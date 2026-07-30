'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createOrphanCleaner,
  CHECKPOINT_ID,
  CHECKPOINT_OWNER,
  CHECKPOINT_TASK_KEY,
} = require('../../cloudfunctions/cleanup/orphan-cleaner')

// ---------------------------------------------------------------------------
// Mock DB factory (lightweight — only what orphan-cleaner uses)
// ---------------------------------------------------------------------------

function isCommand(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    !(value instanceof Date)
}

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
  if (query._and) {
    return (Array.isArray(query._and) ? query._and : [query._and])
      .every((sub) => matchItem(item, sub))
  }
  if (query._or) {
    return (Array.isArray(query._or) ? query._or : [query._or])
      .some((sub) => matchItem(item, sub))
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

function createMockDb(seed = {}) {
  const store = {
    photos: new Map((seed.photos || []).map((p) => [p._id, { ...p }])),
    tags: new Map((seed.tags || []).map((t) => [t._id, { ...t }])),
    photo_tags: new Map((seed.photo_tags || []).map((r) => [r._id, { ...r }])),
    deletion_tasks: new Map(
      (seed.deletion_tasks || []).map((d) => [d._id, { ...d }]),
    ),
  }

  let nextId = 1000

  const _command = {
    gt: (v) => ({ _gt: v }),
    lt: (v) => ({ _lt: v }),
    lte: (v) => ({ _lte: v }),
    gte: (v) => ({ _gte: v }),
    eq: (v) => ({ _eq: v }),
    neq: (v) => ({ _neq: v }),
    in: (arr) => ({ _in: arr }),
    inc: (v) => ({ _inc: v }),
    and: (...args) => {
      const arr = args.length === 1 && Array.isArray(args[0]) ? args[0] : args
      return { _and: arr }
    },
  }

  function collectionApi(name) {
    function docs() {
      return store[name]
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
          async count() {
            return { total: filtered(_query).length }
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
                resolved[k] = Math.max(0, (item[k] || 0) + v._inc)
              } else {
                resolved[k] = v
              }
            }
            docs().set(id, { ...item, ...resolved })
          },
          async remove() {
            docs().delete(id)
          },
          async set({ data }) {
            const existing = docs().get(id)
            if (existing) {
              // Merge update
              const merged = {}
              for (const [k, v] of Object.entries(data)) {
                if (isCommand(v) && '_inc' in v) {
                  merged[k] = Math.max(0, (existing[k] || 0) + v._inc)
                } else {
                  merged[k] = v
                }
              }
              docs().set(id, { ...existing, ...merged })
            } else {
              docs().set(id, { _id: id, ...data })
            }
          },
        }
      },
      async add({ data }) {
        const id = data._id || `auto-${nextId++}`
        const doc = { _id: id, ...data }
        docs().set(id, doc)
        return { _id: id }
      },
    }
  }

  return {
    collection(name) {
      return collectionApi(name)
    },
    command: _command,
    serverDate() {
      return new Date()
    },
    inspect() {
      return store
    },
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const USR = { _id: 'u1', _openid: 'u1', status: 'ACTIVE' }

function activePhoto(id, overrides = {}) {
  return {
    _id: id,
    _openid: 'u1',
    status: 'ACTIVE',
    upload_time: '2024-06-15T12:00:00.000Z',
    tag_count: 0,
    ...overrides,
  }
}

function deletingPhoto(id, overrides = {}) {
  return {
    _id: id,
    _openid: 'u1',
    status: 'DELETING',
    upload_time: '2024-06-15T12:00:00.000Z',
    tag_count: 0,
    ...overrides,
  }
}

function tagDoc(id, overrides = {}) {
  return {
    _id: id,
    _openid: 'u1',
    name: `tag-${id}`,
    photo_count: 0,
    last_used_at: '2024-06-15T12:00:00.000Z',
    created_at: '2024-06-15T12:00:00.000Z',
    updated_at: '2024-06-15T12:00:00.000Z',
    ...overrides,
  }
}

function photoTag(id, photoId, tagId, overrides = {}) {
  return {
    _id: id,
    _openid: 'u1',
    photo_id: photoId,
    tag_id: tagId,
    photo_upload_time: '2024-06-15T12:00:00.000Z',
    created_at: '2024-06-15T12:00:00.000Z',
    ...overrides,
  }
}

function createCleaner(db) {
  return createOrphanCleaner({ db })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('orphan cleaner — no orphans: scanned all, orphaned 0', async () => {
  const db = createMockDb({
    photos: [activePhoto('p1')],
    tags: [tagDoc('t1')],
    photo_tags: [photoTag('pt1', 'p1', 't1')],
  })

  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: true })

  assert.equal(result.scanned, 1)
  assert.equal(result.orphaned, 0)
  assert.equal(result.deleted, 0)
  assert.equal(result.completed, true)
})

