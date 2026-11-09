/**
 * 单元测试：dispatcher 发送失败用户提示（OA-11）与 HTTP 401 语义（OA-21）。
 *
 * 本地假 iLink（无真实网络）；覆盖：
 *  - 永久失败（达到最大重试次数）时 best-effort 发送一条简短失败提示：只发一次、不进入 outbox、不重试；
 *  - 提示发送失败不抛错、不影响 outbox 终态、不循环重试；
 *  - -14（token 失效）与 prepare failed（context_token 失效）不发送提示；
 *  - HTTP 401 但 body 非 -14：不冷却账号、按普通失败退避重试；body 含 -14 才暂停；
 *  - 开关 PUSH_ERROR_NOTICE_ENABLED 默认 true，settings push 组字段 errorNoticeEnabled 可关闭（即时生效）。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after } from 'node:test';
import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

// ---------------------------------------------------------------------------
// 假 iLink：仅处理 /ilink/bot/sendmessage
// ---------------------------------------------------------------------------
const state = {
  /** @type {Array<{kind:'text'|'notice', text:string, toUserId:string, at:number}>} */
  requests: [],
  /** @type {Array<{target:'text'|'notice', times:number, ret?:number, errmsg?:string, httpStatus?:number}>} */
  failures: [],
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  if (url.pathname !== '/ilink/bot/sendmessage') {
    sendJson(res, 404, { ret: -1, errmsg: 'not found' });
    return;
  }
  const body = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : {};
  const msg = body?.msg ?? {};
  const text = String(msg?.item_list?.[0]?.text_item?.text ?? '');
  const kind = text.includes('消息发送失败') ? 'notice' : 'text';
  state.requests.push({ kind, text, toUserId: String(msg?.to_user_id ?? ''), at: Date.now() });
  const failure = state.failures.find((entry) => entry.target === kind && entry.times > 0);
  if (failure) {
    failure.times -= 1;
    sendJson(res, failure.httpStatus ?? 200, {
      ret: failure.ret ?? -1,
      errmsg: failure.errmsg ?? 'mock send failure',
      message_id: 'msg_failure',
    });
    return;
  }
  sendJson(res, 200, { ret: 0, message_id: `msg_ok_${state.requests.length}`, errmsg: '' });
});

await new Promise((resolve, reject) => {
  fake.once('error', reject);
  fake.listen(0, '127.0.0.1', resolve);
});
const fakeBase = `http://127.0.0.1:${fake.address().port}`;

// 必须在 import 业务模块前设置
const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-dispatcher-errors-',
  env: {
    APP_SECRET: 'dispatcher-errors-secret-0123456789abcdef0123456789abcdef',
    ADMIN_PASSWORD: 'dispatcher-errors-password',
    API_TOKEN: 'dispatcher-errors-token',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: '50',
    RATE_LIMIT_WINDOW_MS: '300000',
    PUSH_MAX_ATTEMPTS: '5',
    PUSH_RETRY_DELAYS_MS: '10',
  },
});

const store = await import('../../server/src/store.js');
const dispatcher = await import('../../server/src/dispatcher.js');
const { config } = await import('../../server/src/config.js');
const { getDb } = await import('../../server/src/db.js');
const settingsSchema = await import('../../server/src/settings/schema.js');

after(async () => {
  try {
    await dispatcher.stop({ timeoutMs: 100 });
  } catch {
    /* 忽略 */
  }
  fake.closeAllConnections?.();
  await new Promise((resolve) => fake.close(resolve));
  await cleanupUnitEnv(unitEnv);
});

let seq = 0;
function createUser() {
  seq += 1;
  const { user } = store.upsertBoundUser({
    wechatUserId: `wx_dispatcher_errors_${seq}`,
    displayName: `失败提示用户${seq}`,
    ilinkBotId: `bot_dispatcher_errors_${seq}@im.bot`,
    botToken: `dispatcher-errors-token-${seq}`,
    baseUrl: fakeBase,
  });
  dispatcher.resetRateLimit(user.id);
  return user;
}

function outboxRow(userId) {
  return getDb().prepare('SELECT * FROM outbox WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').get(userId);
}

