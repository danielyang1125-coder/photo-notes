'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createDeleteHandlers } =
  require('../../cloudfunctions/photo/delete-handlers')
const {
  createPhotoDeleteWorker,
  LEASE_TTL_MS,
  MAX_RETRIES,
} = require('../../cloudfunctions/cleanup/photo-delete-worker')

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

function isCommand(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    !(value instanceof Date)
}

// Evaluate a single condition against a scalar value (preserves field context)
function evaluateCondition(value, cond) {
  if (!isCommand(cond)) {
    if (cond === null) return value === null
    if (cond instanceof Date) {
      return value instanceof Date && value.getTime() === cond.getTime()
    }
    return value === cond
  }
  if ('_and' in cond) {
    return (Array.isArray(cond._and) ? cond._and : [cond._and])
      .every((sub) => evaluateCondition(value, sub))
  }
  if ('_or' in cond) {
    return (Array.isArray(cond._or) ? cond._or : [cond._or])
      .some((sub) => evaluateCondition(value, sub))
  }
  if ('_in' in cond) return Array.isArray(cond._in) && cond._in.includes(value)
  if ('_lt' in cond) return value < cond._lt
  if ('_gt' in cond) return value > cond._gt
  if ('_lte' in cond) return value <= cond._lte
  if ('_gte' in cond) return value >= cond._gte
  if ('_eq' in cond) return value === cond._eq
  if ('_neq' in cond) return value !== cond._neq
  return value === cond
}

function matchItem(item, query) {
  if (!query || typeof query !== 'object') return true
  // Top-level logical operators
  if (query._and) {
    return (Array.isArray(query._and) ? query._and : [query._and])
      .every((sub) => matchItem(item, sub))
  }
  if (query._or) {
    return (Array.isArray(query._or) ? query._or : [query._or])
      .some((sub) => matchItem(item, sub))
  }
  // Field-level conditions — evaluate each field condition against item[key]
  return Object.entries(query).every(([key, cond]) => {
    const itemValue = item[key]
    return evaluateCondition(itemValue, cond)
  })
}

function compareValues(a, b) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function cloneStore(store) {
  const result = {}
  for (const [name, documents] of Object.entries(store)) {
    result[name] = new Map(
      [...documents.entries()].map(([id, value]) => [id, { ...value }]),
    )
  }
  return result
}

/**
 * Creates an in-memory mock DB supporting:
 * - collection.where / .doc / .add / .orderBy / .limit
 * - db.startTransaction with commit/rollback
 * - db.serverDate
 * - Unique index on deletion_tasks {_openid, task_key}
 * - Unique index on photos {_openid, task_id}
 */
