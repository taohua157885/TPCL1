import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from './server.js';
import { loadConfig, ROOT } from './core/config.js';

const PORT = Number(process.env.TPCL_PORT || 26543);
const DEV = process.argv.includes('--dev');

function findBrowser() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function openWindow(url) {
  const browser = findBrowser();
  if (browser) {
    const args = [
      `--app=${url}`,
      '--window-size=1240,780',
      '--window-position=80,40',
      '--disable-features=Translate,PrivacySandboxSettings4',
      '--user-data-dir=' + path.join(ROOT, 'data', 'profile'),
    ];
    const child = spawn(browser, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return;
  }
  // 回退：默认浏览器
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

const server = createServer();

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`[TPCL] 端口 ${PORT} 已被占用，直接尝试打开已有窗口：${url}`);
    openWindow(url);
    setTimeout(() => process.exit(0), 1200);
  } else {
    console.error('[TPCL] 启动失败：', e);
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const cfg = loadConfig();
  const url = `http://127.0.0.1:${PORT}`;
  console.log('');
  console.log('  ███  TPCL  ███  个人 Minecraft 启动器');
  console.log('  ----------------------------------------');
  console.log(`  地址      ${url}`);
  console.log(`  游戏目录  ${cfg.mcDir}`);
  console.log(`  数据目录  ${path.join(ROOT, 'data')}`);
  console.log('  ----------------------------------------');
  console.log('  关闭此窗口即退出启动器');
  console.log('');
  if (!DEV) openWindow(url);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});
