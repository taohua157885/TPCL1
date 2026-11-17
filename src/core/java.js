import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, DATA_DIR } from './config.js';
import { ensureDir, downloadFile } from './download.js';

const execFileP = promisify(execFile);
export const JAVA_HOME_DIR = path.join(DATA_DIR, 'java');

const EXE = process.platform === 'win32' ? 'java.exe' : 'java';

function readReleaseVersion(javaHome) {
  const releaseFile = path.join(javaHome, 'release');
  try {
    const txt = fs.readFileSync(releaseFile, 'utf8');
    const m = txt.match(/JAVA_VERSION="([^"]+)"/) || txt.match(/JAVA_RUNTIME_VERSION="([^"]+)"/);
    if (m) {
      const major = Number(m[1].split('.').map((s, i) => (i === 0 && s === '1' ? null : s)).filter(Boolean)[0]);
      return { version: m[1], major: Number.isFinite(major) ? major : 0 };
    }
  } catch { /* ignore */ }
  return null;
}

async function probeJava(exePath) {
  try {
    const { stdout, stderr } = await execFileP(`"${exePath}"`, ['-version'], { timeout: 8000, windowsHide: true });
    const out = `${stderr}\n${stdout}`;
    const m = out.match(/version "([^"]+)"/);
    const version = m?.[1] ?? '';
    const major = Number(version.split('.').map((s, i) => (i === 0 && s === '1' ? null : s)).filter(Boolean)[0]) || 0;
    return { version, major };
  } catch {
    return null;
  }
}

async function findJavaExes(root, maxDepth = 4) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch { return; }
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === EXE)) {
      found.push(path.join(dir, EXE));
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name.toLowerCase();
      if (depth > 0 && !['bin', 'jre', 'jdk', 'runtime', 'contents', 'home'].includes(name)) {
        // 只在名字像 JDK 的目录继续下钻
        if (!/(jdk|jre|temurin|zulu|corretto|adoptium|graal|java)/.test(name)) continue;
      }
      await walk(path.join(dir, e.name), depth + 1);
    }
  }
  await walk(root, 0);
  return found;
}

function candidateRoots() {
  const cfg = loadConfig();
  const roots = [];
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p); };

  push(JAVA_HOME_DIR);
  push(path.join(cfg.mcDir, 'runtime'));
  push(path.join(os.homedir(), '.jdks'));

  // 打包后的启动器数据目录在 %APPDATA%\TPCL\data，
  // 但开发目录里可能已经下载过 Java（data/java），用环境变量把它也纳入扫描
  for (const extra of String(process.env.TPCL_EXTRA_JAVA || '').split(';')) {
    const p = extra.trim();
    if (p) push(p);
  }

  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    for (const base of [pf, pf86]) {
      for (const sub of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'BellSoft',
        'Amazon Corretto', 'AdoptOpenJDK', 'Semeru', 'Temurin', 'JetBrains']) {
        push(path.join(base, sub));
      }
    }
    if (process.env.JAVA_HOME) push(process.env.JAVA_HOME);
  } else {
    push('/usr/lib/jvm');
    push('/Library/Java/JavaVirtualMachines');
    if (process.env.JAVA_HOME) push(process.env.JAVA_HOME);
  }
  return roots;
}

let scanCache = null;
let scanAt = 0;

export async function scanJavas(force = false) {
  if (!force && scanCache && Date.now() - scanAt < 15000) return scanCache;

  const paths = new Set();
  const cfg = loadConfig();
  if (cfg.javaPath && fs.existsSync(cfg.javaPath)) paths.add(cfg.javaPath);

  for (const root of candidateRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const exe of await findJavaExes(root, 4)) paths.add(exe);
  }

  // PATH 上的 java
  try {
    const { stdout } = await execFileP(process.platform === 'win32' ? 'where' : 'which', ['java'], { timeout: 5000, windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) {
      const p = line.trim();
      if (p && fs.existsSync(p)) paths.add(p);
    }
  } catch { /* ignore */ }

  const list = [];
  const seenHome = new Set();
  for (const exe of paths) {
    const home = path.dirname(path.dirname(exe));
    if (seenHome.has(home)) continue;
    seenHome.add(home);
    const rel = readReleaseVersion(home);
    const probed = rel ?? (await probeJava(exe));
    if (!probed || !probed.major) continue;
    list.push({
      path: exe,
      home,
      major: probed.major,
      version: probed.version,
      source: inferSource(home),
      // 是不是本启动器自己下到 data/java 里的（这种才能安全删除）
      auto: path.resolve(home).startsWith(path.resolve(JAVA_HOME_DIR)),
    });
  }

  list.sort((a, b) => b.major - a.major || a.home.localeCompare(b.home));
  scanCache = list;
  scanAt = Date.now();
  return list;
}

/** 删掉启动器自己下载的 Java（只允许 data/java 下的目录） */
export async function removeJava(home) {
  if (!String(home || '').trim()) return { ok: false, error: '没有指定要删除的目录' };
  const target = path.resolve(String(home || ''));
  const base = path.resolve(JAVA_HOME_DIR);
  if (target === base) return { ok: false, error: '不能删掉整个 data/java 目录' };
  if (!target.startsWith(base + path.sep)) return { ok: false, error: '只能删除启动器自己下载的 Java（data/java 下）' };
  if (!fs.existsSync(target)) return { ok: false, error: `目录不存在：${target}` };
  const cfg = loadConfig();
  if (cfg.javaPath && path.resolve(cfg.javaPath).startsWith(target + path.sep)) {
    return { ok: false, error: '这个 Java 正被全局设置使用，先切换到别的 Java 再删' };
  }
  await fsp.rm(target, { recursive: true, force: true });
  scanCache = null;
  scanAt = 0;
  return { ok: true, removed: target };
}

