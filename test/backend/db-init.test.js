'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { COLLECTIONS, flattenIndexes } = require('../../scripts/backend-schema')
const {
  CliError,
  applyPlan,
  buildPlan,
  createCloudBaseAdapter,
  indexMatchesCloud,
  parseArgs,
} = require('../../scripts/db-init')

const EXPECTED_INDEXES = [
  ['users', 'status_idx', { status: 1 }, false],
  ['photos', 'photo_task_unique', { _openid: 1, task_id: 1 }, true],
  ['photos', 'photo_attempt_unique', { _openid: 1, upload_attempt_id: 1 }, true],
  ['photos', 'photo_list_cursor_idx', { _openid: 1, status: 1, upload_time: -1, _id: -1 }, false],
  ['photos', 'photo_uncategorized_cursor_idx', { _openid: 1, status: 1, tag_count: 1, upload_time: -1, _id: -1 }, false],
  ['notes', 'note_photo_idx', { photo_id: 1 }, false],
  ['notes', 'note_created_desc_cursor_idx', { _openid: 1, created_at: -1, _id: -1 }, false],
  ['notes', 'note_created_asc_cursor_idx', { _openid: 1, created_at: 1, _id: 1 }, false],
  ['notes', 'note_shoot_desc_cursor_idx', { _openid: 1, photo_shoot_time: -1, _id: -1 }, false],
  ['notes', 'note_shoot_asc_cursor_idx', { _openid: 1, photo_shoot_time: 1, _id: 1 }, false],
  ['tags', 'tag_name_unique', { _openid: 1, normalized_name: 1 }, true],
  ['tags', 'tag_list_idx', { _openid: 1, last_used_at: -1, updated_at: -1, created_at: -1 }, false],
  ['photo_tags', 'photo_tag_relation_unique', { _openid: 1, photo_id: 1, tag_id: 1 }, true],
  ['photo_tags', 'photo_tag_filter_cursor_idx', { _openid: 1, tag_id: 1, photo_upload_time: -1, _id: -1 }, false],
  ['photo_tags', 'photo_tag_photo_idx', { _openid: 1, photo_id: 1 }, false],
  ['upload_attempts', 'attempt_task_unique', { _openid: 1, task_id: 1 }, true],
  ['upload_attempts', 'attempt_expire_idx', { status: 1, expires_at: 1 }, false],
  ['upload_attempts', 'attempt_lease_idx', { status: 1, confirm_lease_expire_at: 1 }, false],
  ['upload_attempts', 'attempt_cleanup_cursor_idx', { status: 1, _id: 1 }, false],
  ['deletion_tasks', 'delete_task_unique', { _openid: 1, task_key: 1 }, true],
  ['deletion_tasks', 'delete_dispatch_idx', { type: 1, status: 1, next_retry_at: 1 }, false],
  ['deletion_tasks', 'delete_lease_idx', { type: 1, status: 1, lease_expire_at: 1 }, false],
]

test('schema contains the seven authoritative collections and indexes', () => {
  assert.deepEqual(
    COLLECTIONS.map((collection) => collection.name),
    ['users', 'photos', 'notes', 'tags', 'photo_tags', 'upload_attempts', 'deletion_tasks'],
  )
  assert.deepEqual(
    flattenIndexes().map((index) => [
      index.collection,
      index.name,
      index.keys,
      index.unique,
    ]),
    EXPECTED_INDEXES,
  )
})

test('database initialization defaults to dry-run and requires an explicit environment', () => {
  assert.deepEqual(parseArgs(['--env', 'photo-notes-dev']), {
    mode: 'dry-run',
    envId: 'photo-notes-dev',
    help: false,
  })
  assert.throws(() => parseArgs([]), (error) =>
    error instanceof CliError && error.code === 'ENV_REQUIRED',
  )
  assert.throws(() => parseArgs(['--dry-run', '--apply', '--env', 'dev']), {
    code: 'CONFLICTING_MODES',
  })
})

