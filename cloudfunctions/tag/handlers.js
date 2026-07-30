'use strict'

const { AppError, success } = require('./lib/shared/response')
const validation = require('./lib/shared/validation')
const { isUniqueConflict, withTransactionRetry } = require('./lib/shared/transaction')
const { findOwnedResource } = require('./lib/shared/auth')

const TAG_NAME_MAX = 12
const TAG_MAX_COUNT = 100
const PHOTO_TAG_MAX = 5
const QUICK_LIMIT = 5
const RESERVED = ['全部', '未分类']

// ============================================================
// 标签名称规范化（按严格顺序）
// ============================================================
function normalizeTagName(input) {
  // 1. Trim Unicode White_Space from both ends.
  //    Build a regex from code points to avoid embedding invisible characters
  //    directly in source: NBSP(U+00A0), OGHAM(U+1680), EN QUAD..HAIR SPACE
  //    (U+2000-U+200A), LINE SEP(U+2028), PARA SEP(U+2029), NNBSP(U+202F),
  //    MED MATH SPACE(U+205F), IDEOGRAPHIC SPACE(U+3000).
  var wsChars = '\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000'
  var wsTrimRe = new RegExp('^[' + wsChars + ']+|[' + wsChars + ']+$', 'g')
  var trimmed = (input || '').replace(wsTrimRe, '')

  // 2. Reject control characters (C0: U+0000-U+001F, DEL: U+007F, C1: U+0080-U+009F)
  var ccRe = new RegExp('[\\x00-\\x1F\\x7F\\u0080-\\u009F]')
  if (ccRe.test(trimmed)) {
    throw new AppError('TAG_NAME_INVALID')
  }

  // 3. Check Unicode code point length 1~12
  var codePointLength = [...trimmed].length
  if (codePointLength < 1 || codePointLength > TAG_NAME_MAX) {
    throw new AppError('TAG_NAME_INVALID')
  }

  // 4. Reject reserved names
  if (RESERVED.includes(trimmed)) {
    throw new AppError('TAG_NAME_INVALID')
  }

  // 5. NFC normalization
  var nfc = trimmed.normalize('NFC')

  // 6. Latin script lowercasing for normalized_name only
  var normalizedName = nfc.replace(/[A-Za-z]+/g, function (s) { return s.toLowerCase() })

  // 7. Return display name (NFC, original casing) and normalized name
  return { name: nfc, normalizedName: normalizedName }
}

// ============================================================
// 安全投影 — 不暴露 normalized_name、_openid
// ============================================================
function projectTagSummary(tag) {
  const t = tag || {}
  return {
    _id: t._id,
    name: t.name,
    photo_count: t.photo_count || 0,
    last_used_at: t.last_used_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  }
}

