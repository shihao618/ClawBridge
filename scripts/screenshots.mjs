#!/usr/bin/env node
/**
 * ClawBridge 2.0.0 截图重生成脚本（零外部依赖）。
 *
 * 可复现地重建 README「界面预览」引用的全部截图：
 *   1. 启动临时 mock 微信 iLink 服务（mock/ilink-mock.mjs，随机端口）；
 *   2. 启动临时 app 实例（随机端口 + 临时 DATA_DIR，连接 mock，不接触真实微信/真实数据）；
 *   3. 通过 mock 控制面自动「扫码 + 确认」绑定 3 个演示用户（昵称固定为演示用户A/B/C）；
 *   4. 通过管理 API 种入演示分组/保活/接口规则/定时任务，并注入演示消息、图片与文件附件；
 *   5. 用 headless Edge/Chrome + CDP 打开各页面，按固定视口截取 screenshots/*.webp（文件名与 README 引用一致）。
 *
 * 隐私：演示数据均为虚构；脚本在截图前会清除页面文本中的本机绝对路径，并断言页面不包含
 * 真实昵称/绝对路径痕迹（截图内容不含 `C:\...`、`/Users/...`、`/tmp/...` 等）。
 *
 * 用法：
 *   node scripts/screenshots.mjs               # 生成全部截图（无浏览器时优雅退出，exit 0）
 *   node scripts/screenshots.mjs --verbose     # 打印 CDP/子进程细节
 *   node scripts/screenshots.mjs --only=admin-menu-overview,bind-mobile   # 只重截部分
 *
 * 环境变量：EDGE_PATH / CHROME_PATH 可显式指定浏览器可执行文件。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots');
const VERBOSE = process.argv.includes('--verbose');
const ONLY = (() => {
  const arg = process.argv.find((item) => item.startsWith('--only='));
  if (!arg) return null;
  return new Set(arg.slice('--only='.length).split(',').map((item) => item.trim()).filter(Boolean));
})();
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const APP_START_TIMEOUT_MS = 30_000;
const BROWSER_START_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 20_000;

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

function log(...args) {
  console.log('[screenshots]', ...args);
}
function logVerbose(...args) {
  if (VERBOSE) console.log('[screenshots:verbose]', ...args);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 120, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function httpJson(url, { method = 'GET', body, headers = {}, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** 带 Cookie 的管理端 HTTP 客户端（用于种子数据，避免截图脚本依赖浏览器登录态）。 */
class AdminClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = '';
  }

  async request(pathname, { method = 'GET', body } = {}) {
    const headers = { 'X-Requested-With': 'ClawBridge-Admin' };
    if (this.cookie) headers.Cookie = this.cookie;
    const result = await httpJson(`${this.baseUrl}${pathname}`, { method, body, headers });
    const setCookies = typeof result.headers.getSetCookie === 'function' ? result.headers.getSetCookie() : [];
    if (setCookies.length > 0) this.cookie = setCookies.map((item) => item.split(';')[0]).join('; ');
    if (!result.ok) throw new Error(`${method} ${pathname} -> ${result.status} ${result.text.slice(0, 300)}`);
    return result.json;
  }

  async login(password) {
    const result = await httpJson(`${this.baseUrl}/api/admin/login`, {
      method: 'POST',
      body: { password },
      headers: { 'X-Requested-With': 'ClawBridge-Admin' },
    });
    if (!result.ok) throw new Error(`管理员登录失败：HTTP ${result.status} ${result.text.slice(0, 200)}`);
    const setCookies = typeof result.headers.getSetCookie === 'function' ? result.headers.getSetCookie() : [];
    if (setCookies.length === 0) throw new Error('管理员登录未返回会话 Cookie');
    this.cookie = setCookies.map((item) => item.split(';')[0]).join('; ');
  }
}

