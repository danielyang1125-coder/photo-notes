'use strict'

const { AppError } = require('./response')

const UNIQUE_CODES = new Set([-502003, 'DATABASE_DUPLICATE_KEY', 'DUPLICATE_KEY'])
const RETRYABLE_CODES = new Set([
  -502002,
  'DATABASE_TRANSACTION_CONFLICT',
  'TRANSACTION_CONFLICT',
])

function isUniqueConflict(error) {
  return Boolean(error && UNIQUE_CODES.has(error.errCode || error.code))
}

function isRetryableConflict(error) {
  return Boolean(error && RETRYABLE_CODES.has(error.errCode || error.code))
}

async function withTransactionRetry(db, operation, options = {}) {
  const maxAttempts = options.maxAttempts === undefined ? 3 : options.maxAttempts
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new AppError('INTERNAL_ERROR')
  }

  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const transaction = await db.startTransaction()
    try {
      const result = await operation(transaction, attempt)
      await transaction.commit()
      return result
    } catch (error) {
      lastError = error
      try {
        await transaction.rollback()
      } catch (_) {
        // The original error remains authoritative.
      }
      if (!isRetryableConflict(error) || attempt === maxAttempts) throw error
    }
  }
  throw lastError
}

module.exports = {
  isRetryableConflict,
  isUniqueConflict,
  withTransactionRetry,
}
