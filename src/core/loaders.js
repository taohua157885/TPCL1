// 模组加载器（Forge / NeoForge / Fabric）安装
//
// 设计要点（2026-11 实测）：
//  - maven.neoforged.net 在本机 TCP 直连超时，GitHub 下载也超时；
//    只有 BMCLAPI 的 /maven 通道能取到 neoforged 构件。
//  - 因此**不运行**官方 installer（它内部写死官方 maven，会卡死），
//    而是从 installer jar 里取出 version.json，交给 installVersion()
//    用我们自己的镜像管线下载库文件。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, loadConfig } from './config.js';
import { ensureDir, downloadFile, runPool } from './download.js';
import { versionDir, versionJsonPath, readVersionJsonRaw, librariesDir } from './version.js';
import { scanJavas, pickJava, downloadJava } from './java.js';
import { installVersion } from './installer.js';
import { candidateUrls } from './mirror.js';

const CACHE = path.join(DATA_DIR, 'cache');
const BMCL = 'https://bmclapi2.bangbang93.com';
const FORGE_MAVEN = 'https://maven.minecraftforge.net';
const NEO_MAVEN = 'https://maven.neoforged.net/releases';
const FABRIC_META = 'https://meta.fabricmc.net';
const QUILT_META = 'https://meta.quiltmc.org';
const TAR = 'C:/Windows/System32/tar.exe';

// ---------- 通用抓取（带磁盘缓存） ----------

async function fetchText(urls, cacheName, ttlMs = 6 * 3600 * 1000) {
  await ensureDir(CACHE);
  const file = path.join(CACHE, cacheName);
  try {
    const st = await fsp.stat(file);
    if (Date.now() - st.mtimeMs < ttlMs) return await fsp.readFile(file, 'utf8');
  } catch {}
  const list = Array.isArray(urls) ? urls : [urls];
  let lastErr;
  for (const u of list) {
    // BMCLAPI 偶尔 ECONNRESET，重试几次比直接放弃划算
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(u, {
          headers: { 'user-agent': 'TPCL/1.0' },
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        await fsp.writeFile(file, text, 'utf8');
        return text;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 + attempt * 700));
      }
    }
  }
  throw new Error(`获取失败：${lastErr?.message ?? '未知错误'}`);
}

async function fetchJson(urls, cacheName, ttlMs) {
  return JSON.parse(await fetchText(urls, cacheName, ttlMs));
}

function parseXmlVersions(xml) {
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1].trim());
}

