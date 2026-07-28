const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function getOpenId() {
  return cloud.getWXContext().OPENID
}

async function checkUserActive(openid) {
  try {
    const user = await db.collection('users').doc(openid).get()
    if (!user.data || user.data.status !== 'ACTIVE') {
      throw { code: 'USER_NOT_ACTIVE', message: '账号状态异常' }
    }
    return user.data
  } catch (e) {
    if (e.code) throw e
    throw { code: 'USER_NOT_ACTIVE', message: '用户不存在' }
  }
}

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
    console.warn('[upload] imgSecCheck 未可用，放行:', e.errCode || e.message)
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
  const addResult = await db.collection('photos').add({ data: photo })

  // 原子更新空间用量
  if (size > 0) {
    await db.collection('users').doc(openid)
      .update({ data: { used_bytes: _.inc(size) } })
  }

  return {
    code: 'SUCCESS',
    data: { photo: { _id: addResult._id, ...photo } },
  }
}

// ============================================================
exports.main = async (event, context) => {
  const openid = getOpenId()
  if (!openid) return { code: 'AUTH_FAILED', message: '身份验证失败' }
  try {
    await checkUserActive(openid)
    switch (event.type) {
      case 'confirm':
        return handleConfirm(openid, event)
      default:
        return { code: 'UNKNOWN_TYPE', message: '支持: confirm' }
    }
  } catch (err) {
    if (err.code && err.code !== 'INTERNAL_ERROR') {
      return { code: err.code, message: err.message }
    }
    console.error('[upload]', err)
    return { code: err.code || 'INTERNAL_ERROR', message: err.message || '服务异常' }
  }
}
