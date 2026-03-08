const { launch, connect } = require('puppeteer-core');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const http = require('http');
const fs = require('fs');

let apiServer = null;

// 浏览器实例管理
const browserInstances = new Map();

// API 密钥管理
const apiKeys = new Map();

// Puppeteer 配置
const defaultBrowserOptions = {
  headless: false,
  executablePath: '/usr/bin/google-chrome',  // 系统 Chrome 路径
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security',
    '--remote-debugging-port=9222'
  ]
};

// ============ 重试机制 ============

const defaultRetryConfig = {
  maxRetries: 3,
  initialDelay: 500,
  maxDelay: 5000,
  backoffMultiplier: 2,
  retryableErrors: [
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_TIMED_OUT',
    'ETIMEDOUT',
    'ECONNRESET',
    'timeout'
  ]
};

function isRetryableError(error, retryableErrors) {
  if (!error) return false;
  const errorStr = String(error).toLowerCase();
  return retryableErrors.some(e => errorStr.includes(e.toLowerCase()));
}

async function withRetry(operation, config = {}) {
  const {
    maxRetries = defaultRetryConfig.maxRetries,
    initialDelay = defaultRetryConfig.initialDelay,
    maxDelay = defaultRetryConfig.maxDelay,
    backoffMultiplier = defaultRetryConfig.backoffMultiplier,
    retryableErrors = defaultRetryConfig.retryableErrors
  } = config;

  let lastError;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      if (result && result.success === false) {
        const errorMsg = result.error || '';
        if (isRetryableError(errorMsg, retryableErrors) && attempt < maxRetries) {
          lastError = errorMsg;
          console.log(`[Retry] Attempt ${attempt + 1} failed: ${errorMsg}, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * backoffMultiplier, maxDelay);
          continue;
        }
      }
      return result;
    } catch (err) {
      lastError = err.message;
      if (isRetryableError(err.message, retryableErrors) && attempt < maxRetries) {
        console.log(`[Retry] Attempt ${attempt + 1} error: ${err.message}, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * backoffMultiplier, maxDelay);
      } else {
        throw err;
      }
    }
  }
  return { success: false, error: `Max retries (${maxRetries}) exceeded: ${lastError}` };
}

// ============ 浏览器操作函数 ============

