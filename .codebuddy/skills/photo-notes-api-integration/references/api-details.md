# 图片笔记小程序 - API 详细文档

> 基于云端实际部署代码梳理，最后更新：2026-07-30
> 环境：`cloud1-d0gsee3m13c2b446c`（ap-shanghai，个人版）

---

## 0. 总则

### 0.1 调用方式

所有后端能力通过 `wx.cloud.callFunction()` 调用，**禁止客户端直接操作数据库或存储**。

```js
wx.cloud.callFunction({
  name: '<云函数名>',   // user | upload | photo | note | tag | account
  data: {
    type: '<操作类型>', // 必填
    // ...其他参数
  },
})
```

### 0.2 响应格式

```json
// 成功
{ "code": "SUCCESS", "data": { ... } }

// 失败
{ "code": "ERROR_CODE", "message": "用户可读的中文提示" }
```

### 0.3 全局约束

| 规则 | 说明 |
|---|---|
| 分页 | 一律使用 `cursor`（HMAC 签名），禁止 `page`/`skip` |
| 上传 | 三步协议：`prepare → wx.cloud.uploadFile → confirm` |
| 删除 | 异步：提交后立即隐藏，后台 worker 最终清理 |
| 安全投影 | 响应不含 `_openid`、`file_id`、`normalized_name`、内部租约 |
| 错误掩码 | 他人/不存在/DELETING 资源统一返回安全错误，不泄露存在性 |

---

## 1. user — 用户与空间

**云函数名：** `user`

### 1.1 login

首次调用自动创建用户（500MB 空间），并发安全。

```
type: "login"
```

**请求参数：** 无（身份由微信上下文自动注入）

**响应：**
```json
{
  "code": "SUCCESS",
  "data": {
    "user": {
      "status": "ACTIVE",       // ACTIVE | DELETING | DELETED
      "used_bytes": 0,          // 已用空间（字节）
      "limit_bytes": 524288000  // 总空间（500MB）
    },
    "isNewUser": true
  }
}
```

### 1.2 getStatus

```
type: "getStatus"
```

**响应：**
```json
{ "code": "SUCCESS", "data": { "status": "ACTIVE" } }
```

### 1.3 getSpaceUsage

```
type: "getSpaceUsage"
```

**响应：**
```json
{
  "code": "SUCCESS",
  "data": {
    "used_bytes": 236251,
    "limit_bytes": 524288000,
    "warning": false,   // used >= 85% limit
    "full": false       // used >= limit
  }
}
```

> **错误：** 用户非 ACTIVE 时返回 `USER_NOT_ACTIVE`

---

## 2. upload — 上传（三步协议）

**云函数名：** `upload`

### 流程图

```
客户端                              服务端
  │                                   │
  │── prepare({taskId}) ────────────→│ 签发 attemptId + cloudPath
  │←── {attemptId, cloudPath} ───────│   (uploads/pending/{random}.bin)
  │                                   │
  │── wx.cloud.uploadFile(cloudPath) → 客户端直传存储
  │                                   │
  │── confirm({attemptId, fileId, ───→│ 验证文件真实性
  │     shootTime, timeSource})       │  下载→解码→审核→提升到 active/
  │←── {photo} ──────────────────────│  原子创建 photo + 扣空间
```

### 2.1 prepare

```
type: "prepare"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `taskId` | string | ✅ | 客户端生成的唯一幂等键，1~128 安全字符 |

**响应：**
```json
{
  "code": "SUCCESS",
  "data": {
    "attemptId": "a1b2c3d4...",              // 32位 hex，后续 confirm 用
    "cloudPath": "uploads/pending/xxx.bin",  // wx.cloud.uploadFile 的目标路径
    "expiresAt": "2026-07-31T12:00:00.000Z"  // 24h 有效期
  }
}
```

**幂等：** 相同 `taskId` 重复调用返回相同 attempt。如果已 confirm，额外返回 `photoId`：
```json
{ "attemptId": "...", "cloudPath": "...", "expiresAt": "...", "photoId": "xxx" }
```

> **错误：** `VALIDATION_ERROR`（taskId 非法）

### 2.2 confirm

```
type: "confirm"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `attemptId` | string | ✅ | prepare 返回的 attemptId |
| `fileId` | string | ✅ | wx.cloud.uploadFile 返回的 fileID |
| `shootTime` | string\|null | ✅ | ISO 8601 时间戳；`timeSource=UPLOAD_TIME` 时可 null |
| `timeSource` | string | ✅ | `"EXIF"` 或 `"UPLOAD_TIME"` |

