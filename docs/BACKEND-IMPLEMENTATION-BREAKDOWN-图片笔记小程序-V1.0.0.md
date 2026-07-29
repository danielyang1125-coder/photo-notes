# BACKEND IMPLEMENTATION BREAKDOWN — 图片笔记小程序 V1.0.0

> **文档类型**：后端实施任务拆分  
> **适用版本**：V1.0.0  
> **文档日期**：2026-07-29  
> **架构基线**：[TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md](./TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md)  
> **检查基线**：[BACKEND-IMPLEMENTATION-AUDIT-图片笔记小程序-V1.0.0.md](./BACKEND-IMPLEMENTATION-AUDIT-图片笔记小程序-V1.0.0.md)  
> **用途**：把后端目标能力拆成可开发、可联调、可独立验收的任务包；实现完成后仍以检查基线逐项审计。

---

## 1. 拆分目标

本拆分覆盖 7 个云函数、7 个数据库集合、云存储、定时任务、公共后端能力、前后端契约、测试与发布准备。

任务包按业务一致性边界拆分，不强行按 Controller、Service、Repository 分层拆开。以下能力必须作为一个整体交付：

1. 上传确认中的 attempt、photo、空间配额最终事务。
2. 图片删除中的逻辑隐藏、后台分阶段清理和空间最终释放。
3. 标签关系、图片标签计数和标签图片计数的事务更新。
4. 注销申请、业务拦截、全量数据清理和最终身份解绑。
5. Keyset Cursor 的编码、参数绑定、稳定排序和查询索引。

---

## 2. 总体范围

### 2.1 云函数

| 云函数 | type/入口 | 对应任务包 |
|---|---|---|
| `user` | `login`, `getStatus` | BE-05 |
| `upload` | `prepare`, `confirm`, `cancel` | BE-06～BE-10 |
| `photo` | `list`, `detail`, `delete`, `getDeleteStatus` | BE-11～BE-15 |
| `note` | `add`, `update`, `delete`, `list` | BE-16～BE-17 |
| `tag` | `list`, `create`, `rename`, `delete`, `getPhotoTags`, `updatePhotoTags`, `batchAddPhotoTags` | BE-18～BE-21 |
| `account` | `requestDeletion`, `getDeletionStatus` | BE-22～BE-23 |
| `cleanup` | 高频任务、每日补偿 | BE-10、BE-15、BE-21、BE-23～BE-24 |

### 2.2 数据与存储

| 类型 | 范围 |
|---|---|
| 集合 | `users`, `photos`, `notes`, `tags`, `photo_tags`, `deletion_tasks`, `upload_attempts` |
| pending 存储 | `uploads/pending/{random32}.bin` |
| active 存储 | `photos/active/{random32}.{ext}` |
| 定时任务 | 至少每 5 分钟推进删除类任务；每日全量补偿 |

### 2.3 不在本拆分内

- 小程序页面、组件、样式和本地图片压缩的具体实现。
- 云开发控制台中的实际资源创建和部署操作；仓库内只准备配置、脚本和核验清单。
- 线上历史数据迁移；V1.0.0 仅包含开发、测试环境的一次性字段回填。

---

## 3. 优先级与依赖约定

| 优先级 | 含义 |
|---|---|
| P0 | 身份隔离、数据安全、配额、幂等、事务、删除与发布阻断能力 |
| P1 | 主业务闭环、稳定分页、失败恢复和主要验收能力 |
| P2 | 补偿校正、可观测性、维护性和完整测试能力 |

依赖字段中的 `BE-xx` 表示该任务开始前必须已有稳定接口或数据约束。允许在同一迭代并行开发，但联调和验收必须遵守依赖顺序。

---

## 4. 实施任务总表

