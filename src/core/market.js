// 在线资源（Modrinth）：搜索、版本列表、安装模组/资源包/光影/整合包
// 之所以选 Modrinth 而不是 CurseForge：它的公开 API 不需要 API Key，也不需要 CDN 鉴权。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, loadConfig } from './config.js';
import { ensureDir, downloadFile } from './download.js';
import { versionDir } from './version.js';
import { modContext, resourceContext, compatible, planDependencies } from './mod-dependencies.js';
import { importModpack } from './modpack.js';

const API = 'https://api.modrinth.com/v2';
const UA = 'TPCL/1.0.0 (personal minecraft launcher)';

async function jget(url, { retries = 2, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('请求超时')), timeoutMs);
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: ac.signal,
      });
      if (r.status === 404) throw new Error('资源不存在（404）');
      if (!r.ok) throw new Error(`Modrinth 返回 ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((res) => setTimeout(res, 500 + i * 700));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

const TYPE_ZH = { mod: '模组', modpack: '整合包', resourcepack: '资源包', shader: '光影', datapack: '数据包' };

/** POST 到 Modrinth（带重试与超时） */
async function jpost(url, body, { retries = 2, timeoutMs = 25000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('请求超时')), timeoutMs);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!r.ok) throw new Error(`Modrinth 返回 ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((res) => setTimeout(res, 500 + i * 700));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

/**
 * 按文件 SHA-1 批量查更新：Modrinth 的 version_files/update。
 * 返回 { [sha1]: version }，只包含“有更新”的那些；文件本来是最新版就不会出现在结果里。
 */
export async function checkUpdates(hashes, { mcVer = '', loader = '' } = {}) {
  const list = [...new Set(hashes.filter(Boolean))];
  if (!list.length) return {};
  const body = { hashes: list, algorithm: 'sha1' };
  if (mcVer) body.game_versions = [mcVer];
  if (loader) body.loaders = [loader];
  const res = await jpost(`${API}/version_files/update`, body);
  const out = {};
  for (const [hash, v] of Object.entries(res || {})) {
    const file = (v.files ?? []).find((f) => f.primary) ?? (v.files ?? [])[0];
    out[hash] = {
      versionId: v.id,
      projectId: v.project_id,
      versionNumber: v.version_number,
      name: v.name,
      type: v.version_type,
      date: v.date_published,
      gameVersions: v.game_versions ?? [],
      loaders: v.loaders ?? [],
      file: file ? { url: file.url, filename: file.filename, size: file.size, sha1: file.hashes?.sha1 ?? '' } : null,
    };
  }
  return out;
}

/** 搜索项目 */
export async function searchProjects({ kind = 'mod', query = '', mcVer = '', loader = '', limit = 20, offset = 0, sort = '' } = {}) {
  const facets = [];
  if (kind) facets.push([`project_type:${kind}`]);
  if (mcVer) facets.push([`versions:${mcVer}`]);
  // 光影和资源包没有加载器概念，别加这个 facet，否则搜不到东西
  if (loader && (kind === 'mod' || kind === 'modpack')) facets.push([`categories:${loader}`]);

  const SORTS = new Set(['relevance', 'downloads', 'follows', 'newest', 'updated']);
  const index = SORTS.has(String(sort || '')) ? String(sort) : 'relevance';
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset), index });
  if (query) params.set('query', query);
  if (facets.length) params.set('facets', JSON.stringify(facets));

  const data = await jget(`${API}/search?${params}`);
  return {
    total: data.total_hits ?? 0,
    hits: (data.hits ?? []).map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      follows: h.follows,
      icon: h.icon_url,
      categories: h.categories ?? [],
      versions: (h.versions ?? []).slice(-6),
      type: h.project_type,
      typeZh: TYPE_ZH[h.project_type] ?? h.project_type,
    })),
  };
}

/** 某个项目可用的版本（按游戏版本/加载器过滤） */
export async function listProjectVersions(id, { mcVer = '', loader = '' } = {}) {
  const q = new URLSearchParams();
  if (mcVer) q.set('game_versions', JSON.stringify([mcVer]));
  if (loader) q.set('loaders', JSON.stringify([loader]));
  const list = await jget(`${API}/project/${encodeURIComponent(id)}/version?${q}`);
  return (list ?? []).map((v) => ({
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    type: v.version_type,
    date: v.date_published,
    downloads: v.downloads,
    gameVersions: v.game_versions ?? [],
    loaders: v.loaders ?? [],
    dependencies: (v.dependencies ?? []).map((d) => ({
      projectId: d.project_id, versionId: d.version_id, type: d.dependency_type,
    })),
    files: (v.files ?? []).map((f) => ({
      url: f.url, filename: f.filename, size: f.size, primary: Boolean(f.primary),
      sha1: f.hashes?.sha1 ?? '',
    })),
  }));
}

/** 批量取项目摘要（用于把依赖 id 变成名字） */
export async function getProjects(ids) {
  const list = [...new Set((ids || []).filter(Boolean))].slice(0, 60);
  if (!list.length) return [];
  const q = new URLSearchParams({ ids: JSON.stringify(list) });
  const arr = await jget(`${API}/projects?${q}`);
  return (arr ?? []).map((p) => ({
    id: p.id, slug: p.slug, title: p.title, icon: p.icon_url ?? '',
    downloads: p.downloads ?? 0, description: p.description ?? '',
  }));
}

/** 项目详情（简介 / 正文 / 统计数据） */
export async function getProject(id) {
  const p = await jget(`${API}/project/${encodeURIComponent(id)}`);
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    body: p.body ?? '',
    icon: p.icon_url ?? '',
    downloads: p.downloads ?? 0,
    followers: p.followers ?? 0,
    categories: p.categories ?? [],
    loaders: p.loaders ?? [],
    gameVersions: p.game_versions ?? [],
    sourceUrl: p.source_url ?? '',
    issuesUrl: p.issues_url ?? '',
    license: p.license?.name ?? p.license?.id ?? '',
    updated: p.updated,
  };
}

