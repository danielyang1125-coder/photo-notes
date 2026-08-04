# 图片笔记 Design System — 完整视觉规范

> 本文档为 `SKILL.md` 的详细参考，包含完整的颜色表、字体表、组件尺寸和页面规格。
> 当需要查询具体数值时，从这里检索。

---

## 1. 颜色系统

### 品牌主色

| Token | CSS 变量 | Hex | 使用场景 |
|-------|---------|-----|---------|
| primary-500 | `--color-primary` | `#0052D9` | 主按钮、激活 Tab、链接、Icon 高亮、危险提示按钮 |
| primary-50 | `--color-primary-light` | `#E7F0FF` | 选中 Tag 浅色背景 |

### 状态色

| Token | CSS 变量 | Hex | 使用场景 |
|-------|---------|-----|---------|
| success-500 | `--color-success` | `#00A870` | 上传成功、进行中绿点 |
| warning-500 | `--color-warning` | `#ED7B2F` | 上传失败警告、存储超 80% |
| danger-500 | `--color-error` | `#D54941` | 注销按钮、删除文字、报错 Icon |

### Surface / 背景

| Token | CSS 变量 | Hex | 使用场景 |
|-------|---------|-----|---------|
| surface-base | `--color-surface-base` | `#FFFFFF` | 主背景、卡片、Tab Bar、Navbar |
| surface-secondary | `--color-surface-secondary` | `#F3F3F3` | 页面次背景、设置分组背景 |
| surface-tertiary | `--color-surface-tertiary` | `#F2F3F5` | Loading 区、Modal 内底 |

### Neutral / 文本描边

| Token | CSS 变量 | Hex | 使用场景 |
|-------|---------|-----|---------|
| text-primary | `--color-text-primary` | `#181818` | 主标题、正文 |
| text-secondary | `--color-text-secondary` | `#5E5E5E` | 次要说明、辅助文字 |
| text-placeholder | `--color-text-placeholder` | `#A6A6A6` | 不可点击/占位 |
| border-default | `--color-border` | `#E8E8E8` | 卡片描边、按钮描边 |
| overlay-ink | `--color-overlay-ink` | `#101114` | Modal 遮罩 |

### 透明度规范

| 用途 | CSS 变量 |
|------|---------|
| Tab Bar 阴影 / 一级浮层 | `--shadow-tab` = `0 4rpx 16rpx rgba(0,0,0,0.08)` |
| 卡片轻浮层 | `--shadow-light` = `0 2rpx 8rpx rgba(0,0,0,0.10)` |
| Modal 遮罩 | `--shadow-modal` = `0 -4rpx 12rpx rgba(0,0,0,0.15)` |

---

## 2. 字体系统

### 字体家族
- 中文：`Noto Sans SC`（Regular 400 / Medium 500 / Bold 700 / SemiBold 600）
- 数字/英文：`Inter`（用于时间戳、百分比、容量数字）

### Text Style Tokens（pt → rpx 换算：×2）

| Token | 字体 | 字号(pt) | 字号(rpx) | CSS 变量 | 字重 | 颜色 | 用途 |
|-------|------|---------|----------|---------|------|------|------|
| h1 | Noto Sans SC | 20 | 40rpx | `--font-size-xl`+ | Bold | text-primary | 启动页 App 名 |
| h2 | Noto Sans SC | 18 | 36rpx | `--font-size-xl` | Bold | text-primary | Navbar 标题 |
| h3 | Noto Sans SC | 16 | 32rpx | `--font-size-lg` | Bold | text-primary | 区块标题 |
| body-lg | Noto Sans SC | 15 | 30rpx | `--font-size-lg`- | Regular | text-primary | 备注正文 |
| body | Noto Sans SC | 14 | 28rpx | `--font-size-md` | Regular | text-primary | 卡片正文 |
| body-sm | Noto Sans SC | 13 | 26rpx | `--font-size-sm`+ | Regular | text-primary/secondary | Tag 文案 |
| caption | Noto Sans SC | 12 | 24rpx | `--font-size-sm` | Regular | text-secondary/warning | 时间戳 |
| label-md | Noto Sans SC | 14 | 28rpx | `--font-size-md` | Medium | 视场景 | 按钮、Tab |
| label-sm | Noto Sans SC | 13 | 26rpx | `--font-size-sm`+ | Medium | 视场景 | Tag 选中态 |
| number-md | Inter | 14 | 28rpx | `--font-size-md` | Medium | text-primary | 存储容量 |
| number-lg | Inter | 18 | 36rpx | `--font-size-xl` | SemiBold | surface-base | FAB 数字 |

