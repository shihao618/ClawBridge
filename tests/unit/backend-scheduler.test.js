/**
 * 单元测试：scheduler 执行/tick/dry-run/start-stop（docs/SCHEDULED_TASKS.md §3/§4/§8）。
 * 本地假 HTTP server；不触真实外网。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-scheduler-engine-',
  env: {
    APP_SECRET: 'scheduler-engine-secret-0123456789abcdef0123456789abcdef',
    ADMIN_PASSWORD: 'scheduler-engine-password',
    API_TOKEN: 'scheduler-engine-token',
    LOG_LEVEL: 'silent',
    APP_RULES_ALLOWED_HOSTS: '127.0.0.1',
  },
});

const scheduler = await import('../../server/src/scheduler.js');
const store = await import('../../server/src/store.js');
const { getDb } = await import('../../server/src/db.js');
const { config } = await import('../../server/src/config.js');
const userSecrets = await import('../../server/src/data/user-secrets.js');
const { defaultHttpRequest } = await import('../../server/src/shared/http-client.js');

let server;
let port = 0;
/** 按用户模式测试：外部 API 收到的请求记录与并发观测。 */
const perUserRequests = [];
let perUserActive = 0;
let perUserMaxActive = 0;

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
    if (url.pathname === '/slow') {
      // 延迟响应，用于验证 stop 等待在途 tick）
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { answer: 'SLOW' } }));
      }, 150);
      return;
    }
    if (url.pathname === '/boom') {
      res.destroy();
      return;
    }
    if (url.pathname === '/per-user' || url.pathname === '/per-user-slow') {
      const token = url.searchParams.get('token') ?? '';
      perUserRequests.push({ token, pathname: url.pathname, at: Date.now() });
      perUserActive += 1;
      perUserMaxActive = Math.max(perUserMaxActive, perUserActive);
      const finish = () => {
        perUserActive -= 1;
        if (token === 'bad-token') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"error":"boom"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { answer: `token:${token}` } }));
      };
      if (url.pathname === '/per-user-slow') setTimeout(finish, 120);
      else finish();
      return;
    }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"boom"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(async () => {
  await scheduler.stop();
  scheduler.resetDependencies();
  if (server) await new Promise((resolve) => server.close(resolve));
  await cleanupUnitEnv(unitEnv);
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

test('立即执行成功：真实调用→解析→逐目标入队→写日志，保留 next_run_at', async () => {  const userA = createUser();
  const userB = createUser();
  const task = createTask({ name: '成功任务', targetIds: [userA.id, userB.id] });
  const nextBefore = Number(store.getScheduledTaskRow(task.id).next_run_at);

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
  assert.equal(Number(row.next_run_at), nextBefore, '手动执行不应改变 next_run_at');
});

test('模板 {{noreply}}：不发送任何消息、不使用兜底文案，但仍记录成功日志', async () => {
  const user = createUser();
  const task = createTask({
    name: '不回复任务',
    targetIds: [user.id],
    replyTemplate: '{{#if data.missing}}{{data.missing}}{{else}}{{noreply}}{{/if}}',
    responsePath: '', // 根对象：{data:{answer:'OK'}} → 无 data.answer 命中 else 分支
    fallbackText: '不应发送的兜底',
  });

  const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: false });
  assert.equal(result.status, 'success');
  assert.equal(result.noreply, true);
  assert.equal(result.replyText, '');
  assert.equal(result.recipientsCount, 0);
  assert.equal(outboxFor(user.id).length, 0, '不回复时不应入队任何消息');

  const logs = logsFor(task.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'success');
  assert.equal(Number(logs[0].recipients_count), 0);
  assert.match(logs[0].reply_preview, /不回复/, '日志应记录不回复（未使用兜底）');
  assert.ok(!String(logs[0].reply_preview).includes('不应发送的兜底'), '日志不应出现兜底文案内容');
});

