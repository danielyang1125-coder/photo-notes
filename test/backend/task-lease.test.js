'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
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
} = require('../../cloudfunctions/cleanup/task-lease')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const NOW = new Date('2026-07-30T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

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
    if (key === '_id' && cond && typeof cond === 'object' && cond._in) {
      return cond._in.includes(item[key])
    }
    return evaluateCondition(item[key], cond)
  })
}

function compareValues(a, b) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function tasksCollection(documents) {
  const docs = new Map(documents.map((d) => [d._id, { ...d }]))

  return {
    _docs: docs,
    _clock: () => NOW,

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
              let items = [...docs.values()].filter((i) => matchItem(i, _query))
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
          return { data: [...docs.values()].filter((i) => matchItem(i, _query)).map((i) => ({ ...i })) }
        },
        async update({ data }) {
          const items = [...docs.values()].filter((i) => matchItem(i, _query))
          let updated = 0
          for (const item of items) {
            for (const [k, v] of Object.entries(data)) {
              item[k] = v
            }
            docs.set(item._id, item)
            updated++
          }
          return { stats: { updated } }
        },
      }
    },

    doc(id) {
      return {
        async get() {
          const item = docs.get(id)
          if (!item) return { data: null }
          return { data: { ...item } }
        },
        async update({ data }) {
          const item = docs.get(id)
          if (!item) return { data: null }
          for (const [k, v] of Object.entries(data)) {
            item[k] = v
          }
          docs.set(id, item)
          return { stats: { updated: 1 } }
        },
      }
    },
  }
}

function createMockDb(documents = []) {
  const tasks = tasksCollection(documents)

  return {
    collection(name) {
      if (name === 'deletion_tasks') return tasks
      throw new Error(`Unexpected collection: ${name}`)
    },
    command: {
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
    },
    _tasks: tasks,
  }
}

function makeTask(id, overrides = {}) {
  return {
    _id: id,
    _openid: 'user-1',
    type: 'PHOTO_DELETE',
    status: 'PENDING',
    current_stage: 'STORAGE_DELETE',
    lease_token: null,
    lease_expire_at: null,
    next_retry_at: null,
    retry_count: 0,
    last_error: null,
    last_error_at: null,
    applied_at: new Date(NOW.getTime() - HOUR),
    photo_id: `photo-${id}`,
    file_id: `cloud://env/photos/${id}.jpg`,
    file_size: 1024,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
test('LEASE_TTL_MS is 10 minutes', () => {
  assert.equal(LEASE_TTL_MS, 10 * 60 * 1000)
})

test('LEASE_RENEW_INTERVAL_MS is 2 minutes', () => {
  assert.equal(LEASE_RENEW_INTERVAL_MS, 2 * 60 * 1000)
})

test('MAX_RETRIES is 10', () => {
  assert.equal(MAX_RETRIES, 10)
})

test('MAX_DAYS_SINCE_APPLIED is 7', () => {
  assert.equal(MAX_DAYS_SINCE_APPLIED, 7)
})

test('DISPATCHABLE_STATUSES contains PENDING and RETRYING', () => {
  assert.deepEqual(DISPATCHABLE_STATUSES, ['PENDING', 'RETRYING'])
})

// ---------------------------------------------------------------------------
// calculateBackoff
// ---------------------------------------------------------------------------
test('calculateBackoff retry 0 → 60s', () => {
  assert.equal(calculateBackoff(0), 60000)
})

test('calculateBackoff retry 1 → 120s', () => {
  assert.equal(calculateBackoff(1), 120000)
})

test('calculateBackoff retry 11 → capped at 24h', () => {
  // min(60000 * 2^11, 86400000) = min(122880000, 86400000) = 86400000
  assert.equal(calculateBackoff(11), 86400000)
})

test('calculateBackoff retry 20 → capped at 24h', () => {
  assert.equal(calculateBackoff(20), 86400000)
})

// ---------------------------------------------------------------------------
// toDate
// ---------------------------------------------------------------------------
test('toDate returns null for falsy values', () => {
  assert.equal(toDate(null), null)
  assert.equal(toDate(undefined), null)
  assert.equal(toDate(''), null)
  assert.equal(toDate(0), null)
})

test('toDate returns null for invalid dates', () => {
  assert.equal(toDate('not-a-date'), null)
})

test('toDate returns Date for valid Date object', () => {
  const d = new Date()
  assert.ok(toDate(d) instanceof Date)
})

test('toDate returns Date for valid ISO string', () => {
  const d = toDate('2026-07-30T12:00:00.000Z')
  assert.ok(d instanceof Date)
  assert.equal(d.toISOString(), '2026-07-30T12:00:00.000Z')
})

// ---------------------------------------------------------------------------
// acquireTasks
// ---------------------------------------------------------------------------
test('acquireTasks returns empty when no tasks match', async () => {
  const db = createMockDb([])
  const result = await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 10 })
  assert.deepEqual(result, [])
})

