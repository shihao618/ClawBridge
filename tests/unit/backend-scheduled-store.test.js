/**
 * 单元测试：定时通知 store + 计划计算纯函数（docs/SCHEDULED_TASKS.md §1/§3/§5）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-scheduled-store-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'scheduled-store-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'scheduled-store-password';
process.env.API_TOKEN = 'scheduled-store-token';
process.env.LOG_LEVEL = 'silent';

const store = await import('../../server/src/store.js');
const scheduler = await import('../../server/src/scheduler.js');
const { encryptSecret } = await import('../../server/src/crypto.js');
const { closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
function createUser({ active = true, displayName } = {}) {
  seq += 1;
  const user = store.upsertBoundUser({
    wechatUserId: `wx_sched_${seq}`,
    displayName: displayName ?? `定时用户${seq}`,
    ilinkBotId: `bot_sched_${seq}@im.bot`,
    botToken: `sched-token-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
  if (!active) store.unbindUser(user.id);
  return user;
}

function createTask(overrides = {}) {
  return store.createScheduledTask({
    name: '测试任务',
    enabled: true,
    scheduleType: 'interval',
    intervalMs: 3_600_000,
    targetType: 'users',
    targetIds: [],
    requestMethod: 'GET',
    requestUrl: 'https://api.example.com/x',
    requestHeadersEnc: null,
    requestBodyTemplate: '',
    responseType: 'json',
    responsePath: '',
    replyTemplate: 'hi',
    fallbackText: '',
    timeoutMs: 8000,
    nextRunAt: 0,
    ...overrides,
  });
}

test('任务 CRUD / TaskView：headerNames 不含值、targets.names、schedule 视图', () => {
  const group = store.createGroup({ name: '定时目标组' });
  const user = createUser({ displayName: '张三' });
  const headersEnc = encryptSecret(JSON.stringify({ Authorization: 'Bearer top-secret' }));
  const task = createTask({
    name: '天气任务',
    targetType: 'users',
    targetIds: [user.id],
    requestHeadersEnc: headersEnc,
    scheduleType: 'daily',
    dailyTime: '08:30',
    nextRunAt: 12345,
  });
  assert.match(task.id, /^task_/);
  assert.equal(task.name, '天气任务');
  assert.equal(task.enabled, true);
  assert.deepEqual(task.schedule, {
    type: 'daily',
    intervalMs: 3600000,
    dailyTime: '08:30',
    timezone: 'Asia/Shanghai',
  });
  assert.equal(task.targets.type, 'users');
  assert.deepEqual(task.targets.ids, [user.id]);
  assert.deepEqual(task.targets.names, ['张三']);
  assert.deepEqual(task.request.headerNames, ['Authorization']);
  assert.ok(!JSON.stringify(task).includes('Bearer'), 'TaskView 不得包含 header 值');
  assert.equal(task.response.template, 'hi');
  assert.equal(task.nextRunAt, 12345);
  assert.equal(task.lastRunAt, 0);
  assert.equal(task.lastStatus, '');

  // 分组目标 names
  const groupTask = createTask({ name: '分组任务', targetType: 'groups', targetIds: [group.id] });
  assert.deepEqual(groupTask.targets.names, ['定时目标组']);

  // get / list（含 disabled）
  assert.equal(store.getScheduledTask(task.id).name, '天气任务');
  const disabled = createTask({ name: '停用任务', enabled: false });
  const list = store.listScheduledTasks();
  assert.ok(list.some((item) => item.id === task.id));
  assert.ok(list.some((item) => item.id === disabled.id));
  const enabledOnly = store.listScheduledTasks({ includeDisabled: false });
  assert.ok(!enabledOnly.some((item) => item.id === disabled.id));

  // update 局部字段
  const updated = store.updateScheduledTask(task.id, { name: '改名任务', intervalMs: 120000, nextRunAt: 999 });
  assert.equal(updated.name, '改名任务');
  assert.equal(updated.schedule.intervalMs, 120000);
  assert.equal(updated.nextRunAt, 999);
  assert.equal(store.updateScheduledTask('task_missing', { name: 'x' }), null);

  // delete
  assert.equal(store.deleteScheduledTask(task.id), true);
  assert.equal(store.getScheduledTask(task.id), null);
  assert.equal(store.deleteScheduledTask(task.id), false);
});

test('到期查询 / markScheduledTaskRun / 日志写入与过滤分页', () => {
  const taskA = createTask({ name: '到期A', nextRunAt: 1000 });
  const taskB = createTask({ name: '到期B', nextRunAt: 2000 });
  const taskC = createTask({ name: '未到期C', nextRunAt: 9000 });
  const disabled = createTask({ name: '停用到期', nextRunAt: 500, enabled: false });

  const due = store.listDueScheduledTasks(2500, 10);
  const dueIds = due.map((row) => row.id);
  assert.deepEqual(
    dueIds.filter((id) => [taskA.id, taskB.id].includes(id)),
    [taskA.id, taskB.id],
    '到期任务按 next_run_at ASC',
  );
  assert.ok(!dueIds.includes(taskC.id) && !dueIds.includes(disabled.id));
  assert.equal(store.listDueScheduledTasks(2500, 1).length, 1, 'limit 生效');

  assert.equal(store.markScheduledTaskRun(taskA.id, { lastRunAt: 3000, lastStatus: 'success', nextRunAt: 4000 }), true);
  const row = store.getScheduledTaskRow(taskA.id);
  assert.equal(Number(row.last_run_at), 3000);
  assert.equal(row.last_status, 'success');
  assert.equal(Number(row.next_run_at), 4000);

  const logId = store.insertScheduledTaskLog({
    taskId: taskA.id,
    status: 'success',
    httpStatus: 200,
    latencyMs: 12,
    responsePreview: '{"ok":1}',
    replyPreview: '通知文本',
    recipientsCount: 2,
    createdAt: 5000,
  });
  assert.ok(logId > 0);
  store.insertScheduledTaskLog({ taskId: taskB.id, status: 'failed', error: 'HTTP 500', createdAt: 5001 });
  const all = store.listScheduledTaskLogs({ limit: 10 });
  assert.equal(all.total, 2);
  const success = store.listScheduledTaskLogs({ taskId: taskA.id, status: 'success' });
  assert.equal(success.total, 1);
  assert.equal(success.items[0].taskName, '到期A');
  assert.equal(success.items[0].httpStatus, 200);
  assert.equal(success.items[0].latencyMs, 12);
  assert.equal(success.items[0].replyPreview, '通知文本');
  assert.equal(success.items[0].recipientsCount, 2);
  const failed = store.listScheduledTaskLogs({ status: 'failed' });
  assert.equal(failed.total, 1);
  assert.equal(failed.items[0].error, 'HTTP 500');
  const page = store.listScheduledTaskLogs({ limit: 1, offset: 1 });
  assert.equal(page.items.length, 1);
});

test('目标解析：users active 过滤 / groups 去重 / 稳定排序 / 上限截断', () => {
  const userA = createUser();
  const userB = createUser();
  const inactive = createUser({ active: false });
  const group1 = store.createGroup({ name: '目标组1' });
  const group2 = store.createGroup({ name: '目标组2' });
  store.replaceUserGroups(userA.id, [group1.id, group2.id]);
  store.replaceUserGroups(userB.id, [group1.id]);
  store.replaceUserGroups(inactive.id, [group2.id]);

  const userTask = createTask({ targetType: 'users', targetIds: [userA.id, inactive.id, userB.id] });
  const byUsers = store.resolveScheduledTaskRecipients(store.getScheduledTaskRow(userTask.id));
  assert.deepEqual(byUsers.userIds, [userA.id, userB.id].sort());
  assert.equal(byUsers.total, 2);
  assert.equal(byUsers.truncated, false);

  const groupTask = createTask({ targetType: 'groups', targetIds: [group1.id, group2.id] });
  const byGroups = store.resolveScheduledTaskRecipients(store.getScheduledTaskRow(groupTask.id));
  assert.deepEqual(byGroups.userIds, [userA.id, userB.id].sort(), '分组去重且排除 unbound');
  assert.equal(byGroups.total, 2);

  const limited = store.resolveScheduledTaskRecipients(store.getScheduledTaskRow(groupTask.id), { maxRecipients: 1 });
  assert.equal(limited.userIds.length, 1);
  assert.equal(limited.total, 2);
  assert.equal(limited.truncated, true);
});

test('计划计算：interval / daily（时区、跨天、严格晚于 now）/ 补跑顺延', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01 08:00 Asia/Shanghai
  // interval
  assert.equal(scheduler.computeInitialNextRun({ scheduleType: 'interval', intervalMs: 60000 }, now), now + 60000);
  assert.equal(scheduler.computeInitialNextRun({ scheduleType: 'interval', intervalMs: 1000 }, now), now + 60000, 'interval 最小 60s');
  assert.equal(scheduler.computeNextAfterRun({ schedule_type: 'interval', interval_ms: 120000 }, 5000), 125000);
  assert.equal(scheduler.advanceIntervalNextRun(1000, 60000, 1000 + 20 * 60000), 1000 + 20 * 60000 + 60000);

  // daily：今天 09:00 Asia/Shanghai = 01:00Z
  assert.equal(scheduler.computeDailyNextRun(now, '09:00'), Date.UTC(2026, 0, 1, 1, 0, 0));
  // 恰好到点 → 严格晚于 now → 明天
  assert.equal(scheduler.computeDailyNextRun(Date.UTC(2026, 0, 1, 1, 0, 0), '09:00'), Date.UTC(2026, 0, 2, 1, 0, 0));
  // 今天已过 → 明天
  assert.equal(scheduler.computeDailyNextRun(Date.UTC(2026, 0, 1, 2, 0, 0), '09:00'), Date.UTC(2026, 0, 2, 1, 0, 0));
  // 跨月（1/31 → 2/1）
  assert.equal(scheduler.computeDailyNextRun(Date.UTC(2026, 0, 31, 2, 0, 0), '09:00'), Date.UTC(2026, 1, 1, 1, 0, 0));
  // 不同时区：UTC 时区 09:00 = 09:00Z
  assert.equal(scheduler.computeDailyNextRun(now, '09:00', 'UTC'), Date.UTC(2026, 0, 1, 9, 0, 0));
  // store view / 规范化任务对象（schedule.type）也必须按 daily 计算，不能退化成 interval
  const runAt = Date.UTC(2026, 0, 1, 14, 15, 0); // 2026-01-01 22:15 Asia/Shanghai
  assert.equal(
    scheduler.computeNextAfterRun({ schedule: { type: 'daily', dailyTime: '21:15', intervalMs: 3_600_000 } }, runAt),
    Date.UTC(2026, 0, 2, 13, 15, 0),
    'daily 任务执行后下一次应是次日 21:15，而不是 +1 小时（intervalMs 不能误用）',
  );
  assert.equal(
    scheduler.computeInitialNextRun({ schedule: { type: 'daily', dailyTime: '09:00' } }, now),
    Date.UTC(2026, 0, 1, 1, 0, 0),
  );
  assert.equal(
    scheduler.computeNextAfterRun({ schedule: { type: 'interval', intervalMs: 120_000 } }, 5000),
    125_000,
  );
  // 非法 HH:mm
  assert.equal(scheduler.computeDailyNextRun(now, '25:00'), null);
  assert.equal(scheduler.parseDailyTime('08:05').hour, 8);
  assert.equal(scheduler.parseDailyTime('8:05'), null);
  assert.equal(scheduler.parseDailyTime('08:60'), null);

  // 启动对账：next=0 初始化；interval 过期 >5min 顺延；≤5min 保持到期；daily 过期保持到期；disabled 跳过
  const initTask = createTask({ name: '初始化', nextRunAt: 0 });
  const lateTask = createTask({ name: '长期过期', nextRunAt: now - 60 * 60 * 1000, intervalMs: 60000 });
  const recentTask = createTask({ name: '刚过期', nextRunAt: now - 60 * 1000, intervalMs: 60000 });
  const dailyTask = createTask({ name: 'daily过期', scheduleType: 'daily', dailyTime: '09:00', nextRunAt: now - 60 * 1000 });
  const disabledTask = createTask({ name: '停用不处理', nextRunAt: 0, enabled: false });

  const changed = scheduler.reconcileStartupTasks(now);
  assert.ok(changed >= 2);
  assert.equal(store.getScheduledTaskRow(initTask.id).next_run_at, now + 3_600_000);
  assert.equal(Number(store.getScheduledTaskRow(lateTask.id).next_run_at) > now, true, '长期过期应顺延到未来');
  assert.equal(Number(store.getScheduledTaskRow(recentTask.id).next_run_at), now - 60 * 1000, '≤5min 过期保持到期补跑');
  assert.equal(Number(store.getScheduledTaskRow(dailyTask.id).next_run_at), now - 60 * 1000, 'daily 过期保持到期补跑');
  assert.equal(Number(store.getScheduledTaskRow(disabledTask.id).next_run_at), 0, 'disabled 不处理');
});
