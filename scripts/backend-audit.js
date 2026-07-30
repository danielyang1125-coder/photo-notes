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
if (flattenIndexes().length !== 22) {
  infrastructureErrors.push(`index count: expected 22, received ${flattenIndexes().length}`)
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
if (!accountEntry.includes("getDeletionStatus")) {
  dev02Errors.push('account ACTIVE guard exemptions — missing getDeletionStatus')
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

const dev04Errors = []
for (const relative of [
  path.join('cloudfunctions', 'upload', 'image-processing.js'),
  path.join('test', 'backend', 'upload-confirm.test.js'),
]) {
  if (!fs.existsSync(path.join(root, relative))) {
    dev04Errors.push(`artifact: ${relative}`)
  }
}
for (const evidence of [
  'acquireConfirmLease',
  'assertPendingFile',
  'persistPromotion',
  'finalizeConfirm',
  "status: 'CONFIRMED'",
  "status: 'ACTIVE'",
  'upload_attempt_id',
  'promoted_file_id',
  'verified_meta',
]) {
  if (!uploadHandlers.includes(evidence)) {
    dev04Errors.push(`upload confirm evidence: ${evidence}`)
  }
}
const imageProcessing = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'upload', 'image-processing.js'),
  'utf8',
)
for (const evidence of [
  "return 'JPEG'",
  "return 'PNG'",
  "require('sharp')",
  'REVIEW_MAX_EDGE = 750',
  'REVIEW_MAX_BYTES = 1024 * 1024',
  "createHash('sha256')",
]) {
  if (!imageProcessing.includes(evidence)) {
    dev04Errors.push(`trusted image evidence: ${evidence}`)
  }
}
if (!uploadEntry.includes(
  "config.boolean('CONTENT_REVIEW_ENABLED')",
)) {
  dev04Errors.push('content review fail-closed configuration')
}
for (const evidence of [
  'CONTENT_REVIEW_FAILED',
  'CONTENT_REVIEW_UNAVAILABLE',
]) {
  if (!uploadEntry.includes(evidence)) {
    dev04Errors.push(`content review mapping: ${evidence}`)
  }
}
if (dev04Errors.length) {
  process.stderr.write(
    `DEV-04 audit failed:\n${dev04Errors.join('\n')}\n`,
  )
  process.exit(1)
}
process.stdout.write(
  'DEV-04 audit manifest passed (UPL-05..UPL-16, UPL-20 static scope).\n',
)

const dev05Errors = []
for (const relative of [
  path.join('cloudfunctions', 'cleanup', 'upload-compensation.js'),
  path.join('test', 'backend', 'upload-compensation.test.js'),
]) {
  if (!fs.existsSync(path.join(root, relative))) {
    dev05Errors.push(`artifact: ${relative}`)
  }
}
const uploadCompensation = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'cleanup', 'upload-compensation.js'),
  'utf8',
)
for (const evidence of [
  'expireAttempt',
  'releaseExpiredLease',
  'pending_cleaned_at',
  'active_cleaned_at',
  'TERMINAL_RETENTION_MS',
  'attempt_cleanup_cursor_idx',
  'saveCheckpoint',
]) {
  const source = evidence === 'attempt_cleanup_cursor_idx'
    ? fs.readFileSync(
      path.join(root, 'scripts', 'backend-schema.js'),
      'utf8',
    )
    : uploadCompensation
  if (!source.includes(evidence)) {
    dev05Errors.push(`upload compensation evidence: ${evidence}`)
  }
}
if (dev05Errors.length) {
  process.stderr.write(
    `DEV-05 audit failed:\n${dev05Errors.join('\n')}\n`,
  )
  process.exit(1)
}
process.stdout.write(
  'DEV-05 audit manifest passed (UPL-21..UPL-22, CLN-03..CLN-05 static scope).\n',
)

// =========================================================================
// DEV-07: 异步图片删除
// =========================================================================
const dev07Errors = []
for (const relative of [
  path.join('cloudfunctions', 'photo', 'delete-handlers.js'),
  path.join('cloudfunctions', 'cleanup', 'photo-delete-worker.js'),
  path.join('test', 'backend', 'photo-delete.test.js'),
]) {
  if (!fs.existsSync(path.join(root, relative))) {
    dev07Errors.push(`artifact: ${relative}`)
  }
}

