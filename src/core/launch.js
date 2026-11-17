import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { loadConfig, gameDirFor, DATA_DIR } from './config.js';
import { applyConfiguredLanguage } from './gamelang.js';
import { setGpuPreference } from './gpu.js';
import {
  resolveVersion, rulesAllow, versionDir, librariesDir, assetsDir,
  libraryArtifactPath, libraryUrl, classifyLibrary, nativeArtifact, libKey, OS_NAME, libArchAllowed,
  readVersionJsonRaw,
} from './version.js';
import { toMirror } from './mirror.js';
import { scanJavas, pickJava } from './java.js';
import { ensureDir } from './download.js';
import { createLogCleaner } from './logfmt.js';

export const bus = new EventEmitter();

const LAUNCHER_NAME = 'TPCL';
const LAUNCHER_VERSION = '1.0.0';

function offlineUuid(name) {
  // Java 版离线 UUID：name -> 固定 UUID（与主流启动器一致的做法）
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function flattenArg(entry, features) {
  if (typeof entry === 'string') return [entry];
  if (Array.isArray(entry)) return entry.flatMap((e) => flattenArg(e, features));
  if (entry && typeof entry === 'object') {
    if (!rulesAllow(entry.rules, features)) return [];
    const v = entry.value;
    return Array.isArray(v) ? v : v === undefined ? [] : [v];
  }
  return [];
}

function expand(tokens, vars) {
  return tokens.map((t) =>
    String(t).replace(/\$\{([^}]+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)),
  );
}

export function isModernNatives(json) {
  const jvm = json.arguments?.jvm ?? [];
  return jvm.some((e) => typeof e === 'string' && e.includes('SharedLibraryExtractPath'));
}

export function clientJarPath(id, json) {
  const jarName = json.jar ? `${json.jar}.jar` : `${id}.jar`;
  const own = path.join(versionDir(id), jarName);
  if (fs.existsSync(own)) return own;
  if (json.jar) {
    const inherited = path.join(versionDir(json.jar), `${json.jar}.jar`);
    if (fs.existsSync(inherited)) return inherited;
  }
  // 加载器版本（Forge/NeoForge/Fabric）没有自己的 jar，真正的客户端主文件在父版本目录里
  let cur = json;
  const seen = new Set([id]);
  while (cur?.inheritsFrom && !seen.has(cur.inheritsFrom)) {
    seen.add(cur.inheritsFrom);
    const cand = path.join(versionDir(cur.inheritsFrom), `${cur.inheritsFrom}.jar`);
    if (fs.existsSync(cand)) return cand;
    try {
      cur = readVersionJsonRaw(cur.inheritsFrom);
    } catch {
      break;
    }
  }
  return own;
}

/** 收集该版本需要的库文件（含 native） */
export function collectLibraries(json, features = {}) {
  const out = { jars: [], natives: [] };
  const seen = new Set();
  for (const lib of json.libraries ?? []) {
    if (!rulesAllow(lib.rules, features)) continue;
    if (!libArchAllowed(lib)) continue;
    const kind = classifyLibrary(lib);
    const p = libraryArtifactPath(lib);
    const url = lib.downloads?.artifact?.url ?? `https://libraries.minecraft.net/${p}`;
    const entry = {
      key: libKey(lib),
      name: lib.name,
      relPath: p,
      fullPath: path.join(librariesDir(), p),
      url,
      size: lib.downloads?.artifact?.size ?? 0,
      sha1: lib.downloads?.artifact?.sha1 ?? '',
      kind,
    };
    if (kind === 'native' && !isModernNatives(json)) {
      const nat = nativeArtifact(lib);
      if (nat) {
        if (seen.has(nat.path)) continue;
        seen.add(nat.path);
        out.natives.push({
          key: `${entry.key}:native`,
          fullPath: path.join(librariesDir(), nat.path),
          relPath: nat.path,
          url: nat.url,
          size: nat.size ?? 0,
          sha1: nat.sha1 ?? '',
        });
        continue;
      }
    }
    if (seen.has(p)) continue;
    seen.add(p);
    out.jars.push(entry);
  }
  return out;
}

export function assetIndexInfo(json) {
  const ai = json.assetIndex;
  if (!ai) return null;
  return {
    id: ai.id,
    url: ai.url,
    sha1: ai.sha1,
    size: ai.size ?? 0,
    totalSize: ai.totalSize ?? 0,
    indexPath: path.join(assetsDir(), 'indexes', `${ai.id}.json`),
  };
}

export function logConfigInfo(json) {
  const c = json.logging?.client;
  if (!c?.file?.url) return null;
  return {
    id: c.file.id,
    url: c.file.url,
    sha1: c.file.sha1,
    size: c.file.size ?? 0,
    argument: c.argument,
    filePath: path.join(assetsDir(), 'log_configs', c.file.id),
  };
}

/** 检查版本完整性，返回缺失项描述 */
/**
 * 数一下资源索引里有多少对象在本地缺失（只看文件是否存在，不校验 sha1）。
 * @param {string} indexPath assets/indexes/<id>.json
 */
function countMissingAssets(indexPath) {
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const objects = index.objects ?? {};
    const objDir = path.join(assetsDir(), 'objects');
    let miss = 0;
    for (const v of Object.values(objects)) {
      const hash = v?.hash;
      if (!hash) continue;
      if (!fs.existsSync(path.join(objDir, hash.slice(0, 2), hash))) miss++;
    }
    return miss;
  } catch {
    return 0;
  }
}

