# BACKEND DEVELOPMENT PLAN — 图片笔记小程序 V1.0.0

> 文档用途：供 AI Agent 按依赖顺序持续实现、测试和验收后端功能。  
> 版本：V1.0.0  
> 编制日期：2026-07-29  
> 当前基线：后端审计 27 个任务包中 0 个完全完成，134 个技术检查项中 8 个完全完成。  
> 目标：完成产品 F-001、F-004～F-019 对应的后端能力，并关闭审计中的全部 P0/P1 缺口。

## 1. 权威来源与冲突处理

实现前必须按以下优先级读取基线，低优先级文档不得覆盖高优先级决策：

1. [TECHNICAL-DESIGN-图片笔记小程序-V1.0.0-P0问题修复.md](./TECHNICAL-DESIGN-图片笔记小程序-V1.0.0-P0问题修复.md)
2. [TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md](./TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md)
3. [PRD-图片笔记小程序-V1.0.0.md](./PRD-图片笔记小程序-V1.0.0.md) 与 [PRD-图片笔记小程序-V1.0.0-标签功能增量.md](./PRD-图片笔记小程序-V1.0.0-标签功能增量.md)
4. [BACKEND-IMPLEMENTATION-BREAKDOWN-图片笔记小程序-V1.0.0.md](./BACKEND-IMPLEMENTATION-BREAKDOWN-图片笔记小程序-V1.0.0.md)
5. [BACKEND-IMPLEMENTATION-AUDIT-RESULT-图片笔记小程序-V1.0.0.md](./BACKEND-IMPLEMENTATION-AUDIT-RESULT-图片笔记小程序-V1.0.0.md)

已锁定的冲突决策：

- 他人、不存在、DELETING 或已删除标签统一返回 `TAG_NOT_FOUND`，不使用主 PRD 旧稿中的 `TAG_ACCESS_DENIED`。
- 图片不存在、越权、DELETING 或已删除统一使用安全的 `NOT_FOUND`/`PHOTO_NOT_FOUND`，不得泄露存在性。
- 保留产品所需的 `user/getSpaceUsage` 作为正式扩展接口；`login` 同时返回空间摘要。
- 上传、图片/备注分页和图片删除最终只支持新协议；旧 `confirm(fileId,size,...)`、page/skip 和同步删除必须在迁移完成后强制关闭。
- V1.0.0 尚未上线，不设计线上历史迁移；仍需为开发/测试数据提供可重复执行、默认 dry-run 的回填脚本。

## 2. 整体完成目标

满足以下条件才可认为后端整体开发完成：

- 6 个业务云函数和 1 个 cleanup 云函数均实现目标 type、统一身份/响应/错误边界。
- 7 个集合、全部唯一索引和 Keyset 查询索引在开发环境验证通过。
- 客户端不能直读写数据库、不能自定 active 路径、不能覆盖或删除 active 对象。
- 上传 prepare/confirm/cancel、图片异步删除、标签关系、备注计数和注销清理均满足事务、幂等、并发及失败恢复要求。
- ALL、UNCATEGORIZED、TAG 图片列表和四种备注排序全部使用绑定参数的 Keyset Cursor，不出现 `.skip()`。
- 所有图片业务读写均限制 `_openid + status=ACTIVE`；删除申请提交后立即全局隐藏。
- P0/P1 功能具备自动化测试或明确的云环境验收证据。
- 审计重新执行后，P0/P1 项不得为 `PARTIAL`、`NOT_IMPLEMENTED`、`DEVIATED` 或无说明的 `UNVERIFIED`。

## 3. 已锁定的实现方案

### 3.1 代码组织

- 保持“每个业务域一个云函数 + type 路由”。
- 将公共实现的单一源文件放在 `cloudfunctions/_shared/`，至少包含：
  - `response`：统一成功/错误响应和安全错误映射。
  - `validation`：字符串、枚举、数组、日期、code point 和 requestId 校验。
  - `auth`：OPENID、ACTIVE 用户和资源归属检查。
  - `transaction`：有限事务重试和唯一冲突识别。
  - `cursor`：HMAC cursor 编解码、参数绑定和 keyset 条件。
  - `security-log`：HMAC 摘要、结构化安全日志和敏感字段禁止规则。
  - `config`：环境变量读取、必填项及 feature flag。
