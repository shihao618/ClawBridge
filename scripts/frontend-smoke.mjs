#!/usr/bin/env node
/**
 * 前端浏览器冒烟测试（零外部依赖）。
 *
 * 目标：弥补 tests/unit/frontend-pages.test.js 只能做"源码文本静态校验"的不足，
 * 用本机安装的 Edge/Chrome 以 headless 模式真实加载页面，验证：
 *   1. /admin 登录页可渲染，管理密码登录成功 → 概览视图渲染；
 *   2. 逐个 hash 路由切换到全部菜单视图（概览/用户/分组/消息/广播/规则与定时通知/运行配置），
 *      每个视图都能激活且无未捕获异常；
 *   3. / 绑定页与 /docs 文档页可加载、无脚本错误；
 *   4. 全程收集 Console error / Runtime exception / Log error，作为失败依据。
 *
 * 用法：
 *   node scripts/frontend-smoke.mjs            # 找不到浏览器时跳过（exit 0）
 *   node scripts/frontend-smoke.mjs --verbose  # 打印 CDP 细节与页面错误明细
 *
 * 环境变量：EDGE_PATH / CHROME_PATH 可显式指定浏览器可执行文件路径。
 *
 * 说明：脚本会启动一个临时 app 实例（随机端口、临时 DATA_DIR，不触碰 data/ 与线上容器），
 * 结束后自动清理；无外部 npm 依赖（CDP 使用 Node 内置 WebSocket）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
const APP_START_TIMEOUT_MS = 20_000;
const BROWSER_START_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 15_000;

/** 管理后台全部菜单视图 id（与 web/assets/admin.js 的 MENU_VIEWS 一致）。 */
const ADMIN_VIEWS = ['overview', 'users', 'groups', 'messages', 'broadcast', 'app-rules', 'config'];

function log(...args) {
  console.log('[smoke]', ...args);
}

function logVerbose(...args) {
  if (VERBOSE) console.log('[smoke:verbose]', ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到 fn 返回真值；超时抛错。 */
async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 150, label = 'condition' } = {}) {
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
  throw new Error(`等待超时（${label}）${lastError ? `：${lastError.message}` : ''}`);
}

/** 申请一个空闲端口。 */
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

/** 查找本机可用的 Chromium 系浏览器。 */
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
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
}

/** HTTP GET，返回 Response（失败抛错）。 */
async function httpGet(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers: { 'Accept-Encoding': 'identity' } });
  } finally {
    clearTimeout(timer);
  }
}

/** 启动临时 app 实例，返回 { port, dataDir, child, stop }。 */
async function startApp() {
  const port = await getFreePort();
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clawbridge-smoke-'));
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
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(5000).then(() => child.kill('SIGKILL')),
      ]);
    } catch {
      /* 忽略清理失败 */
    }
  };

  try {
    await waitFor(
      async () => {
        if (exitInfo) throw new Error(`app 进程提前退出（code=${exitInfo.code}）：${output.slice(-800)}`);
        const res = await httpGet(`http://127.0.0.1:${port}/health`);
        return res.ok;
      },
      { timeoutMs: APP_START_TIMEOUT_MS, label: 'app /health' },
    );
  } catch (err) {
    await stop();
    throw err;
  }

  // 首次启动会把自动生成的随机管理密码写入 DATA_DIR/admin-password.txt
  const passwordFile = path.join(dataDir, 'admin-password.txt');
  const password = await waitFor(
    async () => {
      const text = await fsp.readFile(passwordFile, 'utf8').catch(() => '');
      return text.trim() || null;
    },
    { timeoutMs: 5000, label: 'admin-password.txt' },
  );

  return { port, dataDir, child, password, stop, output: () => output };
}

