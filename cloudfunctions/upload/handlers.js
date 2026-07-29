'use strict'

const crypto = require('crypto')
const { AppError, success } = require('./lib/shared/response')
const { withTransactionRetry, isUniqueConflict } =
  require('./lib/shared/transaction')
const validation = require('./lib/shared/validation')

const ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000
const HEX_128_PATTERN = /^[a-f0-9]{32}$/

function defaultRandomHex() {
  return crypto.randomBytes(16).toString('hex')
}

function normalizeNow(now) {
  const value = now()
  const timestamp = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(timestamp.getTime())) {
    throw new AppError('INTERNAL_ERROR')
  }
  return timestamp
}

function normalizeRandomHex(randomHex) {
  const value = randomHex()
  if (typeof value !== 'string' || !HEX_128_PATTERN.test(value)) {
    throw new AppError('INTERNAL_ERROR')
  }
  return value
}

function isoTimestamp(value) {
  const timestamp = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(timestamp.getTime())) {
    throw new AppError('INTERNAL_ERROR')
  }
  return timestamp.toISOString()
}

async function readAttempt(collection, query) {
  const result = await collection.where(query).limit(1).get()
  return result && Array.isArray(result.data) && result.data.length > 0
    ? result.data[0]
    : null
}

function projectPreparedAttempt(attempt) {
  if (!attempt || typeof attempt._id !== 'string' ||
      typeof attempt.pending_cloud_path !== 'string') {
    throw new AppError('INTERNAL_ERROR')
  }

  if (attempt.status === 'CANCELED') {
    throw new AppError('UPLOAD_ATTEMPT_CANCELED')
  }
  if (attempt.status === 'EXPIRED') {
    throw new AppError('UPLOAD_ATTEMPT_EXPIRED')
  }
  if (attempt.status !== 'PREPARED' && attempt.status !== 'CONFIRMED') {
    throw new AppError('INTERNAL_ERROR')
  }

  const data = {
    attemptId: attempt._id,
    cloudPath: attempt.pending_cloud_path,
    expiresAt: isoTimestamp(attempt.expires_at),
  }
  if (attempt.status === 'CONFIRMED') {
    if (typeof attempt.photo_id !== 'string' || !attempt.photo_id) {
      throw new AppError('INTERNAL_ERROR')
    }
    data.photoId = attempt.photo_id
  }
  return success(data)
}

function projectCancelState(attemptId, attempt) {
  if (!attempt) {
    return {
      attemptId,
      status: 'NOT_FOUND',
      code: 'UPLOAD_ATTEMPT_NOT_FOUND',
    }
  }
  if (attempt.status === 'CONFIRMED') {
    if (typeof attempt.photo_id !== 'string' || !attempt.photo_id) {
      throw new AppError('INTERNAL_ERROR')
    }
    return {
      attemptId,
      status: 'CONFIRMED',
      photoId: attempt.photo_id,
    }
  }
  if (attempt.status === 'CANCELED') {
    return { attemptId, status: 'CANCELED' }
  }
  if (attempt.status === 'EXPIRED') {
    return {
      attemptId,
      status: 'EXPIRED',
      code: 'UPLOAD_ATTEMPT_EXPIRED',
    }
  }
  if (attempt.status !== 'PREPARED') {
    throw new AppError('INTERNAL_ERROR')
  }
  return null
}

function createUploadAttemptHandlers(options) {
  const {
    db,
    now = () => new Date(),
    randomHex = defaultRandomHex,
  } = options
  const attempts = db.collection('upload_attempts')

  async function prepare(openid, event) {
    const input = validation.requireObject(event)
    const taskId = validation.requestId(input.taskId)
    const existing = await readAttempt(attempts, {
      _openid: openid,
      task_id: taskId,
    })
    if (existing) return projectPreparedAttempt(existing)

    const timestamp = normalizeNow(now)
    const attemptId = normalizeRandomHex(randomHex)
    const cloudPath =
      `uploads/pending/${normalizeRandomHex(randomHex)}.bin`
    const attempt = {
      _id: attemptId,
      _openid: openid,
      task_id: taskId,
      status: 'PREPARED',
      pending_cloud_path: cloudPath,
      pending_file_id: null,
      promoted_file_id: null,
      verified_meta: null,
      confirm_lease_token: null,
      confirm_lease_expire_at: null,
      photo_id: null,
      expires_at: new Date(timestamp.getTime() + ATTEMPT_TTL_MS),
      created_at: timestamp,
      updated_at: timestamp,
      confirmed_at: null,
      canceled_at: null,
    }

    try {
      await attempts.add({ data: attempt })
      return projectPreparedAttempt(attempt)
    } catch (error) {
      if (!isUniqueConflict(error)) throw error
      const winner = await readAttempt(attempts, {
        _openid: openid,
        task_id: taskId,
      })
      if (!winner) throw new AppError('INTERNAL_ERROR')
      return projectPreparedAttempt(winner)
    }
  }

  async function cancelOne(openid, attemptId) {
    return withTransactionRetry(db, async (transaction) => {
      const transactionAttempts = transaction.collection('upload_attempts')
      const attempt = await readAttempt(transactionAttempts, {
        _id: attemptId,
        _openid: openid,
      })
      const terminal = projectCancelState(attemptId, attempt)
      if (terminal) return terminal

      const timestamp = normalizeNow(now)
      await transactionAttempts.doc(attemptId).update({
        data: {
          status: 'CANCELED',
          canceled_at: timestamp,
          updated_at: timestamp,
        },
      })
      return { attemptId, status: 'CANCELED' }
    })
  }

  async function cancel(openid, event) {
    const input = validation.requireObject(event)
    const attemptIds = validation.array(input.attemptIds, {
      min: 1,
      max: 20,
      unique: true,
      item: validation.requestId,
    })
    const results = []
    for (const attemptId of attemptIds) {
      try {
        results.push(await cancelOne(openid, attemptId))
      } catch (_) {
        results.push({
          attemptId,
          status: 'FAILED',
          code: 'INTERNAL_ERROR',
        })
      }
    }
    return success({ results })
  }

  return {
    cancel,
    prepare,
  }
}

module.exports = {
  ATTEMPT_TTL_MS,
  createUploadAttemptHandlers,
  projectCancelState,
  projectPreparedAttempt,
}
