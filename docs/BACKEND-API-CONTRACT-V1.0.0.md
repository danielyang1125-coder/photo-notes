# BACKEND API CONTRACT — 图片笔记小程序 V1.0.0

> 文档用途：前端对接参考。所有接口以本文档为准。  
> 版本：V1.0.0  
> 日期：2026-07-30

---

## 1. 通用响应格式

所有业务云函数统一返回：

```json
// 成功
{ "code": "SUCCESS", "data": { ... }, "message": "可选提示" }

// 错误
{ "code": "ERROR_CODE", "message": "用户可读的安全信息" }
```

- 成功时 `code` 固定为 `"SUCCESS"`，业务数据在 `data` 中。
- 错误时 `code` 为下表中的错误码，`message` 为面向用户的中文提示。
- 错误响应不泄露资源是否存在、属于谁、内部 fileID/OPENID 等敏感信息。

---

## 2. 完整错误码表

| 错误码 | 说明 | 前端处理建议 |
|---|---|---|
| `AUTH_FAILED` | 身份验证失败 | 重新登录 |
| `USER_NOT_ACTIVE` | 账号已注销或状态异常 | 进入受限页面 |
| `FORBIDDEN` | 操作不可用（如 health check 未开启）| 不重试 |
| `VALIDATION_ERROR` | 请求参数不合法 | 检查输入，显示字段错误 |
| `UNKNOWN_TYPE` | 未知的 type 值 | 检查云函数调用参数 |
| `NOT_FOUND` | 资源不存在或已删除（通用）| 刷新页面 |
| `PHOTO_NOT_FOUND` | 图片不存在、DELETING、已删除或属于他人 | 返回列表页 |
| `TAG_NOT_FOUND` | 标签不存在、已删除或属于他人 | 刷新标签列表 |
| `NOTE_NOT_FOUND` | 备注不存在或已删除 | 刷新备注列表 |
| `DELETE_TASK_NOT_FOUND` | 删除任务不存在或属于他人 | 停止轮询 |
| `UPLOAD_ATTEMPT_NOT_FOUND` | 上传 attempt 不存在或属于他人 | 重新 prepare |
| `INVALID_CURSOR` | cursor 过期、篡改或参数不匹配 | 清空 cursor 刷新首屏 |
| `CONFLICT` | 数据版本冲突（乐观锁）| 展示冲突处理 UI |
| `SPACE_EXCEEDED` | 存储空间不足 | 提示清理空间 |
| `TAG_NAME_INVALID` | 标签名称不合法（长度/字符/保留名）| 显示字段错误 |
| `TAG_NAME_DUPLICATED` | 同名标签已存在 | 提示使用已有标签 |
| `TAG_LIMIT_REACHED` | 标签数量达上限（100 个）| 禁用创建入口 |
| `PHOTO_TAG_LIMIT_REACHED` | 单图标签已达上限（5 个）| 提示移除其他标签 |
| `UPLOAD_ATTEMPT_CANCELED` | 上传任务已取消 | 不重试 confirm |
| `UPLOAD_ATTEMPT_EXPIRED` | 上传任务已过期（24h）| 重新 prepare |
| `UPLOAD_CONFIRM_IN_PROGRESS` | 该 attempt 正在确认中 | 延迟重试 |
| `UPLOAD_FILE_MISMATCH` | fileID 的环境或路径与 attempt 不匹配 | 拒绝并记录 |
| `UPLOAD_FILE_INVALID` | 文件格式/尺寸/解码失败 | 提示文件无效 |
| `DELETION_ALREADY_PENDING` | 已有未完成的注销任务 | 进入注销状态页 |
| `CONTENT_REVIEW_FAILED` | 内容不合规 | 提示用户 |
| `CONTENT_REVIEW_UNAVAILABLE` | 审核服务暂时不可用 | 提示稍后重试 |
| `INTERNAL_ERROR` | 服务内部错误 | 保留输入，允许重试 |

---

## 3. 接口规范

### 3.1 user 云函数

#### login

```
IN  { type: "login" }
OUT { code: "SUCCESS", data: { status: "ACTIVE"|"DELETING"|"DELETED",
      used_bytes: number, limit_bytes: number, isNewUser: boolean } }
```

- 并发首次登录幂等：只创建一个用户记录，默认配额 500 MB。
- DELETED 用户不自动复活。

#### getStatus

```
IN  { type: "getStatus" }
OUT { code: "SUCCESS", data: { status: "ACTIVE"|"DELETING"|"DELETED" } }
```

#### getSpaceUsage

