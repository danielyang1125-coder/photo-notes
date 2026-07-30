# TECHNICAL DESIGN — 图片笔记小程序 V1.0.0 P0 问题修复

> **文档状态**：增量技术设计稿，待评审
> **文档类型**：后端 P0 修复技术开发文档
> **适用版本**：V1.0.0（正式发布前）
> **设计基线**：[TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md](./TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md)
> **需求基线**：[PRD-图片笔记小程序-V1.0.0.md](./PRD-图片笔记小程序-V1.0.0.md)
> **基础设施基线**：[DATABASE-SETUP-CHECKLIST.md](./DATABASE-SETUP-CHECKLIST.md)
> **文档日期**：2026-07-29

---

## 0. 文档定位与优先级

本文是 V1.0.0 主技术架构的增量修复设计，只解决以下 7 个 P0 问题：

1. 上传空间配额并发超限及图片记录、空间统计半提交。
2. `upload/confirm` 信任客户端 fileID、大小、格式和尺寸。
3. 上传幂等只有“先查后写”，缺少数据库唯一性防线。
4. 客户端取消与服务端迟到 confirm 的竞态无法判定。
5. 图片异步删除缺少逻辑删除、状态查询和完整恢复机制。
6. `page/skip` 分页在并发变化下重复、遗漏且排序不稳定。
7. `TAG_ACCESS_DENIED` 等错误码泄露资源存在性。

在上述范围内，本文与其他文档冲突时采用以下优先级：

```text
本文
  > TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md
  > DATABASE-SETUP-CHECKLIST.md
  > 当前未发布的云函数实现
```

本文评审通过前不直接修改 PRD、主技术架构或数据库清单。评审通过后，必须按 §13 的清单回写基线，避免长期存在两套口径。

### 0.1 不在本次范围

- 内容安全策略取舍及人工复核能力。
- 备注派生计数的后台校正。
- 注销完成后的身份绑定匿名化。
- 标签大规模删除的独立异步任务改造。
- 临时 URL 与 CI 图片处理参数的厂商可行性验证。

上述项目按 P1 继续跟踪；但内容审核位于上传确认链路内时，必须遵守本文定义的文件可信边界和事务边界。

---

## 1. 当前问题与需求追溯

| P0 | 当前实现/设计 | 失败场景 | 对应需求或验收 |
|---|---|---|---|
| P0-01 配额原子性 | 先读 `used_bytes`，再创建 photo，最后 `$inc` | 3 个并发上传同时通过空间检查；photo 成功但空间更新失败 | BR-012、AC-012、AC-035、§7.2 一致性 |
| P0-02 文件可信性 | confirm 接收客户端 `fileId/size/width/height/format` | 少报大小绕过配额；确认其他路径对象；数据库元数据与实际文件不一致 | BR-004～BR-008、BR-012、BR-028 |
| P0-03 上传幂等 | 先按 `task_id` 查询再插入，无唯一索引 | 重复回调并发执行时创建两条 photo 并重复计费 | BR-011、AC-013 |
| P0-04 取消竞态 | 上传任务只存在客户端 | 用户已取消，但在途 confirm 随后创建 photo | BR-025、AC-036 |
| P0-05 图片删除 | delete 返回 `PENDING`，photo 仍可查询且没有状态接口 | 对象已删但详情仍返回；重试重复扣空间；前端无法判断完成 | BR-020/021、AC-027/028/069 |
| P0-06 分页稳定性 | 使用 `page/skip`，只按时间排序 | 翻页期间新增/删除导致重复或漏项；相同时间顺序不确定 | AC-022、AC-034、AC-047 |
| P0-07 存在性泄露 | 他人标签和不存在标签使用不同错误码 | 可枚举 tagId 并判断资源是否存在 | BR-001、BR-029、AC-002、AC-067、§7.3 安全 |

---

## 2. 修复后的总体架构

```text
小程序
  │
  ├─ upload/prepare(taskId)
  │      └─ upload_attempts: PREPARED
  │          返回随机 attemptId + pending cloudPath
  │
  ├─ wx.cloud.uploadFile(pending cloudPath)
  │
  ├─ upload/confirm(attemptId, fileId, shootTime, timeSource)
  │      ├─ 取得 confirm 租约
  │      ├─ 校验环境、路径、真实文件内容和元数据
  │      ├─ 内容审核（若启用）
  │      ├─ 服务端提升到客户端不可写的 active 路径
  │      └─ 数据库事务：
  │          user ACTIVE + 配额校验
  │          photo INSERT
  │          users.used_bytes INC
  │          attempt → CONFIRMED
  │
  └─ upload/cancel(attemptIds)
         └─ 事务：仍为 PREPARED 才可 → CANCELED

photo/delete(photoId)
  │
  ├─ 数据库事务：
  │    photo ACTIVE → DELETING
  │    创建或返回唯一 PHOTO_DELETE 任务
  │
  ├─ 立即从业务查询隐藏，操作不可撤销
  └─ 删除处理器：
       STORAGE_DELETE
       → NOTES_CLEANUP
       → PHOTO_TAGS_CLEANUP
       → PHOTO_FINALIZE + used_bytes 扣减
       → COMPLETED
```

