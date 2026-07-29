'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createSecurityLogger,
  digest,
  sanitize,
} = require('../../cloudfunctions/_shared/security-log')

test('log sanitizer keeps only approved non-sensitive fields', () => {
  const record = sanitize({
    event: 'photo.detail',
    result: 'SUCCESS',
    openid: 'sensitive',
    resourceId: 'photo-id',
    fileID: 'cloud://secret',
    url: 'https://private',
    content: 'private note',
  }, class FixedDate extends Date {
    constructor() {
      super('2026-07-29T00:00:00.000Z')
    }
  })
  assert.deepEqual(record, {
    event: 'photo.detail',
    result: 'SUCCESS',
    timestamp: '2026-07-29T00:00:00.000Z',
  })
})

test('logger serializes sanitized records only', () => {
  const output = []
  const logger = createSecurityLogger({
    sink: { log: (line) => output.push(line), error: (line) => output.push(line) },
  })
  logger.error({
    event: 'upload.confirm',
    result: 'FAILURE',
    safeErrorCode: 'INTERNAL_ERROR',
    error: new Error('secret'),
  })
  assert.equal(output.length, 1)
  assert.equal(output[0].includes('secret'), false)
})

test('HMAC digest needs a server-held secret', () => {
  assert.equal(digest('resource', 'short'), undefined)
  assert.match(
    digest('resource', 'audit-test-secret-with-at-least-32-characters'),
    /^[a-f0-9]{64}$/,
  )
})
