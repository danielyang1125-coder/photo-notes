'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createTagHandlers,
  normalizeTagName,
  TAG_NAME_MAX,
  TAG_MAX_COUNT,
  PHOTO_TAG_MAX,
  QUICK_LIMIT,
  RESERVED,
} = require('../../cloudfunctions/tag/handlers')
const { AppError } = require('../../cloudfunctions/_shared/response')

// ===========================================================================
// In-memory DB mock with transaction support
// ===========================================================================

function isCommand(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    !(value instanceof Date)
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
    if (!isCommand(cond)) {
      if (itemValue instanceof Date && typeof cond === 'string') {
        return itemValue.toISOString() === cond
      }
      return itemValue === cond
    }
    if (Array.isArray(cond._in)) return cond._in.some((v) => {
      if (itemValue instanceof Date && typeof v === 'string') {
        return itemValue.toISOString() === v
      }
      return itemValue === v
    })
    if ('_eq' in cond) return itemValue === cond._eq
    return true
  })
}

function compareValues(a, b) {
  const va = a instanceof Date ? a.getTime() : a
  const vb = b instanceof Date ? b.getTime() : b
  if (va < vb) return -1
  if (va > vb) return 1
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

function createTagDb(seed = {}) {
  let store = {
    photos: new Map((seed.photos || []).map((p) => [p._id, { ...p }])),
    tags: new Map((seed.tags || []).map((t) => [t._id, { ...t }])),
    photo_tags: new Map((seed.photo_tags || []).map((r) => [r._id, { ...r }])),
  }

  let nextId = 1000
  const SERVER_DATE = new Date('2026-07-30T12:00:00.000Z')

  const _command = {
    and: (conditions) => ({ _and: Array.isArray(conditions) ? conditions : [conditions] }),
    or: (conditions) => ({ _or: Array.isArray(conditions) ? conditions : [conditions] }),
    lt: (v) => ({ _lt: v }),
    gt: (v) => ({ _gt: v }),
    lte: (v) => ({ _lte: v }),
    gte: (v) => ({ _gte: v }),
    eq: (v) => ({ _eq: v }),
    in: (values) => ({ _in: values }),
    inc: (v) => ({ _inc: v }),
  }

  function serverDate() {
    return SERVER_DATE
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

    function resolveUpdate(item, data) {
      const resolved = {}
      for (const [k, v] of Object.entries(data)) {
        if (isCommand(v) && '_inc' in v) {
          resolved[k] = (item[k] || 0) + v._inc
        } else {
          resolved[k] = v
        }
      }
      return resolved
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
              const resolved = resolveUpdate(item, data)
              docs().set(item._id, { ...item, ...resolved })
              updated++
            }
            return { stats: { updated } }
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
            // Unique index check for tags: (_openid, normalized_name)
            if (name === 'tags' && data.normalized_name) {
              const targetOpenid = data._openid || item._openid
              for (const [, existing] of docs()) {
                if (existing._openid === targetOpenid &&
                    existing.normalized_name === data.normalized_name &&
                    existing._id !== id) {
                  throw { errCode: -502003, code: 'DATABASE_DUPLICATE_KEY' }
                }
              }
            }
            const resolved = resolveUpdate(item, data)
            docs().set(id, { ...item, ...resolved })
            return { stats: { updated: 1 } }
          },
          async remove() {
            docs().delete(id)
            return { stats: { removed: 1 } }
          },
        }
      },
      async add({ data }) {
        // Unique index on tags: (_openid, normalized_name)
        if (name === 'tags' && data._openid && data.normalized_name) {
          for (const [, existing] of docs()) {
            if (existing._openid === data._openid &&
                existing.normalized_name === data.normalized_name) {
              throw { errCode: -502003, code: 'DATABASE_DUPLICATE_KEY' }
            }
          }
        }
        // Unique index on photo_tags: (_openid, photo_id, tag_id)
        if (name === 'photo_tags' && data._openid && data.photo_id && data.tag_id) {
          for (const [, existing] of docs()) {
            if (existing._openid === data._openid &&
                existing.photo_id === data.photo_id &&
                existing.tag_id === data.tag_id) {
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
        return { total: filtered(null).length }
      },
    }
  }

  let transactionTail = Promise.resolve()

  return {
    collection(name) {
      return { ...collectionApi(name, () => store), _store: () => store }
    },
    command: _command,
    serverDate,
    get _stores() { return store },
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
          return { ...collectionApi(name, () => txnStore), _store: () => txnStore }
        },
        async commit() { store = txnStore; done() },
        async rollback() { done() },
      }
    },
  }
}

// ===========================================================================
// Test helpers
// ===========================================================================

function makeHandlers(db, opts = {}) {
  return createTagHandlers({
    db,
    reviewContent: opts.reviewContent || (async () => {}),
  })
}

