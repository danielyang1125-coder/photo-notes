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
const { createOrphanCleaner } = require('./orphan-cleaner')
const { createCountCorrector } = require('./count-corrector')
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

const orphanCleaner = createOrphanCleaner({
  db,
  now: () => new Date(),
})

const countCorrector = createCountCorrector({
  db,
  now: () => new Date(),
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

  // 4. 计数校正：tags.photo_count + photos.tag_count
  try {
    const r = await correctCounts()
    summary.countCorrection = r
  } catch (_) {
    logger.error({
      event: 'cleanup.count_correction',
      result: 'FAILURE',
      safeErrorCode: 'INTERNAL_ERROR',
    })
    summary.countCorrection = { errorCode: 'INTERNAL_ERROR' }
  }

  return { code: 'SUCCESS', data: summary }
}

// ============================================================
// 清理孤立 photo_tags（委托给 orphan-cleaner 模块）
// ============================================================
async function cleanOrphanRelations() {
  return orphanCleaner.run({ dryRun: false, batchSize: BATCH_SIZE })
}

// ============================================================
// 校正 tags.photo_count + photos.tag_count（委托给 count-corrector 模块）
// ============================================================
async function correctCounts() {
  return countCorrector.run({ dryRun: false, batchSize: BATCH_SIZE })
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
