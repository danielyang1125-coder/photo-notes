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
    navTotalHeight: 0,
  },

  onLoad() {
    this._queryVersion = 0
    this._calcNavHeight()
    this.loadNotes(true)
  },

  _calcNavHeight() {
    try {
      const info = wx.getSystemInfoSync() || {}
      const menu = wx.getMenuButtonBoundingClientRect()
      const statusBarHeight = Number(info.statusBarHeight) || 20
      const navBarHeight = (menu && menu.top > 0 && menu.height > 0)
        ? Math.max(44, (menu.top - statusBarHeight) * 2 + menu.height)
        : 44
      this.setData({ navTotalHeight: statusBarHeight + navBarHeight })
    } catch (e) {
      this.setData({ navTotalHeight: 96 })
    }
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

  _fmtTime(val) {
    if (!val) return ''
    if (typeof val === 'object' && val !== null) {
      if (val.$date) { val = val.$date }
      else if (val.offset) { val = Date.now() }
      else { return '' }
    }
    const d = new Date(val)
    if (isNaN(d.getTime())) return ''
    const now = new Date()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    if (d.getFullYear() !== now.getFullYear()) {
      return `${d.getFullYear()}-${mm}-${dd} ${hh}:${min}`
    }
    return `${mm}-${dd} ${hh}:${min}`
  },

  _fmtNoteTimes(notes) {
    return notes.map(n => ({
      ...n,
      created_at: this._fmtTime(n.created_at),
      updated_at: this._fmtTime(n.updated_at),
    }))
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
          const incoming = this._fmtNoteTimes(res.result.data.list || [])
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

  handleNoteTap(e) {
    const photoId = e.currentTarget.dataset.photoId
    if (!photoId) return
    wx.navigateTo({ url: `/pages/preview/preview?photoId=${photoId}` })
  },

  handleRetry() {
    this.loadNotes(true)
  },
})
