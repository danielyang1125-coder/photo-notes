'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  CHECKPOINT_ID,
  createUploadCompensationService,
  pendingFileId,
} = require('../../cloudfunctions/cleanup/upload-compensation')

const NOW = new Date('2026-07-30T00:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function attempt(id, overrides = {}) {
  return {
    _id: id,
    _openid: 'private-user',
    task_id: `task-${id}`,
    status: 'PREPARED',
    pending_cloud_path: `uploads/pending/${id}.bin`,
    pending_file_id: `cloud://test-env/uploads/pending/${id}.bin`,
    promoted_file_id: null,
    promoted_at: null,
    confirm_lease_token: null,
    confirm_lease_expire_at: null,
    expires_at: new Date(NOW.getTime() + DAY),
    created_at: new Date(NOW.getTime() - DAY),
    updated_at: new Date(NOW.getTime() - DAY),
    confirmed_at: null,
    canceled_at: null,
    expired_at: null,
    ...overrides,
  }
}

function createMemoryRepository(seed = {}) {
  const attempts = new Map(
    (seed.attempts || []).map((item) => [item._id, { ...item }]),
  )
  const photoAttemptIds = new Set(seed.photoAttemptIds || [])
  let checkpoint = seed.checkpoint || {
    _id: CHECKPOINT_ID,
    cursors: {},
  }

  return {
    async loadCheckpoint() {
      return {
        ...checkpoint,
        cursors: { ...(checkpoint.cursors || {}) },
      }
    },
    async saveCheckpoint(value) {
      checkpoint = {
        ...value,
        cursors: { ...(value.cursors || {}) },
      }
    },
    async listAttempts(status, cursor, limit) {
      return [...attempts.values()]
        .filter((item) =>
          item.status === status && (!cursor || item._id > cursor))
        .sort((left, right) => left._id.localeCompare(right._id))
        .slice(0, limit)
        .map((item) => ({ ...item }))
    },
    async expireAttempt(id, timestamp) {
      const item = attempts.get(id)
      if (!item || item.status !== 'PREPARED' ||
          new Date(item.expires_at).getTime() > timestamp.getTime() ||
          (item.confirm_lease_token &&
            new Date(item.confirm_lease_expire_at).getTime() >
              timestamp.getTime())) {
        return false
      }
      Object.assign(item, {
        status: 'EXPIRED',
        expired_at: timestamp,
        confirm_lease_token: null,
        confirm_lease_expire_at: null,
        updated_at: timestamp,
      })
      return true
    },
    async releaseExpiredLease(id, timestamp) {
      const item = attempts.get(id)
      if (!item || item.status !== 'PREPARED' ||
          !item.confirm_lease_token ||
          new Date(item.confirm_lease_expire_at).getTime() >
            timestamp.getTime()) {
        return false
      }
      item.confirm_lease_token = null
      item.confirm_lease_expire_at = null
      item.updated_at = timestamp
      return true
    },
    async findPhoto(item) {
      return photoAttemptIds.has(item._id)
        ? { _id: `photo-${item._id}` }
        : null
    },
    async markPendingCleaned(id, timestamp) {
      Object.assign(attempts.get(id), {
        pending_file_id: null,
        pending_cleaned_at: timestamp,
        updated_at: timestamp,
      })
    },
    async markActiveCleaned(id, timestamp) {
      Object.assign(attempts.get(id), {
        promoted_file_id: null,
        verified_meta: null,
        active_cleaned_at: timestamp,
        updated_at: timestamp,
      })
    },
    async removeTerminalAttempt(id, cutoff) {
      const item = attempts.get(id)
      const endedAt = item.status === 'CONFIRMED'
        ? item.confirmed_at
        : item.status === 'CANCELED'
          ? item.canceled_at
          : item.expired_at || item.updated_at
      if (!endedAt || new Date(endedAt).getTime() > cutoff.getTime()) {
        return false
      }
      attempts.delete(id)
      return true
    },
    inspect() {
      return { attempts, checkpoint }
    },
  }
}

function createService(repository, deleted, overrides = {}) {
  return createUploadCompensationService({
    repository,
    environmentId: () => 'test-env',
    now: () => NOW,
    deleteFiles: async (fileIds) => {
      deleted.push(...fileIds)
    },
    ...overrides,
  })
}

