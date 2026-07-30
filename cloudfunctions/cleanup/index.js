'use strict'

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const { createTimerMain } = require('./lib/shared/router')
const { createSecurityLogger, countBucket } = require('./lib/shared/security-log')
const {
  createCloudUploadCleanupRepository,
  createUploadCompensationService,
} = require('./upload-compensation')
const { createPhotoDeleteWorker } = require('./photo-delete-worker')
const { createOrphanCleaner } = require('./orphan-cleaner')
const { createCountCorrector } = require('./count-corrector')
const { createAccountDeleteWorker } = require('./account-delete-worker')
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

const accountDeleteWorker = createAccountDeleteWorker({
  db,
  deleteFiles: (fileList) => cloud.deleteFile({ fileList }),
  now: () => new Date(),
  batchSize: 10,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a single worker with timing and error isolation.
 * Returns a structured summary entry.
 */
async function runWorker(name, workerFn, eventName) {
  const startMs = Date.now()
  try {
    const result = await workerFn()
    const durationMs = Date.now() - startMs

    // Log success with sanitized counts
    logger.info({
      event: eventName,
      result: 'SUCCESS',
      durationMs,
      countBucket: countBucket(
        typeof result === 'object' && result !== null
          ? (result.acquired || result.processed || 0)
          : 0,
      ),
    })

    return {
      status: 'OK',
      durationMs,
      ...(typeof result === 'object' && result !== null ? result : { data: result }),
    }
  } catch (_) {
    const durationMs = Date.now() - startMs
    logger.error({
      event: eventName,
      result: 'FAILURE',
      safeErrorCode: 'INTERNAL_ERROR',
      durationMs,
    })
    return {
      status: 'ERROR',
      errorCode: 'INTERNAL_ERROR',
      durationMs,
    }
  }
}

/**
 * Count total MANUAL_REQUIRED tasks across deletion task types.
 */
async function countManualRequiredTasks() {
  try {
    const result = await db
      .collection('deletion_tasks')
      .where({
        status: 'MANUAL_REQUIRED',
      })
      .count()
    return typeof result.total === 'number' ? result.total : 0
  } catch (_) {
    return -1 // unknown
  }
}

// ============================================================
// 定时触发器入口：每日 03:00 执行
// ============================================================
async function handleCleanup() {
  const summary = {
    trigger: 'dailyCleanup',
    startTime: new Date().toISOString(),
    workers: {},
  }

  // 1. 上传 attempt 与对象补偿
  summary.workers.uploadCompensation = await runWorker(
    'uploadCompensation',
    () => uploadCompensation.run(),
    'cleanup.upload_compensation',
  )

  // 2. 异步图片删除任务处理
  summary.workers.photoDeleteWorker = await runWorker(
    'photoDeleteWorker',
    () => photoDeleteWorker.run(),
    'cleanup.photo_delete_worker',
  )

  // 2b. 账号注销任务处理
  summary.workers.accountDeleteWorker = await runWorker(
    'accountDeleteWorker',
    () => accountDeleteWorker.run(),
    'cleanup.account_delete_worker',
  )

  // 3. 扫描孤立 photo_tags（图片已删但关联还在）
  summary.workers.orphanRelations = await runWorker(
    'orphanRelations',
    () => orphanCleaner.run({ dryRun: false, batchSize: BATCH_SIZE }),
    'cleanup.orphan_relations',
  )

  // 4. 计数校正：tags.photo_count + photos.tag_count
  summary.workers.countCorrection = await runWorker(
    'countCorrection',
    () => countCorrector.run({ dryRun: false, batchSize: BATCH_SIZE }),
    'cleanup.count_correction',
  )

  // Aggregate MANUAL_REQUIRED tasks for alerting
  const manualCount = await countManualRequiredTasks()
  summary.manualRequiredTaskCount = manualCount

  if (manualCount > 0) {
    logger.info({
      event: 'cleanup.manual_required_alert',
      result: 'SUCCESS',
      countBucket: countBucket(manualCount),
    })
  }

  summary.endTime = new Date().toISOString()

  return { code: 'SUCCESS', data: summary }
}

// ============================================================
// 每 5 分钟触发器：deleteTaskWorker
// 推进图片删除和账号注销任务
// ============================================================
async function handleDeleteTaskWorker() {
  const summary = {
    trigger: 'deleteTaskWorker',
    startTime: new Date().toISOString(),
    workers: {},
  }

  summary.workers.photoDeleteWorker = await runWorker(
    'photoDeleteWorker',
    () => photoDeleteWorker.run(),
    'cleanup.photo_delete_worker',
  )

  summary.workers.accountDeleteWorker = await runWorker(
    'accountDeleteWorker',
    () => accountDeleteWorker.run(),
    'cleanup.account_delete_worker',
  )

  // Aggregate MANUAL_REQUIRED tasks
  const manualCount = await countManualRequiredTasks()
  summary.manualRequiredTaskCount = manualCount

  if (manualCount > 0) {
    logger.info({
      event: 'cleanup.manual_required_alert',
      result: 'SUCCESS',
      countBucket: countBucket(manualCount),
    })
  }

  summary.endTime = new Date().toISOString()

  return { code: 'SUCCESS', data: summary }
}

async function pickHandler(params) {
  const event = (params && params.event) || {}
  const triggerName = event.TriggerName || ''

  if (triggerName === 'deleteTaskWorker') {
    return handleDeleteTaskWorker()
  }

  return handleCleanup()
}

exports.main = createTimerMain({
  domain: 'cleanup',
  logger,
  handler: pickHandler,
})
