const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, screen, nativeImage, Tray, Menu, shell, dialog, Notification, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec, execFileSync } = require('child_process');
const https = require('https');

// ============ 常量 ============
const HISTORY_VERSION = 2;
const MAX_HISTORY = 200;
const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 单条文本上限 2MB，超出部分截断
const THUMB_MAX = 480;                  // 缩略图最长边
// 从旧名字（package.json 的 name: clipboard-history）迁移 userData，
// 否则改名后历史记录看起来"消失"了。
function migrateLegacyUserData() {
  try {
    const legacy = path.join(app.getPath('appData'), 'clipboard-history');
    const target = app.getPath('userData');
    if (path.resolve(legacy) === path.resolve(target)) return;
    if (!fs.existsSync(legacy)) return;

    const targetImages = path.join(target, 'images');
    const targetHasImages = fs.existsSync(targetImages) && fs.readdirSync(targetImages).length > 0;
    if (fs.existsSync(path.join(target, 'clipboard-history.json')) || targetHasImages) return;

    fs.mkdirSync(target, { recursive: true });

    for (const file of ['clipboard-history.json', 'clipboard-history.json.bak']) {
      const src = path.join(legacy, file);
      if (!fs.existsSync(src)) continue;
      try { fs.copyFileSync(src, path.join(target, file)); } catch (_) {}
    }

    const legacyImages = path.join(legacy, 'images');
    if (fs.existsSync(legacyImages)) {
      fs.mkdirSync(targetImages, { recursive: true });
      for (const file of fs.readdirSync(legacyImages)) {
        if (file.startsWith('.')) continue;
        try { fs.copyFileSync(path.join(legacyImages, file), path.join(targetImages, file)); } catch (_) {}
      }
    }
    console.log('[migrate] legacy userData copied to', target);
  } catch (e) {
    console.error('legacy userData migration failed:', e.message);
  }
}

function migrateLegacyUserDataOnce() {
  if (migrateLegacyUserData.done) return;
  migrateLegacyUserData.done = true;
  migrateLegacyUserData();
}

const IMAGE_SCHEME = 'ch-image';
const SOURCES_DIR = 'sources';   // 来源 App 图标缓存目录
const CONTENT_DIR = 'content';   // 富文本（RTF/HTML）原始内容
const MAX_HTML_BYTES = 100 * 1024;      // 渲染用的 HTML 上限
const MAX_RICH_BYTES = 2 * 1024 * 1024; // 落盘的 RTF/HTML 上限
const pendingIcons = new Set();  // 正在抓取的图标，避免同一 App 重复起进程
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
    this.sourcesDir = path.join(this.dir, SOURCES_DIR);
    fs.mkdirSync(this.sourcesDir, { recursive: true });
    this.contentDir = path.join(this.dir, CONTENT_DIR);
    fs.mkdirSync(this.contentDir, { recursive: true });
    this.iconCache = new Set(fs.readdirSync(this.sourcesDir));
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
      if (item.source) dup.source = item.source;
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
    const wipe = (dir, names) => {
      for (const name of names) {
        if (!name) continue;
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch (e) {
          // 文件可能已经不在了
        }
      }
    };
    if (item.type === 'image') wipe(this.imagesDir, [item.file, item.thumb]);
    if (item.type === 'richtext') wipe(this.contentDir, [item.htmlFile, item.rtfFile]);
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

// ============ 来源 App（哪来的这条剪贴板）============
// lsappinfo 是 Launch Services 自带的查询工具：不用辅助功能权限、不发通知、
// 比 osascript 快一个量级（单次 <10ms），拿得到 bundle id 和 .app 路径。
// 这些进程虽然"在前台"，但并不是用户真的在那里复制东西（锁屏、通知横幅、菜单栏）
const IGNORED_SOURCE_IDS = new Set([
  'com.liuxinyu.clipboard-history',
  'com.apple.UserNotificationCenter',
  'com.apple.notificationcenterui',
  'com.apple.controlcenter',
  'com.apple.dock',
  'com.apple.WindowManager',
  'com.apple.loginwindow',
  'com.apple.ScreenSaver.Engine'
]);

