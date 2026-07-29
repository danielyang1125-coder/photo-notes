const app = getApp()
const photosService = require('../../services/photos')
const tagsService = require('../../services/tags')
const authService = require('../../services/auth')

Page({
  data: {
    pageState: 'initialLoading',
    list: [],
    leftList: [],
    rightList: [],
    page: 1,
    hasMore: true,
    refreshing: false,
    refresherTriggered: false,
    loadingMore: false,
    loadMoreError: '',
    filter: { scope: 'ALL', tagId: null },
    spaceWarning: false,
    spaceFull: false,
    showSourcePopup: false,
    showUpload: false,
    statusBarHeight: 0,
    navBarHeight: 44,
    navTotalHeight: 44,
    settingsRight: 12,
    scrollTop: 0,
  },

  onLoad() {
    this._queryVersion = 0
    this._inflight = {}
    this._currentScrollTop = 0
    this._creatingTag = false
    this._navigatingTags = false
    this._hasShown = false
    this._initNavigation()
    this._beginQuery(true)
    this.loadPhotos('initial')
    this.refreshSpaceUsage()
  },

  onShow() {
    if (!this._hasShown) {
      this._hasShown = true
      return
    }
    this._applyPhotoChange()
    if (app.globalData.refreshTags) {
      app.globalData.refreshTags = false
      this._refreshQuickTags()
      if (this.data.filter.scope === 'TAG') this.handleRefresh()
    }
    if (app.globalData.refreshPhotos) {
      app.globalData.refreshPhotos = false
      this.handleRefresh()
    }
  },

  onHide() {
    const panel = this.selectComponent('#uploadPanel')
    if (panel && this.data.showUpload) panel.cancelActiveTasks()
  },

  onUnload() {
    const panel = this.selectComponent('#uploadPanel')
    if (panel) panel.cancelActiveTasks()
  },

  _initNavigation() {
    let info = {}
    let menu = null
    try {
      info = wx.getSystemInfoSync() || {}
      menu = wx.getMenuButtonBoundingClientRect()
    } catch (error) {
      console.warn('[photos] 获取导航栏信息失败:', error)
    }
    const statusBarHeight = Number(info.statusBarHeight) || 20
    const screenWidth = Number(info.screenWidth || info.windowWidth) || 375
    const menuValid = menu && menu.top > 0 && menu.height > 0 && menu.left > 0
    const navBarHeight = menuValid
      ? Math.max(44, (menu.top - statusBarHeight) * 2 + menu.height)
      : 44
    const settingsRight = menuValid ? Math.max(12, screenWidth - menu.left + 8) : 12
    this.setData({
      statusBarHeight,
      navBarHeight,
      navTotalHeight: statusBarHeight + navBarHeight,
      settingsRight,
    })
  },

  _beginQuery(clearList) {
    if (!clearList && this.data.list.length > 0) {
      this._preservedQueryState = {
        page: this.data.page,
        hasMore: this.data.hasMore,
      }
    } else {
      this._preservedQueryState = null
    }
    this._queryVersion += 1
    this._inflight = {}
    const patch = {
      page: 1,
      hasMore: true,
      loadingMore: false,
      loadMoreError: '',
    }
    if (clearList) {
      Object.assign(patch, {
        pageState: 'initialLoading',
        list: [],
        leftList: [],
        rightList: [],
        scrollTop: 0,
      })
      this._currentScrollTop = 0
    }
    this.setData(patch)
  },

  _isCurrent(snapshot) {
    const current = this.data.filter
    return snapshot.version === this._queryVersion &&
      snapshot.scope === current.scope &&
      snapshot.tagId === current.tagId &&
      snapshot.page === this.data.page
  },

  async loadPhotos(requestType) {
    const filter = this.data.filter
    const snapshot = {
      version: this._queryVersion,
      scope: filter.scope,
      tagId: filter.tagId,
      page: this.data.page,
      requestType,
    }
    const requestKey = `${snapshot.version}:${snapshot.scope}:${snapshot.tagId || ''}:${snapshot.page}`
    if (this._inflight[requestKey]) return this._inflight[requestKey]

    if (requestType === 'refresh') {
      this._refreshRequestKey = requestKey
      this.setData({ refreshing: true, refresherTriggered: true })
    } else if (requestType === 'loadMore') {
      this._loadMoreRequestKey = requestKey
      this.setData({ loadingMore: true, loadMoreError: '' })
    }

    const request = photosService.list(snapshot.scope, snapshot.tagId, snapshot.page)
      .then(async (res) => {
        if (!this._isCurrent(snapshot)) return
        const result = res.result || {}
        if (result.code === 'TAG_NOT_FOUND' && snapshot.scope === 'TAG') {
          await this._handleInvalidTag(snapshot)
          return
        }
        if (result.code !== 'SUCCESS') {
          const error = new Error(result.message || '图片加载失败')
          error.code = result.code
          throw error
        }

        const incoming = (result.data && result.data.list) || []
        const base = snapshot.page === 1 ? [] : this.data.list
        const seen = new Set()
        const merged = [...base, ...incoming].filter(item => {
          if (!item || !item._id || seen.has(item._id)) return false
          seen.add(item._id)
          return true
        })
        const columns = this._splitToColumns(merged)
        this.setData({
          list: merged,
          leftList: columns.left,
          rightList: columns.right,
          hasMore: Boolean(result.data && result.data.hasMore),
          page: snapshot.page + 1,
          pageState: merged.length === 0 ? 'empty' : 'ready',
          loadMoreError: '',
        })
        this._preservedQueryState = null
        if (snapshot.scope === 'TAG') this._refreshQuickTags()
      })
      .catch((error) => {
        if (!this._isCurrent(snapshot)) return
        console.error('[photos]', requestType, error)
        if (requestType === 'loadMore') {
          this.setData({ loadMoreError: '加载失败，点击重试' })
        } else if (requestType === 'refresh') {
          if (this._preservedQueryState) {
            this.setData({
              page: this._preservedQueryState.page,
              hasMore: this._preservedQueryState.hasMore,
            })
            this._preservedQueryState = null
          }
          wx.showToast({ title: '刷新失败，已保留原列表', icon: 'none' })
        } else {
          this.setData({ pageState: 'initialError' })
        }
      })
      .finally(() => {
        if (this._inflight[requestKey] === request) delete this._inflight[requestKey]
        if (this._refreshRequestKey === requestKey) {
          this._refreshRequestKey = ''
          this.setData({ refreshing: false, refresherTriggered: false })
        }
        if (this._loadMoreRequestKey === requestKey) {
          this._loadMoreRequestKey = ''
          this.setData({ loadingMore: false })
        }
      })
    this._inflight[requestKey] = request
    return request
  },

  async _handleInvalidTag(snapshot) {
    if (!this._isCurrent(snapshot)) return
    wx.showToast({ title: '标签已不存在，已切换到全部图片', icon: 'none', duration: 2200 })
    this.setData({ filter: { scope: 'ALL', tagId: null } })
    this._beginQuery(true)
    this._refreshQuickTags()
    await this.loadPhotos('filter')
  },

  _splitToColumns(list) {
    const left = []
    const right = []
    let leftHeight = 0
    let rightHeight = 0
    list.forEach(item => {
      const proportional = item.height && item.width
        ? Math.round((item.height / item.width) * 340)
        : 340
      const imageHeight = Math.min(Math.max(proportional, 180), 560)
      const card = { ...item, _cardHeight: imageHeight }
      if (leftHeight <= rightHeight) {
        left.push(card)
        leftHeight += imageHeight + 16
      } else {
        right.push(card)
        rightHeight += imageHeight + 16
      }
    })
    return { left, right }
  },

  handleLoadMore() {
    if (this.data.loadingMore || this.data.loadMoreError || !this.data.hasMore) return
    this.loadPhotos('loadMore')
  },

  handleRetryLoadMore() {
    if (this.data.loadingMore) return
    this.setData({ loadMoreError: '' })
    this.loadPhotos('loadMore')
  },

  handleRefresh() {
    if (this.data.refreshing) return
    this._beginQuery(false)
    this.loadPhotos('refresh')
    this.refreshSpaceUsage()
  },

  handleFilterChange(e) {
    const next = e.detail || {}
    const current = this.data.filter
    if (next.scope === current.scope && (next.tagId || null) === current.tagId) return
    this.setData({ filter: { scope: next.scope, tagId: next.tagId || null } })
    this._beginQuery(true)
    this.loadPhotos('filter')
  },

  handleViewAll() {
    this.handleFilterChange({ detail: { scope: 'ALL', tagId: null } })
  },

  handleRetry() {
    this._beginQuery(true)
    this.loadPhotos('initial')
  },

  handleScroll(e) {
    this._currentScrollTop = e.detail.scrollTop || 0
  },

  handlePhotoSelect(e) {
    const photoId = e.detail.photoId
    if (!photoId) return
    this.setData({ scrollTop: this._currentScrollTop })
    wx.navigateTo({ url: `/pages/preview/preview?photoId=${photoId}` })
  },

  _applyPhotoChange() {
    const change = app.globalData.photoListChange
    if (!change || !change.photoId) return
    app.globalData.photoListChange = null
    const original = this.data.list
    const target = original.find(item => item._id === change.photoId)
    if (!target && change.changeType !== 'deleted') return
    let list = original
    if (change.changeType === 'deleted') {
      list = original.filter(item => item._id !== change.photoId)
      this.refreshSpaceUsage()
    } else if (change.changeType === 'noteCountChanged') {
      list = original.map(item => item._id === change.photoId
        ? { ...item, note_count: Number(change.noteCount) || 0 }
        : item)
    } else if (change.changeType === 'tagsChanged') {
      const tagIds = change.tagIds || []
      const filter = this.data.filter
      const stillMatches = filter.scope === 'ALL' ||
        (filter.scope === 'UNCATEGORIZED' && tagIds.length === 0) ||
        (filter.scope === 'TAG' && tagIds.includes(filter.tagId))
      if (!stillMatches) list = original.filter(item => item._id !== change.photoId)
    }
    if (list !== original) {
      const columns = this._splitToColumns(list)
      this.setData({
        list,
        leftList: columns.left,
        rightList: columns.right,
        pageState: list.length === 0 ? 'empty' : 'ready',
        scrollTop: this._currentScrollTop,
      })
      if (list.length < original.length && this.data.hasMore) this.loadPhotos('loadMore')
    }
  },

  _refreshQuickTags() {
    const bar = this.selectComponent('#tagFilterBar')
    return bar ? bar.refresh() : Promise.resolve(false)
  },

  async handleNewTag() {
    if (this._creatingTag) return
    this._creatingTag = true
    try {
      const modal = await new Promise(resolve => wx.showModal({
        title: '新建标签',
        editable: true,
        placeholderText: '请输入标签名称',
        confirmText: '创建',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      }))
      if (!modal.confirm) return
      const res = await tagsService.create(modal.content || '')
      if (!res.result || res.result.code !== 'SUCCESS') {
        wx.showToast({ title: (res.result && res.result.message) || '创建失败', icon: 'none' })
        return
      }
      app.globalData.refreshTags = false
      const refreshed = await this._refreshQuickTags()
      if (!refreshed) {
        wx.showToast({ title: '标签已创建，但快捷标签刷新失败', icon: 'none' })
        return
      }
      this.handleFilterChange({
        detail: { scope: 'TAG', tagId: res.result.data.tag._id },
      })
    } catch (error) {
      wx.showToast({ title: '创建标签失败', icon: 'none' })
    } finally {
      this._creatingTag = false
    }
  },

  handleTagManage() {
    if (this._navigatingTags) return
    this._navigatingTags = true
    wx.navigateTo({
      url: '/pages/tag-manager/tag-manager',
      complete: () => setTimeout(() => { this._navigatingTags = false }, 500),
    })
  },

  handleOpenSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' })
  },

  async refreshSpaceUsage(showWarning = true) {
    try {
      const res = await authService.getSpaceUsage()
      if (!res.result || res.result.code !== 'SUCCESS') return null
      const usage = res.result.data
      app.globalData.spaceUsage = usage
      const shouldShow = showWarning && usage.warning && !app.globalData.spaceWarningShown
      if (shouldShow) app.globalData.spaceWarningShown = true
      const patch = { spaceFull: Boolean(usage.full) }
      if (showWarning) patch.spaceWarning = Boolean(shouldShow)
      if (!usage.warning) patch.spaceWarning = false
      this.setData(patch)
      return usage
    } catch (error) {
      console.error('[photos] 空间用量查询失败:', error)
      return null
    }
  },

  async handleOpenUpload() {
    const usage = await this.refreshSpaceUsage(false)
    if (usage && usage.full) {
      wx.showToast({ title: '存储空间不足，请先清理图片', icon: 'none' })
      return
    }
    this.setData({ showSourcePopup: true })
  },

  handleSourcePopupChange(e) {
    if (!e.detail.visible) this.handleCloseSourcePopup()
  },

  handleCloseSourcePopup() {
    this.setData({ showSourcePopup: false })
  },

  handleSourceSelect(e) {
    const sourceType = e.currentTarget.dataset.source
    this.setData({ showSourcePopup: false }, () => {
      const panel = this.selectComponent('#uploadPanel')
      if (panel) panel.chooseImage(sourceType)
    })
  },

  handleUploadSelected() {
    this.setData({ showUpload: true })
  },

  handleCloseUpload() {
    this.setData({ showUpload: false })
  },

  handleUploadDone(e) {
    this.setData({ showUpload: false })
    const result = (e && e.detail) || {}
    if (result.successCount > 0) {
      this._beginQuery(false)
      this.loadPhotos('refresh')
      this.refreshSpaceUsage()
    }
  },

  async handleUploadAddTags(e) {
    const photoIds = (e.detail && e.detail.photoIds) || []
    if (photoIds.length === 0) return
    try {
      const listResult = await tagsService.list('ALL')
      if (!listResult.result || listResult.result.code !== 'SUCCESS') throw new Error('标签加载失败')
      const tags = listResult.result.data.list || []
      if (tags.length === 0) {
        wx.showToast({ title: '请先创建标签', icon: 'none' })
        return
      }
      const modal = await new Promise(resolve => wx.showModal({
        title: '为本批图片添加标签',
        content: '请输入已有标签的完整名称',
        editable: true,
        placeholderText: '标签名称',
        confirmText: '添加',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      }))
      if (!modal.confirm) return
      const tag = tags.find(item => item.name === (modal.content || '').trim())
      if (!tag) {
        wx.showToast({ title: '未找到该标签', icon: 'none' })
        return
      }
      const requestId = `batch_tag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const result = await tagsService.batchAddPhotoTags(photoIds, [tag._id], requestId)
      if (!result.result || result.result.code !== 'SUCCESS') {
        throw new Error((result.result && result.result.message) || '添加失败')
      }
      wx.showToast({ title: '标签已添加', icon: 'success' })
      this._refreshQuickTags()
    } catch (error) {
      wx.showToast({ title: error.message || '添加标签失败', icon: 'none' })
    }
  },
})
