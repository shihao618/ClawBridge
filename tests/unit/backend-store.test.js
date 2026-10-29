/**
 * 后端单元测试：store.js（临时 DATA_DIR + 真实 SQLite，无网络）。
 *
 * 覆盖：用户 upsert/换绑语义、token/context_token 加密落库、CRUD、列表筛选/分页、
 * outbox 生命周期、入站消息去重、混合消息分页、events、统计、解绑清理。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// config.js 在模块加载时求值：必须先设置环境变量，再动态 import 业务模块。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-store-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'store-test-app-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'store-test-admin-password';
process.env.API_TOKEN = 'store-test-api-token-123456';
process.env.LOG_LEVEL = 'silent';

const store = await import('../../server/src/store.js');
const { getDb, closeDb } = await import('../../server/src/db.js');
const { decryptSecret } = await import('../../server/src/crypto.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
function createUser(overrides = {}) {
  seq += 1;
  return store.upsertBoundUser({
    wechatUserId: overrides.wechatUserId ?? `wx_test_${seq}`,
    displayName: overrides.displayName ?? `用户${seq}`,
    ilinkBotId: overrides.ilinkBotId ?? `bot_${seq}@im.bot`,
    botToken: overrides.botToken ?? `bot-token-${seq}`,
    baseUrl: overrides.baseUrl ?? 'https://ilink.example.test',
  });
}

function rawUser(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

test('users: upsert 新建 + token 加密落库（DB 无明文）', () => {
  const result = createUser({ wechatUserId: 'wx_enc_1', displayName: '加密用户', botToken: 'secret-bot-token-abc' });
  assert.equal(result.created, true);
  assert.equal(result.rebound, false);
  assert.match(result.user.id, /^u_/);
  assert.equal(result.user.status, 'active');
  assert.equal(result.user.wechatUserId, 'wx_enc_1');
  assert.equal(result.user.hasContextToken, false);

  const raw = rawUser(result.user.id);
  assert.ok(typeof raw.token_enc === 'string' && raw.token_enc.startsWith('v1.'), 'token_enc 应为 AES-GCM 密文');
  assert.ok(!raw.token_enc.includes('secret-bot-token-abc'), 'DB 不得出现 token 明文');
  assert.equal(decryptSecret(raw.token_enc), 'secret-bot-token-abc');

  const secrets = store.getUserSecrets(result.user.id);
  assert.equal(secrets.token, 'secret-bot-token-abc');
  assert.equal(secrets.contextToken, null);
  assert.equal(store.getUserSecrets('u_not_exist'), null);
});

test('users: context_token 加密更新 + 换绑清理旧凭证', () => {
  const first = createUser({ wechatUserId: 'wx_rebind_1', displayName: '旧昵称', botToken: 'old-bot-token' });
  const userId = first.user.id;

  assert.equal(store.updateContextToken(userId, 'ctx-old-token'), true);
  store.setUserPaused(userId, Date.now() + 3600_000, 'stale token');
  store.updateGetUpdatesBuf(userId, 'old-buf');

  let raw = rawUser(userId);
  assert.ok(raw.context_token_enc.startsWith('v1.'), 'context_token 应加密落库');
  assert.ok(!raw.context_token_enc.includes('ctx-old-token'));
  assert.equal(decryptSecret(raw.context_token_enc), 'ctx-old-token');
  assert.equal(store.getUser(userId).hasContextToken, true);

  // 同一微信用户再次 confirmed（换绑）：保留 id、清旧 token/context/pause/游标
  const second = store.upsertBoundUser({
    wechatUserId: 'wx_rebind_1',
    displayName: '新昵称',
    ilinkBotId: 'bot_new@im.bot',
    botToken: 'new-bot-token',
    baseUrl: 'https://new-base.example.test',
  });
  assert.equal(second.created, false);
  assert.equal(second.rebound, true);
  assert.equal(second.user.id, userId, '换绑应复用同一用户 id');

  raw = rawUser(userId);
  assert.equal(raw.context_token_enc, null);
  assert.equal(raw.context_token_updated_at, 0);
  assert.equal(raw.get_updates_buf, '');
  assert.equal(raw.pause_until, 0);
  assert.equal(raw.status, 'active');
  assert.equal(raw.display_name, '新昵称');
  assert.equal(raw.base_url, 'https://new-base.example.test');
  assert.equal(decryptSecret(raw.token_enc), 'new-bot-token');
  assert.equal(
    Number(getDb().prepare('SELECT COUNT(*) AS c FROM users WHERE wechat_user_id = ?').get('wx_rebind_1').c),
    1,
    'wechat_user_id 唯一索引应保证只有一条记录',
  );
});

test('users: 列表筛选（active/paused/unbound/all）、搜索与分页', () => {
  const a = createUser({ wechatUserId: 'wx_page_a', displayName: '分页甲' });
  const b = createUser({ wechatUserId: 'wx_page_b', displayName: '分页乙' });
  createUser({ wechatUserId: 'wx_page_c', displayName: '分页丙' });

  const all = store.listUsers({ status: 'all', q: '分页' });
  assert.equal(all.total, 3);
  assert.equal(all.items.length, 3);

  const page = store.listUsers({ status: 'all', q: '分页', limit: 2, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);
  const page2 = store.listUsers({ status: 'all', q: '分页', limit: 2, offset: 0 });
  assert.equal(page2.items.length, 2);
  assert.equal(new Set([...page.items, ...page2.items].map((u) => u.id)).size, 3);

  // paused 派生状态
  store.setUserPaused(a.user.id, Date.now() + 60_000, 'stale');
  const pausedList = store.listUsers({ status: 'paused', q: 'wx_page_a' });
  assert.equal(pausedList.total, 1);
  assert.equal(pausedList.items[0].status, 'paused');
  assert.ok(pausedList.items[0].pauseUntil > Date.now());
  assert.equal(store.listUsers({ status: 'active', q: 'wx_page_a' }).total, 1, 'active 筛选包含冷却中的账号');
  store.clearUserPause(a.user.id);
  assert.equal(store.getUser(a.user.id).status, 'active');

  // unbound 筛选
  store.unbindUser(b.user.id);
  const unbound = store.listUsers({ status: 'unbound', q: 'wx_page_b' });
  assert.equal(unbound.total, 1);
  assert.equal(unbound.items[0].status, 'unbound');
  assert.equal(store.listUsers({ status: 'active', q: 'wx_page_b' }).total, 0);

  // 搜索命中 wechat_user_id / id
  assert.equal(store.listUsers({ status: 'all', q: 'wx_page_c' }).total, 1);
  assert.equal(store.listUsers({ status: 'all', q: '不存在的关键词' }).total, 0);
});

test('users: getUserWithCounts / 解绑清空凭证 / 监控候选列表', () => {
  const { user } = createUser({ wechatUserId: 'wx_counts_1', botToken: 'count-token' });
  store.enqueueMessage({ userId: user.id, text: 'a' });
  store.enqueueMessage({ userId: user.id, text: 'b' });
  const sent = store.enqueueMessage({ userId: user.id, text: 'c' });
  store.markOutboxSent(sent.id, { serverMessageId: 'svr_1' });

  const withCounts = store.getUserWithCounts(user.id);
  assert.equal(withCounts.queuedCount, 2);
  assert.equal(withCounts.sentCount, 1);
  assert.equal(withCounts.failedCount, 0);
  assert.equal(withCounts.hasContextToken, false);

  // 解绑：清空凭证，保留用户记录
  store.updateContextToken(user.id, 'ctx-unbind');
  assert.equal(store.unbindUser(user.id), true);
  const raw = rawUser(user.id);
  assert.equal(raw.status, 'unbound');
  assert.equal(raw.token_enc, null);
  assert.equal(raw.context_token_enc, null);
  assert.equal(raw.ilink_bot_id, null);
  assert.equal(raw.base_url, '');
  assert.equal(store.getUserSecrets(user.id).token, null);

  // 监控候选：只含 active 且未冷却
  const paused = createUser({ wechatUserId: 'wx_monitor_paused' });
  store.setUserPaused(paused.user.id, Date.now() + 3600_000, 'stale');
  const active = createUser({ wechatUserId: 'wx_monitor_active' });
  const candidates = store.getActiveUsersForMonitor(100);
  const ids = candidates.map((row) => row.id);
  assert.ok(ids.includes(active.user.id));
  assert.ok(!ids.includes(paused.user.id), '冷却中账号不应恢复监控');
  assert.ok(!ids.includes(user.id), 'unbound 账号不应恢复监控');
  for (const row of candidates) assert.equal(row.status, 'active');
});

test('outbox: 入队/抢占/发送/失败/退避/重置 sending', () => {
  getDb().exec('DELETE FROM outbox');
  const { user } = createUser({ wechatUserId: 'wx_outbox_1', botToken: 'outbox-token' });

  const first = store.enqueueMessage({ userId: user.id, text: 'hello-1', source: 'admin' });
  assert.match(first.id, /^ob_/);
  assert.equal(first.status, 'queued');
  assert.equal(first.attempts, 0);

  // 可取到最早的可投递记录
  const candidate = store.getNextQueuedCandidate(Date.now());
  assert.equal(candidate.id, first.id);
  // next_attempt_at 未到期的记录不会被取出
  const future = store.enqueueMessage({ userId: user.id, text: 'future', nextAttemptAt: Date.now() + 60_000 });
  const candidateNow = store.getNextQueuedCandidate(Date.now());
  assert.equal(candidateNow.id, first.id, 'future 记录未到期不应被取出');
  assert.notEqual(candidateNow.id, future.id);
  getDb().prepare('DELETE FROM outbox WHERE id = ?').run(future.id);

  // queued → sending
  assert.equal(store.markOutboxSending(first.id), true);
  assert.equal(store.markOutboxSending(first.id), false, '状态守卫：不能重复抢占');
  assert.equal(store.getOutbox(first.id).status, 'sending');

  // 进程重启恢复：sending → queued
  assert.equal(store.resetSendingToQueued(), 1);
  let row = store.getOutbox(first.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 0);

  // 退避重试：attempts+1 / next_attempt_at 延后 / error 记录
  store.rescheduleOutbox(first.id, { nextAttemptAt: Date.now() + 30_000, error: 'retry-me' });
  row = store.getOutbox(first.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 1);
  assert.ok(row.nextAttemptAt > Date.now() + 20_000);
  assert.equal(row.error, 'retry-me');

  // 限流时推迟该账号全部 queued
  const second = store.enqueueMessage({ userId: user.id, text: 'hello-2', source: 'api' });
  const deferredAt = Date.now() + 60_000;
  const deferredCount = store.deferUserQueued(user.id, deferredAt);
  assert.equal(deferredCount, 2);
  assert.ok(store.getOutbox(first.id).nextAttemptAt >= deferredAt);
  assert.ok(store.getOutbox(second.id).nextAttemptAt >= deferredAt);

  // 发送成功（attempts 语义：实际发送尝试次数，首次成功 = 1）
  store.markOutboxSent(second.id, { serverMessageId: 'svr_msg_1', clientId: 'clawbridge-cid' });
  row = store.getOutbox(second.id);
  assert.equal(row.status, 'sent');
  assert.equal(row.attempts, 1, '首次投递成功 attempts 应为 1');
  assert.equal(row.serverMessageId, 'svr_msg_1');
  assert.equal(row.clientId, 'clawbridge-cid');
  assert.ok(row.sentAt > 0);

  // 终态失败：attempts+1
  const third = store.enqueueMessage({ userId: user.id, text: 'hello-3' });
  store.markOutboxFailed(third.id, { error: 'boom' });
  row = store.getOutbox(third.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 1);
  assert.equal(row.error, 'boom');

  // 批量入队（事务）
  const batch = store.enqueueMany([
    { userId: user.id, text: 'batch-1' },
    { userId: user.id, text: 'batch-2' },
  ]);
  assert.equal(batch.length, 2);
  assert.ok(batch.every((item) => item.status === 'queued'));

  // 批量失败该账号剩余 queued（未真正发送的消息 attempts 不增加）
  const failedCount = store.failUserQueued(user.id, '用户已解绑');
  assert.equal(failedCount, 3, 'first(queued) + batch(2) 应全部失败');
  assert.equal(store.getOutbox(third.id).status, 'failed');
  for (const item of batch) {
    const batchRow = store.getOutbox(item.id);
    assert.equal(batchRow.status, 'failed');
    assert.equal(batchRow.attempts, 0, '未发送的 queued 消息失败时 attempts 应保持 0');
  }

  // 用户维度列表与分页
  const list = store.listOutbox({ userId: user.id, limit: 2, offset: 0 });
  assert.ok(list.total >= 5);
  assert.equal(list.items.length, 2);
});

test('inbound: 按 message_id 去重 + 空 message_id 允许重复 + context 关联', () => {
  getDb().exec('DELETE FROM inbound_messages');
  const { user } = createUser({ wechatUserId: 'wx_inbound_1' });

  const first = store.saveInbound({
    userId: user.id,
    wechatMessageId: 'msg_100',
    fromUserId: 'wx_inbound_1',
    text: '你好',
    itemTypes: '1',
    rawJson: '{"message_id":"msg_100"}',
    createdAt: 1000,
    receivedAt: 2000,
  });
  assert.equal(first.inserted, true);

  const dup = store.saveInbound({
    userId: user.id,
    wechatMessageId: 'msg_100',
    fromUserId: 'wx_inbound_1',
    text: '你好（重复）',
    createdAt: 1000,
    receivedAt: 3000,
  });
  assert.equal(dup.inserted, false, '唯一索引应忽略重复 message_id');

  const empty1 = store.saveInbound({ userId: user.id, wechatMessageId: '', fromUserId: 'wx', text: '占位1' });
  const empty2 = store.saveInbound({ userId: user.id, wechatMessageId: '', fromUserId: 'wx', text: '占位2' });
  assert.equal(empty1.inserted, true);
  assert.equal(empty2.inserted, true, '空 message_id 不参与唯一约束');

  const list = store.listInbound({ userId: user.id });
  assert.equal(list.total, 3);
  assert.ok(list.items.some((item) => item.text === '你好'));
  assert.ok(list.items.every((item) => item.direction === 'inbound' && item.status === 'received'));
  const dedupedItem = list.items.find((item) => item.text === '你好');
  assert.equal(dedupedItem.serverMessageId, 'msg_100', '入站 serverMessageId 应为微信 message_id 字符串');
  assert.equal(list.items.find((item) => item.text === '占位1').serverMessageId, null, '空 message_id 返回 null');

  const recent = store.getRecentInbound(user.id, 10);
  assert.equal(recent.length, 3);
});

test('messages: inbound/outbound 合并分页、方向/状态/用户过滤', () => {
  getDb().exec('DELETE FROM outbox');
  getDb().exec('DELETE FROM inbound_messages');
  const { user } = createUser({ wechatUserId: 'wx_mixed_1' });
  const other = createUser({ wechatUserId: 'wx_mixed_2' });

  store.saveInbound({ userId: user.id, wechatMessageId: 'in_1', fromUserId: 'wx_mixed_1', text: '入站文本', createdAt: 1000, receivedAt: 1500 });
  const sent = store.enqueueMessage({ userId: user.id, text: '出站成功', source: 'admin' });
  store.markOutboxSent(sent.id, { serverMessageId: 'svr_x', ts: 2000 });
  const queued = store.enqueueMessage({ userId: other.user.id, text: '出站排队', source: 'api' });

  const all = store.listMessages({ direction: 'all', limit: 10, offset: 0 });
  assert.equal(all.total, 3);
  assert.equal(all.items.length, 3);
  const directions = new Set(all.items.map((item) => item.direction));
  assert.deepEqual([...directions].sort(), ['inbound', 'outbound']);
  const inboundItem = all.items.find((item) => item.direction === 'inbound');
  assert.equal(inboundItem.status, 'received');
  assert.equal(inboundItem.text, '入站文本');
  assert.equal(inboundItem.displayName, user.displayName);
  assert.equal(inboundItem.serverMessageId, 'in_1', '入站消息的微信 message_id 应无损透出');
  const sentItem = all.items.find((item) => item.id === sent.id);
  assert.equal(sentItem.status, 'sent');
  assert.equal(sentItem.serverMessageId, 'svr_x');

  assert.equal(store.listMessages({ direction: 'inbound' }).total, 1);
  assert.equal(store.listMessages({ direction: 'outbound' }).total, 2);
  assert.equal(store.listMessages({ direction: 'all', status: 'sent' }).total, 1);
  assert.equal(store.listMessages({ direction: 'all', status: 'queued' }).total, 1);
  assert.equal(store.listMessages({ direction: 'all', status: 'received' }).total, 1);
  assert.equal(store.listMessages({ direction: 'all', userId: user.id }).total, 2);
  assert.equal(store.listMessages({ direction: 'inbound', userId: other.user.id }).total, 0);

  const page = store.listMessages({ direction: 'all', limit: 2, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);
  assert.equal(new Set(page.items.map((item) => `${item.direction}:${item.id}`)).size, 2);
});

test('events / stats / 绑定 token 列表', () => {
  store.addEvent({ type: 'bind', userId: 'u_event_1', detail: 'test-event' });
  const events = store.listEvents(10);
  assert.ok(events.length >= 1);
  assert.equal(events[0].type, 'bind');
  assert.equal(events[0].user_id, 'u_event_1');

  const stats = store.getStats();
  const rawUsers = Number(getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c);
  assert.equal(stats.totalUsers, rawUsers);
  assert.ok(stats.activeUsers >= 0 && stats.pausedUsers >= 0);
  assert.equal(typeof stats.messagesToday, 'number');
  assert.equal(typeof stats.queued, 'number');
  assert.equal(typeof stats.sending, 'number');
  assert.equal(typeof stats.sent, 'number');
  assert.equal(typeof stats.failed, 'number');
  assert.equal(typeof stats.inboundLast24h, 'number');

  const tokens = store.getRecentBindingTokens(10);
  assert.ok(Array.isArray(tokens));
  assert.ok(tokens.length <= 10);
  assert.ok(tokens.every((token) => typeof token === 'string' && token.length > 0));
});

test('deleteUserCascade：删除用户并清理关联数据、定时任务/接口应用目标', () => {
  const target = createUser({ displayName: '待删除用户' }).user;
  const keep = createUser({ displayName: '保留用户' }).user;
  const group = store.createGroup({ name: '删除测试组' });
  store.replaceUserGroups(target.id, [group.id]);
  store.enqueueMessage({ userId: target.id, text: 'queued message' });
  store.saveInbound({ userId: target.id, wechatMessageId: 'wxm_delete_1', text: 'inbound text' });
  store.addEvent({ type: 'test', userId: target.id });

  const db = getDb();
  db.prepare(
    `INSERT INTO attachments (id, direction, kind, mime, size, path, sha256, user_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('att_delete_1', 'inbound', 'image', 'image/jpeg', 10, 'inbound/att_delete_1.jpg', 'hash', target.id, 'ready', Date.now());
  db.prepare(
    `INSERT INTO app_rules (id, name, scope_type, scope_ids, request_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('rule_delete_1', '删除测试规则', 'users', JSON.stringify([target.id, keep.id]), 'https://example.com/x', Date.now(), Date.now());
  const task = store.createScheduledTask({
    name: '删除测试任务',
    enabled: true,
    scheduleType: 'interval',
    intervalMs: 3_600_000,
    targetType: 'users',
    targetIds: [target.id, keep.id],
    requestMethod: 'GET',
    requestUrl: 'https://example.com/x',
    requestHeadersEnc: null,
    requestBodyTemplate: '',
    responseType: 'json',
    responsePath: '',
    replyTemplate: 'hi',
    fallbackText: '',
    timeoutMs: 8000,
    nextRunAt: 0,
  });

  const result = store.deleteUserCascade(target.id);
  assert.equal(result.deleted, true);
  assert.equal(result.user.id, target.id);
  assert.deepEqual(result.attachmentPaths, ['inbound/att_delete_1.jpg']);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM users WHERE id = ?').get(target.id).c), 0);
  for (const table of ['user_groups', 'outbox', 'inbound_messages', 'attachments', 'app_rule_logs', 'events']) {
    assert.equal(
      Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`).get(target.id).c),
      0,
      `${table} 中不应再有被删用户数据`,
    );
  }
  assert.ok(store.getUserRow(keep.id), '其它用户应保留');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM user_groups WHERE group_id = ?').get(group.id).c), 0);
  const ruleScope = JSON.parse(db.prepare('SELECT scope_ids FROM app_rules WHERE id = ?').get('rule_delete_1').scope_ids);
  assert.deepEqual(ruleScope, [keep.id]);
  const taskRow = store.getScheduledTaskRow(task.id);
  assert.deepEqual(JSON.parse(taskRow.target_ids), [keep.id]);
  const deleteEvent = db.prepare("SELECT * FROM events WHERE type = 'user_delete' ORDER BY id DESC LIMIT 1").get();
  assert.ok(deleteEvent, '应写入 user_delete 事件');
  assert.equal(deleteEvent.user_id, null);
  assert.equal(store.deleteUserCascade('u_not_exists'), null);
});