function seedTag(id, overrides = {}) {
  return {
    _id: id,
    _openid: 'u1',
    name: `Tag ${id}`,
    normalized_name: `tag ${id}`,
    photo_count: 0,
    last_used_at: new Date('2026-07-20T10:00:00.000Z'),
    created_at: new Date('2026-07-20T10:00:00.000Z'),
    updated_at: new Date('2026-07-20T10:00:00.000Z'),
    ...overrides,
  }
}

function seedPhoto(id, overrides = {}) {
  return {
    _id: id,
    _openid: 'u1',
    status: 'ACTIVE',
    file_id: `cloud://file-${id}`,
    shoot_time: new Date('2026-07-01T12:00:00.000Z'),
    upload_time: new Date('2026-07-15T10:00:00.000Z'),
    tag_count: 0,
    created_at: new Date('2026-07-15T10:00:00.000Z'),
    ...overrides,
  }
}

function seedRelation(id, overrides = {}) {
  return {
    _id: id,
    _openid: 'u1',
    photo_id: 'photo-1',
    tag_id: 'tag-1',
    photo_upload_time: new Date('2026-07-15T10:00:00.000Z'),
    created_at: new Date('2026-07-20T10:00:00.000Z'),
    ...overrides,
  }
}

// ===========================================================================
// normalizeTagName tests (TAG-05)
// ===========================================================================

test('normalizeTagName: trims Unicode whitespace', () => {
  const result = normalizeTagName(' 　 Hello World  \t')
  assert.equal(result.name, 'Hello World')
  assert.equal(result.normalizedName, 'hello world')
})

test('normalizeTagName: rejects control characters (null)', () => {
  assert.throws(
    () => normalizeTagName('Hello\x00World'),
    (e) => e.code === 'TAG_NAME_INVALID',
  )
})

test('normalizeTagName: rejects control characters (newline)', () => {
  assert.throws(
    () => normalizeTagName('Hello\nWorld'),
    (e) => e.code === 'TAG_NAME_INVALID',
  )
})

test('normalizeTagName: rejects control characters (tab)', () => {
  assert.throws(
    () => normalizeTagName('Hello\tWorld'),
    (e) => e.code === 'TAG_NAME_INVALID',
  )
})

test('normalizeTagName: rejects empty string after trim', () => {
  assert.throws(
    () => normalizeTagName('   '),
    (e) => e.code === 'TAG_NAME_INVALID',
  )
})

test('normalizeTagName: rejects empty input', () => {
  assert.throws(
    () => normalizeTagName(''),
    (e) => e.code === 'TAG_NAME_INVALID',
  )
})

test('normalizeTagName: accepts 1 code point', () => {
  const result = normalizeTagName('A')
  assert.equal(result.name, 'A')
  assert.equal(result.normalizedName, 'a')
})

test('normalizeTagName: accepts 12 code points', () => {
  const name = 'ABCDEFGHIJKL'
  const result = normalizeTagName(name)
  assert.equal(result.name, name)
  assert.equal(result.normalizedName, name.toLowerCase())
})

test('normalizeTagName: rejects 13 code points', () => {
  assert.throws(
    () => normalizeTagName('ABCDEFGHIJKLM'),
    (e) => e.code === 'TAG_NAME_INVALID',
  )
})

test('normalizeTagName: accepts Chinese characters up to 12', () => {
  const name = '标签名称十二个字啦'
  assert.equal([...name].length, 9)
  const result = normalizeTagName(name)
  assert.equal(result.name, name)
  assert.equal(result.normalizedName, name)
})

test('normalizeTagName: rejects reserved name "全部"', () => {
  assert.throws(
    () => normalizeTagName('全部'),
    (e) => e.code === 'TAG_NAME_INVALID',
  )
})

test('normalizeTagName: rejects reserved name "未分类"', () => {
  assert.throws(
    () => normalizeTagName('未分类'),
    (e) => e.code === 'TAG_NAME_INVALID',
  )
})

test('normalizeTagName: rejects reserved name with whitespace', () => {
  assert.throws(
    () => normalizeTagName('  全部  '),
    (e) => e.code === 'TAG_NAME_INVALID',
  )
})

test('normalizeTagName: applies NFC normalization', () => {
  // U+0065 (e) + U+0301 (combining acute accent) → U+00E9 (é)
  const decomposed = 'café'
  const result = normalizeTagName(decomposed)
  assert.equal(result.name, 'café')
  assert.equal(result.normalizedName, 'café')
})

test('normalizeTagName: lowercases Latin in normalized_name only', () => {
  const result = normalizeTagName('HelloWorld')
  assert.equal(result.name, 'HelloWorld')
  assert.equal(result.normalizedName, 'helloworld')
})

