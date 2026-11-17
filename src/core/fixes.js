// 崩溃建议的一键执行：把「你可以去改 X」变成「已经帮你改好了」
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, gameDirFor } from './config.js';
import { inspectVersion } from './launch.js';
import { setGpuPreference, getGpuPreference } from './gpu.js';
import { toggleContent, contentDir } from './content.js';
import { repairVersion } from './installer.js';
import { versionDir } from './version.js';

/** 所有可执行的修复动作（前端拿 id 来调） */
export const ACTIONS = {
  gpu: { label: '改用独显', hint: '给当前 Java 写 Windows 高性能 GPU 偏好' },
  memUp: { label: '内存调大', hint: '给这个版本单独提高内存上限' },
  memDown: { label: '内存调回 4096', hint: '排除内存分配过大导致的崩溃' },
  stripJvm: { label: '清空额外 JVM 参数', hint: '去掉自定义 -XX 参数，恢复默认' },
  safeMode: { label: '安全模式：禁用全部模组', hint: '把 mods 里的 jar 改名停用，可随时恢复' },
  repair: { label: '校验并修复版本', hint: '检查缺失/损坏文件并重新下载' },
};

function bumpMemory(cur) {
  const base = Number(cur) > 0 ? Number(cur) : 4096;
  const want = Math.max(6144, Math.round((base * 1.5) / 512) * 512);
  return Math.min(want, 16384);
}

/**
 * 执行一个修复动作。
 * @returns {{ok:boolean, action:string, message:string, detail?:any}}
 */
export async function applyFix(versionId, action) {
  const cfg = loadConfig();
  const id = versionId || cfg.selectedVersion;
  if (!id) return { ok: false, action, message: '没有选中版本' };

  if (action === 'gpu') {
    let java = cfg.javaPath || '';
    if (!java) {
      try { java = (await inspectVersion(id)).java?.path || ''; } catch { /* ignore */ }
    }
    if (!java) return { ok: false, action, message: '没找到这个版本用的 Java' };
    const r = setGpuPreference(java, true);
    if (!r.ok) return { ok: false, action, message: '写入 GPU 偏好失败：' + (r.error || '未知原因') };
    saveConfig({ gpuHigh: true });
    return { ok: true, action, message: `已把 ${path.basename(path.dirname(path.dirname(java)))} 设为高性能 GPU（独显）`, detail: { java, preference: getGpuPreference(java) } };
  }

  if (action === 'memUp' || action === 'memDown') {
    const ov = { ...(cfg.versionOverrides || {}) };
    const cur = Number(ov[id]?.memory) > 0 ? Number(ov[id].memory) : Number(cfg.memory) || 4096;
    const next = action === 'memDown' ? 4096 : bumpMemory(cur);
    ov[id] = { ...(ov[id] || {}), memory: next };
    saveConfig({ versionOverrides: ov });
    return { ok: true, action, message: `已把这个版本的内存上限设为 ${next} MB（原来是 ${cur} MB）`, detail: { memory: next, before: cur } };
  }

  if (action === 'stripJvm') {
    const ov = { ...(cfg.versionOverrides || {}) };
    const had = cfg.jvmArgs || ov[id]?.jvmArgs || '';
    if (ov[id]) delete ov[id].jvmArgs;
    saveConfig({ jvmArgs: '', versionOverrides: ov });
    return { ok: true, action, message: had ? `已清空自定义 JVM 参数：${had.slice(0, 80)}` : '本来就没有自定义 JVM 参数', detail: { before: had } };
  }

  if (action === 'safeMode') {
    const dir = contentDir(id, 'mods');
    if (!fs.existsSync(dir)) return { ok: false, action, message: '这个版本没有 mods 目录' };
    const files = fs.readdirSync(dir).filter((f) => /\.jar$/i.test(f));
    let n = 0;
    for (const f of files) {
      try { await toggleContent(id, 'mods', f); n++; } catch { /* 同名 disabled 已存在就跳过 */ }
    }
    return { ok: true, action, message: n ? `已停用 ${n} 个模组（在内容页可以一个个开回来）` : '模组已经全是停用状态', detail: { disabled: n } };
  }

  if (action === 'repair') {
    const r = await repairVersion(id);
    if (r.stillBroken?.length) {
      return { ok: false, action, message: `还有 ${r.stillBroken.length} 个文件修不好：${r.stillBroken.slice(0, 3).join('、')}`, detail: r };
    }
    return { ok: true, action, message: r.repaired ? `已修复 ${r.repaired} 个文件` : '文件本来就是完整的', detail: r };
  }

  if (action === 'openCrashDir') {
    const dir = path.join(gameDirFor(id), 'crash-reports');
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true, action, message: dir, detail: { dir } };
  }

  return { ok: false, action, message: '未知动作：' + action };
}