### 2.1 核心不变量

以下不变量是实现和测试的最终判断标准：

1. 一个用户的同一 `task_id` 最多对应一条有效 photo。
2. `users.used_bytes` 等于该用户仍计费的 photo `file_size` 总和；删除任务完成前仍计费。
3. photo 使用的 `file_id/file_size/format/width/height` 均来自服务端验证后的 active 对象。
4. 客户端只能写 pending 路径，不能覆盖 active 对象。
5. upload attempt 只能从 `PREPARED` 进入一个终态。
6. confirm 与 cancel 以服务端数据库事务提交顺序线性化。
7. `DELETING` photo 不得从任何业务读接口返回，也不得新增备注或标签关系。
8. PHOTO_DELETE 任务只对实际存在的记录或关系执行一次计数变更。
9. 列表分页使用稳定复合排序和 keyset cursor，不使用 `skip`。
10. 本人外资源与不存在资源对客户端不可区分。

---

## 3. 上传尝试状态机

### 3.1 业务状态

```text
              confirm 事务成功
PREPARED ───────────────────────→ CONFIRMED
    │
    ├─ cancel 事务成功 ─────────→ CANCELED
    │
    └─ expires_at 到期清理 ─────→ EXPIRED
```

`CONFIRMED`、`CANCELED`、`EXPIRED` 均为终态，不允许逆向流转。

### 3.2 confirm 内部租约

文件下载、解析、审核和提升不应放入长数据库事务。为防止两个 confirm 同时执行，`PREPARED` attempt 增加内部租约：

```javascript
{
  confirm_lease_token: "random",
  confirm_lease_expire_at: Date,
  promoted_file_id: "cloud://...", // 提升成功后暂存
  verified_meta: {
    file_size: 1500000,
    width: 2560,
    height: 1920,
    format: "JPEG",
    sha256: "..."
  }
}
```

租约规则：

1. confirm 首先在短事务内读取 attempt。
2. `CONFIRMED`：直接返回原 `photo_id`，作为幂等成功。
3. `CANCELED/EXPIRED`：拒绝，不重新启用。
4. `PREPARED` 且无有效租约：写入随机租约和短过期时间。
5. `PREPARED` 且已有有效租约：返回 `UPLOAD_CONFIRM_IN_PROGRESS`，客户端延迟重试。
6. 租约持有者执行文件验证和提升；最终事务必须再次读取 attempt 状态和租约 token。
7. 租约期间 cancel 仍可先把 `PREPARED` 改为 `CANCELED`；confirm 最终事务发现状态变化后终止并删除已提升的孤立 active 对象。
8. 云函数异常退出后租约到期；重试可复用 `promoted_file_id` 和 `verified_meta`，禁止重复计费。

### 3.3 confirm 与 cancel 的线性化口径

网络环境下无法以客户端点击时间判定两个在途请求的真实先后，服务端统一使用事务提交顺序：

| 先提交 | 后提交 | 最终结果 |
|---|---|---|
| cancel | confirm | attempt=`CANCELED`；confirm 返回 `UPLOAD_ATTEMPT_CANCELED`；不创建 photo |
| confirm | cancel | attempt=`CONFIRMED`；cancel 返回该任务已成功；photo 保留 |
| 两个 confirm | 后一个冲突/重试 | 只创建一条 photo，两个请求最终返回同一 photoId |
| attempt 过期 | confirm/cancel | 返回 `UPLOAD_ATTEMPT_EXPIRED` |

客户端关闭上传面板时应先批量调用 cancel，再忽略本地迟到回调。若 confirm 已先在服务端提交，该任务属于成功项，不能再改为已取消。PRD AC-036 应回写这一可实现的线性化边界。

---

## 4. 数据模型与索引

### 4.1 新增 `upload_attempts`

```javascript
{
  _id: "random-attempt-id",
  _openid: "owner-openid",
  task_id: "batch_file03",
  status: "PREPARED", // PREPARED | CONFIRMED | CANCELED | EXPIRED

  pending_cloud_path: "uploads/pending/{random32}.bin",
  pending_file_id: null,
  promoted_file_id: null,
  verified_meta: null,

  confirm_lease_token: null,
  confirm_lease_expire_at: null,

  photo_id: null,
  expires_at: Date,
  created_at: Date,
  updated_at: Date,
  confirmed_at: null,
  canceled_at: null
}
```

索引：

| 索引名 | 字段 | 类型 | 用途 |
|---|---|---|---|
| `attempt_task_unique` | `_openid:1, task_id:1` | UNIQUE | 同一客户端上传任务只签发一个 attempt |
| `attempt_expire_idx` | `status:1, expires_at:1` | 普通 | cleanup 过期和孤立对象清理 |
| `attempt_lease_idx` | `status:1, confirm_lease_expire_at:1` | 普通 | 失效 confirm 租约恢复 |
| `attempt_cleanup_cursor_idx` | `status:1, _id:1` | 普通 | 补偿任务稳定 keyset 扫描与断点续跑 |

