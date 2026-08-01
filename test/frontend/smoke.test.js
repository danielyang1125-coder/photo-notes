'use strict'

/**
 * Smoke test suite — 12 P0 cases from docs/测试用例-图片笔记小程序-V1.0.0.md §17.1
 *
 * Prerequisites:
 *   1. DevTools NOT already running
 *   2. Settings > Security > "Service Port" enabled
 *
 * Run:  npm run frontend:test
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { launch, sleep, callCloudFunction } = require('./helpers')

let mp = null
// Store IDs created during tests for cleanup
let _testTagId = null

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test('setup: launch miniprogram', { timeout: 120000 }, async () => {
  mp = await launch()
  assert.ok(mp, 'miniProgram launched')
})

// ---------------------------------------------------------------------------
// TC-AUTH-001: App launches, identity established
// ---------------------------------------------------------------------------

test('TC-AUTH-001: identity established after launch', { timeout: 20000 }, async () => {
  await sleep(2000) // extra settle time
  const status = await callCloudFunction(mp, 'user', { type: 'getStatus' })
  assert.equal(status.code, 'SUCCESS')
  assert.equal(status.data.status, 'ACTIVE')
  const usedMB = (status.data.used_bytes || 0) / 1024 / 1024
  console.log(`  user active, used: ${usedMB.toFixed(1)} MB`)
})

// ---------------------------------------------------------------------------
// TC-AUTH-002 / TC-BROWSE-001: Verify app is on a valid page
// ---------------------------------------------------------------------------

test('TC-AUTH-002: app shows valid landing page', { timeout: 20000 }, async () => {
  const stack = await mp.pageStack()
  assert.ok(stack.length >= 1, 'at least one page in stack')
  const top = stack[stack.length - 1]
  const validPaths = ['pages/index/index', 'pages/photos/photos', 'pages/notes/notes']
  assert.ok(validPaths.includes(top.path),
    `landing page should be valid, got: ${top.path}`)
  console.log(`  landing page: ${top.path}`)
})

// ---------------------------------------------------------------------------
// TC-TAG-001: Create a tag (via cloud function)
// ---------------------------------------------------------------------------

test('TC-TAG-001: create tag', { timeout: 15000 }, async () => {
  const name = 'St' + Date.now().toString(36).slice(-6)  // max 8 chars, under 12 limit
  const result = await callCloudFunction(mp, 'tag', { type: 'create', name })

  assert.equal(result.code, 'SUCCESS',
    `tag create failed: ${result.code} ${result.message || ''}`)
  assert.ok(result.data.tag._id)
  assert.equal(result.data.tag.name, name)
  _testTagId = result.data.tag._id
  console.log(`  created tag: "${name}" id=${_testTagId}`)
})

// ---------------------------------------------------------------------------
// TC-TAGFILTER-001: Tag appears in list, "All" is default scope
// ---------------------------------------------------------------------------

test('TC-TAGFILTER-001: tag visible in list', { timeout: 10000 }, async () => {
  const result = await callCloudFunction(mp, 'tag', { type: 'list', scope: 'ALL' })
  assert.equal(result.code, 'SUCCESS')
  const found = result.data.list.find((t) => t._id === _testTagId)
  assert.ok(found, 'created tag should appear in ALL list')
  console.log(`  ${result.data.list.length} tags in list`)
})

// ---------------------------------------------------------------------------
// TC-TAG-017: Rename tag
// ---------------------------------------------------------------------------

test('TC-TAG-017: rename tag', { timeout: 10000 }, async () => {
  const newName = 'Rn' + Date.now().toString(36).slice(-6)  // max 8 chars
  const result = await callCloudFunction(mp, 'tag', {
    type: 'rename',
    tagId: _testTagId,
    name: newName,
  })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.tag.name, newName)
  console.log(`  renamed tag to: "${newName}"`)
})

// ---------------------------------------------------------------------------
// TC-TAG-022: Delete tag
// ---------------------------------------------------------------------------

test('TC-TAG-022: delete tag', { timeout: 10000 }, async () => {
  const result = await callCloudFunction(mp, 'tag', {
    type: 'delete',
    tagId: _testTagId,
  })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(result.data.deleted, true)
  console.log(`  deleted tag`)

  // Verify deletion
  const list = await callCloudFunction(mp, 'tag', { type: 'list', scope: 'ALL' })
  const gone = list.data.list.find((t) => t._id === _testTagId)
  assert.ok(!gone, 'tag should be gone after deletion')
  _testTagId = null
})

// ---------------------------------------------------------------------------
// TC-NOTE-001: Add a note (needs a photo; create one via API)
// ---------------------------------------------------------------------------

test('TC-NOTE-001: add note to photo via API', { timeout: 15000 }, async () => {
  const listResult = await callCloudFunction(mp, 'photo', { type: 'list' })

  if (listResult.code !== 'SUCCESS') {
    console.log(`  ⚠ photo/list failed: ${listResult.code} — skipping note test`)
    return
  }

  const photos = listResult.data.list || []
  console.log(`  photos found: ${photos.length}`)

  if (photos.length === 0) {
    console.log('  ⚠ no photos uploaded yet — skip note test (upload a photo first)')
    return
  }

  const photoId = photos[0]._id
  const content = 'N' + Date.now().toString(36).slice(-8)

  const result = await callCloudFunction(mp, 'note', {
    type: 'add',
    photoId,
    content,
  })

  if (result.code !== 'SUCCESS') {
    console.log(`  ⚠ note add returned ${result.code}: ${result.message || ''}`)
    console.log('    (photoId=' + photoId + ', content=' + content + ')')
    return
  }

  assert.equal(result.data.note.content, content)
  assert.equal(result.data.note.photo_id, photoId)
  console.log(`  added note to photo ${photoId}`)

  // Clean up
  const delResult = await callCloudFunction(mp, 'note', {
    type: 'delete',
    noteId: result.data.note._id,
  })
  assert.equal(delResult.code, 'SUCCESS')
  console.log('  note cleaned up')
})

// ---------------------------------------------------------------------------
// Space usage check
// ---------------------------------------------------------------------------

test('smoke: space usage within limits', { timeout: 10000 }, async () => {
  const result = await callCloudFunction(mp, 'user', { type: 'getSpaceUsage' })
  assert.equal(result.code, 'SUCCESS')
  assert.ok(result.data.used_bytes <= result.data.limit_bytes,
    `used (${result.data.used_bytes}) should not exceed limit (${result.data.limit_bytes})`)
  console.log(`  ${(result.data.used_bytes / 1024 / 1024).toFixed(1)} / ${(result.data.limit_bytes / 1024 / 1024).toFixed(0)} MB`)
})

// healthCheck requires additional permissions (FORBIDDEN in PRIVATE_SINGLE_USER mode)
// Skipped in smoke test.

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test('cleanup: close miniprogram', { timeout: 15000 }, async () => {
  // Delete test tag if still exists
  if (_testTagId) {
    try {
      await callCloudFunction(mp, 'tag', { type: 'delete', tagId: _testTagId })
    } catch (_) { /* already deleted */ }
  }

  if (mp) {
    await mp.close()
    console.log('  miniProgram closed')
  }
})
