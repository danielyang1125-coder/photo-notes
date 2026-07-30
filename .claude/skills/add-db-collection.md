---
name: add-db-collection
description: Add a new database collection with schema definition, indexes, and db-init integration. Triggers on "新建集合", "add collection", "新增表".
---

# Add DB Collection — 新增数据库集合

在微信云开发云数据库中新增集合，含 schema 定义、索引和初始化逻辑。

## 架构原则

- `scripts/backend-schema.js` 是**单一事实源**——所有集合定义集中在此
- `scripts/db-init.js` 负责执行初始化
- 客户端访问权限默认**拒绝**——所有操作通过云函数

## 步骤一：定义 Schema

在 `scripts/backend-schema.js` 的 `COLLECTIONS` 数组中添加：

```javascript
{
  name: 'new_collection',
  backfill: [
    // 仅当给已有集合添加新字段时需要
    { field: 'new_field', value: 'DEFAULT_VALUE' }
  ],
  indexes: [
    {
      // 唯一索引：<entity>_<field>_unique
      name: 'new_collection_key_unique',
      keys: { _openid: 1, business_key: 1 },
      unique: true
    },
    {
      // 普通索引：<entity>_<purpose>_idx
      name: 'new_collection_list_idx',
      keys: { _openid: 1, sort_field: -1, _id: -1 }
    }
  ]
}
```

### 索引命名规范

| 类型 | 格式 | 示例 |
|------|------|------|
| 唯一索引 | `<entity>_<field>_unique` | `tag_name_unique` |
| 普通索引 | `<entity>_<purpose>_idx` | `photo_list_cursor_idx` |

### 字段约定

- **`_openid`**：每个集合必须保留此字段用于数据隔离
- **`_id`**：自动生成（ObjectId 或显式设置如 users 表 `_id = _openid`）
- **时间戳**：`created_at`、`updated_at` 使用 `db.serverDate()`
- **状态字段**：软删除使用 `status` 字段（`ACTIVE` / `DELETING` / ...）
- **冗余字段**：允许为查询优化添加冗余字段，必须注释说明
- **禁止存储**：临时 URL（使用 `cloud.getTempFileURL()` 实时获取）

### 索引设计原则

- 每个集合至少有 `_openid` 作为首字段的过滤索引
- Keyset cursor 分页需要复合排序索引：`{ _openid: 1, sortField: -1, _id: -1 }`
- 幂等键使用唯一复合索引：`{ _openid: 1, task_id: 1 }`
- 状态查询需要 `{ status: 1, ... }` 前缀
- 每个集合索引数控制在 3-5 个

## 步骤二：更新 db-init.js

`db-init.js` 会自动读取 `backend-schema.js` 中的 `COLLECTIONS` 数组，无需手动更新列表。

如果新增的集合需要额外初始化逻辑（如创建默认数据），在 `db-init.js` 中添加对应处理。

## 步骤三：运行迁移

```bash
# 预览变更
node scripts/db-init.js --dry-run --env <environment-id>

# 确认执行
node scripts/db-init.js --apply --env <environment-id>
```

需要环境变量：`CLOUDBASE_SECRET_ID`、`CLOUDBASE_SECRET_KEY`

## 步骤四：后续检查

1. 运行审计：`npm run backend:audit`
2. 确认新集合索引正确创建
3. 考虑是否需要在 cleanup 定时器中添加孤立数据清理逻辑
4. 更新 [DATABASE-SETUP-CHECKLIST.md](docs/DATABASE-SETUP-CHECKLIST.md)

## 现有集合参考

| 集合 | 索引数 | 唯一约束 | 特点 |
|------|--------|---------|------|
| `users` | 1 | `_id = _openid` | 最简集合 |
| `photos` | 4 | `_openid+task_id`, `_openid+upload_attempt_id` | 双唯一约束 |
| `notes` | 5 | 无 | 多排序索引 |
| `tags` | 2 | `_openid+normalized_name` | 标准化名称 |
| `photo_tags` | 3 | `_openid+photo_id+tag_id` | 关联表 |
| `upload_attempts` | 4 | `_openid+task_id` | 状态机 + lease |
| `deletion_tasks` | 3 | `_openid+task_key` | 任务调度 |

## 核心参考文件

- [scripts/backend-schema.js](scripts/backend-schema.js) — 所有集合的完整定义
- [scripts/db-init.js](scripts/db-init.js) — 初始化执行器
- [docs/DATABASE-SETUP-CHECKLIST.md](docs/DATABASE-SETUP-CHECKLIST.md) — 数据库设置清单
- [docs/TECHNICAL-ARCHITECTURE.md §4.3](docs/TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md) — 数据库架构