/** 版本号排序：段式比较，数字段按数值比 */
function cmpVer(a, b) {
  const pa = a.split(/[.\-+_]/);
  const pb = b.split(/[.\-+_]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---------- Forge ----------

export async function listForge(mc) {
  const xml = await fetchText(
    [`${BMCL}/maven/net/minecraftforge/forge/maven-metadata.xml`, `${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`],
    'forge-maven.xml',
  );
  const all = parseXmlVersions(xml)
    .filter((v) => v.startsWith(mc + '-'))
    .map((v) => v.slice(mc.length + 1));
  let promos = {};
  try {
    const j = await fetchJson(
      ['https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'],
      'forge-promos.json',
      30 * 60 * 1000,
    );
    promos = j.promos || {};
  } catch {}
  const list = [...new Set(all)].sort(cmpVer).reverse();
  return {
    loader: 'forge',
    mc,
    versions: list,
    recommended: promos[`${mc}-recommended`] ?? list[0] ?? null,
    latest: promos[`${mc}-latest`] ?? list[0] ?? null,
  };
}

// ---------- NeoForge ----------

/** NeoForge 版本前缀：1.21.1→"21.1"；26.3→"26.3"；26.1.2→"26.1.2" */
function neoPrefixFor(mc) {
  const p = mc.split('.');
  if (Number(p[0]) === 1) return `${Number(p[1] ?? 0)}.${Number(p[2] ?? 0)}`;
  return mc;
}

export async function listNeoForge(mc) {
  const legacy = mc === '1.20.1';
  const groupPath = legacy ? 'net/neoforged/forge' : 'net/neoforged/neoforge';
  const xml = await fetchText(
    [`${BMCL}/maven/${groupPath}/maven-metadata.xml`, `${NEO_MAVEN}/${groupPath}/maven-metadata.xml`],
    legacy ? 'neoforge-forge-maven.xml' : 'neoforge-maven.xml',
  );
  let all = parseXmlVersions(xml);
  if (legacy) all = all.filter((v) => v.startsWith(mc + '-')).map((v) => v.slice(mc.length + 1));
  else {
    const pre = neoPrefixFor(mc);
    all = all.filter((v) => v === pre || v.startsWith(pre + '.'));
  }
  const list = [...new Set(all)].sort(cmpVer).reverse();
  return { loader: 'neoforge', mc, versions: list, recommended: list[0] ?? null, latest: list[0] ?? null };
}

// ---------- Fabric ----------

export async function listFabric(mc) {
  const arr = await fetchJson(
    [`${BMCL}/fabric-meta/v2/versions/loader/${encodeURIComponent(mc)}`, `${FABRIC_META}/v2/versions/loader/${encodeURIComponent(mc)}`],
    `fabric-${mc}.json`,
    30 * 60 * 1000,
  );
  const versions = (Array.isArray(arr) ? arr : [])
    .map((x) => ({ version: x?.loader?.version, stable: !!x?.loader?.stable }))
    .filter((x) => x.version);
  const stable = versions.find((v) => v.stable) ?? versions[0] ?? null;
  const ordered = [...versions.filter((v) => v.stable), ...versions.filter((v) => !v.stable)];
  return {
    loader: 'fabric',
    mc,
    versions: ordered.map((v) => v.version),
    recommended: stable?.version ?? null,
    latest: versions[0]?.version ?? null,
    stableFlags: versions,
  };
}

export async function listQuilt(mc) {
  const arr = await fetchJson(
    [`${BMCL}/quilt-meta/v3/versions/loader/${encodeURIComponent(mc)}`, `${QUILT_META}/v3/versions/loader/${encodeURIComponent(mc)}`],
    `quilt-${mc}.json`,
    30 * 60 * 1000,
  );
  const versions = (Array.isArray(arr) ? arr : [])
    .map((x) => ({ version: x?.loader?.version }))
    .filter((x) => x.version);
  // Quilt 不给 stable 字段，按语义化预发布后缀判断
  versions.sort((a, b) => cmpVer(b.version, a.version));
  const stableVersions = versions.filter((v) => !/-(beta|pre|alpha|rc)/i.test(v.version));
  const ordered = [...stableVersions, ...versions.filter((v) => /-(beta|pre|alpha|rc)/i.test(v.version))];
  const stable = stableVersions[0] ?? versions[0] ?? null;
  return {
    loader: 'quilt',
    mc,
    versions: ordered.map((v) => v.version),
    recommended: stable?.version ?? null,
    latest: ordered[0]?.version ?? null,
  };
}

export async function listLoaders(kind, mc) {
  if (kind === 'forge') return listForge(mc);
  if (kind === 'neoforge') return listNeoForge(mc);
  if (kind === 'fabric') return listFabric(mc);
  if (kind === 'quilt') return listQuilt(mc);
  throw new Error('未知加载器 ' + kind);
}

// ---------- 工具 ----------

function mcDir() {
  return loadConfig().mcDir;
}

async function ensureLauncherProfiles(dir) {
  const f = path.join(dir, 'launcher_profiles.json');
  if (!fs.existsSync(f)) {
    await fsp.writeFile(f, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2), 'utf8');
  }
}

const JAVA_FALLBACK = (mc) => {
  const p = mc.split('.').map((n) => Number(n));
  if (p[0] >= 26) return 25;
  if (p[0] === 1 && p[1] > 20) return 21;
  if (p[0] === 1 && p[1] === 20 && (p[2] ?? 0) >= 5) return 21;
  if (p[0] === 1 && p[1] >= 17) return 17;
  return 8;
};

async function requiredJava(mc) {
  try {
    const j = readVersionJsonRaw(mc);
    const major = j?.javaVersion?.majorVersion;
    if (major) return Number(major);
  } catch {}
  return JAVA_FALLBACK(mc);
}

async function resolveJava(major, onProgress) {
  let list = await scanJavas();
  let picked = pickJava(list, major);
  if (picked) return picked.path;
  onProgress({ stage: 'java', percent: 0, text: `缺少 Java ${major}，正在下载…` });
  await downloadJava(major, (p) => onProgress({ stage: 'java', ...p }));
  list = await scanJavas(true);
  picked = pickJava(list, major);
  if (!picked) throw new Error(`Java ${major} 准备失败`);
  return picked.path;
}

function runProcess(exe, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn(exe, args, { cwd: opts.cwd, windowsHide: true, env: { ...process.env } });
    } catch (e) {
      resolve({ code: -1, out: String(e) });
      return;
    }
    const onData = (buf) => {
      const s = String(buf);
      out += s;
      if (out.length > 200000) out = out.slice(-120000);
      opts.onData?.(s);
    };
    p.stdout?.on('data', onData);
    p.stderr?.on('data', onData);
    p.on('error', (e) => resolve({ code: -1, out: out + '\n' + e.message }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

/** 从 installer jar 里取出 version.json（bsdtar 能直接读 zip） */
async function extractProfile(jarPath) {
  const tmp = path.join(CACHE, 'tmp', 'ex-' + Date.now());
  await ensureDir(tmp);
  const r = await runProcess(TAR, ['-xf', jarPath, '-C', tmp, 'version.json'], {});
  const p = path.join(tmp, 'version.json');
  if (!fs.existsSync(p)) throw new Error('安装器里没有 version.json：' + (r.out || '').slice(0, 200));
  const text = await fsp.readFile(p, 'utf8');
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  return JSON.parse(text);
}

/** 读取安装器里的 install_profile.json（Forge/NeoForge 处理器清单） */
async function readInstallProfile(jarPath) {
  const tmp = path.join(CACHE, 'tmp', 'ip-' + Date.now());
  await ensureDir(tmp);
  await runProcess(TAR, ['-xf', jarPath, '-C', tmp, 'install_profile.json'], {});
  const p = path.join(tmp, 'install_profile.json');
  if (!fs.existsSync(p)) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return null;
  }
  const text = await fsp.readFile(p, 'utf8');
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  return JSON.parse(text);
}

/** "group:artifact:version[:classifier][@ext]" → 各段 */
function mavenCoords(name) {
  let rest = String(name || '').trim();
  let ext = 'jar';
  const at = rest.indexOf('@');
  if (at >= 0) {
    ext = rest.slice(at + 1) || 'jar';
    rest = rest.slice(0, at);
  }
  const parts = rest.split(':');
  if (parts.length < 3) return null;
  const [group, artifact, version, classifier] = parts;
  return { group, artifact, version, classifier: classifier || '', ext };
}

function mavenRelPath(c) {
  const dir = c.group.replace(/\./g, '/');
  const file = `${c.artifact}-${c.version}${c.classifier ? '-' + c.classifier : ''}.${c.ext}`;
  return `${dir}/${c.artifact}/${c.version}/${file}`;
}

/**
 * 提前把安装器自己要用的库塞进 libraries/。
 * 原因：NeoForge 安装器会去 maven.neoforged.net 拉自己的处理器依赖，
 * 而该域名在本机不可达（TCP 超时）。文件已存在时安装器会直接跳过下载。
 */
async function prefetchInstallerLibs(profile, onProgress) {
  if (!profile) return 0;
  const names = new Set();
  for (const lib of profile.libraries || []) if (lib.name) names.add(lib.name);
  for (const pr of profile.processors || []) {
    if (pr.jar) names.add(pr.jar);
    for (const c of pr.classpath || []) names.add(c);
  }

  const jobs = [];
  for (const name of names) {
    const c = mavenCoords(name);
    if (!c) continue;
    const rel = mavenRelPath(c);
    const dest = path.join(librariesDir(), rel);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    jobs.push({ rel, dest });
  }
  if (!jobs.length) return 0;

  onProgress({ stage: 'prefetch', percent: 0, text: `预置安装器依赖 ${jobs.length} 个…` });
  let done = 0;
  await runPool(
    jobs.map((j) => async () => {
      const urls = [
        `${BMCL}/maven/${j.rel}`,
        `https://maven.aliyun.com/repository/public/${j.rel}`,
        `https://repo1.maven.org/maven2/${j.rel}`,
        `https://libraries.minecraft.net/${j.rel}`,
        `${NEO_MAVEN}/${j.rel}`,
        `${FORGE_MAVEN}/${j.rel}`,
      ];
      try {
        await ensureDir(path.dirname(j.dest));
        await downloadFile(urls, j.dest, { retries: 2, connectTimeoutMs: 20000, idleMs: 25000 });
      } catch {
        // 单个失败不阻断，安装器会自己再试
      }
      done += 1;
      onProgress({
        stage: 'prefetch',
        percent: Math.round((done / jobs.length) * 100),
        text: `预置安装器依赖 ${done}/${jobs.length}`,
      });
    }),
    8,
  );
  return jobs.length;
}

async function writeProfile(id, profile) {
  const vd = versionDir(id);
  await ensureDir(vd);
  await fsp.writeFile(versionJsonPath(id), JSON.stringify(profile, null, 2), 'utf8');
  return id;
}

/**
 * 运行官方安装器生成“打过补丁的客户端”（Forge 的 -client.jar 无法下载，
 * 必须由 binarypatcher 本地生成：反混淆 → 打补丁）。
 * 库文件我们已经用镜像提前下载好，安装器只会补少量自身构件。
 */
async function runInstaller(jarPath, mc, onProgress) {
  const dir = mcDir();
  await ensureLauncherProfiles(dir);
  const major = await requiredJava(mc);
  const javaPath = await resolveJava(major, onProgress);
  onProgress({ stage: 'patch', percent: 0, text: '运行安装器生成补丁客户端（首次约 1 分钟）…' });
  const r = await runProcess(javaPath, ['-Djava.awt.headless=true', '-jar', jarPath, '--installClient', dir], {
    cwd: dir,
    onData: (s) => {
      const line = String(s).replace(/\s+/g, ' ').trim();
      if (line) onProgress({ stage: 'patch', percent: 0, text: line.slice(0, 160) });
    },
  });
  if (r.code !== 0) {
    const tail = String(r.out || '').split(/\r?\n/).filter(Boolean).slice(-6).join(' / ');
    throw new Error(`安装器执行失败（退出码 ${r.code}）：${tail.slice(0, 400)}`);
  }
  return r;
}

// ---------- 安装 ----------

export async function installLoader({ kind, mc, version, onProgress = () => {} }) {
  if (!kind || !mc) throw new Error('缺少参数');

  // 1) 原版必须先装好
  const vanillaJson = path.join(versionDir(mc), mc + '.json');
  if (!fs.existsSync(vanillaJson)) {
    onProgress({ stage: 'vanilla', percent: 0, text: `先安装原版 ${mc}…` });
    await installVersion(mc, { onProgress: (p) => onProgress({ stage: 'vanilla', ...p }) });
  }

  let profile = null;
  let id = null;
  let installerJar = null;
  let installProfile = null;

  if (kind === 'fabric' || kind === 'quilt') {
    const isQuilt = kind === 'quilt';
    if (!version) throw new Error(`缺少 ${isQuilt ? 'Quilt' : 'Fabric'} Loader 版本`);
    const label = isQuilt ? 'Quilt' : 'Fabric';
    onProgress({ stage: 'meta', percent: 0, text: `获取 ${label} ${version} 配置…` });
    const metaBase = isQuilt ? 'quilt-meta/v3' : 'fabric-meta/v2';
    const remoteBase = isQuilt ? QUILT_META + '/v3' : FABRIC_META + '/v2';
    profile = await fetchJson(
      [
        `${BMCL}/${metaBase}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(version)}/profile/json`,
        `${remoteBase}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(version)}/profile/json`,
      ],
      `${isQuilt ? 'quilt' : 'fabric'}-profile-${mc}-${version}.json`,
      3600 * 1000,
    );
    id = profile.id || `${isQuilt ? 'quilt' : 'fabric'}-loader-${version}-${mc}`;
  } else {
    if (!version) throw new Error(`缺少 ${kind} 版本`);
    const label =
      kind === 'forge'
        ? `${mc}-forge-${version}`
        : mc === '1.20.1'
          ? `${mc}-neoforge-${version}`
          : `${mc}-neoforge-${version}`;
    const jarUrl =
      kind === 'forge'
        ? `${FORGE_MAVEN}/net/minecraftforge/forge/${mc}-${version}/forge-${mc}-${version}-installer.jar`
        : mc === '1.20.1'
          ? `${NEO_MAVEN}/net/neoforged/forge/${mc}-${version}/forge-${mc}-${version}-installer.jar`
          : `${NEO_MAVEN}/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;

    await ensureDir(path.join(CACHE, 'installers'));
    const jarPath = path.join(CACHE, 'installers', path.basename(jarUrl));
    const dlTotal = { v: 0 };
    const dlGot = { v: 0 };
    onProgress({ stage: 'download', percent: 0, text: `下载 ${label} 安装包…` });
    const dlTimer = setInterval(() => {
      const pct = dlTotal.v ? Math.min(99, Math.round((dlGot.v / dlTotal.v) * 100)) : 0;
      onProgress({
        stage: 'download',
        percent: pct,
        text: `下载 ${label} 安装包 ${(dlGot.v / 1048576).toFixed(1)} MB` + (dlTotal.v ? ` / ${(dlTotal.v / 1048576).toFixed(1)} MB` : ''),
      });
    }, 700);
    try {
      await downloadFile(candidateUrls(jarUrl, 'bmclapi'), jarPath, {
        retries: 3,
        connectTimeoutMs: 25000,
        idleMs: 30000,
        onBytes: (n, total) => {
          dlGot.v += n;
          if (total) dlTotal.v = total;
        },
      });
    } finally {
      clearInterval(dlTimer);
    }

    onProgress({ stage: 'extract', percent: 0, text: '读取加载器描述文件…' });
    profile = await extractProfile(jarPath);
    id = profile.id || label;
    installerJar = jarPath;
    installProfile = await readInstallProfile(jarPath);
  }

  await writeProfile(id, profile);
  onProgress({ stage: 'libraries', percent: 0, text: `下载 ${id} 的依赖库…` });

  // 交给统一管线：合并 inheritsFrom、按镜像下载库与资源
  await installVersion(id, {
    skipAssets: false,
    onProgress: (p) => onProgress({ stage: 'libraries', ...p }),
  });

  // Forge / NeoForge 还需要安装器本地生成 -client.jar
  if (installerJar) {
    // 先把安装器自己的处理器依赖放好，避免它去连不通的 maven.neoforged.net
    await prefetchInstallerLibs(installProfile, onProgress);
    await runInstaller(installerJar, mc, onProgress);
  }

  onProgress({ stage: 'done', percent: 100, text: `${id} 已就绪`, id });
  return { ok: true, id, loader: kind, version };
}