> ⚠️ **禁止传 `size`、`width`、`height`、`format`、`taskId`** — 这些字段会被拒绝（VALIDATION_ERROR）

**响应：**
```json
{
  "code": "SUCCESS",
  "data": {
    "photo": {
      "_id": "abc123...",
      "file_size": 79911,
      "width": 402,
      "height": 791,
      "format": "PNG",
      "shoot_time": "2026-07-30T12:00:00.000Z",
      "time_source": "UPLOAD_TIME",
      "upload_time": "2026-07-30T12:05:00.000Z"
    },
    "duplicated": false
  }
}
```

> `duplicated: true` 表示此 attemptId 已确认过（幂等重放），返回的是已有 photo。

> **错误：** `UPLOAD_ATTEMPT_NOT_FOUND` | `UPLOAD_ATTEMPT_EXPIRED` | `UPLOAD_ATTEMPT_CANCELED` | `UPLOAD_FILE_MISMATCH` | `UPLOAD_FILE_INVALID` | `UPLOAD_CONFIRM_IN_PROGRESS` | `SPACE_EXCEEDED` | `CONTENT_REVIEW_FAILED`

### 2.3 cancel

```
type: "cancel"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `attemptIds` | string[] | ✅ | 1~20 个 attemptId，自动去重 |

**响应：**
```json
{
  "code": "SUCCESS",
  "data": {
    "results": [
      { "attemptId": "xxx", "status": "CANCELED" },
      { "attemptId": "yyy", "status": "CONFIRMED", "photoId": "abc" },
      { "attemptId": "zzz", "status": "NOT_FOUND", "code": "UPLOAD_ATTEMPT_NOT_FOUND" }
    ]
  }
}
```

状态枚举：`CANCELED` | `CONFIRMED` | `EXPIRED` | `NOT_FOUND`

---

## 3. photo — 图片查询与删除

**云函数名：** `photo`

### 3.1 list — 图片列表（Cursor 分页）

```
type: "list"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scope` | string | ✅ | `"ALL"` / `"UNCATEGORIZED"` / `"TAG"` |
| `tagId` | string | scope=TAG 时必填 | 标签 ID |
| `cursor` | string | 翻页时传 | 上一页返回的 nextCursor（首页不传） |
| `pageSize` | number | 可选 | 1~20，默认 20 |

**响应：**
```json
{
  "code": "SUCCESS",
  "data": {
    "list": [
      {
        "_id": "abc123...",
        "thumbnail_url": "https://...?imageMogr2/thumbnail/!200x200r",
        "width": 402,
        "height": 791,
        "shoot_time": "2026-07-30T12:00:00.000Z",
        "time_source": "EXIF",
        "upload_time": "2026-07-30T12:05:00.000Z",
        "tag_count": 2,
        "note_count": 3,
        "latest_note_content": "最新一条备注的文本内容"
      }
    ],
    "nextCursor": "xxx...",   // 下一页用；无更多时为 null
    "hasMore": true
  }
}
```

**list 返回字段：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 图片 ID |
| `thumbnail_url` | string | 缩略图临时链接（200×200，1h 有效，可能为空） |
| `width` | number | 图片宽度（px） |
| `height` | number | 图片高度（px） |
| `shoot_time` | string\|null | ISO 8601 拍摄时间 |
| `time_source` | string | `"EXIF"` 或 `"UPLOAD_TIME"` |
| `upload_time` | string | ISO 8601 上传时间 |
| `tag_count` | number | 标签数量（0~5） |
| `note_count` | number | 备注数量（实际查询计数） |
| `latest_note_content` | string | 最新一条备注内容（无备注时为空字符串） |

> **关于 `note_count` 和 `latest_note_content`：** `note_count` 在每次 list 请求时从 `notes` 集合实时聚合计数；`latest_note_content` 取 `created_at` 最大的一条备注的 `content` 字段。两者均为非关键数据（查询失败时返回 `0`/`""`）。

**三种 scope：**

| scope | 数据范围 | 排序 |
|---|---|---|
| `ALL` | 本人 ACTIVE 图片 | `upload_time DESC, _id DESC` |
| `UNCATEGORIZED` | tag_count=0 的 ACTIVE 图片 | `upload_time DESC, _id DESC` |
| `TAG` | 指定标签关联的 ACTIVE 图片 | `photo_upload_time DESC, _id DESC` |

**分页用法：**
```js
// 首页
const page1 = await callPhoto('list', { scope: 'ALL', pageSize: 20 })
// 下一页
const page2 = await callPhoto('list', { scope: 'ALL', pageSize: 20, cursor: page1.nextCursor })
// 直到 hasMore === false
```

> **错误：** `VALIDATION_ERROR`（scope/cursor/pageSize 非法）| `TAG_NOT_FOUND` | `INVALID_CURSOR`（cursor 篡改/跨 scope 复用）

### 3.2 detail — 图片详情

```
type: "detail"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `photoId` | string | ✅ | 图片 ID |

