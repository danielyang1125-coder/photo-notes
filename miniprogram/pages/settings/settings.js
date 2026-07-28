const app = getApp()
Page({
  data: {
    usedBytes:0, limitBytes:524288000,
    usedMB:'0', limitMB:'500',
    usagePercent:0,
    showDeleteDialog:false
  },
  onLoad(){ this.loadStatus() },
  onShow(){ this.loadStatus() },
  loadStatus(){
    const ui=app.globalData.userInfo||{}
    const used=ui.used_bytes||0, limit=ui.limit_bytes||524288000
    this.setData({
      usedBytes:used, limitBytes:limit,
      usedMB:(used/1048576).toFixed(1), limitMB:(limit/1048576).toFixed(0),
      usagePercent:limit>0?Math.round(used/limit*100):0
    })
  },
  handleBack(){ wx.switchTab({url:'/pages/photos/photos'}) },
  handleTagManage(){ wx.navigateTo({url:'/pages/tag-manager/tag-manager'}) },
  handleDeleteAccount(){ this.setData({showDeleteDialog:true}) },
  handleCancelDeletion(){ this.setData({showDeleteDialog:false}) },
  handleConfirmDeletion(){
    this.setData({showDeleteDialog:false})
    wx.cloud.callFunction({name:'account',data:{type:'requestDeletion',confirmText:'确认注销'}})
      .then(res=>{
        if(res.result.code==='SUCCESS') wx.redirectTo({url:'/pages/deletion-status/deletion-status'})
        else wx.showToast({title:res.result.message||'操作失败',icon:'none'})
      })
      .catch(()=>wx.showToast({title:'网络异常',icon:'none'}))
  }
})