默认 `expires_at = created_at + 24h`。只有 PREPARED attempt 可到期；终态记录保留 7 天用于幂等重放，之后删除或转为不可识别统计。

### 4.2 修改 `photos`

新增字段：

```javascript
{
  status: "ACTIVE", // ACTIVE | DELETING
  upload_attempt_id: "attempt-id",
  updated_at: Date,
  deleting_at: null
}
```

新增或替换索引：

| 索引名 | 字段 | 类型 |
|---|---|---|
| `photo_task_unique` | `_openid:1, task_id:1` | UNIQUE |
| `photo_attempt_unique` | `_openid:1, upload_attempt_id:1` | UNIQUE |
| `photo_list_cursor_idx` | `_openid:1, status:1, upload_time:-1, _id:-1` | 普通 |
| `photo_uncategorized_cursor_idx` | `_openid:1, status:1, tag_count:1, upload_time:-1, _id:-1` | 普通 |

所有新建 photo 固定写入 `status: "ACTIVE"`。现有开发/测试数据上线前统一回填 `status: "ACTIVE"` 和 `updated_at`。

### 4.3 修改 `photo_tags`

按标签分页索引替换为：

```text
_openid:1, tag_id:1, photo_upload_time:-1, _id:-1
```

分页以关系记录 `_id` 作为时间相同情况下的稳定第二排序键。

### 4.4 修改 `notes`

列表索引替换为：

```text
_openid:1, created_at:-1, _id:-1
_openid:1, created_at: 1, _id: 1
_openid:1, photo_shoot_time:-1, _id:-1
_openid:1, photo_shoot_time: 1, _id: 1
```

CloudBase 若支持同一复合索引反向扫描，可在实际环境验证后合并升降序索引；未验证前按四个访问路径显式建立，禁止以假设替代环境验收。

### 4.5 修改 `deletion_tasks`

PHOTO_DELETE 任务字段：

```javascript
{
  _id: "random-task-id",
  _openid: "owner-openid",
  type: "PHOTO_DELETE",
  task_key: "PHOTO_DELETE:{photoId}",
  photo_id: "photo-id",
  file_id: "cloud://...",
  file_size: 1500000,

  status: "PENDING", // PENDING | PROCESSING | RETRYING | COMPLETED
  current_stage: "STORAGE_DELETE",
  stage_cursor: null,

  lease_token: null,
  lease_expire_at: null,
  next_retry_at: Date,
  retry_count: 0,
  last_error_code: null,
  last_error_safe_message: null,

  applied_at: Date,
  updated_at: Date,
  completed_at: null
}
```

新增索引：

| 索引名 | 字段 | 类型 | 用途 |
|---|---|---|---|
| `delete_task_unique` | `_openid:1, task_key:1` | UNIQUE | 同一图片只有一个删除任务 |
| `delete_dispatch_idx` | `type:1, status:1, next_retry_at:1` | 普通 | cleanup 获取可执行任务 |
| `delete_lease_idx` | `type:1, status:1, lease_expire_at:1` | 普通 | 回收失效租约 |

`last_error_safe_message` 禁止记录完整 fileID、图片内容、备注内容、标签名称或原始 OPENID。

---

## 5. 云存储可信边界

### 5.1 路径分区

```text
uploads/
└── pending/
    └── {random32}.bin        # 客户端只能向该区上传，扩展名不作为格式依据

photos/
└── active/
    └── {random32}.{ext}      # 客户端禁止写，仅云函数写入
```

- 路径不得包含完整或截断 OPENID。
- `random32` 使用服务端密码学安全随机数，不由时间戳单独构成。
- 客户端不自行生成路径，只使用 `upload/prepare` 返回值。
- 数据库和存储权限必须禁止客户端写 `photos/active/`。
- active fileID 才能写入 `photos.file_id`。

### 5.2 服务端验证与提升

confirm 必须按以下顺序执行：

1. 从 `getWXContext().OPENID` 获取用户身份。
2. 按 `_id + _openid` 查询 upload attempt。
3. 校验 fileID 属于当前云环境。
4. 从 fileID 解析对象路径，并与 attempt 的 `pending_cloud_path` 完全匹配。
5. 下载对象 buffer，以 `buffer.length` 得到真实字节数。
6. 从文件 magic bytes 和解码结果取得真实格式、宽度、高度；不采用客户端值。
7. 只接受静态 JPEG/PNG；拒绝 GIF、伪造扩展名、无法解码和异常尺寸。
8. 对 `shootTime/timeSource` 做类型、枚举和合理时间范围校验；拍摄时间仍属于客户端提取元数据，不表述为服务端已验证 EXIF。
9. 执行内容审核（若 V1 最终启用）。
10. 由云函数把已验证 buffer 写入随机 active 路径，并保存 SHA-256。
11. 执行 §6 的数据库事务。
12. 事务成功后尽力删除 pending 对象；失败由 cleanup 按 attempt 终态补偿。

