# TECHNICAL ARCHITECTURE — 图片笔记小程序 V1.0.0

> **文档状态**：技术设计稿  
> **文档类型**：技术架构  
> **前端技术**：微信小程序原生开发 + TDesign Miniprogram  
> **后端技术**：微信云开发（云函数 + 云数据库 + 云存储）  
> **基线日期**：2026-07-27  

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
| 5 个页面 | photos, notes, preview, settings, deletion-status |
| 6 个自定义组件 | upload-panel, note-editor, photo-card, note-item, page-state, danger-confirm |
| 7 个云函数 | user, photo, note, upload, account, cleanup |
| 4 个数据库集合 | users, photos, notes, deletion_tasks |
| 主题 CSS Tokens | `theme/tokens.wxss` |

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
│  │  PG-008    │   │  note-editor  │   │  exif.js            │  │
│  │            │   │  photo-card   │   │  upload-queue.js    │  │
│  │            │   │  note-item    │   │  validator.js       │  │
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
│  │   upload / account      │   │     孤立对象清理    │            │
│  │                         │   │     注销任务推进    │            │
│  └───────────┬─────────────┘   └──────────────────┘            │
│              │                                                  │
│  ┌───────────┴─────────────┐   ┌──────────────────┐            │
│  │    云数据库               │   │   云存储           │            │
│  │    users / photos        │   │   photos/          │            │
│  │    notes / deletion_tasks│   │     {openid}/      │            │
│  └─────────────────────────┘   │       *.jpg         │            │
│                                 │   万象优图 CI 处理   │            │
│                                 └──────────────────┘            │
└────────────────────────────────────────────────────────────────┘
```

**核心交互**：
- 前端通过 `wx.cloud.callFunction({ name, data })` 调用云函数
- 云函数通过 `wx-server-sdk` 操作数据库和云存储
- 图片上传：本地压缩 → `wx.cloud.uploadFile()` → 云函数 `upload/confirm` 创建数据库记录
- 身份认证：云函数 `cloud.getWXContext().OPENID` 获取唯一标识，实现数据隔离

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
│   └── deletion-status/           # PG-008 注销处理中
│       └── deletion-status.{wxml,wxss,js,json}
│
├── components/
│   ├── upload-panel/              # PG-003 上传面板 (t-popup 浮层)
│   ├── note-editor/               # PG-005 备注编辑层 (t-popup 浮层)
│   ├── photo-card/                # 图片卡片（瀑布流单元）
│   ├── note-item/                 # 备注列表项
│   ├── page-state/                # 统一状态：加载/空/错误
│   └── danger-confirm/            # 高风险确认组件
│
├── services/                      # 云函数调用封装
│   ├── auth.js                    # 登录/身份
│   ├── photos.js                  # 图片 CRUD
│   ├── notes.js                   # 备注 CRUD
│   ├── upload.js                   # 上传队列管理
│   └── user.js                    # 用户信息/空间/注销
│
├── utils/
│   ├── compress.js                # Canvas 离屏压缩
│   ├── exif.js                    # EXIF 提取
│   ├── validator.js               # 校验（含 Unicode code point 计数）
│   ├── constants.js               # 常量定义
│   └── util.js                    # 通用工具
│
├── theme/
│   └── tokens.wxss                # CSS 自定义属性（13 个颜色 Token）
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
    "pages/deletion-status/deletion-status"
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
- 二级页：`wx.navigateTo()`（preview, settings, deletion-status）
- PG-001 → PG-002：`wx.redirectTo()`（不保留启动页）
- PG-007 → PG-008：`wx.redirectTo()`（注销后不可返回）

### 3.3 页面形态说明（PG-003 与 PG-005）

依据原型设计，PG-003 和 PG-005 不作为独立页面，而是浮层组件嵌入父页面：

| 编号 | 名称 | 前端形态 | 载体 |
|---|---|---|---|
| PG-003 | 图片选择与上传面板 | `<upload-panel>` + `t-popup` 底部弹出 | PG-002 |
| PG-005 | 备注编辑层 | `<note-editor>` + `t-popup` 底部弹出 | PG-004 |

### 3.4 TDesign 组件分配

| 页面/组件 | TDesign 组件 | 用途 |
|---|---|---|
| PG-002 图片列表 | `t-navbar`, `t-image`, `t-badge`, `t-notice-bar`, `t-skeleton`, `t-tab-bar` | 导航、缩略图、备注标记、空间预警、骨架屏、底部Tab |
| PG-003 上传面板 | `t-popup`, `t-progress`, `t-dialog` | 底部弹出、进度条、离开确认 |
| PG-004 图片预览 | `t-navbar`, `t-image-viewer`, `t-action-sheet`, `t-empty` | 导航、大图查看、操作菜单、空态 |
| PG-005 备注编辑 | `t-popup`, `t-textarea`, `t-button`, `t-message` | 编辑层、文本输入、保存按钮、冲突提示 |
| PG-006 备注列表 | `t-navbar`, `t-cell`, `t-image`, `t-tag`, `t-action-sheet`, `t-tab-bar` | 导航、列表项、缩略图、排序标签、排序选择、底部Tab |
| PG-007 设置 | `t-cell-group`, `t-cell`, `t-progress`, `t-dialog`, `t-input` | 设置项、空间进度条、注销确认、文字输入 |
| PG-008 注销状态 | `t-result`, `t-loading`, `t-button` | 结果展示、加载态、联系客服 |
| PG-001 启动 | `t-loading`, `t-result`, `t-button` | 加载、错误结果、重试 |

**注册方式**：在每个页面的 `.json` 中通过 `usingComponents` 局部注册，禁止全局全量注册。

### 3.5 自定义业务组件

| 组件名 | 对应页面 | 职责 |
|---|---|---|
| `upload-panel` | PG-003 | 上传队列：N/20 计数、缩略图、状态、进度、重试；压缩触发、上传幂等控制；底部弹出+离开确认 |
| `note-editor` | PG-005 | 备注编辑：多行文本、字数 N/1000（超限变红）、保存冲突三选一处理（加载最新/继续提交/取消） |
| `photo-card` | — | 瀑布流卡片：缩略图 + 备注 badge + 点击跳转 |
| `note-item` | — | 备注列表项：72×72 缩略图 + 内容(3行省略) + 时间 + "已编辑"标签 |
| `page-state` | — | 统一状态：骨架屏/空态(插画+文案+CTA)/错误态(说明+重试) |
| `danger-confirm` | — | 高风险确认：不可恢复提示 + 影响范围 + 二次确认（禁止遮罩关闭） |

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
  refreshNotes: false
}
```

