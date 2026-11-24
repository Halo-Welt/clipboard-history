const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, screen, nativeImage, Tray, Menu, shell, dialog, Notification, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const https = require('https');

// ============ 常量 ============
const HISTORY_VERSION = 2;
const MAX_HISTORY = 200;
const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 单条文本上限 2MB，超出部分截断
const THUMB_MAX = 480;                  // 缩略图最长边
const IMAGE_SCHEME = 'ch-image';
const POLL_INTERVAL = 700;
const GITHUB_REPO = 'Halo-Welt/clipboard-history';
const CURRENT_VERSION = app.getVersion();

// 渲染进程通过 ch-image:// 读取缩略图，必须在 app ready 之前注册
protocol.registerSchemesAsPrivileged([
  { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

// ============ 工具函数 ============
function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}
function hashText(text) {
  return 't:' + sha1(Buffer.from(text, 'utf8')).slice(0, 32);
}
function newId() {
  return crypto.randomUUID();
}

// ============ 本地存储：元数据 JSON + 图片独立文件 ============
// v1 的问题：图片 base64 存在 JSON 里（且 content/preview 存两遍），
// 每次变更全量同步写盘、写入非原子。v2 改为元数据 + 图片文件、原子写、可迁移。
class Store {
  constructor() {
    this.dir = null;
    this.filePath = null;
    this.imagesDir = null;
    this.cache = { version: HISTORY_VERSION, history: [], settings: {} };
    this.saveTimer = null;
  }

  init() {
    this.dir = app.getPath('userData');
    this.imagesDir = path.join(this.dir, 'images');
    fs.mkdirSync(this.imagesDir, { recursive: true });
    this.filePath = path.join(this.dir, 'clipboard-history.json');

    const raw = this.readJSON(this.filePath) || this.readJSON(this.filePath + '.bak');
    if (raw) {
      this.cache = Object.assign({ version: HISTORY_VERSION, history: [], settings: {} }, raw);
      if ((raw.version || 1) < HISTORY_VERSION) this.migrateFromV1();
    }
  }

  readJSON(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  // v1 → v2：把 base64 dataURL 抽成 images/*.png，条目只留元数据
  migrateFromV1() {
    let migrated = 0;
    const history = [];
    for (const item of this.cache.history || []) {
      if (item.type !== 'image') {
        history.push(Object.assign({}, item, {
          id: item.id || newId(),
          hash: item.hash || hashText(item.content || '')
        }));
        continue;
      }
      const dataUrl = item.content || item.preview || '';
      const m = /^data:image\/[a-z0-9+.-]+;base64,(.*)$/i.exec(dataUrl);
      if (!m) continue;
      try {
        const buf = Buffer.from(m[1], 'base64');
        const saved = saveImageFiles(buf);
        if (!saved) continue;
        migrated++;
        history.push({
          id: newId(),
          type: 'image',
          hash: sha1(buf),
          timestamp: item.timestamp || Date.now(),
          bytes: saved.bytes,
          width: saved.width,
          height: saved.height,
          file: saved.file,
          thumb: saved.thumb,
          preview: `${saved.width} × ${saved.height}`
        });
      } catch (e) {
        // 单条迁移失败不影响其它记录
      }
    }
    this.cache.history = history;
    this.cache.version = HISTORY_VERSION;
    this.save(true);
    if (migrated) console.log(`[store] migrated ${migrated} image(s) to v2`);
  }

  history() {
    return this.cache.history;
  }

  find(id) {
    return this.cache.history.find(x => x.id === id) || null;
  }

  // 同 hash 视为重复：挪到最前面并更新时间，不新增
  add(item) {
    const list = this.cache.history;
    const idx = list.findIndex(x => x.hash && x.hash === item.hash && x.type === item.type);
    if (idx >= 0) {
      const [dup] = list.splice(idx, 1);
      if (item.timestamp) dup.timestamp = item.timestamp;
      list.unshift(dup);
      this.save();
      return dup;
    }
    list.unshift(item);
    const overflow = list.length > MAX_HISTORY ? list.splice(MAX_HISTORY) : [];
    overflow.forEach(x => this.dropFiles(x));
    this.save();
    return item;
  }

  remove(id) {
    const list = this.cache.history;
    const idx = list.findIndex(x => x.id === id);
    if (idx < 0) return false;
    const [item] = list.splice(idx, 1);
    this.dropFiles(item);
    this.save();
    return true;
  }

  clear() {
    this.cache.history.forEach(x => this.dropFiles(x));
    this.cache.history = [];
    this.save();
  }

  dropFiles(item) {
    if (item.type !== 'image') return;
    for (const name of [item.file, item.thumb]) {
      if (!name) continue;
      try {
        fs.unlinkSync(path.join(this.imagesDir, name));
      } catch (e) {
        // 文件可能已经不在了
      }
    }
  }

  get(key, def) {
    return this.cache[key] !== undefined ? this.cache[key] : def;
  }

  set(key, value) {
    this.cache[key] = value;
    this.save();
  }

  // 合并 200ms 内的多次改动，避免频繁写盘
  save(immediate = false) {
    if (immediate) {
      this.flush();
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 200);
  }

  // 原子写：先写 .tmp 再 rename，旧文件留一份 .bak
  flush() {
    if (!this.filePath) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const tmp = this.filePath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.cache));
      try {
        fs.renameSync(this.filePath, this.filePath + '.bak');
      } catch (e) {
        // 第一次写入时没有旧文件
      }
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
  }
}

const store = new Store();

// 把图片 Buffer 写成 PNG + 缩略图，返回元数据
function saveImageFiles(buf) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (!width || !height) return null;

  const id = newId();
  const file = `${id}.png`;
  const thumb = `${id}.thumb.png`;
  fs.writeFileSync(path.join(store.imagesDir, file), buf);

  const scale = Math.min(1, THUMB_MAX / Math.max(width, height));
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));
  const thumbImg = scale < 1 ? img.resize({ width: tw, height: th, quality: 'good' }) : img;
  fs.writeFileSync(path.join(store.imagesDir, thumb), thumbImg.toPNG());

  return { file, thumb, width, height, bytes: buf.length };
}