不能直接把客户端上传的 pending fileID写入 photo。否则文件在验证后仍可能被客户端覆盖，数据库元数据与最终对象不再一致。

### 5.3 孤立对象清理

- PREPARED 且未到 `expires_at` 的 pending 对象不得删除。
- CANCELED/EXPIRED attempt 的 pending 对象可立即清理。
- CONFIRMED attempt 的 pending 对象只保留至事务完成后的补偿清理。
- active 对象只有在不存在有效 photo、没有有效 confirm 租约且创建时间超过 24h 时才视为孤立。
- 孤立扫描必须使用对象列表分页，保存本次游标；单次任务不得无界遍历整个目录。

---

## 6. 上传接口与事务

### 6.1 `upload/prepare`

请求：

```javascript
{
  type: "prepare",
  taskId: "batch_file03"
}
```

响应：

```javascript
{
  code: "SUCCESS",
  data: {
    attemptId: "random-attempt-id",
    cloudPath: "uploads/pending/random32.bin",
    expiresAt: "server ISO time"
  }
}
```

规则：

- `taskId` 必填，长度 1～128，只接受约定安全字符。
- 用户必须为 ACTIVE。
- 同一 `_openid + taskId` 重放时返回原 attempt。
- 原 attempt 为 CONFIRMED 时额外返回 `photoId`，客户端直接把任务恢复为成功。
- 原 attempt 为 CANCELED/EXPIRED 时不得复活；重试上传必须使用新的 taskId。

### 6.2 `upload/confirm`

请求：

```javascript
{
  type: "confirm",
  attemptId: "attempt-id",
  fileId: "cloud://current-env.xxx/uploads/pending/random32.bin",
  shootTime: "2026-07-29T08:00:00.000Z",
  timeSource: "EXIF" // EXIF | UPLOAD_TIME
}
```

成功响应：

```javascript
{
  code: "SUCCESS",
  data: {
    photo: {
      _id: "photo-id",
      file_size: 1500000,
      width: 2560,
      height: 1920,
      format: "JPEG",
      shoot_time: "server normalized time",
      time_source: "EXIF",
      upload_time: "server time"
    },
    duplicated: false
  }
}
```

空间与入库使用一个短事务：

```text
读取 attempt（本人、PREPARED、租约 token 匹配）
读取 user（本人、ACTIVE）
若 used_bytes + verified.file_size > limit_bytes
  → 事务不写入，返回 SPACE_EXCEEDED
否则
  → 创建 photo(status=ACTIVE, verified metadata)
  → users.used_bytes += verified.file_size
  → attempt.status = CONFIRMED
  → attempt.photo_id = photoId
  → 清空租约并写 confirmed_at
提交
```

补充规则：

- photo ID 在最终事务前生成，保证 attempt 与 photo 同一提交。
- 数据库唯一索引是最终幂等防线；唯一冲突后按 `_openid + task_id` 读取已有 photo 并返回。
- 事务冲突按 SDK 支持的安全策略有限重试；超过上限返回 `INTERNAL_ERROR`，不得提前返回成功。
- SPACE_EXCEEDED 时 attempt 保持 PREPARED，用户释放空间后可在过期前重试同一 confirm。
- active 提升成功但事务失败时，记录在 attempt 的 `promoted_file_id` 供重试或补偿删除，不增加空间。

### 6.3 `upload/cancel`

请求：

```javascript
{
  type: "cancel",
  attemptIds: ["attempt-1", "attempt-2"]
}
```

限制：每次 1～20 个且去重。

响应：

```javascript
{
  code: "SUCCESS",
  data: {
    results: [
      { attemptId: "attempt-1", status: "CANCELED" },
      { attemptId: "attempt-2", status: "CONFIRMED", photoId: "photo-id" }
    ]
  }
}
```

每个 attempt 独立短事务提交，部分失败不回滚其他 attempt。只能取消本人的 PREPARED attempt；CONFIRMED 返回成功事实而不是改为取消。

### 6.4 新增错误码

| 错误码 | 含义 | 客户端处理 |
|---|---|---|
| `UPLOAD_ATTEMPT_NOT_FOUND` | 本人 attempt 不存在；他人 attempt 同样返回此码 | 当前任务失败，不展示资源信息 |
| `UPLOAD_ATTEMPT_CANCELED` | attempt 已取消 | 保持已取消，不重试 confirm |
| `UPLOAD_ATTEMPT_EXPIRED` | attempt 已过期 | 使用新 taskId 重新开始 |
| `UPLOAD_CONFIRM_IN_PROGRESS` | 同一 attempt 正在确认 | 延迟查询/重试，不重复上传 |
| `UPLOAD_FILE_MISMATCH` | fileID 环境或路径与签发值不一致 | 拒绝确认并记录安全事件 |
| `UPLOAD_FILE_INVALID` | 真实文件格式、尺寸或解码失败 | 保留失败原因，禁止入库 |

