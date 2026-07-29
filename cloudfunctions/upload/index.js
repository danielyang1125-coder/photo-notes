const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const { createBusinessMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const logger = createSecurityLogger()

// ============================================================
// confirm — 上传确认（幂等 + 内容审核 + 创建记录）
// ============================================================
async function handleConfirm(openid, event) {
  const {
    fileId,
    size,
    width,
    height,
    format,
    shootTime,
    timeSource,
    taskId,
  } = event

  if (!fileId || !taskId) {
    return { code: 'VALIDATION_ERROR', message: '缺少 fileId 或 taskId' }
  }

  // 幂等检查
  const existing = await db.collection('photos')
    .where({ _openid: openid, task_id: taskId }).get()
  if (existing.data && existing.data.length > 0) {
    if (existing.data[0].file_id !== fileId) {
      try { await cloud.deleteFile({ fileList: [fileId] }) } catch (_) {}
    }
    return {
      code: 'SUCCESS',
      data: { photo: { _id: existing.data[0]._id, ...existing.data[0] }, duplicated: true },
    }
  }

  // 空间检查
  const user = await db.collection('users').doc(openid).get()
  const usedBytes = user.data ? (user.data.used_bytes || 0) : 0
  const limitBytes = user.data ? (user.data.limit_bytes || 524288000) : 524288000
  if (usedBytes + (size || 0) > limitBytes) {
    try { await cloud.deleteFile({ fileList: [fileId] }) } catch (_) {}
    return { code: 'SPACE_EXCEEDED', message: '存储空间不足' }
  }

  // 内容安全审核：imgSecCheck（仅内容违规时拒绝，API 不可用时放行）
  try {
    const downloadResult = await cloud.downloadFile({ fileID: fileId })
    if (downloadResult.fileContent) {
      const imgBuffer = downloadResult.fileContent
      await cloud.openapi.security.imgSecCheck({
        media: {
          contentType: 'image/' + (format || 'jpeg').toLowerCase(),
          value: imgBuffer,
        },
      })
    }
  } catch (e) {
    if (e.errCode === 87014) {
      // 内容违规 → 删除文件 + 拒绝
      try { await cloud.deleteFile({ fileList: [fileId] }) } catch (_) {}
      return { code: 'CONTENT_REVIEW_FAILED', message: '内容不合规，无法上传' }
    }
    // API 未开通/未配置权限/超时 → 记日志放行（生产环境需开通）
    logger.error({
      event: 'upload.content_review',
      result: 'FAILURE',
      safeErrorCode: 'CONTENT_REVIEW_UNAVAILABLE',
    })
  }

  // 创建 photo 记录
  const photo = {
    _openid: openid,
    file_id: fileId,
    task_id: taskId,
    file_size: size || 0,
    width: width || 0,
    height: height || 0,
    format: format || 'JPEG',
    shoot_time: shootTime ? new Date(shootTime) : db.serverDate(),
    time_source: timeSource || 'UPLOAD_TIME',
    upload_time: db.serverDate(),
    note_count: 0,
    tag_count: 0,
    created_at: db.serverDate(),
  }
  // 在同一事务内再次校验空间并入库，防止 3 个并发任务共同越过上限。
  const transaction = await db.startTransaction()
  let addResult
  try {
    const latestUser = await transaction.collection('users').doc(openid).get()
    const latestUsed = latestUser.data ? (latestUser.data.used_bytes || 0) : 0
    const latestLimit = latestUser.data ? (latestUser.data.limit_bytes || 524288000) : 524288000
    if (latestUsed + (size || 0) > latestLimit) {
      await transaction.rollback()
      try { await cloud.deleteFile({ fileList: [fileId] }) } catch (_) {}
      return { code: 'SPACE_EXCEEDED', message: '存储空间不足' }
    }
    addResult = await transaction.collection('photos').add({ data: photo })
    if (size > 0) {
      await transaction.collection('users').doc(openid)
        .update({ data: { used_bytes: _.inc(size) } })
    }
    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  }

  return {
    code: 'SUCCESS',
    data: { photo: { _id: addResult._id, ...photo } },
  }
}

// ============================================================
exports.main = createBusinessMain({
  domain: 'upload',
  cloud,
  db,
  logger,
  handlers: {
    confirm: ({ openid, event }) => handleConfirm(openid, event),
  },
})
