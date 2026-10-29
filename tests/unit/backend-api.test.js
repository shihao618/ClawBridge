/**
 * 后端单元测试：api.js —— 进程内启动 Express 应用做 HTTP 契约测试（无外部网络）。
 *
 * 用不可达的 ILINK_BASE_URL（127.0.0.1:9）验证上游失败时返回明确 5xx JSON；
 * 覆盖健康检查、安全头、静态页、绑定接口、管理后台鉴权/CSRF、推送 API Key、
 * 参数校验、错误格式与 404。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-api-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'api-test-app-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'api-test-admin-password';
process.env.API_TOKEN = 'api-test-token-123456';
process.env.ILINK_LOGIN_BASE_URL = 'http://127.0.0.1:9';
process.env.ILINK_BASE_URL = 'http://127.0.0.1:9';
process.env.LOG_LEVEL = 'silent';

const { createApp } = await import('../../server/src/api.js');
const { closeDb } = await import('../../server/src/db.js');
const store = await import('../../server/src/store.js');

/** @type {import('node:http').Server} */
let server;
let base = '';

before(async () => {
  // 机密仅由 DB 管理：先把测试 env 密码/Token seed 到 DB（等价 bootstrap）
  const { seedTestAdminSecrets } = await import('./backend-test-secrets.js');
  seedTestAdminSecrets();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(method, pathName, { body, rawBody, headers = {}, cookie } = {}) {
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (cookie) requestHeaders.cookie = cookie;
  const response = await fetch(base + pathName, {
    method,
    headers: requestHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(rawBody !== undefined ? { body: rawBody } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function assertErrorShape(result, status, code) {
  assert.equal(result.status, status, result.text);
  assert.ok(result.json?.error, `响应应为错误 JSON：${result.text}`);
  assert.equal(result.json.error.code, code);
  assert.equal(typeof result.json.error.message, 'string');
}

/** 登录并返回 Cookie 请求头。 */
async function loginCookie() {
  const login = await request('POST', '/api/admin/login', { body: { password: 'api-test-admin-password' } });
  assert.equal(login.status, 200, login.text);
  const setCookie = login.headers.get('set-cookie') || '';
  const match = /cb_session=[^;]+/.exec(setCookie);
  assert.ok(match, '登录响应应下发 cb_session Cookie');
  return match[0];
}

test('健康检查 /health 与 /api/health', async () => {
  for (const pathName of ['/health', '/api/health']) {
    const result = await request('GET', pathName);
    assert.equal(result.status, 200);
    assert.equal(result.json.status, 'ok');
    assert.equal(typeof result.json.version, 'string');
    assert.equal(typeof result.json.uptimeMs, 'number');
  }
});

test('安全响应头：nosniff / DENY / no-referrer / CSP', async () => {
  const result = await request('GET', '/health');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(result.headers.get('x-frame-options'), 'DENY');
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  assert.match(result.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.match(result.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(result.headers.get('x-powered-by'), null);
});

test('静态页面：/、/bind、/admin、/docs 与 /assets/*', async () => {
  for (const [pathName, marker] of [
    ['/', 'id="bind-form"'],
    ['/bind', 'id="bind-form"'],
    ['/admin', 'id="login-form"'],
    ['/docs', 'id="docs-nav"'],
  ]) {
    const result = await request('GET', pathName);
    assert.equal(result.status, 200, `${pathName} 应返回 200：${result.text.slice(0, 120)}`);
    assert.match(result.headers.get('content-type') || '', /text\/html/, `${pathName} 应为 HTML`);
    assert.ok(result.text.includes(marker), `${pathName} 应包含页面标记 ${marker}`);
    // 安全头同样作用于页面
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  }
  const css = await request('GET', '/assets/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') || '', /text\/css/);
});

test('API 404 返回统一 JSON 错误', async () => {
  const result = await request('GET', '/api/not-exist');
  assertErrorShape(result, 404, 'NOT_FOUND');
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('绑定接口：上游不可达返回 503 JSON 且不崩溃', async () => {
  const result = await request('POST', '/api/bind/sessions', { body: { displayName: '张三' } });
  assertErrorShape(result, 503, 'UNAVAILABLE');

  // 健康检查仍正常（进程未崩溃）
  const health = await request('GET', '/health');
  assert.equal(health.status, 200);

  // 参数校验：昵称超长
  const tooLong = await request('POST', '/api/bind/sessions', { body: { displayName: 'x'.repeat(41) } });
  assertErrorShape(tooLong, 400, 'BAD_REQUEST');

  // 不存在的会话
  const missing = await request('GET', '/api/bind/sessions/no-such-session?token=abc');
  assertErrorShape(missing, 404, 'NOT_FOUND');
  const verifyMissing = await request('POST', '/api/bind/sessions/no-such-session/verify-code', {
    body: { token: 'abc', code: '1234' },
  });
  assertErrorShape(verifyMissing, 404, 'NOT_FOUND');
});

test('管理后台：登录 / me / 登出 / 未认证 401', async () => {
  assertErrorShape(await request('GET', '/api/admin/overview'), 401, 'UNAUTHORIZED');
  assertErrorShape(await request('POST', '/api/admin/login', { body: { password: 'wrong' } }), 401, 'UNAUTHORIZED');
  assertErrorShape(await request('POST', '/api/admin/login', { body: {} }), 400, 'BAD_REQUEST');

  const unauthMe = await request('GET', '/api/admin/me');
  assert.equal(unauthMe.status, 200);
  assert.equal(unauthMe.json.authenticated, false);

  const login = await request('POST', '/api/admin/login', { body: { password: 'api-test-admin-password' } });
  assert.equal(login.status, 200, login.text);
  assert.equal(login.json.ok, true);
  assert.ok(login.json.expiresAt > Date.now());
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, /cb_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);

  const cookie = /cb_session=[^;]+/.exec(setCookie)[0];
  const me = await request('GET', '/api/admin/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.authenticated, true);
  assert.equal(typeof me.json.expiresAt, 'number');

  const logout = await request('POST', '/api/admin/logout', {
    cookie,
    headers: { 'x-requested-with': 'ClawBridge-Admin' },
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie') || '', /cb_session=/);
});

test('管理后台：写接口必须携带 X-Requested-With', async () => {
  const cookie = await loginCookie();
  const noHeader = await request('POST', '/api/admin/broadcast', { body: { text: 'hello' }, cookie });
  assertErrorShape(noHeader, 403, 'FORBIDDEN');

  const withHeader = await request('POST', '/api/admin/broadcast', {
    body: { text: 'hello' },
    cookie,
    headers: { 'x-requested-with': 'ClawBridge-Admin' },
  });
  assert.equal(withHeader.status, 202, withHeader.text);
  assert.equal(withHeader.json.count, 0);
  assert.deepEqual(withHeader.json.queued, []);
});

test('管理后台：概览 / 用户 / 消息 / 配置字段符合契约且不泄露 Token', async () => {
  const cookie = await loginCookie();

  const overview = await request('GET', '/api/admin/overview', { cookie });
  assert.equal(overview.status, 200);
  for (const key of ['totalUsers', 'activeUsers', 'pausedUsers', 'usersWithContextToken', 'messagesToday', 'queued', 'sending', 'sent', 'failed', 'inboundLast24h']) {
    assert.equal(typeof overview.json.stats[key], 'number', `stats.${key} 应为数字`);
  }
  assert.equal(typeof overview.json.server.version, 'string');
  assert.equal(typeof overview.json.server.uptimeMs, 'number');
  assert.equal(typeof overview.json.server.now, 'number');
  assert.equal(typeof overview.json.server.monitorsRunning, 'number');
  assert.equal(typeof overview.json.server.bindingSessionsActive, 'number');
  assert.equal(overview.json.server.rateLimit.max, 7);

  const users = await request('GET', '/api/admin/users', { cookie });
  assert.equal(users.status, 200);
  assert.equal(typeof users.json.total, 'number');
  assert.ok(Array.isArray(users.json.items));

  const messages = await request('GET', '/api/admin/messages', { cookie });
  assert.equal(messages.status, 200);
  assert.equal(typeof messages.json.total, 'number');
  assert.ok(Array.isArray(messages.json.items));

  const config = await request('GET', '/api/admin/config', { cookie });
  assert.equal(config.status, 200);
  assert.equal(config.json.pushApiEnabled, true);
  assert.equal(typeof config.json.apiTokenPreview, 'string');
  assert.ok(!config.text.includes('api-test-token-123456'), 'config 响应不得包含 API Token 明文');
  assert.equal(typeof config.json.adminPasswordIsDefault, 'boolean');
  assert.equal(config.json.dataDir, dataDir);
  assert.equal(config.json.binding.maxRefreshes, 3);

  // 未知用户
  for (const [method, pathName] of [
    ['GET', '/api/admin/users/u_missing'],
    ['POST', '/api/admin/users/u_missing/messages'],
    ['POST', '/api/admin/users/u_missing/unbind'],
    ['POST', '/api/admin/users/u_missing/reconnect'],
  ]) {
    const result = await request(method, pathName, {
      cookie,
      headers: { 'x-requested-with': 'ClawBridge-Admin' },
      ...(method === 'POST' && pathName.endsWith('/messages') ? { body: { text: 'hi' } } : {}),
    });
    assertErrorShape(result, 404, 'NOT_FOUND');
  }

  // 查询参数校验
  assertErrorShape(await request('GET', '/api/admin/users?status=bogus', { cookie }), 400, 'BAD_REQUEST');
  assertErrorShape(await request('GET', '/api/admin/messages?direction=bogus', { cookie }), 400, 'BAD_REQUEST');
});

test('管理后台：文本校验（空/超长）', async () => {
  const cookie = await loginCookie();
  const headers = { 'x-requested-with': 'ClawBridge-Admin' };
  const empty = await request('POST', '/api/admin/broadcast', { body: { text: '   ' }, cookie, headers });
  assertErrorShape(empty, 400, 'BAD_REQUEST');
  const tooLong = await request('POST', '/api/admin/broadcast', { body: { text: 'x'.repeat(4001) }, cookie, headers });
  assertErrorShape(tooLong, 400, 'BAD_REQUEST');
  const notString = await request('POST', '/api/admin/broadcast', { body: { text: 42 }, cookie, headers });
  assertErrorShape(notString, 400, 'BAD_REQUEST');
});

test('推送 API：API Key 鉴权与契约字段', async () => {
  // 无 Key / 错误 Key → 401
  assertErrorShape(await request('POST', '/api/v1/messages', { body: { to: ['u_x'], text: 'hi' } }), 401, 'UNAUTHORIZED');
  assertErrorShape(
    await request('POST', '/api/v1/messages', {
      body: { to: ['u_x'], text: 'hi' },
      headers: { authorization: 'Bearer wrong-key' },
    }),
    401,
    'UNAUTHORIZED',
  );

  const keyHeaders = { 'x-api-key': 'api-test-token-123456' };
  const users = await request('GET', '/api/v1/users', { headers: keyHeaders });
  assert.equal(users.status, 200);
  assert.deepEqual(users.json.items, []);

  // 未知用户全部无效 → 404 + unknownUserIds
  const unknown = await request('POST', '/api/v1/messages', {
    body: { to: ['u_missing_1', 'u_missing_2'], text: 'hi' },
    headers: keyHeaders,
  });
  assert.equal(unknown.status, 404, unknown.text);
  assert.equal(unknown.json.error.code, 'NOT_FOUND');
  assert.deepEqual(unknown.json.error.details.unknownUserIds, ['u_missing_1', 'u_missing_2']);

  // 参数校验
  assertErrorShape(await request('POST', '/api/v1/messages', { body: { to: [], text: 'hi' }, headers: keyHeaders }), 400, 'BAD_REQUEST');
  assertErrorShape(await request('POST', '/api/v1/messages', { body: { to: ['u'], text: '' }, headers: keyHeaders }), 400, 'BAD_REQUEST');
  assertErrorShape(await request('POST', '/api/v1/messages', { body: { text: 'hi' }, headers: keyHeaders }), 400, 'BAD_REQUEST');

  // 广播（无用户 → accepted 0）
  const broadcast = await request('POST', '/api/v1/broadcast', {
    body: { text: '系统维护通知', onlyBound: true },
    headers: { authorization: 'Bearer api-test-token-123456' },
  });
  assert.equal(broadcast.status, 202, broadcast.text);
  assert.equal(broadcast.json.accepted, 0);
  assert.deepEqual(broadcast.json.queued, []);

  // 不存在的 outboxId
  assertErrorShape(await request('GET', '/api/v1/messages/ob_missing', { headers: keyHeaders }), 404, 'NOT_FOUND');
});

test('请求体校验：非法 JSON / 超过 64KB', async () => {
  const badJson = await request('POST', '/api/admin/login', {
    rawBody: '{bad json',
    headers: { 'content-type': 'application/json' },
  });
  assertErrorShape(badJson, 400, 'BAD_REQUEST');

  const tooLarge = await request('POST', '/api/admin/login', { body: { password: 'x'.repeat(70 * 1024) } });
  assertErrorShape(tooLarge, 400, 'BAD_REQUEST');

  const wrongType = await request('POST', '/api/admin/login', {
    rawBody: 'not json',
    headers: { 'content-type': 'text/plain' },
  });
  assertErrorShape(wrongType, 400, 'BAD_REQUEST');
});

test('契约对齐：admin/v1 入队项包含 userId；outbox 首次成功 attempts=1', async () => {
  const cookie = await loginCookie();
  const created = store.upsertBoundUser({
    wechatUserId: 'wx_api_queued_1',
    displayName: '队列用户',
    ilinkBotId: 'bot_api@im.bot',
    botToken: 'api-queued-bot-token',
    baseUrl: 'https://ilink.example.test',
  });
  const userId = created.user.id;

  const adminSend = await request('POST', `/api/admin/users/${encodeURIComponent(userId)}/messages`, {
    body: { text: '管理端消息' },
    cookie,
    headers: { 'x-requested-with': 'ClawBridge-Admin' },
  });
  assert.equal(adminSend.status, 202, adminSend.text);
  const adminItem = adminSend.json.queued[0];
  assert.equal(adminItem.userId, userId, 'admin queued 项必须带 userId');
  assert.equal(adminItem.status, 'queued');
  assert.match(adminItem.outboxId, /^ob_/);

  const v1Send = await request('POST', '/api/v1/messages', {
    body: { to: [userId], text: '推送消息' },
    headers: { 'x-api-key': 'api-test-token-123456' },
  });
  assert.equal(v1Send.status, 202, v1Send.text);
  assert.equal(v1Send.json.queued[0].userId, userId, 'v1 queued 项必须带 userId');

  // attempts 语义：实际发送尝试次数，首次成功 = 1
  assert.equal(store.markOutboxSending(adminItem.outboxId), true);
  store.markOutboxSent(adminItem.outboxId, { serverMessageId: 'svr_attempts_1' });
  const sentRow = store.getOutbox(adminItem.outboxId);
  assert.equal(sentRow.status, 'sent');
  assert.equal(sentRow.attempts, 1, '首次投递成功 attempts 应为 1');

  const v1Status = await request('GET', `/api/v1/messages/${encodeURIComponent(adminItem.outboxId)}`, {
    headers: { 'x-api-key': 'api-test-token-123456' },
  });
  assert.equal(v1Status.json.status, 'sent');
  assert.equal(v1Status.json.attempts, 1);
});
