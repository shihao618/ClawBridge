/**
 * 单元测试：scheduler 执行/tick/dry-run/start-stop（docs/SCHEDULED_TASKS.md §3/§4/§8）。
 * 本地假 HTTP server；不触真实外网。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-scheduler-engine-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'scheduler-engine-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'scheduler-engine-password';
process.env.API_TOKEN = 'scheduler-engine-token';
process.env.LOG_LEVEL = 'silent';
process.env.APP_RULES_ALLOWED_HOSTS = '127.0.0.1';

const scheduler = await import('../../server/src/scheduler.js');
const store = await import('../../server/src/store.js');
const { getDb, closeDb } = await import('../../server/src/db.js');

let server;
let port = 0;

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { answer: `OK:${url.searchParams.get('city') ?? ''}` } }));
      return;
    }
    if (url.pathname === '/text') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('纯文本通知');
      return;
    }
    if (url.pathname === '/boom') {
      res.destroy();
      return;
    }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"boom"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(async () => {
  scheduler.stop();
  scheduler.resetDependencies();
  closeDb();
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
function createUser({ active = true, displayName } = {}) {
  seq += 1;
  const user = store.upsertBoundUser({
    wechatUserId: `wx_sched_engine_${seq}`,
    displayName: displayName ?? `调度用户${seq}`,
    ilinkBotId: `bot_sched_engine_${seq}@im.bot`,
    botToken: `sched-engine-token-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
  if (!active) store.unbindUser(user.id);
  return user;
}

function createTask(overrides = {}) {
  return store.createScheduledTask({
    name: '调度任务',
    enabled: true,
    scheduleType: 'interval',
    intervalMs: 60_000,
    targetType: 'users',
    targetIds: [],
    requestMethod: 'GET',
    requestUrl: `http://127.0.0.1:${port}/ok?city={taskName}`,
    requestHeadersEnc: null,
    requestBodyTemplate: '',
    responseType: 'json',
    responsePath: 'data',
    replyTemplate: '通知：{{answer}}',
    fallbackText: '兜底通知',
    timeoutMs: 2000,
    nextRunAt: Date.now() + 60_000,
    ...overrides,
  });
}

const outboxFor = (userId) =>
  getDb().prepare("SELECT * FROM outbox WHERE user_id = ? AND source = 'schedule' ORDER BY id ASC").all(userId);
const logsFor = (taskId) =>
  getDb().prepare('SELECT * FROM scheduled_task_logs WHERE task_id = ? ORDER BY id ASC').all(taskId);

test('立即执行成功：真实调用→解析→逐目标入队 source=schedule→写日志/更新 next_run_at', async () => {
  const userA = createUser();
  const userB = createUser();
  const task = createTask({ name: '成功任务', targetIds: [userA.id, userB.id] });

  const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: false });
  assert.equal(result.status, 'success');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.error, '');
  assert.equal(result.recipientsCount, 2);
  assert.equal(result.replyText, '通知：OK:成功任务');
  assert.match(result.responsePreview, /OK:成功任务/);

  for (const user of [userA, userB]) {
    const rows = outboxFor(user.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, '通知：OK:成功任务');
    assert.equal(rows[0].status, 'queued');
  }
  const logs = logsFor(task.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'success');
  assert.equal(Number(logs[0].http_status), 200);
  assert.equal(Number(logs[0].recipients_count), 2);
  assert.match(logs[0].reply_preview, /OK:成功任务/);

  const row = store.getScheduledTaskRow(task.id);
  assert.equal(row.last_status, 'success');
  assert.ok(Number(row.last_run_at) > 0);
  assert.ok(Number(row.next_run_at) > Number(row.last_run_at), 'interval 下一次 = 执行开始 + 间隔');
});

test('失败 fallback：非 2xx → failed 日志 + fallback 文案发给全部目标', async () => {
  const user = createUser();
  const task = createTask({
    name: '失败任务',
    targetIds: [user.id],
    requestUrl: `http://127.0.0.1:${port}/fail`,
    fallbackText: '接口失败兜底',
  });
  const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.httpStatus, 500);
  assert.match(result.error, /HTTP 500/);
  assert.equal(result.recipientsCount, 1);
  const rows = outboxFor(user.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '接口失败兜底');
  const logs = logsFor(task.id);
  assert.equal(logs[0].status, 'failed');
  assert.equal(Number(logs[0].recipients_count), 1);
});

test('失败且无 fallback → 不发送，仅写 failed 日志（recipients_count=0）', async () => {
  const user = createUser();
  const task = createTask({
    name: '无兜底任务',
    targetIds: [user.id],
    requestUrl: `http://127.0.0.1:${port}/fail`,
    fallbackText: '',
  });
  const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.replyText, '');
  assert.equal(result.recipientsCount, 0);
  assert.equal(outboxFor(user.id).length, 0);
  const logs = logsFor(task.id);
  assert.equal(logs[0].status, 'failed');
  assert.equal(Number(logs[0].recipients_count), 0);
});

test('dry-run：真实调用/渲染但不发送、不写日志、不更新 next_run_at', async () => {
  const user = createUser();
  const task = createTask({ name: '测试运行任务', targetIds: [user.id] });
  const outboxBefore = Number(getDb().prepare('SELECT COUNT(*) AS c FROM outbox').get().c);
  const logsBefore = Number(getDb().prepare('SELECT COUNT(*) AS c FROM scheduled_task_logs').get().c);
  const nextBefore = Number(store.getScheduledTaskRow(task.id).next_run_at);

  const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: true });
  assert.equal(result.status, 'success');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.replyText, '通知：OK:测试运行任务');
  assert.equal(result.recipientsCount, 1);
  assert.equal(result.request.headerNames.length, 0);
  assert.equal(typeof result.responseHeaders, 'object');

  assert.equal(Number(getDb().prepare('SELECT COUNT(*) AS c FROM outbox').get().c), outboxBefore, 'dry-run 不发消息');
  assert.equal(Number(getDb().prepare('SELECT COUNT(*) AS c FROM scheduled_task_logs').get().c), logsBefore, 'dry-run 不写日志');
  assert.equal(Number(store.getScheduledTaskRow(task.id).next_run_at), nextBefore, 'dry-run 不改 next_run_at');
});

test('目标去重/active 过滤：分组与用户重叠时每人只发一次，unbound 跳过', async () => {
  const active = createUser();
  const inactive = createUser({ active: false });
  const group = store.createGroup({ name: '调度目标组' });
  store.replaceUserGroups(active.id, [group.id]);
  store.replaceUserGroups(inactive.id, [group.id]);
  const task = createTask({ name: '去重任务', targetType: 'groups', targetIds: [group.id] });
  const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: false });
  assert.equal(result.recipientsCount, 1);
  assert.equal(outboxFor(active.id).length, 1);
  assert.equal(outboxFor(inactive.id).length, 0);
});

test('tick：只执行到期任务、顺序执行、写日志并推进 next_run_at', async () => {
  const user = createUser();
  const now = Date.now();
  const dueA = createTask({ name: '到期A', targetIds: [user.id], nextRunAt: now - 2000 });
  const dueB = createTask({ name: '到期B', targetIds: [user.id], nextRunAt: now - 1000 });
  const future = createTask({ name: '未到期', targetIds: [user.id], nextRunAt: now + 60_000 });

  const executed = await scheduler.tick(now);
  assert.equal(executed, 2);
  assert.equal(logsFor(dueA.id).length, 1);
  assert.equal(logsFor(dueB.id).length, 1);
  assert.equal(logsFor(future.id).length, 0);
  assert.ok(Number(store.getScheduledTaskRow(dueA.id).next_run_at) > now);
  assert.ok(Number(store.getScheduledTaskRow(dueB.id).next_run_at) > now);

  // 同一 now 再次 tick → 无到期任务
  assert.equal(await scheduler.tick(now), 0);
});

test('tick：单任务异常不影响其他任务（fetch 抛错任务失败但后续任务仍执行）', async () => {
  const user = createUser();
  const now = Date.now();
  const boom = createTask({ name: '异常任务', targetIds: [user.id], nextRunAt: now - 1000, requestUrl: `http://127.0.0.1:${port}/boom` });
  const ok = createTask({ name: '正常任务', targetIds: [user.id], nextRunAt: now - 500 });
  const realFetch = (...args) => globalThis.fetch(...args);
  scheduler.configureDependencies({
    fetch: async (...args) => {
      if (String(args[0]).includes('/boom')) throw new Error('网络异常（注入）');
      return realFetch(...args);
    },
  });
  try {
    const executed = await scheduler.tick(now);
    assert.equal(executed, 2);
    assert.equal(logsFor(boom.id)[0].status, 'failed');
    assert.equal(logsFor(ok.id)[0].status, 'success');
  } finally {
    scheduler.resetDependencies();
  }
});

test('start/stop 幂等；未启动时 runScheduledTaskNow 仍可执行（API 手动触发）', () => {
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.isRunning(), true);
  assert.equal(scheduler.start(), false);
  assert.equal(scheduler.stop(), true);
  assert.equal(scheduler.isRunning(), false);
  assert.equal(scheduler.stop(), false);
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.stop(), true);

  const missing = scheduler.runScheduledTaskNow('task_missing', { dryRun: true });
  assert.ok(missing instanceof Promise);
});
