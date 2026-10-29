/**
 * 单元测试：store.js 保活扩展（schema v4，docs/KEEPALIVE.md §3）。
 * 临时 DATA_DIR + 真实 SQLite，无网络。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-keepalive-store-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'keepalive-store-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'keepalive-store-password';
process.env.API_TOKEN = 'keepalive-store-token';
process.env.LOG_LEVEL = 'silent';

const store = await import('../../server/src/store.js');
const { closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
function createUser(overrides = {}) {
  seq += 1;
  return store.upsertBoundUser({
    wechatUserId: overrides.wechatUserId ?? `wx_keepalive_${seq}`,
    displayName: overrides.displayName ?? `保活用户${seq}`,
    ilinkBotId: `bot_keepalive_${seq}@im.bot`,
    botToken: `keepalive-token-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
}

const WINDOW = 2000;
const LEAD = 200;
const TRIGGER = WINDOW - LEAD; // 1800

/** 构造一个 active + 开启保活 + 最后入站时间为 lastInbound 的用户。 */
function createCandidate({ lastInbound = 1000, enabled = true, displayName } = {}) {
  const user = createUser({ displayName });
  store.touchInbound(user.id, lastInbound);
  if (enabled) store.setKeepaliveEnabled(user.id, true);
  return user;
}

const candidateIds = (now, options = {}) =>
  store.getKeepaliveCandidates(now, { windowMs: WINDOW, leadMs: LEAD, limit: 100, ...options }).map((row) => row.id);

test('setKeepaliveEnabled / setKeepaliveLastSentAt / 用户视图字段', () => {
  const user = createUser();
  assert.equal(store.getUser(user.id).keepaliveEnabled, false);
  assert.equal(store.getUser(user.id).keepaliveLastSentAt, 0);

  assert.equal(store.setKeepaliveEnabled(user.id, true), true);
  assert.equal(store.setKeepaliveEnabled('u_missing', true), false);
  let view = store.getUser(user.id);
  assert.equal(view.keepaliveEnabled, true);
  const list = store.listUsers({ status: 'all', q: user.wechatUserId });
  assert.equal(list.items[0].keepaliveEnabled, true);

  assert.equal(store.setKeepaliveLastSentAt(user.id, 12345), true);
  view = store.getUser(user.id);
  assert.equal(view.keepaliveLastSentAt, 12345);
  assert.equal(store.getUserWithCounts(user.id).keepaliveLastSentAt, 12345);

  // 关闭
  store.setKeepaliveEnabled(user.id, false);
  assert.equal(store.getUser(user.id).keepaliveEnabled, false);
  // 入参布尔语义（0/1 落库）
  store.setKeepaliveEnabled(user.id, true);
  assert.equal(store.getUser(user.id).keepaliveEnabled, true);
});

test('分组批量开关：返回更新数、包含 unbound 成员、用户视图同步', () => {
  const group = store.createGroup({ name: '保活批量组' });
  const active = createUser();
  const unbound = createUser();
  store.unbindUser(unbound.id);
  store.replaceUserGroups(active.id, [group.id]);
  store.replaceUserGroups(unbound.id, [group.id]);
  // 组外用户不应被更新
  const outsider = createUser();

  assert.equal(store.setGroupKeepaliveEnabled(group.id, true), 2);
  assert.equal(store.getUser(active.id).keepaliveEnabled, true);
  assert.equal(store.getUser(unbound.id).keepaliveEnabled, true);
  assert.equal(store.getUser(outsider.id).keepaliveEnabled, false);
  assert.equal(store.setGroupKeepaliveEnabled(group.id, false), 2);
  assert.equal(store.getUser(active.id).keepaliveEnabled, false);
  assert.equal(store.setGroupKeepaliveEnabled('grp_missing', true), 0);
});

