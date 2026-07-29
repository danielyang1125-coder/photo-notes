'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  ATTEMPT_TTL_MS,
  createUploadAttemptHandlers,
} = require('../../cloudfunctions/upload/handlers')

function createUploadDb(seed = []) {
  const documents = new Map(seed.map((item) => [item._id, { ...item }]))
  let createCount = 0
  let transactionTail = Promise.resolve()

  function find(query) {
    return [...documents.values()].find((item) =>
      Object.entries(query).every(([key, value]) => item[key] === value),
    )
  }

  function collectionApi() {
    return {
      where(query) {
        return {
          limit(value) {
            assert.equal(value, 1)
            return {
              async get() {
                await Promise.resolve()
                const item = find(query)
                return { data: item ? [{ ...item }] : [] }
              },
            }
          },
        }
      },
      async add({ data }) {
        await Promise.resolve()
        if (documents.has(data._id) ||
            find({ _openid: data._openid, task_id: data.task_id })) {
          throw { code: 'DATABASE_DUPLICATE_KEY' }
        }
        documents.set(data._id, { ...data })
        createCount += 1
        return { _id: data._id }
      },
      doc(id) {
        return {
          async update({ data }) {
            const item = documents.get(id)
            if (!item) throw new Error('missing test document')
            documents.set(id, { ...item, ...data })
          },
        }
      },
    }
  }

  return {
    collection(name) {
      assert.equal(name, 'upload_attempts')
      return collectionApi()
    },
    async startTransaction() {
      let release
      const previous = transactionTail
      transactionTail = new Promise((resolve) => {
        release = resolve
      })
      await previous
      let closed = false
      function close() {
        if (!closed) {
          closed = true
          release()
        }
      }
      return {
        collection(name) {
          assert.equal(name, 'upload_attempts')
          return collectionApi()
        },
        async commit() {
          close()
        },
        async rollback() {
          close()
        },
      }
    },
    async transition(attemptId, status, photoId) {
      const transaction = await this.startTransaction()
      try {
        const item = documents.get(attemptId)
        if (!item || item.status !== 'PREPARED') return { ...item }
        const data = { status, updated_at: new Date('2026-07-29T01:00:00.000Z') }
        if (photoId) data.photo_id = photoId
        await transaction.collection('upload_attempts')
          .doc(attemptId)
          .update({ data })
        await transaction.commit()
        return { ...documents.get(attemptId) }
      } finally {
        await transaction.rollback()
      }
    },
    inspect() {
      return { createCount, documents }
    },
  }
}

function randomHexFactory() {
  let value = 0
  return () => (++value).toString(16).padStart(32, '0')
}

function createHandlers(db) {
  return createUploadAttemptHandlers({
    db,
    now: () => new Date('2026-07-29T00:00:00.000Z'),
    randomHex: randomHexFactory(),
  })
}

test('concurrent prepare signs one server-owned attempt and replays it', async () => {
  const db = createUploadDb()
  const handlers = createHandlers(db)
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      handlers.prepare('private-user-id', { taskId: 'batch_file03' }),
    ),
  )

  assert.equal(db.inspect().createCount, 1)
  assert.equal(db.inspect().documents.size, 1)
  assert.equal(new Set(results.map((item) => item.data.attemptId)).size, 1)
  assert.equal(new Set(results.map((item) => item.data.cloudPath)).size, 1)
  for (const result of results) {
    assert.match(result.data.attemptId, /^[a-f0-9]{32}$/)
    assert.match(
      result.data.cloudPath,
      /^uploads\/pending\/[a-f0-9]{32}\.bin$/,
    )
    assert.equal(
      Date.parse(result.data.expiresAt) -
        Date.parse('2026-07-29T00:00:00.000Z'),
      ATTEMPT_TTL_MS,
    )
  }

  const attempt = [...db.inspect().documents.values()][0]
  assert.equal(attempt._openid, 'private-user-id')
  assert.equal(attempt.status, 'PREPARED')
  assert.equal(attempt.pending_file_id, null)
  assert.equal(attempt.promoted_file_id, null)
  assert.equal(attempt.confirm_lease_token, null)
  assert.equal(JSON.stringify(results).includes('private-user-id'), false)
})

