/** 图片服务 */
const NAME = 'photo'

function call(type, data = {}) {
  return wx.cloud.callFunction({ name: NAME, data: { type, ...data } })
}

export function list(scope = 'ALL', tagId, page = 1, pageSize = 20) {
  return call('list', { scope, tagId, page, pageSize })
}

export function detail(photoId) {
  return call('detail', { photoId })
}

export function del(photoId) {
  return call('delete', { photoId })
}
