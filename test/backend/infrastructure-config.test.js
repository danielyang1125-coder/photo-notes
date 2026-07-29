'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '../..')

test('cleanup declares independent five-minute and daily triggers', () => {
  const config = JSON.parse(
    fs.readFileSync(
      path.join(root, 'cloudfunctions', 'cleanup', 'config.json'),
      'utf8',
    ),
  )
  assert.deepEqual(config.triggers, [
    {
      name: 'deleteTaskWorker',
      type: 'timer',
      config: '0 */5 * * * * *',
    },
    {
      name: 'dailyCleanup',
      type: 'timer',
      config: '0 0 3 * * * *',
    },
  ])
})

test('runtime configuration template lists every required production setting', () => {
  const template = fs.readFileSync(
    path.join(root, 'config', 'backend-runtime.env.example'),
    'utf8',
  )
  for (const name of [
    'CURSOR_HMAC_SECRET',
    'AUDIT_HMAC_SECRET',
    'UPLOAD_ATTEMPT_REQUIRED',
    'CURSOR_PAGINATION_REQUIRED',
    'ASYNC_PHOTO_DELETE_ENABLED',
    'PUBLIC_RESOURCE_ERROR_MASKING',
    'CONTENT_REVIEW_ENABLED',
  ]) {
    assert.match(template, new RegExp(`^${name}=`, 'mu'))
  }
  assert.doesNotMatch(template, /cloud1-|AKID|secret.{0,3}=.{8,}/iu)
})