**响应：**
```json
{
  "code": "SUCCESS",
  "data": {
    "photo": {
      "_id": "abc123...",
      "width": 402, "height": 791,
      "format": "PNG",
      "file_size": 79911,
      "shoot_time": "2026-07-30T12:00:00.000Z",
      "time_source": "EXIF",
      "upload_time": "2026-07-30T12:05:00.000Z",
      "tag_count": 2,
      "preview_url": "https://..."   // 临时 URL（全尺寸）
    },
    "notes": [
      { "_id": "...", "content": "备注内容", "created_at": "...", "updated_at": "..." }
    ],
    "tags": [
      { "_id": "...", "name": "风景", "photo_count": 3 }
    ]
  }
}
```

> **错误：** `PHOTO_NOT_FOUND`（不存在/他人/DELETING 统一返回）

### 3.3 delete — 删除图片（异步）

```
type: "delete"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `photoId` | string | ✅ | 图片 ID |

**响应：**
```json
{
  "code": "SUCCESS",
  "data": {
    "taskId": "def456...",
    "photoId": "abc123...",
    "status": "PENDING",
    "updatedAt": "2026-07-30T12:10:00.000Z",
    "completedAt": null
  }
}
```

> 提交后图片**立即全局不可见**（list/detail/note/tag 均隐藏）。后台 cleanup worker 每 5 分钟推进删除任务。

> **错误：** `PHOTO_NOT_FOUND`（不存在/他人/已 DELETING 统一返回）。重复 delete 返回同一 taskId。

### 3.4 getDeleteStatus — 查询删除进度

```
type: "getDeleteStatus"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `taskId` | string | 二选一 | 删除任务 ID |
| `photoId` | string | 二选一 | 图片 ID |

**响应：** 与 delete 相同结构，`status` 可能为 `PENDING` / `PROCESSING` / `COMPLETED` / `MANUAL_REQUIRED`

> **错误：** `DELETE_TASK_NOT_FOUND` | `VALIDATION_ERROR`（两个参数都没传）

---

## 4. note — 备注

**云函数名：** `note`

### 4.1 add

```
type: "add"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `photoId` | string | ✅ | 目标图片 ID（必须 ACTIVE 且本人） |
| `content` | string | ✅ | 1~1000 code point |

**响应：**
```json
{
  "code": "SUCCESS",
  "data": {
    "note": {
      "_id": "xxx",
      "photo_id": "abc",
      "thumbnail_url": "https://...?imageMogr2/thumbnail/!200x200r",
      "content": "备注内容",
      "content_code_point_count": 4,
      "photo_shoot_time": "2026-07-30T12:00:00.000Z",
      "created_at": "2026-07-30T12:15:00.000Z",
      "updated_at": "2026-07-30T12:15:00.000Z"
    }
  }
}
```

> **错误：** `PHOTO_NOT_FOUND` | `CONTENT_REVIEW_FAILED` | `VALIDATION_ERROR`

### 4.2 update — 乐观锁更新

```
type: "update"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `noteId` | string | ✅ | 备注 ID |
| `content` | string | ✅ | 1~1000 code point |
| `updatedAt` | string | ✅ | **必须传**当前备注的 `updated_at`（乐观锁） |

**正常响应：** `{ note: {...} }`

**冲突响应：**
```json
{
  "code": "SUCCESS",
  "data": {
    "note": { "_id": "...", "updated_at": "<最新值>", ... },
    "conflict": true
  }
}
```

