# ClipboardHistory v1.2.1 代码体检报告

体检对象：`~/apps/clipboard-history`（源码）、`/Applications/ClipboardHistory.app`（打包产物）
体检时间：2026-11-24 · 方式：通读全部源码 + 本机实测（CPU/内存/存储增长/进程行为）

## 实测数据（先看这个，决定了优先级）

| 场景 | 实测结果 |
|---|---|
| 空闲（剪贴板是文本） | 主进程 CPU 0.3–0.4%，RSS 46 MB |
| 剪贴板里有一张 4.6 MB 的 PNG | 主进程 CPU **11.4% → 23.7% → 41.0%**，RSS 涨到 90 MB，持续不降 |
| 复制那张 PNG 后的历史文件 | `clipboard-history.json` 从 185 B 涨到 **12 MB**（同一个 base64 存了两遍） |
| 同时开两个实例 | 两个实例各自 800ms 轮询、各自全量写同一个 JSON，后写的覆盖先写的（实测可复现） |

## P0 · 数据安全与正确性

1. **图片被存两遍**（`main.js:164-170`）：图片条目同时写 `content: imgData` 和 `preview: imgData`，同一个 base64 字符串在 JSON 里出现两次 → 体积直接翻倍。实测 4.6 MB 图片 → 12 MB 历史文件。
   - 改法：`preview` 只存缩略图（或干脆不存，渲染时按需生成），图片原文落盘成独立文件。
2. **每次变更都全量同步写盘**（`main.js:31` `fs.writeFileSync(this.filePath, JSON.stringify(this.cache))`）：历史里有几张图以后，每复制一次文本都要重新序列化并写入十几 MB，写盘期间主进程完全阻塞（剪贴板监听、快捷键响应都会卡）。
3. **写盘不是原子的**：`writeFileSync` 直接截断原文件再写，进程被杀/断电时会得到半截 JSON。`init()` 里 catch 到解析失败会静默重置成空历史（`main.js:24-27`）——**一次异常退出就可能清空全部历史**。
   - 改法：写 `tmp` 再 `rename`；或用 SQLite（`better-sqlite3`）/ LevelDB 存元数据，图片单独落盘。
4. **没有单实例锁**（全文无 `requestSingleInstanceLock`）：双击两次就有两个实例，两个轮询器同时写同一个文件 → 历史互相覆盖丢失。实测同时运行两个实例可复现。
5. **条目 id 用 `timestamp`**（`main.js:672-676`）：同一毫秒内的两条记录会被"删除"一起删掉。应改为自增 id 或 uuid。

## P1 · 性能（用户能直接感知的卡顿/发热）

6. **800ms 轮询每次都做图片编码**（`main.js:151-176`）：不论剪贴板是文本还是空，每个 tick 都 `clipboard.readImage().toDataURL()`。剪贴板里放着大图时就是每 800ms 编码一次 6 MB 字符串再比较一次字符串——实测 CPU 飙到 40%。
   - 改法：轮询只读 `clipboard.readText()`（极便宜）+ `clipboard.availableFormats()`；只有格式里出现图片且文本没变时才去读图。更彻底的做法是接 `NSPasteboard.changeCount`（需要原生模块或 `osascript`/`pbpaste` 旁路）。
7. **每次呼出把整个历史塞给渲染进程**（`main.js:105-112`）：`webContents.send('clipboard-history', history)` 传的是含全部 base64 图片的数组，历史有图时每次按 ⇧⌘V 都要序列化+跨进程复制几 MB 到几十 MB。
   - 改法：只传元数据（类型/预览文本/时间/尺寸/缩略图路径），图片由渲染进程按需加载。
8. **渲染层全量重建 DOM**（`renderer.js:42-99`）：每次按键、每次历史更新都 `cardList.innerHTML = ''` 重建全部卡片，图片卡片会重新解析 base64 大图；配合 `scrollIntoView({behavior:'smooth'})` 每次按键都触发动画。200 条历史时明显掉帧。
   - 改法：增量 diff 或只切 `.selected` class；图片用 `<img loading="lazy">` + 缩略图。
