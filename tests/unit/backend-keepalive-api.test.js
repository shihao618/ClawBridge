/**
 * 单元测试：api.js 保活开关与字段（docs/KEEPALIVE.md §4）。
 * 进程内 Express 应用 + 临时 DATA_DIR。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-keepalive-api-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'keepalive-api-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'keepalive-api-admin-password';
process.env.API_TOKEN = 'keepalive-api-token-123456';
process.env.ILINK_LOGIN_BASE_URL = 'http://127.0.0.1:9';
process.env.ILINK_BASE_URL = 'http://127.0.0.1:9';
process.env.LOG_LEVEL = 'silent';

const { createApp } = await import('../../server/src/api.js');
const store = await import('../../server/src/store.js');
const { getDb, closeDb } = await import('../../server/src/db.js');

let server;
let base = '';
let cookie = '';
const CSRF = { 'x-requested-with': 'ClawBridge-Admin' };
const API_HEADERS = { 'x-api-key': 'keepalive-api-token-123456' };

before(async () => {
  const { seedTestAdminSecrets } = await import('./backend-test-secrets.js');
  seedTestAdminSecrets();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'keepalive-api-admin-password' }),
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
  return { status: response.status, headers: response.headers, text, json };
}

const adminGet = (pathName) => request('GET', pathName, { headers: { cookie } });
const adminWrite = (method, pathName, body) => request(method, pathName, { body, headers: { cookie, ...CSRF } });
const v1Get = (pathName) => request('GET', pathName, { headers: API_HEADERS });

let seq = 0;
function createUser() {
  seq += 1;
  return store.upsertBoundUser({
    wechatUserId: `wx_ka_api_${seq}`,
    displayName: `保活API用户${seq}`,
    ilinkBotId: `bot_ka_api_${seq}@im.bot`,
    botToken: `ka-api-token-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
}

function assertError(result, status, code) {
  assert.equal(result.status, status, result.text);
  assert.equal(result.json?.error?.code, code, result.text);
}

test('PATCH /api/admin/users/{id}/keepalive：鉴权/校验/开关/用户视图字段', async () => {
  const user = createUser();
  assertError(await request('GET', '/api/admin/users'), 401, 'UNAUTHORIZED');
  assertError(
    await request('PATCH', `/api/admin/users/${encodeURIComponent(user.id)}/keepalive`, {
      body: { enabled: true },
      headers: { cookie },
    }),
    403,
    'FORBIDDEN',
  );

  const enabled = await adminWrite('PATCH', `/api/admin/users/${encodeURIComponent(user.id)}/keepalive`, { enabled: true });
  assert.equal(enabled.status, 200, enabled.text);
  assert.equal(enabled.json.user.id, user.id);
  assert.equal(enabled.json.user.keepaliveEnabled, true);
  assert.equal(enabled.json.user.keepaliveLastSentAt, 0);

  const users = await adminGet('/api/admin/users?status=all&limit=200');
  const listed = users.json.items.find((item) => item.id === user.id);
  assert.equal(listed.keepaliveEnabled, true);
  assert.equal(typeof listed.keepaliveLastSentAt, 'number');

  const disabled = await adminWrite('PATCH', `/api/admin/users/${encodeURIComponent(user.id)}/keepalive`, { enabled: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.user.keepaliveEnabled, false);

  assertError(
    await adminWrite('PATCH', `/api/admin/users/${encodeURIComponent(user.id)}/keepalive`, { enabled: 'yes' }),
    400,
    'BAD_REQUEST',
  );
  assertError(
    await adminWrite('PATCH', `/api/admin/users/${encodeURIComponent(user.id)}/keepalive`, {}),
    400,
    'BAD_REQUEST',
  );
  assertError(await adminWrite('PATCH', '/api/admin/users/u_missing/keepalive', { enabled: true }), 404, 'NOT_FOUND');
});

test('POST /api/admin/groups/{id}/keepalive：批量开关 updated 计数/404/400', async () => {
  const created = await adminWrite('POST', '/api/admin/groups', { name: '保活批量API组' });
  const group = created.json.group;
  const userA = createUser();
  const userB = createUser();
  const userC = createUser();
  for (const user of [userA, userB, userC]) {
    await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(user.id)}/groups`, { groupIds: [group.id] });
  }

  const enabled = await adminWrite('POST', `/api/admin/groups/${group.id}/keepalive`, { enabled: true });
  assert.equal(enabled.status, 200, enabled.text);
  assert.equal(enabled.json.updated, 3);
  assert.equal(enabled.json.group.id, group.id);
  for (const user of [userA, userB, userC]) {
    assert.equal(store.getUser(user.id).keepaliveEnabled, true);
  }

  const disabled = await adminWrite('POST', `/api/admin/groups/${group.id}/keepalive`, { enabled: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.updated, 3);
  assert.equal(store.getUser(userA.id).keepaliveEnabled, false);

  assertError(await adminWrite('POST', '/api/admin/groups/grp_missing/keepalive', { enabled: true }), 404, 'NOT_FOUND');
  assertError(await adminWrite('POST', `/api/admin/groups/${group.id}/keepalive`, { enabled: 1 }), 400, 'BAD_REQUEST');
});

test('config/overview/v1 users/messages.source 字段', async () => {
  const config = await adminGet('/api/admin/config');
  assert.equal(config.status, 200);
  assert.equal(typeof config.json.keepalive.enabled, 'boolean');
  assert.equal(typeof config.json.keepalive.windowMs, 'number');
  assert.equal(typeof config.json.keepalive.leadMs, 'number');
  assert.equal(typeof config.json.keepalive.tickMs, 'number');
  assert.equal(typeof config.json.keepalive.maxPerTick, 'number');
  assert.equal(typeof config.json.keepalive.text, 'string');

  const user = createUser();
  store.setKeepaliveEnabled(user.id, true);
  store.touchInbound(user.id, Date.now() - 60_000);
  const keepaliveOutbox = store.enqueueMessage({ userId: user.id, text: '【保活】请回复', source: 'keepalive' });
  const normalOutbox = store.enqueueMessage({ userId: user.id, text: '普通消息', source: 'api' });

  const overview = await adminGet('/api/admin/overview');
  assert.equal(overview.status, 200);
  assert.equal(typeof overview.json.stats.keepaliveEnabledUsers, 'number');
  assert.equal(typeof overview.json.stats.keepaliveSent24h, 'number');
  assert.ok(overview.json.stats.keepaliveEnabledUsers >= 1);
  assert.ok(overview.json.stats.keepaliveSent24h >= 1);

  // 管理端消息列表 source 字段
  const messages = await adminGet(`/api/admin/messages?direction=outbound&userId=${encodeURIComponent(user.id)}&limit=20`);
  const keepaliveItem = messages.json.items.find((item) => item.id === keepaliveOutbox.id);
  const normalItem = messages.json.items.find((item) => item.id === normalOutbox.id);
  assert.equal(keepaliveItem.source, 'keepalive');
  assert.equal(normalItem.source, 'api');

  // v1 outbox 状态 source 字段
  const v1Status = await v1Get(`/api/v1/messages/${encodeURIComponent(keepaliveOutbox.id)}`);
  assert.equal(v1Status.status, 200);
  assert.equal(v1Status.json.source, 'keepalive');

  // v1 users 带 keepaliveEnabled
  const v1Users = await v1Get('/api/v1/users?status=active&limit=200');
  const v1User = v1Users.json.items.find((item) => item.id === user.id);
  assert.equal(v1User.keepaliveEnabled, true);
});

test('数据库最新 schema：users/groups 保活列存在（v8）', () => {
  const db = getDb();
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));
  assert.ok(columns.has('keepalive_enabled'));
  assert.ok(columns.has('keepalive_last_sent_at'));
  const groupColumns = new Set(db.prepare('PRAGMA table_info(groups)').all().map((row) => row.name));
  assert.ok(groupColumns.has('keepalive_enabled'), 'groups.keepalive_enabled 应存在（schema v6）');
  assert.ok(
    Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'").get()),
    'scheduled_tasks 表应存在（schema v7）',
  );
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '8');
});
