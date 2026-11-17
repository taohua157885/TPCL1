// tpcl-plugin-market-v1
import {pluginMarketRoute} from './core/plugin-market.js';
import http from 'node:http';
import { searchCatalog as cfSearch, sourceStatus, saveApiKey } from './core/cf.js';
import { TaskQueue } from './core/taskqueue.js';
import { writeErrorReport, REPORT_DIR } from './core/reports.js';
import { listReleases } from './core/changelog.js';
import { exportConfig, importConfig } from './core/migrate.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, WEB_DIR, ROOT, DATA_DIR, gameDirFor, applyProxyEnv } from './core/config.js';
import { listLocalVersions, versionsDir, versionDir, versionJsonPath, resolveVersion } from './core/version.js';
import { scanJavas, downloadJava, inspectJavaFile, removeJava, JAVA_HOME_DIR } from './core/java.js';
import { startGame, bus, inspectVersion, buildLaunchCommand } from './core/launch.js';
import { listRemoteVersions, installVersion, deleteVersion, repairVersion } from './core/installer.js';
import { listContent, toggleContent, deleteContent, openFolder, contentDir, peekMeta } from './core/content.js';
import { netplayState, startTunnel, stopTunnel, detectLanPort } from './core/netplay.js';
import { checkMods, disableModFiles } from './core/modcheck.js';
import { iconPath as packIconPath } from './core/packmeta.js';
import { setPackActive } from './core/packstate.js';
import { listLoaders, installLoader } from './core/loaders.js';
import { importModpack, inspectModpack, exportModpack } from './core/modpack.js';
import { writeGameLanguage, readGameLanguage, GAME_LANGS } from './core/gamelang.js';
import { listGpus, getGpuPreference, setGpuPreference, looksDiscrete } from './core/gpu.js';
import {
  searchProjects, listProjectVersions, installProjectVersion,
  installModpackProject, versionContext, getProject, getProjects, checkUpdates,
} from './core/market.js';
import { listCrashes, analyzeCrash, analyzeText, deleteCrash } from './core/crashes.js';
import { applyFix, ACTIONS } from './core/fixes.js';
import { listOptifine, installOptifine, optifineCompat, installedOptifine, mcVersionOf } from './core/optifine.js';
import { checkUpdate, currentVersion } from './core/update.js';
import { updateState, pickAsset, downloadUpdate, applyUpdate, applyLog, canSelfUpdate, updateMode } from './core/selfupdate.js';
import { pingServer, pingAll } from './core/ping.js';
import { listWorlds, listBackups, backupWorld, backupAll, restoreBackup, deleteBackup, savesDir, backupsDir } from './core/backup.js';
import { importWorld } from './core/backup.js';
import { listShots, deleteShots, shotFile, shotsDir, contentType } from './core/shots.js';
import { syncOverview, syncDir, setSyncDir, pushWorld, pushAll, pullWorld, listRemote } from './core/sync.js';
import { diffSync } from './core/syncdiff.js';
import { startDeviceCode, finishLogin, refreshAccessToken } from './core/auth.js';
import { lookupProfile, profileTextures, previewUrls, inspectSkinFile, listMySkins, uploadSkin, resetSkin, downloadMySkin, listGallery, renderHead } from './core/skins.js';
import { startLanWatcher, listLan } from './core/lan.js';
import { getMod as cfGetMod, resolveModRef as cfResolveRef, listFiles as cfListFiles, installCfFile, targetContext as cfTargetContext, ping as cfPing } from './core/cf.js';
import { spawnSync, spawn } from 'node:child_process';
import os from 'node:os';
import { sha1File } from './core/download.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const logBuffer = [];
const MAX_LOG = 4000;
let running = null;                 // 最近一次启动且还在跑的（兼容旧字段）
const games = new Map();            // versionId -> game handle
function activeGames() { return [...games.values()].filter((g) => g && !g.exited); }

/**
 * inspectVersion 要逐个确认 5000+ 个资源对象是否存在，单次约 200~400ms。
 * 界面每次刷新都会问一遍，所以做个 5 秒的短期缓存。
 */
const inspectCache = new Map(); // id -> { at, info }
async function inspectCached(id) {
  const hit = inspectCache.get(id);
  const now = Date.now();
  if (hit && now - hit.at < 5000) return hit.info;
  const info = await inspectVersion(id);
  inspectCache.set(id, { at: now, info });
  return info;
}

bus.on('log', (e) => {
  logBuffer.push(e);
  if (logBuffer.length > MAX_LOG) logBuffer.splice(0, logBuffer.length - MAX_LOG);
});
bus.on('exit', (e) => {
  const vid = e && e.id ? e.id : running?.id;
  if (vid) games.delete(vid);
  if (!running || running.id === vid) {
    running = activeGames().slice(-1)[0] || null;
  }
  // 非正常退出：把最近一份崩溃报告的分析结果记到配置里，首页卡片直接能看见原因
  if (vid && e && e.code !== 0 && e.code !== null) {
    recordCrashLater(vid);
  }
});

/** 等游戏把 crash-report 写完（通常 1–3 秒），再取最新一份分析 */
async function recordCrashLater(versionId) {
  try {
    let info = null;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { items } = await listCrashes(versionId, 1);
      const newest = items?.[0];
      if (newest && Date.now() - newest.mtime < 120000) {
        info = analyzeCrash(versionId, newest.file);
        break;
      }
    }
    if (!info) return;
    const cfg = loadConfig();
    const all = { ...(cfg.lastCrash || {}) };
    all[versionId] = {
      at: Date.now(),
      file: info.file,
      title: info.title,
      signature: info.signature,
      exception: info.exception,
    };
    saveConfig({ lastCrash: all });
  } catch {
    /* 崩溃分析失败不影响主流程 */
  }
}

/** 微软账号令牌快过期时静默续期（游戏启动前调用） */
async function ensureFreshAccount() {
  const cfg = loadConfig();
  const acc = cfg.account || {};
  if (acc.type !== 'microsoft' || !acc.refreshToken) return;
  const exp = Number(acc.expiresAt || 0);
  if (exp && exp - Date.now() > 5 * 60 * 1000) return;
  const fresh = await refreshAccessToken(acc.refreshToken);
  saveConfig({ account: fresh });
}

function json(res, code, data) {
  if (data && (data.error || data.ok === false) && !data.report) {
    data.report = res.tpclReport || writeErrorReport(new Error(data.error || data.message || data.reason || '操作失败'), { route: res.tpclRoute });
  }
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':\n\n');
}

