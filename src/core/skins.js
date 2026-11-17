// 皮肤：按名字查 UUID / 预览图，正版账号上传与还原
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, loadConfig } from './config.js';

const MOJANG = 'https://api.mojang.com';
const MC_API = 'https://api.minecraftservices.com';
const HEADS = 'https://mc-heads.net';

const UA = 'TPCL/1.0.0 (personal minecraft launcher)';

async function jget(url, { token, timeoutMs = 15000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('请求超时')), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'user-agent': UA, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = text.slice(0, 300);
      throw err;
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

/** 查正版档案：支持名字或 UUID（返回 {name, uuid(带连字符)}） */
export async function lookupProfile(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('请输入玩家名或 UUID');
  const isUuid = /^[0-9a-f]{32}$/i.test(q.replace(/-/g, ''));
  if (isUuid) {
    const raw = q.replace(/-/g, '').toLowerCase();
    const j = await jget(`${MOJANG}/user/profile/${raw}`);
    const id = String(j.id || raw).toLowerCase();
    return { name: j.name, uuid: dash(id), raw: id };
  }
  const j = await jget(`${MOJANG}/users/profiles/minecraft/${encodeURIComponent(q)}`);
  const id = String(j.id || '').toLowerCase();
  return { name: j.name, uuid: dash(id), raw: id };
}


/** 从 sessionserver 拿皮肤/披风贴图地址（CAPE 只有正版玩家有） */
export async function profileTextures(uuid) {
  const raw = String(uuid || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(raw)) return { skin: '', cape: '' };
  let j;
  try {
    j = await jget(`https://sessionserver.mojang.com/session/minecraft/profile/${raw}`);
  } catch {
    return { skin: '', cape: '' };
  }
  const prop = (j.properties || []).find((p) => p.name === 'textures');
  if (!prop) return { skin: '', cape: '' };
  let data;
  try {
    data = JSON.parse(Buffer.from(String(prop.value || ''), 'base64').toString('utf8'));
  } catch {
    return { skin: '', cape: '' };
  }
  const tex = (data.textures || {});
  const pick = (KEY) => {
    const e = tex[KEY];
    return e && e.url ? String(e.url).replace(/^http:\/\//i, 'https://') : '';
  };
  return { skin: pick('SKIN'), cape: pick('CAPE') };
}

function dash(raw) {
  const s = String(raw || '');
  if (s.length !== 32) return s;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** 预览图地址（mc-heads 现成渲染，正版/离线按 uuid 都能出图） */
export function previewUrls(uuid) {
  const id = String(uuid || '').replace(/-/g, '') || 'Steve';
  return {
    head: `${HEADS}/avatar/${id}/96`,
    body: `${HEADS}/body/${id}/200`,
    skin: `${HEADS}/skin/${id}`,
  };
}

/** 读 PNG 尺寸（皮肤必须是 64×64 或 64×32，高分辨率按比例） */
export async function inspectSkinFile(filePath) {
  const buf = await fs.readFile(filePath);
  if (buf.length < 24 || buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('不是 PNG 文件');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const ok = width % 64 === 0 && (height === width || height === width / 2 || height * 2 === width);
  return {
    width,
    height,
    size: buf.length,
    valid: ok,
    variant: height === width / 2 ? 'classic' : 'classic',
    hint: ok ? '' : '皮肤 PNG 尺寸应为 64×64（1.8+）或 64×32（旧版），倍数缩放也接受',
  };
}

/** 当前账号的皮肤列表（要正版令牌） */
export async function listMySkins() {
  const { account } = loadConfig();
  if (!account?.accessToken) throw new Error('还没登录正版账号');
  const j = await jget(`${MC_API}/minecraft/profile/skins`, { token: account.accessToken });
  return (j || []).map((s) => ({
    id: s.id,
    state: s.state,
    url: s.url,
    variant: s.variant,
  }));
}

/** 把当前生效的皮肤 PNG 存到本地（data/skins/），返回文件路径 */
export async function downloadMySkin() {
  const { account } = loadConfig();
  if (!account?.accessToken) throw new Error('还没登录正版账号，离线账号没有皮肤可下载');
  const list = await listMySkins();
  const active = list.find((s) => s.state === 'ACTIVE') || list[0];
  if (!active?.url) throw new Error('这个账号没有设置皮肤');
  const res = await fetch(active.url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`下载皮肤失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 64 || buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('下载到的不是 PNG 文件');

  const dir = path.join(DATA_DIR, 'skins');
  await fs.mkdir(dir, { recursive: true });
  const safe = String(account.name || 'skin').replace(/[^\w.-]+/g, '_');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(dir, `${safe}-${stamp}.png`);
  await fs.writeFile(file, buf);
  return { file, bytes: buf.length, variant: active.variant ?? 'classic', url: active.url };
}

/** 上传皮肤：variant = classic | slim */
export async function uploadSkin(filePath, variant = 'classic') {
  const { account } = loadConfig();
  if (!account?.accessToken) throw new Error('还没登录正版账号，离线账号不能上传皮肤');
  const info = await inspectSkinFile(filePath);
  if (!info.valid) throw new Error(info.hint);
  const buf = await fs.readFile(filePath);
  const v = variant === 'slim' ? 'slim' : 'classic';

  const form = new FormData();
  form.append('variant', v);
  form.append('file', new Blob([buf], { type: 'image/png' }), path.basename(filePath));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('上传超时')), 30000);
  try {
    const res = await fetch(`${MC_API}/minecraft/profile/skins`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'user-agent': UA, authorization: `Bearer ${account.accessToken}` },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`上传失败：HTTP ${res.status} ${text.slice(0, 200)}`);
    return { ok: true, variant: v, size: info.size };
  } finally {
    clearTimeout(timer);
  }
}

/** 还原成默认皮肤 */
export async function resetSkin() {
  const { account } = loadConfig();
  if (!account?.accessToken) throw new Error('还没登录正版账号');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('请求超时')), 20000);
  try {
    const res = await fetch(`${MC_API}/minecraft/profile/skins/active`, {
      method: 'DELETE',
      signal: ac.signal,
      headers: { 'user-agent': UA, authorization: `Bearer ${account.accessToken}` },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`还原失败：HTTP ${res.status} ${text.slice(0, 200)}`);
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- MineSkin 皮肤库 ---------------- */
const MINE = 'https://api.mineskin.org';
const SECRETS = path.join(DATA_DIR, 'secrets.json');

async function mineKey() {
  try {
    const { readFileSync } = await import('node:fs');
    const s = JSON.parse(readFileSync(SECRETS, 'utf8'));
    return s?.skin?.apiKey || '';
  } catch { return ''; }
}

/** 最近上传的皮肤列表（MineSkin /v2/skins） */
export async function listGallery(size = 24) {
  const n = Math.max(6, Math.min(48, Number(size) || 24));
  const key = await mineKey();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('请求超时')), 20000);
  try {
    const res = await fetch(`${MINE}/v2/skins?size=${n}`, {
      signal: ac.signal,
      headers: { 'user-agent': UA, accept: 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MineSkin HTTP ${res.status}：${text.slice(0, 160)}`);
    const body = JSON.parse(text || '{}');
    const raw = body.skins || body.data || (Array.isArray(body) ? body : []);
    const items = raw.map((s) => ({
      id: s.uuid || s.shortId || s.id || '',
      name: s.name || '',
      texture: s.texture || '',
      thumb: s.texture ? `${MINE}/render/head?url=${encodeURIComponent(/^https?:\/\//i.test(String(s.texture)) ? String(s.texture) : `https://textures.minecraft.net/texture/${s.texture}`)}` : '',
      ts: s.timestamp || null,
    })).filter((s) => s.thumb);
    return { ok: true, items, count: items.length };
  } finally {
    clearTimeout(timer);
  }
}

/** 把任意 texture 直链渲染成头像 PNG 文件 */
export async function renderHead(textureUrl, destDir = path.join(DATA_DIR, 'skins')) {
  // MineSkin 的 /v2/skins 返回的是裸 hash，不是完整 URL，这里统一归一化
  const raw = String(textureUrl || '').trim();
  if (!raw) throw new Error('缺少 texture（皮肤 hash 或地址）');
  const url = /^https?:\/\//i.test(raw) ? raw : `https://textures.minecraft.net/texture/${raw}`;
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('需要一个 texture 地址或 hash');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('请求超时')), 20000);
  try {
    const res = await fetch(`${MINE}/render/head?url=${encodeURIComponent(url)}`, {
      signal: ac.signal,
      headers: { 'user-agent': UA },
    });
    if (!res.ok) throw new Error(`MineSkin 渲染失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('返回的不是 PNG');
    await fs.mkdir(destDir, { recursive: true });
    const file = path.join(destDir, `head-${Date.now()}.png`);
    await fs.writeFile(file, buf);
    return { ok: true, file, bytes: buf.length };
  } finally {
    clearTimeout(timer);
  }
}
