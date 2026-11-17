// 启动器自更新：下载对应安装包 → 写一个批处理 → 退出当前进程 → 批处理替换/安装 → 重新拉起
// 两种模式：
//   installed  —— 装过 NSIS 安装包（进程目录里没有 portable.txt）
//   portable   —— 便携版（exe 同级有 portable.txt，或 exe 名字带 portable/便携）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, ROOT } from './config.js';

const UPD_DIR = path.join(DATA_DIR, 'updates');
const STATE_FILE = path.join(UPD_DIR, 'state.json');
const UA = 'TPCL-updater/1.0';

export function exeDir() {
  return process.env.TPCL_EXE_DIR || path.dirname(process.execPath);
}
export function currentExe() {
  return process.execPath;
}

/** 打包版才有意义；开发模式（node 直接跑）返回 false */
export function canSelfUpdate() {
  if (process.env.TPCL_SELFUPDATE_TEST === '1') return true;   // 仅测试用
  if (!process.env.TPCL_EXE_DIR && !process.versions.electron) return false;
  return /\.exe$/i.test(process.execPath);
}

export function updateMode() {
  const dir = exeDir();
  const exe = currentExe();
  const mark = path.join(dir, 'portable.txt');
  if (fs.existsSync(mark)) return 'portable';
  if (/portable|便携/i.test(path.basename(exe))) return 'portable';
  return 'installed';
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  try {
    fs.mkdirSync(UPD_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/** 已下载待安装的状态 */
export function updateState() {
  const st = readState();
  const file = st.file && fs.existsSync(st.file) ? st.file : '';
  return {
    ok: true,
    mode: updateMode(),
    canUpdate: canSelfUpdate(),
    downloaded: !!file,
    file,
    version: st.version || '',
    size: file ? (() => { try { return fs.statSync(file).size; } catch { return 0; } })() : 0,
    exeDir: exeDir(),
    exe: currentExe(),
    log: st.log || '',
  };
}

/** 从 release assets 里挑当前模式要的那个 */
export function pickAsset(assets, mode = updateMode()) {
  const list = Array.isArray(assets) ? assets.filter((a) => a && a.url) : [];
  const want = mode === 'portable' ? /portable.*\.exe$/i : /setup\.exe$/i;
  const hit = list.find((a) => want.test(a.name || '') || want.test(a.url || ''));
  return hit || list.find((a) => /\.exe$/i.test(a.name || '')) || null;
}

/** 下载到 <DATA>/updates/，边下边回报进度 */
export async function downloadUpdate(asset, onProgress = () => {}) {
  if (!asset?.url) throw new Error('没有可用的下载地址');
  await fsp.mkdir(UPD_DIR, { recursive: true });
  const name = (asset.name || 'TPCL-setup.exe').replace(/[^\w.\-]/g, '_');
  const dest = path.join(UPD_DIR, name);
  const part = dest + '.part';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('下载超时（5 分钟）')), 5 * 60 * 1000);
  let written = 0;
  try {
    const r = await fetch(asset.url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: ac.signal });
    if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length') || asset.size || 0);
    const out = fs.createWriteStream(part);
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));
      written += value.length;
      onProgress({ got: written, total, pct: total ? Math.min(100, Math.round((written / total) * 100)) : -1 });
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    await fsp.rename(part, dest);
    writeState({ file: dest, version: asset.version || '', log: '' });
    return { ok: true, file: dest, size: written };
  } catch (e) {
    try { await fsp.unlink(part); } catch { /* ignore */ }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生成并启动更新批处理，然后由调用方退出当前进程。
 * 批处理做四件事：等本进程退出 → 安装/替换 → 清掉旧文件 → 重新拉起。
 */
export function applyUpdate(file, mode = updateMode(), over = {}) {
  if (!file || !fs.existsSync(file)) throw new Error('安装包不存在，请重新下载');
  const dir = over.dir || exeDir();
  const exe = over.exe || currentExe();
  const pid = over.pid || process.pid;
  const bat = path.join(UPD_DIR, 'apply-update.cmd');
  const logFile = path.join(UPD_DIR, 'apply-update.log');

  const wait = [
    '@echo off',
    'chcp 65001 >nul',
    `set LOG="${logFile}"`,
    'echo [%date% %time%] start > %LOG%',
    ':waitloop',
    `tasklist /FI "PID eq ${pid}" | find "${pid}" >nul`,
    'if not errorlevel 1 (',
    '  timeout /t 1 /nobreak >nul',
    '  goto waitloop',
    ')',
    'echo exited >> %LOG%',
  ];

  const body = mode === 'portable'
    ? [
        // 便携：把正在跑的 exe 改名，复制新 exe 过去，再启动，最后删旧文件
        `move /y "${exe}" "${exe}.old" >> %LOG% 2>&1`,
        `copy /y "${file}" "${exe}" >> %LOG% 2>&1`,
        'timeout /t 2 /nobreak >nul',
        `del /q "${exe}.old" >> %LOG% 2>&1`,
        `start "" "${exe}"`,
      ]
    : [
        // 安装版：静默原地覆盖安装（/D= 必须是最后一个参数且不带引号转义问题）
        `start /wait "" "${file}" /S /D=${dir} >> %LOG% 2>&1`,
        'echo installed >> %LOG%',
        `start "" "${exe}"`,
      ];

  const lines = [...wait, ...body, 'echo done >> %LOG%', `del /q "${file}" >> %LOG% 2>&1`, 'del "%~f0" >nul 2>&1'];
  fs.mkdirSync(UPD_DIR, { recursive: true });
  fs.writeFileSync(bat, lines.join('\r\n') + '\r\n', 'utf8');
  writeState({ log: logFile, appliedAt: new Date().toISOString(), mode });

  const child = spawn('cmd.exe', ['/c', bat], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: UPD_DIR,
  });
  child.unref();
  return { ok: true, bat, log: logFile, mode };
}

/** 读上一次更新的批处理日志（给「更多」页排错用） */
export function applyLog() {
  const st = readState();
  try { return { ok: true, text: fs.readFileSync(st.log || path.join(UPD_DIR, 'apply-update.log'), 'utf8').slice(-4000) }; }
  catch { return { ok: false, text: '' }; }
}

export const UPDATES_DIR = UPD_DIR;
export const ROOT_DIR = ROOT;
