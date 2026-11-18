// CurseForge 官方目录、文件下载及必需前置安装；密钥保存在本机 secrets.json。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadConfig, gameDirFor } from './config.js';
import { modContext, resourceContext, compatible, planDependencies } from './mod-dependencies.js';
import { ensureDir, downloadFile } from './download.js';

const API = 'https://api.curseforge.com/v1';
const GAME_ID = 432;            // Minecraft
export const CLASS_ID = { mods: 6, resourcepack: 12, world: 17, modpack: 4471, shader: 6552 };

let keyCache = null;
export function sourceStatus() { return { configured: !!apiKey() }; }
export function saveApiKey(key) {
  const file = path.join(DATA_DIR, 'secrets.json');
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  data.curseforge = { ...data.curseforge, apiKey: String(key || '').trim() };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  keyCache = null;
  return sourceStatus();
}
export async function searchCatalog({ kind = 'mod', query = '', offset = 0, mc = '', loader = '', sort = 'downloads' } = {}) {
  const classes = { mod: 6, modpack: 4471, resourcepack: 12, shader: 6552 };
  if (!classes[kind]) throw new Error('不支持的资源类型');
  const q = new URLSearchParams({ gameId: '432', classId: String(classes[kind]), searchFilter: query, pageSize: String(Math.min(24, 10000 - Math.max(0, Math.min(9999, Number(offset) || 0)))), index: String(Math.max(0, Math.min(9999, Number(offset) || 0))), sortField: String(({downloads:6, relevance:1, newest:11, updated:3, follows:2})[sort] || 6), sortOrder: 'desc' });
  if (mc) q.set('gameVersion', mc);
  if (loaderType(loader)) q.set('modLoaderType', String(loaderType(loader)));
  const data = await cfGet('/mods/search?' + q);
  return { total: data.pagination?.totalCount || 0, hits: (data.data || []).map(d => ({ id: String(d.id), title: d.name, description: d.summary, icon: d.logo?.thumbnailUrl, downloads: d.downloadCount, author: (d.authors || []).map(a => a.name).join(', ') })) };
}
export async function fileMetadata(modId, fileId) { return (await cfGet(`/mods/${Number(modId)}/files/${Number(fileId)}`)).data; }
function apiKey() {
  if (keyCache !== null) return keyCache;
  try {
    const sec = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'secrets.json'), 'utf8'));
    keyCache = String(sec?.curseforge?.apiKey || '').trim();
  } catch {
    keyCache = '';
  }
  return keyCache;
}

