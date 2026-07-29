# BACKEND IMPLEMENTATION AUDIT RESULT — 图片笔记小程序 V1.0.0

> 审计日期：2026-07-29  
> 实施基线：[BACKEND-IMPLEMENTATION-BREAKDOWN-图片笔记小程序-V1.0.0.md](./BACKEND-IMPLEMENTATION-BREAKDOWN-图片笔记小程序-V1.0.0.md)  
> 检查基线：[BACKEND-IMPLEMENTATION-AUDIT-图片笔记小程序-V1.0.0.md](./BACKEND-IMPLEMENTATION-AUDIT-图片笔记小程序-V1.0.0.md)  
> 检查方式：当前工作区静态代码、配置和前端调用契约审计；未连接腾讯云控制台。  
> 完成口径：只有 `IMPLEMENTED` 计为完成，`PARTIAL` 不计为完成。

## 1. 审计范围与结论

已检查：

- 7 个目标云函数：`user`、`upload`、`photo`、`note`、`tag`、`account`、`cleanup`。
- `scripts/db-init.js` 中的集合、索引和回填逻辑。
- 所有云函数 `config.json`、`package.json` 及仓库内测试文件。
- 小程序上传、图片/备注分页、标签批量关联、删除和注销调用契约。
- BE-01～BE-27、134 个 COM/INF/USR/UPL/PHQ/PHD/NTE/TAG/ACC/CLN/API 检查项、5 条跨模块流程和 15 条横切检查。

未检查或受阻：

- 云开发控制台中的实际集合、索引、权限规则、存储权限、环境变量和已部署触发器。
- 内容安全 API、临时 URL、事务冲突、并发幂等、定时任务在真实云环境中的行为。

总体结论：**当前后端不能按 V1.0.0 实施拆分判定为完成，不具备按新契约发布条件。** 代码已覆盖登录、单阶段上传确认、图片/备注/标签基础 CRUD、删除和注销申请等早期功能，但上传 attempt 状态机、服务端文件真实性校验、ACTIVE 图片隔离、Keyset Cursor、分阶段可恢复删除、注销执行器、双触发器和自动化验证尚未形成闭环。

### 1.1 任务包统计

| 总数 | IMPLEMENTED | PARTIAL | NOT_IMPLEMENTED | DEVIATED | UNVERIFIED | BLOCKED | 完成率 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 27 | 0 | 14 | 5 | 8 | 0 | 0 | 0% |

### 1.2 技术检查项统计

| 总数 | IMPLEMENTED | PARTIAL | NOT_IMPLEMENTED | DEVIATED | UNVERIFIED | BLOCKED | 完成率 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 134 | 8 | 51 | 40 | 31 | 4 | 0 | 5.97% |

## 2. 后端结构概览

| 子系统 | 当前实现 |
|---|---|
| 身份 | 各云函数直接读取 `getWXContext().OPENID`，业务函数分别实现 ACTIVE 检查。 |
| 上传 | 仅支持 `upload/confirm`；客户端自行生成路径并直传，随后提交客户端 size/width/height/format。 |
| 图片 | ALL/UNCATEGORIZED/TAG 使用 page/skip；详情返回完整 photo；删除同步删存储与数据库。 |
| 备注 | CRUD 和四种排序入口存在，但写计数非事务，列表使用 offset 且不校验关联图片状态。 |
| 标签 | CRUD、单图关联、批量关联和部分计数事务存在；缺少稳定分页、ACTIVE 过滤和部分成功协议。 |
| 注销 | 支持申请和查询；没有注销数据清理执行器。 |
| cleanup | 每日执行失败图片删除重试、孤立关系清理和计数校正；没有租约、续跑游标和高频触发器。 |
| 基础设施 | 初始化脚本声明 6 个集合和部分索引；缺少 `upload_attempts` 及多项唯一/Keyset/任务索引。 |
| 测试 | 目标云函数没有 test 脚本或测试文件。 |

## 3. BE-01～BE-27 完成情况