// ============================================================
// 工厂函数
// ============================================================
function createTagHandlers(deps) {
  const { db, reviewContent } = deps
  const _ = db.command

  // ==========================================================
  // list — QUICK（最近5个）| ALL（最多100个）
  // ==========================================================
  async function list(openid, event) {
    const mode = validation.enumValue(event.mode || 'ALL', ['ALL', 'QUICK'])
    const limit = mode === 'QUICK' ? QUICK_LIMIT : TAG_MAX_COUNT

    const result = await db.collection('tags')
      .where({ _openid: openid })
      .orderBy('last_used_at', 'desc')
      .orderBy('updated_at', 'desc')
      .orderBy('created_at', 'desc')
      .orderBy('_id', 'desc')
      .limit(limit)
      .get()

    const listData = (result.data || []).map(projectTagSummary)

    return success({ list: listData, total: listData.length })
  }

  // ==========================================================
  // create — 创建标签（修复 TAG-02：fail-closed 审核、事务防竞态）
  // ==========================================================
  async function create(openid, event) {
    const { name, normalizedName } = normalizeTagName(event.name)

    // 内容安全审核（fail-closed：异常一律抛错）
    await reviewContent(name, openid)

    try {
      const result = await withTransactionRetry(db, async (transaction) => {
        // 事务内检查数量上限（防竞态）
        const countResult = await transaction.collection('tags')
          .where({ _openid: openid })
          .count()
        if (countResult.total >= TAG_MAX_COUNT) {
          throw new AppError('TAG_LIMIT_REACHED')
        }

        const tagData = {
          _openid: openid,
          name,
          normalized_name: normalizedName,
          photo_count: 0,
          last_used_at: db.serverDate(),
          created_at: db.serverDate(),
          updated_at: db.serverDate(),
        }

        const addResult = await transaction.collection('tags').add({ data: tagData })
        return { _id: addResult._id, ...tagData }
      })

      return success({ tag: projectTagSummary(result) })
    } catch (e) {
      if (e instanceof AppError) throw e
      // 唯一索引冲突 → 重名
      if (isUniqueConflict(e)) {
        throw new AppError('TAG_NAME_DUPLICATED')
      }
      throw e
    }
  }

  // ==========================================================
  // rename — 重命名（修复 TAG-03、TAG-15）
  // ==========================================================
  async function rename(openid, event) {
    const tagId = validation.string(event.tagId, { min: 1, max: 128 })

    // 校验标签归属（不存在/他人 → TAG_NOT_FOUND）
    await findOwnedResource(
      db.collection('tags'),
      { _id: tagId, _openid: openid },
      'TAG_NOT_FOUND',
    )

    const { name: newName, normalizedName } = normalizeTagName(event.name)

    // 内容安全审核（fail-closed）
    await reviewContent(newName, openid)

    try {
      await withTransactionRetry(db, async (transaction) => {
        await transaction.collection('tags').doc(tagId).update({
          data: {
            name: newName,
            normalized_name: normalizedName,
            updated_at: db.serverDate(),
          },
        })
      })

      // 读取更新后的标签
      const updated = await db.collection('tags').doc(tagId).get()
      return success({ tag: projectTagSummary(updated.data) })
    } catch (e) {
      if (e instanceof AppError) throw e
      if (isUniqueConflict(e)) {
        throw new AppError('TAG_NAME_DUPLICATED')
      }
      throw e
    }
  }

  // ==========================================================
  // delete — 幂等删除（修复 TAG-04、TAG-15）
  // ==========================================================
  async function deleteTag(openid, event) {
    const tagId = validation.string(event.tagId, { min: 1, max: 128 })

    // 校验标签归属（不存在/他人 → TAG_NOT_FOUND）
    await findOwnedResource(
      db.collection('tags'),
      { _id: tagId, _openid: openid },
      'TAG_NOT_FOUND',
    )

    let removedRelationCount = 0

    await withTransactionRetry(db, async (transaction) => {
      // 收集所有 photo_tags 关系
      const relationsResult = await transaction.collection('photo_tags')
        .where({ _openid: openid, tag_id: tagId })
        .get()

      const relations = relationsResult.data || []

      // 逐个删除关系并递减 photo.tag_count
      for (const rel of relations) {
        await transaction.collection('photo_tags').doc(rel._id).remove()
        await transaction.collection('photos').doc(rel.photo_id).update({
          data: { tag_count: _.inc(-1) },
        })
        removedRelationCount++
      }

      // 删除标签
      await transaction.collection('tags').doc(tagId).remove()
    })

    return success({ deleted: true, removedRelationCount })
  }

  // ==========================================================
  // getPhotoTags — 单图标签（修复 TAG-06：先校验 ACTIVE photo）
  // ==========================================================
  async function getPhotoTags(openid, event) {
    const photoId = validation.string(event.photoId, { min: 1, max: 128 })

    // 先校验 photo 归属和 ACTIVE 状态
    await findOwnedResource(
      db.collection('photos'),
      { _id: photoId, _openid: openid, status: 'ACTIVE' },
      'PHOTO_NOT_FOUND',
    )

    // 查询 photo_tags
    const relationsResult = await db.collection('photo_tags')
      .where({ _openid: openid, photo_id: photoId })
      .get()

    const relations = relationsResult.data || []
    if (relations.length === 0) {
      return success({ tags: [] })
    }

    // Join tags
    const tagIds = relations.map((r) => r.tag_id)
    const tagsResult = await db.collection('tags')
      .where({ _id: _.in(tagIds), _openid: openid })
      .get()

    const tags = (tagsResult.data || []).map(projectTagSummary)

    return success({ tags })
  }

  // ==========================================================
  // updatePhotoTags — 单图增量关联（修复 TAG-07、TAG-11、TAG-12）
  // ==========================================================
  async function updatePhotoTags(openid, event) {
    const photoId = validation.string(event.photoId, { min: 1, max: 128 })
    const addTagIds = validation.array(event.addTagIds || [], {
      max: PHOTO_TAG_MAX,
      unique: true,
      item: (v) => validation.string(v, { min: 1, max: 128 }),
    })
    const removeTagIds = validation.array(event.removeTagIds || [], {
      max: PHOTO_TAG_MAX,
      unique: true,
      item: (v) => validation.string(v, { min: 1, max: 128 }),
    })

    // 校验 addTagIds 和 removeTagIds 无交叉
    const removeSet = new Set(removeTagIds)
    const overlap = addTagIds.filter((id) => removeSet.has(id))
    if (overlap.length > 0) {
      throw new AppError('VALIDATION_ERROR')
    }

    // 校验 photo 归属和 ACTIVE 状态
    const photo = await findOwnedResource(
      db.collection('photos'),
      { _id: photoId, _openid: openid, status: 'ACTIVE' },
      'PHOTO_NOT_FOUND',
    )

    // 校验所有涉及的 tagIds 归属
    const allTagIds = [...new Set([...addTagIds, ...removeTagIds])]
    if (allTagIds.length > 0) {
      const tagsResult = await db.collection('tags')
        .where({ _id: _.in(allTagIds), _openid: openid })
        .get()
      if ((tagsResult.data || []).length !== allTagIds.length) {
        throw new AppError('TAG_NOT_FOUND')
      }
    }

    // 事务内：读取当前集合 → 计算差异 → 写入
    await withTransactionRetry(db, async (transaction) => {
      // 事务内读取当前 photo_tags 集合
      const currentResult = await transaction.collection('photo_tags')
        .where({ _openid: openid, photo_id: photoId })
        .get()

      const currentTagIds = (currentResult.data || []).map((r) => r.tag_id)
      const currentSet = new Set(currentTagIds)

      // 计算 desired = (current - remove) ∪ add
      const desired = [
        ...new Set([
          ...currentTagIds.filter((id) => !removeSet.has(id)),
          ...addTagIds,
        ]),
      ]

      // 合并后超过 5 个 → 不写入
      if (desired.length > PHOTO_TAG_MAX) {
        throw new AppError('PHOTO_TAG_LIMIT_REACHED')
      }

      const desiredSet = new Set(desired)
      const toInsert = desired.filter((id) => !currentSet.has(id))
      const toDelete = currentTagIds.filter((id) => !desiredSet.has(id))

      // 空差异不执行写入
      if (toInsert.length === 0 && toDelete.length === 0) {
        return
      }

      // 处理删除
      for (const tagId of toDelete) {
        const rels = await transaction.collection('photo_tags')
          .where({ _openid: openid, photo_id: photoId, tag_id: tagId })
          .get()
        for (const rel of rels.data || []) {
          await transaction.collection('photo_tags').doc(rel._id).remove()
        }
        await transaction.collection('tags').doc(tagId).update({
          data: { photo_count: _.inc(-1) },
        })
      }

      // 处理新增
      for (const tagId of toInsert) {
        try {
          await transaction.collection('photo_tags').add({
            data: {
              _openid: openid,
              photo_id: photoId,
              tag_id: tagId,
              photo_upload_time: photo.upload_time || photo.created_at,
              created_at: db.serverDate(),
            },
          })
        } catch (e) {
          // 唯一索引冲突 → 幂等成功，不影响其他写入
          if (!isUniqueConflict(e)) throw e
        }
        await transaction.collection('tags').doc(tagId).update({
          data: { photo_count: _.inc(1), last_used_at: db.serverDate() },
        })
      }

      // 更新 photo.tag_count
      const delta = toInsert.length - toDelete.length
      if (delta !== 0) {
        await transaction.collection('photos').doc(photoId).update({
          data: { tag_count: _.inc(delta) },
        })
      }
    })

    // 事务后读取最新标签列表（用于确认最终状态）
    const finalRelations = await db.collection('photo_tags')
      .where({ _openid: openid, photo_id: photoId })
      .get()
    const finalTagIds = (finalRelations.data || []).map((r) => r.tag_id)

    let tags = []
    if (finalTagIds.length > 0) {
      const tagResult = await db.collection('tags')
        .where({ _id: _.in(finalTagIds), _openid: openid })
        .get()
      tags = (tagResult.data || []).map(projectTagSummary)
    }

    return success({ tags })
  }

  // ==========================================================
  // batchAddPhotoTags — 批量添加（修复 TAG-09、TAG-10）
  // ==========================================================
  async function batchAddPhotoTags(openid, event) {
    const photoIds = validation.array(event.photoIds || [], {
      min: 1,
      max: 20,
      unique: true,
      item: (v) => validation.string(v, { min: 1, max: 128 }),
    })
    const tagIds = validation.array(event.tagIds || [], {
      min: 1,
      max: PHOTO_TAG_MAX,
      unique: true,
      item: (v) => validation.string(v, { min: 1, max: 128 }),
    })
    // requestId 校验
    if (event.requestId !== undefined) {
      validation.requestId(event.requestId)
    }

    // 任一 tagId 无效/越权 → 整次拒绝
    const tagsResult = await db.collection('tags')
      .where({ _id: _.in(tagIds), _openid: openid })
      .get()
    if ((tagsResult.data || []).length !== tagIds.length) {
      throw new AppError('TAG_NOT_FOUND')
    }

    let successCount = 0
    let invalidCount = 0
    let limitExceededCount = 0
    const allFinalTagIds = new Set()

    // 逐图独立事务处理
    for (const photoId of photoIds) {
      // 校验 photo 归属和 ACTIVE 状态
      let photo
      try {
        photo = await findOwnedResource(
          db.collection('photos'),
          { _id: photoId, _openid: openid, status: 'ACTIVE' },
          'PHOTO_NOT_FOUND',
        )
      } catch (e) {
        if (e instanceof AppError && e.code === 'PHOTO_NOT_FOUND') {
          invalidCount++
          continue
        }
        throw e
      }

      let photoProcessed = false
      try {
        await withTransactionRetry(db, async (transaction) => {
          // 读取当前 photo_tags 集合
          const currentResult = await transaction.collection('photo_tags')
            .where({ _openid: openid, photo_id: photoId })
            .get()

          const currentTagIds = (currentResult.data || []).map((r) => r.tag_id)
          const currentSet = new Set(currentTagIds)

          // 计算 desired = current ∪ tagIds（合并）
          const desired = [...new Set([...currentTagIds, ...tagIds])]

          if (desired.length > PHOTO_TAG_MAX) {
            throw new AppError('PHOTO_TAG_LIMIT_REACHED')
          }

          const toInsert = desired.filter((id) => !currentSet.has(id))

          if (toInsert.length === 0) {
            // 所有标签已存在，幂等成功
            currentTagIds.forEach((id) => allFinalTagIds.add(id))
            return
          }

          let actualInserted = 0
          for (const tagId of toInsert) {
            try {
              await transaction.collection('photo_tags').add({
                data: {
                  _openid: openid,
                  photo_id: photoId,
                  tag_id: tagId,
                  photo_upload_time: photo.upload_time || photo.created_at,
                  created_at: db.serverDate(),
                },
              })
              actualInserted++
            } catch (e) {
              if (!isUniqueConflict(e)) throw e
              // 唯一冲突 → 幂等
            }
            await transaction.collection('tags').doc(tagId).update({
              data: { photo_count: _.inc(1), last_used_at: db.serverDate() },
            })
          }

          if (actualInserted > 0) {
            await transaction.collection('photos').doc(photoId).update({
              data: { tag_count: _.inc(actualInserted) },
            })
          }

          // 记录此 photo 最终标签（包括已存在的）
          const finalIds = [...new Set([...currentTagIds, ...toInsert])]
          finalIds.forEach((id) => allFinalTagIds.add(id))
        })

        successCount++
        photoProcessed = true
      } catch (e) {
        if (e instanceof AppError && e.code === 'PHOTO_TAG_LIMIT_REACHED') {
          limitExceededCount++
          photoProcessed = true
        } else {
          throw e
        }
      }

      // 如果事务因非预期原因失败，不应计入
      if (!photoProcessed) {
        invalidCount++
      }
    }

    // 返回最新标签摘要
    let tags = []
    if (allFinalTagIds.size > 0) {
      const tagsResult = await db.collection('tags')
        .where({ _id: _.in([...allFinalTagIds]), _openid: openid })
        .get()
      tags = (tagsResult.data || []).map(projectTagSummary)
    }

    return success({ successCount, invalidCount, limitExceededCount, tags })
  }

  return {
    list,
    create,
    rename,
    delete: deleteTag,
    getPhotoTags,
    updatePhotoTags,
    batchAddPhotoTags,
  }
}

module.exports = {
  createTagHandlers,
  normalizeTagName,
  projectTagSummary,
  TAG_NAME_MAX,
  TAG_MAX_COUNT,
  PHOTO_TAG_MAX,
  QUICK_LIMIT,
  RESERVED,
}