function createMockDb(seed = {}) {
  let store = {
    photos: new Map((seed.photos || []).map((p) => [p._id, { ...p }])),
    notes: new Map((seed.notes || []).map((n) => [n._id, { ...n }])),
    photo_tags: new Map((seed.photo_tags || []).map((r) => [r._id, { ...r }])),
    tags: new Map((seed.tags || []).map((t) => [t._id, { ...t }])),
    users: new Map((seed.users || []).map((u) => [u._id, { ...u }])),
    deletion_tasks: new Map(
      (seed.deletion_tasks || []).map((d) => [d._id, { ...d }]),
    ),
  }

  let nextId = 100

  const _command = {
    and: (...args) => {
      const arr = args.length === 1 && Array.isArray(args[0]) ? args[0] : args
      return { _and: arr }
    },
    or: (...args) => {
      const arr = args.length === 1 && Array.isArray(args[0]) ? args[0] : args
      return { _or: arr }
    },
    lt: (v) => ({ _lt: v }),
    gt: (v) => ({ _gt: v }),
    lte: (v) => ({ _lte: v }),
    gte: (v) => ({ _gte: v }),
    eq: (v) => ({ _eq: v }),
    neq: (v) => ({ _neq: v }),
    in: (arr) => ({ _in: arr }),
    inc: (v) => ({ _inc: v }),
  }

  function serverDate() {
    return new Date()
  }

  function collectionApi(name, getStore) {
    function docs() {
      return getStore()[name]
    }

    function filtered(query) {
      let items = [...docs().values()]
      if (query) items = items.filter((item) => matchItem(item, query))
      return items
    }

    return {
      where(query) {
        let _query = query
        let _orders = []
        return {
          orderBy(field, dir) {
            _orders.push([field, dir])
            return this
          },
          limit(n) {
            return {
              async get() {
                let items = filtered(_query)
                if (_orders.length > 0) {
                  items.sort((a, b) => {
                    for (const [f, d] of _orders) {
                      const cmp = compareValues(a[f], b[f])
                      if (cmp !== 0) return d === 'desc' ? -cmp : cmp
                    }
                    return 0
                  })
                }
                return { data: items.slice(0, n).map((i) => ({ ...i })) }
              },
            }
          },
          async get() {
            return { data: filtered(_query).map((i) => ({ ...i })) }
          },
          async update({ data }) {
            const items = filtered(_query)
            let updated = 0
            for (const item of items) {
              const resolved = {}
              for (const [k, v] of Object.entries(data)) {
                if (isCommand(v) && '_inc' in v) {
                  resolved[k] = (item[k] || 0) + v._inc
                } else {
                  resolved[k] = v
                }
              }
              docs().set(item._id, { ...item, ...resolved })
              updated++
            }
            return { stats: { updated } }
          },
        }
      },
      doc(id) {
        return {
          async get() {
            const item = docs().get(id)
            if (!item) throw { errCode: 'DATABASE_DOCUMENT_NOT_FOUND' }
            return { data: { ...item } }
          },
          async update({ data }) {
            const item = docs().get(id)
            if (!item) throw { errCode: 'DATABASE_DOCUMENT_NOT_FOUND' }
            const resolved = {}
            for (const [k, v] of Object.entries(data)) {
              if (isCommand(v) && '_inc' in v) {
                resolved[k] = (item[k] || 0) + v._inc
              } else {
                resolved[k] = v
              }
            }
            docs().set(id, { ...item, ...resolved })
          },
          async remove() {
            docs().delete(id)
          },
        }
      },
      async add({ data }) {
        // Unique index checks
        if (name === 'deletion_tasks' && data._openid && data.task_key) {
          for (const [, existing] of docs()) {
            if (existing._openid === data._openid &&
                existing.task_key === data.task_key) {
              throw { errCode: -502003, code: 'DATABASE_DUPLICATE_KEY' }
            }
          }
        }
        // Photos unique indexes
        if (name === 'photos' && data._openid) {
          for (const [, existing] of docs()) {
            if (data.task_id && existing._openid === data._openid &&
                existing.task_id === data.task_id) {
              throw { errCode: -502003, code: 'DATABASE_DUPLICATE_KEY' }
            }
            if (data.upload_attempt_id &&
                existing._openid === data._openid &&
                existing.upload_attempt_id === data.upload_attempt_id) {
              throw { errCode: -502003, code: 'DATABASE_DUPLICATE_KEY' }
            }
          }
        }

        const id = data._id || `auto-${nextId++}`
        const doc = { _id: id, ...data }
        docs().set(id, doc)
        return { _id: id }
      },
      async count() {
        return { total: docs().size }
      },
    }
  }

  let transactionTail = Promise.resolve()

  return {
    collection(name) {
      return {
        ...collectionApi(name, () => store),
        _store: () => store,
      }
    },
    command: _command,
    serverDate,
    inspect() {
      return store
    },
    async startTransaction() {
      let release
      const previous = transactionTail
      transactionTail = new Promise((resolve) => { release = resolve })
      await previous
      let closed = false
      const txnStore = cloneStore(store)
      function done() {
        if (!closed) { closed = true; release() }
      }
      return {
        collection(name) {
          return {
            ...collectionApi(name, () => txnStore),
            _store: () => txnStore,
          }
        },
        async commit() { store = txnStore; done() },
        async rollback() { done() },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const USR = {
  _id: 'u1',
  _openid: 'u1',
  status: 'ACTIVE',
  used_bytes: 5000000,
  limit_bytes: 524288000,
}

const ACTIVE_PHOTO = {
  _id: 'p1',
  _openid: 'u1',
  status: 'ACTIVE',
  file_id: 'cloud://env/photos/active/a1.bin',
  file_size: 1500000,
  width: 1920,
  height: 1080,
  format: 'JPEG',
  shoot_time: '2024-06-15T12:00:00.000Z',
  time_source: 'EXIF',
  upload_time: '2024-06-15T12:05:00.000Z',
  tag_count: 2,
  upload_attempt_id: 'att1',
  task_id: 'task1',
  updated_at: '2024-06-15T12:05:00.000Z',
}

function createHandlers(db) {
  return createDeleteHandlers({ db })
}

// ---------------------------------------------------------------------------
// Group 1: handleDelete
// ---------------------------------------------------------------------------

test('handleDelete: marks ACTIVE photo as DELETING and creates task', async () => {
  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO }],
    users: [{ ...USR }],
  })
  const { handleDelete } = createHandlers(db)
  const result = await handleDelete('u1', { photoId: 'p1' })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.photoId, 'p1')
  assert.ok(result.data.taskId)
  assert.equal(result.data.status, 'PENDING')
  assert.equal(result.data.completedAt, null)

  // Photo now DELETING
  const store = db.inspect()
  const photo = store.photos.get('p1')
  assert.equal(photo.status, 'DELETING')
  assert.ok(photo.deleting_at instanceof Date)

  // Task exists with correct fields
  const tasks = [...store.deletion_tasks.values()]
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].type, 'PHOTO_DELETE')
  assert.equal(tasks[0].task_key, 'PHOTO_DELETE:p1')
  assert.equal(tasks[0].status, 'PENDING')
  assert.equal(tasks[0].current_stage, 'STORAGE_DELETE')
  assert.equal(tasks[0].file_id, ACTIVE_PHOTO.file_id)
  assert.equal(tasks[0].file_size, ACTIVE_PHOTO.file_size)
})

