let items = [];
let filtered = [];
let selectedId = null;
let searchKeyword = '';
let pendingDeleteIndex = null;

const cardList = document.getElementById('cardList');
const searchInput = document.getElementById('searchInput');
const clearBtn = document.getElementById('clearBtn');
const statusEl = document.getElementById('status');

const TYPE_LABEL = { text: '文本', link: '链接', image: '图片' };

function formatTime(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${Math.max(1, min)} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function detectType(item) {
  if (item.type === 'image') return 'image';
  const txt = (item.content || '').trim();
  if (/^https?:\/\//i.test(txt) && txt.length < 500 && !txt.includes('\n')) return 'link';
  return 'text';
}

function itemMeta(item) {
  if (item.type === 'image') {
    const size = item.width && item.height ? `${item.width}×${item.height}` : '图片';
    const bytes = formatBytes(item.bytes);
    return bytes ? `${size} · ${bytes}` : size;
  }
  return `${item.length || (item.content || '').length} 字符`;
}

function updateStatus() {
  if (!statusEl) return;
  if (searchKeyword) {
    statusEl.textContent = `找到 ${filtered.length} 条`;
  } else {
    statusEl.textContent = items.length ? `共 ${items.length} 条` : '';
  }
}

// 来源 App 的小图标（Paste 那种「卡片上能看到这条是从哪个 App 复制的」）
function buildSourceChip(item) {
  const chip = document.createElement('span');
  chip.className = 'src';
  const src = item.source;
  if (src && src.name) chip.title = src.name;

  if (item.sourceIcon) {
    const img = document.createElement('img');
    img.src = item.sourceIcon;
    img.alt = src ? src.name : '';
    img.loading = 'lazy';
    img.draggable = false;
    chip.appendChild(img);
    return chip;
  }

  // 没有图标（老记录 / 系统进程 / 取图标失败）时退回一个通用 App 轮廓
  const fallback = document.createElement('span');
  fallback.className = 'src-fallback';
  fallback.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<rect x="2.75" y="2.75" width="10.5" height="10.5" rx="3.25" fill="none" ' +
    'stroke="currentColor" stroke-width="1.25"/><circle cx="8" cy="8" r="1.7" fill="currentColor"/></svg>';
  chip.appendChild(fallback);
  chip.classList.add('is-fallback');
  return chip;
}

function buildCard(item, index) {
  const type = detectType(item);
  const card = document.createElement('div');
  card.className = `card type-${type}`;
  card.dataset.id = item.id;
  if (item.id === selectedId) card.classList.add('selected');

  const head = document.createElement('div');
  head.className = 'card-head';
  head.append(buildSourceChip(item));

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = TYPE_LABEL[type];
  const time = document.createElement('span');
  time.className = 'time';
  time.dataset.ts = String(item.timestamp);
  time.textContent = formatTime(item.timestamp);
  head.append(badge, time);

  const body = document.createElement('div');
  body.className = 'card-body';
  if (item.type === 'image' && item.thumbUrl) {
    const img = document.createElement('img');
    img.src = item.thumbUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    body.appendChild(img);
  } else {
    body.textContent = item.preview || item.content || '';
  }

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const meta = document.createElement('span');
  meta.textContent = itemMeta(item);
  const idx = document.createElement('span');
  idx.className = 'card-index';
  idx.textContent = index < 9 ? `${index + 1}` : '';
  foot.append(meta, idx);

  card.append(head, body, foot);

  card.addEventListener('click', () => {
    selectedId = item.id;
    window.clipAPI.pasteItem(item.id);
  });
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    removeItem(item.id);
  });

  return card;
}

function render() {
  cardList.textContent = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.textContent = searchKeyword ? '🔍' : '📋';
    const text = document.createElement('div');
    text.textContent = searchKeyword ? '没有匹配的内容' : '还没有剪贴板记录';
    const hint = document.createElement('div');
    hint.style.fontSize = '11px';
    hint.style.opacity = '0.75';
    hint.textContent = searchKeyword ? '换个关键词试试' : '复制一段文字或图片后会自动出现在这里';
    empty.append(icon, text, hint);
    cardList.appendChild(empty);
    updateStatus();
    return;
  }

  const frag = document.createDocumentFragment();
  filtered.forEach((item, i) => frag.appendChild(buildCard(item, i)));
  cardList.appendChild(frag);
  updateStatus();
  scrollToSelected('auto');
}

