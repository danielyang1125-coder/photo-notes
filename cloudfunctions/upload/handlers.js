'use strict'

const crypto = require('crypto')
const { AppError, success } = require('./lib/shared/response')
const { withTransactionRetry, isUniqueConflict } =
  require('./lib/shared/transaction')
const validation = require('./lib/shared/validation')

const ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000
const CONFIRM_LEASE_MS = 2 * 60 * 1000
const MIN_SHOOT_TIME_MS = Date.parse('1900-01-01T00:00:00.000Z')
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

async function readPhoto(collection, query) {
  const result = await collection.where(query).limit(1).get()
  return result && Array.isArray(result.data) && result.data.length > 0
    ? result.data[0]
    : null
}

function assertConfirmInput(event, timestamp) {
  const input = validation.requireObject(event)
  const allowed = new Set([
    'type',
    'attemptId',
    'fileId',
    'shootTime',
    'timeSource',
  ])
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new AppError('VALIDATION_ERROR')
  }
  const attemptId = validation.requestId(input.attemptId)
  const fileId = validation.string(input.fileId, { min: 1, max: 1024 })
  const timeSource = validation.enumValue(input.timeSource, [
    'EXIF',
    'UPLOAD_TIME',
  ])
  let shootTime = timestamp
  if (timeSource === 'EXIF') {
    shootTime = validation.isoDate(input.shootTime)
    if (shootTime.getTime() < MIN_SHOOT_TIME_MS ||
        shootTime.getTime() > timestamp.getTime() + 5 * 60 * 1000) {
      throw new AppError('VALIDATION_ERROR')
    }
  } else if (input.shootTime !== undefined && input.shootTime !== null) {
    validation.isoDate(input.shootTime)
  }
  return { attemptId, fileId, shootTime, timeSource }
}

function assertPendingFile(fileId, environmentId, pendingCloudPath) {
  if (typeof environmentId !== 'string' || !environmentId ||
      typeof pendingCloudPath !== 'string' || !pendingCloudPath) {
    throw new AppError('INTERNAL_ERROR')
  }
  const match = /^cloud:\/\/([^/]+)\/(.+)$/.exec(fileId)
  if (!match ||
      (match[1] !== environmentId &&
        !match[1].startsWith(`${environmentId}.`)) ||
      match[2] !== pendingCloudPath) {
    throw new AppError('UPLOAD_FILE_MISMATCH')
  }
}

function projectPhoto(photo, duplicated) {
  if (!photo || typeof photo._id !== 'string') {
    throw new AppError('INTERNAL_ERROR')
  }
  return success({
    photo: {
      _id: photo._id,
      file_size: photo.file_size,
      width: photo.width,
      height: photo.height,
      format: photo.format,
      shoot_time: isoTimestamp(photo.shoot_time),
      time_source: photo.time_source,
      upload_time: isoTimestamp(photo.upload_time),
    },
    duplicated: Boolean(duplicated),
  })
}

