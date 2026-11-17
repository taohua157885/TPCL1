import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, DATA_DIR } from './config.js';
import {
  versionsDir, versionDir, versionJsonPath, librariesDir, assetsDir,
  rulesAllow, libraryArtifactPath, classifyLibrary, nativeArtifact, OS_NAME, libArchAllowed,
} from './version.js';
import { candidateUrls, versionJsonCandidates, clientJarCandidates, toMirror } from './mirror.js';
import { downloadFile, runPool, ensureDir } from './download.js';

const MANIFEST = {
  official: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  bmclapi: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
};
const MANIFEST_CACHE = path.join(DATA_DIR, 'manifest.json');

function mirrorOf() {
  return loadConfig().mirror || 'bmclapi';
}

async function fetchJson(urls, timeoutMs = 30000) {
  let lastErr;
  for (const u of urls) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetch(u, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': 'TPCL/1.0' } });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`获取版本清单失败：${lastErr?.message ?? '网络错误'}`);
}

/** 远程版本清单（带缓存） */
export async function fetchManifest(force = false) {
  const cfg = loadConfig();
  const maxAge = 10 * 60 * 1000;
  if (!force) {
    try {
      const st = await fsp.stat(MANIFEST_CACHE);
      if (Date.now() - st.mtimeMs < maxAge) {
        return JSON.parse(await fsp.readFile(MANIFEST_CACHE, 'utf8'));
      }
    } catch { /* 缓存不存在 */ }
  }
  const urls = cfg.mirror === 'official'
    ? [MANIFEST.official]
    : [MANIFEST.bmclapi, MANIFEST.official];
  const data = await fetchJson(urls);
  await ensureDir(DATA_DIR);
  await fsp.writeFile(MANIFEST_CACHE, JSON.stringify(data), 'utf8');
  return data;
}

/** 远程版本列表（精简字段） */
export async function listRemoteVersions({ includeSnapshot = true } = {}) {
  const m = await fetchManifest();
  const list = (m.versions ?? []).filter((v) => includeSnapshot || v.type === 'release');
  return { latest: m.latest, versions: list };
}

function report(onProgress, payload) {
  try { onProgress?.(payload); } catch { /* 忽略回调异常 */ }
}

/**
 * 安装 / 补全一个版本。
 * @param {string} id 版本 id
 * @param {{ force?:boolean, skipAssets?:boolean, onProgress?:Function }} opts
 */
export async function installVersion(id, opts = {}) {
  const cfg = loadConfig();
  const mirror = cfg.mirror || 'bmclapi';
  const { onProgress, force = false, skipAssets = false } = opts;
  const vDir = versionDir(id);
  const jsonPath = versionJsonPath(id);

  await ensureDir(vDir);
  let json;
  if (force || !fs.existsSync(jsonPath)) {
    report(onProgress, { stage: 'json', percent: 0, text: `获取 ${id} 版本信息…` });
    const manifest = await fetchManifest();
    const entry = manifest.versions?.find((v) => v.id === id);
    const officialUrl = entry?.url ?? `https://piston-meta.mojang.com/v1/packages/x/${id}.json`;
    json = await fetchJson(versionJsonCandidates(id, officialUrl, mirror));
    await fsp.writeFile(jsonPath, JSON.stringify(json, null, 2), 'utf8');
  } else {
    json = JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
  }

  // 若带 inheritsFrom，先装父版本
  if (json.inheritsFrom) {
    const parentJson = path.join(versionDir(json.inheritsFrom), `${json.inheritsFrom}.json`);
    if (!fs.existsSync(parentJson)) {
      report(onProgress, { stage: 'json', percent: 0, text: `先安装父版本 ${json.inheritsFrom}…` });
      await installVersion(json.inheritsFrom, { onProgress, skipAssets });
    }
  }

  const tasks = [];
  const totalBytes = { value: 0 };

  // 1) client jar
  const jarName = json.jar ? `${json.jar}.jar` : `${id}.jar`;
  const jarPath = path.join(vDir, jarName);
  const client = json.downloads?.client;
  if (client?.url && !fs.existsSync(jarPath)) {
    report(onProgress, { stage: 'client', percent: 0, text: '下载客户端主文件…' });
    tasks.push(async () => {
      await downloadFile(clientJarCandidates(id, client.url, mirror), jarPath, {
        sha1: client.sha1, size: client.size, retries: 3,
        onBytes: (n) => report(onProgress, { stage: 'client', bytes: n, bytesTotal: client.size, text: '客户端主文件' }),
      });
    });
    totalBytes.value += client.size ?? 0;
  }

  // 2) libraries
  const libs = (json.libraries ?? []).filter((l) => rulesAllow(l.rules) && libArchAllowed(l));
  const libJobs = [];
  for (const lib of libs) {
    const kind = classifyLibrary(lib);
    let rel = null, url = null, sha1 = '', size = 0;
    if (kind === 'native') {
      const nat = nativeArtifact(lib);
      if (nat) { rel = nat.path; url = nat.url; sha1 = nat.sha1; size = nat.size ?? 0; }
    }
    if (!rel) {
      rel = libraryArtifactPath(lib);
      // Forge / NeoForge / Fabric 的库把仓库写在 lib.url 上（没有 downloads.artifact）
      const repo = typeof lib.url === 'string' && lib.url ? lib.url.replace(/\/+$/, '') : null;
      url = lib.downloads?.artifact?.url ?? (repo ? `${repo}/${rel}` : `https://libraries.minecraft.net/${rel}`);
      sha1 = lib.downloads?.artifact?.sha1 ?? '';
      size = lib.downloads?.artifact?.size ?? 0;
    }
    const dest = path.join(librariesDir(), rel);
    if (fs.existsSync(dest)) continue;
    // url 为空串 = 由加载器安装器本地生成的构件（如 Forge 的 -client.jar），不能下载
    if (!url) continue;
    libJobs.push(async () => {
      await downloadFile(candidateUrls(url, mirror), dest, { sha1, size, retries: 3 });
    });
    totalBytes.value += size;
  }
  if (libJobs.length) {
    report(onProgress, { stage: 'libraries', percent: 0, text: `下载 ${libJobs.length} 个库文件…` });
    tasks.push(async () => {
      let done = 0;
      const results = await runPool(libJobs, cfg.downloadThreads || 12, (d, t) => {
        done = d;
        report(onProgress, { stage: 'libraries', percent: Math.round((d / t) * 100), current: d, total: t, text: `库文件 ${d}/${t}` });
      });
      const failed = results.filter(r => r?.error);
      if (failed.length) throw new Error(`${failed.length} 个依赖库下载失败：${failed[0].error}`);
      return done;
    });
  }

  // 3) asset index（必须同步取到，否则后面无法知道要下哪些对象）
  const ai = json.assetIndex;
  let assetObjects = [];
  if (ai?.url) {
    const aiPath = path.join(assetsDir(), 'indexes', `${ai.id}.json`);
    report(onProgress, { stage: 'assets', percent: 0, text: '检查资源索引…' });
    // downloadFile 命中已有文件会直接返回，不会重复下载
    await downloadFile(candidateUrls(ai.url, mirror), aiPath, { sha1: ai.sha1, size: ai.size, retries: 3 });
    const index = JSON.parse(await fsp.readFile(aiPath, 'utf8'));
    assetObjects = Object.entries(index.objects ?? {}).map(([name, v]) => ({ name, hash: v.hash, size: v.size }));
  }

  // 4) assets objects
  if (!skipAssets && assetObjects.length) {
    const objDir = path.join(assetsDir(), 'objects');
    const missing = [];
    const scanTotal = assetObjects.length;
    let scanned = 0;
    for (const o of assetObjects) {
      const sub = o.hash.slice(0, 2);
      const dest = path.join(objDir, sub, o.hash);
      scanned += 1;
      // 几千个 existsSync 也要时间，期间别让界面停在 0%
      if (scanned % 500 === 0) {
        report(onProgress, {
          stage: 'assets', percent: Math.round((scanned / scanTotal) * 10),
          current: scanned, total: scanTotal,
          text: `检查资源完整性 ${scanned}/${scanTotal}`,
        });
      }
      if (fs.existsSync(dest)) continue;
      missing.push({ ...o, sub, dest });
    }
    if (missing.length) {
      const todo = missing.length;
      report(onProgress, { stage: 'assets', percent: 0, text: `下载 ${todo} 个资源文件…` });
      tasks.push(async () => {
        const jobs = missing.map((o) => async () => {
          const url = `https://resources.download.minecraft.net/${o.sub}/${o.hash}`;
          await downloadFile(candidateUrls(url, mirror), o.dest, { sha1: o.hash, size: o.size, retries: 2 });
        });
        await runPool(jobs, Math.max(8, cfg.downloadThreads || 12), (d, t) => {
          report(onProgress, { stage: 'assets', percent: 15 + Math.round((d / t) * 85), current: d, total: t, text: `资源文件 ${d}/${t}` });
        });
        // 复检：并发池里个别文件可能失败，单独串行补一次（官方源直连，最稳）
        const still = missing.filter((o) => !fs.existsSync(o.dest));
        for (const o of still) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await downloadFile([`https://resources.download.minecraft.net/${o.sub}/${o.hash}`], o.dest, {
                sha1: o.hash, size: o.size, retries: 1, connectTimeoutMs: 20000, idleMs: 20000,
              });
              break;
            } catch {
              await new Promise((r) => setTimeout(r, 500 + attempt * 800));
            }
          }
        }
        const failed = missing.filter(o => !fs.existsSync(o.dest));
        if (failed.length) throw new Error(`${failed.length} 个资源文件仍未下载完成，请重试`);
      });
    }
  }

  // 5) log4j 配置
  const logCfg = json.logging?.client;
  if (logCfg?.file?.url) {
    const dest = path.join(assetsDir(), 'log_configs', logCfg.file.id);
    if (!fs.existsSync(dest)) {
      tasks.push(async () => {
        await downloadFile(candidateUrls(logCfg.file.url, mirror), dest, { sha1: logCfg.file.sha1, size: logCfg.file.size, retries: 2 });
      });
    }
  }

  for (const t of tasks) await t();
  report(onProgress, { stage: 'done', percent: 100, text: `${id} 安装完成` });
  return { id, ok: true };
}

