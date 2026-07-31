/**
 * EXIF 拍摄时间提取
 *
 * 从 JPEG/PNG 文件的 EXIF 段中解析 DateTimeOriginal (0x9003)，
 * 返回拍摄时间或 null。
 */

/**
 * @param {string} filePath - 本地临时文件路径
 * @returns {Promise<{shootTime: Date|null, timeSource: 'EXIF'|'UPLOAD_TIME'}>}
 */
function extractShootTime(filePath) {
  return new Promise((resolve) => {
    try {
      const fs = wx.getFileSystemManager()
      // 用 ArrayBuffer 读取（比 base64 内存效率高），parseExifDate 只扫描前 64KB
      const data = fs.readFileSync(filePath)
      const exifDate = parseExifDate(data)
      if (exifDate) {
        resolve({ shootTime: exifDate, timeSource: 'EXIF' })
      } else {
        resolve({ shootTime: null, timeSource: 'UPLOAD_TIME' })
      }
    } catch (e) {
      console.warn('[exif] 读取失败:', e.message)
      resolve({ shootTime: null, timeSource: 'UPLOAD_TIME' })
    }
  })
}

/**
 * 从二进制数据中解析 EXIF DateTimeOriginal
 */
function parseExifDate(buffer) {
  if (!buffer || buffer.length < 4) return null

  const arr = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer)

  // 扫描 EXIF 起始标记 "Exif\0\0"
  for (let i = 0; i < Math.min(arr.length - 10, 65536); i++) {
    if (
      arr[i] === 0x45 &&
      arr[i + 1] === 0x78 &&
      arr[i + 2] === 0x69 &&
      arr[i + 3] === 0x66
    ) {
      const tiffStart = i + 6
      if (tiffStart + 8 > arr.length) break

      const isLE = arr[tiffStart] === 0x49

      const read16 = (offset) => {
        const b0 = arr[tiffStart + offset]
        const b1 = arr[tiffStart + offset + 1]
        return isLE ? b0 + (b1 << 8) : (b0 << 8) + b1
      }

      const read32 = (offset) => {
        if (tiffStart + offset + 4 > arr.length) return 0
        const b = [
          arr[tiffStart + offset],
          arr[tiffStart + offset + 1],
          arr[tiffStart + offset + 2],
          arr[tiffStart + offset + 3],
        ]
        if (isLE) {
          return b[0] + (b[1] << 8) + (b[2] << 16) + (b[3] << 24)
        }
        return (b[0] << 24) + (b[1] << 16) + (b[2] << 8) + b[3]
      }

      try {
        if (read16(2) !== 0x002a) break

        let ifdOffset = read32(4)
        if (ifdOffset + 2 > arr.length - tiffStart) break

        const entryCount = read16(ifdOffset)
        for (let j = 0; j < Math.min(entryCount, 256); j++) {
          const entryPos = ifdOffset + 2 + j * 12
          if (entryPos + 12 > arr.length - tiffStart) break

          const tag = read16(entryPos)
          if (tag === 0x9003) {
            const valOff = read32(entryPos + 8)
            const strStart = tiffStart + (valOff <= 4 ? entryPos + 8 : valOff)
            let str = ''
            for (let k = 0; k < 20 && strStart + k < arr.length; k++) {
              if (arr[strStart + k] === 0) break
              str += String.fromCharCode(arr[strStart + k])
            }
            const m = str.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
            if (m) {
              return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
            }
            break
          }
        }
      } catch (_) {
        // EXIF 段解析异常，继续扫描
      }
      break
    }
  }
  return null
}

module.exports = { extractShootTime }