async function cfGet(p, { timeoutMs = 15000 } = {}) {
  const key = apiKey();
  if (!key) throw new Error('没有配置 CurseForge API Key（data/secrets.json）');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('请求超时')), timeoutMs);
  try {
    const r = await fetch(`${API}${p}`, {
      headers: { 'x-api-key': key, accept: 'application/json', 'user-agent': 'TPCL/1.0.0 (personal minecraft launcher)' },
      signal: ac.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 200);
      try { msg = JSON.parse(text)?.error ?? msg; } catch {}
      const err = new Error(`CurseForge ${r.status}：${msg}`);
      err.status = r.status;
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** CF 的 modLoaderType：1=Forge 4=Fabric 5=Quilt 6=NeoForge */
export function loaderType(loader) {
  if (loader === 'forge') return 1;
  if (loader === 'fabric') return 4;
  if (loader === 'quilt') return 5;
  if (loader === 'neoforge') return 6;
  return undefined;
}

/** 从「数字 ID / slug / 网页链接」里取出能查的东西 */
export function parseRef(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d{3,}$/.test(s)) return { kind: 'id', value: Number(s) };
  const m = s.match(/curseforge\.com\/minecraft\/(?:mc-mods|texture-packs|shaders|modpacks|worlds)\/([a-z0-9-]+)/i);
  if (m) return { kind: 'slug', value: m[1] };
  if (/^[a-z0-9][a-z0-9-]{1,60}$/i.test(s)) return { kind: 'slug', value: s.toLowerCase() };
  return null;
}

export async function getMod(id) {
  const j = await cfGet(`/mods/${Number(id)}`);
  const d = j.data;
  return {
    id: d.id,
    name: d.name,
    slug: d.slug,
    summary: d.summary ?? '',
    downloads: d.downloadCount ?? 0,
    icon: d.logo?.thumbnailUrl ?? d.logo?.url ?? '',
    links: { website: d.links?.websiteUrl ?? '' },
    classId: d.classId,
    dateModified: d.dateModified,
    authors: (d.authors ?? []).map((a) => a.name),
  };
}

/** 按 slug 找 ID（CF 没有公开的 slug 查询接口，只能借 search —— 它 403，所以退化成让用户给 ID） */
export async function resolveModRef(ref) {
  const parsed = parseRef(ref);
  if (!parsed) throw new Error('看不懂这个 CurseForge 引用，请填项目 ID（纯数字）或 mc-mods 链接');
  if (parsed.kind === 'id') return getMod(parsed.value);
  const data = await cfGet('/mods/search?' + new URLSearchParams({ gameId: '432', slug: parsed.value }));
  const found = data.data?.find(d => d.slug === parsed.value);
  if (!found) throw new Error('没有找到这个 CurseForge 项目');
  return getMod(found.id);
}

export async function listFiles(modId, { mcVer, loader, pageSize = 20, offset = 0 } = {}) {
  const q = new URLSearchParams({ pageSize: String(Math.max(1, Math.min(50, pageSize))), index: String(Math.max(0, Number(offset) || 0)) });
  if (mcVer) q.set('gameVersion', mcVer);
  const lt = loaderType(loader);
  if (lt) q.set('modLoaderType', String(lt));
  const j = await cfGet(`/mods/${Number(modId)}/files?${q}`);
  return (j.data ?? []).map((f) => ({
    id: f.id,
    name: f.displayName || f.fileName,
    fileName: f.fileName,
    size: f.fileLength ?? 0,
    date: f.fileDate,
    releaseType: f.releaseType, // 1 release / 2 beta / 3 alpha
    downloadUrl: f.downloadUrl || '',
    gameVersions: f.gameVersions ?? [],
  }));
}

export async function downloadUrlOf(modId, fileId) {
  const j = await cfGet(`/mods/${Number(modId)}/files/${Number(fileId)}/download-url`);
  return j.data;
}

function subDirForClass(classId) {
  if (classId === CLASS_ID.resourcepack) return 'resourcepacks';
  if (classId === CLASS_ID.shader) return 'shaderpacks';
  if (classId === CLASS_ID.world) return 'saves';
  if (classId === CLASS_ID.modpack) return 'modpacks';
  return 'mods';
}

/** 把某个 CF 文件装进目标版本的对应目录 */
export async function installCfFile({ modId, fileId, target, classId = CLASS_ID.mods, onProgress = () => {} }) {
  if (!target && classId !== CLASS_ID.modpack) throw new Error('没有选中版本');
  if (classId === CLASS_ID.mods) {
    const ctx = modContext(target);
    const plan = await planDependencies({ projectId: modId, versionId: fileId }, async ref => {
      let id = ref.versionId;
      if (!id) {
        // Page through the filtered catalog instead of silently using an unrelated latest file.
        for (let offset = 0; offset < 10000; offset += 50) {
          const files = await listFiles(ref.projectId, { ...ctx, pageSize: 50, offset });
          const hit = files.filter(f => compatible(f.gameVersions, f.gameVersions, ctx)).sort((a,b) => Date.parse(b.date) - Date.parse(a.date))[0];
          if (hit) { id = hit.id; break; }
          if (files.length < 50) break;
        }
        if (!id) throw new Error('没有适配 ' + ctx.mcVer + ' / ' + ctx.loaderName + ' 的必需前置文件');
      }
      const f = await fileMetadata(ref.projectId, id);
      if (!f || String(f.id) !== String(id) || String(f.modId) !== String(ref.projectId)) throw new Error('下载源返回了其他项目或版本的文件');
      if (!compatible(f.gameVersions, f.gameVersions, ctx)) throw new Error((f.displayName || f.fileName) + ' 不适配 ' + ctx.mcVer + ' / ' + ctx.loaderName);
      if (f.isAvailable === false) throw new Error('此前置文件已被下载源停用');
      const url = f.downloadUrl || await downloadUrlOf(ref.projectId, id);
      if (!url) throw new Error('作者关闭了此前置文件的第三方下载');
      const deps = relation => (f.dependencies || []).filter(d => d.relationType === relation).map(d => ({ projectId: d.modId }));
      return { projectId: f.modId, versionId: f.id, name: f.displayName || f.fileName,
        required: deps(3), incompatible: deps(5),
        file: { filename: f.fileName, url, size: f.fileLength || 0, sha1: f.hashes?.find(h => h.algo === 1)?.value || '' } };
    }, onProgress);
    const installed = [];
    for (const [index, item] of plan.entries()) {
      const f = item.file;
      onProgress({ stage: 'download', percent: 5 + Math.floor(index / plan.length * 94), text: '下载模组及前置（' + (index + 1) + '/' + plan.length + '）：' + f.filename });
      try {
        await downloadFile([f.url], path.join(gameDirFor(target), 'mods', f.filename), { size: f.size, sha1: f.sha1, retries: 2, connectTimeoutMs: 20000, idleMs: 30000 });
      } catch (cause) { throw new Error('模组或必需前置下载失败：' + item.name + '：' + cause.message, { cause }); }
      installed.push({ projectId: item.projectId, fileId: item.versionId, filename: f.filename });
    }
    onProgress({ stage: 'done', percent: 100, text: '模组及 ' + (plan.length - 1) + ' 个必需前置已安装' });
    return { ok: true, target, dir: 'mods', file: installed.at(-1).filename, installed };
  }
  const f = await fileMetadata(modId, fileId);
  let url = f?.downloadUrl;
  if (!url) url = await downloadUrlOf(modId, fileId);
  if (!url) throw new Error('这个文件作者关闭了第三方下载');
  const sub = subDirForClass(classId);
  const dir = classId === CLASS_ID.modpack ? path.join(DATA_DIR, 'cache', 'cf-packs', String(modId), String(fileId)) : path.join(gameDirFor(target), sub);
  await ensureDir(dir);
  const name = path.basename(f?.fileName || `${modId}-${fileId}.jar`);
  const dest = path.join(dir, name);
  onProgress?.({ stage: 'download', percent: 5, text: `下载 ${name}` });
  let received = 0;
  await downloadFile([url], dest, {
    size: f.fileLength || 0, sha1: f.hashes?.find(h => h.algo === 1)?.value || '',
    retries: 2, connectTimeoutMs: 20000, idleMs: 30000,
    onBytes: (got, total) => {
      received += got;
      if (total) onProgress?.({ stage: 'download', percent: Math.min(95, 5 + Math.round((received / total) * 90)), text: `下载 ${name}` });
    },
  });
  if (classId === CLASS_ID.modpack) {
    const { importModpack } = await import('./modpack.js');
    return importModpack(dest, onProgress);
  }
  onProgress?.({ stage: 'done', percent: 100, text: `已安装 ${name}` });
  return { ok: true, file: name, dir: sub, target };
}

/** 目标版本的 MC 版本与加载器（给文件筛选用） */
export async function targetContext(versionId) {
  try { return resourceContext(versionId || loadConfig().selectedVersion); }
  catch { return { mcVer: '', loader: '' }; }
}

export async function ping() {
  const j = await cfGet('/games');
  return { ok: true, games: (j.data ?? []).length };
}
