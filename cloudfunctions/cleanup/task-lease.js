'use strict'

// ---------------------------------------------------------------------------
// Shared task lease, retry, and backoff utilities for cleanup workers.
//
// Used by photo-delete-worker and account-delete-worker to eliminate
// duplicated lease-acquisition, release, and failTask logic.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LEASE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const LEASE_RENEW_INTERVAL_MS = 2 * 60 * 1000 // renew every 2 minutes
const MAX_RETRIES = 10
const MAX_DAYS_SINCE_APPLIED = 7

const DISPATCHABLE_STATUSES = ['PENDING', 'RETRYING']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toDate(value) {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

function calculateBackoff(retryCount) {
  // Exponential backoff: min(60s * 2^n, 24h)
  return Math.min(60000 * Math.pow(2, retryCount), 86400000)
}

// ---------------------------------------------------------------------------
// Acquire dispatchable tasks with lease
//
// Queries for PENDING/RETRYING tasks (with ready next_retry_at) and
// PROCESSING tasks (with expired lease), deduplicates, and atomically
// claims each via a random lease_token.
//
// Returns only tasks where our update succeeded (stats.updated > 0).
// ---------------------------------------------------------------------------
async function acquireTasks({ db, type, now: nowFn, batchSize = 10 }) {
  const ts = nowFn instanceof Date ? nowFn : new Date(nowFn)
  const tasksCol = db.collection('deletion_tasks')
  const _ = db.command

  // Query 1: PENDING / RETRYING where next_retry_at is ready
  const condition1 = {
    type,
    status: _.in(DISPATCHABLE_STATUSES),
    next_retry_at: _.or([_.eq(null), _.lte(ts)]),
  }
  const q1 = await tasksCol.where(condition1).limit(batchSize).get()
  const candidates1 = Array.isArray(q1.data) ? q1.data : []

  // Query 2: Expired PROCESSING leases
  const condition2 = {
    type,
    status: 'PROCESSING',
    lease_expire_at: _.and([_.neq(null), _.lt(ts)]),
  }
  const q2 = await tasksCol.where(condition2).limit(batchSize).get()
  const candidates2 = Array.isArray(q2.data) ? q2.data : []

  // Deduplicate by _id
  const seen = new Set()
  const candidates = []
  for (const t of [...candidates1, ...candidates2]) {
    if (!seen.has(t._id)) {
      seen.add(t._id)
      candidates.push(t)
    }
  }

  if (candidates.length === 0) return []

  // Atomic lease acquisition – each update competes independently.
  // Only keep tasks where our update succeeded.
  const leaseExpireAt = new Date(ts.getTime() + LEASE_TTL_MS)
  const results = await Promise.allSettled(
    candidates.map(async (task) => {
      const leaseToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const updateResult = await tasksCol
        .where({ _id: task._id })
        .update({
          data: {
            status: 'PROCESSING',
            lease_token: leaseToken,
            lease_expire_at: leaseExpireAt,
            updated_at: ts,
          },
        })

      return updateResult.stats && updateResult.stats.updated > 0
        ? { ...task, _lease_token: leaseToken }
        : null
    }),
  )

  return results
    .filter((r) => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value)
}

// ---------------------------------------------------------------------------
// Renew lease mid-batch
//
// Extends lease_expire_at by LEASE_TTL_MS.  Only succeeds if this worker
// still holds the lease_token.  Called periodically during long-running
// stages to prevent other workers from stealing the task.
//
// Returns true if the lease was renewed, false otherwise.
// ---------------------------------------------------------------------------
async function renewLease({ db, task, now: nowFn }) {
  const ts = nowFn instanceof Date ? nowFn : new Date(nowFn)
  const leaseExpireAt = new Date(ts.getTime() + LEASE_TTL_MS)
  const leaseToken = task._lease_token
  if (!leaseToken) return false

  try {
    const result = await db
      .collection('deletion_tasks')
      .where({
        _id: task._id,
        lease_token: leaseToken,
      })
      .update({
        data: {
          lease_expire_at: leaseExpireAt,
          updated_at: ts,
        },
      })
    return result.stats && result.stats.updated > 0
  } catch (_) {
    return false
  }
}

// ---------------------------------------------------------------------------
// Release lease
//
// Sets task back to PENDING so other worker invocations can pick it up.
// Clears lease_token, lease_expire_at, and next_retry_at.
// ---------------------------------------------------------------------------
async function releaseLease({ db, task, now: nowFn }) {
  const ts = nowFn instanceof Date ? nowFn : new Date(nowFn)
  await db
    .collection('deletion_tasks')
    .doc(task._id)
    .update({
      data: {
        status: 'PENDING',
        lease_token: null,
        lease_expire_at: null,
        next_retry_at: null,
        updated_at: ts,
      },
    })
}

// ---------------------------------------------------------------------------
// Error handling: RETRYING or MANUAL_REQUIRED
//
// Reads latest retry_count, applies exponential backoff.  Escalates to
// MANUAL_REQUIRED after MAX_RETRIES (10) or MAX_DAYS_SINCE_APPLIED (7).
// ---------------------------------------------------------------------------
async function failTask({
  db,
  task,
  error,
  now: nowFn,
  maxRetries = MAX_RETRIES,
  maxDays = MAX_DAYS_SINCE_APPLIED,
  refreshFn,
}) {
  const ts = nowFn instanceof Date ? nowFn : new Date(nowFn)

  // Re-read to get current retry_count (may have been incremented by
  // another stage failure within the same run)
  let current = task
  if (typeof refreshFn === 'function') {
    try {
      current = (await refreshFn(task)) || task
    } catch (_) {
      current = task
    }
  } else {
    try {
      const fresh = await db
        .collection('deletion_tasks')
        .doc(task._id)
        .get()
      current =
        fresh && fresh.data
          ? Array.isArray(fresh.data)
            ? fresh.data[0]
            : fresh.data
          : task
    } catch (_) {
      current = task
    }
  }

  const retryCount = (current.retry_count || 0) + 1
  const appliedAt = toDate(current.applied_at)
  const daysSinceApplied = appliedAt
    ? (ts.getTime() - appliedAt.getTime()) / 86400000
    : 0

  const safeCode =
    (error && (error.code || error.safeErrorCode)) || 'INTERNAL_ERROR'

  if (retryCount >= maxRetries || daysSinceApplied >= maxDays) {
    // Terminal: MANUAL_REQUIRED
    await db
      .collection('deletion_tasks')
      .doc(task._id)
      .update({
        data: {
          status: 'MANUAL_REQUIRED',
          lease_token: null,
          lease_expire_at: null,
          retry_count: retryCount,
          last_error: safeCode,
          last_error_at: ts,
          updated_at: ts,
        },
      })
  } else {
    // Retry with exponential backoff
    const backoffMs = calculateBackoff(retryCount)
    const nextRetryAt = new Date(ts.getTime() + backoffMs)

    await db
      .collection('deletion_tasks')
      .doc(task._id)
      .update({
        data: {
          status: 'RETRYING',
          lease_token: null,
          lease_expire_at: null,
          retry_count: retryCount,
          next_retry_at: nextRetryAt,
          last_error: safeCode,
          last_error_at: ts,
          updated_at: ts,
        },
      })
  }
}

module.exports = {
  // Constants
  LEASE_TTL_MS,
  LEASE_RENEW_INTERVAL_MS,
  MAX_RETRIES,
  MAX_DAYS_SINCE_APPLIED,
  DISPATCHABLE_STATUSES,

  // Functions
  acquireTasks,
  renewLease,
  releaseLease,
  failTask,
  calculateBackoff,
  toDate,
}
