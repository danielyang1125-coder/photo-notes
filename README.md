# 图片笔记小程序

基于微信云开发的图片笔记小程序，支持图片上传、标签管理、备注记录。

## 技术栈

- **前端**：微信小程序原生框架
- **后端**：微信云开发（CloudBase）
- **云函数**：Node.js + wx-server-sdk ~3.0.4
- **部署环境**：`cloud1-d0gsee3m13c2b446c`（ap-shanghai）

## 项目结构

```text
├── miniprogram/          # 小程序前端
│   ├── pages/            # 页面
│   ├── components/       # 组件
│   └── services/         # API 服务层
├── cloudfunctions/       # 云函数
│   ├── user/             # 登录与用户状态
│   ├── upload/           # 图片上传
│   ├── photo/            # 图片列表/详情/删除
│   ├── note/             # 备注 CRUD
│   ├── tag/              # 标签管理
│   ├── account/          # 账号注销
│   └── cleanup/          # 定时清理
├── docs/                 # 文档
├── scripts/              # 后端脚本
└── test/                 # 测试
```

## 快速开始

```bash
# 安装根依赖
npm install

# 同步共享模块 + 运行检查
npm run backend:sync
npm run backend:check

# 运行测试
npm run backend:test
```

## 参考文档

- [云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)
- [前端 API 对接文档](docs/FRONTEND-API-INTEGRATION-V1.0.0.md)
- [技术架构文档](docs/TECHNICAL-ARCHITECTURE-图片笔记小程序-V1.0.0.md)