const PK_HEAD = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PK_EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

// 半截 jar（下载/打补丁中断）会让 ModLauncher 直接崩在 "zip END header not found"
export function zipTailOk(file) {
  let fd;
  try {
    const st = fs.statSync(file);
    if (st.size < 22) return '文件太小';
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    if (!head.equals(PK_HEAD)) {
      if (head.equals(PK_EOCD)) return ''; // 空 zip 合法
      return '不是 zip';
    }
    const tailLen = Math.min(66000, st.size);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
    if (tail.indexOf(PK_EOCD) < 0) return '缺少 EOCD（文件被截断）';
    return '';
  } catch {
    return '读不了';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// Forge / NeoForge 的补丁客户端 jar 不在 libraries 里，是 BootstrapLauncher 按 mcpVersion 拼出来的
export function patchedClientJarPath(id) {
  try {
    const { json } = resolveVersion(id);
    const args = [
      ...(Array.isArray(json.arguments?.game) ? json.arguments.game : []),
      ...(Array.isArray(json.arguments?.jvm) ? json.arguments.jvm : []),
      ...(typeof json.minecraftArguments === 'string' ? json.minecraftArguments.split(/\s+/) : []),
    ].map((a) => (typeof a === 'string' ? a : a?.value)).filter((a) => typeof a === 'string');
    const pick = (flag) => {
      const i = args.findIndex((a) => a === flag);
      if (i >= 0 && args[i + 1]) return args[i + 1];
      const pref = args.find((a) => a.startsWith(flag + '='));
      return pref ? pref.slice(flag.length + 1) : '';
    };
    const mcp = pick('--fml.mcpVersion');
    const mcVer = pick('--fml.mcVersion');
    if (!mcp || !mcVer) return null;
    const p = path.join(librariesDir(), 'net', 'minecraft', 'client', `${mcVer}-${mcp}`, `client-${mcVer}-${mcp}-srg.jar`);
    return { path: p, mcVer, mcp };
  } catch {
    return null;
  }
}

// 只查这个版本启动真正会用到的 jar：版本 jar + libraries 里的 jar
export function findCorruptFiles(id) {
  const out = [];
  try {
    const { json } = resolveVersion(id);
    const seen = new Set();
    const push = (p, label) => {
      if (!p || seen.has(p)) return;
      seen.add(p);
      if (!fs.existsSync(p)) return;
      const why = zipTailOk(p);
      if (why) out.push({ path: p, why, label });
    };
    push(clientJarPath(id, json), '客户端主文件');
    const libs = collectLibraries(json);
    for (const l of libs.jars) push(l.fullPath, path.basename(l.fullPath));
    for (const l of libs.natives) push(l.fullPath, path.basename(l.fullPath));

    // Forge / NeoForge 的补丁客户端 jar 不在 libraries 里，是 BootstrapLauncher 按 mcpVersion 拼出来的
    const args = [
      ...(Array.isArray(json.arguments?.game) ? json.arguments.game : []),
      ...(Array.isArray(json.arguments?.jvm) ? json.arguments.jvm : []),
      ...(typeof json.minecraftArguments === 'string' ? json.minecraftArguments.split(/\s+/) : []),
    ].map((a) => (typeof a === 'string' ? a : a?.value)).filter((a) => typeof a === 'string');
    const mcp = (() => {
      const i = args.findIndex((a) => a === '--fml.mcpVersion');
      if (i >= 0 && args[i + 1]) return args[i + 1];
      const pref = args.find((a) => a.startsWith('--fml.mcpVersion='));
      return pref ? pref.slice('--fml.mcpVersion='.length) : '';
    })();
    const mcVer = (() => {
      const i = args.findIndex((a) => a === '--fml.mcVersion');
      if (i >= 0 && args[i + 1]) return args[i + 1];
      const pref = args.find((a) => a.startsWith('--fml.mcVersion='));
      return pref ? pref.slice('--fml.mcVersion='.length) : '';
    })();
    if (mcp && mcVer) {
      const rel = path.join('net', 'minecraft', 'client', `${mcVer}-${mcp}`, `client-${mcVer}-${mcp}-srg.jar`);
      push(path.join(librariesDir(), rel), `client-${mcVer}-${mcp}-srg.jar`);
    }
    // 顺带报告「补丁 jar 整个不见了」——启动必崩，但单靠 push 查不出来
    const patched = patchedClientJarPath(id);
    if (patched && !fs.existsSync(patched.path) && fs.existsSync(clientJarPath(id, json))) {
      out.push({ path: patched.path, why: '缺失（安装器产物）', label: path.basename(patched.path), missing: true });
    }
  } catch { /* 解析失败就当没有损坏文件 */ }
  return out;
}

export async function inspectVersion(id) {
  const { json, chain } = resolveVersion(id);
  const cfg = loadConfig();
  const missing = [];

  const jar = clientJarPath(id, json);
  if (!fs.existsSync(jar)) missing.push('客户端主文件（client.jar）');

  const libs = collectLibraries(json);
  const missLib = libs.jars.filter((l) => !fs.existsSync(l.fullPath));
  const missNat = libs.natives.filter((l) => !fs.existsSync(l.fullPath));
  if (missLib.length) missing.push(`${missLib.length} 个前置库文件`);
  if (missNat.length) missing.push(`${missNat.length} 个本地库文件`);

  const corrupt = findCorruptFiles(id);
  if (corrupt.length) missing.push(`${corrupt.length} 个文件损坏（下载不完整）`);

  const ai = assetIndexInfo(json);
  if (ai) {
    if (!fs.existsSync(ai.indexPath)) {
      missing.push('资源索引文件');
    } else {
      const missAssets = countMissingAssets(ai.indexPath);
      if (missAssets > 0) missing.push(`${missAssets} 个资源文件`);
    }
  }

  const javas = await scanJavas();
  const need = json.javaVersion?.majorVersion ?? 8;
  const java = pickJava(javas, need);
  if (!java) missing.push('可用的 Java 运行时');
  else if (java.major < need) missing.push(`Java ${need}（当前最高 ${java.major}）`);

  return { id, json, chain, jar, libs, assetIndex: ai, missing, corrupt, java, needJava: need, cfg, gameDir: gameDirFor(id) };
}

/** 把 "K=V\nK2=V2" 解析成对象，忽略空行与 # 注释 */
function parseEnvText(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return out;
}

/** 构建完整启动命令 */
export async function buildLaunchCommand(id, opts = {}) {
  const info = await inspectVersion(id);
  const base = info.cfg;
  const ov = (base.versionOverrides || {})[id] || {};
  // 版本级覆盖：只覆盖填了值的项，空值继续跟随全局
  const cfg = {
    ...base,
    ...(Number(ov.memory) > 0 ? { memory: Number(ov.memory) } : {}),
    ...(Number(ov.width) > 0 ? { width: Number(ov.width) } : {}),
    ...(Number(ov.height) > 0 ? { height: Number(ov.height) } : {}),
    ...(ov.javaPath ? { javaPath: ov.javaPath } : {}),
    ...(ov.jvmArgs ? { jvmArgs: [base.jvmArgs, ov.jvmArgs].filter(Boolean).join(' ') } : {}),
    ...(ov.gameArgs ? { gameArgs: [base.gameArgs, ov.gameArgs].filter(Boolean).join(' ') } : {}),
  };
  if (ov.javaPath && info.java) {
    const picked = info.javas?.find?.((j) => j.path === ov.javaPath);
    info.java = picked || { ...info.java, path: ov.javaPath };
  }
  const { json } = info;
  const account = opts.account ?? cfg.account ?? { name: 'Steve', type: 'offline' };
  const playerName = (account.name || 'Steve').trim() || 'Steve';

  const uuidRaw = account.uuid || offlineUuid(playerName);
  const uuid = uuidRaw.replace(/-/g, '');
  const accessToken = account.accessToken || crypto.createHash('md5').update(`tpcl:${playerName}:${uuidRaw}`).digest('hex');
  const userType = account.type === 'microsoft' ? 'msa' : account.type === 'mojang' ? 'mojang' : 'legacy';

  const gameDir = opts.gameDir || gameDirFor(id);
  await ensureDir(gameDir);

  const nativesDirectory = path.join(versionDir(id), 'natives');
  await ensureDir(nativesDirectory);
  if (isModernNatives(json)) {
    for (const sub of ['java', 'jna', 'lwjgl', 'netty']) await ensureDir(path.join(nativesDirectory, sub));
  } else {
    await unpackNatives(id, info.libs.natives);
  }

  const features = {
    is_demo_user: false,
    has_custom_resolution: Boolean(cfg.width && cfg.height) || Boolean(opts.width && opts.height),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
  };

  const cpEntries = [];
  for (const l of info.libs.jars) cpEntries.push(l.fullPath);
  // Forge/NeoForge 由 Bootstraplauncher 构建模块层，原版 jar 会和加载器的
  // patched client 同时导出 net.minecraft.*（module.ResolutionException）；
  // Fabric 反而需要原版 jar 在 classpath 上找到游戏。
  const isBootstrap = /bootstraplauncher|modlauncher/i.test(json.mainClass || '');
  if (!isBootstrap) cpEntries.push(info.jar);
  const classpath = cpEntries.join(path.delimiter);

  const memory = Number(opts.memory ?? cfg.memory ?? 4096);
  const vars = {
    auth_player_name: playerName,
    version_name: id,
    game_directory: gameDir,
    assets_root: assetsDir(),
    game_assets: path.join(assetsDir(), 'virtual', 'legacy'),
    assets_index_name: json.assets ?? json.assetIndex?.id ?? 'legacy',
    auth_uuid: uuid,
    auth_access_token: accessToken,
    auth_session: `token:${accessToken}:${uuid}`,
    clientid: account.clientId ?? '',
    auth_xuid: account.xuid ?? '',
    user_type: userType,
    version_type: json.type ?? 'release',
    natives_directory: nativesDirectory,
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    classpath,
    classpath_separator: path.delimiter,
    library_directory: librariesDir(),
    user_properties: '{}',
    resolution_width: String(opts.width ?? cfg.width ?? 854),
    resolution_height: String(opts.height ?? cfg.height ?? 480),
  };

  const jvmTokens = [];
  jvmTokens.push(`-Xmx${memory}M`);
  if (cfg.minMemory) jvmTokens.push(`-Xms${Math.min(cfg.minMemory, memory)}M`);
  jvmTokens.push('-Dfile.encoding=UTF-8');
  jvmTokens.push('-Dstdout.encoding=UTF-8');
  jvmTokens.push('-Dstderr.encoding=UTF-8');

  const logCfg = logConfigInfo(json);
  if (logCfg && fs.existsSync(logCfg.filePath)) {
    jvmTokens.push(`-Dlog4j.configurationFile=${logCfg.filePath}`);
  }

  if (json.arguments?.jvm?.length) {
    jvmTokens.push(...expand(flattenArg(json.arguments.jvm, features), vars));
  } else if (json.minecraftArguments) {
    jvmTokens.push('-Djava.library.path=' + nativesDirectory);
    jvmTokens.push('-cp', classpath);
  }

  if (cfg.jvmArgs) jvmTokens.push(...cfg.jvmArgs.split(/\s+/).filter(Boolean));
  if (opts.jvmArgs) jvmTokens.push(...opts.jvmArgs.split(/\s+/).filter(Boolean));

  let gameTokens = [];
  if (json.arguments?.game?.length) {
    gameTokens = expand(flattenArg(json.arguments.game, features), vars);
  } else if (json.minecraftArguments) {
    gameTokens = expand(json.minecraftArguments.split(/\s+/), vars);
  }
  if (cfg.gameArgs) gameTokens.push(...cfg.gameArgs.split(/\s+/).filter(Boolean));
  if (opts.gameArgs) gameTokens.push(...opts.gameArgs.split(/\s+/).filter(Boolean));

  // 自定义窗口尺寸（版本 JSON 已含时以 JSON 为准）
  const hasResArg = gameTokens.includes('--width');
  if (!hasResArg && (cfg.width && cfg.height)) {
    gameTokens.push('--width', String(cfg.width), '--height', String(cfg.height));
  }
  if (cfg.fullscreen && !gameTokens.includes('--fullscreen')) gameTokens.push('--fullscreen');
  // 版本级窗口标题（原版客户端支持 --title）
  if (ov.windowTitle && !gameTokens.includes('--title')) gameTokens.push('--title', String(ov.windowTitle));

  const mainClass = json.mainClass ?? 'net.minecraft.client.main.Main';
  const args = [...jvmTokens, mainClass, ...gameTokens];

  return {
    javaPath: info.java.path,
    javaMajor: info.java.major,
    needJava: info.needJava,
    args,
    cwd: gameDir,
    gameDir,
    missing: info.missing,
    loginInfo: { name: playerName, uuid, userType },
    env: parseEnvText(ov.env),
    preLaunch: (ov.preLaunch || '').trim(),
    windowTitle: ov.windowTitle || '',
  };
}

async function unpackNatives(id, natives) {
  const dir = path.join(versionDir(id), 'natives');
  await ensureDir(dir);
  for (const n of natives) {
    if (!fs.existsSync(n.fullPath)) continue;
    await extractJar(n.fullPath, dir);
  }
}

let yauzlLike = null;
/** 用系统 tar 解 jar（zip 格式），保留目录结构 */
async function extractJar(jarPath, dest) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);
  try {
    await execFileP('tar.exe', ['-xf', jarPath, '-C', dest], { timeout: 120000, windowsHide: true });
  } catch {
    try {
      const { execSync } = await import('node:child_process');
      execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${jarPath.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force"`, { timeout: 120000, windowsHide: true });
    } catch { /* 部分 jar 解压失败不致命 */ }
  }
}

/** 启动游戏 */
/**
 * 游戏异常退出但没生成 crash-report 时，自己写一份诊断报告。
 * 覆盖：JVM 原生崩溃（hs_err_pid*.log）、mod 初始化期静默退出、被系统或杀软结束。
 */
export function writeExitDiagnostics(o) {
  const dir = path.join(o.gameDir || o.cwd, 'crash-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `tpcl-exit-${stamp}.txt`);

  const hs = [];
  const seenHs = new Set();
  for (const root of [o.cwd, o.gameDir]) {
    if (!root) continue;
    try {
      for (const name of fs.readdirSync(root)) {
        if (!/^hs_err_pid\d+\.log$/i.test(name)) continue;
        const full = path.join(root, name);
        const st = fs.statSync(full);
        if (st.mtimeMs < (o.startedAt || 0) - 5000) continue;
        const key = path.resolve(full).toLowerCase();
        if (seenHs.has(key)) continue;
        seenHs.add(key);
        hs.push({ full, name, text: fs.readFileSync(full, 'utf8').slice(0, 6000) });
      }
    } catch { /* 目录不存在就算了 */ }
  }

  const lines = [];
  lines.push('# TPCL 退出诊断');
  lines.push('');
  lines.push('Description: 游戏异常退出，且没有生成 Minecraft 崩溃报告');
  lines.push('版本: ' + o.id);
  const CODE_HINT = {
    '-1073741819': '0xC0000005 内存访问冲突（驱动/内存/优化模组）',
    '3221225477': '0xC0000005 内存访问冲突（驱动/内存/优化模组）',
    '-1073741795': '0xC000001D 非法指令（CPU 指令集/超频）',
    '-1073741571': '0xC00000FD 栈溢出',
    '-1073741515': '0xC0000135 缺少 DLL（多半是 Java 或 VC 运行库）',
    '1': '通用失败（通常是 mod 初始化阶段抛错后退出）',
    '134': 'SIGABRT（JVM 主动中止）',
  };
  lines.push('退出码: ' + o.code + (o.signal ? '（signal ' + o.signal + '）' : '') + (CODE_HINT[String(o.code)] ? ' = ' + CODE_HINT[String(o.code)] : ''));
  lines.push('时间: ' + new Date().toLocaleString('zh-CN'));
  lines.push('Java: ' + o.javaPath);
  lines.push('工作目录: ' + o.cwd);
  lines.push('启动参数: ' + String((o.args || []).join(' ')).slice(0, 1200));
  lines.push('');
  if (hs.length) {
    lines.push('## 检测到 JVM 原生崩溃日志（hs_err）');
    for (const h of hs) { lines.push('### ' + h.name); lines.push(h.text); lines.push(''); }
  } else {
    lines.push('## 没有 hs_err_pid 日志（说明不是 JVM 原生崩溃，更可能是 mod/驱动主动退出或被结束）');
  }
  lines.push('');
  lines.push('## 退出前最后 80 行日志');
  lines.push((o.tail || []).slice(-80).join('\n'));
  lines.push('');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return { file, hsErr: hs.map((h) => h.full) };
}

export async function startGame(id, opts = {}) {
  const cmd = await buildLaunchCommand(id, opts);
  // force=true 只放过「Java 大版本不匹配」这一类，文件缺失照样拦（强行启动是 PCL2 的常规做法）
  const blocking = opts.force ? cmd.missing.filter((m) => !/^Java\s/.test(m)) : cmd.missing;
  if (blocking.length) {
    const err = new Error(`版本不完整，缺少：${blocking.join('、')}`);
    err.code = 'INCOMPLETE';
    throw err;
  }

  const logsDir = path.join(DATA_DIR, 'logs');
  await ensureDir(logsDir);

  // 核显驱动崩溃的机器：启动前把 java 指到独显（Windows 用户级 GPU 偏好）
  try {
    if (loadConfig().gpuHigh) {
      const g = setGpuPreference(cmd.javaPath, true);
      if (g.ok) bus.emit('log', { type: 'system', text: '[TPCL] 已把 java.exe 设为高性能 GPU（独显）\n' });
      else bus.emit('log', { type: 'warn', text: '[TPCL] 设置独显失败：' + (g.error || '未知原因') + '\n' });
    }
  } catch (e) {
    bus.emit('log', { type: 'warn', text: '[TPCL] 设置独显异常：' + e.message + '\n' });
  }

  // 进游戏就是中文：按设置把 options.txt 的 lang 改掉（首次启动也会写）
  try {
    const langRes = await applyConfiguredLanguage(id);
    if (langRes?.changed) {
      bus.emit('log', { type: 'system', text: `[TPCL] 已把游戏语言设为 ${langRes.lang}（${langRes.file}）\n` });
    }
  } catch (e) {
    bus.emit('log', { type: 'warn', text: `[TPCL] 写入游戏语言失败：${e.message}\n` });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logsDir, `${id}-${stamp}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  bus.emit('log', { type: 'system', text: `[TPCL] 启动 ${id} (Java ${cmd.javaMajor})\n` });
  bus.emit('log', { type: 'system', text: `[TPCL] ${cmd.javaPath} ${cmd.args.join(' ').slice(0, 400)}…\n` });

  if (cmd.preLaunch) {
    bus.emit('log', { type: 'system', text: `[TPCL] 启动前命令: ${cmd.preLaunch}\n` });
    const pre = spawnSync(cmd.preLaunch, {
      shell: true,
      cwd: cmd.cwd,
      env: { ...process.env, ...(cmd.env || {}) },
      windowsHide: true,
      encoding: 'utf8',
      timeout: 120000,
    });
    const outText = (pre.stdout || '').trim();
    const errText = (pre.stderr || '').trim();
    if (outText) bus.emit('log', { type: 'system', text: outText.slice(-4000) + '\n' });
    if (errText) bus.emit('log', { type: 'system', text: errText.slice(-4000) + '\n' });
    if (pre.error) throw new Error(`启动前命令执行失败: ${pre.error.message}`);
    if (pre.status !== 0) throw new Error(`启动前命令返回退出码 ${pre.status}，已中断启动`);
  }

  const child = spawn(cmd.javaPath, cmd.args, {
    cwd: cmd.cwd,
    env: { ...process.env, APPDATA: process.env.APPDATA, ...(cmd.env || {}) },
    windowsHide: true,
    detached: false,
  });

  const running = { id, child, logFile, startedAt: Date.now(), pid: child.pid, exited: false, exitCode: null, tail: [] };

  const cleaner = createLogCleaner();
  const pipe = (stream) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const out = cleaner.push(line);
        if (!out) continue;
        logStream.write(out.text + '\n');
        running.tail.push(out.text);
        if (running.tail.length > 160) running.tail.shift();
        bus.emit('log', { type: out.level, text: out.text + '\n' });
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on('error', (e) => {
    running.exited = true;
    logStream.write(`[TPCL] 进程错误：${e.message}\n`);
    bus.emit('log', { type: 'error', text: `\n[TPCL] 进程错误：${e.message}\n` });
    bus.emit('exit', { id, code: -1, error: e.message });
    logStream.end();
  });

  child.on('exit', (code, signal) => {
    running.exited = true;
    running.exitCode = code;
    running.signal = signal ?? null;
    const desc = code === null
      ? `进程被终止（${signal ?? '未知信号'}）`
      : `游戏已退出，退出码 ${code}`;
    logStream.write(`\n[TPCL] ${desc}\n`);
    bus.emit('log', { type: 'system', text: `\n[TPCL] ${desc}\n` });
    let diag = null;
    if (code !== 0 && code !== null) {
      try {
        diag = writeExitDiagnostics({
          id, code, signal: signal ?? null,
          tail: running.tail,
          cwd: cmd.cwd, gameDir: cmd.gameDir || cmd.cwd,
          javaPath: cmd.javaPath, args: cmd.args, startedAt: running.startedAt,
        });
        bus.emit('log', { type: 'warn', text: `[TPCL] 没有崩溃报告，已生成诊断：${path.basename(diag.file)}\n` });
      } catch (e) {
        bus.emit('log', { type: 'error', text: `[TPCL] 生成诊断失败：${e.message}\n` });
      }
    }
    bus.emit('exit', { id, code, signal: signal ?? null, diag });
    logStream.end();
  });

  return running;
}
