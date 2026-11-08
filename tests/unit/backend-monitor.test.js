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
import http from 'node:http';
import test, { after } from 'node:test';
import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

// ---------------------------------------------------------------------------
// 假 iLink 服务
// ---------------------------------------------------------------------------
const fakeState = {
  /** @type {Array<{hold?: boolean, resp?: object, release?: () => void}>} */
  scriptedUpdates: [],
  holds: [],
  updateCalls: [],
  /** 记录每次 getupdates 请求体（含 get_updates_buf），用于断言游标推进时机。 */
  updateBodies: [],
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
  let rawBody = '';
  for await (const chunk of req) {
    rawBody += chunk;
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
    try {
      fakeState.updateBodies.push(rawBody ? JSON.parse(rawBody) : {});
    } catch {
      fakeState.updateBodies.push({});
    }
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
      entry.status ?? 200,
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
const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-monitor-',
  env: {
    APP_SECRET: 'monitor-test-app-secret-0123456789abcdef0123456789abcdef',
    ADMIN_PASSWORD: 'monitor-test-password',
    API_TOKEN: 'monitor-test-api-token',
    LOG_LEVEL: 'silent',
    ILINK_LOGIN_BASE_URL: fakeBase,
    ILINK_BASE_URL: fakeBase,
  },
});

const monitor = await import('../../server/src/monitor.js');
const store = await import('../../server/src/store.js');
const { config } = await import('../../server/src/config.js');
const { getDb } = await import('../../server/src/db.js');
const { decryptSecret } = await import('../../server/src/crypto.js');

test('游标落库时机：消息后 15 分钟静默 / 无消息 6 小时兜底', () => {
  const now = 10_000_000;
  const idleMs = 15 * 60 * 1000;
  const maxAgeMs = 6 * 60 * 60 * 1000;
  const due = (overrides = {}) =>
    monitor.cursorPersistDue({
      dirty: true,
      now,
      lastMessageAt: 0,
      lastPersistAt: now - maxAgeMs,
      idleMs,
      maxAgeMs,
      ...overrides,
    });
  assert.equal(due({ dirty: false }), false, '无变化不写入');
  assert.equal(due({ lastMessageAt: now - idleMs + 1 }), false, '消息后未静默满 15 分钟不写');
  assert.equal(due({ lastMessageAt: now - idleMs }), true, '消息后静默满 15 分钟写入');
  assert.equal(due({ lastMessageAt: 0, lastPersistAt: now - maxAgeMs + 1 }), false, '无消息未满 6 小时不写');
  assert.equal(due({ lastMessageAt: 0, lastPersistAt: now - maxAgeMs }), true, '无消息满 6 小时写入');
});

after(async () => {
  await monitor.stopAll({ notify: false }).catch(() => {});
  fake.closeAllConnections?.();
  await new Promise((resolve) => fake.close(resolve));
  await cleanupUnitEnv(unitEnv);
});

