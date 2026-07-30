# DEV-13 云环境验收记录 — 发布门禁

> 本文件是发布前云环境验收清单，涵盖第 8 节全部发布门禁。
> 环境 ID、OPENID、fileID、临时 URL、密钥和原始 SDK 错误不得写入仓库。

## 1. 执行信息

| 项目 | 记录 |
|---|---|
| 日期 | — |
| 执行人 | — |
| 环境 SHA-256 前 12 位 | — |
| 最终代码提交 | — |
| 部署工具 | `uploadCloudFunction.sh <envId>` |

---

## 2. 自动化门禁（§8.1）

| 检查项 | 命令 | 预期 | 结果 |
|---|---|---|---|
| JS 语法检查 | `npm run backend:check` | 全部通过 | `PENDING` |
| 共享模块漂移 | `npm run backend:sync -- --check` | 无漂移 | `PENDING` |
| 禁止模式扫描 | `npm run backend:check` | `.skip()`/`console.log`/`err.message` 零命中 | `PENDING` |
| 安全字段扫描 | `npm run backend:check` | OPENID/_openid 在响应中零命中 | `PENDING` |
| 日志字段审计 | `node scripts/backend-log-audit.js` | 0 违规 | `PENDING` |
| 全部单测 | `npm run backend:test` | 365+ 通过，仅 sharp 依赖 1 已知失败 | `PENDING` |
| 功能开关校验 | `node --test test/backend/feature-flags.test.js` | 8/8 通过 | `PENDING` |
| 审计静态检查 | `node scripts/backend-audit.js` | DEV-00～DEV-13 全部通过 | `PENDING` |

---

## 3. 云环境门禁（§8.2）

### 3.1 数据库与索引

| 检查项 | 预期 | 结果 |
|---|---|---|
| 7 个集合实际存在 | users, photos, notes, tags, photo_tags, upload_attempts, deletion_tasks | `PENDING` |
| 22 个索引 | `scripts/backend-schema.js` flat list | `PENDING` |
| 6 个唯一索引 | upload task/photo/attempt, tag name, relation, deletion task_key | `PENDING` |
| `db-init --apply` 二次运行 | 全部已存在、回填 0 行 | `PENDING` |
| ALL 图片 cursor explain | 命中 `photo_list_cursor_idx` | `PENDING` |
| UNCATEGORIZED cursor explain | 命中 `photo_uncategorized_cursor_idx` | `PENDING` |
| TAG relation cursor explain | 命中 `photo_tag_filter_cursor_idx` | `PENDING` |
| 备注四种排序 explain | 各自命中对应索引 | `PENDING` |
| attempt 到期/租约 explain | 命中对应索引 | `PENDING` |
| 删除任务调度/租约 explain | 命中对应索引 | `PENDING` |
| 事务冲突错误码 | 实际唯一冲突可被 `isUniqueConflict()` 识别 | `PENDING` |
| 索引反向扫描 | 升降序 explain 均命中索引 | `PENDING` |

### 3.2 数据库与存储权限

| 用例 | 预期 | 结果 |
|---|---|---|
| 小程序端直读 users 集合 | 拒绝 | `PENDING` |
| 小程序端直写 photos 集合 | 拒绝 | `PENDING` |
| 小程序端直读/写/删任意集合 | 6 个集合全部拒绝 | `PENDING` |
| 客户端上传到非签发 pending 路径 | 拒绝或云函数不可见 | `PENDING` |
| 客户端覆盖他人 pending 对象 | 拒绝 | `PENDING` |
| 客户端写入/覆盖 active 路径 | 拒绝 | `PENDING` |
| 客户端读取/删除 active 对象 | 拒绝 | `PENDING` |
| 云函数写删 active 对象 | 成功 | `PENDING` |
| 过期/越权临时 URL | 不可访问 | `PENDING` |

### 3.3 触发器

| 检查项 | 预期 | 结果 |
|---|---|---|
| `deleteTaskWorker` 触发器 | 每 5 分钟触发 | `PENDING` |
| `dailyCleanup` 触发器 | 每日 03:00 触发 | `PENDING` |
| TriggerName 区分 | cleanup 日志可区分两种上下文 | `PENDING` |
| 任务租约并发 | 同任务并发 worker 仅租约持有者写入 | `PENDING` |

### 3.4 内容审核

| 检查项 | 预期 | 结果 |
|---|---|---|
| 图片审核 `imgSecCheck` | 通过/拒绝/不可用三种场景 | `PENDING` |
| 文本审核 `msgSecCheck` | 备注和标签名称通过/拒绝/不可用 | `PENDING` |
| 审核不可用时 fail-closed | 返回 `CONTENT_REVIEW_UNAVAILABLE`，不放行 | `PENDING` |
| 审核不通过 | 返回 `CONTENT_REVIEW_FAILED`，清理临时文件 | `PENDING` |

---

## 4. 功能与性能门禁（§8.3）

