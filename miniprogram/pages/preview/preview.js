const app = getApp()
const photosService = require('../../services/photos')
const notesService = require('../../services/notes')

Page({
  data: {
    photoId: null,
    pageState: 'loading',
    photo: {},
    tags: [],
    notes: [],
    showActionSheet: false,
    showDeleteConfirm: false,
    actionSheetItems: [{ label: '删除图片', color: '#E34D59' }],
    showNoteEditor: false,
    editingNote: null,
    showTagPicker: false,
    navTotalHeight: 0,
    // 滑动切换
    photoIds: [],
    currentIndex: 0,
    swipeOffset: 0,
    swiping: false,
    hasSwipeContext: false,
  },

  onLoad(options) {
    this._deleted = false
    this._initialNoteCount = null
    this._initialTagIds = null
    this._touchStartX = 0
    this._touchStartY = 0
    this._navigating = false

    const photoId = options.photoId
    if (!photoId) {
      wx.navigateBack()
      return
    }
    this._calcNavHeight()
    this.setData({ photoId })

    // 接收图片列表上下文（用于滑动切换）
    const eventChannel = this.getOpenerEventChannel()
    if (eventChannel) {
      eventChannel.on('photoListContext', (ctx) => {
        if (ctx && ctx.photoIds && ctx.photoIds.length > 1) {
          this.setData({
            photoIds: ctx.photoIds,
            currentIndex: ctx.currentIndex || 0,
            hasSwipeContext: true,
          })
        }
      })
    }

    this.loadDetail()
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

  _fmtTime(val) {
    if (!val) return ''
    // 兼容 CloudBase ServerDate 序列化对象：{$date: timestamp}
    if (typeof val === 'object' && val !== null) {
      if (val.$date) { val = val.$date }
      else if (val.offset) { val = Date.now() } // ServerDate offset 无法还原，用当前时间兜底
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
    return (notes || []).map(n => ({
      ...n,
      created_at: this._fmtTime(n.created_at),
      updated_at: this._fmtTime(n.updated_at),
    }))
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
          p.shoot_time_str =
            dt.getFullYear() +
            '-' +
            String(dt.getMonth() + 1).padStart(2, '0') +
            '-' +
            String(dt.getDate()).padStart(2, '0') +
            ' ' +
            String(dt.getHours()).padStart(2, '0') +
            ':' +
            String(dt.getMinutes()).padStart(2, '0')
        } else {
          p.shoot_time_str = '未知'
        }
        this.setData({
          photo: p,
          tags: d.tags || [],
          notes: this._fmtNoteTimes(d.notes),
          pageState: 'ready',
        })
        if (this._initialNoteCount === null) {
          this._initialNoteCount = (d.notes || []).length
          this._initialTagIds = (d.tags || []).map(tag => tag._id).sort()
        }
      } else if (res.result.code === 'PHOTO_NOT_FOUND') {
        this.setData({ pageState: 'empty' })
      } else {
        this.setData({ pageState: 'error' })
      }
    } catch (e) {
      console.error('[preview]', e)
      this.setData({ pageState: 'error' })
    }
  },

  onUnload() {
    if (this._deleted) return
    this._signalChanges()
  },

  // === 滑动切换 ===

  handleTouchStart(e) {
    if (!this.data.hasSwipeContext || this._navigating) return
    const touch = e.touches[0]
    this._touchStartX = touch.clientX
    this._touchStartY = touch.clientY
  },

  handleTouchMove(e) {
    if (!this.data.hasSwipeContext || this._navigating || !this._touchStartX) return
    const touch = e.touches[0]
    const dx = touch.clientX - this._touchStartX
    const dy = Math.abs(touch.clientY - this._touchStartY)
    // 仅水平滑动时处理（水平位移大于垂直位移）
    if (Math.abs(dx) > dy && Math.abs(dx) > 10) {
      this.setData({ swipeOffset: dx, swiping: true })
    }
  },

  handleTouchEnd(e) {
    if (!this.data.hasSwipeContext || this._navigating) {
      this._touchStartX = 0
      this._touchStartY = 0
      return
    }
    const dx = this.data.swipeOffset
    this.setData({ swipeOffset: 0, swiping: false })
    this._touchStartX = 0
    this._touchStartY = 0

    const threshold = 80
    if (dx < -threshold) {
      // 左滑 → 下一张
      this._navigateToIndex(this.data.currentIndex + 1)
    } else if (dx > threshold) {
      // 右滑 → 上一张
      this._navigateToIndex(this.data.currentIndex - 1)
    }
  },

  _navigateToIndex(index) {
    if (index < 0 || index >= this.data.photoIds.length) return
    if (index === this.data.currentIndex) return
    const nextPhotoId = this.data.photoIds[index]
    if (!nextPhotoId) return

    this._navigating = true

    // 记录当前页的变更信息
    this._signalChanges()

    this.setData({
      photoId: nextPhotoId,
      currentIndex: index,
      pageState: 'loading',
    }, () => {
      this._initialNoteCount = null
      this._initialTagIds = null
      this.loadDetail().finally(() => {
        this._navigating = false
      })
    })
  },

  _signalChanges() {
    if (this._initialNoteCount === null) return
    const currentTagIds = (this.data.tags || []).map(tag => tag._id).sort()
    if (JSON.stringify(currentTagIds) !== JSON.stringify(this._initialTagIds || [])) {
      app.globalData.photoListChange = {
        photoId: this.data.photoId,
        changeType: 'tagsChanged',
        tagIds: currentTagIds,
      }
      app.globalData.refreshPhotos = true
    }
    if ((this.data.notes || []).length !== this._initialNoteCount) {
      app.globalData.photoListChange = {
        photoId: this.data.photoId,
        changeType: 'noteCountChanged',
        noteCount: (this.data.notes || []).length,
      }
      app.globalData.refreshNotes = true
    }
    this._initialNoteCount = null
    this._initialTagIds = null
  },

  handleBack() {
    wx.navigateBack()
  },

  handleViewImage() {
    const { preview_url: url } = this.data.photo
    if (!url) return
    // 有列表上下文时传入全部预览 URL，支持全屏左右滑动
    const urls = this.data.hasSwipeContext && this.data.photoIds.length > 1
      ? this.data.photoIds.map(() => url) // 暂用当前 URL 占位，后续可优化为预加载
      : [url]
    wx.previewImage({ urls, current: url })
  },

  handleEditTags() {
    this.setData({ showTagPicker: true })
  },

  handleTagPickerClose() {
    this.setData({ showTagPicker: false })
  },

  handleTagPickerConfirm(e) {
    this.setData({ showTagPicker: false })
    const { tags } = e.detail
    if (tags) this.setData({ tags })
  },

  // === 备注操作 ===

  handleAddNote() {
    this.setData({ showNoteEditor: true, editingNote: null })
  },

  handleNoteTap(e) {
    const noteId = e.currentTarget.dataset.id
    const note = this.data.notes.find(n => n._id === noteId)
    if (!note) return
    wx.showActionSheet({
      itemList: ['编辑', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.setData({ showNoteEditor: true, editingNote: note })
        } else if (res.tapIndex === 1) {
          this.handleNoteDelete(note)
        }
      },
    })
  },

  handleNoteCancel() {
    this.setData({ showNoteEditor: false, editingNote: null })
  },

  handleNoteConfirm(e) {
    const note = e.detail.note
    if (!note) return
    this.setData({ showNoteEditor: false, editingNote: null })
    // 格式化时间并本地更新列表，避免 loadDetail() 导致页面闪烁
    const formatted = { ...note, created_at: this._fmtTime(note.created_at), updated_at: this._fmtTime(note.updated_at) }
    const notes = [...this.data.notes]
    const existingIndex = notes.findIndex(n => n._id === formatted._id)
    if (existingIndex >= 0) {
      notes[existingIndex] = formatted
    } else {
      notes.unshift(formatted)
    }
    this.setData({ notes })
  },

  handleNoteConflict(e) {
    wx.showToast({ title: '内容已被他人更新，请重试', icon: 'none', duration: 2000 })
    // 自动重试：用服务器返回的最新数据重新打开编辑器
    const latestNote = e.detail.note
    if (latestNote) {
      this.setData({ editingNote: latestNote })
    } else {
      this.setData({ showNoteEditor: false, editingNote: null })
      this.loadDetail()
    }
  },

  async handleNoteDelete(note) {
    const confirm = await new Promise(resolve => wx.showModal({
      title: '删除备注',
      content: '确认删除该备注？',
      success: resolve,
    }))
    if (!confirm.confirm) return
    try {
      const res = await notesService.del(note._id)
      if (res.result.code === 'SUCCESS') {
        wx.showToast({ title: '已删除', icon: 'success' })
        // 本地移除备注，避免 loadDetail() 导致页面闪烁
        const notes = this.data.notes.filter(n => n._id !== note._id)
        this.setData({ notes })
      } else {
        wx.showToast({ title: (res.result.message) || '删除失败', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: '网络异常', icon: 'none' })
    }
  },

  // === 图片删除 ===

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
        // 异步删除：提交后图片立即隐藏，后台 worker 最终清理
        wx.showToast({ title: '已提交删除', icon: 'success' })
        this._deleted = true
        app.globalData.photoListChange = {
          photoId: this.data.photoId,
          changeType: 'deleted',
        }
        // 后台轮询删除进度
        const taskId = res.result.data && res.result.data.taskId
        if (taskId) {
          photosService.pollDeleteStatus(taskId, {
            onManualRequired: () => wx.showToast({ title: '删除遇到问题，请稍后重试', icon: 'none' }),
          })
        }
        setTimeout(() => wx.navigateBack(), 500)
      } else {
        wx.showToast({ title: res.result.message || '删除失败', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: '网络异常', icon: 'none' })
    }
  },

  handleRetry() {
    this.loadDetail()
  },
})
