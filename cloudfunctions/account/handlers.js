'use strict'

const { AppError, success } = require('./lib/shared/response')
const { isUniqueConflict, withTransactionRetry } = require('./lib/shared/transaction')

const CONFIRM_TEXT = '确认注销'
const TASK_TYPE = 'ACCOUNT_DELETION'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initialAccountCursor() {
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

function projectTaskStatus(task) {
  if (!task) return null
  return {
    taskId: task._id,
    status: task.status,
    appliedAt: task.applied_at || null,
    completedAt: task.completed_at || null,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createAccountHandlers(options) {
  const { db, now = () => db.serverDate() } = options
  const users = db.collection('users')
  const tasks = db.collection('deletion_tasks')

  function taskKey(openid) {
    return `${TASK_TYPE}:${openid}`
  }

  async function findExistingTask(openid) {
    const key = taskKey(openid)
    let result
    try {
      result = await tasks
        .where({ _openid: openid, task_key: key })
        .limit(1)
        .get()
    } catch (_) {
      return null
    }
    return result && Array.isArray(result.data) && result.data.length > 0
      ? result.data[0]
      : null
  }

  // -----------------------------------------------------------------------
  // requestDeletion
  // -----------------------------------------------------------------------
  async function requestDeletion(openid, event) {
    const confirmText =
      event && typeof event.confirmText === 'string' ? event.confirmText : ''

    if (confirmText !== CONFIRM_TEXT) {
      throw new AppError('VALIDATION_ERROR')
    }

    // Read user — must be ACTIVE to proceed
    let user
    try {
      const result = await users.doc(openid).get()
      user = result && result.data ? result.data : null
    } catch (_) {
      throw new AppError('USER_NOT_ACTIVE')
    }

    if (!user) {
      throw new AppError('USER_NOT_ACTIVE')
    }

    if (user.status !== 'ACTIVE') {
      // DELETING or DELETED — check for existing task
      const existingTask = await findExistingTask(openid)
      if (existingTask) {
        return success(projectTaskStatus(existingTask))
      }
      throw new AppError('USER_NOT_ACTIVE')
    }

    const ts = now()
    const key = taskKey(openid)

    // Atomic transaction: create task + set user → DELETING
    try {
      const taskResult = await withTransactionRetry(db, async (transaction) => {
        const taskData = {
          _openid: openid,
          type: TASK_TYPE,
          task_key: key,
          status: 'PENDING',
          current_stage: 'STORAGE_CLEANUP',
          stage_cursor: initialAccountCursor(),
          retry_count: 0,
          applied_at: ts,
          updated_at: ts,
        }
        const addResult = await transaction
          .collection('deletion_tasks')
          .add({ data: taskData })

        await transaction
          .collection('users')
          .doc(openid)
          .update({
            data: { status: 'DELETING', updated_at: ts },
          })

        return { ...taskData, _id: addResult._id }
      })

      return success(projectTaskStatus(taskResult))
    } catch (error) {
      if (isUniqueConflict(error)) {
        // Another concurrent request already created the task
        const existingTask = await findExistingTask(openid)
        if (existingTask) {
          return success(projectTaskStatus(existingTask))
        }
        throw new AppError('INTERNAL_ERROR')
      }
      throw error
    }
  }

  // -----------------------------------------------------------------------
  // getDeletionStatus
  // -----------------------------------------------------------------------
  async function getDeletionStatus(openid) {
    // Try to read the user record
    let user
    try {
      const result = await users.doc(openid).get()
      user = result && result.data ? result.data : null
    } catch (_) {
      // User record not found — deletion is considered complete
      user = null
    }

    if (user) {
      // User record still exists — find task for authoritative status
      const task = await findExistingTask(openid)
      if (task) {
        return success(projectTaskStatus(task))
      }
      // No task found, return raw user status
      return success({ status: user.status, taskId: null })
    }

    // USER_NOT_FOUND → deletion is complete
    // Try to find anonymous receipt via task_key (which has _openid removed)
    // Since the task is anonymized with _openid = null, we can't search by openid.
    // But the task_key still contains the openid hash pattern.
    // For V1, USER_NOT_FOUND is treated as definitive deletion complete.
    return success({ status: 'DELETED', taskId: null, completedAt: null })
  }

  return {
    requestDeletion,
    getDeletionStatus,
  }
}

module.exports = {
  createAccountHandlers,
}
