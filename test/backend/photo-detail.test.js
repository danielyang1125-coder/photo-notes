'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPhotoHandlers } =
  require('../../cloudfunctions/photo/handlers')

const TEST_SECRET = 'test-cursor-hmac-secret-at-least-32-chars!!'

// ---------------------------------------------------------------------------
// Re-use the same in-memory DB mock pattern as photo-list.test.js
// ---------------------------------------------------------------------------

function isCommand(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function matchItem(item, query) {
  if (!query || typeof query !== 'object') return true
  if (Array.isArray(query._and)) {
    return query._and.every((sub) => matchItem(item, sub))
  }
  if (Array.isArray(query._or)) {
    return query._or.some((sub) => matchItem(item, sub))
  }
  return Object.entries(query).every(([key, cond]) => {
    if (key === '_and' || key === '_or') return true
    const itemValue = item[key]
    if (!isCommand(cond)) return itemValue === cond
    if (Array.isArray(cond._in)) return cond._in.includes(itemValue)
    if ('_lt' in cond) return itemValue < cond._lt
    if ('_gt' in cond) return itemValue > cond._gt
    if ('_eq' in cond) return itemValue === cond._eq
    return itemValue === cond
  })
}

function compareValues(a, b) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function createDetailDb(seed = {}) {
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
      if (_where) items = items.filter((item) => matchItem(item, _where))
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
    command: _command,
    _stores: stores,
  }
}

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

function makeHandlers(db, opts = {}) {
  return createPhotoHandlers({
    db,
    getTempFileURL: opts.getTempFileURL || createGetTempFileURL(),
    cursorSecret: TEST_SECRET,
    clock: opts.clock || Date,
  })
}

// ---------------------------------------------------------------------------
// detail — happy path
// ---------------------------------------------------------------------------
test('detail returns ACTIVE photo with notes, tags and preview URL', async () => {
  const db = createDetailDb({
    photos: [
      {
        _id: 'p1', _openid: 'u1', status: 'ACTIVE',
        file_id: 'cloud://env/file1',
        width: 1920, height: 1080, format: 'JPEG', file_size: 1500000,
        shoot_time: '2024-06-15T12:00:00.000Z', time_source: 'EXIF',
        upload_time: '2024-06-15T12:05:00.000Z',
        tag_count: 2,
        upload_attempt_id: 'att1',
        deleting_at: null,
        updated_at: '2024-06-15T12:05:00.000Z',
        task_id: 'task1',
      },
    ],
    notes: [
      { _id: 'n1', _openid: 'u1', photo_id: 'p1', content: 'Beautiful sunset', created_at: '2024-06-16T00:00:00.000Z', updated_at: '2024-06-16T00:00:00.000Z' },
      { _id: 'n2', _openid: 'u1', photo_id: 'p1', content: 'At the beach', created_at: '2024-06-17T00:00:00.000Z', updated_at: '2024-06-17T00:00:00.000Z' },
    ],
    photo_tags: [
      { _id: 'r1', _openid: 'u1', photo_id: 'p1', tag_id: 't1', photo_upload_time: '2024-06-15T12:05:00.000Z' },
      { _id: 'r2', _openid: 'u1', photo_id: 'p1', tag_id: 't2', photo_upload_time: '2024-06-15T12:05:00.000Z' },
    ],
    tags: [
      { _id: 't1', _openid: 'u1', name: 'sunset', photo_count: 5, normalized_name: 'sunset' },
      { _id: 't2', _openid: 'u1', name: 'beach', photo_count: 3, normalized_name: 'beach' },
    ],
  })

  const { detail } = makeHandlers(db)
  const result = await detail('u1', { photoId: 'p1' })

  assert.equal(result.code, 'SUCCESS')

  // Photo projection
  assert.equal(result.data.photo._id, 'p1')
  assert.equal(result.data.photo.width, 1920)
  assert.equal(result.data.photo.height, 1080)
  assert.equal(result.data.photo.format, 'JPEG')
  assert.equal(result.data.photo.file_size, 1500000)
  assert.ok(result.data.photo.preview_url.includes('example.com/temp'))

  // Internal fields NOT exposed
  assert.equal(result.data.photo.file_id, undefined)
  assert.equal(result.data.photo._openid, undefined)
  assert.equal(result.data.photo.status, undefined)
  assert.equal(result.data.photo.upload_attempt_id, undefined)
  assert.equal(result.data.photo.deleting_at, undefined)
  assert.equal(result.data.photo.updated_at, undefined)
  assert.equal(result.data.photo.task_id, undefined)

  // Notes (latest first)
  assert.equal(result.data.notes.length, 2)
  assert.equal(result.data.notes[0]._id, 'n2')
  assert.equal(result.data.notes[1]._id, 'n1')
  assert.equal(result.data.notes[0].content, 'At the beach')

  // Tags
  assert.equal(result.data.tags.length, 2)
  assert.equal(result.data.tags[0].name, 'sunset')
  assert.equal(result.data.tags[1].name, 'beach')
})