function sseSend(res, event, data) {
  if (event === 'failed' && data && !data.report) data.report = res.tpclReport || writeErrorReport(new Error(data.error || '任务失败'), { route: res.tpclRoute });
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 任务登记表：所有会跑很久的操作（装版本 / 装加载器 / 导整合包 / 装模组 / 下 Java）
 * 都在这里挂一条，前端「下载任务」面板轮询 /api/tasks 就能同时看到多条进度。
 */
const tasks = new Map();
function validId(id) { return /^[\w.+-]{1,160}$/.test(id) && id !== '.' && id !== '..'; }
function validTarget(id) { return !!id && id.length <= 200 && !/[\\/:*?"<>|\x00-\x1f]/.test(id) && id !== '.' && id !== '..'; }
function queueJob(b) {
          let input, label, run;
          if (b.type === 'version') {
            const id = String(b.id || '');
            if (!validId(id)) throw new Error('无效的版本号');
            input = { type: b.type, id, skipAssets: !!b.skipAssets };
            label = `安装 ${id}`;
            run = async onProgress => { await installVersion(id, { skipAssets: input.skipAssets, onProgress }); inspectCache.delete(id); return { ok: true, id }; };
          } else if (b.type === 'loader') {
            const kind = String(b.kind || ''), mc = String(b.mc || ''), version = String(b.version || '');
            if (!['forge', 'neoforge', 'fabric', 'quilt'].includes(kind) || !validId(mc) || !validId(version)) throw new Error('无效的加载器参数');
            input = { type: b.type, kind, mc, version };
            label = `安装 ${kind} ${version}`;
            run = async onProgress => { const r = await installLoader({ kind, mc, version, onProgress }); inspectCache.delete(r.id); return { ok: true, ...r }; };
          } else if (b.type === 'modpack') {
            const file = path.resolve(String(b.path || ''));
            if (!/\.(zip|mrpack)$/i.test(file) || !fs.statSync(file).isFile()) throw new Error('请选择 zip 或 mrpack 整合包');
            input = { type: b.type, path: file };
            label = `导入 ${path.basename(file)}`;
            run = async onProgress => { const r = await importModpack(file, onProgress); inspectCache.delete(r.id); return r; };
          } else if (b.type === 'java') {
  const major = Number(b.major);
  if (![8, 11, 17, 21, 25].includes(major)) throw new Error('不支持的 Java 版本');
  input = { type: 'java', major }; label = '安装 Java ' + major;
  run = async onProgress => { const javaPath = await downloadJava(major, onProgress); await scanJavas(true); return { ok: true, path: javaPath, major }; };
} else if (b.type === 'market') {
  const project = String(b.project || ''), version = String(b.version || ''), type = String(b.resourceType || ''), target = String(b.target || '');
  if (!project || !version || !['mod','resourcepack','shader','modpack'].includes(type) || (type !== 'modpack' && !validTarget(target))) throw new Error('资源安装参数不完整');
  input = { type: 'market', project, version, resourceType: type, target }; label = '安装资源 ' + project;
  run = async onProgress => type === 'modpack'
    ? installModpackProject({ projectId: project, versionId: version, onProgress })
    : { ok: true, target, installed: await installProjectVersion({ projectId: project, versionId: version, target, type, onProgress }) };
} else if (b.type === 'cf') {
  const mod = String(b.mod || ''), file = String(b.file || ''), target = String(b.target || '');
  if (!/^\d+$/.test(mod) || !/^\d+$/.test(file) || (target && !validTarget(target))) throw new Error('CurseForge 安装参数不完整');
  input = { type: 'cf', mod, file, target }; label = '安装 CurseForge ' + mod;
  run = async onProgress => { const info = await cfGetMod(mod); return installCfFile({ modId: mod, fileId: file, target, onProgress, classId: info.classId }); };
} else { throw new Error('不支持的任务类型'); }

  input.mcDir = b.mcDir || loadConfig().mcDir;
  const execute = run;
  run = async progress => {
    if (path.resolve(loadConfig().mcDir) !== path.resolve(input.mcDir)) throw new Error('游戏目录已改变，请切回原目录或重新添加任务');
    return execute(progress);
  };
  return { input, label, run };

}
const installQueue = new TaskQueue({ report: writeErrorReport, file: path.join(DATA_DIR, 'download-queue.json'), resolveRun: input => queueJob(input).run });
let taskSeq = 0;

function taskStart(label) {
  const id = `t${++taskSeq}`;
  tasks.set(id, { id, label, stage: '准备中', percent: 0, startedAt: Date.now(), done: false, error: null });
  return id;
}

function taskUpdate(id, patch) {
  const t = tasks.get(id);
  if (!t) return;
  if (patch.stage != null) t.stage = String(patch.stage);
  if (patch.percent != null && Number.isFinite(Number(patch.percent))) {
    t.percent = Math.max(0, Math.min(100, Math.round(Number(patch.percent))));
  }
  if (patch.label) t.label = String(patch.label);
}

function taskEnd(id, error = null) {
  const t = tasks.get(id);
  if (!t) return;
  t.done = true;
  t.error = error ? String(error) : null;
  t.percent = error ? t.percent : 100;
  // 结束后留 20 秒让前端看到结果，再清掉
  setTimeout(() => tasks.delete(id), 20000);
}

/** 包一层 onProgress：既推给 SSE，也写进任务表 */
function trackTask(label, send) {
  const id = taskStart(label);
  return {
    id,
    onProgress(e) {
      if (!e) return;
      taskUpdate(id, { stage: e.text || e.stage || '', percent: e.percent });
      try { send(e); } catch {}
    },
    update(patch) { taskUpdate(id, patch); },
    end(err) { taskEnd(id, err); },
  };
}


/**
 * 把模组文件名压成“同一个模组”的键，用来发现重复安装。
 * sodium-fabric-0.8.13+mc1.21.1.jar → sodium
 * ModernFix-5.19.0.jar              → modernfix
 * jei-1.21.1-forge-19.21.0.246.jar  → jei
 */
function modKey(name) {
  let s = String(name || '').toLowerCase().replace(/\.disabled$/, '').replace(/\.(jar|zip)$/, '');
  s = s.replace(/\+.*$/, '');
  s = s.replace(/[-_.]?v?\d+(?:[.\-]\d+)*.*$/, '');
  s = s.replace(/[-_.](fabric|forge|neoforge|quilt|paper|mc)([-_.].*)?$/, '');
  return s.replace(/[^a-z0-9]+/g, '');
}

async function statePayload() {
  const cfg = loadConfig();
  const versions = listLocalVersions();
  const javas = await scanJavas();
  const acc = cfg.account || {};
  return {
    // 令牌不下发到前端，只给界面需要的信息
    config: { ...cfg, account: { name: acc.name, uuid: acc.uuid, type: acc.type, hasToken: Boolean(acc.accessToken) } },
    versions,
    javas,
    running: running ? { id: running.id, pid: running.pid, startedAt: running.startedAt } : null,
    games: activeGames().map((g) => ({ id: g.id, pid: g.pid, startedAt: g.startedAt })),
    mcDir: cfg.mcDir,
    paths: {
      mcDir: cfg.mcDir,
      versions: versionsDir(),
      java: JAVA_HOME_DIR,
      data: DATA_DIR,
    },
  };
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(WEB_DIR, rel);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(WEB_DIR))) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      json(res, 404, { error: 'not found' });
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/** 把规则里的 action id 换成带 label/hint 的对象，前端直接渲染 */
function decorateActions(r) {
  if (!r || !Array.isArray(r.actions)) return r;
  return { ...r, actions: r.actions.filter((id) => ACTIONS[id]).map((id) => ({ id, label: ACTIONS[id].label, hint: ACTIONS[id].hint })) };
}

export function createServer(opts = {}) {
  applyProxyEnv(loadConfig()); // 让 Node 的 fetch 走设置里的 HTTP 代理
  const onRestart = typeof opts.onRestart === 'function' ? opts.onRestart : null;
  const onQuit = typeof opts.onQuit === 'function' ? opts.onQuit : null;
  // 局域网发现是被动监听，起不来也不影响其他功能
  try {
    const r = startLanWatcher();
    if (!r.ok) console.error(`[TPCL] 局域网发现未启动：${r.error}`);
  } catch (e) {
    console.error(`[TPCL] 局域网发现异常：${e.message}`);
  }
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
      res.tpclRoute = p;

    try {
        if (p === '/api/reports' && req.method === 'GET') {
          const names = fs.existsSync(REPORT_DIR) ? fs.readdirSync(REPORT_DIR).filter(n => /^[a-zA-Z0-9-]+\.json$/.test(n)).sort().reverse().slice(0, 100) : [];
          json(res, 200, { ok: true, reports: names.map(id => ({ id, time: id.slice(0, 19).replace('T', ' ') })) });
          return;
        }
        if (p === '/api/catalog/sources') {
          if (req.method === 'POST') { const b = await readBody(req); json(res, 200, { ok: true, curseforge: saveApiKey(b.key) }); }
          else json(res, 200, { ok: true, curseforge: sourceStatus() });
          return;
        }
        if (p === '/api/cf/search' && req.method === 'GET') {
          json(res, 200, { ok: true, ...await cfSearch(Object.fromEntries(url.searchParams)) }); return;
        }
        if (p === '/api/reports/client' && req.method === 'POST') {
          const b = await readBody(req);
          const error = new Error(String(b.message || '前端异常').slice(0, 8000));
          error.stack = String(b.stack || '').slice(0, 24000);
          json(res, 200, { ok: true, report: writeErrorReport(error, { source: 'renderer', page: String(b.page || '').split('?')[0] }) });
          return;
        }
        if (p.startsWith('/api/reports/') && req.method === 'GET') {
          const id = p.slice('/api/reports/'.length);
          if (!/^[a-zA-Z0-9-]+\.json$/.test(id)) { json(res, 400, { error: '无效报告名称' }); return; }
          const file = path.join(REPORT_DIR, id);
          if (!fs.existsSync(file)) { json(res, 404, { error: '报告不存在' }); return; }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="TPCL-error-${id}"` });
          res.end(await fsp.readFile(file));
          return;
        }
        if (p === '/api/queue' && req.method === 'POST') {
          const b = await readBody(req);
          const { input, label, run } = queueJob(b);
          json(res, 202, { ok: true, task: installQueue.add(label, input, run) });
          return;
        }
        if (p === '/api/queue/action' && req.method === 'POST') {
          const b = await readBody(req);
          if (b.action === 'clear') { installQueue.clear(); for (const [id, t] of tasks) if (t.done) tasks.delete(id); json(res, 200, { ok: true }); }
          else if (b.action === 'cancel') json(res, 200, { ok: installQueue.cancel(b.id) });
          else if (b.action === 'retry') json(res, 200, { ok: true, task: installQueue.retry(b.id) });
          else json(res, 400, { error: '未知操作' });
          return;
        }
      if (p === '/api/plugin-market') { await pluginMarketRoute(req,res,json); return; }
      if (p === '/api/state' && req.method === 'GET') {
        json(res, 200, await statePayload());
        return;
      }

      if (p === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.mcDir && path.resolve(body.mcDir) !== path.resolve(loadConfig().mcDir)
            && installQueue.list().some(t => t.status === 'running')) {
          json(res, 409, { error: '安装正在进行，请等当前任务结束后再切换游戏目录' }); return;
        }
        // 前端拿不到令牌，保存设置时不能把它抹掉：微软账号只改昵称/类型时合并旧令牌
        if (body.account && body.account.type === 'microsoft' && !body.account.accessToken) {
          const old = loadConfig().account || {};
          if (old.type === 'microsoft' && old.accessToken) {
            body.account = { ...old, ...body.account, accessToken: old.accessToken, refreshToken: old.refreshToken };
          } else {
            // 没有可用令牌就不要假装是微软账号
            body.account = { name: body.account.name || 'Steve', uuid: '', type: 'offline' };
          }
        }
        const cfg = saveConfig(body);
        // 改内存/隔离目录/Java 会影响 inspect 结论，缓存必须一起清掉
        inspectCache.clear();
        applyProxyEnv(loadConfig()); // 保存后重新应用
        json(res, 200, { ok: true, config: cfg });
        return;
      }

      if (p === '/api/remote-versions' && req.method === 'GET') {
        const includeSnapshot = url.searchParams.get('snapshots') === '1';
        const data = await listRemoteVersions({ includeSnapshot });
        json(res, 200, data);
        return;
      }

      if (p === '/api/game-lang' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.version || loadConfig().selectedVersion;
        if (!id) { json(res, 400, { error: '未指定版本' }); return; }
        const lang = String(body.lang || loadConfig().language || 'zh_cn');
        const r = await writeGameLanguage(id, lang);
        if (body.persist !== false) saveConfig({ language: lang, forceGameLang: body.force !== false });
        json(res, 200, { ok: true, version: id, lang, ...r });
        return;
      }

      if (p === '/api/launch' && req.method === 'POST') {
        const body = await readBody(req);
        const idPre = body.versionId || loadConfig().selectedVersion;
        if (idPre && activeGames().some((g) => g.id === idPre)) {
          json(res, 409, { error: `「${idPre}」已经在运行了` });
          return;
        }
        const id = idPre;
        if (!id) { json(res, 400, { error: '未指定版本' }); return; }
        // 版本不存在就直接拒，别把用户选中的版本写坏
        if (!fs.existsSync(versionJsonPath(id))) {
          json(res, 404, { error: `版本不存在：${id}`, code: 'NO_VERSION' });
          return;
        }
        logBuffer.length = 0;
        saveConfig({ selectedVersion: id });
        // 启动前自动备份存档（设置里可关）
        if (loadConfig().autoBackupBeforeLaunch) {
          try {
            const made = await backupAll(id);
            const n = Array.isArray(made) ? made.length : 0;
            bus.emit('log', {
              type: 'system',
              text: n ? `[TPCL] 启动前已备份 ${n} 个存档\n` : '[TPCL] 启动前备份：这个版本没有存档\n',
            });
          } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
            bus.emit('log', { type: 'system', text: `[TPCL] 启动前备份失败（不影响启动）：${e.message}\n` });
          }
        }
        // 微软账号的 Minecraft 令牌约 24 小时过期，启动前顺手续一次
        try { await ensureFreshAccount(); } catch { /* 续期失败就让游戏自己报错 */ }
        try {
          // quickJoin：从服务器列表一键进服
          // 1.20 起原版忽略 --server/--port，改用 --quickPlayMultiplayer host:port
          const extra = [];
          if (body.quickJoin?.host) {
            const host = String(body.quickJoin.host).trim();
            const port = Number(body.quickJoin.port) || 25565;
            if (/^[A-Za-z0-9._:-]+$/.test(host)) {
              const chain = (await resolveVersion(id)).chain ?? [];
              const mcVer = chain[chain.length - 1] || '';
              const m = mcVer.match(/^(\d+)\.(\d+)/);
              const modern = m ? (Number(m[1]) > 1 || (Number(m[1]) === 1 && Number(m[2]) >= 20)) : true;
              const addr = port === 25565 ? host : `${host}:${port}`;
              if (modern) extra.push('--quickPlayMultiplayer', addr);
              else extra.push('--server', host, '--port', String(port));
            }
          }
          const opts = { memory: body.memory };
          if (extra.length) opts.gameArgs = extra.join(' ');
          if (body.force) opts.force = true;
          running = await startGame(id, opts);
          games.set(id, running);
          try {
            const cfgNow = loadConfig();
            const lp = { ...(cfgNow.lastPlayed || {}), [id]: Date.now() };
            // 这次能起来，就把上一次的崩溃标记清掉
            const lc = { ...(cfgNow.lastCrash || {}) };
            const hadCrash = Boolean(lc[id]);
            if (hadCrash) delete lc[id];
            // 记一份启动参数快照，出问题时可对照/复制
            let snapshot = null;
            try {
              const built = await buildLaunchCommand(id, opts);
              snapshot = {
                at: Date.now(),
                memory: opts.memory ?? cfgNow.memory,
                gameArgs: opts.gameArgs || '',
                java: built?.javaPath ?? '',
                args: built?.args ?? [],
              };
            } catch {}
            saveConfig({
              lastPlayed: lp,
              ...(hadCrash ? { lastCrash: lc } : {}),
              ...(snapshot ? { lastLaunch: { id, ...snapshot } } : {}),
            });
          } catch {}
          json(res, 200, { ok: true, pid: running.pid, joined: extra.length ? extra.join(' ') : null });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message, code: e.code });
        }
        return;
      }

      if (p === '/api/stop' && req.method === 'POST') {
        let want = '';
        try { const b = await readBody(req); want = String(b.versionId || ''); } catch {}
        const list = activeGames();
        const target = want ? list.find((g) => g.id === want) : list.slice(-1)[0];
        if (target) {
          target.child.kill();
          json(res, 200, { ok: true, id: target.id, stopped: want || target.id });
        } else {
          json(res, 200, { ok: false, error: '没有正在运行的游戏' });
        }
        return;
      }

      if (p === '/api/auth/ms/start' && req.method === 'POST') {
        try {
          const d = await startDeviceCode();
          json(res, 200, d);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/auth/ms/finish' && req.method === 'GET') {
        const device = url.searchParams.get('device') || '';
        const interval = Number(url.searchParams.get('interval') || 5);
        if (!device) { json(res, 400, { error: '缺少 device' }); return; }
        sse(res);
        try {
          const account = await finishLogin(device, interval, (stage, text) =>
            sseSend(res, 'step', { stage, text }),
          );
          saveConfig({ account });
          sseSend(res, 'done', {
            ok: true,
            account: { name: account.name, uuid: account.uuid, type: account.type },
          });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          sseSend(res, 'failed', { ok: false, error: e.message });
        }
        res.end();
        return;
      }

      if (p === '/api/auth/offline' && req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.name || '').trim() || 'Steve';
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
          json(res, 200, { ok: false, error: '用户名需 3-16 位字母数字下划线' });
          return;
        }
        saveConfig({ account: { name, uuid: '', type: 'offline' } });
        json(res, 200, { ok: true, account: { name, type: 'offline' } });
        return;
      }

      if (p === '/api/auth/logout' && req.method === 'POST') {
        saveConfig({ account: { name: 'Steve', uuid: '', type: 'offline' } });
        json(res, 200, { ok: true });
        return;
      }

      if (p === '/api/inspect' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) { json(res, 400, { error: '缺少 id' }); return; }
        const info = await inspectCached(id);
        json(res, 200, {
          id: info.id,
          chain: info.chain,
          needJava: info.needJava,
          java: info.java ? { major: info.java.major, path: info.java.path } : null,
          missing: info.missing,
          jar: info.jar,
          libCount: info.libs.jars.length,
          gameDir: info.gameDir,
        });
        return;
      }

      if (p === '/api/version-config' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.id) { json(res, 400, { error: '缺少 id' }); return; }
        const cfg = loadConfig();
        const all = { ...(cfg.versionOverrides || {}) };
        const cur = { ...(all[body.id] || {}), ...(body.patch || {}) };
        for (const k of Object.keys(cur)) {
          if (cur[k] === '' || cur[k] === null || cur[k] === 0) delete cur[k];
        }
        if (Object.keys(cur).length) all[body.id] = cur; else delete all[body.id];
        saveConfig({ versionOverrides: all });
        inspectCache.delete(body.id);
        json(res, 200, { ok: true, override: all[body.id] || null });
        return;
      }

      if (p === '/api/crashes' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        json(res, 200, { version: id, ...listCrashes(id) });
        return;
      }

      /* ---------- 皮肤 ---------- */
      if (p === '/api/skin/lookup' && req.method === 'GET') {
        const q = url.searchParams.get('q') || loadConfig().account?.name || 'Steve';
        try {
          const prof = await lookupProfile(q);
          const tex = await profileTextures(prof.uuid).catch((e) => { console.log('profileTextures failed:', e && e.message); return { skin: '', cape: '' }; });
          json(res, 200, { ok: true, ...prof, urls: previewUrls(prof.uuid), skinUrl: tex.skin, capeUrl: tex.cape });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: `查不到「${q}」：${e.message}` });
        }
        return;
      }

      if (p === '/api/skin/mine' && req.method === 'GET') {
        const acc = loadConfig().account || {};
        const urls = previewUrls(acc.uuid);
        let skins = [];
        let error = null;
        if (acc.type === 'microsoft' && acc.accessToken) {
          try { skins = await listMySkins(); } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method }); error = e.message; }
        }
        json(res, 200, { account: { name: acc.name, uuid: acc.uuid, type: acc.type }, urls, skins, error });
        return;
      }

      if (p === '/api/skin/inspect' && req.method === 'GET') {
        const file = url.searchParams.get('path');
        if (!file) { json(res, 400, { error: '缺少 path' }); return; }
        try {
          json(res, 200, { ok: true, path: file, ...(await inspectSkinFile(file)) });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/skin/upload' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const r = await uploadSkin(body.path, body.variant);
          json(res, 200, { ok: true, ...r, urls: previewUrls(loadConfig().account?.uuid) });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/skin/download' && req.method === 'POST') {
        try {
          const r = await downloadMySkin();
          json(res, 200, { ok: true, ...r });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 400, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/skin/gallery' && req.method === 'GET') {
        try {
          const size = Math.min(Math.max(Number(url.searchParams.get('size')) || 24, 1), 48);
          const r = await listGallery(size);
          json(res, 200, r);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, count: 0, items: [], error: e.message });
        }
        return;
      }

      if (p === '/api/skin/head' && req.method === 'POST') {
        try {
          const b = await readBody(req);
          const r = await renderHead(String(b.texture || ''));
          const file = path.basename(r.file);
          openFolder(path.dirname(r.file), { select: file });
          json(res, 200, { ok: true, ...r, file });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/skin/reset' && req.method === 'POST') {
        try {
          const r = await resetSkin();
          json(res, 200, { ok: true, ...r });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/crash' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        const file = url.searchParams.get('file');
        if (!file) { json(res, 400, { error: '缺少 file' }); return; }
        json(res, 200, decorateActions(analyzeCrash(id, file)));
        return;
      }

      if (p === '/api/crash/actions') {
        json(res, 200, ACTIONS);
        return;
      }

      if (p === '/api/optifine' && req.method === 'GET') {
        const version = url.searchParams.get('version') || loadConfig().selectedVersion;
        const compat = optifineCompat(version);
        if (!compat.ok) {
          json(res, 200, { ok: false, version, mc: compat.mc || '', compat, reason: compat.reason, list: [], installed: [] });
          return;
        }
        try {
          const list = await listOptifine(compat.mc);
          json(res, 200, { ok: true, version, mc: compat.mc, compat, list, installed: installedOptifine(version) });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 500, { ok: false, reason: e.message, list: [], installed: [] });
        }
        return;
      }

      if (p === '/api/optifine/install' && req.method === 'POST') {
        const body = await readBody(req);
        const version = body.version || loadConfig().selectedVersion;
        try {
          const r = await installOptifine(version, { type: body.type, patch: body.patch });
          bus.emit('of', { type: 'done', version, ...r });
          json(res, 200, r);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 400, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/crash/fix' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const r = await applyFix(body.version || loadConfig().selectedVersion, body.action);
          json(res, r.ok ? 200 : 400, r);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 400, { ok: false, action: body.action, message: e.message });
        }
        return;
      }

      if (p === '/api/crash/parse' && req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        json(res, 200, decorateActions(analyzeText(String(b.text || ''), String(b.name || ''))));
        return;
      }

      if (p === '/api/crash/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.version || loadConfig().selectedVersion;
        await deleteCrash(id, body.file);
        json(res, 200, { ok: true, ...listCrashes(id) });
        return;
      }

      /* ---------- 服务器列表 ---------- */
      if (p === '/api/servers' && req.method === 'GET') {
        const cfg = loadConfig();
        const list = Array.isArray(cfg.servers) ? cfg.servers : [];
        if (!list.length) { json(res, 200, { servers: [] }); return; }
        const results = await pingAll(list, 6);
        const byId = new Map(results.map((r) => [r.id, r]));
        json(res, 200, { servers: list.map((s) => ({ ...s, ...(byId.get(s.id) ?? {}) })) });
        return;
      }

      if (p === '/api/servers/save' && req.method === 'POST') {
        const body = await readBody(req);
        const list = Array.isArray(body.servers) ? body.servers : [];
        const clean = list
          .map((s, i) => ({
            id: String(s.id || `s${Date.now()}${i}`),
            name: String(s.name || s.host || '').slice(0, 60),
            host: String(s.host || '').trim(),
            port: s.port ? Number(s.port) : null,
          }))
          .filter((s) => s.host);
        saveConfig({ servers: clean });
        json(res, 200, { ok: true, servers: clean });
        return;
      }

      if (p === '/api/servers/import' && req.method === 'POST') {
        // 从导出的 JSON 文件导入服务器列表（合并，按 host:port 去重）
        const body = await readBody(req);
        const file = String(body.path || '').trim();
        if (!file) { json(res, 400, { error: '缺少文件路径' }); return; }
        let raw;
        try {
          raw = await fsp.readFile(file, 'utf8');
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 400, { error: `读不到文件：${e.message}` }); return;
        }
        let arr;
        try {
          const j = JSON.parse(raw);
          arr = Array.isArray(j) ? j : (Array.isArray(j.servers) ? j.servers : null);
        } catch {
          json(res, 400, { error: '不是有效的 JSON（需要数组或 { servers: [...] }）' }); return;
        }
        if (!arr) { json(res, 400, { error: 'JSON 里没有服务器数组' }); return; }

        const cfg = loadConfig();
        const cur = Array.isArray(cfg.servers) ? [...cfg.servers] : [];
        const key = (s) => `${String(s.host || '').toLowerCase()}:${s.port || 25565}`;
        const seen = new Set(cur.map(key));
        let added = 0, skipped = 0;
        for (const s of arr) {
          const host = String(s?.host || '').trim();
          if (!host) { skipped++; continue; }
          const item = {
            id: `s${Date.now()}${added}${Math.floor(Math.random() * 100)}`,
            name: String(s.name || host).slice(0, 60),
            host,
            port: s.port ? Number(s.port) : null,
          };
          const k = key(item);
          if (seen.has(k)) { skipped++; continue; }
          seen.add(k);
          cur.push(item);
          added++;
        }
        saveConfig({ servers: cur });
        json(res, 200, { ok: true, added, skipped, total: cur.length });
        return;
      }

      if (p === '/api/servers/ping' && req.method === 'GET') {
        const host = url.searchParams.get('host');
        const port = url.searchParams.get('port');
        if (!host) { json(res, 400, { error: '缺少 host' }); return; }
        json(res, 200, await pingServer({ host, port: port ? Number(port) : undefined }));
        return;
      }

      /* ---------- 截图 ---------- */
      if (p === '/api/shots' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        const shots = listShots(id);
        json(res, 200, { version: id, dir: shotsDir(id), shots, total: shots.length });
        return;
      }

      if (p === '/api/pack-icon' && req.method === 'GET') {
        const key = url.searchParams.get('key') || '';
        const file = packIconPath(key);
        if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end('no icon'); return; }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' });
        fs.createReadStream(file).pipe(res);
        return;
      }

      if (p === '/api/shot/file' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        const name = url.searchParams.get('name') || '';
        const full = shotFile(id, name);
        if (!full) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, {
          'content-type': contentType(full),
          'content-length': st.size,
          'cache-control': 'private, max-age=60',
        });
        fs.createReadStream(full).pipe(res);
        return;
      }

      if (p === '/api/shots/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.version || loadConfig().selectedVersion;
        const r = deleteShots(id, body.names || []);
        json(res, 200, { ...r, dir: shotsDir(id) });
        return;
      }

      if (p === '/api/world/import' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.version || loadConfig().selectedVersion;
        const src = String(body.path || '').trim();
        if (!src) { json(res, 400, { error: '缺少路径' }); return; }
        try {
          const r = await importWorld(id, src);
          json(res, r.ok ? 200 : 400, { ...r, worlds: listWorlds(id) });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 500, { error: `导入失败：${e.message}` });
        }
        return;
      }

      /* ---------- 存档备份 ---------- */
      if (p === '/api/worlds' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        json(res, 200, { version: id, dir: savesDir(id), backupDir: backupsDir(id), worlds: listWorlds(id), backups: listBackups(id) });
        return;
      }

      if (p === '/api/backup' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.version || loadConfig().selectedVersion;
        if (body.world) {
          const r = await backupWorld(id, body.world, { keep: Number(body.keep) || 0 });
          json(res, 200, { ok: true, result: r, backups: listBackups(id) });
        } else {
          const results = await backupAll(id, { keep: Number(body.keep) || 0 });
          json(res, 200, { ok: results.every((r) => r.ok), results, backups: listBackups(id) });
        }
        return;
      }

      if (p === '/api/restore' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.version || loadConfig().selectedVersion;
        const r = await restoreBackup(id, body.file);
        json(res, 200, { ok: true, ...r, worlds: listWorlds(id), backups: listBackups(id) });
        return;
      }

      if (p === '/api/world/rename' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.version || loadConfig().selectedVersion;
        const from = String(body.world || '').trim();
        const to = String(body.newName || '').trim();
        if (!from || !to) { json(res, 400, { error: '缺少世界名或新名字' }); return; }
        if (!/^[^\\/:*?"<>|]{1,64}$/.test(to) || to === '.' || to === '..' || to.trim() !== to) {
          json(res, 400, { error: '名字里不能有 \\ / : * ? " < > |，长度 1–64，首尾不能是空格' });
          return;
        }
        const base = savesDir(id);
        const src = path.join(base, from);
        const dst = path.join(base, to);
        if (!fs.existsSync(path.join(src, 'level.dat'))) { json(res, 404, { error: `找不到世界：${from}` }); return; }
        if (fs.existsSync(dst)) { json(res, 409, { error: `已经有同名世界：${to}` }); return; }
        try {
          await fsp.rename(src, dst);
          json(res, 200, { ok: true, from, to });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 500, { error: `重命名失败：${e.message}` });
        }
        return;
      }

      if (p === '/api/world/duplicate' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.version || loadConfig().selectedVersion;
        const from = String(body.world || '').trim();
        if (!from) { json(res, 400, { error: '缺少世界名' }); return; }
        const base = savesDir(id);
        const src = path.join(base, from);
        if (!fs.existsSync(path.join(src, 'level.dat'))) { json(res, 404, { error: `找不到世界：${from}` }); return; }
        let name = `${from}-副本`;
        for (let n = 2; fs.existsSync(path.join(base, name)); n++) name = `${from}-副本${n}`;
        try {
          await fsp.cp(src, path.join(base, name), { recursive: true, force: false, errorOnExist: false });
          await fsp.rm(path.join(base, name, 'session.lock'), { force: true });
          json(res, 200, { ok: true, from, to: name });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          await fsp.rm(path.join(base, name), { recursive: true, force: true }).catch(() => {});
          json(res, 500, { error: `复制失败：${e.message}` });
        }
        return;
      }

      if (p === '/api/backup/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.version || loadConfig().selectedVersion;
        deleteBackup(id, body.file);
        json(res, 200, { ok: true, backups: listBackups(id) });
        return;
      }

      /* ---------- 云同步（文件夹型） ---------- */
      if (p === '/api/sync' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        try {
          json(res, 200, await syncOverview(id));
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { version: id, syncDir: syncDir(), worlds: [], remote: [], error: e.message });
        }
        return;
      }

      if (p === '/api/sync/diff' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        try {
          json(res, 200, await diffSync(id));
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: '对比失败：' + e.message });
        }
        return;
      }

      if (p === '/api/sync/diff' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        try {
          json(res, 200, await diffSync(id));
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: '对比失败：' + e.message });
        }
        return;
      }

      if (p === '/api/sync/dir' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const r = await setSyncDir(body.path || '');
          json(res, 200, { ok: true, ...r });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: '这个目录用不了：' + e.message });
        }
        return;
      }

      if (p === '/api/sync/push' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.version || loadConfig().selectedVersion;
        try {
          const r = body.world ? await pushWorld(id, body.world) : await pushAll(id);
          json(res, 200, { ok: true, ...r, remote: (await listRemote(id)).files });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/sync/pull' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.version || loadConfig().selectedVersion;
        try {
          const r = await pullWorld(id, body.world, body.file || null);
          json(res, 200, r);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/pick-folder' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const dlgTitle = String(body?.title || '选择同步目录').replace(/'/g, "''");
        const tmp = path.join(os.tmpdir(), `tpcl-folder-${Date.now()}.ps1`);
        const ps = [
          '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
          '$OutputEncoding = [System.Text.Encoding]::UTF8;',
          'Add-Type -AssemblyName System.Windows.Forms;',
          '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
          `$d.Description = '${dlgTitle}';`,
          '$d.ShowNewFolderButton = $true;',
          "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }",
        ].join('\n');
        await fsp.writeFile(tmp, '\ufeff' + ps, 'utf8');
        const r = spawnSync(
          'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
          ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmp],
          { encoding: 'utf8', windowsHide: true, timeout: 180000 }
        );
        fsp.unlink(tmp).catch(() => {});
        const picked = String(r.stdout || '').trim().split(/\r?\n/).pop().trim();
        json(res, 200, { path: picked || null, canceled: !picked });
        return;
      }

      if (p === '/api/logs') {
        sse(res);
        for (const e of logBuffer) sseSend(res, 'log', e);
        const onLog = (e) => sseSend(res, 'log', e);
        const onExit = (e) => sseSend(res, 'exit', e);
        const onUpd = (e) => sseSend(res, 'upd', e);
        bus.on('log', onLog);
        bus.on('exit', onExit);
        bus.on('upd', onUpd);
        const ping = setInterval(() => res.write(':\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          bus.off('log', onLog);
          bus.off('exit', onExit);
          bus.off('upd', onUpd);
        });
        return;
      }

      if (p === '/api/install') {
        const id = url.searchParams.get('id');
        const skipAssets = url.searchParams.get('skipAssets') === '1';
        const force = url.searchParams.get('force') === '1';
        if (!id) { json(res, 400, { error: '缺少 id' }); return; }
        sse(res);
        let lastSent = 0;
        const tk = trackTask(`安装 ${id}`, (e) => {
          const now = Date.now();
          if (now - lastSent < 80 && e.percent !== 100 && e.stage !== 'done') return;
          lastSent = now;
          sseSend(res, 'progress', e);
        });
        const onProgress = tk.onProgress;
        try {
          await installVersion(id, { onProgress, skipAssets, force });
          inspectCache.delete(id);
          tk.end();
          sseSend(res, 'done', { ok: true, id });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          tk.end(e.message);
          sseSend(res, 'failed', { ok: false, error: e.message });
        }
        res.end();
        return;
      }

      if (p === '/api/loaders' && req.method === 'GET') {
        const kind = url.searchParams.get('kind') || 'forge';
        const mc = url.searchParams.get('mc') || '';
        if (!mc) { json(res, 400, { error: '缺少 mc' }); return; }
        try {
          json(res, 200, await listLoaders(kind, mc));
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { versions: [], recommended: null, latest: null, error: e.message });
        }
        return;
      }

      if (p === '/api/install-loader') {
        const kind = url.searchParams.get('kind') || 'forge';
        const mc = url.searchParams.get('mc') || '';
        const version = url.searchParams.get('version') || '';
        if (!mc || !version) { json(res, 400, { error: '缺少 mc / version' }); return; }
        sse(res);
        let last = 0;
        const tk = trackTask(`安装 ${kind} ${version}`, (e) => {
          const now = Date.now();
          if (now - last < 100 && e.percent !== 100 && e.stage !== 'done') return;
          last = now;
          sseSend(res, 'progress', e);
        });
        const onProgress = tk.onProgress;
        try {
          const r = await installLoader({ kind, mc, version, onProgress });
          inspectCache.delete(r.id);
          tk.end();
          sseSend(res, 'done', { ok: true, ...r });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          tk.end(e.message);
          sseSend(res, 'failed', { ok: false, error: e.message, stack: e.stack });
        }
        res.end();
        return;
      }

      if (p === '/api/skin/cape' && req.method === 'GET') {
        const raw = String(url.searchParams.get('url') || '').trim();
        if (!raw.startsWith('https://textures.minecraft.net/texture/')) {
          json(res, 400, { ok: false, error: '只支持 Minecraft 官方贴图地址' });
          return;
        }
        const upstream = await fetch(raw, { signal: AbortSignal.timeout(20000) });
        if (!upstream.ok) { json(res, 502, { ok: false, error: `上游返回 ${upstream.status}` }); return; }
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' });
        res.end(buf);
        return;
      }
      if (p === '/api/skin/texture' && req.method === 'GET') {
        try {
          const want = url.searchParams.get('url') || '';
          const local = url.searchParams.get('file') || '';
          let buf = null;
          if (local) {
            const st = fs.statSync(local);
            if (st.size > 2 * 1024 * 1024) throw new Error('皮肤文件太大');
            buf = fs.readFileSync(local);
          } else {
            if (!/^https:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]+$/i.test(want)) throw new Error('只支持 textures.minecraft.net 的皮肤');
            const key = Buffer.from(want).toString('base64url').slice(0, 96);
            const dir = path.join(DATA_DIR, 'cache', 'skintex');
            const cache = path.join(dir, key + '.png');
            if (fs.existsSync(cache)) buf = fs.readFileSync(cache);
            else {
              const r = await fetch(want);
              if (!r.ok) throw new Error('取皮肤失败 HTTP ' + r.status);
              buf = Buffer.from(await r.arrayBuffer());
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(cache, buf);
            }
          }
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' });
          res.end(buf);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          res.writeHead(404); res.end(String(e?.message || e));
        }
        return;
      }
      if (p === '/api/netplay/state' && req.method === 'GET') { json(res, 200, netplayState()); return; }
      if (p === '/api/netplay/detect' && req.method === 'GET') { json(res, 200, detectLanPort(url.searchParams.get('version') || '')); return; }
      if (p === '/api/netplay/start' && req.method === 'POST') {
        const body = await readBody(req);
        const r = await startTunnel(Number(body?.port || 25565));
        json(res, 200, { ...r, state: netplayState() });
        return;
      }
      if (p === '/api/netplay/stop' && req.method === 'POST') { json(res, 200, stopTunnel()); return; }
      if (p === '/api/market/search' && req.method === 'GET') {
        try {
          const r = await searchProjects({
            kind: url.searchParams.get('type') || 'mod',
            query: url.searchParams.get('q') || '',
            mcVer: url.searchParams.get('mc') || '',
            loader: url.searchParams.get('loader') || '',
            limit: Number(url.searchParams.get('limit') || 20),
            offset: Number(url.searchParams.get('offset') || 0),
            sort: url.searchParams.get('sort') || '',
          });
          try {
            const vid = loadConfig().selectedVersion;
            const c = await listContent(vid);
            const pool = [];
            for (const k of ['mods', 'resourcepacks', 'shaderpacks', 'datapacks']) {
              for (const it of c[k] || []) pool.push(String(it.name || '').toLowerCase());
            }
            const flat = pool.join('|');
            for (const h of r.hits || []) {
              const slug = String(h.slug || '').toLowerCase();
              const dashed = slug.replace(/-/g, '');
              h.installed = !!slug && (flat.includes(slug) || (dashed.length > 4 && flat.replace(/[-_]/g, '').includes(dashed)));
            }
          } catch { /* 标记失败不影响搜索 */ }
          json(res, 200, r);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { total: 0, hits: [], error: e.message });
        }
        return;
      }

      if (p === '/api/market/projects' && req.method === 'GET') {
        try {
          const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean);
          const list = await getProjects(ids);
          json(res, 200, { ok: true, projects: list });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, projects: [], error: e.message });
        }
        return;
      }

      if (p === '/api/market/project' && req.method === 'GET') {
        try {
          const proj = await getProject(url.searchParams.get('id') || '');
          json(res, 200, { ok: true, project: proj });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/market/versions' && req.method === 'GET') {
        try {
          const list = await listProjectVersions(url.searchParams.get('id') || '', {
            mcVer: url.searchParams.get('mc') || '',
            loader: url.searchParams.get('loader') || '',
          });
          json(res, 200, { versions: list });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { versions: [], error: e.message });
        }
        return;
      }

      if (p === '/api/market/context' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        json(res, 200, versionContext(id));
        return;
      }

      // ---------- CurseForge ----------
      if (p === '/api/cf/ping') {
        try { json(res, 200, { ok: true, ...(await cfPing()) }); }
        catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method }); json(res, 200, { ok: false, error: e.message }); }
        return;
      }

      if (p === '/api/cf/mod') {
        const ref = url.searchParams.get('ref') || url.searchParams.get('id') || '';
        try { json(res, 200, { ok: true, mod: await cfResolveRef(ref) }); }
        catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method }); json(res, 200, { ok: false, error: e.message }); }
        return;
      }

      if (p === '/api/cf/files') {
        const id = url.searchParams.get('id') || '';
        const mc = url.searchParams.get('mc') || '';
        const loader = url.searchParams.get('loader') || '';
        try {
            const files = await cfListFiles(id, { mcVer: mc, loader, pageSize: 30, offset: url.searchParams.get('offset') });
          json(res, 200, { ok: true, ctx: await cfTargetContext(), files });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method }); json(res, 200, { ok: false, files: [], error: e.message }); }
        return;
      }

      if (p === '/api/cf/install') {
        const mod = url.searchParams.get('mod') || '';
        const file = url.searchParams.get('file') || '';
        const target = url.searchParams.get('target') || loadConfig().selectedVersion;
        if (!mod || !file) { json(res, 400, { error: '缺少 mod 或 file' }); return; }
        sse(res);
        let last = 0;
        const tk = trackTask(`安装 CF ${mod}`, (e) => {
          const now = Date.now();
          if (now - last < 120 && e.percent !== 100) return;
          last = now;
          sseSend(res, 'progress', e);
        });
        try {
          const info = await cfGetMod(mod);
          const r = await installCfFile({ modId: mod, fileId: file, target, classId: info.classId, onProgress: tk.onProgress });
          tk.end();
          sseSend(res, 'done', r);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          tk.end(e.message);
          sseSend(res, 'failed', { error: e.message });
        }
        res.end();
        return;
      }

      if (p === '/api/market/install') {        const project = url.searchParams.get('project') || '';
        const version = url.searchParams.get('version') || '';
        const target = url.searchParams.get('target') || loadConfig().selectedVersion;
        const type = url.searchParams.get('type') || 'mod';
        if (!project) { json(res, 400, { error: '缺少 project' }); return; }
        sse(res);
        let last = 0;
        const tk = trackTask(`安装 ${project}`, (e) => {
          const now = Date.now();
          if (now - last < 120 && e.percent !== 100) return;
          last = now;
          sseSend(res, 'progress', e);
        });
        const onProgress = tk.onProgress;
        try {
          let r;
          if (type === 'modpack') {
            r = await installModpackProject({ projectId: project, versionId: version, onProgress });
            inspectCache.delete(r.id);
          } else {
            const installed = await installProjectVersion({
              projectId: project, versionId: version, target, type, onProgress,
            });
            r = { ok: true, target, installed };
          }
          tk.end();
          sseSend(res, 'done', { ok: true, ...r });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          tk.end(e.message);
          sseSend(res, 'failed', { ok: false, error: e.message });
        }
        res.end();
        return;
      }

      if (p === '/api/theme/bg' && req.method === 'POST') {
        const pb = await readBody(req).catch(() => ({}));
        if (pb?.clear === true) {
          saveConfig({ bgPath: '', bgDim: Number(pb.dim) || 0.35, bgBlur: Number(pb.blur) || 0 });
          json(res, 200, { ok: true, bgPath: '' });
          return;
        }
        const src = String(pb?.file || '');
        if (!src || !fs.existsSync(src)) { json(res, 400, { error: '文件不存在' }); return; }
        const ext = (path.extname(src) || '.png').toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) { json(res, 400, { error: '只支持 png / jpg / webp / bmp' }); return; }
        const dir = path.join(DATA_DIR, 'backgrounds');
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, 'bg-' + Date.now() + ext);
        fs.copyFileSync(src, dest);
        for (const n of fs.readdirSync(dir)) {
          const p2 = path.join(dir, n);
          if (p2 !== dest && fs.statSync(p2).size < 40 * 1024 * 1024) fs.unlinkSync(p2);
        }
        saveConfig({ bgPath: dest, bgDim: Number(pb.dim) || 0.35, bgBlur: Number(pb.blur) || 0 });
        json(res, 200, { ok: true, bgPath: dest });
        return;
      }

      if (p === '/api/theme/bg-image') {
        const bp = loadConfig().bgPath || '';
        if (!bp || !fs.existsSync(bp)) { res.writeHead(404); res.end('no bg'); return; }
        const ext = path.extname(bp).toLowerCase();
        const ct = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : (ext === '.bmp' ? 'image/bmp' : 'image/jpeg'));
        res.writeHead(200, { 'content-type': ct, 'cache-control': 'private, max-age=60' });
        fs.createReadStream(bp).pipe(res);
        return;
      }

      if (p === '/api/theme/bg' && req.method === 'DELETE') {
        saveConfig({ bgPath: '' });
        json(res, 200, { ok: true });
        return;
      }

      if (p === '/api/pick-file' && req.method === 'POST') {
        const pb = await readBody(req).catch(() => ({}));
        const filter = String(pb?.filter || '整合包 (*.mrpack;*.zip)|*.mrpack;*.zip|所有文件 (*.*)|*.*').replace(/'/g, "''");
        const dlgTitle = String(pb?.title || '选择整合包').replace(/'/g, "''");
        const wantFolder = pb?.folder === true;
        const stamp = Date.now();
        const tmp = path.join(os.tmpdir(), `tpcl-pick-${stamp}.ps1`);
        const resFile = path.join(os.tmpdir(), `tpcl-pick-out-${stamp}.txt`);
        const ps = wantFolder
          ? [
              'Add-Type -AssemblyName System.Windows.Forms;',
              '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
              `$d.Description = '${dlgTitle}';`,
              `$out = '${resFile.replace(/'/g, "''")}';`,
              "if ($d.ShowDialog() -eq 'OK') { [System.IO.File]::WriteAllText($out, $d.SelectedPath, [System.Text.Encoding]::UTF8) }",
            ].join('\n')
          : [
              'Add-Type -AssemblyName System.Windows.Forms;',
              '$d = New-Object System.Windows.Forms.OpenFileDialog;',
              `$d.Filter = '${filter}';`,
              `$d.Title = '${dlgTitle}';`,
              `$out = '${resFile.replace(/'/g, "''")}';`,
              "if ($d.ShowDialog() -eq 'OK') { [System.IO.File]::WriteAllText($out, $d.FileName, [System.Text.Encoding]::UTF8) }",
            ].join('\n');
        await fsp.writeFile(tmp, '\ufeff' + ps, 'utf8');
        spawnSync(
          'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
          ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmp],
          { windowsHide: true, timeout: 180000 }
        );
        let picked = '';
        try { picked = fs.readFileSync(resFile, 'utf8').replace(/^\uFEFF/, '').trim(); } catch { /* 用户取消 */ }
        fsp.unlink(tmp).catch(() => {});
        fsp.unlink(resFile).catch(() => {});
        json(res, 200, { path: picked || null, canceled: !picked });
        return;
      }

      if (p === '/api/gpu' && req.method === 'GET') {
        const cfg = loadConfig();
        let java = url.searchParams.get('java') || cfg.javaPath || '';
        if (!java && cfg.selectedVersion) {
          try { java = (await inspectVersion(cfg.selectedVersion)).java?.path || ''; } catch { /* ignore */ }
        }
        const gpus = listGpus();
        json(res, 200, {
          java,
          gpus,
          discrete: gpus.filter((g) => looksDiscrete(g.name)).map((g) => g.name),
          preference: java ? getGpuPreference(java) : null,
          enabled: cfg.gpuHigh === true,
        });
        return;
      }

      if (p === '/api/gpu' && req.method === 'POST') {
        const body = await readBody(req);
        const cfg = loadConfig();
        let java = body.java || cfg.javaPath || '';
        if (!java && cfg.selectedVersion) {
          try { java = (await inspectVersion(cfg.selectedVersion)).java?.path || ''; } catch { /* ignore */ }
        }
        const enable = body.enabled !== false;
        const r = setGpuPreference(java, enable);
        if (r.ok) saveConfig({ gpuHigh: enable });
        json(res, r.ok ? 200 : 400, { ok: r.ok, enabled: enable, java, error: r.error });
        return;
      }

      if (p === '/api/game-lang' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        json(res, 200, {
          version: id,
          lang: await readGameLanguage(id),
          configured: loadConfig().language || 'zh_cn',
          force: loadConfig().forceGameLang !== false,
          supported: GAME_LANGS,
        });
        return;
      }

      if (p === '/api/modpack/inspect') {
        const file = url.searchParams.get('path') || '';
        if (!file) { json(res, 400, { error: '缺少 path' }); return; }
        try {
          const info = await inspectModpack(file);
          json(res, 200, { ok: true, ...info });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/modpack/import') {
        const file = url.searchParams.get('path') || '';
        if (!file) { json(res, 400, { error: '缺少 path' }); return; }
        sse(res);
        let last = 0;
        const tk = trackTask(`导入整合包 ${file.split(/[\\/]/).pop()}`, (e) => {
          const now = Date.now();
          if (now - last < 100 && e.percent !== 100 && e.stage !== 'done') return;
          last = now;
          sseSend(res, 'progress', e);
        });
        const onProgress = tk.onProgress;
        try {
          const r = await importModpack(file, onProgress);
          inspectCache.delete(r.id);
          // 整合包自带的 options.txt 往往是 en_us，导入后按设置改回中文
          try {
            const lr = await writeGameLanguage(r.id, loadConfig().language || 'zh_cn');
            if (lr?.changed) sseSend(res, 'progress', { stage: 'lang', percent: 100, text: `游戏语言已设为 ${lr.lang}` });
          } catch { /* 不影响导入结果 */ }
          tk.end();
          sseSend(res, 'done', r);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          tk.end(e.message);
          sseSend(res, 'failed', { ok: false, error: e.message, stack: e.stack });
        }
        res.end();
        return;
      }

      if (p === '/api/modpack/export' && req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        try {
          const r = await exportModpack(b.version || b.versionId || loadConfig().selectedVersion, { includeSaves: !!b.includeSaves });
          json(res, 200, r);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/java/fit' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        if (!id) { json(res, 400, { error: '缺少 version' }); return; }
        try {
          const info = await inspectVersion(id);
          const required = info.json?.javaVersion?.majorVersion ?? 8;
          const javas = await scanJavas();
          const ovPath = ((loadConfig().versionOverrides || {})[id] || {}).javaPath || '';
          const ovJava = ovPath ? javas.find((j) => j.path.toLowerCase() === ovPath.toLowerCase()) || null : null;
          const cur = ovJava || info.java || null;
          const best = javas.find((j) => j.major === required && j.auto !== false) || javas.find((j) => j.major === required) || null;
          json(res, 200, {
            ok: true,
            version: id,
            required,
            current: cur ? { path: cur.path, major: cur.major } : null,
            best: best ? { path: best.path, major: best.major, home: best.home || '' } : null,
            match: !!(cur && cur.major === required),
          });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/java/inspect' && req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        try {
          const info = await inspectJavaFile(b?.path);
          json(res, 200, info);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/java/download') {
        const major = Number(url.searchParams.get('major') || 21);
        sse(res);
        const tk = trackTask(`安装 Java ${major}`, (e) => sseSend(res, 'progress', e));
        try {
          const javaPath = await downloadJava(major, tk.onProgress);
          tk.end();
          sseSend(res, 'done', { ok: true, major, path: javaPath });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          tk.end(e.message);
          sseSend(res, 'failed', { ok: false, error: e.message });
        }
        res.end();
        return;
      }

      if (p === '/api/tasks' && req.method === 'GET') {
        const list = [...tasks.values(), ...installQueue.list()]
          .map((t) => ({ ...t, age: Date.now() - t.startedAt }))
          .sort((a, b) => a.startedAt - b.startedAt);
        json(res, 200, { tasks: list, active: list.filter((t) => !t.done).length });
        return;
      }

      if (p === '/api/java' && req.method === 'GET') {
        const javas = await scanJavas(true);
        json(res, 200, { javas });
        return;
      }

      if (p === '/api/java/remove' && req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        try {
          json(res, 200, await removeJava(b.home));
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/delete-version' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.id) { json(res, 400, { error: '缺少 id' }); return; }
        const r = await deleteVersion(body.id);
        inspectCache.delete(body.id);
        json(res, 200, r);
        return;
      }

      // 重命名版本（改目录名 + 改 json 里的 id，并同步配置里引用它的地方）
      if (p === '/api/duplicate-version' && req.method === 'POST') {
        // 复制一个版本（PCL2 的「复制版本」）：只复制版本目录里的配置与模组，
        // 不碰 assets / libraries / 存档 / 日志 —— 那些共用或属于玩家数据。
        const body = await readBody(req);
        const src = String(body.id || '').trim();
        if (!src) { json(res, 400, { error: '缺少 id' }); return; }
        if (!fs.existsSync(versionJsonPath(src))) { json(res, 404, { error: `版本不存在：${src}` }); return; }

        let newId = String(body.newId || '').trim();
        if (!newId) {
          let n = 1;
          do { newId = `${src}-副本${n === 1 ? '' : n}`; n++; } while (fs.existsSync(versionDir(newId)));
        }
        if (!/^[^\\/:*?"<>|]{1,64}$/.test(newId) || newId === '.' || newId === '..' || newId.trim() !== newId) {
          json(res, 400, { error: '名称里不能有 \\ / : * ? " < > |，长度 1–64，首尾不能是空格' });
          return;
        }
        if (fs.existsSync(versionDir(newId))) { json(res, 409, { error: `已经有同名版本：${newId}` }); return; }

        const SKIP = new Set(['saves', 'logs', 'crash-reports', 'screenshots', 'replay_recordings', '.mixin.out']);
        const from = versionDir(src);
        const to = versionDir(newId);
        let files = 0;
        try {
          await fsp.cp(from, to, {
            recursive: true,
            force: true,
            errorOnExist: false,
            filter: (s) => {
              const rel = path.relative(from, s);
              if (!rel) return true;
              const head = rel.split(path.sep)[0];
              if (SKIP.has(head)) return false;
              return true;
            },
          });
          // 版本 json 改成新 id，文件名也改
          const oldJson = path.join(to, `${src}.json`);
          const newJson = path.join(to, `${newId}.json`);
          if (fs.existsSync(oldJson)) {
            const j = JSON.parse(await fsp.readFile(oldJson, 'utf8'));
            j.id = newId;
            await fsp.writeFile(newJson, JSON.stringify(j, null, 2), 'utf8');
            await fsp.rm(oldJson, { force: true });
          }
          // 旧 jar 跟着改名（原版版本的 jar 与目录同名）
          const oldJar = path.join(to, `${src}.jar`);
          if (fs.existsSync(oldJar)) await fsp.rename(oldJar, path.join(to, `${newId}.jar`));
          const walk = async (d) => {
            for (const e of await fsp.readdir(d, { withFileTypes: true })) {
              const p = path.join(d, e.name);
              if (e.isDirectory()) await walk(p); else files++;
            }
          };
          await walk(to);
          inspectCache.delete(newId);
          json(res, 200, { ok: true, id: newId, from: src, files });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          await fsp.rm(to, { recursive: true, force: true }).catch(() => {});
          json(res, 500, { error: `复制失败：${e.message}` });
        }
        return;
      }

      if (p === '/api/rename-version' && req.method === 'POST') {
        const body = await readBody(req);
        const oldId = String(body.id || '').trim();
        const newId = String(body.newId || '').trim();
        if (!oldId || !newId) { json(res, 400, { error: '缺少 id 或 newId' }); return; }
        if (oldId === newId) { json(res, 200, { ok: true, id: newId, unchanged: true }); return; }
        if (!/^[^\\/:*?"<>|]{1,64}$/.test(newId) || newId === '.' || newId === '..' || newId.trim() !== newId) {
          json(res, 400, { error: '名称里不能有 \\ / : * ? " < > |，长度 1–64，首尾不能是空格' });
          return;
        }
        const from = versionDir(oldId);
        const to = versionDir(newId);
        if (!fs.existsSync(versionJsonPath(oldId))) { json(res, 404, { error: `版本不存在：${oldId}` }); return; }
        if (fs.existsSync(to)) { json(res, 409, { error: `已经有同名版本：${newId}` }); return; }
        try {
          await fsp.rename(from, to);
          // 重写 json 的 id（文件名也跟着改）
          const oldJson = path.join(to, `${oldId}.json`);
          const newJson = path.join(to, `${newId}.json`);
          if (fs.existsSync(oldJson)) {
            const j = JSON.parse(await fsp.readFile(oldJson, 'utf8'));
            j.id = newId;
            await fsp.writeFile(newJson, JSON.stringify(j, null, 2), 'utf8');
            if (newJson !== oldJson) await fsp.rm(oldJson, { force: true });
          }
          // 同步配置里的引用
          const cfg = loadConfig();
          const patch = {};
          if (cfg.selectedVersion === oldId) patch.selectedVersion = newId;
          const lp = { ...(cfg.lastPlayed || {}) };
          if (lp[oldId]) { lp[newId] = lp[oldId]; delete lp[oldId]; patch.lastPlayed = lp; }
          const vo = { ...(cfg.versionOverrides || {}) };
          if (vo[oldId]) { vo[newId] = vo[oldId]; delete vo[oldId]; patch.versionOverrides = vo; }
          const lcr = { ...(cfg.lastCrash || {}) };
          if (lcr[oldId]) { lcr[newId] = lcr[oldId]; delete lcr[oldId]; patch.lastCrash = lcr; }
          if (Object.keys(patch).length) saveConfig(patch);
          inspectCache.delete(oldId);
          inspectCache.delete(newId);
          json(res, 200, { ok: true, id: newId, from: oldId });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 500, { error: e.message });
        }
        return;
      }

      // 校验并修复版本文件（缺什么补什么）
      if (p === '/api/repair' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.id || loadConfig().selectedVersion;
        if (!id) { json(res, 400, { error: '缺少 id' }); return; }
        const r = await repairVersion(id);
        inspectCache.delete(id);
        json(res, 200, r);
        return;
      }

      // 目录占用统计：缓存 / 数据 / 日志
      if (p === '/api/lan' && req.method === 'GET') {
        json(res, 200, listLan());
        return;
      }

      if (p === '/api/selfcheck' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        const checks = [];
        const add = (level, title, detail) => checks.push({ level, title, detail });

        // 1) 游戏目录
        const cfg0 = loadConfig();
        try {
          fs.mkdirSync(cfg0.mcDir, { recursive: true });
          const probe = path.join(cfg0.mcDir, '.tpcl-write-test');
          fs.writeFileSync(probe, 'ok');
          fs.unlinkSync(probe);
          add('ok', '游戏目录可写', cfg0.mcDir);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          add('bad', '游戏目录不可写', `${cfg0.mcDir}（${e.message}）`);
        }

        // 2) 选中版本
        try {
          if (!id) add('warn', '没有选中版本', '先在启动页选一个版本');
          else if (!fs.existsSync(versionJsonPath(id))) add('bad', '版本不存在', `${id} 的 json 找不到`);
          else {
            const info = await inspectVersion(id);
            if (info.missing?.length) add('bad', `版本不完整（缺 ${info.missing.length} 项）`, info.missing.join('、'));
            else add('ok', '版本完整', `${id} · ${info.clientJar ? '主文件就绪' : '靠继承父版本'}`);
          }
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          add('warn', '版本检查失败', e.message);
        }

        // 3) Java
        try {
          const javas = await scanJavas(true);
          const majors = [...new Set(javas.map((j) => j.major))].sort((a, b) => b - a);
          add(javas.length ? 'ok' : 'bad', `找到 ${javas.length} 个 Java`,
            javas.length ? `版本 ${majors.join(' / ')}` : '启动器会自动下载，也可以在设置里手动装');
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          add('warn', 'Java 扫描失败', e.message);
        }

        // 4) 磁盘占用
        try {
          const sizeOf = async (dir) => {
            let total = 0;
            const walk = async (d) => {
              let items = [];
              try { items = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
              for (const it of items) {
                const full = path.join(d, it.name);
                if (it.isDirectory()) await walk(full);
                else { try { total += (await fsp.stat(full)).size; } catch { /* skip */ } }
              }
            };
            await walk(dir);
            return total;
          };
          const [cache, logs, backups] = await Promise.all([
            sizeOf(path.join(DATA_DIR, 'cache')),
            sizeOf(path.join(DATA_DIR, 'logs')),
            sizeOf(path.join(DATA_DIR, 'backups')),
          ]);
          const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
          add('ok', '数据目录占用',
            `缓存 ${mb(cache)} · 日志 ${mb(logs)} · 备份 ${mb(backups)}`);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          add('warn', '统计失败', e.message);
        }

        // 5) 下载源连通性（各给 6 秒，失败只提示不中断）
        const pingUrl = async (name, u) => {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 6000);
          const t0 = Date.now();
          try {
            const r = await fetch(u, { method: 'HEAD', signal: ac.signal, redirect: 'follow' });
            add(r.ok || r.status === 302 ? 'ok' : 'warn', `${name} 可达`,
              `HTTP ${r.status} · ${Date.now() - t0}ms`);
          } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
            add('warn', `${name} 不通`, e.name === 'AbortError' ? '超时 6s' : e.message);
          } finally { clearTimeout(t); }
        };
        await Promise.all([
          pingUrl('BMCLAPI 镜像', 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'),
          pingUrl('Mojang 官方', 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'),
        ]);

        // 6) Node / 平台
        add('ok', '运行环境', `Node ${process.version} · ${process.platform} ${process.arch}`);

        const bad = checks.filter((c) => c.level === 'bad').length;
        const warn = checks.filter((c) => c.level === 'warn').length;
        json(res, 200, { ok: bad === 0, bad, warn, checks, version: id });
        return;
      }

      if (p === '/api/update/check' && req.method === 'GET') {
        try {
          const r = await checkUpdate();
          json(res, 200, r);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/update/state' && req.method === 'GET') {
        json(res, 200, updateState());
        return;
      }
      if (p === '/api/update/download' && req.method === 'POST') {
        if (!canSelfUpdate()) { json(res, 200, { ok: false, error: '开发模式下不自动更新，请用打包版测试' }); return; }
        const body = await readBody(req);
        const mode = updateMode();
        let asset = body?.asset && body.asset.url ? body.asset : null;
        if (!asset) {
          const chk = await checkUpdate();
          asset = pickAsset(chk.assets, mode);
          if (asset) asset.version = chk.latest;
        }
        if (process.env.TPCL_UPD_ASSET_OVERRIDE) {   // 仅测试：指向本地假 release
          asset = { name: 'TPCL-9.9.9-portable.exe', url: process.env.TPCL_UPD_ASSET_OVERRIDE, version: '9.9.9' };
        }
        if (!asset?.url) { json(res, 200, { ok: false, error: 'release 里没有找到安装包' }); return; }
        asset.version = asset.version || String(body?.version || '');
        json(res, 200, { ok: true, started: true, mode, name: asset.name || '' });
        setTimeout(() => {
          downloadUpdate(asset, (pr) => bus.emit('upd', { type: 'progress', ...pr })).then((r) => {
            bus.emit('upd', { type: 'done', file: r.file, size: r.size, version: asset.version || '' });
          }).catch((e) => {
            bus.emit('upd', { type: 'error', error: e.message });
          });
        }, 50);
        return;
      }
      if (p === '/api/update/apply' && req.method === 'POST') {
        if (!canSelfUpdate()) { json(res, 200, { ok: false, error: '开发模式下不自动更新' }); return; }
        const st = updateState();
        if (!st.downloaded) { json(res, 200, { ok: false, error: '还没下载安装包' }); return; }
        try {
          const r = applyUpdate(st.file, st.mode);
          json(res, 200, { ok: true, ...r, quitting: true });
          setTimeout(() => { try { onQuit ? onQuit() : onRestart?.(); } catch { /* ignore */ } }, 400);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message });
        }
        return;
      }
      if (p === '/api/update/log' && req.method === 'GET') { json(res, 200, applyLog()); return; }
      if (p === '/api/open-url' && req.method === 'POST') {
        const body = await readBody(req);
        const url = String(body?.url || '');
        if (!/^https?:\/\//i.test(url)) { json(res, 400, { error: '只允许打开 http(s) 链接' }); return; }
        try {
          spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          json(res, 200, { ok: true, url });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/paths' && req.method === 'GET') {
        const exeDir = process.env.TPCL_EXE_DIR || path.dirname(process.execPath);
        const mark = path.join(exeDir, 'portable.txt');
        json(res, 200, {
          ok: true,
          dataDir: DATA_DIR,
          secretsFile: path.join(DATA_DIR, 'secrets.json'),
          exeDir,
          portableMark: mark,
          portable: fs.existsSync(mark),
          packaged: !!process.env.TPCL_EXE_DIR,
          gameDir: loadConfig().mcDir,
        });
        return;
      }
      if (p === '/api/changelog' && req.method === 'GET') {
        try {
          const limit = Math.min(20, Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('limit')) || 8));
          const list = await listReleases(limit);
          json(res, 200, { ok: true, list });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: e.message, list: [] });
        }
        return;
      }

      if (p === '/api/net/apply' && req.method === 'POST') {
        const proxy = applyProxyEnv(loadConfig());
        const envOn = process.env.NODE_USE_ENV_PROXY === '1';
        json(res, 200, { ok: true, proxy, envOn, mirror: loadConfig().mirror, base: (await import('./core/mirror.js')).mirrorBase() });
        return;
      }

      if (p === '/api/config/export' && req.method === 'POST') {
        try {
          const r = exportConfig();
          json(res, 200, { ok: true, file: r.file, size: r.size, keys: r.keys });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/config/import' && req.method === 'POST') {
        try {
          const body = await readBody(req);
          const r = importConfig(String(body.file || ''));
          json(res, 200, r);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 400, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/portable' && req.method === 'POST') {
        const b = await readBody(req);
        const exeDir = process.env.TPCL_EXE_DIR || path.dirname(process.execPath);
        const mark = path.join(exeDir, 'portable.txt');
        try {
          if (b && b.on) fs.writeFileSync(mark, 'portable\n', 'utf8');
          else if (fs.existsSync(mark)) fs.unlinkSync(mark);
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { ok: false, error: `改不了 ${mark}：${e.message}` });
          return;
        }
        json(res, 200, { ok: true, portable: !!(b && b.on), needRestart: true, mark });
        return;
      }
      if (p === '/api/restart' && req.method === 'POST') {
        if (!onRestart) { json(res, 200, { ok: false, error: '这个运行方式不支持自动重启' }); return; }
        json(res, 200, { ok: true });
        setTimeout(() => { try { onRestart(); } catch { /* ignore */ } }, 200);
        return;
      }
      if (p === '/api/stats' && req.method === 'GET') {
        const dirSize = async (dir) => {
          let total = 0, files = 0;
          const walk = async (d) => {
            let items = [];
            try { items = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
            for (const it of items) {
              const full = path.join(d, it.name);
              if (it.isDirectory()) await walk(full);
              else { try { const st = await fsp.stat(full); total += st.size; files += 1; } catch { /* skip */ } }
            }
          };
          await walk(dir);
          return { bytes: total, files };
        };
        const cache = await dirSize(path.join(DATA_DIR, 'cache'));
        const logs = await dirSize(path.join(DATA_DIR, 'logs'));
        const backups = await dirSize(path.join(DATA_DIR, 'backups'));
        json(res, 200, {
          appVersion: currentVersion(),
          cache, logs, backups,
          dataDir: DATA_DIR,
          gameDir: loadConfig().mcDir,
          node: process.version,
          uptime: Math.round(process.uptime()),
        });
        return;
      }

      // 清空下载缓存（versions 与 libraries 不动）
      if (p === '/api/cache/clear' && req.method === 'POST') {
        const cacheDir = path.join(DATA_DIR, 'cache');
        let freed = 0, removed = 0;
        const walk = async (d) => {
          let items = [];
          try { items = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
          for (const it of items) {
            const full = path.join(d, it.name);
            if (it.isDirectory()) { await walk(full); await fsp.rm(full, { recursive: true, force: true }).catch(() => {}); }
            else {
              try { const st = await fsp.stat(full); freed += st.size; } catch { /* skip */ }
              await fsp.rm(full, { force: true }).catch(() => {});
              removed += 1;
            }
          }
        };
        await walk(cacheDir);
        json(res, 200, { ok: true, freed, removed });
        return;
      }

      // 清空启动器日志文件
      if (p === '/api/logs/clear' && req.method === 'POST') {
        const logDir = path.join(DATA_DIR, 'logs');
        let removed = 0;
        try {
          for (const f of await fsp.readdir(logDir)) {
            await fsp.rm(path.join(logDir, f), { force: true }).catch(() => {});
            removed += 1;
          }
        } catch { /* 目录不存在 */ }
        json(res, 200, { ok: true, removed });
        return;
      }

      if (p === '/api/content/meta' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        const kind = url.searchParams.get('kind') || 'mods';
        const file = url.searchParams.get('file') || '';
        if (!id || !file) { json(res, 400, { error: '参数不完整' }); return; }
        if (file.includes('..') || file.includes('/') || file.includes('\\')) { json(res, 400, { error: '文件名不合法' }); return; }
        try {
          const dir = contentDir(id, kind);
          const full = path.join(dir, file);
          if (!fs.existsSync(full)) { json(res, 404, { error: '文件不存在' }); return; }
          json(res, 200, await peekMeta(full));
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { file, name: file, error: e.message });
        }
        return;
      }

      if (p === '/api/pack/toggle' && req.method === 'POST') {
        const body = await readBody(req);
        const versionId = String(body.version || cfg.selectedVersion || '');
        const kind = String(body.kind || '');
        const name = String(body.file || '');
        if (!versionId || !name) { json(res, 400, { ok: false, error: '缺少参数' }); return; }
        try {
          const active = await setPackActive(versionId, kind, name, !!body.on);
          json(res, 200, { ok: true, active });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 400, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/mods/check' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        if (!id) { json(res, 400, { error: '缺少 version' }); return; }
        const r = await checkMods(id, gameDirFor(id));
        json(res, 200, r);
        return;
      }
      if (p === '/api/mods/disable' && req.method === 'POST') {
        const b = await readBody(req);
        const id = b.version || loadConfig().selectedVersion;
        if (!id) { json(res, 400, { error: '缺少 version' }); return; }
        const done = await disableModFiles(gameDirFor(id), b.files || []);
        json(res, 200, { ok: true, disabled: done });
        return;
      }
      if (p === '/api/content' && req.method === 'GET') {
        const id = url.searchParams.get('version') || loadConfig().selectedVersion;
        if (!id) { json(res, 400, { error: '缺少 version' }); return; }
        const data = await listContent(id);
        // 同一目录里“同一模组的多份拷贝”是启动崩溃常见原因，顺手标出来
        for (const kind of ['mods', 'resourcepacks', 'shaderpacks', 'datapacks']) {
          const list = data[kind] || [];
          const groups = new Map();
          for (const it of list) {
            const key = modKey(it.name);
            if (!key) continue;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(it);
          }
          for (const [, group] of groups) {
            if (group.length < 2) continue;
            for (const it of group) {
              it.duplicates = group.filter((x) => x !== it).map((x) => x.file);
            }
          }
        }
        json(res, 200, data);
        return;
      }

      // 把选中的本地文件（.jar/.zip/文件夹内文件）导入到当前版本的内容目录
      if (p === '/api/content/import' && req.method === 'POST') {
        const b = await readBody(req);
        const id = b.version || loadConfig().selectedVersion;
        const kind = b.kind;
        const src = b.path;
        const KINDS = ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'datapacks'];
        if (!id || !KINDS.includes(kind) || !src) { json(res, 400, { error: '参数不完整' }); return; }
        if (!fs.existsSync(src)) { json(res, 404, { error: '文件不存在：' + src }); return; }
        const dest = contentDir(id, kind);
        await fsp.mkdir(dest, { recursive: true });
        const name = path.basename(src);
        const out = path.join(dest, name);
        if (fs.existsSync(out) && !b.overwrite) {
          json(res, 409, { error: `已经存在同名文件：${name}`, exists: true, name });
          return;
        }
        await fsp.copyFile(src, out);
        json(res, 200, { ok: true, file: name, dest });
        return;
      }

      if (p === '/api/content/updates' && req.method === 'POST') {
        const b = await readBody(req);
        const id = b.version || loadConfig().selectedVersion;
        if (!id) { json(res, 400, { error: '先选版本' }); return; }
        const kind = ['mods', 'resourcepacks', 'shaderpacks'].includes(b.kind) ? b.kind : 'mods';
        const list = await listContent(id);
        const files = (list[kind] || []).filter((f) => !f.isDir && f.file);
        if (!files.length) { json(res, 200, { checked: 0, updates: [] }); return; }
        const hashes = [];
        const byHash = {};
        for (const f of files) {
          try {
            const h = await sha1File(f.path);
            hashes.push(h);
            byHash[h] = f;
          } catch {}
        }
        let ctx = { mcVer: '', loader: '' };
        try { ctx = versionContext(id) || ctx; } catch {}
        let found = {};
        try {
          found = await checkUpdates(hashes, {
            mcVer: ctx.mcVer || '',
            loader: kind === 'mods' ? (ctx.loader || '') : '',
          });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 200, { checked: hashes.length, updates: [], error: e.message });
          return;
        }
        const updates = Object.entries(found).map(([h, v]) => ({
          file: byHash[h]?.file ?? '',
          name: byHash[h]?.name ?? '',
          current: h,
          projectId: v.projectId,
          versionId: v.versionId,
          latest: v.versionNumber,
          type: v.type,
          date: v.date,
          newFile: v.file?.filename ?? '',
          size: v.file?.size ?? 0,
        }));
        json(res, 200, { checked: hashes.length, updates });
        return;
      }

      if (p === '/api/content/update' && req.method === 'POST') {
        const b = await readBody(req);
        const id = b.version || loadConfig().selectedVersion;
        if (!id || !b.projectId || !b.versionId) { json(res, 400, { error: '参数不完整' }); return; }
        try {
          const installed = await installProjectVersion({
            projectId: b.projectId,
            versionId: b.versionId,
            target: id,
            type: b.kind === 'resourcepacks' ? 'resourcepack' : (b.kind === 'shaderpacks' ? 'shader' : 'mod'),
          });
          // 删掉旧文件（换新后避免同名/重复）
          if (b.oldFile) {
            const dir = contentDir(id, b.kind || 'mods');
            for (const name of [b.oldFile, `${b.oldFile}.disabled`]) {
              const p2 = path.join(dir, name);
              if (fs.existsSync(p2)) await fsp.rm(p2, { force: true }).catch(() => {});
            }
          }
          json(res, 200, { ok: true, installed });
        } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (p === '/api/content/toggle' && req.method === 'POST') {        const b = await readBody(req);
        json(res, 200, await toggleContent(b.version, b.kind, b.file));
        return;
      }

      if (p === '/api/content/delete' && req.method === 'POST') {
        const b = await readBody(req);
        json(res, 200, await deleteContent(b.version, b.kind, b.file));
        return;
      }

      if (p === '/api/open-folder' && req.method === 'POST') {
        const b = await readBody(req);
        // 传了 file 就定位到这个文件（资源管理器会选中它），否则打开目录
        if (b.file) {
          const base = b.path || (b.version && b.kind ? contentDir(b.version, b.kind) : '');
          const full = path.resolve(base, b.file);
          await openFolder(full, { select: true });
          json(res, 200, { ok: true, path: full, select: true });
          return;
        }
        const target = b.path || (b.version && b.kind ? contentDir(b.version, b.kind) : loadConfig().mcDir);
        await fsp.mkdir(target, { recursive: true }).catch(() => {});
        await openFolder(target);
        json(res, 200, { ok: true, path: target });
        return;
      }

      if (p === '/api/shutdown' && req.method === 'POST') {
        json(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 200);
        return;
      }

      if (req.method === 'GET') {
        serveStatic(req, res, p);
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (e) {
          res.tpclReport = writeErrorReport(e, { route: p, method: req.method });
      console.error('[server]', e);
      const report = writeErrorReport(e, { route: p, method: req.method });
      if (!res.headersSent) json(res, 500, { error: e.message, report });
      else res.end();
    }
  });
}
