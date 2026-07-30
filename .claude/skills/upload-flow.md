---
name: upload-flow
description: Complete upload pipeline guidance from media selection through cloud confirmation. Triggers on "上传", "upload", "图片上传", "上传流程".
---

# Upload Flow — 上传流程指导

图片上传的全链路指引，涵盖前端压缩、上传管道到后端三阶段确认协议。

## 一、上传状态机（upload-panel.js）

### 任务状态流转

```
pending → compressing → uploading → confirming → success | failed | cancelled
```

- `ACTIVE_STATUS = ['pending', 'compressing', 'uploading', 'confirming']`
- `FINAL_STATUS = ['success', 'failed', 'cancelled']`

### 关键机制

- **`_batchGeneration` 计数器**：每次取消操作递增，回调中检查 `_isRunnable(taskId, generation)` 防止过期回调
- **`_pumpQueue()`**：维持并发上限，自动从队列中取新任务
- **`cancelActiveTasks()`**：递增 generation、中断进行中的上传（`_uploadHandles[taskId].abort()`）、标记活跃任务为 cancelled

### 文件选择

```javascript
wx.chooseMedia({
  count: remaining,
  mediaType: ['image'],
  sizeType: ['original'],
  sourceType: ['album', 'camera']
})
```

- taskId 格式：`task_${timestamp}_${index}_${random}`
- requestId 格式：`upload_${timestamp}_${random}`（即发送给云函数的 `taskId`）
- 最大数量：`C.UPLOAD_MAX_COUNT = 20`

## 二、单任务管线（按顺序）

### a. 格式校验

```javascript
validatePhotoFormat(ext)  // 仅允许 JPG, JPEG, PNG
```
参见 `utils/validator.js`

### b. 大小校验

```javascript
validatePhotoSize(fileSize)  // 最大 20MB
```
参见 `utils/constants.js` → `UPLOAD_MAX_SIZE`

### c. EXIF 提取

```javascript
const { shootTime, timeSource } = await extractShootTime(filePath)
// timeSource = 'EXIF' | 'UPLOAD_TIME'
```
参见 `utils/exif.js` — 解析 TIFF 头中的 DateTimeOriginal (0x9003)

### d. 图片压缩

```javascript
const compressed = await compress(filePath)
// { path, size, width, height }
```
参见 `utils/compress.js` — Canvas 离屏压缩：
- 最长边 ≤ 2560px
- JPEG 初始质量 85%，目标 ≤ 3MB
- 逐步降质量（每次 -15%），不低于 30% 最低质量
- 仍失败则标记无法处理

### e. 文件上传

```javascript
const uploadTask = wx.cloud.uploadFile({
  cloudPath,          // 服务端签发的 uploads/pending/{random32}.bin
  filePath: compressed.path
})
this._uploadHandles[taskId] = uploadTask  // 追踪以便取消
```

### f. 服务端确认

```javascript
const result = await uploadService.confirm({
  fileId, size, width, height, format,
  shootTime, timeSource, taskId
})
// 返回 { photo: { _id, ... }, duplicated }
```

## 三、后端三阶段协议

### prepare

```
client → upload/prepare { taskId }
server → { attemptId, cloudPath, expiresAt, photoId? } (photoId 仅在重复时返回)
```

- 签发 attempt（状态：PREPARED）
- 生成随机 cloudPath：`uploads/pending/{random32}.bin`
- 24h TTL
- 唯一约束：`(_openid, task_id)` — 重复返回已有 photoId

### confirm

```
client → upload/confirm { attemptId, fileId, shootTime, timeSource }
```

服务端流程：
1. 获取 confirm lease（+2min）
2. 下载文件 → 验证 magic bytes → sharp 解码验证 → 生成缩略图
3. 内容审核（`cloud.openapi.security.imgSecCheck`）— fail-closed
4. 提升文件到 `photos/active/`
5. 原子事务：create photo + update `used_bytes` + mark CONFIRMED

### cancel

```
client → upload/cancel { attemptIds: [...] }
server → { results: [{ attemptId, status, photoId? }] }
```

- 事务线性化：confirm 先于 cancel 提交则返回 CONFIRMED + photoId
- 批量 cancel（一次可取消多个 attempt）

## 四、补偿机制

cleanup 定时器（两个触发器）：
- **高频**（每 5 分钟）：重试失败删除任务
- **全量**（每日 03:00）：
  - 过期 attempt 补偿（`EXPIRED` 标记 + 清理 pending 文件）
  - 孤立 photo_tags 清理
  - 计数校正（`tags.photo_count` / `photos.tag_count`）

## 五、关键常量

参见 `miniprogram/utils/constants.js`：

```javascript
UPLOAD_CONCURRENCY = 3          // 并发上传数
UPLOAD_MAX_COUNT = 20           // 单次最大选择数
UPLOAD_MAX_SIZE = 20 * 1024 * 1024  // 单文件最大 20MB
COMPRESS_MAX_EDGE = 2560        // 压缩最大边长
COMPRESS_TARGET_SIZE = 3 * 1024 * 1024  // 压缩目标 3MB
COMPRESS_INITIAL_QUALITY = 85   // 初始 JPEG 质量
COMPRESS_MIN_QUALITY = 30       // 最低 JPEG 质量
UPLOAD_ALLOWED_FORMATS = ['JPG', 'JPEG', 'PNG']
```

## 六、常见问题

| 问题 | 排查方向 |
|------|---------|
| 上传重复 | task_id 唯一约束保证幂等，相同 task_id 返回已有 photo |
| 空间不足 | 上传前调用 `authService.getSpaceUsage()` 检查配额 |
| 过期回调 | `_isRunnable(taskId, generation)` 防止取消后的回调更新 UI |
| 文件泄漏 | cancel 后调用 `wx.cloud.deleteFile` 清理已上传临时文件 |
| 确认失败 | 检查错误码：`SPACE_EXCEEDED`、`CONTENT_REVIEW_FAILED`、`UPLOAD_FILE_INVALID` |
| 压缩失败 | Canvas 离屏 API 在部分设备不可用，检查 `wx.createOffscreenCanvas` |

## 核心参考文件

- [components/upload-panel/](miniprogram/components/upload-panel/) — 上传面板组件
- [utils/compress.js](miniprogram/utils/compress.js) — Canvas 离屏压缩
- [utils/exif.js](miniprogram/utils/exif.js) — EXIF 提取
- [utils/validator.js](miniprogram/utils/validator.js) — 文件校验
- [utils/constants.js](miniprogram/utils/constants.js) — 上传相关常量
- [cloudfunctions/upload/](cloudfunctions/upload/) — 上传云函数
- [cloudfunctions/_shared/transaction.js](cloudfunctions/_shared/transaction.js) — 事务重试
- [cloudfunctions/cleanup/](cloudfunctions/cleanup/) — 补偿定时器
