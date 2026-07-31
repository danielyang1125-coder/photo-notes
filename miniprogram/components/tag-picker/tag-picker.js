const tagsService = require('../../services/tags')

Component({
  properties: {
    photoId: { type: String, value: '' },
    visible: { type: Boolean, value: false },
  },

  data: {
    allTags: [],
    selectedIds: [],
    loading: false,
    saving: false,
  },

  observers: {
    'visible, photoId'(visible, photoId) {
      if (visible && photoId) {
        this._loadData()
      }
    },
  },

  methods: {
    noop() {},

    async _loadData() {
      this.setData({ loading: true })
      try {
        const [allRes, photoRes] = await Promise.all([
          tagsService.list('ALL'),
          tagsService.getPhotoTags(this.properties.photoId),
        ])
        const allTags = (allRes.result && allRes.result.code === 'SUCCESS')
          ? (allRes.result.data.list || [])
          : []
        const photoTags = (photoRes.result && photoRes.result.code === 'SUCCESS')
          ? (photoRes.result.data.tags || [])
          : []
        const selectedIds = photoTags.map(t => t._id)
        this.setData({ allTags, selectedIds, loading: false })
      } catch (e) {
        console.error('[tag-picker]', e)
        wx.showToast({ title: '加载标签失败', icon: 'none' })
        this.triggerEvent('close')
      }
    },

    handleToggle(e) {
      if (this.data.saving) return
      const tagId = e.currentTarget.dataset.id
      let selectedIds = [...this.data.selectedIds]
      const index = selectedIds.indexOf(tagId)
      if (index >= 0) {
        selectedIds.splice(index, 1)
      } else {
        if (selectedIds.length >= 5) {
          wx.showToast({ title: '每张图片最多 5 个标签', icon: 'none' })
          return
        }
        selectedIds.push(tagId)
      }
      this.setData({ selectedIds })
    },

    handleClose() {
      if (this.data.saving) return
      this.triggerEvent('close')
    },

    async handleSave() {
      if (this.data.saving) return

      // 计算 diff
      const photoRes = await tagsService.getPhotoTags(this.properties.photoId)
      const currentIds = (photoRes.result && photoRes.result.code === 'SUCCESS')
        ? (photoRes.result.data.tags || []).map(t => t._id)
        : []

      const selected = this.data.selectedIds
      const addTagIds = selected.filter(id => !currentIds.includes(id))
      const removeTagIds = currentIds.filter(id => !selected.includes(id))

      if (addTagIds.length === 0 && removeTagIds.length === 0) {
        this.triggerEvent('close')
        return
      }

      this.setData({ saving: true })
      try {
        const requestId = `tag_pick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const res = await tagsService.updatePhotoTags(
          this.properties.photoId,
          addTagIds,
          removeTagIds,
          requestId,
        )
        if (res.result && res.result.code === 'SUCCESS') {
          const tags = (res.result.data && res.result.data.tags) || []
          this.triggerEvent('confirm', { tags })
        } else {
          const msg = (res.result && res.result.message) || '保存失败'
          wx.showToast({ title: msg, icon: 'none' })
        }
      } catch (e) {
        wx.showToast({ title: '网络异常', icon: 'none' })
      } finally {
        this.setData({ saving: false })
      }
    },
  },
})
