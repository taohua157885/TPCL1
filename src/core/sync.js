// 云同步（文件夹型）：把世界备份推到任意「同步目录」——OneDrive / 坚果云 / 局域网共享 / U 盘都行。
// 不做账号体系，也不锁格式，远端就是一个普通目录，能被人肉管理。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { loadConfig, saveConfig } from './config.js';
import { savesDir, listWorlds, backupWorld, backupsDir } from './backup.js';

const TAR = 'C:/Windows/System32/tar.exe';
const KEEP_REMOTE = 5;

export function syncDir() {
  const d = loadConfig().syncDir;
  return typeof d === 'string' && d.trim() ? d.trim() : null;
}

export function remoteDir(versionId) {
  const root = syncDir();
  if (!root) return null;
  return path.join(root, 'TPCL-Worlds', versionId);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function dirSize(dir) {
  let total = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
function run(exe, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true, ...opts });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `退出码 ${code}`))));
  });
}

/** 远端已有哪些这个版本的备份 */
export async function listRemote(versionId) {
  const dir = remoteDir(versionId);
  if (!dir) return { dir: null, files: [] };
  const names = await fsp.readdir(dir).catch(() => []);
  const files = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.zip')) continue;
    const st = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (!st) continue;
    const m = /^(.*)__(\d{8}-\d{6})(?:-\d+)?\.zip$/i.exec(name);
    files.push({
      file: name,
      world: m ? m[1] : name.replace(/\.zip$/i, ''),
      stamp: m ? m[2] : '',
      size: st.size,
      mtime: st.mtimeMs,
    });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return { dir, files };
}

/** 把一个世界推到同步目录（先打本地 tar 包再复制，避免直接写远端失败） */
export async function pushWorld(versionId, world, { keep = KEEP_REMOTE } = {}) {
  const dir = remoteDir(versionId);
  if (!dir) throw new Error('还没设置同步目录');
  await fsp.mkdir(dir, { recursive: true });

  const local = await backupWorld(versionId, world, { keep: 0 });
  const target = path.join(dir, local.file);
  let dest = target;
  let n = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(dir, local.file.replace(/\.zip$/i, `-${n}.zip`));
    n += 1;
  }
  await fsp.copyFile(path.join(backupsDir(versionId), local.file), dest);
  await fsp.rm(path.join(backupsDir(versionId), local.file), { force: true });

  // 只留最近 keep 个
  const { files } = await listRemote(versionId);
  const same = files.filter((f) => f.world === world);
  for (const f of same.slice(keep)) {
    await fsp.rm(path.join(dir, f.file), { force: true }).catch(() => {});
  }
  return { file: path.basename(dest), world, size: (await fsp.stat(dest)).size, dir };
}

export async function pushAll(versionId) {
  const worlds = listWorlds(versionId);
  if (!worlds.length) return { ok: true, pushed: [] };
  const pushed = [];
  for (const w of worlds) {
    try {
      pushed.push(await pushWorld(versionId, w.name));
    } catch (e) {
      pushed.push({ world: w.name, error: e.message });
    }
  }
  return { ok: true, pushed };
}

/** 从同步目录取回最新（或指定）备份，先做本地安全备份再覆盖 */
export async function pullWorld(versionId, world, file = null) {
  const { dir, files } = await listRemote(versionId);
  if (!dir) throw new Error('还没设置同步目录');
  const pick = file ? files.find((f) => f.file === file) : files.find((f) => f.world === world);
  if (!pick) throw new Error(`同步目录里没有「${world}」的备份`);

  // 本地安全备份（若世界还在）
  let safety = null;
  const worldPath = path.join(savesDir(versionId), world);
  if (fs.existsSync(worldPath)) {
    const b = await backupWorld(versionId, world, { keep: 0 });
    safety = b.file;
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'tpcl-sync-'));
  try {
    await run(TAR, ['-x', '-f', path.join(dir, pick.file), '-C', tmp]);
    const inner = path.join(tmp, world);
    const src = fs.existsSync(path.join(inner, 'level.dat')) ? inner : tmp;
    if (!fs.existsSync(path.join(src, 'level.dat'))) throw new Error('这个备份里没有 level.dat，可能不是世界存档');
    await fsp.rm(worldPath, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(worldPath, { recursive: true });
    await fsp.cp(src, worldPath, { recursive: true });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  return { ok: true, world, from: pick.file, safetyBackup: safety };
}

export async function setSyncDir(dir) {
  const value = String(dir || '').trim();
  if (value) {
    await fsp.mkdir(value, { recursive: true });
    await fsp.access(value);
  }
  const cfg = saveConfig({ syncDir: value });
  return { syncDir: cfg.syncDir };
}

/** 概览：本地世界 + 远端备份，给 UI 一次拿全 */
export async function syncOverview(versionId) {
  const dir = syncDir();
  const worlds = listWorlds(versionId);
  const remote = await listRemote(versionId);
  return {
    version: versionId,
    syncDir: dir,
    worlds,
    remote: remote.files,
    localBackupDir: backupsDir(versionId),
    exists: dir ? fs.existsSync(dir) : false,
  };
}
