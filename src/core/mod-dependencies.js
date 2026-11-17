import { resolveVersion, detectLoader } from './version.js';

const LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];

export function resourceContext(target) {
  const info = resolveVersion(target);
  const libs = (info.json.libraries || []).map(l => l.name || '').join(' ').toLowerCase();
  const loader = libs.includes('net.neoforged:') ? 'neoforge'
    : libs.includes('org.quiltmc:quilt-loader:') ? 'quilt'
      : libs.includes('net.fabricmc:fabric-loader:') ? 'fabric'
        : libs.includes('net.minecraftforge:') ? 'forge'
          : detectLoader(target, info.json).toLowerCase();
  const candidates = [info.json.clientVersion, info.json.minecraftVersion, info.json.jar, ...[...info.chain].reverse()];
  const mcVer = candidates.filter(v => typeof v === 'string').map(v => v.match(/^(\d+\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+)?|\d{2}w\d{2}[a-z])(?=$|[-_])/i)?.[1]).find(Boolean) || '';
  return { mcVer, loader: LOADERS.includes(loader) ? loader : '', loaderName: ({ fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' })[loader] || '原版' };
}

export function modContext(target) {
  const ctx = resourceContext(target);
  if (!ctx.mcVer) throw new Error(`无法识别「${target}」的 Minecraft 版本，无法匹配前置模组`);
  if (!ctx.loader) throw new Error(`「${target}」未检测到模组加载器，请先安装 Fabric、Forge、NeoForge 或 Quilt`);
  return ctx;
}

export function compatible(gameVersions, loaders, ctx) {
  return (gameVersions || []).includes(ctx.mcVer) && (loaders || []).some(l => String(l).toLowerCase() === ctx.loader);
}

// Resolve the entire graph before writing files. Cycles/shared dependencies are visited once.
export async function planDependencies(root, resolve, onProgress = () => {}) {
  const preferred = new Map();
  // A later exact pin can replace an earlier automatic choice, before any writes.
  for (let attempt = 0; attempt < 64; attempt++) {
    const selected = new Map(), pins = new Map(), plan = [];
    function checkPin(key, versionId, old) {
      if (!versionId) return;
      const pin = String(versionId), previous = pins.get(key);
      if (previous && previous !== pin) throw new Error(`前置版本冲突：${old?.name || key} 同时需要 ${previous} 和 ${pin}`);
      if (old && String(old.versionId) !== pin) {
        const retry = new Error('重新匹配指定前置版本');
        retry.replan = { key, pin };
        throw retry;
      }
      pins.set(key, pin);
    }
    async function visit(ref, chain = []) {
      if (chain.length > 64 || selected.size >= 256) throw new Error('必需前置数量或层级异常，已停止安装');
      let old = ref.projectId && selected.get(String(ref.projectId));
      if (old) {
        checkPin(String(ref.projectId), ref.versionId, old);
        return;
      }
      try {
        onProgress({ stage: 'dependencies', percent: 2, text: `正在解析必需前置：${ref.projectId || ref.versionId || ref.filename || '未知项目'}` });
        const item = await resolve({ ...ref, versionId: ref.versionId || preferred.get(String(ref.projectId)) });
        if (!item?.projectId || !item.versionId) throw new Error('下载源没有返回有效的项目或文件版本');
        const key = String(item.projectId);
        old = selected.get(key);
        checkPin(key, ref.versionId, old);
        if (old) {
          if (String(old.versionId) !== String(item.versionId)) throw new Error(`前置版本冲突：${item.name}`);
          return;
        }
        selected.set(key, item);
        for (const dep of item.required || []) await visit(dep, [...chain, item.name]);
        plan.push(item);
      } catch (cause) {
        if (cause.replan) throw cause;
        if (cause.code === 'MOD_DEPENDENCY') throw cause;
        const error = new Error(`模组依赖解析失败（${[...chain, ref.projectId || ref.versionId || ref.filename || '未知前置'].join(' → ')}）：${cause.message}`, { cause });
        error.code = 'MOD_DEPENDENCY';
        throw error;
      }
    }
    try { await visit(root); }
    catch (error) {
      if (!error.replan) throw error;
      preferred.set(error.replan.key, error.replan.pin);
      continue;
    }
    const filenames = new Set();
    for (const item of plan) {
      for (const dep of item.incompatible || []) {
        const match = dep.projectId ? selected.get(String(dep.projectId)) : plan.find(p => String(p.versionId) === String(dep.versionId));
        if (match && (!dep.versionId || String(match.versionId) === String(dep.versionId))) throw new Error(`模组冲突：${item.name} 与 ${match.name} 不能同时安装`);
      }
      const name = item.file.filename;
      if (!name || /[\\/:<>"|?*\x00-\x1f]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name)) throw new Error(`下载源返回了非法文件名：${name}`);
      if (filenames.has(name.toLowerCase())) throw new Error(`前置文件名冲突：${name}`);
      filenames.add(name.toLowerCase());
    }
    onProgress({ stage: 'dependencies', percent: 5, text: `已匹配 ${plan.length - 1} 个必需前置，开始下载` });
    return plan;
  }
  throw new Error('前置版本约束无法收敛，请尝试其他主模组版本');
}
