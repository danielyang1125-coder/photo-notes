const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const { createTimerMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const {
  createCloudUploadCleanupRepository,
  createUploadCompensationService,
} = require('./upload-compensation')
const { createPhotoDeleteWorker } = require('./photo-delete-worker')
const logger = createSecurityLogger()

const BATCH_SIZE = 100
function currentEnvironmentId() {
  const context = cloud.getWXContext()
  return context && typeof context.ENV === 'string' ? context.ENV : ''
}
const uploadCompensation = createUploadCompensationService({
  deleteFiles: (fileList) => cloud.deleteFile({ fileList }),
  environmentId: currentEnvironmentId,
  repository: createCloudUploadCleanupRepository({
    command: _,
    db,
  }),
})

const photoDeleteWorker = createPhotoDeleteWorker({
  db,
  deleteFiles: (fileList) => cloud.deleteFile({ fileList }),
  now: () => new Date(),
  batchSize: 10,
})

// ============================================================
// 定时触发器入口：每日 03:00 执行
// ============================================================
async function handleCleanup() {
  const summary = {}

  // 1. 上传 attempt 与对象补偿
  try {
    const r = await uploadCompensation.run()
    summary.uploadCompensation = r
  } catch (_) {
    logger.error({
      event: 'cleanup.upload_compensation',
      result: 'FAILURE',
      safeErrorCode: 'INTERNAL_ERROR',
    })
    summary.uploadCompensation = { errorCode: 'INTERNAL_ERROR' }
  }

  // 2. 异步图片删除任务处理
  try {
    const r = await photoDeleteWorker.run()
    summary.photoDeleteWorker = r
  } catch (_) {
    logger.error({
      event: 'cleanup.photo_delete_worker',
      result: 'FAILURE',
      safeErrorCode: 'INTERNAL_ERROR',
    })
    summary.photoDeleteWorker = { errorCode: 'INTERNAL_ERROR' }
  }

  // 3. 扫描孤立 photo_tags（图片已删但关联还在）
  try {
    const r = await cleanOrphanRelations()
    summary.orphanRelations = r
  } catch (_) {
    logger.error({
      event: 'cleanup.orphan_relations',
      result: 'FAILURE',
      safeErrorCode: 'INTERNAL_ERROR',
    })
    summary.orphanRelations = { errorCode: 'INTERNAL_ERROR' }
  }

  // 4. 计数校正：tags.photo_count
  try {
    const r = await correctTagCounts()
    summary.tagCountCorrection = r
  } catch (_) {
    logger.error({
      event: 'cleanup.tag_count_correction',
      result: 'FAILURE',
      safeErrorCode: 'INTERNAL_ERROR',
    })
    summary.tagCountCorrection = { errorCode: 'INTERNAL_ERROR' }
  }

  // 5. 计数校正：photos.tag_count
  try {
    const r = await correctPhotoTagCounts()
    summary.photoTagCountCorrection = r
  } catch (_) {
    logger.error({
      event: 'cleanup.photo_tag_count_correction',
      result: 'FAILURE',
      safeErrorCode: 'INTERNAL_ERROR',
    })
    summary.photoTagCountCorrection = { errorCode: 'INTERNAL_ERROR' }
  }

  return { code: 'SUCCESS', data: summary }
}

// ============================================================
// 清理孤立 photo_tags
// ============================================================
async function cleanOrphanRelations() {
  // 找 photo_tags 中图片已不存在的关系
  const relations = await db.collection('photo_tags')
    .limit(BATCH_SIZE)
    .get()

  let cleaned = 0
  for (const rel of (relations.data || [])) {
    try {
      const photo = await db.collection('photos')
        .where({ _id: rel.photo_id, _openid: rel._openid }).get()
      if (!photo.data || photo.data.length === 0) {
        await db.collection('photo_tags').doc(rel._id).remove()
        cleaned++
      }
    } catch (_) {
      // 跳过
    }
  }
  return { scanned: (relations.data || []).length, cleaned }
}

// ============================================================
// 校正 tags.photo_count
// ============================================================
async function correctTagCounts() {
  const tags = await db.collection('tags').limit(BATCH_SIZE).get()
  let corrected = 0

  for (const tag of (tags.data || [])) {
    const count = await db.collection('photo_tags')
      .where({ tag_id: tag._id, _openid: tag._openid }).count()
    if (count.total !== (tag.photo_count || 0)) {
      await db.collection('tags').doc(tag._id)
        .update({ data: { photo_count: count.total } })
      corrected++
    }
  }
  return { scanned: (tags.data || []).length, corrected }
}

// ============================================================
// 校正 photos.tag_count
// ============================================================
async function correctPhotoTagCounts() {
  const photos = await db.collection('photos').limit(BATCH_SIZE).get()
  let corrected = 0

  for (const photo of (photos.data || [])) {
    const count = await db.collection('photo_tags')
      .where({ photo_id: photo._id, _openid: photo._openid }).count()
    if (count.total !== (photo.tag_count || 0)) {
      await db.collection('photos').doc(photo._id)
        .update({ data: { tag_count: count.total } })
      corrected++
    }
  }
  return { scanned: (photos.data || []).length, corrected }
}

async function pickHandler(params) {
  const event = (params && params.event) || {}
  const triggerName = event.TriggerName || ''
  if (triggerName === 'deleteTaskWorker') {
    const result = await photoDeleteWorker.run()
    return { code: 'SUCCESS', data: result }
  }
  return handleCleanup()
}

exports.main = createTimerMain({
  domain: 'cleanup',
  logger,
  handler: pickHandler,
})
