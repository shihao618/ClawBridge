/**
 * 单元测试：运行配置管理端 API（docs/SETTINGS.md §3）。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-settings-api-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'settings-api-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'settings-api-admin-password';
process.env.API_TOKEN = 'settings-api-token-123456';
process.env.ILINK_LOGIN_BASE_URL = 'http://127.0.0.1:9';
process.env.ILINK_BASE_URL = 'http://127.0.0.1:9';
process.env.LOG_LEVEL = 'silent';

const { createApp } = await import('../../server/src/api.js');
const { config } = await import('../../server/src/config.js');
const { all, get, closeDb } = await import('../../server/src/db.js');

let server;
let base = '';
let cookie = '';
const CSRF = { 'x-requested-with': 'ClawBridge-Admin' };

before(async () => {
  const { seedTestAdminSecrets } = await import('./backend-test-secrets.js');
  seedTestAdminSecrets();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'settings-api-admin-password' }),
  });
  assert.equal(login.status, 200);
  cookie = /cb_session=[^;]+/.exec(login.headers.get('set-cookie') || '')[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(method, pathName, { body, headers = {} } = {}) {
  const response = await fetch(base + pathName, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

const adminGet = (pathName) => request('GET', pathName, { headers: { cookie } });
const adminWrite = (method, pathName, body) => request(method, pathName, { body, headers: { cookie, ...CSRF } });

function assertError(result, status, code) {
  assert.equal(result.status, status, result.text);
  assert.equal(result.json?.error?.code, code, result.text);
}

const defaultOf = (view, groupKey, fieldKey) =>
  view.groups.find((group) => group.key === groupKey).fields.find((field) => field.key === fieldKey).default;

test('GET /api/admin/settings：401/200、10 分组、envOnly 仅 6 项、security 无明文', async () => {
  assertError(await request('GET', '/api/admin/settings'), 401, 'UNAUTHORIZED');

  const result = await adminGet('/api/admin/settings');
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(
    result.json.groups.map((group) => group.key),
    ['push', 'keepalive', 'appRules', 'scheduler', 'media', 'binding', 'server', 'security', 'ilink', 'monitor'],
  );
  assert.deepEqual(
    result.json.envOnly.map((item) => item.key),
    ['APP_SECRET', 'DATA_DIR', 'MEDIA_DIR', 'PORT', 'HOST', 'NODE_ENV'],
  );
  assert.equal(typeof result.json.security, 'object');
  assert.ok(['db', 'env', 'auto'].includes(result.json.security.adminPasswordSource));
  assert.ok(['db', 'env', 'auto'].includes(result.json.security.apiTokenSource));
  assert.equal(typeof result.json.security.pushApiEnabled, 'boolean');
  assert.equal(typeof result.json.security.sessionTtlMs, 'number');

  // 不得泄漏任何机密明文/哈希
  assert.ok(!result.text.includes(config.secrets.adminPassword), '不得泄漏 ADMIN_PASSWORD');
  assert.ok(!result.text.includes(config.secrets.apiToken), '不得泄漏 API_TOKEN');
  assert.ok(!result.text.includes(config.secrets.appSecret), '不得泄漏 APP_SECRET');
  assert.ok(!/scrypt\$/.test(result.text), '不得泄漏密码哈希');
});

test('PATCH /api/admin/settings：401/403(CSRF)/400 校验', async () => {
  assertError(await request('PATCH', '/api/admin/settings', { body: { keepalive: { enabled: false } } }), 401, 'UNAUTHORIZED');
  // 有 Cookie 但缺 CSRF header
  assertError(
    await request('PATCH', '/api/admin/settings', { body: { keepalive: { enabled: false } }, headers: { cookie } }),
    403,
    'FORBIDDEN',
  );

  const invalid = [
    [{}, '至少提交'],
    [{ nope: { x: 1 } }, '未知配置分组'],
    [{ keepalive: { nope: 1 } }, '未知配置字段'],
    [{ keepalive: { enabled: 'yes' } }, 'boolean'],
    [{ push: { rateLimitMax: 0 } }, '之间'],
    [{ scheduler: { timezone: 'Bad/Zone' } }, 'IANA'],
    [{ appRules: { allowedHosts: 'http://bad host' } }, '非法主机名'],
    [{ media: { maxBytes: 1 } }, '之间'],
  ];
  for (const [body, snippet] of invalid) {
    const result = await adminWrite('PATCH', '/api/admin/settings', body);
    assertError(result, 400, 'BAD_REQUEST');
    assert.match(result.json.error.message || result.text, new RegExp(snippet));
  }
});

test('PATCH 成功：持久化 + 立即生效 + restartRequired + GET 反映', async () => {
  const before = await adminGet('/api/admin/settings');
  const keepaliveTextDefault = defaultOf(before.json, 'keepalive', 'text');

  const result = await adminWrite('PATCH', '/api/admin/settings', {
    keepalive: { enabled: false, text: 'API 自定义保活 {name}' },
    appRules: { allowedHosts: '127.0.0.1, 192.168.88.10' },
    scheduler: { maxRecipients: 66 },
    media: { maxBytes: 6 * 1024 * 1024 },
  });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.restartRequired, ['media.maxBytes']);

  // config 立即生效
  assert.equal(config.keepalive.enabled, false);
  assert.equal(config.keepalive.text, 'API 自定义保活 {name}');
  assert.deepEqual(config.appRules.allowedHosts, ['127.0.0.1', '192.168.88.10']);
  assert.equal(config.scheduler.maxRecipients, 66);
  assert.equal(config.media.outboundMaxBytes, 6 * 1024 * 1024);

  // DB 持久化
  const row = get("SELECT value FROM app_settings WHERE key = 'keepalive.text'");
  assert.equal(JSON.parse(row.value), 'API 自定义保活 {name}');

  // GET 反映新值
  const after = await adminGet('/api/admin/settings');
  const keepalive = after.json.groups.find((group) => group.key === 'keepalive');
  assert.equal(keepalive.fields.find((field) => field.key === 'text').value, 'API 自定义保活 {name}');
  assert.equal(keepalive.fields.find((field) => field.key === 'text').default, keepaliveTextDefault);

  // events 只记录字段名，不记录值（尤其文本/机密）
  const events = all("SELECT detail FROM events WHERE type = 'settings_update' ORDER BY id DESC");
  assert.ok(events.length >= 1);
  assert.match(events[0].detail, /keepalive\.text/);
  assert.ok(!events[0].detail.includes('API 自定义保活'), 'events 不得包含配置值');
  assert.ok(!events[0].detail.includes(config.secrets.apiToken), 'events 不得包含 API_TOKEN');
});

test('POST /api/admin/settings/reset：恢复默认 + 删除覆盖 + 校验', async () => {
  const current = await adminGet('/api/admin/settings');
  const defaultEnabled = defaultOf(current.json, 'keepalive', 'enabled');
  const defaultText = defaultOf(current.json, 'keepalive', 'text');
  await adminWrite('PATCH', '/api/admin/settings', { keepalive: { enabled: !defaultEnabled, text: '临时文案' } });
  assert.notEqual(config.keepalive.enabled, defaultEnabled);

  assertError(await adminWrite('POST', '/api/admin/settings/reset', {}), 400, 'BAD_REQUEST');
  assertError(await adminWrite('POST', '/api/admin/settings/reset', { group: 'nope' }), 400, 'BAD_REQUEST');
  assertError(
    await request('POST', '/api/admin/settings/reset', { body: { group: 'keepalive' }, headers: { cookie } }),
    403,
    'FORBIDDEN',
  );

  const result = await adminWrite('POST', '/api/admin/settings/reset', { group: 'keepalive' });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.ok, true);
  assert.equal(config.keepalive.enabled, defaultEnabled);
  assert.equal(config.keepalive.text, defaultText);
  assert.equal(all("SELECT key FROM app_settings WHERE key LIKE 'keepalive.%'").length, 0);

  const after = await adminGet('/api/admin/settings');
  const keepalive = after.json.groups.find((group) => group.key === 'keepalive');
  assert.equal(keepalive.fields.find((field) => field.key === 'text').value, defaultText);
});

test('POST /api/admin/system/restart：401/403 + 非生产容器环境 409（不会杀测试进程）', async () => {
  assertError(await request('POST', '/api/admin/system/restart'), 401, 'UNAUTHORIZED');
  assertError(
    await request('POST', '/api/admin/system/restart', { headers: { cookie } }),
    403,
    'FORBIDDEN',
  );
  const result = await adminWrite('POST', '/api/admin/system/restart');
  assert.equal(result.status, 409, result.text);
  assert.equal(result.json.error.code, 'CONFLICT');
});
