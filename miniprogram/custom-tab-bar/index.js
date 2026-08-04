Component({
  data: {
    selected: 0,
    list: [
      {
        pagePath: '/pages/photos/photos',
        text: '图片',
        icon: '',
      },
      {
        pagePath: '/pages/notes/notes',
        text: '备注',
        icon: '',
      },
      {
        pagePath: '/pages/settings/settings',
        text: '我的',
        icon: '',
      },
    ],
  },
  methods: {
    switchTab(e) {
      const data = e.currentTarget.dataset
      const url = data.path
      const index = data.index
      if (this.data.selected === index) return
      this.setData({ selected: index })
      wx.switchTab({ url })
    },
  },
})
