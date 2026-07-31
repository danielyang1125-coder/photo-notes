/**
 * 图片压缩模块
 *
 * 优先使用原生 wx.compressImage（可靠、高效），
 * 不可用时降级为 Canvas 离屏压缩（带超时保护）。
 *
 * 约束：
 *   - 最长边 ≤ 2560px
 *   - JPEG 质量 85% 起步
 *   - 目标文件大小 ≤ 3MB
 */

const C = require('./constants')

const COMPRESS_TIMEOUT_MS = 30000 // 30 秒超时

/**
 * 带超时的 Promise
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(label || '操作超时'))
    }, ms)
    promise
      .then((val) => { clearTimeout(timer); resolve(val) })
      .catch((err) => { clearTimeout(timer); reject(err) })
  })
}

/**
 * 使用原生 wx.compressImage 压缩（首选方案）
 *
 * 先获取原图尺寸，按长边等比计算目标宽高，确保竖屏图片压缩后
 * 两边都不超过 COMPRESS_MAX_EDGE。
 */
function compressNative(filePath) {
  return new Promise((resolve, reject) => {
    if (!wx.compressImage) {
      reject(new Error('API not available'))
      return
    }

    // 计算目标宽高（基于长边等比缩放）
    function calcTarget(info) {
      let targetW = info.width
      let targetH = info.height
      const maxEdge = C.COMPRESS_MAX_EDGE
      if (Math.max(info.width, info.height) > maxEdge) {
        if (info.width >= info.height) {
          targetW = maxEdge
          targetH = Math.round((info.height * maxEdge) / info.width)
        } else {
          targetH = maxEdge
          targetW = Math.round((info.width * maxEdge) / info.height)
        }
      }
      return { targetW, targetH }
    }

    // 执行压缩
    function doCompress(targetW, targetH) {
      wx.compressImage({
        src: filePath,
        quality: C.COMPRESS_INITIAL_QUALITY,
        compressedWidth: targetW,
        compressedHeight: targetH,
        success: (res) => {
          wx.getFileInfo({
            filePath: res.tempFilePath,
            success: (f) => {
              resolve({ path: res.tempFilePath, size: f.size })
            },
            fail: () => {
              // 即使无法获取文件信息，也返回压缩结果
              resolve({ path: res.tempFilePath, size: 0 })
            },
          })
        },
        fail: reject,
      })
    }

    wx.getImageInfo({
      src: filePath,
      success: (info) => {
        const { targetW, targetH } = calcTarget(info)
        doCompress(targetW, targetH)
      },
      fail: () => {
        // getImageInfo 失败时降级：宽高都设为上限，依赖 API 等比缩放
        doCompress(C.COMPRESS_MAX_EDGE, C.COMPRESS_MAX_EDGE)
      },
    })
  })
}

/**
 * Canvas 离屏压缩（降级方案，带超时保护）
 */
function compressCanvas(filePath) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: filePath,
      success: (info) => {
        let targetW = info.width
        let targetH = info.height
        const maxEdge = C.COMPRESS_MAX_EDGE

        if (Math.max(info.width, info.height) > maxEdge) {
          if (info.width >= info.height) {
            targetW = maxEdge
            targetH = Math.round((info.height * maxEdge) / info.width)
          } else {
            targetH = maxEdge
            targetW = Math.round((info.width * maxEdge) / info.height)
          }
        }

        // 原图已在限制内 → 检查文件大小是否达标
        if (info.width <= maxEdge && info.height <= maxEdge) {
          wx.getFileInfo({
            filePath,
            success: (f) => {
              if (f.size <= C.COMPRESS_TARGET_SIZE) {
                resolve({ path: filePath, size: f.size, width: info.width, height: info.height })
              } else {
                doCompressCanvas(filePath, targetW, targetH, C.COMPRESS_INITIAL_QUALITY, resolve, reject)
              }
            },
            fail: reject,
          })
        } else {
          doCompressCanvas(filePath, targetW, targetH, C.COMPRESS_INITIAL_QUALITY, resolve, reject)
        }
      },
      fail: reject,
    })
  })
}

