'use strict'

/**
 * Connectivity / smoke test for miniprogram-automator.
 *
 * Run:  node --test test/frontend/connectivity.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { launch, sleep, callCloudFunction } = require('./helpers')

let mp = null

test('connectivity: launch', { timeout: 120000 }, async () => {
  mp = await launch()
  assert.ok(mp, 'miniProgram handle should exist')
  console.log('  launched OK')
})

test('connectivity: page stack', { timeout: 10000 }, async () => {
  const stack = await mp.pageStack()
  console.log(`  ${stack.length} page(s) in stack`)
  for (const p of stack) {
    const dataStr = p.data ? JSON.stringify(p.data).substring(0, 80) : '(no data)'
    console.log(`    path: ${p.path}  data: ${dataStr}`)
  }
  assert.ok(stack.length >= 1, 'at least 1 page in stack')
})

test('connectivity: current page', { timeout: 10000 }, async () => {
  const page = await mp.currentPage()
  console.log(`  currentPath: ${page.path}`)
  assert.ok(page.path, 'page path should exist')
})

test('connectivity: evaluate cloud function', { timeout: 30000 }, async () => {
  // Try calling user/getStatus from the miniprogram context
  const result = await callCloudFunction(mp, 'user', { type: 'getStatus' })
  console.log('  user/getStatus result:', JSON.stringify(result).substring(0, 150))
  assert.ok(result, 'cloud function should return')
})

test('connectivity: reLaunch to photos tab', { timeout: 30000 }, async () => {
  // If the login gate hasn't redirected, force navigation to photos
  const currentPage = await mp.currentPage()
  if (currentPage.path !== 'pages/photos/photos') {
    await mp.reLaunch({ url: 'pages/photos/photos' })
    await sleep(5000)
    const page = await mp.currentPage()
    console.log(`  after reLaunch: ${page.path}`)
  }
  const page = await mp.currentPage()
  console.log(`  final page: ${page.path}`)
})

test('connectivity: screenshot', { timeout: 15000 }, async () => {
  const shot = await mp.screenshot()
  assert.ok(shot, 'screenshot should be captured')
  console.log(`  screenshot captured, size: ${shot.length} bytes`)
})

test('connectivity: cleanup', { timeout: 10000 }, async () => {
  if (mp) {
    await mp.close()
    console.log('  miniProgram closed')
  }
})
