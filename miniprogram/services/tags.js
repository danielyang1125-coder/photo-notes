/** 标签服务 */
const NAME = 'tag'

function call(type, data = {}) {
  return wx.cloud.callFunction({ name: NAME, data: { type, ...data } })
}

export function list(mode = 'ALL') {
  return call('list', { mode })
}

export function create(name) {
  return call('create', { name })
}

export function rename(tagId, name) {
  return call('rename', { tagId, name })
}

export function del(tagId) {
  return call('delete', { tagId })
}

export function getPhotoTags(photoId) {
  return call('getPhotoTags', { photoId })
}

export function updatePhotoTags(photoId, addTagIds, removeTagIds, requestId) {
  return call('updatePhotoTags', { photoId, addTagIds, removeTagIds, requestId })
}

export function batchAddPhotoTags(photoIds, tagIds, requestId) {
  return call('batchAddPhotoTags', { photoIds, tagIds, requestId })
}
