'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createNoteHandlers,
  MAX_PAGE_SIZE,
} = require('../../cloudfunctions/note/handlers')
const { AppError } = require('../../cloudfunctions/_shared/response')

const TEST_SECRET = 'test-cursor-hmac-secret-at-least-32-chars!!'

// ---------------------------------------------------------------------------
// In-memory DB mock supporting notes + photos collections
// ---------------------------------------------------------------------------

function isCommand(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function valuesEqual(a, b) {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime()
  }
  // Handle Date vs ISO string (cursor decoded values are strings)
  if (a instanceof Date && typeof b === 'string') {
    return a.toISOString() === b
  }
  if (typeof a === 'string' && b instanceof Date) {
    return a === b.toISOString()
  }
  return a === b
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

    if (!isCommand(cond)) return valuesEqual(itemValue, cond)

    if (Array.isArray(cond._in)) {
      return cond._in.some((v) => valuesEqual(itemValue, v))
    }

    if ('_lt' in cond) return normalizeForCompare(itemValue) < normalizeForCompare(cond._lt)
    if ('_gt' in cond) return normalizeForCompare(itemValue) > normalizeForCompare(cond._gt)
    if ('_eq' in cond) return valuesEqual(itemValue, cond._eq)

    return valuesEqual(itemValue, cond)
  })
}

function compareValues(a, b) {
  // Normalize to numbers for comparison (handles Date vs ISO string from cursor)
  const va = (a instanceof Date) ? a.getTime() : a
  const vb = (b instanceof Date) ? b.getTime() : b
  if (va < vb) return -1
  if (va > vb) return 1
  return 0
}

function normalizeForCompare(v) {
  if (v instanceof Date) return v.getTime()
  // Cursor-decoded dates are ISO strings — convert to timestamps for numeric comparison
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
    const d = new Date(v)
    if (!isNaN(d.getTime())) return d.getTime()
  }
  return v
}

