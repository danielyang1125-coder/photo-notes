'use strict'

const { getOpenId, requireActiveUser } = require('./auth')
const { AppError, errorResponse, normalizeResponse } = require('./response')

function createBusinessMain(options) {
  const {
    cloud,
    db,
    handlers,
    logger,
    activeGuard = true,
    activeGuardExempt = [],
  } = options
  const knownTypes = new Set(Object.keys(handlers || {}))
  const exemptTypes = new Set(activeGuardExempt)

  return async function main(event = {}, context = {}) {
    const startedAt = Date.now()
    const type = typeof event.type === 'string' ? event.type : ''
    try {
      if (!knownTypes.has(type)) throw new AppError('UNKNOWN_TYPE')
      const openid = getOpenId(cloud)
      let activeUser
      if (activeGuard && !exemptTypes.has(type)) {
        activeUser = await requireActiveUser(db, openid)
      }
      const value = await handlers[type]({
        activeUser,
        event,
        context,
        openid,
      })
      const response = normalizeResponse(value)
      logger.info({
        event: `${options.domain}.${type}`,
        result: response.code === 'SUCCESS' ? 'SUCCESS' : 'REJECTED',
        safeErrorCode: response.code === 'SUCCESS' ? undefined : response.code,
        durationMs: Date.now() - startedAt,
      })
      return response
    } catch (error) {
      const response = errorResponse(error)
      logger.error({
        event: `${options.domain}.${type || 'unknown'}`,
        result: 'FAILURE',
        safeErrorCode: response.code,
        durationMs: Date.now() - startedAt,
      })
      return response
    }
  }
}

function createTimerMain(options) {
  const { handler, logger, domain } = options
  return async function main(event = {}, context = {}) {
    const startedAt = Date.now()
    try {
      const response = normalizeResponse(await handler({ event, context }))
      logger.info({
        event: `${domain}.timer`,
        result: response.code === 'SUCCESS' ? 'SUCCESS' : 'REJECTED',
        safeErrorCode: response.code === 'SUCCESS' ? undefined : response.code,
        durationMs: Date.now() - startedAt,
      })
      return response
    } catch (error) {
      const response = errorResponse(error)
      logger.error({
        event: `${domain}.timer`,
        result: 'FAILURE',
        safeErrorCode: response.code,
        durationMs: Date.now() - startedAt,
      })
      return response
    }
  }
}

module.exports = {
  createBusinessMain,
  createTimerMain,
}
