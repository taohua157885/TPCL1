// 崩溃报告解析：把 crash-reports/*.txt 翻译成「发生了什么 + 怎么修」
// PCL2 的招牌功能之一：不是把 Java 堆栈甩给用户，而是给出人话结论。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gameDirFor, loadConfig } from './config.js';

const SIGS = [
  {
    id: 'intelgpu',
    actions: ['gpu', 'memDown'],
    re: /igxelpicd64|igdumdim64|igd10iumd64|igd11dxva64|Intel\(R\) Iris|Intel.*OpenGL/i,
    title: 'Intel 核显驱动崩溃（改用独显基本能解）',
    cause: '崩溃发生在 Intel 核显的图形驱动 DLL 里（igxelpicd64.dll 之类），不是模组或游戏本身的问题——'
      + '所以 Minecraft 来不及写崩溃报告，表现就是「玩着玩着直接闪退」。',
    tips: [
      '在「设置 → 显卡」里打开「优先使用独显」，启动器会给 java.exe 写一条 Windows 高性能 GPU 偏好。',
      '或者去 设置 → 系统 → 显示 → 图形，把 javaw.exe / java.exe 手动设为「高性能」。',
      '更新 Intel 核显驱动（Intel Driver & Support Assistant），或者干脆在 BIOS/设备管理器里禁用核显。',
      '笔记本插着电源再玩，独显在省电模式下有时不会被调度。',
    ],
  },
  {
    id: 'native',
    actions: ['gpu', 'stripJvm', 'memDown'],
    re: /检测到 JVM 原生崩溃日志|EXCEPTION_ACCESS_VIOLATION|EXCEPTION_ILLEGAL_INSTRUCTION|Problematic frame|# A fatal error has been detected/i,
    title: 'JVM 原生崩溃（驱动 / 内存 / 优化模组）',
    cause: 'JVM 进程被底层错误打死，所以 Minecraft 来不及写崩溃报告——这也是「闪退且没有错误报告」最常见的原因。'
      + '典型来源：显卡驱动、内存条/内存超频、Sodium/Iris 这类直接调 OpenGL 的优化模组、或某些 Windows 安全软件注入。',
    tips: [
      '先看诊断文件里的 hs_err 段，"Problematic frame" 那一行就是出事的模块（nvoglv64.dll = 显卡驱动，jvm.dll = JVM 自身）。',
      '更新/回滚显卡驱动；笔记本双显卡的话强制用独显跑 Java。',
      '临时把 -XX:+UseZGC 之类的额外 JVM 参数去掉，内存别开到物理内存 80% 以上。',
      '把 Sodium / Iris / Oculus 这类渲染优化模组单独停用再试，能进就说明是它们。',
      '还有内存超频（XMP）的话先关掉。',
    ],
  },
  {
    id: 'silentexit',
    actions: ['safeMode', 'memUp'],
    re: /没有生成 Minecraft 崩溃报告|没有 hs_err_pid 日志/,
    title: '静默退出（没有崩溃报告）',
    cause: '游戏进程结束了，但没有写出 crash-report，也没有 hs_err。'
      + '常见于：启动阶段某个 mod 直接调用 System.exit、被安全软件/系统结束、或者 JVM 参数把错误吞掉了。',
    tips: [
      '看诊断文件里「退出前最后 80 行日志」，最后一条正常日志的下一句通常就是凶手。',
      '如果日志停在加载某个 mod 的名字上，先去内容页停用那个 mod。',
      '把内存调大一点（默认 4096 对大型整合包偏小），并确认 Java 版本匹配。',
      '还有问题就把这份诊断文件发给作者。',
    ],
  },
  {
    id: 'oom',
    actions: ['memUp'],
    re: /java\.lang\.OutOfMemoryError/,
    title: '内存不够用了',
    cause: '游戏在运行中被 JVM 判定为内存耗尽（OutOfMemoryError）。常见于装了高清材质包、大型整合包，或分配的内存偏小。',
    tips: [
      '把该版本的内存上限调大（整合包建议 4096–8192 MB，取决于是 1.21+ 还是更早版本）。',
      '关掉「自动内存分配」，手动给足；同时别把内存开到物理内存的 80% 以上。',
      '检查是否装了 512x 以上的材质包或大量实体刷怪塔。',
    ],
  },
  {
    id: 'missingdep',
    actions: ['safeMode', 'repair'],
    re: /Missing or unsupported mandatory dependencies|ModLoadingException|MissingDependencyException/i,
    title: '缺少前置模组 / 模组不兼容',
    cause: '某个模组声明了必须存在的前置（或版本范围不满足），加载阶段直接被拦下。',
    tips: [
      '看崩溃报告里 "Missing or unsupported mandatory dependencies" 后面列出的模组名，把缺的装上。',
      '确认前置与本体的版本号匹配（例如 Fabric API 要和 MC 版本一致）。',
      '装模组时用启动器的「资源搜索」，它会自动带上 required 依赖。',
    ],
  },
  {
    id: 'module',
    actions: ['safeMode', 'stripJvm'],
    re: /java\.lang\.module\.ResolutionException|module .* contains package|exports package/,
    title: '模块层冲突（原版 jar 与加载器补丁 jar 打架）',
    cause: '同一个包被两个模块同时导出，通常是 classpath 里混进了不该出现的原版或补丁 jar。',
    tips: [
      '用启动器的「修复」重新生成该版本的依赖清单。',
      '确认启动参数里没有重复塞 jar（第三方启动器常见问题）。',
      'Forge/NeoForge 版本不要手改 libraries 目录。',
    ],
  },
  {
    id: 'classver',
    actions: ['safeMode', 'repair'],
    re: /UnsupportedClassVersionError|class file version (\d+)/,
    title: 'Java 版本不对',
    cause: '用低版本 Java 跑了高版本游戏/模组（或反过来）。',
    tips: [
      '1.20.5–1.21.x 需要 Java 21；26.x 需要 Java 25；1.17–1.20.4 用 Java 17。',
      '在「设置 → 使用的 Java」里改成自动选择，或给该版本单独指定正确的 Java。',
      '启动器会读版本 json 里的 javaVersion 自动匹配。',
    ],
  },
  {
    id: 'gl',
    actions: ['gpu', 'safeMode'],
    re: /Pixel format not accelerated|GLFW error 65542|Failed to create window|OpenGL.*not supported/i,
    title: '显卡驱动 / OpenGL 初始化失败',
    cause: '系统没有可用的 OpenGL 3.2+ 上下文，通常是驱动太旧、远程桌面会话，或核显驱动缺失。',
    tips: [
      '更新显卡驱动（NVIDIA/AMD/Intel 官网，别用系统自带）。',
      '远程桌面/虚拟机里跑不了，需要本地物理机。',
      '笔记本双显卡时，强制用独显运行 java.exe。',
    ],
  },
  {
    id: 'nosuchmethod',
    actions: ['safeMode', 'repair'],
    re: /NoSuchMethodError|NoClassDefFoundError|ClassNotFoundException/,
    title: '类/方法找不到：模组与游戏版本不匹配',
    cause: '模组按别的 MC 版本（或别的加载器）编译，运行时找不到对应方法签名。',
    tips: [
      '确认每个模组都支持当前 MC 版本与加载器。',
      '删掉最近新加的模组，用二分法定位。',
      '同一个模组别装两份（mods 与 mods/1.21.1 子目录重复）。',
    ],
  },
  {
    id: 'nomain',
    actions: ['repair'],
    re: /Could not find or load main class net\.minecraft\.client\.main\.Main|NoClassDefFoundError: net\/minecraft\/client\/main\/Main/,
    title: '客户端主文件缺失',
    cause: 'versions/<版本>/<版本>.jar 不存在或损坏，classpath 里没有游戏本体。',
    tips: [
      '用启动器的「补全 / 修复」重新下载客户端 jar。',
      '别手动删 versions 目录里的 jar。',
    ],
  },
  {
    id: 'corrupt',
    actions: ['repair'],
    re: /zip END header not found|invalid LOC header|Error reading zip|Corrupted jar/i,
    title: '文件损坏（下载不完整）',
    cause: '某个 jar 下载中断，zip 结构不完整。',
    tips: [
      '用「修复」重下该版本的库文件（启动器会按 SHA1 校验）。',
      '网络不稳时把下载线程数调小一点再试。',
    ],
  },
  {
    id: 'mixin',
    actions: ['safeMode', 'stripJvm'],
    re: /Mixin apply failed|Mixin.*(error|Error).*config|InvalidMixinException/,
    title: 'Mixin 注入失败',
    cause: '模组用 Mixin 改了游戏代码，但目标方法在当前的 MC/加载器版本里不存在了。',
    tips: [
      '通常是模组版本太旧，去资源搜索里装适配当前版本的最新版。',
      '看崩溃里 "Mixin apply failed" 后面的模组名，单独升级它。',
    ],
  },
  {
    id: 'entity',
    actions: ['safeMode'],
    re: /Ticking entity|Ticking block entity|Exception ticking world/,
    title: '某个实体/方块实体出错（存档层面）',
    cause: '世界里某个实体每 tick 抛异常，通常是模组加的生物/机器数据损坏。',
    tips: [
      '先在单人里用备份存档回退（启动器「存档」页可以整份导出）。',
      '用 /kill 或编辑器清掉出问题的实体；报告里有坐标。',
      '确认该模组与游戏版本匹配。',
    ],
  },
];