// ---------------------------------------------------------------------------
// detail — existence / visibility
// ---------------------------------------------------------------------------
test('detail returns PHOTO_NOT_FOUND for non-existent photo', async () => {
  const db = createDetailDb({ photos: [] })
  const { detail } = makeHandlers(db)

  try {
    await detail('u1', { photoId: 'nonexistent' })
    assert.fail('expected PHOTO_NOT_FOUND')
  } catch (err) {
    assert.equal(err.code, 'PHOTO_NOT_FOUND')
  }
})

test('detail returns PHOTO_NOT_FOUND for DELETING photo', async () => {
  const db = createDetailDb({
    photos: [
      { _id: 'p1', _openid: 'u1', status: 'DELETING', file_id: 'f1', width: 100, height: 200, format: 'JPEG', file_size: 1000, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', upload_time: '2024-01-01T00:00:00.000Z', tag_count: 0 },
    ],
  })

  const { detail } = makeHandlers(db)

  try {
    await detail('u1', { photoId: 'p1' })
    assert.fail('expected PHOTO_NOT_FOUND')
  } catch (err) {
    assert.equal(err.code, 'PHOTO_NOT_FOUND')
  }
})

test('detail returns PHOTO_NOT_FOUND for other-user photo (same as non-existent)', async () => {
  const db = createDetailDb({
    photos: [
      { _id: 'p1', _openid: 'u2', status: 'ACTIVE', file_id: 'f1', width: 100, height: 200, format: 'JPEG', file_size: 1000, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', upload_time: '2024-01-01T00:00:00.000Z', tag_count: 0 },
    ],
  })

  const { detail } = makeHandlers(db)

  try {
    await detail('u1', { photoId: 'p1' })
    assert.fail('expected PHOTO_NOT_FOUND')
  } catch (err) {
    assert.equal(err.code, 'PHOTO_NOT_FOUND')
  }
})

// ---------------------------------------------------------------------------
// detail — preview URL edge cases
// ---------------------------------------------------------------------------
test('detail survives getTempFileURL failure with empty preview_url', async () => {
  const db = createDetailDb({
    photos: [
      { _id: 'p1', _openid: 'u1', status: 'ACTIVE', file_id: 'f1', width: 100, height: 200, format: 'JPEG', file_size: 1000, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', upload_time: '2024-01-01T00:00:00.000Z', tag_count: 0 },
    ],
    notes: [],
    photo_tags: [],
    tags: [],
  })

  const { detail } = makeHandlers(db, {
    getTempFileURL: createGetTempFileURL('fail'),
  })

  const result = await detail('u1', { photoId: 'p1' })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.photo.preview_url, '')
})

test('detail handles photo without file_id', async () => {
  const db = createDetailDb({
    photos: [
      { _id: 'p1', _openid: 'u1', status: 'ACTIVE', file_id: '', width: 100, height: 200, format: 'JPEG', file_size: 1000, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', upload_time: '2024-01-01T00:00:00.000Z', tag_count: 0 },
    ],
    notes: [],
    photo_tags: [],
    tags: [],
  })

  const { detail } = makeHandlers(db)
  const result = await detail('u1', { photoId: 'p1' })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.photo.preview_url, '')
})

// ---------------------------------------------------------------------------
// detail — empty sub-resources
// ---------------------------------------------------------------------------
test('detail returns empty notes and tags when none exist', async () => {
  const db = createDetailDb({
    photos: [
      { _id: 'p1', _openid: 'u1', status: 'ACTIVE', file_id: 'f1', width: 100, height: 200, format: 'JPEG', file_size: 1000, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', upload_time: '2024-01-01T00:00:00.000Z', tag_count: 0 },
    ],
    notes: [],
    photo_tags: [],
    tags: [],
  })

  const { detail } = makeHandlers(db)
  const result = await detail('u1', { photoId: 'p1' })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.notes.length, 0)
  assert.equal(result.data.tags.length, 0)
})

// ---------------------------------------------------------------------------
// detail — tags limited to 5
// ---------------------------------------------------------------------------
test('detail returns at most 5 tags', async () => {
  const photo_tags = []
  const tags = []
  for (let i = 1; i <= 7; i++) {
    photo_tags.push({
      _id: `r${i}`, _openid: 'u1', photo_id: 'p1', tag_id: `t${i}`,
      photo_upload_time: '2024-01-01T00:00:00.000Z',
    })
    tags.push({
      _id: `t${i}`, _openid: 'u1', name: `tag${i}`,
      photo_count: i, normalized_name: `tag${i}`,
    })
  }

  const db = createDetailDb({
    photos: [
      { _id: 'p1', _openid: 'u1', status: 'ACTIVE', file_id: 'f1', width: 100, height: 200, format: 'JPEG', file_size: 1000, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', upload_time: '2024-01-01T00:00:00.000Z', tag_count: 7 },
    ],
    notes: [],
    photo_tags,
    tags,
  })

  const { detail } = makeHandlers(db)
  const result = await detail('u1', { photoId: 'p1' })

  assert.equal(result.code, 'SUCCESS')
  // photo_tags query uses limit(5), so at most 5 relations → 5 tags
  assert.ok(result.data.tags.length <= 5)
})

// ---------------------------------------------------------------------------
// detail — input validation
// ---------------------------------------------------------------------------
test('detail rejects missing photoId', async () => {
  const db = createDetailDb({ photos: [] })
  const { detail } = makeHandlers(db)

  try {
    await detail('u1', {})
    assert.fail('expected VALIDATION_ERROR')
  } catch (err) {
    assert.equal(err.code, 'VALIDATION_ERROR')
  }
})

test('detail rejects empty photoId', async () => {
  const db = createDetailDb({ photos: [] })
  const { detail } = makeHandlers(db)

  try {
    await detail('u1', { photoId: '' })
    assert.fail('expected VALIDATION_ERROR')
  } catch (err) {
    assert.equal(err.code, 'VALIDATION_ERROR')
  }
})

// ---------------------------------------------------------------------------
// detail — note projection
// ---------------------------------------------------------------------------
test('detail note projection does not expose internal fields', async () => {
  const db = createDetailDb({
    photos: [
      { _id: 'p1', _openid: 'u1', status: 'ACTIVE', file_id: 'f1', width: 100, height: 200, format: 'JPEG', file_size: 1000, shoot_time: '2024-01-01T00:00:00.000Z', time_source: 'EXIF', upload_time: '2024-01-01T00:00:00.000Z', tag_count: 0 },
    ],
    notes: [
      { _id: 'n1', _openid: 'u1', photo_id: 'p1', content: 'test', created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z', file_id: 'cloud://f', photo_shoot_time: '2024-01-01T00:00:00.000Z' },
    ],
    photo_tags: [],
    tags: [],
  })

  const { detail } = makeHandlers(db)
  const result = await detail('u1', { photoId: 'p1' })

  const note = result.data.notes[0]
  const allowed = new Set(['_id', 'content', 'created_at', 'updated_at'])
  for (const key of Object.keys(note)) {
    assert.ok(allowed.has(key), `note exposes internal field: ${key}`)
  }
  assert.equal(note._openid, undefined)
  assert.equal(note.photo_id, undefined)
  assert.equal(note.file_id, undefined)
})