| 检查项 | 预期 | 结果 |
|---|---|---|
| 3 并发配额竞争 | 剩余仅容 1 张时 3 并发 confirm，仅 1 成功 | `PENDING` |
| 10 并发 confirm | 仅创建 1 张 photo，used_bytes 正确 | `PENDING` |
| ALL 列表分页 | 20 张/页，无重复遗漏 | `PENDING` |
| UNCATEGORIZED 列表分页 | 仅 `tag_count=0` 图片 | `PENDING` |
| TAG 列表分页 | 按 relation cursor，跳过失效引用 | `PENDING` |
| 备注四排序 cursor | 无重复遗漏，跨排序不可复用 | `PENDING` |
| 图片删除立即隐藏 | 提交后 list/detail/note/tag 全部不可见 | `PENDING` |
| 删除各阶段故障恢复 | 每阶段中断后继续，最终无残留 | `PENDING` |
| 注销各阶段故障恢复 | 每阶段中断后继续，最终全部清理 | `PENDING` |
| 真机核心流程 | 上传→浏览→备注→标签→删除，体感无卡顿（>3s） | `PENDING` |

---

## 5. 安全与隐私门禁（§8.4）

### 5.1 越权矩阵

| 场景 | 预期 | 结果 |
|---|---|---|
| 用户 B 查询用户 A 的 photoId | `PHOTO_NOT_FOUND`（不泄露存在性） | `PENDING` |
| 用户 B 操作用户 A 的 noteId | `NOTE_NOT_FOUND` | `PENDING` |
| 用户 B 操作用户 A 的 tagId | `TAG_NOT_FOUND` | `PENDING` |
| 用户 B 操作用户 A 的 attemptId | `UPLOAD_ATTEMPT_NOT_FOUND` | `PENDING` |
| 用户 B 查询用户 A 的删除任务 | `DELETE_TASK_NOT_FOUND` | `PENDING` |
| 用户 B 操作用户 A 的 DELETING photo 的备注 | `PHOTO_NOT_FOUND` | `PENDING` |
| 随机/不存在 ID | 统一安全错误，无响应差异 | `PENDING` |

### 5.2 字段安全投影

| 检查项 | 预期 | 结果 |
|---|---|---|
| photo list 响应 | 无 `file_id`、`_openid` | `PENDING` |
| photo detail 响应 | 无 `file_id`、`_openid` | `PENDING` |
| note 响应 | 无 `_openid` | `PENDING` |
| tag 响应 | 无 `normalized_name`、`_openid` | `PENDING` |
| upload 响应 | 无 `file_id`、`_openid`、内部租约 | `PENDING` |
| 删除任务响应 | 无 `file_id`、`_openid`、内部阶段/错误 | `PENDING` |
| 注销任务响应 | 无 `_openid`、资源 ID、业务内容 | `PENDING` |
| 错误响应 | 无 SDK errCode、索引名、原始 ID、原始异常 | `PENDING` |

### 5.3 日志安全

| 检查项 | 预期 | 结果 |
|---|---|---|
| `backend-log-audit.js` | 0 违规 | `PENDING` |
| 日志不含 OPENID | 搜索生产日志样本 | `PENDING` |
| 日志不含 fileID/URL | 搜索生产日志样本 | `PENDING` |
| 日志不含标签名/备注内容 | 搜索生产日志样本 | `PENDING` |
| 安全日志仅含白名单字段 | event, result, safeErrorCode, durationMs, countBucket, requestIdHash, resourceHash, timestamp | `PENDING` |

### 5.4 配置安全

| 检查项 | 预期 | 结果 |
|---|---|---|
| 生产 HMAC 密钥已配置 | CURSOR_HMAC_SECRET、AUDIT_HMAC_SECRET 非空 | `PENDING` |
| 5 个 feature flag 均为 `"true"` | 生产值 | `PENDING` |
| DEPLOYMENT_MODE 已设置 | `PRIVATE_SINGLE_USER` 或 `PUBLIC` | `PENDING` |
| 仓库无生产密钥 | `.gitignore` 排除 `.env` 文件 | `PENDING` |

---

## 6. DEV-13 专项：契约切换

| 检查项 | 预期 | 结果 |
|---|---|---|
| prepare/confirm/cancel 新协议可用 | 旧 confirm 参数（size/width/height/format）被拒绝 | `PENDING` |
| photo/note 使用 cursor | `page` 参数被拒绝 | `PENDING` |
| photo delete 返回 PENDING | 不再同步返回 COMPLETED | `PENDING` |
| batchAddPhotoTags 返回三类计数 | successCount/invalidCount/limitExceededCount | `PENDING` |
| 功能开关配置错误 | 云函数部署失败（冷启动拒绝） | `PENDING` |

---

## 7. 结论

| 门禁域 | 状态 |
|---|---|
| §8.1 自动化 | `PENDING` |
| §8.2 云环境 | `PENDING` |
| §8.3 功能与性能 | `PENDING` |
| §8.4 安全与隐私 | `PENDING` |
| DEV-13 契约切换 | `PENDING` |

最终状态：`PENDING`

阻断项/负责人/计划日期：—
