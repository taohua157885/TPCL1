// 模组依赖 / 冲突检测：读 jar 里的 fabric.mod.json、mods.toml、mcmod.info，找缺失依赖、重复 modid、同 jar 重复
import fsp from 'node:fs/promises';
import path from 'node:path';
import { listEntries, readEntry } from './ziptool.js';

const MODS_DIR_OF = (gameDir) => path.join(gameDir, 'mods');

// 这些不是模组依赖，检查时忽略
const IGNORE = new Set([
  'minecraft', 'forge', 'neoforge', 'fabricloader', 'fabric', 'fabric-api-base',
  'java', 'javafml', 'lowcodefml', 'mclanguage', 'openloader',
]);

function clean(s) {
  return String(s || '').trim().replace(/^["']|["']$/g, '');
}

// fabric.mod.json
function parseFabric(json) {
  const out = { ids: [], deps: [], name: '' };
  const j = JSON.parse(json);
  const id = clean(j.id);
  if (id) out.ids.push(id.toLowerCase());
  out.name = clean(j.name) || id;
  out.version = clean(j.version);
  const dep = j.depends || {};
  for (const [k, v] of Object.entries(dep)) {
    const modid = String(k).toLowerCase();
    if (IGNORE.has(modid)) continue;
    out.deps.push({ modid, range: Array.isArray(v) ? v.join(', ') : String(v || ''), mandatory: true });
  }
  return out;
}

// mods.toml / neoforge.mods.toml：只做够用的行扫描
function parseToml(text) {
  const out = { ids: [], deps: [], name: '' };
  const lines = text.split(/\r?\n/);
  let section = '';       // '' | 'mods' | 'deps'
  let curDep = null;
  const flush = () => {
    if (curDep && curDep.modid && !IGNORE.has(curDep.modid)) out.deps.push({ ...curDep });
    curDep = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^\[\[mods\]\]/.test(line)) { flush(); section = 'mods'; continue; }
    const dm = line.match(/^\[\[dependencies\.([\w.-]+)\]\]/i);
    if (dm) { flush(); section = 'deps'; curDep = { mandatory: true, owner: dm[1].toLowerCase() }; continue; }
    if (/^\[/.test(line)) { flush(); section = ''; continue; }
    const m = line.match(/^([A-Za-z_][\w.]*)\s*=\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = clean(m[2].split('#')[0]);
    if (section === 'mods') {
      if (key === 'modid') out.ids.push(val.toLowerCase());
      if (key === 'displayname' && !out.name) out.name = val;
      if (key === 'version' && !out.version) out.version = val;
    } else if (section === 'deps' && curDep) {
      if (key === 'modid') curDep.modid = val.toLowerCase();
      if (key === 'mandatory') curDep.mandatory = !/^(false|"false")$/i.test(val);
      if (key === 'versionrange') curDep.range = val;
    }
  }
  flush();
  return out;
}

function parseMcmodInfo(text) {
  const out = { ids: [], deps: [], name: '' };
  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : (j.modList || []);
    for (const m of arr) {
      const id = clean(m.modid || m.modId);
      if (id) out.ids.push(id.toLowerCase());
      if (!out.name) out.name = clean(m.name);
      for (const d of (m.dependencies || [])) {
        const modid = String(d).toLowerCase();
        if (!IGNORE.has(modid)) out.deps.push({ modid, range: '', mandatory: true });
      }
    }
  } catch { /* ignore */ }
  return out;
}

async function describeJar(file) {
  const base = path.basename(file);
  const names = (await listEntries(file).catch(() => [])).map((e) => e.name);
  const has = (n) => names.includes(n);
  if (has('fabric.mod.json')) {
    const buf = await readEntry(file, 'fabric.mod.json');
    if (buf) {
      try { return { file: base, loader: 'fabric', ...parseFabric(buf.toString('utf8')) }; } catch { /* fallthrough */ }
    }
  }
  for (const t of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml', 'META-INF/MANIFEST.MF']) {
    if (t === 'META-INF/MANIFEST.MF') break;
    if (has(t)) {
      const buf = await readEntry(file, t);
      if (buf) {
        const parsed = parseToml(buf.toString('utf8'));
        if (parsed.ids.length) return { file: base, loader: 'forge', ...parsed };
      }
    }
  }
  if (has('mcmod.info')) {
    const buf = await readEntry(file, 'mcmod.info');
    if (buf) return { file: base, loader: 'legacy', ...parseMcmodInfo(buf.toString('utf8')) };
  }
  return { file: base, loader: 'unknown', ids: [], deps: [], name: '' };
}

// 版本区间是否兼容（只做保守判断：解析不出就当作兼容，避免误报）
function rangeOk(range, version) {
  if (!range || !version) return true;
  if (String(version).includes('${')) return true;   // Forge 的 ${file.jarVersion} 占位符，判不了
  const r = String(range).trim();
  if (!/^[\[(]/.test(r)) return true;              // 不是 Maven 区间（可能是 *）
  const m = r.match(/^([\[(])\s*([^,\s\]]*)\s*,\s*([^)\]\s]*)\s*([\])])$/);
  if (!m) return true;
  const [, lo, loV, hiV, hiC] = m;
  const cmp = (a, b) => {
    const pa = String(a).split(/[.\-+]/).map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x));
    const pb = String(b).split(/[.\-+]/).map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] ?? 0, y = pb[i] ?? 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
  if (loV) {
    const c = cmp(version, loV);
    if (c < 0 || (c === 0 && lo === '(')) return false;
  }
  if (hiV) {
    const c = cmp(version, hiV);
    if (c > 0 || (c === 0 && hiC === ')')) return false;
  }
  return true;
}

