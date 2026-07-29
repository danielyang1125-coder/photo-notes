'use strict'

const { AppError } = require('./response')

function requiredString(name, env = process.env) {
  const value = env[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('INTERNAL_ERROR')
  }
  return value
}

function boolean(name, options = {}) {
  const env = options.env || process.env
  const fallback = options.defaultValue
  const value = env[name]
  if (value === undefined || value === '') {
    if (fallback !== undefined) return Boolean(fallback)
    throw new AppError('INTERNAL_ERROR')
  }
  if (value === 'true') return true
  if (value === 'false') return false
  throw new AppError('INTERNAL_ERROR')
}

module.exports = {
  boolean,
  requiredString,
}
