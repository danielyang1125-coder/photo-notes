'use strict'

const crypto = require('crypto')
const { AppError } = require('./lib/shared/response')

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_EDGE = 2560
const REVIEW_MAX_EDGE = 750
const REVIEW_MAX_BYTES = 1024 * 1024
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

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

function createSharpImageProcessor(options = {}) {
  const sharpFactory = options.sharpFactory || require('sharp')

  return async function processImage(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || [])
    if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
      throw new AppError('UPLOAD_FILE_INVALID')
    }

    const magicFormat = detectMagic(buffer)
    try {
      const source = sharpFactory(buffer, {
        animated: true,
        failOn: 'error',
        limitInputPixels: MAX_IMAGE_EDGE * MAX_IMAGE_EDGE,
      })
      const metadata = await source.metadata()
      const decodedFormat = metadata.format === 'jpeg'
        ? 'JPEG'
        : metadata.format === 'png' ? 'PNG' : null
      if (decodedFormat !== magicFormat ||
          !Number.isInteger(metadata.width) ||
          !Number.isInteger(metadata.height) ||
          metadata.width < 1 ||
          metadata.height < 1 ||
          metadata.width > MAX_IMAGE_EDGE ||
          metadata.height > MAX_IMAGE_EDGE ||
          (metadata.pages || 1) !== 1) {
        throw new AppError('UPLOAD_FILE_INVALID')
      }

      let reviewBuffer
      for (const quality of [80, 65, 50, 35]) {
        reviewBuffer = await sharpFactory(buffer, {
          animated: false,
          failOn: 'error',
          limitInputPixels: MAX_IMAGE_EDGE * MAX_IMAGE_EDGE,
        })
          .rotate()
          .resize({
            width: REVIEW_MAX_EDGE,
            height: REVIEW_MAX_EDGE,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer()
        if (reviewBuffer.length <= REVIEW_MAX_BYTES) break
      }
      if (!reviewBuffer || reviewBuffer.length > REVIEW_MAX_BYTES) {
        throw new AppError('UPLOAD_FILE_INVALID')
      }

      return {
        buffer,
        reviewBuffer,
        contentType: 'image/jpeg',
        extension: decodedFormat === 'JPEG' ? 'jpg' : 'png',
        metadata: {
          file_size: buffer.length,
          width: metadata.width,
          height: metadata.height,
          format: decodedFormat,
          sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        },
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('UPLOAD_FILE_INVALID')
    }
  }
}

module.exports = {
  MAX_IMAGE_EDGE,
  MAX_UPLOAD_BYTES,
  REVIEW_MAX_BYTES,
  REVIEW_MAX_EDGE,
  createSharpImageProcessor,
  detectMagic,
}
