const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const { createBusinessMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const logger = createSecurityLogger()

// ============================================================
// 用户登录/身份建立
// ============================================================
async function handleLogin(openid) {
  const usersCol = db.collection('users')
  let result
  try {
    result = await usersCol.doc(openid).get()
  } catch (e) {
    // 文档不存在 = 新用户（CloudBase doc().get() 对不存在的文档抛错）
    result = { data: null }
  }

  if (result.data) {
    // 已有用户
    const user = result.data
    if (user.status === 'DELETING') {
      return {
        code: 'SUCCESS',
        data: { user, isNewUser: false },
      }
    }
    if (user.status === 'DELETED') {
      // 已注销用户按新用户重新初始化
      await usersCol.doc(openid).update({
        data: {
          status: 'ACTIVE',
          used_bytes: 0,
          updated_at: db.serverDate(),
        },
      })
      return {
        code: 'SUCCESS',
        data: {
          user: {
            _id: openid,
            _openid: openid,
            status: 'ACTIVE',
            used_bytes: 0,
            limit_bytes: 524288000,
          },
          isNewUser: true,
        },
      }
    }
    return {
      code: 'SUCCESS',
      data: { user: result.data, isNewUser: false },
    }
  }

  // 新用户：创建记录（_id = _openid）
  const newUser = {
    _id: openid,
    _openid: openid,
    status: 'ACTIVE',
    used_bytes: 0,
    limit_bytes: 524288000,
    created_at: db.serverDate(),
    updated_at: db.serverDate(),
  }
  await usersCol.add({ data: newUser })
  return {
    code: 'SUCCESS',
    data: { user: newUser, isNewUser: true },
  }
}

// ============================================================
// 用户状态查询
// ============================================================
async function handleGetStatus(openid) {
  let result
  try {
    result = await db.collection('users').doc(openid).get()
  } catch (e) {
    return { code: 'NOT_FOUND', message: '用户不存在' }
  }
  if (!result.data) {
    return { code: 'NOT_FOUND', message: '用户不存在' }
  }
  return {
    code: 'SUCCESS',
    data: { status: result.data.status },
  }
}

async function handleGetSpaceUsage(openid) {
  let result
  try {
    result = await db.collection('users').doc(openid).get()
  } catch (e) {
    return { code: 'NOT_FOUND', message: '用户不存在' }
  }
  if (!result.data) return { code: 'NOT_FOUND', message: '用户不存在' }
  const usedBytes = Number(result.data.used_bytes) || 0
  const limitBytes = Number(result.data.limit_bytes) || 524288000
  const full = usedBytes >= limitBytes
  return {
    code: 'SUCCESS',
    data: {
      used_bytes: usedBytes,
      limit_bytes: limitBytes,
      warning: !full && usedBytes / limitBytes >= 0.85,
      full,
    },
  }
}

// ============================================================
// 环境健康检查
// ============================================================
async function handleHealthCheck(openid) {
  if (process.env.ENABLE_HEALTH_CHECK !== 'true') {
    return { code: 'FORBIDDEN', message: '当前操作不可用' }
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
  } catch (e) {
    checks.storage = e.errCode === -501001
  }

  const allOk = Object.values(checks).every(Boolean)

  return {
    code: 'SUCCESS',
    data: {
      checks,
      verdict: allOk ? 'ALL_OK' : 'FAILED',
      durationMs: Date.now() - startTime,
    },
  }
}

// ============================================================
// 入口
// ============================================================
exports.main = createBusinessMain({
  domain: 'user',
  cloud,
  db,
  logger,
  activeGuard: false,
  handlers: {
    login: ({ openid }) => handleLogin(openid),
    getStatus: ({ openid }) => handleGetStatus(openid),
    getSpaceUsage: ({ openid }) => handleGetSpaceUsage(openid),
    healthCheck: ({ openid }) => handleHealthCheck(openid),
  },
})
