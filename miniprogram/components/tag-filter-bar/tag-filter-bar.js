const tagsService = require('../../services/tags')

Component({
  properties: {
    active: { type: String, value: 'ALL' },
    activeTagId: { type: String, value: null },
  },

  data: {
    tagState: 'loading',
    quickTags: [],
    total: null,
  },

  lifetimes: {
    attached() {
      this._requestVersion = 0
      this._refreshPromise = null
      this.refresh()
    },
  },

  methods: {
    refresh() {
      if (this._refreshPromise) return this._refreshPromise
      const requestVersion = ++this._requestVersion
      this.setData({ tagState: 'loading' })
      this._refreshPromise = tagsService.list('QUICK')
        .then((res) => {
          if (requestVersion !== this._requestVersion) return false
          if (!res.result || res.result.code !== 'SUCCESS') {
            throw new Error((res.result && res.result.message) || '标签加载失败')
          }
          const data = res.result.data || {}
          this.setData({
            tagState: 'ready',
            quickTags: data.list || [],
            total: Number(data.total) || 0,
          })
          return true
        })
        .catch((error) => {
          if (requestVersion === this._requestVersion) {
            console.error('[tag-filter-bar]', error)
            this.setData({ tagState: 'error', quickTags: [], total: null })
          }
          return false
        })
        .finally(() => {
          if (requestVersion === this._requestVersion) this._refreshPromise = null
        })
      return this._refreshPromise
    },

    handleRetry() {
      this.refresh()
    },

    handleNewTag() {
      if (this.data.tagState !== 'ready') return
      this.triggerEvent('newtag')
    },

    handleTap(e) {
      if (this.data.tagState === 'loading' && e.currentTarget.dataset.scope === 'TAG') {
        return
      }
      const { scope, tagId } = e.currentTarget.dataset
      this.triggerEvent('filter', { scope, tagId: tagId || null })
    },

    handleManage() {
      if (this._navigating) return
      this._navigating = true
      this.triggerEvent('manage')
      setTimeout(() => {
        this._navigating = false
      }, 800)
    },
  },
})
