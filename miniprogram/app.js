// app.js — 图片笔记小程序
App({
  globalData: {
    env: 'cloud1-d0gsee3m13c2b446c',
    userInfo: null,
    isLoggedIn: false,
    // 跨页面刷新标记
    refreshPhotos: false,
    refreshNotes: false,
    refreshTags: false,
  },

  onLaunch: function () {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }

    wx.cloud.init({
      env: this.globalData.env,
      traceUser: true,
    });
    // 登录由 pages/index/index 统一处理，避免竞态
  },
});
