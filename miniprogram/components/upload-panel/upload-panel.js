const { compress } = require('../../utils/compress')
const { extractShootTime } = require('../../utils/exif')
const { validatePhotoFormat, validatePhotoSize, readableLimit } = require('../../utils/validator')
const C = require('../../utils/constants')
const uploadService = require('../../services/upload')

const ACTIVE_STATUS = ['pending', 'compressing', 'uploading', 'confirming']
const FINAL_STATUS = ['success', 'failed', 'cancelled']
const UPLOAD_TIMEOUT_MS = 120000 // 单文件上传超时 2 分钟

// 需要生成新 requestId 才能重试的错误（原 attempt 已进入终端状态）
const TERMINAL_ATTEMPT_CODES = ['UPLOAD_ATTEMPT_EXPIRED', 'UPLOAD_ATTEMPT_CANCELED', 'UPLOAD_ATTEMPT_NOT_FOUND']
// 需要等待后重试的错误（服务端正持有确认租约）
const LEASE_HELD_CODES = ['UPLOAD_CONFIRM_IN_PROGRESS']
// 确定性失败，重试无意义
const DETERMINISTIC_FAILURE_MESSAGES = ['不支持的格式', '超过']

Component({
  properties: {
    visible: { type: Boolean, value: false },
  },

  data: {
    tasks: [],
    maxCount: C.UPLOAD_MAX_COUNT,
    showLeaveConfirm: false,
    showTagPicker: false,
    batchPhotoIds: [],
    totalCount: 0,
    uploadedCount: 0,
    successCount: 0,
    failedCount: 0,
    errorHint: '',
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
      const firstFailed = tasks.find(task => task.status === 'failed')
      const errorHint = firstFailed && firstFailed.error ? firstFailed.error : '上传失败，请重试'
      const hasActive = tasks.some(task => ACTIVE_STATUS.includes(task.status))
      const allDone = tasks.length > 0 && tasks.every(task => FINAL_STATUS.includes(task.status))
      this.setData({
        tasks,
        totalCount: tasks.length,
        uploadedCount: successCount,
        successCount,
        failedCount,
        errorHint,
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
      this._updateTask(taskId, { status: 'compressing', error: '', errorCode: '', progress: 0 })
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
          const code = prepareResult.result.code
          const msg = code === 'UPLOAD_DUPLICATED'
            ? '任务重复'
            : prepareResult.result.message || '准备上传失败'
          const isTerminal = TERMINAL_ATTEMPT_CODES.includes(code)
          this._updateTask(taskId, {
            status: 'failed',
            error: msg,
            errorCode: code,
            canRetry: isTerminal, // 终端状态可通过换 requestId 重试
          })
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

        // Step 2: 上传到服务端签发的路径（带超时保护）
        this._updateTask(taskId, { status: 'uploading', progress: 0 })
        const uploadResult = await new Promise((resolve, reject) => {
          let settled = false
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            if (uploadTask && uploadTask.abort) uploadTask.abort()
            reject(new Error('上传超时，请检查网络后重试'))
          }, UPLOAD_TIMEOUT_MS)

          const uploadTask = wx.cloud.uploadFile({
            cloudPath: serverCloudPath,
            filePath: compressed.path,
            success: (res) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve(res)
            },
            fail: (err) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              reject(err)
            },
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
          const code = confirmResult.result.code
          let message
          if (code === 'SPACE_EXCEEDED') {
            message = '存储空间不足'
          } else if (code === 'CONTENT_REVIEW_FAILED') {
            message = '内容不合规'
          } else {
            message = confirmResult.result.message || '处理失败'
          }
          const isLeaseHeld = LEASE_HELD_CODES.includes(code)
          this._updateTask(taskId, {
            status: 'failed',
            error: message,
            errorCode: code,
            canRetry: isLeaseHeld, // 租约持有可等待后重试
          })
        }
      } catch (error) {
        if (this._isRunnable(taskId, generation)) {
          const msg = error.message || '上传失败'
          // 确定性失败（格式/大小校验）重试无意义
          const isDeterministic = DETERMINISTIC_FAILURE_MESSAGES.some(prefix => msg.startsWith(prefix))
          this._updateTask(taskId, {
            status: 'failed',
            error: msg,
            errorCode: '',
            canRetry: !isDeterministic,
          })
        }
      }
    },

    handleRetryTask(e) {
      const taskId = e.currentTarget.dataset.id
      const task = this._getTask(taskId)
      if (!task || task.status !== 'failed') return

      const code = task.errorCode || ''

      // 终端状态：生成新 requestId 创建全新 attempt
      if (TERMINAL_ATTEMPT_CODES.includes(code)) {
        const now = Date.now()
        const newRequestId = `upload_${now}_${Math.random().toString(36).slice(2, 10)}`
        this._updateTask(taskId, {
          status: 'pending',
          progress: 0,
          error: '',
          errorCode: '',
          requestId: newRequestId,
          canRetry: true,
        })
        this._pumpQueue()
        return
      }

      // 租约持有：延迟重试
      if (LEASE_HELD_CODES.includes(code)) {
        wx.showToast({ title: '正在处理中，3秒后自动重试', icon: 'none', duration: 2000 })
        this._updateTask(taskId, { status: 'pending', progress: 0, error: '', errorCode: '' })
        setTimeout(() => {
          if (this._getTask(taskId) && this._getTask(taskId).status === 'pending') {
            this._pumpQueue()
          }
        }, 3000)
        return
      }

      // 普通可重试错误（网络超时等）
      this._updateTask(taskId, { status: 'pending', progress: 0, error: '', errorCode: '' })
      this._pumpQueue()
    },

    handleAddTags() {
      const photoIds = this.data.tasks
        .filter(task => task.status === 'success' && task.photoId)
        .map(task => task.photoId)
      if (photoIds.length === 0) return
      this.setData({ batchPhotoIds: photoIds, showTagPicker: true })
    },

    handleTagPickerClose() {
      this.setData({ showTagPicker: false })
    },

    handleTagPickerConfirm() {
      this.setData({ showTagPicker: false, batchPhotoIds: [] })
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
