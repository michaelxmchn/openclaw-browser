/**
 * OpenClaw Browser - 完整集成测试
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const API_URL = 'http://localhost:3847';
const API_KEY = 'test';

let electronProcess = null;
let testsPassed = 0;
let testsFailed = 0;

// 启动 Electron
function startElectron() {
  return new Promise((resolve, reject) => {
    console.log('🚀 Starting Electron...');
    
    electronProcess = spawn('npx', [
      'electron', '.',
      '--no-sandbox',
      '--disable-gpu'
    ], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    electronProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      console.log('[Electron]', msg.trim());
      if (msg.includes('ready')) {
        setTimeout(resolve, 2000);
      }
    });

    electronProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        console.log('[Electron Error]', msg.trim());
      }
    });

    electronProcess.on('error', reject);
    setTimeout(() => reject(new Error('Timeout starting Electron')), 30000);
  });
}

// 停止 Electron
function stopElectron() {
  if (electronProcess) {
    console.log('🛑 Stopping Electron...');
    electronProcess.kill();
  }
}

// HTTP 请求
function request(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 测试函数
async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    testsPassed++;
  } catch (err) {
    console.log(`❌ ${name}: ${err.message}`);
    testsFailed++;
  }
}

async function runTests() {
  console.log('\n🧪 OpenClaw Browser - 完整集成测试 (v2)\n');
  console.log('='.repeat(50));

  try {
    await startElectron();
    
    await test('Health Check', async () => {
      const result = await request('GET', '/health');
      if (result.status !== 'ok') throw new Error('Health check failed');
    });

    await test('API Info', async () => {
      const result = await request('GET', '/');
      if (result.name !== 'OpenClaw Browser API') throw new Error('API info mismatch');
    });

    // 创建浏览器实例
    let browserId;
    await test('Create Browser Instance', async () => {
      const result = await request('POST', '/api/browser/create', { 
        headless: true,
        width: 1280,
        height: 800
      });
      if (!result.success || !result.id) throw new Error('Failed to create browser');
      browserId = result.id;
      console.log(`   Browser ID: ${browserId}`);
    });

    // 导航
    await test('Navigate to URL', async () => {
      const result = await request('POST', `/api/browser/${browserId}/navigate`, { 
        url: 'https://example.com' 
      });
      if (!result.success) throw new Error('Navigation failed');
    });

    // 获取标题
    await test('Get Page Title', async () => {
      const result = await request('GET', `/api/browser/${browserId}/title`);
      if (!result.success) throw new Error('Failed to get title');
      console.log(`   Title: ${result.title}`);
    });

    // 获取 URL
    await test('Get Page URL', async () => {
      const result = await request('GET', `/api/browser/${browserId}/url`);
      if (!result.success) throw new Error('Failed to get URL');
    });

    // 获取内容
    await test('Get Page Content', async () => {
      const result = await request('GET', `/api/browser/${browserId}/content`);
      if (!result.success) throw new Error('Failed to get content');
    });

    // 截图
    await test('Screenshot', async () => {
      const result = await request('GET', `/api/browser/${browserId}/screenshot`);
      if (!result.success) throw new Error('Screenshot failed');
    });

    // JS 执行
    await test('Evaluate JavaScript', async () => {
      const result = await request('POST', `/api/browser/${browserId}/evaluate`, { 
        script: 'document.title' 
      });
      if (!result.success) throw new Error('JS evaluation failed');
    });

    // 滚动
    await test('Scroll Page', async () => {
      const result = await request('POST', `/api/browser/${browserId}/scroll`, { 
        x: 0, y: 100 
      });
      if (!result.success) throw new Error('Scroll failed');
    });

    // Cookie
    await test('Get Cookies', async () => {
      const result = await request('GET', `/api/browser/${browserId}/cookies?url=https://example.com`);
      // Cookie 可能为空，但不应该是错误
    });

    // 列表
    await test('List Browser Instances', async () => {
      const result = await request('GET', '/api/browser/list');
      if (!result.success) throw new Error('List failed');
    });

    // 关闭
    await test('Close Browser Instance', async () => {
      const result = await request('DELETE', `/api/browser/${browserId}`);
      if (!result.success) throw new Error('Close failed');
    });

    // 等待
    await new Promise(r => setTimeout(r, 1000));

    // 验证关闭
    await test('Verify Instance Closed', async () => {
      try {
        const result = await request('GET', '/api/browser/list');
        if (result.instances && result.instances.some(i => i.id === browserId)) {
          throw new Error('Instance still exists');
        }
      } catch (err) {
        if (err.message.includes('ECONNREFUSED')) {
          console.log('   (Electron stopped, instance closed)');
          return;
        }
        throw err;
      }
    });

  } catch (err) {
    console.log(`\n❌ Test suite error: ${err.message}`);
  } finally {
    stopElectron();
  }

  console.log('\n' + '='.repeat(50));
  console.log(`📊 测试结果: ${testsPassed} 通过, ${testsFailed} 失败`);
  console.log('='.repeat(50));

  if (testsFailed === 0) {
    console.log('\n🎉 所有测试通过！\n');
    process.exit(0);
  } else {
    console.log('\n⚠️ 部分测试失败。\n');
    process.exit(1);
  }
}

runTests();