| 编号 | 任务包 | 优先级 | 主要交付物 | 依赖 |
|---|---|---:|---|---|
| BE-01 | 公共云函数内核 | P0 | 路由、响应、校验、身份、错误、事务、日志公共模块 | — |
| BE-02 | 集合、字段与索引 | P0 | 7 集合 schema 约束、唯一索引、查询索引、回填脚本 | BE-01 |
| BE-03 | 数据库与云存储权限 | P0 | 客户端禁写、pending/active 权限、私有读取验证 | BE-02 |
| BE-04 | 运行配置与触发器 | P0 | 环境配置、灰度开关、cleanup 双触发器 | BE-01 |
| BE-05 | 用户登录与状态 | P0 | `user/login`, `user/getStatus` | BE-01～BE-02 |
| BE-06 | 上传 prepare 与 attempt 状态机 | P0 | `upload/prepare`、签发路径、prepare 幂等 | BE-02～BE-05 |
| BE-07 | 上传文件真实性与内容审核 | P0 | confirm 租约、文件校验、审核、active 提升 | BE-03、BE-06 |
| BE-08 | 上传确认事务与幂等 | P0 | 配额/photo/attempt 最终事务、并发防线 | BE-07 |
| BE-09 | 上传取消与竞态 | P0 | `upload/cancel`、confirm/cancel 线性化 | BE-06、BE-08 |
| BE-10 | 上传过期与对象补偿 | P1 | attempt 过期、pending 清理、孤立 active 清理 | BE-04、BE-06～BE-09 |
| BE-11 | 全部与未分类图片列表 | P1 | ALL/UNCATEGORIZED keyset 列表 | BE-02～BE-05 |
| BE-12 | 标签筛选图片列表 | P1 | TAG relation cursor、失效关系跳过 | BE-11、BE-19 |
| BE-13 | 图片详情与受控 URL | P1 | `photo/detail`、备注/标签聚合、临时 URL | BE-03、BE-05 |
| BE-14 | 图片删除申请与状态 | P0 | 逻辑隐藏、唯一删除任务、公开状态查询 | BE-02、BE-05 |
| BE-15 | 图片删除任务执行器 | P0 | 四阶段清理、游标、租约、精确释放空间 | BE-04、BE-14 |
| BE-16 | 备注写操作 | P1 | add/update/delete、审核、乐观锁、计数事务 | BE-05、BE-13 |
| BE-17 | 备注列表与排序 | P1 | 四种排序、cursor、临时缩略图、失效引用跳过 | BE-16 |
| BE-18 | 标签规范化与 CRUD | P1 | list/create/rename/delete、唯一性、审核 | BE-01～BE-05 |
| BE-19 | 单图标签查询与增量更新 | P1 | get/updatePhotoTags、关系与双方计数事务 | BE-18 |
| BE-20 | 上传后批量添加标签 | P1 | batchAddPhotoTags、逐图事务、部分结果 | BE-08、BE-19 |
| BE-21 | 标签引用清理与计数校正 | P2 | 孤立关系清理、派生计数聚合校正 | BE-04、BE-18～BE-20 |
| BE-22 | 注销申请与状态 | P0 | requestDeletion/getDeletionStatus、用户状态切换 | BE-02、BE-05 |
| BE-23 | 注销任务执行器 | P0 | 全量清理、分阶段重试、最后解绑 | BE-04、BE-15、BE-21～BE-22 |
| BE-24 | cleanup 调度与有界执行 | P1 | 任务编排、租约、批次、续跑游标、故障隔离 | BE-10、BE-15、BE-21、BE-23 |
| BE-25 | 安全、隐私与可观测性 | P0 | 内容安全、存在性保护、日志脱敏、安全事件 | BE-01，各业务任务 |
| BE-26 | 接口契约与兼容发布 | P0 | 契约定稿、错误码统一、灰度和发布顺序 | BE-05～BE-25 |
| BE-27 | 自动化验证与云环境验收 | P0 | 单测、集成、并发/故障注入、环境核验报告 | BE-01～BE-26 |

---

## 5. 详细任务拆分

### BE-01 公共云函数内核

**实现内容**

- 建立公共模块：type 白名单路由、统一成功/错误响应、参数校验、OPENID 获取、ACTIVE 用户拦截。
- 资源查询统一使用 `_id + _openid + 业务状态`，具体资源不存在、已删除、越权时使用相同外部响应。
- 建立安全错误映射，屏蔽数据库、唯一索引、存储和审核服务原始异常。
- 封装事务执行与可重试冲突；事务失败不得提前返回 `SUCCESS`。
- 建立配置读取和结构化日志接口，不记录原始 OPENID、资源 ID、fileID、URL 或用户内容。

