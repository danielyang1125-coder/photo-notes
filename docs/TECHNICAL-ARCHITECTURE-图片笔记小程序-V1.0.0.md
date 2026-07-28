# TECHNICAL ARCHITECTURE — 图片笔记小程序 V1.0.0

> **文档状态**：技术设计稿  
> **文档类型**：技术架构  
> **前端技术**：微信小程序原生开发 + TDesign Miniprogram  
> **后端技术**：微信云开发（云函数 + 云数据库 + 云存储）  
> **需求基线**：[PRD-图片笔记小程序-V1.0.0.md](./PRD-图片笔记小程序-V1.0.0.md)
> **增量追溯**：[PRD-图片笔记小程序-V1.0.0-标签功能增量.md](./PRD-图片笔记小程序-V1.0.0-标签功能增量.md)（BR-029～BR-054）
> **设计基线**：[DESIGN-SYSTEM-图片笔记小程序-V1.0.0.md](./DESIGN-SYSTEM-图片笔记小程序-V1.0.0.md)
> **基线日期**：2026-07-28

---

## 0. 现有项目状态

当前工作区已包含一个微信云开发 QuickStart 模板脚手架（AppID: `wx536ce93aa8c43024`，基础库 `3.17.0`），需在现有框架上重构为图片笔记应用。

### 保留项

| 项 | 说明 |
|---|---|
| `project.config.json` | AppID `wx536ce93aa8c43024`，`miniprogramRoot`, `cloudfunctionRoot` |
| `project.private.config.json` | 基础库 `3.17.0`，项目名 `photo-notes` |
| `miniprogram/app.js` | 云开发初始化入口，需更新 `env` |
| `miniprogram/components/cloudTipModal/` | 可复用弹窗组件 |
| `cloudfunctions/` 目录结构 | 部署脚本 `uploadCloudFunction.sh` |
| `docs/` | PRD、设计系统、原型文档完备 |

### 需替换/清理

| 项 | 处理方式 |
|---|---|
| `miniprogram/pages/index/` | 重写为 PG-001 |
| `miniprogram/pages/example/` | 删除 |
| `cloudfunctions/quickstartFunctions/` | 删除 |
| `miniprogram/app.json` | 重写路由和 TabBar |
| `miniprogram/images/` | 替换为应用素材 |
| `README.md` | 替换为项目文档 |

### 需新建

| 项 | 说明 |
|---|---|
| TDesign 组件库 (`tdesign-miniprogram`) | npm 安装 + 构建 |
| 6 个页面 | photos, notes, preview, settings, deletion-status, tag-manager |
| 11 个自定义组件 | 基线 6 个组件 + tag-filter-bar、photo-tag-section、tag-picker、tag-manager-list、tag-name-editor |
| 7 个云函数 | user, photo, note, upload, account, tag, cleanup |
| 6 个数据库集合 | users, photos, notes, tags, photo_tags, deletion_tasks |
| 主题 CSS Tokens | `theme/tokens.wxss`（包含标签状态 Token） |

---

## 1. 技术选型总览

| 层级 | 技术选择 | 说明 |
|---|---|---|
| 前端框架 | 微信小程序原生 | WXML + WXSS + JS，无第三方框架 |
| UI 组件库 | TDesign Miniprogram | npm 安装，按页面局部注册 `usingComponents` |
| 后端运行时 | 微信云开发 · 云函数 | Node.js serverless |
| 数据库 | 微信云开发 · 云数据库 | MongoDB 兼容文档数据库 |
| 文件存储 | 微信云开发 · 云存储 | 底层腾讯云 COS，支持万象优图 CI 图片处理 |
| 定时任务 | 云函数 · 定时触发器 | 孤立对象清理、注销任务推进 |
| 图片处理 | 云存储内置 CI | 服务端拼接参数生成缩略图 URL，前端不拼接 |

---

## 2. 系统架构总览

```text
┌───────────────────────────────────────────────────────────────┐
│                      微信小程序客户端                           │
│  ┌───────────┐   ┌──────────────┐   ┌─────────────────────┐  │
│  │  Pages     │   │  Components   │   │  Services / Utils   │  │
│  │  PG-001~   │   │  upload-panel │   │  compress.js        │  │
│  │  PG-010    │   │  note-editor  │   │  exif.js            │  │
│  │            │   │  photo/tag    │   │  services/tags.js   │  │
│  │            │   │  components   │   │  validator.js       │  │
│  └───────────┘   └──────────────┘   └─────────────────────┘  │
│         │                │                    │               │
│         └────────────────┼────────────────────┘               │
│                          │ wx.cloud.callFunction()             │
└──────────────────────────┼────────────────────────────────────┘
                           │
┌──────────────────────────┼────────────────────────────────────┐
│                 微信云开发 · 云端                               │
│  ┌────────────────────────┐   ┌──────────────────┐            │
│  │   云函数 (Node.js)       │   │   定时触发器       │            │
│  │   user / photo / note   │   │   cleanup:        │            │
│  │   upload / account / tag│   │     孤立对象清理    │            │
│  │                         │   │     注销任务推进    │            │
│  │                         │   │     标签计数校正    │            │
│  └───────────┬─────────────┘   └──────────────────┘            │
│              │                                                  │
│  ┌───────────┴─────────────┐   ┌──────────────────┐            │
│  │    云数据库               │   │   云存储           │            │
│  │    users / photos / notes│   │   photos/          │            │
│  │    tags / photo_tags     │   │     {openid}/      │            │
│  │    deletion_tasks        │   │       *.jpg        │            │
│  └─────────────────────────┘   │   万象优图 CI 处理   │            │
│                                 └──────────────────┘            │
└────────────────────────────────────────────────────────────────┘
```

**核心交互**：
- 前端通过 `wx.cloud.callFunction({ name, data })` 调用云函数
- 云函数通过 `wx-server-sdk` 操作数据库和云存储
- 图片上传：本地压缩 → `wx.cloud.uploadFile()` → 云函数 `upload/confirm` 创建数据库记录
- 身份认证：云函数 `cloud.getWXContext().OPENID` 获取唯一标识，实现数据隔离
- 标签能力：`tag` 云函数统一处理标签 CRUD、单图增量关联和上传后批量关联
- 故障隔离：PG-002 的全部图片与快捷标签并行加载；标签请求失败只降级标签区，不阻断【全部】图片浏览

---

## 3. 前端架构设计

### 3.1 目录结构

