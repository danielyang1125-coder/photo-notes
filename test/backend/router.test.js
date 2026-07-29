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

test('router applies ACTIVE guard before business handlers', async () => {
  let called = false
  const main = createBusinessMain({
    domain: 'photo',
    cloud: { getWXContext: () => ({ OPENID: 'id' }) },
    db: {
      collection: () => ({
        doc: () => ({ get: async () => ({ data: { status: 'DELETING' } }) }),
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
})
