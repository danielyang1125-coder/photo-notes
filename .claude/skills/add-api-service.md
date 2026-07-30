---
name: add-api-service
description: Create or extend a frontend API service module wrapping wx.cloud.callFunction(). Triggers on "添加API", "封装云函数", "新增 service".
---

# Add API Service — 新建或扩展前端 API 服务

在 `miniprogram/services/` 中新建或扩展 API 封装文件，遵循项目统一的 `call()` 包装模式。

## 文件路径

`miniprogram/services/<name>.js`

每个 service 文件对应一个云函数。

## 模块结构模板

```javascript
/**
 * <服务描述>
 * 对应云函数: <cloudFunctionName>
 */

const NAME = 'cloudFunctionName'  // 云函数名，不是路径

function call(type, data = {}) {
  return wx.cloud.callFunction({
    name: NAME,
    data: { type, ...data }
  })
}

/**
 * 获取列表
 * @param {string} param1 - 参数说明
 * @param {number} param2 - 参数说明
 */
export function list(param1, param2) {
  return call('typeName', { param1, param2 })
}

/**
 * 创建
 * @param {string} name - 名称
 */
export function create(name) {
  return call('create', { name })
}

/**
 * 删除
 * @param {string} id - ID
 */
export function del(id) {
  return call('delete', { id })
}
```

## 关键约束

1. **`NAME` 常量**必须与云函数名完全一致（不是路径，只是函数名）
2. **`call()` 是私有辅助函数**，`type` 参数单独传入，其他数据通过 spread 合并
3. **每个导出函数对应一个 `event.type` 值**，参数名需与云函数期望的 event 字段一致
4. **使用 `export function`**，不使用 `module.exports`（项目现有 services 已迁移至此风格）
5. **错误不在 service 层处理**——让错误冒泡到页面/组件层
6. **复杂参数显式命名传递**（如 upload.confirm）

### 复杂参数示例（upload.js 风格）

```javascript
export function confirm({
  fileId,
  size,
  width,
  height,
  format,
  shootTime,
  timeSource,
  taskId
}) {
  return call('confirm', {
    fileId, size, width, height, format,
    shootTime, timeSource, taskId
  })
}
```

## 注意事项

- 不要在 service 之外直接调用 `wx.cloud.callFunction`
- 不要在 service 层吞掉错误（让调用方处理）
- 不要在 service 层做业务逻辑判断
- `type` 字段不要出现在调用方传入的 data 中（在 `call()` 中统一拼接）
- 每个 service 文件对应一个云函数，不要跨云函数混合

## 已有服务参考（从简到繁）

| 文件 | 云函数 | 操作数 | 特点 |
|------|--------|--------|------|
| `auth.js` | `user` | 4 | 最简单参考 |
| `photos.js` | `photo` | 3 | 标准模式 |
| `notes.js` | `note` | 4 | ES module 风格 |
| `tags.js` | `tag` | 7 | 复杂服务 + 批量操作 |
| `upload.js` | `upload` | 1 | 复杂参数展开模式 |

## 核心参考文件

- [services/photos.js](miniprogram/services/photos.js) — 标准 service 模板
- [services/tags.js](miniprogram/services/tags.js) — 复杂 service 示例
- [services/upload.js](miniprogram/services/upload.js) — 显式参数展开模式
