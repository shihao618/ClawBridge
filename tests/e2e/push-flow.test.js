/**
 * e2e：消息推送 / 入站 / 限流与 token 失效（黑盒 HTTP）。
 *
 * 覆盖：
 *  - admin 发消息 → 202 → mock 收到（文本/收件人/client_id/请求头）→ outbox sent + message_id 无损；
 *  - 入站消息 → 落库/去重/context_token 缓存 → 再次发送时 mock 收到相同 context_token；
 *  - API Key：单发/多收件人/未知用户/广播/v1 users/鉴权失败/文本校验；
 *  - -2 限流退避重试成功（attempts=2）；-14 → 用户 paused、消息 failed、overview 正确、再发 409；
 *  - 入站监控 -14（stale-token）→ 用户暂停。
 *
 * 依赖 mock/ilink-mock.mjs 控制面；app 为真实子进程。见 tests/helpers/e2e-env.mjs。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { assertBigMessageId, startE2E, waitStable } from '../helpers/e2e-env.mjs';

let e2e;
/** @type {{user: object, account: object}} */
let coldUser;
/** @type {{user: object, account: object}} */
let inboundUser;

before(async () => {
  e2e = await startE2E();
  await e2e.ensureAdmin();
  const a = await e2e.bindUser({ displayName: '推送用户A', waitMonitor: true });
  coldUser = { user: a.user, account: a.account };
  const b = await e2e.bindUser({ displayName: '入站用户B', waitMonitor: true });
  inboundUser = { user: b.user, account: b.account };
});

after(async () => {
  await e2e?.cleanup();
});

test('admin 发消息（冷启动无 context_token）→ 202 → mock 收到 → outbox sent + message_id 无损', async () => {
  const text = `冷启动消息-${Date.now()}`;
  const send = await e2e.adminWrite('POST', `/api/admin/users/${coldUser.user.id}/messages`, { text });
  assert.equal(send.status, 202, `admin 发消息应 202：${send.status} ${send.text}`);
  assert.equal(send.json.queued.length, 1);
  const item = send.json.queued[0];
  assert.ok(item.outboxId.startsWith('ob_'));
  assert.equal(item.userId, coldUser.user.id, 'queued 项应含 userId');
  assert.equal(item.status, 'queued');

  // mock 侧收到 sendmessage：收件人/文本/冷启动无 context_token/客户端 ID/请求头均正确
  const sent = await e2e.waitSentMessage(text, { botId: coldUser.account.botId });
  assert.equal(sent.toUserId, coldUser.user.wechatUserId);
  assert.equal(sent.text, text);
  assert.equal(sent.contextToken, '', '冷启动尚无入站消息，不应携带 context_token');
  assert.match(sent.clientId, /^clawbridge-/);
  assert.deepEqual(sent.itemTypes, [1]);
  assert.equal(sent.headers.authorizationType, 'ilink_bot_token');
  assert.equal(sent.headers.appId, 'bot');
  assert.equal(sent.headers.clientVersion, '132106');
  assertBigMessageId(sent.messageId, 'mock 返回的 message_id');

  // outbox 状态：sent、attempts=1、serverMessageId 无损字符串
  const outbox = await e2e.waitOutbox(item.outboxId, 'sent');
  assert.equal(outbox.status, 'sent');
  assert.equal(outbox.userId, coldUser.user.id);
  assert.equal(outbox.attempts, 1);
  assert.equal(outbox.serverMessageId, sent.messageId);
  assertBigMessageId(outbox.serverMessageId, 'outbox.serverMessageId');
  assert.ok(outbox.sentAt > 0);

  // 管理后台消息记录（出站）可见
  await e2e.ensureAdmin();
  const msg = await e2e.waitAdminMessage(
    (row) => row.direction === 'outbound' && row.text === text,
    { direction: 'outbound' },
  );
  assert.equal(msg.userId, coldUser.user.id);
  assert.equal(msg.status, 'sent');
  assert.equal(msg.attempts, 1);
  assert.equal(msg.serverMessageId, sent.messageId);

  // 用户详情：lastOutboundAt 更新
  const detail = await e2e.waitUser(coldUser.user.id, (data) => data.user.lastOutboundAt > 0);
  assert.equal(detail.user.sentCount >= 1, true);
  await e2e.waitQueueDrained();
});

