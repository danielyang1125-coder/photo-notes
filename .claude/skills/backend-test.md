---
name: backend-test
description: Write backend unit tests following project patterns (node:test, in-memory mocks, dependency injection). Triggers on "写测试", "add test", "backend test".
---

# Backend Test — 编写后端测试

按照项目测试模式编写 `node:test` 单元测试。

## 测试框架

- **运行器**：Node.js 内置 `node:test`
- **断言**：`node:assert/strict`
- **不引入**：Jest、Mocha 等外部框架
- **运行命令**：`npm run backend:test`（先同步共享模块，再执行 `node --test test/backend`）

## 文件位置

`test/backend/<module-name>.test.js`

## Mock 模式

### 依赖注入

被测模块使用工厂函数，通过参数接收外部依赖：

```javascript
// 被测模块导出工厂函数（便于测试）
function createUserHandlers({ db, now, cloud }) {
  return {
    async login(openid) { /* ... */ },
    async getStatus(openid) { /* ... */ }
  }
}
```

### 内存数据库 Mock

```javascript
function createUserDb(seed = []) {
  const documents = new Map(
    seed.map(item => {
      const doc = { ...item }
      return [doc._id, doc]
    })
  )

  const db = {
    collection(name) {
      return {
        where(condition) {
          return {
            async get() {
              const filtered = [...documents.values()].filter(doc => {
                return Object.entries(condition).every(([k, v]) => doc[k] === v)
              })
              return { data: filtered }
            },
            async update({ data }) {
              let updated = 0
              for (const [id, doc] of documents) {
                if (Object.entries(condition).every(([k, v]) => doc[k] === v)) {
                  Object.assign(doc, data)
                  updated++
                }
              }
              return { stats: { updated } }
            },
            async remove() {
              let deleted = 0
              for (const [id, doc] of documents) {
                if (Object.entries(condition).every(([k, v]) => doc[k] === v)) {
                  documents.delete(id)
                  deleted++
                }
              }
              return { stats: { removed: deleted } }
            }
          }
        },

        doc(id) {
          return {
            async get() {
              const doc = documents.get(id)
              return { data: doc ? [doc] : [] }
            },
            async update({ data }) {
              const doc = documents.get(id)
              if (doc) Object.assign(doc, data)
              return { stats: { updated: doc ? 1 : 0 } }
            }
          }
        },

        async add({ data }) {
          const doc = { _id: `generated_${Date.now()}_${Math.random()}`, ...data }
          documents.set(doc._id, doc)
          return { _id: doc._id }
        }
      }
    },

    serverDate() { return new Date('2026-01-01T00:00:00Z') },

    // 暴露内部状态用于验证
    inspect() {
      return {
        documents: new Map(documents),
        count: documents.size
      }
    }
  }

  return db
}
```

## 测试结构

```javascript
const test = require('node:test')
const assert = require('node:assert/strict')

// 按模块组织
test('module name', async (t) => {

  // 正常流程
  await t.test('正常流程 - 描述', async () => {
    const db = createUserDb([
      { _id: 'user1', status: 'ACTIVE', used_bytes: 0 }
    ])
    const handlers = createUserHandlers({ db, now: () => new Date('2026-01-01') })

    const result = await handlers.getStatus('user1')

    assert.equal(result.code, 'SUCCESS')
    assert.equal(result.data.status, 'ACTIVE')
  })

  // 边界条件
  await t.test('边界条件 - 空结果', async () => {
    const db = createUserDb([])
    const result = await handlers.list('user1')
    assert.equal(result.data.list.length, 0)
    assert.equal(result.data.hasMore, false)
  })

  // 错误路径
  await t.test('错误路径 - 不存在返回 NOT_FOUND', async () => {
    const db = createUserDb([])
    await assert.rejects(
      async () => {
        const handlers = createUserHandlers({ db })
        await handlers.getResource('user1', 'nonexistent_id')
      },
      (err) => err.code === 'NOT_FOUND'
    )
  })

  // 安全场景
  await t.test('安全 - 越权访问统一返回 NOT_FOUND', async () => {
    const db = createUserDb([
      { _id: 'resource1', _openid: 'owner', status: 'ACTIVE' }
    ])
    await assert.rejects(
      async () => {
        const handlers = createUserHandlers({ db })
        await handlers.getResource('intruder', 'resource1')
      },
      (err) => err.code === 'NOT_FOUND'
    )
  })

  // 并发测试
  await t.test('并发 - 重复登录幂等', async () => {
    const db = createUserDb([])
    const handlers = createUserHandlers({ db })
    const results = await Promise.all([
      handlers.login('user1'),
      handlers.login('user1'),
      handlers.login('user1')
    ])
    const ids = results.map(r => r.data.user._id)
    assert.equal(new Set(ids).size, 1)  // 只有一个用户记录
  })
})
```

## 测试覆盖要求

### 共享模块（必须全覆盖）

| 模块 | 测试重点 |
|------|---------|
| `router` | 未知 type 拒绝、ACTIVE 守卫矩阵、豁免 type、错误标准化 |
| `auth` | getOpenId、requireActiveUser 状态矩阵、findOwnedResource |
| `response` | AppError 实例化、success/failure 格式、errorResponse 映射 |
| `validation` | 字符串 Unicode code point、枚举、数组、requestId、ISO 日期、可选 |
| `cursor` | encode/decode 往返、签名验证、版本检查、过期检测 |
| `transaction` | isUniqueConflict 各种错误码、isRetryableConflict |
| `security-log` | ALLOWED_FIELDS、digest、countBucket、sanitize |
| `config` | requiredString 缺失抛错、boolean 默认值 |

### 业务逻辑（按需）

- user: 并发登录幂等、状态投影无 PII、空间计算
- upload attempt: prepare→confirm→cancel 状态机、过期、并发
- upload confirm: 完整流程 mock、内容审核、配额检查
- upload compensation: 过期清理、orphan 处理
- db-init: CLI 参数解析、plan 构建、CloudBase adapter

## 关键模式

- `assertNoIdentity(value)` — 验证无 PII 泄露
- `Promise.all()` — 测试并发操作幂等性
- 测试边界：空结果、最大限制、临界时间戳
- 每个测试独立：不依赖其他测试的副作用

## 核心参考文件

- [test/backend/user.test.js](test/backend/user.test.js) — 完整业务测试示例
- [test/backend/router.test.js](test/backend/router.test.js) — Router 测试模式
- [test/backend/validation.test.js](test/backend/validation.test.js) — 校验测试模式
- [test/backend/upload-confirm.test.js](test/backend/upload-confirm.test.js) — 复杂流程测试
- [test/backend/db-init.test.js](test/backend/db-init.test.js) — CLI 脚本测试
