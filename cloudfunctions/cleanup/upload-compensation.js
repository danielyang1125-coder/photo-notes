'use strict'

const { withTransactionRetry } = require('./lib/shared/transaction')

const ATTEMPT_STATUSES = Object.freeze([
  'PREPARED',
  'CONFIRMED',
  'CANCELED',
  'EXPIRED',
])
const TERMINAL_STATUSES = Object.freeze([
  'CONFIRMED',
  'CANCELED',
  'EXPIRED',
])
const DEFAULT_BATCH_SIZE = 100
const ACTIVE_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const CHECKPOINT_ID = 'system-upload-compensation-v1'
const CHECKPOINT_OWNER = '__system__'
const CHECKPOINT_TASK_KEY = 'UPLOAD_COMPENSATION:V1'

function toDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function hasValidLease(attempt, timestamp) {
  const expiresAt = toDate(attempt.confirm_lease_expire_at)
  return Boolean(
    attempt.confirm_lease_token &&
    expiresAt &&
    expiresAt.getTime() > timestamp.getTime()
  )
}

function terminalAt(attempt) {
  if (attempt.status === 'CONFIRMED') return toDate(attempt.confirmed_at)
  if (attempt.status === 'CANCELED') return toDate(attempt.canceled_at)
  if (attempt.status === 'EXPIRED') {
    return toDate(attempt.expired_at) || toDate(attempt.updated_at)
  }
  return null
}

function pendingFileId(attempt, environmentId) {
  if (typeof attempt.pending_file_id === 'string' &&
      attempt.pending_file_id) {
    return attempt.pending_file_id
  }
  if (typeof environmentId !== 'string' || !environmentId ||
      typeof attempt.pending_cloud_path !== 'string' ||
      !attempt.pending_cloud_path ||
      attempt.pending_cloud_path.startsWith('/') ||
      attempt.pending_cloud_path.includes('..')) {
    return null
  }
  return `cloud://${environmentId}/${attempt.pending_cloud_path}`
}

function emptyCheckpoint() {
  return {
    _id: CHECKPOINT_ID,
    _openid: CHECKPOINT_OWNER,
    type: 'UPLOAD_COMPENSATION',
    task_key: CHECKPOINT_TASK_KEY,
    status: 'PENDING',
    cursors: {},
  }
}

function createCloudUploadCleanupRepository(options) {
  const { command, db, now = () => new Date() } = options
  const attempts = db.collection('upload_attempts')
  const photos = db.collection('photos')
  const tasks = db.collection('deletion_tasks')

  async function getDocument(collection, id) {
    try {
      const result = await collection.doc(id).get()
      return result && result.data ? result.data : null
    } catch (_) {
      return null
    }
  }

  return {
    async loadCheckpoint() {
      return (await getDocument(tasks, CHECKPOINT_ID)) || emptyCheckpoint()
    },

    async saveCheckpoint(checkpoint) {
      await tasks.doc(CHECKPOINT_ID).set({
        data: {
          _openid: CHECKPOINT_OWNER,
          type: 'UPLOAD_COMPENSATION',
          task_key: CHECKPOINT_TASK_KEY,
          status: 'PENDING',
          cursors: { ...(checkpoint.cursors || {}) },
          updated_at: now(),
        },
      })
    },

    async listAttempts(status, cursor, limit) {
      const condition = { status }
      if (cursor) condition._id = command.gt(cursor)
      const result = await attempts.where(condition)
        .orderBy('_id', 'asc')
        .limit(limit)
        .get()
      return Array.isArray(result && result.data) ? result.data : []
    },

    async expireAttempt(id, timestamp) {
      return withTransactionRetry(db, async (transaction) => {
        const collection = transaction.collection('upload_attempts')
        const attempt = await getDocument(collection, id)
        const expiresAt = attempt && toDate(attempt.expires_at)
        if (!attempt || attempt.status !== 'PREPARED' || !expiresAt ||
            expiresAt.getTime() > timestamp.getTime() ||
            hasValidLease(attempt, timestamp)) {
          return false
        }
        await collection.doc(id).update({
          data: {
            status: 'EXPIRED',
            expired_at: timestamp,
            confirm_lease_token: null,
            confirm_lease_expire_at: null,
            updated_at: timestamp,
          },
        })
        return true
      })
    },

    async releaseExpiredLease(id, timestamp) {
      return withTransactionRetry(db, async (transaction) => {
        const collection = transaction.collection('upload_attempts')
        const attempt = await getDocument(collection, id)
        const leaseExpiresAt = attempt &&
          toDate(attempt.confirm_lease_expire_at)
        if (!attempt || attempt.status !== 'PREPARED' ||
            !attempt.confirm_lease_token || !leaseExpiresAt ||
            leaseExpiresAt.getTime() > timestamp.getTime()) {
          return false
        }
        await collection.doc(id).update({
          data: {
            confirm_lease_token: null,
            confirm_lease_expire_at: null,
            updated_at: timestamp,
          },
        })
        return true
      })
    },

    async findPhoto(attempt) {
      const result = await photos.where({
        _openid: attempt._openid,
        upload_attempt_id: attempt._id,
      }).limit(1).get()
      return result && Array.isArray(result.data) && result.data.length
        ? result.data[0]
        : null
    },

    async markPendingCleaned(id, timestamp) {
      await attempts.doc(id).update({
        data: {
          pending_file_id: null,
          pending_cleaned_at: timestamp,
          updated_at: timestamp,
        },
      })
    },

    async markActiveCleaned(id, timestamp) {
      await attempts.doc(id).update({
        data: {
          promoted_file_id: null,
          verified_meta: null,
          active_cleaned_at: timestamp,
          updated_at: timestamp,
        },
      })
    },

    async removeTerminalAttempt(id, cutoff) {
      return withTransactionRetry(db, async (transaction) => {
        const collection = transaction.collection('upload_attempts')
        const attempt = await getDocument(collection, id)
        const endedAt = attempt && terminalAt(attempt)
        if (!attempt || !TERMINAL_STATUSES.includes(attempt.status) ||
            !endedAt || endedAt.getTime() > cutoff.getTime()) {
          return false
        }
        await collection.doc(id).remove()
        return true
      })
    },
  }
}

