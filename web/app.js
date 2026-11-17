import { createCatalog } from './catalog.js';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

import { initFx, fx, sweep } from './fx.js';
import { applyI18n, setLang, getLang, Tpl, T } from './i18n.js';

const state = {
  config: null,
  versions: [],
  javas: [],
  running: null,
  selected: '',
  remote: null,
  contentKind: 'mods',
  content: null,
  installBusy: false,
  logSpawned: false,
};

const catalog = createCatalog({ api, enqueue: input => enqueueInstall(input), selected: () => state.selected, context: async () => {
  if (!state.selected) return {};
  return api('/api/market/context?version=' + encodeURIComponent(state.selected));
} });
/* ---------------- 基础工具 ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  try { const data = JSON.parse(text); if (data.report) showErrorReport(data.report); return data; } catch { return { error: text }; }
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${isErr ? ' err' : ''}`;
  fx.play(isErr ? 'err' : 'ok');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------------- 视图切换 ---------------- */

async function loadChangelog(force) {
  const box = document.getElementById('changelog-list');
  if (!box) return;
  if (!force && box.dataset.loaded === '1') return;
  box.innerHTML = '<p class="hint-line">正在拉取更新日志…</p>';
  try {
    const r = await (await fetch('/api/changelog?limit=8')).json();
    if (!r.ok) throw new Error(r.error || '拉取失败');
    const list = r.list || [];
    if (!list.length) { box.innerHTML = '<p class="hint-line">还没有发布记录。</p>'; return; }
    box.innerHTML = list.map((it) => {
      const date = (it.publishedAt || '').slice(0, 10);
      const body = String(it.body || '').replace(/</g, '&lt;').slice(0, 400);
      return '<div class="changelog-item">'
        + '<h4><span class="cl-tag">' + (it.tag || '') + '</span>' + (it.name || '').replace(/</g, '&lt;')
        + '<span class="cl-date">' + date + '</span></h4>'
        + '<pre>' + body + '</pre></div>';
    }).join('');
    box.dataset.loaded = '1';
  } catch (e) {
    box.innerHTML = '<p class="hint-line">拉取失败：' + String(e.message || e) + '</p>';
  }
}

function showView(name) {
  state.view = name;
  $('.nav-btn[data-view]').forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  const titles = { home: '启动', download: '下载', content: '内容', worlds: '存档', servers: '服务器', skins: '皮肤', settings: '设置', more: '更多' };
  $('#crumb').textContent = titles[name] ?? name;
  sweep();
  if (name === 'download' && !state.remote) loadRemote();
  if (name === 'content') loadContent();
  if (name === 'worlds') loadWorlds();
  if (name === 'servers') loadServers();
  if (name === 'servers') startLanPoll(); else stopLanPoll();
  if (name === 'skins') loadSkins();
  if (name === 'settings') loadPaths();
  if (name === 'more') loadMore();
  if (name === 'download') startTaskPoll(); else stopTaskPoll();
  applyI18n();
}

/* ---------------- 版本列表 ---------------- */
/** 版本卡的菜单项（右键和「⋯」共用） */
function versionMenuItems(id) {
  return [
    { label: T('启动此版本'), onClick: async () => { await selectVersion(id); doLaunch(); } },
    { label: T('设为当前版本'), onClick: () => selectVersion(id) },
    { sep: true },
    { label: T('版本设置'), onClick: async () => { await selectVersion(id); showView('settings'); $('#vs-name')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } },
    { label: T('打开版本目录'), onClick: () => api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: `${state.config.mcDir}\\versions\\${id}` }) }) },
    { label: T('校验并修复'), onClick: () => askRepair(id) },
    { label: T('复制此版本'), onClick: () => duplicateVersion(id) },
    { label: T('重命名'), onClick: () => openRename(id) },
    { sep: true },
    { label: T('删除此版本'), danger: true, onClick: () => askDelete(id) },
  ];
}

function renderVersions() {
  const box = $('#version-cards');
  const kw = $('#search-version').value.trim().toLowerCase();
  const list = state.versions.filter((v) => !kw || v.id.toLowerCase().includes(kw));
  // 最近玩过的排前面，没玩过的按目录修改时间新的在前（PCL2 的习惯）
  const lpMap = state.config?.lastPlayed ?? {};
  list.sort((a, b) => (lpMap[b.id] || 0) - (lpMap[a.id] || 0) || (b.mtime || 0) - (a.mtime || 0));
  if (!list.length) {
    box.innerHTML = `<div class="empty">没有找到版本${kw ? '，试试别的关键词' : '，去「下载」页装一个吧'}</div>`;
    return;
  }
  box.innerHTML = list.map((v) => {
    const tags = [];
    if (v.type === 'release') tags.push('<span class="tag release">正式版</span>');
    else if (v.type === 'snapshot') tags.push('<span class="tag snapshot">快照</span>');
    else tags.push(`<span class="tag">${v.type}</span>`);
    if (v.loader && v.loader !== '原版') tags.push(`<span class="tag ${v.loader.toLowerCase()}">${v.loader}</span>`);
    // 加载器版本与整合包本身没有 jar，靠 inheritsFrom 继承父版本，不该标「缺主文件」
    if (!v.hasJar && v.inheritsFrom) tags.push(`<span class="tag">${escapeHtml(Tpl('继承 {v}', { v: v.inheritsFrom }))}</span>`);
    else if (!v.hasJar) tags.push('<span class="tag missing">缺主文件</span>');
    // 上次非正常退出：在卡片上直接说出原因，不用再点进崩溃分析
    const lc = state.config?.lastCrash?.[v.id];
    if (lc) tags.push(`<span class="tag crash" title="${escapeAttr(`${lc.file || ''}\n${lc.exception || ''}`)}">${escapeHtml(Tpl('上次崩溃：{v}', { v: lc.title || '原因未知' }))}</span>`);
    return `
      <div class="card ${v.id === state.selected ? 'selected' : ''}" data-id="${escapeAttr(v.id)}"
           data-loader="${escapeAttr(String(v.loader || '原版').toLowerCase())}" data-jar="${v.hasJar ? '1' : '0'}">
        <div class="card-actions">
          <button class="tiny-btn card-more" data-act="menu" title="更多操作">⋯</button>
        </div>
        <div class="card-title">${escapeHtml(v.id)}</div>
        <div class="card-tags">${tags.join('')}</div>
        <div class="card-sub"><span>${fmtDate(v.releaseTime)}</span><span>${fmtSize(v.jarSize)}</span></div>
        ${relTime(state.config?.lastPlayed?.[v.id]) ? `<div class="card-last">${escapeHtml(Tpl('最近游玩 {v}', { v: relTime(state.config.lastPlayed[v.id]) }))}</div>` : ''}
      </div>`;
  }).join('');

  $$('#version-cards .card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.tiny-btn')) return;
      selectVersion(card.dataset.id);
    });
    // 双击卡片 = 选中并启动（PCL2 习惯）
    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tiny-btn')) return;
      selectVersion(card.dataset.id).then(() => doLaunch());
    });
    // 右键菜单
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, versionMenuItems(card.dataset.id));
    });
    card.querySelector('[data-act="menu"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(Math.max(8, r.right - 190), r.bottom + 4, versionMenuItems(card.dataset.id));
    });
    card.querySelector('[data-act="settings"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await selectVersion(card.dataset.id);
      showView('settings');
      const box = $('#vs-name');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    card.querySelector('[data-act="folder"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: `${state.config.mcDir}\\versions\\${card.dataset.id}` }) });
    });
    card.querySelector('[data-act="del"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = card.dataset.id;
      if (!confirm(`确定删除版本「${id}」？此操作不可撤销。`)) return;
      const r = await api('/api/delete-version', { method: 'POST', body: JSON.stringify({ id }) });
      if (r.ok) { toast('已删除'); await refresh(); }
      else toast(r.error || '删除失败', true);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - Number(ts);
  const en = getLang() === 'en';
  if (d < 60 * 1000) return en ? 'just now' : '刚刚';
  if (d < 3600 * 1000) { const n = Math.floor(d / 60000); return en ? `${n} min ago` : `${n} 分钟前`; }
  if (d < 86400 * 1000) { const n = Math.floor(d / 3600000); return en ? `${n} h ago` : `${n} 小时前`; }
  if (d < 30 * 86400 * 1000) { const n = Math.floor(d / 86400000); return en ? `${n} days ago` : `${n} 天前`; }
  return fmtDate(ts);
}

/* ---------------- 右键菜单 ---------------- */
let menuEl = null;
function closeMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
}
/* ---------------- 重命名版本 ---------------- */
let rnId = null;
async function duplicateVersion(id) {
  const r = await api('/api/duplicate-version', { method: 'POST', body: JSON.stringify({ id }) });
  if (!r.ok) { toast(r.error || '复制失败', true); return; }
  toast(`已复制为 ${r.id}（${r.files} 个文件），存档和日志没有带过去`);
  await refresh();
}

function openRename(id) {
  rnId = id;
  $('#rn-old').textContent = id;
  const input = $('#rn-input');
  input.value = id;
  $('#rn-mask').hidden = false;
  setTimeout(() => { input.focus(); input.select(); }, 30);
}
function closeRename() { $('#rn-mask').hidden = true; rnId = null; }
async function submitRename() {
  const newId = ($('#rn-input').value || '').trim();
  if (!rnId) return;
  if (!newId) { toast('新名称不能为空', true); return; }
  if (newId === rnId) { closeRename(); return; }
  const btn = $('#rn-go');
  btn.disabled = true;
  try {
    const r = await api('/api/rename-version', { method: 'POST', body: JSON.stringify({ id: rnId, newId }) });
    if (!r.ok) throw new Error(r.error || '重命名失败');
    closeRename();
    toast(`已重命名为 ${r.id}`);
    await refresh();
    if (state.selected === r.id) await renderHero();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function openMenu(x, y, items) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.innerHTML = items.map((it, i) => it.sep
    ? '<div class="ctx-sep"></div>'
    : `<button class="ctx-item${it.danger ? ' danger' : ''}" data-i="${i}">${escapeHtml(it.label)}</button>`).join('');
  document.body.appendChild(el);
  menuEl = el;
  const r = el.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - 8);
  const top = Math.min(y, window.innerHeight - r.height - 8);
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.ctx-item');
    if (!b) return;
    const it = items[Number(b.dataset.i)];
    closeMenu();
    it?.onClick?.();
  });
  setTimeout(() => {
    const off = (ev) => { if (!el.contains(ev.target)) { closeMenu(); document.removeEventListener('pointerdown', off); } };
    document.addEventListener('pointerdown', off);
  }, 0);
}
document.addEventListener('keydown', (e) => {
  // Ctrl+F：回到启动页并聚焦版本搜索（PCL2 里是搜索框，这里对齐这个手感）
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    const box = document.querySelector('#search-version');
    if (box) {
      e.preventDefault();
      showView('home');
      box.focus();
      box.select();
      return;
    }
  } if (e.key === 'Escape') closeMenu(); });

async function askRepair(id) {
  toast(`正在校验 ${id}…`);
  const r = await api('/api/repair', { method: 'POST', body: JSON.stringify({ id }) });
  if (r.ok) { toast(`${id} 校验完成`); await refresh(); }
  else toast(r.error || '修复失败', true);
}

async function askDelete(id) {
  if (!confirm(`确定删除版本「${id}」？此操作不可撤销。`)) return;
  const r = await api('/api/delete-version', { method: 'POST', body: JSON.stringify({ id }) });
  if (r.ok) { toast('已删除'); await refresh(); }
  else toast(r.error || '删除失败', true);
}

/* ---------------- 版本详情（带缓存，避免每次渲染都闪一下） ---------------- */
async function inspectVersionClient(id, force = false) {
  state.inspect = state.inspect ?? {};
  const hit = state.inspect[id];
  const now = Date.now();
  if (!force && hit && now - hit.at < 8000) return hit.data;
  const data = await api(`/api/inspect?id=${encodeURIComponent(id)}`);
  state.inspect[id] = { at: now, data };
  return data;
}

function inspectCacheReset(id) {
  if (state.inspect && id) delete state.inspect[id];
}

async function selectVersion(id) {
  state.selected = id;
  state.config.selectedVersion = id;
  renderVersions();
  await renderHero();
  // 记住这次选择，下次打开还是这个版本
  api('/api/config', { method: 'POST', body: JSON.stringify({ selectedVersion: id }) }).catch(() => {});
  if ($('#view-content').classList.contains('active')) loadContent();
  fillVersionSettings();
}

/* ---------------- 版本下拉（启动按钮旁边） ---------------- */
function renderVersionPicker() {
  const sel = $('#ver-pick');
  if (!sel) return;
  const cur = state.selected || '';
  sel.innerHTML = ['<option value="">切换版本…</option>']
    .concat(state.versions.map((v) => `<option value="${escapeAttr(v.id)}">${escapeHtml(v.id)}</option>`))
    .join('');
  sel.value = cur;
}

async function renderHero() {
  const id = state.selected;
  $('#hero-version').textContent = id || '未选择版本';
  renderVersionPicker();
  if (!id) {
    $('#hero-meta').textContent = '请选择已安装的游戏版本';
    $('#btn-launch').disabled = true;
    return;
  }
  const v = state.versions.find((x) => x.id === id);
  if (!$('#hero-meta').textContent || $('#hero-meta').textContent.startsWith('正在')) {
    $('#hero-meta').textContent = '正在读取版本信息…';
  }
  const info = await inspectVersionClient(id);
  const bits = [];
  bits.push(v?.loader ?? '原版');
  bits.push(T(v?.type === 'snapshot' ? '快照' : '正式版'));
  bits.push(Tpl('需要 Java {v}', { v: info.needJava ?? '?' }));
  if (info.java) bits.push(Tpl('当前 Java {v}', { v: info.java.major }));
  if (v?.hasJar) bits.push(fmtSize(v.jarSize));
  else if (v?.inheritsFrom) bits.push(Tpl('继承 {v}', { v: v.inheritsFrom }));
  $('#hero-meta').textContent = bits.join(' · ');
  const missing = info.missing ?? [];
  const launchable = missing.length === 0;
  $('#btn-launch').disabled = !launchable;
  $('#btn-launch').title = launchable ? '' : `缺少：${missing.join('、')}`;
  if (missing.length) {
    $('#hero-meta').innerHTML = `${bits.join(' · ')} · <span style="color:var(--err)">缺少 ${escapeHtml(missing.join('、'))}</span>`;
  }
  const fix = $('#hero-fix');
  if (fix) {
    fix.hidden = !missing.length;
    if (missing.length) {
      const needJavaFix = missing.some((m) => String(m).includes('Java')) && info.needJava;
      fix.textContent = needJavaFix ? Tpl('安装 Java {v}', { v: info.needJava }) : Tpl('缺 {n} 项 · 一键修复', { n: missing.length });
      fix.title = `缺少：${missing.join('、')}`;
    }
  }
}

/* ---------------- 启动 / 停止 ---------------- */
async function doLaunch(force = false) {
  if (!state.selected) { toast('先选一个版本', true); return; }
  $('#btn-launch').disabled = true;
  $('#log').classList.remove('collapsed');
  $('#btn-toggle-log').textContent = '收起';
  appendLog({ type: 'system', text: `[TPCL] 正在启动 ${state.selected}…\n` });

  const r = await api('/api/launch', { method: 'POST', body: JSON.stringify({ versionId: state.selected, force }) });
  if (!r.ok) {
    appendLog({ type: 'error', text: `[TPCL] ${r.error}\n` });
    toast(r.error || '启动失败', true);
    $('#btn-launch').disabled = false;
    if (r.code === 'INCOMPLETE') {
      // Java 版本不匹配属于「能试一把」的情况；文件缺失才建议去补全
      if (/Java\s*\d/.test(r.error || '')) {
        if (confirm(`${r.error}\n\n仍然强行启动吗？（可能直接崩，但有时候也能跑起来）`)) return doLaunch(true);
        return;
      }
      showView('download');
      if (confirm('版本不完整，是否立即补全下载？')) startInstall(state.selected, false);
    }
    return;
  }
  state.running = { id: state.selected };
  $('#btn-stop').hidden = false;
  toast('游戏已启动');
  setTimeout(refresh, 800);
}

async function doStop() {
  const ids = (state.games || []).map((g) => g.id);
  const target = ids.includes(state.selected) ? state.selected : (ids[ids.length - 1] || '');
  try {
    const r = await api('/api/stop', { method: 'POST', body: JSON.stringify({ versionId: target }) });
    if (r && r.ok === false) toast(r.error || '停止失败', true);
  } catch (e) {
    toast(String(e.message || e), true);
  }
}

/* ---------------- 日志 ---------------- */
const LOG_LEVEL_RE = {
  fatal: /\b(FATAL|SEVERE|CRITICAL)\b/,
  error: /\bERROR\b|\bException\b|\bat [\w.$]+\(/,
  warn: /\bWARN(ING)?\b/,
};

function logLevelOf(text, type) {
  const s = String(text || '');
  if (LOG_LEVEL_RE.fatal.test(s)) return 'fatal';
  if (type === 'stderr' || LOG_LEVEL_RE.error.test(s)) return 'error';
  if (LOG_LEVEL_RE.warn.test(s)) return 'warn';
  return 'info';
}

function paintLogCounts() {
  const el = $('#log-counts');
  if (!el) return;
  el.innerHTML = `警告 <b>${state.logWarn || 0}</b> · 错误 <i>${state.logError || 0}</i>`;
}

function setLogFilter(mode) {
  const pre = $('#log');
  if (!pre) return;
  pre.classList.toggle('only-warn', mode === 'warn');
  pre.classList.toggle('only-error', mode === 'error');
  document.querySelectorAll('#log-filter [data-lf]').forEach((b) => {
    b.classList.toggle('on', b.dataset.lf === mode);
  });
  state.logFilter = mode;
}

function appendLog(e) {
  const pre = $('#log');
  const span = document.createElement('span');
  span.className = `l-${e.type || 'stdout'}`;
  const lv = logLevelOf(e.text, e.type);
  if (lv !== 'info') span.classList.add(`lv-${lv}`);
  if (lv === 'warn') state.logWarn = (state.logWarn || 0) + 1;
  if (lv === 'error' || lv === 'fatal') state.logError = (state.logError || 0) + 1;
  span.textContent = e.text;
  pre.appendChild(span);
  if (pre.childNodes.length > 4000) pre.removeChild(pre.firstChild);
  if (lv !== 'info') paintLogCounts();
  pre.scrollTop = pre.scrollHeight;
}

function connectLogs() {
  if (state.logSpawned) return;
  state.logSpawned = true;
  const es = new EventSource('/api/logs');
  es.addEventListener('log', (ev) => appendLog(JSON.parse(ev.data)));
  es.addEventListener('upd', (ev) => onUpdEvent(JSON.parse(ev.data)));
  es.addEventListener('exit', (ev) => {
    const d = JSON.parse(ev.data);
    const desc = d.code === null || d.code === undefined
      ? `进程被终止（${d.signal ?? '未知信号'}）`
      : `退出码 ${d.code}`;
    appendLog({ type: 'system', text: `\n[TPCL] ${desc}\n` });
    state.running = null;
    $('#btn-stop').hidden = true;
    $('#btn-launch').disabled = false;
    refresh();
    // 非正常退出就自动弹崩溃分析（PCL2 的做法）
    if (d.code !== 0 && d.code !== null) {
      setTimeout(() => openCrash(true), 700);
    }
  });
  es.onerror = () => { /* 浏览器会自动重连 */ };
}

/* ---------------- 远程版本 / 安装 ---------------- */
async function loadRemote(force = false) {
  const box = $('#remote-list');
  // 想看到快照/远古版本就必须拿到完整清单，所以这里固定要全量
  const snap = '1';
  const cacheKey = `tpcl-remote-${snap}`;

  // 先用缓存秒开，再在后台刷新
  if (!force) {
    try {
      const c = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (c && Date.now() - c.at < 30 * 60 * 1000 && c.data?.versions?.length) {
        state.remote = c.data;
        renderRemote();
      }
    } catch { /* 忽略坏缓存 */ }
  }
  if (!state.remote) box.innerHTML = '<div class="empty">正在获取版本列表…</div>';

  try {
    const data = await api(`/api/remote-versions?snapshots=${snap}${force ? '&t=' + Date.now() : ''}`);
    if (!data.versions) throw new Error(data.error || '获取失败');
    state.remote = data;
    try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data })); } catch { /* 配额满了就算了 */ }
    renderRemote();
  } catch (e) {
    if (!state.remote) box.innerHTML = `<div class="empty">获取失败：${escapeHtml(e.message)}</div>`;
    else toast('刷新版本列表失败，显示的是缓存', true);
  }
}

function renderRemote() {
  const box = $('#remote-list');
  const kw = $('#search-remote').value.trim().toLowerCase();
  const installed = new Set(state.versions.map((v) => v.id));
  const ft = state.dlFilter || 'all';
  const list = (state.remote?.versions ?? []).filter((v) => {
    if (kw && !v.id.toLowerCase().includes(kw)) return false;
    if (ft === 'all') return true;
    if (ft === 'old') return v.type === 'old_beta' || v.type === 'old_alpha';
    return v.type === ft;
  });
  if (!list.length) { box.innerHTML = '<div class="empty">没有匹配的版本</div>'; return; }
  box.innerHTML = list.slice(0, 1200).map((v) => {
    const typeTag = v.type === 'release'
      ? '<span class="tag release">正式版</span>'
      : (v.type === 'snapshot' ? '<span class="tag snapshot">快照</span>'
        : `<span class="tag old">${v.type === 'old_beta' ? '远古 Beta' : '远古 Alpha'}</span>`);
    return `
    <div class="row-item ver-row">
      <span class="ver-ico" data-major="${escapeAttr(majorOf(v.id))}">${escapeHtml(majorOf(v.id))}</span>
      <div class="row-main">
        <div class="row-title">
          ${escapeHtml(v.id)}
          ${typeTag}
          ${installed.has(v.id) ? '<span class="tag">已安装</span>' : ''}
        </div>
        <div class="row-sub">${fmtDate(v.releaseTime)}${v.type.startsWith('old_') ? ' · 需要老版本 Java，可能无法直接启动' : ''}</div>
      </div>
      <button class="mini-btn" data-install="${escapeAttr(v.id)}">${installed.has(v.id) ? '补全' : '安装'}</button>
    </div>`;
  }).join('');

  $$('[data-install]', box).forEach((b) => {
    b.addEventListener('click', () => askInstall(b.dataset.install));
  });
}

