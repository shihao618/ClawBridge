/**
 * ClawBridge e2e 测试环境 helper（黑盒：真实 app 进程 + mock 微信 iLink 进程 + 全 HTTP）。
 *
 * 职责：
 *  - 以随机端口启动 mock/ilink-mock.mjs 与 server/src/index.js；
 *  - app 使用 mkdtemp 临时 DATA_DIR；**机密由 app 首启自动生成**
 *    （DATA_DIR/admin-password.txt、DATA_DIR/api-token.txt，见 docs/SETTINGS.md §8），
 *    启动后读取文件明文存入 e2e.adminPassword / e2e.apiToken，供登录与 API 鉴权使用；
 *    ADMIN_PASSWORD/API_TOKEN 环境变量已废弃且不再读取（e2e 也刻意不注入）；
 *  - 提供 waitFor 轮询（代替固定 sleep）、admin 登录/Cookie、绑定会话、mock 控制面、
 *    outbox/队列等待、message_id 无损断言、失败时打印 app/mock 日志尾部；
 *  - cleanup 杀掉两个子进程（Windows 下 SIGKILL/taskkill 兜底）并删除临时目录
 *    （复用已有 DATA_DIR 时不删除，支持“二次启动”用例）。
 *
 * 用法（每个 e2e 文件一个实例）：
 *   import { before, after } from 'node:test';
 *   import { startE2E } from '../helpers/e2e-env.mjs';
 *   let e2e;
 *   before(async () => { e2e = await startE2E(); });
 *   after(async () => { await e2e?.cleanup(); });
 *
 * 环境变量覆盖：E2E_APP_ENV='{"LOG_LEVEL":"debug"}'（JSON）可附加/覆盖 app 环境变量，便于本地排障。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * APP_SECRET 仍由 env 注入（§7.1 六项之一，e2e 用固定值便于重复启动）。
 * 管理密码 / API Token 不再由 env 提供：app 首启自动生成到 DATA_DIR 文件，
 * 每个实例的明文通过 `e2e.adminPassword` / `e2e.apiToken` 获取。
 */
export const APP_SECRET = 'e2e-app-secret-0123456789abcdef0123456789abcdef';

const ADMIN_WRITE_HEADERS = { 'X-Requested-With': 'ClawBridge-Admin' };

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 轮询等待条件成立；fn 返回 truthy 即返回该值。超时抛出带 label 的错误。 */
export async function waitFor(fn, { timeoutMs = 15000, intervalMs = 50, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const suffix = lastError ? `；最后错误：${lastError.message}` : '';
      throw new Error(`waitFor 超时（${timeoutMs}ms）：${label}${suffix}`);
    }
    await sleep(intervalMs);
  }
}

/** 条件连续满足 samples 次（用于断言“状态稳定/不再变化”）。 */
export async function waitStable(fn, { samples = 4, intervalMs = 80, timeoutMs = 10000, label = '状态稳定' } = {}) {
  let count = 0;
  await waitFor(
    async () => {
      if (await fn()) {
        count += 1;
        return count >= samples;
      }
      count = 0;
      return false;
    },
    { timeoutMs, intervalMs, label },
  );
}

/** 获取一个空闲端口（先监听 127.0.0.1:0 再关闭）。 */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 子进程日志采集器：按行收集 stdout/stderr，保留尾部供失败诊断。 */
function createLogCollector(child, name) {
  const lines = [];
  const listeners = new Set();
  const collector = {
    name,
    lines,
    listeningPort: 0,
    onLine(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    tail(count = 80) {
      return lines.slice(-count).join('\n');
    },
    push(line) {
      lines.push(line);
      if (lines.length > 2000) lines.shift();
      try {
        const parsed = JSON.parse(line);
        if (parsed?.event === 'listening' && Number(parsed.port) > 0) collector.listeningPort = Number(parsed.port);
      } catch {
        /* 非 JSON 行（node warning 等）忽略解析 */
      }
      for (const fn of listeners) {
        try {
          fn(line);
        } catch {
          /* 监听器异常不影响主流程 */
        }
      }
    },
  };
  const wire = (stream) => {
    if (!stream) return;
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (part.trim() !== '') collector.push(part);
      }
    });
    stream.on('end', () => {
      if (buffer.trim() !== '') collector.push(buffer);
      buffer = '';
    });
  };
  wire(child.stdout);
  wire(child.stderr);
  return collector;
}

/** 优雅/强制停止子进程；Windows 下用 taskkill /T /F 兜底确保不留孤儿进程。 */
async function stopProcess(proc, logs, name = 'process') {
  if (!proc) return;
  const isAlive = () => proc.exitCode == null && proc.signalCode == null;
  if (!isAlive()) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  try {
    proc.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  const timedOut = sleep(4000).then(() => true);
  const finished = exited.then(() => false);
  if (await Promise.race([finished, timedOut])) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await Promise.race([exited, sleep(1500)]);
  }
  if (isAlive() && process.platform === 'win32' && proc.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* ignore */
    }
    await Promise.race([exited, sleep(1500)]);
  }
  if (isAlive()) {
    throw new Error(`${name} 无法停止（pid=${proc.pid}）：\n${logs?.tail(60) ?? ''}`);
  }
}

function parseExtraAppEnv() {
  const raw = process.env.E2E_APP_ENV;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('E2E_APP_ENV 必须是合法 JSON 对象');
  }
}

// ---------------------------------------------------------------------------
// 外部 HTTP API mock（接口应用 e2e 用：本进程 node:http，随机端口，可配置响应）
// ---------------------------------------------------------------------------
const DEFAULT_MOCK_API_RESPONSE = Object.freeze({
  status: 200,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: '{"ok":true,"data":{"answer":"MOCK-OK"}}',
});

class MockHttpApi {
  constructor(server) {
    this.server = server;
    this.port = server.address().port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.requests = [];
    this.responseConfig = { ...DEFAULT_MOCK_API_RESPONSE };
  }

  /**
   * 配置响应（可按请求动态返回）。支持字段：
   *  - status：HTTP 状态码（默认 200）
   *  - headers：响应头对象
   *  - body：字符串响应体
   *  - json：对象响应体（自动 JSON.stringify + Content-Type: application/json）
   *  - delayMs：响应前延迟（用于超时用例）
   *  - redirectTo：设置 302 + Location（用于重定向/SSRF 用例）
   * 也可传函数 (request) => config（支持异步）。
   */
  setResponse(config) {
    this.responseConfig = config ?? { ...DEFAULT_MOCK_API_RESPONSE };
    return this;
  }

  /** 清空收到的请求记录（默认保留当前响应配置）。 */
  reset({ keepResponse = true } = {}) {
    this.requests = [];
    if (!keepResponse) this.responseConfig = { ...DEFAULT_MOCK_API_RESPONSE };
    return this;
  }

  get lastRequest() {
    return this.requests[this.requests.length - 1] ?? null;
  }

  requestsFor(pathname) {
    return this.requests.filter((item) => item.pathname === pathname);
  }

