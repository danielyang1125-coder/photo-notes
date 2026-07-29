const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const { createBusinessMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const logger = createSecurityLogger()

// ============================================================
// list — ALL | UNCATEGORIZED | TAG
// ============================================================
async function getAllTagRelations(openid, tagId) {
  const batchSize = 100
  const relations = []
  let offset = 0
  while (true) {
    const result = await db.collection('photo_tags')
      .where({ _openid: openid, tag_id: tagId })
      .orderBy('photo_upload_time', 'desc')
      .skip(offset)
      .limit(batchSize)
      .get()
    const batch = result.data || []
    relations.push(...batch)
    if (batch.length < batchSize) break
    offset += batch.length
  }
  return relations
}

async function getPhotosByIds(openid, photoIds) {
  const photos = []
  for (let index = 0; index < photoIds.length; index += 100) {
    const ids = photoIds.slice(index, index + 100)
    if (ids.length === 0) continue
    const result = await db.collection('photos')
      .where({ _openid: openid, _id: _.in(ids) })
      .get()
    photos.push(...(result.data || []))
  }
  return photos
}

async function handleList(openid, event) {
  const { scope = 'ALL', tagId, page = 1, pageSize = 20 } = event
  if (!['ALL', 'UNCATEGORIZED', 'TAG'].includes(scope)) {
    return { code: 'VALIDATION_ERROR', message: '非法 scope' }
  }
  if (scope === 'TAG' && !tagId) {
    return { code: 'VALIDATION_ERROR', message: 'TAG 筛选缺少 tagId' }
  }
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return { code: 'VALIDATION_ERROR', message: '分页参数不合法' }
  }
  const skip = (page - 1) * pageSize

  let result
  let total
  if (scope === 'UNCATEGORIZED') {
    result = await db.collection('photos')
      .where({ _openid: openid, tag_count: 0 })
      .orderBy('upload_time', 'desc').skip(skip).limit(pageSize).get()
    const countResult = await db.collection('photos')
      .where({ _openid: openid, tag_count: 0 }).count()
    total = countResult.total
  } else if (scope === 'TAG') {
    const tag = await db.collection('tags')
      .where({ _id: tagId, _openid: openid }).get()
    if (!tag.data || tag.data.length === 0) {
      return { code: 'TAG_NOT_FOUND', message: '标签不存在' }
    }

    // 先校验关系中的图片，避免失效关系造成分页空洞、重复或错误 hasMore。
    const relations = await getAllTagRelations(openid, tagId)
    const relationPhotoIds = [...new Set(relations.map(item => item.photo_id).filter(Boolean))]
    const relatedPhotos = await getPhotosByIds(openid, relationPhotoIds)
    const photoMap = {}
    relatedPhotos.forEach(photo => { photoMap[photo._id] = photo })
    const seenRelationPhotos = new Set()
    const invalidRelations = relations.filter(item => {
      if (!photoMap[item.photo_id] || seenRelationPhotos.has(item.photo_id)) return true
      seenRelationPhotos.add(item.photo_id)
      return false
    })
    if (invalidRelations.length > 0) {
      await Promise.all(invalidRelations.map(item =>
        db.collection('photo_tags').doc(item._id).remove().catch(() => {
          logger.error({
            event: 'photo.orphan_relation_cleanup',
            result: 'FAILURE',
            safeErrorCode: 'INTERNAL_ERROR',
          })
        })
      ))
    }
    const validPhotoIds = relations
      .map(item => item.photo_id)
      .filter((id, index, ids) => photoMap[id] && ids.indexOf(id) === index)
    total = validPhotoIds.length
    result = { data: validPhotoIds.slice(skip, skip + pageSize).map(id => photoMap[id]) }
    await db.collection('tags').doc(tagId)
      .update({ data: { last_used_at: db.serverDate(), photo_count: total } })
  } else {
    result = await db.collection('photos')
      .where({ _openid: openid })
      .orderBy('upload_time', 'desc').skip(skip).limit(pageSize).get()
    const countResult = await db.collection('photos').where({ _openid: openid }).count()
    total = countResult.total
  }

  const photos = result.data || []

  // 批量生成缩略图临时 URL
  if (photos.length > 0) {
    const fileIds = photos.map(p => p.file_id).filter(Boolean)
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
        photos.forEach(p => { p.thumbnail_url = urlMap[p.file_id] || '' })
      } catch (_) {
        logger.error({
          event: 'photo.thumbnail_url',
          result: 'FAILURE',
          safeErrorCode: 'INTERNAL_ERROR',
        })
        photos.forEach(p => { p.thumbnail_url = '' })
      }
    }
  }

  const list = photos.map(p => ({
    _id: p._id,
    thumbnail_url: p.thumbnail_url || '',
    width: p.width, height: p.height,
    note_count: p.note_count || 0,
    shoot_time: p.shoot_time, time_source: p.time_source,
    upload_time: p.upload_time,
  }))

  return { code: 'SUCCESS', data: { list, total, hasMore: skip + photos.length < total } }
}

// ============================================================
// detail — 图片详情 + 备注 + 标签
// ============================================================
async function handleDetail(openid, event) {
  const { photoId } = event
  if (!photoId) return { code: 'VALIDATION_ERROR', message: '缺少 photoId' }

  const photo = await db.collection('photos')
    .where({ _id: photoId, _openid: openid }).get()
  if (!photo.data || photo.data.length === 0) {
    return { code: 'NOT_FOUND', message: '图片不存在或已删除' }
  }

  let compressionUrl = ''
  const fileId = photo.data[0].file_id
  if (fileId) {
    try {
      const r = await cloud.getTempFileURL({ fileList: [fileId] })
      if (r.fileList[0] && r.fileList[0].tempFileURL) {
        compressionUrl = r.fileList[0].tempFileURL
      }
    } catch (_) {
      logger.error({
        event: 'photo.detail_url',
        result: 'FAILURE',
        safeErrorCode: 'INTERNAL_ERROR',
      })
    }
  }

  const notes = await db.collection('notes')
    .where({ photo_id: photoId, _openid: openid })
    .orderBy('created_at', 'desc').get()

  const tagRelations = await db.collection('photo_tags')
    .where({ photo_id: photoId, _openid: openid }).get()
  let tags = []
  if (tagRelations.data && tagRelations.data.length > 0) {
    const tagIds = tagRelations.data.map(r => r.tag_id)
    const tagResult = await db.collection('tags')
      .where({ _id: _.in(tagIds), _openid: openid }).get()
    tags = (tagResult.data || []).map(t => ({
      _id: t._id, name: t.name, photo_count: t.photo_count,
    }))
  }

  return {
    code: 'SUCCESS',
    data: {
      photo: { ...photo.data[0], compression_url: compressionUrl },
      notes: notes.data || [],
      tags,
    },
  }
}

// ============================================================
// delete — 状态机：PENDING → STORAGE_DELETE → DB_CLEANUP → COMPLETED
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
  } catch (_) {
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
  } catch (_) {
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
    list: ({ openid, event }) => handleList(openid, event),
    detail: ({ openid, event }) => handleDetail(openid, event),
    delete: ({ openid, event }) => handleDelete(openid, event),
  },
})
