# 数据库与存储初始化清单 — 图片笔记小程序 V1.0.0

> 权威清单来源：
> [TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md](./TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md)
> §4.3。真实云环境结果记录到
> [BACKEND-CLOUD-ACCEPTANCE-DEV-01.md](./BACKEND-CLOUD-ACCEPTANCE-DEV-01.md)。

## 1. 安全执行

初始化脚本默认 dry-run，不包含默认环境 ID 或凭据：

```text
npm install
node scripts/db-init.js --dry-run --env <environment-id>
```

核对计划后，显式执行写入：

```text
node scripts/db-init.js --apply --env <environment-id>
```

apply 需要 `CLOUDBASE_SECRET_ID` 和 `CLOUDBASE_SECRET_KEY`。环境 ID、
凭据或 SDK 缺失时脚本安全失败；输出只包含环境 SHA-256 摘要、数量和安全错误码。
脚本必须连续执行两次，第二次不得新增集合、索引或回填字段。

## 2. 集合与索引

共 7 个集合、21 个业务索引（不含平台内置 `_id` 索引）。

### `users`

| 索引 | 字段 | 类型 |
|---|---|---|
| `status_idx` | `status:1` | 普通 |

### `photos`

| 索引 | 字段 | 类型 |
|---|---|---|
| `photo_task_unique` | `_openid:1, task_id:1` | UNIQUE |
| `photo_attempt_unique` | `_openid:1, upload_attempt_id:1` | UNIQUE |
| `photo_list_cursor_idx` | `_openid:1, status:1, upload_time:-1, _id:-1` | 普通 |
| `photo_uncategorized_cursor_idx` | `_openid:1, status:1, tag_count:1, upload_time:-1, _id:-1` | 普通 |

### `notes`

| 索引 | 字段 | 类型 |
|---|---|---|
| `note_photo_idx` | `photo_id:1` | 普通 |
| `note_created_desc_cursor_idx` | `_openid:1, created_at:-1, _id:-1` | 普通 |
| `note_created_asc_cursor_idx` | `_openid:1, created_at:1, _id:1` | 普通 |
| `note_shoot_desc_cursor_idx` | `_openid:1, photo_shoot_time:-1, _id:-1` | 普通 |
| `note_shoot_asc_cursor_idx` | `_openid:1, photo_shoot_time:1, _id:1` | 普通 |

### `tags`

| 索引 | 字段 | 类型 |
|---|---|---|
| `tag_name_unique` | `_openid:1, normalized_name:1` | UNIQUE |
| `tag_list_idx` | `_openid:1, last_used_at:-1, updated_at:-1, created_at:-1` | 普通 |

### `photo_tags`

| 索引 | 字段 | 类型 |
|---|---|---|
| `photo_tag_relation_unique` | `_openid:1, photo_id:1, tag_id:1` | UNIQUE |
| `photo_tag_filter_cursor_idx` | `_openid:1, tag_id:1, photo_upload_time:-1, _id:-1` | 普通 |
| `photo_tag_photo_idx` | `_openid:1, photo_id:1` | 普通 |

### `upload_attempts`

| 索引 | 字段 | 类型 |
|---|---|---|
| `attempt_task_unique` | `_openid:1, task_id:1` | UNIQUE |
| `attempt_expire_idx` | `status:1, expires_at:1` | 普通 |
| `attempt_lease_idx` | `status:1, confirm_lease_expire_at:1` | 普通 |

### `deletion_tasks`

| 索引 | 字段 | 类型 |
|---|---|---|
| `delete_task_unique` | `_openid:1, task_key:1` | UNIQUE |
| `delete_dispatch_idx` | `type:1, status:1, next_retry_at:1` | 普通 |
| `delete_lease_idx` | `type:1, status:1, lease_expire_at:1` | 普通 |

## 3. 回填

仅对缺失字段的既有 `photos` 写入：

| 字段 | 缺失时写入 |
|---|---|
| `status` | `ACTIVE` |
| `updated_at` | 脚本执行时间 |
| `tag_count` | `0` |

合法现值（包括 `DELETING`、非零 `tag_count` 和已有时间）不得覆盖。脚本在索引
创建前回填，在结束前重新统计三个缺失字段；任一剩余数量非零即失败。

## 4. 客户端权限

7 个数据库集合均设为客户端拒绝读写，仅云函数使用服务端身份访问。不得使用
“仅创建者可读写”作为替代，因为业务要求客户端不能绕过云函数的 ACTIVE 状态、
内容审核、配额、归属和响应投影。

存储权限必须满足：

- `uploads/pending/`：客户端只能写服务端签发的随机路径，不能读、覆盖他人对象或删除。
- `photos/active/`：客户端不能读、写、覆盖或删除；仅云函数可管理。
- 图片只通过鉴权接口生成短期临时 URL，越权和过期 URL 不可用。

权限规则由目标环境控制台/API 配置后，必须执行正向和反向用例；仓库模板不能替代
云环境证据。

## 5. 触发器与运行配置

`cloudfunctions/cleanup/config.json` 必须声明：

| TriggerName | 计划 |
|---|---|
| `deleteTaskWorker` | 每 5 分钟 |
| `dailyCleanup` | 每日 03:00 |

生产/测试环境按 [backend-runtime.env.example](../config/backend-runtime.env.example)
显式配置 HMAC 密钥和 feature flags。仓库不得保存真实值。

## 6. 云环境验证

必须在 DEV-13 发布验收前完成：

1. 核对 7 个集合、21 个索引及六道唯一约束。
2. 使用 explain 验证 ALL、UNCATEGORIZED、TAG、备注四排序、attempt 和删除任务查询。
3. 验证复合索引反向扫描能力；未验证前保留备注升降序四个索引。
4. 执行数据库客户端全部 DENY、pending 正向上传、active 反向读写删用例。
5. 验证双触发器实际按 TriggerName 执行且日志不含敏感数据。

所有结果填写到 DEV-01 云环境验收记录；未执行项保持 `PENDING`，不得推断为通过。