// 传给渲染进程的字段（不含 base64 大图）
function publicItem(item) {
  return {
    id: item.id,
    type: item.type,
    timestamp: item.timestamp,
    preview: item.preview || '',
    content: item.type === 'text' ? (item.content || '') : undefined,
    length: item.length || 0,
    width: item.width || 0,
    height: item.height || 0,
    bytes: item.bytes || 0,
    thumbUrl: item.thumb ? `${IMAGE_SCHEME}://img/${encodeURIComponent(item.thumb)}` : ''
  };
}

// ============ 运行状态 ============
let mainWindow = null;
let tray = null;
let clipboardWatcher = null;
let previousAppName = null;
let lastTextHash = '';
let lastImageHash = '';

// ============ 窗口 ============
function currentDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function positionWindow() {
  if (!mainWindow) return;
  const area = currentDisplay().workArea;
  const [w, h] = mainWindow.getSize();
  const width = Math.min(w, area.width - 16);
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + area.height - h - 10);
  mainWindow.setBounds({ x, y, width, height: h });
}

function createWindow() {
  const area = currentDisplay().workArea;
  const winWidth = Math.min(area.width - 16, 1180);
  const winHeight = 300;

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: Math.round(area.x + (area.width - winWidth) / 2),
    y: Math.round(area.y + area.height - winHeight - 10),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    show: false,
    hasShadow: true,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on('blur', () => {
    if (mainWindow && mainWindow.isVisible()) hideWindow();
  });
}

// 记录呼出前的目标 App（异步执行，不阻塞主进程）
function captureFrontmostApp(callback) {
  exec(`osascript -e 'tell application "System Events" to name of first application process whose frontmost is true'`,
    { timeout: 800 },
    (err, stdout) => {
      if (!err) {
        const name = String(stdout || '').trim();
        if (name && name !== 'ClipboardHistory' && name !== 'Electron') {
          previousAppName = name;
        }
      }
      if (callback) callback();
    });
}

function sendHistory() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('clipboard-history', store.history().map(publicItem));
}

function showWindow() {
  if (!mainWindow) return;
  positionWindow();
  sendHistory();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('window-shown');
  captureFrontmostApp();
}

