const app = getApp()
Page({
  data: { status:'loading', errorMsg:'' },
  onLoad(){
    if(app.globalData.isLoggedIn){
      const user=app.globalData.userInfo
      if(user&&user.status==='DELETING') {
        wx.redirectTo({url:'/pages/deletion-status/deletion-status'})
      } else {
        wx.switchTab({url:'/pages/photos/photos'})
      }
      return
    }
    this.doLogin()
  },
  doLogin(){
    const that=this
    that.setData({status:'loading'})
    wx.cloud.callFunction({name:'user',data:{type:'login'}})
      .then(res=>{
        const {code,data}=res.result
        if(code==='SUCCESS'&&data){
          app.globalData.userInfo=data.user
          app.globalData.isLoggedIn=true
          if(data.user.status==='DELETING'){
            wx.redirectTo({url:'/pages/deletion-status/deletion-status'})
          } else {
            wx.switchTab({url:'/pages/photos/photos'})
          }
        }else{
          that.setData({status:'error',errorMsg:res.result?.message||'登录失败，请重试'})
        }
      })
      .catch(err=>{ that.setData({status:'error',errorMsg:err.message||'网络异常，请检查连接后重试'}) })
  },
  handleRetry(){ this.doLogin() }
})
