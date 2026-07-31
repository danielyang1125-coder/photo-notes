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
    // 自定义导航（使用 nav-fixed 时）
    statusBarHeight: 0,
    navBarHeight: 0,
    navTotalHeight: 0,
    settingsRight: 0
  },

  onLoad(options) {
    this._calcNavHeight()
    this._loadData()
  },

  onShow() {
    // 检查跨页刷新标记
    if (app.globalData.refreshXxx) {
      app.globalData.refreshXxx = false
      this._loadData()
    }
  },

  // 计算导航栏高度（所有使用 custom navigation 的页面都必须调用）
  _calcNavHeight() {
    try {
      const info = wx.getSystemInfoSync() || {}
      const menu = wx.getMenuButtonBoundingClientRect()
      const statusBarHeight = Number(info.statusBarHeight) || 20
      const navBarHeight = (menu && menu.top > 0 && menu.height > 0)
        ? Math.max(44, (menu.top - statusBarHeight) * 2 + menu.height)
        : 44
      this.setData({ navTotalHeight: statusBarHeight + navBarHeight })
    } catch (e) {
      this.setData({ navTotalHeight: 96 })
    }
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

### .js 关键约束

- `data.pageState` 取值：`'initialLoading'` | `'loading'` | `'ready'` | `'empty'` | `'error'` | `'initialError'`
- **`onLoad` 中必须调用 `_calcNavHeight()`**：无论使用哪种导航栏（见下方布局要求），都必须动态计算导航栏高度
- `onShow` 中检查 `app.globalData.refresh*` 标记并重置为 `false`
- 请求去重：`this._inflight` Map + `this._queryVersion` 计数器
- 重入保护：关键操作使用 `_navigating`、`_processing` 等守卫布尔值防止双击
- 所有 API 调用通过 `services/` 层
- 常量从 `'../../utils/constants'` 导入，禁止硬编码数字

## .wxml — 两种导航栏模式

### 模式 A：t-navbar（推荐，简单页面）

适用于设置、标签管理等简单页面。

```xml
<view class="page">
  <t-navbar title="页面标题" left-arrow bind:go-back="handleBack" />
  <view class="content" style="padding-top: {{navTotalHeight}}px;">
    <!-- ⚠️ content 必须有 padding-top，否则内容被固定导航栏遮挡 -->
    <!-- 页面内容 -->
  </view>
</view>
```

### 模式 B：自定义导航栏 nav-fixed（复杂页面）

适用于照片列表等需要自定义导航栏按钮、筛选栏的复杂页面。

```xml
<view class="page">
  <view class="nav-fixed" style="height: {{navTotalHeight}}px; padding-top: {{statusBarHeight}}px;">
    <view class="nav-inner" style="height: {{navBarHeight}}px;">
      <text class="nav-title">页面标题</text>
    </view>
  </view>
  <view class="content" style="padding-top: {{navTotalHeight}}px;">
    <!-- 页面内容 -->
  </view>
</view>
```

### .wxml 关键约束

- 顶层 `<view class="page">`
- **无论模式 A 还是 B，content 容器必须加 `padding-top: {{navTotalHeight}}px`**，否则内容会被 `position:fixed` 的导航栏遮挡
- 使用 `<page-state>` 组件包裹加载/空/错误状态
- TDesign 组件使用 `t-` 前缀
- 事件绑定使用冒号语法 `bind:tap="handler"`
- 所有 `wx:for` 必须有 `wx:key`
- 如果内容区域需要滚动，用 `<scroll-view scroll-y>` 并设置明确高度：`style="height: calc(100vh - {{navTotalHeight}}px);"`

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

### .wxss 关键约束

- 使用 `var(--color-*)` 设计令牌（如 `var(--color-bg-page)`、`var(--color-text-primary)`）
- 使用 `rpx` 单位
- 页面左右安全边距 16px
- 导航固定定位、顶部零距离

## 小程序页面布局完整检查清单

实现任何小程序页面时必须逐项确认：

### 1. 导航栏与内容区

| 检查项 | 说明 |
| --- | --- |
| ✅ 内容区 `padding-top` | **最常见 bug**：`t-navbar` / `nav-fixed` 都是 `position: fixed`，内容区必须 `padding-top: {{navTotalHeight}}px` |
| ✅ 导航栏高度计算 | 每个页面 JS 必须有 `_calcNavHeight()`，`onLoad` 中调用 |
| ✅ `navigationStyle: custom` | 页面 `.json` 中必须设置，否则系统导航栏和自定义导航栏叠加 |
| ✅ 窄图/全景图可见性 | 极窄图片（如 2560×576 → 84px 高）可能完全被导航栏遮盖 |

### 2. 底部安全区

| 检查项 | 说明 |
| --- | --- |
| ✅ Tab 页底部留白 | TabBar 高度约 100rpx，底部固定元素需 `bottom: 100rpx` 或加 `padding-bottom` |
| ✅ `safe-area-inset-bottom` | iPhone X+ 底部 Home Indicator，固定元素用 `env(safe-area-inset-bottom)` |
| ✅ FAB / 浮动按钮 | 上传按钮等 `position: fixed` 元素需确保不被 TabBar 遮挡 |

### 3. 滚动区域

| 检查项 | 说明 |
| --- | --- |
| ✅ `scroll-view` 高度 | 必须显式设置 `height`（如 `calc(100vh - {{navTotalHeight}}px)`），不能依赖 `flex: 1` |
| ✅ 非滚动页面 | 简单表单页（settings、tag-manager）用普通 `<view>` 即可，不需要 `scroll-view` |

### 4. 状态栏与胶囊按钮

| 检查项 | 说明 |
| --- | --- |
| ✅ 胶囊按钮避让 | 自定义导航栏右侧元素需计算 `settingsRight`，避免被胶囊按钮遮挡 |
| ✅ 状态栏文字颜色 | 深色背景页设 `navigationBarTextStyle: white`（仅影响系统导航栏） |

### 5. 页面间数据同步

| 检查项 | 说明 |
| --- | --- |
| ✅ 返回刷新 | 编辑后在 `onUnload` 设 `app.globalData.refresh* = true`，列表页 `onShow` 检测并重载 |
| ✅ 增量更新 | `photoListChange` 支持按 photoId 局部更新，避免全量刷新 |

### 6. 常见踩坑记录

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 页面顶部内容看不到 | `t-navbar` 固定定位，content 没加 `padding-top` | 加 `padding-top: {{navTotalHeight}}px` |
| 全景图/窄图不显示 | 图片高度 < 导航栏高度 | 同上 + 考虑最小高度兜底 |
| 备注时间 `[object Object]` | `db.serverDate()` 序列化后是对象 | 云函数回读 DB；前端兼容 `{$date: ...}` |
| `wx:for` 只显示一项 | 具名 slot 在 `wx:for` 中有 bug | 改用组件属性代替具名 slot |
| `wx:for` 列表只显示一项 | 自定义组件 + 具名 slot 在 `wx:for` 中有渲染 bug | 改用组件属性代替具名 slot |

## 核心参考文件

- [pages/photos/photos.js](miniprogram/pages/photos/photos.js) — 最完整的页面示例
- [pages/photos/photos.json](miniprogram/pages/photos/photos.json) — TDesign 注册示例
- [DESIGN-SYSTEM.md §5](docs/DESIGN-SYSTEM-图片笔记小程序-V1.0.0.md) — TDesign 组件分配表
- [TECHNICAL-ARCHITECTURE.md §3](docs/TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md) — 前端架构
