const tagsService = require('../../services/tags')

Component({
  properties: {
    active: { type: String, value: 'ALL' },
    activeTagId: { type: String, value: null },
  },

  data: {
    quickTags: [],
  },

  lifetimes: {
    attached() {
      this.loadQuickTags()
    },
  },

  methods: {
    async loadQuickTags() {
      try {
        const res = await tagsService.list('QUICK')
        if (res.result.code === 'SUCCESS') {
          this.setData({ quickTags: res.result.data.list || [] })
        }
      } catch (e) {
        console.error('[tag-filter-bar]', e)
      }
    },

    handleTap(e) {
      const { scope, tagId } = e.currentTarget.dataset
      this.triggerEvent('filter', { scope, tagId: tagId || null })
    },

    handleManage() {
      this.triggerEvent('manage')
    },
  },
})
