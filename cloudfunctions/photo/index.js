const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const { createBusinessMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const config = require('./lib/shared/config')
const { createPhotoHandlers } = require('./handlers')
const { createDeleteHandlers } = require('./delete-handlers')
const logger = createSecurityLogger()

const photoHandlers = createPhotoHandlers({
  db,
  getTempFileURL: (fileList) => cloud.getTempFileURL({ fileList }),
  cursorSecret: () => config.requiredString('CURSOR_HMAC_SECRET'),
})

const deleteHandlers = createDeleteHandlers({ db })

exports.main = createBusinessMain({
  domain: 'photo',
  cloud,
  db,
  logger,
  handlers: {
    list: ({ openid, event }) => photoHandlers.list(openid, event),
    detail: ({ openid, event }) => photoHandlers.detail(openid, event),
    delete: ({ openid, event }) => deleteHandlers.handleDelete(openid, event),
    getDeleteStatus: ({ openid, event }) =>
      deleteHandlers.handleGetDeleteStatus(openid, event),
  },
})
