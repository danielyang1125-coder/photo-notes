const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const { createBusinessMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const logger = createSecurityLogger()

const NOTE_MAX_CODE_POINTS = 1000

// Unicode code point 计数
function countCodePoints(str) {
  return [...(str || '')].length
}

// ============================================================
// add — 创建备注
// ============================================================
async function handleAdd(openid, event) {
  const { photoId, content } = event
  if (!photoId || !content) {
    return { code: 'VALIDATION_ERROR', message: '缺少 photoId 或 content' }
  }

  // 校验内容长度
  const cpCount = countCodePoints(content)
  if (cpCount < 1 || cpCount > NOTE_MAX_CODE_POINTS) {
    return { code: 'VALIDATION_ERROR', message: `备注长度为 1~${NOTE_MAX_CODE_POINTS} 个字符` }
  }

  // 图片归属校验
  const photo = await db.collection('photos')
    .where({ _id: photoId, _openid: openid }).get()
  if (!photo.data || photo.data.length === 0) {
    return { code: 'NOT_FOUND', message: '图片不存在或已删除' }
  }

  // 内容安全审核
  try {
    await cloud.openapi.security.msgSecCheck({
      content: content,
      version: 2,
      scene: 2,
      openid: openid,
    })
  } catch (e) {
    if (e.errCode === 87014) {
      return { code: 'CONTENT_REVIEW_FAILED', message: '内容不合规' }
    }
    logger.error({
      event: 'note.content_review',
      result: 'FAILURE',
      safeErrorCode: 'CONTENT_REVIEW_UNAVAILABLE',
    })
    return { code: 'CONTENT_REVIEW_UNAVAILABLE', message: '服务暂时不可用，请稍后重试' }
  }

  const note = {
    _openid: openid,
    photo_id: photoId,
    photo_file_id: photo.data[0].file_id || '',
    content: content,
    content_code_point_count: cpCount,
    photo_shoot_time: photo.data[0].shoot_time || photo.data[0].upload_time,
    created_at: db.serverDate(),
    updated_at: db.serverDate(),
  }
  const addResult = await db.collection('notes').add({ data: note })

  // 原子更新图片备注计数
  await db.collection('photos').doc(photoId)
    .update({ data: { note_count: _.inc(1) } })

  return {
    code: 'SUCCESS',
    data: { note: { _id: addResult._id, ...note } },
  }
}

// ============================================================
// update — 更新备注（乐观并发控制）
// ============================================================
async function handleUpdate(openid, event) {
  const { noteId, content, updatedAt } = event
  if (!noteId || !content) {
    return { code: 'VALIDATION_ERROR', message: '缺少 noteId 或 content' }
  }

  const cpCount = countCodePoints(content)
  if (cpCount < 1 || cpCount > NOTE_MAX_CODE_POINTS) {
    return { code: 'VALIDATION_ERROR', message: `备注长度为 1~${NOTE_MAX_CODE_POINTS} 个字符` }
  }

  // 内容安全审核
  try {
    await cloud.openapi.security.msgSecCheck({
      content: content,
      version: 2,
      scene: 2,
      openid: openid,
    })
  } catch (e) {
    if (e.errCode === 87014) {
      return { code: 'CONTENT_REVIEW_FAILED', message: '内容不合规' }
    }
    logger.error({
      event: 'note.content_review',
      result: 'FAILURE',
      safeErrorCode: 'CONTENT_REVIEW_UNAVAILABLE',
    })
    return { code: 'CONTENT_REVIEW_UNAVAILABLE', message: '服务暂时不可用，请稍后重试' }
  }

  // 乐观并发控制：用 updated_at 做版本检查
  const where = { _id: noteId, _openid: openid }
  if (updatedAt) {
    where.updated_at = new Date(updatedAt)
  }

  const result = await db.collection('notes').where(where).update({
    data: {
      content: content,
      content_code_point_count: cpCount,
      updated_at: db.serverDate(),
    },
  })

  if (result.stats.updated === 0) {
    // 冲突：读取当前版本返回给客户端
    const current = await db.collection('notes').doc(noteId).get()
    return {
      code: 'CONFLICT',
      message: '内容已在其他设备更新',
      data: current.data
        ? { note: current.data }
        : null,
    }
  }

  const updated = await db.collection('notes').doc(noteId).get()
  return {
    code: 'SUCCESS',
    data: { note: updated.data },
  }
}

// ============================================================
// delete — 删除备注
// ============================================================
async function handleDelete(openid, event) {
  const { noteId } = event
  if (!noteId) return { code: 'VALIDATION_ERROR', message: '缺少 noteId' }

  const note = await db.collection('notes')
    .where({ _id: noteId, _openid: openid }).get()
  if (!note.data || note.data.length === 0) {
    return { code: 'NOT_FOUND', message: '备注不存在或已删除' }
  }

  const photoId = note.data[0].photo_id
  await db.collection('notes').doc(noteId).remove()

  // 递减图片备注计数
  if (photoId) {
    await db.collection('photos').doc(photoId)
      .update({ data: { note_count: _.inc(-1) } })
  }

  return {
    code: 'SUCCESS',
    data: { photoId, deleted: true },
  }
}

// ============================================================
// list — 备注列表
// ============================================================
async function handleList(openid, event) {
  const {
    page = 1,
    pageSize = 20,
    sortBy = 'created_at',
    sortOrder = 'desc',
  } = event
  const skip = (page - 1) * pageSize

  const orderField = sortBy === 'photo_shoot_time' ? 'photo_shoot_time' : 'created_at'
  const orderDir = sortOrder === 'asc' ? 'asc' : 'desc'

  const result = await db.collection('notes')
    .where({ _openid: openid })
    .orderBy(orderField, orderDir)
    .skip(skip)
    .limit(pageSize)
    .get()

  const notes = result.data || []

  // 批量生成缩略图临时 URL
  if (notes.length > 0) {
    const fileIds = notes.map(n => n.photo_file_id).filter(Boolean)
    if (fileIds.length > 0) {
      try {
        const urlResult = await cloud.getTempFileURL({ fileList: fileIds })
        const urlMap = {}
        urlResult.fileList.forEach(f => {
          if (f.tempFileURL) {
            const sep = f.tempFileURL.includes('?') ? '&' : '?'
            urlMap[f.fileID] = f.tempFileURL + sep + 'imageMogr2/thumbnail/!200x200r'
          }
        })
        notes.forEach(n => { n.thumbnail_url = urlMap[n.photo_file_id] || '' })
      } catch (_) {
        logger.error({
          event: 'note.thumbnail_url',
          result: 'FAILURE',
          safeErrorCode: 'INTERNAL_ERROR',
        })
        notes.forEach(n => { n.thumbnail_url = '' })
      }
    }
  }

  const countResult = await db.collection('notes')
    .where({ _openid: openid }).count()

  const list = notes.map(n => ({
    _id: n._id,
    photo_id: n.photo_id,
    thumbnail_url: n.thumbnail_url || '',
    content: n.content,
    content_code_point_count: n.content_code_point_count,
    photo_shoot_time: n.photo_shoot_time,
    created_at: n.created_at,
    updated_at: n.updated_at,
  }))

  return {
    code: 'SUCCESS',
    data: {
      list,
      total: countResult.total,
      hasMore: skip + notes.length < countResult.total,
    },
  }
}

// ============================================================
exports.main = createBusinessMain({
  domain: 'note',
  cloud,
  db,
  logger,
  handlers: {
    add: ({ openid, event }) => handleAdd(openid, event),
    update: ({ openid, event }) => handleUpdate(openid, event),
    delete: ({ openid, event }) => handleDelete(openid, event),
    list: ({ openid, event }) => handleList(openid, event),
  },
})