---

## 7. 图片异步逻辑删除

### 7.1 对外语义

用户确认删除后：

1. `photo/delete` 事务成功即表示删除申请已被可靠接受，操作不可撤销。
2. photo 立即变为 `DELETING` 并从全部业务查询隐藏。
3. 客户端离开详情页并刷新图片、备注和标签结果。
4. 对象和数据库数据由删除处理器最终清理。
5. 空间在任务 COMPLETED 后释放；处理中不提前增加可用空间。
6. 物理清理失败时继续隐藏并自动重试，不恢复 ACTIVE。

这与当前 PRD“服务端成功即完成全部物理清理”的表述不同，必须回写 F-012、AC-027 和 AC-028：

- `PENDING/PROCESSING/RETRYING` 是已接受但尚未物理完成。
- 只有创建删除任务或逻辑标记事务失败时才停留详情页并提示失败。
- 后台阶段失败不恢复图片，通过状态接口展示“删除处理中”。

### 7.2 `photo/delete`

请求：

```javascript
{
  type: "delete",
  photoId: "photo-id"
}
```

短事务：

```text
按 {_id:photoId, _openid:OPENID} 读取 photo
若 ACTIVE：
  photo.status = DELETING
  photo.deleting_at = serverDate
  创建唯一 PHOTO_DELETE task，快照 file_id/file_size
若 DELETING：
  返回已有 task
若 photo 不存在：
  查询本人同 task_key 的历史任务
  有任务则返回其状态；无任务则返回 PHOTO_NOT_FOUND
```

响应：

```javascript
{
  code: "SUCCESS",
  data: {
    taskId: "delete-task-id",
    photoId: "photo-id",
    status: "PENDING" // 或已有状态
  }
}
```

### 7.3 `photo/getDeleteStatus`

请求：

```javascript
{
  type: "getDeleteStatus",
  taskId: "delete-task-id"
}
```

响应：

```javascript
{
  code: "SUCCESS",
  data: {
    taskId: "delete-task-id",
    photoId: "photo-id",
    status: "PENDING | PROCESSING | RETRYING | COMPLETED",
    updatedAt: "server time",
    completedAt: null
  }
}
```

不返回 `last_error`、fileID、内部阶段或重试堆栈。任务不存在和属于他人统一返回 `DELETE_TASK_NOT_FOUND`。

### 7.4 业务查询隔离

以下操作必须增加 `photo.status = ACTIVE` 条件：

- `photo/list` 的 ALL、UNCATEGORIZED 和 TAG 三种范围。
- `photo/detail`。
- `note/add`。
- `tag/getPhotoTags`、`updatePhotoTags`、`batchAddPhotoTags`。
- 备注列表中的图片有效性处理。

TAG 关系分页取得 photoId 后必须再次按本人且 ACTIVE 查询 photo。关系在后台尚未清理不代表图片仍有效。

### 7.5 删除处理器

任务取得规则：

1. 查询到期的 PENDING/RETRYING 或租约已失效的 PROCESSING 任务。
2. 在短事务中设置 PROCESSING、随机 `lease_token` 和 `lease_expire_at`。
3. 每个批次写入前重新验证租约。
4. 失败时写 RETRYING、递增 `retry_count`，使用指数退避更新 `next_retry_at`。
5. 不设置永久 FAILED 终态；超过告警阈值后仍保持 RETRYING，同时触发运维告警。

处理阶段：

```text
STORAGE_DELETE
  幂等删除 task.file_id
  对象不存在视为成功

NOTES_CLEANUP
  按 _id 游标分批删除本人且 photo_id 匹配的 notes

PHOTO_TAGS_CLEANUP
  按关系 _id 游标分批处理
  同一事务：删除实际存在的关系 + 对对应 tag.photo_count 按实际数递减

PHOTO_FINALIZE
  同一事务：
    确认 photo 为本人且 DELETING
    删除 photo
    users.used_bytes -= task.file_size，结果下限为 0
    task → COMPLETED
```

每个数据库批次都必须在同一事务中提交“本批实际数据变更 + `stage_cursor` 前移”，禁止先移动游标再删除，也禁止删除成功后在另一事务中才保存游标。

如果 finalize 时 photo 已不存在：

- task 已 COMPLETED：幂等返回。
- task 未完成且空间是否扣减无法由阶段记录证明：不得再次盲目扣减，进入安全告警和计数校正流程。

因此 `PHOTO_FINALIZE` 的 photo 删除、空间扣减和任务完成必须处于同一事务。

删除请求提交后可在当前 `photo` 云函数执行一次有时限的立即推进；未完成不阻塞响应，由 cleanup 至少每 5 分钟扫描一次可执行任务。实际触发器频率需在目标环境验证配额后确认，但不得继续只依赖每日一次任务满足用户删除流程。

---

