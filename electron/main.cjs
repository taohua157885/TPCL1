// Electron 主进程：内嵌 HTTP 服务 + 原生窗口 + 托盘 + 单实例
// 注意：项目是 type:module，所以主进程用 .cjs 后缀
const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

// 受限环境（例如被父进程 Job 对象限制）里 Chromium 无法派生 helper 进程，
// 多进程会在 ready 之前以 STATUS_BREAKPOINT 退出。设 TPCL_SINGLE=1 可退回单进程模式。
if (process.env.TPCL_SINGLE === '1') {
  app.commandLine.appendSwitch('single-process');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  app.disableHardwareAcceleration();
}
const DBG_LOG = process.env.TPCL_DEBUG_LOG;
function dbg(m) { if (DBG_LOG) { try { fs.appendFileSync(DBG_LOG, m + '\n'); } catch {} } }
dbg('module loaded, single=' + process.env.TPCL_SINGLE);
const PORT = Number(process.env.TPCL_PORT || 26543);
const URL = `http://127.0.0.1:${PORT}`;

// 打包后源码在只读的 asar 里，配置/缓存/日志要落到用户目录
if (app.isPackaged) {
  process.env.TPCL_EXE_DIR = path.dirname(app.getPath('exe'));
  const portableMark = path.join(process.env.TPCL_EXE_DIR, 'portable.txt');
  // 便携模式：exe 旁边放一个 portable.txt，数据就落在 exe 同级 data 目录
  if (fs.existsSync(portableMark)) {
    process.env.TPCL_DATA_DIR = path.join(process.env.TPCL_EXE_DIR, 'data');
    dbg('portable data dir: ' + process.env.TPCL_DATA_DIR);
  } else {
    process.env.TPCL_DATA_DIR = path.join(app.getPath('userData'), 'data');
  }
  // 便携 / 开发目录里已经下好的 Java 也纳入扫描，省一次二百兆下载
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    const cands = [
      path.join(exeDir, '..', '..', 'data', 'java'),
      path.join(exeDir, '..', '..', '..', 'data', 'java'),
      path.join(exeDir, 'data', 'java'),
    ];
    for (const c of cands) {
      if (fs.existsSync(c) && fs.readdirSync(c).length) { process.env.TPCL_EXTRA_JAVA = c; break; }
    }
  } catch {}
}
const DATA_DIR = process.env.TPCL_DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'window.json');

/* ---------- 首次启动：把便携/开发目录里的旧配置与密钥搬过来 ---------- */
function migrateLegacyData() {
  try {
    if (process.env.TPCL_DATA_DIR && fs.existsSync(path.join(process.env.TPCL_EXE_DIR || '', 'portable.txt'))) return;
    const CONFIG = path.join(DATA_DIR, 'config.json');
    if (fs.existsSync(CONFIG)) return;
    const exeDir = path.dirname(app.getPath('exe'));
    const home = app.getPath('home');
    const cands = [
      path.join(exeDir, '..', '..', 'data'),
      path.join(exeDir, '..', '..', '..', 'data'),
      path.join(exeDir, 'data'),
      path.join(home, 'Desktop', 'tpcl', 'data'),
    ];
    for (const dir of cands) {
      const cfg = path.join(dir, 'config.json');
      if (!fs.existsSync(cfg)) continue;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      for (const name of ['config.json', 'secrets.json', 'window.json']) {
        const src = path.join(dir, name);
        const dst = path.join(DATA_DIR, name);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          try { fs.copyFileSync(src, dst); } catch { /* 单个文件失败不影响其它 */ }
        }
      }
      dbg('migrated legacy data from ' + dir);
      return;
    }
  } catch (e) {
    dbg('migrate failed: ' + (e && e.message));
  }
}
migrateLegacyData();

let win = null;
let tray = null;
let hasTray = false;
let server = null;
let quitting = false;

/* ---------- 单实例：第二次启动就把已有窗口叫出来 ---------- */
const gotLock = app.requestSingleInstanceLock();
dbg('lock=' + gotLock);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch {}
  return { width: 1280, height: 860 };
}

function saveWindowState() {
  if (!win) return;
  try {
    const b = win.getNormalBounds();
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...b, maximized: win.isMaximized() }, null, 2));
  } catch {}
}

