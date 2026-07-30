const { compress } = require('../../utils/compress')
const { extractShootTime } = require('../../utils/exif')
const { validatePhotoFormat, validatePhotoSize, readableLimit } = require('../../utils/validator')
const C = require('../../utils/constants')
const uploadService = require('../../services/upload')

const ACTIVE_STATUS = ['pending', 'compressing', 'uploading', 'confirming']
const FINAL_STATUS = ['success', 'failed', 'cancelled']

Component({
  properties: {
    visible: { type: Boolean, value: false },
  },

  data: {
    tasks: [],
    maxCount: C.UPLOAD_MAX_COUNT,
    showLeaveConfirm: false,
    totalCount: 0,
    uploadedCount: 0,
    successCount: 0,
    failedCount: 0,
    hasActive: false,
    allDone: false,
  },

  lifetimes: {
    attached() {
      this._batchGeneration = 0
      this._running = new Set()
      this._uploadHandles = {}
    },
    detached() {
      this.cancelActiveTasks()
    },
  },

  methods: {
    _setTasks(tasks, extra = {}, callback) {
      const successCount = tasks.filter(task => task.status === 'success').length
      const failedCount = tasks.filter(task => task.status === 'failed').length
      const hasActive = tasks.some(task => ACTIVE_STATUS.includes(task.status))
      const allDone = tasks.length > 0 && tasks.every(task => FINAL_STATUS.includes(task.status))
      this.setData({
        tasks,
        totalCount: tasks.length,
        uploadedCount: successCount,
        successCount,
        failedCount,
        hasActive,
        allDone,
        ...extra,
      }, callback)
    },

    _updateTask(id, patch) {
      const tasks = this.data.tasks.map(task => task.id === id ? { ...task, ...patch } : task)
      this._setTasks(tasks)
    },

    _getTask(id) {
      return this.data.tasks.find(task => task.id === id)
    },

    _isRunnable(id, generation) {
      const task = this._getTask(id)
      return generation === this._batchGeneration && task && ACTIVE_STATUS.includes(task.status)
    },

    handleVisibleChange(e) {
      if (e.detail.visible) return
      if (this.data.hasActive) {
        this.setData({ showLeaveConfirm: true })
      } else {
        this.triggerEvent('close')
      }
    },

    handleCancelLeave() {
      this.setData({ showLeaveConfirm: false })
    },

    handleConfirmLeave() {
      this.cancelActiveTasks()
      this.setData({ showLeaveConfirm: false })
      this.triggerEvent('close')
    },

    chooseImage(sourceType) {
      if (this.data.hasActive) {
        wx.showToast({ title: '图片正在上传，请稍候', icon: 'none' })
        return
      }
      this._setTasks([])
      this._chooseMedia(typeof sourceType === 'string' ? sourceType : '')
    },

    handleChooseImage() {
      this._chooseMedia('')
    },

    _chooseMedia(sourceType) {
      const remaining = C.UPLOAD_MAX_COUNT - this.data.tasks.length
      if (remaining <= 0) {
        wx.showToast({ title: `最多上传${C.UPLOAD_MAX_COUNT}张`, icon: 'none' })
        return
      }
      wx.chooseMedia({
        count: remaining,
        mediaType: ['image'],
        sizeType: ['original'],
        sourceType: sourceType ? [sourceType] : ['album', 'camera'],
        success: (res) => {
          const files = res.tempFiles || []
          if (files.length === 0) return
          const now = Date.now()
          const newTasks = files.map((file, index) => {
            const stableId = `${now}_${index}_${Math.random().toString(36).slice(2, 10)}`
            return {
              id: `task_${stableId}`,
              requestId: `upload_${stableId}`,
              filePath: file.tempFilePath,
              fileName: `图片 ${this.data.tasks.length + index + 1}`,
              fileSize: file.size,
              status: 'pending',
              progress: 0,
              thumb: file.thumbTempFilePath || file.tempFilePath,
              error: '',
              photoId: null,
            }
          })
          this._setTasks([...this.data.tasks, ...newTasks], {}, () => {
            this.triggerEvent('selected', { count: newTasks.length })
            this._pumpQueue()
          })
        },
      })
    },

    _pumpQueue() {
      while (this._running.size < C.UPLOAD_CONCURRENCY) {
        const next = this.data.tasks.find(task =>
          task.status === 'pending' && !this._running.has(task.id)
        )
        if (!next) break
        this._running.add(next.id)
        this._runTask(next.id, this._batchGeneration)
          .finally(() => {
            this._running.delete(next.id)
            delete this._uploadHandles[next.id]
            this._pumpQueue()
          })
      }
    },

    async _runTask(taskId, generation) {
      const initialTask = this._getTask(taskId)
      if (!initialTask) return
      this._updateTask(taskId, { status: 'compressing', error: '', progress: 0 })
      let uploadedFileId = ''
      let attemptId = ''
      try {
        const ext = (initialTask.filePath.split('.').pop() || '').toUpperCase()
        if (!validatePhotoFormat(ext)) throw new Error('不支持的格式')
        if (!validatePhotoSize(initialTask.fileSize)) throw new Error(`超过${readableLimit()}`)

        // Step 1: prepare — 获取服务端签发的 attemptId 和 cloudPath
        const prepareResult = await uploadService.prepare({ taskId: initialTask.requestId })
        if (!this._isRunnable(taskId, generation)) return
        if (prepareResult.result.code !== 'SUCCESS') {
          const msg = prepareResult.result.code === 'UPLOAD_DUPLICATED'
            ? '任务重复'
            : prepareResult.result.message || '准备上传失败'
          this._updateTask(taskId, { status: 'failed', error: msg })
          return
        }
        attemptId = prepareResult.result.data.attemptId
        this._updateTask(taskId, { _attemptId: attemptId })
        const serverCloudPath = prepareResult.result.data.cloudPath
        // 如果服务端已存在同名任务（幂等重试），直接成功
        if (prepareResult.result.data.photoId) {
          this._updateTask(taskId, { status: 'success', progress: 100, photoId: prepareResult.result.data.photoId })
          return
        }

        const exif = await extractShootTime(initialTask.filePath)
        if (!this._isRunnable(taskId, generation)) return
        const compressed = await compress(initialTask.filePath)
        if (!this._isRunnable(taskId, generation)) return

        // Step 2: 上传到服务端签发的路径
        this._updateTask(taskId, { status: 'uploading', progress: 0 })
        const uploadResult = await new Promise((resolve, reject) => {
          const uploadTask = wx.cloud.uploadFile({
            cloudPath: serverCloudPath,
            filePath: compressed.path,
            success: resolve,
            fail: reject,
          })
          this._uploadHandles[taskId] = uploadTask
          uploadTask.onProgressUpdate(progress => {
            if (this._isRunnable(taskId, generation)) {
              this._updateTask(taskId, { progress: progress.progress })
            }
          })
        })
        uploadedFileId = uploadResult.fileID
        if (!this._isRunnable(taskId, generation)) {
          if (uploadedFileId) wx.cloud.deleteFile({ fileList: [uploadedFileId] }).catch(() => {})
          return
        }

        // Step 3: confirm — 服务端验证文件并原子创建 photo
        this._updateTask(taskId, { status: 'confirming' })
        const confirmResult = await uploadService.confirm({
          attemptId,
          fileId: uploadedFileId,
          shootTime: exif.shootTime ? exif.shootTime.toISOString() : null,
          timeSource: exif.timeSource,
        })
        if (!this._isRunnable(taskId, generation)) return
        if (confirmResult.result.code === 'SUCCESS') {
          this._updateTask(taskId, {
            status: 'success',
            progress: 100,
            photoId: confirmResult.result.data.photo._id,
          })
        } else {
          const message = confirmResult.result.code === 'SPACE_EXCEEDED'
            ? '存储空间不足'
            : confirmResult.result.code === 'CONTENT_REVIEW_FAILED'
              ? '内容不合规'
              : confirmResult.result.message || '处理失败'
          this._updateTask(taskId, { status: 'failed', error: message })
        }
      } catch (error) {
        if (this._isRunnable(taskId, generation)) {
          this._updateTask(taskId, { status: 'failed', error: error.message || '上传失败' })
        }
      }
    },

    handleRetryTask(e) {
      const taskId = e.currentTarget.dataset.id
      const task = this._getTask(taskId)
      if (!task || task.status !== 'failed') return
      this._updateTask(taskId, { status: 'pending', progress: 0, error: '' })
      this._pumpQueue()
    },

    handleAddTags() {
      const photoIds = this.data.tasks
        .filter(task => task.status === 'success' && task.photoId)
        .map(task => task.photoId)
      if (photoIds.length > 0) this.triggerEvent('addtags', { photoIds })
    },

    handleDone() {
      this.triggerEvent('done', {
        photoIds: this.data.tasks.filter(task => task.status === 'success').map(task => task.photoId),
        successCount: this.data.successCount,
        failedCount: this.data.failedCount,
      })
      this._setTasks([])
    },

    handleCancel() {
      this.setData({ showLeaveConfirm: true })
    },

    handleCloseCompleted() {
      this.triggerEvent('close')
    },

    cancelActiveTasks() {
      this._batchGeneration += 1
      // 通知服务端取消所有活跃的 attempt
      const activeTasks = this.data.tasks.filter(t => ACTIVE_STATUS.includes(t.status))
      const attemptIds = activeTasks.map(t => t._attemptId).filter(Boolean)
      if (attemptIds.length > 0) {
        uploadService.cancel({ attemptIds }).catch(() => {})
      }
      Object.keys(this._uploadHandles).forEach(id => {
        const handle = this._uploadHandles[id]
        if (handle && handle.abort) handle.abort()
      })
      this._uploadHandles = {}
      const tasks = this.data.tasks.map(task =>
        ACTIVE_STATUS.includes(task.status) ? { ...task, status: 'cancelled', error: '' } : task
      )
      this._running.clear()
      this._setTasks(tasks)
    },
  },
})
