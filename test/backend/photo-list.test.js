'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createPhotoHandlers,
  MAX_PAGE_SIZE,
  TAG_MAX_SCAN_MULTIPLIER,
} = require('../../cloudfunctions/photo/handlers')

const TEST_SECRET = 'test-cursor-hmac-secret-at-least-32-chars!!'

// ---------------------------------------------------------------------------
// In-memory DB mock that handles the query patterns used by photo handlers
// ---------------------------------------------------------------------------

function isCommand(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function matchItem(item, query) {
  if (!query || typeof query !== 'object') return true

  // _.and([...])
  if (Array.isArray(query._and)) {
    return query._and.every((sub) => matchItem(item, sub))
  }

  // _.or([...])
  if (Array.isArray(query._or)) {
    return query._or.some((sub) => matchItem(item, sub))
  }

  // Per-field matching
  return Object.entries(query).every(([key, cond]) => {
    if (key === '_and' || key === '_or') return true // handled above
    const itemValue = item[key]

    // Simple equality (non-command value)
    if (!isCommand(cond)) return itemValue === cond

    // _.in
    if (Array.isArray(cond._in)) return cond._in.includes(itemValue)

    // _.lt / _.gt / _.eq
    if ('_lt' in cond) return itemValue < cond._lt
    if ('_gt' in cond) return itemValue > cond._gt
    if ('_eq' in cond) return itemValue === cond._eq

    // Nested command object — fall back to equality
    return itemValue === cond
  })
}

function compareValues(a, b) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function createPhotoListDb(seed = {}) {
  const stores = {
    photos: new Map((seed.photos || []).map((p) => [p._id, { ...p }])),
    photo_tags: new Map(
      (seed.photo_tags || []).map((r) => [r._id, { ...r }]),
    ),
    tags: new Map((seed.tags || []).map((t) => [t._id, { ...t }])),
    notes: new Map((seed.notes || []).map((n) => [n._id, { ...n }])),
  }

  function collectionApi(name) {
    const docs = stores[name]
    let _where = null
    let _orders = []

    function filtered() {
      let items = [...docs.values()]
      if (_where) {
        items = items.filter((item) => matchItem(item, _where))
      }
      // Sort
      if (_orders.length > 0) {
        items.sort((a, b) => {
          for (const [field, dir] of _orders) {
            const cmp = compareValues(a[field], b[field])
            if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
          }
          return 0
        })
      }
      return items
    }

    return {
      where(query) {
        _where = query
        return this
      },
      orderBy(field, dir) {
        _orders.push([field, dir])
        return this
      },
      limit(n) {
        return {
          async get() {
            const items = filtered()
            return { data: items.slice(0, n).map((i) => ({ ...i })) }
          },
        }
      },
      async get() {
        return { data: filtered().map((i) => ({ ...i })) }
      },
    }
  }

  function docApi(name) {
    const docs = stores[name]
    return (id) => ({
      async update({ data }) {
        const item = docs.get(id)
        if (!item) throw new Error('missing test document')
        // serverDate() simulation
        const merged = { ...item }
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && v._serverDate) {
            merged[k] = new Date().toISOString()
          } else {
            merged[k] = v
          }
        }
        docs.set(id, merged)
      },
      async get() {
        const item = docs.get(id)
        return { data: item ? { ...item } : null }
      },
    })
  }

  const _command = {
    and: (arr) => ({ _and: arr }),
    or: (arr) => ({ _or: arr }),
    lt: (v) => ({ _lt: v }),
    gt: (v) => ({ _gt: v }),
    eq: (v) => ({ _eq: v }),
    in: (arr) => ({ _in: arr }),
  }

  return {
    collection(name) {
      if (!stores[name]) throw new Error(`unknown collection: ${name}`)
      return collectionApi(name)
    },
    doc: docApi,
    command: _command,
    // Direct access for seeding / assertions
    _stores: stores,
  }
}

