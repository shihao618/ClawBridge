/**
 * 后端单元测试：auth.js（临时 DATA_DIR，无网络）。
 * 覆盖管理员密码校验、会话 Cookie 签名/校验、防 CSRF 写头、API Key 常量时间校验、
 * 登录/API Key 内存限流、Cookie 解析。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-auth-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'auth-test-app-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'auth-test-password';
process.env.API_TOKEN = 'auth-test-api-token-abcdef';
process.env.API_RATE_LIMIT_PER_MINUTE = '60';
process.env.LOG_LEVEL = 'silent';

const auth = await import('../../server/src/auth.js');
const { signAdminSession, verifyAdminSession } = await import('../../server/src/crypto.js');

// 机密仅 DB 管理：先验证“无 DB 哈希时一律 false”（env 密码不再回退），再把测试密码 seed 到 DB
const noRecordResult = auth.verifyAdminPassword('auth-test-password');
const { seedTestAdminSecrets } = await import('./backend-test-secrets.js');
seedTestAdminSecrets();

test.after(() => {
  // auth 现在会读取 settings 的 DB 密码哈希（import settings 时打开数据库），先关闭再清理临时目录
  // eslint-disable-next-line global-require
  return import('../../server/src/db.js').then(({ closeDb }) => {
    closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

/** 构造伪造的 Express req（只实现中间件用到的字段）。 */
function fakeReq({ cookie = '', headers = {}, ip = '127.0.0.1' } = {}) {
  const allHeaders = {};
  if (cookie) allHeaders.cookie = cookie;
  for (const [key, value] of Object.entries(headers)) allHeaders[key.toLowerCase()] = value;
  return {
    headers: allHeaders,
    ip,
    get(name) {
      return allHeaders[String(name).toLowerCase()];
    },
  };
}

test('auth: 管理员密码只校验 DB 哈希（无记录 false，env 不回退）', () => {
  assert.equal(noRecordResult, false, 'DB 无哈希时即使 env 密码匹配也必须 false');
  assert.equal(auth.verifyAdminPassword('auth-test-password'), true);
  assert.equal(auth.verifyAdminPassword('wrong-password'), false);
  assert.equal(auth.verifyAdminPassword(''), false);
  assert.equal(auth.verifyAdminPassword(null), false);
  assert.equal(auth.verifyAdminPassword(123456), false);
});

test('auth: 会话 Cookie 生成/校验/篡改/过期', () => {
  const cookieValue = signAdminSession();
  const payload = verifyAdminSession(cookieValue);
  assert.equal(payload.sub, 'admin');
  assert.ok(payload.exp > Date.now());
  assert.equal(verifyAdminSession(`${cookieValue}x`), null, '篡改签名应失效');
  assert.equal(verifyAdminSession(signAdminSession({ ttlMs: -1000 })), null, '过期会话应失效');
  assert.equal(verifyAdminSession(''), null);

  const req = fakeReq({ cookie: `other=1; ${'cb_session'}=${cookieValue}` });
  const session = auth.getAdminSession(req);
  assert.equal(session.sub, 'admin');
  assert.equal(auth.getAdminSession(fakeReq({ cookie: 'cb_session=bogus' })), null);
  assert.equal(auth.getAdminSession(fakeReq()), null);
});

test('auth: Cookie 解析（URL 解码、忽略非法片段）', () => {
  const cookies = auth.parseCookies('a=1; b=hello%20world; broken; =novalue; c=x=y');
  assert.equal(cookies.a, '1');
  assert.equal(cookies.b, 'hello world');
  assert.equal(cookies.c, 'x=y');
  assert.deepEqual({ ...auth.parseCookies('') }, {});
  assert.deepEqual({ ...auth.parseCookies(undefined) }, {});
  assert.deepEqual({ ...auth.parseCookies('bad=%E0%A4%A') }, { bad: '%E0%A4%A' }, '非法编码片段应保留原值且不崩溃');
  assert.equal(auth.readCookie(fakeReq({ cookie: 'x=1; cb_session=abc' })), 'abc');
  assert.equal(auth.readCookie(fakeReq()), null);
});

test('auth: API Key 提取与常量时间校验', () => {
  assert.equal(auth.extractApiKey(fakeReq({ headers: { authorization: 'Bearer auth-test-api-token-abcdef' } })), 'auth-test-api-token-abcdef');
  assert.equal(auth.extractApiKey(fakeReq({ headers: { authorization: 'bearer  spaced-token  ' } })), 'spaced-token');
  assert.equal(auth.extractApiKey(fakeReq({ headers: { 'x-api-key': 'header-key' } })), 'header-key');
  assert.equal(auth.extractApiKey(fakeReq()), '');

  assert.equal(auth.isApiKeyValid('auth-test-api-token-abcdef'), true);
  assert.equal(auth.isApiKeyValid('wrong'), false);
  assert.equal(auth.isApiKeyValid(''), false);
  assert.equal(auth.isApiKeyValid(undefined), false);
});