// Check photo/index.js
const photoEntry07 = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'photo', 'index.js'),
  'utf8',
)
for (const evidence of [
  "getDeleteStatus: ({ openid, event }) =>",
  "deleteHandlers.handleDelete",
  "deleteHandlers.handleGetDeleteStatus",
  "createDeleteHandlers",
]) {
  if (!photoEntry07.includes(evidence)) {
    dev07Errors.push(`photo/index evidence: ${evidence}`)
  }
}
// Old sync delete code must NOT be present
if (photoEntry07.includes('STORAGE_DELETE_FAILED') ||
    photoEntry07.includes('DB_CLEANUP_FAILED') ||
    photoEntry07.includes("'NOT_FOUND', message: '图片不存在或已删除'") ||
    photoEntry07.includes('cloud.deleteFile({ fileList:')) {
  dev07Errors.push('photo/index: old synchronous delete code still present')
}

// Check delete-handlers.js
const deleteHandlers = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'photo', 'delete-handlers.js'),
  'utf8',
)
for (const evidence of [
  'TASK_KEY_PREFIX',
  "status: 'PENDING'",
  "current_stage: 'STORAGE_DELETE'",
  'isUniqueConflict',
  'DELETE_TASK_NOT_FOUND',
  'projectTaskStatus',
  'handleDelete',
  'handleGetDeleteStatus',
  'createDeleteHandlers',
  'findExistingTask',
]) {
  if (!deleteHandlers.includes(evidence)) {
    dev07Errors.push(`delete-handlers evidence: ${evidence}`)
  }
}

// Check photo-delete-worker.js
const photoDeleteWorker = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'cleanup', 'photo-delete-worker.js'),
  'utf8',
)
for (const evidence of [
  'STORAGE_DELETE',
  'RELATED_DATA_CLEANUP',
  'PHOTO_FINALIZE',
  'MANUAL_REQUIRED',
  'MAX_RETRIES',
  'MAX_DAYS_SINCE_APPLIED',
  'lease_token',
  'stage_cursor',
  'acquireTasks',
  'createPhotoDeleteWorker',
]) {
  if (!photoDeleteWorker.includes(evidence)) {
    dev07Errors.push(`photo-delete-worker evidence: ${evidence}`)
  }
}

// Check cleanup/index.js
const cleanupEntry07 = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'cleanup', 'index.js'),
  'utf8',
)
for (const evidence of [
  'photoDeleteWorker',
  'deleteTaskWorker',
  'TriggerName',
  'createPhotoDeleteWorker',
  'photoDeleteWorker.run',
]) {
  if (!cleanupEntry07.includes(evidence)) {
    dev07Errors.push(`cleanup/index evidence: ${evidence}`)
  }
}
if (cleanupEntry07.includes('retryFailedPhotoDeletes')) {
  dev07Errors.push('cleanup/index: old retryFailedPhotoDeletes still present')
}

if (dev07Errors.length) {
  process.stderr.write(
    `DEV-07 audit failed:\n${dev07Errors.join('\n')}\n`,
  )
  process.exit(1)
}
process.stdout.write(
  'DEV-07 audit manifest passed (BE-14, BE-15, PHD-01..PHD-12 static scope).\n',
)

// =========================================================================
// DEV-08: 备注事务、乐观锁与 Cursor
// =========================================================================
const dev08Errors = []
for (const relative of [
  path.join('cloudfunctions', 'note', 'handlers.js'),
  path.join('test', 'backend', 'note.test.js'),
]) {
  if (!fs.existsSync(path.join(root, relative))) {
    dev08Errors.push(`artifact: ${relative}`)
  }
}