// "1.21.1" -> "1.21"，"26.3" -> "26.3"，"1.20.1-pre2" -> "1.20"
function majorOf(id) {
  const m = /^(\d+)\.(\d+)/.exec(id);
  return m ? `${m[1]}.${m[2]}` : id.slice(0, 4);
}

// 安装确认弹窗（替代直接开装）
function askInstall(id) {
  state.pendingInstall = id;
  $('#inst-name').textContent = id;
  const ico = $('#inst-ico');
  ico.textContent = majorOf(id);
  ico.dataset.major = majorOf(id);
  const already = state.versions.some((v) => v.id === id);
  $('#inst-note').textContent = already
    ? '这个版本已经在列表里，安装会补齐缺失的文件。'
    : '将下载客户端主文件、依赖库与资源文件。';
  $('#inst-skipassets').checked = false;
  $('#inst-mask').hidden = false;
}

function closeInstallAsk() {
  $('#inst-mask').hidden = true;
  state.pendingInstall = null;
}

function startInstall(id, skipAssets) {
  return enqueueInstall({ type: 'version', id, skipAssets });
}

/* ---------------- 加载器（Forge / NeoForge / Fabric） ---------------- */
const LOADER_NAME = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric' };

/** "1.21.1-forge-52.1.21" / "fabric-loader-0.20.1-1.21.1" → "1.21.1" */
function baseMcOf(id) {
  if (!id) return '';
  const fab = id.match(/^fabric-loader-[^-]+-(.+)$/i);
  if (fab) return fab[1];
  const ld = id.match(/^(.+?)[-_](?:forge|neoforge)[-_]/i);
  if (ld) return ld[1];
  return id;
}

function showDlTab(name) {
  state.dlTab = name;
  const onlinePack = name === 'packs';
  $('#catalog-title').textContent = onlinePack ? '整合包目录' : '模组与资源';
  $$('#dl-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.dl === name));
  $('#dl-vanilla').hidden = name !== 'vanilla';
  $('#dl-loader').hidden = !['forge', 'neoforge', 'fabric', 'quilt'].includes(name);
  $('#dl-modpack').hidden = name !== 'modpack';
  $('#dl-market').hidden = !['market', 'packs'].includes(name);
  const ofBox = document.getElementById('dl-optifine');
  if (ofBox) ofBox.hidden = name !== 'optifine';
  if (name === 'optifine') loadOptifinePanel();

  if (['forge', 'neoforge', 'fabric', 'quilt'].includes(name)) {
    state.loaderKind = name;
    fillMcSuggest();
    const box = $('#ld-mc');
    if (!box.value || box.value === '__manual') {
      const want = baseMcOf(state.selected) || '1.21.1';
      if (![...box.options].some((o) => o.value === want)) {
        box.insertAdjacentHTML('afterbegin', `<option value="${escapeAttr(want)}">${escapeHtml(want)}</option>`);
      }
      box.value = want;
      $('#ld-mc-manual').hidden = true;
    }
    loadLoaderVersions();
  }
  if (name === 'vanilla' && !state.remote) loadRemote();
  if (name === 'market' || onlinePack) { $('#mk-type').value = onlinePack ? 'modpack' : 'mod'; catalog.search(); }
}

/* ---------------- OptiFine ---------------- */
async function loadOptifinePanel() {
  const sel = document.getElementById('of-version');
  if (!sel) return;
  if (!sel.dataset.filled) {
    const list = (state.versions ?? []).filter((v) => ['forge', 'neoforge', 'fabric', 'quilt'].includes(String(v.loader || '').toLowerCase()));
    const cur = state.selected && list.some((v) => v.id === state.selected) ? state.selected : (list[0]?.id ?? '');
    sel.innerHTML = list.length
      ? list.map((v) => `<option value="${escapeAttr(v.id)}">${escapeHtml(v.id)}</option>`).join('')
      : '<option value="">没有 Forge / NeoForge 版本</option>';
    if (cur) sel.value = cur;
    sel.dataset.filled = '1';
  }
  await fetchOptifineList();
}

async function fetchOptifineList() {
  const sel = document.getElementById('of-version');
  const box = document.getElementById('of-list');
  const hint = document.getElementById('of-hint');
  if (!sel || !box) return;
  const version = sel.value;
  if (!version) {
    box.innerHTML = '<div class="empty-state" style="padding:28px"><b>先装一个 Forge / NeoForge 版本</b><div class="hint-line">OptiFine 在这里是作为 mod 装进已有版本的</div></div>';
    return;
  }
  box.innerHTML = '<div class="hint-line" style="padding:14px">正在获取 OptiFine 列表…</div>';
  try {
    const r = await api(`/api/optifine?version=${encodeURIComponent(version)}`);
    if (!r.ok || !r.compat?.ok) {
      box.innerHTML = `<div class="empty-state" style="padding:28px"><b>这个版本装不了</b><div class="hint-line">${escapeHtml(r.reason || r.compat?.reason || '未知原因')}</div></div>`;
      if (hint) hint.textContent = '';
      return;
    }
    const list = r.list ?? [];
    if (hint) hint.textContent = `MC ${r.mc} · 共 ${list.length} 个构建`;
    const installed = new Set((r.installed ?? []).map((x) => x.name));
    box.innerHTML = list
      .map(
        (x) => `<div class="row-item of-row" data-type="${escapeAttr(x.type)}" data-patch="${escapeAttr(x.patch)}">
          <div class="row-main">
            <b>${escapeHtml(x.label)}</b>
            <span class="hint-line">${escapeHtml(x.filename)}${x.forge ? ' · 对应 ' + escapeHtml(x.forge) : ''}</span>
          </div>
          ${installed.has(x.filename) ? '<span class="chip ok">已安装</span>' : `<button class="mini-btn accent btn-of-install">安装</button>`}
        </div>`
      )
      .join('');
    box.querySelectorAll('.btn-of-install').forEach((btn) => {
      btn.addEventListener('click', () => installOptifine(btn));
    });
  } catch (e) {
    box.innerHTML = `<div class="hint-line" style="padding:14px">获取失败：${escapeHtml(String(e.message || e))}</div>`;
  }
}

async function installOptifine(btn) {
  const row = btn.closest('.of-row');
  const sel = document.getElementById('of-version');
  const status = document.getElementById('of-status');
  if (!row || !sel) return;
  const version = sel.value;
  btn.disabled = true;
  btn.textContent = '下载中…';
  try {
    const r = await api('/api/optifine/install', {
      method: 'POST',
      body: JSON.stringify({ version, type: row.dataset.type, patch: row.dataset.patch }),
    });
    if (r.ok) {
      btn.outerHTML = '<span class="chip ok">已安装</span>';
      if (status) status.textContent = `${r.label} 已装进 ${version} 的 mods${r.skipped ? '（之前就装过）' : `（${(r.size / 1048576).toFixed(1)} MB）`}，重启游戏生效`;
      toast('OptiFine 安装完成');
    } else {
      btn.disabled = false;
      btn.textContent = '安装';
      toast(r.error || '安装失败');
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '安装';
    toast('安装失败：' + (e.message || e));
  }
}

function fillMcSuggest() {
  const box = $('#ld-mc');
  const inst = new Set();
  for (const v of state.versions ?? []) {
    const b = baseMcOf(v.id);
    // 只收纯 MC 版本号；加载器版本自身（如 neoforge-21.1.80）不能当游戏版本用
    if (b && /^\d+\.\d+(\.\d+)?$/.test(b)) inst.add(b);
  }
  const remote = new Set();
  for (const v of (state.remote?.versions ?? []).slice(0, 80)) { if (!inst.has(v.id)) remote.add(v.id); }
  const cur = box.value;
  box.innerHTML = [
    '<option value="">选择版本…</option>',
    inst.size ? `<optgroup label="已安装">${[...inst].sort().reverse().map((id) => `<option value="${escapeAttr(id)}">${escapeHtml(id)}</option>`).join('')}</optgroup>` : '',
    remote.size ? `<optgroup label="可下载">${[...remote].slice(0, 16).map((id) => `<option value="${escapeAttr(id)}">${escapeHtml(id)}</option>`).join('')}</optgroup>` : '',
    '<option value="__manual">手动输入…</option>',
  ].join('');
  if (cur && [...box.options].some((o) => o.value === cur)) box.value = cur;
}

/** 加载器面板里选中的游戏版本（支持手动输入回退） */
function ldMcValue() {
  const sel = $('#ld-mc').value;
  if (sel === '__manual') return $('#ld-mc-manual').value.trim();
  return sel.trim();
}

function ldHint(text) {
  $('#ld-hint').textContent = text;
}

let loaderReqSeq = 0;
async function loadLoaderVersions() {
  const mc = ldMcValue();
  const kind = state.loaderKind || 'forge';
  const box = $('#ld-list');
  if (!mc) {
    box.innerHTML = '<div class="empty-hint">先选游戏版本</div>';
    return;
  }
  const seq = ++loaderReqSeq;
  box.innerHTML = '<div class="empty-hint">正在读取版本列表…</div>';
  ldHint(`${LOADER_NAME[kind]} ${mc}：读取版本列表…`);
  try {
    const d = await api(`/api/loaders?kind=${kind}&mc=${encodeURIComponent(mc)}`);
    if (seq !== loaderReqSeq) return;
    if (d.error) throw new Error(d.error);
    const vs = d.versions ?? [];
    if (!vs.length) {
      box.innerHTML = `<div class="empty-hint">${LOADER_NAME[kind]} 没有 ${mc} 的版本</div>`;
      ldHint(`${LOADER_NAME[kind]} 暂不支持 ${mc}（或列表接口不可用）。`);
      return;
    }
    const all = vs.slice(0, 300);
    const show = state.loaderExpanded ? all : all.slice(0, 30);
    const rowHtml = (v) => {
      const tags = [];
      if (v === d.recommended) tags.push('<span class="tag rec">推荐</span>');
      else if (v === d.latest) tags.push('<span class="tag">最新</span>');
      return `<div class="ld-row">
        <span class="ld-name">${escapeHtml(v)}</span>
        <span class="ld-tags">${tags.join('')}</span>
        <button class="mini-btn accent" data-ldver="${escapeAttr(v)}">安装</button>
      </div>`;
    };
    box.innerHTML = show.map(rowHtml).join('')
      + (all.length > show.length
        ? `<button class="mini-btn wide" id="ld-more">展开全部 ${all.length} 个版本</button>`
        : (state.loaderExpanded && all.length > 30
          ? '<button class="mini-btn wide" id="ld-more">收起</button>' : ''));
    ldHint(`${LOADER_NAME[kind]} ${mc}：共 ${vs.length} 个版本，推荐 ${d.recommended ?? '—'}`);
  } catch (e) {
    if (seq !== loaderReqSeq) return;
    box.innerHTML = '<div class="empty-hint">读取失败</div>';
    ldHint(`读取失败：${e.message}`);
  }
}

function startLoaderInstall(version) {
  const mc = ldMcValue();
  if (!mc || !version) { toast('先选择游戏和加载器版本', true); return; }
  return enqueueInstall({ type: 'loader', kind: state.loaderKind || 'forge', mc, version });
}

/* ---------------- 整合包 ---------------- */
let mpPending = null;
let mpInspectSeq = 0;

async function pickModpackFile() {
  try {
    const r = await api('/api/pick-file', { method: 'POST', body: JSON.stringify({
      kind: 'modpack',
      title: '选择整合包',
      filter: '整合包 (*.mrpack;*.zip)|*.mrpack;*.zip|所有文件 (*.*)|*.*',
    }) });
    if (!r.path) return;
    $('#mp-path').value = r.path;
    await askModpack(r.path);
  } catch (e) {
    toast('选择文件失败：' + e.message, true);
  }
}

const FMT_NAME = { tpcl: 'TPCL 导出包', pcl: 'PCL2 整合包', modrinth: 'Modrinth 整合包', curseforge: 'CurseForge 整合包', plain: '裸目录整合包' };

/** 导入前解析：看清会装什么、多大，再确认 */
async function askModpack(file) {
  const seq = ++mpInspectSeq;
  const mask = $('#mp-mask');
  const body = $('#mp-info');
  $('#mp-go').disabled = true;
  mask.hidden = false;
  body.innerHTML = '<div class="empty-hint">正在解析整合包…</div>';
  mpPending = null;
  try {
    const d = await api(`/api/modpack/inspect?path=${encodeURIComponent(file)}`);
    if (seq !== mpInspectSeq || mask.hidden) return;
    if (!d.ok) {
      body.innerHTML = `<div class="mp-err">${escapeHtml(d.error || '解析失败')}</div>`;
      $('#mp-go').disabled = true;
      return;
    }
    mpPending = file;
    $('#mp-go').disabled = false;
    const size = d.totalSize ? fmtSize(d.totalSize) : '未知';
    const rows = [
      ['格式', FMT_NAME[d.format] ?? d.format],
      ['打包名称', d.name + (d.version ? ' · ' + d.version : '')],
      ['Minecraft', d.mc ?? '—'],
      ['加载器', d.loader ? `${d.loader} ${d.loaderVersion ?? ''}`.trim() : '原版'],
      ['要下载的模组/文件', d.fileCount == null ? '整包解压' : `${d.fileCount} 个`],
      ['下载体积', size],
      ['覆盖文件', d.overrides?.length ? d.overrides.join('、') : '无'],
      ['将创建的版本', d.targetId ?? '—'],
    ];
    body.innerHTML = rows.map(([k, v]) =>
      `<div class="mp-row"><span class="mp-k">${k}</span><span class="mp-v">${escapeHtml(String(v))}</span></div>`).join('');
  } catch (e) {
    body.innerHTML = `<div class="mp-err">解析失败：${escapeHtml(e.message)}</div>`;
    $('#mp-go').disabled = true;
  }
}

function closeModpackAsk() {
  mpInspectSeq++;
  $('#mp-mask').hidden = true;
  mpPending = null;
}

function startModpackImport(file = ($('#mp-path').value || '').trim()) {
  if (!file) { toast('先选择整合包', true); return; }
  return enqueueInstall({ type: 'modpack', path: file });
}

/* 导入完成后的汇总：数一下新版本目录里各有多少东西 */
function bindModpackDrop() {
  const zone = $('#mp-drop');
  if (!zone) return;
  let depth = 0;
  zone.tabIndex = 0;
  zone.setAttribute('role', 'button');
  zone.setAttribute('aria-label', '选择或拖入整合包，预览后加入下载队列');
  zone.addEventListener('click', pickModpackFile);
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickModpackFile(); } });
  zone.addEventListener('dragenter', e => { e.preventDefault(); depth++; zone.classList.add('dragging'); });
  zone.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('dragging'); } });
  zone.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation(); depth = 0; zone.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length !== 1) { toast('请一次拖入一个整合包，确认后可继续添加', true); return; }
    const file = files[0];
    const p = file.path || window.tpcl?.getPathForFile?.(file) || '';
    if (!p) { toast('浏览器无法读取本地路径，请点击选择文件', true); return; }
    if (!/\.(mrpack|zip)$/i.test(p)) { toast('请选择 .mrpack 或 .zip 整合包', true); return; }
    $('#mp-path').value = p;
    await askModpack(p);
  });
  document.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) e.preventDefault(); });
}

async function showPackSummary(d) {
  const box = $('#mp-result');
  if (!box) return;
  try {
    const c = await api(`/api/content?version=${encodeURIComponent(d.id)}`);
    const n = (k) => (Array.isArray(c?.[k]) ? c[k].length : 0);
    const rows = [
      ['模组', n('mods')],
      ['资源包', n('resourcepacks')],
      ['光影', n('shaderpacks')],
      ['存档', n('saves')],
      ['数据包', n('datapacks')],
    ].filter(([, v]) => v > 0);
    const list = rows.map(([k, v]) => `${k} ${v} 个`).join(' · ') || '没有附带内容文件';
    box.innerHTML = `<div class="pack-sum">
      <div class="pack-sum-title">已导入 ${escapeHtml(d.id)}</div>
      <div class="pack-sum-body">${escapeHtml(list)}</div>
      ${d.failed?.length ? `<div class="mp-err">${d.failed.length} 个文件下载失败</div>` : ''}
      <button class="mini-btn" id="btn-goto-pack">去内容页看看</button>
    </div>`;
    $('#btn-goto-pack')?.addEventListener('click', () => showView('content'));
  } catch {
    box.innerHTML = '';
  }
}

/* ---------------- 在线资源搜索（Modrinth） ---------------- */
const MARKET_TYPE = { mod: '模组', resourcepack: '资源包', shader: '光影', modpack: '整合包' };

function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)} 亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`;
  return String(v);
}

async function refreshMarketScope() {
  const scope = $('#mk-scope');
  if (!state.selected) {
    state.mkCtx = null;
    scope.textContent = '先在启动页选版本';
    return;
  }
  const ctx = await api(`/api/market/context?version=${encodeURIComponent(state.selected)}`);
  if (!ctx || ctx.error) { scope.textContent = '—'; state.mkCtx = null; return; }
  state.mkCtx = ctx;
  scope.textContent = `${ctx.mcVer || '?'} · ${ctx.loaderName || '原版'}`;
}

async function searchMarket(append = false) { return catalog.search(append === true); }

// CurseForge：只能按项目 ID / 链接精确打开（关键词搜索接口对本 Key 403）
async function searchCurseForge() {
  const q = $('#mk-query').value.trim();
  const box = $('#mk-list');
  if (!q) { box.innerHTML = '<div class="empty">填 CurseForge 项目 ID（纯数字）或 mc-mods 网页链接</div>'; return; }
  box.innerHTML = '<div class="empty">查询中…</div>';
  if (!state.mkCtx) await refreshMarketScope();
  const ctx = state.mkCtx || {};
  const r = await api(`/api/cf/mod?ref=${encodeURIComponent(q)}`);
  if (!r.ok) { box.innerHTML = `<div class="empty">${escapeHtml(r.error || '查不到这个项目')}</div>`; return; }
  const m = r.mod;
  const f = await api(`/api/cf/files?id=${m.id}&mc=${encodeURIComponent(ctx.mcVer || '')}&loader=${encodeURIComponent(ctx.loader || '')}`);
  const files = f.files || [];
  box.innerHTML = `
    <div class="row-item mk-row">
      <div class="mk-ico">${m.icon ? `<img src="${escapeAttr(m.icon)}" alt="" loading="lazy" />` : '<span>▣</span>'}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(m.name)} <span class="tag">CurseForge</span></div>
        <div class="row-sub">${escapeHtml((m.summary || '').slice(0, 110))}</div>
        <div class="row-sub">${escapeHtml((m.authors || []).join(', ') || '—')} · ${fmtCount(m.downloads)} 次下载</div>
      </div>
    </div>
    ${files.length ? files.map((x) => `
      <div class="row-item mk-row">
        <div class="mk-ico"><span>▤</span></div>
        <div class="row-main">
          <div class="row-title">${escapeHtml(x.fileName)} <span class="tag${x.releaseType === 2 ? ' upd' : ''}">${x.releaseType === 1 ? '正式' : x.releaseType === 2 ? 'beta' : 'alpha'}</span></div>
          <div class="row-sub">${fmtSize(x.size)} · ${fmtDate(x.date)}${x.gameVersions?.length ? ' · ' + escapeHtml(x.gameVersions.slice(0, 3).join(', ')) : ''}</div>
        </div>
        <button class="mini-btn accent" data-cfinst="${escapeAttr(String(x.id))}">安装</button>
      </div>`).join('') : '<div class="empty">当前版本下没有匹配的文件</div>'}`;
  $$('[data-cfinst]', box).forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); installFromCf(m.id, b.dataset.cfinst, b); });
  });
}

// 装 CurseForge 文件（SSE 进度）
async function installFromCf(modId, fileId) {
  if (!state.selected) { toast('先选择目标版本', true); return; }
  return enqueueInstall({ type: 'cf', mod: String(modId), file: String(fileId), target: state.selected });
}

function cleanMarkdown(md) {  return String(md || '')
    .replace(/<[^>]+>/g, '')                            // HTML 标签
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')               // 图片
    .replace(/\[\s*\]\([^)]*\)/g, '')                   // 空文字链接
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')            // 链接只留文字
    .replace(/^#{1,6}\s*/gm, '')                        // 标题符号
    .replace(/^\s*>\s?/gm, '')                          // 引用
    .replace(/^\s*[-*+]\s+/gm, '· ')                    // 列表
    .replace(/^\s*([-—_=])\1{2,}\s*$/gm, '')           // 分隔线
    .replace(/`{1,3}/g, '')                             // 行内代码
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .split('\n').map((l) => l.trim()).filter((l) => l && !/^https?:\/\/\S+$/.test(l)).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 检查启动器更新（走 releases/latest 的 302，不占 GitHub API 配额）

// ── 启动器自更新 ─────────────────────────────────────────────
function updPaint(st) {
  const bar = $('#upd-bar'); const fill = $('#upd-fill'); const txt = $('#upd-pct');
  if (!bar) return;
  const on = !!(st && st.show);
  bar.hidden = !on;
  if (!on) return;
  const pct = Number(st.pct);
  fill.style.width = pct >= 0 ? pct + '%' : '30%';
  fill.classList.toggle('indet', !(pct >= 0));
  txt.textContent = pct >= 0 ? pct + '%' : (st.text || '处理中…');
}

async function updRefresh() {
  try {
    const st = await api('/api/update/state');
    state.updState = st;
    const btn = $('#btn-do-update');
    if (btn) {
      if (!st.canUpdate) { btn.hidden = true; }
      else if (st.downloaded) { btn.hidden = false; btn.textContent = '重启并安装'; btn.dataset.mode = 'apply'; btn.classList.add('accent'); }
      else { btn.hidden = false; btn.textContent = '立即更新'; btn.dataset.mode = 'download'; btn.classList.add('accent'); }
    }
    const note = $('#upd-dl-note');
    if (note) {
      note.hidden = !st.downloaded;
      if (st.downloaded) note.textContent = '安装包已下载（' + (st.size / 1048576).toFixed(1) + ' MB），点击「重启并安装」自动替换并重启';
    }
    return st;
  } catch { return null; }
}

