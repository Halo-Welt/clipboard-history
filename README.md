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
- ⚡ **直接粘贴到目标 App**：选中卡片后自动把焦点切回原 App 并模拟 ⌘V
- 🚀 **应用内一键自动更新**：发现新版后下载、解压、替换、重启全自动完成，无需手动操作

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
- 检查更新...
- 当前版本：vX.Y.Z
- 关于
- 退出

## 🆕 自动更新机制（应用内一键完成 · 零打扰）

- 应用启动 5 秒后会**静默**向 GitHub Releases API 检查是否有新版本
- 之后每 6 小时复查一次
- **发现新版本时不会弹窗**，仅做两件低打扰提示：
  - 菜单栏 📋 标题加一个 `·` 红点提示
  - 点开菜单顶部多出 `🆕  立即更新到 vX.Y.Z` / 查看更新说明 / 跳过此版本 三个选项
- 用户主动点击「立即更新」后，才进入下载流程：
  - 显示进度条小窗（可拖动，毛玻璃风格）
  - **应用内自动下载、解压、替换、重启**，全程无需手动操作 ⚡
- 你也可以从菜单栏 📋 → **检查更新...** 手动触发；触发结果用 macOS 原生 toast 通知（右上角飞过），不打断当前工作

### 自动更新原理（针对未签名应用）

由于应用未走 Apple 开发者签名通道，无法用 Squirrel/electron-updater 的标准更新框架。本项目自实现了完整的应用内更新流程：

1. 调 GitHub Releases API 拿最新版本号 + zip 资产 URL
2. 下载到 `$TMPDIR`，带进度条窗口
3. `unzip` 解压，`xattr -cr` 移除 quarantine
4. 写一个 detached shell 脚本：
   - 等当前 App 进程退出（最多 30 秒）
   - 用 `ditto` 把新 `.app` 拷到 `/Applications/`
   - 原子替换旧版（先 mv 走再 mv 来）
   - `open` 启动新版
5. 当前 App 退出，脚本接力完成替换 → 自动启动新版

整个过程用户只需点一次「立即更新」按钮，30 秒后就在用新版本了。

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