export async function checkMods(versionId, gameDir) {
  const dir = MODS_DIR_OF(gameDir);
  const jars = (await fsp.readdir(dir).catch(() => []))
    .filter((f) => /\.jar$/i.test(f) && !/\.disabled$/i.test(f))
    .map((f) => path.join(dir, f));

  const infos = [];
  for (const f of jars) {
    const d = await describeJar(f).catch(() => null);
    if (d) infos.push(d);
  }

  const byId = new Map();       // modid -> [info]
  for (const i of infos) {
    for (const id of i.ids) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(i);
    }
  }

  const issues = [];

  // 1) 同一 modid 出现在多个 jar（重复安装 / 不同版本并存）
  for (const [id, list] of byId) {
    const files = [...new Set(list.map((x) => x.file))];
    if (files.length > 1) {
      issues.push({
        type: 'duplicate',
        modid: id,
        title: `${id} 装了 ${files.length} 份`,
        detail: '同一个模组有多个 jar 同时在 mods 里，游戏多半会崩或者只加载其中一个。',
        files,
        fixable: true,
      });
    }
  }

  // 2) 完全重复的文件（同名同大小）
  const sizeMap = new Map();
  for (const f of jars) {
    const st = await fsp.stat(f).catch(() => null);
    if (!st) continue;
    const key = `${st.size}`;
    if (!sizeMap.has(key)) sizeMap.set(key, []);
    sizeMap.get(key).push(path.basename(f));
  }
  for (const [, list] of sizeMap) {
    if (list.length > 1) {
      issues.push({
        type: 'dupfile',
        modid: '',
        title: `有 ${list.length} 个大小完全相同的 jar`,
        detail: '可能是同一个模组被复制了两份（改名也算），只保留一份即可。',
        files: list,
        fixable: true,
      });
    }
  }

  // 3) 缺失的强制依赖
  const missing = new Map();
  for (const i of infos) {
    for (const d of i.deps) {
      if (!d.mandatory) continue;
      if (byId.has(d.modid)) {
        // 在，检查版本区间
        const hit = byId.get(d.modid)[0];
        if (!rangeOk(d.range, hit.version)) {
          issues.push({
            type: 'range',
            modid: d.modid,
            title: `${i.name || i.file} 需要 ${d.modid} ${d.range}，当前是 ${hit.version || '未知版本'}`,
            detail: '版本对不上，模组可能不工作或者直接崩。',
            files: [i.file, hit.file],
            fixable: false,
          });
        }
        continue;
      }
      const key = d.modid;
      if (!missing.has(key)) missing.set(key, { range: d.range, from: new Set() });
      missing.get(key).from.add(d.owner || i.name || i.file);
    }
  }
  for (const [modid, info] of missing) {
    issues.push({
      type: 'missing',
      modid,
      title: `缺少前置：${modid}`,
      detail: `${[...info.from].join('、')} 需要它${info.range ? `（要求 ${info.range}）` : ''}，但 mods 里没有。`,
      files: [],
      fixable: false,
    });
  }

  return {
    ok: true,
    version: versionId,
    dir,
    jars: jars.length,
    mods: infos.map((i) => ({ file: i.file, name: i.name, ids: i.ids, loader: i.loader, version: i.version || '' })),
    issues,
    counts: {
      missing: issues.filter((i) => i.type === 'missing').length,
      duplicate: issues.filter((i) => i.type === 'duplicate').length,
      dupfile: issues.filter((i) => i.type === 'dupfile').length,
      range: issues.filter((i) => i.type === 'range').length,
    },
  };
}

// 把某个文件禁掉（改名 .disabled），用于一键处理重复
export async function disableModFiles(gameDir, files) {
  const dir = MODS_DIR_OF(gameDir);
  const done = [];
  for (const f of files || []) {
    const full = path.join(dir, path.basename(String(f)));
    if (!full.startsWith(dir + path.sep)) continue;
    try {
      await fsp.rename(full, full + '.disabled');
      done.push(path.basename(full));
    } catch { /* ignore */ }
  }
  return done;
}