test('normalizeTagName: preserves Chinese casing', () => {
  const result = normalizeTagName('产品Design')
  assert.equal(result.name, '产品Design')
  assert.equal(result.normalizedName, '产品design')
})

test('normalizeTagName: handles emoji', () => {
  const result = normalizeTagName('🎉Party')
  assert.equal(result.name, '🎉Party')
  assert.equal(result.normalizedName, '🎉party')
})

test('normalizeTagName: multiple emoji count as code points', () => {
  const result = normalizeTagName('🎉🎨📷')
  assert.equal([...result.name].length, 3)
  assert.equal(result.name, result.normalizedName)
})

// ===========================================================================
// list tests (TAG-01)
// ===========================================================================

test('list QUICK: returns at most 5 tags', async () => {
  const tags = Array.from({ length: 10 }, (_, i) =>
    seedTag(`tag-${i}`, {
      last_used_at: new Date(`2026-07-${20 + i}T10:00:00.000Z`),
    }),
  )
  const db = createTagDb({ tags })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', { mode: 'QUICK' })
  assert.equal(result.code, 'SUCCESS')
  assert.ok(result.data.list.length <= 5)
  assert.ok(result.data.total <= 5)
})

test('list QUICK: sorted by last_used_at DESC', async () => {
  const tags = [
    seedTag('tag-a', { last_used_at: new Date('2026-07-20T10:00:00.000Z') }),
    seedTag('tag-b', { last_used_at: new Date('2026-07-25T10:00:00.000Z') }),
    seedTag('tag-c', { last_used_at: new Date('2026-07-22T10:00:00.000Z') }),
  ]
  const db = createTagDb({ tags })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', { mode: 'QUICK' })
  assert.equal(result.data.list.length, 3)
  assert.equal(result.data.list[0]._id, 'tag-b')
  assert.equal(result.data.list[1]._id, 'tag-c')
  assert.equal(result.data.list[2]._id, 'tag-a')
})

test('list: uses _id as tiebreaker for same timestamps', async () => {
  const sameTime = new Date('2026-07-20T10:00:00.000Z')
  const tags = [
    seedTag('tag-c', { last_used_at: sameTime, updated_at: sameTime, created_at: sameTime }),
    seedTag('tag-a', { last_used_at: sameTime, updated_at: sameTime, created_at: sameTime }),
    seedTag('tag-b', { last_used_at: sameTime, updated_at: sameTime, created_at: sameTime }),
  ]
  const db = createTagDb({ tags })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', { mode: 'QUICK' })
  // _id DESC: tag-c > tag-b > tag-a
  assert.equal(result.data.list[0]._id, 'tag-c')
  assert.equal(result.data.list[1]._id, 'tag-b')
  assert.equal(result.data.list[2]._id, 'tag-a')
})

test('list ALL: returns up to 100 tags', async () => {
  const tags = Array.from({ length: 50 }, (_, i) => {
    const date = new Date(`2026-07-${String(20 + (i % 10)).padStart(2, '0')}T10:00:00.000Z`)
    return seedTag(`tag-${i}`, {
      last_used_at: date,
      updated_at: date,
      created_at: date,
    })
  })
  const db = createTagDb({ tags })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', { mode: 'ALL' })
  assert.equal(result.data.list.length, 50)
  assert.equal(result.data.total, 50)
})

test('list: cross-user isolation', async () => {
  const tags = [
    seedTag('tag-u1', { _openid: 'u1' }),
    { ...seedTag('tag-u2'), _openid: 'u2' },
  ]
  const db = createTagDb({ tags })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', { mode: 'ALL' })
  assert.equal(result.data.list.length, 1)
  assert.equal(result.data.list[0]._id, 'tag-u1')
})

test('list: response excludes normalized_name and _openid', async () => {
  const db = createTagDb({ tags: [seedTag('tag-1')] })
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', { mode: 'ALL' })
  const tag = result.data.list[0]
  assert.equal(tag._id, 'tag-1')
  assert.equal(tag.name, 'Tag tag-1')
  assert.ok(!('normalized_name' in tag))
  assert.ok(!('_openid' in tag))
  assert.ok('photo_count' in tag)
  assert.ok('last_used_at' in tag)
  assert.ok('updated_at' in tag)
  assert.ok('created_at' in tag)
})

test('list: rejects invalid mode', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.list('u1', { mode: 'INVALID' }),
    (e) => e.code === 'VALIDATION_ERROR',
  )
})

test('list: empty result', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db)

  const result = await handlers.list('u1', { mode: 'ALL' })
  assert.equal(result.data.list.length, 0)
  assert.equal(result.data.total, 0)
})

// ===========================================================================
// create tests (TAG-02)
// ===========================================================================

