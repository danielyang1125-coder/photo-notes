---
name: backend-deploy
description: Deploy cloud functions and run database migrations with verification steps. Triggers on "部署", "deploy", "发布", "backend deploy".
---

# Backend Deploy — 后端部署与迁移

完整的后端部署操作指引，包含检查、迁移、部署和验证。

## 部署前检查（必须全部通过）

```bash
npm run backend:sync     # 同步共享模块到各云函数
npm run backend:check    # 语法检查 + 禁止模式扫描 (.skip/console.log/error.message)
npm run backend:test     # 运行全部后端测试
npm run backend:audit    # 结构审计（路由 + 索引 + 测试覆盖）
```

**审计不通过则禁止部署。**

## 数据库迁移（如需要）

```bash
# 第一步：预览变更
node scripts/db-init.js --dry-run --env <environment-id>

# 第二步：确认无误后执行
node scripts/db-init.js --apply --env <environment-id>
```

### 所需环境变量

```bash
export CLOUDBASE_SECRET_ID="your_secret_id"
export CLOUDBASE_SECRET_KEY="your_secret_key"
```

### 迁移内容

- 创建新集合（如不存在）
- 创建新索引（如不存在）
- 回填缺失字段（如适用）
- 验证回填完整性

## 云函数部署

### 依赖顺序（严格遵守）

1. **① `_shared` sync** — 始终最先
2. **② `user`** — 其他函数可能依赖
3. **③ `photo`, `note`, `tag`, `upload`, `account`** — 彼此独立，可并行部署
4. **④ `cleanup`** — 依赖以上全部（定时触发器）

### 部署方式

- **WeChat DevTools**：右键云函数目录 → "上传并部署：云端安装依赖"
- **CLI**：`bash uploadCloudFunction.sh <function-name>`（需安装 `@cloudbase/cli`）

### 批量部署

```bash
bash uploadCloudFunction.sh    # 部署全部 7 个业务云函数
```

## 运行时环境变量

确认每个云函数在 WeChat DevTools → 云函数 → 版本管理 → 配置中已设置：

| 变量 | 用途 | 缺失行为 |
|------|------|---------|
| `CURSOR_HMAC_SECRET` | cursor 防篡改签名 | 列表返回 `INTERNAL_ERROR` |
| `AUDIT_HMAC_SECRET` | 安全日志 ID 摘要 | 日志降级（不阻断） |
| `UPLOAD_ATTEMPT_REQUIRED` | upload attempt 强制 | 上传拒绝 |
| `CURSOR_PAGINATION_REQUIRED` | keyset cursor 强制 | 列表拒绝 |
| `ASYNC_PHOTO_DELETE_ENABLED` | 异步删除开关 | 同步删除 |
| `PUBLIC_RESOURCE_ERROR_MASKING` | 错误掩码强制 | 可能泄露存在性 |
| `CONTENT_REVIEW_ENABLED` | 内容审核开关 | 跳过审核 |

参考模板：`config/backend-runtime.env.example`

## 常见部署坑点

| 坑点 | 现象 | 解决 |
|------|------|------|
| 忘记同步共享模块 | `Cannot find module './lib/shared/...'` | 先执行 `npm run backend:sync` |
| 新集合索引未创建 | 云函数超时/慢查询 | 先执行 `db-init --apply` |
| TDesign npm 未构建 | 组件不渲染 | WeChat DevTools → Tools → Build npm |
| cleanup 触发器未配置 | 孤立数据积累 | 检查 `cleanup/config.json` 的 triggers |
| 环境变量未设置 | cursor 返回 500 | 云函数版本管理 → 配置中添加 |
| Node modules 未安装 | 部署失败 | 右键云函数 → "云端安装依赖" |

## 部署后验证

1. **健康检查**：
   - 调用 `user/healthCheck` → 验证 database、transaction、storage 三项
   - 预期：`{ checks: { database: true, transaction: true, storage: true }, verdict: "ALL_OK" }`

2. **端到端流程**：
   - 登录 → 上传图片 → 浏览图片列表 → 添加备注 → 添加标签 → 按标签筛选 → 删除图片
   - 每个步骤验证响应 `code === 'SUCCESS'`

3. **补偿验证**（如涉及）：
   - 确认 cleanup 定时触发器状态
   - 手动触发 cleanup 检查日志

4. **日志检查**：
   - 云函数控制台查看最近调用日志
   - 确认无 `INTERNAL_ERROR` 或未捕获异常

## 常用命令速查

| 命令 | 用途 |
|------|------|
| `npm run backend:sync` | 同步共享模块到各云函数 |
| `npm run backend:check` | 语法 + 禁止模式扫描 |
| `npm run backend:test` | 运行全部后端单元测试 |
| `npm run backend:audit` | 结构审计（路由/索引/测试） |
| `bash uploadCloudFunction.sh` | 部署全部云函数 |
| `bash uploadCloudFunction.sh user` | 部署单个云函数 |
| `node scripts/db-init.js --dry-run --env <id>` | 数据库变更预览 |
| `node scripts/db-init.js --apply --env <id>` | 数据库变更执行 |

## 核心参考文件

- [config/backend-runtime.env.example](config/backend-runtime.env.example) — 环境变量模板
- [scripts/db-init.js](scripts/db-init.js) — 数据库迁移工具
- [scripts/backend-audit.js](scripts/backend-audit.js) — 结构审计脚本
- [uploadCloudFunction.sh](uploadCloudFunction.sh) — 部署脚本
- [docs/BACKEND-CLOUD-ACCEPTANCE-DEV-01.md](docs/BACKEND-CLOUD-ACCEPTANCE-DEV-01.md) — 云环境验收