**跨页面通信**：
- Tab 切换时 `onShow` 检测标记决定是否刷新
- 图片删除/备注变更后设置标记通知关联页面

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
| `cleanup` | (定时触发器) | 孤立对象清理、注销任务推进 |

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
  created_at: Date
}
// 索引：
// { _openid: 1, upload_time: -1 }  — 列表查询
// { _openid: 1, shoot_time: -1 }   — 备注排序用
```

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
清理内容：孤立云存储对象 + DELETING 用户重试推进。

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
- 删改操作先校验资源所有权
- `DELETING` / `DELETED` 状态用户的所有业务接口直接拒绝

### 5.2 图片访问控制

- 使用 `cloud.getTempFileURL()` 生成临时访问 URL（不暴露永久公开 URL）
- 云函数校验身份后返回临时链接
- 日志不记录完整 fileID 或临时 URL

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
- 级联清理顺序：图片对象 → 图片记录 → 备注 → 用户数据 → 解绑微信

---

## 6. 接口设计

### 6.1 通用响应格式

```
成功: { code: "SUCCESS", data: {...}, message?: "string" }
错误: { code: "ERROR_CODE", message: "用户可读错误信息" }
```

### 6.2 错误码

| 错误码 | 说明 |
|---|---|
| `SUCCESS` | 操作成功 |
| `AUTH_FAILED` | 身份验证失败 |
| `FORBIDDEN` / `USER_NOT_ACTIVE` | 资源无权访问 / 账号状态异常 |
| `NOT_FOUND` | 图片/备注不存在或已删除 |
| `CONFLICT` | 备注版本冲突（乐观锁） |
| `VALIDATION_ERROR` | 输入校验失败 |
| `SPACE_EXCEEDED` | 空间不足 |
| `DELETION_ALREADY_PENDING` | 已有未完成注销任务 |
| `INTERNAL_ERROR` | 服务内部错误 |

### 6.3 核心接口

#### user 云函数

```
login:       IN { type:"login" }  →  OUT { user:{ status,used_bytes,limit_bytes }, isNewUser }
getStatus:   IN { type:"getStatus" }  →  OUT { status }
```

#### photo 云函数

```
list:    IN { type:"list", page, pageSize }  →  OUT { list:[ {_id,thumbnail_url,width,height,
              note_count,shoot_time,time_source,upload_time} ], total, hasMore }
