// 极简双语层：中文原文 → 英文，按文本节点替换；切回中文时用保存的原文还原。
// 只翻译「界面框架」里出现的固定文案，动态数据（版本号、日志、toast）保持原样。

const EN = {
  // 导航 / 标题
  启动: 'Launch',
  下载: 'Download',
  内容: 'Content',
  存档: 'Worlds',
  服务器: 'Servers',
  皮肤: 'Skins',
  设置: 'Settings',
  更多: 'More',
  原版: 'Vanilla',
  整合包: 'Modpacks',
  资源搜索: 'Modrinth',
  已安装版本: 'Installed versions',
  当前选中: 'Selected',
  运行日志: 'Log',
  备份文件: 'Backups',
  '按名字查看别人的皮肤': "Look up someone's skin",
  // 按钮
  清空: 'Clear',
  收起: 'Collapse',
  展开: 'Expand',
  崩溃分析: 'Crash report',
  启动游戏: 'Launch game',
  结束进程: 'Kill process',
  刷新列表: 'Reload',
  全部刷新: 'Refresh all',
  查询: 'Look up',
  备份: 'Back up',
  打开: 'Open',
  恢复: 'Restore',
  删除: 'Delete',
  安装: 'Install',
  补全: 'Complete',
  已安装: 'Installed',
  取消: 'Cancel',
  确定: 'OK',
  保存: 'Save',
  关闭: 'Close',
  退出登录: 'Sign out',
  获取登录码: 'Get code',
  复制: 'Copy',
  '选择皮肤文件…': 'Choose skin file…',
  '上传到正版账号': 'Upload to account',
  '还原默认皮肤': 'Reset skin',
  '备份全部': 'Back up all',
  '打开备份目录': 'Open backup folder',
  '保存设置': 'Save settings',
  '保存该版本设置': 'Save for this version',
  '清除覆盖': 'Clear override',
  '下载并安装': 'Download & install',
  '重新扫描': 'Rescan',
  '添加并 ping': 'Add & ping',
  // 设置分组 / 字段
  界面: 'Interface',
  游戏: 'Game',
  下载: 'Download',
  窗口与参数: 'Window & args',
  当前版本的独立设置: 'Per-version settings',
  界面语言: 'Language',
  游戏目录: 'Game folder',
  版本隔离: 'Isolation',
  内存: 'Memory',
  '内存（MB）': 'Memory (MB)',
  使用的: 'Java',
  '使用的 Java': 'Java',
  自动下载: 'Auto download',
  下载源: 'Download mirror',
  开发线程: 'Threads',
  并发线程: 'Threads',
  分辨率: 'Resolution',
  '额外 JVM 参数': 'Extra JVM args',
  '额外游戏参数': 'Extra game args',
  跟随全局: 'Follow global',
  留空: 'Empty',
  '按版本隔离（推荐）': 'Per version (recommended)',
  '不隔离（共用 .minecraft）': 'Shared .minecraft',
  '隔离到 versions/<id>/game': 'Isolate to versions/<id>/game',
  '自动选择（推荐）': 'Auto (recommended)',
  '跟随全局（自动选择）': 'Follow global (auto)',
  '留空 = 用上面的全局值': 'Empty = use global value above',
  '留空 = 用全局': 'Empty = use global',
  '例如 --server example.com --port 25565': 'e.g. --server example.com --port 25565',
  '例如 mc.hypixel.net 或 1.2.3.4:25565': 'e.g. mc.hypixel.net or 1.2.3.4:25565',
  '备注名（可选）': 'Label (optional)',
  '玩家名或 UUID，例如 Notch': 'Name or UUID, e.g. Notch',
  '搜索版本号…': 'Search versions…',
  '搜索版本…': 'Search versions…',
  '未选择文件': 'No file chosen',
  '显示快照': 'Show snapshots',
  '版本隔离模式': 'Isolation mode',
  // 标签 / 状态
  正式版: 'Release',
  快照: 'Snapshot',
  缺主文件: 'Missing jar',
  继承: 'Inherits',
  需要: 'Needs',
  当前: 'Current',
  在线: 'online',
  离线: 'offline',
  模组: 'Mods',
  资源包: 'Resource packs',
  光影: 'Shaders',
  数据包: 'Data packs',
  正在运行: 'Running',
  '正在读取版本信息…': 'Reading version info…',
  '正在获取版本列表…': 'Fetching version list…',
  '这个版本还没有存档': 'No worlds in this version yet',
  '还没有备份': 'No backups yet',
  // 新弹窗：重命名 / 导入整合包 / 安装确认 / 市场详情 / 服务器编辑
  '重命名版本': 'Rename version',
  '当前名称': 'Current name',
  '新名称': 'New name',
  '确定重命名': 'Rename',
  '取消': 'Cancel',
  '取消编辑': 'Cancel edit',
  '保存修改': 'Save changes',
  '添加并 ping': 'Add & ping',
  '还没有服务器。上面填个地址（如 mc.hypixel.net 或 1.2.3.4:25565），回车即可添加。':
    'No servers yet. Enter an address above (e.g. mc.hypixel.net or 1.2.3.4:25565) and press Enter.',
  '导入整合包': 'Import modpack',
  '开始导入': 'Start import',
  '会新建一个独立版本，不动现有版本': 'Creates a separate version; existing ones are untouched',
  '格式': 'Format',
  '打包名称': 'Pack name',
  '要下载的模组/文件': 'Files to download',
  '下载体积': 'Download size',
  '覆盖文件': 'Overrides',
  '将创建的版本': 'Version to create',
  '加载器': 'Loader',
  '安装游戏版本': 'Install game version',
  '开始安装': 'Install',
  '跳过资源文件（声音与语言文件会缺失，不推荐）': 'Skip assets (sounds and language files will be missing)',
  '项目详情': 'Project details',
  '可用版本': 'Available versions',
  '安装': 'Install',
  '依赖': 'Requires',
  '下载皮肤': 'Download skin',
  '正版账号登录': 'Microsoft sign-in',
  '获取登录码': 'Get sign-in code',
  '退出登录': 'Sign out',
  '微软登录': 'Microsoft',
  '离线登录': 'Offline',
  '保存昵称': 'Save name',
  '切换 / 登录账号': 'Switch / sign in',
  '去内容页看看': 'Open content page',
  '已导入': 'Imported',
  '都是最新': 'All up to date',
  '选择文件': 'Choose file',
  '导入文件': 'Import file',
  '打开文件夹': 'Open folder',
  '检查更新': 'Check updates',
  '下载安装包': 'Download installer',
  '打开下载页': 'Open download page',
  '启动器更新': 'Launcher update',
  '安装包已就绪': 'installer ready',
  '账号': 'Account',
  '启动器日志': 'Log',
  '正式版 · 需要': 'Release · needs',
  '当前 Java {v}': 'Java {v}',
  '需要 Java {v}': 'needs Java {v}',
  '正式版': 'Release',
  '只改目录名与 json 里的 id，版本内容不动（支持中文）。': 'Renames the folder and its json id; version content stays as-is (Chinese allowed).',
  '当前版本': 'Current version',
  '版本列表': 'Versions',
  '快捷入口': 'Shortcuts',
  '导出日志': 'Export log',
  '下载版本': 'Get versions',
  '管理内容': 'Manage content',
  '存档备份': 'World backups',
  '启动器设置': 'Launcher settings',
  '公告': 'Notice',
  '运行日志': 'Log',
  '当前版本的独立设置': 'Per-version settings',
  '只改目录名和 json 里的 id，版本内容不动。可以用中文，不能含 \ / : * ? " < > |，长度 1–64。': 'Renames the folder and the id inside its json; version content is untouched. Chinese is allowed; avoid \\ / : * ? \' < > |, length 1–64.',
  '启动此版本': 'Launch this version',
  '设为当前版本': 'Set as current',
  '版本设置': 'Version settings',
  '打开版本目录': 'Open version folder',
  '校验并修复': 'Verify & repair',
  '重命名': 'Rename',
  '删除此版本': 'Delete this version',
  '分钟前': 'min ago',
  '小时前': 'h ago',
  '天前': 'days ago',
  '刚刚': 'just now',
};

