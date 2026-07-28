Component({
  properties: {
    tags: { type: Array, value: [] },
  },
  methods: {
    handleEdit() {
      this.triggerEvent('edit')
    },
  },
})
