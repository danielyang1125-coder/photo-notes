'use strict'

/**
 * backend-task-retry.js — 显式重驱 MANUAL_REQUIRED 或卡住的任务
 *
 * 用法：
 *   node scripts/backend-task-retry.js --env <envId> --task-id <taskId> --apply
 *   node scripts/backend-task-retry.js --env <envId> --all-manual-required --apply
 *   node scripts/backend-task-retry.js --env <envId> --task-id <taskId>  (dry-run)
 *
 * 安全措施：
 *   - 默认 dry-run；写入需要 --apply
 *   - 拒绝重试 COMPLETED 任务
 *   - 对拥有活跃租约的 PROCESSING 任务发出警告
 *   - 重置任务状态为 PENDING，清除租约，设置 next_retry_at = null
 *
 * 需要环境变量：
 *   CLOUDBASE_SECRET_ID
 *   CLOUDBASE_SECRET_KEY
 */

const crypto = require('crypto')

const SAFE_ENV_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u

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
    taskId: null,
    allManualRequired: false,
    mode: 'dry-run', // 'dry-run' | 'apply'
    limit: 50,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--env') {
      i += 1
      options.envId = argv[i] || null
    } else if (arg === '--task-id') {
      i += 1
      options.taskId = argv[i] || null
    } else if (arg === '--all-manual-required') {
      options.allManualRequired = true
    } else if (arg === '--apply') {
      options.mode = 'apply'
    } else if (arg === '--limit') {
      i += 1
      const val = Number(argv[i])
      if (!Number.isFinite(val) || val < 1 || val > 500) {
        throw new CliError('INVALID_LIMIT')
      }
      options.limit = Math.floor(val)
    } else {
      throw new CliError('UNKNOWN_ARGUMENT')
    }
  }

  if (!options.help) {
    if (!SAFE_ENV_PATTERN.test(options.envId || '')) {
      throw new CliError('ENV_REQUIRED')
    }
    if (!options.taskId && !options.allManualRequired) {
      throw new CliError('TARGET_REQUIRED')
    }
    if (options.taskId && options.allManualRequired) {
      throw new CliError('CONFLICTING_TARGETS')
    }
  }

  return options
}

