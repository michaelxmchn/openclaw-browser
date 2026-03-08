const { app, BrowserWindow, ipcMain, session, dialog, net } = require('electron');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const http = require('http');
const fs = require('fs');

let mainWindow = null;
let apiServer = null;

// 浏览器实例管理
const browserInstances = new Map();

// API 密钥管理
const apiKeys = new Map();

function createWindow(options = {}) {
  const win = new BrowserWindow({
    width: options.width || 1280,
    height: options.height || 800,
    headless: options.headless || false,
    show: !options.headless,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: !options.disableWebSecurity,
      allowRunningInsecureContent: true
    },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security' // 允许跨域
    ]
  });

  // 隐藏 webdriver
  win.webContents.executeJavaScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  `);

  // 设置下载目录
  if (options.downloadPath) {
    win.webContents.session.setDownloadPath(options.downloadPath);
  }

  return win;
}

// ============ IPC 处理函数 ============

function handleBrowserCreate(event, options = {}) {
  const id = uuidv4();
  const win = createWindow(options);
  
  browserInstances.set(id, {
    window: win,
    options,
    created: Date.now()
  });

  console.log(`[Browser] Created instance: ${id}`);
  return { success: true, id };
}

async function handleBrowserNavigate(event, { id, url }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  return new Promise((resolve) => {
    instance.window.webContents.once('did-finish-load', () => {
      resolve({ success: true });
    });
    instance.window.webContents.once('did-fail-load', (event, errorCode, errorDesc) => {
      resolve({ success: false, error: errorDesc });
    });
    instance.window.loadURL(url).catch(err => {
      resolve({ success: false, error: err.message });
    });
  });
}

async function handleBrowserGetContent(event, { id }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    const content = await instance.window.webContents.executeJavaScript(`
      document.documentElement.outerHTML
    `);
    return { success: true, content };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserEvaluate(event, { id, script }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    const result = await instance.window.webContents.executeJavaScript(script);
    return { success: true, result: String(result) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserClick(event, { id, selector }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    await instance.window.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('${selector}');
        if (!el) throw new Error('Element not found');
        el.click();
      })()
    `);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserFill(event, { id, selector, text }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  const safeText = text.replace(/'/g, "\\'");
  try {
    await instance.window.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('${selector}');
        if (!el) throw new Error('Element not found');
        el.value = '${safeText}';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserScreenshot(event, { id, path: savePath }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    // capturePage 可能返回 Promise
    let image;
    const result = instance.window.webContents.capturePage();
    if (result && typeof result.then === 'function') {
      image = await result;
    } else {
      image = result;
    }
    
    if (!image || image.isEmpty()) {
      return { success: false, error: 'Failed to capture page' };
    }
    
    if (savePath) {
      // 保存到文件
      const buffer = image.toPNG();
      fs.writeFileSync(savePath, buffer);
      return { success: true, path: savePath };
    } else {
      // 返回 Base64
      return { success: true, dataUrl: image.toDataURL() };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function handleBrowserGetTitle(event, { id }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    return { success: true, title: instance.window.getTitle() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function handleBrowserGetUrl(event, { id }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    return { success: true, url: instance.window.webContents.getURL() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function handleBrowserClose(event, { id }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    instance.window.close();
    browserInstances.delete(id);
    console.log(`[Browser] Closed instance: ${id}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function handleBrowserList(event) {
  const instances = [];
  for (const [id, data] of browserInstances) {
    try {
      instances.push({
        id,
        title: data.window.getTitle(),
        url: data.window.webContents.getURL(),
        created: data.created
      });
    } catch (e) {
      instances.push({ id, title: 'Unknown', url: '', created: data.created });
    }
  }
  return instances;
}

async function handleBrowserScroll(event, { id, x, y }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    await instance.window.webContents.executeJavaScript(`window.scrollTo(${x}, ${y})`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserWaitForSelector(event, { id, selector, timeout = 30000 }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    await instance.window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        if (document.querySelector('${selector}')) {
          resolve(true);
          return;
        }
        const observer = new MutationObserver(() => {
          if (document.querySelector('${selector}')) {
            observer.disconnect();
            resolve(true);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          reject(new Error('Timeout'));
        }, ${timeout});
      })
    `);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserGetText(event, { id, selector }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    const text = await instance.window.webContents.executeJavaScript(`
      document.querySelector('${selector}')?.innerText || ''
    `);
    return { success: true, text };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserGetAttribute(event, { id, selector, attribute }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    const value = await instance.window.webContents.executeJavaScript(`
      document.querySelector('${selector}')?.getAttribute('${attribute}') || null
    `);
    return { success: true, value };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserSetCookie(event, { id, cookie }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    await instance.window.webContents.session.cookies.set(cookie);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserGetCookies(event, { id, url }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    const targetUrl = url || instance.window.webContents.getURL();
    const cookies = await instance.window.webContents.session.cookies.get({ url: targetUrl });
    return { success: true, cookies };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// 文件上传
async function handleBrowserUploadFile(event, { id, selector, filePath }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    // 设置文件到输入框
    const files = filePath.split(',').map(f => f.trim());
    await instance.window.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('${selector}');
        if (!el) throw new Error('Element not found');
        
        // 创建 DataTransfer
        const dt = new DataTransfer();
        ${files.map(f => `dt.items.add(new File([], '${path.basename(f)}'));`).join('\n')}
        el.files = dt.files;
        
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// 下载文件
async function handleBrowserDownload(event, { id, url, filename }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    const downloadPath = instance.options.downloadPath || app.getPath('downloads');
    const filePath = path.join(downloadPath, filename || 'download');
    
    await instance.window.webContents.downloadURL(url);
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// 设置代理
async function handleBrowserSetProxy(event, { id, proxy }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    await instance.window.webContents.session.setProxy(proxy);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// 获取页面截图（可见区域）
async function handleBrowserGetViewport(event, { id }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    const viewport = await instance.window.webContents.executeJavaScript(`
      JSON.stringify({
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio
      })
    `);
    return { success: true, viewport: JSON.parse(viewport) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// 选择下拉框
async function handleBrowserSelect(event, { id, selector, value }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    await instance.window.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('${selector}');
        if (!el) throw new Error('Element not found');
        el.value = '${value}';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============ API 服务器 ============

function startApiServer() {
  const expressApp = express();
  expressApp.use(express.json({ limit: '50mb' }));

  // API 密钥验证
  expressApp.use((req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (req.path === '/health' || req.path === '/') {
      return next();
    }
    if (!apiKey || (apiKey !== 'test' && !apiKey.startsWith('oc_') && !apiKeys.has(apiKey))) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }
    next();
  });

  // 健康检查
  expressApp.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now(), instances: browserInstances.size });
  });

  // API 信息
  expressApp.get('/', (req, res) => {
    res.json({ 
      name: 'OpenClaw Browser API', 
      version: '1.0.0',
      endpoints: [
        'POST /api/browser/create', 'GET /api/browser/list',
        'POST /api/browser/:id/navigate', 'GET /api/browser/:id/content',
        'GET /api/browser/:id/title', 'GET /api/browser/:id/url',
        'POST /api/browser/:id/click', 'POST /api/browser/:id/fill',
        'POST /api/browser/:id/evaluate', 'GET /api/browser/:id/screenshot',
        'POST /api/browser/:id/scroll', 'POST /api/browser/:id/wait',
        'GET /api/browser/:id/text/:selector', 'GET /api/browser/:id/attr/:selector/:attr',
        'POST /api/browser/:id/cookie', 'GET /api/browser/:id/cookies',
        'POST /api/browser/:id/upload', 'POST /api/browser/:id/download',
        'POST /api/browser/:id/proxy', 'POST /api/browser/:id/select',
        'DELETE /api/browser/:id'
      ]
    });
  });

  // 创建 API Key
  expressApp.post('/api/keys', (req, res) => {
    const { name, permissions } = req.body;
    const key = 'oc_' + uuidv4().replace(/-/g, '');
    apiKeys.set(key, { name, permissions: permissions || ['*'], created: Date.now() });
    res.json({ success: true, apiKey: key });
  });

  // 列出 API Keys
  expressApp.get('/api/keys', (req, res) => {
    const keys = [];
    for (const [key, data] of apiKeys) {
      keys.push({ name: data.name, permissions: data.permissions, created: data.created });
    }
    res.json({ keys });
  });

  // 创建浏览器实例
  expressApp.post('/api/browser/create', (req, res) => {
    const { headless, width, height, downloadPath, proxy } = req.body;
    const result = handleBrowserCreate(null, { headless, width, height, downloadPath, proxy });
    res.json(result);
  });

  // 列出浏览器实例
  expressApp.get('/api/browser/list', (req, res) => {
    const instances = handleBrowserList();
    res.json({ success: true, instances });
  });

  // 导航
  expressApp.post('/api/browser/:id/navigate', async (req, res) => {
    const { id } = req.params;
    const { url } = req.body;
    const result = await handleBrowserNavigate(null, { id, url });
    res.json(result);
  });

  // 获取页面内容
  expressApp.get('/api/browser/:id/content', async (req, res) => {
    const { id } = req.params;
    const result = await handleBrowserGetContent(null, { id });
    res.json(result);
  });

  // 获取标题
  expressApp.get('/api/browser/:id/title', (req, res) => {
    const { id } = req.params;
    const result = handleBrowserGetTitle(null, { id });
    res.json(result);
  });

  // 获取 URL
  expressApp.get('/api/browser/:id/url', (req, res) => {
    const { id } = req.params;
    const result = handleBrowserGetUrl(null, { id });
    res.json(result);
  });

  // 点击
  expressApp.post('/api/browser/:id/click', async (req, res) => {
    const { id } = req.params;
    const { selector } = req.body;
    const result = await handleBrowserClick(null, { id, selector });
    res.json(result);
  });

  // 填写
  expressApp.post('/api/browser/:id/fill', async (req, res) => {
    const { id } = req.params;
    const { selector, text } = req.body;
    const result = await handleBrowserFill(null, { id, selector, text });
    res.json(result);
  });

  // 选择下拉框
  expressApp.post('/api/browser/:id/select', async (req, res) => {
    const { id } = req.params;
    const { selector, value } = req.body;
    const result = await handleBrowserSelect(null, { id, selector, value });
    res.json(result);
  });

  // 执行 JavaScript
  expressApp.post('/api/browser/:id/evaluate', async (req, res) => {
    const { id } = req.params;
    const { script } = req.body;
    const result = await handleBrowserEvaluate(null, { id, script });
    res.json(result);
  });

  // 截图
  expressApp.get('/api/browser/:id/screenshot', async (req, res) => {
    const { id } = req.params;
    const { path: savePath } = req.query;
    const result = await handleBrowserScreenshot(null, { id, path: savePath });
    res.json(result);
  });

  // 滚动
  expressApp.post('/api/browser/:id/scroll', async (req, res) => {
    const { id } = req.params;
    const { x = 0, y = 0 } = req.body;
    const result = await handleBrowserScroll(null, { id, x, y });
    res.json(result);
  });

  // 等待元素
  expressApp.post('/api/browser/:id/wait', async (req, res) => {
    const { id } = req.params;
    const { selector, timeout = 30000 } = req.body;
    const result = await handleBrowserWaitForSelector(null, { id, selector, timeout });
    res.json(result);
  });

  // 获取文本
  expressApp.get('/api/browser/:id/text/:selector(*)', async (req, res) => {
    const { id, selector } = req.params;
    const result = await handleBrowserGetText(null, { id, selector });
    res.json(result);
  });

  // 获取属性
  expressApp.get('/api/browser/:id/attr/:selector(*)/:attr', async (req, res) => {
    const { id, selector, attr } = req.params;
    const result = await handleBrowserGetAttribute(null, { id, selector, attr });
    res.json(result);
  });

  // 设置 Cookie
  expressApp.post('/api/browser/:id/cookie', async (req, res) => {
    const { id } = req.params;
    const cookie = req.body;
    const result = await handleBrowserSetCookie(null, { id, cookie });
    res.json(result);
  });

  // 获取 Cookies
  expressApp.get('/api/browser/:id/cookies', (req, res) => {
    const { id } = req.params;
    const { url } = req.query;
    handleBrowserGetCookies(null, { id, url }).then(result => res.json(result));
  });

  // 上传文件
  expressApp.post('/api/browser/:id/upload', async (req, res) => {
    const { id } = req.params;
    const { selector, filePath } = req.body;
    const result = await handleBrowserUploadFile(null, { id, selector, filePath });
    res.json(result);
  });

  // 下载文件
  expressApp.post('/api/browser/:id/download', async (req, res) => {
    const { id } = req.params;
    const { url, filename } = req.body;
    const result = await handleBrowserDownload(null, { id, url, filename });
    res.json(result);
  });

  // 设置代理
  expressApp.post('/api/browser/:id/proxy', async (req, res) => {
    const { id } = req.params;
    const { proxy } = req.body;
    const result = await handleBrowserSetProxy(null, { id, proxy });
    res.json(result);
  });

  // 获取视口信息
  expressApp.get('/api/browser/:id/viewport', async (req, res) => {
    const { id } = req.params;
    const result = await handleBrowserGetViewport(null, { id });
    res.json(result);
  });

  // 关闭实例
  expressApp.delete('/api/browser/:id', (req, res) => {
    const { id } = req.params;
    const result = handleBrowserClose(null, { id });
    res.json(result);
  });

  const server = http.createServer(expressApp);
  server.listen(3847, () => {
    console.log('API Server started on port 3847');
  });

  return server;
}

// ============ 应用启动 ============

app.whenReady().then(() => {
  console.log('OpenClaw Browser starting...');
  
  // 注册 IPC 处理器
  ipcMain.handle('browser:create', handleBrowserCreate);
  ipcMain.handle('browser:navigate', handleBrowserNavigate);
  ipcMain.handle('browser:getContent', handleBrowserGetContent);
  ipcMain.handle('browser:evaluate', handleBrowserEvaluate);
  ipcMain.handle('browser:click', handleBrowserClick);
  ipcMain.handle('browser:fill', handleBrowserFill);
  ipcMain.handle('browser:screenshot', handleBrowserScreenshot);
  ipcMain.handle('browser:getTitle', handleBrowserGetTitle);
  ipcMain.handle('browser:getUrl', handleBrowserGetUrl);
  ipcMain.handle('browser:close', handleBrowserClose);
  ipcMain.handle('browser:list', handleBrowserList);
  ipcMain.handle('browser:scroll', handleBrowserScroll);
  ipcMain.handle('browser:waitForSelector', handleBrowserWaitForSelector);
  ipcMain.handle('browser:getText', handleBrowserGetText);
  ipcMain.handle('browser:getAttribute', handleBrowserGetAttribute);
  ipcMain.handle('browser:setCookie', handleBrowserSetCookie);
  ipcMain.handle('browser:getCookies', handleBrowserGetCookies);
  ipcMain.handle('browser:uploadFile', handleBrowserUploadFile);
  ipcMain.handle('browser:download', handleBrowserDownload);
  ipcMain.handle('browser:setProxy', handleBrowserSetProxy);
  ipcMain.handle('browser:getViewport', handleBrowserGetViewport);
  ipcMain.handle('browser:select', handleBrowserSelect);

  // 启动 API 服务器
  apiServer = startApiServer();
  
  console.log('OpenClaw Browser ready');
});

app.on('window-all-closed', () => {
  // 不退出，因为 API 服务器还在运行
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});
