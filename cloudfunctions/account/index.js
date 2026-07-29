const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const { createBusinessMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const logger = createSecurityLogger()

// ============================================================
// requestDeletion — 申请注销
// ============================================================
async function handleRequestDeletion(openid, event) {
  const { confirmText } = event
  if (confirmText !== '确认注销') {
    return { code: 'VALIDATION_ERROR', message: '请输入"确认注销"以确认操作' }
  }

  // 检查是否已有未完成注销任务
  const existing = await db.collection('deletion_tasks')
    .where({ _openid: openid, type: 'ACCOUNT_DELETION', status: _.in(['PENDING', 'PROCESSING', 'RETRYING']) })
    .get()
  if (existing.data && existing.data.length > 0) {
    return { code: 'DELETION_ALREADY_PENDING', message: '已有未完成注销任务' }
  }

  // 标记用户状态为 DELETING
  await db.collection('users').doc(openid)
    .update({ data: { status: 'DELETING', updated_at: db.serverDate() } })

  // 创建注销任务
  const task = {
    _openid: openid,
    type: 'ACCOUNT_DELETION',
    status: 'PENDING',
    retry_count: 0,
    applied_at: db.serverDate(),
  }
  const r = await db.collection('deletion_tasks').add({ data: task })

  return { code: 'SUCCESS', data: { taskId: r._id, status: 'PENDING' } }
}

// ============================================================
// getDeletionStatus — 查询注销状态
// ============================================================
async function handleGetDeletionStatus(openid) {
  const task = await db.collection('deletion_tasks')
    .where({ _openid: openid, type: 'ACCOUNT_DELETION' })
    .orderBy('applied_at', 'desc')
    .limit(1)
    .get()

  if (!task.data || task.data.length === 0) {
    const user = await db.collection('users').doc(openid).get()
    return { code: 'SUCCESS', data: { status: user.data ? user.data.status : 'UNKNOWN' } }
  }

  return {
    code: 'SUCCESS',
    data: {
      status: task.data[0].status,
      retryCount: task.data[0].retry_count || 0,
    },
  }
}

// ============================================================
exports.main = createBusinessMain({
  domain: 'account',
  cloud,
  db,
  logger,
  activeGuardExempt: ['getDeletionStatus'],
  handlers: {
    requestDeletion: ({ openid, event }) => handleRequestDeletion(openid, event),
    getDeletionStatus: ({ openid }) => handleGetDeletionStatus(openid),
  },
})