/** 启动 headless 浏览器并等待 CDP 可用。 */
async function startBrowser() {
  const browserPath = findBrowser();
  if (!browserPath) return null;
  const debugPort = await getFreePort();
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clawbridge-smoke-browser-'));
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
    const targets = await waitFor(
      async () => {
        const res = await httpGet(`http://127.0.0.1:${debugPort}/json/list`);
        if (!res.ok) return null;
        const list = await res.json();
        const page = list.find((item) => item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string');
        return page || null;
      },
      { timeoutMs: BROWSER_START_TIMEOUT_MS, intervalMs: 250, label: '浏览器 CDP' },
    );
    return { child, debugPort, stop, wsUrl: targets.webSocketDebuggerUrl };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** 极简 CDP 客户端（Node 内置 WebSocket）。 */
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
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket 连接失败：${event?.message || 'unknown'}`));
      });
    });
    ws.addEventListener('message', (event) => this.#onMessage(event.data));
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
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
        } catch (err) {
          logVerbose('CDP handler 异常:', err.message);
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

  /** 收集页面侧错误（console.error / 未捕获异常 / 浏览器日志 error）。 */
  watchErrors() {
    this.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error' && params.type !== 'assert') return;
      const text = (params.args || [])
        .map((arg) => arg.value ?? arg.description ?? arg.preview?.description ?? '')
        .join(' ');
      this.errors.push({ kind: 'console.error', text: String(text).slice(0, 500) });
    });
    this.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails || {};
      const text = details.exception?.description || details.text || 'unknown exception';
      this.errors.push({ kind: 'exception', text: String(text).slice(0, 500) });
    });
    this.on('Log.entryAdded', (params) => {
      const entry = params.entry || {};
      if (entry.level !== 'error') return;
      this.errors.push({ kind: `log.${entry.source || 'browser'}`, text: String(entry.text || '').slice(0, 500) });
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
      const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`页面脚本异常：${text}`);
    }
    return result.result?.value;
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await waitFor(
      async () => (await this.evaluate('document.readyState')) === 'complete',
      { timeoutMs: NAV_TIMEOUT_MS, label: `页面加载 ${url}` },
    );
  }
}

/** 校验：当前激活的视图 id（登录页返回 'login'）。 */
const ACTIVE_VIEW_EXPR =
  "document.querySelector('.view-section:not([hidden])')?.dataset.view || (document.querySelector('#login-view:not([hidden])') ? 'login' : '')";

/** 断言辅助。 */
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

/** 切换到指定后台视图并等待其激活。 */
async function activateView(cdp, viewId) {
  await cdp.evaluate(`(location.hash = '#/${viewId}')`);
  await waitFor(async () => (await cdp.evaluate(ACTIVE_VIEW_EXPR)) === viewId, {
    timeoutMs: NAV_TIMEOUT_MS,
    intervalMs: 120,
    label: `视图 ${viewId} 激活`,
  });
}

/** 等待最上层弹窗标题包含指定文案（支持弹窗叠加）。 */
async function waitModalTitle(cdp, substring) {
  return waitFor(
    async () => {
      const title = await cdp.evaluate(
        "Array.from(document.querySelectorAll('.modal')).at(-1)?.querySelector('.modal-title')?.textContent || ''",
      );
      return title.includes(substring) ? title : null;
    },
    { timeoutMs: NAV_TIMEOUT_MS, intervalMs: 100, label: `弹窗「${substring}」` },
  );
}

/** 等待所有弹窗从 DOM 移除（关闭动画约 180ms）。 */
async function waitNoModal(cdp) {
  await waitFor(async () => (await cdp.evaluate("!document.querySelector('.modal')")) === true, {
    timeoutMs: NAV_TIMEOUT_MS,
    intervalMs: 100,
    label: '弹窗关闭',
  });
}

/** 点击弹窗底部最后一个按钮（即确认/主操作按钮）。 */
async function clickModalConfirm(cdp) {
  await cdp.evaluate("[...document.querySelectorAll('.modal .modal-footer button')].at(-1)?.click()");
}

async function run() {
  const browserPath = findBrowser();
  if (!browserPath) {
    log('未找到 Edge/Chrome，跳过浏览器冒烟测试（可用 EDGE_PATH 指定）。');
    return 0;
  }
  log(`浏览器：${browserPath}`);

  let app = null;
  let browser = null;
  let cdp = null;
  const failures = [];
  try {
    app = await startApp();
    const baseUrl = `http://127.0.0.1:${app.port}`;
    log(`临时实例已启动：${baseUrl}（DATA_DIR=${app.dataDir}）`);

    browser = await startBrowser();
    assert(browser, '浏览器启动失败');
    cdp = new CdpClient(browser.wsUrl);
    await cdp.connect();
    cdp.watchErrors();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.setLifecycleEventsEnabled', { enabled: false }).catch(() => {});

    // ---- 1. 管理后台：登录 ----
    await cdp.navigate(`${baseUrl}/admin`);
    await waitFor(
      async () => (await cdp.evaluate("!!document.querySelector('#login-view:not([hidden])')")) === true,
      { timeoutMs: NAV_TIMEOUT_MS, label: '登录视图渲染' },
    );
    log('通过：登录视图渲染');

    await cdp.evaluate(`(() => {
      const input = document.querySelector('#login-password');
      input.value = ${JSON.stringify(app.password)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await waitFor(
      async () => (await cdp.evaluate("!!document.querySelector('#dashboard:not([hidden])')")) === true,
      { timeoutMs: NAV_TIMEOUT_MS, intervalMs: 200, label: '登录成功后进入后台' },
    );
    log('通过：管理密码登录');

    // ---- 2. 全部菜单视图 ----
    for (const viewId of ADMIN_VIEWS) {
      await activateView(cdp, viewId);
      // 等待该视图首个数据请求完成（列表/表单渲染）
      await sleep(400);
      const rendered = await cdp.evaluate(
        "document.querySelector('.view-section:not([hidden])')?.innerText?.trim().length || 0",
      );
      assert(rendered > 0, `视图 ${viewId} 未渲染任何文本`);
      log(`通过：视图 ${viewId}（文本长度 ${rendered}）`);
    }

    // ---- 2b. 关键交互：分组创建/删除、规则/任务编辑器、登出 ----
    await activateView(cdp, 'groups');
    await cdp.evaluate("document.querySelector('#btn-create-group').click()");
    await waitModalTitle(cdp, '新建分组');
    const groupName = `冒烟测试组-${Date.now().toString(36)}`;
    await cdp.evaluate(`(() => {
      const input = document.querySelector('#group-name-input');
      input.value = ${JSON.stringify(groupName)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.modal .modal-footer .btn-primary').click();
      return true;
    })()`);
    await waitNoModal(cdp);
    await waitFor(
      async () =>
        (await cdp.evaluate(`document.querySelector('#group-table-body')?.innerText.includes(${JSON.stringify(groupName)})`)) ===
        true,
      { timeoutMs: NAV_TIMEOUT_MS, intervalMs: 150, label: '分组出现在列表' },
    );
    log('通过：新建分组');

    await cdp.evaluate(
      "[...document.querySelectorAll('#group-table-body button[data-action=\"delete\"]')].at(-1)?.click()",
    );
    await waitModalTitle(cdp, '删除分组');
    await clickModalConfirm(cdp);
    await waitNoModal(cdp);
    await waitFor(
      async () =>
        (await cdp.evaluate(`!document.querySelector('#group-table-body')?.innerText.includes(${JSON.stringify(groupName)})`)) ===
        true,
      { timeoutMs: NAV_TIMEOUT_MS, intervalMs: 150, label: '分组从列表移除' },
    );
    log('通过：删除分组');

    await activateView(cdp, 'app-rules');
    await cdp.evaluate("document.querySelector('#btn-create-rule').click()");
    await waitModalTitle(cdp, '新建规则');
    const ruleFormFields = await cdp.evaluate("document.querySelectorAll('.modal .form-label').length");
    assert(ruleFormFields >= 5, `规则表单字段过少（${ruleFormFields}）`);

    // Markdown 预览回归：微信兼容过滤（中文斜体/H5/H6/图片）+ 有序编号连续 + 缩进嵌套列表 + 裸 URL/尖括号 URL
    const openedPreview = await cdp.evaluate(`(() => {
      const input = document.querySelector('#rule-reply-template');
      if (!input) return false;
      input.value = '1. 第一项\\n   - 子项 A\\n   - 子项 B\\n\\n2. 第二项\\n\\n- 尖括号： <https://gps.example.com/>\\n- 裸链接： https://gps.example.com/\\n\\n##### 五级标题\\n\\n*中文斜体*\\n\\n![图](https://example.com/x.png)';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const modal = Array.from(document.querySelectorAll('.modal')).at(-1);
      const button = Array.from(modal?.querySelectorAll('button') || []).find((node) => node.textContent.trim() === 'Markdown 预览');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert(openedPreview, '规则编辑器缺少 Markdown 预览按钮');
    await waitModalTitle(cdp, 'Markdown 预览');
    const previewStats = JSON.parse(
      await cdp.evaluate(`(() => {
        const modal = Array.from(document.querySelectorAll('.modal')).at(-1);
        const root = modal?.querySelector('.markdown-preview');
        const topList = root?.querySelector('ol');
        const hints = Array.from(modal?.querySelectorAll('.form-hint') || []).map((node) => node.textContent);
        return JSON.stringify({
          ol: root ? root.querySelectorAll('ol').length : -1,
          topLi: topList ? topList.children.length : -1,
          nestedLi: root ? root.querySelectorAll('ol > li > ul > li').length : -1,
          link: root ? root.querySelectorAll('.markdown-link').length : -1,
          text: root ? root.textContent : '',
          hints,
        });
      })()`),
    );
    assert(previewStats.ol === 1, `Markdown 预览有序列表应合并为 1 个 ol（实际 ${previewStats.ol}）`);
    assert(previewStats.topLi === 2, `Markdown 预览有序列表应有 2 项（实际 ${previewStats.topLi}）`);
    assert(previewStats.nestedLi === 2, `Markdown 预览缩进子列表应有 2 项（实际 ${previewStats.nestedLi}）`);
    assert(previewStats.link === 1, `仅裸 URL 应渲染为链接节点（实际 ${previewStats.link} 个）`);
    assert(previewStats.text.includes('<https://gps.example.com/>'), '尖括号 URL 应按原文保留');
    assert(!previewStats.text.includes('#####'), 'H5 标记应被微信规则过滤');
    assert(previewStats.text.includes('五级标题'), 'H5 文字应保留');
    assert(!previewStats.text.includes('*中文斜体*'), '中文斜体星号应被过滤');
    assert(previewStats.text.includes('中文斜体'), '中文斜体文字应保留');
    assert(!previewStats.text.includes('![') && !previewStats.text.includes('x.png'), '图片应被移除');
    assert(previewStats.text.includes('第一项') && previewStats.text.includes('子项 A') && previewStats.text.includes('第二项'), 'Markdown 预览内容不完整');
    assert(previewStats.hints.some((hint) => hint.includes('已按微信渲染规则处理')), '预览应提示微信兼容规则调整');
    log('通过：Markdown 预览微信规则过滤 + 有序编号连续 + 缩进嵌套 + 尖括号/裸 URL');
    await cdp.evaluate("Array.from(document.querySelectorAll('.modal')).at(-1)?.querySelector('.modal-close')?.click()");
    await waitFor(async () => (await cdp.evaluate("document.querySelector('.modal .modal-title')?.textContent || ''")).includes('新建规则'), {
      timeoutMs: NAV_TIMEOUT_MS,
      intervalMs: 100,
      label: 'Markdown 预览关闭回到规则编辑器',
    });

    await cdp.evaluate("document.querySelector('.modal .modal-close').click()");
    await waitNoModal(cdp);
    log(`通过：新建规则编辑器（${ruleFormFields} 个字段标签）`);

    await cdp.evaluate("document.querySelector('button[data-rule-tab=\"schedule\"]')?.click()");
    await cdp.evaluate("document.querySelector('#btn-create-schedule').click()");
    await waitModalTitle(cdp, '新建定时任务');
    const scheduleFormFields = await cdp.evaluate("document.querySelectorAll('.modal .form-label').length");
    assert(scheduleFormFields >= 5, `定时任务表单字段过少（${scheduleFormFields}）`);
    await cdp.evaluate("document.querySelector('.modal .modal-close').click()");
    await waitNoModal(cdp);
    log(`通过：新建定时任务编辑器（${scheduleFormFields} 个字段标签）`);

    await cdp.evaluate("document.querySelector('#btn-logout').click()");
    await waitFor(
      async () => (await cdp.evaluate("!!document.querySelector('#login-view:not([hidden])')")) === true,
      { timeoutMs: NAV_TIMEOUT_MS, intervalMs: 150, label: '登出回到登录页' },
    );
    log('通过：登出');

    // ---- 3. 绑定页与文档页 ----
    for (const [route, marker] of [
      ['/', '#bind-form'],
      ['/docs', '.docs-layout, .docs-shell, article, main'],
    ]) {
      await cdp.navigate(`${baseUrl}${route}`);
      const found = await waitFor(
        async () => (await cdp.evaluate(`!!document.querySelector(${JSON.stringify(marker)})`)) === true,
        { timeoutMs: NAV_TIMEOUT_MS, label: `页面 ${route} 关键元素` },
      );
      assert(found, `页面 ${route} 关键元素缺失`);
      const textLength = await cdp.evaluate('document.body.innerText.trim().length');
      assert(textLength > 50, `页面 ${route} 内容为空`);
      log(`通过：页面 ${route}（文本长度 ${textLength}）`);
    }

    // ---- 4. 文档目录 hash 路由：连续快速点击也必须落在目标 section ----
    await cdp.evaluate(`document.querySelector('#docs-nav a[href="#app-rules"]').click()`);
    await sleep(80);
    await cdp.evaluate(`document.querySelector('#docs-nav a[href="#scheduled-tasks"]').click()`);
    await waitFor(
      async () => (await cdp.evaluate(`location.hash === '#scheduled-tasks'`)) === true,
      { timeoutMs: NAV_TIMEOUT_MS, label: '文档路由 hash' },
    );
    const scheduledTop = await cdp.evaluate(
      `Math.round(document.getElementById('scheduled-tasks').getBoundingClientRect().top)`,
    );
    assert(
      scheduledTop >= 0 && scheduledTop < 260,
      `文档目录「定时通知」路由位置错误（section top=${scheduledTop}）`,
    );
    const activeDocLink = await cdp.evaluate(
      `[...document.querySelectorAll('#docs-nav a.is-active')].map((a) => a.textContent.trim()).join(',')`,
    );
    assert(activeDocLink.includes('定时通知'), `文档目录高亮错误（active=${activeDocLink}）`);
    log('通过：文档目录 hash 路由');
  } catch (err) {
    failures.push(err);
    log(`失败：${err.message}`);
  } finally {
    // 汇总页面错误
    if (cdp && cdp.errors.length > 0) {
      for (const item of cdp.errors) {
        failures.push(new Error(`浏览器错误（${item.kind}）：${item.text}`));
      }
    }
    const cleanup = async (fn, label) => {
      try {
        await fn();
      } catch (err) {
        log(`清理 ${label} 失败：${err.message}`);
      }
    };
    if (cdp) await cleanup(() => cdp.close(), 'CDP');
    if (browser) await cleanup(() => browser.stop(), '浏览器');
    if (app) await cleanup(() => app.stop(), 'app');
  }

  if (failures.length > 0) {
    console.error(`\n[smoke] 失败 ${failures.length} 项：`);
    for (const failure of failures) console.error(`  - ${failure.message}`);
    if (app) {
      console.error('\n----- app 日志（尾部）-----');
      console.error(app.output().slice(-3000));
    }
    return 1;
  }
  log('全部通过 ✅');
  return 0;
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[smoke] 未预期错误：', err);
    process.exitCode = 1;
  });
