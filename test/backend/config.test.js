'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const config = require('../../cloudfunctions/_shared/config')

test('required config never falls back to a production secret', () => {
  assert.equal(
    config.requiredString('CURSOR_HMAC_SECRET', {
      CURSOR_HMAC_SECRET: 'configured-secret',
    }),
    'configured-secret',
  )
  assert.throws(
    () => config.requiredString('CURSOR_HMAC_SECRET', {}),
    (error) => error.code === 'INTERNAL_ERROR',
  )
})

test('feature flags accept explicit booleans only', () => {
  assert.equal(config.boolean('FLAG', { env: { FLAG: 'true' } }), true)
  assert.equal(config.boolean('FLAG', { env: { FLAG: 'false' } }), false)
  assert.throws(() => config.boolean('FLAG', { env: { FLAG: 'yes' } }))
})
