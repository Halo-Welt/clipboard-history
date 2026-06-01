const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, screen, nativeImage, Tray, Menu, shell, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const https = require('https');

// ============ 简单的本地 JSON 存储 ============
class SimpleStore {
  constructor() {
    this.filePath = null;
    this.cache = { history: [], settings: {} };
  }
  init() {
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'clipboard-history.json');
    try {
      if (fs.existsSync(this.filePath)) {
        this.cache = Object.assign({ history: [], settings: {} }, JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
      }
    } catch (e) {
      this.cache = { history: [], settings: {} };
    }
  }
  get(key, def) {
    return this.cache[key] !== undefined ? this.cache[key] : def;
  }
  set(key, value) {
    this.cache[key] = value;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.cache));
    } catch (e) {
      console.error('Store save error:', e);
    }
  }
}

const store = new SimpleStore();

let mainWindow = null;
let tray = null;
let lastClipboardText = '';
let lastClipboardImage = '';
let clipboardWatcher = null;
let previousAppName = null; // 呼出前的目标 App 名称

const MAX_HISTORY = 200;
const GITHUB_REPO = 'Halo-Welt/clipboard-history';
const CURRENT_VERSION = app.getVersion();

// ============ 窗口 ============
function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const winHeight = 320;

  mainWindow = new BrowserWindow({
    width: screenWidth,
    height: winHeight,
    x: 0,
    y: screenHeight - winHeight + 25,
    frame: false,
    transparent: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    show: false,
    hasShadow: false,
    // ⭐ 关键：让 Electron 主窗口不偷焦点 —— 但激活快捷键时仍可接收输入
    // 我们通过 panel 风格控制，这样关闭后焦点回到原 App
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on('blur', () => {
    if (mainWindow && mainWindow.isVisible()) {
      hideWindow();
    }
  });
}

// ⭐ 获取当前最前台 App 的名称（用于粘贴前先把焦点切回去）
function captureFrontmostApp() {
  try {
    const out = execSync(`osascript -e 'tell application "System Events" to name of first application process whose frontmost is true'`, { timeout: 500 }).toString().trim();
    if (out && out !== 'ClipboardHistory' && out !== 'Electron') {
      previousAppName = out;
    }
  } catch (e) {
    // ignore
  }
}

function showWindow() {
  if (!mainWindow) return;
  // ⭐ 在显示窗口前，先捕获当前最前的 App
  captureFrontmostApp();

  const history = store.get('history', []);
  mainWindow.webContents.send('clipboard-history', history);
  mainWindow.show();
  mainWindow.focus();
}

function hideWindow() {
  if (mainWindow) {
    mainWindow.hide();
  }
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    hideWindow();
  } else {
    showWindow();
  }
}

// ============ 历史记录 ============
function addToHistory(item) {
  let history = store.get('history', []);
  history = history.filter(h => {
    if (item.type === 'text' && h.type === 'text') return h.content !== item.content;
    if (item.type === 'image' && h.type === 'image') return h.content !== item.content;
    return true;
  });
  history.unshift(item);
  if (history.length > MAX_HISTORY) {
    history = history.slice(0, MAX_HISTORY);
  }
  store.set('history', history);
  if (mainWindow && mainWindow.isVisible()) {
    mainWindow.webContents.send('clipboard-history', history);
  }
}

function startClipboardWatcher() {
  lastClipboardText = clipboard.readText();
  const img = clipboard.readImage();
  lastClipboardImage = img.isEmpty() ? '' : img.toDataURL();

  clipboardWatcher = setInterval(() => {
    try {
      const text = clipboard.readText();
      const image = clipboard.readImage();
      const imgData = image.isEmpty() ? '' : image.toDataURL();

      if (imgData && imgData !== lastClipboardImage) {
        lastClipboardImage = imgData;
        addToHistory({
          type: 'image',
          content: imgData,
          preview: imgData,
          timestamp: Date.now()
        });
      } else if (text && text !== lastClipboardText) {
        lastClipboardText = text;
        addToHistory({
          type: 'text',
          content: text,
          preview: text.length > 200 ? text.slice(0, 200) : text,
          timestamp: Date.now(),
          length: text.length
        });
      }
    } catch (e) {
      console.error('Clipboard watch error:', e);
    }
  }, 800);
}

