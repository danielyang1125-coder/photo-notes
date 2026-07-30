/** 图片服务 — cursor 分页 */
const NAME = 'photo'

function call(type, data = {}) {
  return wx.cloud.callFunction({ name: NAME, data: { type, ...data } })
}

/**
 * 图片列表（HMAC cursor 分页）
 * @param {string} scope - "ALL" | "UNCATEGORIZED" | "TAG"
 * @param {string|null} tagId - scope=TAG 时必传
 * @param {string|null} cursor - 首页传 null，翻页传上一页的 nextCursor
 * @param {number} pageSize - 1~20，默认 20
 */
export function list(scope = 'ALL', tagId = null, cursor = null, pageSize = 20) {
  const data = { scope, pageSize }
  if (tagId) data.tagId = tagId
  if (cursor) data.cursor = cursor
  return call('list', data)
}

export function detail(photoId) {
  return call('detail', { photoId })
}

/** 删除图片（异步），返回 {taskId, status:"PENDING"} */
export function del(photoId) {
  return call('delete', { photoId })
}

/** 查询删除进度，传 taskId 或 photoId 之一 */
export function getDeleteStatus(taskId, photoId) {
  const data = {}
  if (taskId) data.taskId = taskId
  if (photoId) data.photoId = photoId
  return call('getDeleteStatus', data)
}