test('handleDelete: idempotent — second call returns same task', async () => {
  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO }],
    users: [{ ...USR }],
  })
  const { handleDelete } = createHandlers(db)

  const r1 = await handleDelete('u1', { photoId: 'p1' })
  // Photo is now DELETING; create another DB with the updated state
  const store = db.inspect()
  const db2 = createMockDb({
    photos: [[...store.photos.entries()][0][1]],
    users: [[...store.users.entries()][0][1]],
    deletion_tasks: [...store.deletion_tasks.entries()].map(([, v]) => v),
  })
  const { handleDelete: hd2 } = createHandlers(db2)

  const r2 = await hd2('u1', { photoId: 'p1' })
  assert.equal(r2.code, 'SUCCESS')
  assert.equal(r2.data.taskId, r1.data.taskId)
  assert.equal(r2.data.photoId, 'p1')

  // No duplicate task created
  const tasks2 = [...db2.inspect().deletion_tasks.values()]
  assert.equal(tasks2.length, 1)
})

test('handleDelete: photo not found without historical task → PHOTO_NOT_FOUND', async () => {
  const db = createMockDb({ users: [{ ...USR }] })
  const { handleDelete } = createHandlers(db)

  try {
    await handleDelete('u1', { photoId: 'nonexistent' })
    assert.fail('expected error')
  } catch (err) {
    assert.equal(err.code, 'PHOTO_NOT_FOUND')
  }
})

test('handleDelete: photo not found with historical task → returns task', async () => {
  const db = createMockDb({
    users: [{ ...USR }],
    deletion_tasks: [
      {
        _id: 'dt1',
        _openid: 'u1',
        type: 'PHOTO_DELETE',
        task_key: 'PHOTO_DELETE:p99',
        photo_id: 'p99',
        file_id: 'cloud://old',
        file_size: 100,
        status: 'COMPLETED',
        current_stage: 'PHOTO_FINALIZE',
        stage_cursor: { notes_done: true, photo_tags_done: true },
        retry_count: 0,
        next_retry_at: null,
        lease_token: null,
        lease_expire_at: null,
        last_error: null,
        last_error_at: null,
        applied_at: new Date('2024-01-01'),
        completed_at: new Date('2024-01-02'),
      },
    ],
  })
  const { handleDelete } = createHandlers(db)

  const result = await handleDelete('u1', { photoId: 'p99' })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.taskId, 'dt1')
  assert.equal(result.data.status, 'COMPLETED')
  assert.ok(result.data.completedAt instanceof Date)
})

test('handleDelete: cross-user returns PHOTO_NOT_FOUND', async () => {
  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO, _openid: 'u2' }],
    users: [{ ...USR }, { _id: 'u2', _openid: 'u2', status: 'ACTIVE', used_bytes: 0, limit_bytes: 524288000 }],
  })
  const { handleDelete } = createHandlers(db)

  // Photo belongs to u2, but we query as u1
  const dbAdjusted = createMockDb({
    photos: [{ ...ACTIVE_PHOTO, _openid: 'u2' }],
    users: [{ ...USR }, { _id: 'u2', _openid: 'u2', status: 'ACTIVE', used_bytes: 0, limit_bytes: 524288000 }],
  })
  const { handleDelete: hd } = createHandlers(dbAdjusted)

  try {
    await hd('u1', { photoId: 'p1' })
    assert.fail('expected error')
  } catch (err) {
    assert.equal(err.code, 'PHOTO_NOT_FOUND')
  }
})

test('handleDelete: response projection excludes internal fields', async () => {
  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO }],
    users: [{ ...USR }],
  })
  const { handleDelete } = createHandlers(db)
  const result = await handleDelete('u1', { photoId: 'p1' })

  assert.equal(result.data.file_id, undefined)
  assert.equal(result.data.file_size, undefined)
  assert.equal(result.data.current_stage, undefined)
  assert.equal(result.data.stage_cursor, undefined)
  assert.equal(result.data.retry_count, undefined)
  assert.equal(result.data.next_retry_at, undefined)
  assert.equal(result.data.lease_token, undefined)
  assert.equal(result.data.lease_expire_at, undefined)
  assert.equal(result.data.last_error, undefined)
  assert.equal(result.data._openid, undefined)
})

test('handleDelete: validation error — missing photoId', async () => {
  const db = createMockDb({ users: [{ ...USR }] })
  const { handleDelete } = createHandlers(db)

  try {
    await handleDelete('u1', {})
    assert.fail('expected error')
  } catch (err) {
    assert.equal(err.code, 'VALIDATION_ERROR')
  }
})

// ---------------------------------------------------------------------------
// Group 2: handleGetDeleteStatus
// ---------------------------------------------------------------------------