function onUpdEvent(ev) {
  if (ev.type === 'progress') {
    updPaint({ show: true, pct: ev.pct, text: ev.pct >= 0 ? '' : '下载中…' });
    const s = $('#upd-summary');
    if (s) { s.className = 'more-key warn'; s.textContent = '正在下载 ' + (ev.total ? (ev.total / 1048576).toFixed(1) + ' MB' : '') + (ev.pct >= 0 ? ' ' + ev.pct + '%' : ''); }
  } else if (ev.type === 'done') {
    updPaint({ show: false });
    const s = $('#upd-summary');
    if (s) { s.className = 'more-key good'; s.textContent = '下载完成，可以安装了'; }
    toast('更新包已下载');
    updRefresh();
  } else if (ev.type === 'error') {
    updPaint({ show: false });
    const s = $('#upd-summary');
    if (s) { s.className = 'more-key bad'; s.textContent = '下载失败：' + ev.error; }
    toast('下载失败：' + ev.error, true);
  }
}

async function checkLauncherUpdate() {
  const sum = $('#upd-summary');
  const btn = $('#btn-check-update');
  sum.className = 'more-key';
  sum.textContent = '检查中…';
  btn.disabled = true;
  try {
    const d = await api('/api/update/check');
    if (!d.ok) { sum.textContent = `检查失败：${d.error || '未知原因'}`; sum.className = 'more-key bad'; return; }
    $('#upd-row').hidden = false;
    $('#upd-latest').textContent = d.hasUpdate ? `${d.latest}（当前 ${d.current}）` : `${d.current}（已最新）`;
    const asset = Array.isArray(d.assets) && d.assets.length ? d.assets[0] : null;
    $('#upd-acts').hidden = !(d.hasUpdate || asset);
    const dl = $('#btn-dl-setup');
    if (dl) {
      dl.hidden = !asset;
      if (asset) {
        const mb = asset.size ? `（${(asset.size / 1048576).toFixed(1)} MB）` : '';
        dl.textContent = `下载安装包${mb}`;
        dl.title = asset.name;
        state.updAsset = asset.url;
      }
    }
    if (d.hasUpdate) {
      sum.textContent = `有新版本 ${d.latest}，去下载`;
      sum.className = 'more-key warn';
    } else if (asset) {
      sum.textContent = `${d.note || '已是最新'} · ${T('安装包已就绪')}`;
      sum.className = 'more-key good';
    } else {
      sum.textContent = d.note || '已是最新';
      sum.className = 'more-key good';
    }
    state.updUrl = d.htmlUrl;
  } catch (e) {
    sum.textContent = `检查失败：${e.message}`;
    sum.className = 'more-key bad';
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 市场项目详情 ---------------- */
async function openMarketDetail(projectId, type) {
  const mask = $('#mkd-mask');
  const body = $('#mkd-body');
  mask.hidden = false;
  $('#mkd-title').textContent = '项目详情';
  body.innerHTML = '<div class="empty">正在读取…</div>';
  if (!state.mkCtx) await refreshMarketScope().catch(() => {});
  const ctxMc = state.mkCtx?.mcVer || '';
  const ctxLoader = (type === 'mod' || type === 'modpack') ? (state.mkCtx?.loader || '') : '';
  let pr, vr;
  try {
    [pr, vr] = await Promise.all([
      api(`/api/market/project?id=${encodeURIComponent(projectId)}`),
      api(`/api/market/versions?id=${encodeURIComponent(projectId)}&mc=${encodeURIComponent(ctxMc)}&loader=${encodeURIComponent(ctxLoader)}`),
    ]);
  } catch (e) {
    body.innerHTML = `<div class="empty">读取失败：${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }
  if (!pr?.ok) { body.innerHTML = `<div class="empty">读不到详情：${escapeHtml(pr?.error || '')}</div>`; return; }
  const p = pr.project;
  const versions = vr.versions || [];
  $('#mkd-title').textContent = p.title;
  const bodyText = cleanMarkdown(p.body || p.description || '');
  body.innerHTML = `
    <div class="mkd-head">
      <div class="mkd-ico">${p.icon ? `<img src="${escapeAttr(p.icon)}" alt="" />` : '<span>▣</span>'}</div>
      <div class="mkd-meta">
        <div class="mkd-name">${escapeHtml(p.title)}</div>
        <div class="mkd-sub">${fmtCount(p.downloads)} 次下载 · ${fmtCount(p.followers)} 关注 · ${escapeHtml(p.license || '未标注协议')}</div>
        <div class="mkd-tags">${(p.categories || []).slice(0, 6).map((c) => `<span class="tag">${escapeHtml(c)}</span>`).join('')}
          ${(p.loaders || []).slice(0, 4).map((l) => `<span class="tag release">${escapeHtml(l)}</span>`).join('')}</div>
      </div>
    </div>
    <div class="mkd-desc">${escapeHtml(bodyText.slice(0, 1200)) || '（没有简介）'}</div>
    <div class="mkd-ver-head">可用版本 <span class="hint-line">共 ${versions.length} 个${ctxMc ? ` · 已按 ${escapeHtml(ctxMc)} 过滤` : ''}${ctxLoader ? ` · ${escapeHtml(ctxLoader)}` : ''}</span></div>
    <div class="mkd-vers">${versions.slice(0, 40).map((v) => `
      <div class="row-item mkd-ver">
        <div class="row-main">
          <div class="row-title">${escapeHtml(v.versionNumber || v.name)} ${v.type === 'release' ? '<span class="tag release">正式</span>' : '<span class="tag">' + escapeHtml(v.type || '') + '</span>'}</div>
          <div class="row-sub">${escapeHtml((v.gameVersions || []).slice(0, 4).join(', '))} · ${escapeHtml((v.loaders || []).join(', '))} · ${fmtDate(v.date)}</div>
        </div>
        <button class="mini-btn accent" data-mkv="${escapeAttr(v.id)}">安装</button>
      </div>`).join('') || '<div class="empty">这个版本组合没有可用文件</div>'}</div>`;

  $$('[data-mkv]', body).forEach((b) => {
    b.addEventListener('click', async () => {
      mask.hidden = true;
      await installFromMarketVersion(projectId, b.dataset.mkv, type);
    });
  });

  // 依赖：取最新一个版本的 dependencies，把项目 id 换成名字做成可点标签
  const newest = versions[0];
  const deps = (newest?.dependencies || []).filter((d) => d?.projectId);
  if (deps.length) {
    const holder = document.createElement('div');
    holder.className = 'mkd-deps';
    holder.innerHTML = '<span class="mkd-deps-label">依赖</span> <span class="hint-line">读取中…</span>';
    $('.mkd-desc', body)?.after(holder);
    try {
      const ids = deps.map((d) => d.projectId).join(',');
      const r = await api(`/api/market/projects?ids=${encodeURIComponent(ids)}`);
      const byId = new Map((r.projects || []).map((x) => [x.id, x]));
      holder.innerHTML = '<span class="mkd-deps-label">依赖</span> ' + deps.map((d) => {
        const pj = byId.get(d.projectId);
        const label = pj?.title || d.projectId;
        const kind = d.dependencyType ?? d.dependency_type;
        const opt = kind && kind !== 'required' ? ' opt' : '';
        return `<button class="dep-chip${opt}" data-dep="${escapeAttr(d.projectId)}" title="${escapeAttr(kind === 'required' ? '必需' : (kind === 'optional' ? '可选' : '依赖'))}">${escapeHtml(label)}</button>`;
      }).join('');
      $$('[data-dep]', holder).forEach((b) => {
        b.addEventListener('click', () => { openMarketDetail(b.dataset.dep, 'mod'); });
      });
    } catch {
      holder.innerHTML = '<span class="mkd-deps-label">依赖</span> <span class="hint-line">读取失败</span>';
    }
  }
}

function closeMarketDetail() { $('#mkd-mask').hidden = true; }

async function installFromMarket(projectId, type) {
  if (state.installBusy) { toast('已有安装任务在进行', true); return; }
  if (type !== 'modpack' && !state.selected) { toast('先在启动页选一个版本', true); return; }
  const ctx = state.mkCtx || {};
  const status = $('#mk-status');
  const bar = $('#mk-bar');
  const text = $('#mk-text');
  status.hidden = false;
  bar.style.width = '4%';
  text.textContent = '获取可用的项目版本…';

  const vq = new URLSearchParams({
    id: projectId,
    mc: ctx.mcVer || '',
    loader: (type === 'mod' || type === 'modpack') ? (ctx.loader || '') : '',
  });
  const vr = await api(`/api/market/versions?${vq}`);
  const versions = vr.versions || [];
  if (!versions.length) {
    bar.style.width = '0%';
    text.textContent = '这个项目没有适配当前游戏版本的版本';
    toast('没有可用版本', true);
    return;
  }
  return runMarketInstall(projectId, versions[0], type);
}

/** 从详情弹窗里装指定版本 */
async function installFromMarketVersion(projectId, versionId, type) {
  const vr = await api(`/api/market/versions?id=${encodeURIComponent(projectId)}`);
  const v = (vr.versions || []).find((x) => x.id === versionId);
  if (!v) { toast('这个版本已不可用', true); return; }
  return runMarketInstall(projectId, v, type);
}

async function runMarketInstall(projectId, v, type) {
  if (type !== 'modpack' && !state.selected) { toast('先选择目标版本', true); return; }
  return enqueueInstall({ type: 'market', project: projectId, version: v.id, resourceType: type, target: type === 'modpack' ? '' : state.selected });
}

const SC_ICON = { ok: '✓', warn: '!', bad: '✕' };
async function runSelfcheck() {
  const btn = $('#btn-selfcheck');
  const sum = $('#sc-summary');
  const box = $('#sc-list');
  if (!box) return;
  btn.disabled = true;
  sum.textContent = '正在检查…';
  box.innerHTML = '<div class="sc-empty">逐个检查中，网络那两项最多等 6 秒…</div>';
  try {
    const d = await api(`/api/selfcheck?version=${encodeURIComponent(state.selected || '')}`);
    const checks = d.checks ?? [];
    box.innerHTML = checks.map((c) => `
      <div class="sc-row ${c.level}">
        <span class="sc-dot ${c.level}">${SC_ICON[c.level] ?? '·'}</span>
        <span class="sc-body"><b>${escapeHtml(c.title)}</b><em>${escapeHtml(c.detail ?? '')}</em></span>
      </div>`).join('') || '<div class="sc-empty">没有返回检查项</div>';
    const bad = d.bad ?? 0;
    const warn = d.warn ?? 0;
    sum.textContent = bad ? `${bad} 项会挡住启动${warn ? `，${warn} 项要注意` : ''}` : (warn ? `可以启动，${warn} 项要注意` : '全部正常');
    sum.className = `more-key ${bad ? 'bad' : warn ? 'warn' : 'good'}`;
  } catch (e) {
    box.innerHTML = `<div class="sc-empty">自检失败：${escapeHtml(e.message)}</div>`;
    sum.textContent = '自检失败';
    sum.className = 'more-key bad';
  } finally {
    btn.disabled = false;
  }
}

async function loadMore() {
  const id = state.selected;
  $('#more-ver').textContent = id || '未选择版本';
  $('#more-state').textContent = '-';
  $('#more-state').className = 'more-state';

  let info = null;
  if (id) {
    try {
      info = await inspectVersionClient(id, true);
      const miss = info?.missing ?? [];
      if (miss.length) {
        $('#more-state').textContent = `缺 ${miss.length} 项：${miss.join('、')}`;
        $('#more-state').classList.add('bad');
      } else {
        $('#more-state').textContent = '完整，可以启动';
        $('#more-state').classList.add('good');
      }
    } catch (e) {
      $('#more-state').textContent = '读取失败：' + (e?.message ?? e);
      $('#more-state').classList.add('bad');
    }
  }

  try {
    const st = await api('/api/stats');
    if ($('#more-appver')) $('#more-appver').textContent = st.appVersion || '—';
    if ($('#notice-ver')) $('#notice-ver').textContent = 'TPCL ' + (st.appVersion || '');
    $('#st-cache').textContent = `${fmtSize(st.cache.bytes)} · ${st.cache.files} 个文件`;
    $('#st-logs').textContent = `${fmtSize(st.logs.bytes)} · ${st.logs.files} 个文件`;
    $('#st-backups').textContent = `${fmtSize(st.backups.bytes)} · ${st.backups.files} 个文件`;
    $('#more-runtime').textContent = `Node ${st.node}`;
    $('#more-uptime').textContent = fmtUptime(st.uptime);
    $('#more-gamedir').textContent = st.gameDir || '-';
    $('#more-datadir').textContent = st.dataDir || '-';
    $('#more-gamedir').title = st.gameDir || '';
    $('#more-datadir').title = st.dataDir || '';
  } catch (e) {
    $('#st-cache').textContent = '统计失败';
  }

  // 上次启动参数快照
  const ll = state.config?.lastLaunch;
  const llEl = $('#more-lastlaunch');
  if (llEl) {
    if (ll?.id) {
      const mem = ll.memory ? ` · ${ll.memory} MB` : '';
      llEl.textContent = `${ll.id} · ${relTime(ll.at)}${mem}`;
      llEl.title = `${ll.java || ''}\n${(ll.args || []).join(' ')}`.trim();
    } else {
      llEl.textContent = '还没启动过';
      llEl.removeAttribute('title');
    }
  }
}

function fmtUptime(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

/** 下载并安装指定大版本的 Java，进度显示在下载页的安装条上 */
function ensureJava(major) {
  showView('download');
  return enqueueInstall({ type: 'java', major });
}

async function fixCurrent() {
  const id = state.selected;
  if (!id) { toast('先选一个版本', true); return; }
  const insp = await inspectVersionClient(id, true);
  const miss = insp?.missing ?? [];
  if (!miss.length) { toast('这个版本已经是完整的'); return; }
  const javaMiss = miss.some((m) => String(m).includes('Java'));
  if (javaMiss && insp?.needJava) { ensureJava(insp.needJava); return; }
  await repairCurrent();
  inspectCacheReset(id);
  await refresh();
}

async function repairCurrent() {
  const id = state.selected;
  if (!id) { toast('先选一个版本', true); return; }
  const btn = $('#btn-more-repair');
  if (btn) btn.disabled = true;
  const hint = $('#more-hint');
  if (hint) hint.textContent = '正在校验并补齐…';
  try {
    const r = await api('/api/repair', { method: 'POST', body: JSON.stringify({ id }) });
    if (r.ok) {
      toast('校验完成');
      if (hint) hint.textContent = '已完成，缺少的文件已重新下载。';
      inspectCacheReset(id);
      await loadMore();
      await refresh();
    } else {
      toast(r.error || '修复失败', true);
      if (hint) hint.textContent = '失败：' + (r.error || '未知错误');
    }
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 内容管理 ---------------- */
async function loadContent() {
  if (!state.selected) {
    $('#content-list').innerHTML = '<div class="empty">先在上方选择一个版本</div>';
    return;
  }
  if (state.contentKind === 'shots') {
    const d = await api(`/api/shots?version=${encodeURIComponent(state.selected)}`);
    state.shots = d?.shots ?? [];
    state.shotsDir = d?.dir || '';
    renderShots();
    return;
  }
  const data = await api(`/api/content?version=${encodeURIComponent(state.selected)}`);
  state.content = data;
  if (state.contentKind === 'mods') {
    state.modCheck = null;
    await runModCheck(false);
  }
  renderContent();
}

/**
 * 下载任务面板：同时装版本 + 加载器 + 模组时，这里一并列出，
 * 每 1.5 秒轮询 /api/tasks（只在下载页、且面板可见时跑）。
 */
let taskTimer = null;

function stopTaskPoll() {
  if (taskTimer) { clearInterval(taskTimer); taskTimer = null; }
}

const knownQueueTasks = new Map();
let pollBusy = false;
async function enqueueInstall(input) {
  try {
    const d = await api('/api/queue', { method: 'POST', body: JSON.stringify(input) });
    if (!d.ok) throw new Error(d.error || '添加任务失败');
    knownQueueTasks.set(d.task.id, d.task.status);
    toast('已加入下载队列：' + d.task.label);
    nudgeTasks();
    return d.task;
  } catch (e) { toast(e.message || '添加任务失败', true); }
}
function renderTasks(d) {
  const panel = $('#task-panel'), box = $('#task-list');
  if (!panel || !box) return;
  const list = d?.tasks || [];
  for (const t of list) {
    const before = knownQueueTasks.get(t.id);
    if (before && !['completed', 'failed', 'cancelled'].includes(before) && t.done) {
      if (t.status === 'completed') {
        toast(t.label + '已完成');
        refresh().then(() => {
          if (state.remote) renderRemote();
          if ((t.input?.type === 'modpack' || t.input?.resourceType === 'modpack') && t.result?.id) showPackSummary(t.result);
          if (t.input?.type === 'java') { fillSettings(); inspectCacheReset(state.selected); }
          if (['market', 'cf'].includes(t.input?.type) && state.view === 'content') loadContent();
        }).catch(reportClientError);
      } else if (t.status === 'failed') {
        toast(t.label + '失败：' + t.error, true);
        if (t.report) showErrorReport(t.report);
      }
    }
    knownQueueTasks.set(t.id, t.status);
  }
  for (const id of knownQueueTasks.keys()) if (!list.some(t => t.id === id)) knownQueueTasks.delete(id);
  panel.hidden = !list.length;
  const waiting = list.filter(t => t.status === 'queued').length;
    const running = list.filter(t => !t.done && t.status !== 'queued').length;
  $('#task-count').textContent = running + ' 进行中 · ' + waiting + ' 等待';
  box.innerHTML = list.map(t => {
    const stage = t.status === 'queued' ? '排队第 ' + t.position + ' 位' : (t.error ? '失败：' + t.error : t.stage || '准备中');
    const action = t.status === 'queued' ? '<button class="mini-btn" data-queue="cancel" data-id="' + escapeAttr(t.id) + '">取消等待</button>'
      : ['failed', 'cancelled', 'interrupted'].includes(t.status) ? '<button class="mini-btn" data-queue="retry" data-id="' + escapeAttr(t.id) + '">' + (t.status === 'interrupted' ? '继续' : '重试') + '</button>' + (t.status === 'interrupted' ? '<button class="mini-btn" data-queue="cancel" data-id="' + escapeAttr(t.id) + '">取消</button>' : '') : '';
    const report = t.report ? '<a class="mini-btn" href="/api/reports/' + encodeURIComponent(t.report) + '" download>导出错误报告</a>' : '';
    return '<div class="task-row ' + (t.error ? 'err' : ['cancelled', 'interrupted'].includes(t.status) ? 'cancelled' : t.done ? 'ok' : '') + '"><div class="task-top"><span class="task-label">' + escapeHtml(t.label) + '</span><span class="task-pct">' + (t.status === 'queued' ? '等待' : t.error ? '失败' : t.status === 'interrupted' ? '未完成' : t.status === 'cancelled' ? '取消' : t.done ? '完成' : t.percent + '%') + '</span></div><div class="task-bar"><i style="width:' + t.percent + '%"></i></div><div class="task-stage">' + escapeHtml(stage) + '</div><div class="task-actions">' + action + report + '</div></div>';
  }).join('');
}

async function pollTasks() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const d = await api('/api/tasks');
    renderTasks(d);
    if (!(d?.tasks ?? []).some(t => !t.done)) stopTaskPoll(); // 全部都清掉了，停轮询
  } catch {} finally { pollBusy = false; }
}

function startTaskPoll() {
  if (taskTimer) return;
  pollTasks();
  taskTimer = setInterval(pollTasks, 1500);
}

/** 任何下载入口开始时调用一次，立刻把面板拉起来 */
function nudgeTasks() {
  startTaskPoll();
  setTimeout(pollTasks, 400);
  setTimeout(pollTasks, 1200);
}

/**
 * 懒加载 jar 元数据（名称/版本/作者），最多并发 4 个，
 * 拿到的写进 state.metas 并只更新对应行的副标题，不整页重绘。
 */
async function loadMetas(kind, list) {
  if (!['mods', 'resourcepacks', 'shaderpacks'].includes(kind)) return;
  state.metas = state.metas || {};
  const todo = list
    .filter((it) => !it.isDir && !state.metas[`${kind}:${it.file}`])
    .slice(0, 40);
  if (!todo.length) return; // 已经全部取过，避免重绘递归
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const it = todo[i++];
      try {
        const m = await api(`/api/content/meta?version=${encodeURIComponent(state.selected)}&kind=${kind}&file=${encodeURIComponent(it.file)}`);
        if (m && !m.error) state.metas[`${kind}:${it.file}`] = m;
        else state.metas[`${kind}:${it.file}`] = { skip: true };
      } catch {
        state.metas[`${kind}:${it.file}`] = { skip: true };
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (state.view === 'content' && state.contentKind === kind) renderContent();
}

/** 截图网格：点开看大图，右上角 × 删除 */
function shotUrl(name) {
  return `/api/shot/file?version=${encodeURIComponent(state.selected || '')}&name=${encodeURIComponent(name)}`;
}

function renderShots() {
  try {
  const box = $('#content-list');
  if (!box) return;
  const list = state.shots ?? [];
  const chk = document.getElementById('btn-check-updates');
  const imp = document.getElementById('btn-import-content');
  const srch = document.getElementById('content-search');
  if (chk) chk.hidden = true;
  if (imp) imp.hidden = true;
  if (srch) srch.placeholder = '搜索截图文件名…';
  for (const t of [...document.querySelectorAll('.tabs [data-kind]')]) {
    if (!t.dataset.label) t.dataset.label = t.textContent.replace(/\s*\d+$/, '');
    const base = t.dataset.label;
    t.textContent = t.dataset.kind === 'shots' && list.length ? `${base} ${list.length}` : base;
  }
  if (!list.length) {
    box.innerHTML = `<div class="empty-state">
        <div class="empty-ico">🖼️</div>
        <div class="empty-title">这个版本还没有截图</div>
        <div class="empty-sub">游戏里按 F2 就会存到这里：<br /><span class="mono">${escapeHtml(state.shotsDir || 'screenshots')}</span></div>
        <div class="empty-acts">
          <button class="mini-btn accent" data-shot="folder">打开截图文件夹</button>
        </div>
      </div>`;
    box.querySelector('[data-shot="folder"]')?.addEventListener('click', openShotsFolder);
    return;
  }
  box.innerHTML = list.map((it) => {
    const dim = it.w ? `${it.w}×${it.h}` : fmtSize(it.size);
    return `
    <div class="shot-card" data-shot-name="${escapeAttr(it.name)}" title="${escapeAttr(it.name)}">
      <img loading="lazy" src="${shotUrl(it.name)}" alt="" />
      <button class="shot-del" data-shot-del="${escapeAttr(it.name)}" title="删除这张截图">✕</button>
      <div class="shot-meta"><span>${dim}</span><span>${fmtDate(new Date(it.mtime).toISOString())}</span></div>
    </div>`;
  }).join('');
  for (const card of [...box.querySelectorAll('.shot-card')]) {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-shot-del]')) return;
      openShotView(card.dataset.shotName);
    });
  }
  for (const b of [...box.querySelectorAll('[data-shot-del]')]) {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = b.dataset.shotDel;
      if (!confirm(`删除截图「${name}」？删了就找不回来了。`)) return;
      const r = await api('/api/shots/delete', {
        method: 'POST',
        body: JSON.stringify({ version: state.selected, names: [name] }),
      });
      if (r?.ok) {
        state.shots = r.shots ?? [];
        renderShots();
        toast(r.deleted ? '已删除' : '没删掉，可能被占用', !r.deleted);
      } else toast(r?.error || '删除失败', true);
    });
  }
  } catch (e) { console.warn('renderShots failed:', e); }
}

async function openShotsFolder() {
  if (!state.selected) { toast('先选版本', true); return; }
  await api('/api/open-folder', {
    method: 'POST',
    body: JSON.stringify({ path: state.shotsDir || '' }),
  }).catch(() => {});
}

function openShotView(name) {
  const mask = $('#shot-mask');
  if (!mask) return;
  state.shotViewing = name;
  $('#shot-view-name').textContent = name;
  $('#shot-view-img').src = shotUrl(name);
  mask.hidden = false;
}

function closeShotView() {
  const mask = $('#shot-mask');
  if (mask) mask.hidden = true;
  state.shotViewing = '';
  const img = $('#shot-view-img');
  if (img) img.src = '';
}

// 模组依赖 / 冲突：拿到检查结果后插一条横幅（异步，不阻塞列表渲染）
async function runModCheck(force) {
  const ver = state.selected;
  if (!ver) return null;
  if (!force && state.modCheck && state.modCheck.version === ver && Date.now() - state.modCheck.at < 60000) return state.modCheck;
  try {
    const r = await api('/api/mods/check?version=' + encodeURIComponent(ver));
    state.modCheck = { ...r, at: Date.now() };
    return state.modCheck;
  } catch (e) {
    console.warn('mod check failed', e);
    return null;
  }
}

function modIssueHtml(it) {
  const acts = [];
  if (it.files && it.files.length) {
    acts.push(`<button class="mini-btn" data-mod-locate="${escapeAttr(it.files[0])}">定位</button>`);
  }
  if (it.fixable && it.files && it.files.length > 1) {
    acts.push(`<button class="mini-btn" data-mod-disable="${escapeAttr(it.files.slice(1).join("|"))}">禁用多余的</button>`);
  }
  return `<div class="mod-issue mod-issue-${it.type}">
    <div class="mod-issue-main"><b>${escapeHtml(it.title)}</b><span>${escapeHtml(it.detail || "")}</span></div>
    <div class="mod-issue-acts">${acts.join("")}</div>
  </div>`;
}

function renderModIssues(box, list) {
  const r = state.modCheck;
  if (!r || r.version !== state.selected) return;
  const c = r.counts || {};
  const total = (c.missing || 0) + (c.duplicate || 0) + (c.dupfile || 0) + (c.range || 0);
  const head = `<div class="mod-check-head">
      <span>检查了 ${r.jars} 个 jar · ${total ? "发现 " + total + " 个问题" : "依赖都齐"}</span>
      <button class="mini-btn" data-mod-recheck="1">重新检查</button>
    </div>`;
  const body = total ? r.issues.map(modIssueHtml).join("") : "";
  const wrap = document.createElement('div');
  wrap.className = "mod-check" + (total ? " has-issue" : "");
  wrap.innerHTML = head + body;
  box.prepend(wrap);
  wrap.querySelector("[data-mod-recheck]")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    wrap.querySelector("[data-mod-recheck]").textContent = "检查中…";
    await runModCheck(true);
    renderContent();
  });
  [...wrap.querySelectorAll("[data-mod-disable]")].forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const files = btn.dataset.modDisable.split("|").filter(Boolean);
      if (!confirm(`把 ${files.join("、")} 改名成 .disabled？`)) return;
      try {
        await api("/api/mods/disable", { version: state.selected, files });
        toast("已禁用 " + files.length + " 个文件");
        await loadContent();
        await runModCheck(true);
        renderContent();
      } catch (err) { toast("禁用失败：" + err.message); }
    });
  });
  [...wrap.querySelectorAll("[data-mod-locate]")].forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      api("/api/open-folder", { version: state.selected, kind: "mods", file: btn.dataset.modLocate }).catch(() => {});
    });
  });
}

function renderContent() {
  const kind = state.contentKind;
  if (kind === 'shots') { renderShots(); return; }
  const chk = document.getElementById('btn-check-updates');
  const imp = document.getElementById('btn-import-content');
  const srch = document.getElementById('content-search');
  if (chk) chk.hidden = false;
  if (imp) imp.hidden = false;
  if (srch) srch.placeholder = '搜索文件名 / 模组名 / 作者…';
  const all = state.content?.[kind] ?? [];
  const q = String(state.contentQuery || '').trim().toLowerCase();
  const list = q
    ? all.filter((it) => {
        const meta = state.metas?.[`${kind}:${it.file}`];
        return String(it.file).toLowerCase().includes(q)
          || String(meta?.name || '').toLowerCase().includes(q)
          || String(meta?.authors || '').toLowerCase().includes(q);
      })
    : all;
  const box = $('#content-list');

  // 标签上带数量（模组 3 / 资源包 0 这种），一眼看出每个分组有多少东西
  const KIND_LABEL = { mods: '模组', resourcepacks: '资源包', shaderpacks: '光影', saves: '存档', datapacks: '数据包' };
  $$('.tabs [data-kind]').forEach((t) => {
    const k = t.dataset.kind;
    const n = Array.isArray(state.content?.[k]) ? state.content[k].length : 0;
    const base = KIND_LABEL[k] || t.dataset.label || t.textContent.replace(/\s*\d+$/, '');
    t.dataset.label = base;
    t.textContent = n > 0 ? `${base} ${n}` : base;
  });

  const upd = state.updates?.[kind] ?? {};
  const verLoader = kind === 'mods'
    ? (String(state.versions?.find((v) => v.id === state.selected)?.loader || '')).toLowerCase()
    : '';
  const hits = $('#content-hits');
  if (hits) {
    hits.textContent = q ? `${list.length} / ${all.length} 匹配` : '';
    hits.hidden = !q;
  }
  if (!all.length) {
    const KIND_TIP = {
      mods: '这个版本还没有装模组',
      resourcepacks: '这个版本还没有资源包',
      shaderpacks: '这个版本还没有光影',
      saves: '这个版本还没有存档',
      datapacks: '这个版本还没有数据包',
    };
    box.innerHTML = `<div class="empty-state">
        <div class="empty-ico">📦</div>
        <div class="empty-title">${escapeHtml(KIND_TIP[kind] || '这里还是空的')}</div>
        <div class="empty-sub">当前版本：${escapeHtml(state.selected || '未选择')}</div>
        <div class="empty-acts">
          <button class="mini-btn accent" data-empty="download">去下载</button>
          <button class="mini-btn" data-empty="folder">打开文件夹</button>
        </div>
      </div>`;
    box.querySelector('[data-empty="download"]')?.addEventListener('click', () => showView('download'));
    box.querySelector('[data-empty="folder"]')?.addEventListener('click', () => $('#btn-open-content')?.click());
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="empty">没有匹配「${escapeHtml(state.contentQuery)}」的文件</div>`;
    return;
  }
  box.innerHTML = list.map((it) => {
    const u = upd[it.file];
    const meta = state.metas?.[`${kind}:${it.file}`];
    const dup = (it.duplicates ?? []).length
      ? ` <span class="tag dup" title="同一个模组装了多份，通常会导致启动崩溃：${escapeAttr(it.duplicates.join(', '))}">重复 ×${it.duplicates.length + 1}</span>`
      : '';
    const metaLine = meta
      ? [meta.name && meta.name !== it.name ? meta.name : '', meta.version ? `v${meta.version}` : '', meta.authors, meta.loader]
          .filter(Boolean).join(' · ')
      : '';
    const mLd = String(meta?.loader || '').toLowerCase();
    const mismatch = verLoader && mLd && ['fabric', 'forge', 'neoforge', 'quilt'].includes(mLd) && mLd !== verLoader && !(verLoader === 'neoforge' && mLd === 'forge');
    const badTag = mismatch
      ? ` <span class="tag warn" title="这个模组是 ${mLd} 的，当前版本是 ${verLoader}，加载器不认它，装进去不会生效">${mLd} 模组</span>`
      : '';
    const isPack = kind === 'resourcepacks' || kind === 'shaderpacks' || kind === 'datapacks';

    const canAct = isPack && it.active !== undefined;
    const actBtn = canAct
      ? '<button class="mini-btn ' + (it.active ? 'accent' : '') + ' pack-act" data-act="' + (it.active ? 'off' : 'on') + '" data-name="' + escapeAttr(it.name) + '">' + (it.active ? '已启用' : '启用') + '</button>'
      : '';    const ico = isPack && it.iconKey ? `<img class="pack-ico" loading="eager" src="/api/pack-icon?key=${encodeURIComponent(it.iconKey)}" alt="">` : (isPack ? '<div class="pack-ico pack-ico-ph"></div>' : '');
    const packDesc = isPack && it.description
      ? `<div class="row-desc">${escapeHtml(String(it.description).replace(/\u00a7./g, '').slice(0, 140))}</div>`
      : '';
    const fmtTag = isPack && it.packFormat ? ` <span class="tag">格式 ${escapeHtml(String(it.packFormat))}</span>` : '';
    return `
    <div class="row-item ${it.enabled ? '' : 'disabled'}${isPack ? ' row-pack' : ''}" data-dbl-locate="${escapeAttr(it.file)}" title="${escapeAttr('双击在资源管理器里定位')}">
      ${ico}
      <div class="row-main">
        <div class="row-title">${escapeHtml(it.name)}${dup}${badTag}${u ? ` <span class="tag upd">可更新 → ${escapeHtml(u.latest)}</span>` : ''}${fmtTag}</div>
        ${packDesc}
        <div class="row-sub">${it.isDir ? '文件夹' : fmtSize(it.size)} · ${fmtDate(new Date(it.mtime).toISOString())}${u?.date ? ` · 新版 ${fmtDate(u.date)}` : ''}${(it.duplicates ?? []).length ? ` · 与之重复：${escapeHtml(it.duplicates.join('、'))}` : ''}${metaLine ? ` · <span class="mod-meta">${escapeHtml(metaLine)}</span>` : ''}</div>
      </div>
      ${u ? `<button class="mini-btn accent" data-upd="${escapeAttr(it.file)}">更新</button>` : ''}
      ${actBtn}
      <button class="mini-btn" data-locate="${escapeAttr(it.file)}" title="在资源管理器里定位这个文件">定位</button>
      ${kind === 'saves' || it.isDir ? '' : `<button class="mini-btn" data-toggle="${escapeAttr(it.file)}">${it.enabled ? '禁用' : '启用'}</button>`}
      <button class="mini-btn" data-del="${escapeAttr(it.file)}">删除</button>
    </div>`;
  }).join('');
  if (kind === 'mods') renderModIssues(box, list);
  loadMetas(kind, list);

  $$('[data-upd]', box).forEach((b) => b.addEventListener('click', async () => {
    const file = b.dataset.upd;
    const u = upd[file];
    if (!u) return;
    b.disabled = true;
    b.textContent = '更新中…';
    const r = await api('/api/content/update', {
      method: 'POST',
      body: JSON.stringify({ version: state.selected, kind, oldFile: file, projectId: u.projectId, versionId: u.versionId }),
    });
    if (r.ok) { toast(`已更新 ${u.name} → ${u.latest}`); delete upd[file]; await loadContent(); }
    else { b.disabled = false; b.textContent = '更新'; toast(r.error || '更新失败', true); }
  }));

  const locateFile = async (file) => {
    const r = await api('/api/open-folder', {
      method: 'POST',
      body: JSON.stringify({ version: state.selected, kind, file }),
    });
    if (!r.ok) toast(r.error || '定位失败', true);
  };

  $$('[data-locate]', box).forEach((b) => b.addEventListener('click', () => locateFile(b.dataset.locate)));

  // 双击整行也能定位，和 PCL2 的习惯一致
  $$('[data-dbl-locate]', box).forEach((row) => row.addEventListener('dblclick', (ev) => {
    if (ev.target.closest('button')) return;
    locateFile(row.dataset.dblLocate);
  }));

  $$('[data-toggle]', box).forEach((b) => b.addEventListener('click', async () => {
    const r = await api('/api/content/toggle', {
      method: 'POST',
      body: JSON.stringify({ version: state.selected, kind, file: b.dataset.toggle }),
    });
    if (r.ok) loadContent(); else toast(r.error || '操作失败', true);
  }));
  $$('[data-del]', box).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`删除「${b.dataset.del}」？`)) return;
    const r = await api('/api/content/delete', {
      method: 'POST',
      body: JSON.stringify({ version: state.selected, kind, file: b.dataset.del }),
    });
    if (r.ok) loadContent(); else toast(r.error || '删除失败', true);
  }));
}