async function waitFor(fn, timeoutMs = 12000, intervalMs = 20) {
  // 兼容两种调用：waitFor(fn, timeoutMs, intervalMs) 与 waitFor(fn, { timeoutMs, intervalMs })。
  if (timeoutMs && typeof timeoutMs === 'object') {
    intervalMs = timeoutMs.intervalMs ?? intervalMs;
    timeoutMs = timeoutMs.timeoutMs ?? 12000;
  }
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

// ---------------------------------------------------------------------------
// 补充分支覆盖：业务错误退避重试 / HTTP 401 stale-token /
// start-stop 幂等 / 退出时游标持久化 / extractMessageText 表驱动
// ---------------------------------------------------------------------------
test('退避分支：getupdates 业务错误（ret!=0）按 retryDelayMs 重试，成功后恢复轮询', async () => {
  const token = 'token-monitor-retry-business';
  const user = createUser({ wechatUserId: 'wx_monitor_retry_business', token });
  queueUpdates({ resp: { ret: 1, errcode: 1, errmsg: 'server busy' } });
  queueUpdates({ resp: { ret: 0, errcode: 0, errmsg: '', msgs: [], get_updates_buf: 'retry-ok-buf', longpolling_timeout_ms: 1000 } });

  assert.equal(monitor.start(user.id), true);
  // 第一次失败 → consecutiveFailures=1 → sleep(retryDelayMs=2000) → 第二次成功
  await waitFor(() => fakeState.updateCalls.filter((call) => call.token === token).length >= 2, {
    timeoutMs: 10000,
    intervalMs: 50,
  });
  assert.equal(monitor.isRunning(user.id), true, '退避重试成功后监控应仍在运行');
  assert.equal(await monitor.stop(user.id), true);
  assert.equal(monitor.isRunning(user.id), false);
});

test('stale-token 分支：HTTP 401（body 不带 ret）按 token 失效冷却并停止循环', async () => {
  const token = 'token-monitor-http-401';
  const user = createUser({ wechatUserId: 'wx_monitor_http_401', token });
  queueUpdates({ status: 401, resp: { ret: -14, errcode: -14, errmsg: 'token expired' } });

  assert.equal(monitor.start(user.id), true);
  await waitFor(() => monitor.isRunning(user.id) === false, { timeoutMs: 8000 });
  const row = store.getUserRow(user.id);
  assert.ok(Number(row.pause_until) > Date.now(), 'HTTP 401 应把账号置为冷却（pause_until > now）');
  assert.ok(String(row.last_error).includes('失效'), `last_error 应说明 token 失效：${row.last_error}`);
  const staleEvents = store.listEvents(50).filter((event) => event.user_id === user.id && event.type === 'stale_token');
  assert.equal(staleEvents.length, 1, '应写入 stale_token 事件');
});

test('start/stop 幂等：重复 start/stop 返回 false，runningCount 复位', async () => {
  const token = 'token-monitor-idempotent';
  const user = createUser({ wechatUserId: 'wx_monitor_idempotent', token });
  const runningBefore = monitor.runningCount();
  const callsBefore = fakeState.updateCalls.filter((call) => call.token === token).length;

  assert.equal(monitor.start(user.id), true);
  assert.equal(monitor.start(user.id), false, '重复 start 应返回 false');
  await waitFor(() => fakeState.updateCalls.filter((call) => call.token === token).length > callsBefore, {
    timeoutMs: 8000,
    intervalMs: 20,
  });
  assert.equal(monitor.runningCount(), runningBefore + 1);

  assert.equal(await monitor.stop(user.id), true);
  assert.equal(await monitor.stop(user.id), false, '重复 stop 应返回 false');
  assert.equal(monitor.isRunning(user.id), false);
  assert.equal(monitor.runningCount(), runningBefore);
});

test('PersistCursor 分支：stop(reason=shutdown) 才把内存游标持久化到 DB', async () => {
  const token = 'token-monitor-cursor';
  const user = createUser({ wechatUserId: 'wx_monitor_cursor_shutdown', token });
  queueUpdates({
    resp: { ret: 0, errcode: 0, errmsg: '', msgs: [], get_updates_buf: 'shutdown-cursor-buf', longpolling_timeout_ms: 1000 },
  });

  assert.equal(monitor.start(user.id), true);
  // 等第二轮 getupdates 请求，说明第一轮响应已处理、worker.pendingBuf 已更新
  await waitFor(() => fakeState.updateCalls.filter((call) => call.token === token).length >= 2, {
    timeoutMs: 8000,
    intervalMs: 20,
  });
  assert.equal(store.getUserRow(user.id).get_updates_buf, '', '日常运行不立即落盘游标');
  await monitor.stop(user.id, { notify: false, reason: 'shutdown' });
  assert.equal(store.getUserRow(user.id).get_updates_buf, 'shutdown-cursor-buf', '优雅退出时应持久化内存游标');
});

test('extractMessageText：文本优先、语音转写、媒体占位与空消息', () => {
  const text = (itemList) => monitor.extractMessageText({ item_list: itemList });
  assert.equal(text([{ type: 1, text_item: { text: '你好' } }]), '你好');
  assert.equal(text([{ type: 2, image_item: {} }, { type: 1, text_item: { text: '图文' } }]), '图文', '文本优先于媒体占位');
  assert.equal(text([{ type: 3, voice_item: { text: '语音转写内容' } }]), '语音转写内容');
  assert.equal(text([{ type: 2, image_item: {} }]), '[图片]');
  assert.equal(text([{ type: 3, voice_item: { text: '   ' } }]), '[语音]', '空语音转写回退占位');
  assert.equal(text([{ type: 4, file_item: { file_name: 'a.pdf' } }]), '[文件] a.pdf');
  assert.equal(text([{ type: 4, file_item: {} }]), '[文件]');
  assert.equal(text([{ type: 5, video_item: {} }]), '[视频]');
  assert.equal(text([{ type: 11 }]), '[工具调用]');
  assert.equal(text([{ type: 12 }]), '[工具调用]');
  assert.equal(text([{ type: 99 }]), '[消息]');
  assert.equal(text([]), '');
  assert.equal(monitor.extractMessageText({}), '');
});

// ---------------------------------------------------------------------------
// 导出清理 / 落库错误分类 / last_poll_at
// ---------------------------------------------------------------------------
test('未使用的 listRunning 导出已移除（监控状态查询保留 isRunning/runningCount）', () => {
  assert.equal('listRunning' in monitor, false);
  assert.equal(typeof monitor.isRunning, 'function');
  assert.equal(typeof monitor.runningCount, 'function');
});

test('落库错误分类：busy/locked/IO 可重试，普通错误不可重试', () => {
  assert.equal(monitor.isRetryableInboundSaveError({ message: 'database is locked' }), true);
  assert.equal(monitor.isRetryableInboundSaveError({ message: 'SQLITE_BUSY: database is locked' }), true);
  assert.equal(monitor.isRetryableInboundSaveError({ message: 'disk I/O error' }), true);
  assert.equal(monitor.isRetryableInboundSaveError({ message: 'database or disk is full' }), true);
  assert.equal(monitor.isRetryableInboundSaveError({ errcode: 5, message: 'x' }), true);
  assert.equal(monitor.isRetryableInboundSaveError({ errcode: 13, message: 'x' }), true);
  assert.equal(monitor.isRetryableInboundSaveError(new Error('UNIQUE constraint failed')), false);
  assert.equal(monitor.isRetryableInboundSaveError(null), false);
});

test('不可重试落库失败 → 写 inbound_save_failed 事件且同批后续消息继续处理', async () => {
  const user = createUser({ wechatUserId: 'wx_ba15_fatal', token: 'token-ba15-fatal' });
  const trigger = 'ba15_fatal_inbound';
  getDb().exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  getDb().exec(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON inbound_messages
       WHEN NEW.user_id = '${user.id}' AND NEW.wechat_message_id = 'ba15_msg_fatal_1'
       BEGIN SELECT RAISE(ABORT, 'forced inbound failure'); END;`,
  );
  try {
    const outcome = await monitor.processMessages(user.id, [
      { message_id: 'ba15_msg_fatal_1', from_user_id: 'wx_ba15_fatal', item_list: [{ type: 1, text_item: { text: 'fatal' } }] },
      { message_id: 'ba15_msg_ok_2', from_user_id: 'wx_ba15_fatal', item_list: [{ type: 1, text_item: { text: 'ok' } }] },
    ]);
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.failed, 1);
    assert.equal(outcome.saved, 1);
  } finally {
    getDb().exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  const events = store.listEvents(100).filter((event) => event.user_id === user.id && event.type === 'inbound_save_failed');
  assert.equal(events.length, 1, '不可重试失败应写 inbound_save_failed 事件');
  assert.match(events[0].detail, /ba15_msg_fatal_1/);
  assert.equal(store.listInbound({ userId: user.id }).total, 1, '同批后续消息应正常落库');
});

test('可重试落库失败不推进游标，恢复后重放同一批消息并推进', async () => {
  const user = createUser({ wechatUserId: 'wx_ba15_retry', token: 'token-ba15-retry' });
  const message = {
    seq: 1,
    message_id: 'ba15_msg_retry_1',
    from_user_id: 'wx_ba15_retry',
    create_time_ms: Date.now(),
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: 'BA15 重试消息' } }],
  };
  const trigger = 'ba15_busy_inbound';
  const prevRetryDelay = config.monitor.retryDelayMs;
  config.monitor.retryDelayMs = 20;
  getDb().exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  getDb().exec(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON inbound_messages
       WHEN NEW.user_id = '${user.id}'
       BEGIN SELECT RAISE(ABORT, 'database is locked'); END;`,
  );
  const bodyBase = fakeState.updateBodies.length;
  try {
    queueUpdates({ resp: { ret: 0, errcode: 0, msgs: [message], get_updates_buf: 'ba15-buf-1', longpolling_timeout_ms: 500 } });
    queueUpdates({ hold: true, resp: { ret: 0, errcode: 0, msgs: [message], get_updates_buf: 'ba15-buf-1', longpolling_timeout_ms: 500 } });
    assert.equal(monitor.start(user.id), true);
    // 第 1 轮失败 → 第 2 轮重试：请求仍携带旧游标（空串）
    await waitFor(() => fakeState.updateBodies.length >= bodyBase + 2);
    assert.equal(fakeState.updateBodies[bodyBase].get_updates_buf, '');
    assert.equal(fakeState.updateBodies[bodyBase + 1].get_updates_buf, '', '可重试失败时不得推进游标');

    // 第 2 轮响应在途（被假服务挂起）期间恢复 DB，再放行 → 同一批消息重放成功
    getDb().exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    const held = fakeState.holds[fakeState.holds.length - 1];
    assert.ok(held?.release, '第二次 getupdates 应处于挂起状态');
    held.release();
    await waitFor(() => fakeState.updateBodies.length >= bodyBase + 3);
    assert.equal(fakeState.updateBodies[bodyBase + 2].get_updates_buf, 'ba15-buf-1', '落库恢复后应推进到新游标');
    await waitFor(() => store.listInbound({ userId: user.id }).total === 1);
    const events = store.listEvents(100).filter((event) => event.user_id === user.id && event.type === 'inbound_save_failed');
    assert.equal(events.length, 0, '可重试失败不应写不可重试事件');
  } finally {
    try {
      getDb().exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    } catch {
      /* ignore */
    }
    config.monitor.retryDelayMs = prevRetryDelay;
    await monitor.stop(user.id, { notify: false }).catch(() => {});
  }
});

test('每轮 getupdates 成功后更新 last_poll_at', async () => {
  const user = createUser({ wechatUserId: 'wx_touch_poll', token: 'token-touch-poll' });
  queueUpdates({ resp: { ret: 0, errcode: 0, msgs: [], get_updates_buf: '', longpolling_timeout_ms: 500 } });
  assert.equal(monitor.start(user.id), true);
  try {
    await waitFor(() => Number(store.getUserRow(user.id).last_poll_at) > 0);
  } finally {
    await monitor.stop(user.id, { notify: false }).catch(() => {});
  }
});
