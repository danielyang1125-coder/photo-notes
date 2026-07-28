const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

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

// ============================================================
// 环境健康检查
// ============================================================
async function handleHealthCheck(openid) {
  const checks = {}
  const startTime = Date.now()

  // 1. 数据库连接
  try {
    await db.collection('users').count()
    checks.dbConnect = { ok: true, ms: Date.now() - startTime }
  } catch (e) {
    checks.dbConnect = { ok: false, error: e.message }
    return { code: 'SUCCESS', data: { checks, verdict: 'FAILED' } }
  }

  // 2. 集合可访问性
  const collections = [
    'users',
    'photos',
    'notes',
    'tags',
    'photo_tags',
    'deletion_tasks',
  ]
  checks.collections = {}
  for (const name of collections) {
    try {
      const r = await db.collection(name).count()
      checks.collections[name] = { ok: true, count: r.total }
    } catch (e) {
      checks.collections[name] = { ok: false, error: e.message }
    }
  }

  // 3. 事务能力：写入测试文档 + 回滚，验证完整事务链路且不留数据
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
    checks.transaction = { ok: true, note: '事务启动 + add + rollback 成功' }
  } catch (e) {
    checks.transaction = { ok: false, error: e.message }
  }

  // 4. 云存储
  try {
    const envId = cloud.DYNAMIC_CURRENT_ENV.toString()
    await cloud.getTempFileURL({
      fileList: [`cloud://${envId}.dummy`],
    })
    checks.storage = { ok: true, note: 'API 可达' }
  } catch (e) {
    // 文件不存在 = getTempFileURL API 已调通
    if (
      (e.message && e.message.includes('NOT_FOUND')) ||
      e.errCode === -501001
    ) {
      checks.storage = { ok: true, note: 'API 可达（预期：文件不存在）' }
    } else {
      checks.storage = { ok: false, error: e.message || String(e) }
    }
  }

  // 5. 综合判定（扁平化所有检查项）
  const leafChecks = [
    checks.dbConnect,
    ...Object.values(checks.collections),
    checks.transaction,
    checks.storage,
  ]
  const allOk = leafChecks.every((c) => c && c.ok === true)
  const collectionsOk = Object.values(checks.collections).every((c) => c.ok === true)

  return {
    code: 'SUCCESS',
    data: {
      checks,
      verdict: allOk ? 'ALL_OK' : collectionsOk ? 'COLLECTIONS_OK' : 'NEED_SETUP',
      env: cloud.DYNAMIC_CURRENT_ENV,
      openid: openid.substring(0, 8) + '...',
      ms: Date.now() - startTime,
    },
  }
}

// ============================================================
// 入口
// ============================================================
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { code: 'AUTH_FAILED', message: '身份验证失败' }

  try {
    switch (event.type) {
      case 'login':
        return handleLogin(OPENID)
      case 'getStatus':
        return handleGetStatus(OPENID)
      case 'healthCheck':
        return handleHealthCheck(OPENID)
      default:
        return { code: 'UNKNOWN_TYPE', message: '未知操作类型，支持: login | getStatus | healthCheck' }
    }
  } catch (err) {
    console.error('[user]', err)
    return {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || '服务异常',
    }
  }
}
