// Unified project browser. DOM text nodes keep provider content out of HTML.
export function createCatalog({ api, enqueue, selected, context }) {
  let sequence = 0, hits = [], total = 0;
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
  async function search(append = false) {
    const seq = ++sequence, source = document.querySelector('#mk-src .active')?.dataset.mksrc || 'modrinth', kind = $('mk-type').value;
    const query = $('mk-query').value.trim();
    if (!append) { hits = []; showMessage('正在加载可下载目录…'); }
    try {
      const ctx = await scope(kind);
      if (seq !== sequence) return;
      const q = new URLSearchParams({ kind, type: kind, query, q: query, offset: String(append ? hits.length : 0), mc: ctx.mcVer || '', loader: kind === 'mod' ? ctx.loader || '' : '', sort: $('mk-sort').value, limit: '24' });
      const data = await api((source === 'cf' ? '/api/cf/search?' : '/api/market/search?') + q);
      if (seq !== sequence) return;
      if (data.error) throw new Error(data.error);
      hits = append ? [...hits, ...(data.hits || [])] : data.hits || []; total = data.total || 0;
      const box = $('mk-list'); box.replaceChildren();
      $('mk-scope').textContent = `${source === 'cf' ? 'CurseForge' : 'Modrinth'} · ${total.toLocaleString()} 个项目`;
      if (!hits.length) { showMessage('暂无匹配项目，请调整关键词或关闭“匹配当前游戏”。'); return; }
      for (const item of hits) {
        const row = node('article', '', 'catalog-card');
        const icon = node('div', '▦', 'catalog-icon');
        if (item.icon && /^https:\/\//.test(item.icon)) { const img = document.createElement('img'); img.src = item.icon; img.alt = ''; img.loading = 'eager'; img.onerror = () => { img.remove(); icon.textContent = '▦'; }; icon.replaceChildren(img); }
        const info = node('div', '', 'catalog-info'); info.append(node('h3', item.title), node('p', item.description || '暂无简介'), node('small', `${item.author || source} · ${Number(item.downloads || 0).toLocaleString()} 次下载`));
        row.append(icon, info, button('选择版本', () => versions(item, source, kind))); box.append(row);
      }
      if (hits.length < total) box.append(button(`加载更多 · 已显示 ${hits.length}`, () => search(true)));
    } catch (error) {
      if (seq !== sequence) return;
      showMessage(error.message);
      $('mk-list').append(button('重试', () => search()), button('切换到 Modrinth', () => { document.querySelector('[data-mksrc="modrinth"]').click(); }));
    }
  }
  async function configure() {
    const d = document.createElement('dialog'); d.className = 'catalog-dialog';
    d.append(node('h2', '下载源设置'), node('p', 'Modrinth 可直接使用。CurseForge 需要有效的官方 API Key；密钥仅保存在本机。'));
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
