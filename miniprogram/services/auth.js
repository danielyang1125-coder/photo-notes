/** 用户身份服务 */
const NAME = 'user'

function call(type, data = {}) {
  return wx.cloud.callFunction({ name: NAME, data: { type, ...data } })
}

export function login() {
  return call('login')
}

export function getStatus() {
  return call('getStatus')
}

export function getSpaceUsage() {
  return call('getSpaceUsage')
}

export function healthCheck() {
  return call('healthCheck')
}
