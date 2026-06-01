# Clipboard History · 剪贴板历史

一个仿 Paste 风格的 macOS 剪贴板历史 App，毛玻璃毛玻璃 + 横向卡片墙。已打包成原生 `.app`，**不需要终端常驻**。

## 🚀 一键安装（推荐）

```bash
cd /Users/liuxinyutencent/WorkBuddy/2026-06-01-13-01-50
./install.sh
```

脚本会：
1. 把 `ClipboardHistory.app` 拷贝到 `/Applications/`
2. 移除 quarantine 标记（避免「未知开发者」提示）
3. 询问是否立即启动

之后从 **Launchpad** 或 **应用程序** 文件夹直接双击启动，无需任何终端依赖。

## 功能

- 🎯 全局快捷键 **⇧⌘V** 呼出 / 隐藏
- 📋 自动监听剪贴板（文本 + 图片），自动去重
- 🔍 关键字搜索
- ⌨️ 全键盘操作（← → 切换、Enter 粘贴、1-9 直选、Delete 删除、⌘F 搜索、Esc 关闭）
- 💾 持久化存储，最多 200 条
- ✨ 毛玻璃 vibrancy + 横向滑动卡片
- 🍎 隐藏 Dock 图标，仅菜单栏 📋 常驻
- 🔄 **菜单栏可勾选「开机自启动」**，再也不用手动开了

## 首次启动注意事项

1. **辅助功能权限**：模拟 ⌘V 自动粘贴需要"辅助功能"权限。
   - 系统设置 → 隐私与安全性 → 辅助功能 → 把 **ClipboardHistory** 打钩
   - 没打钩的话，点击卡片只会复制到剪贴板，不会自动粘贴到目标 App
2. **未签名应用**：因为没花苹果开发者账号 99 美元，第一次双击如果提示"无法验证开发者"，请：
   - 右键应用 → 选择"打开" → 弹窗中点"打开"
   - 或者运行 `xattr -cr /Applications/ClipboardHistory.app`（install.sh 已自动做了）

## 操作快捷键

| 按键 | 作用 |
|------|------|
| ⇧⌘V | 显示 / 隐藏窗口 |
| ← / → | 选择卡片 |
| Enter | 粘贴选中项 |
| 1-9 | 直接粘贴对应序号 |
| Delete / Backspace | 删除选中项 |
| ⌘F 或 / | 聚焦搜索框 |
| Esc | 关闭窗口 |
| 右键卡片 | 删除该项 |

## 菜单栏（点击 📋）

- 显示剪贴板历史 (⇧⌘V)
- 清空历史
- ☐ 开机自启动
- 关于
- 退出

## 项目结构

```
.
├── main.js          # 主进程：快捷键、剪贴板监听、自启动、托盘
├── preload.js       # 预加载脚本（contextBridge）
├── index.html       # 渲染层入口
├── styles.css       # 毛玻璃 + 卡片样式
├── renderer.js      # 渲染层逻辑（搜索、键盘、卡片渲染）
├── build/
│   ├── icon.icns    # 应用图标
│   └── package.js   # 打包脚本
├── install.sh       # 一键安装到 /Applications
└── dist/
    └── ClipboardHistory-darwin-arm64/
        └── ClipboardHistory.app   # 打包好的 App
```

## 自己改完重新打包

```bash
npm run package    # 重新生成 dist/ 下的 .app
./install.sh       # 重新安装到 /Applications
```

## 技术栈

- Electron 28（Chromium + Node）
- @electron/packager 打包
- macOS vibrancy + LSUIElement（无 Dock 图标）
- 本地 JSON 持久化（avoid Library 沙箱写入问题）
- 自启动通过 `app.setLoginItemSettings`，菜单栏切换
