'use strict'

const { withTransactionRetry } = require('./lib/shared/transaction')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LEASE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_RETRIES = 10
const MAX_DAYS_SINCE_APPLIED = 7
const DEFAULT_BATCH_SIZE = 10

const DISPATCHABLE_STATUSES = ['PENDING', 'RETRYING']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toDate(value) {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

function initialStageCursor() {
  return {
    notes_cursor: null,
    photo_tags_cursor: null,
    notes_done: false,
    photo_tags_done: false,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createPhotoDeleteWorker(deps) {
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
  async function acquireTasks(type, timestamp) {
    const ts =
      timestamp instanceof Date ? timestamp : new Date(timestamp)
    const tasksCol = db.collection('deletion_tasks')

    // Query 1: PENDING / RETRYING where next_retry_at is ready
    const condition1 = {
      type,
      status: _.in(DISPATCHABLE_STATUSES),
      next_retry_at: _.or([
        _.eq(null),
        _.lte(ts),
      ]),
    }
    const q1 = await tasksCol
      .where(condition1)
      .limit(batchSize)
      .get()
    const candidates1 = Array.isArray(q1.data) ? q1.data : []

    // Query 2: Expired PROCESSING leases
    const condition2 = {
      type,
      status: 'PROCESSING',
      lease_expire_at: _.and([
        _.neq(null),
        _.lt(ts),
      ]),
    }
    const q2 = await tasksCol
      .where(condition2)
      .limit(batchSize)
      .get()
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

    // Atomic lease acquisition – each update competes independently.
    // Only keep tasks where our update succeeded.
    const leaseExpireAt = new Date(ts.getTime() + LEASE_TTL_MS)
    const results = await Promise.allSettled(
      candidates.map(async (task) => {
        // Use a random lease_token to prevent double-processing
        const leaseToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const updateResult = await tasksCol
          .where({
            _id: task._id,
            // Ensure we only update if still in a dispatchable state or
            // expired lease, preventing two workers from both claiming.
          })
          .update({
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
  // Stage 1: STORAGE_DELETE
  // -----------------------------------------------------------------------
  async function processStorageDelete(task, timestamp) {
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp)

    if (task.file_id) {
      try {
        await deleteFiles([task.file_id])
      } catch (err) {
        // "File not found" is success (idempotent).
        // We check for known NOT_FOUND codes; everything else is a real failure.
        const code = (err && (err.errCode || err.code)) || ''
        const isNotFound =
          code === 'STORAGE_FILE_NON_EXIST' ||
          code === 'STORAGE_FILE_NOT_FOUND' ||
          code === 'FUNCTION_FILE_NOT_FOUND'
        if (!isNotFound) throw err
      }
    }

    // Advance to next stage
    await db
      .collection('deletion_tasks')
      .doc(task._id)
      .update({
        data: {
          current_stage: 'RELATED_DATA_CLEANUP',
          stage_cursor: initialStageCursor(),
          updated_at: ts,
        },
      })
  }

  // -----------------------------------------------------------------------
  // Stage 2: RELATED_DATA_CLEANUP (notes + photo_tags, batched)
  // -----------------------------------------------------------------------

  async function processNotesBatch(task, cursor) {
    const notesCol = db.collection('notes')
    const condition = {
      photo_id: task.photo_id,
      _openid: task._openid,
    }
    if (cursor.notes_cursor) {
      condition._id = _.gt(cursor.notes_cursor)
    }

    const result = await notesCol
      .where(condition)
      .orderBy('_id', 'asc')
      .limit(batchSize)
      .get()

    const notes = Array.isArray(result.data) ? result.data : []
    if (notes.length === 0) {
      cursor.notes_done = true
      return 0
    }

    let deleted = 0
    await withTransactionRetry(db, async (transaction) => {
      for (const note of notes) {
        await transaction.collection('notes').doc(note._id).remove()
        deleted++
      }
      // Advance cursor inside the same transaction
      cursor.notes_cursor = notes[notes.length - 1]._id
      await transaction
        .collection('deletion_tasks')
        .doc(task._id)
        .update({ data: { stage_cursor: cursor } })
    })

    if (notes.length < batchSize) {
      cursor.notes_done = true
    }

    return deleted
  }

  async function processPhotoTagsBatch(task, cursor) {
    const ptCol = db.collection('photo_tags')
    const condition = {
      photo_id: task.photo_id,
      _openid: task._openid,
    }
    if (cursor.photo_tags_cursor) {
      condition._id = _.gt(cursor.photo_tags_cursor)
    }

    const result = await ptCol
      .where(condition)
      .orderBy('_id', 'asc')
      .limit(batchSize)
      .get()

    const relations = Array.isArray(result.data) ? result.data : []
    if (relations.length === 0) {
      cursor.photo_tags_done = true
      return 0
    }

    let deleted = 0
    await withTransactionRetry(db, async (transaction) => {
      for (const rel of relations) {
        try {
          await transaction.collection('photo_tags').doc(rel._id).remove()
        } catch (_) {
          // Already removed – skip
          continue
        }
        deleted++
        // Decrement tag photo_count
        try {
          await transaction
            .collection('tags')
            .doc(rel.tag_id)
            .update({ data: { photo_count: _.inc(-1) } })
        } catch (_) {
          // Tag may already be deleted – ignore
        }
      }
      cursor.photo_tags_cursor = relations[relations.length - 1]._id
      await transaction
        .collection('deletion_tasks')
        .doc(task._id)
        .update({ data: { stage_cursor: cursor } })
    })

    if (relations.length < batchSize) {
      cursor.photo_tags_done = true
    }

    return deleted
  }

  async function processRelatedDataCleanup(task, timestamp) {
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp)

    // Re-read to get latest cursor
    const fresh = await db
      .collection('deletion_tasks')
      .doc(task._id)
      .get()
    const current =
      fresh && fresh.data
        ? Array.isArray(fresh.data)
          ? fresh.data[0]
          : fresh.data
        : task
    const cursor = (current && current.stage_cursor) || initialStageCursor()

    let notesDeleted = 0
    let photoTagsDeleted = 0

    if (!cursor.notes_done) {
      notesDeleted = await processNotesBatch(current || task, cursor)
    }

    if (!cursor.photo_tags_done) {
      photoTagsDeleted = await processPhotoTagsBatch(current || task, cursor)
    }

    const allDone = cursor.notes_done && cursor.photo_tags_done

    if (allDone) {
      await db
        .collection('deletion_tasks')
        .doc(task._id)
        .update({
          data: {
            current_stage: 'PHOTO_FINALIZE',
            updated_at: ts,
          },
        })
    } else {
      // Release lease so the next worker invocation can pick this task up
      // for the next batch.  Without this, the task stays PROCESSING and
      // won't be re-acquired until the lease expires.
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

    return { notesDeleted, photoTagsDeleted, allDone }
  }

  // -----------------------------------------------------------------------
  // Stage 3: PHOTO_FINALIZE
  //
  // Single transaction: confirm DELETING, delete photo, deduct used_bytes,
  // task → COMPLETED.  The space deduction is the ONLY place space is released.
  // -----------------------------------------------------------------------
  async function processPhotoFinalize(task, timestamp) {
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp)

    await withTransactionRetry(db, async (transaction) => {
      // Read user for current used_bytes
      const userResult = await transaction
        .collection('users')
        .doc(task._openid)
        .get()
      const user =
        userResult && userResult.data
          ? Array.isArray(userResult.data)
            ? userResult.data[0]
            : userResult.data
          : null

      // Read and delete photo (if still exists)
      try {
        const photoResult = await transaction
          .collection('photos')
          .doc(task.photo_id)
          .get()
        const photo =
          photoResult && photoResult.data
            ? Array.isArray(photoResult.data)
              ? photoResult.data[0]
              : photoResult.data
            : null

        if (photo) {
          // Only delete if DELETING (safety check)
          if (photo.status === 'DELETING') {
            await transaction
              .collection('photos')
              .doc(task.photo_id)
              .remove()
          }
        }
      } catch (_) {
        // Photo already gone – that's fine for idempotent replay
      }

      // Deduct used_bytes (precise, floor at 0)
      if (user) {
        const currentUsed = typeof user.used_bytes === 'number'
          ? user.used_bytes
          : 0
        const newUsed = Math.max(0, currentUsed - (task.file_size || 0))
        await transaction
          .collection('users')
          .doc(task._openid)
          .update({ data: { used_bytes: newUsed } })
      }

      // Mark task COMPLETED
      await transaction
        .collection('deletion_tasks')
        .doc(task._id)
        .update({
          data: {
            status: 'COMPLETED',
            lease_token: null,
            lease_expire_at: null,
            completed_at: ts,
            updated_at: ts,
          },
        })
    })
  }

  // -----------------------------------------------------------------------
  // Error handling: RETRYING or MANUAL_REQUIRED
  // -----------------------------------------------------------------------
  async function failTask(task, error, timestamp) {
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp)

    // Re-read to get current retry_count (may have been incremented by
    // another stage failure within the same run)
    const fresh = await db
      .collection('deletion_tasks')
      .doc(task._id)
      .get()
    const current =
      fresh && fresh.data
        ? Array.isArray(fresh.data)
          ? fresh.data[0]
          : fresh.data
        : task

    const retryCount = (current.retry_count || 0) + 1
    const appliedAt = toDate(current.applied_at)
    const daysSinceApplied = appliedAt
      ? (ts.getTime() - appliedAt.getTime()) / 86400000
      : 0

    const safeCode = (error && (error.code || error.safeErrorCode)) || 'INTERNAL_ERROR'

    if (retryCount >= MAX_RETRIES || daysSinceApplied >= MAX_DAYS_SINCE_APPLIED) {
      // Terminal: MANUAL_REQUIRED
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
      // Retry with exponential backoff
      const backoffMs = Math.min(
        60000 * Math.pow(2, retryCount),
        86400000, // cap at 1 day
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
    const ts =
      timestamp instanceof Date ? timestamp : new Date(timestamp)

    const tasks = await acquireTasks('PHOTO_DELETE', ts)

    const summary = {
      acquired: tasks.length,
      succeeded: 0,
      failed: 0,
      details: [],
    }

    for (const task of tasks) {
      const detail = { taskId: task._id, photoId: task.photo_id, stages: {} }

      try {
        // Stage 1: STORAGE_DELETE
        if (task.current_stage === 'STORAGE_DELETE') {
          await processStorageDelete(task, ts)
          detail.stages.storageDelete = 'OK'
          // Update local view so subsequent stage checks work
          task.current_stage = 'RELATED_DATA_CLEANUP'
        }

        // Stage 2: RELATED_DATA_CLEANUP
        if (task.current_stage === 'RELATED_DATA_CLEANUP') {
          const result = await processRelatedDataCleanup(task, ts)
          detail.stages.relatedDataCleanup = result.allDone ? 'OK' : 'BATCHED'
          if (result.allDone) {
            task.current_stage = 'PHOTO_FINALIZE'
          }
        }

        // Stage 3: PHOTO_FINALIZE
        if (task.current_stage === 'PHOTO_FINALIZE') {
          await processPhotoFinalize(task, ts)
          detail.stages.photoFinalize = 'OK'
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
  createPhotoDeleteWorker,
}