### 行高
- 中文行高统一 Auto；正文密度 1.4–1.5 视觉感受
- 英文/数字 Inter 行高 Auto
- 默认字距 0

---

## 3. 形状系统

### 圆角（rpx = pt × 2）

| Token | CSS 变量 | pt值 | rpx值 | 典型用法 |
|-------|---------|------|-------|---------|
| r-xs | `--radius-xs` | 4 | 4rpx | 角标、徽章、Checkbox |
| r-sm | `--radius-sm` | 8 | 8rpx | 卡片、按钮、Photo Card |
| r-tag | `--radius-tag` | 14 | 14rpx | Tag/Chip 胶囊 |
| r-lg | `--radius-lg` | 16 | 16rpx | Sort Button、Modal 顶角 |
| r-pill | `--radius-pill` | 26 | 26rpx | Tab Bar 胶囊 |
| r-circle | `--radius-circle` | — | 50% | FAB 圆形 |

### 间距（rpx = pt × 2）

| Token | CSS 变量 | pt值 | rpx值 | 典型用法 |
|-------|---------|------|-------|---------|
| sp-xs | `--space-xs` | 4 | 4rpx | 文字与 Icon 间距、Tag 之间 gap |
| sp-sm | `--space-sm` | 8 | 8rpx | 卡片垂直 padding 一半 |
| sp-md | `--space-md` | 12 | 12rpx | 列表垂直 padding、Grid 间距 |
| sp-lg | `--space-lg` | 16 | 16rpx | 卡片水平 padding、Modal 边距 |
| sp-xl | `--space-xl` | 24 | 24rpx | 区块上下分隔 |

### 描边

| Token | 值 | 用途 |
|-------|-----|------|
| st-1 | 1px | 默认描边、按钮 outline、卡片边 |
| st-2 | 2px | 选中态额外强调（少见） |

---

## 4. 原子组件详细规格

### Tag / Chip
- 尺寸：H=28pt (56rpx)，宽度自适应
- 字体：`body-sm`（13pt / 26rpx）
- 圆角：`r-tag`（14pt / 14rpx）
- Padding：`sp-xs`（10pt → 20rpx）
- **选中态**：文字 `--color-primary` + 背景 `--color-primary-light`
- **未选态**：文字 `--color-text-primary` + 背景 `--color-surface-base` + 描边 `--color-border` 1px

### Sort Button
- 尺寸：62×32pt (124×64rpx)
- 字体：`body-sm`（13pt）
- 圆角：`r-lg`（16pt / 16rpx）
- 半透明白底

### Primary Button
- 高度：≥ 44pt (88rpx)，宽度自适应
- 字体：`label-md`（14pt / 28rpx Medium）
- 圆角：`r-sm`（8pt / 8rpx）
- 背景：`--color-primary`，文字：`--color-surface-base`

### Outline Button（危险操作）
- 高度：≥ 44pt (88rpx)
- 字体：`label-md`（14pt / 28rpx Medium）
- 圆角：`r-sm`（8pt / 8rpx）
- 背景：`--color-surface-base`，文字+描边：`--color-error`

### Checkbox
- 尺寸：16×16pt (32×32rpx) 圆
- 圆角：`r-xs`（4pt / 4rpx）
- 选中：`--color-primary` 底 + 白色对勾（Check Icon 12×12）

### Status Indicator
- 尺寸：6×6pt (12×12rpx) 圆点
- 绿点 = 成功（`--color-success`），红点 = 失败（`--color-error`）

---

## 5. 图标规格

均采用 1.5–2px stroke 线性 icon，统一 16/18/24pt 三档尺寸。