## 8. Keyset Cursor 分页

### 8.1 通用 cursor

响应统一为：

```javascript
{
  list: [],
  nextCursor: "base64url-json-or-null",
  hasMore: true
}
```

cursor 解码结构：

```javascript
{
  v: 1,
  resource: "PHOTO",
  scope: "ALL",
  tagId: null,
  sortBy: "upload_time",
  sortOrder: "desc",
  lastValue: "2026-07-29T08:00:00.000Z",
  lastId: "document-id"
}
```

规则：

- Base64URL 只是传输编码，不是可信签名。
- 服务端校验版本、资源、scope、tagId、排序字段、方向、时间和 ID 格式。
- cursor 内容必须与本次请求参数完全一致，否则返回 `INVALID_CURSOR`。
- 所有查询仍以 `_openid` 和资源状态作为第一数据边界；篡改 cursor 不能扩大数据范围。
- 每次最多 20 条；服务端内部可读取 `pageSize + 1` 判断 hasMore。
- 不返回依赖 offset 的 page；`total` 不参与翻页正确性。页面确需 total 时通过独立计数返回，但不得用它计算 offset。

### 8.2 图片 ALL/UNCATEGORIZED

固定排序：

```text
upload_time DESC, _id DESC
```

下一页条件：

```text
upload_time < cursor.lastValue
OR
(upload_time == cursor.lastValue AND _id < cursor.lastId)
```

查询条件：

- ALL：`_openid + status=ACTIVE`。
- UNCATEGORIZED：`_openid + status=ACTIVE + tag_count=0`。

同一分页会话开始后新插入且排在 cursor 之前的图片不会出现在后续页；这是 keyset 分页的预期快照边界，用户通过下拉刷新获取新数据。固定数据集必须无重复、无遗漏。

### 8.3 TAG 图片分页

关系固定排序：

```text
photo_upload_time DESC, photo_tags._id DESC
```

处理流程：

1. 校验本人有效 tag；不存在和他人 tag 使用相同外部错误。
2. 按关系 cursor 分批取得候选 relation。
3. 批量查询 `_openid + status=ACTIVE + _id in photoIds` 的 photo。
4. 按 relation 原顺序恢复结果。
5. 若候选 photo 已逻辑删除或物理删除，继续向后扫描关系，直至凑满 20 条或关系耗尽。
6. `nextCursor` 取“最后扫描的 relation”，不能取最后返回的 photo，否则失效关系会被重复扫描。
7. 单次请求设置最大内部扫描批次数；超过时返回已取得结果及 nextCursor，不能退回全量加载。

禁止现有“读取某标签全部关系后再本地 skip”的实现。

### 8.4 备注列表

| sortBy | sortOrder | 固定排序 |
|---|---|---|
| `created_at` | `desc` | `created_at DESC, _id DESC` |
| `created_at` | `asc` | `created_at ASC, _id ASC` |
| `photo_shoot_time` | `desc` | `photo_shoot_time DESC, _id DESC` |
| `photo_shoot_time` | `asc` | `photo_shoot_time ASC, _id ASC` |

备注列表只返回仍关联本人 ACTIVE photo 的结果。发现失效冗余 note 时跳过并由 cleanup 补偿；nextCursor 同样基于最后扫描的 note。

### 8.5 接口变化

`photo/list`：

```javascript
IN  { type:"list", scope, tagId?, cursor:null|string, pageSize:20 }
OUT { list, nextCursor, hasMore, total? }
```

`note/list`：

```javascript
IN  { type:"list", cursor:null|string, pageSize:20, sortBy, sortOrder }
OUT { list, nextCursor, hasMore, total? }
```

V1.0.0 尚未发布，本次是破坏性升级：

- 删除 `page` 参数。
- 后端不再调用 `.skip()`。
- 客户端列表状态由 `page` 改为 `nextCursor`。
- 旧客户端与旧云函数不得混合发布。

---

## 9. 资源存在性保护

### 9.1 外部错误策略

| 资源 | 以下场景统一响应 |
|---|---|
| Tag | 不存在、已删除、属于他人 → `TAG_NOT_FOUND` |
| Photo | 不存在、DELETING、已删除、属于他人 → `PHOTO_NOT_FOUND` |
| Note | 不存在、关联图片不可用、属于他人 → `NOT_FOUND` |
| UploadAttempt | 不存在、属于他人 → `UPLOAD_ATTEMPT_NOT_FOUND` |
| DeletionTask | 不存在、属于他人 → `DELETE_TASK_NOT_FOUND` |

从公共接口删除 `TAG_ACCESS_DENIED`。`FORBIDDEN` 只用于“已确认当前用户身份，但账号状态或系统策略禁止整个操作”等不涉及具体资源存在性的场景。

### 9.2 查询方式

资源读取直接使用本人条件：

```javascript
where({ _id: resourceId, _openid: OPENID, ...businessState })
```

查不到即返回统一 NOT_FOUND，不允许先按 `_id` 全局查询再判断 `_openid`，避免产生不同响应、日志或耗时路径。

