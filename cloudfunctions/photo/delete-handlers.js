'use strict'

const { AppError, success } = require('./lib/shared/response')
const validation = require('./lib/shared/validation')
const {
  withTransactionRetry,
  isUniqueConflict,
} = require('./lib/shared/transaction')

const TASK_KEY_PREFIX = 'PHOTO_DELETE:'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createDeleteHandlers(deps) {
  const { db } = deps

  // -----------------------------------------------------------------------
  // Security projection – never exposes internal fields
  // -----------------------------------------------------------------------
  function projectTaskStatus(task) {
    if (!task) return null
    return {
      taskId: task._id,
      photoId: task.photo_id,
      status: task.status,
      updatedAt: task.completed_at || task.last_error_at || task.applied_at,
      completedAt: task.completed_at || null,
    }
  }

  function taskKey(photoId) {
    return `${TASK_KEY_PREFIX}${photoId}`
  }

  // -----------------------------------------------------------------------
  // Build a fresh task document
  // -----------------------------------------------------------------------
  function buildTask(openid, photo) {
    return {
      _openid: openid,
      type: 'PHOTO_DELETE',
      task_key: taskKey(photo._id),
      photo_id: photo._id,
      file_id: photo.file_id || '',
      file_size: photo.file_size || 0,
      status: 'PENDING',
      current_stage: 'STORAGE_DELETE',
      stage_cursor: {
        notes_cursor: null,
        photo_tags_cursor: null,
        notes_done: false,
        photo_tags_done: false,
      },
      retry_count: 0,
      next_retry_at: null,
      lease_token: null,
      lease_expire_at: null,
      last_error: null,
      last_error_at: null,
      applied_at: db.serverDate(),
      completed_at: null,
    }
  }

  // -----------------------------------------------------------------------
  // Look up an existing task for a photo (any status)
  // -----------------------------------------------------------------------
  async function findExistingTask(dbRef, openid, photoId) {
    const key = taskKey(photoId)
    const result = await dbRef
      .collection('deletion_tasks')
      .where({ _openid: openid, task_key: key })
      .limit(1)
      .get()
    return result.data && result.data.length > 0 ? result.data[0] : null
  }

  // -----------------------------------------------------------------------
  // handleDelete
  //
  // Short transaction: ACTIVE → DELETING + create unique PHOTO_DELETE task.
  // Unique conflict → fetch and return the winner.
  // Photo not found → check historical task; return it or PHOTO_NOT_FOUND.
  // -----------------------------------------------------------------------
  async function handleDelete(openid, event) {
    const eventObj = validation.requireObject(event)
    const photoId = validation.string(eventObj.photoId, { min: 1, max: 128 })

    let notFound = false
    let txnResult

    try {
      txnResult = await withTransactionRetry(db, async (transaction) => {
        const photoResult = await transaction
          .collection('photos')
          .where({ _id: photoId, _openid: openid })
          .limit(1)
          .get()

        // Photo not found – defer resolution to post-transaction
        if (!photoResult.data || photoResult.data.length === 0) {
          notFound = true
          return null
        }

        const photo = photoResult.data[0]

        // Already DELETING: return the existing task
        if (photo.status === 'DELETING') {
          const existing = await findExistingTask(transaction, openid, photoId)
          if (existing) return projectTaskStatus(existing)
          // Edge case: DELETING but no task – fall through and create one.
        }

        // ACTIVE → DELETING
        await transaction
          .collection('photos')
          .doc(photoId)
          .update({
            data: {
              status: 'DELETING',
              deleting_at: db.serverDate(),
            },
          })

        // Insert unique task
        const task = buildTask(openid, photo)
        await transaction
          .collection('deletion_tasks')
          .add({ data: task })

        // Re-read to get the server-generated _id
        const created = await findExistingTask(transaction, openid, photoId)
        return created ? projectTaskStatus(created) : projectTaskStatus(task)
      })
    } catch (error) {
      // Unique conflict → another concurrent request created the task first
      if (isUniqueConflict(error)) {
        const existing = await findExistingTask(db, openid, photoId)
        if (existing) return success(projectTaskStatus(existing))
      }
      throw error
    }

    // Photo not found: check for a historical task
    if (notFound) {
      const historical = await findExistingTask(db, openid, photoId)
      if (historical) return success(projectTaskStatus(historical))
      throw new AppError('PHOTO_NOT_FOUND')
    }

    return success(txnResult)
  }

  // -----------------------------------------------------------------------
  // handleGetDeleteStatus
  //
  // Query by taskId (doc _id) or photoId (task_key).  Cross-user tasks
  // return DELETE_TASK_NOT_FOUND (no existence leak).
  // Response is always security-projected.
  // -----------------------------------------------------------------------
  async function handleGetDeleteStatus(openid, event) {
    const eventObj = validation.requireObject(event)
    const taskId = validation.optional(
      eventObj.taskId,
      (v) => validation.string(v, { min: 1, max: 128 }),
    )
    const photoId = validation.optional(
      eventObj.photoId,
      (v) => validation.string(v, { min: 1, max: 128 }),
    )

    if (!taskId && !photoId) {
      throw new AppError('VALIDATION_ERROR')
    }

    // By taskId (document _id)
    if (taskId) {
      let task
      try {
        const res = await db.collection('deletion_tasks').doc(taskId).get()
        if (!res.data) {
          throw new AppError('DELETE_TASK_NOT_FOUND')
        }
        task = Array.isArray(res.data) ? res.data[0] : res.data
      } catch (err) {
        if (err instanceof AppError) throw err
        // doc not found → safe response
        throw new AppError('DELETE_TASK_NOT_FOUND')
      }

      if (!task || task._openid !== openid) {
        throw new AppError('DELETE_TASK_NOT_FOUND')
      }
      return success(projectTaskStatus(task))
    }

    // By photoId (derives task_key)
    if (photoId) {
      const key = taskKey(photoId)
      const result = await db
        .collection('deletion_tasks')
        .where({ _openid: openid, task_key: key })
        .limit(1)
        .get()
      if (!result.data || result.data.length === 0) {
        throw new AppError('DELETE_TASK_NOT_FOUND')
      }
      return success(projectTaskStatus(result.data[0]))
    }

    // Unreachable – kept for safety
    throw new AppError('VALIDATION_ERROR')
  }

  return { handleDelete, handleGetDeleteStatus }
}

module.exports = { createDeleteHandlers }
