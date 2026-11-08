/**
 * e2e：公开扫码绑定全流程（黑盒 HTTP）。
 *
 * 覆盖：健康检查、waiting→scanned→confirmed、admin 用户列表可见、need_verifycode
 * （错误码→可重试→正确码）、二维码过期自动刷新、binded_redirect→already_bound、
 * 取消会话、会话 token/参数校验。
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

test('健康检查 /health、/api/health 返回 200 且带安全响应头', async () => {
  for (const pathname of ['/health', '/api/health']) {
    const res = await e2e.api('GET', pathname);
    assert.equal(res.status, 200, `${pathname} 应 200`);
    assert.equal(res.json.status, 'ok');
    assert.equal(typeof res.json.version, 'string');
    assert.equal(typeof res.json.uptimeMs, 'number');
  }
  const res = await e2e.api('GET', '/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('公开绑定完整流程：waiting → scanned → confirmed，admin 用户列表可见', async () => {
  const created = await e2e.createBindSession('张三-e2e');
  assert.equal(created.status, 'waiting');
  assert.equal(created.displayName, '张三-e2e');
  assert.ok(created.qr.expiresAt > Date.now(), '二维码应有未来过期时间');
  const qrcode = e2e.extractQrcode(created);
  assert.match(qrcode, /^qr_[0-9a-f]+$/);

  // mock 侧已生成二维码；首次绑定 local_token_list 为空
  const state = await e2e.mockState();
  const mockQr = state.qrs.find((item) => item.qrcode === qrcode);
  assert.ok(mockQr, 'mock 侧应存在该二维码');
  assert.deepEqual(mockQr.localTokenList, []);
  assert.equal(mockQr.status, 'wait');

  // 手机扫码
  await e2e.mockScan(qrcode);
  const scanned = await e2e.waitBindStatus(created.sessionId, created.token, 'scanned');
  assert.match(scanned.message, /已扫码/);

  // 手机确认
  await e2e.mockConfirm(qrcode);
  const confirmed = await e2e.waitBindStatus(created.sessionId, created.token, 'confirmed');
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.refreshCount, 0);
  assert.ok(confirmed.user?.id?.startsWith('u_'), 'confirmed 应返回用户');
  assert.equal(confirmed.user.displayName, '张三-e2e');
  assert.ok(confirmed.user.wechatUserId, 'confirmed 应返回 wechatUserId');

  // mock 账号：baseurl 回连 mock、ilink_user_id 与用户一致、notifyStart 已调用（入站监控启动）
  const account = await e2e.findMockAccount(confirmed.user);
  assert.ok(account, 'mock 侧应有对应 bot 账号');
  assert.equal(account.baseUrl, e2e.mockUrl);
  assert.equal(account.ilinkUserId, confirmed.user.wechatUserId);
  const monitored = await e2e.waitMonitorStarted(confirmed.user);
  assert.equal(monitored.notifyStart, 1);

  // admin 用户列表可见
  await e2e.ensureAdmin();
  const users = await e2e.adminGet('/api/admin/users?status=all');
  assert.equal(users.status, 200);
  const found = users.json.items.find((item) => item.id === confirmed.user.id);
  assert.ok(found, 'admin 用户列表应能看到新绑定用户');
  assert.equal(found.status, 'active');
  assert.equal(found.displayName, '张三-e2e');
  assert.equal(found.wechatUserId, confirmed.user.wechatUserId);
  assert.equal(found.ilinkBotId, account.botId);
  assert.equal(found.hasContextToken, false);
  assert.equal(found.boundAt, confirmed.user.boundAt);

  // 会话保留查询：confirmed 后仍可查到（10 分钟内）
  const again = await e2e.getBindSession(created.sessionId, created.token);
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'confirmed');
});

test('need_verifycode：错误配对码可重试，正确配对码后 confirmed', async () => {
  const created = await e2e.createBindSession('配对码用户');
  const qrcode = e2e.extractQrcode(created);
  await e2e.mockScan(qrcode);

  const required = await e2e.mockRequireVerify(qrcode, '4321');
  assert.equal(required.code, '4321');
  const need = await e2e.waitBindStatus(created.sessionId, created.token, 'need_verifycode');
  assert.match(need.message, /配对数字/);

  // 错误配对码：API 接受（202），mock 记录一次错误，会话回到 need_verifycode
  const wrong = await e2e.api('POST', `/api/bind/sessions/${created.sessionId}/verify-code`, {
    body: { token: created.token, code: '1111' },
  });
  assert.equal(wrong.status, 202);
  assert.equal(wrong.json.ok, true);
  const qrAfterWrong = await waitFor(
    async () => {
      const state = await e2e.mockState();
      const qr = state.qrs.find((item) => item.qrcode === qrcode);
      return qr && qr.verifyAttempts >= 1 ? qr : null;
    },
    { label: 'mock 记录一次错误配对码' },
  );
  assert.equal(qrAfterWrong.verifyAttempts, 1);
  await e2e.waitBindStatus(created.sessionId, created.token, 'need_verifycode', {
    label: '错误配对码后会回到 need_verifycode',
  });

  // 正确配对码：mock verifyHistory 出现 ok，随后手机确认 → confirmed
  const right = await e2e.api('POST', `/api/bind/sessions/${created.sessionId}/verify-code`, {
    body: { token: created.token, code: '4321' },
  });
  assert.equal(right.status, 202);
  const verified = await waitFor(
    async () => {
      const state = await e2e.mockState();
      const qr = state.qrs.find((item) => item.qrcode === qrcode);
      return qr && qr.verifyHistory.some((entry) => entry.ok === true) ? qr : null;
    },
    { label: 'mock 校验通过正确配对码' },
  );
  assert.equal(verified.verifyAttempts, 1, '只应有 1 次错误记录');
  await e2e.waitBindStatus(created.sessionId, created.token, ['scanned', 'confirmed'], {
    label: '正确配对码后进入 scanned',
  });
  await e2e.mockConfirm(qrcode);
  const confirmed = await e2e.waitBindStatus(created.sessionId, created.token, 'confirmed');
  assert.ok(confirmed.user?.id, '配对码流程最终应绑定成功');
});

test('非 need_verifycode 状态提交配对码返回 409 CONFLICT', async () => {
  const created = await e2e.createBindSession('状态校验用户');
  const res = await e2e.api('POST', `/api/bind/sessions/${created.sessionId}/verify-code`, {
    body: { token: created.token, code: '1234' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'CONFLICT');
  const cancelled = await e2e.api('DELETE', `/api/bind/sessions/${created.sessionId}`, {
    body: { token: created.token },
  });
  assert.equal(cancelled.status, 204);
});

test('二维码过期自动刷新：refreshCount 递增、二维码更新、刷新后可绑定成功', async () => {
  const created = await e2e.createBindSession('刷新用户');
  const qr1 = e2e.extractQrcode(created);
  await e2e.mockExpire(qr1);

  const refreshed = await waitFor(
    async () => {
      const res = await e2e.getBindSession(created.sessionId, created.token);
      assert.equal(res.status, 200);
      const view = res.json;
      if (view.refreshCount < 1) return null;
      const qr2 = e2e.extractQrcode(view);
      return qr2 !== qr1 && ['waiting', 'scanned'].includes(view.status) ? view : null;
    },
    { timeoutMs: 15000, label: '二维码自动刷新生效' },
  );
  assert.equal(refreshed.refreshCount, 1);
  const qr2 = e2e.extractQrcode(refreshed);
  assert.notEqual(qr2, qr1);

  // 刷新后的新二维码可正常完成绑定
  await e2e.mockScan(qr2);
  await e2e.mockConfirm(qr2);
  const confirmed = await e2e.waitBindStatus(created.sessionId, created.token, 'confirmed');
  assert.equal(confirmed.refreshCount, 1);
  assert.ok(confirmed.user?.id);
});

test('binded_redirect → already_bound（成功语义，不发放新 bot 账号）', async () => {
  const accountsBefore = (await e2e.mockState()).accounts.length;
  const created = await e2e.createBindSession('已绑定用户');
  const qrcode = e2e.extractQrcode(created);
  await e2e.mockAlreadyBound(qrcode, { ilink_user_id: 'mock_existing_user@im.wechat' });
  const already = await e2e.waitBindStatus(created.sessionId, created.token, 'already_bound');
  assert.match(already.message, /已绑定/);
  assert.equal(already.user, undefined, 'mock 未返回可匹配用户时不应伪造 user');
  const accountsAfter = (await e2e.mockState()).accounts.length;
  assert.equal(accountsAfter, accountsBefore, 'binded_redirect 不应创建新 bot 账号');
});

test('DELETE 取消绑定 → 状态 cancelled', async () => {
  const created = await e2e.createBindSession('取消用户');
  const del = await e2e.api('DELETE', `/api/bind/sessions/${created.sessionId}`, {
    body: { token: created.token },
  });
  assert.equal(del.status, 204);
  const cancelled = await e2e.waitBindStatus(created.sessionId, created.token, 'cancelled');
  assert.match(cancelled.message, /取消/);
});

test('绑定会话 token/参数校验：错误 token 401、未知会话 404、displayName 超长 400', async () => {
  const created = await e2e.createBindSession('鉴权用户');

  const badToken = await e2e.getBindSession(created.sessionId, 'wrong-token');
  assert.equal(badToken.status, 401);
  assert.equal(badToken.json.error.code, 'UNAUTHORIZED');

  const noToken = await e2e.getBindSession(created.sessionId);
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json.error.code, 'UNAUTHORIZED');

  const unknown = await e2e.getBindSession('00000000-0000-4000-8000-000000000000', created.token);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'NOT_FOUND');

  const badDelete = await e2e.api('DELETE', `/api/bind/sessions/${created.sessionId}`, {
    body: { token: 'wrong-token' },
  });
  assert.equal(badDelete.status, 401);

  const longName = await e2e.api('POST', '/api/bind/sessions', { body: { displayName: 'x'.repeat(41) } });
  assert.equal(longName.status, 400);
  assert.equal(longName.json.error.code, 'BAD_REQUEST');

  const cleaned = await e2e.api('DELETE', `/api/bind/sessions/${created.sessionId}`, {
    body: { token: created.token },
  });
  assert.equal(cleaned.status, 204);
});