/** 项目所属的 MOD 放哪个目录 */
function subDirFor(type) {
  switch (type) {
    case 'resourcepack': return 'resourcepacks';
    case 'shader': return 'shaderpacks';
    case 'datapack': return 'datapacks';
    case 'mod': return 'mods';
    default: return 'mods';
  }
}

function pickFile(ver) {
  const files = ver.files ?? [];
  return files.find((f) => f.primary) ?? files[0] ?? null;
}

/** 装单个版本（含必需依赖，只递归一层半） */
export async function installProjectVersion({ projectId, versionId, target, type = 'mod', onProgress = () => {} }) {
  if (!target) throw new Error('没有选中的游戏版本');
  // Non-mod resources retain their existing directory and do not pull mod dependencies.
  if (type !== 'mod') {
    const versions = await listProjectVersions(projectId);
    const ver = versionId ? versions.find(v => v.id === versionId) : versions[0];
    if (!ver) throw new Error('指定资源版本不存在');
    const file = pickFile(ver);
    if (!file) throw new Error('版本中没有可下载文件');
    const sub = subDirFor(type), filename = path.basename(file.filename);
    await downloadFile([file.url], path.join(versionDir(target), sub, filename), { sha1: file.sha1, size: file.size, retries: 2, idleMs: 25000 });
    return [{ projectId, filename, dir: sub, version: ver.versionNumber }];
  }
  const ctx = modContext(target);
  const plan = await planDependencies({ projectId, versionId }, async ref => {
    let v;
    if (ref.versionId) {
      v = await jget(API + '/version/' + encodeURIComponent(ref.versionId));
      if (ref.projectId && v.project_id !== ref.projectId) throw new Error('指定版本不属于此前置项目');
    } else {
      if (!ref.projectId) throw new Error('作者未提供可下载的前置项目或版本编号');
      const versions = await listProjectVersions(ref.projectId, ctx);
      const hit = versions.filter(v => compatible(v.gameVersions, v.loaders, ctx))
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
      if (!hit) throw new Error('没有适配 ' + ctx.mcVer + ' / ' + ctx.loaderName + ' 的必需前置版本');
      v = await jget(API + '/version/' + encodeURIComponent(hit.id));
      if (v.project_id !== ref.projectId) throw new Error('下载源返回了其他项目的文件');
    }
    if (!compatible(v.game_versions, v.loaders, ctx)) throw new Error((v.name || v.id) + ' 不适配 ' + ctx.mcVer + ' / ' + ctx.loaderName);
    const f = v.files?.find(f => f.primary) || v.files?.[0];
    if (!f?.url) throw new Error('此前置版本没有可下载文件');
    const deps = kind => (v.dependencies || []).filter(d => d.dependency_type === kind).map(d => ({ projectId: d.project_id, versionId: d.version_id, filename: d.file_name }));
    return { projectId: v.project_id, versionId: v.id, name: v.name || v.project_id, version: v.version_number,
      required: deps('required'), incompatible: deps('incompatible'),
      file: { filename: f.filename, url: f.url, size: f.size, sha1: f.hashes?.sha1 || '' } };
  }, onProgress);
  const installed = [];
  for (const [index, item] of plan.entries()) {
    const f = item.file;
    onProgress({ stage: 'download', percent: 5 + Math.floor(index / plan.length * 94), text: '下载模组及前置（' + (index + 1) + '/' + plan.length + '）：' + f.filename });
    try {
      await downloadFile([f.url], path.join(versionDir(target), 'mods', f.filename), { sha1: f.sha1, size: f.size, retries: 2, idleMs: 25000 });
    } catch (cause) { throw new Error('模组或必需前置下载失败：' + item.name + '：' + cause.message, { cause }); }
    installed.push({ projectId: item.projectId, filename: f.filename, dir: 'mods', version: item.version });
  }
  onProgress({ stage: 'done', percent: 100, text: '模组及 ' + (plan.length - 1) + ' 个必需前置已安装' });
  return installed;
}

/** 从 Modrinth 直接装整合包（.mrpack 交给 importModpack） */
export async function installModpackProject({ projectId, versionId, onProgress = () => {} }) {
  const versions = await listProjectVersions(projectId);
  const ver = versions.find((v) => v.id === versionId) ?? versions[0];
  if (!ver) throw new Error('这个整合包没有可用版本');
  const file = pickFile(ver);
  if (!file) throw new Error('整合包版本里没有可下载文件');

  const cacheDir = path.join(DATA_DIR, 'cache', 'modpacks');
  await ensureDir(cacheDir);
  const dest = path.join(cacheDir, file.filename);
  onProgress({ stage: 'download', percent: 3, text: `下载整合包 ${file.filename}（${(file.size / 1048576).toFixed(1)} MB）…` });
  await downloadFile([file.url], dest, { sha1: file.sha1, size: file.size, retries: 2, idleMs: 30000 });

  onProgress({ stage: 'import', percent: 40, text: '开始解包安装…' });
  const r = await importModpack(dest, (p) => {
    onProgress({ stage: p.stage, percent: 40 + Math.round((p.percent ?? 0) * 0.6), text: p.text });
  });
  return { ...r, file: dest };
}

/** 当前选中版本对应的 MC 版本与加载器，供搜索过滤用 */
export function versionContext(versionId) {
  try { return resourceContext(versionId); }
  catch { return { mcVer: '', loader: '', loaderName: '原版' }; }
}

export { TYPE_ZH };