test('dry-run plan contains a digest instead of the raw environment id', () => {
  const plan = buildPlan(
    { mode: 'dry-run', envId: 'photo-notes-dev' },
    new Date('2026-07-29T00:00:00.000Z'),
  )
  assert.equal(plan.mode, 'dry-run')
  assert.equal(plan.environmentHash.length, 12)
  assert.equal(JSON.stringify(plan).includes('photo-notes-dev'), false)
  assert.equal(plan.indexes.length, EXPECTED_INDEXES.length)
})

test('apply fails safely before loading the SDK when credentials are missing', () => {
  assert.throws(
    () => createCloudBaseAdapter('photo-notes-dev', {}),
    (error) => error instanceof CliError && error.code === 'CREDENTIALS_REQUIRED',
  )
})

test('manager index payload preserves field order and direction', () => {
  const index = flattenIndexes().find(
    (item) => item.name === 'photo_uncategorized_cursor_idx',
  )
  assert.deepEqual(Object.entries(index.keys), [
    ['_openid', 1],
    ['status', 1],
    ['tag_count', 1],
    ['upload_time', -1],
    ['_id', -1],
  ])
})

test('cloud index comparison rejects drift instead of silently skipping it', () => {
  const index = {
    name: 'cursor_idx',
    keys: { _openid: 1, created_at: -1, _id: -1 },
    unique: false,
  }
  assert.equal(indexMatchesCloud(index, {
    Name: 'cursor_idx',
    Unique: 'false',
    Keys: [
      { Name: '_openid', Direction: '1' },
      { Name: 'created_at', Direction: '-1' },
      { Name: '_id', Direction: '-1' },
    ],
  }), true)
  assert.equal(indexMatchesCloud(index, {
    Name: 'cursor_idx',
    Unique: 'false',
    Keys: [
      { Name: '_openid', Direction: '1' },
      { Name: 'created_at', Direction: '-1' },
    ],
  }), false)
})

test('apply is repeatable and only backfills missing photo fields', async () => {
  const state = {
    collections: new Set(),
    indexes: new Set(),
    photos: [
      { _id: 'a' },
      {
        _id: 'b',
        status: 'DELETING',
        updated_at: new Date('2026-07-01T00:00:00.000Z'),
        tag_count: 2,
      },
    ],
  }
  const adapter = {
    async createCollection(name) {
      if (state.collections.has(name)) throw Object.assign(new Error(), { code: 'ResourceConflict' })
      state.collections.add(name)
    },
    async createIndex(collection, index) {
      const key = `${collection}.${index.name}`
      if (state.indexes.has(key)) throw Object.assign(new Error(), { code: 'ResourceConflict' })
      state.indexes.add(key)
    },
    async backfillMissing(collection, field, value) {
      assert.equal(collection, 'photos')
      let updated = 0
      for (const photo of state.photos) {
        if (!(field in photo)) {
          photo[field] = value
          updated += 1
        }
      }
      return { matched: updated, updated }
    },
    async countMissing(collection, field) {
      assert.equal(collection, 'photos')
      return state.photos.filter((photo) => !(field in photo)).length
    },
  }
  const now = new Date('2026-07-29T01:02:03.000Z')

  const first = await applyPlan(adapter, { now })
  const second = await applyPlan(adapter, { now: new Date('2026-07-30T00:00:00.000Z') })

  assert.equal(first.collectionsCreated, 7)
  assert.equal(first.indexesCreated, EXPECTED_INDEXES.length)
  assert.equal(first.backfillUpdated, 3)
  assert.equal(second.collectionsExisting, 7)
  assert.equal(second.indexesExisting, EXPECTED_INDEXES.length)
  assert.equal(second.backfillUpdated, 0)
  assert.deepEqual(state.photos[0], {
    _id: 'a',
    status: 'ACTIVE',
    updated_at: now,
    tag_count: 0,
  })
  assert.equal(state.photos[1].status, 'DELETING')
  assert.equal(state.photos[1].tag_count, 2)
})