/* ------------------------------------------------------------------ */
/* 演示用 PNG（生成渐变图，不依赖图片库）                              */
/* ------------------------------------------------------------------ */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}
function createDemoPng(width = 480, height = 320) {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      const wave = Math.sin((x / width) * Math.PI * 2 + (y / height) * Math.PI) * 0.5 + 0.5;
      raw[offset] = Math.round(30 + wave * 60); // R
      raw[offset + 1] = Math.round(150 + wave * 70); // G（微信绿系）
      raw[offset + 2] = Math.round(160 + (1 - wave) * 70); // B
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* 子进程：mock / app / 浏览器                                          */
/* ------------------------------------------------------------------ */
function findBrowser() {
  const envPath = process.env.EDGE_PATH || process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const candidates = [
    path.join(process.env['ProgramFiles'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((item) => item && fs.existsSync(item)) || null;
}

async function startMock() {
  const child = spawn(process.execPath, [path.join(ROOT, 'mock', 'ilink-mock.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      MOCK_QUIET: '1',
      MOCK_AUTO_CONFIRM_MS: '0',
      MOCK_QR_POLL_MS: '200',
      MOCK_LONGPOLL_MS: '250',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let port = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
    logVerbose('mock stdout:', chunk.trim());
    for (const line of chunk.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const event = JSON.parse(line);
        if (event.event === 'listening' && event.port) port = Number(event.port);
      } catch {
        /* 忽略非 JSON 行 */
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
    logVerbose('mock stderr:', chunk.trim());
  });
  const stop = async () => {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  };
  await waitFor(() => port !== null, { timeoutMs: 10_000, intervalMs: 100, label: 'mock 监听端口' });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => {
      const result = await httpJson(`${baseUrl}/__mock/health`, { timeoutMs: 2000 }).catch(() => null);
      return result && result.ok;
    },
    { timeoutMs: 10_000, intervalMs: 100, label: 'mock health' },
  );
  return { baseUrl, stop, output: () => output };
}

async function startApp({ mockBaseUrl }) {
  const port = await getFreePort();
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clawbridge-screenshots-'));
  const child = spawn(process.execPath, [path.join('server', 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      APP_SECRET: 'a'.repeat(64),
      LOG_LEVEL: 'warn',
      ILINK_LOGIN_BASE_URL: mockBaseUrl,
      ILINK_BASE_URL: mockBaseUrl,
      ILINK_CDN_BASE_URL: mockBaseUrl,
      APP_RULES_ALLOWED_HOSTS: '127.0.0.1',
      MEDIA_ALLOWED_HOSTS: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
    logVerbose('app stdout:', chunk.trim());
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
    logVerbose('app stderr:', chunk.trim());
  });
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });
  const stop = async () => {
    if (exitInfo) return;
    child.kill('SIGTERM');
    try {
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000).then(() => child.kill('SIGKILL'))]);
    } catch {
      /* 忽略清理失败 */
    }
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  };
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => {
      if (exitInfo) throw new Error(`app 提前退出（code=${exitInfo.code}）：${output.slice(-800)}`);
      const result = await httpJson(`${baseUrl}/health`, { timeoutMs: 2000 }).catch(() => null);
      return result && result.ok;
    },
    { timeoutMs: APP_START_TIMEOUT_MS, intervalMs: 150, label: 'app /health' },
  );
  const passwordFile = path.join(dataDir, 'admin-password.txt');
  const password = await waitFor(
    async () => {
      const text = await fsp.readFile(passwordFile, 'utf8').catch(() => '');
      return text.trim() || null;
    },
    { timeoutMs: 5000, label: 'admin-password.txt' },
  );
  return { baseUrl, password, stop, output: () => output };
}