| 编号 | 优先级 | 状态 | 已完成能力与证据 | 主要缺口 | 影响与建议 |
|---|---:|---|---|---|---|
| BE-01 公共云函数内核 | P0 | PARTIAL | 各入口有 type 白名单、OPENID 和异常边界，如 `cloudfunctions/upload/index.js:132-148`。 | 无公共模块；校验/错误结构重复，原始异常和标识进入日志。 | 影响全部云函数；先建立共享响应、校验、身份、事务、错误和脱敏日志模块。 |
| BE-02 集合、字段与索引 | P0 | PARTIAL | 脚本定义 6 个集合及标签唯一索引，`scripts/db-init.js:51-133`。 | 缺 `upload_attempts`、上传三道唯一索引、task_key、Keyset `_id` 索引及完整回填。 | 阻断上传幂等和稳定分页；按架构索引清单重建初始化脚本。 |
| BE-03 数据库与云存储权限 | P0 | DEVIATED | 业务接口可生成临时 URL，`cloudfunctions/photo/index.js:123-140`。 | 仓库无权限规则；客户端自行选择 `photos/` 路径直传，`miniprogram/components/upload-panel/upload-panel.js:171-187`。 | 存在越路径/覆盖风险；改为服务端签发 pending 路径并完成控制台反向验证。 |
| BE-04 运行配置与触发器 | P0 | PARTIAL | 云函数使用动态环境；有每日触发器，`cloudfunctions/cleanup/config.json:1`。 | 初始化脚本硬编码环境回退；无 HMAC/灰度配置和每 5 分钟触发器。 | 补齐环境配置与高频/每日双入口。 |
| BE-05 用户登录与状态 | P0 | PARTIAL | login/getStatus、默认 500 MB 配额存在，`cloudfunctions/user/index.js:9-90`。 | 首登非并发幂等；DELETED 会被复活；login 返回含 `_openid` 的完整 user。 | 修正身份生命周期、响应投影和并发首次创建。 |
| BE-06 上传 prepare 与 attempt 状态机 | P0 | NOT_IMPLEMENTED | 无。 | `upload` 只路由 confirm，`cloudfunctions/upload/index.js:132-142`；无 attempt 集合/状态。 | 先实现 prepare、随机路径、24h 到期和幂等状态机。 |
| BE-07 上传文件真实性与内容审核 | P0 | PARTIAL | 下载 buffer 并调用图片审核，`cloudfunctions/upload/index.js:64-84`。 | 无租约、fileID 环境/路径、magic bytes、解码尺寸、动态图片校验；审核不可用时放行。 | 重构 confirm 处理阶段，所有元数据以服务端 buffer 为准。 |
| BE-08 上传确认事务与幂等 | P0 | PARTIAL | photo 与 used_bytes 在同一事务，`cloudfunctions/upload/index.js:102-123`。 | 无 attempt；事务使用客户端 size；无唯一索引；并发幂等检查在事务外。 | 建立 user/photo/attempt 最终事务和数据库唯一防线。 |
| BE-09 上传取消与竞态 | P0 | NOT_IMPLEMENTED | 无。 | 无 cancel 路由、批量结果和 confirm/cancel 线性化。 | 在 attempt 状态机上实现 1～20 项取消。 |
| BE-10 上传过期与对象补偿 | P1 | NOT_IMPLEMENTED | 无。 | cleanup 不处理 attempt、pending 或孤立 active 对象。 | 增加过期、租约释放和有游标的对象补偿。 |
| BE-11 全部与未分类图片列表 | P1 | DEVIATED | ALL/UNCATEGORIZED、用户过滤、缩略图存在，`cloudfunctions/photo/index.js:58-153`。 | 无 ACTIVE、Keyset、`_id` 第二排序键；使用 page/skip。 | 按 scope 绑定 HMAC cursor 并更新索引。 |
| BE-12 标签筛选图片列表 | P1 | DEVIATED | 校验本人 tag 并恢复 relation 顺序，`cloudfunctions/photo/index.js:80-112`。 | 全量读取关系、offset 分页、无 ACTIVE；读取接口直接删除失效关系。 | 改为 relation cursor、批量 ACTIVE 二次过滤和继续扫描。 |
| BE-13 图片详情与受控 URL | P1 | PARTIAL | 聚合图片、备注、标签和临时 URL，`cloudfunctions/photo/index.js:159-205`。 | 无 ACTIVE；返回完整 photo，暴露 file_id/_openid/内部字段。 | 增加状态条件和严格响应投影。 |
| BE-14 图片删除申请与状态 | P0 | DEVIATED | 有 delete 路由和 deletion_tasks 记录，`cloudfunctions/photo/index.js:211-277`。 | 先删存储/数据再建任务；不先标记 DELETING；无 task_key 和 getDeleteStatus。 | 重写为申请事务，提交后立即隐藏并异步推进。 |
| BE-15 图片删除任务执行器 | P0 | PARTIAL | cleanup 能重试 FAILED 图片删除，`cloudfunctions/cleanup/index.js:59-113`。 | 无四阶段、租约、游标；重试成功不释放 used_bytes；任务完成不与最终事务原子提交。 | 实现可重放的分阶段执行器。 |
| BE-16 备注写操作 | P1 | DEVIATED | CRUD、文本审核和可选 updated_at 条件存在，`cloudfunctions/note/index.js:33-179`。 | 图片无 ACTIVE；note 与计数分开提交；updatedAt 可省略；冲突读取未带 `_openid`。 | 使用事务、强制版本条件并统一存在性保护。 |
| BE-17 备注列表与排序 | P1 | DEVIATED | 可选择 created_at/photo_shoot_time 与方向，`cloudfunctions/note/index.js:184-247`。 | offset、无 `_id` 稳定键、无 cursor、无 ACTIVE photo 二次过滤。 | 实现四组 Keyset 查询和失效引用继续扫描。 |
| BE-18 标签规范化与 CRUD | P1 | PARTIAL | CRUD、NFC/大小写归一、唯一索引脚本存在，`cloudfunctions/tag/index.js:25-68,138-236`。 | 审核不可用会放行；规范化顺序有边界问题；删除无分页/ACTIVE 保护。 | 固化规范化函数与失败策略，补并发和大数据测试。 |
| BE-19 单图标签查询与增量更新 | P1 | PARTIAL | 差异计算和双方计数事务存在，`cloudfunctions/tag/index.js:241-330`。 | getPhotoTags 不验证图片；无 ACTIVE；add/remove 不拒绝交叉；当前关系在事务外读取。 | 将验证、当前集合和差异写入同一事务。 |
| BE-20 上传后批量添加标签 | P1 | DEVIATED | 有 20 图/5 标签限制和逐图事务，`cloudfunctions/tag/index.js:74-132`。 | 任一无效图片/超限会提前终止；没有逐图结果、requestId 幂等或 ACTIVE 过滤。 | 返回 per-photo success/invalid/limitExceeded。 |
| BE-21 标签引用清理与计数校正 | P2 | PARTIAL | cleanup 清理部分孤立关系并校正双向计数，`cloudfunctions/cleanup/index.js:118-176`。 | 每次只处理首 100 条且无 cursor；不清理缺失 tag 的关系。 | 增加稳定扫描游标和全量补偿状态。 |
| BE-22 注销申请与状态 | P0 | PARTIAL | 确认文字、申请和状态查询存在，`cloudfunctions/account/index.js:11-63`。 | 用户状态与任务非事务；未校验 ACTIVE；重复申请不返回原任务且无唯一索引。 | 使用 task_key 唯一约束和申请事务。 |
| BE-23 注销任务执行器 | P0 | NOT_IMPLEMENTED | 无。 | cleanup 完全没有 ACCOUNT_DELETION 分支。 | 建立分阶段全量清理，最后执行身份解绑。 |
| BE-24 cleanup 调度与有界执行 | P1 | PARTIAL | 子任务故障隔离和单批 100 条存在，`cloudfunctions/cleanup/index.js:11-53`。 | 仅每日入口；无触发上下文分流、任务租约、续跑游标和最大扫描轮次。 | 拆分高频推进与每日补偿，持久化游标。 |
| BE-25 安全、隐私与可观测性 | P0 | PARTIAL | 备注/标签/图片审核调用和部分归属查询存在。 | 图片/标签审核 fail-open；日志记录原始 ID/异常；响应泄露内部对象；无结构化安全事件。 | 统一 fail-closed 策略、响应投影和不可逆摘要日志。 |
| BE-26 接口契约与兼容发布 | P0 | DEVIATED | 前后端当前旧接口能对应 confirm/page 模式。 | 与 prepare/confirm/cancel、cursor、异步删除新契约不一致；无灰度/发布顺序配置。 | 先定稿契约，再按后端兼容→前端→清理旧协议发布。 |
| BE-27 自动化验证与云环境验收 | P0 | NOT_IMPLEMENTED | JavaScript 文件可进行静态语法检查。 | 无单元/集成/并发/故障注入测试，也无云环境核验报告。 | 建立测试夹具和环境验收记录，作为发布门禁。 |

