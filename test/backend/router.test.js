'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createBusinessMain } = require('../../cloudfunctions/_shared/router')

function logger() {
  return { info: () => {}, error: () => {} }
}

test('unknown type is rejected before executing a handler', async () => {
  const main = createBusinessMain({
    domain: 'photo',
    cloud: { getWXContext: () => ({ OPENID: 'id' }) },
    db: {},
    handlers: { list: async () => ({ code: 'SUCCESS', data: {} }) },
    logger: logger(),
    activeGuard: false,
  })
  assert.deepEqual(await main({ type: 'missing' }), {
    code: 'UNKNOWN_TYPE',
    message: '未知操作类型',
  })
})

test('router applies the ACTIVE interface matrix before handlers', async () => {
  for (const status of [undefined, 'DELETING', 'DELETED']) {
    let called = false
    const main = createBusinessMain({
      domain: 'photo',
      cloud: { getWXContext: () => ({ OPENID: 'id' }) },
      db: {
        collection: () => ({
          doc: () => ({
            get: async () => ({ data: status ? { status } : null }),
          }),
        }),
      },
      handlers: {
        list: async () => {
          called = true
          return { code: 'SUCCESS', data: {} }
        },
      },
      logger: logger(),
    })
    assert.equal((await main({ type: 'list' })).code, 'USER_NOT_ACTIVE')
    assert.equal(called, false)
  }
})

test('router exposes the ACTIVE user only to guarded handlers', async () => {
  const user = { status: 'ACTIVE', internal: 'not-public' }
  const main = createBusinessMain({
    domain: 'user',
    cloud: { getWXContext: () => ({ OPENID: 'id' }) },
    db: {
      collection: () => ({
        doc: () => ({ get: async () => ({ data: user }) }),
      }),
    },
    activeGuardExempt: ['getStatus'],
    handlers: {
      getStatus: async ({ activeUser }) => ({
        code: 'SUCCESS',
        data: { guarded: Boolean(activeUser) },
      }),
      getSpaceUsage: async ({ activeUser }) => ({
        code: 'SUCCESS',
        data: { guarded: activeUser === user },
      }),
    },
    logger: logger(),
  })

  assert.deepEqual((await main({ type: 'getStatus' })).data, {
    guarded: false,
  })
  assert.deepEqual((await main({ type: 'getSpaceUsage' })).data, {
    guarded: true,
  })
})
