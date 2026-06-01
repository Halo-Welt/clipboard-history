#!/bin/bash
# 安装 ClipboardHistory.app 到 /Applications
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_SRC="$SCRIPT_DIR/dist/ClipboardHistory-darwin-arm64/ClipboardHistory.app"
APP_DST="/Applications/ClipboardHistory.app"

if [ ! -d "$APP_SRC" ]; then
  echo "✗ 应用未打包，先运行 npm run package"
  exit 1
fi

# 关闭已运行的进程
pkill -f "ClipboardHistory" 2>/dev/null || true
sleep 1

# 移除旧版本
if [ -d "$APP_DST" ]; then
  echo "→ 移除旧版本..."
  rm -rf "$APP_DST"
fi

# 复制
echo "→ 安装到 /Applications..."
cp -R "$APP_SRC" "$APP_DST"

# 移除 quarantine 标记（让首次启动不弹"未知开发者"提示）
xattr -cr "$APP_DST" 2>/dev/null || true

echo ""
echo "✓ 安装完成！"
echo "  路径：$APP_DST"
echo ""
echo "下一步："
echo "  1. 在 Launchpad 或 Applications 里双击启动 ClipboardHistory"
echo "  2. 首次启动会弹出辅助功能权限请求，请到「系统设置 → 隐私与安全性 → 辅助功能」打钩"
echo "  3. 启动后按 ⇧⌘V 呼出剪贴板历史"
echo "  4. 想开机自启：点击菜单栏的 📋 → 勾选「开机自启动」"
echo ""

# 直接打开
read -p "现在就启动应用？[Y/n] " ans
ans=${ans:-Y}
if [[ "$ans" =~ ^[Yy]$ ]]; then
  open "$APP_DST"
  echo "✓ 已启动，按 ⇧⌘V 试试看"
fi
