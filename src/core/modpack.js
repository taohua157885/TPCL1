import { wrapperPrefix, contentDirs, plainVersion, gameLayers, localModCount } from './pack-layout.js';
// 整合包导入：Modrinth (.mrpack) / CurseForge 导出包 / 直接打包的 .minecraft
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, gameDirFor } from './config.js';
import { ensureDir, downloadFile } from './download.js';
import { versionDir, versionJsonPath } from './version.js';
import { installVersion } from './installer.js';
import { installLoader } from './loaders.js';
import { listEntries, readText as zipReadMember, extract as zipExtract } from './ziptool.js';

const TAR = 'C:/Windows/System32/tar.exe';

function run(exe, args) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(exe, args, { windowsHide: true });
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => resolve({ code: -1, out: out + e.message }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function zipList(file) {
  // 自己解析 zip：bsdtar 读 GBK 文件名会解成乱码，而且按名字提取会失败
  const list = await listEntries(file);
  return list.map((e) => e.name);
}

/** 把 zip 里某个成员取到内存 */
async function zipReadText(file, member) {
  try {
    return await zipReadMember(file, member);
  } catch (e) {
    throw new Error(`整合包内找不到 ${member}（${e.message}）`);
  }
}

async function unpackGameRoot(file, entries, prefix, dest) {
  const layers = gameLayers(entries, prefix);
  for (const layer of layers) {
    await zipExtract(file, dest, {
      prefix: layer,
      filter: (entry, rel) => !layers.some(other => other.length > layer.length && entry.name.toLowerCase().startsWith(other.toLowerCase()))
        && !rel.split('/').some(segment => segment.toLowerCase() === '__macosx'),
    });
  }
}

function plainLayers(entries, versionJson) {
  const layers = gameLayers(entries);
  if (versionJson) layers.push(...gameLayers(entries, versionJson.slice(0, versionJson.lastIndexOf('/') + 1)));
  return layers;
}

/**
 * 去掉包裹前缀，让后续逻辑按包根目录处理。
 */
function stripPrefix(entries, prefix) {
  if (!prefix) return entries;
  return entries
    .filter(e => e.startsWith(prefix))
    .map(e => e.slice(prefix.length))
    .filter(Boolean);
}

/**
 * 从文件名猜版本信息：PCL2 的导出命名形如「整合包名-1.20.1-Forge_47.4.20.zip」。
 * 认不出来就返回空，交给调用方兜底。
 */
function guessFromName(base) {
  const s = String(base || '');
  const m = s.match(/^(.*?)-(\d+\.\d+(?:\.\d+)?)-(Forge|NeoForge|Fabric|Vanilla)(?:[_-]([\w.+-]+))?$/i);
  if (!m) return { name: '', mc: null, loader: null, loaderVersion: null };
  const kind = m[3].toLowerCase();
  return {
    name: m[1].trim(),
    mc: m[2],
    loader: kind === 'vanilla' ? null : kind,
    loaderVersion: m[4] || null,
  };
}

function safeId(name) {
  return String(name || 'pack').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60).replace(/\.+$/, '') || 'pack';
}

function plainTarget(file, baseId) {
  const stem = safeId(path.basename(file, path.extname(file)));
  let id = stem;
  for (let n = 2; id.toLowerCase() === baseId?.toLowerCase() || fs.existsSync(versionDir(id)); n++) {
    id = stem + '-' + n;
  }
  return id;
}

async function writeProxyVersion(id, inheritsFrom) {
  const vd = versionDir(id);
  await ensureDir(vd);
  const json = {
    id,
    inheritsFrom,
    type: 'release',
    time: new Date().toISOString(),
    releaseTime: new Date().toISOString(),
  };
  await fsp.writeFile(versionJsonPath(id), JSON.stringify(json, null, 2), 'utf8');
}

