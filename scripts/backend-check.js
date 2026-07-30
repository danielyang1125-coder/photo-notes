'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const excludedDirectories = new Set(['node_modules', '.git', 'quickstartFunctions'])

function walk(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excludedDirectories.has(entry.name)) continue
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(fullPath))
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath)
  }
  return files
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) process.exit(result.status || 1)
}

run(process.execPath, [path.join('scripts', 'sync-cloudfunction-shared.js'), '--check'])

const files = walk(path.join(root, 'cloudfunctions'))
  .concat(walk(path.join(root, 'scripts')))
  .concat(walk(path.join(root, 'test')))

for (const file of files) run(process.execPath, ['--check', file])

// ---------------------------------------------------------------------------
// 禁止模式扫描
// ---------------------------------------------------------------------------
const forbidden = [
  {
    pattern: /\.skip\s*\(/u,
    label: 'offset pagination (.skip)',
    temporaryAllow: new Set([]),
  },
  { pattern: /console\.(?:log|warn|error)\s*\(/u, label: 'direct console logging' },
  { pattern: /(?:err|error)\.message/u, label: 'raw error message access' },
]

const scanFiles = walk(path.join(root, 'cloudfunctions'))
  .filter((file) => !file.includes(`${path.sep}_shared${path.sep}security-log.js`))
  .filter((file) => !file.includes(`${path.sep}lib${path.sep}shared${path.sep}security-log.js`))
const violations = []
for (const file of scanFiles) {
  const content = fs.readFileSync(file, 'utf8')
  for (const rule of forbidden) {
    const relative = path.relative(root, file)
    if (rule.temporaryAllow && rule.temporaryAllow.has(relative)) continue
    if (rule.pattern.test(content)) {
      violations.push(`${relative}: ${rule.label}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 安全字段扫描：在非 auth/security-log 文件中扫描敏感模式
// ---------------------------------------------------------------------------
const securityScanFiles = walk(path.join(root, 'cloudfunctions'))
  .filter((file) => {
    // 允许在共享基础设施中使用安全日志摘要
    const rel = path.relative(root, file)
    return !rel.includes(`${path.sep}_shared${path.sep}`) &&
           !rel.includes(`${path.sep}lib${path.sep}shared${path.sep}`)
  })

const securityPatterns = [
  {
    pattern: /['"]OPENID['"]/u,
    label: 'OPENID string literal (use openid variable or digest)',
  },
  {
    pattern: /['"]_openid['"]\s*:/u,
    label: '_openid in response construction (never expose)',
    // Exclude files that legitimately use _openid in database queries (where clauses)
    // We only flag it in response construction contexts
    requireResponseContext: true,
  },
]

for (const file of securityScanFiles) {
  const content = fs.readFileSync(file, 'utf8')
  const relative = path.relative(root, file)

  for (const rule of securityPatterns) {
    if (rule.pattern.test(content)) {
      // For _openid in responses, only flag if it appears in a data projection context
      if (rule.requireResponseContext) {
        // Check if _openid appears in a return/response object, not just a where clause
        const lines = content.split('\n')
        let inResponseContext = false
        for (const line of lines) {
          if (rule.pattern.test(line)) {
            // If this line contains 'where' or 'condition', it's a DB query, not a response
            if (!/\bwhere\b|\bcondition\b|\.doc\(|\bquery\b/.test(line)) {
              inResponseContext = true
              break
            }
          }
        }
        if (!inResponseContext) continue
      }
      violations.push(`${relative}: ${rule.label}`)
    }
  }
}

if (violations.length) {
  process.stderr.write(`Forbidden backend patterns detected:\n${violations.join('\n')}\n`)
  process.exit(1)
}

process.stdout.write(
  'DEV-13: All .skip() patterns resolved. Zero pagination debt.\n',
)
process.stdout.write(`Backend checks passed for ${files.length} JavaScript files.\n`)