// Check note/index.js
const noteEntry08 = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'note', 'index.js'),
  'utf8',
)
for (const evidence of [
  'createNoteHandlers',
  'add: ({ openid, event }) =>',
  'update: ({ openid, event }) =>',
  'delete: ({ openid, event }) =>',
  'list: ({ openid, event }) =>',
  'createBusinessMain',
  'reviewContent',
  'cursorSecret',
]) {
  if (!noteEntry08.includes(evidence)) {
    dev08Errors.push(`note/index evidence: ${evidence}`)
  }
}
// Must NOT contain old note_count manipulation
if (/note_count\s*:/u.test(noteEntry08) || /['"]note_count['"]/u.test(noteEntry08) || /_.inc\(/u.test(noteEntry08)) {
  dev08Errors.push('note/index: old note_count manipulation should be removed')
}
// Must NOT contain old inline handlers
if (noteEntry08.includes('async function handleAdd') ||
    noteEntry08.includes('async function handleUpdate') ||
    noteEntry08.includes('async function handleDelete') ||
    noteEntry08.includes('async function handleList')) {
  dev08Errors.push('note/index: old inline handlers should be removed')
}

// Check note/handlers.js
const noteHandlers08 = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'note', 'handlers.js'),
  'utf8',
)
for (const evidence of [
  'createNoteHandlers',
  'projectNote',
  'keysetCondition',
  'decodeCursor',
  'encodeCursor',
  'NOTE',
  "status: 'ACTIVE'",
  'PHOTO_NOT_FOUND',
  'NOTE_NOT_FOUND',
  'validation.isoDate',
  'validation.string',
  'reviewContent',
  'generateThumbnailUrls',
  'MAX_SCAN_MULTIPLIER',
]) {
  if (!noteHandlers08.includes(evidence)) {
    dev08Errors.push(`note/handlers evidence: ${evidence}`)
  }
}
// Must NOT contain note_count field manipulation (check for field usage, not comments)
if (/note_count\s*:/u.test(noteHandlers08) || /['"]note_count['"]/u.test(noteHandlers08) || /_.inc\(/u.test(noteHandlers08)) {
  dev08Errors.push('note/handlers: note_count manipulation should be removed (V1 simplification)')
}
// Conflict must use where({_id, _openid}) not bare doc(id)
if (noteHandlers08.includes('.doc(noteId).get()')) {
  dev08Errors.push('note/handlers: conflict read must use where({_id,_openid}) not doc(noteId)')
}
// Must not use .skip()
if (/\.skip\s*\(/u.test(noteHandlers08)) {
  dev08Errors.push('note/handlers: must not use offset pagination (.skip)')
}

// Check response.js for NOTE_NOT_FOUND
const response08 = fs.readFileSync(
  path.join(root, 'cloudfunctions', '_shared', 'response.js'),
  'utf8',
)
if (!response08.includes('NOTE_NOT_FOUND')) {
  dev08Errors.push('response: NOTE_NOT_FOUND missing from PUBLIC_MESSAGES')
}

// Check backend-check.js no longer allows note .skip()
const checkJs = fs.readFileSync(
  path.join(root, 'scripts', 'backend-check.js'),
  'utf8',
)
if (checkJs.includes("path.join('cloudfunctions', 'note', 'index.js')")) {
  dev08Errors.push('backend-check: note/index.js should be removed from skip() temporaryAllow')
}

if (dev08Errors.length) {
  process.stderr.write(
    `DEV-08 audit failed:\n${dev08Errors.join('\n')}\n`,
  )
  process.exit(1)
}
process.stdout.write(
  'DEV-08 audit manifest passed (BE-16, BE-17 static scope).\n',
)

// =========================================================================
// DEV-12: cleanup 编排、安全与可观测性收口
// =========================================================================
const dev12Errors = []

// Check task-lease.js shared module exists
for (const relative of [
  path.join('cloudfunctions', 'cleanup', 'task-lease.js'),
  path.join('scripts', 'backend-task-inspect.js'),
  path.join('scripts', 'backend-task-retry.js'),
  path.join('scripts', 'backend-log-audit.js'),
]) {
  if (!fs.existsSync(path.join(root, relative))) {
    dev12Errors.push(`artifact: ${relative}`)
  }
}

// Check task-lease.js exports all required functions and constants
const taskLeaseSource = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'cleanup', 'task-lease.js'),
  'utf8',
)
for (const evidence of [
  'async function acquireTasks',
  'async function renewLease',
  'async function releaseLease',
  'async function failTask',
  'function calculateBackoff',
  'function toDate',
  'LEASE_TTL_MS',
  'LEASE_RENEW_INTERVAL_MS',
  'MAX_RETRIES',
  'MAX_DAYS_SINCE_APPLIED',
  'DISPATCHABLE_STATUSES',
  'module.exports',
]) {
  if (!taskLeaseSource.includes(evidence)) {
    dev12Errors.push(`task-lease missing: ${evidence}`)
  }
}

