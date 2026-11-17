const { contextBridge, webUtils } = require('electron');

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
