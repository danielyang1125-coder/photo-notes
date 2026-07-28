const { compress } = require('../../utils/compress')
const { extractShootTime } = require('../../utils/exif')
const { validatePhotoFormat, validatePhotoSize, readableLimit } = require('../../utils/validator')
const C = require('../../utils/constants')
const uploadService = require('../../services/upload')

let batchSeq = 0

Component({
  properties: {
    visible: { type: Boolean, value: false },
  },

  data: {
    tasks: [],
    maxCount: C.UPLOAD_MAX_COUNT,
    showLeaveConfirm: false,
  },

  computed: {
    totalCount() { return this.data.tasks.length },
    uploadedCount() {
      return this.data.tasks.filter((t) => t.status === 'success').length
    },
    successCount() { return this.data.tasks.filter((t) => t.status === 'success').length },
    hasActive() {
      return this.data.tasks.some((t) => ['pending', 'compressing', 'uploading', 'confirming'].includes(t.status))
    },
    allDone() {
      if (this.data.tasks.length === 0) return false
      return this.data.tasks.every((t) => ['success', 'failed', 'cancelled'].includes(t.status))
    },
  },

  observers: {
    visible(val) {
      if (!val) this._resetBatchSeq()
    },
  },

  methods: {
    _resetBatchSeq() { batchSeq++ },

    handleVisibleChange(e) {
      if (!e.detail.visible) {
        // 关闭时检查是否有活跃任务
        if (this.data.hasActive) {
          this.setData({ showLeaveConfirm: true })
        } else {
          this.triggerEvent('close')
        }
      }
      // 打开时不触发任何事件
    },

    handleCancelLeave() { this.setData({ showLeaveConfirm: false }) },
    handleConfirmLeave() {
      this.setData({ showLeaveConfirm: false })
      // 取消所有非成功任务
      const tasks = this.data.tasks.map((t) => {
        if (t.status !== 'success') return { ...t, status: 'cancelled' }
        return t
      })
      this.setData({ tasks })
    },

    /** 选择图片 */
    handleChooseImage() {
      const remaining = C.UPLOAD_MAX_COUNT - this.data.tasks.length
      if (remaining <= 0) return wx.showToast({ title: '最多上传' + C.UPLOAD_MAX_COUNT + '张', icon: 'none' })

      wx.chooseMedia({
        count: remaining,
        mediaType: ['image'],
        sizeType: ['original'],
        sourceType: ['album', 'camera'],
        success: (res) => {
          const newTasks = res.tempFiles.map((f, i) => ({
            id: 'task_' + Date.now() + '_' + i,
            filePath: f.tempFilePath,
            fileName: '图片 ' + (Date.now() % 10000),
            fileSize: f.size,
            status: 'pending',
            progress: 0,
            thumb: f.thumbTempFilePath || f.tempFilePath,
            error: '',
            photoId: null,
          }))
          this.setData({ tasks: [...this.data.tasks, ...newTasks] })
          this._processQueue()
        },
      })
    },

    /** 处理上传队列（并发3） */
    async _processQueue() {
      const batchId = 'batch_' + Date.now()
      batchSeq++

      const processNext = async () => {
        const tasks = this.data.tasks
        const pending = tasks.findIndex((t) => t.status === 'pending')
        if (pending === -1) return

        const activeCount = tasks.filter((t) => ['compressing', 'uploading', 'confirming'].includes(t.status)).length
        if (activeCount >= C.UPLOAD_CONCURRENCY) return

        const task = tasks[pending]
        this._updateTask(task.id, { status: 'compressing' })

        try {
          // Step 1: 校验
          const ext = task.filePath.split('.').pop()
          if (!validatePhotoFormat(ext)) {
            this._updateTask(task.id, { status: 'failed', error: '不支持的格式' })
            processNext()
            return
          }
          if (!validatePhotoSize(task.fileSize)) {
            this._updateTask(task.id, { status: 'failed', error: '超过' + readableLimit() })
            processNext()
            return
          }

          // Step 2: EXIF 提取
          const exif = await extractShootTime(task.filePath)

          // Step 3: 压缩
          const compressed = await compress(task.filePath)

          // Step 4: 上传到云存储
          this._updateTask(task.id, { status: 'uploading', progress: 0 })
          const ext2 = task.filePath.split('.').pop() || 'jpg'
          const ts = Date.now()
          const rand = Math.random().toString(36).slice(2, 10)
          const cloudPath = 'photos/' + ts + '_' + rand + '.' + ext2

          const uploadResult = await new Promise((resolve, reject) => {
            const uploadTask = wx.cloud.uploadFile({
              cloudPath,
              filePath: compressed.path,
              success: resolve,
              fail: reject,
            })
            uploadTask.onProgressUpdate((res) => {
              this._updateTask(task.id, { progress: res.progress })
            })
          })

          // Step 5: confirm
          this._updateTask(task.id, { status: 'confirming' })
          const taskId = batchId + '_' + pending
          const confirmResult = await uploadService.confirm({
            fileId: uploadResult.fileID,
            size: compressed.size,
            width: compressed.width,
            height: compressed.height,
            format: compressed.path.endsWith('.png') ? 'PNG' : 'JPEG',
            shootTime: exif.shootTime ? exif.shootTime.toISOString() : null,
            timeSource: exif.timeSource,
            taskId,
          })

          if (confirmResult.result.code === 'SUCCESS') {
            this._updateTask(task.id, {
              status: 'success',
              photoId: confirmResult.result.data.photo._id,
            })
          } else if (confirmResult.result.code === 'CONTENT_REVIEW_FAILED') {
            this._updateTask(task.id, { status: 'failed', error: '内容不合规' })
          } else {
            this._updateTask(task.id, { status: 'failed', error: confirmResult.result.message || '处理失败' })
          }
        } catch (e) {
          this._updateTask(task.id, { status: 'failed', error: e.message || '上传失败' })
        }

        processNext()
      }

      // 启动并发
      for (let i = 0; i < C.UPLOAD_CONCURRENCY; i++) {
        processNext()
      }
    },

    _updateTask(id, patch) {
      const tasks = this.data.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t))
      this.setData({ tasks })
    },

    /** 完成 — 触发批量标签 */
    handleDone() {
      const successTasks = this.data.tasks.filter((t) => t.status === 'success')
      this.triggerEvent('done', {
        photoIds: successTasks.map((t) => t.photoId).filter(Boolean),
        successCount: successTasks.length,
        failedCount: this.data.tasks.filter((t) => t.status === 'failed').length,
      })
      this.close()
    },

    handleCancel() {
      this.setData({ showLeaveConfirm: true })
    },

    close() {
      this.setData({ tasks: [], showLeaveConfirm: false })
      this.triggerEvent('close')
    },
  },
})