### 9.3 内部日志

允许记录：

```text
event, result, safeErrorCode, durationMs, requestIdHash, resourceIdHash
```

禁止记录：

- 原始 OPENID。
- 原始资源 ID。
- 完整 fileID 或临时 URL。
- 标签名称、备注内容和图片内容。
- 能把资源 ID 哈希反查为用户内容的映射表。

安全审计可使用仅服务端持有的带盐 HMAC 摘要进行同类事件关联。

---

## 10. 安全权限

数据库集合统一设置为客户端拒绝读写，所有业务访问经过云函数：

```json
{
  "read": false,
  "write": false
}
```

适用集合：

- `users`
- `photos`
- `notes`
- `tags`
- `photo_tags`
- `deletion_tasks`
- `upload_attempts`

不能继续使用“仅创建者可读写”作为客户端权限，因为产品契约要求所有权、状态和派生计数校验统一在服务端完成。

云存储权限至少满足：

- 客户端可向服务端签发的 `uploads/pending/` 随机路径上传。
- 客户端禁止写入、覆盖和删除 `photos/active/`。
- active 对象禁止永久公开读。
- 图片读取只能使用云函数鉴权后生成的临时受控 URL。

具体安全规则语法必须在实际 CloudBase 环境做正反向验证，不能只检查控制台显示状态。

---

## 11. 迁移与发布

### 11.1 实施顺序

1. 在开发环境验证事务、复合唯一索引、复合游标索引和存储权限。
2. 创建 `upload_attempts` 及索引。
3. 为 photos、photo_tags、notes、deletion_tasks 创建新索引。
4. 回填开发/测试 photos：`status=ACTIVE`、`updated_at`。
5. 部署支持新 schema 但尚未开放入口的 upload/photo/note/cleanup 云函数。
6. 部署使用 prepare/confirm/cancel 和 cursor 的小程序客户端。
7. 启用新上传协议与 cursor 分页开关。
8. 停止旧 `confirm(fileId,size,...)` 和 `page/skip` 接口。
9. 启用异步图片删除和至少每 5 分钟的任务推进。
10. 完成 §12 验证后删除兼容代码和临时开关。

### 11.2 灰度开关

服务端环境变量：

```text
UPLOAD_ATTEMPT_REQUIRED=true
CURSOR_PAGINATION_REQUIRED=true
ASYNC_PHOTO_DELETE_ENABLED=true
PUBLIC_RESOURCE_ERROR_MASKING=true
```

V1.0.0 正式发布时四项必须全部为 true。开关只用于开发环境联调，不允许生产长期混用两套一致性模型。

### 11.3 回滚

- 新上传协议启用后，不回滚到信任客户端元数据的旧 confirm。
- cursor 客户端和服务端作为同一版本整体回滚，禁止一端单独回滚。
- 异步删除启用后，已有 DELETING photo 和删除任务必须由 cleanup 继续处理；回滚 UI 不得使其重新可见。
- 事务或唯一索引验证失败时停止发布，不通过删除索引绕过。
- active 对象提升成功但发布失败时，按 upload attempt 和 24h 宽限期执行孤立清理。

---

## 12. 测试与验收

### 12.1 上传配额与事务

| 场景 | 预期 |
|---|---|
| 剩余空间只能容纳 1 张，同时 confirm 3 张 | 仅 1 张成功；另 2 张 SPACE_EXCEEDED |
| photo 插入后注入事务异常 | photo、空间、attempt 均不提交 |
| user 更新冲突并重试 | 最终空间不超限、不丢增量 |
| 事务响应丢失后重放 | 返回原 photoId，不重复计费 |
| 删除完成后再次 confirm | 使用最新空间重新判断 |

验收公式：

```text
users.used_bytes
= sum(该用户 ACTIVE photo.file_size)
 + sum(该用户 DELETING 且尚未 finalize 的 task.file_size)
```

### 12.2 文件可信性

- 少报 size、伪造 format/width/height 不影响服务端最终元数据。
- 扩展名为 JPG、内容为 GIF 时拒绝。
- fileID 属于其他环境、其他 pending 路径或 active 路径时拒绝。
- 客户端无法覆盖 active 对象。
- pending 验证后被再次覆盖时，photo 仍引用服务端提升的已验证 buffer。
- shootTime 非法、超合理范围或 timeSource 非法时拒绝。

### 12.3 幂等与取消竞态

- 10 个并发 confirm 最多创建一条 photo。
- 唯一索引冲突映射为原任务成功，而不是 INTERNAL_ERROR。
- cancel 先提交时，所有迟到 confirm 均不入库。
- confirm 先提交时，cancel 返回 CONFIRMED 和原 photoId。
- confirm 租约持有者崩溃后可在租约过期后恢复。
- 批量取消部分成功、部分已确认时逐项结果正确。

### 12.4 图片删除