test('orphan cleaner — DELETING photo relation is orphaned', async () => {
  const db = createMockDb({
    photos: [deletingPhoto('p1')],
    tags: [tagDoc('t1')],
    photo_tags: [photoTag('pt1', 'p1', 't1')],
  })

  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: true })

  assert.equal(result.scanned, 1)
  assert.equal(result.orphaned, 1)
  assert.equal(result.deleted, 0) // dry-run
})

test('orphan cleaner — non-existent photo relation is orphaned', async () => {
  const db = createMockDb({
    photos: [],
    tags: [tagDoc('t1')],
    photo_tags: [photoTag('pt1', 'p-missing', 't1')],
  })

  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: true })

  assert.equal(result.scanned, 1)
  assert.equal(result.orphaned, 1)
})

test('orphan cleaner — non-existent tag relation is orphaned', async () => {
  const db = createMockDb({
    photos: [activePhoto('p1')],
    tags: [],
    photo_tags: [photoTag('pt1', 'p1', 't-missing')],
  })

  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: true })

  assert.equal(result.scanned, 1)
  assert.equal(result.orphaned, 1)
})

test('orphan cleaner — only within same _openid (cross-user isolation)', async () => {
  const otherUser = 'u2'
  const db = createMockDb({
    photos: [activePhoto('p1'), { ...activePhoto('p2'), _openid: otherUser }],
    tags: [tagDoc('t1'), { ...tagDoc('t2'), _openid: otherUser }],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),                     // u1 — valid
      { ...photoTag('pt2', 'p2', 't2'), _openid: otherUser }, // u2 — valid
    ],
  })

  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: true })

  // Both relations reference ACTIVE photos and existing tags in their own _openid
  assert.equal(result.orphaned, 0)
})

test('orphan cleaner — cross-user: u1 relation to u2 photo is orphaned', async () => {
  const otherUser = 'u2'
  const db = createMockDb({
    photos: [
      // Photo p2 belongs to u2 only — u1 should NOT see it as ACTIVE
      { ...activePhoto('p2'), _openid: otherUser },
    ],
    tags: [tagDoc('t1')], // u1's tag
    photo_tags: [
      photoTag('pt1', 'p2', 't1'), // u1's relation to u2's photo → orphaned
    ],
  })

  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: true })

  assert.equal(result.orphaned, 1)
})

test('orphan cleaner — dry-run does not delete data', async () => {
  const db = createMockDb({
    photos: [],
    tags: [tagDoc('t1', { photo_count: 5 })],
    photo_tags: [photoTag('pt1', 'p-missing', 't1')],
  })

  const cleaner = createCleaner(db)
  await cleaner.run({ dryRun: true })

  // Verify photo_tags still exists
  const store = db.inspect()
  assert.equal(store.photo_tags.has('pt1'), true)
  // Verify tag.photo_count unchanged
  assert.equal(store.tags.get('t1').photo_count, 5)
})

test('orphan cleaner — apply mode deletes orphaned relations', async () => {
  const db = createMockDb({
    photos: [activePhoto('p-keep')],
    tags: [tagDoc('t1', { photo_count: 3 })],
    photo_tags: [
      photoTag('pt1', 'p-missing', 't1'),  // orphaned (photo missing)
      photoTag('pt2', 'p-keep', 't1'),      // valid
    ],
  })

  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: false })

  assert.equal(result.orphaned, 1)
  assert.equal(result.deleted, 1)

  const store = db.inspect()
  assert.equal(store.photo_tags.has('pt1'), false) // deleted
  assert.equal(store.photo_tags.has('pt2'), true)  // kept
})

test('orphan cleaner — apply decrements tag.photo_count (non-negative)', async () => {
  const db = createMockDb({
    photos: [],
    tags: [tagDoc('t1', { photo_count: 3 })],
    photo_tags: [
      photoTag('pt1', 'p-gone1', 't1'),
      photoTag('pt2', 'p-gone2', 't1'),
    ],
  })

  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: false })

  assert.equal(result.orphaned, 2)
  assert.equal(result.deleted, 2)

  // tag.photo_count should be decremented by 2 (3 - 2 = 1).
  // Note: our mock clamps _inc at 0 floor, not the caller.
  const store = db.inspect()
  assert.equal(store.tags.get('t1').photo_count, 1)
})

test('orphan cleaner — cursor advances correctly across batches', async () => {
  // Create 5 photo_tags, all orphaned (photos missing), batchSize=2
  const relations = []
  for (let i = 0; i < 5; i++) {
    relations.push(photoTag(`pt${i}`, `p-missing-${i}`, 't1'))
  }
  const db = createMockDb({
    photos: [],
    tags: [tagDoc('t1')],
    photo_tags: relations,
  })

  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: true, batchSize: 2, maxRounds: 10 })

  assert.equal(result.scanned, 5)
  assert.equal(result.orphaned, 5)
  assert.equal(result.completed, true)
  assert.ok(result.rounds >= 3) // At least 3 rounds: 2+2+1
})