function makeTask(overrides = {}) {
  return {
    _id: 'dt-status-1',
    _openid: 'u1',
    type: 'PHOTO_DELETE',
    task_key: 'PHOTO_DELETE:p1',
    photo_id: 'p1',
    file_id: 'cloud://test',
    file_size: 100,
    status: 'PENDING',
    current_stage: 'STORAGE_DELETE',
    stage_cursor: { notes_done: false, photo_tags_done: false },
    retry_count: 0,
    next_retry_at: null,
    lease_token: null,
    lease_expire_at: null,
    last_error: null,
    last_error_at: null,
    applied_at: new Date('2024-06-15T12:00:00Z'),
    completed_at: null,
    ...overrides,
  }
}

test('handleGetDeleteStatus: by taskId', async () => {
  const db = createMockDb({
    users: [{ ...USR }],
    deletion_tasks: [makeTask()],
  })
  const { handleGetDeleteStatus } = createHandlers(db)
  const result = await handleGetDeleteStatus('u1', { taskId: 'dt-status-1' })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.taskId, 'dt-status-1')
  assert.equal(result.data.photoId, 'p1')
  assert.equal(result.data.status, 'PENDING')
  assert.equal(result.data.completedAt, null)
  assert.ok(result.data.updatedAt instanceof Date)
})

test('handleGetDeleteStatus: by photoId', async () => {
  const db = createMockDb({
    users: [{ ...USR }],
    deletion_tasks: [makeTask()],
  })
  const { handleGetDeleteStatus } = createHandlers(db)
  const result = await handleGetDeleteStatus('u1', { photoId: 'p1' })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.photoId, 'p1')
})

test('handleGetDeleteStatus: COMPLETED task returns completedAt', async () => {
  const db = createMockDb({
    users: [{ ...USR }],
    deletion_tasks: [
      makeTask({
        status: 'COMPLETED',
        completed_at: new Date('2024-06-16T00:00:00Z'),
      }),
    ],
  })
  const { handleGetDeleteStatus } = createHandlers(db)
  const result = await handleGetDeleteStatus('u1', { taskId: 'dt-status-1' })

  assert.equal(result.data.status, 'COMPLETED')
  assert.ok(result.data.completedAt instanceof Date)
})

test('handleGetDeleteStatus: not found → DELETE_TASK_NOT_FOUND', async () => {
  const db = createMockDb({ users: [{ ...USR }] })
  const { handleGetDeleteStatus } = createHandlers(db)

  try {
    await handleGetDeleteStatus('u1', { taskId: 'nonexistent' })
    assert.fail('expected error')
  } catch (err) {
    assert.equal(err.code, 'DELETE_TASK_NOT_FOUND')
  }
})

test('handleGetDeleteStatus: cross-user task → DELETE_TASK_NOT_FOUND', async () => {
  const db = createMockDb({
    users: [{ ...USR }, { _id: 'u2', _openid: 'u2', status: 'ACTIVE', used_bytes: 0, limit_bytes: 524288000 }],
    deletion_tasks: [
      makeTask({ _id: 'dt-other', _openid: 'u2', task_key: 'PHOTO_DELETE:p2' }),
    ],
  })
  const { handleGetDeleteStatus } = createHandlers(db)

  try {
    await handleGetDeleteStatus('u1', { taskId: 'dt-other' })
    assert.fail('expected error')
  } catch (err) {
    assert.equal(err.code, 'DELETE_TASK_NOT_FOUND')
  }
})

test('handleGetDeleteStatus: security projection excludes internal fields', async () => {
  const db = createMockDb({
    users: [{ ...USR }],
    deletion_tasks: [makeTask()],
  })
  const { handleGetDeleteStatus } = createHandlers(db)
  const result = await handleGetDeleteStatus('u1', { taskId: 'dt-status-1' })

  assert.equal(result.data.file_id, undefined)
  assert.equal(result.data.file_size, undefined)
  assert.equal(result.data.current_stage, undefined)
  assert.equal(result.data.stage_cursor, undefined)
  assert.equal(result.data.retry_count, undefined)
  assert.equal(result.data.next_retry_at, undefined)
  assert.equal(result.data.lease_token, undefined)
  assert.equal(result.data.lease_expire_at, undefined)
  assert.equal(result.data.last_error, undefined)
})

test('handleGetDeleteStatus: missing both taskId and photoId → VALIDATION_ERROR', async () => {
  const db = createMockDb({ users: [{ ...USR }] })
  const { handleGetDeleteStatus } = createHandlers(db)

  try {
    await handleGetDeleteStatus('u1', {})
    assert.fail('expected error')
  } catch (err) {
    assert.equal(err.code, 'VALIDATION_ERROR')
  }
})

// ---------------------------------------------------------------------------
// Group 3: Worker (photo-delete-worker)
// ---------------------------------------------------------------------------

function trackedDeletes(files = []) {
  const deleted = []
  return {
    deleted,
    deleteFiles: async (fileList) => {
      for (const fid of fileList) {
        const found = files.includes(fid)
        if (!fid || !found) {
          // Simulate "file not found" error
          const err = new Error('STORAGE_FILE_NON_EXIST')
          err.errCode = 'STORAGE_FILE_NON_EXIST'
          throw err
        }
        deleted.push(fid)
      }
    },
  }
}