```
IN  { type: "getSpaceUsage" }
OUT { code: "SUCCESS", data: { used_bytes: number, limit_bytes: number,
      warning: boolean, full: boolean } }
```

- `warning`：已使用 ≥ 90% 配额
- `full`：已使用 ≥ 100% 配额

---

### 3.2 upload 云函数

#### prepare

```
IN  { type: "prepare", taskId: string }   // taskId 1-128 安全字符
OUT { code: "SUCCESS", data: { attemptId: string, cloudPath: string,
      expiresAt: ISO8601, photoId?: string } }
```

- 同一 `_openid + taskId` 重复调用返回原 attempt。
- 已 CONFIRMED 时额外返回 `photoId`。
- CANCELED/EXPIRED 返回终态，不复活。
- `cloudPath` 格式：`uploads/pending/{random32}.bin`，客户端用此路径上传文件。

#### confirm

```
IN  { type: "confirm", attemptId: string, fileId: string,
      shootTime: ISO8601, timeSource: "EXIF"|"UPLOAD_TIME" }
OUT { code: "SUCCESS", data: { photo: { _id, file_size, width, height,
      format, shoot_time, time_source, upload_time }, duplicated: boolean } }
```

- **不接受也不信任** 客户端传入的 `size/width/height/format`。
- 服务端下载文件并验证：magic bytes（JPEG/PNG）、真实尺寸、解码损坏。
- 审核不可用时 fail-closed（返回 `CONTENT_REVIEW_UNAVAILABLE`）。
- `duplicated: true` 表示本次 confirm 未创建新 photo（重放或并发冲突）。
- `SPACE_EXCEEDED` 时 attempt 保持 PREPARED，可在 24h 内释放空间后重试。

#### cancel

```
IN  { type: "cancel", attemptIds: string[] }  // 1-20 个，去重
OUT { code: "SUCCESS", data: { results: [
      { attemptId: string, status: "CANCELED"|"CONFIRMED"|"EXPIRED"|"NOT_FOUND",
        photoId?: string, code?: string }
    ] } }
```

- PREPARED → CANCELED；已 CONFIRMED 返回 photoId。
- 终态重放幂等。
- cancel 和 confirm 以服务端事务提交顺序线性化。

---

### 3.3 photo 云函数

#### list

```
IN  { type: "list", scope: "ALL"|"UNCATEGORIZED"|"TAG",
      tagId?: string,          // scope=TAG 时必传
      cursor?: string | null,  // 首屏传 null 或不传
      pageSize?: number }      // 1-20，默认 20
OUT { code: "SUCCESS", data: {
      list: [{ _id, thumbnail_url, width, height, shoot_time,
               time_source, upload_time, tag_count }],
      nextCursor: string | null,
      hasMore: boolean } }
```

- ALL：查询本人 `status=ACTIVE` 的全部图片。
- UNCATEGORIZED：查询 `status=ACTIVE, tag_count=0`。
- TAG：先校验本人 tag，按 `photo_tags` 的 `photo_upload_time DESC, _id DESC` 扫描，批量读取本人 ACTIVE photo；跳过失效引用继续填页。
- 排序：ALL/UNCATEGORIZED 按 `upload_time DESC, _id DESC`；TAG 按 `photo_upload_time DESC, _id DESC`。
- 不使用 `.skip()`，不使用 `page` 参数。
- `thumbnail_url`：服务端批量生成的约 200px 临时缩略图 URL。
- TAG 筛选成功时更新标签 `last_used_at`。

#### detail

```
IN  { type: "detail", photoId: string }
OUT { code: "SUCCESS", data: {
      photo: { _id, width, height, format, file_size, shoot_time,
               time_source, upload_time, tag_count, preview_url },
      notes: [{ _id, content, created_at, updated_at }],
      tags: [{ _id, name, photo_count }]   // 最多 5 个
    } }
```

- 只查询本人 `status=ACTIVE` 的 photo。
- `preview_url`：临时 URL（完整图，无 CI 压缩参数）。
- 不返回 `file_id`、`_openid` 等内部字段。

#### delete

```
IN  { type: "delete", photoId: string }
OUT { code: "SUCCESS", data: { taskId: string, photoId: string,
      status: "PENDING", updatedAt: ISO8601, completedAt: null } }
```

- 短事务：photo ACTIVE → DELETING，创建唯一 PHOTO_DELETE 任务。
- 提交后图片立即从 list/detail/note/tag 全局隐藏。
- 重复 delete 返回同一任务。
- 删除为异步：状态通过 `getDeleteStatus` 查询。

#### getDeleteStatus

