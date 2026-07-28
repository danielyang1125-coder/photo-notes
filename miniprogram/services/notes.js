/** 备注服务 */
const NAME = 'note'

function call(type, data = {}) {
  return wx.cloud.callFunction({ name: NAME, data: { type, ...data } })
}

export function add(photoId, content) {
  return call('add', { photoId, content })
}

export function update(noteId, content, updatedAt) {
  return call('update', { noteId, content, updatedAt })
}

export function del(noteId) {
  return call('delete', { noteId })
}

export function list(page = 1, pageSize = 20, sortBy = 'created_at', sortOrder = 'desc') {
  return call('list', { page, pageSize, sortBy, sortOrder })
}