test('create: successfully creates tag', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db)

  const result = await handlers.create('u1', { name: '新产品' })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.tag.name, '新产品')
  assert.equal(result.data.tag.photo_count, 0)
  assert.ok(result.data.tag._id)
  assert.ok(!('normalized_name' in result.data.tag))
  assert.ok(!('_openid' in result.data.tag))
})

test('create: applies normalization', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db)

  const result = await handlers.create('u1', { name: '  Hello  ' })
  assert.equal(result.data.tag.name, 'Hello')
})

test('create: rejects invalid name with TAG_NAME_INVALID', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.create('u1', { name: '' }),
    (e) => e.code === 'TAG_NAME_INVALID',
  )
})

test('create: content review failure → CONTENT_REVIEW_FAILED', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db, {
    reviewContent: async () => { throw new AppError('CONTENT_REVIEW_FAILED') },
  })

  await assert.rejects(
    () => handlers.create('u1', { name: 'BadWords' }),
    (e) => e.code === 'CONTENT_REVIEW_FAILED',
  )
})

test('create: content review unavailable → CONTENT_REVIEW_UNAVAILABLE', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db, {
    reviewContent: async () => { throw new AppError('CONTENT_REVIEW_UNAVAILABLE') },
  })

  await assert.rejects(
    () => handlers.create('u1', { name: 'NormalName' }),
    (e) => e.code === 'CONTENT_REVIEW_UNAVAILABLE',
  )
})

test('create: duplicate name → TAG_NAME_DUPLICATED', async () => {
  const db = createTagDb({
    tags: [seedTag('existing', { name: 'Travel', normalized_name: 'travel' })],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.create('u1', { name: 'Travel' }),
    (e) => e.code === 'TAG_NAME_DUPLICATED',
  )
})

test('create: duplicate name with different casing → TAG_NAME_DUPLICATED', async () => {
  const db = createTagDb({
    tags: [seedTag('existing', { name: 'Travel', normalized_name: 'travel' })],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.create('u1', { name: 'TRAVEL' }),
    (e) => e.code === 'TAG_NAME_DUPLICATED',
  )
})

test('create: tag limit reached → TAG_LIMIT_REACHED', async () => {
  const tags = Array.from({ length: TAG_MAX_COUNT }, (_, i) =>
    seedTag(`tag-${i}`, { name: `Tag${i}`, normalized_name: `tag${i}` }),
  )
  const db = createTagDb({ tags })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.create('u1', { name: 'NewTag' }),
    (e) => e.code === 'TAG_LIMIT_REACHED',
  )
})

test('create: different users can have same tag name', async () => {
  const db = createTagDb({
    tags: [seedTag('tag-u2', { _openid: 'u2', name: 'Travel', normalized_name: 'travel' })],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.create('u1', { name: 'Travel' })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.tag.name, 'Travel')
})

// ===========================================================================
// rename tests (TAG-03, TAG-15)
// ===========================================================================

test('rename: successfully renames own tag', async () => {
  const db = createTagDb({
    tags: [seedTag('tag-1', { name: 'OldName', normalized_name: 'oldname' })],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.rename('u1', { tagId: 'tag-1', name: 'NewName' })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.tag.name, 'NewName')
})

test('rename: preserves photo_count', async () => {
  const db = createTagDb({
    tags: [seedTag('tag-1', { photo_count: 5 })],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.rename('u1', { tagId: 'tag-1', name: 'Renamed' })
  assert.equal(result.data.tag.photo_count, 5)
})

test('rename: non-existent tag → TAG_NOT_FOUND', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.rename('u1', { tagId: 'nonexistent', name: 'NewName' }),
    (e) => e.code === 'TAG_NOT_FOUND',
  )
})

test('rename: other user tag → TAG_NOT_FOUND', async () => {
  const db = createTagDb({
    tags: [{ ...seedTag('tag-1'), _openid: 'u2' }],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.rename('u1', { tagId: 'tag-1', name: 'NewName' }),
    (e) => e.code === 'TAG_NOT_FOUND',
  )
})

test('rename: content review failure → CONTENT_REVIEW_FAILED (fail-closed)', async () => {
  const db = createTagDb({
    tags: [seedTag('tag-1')],
  })
  const handlers = makeHandlers(db, {
    reviewContent: async () => { throw new AppError('CONTENT_REVIEW_FAILED') },
  })

  await assert.rejects(
    () => handlers.rename('u1', { tagId: 'tag-1', name: 'Bad' }),
    (e) => e.code === 'CONTENT_REVIEW_FAILED',
  )
})

test('rename: duplicate name → TAG_NAME_DUPLICATED', async () => {
  const db = createTagDb({
    tags: [
      seedTag('tag-1', { name: 'Old', normalized_name: 'old' }),
      seedTag('tag-2', { name: 'Existing', normalized_name: 'existing' }),
    ],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.rename('u1', { tagId: 'tag-1', name: 'Existing' }),
    (e) => e.code === 'TAG_NAME_DUPLICATED',
  )
})

test('rename: missing tagId → VALIDATION_ERROR', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.rename('u1', { name: 'NewName' }),
    (e) => e.code === 'VALIDATION_ERROR',
  )
})

// ===========================================================================
// delete tests (TAG-04, TAG-15)
// ===========================================================================

test('delete: deletes tag and its relations', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1', { tag_count: 2 }), seedPhoto('photo-2', { tag_count: 0 })],
    tags: [seedTag('tag-1', { photo_count: 2 })],
    photo_tags: [
      seedRelation('rel-1', { tag_id: 'tag-1', photo_id: 'photo-1' }),
      seedRelation('rel-2', { tag_id: 'tag-1', photo_id: 'photo-2' }),
    ],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.delete('u1', { tagId: 'tag-1' })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.deleted, true)
  assert.equal(result.data.removedRelationCount, 2)

  // Verify tag deleted
  assert.ok(!db._stores.tags.has('tag-1'))
  // Verify relations deleted
  assert.ok(!db._stores.photo_tags.has('rel-1'))
  assert.ok(!db._stores.photo_tags.has('rel-2'))
  // Verify photo.tag_count decremented
  const photo = db._stores.photos.get('photo-1')
  assert.equal(photo.tag_count, 1)
})

test('delete: non-existent tag → TAG_NOT_FOUND', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.delete('u1', { tagId: 'nonexistent' }),
    (e) => e.code === 'TAG_NOT_FOUND',
  )
})

