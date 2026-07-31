const tagsService = require('../../services/tags')
const { TAG_NAME_MAX_LENGTH, TAG_MAX_COUNT, RESERVED_TAG_NAMES } = require('../../utils/constants')

Component({
  properties: {
    photoId: { type: String, value: '' },
    visible: { type: Boolean, value: false },
  },

  data: {
    allTags: [],
    filteredTags: [],
    selectedIds: [],
    loading: false,
    saving: false,
    searchText: '',
    canCreate: false,
    creating: false,
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
      this.setData({ loading: true, searchText: '', filteredTags: [] })
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
        this.setData({ allTags, filteredTags: allTags, selectedIds, loading: false })
      } catch (e) {
        console.error('[tag-picker]', e)
        wx.showToast({ title: '加载标签失败', icon: 'none' })
        this.triggerEvent('close')
      }
    },

    // ---------- 搜索 ----------

    handleSearchInput(e) {
      const searchText = e.detail.value || ''
      this.setData({ searchText })
      this._applyFilter(searchText)
    },

    handleClearSearch() {
      this.setData({ searchText: '' })
      this._applyFilter('')
    },

    _applyFilter(searchText) {
      const text = searchText.trim()
      if (!text) {
        this.setData({ filteredTags: this.data.allTags, canCreate: false })
        return
      }
      const lower = text.toLowerCase()
      const filtered = this.data.allTags.filter(tag =>
        tag.name.toLowerCase().includes(lower)
      )
      const canCreate = this._computeCanCreate(text)
      this.setData({ filteredTags: filtered, canCreate })
    },

    _computeCanCreate(text) {
      if (!text) return false
      // 长度校验（Unicode 码点）
      const len = [...text].length
      if (len < 1 || len > TAG_NAME_MAX_LENGTH) return false
      // 保留名称
      if (RESERVED_TAG_NAMES.includes(text)) return false
      // 已达标签数量上限
      if (this.data.allTags.length >= TAG_MAX_COUNT) return false
      // 是否已有同名标签（大小写不敏感）
      const lower = text.toLowerCase()
      const exists = this.data.allTags.some(tag => tag.name.toLowerCase() === lower)
      if (exists) return false
      return true
    },

    // ---------- 创建标签 ----------

    async handleCreateTag() {
      if (this.data.creating) return
      const name = this.data.searchText.trim()
      if (!this._computeCanCreate(name)) return

      this.setData({ creating: true })
      try {
        const res = await tagsService.create(name)
        if (res.result && res.result.code === 'SUCCESS') {
          const newTag = res.result.data.tag
          // 插入到列表头部
          const allTags = [newTag, ...this.data.allTags]
          const filteredTags = [newTag, ...this.data.filteredTags]

          // 自动选中（不超过 5 个上限）
          let selectedIds = [...this.data.selectedIds]
          if (selectedIds.length < 5) {
            selectedIds.push(newTag._id)
          } else {
            wx.showToast({ title: '已创建，但当前图片已有 5 个标签', icon: 'none', duration: 2000 })
          }

          // 通知标签列表刷新（图片列表页顶部的标签筛选栏）
          const app = getApp()
          app.globalData.refreshTags = true

          this.setData({ allTags, filteredTags, selectedIds, creating: false })
          wx.showToast({ title: '已创建并选中', icon: 'success', duration: 1500 })
        } else {
          const msg = (res.result && res.result.message) || '创建失败'
          wx.showToast({ title: msg, icon: 'none' })
          this.setData({ creating: false })
        }
      } catch (e) {
        wx.showToast({ title: '网络异常', icon: 'none' })
        this.setData({ creating: false })
      }
    },

    // ---------- 选择/取消 ----------

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

    // ---------- 关闭 / 保存 ----------

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
