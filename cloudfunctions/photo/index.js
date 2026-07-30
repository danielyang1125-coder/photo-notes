const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const { createBusinessMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const config = require('./lib/shared/config')
const { createPhotoHandlers } = require('./handlers')
const logger = createSecurityLogger()

const photoHandlers = createPhotoHandlers({
  db,
  getTempFileURL: (fileList) => cloud.getTempFileURL({ fileList }),
  cursorSecret: () => config.requiredString('CURSOR_HMAC_SECRET'),
})

// ============================================================
// delete — 状态机：PENDING → STORAGE_DELETE → DB_CLEANUP → COMPLETED
// （DEV-07 将重写为异步删除协议）
// ============================================================
async function handleDelete(openid, event) {
  const { photoId } = event
  if (!photoId) return { code: 'VALIDATION_ERROR', message: '缺少 photoId' }

  const photo = await db.collection('photos')
    .where({ _id: photoId, _openid: openid }).get()
  if (!photo.data || photo.data.length === 0) {
    return { code: 'NOT_FOUND', message: '图片不存在或已删除' }
  }

  const { file_id: fileId, file_size: photoSize = 0 } = photo.data[0]
  const task = {
    _openid: openid,
    type: 'PHOTO_DELETE',
    photo_id: photoId,
    status: 'DELETING',
    retry_count: 0,
    applied_at: db.serverDate(),
  }
  let noteCount = 0

  // 阶段 1：删除云存储（COS DELETE 幂等）
  try {
    if (fileId) await cloud.deleteFile({ fileList: [fileId] })
  } catch (_err) {
    task.status = 'FAILED'
    task.failed_stage = 'STORAGE_DELETE'
    task.last_error = 'STORAGE_DELETE_FAILED'
    const r = await db.collection('deletion_tasks').add({ data: task })
    return { code: 'SUCCESS', data: { taskId: r._id, status: 'FAILED', message: '云存储删除失败，稍后重试' } }
  }

  // 阶段 2：数据库事务
  try {
    const transaction = await db.startTransaction()
    const notesResult = await transaction.collection('notes')
      .where({ photo_id: photoId, _openid: openid }).get()
    noteCount = (notesResult.data || []).length
    for (const n of (notesResult.data || [])) {
      await transaction.collection('notes').doc(n._id).remove()
    }
    const relations = await transaction.collection('photo_tags')
      .where({ photo_id: photoId, _openid: openid }).get()
    for (const rel of (relations.data || [])) {
      await transaction.collection('photo_tags').doc(rel._id).remove()
      await transaction.collection('tags').doc(rel.tag_id)
        .update({ data: { photo_count: _.inc(-1) } })
    }
    await transaction.collection('photos').doc(photoId).remove()
    if (photoSize > 0) {
      await transaction.collection('users').doc(openid)
        .update({ data: { used_bytes: _.inc(-photoSize) } })
    }
    await transaction.commit()
    task.status = 'COMPLETED'
    task.completed_at = db.serverDate()
  } catch (_err) {
    task.status = 'FAILED'
    task.failed_stage = 'DB_CLEANUP'
    task.last_error = 'DB_CLEANUP_FAILED'
  }

  const r = await db.collection('deletion_tasks').add({ data: task })
  return {
    code: 'SUCCESS',
    data: { taskId: r._id, status: task.status, deletedNotesCount: noteCount },
  }
}

// ============================================================
exports.main = createBusinessMain({
  domain: 'photo',
  cloud,
  db,
  logger,
  handlers: {
    list: ({ openid, event }) => photoHandlers.list(openid, event),
    detail: ({ openid, event }) => photoHandlers.detail(openid, event),
    delete: ({ openid, event }) => handleDelete(openid, event),
  },
})