  /** 等待收到满足条件的外部 API 请求（返回请求记录）。 */
  waitForRequest(predicate, { timeoutMs = 10000, intervalMs = 40, label = '外部 API 请求' } = {}) {
    const matcher = typeof predicate === 'function' ? predicate : (item) => item.pathname === predicate;
    return waitFor(() => this.requests.find(matcher) ?? null, { timeoutMs, intervalMs, label });
  }

  /** 等待累计收到 count 个请求。 */
  waitForRequestCount(count, { timeoutMs = 10000, intervalMs = 40, label } = {}) {
    return waitFor(() => (this.requests.length >= count ? this.requests.length : null), {
      timeoutMs,
      intervalMs,
      label: label ?? `外部 API 收到 ${count} 个请求`,
    });
  }

  async close() {
    const server = this.server;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      server.close(done);
      server.closeAllConnections?.();
      const timer = setTimeout(done, 1500);
      timer.unref?.();
    });
    this.requests = [];
  }
}

/**
 * 启动本进程内的外部 HTTP API mock（随机端口 127.0.0.1）。
 * @param {{response?: object, host?: string}} [options]
 * @returns {Promise<MockHttpApi>}
 */
export async function startMockApi({ response, host = '127.0.0.1' } = {}) {
  const api = { instance: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let parsedUrl;
      try {
        parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        parsedUrl = new URL('http://127.0.0.1/');
      }
      const record = {
        at: Date.now(),
        method: String(req.method || 'GET').toUpperCase(),
        url: String(req.url || '/'),
        pathname: parsedUrl.pathname,
        query: Object.fromEntries(parsedUrl.searchParams.entries()),
        headers: { ...req.headers },
        body,
        bodyJson: null,
      };
      try {
        record.bodyJson = body === '' ? null : JSON.parse(body);
      } catch {
        record.bodyJson = null;
      }
      api.instance.requests.push(record);

      try {
        const target = api.instance.responseConfig;
        const config = typeof target === 'function' ? await target(record) : target;
        const cfg = config && typeof config === 'object' ? config : DEFAULT_MOCK_API_RESPONSE;
        if (Number(cfg.delayMs) > 0) await sleep(Number(cfg.delayMs));
        const status = Number(cfg.status) || (cfg.redirectTo ? 302 : 200);
        const headers = { ...(cfg.headers ?? {}) };
        let payload = '';
        if (cfg.redirectTo) {
          headers.Location = String(cfg.redirectTo);
          res.writeHead(status, headers);
          res.end();
          return;
        }
        if (cfg.json !== undefined) {
          payload = JSON.stringify(cfg.json);
          if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json; charset=utf-8';
        } else if (cfg.body !== undefined) {
          payload = typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body);
        }
        if (!headers['Content-Type'] && !headers['content-type'] && payload) {
          headers['Content-Type'] = 'text/plain; charset=utf-8';
        }
        res.writeHead(status, headers);
        res.end(payload);
      } catch {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('mock api handler error');
        } catch {
          /* ignore */
        }
      }
    });
    req.on('error', () => {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    });
  });
  server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const mockApi = new MockHttpApi(server);
  api.instance = mockApi;
  if (response !== undefined) mockApi.setResponse(response);
  return mockApi;
}

