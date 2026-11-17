// 更新日志：读 GitHub releases
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const REPO = 'taohua157885/TPCL1';
let cache = null;
let cacheAt = 0;
const TTL = 10 * 60 * 1000;

function token() {
  try {
    const p = path.join(DATA_DIR, 'secrets.json');
    if (!fs.existsSync(p)) return '';
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (s.github && s.github.token) || '';
  } catch {
    return '';
  }
}

export async function listReleases(limit = 10) {
  const now = Date.now();
  if (cache && now - cacheAt < TTL) return cache.slice(0, limit);

  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'TPCL-launcher',
  };
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers });
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}${res.status === 403 ? '（API 限流，稍后再试）' : ''}`);
  const arr = await res.json();
  cache = (Array.isArray(arr) ? arr : []).map((r) => ({
    tag: r.tag_name || '',
    name: r.name || r.tag_name || '',
    publishedAt: r.published_at || '',
    prerelease: !!r.prerelease,
    url: r.html_url || '',
    body: String(r.body || '').slice(0, 4000),
    assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
  }));
  cacheAt = now;
  return cache.slice(0, limit);
}