function scrollToSelected(behavior = 'smooth') {
  const el = selectedId ? cardList.querySelector(`.card[data-id="${CSS.escape(selectedId)}"]`) : null;
  if (el) el.scrollIntoView({ behavior, block: 'nearest', inline: 'nearest' });
}

// 只切换选中样式，不重建列表（方向键连按时不再重排 DOM）
function setSelection(id, { scroll = true } = {}) {
  if (!id || id === selectedId) {
    if (id && scroll) scrollToSelected();
    return;
  }
  const prev = cardList.querySelector('.card.selected');
  if (prev) prev.classList.remove('selected');
  selectedId = id;
  const next = cardList.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (next) {
    next.classList.add('selected');
    if (scroll) next.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }
}

function applyFilter(preferredIndex) {
  const kw = searchKeyword.trim().toLowerCase();
  // 搜索同时匹配内容与来源 App 名（搜「微信」「Chrome」也能过滤）
  filtered = !kw
    ? items.slice()
    : items.filter(item => {
        const inContent = item.type !== 'image' && (item.content || '').toLowerCase().includes(kw);
        const inSource = (item.source && item.source.name || '').toLowerCase().includes(kw);
        return inContent || inSource;
      });

  if (!filtered.some(item => item.id === selectedId)) {
    const idx = typeof preferredIndex === 'number'
      ? Math.max(0, Math.min(preferredIndex, filtered.length - 1))
      : 0;
    selectedId = filtered[idx] ? filtered[idx].id : null;
  }
  render();
}

function moveSelection(delta) {
  if (filtered.length === 0) return;
  const current = filtered.findIndex(item => item.id === selectedId);
  const next = Math.max(0, Math.min(filtered.length - 1, (current < 0 ? 0 : current) + delta));
  setSelection(filtered[next].id);
}

function selectedItem() {
  return filtered.find(item => item.id === selectedId) || null;
}

function pasteSelected() {
  const item = selectedItem();
  if (item) window.clipAPI.pasteItem(item.id);
}

function copySelected() {
  const item = selectedItem();
  if (!item) return;
  window.clipAPI.copyItem(item.id);
  // 复制后停留 200ms 让用户看到反馈，再收起
  setTimeout(() => window.clipAPI.hideWindow(), 220);
}

function removeItem(id) {
  pendingDeleteIndex = filtered.findIndex(item => item.id === id);
  window.clipAPI.deleteItem(id);
}

// ============ 主进程事件 ============
window.clipAPI.onHistory((data) => {
  items = Array.isArray(data) ? data : [];
  applyFilter(pendingDeleteIndex);
  pendingDeleteIndex = null;
});

window.clipAPI.onShown(() => {
  searchKeyword = '';
  searchInput.value = '';
  selectedId = null;
  pendingDeleteIndex = null;
  applyFilter();
});

// ============ 键盘 ============
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    window.clipAPI.hideWindow();
    return;
  }

  const typing = document.activeElement === searchInput;

  if (typing) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      searchInput.blur();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      searchInput.blur();
      pasteSelected();
      return;
    }
    return;
  }

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    moveSelection(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    moveSelection(-1);
  } else if (e.key === 'Home') {
    e.preventDefault();
    if (filtered[0]) setSelection(filtered[0].id);
  } else if (e.key === 'End') {
    e.preventDefault();
    if (filtered.length) setSelection(filtered[filtered.length - 1].id);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pasteSelected();
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    if (selectedId) removeItem(selectedId);
  } else if (e.metaKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    copySelected();
  } else if (e.key === '/' || (e.metaKey && e.key.toLowerCase() === 'f')) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (/^[1-9]$/.test(e.key)) {
    const idx = parseInt(e.key, 10) - 1;
    if (filtered[idx]) {
      setSelection(filtered[idx].id);
      window.clipAPI.pasteItem(filtered[idx].id);
    }
  }
});

searchInput.addEventListener('input', (e) => {
  searchKeyword = e.target.value;
  applyFilter(0);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (searchKeyword) {
      searchKeyword = '';
      searchInput.value = '';
      applyFilter(0);
    } else {
      window.clipAPI.hideWindow();
    }
  }
});

clearBtn.addEventListener('click', () => {
  if (items.length === 0) return;
  if (confirm(`确认清空全部 ${items.length} 条剪贴板记录？`)) {
    window.clipAPI.clearHistory();
  }
});

// 每 20 秒只刷新时间文案，不重建卡片
setInterval(() => {
  cardList.querySelectorAll('.time[data-ts]').forEach(el => {
    const ts = Number(el.dataset.ts);
    if (ts) el.textContent = formatTime(ts);
  });
}, 20000);