function readSafe(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function crashDir(versionId) {
  const base = gameDirFor(versionId) || loadConfig().mcDir;
  return path.join(base, 'crash-reports');
}

export function listCrashes(versionId, limit = 30) {
  const dir = crashDir(versionId);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.txt'));
  } catch {
    return { dir, items: [] };
  }
  const items = names
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      const text = readSafe(full) || '';
      const desc = (text.match(/^Description:\s*(.+)$/m) || [])[1] || '';
      const first = (text.match(/^(?:java|net\.|org\.|com\.)[\w.$]+(?:Exception|Error)[^\n]*/m) || [])[0] || '';
      return {
        file: f,
        size: st.size,
        mtime: st.mtimeMs,
        description: desc.slice(0, 120),
        exception: first.slice(0, 160),
      };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  return { dir, items };
}

export function analyzeText(text, name = '') {
  if (!text || typeof text !== 'string' || !text.trim()) return { error: '没有拿到内容' };

  const description = (text.match(/^Description:\s*(.+)$/m) || [])[1] || '';
  const exception = (text.match(/^(?:java|net\.|org\.|com\.)[\w.$]+(?:Exception|Error)[^\n]*/m) || [])[0] || '';
  const stack = (text.match(/^\s+at [\w.$]+\([^)]*\)/m) || [])[0]?.trim() || '';

  const mods = [];
  const modSection = text.split(/-- Mods --/)[1];
  if (modSection) {
    for (const line of modSection.split('\n').slice(1, 400)) {
      if (/^--/.test(line)) break;
      const m = line.match(/^\s+([\w.-]+)\s+\{?([^\s{]*)/);
      if (m && m[1] !== 'Mod') mods.push(`${m[1]}${m[2] ? ' ' + m[2] : ''}`);
      if (mods.length >= 40) break;
    }
  }

  const hits = SIGS.filter((s) => s.re.test(text));
  const primary = hits[0] || null;

  return {
    file: name || '（粘贴的文本）',
    size: Buffer.byteLength(text),
    description,
    exception,
    stack,
    signature: primary?.id || 'unknown',
    actions: primary?.actions || [],
    title: primary?.title || (description || '未知崩溃'),
    cause: primary?.cause || '没有匹配到已知特征，需要看完整堆栈。',
    tips: primary?.tips || [
      '看崩溃报告第一段「---- Minecraft Crash Report ----」后面的异常，那才是根因。',
      '把最近新装的模组/资源包撤掉再试。',
    ],
    extraHits: hits.slice(1).map((h) => ({ id: h.id, title: h.title })),
    mods,
    text: text.slice(0, 20000),
  };
}

export function latestCrash(versionId) {
  const { items } = listCrashes(versionId, 5);
  return items[0] || null;
}

export async function deleteCrash(versionId, file) {
  const full = path.join(crashDir(versionId), path.basename(file));
  await fsp.rm(full, { force: true });
  return { ok: true };
}

export function analyzeCrash(versionId, file) {
  const dir = crashDir(versionId);
  const full = path.join(dir, path.basename(file));
  const text = readSafe(full);
  if (text == null) return { error: '找不到这个崩溃报告' };
  // 原生崩溃的线索在 hs_err 里，不在 crash-report 里：一起喂给规则
  let merged = text;
  try {
    const hs = fs.readdirSync(dir)
      .filter((f) => /^hs_err_pid\d+\.log$/i.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (hs) {
      const head = readSafe(path.join(dir, hs.f))?.split('\n').slice(0, 120).join('\n') || '';
      if (head && !text.includes('igxelpicd64') && !text.includes('Problematic frame')) {
        merged = text + '\n\n## 检测到 JVM 原生崩溃日志（hs_err）\n### ' + hs.f + '\n' + head;
      }
    }
  } catch { /* ignore */ }
  return analyzeText(merged, path.basename(full));
}
