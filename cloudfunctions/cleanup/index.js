const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const { createTimerMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const {
  createCloudUploadCleanupRepository,
  createUploadCompensationService,
} = require('./upload-compensation')
const logger = createSecurityLogger()

const BATCH_SIZE = 100
function currentEnvironmentId() {
  const context = cloud.getWXContext()
  return context && typeof context.ENV === 'string' ? context.ENV : ''
}
const uploadCompensation = createUploadCompensationService({
  deleteFiles: (fileList) => cloud.deleteFile({ fileList }),
  environmentId: currentEnvironmentId,
  repository: createCloudUploadCleanupRepository({
    command: _,
    db,
  }),
})

// ============================================================
// 定时触发器入口：每日 03:00 执行
// ============================================================
async function handleCleanup() {
  const summary = {}

  // 1. 上传 attempt 与对象补偿
  try {
    const r = await uploadCompensation.run()
    summary.uploadCompensation = r
  } catch (_) {
    logger.error({
      event: 'cleanup.upload_compensation',
      result: 'FAILURE',
      safeErrorCode: 'INTERNAL_ERROR',
    })
    summary.uploadCompensation = { errorCode: 'INTERNAL_ERROR' }
  }

  // 2. 重试失败的 PHOTO_DELETE 任务
  try {
    const r = await retryFailedPhotoDeletes()
    summary.retryPhotoDeletes = r
  } catch (_) {
    logger.error({
      event: 'cleanup.retry_photo_deletes',
      result: 'FAILURE',
      safeErrorCode: 'INTERNAL_ERROR',
    })
    summary.retryPhotoDeletes = { errorCode: 'INTERNAL_ERROR' }
  }

  // 3. 扫描孤立 photo_tags（图片已删但关联还在）
  try {
    const r = await cleanOrphanRelations()
    summary.orphanRelations = r
  } catch (_) {
    logger.error({
      event: 'cleanup.orphan_relations',
      result: 'FAILURE',
      safeErrorCode: 'INTERNAL_ERROR',
    })
    summary.orphanRelations = { errorCode: 'INTERNAL_ERROR' }
  }

  // 4. 计数校正：tags.photo_count
  try {
    const r = await correctTagCounts()
    summary.tagCountCorrection = r
  } catch (_) {
    logger.error({
      event: 'cleanup.tag_count_correction',
      result: 'FAILURE',
      safeErrorCode: 'INTERNAL_ERROR',
    })
    summary.tagCountCorrection = { errorCode: 'INTERNAL_ERROR' }
  }

  // 5. 计数校正：photos.tag_count
  try {
    const r = await correctPhotoTagCounts()
    summary.photoTagCountCorrection = r
  } catch (_) {
    logger.error({
      event: 'cleanup.photo_tag_count_correction',
      result: 'FAILURE',
      safeErrorCode: 'INTERNAL_ERROR',
    })
    summary.photoTagCountCorrection = { errorCode: 'INTERNAL_ERROR' }
  }

  return { code: 'SUCCESS', data: summary }
}

// ============================================================
// 重试失败删除任务
// ============================================================
async function retryFailedPhotoDeletes() {
  const tasks = await db.collection('deletion_tasks')
    .where({ type: 'PHOTO_DELETE', status: 'FAILED', retry_count: _.lt(5) })
    .limit(BATCH_SIZE)
    .get()

  let retried = 0
  let succeeded = 0

  for (const task of (tasks.data || [])) {
    retried++
    try {
      if (task.failed_stage === 'STORAGE_DELETE') {
        const photo = await db.collection('photos').doc(task.photo_id).get()
        if (photo.data && photo.data.file_id) {
          await cloud.deleteFile({ fileList: [photo.data.file_id] })
        }
      }

      // DB 清理事务
      const transaction = await db.startTransaction()
      const notes = await transaction.collection('notes')
        .where({ photo_id: task.photo_id, _openid: task._openid }).get()
      for (const n of (notes.data || [])) {
        await transaction.collection('notes').doc(n._id).remove()
      }
      const rels = await transaction.collection('photo_tags')
        .where({ photo_id: task.photo_id, _openid: task._openid }).get()
      for (const rel of (rels.data || [])) {
        await transaction.collection('photo_tags').doc(rel._id).remove()
        await transaction.collection('tags').doc(rel.tag_id)
          .update({ data: { photo_count: _.inc(-1) } })
      }
      try {
        await transaction.collection('photos').doc(task.photo_id).remove()
      } catch (_) { /* 已删除 */ }
      await transaction.commit()

      await db.collection('deletion_tasks').doc(task._id).update({
        data: { status: 'COMPLETED', completed_at: db.serverDate() },
      })
      succeeded++
    } catch (_) {
      await db.collection('deletion_tasks').doc(task._id).update({
        data: {
          status: 'FAILED',
          retry_count: _.inc(1),
          last_error: 'PHOTO_DELETE_RETRY_FAILED',
        },
      })
    }
  }

  return { retried, succeeded, failed: retried - succeeded }
}

// ============================================================
// 清理孤立 photo_tags
// ============================================================
async function cleanOrphanRelations() {
  // 找 photo_tags 中图片已不存在的关系
  const relations = await db.collection('photo_tags')
    .limit(BATCH_SIZE)
    .get()

  let cleaned = 0
  for (const rel of (relations.data || [])) {
    try {
      const photo = await db.collection('photos')
        .where({ _id: rel.photo_id, _openid: rel._openid }).get()
      if (!photo.data || photo.data.length === 0) {
        await db.collection('photo_tags').doc(rel._id).remove()
        cleaned++
      }
    } catch (_) {
      // 跳过
    }
  }
  return { scanned: (relations.data || []).length, cleaned }
}

// ============================================================
// 校正 tags.photo_count
// ============================================================
async function correctTagCounts() {
  const tags = await db.collection('tags').limit(BATCH_SIZE).get()
  let corrected = 0

  for (const tag of (tags.data || [])) {
    const count = await db.collection('photo_tags')
      .where({ tag_id: tag._id, _openid: tag._openid }).count()
    if (count.total !== (tag.photo_count || 0)) {
      await db.collection('tags').doc(tag._id)
        .update({ data: { photo_count: count.total } })
      corrected++
    }
  }
  return { scanned: (tags.data || []).length, corrected }
}

// ============================================================
// 校正 photos.tag_count
// ============================================================
async function correctPhotoTagCounts() {
  const photos = await db.collection('photos').limit(BATCH_SIZE).get()
  let corrected = 0

  for (const photo of (photos.data || [])) {
    const count = await db.collection('photo_tags')
      .where({ photo_id: photo._id, _openid: photo._openid }).count()
    if (count.total !== (photo.tag_count || 0)) {
      await db.collection('photos').doc(photo._id)
        .update({ data: { tag_count: count.total } })
      corrected++
    }
  }
  return { scanned: (photos.data || []).length, corrected }
}

exports.main = createTimerMain({
  domain: 'cleanup',
  logger,
  handler: () => handleCleanup(),
})
