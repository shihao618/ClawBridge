/**
 * 单元测试：定时通知 interval 每日生效时间段（schema v9，task-47）。
 * 覆盖：窗口判断/下一次窗口计算/创建与执行后 next_run_at 调整/跨午夜/端点/启动对账/API 校验。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-scheduled-window-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'scheduled-window-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'scheduled-window-admin-password';
process.env.API_TOKEN = 'scheduled-window-token-123456';
process.env.ILINK_LOGIN_BASE_URL = 'http://127.0.0.1:9';
process.env.ILINK_BASE_URL = 'http://127.0.0.1:9';
process.env.SCHEDULER_TIMEZONE = 'UTC';
process.env.LOG_LEVEL = 'silent';

const scheduler = await import('../../server/src/scheduler.js');
const store = await import('../../server/src/store.js');
const { getDb, closeDb } = await import('../../server/src/db.js');
const { createApp } = await import('../../server/src/api.js');

let server;
let base = '';
let cookie = '';
const CSRF = { 'x-requested-with': 'ClawBridge-Admin' };

before(async () => {
  const { seedTestAdminSecrets } = await import('./backend-test-secrets.js');
  seedTestAdminSecrets();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'scheduled-window-admin-password' }),
  });
  await login.text();
  cookie = /cb_session=[^;]+/.exec(login.headers.get('set-cookie') || '')[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(method, pathName, { body, headers = {} } = {}) {
  const response = await fetch(base + pathName, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}
const adminWrite = (method, pathName, body) => request(method, pathName, { body, headers: { cookie, ...CSRF } });

const at = (hour, minute, day = 1) => Date.UTC(2026, 0, day, hour, minute, 0);
const iso = (ts) => new Date(ts).toISOString();
const baseTask = (overrides = {}) => ({
  scheduleType: 'interval',
  intervalMs: 3_600_000,
  windowStart: '09:00',
  windowEnd: '18:00',
  ...overrides,
});
const createTask = (overrides = {}) =>
  store.createScheduledTask({
    name: '窗口任务',
    enabled: true,
    scheduleType: 'interval',
    intervalMs: 3_600_000,
    targetType: 'users',
    targetIds: [],
    requestMethod: 'GET',
    requestUrl: 'http://127.0.0.1:9/x',
    responseType: 'json',
    responsePath: '',
    replyTemplate: 'hi',
    fallbackText: '',
    timeoutMs: 1000,
    nextRunAt: 0,
    ...overrides,
  });

test('isInDailyWindow / nextWindowStart：普通窗口、跨午夜、端点边界', () => {
  // 普通窗口 [09:00, 18:00)
  assert.equal(scheduler.isInDailyWindow(at(9, 0), '09:00', '18:00'), true, 'start 端点在内');
  assert.equal(scheduler.isInDailyWindow(at(17, 59), '09:00', '18:00'), true);
  assert.equal(scheduler.isInDailyWindow(at(18, 0), '09:00', '18:00'), false, 'end 端点在外');
  assert.equal(scheduler.isInDailyWindow(at(8, 59), '09:00', '18:00'), false);
  // 跨午夜 [22:00, 06:00)
  assert.equal(scheduler.isInDailyWindow(at(22, 0), '22:00', '06:00'), true);
  assert.equal(scheduler.isInDailyWindow(at(23, 30), '22:00', '06:00'), true);
  assert.equal(scheduler.isInDailyWindow(at(1, 0), '22:00', '06:00'), true);
  assert.equal(scheduler.isInDailyWindow(at(5, 59), '22:00', '06:00'), true);
  assert.equal(scheduler.isInDailyWindow(at(6, 0), '22:00', '06:00'), false);
  assert.equal(scheduler.isInDailyWindow(at(21, 59), '22:00', '06:00'), false);
  // 非法窗口
  assert.equal(scheduler.isInDailyWindow(at(10, 0), '10:00', '10:00'), false);
  assert.equal(scheduler.parseClockTime('08:05'), 485);
  assert.equal(scheduler.parseClockTime('8:05'), null);
  assert.equal(scheduler.parseClockTime('24:00'), null);

  // nextWindowStart：严格大于 ts 的下一次窗口开始
  assert.equal(iso(scheduler.nextWindowStart(at(7, 0), '09:00', '18:00')), iso(at(9, 0)), '早于窗口 → 当天 09:00');
  assert.equal(iso(scheduler.nextWindowStart(at(10, 0), '09:00', '18:00')), iso(at(9, 0, 2)), '窗口内 → 次日 09:00（严格大于）');
  assert.equal(iso(scheduler.nextWindowStart(at(19, 0), '09:00', '18:00')), iso(at(9, 0, 2)), '晚于窗口 → 次日 09:00');
  assert.equal(iso(scheduler.nextWindowStart(at(23, 30), '22:00', '06:00')), iso(at(22, 0, 2)), '跨午夜窗口内 → 次日 22:00');
  assert.equal(iso(scheduler.nextWindowStart(at(6, 30), '22:00', '06:00')), iso(at(22, 0)), '跨午夜窗口后 → 当天 22:00');
});

test('computeInitialNextRun：窗口内/前/后/超出 end 均落窗口（含跨午夜）', () => {
  const task = baseTask();
  // 早于窗口 → 当天窗口 start
  assert.equal(iso(scheduler.computeInitialNextRun(task, at(7, 0))), iso(at(9, 0)));
  // 窗口内 → now+interval
  assert.equal(iso(scheduler.computeInitialNextRun(task, at(10, 0))), iso(at(11, 0)));
  // 窗口内但 now+interval 超出 end → 下一个窗口 start
  assert.equal(iso(scheduler.computeInitialNextRun(task, at(17, 30))), iso(at(9, 0, 2)));
  // 晚于窗口 end → 下一个窗口 start
  assert.equal(iso(scheduler.computeInitialNextRun(task, at(19, 0))), iso(at(9, 0, 2)));

  const cross = baseTask({ windowStart: '22:00', windowEnd: '06:00' });
  // 跨午夜窗口内（23:00）→ 次日 00:00（仍在窗口内）
  assert.equal(iso(scheduler.computeInitialNextRun(cross, at(23, 0))), iso(at(0, 0, 2)));
  // 跨午夜窗口内（05:30）→ 06:30 超出 end → 当天 22:00
  assert.equal(iso(scheduler.computeInitialNextRun(cross, at(5, 30))), iso(at(22, 0)));
  // 跨午夜窗口外（21:00）→ 当天 22:00
  assert.equal(iso(scheduler.computeInitialNextRun(cross, at(21, 0))), iso(at(22, 0)));

  // 无窗口：行为不变
  assert.equal(iso(scheduler.computeInitialNextRun(baseTask({ windowStart: '', windowEnd: '' }), at(10, 0))), iso(at(11, 0)));
  // daily：忽略窗口语义（仍按 daily 计算）
  assert.equal(
    iso(scheduler.computeInitialNextRun({ scheduleType: 'daily', dailyTime: '09:00', windowStart: '09:00', windowEnd: '18:00' }, at(8, 0))),
    iso(at(9, 0)),
  );
});

test('computeNextAfterRun：执行后在窗口内沿用 candidate，否则下一个窗口 start（跨午夜正确）', () => {
  const task = baseTask();
  assert.equal(iso(scheduler.computeNextAfterRun(task, at(10, 0))), iso(at(11, 0)), 'candidate 在窗口内');
  assert.equal(iso(scheduler.computeNextAfterRun(task, at(17, 30))), iso(at(9, 0, 2)), 'candidate 超出 end → 次日 09:00');
  const cross = baseTask({ windowStart: '22:00', windowEnd: '06:00' });
  assert.equal(iso(scheduler.computeNextAfterRun(cross, at(23, 0))), iso(at(0, 0, 2)));
  assert.equal(iso(scheduler.computeNextAfterRun(cross, at(5, 30))), iso(at(22, 0)), 'candidate 06:30 在窗口外 → 当天 22:00');
  // 无窗口不变
  assert.equal(iso(scheduler.computeNextAfterRun(baseTask({ windowStart: '', windowEnd: '' }), at(23, 0))), iso(at(0, 0, 2)));
});

test('reconcileStartupTasks：窗口外 next 修正、next=0 初始化、过期超窗口内容再顺延', () => {
  const now = at(12, 0);
  const windowOpts = { windowStart: '09:00', windowEnd: '18:00' };
  const outsideFuture = createTask({ ...windowOpts, name: '未来窗口外', nextRunAt: at(19, 0) });
  const outsideOverdue = createTask({ ...windowOpts, name: '过期窗口外', nextRunAt: at(8, 0) });
  const zeroNext = createTask({ ...windowOpts, name: '未初始化', nextRunAt: 0 });
  const insideOverdue = createTask({ ...windowOpts, name: '窗口内过期', nextRunAt: now - 10 * 60 * 1000 });
  const insideRecent = createTask({ ...windowOpts, name: '窗口内刚过期', nextRunAt: now - 60 * 1000 });
  const changed = scheduler.reconcileStartupTasks(now);
  assert.ok(changed >= 4, `changed=${changed}`);

  const rowOf = (id) => store.getScheduledTaskRow(id);
  // 未来但在窗口外 → 修正到该时间之后的窗口 start（次日 09:00）
  assert.equal(Number(rowOf(outsideFuture.id).next_run_at), at(9, 0, 2));
  // 过期且在窗口外 → 下一个窗口 start（当天 12:00 后为次日 09:00）
  assert.equal(Number(rowOf(outsideOverdue.id).next_run_at), at(9, 0, 2));
  // next=0 → 按初始规则（now 在窗口内 → now+interval=13:00）
  assert.equal(Number(rowOf(zeroNext.id).next_run_at), at(13, 0));
  // 窗口内过期 >5min → 推进周期并落回窗口（10:50 + n*1h → 13:00 在窗口内? 用 advance 算法结果校验在窗口内且>now）
  const advanced = Number(rowOf(insideOverdue.id).next_run_at);
  assert.ok(advanced > now && scheduler.isInDailyWindow(advanced, '09:00', '18:00'), `告警：${iso(advanced)}`);
  // 窗口内 ≤5min 过期 → 保持到期补跑
  assert.equal(Number(rowOf(insideRecent.id).next_run_at), now - 60 * 1000);
});

test('store/TaskView：windowStart/windowEnd 持久化与默认空值', () => {
  const withWindow = createTask({ windowStart: '08:00', windowEnd: '20:00', nextRunAt: 0 });
  assert.deepEqual(
    { windowStart: withWindow.schedule.windowStart, windowEnd: withWindow.schedule.windowEnd },
    { windowStart: '08:00', windowEnd: '20:00' },
  );
  const row = store.getScheduledTaskRow(withWindow.id);
  assert.equal(row.window_start, '08:00');
  assert.equal(row.window_end, '20:00');

  const noWindow = createTask({ windowStart: '', windowEnd: '' });
  assert.deepEqual(
    { windowStart: noWindow.schedule.windowStart, windowEnd: noWindow.schedule.windowEnd },
    { windowStart: '', windowEnd: '' },
  );

  // update 持久化
  const updated = store.updateScheduledTask(withWindow.id, { windowStart: '22:00', windowEnd: '06:00' });
  assert.equal(updated.schedule.windowStart, '22:00');
  assert.equal(updated.schedule.windowEnd, '06:00');
});

test('API：间隔任务窗口字段创建/更新/TaskView；nextRunAt 落在窗口内；非法值 400', async () => {
  const body = {
    name: 'API窗口任务',
    enabled: true,
    schedule: { type: 'interval', intervalMs: 3600000, windowStart: '09:00', windowEnd: '18:00' },
    targets: { type: 'users', ids: [] },
    request: { method: 'GET', url: 'http://127.0.0.1:9/x' },
    response: { type: 'json', path: '', template: 'hi', fallbackText: '' },
    timeoutMs: 1000,
  };
  // 空 targets 不允许（复用已有校验），补一个真实用户
  const user = store.upsertBoundUser({
    wechatUserId: 'wx_sched_window_api',
    displayName: '窗口API用户',
    ilinkBotId: 'bot_sched_window@im.bot',
    botToken: 'sched-window-bot-token',
    baseUrl: 'https://ilink.example.test',
  }).user;
  body.targets.ids = [user.id];

  const created = await adminWrite('POST', '/api/admin/scheduled-tasks', body);
  assert.equal(created.status, 201, created.text);
  const task = created.json.task;
  assert.equal(task.schedule.windowStart, '09:00');
  assert.equal(task.schedule.windowEnd, '18:00');
  assert.ok(
    scheduler.isInDailyWindow(task.nextRunAt, '09:00', '18:00'),
    `nextRunAt 应落在窗口内：${iso(task.nextRunAt)}`,
  );

  // PATCH 修改窗口 → 持久化 + nextRunAt 重算
  const patched = await adminWrite('PATCH', `/api/admin/scheduled-tasks/${task.id}`, {
    schedule: { type: 'interval', intervalMs: 7200000, windowStart: '22:00', windowEnd: '06:00' },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.task.schedule.windowStart, '22:00');
  assert.equal(patched.json.task.schedule.windowEnd, '06:00');
  assert.ok(
    scheduler.isInDailyWindow(patched.json.task.nextRunAt, '22:00', '06:00'),
    `跨午夜 nextRunAt 应落在窗口内：${iso(patched.json.task.nextRunAt)}`,
  );

  // 清空窗口
  const cleared = await adminWrite('PATCH', `/api/admin/scheduled-tasks/${task.id}`, {
    schedule: { type: 'interval', intervalMs: 3600000, windowStart: '', windowEnd: '' },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.task.schedule.windowStart, '');

  // 非法值 400
  const invalidBodies = [
    [{ ...body, schedule: { type: 'interval', intervalMs: 3600000, windowStart: '09:00' } }, '同时为空或同时填写'],
    [{ ...body, schedule: { type: 'interval', intervalMs: 3600000, windowStart: '09:00', windowEnd: '' } }, '同时为空或同时填写'],
    [{ ...body, schedule: { type: 'interval', intervalMs: 3600000, windowStart: '09:00', windowEnd: '09:00' } }, '不能相同'],
    [{ ...body, schedule: { type: 'interval', intervalMs: 3600000, windowStart: '9:00', windowEnd: '18:00' } }, 'HH:mm'],
    [{ ...body, schedule: { type: 'interval', intervalMs: 3600000, windowStart: '09:00', windowEnd: '24:00' } }, 'HH:mm'],
    [{ ...body, schedule: { type: 'daily', dailyTime: '08:00', windowStart: '09:00', windowEnd: '18:00' } }, 'daily'],
    [{ ...body, schedule: { type: 'interval', intervalMs: 3600000, windowStart: 900, windowEnd: 1800 } }, 'HH:mm 字符串'],
  ];
  for (const [invalidBody, snippet] of invalidBodies) {
    const result = await adminWrite('POST', '/api/admin/scheduled-tasks', invalidBody);
    assert.equal(result.status, 400, `${snippet} 应 400：${result.text}`);
    assert.match(result.json.error.message || result.text, new RegExp(snippet));
  }

  // DB schema v9 + 旧数据列默认值
  assert.equal(getDb().prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
  const columns = new Set(getDb().prepare('PRAGMA table_info(scheduled_tasks)').all().map((row) => row.name));
  assert.ok(columns.has('window_start') && columns.has('window_end'));
});
