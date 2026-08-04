---
name: photo-notes-api-integration
description: >
  图片笔记小程序前端 API 对接规范。
  This skill should be used when developing pages or components that involve
  calling backend cloud functions, handling API response fields, or integrating
  with any of the 6 cloud function modules (user, upload, photo, note, tag, account).
  Trigger when the user asks to: add or modify API calls, create a new page that
  needs backend data, handle API responses, implement pagination (cursor-based),
  implement upload flow (three-step protocol), handle optimistic locking for notes,
  process batch operations, or any task involving wx.cloud.callFunction() calls.
---

# 图片笔记小程序 - 前端 API 对接规范

本 skill 用于指导前端页面和组件开发时如何正确对接后端云函数 API。

## 核心原则

### 调用方式

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

### 响应格式

```json
// 成功
{ "code": "SUCCESS", "data": { ... } }

// 失败
{ "code": "ERROR_CODE", "message": "用户可读的中文提示" }
```

### 全局约束

- **分页**：一律使用 `cursor`（HMAC 签名），禁止 `page`/`skip`
- **上传**：三步协议：`prepare → wx.cloud.uploadFile → confirm`
- **删除**：异步：提交后立即隐藏，后台 worker 最终清理
- **安全投影**：响应不含 `_openid`、`file_id`、`normalized_name`、内部租约
- **错误掩码**：他人/不存在/DELETING 资源统一返回安全错误，不泄露存在性

---

## 参考文档

详细的 API 接口定义（请求参数、响应格式、错误码、数据库 Schema）见 `references/api-details.md`。

当需要以下信息时，读取 `references/api-details.md`：
- 具体接口的参数列表和类型
- 响应字段的完整定义
- 错误码含义
- 数据库集合 Schema
- 环境变量与特性开关
- 异步删除管道流程

---

## 开发工作流

### 涉及接口对接时

1. 先确定需要哪个云函数模块（user/upload/photo/note/tag/account）
2. 读取 `references/api-details.md` 中对应章节，确认请求参数和响应格式
3. 按文档定义的参数名、类型、必填规则构造请求
4. 按文档定义的响应字段解析数据并驱动 UI

### 涉及分页时

- 必须使用 cursor-based 分页，禁止使用 page/skip
- 首页不传 cursor，后续页传入上一页返回的 `nextCursor`
- 直到 `hasMore === false` 停止加载

```js
// 首页
const page1 = await callPhoto('list', { scope: 'ALL', pageSize: 20 })
// 下一页
const page2 = await callPhoto('list', { scope: 'ALL', pageSize: 20, cursor: page1.nextCursor })
```

### 涉及上传时

必须遵循三步协议：
1. `prepare({ taskId })` → 获取 `attemptId` + `cloudPath`
2. `wx.cloud.uploadFile(cloudPath)` → 客户端直传
3. `confirm({ attemptId, fileId, shootTime, timeSource })` → 确认上传

⚠️ confirm 时禁止传 `size`、`width`、`height`、`format`、`taskId` 字段。

### 涉及备注更新时

必须使用乐观锁：传 `updatedAt`（当前备注的 `updated_at` 值）。
响应中检查 `conflict: true` 表示并发冲突，需提示用户并用返回的最新 `updated_at` 重试。

### 涉及删除时

- 图片删除是异步的，返回 `status: "PENDING"`，提交后立即隐藏
- 可通过 `getDeleteStatus` 查询删除进度
- 标签删除是同步的

### 涉及批量操作时

`batchAddPhotoTags` 返回三类结果：`successCount`、`invalidCount`、`limitExceededCount`。需要分别处理，不能假设全成功或全失败。

---

## 云函数模块速查

| 模块 | 云函数名 | 操作类型 |
|------|---------|---------|
| 用户与空间 | `user` | `login`, `getStatus`, `getSpaceUsage` |
| 上传 | `upload` | `prepare`, `confirm`, `cancel` |
| 图片 | `photo` | `list`, `detail`, `delete`, `getDeleteStatus` |
| 备注 | `note` | `add`, `update`, `delete`, `list` |
| 标签 | `tag` | `list`, `create`, `rename`, `delete`, `getPhotoTags`, `updatePhotoTags`, `batchAddPhotoTags` |
| 账号 | `account` | `requestDeletion`, `getDeletionStatus` |

---

## 关键注意事项

1. **禁止传多余字段**：confirm 接口传了 `size` 等字段会触发 `VALIDATION_ERROR`
2. **cursor 不可复用**：cursor 被篡改或跨 scope 复用会返回 `INVALID_CURSOR`
3. **图片删除后立即不可见**：list/detail/note/tag 均隐藏已 DELETING 的图片
4. **标签名有保留名**："全部"、"未分类" 不可使用
5. **标签上限**：每用户最多 100 个标签，每图片最多 5 个标签
6. **空间限制**：每用户 500MB，上传前检查空间
7. **错误掩码**：不存在的资源统一返回安全错误码，不区分"不存在"和"无权限"
8. **服务层文件**：`services/upload.js` 已改为新协议，`services/photos.js` 和 `services/notes.js` 的 list 需要改为 cursor 分页
