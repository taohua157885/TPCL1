import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, gameDirFor } from './config.js';
import { annotatePacks } from './packmeta.js';
import { annotateActive } from './packstate.js';

const TAR = 'C:/Windows/System32/tar.exe';

const MOD_EXT = ['.jar', '.zip', '.mrpack', '.disabled'];
const SUBDIRS = {
  mods: 'mods',
  resourcepacks: 'resourcepacks',
  shaderpacks: 'shaderpacks',
  saves: 'saves',
  datapacks: 'datapacks',
};

export function contentDir(versionId, kind) {
  const sub = SUBDIRS[kind];
  if (!sub) throw new Error(`未知内容类型：${kind}`);
  const base = gameDirFor(versionId);
  // 版本隔离时 mods 在版本目录内；全局则在 .minecraft 根
  return path.join(base, sub);
}

export async function listContent(versionId) {
  const result = { mods: [], resourcepacks: [], shaderpacks: [], saves: [], datapacks: [] };
  for (const kind of Object.keys(SUBDIRS)) {
    const dir = contentDir(versionId, kind);
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (kind === 'saves') {
          const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
          result[kind].push({
            name: e.name, enabled: true, isDir: true,
            size: 0, mtime: st?.mtimeMs ?? 0, path: path.join(dir, e.name),
          });
        }
        continue;
      }
      const name = e.name;
      const disabled = name.endsWith('.disabled');
      const base = disabled ? name.slice(0, -'.disabled'.length) : name;
      const ext = path.extname(base).toLowerCase();
      if (kind === 'mods' && !['.jar', '.zip'].includes(ext)) continue;
      if (kind === 'resourcepacks' && !['.zip', '.jar'].includes(ext)) continue;
      if (kind === 'shaderpacks' && !['.zip', '.jar'].includes(ext)) continue;
      const full = path.join(dir, name);
      const st = await fsp.stat(full).catch(() => null);
      result[kind].push({
        name: base,
        file: name,
        enabled: !disabled,
        isDir: false,
        size: st?.size ?? 0,
        mtime: st?.mtimeMs ?? 0,
        path: full,
      });
    }
    result[kind].sort((a, b) => a.name.localeCompare(b.name));
    if (kind === 'resourcepacks' || kind === 'shaderpacks' || kind === 'datapacks') {
      await annotatePacks(versionId, kind, result[kind]).catch(() => {});
      await annotateActive(versionId, kind, result[kind]).catch(() => {});
    }
  }
  return result;
}

export async function toggleContent(versionId, kind, fileName) {
  const dir = contentDir(versionId, kind);
  const full = path.join(dir, fileName);
  if (!fs.existsSync(full)) throw new Error('文件不存在');
  const disabled = fileName.endsWith('.disabled');
  const target = disabled ? full.slice(0, -'.disabled'.length) : `${full}.disabled`;
  if (fs.existsSync(target)) throw new Error('目标文件已存在');
  await fsp.rename(full, target);
  return { ok: true, enabled: disabled, file: path.basename(target) };
}

export async function deleteContent(versionId, kind, fileName) {
  const dir = contentDir(versionId, kind);
  const full = path.join(dir, fileName);
  const st = await fsp.stat(full).catch(() => null);
  if (!st) throw new Error('文件不存在');
  await fsp.rm(full, { recursive: true, force: true });
  return { ok: true };
}

/** 从 zip 里取一个成员的内容（读不到返回 null） */
function readZipMember(filePath, member) {
  try {
    const r = spawnSync(TAR, ['-xOf', filePath, member], {
      timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8',
    });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout;
  } catch {
    return null;
  }
}

/**
 * 读取 jar/zip 内的模组元数据：Fabric(fabric.mod.json) → Forge/NeoForge(mods.toml)
 * → 退回 MANIFEST.MF / pack.mcmeta。全部失败就给个只有文件名的结果。
 */
export async function peekMeta(filePath) {
  const base = path.basename(filePath);
  const out = { file: base, name: base, id: '', version: '', authors: '', loader: '', description: '' };

  // Fabric
  const fab = readZipMember(filePath, 'fabric.mod.json');
  if (fab) {
    try {
      const j = JSON.parse(fab);
      out.loader = 'fabric';
      out.id = String(j.id ?? '');
      out.version = String(j.version ?? '');
      out.name = String(j.name ?? out.name);
      const a = j.authors;
      out.authors = Array.isArray(a)
        ? a.map((x) => (typeof x === 'string' ? x : x?.name ?? '')).filter(Boolean).join(', ')
        : (typeof a === 'string' ? a : '');
      const d = j.description;
      out.description = typeof d === 'string' ? d : (d?.translate ?? '');
      return out;
    } catch { /* 继续尝试其它格式 */ }
  }

  // Forge / NeoForge：mods.toml 是 TOML，但我们只需要几个顶层字段，用轻量解析
  for (const member of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
    const toml = readZipMember(filePath, member);
    if (!toml) continue;
    out.loader = member.includes('neoforge') ? 'neoforge' : 'forge';
    const pick = (key) => {
      const m = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'));
      return m ? m[1] : '';
    };
    out.id = pick('modId');
    out.name = pick('displayName') || out.name;
    out.version = pick('version');
    out.authors = pick('authors');
    out.description = pick('description');
    if (out.id || out.name !== base) return out;
  }

  // 资源包 / 光影：pack.mcmeta
  const mcmeta = readZipMember(filePath, 'pack.mcmeta');
  if (mcmeta) {
    try {
      const j = JSON.parse(mcmeta);
      out.loader = 'resourcepack';
      out.description = String(j.pack?.description ?? '').slice(0, 200);
      out.version = String(j.pack?.pack_format ?? '');
      return out;
    } catch { /* ignore */ }
  }

  // 最后退回 MANIFEST.MF
  const mf = readZipMember(filePath, 'META-INF/MANIFEST.MF');
  if (mf) {
    const pick = (key) => {
      const m = mf.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    out.name = pick('Implementation-Title') || out.name;
    out.version = pick('Implementation-Version') || out.version;
    out.authors = pick('Implementation-Vendor') || '';
    return out;
  }

  return out;
}

export async function openFolder(dirPath, opts = {}) {
  const { execFile } = await import('node:child_process');
  if (process.platform === 'win32') {
    // select=true 时传 /select,"路径" 让资源管理器选中这个文件
    const args = opts.select ? ['/select,', dirPath] : [dirPath];
    execFile('explorer.exe', args, { windowsHide: true });
  } else if (process.platform === 'darwin') {
    execFile('open', opts.select ? ['-R', dirPath] : [dirPath]);
  } else {
    execFile('xdg-open', [dirPath]);
  }
}