> `conflict: true` 表示并发冲突（其他人已修改）。前端应提示用户"内容已被更新"，用返回的 `note.updated_at` 重试。

> **错误：** `NOTE_NOT_FOUND` | `CONTENT_REVIEW_FAILED` | `VALIDATION_ERROR`

### 4.3 delete

```
type: "delete"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `noteId` | string | ✅ | 备注 ID |

**响应：**
```json
{ "code": "SUCCESS", "data": { "deleted": true, "photoId": "abc" } }
```

> **错误：** `NOTE_NOT_FOUND`

### 4.4 list — 备注列表（Cursor 分页）

```
type: "list"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sortBy` | string | 可选 | `"created_at"`（默认）/ `"photo_shoot_time"` |
| `sortOrder` | string | 可选 | `"desc"`（默认）/ `"asc"` |
| `cursor` | string | 翻页时传 | 上一页的 nextCursor |
| `pageSize` | number | 可选 | 1~20，默认 20 |

**响应：**
```json
{
  "code": "SUCCESS",
  "data": {
    "list": [
      {
        "_id": "xxx",
        "photo_id": "abc",
        "thumbnail_url": "https://...?imageMogr2/thumbnail/!200x200r",
        "content": "备注内容",
        "content_code_point_count": 4,
        "photo_shoot_time": "2026-07-30T12:00:00.000Z",
        "created_at": "2026-07-30T12:15:00.000Z",
        "updated_at": "2026-07-30T12:15:00.000Z"
      }
    ],
    "nextCursor": "xxx...",
    "hasMore": true
  }
}
```

> 仅返回关联到 ACTIVE 图片的备注；若图片已删除，备注自动跳过。

---

## 5. tag — 标签

**云函数名：** `tag`

### 5.1 list

```
type: "list"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mode` | string | 可选 | `"ALL"`（默认，最多 100 个）/ `"QUICK"`（最近 5 个） |

**响应：**
```json
{
  "code": "SUCCESS",
  "data": {
    "list": [
      {
        "_id": "xxx",
        "name": "风景",
        "photo_count": 3,
        "last_used_at": "2026-07-30T12:00:00.000Z",
        "created_at": "...",
        "updated_at": "..."
      }
    ],
    "total": 1
  }
}
```

> 排序：`last_used_at DESC → updated_at DESC → created_at DESC → _id DESC`

### 5.2 create

```
type: "create"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | 1~12 code point，自动规范化 |

**规范化规则：** Unicode trim → 控制字符拒绝 → 1~12 code point → 保留名拒绝 → NFC → 拉丁小写归一

> "全部"、"未分类" 为保留名，不可使用。

**响应：** `{ tag: {...} }`

> **错误：** `TAG_NAME_INVALID` | `TAG_NAME_DUPLICATED` | `TAG_LIMIT_REACHED`（上限 100）| `CONTENT_REVIEW_FAILED`

### 5.3 rename

```
type: "rename"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tagId` | string | ✅ | 标签 ID |
| `name` | string | ✅ | 新名称（同 create 规范化） |

> **错误：** `TAG_NOT_FOUND` | `TAG_NAME_INVALID` | `TAG_NAME_DUPLICATED` | `CONTENT_REVIEW_FAILED`

### 5.4 delete

```
type: "delete"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tagId` | string | ✅ | 标签 ID |

**响应：**
```json
{ "code": "SUCCESS", "data": { "deleted": true, "removedRelationCount": 3 } }
```

> 事务内删除所有关联关系 + 标签本身，同步递减 photo.tag_count。幂等：重复删除返回成功。

> **错误：** `TAG_NOT_FOUND`

### 5.5 getPhotoTags

```
type: "getPhotoTags"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `photoId` | string | ✅ | 图片 ID（必须 ACTIVE 且本人） |

**响应：** `{ tags: [...] }` — 空数组表示无标签（UNCATEGORIZED）

> **错误：** `PHOTO_NOT_FOUND`

### 5.6 updatePhotoTags

```
type: "updatePhotoTags"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `photoId` | string | ✅ | 图片 ID |
| `addTagIds` | string[] | 可选(默认[]) | 要添加的标签 ID（最多 5，去重） |
| `removeTagIds` | string[] | 可选(默认[]) | 要移除的标签 ID（最多 5，去重） |

> ⚠️ `addTagIds` 和 `removeTagIds` 不能有交集

