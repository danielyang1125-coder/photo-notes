'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { getOpenId, requireActiveUser } = require('../../cloudfunctions/_shared/auth')

test('identity is read only from cloud context', () => {
  assert.equal(getOpenId({
    getWXContext: () => ({ OPENID: 'server-openid' }),
  }), 'server-openid')
  assert.throws(
    () => getOpenId({ getWXContext: () => ({}) }),
    (error) => error.code === 'AUTH_FAILED',
  )
})

test('ACTIVE guard rejects missing and non-active users', async () => {
  const db = {
    collection: () => ({
      doc: () => ({
        get: async () => ({ data: { status: 'DELETING' } }),
      }),
    }),
  }
  await assert.rejects(
    requireActiveUser(db, 'id'),
    (error) => error.code === 'USER_NOT_ACTIVE',
  )
})
