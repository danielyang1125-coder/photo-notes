'use strict'

const COLLECTIONS = Object.freeze([
  {
    name: 'users',
    indexes: [
      { name: 'status_idx', keys: { status: 1 } },
    ],
  },
  {
    name: 'photos',
    backfill: [
      { field: 'status', value: 'ACTIVE' },
      { field: 'updated_at', value: 'NOW' },
      { field: 'tag_count', value: 0 },
    ],
    indexes: [
      {
        name: 'photo_task_unique',
        keys: { _openid: 1, task_id: 1 },
        unique: true,
      },
      {
        name: 'photo_attempt_unique',
        keys: { _openid: 1, upload_attempt_id: 1 },
        unique: true,
      },
      {
        name: 'photo_list_cursor_idx',
        keys: { _openid: 1, status: 1, upload_time: -1, _id: -1 },
      },
      {
        name: 'photo_uncategorized_cursor_idx',
        keys: {
          _openid: 1,
          status: 1,
          tag_count: 1,
          upload_time: -1,
          _id: -1,
        },
      },
    ],
  },
  {
    name: 'notes',
    indexes: [
      { name: 'note_photo_idx', keys: { photo_id: 1 } },
      {
        name: 'note_created_desc_cursor_idx',
        keys: { _openid: 1, created_at: -1, _id: -1 },
      },
      {
        name: 'note_created_asc_cursor_idx',
        keys: { _openid: 1, created_at: 1, _id: 1 },
      },
      {
        name: 'note_shoot_desc_cursor_idx',
        keys: { _openid: 1, photo_shoot_time: -1, _id: -1 },
      },
      {
        name: 'note_shoot_asc_cursor_idx',
        keys: { _openid: 1, photo_shoot_time: 1, _id: 1 },
      },
    ],
  },
  {
    name: 'tags',
    indexes: [
      {
        name: 'tag_name_unique',
        keys: { _openid: 1, normalized_name: 1 },
        unique: true,
      },
      {
        name: 'tag_list_idx',
        keys: {
          _openid: 1,
          last_used_at: -1,
          updated_at: -1,
          created_at: -1,
        },
      },
    ],
  },
  {
    name: 'photo_tags',
    indexes: [
      {
        name: 'photo_tag_relation_unique',
        keys: { _openid: 1, photo_id: 1, tag_id: 1 },
        unique: true,
      },
      {
        name: 'photo_tag_filter_cursor_idx',
        keys: {
          _openid: 1,
          tag_id: 1,
          photo_upload_time: -1,
          _id: -1,
        },
      },
      {
        name: 'photo_tag_photo_idx',
        keys: { _openid: 1, photo_id: 1 },
      },
    ],
  },
  {
    name: 'upload_attempts',
    indexes: [
      {
        name: 'attempt_task_unique',
        keys: { _openid: 1, task_id: 1 },
        unique: true,
      },
      {
        name: 'attempt_expire_idx',
        keys: { status: 1, expires_at: 1 },
      },
      {
        name: 'attempt_lease_idx',
        keys: { status: 1, confirm_lease_expire_at: 1 },
      },
      {
        name: 'attempt_cleanup_cursor_idx',
        keys: { status: 1, _id: 1 },
      },
    ],
  },
  {
    name: 'deletion_tasks',
    indexes: [
      {
        name: 'delete_task_unique',
        keys: { _openid: 1, task_key: 1 },
        unique: true,
      },
      {
        name: 'delete_dispatch_idx',
        keys: { type: 1, status: 1, next_retry_at: 1 },
      },
      {
        name: 'delete_lease_idx',
        keys: { type: 1, status: 1, lease_expire_at: 1 },
      },
    ],
  },
])

function flattenIndexes(collections = COLLECTIONS) {
  return collections.flatMap((collection) =>
    collection.indexes.map((index) => ({
      collection: collection.name,
      name: index.name,
      keys: index.keys,
      unique: Boolean(index.unique),
    })),
  )
}

module.exports = {
  COLLECTIONS,
  flattenIndexes,
}
