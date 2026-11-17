// 自更新检查：不依赖 GitHub API（无 token 也能用）
// 思路：GET /releases/latest 让它 302 到 /releases/tag/<tag>，从中拿版本号；
// 再抓那个页面 HTML，正则出 .exe 资产直链（不需要 API 配额）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.js';

const SECRETS = path.join(DATA_DIR, 'secrets.json');
const UA = 'TPCL/1.0.0 (personal minecraft launcher)';
const TIMEOUT = 15000;

function secrets() {
  try { return JSON.parse(fs.readFileSync(SECRETS, 'utf8')); } catch { return {}; }
}

export function currentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || '1.0.0';
  } catch { return '1.0.0'; }
}

/** 版本号比较：只比数字段，忽略前缀 v 与后缀 -beta */
export function cmpVersion(a, b) {
  const norm = (v) => String(v || '').replace(/^v/i, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = norm(a);
  const y = norm(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchText(url, { method = 'GET', redirect = 'follow' } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('超时')), TIMEOUT);
  try {
    const r = await fetch(url, { method, redirect, headers: { 'user-agent': UA, accept: 'text/html,application/json' }, signal: ac.signal });
    const loc = r.headers.get('location') || '';
    const text = method === 'HEAD' ? '' : await r.text().catch(() => '');
    return { status: r.status, location: loc, url: r.url, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检查更新。返回：
 * { ok, repo, current, latest, hasUpdate, htmlUrl, assets:[{name,url}], note }
 */
export async function checkUpdate() {
  const s = secrets();
  const repo = s?.github?.repo || 'taohua157885/TPCL1';
  const current = currentVersion();
  const base = `https://github.com/${repo}`;

  const head = await fetchText(`${base}/releases/latest`, { redirect: 'manual' });
  const loc = head.location || '';
  const m = loc.match(/\/releases\/tag\/(.+)$/);
  if (!m) {
    return { ok: true, repo, current, latest: current, hasUpdate: false, assets: [], htmlUrl: `${base}/releases`, note: '仓库还没有发布任何 release' };
  }
  const tag = decodeURIComponent(m[1]);
  const htmlUrl = `${base}/releases/tag/${encodeURIComponent(tag)}`;

  // 抓资产直链：先试 GitHub API（一次请求、字段齐全），失败再退回 HTML 抓取
  let assets = [];
  try {
    const api = await fetchText(`https://api.github.com/repos/${repo}/releases/latest`);
    const j = JSON.parse(api.text);
    if (j && Array.isArray(j.assets)) {
      for (const a of j.assets) {
        if (!a || !a.name) continue;
        if (!/\.(exe|zip|msi)$/i.test(a.name)) continue;
        assets.push({ name: a.name, url: a.browser_download_url, size: a.size || 0 });
      }
    }
  } catch { /* API 限流或不可达，走 HTML */ }

  const seen = new Set(assets.map((a) => a.url));
  const collect = (html, pattern) => {
    const re = new RegExp(pattern, 'g');
    let hit;
    while ((hit = re.exec(html))) {
      const rel = hit[1];
      if (seen.has(rel)) continue;
      seen.add(rel);
      const name = decodeURIComponent(rel.split('/').pop());
      if (!/\.(exe|zip|msi)$/i.test(name)) continue;
      assets.push({ name, url: `https://github.com${rel}` });
    }
  };
  const tagEsc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!assets.length) {
    try {
      const page = await fetchText(htmlUrl);
      collect(page.text, `href="(/${repo}/releases/download/${tagEsc}/[^"]+)"`);
    } catch { /* 页面抓不到就只给 tag */ }
  }
  if (!assets.length) {
    try {
      const exp = await fetchText(`${base}/releases/expanded_assets/${encodeURIComponent(tag)}`);
      collect(exp.text, `href="(/${repo}/releases/download/${tagEsc}/[^"]+)"`);
    } catch { /* expanded_assets 也失败则放弃 */ }
  }

  const newer = cmpVersion(tag, current) > 0;
  // 只有「有更新但 release 里没有任何安装包」时才特殊说明——避免用户看到一个点不动的更新
  const installable = assets.some((a) => /\.(exe|msi|zip)$/i.test(a.name));
  const hasUpdate = newer && installable;
  let note = '已是最新';
  if (newer && !installable) note = `发现 ${tag.replace(/^v/i, '')}，但那个 release 里还没有安装包`;
  else if (newer) note = '有新版本可用';
  return {
    ok: true, repo, current, latest: tag.replace(/^v/i, ''), tag, hasUpdate, assets, htmlUrl,
    note,
    pending: newer && !installable,
  };
}