9. **双重模糊**（`main.js:63` `vibrancy:'under-window'` + `styles.css:24` `backdrop-filter: blur(40px) saturate(180%)`）：窗口显示时两层实时模糊叠加，GPU 合成开销翻倍。二选一即可。
10. **每次呼出同步执行 osascript**（`main.js:93`）：`captureFrontmostApp()` 用 `execSync` 拿最前台 App 名，超时 500ms，这期间主进程完全阻塞——冷启动第一次呼出的顿挫感就来自这里（首次调用 osascript 还要加载 AppleScript 运行时）。
    - 改法：缓存结果 + 异步 `exec`，或用 `NSWorkspace.frontmostApplication`（native 模块）。

## P2 · 交互与体验

11. **选中项每次都跳回第一张**（`renderer.js:131` `selectedIndex = 0`）：窗口开着的时候复制了新内容、或者删掉一张卡片，选中态立刻回到最左，正在按方向键找东西时非常打断。
12. **删除无确认、不可撤销**（`renderer.js:86-89` 右键即删）：误触右键就没了。
13. **图片卡片直接渲染原图**（`renderer.js:61-62`）：200px 宽的卡片里塞 6 MB 原图，内存和解码都浪费；应生成缩略图。
14. **窗口只认主屏且铺满整屏**（`main.js:53,58-70`）：外接显示器时在副屏按快捷键，窗口还是弹在主屏；小屏/大屏都是固定 320px 高 + 全宽。应按鼠标所在屏 + 限制最大宽度。
15. **序号提示不完整**：卡片底部显示 `≡ i+1`，但只有 1–9 有直选快捷键，第 10 张以后的编号是误导。
16. **搜索不可用键盘结果导航之外的入口**：搜索结果里图片被整体过滤掉（`renderer.js:107`），历史里全是图时搜索框毫无反应，容易以为坏了。
17. `index.html:12` 的 SVG 用了 `clipPath=` 属性（不是有效 SVG 属性），无效。
18. 底部提示没有列出 `/`、`⌘F` 搜索和右键删除，新用户发现不了。

## P3 · 工程化与分发

19. **打包图标没生效**（`build/package.js:14`）：`icon: __dirname + '/icon'` 缺扩展名，@electron/packager v20 直接跳过并在日志里警告 `Could not find icon ... with extension ".icon"`；产物 `Info.plist` 的 `CFBundleIconFile` 仍是 `electron.icns`，README 里宣传的"全新图标"在安装后看是 Electron 默认图标。改成 `path.join(__dirname, 'icon.icns')` 即可。
20. **没有签名/公证**：产物是 adhoc + linker-signed，`codesign --verify --deep --strict` 报 `code has no resources but signature indicates they must be present`。本地 `xattr -cr` 后能启动，但别人从 Release 下载的 zip 带 quarantine，会被 Gatekeeper 拦；自动更新替换下来的包同样问题。
21. **自动更新是"自杀式替换"**（`main.js:380-490`）：下载的 zip 不校验签名/哈希，脚本里 `TRASH_DIR` 变量拼好但目录没创建（`mv` 到不存在路径只是重命名，能用但脆弱），失败无回滚，替换 `/Applications` 需要权限，更新后「辅助功能」授权可能失效。
22. **`install.sh` 两个坑**：`pkill -f "ClipboardHistory"` 匹配过宽（任何含该串的进程都会被误杀）；末尾 `open "$APP_DST"` 在带 `ELECTRON_RUN_AS_NODE=1` 的终端环境里启动会静默失败（本机实测）。
23. **Electron 28 已 EOL**（`package.json`）：不再收安全更新，建议升到 3x 系列（升级成本主要在 30+ 的 API 变化，这个项目用到的 API 很基础，风险不大）。
24. 没有测试、lint、CI；`renderer.js` 是全局脚本，没有模块化，改动容易互相影响。

## 建议的动手顺序