/** 只补全缺失文件（不重下已有） */
function parseLoaderId(id) {
  let m = /^(.+?)-forge-(.+)$/i.exec(id);
  if (m) return { kind: 'forge', mc: m[1], version: m[2] };
  m = /^(.+?)-neoforge-(.+)$/i.exec(id);
  if (m) return { kind: 'neoforge', mc: m[1], version: m[2] };
  m = /^fabric-loader-(.+)-(.+)$/i.exec(id);
  if (m) return { kind: 'fabric', version: m[1], mc: m[2] };
  return null;
}

// 修「文件存在但内容不完整」：先删半截 jar 再补下载；Forge/NeoForge 的补丁产物补不回来就重跑安装器
export async function repairVersion(id, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  let corrupt = [];
  try {
    const { findCorruptFiles } = await import('./launch.js');
    corrupt = findCorruptFiles(id);
  } catch {}

  if (corrupt.length) {
    onProgress({ phase: 'repair', text: `发现 ${corrupt.length} 个不完整文件，先删除再补` });
    for (const c of corrupt) {
      try {
        await fsp.rm(c.path, { force: true });
        onProgress({ phase: 'repair', text: `已删除 ${path.basename(c.path)}（${c.why}）` });
      } catch (e) {
        onProgress({ phase: 'repair', text: `删不掉 ${path.basename(c.path)}：${e.message}` });
      }
    }
  }

  let r = await installVersion(id, { ...opts, force: false });

  let stillBroken = [];
  try {
    const { findCorruptFiles, patchedClientJarPath } = await import('./launch.js');
    stillBroken = findCorruptFiles(id);
    const pj = patchedClientJarPath(id);
    if (pj && (!fs.existsSync(pj.path) || stillBroken.some((c) => c.path === pj.path))) {
      stillBroken = stillBroken.some((c) => c.path === pj.path)
        ? stillBroken
        : [...stillBroken, { path: pj.path, why: '缺失（安装器产物）', missing: true }];
    }
  } catch {}
  const patched = stillBroken.filter((c) => /libraries[\\/]net[\\/]minecraft[\\/]/i.test(c.path));
  if (patched.length) {
    const parsed = parseLoaderId(id);
    if (parsed) {
      onProgress({ phase: 'repair', text: `补丁 jar 缺失，重跑 ${parsed.kind} 安装器（${parsed.mc} / ${parsed.version}）` });
      try {
        const { installLoader } = await import('./loaders.js');
        await installLoader({ kind: parsed.kind, mc: parsed.mc, version: parsed.version, onProgress });
        const { findCorruptFiles } = await import('./launch.js');
        stillBroken = findCorruptFiles(id);
      } catch (e) {
        onProgress({ phase: 'repair', text: `重跑安装器失败：${e.message}` });
      }
    } else {
      onProgress({ phase: 'repair', text: '补丁 jar 缺失，但认不出是哪个加载器版本，只能手动重装' });
    }
  }

  return { ...r, repaired: corrupt.length, stillBroken: stillBroken.length };
}

export async function deleteVersion(id) {
  const dir = versionDir(id);
  if (!fs.existsSync(dir)) return { ok: true, removed: false };
  await fsp.rm(dir, { recursive: true, force: true });
  return { ok: true, removed: true };
}