// Check photo-delete-worker imports from task-lease
const pdw = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'cleanup', 'photo-delete-worker.js'),
  'utf8',
)
for (const evidence of [
  "require('./task-lease')",
  'renewLease',
  'maybeRenewLease',
  'manualRequired',
  'releaseLease({ db, task, now: ts })',
]) {
  if (!pdw.includes(evidence)) {
    dev12Errors.push(`photo-delete-worker evidence: ${evidence}`)
  }
}

// Check account-delete-worker imports from task-lease
const adw = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'cleanup', 'account-delete-worker.js'),
  'utf8',
)
for (const evidence of [
  "require('./task-lease')",
  'renewLease',
  'maybeRenewLease',
  'manualRequired',
  'releaseLease({ db, task, now: ts })',
  'refreshFn: refreshTask',
]) {
  if (!adw.includes(evidence)) {
    dev12Errors.push(`account-delete-worker evidence: ${evidence}`)
  }
}

// Check cleanup/index.js has TriggerName dispatch and security summaries
const cleanupIndex = fs.readFileSync(
  path.join(root, 'cloudfunctions', 'cleanup', 'index.js'),
  'utf8',
)
for (const evidence of [
  'runWorker',
  'TriggerName',
  'deleteTaskWorker',
  'manualRequiredTaskCount',
  'countManualRequiredTasks',
  'handleDeleteTaskWorker',
  'countBucket',
  'startTime',
  'endTime',
]) {
  if (!cleanupIndex.includes(evidence)) {
    dev12Errors.push(`cleanup/index evidence: ${evidence}`)
  }
}

// Check that both workers are wired in both trigger paths
if (!cleanupIndex.includes("trigger: 'deleteTaskWorker'") ||
    !cleanupIndex.includes("trigger: 'dailyCleanup'")) {
  dev12Errors.push('cleanup/index: trigger context in summary')
}

// Check backend-check.js has security patterns
const backendCheck = fs.readFileSync(
  path.join(root, 'scripts', 'backend-check.js'),
  'utf8',
)
for (const evidence of [
  "OPENID string literal",
  '_openid in response construction',
  'securityPatterns',
  'requireResponseContext',
]) {
  if (!backendCheck.includes(evidence)) {
    dev12Errors.push(`backend-check security evidence: ${evidence}`)
  }
}

// Check backend-check.js no longer has stale temporary exceptions
// (verify note/index.js and photo/index.js exceptions are documented)
if (backendCheck.includes("path.join('cloudfunctions', 'note', 'index.js')")) {
  dev12Errors.push('backend-check: stale note/index.js temporary exception')
}

// Check backend-log-audit.js key functions and patterns exist
const logAuditSource = fs.readFileSync(
  path.join(root, 'scripts', 'backend-log-audit.js'),
  'utf8',
)
for (const evidence of [
  'extractLogFields',
  'extractFieldNames',
  'ALLOWED_FIELDS',
  'logger',
]) {
  if (!logAuditSource.includes(evidence)) {
    dev12Errors.push(`backend-log-audit missing: ${evidence}`)
  }
}

// Check backend-task-inspect.js and backend-task-retry.js key patterns
for (const [script, evidences] of [
  ['backend-task-inspect', ['taskIdHash', 'safeTaskProjection', 'SAFE_ENV_PATTERN', 'aggregate']],
  ['backend-task-retry', ['taskIdHash', 'SAFE_ENV_PATTERN', 'MANUAL_REQUIRED', 'allManualRequired']],
]) {
  const source = fs.readFileSync(
    path.join(root, 'scripts', `${script}.js`),
    'utf8',
  )
  for (const evidence of evidences) {
    if (!source.includes(evidence)) {
      dev12Errors.push(`${script} missing: ${evidence}`)
    }
  }
}

// Verify test files exist
for (const relative of [
  path.join('test', 'backend', 'task-lease.test.js'),
  path.join('test', 'backend', 'cleanup-orchestration.test.js'),
]) {
  if (!fs.existsSync(path.join(root, relative))) {
    dev12Errors.push(`test artifact: ${relative}`)
  }
}

if (dev12Errors.length) {
  process.stderr.write(
    `DEV-12 audit failed:\n${dev12Errors.join('\n')}\n`,
  )
  process.exit(1)
}
process.stdout.write(
  'DEV-12 audit manifest passed (BE-24, BE-25, CLN, COM-10..COM-12 static scope).\n',
)