- 新增 `scripts/sync-cloudfunction-shared.js`，把公共模块复制到各函数的 `lib/shared/`；部署目录中的副本纳入版本控制。
- 新增漂移检查：测试前同步，CI/本地检查确认副本与 `_shared` 一致。业务代码不得直接修改生成副本。
- 各云函数 `index.js` 只负责初始化、路由和顶层异常边界；业务实现逐步迁入 `handlers/`、`services/`、`repositories/`。

### 3.2 测试组织

- 使用 Node.js 内置 `node:test` 和 `assert`，不额外引入测试框架。
- handler/service 使用依赖注入接收 db、cloud、clock、random、logger，测试不得连接真实云环境。
- 根目录新增 `package.json`，提供：
  - `backend:sync`
  - `backend:check`：同步检查、`node --check`、禁止模式扫描。
  - `backend:test`：全部后端单元/集成模拟测试。
  - `backend:audit`：核对路由、索引清单、测试清单和审计编号覆盖。
- 云环境验证不伪装成自动化通过；结果记录到独立验收文档。

### 3.3 配置

生产/测试环境必须显式配置：

| 配置 | 用途 | 缺失行为 |
|---|---|---|
| `CURSOR_HMAC_SECRET` | cursor 防篡改 | 列表返回 `INTERNAL_ERROR`，禁止无签名降级 |
| `AUDIT_HMAC_SECRET` | 安全日志 ID 摘要 | 禁止记录原始 ID |
| `UPLOAD_ATTEMPT_REQUIRED` | 强制新上传协议 | 发布最终值为 `true` |
| `CURSOR_PAGINATION_REQUIRED` | 强制 cursor | 发布最终值为 `true` |
| `ASYNC_PHOTO_DELETE_ENABLED` | 强制异步删除 | 发布最终值为 `true` |
| `PUBLIC_RESOURCE_ERROR_MASKING` | 统一存在性保护 | 发布最终值为 `true` |
| `CONTENT_REVIEW_ENABLED` | 内容审核开关 | 生产必须为 `true`；审核不可用时 fail-closed |

仓库不得包含生产密钥或默认生产环境 ID。初始化和验收脚本必须要求显式传入环境。

### 3.4 数据与状态机

- `upload_attempts`：`PREPARED → CONFIRMED | CANCELED | EXPIRED`；终态不复活，保留 7 天。
- `photos.status`：`ACTIVE → DELETING`；不得恢复 ACTIVE。
- `deletion_tasks.status`：`PENDING → PROCESSING ↔ RETRYING → COMPLETED`。
- 上传最终事务：读取 PREPARED attempt + ACTIVE user，校验租约/配额，原子创建 ACTIVE photo、增加 used_bytes、attempt→CONFIRMED。
- 图片删除最终事务：确认 DELETING photo，删除 photo、精确扣减一次 used_bytes、任务→COMPLETED。
- 账号注销顺序：对象 → notes → photo_tags → tags → photos → 空间/用户数据 → 身份解绑；任一失败保持 DELETING。

## 4. 开发路线图

| 阶段 | 任务 | 依赖 | 主要关闭项 | 完成门禁 |
|---|---|---|---|---|
| M0 | DEV-00 公共内核与测试骨架 | — | BE-01、BE-25/27 基础 | 公共模块可测试、全部旧 JS 语法通过 |
| M1 | DEV-01 数据、索引、回填与配置 | DEV-00 | BE-02～04 | dry-run、索引清单和触发器配置通过 |
| M2 | DEV-02 用户身份与状态隔离 | DEV-00～01 | BE-05 | 并发首登、状态拦截和安全投影通过 |
| M3 | DEV-03 上传 attempt；DEV-04 可信 confirm | DEV-02 | BE-06～09 | 幂等、配额、真实性、取消竞态通过 |
| M4 | DEV-05 上传补偿与清理 | DEV-03～04 | BE-10 | 过期/孤立对象任务可续跑 |
| M5 | DEV-06 图片查询与详情 | DEV-01～04 | BE-11～13 | 三类 cursor、ACTIVE 隔离、受控 URL 通过 |
| M6 | DEV-07 异步图片删除 | DEV-05～06 | BE-14～15 | 立即隐藏、四阶段重试、精确释放空间通过 |
| M7 | DEV-08 备注；DEV-09 标签核心 | DEV-01～02、DEV-06 | BE-16～20 | 备注并发、标签唯一/计数/部分结果通过 |
| M8 | DEV-10 引用清理与计数校正 | DEV-07～09 | BE-21 | 孤立引用和派生计数可全量续跑 |
| M9 | DEV-11 账号注销 | DEV-07～10 | BE-22～23 | 完整级联、失败重试、最后解绑通过 |
| M10 | DEV-12 cleanup 编排与安全收口 | DEV-05、07、10、11 | BE-24～25 | 双触发器、租约、游标、脱敏日志通过 |
| M11 | DEV-13 契约切换、验收与发布 | DEV-00～12 | BE-26～27 | 自动化、云验收、重审和发布门禁全部通过 |

