/**
 * 单元测试：DB-only 机密管理（无 env 回退）+ 首次启动引导 bootstrapSecrets。
 * docs/SETTINGS.md §7/§8（task-44）。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-settings-security-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'settings-security-secret-0123456789abcdef0123456789abcdef';
// 故意设置 env 机密：bootstrap 必须忽略它们（无 env 回退）
process.env.ADMIN_PASSWORD = 'env-should-be-ignored-pass';
process.env.API_TOKEN = 'env-should-be-ignored-token';
process.env.ILINK_LOGIN_BASE_URL = 'http://127.0.0.1:9';
process.env.ILINK_BASE_URL = 'http://127.0.0.1:9';
process.env.LOG_LEVEL = 'silent';

const settings = await import('../../server/src/settings.js');
const auth = await import('../../server/src/auth.js');
const crypto = await import('../../server/src/crypto.js');
const { config } = await import('../../server/src/config.js');
const { logger, setLogLevel } = await import('../../server/src/logger.js');
const { all, get, run, closeDb } = await import('../../server/src/db.js');
const { createApp } = await import('../../server/src/api.js');

const ENV_PASSWORD = 'env-should-be-ignored-pass';
const ENV_TOKEN = 'env-should-be-ignored-token';

// 启动流程模拟：loadOverrides → bootstrapSecrets（与 index.js 一致）
settings.loadOverrides();
const bootstrap = settings.bootstrapSecrets();
const passwordFile = path.join(dataDir, 'admin-password.txt');
const tokenFile = path.join(dataDir, 'api-token.txt');
const filePassword = () => fs.readFileSync(passwordFile, 'utf8').trim();
const fileToken = () => fs.readFileSync(tokenFile, 'utf8').trim();

let server;
let base = '';
let cookie = '';
const CSRF = { 'x-requested-with': 'ClawBridge-Admin' };

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
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

async function login(password) {
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  await response.text();
  return {
    status: response.status,
    cookie: /cb_session=[^;]+/.exec(response.headers.get('set-cookie') || '')?.[0] ?? '',
  };
}

const adminGet = (pathName) => request('GET', pathName, { headers: { cookie } });
const adminWrite = (method, pathName, body) => request(method, pathName, { body, headers: { cookie, ...CSRF } });

test('crypto.hashPassword/verifyPassword：scrypt 自描述格式、随机 salt、错误拒绝', () => {
  const record = crypto.hashPassword('正确密码-123');
  assert.match(record, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.ok(!record.includes('正确密码-123'));
  assert.equal(crypto.verifyPassword('正确密码-123', record), true);
  assert.equal(crypto.verifyPassword('错误密码', record), false);
  assert.equal(crypto.verifyPassword('正确密码-123', 'not-a-record'), false);
  assert.equal(crypto.verifyPassword('', record), false);
  assert.notEqual(crypto.hashPassword('same'), crypto.hashPassword('same'));
});

test('bootstrapSecrets：空 DB 生成密码/token 文件与 DB；env 机密被忽略；二次启动不重生成', () => {
  assert.equal(bootstrap.adminPasswordGenerated, true);
  assert.equal(bootstrap.apiTokenGenerated, true);
  assert.ok(fs.existsSync(passwordFile), '应生成 admin-password.txt');
  assert.ok(fs.existsSync(tokenFile), '应生成 api-token.txt');
  assert.ok(filePassword().length >= 8, '初始密码长度应 >= 8');
  assert.match(fileToken(), /^cb_/);

  // env 机密被忽略：env 密码/token 都不生效
  assert.notEqual(filePassword(), ENV_PASSWORD);
  assert.notEqual(fileToken(), ENV_TOKEN);
  assert.equal(auth.verifyAdminPassword(ENV_PASSWORD), false, 'env ADMIN_PASSWORD 不应能登录');
  assert.equal(auth.verifyAdminPassword(filePassword()), true, '文件中的初始密码应可登录');
  assert.equal(config.secrets.apiToken, fileToken(), 'config token 应为 DB/bootstrap token');
  assert.equal(config.pushApiEnabled, true);

  // DB 落库（哈希/密文，无明文）
  const hashRow = get("SELECT value FROM app_settings WHERE key = 'security.adminPasswordHash'");
  const tokenRow = get("SELECT value FROM app_settings WHERE key = 'security.apiTokenEnc'");
  assert.ok(String(hashRow.value).includes('scrypt$'));
  assert.ok(!String(hashRow.value).includes(filePassword()));
  assert.ok(!String(tokenRow.value).includes(fileToken()));
  assert.equal(crypto.decryptSecret(JSON.parse(tokenRow.value)), fileToken());

  // 二次 bootstrap：幂等，不重新生成
  const beforeHash = hashRow.value;
  const beforeToken = tokenRow.value;
  const initialPassword = filePassword();
  const second = settings.bootstrapSecrets();
  assert.equal(second.adminPasswordGenerated, false);
  assert.equal(second.apiTokenGenerated, false);
  assert.equal(get("SELECT value FROM app_settings WHERE key = 'security.adminPasswordHash'").value, beforeHash);
  assert.equal(get("SELECT value FROM app_settings WHERE key = 'security.apiTokenEnc'").value, beforeToken);
  assert.equal(filePassword(), initialPassword, '二次启动不覆盖密码文件');

  const state = settings.getSecurityState();
  assert.equal(state.adminPasswordSource, 'db');
  assert.equal(state.apiTokenSource, 'db');
  assert.ok(!JSON.stringify(state).includes(filePassword()));
  assert.ok(!JSON.stringify(state).includes(fileToken()));
});

test('API：env 密码/token 不可用，文件中的 DB 机密可用；GET settings 不泄漏', async () => {
  assert.equal((await login(ENV_PASSWORD)).status, 401);
  const loggedIn = await login(filePassword());
  assert.equal(loggedIn.status, 200);
  cookie = loggedIn.cookie;

  assert.equal((await request('GET', '/api/v1/users', { headers: { 'x-api-key': ENV_TOKEN } })).status, 401);
  assert.equal((await request('GET', '/api/v1/users', { headers: { 'x-api-key': fileToken() } })).status, 200);

  const view = await adminGet('/api/admin/settings');
  assert.equal(view.status, 200);
  assert.deepEqual(view.json.envOnly.map((item) => item.key), ['APP_SECRET', 'DATA_DIR', 'MEDIA_DIR', 'PORT', 'HOST', 'NODE_ENV']);
  assert.equal(view.json.security.adminPasswordSource, 'db');
  assert.equal(view.json.security.apiTokenSource, 'db');
  assert.ok(!view.text.includes(filePassword()));
  assert.ok(!view.text.includes(fileToken()));
  assert.ok(!/scrypt\$/.test(view.text));
});

test('API：密码 change/reset（reset 生成新随机密码）与 Token rotate/reset', async () => {
  assert.equal((await request('POST', '/api/admin/security/password', { body: {} })).status, 401);
  assert.equal(
    (await request('POST', '/api/admin/security/password', { body: {}, headers: { cookie } })).status,
    403,
  );

  assert.equal(
    (await adminWrite('POST', '/api/admin/security/password', { currentPassword: 'wrong', newPassword: 'new-password-1' })).status,
    401,
  );
  assert.equal(
    (await adminWrite('POST', '/api/admin/security/password', { currentPassword: filePassword(), newPassword: 'short' })).status,
    400,
  );
  const changed = await adminWrite('POST', '/api/admin/security/password', {
    currentPassword: filePassword(),
    newPassword: 'api-new-password-123',
  });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(changed.json.adminPasswordSource, 'db');
  assert.equal((await login('api-new-password-123')).status, 200);
  assert.equal((await login(filePassword())).status, 401, '旧初始密码应失效');

  // reset 密码：生成新的随机密码（明文仅本次返回），并更新文件
  cookie = (await login('api-new-password-123')).cookie;
  const resetPw = await adminWrite('POST', '/api/admin/security/password/reset', { currentPassword: 'api-new-password-123' });
  assert.equal(resetPw.status, 200, resetPw.text);
  assert.equal(resetPw.json.ok, true);
  assert.equal(resetPw.json.source, 'db');
  assert.ok(typeof resetPw.json.password === 'string' && resetPw.json.password.length >= 8);
  assert.notEqual(resetPw.json.password, 'api-new-password-123');
  assert.equal(filePassword(), resetPw.json.password, 'reset 后文件应更新为新密码');
  assert.equal((await login(resetPw.json.password)).status, 200);
  assert.equal((await login('api-new-password-123')).status, 401);
  cookie = (await login(resetPw.json.password)).cookie;

  // Token rotate：旧 token 401 / 新 token 200；reset 再生成新 token
  const oldFileToken = fileToken();
  const rotate = await adminWrite('POST', '/api/admin/security/api-token/rotate', {});
  assert.equal(rotate.status, 200, rotate.text);
  const rotatedToken = rotate.json.token;
  assert.match(rotatedToken, /^cb_/);
  assert.equal(rotate.json.source, 'db');
  assert.equal((await request('GET', '/api/v1/users', { headers: { 'x-api-key': oldFileToken } })).status, 401);
  assert.equal((await request('GET', '/api/v1/users', { headers: { 'x-api-key': rotatedToken } })).status, 200);
  assert.equal(fileToken(), rotatedToken);

  const resetToken = await adminWrite('POST', '/api/admin/security/api-token/reset', {});
  assert.equal(resetToken.status, 200, resetToken.text);
  const newToken = resetToken.json.token;
  assert.match(newToken, /^cb_/);
  assert.equal(resetToken.json.source, 'db');
  assert.notEqual(newToken, rotatedToken);
  assert.equal((await request('GET', '/api/v1/users', { headers: { 'x-api-key': rotatedToken } })).status, 401);
  assert.equal((await request('GET', '/api/v1/users', { headers: { 'x-api-key': newToken } })).status, 200);
  assert.equal(fileToken(), newToken);

  // 事件不含任何机密明文
  const detailText = all("SELECT detail FROM events WHERE type = 'settings_update'").map((row) => row.detail).join('\n');
  for (const secret of [ENV_PASSWORD, ENV_TOKEN, filePassword(), newToken, 'api-new-password-123']) {
    assert.ok(!detailText.includes(secret), `events 不得包含机密：${secret}`);
  }
});

test('新字段校验/映射/restartRequired + logLevel 即时生效', () => {
  const result = settings.updateSettings({
    server: { publicBaseUrl: 'https://bot.example.com/', trustProxy: true, cookieSecure: true, logLevel: 'error' },
    security: { sessionTtlMs: 3600000, pushApiEnabled: true },
    ilink: { loginBaseUrl: 'https://ilink.example.com/', appId: 'my-app', clientVersion: 42 },
    monitor: { longPollTimeoutMs: 30000, maxAccounts: 100 },
    media: { allowedImageMime: 'IMAGE/PNG, image/webp', downloadTimeoutMs: 30000 },
    push: { tickMs: 500 },
    binding: { networkErrorLimit: 7, pollGapMs: 500 },
  });
  assert.equal(result.ok, true);
  assert.ok(result.restartRequired.includes('push.tickMs'));
  assert.ok(result.restartRequired.includes('server.trustProxy'));
  assert.ok(result.restartRequired.includes('ilink.loginBaseUrl'));
  assert.ok(result.restartRequired.includes('monitor.maxAccounts'));
  assert.equal(config.publicBaseUrl, 'https://bot.example.com');
  assert.equal(config.ilink.appId, 'my-app');
  assert.equal(config.monitor.maxAccounts, 100);
  assert.deepEqual(config.media.allowedImageMime, ['image/png', 'image/webp']);
  assert.equal(config.push.tickMs, 500);
  assert.equal(config.binding.networkErrorLimit, 7);

  // logLevel 即时生效
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    logger.child({ mod: 'test' }).info('logLevel-immediate-check');
    assert.equal(writes.length, 0, 'error 级别下 info 不应输出');
    settings.updateSettings({ server: { logLevel: 'info' } });
    logger.child({ mod: 'test' }).info('logLevel-immediate-check');
    assert.ok(writes.some((line) => line.includes('logLevel-immediate-check')));
  } finally {
    process.stdout.write = originalWrite;
    settings.updateSettings({ server: { logLevel: 'silent' } });
  }

  // 非法值 400
  for (const [patch, snippet] of [
    [{ server: { publicBaseUrl: 'ftp://x' } }, 'http/https'],
    [{ server: { publicBaseUrl: 'http://user:pass@x' } }, 'userinfo'],
    [{ server: { logLevel: 'verbose' } }, 'debug/info'],
    [{ ilink: { loginBaseUrl: 'not-a-url' } }, 'URL'],
    [{ monitor: { maxAccounts: 0 } }, '之间'],
    [{ media: { allowedImageMime: 'not-a-mime' } }, 'MIME'],
    [{ binding: { pollGapMs: -1 } }, '之间'],
  ]) {
    assert.throws(
      () => settings.updateSettings(patch),
      (err) => err.code === 'BAD_REQUEST' && err.message.includes(snippet),
    );
  }

  for (const group of ['server', 'security', 'ilink', 'monitor', 'media', 'push', 'binding']) settings.resetGroup(group);
  assert.equal(config.trustProxy, false);
});

test('loadOverrides：新分组映射从 DB 恢复 + logLevel 应用 + 非法值忽略', () => {
  const now = Date.now();
  for (const [key, value] of [
    ['server.logLevel', '"warn"'],
    ['server.publicBaseUrl', '"https://restored.example.com"'],
    ['ilink.appId', '"restored-app"'],
    ['monitor.maxAccounts', '77'],
    ['media.allowedVideoMime', '["video/mp4"]'],
    ['binding.pollGapMs', '250'],
    ['push.tickMs', '500'],
    ['ilink.loginBaseUrl', '"not-a-url"'],
  ]) {
    run(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key,
      value,
      now,
    );
  }
  const result = settings.loadOverrides();
  assert.ok(result.applied >= 5);
  assert.ok(result.ignored >= 1);
  assert.equal(config.logLevel, 'warn');
  assert.equal(config.publicBaseUrl, 'https://restored.example.com');
  assert.equal(config.ilink.appId, 'restored-app');
  assert.equal(config.monitor.maxAccounts, 77);
  assert.deepEqual(config.media.allowedVideoMime, ['video/mp4']);
  assert.equal(config.binding.pollGapMs, 250);
  assert.equal(config.push.tickMs, 500);

  const writes = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    setLogLevel(config.logLevel);
    logger.child({ mod: 'test' }).info('info-should-be-hidden');
    logger.child({ mod: 'test' }).warn('warn-should-show');
    assert.ok(writes.some((line) => line.includes('warn-should-show')));
    assert.ok(!writes.some((line) => line.includes('info-should-be-hidden')));
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    for (const group of ['server', 'ilink', 'monitor', 'media', 'push', 'binding']) settings.resetGroup(group);
  }
});
