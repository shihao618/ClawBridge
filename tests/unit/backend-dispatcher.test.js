/**
 * 单元测试：dispatcher 优雅退出 drain。
 *
 * 本地假 iLink（/ilink/bot/sendmessage 响应延迟可配置）；临时 DATA_DIR；无真实网络。
 * 覆盖：
 *  - stop() 等待在途 processOne 完成，返回后 sent 状态已写库（避免重启重复投递）；
 *  - 空闲/重复 stop 幂等；
 *  - drain 超时且 markDbClosing() 后，在途发送完成不再写库（避免关库后写失败）。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after } from 'node:test';
import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-dispatcher-',
  env: {
    APP_SECRET: 'dispatcher-test-secret-0123456789abcdef0123456789abcdef',
    ADMIN_PASSWORD: 'dispatcher-test-password',
    API_TOKEN: 'dispatcher-test-token',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: '50',
    RATE_LIMIT_WINDOW_MS: '300000',
  },
});

const state = { delayMs: 0, sendRequests: [] };
const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  // 读空请求体，避免连接提前关闭导致客户端 fetch 报错
  for await (const _chunk of req) {
    /* drain */
  }
  if (url.pathname === '/ilink/bot/sendmessage') {
    state.sendRequests.push({ at: Date.now() });
    if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ret":0,"message_id":"msg_dispatcher_1","errmsg":""}');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"ret":-1}');
});
await new Promise((resolve, reject) => {
  fake.once('error', reject);
  fake.listen(0, '127.0.0.1', resolve);
});
const fakeBase = `http://127.0.0.1:${fake.address().port}`;

const store = await import('../../server/src/store.js');
const dispatcher = await import('../../server/src/dispatcher.js');
const { getDb } = await import('../../server/src/db.js');

after(async () => {
  try {
    await dispatcher.stop({ timeoutMs: 100 });
  } catch {
    /* 忽略 */
  }
  dispatcher.markDbClosing();
  fake.closeAllConnections?.();
  await new Promise((resolve) => fake.close(resolve));
  await cleanupUnitEnv(unitEnv);
});

let seq = 0;
function createUser() {
  seq += 1;
  const { user } = store.upsertBoundUser({
    wechatUserId: `wx_dispatcher_graceful_${seq}`,
    displayName: `优雅退出用户${seq}`,
    ilinkBotId: `bot_dispatcher_graceful_${seq}@im.bot`,
    botToken: `dispatcher-graceful-token-${seq}`,
    baseUrl: fakeBase,
  });
  dispatcher.resetRateLimit(user.id);
  return user;
}

async function waitFor(predicate, { timeoutMs = 3000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
}

function outboxRow(userId) {
  return getDb().prepare('SELECT * FROM outbox WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').get(userId);
}

test('stop 等待在途 processOne 完成：stop 返回时 sent 状态已写库', async () => {
  state.delayMs = 300;
  state.sendRequests.length = 0;
  const user = createUser();
  store.enqueueMessage({ userId: user.id, text: '慢消息', source: 'admin' });
  assert.equal(dispatcher.start(), true);
  try {
    await waitFor(() => state.sendRequests.length === 1, { label: '假 iLink 收到 sendmessage' });
    const startedAt = Date.now();
    const result = await dispatcher.stop();
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(result, { stopped: true, drained: true });
    assert.ok(elapsed >= 200, `stop 应等待在途发送完成（实际 ${elapsed}ms）`);
    assert.equal(outboxRow(user.id).status, 'sent', '在途发送必须在 stop 返回前写回 sent');
    assert.equal(dispatcher.isRunning(), false);
    assert.equal(dispatcher.isDraining(), false);
    assert.equal(dispatcher.getState().draining, false);
  } finally {
    state.delayMs = 0;
    await dispatcher.stop();
  }
});

test('空闲/重复 stop：立即返回且幂等（第二次 stopped=false）', async () => {
  state.delayMs = 0;
  const user = createUser();
  store.enqueueMessage({ userId: user.id, text: '快消息', source: 'admin' });
  dispatcher.start();
  await waitFor(() => outboxRow(user.id)?.status === 'sent', { label: '消息已投递' });
  assert.deepEqual(await dispatcher.stop(), { stopped: true, drained: true });
  assert.deepEqual(await dispatcher.stop(), { stopped: false, drained: true });
});

test('drain 超时 + markDbClosing：在途发送完成后不再写库（避免关库后写失败）', async () => {
  state.delayMs = 500;
  state.sendRequests.length = 0;
  const user = createUser();
  store.enqueueMessage({ userId: user.id, text: '超时消息', source: 'admin' });
  dispatcher.start();
  await waitFor(() => state.sendRequests.length === 1, { label: '假 iLink 收到 sendmessage' });

  const result = await dispatcher.stop({ timeoutMs: 100 });
  assert.equal(result.drained, false, '在途发送超过等待上限时应返回 drained=false');

  // index.js 在 drained=false 时调用 markDbClosing()；此后在途发送不得再写 DB
  dispatcher.markDbClosing();
  assert.equal(dispatcher.getState().dbClosing, true);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(outboxRow(user.id).status, 'sending', '退出中在途发送完成后不应再写库');
  assert.equal(dispatcher.isRunning(), false);
});
