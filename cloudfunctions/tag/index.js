const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const TAG_NAME_MAX = 12
const TAG_MAX_COUNT = 100
const PHOTO_TAG_MAX = 5
const QUICK_LIMIT = 5
const RESERVED = ['全部', '未分类']

function getOpenId() { return cloud.getWXContext().OPENID }

async function checkUserActive(openid) {
  const user = await db.collection('users').doc(openid).get()
  if (!user.data || user.data.status !== 'ACTIVE') {
    throw { code: 'USER_NOT_ACTIVE', message: '账号状态异常' }
  }
  return user.data
}

// ============================================================
// 标签名称规范化
// ============================================================
function normalizeTagName(input) {
  // 去首尾 Unicode 空白
  const name = (input || '').replace(/^[\s ]+|[\s ]+$/g, '')
  // 控制字符
  if (/[\x00-\x1F\x7F-]/.test(name)) {
    throw { code: 'TAG_NAME_INVALID', message: '标签名称包含非法字符' }
  }
  const len = [...name].length
  if (len < 1 || len > TAG_NAME_MAX) {
    throw { code: 'TAG_NAME_INVALID', message: `标签长度为 1~${TAG_NAME_MAX} 个字符` }
  }
  if (RESERVED.includes(name)) {
    throw { code: 'TAG_NAME_INVALID', message: '不能使用保留名称' }
  }
  const nfc = name.normalize('NFC')
  // 拉丁字母大小写归一
  const normalizedName = nfc.replace(/[A-Za-z]+/g, s => s.toLowerCase())
  return { name, normalizedName }
}

// ============================================================
// list — QUICK（最近5个）| ALL（最多100个）
// ============================================================
async function handleList(openid, event) {
  const { mode = 'ALL' } = event
  const limit = mode === 'QUICK' ? QUICK_LIMIT : TAG_MAX_COUNT
  const result = await db.collection('tags')
    .where({ _openid: openid })
    .orderBy('last_used_at', 'desc')
    .orderBy('updated_at', 'desc')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .get()
  const list = (result.data || []).map(t => ({
    _id: t._id, name: t.name, photo_count: t.photo_count || 0,
    last_used_at: t.last_used_at, created_at: t.created_at, updated_at: t.updated_at,
  }))
  return { code: 'SUCCESS', data: { list, total: list.length } }
}

// ============================================================
// create — 创建标签
// ============================================================
async function handleCreate(openid, event) {
  // 数量上限检查
  const count = await db.collection('tags').where({ _openid: openid }).count()
  if (count.total >= TAG_MAX_COUNT) {
    return { code: 'TAG_LIMIT_REACHED', message: '标签数量已达上限（100个）' }
  }
  try {
    const { name, normalizedName } = normalizeTagName(event.name)
    // 内容安全
    try {
      await cloud.openapi.security.msgSecCheck({
        content: name, version: 2, scene: 2, openid,
      })
    } catch (e) {
      if (e.errCode === 87014) return { code: 'CONTENT_REVIEW_FAILED', message: '内容不合规' }
      console.error('[tag] msgSecCheck:', e.errCode, e.message)
    }
    const tag = {
      _openid: openid, name, normalized_name: normalizedName,
      photo_count: 0, last_used_at: db.serverDate(),
      created_at: db.serverDate(), updated_at: db.serverDate(),
    }
    const r = await db.collection('tags').add({ data: tag })
    return {
      code: 'SUCCESS',
      data: { tag: { _id: r._id, ...tag } },
    }
  } catch (e) {
    if (e.code) throw e
    // 唯一索引冲突 → 重名
    if (e.errCode === -502003 || (e.message && e.message.includes('duplicate'))) {
      return { code: 'TAG_NAME_DUPLICATED', message: '标签名称已存在' }
    }
    throw e
  }
}

// ============================================================
// rename — 重命名
// ============================================================
async function handleRename(openid, event) {
  const { tagId, name } = event
  if (!tagId) return { code: 'VALIDATION_ERROR', message: '缺少 tagId' }
  const tag = await db.collection('tags').where({ _id: tagId, _openid: openid }).get()
  if (!tag.data || tag.data.length === 0) {
    return { code: 'TAG_NOT_FOUND', message: '标签不存在' }
  }
  try {
    const { name: newName, normalizedName } = normalizeTagName(name)
    try {
      await cloud.openapi.security.msgSecCheck({
        content: newName, version: 2, scene: 2, openid,
      })
    } catch (e) {
      if (e.errCode === 87014) return { code: 'CONTENT_REVIEW_FAILED', message: '内容不合规' }
    }
    await db.collection('tags').doc(tagId).update({
      data: { name: newName, normalized_name: normalizedName, updated_at: db.serverDate() },
    })
    const updated = await db.collection('tags').doc(tagId).get()
    return { code: 'SUCCESS', data: { tag: updated.data } }
  } catch (e) {
    if (e.code) throw e
    if (e.errCode === -502003 || (e.message && e.message.includes('duplicate'))) {
      return { code: 'TAG_NAME_DUPLICATED', message: '标签名称已存在' }
    }
    throw e
  }
}

// ============================================================
// delete — 删除标签（不删图片和备注）
// ============================================================
async function handleDelete(openid, event) {
  const { tagId } = event
  if (!tagId) return { code: 'VALIDATION_ERROR', message: '缺少 tagId' }
  const tag = await db.collection('tags').where({ _id: tagId, _openid: openid }).get()
  if (!tag.data || tag.data.length === 0) {
    return { code: 'SUCCESS', data: { deleted: true, removedRelationCount: 0 } }
  }
  const transaction = await db.startTransaction()
  try {
    const relations = await transaction.collection('photo_tags')
      .where({ _openid: openid, tag_id: tagId }).get()
    let removed = 0
    for (const rel of (relations.data || [])) {
      await transaction.collection('photo_tags').doc(rel._id).remove()
      await transaction.collection('photos').doc(rel.photo_id)
        .update({ data: { tag_count: _.inc(-1) } })
      removed++
    }
    await transaction.collection('tags').doc(tagId).remove()
    await transaction.commit()
    return { code: 'SUCCESS', data: { deleted: true, removedRelationCount: removed } }
  } catch (e) {
    await transaction.rollback()
    throw e
  }
}

