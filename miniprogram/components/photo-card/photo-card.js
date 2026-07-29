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
  data: {
    imageError: false,
  },
  observers: {
    'photo.thumbnail_url'() {
      this.setData({ imageError: false })
    },
  },
  methods: {
    handleTap() {
      const { _id } = this.properties.photo
      if (_id) {
        this.triggerEvent('select', { photoId: _id })
      }
    },
    handleImageError() {
      this.setData({ imageError: true })
    },
  },
})
