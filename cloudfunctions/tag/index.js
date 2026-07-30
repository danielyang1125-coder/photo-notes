const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const { createBusinessMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const { AppError } = require('./lib/shared/response')
const { createTagHandlers } = require('./handlers')

const logger = createSecurityLogger()

// 内容安全审核 — fail-closed
async function reviewContent(name, openid) {
  try {
    await cloud.openapi.security.msgSecCheck({
      content: name,
      version: 2,
      scene: 2,
      openid: openid,
    })
  } catch (e) {
    if (e.errCode === 87014) {
      throw new AppError('CONTENT_REVIEW_FAILED')
    }
    logger.error({
      event: 'tag.content_review',
      result: 'FAILURE',
      safeErrorCode: 'CONTENT_REVIEW_UNAVAILABLE',
    })
    throw new AppError('CONTENT_REVIEW_UNAVAILABLE')
  }
}

const tagHandlers = createTagHandlers({ db, reviewContent })

exports.main = createBusinessMain({
  domain: 'tag',
  cloud,
  db,
  logger,
  handlers: {
    list: ({ openid, event }) => tagHandlers.list(openid, event),
    create: ({ openid, event }) => tagHandlers.create(openid, event),
    rename: ({ openid, event }) => tagHandlers.rename(openid, event),
    delete: ({ openid, event }) => tagHandlers.delete(openid, event),
    getPhotoTags: ({ openid, event }) => tagHandlers.getPhotoTags(openid, event),
    updatePhotoTags: ({ openid, event }) => tagHandlers.updatePhotoTags(openid, event),
    batchAddPhotoTags: ({ openid, event }) => tagHandlers.batchAddPhotoTags(openid, event),
  },
})
