import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function fileOk(file, sha1, size) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return false;
    if (typeof size === 'number' && size > 0 && st.size !== size) return false;
    if (sha1) {
      const got = await sha1File(file);
      return got.toLowerCase() === sha1.toLowerCase();
    }
    return st.size > 0;
  } catch {
    return false;
  }
}

/**
 * 下载单个文件到 dest（先写 .part 再改名），带校验与重试。
 * @returns {Promise<{size:number, from:string}>}
 */
export async function downloadFile(urls, dest, opts = {}) {
  const {
    sha1 = '',
    size = 0,
    retries = 3,
    onBytes = () => {},
    connectTimeoutMs = 20000,
    idleMs = 25000,
    // 吞吐量停滞检测：慢速滴流（每几秒来一点点）不会被 idleMs 抓到，但实际等于卡死。
    minBps = 2048,
    speedWindowMs = 8000,
  } = opts;
  await ensureDir(path.dirname(dest));

  if (await fileOk(dest, sha1, size)) return { size: (await fsp.stat(dest)).size, from: 'cache' };

  const list = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const url = list[Math.min(attempt, list.length - 1)];
    if (!url) break;
    const part = `${dest}.part`;
    try {
      const ac = new AbortController();
      // 连接阶段：等响应头；进入 body 后改为「空闲计时」，每收到一段数据就续期。
      let timer = setTimeout(() => ac.abort(new Error('连接超时')), connectTimeoutMs);
      let speedTimer;
      let got = 0;
      try {
        const res = await fetch(url, {
          signal: ac.signal,
          redirect: 'follow',
          headers: { 'User-Agent': 'TPCL/1.0 (Minecraft Launcher)' },
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length') || 0);
        if (size > 0 && total > 0 && total !== size) {
          throw new Error(`长度不符（服务器 ${total} != 预期 ${size}）`);
        }
        clearTimeout(timer);
        timer = setTimeout(() => ac.abort(new Error('下载停滞')), idleMs);
        const body = Readable.fromWeb(res.body);
        let winStart = Date.now();
        let winBytes = 0;
        // Check independently of incoming chunks: a trickling server may not emit
        // another chunk for many seconds, so checking only in 'data' is too late.
        if (minBps > 0 && speedWindowMs > 0) speedTimer = setInterval(() => {
          const elapsed = Date.now() - winStart;
          if (elapsed < speedWindowMs) return;
          if ((winBytes * 1000) / elapsed < minBps) ac.abort(new Error('下载速度过低，切换下载源'));
          winStart = Date.now();
          winBytes = 0;
        }, Math.max(50, Math.min(1000, speedWindowMs)));
        body.on('data', (c) => {
          got += c.length;
          winBytes += c.length;
          clearTimeout(timer);
          timer = setTimeout(() => ac.abort(new Error('下载停滞')), idleMs);
          const winMs = Date.now() - winStart;
          if (winMs >= speedWindowMs) {
            const bps = (winBytes * 1000) / winMs;
            winStart = Date.now();
            winBytes = 0;
            // 只有真的慢到不可用时才判死，避免误伤瞬时抖动
            if (bps < minBps && got < (size || Infinity)) {
              ac.abort(new Error('速度过低（' + Math.round(bps / 1024) + ' KB/s）'));
            }
          }
          onBytes(c.length, total || size);
        });
        await pipeline(body, fs.createWriteStream(part));
      } finally {
        clearTimeout(timer);
        clearInterval(speedTimer);
      }
      if (size > 0 && got !== size) {
        throw new Error(`大小不符（实际 ${got} != 预期 ${size}）`);
      }
      if (sha1) {
        const gotSha = await sha1File(part);
        if (gotSha.toLowerCase() !== sha1.toLowerCase()) {
          await fsp.rm(part, { force: true });
          throw new Error(`SHA1 不匹配（${gotSha.slice(0, 8)} != ${sha1.slice(0, 8)}）`);
        }
      }
      await fsp.rename(part, dest);
      return { size: got, from: url };
    } catch (e) {
      lastErr = e;
      await fsp.rm(`${dest}.part`, { force: true }).catch(() => {});
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw new Error(`下载失败 ${path.basename(dest)}: ${lastErr?.message ?? '未知错误'}`);
}

/**
 * 并发执行任务队列。
 * @param {Array<() => Promise<any>>} jobs
 */
export async function runPool(jobs, concurrency = 8, onProgress = () => {}) {
  let index = 0;
  let done = 0;
  const total = jobs.length;
  const results = new Array(total);
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total || 1)) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= total) return;
      try {
        results[i] = await jobs[i]();
      } catch (e) {
        results[i] = { error: e.message };
      }
      done++;
      onProgress(done, total);
    }
  });
  await Promise.all(workers);
  return results;
}
