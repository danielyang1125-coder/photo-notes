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

/** 模块级删除轮询器（页面卸载后继续运行） */
const _deletePollers = new Map()

/**
 * 轮询删除进度，完成后自动停止
 * @param {string} taskId - 删除任务 ID
 * @param {object} opts
 * @param {number} opts.intervalMs - 轮询间隔，默认 5000
 * @param {number} opts.maxAttempts - 最大轮询次数，默认 12（1 分钟）
 * @param {function} opts.onManualRequired - 需要人工处理时的回调
 * @param {function} opts.onDone - 删除完成时的回调
 */
export function pollDeleteStatus(taskId, {
  intervalMs = 5000,
  maxAttempts = 12,
  onManualRequired,
  onDone,
} = {}) {
  if (!taskId || _deletePollers.has(taskId)) return
  let attempts = 0
  const timer = setInterval(async () => {
    attempts += 1
    try {
      const res = await getDeleteStatus(taskId)
      const code = res.result && res.result.code
      const status = res.result && res.result.data && res.result.data.status
      if (code === 'DELETE_TASK_NOT_FOUND' || status === 'COMPLETED') {
        clearInterval(timer)
        _deletePollers.delete(taskId)
        if (onDone) onDone()
        return
      }
      if (status === 'MANUAL_REQUIRED') {
        clearInterval(timer)
        _deletePollers.delete(taskId)
        if (onManualRequired) onManualRequired()
        return
      }
    } catch (_) { /* 网络错误不中断轮询 */ }
    if (attempts >= maxAttempts) {
      clearInterval(timer)
      _deletePollers.delete(taskId)
    }
  }, intervalMs)
  _deletePollers.set(taskId, timer)
}
