# DESIGN SYSTEM — 图片笔记小程序 V1.0.0

> 设计角色：AGENT-02-UI-DESIGN  
> 适用端：微信小程序用户端  
> 组件基线：TDesign 微信小程序

## 1. 设计原则

- 内容优先：图片与备注是第一视觉层级，品牌色只用于操作、选中和反馈。
- TDesign 优先：基础控件不重复设计，通过属性、插槽和主题变量完成适配。
- 状态明确：上传、保存、删除、注销等操作同时使用颜色、图标和文字表达状态。
- 移动端友好：主操作热区不小于 44px，适配底部安全区和系统字体放大。

## 2. 色彩

| Token | 色值 | 用途 |
|---|---|---|
| `--color-primary` | `#0052D9` | 主按钮、链接、选中态 |
| `--color-primary-hover` | `#266FE8` | 悬停/轻强调 |
| `--color-primary-active` | `#003CAB` | 按下态 |
| `--color-primary-light` | `#E7F0FF` | 高亮、浅色提示背景 |
| `--color-success` | `#00A870` | 上传/保存成功 |
| `--color-warning` | `#ED7B2F` | 空间预警、接近字符上限 |
| `--color-danger` | `#D54941` | 删除、错误、注销 |
| `--color-text-primary` | `#181818` | 标题、正文 |
| `--color-text-secondary` | `#5E5E5E` | 次级正文 |
| `--color-text-placeholder` | `#A6A6A6` | 占位内容 |
| `--color-border` | `#E7E7E7` | 边框、分割线 |
| `--color-bg-page` | `#F3F3F3` | 页面背景 |
| `--color-bg-card` | `#FFFFFF` | 卡片、弹层 |
| `--color-image-stage` | `#101114` | 沉浸式图片背景 |

文本与背景对比度按 WCAG AA 校验；语义色不作为唯一状态信号。

## 3. 字体

- 字体族：`-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`
- 页面标题：18px / 26px / 600
- 区块标题：16px / 24px / 600
- 正文：14px / 22px / 400
- 重要正文：15px / 24px / 400
- 辅助信息：12px / 18px / 400
- 徽标：10px / 14px / 500

长备注正文支持系统字体放大，不使用固定高度截断编辑内容。

## 4. 间距、圆角与阴影

- 基础间距单位：4px；常用间距为 8、12、16、24、32px。
- 页面左右安全边距：16px；瀑布流列间距：8px。
- 按钮、输入框：8px 圆角。
- 图片卡片、普通卡片：12px 圆角。
- 底部弹层顶部：16px 圆角。
- 悬浮按钮：圆形；主要弹窗：12px 圆角。
- 卡片默认阴影：`0 1px 3px rgba(0, 0, 0, .08)`。
- 弹层阴影：`0 -8px 24px rgba(0, 0, 0, .12)`。

## 5. TDesign 组件策略

| 场景 | 组件 | 约束 |
|---|---|---|
| 页面导航 | `t-navbar` | 统一返回、标题和右侧操作 |
| 一级导航 | `t-tab-bar` | 仅“图片”“备注” |
| 图片与状态 | `t-image`、`t-badge`、`t-tag` | 列表只加载缩略图 |
| 上传 | `t-upload`、`t-progress`、`t-loading` | 业务层控制压缩、并发和幂等 |
| 编辑 | `t-popup`、`t-textarea`、`t-input` | 未保存内容离开需确认 |
| 操作选择 | `t-action-sheet` | 来源、排序、单项更多操作 |
| 高风险确认 | `t-dialog` | 禁止点击遮罩直接关闭 |
| 页面状态 | `t-skeleton`、`t-empty`、`t-result` | 页面框架保持稳定 |
| 即时反馈 | `t-toast`、`t-message`、`t-notice-bar` | 按信息持续时间选用 |
| 设置列表 | `t-cell-group`、`t-cell`、`t-progress` | 保持 TDesign 默认信息层级 |

组件按页面在 `usingComponents` 中局部引入；不修改 TDesign 源码，不全量引入。

## 6. 业务组合组件

- `AppNavbar`：封装标题、返回、右侧操作和状态栏安全区。
- `AppTabBar`：封装两个固定一级入口和底部安全区。
- `PhotoCard`：组合图片、加载占位、备注徽标与点击行为。
- `NoteCard`：组合缩略图、正文、时间、已编辑标识和更多操作。
- `UploadTaskGrid`：把上传任务状态映射到 Upload、Progress 和错误反馈。
- `PageState`：统一加载、空、错误、无权限和注销处理中状态。
- `NoteEditor`：统一新增、编辑、计数、失败保留和冲突处理。
- `DangerConfirm`：统一永久删除和注销的影响范围提示。

组合组件只承载业务组合与状态映射，必须透传底层组件可用属性和事件。

## 7. 动效与无障碍

- 页面跳转沿用微信原生转场。
- ActionSheet、Popup 使用 TDesign 默认 200–250ms 动效。
- 目标备注高亮持续约 1.5 秒，不闪烁。
- 所有图标按钮提供可读标签，点击热区不小于 44 × 44px。
- 上传进度允许平滑动画，但最终状态以服务端结果为准。

