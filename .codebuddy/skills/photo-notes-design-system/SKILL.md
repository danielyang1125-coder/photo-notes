---
name: photo-notes-design-system
description: |
  图片笔记小程序设计规范技能。This skill should be used when developing, restoring, or modifying
  frontend pages and components for the photo-notes WeChat mini-program. It provides visual
  specifications including color tokens, typography, spacing, border-radius, shadows, component
  dimensions, and page layout rules. Trigger this skill when the user asks to: create a new page,
  modify an existing page, restore a design from mockups, fix UI inconsistencies, add a new
  component, adjust styling, or any task involving .wxml/.wxss files in the miniprogram directory.
---

# 图片笔记小程序 — 设计规范还原 Skill

## 概述

本 Skill 为「图片笔记」微信小程序的前端页面开发和设计还原提供视觉规范指导。
设计语言：克制、留白、以蓝色（`#0052D9`）为情感主线，整体偏 editorial/clean 风格。
基准画板：iOS 375 × 812，支持默认 / 加载骨架 / 空态 / 错误四种状态。

> 完整的 Design Token 定义位于 `miniprogram/theme/tokens.wxss`，所有页面和组件应引用这些 CSS 变量，禁止硬编码颜色或尺寸值。
> 详细的设计规范文档位于 `references/design-spec.md`，包含完整的颜色、字体、组件规格表。

## 触发场景

以下场景应加载此 Skill：
- 创建新页面或新组件（.wxml / .wxss / .js / .json）
- 修改现有页面或组件的样式
- 还原设计稿到前端代码
- 修复 UI 不一致、颜色/间距/圆角不符合规范的问题
- 添加新的 UI 元素（按钮、标签、卡片、模态层等）
- 用户提到"设计规范"、"视觉还原"、"样式调整"等关键词

## 核心规范速查

### 颜色使用原则

- 主色 `--color-primary`（`#0052D9`）面积控制在单页 30% 以内
- 正文和标题统一使用 `--color-text-primary`（`#181818`），禁止使用纯黑 `#000`
- 次级文字使用 `--color-text-secondary`（`#5E5E5E`）
- 占位/禁用文字使用 `--color-text-placeholder`（`#A6A6A6`）
- 危险操作使用 `--color-error`（`#D54941`）描边 + 文字，不使用实色背景
- 卡片之间用 `--color-border`（`#E8E8E8`）描边区分，不使用阴影
- 浮层（Tab Bar、Modal）才使用阴影，卡片不使用阴影

### 圆角分层

| 元素 | Token | 值 |
|------|-------|-----|
| 角标/徽章/Checkbox | `--radius-xs` | 4rpx |
| 普通卡片/按钮/Photo Card | `--radius-sm` | 8rpx |
| Tag/Chip | `--radius-tag` | 14rpx |
| Sort Button / Modal 顶角 | `--radius-lg` | 16rpx |
| Tab Bar 胶囊 | `--radius-pill` | 26rpx |
| FAB 圆形 | `--radius-circle` | 50% |

规则：同一容器内禁止混用差距 > 12rpx 的圆角。

### 字体系统

- 中文：`Noto Sans SC`（Regular / Medium / Bold / SemiBold）
- 数字/英文：`Inter`（用于时间戳、百分比、容量数字）

字号 Token 映射：
| Token | 值 | 用途 |
|-------|-----|------|
| `--font-size-xs` | 22rpx | caption / 时间戳 |
| `--font-size-sm` | 24rpx | body-sm / Tag 文案 |
| `--font-size-md` | 28rpx | body / label-md / 正文 |
| `--font-size-lg` | 32rpx | h3 / body-lg |
| `--font-size-xl` | 36rpx | h2 / Navbar 标题 |

### 间距系统（4rpx 基数）

| Token | 值 | 典型用法 |
|-------|-----|---------|
| `--space-xs` | 4rpx | 文字与 Icon 间距 |
| `--space-sm` | 8rpx | 卡片内垂直 padding / Tag 间距 |
| `--space-md` | 12rpx | 列表项垂直 padding / Grid 间距 |
| `--space-lg` | 16rpx | 卡片水平 padding / Modal 边距 |
| `--space-xl` | 24rpx | 区块上下分隔 |

### 阴影规范

| Token | 值 | 用途 |
|-------|-----|------|
| `--shadow-tab` | `0 4rpx 16rpx rgba(0,0,0,0.08)` | 底部 Tab Bar |
| `--shadow-modal` | `0 -4rpx 12rpx rgba(0,0,0,0.15)` | 模态层 |
| `--shadow-light` | `0 2rpx 8rpx rgba(0,0,0,0.10)` | 卡片轻浮（hover） |

## 关键组件规格

### Tag / Chip
- 高度 28px → 56rpx，自适应宽度
- 选中态：`--color-primary` 文字 + `--color-primary-light` 背景
- 未选态：`--color-text-primary` 文字 + `--color-surface-base` 背景 + `--color-border` 描边 1px
- 圆角 `--radius-tag`（14rpx），字体 `--font-size-sm`（24rpx）

### Primary Button
- 高度 ≥ 44px → 88rpx，宽度自适应
- 背景 `--color-primary`，文字 `--color-surface-base`
- 圆角 `--radius-sm`（8rpx），字体 `--font-size-md`（28rpx）Medium