| 图标 | pt尺寸 | rpx尺寸 | 来源 |
|------|--------|---------|------|
| Note Icon（备注） | 18×18 | 36×36 | Tab Bar、备注列表 |
| Image Icon（图片） | 18×18 | 36×36 | Tab Bar、上传反馈 |
| Photo Icon | 16×16 | 32×32 | Photo 详情标记 |
| Sort Icon | 12×12 | 24×24 | 排序按钮 |
| Edit Icon（铅笔） | 12×12 | 24×24 | Tag 行尾编辑 |
| Plus Icon | 24×24 | 48×48 | FAB、空态 CTA |
| Check Icon | 12×12 | 24×24 | 选中状态 |
| Close / X | 16×16 | 32×32 | 上传失败标记 |
| Back Arrow | 24×24 | 48×48 | Navbar 返回 |
| Settings（齿轮） | 24×24 | 48×48 | Navbar 右上角 |

---

## 6. 复合组件详细规格

### Status Bar
- 375×62pt，`--color-surface-base` 背景
- 左：时间（Inter SemiBold 15pt，`--color-text-primary`）
- 右：信号+WiFi+电池

### Navbar / Top Bar
- 375×44pt（普通页）/ 52pt（Modal 含关闭按钮）
- 左：返回/取消，右：更多/保存
- 中间标题 `h2`（18pt Bold）居中

### Tab Bar（底部导航）
- 容器：375×83pt，内含 351×62pt 白色胶囊
- 胶囊圆角：`r-pill`（26pt / 26rpx），阴影：`--shadow-tab`
- 单 Tab：169.5×54pt，`r-pill` 圆角，含 Icon + Label
- 激活：`--color-primary` 背景 + `--color-surface-base` 文字
- 非激活：透明 + `--color-text-placeholder` 文字
- 上间距 12pt，下间距 12pt

### Photo Card
- 167×Npt（160–260 多档，瀑布流）
- 圆角：`r-sm`（8pt / 8rpx）
- 左下角可叠加 Photo Icon + 数字 Count 角标

### Note Card
- 343×96pt，圆角 `r-sm`（8pt / 8rpx）
- 背景：`--color-surface-base`
- 左：60×60pt 缩略图
- 右：备注正文（最多两行省略号）+ 时间戳 `caption`

### Storage Card
- 343×101pt，圆角 `r-sm`（8pt / 8rpx）
- 上：Label + 已用/总量（Inter Medium 14pt）
- 中：进度条 H=4pt，`--color-primary` 填充，`--color-surface-tertiary` 底色
- 下：百分比（`number-md`），≥85% 时变 `--color-warning`

### FAB（Floating Action Button）
- 56×56pt 圆形（`r-circle` = 50%）
- 背景：`--color-primary`
- Plus Icon 24×24pt 居中
- 距底部 32pt，距右侧 16pt

### Tag Panel（Modal 底部抽屉）
- 375×700pt，顶角 `r-lg`（16pt / 16rpx），背景 `--color-surface-base`
- Top Bar：取消 / 编辑标签 / 「已选 n/m」Badge + 保存
- 内含「+ 新建标签」虚框入口 + 多选 Tag 列表

### Note Editor Sheet
- Modal 顶角 `r-lg`（16rpx）
- Top Bar：取消 / 新备注 / 保存
- 输入框 + 字符计数 `caption`

### Upload Panel
- Header：「已选 n/m」+「继续选择」按钮
- 中部：4 列网格，每张可叠加选中绿勾 / 失败红 X
- 底部 Warning Banner：橙色文字
- 最底 CTA：「为本批图片添加标签」Primary Button

### Settings List Item
- 343×56pt（基础）/ 112pt（含说明）
- 左：标题 / 右：chevron > 或危险文字
- 分组间用 `--color-surface-secondary` 间隔

### Empty State
- 居中：插画（240×160pt）+ 主标题 `h3` + 副文案 `body` + Primary Button CTA

### Skeleton Card
- 167×Npt，灰色 `--color-surface-secondary` 占位块
- 内部 12×12pt / 长条形骨架条
- 列表骨架：3 条

