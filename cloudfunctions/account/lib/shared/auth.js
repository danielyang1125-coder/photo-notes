'use strict'

const { AppError } = require('./response')

function getOpenId(cloud) {
  const context = cloud && typeof cloud.getWXContext === 'function'
    ? cloud.getWXContext()
    : null
  const openid = context && context.OPENID
  if (typeof openid !== 'string' || !openid) {
    throw new AppError('AUTH_FAILED')
  }
  return openid
}

async function requireActiveUser(db, openid) {
  let result
  try {
    result = await db.collection('users').doc(openid).get()
  } catch (_) {
    throw new AppError('USER_NOT_ACTIVE')
  }
  if (!result || !result.data || result.data.status !== 'ACTIVE') {
    throw new AppError('USER_NOT_ACTIVE')
  }
  return result.data
}

async function findOwnedResource(collection, query, notFoundCode = 'NOT_FOUND') {
  let result
  try {
    result = await collection.where(query).limit(1).get()
  } catch (_) {
    throw new AppError('INTERNAL_ERROR')
  }
  if (!result || !Array.isArray(result.data) || result.data.length === 0) {
    throw new AppError(notFoundCode)
  }
  return result.data[0]
}

module.exports = {
  findOwnedResource,
  getOpenId,
  requireActiveUser,
}