```
IN  { type: "getDeleteStatus", taskId?: string, photoId?: string }
OUT { code: "SUCCESS", data: {
      taskId: string, photoId: string,
      status: "PENDING"|"PROCESSING"|"RETRYING"|"COMPLETED",
      updatedAt: ISO8601, completedAt: ISO8601|null } }
```

- `taskId` 和 `photoId` 至少传一个。
- 任务不存在或属于他人统一返回 `DELETE_TASK_NOT_FOUND`。

---

### 3.4 note 云函数

#### add

```
IN  { type: "add", photoId: string, content: string }  // content 1-1000 code point
OUT { code: "SUCCESS", data: { note: { _id, photo_id, thumbnail_url,
      content, content_code_point_count, photo_shoot_time,
      created_at, updated_at } } }
```

- 校验本人 ACTIVE photo。
- 先审核 content（msgSecCheck），不通过返回 `CONTENT_REVIEW_FAILED`。
- 审核不可用时 fail-closed（返回 `CONTENT_REVIEW_UNAVAILABLE`）。

#### update

```
IN  { type: "update", noteId: string, content: string, updatedAt: ISO8601 }
OUT { code: "SUCCESS", data: { note: {...}, conflict?: true } }
     或 { code: "CONFLICT", ... }（见错误处理）
```

- 乐观锁：`where({ _id, _openid, updated_at: updatedAt })` 条件更新。
- 冲突时返回当前版本 note + `conflict: true`。
- `updatedAt` 为必填，不接受省略。
- 冲突读取使用 `where({_id, _openid})`，不裸用 `doc(noteId)`。

#### delete

```
IN  { type: "delete", noteId: string }
OUT { code: "SUCCESS", data: { deleted: true, photoId: string } }
```

- 校验本人 note，不存在的 note 返回 `NOTE_NOT_FOUND`。
- V1 不维护 photo 的 note_count。

#### list

```
IN  { type: "list",
      sortBy?: "created_at"|"photo_shoot_time",  // 默认 created_at
      sortOrder?: "desc"|"asc",                    // 默认 desc
      cursor?: string | null,
      pageSize?: number }                          // 1-20，默认 20
OUT { code: "SUCCESS", data: {
      list: [{ _id, photo_id, thumbnail_url, content,
               content_code_point_count, photo_shoot_time,
               created_at, updated_at }],
      nextCursor: string | null,
      hasMore: boolean } }
```

- 四种排序组合：`{created_at|photo_shoot_time} × {desc|asc}`。
- 同向 `_id` 作为稳定第二排序键。
- 批量复核父图片为本人 ACTIVE，跳过失效引用继续扫描。
- `thumbnail_url`：服务端批量生成的临时缩略图。
- 不使用 `.skip()`。

---

### 3.5 tag 云函数

#### list

```
IN  { type: "list", mode: "QUICK"|"ALL" }
OUT { code: "SUCCESS", data: { list: [TagSummary] } }
```

TagSummary：
```
{ _id: string, name: string, photo_count: number,
  last_used_at?: ISO8601, created_at: ISO8601, updated_at: ISO8601 }
```

- QUICK：最近使用的 5 个。
- ALL：全部（最多 100 个）。
- 固定排序：`last_used_at DESC, updated_at DESC, created_at DESC, _id DESC`。
- 不暴露 `normalized_name`。

#### create

```
IN  { type: "create", name: string }
OUT { code: "SUCCESS", data: { tag: TagSummary } }
```

- 规范化顺序：Unicode trim → 控制字符拒绝 → code point 1-12 → 保留名拒绝 → NFC → Latin 小写归一。
- 内容审核 fail-closed。
- 同名冲突返回 `TAG_NAME_DUPLICATED`。

#### rename

```
IN  { type: "rename", tagId: string, name: string }
OUT { code: "SUCCESS", data: { tag: TagSummary } }
```

- 校验本人标签，不存在返回 `TAG_NOT_FOUND`。
- 审核和规范化规则同 create。

#### delete

```
IN  { type: "delete", tagId: string }
OUT { code: "SUCCESS", data: { deleted: true, removedRelationCount: number } }
```

- 幂等删除本人标签和关系。
- 按实际删除的关系数更新图片 `tag_count`。
- 不删除图片、备注。

#### getPhotoTags

```
IN  { type: "getPhotoTags", photoId: string }
OUT { code: "SUCCESS", data: { tags: [TagSummary] } }
```

- 先校验本人 ACTIVE photo（不存在返回 `PHOTO_NOT_FOUND`）。

#### updatePhotoTags

```
IN  { type: "updatePhotoTags", photoId: string,
      addTagIds: string[], removeTagIds: string[], requestId: string }
OUT { code: "SUCCESS", data: { tags: [TagSummary] } }
```