test('worker: full lifecycle PENDING → COMPLETED', async () => {
  const { deleted, deleteFiles } = trackedDeletes(['cloud://env/photos/active/a1.bin'])
  const fixedNow = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO, status: 'DELETING', deleting_at: fixedNow }],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [{ ...USR }],
    deletion_tasks: [
      {
        _id: 'dt-full',
        _openid: 'u1',
        type: 'PHOTO_DELETE',
        task_key: 'PHOTO_DELETE:p1',
        photo_id: 'p1',
        file_id: 'cloud://env/photos/active/a1.bin',
        file_size: 1500000,
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
        applied_at: fixedNow,
        completed_at: null,
      },
    ],
  })

  const worker = createPhotoDeleteWorker({
    db,
    deleteFiles,
    now: () => fixedNow,
    batchSize: 10,
  })

  const summary = await worker.run()
  assert.equal(summary.acquired, 1)
  assert.equal(summary.succeeded, 1)
  assert.equal(summary.failed, 0)

  // Storage file was deleted
  assert.ok(deleted.includes('cloud://env/photos/active/a1.bin'))

  // Task is COMPLETED
  const store = db.inspect()
  const task = store.deletion_tasks.get('dt-full')
  assert.equal(task.status, 'COMPLETED')
  assert.ok(task.completed_at instanceof Date)

  // Photo removed
  assert.equal(store.photos.has('p1'), false)

  // Space deducted
  const user = store.users.get('u1')
  assert.equal(user.used_bytes, USR.used_bytes - 1500000)
})

test('worker: STORAGE_DELETE idempotent — file not found is success', async () => {
  // File doesn't exist in the tracked list = file not found
  const { deleteFiles } = trackedDeletes([])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO }],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [{ ...USR }],
    deletion_tasks: [
      {
        _id: 'dt-no-file',
        _openid: 'u1',
        type: 'PHOTO_DELETE',
        task_key: 'PHOTO_DELETE:p1',
        photo_id: 'p1',
        file_id: 'cloud://env/photos/active/missing.bin',
        file_size: 100,
        status: 'PENDING',
        current_stage: 'STORAGE_DELETE',
        stage_cursor: { notes_cursor: null, photo_tags_cursor: null, notes_done: false, photo_tags_done: false },
        retry_count: 0,
        next_retry_at: null,
        lease_token: null,
        lease_expire_at: null,
        last_error: null,
        last_error_at: null,
        applied_at: now,
        completed_at: null,
      },
    ],
  })

  const worker = createPhotoDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  const summary = await worker.run()
  // Should succeed — file-not-found is treated as success
  assert.equal(summary.succeeded, 1)
})

test('worker: RELATED_DATA_CLEANUP batches notes', async () => {
  const { deleteFiles } = trackedDeletes([])
  const now = new Date('2024-06-16T00:00:00Z')

  const notes = []
  for (let i = 0; i < 25; i++) {
    notes.push({
      _id: `note-${i}`,
      _openid: 'u1',
      photo_id: 'p1',
      content: `Note ${i}`,
      created_at: now,
      updated_at: now,
    })
  }

  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO, file_id: '' }],
    notes,
    photo_tags: [],
    tags: [],
    users: [{ ...USR }],
    deletion_tasks: [
      {
        _id: 'dt-notes',
        _openid: 'u1',
        type: 'PHOTO_DELETE',
        task_key: 'PHOTO_DELETE:p1',
        photo_id: 'p1',
        file_id: '',
        file_size: 100,
        status: 'PENDING',
        current_stage: 'RELATED_DATA_CLEANUP', // Skip storage delete
        stage_cursor: { notes_cursor: null, photo_tags_cursor: null, notes_done: false, photo_tags_done: true },
        retry_count: 0,
        next_retry_at: null,
        lease_token: null,
        lease_expire_at: null,
        last_error: null,
        last_error_at: null,
        applied_at: now,
        completed_at: null,
      },
    ],
  })

  const worker = createPhotoDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10, // 25 notes → 3 batches
  })

  // First run: processes first batch
  let summary = await worker.run()
  const store1 = db.inspect()
  const task1 = store1.deletion_tasks.get('dt-notes')
  // 10 notes deleted in first batch
  const remainingNotes1 = [...store1.notes.values()].filter(
    (n) => n.photo_id === 'p1',
  )
  assert.equal(remainingNotes1.length, 15)
  assert.equal(task1.stage_cursor.notes_done, false)

  // Second run: should pick up from cursor
  summary = await worker.run()
  const remainingNotes2 = [...db.inspect().notes.values()].filter(
    (n) => n.photo_id === 'p1',
  )
  assert.equal(remainingNotes2.length, 5)

  // Third run
  summary = await worker.run()
  const remainingNotes3 = [...db.inspect().notes.values()].filter(
    (n) => n.photo_id === 'p1',
  )
  assert.equal(remainingNotes3.length, 0)

  // Fourth run: should finish stage and advance to PHOTO_FINALIZE
  summary = await worker.run()
  const taskFinal = db.inspect().deletion_tasks.get('dt-notes')
  assert.equal(taskFinal.status, 'COMPLETED')
})

