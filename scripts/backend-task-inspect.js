'use strict'

/**
 * backend-task-inspect.js — 只读检查 deletion_tasks 状态
 *
 * 用法：
 *   node scripts/backend-task-inspect.js --env <envId>
 *   node scripts/backend-task-inspect.js --env <envId> --type PHOTO_DELETE
 *   node scripts/backend-task-inspect.js --env <envId> --status MANUAL_REQUIRED
 *   node scripts/backend-task-inspect.js --env <envId> --limit 50
 *   node scripts/backend-task-inspect.js --env <envId> --output summary  (仅摘要)
 *
 * 需要环境变量：
 *   CLOUDBASE_SECRET_ID
 *   CLOUDBASE_SECRET_KEY
 */

const crypto = require('crypto')

const SAFE_ENV_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u
const VALID_TYPES = new Set([
  'PHOTO_DELETE',
  'ACCOUNT_DELETION',
  'UPLOAD_COMPENSATION',
  'ORPHAN_CLEANER',
  'COUNT_CORRECTOR_PHOTOS',
  'COUNT_CORRECTOR_TAGS',
])
const VALID_STATUSES = new Set([
  'PENDING',
  'PROCESSING',
  'RETRYING',
  'COMPLETED',
  'MANUAL_REQUIRED',
])

class CliError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// CLI 参数解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const options = {
    envId: null,
    type: null,
    status: null,
    limit: 100,
    output: 'full', // 'full' | 'summary'
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--env') {
      i += 1
      options.envId = argv[i] || null
    } else if (arg === '--type') {
      i += 1
      const val = argv[i]
      if (val && !VALID_TYPES.has(val)) {
        throw new CliError('INVALID_TYPE')
      }
      options.type = val || null
    } else if (arg === '--status') {
      i += 1
      const val = argv[i]
      if (val && !VALID_STATUSES.has(val)) {
        throw new CliError('INVALID_STATUS')
      }
      options.status = val || null
    } else if (arg === '--limit') {
      i += 1
      const val = Number(argv[i])
      if (!Number.isFinite(val) || val < 1 || val > 1000) {
        throw new CliError('INVALID_LIMIT')
      }
      options.limit = Math.floor(val)
    } else if (arg === '--output') {
      i += 1
      const val = argv[i]
      if (val !== 'full' && val !== 'summary') {
        throw new CliError('INVALID_OUTPUT')
      }
      options.output = val
    } else {
      throw new CliError('UNKNOWN_ARGUMENT')
    }
  }

  if (!options.help && !SAFE_ENV_PATTERN.test(options.envId || '')) {
    throw new CliError('ENV_REQUIRED')
  }
  return options
}

// ---------------------------------------------------------------------------
// 摘要哈希 (保护原始 ID)
// ---------------------------------------------------------------------------
function taskIdHash(taskId) {
  return crypto.createHash('sha256').update(String(taskId)).digest('hex').slice(0, 16)
}