1. 先做 P0 的 1/2/3/4：数据结构改成「元数据 + 图片文件」、原子写、单实例锁。这一步能同时消掉 P1 的 6/7 的大半收益，而且后面所有优化都建立在它上面。
2. 再做 P1 的 6/7/8（轮询、IPC 载荷、渲染 diff），这三项直接决定"用起来顺不顺"。
3. 然后 P2 的 11/12/13/14（选中态、删除确认、缩略图、多屏）。
4. 最后 P3 的 19/20/22（图标、签名、安装脚本）。

P0 改造对现有 `clipboard-history.json` 兼容：第一次启动时做一次迁移（把 base64 抽成文件、写 v2 结构），历史不丢。

---

## ✅ 本轮已落地（2026-11-24）

范围：P0 全部 + P1 全部 + P2 的选中态/删除定位/缩略图/多屏/序号 + UI 重做 + P3 的图标与 install.sh。

- **存储层重写**：`userData/clipboard-history.json` 只存元数据（id/type/hash/timestamp/preview/length/width/height/bytes/file/thumb），
  原图和 480px 缩略图落到 `userData/images/`；`save()` 200ms 防抖，`flush()` 写 `.tmp` 再 `rename`，旧文件轮转为 `.bak`，
  解析失败自动回退 `.bak`；v1 的 base64 历史首次启动自动迁移（实测 3 条历史 + 1 张图无损迁移）。
- **单实例锁**：`requestSingleInstanceLock()`，第二次启动直接退出，第一次收到 `second-instance` 就呼出窗口。
- **轮询重写**：700ms tick 只做 `readText()`；无文本时才 `readBuffer('public.png')` 比 sha1（实测 1.4ms vs 旧 `readImage().toDataURL()` 118ms），
  哈希不变就不解码。实测：剪贴板常驻 4.6 MB 图片时 CPU 0.4–1.3%（旧 11.4→41.0%）。
- **IPC 轻量化**：历史只传元数据 + `thumbUrl`（`ch-image://img/<file>`），自定义 `protocol.handle` 提供图片；图片卡片用 `loading="lazy"` 的缩略图。
- **渲染层**：方向键只切 `selected` class 不重建 DOM；筛选保留选中 id，删除后聚焦邻居；每 20s 只更新时间文案；新增 ⌘C 复制、Home/End、搜索空结果提示、清空二次确认。
- **窗口**：跟随鼠标所在屏幕（`getDisplayNearestPoint`）、居中贴底、宽度 `min(屏宽-16, 1180)`、高 300，`hasShadow`/`roundedCorners`。
- **UI**：重写为 macOS 风格（vibrancy 单层材质、去 `backdrop-filter` 双模糊、`color-scheme: light dark` 明暗两套变量、12px 圆角卡片、选中蓝环、类型着色角标）。截图见 `docs/ui-dark.png`、`docs/ui-light.png`。
- **打包/安装**：`build/package.js` 图标改为 `path.join(__dirname, 'icon.icns')`（产物 `Resources/electron.icns` 内容已核对为自绘图标，哈希一致；`.icon` 警告来自 Icon Composer 新格式探测，可忽略）；
  `install.sh` 的 pkill 收窄到应用二进制路径，启动改为 `env -u ELECTRON_RUN_AS_NODE open ...`。
- **仍待办**：签名/公证（19/20 之外）、自动更新替换的校验与回滚、Electron 28 升级、测试/lint/CI。

---

## ✅ v1.4.0 新增：剪贴板来源 App（2026-11-25）

- **取来源**：每次检测到剪贴板变化时调 `captureSourceApp()`，用 `/usr/bin/lsappinfo front` + `lsappinfo info -only name,bundleID,bundlepath`
  读当前前台 App。`lsappinfo` 是 Launch Services 自带工具：**不需要辅助功能权限**、不弹窗，实测两次 spawn 合计约 7ms（只在内容变化时调用，不是每 tick）。
  `com.liuxinyu.clipboard-history`（自己）会被忽略，避免从应用内复制时记成自己。