test('worker: RELATED_DATA_CLEANUP processes photo_tags with tag count decrement', async () => {
  const { deleteFiles } = trackedDeletes([])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO, file_id: '' }],
    notes: [],
    photo_tags: [
      { _id: 'r1', _openid: 'u1', photo_id: 'p1', tag_id: 't1', photo_upload_time: now },
      { _id: 'r2', _openid: 'u1', photo_id: 'p1', tag_id: 't2', photo_upload_time: now },
      { _id: 'r3', _openid: 'u1', photo_id: 'p1', tag_id: 't3', photo_upload_time: now },
    ],
    tags: [
      { _id: 't1', _openid: 'u1', name: 'tag1', photo_count: 5, normalized_name: 'tag1' },
      { _id: 't2', _openid: 'u1', name: 'tag2', photo_count: 3, normalized_name: 'tag2' },
      { _id: 't3', _openid: 'u1', name: 'tag3', photo_count: 1, normalized_name: 'tag3' },
    ],
    users: [{ ...USR }],
    deletion_tasks: [
      {
        _id: 'dt-tags',
        _openid: 'u1',
        type: 'PHOTO_DELETE',
        task_key: 'PHOTO_DELETE:p1',
        photo_id: 'p1',
        file_id: '',
        file_size: 100,
        status: 'PENDING',
        current_stage: 'RELATED_DATA_CLEANUP',
        stage_cursor: { notes_cursor: null, photo_tags_cursor: null, notes_done: true, photo_tags_done: false },
        retry_count: 0,
        next_retry_at: null,
        lease_token: null,
        lease_expire_at: null,
        last_error: null,
        last_error_at: null,
        applied_at: now,
        completed_at: null,
      },
    ],
  })

  const worker = createPhotoDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  // Run to complete (one batch since batchSize=10 > 3 relations)
  await worker.run()
  // If not done yet, run again
  let task = db.inspect().deletion_tasks.get('dt-tags')
  if (task.current_stage === 'RELATED_DATA_CLEANUP') {
    await worker.run()
  }
  // Final run for PHOTO_FINALIZE
  task = db.inspect().deletion_tasks.get('dt-tags')
  if (task.current_stage === 'PHOTO_FINALIZE') {
    await worker.run()
  }

  const store = db.inspect()
  // All relations deleted
  assert.equal(
    [...store.photo_tags.values()].filter((r) => r.photo_id === 'p1').length,
    0,
  )
  // Tag counts decremented
  assert.equal(store.tags.get('t1').photo_count, 4)
  assert.equal(store.tags.get('t2').photo_count, 2)
  assert.equal(store.tags.get('t3').photo_count, 0)
})

test('worker: PHOTO_FINALIZE floors used_bytes at 0', async () => {
  const { deleteFiles } = trackedDeletes([])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO, file_id: '', file_size: 9999999 }],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [{ ...USR, used_bytes: 1000000 }], // Less than file_size!
    deletion_tasks: [
      {
        _id: 'dt-floor',
        _openid: 'u1',
        type: 'PHOTO_DELETE',
        task_key: 'PHOTO_DELETE:p1',
        photo_id: 'p1',
        file_id: '',
        file_size: 9999999,
        status: 'PENDING',
        current_stage: 'PHOTO_FINALIZE', // Skip to final stage
        stage_cursor: { notes_cursor: null, photo_tags_cursor: null, notes_done: true, photo_tags_done: true },
        retry_count: 0,
        next_retry_at: null,
        lease_token: null,
        lease_expire_at: null,
        last_error: null,
        last_error_at: null,
        applied_at: now,
        completed_at: null,
      },
    ],
  })

  const worker = createPhotoDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  const summary = await worker.run()
  assert.equal(summary.succeeded, 1)

  const store = db.inspect()
  const user = store.users.get('u1')
  // Should floor at 0, not go negative
  assert.equal(user.used_bytes, 0)
})

test('worker: RETRYING after failure', async () => {
  // deleteFiles throws with a non-NOT-FOUND error
  const deleteFiles = async () => {
    const err = new Error('Network error')
    err.code = 'NETWORK_ERROR'
    throw err
  }
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO }],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [{ ...USR }],
    deletion_tasks: [
      {
        _id: 'dt-retry',
        _openid: 'u1',
        type: 'PHOTO_DELETE',
        task_key: 'PHOTO_DELETE:p1',
        photo_id: 'p1',
        file_id: 'cloud://file',
        file_size: 100,
        status: 'PENDING',
        current_stage: 'STORAGE_DELETE',
        stage_cursor: { notes_cursor: null, photo_tags_cursor: null, notes_done: false, photo_tags_done: false },
        retry_count: 0,
        next_retry_at: null,
        lease_token: null,
        lease_expire_at: null,
        last_error: null,
        last_error_at: null,
        applied_at: now,
        completed_at: null,
      },
    ],
  })

  const worker = createPhotoDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  const summary = await worker.run()
  assert.equal(summary.acquired, 1)
  assert.equal(summary.failed, 1)

  const store = db.inspect()
  const task = store.deletion_tasks.get('dt-retry')
  assert.equal(task.status, 'RETRYING')
  assert.equal(task.retry_count, 1)
  assert.ok(task.next_retry_at instanceof Date)
  assert.ok(task.next_retry_at.getTime() > now.getTime())
})