function terminalConfirmResult(attempt) {
  if (!attempt) throw new AppError('UPLOAD_ATTEMPT_NOT_FOUND')
  if (attempt.status === 'CANCELED') {
    throw new AppError('UPLOAD_ATTEMPT_CANCELED')
  }
  if (attempt.status === 'EXPIRED') {
    throw new AppError('UPLOAD_ATTEMPT_EXPIRED')
  }
  if (attempt.status !== 'PREPARED' && attempt.status !== 'CONFIRMED') {
    throw new AppError('INTERNAL_ERROR')
  }
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
    deleteFiles = async () => {},
    downloadFile,
    environmentId,
    isContentReviewEnabled = () => true,
    now = () => new Date(),
    processImage,
    reviewImage,
    randomHex = defaultRandomHex,
    uploadFile,
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

  async function acquireConfirmLease(openid, input, timestamp) {
    return withTransactionRetry(db, async (transaction) => {
      const transactionAttempts = transaction.collection('upload_attempts')
      const attempt = await readAttempt(transactionAttempts, {
        _id: input.attemptId,
        _openid: openid,
      })
      terminalConfirmResult(attempt)
      if (attempt.status === 'CONFIRMED') return { confirmed: attempt }
      if (new Date(attempt.expires_at).getTime() <= timestamp.getTime()) {
        throw new AppError('UPLOAD_ATTEMPT_EXPIRED')
      }
      assertPendingFile(input.fileId, environmentId(), attempt.pending_cloud_path)
      if (attempt.pending_file_id &&
          attempt.pending_file_id !== input.fileId) {
        throw new AppError('UPLOAD_FILE_MISMATCH')
      }
      const leaseExpiresAt = attempt.confirm_lease_expire_at &&
        new Date(attempt.confirm_lease_expire_at)
      if (leaseExpiresAt &&
          Number.isFinite(leaseExpiresAt.getTime()) &&
          leaseExpiresAt.getTime() > timestamp.getTime()) {
        throw new AppError('UPLOAD_CONFIRM_IN_PROGRESS')
      }

      const leaseToken = normalizeRandomHex(randomHex)
      const leaseExpireAt = new Date(timestamp.getTime() + CONFIRM_LEASE_MS)
      await transactionAttempts.doc(input.attemptId).update({
        data: {
          pending_file_id: input.fileId,
          confirm_lease_token: leaseToken,
          confirm_lease_expire_at: leaseExpireAt,
          updated_at: timestamp,
        },
      })
      return {
        attempt: {
          ...attempt,
          pending_file_id: input.fileId,
          confirm_lease_token: leaseToken,
          confirm_lease_expire_at: leaseExpireAt,
        },
        leaseToken,
      }
    })
  }

  async function persistPromotion(openid, attemptId, leaseToken, promoted) {
    return withTransactionRetry(db, async (transaction) => {
      const transactionAttempts = transaction.collection('upload_attempts')
      const attempt = await readAttempt(transactionAttempts, {
        _id: attemptId,
        _openid: openid,
      })
      terminalConfirmResult(attempt)
      if (attempt.status === 'CONFIRMED') return attempt
      if (attempt.confirm_lease_token !== leaseToken) {
        throw new AppError('UPLOAD_CONFIRM_IN_PROGRESS')
      }
      const timestamp = normalizeNow(now)
      await transactionAttempts.doc(attemptId).update({
        data: {
          promoted_file_id: promoted.fileId,
          verified_meta: promoted.metadata,
          updated_at: timestamp,
        },
      })
      return {
        ...attempt,
        promoted_file_id: promoted.fileId,
        verified_meta: promoted.metadata,
      }
    })
  }

  async function createPromotion(openid, input, lease) {
    const reusable = lease.attempt.promoted_file_id &&
      lease.attempt.verified_meta
    if (reusable) {
      return {
        fileId: lease.attempt.promoted_file_id,
        metadata: lease.attempt.verified_meta,
      }
    }
    if (typeof downloadFile !== 'function' ||
        typeof processImage !== 'function' ||
        typeof reviewImage !== 'function' ||
        typeof uploadFile !== 'function') {
      throw new AppError('INTERNAL_ERROR')
    }

    let downloaded
    try {
      downloaded = await downloadFile(input.fileId)
    } catch (_) {
      throw new AppError('UPLOAD_FILE_INVALID')
    }
    const processed = await processImage(
      downloaded && downloaded.fileContent !== undefined
        ? downloaded.fileContent
        : downloaded,
    )
    if (isContentReviewEnabled()) {
      await reviewImage(processed.reviewBuffer, processed.contentType)
    }
    const activePath =
      `photos/active/${normalizeRandomHex(randomHex)}.${processed.extension}`
    let uploaded
    try {
      uploaded = await uploadFile(activePath, processed.buffer)
    } catch (_) {
      throw new AppError('INTERNAL_ERROR')
    }
    if (!uploaded || typeof uploaded.fileID !== 'string' || !uploaded.fileID) {
      throw new AppError('INTERNAL_ERROR')
    }
    return {
      fileId: uploaded.fileID,
      metadata: processed.metadata,
    }
  }

  async function finalizeConfirm(openid, input, leaseToken, promotion) {
    const photoId = normalizeRandomHex(randomHex)
    try {
      return await withTransactionRetry(db, async (transaction) => {
        const transactionAttempts = transaction.collection('upload_attempts')
        const transactionPhotos = transaction.collection('photos')
        const transactionUsers = transaction.collection('users')
        const attempt = await readAttempt(transactionAttempts, {
          _id: input.attemptId,
          _openid: openid,
        })
        terminalConfirmResult(attempt)
        if (attempt.status === 'CONFIRMED') {
          const existing = await readPhoto(transactionPhotos, {
            _id: attempt.photo_id,
            _openid: openid,
          })
          if (!existing) throw new AppError('INTERNAL_ERROR')
          return projectPhoto(existing, true)
        }
        if (attempt.confirm_lease_token !== leaseToken ||
            attempt.promoted_file_id !== promotion.fileId) {
          throw new AppError('UPLOAD_CONFIRM_IN_PROGRESS')
        }

        const userResult = await transactionUsers.doc(openid).get()
        const user = userResult && userResult.data
        if (!user || user.status !== 'ACTIVE') {
          throw new AppError('USER_NOT_ACTIVE')
        }
        const usedBytes = Number(user.used_bytes)
        const limitBytes = Number(user.limit_bytes)
        const fileSize = Number(promotion.metadata.file_size)
        if (!Number.isSafeInteger(usedBytes) ||
            !Number.isSafeInteger(limitBytes) ||
            !Number.isSafeInteger(fileSize) ||
            fileSize < 1) {
          throw new AppError('INTERNAL_ERROR')
        }
        if (usedBytes + fileSize > limitBytes) {
          throw new AppError('SPACE_EXCEEDED')
        }

        const timestamp = normalizeNow(now)
        const photo = {
          _id: photoId,
          _openid: openid,
          file_id: promotion.fileId,
          task_id: attempt.task_id,
          upload_attempt_id: attempt._id,
          file_size: fileSize,
          width: promotion.metadata.width,
          height: promotion.metadata.height,
          format: promotion.metadata.format,
          sha256: promotion.metadata.sha256,
          shoot_time: input.shootTime,
          time_source: input.timeSource,
          upload_time: timestamp,
          status: 'ACTIVE',
          note_count: 0,
          tag_count: 0,
          created_at: timestamp,
          updated_at: timestamp,
          deleting_at: null,
        }
        await transactionPhotos.add({ data: photo })
        await transactionUsers.doc(openid).update({
          data: { used_bytes: usedBytes + fileSize },
        })
        await transactionAttempts.doc(input.attemptId).update({
          data: {
            status: 'CONFIRMED',
            photo_id: photoId,
            confirm_lease_token: null,
            confirm_lease_expire_at: null,
            confirmed_at: timestamp,
            updated_at: timestamp,
          },
        })
        return projectPhoto(photo, false)
      })
    } catch (error) {
      if (!isUniqueConflict(error)) throw error
      const existing = await readPhoto(db.collection('photos'), {
        _openid: openid,
        upload_attempt_id: input.attemptId,
      })
      if (!existing) throw new AppError('INTERNAL_ERROR')
      return projectPhoto(existing, true)
    }
  }

  async function confirm(openid, event) {
    const timestamp = normalizeNow(now)
    const input = assertConfirmInput(event, timestamp)
    const lease = await acquireConfirmLease(openid, input, timestamp)
    if (lease.confirmed) {
      const existing = await readPhoto(db.collection('photos'), {
        _id: lease.confirmed.photo_id,
        _openid: openid,
      })
      if (!existing) throw new AppError('INTERNAL_ERROR')
      return projectPhoto(existing, true)
    }

    let promotion
    try {
      promotion = await createPromotion(openid, input, lease)
      await persistPromotion(
        openid,
        input.attemptId,
        lease.leaseToken,
        promotion,
      )
      const response = await finalizeConfirm(
        openid,
        input,
        lease.leaseToken,
        promotion,
      )
      deleteFiles([input.fileId]).catch(() => {})
      return response
    } catch (error) {
      if (promotion &&
          (error.code === 'UPLOAD_ATTEMPT_CANCELED' ||
            error.code === 'UPLOAD_ATTEMPT_EXPIRED')) {
        deleteFiles([promotion.fileId]).catch(() => {})
      }
      throw error
    }
  }

  return {
    cancel,
    confirm,
    prepare,
  }
}

module.exports = {
  ATTEMPT_TTL_MS,
  CONFIRM_LEASE_MS,
  assertConfirmInput,
  assertPendingFile,
  createUploadAttemptHandlers,
  projectPhoto,
  projectCancelState,
  projectPreparedAttempt,
}
