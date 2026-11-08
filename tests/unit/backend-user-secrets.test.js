/**
 * 后端单元测试：用户级凭据（user_secrets，1.0.0 全新基线）
 *
 * 覆盖：
 * - 加密落库（DB 中看不到明文，fields_enc 为 v1 密文）；
 * - 列表只返回掩码 hints / 字段名 / 元数据（永不回显值）；
 * - getUserSecret 解密字段（仅内部使用）；缺失返回 null；
 * - (user_id,name) upsert：单行、保留 created_at/last_used_at、替换字段；
 * - 删除、批量 touch last_used_at；
 * - 校验（名称/字段名/值长度/字段数/总大小）→ 400 AppError；
 * - 删除用户时外键级联删除凭据行；
 * - HTTP API：401/403/404、PUT/GET/DELETE 往返、响应不回显明文。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test, { after, before } from 'node:test';

import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-user-secrets-',
  env: {
    APP_SECRET: 'user-secrets-test-app-secret-0123456789abcdef0123456789abcdef',
    ADMIN_PASSWORD: 'user-secrets-test-password',
    API_TOKEN: 'user-secrets-test-token-123456',
    ILINK_LOGIN_BASE_URL: 'http://127.0.0.1:9',
    ILINK_BASE_URL: 'http://127.0.0.1:9',
    LOG_LEVEL: 'silent',
  },
});

const userSecrets = await import('../../server/src/data/user-secrets.js');
const { createApp } = await import('../../server/src/api.js');
const store = await import('../../server/src/store.js');
const { get } = await import('../../server/src/db.js');

/** @type {import('node:http').Server} */
let server;
let base = '';

before(async () => {
  const { seedTestAdminSecrets } = await import('../helpers/backend-test-secrets.js');
  seedTestAdminSecrets();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await cleanupUnitEnv(unitEnv);
});

