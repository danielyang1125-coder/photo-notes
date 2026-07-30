'use strict'

/**
 * backend-log-audit.js — 审计所有云函数源文件中的日志调用，
 * 确保只使用 security-log.js 中 ALLOWED_FIELDS 白名单内的字段。
 *
 * 用法：
 *   node scripts/backend-log-audit.js
 *
 * 退出码：
 *   0 — 未发现违规
 *   1 — 发现日志字段违规
 */

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const excludedDirectories = new Set(['node_modules', '.git', 'quickstartFunctions'])

// ---------------------------------------------------------------------------
// 从 security-log.js 提取 ALLOWED_FIELDS
// ---------------------------------------------------------------------------
function loadAllowedFields() {
  const sourcePath = path.join(root, 'cloudfunctions', '_shared', 'security-log.js')
  const content = fs.readFileSync(sourcePath, 'utf8')

  // 匹配 ALLOWED_FIELDS = new Set([...])
  const match = content.match(
    /ALLOWED_FIELDS\s*=\s*new\s+Set\s*\(\s*\[([^\]]*)\]\s*\)/,
  )
  if (!match) {
    process.stderr.write('错误：无法解析 security-log.js 中的 ALLOWED_FIELDS。\n')
    process.exit(2)
  }

  const fieldsStr = match[1]
  const fields = []
  // 提取单引号或双引号内的字符串
  const fieldPattern = /['"]([^'"]+)['"]/g
  let fieldMatch
  while ((fieldMatch = fieldPattern.exec(fieldsStr)) !== null) {
    fields.push(fieldMatch[1])
  }

  return new Set(fields)
}

// ---------------------------------------------------------------------------
// 遍历目录
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 从 logger 调用参数中提取字段名
// ---------------------------------------------------------------------------
function extractLogFields(callText) {
  // 匹配 logger.info({ ... }) 或 logger.error({ ... })
  const match = callText.match(
    /logger\s*\.\s*(?:info|error)\s*\(\s*\{([^}]*)\}\s*\)/,
  )
  if (!match) {
    // 可能跨多行 — 检查是否以 { 开头
    const braceMatch = callText.match(
      /logger\s*\.\s*(?:info|error)\s*\(\s*\{/,
    )
    if (!braceMatch) return [] // 变量或函数调用，跳过
    // 提取到第一个闭合花括号
    const openIdx = callText.indexOf('{', braceMatch.index)
    let depth = 0
    let closeIdx = -1
    for (let i = openIdx; i < callText.length; i += 1) {
      if (callText[i] === '{') depth += 1
      else if (callText[i] === '}') {
        depth -= 1
        if (depth === 0) {
          closeIdx = i
          break
        }
      }
    }
    if (closeIdx === -1) return []
    const body = callText.slice(openIdx + 1, closeIdx)
    return extractFieldNames(body)
  }

  const body = match[1]
  return extractFieldNames(body)
}

function extractFieldNames(objBody) {
  const fields = []
  // 匹配键名：key: 或 'key': 或 "key":
  const keyPattern = /['"]?(\w+)['"]?\s*:/g
  let m
  while ((m = keyPattern.exec(objBody)) !== null) {
    fields.push(m[1])
  }
  return fields
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
function main() {
  const allowedFields = loadAllowedFields()
  const cloudFunctionFiles = walk(path.join(root, 'cloudfunctions'))

  const violations = []

  for (const file of cloudFunctionFiles) {
    const content = fs.readFileSync(file, 'utf8')
    const relative = path.relative(root, file)

    // 跳过 security-log.js 自身和它的副本
    if (relative.includes('security-log.js')) continue
    // 跳过共享模块（它们在 security-log.js 允许列表语境下使用）
    if (relative.includes(`${path.sep}_shared${path.sep}`)) continue
    if (relative.includes(`${path.sep}lib${path.sep}shared${path.sep}`)) continue

    // 查找所有 logger.info 和 logger.error 调用
    const loggerPattern = /logger\s*\.\s*(?:info|error)\s*\(\s*\{[^}]*\}\s*\)/g
    const calls = content.match(loggerPattern)
    if (!calls) continue

    for (const call of calls) {
      // 将调用文本合并成一行以进行字段提取
      const singleLine = call.replace(/\s+/g, ' ')
      const fields = extractLogFields(singleLine)

      for (const field of fields) {
        if (!allowedFields.has(field)) {
          violations.push(
            `${relative}: logger 调用中的禁止字段 '${field}'（不在 ALLOWED_FIELDS 中）`,
          )
        }
      }
    }

    // 同时检查多行 logger 调用
    const multiLinePattern = /logger\s*\.\s*(?:info|error)\s*\(\s*\{/g
    let match
    while ((match = multiLinePattern.exec(content)) !== null) {
      const startIdx = match.index
      let depth = 0
      let endIdx = -1
      for (let i = startIdx; i < content.length; i += 1) {
        if (content[i] === '{') depth += 1
        else if (content[i] === '}') {
          depth -= 1
          if (depth === 0) {
            endIdx = i
            break
          }
        }
      }
      if (endIdx === -1) continue

      const body = content.slice(
        content.indexOf('{', startIdx) + 1,
        endIdx,
      )
      const fields = extractFieldNames(body)

      for (const field of fields) {
        if (!allowedFields.has(field)) {
          // 避免重复（单行模式可能已经捕获）
          const vMsg = `${relative}: logger 调用中的禁止字段 '${field}'（不在 ALLOWED_FIELDS 中）`
          if (!violations.includes(vMsg)) {
            violations.push(vMsg)
          }
        }
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write(
      `日志安全审计发现 ${violations.length} 个违规项：\n`,
    )
    for (const v of violations) {
      process.stderr.write(`  ${v}\n`)
    }
    process.stderr.write(
      '\n只允许使用以下日志字段：' +
      [...allowedFields].map((f) => `"${f}"`).join(', ') +
      '\n',
    )
    process.exit(1)
  }

  process.stdout.write(
    `日志安全审计通过：${cloudFunctionFiles.length} 个文件中未发现违规项。\n`,
  )
  process.stdout.write(
    `允许的日志字段：${[...allowedFields].map((f) => `"${f}"`).join(', ')}\n`,
  )
}

main()