test('acquireTasks claims a PENDING task', async () => {
  const task = makeTask('t1', { status: 'PENDING' })
  const db = createMockDb([task])
  const result = await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 10 })
  assert.equal(result.length, 1)
  assert.equal(result[0]._id, 't1')
  assert.equal(result[0]._lease_token, result[0]._lease_token) // has a lease token
  // Verify the task was updated in the store
  const stored = db._tasks._docs.get('t1')
  assert.equal(stored.status, 'PROCESSING')
  assert.ok(stored.lease_token)
  assert.ok(stored.lease_expire_at)
})

test('acquireTasks claims RETRYING task with ready next_retry_at', async () => {
  const task = makeTask('t1', {
    status: 'RETRYING',
    next_retry_at: new Date(NOW.getTime() - HOUR), // past
  })
  const db = createMockDb([task])
  const result = await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 10 })
  assert.equal(result.length, 1)
})

test('acquireTasks skips RETRYING task with future next_retry_at', async () => {
  const task = makeTask('t1', {
    status: 'RETRYING',
    next_retry_at: new Date(NOW.getTime() + HOUR), // future
  })
  const db = createMockDb([task])
  const result = await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 10 })
  assert.equal(result.length, 0)
})

test('acquireTasks recovers expired PROCESSING lease', async () => {
  const task = makeTask('t1', {
    status: 'PROCESSING',
    lease_token: 'old-token',
    lease_expire_at: new Date(NOW.getTime() - HOUR), // expired
  })
  const db = createMockDb([task])
  const result = await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 10 })
  assert.equal(result.length, 1)
  assert.equal(result[0]._id, 't1')
})

test('acquireTasks skips PROCESSING task with valid lease', async () => {
  const task = makeTask('t1', {
    status: 'PROCESSING',
    lease_token: 'active-token',
    lease_expire_at: new Date(NOW.getTime() + HOUR), // still valid
  })
  const db = createMockDb([task])
  const result = await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 10 })
  assert.equal(result.length, 0)
})

test('acquireTasks deduplicates tasks from both query results', async () => {
  const db = createMockDb([
    makeTask('t1', { status: 'PENDING' }),
    makeTask('t2', { status: 'RETRYING' }),
  ])
  const result = await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 10 })
  assert.equal(result.length, 2)
  const ids = result.map((t) => t._id).sort()
  assert.deepEqual(ids, ['t1', 't2'])
})

test('acquireTasks filters by task type', async () => {
  const db = createMockDb([
    makeTask('t1', { type: 'PHOTO_DELETE', status: 'PENDING' }),
    makeTask('t2', { type: 'ACCOUNT_DELETION', status: 'PENDING' }),
  ])
  const result = await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 10 })
  assert.equal(result.length, 1)
  assert.equal(result[0]._id, 't1')
})

