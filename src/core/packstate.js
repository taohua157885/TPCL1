// 资源包/光影的「游戏内启用状态」：读写 options.txt
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gameDirFor } from './config.js';
import { versionDir } from './version.js';

function optionsPath(versionId) {
  const dir = gameDirFor(versionId);
  const p1 = path.join(dir, 'options.txt');
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(versionDir(versionId), 'options.txt');
  if (fs.existsSync(p2)) return p2;
  return p1;
}

/** 解析 resourcePacks:["vanilla","file/a.zip"] 里的数组 */
function parseList(text, key) {
  const re = new RegExp(`^${key}:(\\[.*\\])$`, 'm');
  const m = text.match(re);
  if (!m) return null;
  const raw = m[1];
  const out = [];
  const itemRe = /"((?:[^"\\]|\\.)*)"/g;
  let x;
  while ((x = itemRe.exec(raw))) out.push(x[1].replace(/\\"/g, '"'));
  return out;
}

function quoteList(arr) {
  return '[' + arr.map((s) => '"' + String(s).replace(/"/g, '\\"') + '"').join(',') + ']';
}

function setLine(text, key, value) {
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(text)) return text.replace(re, () => `${key}:${value}`);
  const nl = text.endsWith('\n') || text === '' ? '' : '\n';
  return text + nl + `${key}:${value}\n`;
}

async function readText(versionId) {
  const p = optionsPath(versionId);
  try {
    return { p, text: await fsp.readFile(p, 'utf8') };
  } catch {
    return { p, text: '' };
  }
}

const packId = (name) => `file/${name}`;

/** 资源包 / 光影当前是否启用 */
export async function packActive(versionId, kind, name) {
  const { text } = await readText(versionId);
  if (kind === 'resourcepacks') {
    const list = parseList(text, 'resourcePacks') || [];
    return list.includes(packId(name));
  }
  if (kind === 'shaderpacks') {
    const m = text.match(/^shaderPack:(.*)$/m);
    const cur = m ? m[1].trim() : '';
    return !!cur && cur === name;
  }
  return false;
}

/**
 * 启用/禁用。资源包是多选（追加/移除），光影是单选（设为它或清空）。
 * 返回写入后的状态。
 */
export async function setPackActive(versionId, kind, name, on) {
  const { p, text } = await readText(versionId);
  let next = text;

  if (kind === 'resourcepacks') {
    const list = parseList(text, 'resourcePacks') || ['vanilla'];
    const id = packId(name);
    const has = list.includes(id);
    if (on && !has) list.push(id);
    if (!on && has) list.splice(list.indexOf(id), 1);
    next = setLine(next, 'resourcePacks', quoteList(list));
  } else if (kind === 'shaderpacks') {
    next = setLine(next, 'shaderPack', on ? name : '');
  } else {
    throw new Error('这个分类不支持启用开关: ' + kind);
  }

  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, next, 'utf8');
  return packActive(versionId, kind, name);
}

/** 给列表补 active 字段（只对资源包/光影有意义） */
export async function annotateActive(versionId, kind, items) {
  if (kind !== 'resourcepacks' && kind !== 'shaderpacks') return items;
  const { text } = await readText(versionId);
  const list = kind === 'resourcepacks' ? parseList(text, 'resourcePacks') || [] : null;
  const shader = kind === 'shaderpacks' ? (text.match(/^shaderPack:(.*)$/m)?.[1] || '').trim() : '';
  for (const it of items) {
    it.active = kind === 'resourcepacks' ? list.includes(packId(it.name)) : !!shader && shader === it.name;
  }
  return items;
}