test('worker: MANUAL_REQUIRED after MAX_RETRIES failures', async () => {
  const deleteFiles = async () => { throw { code: 'NETWORK_ERROR' } }
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO }],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [{ ...USR }],
    deletion_tasks: [
      {
        _id: 'dt-max',
        _openid: 'u1',
        type: 'PHOTO_DELETE',
        task_key: 'PHOTO_DELETE:p1',
        photo_id: 'p1',
        file_id: 'cloud://file',
        file_size: 100,
        status: 'RETRYING',
        current_stage: 'STORAGE_DELETE',
        stage_cursor: { notes_cursor: null, photo_tags_cursor: null, notes_done: false, photo_tags_done: false },
        retry_count: 9, // Next failure → 10 → MANUAL_REQUIRED
        next_retry_at: now,
        lease_token: null,
        lease_expire_at: null,
        last_error: null,
        last_error_at: null,
        applied_at: now,
        completed_at: null,
      },
    ],
  })

  const worker = createPhotoDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  await worker.run()

  const store = db.inspect()
  const task = store.deletion_tasks.get('dt-max')
  assert.equal(task.status, 'MANUAL_REQUIRED')
  assert.equal(task.retry_count, 10)
})

test('worker: MANUAL_REQUIRED after 7 days', async () => {
  const deleteFiles = async () => { throw { code: 'NETWORK_ERROR' } }
  const eightDaysAgo = new Date('2024-06-08T00:00:00Z')
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO }],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [{ ...USR }],
    deletion_tasks: [
      {
        _id: 'dt-old',
        _openid: 'u1',
        type: 'PHOTO_DELETE',
        task_key: 'PHOTO_DELETE:p1',
        photo_id: 'p1',
        file_id: 'cloud://file',
        file_size: 100,
        status: 'RETRYING',
        current_stage: 'STORAGE_DELETE',
        stage_cursor: { notes_cursor: null, photo_tags_cursor: null, notes_done: false, photo_tags_done: false },
        retry_count: 3, // Only 3 retries but >7 days
        next_retry_at: now,
        lease_token: null,
        lease_expire_at: null,
        last_error: null,
        last_error_at: null,
        applied_at: eightDaysAgo,
        completed_at: null,
      },
    ],
  })

  const worker = createPhotoDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  await worker.run()

  const store = db.inspect()
  const task = store.deletion_tasks.get('dt-old')
  assert.equal(task.status, 'MANUAL_REQUIRED')
})

test('worker: exponential backoff scales correctly', async () => {
  const deleteFiles = async () => { throw { code: 'NETWORK_ERROR' } }
  const now = new Date('2024-06-16T00:00:00Z')

  for (let rc = 0; rc < 3; rc++) {
    const db = createMockDb({
      photos: [{ ...ACTIVE_PHOTO }],
      notes: [],
      photo_tags: [],
      tags: [],
      users: [{ ...USR }],
      deletion_tasks: [
        {
          _id: `dt-backoff-${rc}`,
          _openid: 'u1',
          type: 'PHOTO_DELETE',
          task_key: `PHOTO_DELETE:p${rc}`,
          photo_id: `p${rc}`,
          file_id: 'cloud://file',
          file_size: 100,
          status: 'RETRYING',
          current_stage: 'STORAGE_DELETE',
          stage_cursor: { notes_cursor: null, photo_tags_cursor: null, notes_done: false, photo_tags_done: false },
          retry_count: rc,
          next_retry_at: now,
          lease_token: null,
          lease_expire_at: null,
          last_error: null,
          last_error_at: null,
          applied_at: now,
          completed_at: null,
        },
      ],
    })

    const worker = createPhotoDeleteWorker({
      db,
      deleteFiles,
      now: () => now,
      batchSize: 10,
    })

    await worker.run()
    const task = db.inspect().deletion_tasks.get(`dt-backoff-${rc}`)
    const expectedBackoff = Math.min(60000 * Math.pow(2, rc + 1), 86400000)
    const actualDiff = task.next_retry_at.getTime() - now.getTime()
    assert.ok(actualDiff >= expectedBackoff * 0.9, `backoff for rc=${rc}: expected ~${expectedBackoff}, got ${actualDiff}`)
  }
})