function iconPath() {
  const p = path.join(ROOT, 'build', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

async function startServer() {
  dbg('startServer begin');
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'server.js')).href);
  dbg('server module loaded');
  server = mod.createServer({
    onRestart: () => {
      try { quitting = true; app.relaunch(); app.exit(0); } catch (e) { dbg('restart failed: ' + e.message); }
    },
    // 自更新：批处理已经起好，这里只负责干净退出，别再 relaunch
    onQuit: () => {
      try { quitting = true; app.exit(0); } catch (e) { dbg('quit failed: ' + e.message); }
    },
  });
  await new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') resolve('in-use');
      else reject(e);
    });
    server.listen(PORT, '127.0.0.1', () => resolve('ok'));
  });
}

function titleBarColors(dark) {
  return dark ? { color: '#191b1e', symbolColor: '#f0f1f3' }
    : { color: '#ffffff', symbolColor: '#202226' };
}

ipcMain.on('tpcl:titlebar-theme', (event, dark) => {
  if (process.platform === 'win32' && win && event.sender === win.webContents && typeof dark === 'boolean') {
    win.setTitleBarOverlay(titleBarColors(dark));
  }
});

function createWindow() {
  dbg('createWindow begin');
  const st = loadWindowState();
  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#080b11',
    title: 'TPCL · 我的 Minecraft 启动器',
    icon: iconPath(),
    autoHideMenuBar: true,
    ...(process.platform === 'win32' && {
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...titleBarColors(false), height: 53 },
    }),
    webPreferences: {
      preload: require('path').join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  dbg('window constructed id=' + win.id);
  win.setMenuBarVisibility(false);
  win.loadURL(URL);
  if (st.maximized) win.maximize();

  win.once('ready-to-show', () => win.show());

  // 外部链接交给系统浏览器，别在应用里开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // F5 刷新 / F12 开发者工具
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5') { win.webContents.reload(); e.preventDefault(); }
    if (input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });

  win.on('close', (e) => {
    saveWindowState();
    if (!quitting && hasTray) {
      // 点 × 收进托盘，不真退出（和 PCL2 习惯一致）
      e.preventDefault();
      win.hide();
    }
  });

  // 移动 / 缩放 / 最大化时也记录（被强杀时 close 不会触发，只靠 close 可能永远写不出 window.json）
  let saveTimer = null;
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 400);
  };
  win.on('resize', queueSave);
  win.on('move', queueSave);
  win.on('maximize', queueSave);
  win.on('unmaximize', queueSave);
}

function createTray() {
  if (process.env.TPCL_NO_TRAY === '1') return false;
  try {
    const img = iconPath();
    tray = new Tray(img ? nativeImage.createFromPath(img).resize({ width: 16, height: 16 }) : nativeImage.createEmpty());
    tray.setToolTip('TPCL · 我的 Minecraft 启动器');
    const menu = Menu.buildFromTemplate([
      { label: '打开启动器', click: () => { if (win) { win.show(); win.focus(); } } },
      { type: 'separator' },
      { label: '打开游戏目录', click: () => { shell.openPath(path.join(process.env.APPDATA || '', '.minecraft')); } },
      { label: '打开数据目录', click: () => { shell.openPath(path.join(ROOT, 'data')); } },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
    return true;
  } catch (e) {
    // 某些受限环境（单进程模式）创建托盘会让 Chromium 直接崩，降级为无托盘
    dbg('tray failed: ' + e.message);
    tray = null;
    return false;
  }
}

app.whenReady().then(async () => {
  try {
    const r = await startServer();
    if (r === 'in-use') {
      // 端口被占：说明已有一个实例在跑（比如从 vbs 启动的），直接用
    }
  } catch (e) {
    dialog.showErrorBox('TPCL 启动失败', String(e && e.stack ? e.stack : e));
    app.exit(1);
    return;
  }
  createWindow();
  hasTray = createTray();
  dbg('hasTray=' + hasTray);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else win.show();
  });
});

app.on('window-all-closed', () => {
  // 有托盘，不随窗口关闭退出
});

app.on('before-quit', () => {
  quitting = true;
  saveWindowState();
  try { if (server) server.close(); } catch {}
});