async function startBrowser() {
  const browserPath = findBrowser();
  if (!browserPath) return null;
  const debugPort = await getFreePort();
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clawbridge-screenshots-browser-'));
  const child = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--mute-audio',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  child.stdout.resume();
  child.stderr.resume();
  const stop = async () => {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
    await sleep(200);
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const target = await waitFor(
      async () => {
        const result = await httpJson(`http://127.0.0.1:${debugPort}/json/list`, { timeoutMs: 2000 }).catch(() => null);
        if (!result || !result.ok || !Array.isArray(result.json)) return null;
        return result.json.find((item) => item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string') || null;
      },
      { timeoutMs: BROWSER_START_TIMEOUT_MS, intervalMs: 200, label: '浏览器 CDP' },
    );
    return { stop, wsUrl: target.webSocketDebuggerUrl };
  } catch (err) {
    await stop();
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端（Node 内置 WebSocket）                               */
/* ------------------------------------------------------------------ */
class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.errors = [];
  }

  async connect() {
    const ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket 连接失败'));
      });
    });
    this.ws = ws;
    ws.addEventListener('message', (event) => this.#onMessage(event.data));
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}（${message.error.code}）`));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of this.handlers.get(message.method) || []) {
        try {
          handler(message.params);
        } catch {
          /* 忽略 handler 异常 */
        }
      }
    }
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 请求超时：${method}`));
        }
      }, NAV_TIMEOUT_MS).unref?.();
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
  }

  watchErrors() {
    this.on('Runtime.exceptionThrown', (params) => {
      const text = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || '';
      this.errors.push(String(text).slice(0, 500));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面脚本异常：${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await waitFor(async () => (await this.evaluate('document.readyState')) === 'complete', {
      timeoutMs: NAV_TIMEOUT_MS,
      label: `页面加载 ${url}`,
    });
  }

  async setViewport({ width, height, deviceScaleFactor, mobile }) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
      screenWidth: width,
      screenHeight: height,
    });
  }

  async capture(name, { clip } = {}) {
    const params = { format: 'webp', quality: 82, captureBeyondViewport: Boolean(clip), fromSurface: true };
    if (clip) params.clip = { ...clip, scale: 1 };
    const shot = await this.send('Page.captureScreenshot', params);
    return Buffer.from(shot.data, 'base64');
  }
}

/* ------------------------------------------------------------------ */
/* 页面辅助：登录 / 视图切换 / 截图前脱敏                               */
/* ------------------------------------------------------------------ */
const SANITIZE_SCRIPT = `(() => {
  const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\\\/]|\\/(?:Users|home|tmp|var\\/folders)\\/)[^\\s"'<>]*/g;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.nodeValue && ABSOLUTE_PATH.test(node.nodeValue)) node.nodeValue = node.nodeValue.replace(ABSOLUTE_PATH, '…');
  }
  // 清理上一动作残留的 toast 提示
  for (const toast of document.querySelectorAll('.toast')) toast.remove();
  // 运行配置「数据目录」统一显示为 /data，避免泄露本机路径
  const configList = document.getElementById('config-list');
  if (configList) {
    for (const item of configList.querySelectorAll('.kv-item, .kv')) {
      const label = item.querySelector('.kv-label');
      const value = item.querySelector('.kv-value');
      if (label && value && label.textContent.trim() === '数据目录') value.textContent = '/data';
    }
  }
  return true;
})()`;

const PRIVACY_CHECK_SCRIPT = `(() => {
  const text = document.body.innerText || '';
  const leaks = [];
  const absolute = /(?:[A-Za-z]:[\\\\/]|\\/(?:Users|home|tmp|var\\/folders)\\/)/;
  if (absolute.test(text)) leaks.push('absolute-path');
  for (const bad of ['杨星雨', '真实用户', 'DEMO_SECRET']) if (text.includes(bad)) leaks.push(bad);
  return leaks;
})()`;

async function adminLogin(cdp, baseUrl, password) {
  await cdp.navigate(`${baseUrl}/admin`);
  const status = await cdp.evaluate(`(async () => {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ClawBridge-Admin' },
      body: JSON.stringify({ password: ${JSON.stringify(password)} }),
    });
    return res.status;
  })()`);
  if (status !== 200) throw new Error(`管理员登录失败：HTTP ${status}`);
  // 带查询参数强制整页重载（仅改 hash 不会重新执行 bootstrap）
  await cdp.navigate(`${baseUrl}/admin?from=screenshots#/overview`);
  await waitFor(
    async () => (await cdp.evaluate("!!document.querySelector('#dashboard:not([hidden])')")) === true,
    { timeoutMs: NAV_TIMEOUT_MS, intervalMs: 150, label: '管理后台登录' },
  );
  // 等待侧栏版本号（验证 2.0.0 UI）
  await waitFor(
    async () =>
      (await cdp.evaluate(
        `document.querySelector('#sidebar-version')?.textContent?.includes(${JSON.stringify('v' + APP_VERSION)}) || false`,
      )) === true,
    { timeoutMs: 10_000, intervalMs: 200, label: `侧栏版本号 v${APP_VERSION}` },
  );
}

async function gotoAdminView(cdp, baseUrl, viewId) {
  await cdp.evaluate(`location.hash = '#/${viewId}'`);
  await waitFor(
    async () =>
      (await cdp.evaluate(
        `document.querySelector('.view-section[data-view="${viewId}"]:not([hidden])') !== null`,
      )) === true,
    { timeoutMs: NAV_TIMEOUT_MS, intervalMs: 120, label: `视图 ${viewId}` },
  );
  await sleep(700);
}

