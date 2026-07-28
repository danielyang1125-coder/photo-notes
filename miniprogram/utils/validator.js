/**
 * 输入校验模块 — 前后端同口径
 */
const C = require('./constants')

/** Unicode code point 计数（去首尾空白后） */
function countCodePoints(str) {
  const trimmed = (str || '').replace(/^[\s ]+|[\s ]+$/g, '')
  return [...trimmed].length
}

/** 校验备注内容 */
function validateNoteContent(content) {
  if (!content || typeof content !== 'string') {
    return { valid: false, error: '内容不能为空' }
  }
  const cp = countCodePoints(content)
  if (cp < 1) return { valid: false, error: '内容不能为空' }
  if (cp > C.NOTE_CONTENT_MAX_LENGTH) {
    return {
      valid: false,
      error: '备注最长 ' + C.NOTE_CONTENT_MAX_LENGTH + ' 个字符，当前 ' + cp + ' 个',
    }
  }
  return { valid: true, codePointCount: cp }
}

/** 校验图片格式 */
function validatePhotoFormat(ext) {
  const upper = (ext || '').toUpperCase()
  return C.UPLOAD_ALLOWED_FORMATS.includes(upper)
}

/** 校验图片文件大小 */
function validatePhotoSize(bytes) {
  return bytes <= C.UPLOAD_MAX_SIZE
}

/** 获取可读的图片大小限制 */
function readableLimit() {
  return (C.UPLOAD_MAX_SIZE / 1024 / 1024).toFixed(0) + 'MB'
}

/**
 * 标签名称本地即时校验（与服务端同口径）
 * 服务端为权威结果
 */
function validateTagName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: '标签名称不能为空' }
  }
  const trimmed = name.replace(/^[\s ]+|[\s ]+$/g, '')
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return { valid: false, error: '标签名称包含非法字符' }
  }
  const cp = [...trimmed].length
  if (cp < C.TAG_NAME_MIN_LENGTH || cp > C.TAG_NAME_MAX_LENGTH) {
    return {
      valid: false,
      error: '标签长度为 ' + C.TAG_NAME_MIN_LENGTH + '~' + C.TAG_NAME_MAX_LENGTH + ' 个字符',
    }
  }
  if (C.RESERVED_TAG_NAMES.includes(trimmed)) {
    return { valid: false, error: '不能使用保留名称' }
  }
  return { valid: true, name: trimmed }
}

module.exports = {
  countCodePoints,
  validateNoteContent,
  validatePhotoFormat,
  validatePhotoSize,
  readableLimit,
  validateTagName,
}
