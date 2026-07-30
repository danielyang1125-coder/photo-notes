'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  CONFIRM_LEASE_MS,
  assertConfirmInput,
  assertPendingFile,
  createUploadAttemptHandlers,
} = require('../../cloudfunctions/upload/handlers')
const {
  MAX_UPLOAD_BYTES,
  REVIEW_MAX_BYTES,
  createSharpImageProcessor,
  detectMagic,
} = require('../../cloudfunctions/upload/image-processing')
const { AppError } =
  require('../../cloudfunctions/upload/lib/shared/response')

function cloneStore(store) {
  const result = {}
  for (const [name, documents] of Object.entries(store)) {
    result[name] = new Map(
      [...documents.entries()].map(([id, value]) => [id, { ...value }]),
    )
  }
  return result
}

function createConfirmDb(seed) {
  let userUpdateConflicts = seed.userUpdateConflicts || 0
  let store = {
    upload_attempts: new Map(
      (seed.attempts || []).map((item) => [item._id, { ...item }]),
    ),
    users: new Map(
      (seed.users || []).map((item) => [item._id, { ...item }]),
    ),
    photos: new Map(
      (seed.photos || []).map((item) => [item._id, { ...item }]),
    ),
  }
  let transactionTail = Promise.resolve()

  function collectionApi(name, getStore) {
    function documents() {
      return getStore()[name]
    }
    function find(query) {
      return [...documents().values()].find((item) =>
        Object.entries(query).every(([key, value]) => item[key] === value),
      )
    }
    return {
      where(query) {
        return {
          limit(value) {
            assert.equal(value, 1)
            return {
              async get() {
                const item = find(query)
                return { data: item ? [{ ...item }] : [] }
              },
            }
          },
        }
      },
      doc(id) {
        return {
          async get() {
            const item = documents().get(id)
            return { data: item ? { ...item } : null }
          },
          async update({ data }) {
            const item = documents().get(id)
            if (!item) throw new Error('missing test document')
            if (name === 'users' && userUpdateConflicts > 0) {
              userUpdateConflicts -= 1
              throw { code: 'DATABASE_TRANSACTION_CONFLICT' }
            }
            documents().set(id, { ...item, ...data })
          },
        }
      },
      async add({ data }) {
        const duplicateTask = name === 'photos' &&
          find({ _openid: data._openid, task_id: data.task_id })
        const duplicateAttempt = name === 'photos' &&
          find({
            _openid: data._openid,
            upload_attempt_id: data.upload_attempt_id,
          })
        if (documents().has(data._id) || duplicateTask || duplicateAttempt) {
          throw { code: 'DATABASE_DUPLICATE_KEY' }
        }
        documents().set(data._id, { ...data })
        return { _id: data._id }
      },
    }
  }

  return {
    collection(name) {
      return collectionApi(name, () => store)
    },
    async startTransaction() {
      let release
      const previous = transactionTail
      transactionTail = new Promise((resolve) => {
        release = resolve
      })
      await previous
      let closed = false
      const transactionStore = cloneStore(store)
      function close() {
        if (!closed) {
          closed = true
          release()
        }
      }
      return {
        collection(name) {
          return collectionApi(name, () => transactionStore)
        },
        async commit() {
          store = transactionStore
          close()
        },
        async rollback() {
          close()
        },
      }
    },
    inspect() {
      return store
    },
  }
}

function randomHexFactory() {
  let value = 100
  return () => (++value).toString(16).padStart(32, '0')
}

function attempt(id, overrides = {}) {
  return {
    _id: id,
    _openid: 'private-user-id',
    task_id: `task-${id}`,
    status: 'PREPARED',
    pending_cloud_path: `uploads/pending/${id}.bin`,
    pending_file_id: null,
    promoted_file_id: null,
    verified_meta: null,
    confirm_lease_token: null,
    confirm_lease_expire_at: null,
    expires_at: new Date('2026-07-30T00:00:00.000Z'),
    ...overrides,
  }
}

function fileId(id, env = 'test-env') {
  return `cloud://${env}.bucket/uploads/pending/${id}.bin`
}