async function request(method, pathName, { body, headers = {}, cookie } = {}) {
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (cookie) requestHeaders.cookie = cookie;
  const response = await fetch(base + pathName, {
    method,
    headers: requestHeaders,
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

function assertErrorShape(result, status, code) {
  assert.equal(result.status, status, result.text);
  assert.ok(result.json?.error, `响应应为错误 JSON：${result.text}`);
  assert.equal(result.json.error.code, code);
}

async function loginCookie() {
  const login = await request('POST', '/api/admin/login', { body: { password: 'user-secrets-test-password' } });
  assert.equal(login.status, 200, login.text);
  const setCookie = login.headers.get('set-cookie') || '';
  const match = /cb_session=[^;]+/.exec(setCookie);
  assert.ok(match, '登录响应应下发 cb_session Cookie');
  return match[0];
}

let userSeq = 0;
function createUser(prefix = 'wx_user_secrets') {
  userSeq += 1;
  return store.upsertBoundUser({
    wechatUserId: `${prefix}_${userSeq}`,
    displayName: `凭据用户${userSeq}`,
    ilinkBotId: `bot_user_secrets_${userSeq}@im.bot`,
    botToken: `token-user-secrets-${userSeq}`,
    baseUrl: 'http://127.0.0.1:9',
  }).user;
}

function countSecrets(userId) {
  return Number(get('SELECT COUNT(*) AS c FROM user_secrets WHERE user_id = ?', userId).c);
}

function assertBadRequest(fn) {
  assert.throws(fn, (err) => err?.status === 400 && err?.code === 'BAD_REQUEST');
}

// ---------------------------------------------------------------------------
// 数据层
// ---------------------------------------------------------------------------

test('加密落库：DB 无明文，fields_enc 为 v1 密文，列表只返回掩码/元数据', () => {
  const user = createUser();
  const item = userSecrets.setUserSecret(user.id, {
    name: 'gps',
    label: 'GPS 定位',
    fields: { token: 'gps-token-ab12', appkey: 'app-key-9999' },
  });

  assert.equal(item.name, 'gps');
  assert.equal(item.label, 'GPS 定位');
  assert.deepEqual(item.fieldNames, ['token', 'appkey']);
  assert.equal(item.hints.token, '••••ab12');
  assert.equal(item.hints.appkey, '••••9999');
  assert.ok(item.createdAt > 0);
  assert.ok(item.updatedAt >= item.createdAt);
  assert.equal(item.lastUsedAt, 0);

  const row = get('SELECT fields_enc, field_names, hints FROM user_secrets WHERE user_id = ? AND name = ?', user.id, 'gps');
  assert.ok(row.fields_enc.startsWith('v1.'), 'fields_enc 应为 AES-256-GCM 密文');
  assert.equal(row.fields_enc.includes('gps-token-ab12'), false, 'DB 中不得出现明文');
  assert.equal(row.fields_enc.includes('app-key-9999'), false);
  assert.equal(JSON.stringify(item).includes('gps-token-ab12'), false, '列表视图不得回显明文');

  const listed = userSecrets.listUserSecrets(user.id);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].fieldNames, ['token', 'appkey']);
  assert.equal(JSON.stringify(listed).includes('gps-token-ab12'), false);
});

test('getUserSecret：返回解密后的字段对象；不存在/空名称返回 null', () => {
  const user = createUser();
  userSecrets.setUserSecret(user.id, {
    name: 'api',
    label: '',
    fields: { key: 'api-key-1234', secret: 'api-secret-5678' },
  });
  assert.deepEqual(userSecrets.getUserSecret(user.id, 'api'), {
    key: 'api-key-1234',
    secret: 'api-secret-5678',
  });
  assert.equal(userSecrets.getUserSecret(user.id, 'missing'), null);
  assert.equal(userSecrets.getUserSecret(user.id, ''), null);
  assert.equal(userSecrets.getUserSecret('u_not_exists', 'api'), null);
});

test('upsert：同 (user_id,name) 单行；保留 created_at/last_used_at；字段整体替换', () => {
  const user = createUser();
  const first = userSecrets.setUserSecret(user.id, {
    name: 'mail',
    label: '旧标签',
    fields: { user: 'old-user', pass: 'old-pass-1111' },
  });
  assert.equal(countSecrets(user.id), 1);
  assert.equal(userSecrets.touchUserSecretsUsed(user.id, ['mail'], 1000), 1);

  const second = userSecrets.setUserSecret(user.id, {
    name: 'mail',
    label: '新标签',
    fields: { token: 'new-token-2222' },
  });
  assert.equal(countSecrets(user.id), 1, 'upsert 不应新增行');
  assert.equal(second.createdAt, first.createdAt, 'upsert 应保留 created_at');
  assert.equal(second.label, '新标签');
  assert.deepEqual(second.fieldNames, ['token']);
  assert.equal(second.lastUsedAt, 1000, 'upsert 应保留 last_used_at');
  assert.deepEqual(userSecrets.getUserSecret(user.id, 'mail'), { token: 'new-token-2222' });
});

test('deleteUserSecret：删除返回 true/false，删除后列表为空', () => {
  const user = createUser();
  userSecrets.setUserSecret(user.id, { name: 'tmp', label: '', fields: { a: 'value-aaaa' } });
  assert.equal(userSecrets.deleteUserSecret(user.id, 'tmp'), true);
  assert.equal(userSecrets.deleteUserSecret(user.id, 'tmp'), false);
  assert.deepEqual(userSecrets.listUserSecrets(user.id), []);
});

test('touchUserSecretsUsed：批量更新 last_used_at，只影响匹配名称，不改变 updated_at', () => {
  const user = createUser();
  userSecrets.setUserSecret(user.id, { name: 'a', label: '', fields: { k: 'a-value-1111' } });
  userSecrets.setUserSecret(user.id, { name: 'b', label: '', fields: { k: 'b-value-2222' } });
  const beforeB = userSecrets.listUserSecrets(user.id).find((item) => item.name === 'b');

  assert.equal(userSecrets.touchUserSecretsUsed(user.id, ['a', 'not-exist'], 5000), 1);
  const after = userSecrets.listUserSecrets(user.id);
  assert.equal(after.find((item) => item.name === 'a').lastUsedAt, 5000);
  assert.equal(after.find((item) => item.name === 'b').lastUsedAt, 0);
  assert.equal(after.find((item) => item.name === 'b').updatedAt, beforeB.updatedAt, 'touch 不应改 updated_at');
  // 兼容 Set（凭据注入链路返回 usedNames:Set）
  assert.equal(userSecrets.touchUserSecretsUsed(user.id, new Set(['b']), 7000), 1);
  assert.equal(userSecrets.listUserSecrets(user.id).find((item) => item.name === 'b').lastUsedAt, 7000);
  assert.equal(userSecrets.touchUserSecretsUsed(user.id, [], 6000), 0);
  assert.equal(userSecrets.touchUserSecretsUsed(user.id, new Set(), 6000), 0);
});

test('校验：非法名称/字段/值/字段数/总大小 → 400 AppError，不落库', () => {
  const user = createUser();
  assertBadRequest(() => userSecrets.setUserSecret(user.id, { name: 'bad name', fields: { a: 'v' } }));
  assertBadRequest(() => userSecrets.setUserSecret(user.id, { name: '', fields: { a: 'v' } }));
  assertBadRequest(() => userSecrets.setUserSecret(user.id, { name: 'ok', fields: {} }));
  assertBadRequest(() => userSecrets.setUserSecret(user.id, { name: 'ok', fields: [] }));
  assertBadRequest(() => userSecrets.setUserSecret(user.id, { name: 'ok', fields: { 'bad field': 'v' } }));
  assertBadRequest(() => userSecrets.setUserSecret(user.id, { name: 'ok', fields: { a: 123 } }));
  assertBadRequest(() => userSecrets.setUserSecret(user.id, { name: 'ok', fields: { a: '' } }));
  assertBadRequest(() =>
    userSecrets.setUserSecret(user.id, { name: 'ok', fields: { a: 'x'.repeat(4097) } }),
  );
  const tooManyFields = {};
  for (let index = 0; index < 21; index += 1) tooManyFields[`f${index}`] = 'v';
  assertBadRequest(() => userSecrets.setUserSecret(user.id, { name: 'ok', fields: tooManyFields }));
  // 每字段合法但总 JSON > 32KB
  const largeFields = {};
  for (let index = 0; index < 9; index += 1) largeFields[`field_${index}`] = 'y'.repeat(4000);
  assertBadRequest(() => userSecrets.setUserSecret(user.id, { name: 'ok', fields: largeFields }));
  assertBadRequest(() => userSecrets.setUserSecret(user.id, { name: 'ok', fields: { a: 'v' }, label: 'x'.repeat(201) }));
  assert.equal(countSecrets(user.id), 0, '非法输入不应落库');
});

test('级联删除：删除用户后 user_secrets 行随外键级联删除', () => {
  const user = createUser();
  userSecrets.setUserSecret(user.id, { name: 'cascade', label: '', fields: { token: 'cascade-token-1' } });
  assert.equal(countSecrets(user.id), 1);
  const deleted = store.deleteUserCascade(user.id);
  assert.equal(deleted.deleted, true);
  assert.equal(countSecrets(user.id), 0, '删除用户后凭据行应级联删除');
});

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

test('API：鉴权/CSRF/404 + PUT/GET/DELETE 往返且不回显明文', async () => {
  const user = createUser('wx_user_secrets_api');
  const path = `/api/admin/users/${encodeURIComponent(user.id)}/secrets`;
  const csrf = { 'x-requested-with': 'ClawBridge-Admin' };

  // 未登录 401；写接口缺少 CSRF 403
  assertErrorShape(await request('GET', path), 401, 'UNAUTHORIZED');
  const cookie = await loginCookie();
  assertErrorShape(await request('PUT', `${path}/city`, { cookie, body: { fields: { token: 'x' } } }), 403, 'FORBIDDEN');

  // 不存在用户 404（读/写/删）
  assertErrorShape(await request('GET', '/api/admin/users/u_not_exists/secrets', { cookie }), 404, 'NOT_FOUND');
  assertErrorShape(
    await request('PUT', '/api/admin/users/u_not_exists/secrets/city', {
      cookie,
      headers: csrf,
      body: { fields: { token: 'x' } },
    }),
    404,
    'NOT_FOUND',
  );
  assertErrorShape(
    await request('DELETE', '/api/admin/users/u_not_exists/secrets/city', { cookie, headers: csrf }),
    404,
    'NOT_FOUND',
  );

  // PUT upsert：响应只含掩码/字段名，不含明文
  const put = await request('PUT', `${path}/city`, {
    cookie,
    headers: csrf,
    body: { label: '城市接口', fields: { token: 'city-token-7788', appkey: 'city-key-6655' } },
  });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.item.name, 'city');
  assert.equal(put.json.item.label, '城市接口');
  assert.deepEqual(put.json.item.fieldNames, ['token', 'appkey']);
  assert.equal(put.json.item.hints.token, '••••7788');
  assert.equal(put.text.includes('city-token-7788'), false, '响应不得回显明文');
  assert.equal(put.text.includes('city-key-6655'), false);

  // GET 列表：只有一条、无明文
  const list = await request('GET', path, { cookie });
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].hints.appkey, '••••6655');
  assert.equal(list.text.includes('city-token-7788'), false);

  // 同 name 再 PUT 为 upsert（仍一条）
  const putAgain = await request('PUT', `${path}/city`, {
    cookie,
    headers: csrf,
    body: { label: '城市接口 v2', fields: { token: 'city-token-9999' } },
  });
  assert.equal(putAgain.status, 200, putAgain.text);
  assert.equal(putAgain.json.item.label, '城市接口 v2');
  assert.deepEqual(putAgain.json.item.fieldNames, ['token']);
  const listAgain = await request('GET', path, { cookie });
  assert.equal(listAgain.json.items.length, 1);

  // 非法输入 400
  assertErrorShape(
    await request('PUT', `${path}/bad name`, {
      cookie,
      headers: csrf,
      body: { fields: { token: 'x' } },
    }),
    400,
    'BAD_REQUEST',
  );
  assertErrorShape(
    await request('PUT', `${path}/city`, { cookie, headers: csrf, body: { fields: {} } }),
    400,
    'BAD_REQUEST',
  );

  // DELETE 204 → 再删 404
  const deleted = await request('DELETE', `${path}/city`, { cookie, headers: csrf });
  assert.equal(deleted.status, 204, deleted.text);
  const empty = await request('GET', path, { cookie });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.items, []);
  assertErrorShape(await request('DELETE', `${path}/city`, { cookie, headers: csrf }), 404, 'NOT_FOUND');
});
