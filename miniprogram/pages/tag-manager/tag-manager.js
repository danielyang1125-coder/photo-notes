const app = getApp()
Page({
  data: { list:[], loading:false },
  onLoad(){ this.loadTags() },
  loadTags(){
    const that=this
    that.setData({loading:true})
    wx.cloud.callFunction({name:'tag',data:{type:'list',mode:'ALL'}})
      .then(res=>{
        if(res.result.code==='SUCCESS') that.setData({list:res.result.data.list||[]})
      })
      .catch(err=>console.error('[tag-manager]',err))
      .finally(()=>that.setData({loading:false}))
  },
  handleBack(){ wx.navigateBack() },
  handleAction(e){
    const {id,action}=e.currentTarget.dataset
    if(action==='delete'){
      wx.showModal({title:'删除标签',content:'删除标签不会删除图片或备注，但关联将被移除。',success:r=>{
        if(r.confirm) this.deleteTag(id)
      }})
    }else if(action==='rename'){
      /* S5 实现：使用 tag-name-editor 组件 */
    }
  },
  deleteTag(tagId){
    wx.cloud.callFunction({name:'tag',data:{type:'delete',tagId}})
      .then(res=>{
        if(res.result.code==='SUCCESS'){ wx.showToast({title:'已删除'}); app.globalData.refreshTags=true; this.loadTags() }
        else wx.showToast({title:res.result.message||'删除失败',icon:'none'})
      })
      .catch(()=>wx.showToast({title:'网络异常',icon:'none'}))
  }
})