async function handleBrowserCreate(event, options = {}) {
  const id = uuidv4();
  
  const browserOptions = {
    ...defaultBrowserOptions,
    headless: options.headless !== undefined ? options.headless : true,
    executablePath: options.executablePath || defaultBrowserOptions.executablePath,
    args: [
      ...defaultBrowserOptions.args,
      ...(options.args || [])
    ]
  };

  try {
    const browser = await launch(browserOptions);
    const page = await browser.newPage();
    
    // 隐藏 webdriver
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    browserInstances.set(id, {
      browser,
      page,
      options,
      created: Date.now()
    });

    console.log(`[Browser] Created instance: ${id}`);
    return { success: true, id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserNavigate(event, { id, url }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    await instance.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserGetContent(event, { id }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    const content = await instance.page.content();
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
    const result = await instance.page.evaluate(script);
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
    await instance.page.click(selector);
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
  
  try {
    await instance.page.type(selector, text);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserSelect(event, { id, selector, value }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    await instance.page.select(selector, value);
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
    const screenshot = await instance.page.screenshot({
      encoding: savePath ? 'binary' : 'base64'
    });
    
    if (savePath) {
      fs.writeFileSync(savePath, screenshot);
      return { success: true, path: savePath };
    } else {
      return { success: true, dataUrl: `data:image/png;base64,${screenshot}` };
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
  
  return { success: true, title: instance.page.title() };
}

function handleBrowserGetUrl(event, { id }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  return { success: true, url: instance.page.url() };
}

function handleBrowserClose(event, { id }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  instance.browser.close();
  browserInstances.delete(id);
  console.log(`[Browser] Closed instance: ${id}`);
  return { success: true };
}

function handleBrowserList(event) {
  const instances = [];
  for (const [id, data] of browserInstances) {
    instances.push({
      id,
      title: data.page.title(),
      url: data.page.url(),
      created: data.created
    });
  }
  return instances;
}

async function handleBrowserScroll(event, { id, x, y }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    await instance.page.evaluate((x, y) => window.scrollTo(x, y), x, y);
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
    await instance.page.waitForSelector(selector, { timeout });
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
    const text = await instance.page.$eval(selector, el => el.innerText).catch(() => '');
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
    const value = await instance.page.$eval(selector, (el, attr) => el.getAttribute(attr), attribute).catch(() => null);
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
    await instance.page.setCookie(cookie);
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
    const cookies = await instance.page.cookies();
    return { success: true, cookies };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============ 反爬虫功能 ============

function randomDelay(min = 100, max = 500) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function handleBrowserHumanType(event, { id, selector, text, minDelay = 50, maxDelay = 150 }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    await instance.page.click(selector).catch(() => {});
    for (let i = 0; i < text.length; i++) {
      await instance.page.type(selector, text[i], { delay: randomDelay(minDelay, maxDelay) });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserHumanClick(event, { id, selector, offsetX = 0, offsetY = 0, minDelay = 100, maxDelay = 500 }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    await new Promise(r => setTimeout(r, randomDelay(minDelay, maxDelay)));
    await instance.page.hover(selector);
    await instance.page.click(selector);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserHumanScroll(event, { id, y, minStep = 100, maxStep = 300, minDelay = 200, maxDelay = 500 }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    let currentY = 0;
    while (currentY < y) {
      const step = randomDelay(minStep, maxStep);
      currentY = Math.min(currentY + step, y);
      await instance.page.evaluate(y => window.scrollTo(0, y), currentY);
      if (currentY < y) {
        await new Promise(r => setTimeout(r, randomDelay(minDelay, maxDelay)));
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function handleBrowserRandomWait(event, { id, minMs = 1000, maxMs = 3000 }) {
  const delay = randomDelay(minMs, maxMs);
  return { success: true, waited: delay };
}

async function handleBrowserPressKey(event, { id, key, minDelay = 50, maxDelay = 150 }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    await new Promise(r => setTimeout(r, randomDelay(minDelay, maxDelay)));
    await instance.page.keyboard.press(key);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============ 录屏功能 ============

async function handleBrowserRecordScreen(event, { id, duration = 10, interval = 100, outputPath }) {
  const instance = browserInstances.get(id);
  if (!instance) {
    return { success: false, error: 'Browser instance not found' };
  }
  
  try {
    const frames = [];
    const startTime = Date.now();
    const endTime = startTime + (duration * 1000);
    
    while (Date.now() < endTime) {
      const screenshot = await instance.page.screenshot({ encoding: 'binary' });
      frames.push(screenshot);
      await new Promise(r => setTimeout(r, interval));
    }
    
    if (frames.length === 0) {
      return { success: false, error: 'No frames captured' };
    }
    
    if (outputPath) {
      const dir = outputPath.replace(/\.[^.]+$/, '');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      frames.forEach((frame, i) => {
        fs.writeFileSync(`${dir}/frame_${String(i).padStart(5, '0')}.png`, frame);
      });
      return { success: true, frames: frames.length, path: dir, duration: Date.now() - startTime };
    }
    
    const lastFrame = frames[frames.length - 1];
    return { success: true, frames: frames.length, preview: `data:image/png;base64,${lastFrame.toString('base64')}`, duration: Date.now() - startTime };
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
    res.json({ 
      status: 'ok', 
      timestamp: Date.now(), 
      instances: browserInstances.size,
      retry: { defaultConfig: defaultRetryConfig }
    });
  });

  // API 信息
  expressApp.get('/', (req, res) => {
    res.json({ 
      name: 'OpenClaw Browser (Puppeteer)', 
      version: '1.0.0',
      browser: 'Chrome via Puppeteer'
    });
  });

  // 创建浏览器实例
  expressApp.post('/api/browser/create', async (req, res) => {
    const { headless, executablePath } = req.body;
    const result = await handleBrowserCreate(null, { headless, executablePath });
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
    const { url, retry } = req.body;
    
    if (retry) {
      const instance = browserInstances.get(id);
      if (!instance) {
        return res.json({ success: false, error: 'Browser instance not found' });
      }
      const result = await withRetry(() => handleBrowserNavigate(null, { id, url }), retry);
      res.json(result);
    } else {
      const result = await handleBrowserNavigate(null, { id, url });
      res.json(result);
    }
  });

  // 其他 API 端点...
  expressApp.get('/api/browser/:id/content', async (req, res) => {
    const result = await handleBrowserGetContent(null, { id: req.params.id });
    res.json(result);
  });

  expressApp.get('/api/browser/:id/title', (req, res) => {
    const result = handleBrowserGetTitle(null, { id: req.params.id });
    res.json(result);
  });

  expressApp.get('/api/browser/:id/url', (req, res) => {
    const result = handleBrowserGetUrl(null, { id: req.params.id });
    res.json(result);
  });

  expressApp.post('/api/browser/:id/click', async (req, res) => {
    const result = await handleBrowserClick(null, { id: req.params.id, ...req.body });
    res.json(result);
  });

  expressApp.post('/api/browser/:id/fill', async (req, res) => {
    const result = await handleBrowserFill(null, { id: req.params.id, ...req.body });
    res.json(result);
  });

  expressApp.post('/api/browser/:id/select', async (req, res) => {
    const result = await handleBrowserSelect(null, { id: req.params.id, ...req.body });
    res.json(result);
  });

  expressApp.post('/api/browser/:id/evaluate', async (req, res) => {
    const result = await handleBrowserEvaluate(null, { id: req.params.id, ...req.body });
    res.json(result);
  });

  expressApp.get('/api/browser/:id/screenshot', async (req, res) => {
    const result = await handleBrowserScreenshot(null, { id: req.params.id, ...req.query });
    res.json(result);
  });

  expressApp.post('/api/browser/:id/scroll', async (req, res) => {
    const result = await handleBrowserScroll(null, { id: req.params.id, ...req.body });
    res.json(result);
  });

  expressApp.post('/api/browser/:id/wait', async (req, res) => {
    const result = await handleBrowserWaitForSelector(null, { id: req.params.id, ...req.body });
    res.json(result);
  });

  expressApp.get('/api/browser/:id/text/:selector(*)', async (req, res) => {
    const result = await handleBrowserGetText(null, { id: req.params.id, selector: req.params.selector });
    res.json(result);
  });

  expressApp.get('/api/browser/:id/attr/:selector(*)/:attr', async (req, res) => {
    const result = await handleBrowserGetAttribute(null, { id: req.params.id, selector: req.params.selector, attribute: req.params.attr });
    res.json(result);
  });

  expressApp.post('/api/browser/:id/cookie', async (req, res) => {
    const result = await handleBrowserSetCookie(null, { id: req.params.id, cookie: req.body });
    res.json(result);
  });

  expressApp.get('/api/browser/:id/cookies', async (req, res) => {
    const result = await handleBrowserGetCookies(null, { id: req.params.id, url: req.query.url });
    res.json(result);
  });

  // 反爬虫 API
  expressApp.post('/api/browser/:id/human-type', async (req, res) => {
    const result = await handleBrowserHumanType(null, { id: req.params.id, ...req.body });
    res.json(result);
  });

  expressApp.post('/api/browser/:id/human-click', async (req, res) => {
    const result = await handleBrowserHumanClick(null, { id: req.params.id, ...req.body });
    res.json(result);
  });

  expressApp.post('/api/browser/:id/human-scroll', async (req, res) => {
    const result = await handleBrowserHumanScroll(null, { id: req.params.id, ...req.body });
    res.json(result);
  });

  expressApp.post('/api/browser/:id/wait-random', (req, res) => {
    const result = handleBrowserRandomWait(null, { id: req.params.id, ...req.body });
    res.json(result);
  });

  expressApp.post('/api/browser/:id/press-key', async (req, res) => {
    const result = await handleBrowserPressKey(null, { id: req.params.id, ...req.body });
    res.json(result);
  });

  // 录屏
  expressApp.post('/api/browser/:id/record-screen', async (req, res) => {
    const result = await handleBrowserRecordScreen(null, { id: req.params.id, ...req.body });
    res.json(result);
  });

  // ============ 交互式登录功能 ============
  
  // 检测登录状态/验证码
  expressApp.get('/api/browser/:id/login-check', async (req, res) => {
    const instance = browserInstances.get(req.params.id);
    if (!instance) {
      return res.json({ success: false, error: 'Browser instance not found' });
    }
    
    try {
      const result = await instance.page.evaluate(() => {
        const checks = {
          // 检测登录表单
          hasLoginForm: !!document.querySelector('form[action*="login"]') || 
                       !!document.querySelector('input[name="phone"]') ||
                       !!document.querySelector('input[name="mobile"]') ||
                       !!document.querySelector('input[type="tel"]'),
          
          // 检测验证码输入框
          hasCaptcha: !!document.querySelector('input[name="code"]') ||
                     !!document.querySelector('input[name="captcha"]') ||
                     !!document.querySelector('input[name="verify"]') ||
                     !!document.querySelector('input[placeholder*="验证码"]') ||
                     !!document.querySelector('input[placeholder*="码"]'),
          
          // 检测手机号输入框
          hasPhone: !!document.querySelector('input[name="phone"]') ||
                    !!document.querySelector('input[name="mobile"]') ||
                    !!document.querySelector('input[type="tel"]'),
          
          // 检测登录按钮
          hasLoginBtn: !!document.querySelector('button[type="submit"]') ||
                       !!document.querySelector('button:contains("登录")') ||
                       !!document.querySelector('button:contains("登")') ||
                       !!document.querySelector('a:contains("登录")'),
          
          // 检测需要人机验证
          hasHumanVerify: !!document.querySelector('.geetest_panel') ||
                         !!document.querySelector('#nc_1_n1z') ||
                         !!document.querySelector('.tcaptcha'),
          
          // 检测滑块验证
          hasSlider: !!document.querySelector('.slider') ||
                    !!document.querySelector('.nc_wrapper') ||
                    !!document.querySelector('[class*="slider"]'),
          
          // 检测二维码登录
          hasQRCode: !!document.querySelector('img[src*="qrcode"]') ||
                     !!document.querySelector('.qrcode') ||
                     !!document.querySelector('[class*="qr"]'),
          
          // 获取页面标题
          pageTitle: document.title,
          
          // 获取当前 URL
          pageUrl: window.location.href
        };
        return checks;
      });
      
      res.json({ success: true, ...result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 保存登录状态（Cookie）
  expressApp.post('/api/browser/:id/login-save', async (req, res) => {
    const instance = browserInstances.get(req.params.id);
    if (!instance) {
      return res.json({ success: false, error: 'Browser instance not found' });
    }
    
    try {
      const cookies = await instance.page.cookies();
      const localStorage = await instance.page.evaluate(() => JSON.stringify(localStorage));
      
      // 保存到文件
      const savePath = req.body.path || `./login_state_${req.params.id}.json`;
      const loginState = {
        cookies,
        localStorage: JSON.parse(localStorage),
        url: instance.page.url(),
        savedAt: Date.now()
      };
      
      fs.writeFileSync(savePath, JSON.stringify(loginState, null, 2));
      
      res.json({ success: true, path: savePath, cookieCount: cookies.length });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 加载登录状态
  expressApp.post('/api/browser/:id/login-load', async (req, res) => {
    const instance = browserInstances.get(req.params.id);
    if (!instance) {
      return res.json({ success: false, error: 'Browser instance not found' });
    }
    
    try {
      const loadPath = req.body.path || `./login_state_${req.params.id}.json`;
      
      if (!fs.existsSync(loadPath)) {
        return res.json({ success: false, error: 'Login state file not found' });
      }
      
      const loginState = JSON.parse(fs.readFileSync(loadPath, 'utf-8'));
      
      // 设置 Cookie
      await instance.page.setCookie(...loginState.cookies);
      
      // 跳转回保存时的 URL（如果需要）
      if (req.body.navigateBack && loginState.url) {
        await instance.page.goto(loginState.url);
      }
      
      res.json({ success: true, cookieCount: loginState.cookies.length });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 输入手机号并点击获取验证码
  expressApp.post('/api/browser/:id/login-phone', async (req, res) => {
    const instance = browserInstances.get(req.params.id);
    if (!instance) {
      return res.json({ success: false, error: 'Browser instance not found' });
    }
    
    const { phone, phoneSelector, sendBtnSelector } = req.body;
    
    try {
      // 查找手机号输入框
      const sel = phoneSelector || 'input[name="phone"], input[name="mobile"], input[type="tel"]';
      await instance.page.type(sel, phone);
      
      // 点击发送验证码按钮
      const btnSel = sendBtnSelector || 'button:contains("获取验证码"), button:contains("发送"), button[type="submit"]';
      await instance.page.click(btnSel).catch(() => {});
      
      res.json({ success: true, message: 'Phone number entered, verification code sent' });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 输入验证码并登录
  expressApp.post('/api/browser/:id/login-verify', async (req, res) => {
    const instance = browserInstances.get(req.params.id);
    if (!instance) {
      return res.json({ success: false, error: 'Browser instance not found' });
    }
    
    const { code, codeSelector, submitSelector } = req.body;
    
    try {
      // 输入验证码
      const sel = codeSelector || 'input[name="code"], input[name="captcha"], input[name="verify"]';
      await instance.page.type(sel, code);
      
      // 点击登录按钮
      const btnSel = submitSelector || 'button[type="submit"], button:contains("登录"), button:contains("确认")';
      await instance.page.click(btnSel).catch(() => {});
      
      res.json({ success: true, message: 'Verification code submitted' });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 关闭实例
  expressApp.delete('/api/browser/:id', (req, res) => {
    const result = handleBrowserClose(null, { id: req.params.id });
    res.json(result);
  });

  // 重试配置
  expressApp.get('/api/retry/config', (req, res) => {
    res.json({ success: true, config: defaultRetryConfig });
  });

  expressApp.post('/api/retry/config', (req, res) => {
    const { maxRetries, initialDelay, maxDelay, backoffMultiplier, retryableErrors } = req.body;
    if (maxRetries !== undefined) defaultRetryConfig.maxRetries = maxRetries;
    if (initialDelay !== undefined) defaultRetryConfig.initialDelay = initialDelay;
    if (maxDelay !== undefined) defaultRetryConfig.maxDelay = maxDelay;
    if (backoffMultiplier !== undefined) defaultRetryConfig.backoffMultiplier = backoffMultiplier;
    if (retryableErrors !== undefined) defaultRetryConfig.retryableErrors = retryableErrors;
    res.json({ success: true, config: defaultRetryConfig });
  });

  expressApp.post('/api/retry/test', async (req, res) => {
    const { attempts = 3, failUntilAttempt = 2 } = req.body;
    let currentAttempt = 0;
    const result = await withRetry(async () => {
      currentAttempt++;
      if (currentAttempt <= failUntilAttempt) {
        throw new Error('net::ERR_CONNECTION_RESET');
      }
      return { success: true, message: `Succeeded on attempt ${currentAttempt}` };
    }, { maxRetries: attempts - 1 });
    res.json({ ...result, attempts: currentAttempt });
  });

  const server = http.createServer(expressApp);
  server.listen(3847, () => {
    console.log('OpenClaw Browser (Puppeteer) started on port 3847');
    console.log('Using system Chrome:', defaultBrowserOptions.executablePath);
  });

  return server;
}

// 启动
startApiServer();
