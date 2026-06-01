let history = [];
let filtered = [];
let selectedIndex = 0;
let searchKeyword = '';

const cardList = document.getElementById('cardList');
const searchInput = document.getElementById('searchInput');
const clearBtn = document.getElementById('clearBtn');

function formatTime(ts) {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  return `${day} 天前`;
}

function detectType(item) {
  if (item.type === 'image') return 'image';
  const txt = (item.content || '').trim();
  if (/^https?:\/\//i.test(txt) && txt.length < 500 && !txt.includes('\n')) return 'link';
  return 'text';
}

function getTitle(item) {
  if (item.type === 'image') return '图片';
  const sub = detectType(item);
  if (sub === 'link') return '链接';
  return '文本';
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function render() {
  cardList.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = searchKeyword ? '未找到匹配项' : '暂无剪贴板记录，复制一些内容试试吧 ✨';
    cardList.appendChild(empty);
    return;
  }

  filtered.forEach((item, i) => {
    const sub = detectType(item);
    const card = document.createElement('div');
    card.className = `card type-${sub}`;
    if (i === selectedIndex) card.classList.add('selected');
    card.dataset.index = i;

    let bodyHtml = '';
    if (item.type === 'image') {
      bodyHtml = `<img src="${item.content}" />`;
    } else {
      bodyHtml = escapeHtml(item.preview || item.content || '');
    }

    const charLen = item.type === 'text' ? `${item.length || (item.content || '').length} 个字符` : '图片';

    card.innerHTML = `
      <div class="card-header">
        <span class="title">${getTitle(item)}</span>
        <span class="time">${formatTime(item.timestamp)}</span>
      </div>
      <div class="card-body">${bodyHtml}</div>
      <div class="card-footer">
        <span>${charLen}</span>
        <span class="card-index">≡ ${i + 1}</span>
      </div>
    `;

    card.addEventListener('click', () => {
      selectedIndex = i;
      pasteSelected();
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.clipAPI.deleteItem(item.timestamp);
    });

    cardList.appendChild(card);
  });

  // 滚动到选中项
  const selected = cardList.querySelector('.card.selected');
  if (selected) {
    selected.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
}

function applyFilter() {
  if (!searchKeyword) {
    filtered = history.slice();
  } else {
    const kw = searchKeyword.toLowerCase();
    filtered = history.filter(h => {
      if (h.type === 'image') return false;
      return (h.content || '').toLowerCase().includes(kw);
    });
  }
  if (selectedIndex >= filtered.length) selectedIndex = Math.max(0, filtered.length - 1);
  render();
}

function pasteSelected() {
  if (filtered.length === 0) return;
  const item = filtered[selectedIndex];
  if (!item) return;
  window.clipAPI.pasteItem(item);
}

function deleteSelected() {
  if (filtered.length === 0) return;
  const item = filtered[selectedIndex];
  if (!item) return;
  window.clipAPI.deleteItem(item.timestamp);
}

window.clipAPI.onHistory((data) => {
  history = data || [];
  selectedIndex = 0;
  applyFilter();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.clipAPI.hideWindow();
    return;
  }

  if (document.activeElement === searchInput) {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      searchInput.blur();
      if (e.key === 'Enter') pasteSelected();
      return;
    }
    return;
  }

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (selectedIndex < filtered.length - 1) {
      selectedIndex++;
      render();
    }
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (selectedIndex > 0) {
      selectedIndex--;
      render();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pasteSelected();
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    deleteSelected();
  } else if (e.key === '/' || (e.metaKey && e.key === 'f')) {
    e.preventDefault();
    searchInput.focus();
  } else if (/^[1-9]$/.test(e.key)) {
    const idx = parseInt(e.key, 10) - 1;
    if (idx < filtered.length) {
      selectedIndex = idx;
      pasteSelected();
    }
  }
});

searchInput.addEventListener('input', (e) => {
  searchKeyword = e.target.value;
  selectedIndex = 0;
  applyFilter();
});

clearBtn.addEventListener('click', () => {
  if (confirm('确认清空所有剪贴板历史？')) {
    window.clipAPI.clearHistory();
  }
});

// 每30秒刷新时间显示
setInterval(() => {
  if (filtered.length > 0) render();
}, 30000);
