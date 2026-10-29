/**
 * 回归测试：monitor.js
 *  - M1 凭据代际保护：换绑后旧 worker 不得写 buf/入站/暂停（且旧凭据 -14 不得把新绑定置 paused）；
 *  - M1 正常路径保护：当前凭据 -14 仍应正常进入冷却；
 *  - M2 context_token 脱敏：processMessages 落库的 raw_json 不得含 context_token 明文，
 *    context_token 只能出现在 users.context_token_enc 密文中。
 *
 * 使用本地假 iLink 服务（可控挂起 getupdates）+ 临时 DATA_DIR，无真实网络。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-monitor-'));

// ---------------------------------------------------------------------------
// 假 iLink 服务
// ---------------------------------------------------------------------------
const fakeState = {
  /** @type {Array<{hold?: boolean, resp?: object, release?: () => void}>} */
  scriptedUpdates: [],
  holds: [],
  updateCalls: [],
  notifyStarts: [],
  notifyStops: [],
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 预置下一次 getupdates 的行为（hold=true 时挂起，直到测试调用 release）。 */
function queueUpdates(entry) {
  fakeState.scriptedUpdates.push(entry);
}

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  for await (const _chunk of req) {
    /* drain body */
  }
  const authorization = String(req.headers.authorization || '');
  const token = authorization.replace(/^Bearer\s+/i, '').trim();

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
    const entry = fakeState.scriptedUpdates.shift() || {};
    if (entry.hold) {
      await new Promise((resolve) => {
        entry.release = resolve;
        fakeState.holds.push(entry);
      });
    } else {
      await sleep(20);
    }
    sendJson(
      res,
      200,
      entry.resp ?? { ret: 0, errcode: 0, errmsg: '', msgs: [], get_updates_buf: '', longpolling_timeout_ms: 1000 },
    );
    return;
  }
  sendJson(res, 404, { ret: -1, errmsg: 'not found' });
});

await new Promise((resolve, reject) => {
  fake.once('error', reject);
  fake.listen(0, '127.0.0.1', resolve);
});
const fakeBase = `http://127.0.0.1:${fake.address().port}`;

// 必须在 import 业务模块前设置（config 加载即求值）
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'monitor-test-app-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'monitor-test-password';
process.env.API_TOKEN = 'monitor-test-api-token';
process.env.LOG_LEVEL = 'silent';
process.env.ILINK_LOGIN_BASE_URL = fakeBase;
process.env.ILINK_BASE_URL = fakeBase;

const monitor = await import('../../server/src/monitor.js');
const store = await import('../../server/src/store.js');
const { getDb, closeDb } = await import('../../server/src/db.js');
const { decryptSecret } = await import('../../server/src/crypto.js');

after(async () => {
  await monitor.stopAll({ notify: false }).catch(() => {});
  closeDb();
  fake.closeAllConnections?.();
  await new Promise((resolve) => fake.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function waitFor(fn, timeoutMs = 12000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw lastError ?? new Error('waitFor 超时');
}

let userSeq = 0;
function createUser({ token, wechatUserId } = {}) {
  userSeq += 1;
  return store.upsertBoundUser({
    wechatUserId: wechatUserId ?? `wx_monitor_gen_${userSeq}`,
    displayName: `监控用户${userSeq}`,
    ilinkBotId: `bot_monitor_${userSeq}@im.bot`,
    botToken: token ?? `token-gen-${userSeq}`,
    baseUrl: fakeBase,
  }).user;
}

// ---------------------------------------------------------------------------
// M1：凭据代际保护
// ---------------------------------------------------------------------------
test('M1: 换绑后旧 worker 不得写入 get_updates_buf / 入站消息 / context_token', async () => {
  const user = createUser({ wechatUserId: 'wx_monitor_gen_stale_writes', token: 'token-gen-old-A' });
  const staleMessage = {
    seq: 1,
    message_id: '9007199254740995',
    from_user_id: 'wx_monitor_gen_stale_writes',
    create_time_ms: Date.now(),
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: '旧 bot 的入站消息' } }],
    context_token: 'ctx-old-token-should-not-be-written',
  };
  queueUpdates({ hold: true, resp: { ret: 0, errcode: 0, errmsg: '', msgs: [staleMessage], get_updates_buf: 'stale-buf', longpolling_timeout_ms: 35000 } });
  assert.equal(monitor.start(user.id), true);
  await waitFor(() => fakeState.holds.length === 1);

  // 模拟换绑：DB 中凭据已更新为新 bot（旧 worker 尚未 stop 的残留场景）
  store.upsertBoundUser({
    wechatUserId: 'wx_monitor_gen_stale_writes',
    displayName: '监控用户',
    ilinkBotId: 'bot_monitor_new_A@im.bot',
    botToken: 'token-gen-new-A',
    baseUrl: fakeBase,
  });
  // 释放旧 bot 的在途响应
  fakeState.holds[0].release();
  await waitFor(() => monitor.isRunning(user.id) === false);

  const row = store.getUserRow(user.id);
  assert.equal(row.get_updates_buf, '', '旧 worker 不得写 get_updates_buf');
  assert.equal(row.pause_until, 0);
  assert.equal(store.listInbound({ userId: user.id }).total, 0, '旧 worker 不得写旧 bot 的入站消息');
  assert.equal(store.getUserSecrets(user.id).contextToken, null, '旧 worker 不得写旧 context_token');
  assert.equal(decryptSecret(row.token_enc), 'token-gen-new-A', '新凭据不应被旧 worker 覆盖');
});

