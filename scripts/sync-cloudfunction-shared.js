'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const root = path.resolve(__dirname, '..')
const sourceDirectory = path.join(root, 'cloudfunctions', '_shared')
const excludedFunctions = new Set(['_shared'])
const checkOnly = process.argv.includes('--check')

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort()
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function targetDirectories() {
  const cloudfunctions = path.join(root, 'cloudfunctions')
  return fs.readdirSync(cloudfunctions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !excludedFunctions.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: path.join(cloudfunctions, entry.name, 'lib', 'shared'),
    }))
}

function checkTarget(target, sourceFiles) {
  if (!fs.existsSync(target.path)) return [`${target.name}: missing lib/shared`]
  const targetFiles = listFiles(target.path)
  const errors = []
  for (const file of sourceFiles) {
    const targetFile = path.join(target.path, file)
    if (!targetFiles.includes(file)) {
      errors.push(`${target.name}: missing ${file}`)
    } else if (hash(path.join(sourceDirectory, file)) !== hash(targetFile)) {
      errors.push(`${target.name}: drifted ${file}`)
    }
  }
  for (const file of targetFiles) {
    if (!sourceFiles.includes(file)) errors.push(`${target.name}: unexpected ${file}`)
  }
  return errors
}

function syncTarget(target, sourceFiles) {
  fs.mkdirSync(target.path, { recursive: true })
  for (const file of listFiles(target.path)) {
    if (!sourceFiles.includes(file)) fs.rmSync(path.join(target.path, file))
  }
  for (const file of sourceFiles) {
    fs.copyFileSync(path.join(sourceDirectory, file), path.join(target.path, file))
  }
}

const sourceFiles = listFiles(sourceDirectory)
const targets = targetDirectories()

if (checkOnly) {
  const errors = targets.flatMap((target) => checkTarget(target, sourceFiles))
  if (errors.length) {
    process.stderr.write(`Shared module drift detected:\n${errors.join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`Shared modules are synchronized across ${targets.length} cloud functions.\n`)
  }
} else {
  for (const target of targets) syncTarget(target, sourceFiles)
  process.stdout.write(`Synchronized ${sourceFiles.length} shared modules to ${targets.length} cloud functions.\n`)
}
