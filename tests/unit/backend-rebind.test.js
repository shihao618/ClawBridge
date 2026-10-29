/**
 * 回归测试（QA M1）：换绑后入站监控必须切换到新 bot 凭据。
 *
 * 用本地假 iLink 服务让同一 wechat_user_id 连续两次扫码确认（token A → token B），
 * 断言：旧 monitor 被 stop（notifyStop token A）→ 新 monitor start（notifyStart token B）
 * → 新循环用 token B 轮询、旧 token 不再轮询、用户 id 不变且未冷却。
 *
 * 修复前（binding confirmed 仅 monitor.start，而 start 对运行中 userId 幂等返回 false）：
 * 不会出现 notifyStart token B，本测试失败。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-rebind-'));

// ---------------------------------------------------------------------------
// 假 iLink 服务：按二维码顺序返回预设的 confirmed 凭证（同 wechat_user_id）
// ---------------------------------------------------------------------------
const fakeState = {
  qrSeq: 0,
  /** @type {Array<{token: string, botId: string, ilinkUserId: string}>} */
  confirmSequence: [],
  qrConfig: new Map(),
  notifyStarts: [],
  notifyStops: [],
  updateCalls: [],
  /** 各 token 当前在途的 getupdates 请求数（用于 stop 后确定性断言） */
  inFlightByToken: new Map(),
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  for await (const _chunk of req) {
    /* drain */
  }
  const authorization = String(req.headers.authorization || '');
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  const qrcode = url.searchParams.get('qrcode') || '';

  if (url.pathname === '/ilink/bot/get_bot_qrcode') {
    fakeState.qrSeq += 1;
    const id = `qr_rebind_${fakeState.qrSeq}`;
    fakeState.qrConfig.set(id, fakeState.confirmSequence[fakeState.qrSeq - 1]);
    sendJson(res, 200, { qrcode: id, qrcode_img_content: `https://example.test/rebind?qrcode=${id}` });
    return;
  }
  if (url.pathname === '/ilink/bot/get_qrcode_status') {
    const config = fakeState.qrConfig.get(qrcode);
    if (!config) {
      sendJson(res, 200, { status: 'wait' });
      return;
    }
    sendJson(res, 200, {
      status: 'confirmed',
      bot_token: config.token,
      ilink_bot_id: config.botId,
      baseurl: fakeBase,
      ilink_user_id: config.ilinkUserId,
    });
    return;
  }
  if (url.pathname === '/ilink/bot/msg/notifystart') {
    fakeState.notifyStarts.push({ token, at: Date.now() });
    sendJson(res, 200, { ret: 0, errmsg: '' });
    return;
  }
  if (url.pathname === '/ilink/bot/msg/notifystop') {
    fakeState.notifyStops.push({ token, at: Date.now() });
    sendJson(res, 200, { ret: 0, errmsg: '' });
    return;
  }
  if (url.pathname === '/ilink/bot/getupdates') {
    fakeState.updateCalls.push({ token, at: Date.now() });
    fakeState.inFlightByToken.set(token, (fakeState.inFlightByToken.get(token) ?? 0) + 1);
    try {
      await delay(40);
      sendJson(res, 200, {
        ret: 0,
        errcode: 0,
        errmsg: '',
        msgs: [],
        get_updates_buf: `buf-${token}`,
        longpolling_timeout_ms: 1000,
      });
    } finally {
      const remaining = (fakeState.inFlightByToken.get(token) ?? 1) - 1;
      if (remaining > 0) fakeState.inFlightByToken.set(token, remaining);
      else fakeState.inFlightByToken.delete(token);
    }
    return;
  }
  sendJson(res, 404, { ret: -1, errmsg: 'not found' });
});

await new Promise((resolve, reject) => {
  fake.once('error', reject);
  fake.listen(0, '127.0.0.1', resolve);
});
const fakeBase = `http://127.0.0.1:${fake.address().port}`;

// 必须在 import 业务模块前设置
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'rebind-test-app-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'rebind-test-password';
process.env.API_TOKEN = 'rebind-test-api-token';
process.env.LOG_LEVEL = 'silent';
process.env.ILINK_LOGIN_BASE_URL = fakeBase;
process.env.ILINK_BASE_URL = fakeBase;
process.env.BINDING_POLL_GAP_MS = '50';

const binding = await import('../../server/src/binding.js');
const monitor = await import('../../server/src/monitor.js');
const store = await import('../../server/src/store.js');
const dispatcher = await import('../../server/src/dispatcher.js');
const { closeDb } = await import('../../server/src/db.js');
const { decryptSecret } = await import('../../server/src/crypto.js');

