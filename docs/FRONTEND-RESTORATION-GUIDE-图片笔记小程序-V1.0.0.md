# 图片笔记小程序 — 前端还原实现技术文档

> 版本：V1.0.0  
> 日期：2026-08-03  
> 适用端：微信小程序  
> 技术栈：微信原生 + TDesign Miniprogram v1.15.3  
> 基准设计稿：`design/pages/`（10 个页面）+ `design/skeleton/`（2 个骨架屏）+ `design/empty/`（2 个空态）  
> 设计规范源：`design/design_guide.md`

---

## 目录

1. [设计系统映射](#1-设计系统映射)
2. [全局组件规范](#2-全局组件规范)
3. [页面还原指南](#3-页面还原指南)
4. [骨架屏 & 空态专项](#4-骨架屏--空态专项)
5. [实施优先级与工时估算](#5-实施优先级与工时估算)

---

## 1. 设计系统映射

### 1.1 颜色 Token 对照表

`design/design_guide.md` §2 定义了完整颜色体系。与现有 `miniprogram/theme/tokens.wxss` 存在以下差异，需要对齐：

#### Brand · 品牌主色

| 设计 Token | 设计 Hex | 现有 Token | 现有 Hex | 状态 | 建议操作 |
|---|---|---|---|---|---|
| `primary-500` | `#0052D9` | `--color-primary` | `#0052D9` | ✅ 一致 | 无需变更 |
| `primary-50` | `#E7F0FF` | `--color-primary-light` | `#E0EBFF` | ⚠️ 偏差 | 改为 `#E7F0FF` |
| — | — | `--color-primary-dark` | `#003CAB` | ✅ 无冲突 | 保留 |

#### Status · 状态色

| 设计 Token | 设计 Hex | 现有 Token | 现有 Hex | 状态 | 建议操作 |
|---|---|---|---|---|---|
| `success-500` | `#00A870` | `--color-success` | `#00A870` | ✅ 一致 | 无需变更 |
| `warning-500` | `#ED7B2F` | `--color-warning` | `#ED7B2F` | ✅ 一致 | 无需变更 |
| `danger-500` | `#D54941` | `--color-error` | `#E34D59` | ❌ 不一致 | 改为 `#D54941` |

#### Surface · 表面/背景

| 设计 Token | 设计 Hex | 现有 Token | 现有 Hex | 状态 | 建议操作 |
|---|---|---|---|---|---|
| `surface-base` | `#FFFFFF` | `--color-bg-white` | `#FFFFFF` | ✅ 一致 | 保持命名或改为 `--color-surface-base` |
| `surface-secondary` | `#F3F3F3` | `--color-bg` | `#F3F3F3` | ✅ 一致 | 保持命名或改为 `--color-surface-secondary` |
| `surface-tertiary` | `#F2F3F5` | — | — | ❌ 缺失 | 新增 `--color-surface-tertiary: #F2F3F5` |

#### Neutral · 中性文本/描边

| 设计 Token | 设计 Hex | 现有 Token | 现有 Hex | 状态 | 建议操作 |
|---|---|---|---|---|---|
| `text-primary` | `#181818` | `--color-text-primary` | `#1D1D1D` | ⚠️ 偏差 | 改为 `#181818` |
| `text-secondary` | `#5E5E5E` | `--color-text-secondary` | `#717171` | ❌ 不一致 | 改为 `#5E5E5E` |
| `text-tertiary` | `#A6A6A6` | `--color-text-placeholder` | `#BBBBBB` | ❌ 不一致 | 改为 `#A6A6A6` |
| `border-default` | `#E8E8E8` | `--color-border` | `#E7E7E7` | ⚠️ 偏差 | 改为 `#E8E8E8` |
| `overlay-ink` | `#101114` | — | — | ❌ 缺失 | 新增 `--color-overlay-ink: #101114` |

#### 缺失的 Token 补充

| 类别 | Token | 值 | 说明 |
|---|---|---|---|
| Tag 专用 | `--color-tag-bg` | `#F3F3F3` | 已有但值不同，设计稿为 `surface-secondary` |
| Tag 专用 | `--color-tag-selected-bg` | `#E7F0FF` | 随 `primary-50` 一起更新 |
| 禁用态 | `--color-disabled-bg` | `#EEEEEE` | 保留现有值 |

#### 推荐的 tokens.wxss 更新内容

```css
page {
  /* Brand */
  --color-primary: #0052D9;
  --color-primary-light: #E7F0FF;          /* 更新 */
  --color-primary-dark: #003CAB;

  /* Status */
  --color-success: #00A870;
  --color-warning: #ED7B2F;
  --color-error: #D54941;                  /* 更新 */
  --color-info: #0052D9;

  /* Surface */
  --color-surface-base: #FFFFFF;           /* 新增 */
  --color-surface-secondary: #F3F3F3;      /* 新增 */
  --color-surface-tertiary: #F2F3F5;       /* 新增 */
  --color-bg: #F3F3F3;                     /* 保留兼容 */
  --color-bg-white: #FFFFFF;               /* 保留兼容 */

  /* Neutral */
  --color-text-primary: #181818;           /* 更新 */
  --color-text-secondary: #5E5E5E;         /* 更新 */
  --color-text-placeholder: #A6A6A6;       /* 更新 */
  --color-border: #E8E8E8;                /* 更新 */
  --color-overlay-ink: #101114;            /* 新增 */

  /* Tag */
  --color-tag-bg: #F3F3F3;
  --color-tag-selected-bg: #E7F0FF;       /* 更新 */
  --color-disabled-bg: #EEEEEE;

  /* Radius — 扩展 */
  --radius-xs: 4rpx;                       /* 新增 */
  --radius-sm: 8rpx;                       /* 新增 (当前 --radius-md 在 rpx 下约=12rpx, 需调整) */
  --radius-md: 12rpx;
  --radius-tag: 14rpx;                     /* 新增 */
  --radius-lg: 16rpx;
  --radius-pill: 26rpx;                    /* 新增 */
  --radius-circle: 50%;                    /* 新增 */

  /* Spacing */
  --space-xs: 4rpx;                        /* 新增 */
  --space-sm: 8rpx;                        /* 新增 */
  --space-md: 12rpx;                       /* 新增 */
  --space-lg: 16rpx;                       /* 新增 */
  --space-xl: 24rpx;                       /* 新增 */

  /* Font */
  --font-size-xs: 22rpx;
  --font-size-sm: 24rpx;
  --font-size-md: 28rpx;
  --font-size-lg: 32rpx;
  --font-size-xl: 36rpx;

  /* Shadow */
  --shadow-tab: 0 4rpx 16rpx rgba(0, 0, 0, 0.08);     /* 新增 */
  --shadow-modal: 0 -4rpx 12rpx rgba(0, 0, 0, 0.15);   /* 新增 */
  --shadow-light: 0 2rpx 8rpx rgba(0, 0, 0, 0.10);     /* 新增 */
}
```

### 1.2 字体排版映射

设计稿基于 375pt 画板定义字体。微信小程序使用 rpx（750 基准），换算关系：**1pt = 2rpx**。

| 设计 Token | 设计字号(pt) | rpx 值 | 字重 | CSS font-weight | 用途 |
|---|---|---|---|---|---|
| `h1` | 20 | 40rpx | Bold | 700 | 启动页 App 名 |
| `h2` | 18 | 36rpx | Bold | 700 | Navbar / 详情页标题 |
| `h3` | 16 | 32rpx | Bold | 700 | 区块标题 |
| `body-lg` | 15 | 30rpx | Regular | 400 | 备注正文、 Modal 正文 |
| `body` | 14 | 28rpx | Regular | 400 | 卡片正文、说明文字 |
| `body-sm` | 13 | 26rpx | Regular | 400 | Tag 文案、列表次要信息 |
| `caption` | 12 | 24rpx | Regular | 400 | 时间戳、警告信息 |
| `label-md` | 14 | 28rpx | Medium | 500 | 主按钮、Tab 文案 |
| `label-sm` | 13 | 26rpx | Medium | 500 | Tag 选中态文案、Counter |
| `number-md` | 14 | 28rpx | Medium | 500 | 存储容量数字（Inter） |
| `number-lg` | 18 | 36rpx | Semi Bold | 600 | 容量百分比（Inter） |

**字体家族策略：**

- 设计稿指定 `Noto Sans SC` + `Inter`，但小程序内无法加载 Web Font
- 现有代码使用系统字体栈：`-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`
- **建议**：保持现有系统字体栈，中文字体 `<text>` 和数字字体 `<text class="number">` 分开设置 CSS 类
- 数字/时间戳使用 `.number` 类，设置 `font-family: -apple-system, "Helvetica Neue", sans-serif`（iOS 下 Inter 近似效果）

**行高规范：**

- 正文密度 1.4–1.5：`line-height: 1.4`（正文）/ `1.5`（备注）
- 标题默认行高跟随字号
- 现有代码大多未设置行高，需要在全局 `app.wxss` 或各组件中补充

### 1.3 圆角规格映射

| 设计 Token | 设计值(px) | rpx 值 | 用途 |
|---|---|---|---|
| `r-xs` | 4 | 8rpx | Checkbox 圆角 |
| `r-sm` | 8 | 16rpx | 卡片（Photo Card、Note Card、Storage Card）、按钮 |
| `r-tag` | 14 | 28rpx | Tag/Chip 胶囊 |
| `r-lg` | 16 | 32rpx | Sort Button、Modal 顶角 |
| `r-pill` | 26 | 52rpx | Tab Bar 胶囊 |
| `r-circle` | 28+ | 50% | FAB（圆形 56px → 112rpx） |

**当前代码差距：**
- 现有 `--radius-sm: 6rpx` 对应设计没有的 3px 圆角，需评估是否需新增
- 现有 `--radius-md: 12rpx` 现为卡片圆角，对应设计 `r-sm: 8px → 16rpx`。**不要直接改**，因为大量现有代码依赖 12rpx。应**新增** `--radius-card: 16rpx` 用于卡片，保留 `--radius-md: 12rpx` 用于内部元素

### 1.4 间距规格映射

以 4pt 为基数，换算 rpx：**1pt = 2rpx**

| 设计 Token | 设计值(px) | rpx 值 | 典型用法 |
|---|---|---|---|
| `sp-xs` | 4 | 8rpx | 文字与 Icon 间距、Tag 间隙 |
| `sp-sm` | 8 | 16rpx | 卡片内垂直 padding 一半 |
| `sp-md` | 12 | 24rpx | 列表项垂直 padding、Photo Grid 间距 |
| `sp-lg` | 16 | 32rpx | 卡片水平 padding、Modal 内容边距 |
| `sp-xl` | 24 | 48rpx | 区块上下分隔 |

### 1.5 阴影规范映射

设计稿阴影采用实色黑遮罩模拟柔光。前端实现需转换为标准 box-shadow：

| 设计 Token | 设计配置 | 前端实现 | 用途 |
|---|---|---|---|
| `shadow-tab` | `rgba(0,0,0,0.08)` 实色 | `0 4rpx 16rpx rgba(0,0,0,0.08)` | 底部 Tab Bar |
| `shadow-modal` | `rgba(0,0,0,0.15)` 实色 | `0 -8rpx 24rpx rgba(0,0,0,0.12)` | 模态层 |
| `shadow-light` | `rgba(0,0,0,0.10)` 实色 | `0 2rpx 8rpx rgba(0,0,0,0.10)` | 卡片轻浮 |

> 设计稿规则 §4：「仅浮层（Tab Bar / Modal）使用 shadow；卡片不使用阴影，靠 border-default 描边区分。」

---

## 2. 全局组件规范

### 2.1 Status Bar（状态栏）

**设计规格：** 375 × 62pt，`surface-base` 底，左时间 + 右信号/WiFi/电池

**现状：** 微信小程序自带状态栏，通过 `wx.getSystemInfoSync().statusBarHeight` 获取高度即可，无需自行绘制。各页面通过 `_calcNavHeight()` 方法计算安全区后留白。

**还原方案：** 无需实现自定义 Status Bar，保持现有方式。

### 2.2 Navbar（导航栏）

**设计规格：**
- 高度 44pt → 88rpx（普通页）/ 52pt → 104rpx（Modal 含关闭按钮）
- 左侧：返回箭头（24×24）/ "取消"文字
- 右侧："更多"/"保存"/齿轮 Icon
- 中间：标题 `h2`(18pt Bold)，居中
- 背景 `surface-base`(白色)

**现状：**
- `photos` 页使用自定义导航栏（`navigationStyle: "custom"`）：fixed 定位，`statusBarHeight + navBarHeight` 计算
- `notes`、`preview`、`settings`、`deletion-status`、`tag-manager` 使用 `t-navbar` 组件
- 各页独立实现了 `_calcNavHeight()`，代码重复（`photos.js`, `notes.js`, `preview.js`, `settings.js`, `tag-manager.js`）

**还原方案：**
1. _抽取导航栏计算为工具函数_：在 `utils/` 下新增 `navbar.js`，提供 `getNavBarHeight()` 和 `getNavLayout()` 函数
2. _规范 title 字号_：t-navbar 默认标题字号需匹配设计 `h2`（36rpx Bold）
3. _Modal 内 Top Bar_：`note-editor` 和 `tag-picker` 已有自定义 header，样式需对齐设计稿：
   - 高度 ≥ 88rpx
   - 取消按钮居左，"保存"按钮居右
   - 标题 `h3`(32rpx Bold) 居中

> 现有文件：`miniprogram/pages/photos/photos.wxml:3-16`, `miniprogram/pages/photos/photos.wxss:2-20`  
> 重复代码位置：`photos.js`, `notes.js`, `preview.js`, `settings.js`, `tag-manager.js` 中的 `_calcNavHeight()`

### 2.3 Tab Bar（底部主导航）

**设计规格：**
- 容器 375 × 83pt (166rpx)，内含 351 × 62pt 白色胶囊（`r-pill` 26pt, `shadow-tab`）
- 单 Tab 169.5 × 54pt，`r-pill`(26)，内含 Icon(18) + Label
- 激活：`primary-500` 底 + 白色文字
- 非激活：透明底 + `text-tertiary` 文字

**现状：** 使用微信原生 `tabBar` 配置（`app.json`），样式受限。

**还原方案：**
- _短期（当前可行）_：原生 tabBar 仅支持文字 + iconPath/selectedIconPath，已配置 `selectedColor: #0052D9`，基本满足需求
- _长期（视觉对齐）_：需通过 `custom-tab-bar` 方式自定义。参照设计稿：
  1. 在 `miniprogram/custom-tab-bar/` 下创建组件
  2. 使用白色 pill 容器 + `box-shadow: 0 4rpx 16rpx rgba(0,0,0,0.08)`
  3. 内部两个 tab 使用 `r-pill`(52rpx) 圆角胶囊
  4. 激活态 `primary-500` 底色 + 白色文字 + icon

> 现有文件：`miniprogram/app.json:11-25`

### 2.4 原子组件规范

#### Tag / Chip

| 状态 | 背景 | 文字 | 描边 | 字重 |
|---|---|---|---|---|
| 默认 | `surface-base` | `text-primary` | `border-default` 1px | Regular |
| 选中 | `primary-50` | `primary-500` | 无 | Medium |

- 高度：28px → 56rpx
- 圆角：`r-tag` → 28rpx
- Padding：`sp-xs`(4pt) → 8rpx 水平

**现状：** `tag-filter-bar` 使用 `t-tag` 组件，已有自定义 CSS shimmer 骨架。但 tag 样式可能不完全匹配设计稿。

**还原方案：**
- 通过 CSS 变量覆盖 `t-tag` 默认样式
- 选中态：`.tag-selected { background: var(--color-tag-selected-bg); color: var(--color-primary); font-weight: 500; }`

#### Primary / Outline Button

| 类型 | 高度 | 圆角 | 背景 | 文字 | 描边 |
|---|---|---|---|---|---|
| Primary | 44pt(88rpx)+ | `r-sm`(16rpx) | `primary-500` | `surface-base` Medium 14pt | 无 |
| Outline | 44pt(88rpx)+ | `r-sm`(16rpx) | `surface-base` | `danger-500` Medium 14pt | `danger-500` 1px |

**现状：** 使用 `t-button`，基本满足。需要确保高度和圆角配置一致。

#### Checkbox

- 16×16px → 32×32rpx，圆角 `r-xs`(8rpx)
- 选中：`primary-500` 底 + 白色对勾

**现状：** `tag-picker` 中使用了自定义 check mark（✓），无 TDesign checkbox。

#### Status Indicator

- 6×6px → 12×12rpx 圆点
- 绿（success-500）标识成功、红（danger-500）标识失败

**现状：** `upload-panel` 中 `task-status` 使用文字形式（✓/已取消），未使用圆点。

### 2.5 图标系统

设计稿所有图标均为 1.5–2px stroke 线性图标，统一 16/18/24pt 三档。

| 图标 | 设计尺寸(pt) | rpx | 使用场景 |
|---|---|---|---|
| Note Icon | 18×18 | 36rpx | Tab Bar、备注列表 |
| Image Icon | 18×18 | 36rpx | Tab Bar、上传反馈 |
| Photo Icon | 16×16 | 32rpx | Photo 详情标记 |
| Sort Icon | 12×12 | 24rpx | 排序按钮 |
| Edit Icon | 12×12 | 24rpx | Tag 编辑 |
| Plus Icon | 24×24 | 48rpx | FAB、空态 CTA |
| Check Icon | 12×12 | 24rpx | Checkbox 内 |
| Close/X | 16×16 | 32rpx | 上传失败标记 |
| Back Arrow | 24×24 | 48rpx | Navbar 返回 |
| Settings | 24×24 | 48rpx | Navbar 右上角 |

**现状：** 使用 TDesign `t-icon` 组件，部分自定义（FAB +、tag-filter-bar 文字图标）。

**还原方案：**

- TDesign icon 名称映射表：

| 设计图标 | TDesign icon name | 备注 |
|---|---|---|
| Note/备注 | `edit-1` | 已在 `photo-card` 中使用 |
| Image/图片 | `image` | 已在 photo-card、photos empty 中使用 |
| Settings | `setting` | 已在 photos navbar 中使用 |
| Back Arrow | `chevron-left` | TDesign navbar 自带 |
| Plus | `add` | 或自定义文字 + |
| Close/X | `close` | TDesign 内置 |
| Check | `check` | TDesign 内置 |

> 现有文件：`miniprogram/pages/photos/photos.wxml:13`, `miniprogram/components/photo-card/photo-card.wxml:16`

---

## 3. 页面还原指南

每个页面按：**设计稿分析 → 当前实现状态 → 差距 → 还原要点** 展开。

### 3.1 PG-001 启动页

**设计稿：** `design/pages/PG-001 启动页.png`  
**设计定位：** 全屏居中，Logo + App 名「图片笔记」+ Loading Spinner + 版本号 v1.0.0

**设计布局：**
```
┌────────────────────┐
│                    │
│       [Logo]       │  ← 图标/插画
│     图片笔记        │  ← h1(20pt Bold)
│    [Loading动画]   │  ← 32×32 圆环 spinner
│      v1.0.0        │  ← caption(12pt)
│                    │
└────────────────────┘
```

**现状：** `miniprogram/pages/index/index.wxml`

- 仅 `t-loading`（正在连接…）和 `t-result`（错误+重试）
- 无 Logo、无 App 名「图片笔记」、无版本号
- 无设计稿中的 Spinner 样式（当前为 TDesign 默认 spinner）

**差距分析：**
- ❌ 缺少 Logo 展示
- ❌ 缺少 App 名称「图片笔记」
- ❌ 缺少版本号
- ❌ Loading spinner 样式不完全匹配设计稿（设计：32×32 圆环，外圈 `surface-secondary`，1/4 圈 `primary-500`）
- ⚠️ 启动页实际上是一个短暂的过渡页（调用 login → redirect），视觉设计需求低

**还原方案：**
1. 保留 `t-loading` 作为后台连接状态
2. 新增启动视觉层：居中 Logo 插画（240×160）、标题「图片笔记」(h1)、版本号(caption)
3. Loading Spinner 自定义：使用 CSS animation 实现 32×32 圆环旋转，或使用 `t-loading` 的 `theme="circular"` 属性
4. 连接成功后淡出 → 跳转 photos tab

> 现有文件：`miniprogram/pages/index/index.wxml`, `miniprogram/pages/index/index.js`

### 3.2 PG-002 图片列表

**设计稿：** `design/pages/PG-002 图片列表.png`  
**骨架屏：** `design/skeleton/PG-002 图片列表 — 骨架屏加载态.png`  
**空态：** `design/empty/PG-002 图片列表 — 空态.png`

**设计布局：**
```
┌────────────────────┐
│    Status Bar      │
│  [设置]  图片       │  ← Navbar
│ [全部][标签1]...[+] │  ← Tag Filter Bar
├────────────────────┤
│  ┌──────┐ ┌──────┐ │
│  │      │ │      │ │  ← 2 列瀑布流
│  │      │ ├──────┤ │     列宽 167pt
│  ├──────┤ │      │ │     间距 8pt
│  │      │ │      │ │
│  └──────┘ └──────┘ │
├────────────────────┤
│         [+]        │  ← FAB (56×56)
│   [Tab Bar 胶囊]   │
└────────────────────┘
```

**现状：** `miniprogram/pages/photos/photos.wxml`

核心结构已实现：自定义 Navbar + tag-filter-bar + 2列瀑布流 + FAB + upload-panel + 来源选择 Popup。

**差距分析（逐模块）：**

| 模块 | 状态 | 差距 |
|---|---|---|
| Navbar | ✅ 已实现 | 标题居中（现有 `.nav-inner` 已有 `justify-content: center`），设置齿轮位置通过 `settingsRight` 计算 |
| Tag Filter | ✅ 已实现 | `tag-filter-bar` 组件已按设计实现 |
| 瀑布流 | ✅ 已实现 | 2 列 flex，`gap: 16rpx`，`photo-card` 组件 |
| FAB | ⚠️ 部分匹配 | 位置正确（右下），颜色正确。但设计为 56×56(112rpx)，现有 96rpx；阴影为 `rgba(0,82,217,.4)` 而非设计 `shadow-tab` |
| 空态 | ⚠️ 部分匹配 | 有 3 种 filter scope 对应的空态文案 + CTA，但缺少设计稿中的插图(240×160) |
| 骨架屏 | ❌ 不匹配 | 现有使用 `page-state` → `t-skeleton` 列表骨架，设计稿是 2 列瀑布流卡片骨架 |
| Tab Bar | ⚠️ 基本满足 | 原生 tabBar，未实现设计稿中的白色胶囊浮层 |
| Source Popup | ⚠️ 样式偏差 | 现有 `.source-popup` 使用 `#f5f5f5` 背景和 `32rpx` 圆角，设计稿应使用 `surface-base` + `r-lg`(16pt→32rpx) |

**还原要点：**
1. 骨架屏 → 见 [§4.1](#41-图片列表瀑布流骨架屏)
2. 空态 → 见 [§4.3](#43-统一空态组件)
3. FAB 尺寸调为 112rpx，阴影改为 `var(--shadow-tab)`
4. Source Popup 样式对齐设计稿

> 现有文件：`miniprogram/pages/photos/photos.wxml`, `photos.wxss`, `photos.js`  
> 依赖组件：`photo-card`, `tag-filter-bar`, `page-state`, `upload-panel`

### 3.3 PG-003 上传面板

**设计稿：** `design/pages/PG-003 上传面板.png`

**设计布局：**
```
┌────────────────────┐
│  已选 6/20  继续选择 │  ← Header
├────────────────────┤
│ ┌──┐ ┌──┐ ┌──┐ ┌──┐│
│ │✓ │ │  │ │  │ │✕ ││  ← 4 列网格（多选态）
│ └──┘ └──┘ └──┘ └──┘│    绿勾=成功 红X=失败
│ ┌──┐               │
│ │  │               │
│ └──┘               │
├────────────────────┤
│ ⚠ 1张图片上传失败   │  ← Warning Banner
│  文件过大(>20MB)    │
├────────────────────┤
│ [为本批图片添加标签] │  ← Primary Button CTA
└────────────────────┘
```

**现状：** `miniprogram/components/upload-panel/upload-panel.wxml`

已实现完整上传流程：选图 → 压缩 → 上传 → 确认 → 完成。包含重试逻辑、离开确认、批量标签。

**差距分析：**
- ⚠️ Header 显示 `{{uploadedCount}}/{{totalCount}} 张`，但缺少"继续选择"功能按钮
- ⚠️ 现有为列表式（scroll-view + task-item），非设计稿中的 4 列网格布局
- ⚠️ 缺少 Warning Banner（失败原因汇总区域）
- ⚠️ "为本批图片添加标签"按钮在完成后才出现，设计稿中应持续可见
- ✅ 状态机制完善（pending/compressing/uploading/confirming/success/failed/cancelled）

**还原方案：**
1. 将上传项列表从竖向列表改为 4 列网格（每格 `(375-32-3*8)/4 ≈ 80pt → 160rpx`）
2. 每格叠加状态标记：成功(绿勾 check icon)、失败(红 X close icon)
3. 新增底部 Warning Banner：汇总失败原因，橙色文字 `warning-500`
4. "为本批图片添加标签"按钮改为始终可见（无图片时 disabled）

> 现有文件：`miniprogram/components/upload-panel/upload-panel.wxml`

### 3.4 PG-004 图片预览详情

**设计稿：** `design/pages/PG-004 图片预览详情.png`

**设计布局：**
```
┌────────────────────┐
│  [<]  详情  [...]  │  ← Navbar
├────────────────────┤
│                    │
│   [大图 满宽]       │  ← 支持滑动切换
│                    │
├────────────────────┤
│ 拍摄时间: ...       │  ← 图片信息
│ 标签（3/5）         │  ← Tag Section
│ [Tag1] [Tag2] [编辑]│
├────────────────────┤
│ 备注（5）    [添加]  │  ← 备注列表
│ ┌──────────────┐   │
│ │ 备注内容...    │   │
│ │ 2024-01-01     │   │
│ └──────────────┘   │
├────────────────────┤
│ [删除图片及所有备注] │  ← Danger Outline Button
└────────────────────┘
```

**现状：** `miniprogram/pages/preview/preview.wxml`

已实现完整详情页：大图 + 滑动切换 + 位置指示器、标签区、备注列表、图片信息行、删除按钮。使用 `t-navbar`、`note-editor`、`tag-picker`、`t-action-sheet`、`t-dialog`。

**差距分析：**
- ⚠️ 页面背景应为深色沉浸式（`#101114` overlay-ink），当前可能未设置
- ⚠️ 大图区需占满宽度（`widthFix` 模式可能留边距）
- ✅ 标签区 `photo-tag-section` 已实现
- ✅ 备注列表已实现（含空态/已编辑标识）
- ✅ 图片信息行（拍摄时间/来源/尺寸/格式）
- ✅ Danger Button 「删除图片及所有备注」
- ⚠️ 备注列表排序：设计稿暗示按时间倒序（最新在前），需确认现有实现

**还原方案：**
1. 页面背景色改为 `#101114`（沉浸式深色），内容区用半透明白底
2. 大图 `image` 使用 `width: 100%` + `mode="widthFix"`，去掉左右 padding
3. 备注列表确认排序逻辑

> 现有文件：`miniprogram/pages/preview/preview.wxml`

### 3.5 PG-005 备注编辑层

**设计稿：** `design/pages/PG-005 备注编辑层.png`

**设计布局：**
```
┌────────────────────┐
│ [Modal 遮罩 65%]    │
├────────────────────┤
│  取消  添加备注  保存 │  ← Top Bar (H=52)
│                    │
│  ┌──────────────┐  │
│  │ 输入备注...    │  │  ← textarea
│  │              │  │
│  └──────────────┘  │
│  还可输入 850 字     │  ← 字符计数 caption
└────────────────────┘
```

**现状：** `miniprogram/components/note-editor/note-editor.wxml`

已实现底部弹层：mask + editor-header（取消/标题/保存）+ textarea + 错误提示。

**差距分析：**
- ⚠️ 缺少字符计数显示（"还可输入 850 字"），应使用 `maxlength="{{1000}}"` 减去当前长度
- ⚠️ 标题区分「添加备注」和「编辑备注」（已有实现，正确）
- ⚠️ Top Bar 高度应≥104rpx（设计 52pt Modal），现有未明确指定
- ⚠️ Modal 圆角顶部应为 `r-lg`(16pt→32rpx)，现有 mask 无圆角约束
- ✅ 保存中禁用态（"保存中…"）已实现
- ✅ 乐观锁冲突处理（`bind:conflict` 事件）

**还原方案：**
1. 新增字符计数：在 textarea 下方显示「还可输入 {{1000 - content.length}} 字」
2. Editor 面板顶部添加 `border-radius: 32rpx 32rpx 0 0`
3. Header 高度规范 ≥ 104rpx，内部垂直居中

> 现有文件：`miniprogram/components/note-editor/note-editor.wxml`, `note-editor.js`

### 3.6 PG-006 备注列表

**设计稿：** `design/pages/PG-006 备注列表.png`  
**骨架屏：** `design/skeleton/PG-006 备注列表 — 骨架屏加载态.png`  
**空态：** `design/empty/PG-006 备注列表 — 空态.png`

**设计布局：**
```
┌────────────────────┐
│    Status Bar      │
│      备注    [排序]  │  ← Navbar + Sort Button
├────────────────────┤
│ ┌────────────────┐ │
│ │ [缩略图] 备注内容 │ │  ← Note Card (343×96)
│ │   60×60  最多两行 │ │     左侧 60×60 缩略图
│ │          时间戳   │ │     右侧 备注+时间
│ └────────────────┘ │
│ ┌────────────────┐ │
│ │ [缩略图] 备注内容 │ │
│ │          时间戳   │ │
│ └────────────────┘ │
├────────────────────┤
│   [Tab Bar 胶囊]   │
└────────────────────┘
```

**现状：** `miniprogram/pages/notes/notes.wxml`

使用 `t-navbar` + `page-state` + `t-cell` 列表。

**差距分析：**

| 模块 | 状态 | 差距 |
|---|---|---|
| Navbar | ✅ 已实现 | TDesign navbar + "备注"标题 |
| Sort Button | ❌ 缺失 | 设计稿右上角有排序按钮(62×32, `r-lg`)，用于切换时间正序/倒序 |
| Note Card | ⚠️ 样式偏差 | 现有用 `t-cell`，设计稿为独立 Note Card(343×96pt) |
| 骨架屏 | ❌ 不匹配 | 现有 `page-state` 列表骨架，设计稿为 3 条 Note Card 骨架 |
| 空态 | ⚠️ 基本满足 | 使用 `page-state` 空态，但缺少设计稿中的插画+CTA |
| Tab Bar | ⚠️ 基本满足 | 原生 tabBar |

**还原要点：**
1. _Sort Button_：Navbar 右侧新增排序按钮，62×32pt(124×64rpx)，`r-lg`(32rpx)，文字 `body-sm`
2. _Note Card_ 样式：独立样式替代或定制 `t-cell`
   - 尺寸 343×96pt → 686×192rpx（宽自适应 `100% - 32rpx padding`）
   - 左侧 60×60pt → 120×120rpx 缩略图
   - 右侧正文（最多两行省略）+ 时间戳 `caption`
3. 骨架屏 → 见 [§4.2](#42-备注列表骨架屏)
4. 空态 → 见 [§4.3](#43-统一空态组件)

> 现有文件：`miniprogram/pages/notes/notes.wxml`, `notes.wxss`, `notes.js`

### 3.7 PG-007 设置与隐私

**设计稿：** `design/pages/PG-007 设置与隐私.png`

**设计布局：**
```
┌────────────────────┐
│    Status Bar      │
│  [<]  设置          │  ← Navbar
├────────────────────┤
│ 存储空间            │  ← Section Header (surface-secondary 底)
│ ┌────────────────┐ │
│ │ 已用 200MB/500MB │ │  ← Storage Card (343×101)
│ │ [========>     ] │ │     进度条 H=4
│ │    40%          │ │
│ └────────────────┘ │
│                    │  ← surface-secondary 分隔
│ 数据               │
│ ┌────────────────┐ │
│ │ 标签管理      >  │ │  ← Settings Item (343×56)
│ └────────────────┘ │
│                    │
│ 账号               │
│ ┌────────────────┐ │
│ │ 注销账号   删除>  │ │  ← Settings Item (343×56)
│ └────────────────┘ │
└────────────────────┘
```

**现状：** `miniprogram/pages/settings/settings.wxml`

使用 `t-navbar` + `t-cell-group` + `t-progress` + `t-dialog`。

**差距分析：**
- ⚠️ Storage Card 不是一个整体卡片，而是 `t-cell` + 独立 `t-progress`
- ⚠️ 进度条下方缺少百分比大字（设计稿 `number-lg` 18pt Semi Bold）
- ⚠️ 分组背景应使用 `surface-secondary` (`#F3F3F3`)，现有通过 `t-cell-group` 默认样式
- ⚠️ 「注销账号」行 note 文字应为 `danger-500` 颜色，现有为默认
- ✅ 功能完整：空间使用、标签管理入口、注销流程

**还原方案：**
1. Storage Card 合并为一个整体卡片组件：Label + 数字(Inter) + 进度条(H=4) + 百分比大字
2. 进度条 `t-progress` 配置：`stroke-width="4"`，颜色 `primary-500`，轨道色 `surface-tertiary`
3. 百分比 85%+ 时颜色切换为 `warning-500`
4. 注销按钮 note 颜色改为 `var(--color-error)`（`#D54941`）

> 现有文件：`miniprogram/pages/settings/settings.wxml`, `settings.js`

### 3.8 PG-008 注销处理中

**设计稿：** `design/pages/PG-008 注销处理中.png`

**设计布局：**
```
┌────────────────────┐
│                    │
│   [Loading动画]    │  ← 32×32 圆环 spinner
│                    │
│   正在处理注销请求…  │  ← body-lg(15pt)
│                    │
│   联系客服          │  ← 链接 caption
│                    │
└────────────────────┘
```

**现状：** `miniprogram/pages/deletion-status/deletion-status.wxml`

三态：loading → processing（刷新按钮） → completed（退出按钮）。

**差距分析：**
- ⚠️ 缺少"联系客服"链接（跳转微信客服或反馈）
- ⚠️ Loading 页缺少副文案解释（如"您的数据正在清理，请稍后查看" → 已在 processing 态）
- ✅ 三态切换逻辑完整

**还原方案：**
1. 所有状态添加"联系客服"文字链接，位于底部
2. Loading 态添加副文案

> 现有文件：`miniprogram/pages/deletion-status/deletion-status.wxml`

### 3.9 PG-009 标签管理

**设计稿：** `design/pages/PG-009 标签管理.png`

**设计布局：**
```
┌────────────────────┐
│    Status Bar      │
│  [<]  标签管理      │  ← Navbar
├────────────────────┤
│ [+ 新建标签]        │  ← Primary Button（全宽）
├────────────────────┤
│ 生活（12张）  [✎][×]│  ← Tag List Item
│ 旅行（8张）   [✎][×]│     name + count + edit + delete
│ 美食（15张）  [✎][×]│
│ ...               │
└────────────────────┘
```

**现状：** `miniprogram/pages/tag-manager/tag-manager.wxml`

`t-navbar` + `t-button`（新建标签）+ `t-empty`（空态）+ `t-cell` 列表。

**差距分析：**
- ⚠️ Edit Icon 和 Delete Icon 使用文字（重命名/删除），设计稿为铅笔 Icon + 删除 Icon
- ⚠️ 「新建标签」按钮样式需匹配设计稿 Primary Button
- ✅ 标签计数显示（`{{item.photo_count}} 张图片`）
- ✅ 空态、重命名、删除功能已实现

**还原方案：**
1. 操作按钮改用图标：铅笔 `t-icon name="edit"` + 删除 `t-icon name="delete"`，红色
2. 「新建标签」按钮样式：高度≥88rpx，`primary-500` 底色

> 现有文件：`miniprogram/pages/tag-manager/tag-manager.wxml`

### 3.10 PG-010 标签选择层

**设计稿：** `design/pages/PG-010 标签选择层.png`

**设计布局：**
```
┌────────────────────┐
│ [Modal 遮罩]        │
├────────────────────┤  ← 顶部圆角 r-lg(16pt→32rpx)
│ 取消 选择标签 已选n/m│  ← Top Bar
├────────────────────┤
│ [+ 新建标签]        │  ← 新建入口（虚框）
├────────────────────┤
│ ☑ 生活   12         │  ← 多选 Tag 列表
│ ☐ 旅行   8          │     Checkbox + name + count
│ ☐ 美食   15         │
│ ...               │
└────────────────────┘
```

**现状：** `miniprogram/components/tag-picker/tag-picker.wxml`

已实现：mask + picker-header + search-bar + tag-list（含创建入口）。

**差距分析：**
- ⚠️ Header 标题在非批量模式下显示「选择标签（n/5）」，设计稿为「已选 n/m」
- ⚠️ 「新建标签」入口应为虚框按钮样式，现有为列表 inline 文字入口
- ⚠️ 多选列表每项缺少数量显示（设计稿有 count）
- ✅ 搜索+创建、5 个上限、批量模式已实现
- ✅ 选中态勾选标记（✓）已实现

**还原方案：**
1. Header 标题改为「已选 {{selectedIds.length}}/5」
2. 「新建标签」入口改为虚线边框按钮（`border: 1px dashed var(--color-border)`）
3. Tag 列表项添加 `photo_count` 显示

> 现有文件：`miniprogram/components/tag-picker/tag-picker.wxml`

---

## 4. 骨架屏 & 空态专项

设计全局规则 §5：「每个数据列表都需要 3 态 —— 默认 / 加载骨架 / 空态」

### 4.1 图片列表瀑布流骨架屏

**设计稿：** `design/skeleton/PG-002 图片列表 — 骨架屏加载态.png`

**设计要求：**
- 2 列瀑布流骨架卡片（`surface-secondary` `#F3F3F3` 底色）
- 每张骨架卡片：167×N（变高），`r-sm`(8px→16rpx) 圆角
- 建议展示 4–6 张骨架卡片（2 列 × 2–3 行）
- 顶部 Tag Filter Bar 也需骨架（tag-filter-bar 已有 shimmer pills 实现）
- FAB 在骨架态中仍显示

**现状：** `page-state` 组件使用 `t-skeleton row-col="{{[1,1,1,{width:'60%'}]}}"`，为 3行列表骨架，与设计稿 2 列瀑布流完全不同。

**还原方案：**
1. _方案 A（推荐）_：在 `page-state` 组件中新增 `skeleton-type` 属性，`type="waterfall"` 时渲染自定义瀑布流骨架
2. _方案 B_：在 `photos` 页面单独实现骨架，绕过 `page-state`

**推荐方案 A 实现细节：**

```html
<!-- page-state 新增 waterfall skeleton -->
<view wx:if="{{skeletonType === 'waterfall'}}" class="waterfall-skeleton">
  <view class="sk-column">
    <view class="sk-card" style="height: {{320}}rpx;"></view>
    <view class="sk-card" style="height: {{260}}rpx;"></view>
    <view class="sk-card" style="height: {{380}}rpx;"></view>
  </view>
  <view class="sk-column">
    <view class="sk-card" style="height: {{280}}rpx;"></view>
    <view class="sk-card" style="height: {{360}}rpx;"></view>
    <view class="sk-card" style="height: {{240}}rpx;"></view>
  </view>
</view>
```

```css
/* 瀑布流骨架 */
.waterfall-skeleton {
  display: flex;
  gap: 16rpx;
  padding: 16rpx;
}
.sk-column {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}
.sk-card {
  background: var(--color-surface-secondary); /* #F3F3F3 */
  border-radius: 16rpx; /* r-sm */
  /* shimmer 动画 */
  animation: skeleton-loading 1.5s ease-in-out infinite;
}
@keyframes skeleton-loading {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

> 现有文件：`miniprogram/components/page-state/page-state.wxml`  
> 设计文件：`design/skeleton/PG-002 图片列表 — 骨架屏加载态.png`

### 4.2 备注列表骨架屏

**设计稿：** `design/skeleton/PG-006 备注列表 — 骨架屏加载态.png`

**设计要求：**
- 3 条 Note Card 骨架（`surface-secondary` 底色）
- 每条：左侧 60×60 方形 + 右侧 2 行文字条 + 时间戳条

**现状：** `page-state` → `t-skeleton` 3 行列表，基本接近设计稿，但缺少左侧缩略图位置的方形骨架。

**还原方案：**

在 `page-state` 中新增 `skeletonType="note-list"` 模式：

```html
<view wx:elif="{{skeletonType === 'note-list'}}" class="note-list-skeleton">
  <block wx:for="{{[1,2,3]}}" wx:key="*this">
    <view class="sk-note-card">
      <view class="sk-thumb"></view>
      <view class="sk-body">
        <view class="sk-line" style="width: 80%;"></view>
        <view class="sk-line" style="width: 60%;"></view>
        <view class="sk-line short" style="width: 30%;"></view>
      </view>
    </view>
  </block>
</view>
```

```css
.sk-note-card {
  display: flex;
  gap: 24rpx;
  padding: 24rpx 32rpx;
  background: var(--color-surface-base);
  margin: 0 32rpx 16rpx;
  border-radius: 16rpx;
  border: 1px solid var(--color-border);
}
.sk-thumb {
  width: 120rpx; /* 60pt */
  height: 120rpx;
  background: var(--color-surface-secondary);
  border-radius: 12rpx;
  flex-shrink: 0;
}
.sk-line {
  height: 24rpx;
  background: var(--color-surface-secondary);
  border-radius: 4rpx;
  margin-bottom: 12rpx;
  animation: skeleton-loading 1.5s ease-in-out infinite;
}
.sk-line.short {
  width: 40% !important;
  height: 20rpx;
}
```

> 现有文件：`miniprogram/components/page-state/page-state.wxml`  
> 设计文件：`design/skeleton/PG-006 备注列表 — 骨架屏加载态.png`

### 4.3 统一空态组件

**设计稿：**
- `design/empty/PG-002 图片列表 — 空态.png`
- `design/empty/PG-006 备注列表 — 空态.png`

**设计要求：**
- 居中纵向排列：插画(240×160pt → 480×320rpx) + h3 标题 + body 副文案 + Primary Button CTA
- 图片空态：「还没有图片」 + 「上传第一张图片」按钮
- 备注空态：「还没有备注」 + 「去上传图片并添加备注」按钮

**现状：**
- `photos` 页：自定义 inline `.filter-empty`（`t-icon image` 112rpx + 动态文案 + `t-button`）
- `notes` 页：通过 `page-state` → `t-empty`（无 CTA 按钮）
- `tag-manager`：`t-empty`（无 CTA 按钮）
- `preview`：`page-state` → `t-empty`（"图片不存在或已删除"）

**差距分析：**
- ❌ 全部缺少设计稿中的插画（240×160）
- ❌ notes 空态缺少 CTA 按钮
- ❌ tag-manager/preview 空态缺少 CTA 按钮
- ⚠️ photos 空态有 CTA，但不是统一方式

**还原方案：**

在 `page-state` 组件中升级空态，支持插画 + CTA：

```html
<!-- 空态（支持自定义 CTA） -->
<view wx:elif="{{state === 'empty'}}" class="empty-state">
  <image wx:if="{{emptyImage}}" src="{{emptyImage}}" mode="aspectFit" class="empty-illustration" />
  <t-icon wx:else name="{{emptyIcon || 'image'}}" size="112rpx" color="#bbb" />
  <text class="empty-title">{{emptyTitle || emptyText || '暂无数据'}}</text>
  <text wx:if="{{emptyDescription}}" class="empty-desc">{{emptyDescription}}</text>
  <t-button
    wx:if="{{emptyAction}}"
    theme="primary"
    size="medium"
    bind:tap="handleEmptyAction"
  >{{emptyAction}}</t-button>
</view>
```

新增 props：`emptyTitle`, `emptyDescription`, `emptyImage`, `emptyIcon`, `emptyAction`

各页面使用示例：

| 页面 | emptyTitle | emptyDescription | emptyAction |
|---|---|---|---|
| photos (全部) | 还没有图片 | 上传第一张图片 | 上传第一张图片 |
| photos (未分类) | 所有图片都已添加标签 | 上传更多图片 | 添加图片 |
| photos (标签筛选) | 这个标签下还没有图片 | — | 查看全部图片 |
| notes | 还没有备注 | 为图片添加第一条备注 | 去上传图片并添加备注 |
| tag-manager | 暂无标签 | 新建标签来整理你的图片 | 新建标签 |

> 现有文件：`miniprogram/components/page-state/page-state.wxml`, `page-state.js`  
> 设计文件：`design/empty/PG-002 图片列表 — 空态.png`, `design/empty/PG-006 备注列表 — 空态.png`

### 4.4 page-state 组件升级方案汇总

统一 `page-state` 组件需要升级的内容：

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `state` | String | — | `loading`/`initialLoading`/`empty`/`error`/`initialError` |
| `skeletonType` | String | `list` | `list`/`waterfall`/`note-list` |
| `emptyTitle` | String | `暂无数据` | 空态主标题（h3） |
| `emptyDescription` | String | — | 空态副文案（body） |
| `emptyImage` | String | — | 空态插画路径 |
| `emptyIcon` | String | `image` | 无插图时的 icon |
| `emptyAction` | String | — | 空态 CTA 按钮文字 |
| `showRetry` | Boolean | true | 错误态是否显示重试 |
| `errorTitle` | String | `加载失败` | 错误标题 |
| `errorText` | String | — | 错误描述 |
| `bind:retry` | Event | — | 重试事件 |
| `bind:emptyAction` | Event | — | 空态 CTA 点击事件 |

---

## 5. 实施优先级与工时估算

### 5.1 P0 — Design Token 对齐（预计 2h）

**影响范围：** 全局，所有页面和组件

| 任务 | 文件 | 工时 |
|---|---|---|
| 更新 `tokens.wxss` 颜色变量值 | `miniprogram/theme/tokens.wxss` | 0.5h |
| 新增 missing tokens（spacing, shadow, radius） | `miniprogram/theme/tokens.wxss` | 0.5h |
| 验证所有页面颜色显示正常 | 全页面走查 | 1h |

**关键风险：** 颜色更新可能影响现有页面视觉效果，需要逐页确认。

### 5.2 P1 — 骨架屏 & 空态组件重构（预计 6h）

| 任务 | 文件 | 工时 |
|---|---|---|
| 升级 `page-state` 组件（新增 props + waterfall/note-list skeleton + empty CTA） | `miniprogram/components/page-state/` | 3h |
| photos 页接入 waterfall skeleton + 新空态 | `miniprogram/pages/photos/` | 1h |
| notes 页接入 note-list skeleton + 新空态 | `miniprogram/pages/notes/` | 0.5h |
| tag-manager、preview 页接入新空态 | `miniprogram/pages/tag-manager/`, `preview/` | 0.5h |
| 全页测试 3 态切换 | 全页面走查 | 1h |

### 5.3 P2 — 各页面细节对齐（预计 12h）

| 页面 | 主要任务 | 工时 |
|---|---|---|
| PG-001 启动页 | Logo + App 名 + 版本号 + 自定义 spinner | 1.5h |
| PG-002 图片列表 | FAB 尺寸/阴影、Source Popup 样式 | 1h |
| PG-003 上传面板 | 4 列网格布局、Warning Banner 汇总、CTA 常驻 | 2h |
| PG-004 图片预览详情 | 沉浸式背景、大图满宽 | 1h |
| PG-005 备注编辑层 | 字符计数、圆角、header 高度 | 0.5h |
| PG-006 备注列表 | Sort Button、Note Card 样式重做 | 2h |
| PG-007 设置与隐私 | Storage Card 合并、百分比大字、危险色 | 1.5h |
| PG-008 注销处理中 | 联系客服链接、副文案 | 0.5h |
| PG-009 标签管理 | 图标操作按钮 | 0.5h |
| PG-010 标签选择层 | 虚框新建入口、count 显示、header 标题 | 1h |
| Navbar 工具函数 | 抽取 `utils/navbar.js`，重构各页 `_calcNavHeight` | 0.5h |

### 5.4 P3 — 动效 & 像素级还原（预计 4h）

| 任务 | 工时 |
|---|---|
| FAB 按压动效（scale 0.95） | 0.5h |
| Tag 选中/取消动效（transition 200ms） | 0.5h |
| Skeleton shimmer 动画微调（1.5s → 1.2s，更流畅） | 0.5h |
| Modal 弹出/关闭动效（translateY + opacity） | 1h |
| Tab Bar 自定义胶囊（custom-tab-bar） | 1.5h |

### 总工时估算

| 优先级 | 内容 | 工时 |
|---|---|---|
| P0 | Token 对齐 | 2h |
| P1 | 骨架屏 & 空态 | 6h |
| P2 | 页面细节对齐 | 12h |
| P3 | 动效 & 像素级 | 4h |
| **合计** | | **24h（约 3 人天）** |

---

## 附录 A：文件索引

### 设计文件

| 文件 | 用途 |
|---|---|
| `design/design_guide.md` | 设计规范文档（颜色、字体、圆角、组件、页面骨架） |
| `design/pages/PG-001~010*.png` | 10 个页面设计稿 |
| `design/skeleton/PG-002~006*.png` | 2 个骨架屏设计稿 |
| `design/empty/PG-002~006*.png` | 2 个空态设计稿 |

### 需修改的源码文件

| 文件 | 修改内容 |
|---|---|
| `miniprogram/theme/tokens.wxss` | 更新颜色值 + 新增 token |
| `miniprogram/components/page-state/page-state.wxml` | 新增 waterfall/note-list skeleton + empty CTA |
| `miniprogram/components/page-state/page-state.js` | 新增 props + emptyAction 事件 |
| `miniprogram/components/page-state/page-state.wxss` | 新增 skeleton & empty 样式 |
| `miniprogram/pages/photos/photos.wxml` | 接入新 page-state props |
| `miniprogram/pages/photos/photos.wxss` | FAB 尺寸 + Source Popup 样式 |
| `miniprogram/pages/notes/notes.wxml` | Sort Button + 接入新 page-state |
| `miniprogram/pages/notes/notes.wxss` | Note Card 样式优化 |
| `miniprogram/pages/index/index.wxml` | Logo + App 名 + spinner |
| `miniprogram/pages/index/index.wxss` | 启动页样式 |
| `miniprogram/pages/settings/settings.wxml` | Storage Card 合并 |
| `miniprogram/pages/deletion-status/deletion-status.wxml` | 联系客服链接 |
| `miniprogram/pages/tag-manager/tag-manager.wxml` | 图标操作按钮 |
| `miniprogram/components/note-editor/note-editor.wxml` | 字符计数 |
| `miniprogram/components/tag-picker/tag-picker.wxml` | 虚框新建 + count + header |
| `miniprogram/components/upload-panel/upload-panel.wxml` | 4 列网格 |
| `miniprogram/utils/navbar.js`（新建） | 导航栏算高工具函数 |

### 参考资料

| 文件 | 用途 |
|---|---|
| `docs/DESIGN-SYSTEM-图片笔记小程序-V1.0.0.md` | 现有设计系统文档（TDesign 组件策略） |
| `docs/PRD-图片笔记小程序-V1.0.0.md` | 产品需求文档 |
| `docs/FRONTEND-API-INTEGRATION-V1.0.0.md` | 前端 API 集成文档 |
| `docs/TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md` | 技术架构文档 |

---

## 附录 B：关键尺寸速查表

| 组件 | 设计尺寸(pt) | rpx | 备注 |
|---|---|---|---|
| Status Bar | 375×62 | 750×124 | 系统自动处理 |
| Navbar | 375×44 | 750×88 | h2(18pt Bold) |
| Modal Top Bar | 375×52 | 750×104 | 含关闭按钮 |
| Tab Bar | 375×83 | 750×166 | 内含 351×62 胶囊 |
| Tab Bar Pill | 351×62 | 702×124 | r-pill(52rpx) |
| Single Tab | 169.5×54 | 339×108 | r-pill(52rpx) |
| Photo Card | 167×N | 334×N rpx | r-sm(16rpx) |
| Note Card | 343×96 | 686×192 | 缩略图 60×60→120×120 |
| Storage Card | 343×101 | 686×202 | 进度条 H=4→8rpx |
| FAB | 56×56 | 112×112 | r-circle, 距底 32pt, 距右 16pt |
| Sort Button | 62×32 | 124×64 | r-lg(32rpx) |
| Tag/Chip | H=28 | H=56rpx | r-tag(28rpx) |
| Checkbox | 16×16 | 32×32 | r-xs(8rpx) |
| Status Indicator | 6×6 | 12×12 | 圆点 |
| Icon Small | 12×12 | 24rpx | Sort、Edit、Check |
| Icon Medium | 16×16 | 32rpx | Photo、Close/X |
| Icon Large | 18×18 | 36rpx | Tab Bar、Note、Image |
| Icon XLarge | 24×24 | 48rpx | Back Arrow、Settings、Plus |
| Empty Illustration | 240×160 | 480×320 | 空态插画 |
| Loading Spinner | 32×32 | 64rpx | 圆环 spinner |

---

> **文档维护：** 本文档基于设计稿 `design/` 和设计规范 `design/design_guide.md` 于 2026-08-03 生成。后续设计稿更新时，应同步更新本文档。
