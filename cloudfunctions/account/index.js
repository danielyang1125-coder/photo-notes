const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const { createBusinessMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
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