test('同一任务并发执行：第二个请求 409，不会重复调用外部接口/发消息', async () => {
  const user = createUser();
  const task = createTask({ name: '并发任务', targetIds: [user.id] });
  scheduler.configureDependencies({
    httpRequest: async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return defaultHttpRequest(options);
    },
  });
  try {
    const first = scheduler.runScheduledTaskNow(task.id, { dryRun: false });
    await assert.rejects(
      scheduler.runScheduledTaskNow(task.id, { dryRun: false }),
      (err) => err?.code === 'CONFLICT' && /正在执行/.test(err.message),
    );
    const result = await first;
    assert.equal(result.status, 'success');
    assert.equal(outboxFor(user.id).length, 1, '并发请求不应重复入队');
    assert.equal(logsFor(task.id).length, 1, '并发请求不应重复写日志');
  } finally {
    scheduler.resetDependencies();
  }
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

test('tick：单任务异常不影响其他任务（httpRequest 抛错任务失败但后续任务仍执行）', async () => {
  const user = createUser();
  const now = Date.now();
  const boom = createTask({ name: '异常任务', targetIds: [user.id], nextRunAt: now - 1000, requestUrl: `http://127.0.0.1:${port}/boom` });
  const ok = createTask({ name: '正常任务', targetIds: [user.id], nextRunAt: now - 500 });
  scheduler.configureDependencies({
    httpRequest: async (options) => {
      if (String(options.url).includes('/boom')) throw new Error('网络异常（注入）');
      return defaultHttpRequest(options);
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

test('网络防护配置：scheduler.maxResponseBytes/allowedHosts 缺省继承 appRules，显式配置覆盖）', async () => {
  const user = createUser();
  const task = createTask({ name: '配置来源任务', targetIds: [user.id] });
  const prevSchedHosts = config.scheduler.allowedHosts;
  const prevSchedBytes = config.scheduler.maxResponseBytes;
  try {
    // 缺省（0/[]）→ 继承 appRules 白名单与大小上限，历史行为不变（可访问环境变量放行的 127.0.0.1）
    config.scheduler.maxResponseBytes = 0;
    config.scheduler.allowedHosts = [];
    assert.deepEqual(scheduler.getHttpLimits(), {
      maxResponseBytes: config.appRules.maxResponseBytes,
      allowedHosts: config.appRules.allowedHosts,
    });
    const ok = await scheduler.runScheduledTaskNow(task.id, { dryRun: true });
    assert.equal(ok.status, 'success');

    // 显式覆盖白名单（不含 127.0.0.1）→ SSRF 拒绝
    config.scheduler.allowedHosts = ['not-allowed.example'];
    assert.deepEqual(scheduler.getHttpLimits().allowedHosts, ['not-allowed.example']);
    const denied = await scheduler.runScheduledTaskNow(task.id, { dryRun: true });
    assert.equal(denied.status, 'failed');
    assert.match(String(denied.error), /SSRF|私网|内网/);

    // 显式覆盖大小上限（极小值）→ 响应体超限失败
    config.scheduler.allowedHosts = [];
    config.scheduler.maxResponseBytes = 32;
    const tooBig = await scheduler.runScheduledTaskNow(task.id, { dryRun: true });
    assert.equal(tooBig.status, 'failed');
    assert.match(String(tooBig.error), /大小上限/);
  } finally {
    config.scheduler.allowedHosts = prevSchedHosts;
    config.scheduler.maxResponseBytes = prevSchedBytes;
  }
});

test('start/stop 幂等（stop 为异步，等待在途任务）；未启动时 runScheduledTaskNow 仍可执行（API 手动触发）', async () => {
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.isRunning(), true);
  assert.equal(scheduler.start(), false);
  assert.equal(await scheduler.stop(), true);
  assert.equal(scheduler.isRunning(), false);
  assert.equal(await scheduler.stop(), false);
  assert.equal(scheduler.start(), true);
  assert.equal(await scheduler.stop(), true);

  const missing = scheduler.runScheduledTaskNow('task_missing', { dryRun: true });
  assert.ok(missing instanceof Promise);
});

test('stop 等待在途 tick settle 后才返回，在途任务的日志/next_run_at 已落库）', async () => {
  const user = createUser();
  const now = Date.now();
  const task = createTask({
    name: '退出在途任务',
    targetIds: [user.id],
    nextRunAt: now - 1000,
    requestUrl: `http://127.0.0.1:${port}/slow`,
  });
  const tickPromise = scheduler.tick(now);
  // 留出时间让 tick 进入在途 HTTP 请求（/slow 固定延迟 150ms）
  await new Promise((resolve) => setTimeout(resolve, 30));
  const startedAt = Date.now();
  await scheduler.stop();
  const elapsed = Date.now() - startedAt;
  await tickPromise;
  assert.ok(elapsed >= 100, `stop 应等待在途 tick（实际等待 ${elapsed}ms）`);
  assert.equal(logsFor(task.id).length, 1, '在途 tick 的运行日志应在 stop 返回前写入');
  assert.equal(store.getScheduledTaskRow(task.id).last_status, 'success');
  assert.ok(Number(store.getScheduledTaskRow(task.id).next_run_at) > now, 'next_run_at 应已推进');
});

test('restart 先等待在途 tick，再按配置重新启动）', async () => {
  assert.equal(scheduler.start(), true);
  const restarted = await scheduler.restart();
  assert.equal(restarted, true);
  assert.equal(scheduler.isRunning(), true);
  assert.equal(await scheduler.stop(), true);
});

// ---------------------------------------------------------------------------
// 按用户模式（per_user_mode）：凭据注入 + 逐用户请求/回复
// ---------------------------------------------------------------------------

function createPerUserTask(overrides = {}) {
  return createTask({
    name: '按用户任务',
    perUserMode: true,
    requestUrl: `http://127.0.0.1:${port}/per-user?token={credential:gps.token}`,
    responsePath: '',
    replyTemplate: '{{data.answer}}|{{userName}}|{{userId}}',
    ...overrides,
  });
}

function seedGpsToken(userId, token) {
  userSecrets.setUserSecret(userId, { name: 'gps', label: 'GPS', fields: { token } });
}

function recipientEventsFor(taskId) {
  return getDb()
    .prepare("SELECT * FROM events WHERE type LIKE 'scheduled_recipient_%' ORDER BY id ASC")
    .all()
    .filter((row) => {
      try {
        return JSON.parse(row.detail).taskId === taskId;
      } catch {
        return false;
      }
    });
}

test('按用户模式：多用户共享凭据合并一次请求 + 按用户渲染回复', async () => {
  perUserRequests.length = 0;
  const userA = createUser({ displayName: '共享甲' });
  const userB = createUser({ displayName: '共享乙' });
  const userC = createUser({ displayName: '独立丙' });
  seedGpsToken(userA.id, 'shared-token');
  seedGpsToken(userB.id, 'shared-token');
  seedGpsToken(userC.id, 'other-token');
  const task = createPerUserTask({ targetIds: [userA.id, userB.id, userC.id] });

  const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: false });
  assert.equal(result.status, 'success');
  assert.equal(result.recipientsCount, 3);
  assert.equal(result.perUserMode, true);
  assert.equal(perUserRequests.length, 2, '共享凭据 + 相同模板应合并为 2 组请求');
  assert.deepEqual(perUserRequests.map((item) => item.token).sort(), ['other-token', 'shared-token']);

  assert.equal(outboxFor(userA.id).length, 1);
  assert.equal(outboxFor(userA.id)[0].text, `token:shared-token|共享甲|${userA.id}`);
  assert.equal(outboxFor(userB.id)[0].text, `token:shared-token|共享乙|${userB.id}`);
  assert.equal(outboxFor(userC.id)[0].text, `token:other-token|独立丙|${userC.id}`);

  const logs = logsFor(task.id);
  assert.equal(logs.at(-1).status, 'success');
  assert.equal(Number(logs.at(-1).recipients_count), 3);
  assert.equal(store.getScheduledTaskRow(task.id).last_status, 'success');
  // 凭据最近使用时间已更新（且 DB 中无明文值 —— user-secrets 模块保证）
  const used = userSecrets.listUserSecrets(userA.id).find((item) => item.name === 'gps');
  assert.ok(used.lastUsedAt > 0, '按用户模式使用凭据后应更新 last_used_at');
});

test('按用户模式：缺凭据跳过（写事件、不兜底）+ 部分成功 partial', async () => {
  perUserRequests.length = 0;
  const userOk = createUser({ displayName: '有凭据' });
  const userMissing = createUser({ displayName: '缺凭据' });
  seedGpsToken(userOk.id, 'ok-token');
  const task = createPerUserTask({ targetIds: [userOk.id, userMissing.id], fallbackText: '兜底通知' });

  const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: false });
  assert.equal(result.status, 'partial');
  assert.equal(result.successCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.match(result.error, /missing credential gps\.token/);
  assert.equal(outboxFor(userOk.id).length, 1);
  assert.equal(outboxFor(userMissing.id).length, 0, '缺凭据应跳过且不使用兜底文案');
  assert.equal(perUserRequests.length, 1, '缺凭据用户不应发起请求');

  const logs = logsFor(task.id);
  assert.equal(logs.at(-1).status, 'partial');
  assert.equal(Number(logs.at(-1).recipients_count), 1);

  const skipped = recipientEventsFor(task.id).find((row) => row.type === 'scheduled_recipient_skipped');
  assert.ok(skipped, '应写 scheduled_recipient_skipped 事件');
  const detail = JSON.parse(skipped.detail);
  assert.equal(detail.userId, userMissing.id);
  assert.deepEqual(detail.missing, ['gps.token']);
  assert.equal(skipped.user_id, userMissing.id);
});

test('按用户模式：单用户请求失败只影响该用户（按配置兜底）+ failed 事件', async () => {
  perUserRequests.length = 0;
  const userGood = createUser({ displayName: '正常用户' });
  const userBad = createUser({ displayName: '失败用户' });
  seedGpsToken(userGood.id, 'good-token');
  seedGpsToken(userBad.id, 'bad-token');
  const task = createPerUserTask({ targetIds: [userGood.id, userBad.id], fallbackText: '兜底通知' });

  const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: false });
  assert.equal(result.status, 'partial');
  assert.equal(result.failedCount, 1);
  assert.equal(outboxFor(userGood.id)[0].text, `token:good-token|正常用户|${userGood.id}`);
  assert.equal(outboxFor(userBad.id)[0].text, '兜底通知', '失败用户应按配置收到兜底文案');

  const failedEvent = recipientEventsFor(task.id).find((row) => row.type === 'scheduled_recipient_failed');
  assert.ok(failedEvent, '应写 scheduled_recipient_failed 事件');
  const detail = JSON.parse(failedEvent.detail);
  assert.equal(detail.userId, userBad.id);
  assert.equal(detail.httpStatus, 500);
  assert.deepEqual(detail.credentials, ['gps']);
  assert.ok(!JSON.stringify(detail).includes('bad-token'), '事件明细不得包含凭据值');
});