test('auth: 登录失败按 IP 限流（10 次 / 15 分钟）', () => {
  const ip = '10.0.0.1';
  for (let i = 0; i < 10; i += 1) {
    const result = auth.checkLoginRateLimit(ip);
    assert.equal(result.allowed, true, `第 ${i + 1} 次应允许`);
  }
  assert.throws(
    () => auth.checkLoginRateLimit(ip),
    (err) => err.name === 'AppError' && err.code === 'RATE_LIMITED' && err.status === 429,
  );
  // 其他 IP 不受影响
  assert.equal(auth.checkLoginRateLimit('10.0.0.2').allowed, true);
  auth.loginLimiter.reset(ip);
  assert.equal(auth.checkLoginRateLimit(ip).allowed, true, 'reset 后恢复额度');
});

test('auth: API Key 限流（默认 60 次/分钟）', () => {
  const key = 'hash-of-key-1';
  for (let i = 0; i < 60; i += 1) {
    assert.equal(auth.apiKeyLimiter.hit(key).allowed, true, `第 ${i + 1} 次应允许`);
  }
  const denied = auth.apiKeyLimiter.peek(key);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0);
  assert.equal(auth.apiKeyLimiter.hit('other-key').allowed, true, '不同 key 独立限流');
  auth.apiKeyLimiter.reset(key);
});

test('auth: requireAdmin 中间件（已登录放行 / 未登录 401）', () => {
  const cookieValue = signAdminSession();
  let passed = false;
  auth.requireAdmin(fakeReq({ cookie: `cb_session=${cookieValue}` }), {}, (err) => {
    assert.equal(err, undefined);
    passed = true;
  });
  assert.equal(passed, true);

  let captured = null;
  auth.requireAdmin(fakeReq(), {}, (err) => {
    captured = err;
  });
  assert.ok(captured);
  assert.equal(captured.status, 401);
  assert.equal(captured.code, 'UNAUTHORIZED');
});

test('auth: 写接口防 CSRF 头校验', () => {
  let passError = 'not-called';
  auth.requireWriteHeader(fakeReq({ headers: { 'x-requested-with': 'ClawBridge-Admin' } }), {}, (err) => {
    passError = err;
  });
  assert.equal(passError, undefined, '带正确请求头应放行');

  let captured = null;
  auth.requireWriteHeader(fakeReq({ headers: { 'x-requested-with': 'Other' } }), {}, (err) => {
    captured = err;
  });
  assert.equal(captured.status, 403);
  assert.equal(captured.code, 'FORBIDDEN');

  captured = null;
  auth.requireWriteHeader(fakeReq(), {}, (err) => {
    captured = err;
  });
  assert.equal(captured.status, 403);
});

test('auth: requireAdminWrite = 登录 + CSRF 头', () => {
  const cookieValue = signAdminSession();
  let result = 'pending';
  auth.requireAdminWrite(
    fakeReq({ cookie: `cb_session=${cookieValue}`, headers: { 'x-requested-with': 'ClawBridge-Admin' } }),
    {},
    (err) => {
      result = err;
    },
  );
  assert.equal(result, undefined);

  let captured = null;
  auth.requireAdminWrite(fakeReq({ cookie: `cb_session=${cookieValue}` }), {}, (err) => {
    captured = err;
  });
  assert.equal(captured.status, 403, '已登录但缺 CSRF 头应 403');

  captured = null;
  auth.requireAdminWrite(fakeReq({ headers: { 'x-requested-with': 'ClawBridge-Admin' } }), {}, (err) => {
    captured = err;
  });
  assert.equal(captured.status, 401, '有 CSRF 头但未登录应 401');
});

test('auth: setAdminSessionCookie 下发 HttpOnly/SameSite=Lax Cookie', () => {
  const captured = {};
  const fakeRes = {
    cookie(name, value, options) {
      captured.name = name;
      captured.value = value;
      captured.options = options;
    },
    clearCookie(name, options) {
      captured.clearedName = name;
      captured.clearOptions = options;
    },
  };
  const payload = auth.setAdminSessionCookie(fakeRes);
  assert.equal(captured.name, 'cb_session');
  assert.ok(captured.value.includes('.'));
  assert.equal(captured.options.httpOnly, true);
  assert.equal(captured.options.sameSite, 'lax');
  assert.equal(captured.options.path, '/');
  assert.ok(captured.options.maxAge > 0);
  assert.equal(payload.sub, 'admin');

  auth.clearAdminSessionCookie(fakeRes);
  assert.equal(captured.clearedName, 'cb_session');
  assert.equal(captured.clearOptions.httpOnly, true);
});

test('auth: getClientIp 兜底', () => {
  assert.equal(auth.getClientIp(fakeReq({ ip: '1.2.3.4' })), '1.2.3.4');
  assert.equal(auth.getClientIp({ socket: { remoteAddress: '::1' } }), '::1');
  assert.equal(auth.getClientIp({}), 'unknown');
  assert.equal(auth.getClientIp(undefined), 'unknown');
});
