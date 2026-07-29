'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { decodeCursor, encodeCursor } = require('../../cloudfunctions/_shared/cursor')

const secret = 'cursor-test-secret-with-at-least-32-characters'
const binding = {
  resource: 'PHOTO',
  scope: 'ALL',
  tagId: null,
  sortBy: 'upload_time',
  sortOrder: 'desc',
}

test('signed cursor round-trips with request binding', () => {
  const value = encodeCursor({
    ...binding,
    lastValue: '2026-07-29T08:00:00.000Z',
    lastId: 'photo-id',
  }, secret)
  assert.equal(decodeCursor(value, binding, secret).lastId, 'photo-id')
})

test('cursor tampering and cross-scope reuse are rejected', () => {
  const value = encodeCursor({ ...binding, lastValue: 'x', lastId: 'id' }, secret)
  assert.throws(
    () => decodeCursor(`${value.slice(0, -1)}x`, binding, secret),
    (error) => error.code === 'INVALID_CURSOR',
  )
  assert.throws(
    () => decodeCursor(value, { ...binding, scope: 'TAG' }, secret),
    (error) => error.code === 'INVALID_CURSOR',
  )
})

test('cursor refuses unsigned operation when secret is missing', () => {
  assert.throws(
    () => encodeCursor(binding, ''),
    (error) => error.code === 'INTERNAL_ERROR',
  )
})