test('expired PREPARED attempts converge while valid confirm leases survive', async () => {
  const repository = createMemoryRepository({
    attempts: [
      attempt('a-expired', {
        expires_at: new Date(NOW.getTime() - HOUR),
      }),
      attempt('b-confirming', {
        expires_at: new Date(NOW.getTime() - HOUR),
        confirm_lease_token: 'valid-token',
        confirm_lease_expire_at: new Date(NOW.getTime() + HOUR),
        promoted_file_id: 'cloud://test-env/photos/active/b.jpg',
        promoted_at: new Date(NOW.getTime() - 2 * DAY),
      }),
      attempt('c-stale-lease', {
        expires_at: new Date(NOW.getTime() + DAY),
        confirm_lease_token: 'stale-token',
        confirm_lease_expire_at: new Date(NOW.getTime() - HOUR),
      }),
    ],
  })
  const deleted = []

  await createService(repository, deleted).run()

  const state = repository.inspect().attempts
  assert.equal(state.get('a-expired').status, 'EXPIRED')
  assert.equal(state.get('c-stale-lease').confirm_lease_token, null)
  assert.equal(state.get('b-confirming').status, 'PREPARED')
  assert.equal(state.get('b-confirming').promoted_file_id.includes('b.jpg'), true)
  assert.equal(deleted.includes(
    'cloud://test-env/photos/active/b.jpg',
  ), false)
})

test('terminal pending files and old orphan active files are deleted idempotently', async () => {
  const old = new Date(NOW.getTime() - 2 * DAY)
  const repository = createMemoryRepository({
    attempts: [
      attempt('a-orphan', {
        status: 'CANCELED',
        canceled_at: old,
        promoted_file_id: 'cloud://test-env/photos/active/orphan.jpg',
        promoted_at: old,
      }),
      attempt('b-owned', {
        status: 'CONFIRMED',
        confirmed_at: old,
        promoted_file_id: 'cloud://test-env/photos/active/owned.jpg',
        promoted_at: old,
      }),
    ],
    photoAttemptIds: ['b-owned'],
  })
  const deleted = []
  const service = createService(repository, deleted)

  await service.run()
  await service.run()

  const state = repository.inspect().attempts
  assert.equal(state.get('a-orphan').pending_cleaned_at instanceof Date, true)
  assert.equal(state.get('a-orphan').active_cleaned_at instanceof Date, true)
  assert.equal(state.get('a-orphan').promoted_file_id, null)
  assert.equal(state.get('b-owned').promoted_file_id.includes('owned.jpg'), true)
  assert.equal(
    deleted.filter((item) => item.includes('orphan.jpg')).length,
    1,
  )
  assert.equal(deleted.some((item) => item.includes('owned.jpg')), false)
})

test('each phase persists a stable keyset cursor and resumes the next batch', async () => {
  const canceledAt = new Date(NOW.getTime() - DAY)
  const repository = createMemoryRepository({
    attempts: [
      attempt('a', { status: 'CANCELED', canceled_at: canceledAt }),
      attempt('b', { status: 'CANCELED', canceled_at: canceledAt }),
    ],
  })
  const deleted = []
  const service = createService(repository, deleted, { batchSize: 1 })

  await service.run()
  assert.equal(
    repository.inspect().checkpoint.cursors['pending:CANCELED'],
    'a',
  )
  assert.equal(repository.inspect().attempts.get('a').pending_cleaned_at instanceof Date, true)
  assert.equal(repository.inspect().attempts.get('b').pending_cleaned_at, undefined)

  await service.run()
  assert.equal(repository.inspect().attempts.get('b').pending_cleaned_at instanceof Date, true)
  assert.equal(new Set(deleted).size, deleted.length)
})

test('terminal attempts are retained seven days and only removed after cleanup', async () => {
  const old = new Date(NOW.getTime() - 8 * DAY)
  const recent = new Date(NOW.getTime() - 6 * DAY)
  const repository = createMemoryRepository({
    attempts: [
      attempt('a-old', {
        status: 'CONFIRMED',
        confirmed_at: old,
        pending_cleaned_at: old,
        pending_file_id: null,
      }),
      attempt('b-recent', {
        status: 'CANCELED',
        canceled_at: recent,
        pending_cleaned_at: recent,
        pending_file_id: null,
      }),
      attempt('c-unresolved', {
        status: 'EXPIRED',
        expired_at: old,
        pending_file_id: null,
        pending_cloud_path: '../invalid.bin',
      }),
    ],
    photoAttemptIds: ['a-old'],
  })
  const deleted = []

  await createService(repository, deleted).run()

  const state = repository.inspect().attempts
  assert.equal(state.has('a-old'), false)
  assert.equal(state.has('b-recent'), true)
  assert.equal(state.has('c-unresolved'), true)
})

test('pending fallback file id is derived from the signed path only', () => {
  assert.equal(
    pendingFileId(
      {
        pending_file_id: null,
        pending_cloud_path: 'uploads/pending/random.bin',
      },
      'test-env',
    ),
    'cloud://test-env/uploads/pending/random.bin',
  )
  assert.equal(
    pendingFileId(
      { pending_file_id: null, pending_cloud_path: '../active/file.jpg' },
      'test-env',
    ),
    null,
  )
})
