// 联机：用 bore 公共中继把本机 MC 端口映射到 bore.pub，零账号、零服务器
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, loadConfig } from './config.js';
import { gameDirFor } from './config.js';

const TOOL = () => path.join(DATA_DIR, 'tools', 'bore.exe');

let tun = null; // { proc, port, addr, since, err }

export function toolsReady() {
  try {
    const st = fs.statSync(TOOL());
    return st.size > 500 * 1024;
  } catch {
    return false;
  }
}

const BORE_URL = 'https://github.com/ekzhang/bore/releases/download/v0.6.0/bore-v0.6.0-x86_64-pc-windows-msvc.zip';

/** 首次使用时把 bore.exe 下到 DATA/tools（安装包不带它，省 1.7MB） */
export async function ensureBore() {
  if (toolsReady()) return { ok: true, path: TOOL() };
  const dir = path.join(DATA_DIR, 'tools');
  const zip = path.join(dir, 'bore.zip');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const { spawnSync } = await import('node:child_process');
    // 优先用系统 curl（会走系统代理，Node 自带 fetch 不走）
    let ok = false, lastErr = '';
    const curl = 'C:/Windows/System32/curl.exe';
    for (let i = 0; i < 3 && !ok; i++) {
      const r = spawnSync(curl, ['-L', '--fail', '--max-time', '180', '-o', zip, BORE_URL], { windowsHide: true });
      if (r.status === 0 && fs.existsSync(zip) && fs.statSync(zip).size > 300 * 1024) { ok = true; break; }
      lastErr = 'curl exit ' + r.status;
    }
    if (!ok) {
      try {
        const rr = await fetch(BORE_URL, { redirect: 'follow' });
        if (rr.ok) { fs.writeFileSync(zip, Buffer.from(await rr.arrayBuffer())); ok = true; }
        else lastErr += ' / HTTP ' + rr.status;
      } catch (e) { lastErr += ' / ' + String(e?.message || e); }
    }
    if (!ok) return { ok: false, error: '下载联机组件失败：' + lastErr };
  } catch (e) {
    return { ok: false, error: '下载联机组件失败：' + String(e?.message || e) };
  }
  try {
    const tar = 'C:/Windows/System32/tar.exe';
    const { spawnSync } = await import('node:child_process');
    const x = spawnSync(tar, ['-xf', zip, '-C', dir], { windowsHide: true });
    if (x.status !== 0 || !toolsReady()) return { ok: false, error: '联机组件解压失败（tar 返回 ' + x.status + '）' };
    return { ok: true, path: TOOL() };
  } catch (e) {
    return { ok: false, error: '联机组件解压失败：' + String(e?.message || e) };
  } finally {
    try { fs.unlinkSync(zip); } catch { /* ignore */ }
  }
}

export function netplayState() {
  if (!tun) return { ok: true, running: false, available: toolsReady() };
  return {
    ok: true,
    running: !!tun.proc && !tun.proc.killed,
    available: true,
    port: tun.port,
    addr: tun.addr || '',
    since: tun.since || 0,
    err: tun.err || '',
  };
}

/** 从最新游戏日志里找「Local game hosted on port XXXX」 */
export function detectLanPort(versionId) {
  const id = versionId || loadConfig().selectedVersion;
  const logs = path.join(gameDirFor(id), 'logs');
  const files = ['latest.log', 'debug.log'];
  for (const f of files) {
    const p = path.join(logs, f);
    try {
      const st = fs.statSync(p);
      const len = Math.min(st.size, 512 * 1024);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(p, 'r');
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const m = [...text.matchAll(/Local game hosted on port (\d{2,5})/g)].pop();
      if (m) return { ok: true, port: Number(m[1]), from: 'log' };
    } catch { /* 没有日志就继续 */ }
  }
  return { ok: true, port: 25565, from: 'default' };
}

export function stopTunnel() {
  if (!tun) return { ok: true, running: false };
  try { tun.proc?.kill(); } catch { /* ignore */ }
  tun = null;
  return { ok: true, running: false };
}

export function startTunnel(port) {
  return new Promise(async (resolve) => {
   try {
    if (tun?.proc && !tun.proc.killed) return resolve({ ok: true, addr: tun.addr, port: tun.port });
    const ens = await ensureBore();
    if (!ens.ok) return resolve({ ok: false, error: ens.error });
    const p = Number(port) || 25565;
    const proc = spawn(TOOL(), ['local', String(p), '--to', 'bore.pub'], { windowsHide: true });
    tun = { proc, port: p, addr: '', since: Date.now(), err: '' };
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const onData = (b) => {
      const s = String(b);
      const m = s.match(/bore\.pub:(\d{2,5})/);
      if (m && !tun.addr) {
        tun.addr = m[0];
        finish({ ok: true, addr: m[0], port: p });
      }
      if (/error|failed|refused/i.test(s)) {
        tun.err = s.trim().slice(0, 200);
        finish({ ok: false, error: tun.err });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      if (!done) finish({ ok: false, error: `中继进程退出（code ${code}）` });
      if (tun?.proc === proc) tun = null;
    });
    setTimeout(() => finish({ ok: false, error: '连接 bore.pub 超时（20 秒）' }), 20000);
   } catch (e) { resolve({ ok: false, error: String(e?.message || e) }); }
  });
}