function safeTaskProjection(task) {
  return {
    taskIdHash: taskIdHash(task._id),
    type: task.type || 'UNKNOWN',
    status: task.status || 'UNKNOWN',
    currentStage: task.current_stage || null,
    retryCount: typeof task.retry_count === 'number' ? task.retry_count : 0,
    appliedAt: task.applied_at || null,
    lastErrorAt: task.last_error_at || null,
    completedAt: task.completed_at || null,
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    printHelp()
    return
  }

  // 延迟加载 CloudBase SDK（仅在非 help 时需要）
  let CloudBase
  try {
    CloudBase = require('@cloudbase/node-sdk')
  } catch (_) {
    process.stderr.write(
      '错误：需要安装 @cloudbase/node-sdk 依赖。请运行 npm install。\n',
    )
    process.exit(1)
  }

  const secretId = process.env.CLOUDBASE_SECRET_ID
  const secretKey = process.env.CLOUDBASE_SECRET_KEY
  if (!secretId || !secretKey) {
    process.stderr.write(
      '错误：需要设置 CLOUDBASE_SECRET_ID 和 CLOUDBASE_SECRET_KEY 环境变量。\n',
    )
    process.exit(1)
  }

  const app = CloudBase.init({
    env: options.envId,
    secretId,
    secretKey,
  })
  const db = app.database()

  // 构建查询
  const condition = {}
  if (options.type) condition.type = options.type
  if (options.status) condition.status = options.status

  // 查询摘要：按 type + status 分组统计
  const aggregateResult = await db
    .collection('deletion_tasks')
    .aggregate()
    .group({
      _id: { type: '$type', status: '$status' },
      count: { $sum: 1 },
    })
    .end()

  const summary = {}
  let totalCount = 0
  if (aggregateResult && Array.isArray(aggregateResult.list)) {
    for (const group of aggregateResult.list) {
      const { type, status } = group._id || {}
      const count = group.count || 0
      if (!summary[type]) summary[type] = {}
      summary[type][status] = count
      totalCount += count
    }
  }

  // 查询 MANUAL_REQUIRED 计数
  const manualResult = await db
    .collection('deletion_tasks')
    .where({ status: 'MANUAL_REQUIRED' })
    .count()
  const manualCount = typeof manualResult.total === 'number' ? manualResult.total : 0

  const report = {
    environmentHash: crypto
      .createHash('sha256')
      .update(options.envId)
      .digest('hex')
      .slice(0, 12),
    totalTasks: totalCount,
    manualRequiredCount: manualCount,
    summary,
    query: {
      type: options.type || '(all)',
      status: options.status || '(all)',
      limit: options.limit,
    },
  }

  if (options.output === 'full') {
    // 查询匹配条件的任务详情
    const query = db.collection('deletion_tasks')
    const q = condition.type || condition.status ? query.where(condition) : query
    const taskResult = await q.limit(options.limit).get()
    const tasks = Array.isArray(taskResult.data) ? taskResult.data : []

    report.tasks = tasks.map(safeTaskProjection)
    report.resultCount = tasks.length
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n')

  // 如果有 MANUAL_REQUIRED 任务，以非零退出码退出（用于告警）
  if (manualCount > 0) {
    process.stderr.write(
      `⚠ 警告：存在 ${manualCount} 个 MANUAL_REQUIRED 任务，需要手动处理。\n`,
    )
    process.stderr.write(
      '使用 backend-task-retry.js 来重新驱动这些任务。\n',
    )
  }
}

function printHelp() {
  process.stdout.write(`用法：node scripts/backend-task-inspect.js --env <envId> [选项]

只读检查 deletion_tasks 集合中的任务状态。

选项：
  --env <envId>         CloudBase 环境 ID（必填）
  --type <type>         按任务类型过滤：PHOTO_DELETE, ACCOUNT_DELETION,
                        UPLOAD_COMPENSATION, ORPHAN_CLEANER,
                        COUNT_CORRECTOR_PHOTOS, COUNT_CORRECTOR_TAGS
  --status <status>     按状态过滤：PENDING, PROCESSING, RETRYING,
                        COMPLETED, MANUAL_REQUIRED
  --limit <n>           返回的最大任务数（1-1000，默认 100）
  --output <mode>       输出模式：summary（仅摘要）或 full（含任务详情，默认）
  --help, -h            显示此帮助信息

需要环境变量：
  CLOUDBASE_SECRET_ID   腾讯云 SecretId
  CLOUDBASE_SECRET_KEY  腾讯云 SecretKey

输出：
  JSON 报告，包含按类型/状态的摘要计数、MANUAL_REQUIRED 计数，
  以及（在 full 模式下）最多 --limit 个匹配任务的安全投影。
  任务 ID 使用 SHA-256 哈希保护隐私。
`)
}

main().catch((err) => {
  if (err instanceof CliError) {
    process.stderr.write(`参数错误：${err.code}\n`)
    process.stderr.write('使用 --help 查看用法。\n')
    process.exit(2)
  }
  process.stderr.write(`错误：${err.message || err}\n`)
  process.exit(1)
})
