const app = getApp()
const notesService = require('../../services/notes')

Page({
  data: {
    pageState: 'loading',
    list: [],
    cursor: null,
    hasMore: true,
    loadingMore: false,
    sortBy: 'created_at',
    sortOrder: 'desc',
  },

  onLoad() {
    this._queryVersion = 0
    this.loadNotes(true)
  },

  onShow() {
    if (app.globalData.refreshNotes) {
      app.globalData.refreshNotes = false
      this.loadNotes(true)
    }
  },

  _beginQuery(clearList) {
    this._queryVersion += 1
    const patch = { cursor: null, hasMore: true, loadingMore: false }
    if (clearList) {
      Object.assign(patch, { pageState: 'loading', list: [] })
    }
    this.setData(patch)
  },

  loadNotes(reset) {
    if (reset) this._beginQuery(true)
    if (this.data.loadingMore) return

    const snapshotVersion = this._queryVersion
    const cursor = reset ? null : this.data.cursor

    if (!reset) this.setData({ loadingMore: true })

    notesService.list(cursor || null, 20, this.data.sortBy, this.data.sortOrder)
      .then(res => {
        if (snapshotVersion !== this._queryVersion) return
        if (res.result.code === 'SUCCESS') {
          const incoming = res.result.data.list || []
          const base = reset ? [] : this.data.list
          const seen = new Set()
          const merged = [...base, ...incoming].filter(item => {
            if (!item || !item._id || seen.has(item._id)) return false
            seen.add(item._id)
            return true
          })
          this.setData({
            list: merged,
            hasMore: Boolean(res.result.data.hasMore),
            cursor: res.result.data.nextCursor || null,
            pageState: merged.length === 0 ? 'empty' : 'ready',
          })
        } else {
          console.error('[notes]', res.result.code, res.result.message)
          if (reset) this.setData({ pageState: 'error' })
          else this.setData({ hasMore: false })
        }
      })
      .catch(err => {
        if (snapshotVersion !== this._queryVersion) return
        console.error('[notes]', err)
        if (reset) this.setData({ pageState: 'error' })
        else this.setData({ hasMore: false })
      })
      .finally(() => {
        if (snapshotVersion === this._queryVersion) {
          this.setData({ loadingMore: false })
        }
      })
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) {
      this.loadNotes(false)
    }
  },

  handleRetry() {
    this.loadNotes(true)
  },
})
