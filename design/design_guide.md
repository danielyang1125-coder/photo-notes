# 图片笔记 Design System

> 一份给前端开发的视觉规范说明。覆盖颜色变量、文字样式、间距、圆角、阴影、组件结构与页面骨架。所有 token 命名遵循 `类别-角色` 模式，方便映射成 CSS variables / Tailwind theme / Style Dictionary 等前端工程方案。

---

## 1. 概览

**产品定位**：图片笔记 App —— 用图片承载记忆，用备注记录想法。
**设计语言**：克制、留白、克制装饰，以蓝色为情感主线，整体偏 editorial/clean。
**设备规范**：iOS 移动端（375 × 812 为基准画板），含启动页、列表、详情、模态层、设置页与多种状态。
**支持状态**：默认 / 加载骨架 / 空态 / 错误 / 进行中。

---

## 2. 颜色系统（Color Tokens）

按用途归类，禁止用 hue 名（Blue / Red）。

### 2.1 Brand · 品牌主色

| Token         | Hex       | 使用场景                                                            |
| ------------- | --------- | ------------------------------------------------------------------- |
| `primary-500` | `#0052D9` | 主按钮、激活态 Tab、关键链接、Icon 高亮、链接 Tag、危险提示按钮底色 |
| `primary-50`  | `#E7F0FF` | 选中 Tag 的浅色背景、Tag 选择层选中态底色                           |

> 主色饱和度偏高，建议主色面积控制在 30% 以内，主品牌情感来自克制。

### 2.2 Status · 状态色

| Token         | Hex       | 使用场景                                           |
| ------------- | --------- | -------------------------------------------------- |
| `success-500` | `#00A870` | 上传成功提示、进行中（绿点）                       |
| `warning-500` | `#ED7B2F` | 上传失败 / 警告提示文字、存储超过 80% 时百分比文字 |
| `danger-500`  | `#D54941` | 注销账号按钮、删除文字、报错 Icon                  |

### 2.3 Surface · 表面 / 背景

| Token               | Hex       | 使用场景                         |
| ------------------- | --------- | -------------------------------- |
| `surface-base`      | `#FFFFFF` | 主背景、卡片底、Tab Bar、Navbar  |
| `surface-secondary` | `#F3F3F3` | 页面级次背景、设置分组背景       |
| `surface-tertiary`  | `#F2F3F5` | 顶部 Loading 区、特殊 Modal 内底 |

### 2.4 Neutral · 中性文本 / 描边

| Token            | Hex       | 使用场景                         |
| ---------------- | --------- | -------------------------------- |
| `text-primary`   | `#181818` | 主标题、正文                     |
| `text-secondary` | `#5E5E5E` | 次要说明、辅助文字、拍摄时间     |
| `text-tertiary`  | `#A6A6A6` | 不可点击 / 占位 / 更多按钮       |
| `border-default` | `#E8E8E8` | 卡片描边、按钮描边、Tab 容器描边 |
| `overlay-ink`    | `#101114` | Modal 顶部遮罩                   |

### 2.5 透明度规范

| 用途                    | RGBA               |
| ----------------------- | ------------------ |
| Tab Bar 阴影 / 一级浮层 | `rgba(0,0,0,0.08)` |
| 卡片轻浮层              | `rgba(0,0,0,0.10)` |
| Modal 遮罩              | `rgba(0,0,0,0.15)` |

---

## 3. 字体系统（Typography）

**字体家族**：

- 中文：`Noto Sans SC`（Regular / Medium / Bold / SemiBold 四种字重）
- 数字 / 英文：`Inter`（用于时间戳、百分比、容量数字）

### 3.1 Text Style Tokens

| Token       | 字体         | 字号 | 字重      | 颜色                              | 用途                                     |
| ----------- | ------------ | ---- | --------- | --------------------------------- | ---------------------------------------- |
| `h1`        | Noto Sans SC | 20   | Bold      | `text-primary`                    | 启动页 App 名                            |
| `h2`        | Noto Sans SC | 18   | Bold      | `text-primary`                    | Navbar / 详情页标题                      |
| `h3`        | Noto Sans SC | 16   | Bold      | `text-primary`                    | 区块标题（新备注、备注数量、Modal 标题） |
| `body-lg`   | Noto Sans SC | 15   | Regular   | `text-primary`                    | 备注正文、Modal 正文                     |
| `body`      | Noto Sans SC | 14   | Regular   | `text-primary`                    | 卡片正文、说明文字                       |
| `body-sm`   | Noto Sans SC | 13   | Regular   | `text-primary` / `text-secondary` | Tag 文案、列表次要信息                   |
| `caption`   | Noto Sans SC | 12   | Regular   | `text-secondary` / `warning-500`  | 时间戳、警告信息                         |
| `label-md`  | Noto Sans SC | 14   | Medium    | 视场景而定                        | 主按钮、Tab 文案、Modal 保存按钮         |
| `label-sm`  | Noto Sans SC | 13   | Medium    | 视场景而定                        | Tag 选中态文案、Counter                  |
| `number-md` | Inter        | 14   | Medium    | `text-primary`                    | 存储容量、进度数字                       |
| `number-lg` | Inter        | 18   | Semi Bold | `surface-base`                    | FAB 上大数字 / 容量百分比                |