test('入站消息：落库/去重/context_token 缓存与回传，入站 message_id 无损', async () => {
  // 1) 注入中文入站消息（message_id 为 >2^53 的 JSON number）
  const text1 = '你好，ClawBridge e2e！';
  const injected1 = await e2e.mockInbound(inboundUser.account.botId, {
    text: text1,
    context_token: 'ctx_e2e_1',
  });
  assert.equal(injected1.count, 1);
  const mockMessageId1 = injected1.messages[0].message_id;
  assertBigMessageId(mockMessageId1, '注入的入站 message_id');

  const inbound1 = await e2e.waitInboundText(inboundUser.user.id, text1);
  assert.equal(inbound1.direction, 'inbound');
  assert.equal(inbound1.status, 'received');
  assert.equal(inbound1.userId, inboundUser.user.id);
  assert.equal(inbound1.serverMessageId, mockMessageId1, '入站 message_id 应无损保存为字符串');
  assertBigMessageId(inbound1.serverMessageId, '入站 serverMessageId');

  // 2) 重复 message_id：同一 message_id 注入两次只落库一条（唯一索引去重）
  const dupId = '424242424242424242';
  await e2e.mockInbound(inboundUser.account.botId, { text: '重复消息-1', message_id: dupId, context_token: 'ctx_dup' });
  await e2e.mockInbound(inboundUser.account.botId, { text: '重复消息-2', message_id: dupId, context_token: 'ctx_dup' });
  const dupRow = await e2e.waitInboundText(inboundUser.user.id, '重复消息-1');
  assert.equal(dupRow.serverMessageId, dupId);
  const countAfterDup = await e2e.inboundCount(inboundUser.user.id);
  await waitStable(async () => (await e2e.inboundCount(inboundUser.user.id)) === countAfterDup, {
    samples: 4,
    label: '重复入站不再落库',
  });
  assert.equal(await e2e.inboundCount(inboundUser.user.id), countAfterDup, '同 message_id 重复消息不应重复落库');

  // 3) 新 context_token 入站后，admin 再次发送应回传最新 context_token
  await e2e.mockInbound(inboundUser.account.botId, { text: '第二条入站消息', context_token: 'ctx_e2e_2' });
  await e2e.waitInboundText(inboundUser.user.id, '第二条入站消息');
  const replyText = '带 context_token 的回复';
  const send = await e2e.adminWrite('POST', `/api/admin/users/${inboundUser.user.id}/messages`, { text: replyText });
  assert.equal(send.status, 202);
  const sent = await e2e.waitSentMessage(replyText, { botId: inboundUser.account.botId });
  assert.equal(sent.contextToken, 'ctx_e2e_2', '发送时应回传最近一条入站消息的 context_token');
  assert.equal(sent.toUserId, inboundUser.user.wechatUserId);

  // 4) 用户详情：hasContextToken=true 且能查到最近入站
  const detail = await e2e.waitUser(inboundUser.user.id, (data) => data.user.hasContextToken === true);
  assert.ok(detail.recentInbound.some((row) => row.text === text1));
  await e2e.waitQueueDrained();
});

test('API Key：单发/多收件人/未知用户/广播/用户列表/鉴权失败/文本校验', async () => {
  const authHeader = { Authorization: `Bearer ${e2e.apiToken}` };

  // 单发（使用 X-Api-Key 头）
  const singleText = 'v1 单发消息';
  const single = await e2e.api('POST', '/api/v1/messages', {
    body: { to: [coldUser.user.id], text: singleText },
    headers: { 'X-Api-Key': e2e.apiToken },
  });
  assert.equal(single.status, 202, `v1 单发应 202：${single.status} ${single.text}`);
  assert.equal(single.json.accepted, 1);
  assert.equal(single.json.queued[0].userId, coldUser.user.id);
  await e2e.waitSentMessage(singleText, { botId: coldUser.account.botId });

  // 多收件人：有效 + 未知 id → accepted=N + unknownUserIds
  const multiText = 'v1 多收件人消息';
  const multi = await e2e.api('POST', '/api/v1/messages', {
    body: { to: [coldUser.user.id, inboundUser.user.id, 'u_not_exists_e2e'], text: multiText },
    headers: authHeader,
  });
  assert.equal(multi.status, 202);
  assert.equal(multi.json.accepted, 2);
  assert.deepEqual(multi.json.unknownUserIds, ['u_not_exists_e2e']);
  await e2e.waitSentMessageCount(multiText, 2);

  // 全部未知 → 404 + details.unknownUserIds
  const allUnknown = await e2e.api('POST', '/api/v1/messages', {
    body: { to: ['u_not_exists_e2e'], text: '无人接收' },
    headers: authHeader,
  });
  assert.equal(allUnknown.status, 404);
  assert.equal(allUnknown.json.error.code, 'NOT_FOUND');
  assert.deepEqual(allUnknown.json.error.details.unknownUserIds, ['u_not_exists_e2e']);

  // 广播
  const broadcastText = 'v1 广播消息';
  const broadcast = await e2e.api('POST', '/api/v1/broadcast', {
    body: { text: broadcastText },
    headers: authHeader,
  });
  assert.equal(broadcast.status, 202);
  assert.ok(broadcast.json.accepted >= 2, `广播应覆盖至少 2 个 active 用户，实际 ${broadcast.json.accepted}`);
  assert.equal(broadcast.json.queued.length, broadcast.json.accepted);
  await e2e.waitSentMessageCount(broadcastText, broadcast.json.accepted);

  // 用户列表
  const users = await e2e.api('GET', '/api/v1/users?status=active', { headers: authHeader });
  assert.equal(users.status, 200);
  assert.ok(Array.isArray(users.json.items));
  assert.ok(users.json.items.some((item) => item.id === coldUser.user.id));

  // 鉴权失败
  const badKey = await e2e.api('GET', '/api/v1/users', { headers: { Authorization: 'Bearer wrong-token' } });
  assert.equal(badKey.status, 401);
  assert.equal(badKey.json.error.code, 'UNAUTHORIZED');
  const noKey = await e2e.api('GET', '/api/v1/users');
  assert.equal(noKey.status, 401);

  // 文本校验
  const emptyText = await e2e.api('POST', '/api/v1/messages', {
    body: { to: [coldUser.user.id], text: '   ' },
    headers: authHeader,
  });
  assert.equal(emptyText.status, 400);
  assert.equal(emptyText.json.error.code, 'BAD_REQUEST');

  // 查询不存在的 outbox
  const missingOutbox = await e2e.api('GET', '/api/v1/messages/ob_not_exists', { headers: authHeader });
  assert.equal(missingOutbox.status, 404);
  assert.equal(missingOutbox.json.error.code, 'NOT_FOUND');

  await e2e.waitQueueDrained();
});

