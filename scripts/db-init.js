'use strict'

const crypto = require('crypto')
const { COLLECTIONS, flattenIndexes } = require('./backend-schema')

const SAFE_ENV_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u
const ALREADY_EXISTS_CODES = new Set([
  'DATABASE_COLLECTION_EXIST',
  'INDEX_ALREADY_EXISTS',
  'ResourceConflict',
  'ResourceInUse',
])

class CliError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function parseArgs(argv) {
  const options = { mode: 'dry-run', envId: null, help: false }
  let explicitMode = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--dry-run' || arg === '--apply') {
      const mode = arg === '--apply' ? 'apply' : 'dry-run'
      if (explicitMode && explicitMode !== mode) {
        throw new CliError('CONFLICTING_MODES')
      }
      explicitMode = mode
      options.mode = mode
    } else if (arg === '--env') {
      index += 1
      options.envId = argv[index] || null
    } else {
      throw new CliError('UNKNOWN_ARGUMENT')
    }
  }

  if (!options.help && !SAFE_ENV_PATTERN.test(options.envId || '')) {
    throw new CliError('ENV_REQUIRED')
  }
  return options
}

function environmentHash(envId) {
  return crypto.createHash('sha256').update(envId).digest('hex').slice(0, 12)
}

function buildPlan(options, now = new Date()) {
  return {
    mode: options.mode,
    environmentHash: environmentHash(options.envId),
    collections: COLLECTIONS.map((collection) => collection.name),
    indexes: flattenIndexes(),
    backfill: {
      collection: 'photos',
      missingOnly: true,
      fields: {
        status: 'ACTIVE',
        updated_at: now.toISOString(),
        tag_count: 0,
      },
    },
  }
}

function isAlreadyExists(error) {
  return Boolean(error && ALREADY_EXISTS_CODES.has(error.code))
}

function indexMatchesCloud(index, cloudIndex) {
  if (!cloudIndex || cloudIndex.Name !== index.name) return false
  const cloudUnique =
    cloudIndex.Unique === true || String(cloudIndex.Unique).toLowerCase() === 'true'
  if (cloudUnique !== Boolean(index.unique)) return false
  const cloudKeys = Array.isArray(cloudIndex.Keys) ? cloudIndex.Keys : []
  const expectedKeys = Object.entries(index.keys)
  if (cloudKeys.length !== expectedKeys.length) return false
  return expectedKeys.every(([name, direction], position) => {
    const actual = cloudKeys[position]
    return actual &&
      actual.Name === name &&
      String(actual.Direction) === String(direction)
  })
}

async function applyPlan(adapter, options = {}) {
  const now = options.now || new Date()
  const summary = {
    collectionsCreated: 0,
    collectionsExisting: 0,
    indexesCreated: 0,
    indexesExisting: 0,
    backfillMatched: 0,
    backfillUpdated: 0,
    backfillRemaining: 0,
  }

  for (const collection of COLLECTIONS) {
    try {
      await adapter.createCollection(collection.name)
      summary.collectionsCreated += 1
    } catch (error) {
      if (!isAlreadyExists(error)) throw new CliError('COLLECTION_CREATE_FAILED')
      summary.collectionsExisting += 1
    }
  }

  const photos = COLLECTIONS.find((item) => item.name === 'photos')
  for (const item of photos.backfill) {
    const value = item.value === 'NOW' ? now : item.value
    const result = await adapter.backfillMissing('photos', item.field, value)
    summary.backfillMatched += Number(result.matched || 0)
    summary.backfillUpdated += Number(result.updated || 0)
  }

  for (const collection of COLLECTIONS) {
    for (const index of collection.indexes) {
      try {
        await adapter.createIndex(collection.name, index)
        summary.indexesCreated += 1
      } catch (error) {
        if (!isAlreadyExists(error)) throw new CliError('INDEX_CREATE_FAILED')
        summary.indexesExisting += 1
      }
    }
  }

  for (const item of photos.backfill) {
    summary.backfillRemaining += await adapter.countMissing(
      'photos',
      item.field,
    )
  }
  if (summary.backfillRemaining !== 0) {
    throw new CliError('BACKFILL_VERIFICATION_FAILED')
  }
  return summary
}