test('delete: other user tag → TAG_NOT_FOUND', async () => {
  const db = createTagDb({
    tags: [{ ...seedTag('tag-1'), _openid: 'u2' }],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.delete('u1', { tagId: 'tag-1' }),
    (e) => e.code === 'TAG_NOT_FOUND',
  )
})

test('delete: does not delete photos or notes', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [seedTag('tag-1')],
    photo_tags: [seedRelation('rel-1', { tag_id: 'tag-1', photo_id: 'photo-1' })],
  })
  const handlers = makeHandlers(db)

  await handlers.delete('u1', { tagId: 'tag-1' })

  // Photo should still exist
  assert.ok(db._stores.photos.has('photo-1'))
})

test('delete: tag with no relations succeeds', async () => {
  const db = createTagDb({
    tags: [seedTag('tag-1', { photo_count: 0 })],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.delete('u1', { tagId: 'tag-1' })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.removedRelationCount, 0)
  assert.ok(!db._stores.tags.has('tag-1'))
})

// ===========================================================================
// getPhotoTags tests (TAG-06)
// ===========================================================================

test('getPhotoTags: returns tags for own ACTIVE photo', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [
      seedTag('tag-1', { name: 'Travel', photo_count: 1 }),
      seedTag('tag-2', { name: 'Food', photo_count: 1 }),
    ],
    photo_tags: [
      seedRelation('rel-1', { photo_id: 'photo-1', tag_id: 'tag-1' }),
      seedRelation('rel-2', { photo_id: 'photo-1', tag_id: 'tag-2' }),
    ],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.getPhotoTags('u1', { photoId: 'photo-1' })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.tags.length, 2)
  assert.ok(result.data.tags.every((t) => t._id && t.name && !('normalized_name' in t)))
})

test('getPhotoTags: non-existent photo → PHOTO_NOT_FOUND', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.getPhotoTags('u1', { photoId: 'nonexistent' }),
    (e) => e.code === 'PHOTO_NOT_FOUND',
  )
})

test('getPhotoTags: DELETING photo → PHOTO_NOT_FOUND', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1', { status: 'DELETING' })],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.getPhotoTags('u1', { photoId: 'photo-1' }),
    (e) => e.code === 'PHOTO_NOT_FOUND',
  )
})

test('getPhotoTags: other user photo → PHOTO_NOT_FOUND', async () => {
  const db = createTagDb({
    photos: [{ ...seedPhoto('photo-1'), _openid: 'u2' }],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.getPhotoTags('u1', { photoId: 'photo-1' }),
    (e) => e.code === 'PHOTO_NOT_FOUND',
  )
})

test('getPhotoTags: photo with no tags returns empty array', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.getPhotoTags('u1', { photoId: 'photo-1' })
  assert.equal(result.data.tags.length, 0)
})

test('getPhotoTags: missing photoId → VALIDATION_ERROR', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.getPhotoTags('u1', {}),
    (e) => e.code === 'VALIDATION_ERROR',
  )
})

// ===========================================================================
// updatePhotoTags tests (TAG-07, TAG-11, TAG-12)
// ===========================================================================

