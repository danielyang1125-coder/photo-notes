'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  DEFAULT_LIMIT_BYTES,
  createUserHandlers,
} = require('../../cloudfunctions/user/handlers')

function createUserDb(seed = []) {
  const documents = new Map(seed.map((item) => [item._id, { ...item }]))
  let createCount = 0
  const users = {
    where(query) {
      return {
        limit(value) {
          assert.equal(value, 1)
          return {
            async get() {
              await Promise.resolve()
              const item = documents.get(query._id)
              if (!item || item._openid !== query._openid) {
                return { data: [] }
              }
              return { data: [{ ...item }] }
            },
          }
        },
      }
    },
    async add({ data }) {
      await Promise.resolve()
      if (documents.has(data._id)) {
        throw { code: 'DATABASE_DUPLICATE_KEY' }
      }
      documents.set(data._id, { ...data })
      createCount += 1
      return { _id: data._id }
    },
  }
  return {
    collection(name) {
      assert.equal(name, 'users')
      return users
    },
    serverDate() {
      return new Date('2026-07-29T00:00:00.000Z')
    },
    inspect() {
      return { createCount, documents }
    },
  }
}

function assertNoIdentity(value) {
  const serialized = JSON.stringify(value)
  assert.equal(serialized.includes('openid'), false)
  assert.equal(serialized.includes('_id'), false)
}

test('ten concurrent first logins create one default user', async () => {
  const db = createUserDb()
  const handlers = createUserHandlers({ db })
  const results = await Promise.all(
    Array.from({ length: 10 }, () => handlers.login('private-user-id')),
  )

  const state = db.inspect()
  assert.equal(state.createCount, 1)
  assert.equal(state.documents.size, 1)
  assert.deepEqual(
    results.map((result) => result.data.isNewUser).sort(),
    [false, false, false, false, false, false, false, false, false, true],
  )
  for (const result of results) {
    assert.deepEqual(result.data.user, {
      status: 'ACTIVE',
      used_bytes: 0,
      limit_bytes: DEFAULT_LIMIT_BYTES,
    })
    assertNoIdentity(result)
  }
})

test('login returns authoritative states and never revives deleted users', async () => {
  for (const status of ['ACTIVE', 'DELETING', 'DELETED']) {
    const db = createUserDb([{
      _id: 'private-user-id',
      _openid: 'private-user-id',
      status,
      used_bytes: 12,
      limit_bytes: 34,
      internal_field: 'secret',
    }])
    const handlers = createUserHandlers({ db })
    const result = await handlers.login('private-user-id')

    assert.deepEqual(result.data, {
      user: { status, used_bytes: 12, limit_bytes: 34 },
      isNewUser: false,
    })
    assert.equal(db.inspect().createCount, 0)
    assertNoIdentity(result)
  }
})

test('status and space usage use minimal public projections', async () => {
  const db = createUserDb([{
    _id: 'private-user-id',
    _openid: 'private-user-id',
    status: 'ACTIVE',
    used_bytes: 85,
    limit_bytes: 100,
  }])
  const handlers = createUserHandlers({ db })

  assert.deepEqual(await handlers.getStatus('private-user-id'), {
    code: 'SUCCESS',
    data: { status: 'ACTIVE' },
  })
  assert.deepEqual(await handlers.getSpaceUsage('private-user-id'), {
    code: 'SUCCESS',
    data: {
      used_bytes: 85,
      limit_bytes: 100,
      warning: true,
      full: false,
    },
  })
})

test('missing and non-active users are rejected by the interface matrix', async () => {
  const missingHandlers = createUserHandlers({ db: createUserDb() })
  await assert.rejects(
    missingHandlers.getStatus('missing'),
    (error) => error.code === 'NOT_FOUND',
  )
  await assert.rejects(
    missingHandlers.getSpaceUsage('missing'),
    (error) => error.code === 'USER_NOT_ACTIVE',
  )

  for (const status of ['DELETING', 'DELETED']) {
    const handlers = createUserHandlers({
      db: createUserDb([{
        _id: 'private-user-id',
        _openid: 'private-user-id',
        status,
        used_bytes: 0,
        limit_bytes: DEFAULT_LIMIT_BYTES,
      }]),
    })
    await assert.rejects(
      handlers.getSpaceUsage('private-user-id'),
      (error) => error.code === 'USER_NOT_ACTIVE',
    )
  }
})