**验收标准**

- 未知 type 固定返回 `UNKNOWN_TYPE` 或统一安全错误。
- 客户端传入的 openid/userId 不参与身份判断。
- 所有云函数使用相同响应结构和错误边界。
- 公共模块具有参数、错误映射、状态拦截和日志脱敏单元测试。

**审计映射**：COM-01～COM-10、COM-12，USR-04～USR-05。

### BE-02 集合、字段与索引

**实现内容**

- 为 7 个集合固化字段、状态、时间、租约、游标、幂等键和派生计数字段。
- 建立上传三道唯一防线：attempt task、photo task、photo attempt。
- 建立标签名称和图片标签关系唯一索引。
- 建立图片三类列表、标签关系、备注四种排序、删除任务调度所需索引。
- 提供开发/测试环境旧 photo 的 `status`、`updated_at`、`tag_count` 回填和抽样核验脚本。

**验收标准**

- 索引清单与架构 §4.3 一致，唯一冲突可由业务代码识别。
- 回填可重复执行，不覆盖已有有效值。
- 查询 explain 或云环境实测证明核心分页查询使用目标索引。

**审计映射**：INF-01～INF-06、INF-12，UPL-17。

### BE-03 数据库与云存储权限

**实现内容**

- 7 个集合禁止客户端直接读写。
- 客户端只能向服务端签发的随机 pending 路径上传，不能自定 active 路径。
- active 对象只允许云函数写、覆盖和删除。
- 图片保持私有，只能由鉴权业务接口生成临时受控 URL。
- 准备权限正向、反向验证用例和云环境核验记录。

**验收标准**

- 客户端直读/直写集合全部失败。
- 未签发 pending、覆盖 active、删除 active 的客户端操作全部失败。
- 本人图片可通过接口读取；越权或过期 URL 不可用。

**审计映射**：INF-07～INF-10。

### BE-04 运行配置与触发器

**实现内容**

- 环境 ID、运行时、内容审核、HMAC 密钥和灰度开关通过环境配置注入。
- 配置高频删除任务触发器和每日全量补偿触发器。
- cleanup 能根据触发上下文区分高频推进与每日补偿。

**验收标准**

- 仓库中不存在生产密钥和硬编码敏感环境值。
- 高频触发至少每 5 分钟一次，每日补偿固定执行一次。
- 两类触发器可独立运行和记录安全结果。

**审计映射**：INF-11、CLN-01、COM-12。

### BE-05 用户登录与状态

**实现内容**

- `login` 获取 OPENID，查询或幂等创建用户。
- 新用户初始化 ACTIVE、`used_bytes=0`、默认 500 MB 配额及时间字段。
- `getStatus` 返回权威状态；登录返回状态、空间和是否新用户。
- 普通业务接口只允许 ACTIVE 用户；注销状态接口按契约例外开放。

**验收标准**

- 并发首次登录只创建一个用户且默认值一致。
- DELETING/DELETED 用户不能调用普通业务接口。
- 不向客户端返回 OPENID 或内部用户标识。

**审计映射**：USR-01～USR-06、COM-04～COM-05。

### BE-06 上传 prepare 与 attempt 状态机

**实现内容**

- 校验 ACTIVE 用户和 taskId，创建 PREPARED attempt。
- attemptId、pending 路径使用服务端密码学安全随机数，路径不包含 OPENID。
- 同一 `_openid + taskId` 重放返回原 attempt；CONFIRMED 同时返回原 photoId。
- CANCELED/EXPIRED 不复活；设置 24 小时到期时间。

**验收标准**

- 并发 prepare 最终只有一条 attempt。
- 客户端不能指定 attemptId、cloudPath 或 attempt 状态。
- 状态只允许 PREPARED 进入 CONFIRMED/CANCELED/EXPIRED 之一。

**审计映射**：UPL-01～UPL-04。

### BE-07 上传文件真实性与内容审核

**实现内容**

