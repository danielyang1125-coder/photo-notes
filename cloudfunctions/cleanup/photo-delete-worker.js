'use strict'

const { withTransactionRetry } = require('./lib/shared/transaction')
const {
  LEASE_TTL_MS,
  LEASE_RENEW_INTERVAL_MS,
  MAX_RETRIES,
  MAX_DAYS_SINCE_APPLIED,
  DISPATCHABLE_STATUSES,
  acquireTasks,
  renewLease,
  releaseLease,
  failTask,
  calculateBackoff,
  toDate,
} = require('./task-lease')

// ---------------------------------------------------------------------------
// Constants (task-lease re-exports + worker-specific)
// ---------------------------------------------------------------------------
const DEFAULT_BATCH_SIZE = 10

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
  let lastLeaseRenewal = null

  // -----------------------------------------------------------------------
  // Renew lease if enough time has passed since last renewal
  // -----------------------------------------------------------------------
  async function maybeRenewLease(task, timestamp) {
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp)
    const nowMs = ts.getTime()
    const lastMs = lastLeaseRenewal ? lastLeaseRenewal.getTime() : 0
    if (nowMs - lastMs >= LEASE_RENEW_INTERVAL_MS) {
      const renewed = await renewLease({ db, task, now: ts })
      if (renewed) {
        lastLeaseRenewal = ts
      }
      return renewed
    }
    return true // still within interval, no renewal needed
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
      // Renew lease during long-running batch processing
      await maybeRenewLease(task, ts)
    }

    if (!cursor.photo_tags_done) {
      photoTagsDeleted = await processPhotoTagsBatch(current || task, cursor)
      await maybeRenewLease(task, ts)
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
      await releaseLease({ db, task, now: ts })
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
  // Main run method
  // -----------------------------------------------------------------------
  async function run() {
    const timestamp = now()
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp)

    // Reset lease renewal tracker for this run
    lastLeaseRenewal = null

    const tasks = await acquireTasks({
      db,
      type: 'PHOTO_DELETE',
      now: ts,
      batchSize,
    })

    const summary = {
      acquired: tasks.length,
      succeeded: 0,
      failed: 0,
      manualRequired: 0,
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
        await failTask({
          db,
          task,
          error: err,
          now: ts,
        })
        // Track MANUAL_REQUIRED escalation
        const freshTask = await db
          .collection('deletion_tasks')
          .doc(task._id)
          .get()
        const updated =
          freshTask && freshTask.data
            ? Array.isArray(freshTask.data)
              ? freshTask.data[0]
              : freshTask.data
            : null
        if (updated && updated.status === 'MANUAL_REQUIRED') {
          summary.manualRequired++
        }
      }

      summary.details.push(detail)
    }

    return summary
  }

  return { run }
}

module.exports = {
  LEASE_TTL_MS,
  LEASE_RENEW_INTERVAL_MS,
  MAX_RETRIES,
  MAX_DAYS_SINCE_APPLIED,
  DISPATCHABLE_STATUSES,
  calculateBackoff,
  createPhotoDeleteWorker,
}