// ---------------------------------------------------------------------------
// 安全标识符哈希
// ---------------------------------------------------------------------------
function taskIdHash(taskId) {
  return crypto.createHash('sha256').update(String(taskId)).digest('hex').slice(0, 16)
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

  // 延迟加载 CloudBase SDK
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

  // 收集要重试的任务
  let candidates = []

  if (options.taskId) {
    // 单个任务
    try {
      const result = await db
        .collection('deletion_tasks')
        .doc(options.taskId)
        .get()
      const task =
        result && result.data
          ? Array.isArray(result.data)
            ? result.data[0]
            : result.data
          : null
      if (task) {
        candidates.push(task)
      } else {
        process.stderr.write(
          `错误：未找到任务 ${taskIdHash(options.taskId)}。\n`,
        )
        process.exit(1)
      }
    } catch (err) {
      process.stderr.write(
        `错误：获取任务失败：${err.message || err}\n`,
      )
      process.exit(1)
    }
  } else if (options.allManualRequired) {
    // 所有 MANUAL_REQUIRED 任务
    const result = await db
      .collection('deletion_tasks')
      .where({ status: 'MANUAL_REQUIRED' })
      .limit(options.limit)
      .get()
    candidates = Array.isArray(result.data) ? result.data : []

    if (candidates.length === 0) {
      process.stdout.write('没有 MANUAL_REQUIRED 任务。\n')
      return
    }
  }

  // 验证每个候选任务
  const report = {
    mode: options.mode,
    environmentHash: crypto
      .createHash('sha256')
      .update(options.envId)
      .digest('hex')
      .slice(0, 12),
    candidates: candidates.length,
    reset: [],
    skipped: [],
    errors: [],
  }

  const now = new Date()

  for (const task of candidates) {
    const hash = taskIdHash(task._id)
    const entry = {
      taskIdHash: hash,
      type: task.type || 'UNKNOWN',
      currentStatus: task.status,
      currentStage: task.current_stage || null,
      retryCount: typeof task.retry_count === 'number' ? task.retry_count : 0,
    }

    // 安全检查：拒绝 COMPLETED
    if (task.status === 'COMPLETED') {
      entry.reason = 'COMPLETED 任务不能重试'
      report.skipped.push(entry)
      continue
    }

    // 警告：PROCESSING 且有活跃租约
    if (task.status === 'PROCESSING') {
      const leaseExpire = task.lease_expire_at
        ? new Date(task.lease_expire_at)
        : null
      if (leaseExpire && leaseExpire > now) {
        entry.reason = `PROCESSING 任务拥有活跃租约（过期时间：${leaseExpire.toISOString()}）`
        entry.warning = true
        report.skipped.push(entry)
        continue
      }
    }

    if (options.mode === 'dry-run') {
      entry.wouldReset = true
      entry.newStatus = 'PENDING'
      report.reset.push(entry)
    } else {
      // 执行重置
      try {
        await db
          .collection('deletion_tasks')
          .doc(task._id)
          .update({
            data: {
              status: 'PENDING',
              lease_token: null,
              lease_expire_at: null,
              next_retry_at: null,
              retry_count: (task.retry_count || 0) + 1,
              updated_at: now,
            },
          })
        entry.reset = true
        entry.newStatus = 'PENDING'
        report.reset.push(entry)
      } catch (err) {
        entry.error = (err && err.message) || String(err)
        report.errors.push(entry)
      }
    }
  }

  if (options.mode === 'dry-run') {
    process.stdout.write(
      `[DRY-RUN] 将从 ${report.candidates} 个候选任务中重置 ${report.reset.length} 个任务。\n`,
    )
    process.stdout.write(
      `跳过 ${report.skipped.length} 个任务。\n`,
    )
    process.stdout.write(
      '使用 --apply 执行实际写入。\n\n',
    )
  } else {
    process.stdout.write(
      `已重置 ${report.reset.length} 个任务。\n`,
    )
    if (report.skipped.length > 0) {
      process.stdout.write(
        `跳过 ${report.skipped.length} 个任务。\n`,
      )
    }
    if (report.errors.length > 0) {
      process.stdout.write(
        `${report.errors.length} 个任务重置失败。\n`,
      )
    }
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n')

  if (report.errors.length > 0) {
    process.exit(1)
  }
}

function printHelp() {
  process.stdout.write(`用法：node scripts/backend-task-retry.js --env <envId> [选项]

显式重驱 MANUAL_REQUIRED 或卡住的后台任务。

选项：
  --env <envId>              CloudBase 环境 ID（必填）
  --task-id <taskId>         要重试的特定任务 ID
  --all-manual-required      重试所有 MANUAL_REQUIRED 任务（最多 --limit 个）
  --limit <n>                处理的最大任务数（1-500，默认 50，仅与 --all-manual-required 一起使用）
  --apply                    执行实际写入（默认：dry-run）
  --help, -h                 显示此帮助信息

需要环境变量：
  CLOUDBASE_SECRET_ID        腾讯云 SecretId
  CLOUDBASE_SECRET_KEY       腾讯云 SecretKey

安全措施：
  - 默认 dry-run；写入需要 --apply
  - 拒绝重试 COMPLETED 任务
  - 对拥有活跃租约的 PROCESSING 任务发出警告
  - 重置任务状态为 PENDING，清除租约字段
  - 任务 ID 在输出中使用 SHA-256 哈希保护隐私

示例：
  # 查看将重置哪些 MANUAL_REQUIRED 任务
  node scripts/backend-task-retry.js --env my-env --all-manual-required

  # 重置特定任务
  node scripts/backend-task-retry.js --env my-env --task-id abc123 --apply

  # 重置最多 10 个 MANUAL_REQUIRED 任务
  node scripts/backend-task-retry.js --env my-env --all-manual-required --limit 10 --apply
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