同一阶段标记为并行的任务只有在不同 AI Agent 使用独立工作树/分支时才能并行；共享工作区中按任务编号顺序执行。

### 4.1 需求与审计追溯

| 开发任务 | 产品功能 | 实施任务 | 主要审计域 |
|---|---|---|---|
| DEV-00 | 全局非功能需求 | BE-01、BE-25、BE-27 | COM、API、安全/日志 |
| DEV-01 | 数据权限、性能与发布准备 | BE-02～BE-04 | INF |
| DEV-02 | F-001、空间用量 | BE-05 | USR、COM-04～COM-07 |
| DEV-03～DEV-05 | F-004、F-013 | BE-06～BE-10 | UPL、API-01～API-03 |
| DEV-06 | F-005、F-006、F-016 | BE-11～BE-13 | PHQ、TAG-13～TAG-15、API-04 |
| DEV-07 | F-012 | BE-14～BE-15 | PHD、API-06 |
| DEV-08 | F-007～F-011 | BE-16～BE-17 | NTE、API-05 |
| DEV-09 | F-016～F-019 | BE-18～BE-20 | TAG-01～TAG-15、API-08 |
| DEV-10 | 标签/未分类一致性 | BE-21 | TAG-16、CLN-08～CLN-09 |
| DEV-11 | F-015 | BE-22～BE-23 | ACC、CLN-07 |
| DEV-12 | 全局安全、补偿与可观测性 | BE-24～BE-25 | CLN、COM-10～COM-12 |
| DEV-13 | 发布与整体验收 | BE-26～BE-27 | API、全部 P0/P1 |

## 5. 可执行任务说明

### DEV-00 公共内核与测试骨架

**目标**

建立后续所有云函数必须使用的统一基础能力，先消除错误透传、重复身份逻辑和不可测试结构。

**实现**

- 建立 §3.1 的公共模块、同步脚本、漂移检查和根测试脚本。
- 定义错误目录和公共响应；未知 type 固定 `UNKNOWN_TYPE`。
- 资源错误映射不得包含 SDK errCode、索引名、fileID、资源 ID 或原始异常。
- 日志只允许 `event`、`result`、安全错误码、duration、数量区间、requestIdHash/resourceHash。
- 逐个云函数把入口改成薄路由；本任务只迁移公共边界，不改变业务协议。
- 将 `quickstartFunctions` 排除出生产部署清单；样例数据库和 getOpenId 能力不得进入发布环境。

**测试与验收**

- 公共参数、状态拦截、错误映射、事务有限重试、HMAC cursor 和日志脱敏单测。
- 扫描 `console.*`、`err.message`、原始 OPENID/fileID/URL 输出。
- 现有业务入口在迁移期间仍能加载；所有 JS 通过语法检查。

### DEV-01 数据、索引、回填与运行配置

**目标**

把 7 个集合、目标字段、唯一约束、Keyset 索引和 cleanup 双触发器固化为可重复执行的基础设施。

**实现**

- 重写 `scripts/db-init.js`：显式创建 7 个集合并创建架构 §4.3 的全部索引。
- 索引至少包括上传三道唯一防线、标签/关系唯一索引、图片两类 cursor、TAG relation cursor、备注四类 cursor、删除 task_key/调度/租约索引。
- 增加照片回填：缺失 `status`→ACTIVE、`updated_at`、`tag_count`；不覆盖合法现值。
- 所有脚本默认 `--dry-run`，执行写入必须显式 `--apply --env <id>`；输出数量和安全摘要。
- cleanup 配置 `deleteTaskWorker` 每 5 分钟和 `dailyCleanup` 每日 03:00。
- 新增云环境验收模板，记录集合权限、存储权限、索引 explain 和触发器结果。

**测试与验收**