/** 逐个下载整合包声明的文件 */
async function fetchFiles(packId, files, onProgress, label) {
  // 必须落在「这个版本的游戏目录」里：版本隔离时是 versions/<id>/game，
  // 否则内容页（走 gameDirFor）看不到刚下下来的模组
  const base = gameDirFor(packId);
  let done = 0;
  const failed = [];
  for (const f of files) {
    const rel = String(f.path || f.rel || '').replace(/\\/g, '/');
    if (!rel || rel.includes('..')) continue;
    const dest = path.join(base, rel);
    await ensureDir(path.dirname(dest));
    const urls = f.urls ?? (f.downloads ? [].concat(f.downloads) : []);
    if (!urls.length) { failed.push(rel); continue; }
    try {
      await downloadFile(urls, dest, { sha1: f.sha1 || '', size: f.size || undefined, retries: 2, idleMs: 25000 });
    } catch (e) {
      failed.push(`${rel}（${e.message}）`);
    }
    done++;
    onProgress({
      stage: 'files',
      percent: Math.round((done / files.length) * 100),
      text: `${label} ${done}/${files.length}`,
      log: failed.length && done === files.length ? '部分文件失败：' + failed.slice(0, 5).join(', ') : null,
    });
  }
  return failed;
}

/**
 * 导入整合包
 * @param {string} file 整合包路径
 */
