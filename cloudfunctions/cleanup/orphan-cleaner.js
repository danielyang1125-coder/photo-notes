'use strict'

const { withTransactionRetry } = require('./lib/shared/transaction')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CHECKPOINT_TASK_KEY = 'ORPHAN_CLEANER:V1'
const CHECKPOINT_ID = 'system-orphan-cleaner-v1'
const CHECKPOINT_OWNER = '__system__'
const DEFAULT_BATCH_SIZE = 100
const DEFAULT_MAX_ROUNDS = 10

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function emptyCheckpoint() {
  return {
    _id: CHECKPOINT_ID,
    _openid: CHECKPOINT_OWNER,
    type: 'ORPHAN_CLEANER',
    task_key: CHECKPOINT_TASK_KEY,
    status: 'PENDING',
    cursors: { photo_tags: null },
    completed: false,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createOrphanCleaner(deps) {
  const {
    db,
    now = () => new Date(),
  } = deps

  const _ = db.command

  // -------------------------------------------------------------------------
  // Checkpoint management (stored in deletion_tasks collection)
  // -------------------------------------------------------------------------
  async function loadCheckpoint() {
    try {
      const result = await db.collection('deletion_tasks')
        .doc(CHECKPOINT_ID)
        .get()
      const doc = result && result.data
        ? (Array.isArray(result.data) ? result.data[0] : result.data)
        : null
      if (doc) return doc
    } catch (_e) {
      // Document not found — use empty checkpoint
    }
    return emptyCheckpoint()
  }

  async function saveCheckpoint(checkpoint) {
    const timestamp = now()
    await db.collection('deletion_tasks').doc(CHECKPOINT_ID).set({
      data: {
        _openid: CHECKPOINT_OWNER,
        type: 'ORPHAN_CLEANER',
        task_key: CHECKPOINT_TASK_KEY,
        status: 'PENDING',
        cursors: { ...(checkpoint.cursors || {}) },
        completed: Boolean(checkpoint.completed),
        updated_at: timestamp,
      },
    })
  }

  // -------------------------------------------------------------------------
  // Scan one batch of photo_tags
  // -------------------------------------------------------------------------
  async function scanBatch(cursor, batchSize) {
    const condition = {}
    if (cursor) {
      condition._id = _.gt(cursor)
    }

    const result = await db.collection('photo_tags')
      .where(condition)
      .orderBy('_id', 'asc')
      .limit(batchSize)
      .get()

    return Array.isArray(result.data) ? result.data : []
  }

  // -------------------------------------------------------------------------
  // Group relations by _openid
  // -------------------------------------------------------------------------
  function groupByUser(relations) {
    const groups = new Map()
    for (const rel of relations) {
      const oid = rel._openid
      if (!groups.has(oid)) {
        groups.set(oid, { photoIds: new Set(), tagIds: new Set(), relations: [] })
      }
      const group = groups.get(oid)
      group.photoIds.add(rel.photo_id)
      group.tagIds.add(rel.tag_id)
      group.relations.push(rel)
    }
    return groups
  }

  // -------------------------------------------------------------------------
  // For one user's batch, determine which photo_tags are orphaned.
  // Returns { orphanedIds, tagCountDecrements }
  // -------------------------------------------------------------------------
  async function findOrphans(openid, photoIds, tagIds) {
    // Batch check photos: must exist AND be ACTIVE
    const photoIdArr = [...photoIds]
    let activePhotoIds = new Set()
    if (photoIdArr.length > 0) {
      const photoResult = await db.collection('photos')
        .where({
          _id: _.in(photoIdArr),
          _openid: openid,
          status: 'ACTIVE',
        })
        .get()
      activePhotoIds = new Set(
        (Array.isArray(photoResult.data) ? photoResult.data : [])
          .map((p) => p._id),
      )
    }

    // Batch check tags: must exist
    const tagIdArr = [...tagIds]
    let existingTagIds = new Set()
    if (tagIdArr.length > 0) {
      const tagResult = await db.collection('tags')
        .where({
          _id: _.in(tagIdArr),
          _openid: openid,
        })
        .get()
      existingTagIds = new Set(
        (Array.isArray(tagResult.data) ? tagResult.data : [])
          .map((t) => t._id),
      )
    }

    // Count: for orphan deletions, we need to know which tags we'll decrement.
    // The tagCountDecrements map is: tag_id → number of relations to decrement
    return { activePhotoIds, existingTagIds }
  }

  // -------------------------------------------------------------------------
  // Process a single batch of photo_tags
  // -------------------------------------------------------------------------
  async function processBatch(relations, dryRun) {
    let orphaned = 0
    let deleted = 0
    const tagDecrements = new Map() // tagId → count

    const groups = groupByUser(relations)

    for (const [openid, group] of groups) {
      const { activePhotoIds, existingTagIds } = await findOrphans(
        openid,
        group.photoIds,
        group.tagIds,
      )

      for (const rel of group.relations) {
        const photoMissing = !activePhotoIds.has(rel.photo_id)
        const tagMissing = !existingTagIds.has(rel.tag_id)

        if (photoMissing || tagMissing) {
          orphaned++

          // Only decrement tag.photo_count if tag still exists (photo missing case)
          // If tag is missing, the tag itself is gone — nothing to decrement.
          if (!tagMissing) {
            tagDecrements.set(
              rel.tag_id,
              (tagDecrements.get(rel.tag_id) || 0) + 1,
            )
          }

          if (!dryRun) {
            // Delete the orphaned relation
            try {
              await db.collection('photo_tags').doc(rel._id).remove()
              deleted++
            } catch (_e) {
              // Already removed — idempotent
            }
          }
        }
      }
    }

    // Apply tag.photo_count decrements (non-dry-run only)
    if (!dryRun && tagDecrements.size > 0) {
      for (const [tagId, count] of tagDecrements) {
        try {
          await db.collection('tags').doc(tagId).update({
            data: { photo_count: _.inc(-count) },
          })
        } catch (_e) {
          // Tag may have been deleted concurrently — safe to skip
        }
      }
    }

    return { orphaned, deleted }
  }

  // -------------------------------------------------------------------------
  // Main run method
  // -------------------------------------------------------------------------
  async function run(options = {}) {
    const {
      dryRun = true,
      batchSize = DEFAULT_BATCH_SIZE,
      maxRounds = DEFAULT_MAX_ROUNDS,
    } = options

    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
      throw new TypeError('orphan cleaner batch size must be 1–200')
    }
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) {
      throw new TypeError('orphan cleaner max rounds must be 1–50')
    }

    const checkpoint = await loadCheckpoint()

    // If already completed, reset cursor for a new full scan
    if (checkpoint.completed) {
      checkpoint.cursors = { photo_tags: null }
      checkpoint.completed = false
    }

    let cursor = checkpoint.cursors.photo_tags || null
    let totalScanned = 0
    let totalOrphaned = 0
    let totalDeleted = 0
    let completed = false
    let rounds = 0

    for (let r = 0; r < maxRounds; r++) {
      rounds = r + 1
      const batch = await scanBatch(cursor, batchSize)

      if (batch.length === 0) {
        completed = true
        break
      }

      totalScanned += batch.length

      const result = await processBatch(batch, dryRun)
      totalOrphaned += result.orphaned
      totalDeleted += result.deleted

      // Advance cursor to last _id in batch
      cursor = batch[batch.length - 1]._id
      checkpoint.cursors.photo_tags = cursor
      checkpoint.completed = false
      await saveCheckpoint(checkpoint)

      // If batch is smaller than batchSize, we've exhausted the collection
      if (batch.length < batchSize) {
        completed = true
        break
      }
    }

    // If we exhausted all data, mark as completed
    if (completed) {
      checkpoint.cursors.photo_tags = null
      checkpoint.completed = true
      await saveCheckpoint(checkpoint)
    }

    return {
      scanned: totalScanned,
      orphaned: totalOrphaned,
      deleted: totalDeleted,
      completed,
      rounds,
    }
  }

  return { run }
}

module.exports = {
  CHECKPOINT_ID,
  CHECKPOINT_TASK_KEY,
  CHECKPOINT_OWNER,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_ROUNDS,
  createOrphanCleaner,
}
