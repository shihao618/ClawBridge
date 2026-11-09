/**
 * 回归测试：monitor.js（task-52 官方差异修复）
 *  - M1 凭据代际保护（换绑后旧 worker 不得写 buf/入站/暂停）；
 *  - -14 token 失效：暂停 1h 后 worker 继续轮询（不退出），恢复后清除 paused；
 *  - HTTP 401 但 body 非 -14：按普通失败退避，不冷却；
 *  - 退避计数清零（2s→2s→30s 节奏）；
 *  - longpolling_timeout_ms 原样使用（仅无效值回退）；
 *  - 有消息立即持久化游标 / 空闲轮询按 MONITOR_META_FLUSH_MS 节流写库；
 *  - 入站 message_id 回退 item.msg_id；
 *  - notifyStart/notifyStop ret!=0 只告警；
 *  - 入站文本顺序对齐官方（首个可识别 item 决定正文，媒体占位不带文件名）；
 *  - quote / partial-quote 最小解析（并入 raw_json）；
 *  - /echo slash 回显（source='slash'，不进入规则流水线）；
 *  - 冷却到期自动恢复（start 期间冷却 / resumePausedMonitors 重启兜底）。
 *
 * 使用本地假 iLink 服务（可控挂起 getupdates）+ 临时 DATA_DIR，无真实网络。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  /** notifyStart/notifyStop 返回的 ret（用于告警分支测试）。 */
  notifyStartRet: 0,
  notifyStopRet: 0,
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
    sendJson(res, 200, { ret: fakeState.notifyStartRet, errmsg: fakeState.notifyStartRet ? 'warn' : '' });
    return;
  }
  if (url.pathname === '/ilink/bot/msg/notifystop') {
    fakeState.notifyStops.push({ token, at: Date.now() });
    sendJson(res, 200, { ret: fakeState.notifyStopRet, errmsg: fakeState.notifyStopRet ? 'warn' : '' });
    return;
  }
  if (url.pathname === '/ilink/bot/getupdates') {
    fakeState.updateCalls.push({ token, at: Date.now() });
    try {
      fakeState.updateBodies.push(rawBody ? JSON.parse(rawBody) : {});
    } catch {
      fakeState.updateBodies.push({});
    }
    const entryIndex = fakeState.scriptedUpdates.findIndex((item) => !item.token || item.token === token);
    const entry = entryIndex >= 0 ? fakeState.scriptedUpdates.splice(entryIndex, 1)[0] : {};
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
const inboundQuote = await import('../../server/src/inbound-quote.js');
const store = await import('../../server/src/store.js');
const { config } = await import('../../server/src/config.js');
const { getDb } = await import('../../server/src/db.js');
const { decryptSecret } = await import('../../server/src/crypto.js');

test('历史游标防抖助手仍可导出（真实轮询已改为变化即落库）', () => {
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

/** 仅本文件内使用：直接统计某用户的出站队列（不依赖 dispatcher 实际发送）。 */
function outboxFor(userId, source = '') {
  const sql = source
    ? 'SELECT * FROM outbox WHERE user_id = ? AND source = ? ORDER BY rowid ASC'
    : 'SELECT * FROM outbox WHERE user_id = ? ORDER BY rowid ASC';
  return source ? getDb().prepare(sql).all(userId, source) : getDb().prepare(sql).all(userId);
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
  const staleEvents = store.listEvents(50).filter((event) => event.user_id === user.id && event.type === 'stale_token');
  assert.equal(staleEvents.length, 0, '旧 worker 的 -14 不得写 stale_token 事件');
});

// ---------------------------------------------------------------------------
// -14：暂停后继续轮询（OA-05）
// ---------------------------------------------------------------------------
test('当前凭据 -14：写 paused/stale_token 事件，冷却到期后 worker 继续轮询并清除 paused', async () => {
  const user = createUser({ wechatUserId: 'wx_monitor_gen_current_14', token: 'token-gen-current-14' });
  const prevPause = config.monitor.stalePauseMs;
  config.monitor.stalePauseMs = 120;
  try {
    queueUpdates({ token: 'token-gen-current-14', resp: { ret: -14, errcode: -14, errmsg: 'token expired' } });
    const callsBefore = fakeState.updateCalls.filter((call) => call.token === 'token-gen-current-14').length;
    assert.equal(monitor.start(user.id), true);
    // 第一次 -14 → 暂停 120ms → 第二次轮询成功（不退出 worker）
    await waitFor(
      () => fakeState.updateCalls.filter((call) => call.token === 'token-gen-current-14').length >= callsBefore + 2,
      { timeoutMs: 8000, intervalMs: 20 },
    );
    await waitFor(() => Number(store.getUserRow(user.id).pause_until) === 0, { timeoutMs: 5000 });
    assert.equal(monitor.isRunning(user.id), true, '冷却后 worker 应继续运行（不再退出）');
    const row = store.getUserRow(user.id);
    assert.equal(Number(row.pause_until), 0, '恢复轮询后应清除 paused');
    // 事件写入与 worker 恢复是同一轮异步流程，等待而不是立即断言，避免全量并发时抖动
    await waitFor(
      () => store.listEvents(200).some((event) => event.user_id === user.id && event.type === 'stale_token'),
      { timeoutMs: 5000 },
    );
    const staleEvents = store.listEvents(200).filter((event) => event.user_id === user.id && event.type === 'stale_token');
    assert.ok(staleEvents.length >= 1, '应写入 stale_token 事件');
  } finally {
    config.monitor.stalePauseMs = prevPause;
    await monitor.stop(user.id, { notify: false }).catch(() => {});
  }
});

test('HTTP 401 + body ret=-14：仍视为 token 失效并冷却（冷却后继续轮询）', async () => {
  const token = 'token-monitor-http-401-stale';
  const user = createUser({ wechatUserId: 'wx_monitor_http_401_stale', token });
  const prevPause = config.monitor.stalePauseMs;
  config.monitor.stalePauseMs = 100;
  try {
    queueUpdates({ token, status: 401, resp: { ret: -14, errcode: -14, errmsg: 'token expired' } });
    const callsBefore = fakeState.updateCalls.filter((call) => call.token === token).length;
    assert.equal(monitor.start(user.id), true);
    await waitFor(() => fakeState.updateCalls.filter((call) => call.token === token).length >= callsBefore + 2, {
      timeoutMs: 8000,
    });
    await waitFor(() => Number(store.getUserRow(user.id).pause_until) === 0, { timeoutMs: 5000 });
    const row = store.getUserRow(user.id);
    assert.equal(Number(row.pause_until), 0, '恢复轮询后应清除 paused');
    // 事件写入与 worker 恢复是同一轮异步流程，等待而不是立即断言，避免全量并发时抖动
    await waitFor(
      () => store.listEvents(200).some((event) => event.user_id === user.id && event.type === 'stale_token'),
      { timeoutMs: 5000 },
    );
    const staleEvents = store.listEvents(200).filter((event) => event.user_id === user.id && event.type === 'stale_token');
    assert.ok(staleEvents.length >= 1, '应写入 stale_token 事件');
  } finally {
    config.monitor.stalePauseMs = prevPause;
    await monitor.stop(user.id, { notify: false }).catch(() => {});
  }
});

test('HTTP 401 但 body 非 -14：不冷却、按普通失败退避后继续轮询（OA-21）', async () => {
  const token = 'token-monitor-http-401-normal';
  const user = createUser({ wechatUserId: 'wx_monitor_http_401_normal', token });
  const prevRetry = config.monitor.retryDelayMs;
  config.monitor.retryDelayMs = 30;
  try {
    queueUpdates({ token, status: 401, resp: { ret: 1, errcode: 1, errmsg: 'unauthorized' } });
    const callsBefore = fakeState.updateCalls.filter((call) => call.token === token).length;
    assert.equal(monitor.start(user.id), true);
    await waitFor(() => fakeState.updateCalls.filter((call) => call.token === token).length >= callsBefore + 2, {
      timeoutMs: 8000,
    });
    assert.equal(monitor.isRunning(user.id), true);
    const row = store.getUserRow(user.id);
    assert.equal(Number(row.pause_until), 0, 'HTTP 401 非 -14 不得进入冷却');
    const staleEvents = store.listEvents(50).filter((event) => event.user_id === user.id && event.type === 'stale_token');
    assert.equal(staleEvents.length, 0, 'HTTP 401 非 -14 不得写 stale_token 事件');
  } finally {
    config.monitor.retryDelayMs = prevRetry;
    await monitor.stop(user.id, { notify: false }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 纯函数：退避节奏 / longpolling_timeout_ms
// ---------------------------------------------------------------------------
test('computeBackoff：2s→2s→30s 后清零计数，重新从 2s 开始', () => {
  const opts = { maxFailures: 3, backoffMs: 30_000, retryDelayMs: 2_000 };
  assert.deepEqual(monitor.computeBackoff(1, opts), { delayMs: 2000, nextFailures: 1 });
  assert.deepEqual(monitor.computeBackoff(2, opts), { delayMs: 2000, nextFailures: 2 });
  assert.deepEqual(monitor.computeBackoff(3, opts), { delayMs: 30000, nextFailures: 0 }, '第 3 次失败后清零');
  assert.deepEqual(monitor.computeBackoff(1, opts), { delayMs: 2000, nextFailures: 1 }, '清零后重新从 2s 开始');
});

test('resolveLongPollTimeout：合法服务端值原样使用，仅无效值回退', () => {
  assert.equal(monitor.resolveLongPollTimeout(500, 35000), 500, '小于 1s 的合法值原样使用（官方语义）');
  assert.equal(monitor.resolveLongPollTimeout(300000, 35000), 300000, '大于 120s 的合法值原样使用');
  assert.equal(monitor.resolveLongPollTimeout(0, 35000), 35000);
  assert.equal(monitor.resolveLongPollTimeout(-1, 35000), 35000);
  assert.equal(monitor.resolveLongPollTimeout('abc', 35000), 35000);
  assert.equal(monitor.resolveLongPollTimeout(undefined, 35000), 35000);
});

// ---------------------------------------------------------------------------
// OA-06/OA-08：退避与游标
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

test('有消息时游标立即持久化（不等空闲节流），且下一次请求携带新游标', async () => {
  const token = 'token-monitor-cursor-immediate';
  const user = createUser({ wechatUserId: 'wx_monitor_cursor_immediate', token });
  // 先制造一个较新的 last_poll_at，确保不是“首次轮询必写”导致通过
  store.touchPoll(user.id, Date.now());
  queueUpdates({
    resp: {
      ret: 0,
      errcode: 0,
      errmsg: '',
      msgs: [
        {
          message_id: '9007199254740999',
          from_user_id: 'wx_monitor_cursor_immediate',
          create_time_ms: Date.now(),
          item_list: [{ type: 1, text_item: { text: '触发立即落盘的消息' } }],
        },
      ],
      get_updates_buf: 'immediate-cursor-buf',
      longpolling_timeout_ms: 300,
    },
  });
  const callsBefore = fakeState.updateCalls.filter((call) => call.token === token).length;
  assert.equal(monitor.start(user.id), true);
  try {
    await waitFor(() => fakeState.updateCalls.filter((call) => call.token === token).length >= callsBefore + 2, {
      timeoutMs: 8000,
    });
    assert.equal(
      store.getUserRow(user.id).get_updates_buf,
      'immediate-cursor-buf',
      '有消息的响应应立即持久化游标（不等 metaFlushMs）',
    );
    const bodies = fakeState.updateBodies.filter(Boolean);
    assert.ok(
      bodies.some((body) => body.get_updates_buf === 'immediate-cursor-buf'),
      '下一次 getupdates 应携带新游标',
    );
  } finally {
    await monitor.stop(user.id, { notify: false }).catch(() => {});
  }
});

test('空闲轮询：空响应游标按 metaFlushMs 节流写库，到期后才落盘', async () => {
  const prev = config.monitor.metaFlushMs;
  config.monitor.metaFlushMs = 120;
  const token = 'token-monitor-cursor-idle';
  const user = createUser({ wechatUserId: 'wx_monitor_cursor_idle', token });
  store.touchPoll(user.id, Date.now());
  queueUpdates({
    resp: { ret: 0, errcode: 0, errmsg: '', msgs: [], get_updates_buf: 'idle-cursor-buf', longpolling_timeout_ms: 60 },
  });
  const callsBefore = fakeState.updateCalls.filter((call) => call.token === token).length;
  assert.equal(monitor.start(user.id), true);
  try {
    await waitFor(() => fakeState.updateCalls.filter((call) => call.token === token).length >= callsBefore + 2, {
      timeoutMs: 8000,
    });
    // 内存游标已经推进（下一次请求带上新 buf），但空闲响应不立即写 DB
    const bodies = fakeState.updateBodies.filter(Boolean);
    assert.ok(
      bodies.some((body) => body.get_updates_buf === 'idle-cursor-buf'),
      '内存游标应推进到下一次请求',
    );
    // 节流到期后应落盘（等待下一次空闲轮询触发 flush）
    await waitFor(() => store.getUserRow(user.id).get_updates_buf === 'idle-cursor-buf', { timeoutMs: 5000 });
  } finally {
    config.monitor.metaFlushMs = prev;
    await monitor.stop(user.id, { notify: false }).catch(() => {});
  }
});

test('空闲轮询：较新的 last_poll_at 不会被每轮 UPDATE 覆盖（只按 metaFlushMs 写）', async () => {
  const prev = config.monitor.metaFlushMs;
  config.monitor.metaFlushMs = 60000;
  const token = 'token-monitor-poll-throttle';
  const user = createUser({ wechatUserId: 'wx_monitor_poll_throttle', token });
  const baseline = Date.now() - 10_000;
  store.touchPoll(user.id, baseline);
  queueUpdates({
    resp: { ret: 0, errcode: 0, errmsg: '', msgs: [], get_updates_buf: '', longpolling_timeout_ms: 60 },
  });
  const callsBefore = fakeState.updateCalls.filter((call) => call.token === token).length;
  assert.equal(monitor.start(user.id), true);
  try {
    await waitFor(() => fakeState.updateCalls.filter((call) => call.token === token).length >= callsBefore + 2, {
      timeoutMs: 8000,
    });
    assert.equal(Number(store.getUserRow(user.id).last_poll_at), baseline, '空闲轮询不应每轮写 last_poll_at');
  } finally {
    config.monitor.metaFlushMs = prev;
    await monitor.stop(user.id, { notify: false }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// OA-09：入站 message_id 回退
// ---------------------------------------------------------------------------
test('入站 message_id 回退 item_list[].msg_id；顶层空白也回退', () => {
  assert.equal(monitor.resolveInboundMessageId({ message_id: ' 1001 ', item_list: [] }), '1001');
  assert.equal(monitor.resolveInboundMessageId({ message_id: '', item_list: [{ msg_id: ' 2002 ' }] }), '2002');
  assert.equal(monitor.resolveInboundMessageId({ item_list: [{ msg_id: '' }, { msg_id: '3003' }] }), '3003');
  assert.equal(monitor.resolveInboundMessageId({ message_id: '  ', item_list: [{ type: 1 }] }), '');
  assert.equal(monitor.resolveInboundMessageId({}), '');
});

test('processMessages：顶层无 message_id 时用 item.msg_id 落库，仍可去重', async () => {
  const user = createUser({ wechatUserId: 'wx_monitor_item_msgid', token: 'token-item-msgid' });
  const message = {
    from_user_id: 'wx_monitor_item_msgid',
    create_time_ms: Date.now(),
    item_list: [{ type: 1, msg_id: 'item-msg-77', text_item: { text: '带 item msg_id 的消息' } }],
  };
  const outcome = await monitor.processMessages(user.id, [message]);
  assert.equal(outcome.saved, 1);
  const row = getDb()
    .prepare('SELECT wechat_message_id, text FROM inbound_messages WHERE user_id = ?')
    .get(user.id);
  assert.equal(row.wechat_message_id, 'item-msg-77');
  assert.equal(row.text, '带 item msg_id 的消息');
});

// ---------------------------------------------------------------------------
// OA-22：notify ret!=0 只告警、不影响轮询
// ---------------------------------------------------------------------------
test('notifyStart/notifyStop ret!=0 只告警，不阻塞启动/停止', async () => {
  const token = 'token-monitor-notify-ret';
  const user = createUser({ wechatUserId: 'wx_monitor_notify_ret', token });
  fakeState.notifyStartRet = 5;
  fakeState.notifyStopRet = 7;
  const startsBefore = fakeState.notifyStarts.length;
  const callsBefore = fakeState.updateCalls.filter((call) => call.token === token).length;
  try {
    assert.equal(monitor.start(user.id), true);
    await waitFor(() => fakeState.updateCalls.filter((call) => call.token === token).length > callsBefore, {
      timeoutMs: 8000,
    });
    assert.equal(monitor.isRunning(user.id), true, 'notifyStart ret!=0 不应阻塞轮询');
    assert.ok(fakeState.notifyStarts.length > startsBefore);
    assert.equal(await monitor.stop(user.id), true, 'notifyStop ret!=0 不应导致 stop 失败');
  } finally {
    fakeState.notifyStartRet = 0;
    fakeState.notifyStopRet = 0;
    await monitor.stop(user.id, { notify: false }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// OA-23：入站文本顺序对齐官方
// ---------------------------------------------------------------------------
test('extractMessageText：按 item 顺序首个可识别项决定正文，媒体占位不带文件名', () => {
  const text = (itemList) => monitor.extractMessageText({ item_list: itemList });
  assert.equal(text([{ type: 1, text_item: { text: '你好' } }]), '你好');
  assert.equal(
    text([{ type: 2, image_item: {} }, { type: 1, text_item: { text: '图文' } }]),
    '[图片]',
    '按官方顺序：首个媒体项即决定正文（不再优先取后面的文本）',
  );
  assert.equal(text([{ type: 3, voice_item: { text: '语音转写内容' } }]), '语音转写内容');
  assert.equal(text([{ type: 2, image_item: {} }]), '[图片]');
  assert.equal(text([{ type: 3, voice_item: { text: '   ' } }]), '   ', '语音 text 为任意非空字符串时官方直接使用');
  assert.equal(text([{ type: 3, voice_item: {} }]), '[语音]');
  assert.equal(text([{ type: 4, file_item: { file_name: 'a.pdf' } }]), '[文件]', '媒体占位不带文件名');
  assert.equal(text([{ type: 4, file_item: {} }]), '[文件]');
  assert.equal(text([{ type: 5, video_item: {} }]), '[视频]');
  assert.equal(text([{ type: 11 }]), '[工具调用]', '工具调用占位为平台附加回退');
  assert.equal(text([{ type: 12 }]), '[工具调用]');
  assert.equal(text([{ type: 99 }]), '');
  assert.equal(text([]), '');
  assert.equal(monitor.extractMessageText({}), '');
});

// ---------------------------------------------------------------------------
// OA-10：quote / partial-quote 最小解析
// ---------------------------------------------------------------------------
test('extractBodyFromItemList：官方 bodyFromItemList 顺序（TEXT > 语音 text > 媒体占位）', () => {
  assert.equal(inboundQuote.extractBodyFromItemList([]), '');
  assert.equal(inboundQuote.extractBodyFromItemList([{ type: 2 }, { type: 1, text_item: { text: '后置文本' } }]), '[图片]');
  assert.equal(inboundQuote.extractBodyFromItemList([{ type: 3, voice_item: { text: '转写' } }, { type: 1, text_item: { text: '文本' } }]), '转写');
  assert.equal(inboundQuote.extractBodyFromItemList([{ type: 1, text_item: { text: 0 } }]), '0');
});

test('extractQuotedMessage：title/message_item/partial_text/svr_id 解析', () => {
  const message = {
    message_id: '100',
    item_list: [
      {
        type: 1,
        text_item: { text: '这个问题' },
        ref_msg: {
          title: '引用标题',
          svr_id: '9001',
          message_item: {
            msg_id: '9002',
            item_list: [{ type: 1, text_item: { text: '被引用的原消息' } }],
          },
          partial_text: { start: '被引用', end: '消息', startindex: 1, endindex: 2, quotemd5: 'ABC' },
        },
      },
    ],
  };
  const quote = inboundQuote.extractQuotedMessage(message);
  assert.ok(quote);
  assert.equal(quote.replyToId, '9001', 'svr_id 优先');
  assert.equal(quote.title, '引用标题');
  assert.equal(quote.body, '被引用的原消息');
  assert.equal(quote.quotedText, '引用标题 | 被引用的原消息');
  assert.equal(quote.media, null);
  assert.deepEqual(quote.partialQuote, { start: '被引用', end: '消息', startindex: 1, endindex: 2, quotemd5: 'abc' });

  // 无 svr_id 时回退 message_item.msg_id；媒体引用只提取元数据
  const mediaQuote = inboundQuote.extractQuotedMessage({
    item_list: [
      {
        type: 2,
        ref_msg: {
          message_item: { msg_id: ' 9003 ', item_list: [{ type: 4, file_item: { file_name: '报告.pdf', media: { aes_key: 'SECRET' } } }] },
        },
      },
    ],
  });
  assert.equal(mediaQuote.replyToId, '9003');
  assert.equal(mediaQuote.quotedText, '[文件]');
  assert.deepEqual(mediaQuote.media, { kind: 'file', itemType: 4, fileName: '报告.pdf' });
  assert.equal(inboundQuote.extractQuotedMessage({ item_list: [{ type: 1, text_item: { text: 'x' } }] }), null);
});

test('resolvePartialQuote：global/relative 两种 endindex 解释 + quotemd5 消歧', () => {
  const fullText = 'prefix-aaa-bbb-aaa-bbb-suffix';
  const partial = { start: 'aaa', end: 'bbb', startindex: 0, endindex: 0 };
  assert.deepEqual(inboundQuote.resolvePartialQuote(fullText, partial), { resolved: 'aaa-bbb', fallback: false });
  const hash = crypto.createHash('md5').update('aaa-bbb-aaa-bbb', 'utf8').digest('hex');
  const hashed = { ...partial, endindex: 1, quotemd5: hash };
  assert.deepEqual(inboundQuote.resolvePartialQuote(fullText, hashed), { resolved: 'aaa-bbb-aaa-bbb', fallback: false });
  assert.equal(inboundQuote.resolvePartialQuote('', partial).fallback, true);
  assert.equal(inboundQuote.resolvePartialQuote(fullText, { start: '', end: '' }).fallback, true);
  const wrongHash = { ...partial, quotemd5: 'deadbeef' };
  assert.equal(inboundQuote.resolvePartialQuote(fullText, wrongHash).resolved, null);
});

test('processMessages：引用信息并入 raw_json，且不泄漏 aes_key/context_token 明文', async () => {
  const user = createUser({ wechatUserId: 'wx_monitor_quote_raw', token: 'token-quote-raw' });
  const secretContext = 'QUOTE_SECRET_CONTEXT_TOKEN';
  const secretAesKey = 'QUOTE_SECRET_AES_KEY';
  const message = {
    message_id: 'quote-msg-1',
    from_user_id: 'wx_monitor_quote_raw',
    create_time_ms: Date.now(),
    context_token: secretContext,
    item_list: [
      {
        type: 1,
        text_item: { text: '请回答我引用的内容' },
        ref_msg: {
          title: '上一条',
          svr_id: 'q-9001',
          message_item: { msg_id: 'q-9002', item_list: [{ type: 2, image_item: { media: { aes_key: secretAesKey } } }] },
          partial_text: { start: '上一条', end: '图片', startindex: 0, endindex: 0 },
        },
      },
    ],
  };
  await monitor.processMessages(user.id, [message]);
  const row = getDb().prepare('SELECT raw_json, text FROM inbound_messages WHERE user_id = ?').get(user.id);
  assert.ok(row);
  const raw = JSON.parse(row.raw_json);
  assert.ok(raw._quote, 'raw_json 应并入解析后的 _quote');
  assert.equal(raw._quote.replyToId, 'q-9001');
  assert.equal(raw._quote.quotedText, '上一条 | [图片]');
  assert.deepEqual(raw._quote.media, { kind: 'image', itemType: 2, fileName: '' });
  assert.ok(raw._quote.partialQuote, '应保留 partial_text 解析结果');
  assert.ok(raw.item_list[0].ref_msg, '原始 ref_msg 字段应保留');
  assert.equal(row.text, '请回答我引用的内容', '引用信息不改变规则匹配正文');
  assert.equal(row.raw_json.includes(secretContext), false, 'context_token 不得明文');
  assert.equal(row.raw_json.includes(secretAesKey), false, 'aes_key 不得明文');
});

// ---------------------------------------------------------------------------
// OA-12：/echo slash 指令
// ---------------------------------------------------------------------------
test('parseEchoCommand：只处理 /echo（大小写不敏感），其它命令不处理', () => {
  assert.deepEqual(monitor.parseEchoCommand('/echo 你好'), { handled: true, command: '/echo', reply: '你好' });
  assert.deepEqual(monitor.parseEchoCommand('/ECHO hi'), { handled: true, command: '/echo', reply: 'hi' });
  assert.deepEqual(monitor.parseEchoCommand('/echo'), { handled: true, command: '/echo', reply: '（空）' });
  assert.deepEqual(monitor.parseEchoCommand('/toggle-debug'), { handled: false, command: '/toggle-debug', reply: '' });
  assert.deepEqual(monitor.parseEchoCommand('/echoes 不匹配'), { handled: false, command: '/echoes', reply: '' });
  assert.deepEqual(monitor.parseEchoCommand('普通消息'), { handled: false, command: '', reply: '' });
});

test('processMessages：/echo 回显入队 source=slash，且不进入规则流水线', async () => {
  const user = createUser({ wechatUserId: 'wx_monitor_echo', token: 'token-echo-user' });
  const outcome = await monitor.processMessages(user.id, [
    {
      message_id: 'echo-msg-1',
      from_user_id: 'wx_monitor_echo',
      create_time_ms: Date.now(),
      item_list: [{ type: 1, text_item: { text: '/echo 你好，世界' } }],
    },
    {
      message_id: 'echo-msg-2',
      from_user_id: 'wx_monitor_echo',
      create_time_ms: Date.now() + 1,
      item_list: [{ type: 1, text_item: { text: '/ECHO hi' } }],
    },
    {
      message_id: 'echo-msg-3',
      from_user_id: 'wx_monitor_echo',
      create_time_ms: Date.now() + 2,
      item_list: [{ type: 1, text_item: { text: '/echo' } }],
    },
  ]);
  assert.equal(outcome.saved, 3);
  const rows = outboxFor(user.id, 'slash');
  assert.deepEqual(rows.map((row) => row.text), ['你好，世界', 'hi', '（空）']);
  const inbound = getDb().prepare('SELECT text FROM inbound_messages WHERE user_id = ? ORDER BY received_at ASC, rowid ASC').all(user.id);
  assert.deepEqual(inbound.map((row) => row.text), ['/echo 你好，世界', '/ECHO hi', '/echo'], '入站原文仍按官方保存');
  // 不进入规则流水线：无 app_rule_logs 记录（规则引擎未被调用）
  await sleep(30);
  const logs = getDb().prepare('SELECT COUNT(*) AS n FROM app_rule_logs WHERE user_id = ?').get(user.id);
  assert.equal(logs.n, 0, '/echo 不应进入规则流水线');
});

// ---------------------------------------------------------------------------
// 冷却到期自动恢复（start 期间冷却 / 重启兜底 resumePausedMonitors）
// ---------------------------------------------------------------------------
test('start() 遇到冷却中的账号：安排冷却到期自动恢复监控', async () => {
  const token = 'token-monitor-resume-start';
  const user = createUser({ wechatUserId: 'wx_monitor_resume_start', token });
  store.setUserPaused(user.id, Date.now() + 150, '冷却中');
  const callsBefore = fakeState.updateCalls.filter((call) => call.token === token).length;
  try {
    assert.equal(monitor.start(user.id), false, '冷却中 start 返回 false（已安排自动恢复）');
    await waitFor(() => monitor.isRunning(user.id) === true, { timeoutMs: 5000, intervalMs: 20 });
    await waitFor(() => fakeState.updateCalls.filter((call) => call.token === token).length > callsBefore, { timeoutMs: 5000 });
  } finally {
    await monitor.stop(user.id, { notify: false }).catch(() => {});
    store.clearUserPause(user.id);
  }
});

test('resumePausedMonitors（重启兜底）：恢复 pause_until 已到期的 active 账号', async () => {
  const token = 'token-monitor-resume-sweep';
  const user = createUser({ wechatUserId: 'wx_monitor_resume_sweep', token });
  // 模拟进程重启前留下的已到期冷却记录（index.restoreMonitors 的查询会排除 pause_until>now 的用户）
  store.setUserPaused(user.id, Date.now() - 10, '冷却已到期');
  const callsBefore = fakeState.updateCalls.filter((call) => call.token === token).length;
  try {
    const started = monitor.resumePausedMonitors();
    assert.ok(started >= 1, `应至少启动 1 个冷却到期账号（实际 ${started}）`);
    await waitFor(() => monitor.isRunning(user.id) === true, { timeoutMs: 5000, intervalMs: 20 });
    await waitFor(() => fakeState.updateCalls.filter((call) => call.token === token).length > callsBefore, { timeoutMs: 5000 });
  } finally {
    // 兜底：resumePausedMonitors 可能同时恢复其它测试残留的已到期账号，这里统一停掉，避免污染后续用例。
    await monitor.stopAll({ notify: false }).catch(() => {});
    store.clearUserPause(user.id);
  }
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