```text
miniprogram/
├── pages/
│   ├── index/                     # PG-001 启动与身份建立
│   │   └── index.{wxml,wxss,js,json}
│   ├── photos/                    # PG-002 图片列表 (Tab 1)
│   │   └── photos.{wxml,wxss,js,json}
│   ├── notes/                     # PG-006 备注列表 (Tab 2)
│   │   └── notes.{wxml,wxss,js,json}
│   ├── preview/                   # PG-004 图片预览详情
│   │   └── preview.{wxml,wxss,js,json}
│   ├── settings/                  # PG-007 设置与隐私
│   │   └── settings.{wxml,wxss,js,json}
│   ├── deletion-status/           # PG-008 注销处理中
│   │   └── deletion-status.{wxml,wxss,js,json}
│   └── tag-manager/               # PG-009 标签管理（二级页）
│       └── tag-manager.{wxml,wxss,js,json}
│
├── components/
│   ├── upload-panel/              # PG-003 上传面板 (t-popup 浮层)
│   ├── note-editor/               # PG-005 备注编辑层 (t-popup 浮层)
│   ├── photo-card/                # 图片卡片（瀑布流单元）
│   ├── note-item/                 # 备注列表项
│   ├── page-state/                # 统一状态：加载/空/错误
│   ├── danger-confirm/            # 高风险确认组件
│   ├── tag-filter-bar/            # 全部/未分类/快捷标签与自适应入口
│   ├── photo-tag-section/         # PG-004 标签展示与维护入口
│   ├── tag-picker/                # PG-010 单图/批量共用标签选择层
│   ├── tag-manager-list/          # PG-009 标签列表与维护操作
│   └── tag-name-editor/           # 标签名称创建/重命名输入层
│
├── services/                      # 云函数调用封装
│   ├── auth.js                    # 登录/身份
│   ├── photos.js                  # 图片 CRUD
│   ├── notes.js                   # 备注 CRUD
│   ├── upload.js                  # 上传队列管理
│   ├── tags.js                    # 标签 CRUD、单图关联、批量关联
│   └── user.js                    # 用户信息/空间/注销
│
├── utils/
│   ├── compress.js                # Canvas 离屏压缩
│   ├── exif.js                    # EXIF 提取
│   ├── validator.js               # 校验（含 Unicode code point 计数）
│   ├── tag-normalizer.js          # 标签名称规范化（服务端同口径）
│   ├── constants.js               # 常量定义
│   └── util.js                    # 通用工具
│
├── theme/
│   └── tokens.wxss                # CSS 自定义属性（17 个颜色 Token）
│
├── app.js
├── app.json
├── app.wxss
└── sitemap.json
```

### 3.2 页面路由设计 (app.json)

```json
{
  "pages": [
    "pages/index/index",
    "pages/photos/photos",
    "pages/notes/notes",
    "pages/preview/preview",
    "pages/settings/settings",
    "pages/deletion-status/deletion-status",
    "pages/tag-manager/tag-manager"
  ],
  "tabBar": {
    "list": [
      { "pagePath": "pages/photos/photos", "text": "图片", "iconPath": "...", "selectedIconPath": "..." },
      { "pagePath": "pages/notes/notes", "text": "备注", "iconPath": "...", "selectedIconPath": "..." }
    ]
  },
  "window": {
    "backgroundColor": "#F3F3F3",
    "navigationStyle": "custom"
  }
}
```

**路由规则**：
- Tab 页：`wx.switchTab()`（photos ↔ notes）
- 二级页：`wx.navigateTo()`（preview, settings, deletion-status, tag-manager）
- PG-001 → PG-002：`wx.redirectTo()`（不保留启动页）
- PG-007 → PG-008：`wx.redirectTo()`（注销后不可返回）
- PG-002 → PG-009：`wx.navigateTo()`；PG-009 通过 `EventChannel` 回传标签并 `wx.navigateBack()`

### 3.3 页面形态说明（PG-003、PG-005 与 PG-010）

依据原型设计，PG-003、PG-005 和 PG-010 不作为独立路由，而是浮层组件嵌入父页面：

| 编号 | 名称 | 前端形态 | 载体 |
|---|---|---|---|
| PG-003 | 图片选择与上传面板 | `<upload-panel>` + `t-popup` 底部弹出 | PG-002 |
| PG-005 | 备注编辑层 | `<note-editor>` + `t-popup` 底部弹出 | PG-004 |
| PG-010 | 标签选择与创建层 | `<tag-picker>` + `t-popup` 底部弹出 | PG-003、PG-004 |

PG-002 的【＋新建标签】直接复用 `<tag-name-editor>`，创建成功后刷新快捷区、自动选中新标签并加载其空结果，不打开完整 TagPicker。

### 3.4 TDesign 组件分配

| 页面/组件 | TDesign 组件 | 用途 |
|---|---|---|
| PG-002 图片列表 | `t-navbar`, `t-image`, `t-badge`, `t-notice-bar`, `t-skeleton`, `t-tab-bar`, `t-scroll-view`, `t-tag`, `t-button` | 导航、图片流、空间预警、标签单行横向筛选、底部 Tab |
| PG-003 上传面板 | `t-popup`, `t-progress`, `t-dialog` | 底部弹出、进度条、离开确认 |
| PG-004 图片预览 | `t-navbar`, `t-image-viewer`, `t-action-sheet`, `t-empty`, `t-tag` | 导航、大图查看、操作菜单、完整标签展示、空态 |
| PG-005 备注编辑 | `t-popup`, `t-textarea`, `t-button`, `t-message` | 编辑层、文本输入、保存按钮、冲突提示 |
| PG-006 备注列表 | `t-navbar`, `t-cell`, `t-image`, `t-tag`, `t-action-sheet`, `t-tab-bar` | 导航、列表项、缩略图、排序标签、排序选择、底部Tab |
| PG-007 设置 | `t-cell-group`, `t-cell`, `t-progress`, `t-dialog`, `t-input` | 设置项、空间进度条、注销确认、文字输入 |
| PG-008 注销状态 | `t-result`, `t-loading`, `t-button` | 结果展示、加载态、联系客服 |
| PG-009 标签管理 | `t-navbar`, `t-cell`, `t-action-sheet`, `t-skeleton`, `t-empty` | 标签列表、筛选返回、重命名、删除 |
| PG-010 标签选择层 | `t-popup`, `t-checkbox`, `t-input`, `t-button`, `t-dialog` | 最多 5 个多选、新建标签、未保存离开确认 |
| PG-001 启动 | `t-loading`, `t-result`, `t-button` | 加载、错误结果、重试 |

**注册方式**：在每个页面的 `.json` 中通过 `usingComponents` 局部注册，禁止全局全量注册。

**标签视觉与无障碍约束**：
- 快捷筛选胶囊高 36px、实际热区不小于 44px；【全部】【未分类】固定在前，375px 视口横向滚动且隐藏滚动条。
- 快捷标签单项最大宽度 112px 并单行省略；图片详情标签允许换行并完整展示。
- 选中态同时使用品牌色背景、勾选图标和字重；达到 5 个后未选项置灰但保留可读文本。
- 使用 `--color-tag-bg`、`--color-tag-selected-bg`、`--color-disabled-bg`，不修改 TDesign 源码。

