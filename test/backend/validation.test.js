'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const validation = require('../../cloudfunctions/_shared/validation')

test('string length counts Unicode code points', () => {
  assert.equal(validation.string('😀😀', { min: 2, max: 2 }), '😀😀')
  assert.throws(
    () => validation.string('😀😀', { max: 1 }),
    (error) => error.code === 'VALIDATION_ERROR',
  )
})

test('arrays support bounded unique values', () => {
  assert.deepEqual(validation.array(['a', 'a', 'b'], {
    min: 1,
    max: 3,
    unique: true,
  }), ['a', 'b'])
})

test('request ids reject unsafe characters', () => {
  assert.equal(validation.requestId('task-1:a.b'), 'task-1:a.b')
  assert.throws(() => validation.requestId('../task'))
})

test('ISO dates must be canonical and valid', () => {
  assert.equal(
    validation.isoDate('2026-07-29T08:00:00.000Z').toISOString(),
    '2026-07-29T08:00:00.000Z',
  )
  assert.throws(() => validation.isoDate('2026-07-29'))
})
