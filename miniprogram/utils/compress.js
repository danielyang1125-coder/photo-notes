/**
 * 图片压缩模块 — Canvas 离屏压缩
 *
 * 约束：
 *   - 最长边 ≤ 2560px
 *   - JPEG 质量 85% 起步
 *   - 目标文件大小 ≤ 3MB
 *   - 最低质量不低于 30%
 */
const C = require('./constants')

/**
 * 压缩图片
 * @param {string} filePath - 本地临时路径
 * @returns {Promise<{path:string, size:number, width:number, height:number}>}
 */
function compress(filePath) {
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

        // 原图已达标则跳过压缩
        if (info.width <= maxEdge && info.height <= maxEdge) {
          wx.getFileInfo({
            filePath,
            success: (f) => {
              if (f.size <= C.COMPRESS_TARGET_SIZE) {
                resolve({ path: filePath, size: f.size, width: info.width, height: info.height })
              } else {
                doCompress(filePath, targetW, targetH, C.COMPRESS_INITIAL_QUALITY, resolve, reject)
              }
            },
            fail: reject,
          })
        } else {
          doCompress(filePath, targetW, targetH, C.COMPRESS_INITIAL_QUALITY, resolve, reject)
        }
      },
      fail: reject,
    })
  })
}

function doCompress(srcPath, w, h, quality, resolve, reject) {
  const canvas = wx.createOffscreenCanvas({ type: '2d', width: w, height: h })
  const ctx = canvas.getContext('2d')
  const img = canvas.createImage()

  img.onload = () => {
    ctx.drawImage(img, 0, 0, w, h)
    canvas.toDataURL({
      type: 'image/jpeg',
      quality: quality / 100,
      success: (res) => {
        const base64 = res.data.replace(/^data:image\/\w+;base64,/, '')
        const fs = wx.getFileSystemManager()
        const tmpPath = wx.env.USER_DATA_PATH + '/compress_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.jpg'
        try {
          fs.writeFileSync(tmpPath, base64, 'base64')
          wx.getFileInfo({
            filePath: tmpPath,
            success: (f) => {
              if (f.size <= C.COMPRESS_TARGET_SIZE || quality <= C.COMPRESS_MIN_QUALITY + 5) {
                resolve({ path: tmpPath, size: f.size, width: w, height: h })
              } else {
                const nextQ = Math.max(quality - 15, C.COMPRESS_MIN_QUALITY)
                doCompress(srcPath, w, h, nextQ, resolve, reject)
              }
            },
            fail: reject,
          })
        } catch (e) {
          reject(e)
        }
      },
      fail: () => {
        if (quality > C.COMPRESS_MIN_QUALITY) {
          doCompress(srcPath, w, h, quality - 15, resolve, reject)
        } else {
          reject(new Error('压缩失败'))
        }
      },
    })
  }
  img.onerror = () => reject(new Error('图片加载失败'))
  img.src = srcPath
}

module.exports = { compress }