**响应：** `{ tags: [...] }` — 返回最终标签列表

> 事务内：读取当前集合 → 去重 → 只写差异 → 双向维护计数（tag.photo_count + photo.tag_count）

> **错误：** `PHOTO_NOT_FOUND` | `TAG_NOT_FOUND` | `PHOTO_TAG_LIMIT_REACHED`（合并后超 5）| `VALIDATION_ERROR`（数组交叉）

### 5.7 batchAddPhotoTags

```
type: "batchAddPhotoTags"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `photoIds` | string[] | ✅ | 1~20 个图片 ID，去重 |
| `tagIds` | string[] | ✅ | 1~5 个标签 ID，去重 |
| `requestId` | string | 可选 | 客户端重试识别（不落库，仅日志关联） |

**响应：**
```json
{
  "code": "SUCCESS",
  "data": {
    "successCount": 15,         // 成功关联的图片数
    "invalidCount": 2,          // 图片不存在/越权
    "limitExceededCount": 3,    // 合并后超 5 个标签
    "tags": [...]               // 最终涉及的标签摘要
  }
}
```

> 逐图独立事务，一张失败不影响其他。`successCount + invalidCount + limitExceededCount === photoIds.length`

---

## 6. account — 账号注销

**云函数名：** `account`

### 6.1 requestDeletion

```
type: "requestDeletion"
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `confirmText` | string | ✅ | 必须精确为 `"确认注销"` |

**响应：**
```json
{ "code": "SUCCESS", "data": { "taskId": "xxx", "status": "PENDING", "appliedAt": "...", "completedAt": null } }
```

> 提交后用户立即进入 DELETING，所有业务操作拒绝。后台 cleanup worker 推进清理。重复请求返回原任务。

> **错误：** `VALIDATION_ERROR`（确认文字不匹配）| `USER_NOT_ACTIVE`

### 6.2 getDeletionStatus

```
type: "getDeletionStatus"
```

**请求参数：** 无

**响应：**
```json
{ "code": "SUCCESS", "data": { "taskId": "xxx", "status": "DELETED", "completedAt": "..." } }
```

> `USER_NOT_FOUND` 视为注销已完成。

---

## 7. 错误码速查

| 错误码 | 含义 | 触发场景 |
|---|---|---|
| `VALIDATION_ERROR` | 参数不合法 | 类型/范围/格式错误 |
| `AUTH_FAILED` | 身份验证失败 | openid 缺失 |
| `UNKNOWN_TYPE` | 未知操作 | type 值不在路由表中 |
| `NOT_FOUND` | 资源不存在 | 通用不存在 |
| `PHOTO_NOT_FOUND` | 图片不可用 | 不存在/他人/DELETING |
| `NOTE_NOT_FOUND` | 备注不可用 | 不存在/他人 |
| `TAG_NOT_FOUND` | 标签不可用 | 不存在/他人 |
| `TAG_NAME_INVALID` | 标签名非法 | 长度/控制字符/保留名 |
| `TAG_NAME_DUPLICATED` | 标签重名 | 同用户下已存在 |
| `TAG_LIMIT_REACHED` | 标签数达上限 | >100 |
| `PHOTO_TAG_LIMIT_REACHED` | 图片标签达上限 | 合并后 >5 |
| `SPACE_EXCEEDED` | 空间不足 | used + fileSize > limit |
| `UPLOAD_ATTEMPT_NOT_FOUND` | 上传任务不存在 | attemptId 无效/他人 |
| `UPLOAD_ATTEMPT_EXPIRED` | 上传任务过期 | >24h |
| `UPLOAD_ATTEMPT_CANCELED` | 上传任务已取消 | cancel 后 confirm |
| `UPLOAD_CONFIRM_IN_PROGRESS` | 确认进行中 | 并发 confirm |
| `UPLOAD_FILE_MISMATCH` | 文件不匹配 | fileID 路径与 attempt 不一致 |
| `UPLOAD_FILE_INVALID` | 文件无效 | 下载/解码失败 |
| `DELETE_TASK_NOT_FOUND` | 删除任务不存在 | taskId/photoId 无效 |
| `USER_NOT_ACTIVE` | 用户状态异常 | DELETING/DELETED 用户操作 |
| `INTERNAL_ERROR` | 服务异常 | 统一内部错误（安全掩码） |
| `INVALID_CURSOR` | 分页信息失效 | cursor 被篡改或跨 scope 复用 |
| `CONTENT_REVIEW_FAILED` | 内容不合规 | 安全检查不通过 |
| `CONTENT_REVIEW_UNAVAILABLE` | 审核服务不可用 | fail-closed |
| `CONFLICT` | 数据冲突 | 乐观锁冲突（通用） |

