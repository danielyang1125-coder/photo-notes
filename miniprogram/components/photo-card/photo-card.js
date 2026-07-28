Component({
  properties: {
    photo: {
      type: Object,
      value: {},
    },
    cardHeight: {
      type: Number,
      value: 360,
    },
  },
  methods: {
    handleTap() {
      const { _id } = this.properties.photo
      if (_id) {
        wx.navigateTo({ url: '/pages/preview/preview?photoId=' + _id })
      }
    },
  },
})
