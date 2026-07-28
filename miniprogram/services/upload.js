/** 上传服务 */
const NAME = 'upload'

export function confirm(params) {
  return wx.cloud.callFunction({
    name: NAME,
    data: {
      type: 'confirm',
      fileId: params.fileId,
      size: params.size,
      width: params.width,
      height: params.height,
      format: params.format,
      shootTime: params.shootTime,
      timeSource: params.timeSource,
      taskId: params.taskId,
    },
  })
}
