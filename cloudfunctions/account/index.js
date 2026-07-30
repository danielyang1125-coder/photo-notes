const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const { createBusinessMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const config = require('./lib/shared/config')

// ---------------------------------------------------------------------------
// DEV-13 功能开关：冷启动配置校验（未配置或非法值导致部署失败）
// ---------------------------------------------------------------------------
config.boolean('PUBLIC_RESOURCE_ERROR_MASKING')

const { createAccountHandlers } = require('./handlers')
const logger = createSecurityLogger()
const accountHandlers = createAccountHandlers({ db })

exports.main = createBusinessMain({
  domain: 'account',
  cloud,
  db,
  logger,
  activeGuardExempt: ['requestDeletion', 'getDeletionStatus'],
  handlers: {
    requestDeletion: ({ openid, event }) =>
      accountHandlers.requestDeletion(openid, event),
    getDeletionStatus: ({ openid }) =>
      accountHandlers.getDeletionStatus(openid),
  },
})