// ---------------------------------------------------------------------------
// URL helper
// ---------------------------------------------------------------------------
function createGetTempFileURL(behavior = 'success') {
  return async (fileIds) => {
    if (behavior === 'fail') throw new Error('network error')
    const fileList = fileIds.map((fid) => ({
      fileID: fid,
      tempFileURL:
        behavior === 'empty_urls'
          ? ''
          : `https://example.com/temp/${encodeURIComponent(fid)}`,
    }))
    return { fileList }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeHandlers(db, opts = {}) {
  return createPhotoHandlers({
    db,
    getTempFileURL: opts.getTempFileURL || createGetTempFileURL(),
    cursorSecret: TEST_SECRET,
    clock: opts.clock || Date,
  })
}

function iso(offsetMinutes = 0) {
  const d = new Date(Date.now() + offsetMinutes * 60000)
  return d.toISOString()
}

// ---------------------------------------------------------------------------
// ALL scope
// ---------------------------------------------------------------------------
test('ALL list returns ACTIVE photos ordered by upload_time desc, _id desc', async () => {
  const db = createPhotoListDb({
    photos: [
      { _id: 'p1', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-03-01T00:00:00.000Z', file_id: 'f1', width: 100, height: 200, shoot_time: '2024-03-01T00:00:00.000Z', time_source: 'UPLOAD_TIME', tag_count: 0 },
      { _id: 'p2', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-03-02T00:00:00.000Z', file_id: 'f2', width: 200, height: 300, shoot_time: '2024-03-02T00:00:00.000Z', time_source: 'EXIF', tag_count: 1 },
      { _id: 'p3', _openid: 'u1', status: 'DELETING', upload_time: '2024-03-03T00:00:00.000Z', file_id: 'f3', width: 300, height: 400, shoot_time: '2024-03-03T00:00:00.000Z', time_source: 'UPLOAD_TIME', tag_count: 0 },
      { _id: 'p4', _openid: 'u2', status: 'ACTIVE', upload_time: '2024-03-04T00:00:00.000Z', file_id: 'f4', width: 400, height: 500, shoot_time: '2024-03-04T00:00:00.000Z', time_source: 'EXIF', tag_count: 2 },
    ],
  })

  const { list } = makeHandlers(db)
  const result = await list('u1', { scope: 'ALL', pageSize: 20 })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.list.length, 2)
  // Most recent first
  assert.equal(result.data.list[0]._id, 'p2')
  assert.equal(result.data.list[1]._id, 'p1')
  // DELETING photo excluded
  assert.ok(result.data.list.every((p) => p._id !== 'p3'))
  // Other user excluded
  assert.ok(result.data.list.every((p) => p._id !== 'p4'))
  // hasMore false (all returned)
  assert.equal(result.data.hasMore, false)
  assert.equal(result.data.nextCursor, null)
})

test('ALL list pagination with cursor round-trip', async () => {
  const photos = []
  for (let i = 0; i < 5; i++) {
    photos.push({
      _id: `p${i}`,
      _openid: 'u1',
      status: 'ACTIVE',
      upload_time: `2024-01-0${5 - i}T00:00:00.000Z`,
      file_id: `f${i}`,
      width: 100,
      height: 200,
      shoot_time: `2024-01-0${5 - i}T00:00:00.000Z`,
      time_source: 'EXIF',
      tag_count: 0,
    })
  }

  const db = createPhotoListDb({ photos })
  const { list } = makeHandlers(db)

  // Page 1
  const r1 = await list('u1', { scope: 'ALL', pageSize: 2 })
  assert.equal(r1.code, 'SUCCESS')
  assert.equal(r1.data.list.length, 2)
  assert.equal(r1.data.hasMore, true)
  assert.ok(r1.data.nextCursor)

  // Page 2
  const r2 = await list('u1', {
    scope: 'ALL',
    pageSize: 2,
    cursor: r1.data.nextCursor,
  })
  assert.equal(r2.code, 'SUCCESS')
  assert.equal(r2.data.list.length, 2)
  assert.equal(r2.data.hasMore, true)
  assert.ok(r2.data.nextCursor)

  // Page 3 (last item)
  const r3 = await list('u1', {
    scope: 'ALL',
    pageSize: 2,
    cursor: r2.data.nextCursor,
  })
  assert.equal(r3.code, 'SUCCESS')
  assert.equal(r3.data.list.length, 1)
  assert.equal(r3.data.hasMore, false)
  assert.equal(r3.data.nextCursor, null)

  // No duplicates across pages
  const allIds = [
    ...r1.data.list.map((p) => p._id),
    ...r2.data.list.map((p) => p._id),
    ...r3.data.list.map((p) => p._id),
  ]
  assert.equal(new Set(allIds).size, 5)
})

test('ALL list with same upload_time uses _id as tiebreaker', async () => {
  const photos = [
    { _id: 'p_c', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-01-01T00:00:00.000Z', file_id: 'fc', width: 100, height: 200, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', tag_count: 0 },
    { _id: 'p_a', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-01-01T00:00:00.000Z', file_id: 'fa', width: 100, height: 200, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', tag_count: 0 },
    { _id: 'p_b', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-01-01T00:00:00.000Z', file_id: 'fb', width: 100, height: 200, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', tag_count: 0 },
  ]

  const db = createPhotoListDb({ photos })
  const { list } = makeHandlers(db)

  const result = await list('u1', { scope: 'ALL', pageSize: 3 })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.list.length, 3)
  // Descending _id order: p_c, p_b, p_a
  assert.deepEqual(
    result.data.list.map((p) => p._id),
    ['p_c', 'p_b', 'p_a'],
  )
})

test('ALL list empty returns empty list with no cursor', async () => {
  const db = createPhotoListDb({ photos: [] })
  const { list } = makeHandlers(db)

  const result = await list('u1', { scope: 'ALL', pageSize: 20 })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.list.length, 0)
  assert.equal(result.data.hasMore, false)
  assert.equal(result.data.nextCursor, null)
})

// ---------------------------------------------------------------------------
// UNCATEGORIZED scope
// ---------------------------------------------------------------------------
test('UNCATEGORIZED list only returns tag_count=0 photos', async () => {
  const db = createPhotoListDb({
    photos: [
      { _id: 'p1', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-03-01T00:00:00.000Z', file_id: 'f1', width: 100, height: 200, shoot_time: '2024-03-01T00:00:00.000Z', time_source: 'UPLOAD_TIME', tag_count: 0 },
      { _id: 'p2', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-03-02T00:00:00.000Z', file_id: 'f2', width: 200, height: 300, shoot_time: '2024-03-02T00:00:00.000Z', time_source: 'EXIF', tag_count: 3 },
      { _id: 'p3', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-03-03T00:00:00.000Z', file_id: 'f3', width: 300, height: 400, shoot_time: '2024-03-03T00:00:00.000Z', time_source: 'UPLOAD_TIME', tag_count: 0 },
    ],
  })

  const { list } = makeHandlers(db)
  const result = await list('u1', { scope: 'UNCATEGORIZED', pageSize: 20 })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.list.length, 2)
  assert.deepEqual(
    result.data.list.map((p) => p._id),
    ['p3', 'p1'],
  )
})

// ---------------------------------------------------------------------------
// TAG scope
// ---------------------------------------------------------------------------
test('TAG list rejects missing tag with TAG_NOT_FOUND', async () => {
  const db = createPhotoListDb({
    tags: [],
  })

  const { list } = makeHandlers(db)
  try {
    await list('u1', { scope: 'TAG', tagId: 'nonexistent', pageSize: 20 })
    assert.fail('expected TAG_NOT_FOUND')
  } catch (err) {
    assert.equal(err.code, 'TAG_NOT_FOUND')
  }
})

test('TAG list rejects other-user tag with TAG_NOT_FOUND', async () => {
  const db = createPhotoListDb({
    tags: [{ _id: 't1', _openid: 'u2', name: 'other tag', normalized_name: 'other tag' }],
  })

  const { list } = makeHandlers(db)
  try {
    await list('u1', { scope: 'TAG', tagId: 't1', pageSize: 20 })
    assert.fail('expected TAG_NOT_FOUND')
  } catch (err) {
    assert.equal(err.code, 'TAG_NOT_FOUND')
  }
})

test('TAG list returns photos matching the tag', async () => {
  const db = createPhotoListDb({
    tags: [{ _id: 't1', _openid: 'u1', name: 'vacation', normalized_name: 'vacation' }],
    photos: [
      { _id: 'p1', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-01-01T00:00:00.000Z', file_id: 'f1', width: 100, height: 200, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', tag_count: 1 },
      { _id: 'p2', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-01-02T00:00:00.000Z', file_id: 'f2', width: 200, height: 300, shoot_time: '2024-01-02T00:00:00.000Z', time_source: 'EXIF', tag_count: 1 },
      { _id: 'p3', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-01-03T00:00:00.000Z', file_id: 'f3', width: 300, height: 400, shoot_time: '2024-01-03T00:00:00.000Z', time_source: 'UPLOAD_TIME', tag_count: 2 },
    ],
    photo_tags: [
      { _id: 'r1', _openid: 'u1', tag_id: 't1', photo_id: 'p1', photo_upload_time: '2024-01-01T00:00:00.000Z' },
      { _id: 'r2', _openid: 'u1', tag_id: 't1', photo_id: 'p2', photo_upload_time: '2024-01-02T00:00:00.000Z' },
    ],
  })

  const { list } = makeHandlers(db)
  const result = await list('u1', { scope: 'TAG', tagId: 't1', pageSize: 20 })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.list.length, 2)
  // Most recent first by photo_upload_time
  assert.equal(result.data.list[0]._id, 'p2')
  assert.equal(result.data.list[1]._id, 'p1')
  assert.equal(result.data.hasMore, false)
})

test('TAG list skips DELETING photos and dirty relations', async () => {
  const db = createPhotoListDb({
    tags: [{ _id: 't1', _openid: 'u1', name: 'test', normalized_name: 'test' }],
    photos: [
      { _id: 'p1', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-01-01T00:00:00.000Z', file_id: 'f1', width: 100, height: 200, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', tag_count: 1 },
      { _id: 'p2', _openid: 'u1', status: 'DELETING', upload_time: '2024-01-02T00:00:00.000Z', file_id: 'f2', width: 200, height: 300, shoot_time: '2024-01-02T00:00:00.000Z', time_source: 'EXIF', tag_count: 0 },
      { _id: 'p3', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-01-03T00:00:00.000Z', file_id: 'f3', width: 300, height: 400, shoot_time: '2024-01-03T00:00:00.000Z', time_source: 'EXIF', tag_count: 1 },
    ],
    photo_tags: [
      { _id: 'r1', _openid: 'u1', tag_id: 't1', photo_id: 'p1', photo_upload_time: '2024-01-01T00:00:00.000Z' },
      { _id: 'r2', _openid: 'u1', tag_id: 't1', photo_id: 'p2', photo_upload_time: '2024-01-02T00:00:00.000Z' }, // DELETING photo
      { _id: 'r3', _openid: 'u1', tag_id: 't1', photo_id: 'p3', photo_upload_time: '2024-01-03T00:00:00.000Z' },
      { _id: 'r4', _openid: 'u1', tag_id: 't1', photo_id: 'p_ghost', photo_upload_time: '2024-01-04T00:00:00.000Z' }, // non-existent photo
    ],
  })

  const { list } = makeHandlers(db)
  const result = await list('u1', { scope: 'TAG', tagId: 't1', pageSize: 20 })

  assert.equal(result.code, 'SUCCESS')
  // Only p1 and p3 are valid
  assert.equal(result.data.list.length, 2)
  assert.deepEqual(
    result.data.list.map((p) => p._id),
    ['p3', 'p1'],
  )
  // Dirty relations should NOT be deleted (just skipped)
  assert.equal(db._stores.photo_tags.size, 4)
})

test('TAG list cursor continues from last scanned relation', async () => {
  const photos = []
  const relations = []
  for (let i = 0; i < 6; i++) {
    const pid = `p${i}`
    photos.push({
      _id: pid,
      _openid: 'u1',
      status: 'ACTIVE',
      upload_time: `2024-01-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
      file_id: `f${i}`,
      width: 100,
      height: 200,
      shoot_time: `2024-01-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
      time_source: 'EXIF',
      tag_count: 1,
    })
    relations.push({
      _id: `r${i}`,
      _openid: 'u1',
      tag_id: 't1',
      photo_id: pid,
      photo_upload_time: `2024-01-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
    })
  }

  const db = createPhotoListDb({
    tags: [{ _id: 't1', _openid: 'u1', name: 'test', normalized_name: 'test' }],
    photos,
    photo_tags: relations,
  })

  const { list } = makeHandlers(db)

  // Page 1: 2 items
  const r1 = await list('u1', { scope: 'TAG', tagId: 't1', pageSize: 2 })
  assert.equal(r1.code, 'SUCCESS')
  assert.equal(r1.data.list.length, 2)
  assert.equal(r1.data.hasMore, true)
  assert.ok(r1.data.nextCursor)

  // Page 2: 2 items
  const r2 = await list('u1', {
    scope: 'TAG', tagId: 't1', pageSize: 2,
    cursor: r1.data.nextCursor,
  })
  assert.equal(r2.code, 'SUCCESS')
  assert.equal(r2.data.list.length, 2)
  assert.equal(r2.data.hasMore, true)

  // Page 3: last 2 items
  const r3 = await list('u1', {
    scope: 'TAG', tagId: 't1', pageSize: 2,
    cursor: r2.data.nextCursor,
  })
  assert.equal(r3.code, 'SUCCESS')
  assert.equal(r3.data.list.length, 2)
  assert.equal(r3.data.hasMore, false)
  assert.equal(r3.data.nextCursor, null)

  // No duplicates across all pages
  const allIds = [
    ...r1.data.list.map((p) => p._id),
    ...r2.data.list.map((p) => p._id),
    ...r3.data.list.map((p) => p._id),
  ]
  assert.equal(new Set(allIds).size, 6)
})

test('TAG list allows short pages when too many dirty relations', async () => {
  // Create a scenario where most relations point to DELETING photos,
  // so the handler cannot fill the page even after scanning maxScan items
  const photos = [{ _id: 'p_good', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-01-01T00:00:00.000Z', file_id: 'fg', width: 100, height: 200, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', tag_count: 1 }]

  const relations = []
  const maxScan = MAX_PAGE_SIZE * TAG_MAX_SCAN_MULTIPLIER
  for (let i = 0; i < maxScan; i++) {
    relations.push({
      _id: `r${i}`,
      _openid: 'u1',
      tag_id: 't1',
      photo_id: `p_ghost_${i}`, // all non-existent
      photo_upload_time: `2024-01-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
    })
  }
  // Add one valid relation at the very end
  relations.push({
    _id: 'r_valid',
    _openid: 'u1',
    tag_id: 't1',
    photo_id: 'p_good',
    photo_upload_time: '2024-01-09T00:00:00.000Z',
  })

  const db = createPhotoListDb({
    tags: [{ _id: 't1', _openid: 'u1', name: 'test', normalized_name: 'test' }],
    photos,
    photo_tags: relations,
  })

  const { list } = makeHandlers(db)

  const result = await list('u1', { scope: 'TAG', tagId: 't1', pageSize: 5 })
  assert.equal(result.code, 'SUCCESS')
  // maxScan = 25 (5 * 5), first 25 relations are all ghosts, so we stop with 0
  assert.equal(result.data.list.length, 0)
  assert.equal(result.data.hasMore, true) // still more relations to scan
})

// ---------------------------------------------------------------------------
// Cursor validation
// ---------------------------------------------------------------------------
test('tampered cursor returns INVALID_CURSOR', async () => {
  const db = createPhotoListDb({ photos: [] })
  const { list } = makeHandlers(db)

  try {
    await list('u1', { scope: 'ALL', pageSize: 20, cursor: 'tampered.invalid' })
    assert.fail('expected INVALID_CURSOR')
  } catch (err) {
    assert.equal(err.code, 'INVALID_CURSOR')
  }
})

test('cross-scope cursor returns INVALID_CURSOR', async () => {
  const db = createPhotoListDb({
    photos: [
      { _id: 'p1', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-01-01T00:00:00.000Z', file_id: 'f1', width: 100, height: 200, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', tag_count: 0 },
      { _id: 'p2', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-01-02T00:00:00.000Z', file_id: 'f2', width: 200, height: 300, shoot_time: '2024-01-02T00:00:00.000Z', time_source: 'EXIF', tag_count: 0 },
    ],
  })

  const { list } = makeHandlers(db)

  // Get a valid ALL cursor (pageSize=1 with 2 photos → hasMore=true)
  const r1 = await list('u1', { scope: 'ALL', pageSize: 1 })
  assert.equal(r1.data.hasMore, true)
  assert.ok(r1.data.nextCursor)

  // Try to use ALL cursor for UNCATEGORIZED
  try {
    await list('u1', {
      scope: 'UNCATEGORIZED',
      pageSize: 20,
      cursor: r1.data.nextCursor,
    })
    assert.fail('expected INVALID_CURSOR')
  } catch (err) {
    assert.equal(err.code, 'INVALID_CURSOR')
  }
})

// ---------------------------------------------------------------------------
// Thumbnail URL generation
// ---------------------------------------------------------------------------
test('list cards include thumbnail_url from getTempFileURL', async () => {
  const db = createPhotoListDb({
    photos: [
      { _id: 'p1', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-01-01T00:00:00.000Z', file_id: 'cloud://env.xxx/file1', width: 100, height: 200, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', tag_count: 0 },
    ],
  })

  const { list } = makeHandlers(db)
  const result = await list('u1', { scope: 'ALL', pageSize: 20 })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.list.length, 1)
  assert.ok(result.data.list[0].thumbnail_url.includes('imageMogr2/thumbnail/!200x200r'))
})

test('list cards survive getTempFileURL failure with empty thumbnail_url', async () => {
  const db = createPhotoListDb({
    photos: [
      { _id: 'p1', _openid: 'u1', status: 'ACTIVE', upload_time: '2024-01-01T00:00:00.000Z', file_id: 'f1', width: 100, height: 200, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', tag_count: 0 },
    ],
  })

  const { list } = makeHandlers(db, {
    getTempFileURL: createGetTempFileURL('fail'),
  })

  const result = await list('u1', { scope: 'ALL', pageSize: 20 })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.list[0].thumbnail_url, '')
})

// ---------------------------------------------------------------------------
// Card projection
// ---------------------------------------------------------------------------
test('list cards only expose public fields', async () => {
  const db = createPhotoListDb({
    photos: [
      {
        _id: 'p1', _openid: 'u1', status: 'ACTIVE',
        upload_time: '2024-01-01T00:00:00.000Z',
        file_id: 'cloud://env/file1',
        upload_attempt_id: 'att1',
        deleting_at: null,
        updated_at: '2024-01-01T00:00:00.000Z',
        width: 100, height: 200, format: 'JPEG', file_size: 1000,
        shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF',
        tag_count: 2,
      },
    ],
  })

  const { list } = makeHandlers(db)
  const result = await list('u1', { scope: 'ALL', pageSize: 20 })

  const card = result.data.list[0]
  const allowed = new Set([
    '_id', 'thumbnail_url', 'width', 'height',
    'shoot_time', 'time_source', 'upload_time', 'tag_count',
  ])
  for (const key of Object.keys(card)) {
    assert.ok(allowed.has(key), `card exposes internal field: ${key}`)
  }
  // These must NOT be present
  assert.equal(card.file_id, undefined)
  assert.equal(card._openid, undefined)
  assert.equal(card.status, undefined)
  assert.equal(card.upload_attempt_id, undefined)
})

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
test('list rejects invalid scope', async () => {
  const db = createPhotoListDb({ photos: [] })
  const { list } = makeHandlers(db)

  try {
    await list('u1', { scope: 'INVALID', pageSize: 20 })
    assert.fail('expected VALIDATION_ERROR')
  } catch (err) {
    assert.equal(err.code, 'VALIDATION_ERROR')
  }
})

test('list rejects invalid pageSize', async () => {
  const db = createPhotoListDb({ photos: [] })
  const { list } = makeHandlers(db)

  for (const ps of [0, -1, MAX_PAGE_SIZE + 1, 'abc']) {
    try {
      await list('u1', { scope: 'ALL', pageSize: ps })
      assert.fail(`expected VALIDATION_ERROR for pageSize=${ps}`)
    } catch (err) {
      assert.equal(err.code, 'VALIDATION_ERROR')
    }
  }
})

test('TAG list requires tagId', async () => {
  const db = createPhotoListDb({ photos: [] })
  const { list } = makeHandlers(db)

  try {
    await list('u1', { scope: 'TAG', pageSize: 20 })
    assert.fail('expected VALIDATION_ERROR')
  } catch (err) {
    assert.equal(err.code, 'VALIDATION_ERROR')
  }
})