after(async () => {
  await monitor.stopAll({ notify: false }).catch(() => {});
  try {
    binding.stopCleanup();
  } catch {
    /* ignore */
  }
  closeDb();
  fake.closeAllConnections?.();
  await new Promise((resolve) => fake.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function waitFor(fn, timeoutMs = 15000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await delay(intervalMs);
  }
  throw lastError ?? new Error('waitFor 超时');
}

/** 轮询绑定会话直到 confirmed（终态错误直接抛出）。 */
async function waitSessionConfirmed(created) {
  return waitFor(async () => {
    const snapshot = binding.getSession({ sessionId: created.sessionId, token: created.token });
    if (snapshot.status === 'confirmed') return snapshot;
    if (['error', 'timeout', 'expired', 'cancelled'].includes(snapshot.status)) {
      throw new Error(`会话异常: ${snapshot.status} ${snapshot.error ?? ''}`);
    }
    return null;
  });
}

test('M1: 换绑后旧 monitor 停止、新 monitor 用新 token 轮询', async () => {
  const WECHAT_USER = 'wx_rebind_same_user@im.wechat';
  fakeState.confirmSequence = [
    { token: 'token-bind-A', botId: 'bot-bind-A@im.bot', ilinkUserId: WECHAT_USER },
    { token: 'token-bind-B', botId: 'bot-bind-B@im.bot', ilinkUserId: WECHAT_USER },
  ];

  // 第一次绑定 → monitor 用 token A
  const createdA = await binding.createSession({ displayName: '换绑用户' });
  const confirmedA = await waitSessionConfirmed(createdA);
  const userId = confirmedA.user.id;
  assert.ok(userId, '首次绑定应返回用户');
  assert.equal(confirmedA.user.wechatUserId, WECHAT_USER);
  await waitFor(() => fakeState.notifyStarts.some((item) => item.token === 'token-bind-A'));
  await waitFor(() => fakeState.updateCalls.some((item) => item.token === 'token-bind-A'));

  // 同一微信用户再次扫码（换绑）→ token B
  const createdB = await binding.createSession({ displayName: '换绑用户' });
  const confirmedB = await waitSessionConfirmed(createdB);
  assert.equal(confirmedB.user.id, userId, '换绑应复用同一用户 id');
  assert.equal(store.getUser(userId).ilinkBotId, 'bot-bind-B@im.bot', '用户 botId 应更新为新 bot');

  // 旧 monitor 必须被停止（notifyStop token A），新 monitor 必须启动（notifyStart token B）
  await waitFor(() => fakeState.notifyStops.some((item) => item.token === 'token-bind-A'));
  await waitFor(() => fakeState.notifyStarts.some((item) => item.token === 'token-bind-B'));
  await waitFor(() => fakeState.updateCalls.some((item) => item.token === 'token-bind-B'));

  // 确定性判据（不依赖时间戳/时序运气）：
  // 等收尾稳定后取基线，再观察一段时间，旧 token 的 getupdates 数量不得增长且无在途请求。
  await delay(300);
  const staleCallsBaseline = fakeState.updateCalls.filter((item) => item.token === 'token-bind-A').length;
  await delay(300);
  const staleCallsAfter = fakeState.updateCalls.filter((item) => item.token === 'token-bind-A').length;
  assert.equal(
    staleCallsAfter,
    staleCallsBaseline,
    `旧 monitor 退出后不应再发起旧 token 的 getupdates（基线 ${staleCallsBaseline}，之后 ${staleCallsAfter}）`,
  );
  assert.equal(
    fakeState.inFlightByToken.get('token-bind-A') ?? 0,
    0,
    '旧 token 不应有在途 getupdates 请求',
  );

  // DB 使用新凭据，且用户未被冷却
  const row = store.getUserRow(userId);
  assert.equal(decryptSecret(row.token_enc), 'token-bind-B', 'DB 应保存新 token');
  assert.equal(row.ilink_bot_id, 'bot-bind-B@im.bot');
  assert.equal(row.pause_until, 0, '换绑用户不应被置 paused');
  assert.equal(store.getUser(userId).status, 'active');
  const staleEvents = store.listEvents(20).filter((event) => event.user_id === userId && event.type === 'stale_token');
  assert.equal(staleEvents.length, 0, '换绑流程不应产生 stale_token 事件');
  assert.equal(monitor.isRunning(userId), true, '换绑后应只有一个运行中的新 monitor');
});

test('dispatcher.resetRateLimit: 换绑后可重置该账号发送限流桶', () => {
  const limiter = dispatcher.getLimiter();
  const key = 'u_rebind_rate_limit_test';
  // 耗尽默认令牌桶（RATE_LIMIT_MAX=7）
  for (let i = 0; i < 7; i += 1) {
    assert.equal(limiter.tryAcquire(key).allowed, true, `第 ${i + 1} 次应允许`);
  }
  assert.equal(limiter.tryAcquire(key).allowed, false);
  assert.equal(dispatcher.resetRateLimit(key), true);
  assert.equal(limiter.tryAcquire(key).allowed, true, 'reset 后应恢复额度');
  assert.equal(dispatcher.resetRateLimit(''), false);
});
