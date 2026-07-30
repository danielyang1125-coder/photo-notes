---
name: backend-review
description: Review backend code against project conventions (router, auth, validation, error handling, cursor, transactions, security). Triggers on "review后端", "backend review", "检查后端".
---

# Backend Review — 后端代码评审

按照项目规范逐项检查后端代码，覆盖 12 个检查维度。

## 检查清单

### 1. Router 模式

- [ ] 云函数使用 `createBusinessMain`（非手动路由）
- [ ] `domain` 设置正确（与云函数名一致）
- [ ] 所有 type handler 在 `handlers` 对象中注册
- [ ] 定时触发函数使用 `createTimerMain`
- [ ] `createSecurityLogger` 已使用（非 `console.log/error`）

### 2. Auth 与数据隔离

- [ ] 所有查询过滤 `_openid`（非豁免 type 除外）
- [ ] 资源归属验证后再操作：`{ _id, _openid }`
- [ ] `getOpenId(cloud)` 用于身份提取（非手动解析）
- [ ] `findOwnedResource()` 用于常见所有权检查
- [ ] `activeGuardExempt` 仅包含：login、getStatus、healthCheck、getDeletionStatus

### 3. 输入校验

- [ ] 使用 `validation.requireObject(event)` 在 handler 开头
- [ ] 所有用户输入通过 shared `validation` 模块校验
- [ ] 使用正确的校验函数：`validation.string`、`validation.array`、`validation.enumValue`、`validation.requestId`、`validation.isoDate`
- [ ] 避免手写 `if(!x) return {...}` 模式

### 4. 错误处理

- [ ] 业务错误使用 `throw new AppError('ERROR_CODE')`
- [ ] **无**原始 `error.message` 暴露给客户端
- [ ] **无**`catch` 后空返回（让 router 统一处理）
- [ ] 使用 `errorResponse()` 映射 AppError 到公开消息
- [ ] `PUBLIC_MESSAGES` 中有对应错误码定义
- [ ] 唯一索引冲突使用 `isUniqueConflict()` 处理
- [ ] 不存在/越权/已删除使用统一错误码（不泄露存在性）

### 5. 响应格式

- [ ] 成功：`return success(data)`
- [ ] 失败：`return failure(code, message?)` 或 `throw new AppError(code)`
- [ ] 响应格式：`{ code, data?, message? }`

### 6. Cursor 分页

- [ ] 列表接口使用 keyset cursor（**无 `.skip()`**）
- [ ] cursor 通过 `encodeCursor()` 生成（HMAC 签名）
- [ ] cursor 通过 `decodeCursor()` 解码
- [ ] 使用 `keysetCondition()` 生成复合排序 MongoDB 查询
- [ ] `CURSOR_HMAC_SECRET` 缺失时拒绝服务（`INTERNAL_ERROR`）

### 7. 事务使用

- [ ] 多集合写入使用 `withTransactionRetry(db, async (tx) => {...})`
- [ ] 事务内使用 `tx.collection('name')`
- [ ] 最多重试 3 次
- [ ] `isRetryableConflict(error)` 判断可重试冲突
- [ ] 计数更新（used_bytes、photo_count 等）在同一事务内完成

### 8. 安全日志

- [ ] 使用 `logger.info({ event, result, safeErrorCode, durationMs })`
- [ ] 日志仅包含 `ALLOWED_FIELDS`：event、result、safeErrorCode、durationMs、countBucket、requestIdHash、resourceHash、timestamp
- [ ] **绝无** OPENID、fileID、URL、标签名、备注内容、图片内容
- [ ] 敏感 ID 使用 `digest(value)` HMAC 摘要
- [ ] 数值使用 `countBucket(n)` 替代精确值

### 9. 性能

- [ ] 避免 N+1 查询
- [ ] 列表使用复合索引（验证索引覆盖查询条件）
- [ ] 避免 `_.in()` 使用超大数组（>100）
- [ ] 时间字段使用 `db.serverDate()`

### 10. 幂等性

- [ ] 关键操作使用唯一约束防止重复
- [ ] task_id/attempt_id 等幂等键有唯一索引
- [ ] 重复请求返回已有结果（非错误）

### 11. 配置

- [ ] Feature Flag 通过 `config.boolean('FLAG')` 读取
- [ ] 密钥通过 `config.requiredString('SECRET')` 读取
- [ ] 密钥缺失时硬拒绝（不降级）

### 12. 禁止模式（backend-check.js 扫描）

- [ ] 无 `.skip()` 分页（新代码；旧代码仅 photo/note 允许临时期）
- [ ] 无 `console.log` / `console.error`（使用 security-logger）
- [ ] 无 `error.message` 直接返回
- [ ] 无客户端 fileID/meta 信任

## 核心参考文件

- [cloudfunctions/_shared/](cloudfunctions/_shared/) — 所有共享模块源码
- [scripts/backend-check.js](scripts/backend-check.js) — 禁止模式扫描
- [scripts/backend-audit.js](scripts/backend-audit.js) — 结构审计（134 个检查项）
- [docs/BACKEND-IMPLEMENTATION-AUDIT-图片笔记小程序-V1.0.0.md](docs/BACKEND-IMPLEMENTATION-AUDIT-图片笔记小程序-V1.0.0.md) — 审计指南
- [docs/TECHNICAL-ARCHITECTURE.md §2.1](docs/TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md) — 核心不变量
