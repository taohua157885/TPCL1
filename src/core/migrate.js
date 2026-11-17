// 启动器配置的导出 / 导入（换机迁移用）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEFAULTS, loadConfig, saveConfig } from './config.js';

// 不参与迁移的运行时字段
const TRANSIENT = ['lastCrash', 'lastPlayed', 'lastLaunch', 'error'];

export function exportsDir() {
  const dir = path.join(DATA_DIR, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeCopy(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (TRANSIENT.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** 导出当前配置到 data/exports/tpcl-config-<stamp>.json */
export function exportConfig() {
  const cfg = safeCopy(loadConfig());
  const pack = {
    app: 'TPCL Config',
    format: 1,
    at: new Date().toISOString(),
    defaults: { memory: DEFAULTS.memory, language: DEFAULTS.language, mirror: DEFAULTS.mirror },
    config: cfg,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(exportsDir(), `tpcl-config-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(pack, null, 2), 'utf8');
  return { ok: true, file, size: fs.statSync(file).size, keys: Object.keys(cfg).length };
}

/** 读回导出的 json 并合并进本机配置（同名设置项以导入的为准） */
export function importConfig(file) {
  if (!file || !fs.existsSync(file)) throw new Error('文件不存在：' + file);
  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('这不是有效的 JSON 文件');
  }
  if (!pack || pack.app !== 'TPCL Config' || !pack.config) {
    throw new Error('这不是 TPCL 导出的配置文件（缺少 app: "TPCL Config" 标记）');
  }
  const incoming = safeCopy(pack.config);
  // 运行时字段不覆盖本机
  const cfg = saveConfig(incoming);
  return {
    ok: true,
    applied: Object.keys(incoming).length,
    exportedAt: pack.at || '',
    memory: cfg.memory,
    language: cfg.language,
    mirror: cfg.mirror,
    versions: Object.keys(cfg.versionOverrides || {}).length,
    servers: (cfg.servers || []).length,
  };
}