function createNoteDb(seed = {}) {
  const stores = {
    notes: new Map((seed.notes || []).map((n) => [n._id, { ...n }])),
    photos: new Map((seed.photos || []).map((p) => [p._id, { ...p }])),
  }
  const SERVER_DATE = new Date('2026-07-30T00:00:00.000Z')
  let addCounter = 0

  function collectionApi(name) {
    const docs = stores[name]
    let _where = null
    const _orders = []

    function filtered() {
      let items = [...docs.values()]
      if (_where) {
        items = items.filter((item) => matchItem(item, _where))
      }
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

    const api = {
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
      async add({ data }) {
        addCounter += 1
        const id = data._id || `note-${addCounter}`
        const doc = { _id: id, ...data }
        docs.set(id, doc)
        return { _id: id }
      },
      async update({ data: updateData }) {
        const items = filtered()
        let updated = 0
        for (const item of items) {
          for (const [k, v] of Object.entries(updateData)) {
            if (v && v._serverDate) {
              item[k] = SERVER_DATE
            } else {
              item[k] = v
            }
          }
          updated += 1
        }
        return { stats: { updated } }
      },
      doc(id) {
        return {
          async get() {
            const doc = docs.get(id)
            return doc ? { data: { ...doc } } : { data: null }
          },
          async update({ data: updateData }) {
            const doc = docs.get(id)
            if (!doc) return { stats: { updated: 0 } }
            for (const [k, v] of Object.entries(updateData)) {
              if (v && v._serverDate) {
                doc[k] = SERVER_DATE
              } else {
                doc[k] = v
              }
            }
            return { stats: { updated: 1 } }
          },
          async remove() {
            docs.delete(id)
            return { stats: { removed: 1 } }
          },
        }
      },
    }
    return api
  }

  return {
    collection(name) {
      return collectionApi(name)
    },
    serverDate() {
      return { _serverDate: true, date: SERVER_DATE }
    },
    command: {
      and: (conditions) => ({ _and: conditions }),
      or: (conditions) => ({ _or: conditions }),
      lt: (value) => ({ _lt: value }),
      gt: (value) => ({ _gt: value }),
      eq: (value) => ({ _eq: value }),
      in: (values) => ({ _in: values }),
    },
    _stores: stores,
    SERVER_DATE,
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeHandlers(db, opts = {}) {
  return createNoteHandlers({
    db,
    getTempFileURL: opts.getTempFileURL ||
      (async (fileIds) => ({
        fileList: fileIds.map((id) => ({
          fileID: id,
          tempFileURL: `https://example.com/temp/${id}`,
        })),
      })),
    cursorSecret: TEST_SECRET,
    reviewContent: opts.reviewContent || (async () => {}),
  })
}

function photo(id, overrides = {}) {
  return {
    _id: id,
    _openid: 'u1',
    status: 'ACTIVE',
    file_id: `cloud://file-${id}`,
    shoot_time: new Date('2026-07-01T12:00:00.000Z'),
    upload_time: new Date('2026-07-15T10:00:00.000Z'),
    tag_count: 0,
    ...overrides,
  }
}

function noteDoc(id, overrides = {}) {
  return {
    _id: id,
    _openid: 'u1',
    photo_id: 'photo-1',
    photo_file_id: 'cloud://file-photo-1',
    content: `Note content for ${id}`,
    content_code_point_count: 20,
    photo_shoot_time: new Date('2026-07-01T12:00:00.000Z'),
    created_at: new Date('2026-07-20T10:00:00.000Z'),
    updated_at: new Date('2026-07-20T10:00:00.000Z'),
    ...overrides,
  }
}

// =========================================================================
// add tests
// =========================================================================

test('add: creates note on ACTIVE photo', async () => {
  const db = createNoteDb({
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.add('u1', {
    photoId: 'photo-1',
    content: 'Hello World',
  })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.note.content, 'Hello World')
  assert.equal(result.data.note.photo_id, 'photo-1')
  assert.ok(result.data.note._id)
  assert.ok(result.data.note.created_at)
  assert.ok(result.data.note.updated_at)
})

test('add: rejects non-existent photo with PHOTO_NOT_FOUND', async () => {
  const db = createNoteDb({ photos: [] })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.add('u1', { photoId: 'nonexistent', content: 'Hello' }),
    (err) => err.code === 'PHOTO_NOT_FOUND',
  )
})

test('add: rejects DELETING photo with PHOTO_NOT_FOUND', async () => {
  const db = createNoteDb({
    photos: [photo('photo-1', { status: 'DELETING' })],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.add('u1', { photoId: 'photo-1', content: 'Hello' }),
    (err) => err.code === 'PHOTO_NOT_FOUND',
  )
})

test('add: rejects other-user photo with PHOTO_NOT_FOUND', async () => {
  const db = createNoteDb({
    photos: [photo('photo-1', { _openid: 'other-user' })],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.add('u1', { photoId: 'photo-1', content: 'Hello' }),
    (err) => err.code === 'PHOTO_NOT_FOUND',
  )
})

test('add: rejects empty content', async () => {
  const db = createNoteDb({ photos: [photo('photo-1')] })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.add('u1', { photoId: 'photo-1', content: '' }),
    (err) => err.code === 'VALIDATION_ERROR',
  )
})

test('add: rejects content exceeding 1000 code points', async () => {
  const db = createNoteDb({ photos: [photo('photo-1')] })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.add('u1', { photoId: 'photo-1', content: 'x'.repeat(1001) }),
    (err) => err.code === 'VALIDATION_ERROR',
  )
})

test('add: accepts exactly 1000 code points', async () => {
  const db = createNoteDb({ photos: [photo('photo-1')] })
  const handlers = makeHandlers(db)

  const content = 'x'.repeat(1000)
  const result = await handlers.add('u1', { photoId: 'photo-1', content })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.note.content, content)
})

test('add: content review failure', async () => {
  const db = createNoteDb({ photos: [photo('photo-1')] })
  const handlers = makeHandlers(db, {
    reviewContent: async () => {
      throw new AppError('CONTENT_REVIEW_FAILED')
    },
  })

  await assert.rejects(
    () => handlers.add('u1', { photoId: 'photo-1', content: 'bad content' }),
    (err) => err.code === 'CONTENT_REVIEW_FAILED',
  )
})

test('add: content review unavailable', async () => {
  const db = createNoteDb({ photos: [photo('photo-1')] })
  const handlers = makeHandlers(db, {
    reviewContent: async () => {
      throw new AppError('CONTENT_REVIEW_UNAVAILABLE')
    },
  })

  await assert.rejects(
    () => handlers.add('u1', { photoId: 'photo-1', content: 'good content' }),
    (err) => err.code === 'CONTENT_REVIEW_UNAVAILABLE',
  )
})

test('add: stores photo_file_id from photo', async () => {
  const db = createNoteDb({
    photos: [photo('photo-1', { file_id: 'cloud://my-file-id' })],
  })
  const handlers = makeHandlers(db)

  await handlers.add('u1', { photoId: 'photo-1', content: 'test' })
  const stored = [...db._stores.notes.values()][0]
  assert.equal(stored.photo_file_id, 'cloud://my-file-id')
})

test('add: copies shoot_time from photo to note', async () => {
  const shootTime = new Date('2026-06-15T08:30:00.000Z')
  const db = createNoteDb({
    photos: [photo('photo-1', { shoot_time: shootTime })],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.add('u1', {
    photoId: 'photo-1',
    content: 'test',
  })
  assert.equal(
    result.data.note.photo_shoot_time.toISOString(),
    shootTime.toISOString(),
  )
})

test('add: projectNote excludes internal fields', async () => {
  const db = createNoteDb({ photos: [photo('photo-1')] })
  const handlers = makeHandlers(db)

  const result = await handlers.add('u1', {
    photoId: 'photo-1',
    content: 'Hello',
  })

  const n = result.data.note
  assert.ok(!('_openid' in n))
  assert.ok(!('photo_file_id' in n))
})

test('add: validates photoId is required', async () => {
  const db = createNoteDb({ photos: [photo('photo-1')] })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.add('u1', { content: 'Hello' }),
    (err) => err.code === 'VALIDATION_ERROR',
  )
})

// =========================================================================
// update tests
// =========================================================================

test('update: updates content with valid updatedAt', async () => {
  const updatedAt = new Date('2026-07-25T10:00:00.000Z')
  const db = createNoteDb({
    notes: [noteDoc('note-1', { updated_at: updatedAt })],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.update('u1', {
    noteId: 'note-1',
    content: 'Updated content',
    updatedAt: updatedAt.toISOString(),
  })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.note.content, 'Updated content')
  assert.ok(!result.data.conflict)
})

test('update: requires updatedAt — missing throws VALIDATION_ERROR', async () => {
  const db = createNoteDb({ notes: [noteDoc('note-1')] })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.update('u1', { noteId: 'note-1', content: 'Updated' }),
    (err) => err.code === 'VALIDATION_ERROR',
  )
})

test('update: optimistic lock conflict with wrong updatedAt', async () => {
  const actualUpdatedAt = new Date('2026-07-25T10:00:00.000Z')
  const staleUpdatedAt = new Date('2026-07-24T10:00:00.000Z')
  const db = createNoteDb({
    notes: [noteDoc('note-1', {
      updated_at: actualUpdatedAt,
      content: 'Original',
    })],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.update('u1', {
    noteId: 'note-1',
    content: 'Attempted update',
    updatedAt: staleUpdatedAt.toISOString(),
  })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.conflict, true)
  assert.equal(result.data.note.content, 'Original')
})

test('update: conflict response does not expose internal fields', async () => {
  const actualUpdatedAt = new Date('2026-07-25T10:00:00.000Z')
  const db = createNoteDb({
    notes: [noteDoc('note-1', {
      updated_at: actualUpdatedAt,
      content: 'Original',
      _openid: 'u1',
      photo_file_id: 'cloud://secret',
    })],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.update('u1', {
    noteId: 'note-1',
    content: 'Attempted',
    updatedAt: new Date('2026-07-24T10:00:00.000Z').toISOString(),
  })

  assert.equal(result.data.conflict, true)
  assert.ok(!('_openid' in result.data.note))
  assert.ok(!('photo_file_id' in result.data.note))
})

test('update: NOTE_NOT_FOUND for non-existent note', async () => {
  const db = createNoteDb({ notes: [] })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.update('u1', {
      noteId: 'nonexistent',
      content: 'Updated',
      updatedAt: new Date('2026-07-25T10:00:00.000Z').toISOString(),
    }),
    (err) => err.code === 'NOTE_NOT_FOUND',
  )
})

test('update: NOTE_NOT_FOUND for other-user note (ownership check)', async () => {
  const updatedAt = new Date('2026-07-25T10:00:00.000Z')
  const db = createNoteDb({
    notes: [noteDoc('note-1', { _openid: 'other-user', updated_at: updatedAt })],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.update('u1', {
      noteId: 'note-1',
      content: 'Updated',
      updatedAt: updatedAt.toISOString(),
    }),
    (err) => err.code === 'NOTE_NOT_FOUND',
  )
})

test('update: content review failure', async () => {
  const updatedAt = new Date('2026-07-25T10:00:00.000Z')
  const db = createNoteDb({
    notes: [noteDoc('note-1', { updated_at: updatedAt })],
  })
  const handlers = makeHandlers(db, {
    reviewContent: async () => {
      throw new AppError('CONTENT_REVIEW_FAILED')
    },
  })

  await assert.rejects(
    () => handlers.update('u1', {
      noteId: 'note-1',
      content: 'bad',
      updatedAt: updatedAt.toISOString(),
    }),
    (err) => err.code === 'CONTENT_REVIEW_FAILED',
  )
})

test('update: validates noteId is required', async () => {
  const db = createNoteDb({ notes: [] })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.update('u1', {
      content: 'Updated',
      updatedAt: new Date('2026-07-25T10:00:00.000Z').toISOString(),
    }),
    (err) => err.code === 'VALIDATION_ERROR',
  )
})

// =========================================================================
// delete tests
// =========================================================================

test('delete: removes own note', async () => {
  const db = createNoteDb({
    notes: [noteDoc('note-1')],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.delete('u1', { noteId: 'note-1' })

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.deleted, true)
  assert.equal(result.data.photoId, 'photo-1')
  // Verify note is removed from store
  assert.ok(!db._stores.notes.has('note-1'))
})

test('delete: NOTE_NOT_FOUND for non-existent note', async () => {
  const db = createNoteDb({ notes: [] })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.delete('u1', { noteId: 'nonexistent' }),
    (err) => err.code === 'NOTE_NOT_FOUND',
  )
})

test('delete: NOTE_NOT_FOUND for other-user note', async () => {
  const db = createNoteDb({
    notes: [noteDoc('note-1', { _openid: 'other-user' })],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.delete('u1', { noteId: 'note-1' }),
    (err) => err.code === 'NOTE_NOT_FOUND',
  )
})

test('delete: idempotent — second delete returns NOTE_NOT_FOUND', async () => {
  const db = createNoteDb({
    notes: [noteDoc('note-1')],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db)

  const r1 = await handlers.delete('u1', { noteId: 'note-1' })
  assert.equal(r1.code, 'SUCCESS')

  await assert.rejects(
    () => handlers.delete('u1', { noteId: 'note-1' }),
    (err) => err.code === 'NOTE_NOT_FOUND',
  )
})

test('delete: does not update note_count on photo (V1 simplification)', async () => {
  const db = createNoteDb({
    notes: [noteDoc('note-1')],
    photos: [photo('photo-1', { note_count: 5 })],
  })
  const handlers = makeHandlers(db)

  await handlers.delete('u1', { noteId: 'note-1' })

  // photo should remain unchanged (no note_count decrement)
  const storedPhoto = db._stores.photos.get('photo-1')
  assert.equal(storedPhoto.note_count, 5)
})

// =========================================================================
// list tests — ordering
// =========================================================================

test('list: default order is created_at desc, _id desc', async () => {
  const db = createNoteDb({
    notes: [
      noteDoc('n1', { created_at: new Date('2026-07-20T10:00:00.000Z') }),
      noteDoc('n2', { created_at: new Date('2026-07-22T10:00:00.000Z') }),
      noteDoc('n3', { created_at: new Date('2026-07-21T10:00:00.000Z') }),
    ],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', {})
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.list.length, 3)
  assert.equal(result.data.list[0]._id, 'n2')
  assert.equal(result.data.list[1]._id, 'n3')
  assert.equal(result.data.list[2]._id, 'n1')
})

test('list: created_at asc, _id asc ordering', async () => {
  const db = createNoteDb({
    notes: [
      noteDoc('n1', { created_at: new Date('2026-07-20T10:00:00.000Z') }),
      noteDoc('n2', { created_at: new Date('2026-07-22T10:00:00.000Z') }),
      noteDoc('n3', { created_at: new Date('2026-07-21T10:00:00.000Z') }),
    ],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', {
    sortBy: 'created_at',
    sortOrder: 'asc',
  })

  assert.equal(result.data.list[0]._id, 'n1')
  assert.equal(result.data.list[1]._id, 'n3')
  assert.equal(result.data.list[2]._id, 'n2')
})

test('list: photo_shoot_time desc ordering', async () => {
  const db = createNoteDb({
    notes: [
      noteDoc('n1', { photo_shoot_time: new Date('2026-06-01T00:00:00.000Z'), created_at: new Date('2026-07-20T10:00:00.000Z') }),
      noteDoc('n2', { photo_shoot_time: new Date('2026-07-01T00:00:00.000Z'), created_at: new Date('2026-07-20T10:00:00.000Z') }),
      noteDoc('n3', { photo_shoot_time: new Date('2026-05-01T00:00:00.000Z'), created_at: new Date('2026-07-20T10:00:00.000Z') }),
    ],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', {
    sortBy: 'photo_shoot_time',
    sortOrder: 'desc',
  })

  assert.equal(result.data.list[0]._id, 'n2')
  assert.equal(result.data.list[1]._id, 'n1')
  assert.equal(result.data.list[2]._id, 'n3')
})

test('list: photo_shoot_time asc ordering', async () => {
  const db = createNoteDb({
    notes: [
      noteDoc('n1', { photo_shoot_time: new Date('2026-06-01T00:00:00.000Z'), created_at: new Date('2026-07-20T10:00:00.000Z') }),
      noteDoc('n2', { photo_shoot_time: new Date('2026-07-01T00:00:00.000Z'), created_at: new Date('2026-07-20T10:00:00.000Z') }),
      noteDoc('n3', { photo_shoot_time: new Date('2026-05-01T00:00:00.000Z'), created_at: new Date('2026-07-20T10:00:00.000Z') }),
    ],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', {
    sortBy: 'photo_shoot_time',
    sortOrder: 'asc',
  })

  assert.equal(result.data.list[0]._id, 'n3')
  assert.equal(result.data.list[1]._id, 'n1')
  assert.equal(result.data.list[2]._id, 'n2')
})

test('list: same sort value uses _id as tiebreaker desc', async () => {
  const sameTime = new Date('2026-07-20T10:00:00.000Z')
  const db = createNoteDb({
    notes: [
      noteDoc('n-b', { created_at: sameTime }),
      noteDoc('n-a', { created_at: sameTime }),
      noteDoc('n-c', { created_at: sameTime }),
    ],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', { sortBy: 'created_at', sortOrder: 'desc' })

  assert.equal(result.data.list[0]._id, 'n-c')
  assert.equal(result.data.list[1]._id, 'n-b')
  assert.equal(result.data.list[2]._id, 'n-a')
})

// =========================================================================
// list tests — pagination
// =========================================================================

test('list: pagination round-trip with cursor', async () => {
  const notes = []
  for (let i = 0; i < 5; i++) {
    notes.push(noteDoc(`n${i}`, {
      created_at: new Date(`2026-07-2${i}T10:00:00.000Z`),
    }))
  }
  const db = createNoteDb({ notes, photos: [photo('photo-1')] })
  const handlers = makeHandlers(db)

  const r1 = await handlers.list('u1', { pageSize: 2, sortBy: 'created_at', sortOrder: 'desc' })
  assert.equal(r1.data.list.length, 2)
  assert.equal(r1.data.hasMore, true)
  assert.ok(r1.data.nextCursor)

  const r2 = await handlers.list('u1', {
    pageSize: 2,
    sortBy: 'created_at',
    sortOrder: 'desc',
    cursor: r1.data.nextCursor,
  })
  assert.equal(r2.data.list.length, 2)
  assert.equal(r2.data.hasMore, true)
  assert.ok(r2.data.nextCursor)

  const r3 = await handlers.list('u1', {
    pageSize: 2,
    sortBy: 'created_at',
    sortOrder: 'desc',
    cursor: r2.data.nextCursor,
  })
  assert.equal(r3.data.list.length, 1)
  assert.equal(r3.data.hasMore, false)
  assert.equal(r3.data.nextCursor, null)

  const allIds = [
    ...r1.data.list.map((n) => n._id),
    ...r2.data.list.map((n) => n._id),
    ...r3.data.list.map((n) => n._id),
  ]
  assert.equal(new Set(allIds).size, 5)
})

test('list: empty result', async () => {
  const db = createNoteDb({ notes: [], photos: [] })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', {})

  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.list.length, 0)
  assert.equal(result.data.hasMore, false)
  assert.equal(result.data.nextCursor, null)
})

test('list: hasMore = false on last page', async () => {
  const db = createNoteDb({
    notes: [noteDoc('n1')],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', { pageSize: 20 })
  assert.equal(result.data.list.length, 1)
  assert.equal(result.data.hasMore, false)
  assert.equal(result.data.nextCursor, null)
})

// =========================================================================
// list tests — cursor validation
// =========================================================================

test('list: cross-sort cursor returns INVALID_CURSOR', async () => {
  const db = createNoteDb({
    notes: [
      noteDoc('n1', { created_at: new Date('2026-07-20T10:00:00.000Z') }),
      noteDoc('n2', { created_at: new Date('2026-07-21T10:00:00.000Z') }),
    ],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db)

  const r1 = await handlers.list('u1', {
    sortBy: 'created_at',
    sortOrder: 'desc',
    pageSize: 1,
  })
  assert.ok(r1.data.nextCursor)

  await assert.rejects(
    () =>
      handlers.list('u1', {
        sortBy: 'photo_shoot_time',
        sortOrder: 'asc',
        cursor: r1.data.nextCursor,
      }),
    (err) => err.code === 'INVALID_CURSOR',
  )
})

test('list: cross-order cursor returns INVALID_CURSOR', async () => {
  const db = createNoteDb({
    notes: [
      noteDoc('n1', { created_at: new Date('2026-07-20T10:00:00.000Z') }),
      noteDoc('n2', { created_at: new Date('2026-07-21T10:00:00.000Z') }),
    ],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db)

  const r1 = await handlers.list('u1', {
    sortBy: 'created_at',
    sortOrder: 'desc',
    pageSize: 1,
  })
  assert.ok(r1.data.nextCursor)

  await assert.rejects(
    () =>
      handlers.list('u1', {
        sortBy: 'created_at',
        sortOrder: 'asc',
        cursor: r1.data.nextCursor,
      }),
    (err) => err.code === 'INVALID_CURSOR',
  )
})

test('list: tampered cursor returns INVALID_CURSOR', async () => {
  const db = createNoteDb({
    notes: [noteDoc('n1'), noteDoc('n2')],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db)

  const r1 = await handlers.list('u1', { pageSize: 1, sortBy: 'created_at', sortOrder: 'desc' })
  const tampered = r1.data.nextCursor.slice(0, -1) + 'x'

  await assert.rejects(
    () => handlers.list('u1', { cursor: tampered }),
    (err) => err.code === 'INVALID_CURSOR',
  )
})

// =========================================================================
// list tests — stale photo references
// =========================================================================

test('list: skips notes whose parent photo is DELETING', async () => {
  const db = createNoteDb({
    notes: [
      noteDoc('n1', { photo_id: 'photo-active' }),
      noteDoc('n2', { photo_id: 'photo-deleting' }),
      noteDoc('n3', { photo_id: 'photo-active' }),
    ],
    photos: [
      photo('photo-active', { status: 'ACTIVE' }),
      photo('photo-deleting', { status: 'DELETING' }),
    ],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', {})
  assert.equal(result.data.list.length, 2)
  const photoIds = result.data.list.map((n) => n.photo_id)
  assert.ok(photoIds.includes('photo-active'))
  assert.ok(!photoIds.includes('photo-deleting'))
})

test('list: skips notes whose parent photo does not exist', async () => {
  const db = createNoteDb({
    notes: [
      noteDoc('n1', { photo_id: 'photo-exists' }),
      noteDoc('n2', { photo_id: 'photo-gone' }),
    ],
    photos: [
      photo('photo-exists', { status: 'ACTIVE' }),
    ],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', {})
  assert.equal(result.data.list.length, 1)
  assert.equal(result.data.list[0].photo_id, 'photo-exists')
})

test('list: skips notes whose parent photo belongs to other user', async () => {
  const db = createNoteDb({
    notes: [
      noteDoc('n1', { photo_id: 'photo-1' }),
    ],
    photos: [
      photo('photo-1', { _openid: 'other-user', status: 'ACTIVE' }),
    ],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', {})
  assert.equal(result.data.list.length, 0)
})

test('list: continues scanning after skipping stale refs', async () => {
  const notes = [
    noteDoc('n0', { photo_id: 'photo-active', created_at: new Date('2026-07-29T10:00:00.000Z') }),
    noteDoc('n1', { photo_id: 'photo-deleting', created_at: new Date('2026-07-28T10:00:00.000Z') }),
    noteDoc('n2', { photo_id: 'photo-active', created_at: new Date('2026-07-27T10:00:00.000Z') }),
    noteDoc('n3', { photo_id: 'photo-deleting', created_at: new Date('2026-07-26T10:00:00.000Z') }),
    noteDoc('n4', { photo_id: 'photo-active', created_at: new Date('2026-07-25T10:00:00.000Z') }),
  ]
  const db = createNoteDb({
    notes,
    photos: [
      photo('photo-active', { status: 'ACTIVE' }),
      photo('photo-deleting', { status: 'DELETING' }),
    ],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', { pageSize: 3 })
  assert.equal(result.data.list.length, 3)
  // All should point to photo-active
  result.data.list.forEach((n) => {
    assert.equal(n.photo_id, 'photo-active')
  })
})

// =========================================================================
// list tests — thumbnail URLs
// =========================================================================

test('list: includes thumbnail_url from getTempFileURL', async () => {
  const db = createNoteDb({
    notes: [noteDoc('n1', { photo_file_id: 'cloud://file-1' })],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db, {
    getTempFileURL: async (fileIds) => ({
      fileList: fileIds.map((id) => ({
        fileID: id,
        tempFileURL: `https://cdn.example.com/${id}`,
      })),
    }),
  })

  const result = await handlers.list('u1', {})
  assert.equal(result.data.list.length, 1)
  assert.ok(result.data.list[0].thumbnail_url.startsWith('https://cdn.example.com/'))
  assert.ok(result.data.list[0].thumbnail_url.includes('imageMogr2/thumbnail/!200x200r'))
})

test('list: survives getTempFileURL failure with empty thumbnail_url', async () => {
  const db = createNoteDb({
    notes: [noteDoc('n1', { photo_file_id: 'cloud://file-1' })],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db, {
    getTempFileURL: async () => {
      throw new Error('network error')
    },
  })

  const result = await handlers.list('u1', {})
  assert.equal(result.data.list.length, 1)
  assert.equal(result.data.list[0].thumbnail_url, '')
})

test('list: handles notes without photo_file_id', async () => {
  const db = createNoteDb({
    notes: [noteDoc('n1', { photo_file_id: '' })],
    photos: [photo('photo-1', { file_id: '' })],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', {})
  assert.equal(result.data.list.length, 1)
  assert.equal(result.data.list[0].thumbnail_url, '')
})

// =========================================================================
// list tests — projection
// =========================================================================

test('list: projection excludes internal fields', async () => {
  const db = createNoteDb({
    notes: [noteDoc('n1')],
    photos: [photo('photo-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', {})

  assert.equal(result.data.list.length, 1)
  const projected = result.data.list[0]
  assert.ok(!('_openid' in projected))
  assert.ok(!('photo_file_id' in projected))
})

// =========================================================================
// list tests — validation
// =========================================================================

test('list: rejects invalid sortBy', async () => {
  const db = createNoteDb({ notes: [], photos: [] })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.list('u1', { sortBy: 'invalid' }),
    (err) => err.code === 'VALIDATION_ERROR',
  )
})

test('list: rejects invalid sortOrder', async () => {
  const db = createNoteDb({ notes: [], photos: [] })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.list('u1', { sortOrder: 'invalid' }),
    (err) => err.code === 'VALIDATION_ERROR',
  )
})

test('list: rejects pageSize < 1', async () => {
  const db = createNoteDb({ notes: [], photos: [] })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.list('u1', { pageSize: 0 }),
    (err) => err.code === 'VALIDATION_ERROR',
  )
})

test('list: rejects pageSize > MAX_PAGE_SIZE', async () => {
  const db = createNoteDb({ notes: [], photos: [] })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.list('u1', { pageSize: MAX_PAGE_SIZE + 1 }),
    (err) => err.code === 'VALIDATION_ERROR',
  )
})

// =========================================================================
// list tests — cross-user isolation
// =========================================================================

test('list: only returns own notes', async () => {
  const db = createNoteDb({
    notes: [
      noteDoc('n1', { _openid: 'u1', photo_id: 'p1' }),
      noteDoc('n2', { _openid: 'other-user', photo_id: 'p1' }),
    ],
    photos: [
      photo('p1', { _openid: 'u1', status: 'ACTIVE' }),
    ],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', {})
  assert.equal(result.data.list.length, 1)
  assert.equal(result.data.list[0]._id, 'n1')
})

// =========================================================================
// list tests — edge cases
// =========================================================================

test('list: all notes point to DELETING photos returns empty list', async () => {
  const db = createNoteDb({
    notes: [
      noteDoc('n1', { photo_id: 'p1' }),
      noteDoc('n2', { photo_id: 'p2' }),
    ],
    photos: [
      photo('p1', { status: 'DELETING' }),
      photo('p2', { status: 'DELETING' }),
    ],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', {})
  assert.equal(result.data.list.length, 0)
  assert.equal(result.data.hasMore, false)
})

test('list: respects pageSize parameter', async () => {
  const notes = []
  for (let i = 0; i < 10; i++) {
    notes.push(noteDoc(`n${i}`, { created_at: new Date(`2026-07-2${i}T10:00:00.000Z`) }))
  }
  const db = createNoteDb({ notes, photos: [photo('photo-1')] })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', { pageSize: 3 })
  assert.equal(result.data.list.length, 3)
  assert.equal(result.data.hasMore, true)
})

test('list: different users notes are isolated', async () => {
  const db = createNoteDb({
    notes: [
      noteDoc('n1', { _openid: 'u1', photo_id: 'p1' }),
      noteDoc('n2', { _openid: 'u2', photo_id: 'p2' }),
    ],
    photos: [
      photo('p1', { _openid: 'u1' }),
      photo('p2', { _openid: 'u2' }),
    ],
  })
  const handlers = makeHandlers(db)

  const r1 = await handlers.list('u1', {})
  assert.equal(r1.data.list.length, 1)
  assert.equal(r1.data.list[0]._id, 'n1')

  const r2 = await handlers.list('u2', {})
  assert.equal(r2.data.list.length, 1)
  assert.equal(r2.data.list[0]._id, 'n2')
})

test('list: last page continuation works correctly', async () => {
  const notes = []
  for (let i = 0; i < 5; i++) {
    notes.push(noteDoc(`n${i}`, { created_at: new Date(`2026-07-2${i}T10:00:00.000Z`) }))
  }
  const db = createNoteDb({ notes, photos: [photo('photo-1')] })
  const handlers = makeHandlers(db)

  const r1 = await handlers.list('u1', { pageSize: 3, sortBy: 'created_at', sortOrder: 'desc' })
  assert.ok(r1.data.nextCursor)
  assert.equal(r1.data.hasMore, true)

  const r2 = await handlers.list('u1', {
    pageSize: 3,
    sortBy: 'created_at',
    sortOrder: 'desc',
    cursor: r1.data.nextCursor,
  })
  assert.equal(r2.code, 'SUCCESS')
  assert.equal(r2.data.list.length, 2)
  assert.equal(r2.data.hasMore, false)
})