- 初始化/回填重复运行结果一致；缺环境、缺凭据时安全失败。
- 静态测试比较脚本索引清单与架构清单，不允许遗漏 `_id` 稳定排序键。
- 云环境创建索引前先 dry-run；真实创建、权限和 explain 留待 DEV-13 验收。

### DEV-02 用户身份与状态隔离

**目标**

实现并发安全的身份建立、最小响应字段和全局 ACTIVE 拦截。

**实现**

- `user/login` 使用 `_id=OPENID` 唯一性处理并发首登，唯一冲突后读取本人记录作为幂等成功。
- DELETED 不自动复活；DELETING/DELETED 返回权威状态并拒绝普通业务。
- login 只返回 `{status,used_bytes,limit_bytes}` 和 `isNewUser`。
- `getStatus` 只返回 status；`getSpaceUsage` 返回 used/limit/warning/full，不返回标识。
- 公共 ACTIVE guard 应用于 upload/photo/note/tag；account 状态查询按契约例外开放。

**测试与验收**

- 10 个并发首次 login 只产生一个用户且默认 500 MB。
- ACTIVE、DELETING、DELETED、缺失用户的接口矩阵。
- 响应和日志中不存在 OPENID、`_openid` 或内部 user 文档。

### DEV-03 上传 prepare、cancel 与 attempt 状态机

**目标**

建立服务端签发上传路径和可线性化的上传尝试状态机。

**实现**

- `prepare({taskId})`：校验 1～128 安全字符、ACTIVE 用户；创建密码学随机 attemptId 和 `uploads/pending/{random32}.bin`。
- `_openid+task_id` 唯一冲突读取原 attempt；CONFIRMED 返回原 photoId；CANCELED/EXPIRED 返回对应终态且不复活。
- `cancel({attemptIds})`：1～20、去重、逐项短事务；PREPARED→CANCELED，CONFIRMED 返回 photoId，终态重放幂等。
- 响应不返回 OPENID、内部租约和 fileID。

**测试与验收**

- 并发 prepare 只签发一个 attempt。
- cancel/confirm 两种提交顺序的事务测试。
- 他人、随机、过期 attempt 使用安全错误且无存在性差异。

### DEV-04 上传真实性、审核、提升和最终事务

**目标**

完成可信上传、配额原子性和 confirm 并发幂等闭环。

**实现**

- confirm 只接收 `attemptId,fileId,shootTime,timeSource`。
- 短事务领取 confirm lease；有效租约存在时返回 `UPLOAD_CONFIRM_IN_PROGRESS`。
- 验证 fileID 环境和路径与 attempt 完全一致；下载 buffer 获取真实字节。
- 使用 magic bytes + 解码验证静态 JPEG/PNG、宽高和损坏情况；扩展名不作为依据。
- 生成最长边 ≤750px、≤1MB 的审核 buffer；拒绝和服务不可用分别返回安全错误，服务不可用不得放行。
- 审核通过后把已验证 buffer 写到随机 `photos/active/`，保存 SHA-256 和真实元数据。
- 最终短事务完成 user/photo/attempt 三项原子提交；唯一冲突读取原 photo，不能重复计费。
- 提升成功但事务失败时保留可安全重试的信息，由 DEV-05 补偿。

**测试与验收**

- 少报/多报大小、伪扩展名、动态/损坏图片、错误路径/环境、非法时间全部覆盖。
- 剩余空间只容纳一张时 3 个并发 confirm 仅一个成功。
- 10 个并发 confirm 和响应丢失重放只创建一张 photo、只计费一次。

### DEV-05 上传过期与对象补偿

**目标**

让 attempt、pending 和孤立 active 对象在崩溃后安全收敛。

**实现**

- 到期 PREPARED 原子转 EXPIRED；释放过期租约。
- 分页删除 CANCELED/EXPIRED/CONFIRMED 遗留 pending 对象。
- 仅清理超过 24h、无 photo、无有效租约的孤立 active 对象。
- 终态 attempt 保留 7 天后分页删除或匿名统计。
- 所有扫描使用稳定 keyset、批次和持久游标，不枚举无界存储目录。

**测试与验收**

- 有效 confirm 使用中的对象不会被清理。
- 任一批次崩溃后能从游标继续；重复执行无副作用。

### DEV-06 图片列表、标签筛选与详情

**目标**

实现产品三类图片范围、稳定分页、立即隐藏和受控 URL。

**实现**