test('M1: 换绑后旧凭据的 -14 不得把新绑定用户置 paused', async () => {
  const user = createUser({ wechatUserId: 'wx_monitor_gen_stale_pause', token: 'token-gen-old-B' });
  queueUpdates({ hold: true, resp: { ret: -14, errcode: -14, errmsg: 'old token expired' } });
  assert.equal(monitor.start(user.id), true);
  await waitFor(() => fakeState.holds.length === 2);

  store.upsertBoundUser({
    wechatUserId: 'wx_monitor_gen_stale_pause',
    displayName: '监控用户',
    ilinkBotId: 'bot_monitor_new_B@im.bot',
    botToken: 'token-gen-new-B',
    baseUrl: fakeBase,
  });
  fakeState.holds[1].release();
  await waitFor(() => monitor.isRunning(user.id) === false);
  await sleep(50);

  const row = store.getUserRow(user.id);
  assert.equal(row.pause_until, 0, '旧 worker 的 -14 不得写 paused');
  assert.equal(row.last_error, '', '旧 worker 的 -14 不得写 last_error');
  assert.equal(decryptSecret(row.token_enc), 'token-gen-new-B');
  const staleEvents = store.listEvents(20).filter((event) => event.user_id === user.id && event.type === 'stale_token');
  assert.equal(staleEvents.length, 0, '旧 worker 的 -14 不得写 stale_token 事件');
});

test('M1（回归保护）：当前凭据的 -14 仍应正常置 paused 并停止循环', async () => {
  const user = createUser({ wechatUserId: 'wx_monitor_gen_current_14', token: 'token-gen-current-14' });
  queueUpdates({ resp: { ret: -14, errcode: -14, errmsg: 'token expired' } });
  assert.equal(monitor.start(user.id), true);
  await waitFor(() => monitor.isRunning(user.id) === false);
  const row = store.getUserRow(user.id);
  assert.ok(Number(row.pause_until) > Date.now(), '当前凭据 -14 应进入冷却');
  assert.ok(row.last_error.includes('失效'), row.last_error);
  const staleEvents = store.listEvents(20).filter((event) => event.user_id === user.id && event.type === 'stale_token');
  assert.equal(staleEvents.length, 1, '应写入 stale_token 事件');
});

// ---------------------------------------------------------------------------
// M2：context_token 脱敏
// ---------------------------------------------------------------------------
test('M2: 入站消息 raw_json 不含 context_token 明文，加密字段仍可解密', () => {
  const user = createUser({ wechatUserId: 'wx_monitor_ctx_plain', token: 'token-ctx-user' });
  const secretContextToken = 'SUPER_SECRET_CONTEXT_TOKEN_abc123';
  monitor.processMessages(user.id, [
    {
      seq: 7,
      message_id: '9007199254740997',
      from_user_id: 'wx_monitor_ctx_plain',
      create_time_ms: Date.now(),
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: '你好，带 context_token 的入站消息' } }],
      context_token: secretContextToken,
    },
  ]);

  const row = getDb()
    .prepare('SELECT raw_json, text, item_types, wechat_message_id FROM inbound_messages WHERE user_id = ?')
    .get(user.id);
  assert.ok(row, '入站消息应已落库');
  assert.equal(row.text, '你好，带 context_token 的入站消息');
  assert.equal(row.item_types, '1');
  assert.equal(row.wechat_message_id, '9007199254740997');
  assert.ok(!row.raw_json.includes(secretContextToken), 'raw_json 不得包含 context_token 明文');
  assert.match(row.raw_json, /"context_token":"\\?\[redacted\]/, 'raw_json 中 context_token 应被替换为 [redacted]');
  assert.ok(row.raw_json.includes('你好，带 context_token 的入站消息'), 'raw_json 其他字段应保留');

  // context_token 仍通过 users.context_token_enc 加密保存
  const userRow = getDb().prepare('SELECT context_token_enc FROM users WHERE id = ?').get(user.id);
  assert.ok(userRow.context_token_enc.startsWith('v1.'), 'context_token_enc 应为 AES-GCM 密文');
  assert.ok(!userRow.context_token_enc.includes(secretContextToken));
  assert.equal(store.getUserSecrets(user.id).contextToken, secretContextToken);
});

test('M2: redactInboundMessage 深度脱敏（嵌套字段也不泄漏）', () => {
  const redacted = monitor.redactInboundMessage({
    message_id: '1',
    context_token: 'secret-1',
    nested: { context_token: 'secret-2', keep: 'v' },
    arr: [{ context_token: 'secret-3' }],
  });
  assert.equal(redacted.context_token, '[redacted]');
  assert.equal(redacted.nested.context_token, '[redacted]');
  assert.equal(redacted.nested.keep, 'v');
  assert.equal(redacted.arr[0].context_token, '[redacted]');
  const raw = monitor.sanitizeInboundRawJson({ context_token: 'secret-raw', a: 1 });
  assert.ok(!raw.includes('secret-raw'));
  assert.equal(JSON.parse(raw).a, 1);
  assert.equal(JSON.parse(raw).context_token, '[redacted]');
});
