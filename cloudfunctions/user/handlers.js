'use strict'

const { AppError, success } = require('./lib/shared/response')
const { isUniqueConflict } = require('./lib/shared/transaction')

const DEFAULT_LIMIT_BYTES = 500 * 1024 * 1024
const USER_STATUSES = new Set(['ACTIVE', 'DELETING', 'DELETED'])

function normalizeUsedBytes(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function normalizeLimitBytes(value) {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_LIMIT_BYTES
}

function projectUser(user) {
  if (!user || !USER_STATUSES.has(user.status)) {
    throw new AppError('INTERNAL_ERROR')
  }
  return {
    status: user.status,
    used_bytes: normalizeUsedBytes(user.used_bytes),
    limit_bytes: normalizeLimitBytes(user.limit_bytes),
  }
}

async function readUser(users, openid) {
  const result = await users
    .where({ _id: openid, _openid: openid })
    .limit(1)
    .get()
  return result && Array.isArray(result.data) && result.data.length > 0
    ? result.data[0]
    : null
}

function createUserHandlers(options) {
  const { db, now = () => db.serverDate() } = options
  const users = db.collection('users')

  async function login(openid) {
    const existing = await readUser(users, openid)
    if (existing) {
      return success({
        user: projectUser(existing),
        isNewUser: false,
      })
    }

    const timestamp = now()
    const newUser = {
      _id: openid,
      _openid: openid,
      status: 'ACTIVE',
      used_bytes: 0,
      limit_bytes: DEFAULT_LIMIT_BYTES,
      created_at: timestamp,
      updated_at: timestamp,
    }

    try {
      await users.add({ data: newUser })
      return success({
        user: projectUser(newUser),
        isNewUser: true,
      })
    } catch (error) {
      if (!isUniqueConflict(error)) throw error
      const winner = await readUser(users, openid)
      if (!winner) throw new AppError('INTERNAL_ERROR')
      return success({
        user: projectUser(winner),
        isNewUser: false,
      })
    }
  }

  async function getStatus(openid) {
    const user = await readUser(users, openid)
    if (!user) throw new AppError('NOT_FOUND')
    return success({ status: projectUser(user).status })
  }

  async function getSpaceUsage(openid) {
    const user = await readUser(users, openid)
    if (!user || user.status !== 'ACTIVE') {
      throw new AppError('USER_NOT_ACTIVE')
    }
    const projected = projectUser(user)
    const full = projected.used_bytes >= projected.limit_bytes
    return success({
      used_bytes: projected.used_bytes,
      limit_bytes: projected.limit_bytes,
      warning: !full &&
        projected.used_bytes / projected.limit_bytes >= 0.85,
      full,
    })
  }

  return {
    getSpaceUsage,
    getStatus,
    login,
  }
}

module.exports = {
  DEFAULT_LIMIT_BYTES,
  createUserHandlers,
  projectUser,
}