function captureSourceApp() {
  try {
    const asn = execFileSync('/usr/bin/lsappinfo', ['front'], { timeout: 500 })
      .toString().trim();
    if (!asn) return null;
    const out = execFileSync(
      '/usr/bin/lsappinfo',
      ['info', '-only', 'name,bundleID,bundlepath', asn],
      { timeout: 500 }
    ).toString();

    const pick = (key) => {
      const m = new RegExp(`"${key}"="([^"]*)"`).exec(out);
      return m ? m[1] : '';
    };
    const bundleId = pick('CFBundleIdentifier');
    const appPath = pick('LSBundlePath');
    const name = pick('LSDisplayName') || path.basename(appPath || '', '.app');

    if (!bundleId || !name) return null;
    if (IGNORED_SOURCE_IDS.has(bundleId)) return null;

    return { bundleId, name, path: appPath || '' };
  } catch (e) {
    return null;
  }
}

function sourceIconFile(source) {
  if (!source || !source.bundleId) return '';
  return `src-${sha1(source.bundleId).slice(0, 16)}.png`;
}

function sourceIconUrl(source) {
  const file = sourceIconFile(source);
  if (!file || !store.iconCache || !store.iconCache.has(file)) return '';
  return `${IMAGE_SCHEME}://src/${file}`;
}