### Outline / Danger Button
- 高度 ≥ 44px → 88rpx
- 背景 `--color-surface-base`，文字 + 描边 `--color-error`
- 圆角 `--radius-sm`（8rpx）

### Tab Bar（自定义底部导航）
- 容器 375 × 83，内含 351 × 62 白色胶囊
- 胶囊圆角 `--radius-pill`（26rpx），阴影 `--shadow-tab`
- 激活 Tab：`--color-primary` 背景 + `--color-surface-base` 文字
- 非激活 Tab：透明背景 + `--color-text-placeholder` 文字

### Photo Card
- 167 × N（160–260 之间多档，瀑布流布局）
- 圆角 `--radius-sm`（8rpx）
- 左下角可叠加角标

### Note Card
- 343 × 96，圆角 `--radius-sm`（8rpx）
- 左侧 60×60 缩略图 + 右侧备注正文（最多两行省略号）+ 时间戳

### Storage Card
- 343 × 101，圆角 `--radius-sm`（8rpx）
- 进度条 H=4，`--color-primary` 填充，`--color-surface-tertiary` 底色
- 85% 以上时百分比文字变 `--color-warning`

### FAB（悬浮操作按钮）
- 56 × 56 圆形，`--color-primary` 背景
- 距离底部 32，距离右侧 16
- Plus Icon 24×24 居中

### Modal Sheet（底部抽屉）
- 覆盖屏幕 60%–70%，顶角 `--radius-lg`（16rpx）
- 包含 Top Bar（取消 / 标题 / 保存）+ 内容区

### Empty State
- 居中布局：插画（240×160）+ 主标题 `h3` + 副文案 `body` + Primary Button CTA

### Skeleton / Loading
- 灰色 `--color-surface-secondary` 占位块
- Spinner：32×32 圆环，外圈 `--color-surface-secondary`，1/4 弧 `--color-primary`

## 页面布局骨架

每个移动页面纵向结构（从上到下）：

```
┌────────────────────────────┐
│ Status Bar (62)            │ ← 系统状态栏
├────────────────────────────┤
│ Navbar (44)                │ ← 标题 + 操作按钮
├────────────────────────────┤
│ Filter Row / Search (44–56)│ ← 可选，标签筛选
├────────────────────────────┤
│                            │
│ Content（主内容区）         │ ← 列表/网格/表单
│                            │
├────────────────────────────┤
│ Tab Bar (83) / CTA (44+)   │ ← 主导航或底部按钮
└────────────────────────────┘
```

## 全局规则

1. **主色克制**：单页主色面积不超过 30%
2. **圆角分层**：卡片 8 / Tag 14 / Tab 胶囊 26 / FAB 28+，同容器内不混用差距 > 12 的圆角
3. **文字克制**：正文标题统一 `text-primary`，次级 `text-secondary`，禁用纯黑 `#000`
4. **阴影克制**：仅浮层使用 shadow，卡片靠描边区分
5. **状态完整**：每个数据列表需要默认 / 加载骨架 / 空态三种状态
6. **数字字体**：时间戳、容量、百分比统一 Inter；中文统一 Noto Sans SC
7. **Modal 高度**：底部抽屉覆盖 60%–70%，顶角 `r-lg`
8. **危险操作**：仅用 `danger-500` 描边 + 文字，不使用实色背景

## 工作流程

### 开发新页面前

1. 读取 `references/design-spec.md` 确认该页面对应的设计规格
2. 读取 `miniprogram/theme/tokens.wxss` 确认可用的 CSS 变量
3. 确认页面中需要使用的组件（参考现有 `miniprogram/components/` 目录）
4. 优先复用已有组件，避免重复造轮子

### 样式编写规则

1. **所有颜色**必须使用 CSS 变量（`var(--color-xxx)`），禁止硬编码 hex 值
2. **所有圆角**使用 CSS 变量（`var(--radius-xxx)`）
3. **所有间距**使用 CSS 变量（`var(--space-xxx)`）
4. **所有字号**使用 CSS 变量（`var(--font-size-xxx)`）
5. **所有阴影**使用 CSS 变量（`var(--shadow-xxx)`）
6. 尺寸单位统一使用 `rpx`（微信小程序响应式像素）
7. 新组件应放在 `miniprogram/components/` 目录下
8. 每个组件包含 4 个文件：`.js` / `.json` / `.wxml` / `.wxss`

### 设计还原检查清单

完成页面开发后，检查以下项目：
- [ ] 所有颜色值是否来自 CSS 变量（无硬编码 hex）
- [ ] 圆角是否使用正确的 Token（卡片 8、Tag 14、胶囊 26）
- [ ] 字体是否正确（中文 Noto Sans SC，数字 Inter）
- [ ] 间距是否使用 4rpx 基数系统
- [ ] 主色面积是否控制在 30% 以内
- [ ] 卡片是否用描边而非阴影区分
- [ ] 是否实现了三种状态（默认/骨架/空态）
- [ ] 危险按钮是否仅用描边 + 文字
- [ ] Modal 顶角是否为 `r-lg`(16rpx)
- [ ] 文字层级是否正确（text-primary / text-secondary / text-placeholder）

## 参考资源

- 完整设计规范：`references/design-spec.md`
- CSS 变量定义：`miniprogram/theme/tokens.wxss`
- 现有组件目录：`miniprogram/components/`
- 现有页面目录：`miniprogram/pages/`
