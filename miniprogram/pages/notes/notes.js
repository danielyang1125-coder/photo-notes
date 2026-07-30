const app = getApp()
Page({
  data: {
    list: [],
    loading: false,
    cursor: null,
    hasMore: true,
    sortBy: 'created_at',
    sortOrder: 'desc'
  },

  onLoad() {
    this.loadNotes()
  },

  onShow() {
    if (app.globalData.refreshNotes) {
      app.globalData.refreshNotes = false
      this.loadNotes(true)
    }
  },

  loadNotes(reset) {
    const that = this
    if (reset) {
      that.setData({ cursor: null, hasMore: true, list: [] })
    }
    that.setData({ loading: true })
    const cursor = reset ? null : that.data.cursor
    wx.cloud.callFunction({
      name: 'note',
      data: {
        type: 'list',
        cursor: cursor || undefined,
        pageSize: 20,
        sortBy: that.data.sortBy,
        sortOrder: that.data.sortOrder,
      },
    })
      .then(res => {
        if (res.result.code === 'SUCCESS') {
          const incoming = res.result.data.list || []
          that.setData({
            list: reset ? incoming : [...that.data.list, ...incoming],
            hasMore: res.result.data.hasMore,
            cursor: res.result.data.nextCursor || null,
          })
        }
      })
      .catch(err => console.error('[notes]', err))
      .finally(() => that.setData({ loading: false }))
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadNotes()
  },
})