/** 只解析不下载：导入前给用户看「会装什么、多大」 */
export async function inspectModpack(file) {
  const f = path.resolve(file);
  if (!fs.existsSync(f)) throw new Error('文件不存在：' + f);
  const raw = await zipList(f);
  if (!raw.length) throw new Error('无法读取压缩包内容');
  const prefix = wrapperPrefix(raw);
  const entries = stripPrefix(raw, prefix);
  const has = (name) => entries.some((e) => e.toLowerCase() === name.toLowerCase() || e.toLowerCase().startsWith(name.toLowerCase() + '/'));

  if (has('modrinth.index.json')) {
    const idx = JSON.parse(await zipReadText(f, prefix + 'modrinth.index.json'));
    const mc = idx.dependencies?.minecraft ?? null;
    const loader = idx.dependencies?.['fabric-loader'] ? 'fabric'
      : idx.dependencies?.neoforge ? 'neoforge'
        : idx.dependencies?.forge ? 'forge' : null;
    const loaderVersion = loader ? idx.dependencies?.[loader === 'fabric' ? 'fabric-loader' : loader] : null;
    const files = (idx.files ?? []).filter((x) => x.env?.client !== 'unsupported');
    return {
      format: 'modrinth',
      localMods: localModCount(entries, ['', ...gameLayers(entries, 'overrides/'), ...gameLayers(entries, 'client-overrides/')]),
      name: idx.name ?? path.basename(f),
      versionId: idx.versionId ?? '',
      mc, loader, loaderVersion,
      fileCount: files.length,
      totalSize: files.reduce((n, x) => n + (Number(x.fileSize) || 0), 0),
      overrides: ['overrides', 'client-overrides'].filter((d) => has(d)),
      targetId: `${safeId(idx.name ?? 'pack')}-${mc ?? 'unknown'}`,
    };
  }

  // ---------- TPCL 自己导出的包（根目录直接是 mods/ config/ …） ----------
  if (has('tpcl-export.json')) {
    const mk = JSON.parse(await zipReadText(f, prefix + 'tpcl-export.json'));
    const dirs = Array.isArray(mk.entries) ? mk.entries : [];
    return {
      format: 'tpcl',
      localMods: localModCount(entries, gameLayers(entries)),
      name: mk.name ?? path.basename(f),
      versionId: mk.name ?? '',
      mc: mk.mc ?? null,
      loader: mk.loader && mk.loader !== 'vanilla' ? mk.loader : null,
      loaderVersion: mk.loaderVersion ?? null,
      fileCount: entries.filter((e) => !e.endsWith('/')).length,
      totalSize: null,
      overrides: dirs,
      targetId: `${safeId(mk.name ?? 'export')}-${mk.mc ?? 'unknown'}`,
    };
  }

  if (has('manifest.json')) {
    const man = JSON.parse(await zipReadText(f, prefix + 'manifest.json'));
    const mc = man.minecraft?.version ?? null;
    const ml = (man.minecraft?.modLoaders ?? []).find((x) => x.primary) ?? man.minecraft?.modLoaders?.[0];
    let loader = null; let loaderVersion = null;
    const m = ml?.id ? String(ml.id).match(/^(forge|neoforge|fabric)[-_](.+)$/i) : null;
    if (m) { loader = m[1].toLowerCase(); loaderVersion = m[2]; }
    // 体积：CurseForge 清单里没有 size，只能并发查元数据（最多查 80 个，失败就留 null）
    const list = (man.files ?? []).slice(0, 80);
    let totalSize = null;
    if (list.length) {
      const metas = [];
      for (let i = 0; i < list.length; i += 8) {
        const chunk = list.slice(i, i + 8);
        const got = await Promise.all(chunk.map((x) => cfFileMeta(x.projectID, x.fileID).catch(() => null)));
        metas.push(...got);
      }
      const known = metas.filter((x) => x && x.fileLength > 0);
      if (known.length) totalSize = known.reduce((n, x) => n + x.fileLength, 0);
    }
    return {
      format: 'curseforge',
      localMods: localModCount(entries, ['', ...gameLayers(entries, (man.overrides || 'overrides') + '/')]),
      name: man.name ?? path.basename(f),
      version: man.version ?? '',
      mc, loader, loaderVersion,
      fileCount: (man.files ?? []).length,
      totalSize,
      sizeKnown: totalSize != null && totalSize > 0,
      overrides: has(man.overrides || 'overrides') ? [man.overrides || 'overrides'] : [],
      targetId: `${safeId(man.name ?? 'pack')}-${mc ?? 'unknown'}`,
    };
  }

  // PCL2 导出的整合包会带 PCL/Setup.ini（里面有目标版本），优先读它
  let pclSetup = null;
  try {
    const ini = raw.find((e) => /(^|\/)PCL\/Setup\.ini$/i.test(e));
    if (ini) {
      const text = await zipReadText(f, ini);
      const ver = (text.match(/^\s*Version\s*[=:]\s*(.+)$/im) || [])[1];
      if (ver) pclSetup = { version: ver.trim(), ini };
    }
  } catch { /* 读不到就忽略 */ }

  // 裸目录包：找 versions/<id>/<id>.json 反推继承的原版
  const vjson = plainVersion(entries);
  if (!vjson) {
    // 没有清单也没有 versions/：常见于「直接把 .minecraft 里的文件夹打包」的整合包
    const hitDirs = contentDirs.filter(has);
    if (!hitDirs.length) {
      const sample = entries.filter((e) => e && !e.endsWith('/')).slice(0, 6).join('、');
      throw new Error(`这不是可识别的整合包（没有 modrinth.index.json / manifest.json / versions，也找不到 mods、config 等目录）。`
        + `共 ${entries.length} 个条目，前几个是：${sample || '（空包）'}`);
    }
    let guess = guessFromName(path.basename(f, path.extname(f)));
    if (pclSetup?.version) {
      const g2 = guessFromName('x-' + pclSetup.version.replace(/\s+/g, '').replace(/\//g, '-'));
      if (g2.mc) guess = { name: guess.name, mc: g2.mc, loader: g2.loader || guess.loader, loaderVersion: g2.loaderVersion || guess.loaderVersion };
    }
    return {
      format: pclSetup ? 'pcl' : 'content',
      localMods: localModCount(entries, plainLayers(entries)),
      name: guess.name || path.basename(f, path.extname(f)),
      version: pclSetup?.version || '',
      mc: guess.mc,
      loader: guess.loader,
      loaderVersion: guess.loaderVersion,
      fileCount: entries.filter((e) => /\.jar$/i.test(e)).length,
      totalSize: null,
      overrides: hitDirs,
      targetId: plainTarget(f, loadConfig().selectedVersion),
    };
  }
  const innerId = vjson.split('/')[1];
  let mc = null;
  try {
    const j = JSON.parse(await zipReadText(f, prefix + vjson));
    mc = j.inheritsFrom ?? j.id ?? innerId;
  } catch { mc = innerId; }
  return {
    format: 'plain',
    localMods: localModCount(entries, plainLayers(entries, vjson)),
    name: path.basename(f, path.extname(f)),
    version: '',
    mc, loader: null, loaderVersion: null,
    fileCount: null,
    totalSize: null,
    overrides: [],
    targetId: plainTarget(f, innerId),
  };
}

export async function importModpack(file, onProgress = () => {}) {
  const f = path.resolve(file);
  if (!fs.existsSync(f)) throw new Error('文件不存在：' + f);
  const raw = await zipList(f);
  if (!raw.length) throw new Error('无法读取压缩包内容');
  // 被包了一层目录的整合包：逻辑上按包根目录处理，解压时再把前缀补回去
  const prefix = wrapperPrefix(raw);
  const entries = stripPrefix(raw, prefix);

  // 有的打包工具不写目录条目，只有 overrides/config/x 这种文件条目，所以要按前缀判断
  const has = (name) => entries.some((e) => e.toLowerCase() === name.toLowerCase() || e.toLowerCase().startsWith(name.toLowerCase() + '/'));

  // ---------- Modrinth ----------
  if (has('modrinth.index.json')) {
    onProgress({ stage: 'read', percent: 2, text: '读取 Modrinth 整合包…' });
    const idx = JSON.parse(await zipReadText(f, prefix + 'modrinth.index.json'));
    const mc = idx.dependencies?.minecraft;
    if (!mc) throw new Error('整合包没有声明 Minecraft 版本');
    const loaderKind = idx.dependencies?.['fabric-loader']
      ? 'fabric'
      : idx.dependencies?.neoforge
        ? 'neoforge'
        : idx.dependencies?.forge
          ? 'forge'
          : null;
    const loaderVer = loaderKind ? idx.dependencies?.[loaderKind === 'fabric' ? 'fabric-loader' : loaderKind] : null;

    let baseId = mc;
    if (loaderKind) {
      const r = await installLoader({ kind: loaderKind, mc, version: loaderVer, onProgress });
      baseId = r.id;
    } else {
      await installVersion(mc, { onProgress });
    }

    const packId = `${safeId(idx.name)}-${mc}`;
    await writeProxyVersion(packId, baseId);

    const files = (idx.files ?? [])
      .filter((x) => x.env?.client !== 'unsupported')
      .map((x) => ({ path: x.path, urls: x.downloads ?? [], sha1: x.hashes?.sha1, size: x.fileSize }));
    onProgress({ stage: 'files', percent: 5, text: `下载 ${files.length} 个文件…` });
    const failed = await fetchFiles(packId, files, onProgress, '文件');

    if (has('mods')) await zipExtract(f, gameDirFor(packId), { prefix, filter: (_, rel) => /^mods\//i.test(rel) });
    for (const dir of ['overrides', 'client-overrides']) {
      if (has(dir)) {
        onProgress({ stage: 'overrides', percent: 95, text: `解压 ${dir}…` });
        await unpackGameRoot(f, raw, prefix + dir + '/', gameDirFor(packId));
      }
    }
    if (!failed.length) onProgress({ stage: 'done', percent: 100, text: `整合包已导入：${packId}`, id: packId });
    return { ok: !failed.length, id: packId, name: idx.name, mc, loader: loaderKind, version: loaderVer, failed };
  }

  // ---------- TPCL 自己导出的包 ----------
  if (has('tpcl-export.json')) {
    onProgress({ stage: 'read', percent: 2, text: '读取 TPCL 导出包…' });
    const mk = JSON.parse(await zipReadText(f, prefix + 'tpcl-export.json'));
    const mc = mk.mc;
    if (!mc) throw new Error('导出包没有声明 Minecraft 版本');
    const loaderKind = mk.loader && mk.loader !== 'vanilla' && mk.loaderVersion ? mk.loader : null;
    let baseId = mc;
    if (loaderKind) {
      const r = await installLoader({ kind: loaderKind, mc, version: mk.loaderVersion, onProgress });
      baseId = r.id;
    } else {
      await installVersion(mc, { onProgress });
    }
    const packId = `${safeId(mk.name || 'tpcl-export')}-${mc}`;
    await writeProxyVersion(packId, baseId);
    const gameDir = gameDirFor(packId);
    await ensureDir(gameDir);
    onProgress({ stage: 'files', percent: 60, text: '解压文件…' });
    // 整包解到游戏目录（根目录就是 mods/config/…），再删掉 marker，避免污染 mods 扫描
    await unpackGameRoot(f, raw, prefix, gameDir);
    await fsp.rm(path.join(gameDir, 'tpcl-export.json'), { force: true });
    const failed = [];
    onProgress({ stage: 'done', percent: 100, text: `整合包已导入：${packId}`, id: packId });
    return { ok: true, id: packId, name: mk.name, mc, loader: loaderKind, version: mk.loaderVersion || null, failed };
  }

  // ---------- CurseForge ----------
  if (has('manifest.json')) {
    onProgress({ stage: 'read', percent: 2, text: '读取 CurseForge 整合包…' });
    const man = JSON.parse(await zipReadText(f, prefix + 'manifest.json'));
    const mc = man.minecraft?.version;
    if (!mc) throw new Error('manifest.json 没有声明 Minecraft 版本');
    const ml = (man.minecraft?.modLoaders ?? []).find((x) => x.primary) ?? man.minecraft?.modLoaders?.[0];
    let loaderKind = null;
    let loaderVer = null;
    if (ml?.id) {
      const m = String(ml.id).match(/^(forge|neoforge|fabric)[-_](.+)$/i);
      if (m) {
        loaderKind = m[1].toLowerCase();
        loaderVer = m[2];
      }
    }

    let baseId = mc;
    if (loaderKind) {
      const r = await installLoader({ kind: loaderKind, mc, version: loaderVer, onProgress });
      baseId = r.id;
    } else {
      await installVersion(mc, { onProgress });
    }

    const packId = `${safeId(man.name)}-${mc}`;
    await writeProxyVersion(packId, baseId);

    const files = [];
    const skipped = [];
    for (const item of man.files ?? []) {
      const meta = await cfFileMeta(item.projectID, item.fileID).catch(() => null);
      if (!meta?.downloadUrl) { if (item.required !== false) skipped.push(`${item.projectID}/${item.fileID}`); continue; }
      files.push({ path: `mods/${path.basename(meta.fileName)}`, urls: [meta.downloadUrl] });
    }
    onProgress({
      stage: 'files',
      percent: 5,
      text: `下载 ${files.length} 个文件${skipped.length ? `（${skipped.length} 个拿不到下载地址）` : ''}…`,
    });
    const failed = await fetchFiles(packId, files, onProgress, '文件');

    const ov = man.overrides || 'overrides';
    if (has('mods')) await zipExtract(f, gameDirFor(packId), { prefix, filter: (_, rel) => /^mods\//i.test(rel) });
    if (has(ov)) {
      onProgress({ stage: 'overrides', percent: 95, text: '解压 overrides…' });
      await unpackGameRoot(f, raw, prefix + ov + '/', gameDirFor(packId));
    }
    if (!failed.length && !skipped.length) onProgress({ stage: 'done', percent: 100, text: `整合包已导入：${packId}`, id: packId });
    return { ok: !failed.length && !skipped.length, id: packId, name: man.name, mc, loader: loaderKind, version: loaderVer, failed: [...failed, ...skipped], skipped,
      error: skipped.length ? `${skipped.length} 个必需模组无法取得下载地址，请检查下载源配置或作者的下载许可` : undefined };
  }

  // ---------- 裸目录包 ----------
  onProgress({ stage: 'read', percent: 2, text: '未发现清单，按目录包导入…' });
  const vjson = plainVersion(entries);
  let baseMc = vjson?.split('/')[1];
  if (!baseMc) {
    // 纯内容包（只有 mods/config/…）：按文件名猜版本，猜不到就跟随当前选中版本
    const guess = guessFromName(path.basename(f, path.extname(f)));
    const withLoader = guess.mc && guess.loader;
    if (withLoader) {
      onProgress({ stage: 'read', percent: 5, text: `按文件名判定：${guess.mc} / ${guess.loader} ${guess.loaderVersion || ''}` });
      const r = await installLoader({ kind: guess.loader, mc: guess.mc, version: guess.loaderVersion || undefined, onProgress });
      baseMc = r.id;
    } else {
      const cfg = loadConfig();
      if (!cfg.selectedVersion) throw new Error('这个包没有清单，文件名里也读不出游戏版本；请先选一个已安装的版本再导入');
      await fsp.access(versionJsonPath(cfg.selectedVersion));
      baseMc = cfg.selectedVersion;
      onProgress({ stage: 'read', percent: 5, text: `按当前版本判定：继承 ${baseMc}` });
    }
  }
  const packId = plainTarget(f, baseMc);
  const gameDir = gameDirFor(packId);
  onProgress({ stage: 'files', percent: 20, text: '解压整合包内容…' });
  if (!vjson) {
    await unpackGameRoot(f, raw, prefix, gameDir);
  } else {
    const mcDir = loadConfig().mcDir;
    // Restore shared version metadata and resources, preserving already installed files.
    await zipExtract(f, mcDir, {
      prefix,
      filter: (_, rel) => /^(assets|libraries)\//i.test(rel) || /^versions\/([^/]+)\/\1\.(json|jar)$/i.test(rel),
      keepExisting: true,
    });
    const isContent = (_, rel) => contentDirs.includes(rel.split('/')[0].toLowerCase())
      || ['options.txt', 'servers.dat'].includes(rel.toLowerCase());
    for (const root of plainLayers(entries, vjson)) {
      await zipExtract(f, gameDir, { prefix: prefix + root, filter: isContent });
    }
  }
  await writeProxyVersion(packId, baseMc);
  onProgress({ stage: 'done', percent: 100, text: `整合包已导入：${packId}`, id: packId });
  return { ok: true, id: packId, name: packId, mc: baseMc, failed: [] };
}

/**
 * 把当前版本导出成整合包 zip（根目录直接放 mods/config/…，本启动器和其它启动器都能再导入）
 * @param {string} versionId
 * @param {{includeSaves?: boolean}} opts
 */
export async function exportModpack(versionId, opts = {}) {
  const id = String(versionId || '').trim();
  if (!id) throw new Error('没有指定版本');
  if (!fs.existsSync(versionJsonPath(id))) throw new Error(`版本不存在：${id}`);
  const json = JSON.parse(await fsp.readFile(versionJsonPath(id), 'utf8'));
  const gameDir = gameDirFor(id);
  if (!fs.existsSync(gameDir)) throw new Error(`游戏目录不存在：${gameDir}`);

  const candidates = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'datapacks', 'options.txt', 'servers.dat'];
  if (opts.includeSaves) candidates.push('saves');
  const picked = candidates.filter((name) => fs.existsSync(path.join(gameDir, name)));
  if (!picked.length) throw new Error('这个版本的目录里没有可导出的内容（mods/config/资源包都没有）');

  const outDir = path.join(process.env.TPCL_DATA_DIR || path.join(process.cwd(), 'data'), 'exports');
  await ensureDir(outDir);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const safe = id.replace(/[\\/:*?"<>|]/g, '_');
  let outFile = path.join(outDir, `${safe}-${stamp}.zip`);
  for (let n = 2; fs.existsSync(outFile); n += 1) outFile = path.join(outDir, `${safe}-${stamp}-${n}.zip`);

  // 从版本 id 里拆出「加载器 + 加载器版本」：fabric-loader-0.20.1-1.21.1 / 1.21.1-forge-52.1.21 / 1.21.1-Forge_52.1.20
  let loader = 'vanilla';
  let loaderVersion = '';
  const mFab = id.match(/^fabric-loader-(.+)-(\d+\.\d+(?:\.\d+)?)$/);
  const mNeo = id.match(/^(.*?)-neoforge-(.+)$/i);
  const mForge = id.match(/^(.*?)-(?:forge)[-_](.+)$/i);
  if (mFab) { loader = 'fabric'; loaderVersion = mFab[1]; }
  else if (mNeo) { loader = 'neoforge'; loaderVersion = mNeo[2]; }
  else if (mForge) { loader = 'forge'; loaderVersion = mForge[2]; }

  // 写一个自己的标记文件，导入时能认出「这是 TPCL 导出的裸包」并还原加载器
  const marker = {
    format: 'tpcl-export/1',
    name: id,
    mc: json.inheritsFrom || json.id,
    loader,
    loaderVersion,
    createdAt: new Date().toISOString(),
    entries: picked,
  };
  await fsp.writeFile(path.join(gameDir, 'tpcl-export.json'), JSON.stringify(marker, null, 2), 'utf8');

  const r = await run(TAR, ['-a', '-c', '-f', outFile, '-C', gameDir, ...picked, 'tpcl-export.json']);
  await fsp.rm(path.join(gameDir, 'tpcl-export.json'), { force: true });
  if (r.code !== 0 || !fs.existsSync(outFile)) throw new Error(`打包失败：${r.out.trim().slice(0, 300)}`);

  const st = await fsp.stat(outFile);
  return { ok: true, file: outFile, bytes: st.size, entries: picked, name: id };
}

/** CurseForge 文件信息（公开端点，拿不到就返回 null） */
async function cfFileMeta(projectID, fileID) {
  const { sourceStatus, fileMetadata, downloadUrlOf } = await import('./cf.js');
  if (sourceStatus().configured) {
    const data = await fileMetadata(projectID, fileID);
    if (!data.downloadUrl) data.downloadUrl = await downloadUrlOf(projectID, fileID);
    return data;
  }
  const url = `https://www.curseforge.com/api/v1/mods/${projectID}/files/${fileID}`;
  const res = await fetch(url, { headers: { 'user-agent': 'TPCL/1.0', accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const j = await res.json();
  const d = j.data ?? j;
  return {
    fileName: d.fileName,
    downloadUrl: d.downloadUrl,
    fileLength: Number(d.fileLength ?? d.fileSize ?? 0) || 0,
  };
}