const CACHE = new WeakMap(); // textNode -> 原文

// 带占位符的模板：{n} {m} {v} 之类，按当前语言拼好再插进 DOM
const TPL = {
  '继承 {v}': 'inherits {v}',
  '最近游玩 {v}': 'Played {v}',
  '上次崩溃：{v}': 'Last crash: {v}',
  '缺 {n} 项 · 一键修复': 'Fix {n} missing',
  '安装 Java {v}': 'Install Java {v}',
  '检查了 {n} 个文件，{m} 个有新版': 'Checked {n} files, {m} have updates',
  '模组 {n} 个 · 资源包 {m} 个': '{n} mods · {m} resource packs',
  '已选 {v}': 'Selected {v}',
  '共 {n} 个 · 已按 {v} 过滤': '{n} total · filtered by {v}',
  '检查了 {n} 个文件，都是最新': 'Checked {n} files, all up to date',
  '需要 Java {v}': 'needs Java {v}',
  '当前 Java {v}': 'Java {v}',
  '快照': 'Snapshot',
  '正式版': 'Release',
};

/** 动态文案翻译：Tpl('缺 {n} 项 · 一键修复', { n: 3 }) */
export function Tpl(template, vars = {}) {
  let out = template;
  const dict = lang === 'en' ? TPL : null;
  out = dict && dict[template] ? dict[template] : template;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/** 运行时字符串翻译（用于 JS 里拼出来的句子，精确匹配字典） */
export function T(text) {
  if (lang !== 'en') return text;
  return EN[String(text).trim()] ?? text;
}

let lang = 'zh';

export function getLang() {
  return lang;
}

export function setLang(next) {
  lang = next === 'en' ? 'en' : 'zh';
  applyI18n();
}

function tr(raw) {
  if (lang !== 'en') return raw;
  const key = raw.trim();
  if (!key) return raw;
  const hit = EN[key];
  if (!hit) return raw;
  // 保留首尾空白，让排版不跑偏
  return raw.replace(key, hit);
}

/** 遍历可见文本节点与 placeholder/title，按需翻译；切回中文时还原原文 */
export function applyI18n() {
  const root = document.body;
  if (!root) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
      if (p.closest('#log')) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const n of nodes) {
    if (!CACHE.has(n)) CACHE.set(n, n.nodeValue);
    const original = CACHE.get(n);
    if (lang === 'zh') {
      if (n.nodeValue !== original) n.nodeValue = original;
    } else {
      // 每次从原文出发，避免中英混合
      n.nodeValue = tr(original);
    }
  }

  // placeholder / title
  for (const el of root.querySelectorAll('input[placeholder], button[title], [title]')) {
    for (const attr of ['placeholder', 'title']) {
      if (!el.hasAttribute(attr)) continue;
      const cacheKey = `__i18n_${attr}`;
      if (!(cacheKey in el.dataset)) el.dataset[cacheKey] = el.getAttribute(attr);
      const original = el.dataset[cacheKey];
      el.setAttribute(attr, lang === 'zh' ? original : tr(original));
    }
  }

  document.documentElement.dataset.lang = lang;
}

export { EN as DICTIONARY };
