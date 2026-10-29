/**
 * 单元测试：keepalive.js 调度（假时钟 scan，docs/KEEPALIVE.md §3）。
 * 直接调用 scan(now) 验证：触发一次/同窗口不重复/用户回复后新窗口/模板/maxPerTick/失败不崩/全局开关。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-keepalive-scheduler-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'keepalive-scheduler-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'keepalive-scheduler-password';
process.env.API_TOKEN = 'keepalive-scheduler-token';
process.env.LOG_LEVEL = 'silent';

const keepalive = await import('../../server/src/keepalive.js');
const store = await import('../../server/src/store.js');
const { getDb, closeDb } = await import('../../server/src/db.js');

test.after(() => {
  keepalive.stop();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
function createCandidate({ lastInbound, displayName, enabled = true } = {}) {
  seq += 1;
  const user = store.upsertBoundUser({
    wechatUserId: `wx_ka_sched_${seq}`,
    displayName: displayName ?? `保活调度用户${seq}`,
    ilinkBotId: `bot_ka_sched_${seq}@im.bot`,
    botToken: `ka-sched-token-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
  store.touchInbound(user.id, lastInbound);
  if (enabled) store.setKeepaliveEnabled(user.id, true);
  return user;
}

const WINDOW = 2000;
const LEAD = 200;
const OPTS = { windowMs: WINDOW, leadMs: LEAD, limit: 100 };

const keepaliveOutboxCount = (userId) =>
  Number(
    getDb()
      .prepare("SELECT COUNT(*) AS c FROM outbox WHERE user_id = ? AND source = 'keepalive'")
      .get(userId).c,
  );

test('scan：窗口临近时触发一次，同窗口不重复', async () => {
  const user = createCandidate({ lastInbound: 1000 });
  assert.equal(await keepalive.scan(1000 + 1800, OPTS), 1);

  const outbox = getDb()
    .prepare("SELECT * FROM outbox WHERE user_id = ? AND source = 'keepalive'")
    .get(user.id);
  assert.ok(outbox, '应入队一条 source=keepalive 的 outbox');
  assert.equal(outbox.status, 'queued');
  assert.ok(outbox.text.length > 0);
  assert.equal(Number(store.getUserRow(user.id).keepalive_last_sent_at), 2800);
  const event = getDb().prepare("SELECT * FROM events WHERE user_id = ? AND type = 'keepalive'").get(user.id);
  assert.ok(event, '应写入 keepalive 事件');

  // 同窗口不重复
  assert.equal(await keepalive.scan(2801, OPTS), 0);
  assert.equal(await keepalive.scan(2999, OPTS), 0);
  assert.equal(keepaliveOutboxCount(user.id), 1);
});

test('scan：用户回复后进入新窗口可再次触发；窗口过期不触发', async () => {
  const user = createCandidate({ lastInbound: 1000 });
  assert.equal(await keepalive.scan(2800, OPTS), 1);
  assert.equal(await keepalive.scan(2801, OPTS), 0);

  // 用户回复 → last_inbound_at 更新 → 新窗口
  store.touchInbound(user.id, 5000);
  assert.equal(await keepalive.scan(6800, OPTS), 1, '新窗口应再次触发');
  assert.equal(keepaliveOutboxCount(user.id), 2);

  // 窗口过期（now-last >= window）不触发
  store.touchInbound(user.id, 9000);
  assert.equal(await keepalive.scan(9000 + WINDOW, OPTS), 0, '窗口过期不发送');
  assert.equal(keepaliveOutboxCount(user.id), 2);
});

test('scan：模板 {name} 渲染、maxPerTick 限制、关闭保活用户不触发', async () => {
  const user = createCandidate({ lastInbound: 1000, displayName: '张三' });
  assert.equal(await keepalive.scan(2800, { ...OPTS, text: 'Hi {name}，回复任意内容刷新窗口' }), 1);
  const outbox = getDb().prepare("SELECT text FROM outbox WHERE user_id = ? AND source = 'keepalive'").get(user.id);
  assert.equal(outbox.text, 'Hi 张三，回复任意内容刷新窗口');

  // maxPerTick：3 个候选只处理 2 个，下一轮处理剩余
  const batch = [createCandidate({ lastInbound: 500 }), createCandidate({ lastInbound: 500 }), createCandidate({ lastInbound: 500 })];
  const now = 500 + 1800;
  assert.equal(await keepalive.scan(now, { ...OPTS, limit: 2, text: '批量' }), 2);
  assert.equal(await keepalive.scan(now + 1, { ...OPTS, limit: 2, text: '批量' }), 1);
  assert.equal(await keepalive.scan(now + 2, { ...OPTS, limit: 2, text: '批量' }), 0);
  assert.ok(batch.every((candidate) => keepaliveOutboxCount(candidate.id) === 1));

  // 关闭保活不触发
  const disabled = createCandidate({ lastInbound: 100, enabled: false });
  assert.equal(await keepalive.scan(1900, { ...OPTS, text: 'x' }), 0);
  assert.equal(keepaliveOutboxCount(disabled.id), 0);
});

test('scan：enqueue 失败不崩溃、不写 last_sent，下个 tick 可重试', async () => {
  const user = createCandidate({ lastInbound: 1000 });
  const original = store.getUserRow(user.id).keepalive_last_sent_at;

  const sent = await keepalive.scan(2800, {
    ...OPTS,
    enqueueMessage: () => {
      throw new Error('模拟入队失败');
    },
  });
  assert.equal(sent, 0, '失败时本次入队数为 0 且不抛错');
  assert.equal(Number(store.getUserRow(user.id).keepalive_last_sent_at), Number(original), '失败不应写 last_sent');
  assert.equal(keepaliveOutboxCount(user.id), 0);

  // 下一次正常扫描可重试成功
  assert.equal(await keepalive.scan(2801, OPTS), 1);
  assert.equal(keepaliveOutboxCount(user.id), 1);
});

test('scan：全局开关关闭时不扫描', async () => {
  const user = createCandidate({ lastInbound: 1000 });
  assert.equal(await keepalive.scan(2800, { ...OPTS, enabled: false }), 0);
  assert.equal(keepaliveOutboxCount(user.id), 0);
});

test('start/stop：幂等，重复调用安全', () => {
  assert.equal(keepalive.start(), true);
  assert.equal(keepalive.isRunning(), true);
  assert.equal(keepalive.start(), false, '重复 start 应返回 false');
  assert.equal(keepalive.stop(), true);
  assert.equal(keepalive.isRunning(), false);
  assert.equal(keepalive.stop(), false, '重复 stop 应安全返回 false');
  assert.equal(keepalive.start(), true);
  assert.equal(keepalive.stop(), true);
});
