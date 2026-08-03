/**
 * 导航栏计算工具函数
 * 统一各页面 _calcNavHeight() 逻辑，避免代码重复
 *
 * 使用示例：
 *   const navbar = require('../../utils/navbar')
 *   Page({
 *     onLoad() {
 *       const layout = navbar.getNavLayout()
 *       this.setData({
 *         navTotalHeight: layout.totalHeight,
 *         navBarHeight: layout.navBarHeight,
 *         statusBarHeight: layout.statusBarHeight,
 *       })
 *     },
 *   })
 */

/**
 * 获取导航栏布局信息
 * @returns {{ totalHeight: number, navBarHeight: number, statusBarHeight: number }}
 */
function getNavLayout() {
  try {
    const info = wx.getSystemInfoSync() || {}
    const menu = wx.getMenuButtonBoundingClientRect()
    const statusBarHeight = Number(info.statusBarHeight) || 20
    const navBarHeight = (menu && menu.top > 0 && menu.height > 0)
      ? Math.max(44, (menu.top - statusBarHeight) * 2 + menu.height)
      : 44
    return {
      totalHeight: statusBarHeight + navBarHeight,
      navBarHeight,
      statusBarHeight,
    }
  } catch (e) {
    return { totalHeight: 96, navBarHeight: 44, statusBarHeight: 20 }
  }
}

/**
 * 获取导航栏总高度（statusBar + navBar）
 * @returns {number}
 */
function getNavTotalHeight() {
  return getNavLayout().totalHeight
}

/**
 * 获取导航栏高度（不含 statusBar）
 * @returns {number}
 */
function getNavBarHeight() {
  return getNavLayout().navBarHeight
}

/**
 * 获取状态栏高度
 * @returns {number}
 */
function getStatusBarHeight() {
  return getNavLayout().statusBarHeight
}

/**
 * 计算右上角胶囊按钮距离右侧的间距
 * 用于定位自定义 navbar 右侧按钮
 * @returns {number}
 */
function getMenuRightMargin() {
  try {
    const info = wx.getSystemInfoSync() || {}
    const menu = wx.getMenuButtonBoundingClientRect()
    const screenWidth = info.windowWidth || 375
    return screenWidth - menu.right
  } catch (e) {
    return 16
  }
}

module.exports = {
  getNavLayout,
  getNavTotalHeight,
  getNavBarHeight,
  getStatusBarHeight,
  getMenuRightMargin,
}
