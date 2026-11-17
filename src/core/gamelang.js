// 游戏语言：启动前把 options.txt 的 lang 写成配置的语言，保证进游戏就是中文
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, gameDirFor } from './config.js';
import { versionDir } from './version.js';

/** 支持的语言（和 Minecraft 的 lang 代码一致） */
export const GAME_LANGS = [
  { code: 'zh_cn', name: '简体中文' },
  { code: 'zh_tw', name: '繁體中文' },
  { code: 'en_us', name: 'English (US)' },
  { code: 'ja_jp', name: '日本語' },
  { code: 'ru_ru', name: 'Русский' },
  { code: 'ko_kr', name: '한국어' },
];

function optionsPath(versionId) {
  // 隔离模式下游戏目录就是版本目录；否则是全局 .minecraft
  const dir = gameDirFor(versionId);
  const p1 = path.join(dir, 'options.txt');
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(versionDir(versionId), 'options.txt');
  if (fs.existsSync(p2)) return p2;
  return p1;
}

/** 读当前 options.txt 里的语言，没有就返回 null */
export async function readGameLanguage(versionId) {
  const p = optionsPath(versionId);
  try {
    const text = await fsp.readFile(p, 'utf8');
    const m = text.match(/^lang:(.*)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * 把 options.txt 的 lang 改成指定语言。
 * - 文件不存在就新建（只写 lang，其余留给游戏自己生成）
 * - 保留原有其它设置与换行风格
 */
export async function writeGameLanguage(versionId, lang) {
  const code = String(lang || '').trim();
  if (!code) return { changed: false, reason: 'no-lang' };
  const p = optionsPath(versionId);
  let text = '';
  try {
    text = await fsp.readFile(p, 'utf8');
  } catch {
    text = '';
  }
  const crlf = text.includes('\r\n');
  let next;
  if (/^lang:.*$/m.test(text)) {
    next = text.replace(/^lang:.*$/m, `lang:${code}`);
  } else if (text.length) {
    next = text.replace(/\s*$/, '') + (crlf ? '\r\n' : '\n') + `lang:${code}` + (crlf ? '\r\n' : '\n');
  } else {
    next = `lang:${code}\n`;
  }
  if (next === text) return { changed: false, file: p, lang: code };
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, next, 'utf8');
  return { changed: true, file: p, lang: code };
}

/** 启动前调用：按配置把语言写进 options.txt（config.forceGameLang 为 false 时跳过） */
export async function applyConfiguredLanguage(versionId) {
  const cfg = loadConfig();
  if (cfg.forceGameLang === false) return { skipped: true };
  const lang = cfg.language || 'zh_cn';
  return writeGameLanguage(versionId, lang);
}