- **图标缓存**：`ensureSourceIcon()` 把 App 图标抓成 64px PNG 存 `userData/sources/src-<sha1(bundleId)[0:16]>.png`。
  三级策略：① `sips` 直接把 bundle 里的 `.icns` 转 PNG（约 20ms，绝大多数 App 够用）；② `.icns` 只有灰度 mask 时（现代 App 把彩色图标放 `Assets.car`），
  退回 `osascript -l JavaScript` 调 `NSWorkspace.iconForFile`（约 350–1000ms，走资源目录里的彩色图标）；③ 最后兜底 `app.getFileIcon`。
  抓取是 fire-and-forget：条目先入库、卡片先显示通用占位，图标好了再推一次 `sendHistory()`；`pendingIcons` 防止同一 App 并发抓取重复起进程。
- **协议**：`ch-image://src/<file>` 走同一个 `protocol.handle`，白名单 `^src-[A-Za-z0-9]+\.png$`，`cache-control: max-age=86400`（图标不会变）。
- **数据**：条目新增 `source: { bundleId, name, path }`；同 hash 重复复制时用最新的来源覆盖旧来源；老条目没有 source 时渲染通用 App 轮廓图标。
- **渲染**：卡片左上角 16px 圆角小图标（`app.getFileIcon` 量级的尺寸，跟系统通知一致），`title` 显示 App 名；搜索框同时匹配来源 App 名（搜「微信」「Chrome」可直接过滤）。
- 实测：Chrome / 微信 / 备忘录 / 终端 图标均正确取到真彩版本并缓存；复制时来源记录正确。

### 与 Paste 的差距（对照见 README 讨论）
Paste 有 Pinboard（收藏板）、iCloud 跨设备同步、Apple Intelligence 预测下一条、MCP 供 AI 读取剪贴板、忽略密码类 App 的隐私规则、富内容类型（文件/颜色/富文本）。
本项目定位是「零依赖、本地、单机快捷键工具」，下一步优先级建议：**Pin 收藏** → **忽略 App 规则** → **文件/颜色类型** → 同步（可选 iCloud）。

### v1.5.0 新增：文件 / 富文本类型
- **文件**：Finder 复制时写的是 `NSFilenamesPboardType`（多个文件全在这一个 plist 数组里），但 `availableFormats()` 只会列出 `text/uri-list`——所以不能拿 formats 判断，直接 `readBuffer('NSFilenamesPboardType')` 再解析 `<string>` 数组；读不到时退回 `public.file-url`、`text/uri-list`。条目存 `files: [{name,path,isDir,size}]`，去重 hash 用 `f:` + 路径列表。
- **文件图标**：按「目录 / 扩展名」缓存 `sources/file-<sha1(ext|dir)[0:16]>.png`（`app.getFileIcon` 抓 64px），协议白名单放宽成 `^(src|file)-[A-Za-z0-9]+\.png$`，同一扩展名只抓一次。
- **粘贴文件**：AppleScript 的 `set the clipboard to {POSIX file …}` 只写了个 AppleScript list，Finder 收不到；改用 `osascript -l JavaScript` 调 `NSPasteboard.writeObjects([NSURL…])`，实测剪贴板里出现 `NSFilenamesPboardType` + `text/uri-list`。
- **富文本**：`availableFormats()` 会同时给 `text/plain` / `text/html` / `text/rtf`，用 `readHTML()` / `readRTF()` 读；只有 HTML 里真的出现 b/strong/i/em/u/ul/ol/li/h1-6/table/blockquote/mark/pre 或 `font-weight:bold` / `font-style:italic` / `text-decoration:underline` / `background-color` 才算富文本——Chrome 复制纯文字也会塞一份只带 `<span>` 的 HTML，那种仍按纯文本记。
- **存储**：RTF/HTML 落成 `userData/content/<id>.rtf|.html`（各限 2 MB），JSON 里只留文件名；粘贴时从磁盘读回 `clipboard.write({ text, html, rtf })`。删除/清空时一并删掉。
- **渲染**：卡片预览用 DOMParser 白名单清洗 HTML（只留排版标签、**去掉全部属性**，`<style>/<script>/<iframe>/<img>` 等连内容一起丢），避免 Cocoa 生成的 `<style>` 文本糊进卡片，也杜绝远程资源。
- **不做颜色类型**：`NSColor` 写的 pasteboard Electron 完全看不到（`availableFormats()` 为空），要做只能每 tick spawn osascript，代价远超收益。