// ============================================================
// getPhotoTags — 单图标签
// ============================================================
async function handleGetPhotoTags(openid, event) {
  const { photoId } = event
  if (!photoId) return { code: 'VALIDATION_ERROR', message: '缺少 photoId' }
  const relations = await db.collection('photo_tags')
    .where({ _openid: openid, photo_id: photoId }).get()
  if (!relations.data || relations.data.length === 0) {
    return { code: 'SUCCESS', data: { tags: [] } }
  }
  const tagIds = relations.data.map(r => r.tag_id)
  const tags = await db.collection('tags')
    .where({ _id: _.in(tagIds), _openid: openid }).get()
  return {
    code: 'SUCCESS',
    data: { tags: (tags.data || []).map(t => ({ _id: t._id, name: t.name, photo_count: t.photo_count })) },
  }
}

// ============================================================
// updatePhotoTags — 单图增量关联
// ============================================================
async function handleUpdatePhotoTags(openid, event) {
  const { photoId, addTagIds = [], removeTagIds = [] } = event
  if (!photoId) return { code: 'VALIDATION_ERROR', message: '缺少 photoId' }
  // 校验图片
  const photo = await db.collection('photos').where({ _id: photoId, _openid: openid }).get()
  if (!photo.data || photo.data.length === 0) return { code: 'PHOTO_NOT_FOUND', message: '图片不存在' }
  // 校验标签归属
  const allTagIds = [...new Set([...addTagIds, ...removeTagIds])]
  if (allTagIds.length > 0) {
    const tagCheck = await db.collection('tags')
      .where({ _id: _.in(allTagIds), _openid: openid }).get()
    if ((tagCheck.data || []).length !== allTagIds.length) {
      return { code: 'TAG_NOT_FOUND', message: '部分标签不存在' }
    }
  }
  // 获取当前关联
  const current = await db.collection('photo_tags')
    .where({ _openid: openid, photo_id: photoId }).get()
  const currentTagIds = (current.data || []).map(r => r.tag_id)
  const desired = [...new Set([...currentTagIds.filter(id => !removeTagIds.includes(id)), ...addTagIds])]
  if (desired.length > PHOTO_TAG_MAX) {
    return { code: 'PHOTO_TAG_LIMIT_REACHED', message: `每张图片最多 ${PHOTO_TAG_MAX} 个标签` }
  }
  const toInsert = desired.filter(id => !currentTagIds.includes(id))
  const toDelete = currentTagIds.filter(id => !desired.includes(id))

  const transaction = await db.startTransaction()
  try {
    for (const tagId of toDelete) {
      const rels = await transaction.collection('photo_tags')
        .where({ _openid: openid, photo_id: photoId, tag_id: tagId }).get()
      for (const rel of (rels.data || [])) {
        await transaction.collection('photo_tags').doc(rel._id).remove()
      }
      await transaction.collection('tags').doc(tagId)
        .update({ data: { photo_count: _.inc(-1) } })
    }
    for (const tagId of toInsert) {
      await transaction.collection('photo_tags').add({
        data: {
          _openid: openid, photo_id: photoId, tag_id: tagId,
          photo_upload_time: photo.data[0].upload_time,
          created_at: db.serverDate(),
        },
      })
      await transaction.collection('tags').doc(tagId)
        .update({ data: { photo_count: _.inc(1), last_used_at: db.serverDate() } })
    }
    const delta = toInsert.length - toDelete.length
    if (delta !== 0) {
      await transaction.collection('photos').doc(photoId)
        .update({ data: { tag_count: _.inc(delta) } })
    }
    await transaction.commit()
  } catch (e) {
    await transaction.rollback()
    throw e
  }

  // 返回最新标签
  const finalRelations = await db.collection('photo_tags')
    .where({ _openid: openid, photo_id: photoId }).get()
  const finalTagIds = (finalRelations.data || []).map(r => r.tag_id)
  let tags = []
  if (finalTagIds.length > 0) {
    const tagResult = await db.collection('tags')
      .where({ _id: _.in(finalTagIds), _openid: openid }).get()
    tags = (tagResult.data || []).map(t => ({ _id: t._id, name: t.name, photo_count: t.photo_count }))
  }
  return { code: 'SUCCESS', data: { tags } }
}

// ============================================================
exports.main = async (event, context) => {
  const openid = getOpenId()
  if (!openid) return { code: 'AUTH_FAILED', message: '身份验证失败' }
  try {
    await checkUserActive(openid)
    switch (event.type) {
      case 'list':            return handleList(openid, event)
      case 'create':          return handleCreate(openid, event)
      case 'rename':          return handleRename(openid, event)
      case 'delete':          return handleDelete(openid, event)
      case 'getPhotoTags':    return handleGetPhotoTags(openid, event)
      case 'updatePhotoTags': return handleUpdatePhotoTags(openid, event)
      default: return { code: 'UNKNOWN_TYPE', message: '支持: list | create | rename | delete | getPhotoTags | updatePhotoTags' }
    }
  } catch (err) {
    if (err.code && err.code !== 'INTERNAL_ERROR') return { code: err.code, message: err.message }
    console.error('[tag]', err)
    return { code: err.code || 'INTERNAL_ERROR', message: err.message || '服务异常' }
  }
}