/* ---------------- 设置 ---------------- */
function fillSettings() {
  const c = state.config;
  $('#s-mcDir').value = c.mcDir ?? '';
  $('#s-isolation').value = c.isolation ?? 'version';
  $('#s-autobackup').checked = Boolean(c.autoBackupBeforeLaunch);
  $('#s-memory').value = c.memory ?? 4096;
  $('#s-memory-range').value = Math.min(c.memory ?? 4096, 32768);
  $('#s-mirror').value = c.mirror ?? 'bmclapi';
  if ($('#s-mirrorUrl')) $('#s-mirrorUrl').value = c.mirrorUrl || '';
  if ($('#s-proxy')) $('#s-proxy').value = c.proxy || '';
  $('#s-threads').value = c.downloadThreads ?? 12;
  $('#s-width').value = c.width || '';
  $('#s-height').value = c.height || '';
  $('#s-fullscreen').checked = Boolean(c.fullscreen);
  $('#s-jvmArgs').value = c.jvmArgs ?? '';
  $('#s-gameArgs').value = c.gameArgs ?? '';
  $('#s-account-name').value = c.account?.name ?? '';
  $('#s-account-type').value = c.account?.type ?? 'offline';
  $('#s-lang').value = c.locale ?? 'zh';
  if ($('#bg-dim')) $('#bg-dim').value = c.bgDim ?? 0.35;
  if ($('#bg-blur')) $('#bg-blur').value = c.bgBlur ?? 0;
  if ($('#bg-dim-val')) $('#bg-dim-val').textContent = Math.round(Number($('#bg-dim').value) * 100) + '%';
  if ($('#bg-blur-val')) $('#bg-blur-val').textContent = $('#bg-blur').value + ' px';
  applyBg(c.bgPath || '');
  if (window.__applyAccent) window.__applyAccent(c.accent || '');
  if ($('#s-gamelang')) $('#s-gamelang').value = c.language || 'zh_cn';
  if ($('#s-gpuhigh')) $('#s-gpuhigh').checked = c.gpuHigh === true;
  if ($('#s-gpulist')) {
    api('/api/gpu').then((g) => {
      const names = (g.gpus || []).map((x) => x.name).filter(Boolean);
      if ($('#s-gpulist')) $('#s-gpulist').textContent = names.length ? names.join(' / ') : '没有读到显卡信息';
      if ($('#s-gpustate')) {
        $('#s-gpustate').textContent = g.preference === 'high'
          ? `已设为高性能（${(g.java || '').split(/[\\/]/).slice(-3, -2)[0] || 'java'}）`
          : (g.enabled ? '设置已开，但注册表里还没有记录' : '跟随系统默认');
      }
      if ($('#s-gpuhigh')) $('#s-gpuhigh').checked = g.enabled === true;
    }).catch(() => { if ($('#s-gpulist')) $('#s-gpulist').textContent = '-'; });
  }
  if ($('#btn-gpu-apply')) {
    $('#btn-gpu-apply').addEventListener('click', async () => {
      const enabled = $('#s-gpuhigh')?.checked === true;
      const r = await api('/api/gpu', { method: 'POST', body: JSON.stringify({ enabled }) });
      if (r.ok) { toast(enabled ? '已写入独显偏好' : '已恢复系统默认'); fillSettings(); }
      else toast(r.error || '设置失败', true);
    });
  }
  if ($('#s-forcelang')) $('#s-forcelang').checked = c.forceGameLang !== false;
  if ($('#s-curlang')) $('#s-curlang').textContent = '读取中…';
  api('/api/game-lang' + (c.selectedVersion ? '?version=' + encodeURIComponent(c.selectedVersion) : ''))
    .then((d) => { if ($('#s-curlang')) $('#s-curlang').textContent = d.lang || '未设置（首次启动会写入）'; })
    .catch(() => { if ($('#s-curlang')) $('#s-curlang').textContent = '-'; });

  const sel = $('#s-java');
  sel.innerHTML = '<option value="">自动选择（推荐）</option>' + state.javas.map((j) =>
    `<option value="${escapeAttr(j.path)}">Java ${j.major} · ${j.source} · ${escapeHtml(j.home)}</option>`).join('');
  sel.value = c.javaPath ?? '';

  $('#pill-java').textContent = state.javas.length
    ? `Java ${state.javas[0].major}（共 ${state.javas.length} 个）`
    : '未找到 Java';
  renderJavaList();
  $('#pill-dir').textContent = c.mcDir;
}

