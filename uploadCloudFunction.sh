#!/bin/bash
# ============================================================
# 图片笔记小程序 — 云函数批量部署脚本
# ============================================================
# 使用前提：
#   1. 安装 @cloudbase/cli:  npm i -g @cloudbase/cli
#   2. 登录:                   tcb login
#   3. 选择环境:                tcb env:list
#
# 使用方式：
#   bash uploadCloudFunction.sh <envId>
#
# 示例：
#   bash uploadCloudFunction.sh cloud1-d0gsee3m13c2b446c
# ============================================================

set -e

ENV_ID="${1:-}"
if [ -z "$ENV_ID" ]; then
  echo "用法: bash uploadCloudFunction.sh <envId>"
  echo "示例: bash uploadCloudFunction.sh cloud1-d0gsee3m13c2b446c"
  exit 1
fi

PROJECT_PATH="$(cd "$(dirname "$0")" && pwd)"
CLOUD_FUNCTIONS_DIR="$PROJECT_PATH/cloudfunctions"

# 七个业务云函数
FUNCTIONS=("user" "photo" "note" "upload" "account" "tag" "cleanup")

echo "========================================="
echo "图片笔记小程序 — 云函数部署"
echo "目标环境: $ENV_ID"
echo "函数数量: ${#FUNCTIONS[@]}"
echo "========================================="

FAILED=()

for func in "${FUNCTIONS[@]}"; do
  echo ""
  echo "--- 部署 $func ---"
  func_path="$CLOUD_FUNCTIONS_DIR/$func"

  if [ ! -d "$func_path" ]; then
    echo "  ❌ 目录不存在: $func_path"
    FAILED+=("$func")
    continue
  fi

  if tcb fn deploy "$func" \
      --envId "$ENV_ID" \
      --path "$func_path" \
      --force 2>&1; then
    echo "  ✅ $func 部署成功"
  else
    echo "  ❌ $func 部署失败"
    FAILED+=("$func")
  fi
done

echo ""
echo "========================================="
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "✅ 全部 ${#FUNCTIONS[@]} 个云函数部署成功"
else
  echo "❌ ${#FAILED[@]} 个失败: ${FAILED[*]}"
fi
echo "========================================="
echo ""
echo "⚠️  部署后请确认："
echo "  1. 在云开发控制台 → 云函数 → 查看所有 7 个函数状态"
echo "  2. cleanup 的定时触发器已启用"
echo "  3. 运行 user/healthCheck 验证环境"