/** 校验用户手动挑选的 java 可执行文件：存在性 + 版本探测 */
export async function inspectJavaFile(file) {
  const raw = String(file || '').trim();
  if (!raw) return { ok: false, error: '没有拿到路径' };
  const exe = path.resolve(raw);
  if (!fs.existsSync(exe)) return { ok: false, error: `文件不存在：${exe}` };
  const base = path.basename(exe).toLowerCase();
  if (!/^(java|javaw|javaws?)(\.exe)?$/.test(base)) {
    return { ok: false, error: `这不像 Java 可执行文件（当前是 ${base}）` };
  }
  const home = path.dirname(path.dirname(exe));
  const byRelease = readReleaseVersion(home);
  const probed = byRelease ?? (await probeJava(exe));
  if (!probed || !probed.major) {
    return { ok: false, error: '这个文件跑不起来（-version 没返回版本），可能不是可用的 Java' };
  }
  return { ok: true, path: exe, home, major: probed.major, version: probed.version, source: inferSource(home) };
}

function inferSource(home) {
  const s = home.toLowerCase();
  if (s.includes(`${path.sep}runtime`)) return '官方运行时';
  if (s.includes('.jdks')) return 'IDE 下载';
  if (s.includes('adoptium') || s.includes('temurin')) return 'Adoptium';
  if (s.includes('zulu')) return 'Zulu';
  if (s.includes('corretto')) return 'Corretto';
  if (s.includes('microsoft')) return 'Microsoft';
  return '系统安装';
}

/** 选出最合适的 Java：major 满足要求且最接近（不浪费），没有则返回最高版本 */
export function pickJava(list, requiredMajor) {
  if (!list.length) return null;
  const cfg = loadConfig();
  if (cfg.javaPath) {
    const exact = list.find((j) => path.resolve(j.path) === path.resolve(cfg.javaPath));
    if (exact) return exact;
  }
  const need = Number(requiredMajor) || 8;
  const ok = list.filter((j) => j.major >= need);
  if (ok.length) return ok.sort((a, b) => a.major - b.major)[0];
  return list.sort((a, b) => b.major - a.major)[0];
}

const ADOPTIUM = 'https://api.adoptium.net/v3/binary/latest';

/**
 * Java 下载源候选（按顺序尝试）。
 *
 * 实测：Adoptium 会 302 到 GitHub Releases，本机只有 ~100 KB/s；华为云镜像
 * 同一份 JDK 能跑到 ~10 MB/s。所以国内先走华为云，失败再回落 Adoptium。
 * 差别是华为云只有完整 JDK（约 220 MB），Adoptium 提供更小的 JRE。
 */
function javaSources(major, plat, arch) {
  const list = [];
  if (plat === 'windows' && arch === 'x64') {
    list.push({
      name: '华为云 OpenJDK',
      url: `https://mirrors.huaweicloud.com/openjdk/${major}/openjdk-${major}_windows-x64_bin.zip`,
    });
  }
  list.push({
    name: 'Adoptium',
    url: `${ADOPTIUM}/${major}/ga/${plat}/${arch}/jre/hotspot/normal/eclipse`,
  });
  return list;
}

/** 自动下载指定大版本的 Java，返回 java.exe 路径 */
export async function downloadJava(major, onProgress = () => {}) {
  const plat = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'ia32' ? 'x86' : process.arch === 'arm64' ? 'aarch64' : 'x64';
  const zipPath = path.join(JAVA_HOME_DIR, `java-${major}-${plat}-${arch}.zip`);
  await ensureDir(JAVA_HOME_DIR);

  const sources = javaSources(major, plat, arch);
  let lastErr = null;
  let got = false;

  for (let i = 0; i < sources.length && !got; i++) {
    const s = sources[i];
    onProgress({ phase: 'download', percent: 0, text: `从 ${s.name} 下载 Java ${major}…` });
    try {
      await downloadFile([s.url], zipPath, {
        retries: 1,
        connectTimeoutMs: 20000,
        idleMs: 30000,
        onBytes: (n, total) => onProgress({
          phase: 'download',
          percent: total ? Math.round((n / total) * 100) : -1,
          text: `从 ${s.name} 下载 Java ${major}${total ? ` · ${Math.round((n / total) * 100)}%` : ''}`,
        }),
      });
      got = true;
    } catch (e) {
      lastErr = e;
      onProgress({ phase: 'download', percent: -1, text: `${s.name} 失败，换下一个源…` });
    }
  }

  if (!got) throw new Error(`Java ${major} 下载失败：${lastErr?.message ?? '所有源均不可用'}`);

  const dest = path.join(JAVA_HOME_DIR, `java-${major}`);
  await fsp.rm(dest, { recursive: true, force: true });
  await ensureDir(dest);
  onProgress({ phase: 'extract', percent: 0, text: '解压 Java…' });

  await extractZip(zipPath, dest);
  const exes = await findJavaExes(dest, 4);
  if (!exes.length) throw new Error(`解压后未找到 java 可执行文件：${dest}`);
  await fsp.rm(zipPath, { force: true });
  scanCache = null;
  onProgress({ phase: 'done', percent: 100, text: `Java ${major} 就绪` });
  return exes[0];
}

/** 用系统自带 tar(bsdtar) 解 zip，避免引入第三方依赖 */
async function extractZip(zipPath, dest) {
  if (process.platform === 'win32') {
    try {
      await execFileP('tar.exe', ['-xf', zipPath, '-C', dest], { timeout: 300000, windowsHide: true });
      return;
    } catch (e) {
      // 回退 PowerShell
      const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`;
      await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 300000, windowsHide: true });
      return;
    }
  }
  await execFileP('unzip', ['-q', '-o', zipPath, '-d', dest], { timeout: 300000 });
}
