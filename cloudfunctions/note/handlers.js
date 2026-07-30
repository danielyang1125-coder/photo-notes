'use strict'

const { AppError, success } = require('./lib/shared/response')
const validation = require('./lib/shared/validation')
const { encodeCursor, decodeCursor, keysetCondition } =
  require('./lib/shared/cursor')

const MAX_PAGE_SIZE = 20
const MAX_SCAN_MULTIPLIER = 5

function createNoteHandlers(deps) {
  const { db, getTempFileURL, cursorSecret, reviewContent } = deps
  const _ = db.command

  function resolveSecret() {
    const secret =
      typeof cursorSecret === 'function' ? cursorSecret() : cursorSecret
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new AppError('INTERNAL_ERROR')
    }
    return secret
  }

  function cursorBinding(sortBy, sortOrder) {
    return {
      resource: 'NOTE',
      sortBy,
      sortOrder,
    }
  }

  function projectNote(note) {
    return {
      _id: note._id,
      photo_id: note.photo_id,
      thumbnail_url: note.thumbnail_url || '',
      content: note.content,
      content_code_point_count: note.content_code_point_count,
      photo_shoot_time: note.photo_shoot_time,
      created_at: note.created_at,
      updated_at: note.updated_at,
    }
  }

  async function generateThumbnailUrls(notes) {
    if (!notes || notes.length === 0) return
    const fileIds = notes.map((n) => n.photo_file_id).filter(Boolean)
    if (fileIds.length === 0) {
      notes.forEach((n) => {
        n.thumbnail_url = ''
      })
      return
    }
    try {
      const urlResult = await getTempFileURL(fileIds)
      const urlMap = {}
      ;(urlResult.fileList || []).forEach((f) => {
        if (f.tempFileURL) {
          const sep = f.tempFileURL.includes('?') ? '&' : '?'
          urlMap[f.fileID] =
            f.tempFileURL + sep + 'imageMogr2/thumbnail/!200x200r'
        }
      })
      notes.forEach((n) => {
        n.thumbnail_url = urlMap[n.photo_file_id] || ''
      })
    } catch (_err) {
      notes.forEach((n) => {
        n.thumbnail_url = ''
      })
    }
  }

  // ============================================================
  // add
  // ============================================================
  async function add(openid, event) {
    const photoId = validation.string(event.photoId, { min: 1, max: 128 })
    const content = validation.string(event.content, { min: 1, max: 1000 })

    // Verify photo exists, is ACTIVE, and owned by this user
    const photoResult = await db.collection('photos')
      .where({ _id: photoId, _openid: openid, status: 'ACTIVE' })
      .limit(1)
      .get()

    if (!photoResult.data || photoResult.data.length === 0) {
      throw new AppError('PHOTO_NOT_FOUND')
    }

    const photo = photoResult.data[0]

    // Content review
    await reviewContent(content, openid)

    const codePointCount = Array.from(content).length
    const note = {
      _openid: openid,
      photo_id: photoId,
      photo_file_id: photo.file_id || '',
      content: content,
      content_code_point_count: codePointCount,
      photo_shoot_time: photo.shoot_time || photo.upload_time,
      created_at: db.serverDate(),
      updated_at: db.serverDate(),
    }

    const addResult = await db.collection('notes').add({ data: note })

    return success({
      note: projectNote({ _id: addResult._id, ...note }),
    })
  }

  // ============================================================
  // update
  // ============================================================
  async function update(openid, event) {
    const noteId = validation.string(event.noteId, { min: 1, max: 128 })
    const content = validation.string(event.content, { min: 1, max: 1000 })
    const updatedAt = validation.isoDate(event.updatedAt) // REQUIRED — no fallback

    // Content review
    await reviewContent(content, openid)

    const codePointCount = Array.from(content).length

    // Optimistic lock: condition includes _id + _openid + updated_at
    const where = {
      _id: noteId,
      _openid: openid,
      updated_at: updatedAt,
    }

    const updateResult = await db.collection('notes').where(where).update({
      data: {
        content: content,
        content_code_point_count: codePointCount,
        updated_at: db.serverDate(),
      },
    })

    if (updateResult.stats.updated === 0) {
      // Conflict — read current version with ownership check, not bare doc(id)
      const currentResult = await db.collection('notes')
        .where({ _id: noteId, _openid: openid })
        .limit(1)
        .get()

      if (!currentResult.data || currentResult.data.length === 0) {
        throw new AppError('NOTE_NOT_FOUND')
      }

      // Return safe projection with conflict flag
      return success({ note: projectNote(currentResult.data[0]), conflict: true })
    }

    // Read updated note with ownership check
    const updatedResult = await db.collection('notes')
      .where({ _id: noteId, _openid: openid })
      .limit(1)
      .get()

    return success({ note: projectNote(updatedResult.data[0]) })
  }

  // ============================================================
  // delete
  // ============================================================
  async function deleteNote(openid, event) {
    const noteId = validation.string(event.noteId, { min: 1, max: 128 })

    // Find note with ownership check
    const noteResult = await db.collection('notes')
      .where({ _id: noteId, _openid: openid })
      .limit(1)
      .get()

    if (!noteResult.data || noteResult.data.length === 0) {
      throw new AppError('NOTE_NOT_FOUND')
    }

    const note = noteResult.data[0]

    // Delete note — V1 does not maintain photo counters
    await db.collection('notes').doc(noteId).remove()

    return success({ deleted: true, photoId: note.photo_id })
  }

  // ============================================================
  // list
  // ============================================================
  async function list(openid, event) {
    const sortBy = validation.enumValue(
      event.sortBy || 'created_at',
      ['created_at', 'photo_shoot_time'],
    )
    const sortOrder = validation.enumValue(
      event.sortOrder || 'desc',
      ['asc', 'desc'],
    )

    let pageSize = MAX_PAGE_SIZE
    if (event.pageSize !== undefined) {
      if (
        typeof event.pageSize !== 'number' ||
        !Number.isInteger(event.pageSize) ||
        event.pageSize < 1 ||
        event.pageSize > MAX_PAGE_SIZE
      ) {
        throw new AppError('VALIDATION_ERROR')
      }
      pageSize = event.pageSize
    }

    const secret = resolveSecret()
    const sortField = sortBy // 'created_at' or 'photo_shoot_time'
    const binding = cursorBinding(sortBy, sortOrder)

    let decoded = null
    if (event.cursor) {
      validation.string(event.cursor, { min: 1, max: 1024 })
      decoded = decodeCursor(event.cursor, binding, secret)
    }

    const maxScan = pageSize * MAX_SCAN_MULTIPLIER
    const validatedNotes = []
    let scannedCount = 0
    let exhausted = false

    // Cursor anchor — starts from decoded cursor or null (beginning)
    let anchorValue = decoded ? decoded.lastValue : null
    let anchorId = decoded ? decoded.lastId : null

    while (
      validatedNotes.length < pageSize &&
      scannedCount < maxScan &&
      !exhausted
    ) {
      const baseWhere = { _openid: openid }

      let query
      if (anchorValue !== null && anchorId !== null) {
        const cond = keysetCondition(
          _, sortField, sortOrder,
          anchorValue, anchorId,
        )
        query = db.collection('notes').where(_.and([baseWhere, cond]))
      } else {
        query = db.collection('notes').where(baseWhere)
      }

      const needed = Math.min(pageSize, maxScan - scannedCount)
      const fetchLimit = needed + 1
      const result = await query
        .orderBy(sortField, sortOrder)
        .orderBy('_id', sortOrder)
        .limit(fetchLimit)
        .get()

      const rawNotes = result.data || []
      if (rawNotes.length === 0) {
        exhausted = true
        break
      }

      // Detect if there are more notes beyond this batch
      const hasMoreAfter = rawNotes.length === fetchLimit
      const notes = hasMoreAfter
        ? rawNotes.slice(0, needed)
        : rawNotes

      if (!hasMoreAfter) {
        exhausted = true
      }

      scannedCount += notes.length

      // Batch verify parent photos are ACTIVE
      const photoIds = [
        ...new Set(notes.map((n) => n.photo_id).filter(Boolean)),
      ]
      const photoMap = {}
      if (photoIds.length > 0) {
        const photoResult = await db.collection('photos')
          .where({
            _id: _.in(photoIds),
            _openid: openid,
            status: 'ACTIVE',
          })
          .get()
        ;(photoResult.data || []).forEach((p) => {
          photoMap[p._id] = p
        })
      }

      // Collect valid notes in order, skipping those with non-ACTIVE parent photos
      for (const note of notes) {
        if (photoMap[note.photo_id]) {
          validatedNotes.push(note)
          if (validatedNotes.length >= pageSize) break
        }
      }

      // Advance cursor anchor for the next batch
      if (notes.length > 0) {
        const last = notes[notes.length - 1]
        anchorValue = last[sortField]
        anchorId = last._id
      }
    }

    // Generate thumbnail URLs for returned notes
    await generateThumbnailUrls(validatedNotes)

    const hasMore = !exhausted
    let nextCursor = null
    if (hasMore && validatedNotes.length > 0) {
      const last = validatedNotes[validatedNotes.length - 1]
      nextCursor = encodeCursor(
        {
          ...binding,
          lastValue: last[sortField],
          lastId: last._id,
        },
        secret,
      )
    }

    return success({
      list: validatedNotes.map(projectNote),
      nextCursor,
      hasMore,
    })
  }

  return { add, update, delete: deleteNote, list }
}

module.exports = {
  createNoteHandlers,
  MAX_PAGE_SIZE,
  MAX_SCAN_MULTIPLIER,
}