test('按用户模式：整组请求网络失败 → 每个失败用户按配置兜底（failed 状态，事件无明文）', async () => {
  perUserRequests.length = 0;
  const userA = createUser({ displayName: '网络失败甲' });
  const userB = createUser({ displayName: '网络失败乙' });
  seedGpsToken(userA.id, 'netfail-a');
  seedGpsToken(userB.id, 'netfail-b');
  const task = createPerUserTask({
    targetIds: [userA.id, userB.id],
    requestUrl: `http://127.0.0.1:${port}/boom?token={credential:gps.token}`,
    fallbackText: '网络失败兜底',
  });

  const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: false });
  assert.equal(result.status, 'failed', '全部用户都未成功送达 → failed');
  assert.equal(result.failedCount, 2);
  for (const user of [userA, userB]) {
    assert.equal(outboxFor(user.id).length, 1, `${user.displayName} 应按配置收到兜底`);
    assert.equal(outboxFor(user.id)[0].text, '网络失败兜底');
  }

  const failedEvents = recipientEventsFor(task.id).filter((row) => row.type === 'scheduled_recipient_failed');
  assert.equal(failedEvents.length, 2);
  assert.ok(!JSON.stringify(failedEvents).includes('netfail-a'), '事件明细不得包含凭据值');
  const log = logsFor(task.id).at(-1);
  assert.equal(log.status, 'failed');
  assert.equal(Number(log.recipients_count), 2);
  assert.ok(!String(log.error).includes('netfail'));
});