test('updatePhotoTags: adds tags to photo', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [seedTag('tag-1'), seedTag('tag-2')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.updatePhotoTags('u1', {
    photoId: 'photo-1',
    addTagIds: ['tag-1', 'tag-2'],
    removeTagIds: [],
  })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.tags.length, 2)

  // Verify photo.tag_count updated
  const photo = db._stores.photos.get('photo-1')
  assert.equal(photo.tag_count, 2)

  // Verify tag.photo_count updated
  assert.equal(db._stores.tags.get('tag-1').photo_count, 1)
  assert.equal(db._stores.tags.get('tag-2').photo_count, 1)
})

test('updatePhotoTags: removes tags from photo', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1', { tag_count: 2 })],
    tags: [
      seedTag('tag-1', { photo_count: 1 }),
      seedTag('tag-2', { photo_count: 1 }),
    ],
    photo_tags: [
      seedRelation('rel-1', { photo_id: 'photo-1', tag_id: 'tag-1' }),
      seedRelation('rel-2', { photo_id: 'photo-1', tag_id: 'tag-2' }),
    ],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.updatePhotoTags('u1', {
    photoId: 'photo-1',
    addTagIds: [],
    removeTagIds: ['tag-1'],
  })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.tags.length, 1)
  assert.equal(result.data.tags[0]._id, 'tag-2')

  // Photo count decremented
  assert.equal(db._stores.photos.get('photo-1').tag_count, 1)
  // Tag count decremented
  assert.equal(db._stores.tags.get('tag-1').photo_count, 0)
  // Relation removed
  assert.ok(!db._stores.photo_tags.has('rel-1'))
})

test('updatePhotoTags: rejects overlapping add and remove arrays', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [seedTag('tag-1')],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.updatePhotoTags('u1', {
      photoId: 'photo-1',
      addTagIds: ['tag-1'],
      removeTagIds: ['tag-1'],
    }),
    (e) => e.code === 'VALIDATION_ERROR',
  )
})

test('updatePhotoTags: non-existent photo → PHOTO_NOT_FOUND', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.updatePhotoTags('u1', {
      photoId: 'nonexistent',
      addTagIds: ['tag-1'],
      removeTagIds: [],
    }),
    (e) => e.code === 'PHOTO_NOT_FOUND',
  )
})

test('updatePhotoTags: DELETING photo → PHOTO_NOT_FOUND', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1', { status: 'DELETING' })],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.updatePhotoTags('u1', {
      photoId: 'photo-1',
      addTagIds: ['tag-1'],
      removeTagIds: [],
    }),
    (e) => e.code === 'PHOTO_NOT_FOUND',
  )
})

test('updatePhotoTags: non-existent tag → TAG_NOT_FOUND', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.updatePhotoTags('u1', {
      photoId: 'photo-1',
      addTagIds: ['nonexistent'],
      removeTagIds: [],
    }),
    (e) => e.code === 'TAG_NOT_FOUND',
  )
})

test('updatePhotoTags: other user tag → TAG_NOT_FOUND', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [{ ...seedTag('tag-1'), _openid: 'u2' }],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.updatePhotoTags('u1', {
      photoId: 'photo-1',
      addTagIds: ['tag-1'],
      removeTagIds: [],
    }),
    (e) => e.code === 'TAG_NOT_FOUND',
  )
})

test('updatePhotoTags: exceeds PHOTO_TAG_MAX → PHOTO_TAG_LIMIT_REACHED', async () => {
  const tags = Array.from({ length: 6 }, (_, i) =>
    seedTag(`tag-${i}`, { photo_count: 0 }),
  )
  const existingRelations = Array.from({ length: 4 }, (_, i) =>
    seedRelation(`rel-${i}`, {
      photo_id: 'photo-1',
      tag_id: `tag-${i}`,
    }),
  )
  const db = createTagDb({
    photos: [seedPhoto('photo-1', { tag_count: 4 })],
    tags,
    photo_tags: existingRelations,
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.updatePhotoTags('u1', {
      photoId: 'photo-1',
      addTagIds: ['tag-4', 'tag-5'],
      removeTagIds: [],
    }),
    (e) => e.code === 'PHOTO_TAG_LIMIT_REACHED',
  )
})

test('updatePhotoTags: empty diff does not modify anything', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1', { tag_count: 1 })],
    tags: [seedTag('tag-1', { photo_count: 1 }), seedTag('tag-2', { photo_count: 0 })],
    photo_tags: [
      seedRelation('rel-1', { photo_id: 'photo-1', tag_id: 'tag-1' }),
    ],
  })
  const handlers = makeHandlers(db)

  // tag-1 already on photo (no-op add), tag-2 not on photo (no-op remove)
  const result = await handlers.updatePhotoTags('u1', {
    photoId: 'photo-1',
    addTagIds: ['tag-1'],  // already exists - no-op
    removeTagIds: ['tag-2'], // exists as tag but not on photo - no-op
  })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.tags.length, 1)
  // No count changes
  assert.equal(db._stores.tags.get('tag-1').photo_count, 1)
  assert.equal(db._stores.photos.get('photo-1').tag_count, 1)
})

