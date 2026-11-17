import { loadConfig } from './config.js';

const BMCL = 'https://bmclapi2.bangbang93.com';

/** 当前生效的镜像基址（设置里选了「自定义」就用它） */
export function mirrorBase() {
  try {
    const c = loadConfig();
    if (c.mirror === 'custom') {
      const u = String(c.mirrorUrl || '').trim().replace(/\/+$/, '');
      if (/^https?:\/\//.test(u)) return u;
    }
  } catch { /* 配置读不出来就退回默认 */ }
  return BMCL;
}


function hostMap() {
  const B = mirrorBase();
  return [
    ['https://launchermeta.mojang.com', B],
    ['https://piston-meta.mojang.com', B],
    ['https://piston-data.mojang.com', B],
    ['https://launcher.mojang.com', B],
    ['https://libraries.minecraft.net', B + '/maven'],
    ['https://resources.download.minecraft.net', B + '/assets'],
    ['https://maven.minecraftforge.net', B + '/maven'],
    ['https://files.minecraftforge.net/maven', B + '/maven'],
    ['https://maven.neoforged.net/releases', B + '/maven'],
    ['https://maven.neoforged.net', B + '/maven'],
    ['https://maven.fabricmc.net', B + '/maven'],
    ['https://meta.fabricmc.net', B + '/fabric-meta'],
  ];
}

/** 把官方 URL 换成镜像 URL；无法映射的返回 null */
export function toMirror(url) {
  for (const [from, to] of hostMap()) {
    if (url.startsWith(from)) return to + url.slice(from.length);
  }
  return null;
}

/**
 * 镜像对这些前缀实测不可用：会 302 到一个第三方节点，而该节点再返回一个
 * 不带响应体的 302，跟随后连接被挂住（只能等到空闲超时才失败）。
 * 对它们一律官方优先，镜像仅作兜底。
 */
const MIRROR_UNRELIABLE = [
  'https://resources.download.minecraft.net', // 实测 302 空响应
];

/**
 * 按镜像偏好给出候选 URL 列表（按顺序尝试）。
 * @param {string} url 官方地址
 * @param {'bmclapi'|'official'|'auto'} mirror
 */
export function candidateUrls(url, mirror) {
  const m = toMirror(url);
  if (mirror === 'official') return [url];
  const usable = m && m !== url;
  if (!usable) return [url];
  if (MIRROR_UNRELIABLE.some((p) => url.startsWith(p))) return [url, m];
  return [m, url];
}

/** 版本 JSON 的镜像候选（BMCLAPI 有专用接口，比套 CDN 更稳） */
export function versionJsonCandidates(id, officialUrl, mirror) {
  const bmcl = `${mirrorBase()}/version/${encodeURIComponent(id)}/json`;
  if (mirror === 'official') return [officialUrl];
  if (mirror === 'bmclapi') return [bmcl, officialUrl];
  return [bmcl, officialUrl];
}

/**
 * 版本 client.jar 的候选地址。
 *
 * 实测（2026-11）：BMCLAPI 的 `/version/<id>/client` 会 302 到一个第三方节点
 * （如 bmclapi24.sakura.sld.tw），而该节点自身再返回一个 302 且不带响应体，
 * 浏览器/curl 跟随后拿不到文件。因此这里把官方地址放第一位，镜像仅作兜底。
 */
export function clientJarCandidates(id, officialUrl, mirror) {
  const bmcl = `${mirrorBase()}/version/${encodeURIComponent(id)}/client`;
  if (mirror === 'official') return [officialUrl];
  return [officialUrl, bmcl];
}
