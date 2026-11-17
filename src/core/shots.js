// 截图管理：列目录 / 读尺寸 / 删除 / 打开所在文件夹
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, gameDirFor } from './config.js';

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function cfg() {
  return loadConfig();
}

/** 当前版本的 screenshots 目录（跟随版本隔离） */
export function shotsDir(versionId) {
  const g = gameDirFor(versionId) || cfg().mcDir;
  return path.join(g, 'screenshots');
}

/** PNG 读 IHDR 拿宽高；JPEG 不支持则返回 null */
function pngSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(24);
    const n = fs.readSync(fd, buf, 0, 24, 0);
    if (n < 24) return null;
    if (buf.readUInt32BE(0) !== 0x89504e47) return null; // ‰PNG
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 列出截图，按修改时间倒序 */
export function listShots(versionId) {
  const dir = shotsDir(versionId);
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of ents) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!IMG_EXT.has(ext)) continue;
    const full = path.join(dir, e.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    const dim = pngSize(full);
    out.push({
      name: e.name,
      path: full,
      size: st.size,
      mtime: st.mtimeMs,
      w: dim?.w || 0,
      h: dim?.h || 0,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** 只允许操作 screenshots 目录内的文件 */
function safeShot(versionId, name) {
  const dir = path.resolve(shotsDir(versionId));
  const full = path.resolve(dir, path.basename(String(name || '')));
  if (!full.startsWith(dir + path.sep)) return null;
  return full;
}

export function deleteShot(versionId, name) {
  const full = safeShot(versionId, name);
  if (!full) return { ok: false, error: '路径不合法' };
  try {
    fs.unlinkSync(full);
    return { ok: true, deleted: path.basename(full) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** 批量删除，返回成功条数 */
export function deleteShots(versionId, names) {
  const list = Array.isArray(names) ? names : [];
  let deleted = 0;
  const failed = [];
  for (const n of list) {
    const r = deleteShot(versionId, n);
    if (r.ok) deleted += 1;
    else failed.push({ name: n, error: r.error });
  }
  return { ok: true, deleted, failed, shots: listShots(versionId) };
}

/** 缩略图/原图文件路径（供 /api/shot/file 使用） */
export function shotFile(versionId, name) {
  const full = safeShot(versionId, name);
  if (!full) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return full;
}

export function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}
