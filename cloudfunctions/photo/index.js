const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function getOpenId() {
  return cloud.getWXContext().OPENID
}

async function checkUserActive(openid) {
  try {
    const user = await db.collection('users').doc(openid).get()
    if (!user.data || user.data.status !== 'ACTIVE') {
      throw { code: 'USER_NOT_ACTIVE', message: '账号状态异常' }
    }
    return user.data
  } catch (e) {
    if (e.code) throw e
    throw { code: 'USER_NOT_ACTIVE', message: '用户不存在' }
  }
}

// ============================================================
// list — ALL | UNCATEGORIZED | TAG
// ============================================================
async function handleList(openid, event) {
  const { scope = 'ALL', tagId, page = 1, pageSize = 20 } = event
  const skip = (page - 1) * pageSize

  let result
  if (scope === 'UNCATEGORIZED') {
    result = await db.collection('photos')
      .where({ _openid: openid, tag_count: 0 })
      .orderBy('upload_time', 'desc').skip(skip).limit(pageSize).get()
  } else if (scope === 'TAG' && tagId) {
    const tag = await db.collection('tags')
      .where({ _id: tagId, _openid: openid }).get()
    if (!tag.data || tag.data.length === 0) {
      return { code: 'TAG_NOT_FOUND', message: '标签不存在' }
    }
    const relations = await db.collection('photo_tags')
      .where({ _openid: openid, tag_id: tagId })
      .orderBy('photo_upload_time', 'desc').skip(skip).limit(pageSize).get()
    if (!relations.data || relations.data.length === 0) {
      return { code: 'SUCCESS', data: { list: [], total: 0, hasMore: false } }
    }
    const photoIds = relations.data.map(r => r.photo_id)
    result = await db.collection('photos')
      .where({ _openid: openid, _id: _.in(photoIds) }).get()
    const photoMap = {}
    result.data.forEach(p => { photoMap[p._id] = p })
    result.data = photoIds.map(id => photoMap[id]).filter(Boolean)
    await db.collection('tags').doc(tagId)
      .update({ data: { last_used_at: db.serverDate() } })
  } else {
    result = await db.collection('photos')
      .where({ _openid: openid })
      .orderBy('upload_time', 'desc').skip(skip).limit(pageSize).get()
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
      } catch (e) {
        console.error('[photo] getTempFileURL 失败:', e.message)
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

  let total
  if (scope === 'TAG' && tagId) {
    const c = await db.collection('photo_tags')
      .where({ _openid: openid, tag_id: tagId }).count()
    total = c.total
  } else {
    const whereCond = scope === 'UNCATEGORIZED'
      ? { _openid: openid, tag_count: 0 }
      : { _openid: openid }
    const c = await db.collection('photos').where(whereCond).count()
    total = c.total
  }

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
    } catch (e) {
      console.error('[photo] detail URL:', e.message)
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
  } catch (e) {
    task.status = 'FAILED'
    task.failed_stage = 'STORAGE_DELETE'
    task.last_error = e.message || '云存储删除失败'
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
  } catch (e) {
    task.status = 'FAILED'
    task.failed_stage = 'DB_CLEANUP'
    task.last_error = e.message || '数据库清理失败'
  }

  const r = await db.collection('deletion_tasks').add({ data: task })
  return {
    code: 'SUCCESS',
    data: { taskId: r._id, status: task.status, deletedNotesCount: noteCount },
  }
}

// ============================================================
exports.main = async (event, context) => {
  const openid = getOpenId()
  if (!openid) return { code: 'AUTH_FAILED', message: '身份验证失败' }
  try {
    await checkUserActive(openid)
    switch (event.type) {
      case 'list':   return handleList(openid, event)
      case 'detail': return handleDetail(openid, event)
      case 'delete': return handleDelete(openid, event)
      default:       return { code: 'UNKNOWN_TYPE', message: '支持: list | detail | delete' }
    }
  } catch (err) {
    if (err.code && err.code !== 'INTERNAL_ERROR') {
      return { code: err.code, message: err.message }
    }
    console.error('[photo]', err)
    return { code: err.code || 'INTERNAL_ERROR', message: err.message || '服务异常' }
  }
}