test('worker: lease acquisition sets PROCESSING with lease fields', async () => {
  const { deleteFiles } = trackedDeletes(['cloud://file'])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO, file_id: 'cloud://file' }],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [{ ...USR }],
    deletion_tasks: [
      {
        _id: 'dt-lease',
        _openid: 'u1',
        type: 'PHOTO_DELETE',
        task_key: 'PHOTO_DELETE:p1',
        photo_id: 'p1',
        file_id: 'cloud://file',
        file_size: 100,
        status: 'PENDING',
        current_stage: 'STORAGE_DELETE',
        stage_cursor: { notes_cursor: null, photo_tags_cursor: null, notes_done: false, photo_tags_done: false },
        retry_count: 0,
        next_retry_at: null,
        lease_token: null,
        lease_expire_at: null,
        last_error: null,
        last_error_at: null,
        applied_at: now,
        completed_at: null,
      },
    ],
  })

  const worker = createPhotoDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  await worker.run()

  const store = db.inspect()
  const task = store.deletion_tasks.get('dt-lease')
  assert.equal(task.status, 'COMPLETED')
})

test('worker: respects next_retry_at — task not ready is not acquired', async () => {
  const { deleteFiles } = trackedDeletes(['cloud://file'])
  const now = new Date('2024-06-16T00:00:00Z')
  const futureRetry = new Date('2024-06-17T00:00:00Z')

  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO }],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [{ ...USR }],
    deletion_tasks: [
      {
        _id: 'dt-future',
        _openid: 'u1',
        type: 'PHOTO_DELETE',
        task_key: 'PHOTO_DELETE:p1',
        photo_id: 'p1',
        file_id: 'cloud://file',
        file_size: 100,
        status: 'RETRYING',
        current_stage: 'STORAGE_DELETE',
        stage_cursor: { notes_cursor: null, photo_tags_cursor: null, notes_done: false, photo_tags_done: false },
        retry_count: 1,
        next_retry_at: futureRetry, // Not ready yet
        lease_token: null,
        lease_expire_at: null,
        last_error: null,
        last_error_at: null,
        applied_at: now,
        completed_at: null,
      },
    ],
  })

  const worker = createPhotoDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  const summary = await worker.run()
  assert.equal(summary.acquired, 0)
})

test('worker: reclaims expired PROCESSING leases', async () => {
  const { deleteFiles } = trackedDeletes(['cloud://file'])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [{ ...ACTIVE_PHOTO, file_id: 'cloud://file' }],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [{ ...USR }],
    deletion_tasks: [
      {
        _id: 'dt-reclaim',
        _openid: 'u1',
        type: 'PHOTO_DELETE',
        task_key: 'PHOTO_DELETE:p1',
        photo_id: 'p1',
        file_id: 'cloud://file',
        file_size: 100,
        status: 'PROCESSING', // Stuck task with expired lease
        current_stage: 'STORAGE_DELETE',
        stage_cursor: { notes_cursor: null, photo_tags_cursor: null, notes_done: false, photo_tags_done: false },
        retry_count: 0,
        next_retry_at: null,
        lease_token: 'old-lease',
        lease_expire_at: new Date('2024-06-15T00:00:00Z'), // Expired yesterday
        last_error: null,
        last_error_at: null,
        applied_at: now,
        completed_at: null,
      },
    ],
  })

  const worker = createPhotoDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  const summary = await worker.run()
  assert.equal(summary.acquired, 1)
  assert.equal(summary.succeeded, 1)
})

test('worker: multiple tasks processed in one run', async () => {
  const { deleteFiles } = trackedDeletes(['cloud://f1', 'cloud://f2', 'cloud://f3'])
  const now = new Date('2024-06-16T00:00:00Z')

  const tasks = [1, 2, 3].map((i) => ({
    _id: `dt-multi-${i}`,
    _openid: 'u1',
    type: 'PHOTO_DELETE',
    task_key: `PHOTO_DELETE:pm${i}`,
    photo_id: `pm${i}`,
    file_id: `cloud://f${i}`,
    file_size: 100 * i,
    status: 'PENDING',
    current_stage: 'STORAGE_DELETE',
    stage_cursor: { notes_cursor: null, photo_tags_cursor: null, notes_done: false, photo_tags_done: false },
    retry_count: 0,
    next_retry_at: null,
    lease_token: null,
    lease_expire_at: null,
    last_error: null,
    last_error_at: null,
    applied_at: now,
    completed_at: null,
  }))

  const photos = [1, 2, 3].map((i) => ({
    ...ACTIVE_PHOTO,
    _id: `pm${i}`,
    file_id: `cloud://f${i}`,
    file_size: 100 * i,
    task_id: `task${i}`,
    upload_attempt_id: `att${i}`,
  }))

  const db = createMockDb({
    photos,
    notes: [],
    photo_tags: [],
    tags: [],
    users: [{ ...USR }],
    deletion_tasks: tasks,
  })

  const worker = createPhotoDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  const summary = await worker.run()
  assert.equal(summary.acquired, 3)
  assert.equal(summary.succeeded, 3)
  assert.equal(summary.failed, 0)
  assert.equal(summary.details.length, 3)
})
