'use strict'

const { withTransactionRetry } = require('./lib/shared/transaction')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LEASE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_RETRIES = 10
const MAX_DAYS_SINCE_APPLIED = 7
const DEFAULT_BATCH_SIZE = 10
const TASK_TYPE = 'ACCOUNT_DELETION'

const DISPATCHABLE_STATUSES = ['PENDING', 'RETRYING']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toDate(value) {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

function defaultStageCursor() {
  return {
    storage_photos_cursor: null,
    storage_done: false,
    notes_cursor: null,
    photo_tags_cursor: null,
    tags_cursor: null,
    notes_done: false,
    photo_tags_done: false,
    tags_done: false,
    photos_cursor: null,
    upload_attempts_cursor: null,
    photos_done: false,
    upload_attempts_done: false,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createAccountDeleteWorker(deps) {
  const {
    db,
    deleteFiles,
    now = () => new Date(),
    batchSize = DEFAULT_BATCH_SIZE,
  } = deps

  const _ = db.command

  // -----------------------------------------------------------------------
  // Acquire dispatchable tasks with lease
  // -----------------------------------------------------------------------
  async function acquireTasks(timestamp) {
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp)
    const tasksCol = db.collection('deletion_tasks')

    // Query 1: PENDING / RETRYING where next_retry_at is ready
    const condition1 = {
      type: TASK_TYPE,
      status: _.in(DISPATCHABLE_STATUSES),
      next_retry_at: _.or([_.eq(null), _.lte(ts)]),
    }
    const q1 = await tasksCol.where(condition1).limit(batchSize).get()
    const candidates1 = Array.isArray(q1.data) ? q1.data : []

    // Query 2: Expired PROCESSING leases
    const condition2 = {
      type: TASK_TYPE,
      status: 'PROCESSING',
      lease_expire_at: _.and([_.neq(null), _.lt(ts)]),
    }
    const q2 = await tasksCol.where(condition2).limit(batchSize).get()
    const candidates2 = Array.isArray(q2.data) ? q2.data : []

    // Deduplicate by _id
    const seen = new Set()
    const candidates = []
    for (const t of [...candidates1, ...candidates2]) {
      if (!seen.has(t._id)) {
        seen.add(t._id)
        candidates.push(t)
      }
    }

    if (candidates.length === 0) return []

    const leaseExpireAt = new Date(ts.getTime() + LEASE_TTL_MS)
    const results = await Promise.allSettled(
      candidates.map(async (task) => {
        const leaseToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const updateResult = await tasksCol.where({ _id: task._id }).update({
          data: {
            status: 'PROCESSING',
            lease_token: leaseToken,
            lease_expire_at: leaseExpireAt,
            updated_at: ts,
          },
        })
        return updateResult.stats && updateResult.stats.updated > 0
          ? { ...task, _lease_token: leaseToken }
          : null
      }),
    )

    return results
      .filter((r) => r.status === 'fulfilled' && r.value !== null)
      .map((r) => r.value)
  }

  // -----------------------------------------------------------------------
  // Re-read task to get latest state
  // -----------------------------------------------------------------------
  async function refreshTask(task) {
    try {
      const fresh = await db.collection('deletion_tasks').doc(task._id).get()
      return fresh && fresh.data
        ? Array.isArray(fresh.data)
          ? fresh.data[0]
          : fresh.data
        : task
    } catch (_) {
      return task
    }
  }

  // -----------------------------------------------------------------------
  // Stage 1: STORAGE_CLEANUP
  // -----------------------------------------------------------------------
  async function processStorageCleanup(task, timestamp) {
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp)
    const fresh = await refreshTask(task)
    const cursor = (fresh && fresh.stage_cursor) || defaultStageCursor()

    if (cursor.storage_done) return { stage: 'STORAGE_CLEANUP', skipped: true }

    const photosCol = db.collection('photos')
    const condition = { _openid: task._openid }
    if (cursor.storage_photos_cursor) {
      condition._id = _.gt(cursor.storage_photos_cursor)
    }

    const result = await photosCol
      .where(condition)
      .orderBy('_id', 'asc')
      .limit(batchSize)
      .get()

    const photos = Array.isArray(result.data) ? result.data : []

    if (photos.length === 0) {
      // All photos processed
      await db
        .collection('deletion_tasks')
        .doc(task._id)
        .update({
          data: {
            stage_cursor: { ...cursor, storage_done: true },
            updated_at: ts,
          },
        })
      return { stage: 'STORAGE_CLEANUP', deleted: 0, done: true }
    }

    // Collect file_ids and delete from storage
    const fileIds = photos
      .map((p) => p.file_id)
      .filter((fid) => typeof fid === 'string' && fid.length > 0)

    let deleted = 0
    for (const fid of fileIds) {
      try {
        await deleteFiles([fid])
        deleted++
      } catch (err) {
        const code = (err && (err.errCode || err.code)) || ''
        const isNotFound =
          code === 'STORAGE_FILE_NON_EXIST' ||
          code === 'STORAGE_FILE_NOT_FOUND' ||
          code === 'FUNCTION_FILE_NOT_FOUND'
        if (!isNotFound) throw err
        // File already deleted — idempotent, count as success
        deleted++
      }
    }

    // Advance cursor
    const newCursor = {
      ...cursor,
      storage_photos_cursor: photos[photos.length - 1]._id,
    }

    if (photos.length < batchSize) {
      newCursor.storage_done = true
    }

    // Release lease for next batch if not done
    if (!newCursor.storage_done) {
      await db
        .collection('deletion_tasks')
        .doc(task._id)
        .update({
          data: {
            status: 'PENDING',
            lease_token: null,
            lease_expire_at: null,
            next_retry_at: null,
            stage_cursor: newCursor,
            updated_at: ts,
          },
        })
    } else {
      await db
        .collection('deletion_tasks')
        .doc(task._id)
        .update({
          data: {
            stage_cursor: { ...newCursor, storage_done: true },
            updated_at: ts,
          },
        })
    }

    return { stage: 'STORAGE_CLEANUP', deleted, done: newCursor.storage_done }
  }

  // -----------------------------------------------------------------------
  // Generic batch-delete helper for related/primary data
  // -----------------------------------------------------------------------
  async function batchDeleteCollection(
    task,
    collectionName,
    cursorField,
    doneField,
    extraCondition,
    timestamp,
  ) {
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp)
    const fresh = await refreshTask(task)
    const cursor = (fresh && fresh.stage_cursor) || defaultStageCursor()

    if (cursor[doneField]) return { deleted: 0, done: true }

    const col = db.collection(collectionName)
    const condition = {
      _openid: task._openid,
      ...(extraCondition || {}),
    }
    if (cursor[cursorField]) {
      condition._id = _.gt(cursor[cursorField])
    }

    const result = await col
      .where(condition)
      .orderBy('_id', 'asc')
      .limit(batchSize)
      .get()

    const items = Array.isArray(result.data) ? result.data : []

    if (items.length === 0) {
      const newCursor = { ...cursor, [doneField]: true }
      await db
        .collection('deletion_tasks')
        .doc(task._id)
        .update({ data: { stage_cursor: newCursor, updated_at: ts } })
      return { deleted: 0, done: true }
    }

    let deleted = 0
    await withTransactionRetry(db, async (transaction) => {
      for (const item of items) {
        try {
          await transaction.collection(collectionName).doc(item._id).remove()
          deleted++
        } catch (_) {
          // Already removed — skip
        }
      }
      const newCursor = {
        ...cursor,
        [cursorField]: items[items.length - 1]._id,
      }
      if (items.length < batchSize) {
        newCursor[doneField] = true
      }
      await transaction
        .collection('deletion_tasks')
        .doc(task._id)
        .update({ data: { stage_cursor: newCursor } })
    })

    const finalCursor =
      (await refreshTask(task))?.stage_cursor || defaultStageCursor()
    const done = finalCursor[doneField] || items.length < batchSize

    // Release lease if not done
    if (!done) {
      await db
        .collection('deletion_tasks')
        .doc(task._id)
        .update({
          data: {
            status: 'PENDING',
            lease_token: null,
            lease_expire_at: null,
            next_retry_at: null,
            updated_at: ts,
          },
        })
    }

    return { deleted, done }
  }

  // -----------------------------------------------------------------------
  // Stage 2: RELATED_DATA_CLEANUP
  // -----------------------------------------------------------------------
  async function processRelatedDataCleanup(task, timestamp) {
    const results = {}

    // Notes
    if (!results.notes) {
      results.notes = await batchDeleteCollection(
        task, 'notes', 'notes_cursor', 'notes_done', null, timestamp,
      )
    }

    // Photo_tags
    if (!results.photo_tags) {
      results.photo_tags = await batchDeleteCollection(
        task, 'photo_tags', 'photo_tags_cursor', 'photo_tags_done', null, timestamp,
      )
    }

    // Tags
    if (!results.tags) {
      results.tags = await batchDeleteCollection(
        task, 'tags', 'tags_cursor', 'tags_done', null, timestamp,
      )
    }

    const allDone =
      results.notes?.done &&
      results.photo_tags?.done &&
      results.tags?.done

    if (allDone) {
      await db
        .collection('deletion_tasks')
        .doc(task._id)
        .update({
          data: {
            current_stage: 'PRIMARY_DATA_CLEANUP',
            updated_at: timestamp instanceof Date ? timestamp : new Date(timestamp),
          },
        })
    }

    return { stage: 'RELATED_DATA_CLEANUP', results, allDone }
  }

  // -----------------------------------------------------------------------
  // Stage 3: PRIMARY_DATA_CLEANUP
  // -----------------------------------------------------------------------
  async function processPrimaryDataCleanup(task, timestamp) {
    const results = {}

    // Photos
    if (!results.photos) {
      results.photos = await batchDeleteCollection(
        task, 'photos', 'photos_cursor', 'photos_done', null, timestamp,
      )
    }

    // Upload_attempts
    if (!results.upload_attempts) {
      results.upload_attempts = await batchDeleteCollection(
        task, 'upload_attempts', 'upload_attempts_cursor', 'upload_attempts_done',
        null, timestamp,
      )
    }

    const allDone = results.photos?.done && results.upload_attempts?.done

    if (allDone) {
      await db
        .collection('deletion_tasks')
        .doc(task._id)
        .update({
          data: {
            current_stage: 'USER_FINALIZE',
            updated_at: timestamp instanceof Date ? timestamp : new Date(timestamp),
          },
        })
    }

    return { stage: 'PRIMARY_DATA_CLEANUP', results, allDone }
  }

  // -----------------------------------------------------------------------
  // Stage 4: USER_FINALIZE
  //
  // Delete user record, anonymize deletion task (remove _openid + resource IDs).
  // -----------------------------------------------------------------------
  async function processUserFinalize(task, timestamp) {
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp)

    await withTransactionRetry(db, async (transaction) => {
      // Delete user record
      try {
        await transaction.collection('users').doc(task._openid).remove()
      } catch (_) {
        // User already deleted — idempotent
      }

      // Anonymize task: remove _openid, resource IDs, and internal fields
      // Keep only the receipt for 7-day retention
      await transaction
        .collection('deletion_tasks')
        .doc(task._id)
        .update({
          data: {
            status: 'COMPLETED',
            _openid: null,
            // Remove sensitive/resource fields
            lease_token: null,
            lease_expire_at: null,
            next_retry_at: null,
            last_error: null,
            last_error_at: null,
            stage_cursor: null,
            current_stage: null,
            completed_at: ts,
            updated_at: ts,
          },
        })
    })

    return { stage: 'USER_FINALIZE', done: true }
  }

  // -----------------------------------------------------------------------
  // Error handling: RETRYING or MANUAL_REQUIRED
  // -----------------------------------------------------------------------
  async function failTask(task, error, timestamp) {
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp)

    const fresh = await refreshTask(task)
    const current = fresh || task

    const retryCount = (current.retry_count || 0) + 1
    const appliedAt = toDate(current.applied_at)
    const daysSinceApplied = appliedAt
      ? (ts.getTime() - appliedAt.getTime()) / 86400000
      : 0

    const safeCode =
      (error && (error.code || error.safeErrorCode)) || 'INTERNAL_ERROR'

    if (
      retryCount >= MAX_RETRIES ||
      daysSinceApplied >= MAX_DAYS_SINCE_APPLIED
    ) {
      await db
        .collection('deletion_tasks')
        .doc(task._id)
        .update({
          data: {
            status: 'MANUAL_REQUIRED',
            lease_token: null,
            lease_expire_at: null,
            retry_count: retryCount,
            last_error: safeCode,
            last_error_at: ts,
            updated_at: ts,
          },
        })
    } else {
      const backoffMs = Math.min(
        60000 * Math.pow(2, retryCount),
        86400000,
      )
      const nextRetryAt = new Date(ts.getTime() + backoffMs)

      await db
        .collection('deletion_tasks')
        .doc(task._id)
        .update({
          data: {
            status: 'RETRYING',
            lease_token: null,
            lease_expire_at: null,
            retry_count: retryCount,
            next_retry_at: nextRetryAt,
            last_error: safeCode,
            last_error_at: ts,
            updated_at: ts,
          },
        })
    }
  }

  // -----------------------------------------------------------------------
  // Main run method
  // -----------------------------------------------------------------------
  async function run() {
    const timestamp = now()
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp)

    const tasks = await acquireTasks(ts)

    const summary = {
      acquired: tasks.length,
      succeeded: 0,
      failed: 0,
      details: [],
    }

    for (const task of tasks) {
      const detail = { taskId: task._id, stages: {} }

      try {
        // Stage 1: STORAGE_CLEANUP
        if (
          !task.current_stage ||
          task.current_stage === 'STORAGE_CLEANUP'
        ) {
          detail.stages.storageCleanup = await processStorageCleanup(
            task,
            ts,
          )
          task.current_stage = detail.stages.storageCleanup.done
            ? 'RELATED_DATA_CLEANUP'
            : 'STORAGE_CLEANUP'
          // If not done, release was set — don't proceed further this run
          if (!detail.stages.storageCleanup.done) {
            summary.details.push(detail)
            continue
          }
        }

        // Stage 2: RELATED_DATA_CLEANUP
        if (task.current_stage === 'RELATED_DATA_CLEANUP') {
          detail.stages.relatedDataCleanup =
            await processRelatedDataCleanup(task, ts)
          if (!detail.stages.relatedDataCleanup.allDone) {
            summary.details.push(detail)
            continue
          }
          task.current_stage = 'PRIMARY_DATA_CLEANUP'
        }

        // Stage 3: PRIMARY_DATA_CLEANUP
        if (task.current_stage === 'PRIMARY_DATA_CLEANUP') {
          detail.stages.primaryDataCleanup =
            await processPrimaryDataCleanup(task, ts)
          if (!detail.stages.primaryDataCleanup.allDone) {
            summary.details.push(detail)
            continue
          }
          task.current_stage = 'USER_FINALIZE'
        }

        // Stage 4: USER_FINALIZE
        if (task.current_stage === 'USER_FINALIZE') {
          detail.stages.userFinalize = await processUserFinalize(task, ts)
          summary.succeeded++
        }
      } catch (err) {
        summary.failed++
        detail.error = (err && err.code) || 'INTERNAL_ERROR'
        await failTask(task, err, ts)
      }

      summary.details.push(detail)
    }

    return summary
  }

  return { run }
}

module.exports = {
  LEASE_TTL_MS,
  MAX_RETRIES,
  MAX_DAYS_SINCE_APPLIED,
  createAccountDeleteWorker,
}