test('orphan cleaner — resumes from checkpoint mid-scan', async () => {
  // Simulate: first run processes 2 of 5 items, then "stops".
  // Create a checkpoint with cursor at pt1 (after first 2 items)
  const relations = []
  for (let i = 0; i < 5; i++) {
    relations.push(photoTag(`pt${i}`, `p-missing-${i}`, 't1'))
  }
  const db = createMockDb({
    photos: [],
    tags: [tagDoc('t1')],
    photo_tags: relations,
    deletion_tasks: [{
      _id: CHECKPOINT_ID,
      _openid: CHECKPOINT_OWNER,
      type: 'ORPHAN_CLEANER',
      task_key: CHECKPOINT_TASK_KEY,
      status: 'PENDING',
      cursors: { photo_tags: 'pt1' }, // processed pt0 and pt1
      completed: false,
    }],
  })

  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: true, batchSize: 2 })

  // Should scan remaining 3 (pt2, pt3, pt4)
  assert.equal(result.scanned, 3)
  assert.equal(result.orphaned, 3)
  assert.equal(result.completed, true)
})

test('orphan cleaner — completes and resets cursor for fresh scan', async () => {
  const db = createMockDb({
    photos: [activePhoto('p1')],
    tags: [tagDoc('t1')],
    photo_tags: [photoTag('pt1', 'p1', 't1')],
  })

  const cleaner = createCleaner(db)
  const r1 = await cleaner.run({ dryRun: true })
  assert.equal(r1.completed, true)

  // Second run: should start fresh (cursor reset because completed=true)
  const r2 = await cleaner.run({ dryRun: true })
  assert.equal(r2.scanned, 1) // scans all again
  assert.equal(r2.completed, true)

  // Checkpoint should be marked completed again
  const store = db.inspect()
  const cp = store.deletion_tasks.get(CHECKPOINT_ID)
  assert.equal(cp.completed, true)
})

test('orphan cleaner — rounds limit stops early', async () => {
  const relations = []
  for (let i = 0; i < 10; i++) {
    relations.push(photoTag(`pt${i}`, `p-missing-${i}`, 't1'))
  }
  const db = createMockDb({
    photos: [],
    tags: [tagDoc('t1')],
    photo_tags: relations,
  })

  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: true, batchSize: 2, maxRounds: 3 })

  // 3 rounds * 2 items = 6 scanned
  assert.equal(result.scanned, 6)
  assert.equal(result.completed, false)
  assert.equal(result.rounds, 3)
})

test('orphan cleaner — tag already deleted: skip decrement gracefully', async () => {
  // Orphan relation referencing a tag that doesn't exist (not in tags store)
  const db = createMockDb({
    photos: [activePhoto('p1')],
    tags: [], // t-missing is not here
    photo_tags: [photoTag('pt1', 'p1', 't-missing')],
  })

  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: false })

  assert.equal(result.orphaned, 1)
  assert.equal(result.deleted, 1)

  // Should not have thrown. The tag is missing, so tag photo_count decrement
  // is skipped (nothing to decrement).
  const store = db.inspect()
  assert.equal(store.photo_tags.has('pt1'), false)
})

test('orphan cleaner — mixed valid and orphan in single batch', async () => {
  const db = createMockDb({
    photos: [activePhoto('p1'), deletingPhoto('p2')],
    tags: [tagDoc('t1', { photo_count: 2 }), tagDoc('t2')],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),       // valid: ACTIVE photo + existing tag
      photoTag('pt2', 'p2', 't1'),       // orphaned: DELETING photo
      photoTag('pt3', 'p-missing', 't1'), // orphaned: photo doesn't exist
      photoTag('pt4', 'p1', 't-missing'), // orphaned: tag doesn't exist
    ],
  })

  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: false })

  assert.equal(result.scanned, 4)
  assert.equal(result.orphaned, 3) // pt2, pt3, pt4 are orphaned
  assert.equal(result.deleted, 3)
})

test('orphan cleaner — empty collection completes immediately', async () => {
  const db = createMockDb({})
  const cleaner = createCleaner(db)
  const result = await cleaner.run({ dryRun: true })

  assert.equal(result.scanned, 0)
  assert.equal(result.orphaned, 0)
  assert.equal(result.completed, true)
  assert.equal(result.rounds, 1)
})

test('orphan cleaner — rejects invalid batch size', async () => {
  const db = createMockDb({})
  const cleaner = createCleaner(db)

  await assert.rejects(
    () => cleaner.run({ batchSize: 0 }),
    TypeError,
  )
  await assert.rejects(
    () => cleaner.run({ batchSize: 201 }),
    TypeError,
  )
})

test('orphan cleaner — rejects invalid max rounds', async () => {
  const db = createMockDb({})
  const cleaner = createCleaner(db)

  await assert.rejects(
    () => cleaner.run({ maxRounds: 0 }),
    TypeError,
  )
  await assert.rejects(
    () => cleaner.run({ maxRounds: 51 }),
    TypeError,
  )
})