- 公共 HMAC cursor 绑定 resource、scope、tagId、sort、方向和最后键值。
- ALL/UNCATEGORIZED 固定查询本人 ACTIVE photo，排序 `upload_time DESC,_id DESC`。
- TAG 先校验本人 tag，按 relation cursor 扫描，批量读取本人 ACTIVE photo，跳过失效引用并继续填页；nextCursor 取最后扫描 relation。
- 禁止 `.skip()`、page 和全量关系后本地分页。
- 列表只投影卡片字段；服务端批量生成约 200px thumbnail_url。
- detail 只查询本人 ACTIVE photo，只返回公开 photo 字段、预览 URL、备注和最多 5 个标签。
- 成功 TAG 筛选更新 last_used_at；读取路径不直接删除脏数据。

**测试与验收**

- 同时间戳、跨页并发插入/删除无重复；静态扫描不出现 `.skip()`。
- cursor 篡改、跨 scope/tag/sort 复用返回 `INVALID_CURSOR`。
- DELETING/他人/随机图片统一不可见，响应无 fileID/_openid。

### DEV-07 图片异步删除与状态查询

**目标**

实现“申请即隐藏、后台可恢复、空间只释放一次”的永久删除。

**实现**

- `photo/delete` 短事务：本人 ACTIVE→DELETING，同时创建或读取唯一 PHOTO_DELETE 任务。
- `getDeleteStatus` 只返回 taskId、photoId、公开状态和时间。
- worker 使用短租约推进：
  1. `STORAGE_DELETE`
  2. `NOTES_CLEANUP`
  3. `PHOTO_TAGS_CLEANUP`
  4. `PHOTO_FINALIZE`
- 每批清理和 stage_cursor 前移同事务；关系按实际删除数递减 tag.photo_count。
- finalize 原子删除 photo、精确扣减 used_bytes、任务 COMPLETED；重放不得重复扣空间。
- 失败记录安全码并进入 RETRYING，不恢复图片可见。

**测试与验收**

- 申请提交后 list/detail/note/tag 全部立即隐藏。
- 每阶段提交前后故障注入并重放，最终无对象/备注/关系/photo 残留，空间只扣一次。
- 重复 delete 返回同一任务。

### DEV-08 备注事务、乐观锁与 Cursor

**目标**

完成备注 CRUD、计数一致性、四种稳定排序和反向定位数据。

**实现**

- add 校验本人 ACTIVE photo、1～1000 code point、文本审核；note 创建和 note_count+1 同事务。
- update 强制 updatedAt；条件必须含 `_id+_openid+updated_at`。冲突只返回安全所需字段，不按裸 doc(id) 读取。
- delete 与 note_count 更新同事务；重放不减为负数。
- list 支持两字段×两方向 Keyset Cursor，同向 `_id` 作为第二键。
- 候选 note 批量复核本人 ACTIVE photo，跳过失效项并继续扫描；批量生成临时缩略图。

**测试与验收**

- 双设备并发更新只有一个成功，覆盖保存再次冲突仍拒绝。
- 写入任一点失败不产生 note/count 半提交。
- 四种排序同时间戳分页无重复遗漏，cursor 不可跨排序复用。

### DEV-09 标签 CRUD、单图关系与批量关系

**目标**

完成 F-016～F-019 的标签主链路和并发计数一致性。

**实现**

- 规范化顺序固定：Unicode trim→控制字符拒绝→NFC→code point 1～12→保留名→拉丁大小写归一。
- create/rename 内容审核 fail-closed；唯一冲突映射 `TAG_NAME_DUPLICATED`。
- list QUICK/ALL 固定排序，返回 TagSummary，不暴露 normalized_name。
- delete 幂等删除本人标签和关系，按实际关系更新图片 tag_count；不删除图片/备注。
- getPhotoTags/updatePhotoTags 必须先校验本人 ACTIVE photo。
- updatePhotoTags：数组分别去重、拒绝交叉；事务内读取当前集合并写实际差异，维护双方计数。
- batchAdd：全部 tagId 先整体校验；1～20 图逐图事务，返回 success/invalid/limitExceeded 三类计数；一个图片失败不回滚其他图片。
- requestId 必填且只记录 HMAC 摘要；幂等依赖实际差异+唯一关系索引。

**测试与验收**