test('按用户模式：{{noreply}} 逐用户生效（不发送、不兜底、状态 success）', async () => {
  perUserRequests.length = 0;
  const userA = createUser();
  const userB = createUser();
  seedGpsToken(userA.id, 'noreply-a');
  seedGpsToken(userB.id, 'noreply-b');
  const task = createPerUserTask({ targetIds: [userA.id, userB.id], replyTemplate: '{{noreply}}' });

  const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: false });
  assert.equal(result.status, 'success');
  assert.equal(result.noreply, true);
  assert.equal(result.recipientsCount, 0);
  assert.equal(outboxFor(userA.id).length, 0);
  assert.equal(outboxFor(userB.id).length, 0);
  const logs = logsFor(task.id);
  assert.equal(logs.at(-1).status, 'success');
  assert.ok(String(logs.at(-1).reply_preview).includes('按用户模式'));
});

test('按用户模式：perUserMaxRecipients 上限截断（运行配置实时读取）', async () => {
  perUserRequests.length = 0;
  const userA = createUser();
  const userB = createUser();
  seedGpsToken(userA.id, 'limit-a');
  seedGpsToken(userB.id, 'limit-b');
  const prev = config.scheduler.perUserMaxRecipients;
  config.scheduler.perUserMaxRecipients = 1;
  try {
    const task = createPerUserTask({ targetIds: [userA.id, userB.id] });
    const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: false });
    assert.equal(result.truncated, true);
    assert.equal(result.recipientsTotal, 2);
    assert.equal(result.recipientsCount, 1);
    assert.equal(perUserRequests.length, 1);
  } finally {
    config.scheduler.perUserMaxRecipients = prev;
  }
});