/**
 * 单轮 Canvas 压缩（避免递归中重复加载原图）
 */
function doCompressCanvas(srcPath, w, h, quality, resolve, reject) {
  if (quality < C.COMPRESS_MIN_QUALITY) {
    // 已到最低质量，直接返回原图
    resolve({ path: srcPath, size: 0, width: w, height: h })
    return
  }

  const canvas = wx.createOffscreenCanvas({ type: '2d', width: w, height: h })
  if (!canvas) {
    reject(new Error('无法创建离屏画布'))
    return
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    reject(new Error('无法获取画布上下文'))
    return
  }

  const img = canvas.createImage()

  const cleanup = () => {
    img.onload = null
    img.onerror = null
  }

  img.onload = () => {
    try {
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      canvas.toDataURL({
        type: 'image/jpeg',
        quality: quality / 100,
        success: (res) => {
          cleanup()
          const base64 = res.data.replace(/^data:image\/\w+;base64,/, '')
          const tmpPath = wx.env.USER_DATA_PATH + '/compress_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.jpg'
          const fs = wx.getFileSystemManager()
          try {
            fs.writeFileSync(tmpPath, base64, 'base64')
            wx.getFileInfo({
              filePath: tmpPath,
              success: (f) => {
                if (f.size <= C.COMPRESS_TARGET_SIZE || quality <= C.COMPRESS_MIN_QUALITY) {
                  resolve({ path: tmpPath, size: f.size, width: w, height: h })
                } else {
                  // 当前质量仍超标，递减后重试
                  doCompressCanvas(tmpPath, w, h, quality - 15, resolve, reject)
                }
              },
              fail: reject,
            })
          } catch (e) {
            reject(e)
          }
        },
        fail: () => {
          cleanup()
          // toDataURL 失败，降质量重试
          doCompressCanvas(srcPath, w, h, quality - 15, resolve, reject)
        },
      })
    } catch (e) {
      cleanup()
      reject(e)
    }
  }

  img.onerror = () => {
    cleanup()
    reject(new Error('图片加载失败'))
  }

  img.src = srcPath
}

/**
 * 压缩图片 — 首选原生 API，降级 Canvas（均带超时保护）
 * @param {string} filePath - 本地临时路径
 * @returns {Promise<{path:string, size:number, width?:number, height?:number}>}
 */
async function compress(filePath) {
  try {
    // 优先尝试原生压缩
    const result = await withTimeout(
      compressNative(filePath),
      COMPRESS_TIMEOUT_MS,
      '原生压缩超时'
    )
    return result
  } catch (_nativeErr) {
    // 原生压缩不可用或超时 → 降级 Canvas 方案
    try {
      const result = await withTimeout(
        compressCanvas(filePath),
        COMPRESS_TIMEOUT_MS,
        'Canvas压缩超时'
      )
      return result
    } catch (canvasErr) {
      // 两种方案都失败 → 检查原图尺寸是否在服务端限制内
      console.warn('[compress] 压缩失败，检查原图尺寸:', canvasErr.message || canvasErr)
      try {
        const info = await new Promise((resolve, reject) => {
          wx.getImageInfo({ src: filePath, success: resolve, fail: reject })
        })
        if (Math.max(info.width, info.height) > C.COMPRESS_MAX_EDGE) {
          throw new Error('图片尺寸过大，压缩失败，请尝试更小的图片')
        }
        // 原图尺寸在限制内，直接上传
        return await new Promise((resolve, reject) => {
          wx.getFileInfo({
            filePath,
            success: (f) => resolve({ path: filePath, size: f.size }),
            fail: reject,
          })
        })
      } catch (dimErr) {
        throw new Error(dimErr.message || '图片压缩失败，请重试')
      }
    }
  }
}

module.exports = { compress }