### 3.2 行高 / 字距

- 中文行高统一跟随字号自动 (Auto)；正文密度 1.4–1.5 视觉感受。
- 英文 / 数字 Inter 行高同样使用 AUTO。
- 默认字距 0；`number-lg` 字距保持 0 即可。

---

## 4. 形状（Shape）

### 4.1 圆角（Radii）

| Token      | 值  | 典型用法                                         |
| ---------- | --- | ------------------------------------------------ |
| `r-xs`     | 4   | 角标、徽章、Checkbox                             |
| `r-sm`     | 8   | 普通卡片、备注卡、Photo Card、Storage Card、按钮 |
| `r-tag`    | 14  | Tag / Chip（半圆角胶囊）                         |
| `r-lg`     | 16  | Sort Button、Tag Panel 顶角                      |
| `r-pill`   | 26  | Tab Bar 上单个 Tab 胶囊                          |
| `r-circle` | 28+ | FAB（圆形 56×56）                                |

### 4.2 间距（Spacing）

以 4 为基数，固定比例。

| Token   | 值  | 典型用法                              |
| ------- | --- | ------------------------------------- |
| `sp-xs` | 4   | 文字与 Icon 间距、Tag 之间 gap        |
| `sp-sm` | 8   | 卡片内垂直 padding 一半、Tag row 间距 |
| `sp-md` | 12  | 列表项垂直 padding、Photo Grid 间距   |
| `sp-lg` | 16  | 卡片水平 padding、Modal 内容边距      |
| `sp-xl` | 24  | 区块上下分隔、Section 之间            |

### 4.3 描边（Strokes）

| Token  | 值  | 用途                           |
| ------ | --- | ------------------------------ |
| `st-1` | 1   | 默认描边、按钮 outline、卡片边 |
| `st-2` | 2   | 选中态额外强调（少见）         |

### 4.4 阴影（Effect）

| Token          | 配置                                                       | 用途                             |
| -------------- | ---------------------------------------------------------- | -------------------------------- |
| `shadow-tab`   | `0 0 0 rgba(0,0,0,0.08)`（Y/X 偏移 0，Blur 0，实色 8% 黑） | 底部 Tab Bar 浮起                |
| `shadow-modal` | `0 0 0 rgba(0,0,0,0.15)`                                   | 模态层（编辑备注、标签选择）     |
| `shadow-light` | `0 0 0 rgba(0,0,0,0.10)`                                   | 卡片轻浮（设置项、列表项 hover） |

> 设计稿阴影采用「无偏移、无模糊」+ 8%/15% 实色黑作为遮罩模拟柔光，前端实现时可用 `box-shadow: 0 4px 16px rgba(0,0,0,0.08)` 近似。

---

## 5. 组件（Components）

下列组件按「原子 → 复合 → 页面骨架」层级拆分。

### 5.1 原子组件（Atoms）

| 组件                 | 尺寸              | 关键 Token                                                                      | 说明                                                                                                                  |
| -------------------- | ----------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Tag / Chip**       | H=28，自适应宽度  | `body-sm` / `r-tag` / `sp-xs`(padding 10)                                       | 选中态：`primary-500` 文字 + `primary-50` 底；未选：`text-primary` 文字 + `surface-base` 底 + `border-default` 描边 1 |
| **Sort Button**      | 62×32             | `body-sm` / `r-lg`(16)                                                          | 半透明白底，按下可切换倒序                                                                                            |
| **Primary Button**   | H=44+，宽度自适应 | `label-md` / `r-sm`(8) / `primary-500` 底 / `surface-base` 文字                 | 例：保存、添加备注、为本批图片添加标签                                                                                |
| **Outline Button**   | H=44+             | `label-md` / `r-sm` / `surface-base` 底 / `danger-500` 文字 + `danger-500` 描边 | 例：注销账号                                                                                                          |
| **Checkbox**         | 16×16 圆          | `r-xs`                                                                          | 选中：`primary-500` 底 + 白色对勾                                                                                     |
| **Status Indicator** | 6×6 圆点          | —                                                                               | 绿点（成功）+ 红点（失败）出现在上传反馈                                                                              |

### 5.2 图标（Icons）

均采用 1.5–2px stroke 的线性 icon，统一 16 / 18 / 24 三档尺寸。

