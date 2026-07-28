const app = getApp()
Page({
  data: { status:'loading', retryCount:0 },
  onLoad(){ this.checkStatus() },
  checkStatus(){
    const that=this
    wx.cloud.callFunction({name:'account',data:{type:'getDeletionStatus'}})
      .then(res=>{
        if(res.result.code==='SUCCESS'){
          const s=res.result.data.status
          if(s==='PENDING'||s==='PROCESSING'||s==='RETRYING') that.setData({status:'processing',retryCount:res.result.data.retryCount||0})
          else if(s==='COMPLETED') that.setData({status:'completed'})
          else that.setData({status:'processing'})
        }
      })
      .catch(()=>that.setData({status:'processing'}))
  },
  handleRefresh(){ this.setData({status:'loading'}); this.checkStatus() }
})