- confirm 先在短事务中获取带 token 和过期时间的处理租约。
- 校验 fileID 属于当前环境，且对象路径与 attempt 签发路径完全一致。
- 下载 buffer，以真实字节数、magic bytes 和解码结果识别大小、静态 JPEG/PNG、宽高。
- 校验 shootTime/timeSource 的类型、枚举和合理范围，但不把客户端 EXIF 当作可信文件元数据。
- 使用审核专用 buffer 进行图片内容安全检查。
- 审核通过后将已验证 buffer 写入随机 active 路径，计算 SHA-256。

**验收标准**

- 伪扩展名、动态图片、损坏图片、越环境/越路径 fileID 全部被拒绝。
- 审核拒绝与审核服务不可用分别映射安全错误。
- 并发 confirm 只有租约持有者执行昂贵处理，租约失效可恢复。

**审计映射**：UPL-05～UPL-13、COM-11。

### BE-08 上传确认事务与幂等

**实现内容**

- 最终短事务重新读取本人 PREPARED attempt、验证租约 token，并读取本人 ACTIVE user。
- 原子校验配额、创建 ACTIVE photo、增加 `used_bytes`、attempt 改为 CONFIRMED。
- photo 元数据只来自 BE-07 的服务端验证结果。
- 唯一冲突读取本人原 photo，作为幂等成功返回同一 photoId。
- active 提升后最终事务失败时允许安全重试，并登记孤立对象供补偿。

**验收标准**

- 任何失败均不会出现 photo、空间、attempt 三者半提交。
- 并发确认、响应丢失重放只生成一张 photo 且只计费一次。
- SPACE_EXCEEDED 不写入 photo，attempt 保持 PREPARED。

**审计映射**：UPL-14～UPL-17、UPL-20，API-01～API-02。

### BE-09 上传取消与竞态

**实现内容**

- cancel 接受 1～20 个 attemptId，逐项校验本人归属并返回独立结果。
- PREPARED 可事务转 CANCELED；CONFIRMED 返回原 photoId；终态重放幂等。
- confirm/cancel 以服务端事务提交顺序线性化。

**验收标准**

- cancel 先提交时迟到 confirm 不创建 photo。
- confirm 先提交时 cancel 返回 CONFIRMED 和原 photoId。
- 一个无效 attempt 不回滚其他取消结果。

**审计映射**：UPL-18～UPL-19、API-03。

### BE-10 上传过期与对象补偿

**实现内容**

- 到期 PREPARED attempt 原子转 EXPIRED，终态记录保留 7 天。
- 分页清理 CANCELED/EXPIRED/CONFIRMED 的遗留 pending 对象。
- 分页清理超过 24 小时、无 photo 且无有效 confirm 租约的孤立 active 对象。
- 释放失效 confirm 租约；所有扫描具有批次和续跑游标。

**验收标准**

- EXPIRED attempt 无法通过 confirm 恢复。
- 不删除仍可能被有效 confirm 使用的 pending/active 对象。
- 超时中断后从游标续跑，不进行无界目录遍历。

**审计映射**：UPL-21～UPL-22、CLN-03～CLN-05。

### BE-11 全部与未分类图片列表

**实现内容**

- `photo/list` 支持 ALL、UNCATEGORIZED，固定过滤本人 ACTIVE photo。
- 固定按 `upload_time DESC, _id DESC` 使用 keyset cursor。
- cursor 绑定 resource、scope、sort，防止把旧 cursor 用于扩大查询范围。
- 使用字段投影，批量生成临时缩略图 URL，不持久化 URL。

**验收标准**

- 不使用 `page`、`skip` 或全量读取后本地分页。
- 同时间值下分页无重复、无遗漏。
- UNCATEGORIZED 只返回 `tag_count=0` 的图片。

**审计映射**：PHQ-01～PHQ-02、PHQ-05～PHQ-07、PHQ-09～PHQ-10、API-04。

### BE-12 标签筛选图片列表

**实现内容**

- 校验 tag 属于当前用户，按 `photo_tags.photo_upload_time DESC, _id DESC` 扫描关系。
- 批量读取本人 ACTIVE photo，跳过孤立关系和 DELETING photo，并恢复关系顺序。
- 候选不足时继续扫描直至填满 pageSize 或耗尽。
- nextCursor 使用最后扫描的 relation，而不是最后返回的 photo。
- 成功筛选时按方案更新标签 `last_used_at`。

