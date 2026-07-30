'use strict'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CHECKPOINT_ID_PHOTOS = 'system-count-corrector-photos-v1'
const CHECKPOINT_ID_TAGS = 'system-count-corrector-tags-v1'
const CHECKPOINT_OWNER = '__system__'
const CHECKPOINT_TASK_KEY_PHOTOS = 'COUNT_CORRECTOR_PHOTOS:V1'
const CHECKPOINT_TASK_KEY_TAGS = 'COUNT_CORRECTOR_TAGS:V1'
const DEFAULT_BATCH_SIZE = 100
const DEFAULT_MAX_ROUNDS = 10
const PHOTO_TAG_MAX = 5

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function emptyPhotosCheckpoint() {
  return {
    _id: CHECKPOINT_ID_PHOTOS,
    _openid: CHECKPOINT_OWNER,
    type: 'COUNT_CORRECTOR',
    task_key: CHECKPOINT_TASK_KEY_PHOTOS,
    status: 'PENDING',
    cursors: { photos: null },
    completed: false,
  }
}

function emptyTagsCheckpoint() {
  return {
    _id: CHECKPOINT_ID_TAGS,
    _openid: CHECKPOINT_OWNER,
    type: 'COUNT_CORRECTOR',
    task_key: CHECKPOINT_TASK_KEY_TAGS,
    status: 'PENDING',
    cursors: { tags: null },
    completed: false,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createCountCorrector(deps) {
  const {
    db,
    now = () => new Date(),
  } = deps

  const _ = db.command

  // -------------------------------------------------------------------------
  // Checkpoint management
  // -------------------------------------------------------------------------
  async function loadCheckpoint(checkpointId, emptyFn) {
    try {
      const result = await db.collection('deletion_tasks')
        .doc(checkpointId)
        .get()
      const doc = result && result.data
        ? (Array.isArray(result.data) ? result.data[0] : result.data)
        : null
      if (doc) return doc
    } catch (_e) {
      // Not found
    }
    return emptyFn()
  }

  async function saveCheckpoint(checkpoint) {
    const timestamp = now()
    await db.collection('deletion_tasks').doc(checkpoint._id).set({
      data: {
        _openid: CHECKPOINT_OWNER,
        type: 'COUNT_CORRECTOR',
        task_key: checkpoint.task_key,
        status: 'PENDING',
        cursors: { ...(checkpoint.cursors || {}) },
        completed: Boolean(checkpoint.completed),
        updated_at: timestamp,
      },
    })
  }

  // -------------------------------------------------------------------------
  // Phase 1: Correct photos.tag_count
  // -------------------------------------------------------------------------
  async function correctPhotoTagCounts(options) {
    const {
      dryRun = true,
      batchSize = DEFAULT_BATCH_SIZE,
      maxRounds = DEFAULT_MAX_ROUNDS,
    } = options

    const checkpoint = await loadCheckpoint(
      CHECKPOINT_ID_PHOTOS,
      emptyPhotosCheckpoint,
    )

    if (checkpoint.completed) {
      checkpoint.cursors = { photos: null }
      checkpoint.completed = false
    }

    let cursor = checkpoint.cursors.photos || null
    let scanned = 0
    let corrected = 0
    let completed = false
    let rounds = 0

    for (let r = 0; r < maxRounds; r++) {
      rounds = r + 1

      // Scan photos (ACTIVE only) by _id ASC
      const condition = { status: 'ACTIVE' }
      if (cursor) {
        condition._id = _.gt(cursor)
      }

      const result = await db.collection('photos')
        .where(condition)
        .orderBy('_id', 'asc')
        .limit(batchSize)
        .get()

      const photos = Array.isArray(result.data) ? result.data : []
      if (photos.length === 0) {
        completed = true
        break
      }

      scanned += photos.length

      // For each photo, count actual photo_tags and compare
      for (const photo of photos) {
        const countResult = await db.collection('photo_tags')
          .where({
            _openid: photo._openid,
            photo_id: photo._id,
          })
          .count()

        const actualCount = countResult.total || 0
        const clampedCount = Math.max(0, Math.min(PHOTO_TAG_MAX, actualCount))
        const currentCount = typeof photo.tag_count === 'number'
          ? photo.tag_count
          : 0

        if (currentCount !== clampedCount) {
          corrected++
          if (!dryRun) {
            try {
              await db.collection('photos').doc(photo._id).update({
                data: { tag_count: clampedCount },
              })
            } catch (_e) {
              // Photo may have been deleted — skip
            }
          }
        }
      }

      // Advance cursor
      cursor = photos[photos.length - 1]._id
      checkpoint.cursors.photos = cursor
      checkpoint.completed = false
      await saveCheckpoint(checkpoint)

      if (photos.length < batchSize) {
        completed = true
        break
      }
    }

    if (completed) {
      checkpoint.cursors.photos = null
      checkpoint.completed = true
      await saveCheckpoint(checkpoint)
    }

    return { scanned, corrected, completed, rounds }
  }

  // -------------------------------------------------------------------------
  // Phase 2: Correct tags.photo_count
  // -------------------------------------------------------------------------
  async function correctTagPhotoCounts(options) {
    const {
      dryRun = true,
      batchSize = DEFAULT_BATCH_SIZE,
      maxRounds = DEFAULT_MAX_ROUNDS,
    } = options

    const checkpoint = await loadCheckpoint(
      CHECKPOINT_ID_TAGS,
      emptyTagsCheckpoint,
    )

    if (checkpoint.completed) {
      checkpoint.cursors = { tags: null }
      checkpoint.completed = false
    }

    let cursor = checkpoint.cursors.tags || null
    let scanned = 0
    let corrected = 0
    let completed = false
    let rounds = 0

    for (let r = 0; r < maxRounds; r++) {
      rounds = r + 1

      // Scan tags by _id ASC
      const condition = {}
      if (cursor) {
        condition._id = _.gt(cursor)
      }

      const result = await db.collection('tags')
        .where(condition)
        .orderBy('_id', 'asc')
        .limit(batchSize)
        .get()

      const tags = Array.isArray(result.data) ? result.data : []
      if (tags.length === 0) {
        completed = true
        break
      }

      scanned += tags.length

      // For each tag, count actual photo_tags and compare
      for (const tag of tags) {
        const countResult = await db.collection('photo_tags')
          .where({
            _openid: tag._openid,
            tag_id: tag._id,
          })
          .count()

        const actualCount = countResult.total || 0
        // tag.photo_count must be >= 0
        const clampedCount = Math.max(0, actualCount)
        const currentCount = typeof tag.photo_count === 'number'
          ? tag.photo_count
          : 0

        if (currentCount !== clampedCount) {
          corrected++
          if (!dryRun) {
            try {
              await db.collection('tags').doc(tag._id).update({
                data: { photo_count: clampedCount },
              })
            } catch (_e) {
              // Tag may have been deleted — skip
            }
          }
        }
      }

      // Advance cursor
      cursor = tags[tags.length - 1]._id
      checkpoint.cursors.tags = cursor
      checkpoint.completed = false
      await saveCheckpoint(checkpoint)

      if (tags.length < batchSize) {
        completed = true
        break
      }
    }

    if (completed) {
      checkpoint.cursors.tags = null
      checkpoint.completed = true
      await saveCheckpoint(checkpoint)
    }

    return { scanned, corrected, completed, rounds }
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
      throw new TypeError('count corrector batch size must be 1–200')
    }
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) {
      throw new TypeError('count corrector max rounds must be 1–50')
    }

    const opts = { dryRun, batchSize, maxRounds }

    const photosResult = await correctPhotoTagCounts(opts)
    const tagsResult = await correctTagPhotoCounts(opts)

    return {
      photos: photosResult,
      tags: tagsResult,
    }
  }

  return { run }
}

module.exports = {
  CHECKPOINT_ID_PHOTOS,
  CHECKPOINT_ID_TAGS,
  CHECKPOINT_TASK_KEY_PHOTOS,
  CHECKPOINT_TASK_KEY_TAGS,
  CHECKPOINT_OWNER,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_ROUNDS,
  PHOTO_TAG_MAX,
  createCountCorrector,
}
