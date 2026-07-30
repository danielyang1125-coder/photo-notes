const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const config = require('./lib/shared/config')
const { createBusinessMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const { createUploadAttemptHandlers } = require('./handlers')
const { AppError } = require('./lib/shared/response')
const { createLightImageProcessor } = require('./image-processing')

// ---------------------------------------------------------------------------
// DEV-13 功能开关：冷启动配置校验（未配置或非法值导致部署失败）
// ---------------------------------------------------------------------------
config.boolean('UPLOAD_ATTEMPT_REQUIRED')
config.boolean('PUBLIC_RESOURCE_ERROR_MASKING')

const logger = createSecurityLogger()
function currentEnvironmentId() {
  const context = cloud.getWXContext()
  const value = context && context.ENV
  if (typeof value !== 'string' || !value) throw new AppError('INTERNAL_ERROR')
  return value
}

async function reviewImage(buffer, contentType) {
  try {
    const result = await cloud.openapi.security.imgSecCheck({
      media: { contentType, value: buffer },
    })
    if (result && result.errCode && result.errCode !== 0) {
      throw result
    }
  } catch (error) {
    if (error && Number(error.errCode) === 87014) {
      throw new AppError('CONTENT_REVIEW_FAILED')
    }
    throw new AppError('CONTENT_REVIEW_UNAVAILABLE')
  }
}
const uploadAttemptHandlers = createUploadAttemptHandlers({
  db,
  deleteFiles: (fileList) => cloud.deleteFile({ fileList }),
  downloadFile: (fileID) => cloud.downloadFile({ fileID }),
  environmentId: currentEnvironmentId,
  isContentReviewEnabled: () =>
    config.boolean('CONTENT_REVIEW_ENABLED'),
  processImage: createLightImageProcessor(),
  reviewImage,
  uploadFile: (cloudPath, fileContent) =>
    cloud.uploadFile({ cloudPath, fileContent }),
})

// ============================================================
exports.main = createBusinessMain({
  domain: 'upload',
  cloud,
  db,
  logger,
  handlers: {
    prepare: ({ openid, event }) =>
      uploadAttemptHandlers.prepare(openid, event),
    confirm: ({ openid, event }) =>
      uploadAttemptHandlers.confirm(openid, event),
    cancel: ({ openid, event }) =>
      uploadAttemptHandlers.cancel(openid, event),
  },
})