**验收标准**

- tag 不存在、越权、已删除统一返回 `TAG_NOT_FOUND`。
- 存在失效关系时仍尽量填满页面且分页无死循环。
- cursor 绑定 TAG scope、tagId 和排序参数。

**审计映射**：PHQ-03、PHQ-08，TAG-13～TAG-15。

### BE-13 图片详情与受控 URL

**实现内容**

- `photo/detail` 直接查询本人 ACTIVE photo。
- 返回预览临时 URL、备注列表和最多 5 个标签。
- 临时 URL 和 CI 参数由云函数生成，不写入数据库、不由前端拼接。
- 不存在、DELETING、已删除、越权图片统一外部响应。

**验收标准**

- 详情响应不包含 fileID、OPENID 或内部删除字段。
- DELETING photo 在删除事务提交后立即不可见。
- URL 到期后必须重新通过接口获取。

**审计映射**：PHQ-04、PHQ-09，NTE-06，TAG-06。

### BE-14 图片删除申请与状态

**实现内容**

- `photo/delete` 在短事务内把本人 ACTIVE photo 改为 DELETING，并创建 PHOTO_DELETE 任务。
- 任务保存清理所需 file_id/file_size，但状态接口不暴露这些内部字段。
- task_key 唯一保证重复删除返回同一任务。
- `getDeleteStatus` 仅返回公开状态和时间。

**验收标准**

- 删除申请事务提交后，图片从图片、备注、标签全部业务读写路径立即隐藏。
- 重复删除不创建重复任务。
- 空间在任务 COMPLETED 前仍计费。

**审计映射**：PHD-01～PHD-04、PHD-10。

### BE-15 图片删除任务执行器

**实现内容**

- 使用短租约推进 PENDING/RETRYING/租约失效任务。
- `STORAGE_DELETE`：幂等删除对象，对象不存在视为完成。
- `NOTES_CLEANUP`：分页删除备注。
- `PHOTO_TAGS_CLEANUP`：分页删除关系，按实际删除数递减标签计数。
- 每批数据变更与 stage_cursor 前移位于同一事务。
- `PHOTO_FINALIZE`：原子删除 DELETING photo、精确扣减一次空间、任务改 COMPLETED。
- 失败记录安全错误并 RETRYING，不把 photo 恢复 ACTIVE。

**验收标准**

- 任一阶段崩溃和重放均不重复减计数或扣空间。
- 大数据量任务可从阶段游标恢复。
- COMPLETED 表示存储、备注、关系、photo 和空间均已完成。

**审计映射**：PHD-05～PHD-12、CLN-02、CLN-06。

### BE-16 备注写操作

**实现内容**

- add 校验本人 ACTIVE photo、1～1000 code point 内容并执行文本审核。
- 创建 note 时从权威 photo 冗余 file_id 和 shoot_time，事务增加 note_count。
- update 使用本人 note 和 updated_at 乐观锁；冲突返回安全且足够的最新数据。
- delete 在事务中删除 note 并更新 ACTIVE photo.note_count。

**验收标准**

- DELETING/越权/不存在 photo 不能新增备注。
- 并发修改只有一个版本成功，冲突不会覆盖新内容。
- 重放删除不会把 note_count 减为负数。

**审计映射**：NTE-01～NTE-05、NTE-10，COM-11。

### BE-17 备注列表与排序

**实现内容**

- 支持 created_at/photo_shoot_time × asc/desc 四种排序。
- 每种排序使用同向 `_id` 作为稳定第二排序键和 keyset cursor。
- 只返回仍关联本人 ACTIVE photo 的备注，失效引用跳过并继续扫描。
- 批量生成临时缩略图 URL，不持久化。

**验收标准**

- cursor 与 sortBy/sortOrder 绑定，篡改返回 `INVALID_CURSOR`。
- 同时间值分页无重复、无遗漏。
- DELETING photo 的备注不出现在全局列表。

**审计映射**：NTE-07～NTE-09、NTE-11～NTE-12、API-05。

### BE-18 标签规范化与 CRUD

**实现内容**

