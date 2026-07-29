'use strict'

const fs = require('fs')
const path = require('path')
const { COLLECTIONS, flattenIndexes } = require('./backend-schema')

const root = path.resolve(__dirname, '..')
const requiredFunctions = ['user', 'upload', 'photo', 'note', 'tag', 'account', 'cleanup']
const requiredShared = [
  'auth.js',
  'config.js',
  'cursor.js',
  'response.js',
  'router.js',
  'security-log.js',
  'transaction.js',
  'validation.js',
]

const missing = []
for (const name of requiredFunctions) {
  if (!fs.existsSync(path.join(root, 'cloudfunctions', name, 'index.js'))) {
    missing.push(`cloud function: ${name}`)
  }
}
for (const name of requiredShared) {
  if (!fs.existsSync(path.join(root, 'cloudfunctions', '_shared', name))) {
    missing.push(`shared module: ${name}`)
  }
}
if (!fs.existsSync(path.join(root, 'test', 'backend'))) missing.push('backend tests')

if (missing.length) {
  process.stderr.write(`DEV-00 audit failed:\n${missing.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('DEV-00 audit manifest passed (COM-01..COM-10, COM-12 foundation).\n')

const infrastructureErrors = []
if (COLLECTIONS.length !== 7) {
  infrastructureErrors.push(`collection count: expected 7, received ${COLLECTIONS.length}`)
}
if (flattenIndexes().length !== 21) {
  infrastructureErrors.push(`index count: expected 21, received ${flattenIndexes().length}`)
}
const uniqueIndexes = flattenIndexes()
  .filter((index) => index.unique)
  .map((index) => index.name)
if (uniqueIndexes.length !== 6) {
  infrastructureErrors.push(
    `unique index count: expected 6, received ${uniqueIndexes.length}`,
  )
}

const cleanupConfig = JSON.parse(
  fs.readFileSync(
    path.join(root, 'cloudfunctions', 'cleanup', 'config.json'),
    'utf8',
  ),
)
const triggerNames = new Set(
  (cleanupConfig.triggers || []).map((trigger) => trigger.name),
)
for (const name of ['deleteTaskWorker', 'dailyCleanup']) {
  if (!triggerNames.has(name)) infrastructureErrors.push(`trigger: ${name}`)
}

for (const relative of [
  path.join('config', 'backend-runtime.env.example'),
  path.join('docs', 'BACKEND-CLOUD-ACCEPTANCE-DEV-01.md'),
  path.join('docs', 'DATABASE-SETUP-CHECKLIST.md'),
]) {
  if (!fs.existsSync(path.join(root, relative))) {
    infrastructureErrors.push(`artifact: ${relative}`)
  }
}

if (infrastructureErrors.length) {
  process.stderr.write(
    `DEV-01 audit failed:\n${infrastructureErrors.join('\n')}\n`,
  )
  process.exit(1)
}
process.stdout.write(
  'DEV-01 audit manifest passed (INF-01..INF-12, UPL-17, CLN-01 static scope).\n',
)

const dev02Errors = []
for (const relative of [
  path.join('cloudfunctions', 'user', 'handlers.js'),
  path.join('test', 'backend', 'user.test.js'),
]) {
  if (!fs.existsSync(path.join(root, relative))) {
    dev02Errors.push(`artifact: ${relative}`)
  }
}

const userEntry = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'user', 'index.js'),
  'utf8',
)
if (!userEntry.includes(
  "activeGuardExempt: ['login', 'getStatus', 'healthCheck']",
)) {
  dev02Errors.push('user ACTIVE guard exemptions')
}
const accountEntry = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'account', 'index.js'),
  'utf8',
)
if (!accountEntry.includes("activeGuardExempt: ['getDeletionStatus']")) {
  dev02Errors.push('account ACTIVE guard exemptions')
}
for (const domain of ['upload', 'photo', 'note', 'tag']) {
  const entry = fs.readFileSync(
    path.join(root, 'cloudfunctions', domain, 'index.js'),
    'utf8',
  )
  if (!entry.includes('createBusinessMain({') ||
      entry.includes('activeGuard: false')) {
    dev02Errors.push(`${domain} ACTIVE guard`)
  }
}
if (dev02Errors.length) {
  process.stderr.write(
    `DEV-02 audit failed:\n${dev02Errors.join('\n')}\n`,
  )
  process.exit(1)
}
process.stdout.write(
  'DEV-02 audit manifest passed (USR-01..USR-06, COM-04..COM-07 static scope).\n',
)

const dev03Errors = []
for (const relative of [
  path.join('cloudfunctions', 'upload', 'handlers.js'),
  path.join('test', 'backend', 'upload-attempt.test.js'),
]) {
  if (!fs.existsSync(path.join(root, relative))) {
    dev03Errors.push(`artifact: ${relative}`)
  }
}

const uploadEntry = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'upload', 'index.js'),
  'utf8',
)
for (const route of ['prepare', 'cancel']) {
  if (!uploadEntry.includes(`${route}: ({ openid, event })`)) {
    dev03Errors.push(`upload route: ${route}`)
  }
}

const uploadHandlers = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'upload', 'handlers.js'),
  'utf8',
)
for (const evidence of [
  'crypto.randomBytes(16)',
  'uploads/pending/${normalizeRandomHex(randomHex)}.bin',
  'ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000',
  "status: 'PREPARED'",
  "status: 'CANCELED'",
  'withTransactionRetry',
  '_openid: openid',
  'task_id: taskId',
]) {
  if (!uploadHandlers.includes(evidence)) {
    dev03Errors.push(`upload attempt evidence: ${evidence}`)
  }
}

if (dev03Errors.length) {
  process.stderr.write(
    `DEV-03 audit failed:\n${dev03Errors.join('\n')}\n`,
  )
  process.exit(1)
}
process.stdout.write(
  'DEV-03 audit manifest passed (UPL-01..UPL-04, UPL-18..UPL-19 static scope).\n',
)
