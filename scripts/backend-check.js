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

const forbidden = [
  {
    pattern: /\.skip\s*\(/u,
    label: 'offset pagination (.skip)',
    temporaryAllow: new Set([
      path.join('cloudfunctions', 'photo', 'index.js'),
      path.join('cloudfunctions', 'note', 'index.js'),
    ]),
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
if (violations.length) {
  process.stderr.write(`Forbidden backend patterns detected:\n${violations.join('\n')}\n`)
  process.exit(1)
}

process.stdout.write(
  'Known DEV-06/DEV-08 pagination debt remains isolated to photo/note handlers.\n',
)
process.stdout.write(`Backend checks passed for ${files.length} JavaScript files.\n`)
