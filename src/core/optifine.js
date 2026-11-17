// OptiFine：从 BMCLAPI 列版本，并作为模组装进 Forge / NeoForge 版本
// 1.13 之后 OptiFine 官方就是「一个 mod」；纯净版才需要运行安装器改 jar。
// 本项目只做前者（可靠、可回滚、不动 jar），原版会明确提示先装 Forge。

import fs from 'node:fs';
import path from 'node:path';
import { gameDirFor } from './config.js';
import { listLocalVersions } from './version.js';

const MIRROR = 'https://bmclapi2.bangbang93.com';

function http(url) {
  return fetch(url, { signal: AbortSignal.timeout(120000) });
}

/** 从版本 id / 继承链里猜 MC 版本号 */
export function mcVersionOf(versionId) {
  const all = listLocalVersions();
  const seen = new Set();
  let cur = all.find((v) => v.id === versionId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const m = String(cur.id).match(/(\d+\.\d+(?:\.\d+)?)/);
    if (m) return m[1];
    cur = all.find((v) => v.id === cur.inheritsFrom);
  }
  const m2 = String(versionId).match(/(\d+\.\d+(?:\.\d+)?)/);
  return m2 ? m2[1] : '';
}

/** 列出某个 MC 版本下所有 OptiFine 构建 */
export async function listOptifine(mcVersion) {
  if (!/^\d+\.\d+(\.\d+)?$/.test(String(mcVersion || ''))) {
    throw new Error('MC 版本号不合法：' + mcVersion);
  }
  const r = await http(`${MIRROR}/optifine/${encodeURIComponent(mcVersion)}`);
  if (!r.ok) throw new Error(`获取 OptiFine 列表失败（HTTP ${r.status}）`);
  const arr = await r.json();
  if (!Array.isArray(arr)) throw new Error('OptiFine 列表格式异常');
  return arr
    .filter((x) => x && x.filename && x.patch)
    .map((x) => ({
      type: x.type || 'HD_U',
      patch: String(x.patch),
      filename: x.filename,
      forge: x.forge || '',
      label: /pre/i.test(String(x.patch)) ? `OptiFine ${x.type || 'HD_U'} ${x.patch}（预览）` : `OptiFine ${x.type || 'HD_U'} ${x.patch}`,
      url: `${MIRROR}/optifine/${encodeURIComponent(mcVersion)}/${encodeURIComponent(x.type || 'HD_U')}/${encodeURIComponent(x.patch)}`,
    }))
    .sort((a, b) => {
      const pa = /pre/i.test(a.patch) ? 1 : 0;
      const pb = /pre/i.test(b.patch) ? 1 : 0;
      if (pa !== pb) return pa - pb;
      return String(b.patch).localeCompare(String(a.patch), 'en', { numeric: true });
    });
}

/** 目标版本能不能直接塞 OptiFine（必须有 Forge / NeoForge） */
export function optifineCompat(versionId) {
  const v = listLocalVersions().find((x) => x.id === versionId);
  if (!v) return { ok: false, reason: '找不到这个版本' };
  const loader = String(v.loader || '').toLowerCase();
  const mc = mcVersionOf(versionId);
  if (loader === 'forge' || loader === 'neoforge') return { ok: true, mc, loader };
  if (loader === 'fabric') {
    return {
      ok: false,
      mc,
      loader,
      reason: 'Fabric 需要 OptiFabric 才能跑 OptiFine，本启动器暂不代装；建议改用 Forge 版本',
    };
  }
  return {
    ok: false,
    mc,
    loader,
    reason: `「${versionId}」是原版版本。1.13 之后 OptiFine 以 mod 形式工作，需要先装 Forge 或 NeoForge`,
  };
}

function modsDirOf(versionId) {
  return path.join(gameDirFor(versionId), 'mods');
}

/** 安装：下载 OptiFine jar 到该版本的 mods/ */
export async function installOptifine(versionId, { type, patch }, onProgress) {
  const compat = optifineCompat(versionId);
  if (!compat.ok) throw new Error(compat.reason);
  const list = await listOptifine(compat.mc);
  const want = { type: type || 'HD_U', patch: String(patch) };
  const hit = list.find((x) => x.type === want.type && x.patch === want.patch);
  if (!hit) throw new Error(`没找到 OptiFine ${want.type} ${want.patch}（MC ${compat.mc}）`);

  const dir = modsDirOf(versionId);
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, hit.filename);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100000) {
    return { ok: true, skipped: true, file: dest, size: fs.statSync(dest).size, label: hit.label };
  }

  const r = await http(hit.url);
  if (!r.ok) throw new Error(`下载 OptiFine 失败（HTTP ${r.status}）`);
  const total = Number(r.headers.get('content-length') || 0);
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let last = 0;
  for await (const chunk of r.body) {
    out.write(chunk);
    got += chunk.length;
    const now = Date.now();
    if (onProgress && now - last > 200) {
      last = now;
      onProgress({ got, total, pct: total ? Math.round((got / total) * 100) : 0 });
    }
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  if (got < 100000) {
    await fs.promises.rm(tmp, { force: true });
    throw new Error(`下载内容过小（${got} B），可能不是有效的 OptiFine 包`);
  }
  await fs.promises.rename(tmp, dest);
  if (onProgress) onProgress({ got, total: total || got, pct: 100 });
  return { ok: true, skipped: false, file: dest, size: got, label: hit.label };
}

/** 这个版本里已装了哪些 OptiFine */
export function installedOptifine(versionId) {
  const dir = modsDirOf(versionId);
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /^OptiFine.*\.jar$/i.test(n))
      .map((n) => ({ name: n, size: fs.statSync(path.join(dir, n)).size }));
  } catch {
    return [];
  }
}
