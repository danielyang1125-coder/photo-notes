const app = getApp()
Page({
  data: { list:[], loading:false, page:1, hasMore:true, sortBy:'created_at', sortOrder:'desc' },
  onLoad(){ this.loadNotes() },
  onShow(){
    if(app.globalData.refreshNotes){ app.globalData.refreshNotes=false; this.loadNotes(true) }
  },
  loadNotes(reset){
    const that=this
    if(reset){ that.setData({page:1,hasMore:true,list:[]}) }
    that.setData({loading:true})
    wx.cloud.callFunction({name:'note',data:{type:'list',page:that.data.page,pageSize:20,sortBy:that.data.sortBy,sortOrder:that.data.sortOrder}})
      .then(res=>{
        if(res.result.code==='SUCCESS'){
          that.setData({list:reset?res.result.data.list:[...that.data.list,...res.result.data.list],hasMore:res.result.data.hasMore,page:that.data.page+1})
        }
      })
      .catch(err=>console.error('[notes]',err))
      .finally(()=>that.setData({loading:false}))
  },
  onReachBottom(){ if(this.data.hasMore&&!this.data.loading) this.loadNotes() }
})