test('-2 限流：退避重试后成功（attempts=2，mock 记录 1 次失败）', async () => {
  const bound = await e2e.bindUser({ displayName: '限流用户C', waitMonitor: true });
  const text = '被限流后重试成功的消息';
  await e2e.mockFailNextSend({ ret: -2, times: 1, botId: bound.account.botId });

  const send = await e2e.adminWrite('POST', `/api/admin/users/${bound.user.id}/messages`, { text });
  assert.equal(send.status, 202);
  const outboxId = send.json.queued[0].outboxId;

  const outbox = await e2e.waitOutbox(outboxId, 'sent', { timeoutMs: 20000 });
  assert.equal(outbox.status, 'sent');
  assert.equal(outbox.attempts, 2, '-2 重试一次后成功，attempts 应为 2');
  const sent = await e2e.waitSentMessage(text, { botId: bound.account.botId });
  assertBigMessageId(sent.messageId, '重试成功后的 message_id');
  assert.equal(outbox.serverMessageId, sent.messageId);

  const state = await e2e.mockState();
  assert.ok(
    state.failedSends.some((entry) => entry.ret === -2 && entry.text === text),
    'mock 应记录一次 -2 失败',
  );
  assert.equal(
    state.sentMessages.filter((item) => item.text === text).length,
    1,
    '重试成功后应只实际投递一次',
  );
  await e2e.waitQueueDrained();
});

test('-14 token 失效：用户 paused、消息 failed、overview/列表正确、再次发送 409', async () => {
  const bound = await e2e.bindUser({ displayName: '失效用户D', waitMonitor: true });
  const text = '触发 token 失效的消息';
  await e2e.mockFailNextSend({ ret: -14, times: 1, botId: bound.account.botId });

  await e2e.ensureAdmin();
  const send = await e2e.adminWrite('POST', `/api/admin/users/${bound.user.id}/messages`, { text });
  assert.equal(send.status, 202);
  const outbox = await e2e.waitOutbox(send.json.queued[0].outboxId, 'failed', { timeoutMs: 20000 });
  assert.equal(outbox.status, 'failed');
  assert.match(outbox.error, /失效|重新扫码/, `失败原因应说明 token 失效：${outbox.error}`);
  assert.equal(outbox.attempts, 1);

  // 用户进入 paused（-14 冷却）
  const paused = await e2e.waitUser(bound.user.id, (data) => data.user.status === 'paused');
  assert.equal(paused.user.status, 'paused');
  assert.ok(paused.user.pauseUntil > Date.now(), 'pauseUntil 应在未来');

  const overview = await e2e.adminGet('/api/admin/overview');
  assert.equal(overview.status, 200);
  assert.ok(overview.json.stats.pausedUsers >= 1, 'overview.pausedUsers 应包含冷却账号');

  const pausedList = await e2e.adminGet('/api/admin/users?status=paused');
  assert.ok(pausedList.json.items.some((item) => item.id === bound.user.id), 'paused 列表应包含该用户');

  // 冷却中：admin 发送 409、reconnect 409
  const again = await e2e.adminWrite('POST', `/api/admin/users/${bound.user.id}/messages`, { text: '冷却中再发' });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'CONFLICT');
  const reconnect = await e2e.adminWrite('POST', `/api/admin/users/${bound.user.id}/reconnect`, {});
  assert.equal(reconnect.status, 409);
  await e2e.waitQueueDrained();
});

test('入站监控 -14（stale-token）→ 用户暂停并停止轮询', async () => {
  const bound = await e2e.bindUser({ displayName: '监控失效用户E', waitMonitor: true });
  await e2e.mockStaleToken(bound.account.botId);
  const paused = await e2e.waitUser(bound.user.id, (data) => data.user.status === 'paused', {
    label: 'getupdates 返回 -14 后用户暂停',
  });
  assert.ok(paused.user.pauseUntil > Date.now());
  // 清理 mock 状态，避免影响后续（用户已 paused，不再轮询）
  await e2e.mockClearStaleToken(bound.account.botId);
});