function createUploadCompensationService(options) {
  const {
    deleteFiles,
    environmentId,
    now = () => new Date(),
    repository,
    batchSize = DEFAULT_BATCH_SIZE,
  } = options

  if (!repository || typeof deleteFiles !== 'function' ||
      typeof environmentId !== 'function') {
    throw new TypeError('upload cleanup dependencies are required')
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new TypeError('upload cleanup batch size is invalid')
  }

  async function deleteOne(fileId) {
    if (!fileId) return false
    await deleteFiles([fileId])
    return true
  }

  async function scan(checkpoint, key, status, processor) {
    const cursor = checkpoint.cursors[key] || null
    const records = await repository.listAttempts(status, cursor, batchSize)
    let changed = 0
    let failed = 0
    for (const attempt of records) {
      try {
        if (await processor(attempt)) changed += 1
      } catch (_) {
        failed += 1
      }
    }
    checkpoint.cursors[key] =
      records.length === batchSize ? records[records.length - 1]._id : null
    await repository.saveCheckpoint(checkpoint)
    return { scanned: records.length, changed, failed }
  }

  async function run() {
    const timestamp = toDate(now())
    if (!timestamp) throw new TypeError('upload cleanup clock is invalid')
    const checkpoint = await repository.loadCheckpoint()
    checkpoint.cursors = { ...(checkpoint.cursors || {}) }
    const summary = {}

    summary.expired = await scan(
      checkpoint,
      'expire:PREPARED',
      'PREPARED',
      (attempt) => repository.expireAttempt(attempt._id, timestamp),
    )
    summary.releasedLeases = await scan(
      checkpoint,
      'lease:PREPARED',
      'PREPARED',
      (attempt) => repository.releaseExpiredLease(attempt._id, timestamp),
    )

    summary.pending = {}
    for (const status of TERMINAL_STATUSES) {
      summary.pending[status] = await scan(
        checkpoint,
        `pending:${status}`,
        status,
        async (attempt) => {
          if (attempt.pending_cleaned_at) return false
          const fileId = pendingFileId(attempt, environmentId())
          if (!fileId) return false
          await deleteOne(fileId)
          await repository.markPendingCleaned(attempt._id, timestamp)
          return true
        },
      )
    }

    const orphanCutoff = new Date(
      timestamp.getTime() - ACTIVE_ORPHAN_AGE_MS,
    )
    summary.active = {}
    for (const status of ATTEMPT_STATUSES) {
      summary.active[status] = await scan(
        checkpoint,
        `active:${status}`,
        status,
        async (attempt) => {
          if (!attempt.promoted_file_id || attempt.active_cleaned_at ||
              hasValidLease(attempt, timestamp)) {
            return false
          }
          const promotedAt =
            toDate(attempt.promoted_at) || toDate(attempt.updated_at)
          if (!promotedAt ||
              promotedAt.getTime() > orphanCutoff.getTime()) {
            return false
          }
          if (await repository.findPhoto(attempt)) return false
          await deleteOne(attempt.promoted_file_id)
          await repository.markActiveCleaned(attempt._id, timestamp)
          return true
        },
      )
    }

    const retentionCutoff = new Date(
      timestamp.getTime() - TERMINAL_RETENTION_MS,
    )
    summary.archived = {}
    for (const status of TERMINAL_STATUSES) {
      summary.archived[status] = await scan(
        checkpoint,
        `archive:${status}`,
        status,
        async (attempt) => {
          const endedAt = terminalAt(attempt)
          if (!endedAt || endedAt.getTime() > retentionCutoff.getTime() ||
              !attempt.pending_cleaned_at) {
            return false
          }
          if (attempt.promoted_file_id) {
            if (status !== 'CONFIRMED' ||
                !(await repository.findPhoto(attempt))) {
              return false
            }
          }
          return repository.removeTerminalAttempt(
            attempt._id,
            retentionCutoff,
          )
        },
      )
    }

    return summary
  }

  return { run }
}

module.exports = {
  ACTIVE_ORPHAN_AGE_MS,
  CHECKPOINT_ID,
  DEFAULT_BATCH_SIZE,
  TERMINAL_RETENTION_MS,
  createCloudUploadCleanupRepository,
  createUploadCompensationService,
  hasValidLease,
  pendingFileId,
  terminalAt,
}
