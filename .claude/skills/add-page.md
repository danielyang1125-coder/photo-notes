---
name: add-page
description: Create a new WeChat Mini Program page following project conventions (4 files + app.json registration). Triggers on "新建页面", "create a new page", "add page".
---

# Add Page — 新建小程序页面

按照项目规范创建新的微信小程序页面的 4 个文件（`.wxml` / `.wxss` / `.js` / `.json`），并在 `app.json` 中注册路由。

## 文件创建步骤

1. 创建目录 `miniprogram/pages/<page-name>/`
2. 创建 4 个文件：`<page-name>.wxml`, `<page-name>.wxss`, `<page-name>.js`, `<page-name>.json`
3. 在 `miniprogram/app.json` 的 `pages` 数组中注册路径
4. 如果页面需要作为 Tab，在 `tabBar.list` 中添加配置

## 文件命名

- 全小写 kebab-case：`miniprogram/pages/<page-name>/<page-name>.{wxml,wxss,js,json}`
- 目录名与文件名一致（如 `pages/tag-manager/tag-manager.js`）

## 路由规则

- 仅 `photos` 和 `notes` 是 Tab 页
- 其他页面通过 `wx.navigateTo()` 跳转
- PG-001（index）→ PG-002（photos）：`wx.redirectTo()`（不保留启动页）
- PG-007（settings）→ PG-008（deletion-status）：`wx.redirectTo()`（注销后不可返回）

## .json 必须包含

```json
{
  "navigationStyle": "custom",
  "usingComponents": {
    "page-state": "../../components/page-state/page-state",
    "t-navbar": "tdesign-miniprogram/navbar/navbar"
  }
}
```

- `"navigationStyle": "custom"`（除非是纯加载/弹窗页）
- `usingComponents` 局部注册 TDesign 组件，**禁止全局注册**
- TDesign 组件路径格式：`"t-button": "tdesign-miniprogram/button/button"`
- 必须注册 `page-state` 组件
- 按需注册其他 TDesign 组件（参见 [设计系统 §5](docs/DESIGN-SYSTEM-图片笔记小程序-V1.0.0.md) 的组件分配表）

## .js 必须包含

```javascript
const app = getApp()
const someService = require('../../services/some')

Page({
  data: {
    pageState: 'initialLoading',
    // 自定义导航
    statusBarHeight: 0,
    navBarHeight: 0,
    navTotalHeight: 0,
    settingsRight: 0
  },

  onLoad(options) {
    this._initNavigation()
    this._loadData()
  },

  onShow() {
    // 检查跨页刷新标记
    if (app.globalData.refreshXxx) {
      app.globalData.refreshXxx = false
      this._loadData()
    }
  },

  // 自定义导航初始化
  _initNavigation() {
    const sysInfo = wx.getSystemInfoSync()
    const menuBtn = wx.getMenuButtonBoundingClientRect()
    this.setData({
      statusBarHeight: sysInfo.statusBarHeight,
      navBarHeight: (menuBtn.bottom - sysInfo.statusBarHeight) + menuBtn.top,
      navTotalHeight: sysInfo.statusBarHeight + (menuBtn.bottom - sysInfo.statusBarHeight) + menuBtn.top,
      settingsRight: sysInfo.windowWidth - menuBtn.left + 8
    })
  },

  // 请求去重
  _inflight: new Map(),
  _queryVersion: 0,

  async _loadData() {
    this._queryVersion++
    const version = this._queryVersion
    // ... 加载逻辑
    // 回调中检查: if (this._queryVersion !== version) return
  }
})
```

### 关键约束

- 顶部：`const app = getApp()` + 各 service 的 `require()`
- `data.pageState` 取值：`'initialLoading'` | `'loading'` | `'ready'` | `'empty'` | `'error'` | `'initialError'`
- `onLoad` 中调用 `_initNavigation()` 计算导航栏高度
- `onShow` 中检查 `app.globalData.refresh*` 标记并重置为 `false`
- 请求去重：`this._inflight` Map + `this._queryVersion` 计数器
- 重入保护：关键操作使用 `_navigating`、`_processing` 等守卫布尔值防止双击
- 所有 API 调用通过 `services/` 层
- 常量从 `'../../utils/constants'` 导入，禁止硬编码数字

## .wxml 必须包含

```xml
<view class="page">
  <!-- 自定义导航栏 -->
  <view class="nav-fixed" style="padding-top:{{statusBarHeight}}px;height:{{navTotalHeight}}px;">
    <view class="nav-inner" style="height:{{navBarHeight}}px;">
      <view class="nav-title">页面标题</view>
    </view>
  </view>

  <!-- 统一状态组件 -->
  <page-state wx:if="{{pageState !== 'ready'}}" state="{{pageState}}" bind:retry="_loadData" />

  <!-- 主要内容 -->
  <view wx:else class="page-content">
    <!-- ... -->
  </view>
</view>
```

### 关键约束

- 顶层 `<view class="page">`
- 自定义导航按上述结构
- 使用 `<page-state>` 组件包裹加载/空/错误状态
- TDesign 组件使用 `t-` 前缀
- 事件绑定使用冒号语法 `bind:tap="handler"`
- 所有 `wx:for` 必须有 `wx:key`

## .wxss 必须包含

```css
.page {
  min-height: 100vh;
  background: #F3F3F3;
}

.nav-fixed {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  background: #fff;
}

.nav-inner {
  display: flex;
  align-items: center;
  padding: 0 16px;
}

.nav-title {
  font-size: 18px;
  font-weight: 600;
  color: #181818;
}

.page-content {
  padding: 0 16px;
}
```

### 关键约束

- 使用 `var(--color-*)` 设计令牌（如 `var(--color-bg-page)`、`var(--color-text-primary)`）
- 使用 `rpx` 单位
- 页面左右安全边距 16px
- 导航固定定位、顶部零距离

## 核心参考文件

- [pages/photos/photos.js](miniprogram/pages/photos/photos.js) — 最完整的页面示例
- [pages/photos/photos.json](miniprogram/pages/photos/photos.json) — TDesign 注册示例
- [DESIGN-SYSTEM.md §5](docs/DESIGN-SYSTEM-图片笔记小程序-V1.0.0.md) — TDesign 组件分配表
- [TECHNICAL-ARCHITECTURE.md §3](docs/TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md) — 前端架构
