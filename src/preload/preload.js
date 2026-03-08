const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的 API 给渲染进程
contextBridge.exposeInMainWorld('openclaw', {
  create: (options) => ipcRenderer.invoke('browser:create', options),
  close: (id) => ipcRenderer.invoke('browser:close', { id }),
  list: () => ipcRenderer.invoke('browser:list'),
  navigate: (id, url) => ipcRenderer.invoke('browser:navigate', { id, url }),
  getContent: (id) => ipcRenderer.invoke('browser:getContent', { id }),
  getTitle: (id) => ipcRenderer.invoke('browser:getTitle', { id }),
  getUrl: (id) => ipcRenderer.invoke('browser:getUrl', { id }),
  click: (id, selector) => ipcRenderer.invoke('browser:click', { id, selector }),
  fill: (id, selector, text) => ipcRenderer.invoke('browser:fill', { id, selector, text }),
  select: (id, selector, value) => ipcRenderer.invoke('browser:select', { id, selector, value }),
  getText: (id, selector) => ipcRenderer.invoke('browser:getText', { id, selector }),
  getAttribute: (id, selector, attribute) => ipcRenderer.invoke('browser:getAttribute', { id, selector, attribute }),
  evaluate: (id, script) => ipcRenderer.invoke('browser:evaluate', { id, script }),
  screenshot: (id, path) => ipcRenderer.invoke('browser:screenshot', { id, path }),
  scroll: (id, x, y) => ipcRenderer.invoke('browser:scroll', { id, x, y }),
  waitForSelector: (id, selector, timeout) => ipcRenderer.invoke('browser:waitForSelector', { id, selector, timeout }),
  setCookie: (id, cookie) => ipcRenderer.invoke('browser:setCookie', { id, cookie }),
  getCookies: (id, url) => ipcRenderer.invoke('browser:getCookies', { id, url }),
  uploadFile: (id, selector, filePath) => ipcRenderer.invoke('browser:uploadFile', { id, selector, filePath }),
  download: (id, url, filename) => ipcRenderer.invoke('browser:download', { id, url, filename }),
  setProxy: (id, proxy) => ipcRenderer.invoke('browser:setProxy', { id, proxy }),
  getViewport: (id) => ipcRenderer.invoke('browser:getViewport', { id })
});

console.log('OpenClaw Browser preload script loaded');
