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

async function checkForUpdates(silent = false) {
  try {
    const release = await fetchLatestRelease();
    const latestVersion = release.tag_name.replace(/^v/, '');
    const skipped = store.get('settings', {}).skipVersion;

    if (compareVersion(latestVersion, CURRENT_VERSION) > 0) {
      // 静默检查时，如果用户跳过过这个版本就不弹了
      if (silent && skipped === latestVersion) return { hasUpdate: true, version: latestVersion, release };

      // 弹对话框
      const asset = (release.assets || []).find(a => a.name && a.name.endsWith('.zip'));
      const downloadUrl = asset ? asset.browser_download_url : release.html_url;

      const result = await dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `ClipboardHistory ${latestVersion} 已发布`,
        detail: `当前版本：${CURRENT_VERSION}\n最新版本：${latestVersion}\n\n${release.name || ''}\n\n${(release.body || '').slice(0, 400)}`,
        buttons: ['立即下载', '查看详情', '跳过此版本', '稍后再说'],
        defaultId: 0,
        cancelId: 3
      });

      if (result.response === 0) {
        // 直接下载 zip
        shell.openExternal(downloadUrl);
      } else if (result.response === 1) {
        // 打开 release 页面
        shell.openExternal(release.html_url);
      } else if (result.response === 2) {
        // 跳过此版本
        const settings = store.get('settings', {});
        settings.skipVersion = latestVersion;
        store.set('settings', settings);
      }
      return { hasUpdate: true, version: latestVersion };
    } else {
      if (!silent) {
        await dialog.showMessageBox({
          type: 'info',
          title: '已是最新版本',
          message: `ClipboardHistory ${CURRENT_VERSION}`,
          detail: '您当前使用的已经是最新版本。'
        });
      }
      return { hasUpdate: false };
    }
  } catch (e) {
    if (!silent) {
      dialog.showMessageBox({
        type: 'error',
        title: '检查更新失败',
        message: '无法连接到 GitHub',
        detail: e.message + '\n\n请检查网络连接或稍后重试。'
      });
    }
    console.error('Update check error:', e);
    return { hasUpdate: false, error: e.message };
  }
}

// ============ 托盘 ============
function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  if (process.platform === 'darwin') {
    tray.setTitle('📋');
  } else {
    tray.setToolTip('剪贴板历史');
  }
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const isAutoStart = app.getLoginItemSettings().openAtLogin;
  const contextMenu = Menu.buildFromTemplate([
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
  ]);
  tray.setContextMenu(contextMenu);
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