test('updatePhotoTags: updates last_used_at for added tags', async () => {
  const oldDate = new Date('2026-07-01T10:00:00.000Z')
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [seedTag('tag-1', { last_used_at: oldDate })],
  })
  const handlers = makeHandlers(db)

  await handlers.updatePhotoTags('u1', {
    photoId: 'photo-1',
    addTagIds: ['tag-1'],
    removeTagIds: [],
  })

  const tag = db._stores.tags.get('tag-1')
  assert.ok(tag.last_used_at.getTime() > oldDate.getTime())
})

test('updatePhotoTags: deduplicates addTagIds', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [seedTag('tag-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.updatePhotoTags('u1', {
    photoId: 'photo-1',
    addTagIds: ['tag-1', 'tag-1'],
    removeTagIds: [],
  })
  assert.equal(result.data.tags.length, 1)
  assert.equal(db._stores.photos.get('photo-1').tag_count, 1)
  assert.equal(db._stores.tags.get('tag-1').photo_count, 1)
})

test('updatePhotoTags: add and remove different tags simultaneously', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1', { tag_count: 2 })],
    tags: [
      seedTag('tag-1', { photo_count: 1 }),
      seedTag('tag-2', { photo_count: 1 }),
      seedTag('tag-3', { photo_count: 0 }),
    ],
    photo_tags: [
      seedRelation('rel-1', { photo_id: 'photo-1', tag_id: 'tag-1' }),
      seedRelation('rel-2', { photo_id: 'photo-1', tag_id: 'tag-2' }),
    ],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.updatePhotoTags('u1', {
    photoId: 'photo-1',
    addTagIds: ['tag-3'],
    removeTagIds: ['tag-1'],
  })
  assert.equal(result.data.tags.length, 2)

  // tag-1 removed, tag-3 added, tag-2 unchanged
  assert.equal(db._stores.tags.get('tag-1').photo_count, 0)
  assert.equal(db._stores.tags.get('tag-2').photo_count, 1)
  assert.equal(db._stores.tags.get('tag-3').photo_count, 1)
  assert.equal(db._stores.photos.get('photo-1').tag_count, 2)
})

// ===========================================================================
// batchAddPhotoTags tests (TAG-09, TAG-10)
// ===========================================================================

test('batchAdd: adds tags to multiple photos', async () => {
  const db = createTagDb({
    photos: [
      seedPhoto('photo-1'),
      seedPhoto('photo-2'),
    ],
    tags: [seedTag('tag-1'), seedTag('tag-2')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.batchAddPhotoTags('u1', {
    photoIds: ['photo-1', 'photo-2'],
    tagIds: ['tag-1', 'tag-2'],
  })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.successCount, 2)
  assert.equal(result.data.invalidCount, 0)
  assert.equal(result.data.limitExceededCount, 0)
  assert.equal(result.data.tags.length, 2)

  // Both photos should have 2 tags
  assert.equal(db._stores.photos.get('photo-1').tag_count, 2)
  assert.equal(db._stores.photos.get('photo-2').tag_count, 2)
  // Each tag should have 2 photos
  assert.equal(db._stores.tags.get('tag-1').photo_count, 2)
  assert.equal(db._stores.tags.get('tag-2').photo_count, 2)
})

test('batchAdd: invalid photos counted in invalidCount', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [seedTag('tag-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.batchAddPhotoTags('u1', {
    photoIds: ['photo-1', 'nonexistent', 'photo-deleted'],
    tagIds: ['tag-1'],
  })
  assert.equal(result.data.successCount, 1)
  assert.equal(result.data.invalidCount, 2)
  assert.equal(result.data.limitExceededCount, 0)
})

test('batchAdd: DELETING photos counted in invalidCount', async () => {
  const db = createTagDb({
    photos: [
      seedPhoto('photo-1', { status: 'DELETING' }),
    ],
    tags: [seedTag('tag-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.batchAddPhotoTags('u1', {
    photoIds: ['photo-1'],
    tagIds: ['tag-1'],
  })
  assert.equal(result.data.invalidCount, 1)
  assert.equal(result.data.successCount, 0)
})

test('batchAdd: other-user photos counted in invalidCount', async () => {
  const db = createTagDb({
    photos: [{ ...seedPhoto('photo-1'), _openid: 'u2' }],
    tags: [seedTag('tag-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.batchAddPhotoTags('u1', {
    photoIds: ['photo-1'],
    tagIds: ['tag-1'],
  })
  assert.equal(result.data.invalidCount, 1)
})

test('batchAdd: limit exceeded counted in limitExceededCount', async () => {
  const tags = Array.from({ length: 5 }, (_, i) => seedTag(`tag-${i}`))
  const db = createTagDb({
    photos: [seedPhoto('photo-1', { tag_count: 4 })],
    tags,
    photo_tags: Array.from({ length: 4 }, (_, i) =>
      seedRelation(`rel-${i}`, { photo_id: 'photo-1', tag_id: `tag-${i}` }),
    ),
  })
  const handlers = makeHandlers(db)

  const result = await handlers.batchAddPhotoTags('u1', {
    photoIds: ['photo-1'],
    tagIds: ['tag-4'], // already has tag-4, so adding it wouldn't help; adding tag-5 would make 5 total (still fits), need to go OVER 5
  })
  // Not exceeding limit, tag-4 already exists
  assert.equal(result.data.limitExceededCount, 0)
  assert.equal(result.data.successCount, 1)
})

test('batchAdd: all tagIds must be valid (reject immediately)', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [seedTag('tag-1')],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.batchAddPhotoTags('u1', {
      photoIds: ['photo-1'],
      tagIds: ['tag-1', 'nonexistent'],
    }),
    (e) => e.code === 'TAG_NOT_FOUND',
  )
})

test('batchAdd: deduplicates photoIds and tagIds', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [seedTag('tag-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.batchAddPhotoTags('u1', {
    photoIds: ['photo-1', 'photo-1', 'photo-1'],
    tagIds: ['tag-1', 'tag-1'],
  })
  assert.equal(result.data.successCount, 1)
  assert.equal(db._stores.photos.get('photo-1').tag_count, 1)
  assert.equal(db._stores.tags.get('tag-1').photo_count, 1)
})

test('batchAdd: idempotent for repeated calls', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [seedTag('tag-1')],
  })
  const handlers = makeHandlers(db)

  await handlers.batchAddPhotoTags('u1', { photoIds: ['photo-1'], tagIds: ['tag-1'] })
  await handlers.batchAddPhotoTags('u1', { photoIds: ['photo-1'], tagIds: ['tag-1'] })

  assert.equal(db._stores.photos.get('photo-1').tag_count, 1)
  assert.equal(db._stores.tags.get('tag-1').photo_count, 1)
  assert.equal(db._stores.photo_tags.size, 1)
})

