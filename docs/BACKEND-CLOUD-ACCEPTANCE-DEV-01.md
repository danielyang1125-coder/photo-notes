# DEV-01 云环境验收记录

> 本文件是云环境执行模板，不代表任何项目已通过验收。环境 ID、OPENID、
> fileID、临时 URL、密钥和原始 SDK 错误不得写入仓库；仅记录环境摘要和安全结果。

## 1. 执行信息

| 项目 | 记录 |
|---|---|
| 日期 | — |
| 执行人 | — |
| 环境 SHA-256 前 12 位 | — |
| 代码提交 | — |
| `db-init --dry-run` | `PENDING` |
| `db-init --apply` | `PENDING` |

推荐顺序：

```text
npm install
node scripts/db-init.js --dry-run --env <environment-id>
node scripts/db-init.js --apply --env <environment-id>
node scripts/db-init.js --apply --env <environment-id>
```

第二次 apply 必须显示 7 个集合和 21 个索引均已存在、回填更新数为 0。

## 2. 集合、回填与唯一约束

| 检查项 | 预期 | 结果 | 证据摘要 |
|---|---|---|---|
| 7 个集合 | 全部存在 | `PENDING` | — |
| photos 缺失 `status` | 0 | `PENDING` | — |
| photos 缺失 `updated_at` | 0 | `PENDING` | — |
| photos 缺失 `tag_count` | 0 | `PENDING` | — |
| attempt task 唯一 | 第二次写入冲突 | `PENDING` | — |
| photo task 唯一 | 第二次写入冲突 | `PENDING` | — |
| photo attempt 唯一 | 第二次写入冲突 | `PENDING` | — |
| tag name 唯一 | 第二次写入冲突 | `PENDING` | — |
| photo-tag relation 唯一 | 第二次写入冲突 | `PENDING` | — |
| deletion task_key 唯一 | 第二次写入冲突 | `PENDING` | — |

## 3. 核心查询 explain

| 查询 | 目标索引 | 结果 | 安全 evidence |
|---|---|---|---|
| ALL 图片 cursor | `photo_list_cursor_idx` | `PENDING` | — |
| UNCATEGORIZED 图片 cursor | `photo_uncategorized_cursor_idx` | `PENDING` | — |
| TAG relation cursor | `photo_tag_filter_cursor_idx` | `PENDING` | — |
| 备注创建时间 DESC/ASC | 对应两个 note cursor 索引 | `PENDING` | — |
| 备注拍摄时间 DESC/ASC | 对应两个 note cursor 索引 | `PENDING` | — |
| attempt 到期/租约 | `attempt_expire_idx` / `attempt_lease_idx` | `PENDING` | — |
| 删除任务调度/租约 | `delete_dispatch_idx` / `delete_lease_idx` | `PENDING` | — |

记录 explain 是否命中索引、扫描量区间和耗时区间；不得粘贴业务文档。

## 4. 数据库与存储权限

| 用例 | 预期 | 结果 |
|---|---|---|
| 小程序直读/写 7 个集合 | 全部拒绝 | `PENDING` |
| 客户端上传未签发 pending 路径 | 拒绝 | `PENDING` |
| 客户端覆盖其他 pending 对象 | 拒绝 | `PENDING` |
| 客户端写入/覆盖 active 路径 | 拒绝 | `PENDING` |
| 客户端读取/删除 active 对象 | 拒绝 | `PENDING` |
| 云函数写入、临时读取和删除 active 对象 | 成功 | `PENDING` |
| 越权或过期临时 URL | 不可用 | `PENDING` |

## 5. 触发器与运行配置

| 检查项 | 预期 | 结果 |
|---|---|---|
| `deleteTaskWorker` | 每 5 分钟 | `PENDING` |
| `dailyCleanup` | 每日 03:00 | `PENDING` |
| 两种 TriggerName 可区分 | 独立安全汇总 | `PENDING` |
| 两个 HMAC 密钥 | 显式配置且不同 | `PENDING` |
| 五个 feature flag | 生产最终值均为 `true` | `PENDING` |
| 日志与配置导出 | 无密钥、ID、URL、用户内容 | `PENDING` |

## 6. 结论

状态：`PENDING`

阻断项/负责人/计划日期：—