- 两数组分别去重，不得交叉（同一 tagId 同时出现在 add 和 remove 中）。
- 事务内读取当前关系集合并写实际差异。
- 合并后 0-5 个，超出返回 `PHOTO_TAG_LIMIT_REACHED`。
- `requestId`：客户端生成，重试复用，服务端只做摘要用于链路追踪。

#### batchAddPhotoTags

```
IN  { type: "batchAddPhotoTags", photoIds: string[], tagIds: string[],
      requestId: string }    // photoIds 1-20 个，tagIds 1-5 个
OUT { code: "SUCCESS", data: { successCount: number, invalidCount: number,
      limitExceededCount: number, tags: [TagSummary] } }
```

- 全部 tagId 先整体校验，任一失效整次拒绝。
- 逐图独立事务：一个图片失败不回滚其他图片。
- 返回三类计数：成功、无效图片（不存在/DELETING/他人）、超限。

---

### 3.6 account 云函数

#### requestDeletion

```
IN  { type: "requestDeletion", confirmText: "确认注销" }
OUT { code: "SUCCESS", data: { taskId: string, status: "DELETING" } }
```

- 要求用户为 ACTIVE 状态。
- `confirmText` 必须精确匹配 `"确认注销"`。
- 短事务：user → DELETING，创建唯一注销任务。
- 重复请求返回原任务（`DELETION_ALREADY_PENDING`）。
- 提交后所有普通业务接口全部拒绝。

#### getDeletionStatus

```
IN  { type: "getDeletionStatus" }
OUT { code: "SUCCESS", data: { status: "ACTIVE"|"DELETING"|"DELETED",
      retryCount?: number } }
```

- 用户记录仍存在时返回权威状态。
- `USER_NOT_FOUND` 视为注销已完成（DELETED）。

---

## 4. Cursor 格式

所有列表接口使用 HMAC-SHA256 签名的 base64url cursor：

- **生成**：`encodeCursor({ resource, scope, tagId?, sortBy, sortOrder, lastValue, lastId }, secret)`
- **解码**：`decodeCursor(cursorString, binding, secret)`
- **绑定**：cursor 与 `resource`、`scope`、`tagId`、`sortBy`、`sortOrder` 绑定。
- **安全**：cursor 篡改、跨 scope/tag/sort 复用返回 `INVALID_CURSOR`。
- **不提供** 数据库快照语义或精确 `total` 计数。

---

## 5. 功能开关（Feature Flags）

以下环境变量在 DEV-13 全部启用（值必须为 `"true"`）：

| 变量 | 用途 | 影响范围 |
|---|---|---|
| `UPLOAD_ATTEMPT_REQUIRED` | 强制新上传协议（prepare/confirm/cancel）| upload 云函数 |
| `CURSOR_PAGINATION_REQUIRED` | 强制 Keyset Cursor 分页 | photo、note 云函数 |
| `ASYNC_PHOTO_DELETE_ENABLED` | 强制异步图片删除 | photo 云函数 |
| `PUBLIC_RESOURCE_ERROR_MASKING` | 统一存在性保护（错误码安全映射）| 全部业务云函数 |
| `CONTENT_REVIEW_ENABLED` | 内容安全审核（fail-closed）| upload、note、tag 云函数 |

未配置或值为非法值时，云函数冷启动失败（返回 `INTERNAL_ERROR`）。

---

## 6. 前端迁移指南

### 必须修改的接口调用

| 模块 | 旧协议 | 新协议 |
|---|---|---|
| **上传** | `confirm({ size, width, height, format, taskId, ... })` | `prepare({ taskId })` → 客户端上传 → `confirm({ attemptId, fileId, shootTime, timeSource })` |
| **上传取消** | 不存在 | `cancel({ attemptIds: [...] })` |
| **图片列表** | `list({ page, pageSize })` | `list({ cursor, pageSize?, scope, tagId? })` |
| **备注列表** | `list({ page, pageSize })` | `list({ cursor, pageSize?, sortBy?, sortOrder? })` |
| **图片删除** | 同步删除，返回 `COMPLETED` | `delete({ photoId })` → 返回 `PENDING` → 轮询 `getDeleteStatus` |
| **批量标签** | 任一失败全部回滚 | `batchAddPhotoTags` 返回三类计数，逐图独立 |

### 分页状态管理

- 旧：维护 `page: number`，请求时传 `page`。
- 新：维护 `cursor: string | null`，首次传 `null`，后续传上次返回的 `nextCursor`。
- `hasMore: false` 表示没有更多数据。
- `INVALID_CURSOR` 时清空 cursor 重新从首屏加载。