// ============ 自动更新检查 ============
function compareVersion(a, b) {
  // a > b 返回 1; a < b 返回 -1; 相等 0
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      headers: {
        'User-Agent': 'ClipboardHistory-Updater',
        'Accept': 'application/vnd.github+json'
      },
      timeout: 8000
    };
    const req = https.get(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.tag_name) resolve(json);
          else reject(new Error('No tag_name in response'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// 待更新版本的元信息（被发现时缓存，菜单栏点击「立即更新」时使用）
let pendingUpdate = null;

async function checkForUpdates(silent = false) {
  try {
    const release = await fetchLatestRelease();
    const latestVersion = release.tag_name.replace(/^v/, '');
    const skipped = store.get('settings', {}).skipVersion;

    if (compareVersion(latestVersion, CURRENT_VERSION) > 0) {
      const asset = (release.assets || []).find(a => a.name && a.name.endsWith('.zip'));
      if (!asset) {
        if (!silent) {
          dialog.showMessageBox({ type: 'warning', title: '无可用安装包', message: `Release ${latestVersion} 中找不到 .zip 资产` });
        }
        return { hasUpdate: true, version: latestVersion };
      }

      // 缓存待更新信息，并刷新菜单栏（标题加红点 + 菜单顶部出现"立即更新到 vX.Y.Z"项）
      pendingUpdate = { version: latestVersion, release, asset };
      rebuildTrayMenu();

      // ⭐ 静默检查：仅在菜单栏标题前加红点提示，不弹窗、不发通知（避免打扰）
      if (silent) {
        // 用户已经跳过这个版本 → 连菜单红点也不显示
        if (skipped === latestVersion) {
          pendingUpdate = null;
          rebuildTrayMenu();
        }
        return { hasUpdate: true, version: latestVersion };
      }

      // 手动触发的「检查更新...」：静态系统通知（toast 风格，右上角飞过）
      if (Notification.isSupported()) {
        const n = new Notification({
          title: '剪贴板历史 · 发现新版本',
          body: `${CURRENT_VERSION} → ${latestVersion}    点击菜单栏 📋 → 立即更新到 v${latestVersion}`,
          silent: false
        });
        n.show();
      }
      return { hasUpdate: true, version: latestVersion };
    } else {
      pendingUpdate = null;
      rebuildTrayMenu();
      if (!silent) {
        // 手动检查时显示一条 toast 通知，不弹对话框
        if (Notification.isSupported()) {
          const n = new Notification({
            title: '剪贴板历史 · 已是最新版本',
            body: `当前 v${CURRENT_VERSION}`,
            silent: false
          });
          n.show();
        }
      }
      return { hasUpdate: false };
    }
  } catch (e) {
    if (!silent && Notification.isSupported()) {
      const n = new Notification({
        title: '剪贴板历史 · 检查更新失败',
        body: '无法连接到 GitHub，请稍后重试',
        silent: true
      });
      n.show();
    }
    console.error('Update check error:', e);
    return { hasUpdate: false, error: e.message };
  }
}

// ============ 应用内自动更新（下载 + 解压 + 接力替换 + 重启）============

// 创建一个进度窗口
let progressWindow = null;
function createProgressWindow() {
  progressWindow = new BrowserWindow({
    width: 460,
    height: 200,
    frame: false,
    transparent: true,
    vibrancy: 'under-window',
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  const html = `
    <!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { margin: 0; font-family: -apple-system, "PingFang SC"; color: #fff;
             height: 100vh; display: flex; flex-direction: column; justify-content: center;
             padding: 24px; background: rgba(20,20,22,0.6); -webkit-app-region: drag; }
      h2 { margin: 0 0 12px; font-size: 15px; font-weight: 600; }
      .status { font-size: 12px; opacity: 0.75; margin-bottom: 12px; min-height: 16px; }
      .bar { height: 6px; background: rgba(255,255,255,0.15); border-radius: 3px; overflow: hidden; }
      .fill { height: 100%; width: 0%; background: linear-gradient(90deg,#5f7dff,#a76cff); transition: width .15s; }
      .pct { font-size: 11px; opacity: 0.6; margin-top: 8px; text-align: right; }
    </style></head><body>
      <h2>正在更新 ClipboardHistory</h2>
      <div class="status" id="status">准备中...</div>
      <div class="bar"><div class="fill" id="fill"></div></div>
      <div class="pct" id="pct">0%</div>
      <script>
        const { ipcRenderer } = require('electron');
        // 由于 nodeIntegration 关闭，改用 window.message 接收
      </script>
    </body></html>
  `;
  progressWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return progressWindow;
}

function updateProgress(status, percent) {
  if (!progressWindow || progressWindow.isDestroyed()) return;
  progressWindow.webContents.executeJavaScript(`
    document.getElementById('status').textContent = ${JSON.stringify(status)};
    document.getElementById('fill').style.width = ${percent}+'%';
    document.getElementById('pct').textContent = Math.round(${percent})+'%';
  `).catch(() => {});
}

// 跟随重定向的 https 下载（GitHub assets 会重定向到 CDN）
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const get = (currentUrl, redirectsLeft = 5) => {
      const u = new URL(currentUrl);
      const opts = {
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { 'User-Agent': 'ClipboardHistory-Updater', 'Accept': 'application/octet-stream' }
      };
      const req = https.get(opts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          res.resume();
          return get(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const fileStream = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total) onProgress(received, total);
        });
        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(() => resolve(destPath)));
        fileStream.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('Download timeout')); });
    };
    get(url);
  });
}