- delete 接受后，ALL、UNCATEGORIZED、TAG、detail、note 和 tag 写接口均看不到该 photo。
- STORAGE_DELETE 失败后任务 RETRYING，photo 不恢复可见。
- NOTES_CLEANUP 和 PHOTO_TAGS_CLEANUP 中途失败后从游标继续，不重复递减计数。
- 重复 delete 返回同一 task。
- finalize 重放不重复扣减 `used_bytes`。
- task 完成后对象、photo、notes、photo_tags 均不存在，tags 保留且计数正确。
- 删除处理中查询只返回公开状态，不返回内部错误。

### 12.5 Cursor 分页

- 40 条完全相同时间戳数据按 `_id` 稳定返回，无重复遗漏。
- 第一页后插入更晚数据，后续页不重复；下拉刷新后可见新数据。
- 第一页后删除未读取项，后续页继续稳定。
- TAG 中混有 DELETING photo 和孤立关系时，能继续扫描并尽量填满 20 条。
- cursor 用于错误 scope/tagId/sortBy 时返回 INVALID_CURSOR。
- 篡改 cursor 不能读取其他用户数据。
- 代码扫描确认 photo/note 列表不再使用 `.skip()` 或加载全部关系。

### 12.6 存在性与越权

使用本人、他人、随机和已删除的 tagId/photoId/noteId/attemptId/taskId 逐一调用接口：

- 他人与不存在资源的 code、message 和响应字段相同。
- 不返回名称、数量、状态或关联信息。
- 日志不包含原始资源 ID、OPENID 和用户内容。
- 所有查询首先包含 `_openid` 条件。

### 12.7 故障注入

至少在以下位置注入异常：

- pending 下载前后。
- active 提升后、最终事务前。
- photo 插入、空间更新、attempt 确认之间。
- 删除对象前后。
- 每个删除数据库批次提交前后。
- finalize 的 photo 删除、空间扣减、task 完成之间。
- cursor 候选读取和 photo 批量读取之间。

任何故障不得产生无法由 attempt、删除任务或 cleanup 识别的半提交状态。

---

## 13. 基线回写与开发影响

### 13.1 必须回写的文档

| 文档 | 回写内容 |
|---|---|
| 主技术架构 | 上传 attempt、可信文件提升、配额事务、逻辑删除、cursor、统一错误策略 |
| 数据库初始化清单 | 第 7 个集合、全部新增/替换索引、客户端 DENY 权限 |
| PRD F-004/F-013 | confirm/cancel 的服务端线性化边界 |
| PRD F-012 | 删除申请接受、立即隐藏、后台物理清理和空间释放时点 |
| AC-027/028 | 区分删除申请失败与后台清理重试 |
| AC-036 | confirm 已先提交时属于成功项，取消不能逆转 |
| 非功能验收 | cursor 稳定性、配额并发、文件可信性、任务恢复 |

### 13.2 受影响实现

| 模块 | 主要改动 |
|---|---|
| `upload` 云函数 | prepare/confirm/cancel、文件验证与提升、租约、配额事务 |
| `photo` 云函数 | ACTIVE 过滤、cursor list、逻辑删除、删除状态 |
| `note` 云函数 | cursor list、ACTIVE photo 校验 |
| `tag` 云函数 | ACTIVE photo 校验、TAG cursor、统一 TAG_NOT_FOUND |
| `cleanup` 云函数 | attempt 过期、孤立对象、删除租约和分阶段推进 |
| 小程序上传服务 | 服务端签发路径、attemptId、批量取消、线性化结果处理 |
| 图片/备注页面 | nextCursor 状态替代 page |
| 删除状态交互 | 接受 PENDING/RETRYING，刷新最终空间 |

---

## 14. 开发完成定义

只有同时满足以下条件，7 个 P0 才视为关闭：

1. 本文所有新增集合、字段和唯一索引在实际开发环境验证成功。
2. 上传 confirm 不再接受或信任客户端 size、width、height、format。
3. 配额、photo 和 attempt 在同一事务提交。
4. cancel/confirm 并发测试符合服务端线性化表。
5. DELETING photo 在全部读写路径中均不可用。
6. 删除任务可从任意阶段安全重试并最终精确释放空间。
7. photo/note/TAG 分页不再使用 offset 或全量关系加载。
8. 外部接口无法区分他人资源与不存在资源。
9. 主技术架构、数据库清单和受影响 PRD/AC 已完成回写。
10. §12 的自动化、集成和故障注入测试全部通过。

---

## 评审结论

| 评审角色 | 结论 | 意见 | 日期 |
|---|---|---|---|
| 产品负责人 | 待评审 | 确认异步逻辑删除及 AC 口径调整 |  |
| 小程序研发 | 待评审 | 确认 attempt/cursor 客户端改造 |  |
| 服务端研发 | 待评审 | 确认事务、租约、索引和任务处理器 |  |
| 测试 | 待评审 | 确认并发、越权及故障注入范围 |  |
| 运维/云资源 | 待评审 | 确认触发器频率、权限和告警 |  |
