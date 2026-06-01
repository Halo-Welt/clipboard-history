# Clipboard History · 剪贴板历史

> 一个为自己日常使用而做的 macOS 剪贴板历史小工具。已打包成原生 `.app`，**不需要终端常驻**。

![macOS](https://img.shields.io/badge/macOS-arm64-blue)
![Electron](https://img.shields.io/badge/Electron-28-47848F)
![License](https://img.shields.io/badge/License-MIT-green)

## ✨ 功能

- 🎯 全局快捷键 **⇧⌘V** 呼出 / 隐藏
- 📋 自动监听剪贴板（文本 + 图片），自动去重
- 🔍 关键字搜索
- ⌨️ 全键盘操作（← → 切换、Enter 粘贴、1-9 直选、Delete 删除、⌘F 搜索、Esc 关闭）
- 💾 持久化存储，最多 200 条
- ✨ 毛玻璃 vibrancy + 横向滑动卡片
- 🍎 隐藏 Dock 图标，仅菜单栏 📋 常驻
- 🔄 菜单栏可勾选「**开机自启动**」，一次配置永久生效

## 📦 安装

### 方式一：下载 Release（最简单，推荐）

前往 [Releases 页面](https://github.com/Halo-Welt/clipboard-history/releases) 下载最新的 `ClipboardHistory-arm64.zip`：

```bash
# 解压
unzip ClipboardHistory-arm64.zip

# 移动到应用程序文件夹
mv ClipboardHistory.app /Applications/

# 移除 quarantine 标记（让未签名 App 可以直接打开）
xattr -cr /Applications/ClipboardHistory.app

# 启动
open /Applications/ClipboardHistory.app
```

> ⚠️ 当前 Release 仅提供 **Apple Silicon (arm64)** 架构。Intel Mac 用户请使用方式二自行编译。

### 方式二：从源码编译

```bash
# 克隆仓库
git clone https://github.com/Halo-Welt/clipboard-history.git
cd clipboard-history

# 安装依赖
npm install

# 打包成 .app
npm run package

# 一键安装到 /Applications（含 quarantine 处理）
./install.sh
```

`install.sh` 会自动：
1. 把 `ClipboardHistory.app` 拷贝到 `/Applications/`
2. 移除 quarantine 标记，避免「无法验证开发者」拦截
3. 询问是否立即启动

之后从 **Launchpad** 或 **应用程序** 文件夹直接双击启动即可，无需任何终端依赖。

### 方式三：开发模式直接运行

```bash
git clone https://github.com/Halo-Welt/clipboard-history.git
cd clipboard-history
npm install
npm start
```

## 🔑 首次启动注意事项

1. **辅助功能权限**：模拟 ⌘V 自动粘贴需要"辅助功能"权限。
   - 系统设置 → 隐私与安全性 → 辅助功能 → 把 **ClipboardHistory** 打钩
   - 没打钩的话，点击卡片只会复制到剪贴板，不会自动粘贴到目标 App
2. **未签名应用**：本应用没有 Apple 开发者签名，第一次双击若提示"无法验证开发者"，请：
   - 右键应用 → 选择"打开" → 弹窗中点"打开"
   - 或运行 `xattr -cr /Applications/ClipboardHistory.app`（`install.sh` 已自动处理）

## ⌨️ 操作快捷键

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

## 🍎 菜单栏（点击 📋）

- 显示剪贴板历史 (⇧⌘V)
- 清空历史
- ☐ 开机自启动
- 关于
- 退出

## 📁 项目结构

```
.
├── main.js          # 主进程：快捷键、剪贴板监听、自启动、托盘
├── preload.js       # 预加载脚本（contextBridge）
├── index.html       # 渲染层入口（窗口加载的 HTML）
├── styles.css       # 毛玻璃 + 卡片样式
├── renderer.js      # 渲染层逻辑（搜索、键盘、卡片渲染）
├── build/
│   ├── icon.icns    # 应用图标
│   └── package.js   # 打包脚本（@electron/packager）
└── install.sh       # 一键安装到 /Applications
```

## 🔧 开发

```bash
npm start            # 开发模式启动（直接运行 electron .）
npm run package      # 打包生成 .app（输出到 dist/）
./install.sh         # 把 dist/ 中的 .app 安装到 /Applications
```

## 🛠 技术栈

- [Electron 28](https://www.electronjs.org/) — Chromium + Node 跨平台框架
- [@electron/packager](https://github.com/electron/packager) — 打包工具
- macOS vibrancy + `LSUIElement`（无 Dock 图标）
- 本地 JSON 持久化（`app.getPath('userData')`）
- `app.setLoginItemSettings` 实现开机自启

## 📝 说明

本仓库是作者为自用而开发的 macOS 小工具，仅供个人学习与日常使用。代码以 MIT 协议开源，欢迎自行编译使用，但请勿将构建产物用于商业分发。

## 📜 License

[MIT](./LICENSE) © 2026 liuxinyu