test('prepare replays CONFIRMED and never revives terminal attempts', async () => {
  const base = {
    _openid: 'private-user-id',
    task_id: 'task-1',
    pending_cloud_path: 'uploads/pending/00000000000000000000000000000001.bin',
    expires_at: new Date('2026-07-30T00:00:00.000Z'),
  }

  const confirmed = createHandlers(createUploadDb([{
    ...base,
    _id: 'attempt-confirmed',
    status: 'CONFIRMED',
    photo_id: 'photo-1',
  }]))
  assert.deepEqual(
    await confirmed.prepare('private-user-id', { taskId: 'task-1' }),
    {
      code: 'SUCCESS',
      data: {
        attemptId: 'attempt-confirmed',
        cloudPath: base.pending_cloud_path,
        expiresAt: '2026-07-30T00:00:00.000Z',
        photoId: 'photo-1',
      },
    },
  )

  for (const status of ['CANCELED', 'EXPIRED']) {
    const handlers = createHandlers(createUploadDb([{
      ...base,
      _id: `attempt-${status.toLowerCase()}`,
      status,
    }]))
    await assert.rejects(
      handlers.prepare('private-user-id', { taskId: 'task-1' }),
      (error) => error.code === `UPLOAD_ATTEMPT_${status}`,
    )
  }
})

test('cancel deduplicates input and commits each attempt independently', async () => {
  const db = createUploadDb([
    {
      _id: 'attempt-prepared',
      _openid: 'private-user-id',
      task_id: 'task-1',
      status: 'PREPARED',
    },
    {
      _id: 'attempt-confirmed',
      _openid: 'private-user-id',
      task_id: 'task-2',
      status: 'CONFIRMED',
      photo_id: 'photo-1',
    },
    {
      _id: 'attempt-expired',
      _openid: 'private-user-id',
      task_id: 'task-3',
      status: 'EXPIRED',
    },
    {
      _id: 'attempt-other-owner',
      _openid: 'other-user-id',
      task_id: 'task-4',
      status: 'PREPARED',
    },
  ])
  const result = await createHandlers(db).cancel('private-user-id', {
    attemptIds: [
      'attempt-prepared',
      'attempt-prepared',
      'attempt-confirmed',
      'attempt-expired',
      'attempt-other-owner',
      'attempt-random',
    ],
  })

  assert.deepEqual(result, {
    code: 'SUCCESS',
    data: {
      results: [
        { attemptId: 'attempt-prepared', status: 'CANCELED' },
        {
          attemptId: 'attempt-confirmed',
          status: 'CONFIRMED',
          photoId: 'photo-1',
        },
        {
          attemptId: 'attempt-expired',
          status: 'EXPIRED',
          code: 'UPLOAD_ATTEMPT_EXPIRED',
        },
        {
          attemptId: 'attempt-other-owner',
          status: 'NOT_FOUND',
          code: 'UPLOAD_ATTEMPT_NOT_FOUND',
        },
        {
          attemptId: 'attempt-random',
          status: 'NOT_FOUND',
          code: 'UPLOAD_ATTEMPT_NOT_FOUND',
        },
      ],
    },
  })
  assert.equal(
    db.inspect().documents.get('attempt-other-owner').status,
    'PREPARED',
  )
})

test('cancel and confirm-like commits linearize by transaction order', async () => {
  const attempt = {
    _id: 'attempt-1',
    _openid: 'private-user-id',
    task_id: 'task-1',
    status: 'PREPARED',
  }

  const cancelFirstDb = createUploadDb([attempt])
  const cancelFirst = createHandlers(cancelFirstDb)
  await cancelFirst.cancel('private-user-id', { attemptIds: ['attempt-1'] })
  await cancelFirstDb.transition('attempt-1', 'CONFIRMED', 'photo-1')
  assert.equal(
    cancelFirstDb.inspect().documents.get('attempt-1').status,
    'CANCELED',
  )

  const confirmFirstDb = createUploadDb([attempt])
  const confirmFirst = createHandlers(confirmFirstDb)
  await confirmFirstDb.transition('attempt-1', 'CONFIRMED', 'photo-1')
  assert.deepEqual(
    await confirmFirst.cancel('private-user-id', {
      attemptIds: ['attempt-1'],
    }),
    {
      code: 'SUCCESS',
      data: {
        results: [{
          attemptId: 'attempt-1',
          status: 'CONFIRMED',
          photoId: 'photo-1',
        }],
      },
    },
  )
})

test('prepare and cancel reject invalid bounded identifiers', async () => {
  const handlers = createHandlers(createUploadDb())
  await assert.rejects(
    handlers.prepare('private-user-id', { taskId: 'unsafe task id' }),
    (error) => error.code === 'VALIDATION_ERROR',
  )
  await assert.rejects(
    handlers.cancel('private-user-id', { attemptIds: [] }),
    (error) => error.code === 'VALIDATION_ERROR',
  )
  await assert.rejects(
    handlers.cancel('private-user-id', {
      attemptIds: Array.from({ length: 21 }, (_, index) => `attempt-${index}`),
    }),
    (error) => error.code === 'VALIDATION_ERROR',
  )
})