detail:  IN { type:"detail", photoId }  →  OUT { photo:{...compression_url...}, notes:[...] }
delete:  IN { type:"delete", photoId }  →  OUT { deletedNotesCount }
```

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
              shootTime, timeSource, taskId }  →  OUT { photo }
         幂等：taskId 已存在时直接返回已有记录
```

#### account 云函数

```
requestDeletion:    IN { type:"requestDeletion", confirmText:"确认注销" }  →  OUT { taskId, status }
getDeletionStatus:  IN { type:"getDeletionStatus" }  →  OUT { status, retryCount }
```

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
      photos.insert({...})
      users.update({ $inc: { used_bytes: size } })
      ← 返回 photo 记录
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

---

## 8. 性能优化

| 策略 | 说明 |
|---|---|
| 缩略图 200px | 列表加载 `thumbnail_url`（云函数拼接 CI 参数），不加载 2560px 预览图 |
| 骨架屏 | 数据请求时即时展示，缩略图渐进加载 |
| 数据库索引 | 所有查询场景均有复合索引覆盖 |
| 冗余字段 | `notes` 冗余 `photo_shoot_time`、`photo_thumbnail_url`，避免聚合查询 |
| 原子更新 | `note_count` 使用 `$inc`，避免 count 查询 |
| 并发控制 | 上传队列并发 ≤3，压缩异步执行不阻塞 UI |

---

## 9. 成本优化

| 策略 | 说明 |
|---|---|
| 只存压缩图 | 不上传原图 |
| 动态缩略图 | CI 动态生成，不额外存储缩略图副本 |
| 定时清理 | 移除孤立对象 |
| 分页 20 | 控制单次查询数据量 |
| 500MB/人 | 服务端可配配额 |

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

---

## 11. 开发时序建议

| 阶段 | 内容 | 交付物 |
|---|---|---|
| S1 基础设施 | 项目重构、页面路由、user 云函数、TDesign 引入构建 | 登录流程跑通 |
| S2 上传核心 | photo(list/detail)、upload(confirm)、EXIF+压缩+上传队列 | 单图上传成功 |
| S3 图片浏览 | PG-002 瀑布流、PG-004 预览、photo(delete) | 图片浏览+删除 |
| S4 备注核心 | note(add/update/delete)、PG-005 编辑器+冲突处理 | 备注 CRUD |
| S5 备注浏览 | note(list)、PG-006 四种排序、反向定位+高亮 | 双向浏览 |
| S6 设置与空间 | 空间查询、PG-007、空间预警 | 数据管理 |
| S7 注销与清理 | account 云函数、PG-008、cleanup 定时触发器 | 合规完成 |
| S8 打磨发布 | 骨架屏、空态、错误态、安全区适配、真机测试 | 发布就绪 |

---

## 12. 待确认事项

1. **云开发环境 ID**：环境归属与配额
2. **Node.js 运行时版本**：云函数建议 Node.js 18
3. **TDesign 版本锁定**：建议 `~` 锁定 Minor 版本
4. **图片存储地域**：COS 存储桶地域选择
5. **定时触发器配额**：确认免费额度是否足够每日一次

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
| 注销级联 | 模拟各阶段失败验证重试 |
| 缩略图性能 | 网络抓包确认仅加载 200px thumbnail_url |