/** 设置页「已扫描到的 Java」列表：自动下载的可以删，系统装的只给打开目录 */
function renderJavaList() {
  const box = $('#java-list');
  if (!box) return;
  const list = state.javas || [];
  if (!list.length) {
    box.innerHTML = '<span class="hint-line">没扫到 Java，可能没装：可用上面的「下载并安装」。</span>';
    return;
  }
  box.innerHTML = list.map((j, i) => `
    <div class="java-row" data-i="${i}">
      <div class="java-main">
        <b>Java ${j.major}</b>
        <span class="java-meta">${escapeHtml(j.version || '')} · ${j.auto ? '启动器下载' : escapeHtml(j.source || '')}</span>
        <span class="java-path" title="${escapeAttr(j.home)}">${escapeHtml(j.home)}</span>
      </div>
      <div class="java-acts">
        <button class="mini-btn" data-jopen="${i}">目录</button>
        ${j.auto ? `<button class="mini-btn" data-jdel="${i}">删除</button>` : ''}
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-jopen]').forEach((b) => b.addEventListener('click', async () => {
    const j = list[Number(b.dataset.jopen)];
    await api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: j.home }) });
  }));
  box.querySelectorAll('[data-jdel]').forEach((b) => b.addEventListener('click', async () => {
    const j = list[Number(b.dataset.jdel)];
    if (!confirm(`删除 ${j.home}？\n这个 Java 是启动器下载的，删掉后用到它的版本需要重新下载。`)) return;
    const r = await api('/api/java/remove', { method: 'POST', body: JSON.stringify({ home: j.home }) });
    if (!r.ok) { toast(r.error || '删除失败', true); return; }
    toast('已删除');
    const again = await api('/api/java');
    state.javas = again.javas ?? [];
    fillSettings();
  }));
}

async function saveSettings() {
  const patch = {
    isolation: $('#s-isolation').value,
    memory: Number($('#s-memory').value) || 4096,
    javaPath: $('#s-java').value,
    mirror: $('#s-mirror').value,
    mirrorUrl: ($('#s-mirrorUrl')?.value || '').trim(),
    proxy: ($('#s-proxy')?.value || '').trim(),
    downloadThreads: Number($('#s-threads').value) || 12,
    width: Number($('#s-width').value) || 0,
    height: Number($('#s-height').value) || 0,
    fullscreen: $('#s-fullscreen').checked,
    autoBackupBeforeLaunch: $('#s-autobackup').checked,
    jvmArgs: $('#s-jvmArgs').value,
    gameArgs: $('#s-gameArgs').value,
    language: $('#s-gamelang')?.value || 'zh_cn',
    forceGameLang: $('#s-forcelang') ? $('#s-forcelang').checked : true,
    account: {
      ...(state.config.account ?? {}),
      name: $('#s-account-name').value || 'Steve',
      type: $('#s-account-type').value,
    },
  };
  const r = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  if (r.ok) {
    state.config = r.config;
    $('#save-hint').textContent = '已保存';
    setTimeout(() => { $('#save-hint').textContent = ''; }, 2000);
    toast('设置已保存');
  } else toast(r.error || '保存失败', true);
}

/* ---------------- 全局刷新 ---------------- */
/* ---------------- 数据目录 ---------------- */
async function loadPaths() {
  try {
    const d = await api('/api/paths');
    state.paths = d;
    paintPaths(d);
    return d;
  } catch (e) {
    toast(`读取数据目录失败：${e.message}`, true);
    return null;
  }
}

function paintPaths(d) {
  if (!d) return;
  const a = $('#s-dataDir'); if (a) a.value = d.dataDir || '';
  const b = $('#s-gameDir2'); if (b) b.value = d.gameDir || '';
  const st = $('#s-portable-state');
  if (st) {
    st.textContent = d.packaged
      ? (d.portable ? '已开启（数据在 exe 同级 data）' : '未开启（数据在用户目录）')
      : '开发模式下固定用项目 data 目录';
  }
  const btn = $('#btn-portable');
  if (btn) btn.disabled = !d.packaged;
}

async function refresh() {
  const s = await api('/api/state');
  state.config = s.config;
  state.versions = s.versions ?? [];
  state.javas = s.javas ?? [];
  state.running = s.running;
  state.games = s.games || (s.running ? [s.running] : []);
  if (!state.selected || !state.versions.some((v) => v.id === state.selected)) {
    state.selected = s.config.selectedVersion || state.versions[0]?.id || '';
  }
  renderVersions();
  fillSettings();
  fillVersionSettings();
  renderHero();
  renderAccount();
  if (state.running) {
    $('#btn-stop').hidden = false;
    const all = (state.games || []).map((g) => g.id).join('、');
    appendLog({ type: 'system', text: `[TPCL] 运行中：${all || state.running.id}\n` }); // run::multi
    if ($('#run-note')) { $('#run-note').hidden = false; $('#run-note').textContent = `运行中：${all || state.running.id}`; }
  } else {
    $('#btn-stop').hidden = true;
  }
  applyI18n();
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  const settingsPage = $('#view-settings');
  const settingsLinks = $('.settings-index [data-settings-jump]');
  function highlightSettings() {
    if (!settingsPage.classList.contains('active')) return;
    const top = settingsPage.getBoundingClientRect().top + 32;
    let current = settingsLinks[0];
    for (const link of settingsLinks) {
      if (document.getElementById(link.dataset.settingsJump).getBoundingClientRect().top <= top) current = link;
    }
    if (settingsPage.scrollTop > 0 && settingsPage.scrollTop + settingsPage.clientHeight >= settingsPage.scrollHeight - 2) current = settingsLinks.at(-1);
    for (const link of settingsLinks) {
      link.classList.toggle('active', link === current);
      if (link === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }
  settingsLinks.forEach(link => link.addEventListener('click', () => {
    document.getElementById(link.dataset.settingsJump).scrollIntoView({block: 'start'});
    highlightSettings();
  }));
  settingsPage.addEventListener('scroll', highlightSettings, {passive: true});
  settingsLinks[0].classList.add('active');
  settingsLinks[0].setAttribute('aria-current', 'location');
  $('.nav-btn[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  $('#btn-launch').addEventListener('click', doLaunch);
  $('#btn-stop').addEventListener('click', doStop);
  $('#task-list')?.addEventListener('click', async e => {
    const button = e.target.closest('[data-queue]');
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
      const d = await api('/api/queue/action', { method: 'POST', body: JSON.stringify({ action: button.dataset.queue, id: button.dataset.id }) });
      if (!d.ok) toast(d.error || '任务状态已改变，请刷新后重试', true);
      if (d.task) knownQueueTasks.set(d.task.id, d.task.status);
      nudgeTasks();
    } catch (error) { toast(error.message, true); button.disabled = false; }
  });
  $('#btn-task-clear')?.addEventListener('click', async () => {
    await api('/api/queue/action', { method: 'POST', body: JSON.stringify({ action: 'clear' }) });
    await pollTasks();
  });
  $('#btn-reports')?.addEventListener('click', async () => {
    try {
      const d = await api('/api/reports');
      if (!d.ok) throw new Error(d.error || '无法读取报告');
      let dialog = $('#reports-dialog');
      if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'reports-dialog'; document.body.append(dialog); }
      dialog.replaceChildren();
      const title = document.createElement('h3'); title.textContent = '错误报告';
      const note = document.createElement('p'); note.textContent = '报告保存在本机。下载后可用于排查问题，最近 100 份按时间排列。';
      const close = document.createElement('button'); close.textContent = '关闭'; close.className = 'mini-btn'; close.onclick = () => dialog.close();
      dialog.append(title, note, close);
      for (const item of d.reports || []) {
        const link = document.createElement('a'); link.href = '/api/reports/' + encodeURIComponent(item.id); link.download = ''; link.textContent = item.time + ' · 下载报告';
        dialog.append(link);
      }
      if (!d.reports?.length) { const empty = document.createElement('p'); empty.textContent = '暂无错误报告'; dialog.append(empty); }
      if (!dialog.open) dialog.showModal();
    } catch (e) { toast(e.message, true); }
  });
  $('#btn-refresh').addEventListener('click', async () => { await refresh(); toast('已刷新'); });
  $('#btn-folder').addEventListener('click', () => api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: state.config.mcDir }) }));
  // 存档
  async function importWorldViaDialog(folder) {
    if (!state.selected) { toast('先选一个版本', true); return; }
    const picked = await api('/api/pick-file', {
      method: 'POST',
      body: JSON.stringify(folder
        ? { folder: true, title: '选择世界文件夹' }
        : { filter: '世界存档 (*.zip;*.mcworld)|*.zip;*.mcworld|所有文件 (*.*)|*.*', title: '选择世界压缩包' }),
    });
    if (!picked || picked.canceled || !picked.path) return;
    toast(folder ? '正在复制世界…' : '正在解压世界…');
    const r = await api('/api/world/import', {
      method: 'POST',
      body: JSON.stringify({ version: state.selected, path: picked.path }),
    }).catch((e) => ({ error: String(e.message || e) }));
    if (r && r.ok) {
      const names = (r.imported || []).map((x) => x.name).join('、');
      toast(`已导入 ${names}`);
      await loadWorlds();
    } else {
      toast((r && (r.error || '导入失败')) || '导入失败', true);
    }
  }

  $('#btn-world-import')?.addEventListener('click', () => importWorldViaDialog(false));
  $('#btn-world-import-dir')?.addEventListener('click', () => importWorldViaDialog(true));

  $('#btn-worlds-refresh').addEventListener('click', loadWorlds);
  $('#worlds-sort')?.addEventListener('change', (e) => {
    state.worldsSort = e.target.value;
    if (state.worldsData) renderWorlds(state.worldsData);
  });
  $('#btn-backup-all').addEventListener('click', async (e) => {
    if (!state.selected) { toast('先选一个版本', true); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '打包中…';
    try {
      const r = await api('/api/backup', { method: 'POST', body: JSON.stringify({ version: state.selected, keep: 10 }) });
      const bad = (r.results ?? []).filter((x) => !x.ok);
      toast(bad.length ? `${bad.length} 个存档备份失败` : `已备份 ${(r.results ?? []).length} 个存档`, bad.length > 0);
      await loadWorlds();
    } catch (err) {
      toast(err.message || '备份失败', true);
    } finally {
      btn.disabled = false;
      btn.textContent = '备份全部';
    }
  });
  $('#btn-open-backups').addEventListener('click', async () => {
    const d = await api(`/api/worlds?version=${encodeURIComponent(state.selected || '')}`);
    await api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: d.backupDir }) });
  });

  // 项目详情弹窗
  $('#mkd-close').addEventListener('click', closeMarketDetail);
  $('#mkd-mask').addEventListener('click', (e) => { if (e.target.id === 'mkd-mask') closeMarketDetail(); });

  // 云同步
  $('#btn-sync-refresh').addEventListener('click', () => loadSync());

  // 安装确认弹窗
  $('#inst-close').addEventListener('click', closeInstallAsk);
  $('#inst-cancel').addEventListener('click', closeInstallAsk);
  $('#inst-mask').addEventListener('click', (e) => { if (e.target.id === 'inst-mask') closeInstallAsk(); });
  $('#inst-go').addEventListener('click', () => {
    const id = state.pendingInstall;
    if (!id) return;
    const skip = $('#inst-skipassets').checked;
    closeInstallAsk();
    startInstall(id, skip);
  });

  // 快捷键：Enter 启动 / Esc 停止（输入框内不触发）
  document.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable) return;
    if (!$('#auth-mask').hidden || !$('#crash-mask').hidden || !$('#inst-mask').hidden) {
      if (e.key === 'Escape') { closeInstallAsk(); openAuth(false); openCrash(false); }
      return;
    }
    if (e.key === 'Enter' && !state.running && state.view === 'home') { e.preventDefault(); doLaunch(); }
    if (e.key === 'Escape' && state.running) { e.preventDefault(); doStop(); }
  });
  $('#btn-sync-pick').addEventListener('click', async () => {
    const r = await api('/api/pick-folder', { method: 'POST', body: JSON.stringify({ title: '选择云同步目录' }) });
    if (!r?.path) return;
    const s = await api('/api/sync/dir', { method: 'POST', body: JSON.stringify({ path: r.path }) });
    if (s?.ok) { toast('同步目录已设置'); loadSync(); }
    else toast(s?.error || '设置失败', true);
  });
  document.getElementById('btn-sync-diff')?.addEventListener('click', async () => {
    const box = document.getElementById('sync-diff-list');
    const note = document.getElementById('sync-diff-note');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<div class="row-sub">正在对比…</div>';
    try {
      const d = await api('/api/sync/diff?version=' + encodeURIComponent(state.selected || ''));
      if (!d.ok) {
        box.innerHTML = '<div class="row-sub">' + escapeHtml(d.error || '对比失败') + '</div>';
        if (note) note.textContent = '';
        return;
      }
      const c = d.counts || {};
      if (note) note.textContent = '本地 ' + c.local + ' · 远端 ' + c.remote + ' · 一致 ' + c.same;
      const dt = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');
      const sec = (title, arr, fmt) => (arr && arr.length
        ? '<div class="sync-diff-sec"><b>' + title + '（' + arr.length + '）</b>' + arr.map((x) => '<div class="sync-diff-row">' + escapeHtml(x.name) + '<span class="row-sub">' + fmt(x) + '</span></div>').join('') + '</div>'
        : '');
      const html = [
        sec('只在本地（还没推送）', d.onlyLocal, (x) => '本地 ' + dt(x.mtime)),
        sec('只在远端（还没拉取）', d.onlyRemote, (x) => '远端 ' + dt(x.mtime)),
        sec('本地更新（建议推送）', d.newerLocal, (x) => '本地 ' + dt(x.mtime) + ' ／ 远端 ' + dt(x.remoteMtime)),
        sec('远端更新（建议拉取）', d.newerRemote, (x) => '远端 ' + dt(x.remoteMtime) + ' ／ 本地 ' + dt(x.mtime)),
      ].join('');
      box.innerHTML = html || '<div class="row-sub">两边完全一致，没有要同步的世界。</div>';
    } catch (e) {
      box.innerHTML = '<div class="row-sub">对比失败：' + escapeHtml(e.message || String(e)) + '</div>';
    }
  });

  $('#btn-sync-push').addEventListener('click', async (e) => {
    if (!state.selected) { toast('先选一个版本', true); return; }
    if (!$('#sync-dir').value) { toast('先选择一个同步目录', true); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '推送中…';
    try {
      const r = await api('/api/sync/push', {
        method: 'POST',
        body: JSON.stringify({ version: state.selected }),
      });
      if (r?.ok) {
        const n = (r.pushed ?? []).filter((x) => !x.error).length;
        toast(`已推送 ${n} 个世界到同步目录`);
      } else {
        toast(r?.error || '推送失败', true);
      }
      await loadWorlds();
    } finally {
      btn.disabled = false;
      btn.textContent = '推送全部';
    }
  });

  // 服务器
  $('#btn-sv-add').addEventListener('click', addServer);
  $('#btn-sv-refresh').addEventListener('click', loadServers);
  $('#btn-lan-refresh')?.addEventListener('click', loadLan);
  $('#lan-list')?.addEventListener('click', (e) => {
    const j = e.target.closest('[data-lan-join]');
    if (j) { lanJoin(j.dataset.lanJoin); return; }
    const s = e.target.closest('[data-lan-save]');
    if (s) lanSave(s.dataset.lanSave, s.dataset.lanMotd);
  });
  $('#btn-sv-export').addEventListener('click', exportServers);
  $('#btn-sv-import').addEventListener('click', importServers);
  $('#sv-host').addEventListener('keydown', (e) => { if (e.key === 'Enter') addServer(); });
  $('#sv-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addServer(); });

  // 皮肤
  $('#btn-skin-pick').addEventListener('click', pickSkinFile);
  $('#btn-skin-upload').addEventListener('click', uploadSkinNow);
  $('#btn-skin-reset').addEventListener('click', resetSkinNow);
  $('#btn-skin-download').addEventListener('click', downloadMySkinNow);
  $('#btn-skin-gallery')?.addEventListener('click', loadSkinGallery);
  $('#btn-skin-lookup').addEventListener('click', lookupSkin);
  $('#skin-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') lookupSkin(); });

  $('#search-version').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; renderVersions(); e.target.blur(); }
  });
  $('#search-version').addEventListener('input', renderVersions);
  $('#search-remote').addEventListener('input', renderRemote);
  $$('#dl-filter .chip').forEach((c) => c.addEventListener('click', () => {
    state.dlFilter = c.dataset.vtype;
    $$('#dl-filter .chip').forEach((x) => x.classList.toggle('active', x === c));
    renderRemote();
  }));
  $('#btn-reload-remote').addEventListener('click', () => loadRemote(true));

  // 下载页分栏：原版 / Forge / NeoForge / Fabric / 整合包
  $$('#dl-tabs .tab').forEach((t) => t.addEventListener('click', () => showDlTab(t.dataset.dl)));
  $('#ld-mc').addEventListener('change', () => {
    const manual = $('#ld-mc').value === '__manual';
    $('#ld-mc-manual').hidden = !manual;
    if (manual) { $('#ld-mc-manual').focus(); $('#ld-list').innerHTML = '<div class="empty-hint">输入版本号后自动列出加载器版本</div>'; return; }
    loadLoaderVersions();
  });
  $('#ld-mc-manual').addEventListener('input', () => {
    clearTimeout(state.ldTimer);
    state.ldTimer = setTimeout(() => { if (ldMcValue().length >= 3) loadLoaderVersions(); }, 500);
  });
  $('#ld-list').addEventListener('click', (e) => {
    const more = e.target.closest('#ld-more');
    if (more) { state.loaderExpanded = !state.loaderExpanded; loadLoaderVersions(); return; }
    const b = e.target.closest('[data-ldver]');
    if (b) startLoaderInstall(b.dataset.ldver);
  });
  $('#btn-mp-pick').addEventListener('click', pickModpackFile);
  $('#btn-mp-install').addEventListener('click', async () => {
    const file = ($('#mp-path').value || '').trim();
    if (!file) { toast('先选一个整合包文件', true); return; }
    await askModpack(file);
  });
  $('#mp-close').addEventListener('click', closeModpackAsk);
  $('#mp-cancel').addEventListener('click', closeModpackAsk);
  $('#mp-mask').addEventListener('click', (e) => { if (e.target.id === 'mp-mask') closeModpackAsk(); });
  $('#mp-go').addEventListener('click', () => {
    const file = mpPending || ($('#mp-path').value || '').trim();
    closeModpackAsk();
    if (file) startModpackImport(file);
  });

  $('#btn-mk-go').addEventListener('click', searchMarket);
  $('#mk-sort')?.addEventListener('change', () => searchMarket());
  $('#mk-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchMarket(); });
  $('#mk-type').addEventListener('change', () => catalog.search());
  $$('#mk-src .chip').forEach(c => c.addEventListener('click', () => {
    $$('#mk-src .chip').forEach(x => x.classList.toggle('active', x === c));
    state.mkSrc = c.dataset.mksrc;
    catalog.search();
  }));
  $('#catalog-match').addEventListener('change', () => catalog.search());
  $('#catalog-configure').addEventListener('click', () => catalog.configure().catch(e => toast(e.message, true)));

  const ofLoad = document.getElementById('btn-of-load');
  if (ofLoad) ofLoad.addEventListener('click', () => fetchOptifineList());
  const ofSel = document.getElementById('of-version');
  if (ofSel) ofSel.addEventListener('change', () => fetchOptifineList());
  // 自定义背景图
  if ($('#bg-pick')) {
    $('#bg-pick').addEventListener('click', async () => {
      const picked = await api('/api/pick-file', {
        method: 'POST',
        body: JSON.stringify({ filter: '图片 (*.png;*.jpg;*.jpeg;*.webp;*.bmp)|*.png;*.jpg;*.jpeg;*.webp;*.bmp|所有文件 (*.*)|*.*', title: '选择背景图' }),
      });
      if (!picked || picked.canceled || !picked.path) return;
      const r = await api('/api/theme/bg', {
        method: 'POST',
        body: JSON.stringify({ file: picked.path, dim: Number($('#bg-dim').value), blur: Number($('#bg-blur').value) }),
      });
      if (r?.ok) { toast('背景已更新'); applyBg(r.bgPath); }
      else toast(r?.error || '设置失败', true);
    });
    $('#bg-clear').addEventListener('click', async () => {
      await api('/api/theme/bg', { method: 'DELETE' });
      applyBg('');
      toast('背景已清除');
    });
    const bump = () => {
      $('#bg-dim-val').textContent = Math.round(Number($('#bg-dim').value) * 100) + '%';
      $('#bg-blur-val').textContent = $('#bg-blur').value + ' px';
      applyBgStyle(Number($('#bg-dim').value), Number($('#bg-blur').value));
    };
    $('#bg-dim').addEventListener('input', bump);
    $('#bg-blur').addEventListener('input', bump);
  }

  $('#btn-crash').addEventListener('click', () => openCrash(false));  $('#crash-close').addEventListener('click', () => { $('#crash-mask').hidden = true; });
  $('#crash-mask').addEventListener('click', (e) => { if (e.target === $('#crash-mask')) $('#crash-mask').hidden = true; });
  $('#crash-back').addEventListener('click', () => { $('#crash-detail').hidden = true; $('#crash-list').hidden = false; });
  $('#btn-vs-save').addEventListener('click', () => saveVersionConfig(false));
  $('#btn-vs-clear').addEventListener('click', () => saveVersionConfig(true));

  $('#btn-clear-log').addEventListener('click', () => {
    $('#log').innerHTML = '';
    state.logWarn = 0;
    state.logError = 0;
    paintLogCounts();
  });
  $('#log-filter')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lf]');
    if (b) setLogFilter(b.dataset.lf);
  });
  $('#btn-export-log')?.addEventListener('click', async () => {
    const text = $('#log').textContent || '';
    if (!text.trim()) { toast('日志是空的', true); return; }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const name = `TPCL-log-${state.selected || 'launcher'}-${stamp}.txt`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    toast('已导出日志文件');
  });
  $('#btn-copy-log')?.addEventListener('click', async () => {
    const text = ($('#log').textContent || '').trim();
    if (!text) { toast('日志是空的', true); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${text.split('\n').length} 行日志`);
    } catch {
      toast('复制失败，浏览器拒绝了剪贴板权限', true);
    }
  });
  $('#btn-toggle-log').addEventListener('click', () => {
    const pre = $('#log');
    pre.classList.toggle('collapsed');
    $('#btn-toggle-log').textContent = pre.classList.contains('collapsed') ? '展开' : '收起';
  });

  $('#btn-save').addEventListener('click', saveSettings);
  $('#s-lang').addEventListener('change', async (e) => {
    const locale = e.target.value === 'en' ? 'en' : 'zh';
    setLang(locale);
    state.config.locale = locale;
    await api('/api/config', { method: 'POST', body: JSON.stringify({ locale }) });
    applyI18n();
    toast(locale === 'en' ? 'Language switched to English' : '已切换为中文');
  });
  $('#s-memory-range').addEventListener('input', (e) => { $('#s-memory').value = e.target.value; });
  $('#s-gamelang')?.addEventListener('change', async (e) => {
    const lang = e.target.value;
    await api('/api/config', { method: 'POST', body: JSON.stringify({ language: lang }) });
    state.config.language = lang;
    toast(`游戏语言：${e.target.selectedOptions[0]?.textContent || lang}（下次启动生效）`);
  });
  $('#s-forcelang')?.addEventListener('change', async (e) => {
    const force = e.target.checked;
    await api('/api/config', { method: 'POST', body: JSON.stringify({ forceGameLang: force }) });
    state.config.forceGameLang = force;
  });
  $('#btn-applylang')?.addEventListener('click', async () => {
    const lang = $('#s-gamelang')?.value || 'zh_cn';
    const r = await api('/api/game-lang', { method: 'POST', body: JSON.stringify({ lang, force: $('#s-forcelang')?.checked !== false }) });
    if (r.ok) {
      toast(`已写入 ${lang}`);
      if ($('#s-curlang')) $('#s-curlang').textContent = lang;
    } else toast(r.error || '写入失败', true);
  });
  $('#s-memory').addEventListener('input', (e) => {
    const v = Number(e.target.value) || 0;
    if (v <= 32768) $('#s-memory-range').value = v;
  });
  $('#s-mcDir-open').addEventListener('click', () => api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: state.config.mcDir }) }));
  $('#s-java-rescan').addEventListener('click', async () => {
    const r = await api('/api/java');
    state.javas = r.javas ?? [];
    fillSettings();
    toast(`找到 ${state.javas.length} 个 Java`);
  });
  $('#s-java-dl').addEventListener('click', () => {
    ensureJava(Number($('#s-java-major').value));
  });
  $('#s-java-pick')?.addEventListener('click', async () => {
    const picked = await api('/api/pick-file', {
      method: 'POST',
      body: JSON.stringify({ title: '选择 java.exe', filter: 'Java 可执行文件 (java.exe)|java.exe|所有文件 (*.*)|*.*' }),
    });
    const file = picked?.path || '';
    if (!file) return;
    const info = await api('/api/java/inspect', { method: 'POST', body: JSON.stringify({ path: file }) });
    if (!info?.ok) { toast(`不能用：${info?.error || '校验失败'}`); return; }
    await api('/api/config', { method: 'POST', body: JSON.stringify({ javaPath: info.path }) });
    const r = await api('/api/java');
    state.javas = r.javas ?? [];
    fillSettings();
    const hint = $('#s-java-pick-hint');
    if (hint) hint.textContent = `已指定 Java ${info.major}（${info.version}）· ${info.path}`;
    toast(`已指定 Java ${info.major}`);
  });
  $('#hero-fix')?.addEventListener('click', fixCurrent);
  $('#rn-close').addEventListener('click', closeRename);
  $('#rn-cancel').addEventListener('click', closeRename);
  $('#rn-mask').addEventListener('click', (e) => { if (e.target.id === 'rn-mask') closeRename(); });
  $('#rn-go').addEventListener('click', submitRename);
  $('#rn-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitRename(); }
    if (e.key === 'Escape') closeRename();
  });

  $$('#content-tabs .tab').forEach((t) => t.addEventListener('click', () => {
    $$('#content-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
    state.contentKind = t.dataset.kind;
    if (state.contentKind === 'shots') loadContent().catch(() => {});
    else renderContent();
  }));
  // 检查模组/资源包/光影更新（按本地文件 SHA-1 问 Modrinth）
  $('#btn-check-updates').addEventListener('click', async () => {
    const kind = state.contentKind;
    const hint = $('#update-hint');
    if (!['mods', 'resourcepacks', 'shaderpacks'].includes(kind)) {
      hint.hidden = false;
      hint.textContent = '存档不支持更新检查';
      return;
    }
    const btn = $('#btn-check-updates');
    btn.disabled = true;
    btn.textContent = '检查中…';
    hint.hidden = false;
    hint.textContent = '正在按文件指纹比对 Modrinth…';
    const r = await api('/api/content/updates', { method: 'POST', body: JSON.stringify({ version: state.selected, kind }) });
    btn.disabled = false;
    btn.textContent = '检查更新';
    if (r.error) { hint.textContent = `检查失败：${r.error}`; return; }
    const updates = r.updates || [];
    state.updates = state.updates ?? {};
    state.updates[kind] = Object.fromEntries(updates.map((u) => [u.file, u]));
    hint.textContent = updates.length
      ? Tpl('检查了 {n} 个文件，{m} 个有新版', { n: r.checked, m: updates.length })
      : Tpl('检查了 {n} 个文件，都是最新', { n: r.checked });
    renderContent();
  });

  $('#content-search')?.addEventListener('input', (e) => {
    state.contentQuery = e.target.value;
    renderContent();
  });
  $('#content-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.target.value = '';
      state.contentQuery = '';
      renderContent();
      e.target.blur();
    }
  });
  $('#shot-view-close')?.addEventListener('click', closeShotView);
  $('#shot-mask')?.addEventListener('click', (e) => { if (e.target === $('#shot-mask')) closeShotView(); });
  $('#shot-view-folder')?.addEventListener('click', async () => {
    const name = state.shotViewing;
    if (!name) return;
    await api('/api/open-folder', {
      method: 'POST',
      body: JSON.stringify({ path: state.shotsDir || "", file: name }),
    }).catch(() => {});
  });
  $('#shot-view-del')?.addEventListener('click', async () => {
    const name = state.shotViewing;
    if (!name) return;
    if (!confirm(`删除截图「${name}」？`)) return;
    const r = await api('/api/shots/delete', {
      method: 'POST',
      body: JSON.stringify({ version: state.selected, names: [name] }),
    });
    if (r?.ok) {
      state.shots = r.shots ?? [];
      closeShotView();
      renderShots();
      toast('已删除');
    } else toast(r?.error || '删除失败', true);
  });

  $('#btn-open-content').addEventListener('click', () => {
    if (!state.selected) { toast('先选版本', true); return; }
    api('/api/open-folder', {
      method: 'POST',
      body: JSON.stringify({ version: state.selected, kind: state.contentKind }),
    });
  });

  // 整合包拖拽：松手自动导入
  bindModpackDrop();

  // 导入本地文件到当前版本的内容目录
  // 拖拽文件到内容页直接导入
  const dz = $('#view-content');
  if (dz) {
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragging'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragging'));
    dz.addEventListener('drop', async (e) => {
      e.preventDefault();
      dz.classList.remove('dragging');
      if (!state.selected) { toast('先选版本', true); return; }
      const pathOf = (f) => (typeof f.path === 'string' && f.path) || (window.tpcl && window.tpcl.getPathForFile ? window.tpcl.getPathForFile(f) : '');
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => pathOf(f));
      if (!files.length) { toast('读不到文件路径，请用「导入文件」', true); return; }
      const kind = state.contentKind || 'mods';
      let okCount = 0;
      for (const f of files) {
        let r = await api('/api/content/import', {
          method: 'POST',
          body: JSON.stringify({ version: state.selected, kind, path: pathOf(f) }),
        });
        if (r.exists && confirm(`「${r.name}」已存在，覆盖吗？`)) {
          r = await api('/api/content/import', {
            method: 'POST',
            body: JSON.stringify({ version: state.selected, kind, path: pathOf(f), overwrite: true }),
          });
        }
        if (r.ok) okCount += 1;
        else if (!r.exists) toast(`${f.name}：${r.error || '导入失败'}`, true);
      }
      if (okCount) { toast(files.length > 1 ? `已导入 ${okCount} 个文件` : '已导入'); await loadContent(); }
    });
  }

  $('#btn-import-content')?.addEventListener('click', async () => {
    if (!state.selected) { toast('先选版本', true); return; }
    const KIND_NAMES = { mods: '模组', resourcepacks: '资源包', shaderpacks: '光影', saves: '存档', datapacks: '数据包' };
    const FILTERS = {
      mods: '模组 (*.jar)|*.jar', resourcepacks: '资源包 (*.zip)|*.zip',
      shaderpacks: '光影 (*.zip)|*.zip', saves: '存档 (*.zip)|*.zip', datapacks: '数据包 (*.zip)|*.zip',
    };
    const kind = state.contentKind || 'mods';
    const pick = await api('/api/pick-file', {
      method: 'POST',
      body: JSON.stringify({ title: `导入${KIND_NAMES[kind] ?? '文件'}`, filter: `${FILTERS[kind] ?? '所有文件 (*.*)|*.*'}|所有文件 (*.*)|*.*` }),
    });
    if (!pick?.path) return;
    let r = await api('/api/content/import', {
      method: 'POST',
      body: JSON.stringify({ version: state.selected, kind, path: pick.path }),
    });
    if (r.exists && confirm(`「${r.name}」已存在，覆盖吗？`)) {
      r = await api('/api/content/import', {
        method: 'POST',
        body: JSON.stringify({ version: state.selected, kind, path: pick.path, overwrite: true }),
      });
    }
    if (r.ok) { toast(`已导入 ${r.file}`); await loadContent(); }
    else if (!r.exists) toast(r.error || '导入失败', true);
  });

  $('#btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = cur;
    localStorage.setItem('tpcl-theme', cur);
    api('/api/config', { method: 'POST', body: JSON.stringify({ theme: cur }) }).catch(reportClientError);
  });
  for (const theme of ['light', 'dark']) $('#theme-' + theme)?.addEventListener('click', () => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('tpcl-theme', theme);
    api('/api/config', { method: 'POST', body: JSON.stringify({ theme }) }).catch(reportClientError);
  });

  // 账号
  $('#acc-chip').addEventListener('click', () => openAuth(true));
  $('#btn-side-account')?.addEventListener('click', () => openAuth(true));
  $('#btn-side-download')?.addEventListener('click', () => showView('download'));
  $('#btn-side-content')?.addEventListener('click', () => showView('content'));
  $('#btn-side-worlds')?.addEventListener('click', () => showView('worlds'));
  $('#btn-side-settings')?.addEventListener('click', () => showView('settings'));

  // 版本下拉
  $('#ver-pick')?.addEventListener('change', (e) => {
    if (e.target.value) selectVersion(e.target.value);
  });

  // 更多页
  $('#btn-more-repair')?.addEventListener('click', () => repairCurrent());
  $('#btn-export-pack')?.addEventListener('click', async () => {
    const id = state.selected;
    if (!id) { toast('先选一个版本', true); return; }
    const withSaves = confirm(`导出「${id}」为整合包。\n\n点「确定」= 连存档一起导出；点「取消」= 只导 mods / config / 资源包。`);
    const btn = $('#btn-export-pack');
    if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
    try {
      const r = await api('/api/modpack/export', { method: 'POST', body: JSON.stringify({ version: id, includeSaves: withSaves }) });
      if (!r.ok) { toast(r.error || '导出失败', true); return; }
      const mb = (r.bytes / 1048576).toFixed(1);
      toast(`已导出 ${r.file.split(/[\\/]/).pop()}（${mb} MB，含 ${r.entries.join(' / ')}）`);
      await api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: r.file.replace(/[\\/][^\\/]+$/, '') }) });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '导出整合包'; }
    }
  });
  $('#btn-more-openver')?.addEventListener('click', async () => {
    if (!state.selected) { toast('先选一个版本', true); return; }
    await api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: `${state.config.mcDir}\\versions\\${state.selected}` }) });
  });
  $('#btn-more-delete')?.addEventListener('click', async () => {
    const id = state.selected;
    if (!id) { toast('先选一个版本', true); return; }
    if (!confirm(`确定删除版本「${id}」？版本目录会被整个删掉。`)) return;
    const r = await api('/api/delete-version', { method: 'POST', body: JSON.stringify({ id }) });
    if (r.ok) { toast('已删除'); inspectCacheReset(id); await refresh(); showView('more'); }
    else toast(r.error || '删除失败', true);
  });
  $('#btn-clear-cache')?.addEventListener('click', async () => {
    if (!confirm('清空下载缓存？只删 data/cache，已装好的版本和库不受影响。')) return;
    const r = await api('/api/cache/clear', { method: 'POST' });
    if (r.ok) { toast(`已释放 ${fmtSize(r.freed)}`); loadMore(); }
    else toast(r.error || '清理失败', true);
  });
  $('#btn-clear-logs')?.addEventListener('click', async () => {
    if (!confirm('清空启动器日志文件？（不影响正在显示的日志）')) return;
    const r = await api('/api/logs/clear', { method: 'POST' });
    if (r.ok) { toast(`已删除 ${r.removed} 个日志文件`); loadMore(); }
    else toast(r.error || '清理失败', true);
  });
  $('#btn-open-data')?.addEventListener('click', () => api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: $('#more-datadir').textContent }) }));
  $('#btn-open-game')?.addEventListener('click', () => api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: state.config.mcDir }) }));
  document.getElementById('btn-export-config')?.addEventListener('click', async () => {
    const hint = document.getElementById('s-migrate-hint');
    try {
      const r = await (await fetch('/api/config/export', { method: 'POST' })).json();
      if (!r.ok) throw new Error(r.error || '导出失败');
      if (hint) hint.textContent = '已导出 ' + (r.keys || 0) + ' 项设置（' + (r.size / 1024).toFixed(1) + ' KB）';
      toast('配置已导出：' + r.file);
      fetch('/api/open-folder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: r.file.replace(/[\\/][^\\/]+$/, '') }) }).catch(() => {});
    } catch (e) {
      if (hint) hint.textContent = String(e.message || e);
      toast('导出失败：' + (e.message || e));
    }
  });

  document.getElementById('btn-import-config')?.addEventListener('click', async () => {
    const hint = document.getElementById('s-migrate-hint');
    try {
      const picked = await (await fetch('/api/pick-file?filter=' + encodeURIComponent('JSON 配置|*.json'), { method: 'POST' })).json();
      if (!picked || !picked.path) return;
      const r = await (await fetch('/api/config/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: picked.path }) })).json();
      if (!r.ok) throw new Error(r.error || '导入失败');
      if (hint) hint.textContent = '已导入 ' + r.applied + ' 项（导出于 ' + (r.exportedAt || '未知') + '）';
      toast('配置已导入，正在刷新…');
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      if (hint) hint.textContent = String(e.message || e);
      toast('导入失败：' + (e.message || e));
    }
  });

  $('#btn-changelog')?.addEventListener('click', () => loadChangelog(true));

  $('#s-mirrorUrl')?.addEventListener('change', () => saveSettings().catch(() => {}));
  $('#s-proxy')?.addEventListener('change', () => saveSettings().catch(() => {}));
  $('#btn-net-apply')?.addEventListener('click', async () => {
    const st = document.getElementById('s-net-state');
    try {
      const r = await (await fetch('/api/net/apply', { method: 'POST' })).json();
      if (st) st.textContent = '镜像 ' + (r.base || '-') + (r.proxy ? ' · 代理 ' + r.proxy : ' · 直连');
      toast(r.proxy ? '代理已生效：' + r.proxy : '已切回直连');
    } catch (e) {
      if (st) st.textContent = '失败：' + (e.message || e);
    }
  });

  $('#btn-open-data2')?.addEventListener('click', () => loadPaths().then((d) => d && api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: d.dataDir }) })));
  $('#btn-open-game2')?.addEventListener('click', () => loadPaths().then((d) => d && api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: d.gameDir }) })));
  $('#btn-portable')?.addEventListener('click', async () => {
    const cur = state.paths?.portable;
    const want = !cur;
    const d = await api('/api/portable', { method: 'POST', body: JSON.stringify({ on: want }) });
    if (!d.ok) { toast(d.error || '切换失败', true); return; }
    state.paths = { ...(state.paths || {}), portable: d.portable };
    paintPaths(state.paths);
    toast(`已${want ? '打开' : '关闭'}便携模式，重启后生效`);
  });
  $('#btn-restart')?.addEventListener('click', async () => {
    const d = await api('/api/restart', { method: 'POST' });
    if (!d.ok) { toast(d.error || '这个运行方式不支持自动重启', true); return; }
    toast('正在重启…');
  });
  $('#btn-open-logs')?.addEventListener('click', async () => {
    const st = await api('/api/stats').catch(() => null);
    const dir = st?.dataDir ? `${st.dataDir}\\\\logs` : '';
    if (!dir) { toast('拿不到数据目录', true); return; }
    await api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: dir }) });
  });
  $('#btn-open-crashes')?.addEventListener('click', async () => {
    const id = state.selected;
    if (!id) { toast('先选一个版本', true); return; }
    const d = await api(`/api/crashes?version=${encodeURIComponent(id)}`).catch(() => null);
    if (!d?.dir) { toast('还没生成过崩溃报告', true); return; }
    await api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: d.dir }) });
  });
  $('#btn-feedback')?.addEventListener('click', async () => {
    const url = 'https://qm.qq.com/q/x90dOIHsNc';
    try {
      await api('/api/open-url', { method: 'POST', body: JSON.stringify({ url }) });
      toast('已在浏览器打开反馈群');
    } catch {
      try { window.open(url, '_blank'); } catch { toast('打开失败，手动访问 ' + url, true); }
    }
  });
  // 联机：免费隧道
  const npStatus = (t) => { const el = $('#np-status'); if (el) el.textContent = t; };
  const npPaint = (st) => {
    const on = !!st?.running;
    if ($('#btn-np-start')) $('#btn-np-start').hidden = on;
    if ($('#btn-np-stop')) $('#btn-np-stop').hidden = !on;
    if ($('#np-result-wrap')) $('#np-result-wrap').hidden = !st?.addr;
    if ($('#np-addr')) $('#np-addr').value = st?.addr || '';
    if ($('#np-port') && st?.port && !on) { /* 保留用户输入 */ }
    npStatus(on ? `房间已开：${st.addr || '连接中…'}` : (st?.available === false ? '联机组件缺失（data/tools/bore.exe）' : '未开启'));
  };
  const npRefresh = async () => {
    try { npPaint(await api('/api/netplay/state')); } catch { /* 忽略 */ }
  };
  $('#btn-np-detect')?.addEventListener('click', async () => {
    const r = await api('/api/netplay/detect').catch(() => null);
    if (r?.port) {
      if ($('#np-port')) $('#np-port').value = r.port;
      toast(r.from === 'log' ? `从日志读到端口 ${r.port}` : '日志里没有记录，先按 25565 试');
    }
  });
  $('#btn-np-start')?.addEventListener('click', async () => {
    const port = Number($('#np-port')?.value || 25565);
    npStatus('正在连接公共中继…');
    const r = await api('/api/netplay/start', { method: 'POST', body: JSON.stringify({ port }) }).catch((e) => ({ ok: false, error: String(e.message || e) }));
    if (!r?.ok) { npStatus(r?.error || '开房间失败'); return; }
    npPaint(r.state || { running: true, addr: r.addr, port });
    toast('房间已开：' + r.addr);
  });
  $('#btn-np-stop')?.addEventListener('click', async () => {
    await api('/api/netplay/stop', { method: 'POST' }).catch(() => null);
    npPaint({ running: false });
    toast('已关掉联机');
  });
  $('#btn-np-copy')?.addEventListener('click', async () => {
    const v = $('#np-addr')?.value || '';
    if (!v) return;
    try { await navigator.clipboard.writeText(v); toast('已复制 ' + v); } catch { toast('复制失败，手动选中', true); }
  });
  if ($('#btn-np-start')) npRefresh();
  $('#btn-more-refresh')?.addEventListener('click', () => loadMore());
  $('#btn-selfcheck')?.addEventListener('click', () => runSelfcheck());
  $('#btn-check-update')?.addEventListener('click', () => checkLauncherUpdate());
  $('#btn-check-update')?.addEventListener('click', async () => { await updRefresh(); });
  if (location.hash.includes('more') || $('#btn-do-update')) updRefresh();
  $('#btn-dl-setup')?.addEventListener('click', async () => {
    const url = state.updAsset;
    if (!url) { toast('先点「检查更新」拿到安装包地址', true); return; }
    try {
      await api('/api/open-url', { method: 'POST', body: JSON.stringify({ url }) });
      toast('已在浏览器里开始下载');
    } catch { toast('打不开，手动访问 ' + url, true); }
  });
  // 应用内自更新：下载 → 替换 → 重启
  $('#btn-do-update')?.addEventListener('click', async () => {
    const btn = $('#btn-do-update');
    const mode = btn.dataset.mode;
    if (mode === 'apply') {
      if (!confirm('现在替换并重启启动器？游戏不会受影响。')) return;
      try {
        await api('/api/update/apply', { method: 'POST', body: JSON.stringify({}) });
        toast('正在替换，启动器马上重启');
        const sm = $('#upd-summary');
        if (sm) sm.textContent = '正在替换文件…';
      } catch (e) { toast(e.message || '替换失败', true); }
      return;
    }
    btn.disabled = true;
    btn.textContent = '准备下载…';
    try {
      const r = await api('/api/update/download', { method: 'POST', body: JSON.stringify({}) });
      if (!r || !r.ok) throw new Error((r && r.error) || '下载没有开始');
      updPaint({ show: true, pct: 0 });
      btn.textContent = '下载中…';
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '立即更新';
      toast(e.message || '下载失败', true);
      const s2 = $('#upd-summary');
      if (s2) { s2.className = 'more-key bad'; s2.textContent = '下载失败：' + (e.message || '未知原因'); }
    }
  });
  $('#btn-open-release')?.addEventListener('click', async () => {
    const url = state.updUrl || 'https://github.com/taohua157885/TPCL1/releases';
    try { await api('/api/open-url', { method: 'POST', body: JSON.stringify({ url }) }); }
    catch { toast('打不开，手动访问 ' + url, true); }
  });
  $('#btn-copy-launch')?.addEventListener('click', async () => {
    const ll = state.config?.lastLaunch;
    if (!ll?.args?.length) { toast('还没有启动记录', true); return; }
    const text = `${ll.java}\n${ll.args.join(' ')}`;
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${ll.id} 的启动参数`);
    } catch { toast('复制失败（剪贴板被占用）', true); }
  });
  const openUrl = (u) => window.open(u, '_blank', 'noopener');
  $('#btn-link-mcmod')?.addEventListener('click', () => openUrl('https://www.mcmod.cn/'));
  $('#btn-link-modrinth')?.addEventListener('click', () => openUrl('https://modrinth.com/'));
  $('#btn-link-fabric')?.addEventListener('click', () => openUrl('https://wiki.fabricmc.net/'));
  $('#auth-close').addEventListener('click', () => openAuth(false));
  $('#auth-mask').addEventListener('click', (e) => { if (e.target.id === 'auth-mask') openAuth(false); });
  $$('#auth-tabs .tab').forEach((t) => t.addEventListener('click', () => showAuthTab(t.dataset.at)));
  $('#btn-ms-start').addEventListener('click', startMsLogin);
  $('#btn-ms-copy').addEventListener('click', async () => {
    const code = $('#ms-user-code').textContent.trim();
    try { await navigator.clipboard.writeText(code); toast(`已复制 ${code}`); }
    catch { toast('复制失败，请手动选择', true); }
  });
  $('#btn-off-save').addEventListener('click', saveOfflineName);
  $('#off-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveOfflineName(); });
  $('#btn-logout').addEventListener('click', logoutAccount);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F5') { e.preventDefault(); refresh(); }
    if (e.key === 'Enter' && e.ctrlKey) doLaunch();
  });
}

/* ---------------- 崩溃分析 ---------------- */
async function openCrash(auto = false) {
  const mask = $('#crash-mask');
  if (auto === false && !mask.hidden) { mask.hidden = true; return; }
  mask.hidden = false;
  $('#crash-detail').hidden = true;
  $('#crash-list').hidden = false;
  const list = $('#crash-list');
  list.innerHTML = '<div class="empty">正在读取崩溃报告…</div>';
  const r = await api(`/api/crashes?version=${encodeURIComponent(state.selected || '')}`);
  const items = r.items || [];
  if (!items.length) {
    list.innerHTML = `<div class="empty">${auto ? '这次没留下崩溃报告（可能是被系统结束，或 Java 直接退出）。' : '还没有崩溃记录。'}${
      r.dir ? `<br><span class="dim">${escapeHtml(r.dir)}</span>` : ''}</div>`;
    return;
  }
  list.innerHTML = items.map((it) => `
    <div class="row-item crash-row" data-crash="${escapeAttr(it.file)}">
      <div class="row-main">
        <div class="row-title">${escapeHtml(it.description || it.file)}</div>
        <div class="row-sub">${escapeHtml(it.exception || '—')}</div>
        <div class="row-sub">${fmtDate(new Date(it.mtime).toISOString())} · ${fmtSize(it.size)}</div>
      </div>
      <span class="mini-btn">查看</span>
    </div>`).join('');
  $$('[data-crash]', list).forEach((el) => {
    el.addEventListener('click', () => showCrash(el.dataset.crash));
  });
}

function paintCrash(r) {
  $('#crash-list').hidden = true;
  const box = $('#crash-detail');
  box.hidden = false;
  $('#crash-title').textContent = r.title;
  $('#crash-cause').textContent = r.cause;
  $('#crash-tips').innerHTML = (r.tips || []).map((t) => `<li>${escapeHtml(t)}</li>`).join('');

  // 一键修复：把建议变成可点的动作
  try {
  const acts = Array.isArray(r.actions) ? r.actions : [];
  const actsBox = $('#crash-acts');
  if (actsBox) {
    actsBox.innerHTML = acts.map((a) => `<button class="mini-btn accent crash-act" data-fix="${escapeAttr(a.id)}" title="${escapeAttr(a.hint || '')}">${escapeHtml(a.label)}</button>`).join('');
    actsBox.hidden = !acts.length;
    [...actsBox.querySelectorAll('.crash-act')].forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.fix;
        btn.disabled = true;
        btn.textContent = '处理中…';
        try {
          const rr = await api('/api/crash/fix', { method: 'POST', body: JSON.stringify({ version: r.version || state.selected, action: id }) });
          toast(rr.message || (rr.ok ? '已处理' : '处理失败'), !rr.ok);
          btn.textContent = rr.ok ? '✓ 已完成' : '✕ 失败';
          if (rr.ok) setTimeout(() => { btn.disabled = false; btn.textContent = (acts.find((x) => x.id === id) || {}).label || id; }, 1800);
          else { btn.disabled = false; btn.textContent = (acts.find((x) => x.id === id) || {}).label || id; }
        } catch (e) {
          toast('处理失败：' + e.message, true);
          btn.disabled = false;
        }
      });
    });
  }
  } catch (e) { console.warn('crash actions render failed:', e); }
  const modsWrap = $('#crash-mods-wrap');
  const mods = r.mods || [];
  modsWrap.hidden = !mods.length;
  $('#crash-mods').textContent = mods.join('、');
  $('#crash-pre').textContent = [
    r.description ? `Description: ${r.description}` : '',
    r.exception || '',
    r.stack ? '  ' + r.stack : '',
    r.extraHits?.length ? `另外还匹配到：${r.extraHits.map((h) => h.title).join('；')}` : '',
  ].filter(Boolean).join('\n');
  const full = $('#crash-full');
  full.hidden = true;
  full.textContent = '';
  $('#crash-raw').onclick = () => {
    full.hidden = !full.hidden;
    if (!full.hidden && !full.textContent) full.textContent = r.text || '（报告太大，已截断）';
    $('#crash-raw').textContent = full.hidden ? '查看完整报告' : '收起完整报告';
  };
  fx.play('tap');
}

async function showCrash(file) {
  const r = await api(`/api/crash?version=${encodeURIComponent(state.selected || '')}&file=${encodeURIComponent(file)}`);
  if (r.error) { toast(r.error, true); return; }
  paintCrash(r);
}

function openCrashPaste() {
  $('#cp-mask').hidden = false;
  $('#cp-result').hidden = true;
  $('#cp-note').textContent = '';
  setTimeout(() => $('#cp-text').focus(), 30);
}
function closeCrashPaste() { $('#cp-mask').hidden = true; }
async function submitCrashPaste() {
  const text = $('#cp-text').value.trim();
  if (!text) { toast('先贴点内容进来', true); return; }
  $('#cp-note').textContent = '分析中…';
  const r = await api('/api/crash/parse', { method: 'POST', body: JSON.stringify({ text }) });
  if (r.error) { $('#cp-note').textContent = r.error; toast(r.error, true); return; }
  $('#cp-title').textContent = r.title;
  $('#cp-cause').textContent = r.cause;
  const mods = r.mods || [];
  $('#cp-mods-wrap').hidden = !mods.length;
  $('#cp-mods').textContent = mods.join('、');
  $('#cp-result').hidden = false;
  $('#cp-note').textContent = `${r.signature} · ${(r.size / 1024).toFixed(1)} KB`;
  fx.play('tap');
}

/* ---------------- 版本级设置 ---------------- */
function fillVersionSettings() {
  renderJavaFit().catch(() => {});
  const id = state.selected;
  $('#vs-name').textContent = id || '—';
  const sel = $('#vs-java');
  if (sel) {
    sel.innerHTML = '<option value="">跟随全局（自动选择）</option>' + (state.javas || [])
      .map((j) => `<option value="${escapeAttr(j.path)}">Java ${j.major} · ${escapeHtml(j.source || '')}</option>`)
      .join('');
    const ov = (state.config?.versionOverrides || {})[id] || {};
    $('#vs-memory').value = ov.memory || '';
    $('#vs-width').value = ov.width || '';
    $('#vs-height').value = ov.height || '';
    $('#vs-jvm').value = ov.jvmArgs || '';
    $('#vs-game').value = ov.gameArgs || '';
    sel.value = ov.javaPath || '';
  }
}

async function saveVersionConfig(clear = false) {
  if (!state.selected) { toast('先在启动页选一个版本', true); return; }
  const patch = clear ? {
    memory: '', javaPath: '', width: '', height: '', jvmArgs: '', gameArgs: '',
    windowTitle: '', env: '', preLaunch: '',
  } : {
    memory: Number($('#vs-memory').value) || 0,
    javaPath: $('#vs-java').value || '',
    width: Number($('#vs-width').value) || 0,
    height: Number($('#vs-height').value) || 0,
    jvmArgs: $('#vs-jvm').value.trim(),
    gameArgs: $('#vs-game').value.trim(),
    windowTitle: $('#vs-title').value.trim(),
    env: $('#vs-env').value.trim(),
    preLaunch: $('#vs-pre').value.trim(),
  };
  const r = await api('/api/version-config', {
    method: 'POST',
    body: JSON.stringify({ id: state.selected, patch }),
  });
  if (r.ok) {
    await refresh();
    fillVersionSettings();
    toast(clear ? '已清除该版本的覆盖设置' : '已保存该版本的独立设置');
  } else {
    toast(r.error || '保存失败', true);
  }
}

/* ---------------- 账号 ---------------- */
function renderAccount() {
  const acc = state.config?.account ?? { name: 'Steve', type: 'offline' };
  const isMs = acc.type === 'microsoft';
  $('#acc-name').textContent = acc.name || 'Steve';
  $('#acc-type').textContent = isMs ? '正版' : '离线';
  $('#acc-chip').classList.toggle('ms', isMs);

  // 正版账号显示真实皮肤头像；离线用 Steve 头像
  const head = $('#acc-head');
  if (head) {
    const uuid = isMs && acc.uuid ? acc.uuid.replace(/-/g, '') : '';
    if (uuid) {
      head.innerHTML = `<img src="https://mc-heads.net/avatar/${encodeURIComponent(uuid)}/48" alt="" onerror="this.replaceWith('👤')" />`;
    } else {
      head.textContent = '👤';
    }
  }

  $('#auth-cur-name').textContent = acc.name || 'Steve';
  $('#auth-cur-type').textContent = isMs
    ? `微软账号${acc.uuid ? ` · ${acc.uuid.slice(0, 8)}…` : ''}`
    : '离线登录（皮肤仅本地可见）';
  if (!isMs) $('#off-name').value = acc.name || 'Steve';

  // 主页右侧账号卡
  const sName = $('#side-acc-name');
  if (sName) {
    sName.textContent = acc.name || 'Steve';
    $('#side-acc-type').textContent = isMs ? '微软正版账号' : '离线登录';
    const sHead = $('#side-acc-head');
    const uuid = isMs && acc.uuid ? acc.uuid.replace(/-/g, '') : '';
    if (sHead) {
      sHead.innerHTML = uuid
        ? `<img src="https://mc-heads.net/avatar/${encodeURIComponent(uuid)}/64" alt="" onerror="this.replaceWith('👤')" />`
        : '👤';
    }
  }
}

function openAuth(show = true) {
  $('#auth-mask').hidden = !show;
  if (show) {
    state.authTab = state.authTab || 'ms';
    showAuthTab(state.authTab);
    // 每次都把上一次的登录码清掉，避免误以为还能用
    $('#ms-code').hidden = true;
    $('#ms-status').hidden = true;
    $('#auth-hint').textContent = '';
  }
}

function showAuthTab(name) {
  state.authTab = name;
  $$('#auth-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.at === name));
  $('#ap-ms').hidden = name !== 'ms';
  $('#ap-offline').hidden = name !== 'offline';
}

function msStatus(text, percent) {
  const box = $('#ms-status');
  box.hidden = !text;
  if (!text) return;
  $('#ms-text').textContent = text;
  if (percent != null) $('#ms-bar').style.width = `${percent}%`;
}

async function startMsLogin() {
  const btn = $('#btn-ms-start');
  btn.disabled = true;
  btn.textContent = '请求登录码…';
  try {
    const r = await api('/api/auth/ms/start', { method: 'POST', body: '{}' });
    if (r.ok === false || r.error) throw new Error(r.error || '获取设备码失败');
    $('#ms-user-code').textContent = r.userCode;
    $('#ms-url').textContent = String(r.url || 'https://microsoft.com/link').replace(/^https?:\/\//, '');
    $('#ms-url').href = r.url || 'https://microsoft.com/link';
    $('#ms-code').hidden = false;
    btn.textContent = '重新获取';
    btn.disabled = false;
    msStatus('等待你在网页里完成授权…', 12);
    watchMsLogin(r.deviceCode, r.interval || 5);
  } catch (e) {
    btn.textContent = '获取登录码';
    btn.disabled = false;
    msStatus('');
    toast(e.message, true);
  }
}

function watchMsLogin(deviceCode, interval) {
  if (state.authES) state.authES.close();
  const es = new EventSource(`/api/auth/ms/finish?device=${encodeURIComponent(deviceCode)}&interval=${interval}`);
  state.authES = es;
  es.addEventListener('step', (ev) => {
    const d = JSON.parse(ev.data);
    const pct = { device: 18, xbl: 38, xsts: 52, mc: 72, profile: 88, saving: 96 }[d.stage] ?? 50;
    msStatus(d.text || '登录中…', pct);
  });
  es.addEventListener('done', async (ev) => {
    es.close();
    state.authES = null;
    const d = JSON.parse(ev.data);
    msStatus('登录成功', 100);
    $('#auth-hint').textContent = `已登录 ${d.account?.name ?? ''}`;
    toast(`已登录：${d.account?.name ?? '微软账号'}`);
    await refresh();
    setTimeout(() => openAuth(false), 900);
  });
  es.addEventListener('failed', (ev) => {
    es.close();
    state.authES = null;
    const d = JSON.parse(ev.data);
    msStatus('');
    toast(d.error || '登录失败', true);
    $('#btn-ms-start').textContent = '重新获取';
  });
}

async function saveOfflineName() {
  const name = ($('#off-name').value || '').trim();
  const r = await api('/api/auth/offline', { method: 'POST', body: JSON.stringify({ name }) });
  if (!r.ok) { toast(r.error || '保存失败', true); return; }
  toast(`离线昵称已设为 ${name}`);
  await refresh();
  openAuth(false);
}

async function logoutAccount() {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  if (state.authES) { state.authES.close(); state.authES = null; }
  await refresh();
  toast('已退出登录');
}

/* ---------------- 启动 ---------------- */
/* ---------------- 存档与备份 ---------------- */
async function loadWorlds() {
  const id = state.selected;
  $('#worlds-version').textContent = id ? `版本：${id}` : '未选择版本';
  const wl = $('#worlds-list');
  const bl = $('#backups-list');
  if (!id) {
    wl.innerHTML = '<div class="empty">先在「启动」页选一个版本</div>';
    bl.innerHTML = '';
    $('#backups-count').textContent = '';
    return;
  }
  wl.innerHTML = '<div class="empty">读取中…</div>';
  try {
    const d = await api(`/api/worlds?version=${encodeURIComponent(id)}`);
    state.worldsData = d;
    renderWorlds(d);
  } catch (e) {
    wl.innerHTML = `<div class="empty">读取失败：${escapeHtml(e.message)}</div>`;
  }
  loadSync(id);
}

/* ---------------- 云同步 ---------------- */
async function loadSync(id = state.selected) {
  const box = $('#sync-list');
  if (!id) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="empty">读取中…</div>';
  try {
    const d = await api(`/api/sync?version=${encodeURIComponent(id)}`);
    $('#sync-dir').value = d.syncDir || '';
    $('#sync-dir').placeholder = '未设置（可选 OneDrive / 坚果云 / 局域网共享 / U 盘）';
    const files = d.remote ?? [];
    if (!d.syncDir) {
      box.innerHTML = '<div class="empty">还没设置同步目录。点「选择目录」，指向 OneDrive / 坚果云 / 共享盘里的任意空文件夹即可。</div>';
      return;
    }
    if (!files.length) {
      box.innerHTML = '<div class="empty">同步目录里还没有备份，点「推送全部」上传当前版本的世界。</div>';
      return;
    }
    box.innerHTML = files.map((f) => `
      <div class="row-item wd-row">
        <div class="wd-main">
          <div class="wd-name">${escapeHtml(f.world)}</div>
          <div class="wd-sub">${escapeHtml(f.file)} · ${fmtSize(f.size)} · ${fmtDate(new Date(f.mtime).toISOString())}</div>
        </div>
        <div class="wd-acts">
          <button class="mini-btn" data-sact="pull" data-file="${escapeAttr(f.file)}" data-world="${escapeAttr(f.world)}">拉取</button>
        </div>
      </div>`).join('');

    $$('#sync-list [data-sact="pull"]').forEach((b) => b.addEventListener('click', async () => {
      const world = b.dataset.world;
      if (!confirm(`用云端备份覆盖本地世界「${world}」？\n覆盖前会自动在本地备份一次。`)) return;
      b.disabled = true;
      b.textContent = '拉取中…';
      const r = await api('/api/sync/pull', {
        method: 'POST',
        body: JSON.stringify({ version: state.selected, world, file: b.dataset.file }),
      });
      b.disabled = false;
      b.textContent = '拉取';
      if (r?.ok) {
        toast(`已从云端恢复「${world}」`);
        loadWorlds();
      } else {
        toast(r?.error || '拉取失败', true);
      }
    }));
  } catch (e) {
    box.innerHTML = `<div class="empty">读取失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderWorlds(d) {
  const wl = $('#worlds-list');
  const bl = $('#backups-list');
  const rawWorlds = d.worlds ?? [];
  const backups = d.backups ?? [];
  const by = state.worldsSort ?? 'mtime';
  const worlds = [...rawWorlds].sort((a, b) => {
    if (by === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (by === 'size') return b.size - a.size;
    return b.mtime - a.mtime;
  });
  $('#backups-count').textContent = backups.length ? `共 ${backups.length} 个` : '';

  if (!worlds.length) {
    wl.innerHTML = `<div class="empty">这个版本还没有存档${d.dir ? `<br><span style="font-size:11px;opacity:.6">${escapeHtml(d.dir)}</span>` : ''}</div>`;
  } else {
    wl.innerHTML = worlds.map((w) => `
      <div class="row-item wd-row" data-world="${escapeAttr(w.name)}">
        <div class="wd-main">
          <div class="wd-name">${escapeHtml(w.name)}</div>
          <div class="wd-sub">${fmtSize(w.size)} · 最后修改 ${relTime(w.mtime)} · ${w.backupCount} 个备份</div>
        </div>
        <div class="wd-acts">
          <button class="mini-btn" data-wact="backup" data-world="${escapeAttr(w.name)}">备份</button>
          <button class="mini-btn" data-wact="rename" data-world="${escapeAttr(w.name)}">重命名</button>
          <button class="mini-btn" data-wact="duplicate" data-world="${escapeAttr(w.name)}">复制</button>
          <button class="mini-btn" data-wact="open" data-world="${escapeAttr(w.name)}">打开</button>
        </div>
      </div>`).join('');
  }

  if (!backups.length) {
    bl.innerHTML = '<div class="empty">还没有备份</div>';
  } else {
    bl.innerHTML = backups.map((b) => `
      <div class="row-item wd-row">
        <div class="wd-main">
          <div class="wd-name">${escapeHtml(b.world)}</div>
          <div class="wd-sub">${escapeHtml(b.file)} · ${fmtSize(b.size)} · ${fmtDate(new Date(b.mtime).toISOString())}</div>
        </div>
        <div class="wd-acts">
          <button class="mini-btn" data-bact="restore" data-file="${escapeAttr(b.file)}">恢复</button>
          <button class="mini-btn" data-bact="delete" data-file="${escapeAttr(b.file)}">删除</button>
        </div>
      </div>`).join('');
  }

  $$('#worlds-list [data-wact]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const world = b.dataset.world;
    const act = b.dataset.wact;
    if (act === 'open') {
      await api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: pathJoin(d.dir, world) }) });
      return;
    }
    if (act === 'rename') {
      const name = prompt(`把世界「${world}」改名为：`, world);
      if (!name || name === world) return;
      const r = await api('/api/world/rename', { method: 'POST', body: JSON.stringify({ version: state.selected, world, newName: name }) });
      if (!r.ok) { toast(r.error || '重命名失败', true); return; }
      toast(`已改名为 ${r.to}`);
      await loadWorlds();
      return;
    }
    if (act === 'duplicate') {
      b.disabled = true;
      b.textContent = '复制中…';
      const r = await api('/api/world/duplicate', { method: 'POST', body: JSON.stringify({ version: state.selected, world }) });
      if (!r.ok) { toast(r.error || '复制失败', true); b.disabled = false; b.textContent = '复制'; return; }
      toast(`已复制为 ${r.to}`);
      await loadWorlds();
      return;
    }
    b.disabled = true;
    b.textContent = '打包中…';
    try {
      await api('/api/backup', { method: 'POST', body: JSON.stringify({ version: state.selected, world, keep: 10 }) });
      toast(`${world} 已备份`);
      await loadWorlds();
    } catch (err) {
      toast(err.message || '备份失败', true);
      b.disabled = false;
      b.textContent = '备份';
    }
  }));

  $$('#backups-list [data-bact]').forEach((b) => b.addEventListener('click', async () => {
    const file = b.dataset.file;
    if (b.dataset.bact === 'delete') {
      if (!confirm(`删除备份 ${file}？`)) return;
      await api('/api/backup/delete', { method: 'POST', body: JSON.stringify({ version: state.selected, file }) });
      toast('已删除');
      await loadWorlds();
      return;
    }
    if (!confirm(`用 ${file} 覆盖当前存档？\n覆盖前会自动再备份一次当前存档。`)) return;
    b.disabled = true;
    try {
      const r = await api('/api/restore', { method: 'POST', body: JSON.stringify({ version: state.selected, file }) });
      toast(`已恢复 ${r.world}${r.safetyBackup ? '（覆盖前的版本也存了一份）' : ''}`);
      await loadWorlds();
    } catch (err) {
      toast(err.message || '恢复失败', true);
      b.disabled = false;
    }
  }));
}