## 4. P0/P1 缺口摘要与修复顺序

1. **身份与立即隐藏**：所有图片业务查询必须带 `_openid + status=ACTIVE`；修复 note 冲突读取和响应字段泄露。
2. **上传协议**：新增 `upload_attempts`、prepare/cancel、服务端 pending 路径、真实性校验、租约及 user/photo/attempt 最终事务。
3. **数据库约束**：补上传三道唯一索引、task_key、所有 Keyset `_id` 复合索引和完整回填。
4. **删除与注销**：删除改为申请事务和四阶段执行；新增注销执行器，完成全部清理后再解绑。
5. **分页契约**：图片和备注从 page/skip 改为绑定 scope/sort 的 HMAC Keyset cursor。
6. **安全与权限**：内容审核不可用时不放行；控制台禁止客户端数据库访问和 active 对象写入。
7. **cleanup**：配置每 5 分钟推进和每日补偿，增加租约、批次、游标和故障隔离。
8. **验证门禁**：补单测、集成、并发/故障注入和云环境权限/索引/触发器验收。

## 5. 完整技术检查矩阵

### 5.1 公共能力与基础设施

| 编号 | 状态 | 证据 | 结论/缺口 | 风险 |
|---|---|---|---|---|
| COM-01 | PARTIAL | `cloudfunctions/upload/index.js:132-148` | 有白名单和边界，但各函数重复且异常映射不安全。 | P0 |
| COM-02 | PARTIAL | `cloudfunctions/user/index.js:19-70`; `cloudfunctions/account/index.js:57-63` | code/data 基本存在，响应字段和错误结构不统一。 | P0 |
| COM-03 | PARTIAL | `cloudfunctions/note/index.js:33-43`; `cloudfunctions/note/index.js:184-194` | 部分长度校验存在，分页、数组、枚举校验不完整。 | P0 |
| COM-04 | IMPLEMENTED | `cloudfunctions/account/index.js:6,67-69`; `cloudfunctions/tag/index.js:12,334-336` | 目标云函数均从 WXContext 取 OPENID。 | P0 |
| COM-05 | PARTIAL | `cloudfunctions/upload/index.js:10-20`; `cloudfunctions/account/index.js:11-39` | 主要业务有检查，注销申请和 user 附加接口未统一按状态约束。 | P0 |
| COM-06 | PARTIAL | `cloudfunctions/photo/index.js:163-166`; `cloudfunctions/note/index.js:134-146` | 多数入口限制归属，但存在后续按 doc(id) 的无归属读取/更新。 | P0 |
| COM-07 | PARTIAL | `cloudfunctions/tag/index.js:181-184`; `cloudfunctions/note/index.js:134-143` | 多数返回统一 not-found，note 冲突路径可能泄露他人资源。 | P0 |
| COM-08 | PARTIAL | `cloudfunctions/tag/index.js:165-171`; `cloudfunctions/user/index.js:230-235` | 仅局部映射唯一冲突；普遍透传 err.code/message。 | P0 |
| COM-09 | PARTIAL | `cloudfunctions/upload/index.js:103-123`; `cloudfunctions/tag/index.js:287-318` | 有事务但无公共重试，多个关键状态仍拆分提交。 | P0 |
| COM-10 | DEVIATED | `cloudfunctions/photo/index.js:99-103`; `cloudfunctions/user/index.js:198-205` | 日志/健康响应包含资源 ID、原始错误或 OPENID 前缀。 | P0 |
| COM-11 | PARTIAL | `cloudfunctions/upload/index.js:64-84`; `cloudfunctions/note/index.js:52-66` | 审核存在，但图片和部分标签路径在服务不可用时放行。 | P0 |
| COM-12 | PARTIAL | `cloudfunctions/user/index.js:1-3`; `scripts/db-init.js:29-31` | 云函数用动态环境，初始化脚本有硬编码环境回退且无灰度/HMAC 配置。 | P0 |
| INF-01 | PARTIAL | `scripts/db-init.js:51-133` | 仅声明 6 个集合，缺 upload_attempts。 | P0 |
| INF-02 | PARTIAL | `cloudfunctions/photo/index.js:87-101`; `cloudfunctions/account/index.js:30-36` | 基础字段存在，缺 attempt、任务阶段/租约/游标等字段。 | P0 |
| INF-03 | NOT_IMPLEMENTED | `scripts/db-init.js:60-69` | 无 attempt task、photo task、photo attempt 唯一索引。 | P0 |
| INF-04 | UNVERIFIED | `scripts/db-init.js:90-123` | 仓库有标签与关系唯一索引脚本，实际创建状态需云环境验证。 | P0 |
| INF-05 | NOT_IMPLEMENTED | `scripts/db-init.js:60-123` | 列表索引缺 status 和稳定 `_id`，无法支持目标 cursor。 | P0 |
| INF-06 | NOT_IMPLEMENTED | `scripts/db-init.js:126-131` | 无 task_key 唯一、租约和阶段调度索引。 | P0 |
| INF-07 | UNVERIFIED | `scripts/db-init.js:190-194` | 脚本明确不配置权限，控制台实际规则未知。 | P0 |
| INF-08 | DEVIATED | `miniprogram/components/upload-panel/upload-panel.js:171-187` | 客户端自行生成路径，未使用服务端签发 pending。 | P0 |
| INF-09 | UNVERIFIED | `cloudfunctions/upload/config.json:1`; `miniprogram/components/upload-panel/upload-panel.js:171-187` | active 写权限无法确认，当前协议允许客户端直传 `photos/`。 | P0 |
| INF-10 | PARTIAL | `cloudfunctions/photo/index.js:169-180,198-205` | 有临时 URL，但详情返回完整 photo/file_id。 | P0 |
| INF-11 | DEVIATED | `cloudfunctions/cleanup/config.json:1-10` | 仅每日 03:00，无至少每 5 分钟触发器。 | P0 |
| INF-12 | PARTIAL | `scripts/db-init.js:70-78` | 只回填 tag_count，缺 status、updated_at 和抽样核验。 | P0 |