### 3.5 自定义业务组件

| 组件名 | 对应页面 | 职责 |
|---|---|---|
| `upload-panel` | PG-003 | 上传队列：N/20 计数、缩略图、状态、进度、重试；压缩触发、上传幂等控制；底部弹出+离开确认 |
| `note-editor` | PG-005 | 备注编辑：多行文本、字数 N/1000（超限变红）、保存冲突三选一处理（加载最新/继续提交/取消） |
| `photo-card` | — | 瀑布流卡片：缩略图 + 备注 badge + 点击跳转 |
| `note-item` | — | 备注列表项：72×72 缩略图 + 内容(3行省略) + 时间 + "已编辑"标签 |
| `page-state` | — | 统一状态：骨架屏/空态(插画+文案+CTA)/错误态(说明+重试) |
| `danger-confirm` | — | 高风险确认：不可恢复提示 + 影响范围 + 二次确认（禁止遮罩关闭） |
| `tag-filter-bar` | PG-002 | 固定【全部】【未分类】，按标签数切换【＋新建标签/管理/更多】，独立管理标签加载与错误态 |
| `photo-tag-section` | PG-004 | 完整展示 0～5 个标签及添加、编辑、加载失败重试入口 |
| `tag-picker` | PG-003/PG-004（PG-010） | 最近使用排序、多选计数、5 个上限、创建后自动选中（已满 5 个时只创建并提示）、失败保留和未保存关闭确认 |
| `tag-manager-list` | PG-009 | 标签名称、关联图片数、筛选返回及重命名/删除操作 |
| `tag-name-editor` | PG-002/PG-009/PG-010 | 1～12 code point 计数、非法字符/重名/保留名校验、创建与重命名 |

### 3.6 状态管理

**方案**：轻量全局数据 + 页面级管理，不引入第三方状态库。

```javascript
// app.js — 全局数据
globalData: {
  userInfo: {
    usedBytes: 0,
    limitBytes: 524288000,  // 500 MB
    status: 'ACTIVE'         // ACTIVE | DELETING | DELETED
  },
  spaceWarningShown: false,  // 本会话预警标记
  refreshPhotos: false,      // 跨页面刷新标记
  refreshNotes: false,
  refreshTags: false
}
```

PG-002 自身维护且不持久化：

```javascript
photoPageState: {
  filter: { scope: 'ALL', tagId: null }, // ALL | UNCATEGORIZED | TAG
  list: [],
  page: 1,
  hasMore: true,
  scrollTop: 0
}
```

**跨页面通信**：
- Tab 切换时 `onShow` 检测刷新标记；标签增删、单图维护和批量关联后分别刷新标签摘要或当前筛选结果。
- PG-009 使用 `EventChannel` 向打开它的 PG-002 回传 `{ tagId }`；PG-002 重置分页并应用 `TAG` 筛选。
- 从 PG-004 返回时保留 PG-002 的筛选、已加载列表和滚动位置；若当前为【未分类】且图片已被添加标签，`onShow` 按刷新标记重新拉取。
- 筛选状态不写入 Storage；页面实例销毁或小程序冷启动后固定恢复 `{ scope: 'ALL' }`。
- 客户端仅在服务端成功响应后提交展示状态；标签保存失败时 TagPicker/TagNameEditor 保持打开并保留未提交值。

### 3.7 图片处理流程

```
用户选择图片
    ↓
读取 EXIF 拍摄时间 → 有值: EXIF / 无值: UPLOAD_TIME
    ↓
校验格式 (JPG/JPEG/PNG) + 大小 (≤20MB) → 不通过: 标记失败
    ↓
Canvas 离屏压缩:
  · 最长边 ≤ 2560px, 保持宽高比
  · JPEG 初始质量 85%, 目标 ≤ 3MB
  · 不达标逐步降质量 (不低于约定最低值), 仍失败则标记无法处理
    ↓
上传队列 (并发 ≤3)
    ↓
wx.cloud.uploadFile() → cloudPath: photos/{openid_short}/{timestamp}_{random8}.jpg
    ↓
callFunction('upload', { type: 'confirm', taskId, fileId, ... })
→ 云函数创建 photo 记录 + $inc used_bytes
```

### 3.8 上传队列管理

```
┌─────────────────────────────────────────────┐
│  上传队列                                     │
│  ┌──────┐ ┌──────┐ ┌──────┐                 │
│  │上传中 │ │上传中 │ │上传中 │  ← 并发 3       │
│  └──────┘ └──────┘ └──────┘                 │
│  ┌──────┐ ┌──────┐ ┌──────┐ ...             │
│  │待上传 │ │待上传 │ │待上传 │  ← 排队         │
│  └──────┘ └──────┘ └──────┘                 │
│                                               │
│  成功 N 张  │  失败 M 张  │  进度 N+M/20       │
└─────────────────────────────────────────────┘
```

- 每个任务有唯一幂等标识 `{batchId}_{fileIndex}`
- 终态（成功/已取消）不可再操作
- 失败 → 待处理 → 重试
- 离开面板时：成功项保留，其余 → 已取消（引用 BR-025）
- `upload/confirm` 成功结果必须保存服务端返回的 `photoId`；批量标签只收集本批终态为成功的 `photoId`
- 全部任务结束且成功数 ≥1 时显示“为本批图片添加标签”；“完成”始终允许跳过标签步骤
- 批量标签失败不回退上传状态；TagPicker 保留选择，失败任务仍按原上传流程重试且不自动继承已提交标签

---

## 4. 后端架构设计

### 4.1 云函数清单（type 路由模式）

采用 **多函数 + type 路由**：每个业务域一个云函数，通过 `event.type` 路由到具体 handler。

| 云函数 | type 值 | 职责 |
|---|---|---|
| `user` | `login`, `getStatus` | 登录/身份建立、用户状态查询 |
| `photo` | `list`, `detail`, `delete` | 图片列表(含缩略图URL)、详情+备注、级联删除 |
| `note` | `add`, `update`, `delete`, `list` | 备注 CRUD（含乐观并发控制、排序） |
| `upload` | `confirm` | 上传确认：幂等创建图片记录 |
| `account` | `requestDeletion`, `getDeletionStatus` | 注销申请与状态查询 |
| `tag` | `list`, `create`, `rename`, `delete`, `getPhotoTags`, `updatePhotoTags`, `batchAddPhotoTags` | 标签 CRUD、单图增量关联、上传后批量关联 |
| `cleanup` | (定时触发器) | 孤立对象清理、注销任务推进、标签派生计数校正 |