- 名称边界、Emoji、Unicode 空白、控制字符、NFC、大小写和保留名全覆盖。
- 并发创建同名标签只成功一个。
- 单图第 6 个标签无任何写入；移除最后标签后进入未分类。
- 20×5、部分图片失效/超限的结果和双方计数正确。

### DEV-10 孤立引用清理与派生计数校正

**目标**

为运行期异常提供可续跑的最终一致性修复。

**实现**

- 清理引用非 ACTIVE/不存在 photo 的 note/photo_tags，以及引用不存在 tag 的 photo_tags。
- 按用户/稳定键分页聚合 `photos.tag_count` 与 `tags.photo_count`，只修正不一致项。
- photo.tag_count 限制 0～5，tag.photo_count 不得为负。
- 每次执行有批次、最大扫描轮次和持久 cursor；日志仅记录摘要与计数区间。

**测试与验收**

- 构造孤立 note/relation 和错误计数，重复执行后收敛且无越用户修改。
- 中途退出可续跑，不永远只处理前 100 条。

### DEV-11 注销申请与全量执行器

**目标**

完成产品要求的立即失效、全量清理、失败重试和最终身份解绑。

**实现**

- requestDeletion 要求 ACTIVE 和精确确认文字；短事务 user→DELETING 并创建/读取唯一任务。
- 重复请求返回原任务；getDeletionStatus 对 DELETING/DELETED 开放且只返回公开状态。
- ACCOUNT_DELETION 分阶段分页处理对象、notes、photo_tags、tags、photos、空间/用户数据、身份解绑。
- 每阶段幂等、带游标/租约；任一失败 RETRYING 且 user 保持 DELETING。
- 身份解绑必须是最后阶段；若目标 CloudBase 不提供独立解绑 API，则最终动作定义为删除/匿名化应用用户记录及全部业务映射，并在云验收文档记录平台能力结论，禁止伪造成功。

**测试与验收**

- 状态更新/任务创建任一点失败均不产生孤立 DELETING。
- 每阶段故障注入后能续跑；标签或关系未清完时不能 COMPLETED。
- 完成后按 `_openid` 扫描 7 个集合和存储均无用户数据。

### DEV-12 cleanup 编排、安全与可观测性收口

**目标**

让所有后台任务有界、可恢复、互不阻断，并完成全局安全反向检查。

**实现**

- 根据 TriggerName 区分每 5 分钟任务推进和每日全量补偿。
- 统一任务领取租约、续租、超时回收、批次、deadline 和 next_retry_at 退避。
- 单处理器失败不阻断其他类型；返回安全汇总。
- 全量扫描 `_id`、`_openid`、status 条件、原始异常、敏感日志和客户端可信字段。
- 健康检查不得返回 OPENID、集合数量或原始 SDK 错误；仅保留受控运维结果，生产默认关闭。

**测试与验收**

- 两种触发器调用不同任务集合。
- 同任务并发 worker 只有租约持有者写入。
- 模拟一个处理器失败，其他处理器仍完成。
- 日志样本自动扫描不含 OPENID、资源 ID、fileID、URL、标签/备注内容。

### DEV-13 契约切换、完整验收与发布

**目标**

完成后端新契约、客户端协同、云环境验收和最终重审。

**实现**

- 输出最终接口契约和错误码表，前端必须同步切换：
  - upload prepare/confirm/cancel
  - photo/note cursor
  - photo 异步删除状态
  - batchAdd 三类结果
- 新 schema 先部署但入口关闭；客户端适配完成后一次性启用四个 REQUIRED/ENABLED 开关。
- 开关启用后拒绝旧 confirm 元数据、page/skip 和同步删除协议。
- 执行自动化、云权限、索引 explain、内容审核、性能、并发和故障注入验收。
- 重新运行后端审计并更新结果文档。

**测试与验收**

- 第 8 节全部发布门禁通过。
- 新旧协议不会混发；上传新协议启用后不得回退到信任客户端元数据。
- 存在 DELETING photo/任务时回滚也必须继续 cleanup 且不得恢复可见。

## 6. 最终接口清单

