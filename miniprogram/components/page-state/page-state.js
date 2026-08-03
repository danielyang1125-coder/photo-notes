Component({
  properties: {
    state: {
      type: String,
      value: 'loading', // loading | initialLoading | empty | error | initialError
    },
    skeletonType: {
      type: String,
      value: 'list', // list | waterfall | note-list
    },
    emptyText: {
      type: String,
      value: '暂无数据',
    },
    emptyTitle: {
      type: String,
      value: '',
    },
    emptyDescription: {
      type: String,
      value: '',
    },
    emptyImage: {
      type: String,
      value: '',
    },
    emptyIcon: {
      type: String,
      value: 'image',
    },
    emptyAction: {
      type: String,
      value: '',
    },
    errorTitle: {
      type: String,
      value: '加载失败',
    },
    errorText: {
      type: String,
      value: '请检查网络后重试',
    },
    showRetry: {
      type: Boolean,
      value: true,
    },
  },
  methods: {
    handleRetry() {
      this.triggerEvent('retry')
    },
    handleEmptyAction() {
      this.triggerEvent('emptyAction')
    },
  },
})
