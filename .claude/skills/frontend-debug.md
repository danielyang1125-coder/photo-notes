---
name: frontend-debug
description: Systematic debugging guidance for common frontend issues in this WeChat Mini Program project. Triggers on "前端报错", "页面不显示", "排查", "frontend debug".
---

# Frontend Debug — 前端问题排查

项目特定的前端问题排查指南。

## 1. 过期状态 / UI 不更新

**症状**：数据加载后页面不渲染，或显示旧数据

**排查顺序**：
1. 检查 `_isCurrent()` 模式 — 响应到达前页面状态可能已被重置
2. 检查 `_queryVersion` 递增 — 版本不匹配时响应被丢弃
3. 检查 `_batchGeneration`（upload-panel） — 取消后回调仍执行
4. 检查 `setData()` 调用的对象 — 可能捕获了过期变量

## 2. 自定义导航栏异常

**症状**：导航栏高度不对、内容被遮挡

**排查顺序**：
1. `_initNavigation()` 是否在 `onLoad` 中调用
2. 验证 `statusBarHeight`、`navBarHeight`、`navTotalHeight`、`settingsRight` 值
3. `wx.getMenuButtonBoundingClientRect()` 不同设备返回值不同
4. `<view class="nav-fixed">` 是否使用了正确的 style 绑定

## 3. 云函数调用静默失败

**症状**：操作无响应、无错误提示

**排查顺序**：
1. 检查响应结构：`res.result.code`、`res.result.data`
2. 检查 service 中 `NAME` 常量是否与云函数名完全一致
3. 检查 `event.type` 是否在云函数 handlers 中注册
4. 在 WeChat DevTools 或云控制台查看云函数日志
5. 对照 `PUBLIC_MESSAGES` 查看错误码含义

## 4. 跨页刷新不生效

**症状**：从子页面返回后列表未更新

**排查顺序**：
1. 验证 `app.globalData.refreshPhotos/refreshNotes/refreshTags` 是否正确设置
2. 在目标页 `onShow()` 中断点确认标记是否被正确检测
3. 注意：标记是 boolean 型，非计数器（快速多次变化可能丢失）
4. `photoListChange` 对象需要包含完整字段：`{photoId, changeType, tagIds?, noteCount?}`

## 5. 上传管线失败

**症状**：图片上传卡住或报错

**排查顺序**：
- **格式/大小**：检查是否在 `UPLOAD_ALLOWED_FORMATS` 和 `UPLOAD_MAX_SIZE` 范围内
- **压缩**：Canvas 离屏 API 在某些设备不可用 — `wx.createOffscreenCanvas` 可用性
- **确认**：`uploadService.confirm` 参数名是否匹配云函数期望
- **错误码**：`SPACE_EXCEEDED`（配额不足）、`CONTENT_REVIEW_FAILED`（审核不通过）、`UPLOAD_FILE_INVALID`（文件损坏）
- **并发**：检查 `UPLOAD_CONCURRENCY = 3`，是否超限
- **云存储**：临时 URL 默认 2h 过期，超时重新获取

## 6. 滚动位置丢失（Tab 切换）

**症状**：Tab 切换后回到顶部

**排查顺序**：
1. scroll-view 使用 `scroll-top="{{scrollTop}}"` 绑定
2. `handleScroll` 中保存 `_currentScrollTop`
3. 重新渲染前恢复 scrollTop

## 7. 瀑布流布局异常

**症状**：图片卡片宽度/高度不对

**排查顺序**：
1. `_splitToColumns`：交替最短列分配算法
2. `_cardHeight`：`height/width * 340`，clamp `[180, 560]`
3. 列表变化时重新计算列高

## 8. 通用调试技巧

- 使用 `console.warn` 代替 `console.log` 在 DevTools 中更显眼
- `wx.getSystemInfoSync()` 查看设备信息
- 验证 TDesign 组件版本匹配
- WeChat DevTools → Cloud Console 查看云函数日志
- 检查 `project.config.json` 中 `miniprogramRoot` 和 `cloudfunctionRoot` 路径是否正确

## 关键文件

- [services/](miniprogram/services/) — API 调用层
- [utils/constants.js](miniprogram/utils/constants.js) — 所有常量
- [cloudfunctions/_shared/response.js](cloudfunctions/_shared/response.js) — `PUBLIC_MESSAGES` 错误码定义
