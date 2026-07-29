'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  AppError,
  errorResponse,
  normalizeResponse,
  success,
} = require('../../cloudfunctions/_shared/response')

test('success always returns the public response envelope', () => {
  assert.deepEqual(success({ id: 'public' }), {
    code: 'SUCCESS',
    data: { id: 'public' },
  })
})

test('unknown errors never expose SDK details', () => {
  assert.deepEqual(errorResponse({
    code: 'DATABASE_ERROR',
    message: 'duplicate index users_openid fileID cloud://secret',
  }), {
    code: 'INTERNAL_ERROR',
    message: '服务暂时不可用，请稍后重试',
  })
})

test('known errors use catalog messages instead of thrown messages', () => {
  const error = new AppError('PHOTO_NOT_FOUND', {
    cause: new Error('secret resource identifier'),
  })
  assert.deepEqual(errorResponse(error), {
    code: 'PHOTO_NOT_FOUND',
    message: '图片不存在或已删除',
  })
})

test('normalization rejects unknown response error codes', () => {
  assert.deepEqual(normalizeResponse({ code: 'SDK_ERROR', message: 'raw' }), {
    code: 'INTERNAL_ERROR',
    message: '服务暂时不可用，请稍后重试',
  })
})