`tag` 云函数统一承载标签名称规范化、归属校验和关联事务；`photo/delete`、`account`、`cleanup` 按同一关联清理契约维护计数。客户端不得直接读写 `tags` 或 `photo_tags` 集合。

### 4.2 云函数路由模板

```javascript
// cloudfunctions/photo/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function getOpenId() { return cloud.getWXContext().OPENID }

async function checkUserActive(openid) {
  const user = await db.collection('users').doc(openid).get()
  if (!user.data || user.data.status !== 'ACTIVE') {
    throw { code: 'USER_NOT_ACTIVE', message: '账号状态异常' }
  }
  return user.data
}

exports.main = async (event, context) => {
  const openid = getOpenId()
  if (!openid) return { code: 'AUTH_FAILED', message: '身份验证失败' }
  try {
    await checkUserActive(openid)
    switch (event.type) {
      case 'list':   return handleList(openid, event)
      case 'detail': return handleDetail(openid, event)
      case 'delete': return handleDelete(openid, event)
      default:       return { code: 'UNKNOWN_TYPE', message: '未知操作类型' }
    }
  } catch (err) {
    console.error('[photo]', err)
    return { code: err.code || 'INTERNAL_ERROR', message: err.message || '服务异常' }
  }
}
```

### 4.3 数据库设计

#### `users` 集合

```javascript
{
  _id: "oA_...",                   // = _openid，天然唯一
  _openid: "oA_...",
  status: "ACTIVE",                // ACTIVE | DELETING | DELETED
  used_bytes: 0,
  limit_bytes: 524288000,          // 500 MB
  created_at: Date,
  updated_at: Date
}
// 索引：{ _openid: 1 } 唯一索引, { status: 1 }
```

#### `photos` 集合

```javascript
{
  _id: ObjectId,
  _openid: "oA_...",
  file_id: "cloud://env-id.xxx",  // 云存储 fileID
  task_id: "batch_file03",        // 幂等键
  file_size: 1500000,             // 压缩后字节
  width: 2560, height: 1920,
  format: "JPEG",                 // JPG | JPEG | PNG
  shoot_time: Date,
  time_source: "EXIF",            // EXIF | UPLOAD_TIME
  upload_time: Date,
  note_count: 0,
  tag_count: 0,                   // 派生计数；0 即符合【未分类】查询
  created_at: Date
}
// 索引：
// { _openid: 1, upload_time: -1 }  — 列表查询
// { _openid: 1, tag_count: 1, upload_time: -1 } — 未分类分页
// { _openid: 1, shoot_time: -1 }   — 备注排序用
```

`tag_count` 是由有效 `photo_tags` 关系派生的查询字段，不接受客户端传值。新增图片固定初始化为 `0`；关联事务仅在关系实际新增或移除时增减，并保证范围为 0～5。

#### `notes` 集合

```javascript
{
  _id: ObjectId,
  _openid: "oA_...",
  photo_id: ObjectId,
  content: "string",               // 1~1000 Unicode code point
  content_code_point_count: 150,   // 服务端计数值
  photo_thumbnail_url: "string",   // 冗余：加速列表展示
  photo_shoot_time: Date,          // 冗余：支持拍摄时间排序
  created_at: Date,
  updated_at: Date                 // 乐观并发锁版本号
}
// 索引：
// { photo_id: 1 }                       — 图片详情查询备注
// { _openid: 1, created_at: -1 }       — 备注列表（默认排序）
// { _openid: 1, photo_shoot_time: -1 } — 按拍摄时间排序
```

**设计要点**：`photo_thumbnail_url` 和 `photo_shoot_time` 为冗余字段，创建备注时从 photo 拷贝。避免备注列表按拍摄时间排序时需要 `$lookup` 聚合查询。

#### `tags` 集合

```javascript
{
  _id: ObjectId,
  _openid: "oA_...",
  name: "产品设计",                 // 裁剪后的原始展示名称
  normalized_name: "产品设计",      // NFC + 拉丁字母大小写归一，仅用于唯一性
  photo_count: 0,                  // 有效 photo_tags 数量，非负
  last_used_at: Date,              // 成功筛选或实际新增关联时更新
  created_at: Date,
  updated_at: Date
}
// 索引：
// { _openid: 1, normalized_name: 1 } UNIQUE — 用户内规范化名称唯一
// { _openid: 1, last_used_at: -1, updated_at: -1, created_at: -1 } — 固定排序
```

创建时 `last_used_at = created_at`。重命名不改变关联关系或 `photo_count`；删除标签仅删除标签及其关系，不删除图片或备注。

#### `photo_tags` 集合

```javascript
{
  _id: ObjectId,
  _openid: "oA_...",
  photo_id: ObjectId,
  tag_id: ObjectId,
  photo_upload_time: Date,         // 从 photo 冗余，用于标签结果分页
  created_at: Date
}
// 索引：
// { _openid: 1, photo_id: 1, tag_id: 1 } UNIQUE — 防止重复关联
// { _openid: 1, tag_id: 1, photo_upload_time: -1 } — 按标签分页
// { _openid: 1, photo_id: 1 } — 单图标签、图片删除
```

`photo_tags` 是图片与标签关系的权威数据。`tags.photo_count`、`photos.tag_count` 和 `photo_upload_time` 均为查询冗余：只允许服务端事务维护，并由定时校正任务复核。

#### `deletion_tasks` 集合

```javascript
{
  _id: ObjectId,
  _openid: "oA_...",
  status: "PENDING",               // PENDING | PROCESSING | RETRYING | COMPLETED
  failed_stage: "string",
  retry_count: 0,
  applied_at: Date,
  completed_at: Date
}
// 索引：{ _openid: 1, status: 1 }
```

#### 事务与一致性边界