test('batchAdd: validates photoIds array size (min 1, max 20)', async () => {
  const db = createTagDb({
    tags: [seedTag('tag-1')],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.batchAddPhotoTags('u1', { photoIds: [], tagIds: ['tag-1'] }),
    (e) => e.code === 'VALIDATION_ERROR',
  )
})

test('batchAdd: validates tagIds array size (min 1, max 5)', async () => {
  const db = createTagDb({})
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.batchAddPhotoTags('u1', { photoIds: ['photo-1'], tagIds: [] }),
    (e) => e.code === 'VALIDATION_ERROR',
  )
})

test('batchAdd: accepts optional requestId', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [seedTag('tag-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.batchAddPhotoTags('u1', {
    photoIds: ['photo-1'],
    tagIds: ['tag-1'],
    requestId: 'req-abc-123',
  })
  assert.equal(result.code, 'SUCCESS')
})

test('batchAdd: rejects invalid requestId', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [seedTag('tag-1')],
  })
  const handlers = makeHandlers(db)

  await assert.rejects(
    () => handlers.batchAddPhotoTags('u1', {
      photoIds: ['photo-1'],
      tagIds: ['tag-1'],
      requestId: '<invalid>',
    }),
    (e) => e.code === 'VALIDATION_ERROR',
  )
})

test('batchAdd: one photo failure does not roll back others', async () => {
  const db = createTagDb({
    photos: [
      seedPhoto('photo-valid'),
      seedPhoto('photo-other-user', { _openid: 'u2' }),
    ],
    tags: [seedTag('tag-1')],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.batchAddPhotoTags('u1', {
    photoIds: ['photo-valid', 'photo-other-user'],
    tagIds: ['tag-1'],
  })
  assert.equal(result.data.successCount, 1)
  assert.equal(result.data.invalidCount, 1)
  assert.equal(db._stores.photos.get('photo-valid').tag_count, 1)
})

test('batchAdd: returns tag summaries', async () => {
  const db = createTagDb({
    photos: [seedPhoto('photo-1')],
    tags: [seedTag('tag-1', { name: 'Travel' })],
  })
  const handlers = makeHandlers(db)

  const result = await handlers.batchAddPhotoTags('u1', {
    photoIds: ['photo-1'],
    tagIds: ['tag-1'],
  })
  assert.equal(result.data.tags.length, 1)
  assert.equal(result.data.tags[0].name, 'Travel')
  assert.ok(!('normalized_name' in result.data.tags[0]))
  assert.ok(!('_openid' in result.data.tags[0]))
})
