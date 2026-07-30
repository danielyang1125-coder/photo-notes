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

const { createUserHandlers } = require('./handlers')
const logger = createSecurityLogger()
const userHandlers = createUserHandlers({ db })

async function handleHealthCheck() {
  if (process.env.ENABLE_HEALTH_CHECK !== 'true') {
    return { code: 'FORBIDDEN' }
  }

  const checks = {
    database: false,
    transaction: false,
    storage: false,
  }
  const startTime = Date.now()

  try {
    await db.collection('users').count()
    checks.database = true
  } catch (_) {
    return { code: 'SUCCESS', data: { checks, verdict: 'FAILED' } }
  }

  try {
    const transaction = await db.startTransaction()
    await transaction.collection('users').add({
      data: {
        _openid: 'healthcheck_test',
        status: 'TEST',
        used_bytes: 0,
        limit_bytes: 0,
        created_at: new Date(),
        updated_at: new Date(),
      },
    })
    await transaction.rollback()
    checks.transaction = true
  } catch (_) {
    checks.transaction = false
  }

  try {
    const envId = cloud.DYNAMIC_CURRENT_ENV.toString()
    await cloud.getTempFileURL({
      fileList: [`cloud://${envId}.dummy`],
    })
    checks.storage = true
  } catch (error) {
    checks.storage = error.errCode === -501001
  }

  return {
    code: 'SUCCESS',
    data: {
      checks,
      verdict: Object.values(checks).every(Boolean) ? 'ALL_OK' : 'FAILED',
      durationMs: Date.now() - startTime,
    },
  }
}

exports.main = createBusinessMain({
  domain: 'user',
  cloud,
  db,
  logger,
  activeGuardExempt: ['login', 'getStatus', 'healthCheck'],
  handlers: {
    login: ({ openid }) => userHandlers.login(openid),
    getStatus: ({ openid }) => userHandlers.getStatus(openid),
    getSpaceUsage: ({ openid }) => userHandlers.getSpaceUsage(openid),
    healthCheck: () => handleHealthCheck(),
  },
})
