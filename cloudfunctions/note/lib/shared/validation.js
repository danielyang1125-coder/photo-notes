'use strict'

const { AppError } = require('./response')

function invalid() {
  throw new AppError('VALIDATION_ERROR')
}

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value
}

function string(value, options = {}) {
  if (typeof value !== 'string') invalid()
  const normalized = options.trim === false ? value : value.trim()
  const length = Array.from(normalized).length
  if (options.min !== undefined && length < options.min) invalid()
  if (options.max !== undefined && length > options.max) invalid()
  if (options.pattern && !options.pattern.test(normalized)) invalid()
  return normalized
}

function enumValue(value, allowed) {
  if (!Array.isArray(allowed) || !allowed.includes(value)) invalid()
  return value
}

function array(value, options = {}) {
  if (!Array.isArray(value)) invalid()
  if (options.min !== undefined && value.length < options.min) invalid()
  if (options.max !== undefined && value.length > options.max) invalid()
  const result = options.unique ? [...new Set(value)] : value.slice()
  if (options.item) return result.map(options.item)
  return result
}

function isoDate(value) {
  if (typeof value !== 'string' || !value) invalid()
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid()
  return date
}

function requestId(value) {
  return string(value, {
    min: 1,
    max: 128,
    pattern: /^[A-Za-z0-9._:-]+$/,
  })
}

function optional(value, validator) {
  return value === undefined || value === null ? undefined : validator(value)
}

module.exports = {
  array,
  enumValue,
  isoDate,
  optional,
  requestId,
  requireObject,
  string,
}
