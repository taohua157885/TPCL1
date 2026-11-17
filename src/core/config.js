import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
// 打包成 Electron 后，程序目录是只读的 asar，数据要落到 %APPDATA%\TPCL
export const DATA_DIR = process.env.TPCL_DATA_DIR
  ? path.resolve(process.env.TPCL_DATA_DIR)
  : path.join(ROOT, 'data');
export const WEB_DIR = path.join(ROOT, 'web');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULTS = {
  locale: 'zh',
  mcDir: guessMcDir(),
  javaPath: '',
  memory: 4096,
  minMemory: 512,
  jvmArgs: '',
  gameArgs: '',
  width: 0,
  height: 0,
  fullscreen: false,
  autoBackupBeforeLaunch: false,
  detached: true,
  mirror: 'bmclapi',
  // mirror === 'custom' 时使用；按 BMCLAPI 的路径规则拼接（/maven、/assets、/fabric-meta、/version/<id>/json）
  mirrorUrl: '',
  // HTTP 代理，例如 http://127.0.0.1:7890（留空直连）
  proxy: '',
  isolation: 'version',
  selectedVersion: '',
  account: { name: 'Steve', uuid: '', type: 'offline' },
  language: 'zh_cn',
  downloadThreads: 12,
  autoJava: true,
  closeAfterLaunch: false,
  theme: 'dark',
  accent: '',
  // 启动前把 java.exe 设为「高性能 GPU」（HKCU\Software\Microsoft\DirectX\UserGpuPreferences）
  gpuHigh: false,
  showSnapshot: false,
  // 每个版本的独立覆盖：{ [版本id]: { memory, javaPath, width, height, jvmArgs, gameArgs } }
  // 留空/0 表示跟随全局设置
  versionOverrides: {},
  // 服务器列表：[{ id, name, host, port }]
  servers: [],
  lastPlayed: {},
  // { [版本id]: { at, file, title, signature, exception } } —— 非正常退出后自动写入
  lastCrash: {},
};

/** 猜一个 .minecraft 路径：优先官方默认位置 */
export function guessMcDir() {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft'),
    path.join(os.homedir(), '.minecraft'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return candidates[0];
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

let cache = null;

export function loadConfig() {
  if (cache) return cache;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let disk = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[config] 读取失败，使用默认值：', e.message);
  }
  cache = deepMerge(DEFAULTS, disk);
  return cache;
}

export function saveConfig(patch) {
  const cur = loadConfig();
  cache = deepMerge(cur, patch);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

/** 游戏真实运行目录（版本隔离时按版本分目录） */
export function gameDirFor(versionId) {
  const cfg = loadConfig();
  const base = cfg.mcDir;
  switch (cfg.isolation) {
    case 'global':
      return base;
    case 'custom':
      return path.join(base, 'versions', versionId, 'game');
    case 'version':
    default:
      return path.join(base, 'versions', versionId);
  }
}

/** 把配置里的代理写进进程环境变量（Node 24 的 fetch 认 NODE_USE_ENV_PROXY） */
export function applyProxyEnv(cfg = loadConfig()) {
  const p = String(cfg.proxy || '').trim();
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
  if (p) {
    for (const k of keys) process.env[k] = p;
    process.env.NODE_USE_ENV_PROXY = '1';
  } else {
    for (const k of keys) delete process.env[k];
    delete process.env.NODE_USE_ENV_PROXY;
  }
  return p;
}
