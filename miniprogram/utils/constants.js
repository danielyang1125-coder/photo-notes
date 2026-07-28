/* ============================================================
   图片笔记小程序 — 常量定义
   ============================================================ */

/** 用户存储上限（字节） */
const STORAGE_LIMIT_BYTES = 524288000 // 500 MB

/** 图片上传限制 */
const UPLOAD_MAX_SIZE = 20 * 1024 * 1024       // 20 MB
const UPLOAD_ALLOWED_FORMATS = ['JPG', 'JPEG', 'PNG']
const UPLOAD_CONCURRENCY = 3
const UPLOAD_MAX_COUNT = 20

/** 压缩参数 */
const COMPRESS_MAX_EDGE = 2560
const COMPRESS_TARGET_SIZE = 3 * 1024 * 1024    // 3 MB
const COMPRESS_INITIAL_QUALITY = 85
const COMPRESS_MIN_QUALITY = 30

/** 标签限制 */
const TAG_NAME_MIN_LENGTH = 1
const TAG_NAME_MAX_LENGTH = 12            // Unicode code points
const TAG_MAX_COUNT = 100                 // 每用户
const PHOTO_TAG_MAX_COUNT = 5             // 每图片

/** 尺寸限制 */
const NOTE_CONTENT_MAX_LENGTH = 1000      // Unicode code points

/** 分页 */
const PAGE_SIZE = 20

/** 注销确认文本 */
const DELETION_CONFIRM_TEXT = '确认注销'

/** 保留标签名称 */
const RESERVED_TAG_NAMES = ['全部', '未分类']

module.exports = {
  STORAGE_LIMIT_BYTES,
  UPLOAD_MAX_SIZE,
  UPLOAD_ALLOWED_FORMATS,
  UPLOAD_CONCURRENCY,
  UPLOAD_MAX_COUNT,
  COMPRESS_MAX_EDGE,
  COMPRESS_TARGET_SIZE,
  COMPRESS_INITIAL_QUALITY,
  COMPRESS_MIN_QUALITY,
  TAG_NAME_MIN_LENGTH,
  TAG_NAME_MAX_LENGTH,
  TAG_MAX_COUNT,
  PHOTO_TAG_MAX_COUNT,
  NOTE_CONTENT_MAX_LENGTH,
  PAGE_SIZE,
  DELETION_CONFIRM_TEXT,
  RESERVED_TAG_NAMES,
}