---

## 8. 数据库集合 Schema

### 8.1 `users`

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | = openid |
| `_openid` | string | 微信 openid |
| `status` | string | `ACTIVE` / `DELETING` / `DELETED` |
| `used_bytes` | number | 已用空间（字节） |
| `limit_bytes` | number | 总空间（默认 524288000 = 500MB） |
| `created_at` | Date | 创建时间 |
| `updated_at` | Date | 更新时间 |

### 8.2 `photos`

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 随机 hex |
| `_openid` | string | 所属用户 |
| `file_id` | string | 云存储 fileID（`cloud://...`） |
| `task_id` | string | 上传幂等键 |
| `upload_attempt_id` | string | 关联的上传 attempt |
| `file_size` | number | 文件大小（字节） |
| `width` | number | 图片宽度（px） |
| `height` | number | 图片高度（px） |
| `format` | string | 格式（`JPEG` / `PNG`） |
| `sha256` | string | 文件 SHA-256 |
| `shoot_time` | Date\|null | 拍摄时间 |
| `time_source` | string | `EXIF` / `UPLOAD_TIME` |
| `upload_time` | Date | 上传时间 |
| `status` | string | `ACTIVE` / `DELETING` |
| `tag_count` | number | 标签数（0~5，计数器） |
| `note_count` | number | 备注数（实时查询，非持久化） |
| `deleting_at` | Date\|null | 删除提交时间 |

### 8.3 `notes`

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 自动生成 |
| `_openid` | string | 所属用户 |
| `photo_id` | string | 关联图片 ID |
| `photo_file_id` | string | 关联图片的 fileID（用于生成缩略图） |
| `content` | string | 备注内容（1~1000 code point） |
| `content_code_point_count` | number | Unicode code point 长度 |
| `photo_shoot_time` | Date | 图片拍摄时间快照 |
| `created_at` | Date | 创建时间 |
| `updated_at` | Date | 更新时间（乐观锁） |

### 8.4 `tags`

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 自动生成 |
| `_openid` | string | 所属用户 |
| `name` | string | 标签名（1~12 code point） |
| `normalized_name` | string | 规范化名称（拉丁小写，唯一索引，不对外暴露） |
| `photo_count` | number | 关联图片数（计数器） |
| `last_used_at` | Date | 最后使用时间 |
| `created_at` | Date | 创建时间 |
| `updated_at` | Date | 更新时间 |

### 8.5 `photo_tags`

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 自动生成 |
| `_openid` | string | 所属用户 |
| `photo_id` | string | 图片 ID |
| `tag_id` | string | 标签 ID |
| `photo_upload_time` | Date | 图片上传时间快照（TAG scope 排序用） |

### 8.6 `upload_attempts`

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 32-char hex（attemptId） |
| `_openid` | string | 所属用户 |
| `task_id` | string | 客户端幂等键 |
| `status` | string | `PREPARED` / `CONFIRMED` / `CANCELED` / `EXPIRED` |
| `pending_cloud_path` | string | 客户端上传目标路径 |
| `pending_file_id` | string\|null | confirm 期间暂存的 fileID |
| `promoted_file_id` | string\|null | 提升后的 fileID |
| `promoted_at` | Date\|null | 提升时间 |
| `verified_meta` | Object\|null | 验证后的图片元数据 |
| `photo_id` | string\|null | 关联的 photo ID（CONFIRMED 后） |
| `expires_at` | Date | 过期时间（24h） |
| `canceled_at` | Date\|null | 取消时间 |
| `confirm_lease_token` | string\|null | confirm 租约令牌 |
| `confirm_lease_expire_at` | Date\|null | 租约过期时间 |