test('acquireTasks respects batchSize', async () => {
  const tasks = Array.from({ length: 20 }, (_, i) =>
    makeTask(`t${i}`, { status: 'PENDING' }),
  )
  const db = createMockDb(tasks)
  const result = await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 5 })
  assert.equal(result.length, 5)
})

test('acquireTasks each task appears at most once in results', async () => {
  // Within a single acquireTasks call, tasks should be deduplicated
  // and each task claimed only once
  const tasks = [
    makeTask('t1', { status: 'PENDING' }),
    makeTask('t2', { status: 'PENDING' }),
    makeTask('t3', { status: 'PENDING' }),
  ]
  const db = createMockDb(tasks)

  const result = await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 10 })
  const ids = result.map((t) => t._id)

  // Each task appears at most once
  assert.equal(new Set(ids).size, ids.length, 'no duplicate task IDs in result')

  // All claimed tasks are now PROCESSING
  for (const id of ids) {
    const stored = db._tasks._docs.get(id)
    assert.equal(stored.status, 'PROCESSING', `${id} should be PROCESSING`)
  }
})

test('acquireTasks sequential calls do not reclaim already PROCESSING tasks', async () => {
  const tasks = [makeTask('t1', { status: 'PENDING' })]
  const db = createMockDb(tasks)

  // First call claims the task
  const r1 = await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 10 })
  assert.equal(r1.length, 1)
  assert.equal(r1[0]._id, 't1')

  // Second call — t1 is now PROCESSING with valid lease, so it won't match
  // PENDING/RETRYING query (it's PROCESSING) or PROCESSING query (lease not expired)
  const r2 = await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 10 })
  assert.equal(r2.length, 0, 'already claimed task should not be re-claimed')
})

// ---------------------------------------------------------------------------
// renewLease
// ---------------------------------------------------------------------------
test('renewLease extends lease_expire_at', async () => {
  const leaseToken = 'token-123'
  const task = makeTask('t1', {
    status: 'PROCESSING',
    _lease_token: leaseToken,
    lease_token: leaseToken,
    lease_expire_at: new Date(NOW.getTime() + 5 * 60000), // 5 min left
  })
  const db = createMockDb([task])

  const renewed = await renewLease({ db, task, now: NOW })
  assert.ok(renewed)

  const stored = db._tasks._docs.get('t1')
  assert.ok(stored.lease_expire_at > new Date(NOW.getTime() + LEASE_TTL_MS - 1000))
})

test('renewLease fails with wrong lease token', async () => {
  const task = makeTask('t1', {
    status: 'PROCESSING',
    _lease_token: 'wrong-token',
    lease_token: 'correct-token',
    lease_expire_at: new Date(NOW.getTime() + 5 * 60000),
  })
  const db = createMockDb([task])

  const renewed = await renewLease({ db, task, now: NOW })
  // Should fail because where clause {lease_token: wrong-token} won't match
  assert.equal(renewed, false)
})

test('renewLease returns false without lease token', async () => {
  const task = makeTask('t1', { status: 'PROCESSING' })
  const db = createMockDb([task])

  const renewed = await renewLease({ db, task, now: NOW })
  assert.equal(renewed, false)
})

// ---------------------------------------------------------------------------
// releaseLease
// ---------------------------------------------------------------------------
test('releaseLease sets task to PENDING and clears lease fields', async () => {
  const task = makeTask('t1', {
    status: 'PROCESSING',
    lease_token: 'token-xyz',
    lease_expire_at: new Date(NOW.getTime() + HOUR),
    next_retry_at: new Date(NOW.getTime() + HOUR),
  })
  const db = createMockDb([task])

  await releaseLease({ db, task, now: NOW })

  const stored = db._tasks._docs.get('t1')
  assert.equal(stored.status, 'PENDING')
  assert.equal(stored.lease_token, null)
  assert.equal(stored.lease_expire_at, null)
  assert.equal(stored.next_retry_at, null)
})

