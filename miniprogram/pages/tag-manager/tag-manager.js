const app = getApp()
const tagsService = require('../../services/tags')

Page({
  data: { list: [], loading: false, mutating: false },

  onLoad() {
    this.loadTags()
  },

  async loadTags() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const res = await tagsService.list('ALL')
      if (res.result && res.result.code === 'SUCCESS') {
        this.setData({ list: res.result.data.list || [] })
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '加载失败', icon: 'none' })
      }
    } catch (error) {
      wx.showToast({ title: '网络异常', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  handleBack() {
    wx.navigateBack()
  },

  handleCreate() {
    this._editTag()
  },

  handleAction(e) {
    const { id, action } = e.currentTarget.dataset
    if (action === 'delete') {
      wx.showModal({
        title: '删除标签',
        content: '删除标签不会删除图片或备注，但关联将被移除。',
        success: result => {
          if (result.confirm) this.deleteTag(id)
        },
      })
    } else if (action === 'rename') {
      const tag = this.data.list.find(item => item._id === id)
      this._editTag(tag)
    }
  },

  async _editTag(tag) {
    if (this.data.mutating) return
    const modal = await new Promise(resolve => wx.showModal({
      title: tag ? '重命名标签' : '新建标签',
      editable: true,
      content: tag ? tag.name : '',
      placeholderText: '请输入标签名称',
      confirmText: tag ? '保存' : '创建',
      success: resolve,
      fail: () => resolve({ confirm: false }),
    }))
    if (!modal.confirm) return
    this.setData({ mutating: true })
    try {
      const res = tag
        ? await tagsService.rename(tag._id, modal.content || '')
        : await tagsService.create(modal.content || '')
      if (!res.result || res.result.code !== 'SUCCESS') {
        wx.showToast({ title: (res.result && res.result.message) || '操作失败', icon: 'none' })
        return
      }
      app.globalData.refreshTags = true
      wx.showToast({ title: tag ? '已重命名' : '已创建', icon: 'success' })
      await this.loadTags()
    } catch (error) {
      wx.showToast({ title: '网络异常', icon: 'none' })
    } finally {
      this.setData({ mutating: false })
    }
  },

  async deleteTag(tagId) {
    if (this.data.mutating) return
    this.setData({ mutating: true })
    try {
      const res = await tagsService.del(tagId)
      if (!res.result || res.result.code !== 'SUCCESS') {
        wx.showToast({ title: (res.result && res.result.message) || '删除失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '已删除' })
      app.globalData.refreshTags = true
      await this.loadTags()
    } catch (error) {
      wx.showToast({ title: '网络异常', icon: 'none' })
    } finally {
      this.setData({ mutating: false })
    }
  },
})
