---
name: add-component
description: Create a new WeChat Mini Program reusable component following project patterns. Triggers on "新建组件", "create a component", "封装组件".
---

# Add Component — 新建业务组件

按照项目规范创建新的微信小程序自定义组件（4 个文件）。

## 文件创建步骤

1. 创建目录 `miniprogram/components/<comp-name>/`
2. 创建 4 个文件：`<comp-name>.wxml`, `<comp-name>.wxss`, `<comp-name>.js`, `<comp-name>.json`
3. 在目标页面的 `.json` 中通过 `usingComponents` 注册

## 文件路径

`miniprogram/components/<comp-name>/<comp-name>.{wxml,wxss,js,json}`

## .js 模板

```javascript
Component({
  properties: {
    // 对外接口，清晰定义类型和默认值
    dataList: {
      type: Array,
      value: []
    },
    loading: {
      type: Boolean,
      value: false
    }
  },

  observers: {
    // 监听 property 变化
    'dataList'(newVal) {
      if (newVal && newVal.length > 0) {
        this._processData(newVal)
      }
    }
  },

  lifetimes: {
    attached() {
      // 组件挂载时的初始化
    },
    detached() {
      // 组件卸载时的清理
    }
  },

  methods: {
    _processData(list) {
      // 私有方法用 _ 前缀
    },

    onItemTap(e) {
      const { index } = e.currentTarget.dataset
      this.triggerEvent('select', { item: this.data.dataList[index], index })
    }
  }
})
```

### 关键约束

- 使用 `Component({})` 定义
- `properties` 必须标注类型和默认值
- 生命周期使用 `lifetimes: { attached() {}, detached() {} }` — **禁止**旧式顶层写法
- 使用 `observers` 监听 property 变化
- 通过 `this.triggerEvent('eventName', detailData)` 向上通信
- 私有属性/方法用 `_` 前缀（如 `this._batchGeneration = 0`）
- 子组件引用：`this.selectComponent('#id')`
- **禁止**直接调用 `wx.cloud.callFunction`（应通过事件向上传递）
- **禁止**滥用 `getApp()`（只在确实需要全局状态时使用）
- **单一职责**：状态映射 + 渲染，不做复杂业务逻辑
- 遵循"透传底层组件属性和事件"原则（设计系统 §6）

## .json 模板

```json
{
  "component": true,
  "styleIsolation": "apply-shared",
  "usingComponents": {}
}
```

- `"component": true` — 必须
- `"styleIsolation": "apply-shared"` — 共享设计令牌
- 局部注册所需 TDesign 组件

## .wxml 模板

```xml
<view class="comp-name">
  <view wx:for="{{dataList}}" wx:key="id" class="comp-name-item"
        data-index="{{index}}" bind:tap="onItemTap">
    <!-- ... -->
  </view>
</view>
```

### 关键约束

- 使用 `var(--color-*)` 令牌
- Props 绑定：`{{propName}}`
- 事件绑定：`bind:tap="methodName"`
- 所有 `wx:for` 必须有 `wx:key`

## 已有组件模式参考（从简到繁）

| 组件 | 复杂度 | 学习重点 |
|------|--------|---------|
| `page-state` | ★ | property 驱动 + 事件触发 |
| `photo-card` | ★★ | property 驱动 + 事件 + observer |
| `tag-filter-bar` | ★★★ | `lifetimes.attached` 调用 API + 刷新模式 |
| `upload-panel` | ★★★★★ | 复杂状态机 + 组件级队列管理 |

## 设计系统组合组件列表（§6）

已有和计划中的组合组件：`upload-panel`, `note-editor`, `photo-card`, `note-item`, `page-state`, `danger-confirm`, `tag-filter-bar`, `photo-tag-section`, `tag-picker`, `tag-manager-list`, `tag-name-editor`

新建组件时参考设计系统 §6 中的规格说明。

## 核心参考文件

- [components/page-state/](miniprogram/components/page-state/) — 最简组件参考
- [components/photo-card/](miniprogram/components/photo-card/) — 标准组件结构
- [components/upload-panel/](miniprogram/components/upload-panel/) — 复杂组件示例
- [DESIGN-SYSTEM.md §6](docs/DESIGN-SYSTEM-图片笔记小程序-V1.0.0.md) — 业务组合组件规格
