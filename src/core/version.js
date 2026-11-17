import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';

export const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
export const OS_ARCH = process.arch === 'ia32' ? 'x86' : process.arch === 'arm64' ? 'arm64' : 'x64';

export function versionsDir() {
  return path.join(loadConfig().mcDir, 'versions');
}

export function librariesDir() {
  return path.join(loadConfig().mcDir, 'libraries');
}

export function assetsDir() {
  return path.join(loadConfig().mcDir, 'assets');
}

export function versionDir(id) {
  return path.join(versionsDir(), id);
}

export function versionJsonPath(id) {
  return path.join(versionDir(id), `${id}.json`);
}

export function readVersionJsonRaw(id) {
  const p = versionJsonPath(id);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 扫描本地已安装版本 */
export function listLocalVersions() {
  const dir = versionsDir();
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const id = e.name;
    const jsonPath = path.join(dir, id, `${id}.json`);
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const jarPath = path.join(dir, id, `${id}.jar`);
      const jarName = j.jar ? `${j.jar}.jar` : `${id}.jar`;
      const jarFull = path.join(dir, id, jarName);
      out.push({
        id,
        type: j.type ?? 'unknown',
        inheritsFrom: j.inheritsFrom ?? null,
        releaseTime: j.releaseTime ?? '',
        javaMajor: j.javaVersion?.majorVersion ?? null,
        loader: detectLoader(id, j),
        hasJar: fs.existsSync(jarFull),
        jarSize: fs.existsSync(jarFull) ? fs.statSync(jarFull).size : 0,
        mtime: fs.statSync(jsonPath).mtimeMs,
      });
    } catch (e) {
      out.push({ id, type: 'broken', error: e.message, hasJar: false, jarSize: 0, mtime: 0 });
    }
  }
  out.sort((a, b) => (b.releaseTime || '').localeCompare(a.releaseTime || '') || a.id.localeCompare(b.id));
  return out;
}

export function detectLoader(id, json) {
  const s = `${id} ${json?.mainClass ?? ''}`.toLowerCase();
  if (s.includes('neoforge')) return 'NeoForge';
  if (s.includes('forge')) return 'Forge';
  if (s.includes('fabric')) return 'Fabric';
  if (s.includes('quilt')) return 'Quilt';
  if (s.includes('optifine')) return 'OptiFine';
  return '原版';
}

