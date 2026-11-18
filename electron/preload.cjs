const { contextBridge, webUtils, ipcRenderer } = require('electron');

// Electron 32 起 File.path 被移除，拖拽/选择文件只能这样拿真实路径
contextBridge.exposeInMainWorld('tpcl', {
  getPathForFile(file) {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
});

if (process.platform === 'win32') {
  window.addEventListener('DOMContentLoaded', () => {
    const root = document.documentElement;
    root.classList.add('tpcl-desktop-frame');
    const sync = () => ipcRenderer.send('tpcl:titlebar-theme', root.dataset.theme === 'dark');
    new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    sync();
  });
}
