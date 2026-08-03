'use strict'

const crypto = require('crypto')
const { AppError } = require('./response')

const CURSOR_VERSION = 1

function base64url(value) {
  return Buffer.from(value).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '')
}

function fromBase64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new AppError('INVALID_CURSOR')
  }
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + padding, 'base64')
}

function signature(payload, secret) {
  return base64url(crypto.createHmac('sha256', secret).update(payload).digest())
}

function assertSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new AppError('INTERNAL_ERROR')
  }
}

function encodeCursor(data, secret) {
  assertSecret(secret)
  const payload = base64url(JSON.stringify({ v: CURSOR_VERSION, ...data }))
  return `${payload}.${signature(payload, secret)}`
}

function decodeCursor(value, expected, secret) {
  assertSecret(secret)
  try {
    const parts = String(value).split('.')
    if (parts.length !== 2) throw new AppError('INVALID_CURSOR')
    const expectedSignature = signature(parts[0], secret)
    const actual = Buffer.from(parts[1])
    const wanted = Buffer.from(expectedSignature)
    if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) {
      throw new AppError('INVALID_CURSOR')
    }
    const decoded = JSON.parse(fromBase64url(parts[0]).toString('utf8'))
    if (!decoded || decoded.v !== CURSOR_VERSION) throw new AppError('INVALID_CURSOR')
    for (const [key, expectedValue] of Object.entries(expected || {})) {
      if (decoded[key] !== expectedValue) throw new AppError('INVALID_CURSOR')
    }
    // 将 JSON 序列化丢失类型的 Date 字段还原为 Date 对象
    // （JSON.stringify 把 Date → ISO string，JSON.parse 不会自动还原，
    //   导致 CloudBase 查询中 Date 字段与字符串比较时类型不匹配）
    if (decoded.lastValue && typeof decoded.lastValue === 'string') {
      const d = new Date(decoded.lastValue)
      if (!isNaN(d.getTime())) {
        decoded.lastValue = d
      }
    }
    return decoded
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('INVALID_CURSOR')
  }
}

function keysetCondition(command, field, order, lastValue, lastId) {
  const compare = order === 'asc' ? command.gt : command.lt
  if (typeof compare !== 'function') throw new AppError('INTERNAL_ERROR')
  return command.or([
    { [field]: compare(lastValue) },
    { [field]: command.eq(lastValue), _id: compare(lastId) },
  ])
}

module.exports = {
  CURSOR_VERSION,
  decodeCursor,
  encodeCursor,
  keysetCondition,
}