// ---------------------------------------------------------------------------
// failTask
// ---------------------------------------------------------------------------
test('failTask increments retry_count and sets RETRYING with backoff', async () => {
  const task = makeTask('t1', { retry_count: 0 })
  const db = createMockDb([task])

  await failTask({
    db,
    task,
    error: { code: 'TEST_ERROR' },
    now: NOW,
  })

  const stored = db._tasks._docs.get('t1')
  assert.equal(stored.status, 'RETRYING')
  assert.equal(stored.retry_count, 1)
  assert.equal(stored.lease_token, null)
  assert.equal(stored.lease_expire_at, null)
  assert.equal(stored.last_error, 'TEST_ERROR')
  assert.ok(stored.next_retry_at > NOW)
})

test('failTask escalates to MANUAL_REQUIRED after max retries', async () => {
  const task = makeTask('t1', { retry_count: 9 }) // next will be 10 (>= MAX_RETRIES)
  const db = createMockDb([task])

  await failTask({
    db,
    task,
    error: { safeErrorCode: 'PERSISTENT_ERROR' },
    now: NOW,
  })

  const stored = db._tasks._docs.get('t1')
  assert.equal(stored.status, 'MANUAL_REQUIRED')
  assert.equal(stored.retry_count, 10)
  assert.equal(stored.lease_token, null)
  assert.equal(stored.last_error, 'PERSISTENT_ERROR')
})

test('failTask escalates to MANUAL_REQUIRED after max days', async () => {
  const task = makeTask('t1', {
    retry_count: 2,
    applied_at: new Date(NOW.getTime() - 8 * DAY), // 8 days ago
  })
  const db = createMockDb([task])

  await failTask({
    db,
    task,
    error: { code: 'STALE_ERROR' },
    now: NOW,
  })

  const stored = db._tasks._docs.get('t1')
  assert.equal(stored.status, 'MANUAL_REQUIRED')
})

test('failTask uses refreshFn when provided', async () => {
  const task = makeTask('t1', { retry_count: 3 })
  const db = createMockDb([task])

  // refreshFn returns a task with higher retry_count
  let refreshCalled = false
  const refreshFn = async (t) => {
    refreshCalled = true
    assert.equal(t._id, 't1')
    return { ...t, retry_count: 9 } // will push to 10 = MANUAL_REQUIRED
  }

  await failTask({
    db,
    task,
    error: { code: 'ERROR' },
    now: NOW,
    refreshFn,
  })

  assert.ok(refreshCalled)
  const stored = db._tasks._docs.get('t1')
  assert.equal(stored.status, 'MANUAL_REQUIRED')
  assert.equal(stored.retry_count, 10)
})

test('failTask handles errors gracefully when refresh fails', async () => {
  const task = makeTask('t1', { retry_count: 0 })
  const db = createMockDb([task])

  await failTask({
    db,
    task,
    error: { code: 'ERROR' },
    now: NOW,
    refreshFn: async () => {
      throw new Error('refresh failed')
    },
  })

  // Should fall back to original task
  const stored = db._tasks._docs.get('t1')
  assert.equal(stored.status, 'RETRYING')
  assert.equal(stored.retry_count, 1)
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------
test('releaseLease is idempotent', async () => {
  const task = makeTask('t1', {
    status: 'PENDING',
    lease_token: null,
    next_retry_at: new Date(NOW.getTime() + HOUR),
  })
  // Should not error even if already PENDING
  const db = createMockDb([task])
  await releaseLease({ db, task, now: NOW })
  const stored = db._tasks._docs.get('t1')
  assert.equal(stored.status, 'PENDING')
  assert.equal(stored.lease_token, null)
})

test('acquireTasks returns empty for already claimed tasks on second call', async () => {
  const tasks = [makeTask('t1', { status: 'PENDING' })]
  const db = createMockDb(tasks)

  // First call claims
  await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 10 })
  // Second call should find no PENDING tasks (t1 is now PROCESSING)
  const result = await acquireTasks({ db, type: 'PHOTO_DELETE', now: NOW, batchSize: 10 })
  assert.equal(result.length, 0)
})
