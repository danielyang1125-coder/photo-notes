const app = getApp()
const photosService = require('../../services/photos')

Page({
  data: {
    pageState: 'loading',
    list: [],
    leftList: [],
    rightList: [],
    page: 1,
    hasMore: true,
    loadingMore: false,
    filter: { scope: 'ALL', tagId: null },
    spaceWarning: false,
    showUpload: false,
    statusBarHeight: 0,
    navBarHeight: 44, // px
    navTotalHeight: 44, // px (statusBar + navBar)
  },

  onLoad() {
    const info = wx.getSystemInfoSync()
    const sb = info.statusBarHeight // px
    const nb = 44 // px, 标准导航栏高度
    this.setData({
      statusBarHeight: sb,
      navBarHeight: nb,
      navTotalHeight: sb + nb,
    })
    this.loadPhotos(true)
  },

  onShow() {
    if (app.globalData.refreshPhotos) {
      app.globalData.refreshPhotos = false
      this.loadPhotos(true)
    }
  },

  onPullDownRefresh() {
    this.loadPhotos(true).then(() => wx.stopPullDownRefresh())
  },

  async loadPhotos(reset) {
    if (reset) this.setData({ page: 1, hasMore: true, list: [], leftList: [], rightList: [] })
    this.setData({ pageState: 'loading' })

    try {
      const { scope, tagId } = this.data.filter
      const res = await photosService.list(scope, tagId, this.data.page)
      if (res.result.code === 'SUCCESS') {
        const d = res.result.data
        const merged = reset ? d.list : [...this.data.list, ...d.list]
        const { left, right } = this._splitToColumns(merged)
        this.setData({
          list: merged, leftList: left, rightList: right,
          hasMore: d.hasMore, page: this.data.page + 1,
          pageState: merged.length === 0 ? 'empty' : 'ready',
        })
        const ui = app.globalData.userInfo || {}
        const pct = ui.limit_bytes ? ui.used_bytes / ui.limit_bytes : 0
        this.setData({ spaceWarning: pct >= 0.8 })
      } else {
        this.setData({ pageState: 'error' })
      }
    } catch (e) {
      console.error('[photos]', e)
      this.setData({ pageState: 'error' })
    }
  },

  _splitToColumns(list) {
    const left = [], right = []
    let lh = 0, rh = 0
    list.forEach((item) => {
      const h = item.height && item.width ? Math.round((item.height / item.width) * 340) : 340
      const ch = Math.min(Math.max(h, 180), 560)
      item._cardHeight = ch
      if (lh <= rh) { left.push(item); lh += ch + 16 }
      else { right.push(item); rh += ch + 16 }
    })
    return { left, right }
  },

  handleLoadMore() {
    if (this.data.loadingMore || !this.data.hasMore) return
    this.setData({ loadingMore: true })
    this.loadPhotos(false).then(() => this.setData({ loadingMore: false }))
  },

  handleFilterChange(e) {
    this.setData({ filter: e.detail })
    this.loadPhotos(true)
  },

  handleNewTag() { /* S5 实现 */ },
  handleTagManage() { wx.navigateTo({ url: '/pages/tag-manager/tag-manager' }) },
  handleOpenUpload() { this.setData({ showUpload: true }) },
  handleCloseUpload() { this.setData({ showUpload: false }) },

  handleUploadDone() {
    this.setData({ showUpload: false })
    app.globalData.refreshPhotos = true
    this.loadPhotos(true)
  },

  handleRetry() { this.loadPhotos(true) },
})
