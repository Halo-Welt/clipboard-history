const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, screen, nativeImage, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// 简单的本地 JSON 存储，避开 electron-store 在某些环境下的目录权限问题
class SimpleStore {
  constructor() {
    this.filePath = null;
    this.cache = { history: [] };
  }
  init() {
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'clipboard-history.json');
    try {
      if (fs.existsSync(this.filePath)) {
        this.cache = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (e) {
      this.cache = { history: [] };
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

const MAX_HISTORY = 200;

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

function showWindow() {
  if (!mainWindow) return;
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

function addToHistory(item) {
  let history = store.get('history', []);
  // remove duplicate
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

function createTray() {
  // 使用一个简单的 16x16 透明图标（macOS会显示标题文字）
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  if (process.platform === 'darwin') {
    tray.setTitle('📋');
  } else {
    tray.setToolTip('剪贴板历史');
  }
  const isAutoStart = app.getLoginItemSettings().openAtLogin;
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示剪贴板历史 (⇧⌘V)', click: () => showWindow() },
    { label: '清空历史', click: () => { store.set('history', []); if (mainWindow) mainWindow.webContents.send('clipboard-history', []); } },
    { type: 'separator' },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: isAutoStart,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
      }
    },
    { type: 'separator' },
    { label: '关于 ClipboardHistory', click: () => {
      const { dialog } = require('electron');
      dialog.showMessageBox({
        type: 'info',
        title: '关于',
        message: 'ClipboardHistory · 剪贴板历史',
        detail: '一个自用的 macOS 剪贴板小工具\n快捷键 ⇧⌘V 呼出'
      });
    }},
    { label: '退出', click: () => app.quit() }
  ]);
  tray.setContextMenu(contextMenu);
}

app.whenReady().then(() => {
  store.init();

  // macOS 隐藏 Dock 图标
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.hide(); } catch (e) {}
  }

  createWindow();
  try { createTray(); } catch (e) { console.error('Tray failed:', e); }
  startClipboardWatcher();

  const ret = globalShortcut.register('Shift+Command+V', () => {
    toggleWindow();
  });

  if (!ret) {
    console.error('快捷键注册失败');
  }
});

ipcMain.on('paste-item', (event, item) => {
  if (item.type === 'text') {
    clipboard.writeText(item.content);
    lastClipboardText = item.content;
  } else if (item.type === 'image') {
    const img = nativeImage.createFromDataURL(item.content);
    clipboard.writeImage(img);
    lastClipboardImage = item.content;
  }
  hideWindow();
  // 模拟粘贴 ⌘V
  setTimeout(() => {
    const { exec } = require('child_process');
    exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
  }, 100);
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