- 实现 Unicode trim、控制字符拒绝、1～12 code point、NFC、拉丁字母大小写归一。
- 禁止保留名“全部”“未分类”，内部普通空格保留。
- list 支持 QUICK/ALL，按 last_used_at、updated_at、created_at 稳定降序，限制 5/100。
- create/rename 执行文本审核和用户内规范化名称唯一性校验。
- delete 幂等删除本人标签及关系，按实际受影响关系更新图片 tag_count，不删除图片/备注。

**验收标准**

- 唯一索引是并发最终防线，冲突映射 `TAG_NAME_DUPLICATED`。
- 重命名保持关系和 photo_count。
- 达到 100 个标签时返回 `TAG_LIMIT_REACHED`。

**审计映射**：TAG-01～TAG-05、TAG-15，COM-11。

### BE-19 单图标签查询与增量更新

**实现内容**

- getPhotoTags 校验本人 ACTIVE photo 并返回 0～5 个标签。
- updatePhotoTags 校验 add/remove 数组、分别去重且不得交叉。
- 事务内读取当前集合，计算 desired/toInsert/toDelete。
- 只对实际差异写关系，并同步更新 photo.tag_count、tag.photo_count 和实际新增标签的 last_used_at。
- 使用唯一关系索引保证并发幂等。

**验收标准**

- 合并后超过 5 个时不写入任何关系或计数。
- 空差异不执行 `$inc`。
- 重试不会重复建关系、重复加计数或产生负数。

**审计映射**：TAG-06～TAG-08、TAG-11～TAG-12、TAG-14。

### BE-20 上传后批量添加标签

**实现内容**

- 校验 1～20 个 photoId、1～5 个 tagId 和 requestId。
- 任一 tag 无效时整次拒绝；所有 tag 有效后按图片独立提交事务。
- 每张图片复用 BE-19 的集合差异算法。
- 返回 success、invalid、limitExceeded 分类计数和标签摘要。
- requestId 只记录不可逆摘要，重试复用但不以它替代唯一索引。

**验收标准**

- 某张图片无效或超限不回滚其他图片。
- 只接受 confirm 已返回的 photoId 所代表的 ACTIVE photo。
- 重复提交不重复计数。

**审计映射**：TAG-09～TAG-10、API-08。

### BE-21 标签引用清理与计数校正

**实现内容**

- 分页清理指向无效 photo/tag 的孤立 photo_tags。
- 聚合有效关系，校正 photos.tag_count 与 tags.photo_count。
- 只更新不一致项；不通过孤立关系恢复已删除资源。
- 使用安全 ID 摘要记录校正前后计数和结果。

**验收标准**

- 重复执行得到相同结果。
- 大数据量校正有批次上限和续跑游标。
- 校正后 photo 计数范围 0～5，tag 计数非负。

**审计映射**：TAG-16、CLN-08～CLN-09。

### BE-22 注销申请与状态

**实现内容**

- requestDeletion 校验确认文字和 ACTIVE 用户。
- 事务内创建唯一 ACCOUNT_DELETION 任务并把 user 改为 DELETING。
- 重复申请返回已有任务。
- getDeletionStatus 返回公开状态、安全重试信息，不暴露内部阶段和错误。

**验收标准**

- 申请提交后普通业务接口立即拒绝该用户。
- 重放申请不创建多条注销链路。
- 注销状态查询在 DELETING 期间可用。

**审计映射**：ACC-01～ACC-05。

### BE-23 注销任务执行器

**实现内容**

- 使用租约、阶段和游标依次清理图片对象、备注、photo_tags、tags、photos 和其他用户数据。
- 每个阶段分页、幂等、可重试，失败保留 failed stage 和安全错误。
- 业务数据和空间全部清理后，最后执行微信身份解绑并完成任务。
- 任一标签或关系清理失败不得返回 COMPLETED。

**验收标准**

- 中途崩溃重跑不会遗漏或重复破坏计数。
- 完成后不存在该用户的内容、关系、对象和可用身份。
- 身份解绑失败时任务保持可重试而非假完成。

**审计映射**：ACC-06～ACC-12、CLN-07。

### BE-24 cleanup 调度与有界执行

**实现内容**

