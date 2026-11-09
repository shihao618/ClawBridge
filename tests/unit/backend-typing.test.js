/**
 * 单元测试：typing.js —— 规则请求外部接口期间的微信「正在输入」状态（docs/PROTOCOL.md §5.6）。
 *
 * 注入 fake getConfig/sendTyping（不触真实网络），覆盖：
 * 开启→status1 / 结束→status2、刷新定时、实时开关、无 token/无 wechatUserId 静默、
 * getconfig/sendtyping 失败不影响、引用计数、ticket 缓存、未知/重复 handle 安全。
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
    APP_RULE_TYPING_REFRESH_MS: '4000',
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

function fakeGetConfig(options) {
  calls.getConfig.push(options);
  if (failGetConfig) throw new Error('getconfig boom');
  return Promise.resolve({ ret: 0, typing_ticket: `ticket-${options.ilinkUserId}` });
}

function fakeSendTyping(options) {
  calls.sendTyping.push(options);
  if (failSendTyping) throw new Error('sendtyping boom');
  return Promise.resolve({ ret: 0 });
}

typing.configureTypingDependencies({ getConfig: fakeGetConfig, sendTyping: fakeSendTyping });

function resetState() {
  typing.clearTypingState();
  calls.getConfig.length = 0;
  calls.sendTyping.length = 0;
  failGetConfig = false;
  failSendTyping = false;
  config.appRules.typingIndicator = true;
  config.appRules.typingRefreshMs = 4000;
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

test('beginTyping → sendtyping(1) → endTyping → sendtyping(2)（携带 ticket/context_token）', async () => {
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
  assert.deepEqual(statuses(), [1, 2]);
  assert.equal(calls.sendTyping[1].typingTicket, `ticket-${user.wechatUserId}`);
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

test('ticket 缓存 10 分钟：同用户再次请求不重复 getconfig', async () => {
  resetState();
  const user = createUser();
  const h1 = await typing.beginTyping(user);
  await typing.endTyping(h1);
  const h2 = await typing.beginTyping(user);
  await typing.endTyping(h2);
  assert.equal(calls.getConfig.length, 1, '10 分钟内复用缓存的 typing_ticket');
  assert.deepEqual(statuses(), [1, 2, 1, 2]);
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