async function clickModalClose(cdp) {
  await cdp.evaluate("document.querySelector('.modal .modal-close')?.click()");
  await waitFor(
    async () => (await cdp.evaluate("!!document.querySelector('.modal')")) === false,
    { timeoutMs: 10_000, intervalMs: 120, label: '关闭弹窗' },
  );
  await sleep(220);
}

async function waitModalTitle(cdp, substring) {
  await waitFor(
    async () =>
      (await cdp.evaluate(
        `document.querySelector('.modal .modal-title')?.textContent?.includes(${JSON.stringify(substring)}) || false`,
      )) === true,
    { timeoutMs: NAV_TIMEOUT_MS, intervalMs: 120, label: `弹窗「${substring}」` },
  );
  await sleep(220);
}

/* ------------------------------------------------------------------ */
/* 截图执行                                                             */
/* ------------------------------------------------------------------ */
const results = [];
let failures = 0;

async function capture(cdp, name, { clipSelector = null, viewport = DESKTOP, waitMs = 260 } = {}) {
  if (ONLY && !ONLY.has(name)) return;
  await cdp.setViewport(viewport);
  await sleep(120);
  await cdp.evaluate(SANITIZE_SCRIPT);
  await checkPrivacy(cdp, name);
  if (clipSelector) {
    await cdp.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(clipSelector)});
      if (node) {
        node.scrollIntoView({ block: 'start' });
        window.scrollBy(0, 118); // 跳过 view-head，让内容表格/卡片成为主体
      }
      return true;
    })()`);
  }
  await sleep(waitMs);
  const buffer = await cdp.capture(name);
  return saveScreenshot(name, buffer);
}

function saveScreenshot(name, buffer) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const file = path.join(SCREENSHOTS_DIR, `${name}.webp`);
  fs.writeFileSync(file, buffer);
  results.push({ name, bytes: buffer.length });
  log(`已生成 screenshots/${name}.webp（${(buffer.length / 1024).toFixed(1)} KB）`);
  return file;
}

async function checkPrivacy(cdp, name) {
  const leaks = await cdp.evaluate(PRIVACY_CHECK_SCRIPT);
  if (Array.isArray(leaks) && leaks.length > 0) {
    throw new Error(`截图 ${name} 页面文本疑似包含隐私信息：${leaks.join(', ')}`);
  }
}

/* ------------------------------------------------------------------ */
/* 数据种子                                                             */
/* ------------------------------------------------------------------ */
async function bindDemoUser({ appBase, mockBase, displayName }) {
  const created = await httpJson(`${appBase}/api/bind/sessions`, { method: 'POST', body: { displayName } });
  if (!created.ok) throw new Error(`创建绑定会话失败：${created.status} ${created.text.slice(0, 200)}`);
  const { sessionId, token } = created.json;
  const qrcode = await waitFor(
    async () => {
      const state = await httpJson(`${mockBase}/__mock/state`);
      const qr = (state.json?.qrs || []).at(-1);
      return qr && qr.status === 'wait' ? qr.qrcode : null;
    },
    { timeoutMs: 10_000, intervalMs: 100, label: 'mock 二维码' },
  );
  await httpJson(`${mockBase}/__mock/qr/${encodeURIComponent(qrcode)}/scan`, { method: 'POST', body: {} });
  await httpJson(`${mockBase}/__mock/qr/${encodeURIComponent(qrcode)}/confirm`, { method: 'POST', body: {} });
  await waitFor(
    async () => {
      const view = await httpJson(`${appBase}/api/bind/sessions/${sessionId}?token=${encodeURIComponent(token)}`);
      return view.json && ['confirmed', 'already_bound'].includes(view.json.status);
    },
    { timeoutMs: 15_000, intervalMs: 200, label: `绑定用户 ${displayName}` },
  );
  log(`演示用户已绑定：${displayName}`);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */
async function run() {
  const browserPath = findBrowser();
  if (!browserPath) {
    log('未找到 headless Edge/Chrome，跳过截图生成（可用 EDGE_PATH/CHROME_PATH 指定浏览器）。');
    return;
  }
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const beforeSizes = new Map();
  for (const file of fs.readdirSync(SCREENSHOTS_DIR)) {
    if (file.endsWith('.webp')) beforeSizes.set(file.replace(/\.webp$/, ''), fs.statSync(path.join(SCREENSHOTS_DIR, file)).size);
  }

  let mock = null;
  let app = null;
  let browser = null;
  let cdp = null;
  try {
    mock = await startMock();
    app = await startApp({ mockBaseUrl: mock.baseUrl });
    const password = app.password;

    /* ---- 1. 种子演示数据（演示用户 / 分组 / 保活 / 规则 / 定时任务 / 消息） ---- */
    const admin = new AdminClient(app.baseUrl);
    await admin.login(password);

    for (const displayName of ['演示用户A', '演示用户B', '演示用户C']) {
      await bindDemoUser({ appBase: app.baseUrl, mockBase: mock.baseUrl, displayName });
    }

    const usersPayload = await admin.request('/api/admin/users?status=all&limit=500');
    const demoUsers = (usersPayload.items || []).filter((item) => /演示用户[ABC]/.test(item.displayName || ''));
    if (demoUsers.length < 3) throw new Error(`演示用户绑定数量不足：${demoUsers.length}`);
    log(`演示用户就绪：${demoUsers.map((u) => u.displayName).join('、')}`);

    const groups = [];
    for (const [name, description, color] of [
      ['示例分组', '演示用虚构分组：值班同学', '#2563EB'],
      ['演示分组', '演示用虚构分组：运营同事', '#7C3AED'],
      ['测试分组', '演示用虚构分组：测试账号', '#D97706'],
    ]) {
      const created = await admin.request('/api/admin/groups', {
        method: 'POST',
        body: { name, description, color },
      });
      groups.push(created.group);
    }
    if (groups.length < 3) throw new Error('演示分组创建失败');
    await admin.request(`/api/admin/users/${demoUsers[0].id}/groups`, {
      method: 'PUT',
      body: { groupIds: [groups[0].id, groups[1].id] },
    });
    await admin.request(`/api/admin/users/${demoUsers[1].id}/groups`, {
      method: 'PUT',
      body: { groupIds: [groups[1].id] },
    });
    await admin.request(`/api/admin/users/${demoUsers[2].id}/groups`, {
      method: 'PUT',
      body: { groupIds: [groups[2].id] },
    });
    for (const user of demoUsers.slice(0, 2)) {
      await admin.request(`/api/admin/users/${user.id}/keepalive`, { method: 'PATCH', body: { enabled: true } });
    }
    await admin.request(`/api/admin/groups/${groups[0].id}/keepalive`, { method: 'POST', body: { enabled: true } });

    const rulePayload = {
      name: '天气查询（演示）',
      enabled: true,
      priority: 100,
      scope: { type: 'all', ids: [] },
      matchMode: 'contains',
      keywords: ['天气', '查天气'],
      regexPattern: '',
      extraction: { mode: 'none', config: {} },
      request: { mode: 'none' },
      response: {
        type: 'json',
        path: '',
        template: '天气助手（演示）：北京今天晴，18~26℃，出行注意防晒。',
        fallbackText: '天气服务暂时不可用，请稍后再试。',
      },
      timeoutMs: 8000,
    };
    const ruleCreated = await admin.request('/api/admin/app-rules', { method: 'POST', body: rulePayload });
    const ruleId = ruleCreated.rule?.id || ruleCreated.id;
    if (!ruleId) throw new Error('演示规则创建失败');

    const schedulePayload = {
      name: '每日天气推送（演示）',
      enabled: false,
      schedule: {
        type: 'interval',
        intervalMs: 3600000,
        windowStart: '08:00',
        windowEnd: '22:00',
      },
      targets: { type: 'groups', ids: [groups[0].id] },
      request: { method: 'GET', url: `${mock.baseUrl}/__mock/health` },
      response: {
        type: 'json',
        path: 'ok',
        template: '服务状态：{{.}}（演示数据）',
        fallbackText: '定时通知发送失败（演示）',
      },
      timeoutMs: 8000,
    };
    const scheduleCreated = await admin.request('/api/admin/scheduled-tasks', { method: 'POST', body: schedulePayload });
    if (!scheduleCreated.task?.id && !scheduleCreated.id) throw new Error('演示定时任务创建失败');

    // 注入入站消息 + 媒体，触发规则运行日志与消息记录
    const state = await (await httpJson(`${mock.baseUrl}/__mock/state`)).json;
    const accounts = state.accounts || [];
    if (accounts.length < 3) throw new Error(`mock 账号数量不足：${accounts.length}`);
    const demoPng = createDemoPng();
    for (const account of accounts.slice(0, 3)) {
      await httpJson(`${mock.baseUrl}/__mock/accounts/${encodeURIComponent(account.botId)}/inbound`, {
        method: 'POST',
        body: { text: '查天气 北京' },
      });
    }
    await sleep(600);
    await httpJson(`${mock.baseUrl}/__mock/accounts/${encodeURIComponent(accounts[0].botId)}/inbound-media`, {
      method: 'POST',
      body: {
        kind: 'image',
        fileName: '演示图片.png',
        mime: 'image/png',
        fullUrl: true,
        contentBase64: demoPng.toString('base64'),
      },
    });
    await httpJson(`${mock.baseUrl}/__mock/accounts/${encodeURIComponent(accounts[1].botId)}/inbound-media`, {
      method: 'POST',
      body: {
        kind: 'file',
        fileName: '演示文档.txt',
        mime: 'text/plain',
        fullUrl: true,
        contentBase64: Buffer.from('ClawBridge 演示附件（虚构内容）').toString('base64'),
      },
    });
    for (const text of ['演示消息：明天下午三点开会，请准时参加。', '演示消息：欢迎使用 ClawBridge 2.0.0。']) {
      await admin.request(`/api/admin/users/${demoUsers[0].id}/messages`, { method: 'POST', body: { text } });
    }
    await waitFor(
      async () => {
        const logs = await admin.request(`/api/admin/app-rule-logs?ruleId=${encodeURIComponent(ruleId)}&limit=5&offset=0`);
        return (logs.items || []).length > 0;
      },
      { timeoutMs: 15_000, intervalMs: 300, label: '规则运行日志' },
    );
    log('演示数据种子完成（用户/分组/保活/规则/定时任务/消息/媒体）');

    /* ---- 2. 浏览器 + 绑定页截图（移动端） ---- */
    browser = await startBrowser();
    if (!browser) {
      log('未找到 headless Edge/Chrome，跳过截图生成。');
      return;
    }
    cdp = new CdpClient(browser.wsUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.watchErrors();

    await cdp.setViewport(MOBILE);
    await cdp.navigate(`${app.baseUrl}/`);
    await cdp.evaluate('sessionStorage.clear(); localStorage.clear(); true');
    await cdp.navigate(`${app.baseUrl}/`);
    await cdp.evaluate(`(() => {
      const input = document.querySelector('#display-name');
      input.value = '演示新用户';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#bind-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await waitFor(
      async () =>
        (await cdp.evaluate("!!document.querySelector('#bind-session:not([hidden]) #qr-img')")) === true,
      { timeoutMs: NAV_TIMEOUT_MS, intervalMs: 150, label: '绑定二维码' },
    );
    await sleep(500);
    await capture(cdp, 'bind-mobile', { viewport: MOBILE, waitMs: 200 });

    const freshState = await (await httpJson(`${mock.baseUrl}/__mock/state`)).json;
    const freshQr = (freshState.qrs || []).at(-1);
    if (!freshQr) throw new Error('绑定页二维码在 mock 中不存在');
    await httpJson(`${mock.baseUrl}/__mock/qr/${encodeURIComponent(freshQr.qrcode)}/scan`, { method: 'POST', body: {} });
    await httpJson(`${mock.baseUrl}/__mock/qr/${encodeURIComponent(freshQr.qrcode)}/confirm`, { method: 'POST', body: {} });
    await waitFor(
      async () => (await cdp.evaluate("!!document.querySelector('#bound-info:not([hidden])')")) === true,
      { timeoutMs: 20_000, intervalMs: 200, label: '绑定成功页' },
    );
    await sleep(400);
    await capture(cdp, 'bind-mobile-confirmed', { viewport: MOBILE, waitMs: 200 });

    /* ---- 3. 管理后台截图（桌面 + 移动） ---- */
    await cdp.setViewport(DESKTOP);
    await adminLogin(cdp, app.baseUrl, password);

    await gotoAdminView(cdp, app.baseUrl, 'overview');
    await capture(cdp, 'admin-menu-overview');

    await gotoAdminView(cdp, app.baseUrl, 'users');
    await sleep(500);
    await capture(cdp, 'admin-menu-users');
    await capture(cdp, 'admin-keepalive', { clipSelector: '.view-section[data-view="users"]' });

    await gotoAdminView(cdp, app.baseUrl, 'groups');
    await capture(cdp, 'admin-menu-groups');
    await capture(cdp, 'admin-groups', { clipSelector: '.view-section[data-view="groups"]' });

    await gotoAdminView(cdp, app.baseUrl, 'app-rules');
    await sleep(500);
    await capture(cdp, 'admin-menu-app-rules');
    await capture(cdp, 'admin-app-rules', { clipSelector: '.view-section[data-view="app-rules"]' });

    // 规则运行日志弹窗
    await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('#app-rule-table-body tr')].find((tr) => tr.innerText.includes('天气查询'));
      row?.querySelector('button[data-action="logs"]')?.click();
      return !!row;
    })()`);
    await waitModalTitle(cdp, '运行日志');
    await sleep(800);
    await capture(cdp, 'admin-app-rules-logs-modal');
    await clickModalClose(cdp);

    // 规则测试运行弹窗（dry-run，不发送）
    await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('#app-rule-table-body tr')].find((tr) => tr.innerText.includes('天气查询'));
      row?.querySelector('button[data-action="test"]')?.click();
      return !!row;
    })()`);
    await waitModalTitle(cdp, '测试运行：');
    await cdp.evaluate(`(() => {
      const input = document.querySelector('#rule-test-message');
      input.value = '查天气 北京';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.modal .modal-footer .btn-primary').click();
      return true;
    })()`);
    await waitFor(
      async () => (await cdp.evaluate("!!document.querySelector('#rule-test-result:not([hidden])')")) === true,
      { timeoutMs: 20_000, intervalMs: 200, label: '规则测试结果' },
    );
    await sleep(400);
    await capture(cdp, 'admin-app-rules-test');
    await clickModalClose(cdp);

    // 定时通知 Tab
    await cdp.evaluate("document.querySelector('button[data-rule-tab=\"schedule\"]')?.click()");
    await sleep(1200);
    await capture(cdp, 'admin-app-rules-schedule', { clipSelector: '.view-section[data-view="app-rules"]' });

    // 定时任务编辑弹窗：计划生效时间段
    await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('#schedule-table-body tr')].find((tr) => tr.innerText.includes('每日天气推送'));
      row?.querySelector('button[data-action="schedule-edit"]')?.click();
      return !!row;
    })()`);
    await waitModalTitle(cdp, '编辑定时任务');
    await cdp.evaluate(`(() => {
      const sections = document.querySelectorAll('.modal .rule-form-section');
      sections[1]?.scrollIntoView({ block: 'start' });
      return sections.length;
    })()`);
    await sleep(400);
    await capture(cdp, 'admin-schedule-window');
    await clickModalClose(cdp);

    // 定时任务测试运行弹窗
    await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('#schedule-table-body tr')].find((tr) => tr.innerText.includes('每日天气推送'));
      row?.querySelector('button[data-action="schedule-test"]')?.click();
      return !!row;
    })()`);
    await waitModalTitle(cdp, '测试运行：');
    await cdp.evaluate("document.querySelector('.modal .modal-footer .btn-primary')?.click()");
    await waitFor(
      async () => (await cdp.evaluate("!!document.querySelector('#schedule-test-result:not([hidden])')")) === true,
      { timeoutMs: 20_000, intervalMs: 200, label: '定时任务测试结果' },
    );
    await sleep(400);
    await capture(cdp, 'admin-app-rules-schedule-test');
    await clickModalClose(cdp);

    // 运行配置 / 安全卡片
    await gotoAdminView(cdp, app.baseUrl, 'config');
    await sleep(900);
    await cdp.evaluate(SANITIZE_SCRIPT);
    await capture(cdp, 'admin-settings', { clipSelector: '.view-section[data-view="config"]', waitMs: 300 });
    await cdp.evaluate("document.querySelector('#security-card')?.scrollIntoView({ block: 'center' })");
    await sleep(500);
    await capture(cdp, 'admin-security');

    // 发送弹窗（含附件预览）
    await gotoAdminView(cdp, app.baseUrl, 'users');
    await sleep(500);
    await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('#user-table-body tr')].find((tr) => tr.innerText.includes('演示用户A'));
      row?.querySelector('button[data-action="message"]')?.click();
      return !!row;
    })()`);
    await waitModalTitle(cdp, '发送消息');
    await cdp.evaluate(`(() => {
      const input = document.querySelector('#media-file-input');
      const bytes = Uint8Array.from(atob(${JSON.stringify(createDemoPng(240, 160).toString('base64'))}), (c) => c.charCodeAt(0));
      const file = new File([bytes], '演示图片.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const textarea = document.querySelector('#message-text');
      textarea.value = '这是一条带附件的演示消息（虚构数据）。';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(
      async () => (await cdp.evaluate("!!document.querySelector('#media-preview:not([hidden])')")) === true,
      { timeoutMs: 20_000, intervalMs: 200, label: '附件预览' },
    );
    await sleep(600);
    await capture(cdp, 'admin-media-send');
    await cdp.evaluate("document.querySelector('.modal .modal-footer .btn-primary')?.click()");
    await waitFor(
      async () => (await cdp.evaluate("!!document.querySelector('.modal')")) === false,
      { timeoutMs: 20_000, intervalMs: 200, label: '发送消息弹窗关闭' },
    );
    await sleep(800);

    // 消息记录（含多媒体附件）
    await gotoAdminView(cdp, app.baseUrl, 'messages');
    await sleep(900);
    await capture(cdp, 'admin-media-messages', { clipSelector: '.view-section[data-view="messages"]' });

    /* ---- 4. 文档页截图 ---- */
    await cdp.navigate(`${app.baseUrl}/docs`);
    await sleep(500);
    await capture(cdp, 'docs-page', { waitMs: 300 });
    for (const [sectionId, name] of [
      ['inbound-api', 'docs-inbound-api'],
      ['app-rules', 'docs-app-rules'],
      ['scheduled-tasks', 'docs-scheduled-tasks'],
    ]) {
      await cdp.evaluate(`document.getElementById(${JSON.stringify(sectionId)})?.scrollIntoView({ block: 'start' }); true`);
      await sleep(450);
      await capture(cdp, name, { waitMs: 200 });
    }

    /* ---- 5. 移动端后台（响应式侧栏，抽屉展开） ---- */
    await cdp.setViewport(MOBILE);
    await cdp.navigate(`${app.baseUrl}/admin#/overview`);
    await waitFor(
      async () => (await cdp.evaluate("!!document.querySelector('#dashboard:not([hidden])')")) === true,
      { timeoutMs: NAV_TIMEOUT_MS, intervalMs: 200, label: '移动端后台' },
    );
    await sleep(800);
    await cdp.evaluate("document.querySelector('#btn-sidebar-toggle')?.click()");
    await sleep(500);
    await capture(cdp, 'admin-menu-mobile', { viewport: MOBILE, waitMs: 250 });

    if (cdp.errors.length > 0) {
      throw new Error(`浏览器页面异常：${cdp.errors.slice(0, 3).join(' | ')}`);
    }

    /* ---- 6. 汇总（体积前后对比） ---- */
    log('----------------------------------------');
    log(`截图完成：${results.length} 张`);
    for (const item of results) {
      const before = beforeSizes.get(item.name);
      const detail = before ? `${(before / 1024).toFixed(1)} KB -> ${(item.bytes / 1024).toFixed(1)} KB` : `${(item.bytes / 1024).toFixed(1)} KB（新增）`;
      log(`  ${item.name}.webp  ${detail}`);
    }
    const missing = [...beforeSizes.keys()].filter((name) => !results.some((item) => item.name === name));
    if (missing.length > 0) log(`未重截（--only 过滤）：${missing.join(', ')}`);
  } finally {
    cdp?.close();
    if (browser) await browser.stop();
    if (app) await app.stop();
    if (mock) await mock.stop();
  }
}

try {
  await run();
  if (failures > 0) process.exit(1);
} catch (error) {
  failures += 1;
  console.error('[screenshots] 失败：', error && error.stack ? error.stack : error);
  process.exit(1);
}
