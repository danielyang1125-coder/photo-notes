'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createCountCorrector,
  CHECKPOINT_ID_PHOTOS,
  CHECKPOINT_ID_TAGS,
  CHECKPOINT_OWNER,
  CHECKPOINT_TASK_KEY_PHOTOS,
  CHECKPOINT_TASK_KEY_TAGS,
  PHOTO_TAG_MAX,
} = require('../../cloudfunctions/cleanup/count-corrector')

// ---------------------------------------------------------------------------
// Mock DB factory (reuses same pattern as orphan-cleaner test)
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
                resolved[k] = (item[k] || 0) + v._inc
              } else {
                resolved[k] = v
              }
            }
            docs().set(id, { ...item, ...resolved })
          },
          async set({ data }) {
            const existing = docs().get(id)
            if (existing) {
              const merged = { ...existing }
              for (const [k, v] of Object.entries(data)) {
                if (isCommand(v) && '_inc' in v) {
                  merged[k] = (existing[k] || 0) + v._inc
                } else {
                  merged[k] = v
                }
              }
              docs().set(id, merged)
            } else {
              docs().set(id, { _id: id, ...data })
            }
          },
        }
      },
      async add({ data }) {
        const id = data._id || `auto-${nextId++}`
        docs().set(id, { _id: id, ...data })
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

function activePhoto(id, overrides = {}) {
  return {
    _id: id,
    _openid: 'u1',
    status: 'ACTIVE',
    tag_count: 0,
    upload_time: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function tagDoc(id, overrides = {}) {
  return {
    _id: id,
    _openid: 'u1',
    name: `tag-${id}`,
    photo_count: 0,
    last_used_at: '2024-01-01T00:00:00.000Z',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function photoTag(id, photoId, tagId, overrides = {}) {
  return {
    _id: id,
    _openid: 'u1',
    photo_id: photoId,
    tag_id: tagId,
    photo_upload_time: '2024-01-01T00:00:00.000Z',
    created_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function createCorrector(db) {
  return createCountCorrector({ db })
}

// =========================================================================
// Photo tag_count correction tests
// =========================================================================

test('count corrector — photo.tag_count correct: no correction', async () => {
  const db = createMockDb({
    photos: [activePhoto('p1', { tag_count: 2 })],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
      photoTag('pt2', 'p1', 't2'),
    ],
    tags: [tagDoc('t1'), tagDoc('t2')],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true })

  assert.equal(result.photos.scanned, 1)
  assert.equal(result.photos.corrected, 0)
  assert.equal(result.photos.completed, true)
})

test('count corrector — photo.tag_count higher than actual: corrected down', async () => {
  const db = createMockDb({
    photos: [activePhoto('p1', { tag_count: 5 })],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'), // only 2 actual relations
      photoTag('pt2', 'p1', 't2'),
    ],
    tags: [tagDoc('t1'), tagDoc('t2')],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true })

  assert.equal(result.photos.scanned, 1)
  assert.equal(result.photos.corrected, 1)
})

test('count corrector — photo.tag_count lower than actual: corrected up', async () => {
  const db = createMockDb({
    photos: [activePhoto('p1', { tag_count: 0 })],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
      photoTag('pt2', 'p1', 't2'),
      photoTag('pt3', 'p1', 't3'),
    ],
    tags: [tagDoc('t1'), tagDoc('t2'), tagDoc('t3')],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true })

  assert.equal(result.photos.scanned, 1)
  assert.equal(result.photos.corrected, 1)
})

test('count corrector — photo.tag_count clamped to 5 even if actual > 5', async () => {
  const db = createMockDb({
    photos: [activePhoto('p1', { tag_count: 0 })],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
      photoTag('pt2', 'p1', 't2'),
      photoTag('pt3', 'p1', 't3'),
      photoTag('pt4', 'p1', 't4'),
      photoTag('pt5', 'p1', 't5'),
      photoTag('pt6', 'p1', 't6'), // 6th relation (shouldn't happen, but counts as actual)
    ],
    tags: [
      tagDoc('t1'), tagDoc('t2'), tagDoc('t3'),
      tagDoc('t4'), tagDoc('t5'), tagDoc('t6'),
    ],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true })

  // Actual count is 6, clamped to 5. tag_count is 0. So correction needed.
  assert.equal(result.photos.corrected, 1)
})

test('count corrector — photo.tag_count negative clamped to 0', async () => {
  const db = createMockDb({
    photos: [activePhoto('p1', { tag_count: -3 })],
    photo_tags: [],
    tags: [],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true })

  assert.equal(result.photos.scanned, 1)
  assert.equal(result.photos.corrected, 1)
})

test('count corrector — photo apply mode actually updates the document', async () => {
  const db = createMockDb({
    photos: [activePhoto('p1', { tag_count: 0 })],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
      photoTag('pt2', 'p1', 't2'),
    ],
    tags: [tagDoc('t1'), tagDoc('t2')],
  })

  const corrector = createCorrector(db)
  await corrector.run({ dryRun: false })

  const store = db.inspect()
  assert.equal(store.photos.get('p1').tag_count, 2)
})

test('count corrector — photo dry-run does not update', async () => {
  const db = createMockDb({
    photos: [activePhoto('p1', { tag_count: 0 })],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
      photoTag('pt2', 'p1', 't2'),
    ],
    tags: [tagDoc('t1'), tagDoc('t2')],
  })

  const corrector = createCorrector(db)
  await corrector.run({ dryRun: true })

  const store = db.inspect()
  assert.equal(store.photos.get('p1').tag_count, 0) // unchanged
})

test('count corrector — only ACTIVE photos are scanned', async () => {
  const db = createMockDb({
    photos: [
      activePhoto('p1', { tag_count: 0 }),
      { ...activePhoto('p2', { tag_count: 0 }), status: 'DELETING' },
    ],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
      photoTag('pt2', 'p2', 't1'), // relation to DELETING photo
    ],
    tags: [tagDoc('t1')],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true })

  // Only p1 (ACTIVE) should be scanned
  assert.equal(result.photos.scanned, 1)
})

