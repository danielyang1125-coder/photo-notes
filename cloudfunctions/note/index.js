const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const { createBusinessMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const { AppError } = require('./lib/shared/response')
const config = require('./lib/shared/config')

// ---------------------------------------------------------------------------
// DEV-13 功能开关：冷启动配置校验（未配置或非法值导致部署失败）
// ---------------------------------------------------------------------------
config.boolean('CONTENT_REVIEW_ENABLED')
config.boolean('CURSOR_PAGINATION_REQUIRED')
config.boolean('PUBLIC_RESOURCE_ERROR_MASKING')

const { createNoteHandlers } = require('./handlers')

const logger = createSecurityLogger()

async function reviewContent(content, openid) {
  try {
    await cloud.openapi.security.msgSecCheck({
      content: content,
      version: 2,
      scene: 2,
      openid: openid,
    })
  } catch (e) {
    if (e.errCode === 87014) {
      throw new AppError('CONTENT_REVIEW_FAILED')
    }
    logger.error({
      event: 'note.content_review',
      result: 'FAILURE',
      safeErrorCode: 'CONTENT_REVIEW_UNAVAILABLE',
    })
    throw new AppError('CONTENT_REVIEW_UNAVAILABLE')
  }
}

const noteHandlers = createNoteHandlers({
  db,
  getTempFileURL: (fileList) => cloud.getTempFileURL({ fileList }),
  cursorSecret: () => config.requiredString('CURSOR_HMAC_SECRET'),
  isContentReviewEnabled: () =>
    config.boolean('CONTENT_REVIEW_ENABLED'),
  reviewContent,
})

exports.main = createBusinessMain({
  domain: 'note',
  cloud,
  db,
  logger,
  handlers: {
    add: ({ openid, event }) => noteHandlers.add(openid, event),
    update: ({ openid, event }) => noteHandlers.update(openid, event),
    delete: ({ openid, event }) => noteHandlers.delete(openid, event),
    list: ({ openid, event }) => noteHandlers.list(openid, event),
  },
})
