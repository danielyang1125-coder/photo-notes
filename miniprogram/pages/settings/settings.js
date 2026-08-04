const app = getApp()
const authService = require('../../services/auth')
const navbar = require('../../utils/navbar')

Page({
  data: {
    usedBytes: 0,
    limitBytes: 524288000,
    usedMB: '0',
    limitMB: '500',
    usagePercent: 0,
    showDeleteDialog: false,
    navTotalHeight: 0,
  },

  onLoad() {
    this._calcNavHeight()
    this.loadStatus()
  },
  onShow() {
    // 同步自定义 tabBar 选中态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    this.loadStatus()
  },

  _calcNavHeight() {
    const layout = navbar.getNavLayout()
    this.setData({ navTotalHeight: layout.totalHeight })
  },

  _applyUsage(used, limit) {
    this.setData({
      usedBytes: used,
      limitBytes: limit,
      usedMB: (used / 1048576).toFixed(1),
      limitMB: (limit / 1048576).toFixed(0),
      usagePercent: limit > 0 ? Math.round((used / limit) * 100) : 0,
    })
  },

  async loadStatus() {
    try {
      const res = await authService.getSpaceUsage()
      if (res.result && res.result.code === 'SUCCESS') {
        const data = res.result.data
        this._applyUsage(data.used_bytes || 0, data.limit_bytes || 524288000)
        return
      }
    } catch (e) {
      console.error('[settings] 空间用量查询失败:', e)
    }
    // 降级：使用登录时缓存的数据
    const ui = app.globalData.userInfo || {}
    const used = ui.used_bytes || 0
    const limit = ui.limit_bytes || 524288000
    this._applyUsage(used, limit)
  },

  handleBack() {
    wx.switchTab({ url: '/pages/photos/photos' })
  },
  handleTagManage() {
    wx.navigateTo({ url: '/pages/tag-manager/tag-manager' })
  },
  handleDeleteAccount() {
    this.setData({ showDeleteDialog: true })
  },
  handleCancelDeletion() {
    this.setData({ showDeleteDialog: false })
  },
  handleConfirmDeletion() {
    this.setData({ showDeleteDialog: false })
    wx.cloud
      .callFunction({
        name: 'account',
        data: { type: 'requestDeletion', confirmText: '确认注销' },
      })
      .then((res) => {
        if (res.result.code === 'SUCCESS')
          wx.redirectTo({ url: '/pages/deletion-status/deletion-status' })
        else
          wx.showToast({
            title: res.result.message || '操作失败',
            icon: 'none',
          })
      })
      .catch(() => wx.showToast({ title: '网络异常', icon: 'none' }))
  },
})
