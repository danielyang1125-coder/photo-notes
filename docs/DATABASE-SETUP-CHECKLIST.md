# 数据库初始化清单 — 图片笔记小程序 V1.0.0

> **关联文档**：[TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md](./TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md)  
> **初始化脚本**：[scripts/db-init.js](../scripts/db-init.js)  
> **目标环境**：`cloud1-d0gsee3m13c2b446c`（dev）

---

## 0. 初始化方式

| 方式 | 适用场景 | 工具 |
|---|---|---|
| **脚本初始化**（推荐） | 可重复执行、可审计、可 CI | `node scripts/db-init.js` |
| **控制台手动** | 首次快速验证、无命令行环境 | 微信开发者工具 → 云开发 → 数据库 |

无论哪种方式，初始化后必须执行 §4 的验证步骤。

---

## 1. 集合与索引总览

### 1.1 `users` — 用户

| 索引 | 字段 | 类型 | 说明 |
|---|---|---|---|
| `status_idx` | `status: 1` | 普通 | cleanup 扫描 DELETING/DELETED 用户 |

> ⚠️ 不需要手动创建 `_openid` 索引。CloudBase 对系统字段 `_openid` 已有内置索引；且 `_id = _openid`，主键本身唯一。手动创建会报冲突，此为预期行为。

**安全权限**：仅云函数可读写（`READONLY` 对客户端）。

### 1.2 `photos` — 图片

| 索引 | 字段 | 类型 | 说明 |
|---|---|---|---|
| `list_idx` | `_openid: 1, upload_time: -1` | 普通 | 全部图片列表分页 |
| `uncategorized_idx` | `_openid: 1, tag_count: 1, upload_time: -1` | 普通 | 未分类图片查询（`tag_count = 0`） |
| `shoot_time_idx` | `_openid: 1, shoot_time: -1` | 普通 | 备注列表按拍摄时间排序 |

**安全权限**：客户端不可直接读写。所有操作通过 photo/upload 云函数。

**前置条件**：`uncategorized_idx` 创建前，必须对所有已有 `photos` 记录执行 `tag_count: 0` 回填。详见 §3。

### 1.3 `notes` — 备注

| 索引 | 字段 | 类型 | 说明 |
|---|---|---|---|
| `photo_idx` | `photo_id: 1` | 普通 | 根据图片 ID 查询备注列表 |
| `created_at_idx` | `_openid: 1, created_at: -1` | 普通 | 备注列表按创建时间排序 |
| `shoot_time_idx` | `_openid: 1, photo_shoot_time: -1` | 普通 | 备注列表按拍摄时间排序 |

**安全权限**：客户端不可直接读写。所有操作通过 note 云函数。

### 1.4 `tags` — 标签

| 索引 | 字段 | 类型 | 说明 |
|---|---|---|---|
| `name_unique` | `_openid: 1, normalized_name: 1` | **复合唯一** | 用户内标签名称唯一 |
| `list_idx` | `_openid: 1, last_used_at: -1, updated_at: -1, created_at: -1` | 普通 | 标签列表固定排序（最近使用优先） |

**安全权限**：客户端 `DENY` 所有读写。仅 tag 云函数可操作。

> ⚠️ `name_unique` 是业务正确性的基础设施。不建此索引，"先查后插"无法防止并发创建同名标签。

### 1.5 `photo_tags` — 图片-标签关联

| 索引 | 字段 | 类型 | 说明 |
|---|---|---|---|
| `relation_unique` | `_openid: 1, photo_id: 1, tag_id: 1` | **复合唯一** | 防止同一图片重复关联同一标签 |
| `tag_filter_idx` | `_openid: 1, tag_id: 1, photo_upload_time: -1` | 普通 | 按标签筛选图片分页 |
| `photo_relation_idx` | `_openid: 1, photo_id: 1` | 普通 | 单图标签查询、图片删除级联 |

**安全权限**：客户端 `DENY` 所有读写。仅 tag/photo/cleanup 云函数可操作。

### 1.6 `deletion_tasks` — 删除任务

| 索引 | 字段 | 类型 | 说明 |
|---|---|---|---|
| `user_status_idx` | `_openid: 1, status: 1` | 普通 | 查询用户待处理删除任务 |
| `retry_idx` | `status: 1, retry_count: 1` | 普通 | cleanup 扫描失败任务重试 |

**安全权限**：客户端不可读写。仅 account/photo/cleanup 云函数可操作。

---

## 2. 集合安全权限配置

在云开发控制台 → 数据库 → 选择集合 → 权限设置：

| 集合 | 权限 | 说明 |
|---|---|---|
| `users` | **仅创建者可读写** | 用户只通过云函数访问自己的记录 |
| `photos` | **仅创建者可读写** | 同上 |
| `notes` | **仅创建者可读写** | 同上 |
| `tags` | **自定义安全规则**（拒绝所有客户端） | `{ "read": false, "write": false }` |
| `photo_tags` | **自定义安全规则**（拒绝所有客户端） | `{ "read": false, "write": false }` |
| `deletion_tasks` | **仅创建者可读写** | 用户只通过云函数访问自己的记录 |

所有业务数据的 `_openid` 隔离在云函数中通过 `cloud.getWXContext().OPENID` 强制实施。

---

## 3. 数据回填：`photos.tag_count`

`photos` 集合中的 `tag_count` 字段默认值必须为 `0`。如果环境中有测试图片（例如 QuickStart 遗留数据），需要执行回填：

```javascript
// 在 user 云函数中临时添加，或通过云开发控制台数据库操作执行
const _ = db.command
await db.collection('photos')
  .where({ tag_count: _.exists(false) })
  .update({ data: { tag_count: 0 } })
```

回填完成并验证后，再创建 `uncategorized_idx` 索引。如果跳过回填直接创建索引，已有图片在【未分类】查询中将被遗漏。

---

## 4. 初始化后验证

### 4.1 索引存在性

在云开发控制台 → 数据库 → 选择集合 → 索引管理，逐一核对 §1 中列出的全部索引。

或者在云函数中执行：

```javascript
const collections = ['users','photos','notes','tags','photo_tags','deletion_tasks']
for (const name of collections) {
  const result = await db.collection(name).get()
  console.log(`${name}: ${result.data.length} docs`)
}
```

### 4.2 唯一键冲突验证

在 user 云函数中临时添加测试逻辑，验证：

1. 插入两条 `normalized_name` 相同的 `tags` 记录，第二条应抛唯一键冲突。
2. 插入两条 `(photo_id, tag_id)` 相同的 `photo_tags` 记录，第二条应抛唯一键冲突。

确认错误结构和错误码可在代码中映射。

### 4.3 事务能力验证

在 user 云函数中验证 `db.startTransaction()` 可用：

```javascript
const transaction = await db.startTransaction()
try {
  // 测试读写
  await transaction.collection('photos').add({ data: { _openid: 'test', tag_count: 0 }})
  await transaction.commit()
} catch (e) {
  await transaction.rollback()
  console.error('事务测试失败:', e)
}
```

### 4.4 核心链路验证

按顺序验证最小闭环：

```
1. user/login  → 返回 { status: 'ACTIVE', isNewUser: true }
2. wx.cloud.uploadFile() → 返回 fileID
3. upload/confirm → 创建 photo 记录，返回 photoId
4. cloud.getTempFileURL() → 返回可访问临时 URL
5. imageMogr2 参数拼接 → 缩略图正常显示
```

---

## 5. 操作记录

| 日期 | 操作人 | 操作内容 | 结果 |
|---|---|---|---|
| — | — | — | — |

初始化完成后在此记录，便于审计和问题回溯。