### 5.2 用户与上传

| 编号 | 状态 | 证据 | 结论/缺口 | 风险 |
|---|---|---|---|---|
| USR-01 | PARTIAL | `cloudfunctions/user/index.js:9-71` | login 可查/建用户，但并发首登和安全投影不满足。 | P0 |
| USR-02 | PARTIAL | `cloudfunctions/user/index.js:57-67` | 默认值正确，创建无唯一冲突幂等处理。 | P0 |
| USR-03 | IMPLEMENTED | `cloudfunctions/user/index.js:77-90` | getStatus 返回权威状态。 | P0 |
| USR-04 | PARTIAL | `cloudfunctions/photo/index.js:10-20,281-290` | 核心业务检查 ACTIVE，但未覆盖全部普通接口。 | P0 |
| USR-05 | PARTIAL | `cloudfunctions/tag/index.js:84-87`; `cloudfunctions/note/index.js:134-146` | 多数查询限制 `_openid`，仍有无归属 doc 读取。 | P0 |
| USR-06 | IMPLEMENTED | `cloudfunctions/user/index.js:93-112` | 空间值来自权威 user 文档。 | P1 |
| UPL-01 | NOT_IMPLEMENTED | `cloudfunctions/upload/index.js:137-141` | 无 prepare。 | P0 |
| UPL-02 | NOT_IMPLEMENTED | `cloudfunctions/upload/index.js:23-53` | 只有 photo/taskId 预查，不是 attempt prepare 幂等。 | P0 |
| UPL-03 | DEVIATED | `miniprogram/components/upload-panel/upload-panel.js:171-176` | 路径由客户端生成。 | P0 |
| UPL-04 | NOT_IMPLEMENTED | `scripts/db-init.js:51-133` | 无 upload_attempts 和状态机。 | P0 |
| UPL-05 | NOT_IMPLEMENTED | `cloudfunctions/upload/index.js:26-129` | 无 confirm 租约/token/过期复核。 | P0 |
| UPL-06 | NOT_IMPLEMENTED | `cloudfunctions/upload/index.js:26-84` | 无 fileID 环境校验。 | P0 |
| UPL-07 | NOT_IMPLEMENTED | `cloudfunctions/upload/index.js:26-84` | 无 attempt pending 路径完全匹配。 | P0 |
| UPL-08 | DEVIATED | `cloudfunctions/upload/index.js:27-36,55-61` | 直接信任客户端 size。 | P0 |
| UPL-09 | NOT_IMPLEMENTED | `cloudfunctions/upload/index.js:64-74` | 未检查 magic bytes、解码和静态 JPEG/PNG。 | P0 |
| UPL-10 | DEVIATED | `cloudfunctions/upload/index.js:91-94` | width/height 直接取客户端值。 | P0 |
| UPL-11 | PARTIAL | `cloudfunctions/upload/index.js:33-36,95-96` | 接收拍摄时间，但无类型、枚举和范围验证。 | P1 |
| UPL-12 | DEVIATED | `cloudfunctions/upload/index.js:64-84` | 有 imgSecCheck，但审核不可用时放行。 | P0 |
| UPL-13 | NOT_IMPLEMENTED | `cloudfunctions/upload/index.js:64-101` | 未写随机 active 路径、未保存 SHA-256。 | P0 |
| UPL-14 | PARTIAL | `cloudfunctions/upload/index.js:102-123` | photo/user 同事务，无 attempt 且使用客户端 size。 | P0 |
| UPL-15 | PARTIAL | `cloudfunctions/upload/index.js:103-119` | 超额时事务不写 photo，但无 attempt PREPARED 语义。 | P0 |
| UPL-16 | PARTIAL | `cloudfunctions/upload/index.js:42-53` | 有重放预查，但无唯一索引，并发仍可重复。 | P0 |
| UPL-17 | NOT_IMPLEMENTED | `scripts/db-init.js:60-69` | 无上传唯一防线。 | P0 |
| UPL-18 | NOT_IMPLEMENTED | `cloudfunctions/upload/index.js:137-141` | 无 cancel。 | P0 |
| UPL-19 | NOT_IMPLEMENTED | `cloudfunctions/upload/index.js:26-129` | 无 confirm/cancel 竞态状态机。 | P0 |
| UPL-20 | NOT_IMPLEMENTED | `cloudfunctions/upload/index.js:120-123` | 事务失败后客户端已上传对象无补偿登记。 | P0 |
| UPL-21 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:11-53` | 无 attempt 过期。 | P1 |
| UPL-22 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:11-53` | 无 pending/孤立 active 清理。 | P1 |

