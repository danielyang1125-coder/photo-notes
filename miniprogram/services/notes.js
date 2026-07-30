/** 备注服务 — cursor 分页 */
const NAME = 'note'

function call(type, data = {}) {
  return wx.cloud.callFunction({ name: NAME, data: { type, ...data } })
}

export function add(photoId, content) {
  return call('add', { photoId, content })
}

/** 更新备注（乐观锁），updatedAt 必须传当前 note.updated_at */
export function update(noteId, content, updatedAt) {
  return call('update', { noteId, content, updatedAt })
}

export function del(noteId) {
  return call('delete', { noteId })
}

/**
 * 备注列表（HMAC cursor 分页）
 * @param {string|null} cursor - 首页传 null
 * @param {number} pageSize - 1~20
 * @param {string} sortBy - "created_at" | "photo_shoot_time"
 * @param {string} sortOrder - "desc" | "asc"
 */
export function list(cursor = null, pageSize = 20, sortBy = 'created_at', sortOrder = 'desc') {
  const data = { sortBy, sortOrder, pageSize }
  if (cursor) data.cursor = cursor
  return call('list', data)
}
