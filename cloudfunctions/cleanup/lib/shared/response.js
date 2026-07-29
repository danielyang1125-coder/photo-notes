'use strict'

const PUBLIC_MESSAGES = Object.freeze({
  AUTH_FAILED: '身份验证失败',
  USER_NOT_ACTIVE: '账号状态异常',
  FORBIDDEN: '当前操作不可用',
  VALIDATION_ERROR: '请求参数不合法',
  UNKNOWN_TYPE: '未知操作类型',
  NOT_FOUND: '资源不存在或已删除',
  PHOTO_NOT_FOUND: '图片不存在或已删除',
  TAG_NOT_FOUND: '标签不存在或已删除',
  UPLOAD_ATTEMPT_NOT_FOUND: '上传任务不存在或已失效',
  DELETE_TASK_NOT_FOUND: '删除任务不存在或已失效',
  INVALID_CURSOR: '分页信息已失效，请刷新后重试',
  CONFLICT: '数据已更新，请刷新后重试',
  SPACE_EXCEEDED: '存储空间不足',
  TAG_NAME_INVALID: '标签名称不合法',
  TAG_NAME_DUPLICATED: '标签名称已存在',
  TAG_LIMIT_REACHED: '标签数量已达上限',
  PHOTO_TAG_LIMIT_REACHED: '图片标签数量已达上限',
  UPLOAD_ATTEMPT_CANCELED: '上传任务已取消',
  UPLOAD_ATTEMPT_EXPIRED: '上传任务已过期',
  UPLOAD_CONFIRM_IN_PROGRESS: '上传任务正在确认',
  UPLOAD_FILE_MISMATCH: '上传文件不匹配',
  UPLOAD_FILE_INVALID: '上传文件无效',
  DELETION_ALREADY_PENDING: '已有未完成的注销任务',
  CONTENT_REVIEW_FAILED: '内容不合规',
  CONTENT_REVIEW_UNAVAILABLE: '内容审核服务暂时不可用',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试',
})

class AppError extends Error {
  constructor(code, options = {}) {
    super(PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.INTERNAL_ERROR)
    this.name = 'AppError'
    this.code = PUBLIC_MESSAGES[code] ? code : 'INTERNAL_ERROR'
    this.details = options.details
    this.cause = options.cause
  }
}

function success(data, message) {
  const response = { code: 'SUCCESS', data: data === undefined ? {} : data }
  if (message) response.message = String(message)
  return response
}

function failure(code) {
  const safeCode = PUBLIC_MESSAGES[code] ? code : 'INTERNAL_ERROR'
  return {
    code: safeCode,
    message: PUBLIC_MESSAGES[safeCode],
  }
}

function normalizeResponse(value) {
  if (!value || typeof value !== 'object') return success(value)
  if (value.code === 'SUCCESS') {
    return success(value.data, value.message)
  }
  if (typeof value.code === 'string') {
    return failure(value.code)
  }
  return success(value)
}

function errorResponse(error) {
  if (error instanceof AppError) return failure(error.code)
  if (error && PUBLIC_MESSAGES[error.code]) return failure(error.code)
  return failure('INTERNAL_ERROR')
}

module.exports = {
  AppError,
  PUBLIC_MESSAGES,
  errorResponse,
  failure,
  normalizeResponse,
  success,
}