test('getKeepaliveCandidates：8 条触发条件与边界', () => {
  // 基准：lastInbound=1000，now=1000+TRIGGER 恰好达到触发点
  const exact = createCandidate({ lastInbound: 1000 });
  assert.deepEqual(candidateIds(1000 + TRIGGER), [exact.id], 'now-lastInbound=window-lead 应触发');

  // 未到触发点（少 1ms）不触发
  assert.deepEqual(candidateIds(1000 + TRIGGER - 1), []);

  // 窗口过期（now-lastInbound >= window）不触发
  assert.deepEqual(candidateIds(1000 + WINDOW), []);

  // 关闭保活不触发
  const disabled = createCandidate({ lastInbound: 1001, enabled: false });
  assert.ok(!candidateIds(1000 + TRIGGER + 1).includes(disabled.id));

  // 冷却中（pause_until > now）不触发
  const paused = createCandidate({ lastInbound: 1002 });
  store.setUserPaused(paused.id, 5000, 'stale');
  assert.ok(!candidateIds(1000 + TRIGGER + 2).includes(paused.id));

  // unbound 不触发
  const unbound = createCandidate({ lastInbound: 1003 });
  store.unbindUser(unbound.id);
  assert.ok(!candidateIds(4000).includes(unbound.id));

  // last_inbound_at=0 不触发
  const neverInbound = createUser();
  store.setKeepaliveEnabled(neverInbound.id, true);
  assert.ok(!candidateIds(5000).includes(neverInbound.id));

  // 本窗口已发过（last_sent >= last_inbound）不触发
  const already = createCandidate({ lastInbound: 1004 });
  store.setKeepaliveLastSentAt(already.id, 1004);
  assert.ok(!candidateIds(1000 + TRIGGER + 4).includes(already.id));

  // 用户回复后（lastInbound > last_sent）进入新窗口可再次触发
  store.touchInbound(already.id, 3000);
  assert.ok(candidateIds(3000 + TRIGGER).includes(already.id), '用户回复后新窗口可触发');

  // 排序（last_inbound_at ASC）+ limit（now=3800 时 1800 <= now-last < 2000）
  const orderedA = createCandidate({ lastInbound: 1900 });
  const orderedB = createCandidate({ lastInbound: 1850 });
  const orderedC = createCandidate({ lastInbound: 1950 });
  const now = 3800;
  const ordered = store
    .getKeepaliveCandidates(now, { windowMs: WINDOW, leadMs: LEAD, limit: 2 })
    .map((row) => row.id);
  assert.deepEqual(ordered, [orderedB.id, orderedA.id], '按 last_inbound_at ASC 且 limit 生效');
  assert.ok(!ordered.includes(orderedC.id));

  // effectiveLeadMs = min(lead, window)：lead > window 时不应逻辑反转
  const zeroLead = createCandidate({ lastInbound: 100 });
  assert.ok(
    store
      .getKeepaliveCandidates(500, { windowMs: WINDOW, leadMs: 99999, limit: 100 })
      .some((row) => row.id === zeroLead.id || row.id === exact.id),
  );
});

test('统计与消息 source 字段', () => {
  const user = createCandidate({ lastInbound: 1, enabled: false });
  const before = store.getStats();
  store.setKeepaliveEnabled(user.id, true);
  const after = store.getStats();
  assert.equal(typeof after.keepaliveEnabledUsers, 'number');
  assert.equal(typeof after.keepaliveSent24h, 'number');
  assert.ok(after.keepaliveEnabledUsers >= before.keepaliveEnabledUsers + 1);

  const outbox = store.enqueueMessage({ userId: user.id, text: '保活消息', source: 'keepalive' });
  assert.equal(outbox.source, 'keepalive');
  const messages = store.listMessages({ direction: 'outbound', userId: user.id, limit: 10 });
  const item = messages.items.find((message) => message.id === outbox.id);
  assert.equal(item.source, 'keepalive', '管理端消息视图应带 source');
  assert.equal(store.getOutbox(outbox.id).source, 'keepalive');
  assert.ok(store.countKeepaliveSent24h() >= 1);
  assert.ok(store.countKeepaliveEnabled() >= 1);
});
