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
