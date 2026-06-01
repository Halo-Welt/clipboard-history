#!/bin/bash
# 启动剪贴板历史应用
cd "$(dirname "$0")"
/Users/liuxinyutencent/.workbuddy/binaries/node/versions/22.22.2/bin/npx electron . > /tmp/clipboard-history.log 2>&1 &
echo "✓ 剪贴板历史应用已启动"
echo "  - 快捷键：⇧⌘V (Shift + Command + V)"
echo "  - 日志：/tmp/clipboard-history.log"
echo "  - 进程ID：$!"
