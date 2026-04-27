#!/usr/bin/env bash
# 完整一次抓取 + 渲染 + 提交流程
# 用法: bash scripts/run.sh
set -e
cd "$(dirname "$0")/.."

# 使用沙箱预装浏览器（/opt/pw-browsers），避免重复下载
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"

echo "==> 安装依赖（如需要）"
if [ ! -d node_modules ]; then
  npm install --silent
fi

echo "==> 抓取价格"
PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" node scripts/fetch.mjs

echo "==> 注入 index.html"
node scripts/render.mjs

echo "==> 提交"
git config user.email "bot@wwei.ai" 2>/dev/null || true
git config user.name "pvg-jhg-bot" 2>/dev/null || true
git add data/ index.html package.json package-lock.json 2>/dev/null || git add data/ index.html
TZ=Asia/Shanghai NOW=$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M')
git commit -m "价格更新 ${NOW}" || { echo "无改动可提交"; exit 0; }
git push
echo "==> 完成"
