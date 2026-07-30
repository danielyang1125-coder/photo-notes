'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

// ---------------------------------------------------------------------------
// Test the orchestration patterns used in cleanup/index.js without
// requiring it directly (it depends on wx-server-sdk / cloud.init).
//
// We test the error isolation, summary structure, and trigger dispatch
// logic by replicating the core patterns from index.js.
// ---------------------------------------------------------------------------

// Replicated from cleanup/index.js — this is the same runWorker pattern
async function runWorker(name, workerFn) {
  try {
    const result = await workerFn()
    return { status: 'OK', ...(result && typeof result === 'object' ? result : { data: result }) }
  } catch (_) {
    return { status: 'ERROR', errorCode: 'INTERNAL_ERROR' }
  }
}

// Replicated pickHandler pattern
function pickHandler(triggerName, handleCleanup, handleDeleteTaskWorker) {
  if (triggerName === 'deleteTaskWorker') {
    return handleDeleteTaskWorker()
  }
  return handleCleanup()
}

// ---------------------------------------------------------------------------
// Error isolation tests
// ---------------------------------------------------------------------------
test('runWorker returns OK when worker succeeds', async () => {
  const result = await runWorker('testWorker', async () => ({
    processed: 5,
    succeeded: 5,
    failed: 0,
  }))
  assert.equal(result.status, 'OK')
  assert.equal(result.processed, 5)
  assert.equal(result.succeeded, 5)
  assert.equal(result.failed, 0)
})

test('runWorker returns ERROR when worker throws', async () => {
  const result = await runWorker('badWorker', async () => {
    throw new Error('boom')
  })
  assert.equal(result.status, 'ERROR')
  assert.equal(result.errorCode, 'INTERNAL_ERROR')
})

test('runWorker returns OK with data wrapper for non-object results', async () => {
  const result = await runWorker('simpleWorker', async () => 42)
  assert.equal(result.status, 'OK')
  assert.equal(result.data, 42)
})

test('one worker failure does not block other workers', async () => {
  const results = {}
  let goodRan = false

  // Bad worker throws
  results.bad = await runWorker('badWorker', async () => {
    throw new Error('boom')
  })

  // Good worker still runs and succeeds
  results.good = await runWorker('goodWorker', async () => {
    goodRan = true
    return { done: true }
  })

  assert.ok(goodRan)
  assert.equal(results.bad.status, 'ERROR')
  assert.equal(results.good.status, 'OK')
  assert.equal(results.good.done, true)
})

test('multiple independent workers all run even if some fail', async () => {
  const workers = [
    { name: 'w1', fn: async () => ({ ok: 1 }) },
    { name: 'w2', fn: async () => { throw new Error('fail') } },
    { name: 'w3', fn: async () => ({ ok: 3 }) },
    { name: 'w4', fn: async () => { throw new Error('also fail') } },
  ]

  const results = {}
  for (const w of workers) {
    results[w.name] = await runWorker(w.name, w.fn)
  }

  assert.equal(results.w1.status, 'OK')
  assert.equal(results.w2.status, 'ERROR')
  assert.equal(results.w3.status, 'OK')
  assert.equal(results.w4.status, 'ERROR')
})

// ---------------------------------------------------------------------------
// Summary structure tests
// ---------------------------------------------------------------------------
test('orchestration summary includes all workers with structured results', async () => {
  const summary = {
    trigger: 'dailyCleanup',
    startTime: new Date().toISOString(),
    workers: {},
  }

  summary.workers.photoDeleteWorker = await runWorker(
    'photoDeleteWorker',
    async () => ({ acquired: 3, succeeded: 2, failed: 1, manualRequired: 0 }),
  )
  summary.workers.orphanRelations = await runWorker(
    'orphanRelations',
    async () => ({ processed: 100, deleted: 5 }),
  )

  // Verify structure
  assert.equal(summary.workers.photoDeleteWorker.status, 'OK')
  assert.equal(summary.workers.photoDeleteWorker.acquired, 3)
  assert.equal(summary.workers.photoDeleteWorker.succeeded, 2)
  assert.equal(summary.workers.orphanRelations.status, 'OK')
  assert.equal(summary.workers.orphanRelations.processed, 100)
})

test('summary includes failed workers without blocking', async () => {
  const summary = { workers: {} }

  summary.workers.good = await runWorker('good', async () => ({ ok: true }))
  summary.workers.bad = await runWorker('bad', async () => {
    throw new Error('test failure')
  })

  assert.equal(summary.workers.good.status, 'OK')
  assert.equal(summary.workers.bad.status, 'ERROR')
  assert.equal(summary.workers.bad.errorCode, 'INTERNAL_ERROR')
})

