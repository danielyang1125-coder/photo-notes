'use strict'

/**
 * Frontend test helpers for miniprogram-automator smoke suite.
 *
 * Prerequisites:
 *   1. WeChat DevTools installed
 *   2. Settings > Security > "Service Port" enabled
 *   3. npm install miniprogram-automator
 *
 * Usage:
 *   node --test test/frontend/smoke.test.js
 */

const path = require('path')
const cp = require('child_process')
const automator = require('miniprogram-automator')

const PROJECT_PATH = path.resolve(__dirname, '../..')
const CLI_PATH = 'C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat'

// ---------------------------------------------------------------------------
// Node v24 compatibility: child_process.spawn() cannot execute .bat files
// directly (EINVAL error). Monkey-patch spawn to route .bat/.cmd through
// cmd.exe on Windows.
// ---------------------------------------------------------------------------
const _origSpawn = cp.spawn

cp.spawn = function (command, args, options) {
  if (
    process.platform === 'win32' &&
    typeof command === 'string' &&
    (command.endsWith('.bat') || command.endsWith('.cmd'))
  ) {
    return _origSpawn('cmd', ['/c', command, ...(args || [])], options || {})
  }
  return _origSpawn(command, args, options)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Launch the miniprogram in DevTools (opens project if needed, then connects).
 * Uses automator's built-in launcher which handles the full lifecycle:
 *   cli.bat auto --project <path> --auto-port <port>
 *   → WebSocket connect to the automation endpoint
 */
async function launch() {
  // First, ensure no stale DevTools is holding the project
  // (the automator will handle opening if needed)
  const mp = await automator.launcher.launch({
    cliPath: CLI_PATH,
    projectPath: PROJECT_PATH,
    timeout: 120000, // generous timeout for first launch
  })
  // Give the miniprogram time to initialize (login → redirect)
  await sleep(5000)
  return mp
}

/** Wait for a tab page (photos or notes) to appear after login redirect. */
async function waitForPhotosPage(mp) {
  for (let i = 0; i < 30; i++) {
    const page = await mp.currentPage()
    const pgPath = page.path
    if (pgPath === 'pages/photos/photos' || pgPath === 'pages/notes/notes') {
      return page
    }
    await sleep(1000)
  }
  throw new Error('Timed out waiting for photos/notes tab page')
}

/** Switch to a named tab ('photos' | 'notes'). */
async function switchToTab(mp, tab) {
  const urls = { photos: 'pages/photos/photos', notes: 'pages/notes/notes' }
  await mp.switchTab({ url: urls[tab] })
  await sleep(1500)
}

/** Navigate to a non-tab page, return the new Page. */
async function navigateTo(mp, url) {
  await mp.navigateTo({ url })
  await sleep(1500)
  return mp.currentPage()
}

/** Navigate back one level. */
async function navigateBack(mp) {
  await mp.navigateBack()
  await sleep(1000)
}

/**
 * Call a cloud function from within the miniprogram context.
 * Uses evaluate() to run wx.cloud.callFunction in the miniprogram's JS context.
 * This carries the real WeChat OPENID, critical for business handler auth.
 */
async function callCloudFunction(mp, name, data) {
  // evaluate() serializes the function via fn.toString() and args via JSON.
  // To avoid any serialization quirks, embed the call parameters directly
  // inside the function body (they're pure JSON-serializable values).
  const fnBody = `
    return new Promise(function (resolve, reject) {
      wx.cloud.callFunction({
        name: ${JSON.stringify(name)},
        data: ${JSON.stringify(data)},
        success: resolve,
        fail: reject,
      })
    })
  `
  // eslint-disable-next-line no-new-func
  const fn = new Function(fnBody)

  const raw = await mp.evaluate(fn)

  // Unwrap: wx.cloud.callFunction returns { result: { code, data, message } }
  if (raw && raw.result) return raw.result
  return raw
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Get a WX-like element by selector, with retry. */
async function waitForElement(page, selector, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const el = await page.$(selector)
    if (el) return el
    await sleep(500)
  }
  return null
}

module.exports = {
  PROJECT_PATH,
  CLI_PATH,
  launch,
  waitForPhotosPage,
  switchToTab,
  navigateTo,
  navigateBack,
  callCloudFunction,
  waitForElement,
  sleep,
}