### 8.7 `deletion_tasks`

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 自动生成 |
| `_openid` | string | 所属用户（注销完成后清空） |
| `type` | string | `PHOTO_DELETE` / `ACCOUNT_DELETION` / 系统检查点 |
| `task_key` | string | 唯一键（`<type>:<id>`） |
| `status` | string | `PENDING` / `PROCESSING` / `RETRYING` / `COMPLETED` / `MANUAL_REQUIRED` |
| `current_stage` | string | 当前执行阶段 |
| `stage_cursor` | Object | 各阶段游标状态 |
| `retry_count` | number | 重试次数 |
| `next_retry_at` | Date\|null | 下次重试时间 |
| `lease_token` | string\|null | 租约令牌 |
| `lease_expire_at` | Date\|null | 租约过期时间 |
| `file_id` | string\|null | 关联文件 ID（图片删除） |
| `file_size` | number\|null | 文件大小（图片删除） |
| `photo_id` | string\|null | 关联图片 ID |
| `applied_at` | Date | 任务创建时间 |
| `completed_at` | Date\|null | 完成时间 |

---

## 9. 前端适配清单

### 9.1 分页切换（待修改）

| 文件 | 当前 | 需改为 |
|---|---|---|
| `services/photos.js` → `list()` | `page, pageSize` | `cursor, pageSize` |
| `services/notes.js` → `list()` | `page, pageSize` | `cursor, pageSize` |
| 调用 list 的页面 | 页码递增翻页 | `nextCursor` 驱动翻页 |

**改造模板：**
```js
// 旧
const res = await photosService.list('ALL', null, this.data.page, 20)
this.setData({ photos: res.result.data.list, page: this.data.page + 1 })

// 新
const res = await photosService.list('ALL', null, this.data.cursor, 20)
this.setData({
  photos: this.data.page === 1
    ? res.result.data.list
    : [...this.data.photos, ...res.result.data.list],
  cursor: res.result.data.nextCursor,
  hasMore: res.result.data.hasMore
})
```

### 9.2 图片删除适配

调用 delete 的页面需要接受 `PENDING` 状态，通过 `getDeleteStatus` 轮询。

### 9.3 batchAddPhotoTags 响应适配

需要解析 `successCount/invalidCount/limitExceededCount` 三类结果，分别处理。

### 9.4 无需修改

- `user/login`、`getStatus`、`getSpaceUsage` — 协议不变
- `tag/list`、`create`、`rename`、`delete`、`getPhotoTags`、`updatePhotoTags` — 协议不变
- `note/add`、`update`（乐观锁）、`delete` — 协议不变
- `account/*` — 协议不变

---

## 10. 服务层文件对照

| 文件 | 状态 |
|---|---|
| `services/upload.js` | ✅ 已改为新协议 |
| `services/photos.js` | ❌ `list()` 需改为 cursor |
| `services/notes.js` | ❌ `list()` 需改为 cursor |
| `services/tags.js` | ✅ 协议不变 |
| `services/auth.js` | ✅ 协议不变 |
| `components/upload-panel/upload-panel.js` | ✅ 已改为三步流程 |

---

## 11. 常见问题

| 现象 | 可能原因 |
|---|---|
| `AUTH_FAILED` | 非微信环境调用（如 MCP invoke），需要真机/模拟器 |
| `VALIDATION_ERROR` | 参数名拼写错误或传了多余字段（如 confirm 传了 size） |
| `INVALID_CURSOR` | cursor 字符串截断、URL 编码丢失、或跨 scope/sort 复用 |
| `UPLOAD_FILE_MISMATCH` | fileID 路径与 prepare 返回的 cloudPath 不一致 |
| `INTERNAL_ERROR` | 环境变量缺失（HMAC 密钥等）或 SDK 异常 |

---

## 12. 环境变量

| 变量 | 使用模块 | 说明 |
|---|---|---|
| `CURSOR_HMAC_SECRET` | photo, note | 分页 cursor 签名密钥（≥32 字符） |
| `CONTENT_REVIEW_ENABLED` | note, tag, upload | 是否启用内容审核（`true`/`false`） |
| `CURSOR_PAGINATION_REQUIRED` | photo, note | 是否强制 cursor 分页 |
| `ASYNC_PHOTO_DELETE_ENABLED` | photo | 是否启用异步删除 |
| `UPLOAD_ATTEMPT_REQUIRED` | upload | 是否强制使用 attempt 上传 |
| `PUBLIC_RESOURCE_ERROR_MASKING` | 所有模块 | 是否对不存在资源统一返回安全错误 |
| `ENABLE_HEALTH_CHECK` | user | 是否启用健康检查（必须 `'true'`） |