| 云函数 | type | 输入摘要 | 输出摘要 |
|---|---|---|---|
| user | login | 无客户端身份 | user 状态/空间、isNewUser |
| user | getStatus | — | status |
| user | getSpaceUsage | — | used/limit/warning/full |
| upload | prepare | taskId | attemptId/cloudPath/expiresAt/photoId? |
| upload | confirm | attemptId/fileId/shootTime/timeSource | photo/duplicated |
| upload | cancel | attemptIds[1..20] | per-attempt results |
| photo | list | scope/tagId?/cursor/pageSize | list/nextCursor/hasMore/total? |
| photo | detail | photoId | public photo/notes/tags |
| photo | delete | photoId | taskId/PENDING |
| photo | getDeleteStatus | taskId | public task status/times |
| note | add/update/delete/list | 架构 §6.3 | note 或 cursor list |
| tag | list/create/rename/delete/getPhotoTags/updatePhotoTags/batchAddPhotoTags | 架构 §6.3 | TagSummary/计数/逐图结果 |
| account | requestDeletion/getDeletionStatus | 确认文字或无 | 公开任务状态 |
| cleanup | timer | TriggerName | 安全汇总 |

所有业务响应遵循：

```text
成功：{ code: "SUCCESS", data: {...}, message?: "string" }
错误：{ code: "ERROR_CODE", message: "安全且用户可读的信息" }
```

## 7. 数据库和存储交付清单

| 范围 | 必须交付 |
|---|---|
| users | ACTIVE/DELETING/DELETED、空间字段、状态索引 |
| photos | status/upload_attempt_id/updated_at/deleting_at、两道上传唯一索引、ALL/UNCATEGORIZED cursor 索引 |
| notes | 四种排序方向的稳定 cursor 索引 |
| tags | 用户内 normalized_name 唯一、固定列表排序索引 |
| photo_tags | 唯一关系、TAG relation cursor、单图关系索引 |
| upload_attempts | task 唯一、到期和租约索引 |
| deletion_tasks | task_key 唯一、调度和租约索引 |
| pending 存储 | 客户端只能写服务端签发路径，不能读/覆盖他人对象 |
| active 存储 | 仅云函数写删，客户端不能直接读写删 |

## 8. 发布门禁

以下任一失败必须停止发布：

### 8.1 自动化门禁

- 全部 JS 语法、共享模块漂移和禁止模式扫描通过。
- 单元/模拟集成测试全部通过。
- 事务中途失败、唯一冲突、响应丢失、租约超时和 worker 崩溃均有测试。
- `.skip()`、客户端 size/width/height/format 信任、无 `_openid` 资源查询、无 ACTIVE 图片过滤、原始敏感日志扫描结果为零。

### 8.2 云环境门禁

- 7 个集合及全部索引实际存在；核心查询 explain 命中目标索引。
- 事务冲突、复合唯一索引、索引反向扫描能力实测通过。
- 数据库客户端全部 DENY；pending 正向上传和 active 反向读写删用例通过。
- 双触发器实际执行；任务租约并发验证通过。
- 内容审核、临时 URL、服务端对象提升和删除实际通过。

### 8.3 功能与性能门禁

- 3 并发配额竞争只允许容量内请求成功。
- 10 并发 confirm 只创建一张 photo。
- ALL/UNCATEGORIZED/TAG 和备注四排序无重复遗漏。
- 图片删除各阶段、注销各阶段故障注入后最终收敛。
- QUICK 标签 P95 ≤800ms、ALL 标签 ≤1s、TAG 20 图 ≤2s、单图标签 ≤1s、20×5 批量 ≤2s。
- 普通接口 P95 ≤800ms、备注保存 P95 ≤1s；图片和备注首屏满足 PRD 指标。

### 8.4 安全与隐私门禁

- 双用户越权矩阵覆盖图片、备注、标签、attempt、删除任务。
- 本人/他人/随机/DELETING/已删除资源外部响应不泄露存在性。
- 日志、任务错误和响应不含原始 OPENID、资源 ID、fileID、私有 URL、标签名、备注或图片内容。

## 9. AI Agent 执行协议

每次开发只领取一个 `DEV-xx`，并遵循：

1. 开始前读取本任务、所有依赖任务的完成记录、相关基线和当前 git diff。
2. 先运行现有 `backend:check`/`backend:test`；若脚本尚未由 DEV-00 创建，先执行当前可用的 `node --check`。
3. 只修改本任务需要的业务域和公共模块；遇到新产品决策或基线冲突时停止并记录，不擅自扩展。
4. 先补失败测试或测试夹具，再实现；云环境事项写入验收清单，不用静态推测标记成功。
5. 修改公共 `_shared` 后运行同步脚本，不直接编辑生成副本。
6. 完成时运行语法、单测、集成模拟、禁止模式扫描；报告实际执行结果。
7. 更新下方进度表：状态、完成日期、变更摘要、验证命令、剩余云验证、审计编号。
8. 一个任务未满足完成门禁不得标记 DONE；可标记 BLOCKED 并给出具体外部依赖。

