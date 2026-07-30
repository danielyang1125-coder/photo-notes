'use strict'

const crypto = require('crypto')
const { AppError } = require('./lib/shared/response')

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_EDGE = 2560

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

// ---------------------------------------------------------------------------
// Magic bytes — 不需要 sharp
// ---------------------------------------------------------------------------
function detectMagic(buffer) {
  if (buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff) {
    return 'JPEG'
  }
  if (buffer.length >= PNG_SIGNATURE.length &&
      buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'PNG'
  }
  throw new AppError('UPLOAD_FILE_INVALID')
}

// ---------------------------------------------------------------------------
// JPEG 尺寸解析（从 SOF 段读取，不需要 sharp）
// ---------------------------------------------------------------------------
function parseJpegDimensions(buffer) {
  let offset = 2
  const len = buffer.length
  while (offset < len) {
    if (buffer[offset] !== 0xff) throw new AppError('UPLOAD_FILE_INVALID')
    const marker = buffer[offset + 1]
    // SOF0 (0xC0) ~ SOF15 (0xCF), 不含 DHT(0xC4) 等
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 8 > len) throw new AppError('UPLOAD_FILE_INVALID')
      const height = buffer.readUInt16BE(offset + 5)
      const width = buffer.readUInt16BE(offset + 7)
      return { width, height }
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) {
      offset += 2
      continue
    }
    if (offset + 4 > len) throw new AppError('UPLOAD_FILE_INVALID')
    const segLen = buffer.readUInt16BE(offset + 2)
    if (segLen < 2 || offset + 2 + segLen > len) throw new AppError('UPLOAD_FILE_INVALID')
    offset += 2 + segLen
  }
  throw new AppError('UPLOAD_FILE_INVALID')
}

// ---------------------------------------------------------------------------
// PNG 尺寸解析（从 IHDR chunk 读取，不需要 sharp）
// ---------------------------------------------------------------------------
function parsePngDimensions(buffer) {
  // PNG: signature(8) + IHDR length(4) + "IHDR"(4) + width(4) + height(4)
  if (buffer.length < 24) throw new AppError('UPLOAD_FILE_INVALID')
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  return { width, height }
}

// ---------------------------------------------------------------------------
// 轻量图片处理器 — 纯 JS，零外部依赖
// ---------------------------------------------------------------------------
function createLightImageProcessor() {
  return async function processImage(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || [])

    // 1. 文件大小校验
    if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
      throw new AppError('UPLOAD_FILE_INVALID')
    }

    // 2. Magic bytes 校验 + 格式判定
    const format = detectMagic(buffer)

    // 3. 解析尺寸（纯 JS，无 native 依赖）
    let width, height
    try {
      if (format === 'JPEG') {
        const jpegDims = parseJpegDimensions(buffer)
        width = jpegDims.width
        height = jpegDims.height
      } else {
        const pngDims = parsePngDimensions(buffer)
        width = pngDims.width
        height = pngDims.height
      }
    } catch (_) {
      throw new AppError('UPLOAD_FILE_INVALID')
    }

    // 4. 尺寸校验
    if (width < 1 || height < 1 ||
        width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
      throw new AppError('UPLOAD_FILE_INVALID')
    }

    // 5. 原图直传（不做转换/压缩）
    return {
      buffer,                       // 原始 buffer，直接存到 active/
      reviewBuffer: buffer,         // 审核图 = 原图（CONTENT_REVIEW_ENABLED=false 时不调用审核）
      contentType: format === 'JPEG' ? 'image/jpeg' : 'image/png',
      extension: format === 'JPEG' ? 'jpg' : 'png',
      metadata: {
        file_size: buffer.length,
        width,
        height,
        format,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      },
    }
  }
}

module.exports = {
  MAX_IMAGE_EDGE,
  MAX_UPLOAD_BYTES,
  createLightImageProcessor,
  detectMagic,
  // 保留旧接口兼容
  createSharpImageProcessor: createLightImageProcessor,
}