| 图标               | 尺寸  | 来源                  |
| ------------------ | ----- | --------------------- |
| Note Icon（备注）  | 18×18 | Tab Bar、备注列表     |
| Image Icon（图片） | 18×18 | Tab Bar、上传反馈     |
| Photo Icon         | 16×16 | Photo 详情标记        |
| Sort Icon          | 12×12 | 排序按钮、More 按钮   |
| Edit Icon（铅笔）  | 12×12 | Tag 行尾编辑          |
| Plus Icon          | 24×24 | FAB、空态 CTA 按钮    |
| Check Icon         | 12×12 | 选中状态、Checkbox 内 |
| Close / X          | 16×16 | 上传失败标记          |
| Back Arrow         | 24×24 | Navbar 返回           |
| More (•••)         | —     | 操作菜单              |
| Settings（齿轮）   | 24×24 | Navbar 右上角         |

### 5.3 复合组件（Composites）

#### 5.3.1 Status Bar

- 375 × 62，`surface-base` 底
- 左：时间（Inter SemiBold 15，`text-primary`）
- 右：信号 + WiFi + 电池图标（建议统一 Iconify `material-symbols`）

#### 5.3.2 Navbar / Top Bar

- 375 × 44 / 52（H=44 普通页，52 用于含关闭按钮的 Modal）
- 左侧返回 / 取消，右侧更多 / 保存
- 中间标题 `h2`，粗体居中

#### 5.3.3 Tab Bar（底部主导航）

- 容器 375 × 83，内含 351 × 62 `r-pill` 白色胶囊（`shadow-tab`）
- 单 Tab 169.5 × 54，`r-pill`(26)，内含 Icon + Label
- 激活 Tab：`primary-500` 底 + `surface-base` 文字
- 非激活 Tab：透明底 + `text-tertiary` 文字
- 上间距 12（Nav 安全区），下间距 12

#### 5.3.4 Photo Card

- 167 × N（160–260 之间多档，按瀑布流）
- `r-sm`(8)
- 左下角可叠加角标 Photo Icon + 数字 Count

#### 5.3.5 Note Card

- 343 × 96，`r-sm`(8)，`surface-base` 底
- 左侧 60×60 缩略图 + 右侧 备注正文（最多两行，省略号截断）+ 时间戳 `caption`

#### 5.3.6 Storage Card

- 343 × 101，`r-sm`(8)
- 上：Label + 已用/总量（Inter Medium 14）
- 中：进度条（H=4，`primary-500` 填充，`surface-tertiary` 底）
- 下：百分比文字（`number-md`，85% 时变 `warning-500`）

#### 5.3.7 FAB

- 56 × 56 圆形（`r-circle`），`primary-500` 底，Plus Icon 居中
- 距离底部 32，距离右侧 16

#### 5.3.8 Tag Panel（Modal 底部抽屉）

- 375 × 700，`r-lg`(16) 顶角，`surface-base`
- 顶部 Top Bar：取消 / 编辑标签 / 「已选 n/m」Badge + 保存
- 内含「+ 新建标签」虚框入口 + 多选 Tag 列表

#### 5.3.9 Note Editor Sheet

- 顶部 Modal `r-lg`，包含 Top Bar（取消 / 新备注 / 保存）+ 输入框 + 字符计数 `caption`

#### 5.3.10 Upload Panel

- 顶部 Header：「已选 6/20」+ 「继续选择」按钮
- 中部网格：4 列 Photo，每张可叠加「选中」绿勾 / 「失败」红 X
- 底部 Warning Banner：「1 张图片上传失败：文件过大（>20MB）」橙色文字
- 最底 CTA：「为本批图片添加标签」全宽 Primary Button

#### 5.3.11 Settings List Item

- 343 × 56（基础）/112（含说明）
- 左侧标题 / 右侧 chevron > 或危险文字
- 分组之间用 `surface-secondary` 间隔

#### 5.3.12 Empty State

- 居中：插画（240×160）+ 主标题 `h3` + 副文案 `body` + Primary Button CTA
- 例：图片空态、备注空态

#### 5.3.13 Skeleton Card

- 167 × N，灰色 `surface-secondary` 占位块 + 内部 12×12 / 长条形 Skeleton 条
- 列表 Skeleton：3 条

#### 5.3.14 Loading Spinner

- 32×32 圆环（外圈 `surface-secondary`，内圈四分之一 `primary-500`），用于启动页 / 注销处理中

---

## 6. 页面骨架（Layout）

每个移动页面的纵向区域：

┌────────────────────────────┐ │ Status Bar (62) │ ← 系统状态 ├────────────────────────────┤ │ Navbar (44) │ ← 标题 + 操作 ├────────────────────────────┤ │ Filter Row / Search (44–56)│ ← 可选，标签筛选 ├────────────────────────────┤ │ │ │ Content (主内容) │ ← 列表/网格/表单 │ │ ├────────────────────────────┤ │ Tab Bar (83) / CTA (44+) │ ← 主导航或底部按钮 └────────────────────────────┘