// ---------------------------------------------------------------------------
// Trigger dispatch tests
// ---------------------------------------------------------------------------
test('pickHandler dispatches to deleteTaskWorker on matching trigger', async () => {
  let deleteCalled = false
  let cleanupCalled = false

  const result = await pickHandler(
    'deleteTaskWorker',
    async () => { cleanupCalled = true; return { type: 'daily' } },
    async () => { deleteCalled = true; return { type: 'deleteTask' } },
  )

  assert.ok(deleteCalled)
  assert.equal(cleanupCalled, false)
  assert.equal(result.type, 'deleteTask')
})

test('pickHandler dispatches to handleCleanup on dailyCleanup trigger', async () => {
  let deleteCalled = false
  let cleanupCalled = false

  const result = await pickHandler(
    'dailyCleanup',
    async () => { cleanupCalled = true; return { type: 'daily' } },
    async () => { deleteCalled = true; return { type: 'deleteTask' } },
  )

  assert.ok(cleanupCalled)
  assert.equal(deleteCalled, false)
  assert.equal(result.type, 'daily')
})

test('pickHandler dispatches to handleCleanup on unknown trigger', async () => {
  let deleteCalled = false
  let cleanupCalled = false

  const result = await pickHandler(
    '',
    async () => { cleanupCalled = true; return { type: 'daily' } },
    async () => { deleteCalled = true; return { type: 'deleteTask' } },
  )

  assert.ok(cleanupCalled)
  assert.equal(deleteCalled, false)
  assert.equal(result.type, 'daily')
})

test('pickHandler dispatches to handleCleanup on null trigger', async () => {
  let cleanupCalled = false

  const result = await pickHandler(
    null,
    async () => { cleanupCalled = true; return { default: true } },
    async () => { throw new Error('should not be called') },
  )

  assert.ok(cleanupCalled)
})

// ---------------------------------------------------------------------------
// MANUAL_REQUIRED counting test
// ---------------------------------------------------------------------------
test('summary counts MANUAL_REQUIRED from worker results', async () => {
  const workers = {}

  workers.photoDeleteWorker = await runWorker(
    'photoDeleteWorker',
    async () => ({ acquired: 5, succeeded: 3, failed: 1, manualRequired: 1 }),
  )
  workers.accountDeleteWorker = await runWorker(
    'accountDeleteWorker',
    async () => ({ acquired: 2, succeeded: 2, failed: 0, manualRequired: 0 }),
  )

  // Aggregate manualRequired from all workers
  const totalManualRequired =
    (workers.photoDeleteWorker.manualRequired || 0) +
    (workers.accountDeleteWorker.manualRequired || 0)

  assert.equal(totalManualRequired, 1)
  assert.equal(workers.photoDeleteWorker.manualRequired, 1)
  assert.equal(workers.accountDeleteWorker.manualRequired, 0)
})

// ---------------------------------------------------------------------------
// Worker result forwarding
// ---------------------------------------------------------------------------
test('runWorker forwards all worker result fields', async () => {
  const complexResult = {
    acquired: 10,
    succeeded: 8,
    failed: 1,
    manualRequired: 1,
    details: [
      { taskId: 't1', stages: { storageDelete: 'OK', relatedDataCleanup: 'OK', photoFinalize: 'OK' } },
      { taskId: 't2', stages: { storageDelete: 'OK' }, error: 'INTERNAL_ERROR' },
    ],
  }

  const result = await runWorker('complex', async () => complexResult)
  assert.equal(result.status, 'OK')
  assert.equal(result.acquired, 10)
  assert.equal(result.succeeded, 8)
  assert.equal(result.failed, 1)
  assert.equal(result.manualRequired, 1)
  assert.equal(result.details.length, 2)
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
test('runWorker handles undefined/null return from worker', async () => {
  const result1 = await runWorker('nullWorker', async () => null)
  assert.equal(result1.status, 'OK')
  assert.equal(result1.data, null)

  const result2 = await runWorker('voidWorker', async () => {})
  assert.equal(result2.status, 'OK')
  assert.equal(result2.data, undefined)
})

test('runWorker handles string return from worker', async () => {
  const result = await runWorker('strWorker', async () => 'done')
  assert.equal(result.status, 'OK')
  assert.equal(result.data, 'done')
})

test('runWorker preserves error isolation for async rejections', async () => {
  const result = await runWorker('rejectWorker', async () => {
    return Promise.reject(new Error('async fail'))
  })
  assert.equal(result.status, 'ERROR')
  assert.equal(result.errorCode, 'INTERNAL_ERROR')
})