function createConfirmHandlers(db, overrides = {}) {
  const deleted = []
  const uploads = []
  const reviews = []
  const handlers = createUploadAttemptHandlers({
    db,
    now: () => new Date('2026-07-29T00:00:00.000Z'),
    randomHex: randomHexFactory(),
    environmentId: () => 'test-env',
    downloadFile: async () => ({ fileContent: Buffer.alloc(60, 1) }),
    processImage: async (buffer) => ({
      buffer,
      reviewBuffer: Buffer.from('review'),
      contentType: 'image/jpeg',
      extension: 'jpg',
      metadata: {
        file_size: buffer.length,
        width: 640,
        height: 480,
        format: 'JPEG',
        sha256: 'a'.repeat(64),
      },
    }),
    reviewImage: async (buffer, contentType) => {
      reviews.push({ buffer, contentType })
    },
    uploadFile: async (cloudPath) => {
      uploads.push(cloudPath)
      return { fileID: `cloud://test-env.bucket/${cloudPath}` }
    },
    deleteFiles: async (fileList) => {
      deleted.push(...fileList)
    },
    isContentReviewEnabled: () => true,
    ...overrides,
  })
  return { deleted, handlers, reviews, uploads }
}

test('confirm accepts only the new protocol and validates time and file binding', () => {
  const now = new Date('2026-07-29T00:00:00.000Z')
  assert.throws(
    () => assertConfirmInput({
      type: 'confirm',
      attemptId: 'attempt-1',
      fileId: fileId('attempt-1'),
      shootTime: now.toISOString(),
      timeSource: 'EXIF',
      size: 1,
    }, now),
    (error) => error.code === 'VALIDATION_ERROR',
  )
  assert.throws(
    () => assertConfirmInput({
      type: 'confirm',
      attemptId: 'attempt-1',
      fileId: fileId('attempt-1'),
      shootTime: '1899-12-31T23:59:59.000Z',
      timeSource: 'EXIF',
    }, now),
    (error) => error.code === 'VALIDATION_ERROR',
  )
  assert.doesNotThrow(() =>
    assertPendingFile(
      fileId('attempt-1'),
      'test-env',
      'uploads/pending/attempt-1.bin',
    ),
  )
  for (const invalid of [
    fileId('attempt-1', 'other-env'),
    fileId('other-path'),
    'https://example.invalid/image.jpg',
  ]) {
    assert.throws(
      () => assertPendingFile(
        invalid,
        'test-env',
        'uploads/pending/attempt-1.bin',
      ),
      (error) => error.code === 'UPLOAD_FILE_MISMATCH',
    )
  }
})

test('confirm verifies, reviews, promotes and atomically commits trusted metadata', async () => {
  const db = createConfirmDb({
    attempts: [attempt('attempt-1')],
    users: [{
      _id: 'private-user-id',
      status: 'ACTIVE',
      used_bytes: 10,
      limit_bytes: 100,
    }],
  })
  const fixture = createConfirmHandlers(db)
  const response = await fixture.handlers.confirm('private-user-id', {
    type: 'confirm',
    attemptId: 'attempt-1',
    fileId: fileId('attempt-1'),
    shootTime: '2026-07-28T10:00:00.000Z',
    timeSource: 'EXIF',
  })

  assert.equal(response.code, 'SUCCESS')
  assert.equal(response.data.duplicated, false)
  assert.equal(response.data.photo.file_size, 60)
  assert.equal(response.data.photo.width, 640)
  assert.equal(response.data.photo.format, 'JPEG')
  assert.equal(response.data.photo.file_id, undefined)
  assert.equal(fixture.reviews.length, 1)
  assert.match(fixture.uploads[0], /^photos\/active\/[a-f0-9]{32}\.jpg$/)

  const state = db.inspect()
  const stored = [...state.photos.values()][0]
  assert.equal(stored.status, 'ACTIVE')
  assert.equal(stored.file_size, 60)
  assert.equal(stored.sha256, 'a'.repeat(64))
  assert.equal(state.users.get('private-user-id').used_bytes, 70)
  assert.equal(state.upload_attempts.get('attempt-1').status, 'CONFIRMED')
  assert.equal(
    state.upload_attempts.get('attempt-1').promoted_file_id,
    stored.file_id,
  )
  assert.deepEqual(fixture.deleted, [fileId('attempt-1')])
})

