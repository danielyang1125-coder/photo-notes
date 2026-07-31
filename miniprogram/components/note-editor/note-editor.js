const notesService = require('../../services/notes')
const { validateNoteContent } = require('../../utils/validator')

Component({
  properties: {
    photoId: { type: String, value: '' },
    note: {
      type: Object,
      value: null, // null = 新增模式，传入对象 = 编辑模式
    },
    visible: { type: Boolean, value: false },
  },

  data: {
    content: '',
    saving: false,
    error: '',
  },

  observers: {
    'visible, note'(visible, note) {
      if (visible) {
        this.setData({
          content: note ? (note.content || '') : '',
          error: '',
          saving: false,
        })
      }
    },
  },

  methods: {
    noop() {},

    handleInput(e) {
      this.setData({ content: e.detail.value || '', error: '' })
    },

    handleCancel() {
      if (this.data.saving) return
      this.triggerEvent('cancel')
    },

    async handleConfirm() {
      if (this.data.saving) return
      const content = (this.data.content || '').trim()
      if (!content) {
        this.setData({ error: '内容不能为空' })
        return
      }
      const validation = validateNoteContent(content)
      if (!validation.valid) {
        this.setData({ error: validation.error || '内容不合法' })
        return
      }

      this.setData({ saving: true, error: '' })
      try {
        const note = this.properties.note
        let result
        if (note && note._id) {
          // 编辑模式（乐观锁）
          result = await notesService.update(note._id, content, note.updated_at)
        } else {
          // 新增模式
          result = await notesService.add(this.properties.photoId, content)
        }

        if (!result.result || result.result.code !== 'SUCCESS') {
          const msg = (result.result && result.result.message) || '操作失败'
          this.setData({ error: msg, saving: false })
          return
        }

        const data = result.result.data || {}
        if (data.conflict) {
          // 乐观锁冲突：返回最新数据让调用方重试
          this.triggerEvent('conflict', { note: data.note })
          this.setData({ saving: false })
          return
        }

        this.triggerEvent('confirm', { note: data.note })
      } catch (e) {
        this.setData({ error: '网络异常，请重试', saving: false })
      }
    },
  },
})