建议每个任务形成独立提交，提交信息格式：

```text
backend(DEV-xx): <任务结果>
```

## 10. 进度跟踪表

状态仅使用 `TODO`、`IN_PROGRESS`、`BLOCKED`、`DONE`。

| 任务 | 状态 | 完成日期 | 验证结果 | 剩余事项 |
|---|---|---|---|---|
| DEV-00 公共内核与测试骨架 | DONE | 2026-07-29 | `npm run backend:audit` 通过；83 个 JS 语法/漂移/禁止模式检查通过；22/22 单测通过 | 云函数目标运行时加载与日志样本复核并入 DEV-13 云环境验收 |
| DEV-01 数据、索引、回填与配置 | DONE | 2026-07-29 | 离线 dry-run 通过；7 个集合/21 个索引静态清单、幂等回填、索引漂移拒绝与双触发器测试通过；`npm run backend:audit` 通过，31/31 单测通过 | 真实集合/索引创建、权限、explain、触发器和存储反向用例留待 DEV-13，模板见 `BACKEND-CLOUD-ACCEPTANCE-DEV-01.md` |
| DEV-02 用户身份与状态隔离 | DONE | 2026-07-29 | `npm run backend:audit` 通过；88 个 JS 语法/漂移/禁止模式检查通过；36/36 单测通过；覆盖 10 并发首登、ACTIVE/DELETING/DELETED/缺失用户矩阵和安全投影 | 目标云环境 10 并发首登、云函数运行时响应及日志样本复核并入 DEV-13；已静态覆盖 USR-01～USR-06、COM-04～COM-07 |
| DEV-03 上传 attempt 与 cancel | DONE | 2026-07-29 | `npm run backend:audit` 通过；90 个 JS 语法/漂移/禁止模式检查通过；41/41 单测通过；覆盖 10 并发 prepare、24h 签发、终态重放、逐项 cancel、归属遮蔽及 cancel/confirm 两种提交顺序 | 新协议 confirm 的租约、真实性校验和最终事务由 DEV-04 完成；目标云环境并发 prepare、复合唯一索引与存储签发路径权限复核并入 DEV-13；已静态覆盖 UPL-01～UPL-04、UPL-18～UPL-19 |
| DEV-04 可信 confirm 与最终事务 | DONE | 2026-07-30 | `npm run backend:audit` 通过；92 个 JS 语法/漂移/禁止模式检查通过；49/49 单测通过；覆盖新协议拒旧字段、环境/路径绑定、静态 JPEG/PNG 解码、损坏/动态格式拒绝、≤750px/≤1MB 审核图、审核 fail-closed、active 随机提升与 SHA-256、租约/取消竞态、3 路配额竞争、10 次重放、事务故障后提升信息复用 | 目标云环境 fileID/存储提升、sharp Linux 运行时、内容审核违规/不可用、3/10 并发与唯一索引实测并入 DEV-13；pending/孤立 active 对象的分页补偿由 DEV-05 完成；已静态覆盖 UPL-05～UPL-16，建立 UPL-20 补偿登记 |
| DEV-05 上传补偿与清理 | TODO | — | — | — |
| DEV-06 图片查询与详情 | TODO | — | — | — |
| DEV-07 异步图片删除 | TODO | — | — | — |
| DEV-08 备注事务与 Cursor | TODO | — | — | — |
| DEV-09 标签核心 | TODO | — | — | — |
| DEV-10 引用清理与计数校正 | TODO | — | — | — |
| DEV-11 账号注销 | TODO | — | — | — |
| DEV-12 cleanup 与安全收口 | TODO | — | — | — |
| DEV-13 契约切换、验收与发布 | TODO | — | — | — |

## 11. 最终重新审计

DEV-13 完成后必须重新执行 134 项后端审计：

- 每项给出代码、配置、测试或云环境证据。
- P0/P1 不允许以“文件存在”或“主流程可用”替代事务、并发、失败恢复和权限证据。
- 云环境不可验证项必须明确负责人和阻断原因。
- 只有重新审计、产品验收和发布门禁均通过，才能宣布 V1.0.0 后端完成。