async function performUpdate(zipUrl, newVersion) {
  const tmpDir = path.join(app.getPath('temp'), `clipboardhistory-update-${Date.now()}`);
  const zipPath = path.join(tmpDir, 'update.zip');
  const extractDir = path.join(tmpDir, 'extracted');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(extractDir, { recursive: true });

  // 显示进度窗口
  createProgressWindow();
  progressWindow.show();
  updateProgress('连接服务器...', 0);

  try {
    // 1. 下载
    await downloadFile(zipUrl, zipPath, (received, total) => {
      const mb = (received / 1024 / 1024).toFixed(1);
      const totalMb = (total / 1024 / 1024).toFixed(1);
      updateProgress(`下载中  ${mb} / ${totalMb} MB`, (received / total) * 60);
    });

    // 2. 解压
    updateProgress('解压安装包...', 65);
    await new Promise((resolve, reject) => {
      // macOS 自带的 ditto/unzip 解压
      exec(`/usr/bin/unzip -q -o "${zipPath}" -d "${extractDir}"`, { maxBuffer: 100 * 1024 * 1024 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    // 找到解压出的 .app
    const newAppPath = path.join(extractDir, 'ClipboardHistory.app');
    if (!fs.existsSync(newAppPath)) {
      throw new Error('解压后未找到 ClipboardHistory.app');
    }

    // 3. 移除 quarantine 标记
    updateProgress('准备替换...', 80);
    try { execSync(`/usr/bin/xattr -cr "${newAppPath}"`); } catch (e) {}

    // 4. 计算当前 .app 路径（从 main 进程的可执行文件反推）
    // app.getAppPath() => /Applications/ClipboardHistory.app/Contents/Resources/app.asar
    // process.execPath => /Applications/ClipboardHistory.app/Contents/MacOS/ClipboardHistory
    const currentAppPath = path.dirname(path.dirname(path.dirname(process.execPath))); // .app 根目录

    if (!currentAppPath.endsWith('.app')) {
      // 开发模式（electron .），不支持自动替换
      throw new Error('开发模式下不支持自动更新，请打包后再测试');
    }

    // 5. 写一个 shell 脚本：等当前进程退出后，rsync 替换并重启
    const scriptPath = path.join(tmpDir, 'apply-update.sh');
    const logPath = path.join(tmpDir, 'apply-update.log');
    const script = `#!/bin/bash
set -e
exec >> "${logPath}" 2>&1
echo "[$(date)] update script started, PID=${process.pid}"

# 等待主进程退出（最多 30 秒）
for i in $(seq 1 60); do
  if ! kill -0 ${process.pid} 2>/dev/null; then
    echo "main process exited"
    break
  fi
  sleep 0.5
done

# 即使 PID 还在也强制等一小会儿，让 macOS 释放文件锁
sleep 1

echo "replacing app: ${currentAppPath}"
# 用 ditto 完整覆盖（保留扩展属性、权限）
/usr/bin/ditto "${newAppPath}" "${currentAppPath}.new"

# 原子替换：先把旧的搬到 trash 临时目录
TRASH_DIR="/tmp/clipboardhistory-old-$(date +%s)"
mv "${currentAppPath}" "$TRASH_DIR" || true
mv "${currentAppPath}.new" "${currentAppPath}"
rm -rf "$TRASH_DIR" || true

# 移除 quarantine
/usr/bin/xattr -cr "${currentAppPath}" 2>/dev/null || true

echo "launching new version"
/usr/bin/open "${currentAppPath}"

# 清理
rm -rf "${tmpDir}" 2>/dev/null || true
echo "[$(date)] update done"
`;
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });

    updateProgress('准备应用更新...', 95);
    await new Promise(r => setTimeout(r, 400));

    updateProgress('正在重启应用...', 100);
    await new Promise(r => setTimeout(r, 500));

    // 6. 用 detached 子进程启动脚本，然后退出当前 App
    const { spawn } = require('child_process');
    const child = spawn('/bin/bash', [scriptPath], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    // 关闭进度窗口和应用
    if (progressWindow && !progressWindow.isDestroyed()) progressWindow.destroy();
    setTimeout(() => app.exit(0), 200);
  } catch (e) {
    if (progressWindow && !progressWindow.isDestroyed()) progressWindow.destroy();
    if (Notification.isSupported()) {
      const n = new Notification({
        title: '剪贴板历史 · 更新失败',
        body: e.message + '  点击查看详情',
        silent: false
      });
      n.on('click', () => shell.openExternal(`https://github.com/${GITHUB_REPO}/releases/latest`));
      n.show();
    }
    // 清理
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ============ 托盘 ============
function getTrayIcon() {
  // 加载真实图标（@2x @3x 由 nativeImage 自动选择，文件名匹配）
  const iconPath = path.join(__dirname, 'assets', 'trayTemplate.png');
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) {
    img = nativeImage.createEmpty();
  }
  if (process.platform === 'darwin') {
    img.setTemplateImage(true);
  }
  return img;
}

function createTray() {
  tray = new Tray(getTrayIcon());
  if (process.platform !== 'darwin') {
    tray.setToolTip('剪贴板历史');
  }
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const isAutoStart = app.getLoginItemSettings().openAtLogin;

  // 有待更新时：tray title 加红点提示（图标右侧附加文字 ·）
  if (process.platform === 'darwin') {
    tray.setTitle(pendingUpdate ? ' ·' : '');
  }

  const items = [];

  // 顶部：发现新版本时，显示"立即更新"项
  if (pendingUpdate) {
    items.push({
      label: `🆕  立即更新到 v${pendingUpdate.version}`,
      click: () => performUpdate(pendingUpdate.asset.browser_download_url, pendingUpdate.version)
    });
    items.push({
      label: '查看更新说明...',
      click: () => shell.openExternal(pendingUpdate.release.html_url)
    });
    items.push({
      label: '跳过此版本',
      click: () => {
        const settings = store.get('settings', {});
        settings.skipVersion = pendingUpdate.version;
        store.set('settings', settings);
        pendingUpdate = null;
        rebuildTrayMenu();
      }
    });
    items.push({ type: 'separator' });
  }

  items.push(
    { label: '显示剪贴板历史 (⇧⌘V)', click: () => showWindow() },
    { label: '清空历史', click: () => {
      store.set('history', []);
      if (mainWindow) mainWindow.webContents.send('clipboard-history', []);
    }},
    { type: 'separator' },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: isAutoStart,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
      }
    },
    { label: '检查更新...', click: () => checkForUpdates(false) },
    { type: 'separator' },
    { label: `当前版本：v${CURRENT_VERSION}`, enabled: false },
    { label: '关于 ClipboardHistory', click: () => {
      dialog.showMessageBox({
        type: 'info',
        title: '关于',
        message: 'ClipboardHistory · 剪贴板历史',
        detail: `版本：v${CURRENT_VERSION}\n一个自用的 macOS 剪贴板小工具\n快捷键 ⇧⌘V 呼出`
      });
    }},
    { label: '退出', click: () => app.quit() }
  );

  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ============ 启动 ============
app.whenReady().then(() => {
  store.init();

  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.hide(); } catch (e) {}
  }

  createWindow();
  try { createTray(); } catch (e) { console.error('Tray failed:', e); }
  startClipboardWatcher();

  const ret = globalShortcut.register('Shift+Command+V', () => {
    toggleWindow();
  });
  if (!ret) console.error('快捷键注册失败');

  // ⭐ 启动后 5s 静默检查更新
  setTimeout(() => checkForUpdates(true), 5000);
  // 每 6 小时检查一次
  setInterval(() => checkForUpdates(true), 6 * 60 * 60 * 1000);
});

// ============ IPC ============
ipcMain.on('paste-item', (event, item) => {
  // 1. 写入剪贴板
  if (item.type === 'text') {
    clipboard.writeText(item.content);
    lastClipboardText = item.content;
  } else if (item.type === 'image') {
    const img = nativeImage.createFromDataURL(item.content);
    clipboard.writeImage(img);
    lastClipboardImage = item.content;
  }

  // 2. 隐藏自己的窗口
  hideWindow();

  // 3. ⭐ 关键修复：把焦点切回之前的 App，再发送 ⌘V
  //    单纯 hide 不够，macOS 焦点不会自动回到上一个 App
  const targetApp = previousAppName;
  setTimeout(() => {
    if (targetApp) {
      // 用 osascript activate 目标 App，然后立刻发 ⌘V
      const script = `
        tell application "${targetApp.replace(/"/g, '\\"')}" to activate
        delay 0.05
        tell application "System Events" to keystroke "v" using command down
      `;
      exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
        if (err) {
          // 兜底：直接发 ⌘V
          exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
        }
      });
    } else {
      // 没捕获到目标 App，直接发 ⌘V（可能粘贴到 Finder 等）
      exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
    }
  }, 80);
});

ipcMain.on('delete-item', (event, timestamp) => {
  let history = store.get('history', []);
  history = history.filter(h => h.timestamp !== timestamp);
  store.set('history', history);
  if (mainWindow) mainWindow.webContents.send('clipboard-history', history);
});

ipcMain.on('clear-history', () => {
  store.set('history', []);
  if (mainWindow) mainWindow.webContents.send('clipboard-history', []);
});

ipcMain.on('hide-window', () => {
  hideWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (clipboardWatcher) clearInterval(clipboardWatcher);
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});
