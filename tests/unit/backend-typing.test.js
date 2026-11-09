/**
 * 单元测试：typing.js —— 规则命中期间的微信「正在输入」状态（docs/PROTOCOL.md §5.6）。
 *
 * 参数语义对齐官方微信插件（v1.0.5）：
 * - 5s 续期（keepaliveIntervalMs=5000）；
 * - typing_ticket **按 userId** 缓存：24h 随机刷新 + 失败 2s 起指数退避（x2，最大 1h），空 ticket 缓存；
 * - getconfig/sendtyping 超时固定 10_000ms（官方 DEFAULT_CONFIG_TIMEOUT_MS）；
 * - start/stop 语义：结束立即 status=2，无最小可见时长/延迟取消。
 *
 * 注入 fake getConfig/sendTyping/now（不触真实网络/不等真实时间），覆盖：
 * begin→status1 / end→status2（立即）、刷新定时、实时开关、无 token/无 wechatUserId 静默、
 * getconfig/sendtyping 失败不影响、引用计数、24h 缓存（按 userId，含不同 baseUrl 复用）、
 * 失败指数退避（含 1h 上限）、空 ticket 不 sendTyping、未知/重复 handle 安全、超时参数 10s。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-typing-',
  env: {
    APP_SECRET: 'typing-secret-0123456789abcdef0123456789abcdef',
    ADMIN_PASSWORD: 'typing-password',
    API_TOKEN: 'typing-token',
    LOG_LEVEL: 'silent',
    // 本文件显式开启；其余单测默认关闭（tests/helpers/unit-env.mjs）
    APP_RULE_TYPING_INDICATOR: '1',
    APP_RULE_TYPING_REFRESH_MS: '5000',
  },
});

const { config } = await import('../../server/src/config.js');
const typing = await import('../../server/src/typing.js');
const store = await import('../../server/src/store.js');

test.after(async () => {
  typing.resetTypingDependencies();
  typing.clearTypingState();
  await cleanupUnitEnv(unitEnv);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** fake 依赖调用记录。 */
const calls = {
  getConfig: [],
  sendTyping: [],
};

let failGetConfig = false;
let failSendTyping = false;
let emptyTicket = false;
/** 可注入时钟（仅缓存/退避判定用）；null 表示用真实 Date.now。 */
let fakeNow = null;

const fakeNowFn = () => (fakeNow ?? Date.now());

function fakeGetConfig(options) {
  calls.getConfig.push(options);
  if (failGetConfig) throw new Error('getconfig boom');
  return Promise.resolve({ ret: 0, typing_ticket: emptyTicket ? '' : `ticket-${options.ilinkUserId}` });
}

function fakeSendTyping(options) {
  calls.sendTyping.push(options);
  if (failSendTyping) throw new Error('sendtyping boom');
  return Promise.resolve({ ret: 0 });
}

/** 重新注入 fake 依赖。 */
function configureFake() {
  typing.configureTypingDependencies({
    getConfig: fakeGetConfig,
    sendTyping: fakeSendTyping,
    now: fakeNowFn,
  });
}

configureFake();

function resetState() {
  typing.clearTypingState();
  configureFake();
  calls.getConfig.length = 0;
  calls.sendTyping.length = 0;
  failGetConfig = false;
  failSendTyping = false;
  emptyTicket = false;
  fakeNow = null;
  config.appRules.typingIndicator = true;
  config.appRules.typingRefreshMs = 5000;
}

