// 存档备份：按世界打包成 zip，支持恢复/删除/自动保留 N 份
// 用系统 tar.exe（bsdtar，`-a` 会按扩展名选 zip 格式），零依赖
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadConfig, DATA_DIR, gameDirFor } from './config.js';
import { versionDir } from './version.js';

const TAR = 'C:/Windows/System32/tar.exe';
const BACKUP_ROOT = path.join(DATA_DIR, 'backups');

function cfg() {
  return loadConfig();
}

/** 世界的 saves 目录（跟随版本隔离设置） */
export function savesDir(versionId) {
  const g = gameDirFor(versionId) || cfg().mcDir;
  return path.join(g, 'saves');
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* 忽略读不到的文件 */
        }
      }
    }
  };
  walk(dir);
  return total;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 列出所有世界 */
export function listWorlds(versionId) {
  const dir = savesDir(versionId);
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const worldPath = path.join(dir, e.name);
    const levelDat = path.join(worldPath, 'level.dat');
    if (!fs.existsSync(levelDat)) continue; // 不是世界目录（可能是 backups 残留）
    let mtime = 0;
    try {
      mtime = fs.statSync(levelDat).mtimeMs;
    } catch {
      /* ignore */
    }
    const backups = listBackups(versionId).filter((b) => b.world === e.name);
    out.push({
      name: e.name,
      path: worldPath,
      size: dirSize(worldPath),
      mtime,
      backupCount: backups.length,
      lastBackup: backups[0]?.mtime ?? 0,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function backupDirOf(versionId) {
  return path.join(BACKUP_ROOT, versionId || '_global');
}

/** 列出已有备份（新的在前） */
export function listBackups(versionId) {
  const dir = backupDirOf(versionId);
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.zip')) continue;
    const p = path.join(dir, f);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    // 文件名格式：<world>__<stamp>[-n].zip
    const m = f.match(/^(.*)__(\d{8}-\d{6})(?:-\d+)?\.zip$/);
    out.push({
      file: f,
      path: p,
      world: m ? m[1] : f.replace(/\.zip$/i, ''),
      stamp: m ? m[2] : '',
      size: st.size,
      mtime: st.mtimeMs,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** 备份一个世界，返回备份文件信息 */
export async function backupWorld(versionId, world, { keep = 0 } = {}) {
  const dir = savesDir(versionId);
  const src = path.join(dir, world);
  if (!fs.existsSync(path.join(src, 'level.dat'))) throw new Error(`找不到世界：${world}`);

  const outDir = backupDirOf(versionId);
  await fsp.mkdir(outDir, { recursive: true });
  // 同一秒内可能连做两次（比如恢复前的安全备份），加序号避免覆盖
  let file = `${world}__${stamp()}.zip`;
  let n = 1;
  while (fs.existsSync(path.join(outDir, file))) {
    file = `${world}__${stamp()}-${n}.zip`;
    n += 1;
  }
  const dest = path.join(outDir, file);

  // tar -a 按 .zip 扩展名自动选 zip 格式；session.lock 每次运行都会变，排除掉
  const args = [
    '-a', '-c', '-f', dest,
    '--exclude=session.lock',
    '-C', dir,
    world,
  ];
  const r = spawnSync(TAR, args, { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0 || !fs.existsSync(dest)) {
    const msg = (r.stderr || r.stdout || '').toString().trim().slice(0, 400);
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    } catch {
      /* ignore */
    }
    throw new Error(`打包失败：${msg || 'tar 退出码 ' + r.status}`);
  }

  const st = fs.statSync(dest);
  // 只保留最近 N 份（N>0 时）
  if (keep > 0) {
    const same = listBackups(versionId).filter((b) => b.world === world);
    for (const old of same.slice(keep)) {
      try {
        fs.unlinkSync(old.path);
      } catch {
        /* ignore */
      }
    }
  }
  return { file, world, size: st.size, mtime: st.mtimeMs, path: dest };
}

/** 备份全部世界 */
export async function backupAll(versionId, opts = {}) {
  const worlds = listWorlds(versionId);
  const results = [];
  for (const w of worlds) {
    try {
      results.push({ ok: true, ...(await backupWorld(versionId, w.name, opts)) });
    } catch (e) {
      results.push({ ok: false, world: w.name, error: e.message });
    }
  }
  return results;
}

/** 恢复备份：先解压到临时目录，成功后再替换世界（失败不会毁掉现有存档） */
export async function restoreBackup(versionId, file) {
  const dir = backupDirOf(versionId);
  const src = path.join(dir, file);
  if (!fs.existsSync(src)) throw new Error(`备份不存在：${file}`);
  const m = file.match(/^(.*)__(\d{8}-\d{6})(?:-\d+)?\.zip$/);
  const world = m ? m[1] : file.replace(/\.zip$/i, '');

  const saves = savesDir(versionId);
  await fsp.mkdir(saves, { recursive: true });

  // 先解到临时目录，避免"解压到一半失败"把现有世界弄坏
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'tpcl-restore-'));
  const r = spawnSync(TAR, ['-x', '-f', src, '-C', tmp], {
    windowsHide: true, encoding: 'utf8', timeout: 180000,
  });
  if (r.status !== 0) {
    await fsp.rm(tmp, { recursive: true, force: true });
    const msg = (r.stderr || r.stdout || '').toString().trim().slice(0, 400);
    throw new Error(`解压失败：${msg || 'tar 退出码 ' + r.status}`);
  }

  const extracted = path.join(tmp, world);
  const pick = fs.existsSync(extracted) ? extracted : tmp;
  if (!fs.existsSync(path.join(pick, 'level.dat'))) {
    await fsp.rm(tmp, { recursive: true, force: true });
    throw new Error('这个备份里找不到 level.dat，可能不是存档包');
  }

  const target = path.join(saves, world);
  let safety = null;
  if (fs.existsSync(target)) {
    safety = await backupWorld(versionId, world); // 覆盖前先留一份，防手滑
    await fsp.rm(target, { recursive: true, force: true });
  }
  await fsp.cp(pick, target, { recursive: true });
  await fsp.rm(tmp, { recursive: true, force: true });

  return { world, restored: file, safetyBackup: safety?.file ?? null };
}

export function deleteBackup(versionId, file) {
  const p = path.join(backupDirOf(versionId), file);
  if (!fs.existsSync(p)) throw new Error(`备份不存在：${file}`);
  fs.unlinkSync(p);
  return { ok: true };
}

/** 备份目录路径（用于"打开文件夹"） */
export function backupsDir(versionId) {
  return backupDirOf(versionId);
}

// ───────────────────────── 导入世界 ─────────────────────────
// 支持：单个世界文件夹 / 包含多个世界的文件夹 / zip（含 .mcworld，本质也是 zip）
import { listEntries, extract as zipExtract } from './ziptool.js';

function uniqueName(saves, base) {
  let name = base;
  let n = 2;
  while (fs.existsSync(path.join(saves, name))) {
    name = `${base} (${n})`;
    n += 1;
  }
  return name;
}

function sanitizeName(s) {
  const t = String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().replace(/[. ]+$/, '');
  return t || '导入的世界';
}

/** 从 zip 里导入所有世界（自动处理外层同名包装目录） */
async function importFromZip(saves, file, baseName) {
  const raw = await listEntries(file);
  const names = raw.map((e) => (typeof e === 'string' ? e : e.name));
  const roots = new Set();
  for (const n0 of names) {
    const n = n0.replace(/\\/g, '/');
    if (n === 'level.dat') roots.add('');
    else if (/^[^/]+\/level\.dat$/.test(n)) roots.add(n.slice(0, n.indexOf('/') + 1));
  }
  if (!roots.size) return { imported: [], error: '这个压缩包里没有找到 level.dat（不是世界存档）' };
  const imported = [];
  let i = 0;
  for (const root of roots) {
    // 有外层目录时用目录名（那才是世界名），level.dat 直接在根上的才退回压缩包名
    const want = root ? sanitizeName(root.replace(/\/$/, '')) : sanitizeName(baseName);
    const name = uniqueName(saves, want);
    const dest = path.join(saves, name);
    fs.mkdirSync(dest, { recursive: true });
    const n = await zipExtract(file, dest, root ? { prefix: root } : {});
    if (!n) {
      fs.rmSync(dest, { recursive: true, force: true });
      continue;
    }
    imported.push({ name, files: n });
    i += 1;
  }
  return { imported };
}

/** 导入世界：srcPath 可以是文件夹或 zip/.mcworld */
export async function importWorld(versionId, srcPath) {
  const saves = savesDir(versionId);
  fs.mkdirSync(saves, { recursive: true });
  let st;
  try {
    st = fs.statSync(srcPath);
  } catch {
    return { ok: false, error: '路径不存在：' + srcPath };
  }
  const base = path.basename(srcPath).replace(/\.(zip|mcworld)$/i, '');

  if (st.isDirectory()) {
    // 单个世界，或「装着一堆世界」的文件夹
    if (fs.existsSync(path.join(srcPath, 'level.dat'))) {
      const name = uniqueName(saves, sanitizeName(path.basename(srcPath)));
      fs.cpSync(srcPath, path.join(saves, name), { recursive: true });
      return { ok: true, imported: [{ name, files: 0 }], saves };
    }
    let ents = [];
    try {
      ents = fs.readdirSync(srcPath, { withFileTypes: true });
    } catch {
      ents = [];
    }
    const dirs = ents.filter((e) => e.isDirectory() && fs.existsSync(path.join(srcPath, e.name, 'level.dat')));
    if (!dirs.length) return { ok: false, error: '这个文件夹里没有 level.dat，不是世界存档' };
    const imported = [];
    for (const d of dirs) {
      const name = uniqueName(saves, sanitizeName(d.name));
      fs.cpSync(path.join(srcPath, d.name), path.join(saves, name), { recursive: true });
      imported.push({ name, files: 0 });
    }
    return { ok: true, imported, saves };
  }

  // 文件：只接受 zip / mcworld
  if (!/\.(zip|mcworld)$/i.test(srcPath)) {
    return { ok: false, error: '只支持 .zip / .mcworld 或者世界文件夹' };
  }
  const r = await importFromZip(saves, srcPath, base);
  if (!r.imported.length) return { ok: false, error: r.error || '导入失败' };
  return { ok: true, imported: r.imported, saves };
}