/** 解析库坐标 group:artifact:version[:classifier][@ext] */
export function parseLibName(name) {
  let rest = name;
  let ext = 'jar';
  const at = rest.lastIndexOf('@');
  if (at > 0) {
    ext = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const parts = rest.split(':');
  const [group = '', artifact = '', version = '', classifier = ''] = parts;
  return { group, artifact, version, classifier, ext, raw: name };
}

function osMatches(rule) {
  if (!rule?.os) return true;
  const { name, arch, version } = rule.os;
  if (name && name !== OS_NAME) return false;
  if (arch && arch !== OS_ARCH) return false;
  if (version) {
    try {
      if (!new RegExp(version).test(require_os_release())) return false;
    } catch { /* 忽略非法正则 */ }
  }
  return true;
}

let _osRelease = null;
function require_os_release() {
  if (_osRelease === null) {
    try {
      const cfg = loadConfig();
      const rel = path.join(cfg.mcDir, 'runtime');
      _osRelease = process.getSystemVersion?.() ?? '';
    } catch { _osRelease = ''; }
  }
  return _osRelease;
}

export function rulesAllow(rules, features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allow = false;
  for (const r of rules) {
    let match = osMatches(r);
    if (match && r.features) {
      for (const [k, v] of Object.entries(r.features)) {
        if (Boolean(features[k]) !== Boolean(v)) { match = false; break; }
      }
    }
    if (match) allow = r.action === 'allow';
  }
  return allow;
}

/** 递归合并 inheritsFrom 链（子版本覆盖父版本） */
export function resolveVersion(id, depth = 0) {
  if (depth > 12) throw new Error(`版本继承链过深：${id}`);
  let json;
  try {
    json = readVersionJsonRaw(id);
  } catch {
    const missing = new Error(`缺少版本 JSON：${id}`);
    missing.code = 'MISSING_PARENT';
    missing.versionId = id;
    throw missing;
  }
  if (!json.inheritsFrom) return { id, json, chain: [id] };

  const parent = resolveVersion(json.inheritsFrom, depth + 1);
  const merged = mergeVersionJson(parent.json, json);
  return { id, json: merged, chain: [id, ...parent.chain] };
}

export function mergeVersionJson(parent, child) {
  const out = { ...parent, ...child };
  out.id = child.id ?? parent.id;

  // libraries：子在前，父在后，按坐标去重
  const libs = [];
  const seen = new Set();
  for (const lib of [...(child.libraries ?? []), ...(parent.libraries ?? [])]) {
    const key = libKey(lib);
    if (seen.has(key)) continue;
    seen.add(key);
    libs.push(lib);
  }
  out.libraries = libs;

  // arguments：父在前，子在后
  const pa = normalizeArgs(parent.arguments);
  const ca = normalizeArgs(child.arguments);
  if (pa || ca) {
    out.arguments = {
      game: [...(pa?.game ?? []), ...(ca?.game ?? [])],
      jvm: [...(pa?.jvm ?? []), ...(ca?.jvm ?? [])],
    };
  } else {
    out.minecraftArguments = [parent.minecraftArguments, child.minecraftArguments].filter(Boolean).join(' ');
  }
  return out;
}

function normalizeArgs(a) {
  if (a && !Array.isArray(a) && typeof a === 'object') return { game: a.game ?? [], jvm: a.jvm ?? [] };
  return null;
}

export function libKey(lib) {
  if (lib.name) {
    const n = parseLibName(lib.name);
    return `${n.group}:${n.artifact}:${n.classifier}:${n.ext}`;
  }
  return lib.downloads?.artifact?.path ?? JSON.stringify(lib).slice(0, 80);
}

/**
 * 按 classifier 的架构后缀过滤（部分启动器合并后的 JSON 丢失了 os.arch 规则，
 * 会把 arm64 / x86 的本地库也带进来，必须在这里再挡一层）
 */
export function libArchAllowed(lib) {
  if (!lib?.name) return true;
  const n = parseLibName(lib.name);
  const c = n.classifier || '';
  if (/-arm64$/.test(c)) return OS_ARCH === 'arm64';
  if (/-x86$/.test(c)) return OS_ARCH === 'x86';
  return true;
}

/** 库的分类：普通 / 原生 */
export function classifyLibrary(lib) {
  const nativesKey = lib.natives?.[OS_NAME];
  if (nativesKey) return 'native';
  if (lib.name) {
    const n = parseLibName(lib.name);
    if (n.classifier && n.classifier.startsWith('natives')) return 'native';
    if (lib.downloads?.classifiers && Object.keys(lib.downloads.classifiers).some((k) => k.startsWith('natives'))) return 'native';
  }
  return 'jar';
}

export function libraryArtifactPath(lib) {
  if (lib.downloads?.artifact?.path) return lib.downloads.artifact.path;
  const n = parseLibName(lib.name);
  const parts = n.group.split('.').concat(n.artifact, n.version);
  const file = `${n.artifact}-${n.version}${n.classifier ? '-' + n.classifier : ''}.${n.ext}`;
  return [...parts, file].join('/');
}

export function libraryUrl(lib, mirrorFn) {
  const art = lib.downloads?.artifact;
  if (art?.url) return mirrorFn ? mirrorFn(art.url) : art.url;
  const p = libraryArtifactPath(lib);
  const u = `https://libraries.minecraft.net/${p}`;
  return mirrorFn ? mirrorFn(u) : u;
}

export function nativeArtifact(lib) {
  const key = lib.natives?.[OS_NAME]?.replace('${arch}', OS_ARCH === 'x64' ? '64' : '32');
  if (key && lib.downloads?.classifiers?.[key]) return lib.downloads.classifiers[key];
  if (lib.downloads?.classifiers) {
    const found = Object.keys(lib.downloads.classifiers).find((k) => k.includes(`natives-${OS_NAME}`));
    if (found) return lib.downloads.classifiers[found];
  }
  if (lib.name) {
    const n = parseLibName(lib.name);
    if (n.classifier?.startsWith('natives')) {
      const parts = n.group.split('.').concat(n.artifact, n.version);
      const file = `${n.artifact}-${n.version}-${n.classifier}.${n.ext}`;
      return { path: [...parts, file].join('/'), url: `https://libraries.minecraft.net/${[...parts, file].join('/')}`, size: 0, sha1: '' };
    }
  }
  return null;
}
