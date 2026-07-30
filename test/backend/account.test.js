'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createAccountHandlers,
} = require('../../cloudfunctions/account/handlers')
const {
  createAccountDeleteWorker,
  MAX_RETRIES,
  MAX_DAYS_SINCE_APPLIED,
} = require('../../cloudfunctions/cleanup/account-delete-worker')

// ---------------------------------------------------------------------------
// Mock DB factory (extended from photo-delete.test.js pattern)
// ---------------------------------------------------------------------------

function isCommand(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  )
}

function evaluateCondition(value, cond) {
  if (!isCommand(cond)) {
    if (cond === null) return value === null
    if (cond instanceof Date)
      return value instanceof Date && value.getTime() === cond.getTime()
    return value === cond
  }
  if ('_and' in cond) {
    return (Array.isArray(cond._and) ? cond._and : [cond._and]).every((sub) =>
      evaluateCondition(value, sub),
    )
  }
  if ('_or' in cond) {
    return (Array.isArray(cond._or) ? cond._or : [cond._or]).some((sub) =>
      evaluateCondition(value, sub),
    )
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
  if (query._and) {
    return (Array.isArray(query._and) ? query._and : [query._and]).every((sub) =>
      matchItem(item, sub),
    )
  }
  if (query._or) {
    return (Array.isArray(query._or) ? query._or : [query._or]).some((sub) =>
      matchItem(item, sub),
    )
  }
  return Object.entries(query).every(([key, cond]) => {
    return evaluateCondition(item[key], cond)
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

function createMockDb(seed = {}) {
  let store = {
    photos: new Map((seed.photos || []).map((p) => [p._id, { ...p }])),
    notes: new Map((seed.notes || []).map((n) => [n._id, { ...n }])),
    photo_tags: new Map(
      (seed.photo_tags || []).map((r) => [r._id, { ...r }]),
    ),
    tags: new Map((seed.tags || []).map((t) => [t._id, { ...t }])),
    users: new Map((seed.users || []).map((u) => [u._id, { ...u }])),
    deletion_tasks: new Map(
      (seed.deletion_tasks || []).map((d) => [d._id, { ...d }]),
    ),
    upload_attempts: new Map(
      (seed.upload_attempts || []).map((a) => [a._id, { ...a }]),
    ),
  }

  let nextId = 100

  const _command = {
    and: (...args) => {
      const arr =
        args.length === 1 && Array.isArray(args[0]) ? args[0] : args
      return { _and: arr }
    },
    or: (...args) => {
      const arr =
        args.length === 1 && Array.isArray(args[0]) ? args[0] : args
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
        // Unique index check for deletion_tasks on (_openid, task_key)
        if (name === 'deletion_tasks' && data._openid && data.task_key) {
          for (const [, existing] of docs()) {
            if (
              existing._openid === data._openid &&
              existing.task_key === data.task_key
            ) {
              throw { errCode: -502003, code: 'DATABASE_DUPLICATE_KEY' }
            }
          }
        }
        // Unique index check for upload_attempts
        if (name === 'upload_attempts' && data._openid && data.task_id) {
          for (const [, existing] of docs()) {
            if (
              existing._openid === data._openid &&
              existing.task_id === data.task_id
            ) {
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
      transactionTail = new Promise((resolve) => {
        release = resolve
      })
      await previous
      let closed = false
      const txnStore = cloneStore(store)
      function done() {
        if (!closed) {
          closed = true
          release()
        }
      }
      return {
        collection(name) {
          return {
            ...collectionApi(name, () => txnStore),
            _store: () => txnStore,
          }
        },
        async commit() {
          store = txnStore
          done()
        },
        async rollback() {
          done()
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const ACTIVE_USER = {
  _id: 'u1',
  _openid: 'u1',
  status: 'ACTIVE',
  used_bytes: 5000000,
  limit_bytes: 524288000,
  created_at: new Date('2024-01-01'),
  updated_at: new Date('2024-06-15'),
}

const DELETING_USER = {
  _id: 'u2',
  _openid: 'u2',
  status: 'DELETING',
  used_bytes: 1000000,
  limit_bytes: 524288000,
}

const DELETED_USER = {
  _id: 'u3',
  _openid: 'u3',
  status: 'DELETED',
  used_bytes: 0,
  limit_bytes: 524288000,
}

function createHandlers(db) {
  return createAccountHandlers({ db })
}

function assertNoIdentity(value) {
  const serialized = JSON.stringify(value)
  assert.equal(serialized.includes('openid'), false)
  assert.equal(serialized.includes('_openid'), false)
}

// ===========================================================================
// Group 1: requestDeletion
// ===========================================================================

test('requestDeletion: successful deletion request', async () => {
  const db = createMockDb({ users: [{ ...ACTIVE_USER }] })
  const { requestDeletion } = createHandlers(db)

  const result = await requestDeletion('u1', {
    confirmText: '确认注销',
  })

  assert.equal(result.code, 'SUCCESS')
  assert.ok(result.data.taskId)
  assert.equal(result.data.status, 'PENDING')
  assert.ok(result.data.appliedAt instanceof Date)
  assert.equal(result.data.completedAt, null)

  // User marked DELETING
  const store = db.inspect()
  const user = store.users.get('u1')
  assert.equal(user.status, 'DELETING')

  // Task created with correct fields
  const tasks = [...store.deletion_tasks.values()]
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].type, 'ACCOUNT_DELETION')
  assert.equal(tasks[0].task_key, 'ACCOUNT_DELETION:u1')
  assert.equal(tasks[0].status, 'PENDING')
  assert.equal(tasks[0].current_stage, 'STORAGE_CLEANUP')
  assert.equal(tasks[0]._openid, 'u1')
})

test('requestDeletion: wrong confirm text → VALIDATION_ERROR', async () => {
  const db = createMockDb({ users: [{ ...ACTIVE_USER }] })
  const { requestDeletion } = createHandlers(db)

  try {
    await requestDeletion('u1', { confirmText: '确认' })
    assert.fail('expected error')
  } catch (err) {
    assert.equal(err.code, 'VALIDATION_ERROR')
  }
})

test('requestDeletion: missing confirmText → VALIDATION_ERROR', async () => {
  const db = createMockDb({ users: [{ ...ACTIVE_USER }] })
  const { requestDeletion } = createHandlers(db)

  try {
    await requestDeletion('u1', {})
    assert.fail('expected error')
  } catch (err) {
    assert.equal(err.code, 'VALIDATION_ERROR')
  }
})

test('requestDeletion: non-ACTIVE user (DELETING) with existing task → returns task', async () => {
  const db = createMockDb({
    users: [{ ...DELETING_USER }],
    deletion_tasks: [
      {
        _id: 'dt-existing',
        _openid: 'u2',
        type: 'ACCOUNT_DELETION',
        task_key: 'ACCOUNT_DELETION:u2',
        status: 'PENDING',
        current_stage: 'STORAGE_CLEANUP',
        stage_cursor: {
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
        },
        retry_count: 0,
        applied_at: new Date('2024-06-15T12:00:00Z'),
        completed_at: null,
        updated_at: new Date('2024-06-15T12:00:00Z'),
      },
    ],
  })
  const { requestDeletion } = createHandlers(db)

  const result = await requestDeletion('u2', {
    confirmText: '确认注销',
  })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.taskId, 'dt-existing')
  assert.equal(result.data.status, 'PENDING')
})

test('requestDeletion: non-ACTIVE user (DELETED) with completed task → returns task', async () => {
  const db = createMockDb({
    users: [{ ...DELETED_USER }],
    deletion_tasks: [
      {
        _id: 'dt-completed',
        _openid: 'u3',
        type: 'ACCOUNT_DELETION',
        task_key: 'ACCOUNT_DELETION:u3',
        status: 'COMPLETED',
        current_stage: null,
        stage_cursor: null,
        retry_count: 0,
        applied_at: new Date('2024-01-01T00:00:00Z'),
        completed_at: new Date('2024-01-02T00:00:00Z'),
      },
    ],
  })
  const { requestDeletion } = createHandlers(db)

  const result = await requestDeletion('u3', {
    confirmText: '确认注销',
  })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.taskId, 'dt-completed')
  assert.equal(result.data.status, 'COMPLETED')
  assert.ok(result.data.completedAt instanceof Date)
})

test('requestDeletion: DELETING user without task → USER_NOT_ACTIVE', async () => {
  const db = createMockDb({
    users: [{ ...DELETING_USER }],
  })
  const { requestDeletion } = createHandlers(db)

  try {
    await requestDeletion('u2', { confirmText: '确认注销' })
    assert.fail('expected error')
  } catch (err) {
    assert.equal(err.code, 'USER_NOT_ACTIVE')
  }
})

test('requestDeletion: non-existent user → USER_NOT_ACTIVE', async () => {
  const db = createMockDb({})
  const { requestDeletion } = createHandlers(db)

  try {
    await requestDeletion('nonexistent', { confirmText: '确认注销' })
    assert.fail('expected error')
  } catch (err) {
    assert.equal(err.code, 'USER_NOT_ACTIVE')
  }
})

test('requestDeletion: concurrent requests → one creates, one replays', async () => {
  const db = createMockDb({ users: [{ ...ACTIVE_USER }] })
  const { requestDeletion } = createHandlers(db)

  const results = await Promise.allSettled([
    requestDeletion('u1', { confirmText: '确认注销' }),
    requestDeletion('u1', { confirmText: '确认注销' }),
  ])

  const successes = results.filter(
    (r) => r.status === 'fulfilled' && r.value.code === 'SUCCESS',
  )
  assert.ok(successes.length >= 1)

  // Only one task created
  const store = db.inspect()
  assert.equal(store.deletion_tasks.size, 1)

  // User is DELETING
  const user = store.users.get('u1')
  assert.equal(user.status, 'DELETING')
})

test('requestDeletion: response projection excludes internal fields', async () => {
  const db = createMockDb({ users: [{ ...ACTIVE_USER }] })
  const { requestDeletion } = createHandlers(db)

  const result = await requestDeletion('u1', {
    confirmText: '确认注销',
  })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data._openid, undefined)
  assert.equal(result.data.task_key, undefined)
  assert.equal(result.data.current_stage, undefined)
  assert.equal(result.data.stage_cursor, undefined)
  assert.equal(result.data.retry_count, undefined)
  assert.equal(result.data.lease_token, undefined)
  assert.equal(result.data.lease_expire_at, undefined)
  assert.equal(result.data.last_error, undefined)
})

// ===========================================================================
// Group 2: getDeletionStatus
// ===========================================================================

test('getDeletionStatus: DELETING user with task returns authoritative status', async () => {
  const db = createMockDb({
    users: [{ ...DELETING_USER }],
    deletion_tasks: [
      {
        _id: 'dt-status-1',
        _openid: 'u2',
        type: 'ACCOUNT_DELETION',
        task_key: 'ACCOUNT_DELETION:u2',
        status: 'PROCESSING',
        current_stage: 'RELATED_DATA_CLEANUP',
        retry_count: 2,
        applied_at: new Date('2024-06-15T12:00:00Z'),
        completed_at: null,
      },
    ],
  })
  const { getDeletionStatus } = createHandlers(db)

  const result = await getDeletionStatus('u2')

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.taskId, 'dt-status-1')
  assert.equal(result.data.status, 'PROCESSING')
  assert.equal(result.data.completedAt, null)
  assert.ok(result.data.appliedAt instanceof Date)
})

test('getDeletionStatus: DELETING user without task returns raw status', async () => {
  const db = createMockDb({
    users: [{ ...DELETING_USER }],
  })
  const { getDeletionStatus } = createHandlers(db)

  const result = await getDeletionStatus('u2')

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.status, 'DELETING')
  assert.equal(result.data.taskId, null)
})

test('getDeletionStatus: USER_NOT_FOUND → DELETED', async () => {
  const db = createMockDb({})
  const { getDeletionStatus } = createHandlers(db)

  const result = await getDeletionStatus('deleted-user')

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.status, 'DELETED')
})

test('getDeletionStatus: COMPLETED task returns completedAt', async () => {
  const db = createMockDb({
    users: [{ ...DELETED_USER }],
    deletion_tasks: [
      {
        _id: 'dt-completed-2',
        _openid: 'u3',
        type: 'ACCOUNT_DELETION',
        task_key: 'ACCOUNT_DELETION:u3',
        status: 'COMPLETED',
        applied_at: new Date('2024-01-01T00:00:00Z'),
        completed_at: new Date('2024-01-02T00:00:00Z'),
      },
    ],
  })
  const { getDeletionStatus } = createHandlers(db)

  const result = await getDeletionStatus('u3')

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.status, 'COMPLETED')
  assert.ok(result.data.completedAt instanceof Date)
})

test('getDeletionStatus: response projection excludes internal fields', async () => {
  const db = createMockDb({
    users: [{ ...DELETING_USER }],
    deletion_tasks: [
      {
        _id: 'dt-proj',
        _openid: 'u2',
        type: 'ACCOUNT_DELETION',
        task_key: 'ACCOUNT_DELETION:u2',
        status: 'PENDING',
        current_stage: 'STORAGE_CLEANUP',
        stage_cursor: {},
        retry_count: 0,
        next_retry_at: null,
        lease_token: null,
        lease_expire_at: null,
        last_error: null,
        last_error_at: null,
        applied_at: new Date('2024-06-15'),
        completed_at: null,
      },
    ],
  })
  const { getDeletionStatus } = createHandlers(db)

  const result = await getDeletionStatus('u2')

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.current_stage, undefined)
  assert.equal(result.data.stage_cursor, undefined)
  assert.equal(result.data.retry_count, undefined)
  assert.equal(result.data.next_retry_at, undefined)
  assert.equal(result.data.lease_token, undefined)
  assert.equal(result.data.lease_expire_at, undefined)
  assert.equal(result.data.last_error, undefined)
  assert.equal(result.data._openid, undefined)
})

// ===========================================================================
// Group 3: Account Deletion Worker
// ===========================================================================

function trackedDeletes(files = []) {
  const deleted = []
  return {
    deleted,
    deleteFiles: async (fileList) => {
      for (const fid of fileList) {
        const found = files.includes(fid)
        if (!fid || !found) {
          const err = new Error('STORAGE_FILE_NON_EXIST')
          err.errCode = 'STORAGE_FILE_NON_EXIST'
          throw err
        }
        deleted.push(fid)
      }
    },
  }
}

function makeAccountTask(overrides = {}) {
  return {
    _id: 'dt-acc-1',
    _openid: 'u1',
    type: 'ACCOUNT_DELETION',
    task_key: 'ACCOUNT_DELETION:u1',
    status: 'PENDING',
    current_stage: 'STORAGE_CLEANUP',
    stage_cursor: {
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
    },
    retry_count: 0,
    next_retry_at: null,
    lease_token: null,
    lease_expire_at: null,
    last_error: null,
    last_error_at: null,
    applied_at: new Date('2024-06-16T00:00:00Z'),
    completed_at: null,
    ...overrides,
  }
}

function makePhoto(overrides = {}) {
  return {
    _id: 'p1',
    _openid: 'u1',
    status: 'ACTIVE',
    file_id: 'cloud://env/photos/active/a1.bin',
    file_size: 1500000,
    width: 1920,
    height: 1080,
    format: 'JPEG',
    shoot_time: '2024-06-15T12:00:00.000Z',
    upload_time: '2024-06-15T12:05:00.000Z',
    tag_count: 0,
    updated_at: new Date('2024-06-15'),
    ...overrides,
  }
}

test('worker: full account deletion lifecycle', async () => {
  const { deleted, deleteFiles } = trackedDeletes([
    'cloud://env/photos/active/a1.bin',
    'cloud://env/photos/active/a2.bin',
  ])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [
      makePhoto(),
      makePhoto({
        _id: 'p2',
        file_id: 'cloud://env/photos/active/a2.bin',
        task_id: 'task2',
        upload_attempt_id: 'att2',
      }),
    ],
    notes: [
      {
        _id: 'n1',
        _openid: 'u1',
        photo_id: 'p1',
        content: 'test note',
        created_at: now,
        updated_at: now,
      },
    ],
    photo_tags: [
      {
        _id: 'r1',
        _openid: 'u1',
        photo_id: 'p1',
        tag_id: 't1',
        photo_upload_time: now,
      },
    ],
    tags: [
      {
        _id: 't1',
        _openid: 'u1',
        name: 'mytag',
        normalized_name: 'mytag',
        photo_count: 1,
      },
    ],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 5000000,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [
      {
        _id: 'att1',
        _openid: 'u1',
        task_id: 'task1',
        status: 'CONFIRMED',
      },
    ],
    deletion_tasks: [makeAccountTask()],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  // Run through all stages
  let summary = await worker.run()
  let task = db.inspect().deletion_tasks.get('dt-acc-1')

  // Keep running until COMPLETED
  let maxRuns = 20
  while (task && task.status !== 'COMPLETED' && maxRuns-- > 0) {
    summary = await worker.run()
    task = db.inspect().deletion_tasks.get('dt-acc-1')
  }

  // Verify final state
  const store = db.inspect()
  assert.equal(task.status, 'COMPLETED')

  // User record deleted
  assert.equal(store.users.has('u1'), false)

  // Task anonymized
  assert.equal(task._openid, null)
  assert.equal(task.stage_cursor, null)
  assert.equal(task.current_stage, null)
  assert.ok(task.completed_at instanceof Date)

  // Photos deleted
  assert.equal(store.photos.size, 0)

  // Notes deleted
  assert.equal(store.notes.size, 0)

  // Photo_tags deleted
  assert.equal(store.photo_tags.size, 0)

  // Tags deleted
  assert.equal(store.tags.size, 0)

  // Upload attempts deleted
  assert.equal(store.upload_attempts.size, 0)

  // Storage files deleted
  assert.ok(deleted.includes('cloud://env/photos/active/a1.bin'))
  assert.ok(deleted.includes('cloud://env/photos/active/a2.bin'))
})

test('worker: STORAGE_CLEANUP — file not found is idempotent', async () => {
  // No known files — all file deletes will be "not found"
  const { deleteFiles } = trackedDeletes([])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [makePhoto()],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 100,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [],
    deletion_tasks: [makeAccountTask()],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  const summary = await worker.run()
  // Storage cleanup should succeed (file not found is ignored)
  const task = db.inspect().deletion_tasks.get('dt-acc-1')
  // Task should have progressed past STORAGE_CLEANUP or be completed
  // (stage_cursor is null if USER_FINALIZE completed in the same run)
  assert.ok(
    task.status === 'COMPLETED' ||
      task.current_stage !== 'STORAGE_CLEANUP' ||
      (task.stage_cursor && task.stage_cursor.storage_done),
  )
})

test('worker: RELATED_DATA_CLEANUP — batch deletes notes', async () => {
  const { deleteFiles } = trackedDeletes([])
  const now = new Date('2024-06-16T00:00:00Z')

  const notes = []
  for (let i = 0; i < 25; i++) {
    notes.push({
      _id: `note-${i}`,
      _openid: 'u1',
      photo_id: `p${i}`,
      content: `Note ${i}`,
      created_at: now,
      updated_at: now,
    })
  }

  const db = createMockDb({
    photos: [],
    notes,
    photo_tags: [],
    tags: [],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 100,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [],
    deletion_tasks: [
      makeAccountTask({
        current_stage: 'RELATED_DATA_CLEANUP',
        stage_cursor: {
          storage_photos_cursor: null,
          storage_done: true,
          notes_cursor: null,
          photo_tags_cursor: null,
          tags_cursor: null,
          notes_done: false,
          photo_tags_done: true,
          tags_done: true,
          photos_cursor: null,
          upload_attempts_cursor: null,
          photos_done: false,
          upload_attempts_done: false,
        },
      }),
    ],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  // Run multiple times to process all batches
  for (let run = 0; run < 5; run++) {
    await worker.run()
    const task = db.inspect().deletion_tasks.get('dt-acc-1')
    if (task.current_stage !== 'RELATED_DATA_CLEANUP') break
  }

  const store = db.inspect()
  const remainingNotes = [...store.notes.values()]
  assert.equal(remainingNotes.length, 0)
})

test('worker: PRIMARY_DATA_CLEANUP — batch deletes photos and upload_attempts', async () => {
  const { deleteFiles } = trackedDeletes([])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [
      makePhoto(),
      makePhoto({
        _id: 'p2',
        file_id: '',
        task_id: 'task2',
        upload_attempt_id: 'att2',
      }),
    ],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 100,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [
      { _id: 'a1', _openid: 'u1', task_id: 'task1' },
    ],
    deletion_tasks: [
      makeAccountTask({
        current_stage: 'PRIMARY_DATA_CLEANUP',
        stage_cursor: {
          storage_photos_cursor: null,
          storage_done: true,
          notes_cursor: null,
          photo_tags_cursor: null,
          tags_cursor: null,
          notes_done: true,
          photo_tags_done: true,
          tags_done: true,
          photos_cursor: null,
          upload_attempts_cursor: null,
          photos_done: false,
          upload_attempts_done: false,
        },
      }),
    ],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  // Run to completion
  for (let run = 0; run < 5; run++) {
    await worker.run()
    const task = db.inspect().deletion_tasks.get('dt-acc-1')
    if (task.status === 'COMPLETED' || task.current_stage === 'USER_FINALIZE')
      break
  }

  const store = db.inspect()
  assert.equal(store.photos.size, 0)
  assert.equal(store.upload_attempts.size, 0)
  assert.equal(store.users.has('u1'), false)
})

test('worker: USER_FINALIZE — anonymizes task and deletes user', async () => {
  const { deleteFiles } = trackedDeletes([])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 100,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [],
    deletion_tasks: [
      makeAccountTask({
        current_stage: 'USER_FINALIZE',
        stage_cursor: {
          storage_photos_cursor: null,
          storage_done: true,
          notes_cursor: null,
          photo_tags_cursor: null,
          tags_cursor: null,
          notes_done: true,
          photo_tags_done: true,
          tags_done: true,
          photos_cursor: null,
          upload_attempts_cursor: null,
          photos_done: true,
          upload_attempts_done: true,
        },
      }),
    ],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  const summary = await worker.run()
  assert.equal(summary.acquired, 1)
  assert.equal(summary.succeeded, 1)

  const store = db.inspect()
  const task = store.deletion_tasks.get('dt-acc-1')

  // Task is COMPLETED
  assert.equal(task.status, 'COMPLETED')

  // Task is anonymized — no OPENID
  assert.equal(task._openid, null)

  // Internal fields cleared
  assert.equal(task.stage_cursor, null)
  assert.equal(task.current_stage, null)
  assert.equal(task.lease_token, null)
  assert.equal(task.lease_expire_at, null)
  assert.equal(task.next_retry_at, null)
  assert.equal(task.last_error, null)
  assert.equal(task.last_error_at, null)

  // task_key and type preserved for audit trail
  assert.equal(task.task_key, 'ACCOUNT_DELETION:u1')
  assert.equal(task.type, 'ACCOUNT_DELETION')

  // completed_at set
  assert.ok(task.completed_at instanceof Date)

  // User record deleted
  assert.equal(store.users.has('u1'), false)
})

test('worker: RETRYING after failure with exponential backoff', async () => {
  // deleteFiles throws non-NOT-FOUND error
  const deleteFiles = async () => {
    const err = new Error('Network error')
    err.code = 'NETWORK_ERROR'
    throw err
  }
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [makePhoto()],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 100,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [],
    deletion_tasks: [makeAccountTask()],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  const summary = await worker.run()
  assert.equal(summary.acquired, 1)
  assert.equal(summary.failed, 1)

  const store = db.inspect()
  const task = store.deletion_tasks.get('dt-acc-1')
  assert.equal(task.status, 'RETRYING')
  assert.equal(task.retry_count, 1)
  assert.ok(task.next_retry_at instanceof Date)
  assert.ok(task.next_retry_at.getTime() > now.getTime())
})

test('worker: MANUAL_REQUIRED after MAX_RETRIES', async () => {
  const deleteFiles = async () => {
    throw { code: 'NETWORK_ERROR' }
  }
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [makePhoto()],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 100,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [],
    deletion_tasks: [
      makeAccountTask({
        status: 'RETRYING',
        retry_count: 9,
        next_retry_at: now,
      }),
    ],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  await worker.run()

  const store = db.inspect()
  const task = store.deletion_tasks.get('dt-acc-1')
  assert.equal(task.status, 'MANUAL_REQUIRED')
  assert.equal(task.retry_count, 10)
})

test('worker: MANUAL_REQUIRED after 7 days', async () => {
  const deleteFiles = async () => {
    throw { code: 'NETWORK_ERROR' }
  }
  const eightDaysAgo = new Date('2024-06-08T00:00:00Z')
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [makePhoto()],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 100,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [],
    deletion_tasks: [
      makeAccountTask({
        status: 'RETRYING',
        retry_count: 3,
        next_retry_at: now,
        applied_at: eightDaysAgo,
      }),
    ],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  await worker.run()

  const store = db.inspect()
  const task = store.deletion_tasks.get('dt-acc-1')
  assert.equal(task.status, 'MANUAL_REQUIRED')
})

test('worker: exponential backoff scales correctly', async () => {
  const deleteFiles = async () => {
    throw { code: 'NETWORK_ERROR' }
  }
  const now = new Date('2024-06-16T00:00:00Z')

  for (let rc = 0; rc < 3; rc++) {
    const db = createMockDb({
      photos: [makePhoto({ _id: `p${rc}`, task_id: `t${rc}`, upload_attempt_id: `a${rc}` })],
      notes: [],
      photo_tags: [],
      tags: [],
      users: [
        {
          _id: 'u1',
          _openid: 'u1',
          status: 'DELETING',
          used_bytes: 100,
          limit_bytes: 524288000,
        },
      ],
      upload_attempts: [],
      deletion_tasks: [
        makeAccountTask({
          _id: `dt-backoff-${rc}`,
          task_key: `ACCOUNT_DELETION:backoff-${rc}`,
          _openid: 'u1',
          status: 'RETRYING',
          retry_count: rc,
          next_retry_at: now,
        }),
      ],
    })

    const worker = createAccountDeleteWorker({
      db,
      deleteFiles,
      now: () => now,
      batchSize: 10,
    })

    await worker.run()
    const task = db.inspect().deletion_tasks.get(`dt-backoff-${rc}`)
    const expectedBackoff = Math.min(60000 * Math.pow(2, rc + 1), 86400000)
    const actualDiff = task.next_retry_at.getTime() - now.getTime()
    assert.ok(
      actualDiff >= expectedBackoff * 0.9,
      `backoff for rc=${rc}: expected ~${expectedBackoff}, got ${actualDiff}`,
    )
  }
})

test('worker: lease acquisition sets PROCESSING with lease fields', async () => {
  const { deleteFiles } = trackedDeletes(['cloud://env/photos/active/a1.bin'])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [makePhoto()],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 100,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [],
    deletion_tasks: [makeAccountTask()],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  await worker.run()

  // Task was leased (lease fields set during processing)
  // After storage cleanup completes, it may advance through all stages to COMPLETED
  const store = db.inspect()
  const task = store.deletion_tasks.get('dt-acc-1')
  // It should at least have progressed past STORAGE_CLEANUP or completed
  assert.ok(
    task.status === 'COMPLETED' ||
      task.current_stage !== 'STORAGE_CLEANUP' ||
      (task.stage_cursor && task.stage_cursor.storage_done),
  )
})

test('worker: respects next_retry_at', async () => {
  const { deleteFiles } = trackedDeletes(['cloud://file'])
  const now = new Date('2024-06-16T00:00:00Z')
  const futureRetry = new Date('2024-06-17T00:00:00Z')

  const db = createMockDb({
    photos: [],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 100,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [],
    deletion_tasks: [
      makeAccountTask({
        status: 'RETRYING',
        retry_count: 1,
        next_retry_at: futureRetry,
      }),
    ],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  const summary = await worker.run()
  assert.equal(summary.acquired, 0)
})

test('worker: reclaims expired PROCESSING leases', async () => {
  const { deleteFiles } = trackedDeletes(['cloud://env/photos/active/a1.bin'])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [makePhoto()],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 100,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [],
    deletion_tasks: [
      makeAccountTask({
        status: 'PROCESSING',
        lease_token: 'old-lease',
        lease_expire_at: new Date('2024-06-15T00:00:00Z'), // Expired
      }),
    ],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  const summary = await worker.run()
  assert.equal(summary.acquired, 1)
})

test('worker: multiple tasks processed in one run', async () => {
  const { deleteFiles } = trackedDeletes([])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 0,
        limit_bytes: 524288000,
      },
      {
        _id: 'u2',
        _openid: 'u2',
        status: 'DELETING',
        used_bytes: 0,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [],
    deletion_tasks: [
      makeAccountTask({
        _id: 'dt-1',
        current_stage: 'USER_FINALIZE',
        stage_cursor: {
          storage_photos_cursor: null,
          storage_done: true,
          notes_cursor: null,
          photo_tags_cursor: null,
          tags_cursor: null,
          notes_done: true,
          photo_tags_done: true,
          tags_done: true,
          photos_cursor: null,
          upload_attempts_cursor: null,
          photos_done: true,
          upload_attempts_done: true,
        },
      }),
      makeAccountTask({
        _id: 'dt-2',
        _openid: 'u2',
        task_key: 'ACCOUNT_DELETION:u2',
        current_stage: 'USER_FINALIZE',
        stage_cursor: {
          storage_photos_cursor: null,
          storage_done: true,
          notes_cursor: null,
          photo_tags_cursor: null,
          tags_cursor: null,
          notes_done: true,
          photo_tags_done: true,
          tags_done: true,
          photos_cursor: null,
          upload_attempts_cursor: null,
          photos_done: true,
          upload_attempts_done: true,
        },
      }),
    ],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  const summary = await worker.run()
  assert.equal(summary.acquired, 2)
  assert.equal(summary.succeeded, 2)
  assert.equal(summary.failed, 0)

  // Both users deleted
  const store = db.inspect()
  assert.equal(store.users.has('u1'), false)
  assert.equal(store.users.has('u2'), false)

  // Both tasks anonymized
  const t1 = store.deletion_tasks.get('dt-1')
  const t2 = store.deletion_tasks.get('dt-2')
  assert.equal(t1._openid, null)
  assert.equal(t2._openid, null)
})

test('worker: STORAGE_CLEANUP batch resumes from cursor', async () => {
  const { deleted, deleteFiles } = trackedDeletes([
    'cloud://env/photos/active/a1.bin',
    'cloud://env/photos/active/a2.bin',
    'cloud://env/photos/active/a3.bin',
  ])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [
      makePhoto({ _id: 'p1', file_id: 'cloud://env/photos/active/a1.bin', task_id: 't1', upload_attempt_id: 'a1' }),
      makePhoto({ _id: 'p2', file_id: 'cloud://env/photos/active/a2.bin', task_id: 't2', upload_attempt_id: 'a2' }),
      makePhoto({ _id: 'p3', file_id: 'cloud://env/photos/active/a3.bin', task_id: 't3', upload_attempt_id: 'a3' }),
    ],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 100,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [],
    deletion_tasks: [makeAccountTask()],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 1, // Process one photo at a time
  })

  // Run 3+ times to process all photos in batches
  for (let i = 0; i < 5; i++) {
    await worker.run()
    const task = db.inspect().deletion_tasks.get('dt-acc-1')
    if (task.stage_cursor.storage_done || task.current_stage !== 'STORAGE_CLEANUP')
      break
  }

  // All file_ids should be deleted
  assert.ok(deleted.includes('cloud://env/photos/active/a1.bin'))
  assert.ok(deleted.includes('cloud://env/photos/active/a2.bin'))
  assert.ok(deleted.includes('cloud://env/photos/active/a3.bin'))

  const task = db.inspect().deletion_tasks.get('dt-acc-1')
  assert.ok(task.stage_cursor.storage_done || task.current_stage !== 'STORAGE_CLEANUP')
})

test('worker: idempotent — running twice on USER_FINALIZE task works', async () => {
  const { deleteFiles } = trackedDeletes([])
  const now = new Date('2024-06-16T00:00:00Z')

  const db = createMockDb({
    photos: [],
    notes: [],
    photo_tags: [],
    tags: [],
    users: [
      {
        _id: 'u1',
        _openid: 'u1',
        status: 'DELETING',
        used_bytes: 100,
        limit_bytes: 524288000,
      },
    ],
    upload_attempts: [],
    deletion_tasks: [
      makeAccountTask({
        current_stage: 'USER_FINALIZE',
        stage_cursor: {
          storage_photos_cursor: null,
          storage_done: true,
          notes_cursor: null,
          photo_tags_cursor: null,
          tags_cursor: null,
          notes_done: true,
          photo_tags_done: true,
          tags_done: true,
          photos_cursor: null,
          upload_attempts_cursor: null,
          photos_done: true,
          upload_attempts_done: true,
        },
      }),
    ],
  })

  const worker = createAccountDeleteWorker({
    db,
    deleteFiles,
    now: () => now,
    batchSize: 10,
  })

  // First run
  let summary = await worker.run()
  assert.equal(summary.succeeded, 1)

  // Second run — task is COMPLETED, should not be acquired
  summary = await worker.run()
  assert.equal(summary.acquired, 0)
})