// 所有活跃实例：测试进程以非 0 退出（有失败用例）时，打印最近实例的 app/mock 日志尾部。
const activeInstances = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', (code) => {
    if (!code) return;
    for (const instance of activeInstances) {
      if (instance.finished) continue;
      try {
        console.error(`\n----- E2E 失败诊断：app 日志尾部（${instance.appUrl}）-----\n${instance.appLogs.tail(80)}`);
        console.error(`----- E2E 失败诊断：mock 日志尾部（${instance.mockUrl}）-----\n${instance.mockLogs.tail(40)}`);
      } catch {
        /* ignore */
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 媒体 aes_key 工具（微信出站 CDNMedia 约定，docs/MEDIA.md）
// ---------------------------------------------------------------------------
/** 微信出站 CDNMedia.aes_key = base64(32 字符 hex key 的 ASCII 字节)（44 字符 base64）。 */
export function b64HexKey(aeskeyHex) {
  return Buffer.from(String(aeskeyHex ?? ''), 'utf8').toString('base64');
}

/**
 * 按接收端逻辑解析出站 media.aes_key：base64 decode → 32 字符 hex → hex decode 得到 16 字节 AES key。
 * @returns {Buffer} 16 字节 key
 */
export function parseOutboundAesKey(aesKeyBase64) {
  const ascii = Buffer.from(String(aesKeyBase64 ?? ''), 'base64').toString('utf8');
  assert.match(ascii, /^[0-9a-f]{32}$/, `出站 aes_key base64 decode 后应为 32 字符 hex，实际=${JSON.stringify(ascii.slice(0, 64))}`);
  const key = Buffer.from(ascii, 'hex');
  assert.equal(key.length, 16, 'hex decode 后应为 16 字节 AES-128 key');
  return key;
}

// ---------------------------------------------------------------------------
// E2E 环境
// ---------------------------------------------------------------------------
class E2E {
  constructor({ appProc, mockProc, appPort, mockPort, dataDir, appLogs, mockLogs, ownsDataDir = true }) {
    this.appProc = appProc;
    this.mockProc = mockProc;
    this.appPort = appPort;
    this.mockPort = mockPort;
    this.appUrl = `http://127.0.0.1:${appPort}`;
    this.mockUrl = `http://127.0.0.1:${mockPort}`;
    this.dataDir = dataDir;
    this.ownsDataDir = ownsDataDir;
    this.appLogs = appLogs;
    this.mockLogs = mockLogs;
    this.adminCookie = '';
    // 首启自动生成的机密明文（startE2E 等文件生成后填入）
    this.adminPassword = '';
    this.apiToken = '';
    this.finished = false;
    activeInstances.add(this);
    installExitHook();
  }

  /** DATA_DIR 下首启自动生成的管理密码文件路径（docs/SETTINGS.md §8）。 */
  get adminPasswordPath() {
    return path.join(this.dataDir, 'admin-password.txt');
  }

  /** DATA_DIR 下首启自动生成的 API Token 文件路径。 */
  get apiTokenPath() {
    return path.join(this.dataDir, 'api-token.txt');
  }

  /** 读取 DATA_DIR 下的机密文件（去首尾空白）。 */
  async readSecretFile(fileName) {
    const raw = await fsp.readFile(path.join(this.dataDir, fileName), 'utf8');
    return raw.trim();
  }

  // ---- HTTP 基础 ----
  /**
   * 通用请求：body 为 JSON（自动序列化）；rawBody 为原始二进制（媒体上传用，需自带 Content-Type）。
   * 响应始终带 buffer（二进制安全），text/json 由 buffer 解码而来。
   */
  async request(method, pathname, { body, rawBody, headers = {}, baseUrl = this.appUrl, timeoutMs = 15000 } = {}) {
    const url = `${baseUrl}${pathname}`;
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (rawBody !== undefined) {
      init.body = rawBody;
    } else if (body !== undefined) {
      if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString('utf8');
    let json = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      /* 二进制/非 JSON 响应：保留 buffer 供断言 */
    }
    return {
      status: res.status,
      headers: res.headers,
      text,
      buffer,
      json,
      setCookies: res.headers.getSetCookie?.() ?? [],
    };
  }

  /** 公开接口请求（无 Cookie）。 */
  api(method, pathname, opts) {
    return this.request(method, pathname, opts);
  }

  // ---- admin ----
  /** 管理员登录并缓存 Cookie；返回登录响应。默认使用首启生成文件中的密码。 */
  async loginAdmin(password = this.adminPassword) {
    const res = await this.request('POST', '/api/admin/login', {
      body: { password },
      headers: ADMIN_WRITE_HEADERS,
    });
    if (res.status === 200) {
      const cookie = res.setCookies.map((item) => item.split(';')[0]).find((item) => item.startsWith('cb_session='));
      assert.ok(cookie, `登录成功但未收到 cb_session Cookie：${res.text}`);
      this.adminCookie = cookie;
    }
    return res;
  }

  /** 管理后台请求：默认带 Cookie；write=true 时附带 CSRF 头。 */
  adminRequest(method, pathname, { body, csrf = false, includeCookie = true, timeoutMs } = {}) {
    const headers = {};
    if (csrf) Object.assign(headers, ADMIN_WRITE_HEADERS);
    if (includeCookie && this.adminCookie) headers.Cookie = this.adminCookie;
    return this.request(method, pathname, { body, headers, timeoutMs });
  }

  adminGet(pathname, opts = {}) {
    return this.adminRequest('GET', pathname, opts);
  }

  adminWrite(method, pathname, body) {
    return this.adminRequest(method, pathname, { body, csrf: true });
  }

  /** 确保已登录（幂等）。 */
  async ensureAdmin() {
    if (this.adminCookie) return;
    const res = await this.loginAdmin();
    assert.equal(res.status, 200, `admin 登录失败：${res.status} ${res.text}`);
  }

  /** GET /api/admin/overview（概览统计，含 keepaliveEnabledUsers/keepaliveSent24h 等） */
  getOverview() {
    return this.adminGet('/api/admin/overview');
  }

  /** GET /api/admin/config（运行配置，含 keepalive/media/rateLimit 等） */
  getConfig() {
    return this.adminGet('/api/admin/config');
  }

  // ---- mock 控制面 ----
  async mockRequest(method, pathname, body) {
    const res = await this.request(method, pathname, { body, baseUrl: this.mockUrl });
    if (!res.headers.get('content-type')?.includes('application/json')) {
      throw new Error(`mock ${method} ${pathname} 非 JSON 响应：${res.status} ${res.text.slice(0, 300)}`);
    }
    if (!res.status.toString().startsWith('2')) {
      throw new Error(`mock ${method} ${pathname} 失败：${res.status} ${res.text.slice(0, 300)}`);
    }
    return res.json;
  }

  mockState() {
    return this.mockRequest('GET', '/__mock/state');
  }

  async mockHealth() {
    return this.mockRequest('GET', '/__mock/health');
  }

  mockScan(qrcode, body = {}) {
    return this.mockRequest('POST', `/__mock/qr/${encodeURIComponent(qrcode)}/scan`, body);
  }

  mockConfirm(qrcode, body = {}) {
    return this.mockRequest('POST', `/__mock/qr/${encodeURIComponent(qrcode)}/confirm`, body);
  }

  mockRequireVerify(qrcode, code) {
    return this.mockRequest('POST', `/__mock/qr/${encodeURIComponent(qrcode)}/require-verify`, { code });
  }

  mockExpire(qrcode) {
    return this.mockRequest('POST', `/__mock/qr/${encodeURIComponent(qrcode)}/expire`, {});
  }

  mockRedirect(qrcode, body = {}) {
    return this.mockRequest('POST', `/__mock/qr/${encodeURIComponent(qrcode)}/redirect`, body);
  }

  mockAlreadyBound(qrcode, body = {}) {
    return this.mockRequest('POST', `/__mock/qr/${encodeURIComponent(qrcode)}/already-bound`, body);
  }

  /** 注入一条入站消息；body 可含 text/context_token/message_id/repeat/item_list。 */
  mockInbound(botId, body) {
    return this.mockRequest('POST', `/__mock/accounts/${encodeURIComponent(botId)}/inbound`, body);
  }

  mockStaleToken(botId) {
    return this.mockRequest('POST', `/__mock/accounts/${encodeURIComponent(botId)}/stale-token`, {});
  }

  mockClearStaleToken(botId) {
    return this.mockRequest('POST', `/__mock/accounts/${encodeURIComponent(botId)}/clear-stale-token`, {});
  }

  mockFailNextSend({ ret = -2, times = 1, botId = null, errmsg = '' } = {}) {
    return this.mockRequest('POST', '/__mock/fail-next-send', { ret, times, botId, errmsg });
  }

  // ---- 媒体（docs/MEDIA.md）----
  /**
   * 管理后台上传媒体（原始二进制 body + Content-Type + URL 编码的 X-File-Name）。
   * @param {Buffer} buffer 文件原始字节
   * @returns 201 {media, limits}
   */
  async uploadAdminMedia(buffer, { fileName = 'file.bin', mime = 'application/octet-stream' } = {}) {
    const headers = {
      'Content-Type': mime,
      'X-File-Name': encodeURIComponent(fileName),
      'X-Requested-With': 'ClawBridge-Admin',
    };
    if (this.adminCookie) headers.Cookie = this.adminCookie;
    return this.request('POST', '/api/admin/media', { rawBody: buffer, headers });
  }

  /** 对外 API 上传媒体（API Key）。 */
  uploadV1Media(buffer, { fileName = 'file.bin', mime = 'application/octet-stream' } = {}) {
    return this.request('POST', '/api/v1/media', {
      rawBody: buffer,
      headers: {
        'Content-Type': mime,
        'X-File-Name': encodeURIComponent(fileName),
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
  }

  /** 读取管理后台媒体（Cookie）；download=true 时带 ?download=1。 */
  getAdminMedia(mediaId, { download = false, headers = {} } = {}) {
    const query = download ? '?download=1' : '';
    const h = { ...headers };
    if (this.adminCookie) h.Cookie = this.adminCookie;
    return this.request('GET', `/api/admin/media/${encodeURIComponent(mediaId)}${query}`, { headers: h });
  }

  /** 读取对外 API 媒体（API Key）。 */
  getV1Media(mediaId, { headers = {} } = {}) {
    return this.request('GET', `/api/v1/media/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${this.apiToken}`, ...headers },
    });
  }

  /** 注入入站媒体：body {kind, fileName, mime, contentBase64, fullUrl?}。 */
  mockInboundMedia(botId, body) {
    return this.mockRequest('POST', `/__mock/accounts/${encodeURIComponent(botId)}/inbound-media`, body);
  }

  /** 等待 mock getuploadurl 记录满足条件（返回 upload 记录）。 */
  waitMockUpload(predicate, { timeoutMs = 15000, label = 'mock upload 记录' } = {}) {
    return waitFor(
      async () => {
        const state = await this.mockState();
        return state.uploads.find(predicate) ?? null;
      },
      { timeoutMs, label },
    );
  }

  /** 等待 mock cdnFiles 记录满足条件。 */
  waitMockCdnFile(predicate, { timeoutMs = 15000, label = 'mock cdnFiles 记录' } = {}) {
    return waitFor(
      async () => {
        const state = await this.mockState();
        return state.cdnFiles.find(predicate) ?? null;
      },
      { timeoutMs, label },
    );
  }

  /** 等待 mock sentMessages 中出现满足条件的媒体 item（返回 sentMessage 记录）。 */
  waitSentItem(predicate, { timeoutMs = 15000, label = 'mock 媒体消息 item' } = {}) {
    return waitFor(
      async () => {
        const state = await this.mockState();
        return state.sentMessages.find((record) => (record.itemList ?? []).some(predicate)) ?? null;
      },
      { timeoutMs, label },
    );
  }

  /** 等待 mock 侧某 media 相关记录（uploads/cdnFiles/sentMessages）出现后返回完整 state。 */
  async waitMockState(predicate, { timeoutMs = 15000, label = 'mock state 条件' } = {}) {
    return waitFor(
      async () => {
        const state = await this.mockState();
        return predicate(state) ? state : null;
      },
      { timeoutMs, label },
    );
  }

  // ---- 用户分组（docs/GROUPS_AND_INBOUND.md §3）----
  /** 管理后台分组列表 → GET /api/admin/groups */
  listGroups() {
    return this.adminGet('/api/admin/groups');
  }

  /** 创建分组 → POST /api/admin/groups（201） */
  createGroup(body) {
    return this.adminWrite('POST', '/api/admin/groups', body);
  }

  /** 更新分组 → PATCH /api/admin/groups/{id} */
  updateGroup(groupId, patch) {
    return this.adminWrite('PATCH', `/api/admin/groups/${encodeURIComponent(groupId)}`, patch);
  }

  /** 删除分组 → DELETE /api/admin/groups/{id}（204） */
  deleteGroup(groupId) {
    return this.adminWrite('DELETE', `/api/admin/groups/${encodeURIComponent(groupId)}`);
  }

  /** 全量替换用户分组归属 → PUT /api/admin/users/{id}/groups {groupIds} */
  assignUserGroups(userId, groupIds) {
    return this.adminWrite('PUT', `/api/admin/users/${encodeURIComponent(userId)}/groups`, { groupIds });
  }

  /** 设置用户分组（语义别名，同 assignUserGroups；便于分组保活用例阅读） */
  setUserGroups(userId, groupIds) {
    return this.assignUserGroups(userId, groupIds);
  }

  /** 用户详情 → GET /api/admin/users/{id}（返回原始响应，含 user.keepaliveEnabled/groups 等） */
  getUser(userId) {
    return this.adminGet(`/api/admin/users/${encodeURIComponent(userId)}`);
  }

  /** 从分组列表中查找分组视图（GroupView，含 keepaliveEnabled），不存在返回 null。 */
  async findGroup(groupId) {
    const res = await this.listGroups();
    assert.equal(res.status, 200, `分组列表查询失败：${res.status} ${res.text}`);
    return (res.json.items ?? []).find((item) => item.id === groupId) ?? null;
  }

  /** 等待用户详情中的 keepaliveEnabled 达到期望值（分组保活继承用例）。 */
  async waitUserKeepalive(userId, expected, { timeoutMs = 8000, label } = {}) {
    return waitFor(
      async () => {
        const res = await this.getUser(userId);
        assert.equal(res.status, 200, `用户详情查询失败：${res.status} ${res.text}`);
        return Boolean(res.json.user?.keepaliveEnabled) === Boolean(expected) ? res.json.user : null;
      },
      { timeoutMs, label: label ?? `用户 ${userId} keepaliveEnabled=${expected}` },
    );
  }

  /** 管理后台用户列表（支持 status/groupId/q/limit/offset 过滤）→ GET /api/admin/users */
  listUsers({ status = '', groupId, q = '', limit = 50, offset = 0 } = {}) {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (groupId !== undefined && groupId !== null && groupId !== '') params.set('groupId', groupId);
    if (q) params.set('q', q);
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const query = params.toString();
    return this.adminGet(`/api/admin/users${query ? `?${query}` : ''}`);
  }

  /** 按分组发送（管理后台）→ POST /api/admin/groups/{id}/messages */
  sendGroupMessage(groupId, { text, mediaId } = {}) {
    const body = {};
    if (text !== undefined) body.text = text;
    if (mediaId !== undefined) body.mediaId = mediaId;
    return this.adminWrite('POST', `/api/admin/groups/${encodeURIComponent(groupId)}/messages`, body);
  }

  // ---- 会话保活（docs/KEEPALIVE.md §4）----
  /** 单用户保活开关 → PATCH /api/admin/users/{id}/keepalive {enabled} */
  setUserKeepalive(userId, enabled) {
    return this.adminWrite('PATCH', `/api/admin/users/${encodeURIComponent(userId)}/keepalive`, { enabled });
  }

  /** 分组批量保活开关 → POST /api/admin/groups/{id}/keepalive {enabled} */
  setGroupKeepalive(groupId, enabled) {
    return this.adminWrite('POST', `/api/admin/groups/${encodeURIComponent(groupId)}/keepalive`, { enabled });
  }

  // ---- 接口应用（docs/API_RULES.md §7）----
  /** 规则列表 → GET /api/admin/app-rules?includeDisabled=1 */
  listAppRules({ includeDisabled = true } = {}) {
    const query = includeDisabled ? '?includeDisabled=1' : '';
    return this.adminGet(`/api/admin/app-rules${query}`);
  }

  /** 创建规则 → POST /api/admin/app-rules（201） */
  createAppRule(body) {
    return this.adminWrite('POST', '/api/admin/app-rules', body);
  }

  /** 规则详情 → GET /api/admin/app-rules/{id} */
  getAppRule(ruleId) {
    return this.adminGet(`/api/admin/app-rules/${encodeURIComponent(ruleId)}`);
  }

  /** 更新规则 → PATCH /api/admin/app-rules/{id} */
  updateAppRule(ruleId, patch) {
    return this.adminWrite('PATCH', `/api/admin/app-rules/${encodeURIComponent(ruleId)}`, patch);
  }

  /** 删除规则 → DELETE /api/admin/app-rules/{id}（204） */
  deleteAppRule(ruleId) {
    return this.adminWrite('DELETE', `/api/admin/app-rules/${encodeURIComponent(ruleId)}`);
  }

  /** 测试运行（dry-run，不发送不写运行日志）→ POST /api/admin/app-rules/{id}/test */
  testAppRule(ruleId, body) {
    return this.adminWrite('POST', `/api/admin/app-rules/${encodeURIComponent(ruleId)}/test`, body);
  }

  /** 规则运行日志 → GET /api/admin/app-rule-logs */
  getAppRuleLogs({ ruleId = '', status = '', userId = '', limit = 50, offset = 0 } = {}) {
    const params = new URLSearchParams();
    if (ruleId) params.set('ruleId', ruleId);
    if (status) params.set('status', status);
    if (userId) params.set('userId', userId);
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const query = params.toString();
    return this.adminGet(`/api/admin/app-rule-logs${query ? `?${query}` : ''}`);
  }

  /** 等待规则运行日志中出现满足条件的记录（返回日志项）。 */
  waitAppRuleLog(predicate, { timeoutMs = 12000, intervalMs = 100, label = '规则运行日志条件', ...query } = {}) {
    return waitFor(
      async () => {
        const res = await this.getAppRuleLogs(query);
        assert.equal(res.status, 200, `规则运行日志查询失败：${res.status} ${res.text}`);
        return (res.json.items ?? []).find(predicate) ?? null;
      },
      { timeoutMs, intervalMs, label },
    );
  }

  // ---- 定时通知（docs/SCHEDULED_TASKS.md §5）----
  /** 定时任务列表 → GET /api/admin/scheduled-tasks */
  listScheduledTasks() {
    return this.adminGet('/api/admin/scheduled-tasks');
  }

  /** 创建定时任务 → POST /api/admin/scheduled-tasks（201） */
  createScheduledTask(body) {
    return this.adminWrite('POST', '/api/admin/scheduled-tasks', body);
  }

  /** 任务详情 → GET /api/admin/scheduled-tasks/{id} */
  getScheduledTask(taskId) {
    return this.adminGet(`/api/admin/scheduled-tasks/${encodeURIComponent(taskId)}`);
  }

  /** 更新任务 → PATCH /api/admin/scheduled-tasks/{id} */
  updateScheduledTask(taskId, patch) {
    return this.adminWrite('PATCH', `/api/admin/scheduled-tasks/${encodeURIComponent(taskId)}`, patch);
  }

  /** 删除任务 → DELETE /api/admin/scheduled-tasks/{id}（204） */
  deleteScheduledTask(taskId) {
    return this.adminWrite('DELETE', `/api/admin/scheduled-tasks/${encodeURIComponent(taskId)}`);
  }

  /** 测试运行（dry-run：真实调用外部接口、渲染通知，不发送、不写运行日志）→ POST /:id/test */
  testScheduledTask(taskId, body = {}) {
    return this.adminWrite('POST', `/api/admin/scheduled-tasks/${encodeURIComponent(taskId)}/test`, body);
  }

  /** 立即执行一次（真实调用并发送、写日志、更新 nextRunAt）→ POST /:id/run */
  runScheduledTask(taskId) {
    return this.adminWrite('POST', `/api/admin/scheduled-tasks/${encodeURIComponent(taskId)}/run`, {});
  }

  /** 任务运行日志 → GET /api/admin/scheduled-task-logs */
  getScheduledTaskLogs({ taskId = '', status = '', limit = 50, offset = 0 } = {}) {
    const params = new URLSearchParams();
    if (taskId) params.set('taskId', taskId);
    if (status) params.set('status', status);
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const query = params.toString();
    return this.adminGet(`/api/admin/scheduled-task-logs${query ? `?${query}` : ''}`);
  }

  /** 等待任务运行日志中出现满足条件的记录（返回日志项）。 */
  waitScheduledTaskLog(predicate, { timeoutMs = 12000, intervalMs = 100, label = '定时任务运行日志条件', ...query } = {}) {
    return waitFor(
      async () => {
        const res = await this.getScheduledTaskLogs(query);
        assert.equal(res.status, 200, `定时任务日志查询失败：${res.status} ${res.text}`);
        return (res.json.items ?? []).find(predicate) ?? null;
      },
      { timeoutMs, intervalMs, label },
    );
  }

  // ---- 运行配置（docs/SETTINGS.md §3，后台可改设置）----
  /** 运行配置（分组字段 + envOnly 脱敏项）→ GET /api/admin/settings */
  getSettings() {
    return this.adminGet('/api/admin/settings');
  }

  /** 修改运行配置字段 → PATCH /api/admin/settings（body 形如 {push:{rateLimitMax:10}}） */
  updateSettings(patch) {
    return this.adminWrite('PATCH', '/api/admin/settings', patch);
  }

  /** 恢复某分组默认值 → POST /api/admin/settings/reset {group} */
  resetSettingsGroup(group) {
    return this.adminWrite('POST', '/api/admin/settings/reset', { group });
  }

  // ---- 运行配置：安全（管理密码 / API Token 后台管理，docs/SETTINGS.md §7.3）----
  /** 修改管理密码 → POST /api/admin/security/password {currentPassword,newPassword} */
  changeAdminPassword({ currentPassword, newPassword }) {
    return this.adminWrite('POST', '/api/admin/security/password', { currentPassword, newPassword });
  }

  /** 恢复环境变量/自动生成的密码 → POST /api/admin/security/password/reset {currentPassword} */
  resetAdminPassword({ currentPassword }) {
    return this.adminWrite('POST', '/api/admin/security/password/reset', { currentPassword });
  }

  /** 重新生成 API Token（明文仅此一次返回）→ POST /api/admin/security/api-token/rotate */
  rotateApiToken() {
    return this.adminWrite('POST', '/api/admin/security/api-token/rotate', {});
  }

  /** 恢复环境变量/文件 API Token → POST /api/admin/security/api-token/reset */
  resetApiToken() {
    return this.adminWrite('POST', '/api/admin/security/api-token/reset', {});
  }

  /** 用指定密码尝试登录（不修改当前缓存的 adminCookie；返回原始响应）。 */
  loginAdminWith(password) {
    return this.request('POST', '/api/admin/login', {
      body: { password },
      headers: ADMIN_WRITE_HEADERS,
    });
  }

  /** 事件列表 → GET /api/admin/events?limit=... */
  getEvents({ limit = 100, offset = 0, type = '' } = {}) {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    if (type) params.set('type', type);
    const query = params.toString();
    return this.adminGet(`/api/admin/events${query ? `?${query}` : ''}`);
  }

  // ---- 对外 API：分组 + 入站消息（docs/GROUPS_AND_INBOUND.md §4）----
  /** GET /api/v1/groups（API Key） */
  getV1Groups({ headers = {}, token = this.apiToken } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    return this.request('GET', '/api/v1/groups', { headers: h });
  }

  /** POST /api/v1/groups/{groupId}/messages（API Key） */
  sendV1GroupMessage(groupId, { text, mediaId } = {}, { headers = {}, token = this.apiToken } = {}) {
    const body = {};
    if (text !== undefined) body.text = text;
    if (mediaId !== undefined) body.mediaId = mediaId;
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    return this.request('POST', `/api/v1/groups/${encodeURIComponent(groupId)}/messages`, { body, headers: h });
  }

  /**
   * GET /api/v1/inbound/messages（返回原始响应，便于断言 400/401/空 items）。
   * @param {{cursor?: string, limit?: number, since?: number|string, userId?: string, groupId?: string,
   *          wait?: number, headers?: object, token?: string, timeoutMs?: number}} [options]
   */
  getV1InboundMessages({ cursor, limit, since, userId, groupId, wait, headers = {}, token = this.apiToken, timeoutMs = 15000 } = {}) {
    const params = new URLSearchParams();
    if (cursor !== undefined && cursor !== null && cursor !== '') params.set('cursor', String(cursor));
    if (limit !== undefined && limit !== null) params.set('limit', String(limit));
    if (since !== undefined && since !== null) params.set('since', String(since));
    if (userId !== undefined && userId !== null && userId !== '') params.set('userId', String(userId));
    if (groupId !== undefined && groupId !== null && groupId !== '') params.set('groupId', String(groupId));
    if (wait !== undefined && wait !== null) params.set('wait', String(wait));
    const query = params.toString();
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    return this.request('GET', `/api/v1/inbound/messages${query ? `?${query}` : ''}`, { headers: h, timeoutMs });
  }

  /** 等待 v1 入站消息查询满足条件（返回响应 json）。 */
  waitV1InboundMessages(predicate, { timeoutMs = 15000, intervalMs = 100, label = 'v1 入站消息条件', ...query } = {}) {
    return waitFor(
      async () => {
        const res = await this.getV1InboundMessages(query);
        assert.equal(res.status, 200, `v1 入站消息查询失败：${res.status} ${res.text}`);
        return predicate(res.json) ? res.json : null;
      },
      { timeoutMs, intervalMs, label },
    );
  }

  /**
   * 按接收端逻辑解密 mock CDN 上的媒体密文（复用出站 aes_key 格式校验）。
   * @param {string} cdnToken media.encrypt_query_param / uploads[].token
   * @param {string} aesKeyBase64 出站 media.aes_key（base64(32 字符 hex key ascii)）
   */
  async decryptMockCdnCiphertext(cdnToken, aesKeyBase64) {
    const res = await this.request('GET', `/cdn/download?encrypted_query_param=${encodeURIComponent(cdnToken)}`, {
      baseUrl: this.mockUrl,
    });
    assert.equal(res.status, 200, `mock CDN 下载密文失败：${res.status} ${res.text.slice(0, 200)}`);
    const decipher = createDecipheriv('aes-128-ecb', parseOutboundAesKey(aesKeyBase64), null);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(res.buffer), decipher.final()]);
  }

  // ---- 绑定流程 ----
  async createBindSession(displayName = 'e2e 用户') {
    const res = await this.request('POST', '/api/bind/sessions', { body: { displayName } });
    assert.equal(res.status, 201, `创建绑定会话应 201，实际 ${res.status}：${res.text}`);
    assert.ok(res.json?.sessionId, '创建绑定会话应返回 sessionId');
    assert.ok(res.json?.token, '创建绑定会话应返回 token');
    assert.ok(res.json?.qr?.svg?.startsWith('data:image/svg+xml;base64,'), 'qr.svg 应为 SVG data URI');
    return res.json;
  }

  getBindSession(sessionId, token) {
    const query = token === undefined ? '' : `?token=${encodeURIComponent(token)}`;
    return this.request('GET', `/api/bind/sessions/${encodeURIComponent(sessionId)}${query}`);
  }

  /** 从会话视图 qr.content 中提取 mock 的 qrcode（不依赖 mock 全局状态，避免测试串扰）。 */
  extractQrcode(sessionView) {
    const content = sessionView?.qr?.content;
    assert.ok(typeof content === 'string' && content !== '', '会话应返回 qr.content');
    const url = new URL(content);
    const qrcode = url.searchParams.get('qrcode');
    assert.ok(qrcode, `qr.content 中应包含 qrcode 参数：${content}`);
    return qrcode;
  }

  /** 轮询绑定会话直到进入给定状态之一，返回最终会话视图。 */
  async waitBindStatus(sessionId, token, statuses, { timeoutMs = 15000, label } = {}) {
    const wanted = new Set(Array.isArray(statuses) ? statuses : [statuses]);
    return waitFor(
      async () => {
        const res = await this.getBindSession(sessionId, token);
        assert.equal(res.status, 200, `查询绑定会话失败：${res.status} ${res.text}`);
        return wanted.has(res.json.status) ? res.json : null;
      },
      { timeoutMs, label: label ?? `绑定会话进入 ${[...wanted].join('/')}` },
    );
  }

  /** 在 mock 快照中查找某用户绑定的 bot 账号（按 ilinkUserId / botId 匹配）。 */
  async findMockAccount(user) {
    const state = await this.mockState();
    return (
      state.accounts.find(
        (account) =>
          account.ilinkUserId === user?.wechatUserId ||
          (user?.ilinkBotId && account.botId === user.ilinkBotId),
      ) ?? null
    );
  }

  /** 等待 mock 账号存在且 notifyStart 已被调用（入站监控已启动）。 */
  async waitMonitorStarted(user, { timeoutMs = 15000 } = {}) {
    return waitFor(
      async () => {
        const account = await this.findMockAccount(user);
        return account && account.notifyStart > 0 ? account : null;
      },
      { timeoutMs, label: `mock 账号 notifyStart（user=${user?.id}）` },
    );
  }

  /**
   * 走完一次扫码绑定：创建会话 → mock scan → mock confirm → 等待 confirmed。
   * @returns {Promise<{created, session, user, qrcode, account}>}
   */
  async bindUser({ displayName = 'e2e 用户', waitMonitor = false } = {}) {
    const created = await this.createBindSession(displayName);
    const qrcode = this.extractQrcode(created);
    await this.mockScan(qrcode);
    await this.mockConfirm(qrcode);
    const session = await this.waitBindStatus(created.sessionId, created.token, 'confirmed');
    assert.ok(session.user?.id, `confirmed 会话应返回 user：${JSON.stringify(session)}`);
    const user = session.user;
    const account = waitMonitor ? await this.waitMonitorStarted(user) : await this.findMockAccount(user);
    return { created, session, user, qrcode, account };
  }

  // ---- 队列 / 出站等待 ----
  /** 等待队列清空（queued=0 且 sending=0 连续稳定）。 */
  async waitQueueDrained({ timeoutMs = 15000 } = {}) {
    await this.ensureAdmin();
    await waitStable(
      async () => {
        const res = await this.adminGet('/api/admin/overview');
        assert.equal(res.status, 200, `overview 失败：${res.status} ${res.text}`);
        return res.json.stats.queued === 0 && res.json.stats.sending === 0;
      },
      { timeoutMs, label: '出站队列清空' },
    );
  }

  /** 等待某 outbox 进入指定状态（默认 sent），返回 /api/v1/messages/{id} 响应体。 */
  async waitOutbox(outboxId, statuses = 'sent', { timeoutMs = 15000 } = {}) {
    const wanted = new Set(Array.isArray(statuses) ? statuses : [statuses]);
    return waitFor(
      async () => {
        const res = await this.request('GET', `/api/v1/messages/${encodeURIComponent(outboxId)}`, {
          headers: { Authorization: `Bearer ${this.apiToken}` },
        });
        assert.equal(res.status, 200, `查询 outbox 失败：${res.status} ${res.text}`);
        return wanted.has(res.json.status) ? res.json : null;
      },
      { timeoutMs, label: `outbox ${outboxId} 进入 ${[...wanted].join('/')}` },
    );
  }

  /** 等待 mock sentMessages 中出现指定文本（返回该条记录；可选过滤 botId）。 */
  async waitSentMessage(text, { botId = null, timeoutMs = 15000 } = {}) {
    return waitFor(
      async () => {
        const state = await this.mockState();
        return state.sentMessages.find((item) => item.text === text && (!botId || item.botId === botId)) ?? null;
      },
      { timeoutMs, label: `mock 收到发送消息 text=${JSON.stringify(text)}` },
    );
  }

  /** 等待 mock 收到指定文本的所有消息均投递完成（返回匹配条数）。 */
  async waitSentMessageCount(text, expected, { timeoutMs = 15000 } = {}) {
    return waitFor(
      async () => {
        const state = await this.mockState();
        const count = state.sentMessages.filter((item) => item.text === text).length;
        return count >= expected ? count : null;
      },
      { timeoutMs, label: `mock 收到 ${expected} 条 text=${JSON.stringify(text)}` },
    );
  }

  /** 统计 mock sentMessages 中文本包含指定子串的条数（可按 botId/toUserId 过滤）。 */
  async countMockSentMessagesContaining(substring, { botId = null, toUserId = null } = {}) {
    const state = await this.mockState();
    return state.sentMessages.filter(
      (item) =>
        typeof item.text === 'string' &&
        item.text.includes(substring) &&
        (!botId || item.botId === botId) &&
        (!toUserId || item.toUserId === toUserId),
    ).length;
  }

  /** 等待 mock sentMessages 中出现文本包含指定子串的消息（返回该条记录；可按 botId/toUserId 过滤）。 */
  waitMockSentMessageContaining(substring, { botId = null, toUserId = null, timeoutMs = 15000, label } = {}) {
    return waitFor(
      async () => {
        const state = await this.mockState();
        return (
          state.sentMessages.find(
            (item) =>
              typeof item.text === 'string' &&
              item.text.includes(substring) &&
              (!botId || item.botId === botId) &&
              (!toUserId || item.toUserId === toUserId),
          ) ?? null
        );
      },
      { timeoutMs, label: label ?? `mock 收到包含 ${JSON.stringify(substring)} 的消息` },
    );
  }

  /** 等待管理后台消息记录中出现某条消息；direction: inbound|outbound|all。 */
  async waitAdminMessage(predicate, { direction = 'all', timeoutMs = 15000, label = '管理后台消息记录' } = {}) {
    await this.ensureAdmin();
    return waitFor(
      async () => {
        const res = await this.adminGet(`/api/admin/messages?direction=${direction}&limit=100`);
        assert.equal(res.status, 200, `消息记录查询失败：${res.status} ${res.text}`);
        return res.json.items.find(predicate) ?? null;
      },
      { timeoutMs, label },
    );
  }

  /**
   * 等待管理后台某条消息的附件全部进入 `status='ready'`。
   *
   * 入站媒体是「消息先入库、附件异步下载」，因此不能用 waitAdminMessage 一看到消息就断言附件字段；
   * 本方法轮询消息记录，直到附件出现且全部 ready（或任一 failed 立即抛错，便于定位 CDN/解密问题）。
   *
   * @param {(message: object) => boolean} messagePredicate 匹配消息记录（如 direction/serverMessageId/attachments）
   * @param {{direction?: 'inbound'|'outbound'|'all', kind?: string, timeoutMs?: number,
   *          intervalMs?: number, label?: string}} [options]
   * @returns {Promise<{message: object, attachments: object[]}>} 消息与（按 kind 过滤后的）ready 附件列表
   */
  async waitAttachmentsReady(
    messagePredicate,
    { direction = 'all', kind = '', timeoutMs = 20000, intervalMs = 100, label = '附件 ready' } = {},
  ) {
    await this.ensureAdmin();
    const deadline = Date.now() + timeoutMs;
    let lastState = '消息或附件尚未出现';
    for (;;) {
      const res = await this.adminGet(`/api/admin/messages?direction=${direction}&limit=100`);
      assert.equal(res.status, 200, `消息记录查询失败：${res.status} ${res.text}`);
      const message = res.json.items.find(messagePredicate);
      if (message) {
        const all = Array.isArray(message.attachments) ? message.attachments : [];
        const attachments = kind ? all.filter((item) => item.kind === kind) : all;
        if (attachments.length > 0) {
          const failed = attachments.find((item) => item.status === 'failed');
          if (failed) {
            throw new Error(
              `等待附件 ready 失败：${failed.fileName || failed.id || '(未命名)'} status=failed error=${failed.error ?? '(无)'}`,
            );
          }
          const pending = attachments.filter((item) => item.status !== 'ready');
          if (pending.length === 0) return { message, attachments };
          lastState = `附件状态 ${pending.map((item) => `${item.id}:${item.status}`).join(', ')}`;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`waitAttachmentsReady 超时（${timeoutMs}ms）：${label}；最后状态：${lastState}`);
      }
      await sleep(intervalMs);
    }
  }

  /** 等待用户详情满足条件（如 hasContextToken）。 */
  async waitUser(userId, predicate, { timeoutMs = 15000, label = '用户详情' } = {}) {
    await this.ensureAdmin();
    return waitFor(
      async () => {
        const res = await this.adminGet(`/api/admin/users/${encodeURIComponent(userId)}`);
        assert.equal(res.status, 200, `用户详情查询失败：${res.status} ${res.text}`);
        return predicate(res.json) ? res.json : null;
      },
      { timeoutMs, label },
    );
  }

  /** 等待 mock 侧某账号被注入的消息出现在管理后台入站记录中。 */
  async waitInboundText(userId, text, { timeoutMs = 15000 } = {}) {
    await this.ensureAdmin();
    return waitFor(
      async () => {
        const res = await this.adminGet(`/api/admin/messages?direction=inbound&userId=${encodeURIComponent(userId)}&limit=100`);
        assert.equal(res.status, 200, `入站消息查询失败：${res.status} ${res.text}`);
        return res.json.items.find((item) => item.text === text) ?? null;
      },
      { timeoutMs, label: `入站消息落库 text=${JSON.stringify(text)}` },
    );
  }

  /** 统计某用户入站消息条数。 */
  async inboundCount(userId) {
    await this.ensureAdmin();
    const res = await this.adminGet(`/api/admin/messages?direction=inbound&userId=${encodeURIComponent(userId)}&limit=200`);
    assert.equal(res.status, 200, `入站消息查询失败：${res.status} ${res.text}`);
    return res.json.total;
  }

  // ---- 清理 ----
  /**
   * 停止 mock/app 并（仅当 DATA_DIR 由本实例创建时）删除临时目录。
   * @param {{keepDataDir?: boolean}} [options] keepDataDir=true 时保留 DATA_DIR（二次启动用例）
   */
  async cleanup({ keepDataDir = false } = {}) {
    if (this.finished) return;
    this.finished = true;
    if (this.appProc) await stopProcess(this.appProc, this.appLogs, 'app');
    this.appProc = null;
    await stopProcess(this.mockProc, this.mockLogs, 'mock');
    this.mockProc = null;
    if (this.ownsDataDir && !keepDataDir) {
      try {
        await fsp.rm(this.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (err) {
        console.warn(`[e2e] 清理临时目录失败（忽略）：${err.message}`);
      }
    }
    activeInstances.delete(this);
  }

  /** 仅停止 app 进程（保留 mock 与 DATA_DIR），用于「二次启动/重启不重新生成机密」用例。 */
  async stopApp() {
    if (!this.appProc) return;
    await stopProcess(this.appProc, this.appLogs, 'app');
    this.appProc = null;
  }

  /** 手动打印日志尾部（排障用）。 */
  dumpLogs({ appLines = 80, mockLines = 40 } = {}) {
    console.error(`----- app 日志尾部 -----\n${this.appLogs.tail(appLines)}`);
    console.error(`----- mock 日志尾部 -----\n${this.mockLogs.tail(mockLines)}`);
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
const BASE_APP_ENV = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  APP_SECRET,
  LOG_LEVEL: 'error',
  BINDING_POLL_GAP_MS: '50',
  BINDING_IP_LIMIT_PER_HOUR: '1000',
  RATE_LIMIT_MAX: '100',
  RATE_LIMIT_WINDOW_MS: '60000',
  PUSH_RETRY_DELAYS_MS: '80,150,300',
  DISPATCH_TICK_MS: '50',
  MONITOR_LONGPOLL_TIMEOUT_MS: '1000',
  MAX_TEXT_LENGTH: '4000',
  COOKIE_SECURE: 'false',
  TRUST_PROXY: 'false',
  // 接口应用（docs/API_RULES.md）：e2e 外部 API mock 在 127.0.0.1，需放行白名单；
  // 无规则的常规 e2e 不受影响（没有规则即不触发）。
  APP_RULES_ENABLED: '1',
  APP_RULES_ALLOWED_HOSTS: '127.0.0.1,localhost',
  // 定时通知（docs/SCHEDULED_TASKS.md）：e2e 用「立即执行」验证链路，tick 调小便于调度器启动；
  // 任务 interval 最小 60s，测试期间不会自动触发，避免干扰。
  SCHEDULER_ENABLED: '1',
  SCHEDULER_TICK_MS: '1000',
  SCHEDULER_TIMEZONE: 'Asia/Shanghai',
};

/**
 * 启动 mock + app 并等待健康检查通过，随后读取首启自动生成的机密文件。
 * @param {{appEnv?: object, mockEnv?: object, dataDir?: string}} [options]
 *   dataDir 传入已有目录时复用（用于重启/二次启动用例），cleanup 不会删除该目录。
 * @returns {Promise<E2E>}
 */
export async function startE2E({ appEnv = {}, mockEnv = {}, dataDir: reuseDataDir = null } = {}) {
  const ownsDataDir = !reuseDataDir;
  const dataDir = reuseDataDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'clawbridge-e2e-')));

  // 1) mock
  const mockProc = spawn(process.execPath, [path.join(REPO_ROOT, 'mock', 'ilink-mock.mjs')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      MOCK_QUIET: '1',
      MOCK_AUTO_CONFIRM_MS: '0',
      MOCK_QR_POLL_MS: '150',
      MOCK_LONGPOLL_MS: '300',
      MOCK_LONGPOLLING_TIMEOUT_MS: '1000',
      MOCK_QR_TTL_MS: '300000',
      MOCK_VERIFY_MAX_ATTEMPTS: '3',
      ...mockEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  mockProc.on('error', () => {});
  const mockLogs = createLogCollector(mockProc, 'mock-ilink');

  const mockPort = await waitFor(() => (mockLogs.listeningPort > 0 ? mockLogs.listeningPort : null), {
    timeoutMs: 15000,
    label: 'mock 启动 listening',
  }).catch((err) => {
    throw new Error(`${err.message}\n--- mock 日志 ---\n${mockLogs.tail(40)}`);
  });
  const mockUrl = `http://127.0.0.1:${mockPort}`;

  // 2) app
  const appPort = await getFreePort();
  const appProc = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'src', 'index.js')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...BASE_APP_ENV,
      ...parseExtraAppEnv(),
      PORT: String(appPort),
      DATA_DIR: dataDir,
      ILINK_LOGIN_BASE_URL: mockUrl,
      ILINK_BASE_URL: mockUrl,
      // mock CDN 的下载路径为 /cdn/download?encrypted_query_param=…；
      // 后端按 `{ILINK_CDN_BASE_URL}/download?…` 拼 URL，因此 base 需带 /cdn 后缀。
      ILINK_CDN_BASE_URL: `${mockUrl}/cdn`,
      ...appEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  appProc.on('error', () => {});
  const appLogs = createLogCollector(appProc, 'app');
  const appUrl = `http://127.0.0.1:${appPort}`;

  const e2e = new E2E({ appProc, mockProc, appPort, mockPort, dataDir, appLogs, mockLogs, ownsDataDir });

  try {
    await waitFor(
      async () => {
        if (appProc.exitCode != null || appProc.signalCode != null) {
          throw new Error(`app 进程提前退出（code=${appProc.exitCode}, signal=${appProc.signalCode}）`);
        }
        try {
          const res = await fetch(`${appUrl}/health`, { signal: AbortSignal.timeout(1000) });
          return res.ok;
        } catch {
          return null;
        }
      },
      { timeoutMs: 20000, label: 'app /health 就绪' },
    );
    // 首启自动生成的机密文件（docs/SETTINGS.md §8）：读取明文供登录/API 鉴权使用
    e2e.adminPassword = await waitFor(() => e2e.readSecretFile('admin-password.txt').catch(() => null), {
      timeoutMs: 10000,
      label: 'admin-password.txt 首启生成',
    });
    e2e.apiToken = await waitFor(() => e2e.readSecretFile('api-token.txt').catch(() => null), {
      timeoutMs: 10000,
      label: 'api-token.txt 首启生成',
    });
    assert.ok(e2e.adminPassword.length > 0, 'admin-password.txt 不应为空');
    assert.ok(e2e.apiToken.length > 0, 'api-token.txt 不应为空');
  } catch (err) {
    await e2e.cleanup();
    throw new Error(`${err.message}\n--- app 日志 ---\n${appLogs.tail(60)}`);
  }
  return e2e;
}

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------
/** 断言 message_id 是 >2^53 的无损字符串（mock 以 JSON number 返回，app 应转为字符串保存）。 */
export function assertBigMessageId(value, label = 'message_id') {
  assert.equal(typeof value, 'string', `${label} 应为字符串（无损保存），实际类型 ${typeof value}（值 ${value}）`);
  assert.match(value, /^\d+$/, `${label} 应为十进制数字字符串，实际 ${value}`);
  const bigint = BigInt(value);
  assert.ok(bigint > 2n ** 53n, `${label}=${value} 应大于 2^53`);
  return bigint;
}

export default {
  startE2E,
  startMockApi,
  waitFor,
  waitStable,
  sleep,
  getFreePort,
  assertBigMessageId,
  b64HexKey,
  parseOutboundAesKey,
};