// =========================================================================
// Tag photo_count correction tests
// =========================================================================

test('count corrector — tag.photo_count correct: no correction', async () => {
  const db = createMockDb({
    tags: [tagDoc('t1', { photo_count: 2 })],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
      photoTag('pt2', 'p2', 't1'),
    ],
    photos: [activePhoto('p1'), activePhoto('p2')],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true })

  assert.equal(result.tags.scanned, 1)
  assert.equal(result.tags.corrected, 0)
  assert.equal(result.tags.completed, true)
})

test('count corrector — tag.photo_count incorrect: corrected', async () => {
  const db = createMockDb({
    tags: [tagDoc('t1', { photo_count: 99 })],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
    ],
    photos: [activePhoto('p1')],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true })

  assert.equal(result.tags.scanned, 1)
  assert.equal(result.tags.corrected, 1)
})

test('count corrector — tag.photo_count negative clamped to 0', async () => {
  const db = createMockDb({
    tags: [tagDoc('t1', { photo_count: -5 })],
    photo_tags: [],
    photos: [],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true })

  assert.equal(result.tags.scanned, 1)
  assert.equal(result.tags.corrected, 1)
})

test('count corrector — tag apply mode actually updates', async () => {
  const db = createMockDb({
    tags: [tagDoc('t1', { photo_count: 10 })],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
      photoTag('pt2', 'p2', 't1'),
    ],
    photos: [activePhoto('p1'), activePhoto('p2')],
  })

  const corrector = createCorrector(db)
  await corrector.run({ dryRun: false })

  const store = db.inspect()
  assert.equal(store.tags.get('t1').photo_count, 2)
})

test('count corrector — tag dry-run does not update', async () => {
  const db = createMockDb({
    tags: [tagDoc('t1', { photo_count: 10 })],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
    ],
    photos: [activePhoto('p1')],
  })

  const corrector = createCorrector(db)
  await corrector.run({ dryRun: true })

  const store = db.inspect()
  assert.equal(store.tags.get('t1').photo_count, 10) // unchanged
})

// =========================================================================
// Batch / cursor / resumption tests
// =========================================================================

test('count corrector — both phases run independently', async () => {
  // Photo has wrong tag_count, tag has wrong photo_count
  const db = createMockDb({
    photos: [activePhoto('p1', { tag_count: 0 })],
    tags: [tagDoc('t1', { photo_count: 0 })],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
    ],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true })

  assert.equal(result.photos.corrected, 1) // tag_count 0→1
  assert.equal(result.tags.corrected, 1)   // photo_count 0→1
})

test('count corrector — persists cursor for resumption (photos phase)', async () => {
  const db = createMockDb({
    photos: [
      activePhoto('p1', { tag_count: 0 }),
      activePhoto('p2', { tag_count: 0 }),
      activePhoto('p3', { tag_count: 0 }),
    ],
    tags: [tagDoc('t1')],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
      photoTag('pt2', 'p2', 't1'),
      photoTag('pt3', 'p3', 't1'),
    ],
    deletion_tasks: [{
      _id: CHECKPOINT_ID_PHOTOS,
      _openid: CHECKPOINT_OWNER,
      type: 'COUNT_CORRECTOR',
      task_key: CHECKPOINT_TASK_KEY_PHOTOS,
      status: 'PENDING',
      cursors: { photos: 'p1' }, // p0 & p1 already processed in previous run
      completed: false,
    }],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true, batchSize: 2 })

  // Should only scan p2 and p3 (p0 and p1 already past the cursor)
  assert.equal(result.photos.scanned, 2)
})