### 6.1 主流页面映射

| 页面                | 主要 Frame                                           | 内容区域特征                 |
| ------------------- | ---------------------------------------------------- | ---------------------------- |
| PG-001 启动页       | 全屏 Logo + App 名 + Loading + v1.0.0                | 绝对居中布局，垂直堆叠       |
| PG-002 图片列表     | Navbar + Tag Filter + 2 列瀑布流网格 + FAB + Tab Bar | 网格列宽 167，间距 8         |
| PG-003 上传面板     | Header + 4 列网格（多选态）+ Warning Banner + CTA    | 顶部固定 Header              |
| PG-004 图片预览详情 | Navbar + 大图 + 时间 + Tag Row + 备注列表 + 添加备注 | 大图满宽                     |
| PG-005 备注编辑层   | Modal Sheet（`r-lg`，覆盖 65%）                      | 底部弹起                     |
| PG-006 备注列表     | Navbar + Sort + Note Card 列表 + Tab Bar             | 单列，卡片间距 8             |
| PG-007 设置与隐私   | Navbar + Storage Card + 分组列表 + Danger Button     | 分组背景 `surface-secondary` |
| PG-008 注销处理中   | 全屏 Loading + 文案 + 联系客服链接                   | 居中纵向堆叠                 |
| PG-009 标签管理     | Navbar + 「+ 新建标签」入口 + Tag List Items         | 单列                         |
| PG-010 标签选择层   | Modal Sheet：新建标签 + 多选列表 + 保存              | 与 PG-005 同结构             |

---

## 7. 全局规则（Rules）

1. **主色克制**：单页主色（`primary-500`）面积不超过 30%；大面积主色仅限 FAB、激活 Tab、进度条、主按钮。
2. **圆角分层**：卡片 8 / Tag 14 / Tab 胶囊 26 / FAB 28+；同一容器内禁止混用差距 > 12 的圆角。
3. **文字克制**：除启动页 App 名外，正文与标题统一使用 `text-primary`；次级文字用 `text-secondary`，禁用纯黑 `#000`。
4. **阴影克制**：仅浮层（Tab Bar / Modal）使用 shadow；卡片不使用阴影，靠 `border-default` 描边区分。
5. **状态完整性**：每个数据列表都需要 3 态 —— 默认 / 加载骨架 / 空态。骨架屏与空态文案必须出现在设计稿内。
6. **数字字体**：所有时间戳、容量、百分比统一使用 Inter 系列；中文文字统一 Noto Sans SC，避免混排错位。
7. **Modal 高度**：底部抽屉默认覆盖屏幕 60%–70%，顶角 `r-lg`(16)。
8. **危险操作**：仅用 `danger-500` 描边 + 文字，不使用实色背景。

---

## 8. 前端落地建议

### 8.1 CSS 变量映射（推荐）

```css
:root {
  /* Brand */
  --color-primary-500: #0052D9;
  --color-primary-50:  #E7F0FF;

  /* Status */
  --color-success-500: #00A870;
  --color-warning-500: #ED7B2F;
  --color-danger-500:  #D54941;

  /* Surface */
  --color-surface-base:      #FFFFFF;
  --color-surface-secondary: #F3F3F3;
  --color-surface-tertiary:  #F2F3F5;

  /* Neutral */
  --color-text-primary:   #181818;
  --color-text-secondary: #5E5E5E;
  --color-text-tertiary:  #A6A6A6;
  --color-border-default: #E8E8E8;
  --color-overlay-ink:    #101114;

  /* Radius */
  --radius-xs: 4px;
  --radius-sm: 8px;
  --radius-tag: 14px;
  --radius-lg: 16px;
  --radius-pill: 26px;

  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-lg: 16px;
  --space-xl: 24px;
}

8.2 拆分公用组件建议
拆分颗粒度	复用价值
Tag（含 selected / default）	高：Tab 筛选、Tag Row、Modal 多选
PrimaryButton / OutlineButton / DangerButton	高：贯穿所有 Modal 与 CTA
Card（Note / Storage / Settings Item）	中：样式相同，结构不同
TopBar（含左中右 slot）	高：所有页面共享
StatusBar	中：可封装系统组件
ModalSheet	高：编辑备注、标签选择都使用
EmptyState / SkeletonCard	中：3 列表态通用
Icon 统一封装	高：建议使用 Iconify material-symbols

9. 文档索引
颜色：§2
字体：§3
圆角 / 间距 / 阴影：§4
原子组件：§5.1
图标：§5.2
复合组件：§5.3
页面骨架：§6
全局规则：§7
前端落地：§8
```