test('按用户模式：并发池受 perUserConcurrency 限制', async () => {
  perUserRequests.length = 0;
  perUserMaxActive = 0;
  const users = [];
  for (let index = 0; index < 4; index += 1) {
    const user = createUser();
    seedGpsToken(user.id, `concurrent-${index}`);
    users.push(user);
  }
  const prev = config.scheduler.perUserConcurrency;
  config.scheduler.perUserConcurrency = 2;
  try {
    const task = createPerUserTask({
      targetIds: users.map((user) => user.id),
      requestUrl: `http://127.0.0.1:${port}/per-user-slow?token={credential:gps.token}`,
    });
    const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: false });
    assert.equal(result.status, 'success');
    assert.equal(perUserRequests.length, 4);
    assert.ok(perUserMaxActive <= 2, `并发不应超过配置上限（实际 ${perUserMaxActive}）`);
  } finally {
    config.scheduler.perUserConcurrency = prev;
  }
});

test('按用户模式：dry-run 真实调用但不发送/不写日志/不写事件/不推进 next_run_at', async () => {
  perUserRequests.length = 0;
  const user = createUser();
  seedGpsToken(user.id, 'dry-token');
  const task = createPerUserTask({ targetIds: [user.id], fallbackText: '兜底' });
  const nextBefore = Number(store.getScheduledTaskRow(task.id).next_run_at);

  const result = await scheduler.runScheduledTaskNow(task.id, { dryRun: true });
  assert.equal(result.status, 'success');
  assert.equal(perUserRequests.length, 1);
  assert.equal(outboxFor(user.id).length, 0);
  assert.equal(logsFor(task.id).length, 0);
  assert.equal(recipientEventsFor(task.id).length, 0);
  assert.equal(Number(store.getScheduledTaskRow(task.id).next_run_at), nextBefore);
});
