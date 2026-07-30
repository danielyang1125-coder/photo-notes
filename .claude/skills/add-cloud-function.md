---
name: add-cloud-function
description: Create a new cloud function or add a type handler to an existing one following the router pattern. Triggers on "新建云函数", "add cloud function", "新增API".
---

# Add Cloud Function — 新建云函数或 Handler

按照项目 router 模式创建新的云函数或在已有云函数中添加 type handler。

## 架构原则

- 每个业务域一个云函数 + type 路由
- **所有云函数必须使用 `createBusinessMain`**（来自 shared router）
- 定时触发函数使用 `createTimerMain`
- 文件结构：`cloudfunctions/<name>/index.js` + `package.json` + `config.json`

## 入口文件模板

```javascript
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const { createBusinessMain } = require('./lib/shared/router')
const { createSecurityLogger } = require('./lib/shared/security-log')
const logger = createSecurityLogger()

const { success, failure, AppError } = require('./lib/shared/response')
const validation = require('./lib/shared/validation')
const { findOwnedResource } = require('./lib/shared/auth')
const { withTransactionRetry, isUniqueConflict } = require('./lib/shared/transaction')
const { encodeCursor, decodeCursor, keysetCondition } = require('./lib/shared/cursor')
const config = require('./lib/shared/config')

// ===== Handlers =====

async function handleCreate({ openid, event, db, cloud, logger }) {
  // 1. 校验输入
  validation.requireObject(event)
  const name = validation.string(event.name, 'name', { minCodePoints: 1, maxCodePoints: 100 })

  // 2. 业务逻辑（所有查询过滤 _openid）
  const collection = db.collection('items')
  const result = await collection.add({
    data: {
      _openid: openid,
      name,
      status: 'ACTIVE',
      created_at: db.serverDate(),
      updated_at: db.serverDate()
    }
  })

  return success({ item: { _id: result._id, name } })
}

async function handleList({ openid, event, db, logger }) {
  validation.requireObject(event)
  const pageSize = validation.optional(() =>
    validation.integer(event.pageSize, 'pageSize', { min: 1, max: 100 }), 20)

  // keyset cursor 分页（必须，不用 skip）
  const cursor = event.cursor ? decodeCursor(event.cursor) : null
  const condition = keysetCondition(cursor)
  // ... 查询逻辑

  const nextCursor = list.length === pageSize
    ? encodeCursor({ upload_time: list[list.length - 1].upload_time, _id: list[list.length - 1]._id })
    : null

  return success({ list, nextCursor, hasMore: nextCursor !== null })
}

async function handleDelete({ openid, event, db, logger }) {
  validation.requireObject(event)
  const id = validation.string(event.id, 'id')

  // 资源所有权检查
  const item = await findOwnedResource(db, 'items', openid, id)
  // findOwnedResource 不存在/越权/已删除统一抛 AppError('NOT_FOUND')

  await db.collection('items').doc(item._id).update({
    data: {
      status: 'DELETING',
      updated_at: db.serverDate()
    }
  })

  return success({ deleted: true })
}

// ===== 路由注册 =====

exports.main = createBusinessMain({
  domain: '<functionName>',
  cloud,
  db,
  logger,
  activeGuardExempt: [],  // 仅 login / getStatus / healthCheck / getDeletionStatus 可豁免
  handlers: {
    create: ({ openid, event }) => handleCreate({ openid, event, db, cloud, logger }),
    list: ({ openid, event }) => handleList({ openid, event, db, logger }),
    delete: ({ openid, event }) => handleDelete({ openid, event, db, logger })
  }
})
```

## 关键约束

### Router
- `createBusinessMain({ domain, cloud, db, logger, activeGuardExempt, handlers })`
- 自动处理：type 校验、OPENID 提取、ACTIVE 守卫、错误包装、安全日志
- `activeGuard = true` 默认，**仅以下 type 可豁免**：`login`、`getStatus`、`healthCheck`、`getDeletionStatus`
- `domain` 必须与云函数名一致

### 定时触发函数
使用 `createTimerMain` 代替 `createBusinessMain`：
```javascript
exports.main = createTimerMain({
  domain: 'cleanup',
  logger,
  handler: () => handleCleanup({ db, cloud, logger })
})
```

### 错误处理
- 预期业务错误：`throw new AppError('ERROR_CODE')`
- 校验失败：返回 `{ code: 'VALIDATION_ERROR', message: '...' }`
- **绝不**暴露原始 `error.message` 给客户端
- **绝不** catch 后空返回（让 router 统一 wrap）
- 使用 `PUBLIC_MESSAGES` 映射错误码到用户友好消息

### 数据隔离
- 所有查询第一个过滤条件：`{ _openid: openid }`
- 资源所有权：`{ _id: resourceId, _openid: openid }`
- 使用 `findOwnedResource(db, collection, openid, id)` 通用模式
- 不存在/越权/已删除统一返回 `NOT_FOUND`（不泄露存在性）

### 分页（Cursor）
- **所有列表接口必须使用 keyset cursor**，禁止 `.skip()`
- cursor 通过 `encodeCursor()`/`decodeCursor()` HMAC 签名防篡改
- 使用 `keysetCondition(cursor)` 生成复合排序条件
- cursor 密钥缺失时返回 `INTERNAL_ERROR`（禁止无签名降级）

### 事务
- 多集合写入使用 `withTransactionRetry(db, async (transaction) => {...})`
- 使用 `transaction.collection('name')` 而非 `db.collection('name')`
- 使用 `isUniqueConflict(error)` 检测唯一约束冲突
- 使用 `isRetryableConflict(error)` 判断是否可重试

### 安全日志
- 使用 `logger.info({ event, result, safeErrorCode, durationMs })`
- **绝不**记录 OPENID、fileID、URL、标签名、图片内容、备注文本
- 使用 `digest(value)` 做 HMAC 摘要替代原始 ID
- 使用 `countBucket(n)` 替代精确数值

### 配置
- 通过 `config.requiredString('KEY')` 读取必填配置（缺失抛错）
- 通过 `config.boolean('FLAG')` 读取 Feature Flag

## 新建云函数清单

创建新云函数需要以下文件：

| 文件 | 内容 |
|------|------|
| `index.js` | 入口 + handler 实现 |
| `package.json` | `{ "dependencies": { "wx-server-sdk": "latest" } }` |
| `config.json` | `{}`（非定时触发）或触发器配置 |

## 部署前必须

```bash
npm run backend:sync    # 同步 _shared/ → lib/shared/
```

## 核心参考文件

- [cloudfunctions/photo/index.js](cloudfunctions/photo/index.js) — createBusinessMain 标准示例
- [cloudfunctions/cleanup/index.js](cloudfunctions/cleanup/index.js) — createTimerMain 示例
- [cloudfunctions/_shared/router.js](cloudfunctions/_shared/router.js) — createBusinessMain / createTimerMain 源码
- [cloudfunctions/_shared/response.js](cloudfunctions/_shared/response.js) — AppError / success / failure / PUBLIC_MESSAGES
- [cloudfunctions/_shared/validation.js](cloudfunctions/_shared/validation.js) — 输入校验函数
- [cloudfunctions/_shared/auth.js](cloudfunctions/_shared/auth.js) — findOwnedResource
- [cloudfunctions/_shared/cursor.js](cloudfunctions/_shared/cursor.js) — cursor 编解码
- [docs/TECHNICAL-ARCHITECTURE.md §4](docs/TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md) — 后端架构