- CloudBase 文档型数据库通过服务端 Node SDK 提供 ACID 事务；标签写操作只在云函数内执行。参考：[事务操作](https://docs.cloudbase.net/database/transaction)。
- `tags(_openid, normalized_name)` 与 `photo_tags(_openid, photo_id, tag_id)` 使用唯一索引作为并发最终防线。参考：[索引管理](https://docs.cloudbase.net/database/data-index)。
- 创建/重命名标签：校验、唯一性写入和返回摘要处于同一事务；捕获唯一键冲突并映射为 `TAG_NAME_DUPLICATED`。
- 单图关联：锁定本人图片及涉及标签，计算集合差异；只有实际新增/移除的关系才更新双方计数。事务冲突由 SDK 重试，唯一键冲突按已存在关系处理。
- 标签删除：在服务端事务中删除本人标签及全部关系，并按受影响图片实际移除数递减 `photos.tag_count`；重复删除返回成功。
- 图片删除：云存储对象删除成功后，在数据库事务中删除图片、备注、全部关系，按实际关系递减相关 `tags.photo_count`，并原子扣减空间用量。
- 批量添加：最多 20 张图片 × 5 个标签，以“每张图片一个事务”执行集合合并；某张图片失效或合并后超限不回滚其他图片。
- 请求重放依靠“唯一关系 + 读取实际差异后更新计数”保证状态幂等；`requestId` 用于链路追踪和识别重复调用，不记录标签名称。
- 每日 `cleanup` 重新聚合有效关系，修正 `tags.photo_count` 与 `photos.tag_count`；修正前后值仅写安全审计日志。

#### 上线前数据准备

V1.0.0 为上线前增量，不设计线上迁移流程。建立未分类索引前，对开发和测试环境已有 `photos` 一次性回填 `tag_count: 0`；回填完成后抽样确认所有既有图片均可在【未分类】查询中返回。

### 4.4 云存储设计

```
cloud://env-id/
└── photos/
    └── {openid_short}/
        └── {timestamp}_{random8}.jpg
```

**图片处理策略**（万象优图 CI）：
- **缩略图**：临时 URL + `?imageMogr2/thumbnail/!200x200r`（云函数拼接）
- **预览图**：临时 URL 原尺寸 或 + `?imageMogr2/thumbnail/!1280x1280r`
- **约束**：前端不拼接任何处理参数；URL 在云函数返回前生成

### 4.5 定时触发器

```json
// cloudfunctions/cleanup/config.json
{
  "triggers": [{
    "name": "dailyCleanup",
    "type": "timer",
    "config": "0 0 3 * * * *"
  }]
}
```
清理内容：孤立云存储对象 + DELETING 用户重试推进 + 标签/图片派生计数核对与校正。

---

## 5. 安全设计

### 5.1 身份与数据隔离

```javascript
// 所有云函数统一模式
const { OPENID } = cloud.getWXContext()
// 不信任前端传入的 userId
const data = await db.collection('photos').where({ _openid: OPENID }).get()
```

**原则**：
- 云函数从 `getWXContext().OPENID` 获取身份
- 所有查询 `.where({ _openid: OPENID })` 为第一过滤条件
- 标签、图片和关联的删改操作先分别校验资源所有权，并验证三者 `_openid` 一致
- 不以“查不到”和“属于他人”之间的差异向客户端泄露标签名称、存在性或关联数量
- `DELETING` / `DELETED` 状态用户的所有业务接口直接拒绝

### 5.2 图片访问控制

- 使用 `cloud.getTempFileURL()` 生成临时访问 URL（不暴露永久公开 URL）
- 云函数校验身份后返回临时链接
- 日志不记录完整 fileID、临时 URL、标签名称、图片内容或备注内容

### 5.3 乐观并发控制

```javascript
// note/update 云函数
const result = await db.collection('notes')
  .where({ _id: noteId, _openid: OPENID, updated_at: clientUpdatedAt })
  .update({ data: { content, updated_at: db.serverDate() } })

if (result.stats.updated === 0) {
  return { code: 'CONFLICT', message: '内容已在其他设备更新' }
}
```

### 5.4 注销安全

- 文字二次确认：完全匹配 "确认注销"
- 服务端 `users.status` 为权威状态
- `DELETING` → 所有业务接口拒绝
- 级联清理顺序：图片对象 → 备注 → `photo_tags` → `tags` → 图片记录 → 空间及用户数据 → 解绑微信
- 各阶段按 `_openid` 分批、幂等执行并记录 `failed_stage`；任一阶段失败保持 `DELETING`，由 `cleanup` 自动重试
- 仅在标签、关联及其他业务数据全部清理成功后解除微信绑定

### 5.5 标签名称与内容安全

服务端统一执行以下顺序，客户端仅复用同口径做即时提示：

1. 去除首尾 Unicode `White_Space`。
2. 拒绝换行、回车、制表符及其他 Unicode 控制字符。
3. 按 Unicode code point 校验长度为 1～12。
4. 拒绝保留名称“全部”“未分类”。
5. 对裁剪结果执行 NFC，再对 Unicode Latin Script 字符做大小写归一，生成 `normalized_name`。
6. 以用户 ID + `normalized_name` 唯一索引完成最终并发校验，展示仍使用裁剪后的 `name`。

---

## 6. 接口设计

### 6.1 通用响应格式

```
成功: { code: "SUCCESS", data: {...}, message?: "string" }
错误: { code: "ERROR_CODE", message: "用户可读错误信息" }
```

### 6.2 错误码

| 错误码 | 说明 | 标签相关前端处理 |
|---|---|---|
| `SUCCESS` | 操作成功 | 提交服务端返回数据 |
| `AUTH_FAILED` | 身份验证失败 | 重新建立身份 |
| `FORBIDDEN` / `USER_NOT_ACTIVE` | 资源无权访问 / 账号状态异常 | 不展示资源信息；进入受限流程 |
| `NOT_FOUND` | 图片/备注不存在或已删除 | 刷新原页面 |
| `CONFLICT` | 备注版本冲突（乐观锁） | 进入备注冲突处理 |
| `VALIDATION_ERROR` | 通用输入校验失败 | 保留输入并显示字段错误 |
| `SPACE_EXCEEDED` | 空间不足 | 保留上传任务并提示空间不足 |
| `TAG_NOT_FOUND` | 标签不存在或已删除 | 刷新标签；筛选场景切换到【全部】 |
| `TAG_ACCESS_DENIED` | 标签不属于当前用户 | 拒绝操作且不泄露资源信息 |
| `TAG_NAME_INVALID` | 标签长度、字符或保留名称不合法 | 保留名称并显示对应字段错误 |
| `TAG_NAME_DUPLICATED` | 本人范围规范化名称重复 | 提示使用已有标签 |
| `TAG_LIMIT_REACHED` | 用户已有 100 个标签 | 禁用创建入口并刷新标签总数 |
| `PHOTO_TAG_LIMIT_REACHED` | 单图集合合并后超过 5 个 | 保留选择并提示上限 |
| `PHOTO_NOT_FOUND` | 图片不存在或已删除 | 关闭关联层并刷新/返回图片列表 |
| `DELETION_ALREADY_PENDING` | 已有未完成注销任务 | 进入注销状态页 |
| `INTERNAL_ERROR` | 服务内部错误 | 不提前改变权威结果，保留输入并允许重试 |

### 6.3 核心接口

#### user 云函数

```
login:       IN { type:"login" }  →  OUT { user:{ status,used_bytes,limit_bytes }, isNewUser }
getStatus:   IN { type:"getStatus" }  →  OUT { status }
```

#### photo 云函数

```
list:    IN { type:"list", scope:"ALL"|"UNCATEGORIZED"|"TAG", tagId?, page, pageSize:20 }
         → OUT { list:[ {_id,thumbnail_url,width,height,note_count,shoot_time,
                        time_source,upload_time} ], total, hasMore }
detail:  IN { type:"detail", photoId }
         → OUT { photo:{...compression_url...}, notes:[...], tags:[TagSummary] }
delete:  IN { type:"delete", photoId }
         → OUT { deletedNotesCount, removedTagRelationCount }
```

约束：
- `ALL` 不接收 `tagId`；`UNCATEGORIZED` 查询 `photos.tag_count = 0`；`TAG` 必须传本人有效 `tagId`。
- `TAG` 先按 `photo_tags(_openid, tag_id, photo_upload_time desc)` 分页取得图片 ID，再批量读取图片卡片字段并按关联结果恢复顺序。
- 图片卡片结构不增加标签名称；`detail.tags` 最多 5 个。

#### note 云函数

```
add:     IN { type:"add", photoId, content }  →  OUT { note:{ _id,... } }
update:  IN { type:"update", noteId, content, updatedAt }  →  OUT { note } | CONFLICT
delete:  IN { type:"delete", noteId }  →  OUT { photoId, newNoteCount }
list:    IN { type:"list", page, pageSize, sortBy:"created_at"|"photo_shoot_time",
              sortOrder:"desc"|"asc" }  →  OUT { list, total, hasMore }
```

#### upload 云函数

```
confirm: IN { type:"confirm", fileId, size, width, height, format,
              shootTime, timeSource, taskId }  →  OUT { photo:{ _id:photoId,... } }
         幂等：taskId 已存在时直接返回已有记录
```

PG-003 只使用 `confirm` 返回的 `photoId` 构造批量标签请求，不使用本地任务索引、临时路径或未入库任务。

#### tag 云函数

```text
TagSummary = {
  _id, name, photo_count, last_used_at, created_at, updated_at
}

list:
  IN  { type:"list", mode:"QUICK"|"ALL" }
  OUT { list:[TagSummary], total }
  规则：QUICK 最多返回最近使用前 5 个，ALL 最多 100 个；固定按
        last_used_at、updated_at、created_at 降序。

create:
  IN  { type:"create", name }
  OUT { tag:TagSummary }

rename:
  IN  { type:"rename", tagId, name }
  OUT { tag:TagSummary }

delete:
  IN  { type:"delete", tagId }
  OUT { deleted:true, removedRelationCount }
  规则：重复删除按成功处理，不删除图片或备注。

getPhotoTags:
  IN  { type:"getPhotoTags", photoId }
  OUT { tags:[TagSummary] }

updatePhotoTags:
  IN  { type:"updatePhotoTags", photoId, addTagIds:[], removeTagIds:[], requestId }
  OUT { tags:[TagSummary] }
  规则：增量更新；两个数组分别去重且不得交叉，合并后 0～5 个。

batchAddPhotoTags:
  IN  { type:"batchAddPhotoTags", photoIds:[], tagIds:[], requestId }
  OUT { successCount, invalidCount, limitExceededCount, tags:[TagSummary] }
  规则：photoIds 为 1～20 个、tagIds 为 1～5 个；集合合并并按图片独立提交；
        任一 tagId 失效或越权时整次拒绝且不处理图片。
```

`requestId` 由客户端为一次用户提交生成，重试必须复用；服务端校验非空和长度，只记录不可逆摘要用于链路追踪。关系唯一索引与基于实际集合差异的计数更新共同保证重复请求不产生重复关系或重复计数。

#### account 云函数

```
requestDeletion:    IN { type:"requestDeletion", confirmText:"确认注销" }  →  OUT { taskId, status }
getDeletionStatus:  IN { type:"getDeletionStatus" }  →  OUT { status, retryCount }
```

注销任务的内部阶段增加 `PHOTO_TAGS` 与 `TAGS`；任一标签清理失败均不得返回 `COMPLETED`。

---

## 7. 关键数据流

### 7.1 登录与身份建立

```
客户端                              云函数 user                 数据库
  wx.login() → code
  callFunction('user',{type:'login'})
                                     getWXContext().OPENID
                                     users.doc(openid).get()  → 查询
                                     ← 新用户: insert / 已有: check status
  ← { status, user }
  判断路由: ACTIVE→PG-002 / DELETING→PG-008
```

### 7.2 图片上传完整流程

```
客户端
  选择图片 → 读 EXIF → 校验 → Canvas 压缩
  wx.cloud.uploadFile()  →  云存储返回 fileID
  callFunction('upload', { type:'confirm', fileId, size, ..., taskId })
    云函数 upload:
      校验 _openid
      检查空间 used_bytes + size ≤ limit_bytes
      幂等检查 taskId
      photos.insert({...tag_count:0})
      users.update({ $inc: { used_bytes: size } })
      ← 返回含 photoId 的 photo 记录
```

### 7.3 备注冲突处理

```
客户端 A (updated_at: T1)                   服务端                 客户端 B
  修改内容...                                                 修改内容...
  提交 { updatedAt: T1 }                                       提交 { updatedAt: T1 }
    → 通过 (T1 =  DB)  ← DB: T1                                → CONFLICT (T1 ≠ T2)
    ← 返回新 T2  DB → T2
                                                               ← CONFLICT + 当前内容
                                                               展示三选项:
                                                               [加载最新]→确认弃本地→拉取
                                                               [继续提交]→确认覆盖→用T2提交
                                                               [取消]→关闭编辑层
```

### 7.4 图片首页与标签并行加载

```text
PG-002 onLoad
  ├─ photo/list { scope:"ALL", page:1, pageSize:20 }
  │    └─ 成功即展示全部图片；不等待标签接口
  └─ tag/list { mode:"QUICK" }
       ├─ 成功：依据 total=0 / 1～5 / 6～100 渲染自适应入口
       └─ 失败：保留【全部】【未分类】，显示轻量错误与重试
```

标签总数返回前不提前显示【＋新建标签/管理/更多】。下拉刷新并行刷新标签、标签计数和当前图片范围；其中一项失败不清空另一项成功结果。

### 7.5 单标签与未分类筛选

```text
点击筛选项 → 更新选中态 → 清空图片分页 → photo/list
  ALL:
    photos where {_openid} order by upload_time desc
  UNCATEGORIZED:
    photos where {_openid, tag_count:0} order by upload_time desc
  TAG:
    1. 校验 tag {_id:tagId,_openid}
    2. photo_tags 按 tag_id + photo_upload_time 分页取 photoId
    3. 批量读取本人 photos，按关联页顺序恢复卡片列表
    4. 更新 tag.last_used_at；更新成功后才返回筛选成功
```

- `TAG` 不存在或不属于本人时不返回任何图片信息；前端收到 `TAG_NOT_FOUND` 后刷新快捷区并切换到【全部】。
- 筛选失败保留当前选中项并显示列表错误态；重试复用相同 `scope/tagId/page`。
- 标签结果分页不在客户端对全部图片做筛选，也不在图片卡片中返回标签名称。

### 7.6 单图增量标签保存

```text
PG-004 → tag/getPhotoTags + tag/list(ALL) → 打开 TagPicker
用户编辑 → 计算 initial 与 selected 集合差异
  → updatePhotoTags {photoId,addTagIds,removeTagIds,requestId}
    → 事务校验用户/图片/标签
    → 去除无效重复操作，计算合并后数量
    → 新增/删除 photo_tags
    → 按实际差异更新 photo.tag_count、tag.photo_count、tag.last_used_at
  ← 最新 tags
成功：关闭层并刷新详情；失败：保持层与选择不变
```

部分标签已在其他设备删除时返回 `TAG_NOT_FOUND` 及失效标签标识，前端刷新可选列表、保留其余选择并要求用户重新确认；图片失效则关闭操作层并返回图片列表。

### 7.7 上传后批量添加标签

```text
上传任务全部结束
  → 从 confirm 成功结果收集 1～20 个 photoId
  → TagPicker 默认不选标签
  → batchAddPhotoTags {photoIds,tagIds,requestId}
    → 校验本人标签
    → 对每张图片独立事务执行 union(existingTagIds, tagIds)
       ├─ 有效且 ≤5：写入实际缺少关系并更新计数
       ├─ 图片失效：invalidCount +1
       └─ 合并后 >5：limitExceededCount +1
  ← successCount / invalidCount / limitExceededCount / tags
```

部分失败不回滚其他图片。成功数指请求后已包含所选标签的有效图片数，包括本来已具备全部所选标签的幂等命中图片；重复提交不会重复增加关系或计数。

### 7.8 标签删除

```text
PG-009 二次确认（显示服务端 photo_count）
  → tag/delete {tagId}
    → 事务按 {_openid,tag_id} 读取实际关系
    → 删除关系；逐图递减 tag_count
    → 删除 tag
  ← removedRelationCount
成功：刷新标签列表和当前图片范围
```

重复删除按成功处理。事务失败不返回成功，客户端不提前移除标签；成功后原本仅关联该标签的图片因 `tag_count=0` 自动进入【未分类】。

---

## 8. 性能优化

| 策略 | 说明 |
|---|---|
| 缩略图 200px | 列表加载 `thumbnail_url`（云函数拼接 CI 参数），不加载 2560px 预览图 |
| 骨架屏 | 数据请求时即时展示，缩略图渐进加载 |
| 数据库索引 | 所有查询场景均有复合索引覆盖 |
| 标签并行加载 | PG-002 的 ALL 图片和 QUICK 标签并行请求，标签故障不增加核心图片流等待时间 |
| 标签分页 | 先从 `photo_tags` 索引取得 20 个有序图片 ID，再批量取卡片字段并恢复顺序 |
| 未分类索引 | 使用 `photos.tag_count = 0` 及复合索引，避免全表反连接或前端本地筛选 |
| 冗余字段 | `notes` 冗余图片摘要；`photo_tags` 冗余上传时间；标签/图片冗余关系计数 |
| 原子更新 | `note_count`、`photo_count`、`tag_count` 只按实际关系差异原子增减 |
| 并发控制 | 上传队列并发 ≤3，压缩异步执行不阻塞 UI |

### 8.1 标签性能目标

| 场景 | 指标 | 测量边界 |
|---|---:|---|
| PG-002 快捷标签 | P95 ≤ 800ms | 云函数收到请求至返回最近使用 5 个标签 |
| PG-009/PG-010 全部标签 | P95 ≤ 1s | 100 个标签以内完整列表 |
| 标签筛选图片首屏 | P95 ≤ 2s | 20 张卡片数据，不含缩略图下载 |
| 单图标签保存 | P95 ≤ 1s | 0～5 个标签增量事务 |
| 批量标签保存 | P95 ≤ 2s | 20 张图片 × 5 个标签 |

标签能力不得使图片列表首屏 P95 ≤ 3s 的基线目标失效。

---

## 9. 成本优化

| 策略 | 说明 |
|---|---|
| 只存压缩图 | 不上传原图 |
| 动态缩略图 | CI 动态生成，不额外存储缩略图副本 |
| 定时清理 | 移除孤立对象 |
| 复用既有定时函数 | 计数校正并入 `cleanup`，不新增独立调度服务 |
| 分页 20 | 控制单次查询数据量 |
| 500MB/人 | 服务端可配配额 |
| 无搜索基础设施 | 不建设标签全文索引、搜索服务、AI/OCR 或标签管理后台 |

---

## 10. 关键实现细节

### 10.1 Unicode Code Point 计数（前后端同一口径）

```javascript
function countCodePoints(str) {
  const trimmed = str.replace(/^[\s﻿\xA0]+|[\s﻿\xA0]+$/g, '')
  return [...trimmed].length  // 正确处理 surrogate pair 和组合 Emoji
}
```

### 10.2 上传幂等性

```javascript
// 客户端生成: taskId = `${batchId}_${fileIndex}`
// 服务端: 检查 taskId 是否已存在 → 存在则直接返回已有记录
```

### 10.3 空间用量原子更新

```javascript
// 使用 $inc 而非 read-modify-write，防止并发丢失
await db.collection('users').doc(openid).update({ data: { used_bytes: _.inc(size) } })
```

### 10.4 标签名称规范化

```javascript
function normalizeTagName(input) {
  const name = trimUnicodeWhiteSpace(input)
  if (containsUnicodeControl(name)) throw tagNameInvalid()
  if ([...name].length < 1 || [...name].length > 12) throw tagNameInvalid()
  if (name === '全部' || name === '未分类') throw tagNameInvalid()

  const nfc = name.normalize('NFC')
  const normalizedName = lowerCaseLatinScript(nfc)
  return { name, normalizedName }
}
```

- 前后端共享测试向量，但服务端实现为权威。
- 内部普通空格保留；展示 `name` 不做全量小写。
- 唯一性必须由 `(_openid, normalized_name)` 唯一索引兜底，禁止仅以“先查询再插入”保证并发唯一。

### 10.5 标签关联幂等与计数

```text
desired = union(currentTagIds - validRemoveTagIds, validAddTagIds)
toInsert = desired - currentTagIds
toDelete = currentTagIds - desired

只对 toInsert/toDelete 写关系并更新计数；
空差异直接返回当前标签摘要，不执行 $inc。
```

- `photo_tags` 唯一索引确保同一图片与标签只有一条关系。
- `photos.tag_count` 的事务后值必须在 0～5；`tags.photo_count` 不得为负。
- 批量请求按图片分别应用同一算法，因此重复回调、网络重试和已有关系均不会重复计数。

### 10.6 标签派生计数校正

每日 `cleanup` 按 `_openid/photo_id/tag_id` 聚合有效 `photo_tags`：

1. 与 `photos.tag_count`、`tags.photo_count` 比较。
2. 仅修正不一致的文档并记录对象类型、不可逆 ID 摘要、修正前后计数和执行结果。
3. 孤立关系直接删除；不根据孤立关系恢复已删除图片或标签。
4. 单次任务按分页批处理，失败游标由下一次定时任务继续。

### 10.7 可观测性与隐私

统一事件字段：

```text
{ event, result, errorCode?, durationMs, countBucket?, requestIdHash?, timestamp }
```

至少覆盖标签创建/重命名/删除、单图增删、批量入口曝光/使用/跳过、三类筛选、上限触发、级联清理及计数校正。禁止记录标签名称、原始标签 ID、图片/备注内容、完整 fileID、私有 URL 或可逆用户内容映射。

---

## 11. 开发时序建议

| 阶段 | 内容 | 交付物 |
|---|---|---|
| S1 基础设施 | 项目重构、页面路由、user 云函数、TDesign 引入构建 | 登录流程跑通 |
| S2 上传核心 | photo(list/detail)、upload(confirm)、EXIF+压缩+上传队列；新图片初始化 `tag_count=0` | 单图上传成功并返回 photoId |
| S3 图片浏览 | PG-002 瀑布流、PG-004 预览、photo(delete) | 图片浏览+删除 |
| S4 标签基础 | `tags/photo_tags`、索引、规范化 helper、tag CRUD、PG-009 | 标签隔离、唯一性和维护流程 |
| S5 标签关联 | 单图增量事务、TagPicker、PhotoTagSection、上传后批量关联 | F-018/F-019 跑通 |
| S6 标签筛选 | ALL/UNCATEGORIZED/TAG 查询、TagFilterBar、会话恢复、计数校正 | F-016 与三类分页跑通 |
| S7 备注核心 | note CRUD、PG-005 编辑器、PG-006 排序与反向定位 | 备注双向浏览 |
| S8 设置与空间 | 空间查询、PG-007、空间预警 | 数据管理 |
| S9 注销与清理 | account、PG-008、关联清理、计数校正和失败重试 | 合规完成 |
| S10 打磨发布 | 骨架屏、空/错态、埋点、性能/安全/真机测试 | 发布就绪 |

---

## 12. 待确认事项

1. **云开发环境 ID**：环境归属与配额
2. **Node.js 运行时版本**：云函数建议 Node.js 18
3. **TDesign 版本锁定**：建议 `~` 锁定 Minor 版本
4. **图片存储地域**：COS 存储桶地域选择
5. **定时触发器配额**：确认免费额度是否足够每日一次

标签架构的三项原待确认技术决策已锁定：

- 计数一致性：关系事务增量维护 + `cleanup` 聚合校正。
- 并发唯一性：用户+规范化名称、用户+图片+标签唯一索引。
- 未分类性能：`photos.tag_count=0` 复合索引查询。

---

## 13. 验证计划

| 验证项 | 方法 |
|---|---|
| 目录结构完整性 | 确认文件创建后可构建 |
| 数据库索引覆盖 | 云开发控制台验证索引 |
| 身份隔离 | 不同账号数据互不可见 |
| 图片压缩质量 | 多种样张真机测试 2560px 压缩效果 |
| 上传并发 ≤3 | 20 张批量上传抓包观察 |
| 备注冲突 | 双设备并发修改验证乐观锁 |
| 缩略图性能 | 网络抓包确认仅加载 200px thumbnail_url |
| 快捷入口边界 | 验证 0/1/5/6/100 个标签对应新建/管理/更多形态 |
| 标签名称 | 验证 0/1/12/13 code point、Emoji、Unicode 空白、控制字符、NFC、拉丁大小写、保留名称 |
| 标签隔离 | 用户 B 使用用户 A 的 tagId/photoId 调用全部标签接口均被拒绝且不泄露信息 |
| 三类图片分页 | ALL/UNCATEGORIZED/TAG 每页 20 张，上传时间降序，无重复、遗漏或前端本地筛选 |
| 并发唯一性 | 并发创建规范化同名标签只能成功一个 |
| 单图边界 | 验证 0～5 个标签、尝试第 6 个、移除最后标签后进入未分类 |
| 关联幂等 | 重放单图与批量 requestId，关系及双方计数不重复 |
| 批量部分结果 | 20×5、部分图片失效、部分图片超限时分别核对三类计数且成功图片不回滚 |
| 标签删除 | 删除标签及关系但保留图片/备注，相关图片 tag_count 与未分类结果正确 |
| 图片删除 | 删除图片、备注及关系，保留标签并正确递减 photo_count |
| 注销级联 | 标签及关系清理失败时保持 DELETING，重试完成后才解绑 |
| 故障隔离 | tag/list 故障时 ALL 图片正常展示，选择层保存失败时保留未提交值 |
| 标签性能 | QUICK ≤800ms、ALL 标签 ≤1s、筛选 ≤2s、单图 ≤1s、20×5 批量 ≤2s（P95） |
| 日志隐私 | 抽查日志与埋点不含标签名称、原始标签 ID、用户内容和私有 URL |
| 数据准备 | 开发/测试旧图片回填 tag_count=0 后再建立未分类索引 |

### 13.1 标签需求追溯

| 需求/验收范围 | 架构落点 |
|---|---|
| BR-029～BR-031、AC-057～AC-059、AC-067～AC-068 | 服务端归属校验、`photo_tags` 唯一索引、单图 0～5 校验与增量事务 |
| BR-032～BR-038、AC-050～AC-056 | 统一名称规范化、用户内唯一索引、TagNameEditor、标签/单图数量上限 |
| BR-039～BR-043、AC-044～AC-049、AC-074～AC-075 | 最近使用排序、TagFilterBar 自适应入口、ALL/UNCATEGORIZED/TAG 查询和会话态 |
| BR-044～BR-048、BR-054、AC-060～AC-061、AC-068～AC-070、AC-072 | 重命名保持关系、标签/图片/注销级联、关系与计数幂等、定时校正 |
| BR-049～BR-051、AC-062～AC-065、AC-073 | 成功 photoId 来源、每图独立批量事务、失败保留选择和未保存关闭确认 |
| BR-052～BR-053、AC-066、AC-071 | 服务端权威刷新、标签失效回到全部、标签故障与全部图片隔离 |

文档评审时按上表逐组核对 AC-044～AC-075；任一验收项缺少明确接口、状态处理或验证方法时，不进入实现阶段。
