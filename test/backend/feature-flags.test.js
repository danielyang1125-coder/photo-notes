'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '../..')

function readEntry(domain) {
  return fs.readFileSync(
    path.join(root, 'cloudfunctions', domain, 'index.js'),
    'utf8',
  )
}

// ---------------------------------------------------------------------------
// PUBLIC_RESOURCE_ERROR_MASKING — 所有业务云函数必须校验
// ---------------------------------------------------------------------------
test('PUBLIC_RESOURCE_ERROR_MASKING enforced in all 6 business functions', () => {
  for (const domain of ['upload', 'photo', 'note', 'tag', 'account', 'user']) {
    const entry = readEntry(domain)
    assert.match(
      entry,
      /config\.boolean\('PUBLIC_RESOURCE_ERROR_MASKING'\)/,
      `${domain}/index.js must check PUBLIC_RESOURCE_ERROR_MASKING`,
    )
  }
})

// ---------------------------------------------------------------------------
// UPLOAD_ATTEMPT_REQUIRED — 仅 upload 云函数
// ---------------------------------------------------------------------------
test('UPLOAD_ATTEMPT_REQUIRED enforced in upload function', () => {
  const entry = readEntry('upload')
  assert.match(
    entry,
    /config\.boolean\('UPLOAD_ATTEMPT_REQUIRED'\)/,
    'upload/index.js must check UPLOAD_ATTEMPT_REQUIRED',
  )
})

// ---------------------------------------------------------------------------
// CURSOR_PAGINATION_REQUIRED — photo 和 note 云函数
// ---------------------------------------------------------------------------
test('CURSOR_PAGINATION_REQUIRED enforced in photo and note functions', () => {
  for (const domain of ['photo', 'note']) {
    const entry = readEntry(domain)
    assert.match(
      entry,
      /config\.boolean\('CURSOR_PAGINATION_REQUIRED'\)/,
      `${domain}/index.js must check CURSOR_PAGINATION_REQUIRED`,
    )
  }
})

// ---------------------------------------------------------------------------
// ASYNC_PHOTO_DELETE_ENABLED — 仅 photo 云函数
// ---------------------------------------------------------------------------
test('ASYNC_PHOTO_DELETE_ENABLED enforced in photo function', () => {
  const entry = readEntry('photo')
  assert.match(
    entry,
    /config\.boolean\('ASYNC_PHOTO_DELETE_ENABLED'\)/,
    'photo/index.js must check ASYNC_PHOTO_DELETE_ENABLED',
  )
})

// ---------------------------------------------------------------------------
// CONTENT_REVIEW_ENABLED — upload 云函数（已有）
// ---------------------------------------------------------------------------
test('CONTENT_REVIEW_ENABLED enforced in upload function', () => {
  const entry = readEntry('upload')
  assert.match(
    entry,
    /config\.boolean\('CONTENT_REVIEW_ENABLED'\)/,
    'upload/index.js must check CONTENT_REVIEW_ENABLED',
  )
})

// ---------------------------------------------------------------------------
// 各云函数只校验自己需要的开关，不校验无关开关
// ---------------------------------------------------------------------------
test('photo function does not check upload-only flags', () => {
  const entry = readEntry('photo')
  assert.doesNotMatch(
    entry,
    /config\.boolean\('UPLOAD_ATTEMPT_REQUIRED'\)/,
    'photo/index.js should not check UPLOAD_ATTEMPT_REQUIRED',
  )
})

test('note function does not check upload-only or delete-only flags', () => {
  const entry = readEntry('note')
  assert.doesNotMatch(
    entry,
    /config\.boolean\('UPLOAD_ATTEMPT_REQUIRED'\)/,
    'note/index.js should not check UPLOAD_ATTEMPT_REQUIRED',
  )
  assert.doesNotMatch(
    entry,
    /config\.boolean\('ASYNC_PHOTO_DELETE_ENABLED'\)/,
    'note/index.js should not check ASYNC_PHOTO_DELETE_ENABLED',
  )
})

test('tag, account, user functions only check PUBLIC_RESOURCE_ERROR_MASKING', () => {
  for (const domain of ['tag', 'account', 'user']) {
    const entry = readEntry(domain)
    assert.doesNotMatch(
      entry,
      /config\.boolean\('UPLOAD_ATTEMPT_REQUIRED'\)/,
      `${domain}/index.js should not check UPLOAD_ATTEMPT_REQUIRED`,
    )
    assert.doesNotMatch(
      entry,
      /config\.boolean\('CURSOR_PAGINATION_REQUIRED'\)/,
      `${domain}/index.js should not check CURSOR_PAGINATION_REQUIRED`,
    )
    assert.doesNotMatch(
      entry,
      /config\.boolean\('ASYNC_PHOTO_DELETE_ENABLED'\)/,
      `${domain}/index.js should not check ASYNC_PHOTO_DELETE_ENABLED`,
    )
  }
})
