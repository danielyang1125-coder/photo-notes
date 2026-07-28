Component({
  properties: {
    state: {
      type: String,
      value: 'loading', // loading | empty | error
    },
    emptyText: {
      type: String,
      value: '暂无数据',
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
  },
})