- 统一编排上传补偿、图片删除、注销、孤立引用和计数校正处理器。
- 每类任务具有独立批次、最大扫描次数、执行时限和续跑游标。
- 使用短租约避免多个 cleanup 实例处理同一任务。
- 一个处理器失败不阻断其他任务类型，输出安全汇总。

**验收标准**

- 并发触发不会重复领取同一任务。
- 接近云函数超时时主动保存游标退出。
- 高频任务与每日补偿处理范围符合配置。

**审计映射**：CLN-01～CLN-02、CLN-06～CLN-11。

### BE-25 安全、隐私与可观测性

**实现内容**

- 对图片、备注、标签在权威写入前执行内容审核。
- 所有具体资源接口落实存在性保护和归属查询，禁止先全局按 ID 查询再判断归属。
- 建立统一安全事件：result、errorCode、duration、数量区间、requestIdHash、时间。
- 使用服务端密钥 HMAC 生成必要关联摘要。
- 日志和响应不包含原始身份、资源 ID、fileID、临时 URL、用户内容或内部删除错误。

**验收标准**

- 横切扫描不存在未带 `_openid` 和 ACTIVE 状态的业务资源读写。
- 审核拒绝、服务不可用、存储失败、唯一冲突均映射安全业务错误。
- 自动化测试能捕获日志敏感字段泄漏。

**审计映射**：COM-06～COM-12、CLN-11，以及检查基线 §9 全部横切项。

### BE-26 接口契约与兼容发布

**实现内容**

- 固化 prepare/confirm/cancel、keyset cursor、异步删除和标签批量接口。
- 统一新错误码，移除旧 `TAG_ACCESS_DENIED`、可信客户端元数据、page/skip 协议。
- 确认客户端保存 attemptId/expiresAt/photoId，并只用 confirm 成功 photoId 批量打标签。
- 通过灰度开关保证新旧协议不混用。
- 定义服务端、客户端、触发器和索引的发布/回滚顺序。

**验收标准**

- 所有云函数响应符合通用格式。
- 客户端契约测试覆盖状态枚举、错误码和 cursor 失效。
- 新上传协议启用后不能回滚到信任客户端文件元数据的实现。

**审计映射**：API-01～API-09。

### BE-27 自动化验证与云环境验收

**实现内容**

- 为公共校验、Unicode、cursor、状态机、集合差异算法建立单元测试。
- 为上传、图片删除、标签关联、备注冲突、注销建立集成测试。
- 建立并发、响应丢失、事务冲突、租约过期、阶段崩溃和重放故障注入测试。
- 在开发云环境验证事务、唯一索引、查询索引、权限、临时 URL、图片处理、触发器和运行时。
- 按审计文档 §7 全量输出实现状态和证据。

**验收标准**

- 五条跨模块流程全部通过：上传成功、上传取消竞态、图片删除、标签筛选、账号注销。
- P0/P1 项均有自动化证据或明确的云环境验收记录。
- 所有 `UNVERIFIED` 项在发布前关闭或转为明确阻断项。

**审计映射**：检查基线 §7～§9、§15。

---

## 6. 推荐实施顺序

```text
阶段 A：安全地基
  BE-01 → BE-02 → BE-03 → BE-04 → BE-05

阶段 B：上传闭环
  BE-06 → BE-07 → BE-08 → BE-09 → BE-10

阶段 C：图片读取与删除
  BE-11 → BE-13 → BE-14 → BE-15

阶段 D：标签闭环
  BE-18 → BE-19 → BE-20 → BE-12 → BE-21

阶段 E：备注闭环
  BE-16 → BE-17

阶段 F：注销与统一后台任务
  BE-22 → BE-23 → BE-24

阶段 G：发布收口
  BE-25 → BE-26 → BE-27
```

BE-25 是横切任务，编码阶段应同步落实；阶段 G 只做最终反向扫描和收口，不能把安全补救全部推迟到最后。

---

## 7. 可并行工作流

完成 BE-01～BE-05 后，可以按以下工作流并行实施：

