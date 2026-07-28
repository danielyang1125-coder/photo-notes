/**
 * 数据库初始化脚本 — 图片笔记小程序 V1.0.0
 *
 * 用途：创建集合、创建索引、回填数据
 * 要求：可重复执行（幂等）
 *
 * 使用方式：
 *   1. 在腾讯云控制台获取 CAM 子账号的 SecretId 和 SecretKey
 *      https://console.cloud.tencent.com/cam/capi
 *   2. 设置环境变量：
 *      export CLOUDBASE_SECRET_ID=AKIDxxxxx
 *      export CLOUDBASE_SECRET_KEY=xxxxx
 *      export CLOUDBASE_ENV_ID=cloud1-d0gsee3m13c2b446c
 *   3. npm install @cloudbase/node-sdk
 *   4. node scripts/db-init.js
 *
 * 最小权限 CAM 策略：
 *   - cloudbase:CreateCollection
 *   - cloudbase:UpdateIndex
 *   - cloudbase:DescribeDatabase
 */

const cloudbase = require("@cloudbase/node-sdk");

// ============================================================
// 配置
// ============================================================

const ENV_ID = process.env.CLOUDBASE_ENV_ID || "cloud1-d0gsee3m13c2b446c";
const SECRET_ID = process.env.CLOUDBASE_SECRET_ID;
const SECRET_KEY = process.env.CLOUDBASE_SECRET_KEY;

if (!SECRET_ID || !SECRET_KEY) {
  console.error("❌ 请设置环境变量 CLOUDBASE_SECRET_ID 和 CLOUDBASE_SECRET_KEY");
  console.error("   获取地址：https://console.cloud.tencent.com/cam/capi");
  process.exit(1);
}

const app = cloudbase.init({
  env: ENV_ID,
  secretId: SECRET_ID,
  secretKey: SECRET_KEY,
});

const db = app.database();

// ============================================================
// 集合定义
// ============================================================

const COLLECTIONS = {
  users: {
    description: "用户",
    // 不需要 _openid 索引：CloudBase 内置索引 + _id = _openid 主键唯一
    indexes: [
      { name: "status_idx", keys: { status: 1 } },
    ],
  },

  photos: {
    description: "图片",
    indexes: [
      { name: "list_idx", keys: { _openid: 1, upload_time: -1 } },
      {
        name: "uncategorized_idx",
        keys: { _openid: 1, tag_count: 1, upload_time: -1 },
      },
      { name: "shoot_time_idx", keys: { _openid: 1, shoot_time: -1 } },
    ],
    preInit: async () => {
      // 回填：已有图片如果缺少 tag_count 字段，设为 0
      const _ = db.command;
      const result = await db
        .collection("photos")
        .where({ tag_count: _.exists(false) })
        .update({ tag_count: 0 });
      console.log(`  ↳ tag_count 回填: ${result.updated} 条`);
    },
  },

  notes: {
    description: "备注",
    indexes: [
      { name: "photo_idx", keys: { photo_id: 1 } },
      { name: "created_at_idx", keys: { _openid: 1, created_at: -1 } },
      { name: "shoot_time_idx", keys: { _openid: 1, photo_shoot_time: -1 } },
    ],
  },

  tags: {
    description: "标签",
    indexes: [
      {
        name: "name_unique",
        keys: { _openid: 1, normalized_name: 1 },
        unique: true,
      },
      {
        name: "list_idx",
        keys: {
          _openid: 1,
          last_used_at: -1,
          updated_at: -1,
          created_at: -1,
        },
      },
    ],
  },

  photo_tags: {
    description: "图片-标签关联",
    indexes: [
      {
        name: "relation_unique",
        keys: { _openid: 1, photo_id: 1, tag_id: 1 },
        unique: true,
      },
      {
        name: "tag_filter_idx",
        keys: { _openid: 1, tag_id: 1, photo_upload_time: -1 },
      },
      { name: "photo_relation_idx", keys: { _openid: 1, photo_id: 1 } },
    ],
  },

  deletion_tasks: {
    description: "删除任务",
    indexes: [
      { name: "user_status_idx", keys: { _openid: 1, status: 1 } },
      { name: "retry_idx", keys: { status: 1, retry_count: 1 } },
    ],
  },
};

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log(`\n🔧 初始化云开发环境: ${ENV_ID}\n`);

  const results = { created: [], indexes: { ok: [], skip: [], fail: [] } };

  for (const [name, config] of Object.entries(COLLECTIONS)) {
    console.log(`\n📦 ${name} (${config.description})`);

    // ---- 前置初始化 ----
    if (config.preInit) {
      await config.preInit();
    }

    // ---- 创建索引 ----
    for (const idx of config.indexes) {
      const label = `${name}.${idx.name}: ${JSON.stringify(idx.keys)}${idx.unique ? " UNIQUE" : ""}`;
      try {
        await db.collection(name).createIndex(idx.keys, {
          name: idx.name,
          unique: idx.unique || false,
        });
        console.log(`  ✅ ${label}`);
        results.indexes.ok.push(label);
      } catch (err) {
        // IndexAlreadyExists 视为幂等成功
        if (
          err.message?.includes("already exists") ||
          err.code === "ResourceConflict"
        ) {
          console.log(`  ⏭️  ${label}（已存在）`);
          results.indexes.skip.push(label);
        } else {
          console.error(`  ❌ ${label}\n     ${err.message || err}`);
          results.indexes.fail.push(label);
        }
      }
    }
  }

  // ---- 报告 ----
  console.log("\n" + "=".repeat(60));
  console.log("初始化报告");
  console.log("=".repeat(60));
  console.log(`✅ 索引创建/已存在: ${results.indexes.ok.length + results.indexes.skip.length}`);
  console.log(`❌ 索引创建失败:   ${results.indexes.fail.length}`);

  if (results.indexes.fail.length > 0) {
    console.log("\n失败清单：");
    results.indexes.fail.forEach((f) => console.log(`  - ${f}`));
  }

  console.log("\n⚠️  脚本只创建索引，不配置集合权限。");
  console.log("   请在云开发控制台 → 数据库 → 每个集合 → 权限设置，按以下配置：");
  console.log("   tags、photo_tags → 自定义规则 { read: false, write: false }");
  console.log("   其他四个集合 → 仅创建者可读写");
  console.log("   详见: docs/DATABASE-SETUP-CHECKLIST.md §2\n");
}

main().catch((err) => {
  console.error("\n❌ 初始化异常:", err.message || err);
  process.exit(2);
});