function pathJoin(a, b) {
  if (!a) return b;
  return a.replace(/[\\/]+$/, '') + '\\' + b;
}

/* ---------------- 服务器列表 ---------------- */
const MOTD_DEFAULT = '#e8eef5';

function motdHtml(runs, fallback) {
  if (!runs || !runs.length) return escapeHtml(fallback || '');
  return runs.map((r) => {
    const color = r.color || MOTD_DEFAULT;
    const style = `color:${escapeAttr(color)}${r.bold ? ';font-weight:600' : ''}`;
    return `<span style="${style}">${escapeHtml(r.text)}</span>`;
  }).join('');
}

/* ---------------- 皮肤 ---------------- */
let pendingSkin = null;
let skinTexSrc = '';
const skinView = { yaw: 0.55, pitch: 0.16, zoom: 1, img: null };

async function loadCape(url) {
  if (!url) return null;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((r) => { img.onload = r; img.onerror = r; img.src = url; });
  return img.naturalWidth ? img : null;
}

async function renderSkin3d(src, capeUrl) {
  const cv = document.getElementById('skin-canvas');
  if (!cv || !window.TPCLSkin3D) return;
  if (!src) { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); return; }
  const cape = await loadCape(capeUrl);
  skinView.cape = cape || null;
  if (skinView.img && skinTexSrc === src) { window.TPCLSkin3D.render(cv, skinView.img, skinView); return; }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { skinView.img = img; skinTexSrc = src; window.TPCLSkin3D.render(cv, img, skinView); };
  img.onerror = () => { /* 取不到就空着 */ };
  img.src = src;
}