function createCloudBaseAdapter(envId, env = process.env) {
  if (!env.CLOUDBASE_SECRET_ID || !env.CLOUDBASE_SECRET_KEY) {
    throw new CliError('CREDENTIALS_REQUIRED')
  }

  let CloudBase
  let cloudbase
  try {
    CloudBase = require('@cloudbase/manager-node')
    cloudbase = require('@cloudbase/node-sdk')
  } catch (_) {
    throw new CliError('CLOUDBASE_SDK_REQUIRED')
  }

  const manager = new CloudBase({
    envId,
    secretId: env.CLOUDBASE_SECRET_ID,
    secretKey: env.CLOUDBASE_SECRET_KEY,
  })
  const app = cloudbase.init({
    env: envId,
    secretId: env.CLOUDBASE_SECRET_ID,
    secretKey: env.CLOUDBASE_SECRET_KEY,
  })
  const db = app.database()
  const command = db.command

  return {
    async createCollection(name) {
      const result = await manager.database.checkCollectionExists(name)
      if (result.Exists) {
        throw Object.assign(new Error(), { code: 'ResourceConflict' })
      }
      return manager.database.createCollection(name)
    },
    async createIndex(collection, index) {
      const description = await manager.database.describeCollection(collection)
      const existing = (description.Indexes || []).find(
        (item) => item.Name === index.name,
      )
      if (existing && indexMatchesCloud(index, existing)) {
        throw Object.assign(new Error(), { code: 'INDEX_ALREADY_EXISTS' })
      }
      if (existing) throw new CliError('INDEX_DEFINITION_MISMATCH')
      return manager.database.updateCollection(collection, {
        CreateIndexes: [{
          IndexName: index.name,
          MgoKeySchema: {
            MgoIsUnique: Boolean(index.unique),
            MgoIndexKeys: Object.entries(index.keys).map(
              ([name, direction]) => ({
                Name: name,
                Direction: String(direction),
              }),
            ),
          },
        }],
      })
    },
    async backfillMissing(collection, field, value) {
      const query = db
        .collection(collection)
        .where({ [field]: command.exists(false) })
      const before = await query.count()
      if (!before.total) return { matched: 0, updated: 0 }
      const result = await query.update({ [field]: value })
      return {
        matched: before.total,
        updated: Number(result.updated || 0),
      }
    },
    async countMissing(collection, field) {
      const result = await db
        .collection(collection)
        .where({ [field]: command.exists(false) })
        .count()
      return Number(result.total || 0)
    },
  }
}

function printUsage(write) {
  write(
    'Usage: node scripts/db-init.js [--dry-run|--apply] --env <environment-id>\n',
  )
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv)
  if (options.help) {
    printUsage(process.stdout.write.bind(process.stdout))
    return
  }

  const plan = buildPlan(options)
  if (options.mode === 'dry-run') {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return plan
  }

  const adapter = createCloudBaseAdapter(options.envId, env)
  const summary = await applyPlan(adapter)
  process.stdout.write(
    `${JSON.stringify({
      mode: options.mode,
      environmentHash: plan.environmentHash,
      summary,
    }, null, 2)}\n`,
  )
  return summary
}

if (require.main === module) {
  main().catch((error) => {
    const safeCode = error instanceof CliError ? error.code : 'UNEXPECTED_FAILURE'
    process.stderr.write(`Database initialization failed: ${safeCode}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  CliError,
  applyPlan,
  buildPlan,
  createCloudBaseAdapter,
  indexMatchesCloud,
  main,
  parseArgs,
}