test('count corrector — persists cursor for resumption (tags phase)', async () => {
  const db = createMockDb({
    tags: [
      tagDoc('t1', { photo_count: 0 }),
      tagDoc('t2', { photo_count: 0 }),
      tagDoc('t3', { photo_count: 0 }),
    ],
    photos: [activePhoto('p1'), activePhoto('p2'), activePhoto('p3')],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
      photoTag('pt2', 'p2', 't2'),
      photoTag('pt3', 'p3', 't3'),
    ],
    deletion_tasks: [{
      _id: CHECKPOINT_ID_TAGS,
      _openid: CHECKPOINT_OWNER,
      type: 'COUNT_CORRECTOR',
      task_key: CHECKPOINT_TASK_KEY_TAGS,
      status: 'PENDING',
      cursors: { tags: 't1' },
      completed: false,
    }],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true, batchSize: 2 })

  assert.equal(result.tags.scanned, 2) // t2 and t3
})

test('count corrector — completes and resets for fresh run', async () => {
  const db = createMockDb({
    photos: [activePhoto('p1', { tag_count: 1 })],
    tags: [tagDoc('t1', { photo_count: 1 })],
    photo_tags: [photoTag('pt1', 'p1', 't1')],
  })

  const corrector = createCorrector(db)
  const r1 = await corrector.run({ dryRun: true })

  assert.equal(r1.photos.completed, true)
  assert.equal(r1.tags.completed, true)

  // Second run should scan afresh (completed checkpoints reset)
  const r2 = await corrector.run({ dryRun: true })
  assert.equal(r2.photos.scanned, 1)
  assert.equal(r2.tags.scanned, 1)
})

test('count corrector — rounds limit stops early', async () => {
  const db = createMockDb({
    photos: [
      activePhoto('p0', { tag_count: 0 }),
      activePhoto('p1', { tag_count: 0 }),
      activePhoto('p2', { tag_count: 0 }),
      activePhoto('p3', { tag_count: 0 }),
      activePhoto('p4', { tag_count: 0 }),
    ],
    tags: [],
    photo_tags: [],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true, batchSize: 2, maxRounds: 2 })

  assert.equal(result.photos.scanned, 4) // 2 rounds * 2 batch
  assert.equal(result.photos.completed, false)
  assert.equal(result.photos.rounds, 2)
})

test('count corrector — rejects invalid parameters', async () => {
  const db = createMockDb({})
  const corrector = createCorrector(db)

  await assert.rejects(() => corrector.run({ batchSize: 0 }), TypeError)
  await assert.rejects(() => corrector.run({ batchSize: 201 }), TypeError)
  await assert.rejects(() => corrector.run({ maxRounds: 0 }), TypeError)
  await assert.rejects(() => corrector.run({ maxRounds: 51 }), TypeError)
})

test('count corrector — mixed correct and incorrect in batch', async () => {
  const db = createMockDb({
    photos: [
      activePhoto('p1', { tag_count: 2 }), // correct
      activePhoto('p2', { tag_count: 0 }), // incorrect (should be 2)
    ],
    tags: [tagDoc('t1'), tagDoc('t2')],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
      photoTag('pt2', 'p1', 't2'),
      photoTag('pt3', 'p2', 't1'),
      photoTag('pt4', 'p2', 't2'),
    ],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: true })

  assert.equal(result.photos.scanned, 2)
  assert.equal(result.photos.corrected, 1) // only p2 needs fixing
})

test('count corrector — handles missing tag_count field (undefined)', async () => {
  const db = createMockDb({
    photos: [{
      _id: 'p1',
      _openid: 'u1',
      status: 'ACTIVE',
      upload_time: '2024-01-01T00:00:00.000Z',
      // tag_count intentionally missing
    }],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
      photoTag('pt2', 'p1', 't2'),
    ],
    tags: [tagDoc('t1'), tagDoc('t2')],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: false })

  assert.equal(result.photos.corrected, 1) // undefined → 2
  assert.equal(db.inspect().photos.get('p1').tag_count, 2)
})

test('count corrector — handles missing photo_count field (undefined)', async () => {
  const db = createMockDb({
    tags: [{
      _id: 't1',
      _openid: 'u1',
      name: 'test-tag',
      // photo_count intentionally missing
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    }],
    photo_tags: [
      photoTag('pt1', 'p1', 't1'),
      photoTag('pt2', 'p2', 't1'),
    ],
    photos: [activePhoto('p1'), activePhoto('p2')],
  })

  const corrector = createCorrector(db)
  const result = await corrector.run({ dryRun: false })

  assert.equal(result.tags.corrected, 1) // undefined → 2
  assert.equal(db.inspect().tags.get('t1').photo_count, 2)
})
