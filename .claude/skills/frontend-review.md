---
name: frontend-review
description: Review frontend code against project conventions (TDesign usage, state management, API patterns, accessibility). Triggers on "review前端", "frontend review", "检查前端代码".
---

# Frontend Review — 前端代码评审

按照项目规范逐项检查前端代码，覆盖所有关键检查维度。

## 检查清单

### 1. 页面 JSON

- [ ] `"navigationStyle": "custom"` 已设置
- [ ] TDesign 组件在 `usingComponents` 中**局部注册**，非全局
- [ ] 路径与页面位置匹配
- [ ] `page-state` 组件已注册

### 2. 页面 JS

- [ ] 顶部 `const app = getApp()` + services 的 `require()`
- [ ] `pageState` 使用正确值：`initialLoading` | `loading` | `ready` | `empty` | `error` | `initialError`
- [ ] `_initNavigation()` 在 `onLoad` 中调用
- [ ] `onShow` 检查 `app.globalData.refresh*` 标记并重置
- [ ] 请求去重：`this._inflight` Map + `_queryVersion` 计数器
- [ ] 重入保护：操作守卫布尔值（`_navigating`、`_processing`）
- [ ] `onUnload`/`onHide` 清理：中止上传、清除定时器
- [ ] 过期响应守卫：`_isCurrent()` 或版本号检查
- [ ] 错误处理有用户可见 toast
- [ ] 常量从 `'../../utils/constants'` 导入，无魔数

### 3. 页面 WXML

- [ ] 顶层 `<view class="page">`
- [ ] `<page-state>` 包裹非 ready 状态
- [ ] TDesign 组件 `t-` 前缀
- [ ] 事件 `bind:tap="handler"` 冒号语法
- [ ] 所有 `wx:for` 有 `wx:key`
- [ ] 交互元素有 aria-label
- [ ] 自定义导航结构正确

### 4. 组件 JS

- [ ] `Component({...})` 构造器
- [ ] `properties` 有类型标注
- [ ] `lifetimes: { attached, detached }`（非旧式顶层写法）
- [ ] 事件：`triggerEvent('name', detail)` 而非直接操作父页
- [ ] 无直接 `wx.cloud.callFunction` 调用
- [ ] 私有属性 `_` 前缀

### 5. Services

- [ ] `NAME` 常量匹配云函数名
- [ ] 私有 `call(type, data)` 辅助函数
- [ ] 导出函数使用 `export function`
- [ ] Service 层无错误处理（错误冒泡到调用方）
- [ ] 参数名匹配云函数期望字段

### 6. Utils

- [ ] 常量仅在 `constants.js`，通过 `require` 引用
- [ ] 校验使用 `validator.js`，前后端同口径
- [ ] 无内联魔数或魔字符串

### 7. 设计令牌

- [ ] 使用 `var(--color-*)` 而非硬编码色值
- [ ] 使用 `rpx` 适配
- [ ] 遵循设计系统 §2 颜色规范

### 8. 无障碍与交互

- [ ] 操作热区 ≥ 44px
- [ ] 图标按钮有可读标签
- [ ] 状态反馈不只用颜色（图标 + 文字 + 颜色）

### 9. 性能

- [ ] 列表使用 `wx:key`
- [ ] 图片使用懒加载/缩略图
- [ ] 避免 `setData` 调用过大对象

### 10. 常见禁止模式

- [ ] 无直接 `wx.cloud.callFunction` 调用（应用 services）
- [ ] 无缺失导航守卫导致重复跳转
- [ ] 无过期响应未防护
- [ ] 无跳过 `pageState` 管理
- [ ] 无内联 style 写死尺寸

## 核心参考文件

- [DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM-图片笔记小程序-V1.0.0.md) — 设计规范和组件策略
- [TECHNICAL-ARCHITECTURE.md §3](docs/TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md) — 前端架构章节
- [pages/photos/photos.js](miniprogram/pages/photos/photos.js) — 最完整页面参考
