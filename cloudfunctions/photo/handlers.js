'use strict'

const { AppError, success } = require('./lib/shared/response')
const validation = require('./lib/shared/validation')
const { encodeCursor, decodeCursor, keysetCondition } =
  require('./lib/shared/cursor')

const MAX_PAGE_SIZE = 20
const TAG_MAX_SCAN_MULTIPLIER = 5

function createPhotoHandlers(deps) {
  const { db, getTempFileURL, cursorSecret, clock } = deps
  const _ = db.command

  function resolveSecret() {
    const secret =
      typeof cursorSecret === 'function' ? cursorSecret() : cursorSecret
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new AppError('INTERNAL_ERROR')
    }
    return secret
  }

  function cursorBinding(scope, tagId, sortBy, sortOrder) {
    return {
      resource: 'PHOTO',
      scope,
      tagId: tagId || null,
      sortBy,
      sortOrder,
    }
  }

  function projectCard(photo) {
    return {
      _id: photo._id,
      thumbnail_url: photo.thumbnail_url || '',
      width: photo.width,
      height: photo.height,
      shoot_time: photo.shoot_time,
      time_source: photo.time_source,
      upload_time: photo.upload_time,
      tag_count: photo.tag_count || 0,
    }
  }

  function projectDetail(photo, previewUrl) {
    return {
      _id: photo._id,
      width: photo.width,
      height: photo.height,
      format: photo.format,
      file_size: photo.file_size,
      shoot_time: photo.shoot_time,
      time_source: photo.time_source,
      upload_time: photo.upload_time,
      tag_count: photo.tag_count || 0,
      preview_url: previewUrl || '',
    }
  }

  function projectNote(note) {
    return {
      _id: note._id,
      content: note.content,
      created_at: note.created_at,
      updated_at: note.updated_at,
    }
  }

  function projectTag(tag) {
    return {
      _id: tag._id,
      name: tag.name,
      photo_count: tag.photo_count,
    }
  }

  async function generateThumbnailUrls(photos) {
    if (!photos || photos.length === 0) return
    const fileIds = photos.map((p) => p.file_id).filter(Boolean)
    if (fileIds.length === 0) {
      photos.forEach((p) => {
        p.thumbnail_url = ''
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
      photos.forEach((p) => {
        p.thumbnail_url = urlMap[p.file_id] || ''
      })
    } catch (_err) {
      photos.forEach((p) => {
        p.thumbnail_url = ''
      })
    }
  }

  // ============================================================
  // list
  // ============================================================

  /**
   * Build a base where clause and ordering for direct photo queries
   * (ALL / UNCATEGORIZED).
   */
  function photoBaseWhere(openid, scope) {
    const where = { _openid: openid, status: 'ACTIVE' }
    if (scope === 'UNCATEGORIZED') where.tag_count = 0
    return where
  }

  async function listPhotosDirect(
    openid, scope, pageSize, decoded, binding, secret,
  ) {
    const baseWhere = photoBaseWhere(openid, scope)

    let query
    if (decoded) {
      const cond = keysetCondition(
        _, 'upload_time', 'desc',
        decoded.lastValue, decoded.lastId,
      )
      query = db.collection('photos').where(_.and([baseWhere, cond]))
    } else {
      query = db.collection('photos').where(baseWhere)
    }
    query = query
      .orderBy('upload_time', 'desc')
      .orderBy('_id', 'desc')
      .limit(pageSize + 1)

    const result = await query.get()
    const photos = result.data || []
    const hasMore = photos.length > pageSize
    if (hasMore) photos.pop()

    await generateThumbnailUrls(photos)

    const list = photos.map(projectCard)
    let nextCursor = null
    if (hasMore && photos.length > 0) {
      const last = photos[photos.length - 1]
      nextCursor = encodeCursor(
        { ...binding, lastValue: last.upload_time, lastId: last._id },
        secret,
      )
    }

    return success({ list, nextCursor, hasMore })
  }

  async function listPhotosByTag(
    openid, tagId, pageSize, decoded, binding, secret,
  ) {
    // 1. Verify tag ownership
    const tagResult = await db.collection('tags')
      .where({ _id: tagId, _openid: openid })
      .limit(1)
      .get()
    if (!tagResult.data || tagResult.data.length === 0) {
      throw new AppError('TAG_NOT_FOUND')
    }

    const maxScan = pageSize * TAG_MAX_SCAN_MULTIPLIER
    const validatedPhotos = []
    const seenPhotoIds = new Set()
    let lastScannedRelation = null
    let scannedCount = 0
    let relationsExhausted = false

    // Cursor anchor from the previous request
    let anchorValue = decoded ? decoded.lastValue : null
    let anchorId = decoded ? decoded.lastId : null

    while (
      validatedPhotos.length < pageSize &&
      scannedCount < maxScan &&
      !relationsExhausted
    ) {
      const baseWhere = { _openid: openid, tag_id: tagId }

      let relQuery
      if (anchorValue !== null && anchorId !== null) {
        const cond = keysetCondition(
          _, 'photo_upload_time', 'desc',
          anchorValue, anchorId,
        )
        relQuery = db.collection('photo_tags').where(_.and([baseWhere, cond]))
      } else {
        relQuery = db.collection('photo_tags').where(baseWhere)
      }

      // Fetch one extra to detect whether more relations exist
      const needed = Math.min(pageSize, maxScan - scannedCount)
      const fetchLimit = needed + 1
      const relResult = await relQuery
        .orderBy('photo_upload_time', 'desc')
        .orderBy('_id', 'desc')
        .limit(fetchLimit)
        .get()

      const rawRelations = relResult.data || []
      if (rawRelations.length === 0) {
        relationsExhausted = true
        break
      }

      // If we got the extra item, there are more relations
      const hasMoreAfter = rawRelations.length === fetchLimit
      const relations = hasMoreAfter
        ? rawRelations.slice(0, needed)
        : rawRelations

      relationsExhausted = !hasMoreAfter

      scannedCount += relations.length

      // Batch-read the referenced photos (must be ACTIVE and owned)
      const photoIds = [
        ...new Set(relations.map((r) => r.photo_id).filter(Boolean)),
      ]
      const photoMap = {}
      if (photoIds.length > 0) {
        const photoResult = await db.collection('photos')
          .where({
            _openid: openid,
            status: 'ACTIVE',
            _id: _.in(photoIds),
          })
          .get()
        ;(photoResult.data || []).forEach((p) => {
          photoMap[p._id] = p
        })
      }

      // Walk relations in order; skip dirty references; collect valid photos
      for (const rel of relations) {
        lastScannedRelation = rel
        const photo = photoMap[rel.photo_id]
        if (photo && !seenPhotoIds.has(photo._id)) {
          seenPhotoIds.add(photo._id)
          validatedPhotos.push(photo)
          if (validatedPhotos.length >= pageSize) break
        }
      }

      // Advance the cursor anchor for the next batch
      if (relations.length > 0) {
        const lastRel = relations[relations.length - 1]
        anchorValue = lastRel.photo_upload_time
        anchorId = lastRel._id
      }
    }

    // Update tag last_used_at (best-effort)
    try {
      await db.collection('tags').doc(tagId).update({
        data: { last_used_at: db.serverDate() },
      })
    } catch (_err) {
      // Non-critical
    }

    await generateThumbnailUrls(validatedPhotos)

    const list = validatedPhotos.map(projectCard)
    const hasMore = !relationsExhausted
    let nextCursor = null
    if (hasMore && lastScannedRelation) {
      nextCursor = encodeCursor(
        {
          ...binding,
          lastValue: lastScannedRelation.photo_upload_time,
          lastId: lastScannedRelation._id,
        },
        secret,
      )
    }

    return success({ list, nextCursor, hasMore })
  }

  async function list(openid, event) {
    const scope = validation.enumValue(event.scope, [
      'ALL',
      'UNCATEGORIZED',
      'TAG',
    ])

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

    if (scope === 'TAG') {
      validation.string(event.tagId, { min: 1, max: 128 })
    }

    const secret = resolveSecret()
    const sortBy = scope === 'TAG' ? 'photo_upload_time' : 'upload_time'
    const sortOrder = 'desc'
    const binding = cursorBinding(scope, event.tagId, sortBy, sortOrder)

    let decoded = null
    if (event.cursor) {
      decoded = decodeCursor(event.cursor, binding, secret)
    }

    if (scope === 'ALL' || scope === 'UNCATEGORIZED') {
      return listPhotosDirect(
        openid, scope, pageSize, decoded, binding, secret,
      )
    }

    return listPhotosByTag(
      openid, event.tagId, pageSize, decoded, binding, secret,
    )
  }

  // ============================================================
  // detail
  // ============================================================
  async function detail(openid, event) {
    const photoId = validation.string(event.photoId, { min: 1, max: 128 })

    const photoResult = await db.collection('photos')
      .where({ _id: photoId, _openid: openid, status: 'ACTIVE' })
      .limit(1)
      .get()

    if (!photoResult.data || photoResult.data.length === 0) {
      throw new AppError('PHOTO_NOT_FOUND')
    }

    const photo = photoResult.data[0]

    // Generate preview URL (full, no CI processing)
    let previewUrl = ''
    if (photo.file_id) {
      try {
        const r = await getTempFileURL([photo.file_id])
        if (r.fileList && r.fileList[0] && r.fileList[0].tempFileURL) {
          previewUrl = r.fileList[0].tempFileURL
        }
      } catch (_err) {
        // Leave previewUrl empty
      }
    }

    // Load notes (latest first)
    const notesResult = await db.collection('notes')
      .where({ photo_id: photoId, _openid: openid })
      .orderBy('created_at', 'desc')
      .get()

    // Load tags (up to 5)
    const relResult = await db.collection('photo_tags')
      .where({ photo_id: photoId, _openid: openid })
      .limit(5)
      .get()

    let tags = []
    if (relResult.data && relResult.data.length > 0) {
      const tagIds = relResult.data.map((r) => r.tag_id)
      const tagResult = await db.collection('tags')
        .where({ _id: _.in(tagIds), _openid: openid })
        .get()
      tags = (tagResult.data || []).map(projectTag)
    }

    return success({
      photo: projectDetail(photo, previewUrl),
      notes: (notesResult.data || []).map(projectNote),
      tags,
    })
  }

  return { list, detail }
}

module.exports = {
  createPhotoHandlers,
  MAX_PAGE_SIZE,
  TAG_MAX_SCAN_MULTIPLIER,
}
