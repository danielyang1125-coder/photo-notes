const app = getApp()
const photosService = require('../../services/photos')

Page({
  data: {
    photoId: null,
    pageState: 'loading',
    photo: {},
    tags: [],
    notes: [],
    showActionSheet: false,
    showDeleteConfirm: false,
    actionSheetItems: [
      { label: '删除图片', color: '#E34D59' },
    ],
  },

  onLoad(options) {
    const photoId = options.photoId
    if (!photoId) { wx.navigateBack(); return }
    this.setData({ photoId })
    this.loadDetail()
  },

  async loadDetail() {
    this.setData({ pageState: 'loading' })
    try {
      const res = await photosService.detail(this.data.photoId)
      if (res.result.code === 'SUCCESS') {
        const d = res.result.data
        // 格式化时间
        const p = d.photo
        if (p.shoot_time) {
          const dt = new Date(p.shoot_time)
          p.shoot_time_str = dt.getFullYear() + '-' +
            String(dt.getMonth() + 1).padStart(2, '0') + '-' +
            String(dt.getDate()).padStart(2, '0') + ' ' +
            String(dt.getHours()).padStart(2, '0') + ':' +
            String(dt.getMinutes()).padStart(2, '0')
        } else {
          p.shoot_time_str = '未知'
        }
        this.setData({
          photo: p,
          tags: d.tags || [],
          notes: d.notes || [],
          pageState: 'ready',
        })
      } else if (res.result.code === 'NOT_FOUND') {
        this.setData({ pageState: 'empty' })
      } else {
        this.setData({ pageState: 'error' })
      }
    } catch (e) {
      console.error('[preview]', e)
      this.setData({ pageState: 'error' })
    }
  },

  handleBack() { wx.navigateBack() },

  handleViewImage() {
    const { compression_url: url } = this.data.photo
    if (url) {
      wx.previewImage({ urls: [url], current: url })
    }
  },

  handleEditTags() { /* S5 实现：打开 tag-picker */ },

  handleAddNote() { /* S7 实现：打开 note-editor */ },

  handleDelete() {
    this.setData({ showDeleteConfirm: true })
  },

  handleCancelDelete() {
    this.setData({ showDeleteConfirm: false })
  },

  async handleConfirmDelete() {
    this.setData({ showDeleteConfirm: false })
    try {
      const res = await photosService.del(this.data.photoId)
      if (res.result.code === 'SUCCESS') {
        wx.showToast({ title: '已删除', icon: 'success' })
        app.globalData.refreshPhotos = true
        setTimeout(() => wx.navigateBack(), 500)
      } else {
        wx.showToast({ title: res.result.message || '删除失败', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: '网络异常', icon: 'none' })
    }
  },

  handleRetry() { this.loadDetail() },
})