function outboxCount(userId) {
  return Number(
    getDb().prepare('SELECT COUNT(*) AS c FROM outbox WHERE user_id = ?').get(userId).c,
  );
}

async function waitFor(predicate, { timeoutMs = 3000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
}

function resetFake() {
  state.requests.length = 0;
  state.failures.length = 0;
}

test('配置/运行配置：PUSH_ERROR_NOTICE_ENABLED 默认 true；settings push 组含 errorNoticeEnabled（默认 true、即时生效）', () => {
  assert.equal(config.push.errorNoticeEnabled, true);
  const field = settingsSchema.FIELD_BY_KEY.get('push.errorNoticeEnabled');
  assert.ok(field, 'settings 应包含 push.errorNoticeEnabled');
  assert.equal(field.type, 'boolean');
  assert.equal(field.label, '发送失败时通知用户');
  assert.deepEqual(field.configPath, ['push', 'errorNoticeEnabled']);
  assert.equal(field.restartRequired, undefined, '未声明 restartRequired 表示即时生效');
  assert.equal(settingsSchema.DEFAULTS.get('push.errorNoticeEnabled'), true);
});

test('永久失败（达到最大重试次数）：best-effort 发一次简短失败提示，不入队、不重试、不重复', async () => {
  resetFake();
  const originalMaxAttempts = config.push.maxAttempts;
  config.push.maxAttempts = 1;
  try {
    const user = createUser();
    state.failures.push({ target: 'text', times: 1, ret: -1, errmsg: 'mock permanent failure' });
    store.enqueueMessage({ userId: user.id, text: '会失败的消息', source: 'admin' });

    assert.equal(await dispatcher.processOne(Date.now()), true);
    await waitFor(() => state.requests.some((item) => item.kind === 'notice'), { label: '用户收到失败提示' });

    const row = outboxRow(user.id);
    assert.equal(row.status, 'failed', 'outbox 应永久失败');
    assert.equal(row.attempts, 1);
    assert.equal(outboxCount(user.id), 1, '失败提示不得进入 outbox 队列');
    const notices = state.requests.filter((item) => item.kind === 'notice');
    assert.equal(notices.length, 1, '同一 outbox 只提示一次');
    assert.match(notices[0].text, /^⚠️ 消息发送失败/, `提示文案应为简短失败提示：${notices[0].text}`);
    assert.doesNotMatch(notices[0].text, /mock permanent failure/, '提示不应泄漏内部错误细节');
    assert.equal(notices[0].toUserId, user.wechatUserId);

    // 再跑一轮（无候选）不应重复提示
    assert.equal(await dispatcher.processOne(Date.now()), false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(state.requests.filter((item) => item.kind === 'notice').length, 1);
  } finally {
    config.push.maxAttempts = originalMaxAttempts;
  }
});

test('失败提示本身发送失败：不抛错、只发一次、不循环重试，outbox 仍为 failed', async () => {
  resetFake();
  const originalMaxAttempts = config.push.maxAttempts;
  config.push.maxAttempts = 1;
  try {
    const user = createUser();
    state.failures.push({ target: 'text', times: 1, ret: -1, errmsg: 'send failed' });
    state.failures.push({ target: 'notice', times: 1, httpStatus: 500, ret: -1, errmsg: 'notice failed' });
    store.enqueueMessage({ userId: user.id, text: '会失败的消息 2', source: 'admin' });

    assert.equal(await dispatcher.processOne(Date.now()), true);
    await waitFor(() => state.requests.some((item) => item.kind === 'notice'), { label: '发出一次提示尝试' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(outboxRow(user.id).status, 'failed');
    assert.equal(state.requests.filter((item) => item.kind === 'notice').length, 1, '提示失败不应重试');
  } finally {
    config.push.maxAttempts = originalMaxAttempts;
  }
});

test('-14（token 失效）：暂停账号且不发失败提示（无法保证送达）', async () => {
  resetFake();
  const user = createUser();
  state.failures.push({ target: 'text', times: 1, ret: -14, errmsg: 'token stale' });
  store.enqueueMessage({ userId: user.id, text: 'token 失效消息', source: 'admin' });

  assert.equal(await dispatcher.processOne(Date.now()), true);
  const row = outboxRow(user.id);
  assert.equal(row.status, 'failed');
  const userRow = getDb().prepare('SELECT pause_until FROM users WHERE id = ?').get(user.id);
  assert.ok(Number(userRow.pause_until) > Date.now(), '账号应进入冷却');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(state.requests.filter((item) => item.kind === 'notice').length, 0);
});

test('prepare failed（context_token 失效）：直接 failed，不发失败提示', async () => {
  resetFake();
  const user = createUser();
  state.failures.push({ target: 'text', times: 1, ret: -2, errmsg: 'prepare failed' });
  store.enqueueMessage({ userId: user.id, text: 'prepare failed 消息', source: 'admin' });

  assert.equal(await dispatcher.processOne(Date.now()), true);
  assert.equal(outboxRow(user.id).status, 'failed');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(state.requests.filter((item) => item.kind === 'notice').length, 0);
});

test('开关关闭：永久失败不发送失败提示', async () => {
  resetFake();
  const originalMaxAttempts = config.push.maxAttempts;
  const originalNotice = config.push.errorNoticeEnabled;
  config.push.maxAttempts = 1;
  config.push.errorNoticeEnabled = false;
  try {
    const user = createUser();
    state.failures.push({ target: 'text', times: 1, ret: -1, errmsg: 'permanent failure' });
    store.enqueueMessage({ userId: user.id, text: '关闭提示的消息', source: 'admin' });
    assert.equal(await dispatcher.processOne(Date.now()), true);
    assert.equal(outboxRow(user.id).status, 'failed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(state.requests.filter((item) => item.kind === 'notice').length, 0);
  } finally {
    config.push.maxAttempts = originalMaxAttempts;
    config.push.errorNoticeEnabled = originalNotice;
  }
});

test('HTTP 401 + body 含 -14：视为 token 失效，暂停账号且不提示', async () => {
  resetFake();
  const user = createUser();
  state.failures.push({ target: 'text', times: 1, httpStatus: 401, ret: -14, errmsg: 'stale token' });
  store.enqueueMessage({ userId: user.id, text: '401 -14 消息', source: 'admin' });

  assert.equal(await dispatcher.processOne(Date.now()), true);
  assert.equal(outboxRow(user.id).status, 'failed');
  const userRow = getDb().prepare('SELECT pause_until FROM users WHERE id = ?').get(user.id);
  assert.ok(Number(userRow.pause_until) > Date.now(), 'body 含 -14 时应冷却');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(state.requests.filter((item) => item.kind === 'notice').length, 0);
});

test('HTTP 401 但 body 非 -14：不冷却、不发提示，按普通失败退避重试', async () => {
  resetFake();
  const user = createUser();
  state.failures.push({ target: 'text', times: 1, httpStatus: 401, ret: -1, errmsg: 'gateway unauthorized' });
  store.enqueueMessage({ userId: user.id, text: '401 非 -14 消息', source: 'admin' });

  assert.equal(await dispatcher.processOne(Date.now()), true);
  const row = outboxRow(user.id);
  assert.equal(row.status, 'queued', 'HTTP 401 非 -14 应按普通失败重试');
  assert.equal(row.attempts, 1);
  const userRow = getDb().prepare('SELECT pause_until FROM users WHERE id = ?').get(user.id);
  assert.ok(!(Number(userRow.pause_until) > Date.now()), '不应因 HTTP 401 误冷却账号');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(state.requests.filter((item) => item.kind === 'notice').length, 0, '非永久失败不发提示');
});

test('媒体附件不存在（发送前预检查永久失败）：向用户发一次失败提示', async () => {
  resetFake();
  const user = createUser();
  const queued = store.enqueueMessage({ userId: user.id, text: '坏附件消息', mediaId: 'att_not_exist' });

  assert.equal(await dispatcher.processOne(Date.now()), true);
  const row = store.getOutbox(queued.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 0, '发送前预检查失败不应增加 attempts');
  await waitFor(() => state.requests.some((item) => item.kind === 'notice'), { label: '附件缺失也要提示用户' });
  assert.equal(state.requests.filter((item) => item.kind === 'notice').length, 1);
  assert.equal(outboxCount(user.id), 1, '失败提示不得进入 outbox 队列');
});