| 工作流 | 任务 | 合并前置条件 |
|---|---|---|
| 上传 | BE-06～BE-10 | 数据/存储权限、attempt 索引、用户状态 |
| 图片与删除 | BE-11、BE-13～BE-15 | photo 索引、临时 URL、删除任务索引 |
| 标签 | BE-18～BE-21 | tags/photo_tags 唯一及查询索引 |
| 备注 | BE-16～BE-17 | note 索引、ACTIVE photo 查询 helper |
| 注销 | BE-22～BE-24 | 图片删除、标签清理的可复用阶段处理器 |

公共模块、集合字段和错误码由单一变更入口维护，避免各工作流复制不同版本。

---

## 8. 建议代码组织

```text
cloudfunctions/
├── common/
│   ├── auth.js
│   ├── response.js
│   ├── validator.js
│   ├── errors.js
│   ├── transaction.js
│   ├── cursor.js
│   ├── content-review.js
│   ├── storage.js
│   ├── logger.js
│   └── config.js
├── user/
├── upload/
│   ├── handlers/
│   └── services/
├── photo/
│   ├── handlers/
│   └── services/
├── note/
├── tag/
├── account/
└── cleanup/
    ├── workers/
    └── services/
```

公共代码的具体复用方式需结合微信云函数部署打包限制决定，可以使用构建复制、私有 npm 包或各函数安装的共享包；不得依赖部署环境中不存在的工作区相对路径。

---

## 9. 每个任务包的完成定义

任务包只有同时满足以下条件才能标记完成：

1. 正常流程、参数错误、状态错误、越权、并发和重放行为均已实现。
2. 数据查询带 `_openid`，图片业务读写带 ACTIVE 状态。
3. 事务、唯一索引、租约或补偿机制与该任务的一致性风险匹配。
4. 响应和错误码符合接口契约，不泄漏资源存在性和敏感字段。
5. 至少有单元或集成测试；P0 事务和竞态必须有并发/故障测试。
6. 代码、配置、索引、权限和云环境依赖均留下可定位证据。
7. 对应审计编号已逐项复核，不以“接口能调用”代替完整实现。

---

## 10. 发布门禁

以下任一项未通过时不得发布：

- 用户数据隔离或具体资源存在性保护失败。
- 客户端仍可直接读写集合、覆盖 active 对象或读取私有原图。
- 上传最终事务不能原子维护 photo、空间和 attempt。
- 上传/标签/删除缺少唯一索引或幂等最终防线。
- 图片删除或注销任务不能从中断阶段恢复。
- keyset cursor 查询索引、唯一索引或事务能力未在目标云环境验证。
- 新旧上传协议、分页协议或异步删除协议发生混用。
- cleanup 触发器未部署，或 DELETING 数据没有持续推进者。

---

## 11. 审计编号覆盖矩阵

下表用于确认检查基线中的 134 个技术功能均有实施落点。一个检查项可能由多个任务包共同完成，最终状态仍需在审计报告中按编号逐项判断。

| 审计域 | 编号范围 | 主要实施任务 |
|---|---|---|
| 公共后端能力 | COM-01～COM-12 | BE-01、BE-07、BE-16、BE-18、BE-25 |
| 数据库与云存储 | INF-01～INF-12 | BE-02～BE-04 |
| 用户与身份 | USR-01～USR-06 | BE-01、BE-05 |
| 图片上传 | UPL-01～UPL-22 | BE-06～BE-10 |
| 图片查询 | PHQ-01～PHQ-10 | BE-11～BE-13 |
| 图片删除 | PHD-01～PHD-12 | BE-14～BE-15 |
| 备注 | NTE-01～NTE-12 | BE-13、BE-16～BE-17 |
| 标签 | TAG-01～TAG-16 | BE-12、BE-18～BE-21 |
| 账号注销 | ACC-01～ACC-12 | BE-22～BE-23 |
| 后台任务与补偿 | CLN-01～CLN-11 | BE-04、BE-10、BE-15、BE-21、BE-23～BE-24 |
| 前后端接口契约 | API-01～API-09 | BE-08～BE-09、BE-11、BE-17、BE-20、BE-26 |

覆盖总数：

```text
COM 12 + INF 12 + USR 6 + UPL 22 + PHQ 10 + PHD 12
+ NTE 12 + TAG 16 + ACC 12 + CLN 11 + API 9 = 134
```