function hideWindow() {
  if (mainWindow) mainWindow.hide();
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
function addTextItem(text) {
  const truncated = Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES;
  const content = truncated
    ? Buffer.from(text, 'utf8').subarray(0, MAX_TEXT_BYTES).toString('utf8')
    : text;
  const item = {
    id: newId(),
    type: 'text',
    hash: hashText(content),
    content,
    preview: content.length > 200 ? content.slice(0, 200) : content,
    timestamp: Date.now(),
    length: text.length,
    truncated
  };
  const added = store.add(item);
  if (mainWindow && mainWindow.isVisible()) sendHistory();
  return added;
}

function addImageItem(buf) {
  const saved = saveImageFiles(buf);
  if (!saved) return null;
  const item = {
    id: newId(),
    type: 'image',
    hash: sha1(buf),
    timestamp: Date.now(),
    bytes: saved.bytes,
    width: saved.width,
    height: saved.height,
    file: saved.file,
    thumb: saved.thumb,
    preview: `${saved.width} × ${saved.height}`
  };
  const added = store.add(item);
  if (mainWindow && mainWindow.isVisible()) sendHistory();
  return added;
}

function clipboardHasImage(formats) {
  return formats.some(f =>
    f.startsWith('image/') || f === 'public.png' || f === 'public.tiff' || f === 'public.jpeg'
  );
}

// 轮询策略：
//   文本/格式读取几乎零成本，每个 tick 都读；
//   图片只在「剪贴板里有图且文本没变化」时用 readBuffer 取原始 PNG 再算 hash，
//   只有 hash 变了才解码（readImage+toDataURL 单次约 100ms，绝不能每 tick 调用）。
function startClipboardWatcher() {
  // 启动时只记录当前文本，避免把调用前就在剪贴板里的文字当成"新复制"；
  // 图片不做 seed：重复的图由 store.add 按 hash 去重并置顶，不会产生重复记录。
  const seed = clipboard.readText();
  lastTextHash = seed ? hashText(seed) : '';

  clipboardWatcher = setInterval(() => {
    try {
      const text = clipboard.readText();
      const textHash = text ? hashText(text) : '';

      if (textHash && textHash !== lastTextHash) {
        lastTextHash = textHash;
        addTextItem(text);
        return;
      }
      if (textHash) return; // 有文本时不再检查图片，避免影响文本复制

      const formats = clipboard.availableFormats() || [];
      if (!clipboardHasImage(formats)) return;

      const buf = clipboard.readBuffer('public.png');
      if (!buf || !buf.length) return;
      const hash = sha1(buf);
      if (hash === lastImageHash) return;
      lastImageHash = hash;
      addImageItem(buf);
    } catch (e) {
      console.error('Clipboard watch error:', e);
    }
  }, POLL_INTERVAL);
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
      store.clear();
      sendHistory();
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
function setupImageProtocol() {
  protocol.handle(IMAGE_SCHEME, (request) => {
    try {
      const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''));
      const safe = path.basename(name);
      if (!/^[A-Za-z0-9-]+(\.thumb)?\.png$/.test(safe)) {
        return new Response('Bad request', { status: 400 });
      }
      const data = fs.readFileSync(path.join(store.imagesDir, safe));
      return new Response(data, {
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store' }
      });
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  });
}

async function initApp() {
  store.init();
  setupImageProtocol();

  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.hide(); } catch (e) {}
  }

  createWindow();
  try { createTray(); } catch (e) { console.error('Tray failed:', e); }
  startClipboardWatcher();

  const ret = globalShortcut.register('Shift+Command+V', () => toggleWindow());
  if (!ret) console.error('快捷键注册失败');

  // 启动 5 秒后静默检查更新，之后每 6 小时一次
  setTimeout(() => checkForUpdates(true), 5000);
  setInterval(() => checkForUpdates(true), 6 * 60 * 60 * 1000);
}

// 只允许一个实例：两个实例会同时轮询剪贴板、同时写同一个历史文件
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(initApp);
}

// ============ IPC ============
function writeItemToClipboard(item) {
  if (!item) return false;
  if (item.type === 'text') {
    clipboard.writeText(item.content || '');
    lastTextHash = item.hash || hashText(item.content || '');
    return true;
  }
  try {
    const buf = fs.readFileSync(path.join(store.imagesDir, item.file));
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    lastImageHash = item.hash || sha1(buf);
    return true;
  } catch (e) {
    console.error('Image paste failed:', e.message);
    return false;
  }
}

// 把焦点切回呼出前的 App，再发 ⌘V
function pasteToPreviousApp() {
  const targetApp = previousAppName;
  setTimeout(() => {
    const quoted = targetApp ? targetApp.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : '';
    const script = targetApp
      ? `tell application "${quoted}" to activate\ndelay 0.05\ntell application "System Events" to keystroke "v" using command down`
      : `tell application "System Events" to keystroke "v" using command down`;
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
      if (err && targetApp) {
        // 目标 App 名字无法 activate 时退回直接发送 ⌘V
        exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
      }
    });
  }, 80);
}

ipcMain.on('paste-item', (event, id) => {
  const item = store.find(id);
  if (!item) return;
  if (!writeItemToClipboard(item)) return;
  hideWindow();
  pasteToPreviousApp();
});

ipcMain.on('copy-item', (event, id) => {
  const item = store.find(id);
  if (item) writeItemToClipboard(item);
});

ipcMain.on('delete-item', (event, id) => {
  if (store.remove(id)) sendHistory();
});

ipcMain.on('clear-history', () => {
  store.clear();
  sendHistory();
});

ipcMain.on('hide-window', () => {
  hideWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (clipboardWatcher) clearInterval(clipboardWatcher);
  store.flush();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});