### 5.3 图片查询与删除

| 编号 | 状态 | 证据 | 结论/缺口 | 风险 |
|---|---|---|---|---|
| PHQ-01 | PARTIAL | `cloudfunctions/photo/index.js:113-153` | 本人列表和临时图存在，无 ACTIVE/字段投影查询/cursor。 | P1 |
| PHQ-02 | PARTIAL | `cloudfunctions/photo/index.js:73-79` | 有 tag_count=0，无 ACTIVE 和稳定 cursor。 | P1 |
| PHQ-03 | DEVIATED | `cloudfunctions/photo/index.js:80-112` | 校验 tag，但全量关系和图片、无 ACTIVE。 | P1 |
| PHQ-04 | PARTIAL | `cloudfunctions/photo/index.js:159-205` | 详情聚合存在，无 ACTIVE 且暴露内部字段。 | P1 |
| PHQ-05 | DEVIATED | `cloudfunctions/photo/index.js:74-76,114-116` | 仅按 upload_time 排序，无 `_id`。 | P1 |
| PHQ-06 | NOT_IMPLEMENTED | `cloudfunctions/photo/index.js:58-70` | 使用 page/skip，无 Keyset cursor。 | P1 |
| PHQ-07 | NOT_IMPLEMENTED | `cloudfunctions/photo/index.js:58-70` | 无 cursor 编码、签名和 scope 绑定。 | P0 |
| PHQ-08 | DEVIATED | `cloudfunctions/photo/index.js:26-42,87-110` | 全量扫描后本地分页，不以最后扫描 relation 生成 cursor。 | P1 |
| PHQ-09 | PARTIAL | `cloudfunctions/photo/index.js:123-140,169-180` | URL 动态生成，但详情同时返回 file_id。 | P0 |
| PHQ-10 | DEVIATED | `cloudfunctions/photo/index.js:26-42,69-76` | 明确使用 skip，并加载全部 TAG 关系。 | P1 |
| PHD-01 | DEVIATED | `cloudfunctions/photo/index.js:211-273` | 删除实现存在，但不是 ACTIVE→DELETING+任务的申请事务。 | P0 |
| PHD-02 | NOT_IMPLEMENTED | `scripts/db-init.js:126-131`; `cloudfunctions/photo/index.js:273` | 无 task_key 唯一，重复删除不能返回原任务。 | P0 |
| PHD-03 | NOT_IMPLEMENTED | `cloudfunctions/photo/index.js:73-118,159-166` | 业务查询没有 status=ACTIVE，且申请阶段不先隐藏。 | P0 |
| PHD-04 | NOT_IMPLEMENTED | `cloudfunctions/photo/index.js:286-290` | 无 getDeleteStatus。 | P1 |
| PHD-05 | PARTIAL | `cloudfunctions/photo/index.js:232-240` | 会删对象，但对象不存在/安全重放没有明确完成语义。 | P0 |
| PHD-06 | DEVIATED | `cloudfunctions/photo/index.js:245-251` | 一次读取并逐条删除，无分页和恢复游标。 | P0 |
| PHD-07 | PARTIAL | `cloudfunctions/photo/index.js:252-258` | 按读取关系递减，但无阶段游标/批次/非负保护。 | P0 |
| PHD-08 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:78-100` | 无 stage_cursor，数据变更和任务进度不在同一事务。 | P0 |
| PHD-09 | PARTIAL | `cloudfunctions/photo/index.js:243-273` | photo/空间初次路径同事务，task COMPLETED 在事务外；重试不扣空间。 | P0 |
| PHD-10 | DEVIATED | `cloudfunctions/photo/index.js:259-273` | 先释放空间，后创建 COMPLETED/FAILED 任务。 | P0 |
| PHD-11 | PARTIAL | `cloudfunctions/cleanup/index.js:59-113` | 能重试 FAILED，但无 PENDING/RETRYING 租约与崩溃恢复。 | P0 |
| PHD-12 | PARTIAL | `cloudfunctions/cleanup/index.js:78-108` | 部分删除操作可重放，但状态/空间闭环不幂等。 | P0 |

### 5.4 备注与标签

| 编号 | 状态 | 证据 | 结论/缺口 | 风险 |
|---|---|---|---|---|
| NTE-01 | PARTIAL | `cloudfunctions/note/index.js:33-66` | 归属、长度、审核存在，但图片无 ACTIVE。 | P1 |
| NTE-02 | DEVIATED | `cloudfunctions/note/index.js:78-82` | note 创建和 note_count 更新分开提交。 | P0 |
| NTE-03 | PARTIAL | `cloudfunctions/note/index.js:93-132` | 审核和条件更新存在，但 updatedAt 可省略。 | P1 |
| NTE-04 | DEVIATED | `cloudfunctions/note/index.js:134-143` | 冲突后按 doc(noteId) 读取，未限制 `_openid` 且返回完整 note。 | P0 |
| NTE-05 | DEVIATED | `cloudfunctions/note/index.js:156-178` | 删除和计数分开提交，可能半完成/负计数。 | P0 |
| NTE-06 | PARTIAL | `cloudfunctions/photo/index.js:182-203` | 详情加载本人备注，但父图片无 ACTIVE。 | P1 |
| NTE-07 | DEVIATED | `cloudfunctions/note/index.js:196-203` | 仅按 note._openid 查询，不验证关联 ACTIVE photo。 | P0 |
| NTE-08 | PARTIAL | `cloudfunctions/note/index.js:184-201` | 可选四种组合，但参数校验和相应稳定索引不足。 | P1 |
| NTE-09 | NOT_IMPLEMENTED | `cloudfunctions/note/index.js:191-201` | 使用 skip，无 `_id` 第二排序键和 cursor。 | P1 |
| NTE-10 | IMPLEMENTED | `cloudfunctions/note/index.js:68-76` | 冗余字段来自查询到的权威 photo。 | P1 |
| NTE-11 | IMPLEMENTED | `cloudfunctions/note/index.js:205-223` | 批量生成临时缩略图且不持久化。 | P1 |
| NTE-12 | NOT_IMPLEMENTED | `cloudfunctions/note/index.js:196-203`; `cloudfunctions/cleanup/index.js:11-53` | 列表不跳过失效引用，cleanup 不清理孤立 note。 | P1 |
| TAG-01 | PARTIAL | `cloudfunctions/tag/index.js:48-68` | QUICK/ALL 限制和多字段排序存在，缺 `_id` 稳定键。 | P1 |
| TAG-02 | PARTIAL | `cloudfunctions/tag/index.js:138-171`; `scripts/db-init.js:90-107` | 创建、上限和唯一脚本存在；审核异常放行且数量检查有竞态。 | P1 |
| TAG-03 | PARTIAL | `cloudfunctions/tag/index.js:178-205` | 只更新名称可保持关系/计数，审核异常可能放行。 | P1 |
| TAG-04 | PARTIAL | `cloudfunctions/tag/index.js:211-235` | 幂等删除和关系事务存在，但无分页、ACTIVE/失效 photo 防护。 | P1 |
| TAG-05 | PARTIAL | `cloudfunctions/tag/index.js:25-42` | trim、控制字符、code point、NFC、拉丁归一存在；长度/保留名在 NFC 前判断。 | P1 |
| TAG-06 | DEVIATED | `cloudfunctions/tag/index.js:241-255` | 不校验本人 ACTIVE photo，只查关系。 | P0 |
| TAG-07 | PARTIAL | `cloudfunctions/tag/index.js:261-318` | 有差异写入，但不拒绝交叉数组且当前集合在事务外。 | P0 |
| TAG-08 | IMPLEMENTED | `cloudfunctions/tag/index.js:276-285` | 合并后超过 5 个会在写入前返回。 | P1 |
| TAG-09 | PARTIAL | `cloudfunctions/tag/index.js:74-131` | 数量限制和逐图事务存在，无 ACTIVE 和 requestId 幂等。 | P1 |
| TAG-10 | DEVIATED | `cloudfunctions/tag/index.js:84-103` | 无效或超限直接结束整个请求，不返回部分结果。 | P1 |
| TAG-11 | PARTIAL | `scripts/db-init.js:110-123`; `cloudfunctions/tag/index.js:287-318` | 有唯一索引脚本，但并发冲突未映射为幂等成功。 | P0 |
| TAG-12 | PARTIAL | `cloudfunctions/tag/index.js:289-313` | 事务更新双方计数，但事务外差异读取可导致并发错误。 | P0 |
| TAG-13 | DEVIATED | `cloudfunctions/photo/index.js:26-42,80-110` | 使用全量/offset，不是 relation cursor+ACTIVE 继续扫描。 | P1 |
| TAG-14 | IMPLEMENTED | `cloudfunctions/photo/index.js:111-112`; `cloudfunctions/tag/index.js:306-307` | 成功筛选和实际新增关系会更新 last_used_at。 | P1 |
| TAG-15 | DEVIATED | `cloudfunctions/tag/index.js:181-184,211-217` | rename 返回 TAG_NOT_FOUND，delete 对相同情形返回 SUCCESS，外部语义不统一。 | P0 |
| TAG-16 | PARTIAL | `cloudfunctions/cleanup/index.js:118-176` | 有关系/计数补偿，但只扫首批且不处理缺失 tag。 | P2 |

### 5.5 注销、后台任务与接口契约

| 编号 | 状态 | 证据 | 结论/缺口 | 风险 |
|---|---|---|---|---|
| ACC-01 | PARTIAL | `cloudfunctions/account/index.js:11-39` | 有确认文字和任务创建，未校验 ACTIVE 且非事务。 | P0 |
| ACC-02 | DEVIATED | `cloudfunctions/account/index.js:17-23` | 重复申请返回错误而非原任务，且无唯一约束。 | P0 |
| ACC-03 | DEVIATED | `cloudfunctions/account/index.js:25-37` | 用户状态和任务分开写，失败可使用户永久 DELETING。 | P0 |
| ACC-04 | PARTIAL | `cloudfunctions/account/index.js:43-63` | 返回公开状态/重试数，缺任务时间和安全重试信息。 | P1 |
| ACC-05 | PARTIAL | `cloudfunctions/photo/index.js:10-20`; `cloudfunctions/tag/index.js:14-20` | 主要业务会拦截，user 附加接口仍可调用。 | P0 |
| ACC-06 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:11-53` | 无注销图片对象清理。 | P0 |
| ACC-07 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:11-53` | 无注销备注清理。 | P0 |
| ACC-08 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:11-53` | 无注销 photo_tags 清理。 | P0 |
| ACC-09 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:11-53` | 无注销 tags 清理。 | P0 |
| ACC-10 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:11-53` | 无注销 photo/空间收尾。 | P0 |
| ACC-11 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:11-53` | 无最终身份解绑。 | P0 |
| ACC-12 | NOT_IMPLEMENTED | `cloudfunctions/account/index.js:30-36`; `cloudfunctions/cleanup/index.js:11-53` | 任务无阶段、游标、租约和重试执行器。 | P0 |
| CLN-01 | DEVIATED | `cloudfunctions/cleanup/index.js:9-18`; `cloudfunctions/cleanup/config.json:1-10` | 只有每日入口，不能区分高频和每日补偿。 | P1 |
| CLN-02 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:59-68` | 任务领取无租约。 | P0 |
| CLN-03 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:11-53` | 无上传过期处理。 | P1 |
| CLN-04 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:11-53` | 无 pending 清理。 | P1 |
| CLN-05 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:11-53` | 无孤立 active 清理。 | P1 |
| CLN-06 | DEVIATED | `cloudfunctions/cleanup/index.js:59-113` | 有失败删除重试，但无 current_stage/stage_cursor。 | P0 |
| CLN-07 | NOT_IMPLEMENTED | `cloudfunctions/cleanup/index.js:11-53` | 无注销任务推进。 | P0 |
| CLN-08 | PARTIAL | `cloudfunctions/cleanup/index.js:118-138` | 只清理缺失 photo 的 photo_tags，不清理孤立 note/缺失 tag。 | P2 |
| CLN-09 | PARTIAL | `cloudfunctions/cleanup/index.js:140-176` | 有双向计数校正，但只处理首 100 条且无续跑。 | P2 |
| CLN-10 | PARTIAL | `cloudfunctions/cleanup/index.js:6,59-63,118-122` | 单批有上限，但无稳定 cursor、扫描轮次和超时续跑。 | P1 |
| CLN-11 | DEVIATED | `cloudfunctions/cleanup/index.js:20-52,101-107` | 日志/任务保存原始 error message，无摘要和安全码。 | P0 |
| API-01 | DEVIATED | `miniprogram/components/upload-panel/upload-panel.js:171-202`; `miniprogram/services/upload.js:4-18` | 客户端直传后只调用 confirm，并传可信元数据。 | P0 |
| API-02 | NOT_IMPLEMENTED | `miniprogram/components/upload-panel/upload-panel.js:193-217` | 不保存 attemptId/expiresAt，恢复依据只有本地 taskId。 | P0 |
| API-03 | NOT_IMPLEMENTED | `miniprogram/services/upload.js:1-18` | 无 cancel 结果协议。 | P0 |
| API-04 | DEVIATED | `miniprogram/services/photos.js:8-10` | 客户端使用 page/pageSize。 | P1 |
| API-05 | DEVIATED | `miniprogram/services/notes.js:20-22` | 客户端使用 page/pageSize，无 nextCursor。 | P1 |
| API-06 | NOT_IMPLEMENTED | `cloudfunctions/photo/index.js:286-290`; `miniprogram/pages/preview/preview.js:121-133` | 无 getDeleteStatus；前端只处理 delete 即时结果。 | P1 |
| API-07 | DEVIATED | `cloudfunctions/photo/index.js:290-297`; `cloudfunctions/account/index.js:21-23` | 错误码/状态仍为旧协议，缺统一映射和兼容层。 | P0 |
| API-08 | IMPLEMENTED | `miniprogram/components/upload-panel/upload-panel.js:205-209,234-238` | 仅把 confirm 成功且有 photoId 的任务传给批量标签。 | P1 |
| API-09 | UNVERIFIED | 仓库未发现发布流水线或兼容开关。 | 无法确认新旧客户端/云函数不会混发。 | P0 |

## 6. 跨模块流程验证

| 流程 | 状态 | 验证结果 |
|---|---|---|
| 上传成功 | NOT_IMPLEMENTED | 仅“客户端直传→confirm 审核→photo/user 事务”；缺 prepare、租约、真实性校验、active 提升、attempt 最终事务和对象补偿。 |
| 上传取消竞态 | NOT_IMPLEMENTED | 无 cancel 和 attempt 状态机。 |
| 图片删除 | DEVIATED | 当前为“删存储→单事务删 notes/relations/photo/空间→事后建任务”，不满足立即隐藏、四阶段游标和任务原子完成。 |
| 标签筛选 | DEVIATED | 校验 tag 后全量读取 relation/photo 并本地 offset；无 ACTIVE 继续扫描和 relation cursor。 |
| 账号注销 | NOT_IMPLEMENTED | 仅“user=DELETING→创建任务”；没有任何数据清理、空间收尾或身份解绑执行器。 |

## 7. 横切能力反向检查

| # | 结果 | 证据/结论 |
|---:|---|---|
| 1 | FAIL | 存在不带 `_openid` 的资源读取，如 note 冲突 `cloudfunctions/note/index.js:136`。 |
| 2 | FAIL | 多处先查询后按 doc(id) 更新，事务内未重新验证归属，如 `cloudfunctions/tag/index.js:287-313`。 |
| 3 | FAIL | 图片读写普遍没有 `status=ACTIVE`，如 `cloudfunctions/photo/index.js:73-118`。 |
| 4 | FAIL | confirm 信任客户端 size/width/height/format，`cloudfunctions/upload/index.js:27-36,91-96`。 |
| 5 | FAIL | 上传幂等先查后写且无唯一索引，`cloudfunctions/upload/index.js:42-53`。 |
| 6 | FAIL | 配额/photo 同事务但没有 attempt，无法满足三者原子提交。 |
| 7 | FAIL | photo/note 使用 `.skip()`，TAG 加载全部关系。 |
| 8 | FAIL | 图片/备注排序没有同向 `_id` 第二键。 |
| 9 | FAIL | 删除重试缺空间收尾，且任务状态不与最终数据事务提交。 |
| 10 | UNVERIFIED | 控制台权限未知；客户端当前可向自定 `photos/` 路径上传。 |
| 11 | FAIL | 详情返回完整 photo，冲突返回完整 note，错误信息和日志暴露内部细节。 |
| 12 | FAIL | 日志记录关系 ID、错误 message、OPENID 前缀。 |
| 13 | FAIL | cleanup 无任务租约和持久游标。 |
| 14 | PASS | 未发现事务失败后直接返回 SUCCESS；但图片删除存储失败会以 SUCCESS+FAILED 任务返回，属于旧契约。 |
| 15 | FAIL | 多项文档要求只有文档或完全无代码，详见完整矩阵。 |

## 8. 云环境待验证清单

以下项目不能由仓库静态证据判定为已完成：

1. 7 个集合是否实际存在、字段数据是否完成回填。
2. 初始化脚本中的标签/关系唯一索引是否成功创建；线上是否还有未纳入脚本的索引。
3. 所有集合是否禁止小程序客户端直接读写。
4. pending/active 存储权限、客户端覆盖/删除反向用例和图片私有读取。
5. cleanup 实际部署的触发器是否与仓库配置一致。
6. 内容安全 API 权限、配额、超时和错误码行为。
7. 临时 URL 到期、越权、CI 参数及批量限制。
8. 云数据库事务隔离、唯一冲突错误码和并发行为。
9. 生产环境变量、密钥、灰度开关及日志采集/脱敏配置。

## 9. 基线冲突

未发现实施拆分文档与检查基线之间的实质冲突。当前代码主要实现旧的“直传+confirm、page/skip、同步删除”协议，与两份基线均不一致，应记为实现偏差而不是基线冲突。

## 10. 验证记录

- JavaScript 语法：已对 `cloudfunctions/` 与 `scripts/` 下全部 9 个 `.js` 文件执行 `node --check`，9 个通过、0 个失败。
- 入口路由：user 4 个（含两个基线外运维/空间接口）、upload 1 个、photo 3 个、note 4 个、tag 7 个、account 2 个；cleanup 为触发器入口。
- 测试发现：目标云函数 package.json 均无 test 脚本；仓库未发现目标后端单元、集成、并发或故障恢复测试。
- 报告完整性：BE-01～BE-27 共 27 项、技术检查矩阵共 134 项；编号无缺失、无重复，状态统计与矩阵一致。
