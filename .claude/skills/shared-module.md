---
name: shared-module
description: Add or modify a shared module in _shared/ and sync to all cloud functions. Triggers on "共享模块", "shared module", "修改_shared".
---

# Shared Module — 共享模块开发

在 `cloudfunctions/_shared/` 中新建或修改共享模块，并同步到所有云函数的 `lib/shared/`。

## 架构原则

- 共享模块单一源文件位于 `cloudfunctions/_shared/`
- 通过 `scripts/sync-cloudfunction-shared.js` 同步到各云函数的 `lib/shared/`
- `lib/shared/` 中的副本纳入版本控制，**业务代码不得直接修改**
- 仅 `.js` 文件会被同步（扁平结构，不支持子目录）

## 现有模块职责

| 模块 | 导出 | 用途 |
|------|------|------|
| `router.js` | `createBusinessMain`, `createTimerMain` | 云函数入口框架（所有云函数依赖） |
| `response.js` | `AppError`, `success()`, `failure()`, `errorResponse()`, `PUBLIC_MESSAGES` | 统一响应格式 + 30+ 错误码映射 |
| `validation.js` | `requireObject`, `string`, `integer`, `enumValue`, `array`, `isoDate`, `requestId`, `optional` | 输入校验（对标前端 `utils/validator.js`） |
| `auth.js` | `getOpenId()`, `requireActiveUser()`, `findOwnedResource()` | OPENID 提取 + ACTIVE 守卫 + 资源归属 |
| `cursor.js` | `encodeCursor()`, `decodeCursor()`, `keysetCondition()`, `CURSOR_VERSION` | HMAC cursor 编解码 + 复合排序条件 |
| `transaction.js` | `withTransactionRetry()`, `isUniqueConflict()`, `isRetryableConflict()` | 事务重试（最多 3 次）+ 冲突检测 |
| `security-log.js` | `createSecurityLogger()`, `sanitize()`, `digest()`, `countBucket()` | 结构化安全日志（allowlist 字段 + HMAC 摘要） |
| `config.js` | `requiredString()`, `boolean()` | 环境变量读取（缺失抛错） |

## 新建共享模块

```bash
# 1. 创建源文件
touch cloudfunctions/_shared/new-module.js
```

```javascript
// cloudfunctions/_shared/new-module.js
'use strict'

/**
 * 模块描述
 */
function publicFunction(param) {
  // 实现
}

module.exports = {
  publicFunction
}
```

```bash
# 2. 同步到所有云函数
npm run backend:sync

# 3. 验证完整性
npm run backend:check

# 4. 运行测试
npm run backend:test
```

## 修改已有共享模块

1. 编辑 `cloudfunctions/_shared/<module>.js`
2. 运行 `npm run backend:sync` 同步到所有云函数的 `lib/shared/`
3. 运行 `npm run backend:check` 验证无 drift
4. 运行 `npm run backend:test` 确保测试通过
5. 如修改函数签名，更新所有使用该模块的云函数业务代码
6. **部署受影响的云函数** — 必须重新部署才能使修改生效

> ⚠️ **关键**：只改 `_shared/` 源文件**不会**直接生效。云函数运行时引用的是自身目录下的 `lib/shared/` 副本，必须经过 同步 → 部署 两步才能在线上生效。漏掉任一步都会导致线上代码仍是旧版本。

## 为什么每个云函数有自己的副本？

CloudBase 的部署模型决定了每个云函数是**独立部署单元**——部署时只上传自身目录内的文件，无法引用 `../_shared/` 这类外部路径。因此：

```text
cloudfunctions/_shared/          ← 唯一真相源（开发时在此编辑）
    ├── cursor.js
    ├── router.js
    └── ...

cloudfunctions/photo/
    └── lib/shared/              ← photo 云函数的本地副本（运行时引用）
        ├── cursor.js            ← 由 npm run backend:sync 自动同步
        ├── router.js
        └── ...

cloudfunctions/note/
    └── lib/shared/              ← note 云函数的本地副本
        └── ...
```

`npm run backend:sync` 将 `_shared/` 下的所有 `.js` 文件复制到每个云函数的 `lib/shared/` 目录，保证所有副本与源一致。

## 完整修改 → 生效链路

```text
编辑 _shared/xxx.js → npm run backend:sync → npm run backend:test → 部署云函数 → 线上生效
```

部署方式参考 [[backend-deploy]]。

## 重要约束

- **禁止**从 `_shared/` 之外导入（禁止 `require('../...')`）
- **禁止**在共享模块中使用 `wx-server-sdk`（保持环境无关）
- **禁止**在模块级变量中存储状态（纯函数，线程安全）
- **禁止**在共享模块中引入新的 npm 依赖
- 共享模块间依赖使用相对路径：`require('./other-module')`
- 单个模块最多依赖 1-2 个其他共享模块（保持低耦合）
- 每个共享模块必须有对应单元测试：`test/backend/<module>.test.js`

## 漂移检查

```bash
# 检查 lib/shared/ 副本是否与 _shared/ 源一致
node scripts/sync-cloudfunction-shared.js --check
```

## 排除规则

以下不会被同步：
- `cloudfunctions/_shared/` 自身
- `cloudfunctions/quickstartFunctions/`（遗留模板）

## 核心参考文件

- [cloudfunctions/_shared/](cloudfunctions/_shared/) — 所有共享模块源码
- [scripts/sync-cloudfunction-shared.js](scripts/sync-cloudfunction-shared.js) — 同步脚本
- [scripts/backend-check.js](scripts/backend-check.js) — 完整性检查
- [test/backend/](test/backend/) — 共享模块测试