skinView.cape = null;
window.__renderSkin3d = renderSkin3d;

(function bindSkinDrag() {
  const cv = () => document.getElementById('skin-canvas');
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const c = cv();
    if (!c || e.target !== c) return;
    drag = { x: e.clientX, y: e.clientY, yaw: skinView.yaw, pitch: skinView.pitch };
    c.setPointerCapture?.(e.pointerId);
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    skinView.yaw = drag.yaw + (e.clientX - drag.x) * 0.012;
    skinView.pitch = Math.max(-0.7, Math.min(0.9, drag.pitch + (e.clientY - drag.y) * 0.008));
    const c = cv();
    if (c && skinView.img) window.TPCLSkin3D.render(c, skinView.img, skinView);
  });
  document.addEventListener('pointerup', () => { drag = null; });
  document.addEventListener('pointercancel', () => { drag = null; });
})();

async function loadSkins() {
  const d = await api('/api/skin/mine');
  if (!d || d.error) return;
  const acc = d.account || {};
  $('#skin-account').textContent = acc.name || 'Steve';
  $('#skin-type').textContent =
    acc.type === 'microsoft' ? '微软正版账号 · 可上传皮肤' : '离线账号 · 只能预览';
  if (d.urls?.body && acc.uuid) {
    $('#skin-body').src = d.urls.body;
    $('#skin-body').style.display = '';
    const tex = d.texture || (d.urls?.texture || '');
    if (tex) renderSkin3d('/api/skin/texture?url=' + encodeURIComponent(tex));
    $('#skin-ph')?.remove();
  } else {
    $('#skin-body').removeAttribute('src');
    $('#skin-body').style.display = 'none';
    const fig = document.querySelector('.skin-figure');
    if (fig && !fig.querySelector('#skin-ph')) {
      fig.insertAdjacentHTML('beforeend', '<div id="skin-ph" class="skin-ph">离线账号<br>没有皮肤</div>');
    }
  }
  if (d.urls?.head) $('#skin-head').src = d.urls.head;

  const list = $('#skin-list');
  const owned = (d.skins || []).filter((s) => s.state === 'ACTIVE' || s.url);
  if (!owned.length) {
    list.innerHTML = `<div class="empty">${d.error ? escapeHtml(d.error) : '这个账号名下没有查到皮肤（离线账号本来就没有）'}</div>`;
    return;
  }
  list.innerHTML = owned
    .map(
      (s) => `<div class="skin-row">
        <img class="skin-thumb" src="https://textures.minecraft.net/texture/${String(s.id || '').replace(/-/g, '')}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="skin-meta">
          <div class="row-title">${escapeHtml(s.state === 'ACTIVE' ? '当前使用中' : '已保存')}</div>
          <div class="row-sub">${escapeHtml(s.variant || 'classic')}${
        s.url ? ` · <a href="${escapeAttr(s.url)}" target="_blank" rel="noreferrer">texture</a>` : ''
      }</div>
        </div>
      </div>`
    )
    .join('');
}

