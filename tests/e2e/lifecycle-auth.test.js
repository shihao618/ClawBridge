/**
 * e2e：生命周期 / 鉴权 / 静态页面（黑盒 HTTP）。
 *
 * 覆盖：健康检查与静态页面 200 + 安全响应头；admin 未登录 401 / 错误密码 401 /
 * 正确登录 + Cookie / 写接口 CSRF 头校验 / 登出；API Key 鉴权（Bearer 与 X-Api-Key）；
 * 解绑 → mock notifystop 计数 +1、用户 status=unbound、再发消息被拒；统一错误格式。
 *
 * 依赖 mock/ilink-mock.mjs 控制面；app 为真实子进程。见 tests/helpers/e2e-env.mjs。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startE2E, waitFor } from '../helpers/e2e-env.mjs';

let e2e;

before(async () => {
  e2e = await startE2E();
});

after(async () => {
  await e2e?.cleanup();
});

test('健康检查与静态页面 200：/、/bind、/admin、/docs、/assets/style.css', async () => {
  const health = await e2e.api('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');
  assert.equal(typeof health.json.version, 'string');
  const apiHealth = await e2e.api('GET', '/api/health');
  assert.equal(apiHealth.status, 200);

  const htmlPages = ['/', '/bind', '/admin', '/docs'];
  for (const pathname of htmlPages) {
    const res = await e2e.api('GET', pathname);
    assert.equal(res.status, 200, `GET ${pathname} 应 200，实际 ${res.status}`);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/, `${pathname} 应为 HTML`);
    assert.ok(res.text.length > 200, `${pathname} 页面内容不应为空`);
  }
  const css = await e2e.api('GET', '/assets/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);
  assert.ok(css.text.length > 100);

  // 安全响应头（docs/ARCHITECTURE.md §8）
  const page = await e2e.api('GET', '/');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
});

test('管理后台鉴权：未登录 401、错误密码 401、登录成功、CSRF 写头、登出', async () => {
  // 未登录访问受保护接口
  const noAuth = await e2e.adminRequest('GET', '/api/admin/overview', { includeCookie: false });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.json.error.code, 'UNAUTHORIZED');

  // 错误密码
  const wrong = await e2e.loginAdmin('wrong-password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'UNAUTHORIZED');

  // 缺少密码 → 400
  const missing = await e2e.api('POST', '/api/admin/login', { body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'BAD_REQUEST');

  // 正确密码 + Cookie + /me
  const ok = await e2e.loginAdmin();
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(typeof ok.json.expiresAt, 'number');
  const me = await e2e.adminGet('/api/admin/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.authenticated, true);

  // 概览/配置
  const overview = await e2e.adminGet('/api/admin/overview');
  assert.equal(overview.status, 200);
  assert.equal(typeof overview.json.stats.totalUsers, 'number');
  assert.equal(overview.json.server.version, '1.0.0');
  assert.equal(overview.json.server.ilink.loginBaseUrl, e2e.mockUrl);
  const configRes = await e2e.adminGet('/api/admin/config');
  assert.equal(configRes.status, 200);
  assert.equal(configRes.json.pushApiEnabled, true);
  assert.equal(configRes.json.adminPasswordIsDefault, false);

  // 管理写接口必须带 X-Requested-With（防 CSRF）
  const noCsrf = await e2e.adminRequest('POST', '/api/admin/broadcast', { body: { text: 'noop' } });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error.code, 'FORBIDDEN');
  const withCsrf = await e2e.adminWrite('POST', '/api/admin/broadcast', { text: 'noop' });
  assert.equal(withCsrf.status, 202);
  assert.equal(withCsrf.json.count, 0, '尚无用户时广播 count 应为 0');

  // 登出：无 CSRF 头 403；带 CSRF 头 204 且清除 Cookie
  const logoutNoCsrf = await e2e.adminRequest('POST', '/api/admin/logout');
  assert.equal(logoutNoCsrf.status, 403);
  const logout = await e2e.adminWrite('POST', '/api/admin/logout');
  assert.equal(logout.status, 204);
  assert.ok(
    logout.setCookies.some((item) => item.startsWith('cb_session=') && /Expires=Thu, 01 Jan 1970/i.test(item)),
    '登出应清除 cb_session Cookie',
  );

  // 模拟浏览器丢弃 Cookie 后不再登录
  e2e.adminCookie = '';
  const meAfter = await e2e.adminGet('/api/admin/me');
  assert.equal(meAfter.status, 200);
  assert.equal(meAfter.json.authenticated, false);
  const overviewAfter = await e2e.adminGet('/api/admin/overview');
  assert.equal(overviewAfter.status, 401);

  // 为后续用例重新登录
  const relogin = await e2e.loginAdmin();
  assert.equal(relogin.status, 200);
});

test('API Key 鉴权：Bearer 与 X-Api-Key 均可，错误/缺失 401', async () => {
  const noKey = await e2e.api('GET', '/api/v1/users');
  assert.equal(noKey.status, 401);
  assert.equal(noKey.json.error.code, 'UNAUTHORIZED');

  const wrongKey = await e2e.api('GET', '/api/v1/users', { headers: { Authorization: 'Bearer wrong-token' } });
  assert.equal(wrongKey.status, 401);

  const bearer = await e2e.api('GET', '/api/v1/users', { headers: { Authorization: `Bearer ${e2e.apiToken}` } });
  assert.equal(bearer.status, 200);
  assert.ok(Array.isArray(bearer.json.items));

  const headerKey = await e2e.api('GET', '/api/v1/users', { headers: { 'X-Api-Key': e2e.apiToken } });
  assert.equal(headerKey.status, 200);
});

test('统一错误格式：未知路由 404、非法 JSON 400', async () => {
  const notFound = await e2e.api('GET', '/api/does-not-exist');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.json.error.code, 'NOT_FOUND');
  assert.equal(typeof notFound.json.error.message, 'string');

  const raw = await fetch(`${e2e.appUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-json',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(raw.status, 400);
  const payload = await raw.json();
  assert.equal(payload.error.code, 'BAD_REQUEST');
});

test('解绑：mock notifystop 计数 +1、用户 status=unbound、再发消息被拒', async () => {
  await e2e.ensureAdmin();
  const bound = await e2e.bindUser({ displayName: '解绑用户', waitMonitor: true });
  const { user, account } = bound;

  // 解绑
  const unbind = await e2e.adminWrite('POST', `/api/admin/users/${user.id}/unbind`);
  assert.equal(unbind.status, 200, `解绑应 200：${unbind.status} ${unbind.text}`);
  assert.equal(unbind.json.ok, true);

  // mock：notifyStop 被调用（+1），notifyStart 保持 1
  const stoppedAccount = await waitFor(
    async () => {
      const state = await e2e.mockState();
      const current = state.accounts.find((item) => item.botId === account.botId);
      return current && current.notifyStop >= 1 ? current : null;
    },
    { label: '解绑后 mock 收到 notifystop' },
  );
  assert.equal(stoppedAccount.notifyStop, 1);
  assert.equal(stoppedAccount.notifyStart, 1);

  // 用户状态 unbound，凭证已清除
  const detail = await e2e.waitUser(user.id, (data) => data.user.status === 'unbound');
  assert.equal(detail.user.status, 'unbound');
  assert.equal(detail.user.ilinkBotId, '');
  assert.equal(detail.user.hasContextToken, false);

  // unbound 列表可见，active 列表不再包含
  const unboundList = await e2e.adminGet('/api/admin/users?status=unbound');
  assert.ok(unboundList.json.items.some((item) => item.id === user.id));
  const activeList = await e2e.adminGet('/api/admin/users?status=active');
  assert.equal(activeList.json.items.some((item) => item.id === user.id), false);
  const v1Users = await e2e.api('GET', '/api/v1/users?status=active', {
    headers: { Authorization: `Bearer ${e2e.apiToken}` },
  });
  assert.equal(v1Users.json.items.some((item) => item.id === user.id), false);

  // 再发消息被拒：admin 409、v1 404、reconnect 409
  const adminSend = await e2e.adminWrite('POST', `/api/admin/users/${user.id}/messages`, { text: '解绑后发送' });
  assert.equal(adminSend.status, 409);
  assert.equal(adminSend.json.error.code, 'CONFLICT');
  const v1Send = await e2e.api('POST', '/api/v1/messages', {
    body: { to: [user.id], text: '解绑后 v1 发送' },
    headers: { Authorization: `Bearer ${e2e.apiToken}` },
  });
  assert.equal(v1Send.status, 404);
  const reconnect = await e2e.adminWrite('POST', `/api/admin/users/${user.id}/reconnect`, {});
  assert.equal(reconnect.status, 409);
});