test('an active lease rejects concurrent confirm and confirmed replay is idempotent', async () => {
  const db = createConfirmDb({
    attempts: [attempt('attempt-1', {
      confirm_lease_token: 'existing-token',
      confirm_lease_expire_at: new Date(
        Date.parse('2026-07-29T00:00:00.000Z') + CONFIRM_LEASE_MS,
      ),
    })],
    users: [{
      _id: 'private-user-id',
      status: 'ACTIVE',
      used_bytes: 0,
      limit_bytes: 100,
    }],
  })
  const fixture = createConfirmHandlers(db)
  const input = {
    type: 'confirm',
    attemptId: 'attempt-1',
    fileId: fileId('attempt-1'),
    timeSource: 'UPLOAD_TIME',
  }
  await assert.rejects(
    fixture.handlers.confirm('private-user-id', input),
    (error) => error.code === 'UPLOAD_CONFIRM_IN_PROGRESS',
  )

  const storedAttempt = db.inspect().upload_attempts.get('attempt-1')
  storedAttempt.confirm_lease_expire_at =
    new Date('2026-07-28T23:59:59.000Z')
  const first = await fixture.handlers.confirm('private-user-id', input)
  const replays = await Promise.all(
    Array.from({ length: 10 }, () =>
      fixture.handlers.confirm('private-user-id', input),
    ),
  )
  assert.equal(first.data.duplicated, false)
  assert.equal(
    new Set(replays.map((item) => item.data.photo._id)).size,
    1,
  )
  assert.equal(replays.every((item) => item.data.duplicated), true)
  assert.equal(db.inspect().photos.size, 1)
  assert.equal(db.inspect().users.get('private-user-id').used_bytes, 60)
})

test('quota competition commits only capacity-safe confirms', async () => {
  const ids = ['attempt-1', 'attempt-2', 'attempt-3']
  const db = createConfirmDb({
    attempts: ids.map((id) => attempt(id)),
    users: [{
      _id: 'private-user-id',
      status: 'ACTIVE',
      used_bytes: 0,
      limit_bytes: 100,
    }],
  })
  const fixture = createConfirmHandlers(db)
  const settled = await Promise.allSettled(ids.map((id) =>
    fixture.handlers.confirm('private-user-id', {
      type: 'confirm',
      attemptId: id,
      fileId: fileId(id),
      timeSource: 'UPLOAD_TIME',
    }),
  ))

  assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(
    settled
      .filter((item) => item.status === 'rejected')
      .every((item) => item.reason.code === 'SPACE_EXCEEDED'),
    true,
  )
  assert.equal(db.inspect().photos.size, 1)
  assert.equal(db.inspect().users.get('private-user-id').used_bytes, 60)
  assert.equal(
    [...db.inspect().upload_attempts.values()]
      .filter((item) => item.status === 'CONFIRMED').length,
    1,
  )
})

test('content review failure is fail-closed before active promotion', async () => {
  const db = createConfirmDb({
    attempts: [attempt('attempt-1')],
    users: [{
      _id: 'private-user-id',
      status: 'ACTIVE',
      used_bytes: 0,
      limit_bytes: 100,
    }],
  })
  const fixture = createConfirmHandlers(db, {
    reviewImage: async () => {
      throw new AppError('CONTENT_REVIEW_UNAVAILABLE')
    },
  })
  await assert.rejects(
    fixture.handlers.confirm('private-user-id', {
      type: 'confirm',
      attemptId: 'attempt-1',
      fileId: fileId('attempt-1'),
      timeSource: 'UPLOAD_TIME',
    }),
    (error) => error.code === 'CONTENT_REVIEW_UNAVAILABLE',
  )
  assert.equal(fixture.uploads.length, 0)
  assert.equal(db.inspect().photos.size, 0)
  assert.equal(db.inspect().users.get('private-user-id').used_bytes, 0)
})

