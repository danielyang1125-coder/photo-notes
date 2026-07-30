/** 上传服务 — 新协议：prepare → 上传 → confirm */
const NAME = 'upload'

/**
 * 获取上传授权：服务端签发 attemptId 和 cloudPath
 * @param {{taskId: string}} params
 * @returns {{attemptId, cloudPath, expiresAt, photoId?}}
 */
export function prepare(params) {
  return wx.cloud.callFunction({
    name: NAME,
    data: {
      type: 'prepare',
      taskId: params.taskId,
    },
  })
}

/**
 * 确认上传：服务端验证文件真实性并原子创建 photo
 * @param {{attemptId: string, fileId: string, shootTime: string|null, timeSource: string}} params
 * @returns {{photo, duplicated?}}
 */
export function confirm(params) {
  return wx.cloud.callFunction({
    name: NAME,
    data: {
      type: 'confirm',
      attemptId: params.attemptId,
      fileId: params.fileId,
      shootTime: params.shootTime,
      timeSource: params.timeSource,
    },
  })
}

/**
 * 取消上传尝试
 * @param {{attemptIds: string[]}} params
 * @returns {{results: Array}}
 */
export function cancel(params) {
  return wx.cloud.callFunction({
    name: NAME,
    data: {
      type: 'cancel',
      attemptIds: params.attemptIds,
    },
  })
}