// 从 .app 里找到真正的那份 .icns（CFBundleIconFile 可能不带后缀）
function appIconCandidates(appPath) {
  const resDir = path.join(appPath, 'Contents', 'Resources');
  const found = [];
  try {
    const name = execFileSync(
      '/usr/bin/plutil',
      ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')],
      { timeout: 500 }
    ).toString().trim();
    if (name) found.push(path.join(resDir, name.endsWith('.icns') ? name : `${name}.icns`));
  } catch (e) {
    // 有的 App 根本不声明 CFBundleIconFile
  }
  try {
    for (const file of fs.readdirSync(resDir)) {
      if (file.endsWith('.icns')) found.push(path.join(resDir, file));
    }
  } catch (e) {}
  return found.filter(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
}

// ============ 文件 / 富文本 ============

// Finder 复制文件时写的是 NSFilenamesPboardType（一个 plist 数组）
function parsePlistStrings(buf) {
  const xml = buf.toString('utf8');
  const out = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let m;
  while ((m = re.exec(xml))) {
    out.push(m[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&'));
  }
  return out;
}

function fileUrlToPath(raw) {
  const url = (raw || '').trim();
  if (!url.startsWith('file://')) return '';
  try {
    return decodeURIComponent(url.slice('file://'.length));
  } catch (e) {
    return '';
  }
}

function readClipboardFiles(formats) {
  const hasFiles = formats.includes('NSFilenamesPboardType') ||
    formats.includes('public.file-url') ||
    formats.includes('text/uri-list');
  if (!hasFiles) return [];

  const paths = [];
  // 注意：availableFormats() 不一定会列出 NSFilenamesPboardType（实测 Finder 复制只给
  // text/uri-list），但 readBuffer 依然能读到完整的 plist 数组，所以这里无条件试一次。
  try {
    for (const p of parsePlistStrings(clipboard.readBuffer('NSFilenamesPboardType'))) {
      if (p) paths.push(p);
    }
  } catch (e) {}
  if (!paths.length && formats.includes('public.file-url')) {
    try {
      const p = fileUrlToPath(clipboard.readBuffer('public.file-url').toString('utf8'));
      if (p) paths.push(p);
    } catch (e) {}
  }
  if (!paths.length && formats.includes('text/uri-list')) {
    try {
      for (const line of clipboard.readBuffer('text/uri-list').toString('utf8').split(/\r?\n/)) {
        const p = fileUrlToPath(line);
        if (p) paths.push(p);
      }
    } catch (e) {}
  }

  return [...new Set(paths)].filter(p => fs.existsSync(p)).slice(0, 50);
}

// 只有真的带格式才算「富文本」：Chrome 复制纯文字也会塞一份
// 只带 <span> 的 HTML，那种情况仍按纯文本记，避免历史里一片"富文本"。
const RICH_MARKERS = [
  /<b[\s>]/i, /<strong[\s>]/i, /<i[\s>]/i, /<em[\s>]/i, /<u[\s>]/i,
  /<ul[\s>]/i, /<ol[\s>]/i, /<li[\s>]/i, /<h[1-6][\s>]/i, /<table[\s>]/i,
  /<blockquote[\s>]/i, /<mark[\s>]/i, /<pre[\s>]/i,
  /font-weight\s*:\s*(bold|[6-9]00)/i,
  /font-style\s*:\s*italic/i,
  /text-decoration\s*:[^;"]*underline/i,
  /background-color\s*:/i
];

function readClipboardRich(formats) {
  if (!formats.includes('text/rtf') && !formats.includes('text/html')) return null;
  let rtf = '';
  let html = '';
  try {
    if (formats.includes('text/rtf')) rtf = clipboard.readRTF() || '';
  } catch (e) {}
  try {
    if (formats.includes('text/html')) html = clipboard.readHTML() || '';
  } catch (e) {}

  const htmlHasFormatting = !!html && RICH_MARKERS.some(re => re.test(html));
  // RTF 只要不是纯 "{\rtf1\ansi ...\par}" 这种纯文本转写，就认为有格式
  const rtfHasFormatting = !!rtf && (RICH_MARKERS.some(re => re.test(rtf)) || /\\b\b|\\i\b|\\ul\b|\\cf\d/.test(rtf));
  if (!htmlHasFormatting && !rtfHasFormatting) return null;
  return { rtf, html };
}

function saveRichFiles(id, html, rtf) {
  const out = { htmlFile: '', rtfFile: '' };
  try {
    if (html) {
      const buf = Buffer.from(html, 'utf8').subarray(0, MAX_RICH_BYTES);
      out.htmlFile = `${id}.html`;
      fs.writeFileSync(path.join(store.contentDir, out.htmlFile), buf);
    }
    if (rtf) {
      const buf = Buffer.from(rtf, 'utf8').subarray(0, MAX_RICH_BYTES);
      out.rtfFile = `${id}.rtf`;
      fs.writeFileSync(path.join(store.contentDir, out.rtfFile), buf);
    }
  } catch (e) {
    console.error('saveRichFiles failed:', e.message);
  }
  return out;
}

function readContentFile(name, limit) {
  if (!name) return '';
  try {
    const buf = fs.readFileSync(path.join(store.contentDir, name));
    return buf.subarray(0, limit || MAX_RICH_BYTES).toString('utf8');
  } catch (e) {
    return '';
  }
}

// 文件图标按「目录 / 扩展名」缓存，一个扩展名只抓一次
function fileIconKey(filePath) {
  let ext = '';
  let isDir = false;
  try {
    ext = path.extname(filePath).toLowerCase();
    isDir = fs.statSync(filePath).isDirectory();
  } catch (e) {}
  return sha1(isDir ? 'dir' : (ext || 'generic')).slice(0, 16);
}

const pendingFileIcons = new Set();

async function ensureFileIcon(filePath) {
  const key = fileIconKey(filePath);
  const file = `file-${key}.png`;
  if (store.iconCache.has(file) || pendingFileIcons.has(file)) return true;
  pendingFileIcons.add(file);
  try {
    const img = await app.getFileIcon(filePath, { size: 'normal' });
    if (img.isEmpty()) return false;
    const big = img.resize({ width: 64, height: 64, quality: 'best' });
    fs.writeFileSync(path.join(store.sourcesDir, file), big.toPNG());
    store.iconCache.add(file);
    return true;
  } catch (e) {
    return false;
  } finally {
    pendingFileIcons.delete(file);
  }
}

// 判断一张图标是不是「灰度/掩膜版」：现代 App（Chrome、微信…）把彩色图标放在
// Assets.car 里，.icns 只剩一张黑白 mask，直接转出来会是灰图。
function looksMonochrome(file) {
  try {
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return true;
    const { width, height } = img.getSize();
    if (!width || !height) return true;
    const buf = img.toBitmap(); // BGRA
    let colored = 0;
    let sampled = 0;
    for (let i = 0; i < buf.length; i += 4 * 7) {
      const b = buf[i], g = buf[i + 1], r = buf[i + 2], a = buf[i + 3];
      if (a < 24) continue;
      sampled++;
      if (Math.abs(r - g) > 10 || Math.abs(g - b) > 10 || Math.abs(r - b) > 10) colored++;
    }
    if (!sampled) return true;
    return colored / sampled < 0.02; // 彩色像素不到 2% 就当灰度
  } catch (e) {
    return true;
  }
}

// 用 NSWorkspace 取真彩图标（走 Assets.car，JXA 启动约 1s，所以只在必要时用）
function extractIconViaNSWorkspace(appPath, dest) {
  const tmp = path.join(os.tmpdir(), `ch-icon-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const script = `ObjC.import('Cocoa');
const icon = $.NSWorkspace.sharedWorkspace.iconForFile(${JSON.stringify(appPath)});
icon.setSize($.NSMakeSize(256, 256));
const rep = $.NSBitmapImageRep.imageRepWithData(icon.TIFFRepresentation);
rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(${JSON.stringify(tmp)}, true);`;
  try {
    execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 8000, stdio: 'ignore' });
    if (!fs.existsSync(tmp)) return false;
    execFileSync('/usr/bin/sips', ['-Z', '64', tmp, '--out', dest], { timeout: 8000, stdio: 'ignore' });
    fs.unlinkSync(tmp);
    return fs.existsSync(dest) && fs.statSync(dest).size > 0;
  } catch (e) {
    return false;
  }
}

// 抓 App 图标成 64px PNG 缓存；成功返回 true
async function ensureSourceIcon(source) {
  if (!source || !source.bundleId) return false;
  const file = sourceIconFile(source);
  if (!file) return false;
  if (store.iconCache.has(file)) return false;
  if (!source.path || !fs.existsSync(source.path)) return false;
  if (pendingIcons.has(file)) return false;

  const dest = path.join(store.sourcesDir, file);
  pendingIcons.add(file);
  try {
    fs.mkdirSync(store.sourcesDir, { recursive: true });

    // 1) .icns 直接转，最快；但只有真彩图标才算成功
    for (const icns of appIconCandidates(source.path)) {
      try {
        execFileSync('/usr/bin/sips', ['-s', 'format', 'png', icns, '--out', dest, '-Z', '64'], { timeout: 3000 });
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0 && !looksMonochrome(dest)) {
          store.iconCache.add(file);
          return true;
        }
      } catch (e) {
        // 换下一个候选
      }
    }

    // 2) 退回 NSWorkspace（Assets.car 里的彩色图标）
    if (extractIconViaNSWorkspace(source.path, dest)) {
      store.iconCache.add(file);
      return true;
    }

    // 3) 最后用 Electron 自带的（可能是灰阶），只在还没有文件时兜底
    if (!fs.existsSync(dest)) {
      const img = await app.getFileIcon(source.path, { size: 'normal' });
      if (!img.isEmpty()) {
        const big = img.resize({ width: 64, height: 64, quality: 'best' });
        fs.writeFileSync(dest, big.toPNG());
        store.iconCache.add(file);
        return true;
      }
    }
    return false;
  } catch (e) {
    return false;
  } finally {
    pendingIcons.delete(file);
  }
}

// 传给渲染进程的字段（不含 base64 大图）
function publicItem(item) {
  const out = {
    id: item.id,
    type: item.type,
    timestamp: item.timestamp,
    preview: item.preview || '',
    content: (item.type === 'text' || item.type === 'richtext') ? (item.content || '') : undefined,
    length: item.length || 0,
    width: item.width || 0,
    height: item.height || 0,
    bytes: item.bytes || 0,
    thumbUrl: item.thumb ? `${IMAGE_SCHEME}://img/${encodeURIComponent(item.thumb)}` : '',
    source: item.source || null,
    sourceIcon: sourceIconUrl(item.source)
  };

  if (item.type === 'files' && Array.isArray(item.files)) {
    out.files = item.files.map(f => ({
      name: f.name,
      isDir: !!f.isDir,
      icon: `file-${fileIconKey(f.path)}.png`
    }));
  }

  if (item.type === 'richtext') {
    // 渲染只要一份裁剪过的 HTML；原始 RTF 留在磁盘上用于粘贴
    out.html = readContentFile(item.htmlFile, MAX_HTML_BYTES);
  }

  return out;
}

// ============ 运行状态 ============
let mainWindow = null;
let tray = null;
let clipboardWatcher = null;
let previousAppName = null;
let lastTextHash = '';
let lastFilesHash = '';
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
        if (name && name !== 'Clipboard' && name !== 'Electron') {
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
function refreshSourceIcon(source) {
  if (!source) return;
  ensureSourceIcon(source).then(ok => {
    if (ok && mainWindow && mainWindow.isVisible()) sendHistory();
  }).catch(() => {});
}

async function addTextItem(text, source) {
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
    truncated,
    source: source || null
  };
  const added = store.add(item);
  if (mainWindow && mainWindow.isVisible()) sendHistory();
  refreshSourceIcon(source);
  return added;
}

async function addFilesItem(paths, source) {
  const files = paths.map(p => {
    let size = 0;
    let isDir = false;
    try {
      const st = fs.statSync(p);
      isDir = st.isDirectory();
      size = st.size;
    } catch (e) {}
    return { name: path.basename(p), path: p, isDir, size };
  });
  const item = {
    id: newId(),
    type: 'files',
    hash: 'f:' + sha1(paths.join('\n')),
    timestamp: Date.now(),
    files,
    preview: files.map(f => f.name).join('、'),
    length: files.length,
    bytes: files.reduce((n, f) => n + (f.size || 0), 0),
    source: source || null
  };
  const added = store.add(item);
  if (mainWindow && mainWindow.isVisible()) sendHistory();
  refreshSourceIcon(source);
  // 文件图标：抓完再推一次，卡片上就会从占位变成真实图标
  Promise.all(files.map(f => ensureFileIcon(f.path)))
    .then(() => { if (mainWindow && mainWindow.isVisible()) sendHistory(); })
    .catch(() => {});
  return added;
}

async function addRichItem(text, rich, source) {
  const truncated = Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES;
  const content = truncated
    ? Buffer.from(text, 'utf8').subarray(0, MAX_TEXT_BYTES).toString('utf8')
    : text;
  const id = newId();
  const saved = saveRichFiles(id, rich.html, rich.rtf);
  const item = {
    id,
    type: 'richtext',
    hash: 'r:' + sha1(content + '\u0000' + (rich.html || '').slice(0, 2000) + '\u0000' + (rich.rtf || '').slice(0, 2000)),
    content,
    preview: content.length > 200 ? content.slice(0, 200) : content,
    timestamp: Date.now(),
    length: text.length,
    truncated,
    htmlFile: saved.htmlFile,
    rtfFile: saved.rtfFile,
    bytes: Buffer.byteLength(rich.html || '', 'utf8') + Buffer.byteLength(rich.rtf || '', 'utf8'),
    source: source || null
  };
  const added = store.add(item);
  if (mainWindow && mainWindow.isVisible()) sendHistory();
  refreshSourceIcon(source);
  return added;
}

async function addImageItem(buf, source) {
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
    preview: `${saved.width} × ${saved.height}`,
    source: source || null
  };
  const added = store.add(item);
  if (mainWindow && mainWindow.isVisible()) sendHistory();
  refreshSourceIcon(source);
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
      const formats = clipboard.availableFormats() || [];

      // 1) 文件优先：Finder 复制文件时文本通常是空的，但某些 App 会同时给一段文本
      const files = readClipboardFiles(formats);
      if (files.length) {
        const filesHash = 'f:' + sha1(files.join('\n'));
        if (filesHash !== lastFilesHash) {
          lastFilesHash = filesHash;
          lastTextHash = hashText(clipboard.readText() || '');
          const source = captureSourceApp();
          addFilesItem(files, source).catch(e => console.error('addFilesItem:', e));
        }
        return;
      }
      lastFilesHash = '';

      const text = clipboard.readText();
      const textHash = text ? hashText(text) : '';

      if (textHash && textHash !== lastTextHash) {
        lastTextHash = textHash;
        const source = captureSourceApp();
        const rich = readClipboardRich(formats);
        if (rich) {
          addRichItem(text, rich, source).catch(e => console.error('addRichItem:', e));
        } else {
          addTextItem(text, source).catch(e => console.error('addTextItem:', e));
        }
        return;
      }
      if (textHash) return; // 有文本时不再检查图片，避免影响文本复制

      if (!clipboardHasImage(formats)) return;

      const buf = clipboard.readBuffer('public.png');
      if (!buf || !buf.length) return;
      const hash = sha1(buf);
      if (hash === lastImageHash) return;
      lastImageHash = hash;
      const source = captureSourceApp();
      addImageItem(buf, source).catch(e => console.error('addImageItem:', e));
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
        'User-Agent': 'Clipboard-Updater',
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
          title: 'Clipboard · 发现新版本',
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
            title: 'Clipboard · 已是最新版本',
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
        title: 'Clipboard · 检查更新失败',
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
      <h2>正在更新 Clipboard</h2>
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
        headers: { 'User-Agent': 'Clipboard-Updater', 'Accept': 'application/octet-stream' }
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
  const tmpDir = path.join(app.getPath('temp'), `clipboard-update-${Date.now()}`);
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

    // 找到解压出的 .app（不写死包名，随 app 名字变化）
    const appName = fs.readdirSync(extractDir).find(name => name.endsWith('.app'));
    if (!appName) {
      throw new Error('解压后未找到 .app');
    }
    const newAppPath = path.join(extractDir, appName);

    // 3. 移除 quarantine 标记
    updateProgress('准备替换...', 80);
    try { execSync(`/usr/bin/xattr -cr "${newAppPath}"`); } catch (e) {}

    // 4. 计算当前 .app 路径（从 main 进程的可执行文件反推）
    // app.getAppPath() => /Applications/Clipboard.app/Contents/Resources/app.asar
    // process.execPath => /Applications/Clipboard.app/Contents/MacOS/Clipboard
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
TRASH_DIR="/tmp/clipboard-old-$(date +%s)"
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
        title: 'Clipboard · 更新失败',
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
    tray.setToolTip('Clipboard');
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
    { label: '显示 Clipboard (⇧⌘V)', click: () => showWindow() },
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
    { label: '关于 Clipboard', click: () => {
      dialog.showMessageBox({
        type: 'info',
        title: '关于',
        message: 'Clipboard · 剪贴板历史',
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
      const url = new URL(request.url);
      const host = url.host;
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const safe = path.basename(name);
      if (host === 'src') {
        if (!/^(src|file)-[A-Za-z0-9]+\.png$/.test(safe)) {
          return new Response('Bad request', { status: 400 });
        }
        const data = fs.readFileSync(path.join(store.sourcesDir, safe));
        return new Response(data, {
          headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' }
        });
      }
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
  migrateLegacyUserDataOnce();
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
function writeItemsToClipboard(item) {
  if (!item) return false;

  if (item.type === 'text') {
    clipboard.writeText(item.content || '');
    lastTextHash = item.hash || hashText(item.content || '');
    return true;
  }

  if (item.type === 'richtext') {
    const html = readContentFile(item.htmlFile);
    const rtf = readContentFile(item.rtfFile);
    clipboard.write({ text: item.content || '', html, rtf });
    lastTextHash = hashText(item.content || '');
    return true;
  }

  if (item.type === 'files') {
    const paths = (item.files || []).map(f => f.path).filter(Boolean);
    if (!paths.length) return false;
    try {
      // AppleScript 的 `set the clipboard to {POSIX file …}` 只会写一个 AppleScript list，
      // Finder 收不到文件；必须用 NSPasteboard.writeObjects 写 NSURL 数组。
      const js = `ObjC.import('AppKit');
(function () {
  var pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  pb.writeObjects($(${JSON.stringify(paths)}.map(function (p) { return $.NSURL.fileURLWithPath(p); })));
})();`;
      execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js], { timeout: 8000 });
      lastFilesHash = 'f:' + sha1(paths.join('\n'));
      return true;
    } catch (e) {
      console.error('File paste failed:', e.message);
      return false;
    }
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
  if (!writeItemsToClipboard(item)) return;
  hideWindow();
  pasteToPreviousApp();
});

ipcMain.on('copy-item', (event, id) => {
  const item = store.find(id);
  if (item) writeItemsToClipboard(item);
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