async function pickSkinFile() {
  const r = await api('/api/pick-file', {
    method: 'POST',
    body: JSON.stringify({
      title: '选择皮肤 PNG',
      filter: 'PNG 图片|*.png',
    }),
  });
  if (!r || r.canceled || !r.path) return;
  const info = await api(`/api/skin/inspect?path=${encodeURIComponent(r.path)}`);
  if (!info?.ok) {
    toast(info?.error || '这个文件不能当皮肤用', true);
    return;
  }
  pendingSkin = r.path;
  $('#skin-file').textContent = `${r.path.split(/[\\/]/).pop()} · ${info.width}×${info.height} · ${fmtSize(info.size)}`;
  $('#btn-skin-upload').disabled = false;
  // 本地预览
  $('#skin-body').src = `file:///${r.path.replace(/\\/g, '/')}`;
  renderSkin3d('/api/skin/texture?file=' + encodeURIComponent(r.path));
  toast('皮肤文件可用，点「上传到正版账号」');
}

async function uploadSkinNow() {
  if (!pendingSkin) { toast('先选一个皮肤文件', true); return; }
  const btn = $('#btn-skin-upload');
  btn.disabled = true;
  btn.textContent = '上传中…';
  const r = await api('/api/skin/upload', {
    method: 'POST',
    body: JSON.stringify({ path: pendingSkin, variant: 'classic' }),
  });
  btn.textContent = '上传到正版账号';
  btn.disabled = false;
  if (r?.ok) {
    toast('皮肤已上传，进游戏就能看到');
    setTimeout(loadSkins, 1200);
  } else {
    toast(r?.error || '上传失败', true);
  }
}

async function downloadMySkinNow() {
  const r = await api('/api/skin/download', { method: 'POST', body: '{}' });
  if (!r.ok) { toast(r.error || '下载失败', true); return; }
  toast(`皮肤已存到本地（${Math.round(r.bytes / 1024)} KB，${r.variant}）`);
  const dir = String(r.file).replace(/[\\/][^\\/]+$/, '');
  const name = String(r.file).replace(/^.*[\\/]/, '');
  await api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path: dir, file: name }) }).catch(() => {});
}

async function loadSkinGallery() {
  const box = $('#skin-gallery');
  box.innerHTML = '<p class="hint-line">读取皮肤库…</p>';
  const d = await api('/api/skin/gallery?size=24');
  if (!d?.ok) { box.innerHTML = `<p class="hint-line err">${escapeHtml(d?.error || '读取失败')}</p>`; return; }
  const items = d.items || [];
  if (!items.length) { box.innerHTML = '<p class="hint-line">皮肤库现在是空的。</p>'; return; }
  box.innerHTML = items.map((it, i) => `
    <button class="skin-cell" data-i="${i}" title="${escapeAttr(it.name || it.id)}">
      <img src="${escapeAttr(it.thumb)}" alt="" loading="lazy" onerror="this.style.opacity=.25" />
      <em>${escapeHtml(it.name || '未命名')}</em>
    </button>`).join('');
  state.skinGallery = items;
  box.querySelectorAll('.skin-cell').forEach((b) => b.addEventListener('click', () => renderGalleryHead(Number(b.dataset.i))));
}

async function renderGalleryHead(i) {
  const it = (state.skinGallery || [])[i];
  if (!it) return;
  const r = await api('/api/skin/head', { method: 'POST', body: JSON.stringify({ texture: it.texture }) });
  if (!r?.ok) { toast(r?.error || '渲染失败', true); return; }
  toast(`头像已保存：${r.file}（${Math.round(r.bytes / 1024)} KB）`);
}

async function resetSkinNow() {  const r = await api('/api/skin/reset', { method: 'POST', body: '{}' });
  if (r?.ok) { toast('已还原默认皮肤'); setTimeout(loadSkins, 900); }
  else toast(r?.error || '还原失败', true);
}

async function lookupSkin() {
  const q = $('#skin-query').value.trim();
  if (!q) return;
  const box = $('#skin-look');
  box.innerHTML = '<p class="hint-line">查询中…</p>';
  const d = await api(`/api/skin/lookup?q=${encodeURIComponent(q)}`);
  if (!d?.ok) {
    box.innerHTML = `<p class="hint-line err">${escapeHtml(d?.error || '查不到')}</p>`;
    return;
  }
  if (d.skinUrl || d.capeUrl) {
    renderSkin3d('/api/skin/texture?url=' + encodeURIComponent(d.skinUrl || ''), d.capeUrl ? '/api/skin/cape?url=' + encodeURIComponent(d.capeUrl) : '');
  }
  box.innerHTML = `<div class="skin-look-card">
    <img class="skin-look-body" src="${escapeAttr(d.urls.body)}" alt="" onerror="this.style.display='none'" />
    <div>
      <div class="row-title">${escapeHtml(d.name)}</div>
      <div class="row-sub mono">${escapeHtml(d.uuid)}</div>
      <div class="skin-look-acts">
        <a class="mini-btn" href="${escapeAttr(d.urls.skin)}" target="_blank" rel="noreferrer">下载皮肤</a>
        ${d.capeUrl ? `<a class="mini-btn" href="/api/skin/cape?url=${encodeURIComponent(d.capeUrl)}" download="cape.png">下载披风</a>` : ''}
      </div>
      ${d.capeUrl ? '<div class="row-sub">这个玩家有披风</div>' : ''}
    </div>
  </div>`;
}

/* ---------------- 局域网发现 ---------------- */
let lanTimer = null;

async function loadLan() {
  const box = $('#lan-list');
  if (!box) return;
  try {
    const d = await api('/api/lan');
    const items = d.items ?? [];
    if (!d.watching) {
      box.innerHTML = `<div class="empty">监听没有起来${d.error ? `：${escapeHtml(d.error)}` : ''}</div>`;
      return;
    }
    if (!items.length) {
      box.innerHTML = '<div class="empty">没发现局域网房间。别人在游戏里「对局域网开放」后，这里几秒内就会出现。</div>';
      return;
    }
    box.innerHTML = items.map((it) => `
      <div class="row-item lr-item">
        <div class="row-main">
          <div class="row-title">${escapeHtml(it.motd || '局域网世界')}</div>
          <div class="row-sub">${escapeHtml(it.host)}:${it.port} · ${it.ago} 秒前还在广播</div>
        </div>
        <div class="row-acts">
          <button class="mini-btn accent" data-lan-join="${escapeAttr(it.host)}:${it.port}">进服</button>
          <button class="mini-btn" data-lan-save="${escapeAttr(it.host)}:${it.port}" data-lan-motd="${escapeAttr(it.motd || '')}">保存到列表</button>
        </div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty">读取失败：${escapeHtml(e.message)}</div>`;
  }
}

function startLanPoll() {
  stopLanPoll();
  lanTimer = setInterval(loadLan, 5000);
}
function stopLanPoll() {
  if (lanTimer) { clearInterval(lanTimer); lanTimer = null; }
}
function lanJoin(addr) {
  const [host, port] = String(addr).split(':');
  quickJoinByAddr(host, Number(port) || 25565);
}
async function lanSave(addr, motd) {
  const [host, port] = String(addr).split(':');
  const list = [...(state.config.servers ?? [])];
  if (list.some((s) => s.host === host && (s.port || 25565) === (Number(port) || 25565))) {
    toast('这个地址已经在列表里了');
    return;
  }
  list.push({ id: `s${Date.now()}`, name: motd || host, host, port: Number(port) || 25565 });
  const r = await api('/api/servers/save', { method: 'POST', body: JSON.stringify({ servers: list }) });
  if (r.ok) { state.config = r.config ?? state.config; toast('已保存到服务器列表'); loadServers(); }
  else toast(r.error || '保存失败', true);
}

async function quickJoinByAddr(host, port) {
  try {
    const r = await api('/api/launch', {
      method: 'POST',
      body: JSON.stringify({ versionId: state.selected, quickJoin: { host, port } }),
    });
    if (r.ok) { toast(`正在启动并连接 ${host}:${port}`); showView('home'); }
    else toast(r.error || '启动失败', true);
  } catch (e) {
    toast(e.message, true);
  }
}

async function loadServers() {
  const box = $('#servers-list');
  const cfg = state.config || {};
  const list = cfg.servers ?? [];
  loadLan();
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有服务器。上面填个地址，回车即可添加。</div>';
    return;
  }
  box.innerHTML = '<div class="empty">正在 ping ' + list.length + ' 个服务器…</div>';
  try {
    const d = await api('/api/servers');
    renderServers(d.servers ?? []);
  } catch (e) {
    box.innerHTML = `<div class="empty">ping 失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderServers(servers) {
  const box = $('#servers-list');
  if (!servers.length) {
    box.innerHTML = '<div class="empty">还没有服务器。上面填个地址（如 mc.hypixel.net 或 1.2.3.4:25565），回车即可添加。</div>';
    return;
  }
  box.innerHTML = servers.map((s) => {
    const online = s.online;
    const icon = s.favicon
      ? `<img class="sv-icon" src="${escapeAttr(s.favicon)}" alt="" />`
      : '<div class="sv-icon blank">🖥</div>';
    const right = online
      ? `<div><span class="sv-dot on"></span>${s.players?.online ?? 0} / ${s.players?.max ?? 0}</div>
         <div>${s.latency} ms${s.via === 'srv' ? ' · SRV' : ''}</div>
         <div style="opacity:.65">${escapeHtml(s.version?.name ?? '')}</div>`
      : `<div><span class="sv-dot off"></span>离线</div>
         <div class="sv-err">${escapeHtml(s.error ?? '无法连接')}</div>`;
    return `
      <div class="row-item sv-row" data-sid="${escapeAttr(s.id)}" title="双击直接用当前版本进服">
        ${icon}
        <div class="sv-main">
          <div class="sv-name">${escapeHtml(s.name || s.host)}<span class="tag">${escapeHtml(s.host)}${s.port ? ':' + s.port : ''}</span></div>
          <div class="sv-motd">${online ? motdHtml(s.motdRuns, s.motd) : `<span class="sv-err">${escapeHtml(s.error ?? '连接失败')}</span>`}</div>
        </div>
        <div class="sv-meta">${right}</div>
        <button class="mini-btn" data-sjoin="${escapeAttr(s.id)}">进服</button>
        <button class="tiny-btn" data-sedit="${escapeAttr(s.id)}" title="编辑">✎</button>
        <button class="tiny-btn" data-sdel="${escapeAttr(s.id)}" title="移除">✕</button>
      </div>`;
  }).join('');

  $$('#servers-list [data-sjoin]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    quickJoin(b.dataset.sjoin);
  }));
  $$('#servers-list .sv-row').forEach((row) => row.addEventListener('dblclick', () => quickJoin(row.dataset.sid)));
  $$('#servers-list [data-sedit]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    editServer(b.dataset.sedit);
  }));
  $$('#servers-list [data-sdel]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const rest = (state.config.servers ?? []).filter((x) => x.id !== b.dataset.sdel);
    await api('/api/servers/save', { method: 'POST', body: JSON.stringify({ servers: rest }) });
    await refresh();
    await loadServers();
  }));
}

/* 双击/点「进服」：用当前版本直接连进服务器 */
async function quickJoin(sid) {
  const s = (state.config.servers ?? []).find((x) => x.id === sid);
  if (!s) return;
  if (!state.selected) { toast('先在「启动」页选一个版本', true); return; }
  const runningIds = (state.games || []).map((g) => g.id);
  if (runningIds.includes(state.selected)) { toast('这个版本已经在运行了', true); return; }
  const target = `${s.host}${s.port && s.port !== 25565 ? ':' + s.port : ''}`;
  toast(`正在启动 ${state.selected} → ${target}`);
  $('#log').classList.remove('collapsed');
  const r = await api('/api/launch', {
    method: 'POST',
    body: JSON.stringify({ versionId: state.selected, quickJoin: { host: s.host, port: s.port || 25565 } }),
  });
  if (r.ok) {
    appendLog({ type: 'system', text: `\n[TPCL] 已带参数进服：${r.joined}\n` });
    state.running = { id: state.selected, pid: r.pid };
    $('#btn-stop').hidden = false;
    showView('home');
    refresh();
  } else {
    toast(r.error || '启动失败', true);
  }
}

function exportServers() {
  const list = (state.config?.servers ?? []).map((s) => ({ name: s.name, host: s.host, port: s.port ?? null }));
  if (!list.length) { toast('还没有服务器可以导出', true); return; }
  const blob = new Blob([JSON.stringify({ tpcl: 1, servers: list }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tpcl-servers-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast(`已导出 ${list.length} 个服务器`);
}

async function importServers() {
  const picked = await api('/api/pick-file', {
    method: 'POST',
    body: JSON.stringify({ title: '选择服务器列表', filter: 'JSON (*.json)|*.json|所有文件 (*.*)|*.*' }),
  });
  if (!picked?.path) return;
  const r = await api('/api/servers/import', { method: 'POST', body: JSON.stringify({ path: picked.path }) });
  if (!r.ok) { toast(r.error || '导入失败', true); return; }
  toast(`导入完成：新增 ${r.added} 个，跳过 ${r.skipped} 个重复，共 ${r.total} 个`);
  await refresh();
  loadServers();
}

async function addServer() {
  const raw = ($('#sv-host').value || '').trim();
  if (!raw) { toast('先填服务器地址', true); return; }
  const name = ($('#sv-name').value || '').trim();
  let host = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  let port = null;
  const m = host.match(/^(.*):(\d+)$/);
  if (m) { host = m[1]; port = Number(m[2]); }
  const list = (state.config.servers ?? []).slice();
  if (state.svEdit) {
    const i = list.findIndex((x) => x.id === state.svEdit);
    if (i >= 0) list[i] = { ...list[i], name: name || host, host, port };
    state.svEdit = null;
    $('#btn-sv-add').textContent = '添加并 ping';
    $('#btn-sv-cancel')?.remove();
  } else {
    list.push({ id: 's' + Date.now(), name: name || host, host, port });
  }
  await api('/api/servers/save', { method: 'POST', body: JSON.stringify({ servers: list }) });
  $('#sv-host').value = '';
  $('#sv-name').value = '';
  await refresh();
  await loadServers();
  toast(`已保存 ${name || host}`);
}

/* 编辑：把原值填回上方输入框，按钮切成「保存修改」 */
function editServer(sid) {
  const s = (state.config.servers ?? []).find((x) => x.id === sid);
  if (!s) return;
  state.svEdit = sid;
  $('#sv-host').value = s.port ? `${s.host}:${s.port}` : s.host;
  $('#sv-name').value = s.name && s.name !== s.host ? s.name : '';
  const btn = $('#btn-sv-add');
  btn.textContent = '保存修改';
  if (!$('#btn-sv-cancel')) {
    const c = document.createElement('button');
    c.id = 'btn-sv-cancel';
    c.className = 'mini-btn';
    c.textContent = '取消编辑';
    c.addEventListener('click', () => {
      state.svEdit = null;
      $('#sv-host').value = '';
      $('#sv-name').value = '';
      btn.textContent = '添加并 ping';
      c.remove();
    });
    btn.parentElement.appendChild(c);
  }
  $('#sv-host').focus();
  $('#sv-host').select();
}

async function boot() {
  const savedTheme = localStorage.getItem('tpcl-theme');
  document.documentElement.dataset.theme = savedTheme === 'dark' ? 'dark' : 'light';
  initFx();
  bind();
  connectLogs();
  await refresh();
  setLang(state.config?.locale === 'en' ? 'en' : 'zh');
  // 语言会影响卡片标签（继承/最近游玩/崩溃）等运行时文案，切完要重画一遍
  renderVersions();
  renderHero();
  applyI18n();
  renderRemote();
  // 支持 #download / #content / #settings 直链，方便分享与截图
  const h = location.hash.replace('#', '');
  if (['download', 'content', 'worlds', 'servers', 'skins', 'settings', 'more'].includes(h)) showView(h);
  // 深链：#detail:<projectId> 直接打开市场详情（截图与分享都用得上）
  if (h.startsWith('detail:')) {
    showView('download');
    showDlTab('market');
    const pid = h.slice(7);
    if (pid) setTimeout(() => openMarketDetail(pid, 'mod'), 600);
  }
  // 运行中改 hash 也能切页（截图/收藏/外部调用都方便）
  window.addEventListener('hashchange', () => {
    const k = location.hash.replace('#', '');
    if (['home', 'download', 'content', 'worlds', 'servers', 'skins', 'settings', 'more'].includes(k)) showView(k);
  });
  if (h === 'auth') openAuth(true);
}

boot().catch((e) => {
  reportClientError(e);
  console.error(e);
  document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#fff">初始化失败：${escapeHtml(e.message)}</div>`;
});

// 资源包 / 光影：切换「游戏内启用」状态（写 options.txt）
document.addEventListener('click', async (e) => {
  const b = e.target && e.target.closest ? e.target.closest('.pack-act') : null;
  if (!b) return;
  e.stopPropagation();
  e.preventDefault();
  const on = b.dataset.act === 'on';
  b.disabled = true;
  const r = await api('/api/pack/toggle', {
    method: 'POST',
    body: JSON.stringify({ version: state.selected, kind: state.contentKind, file: b.dataset.name, on }),
  }).catch((err) => ({ ok: false, error: err.message }));
  b.disabled = false;
  if (!r.ok) { toast(r.error || '切换失败', true); return; }
  toast(on ? '已在游戏内启用（进游戏可见）' : '已在游戏内关闭');
  loadContent().catch(() => {});
});

/* ---------- Java 版本匹配提示 ---------- */
async function renderJavaFit() {
  const box = document.getElementById('java-fit-text');
  if (!box || !state.selected) return;
  const r = await api('/api/java/fit?version=' + encodeURIComponent(state.selected)).catch(() => null);
  if (!r || !r.ok) { box.textContent = '检查失败'; return; }
  const need = '需要 Java ' + r.required;
  const cur = r.current ? '当前 Java ' + r.current.major : '当前未选 Java';
  if (r.match) {
    box.innerHTML = '<span style="color:#1f8b4c">' + need + ' · ' + cur + ' ✓</span>';
    return;
  }
  box.innerHTML =
    '<span style="color:#c0392b">' + need + ' · ' + cur + ' ✗</span>' +
    (r.best
      ? ' <button class="mini-btn accent" id="btn-java-fit">改用 Java ' + r.best.major + '</button>'
      : ' <span class="dim">（没装 Java ' + r.required + '，去下面「自动下载」装一个）</span>');
  const btn = document.getElementById('btn-java-fit');
  if (btn && r.best) {
    btn.addEventListener('click', async () => {
      const saved = await api('/api/config', { method: 'POST', body: JSON.stringify({ javaPath: r.best.path }) }).catch(() => null);
      if (!saved || !saved.ok) { toast('切换失败', true); return; }
      toast('已切到 Java ' + r.best.major);
      await refresh();
      renderJavaFit();
    });
  }
}

function applyBgStyle(dim, blur) {
  const el = document.querySelector('.app-bg');
  if (!el) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  el.style.filter = blur ? `blur(${blur}px)` : '';
  el.style.setProperty('--bg-dim-color', dark
    ? `rgba(0, 0, 0, ${Math.max(0.25, dim)})`
    : `rgba(255, 255, 255, ${Math.min(0.85, dim + 0.15)})`);
}

function applyBg(bgPath) {
  const app = document.getElementById('app');
  let el = document.querySelector('.app-bg');
  if (!bgPath) {
    el?.remove();
    app?.classList.remove('has-bg');
    const nm = $('#bg-name'); if (nm) nm.textContent = '未设置（使用纯色背景）';
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.className = 'app-bg';
    document.body.prepend(el);
  }
  el.style.backgroundImage = `url("/api/theme/bg-image?v=${Date.now()}")`;
  app?.classList.add('has-bg');
  const nm = $('#bg-name');
  if (nm) nm.textContent = String(bgPath).split(/[\\/]/).pop();
  applyBgStyle(Number($('#bg-dim')?.value || 0.35), Number($('#bg-blur')?.value || 0));
}

/* ---------------- 主题色（顶层定义，确保 fillSettings 能用到） ---------------- */
function accRgb(hex) {
  const h = String(hex || '').replace('#', '');
  return h.length === 6 ? [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) : null;
}
function accMix(a, b, t) {
  const A = accRgb(a); const B = accRgb(b);
  if (!A || !B) return a;
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
function applyAccent(hex) {
  const root = document.documentElement;
  if (!hex || !accRgb(hex)) {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-2');
    root.style.removeProperty('--accent-soft');
    return;
  }
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-2', accMix(hex, '#000000', 0.18));
  root.style.setProperty('--accent-soft', accMix(hex, '#ffffff', 0.9));
  document.querySelectorAll('.accent-dot').forEach((d) => {
    d.classList.toggle('on', (d.dataset.accent || '').toLowerCase() === hex.toLowerCase());
  });
  const custom = document.getElementById('accent-custom');
  if (custom) custom.value = hex;
}
async function setAccent(hex) {
  applyAccent(hex);
  try { await api('/api/config', { method: 'POST', body: JSON.stringify({ accent: hex }) }); }
  catch (e) { console.warn('accent save failed:', e); }
}
window.__applyAccent = applyAccent;
window.__setAccent = setAccent;

document.querySelectorAll('.accent-dot').forEach((dot) => {
  dot.addEventListener('click', () => setAccent(dot.dataset.accent || ''));
});
const accCustomEl = document.getElementById('accent-custom');
if (accCustomEl) accCustomEl.addEventListener('input', () => setAccent(accCustomEl.value));
if (state.config) applyAccent(state.config.accent || '');

// Keep diagnostics independent of the rest of the UI, and never recursively report failures.
function reportClientError(error) {
  fetch('/api/reports/client', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: String(error?.message || error), stack: error?.stack || '', page: location.pathname }) })
    .then(r => r.json()).then(d => { if (d.report) showErrorReport(d.report); }).catch(() => {});
}
window.addEventListener('error', e => reportClientError(e.error || e.message));
window.addEventListener('unhandledrejection', e => reportClientError(e.reason));

function showErrorReport(id) {
  let box = $('#error-report');
  if (!box) { box = document.createElement('aside'); box.id = 'error-report'; box.setAttribute('role', 'status'); document.body.append(box); }
  box.replaceChildren();
  const label = document.createElement('span'); label.textContent = '错误报告已自动保存';
  const link = document.createElement('a'); link.textContent = '下载报告'; link.href = '/api/reports/' + encodeURIComponent(id); link.download = '';
  const close = document.createElement('button'); close.textContent = '关闭'; close.onclick = () => box.remove();
  box.append(label, link, close);
}
