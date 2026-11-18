// Unified project browser. DOM text nodes keep provider content out of HTML.
export function createCatalog({ api, enqueue, selected, context }) {
  const $ = id => document.getElementById(id);
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el; };
  const button = (text, fn) => { const el = node('button', text, 'mini-btn'); el.onclick = fn; return el; };
  const scope = async kind => kind === 'modpack' || !$('catalog-match').checked ? {} : await context();
  async function versions(item, source, kind) {
    const target = selected();
    if (kind !== 'modpack' && !target) { showMessage('请先在启动页选择要安装到的游戏版本。'); return; }
    const dialog = document.createElement('dialog'); dialog.className = 'catalog-dialog';
    dialog.append(node('h2', item.title), button('关闭', () => dialog.close()));
    if (kind === 'mod') dialog.append(node('p', '自动下载必需前置：按目标游戏版本和加载器匹配，包含前置的前置。可选前置不会自动安装；无法匹配时会提示并生成错误报告。'));
    const body = node('div', '正在获取可下载版本…'); dialog.append(body); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove()); dialog.showModal();
    let offset = 0;
    async function loadVersions(append = false) {
    try {
      const ctx = await scope(kind);
      const qs = new URLSearchParams({ id: item.id, offset: String(offset), mc: ctx.mcVer || '', loader: kind === 'mod' ? ctx.loader || '' : '' });
      const data = await api((source === 'cf' ? '/api/cf/files?' : '/api/market/versions?') + qs);
      if (data.error) throw new Error(data.error);
      if (!append) body.replaceChildren();
      const list = data.files || data.versions || [];
      if (!list.length) body.append(node('p', '没有匹配版本。可以关闭“匹配当前游戏”后查看其他版本，安装前请确认兼容性。'));
      for (const v of list) {
        const row = node('div', '', 'catalog-version');
        const info = node('div'); info.append(node('b', v.name || v.fileName), node('p', (v.gameVersions || []).slice(0, 5).join(' · ') + ' / ' + (v.loaders || []).join(' · ')));
        const install = button(kind === 'mod' ? '安装并补齐前置' : '加入队列', async () => {
          install.disabled = true;
          try {
            const task = await enqueue(source === 'cf' ? { type: 'cf', mod: String(item.id), file: String(v.id), target: kind === 'modpack' ? '' : target }
              : { type: 'market', project: item.id, version: v.id, resourceType: kind, target: kind === 'modpack' ? '' : target });
            if (task) dialog.close(); else install.disabled = false;
          } catch (e) { install.disabled = false; showMessage(e.message); }
        }); row.append(info, install); body.append(row);
      }
      offset += list.length;
      if (source === 'cf' && list.length === 30) {
        const more = button('加载更多版本', async () => { more.remove(); await loadVersions(true); }); body.append(more);
      }
    } catch (error) { if (!append) body.textContent = error.message; else body.append(node('p', error.message)); body.append(button('重试', () => loadVersions(append))); }
    }
    await loadVersions();
  }
  function showMessage(text) { $('mk-list').replaceChildren(node('div', text, 'empty')); }
  let current;

  async function loadPage(run, page) {
    const {kind, query, ctx, sort} = run;
    const params = new URLSearchParams({
      kind, type: kind, query, q: query, sort, limit: '24',
      offset: String(page.offset), mc: ctx.mcVer || '', loader: kind === 'mod' ? ctx.loader || '' : '',
    });
    const endpoint = page.source === 'cf' ? '/api/cf/search?' : '/api/market/search?';
    page.error = '';
    try {
      const data = await api(endpoint + params);
      if (data.error) throw new Error(data.error);
      const batch = data.hits || [];
      page.items.push(...batch);
      page.offset += batch.length;
      page.more = batch.length > 0 && page.offset < data.total && (page.source !== 'cf' || page.offset <= 9900);
    } catch (error) {
      page.error = error.message;
    }
    if (current === run) render(run);
  }

  async function search(append = false) {
    if (append && (!current || current.loading)) return;
    if (!append) {
      current = {
        kind: $('mk-type').value, query: $('mk-query').value.trim(), sort: $('mk-sort').value,
        pages: [], loading: false,
      };
      showMessage('正在加载可下载目录…');
      $('mk-scope').textContent = '';
    }
    const run = current;
    run.loading = true;
    try {
      if (!append) {
        const [ctx, status] = await Promise.all([scope(run.kind), api('/api/catalog/sources').catch(() => ({}))]);
        if (current !== run) return;
        run.ctx = ctx;
        const sources = status.curseforge?.configured ? ['modrinth', 'cf'] : ['modrinth'];
        run.pages = sources.map(source => ({source, offset: 0, more: true, items: [], error: ''}));
      }
      await Promise.all(run.pages.filter(page => page.more).map(page => loadPage(run, page)));
    } catch (error) {
      if (current === run) {
        showMessage(error.message);
        $('mk-list').append(button('重试', () => search()));
      }
    } finally {
      run.loading = false;
      if (current === run && run.pages.length) render(run);
    }
  }

  function projectCard(item, source, kind) {
    const row = node('article', '', 'catalog-card');
    const icon = node('div', '▦', 'catalog-icon');
    if (item.icon && /^https:\/\//.test(item.icon)) {
      const img = document.createElement('img');
      img.src = item.icon;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => { icon.textContent = '▦'; };
      icon.replaceChildren(img);
    }
    const info = node('div', '', 'catalog-info');
    const details = [item.author, Number(item.downloads || 0).toLocaleString() + ' 次下载'];
    info.append(node('h3', item.title), node('p', item.description || '暂无简介'), node('small', details.filter(Boolean).join(' · ')));
    row.append(icon, info, button('选择版本', () => versions(item, source, kind)));
    return row;
  }

  function render(run) {
    const box = $('mk-list');
    box.replaceChildren();
    const entries = [];
    const seen = new Set();
    const length = Math.max(0, ...run.pages.map(page => page.items.length));
    for (let i = 0; i < length; i++) {
      for (const {source, items} of run.pages) {
        const item = items[i];
        if (!item) continue;
        const key = source + ':' + item.id;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({source, item});
      }
    }
    if (run.sort === 'downloads') entries.sort((a, b) => b.item.downloads - a.item.downloads);
    $('mk-scope').textContent = '已显示 ' + entries.length + ' 个项目';
    const failures = run.pages.filter(page => page.error);
    if (!entries.length) {
      const empty = failures.length === run.pages.length ? '目录加载失败' : '暂无匹配项目';
      showMessage(run.loading ? '正在加载可下载目录…' : empty);
    }
    for (const {item, source} of entries) box.append(projectCard(item, source, run.kind));
    if (failures.length) box.append(node('p', failures.map(page => page.error).join(' · '), 'hint-line'));
    if (!run.loading && run.pages.some(page => page.more)) {
      box.append(button(failures.length ? '重试并继续加载' : '加载更多', () => search(true)));
    }
  }
  async function configure() {
    const d = document.createElement('dialog'); d.className = 'catalog-dialog';
    d.append(node('h2', '目录设置'), node('p', 'Modrinth 可直接使用。CurseForge 需要有效的官方 API Key；密钥仅保存在本机。'));
    const status = await api('/api/catalog/sources'); d.append(node('p', status.curseforge?.configured ? 'CurseForge：已配置' : 'CurseForge：尚未配置'));
    const input = document.createElement('input'); input.type = 'password'; input.placeholder = '输入 CurseForge API Key'; input.autocomplete = 'off'; input.setAttribute('aria-label', 'CurseForge API Key');
    const msg = node('p');
    d.append(input, msg, button('保存', async () => {
      if (!input.value.trim()) { msg.textContent = '请输入密钥'; return; }
      try {
        const r = await api('/api/catalog/sources', { method: 'POST', body: JSON.stringify({ key: input.value }) });
        if (r.ok) { input.value = ''; d.close(); search(); } else msg.textContent = r.error || '保存失败';
      } catch (error) { msg.textContent = error.message || '保存失败，请重试'; }
    }), button('关闭', () => d.close()));
    d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal();
  }
  return { search, configure };
}