let seq = 0;
function createUser(displayName = '') {
  seq += 1;
  return store.upsertBoundUser({
    wechatUserId: `wx_typing_${seq}`,
    displayName: displayName || `正在输入用户${seq}`,
    ilinkBotId: `bot_typing_${seq}@im.bot`,
    botToken: `typing-bot-token-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
}

const statuses = () => calls.sendTyping.map((item) => item.status);

test('beginTyping → sendtyping(1) → endTyping → 立即 sendtyping(2)（官方 start/stop 语义）', async () => {
  resetState();
  const user = createUser('基础用户');
  store.updateContextToken(user.id, 'ctx-typing-1');

  const handle = await typing.beginTyping(user);
  assert.deepEqual(handle, { userId: user.id });
  assert.equal(calls.getConfig.length, 1);
  assert.equal(calls.getConfig[0].ilinkUserId, user.wechatUserId);
  assert.equal(calls.getConfig[0].baseUrl, 'https://ilink.example.test');
  assert.equal(calls.getConfig[0].token, 'typing-bot-token-1');
  assert.equal(calls.getConfig[0].contextToken, 'ctx-typing-1');
  assert.equal(calls.sendTyping.length, 1);
  assert.equal(calls.sendTyping[0].status, 1);
  assert.equal(calls.sendTyping[0].typingTicket, `ticket-${user.wechatUserId}`);

  await typing.endTyping(handle);
  // 无最小可见/延迟取消：await 返回时 status=2 已发送
  assert.deepEqual(statuses(), [1, 2]);
  assert.equal(calls.sendTyping[1].typingTicket, `ticket-${user.wechatUserId}`);
});

test('getconfig/sendtyping 超时固定为 10000ms（对齐官方 DEFAULT_CONFIG_TIMEOUT_MS）', async () => {
  resetState();
  const user = createUser();
  const handle = await typing.beginTyping(user);
  await typing.endTyping(handle);
  assert.equal(calls.getConfig.length, 1);
  assert.equal(calls.getConfig[0].timeoutMs, 10_000, 'getConfig 超时应为 10s');
  assert.equal(calls.sendTyping.length, 2);
  for (const call of calls.sendTyping) {
    assert.equal(call.timeoutMs, 10_000, 'sendTyping 超时应为 10s');
  }
});

test('实时开关：config.appRules.typingIndicator=false 时静默返回 null 且不发请求', async () => {
  resetState();
  const user = createUser();
  config.appRules.typingIndicator = false;
  assert.equal(await typing.beginTyping(user), null);
  assert.equal(calls.getConfig.length, 0);
  assert.equal(calls.sendTyping.length, 0);

  config.appRules.typingIndicator = true;
  const handle = await typing.beginTyping(user);
  assert.ok(handle);
  assert.equal(calls.sendTyping.length, 1);
  await typing.endTyping(handle);
});

test('无 token / 无 wechatUserId / 空参数 → 静默返回 null，不发请求', async () => {
  resetState();
  const user = createUser();
  // 用户不存在（getUserSecrets 返回 null）
  assert.equal(await typing.beginTyping({ id: 'u_not_exists', wechatUserId: 'wx_not_exists' }), null);
  // 缺 wechatUserId
  assert.equal(await typing.beginTyping({ id: user.id, wechatUserId: '' }), null);
  assert.equal(await typing.beginTyping(null), null);
  assert.equal(calls.getConfig.length, 0);
  assert.equal(calls.sendTyping.length, 0);
});

test('getconfig 失败：beginTyping/endTyping 均不抛错、不影响规则', async () => {
  resetState();
  const user = createUser();
  failGetConfig = true;
  const handle = await typing.beginTyping(user);
  assert.ok(handle, '失败时仍返回 handle 供引用计数配对');
  assert.equal(calls.getConfig.length, 1);
  assert.equal(calls.sendTyping.length, 0, '无 ticket 时不发送 status=1');
  await typing.endTyping(handle);
  assert.equal(calls.sendTyping.length, 0, '无 ticket 时也不发送 status=2');
});

test('sendtyping 失败：beginTyping/endTyping 均不抛错（best-effort）', async () => {
  resetState();
  const user = createUser();
  failSendTyping = true;
  const handle = await typing.beginTyping(user);
  assert.ok(handle);
  await typing.endTyping(handle);
  assert.deepEqual(statuses(), [1, 2], '两次发送均尝试且错误被吞');
});

test('引用计数：同一用户并发请求只在最后一个结束时取消一次', async () => {
  resetState();
  const user = createUser();
  const handle1 = await typing.beginTyping(user);
  const handle2 = await typing.beginTyping(user);
  assert.equal(calls.getConfig.length, 1, '首次 getconfig 一次');
  assert.deepEqual(statuses(), [1], '只发送一次 status=1');

  await typing.endTyping(handle1);
  assert.deepEqual(statuses(), [1], '仍有引用时不取消');
  await typing.endTyping(handle2);
  assert.deepEqual(statuses(), [1, 2], '最后一个引用结束才取消');
});

test('ticket 缓存 24h 随机刷新：同用户再次请求不重复 getconfig（官方 config-cache 语义）', async () => {
  resetState();
  const originalRandom = Math.random;
  Math.random = () => 0.5; // nextFetchAt ≈ now + 12h
  try {
    const user = createUser();
    const h1 = await typing.beginTyping(user);
    await typing.endTyping(h1);
    const h2 = await typing.beginTyping(user);
    await typing.endTyping(h2);
    assert.equal(calls.getConfig.length, 1, '24h 随机刷新窗口内复用缓存 ticket，不重复 getconfig');
    assert.deepEqual(statuses(), [1, 2, 1, 2]);
  } finally {
    Math.random = originalRandom;
  }
});

test('ticket 缓存按 userId：同用户不同 baseUrl 仍复用缓存（官方 per-user 缓存）', async () => {
  resetState();
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const user = createUser();
    const h1 = await typing.beginTyping(user);
    await typing.endTyping(h1);
    // 换一个 baseUrl（例如用户重新绑定到另一账号）仍应命中同一个 userId 缓存
    const h2 = await typing.beginTyping({ ...user, baseUrl: 'https://other.example.test' });
    await typing.endTyping(h2);
    assert.equal(calls.getConfig.length, 1, '缓存 key 只有 userId，不应因 baseUrl 不同而重取');
    assert.equal(calls.sendTyping[2].baseUrl, 'https://other.example.test', 'sendtyping 使用当前 baseUrl');
  } finally {
    Math.random = originalRandom;
  }
});

// ---------------------------------------------------------------------------
// 官方 config-cache 语义：失败 2s 起指数退避（x2，最大 1h）、空 ticket 只缓存不 sendTyping
// ---------------------------------------------------------------------------

test('getconfig 失败指数退避：2s 内不重试、退避翻倍（注入时钟）', async () => {
  resetState();
  fakeNow = 1_000_000;
  failGetConfig = true;
  const user = createUser();

  await typing.endTyping(await typing.beginTyping(user));
  assert.equal(calls.getConfig.length, 1, '首次失败应记录空 ticket 缓存');

  fakeNow += 1999;
  await typing.endTyping(await typing.beginTyping(user));
  assert.equal(calls.getConfig.length, 1, '失败后 2s 内不应重试 getconfig');

  fakeNow += 1;
  await typing.endTyping(await typing.beginTyping(user));
  assert.equal(calls.getConfig.length, 2, '到 2s 后应重试一次（第二次失败 → 退避 4s）');

  fakeNow += 3999;
  await typing.endTyping(await typing.beginTyping(user));
  assert.equal(calls.getConfig.length, 2, '退避翻倍后 4s 内不应重试');

  fakeNow += 1;
  await typing.endTyping(await typing.beginTyping(user));
  assert.equal(calls.getConfig.length, 3, '4s 到期后再次重试（退避继续翻倍）');
});

test('退避上限 1h：连续失败后重试间隔不超过 1h', async () => {
  resetState();
  fakeNow = 5_000_000;
  failGetConfig = true;
  const user = createUser();
  const MAX_RETRY_MS = 60 * 60 * 1000;

  await typing.endTyping(await typing.beginTyping(user)); // 首次失败：2s 后重试
  let delay = 2000;
  for (let index = 0; index < 20 && delay < MAX_RETRY_MS; index += 1) {
    fakeNow += delay;
    const before = calls.getConfig.length;
    await typing.endTyping(await typing.beginTyping(user));
    assert.equal(calls.getConfig.length, before + 1, `退避 ${delay}ms 到期应重试`);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
  assert.equal(delay, MAX_RETRY_MS, '退避应达到 1h 上限');

  const beforeCap = calls.getConfig.length;
  fakeNow += MAX_RETRY_MS - 1;
  await typing.endTyping(await typing.beginTyping(user));
  assert.equal(calls.getConfig.length, beforeCap, '1h 退避内不应重试');
  fakeNow += 1;
  await typing.endTyping(await typing.beginTyping(user));
  assert.equal(calls.getConfig.length, beforeCap + 1, '1h 到期后应重试');
});

test('空 typing_ticket：只缓存不 sendTyping（官方 hasTypingTicket=false 语义）', async () => {
  resetState();
  emptyTicket = true;
  const originalRandom = Math.random;
  Math.random = () => 0.5; // nextFetchAt ≈ now + 12h
  try {
    const user = createUser();
    const h1 = await typing.beginTyping(user);
    await typing.endTyping(h1);
    assert.equal(calls.getConfig.length, 1);
    assert.equal(calls.sendTyping.length, 0, '空 ticket 不应发送 sendtyping(1)/(2)');

    const h2 = await typing.beginTyping(user);
    await typing.endTyping(h2);
    assert.equal(calls.getConfig.length, 1, '空 ticket 也在 24h 缓存窗口内，不重复 getconfig');
    assert.equal(calls.sendTyping.length, 0, '空 ticket 期间始终静默跳过 sendtyping');
  } finally {
    Math.random = originalRandom;
  }
});

test('刷新定时：按 typingRefreshMs 重发 status=1，结束后清理定时器', async () => {
  resetState();
  const user = createUser();
  config.appRules.typingRefreshMs = 20;
  const handle = await typing.beginTyping(user);
  await sleep(90);
  const started = calls.sendTyping.filter((item) => item.status === 1).length;
  assert.ok(started >= 2, `应至少刷新一次（实际 status=1 共 ${started} 次）`);

  await typing.endTyping(handle);
  const totalAfterEnd = calls.sendTyping.length;
  assert.equal(calls.sendTyping.at(-1).status, 2, '结束时发送 status=2');
  await sleep(60);
  assert.equal(calls.sendTyping.length, totalAfterEnd, '结束后定时器应被清理，不再发送');
});

test('未知/重复 handle 安全：endTyping 不抛错且不重复取消', async () => {
  resetState();
  const user = createUser();
  const handle = await typing.beginTyping(user);
  await typing.endTyping(handle);
  await typing.endTyping(handle); // 重复结束：会话已清理 → no-op
  await typing.endTyping(null);
  await typing.endTyping({ userId: 'u_unknown' });
  assert.deepEqual(statuses(), [1, 2]);
});