test('failed final transaction retains promotion and retry does not upload twice', async () => {
  const db = createConfirmDb({
    attempts: [attempt('attempt-1')],
    users: [{
      _id: 'private-user-id',
      status: 'ACTIVE',
      used_bytes: 0,
      limit_bytes: 100,
    }],
    userUpdateConflicts: 3,
  })
  const fixture = createConfirmHandlers(db)
  const input = {
    type: 'confirm',
    attemptId: 'attempt-1',
    fileId: fileId('attempt-1'),
    timeSource: 'UPLOAD_TIME',
  }
  await assert.rejects(
    fixture.handlers.confirm('private-user-id', input),
    (error) => error.code === 'DATABASE_TRANSACTION_CONFLICT',
  )
  const retained = db.inspect().upload_attempts.get('attempt-1')
  assert.equal(retained.status, 'PREPARED')
  assert.match(retained.promoted_file_id, /photos\/active\//)
  assert.equal(db.inspect().photos.size, 0)
  assert.equal(db.inspect().users.get('private-user-id').used_bytes, 0)

  retained.confirm_lease_expire_at = new Date('2026-07-28T23:59:59.000Z')
  const retry = await fixture.handlers.confirm('private-user-id', input)
  assert.equal(retry.code, 'SUCCESS')
  assert.equal(fixture.uploads.length, 1)
  assert.equal(fixture.reviews.length, 1)
  assert.equal(db.inspect().photos.size, 1)
  assert.equal(db.inspect().users.get('private-user-id').used_bytes, 60)
})

test('cancel committed during verification wins and promoted object is removed', async () => {
  const db = createConfirmDb({
    attempts: [attempt('attempt-1')],
    users: [{
      _id: 'private-user-id',
      status: 'ACTIVE',
      used_bytes: 0,
      limit_bytes: 100,
    }],
  })
  let releaseReview
  let markReviewStarted
  const reviewStarted = new Promise((resolve) => {
    markReviewStarted = resolve
  })
  const reviewPending = new Promise((resolve) => {
    releaseReview = resolve
  })
  const fixture = createConfirmHandlers(db, {
    reviewImage: async () => {
      markReviewStarted()
      await reviewPending
    },
  })
  const confirming = fixture.handlers.confirm('private-user-id', {
    type: 'confirm',
    attemptId: 'attempt-1',
    fileId: fileId('attempt-1'),
    timeSource: 'UPLOAD_TIME',
  })
  await reviewStarted
  const canceled = await fixture.handlers.cancel('private-user-id', {
    attemptIds: ['attempt-1'],
  })
  releaseReview()

  assert.equal(canceled.data.results[0].status, 'CANCELED')
  await assert.rejects(
    confirming,
    (error) => error.code === 'UPLOAD_ATTEMPT_CANCELED',
  )
  assert.equal(db.inspect().photos.size, 0)
  assert.equal(db.inspect().users.get('private-user-id').used_bytes, 0)
  assert.equal(fixture.deleted.length, 1)
  assert.match(fixture.deleted[0], /photos\/active\//)
})

test('sharp processor decodes static JPEG/PNG and rejects invalid images', async () => {
  const sharp = require('../../cloudfunctions/upload/node_modules/sharp')
  const processor = createSharpImageProcessor({ sharpFactory: sharp })
  const jpeg = await sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 3,
      background: '#336699',
    },
  }).jpeg().toBuffer()
  const png = await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 4,
      background: '#112233ff',
    },
  }).png().toBuffer()

  const jpegResult = await processor(jpeg)
  const pngResult = await processor(png)
  assert.equal(jpegResult.metadata.format, 'JPEG')
  assert.equal(jpegResult.metadata.width, 1200)
  assert.equal(pngResult.metadata.format, 'PNG')
  assert.equal(pngResult.metadata.height, 24)
  assert.ok(jpegResult.reviewBuffer.length <= REVIEW_MAX_BYTES)
  assert.ok(pngResult.reviewBuffer.length <= REVIEW_MAX_BYTES)
  assert.equal(detectMagic(jpeg), 'JPEG')
  assert.equal(detectMagic(png), 'PNG')

  await assert.rejects(
    processor(Buffer.from('GIF89a')),
    (error) => error.code === 'UPLOAD_FILE_INVALID',
  )
  await assert.rejects(
    processor(Buffer.concat([jpeg.subarray(0, 20), Buffer.from('broken')])),
    (error) => error.code === 'UPLOAD_FILE_INVALID',
  )
  await assert.rejects(
    processor(Buffer.alloc(MAX_UPLOAD_BYTES + 1)),
    (error) => error.code === 'UPLOAD_FILE_INVALID',
  )
})
