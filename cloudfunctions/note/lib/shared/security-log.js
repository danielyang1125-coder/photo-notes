'use strict'

const crypto = require('crypto')

const ALLOWED_FIELDS = new Set([
  'event',
  'result',
  'safeErrorCode',
  'durationMs',
  'countBucket',
  'requestIdHash',
  'resourceHash',
  'timestamp',
])

const SAFE_RESULTS = new Set(['SUCCESS', 'FAILURE', 'REJECTED', 'RETRY'])

function digest(value, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return undefined
  if (value === undefined || value === null || value === '') return undefined
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex')
}

function countBucket(count) {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count === 1) return '1'
  if (count <= 5) return '2-5'
  if (count <= 20) return '6-20'
  if (count <= 100) return '21-100'
  return '100+'
}

function sanitize(fields, clock = Date) {
  const result = {}
  for (const [key, value] of Object.entries(fields || {})) {
    if (!ALLOWED_FIELDS.has(key) || value === undefined) continue
    if (key === 'durationMs') {
      result[key] = Math.max(0, Math.round(Number(value) || 0))
    } else if (key === 'result') {
      result[key] = SAFE_RESULTS.has(value) ? value : 'FAILURE'
    } else {
      result[key] = String(value)
    }
  }
  if (!result.timestamp) result.timestamp = new clock().toISOString()
  return result
}

function createSecurityLogger(options = {}) {
  const sink = options.sink || console
  const clock = options.clock || Date
  function write(level, fields) {
    const record = sanitize(fields, clock)
    const method = level === 'error' ? 'error' : 'log'
    if (sink && typeof sink[method] === 'function') sink[method](JSON.stringify(record))
    return record
  }
  return {
    info: (fields) => write('info', fields),
    error: (fields) => write('error', fields),
  }
}

module.exports = {
  ALLOWED_FIELDS,
  countBucket,
  createSecurityLogger,
  digest,
  sanitize,
}
