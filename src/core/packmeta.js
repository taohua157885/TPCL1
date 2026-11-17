// 资源包 / 光影包的元信息：读 pack.mcmeta 的描述与格式版本，取 pack.png 作为图标
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readEntry, readText, listEntries } from './ziptool.js';
import { DATA_DIR } from './config.js';

const ICON_CACHE = () => path.join(DATA_DIR, 'cache', 'packicons');

/** 有的光影包把信息写在 shaders/*，有的干脆没有 pack.mcmeta */
async function metaFromZip(file) {
  const out = { title: '', description: '', format: 0, hasIcon: false, kindHint: '' };
  let entries = [];
  try {
    entries = await listEntries(file);
  } catch {
    return out;
  }
  const names = entries.map((e) => e.name.toLowerCase());
  out.hasIcon = names.includes('pack.png');
  // 光影包特征：根上有 shaders/ 目录
  if (names.some((n) => n.startsWith('shaders/'))) out.kindHint = 'shader';

  const metaName = entries.find((e) => e.name.toLowerCase() === 'pack.mcmeta')?.name;
  if (metaName) {
    try {
      const raw = await readText(file, metaName);
      const j = JSON.parse(raw);
      const p = j.pack ?? j;
      out.format = Number(p.pack_format ?? 0) || 0;
      const d = p.description;
      if (typeof d === 'string') out.description = d;
      else if (d && typeof d === 'object') {
        out.description = d.text || (Array.isArray(d.extra) ? d.extra.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('') : '');
      }
    } catch { /* mcmeta 坏了就当没有 */ }
  }

  // 光影包常把说明放在 shaders/lang/*.lang 或根目录 readme
  if (!out.description && out.kindHint === 'shader') {
    const lang = entries.find((e) => /^shaders\/lang\/(en_us|zh_cn)\.lang$/i.test(e.name));
    if (lang) {
      try {
        const raw = await readText(file, lang.name);
        const line = raw.split(/\r?\n/).find((l) => /^screen=|^profile=|^option\./i.test(l) && l.split('=')[1]);
        if (line) out.description = line.split('=').slice(1).join('=').replace(/§./g, '').trim().slice(0, 120);
      } catch { /* 忽略 */ }
    }
  }
  return out;
}

/** 落盘一份图标，返回可给前端的 URL 片段（用文件哈希做 key，避免同名覆盖） */
async function cacheIcon(file, versionId, kind, baseName) {
  const buf = await readEntry(file, 'pack.png');
  if (!buf || buf.length < 32) return '';
  const key = crypto.createHash('sha1').update(versionId + '|' + kind + '|' + baseName + '|' + buf.length).digest('hex').slice(0, 16);
  const dest = path.join(ICON_CACHE(), key + '.png');
  try {
    await fsp.mkdir(ICON_CACHE(), { recursive: true });
    const st = await fsp.stat(dest).catch(() => null);
    if (!st) await fsp.writeFile(dest, buf);
  } catch {
    return '';
  }
  return key;
}

export function iconPath(key) {
  if (!/^[a-f0-9]{16}$/.test(String(key || ''))) return '';
  return path.join(ICON_CACHE(), key + '.png');
}

/**
 * 给一批资源包/光影条目补上 meta 与图标。
 * items 来自 content.js 的 listContent（已是 {name,file,path,...}）
 */
export async function annotatePacks(versionId, kind, items) {
  for (const it of items) {
    if (it.isDir) continue;
    const lower = it.file.toLowerCase();
    if (!lower.endsWith('.zip') && !lower.endsWith('.jar')) continue;
    try {
      const meta = await metaFromZip(it.path);
      it.meta = meta;
      it.description = meta.description;
      it.packFormat = meta.format;
      it.iconKey = meta.hasIcon ? await cacheIcon(it.path, versionId, kind, it.name) : '';
    } catch {
      it.meta = null;
    }
  }
  return items;
}

/** 清掉缓存里没人用的图标（每阶段收尾时可调用） */
export async function pruneIconCache(keepKeys) {
  const keep = new Set(keepKeys);
  let files = [];
  try { files = await fsp.readdir(ICON_CACHE()); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    const key = f.replace(/\.png$/, '');
    if (keep.has(key)) continue;
    await fsp.unlink(path.join(ICON_CACHE(), f)).catch(() => {});
    n++;
  }
  return n;
}

export function iconCacheDir() {
  return ICON_CACHE();
}

export function iconCacheExists() {
  return fs.existsSync(ICON_CACHE());
}