### Loading Spinner
- 32×32pt 圆环
- 外圈：`--color-surface-secondary`
- 1/4 弧：`--color-primary`

---

## 7. 页面映射表

| 页面 | 主要 Frame | 内容特征 |
|------|-----------|---------|
| PG-001 启动页 | 全屏 Logo + App名 + Loading + v1.0.0 | 绝对居中，垂直堆叠 |
| PG-002 图片列表 | Navbar + Tag Filter + 2列瀑布流 + FAB + Tab Bar | 列宽 167pt，间距 8pt |
| PG-003 上传面板 | Header + 4列网格 + Warning Banner + CTA | 顶部固定 Header |
| PG-004 图片预览详情 | Navbar + 大图 + 时间 + Tag Row + 备注列表 + 添加备注 | 大图满宽 |
| PG-005 备注编辑层 | Modal Sheet（r-lg，覆盖 65%） | 底部弹起 |
| PG-006 备注列表 | Navbar + Sort + Note Card 列表 + Tab Bar | 单列，间距 8pt |
| PG-007 设置与隐私 | Navbar + Storage Card + 分组列表 + Danger Button | 分组背景 surface-secondary |
| PG-008 注销处理中 | 全屏 Loading + 文案 + 联系客服 | 居中堆叠 |
| PG-009 标签管理 | Navbar +「+新建标签」+ Tag List | 单列 |
| PG-010 标签选择层 | Modal：新建标签 + 多选列表 + 保存 | 同 PG-005 结构 |

---

## 8. 现有项目结构映射

### 页面 → 设计稿对应

| 页面路径 | 对应设计稿 | 说明 |
|---------|-----------|------|
| `pages/photos/photos` | PG-002 图片列表 | 瀑布流 + Tag 筛选 + FAB |
| `pages/notes/notes` | PG-006 备注列表 | Note Card 列表 |
| `pages/preview/preview` | PG-004 图片预览详情 | 大图 + 备注列表 |
| `pages/settings/settings` | PG-007 设置与隐私 | Storage Card + 列表 |
| `pages/tag-manager/tag-manager` | PG-009 标签管理 | Tag 列表 |
| `pages/deletion-status/deletion-status` | PG-008 注销处理中 | Loading + 文案 |
| `pages/index/index` | PG-001 启动页 | Logo + Loading |

### 组件映射

| 组件目录 | 对应设计组件 | 说明 |
|---------|------------|------|
| `components/photo-card/` | Photo Card | 瀑布流图片卡片 |
| `components/tag-filter-bar/` | Tag Filter | 标签筛选栏 |
| `components/tag-picker/` | Tag Panel | 标签选择 Modal |
| `components/note-editor/` | Note Editor Sheet | 备注编辑 Modal |
| `components/upload-panel/` | Upload Panel | 上传面板 |
| `components/page-state/` | Empty/Skeleton/Error | 页面状态组件 |
| `components/photo-tag-section/` | Tag Row | 图片标签区域 |
| `components/cloudTipModal/` | Modal | 云提示 Modal |
| `custom-tab-bar/` | Tab Bar | 自定义底部导航 |

---

## 9. pt → rpx 换算速查

设计稿以 pt（逻辑像素）为单位，微信小程序使用 rpx。
换算公式：**rpx = pt × 2**（基于 iPhone 6/7/8 375pt = 750rpx）

| 常用 pt 值 | rpx 值 |
|-----------|--------|
| 4pt | 8rpx |
| 8pt | 16rpx |
| 12pt | 24rpx |
| 14pt | 28rpx |
| 16pt | 32rpx |
| 18pt | 36rpx |
| 20pt | 40rpx |
| 24pt | 48rpx |
| 26pt | 52rpx |
| 28pt | 56rpx |
| 32pt | 64rpx |
| 44pt | 88rpx |
| 56pt | 112rpx |
| 62pt | 124rpx |
| 83pt | 166rpx |
| 96pt | 192rpx |
| 101pt | 202rpx |
| 160pt | 320rpx |
| 167pt | 334rpx |
| 240pt | 480rpx |
| 343pt | 686rpx |
| 351pt | 702rpx |
| 375pt | 750rpx |
| 700pt | 1400rpx |
