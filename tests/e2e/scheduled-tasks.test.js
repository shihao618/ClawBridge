/**
 * e2e：定时通知（定时访问外部接口 → 解析 → 发微信给指定用户/分组；docs/SCHEDULED_TASKS.md §5/§8）。
 *
 * 说明：任务 interval 最小 60000ms，等调度器自然到期不现实。
 * 因此 e2e 用 `POST /api/admin/scheduled-tasks/{id}/run`（立即执行）覆盖真实执行链路
 * （外部接口调用→解析→渲染→outbox source=schedule→mock 微信收到），
 * 调度器的 nextRunAt 计算/到期扫描由单测覆盖；dry-run 用 `POST /:id/test` 验证。
 *
 * 外部接口用进程内 node:http mock（127.0.0.1 随机端口），不触真实外网。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { sleep, startE2E, startMockApi, waitFor } from '../helpers/e2e-env.mjs';

let e2e;
let externalApi;
let user1;
let user2;
let user3;
let user4;
let user5;
let groupMain;
let groupExtra;
let seq = 0;
const nextName = (prefix) => `${prefix}-${(seq += 1)}`;

function taskBody(overrides = {}) {
  return {
    name: nextName('定时任务'),
    enabled: true,
    schedule: { type: 'interval', intervalMs: 60000 },
    targets: { type: 'users', ids: [user1.id] },
    request: { method: 'GET', url: `${externalApi.baseUrl}/sched`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: '', template: '{{data.answer}}', fallbackText: '定时通知兜底' },
    timeoutMs: 3000,
    ...overrides,
  };
}

async function createTaskOrFail(body) {
  const res = await e2e.createScheduledTask(body);
  assert.equal(res.status, 201, `创建定时任务应 201，实际 ${res.status}：${res.text}`);
  assert.ok(res.json?.task?.id?.startsWith('task_'), `TaskView.id 应为 task_ 前缀：${res.text}`);
  return res.json.task;
}

/** 统计 mock 微信发给某用户的文本消息条数（可带子串过滤）。 */
async function mockSentCount(toUserId, substring) {
  const state = await e2e.mockState();
  return state.sentMessages.filter(
    (item) =>
      item.toUserId === toUserId &&
      typeof item.text === 'string' &&
      (substring === undefined || item.text.includes(substring)),
  ).length;
}

before(async () => {
  e2e = await startE2E();
  externalApi = await startMockApi();
  await e2e.ensureAdmin();

  const bound = [];
  for (let i = 1; i <= 5; i += 1) {
    bound.push(await e2e.bindUser({ displayName: `定时用户${i}`, waitMonitor: true }));
  }
  user1 = bound[0].user;
  user2 = bound[1].user;
  user3 = bound[2].user;
  user4 = bound[3].user;
  user5 = bound[4].user;

  const created = await e2e.createGroup({ name: '定时通知分组' });
  assert.equal(created.status, 201, `创建分组失败：${created.status} ${created.text}`);
  groupMain = created.json.group;
  const extra = await e2e.createGroup({ name: '定时通知分组2' });
  assert.equal(extra.status, 201);
  groupExtra = extra.json.group;

  // 分组1：u3、u4、u5（u5 之后解绑，用于 active 过滤）
  await e2e.assignUserGroups(user3.id, [groupMain.id]);
  await e2e.assignUserGroups(user4.id, [groupMain.id]);
  await e2e.assignUserGroups(user5.id, [groupMain.id]);
  // 分组2：u3（用于跨分组去重）
  await e2e.assignUserGroups(user3.id, [groupMain.id, groupExtra.id]);
  // u5 解绑（unbound 不应收到定时通知）
  const unbind = await e2e.adminWrite('POST', `/api/admin/users/${user5.id}/unbind`);
  assert.equal(unbind.status, 200, `解绑用户5失败：${unbind.status} ${unbind.text}`);
});

after(async () => {
  await externalApi?.close().catch(() => {});
  await e2e?.cleanup();
});

test('任务 CRUD / TaskView 字段 / 校验（400/404）/ 鉴权（401/403）', async () => {
  await e2e.ensureAdmin();
  externalApi.setResponse({ json: { data: { answer: 'CRUD' } } });

  // 创建 interval 任务
  const intervalTask = await createTaskOrFail({
    ...taskBody(),
    name: '间隔任务',
    schedule: { type: 'interval', intervalMs: 60000 },
    targets: { type: 'users', ids: [user1.id] },
    request: {
      method: 'GET',
      url: `${externalApi.baseUrl}/crud?x={now}`,
      headers: { Authorization: 'Bearer super-secret-token', 'X-Custom': 'cv' },
      bodyTemplate: '',
    },
    timeoutMs: 3000,
  });
  assert.match(intervalTask.id, /^task_/);
  assert.equal(intervalTask.name, '间隔任务');
  assert.equal(intervalTask.enabled, true);
  assert.equal(intervalTask.schedule.type, 'interval');
  assert.equal(intervalTask.schedule.intervalMs, 60000);
  assert.equal(typeof intervalTask.schedule.timezone, 'string');
  assert.equal(intervalTask.targets.type, 'users');
  assert.deepEqual(intervalTask.targets.ids, [user1.id]);
  assert.equal(intervalTask.request.method, 'GET');
  assert.ok(intervalTask.request.url.includes('{now}'));
  assert.ok(Array.isArray(intervalTask.request.headerNames));
  assert.deepEqual(intervalTask.request.headerNames.sort(), ['Authorization', 'X-Custom'].sort());
  assert.equal(intervalTask.response.type, 'json');
  assert.equal(intervalTask.response.template, '{{data.answer}}');
  assert.equal(intervalTask.limits.timeoutMs, 3000);
  assert.equal(typeof intervalTask.nextRunAt, 'number');
  assert.ok(intervalTask.nextRunAt > Date.now(), `创建后 nextRunAt 应在未来：${intervalTask.nextRunAt}`);
  assert.equal(intervalTask.lastRunAt, 0);
  assert.equal(intervalTask.lastStatus, '');
  assert.equal(typeof intervalTask.createdAt, 'number');
  // Header 值不得回显
  const createText = JSON.stringify(intervalTask);
  assert.equal(createText.includes('super-secret-token'), false, 'TaskView 不应回显 Header 值');
  assert.equal(createText.includes('"cv"'), false, 'TaskView 不应回显 Header 值');

  // 创建 daily 任务
  const dailyTask = await createTaskOrFail({
    ...taskBody(),
    name: '每日任务',
    schedule: { type: 'daily', dailyTime: '08:00' },
    targets: { type: 'users', ids: [user2.id] },
  });
  assert.equal(dailyTask.schedule.type, 'daily');
  assert.equal(dailyTask.schedule.dailyTime, '08:00');
  assert.ok(dailyTask.nextRunAt > Date.now(), '每日任务 nextRunAt 应在未来');

  // 列表 / 详情
  const list = await e2e.listScheduledTasks();
  assert.equal(list.status, 200, `任务列表失败：${list.status} ${list.text}`);
  assert.ok(Array.isArray(list.json.items));
  assert.ok(list.json.items.some((item) => item.id === intervalTask.id));
  assert.equal(list.text.includes('super-secret-token'), false, '任务列表不应回显 Header 值');
  const detail = await e2e.getScheduledTask(intervalTask.id);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.task.id, intervalTask.id);
  assert.equal(detail.text.includes('super-secret-token'), false, '任务详情不应回显 Header 值');

  // 更新：计划变更 → nextRunAt 重算；headers {} 清空
  const patched = await e2e.updateScheduledTask(intervalTask.id, {
    name: '间隔任务-改名',
    schedule: { type: 'interval', intervalMs: 120000 },
    request: {
      method: 'GET',
      url: `${externalApi.baseUrl}/crud2`,
      headers: {},
      bodyTemplate: '',
    },
  });
  assert.equal(patched.status, 200, `更新任务应 200：${patched.status} ${patched.text}`);
  assert.equal(patched.json.task.name, '间隔任务-改名');
  assert.equal(patched.json.task.schedule.intervalMs, 120000);
  assert.deepEqual(patched.json.task.request.headerNames, [], 'headers 传 {} 应清空');
  assert.ok(patched.json.task.nextRunAt > Date.now(), '更新计划后 nextRunAt 应重算');

  // 非法参数 → 400
  const invalidBodies = [
    { ...taskBody(), name: '' },
    { ...taskBody(), schedule: { type: 'hourly', intervalMs: 60000 } },
    { ...taskBody(), schedule: { type: 'interval', intervalMs: 1000 } },
    { ...taskBody(), schedule: { type: 'daily', dailyTime: '25:61' } },
    { ...taskBody(), targets: { type: 'all', ids: [] } },
    { ...taskBody(), targets: { type: 'users', ids: [] } },
    { ...taskBody(), targets: { type: 'users', ids: ['u_not_exists_e2e'] } },
    { ...taskBody(), targets: { type: 'groups', ids: ['grp_not_exists_e2e'] } },
    { ...taskBody(), request: { method: 'GET', url: 'ftp://example.com/x', headers: {}, bodyTemplate: '' } },
    { ...taskBody(), request: { method: 'GET', url: 'http://user:pass@example.com/x', headers: {}, bodyTemplate: '' } },
    { ...taskBody(), timeoutMs: 100 },
    { ...taskBody(), response: { type: 'xml', path: '', template: '', fallbackText: '' } },
    { ...taskBody(), enabled: 'yes' },
  ];
  for (const body of invalidBodies) {
    const res = await e2e.createScheduledTask(body);
    assert.equal(res.status, 400, `非法任务参数应 400：${res.status} ${res.text}`);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
  }

  // 未知任务 → 404
  for (const res of [
    await e2e.getScheduledTask('task_not_exists_e2e'),
    await e2e.updateScheduledTask('task_not_exists_e2e', { name: 'x' }),
    await e2e.deleteScheduledTask('task_not_exists_e2e'),
    await e2e.runScheduledTask('task_not_exists_e2e'),
    await e2e.testScheduledTask('task_not_exists_e2e'),
  ]) {
    assert.equal(res.status, 404, `未知任务应 404：${res.status} ${res.text}`);
    assert.equal(res.json.error.code, 'NOT_FOUND');
  }

  // 鉴权：未登录 401 / 缺 CSRF 403
  const noAuthCreate = await e2e.request('POST', '/api/admin/scheduled-tasks', { body: taskBody() });
  assert.equal(noAuthCreate.status, 401, `未登录创建任务应 401：${noAuthCreate.status} ${noAuthCreate.text}`);
  const noCsrfPatch = await e2e.adminRequest('PATCH', `/api/admin/scheduled-tasks/${intervalTask.id}`, {
    body: { name: 'x' },
  });
  assert.equal(noCsrfPatch.status, 403, `缺 CSRF 头更新任务应 403：${noCsrfPatch.status} ${noCsrfPatch.text}`);
  const noAuthRun = await e2e.request('POST', `/api/admin/scheduled-tasks/${intervalTask.id}/run`, { body: {} });
  assert.equal(noAuthRun.status, 401, '未登录立即执行任务应 401');

  // 删除
  const deleted = await e2e.deleteScheduledTask(intervalTask.id);
  assert.equal(deleted.status, 204, `删除任务应 204：${deleted.status} ${deleted.text}`);
  const afterDelete = await e2e.getScheduledTask(intervalTask.id);
  assert.equal(afterDelete.status, 404);
});

test('立即执行成功链路：users 目标 → 外部 API 收到请求 → 解析回复 → outbox source=schedule → 日志 success', async () => {
  await e2e.ensureAdmin();
  externalApi.setResponse({ json: { data: { answer: 'SCHEDULED-OK-内容' } } });
  externalApi.reset();

  const task = await createTaskOrFail({
    ...taskBody(),
    name: '立即执行成功任务',
    targets: { type: 'users', ids: [user1.id, user2.id] },
    request: {
      method: 'GET',
      url: `${externalApi.baseUrl}/sched-run?date={date}&taskName={taskName}`,
      headers: { 'X-Sched': '1', Authorization: 'Bearer run-secret' },
      bodyTemplate: '',
    },
    response: { type: 'json', path: '', template: '{{data.answer}}', fallbackText: '执行失败兜底' },
  });

  const startedAt = Date.now();
  const run = await e2e.runScheduledTask(task.id);
  assert.equal(run.status, 200, `立即执行应 200：${run.status} ${run.text}`);
  assert.equal(run.json.status, 'success', `执行状态应为 success：${run.text}`);
  assert.equal(run.json.httpStatus, 200);
  assert.equal(typeof run.json.latencyMs, 'number');
  assert.equal(run.json.recipientsCount, 2, 'users 目标应有 2 个 active 收件人');
  assert.equal(run.json.error, '');

  // 外部 API：GET + 模板变量 + 请求头
  const request = await externalApi.waitForRequest((item) => item.pathname === '/sched-run');
  assert.equal(request.method, 'GET');
  assert.ok(request.query.date && request.query.date.length > 0, `{date} 应渲染：${JSON.stringify(request.query)}`);
  assert.ok(
    String(request.query.taskName ?? '').includes('立即执行成功任务'),
    `{taskName} 应渲染：${JSON.stringify(request.query)}`,
  );
  assert.equal(request.headers['x-sched'], '1');
  assert.equal(request.headers.authorization, 'Bearer run-secret', '规则配置的 Header 应随请求发送（DB 加密存储）');

  // mock 微信：两个目标用户各收到解析后的通知
  for (const user of [user1, user2]) {
    const record = await e2e.waitMockSentMessageContaining('SCHEDULED-OK-内容', {
      toUserId: user.wechatUserId,
      label: `用户 ${user.displayName} 收到定时通知`,
    });
    assert.equal(record.text, 'SCHEDULED-OK-内容', '回复模板应渲染为接口解析结果');
    assert.deepEqual(record.itemTypes, [1]);
  }

  // outbox source=schedule 且 sent
  for (const user of [user1, user2]) {
    const outbound = await e2e.waitAdminMessage(
      (row) =>
        row.direction === 'outbound' &&
        row.source === 'schedule' &&
        row.userId === user.id &&
        row.status === 'sent' &&
        row.text === 'SCHEDULED-OK-内容',
      { direction: 'outbound', timeoutMs: 8000, label: `用户 ${user.displayName} 收到 source=schedule 出站消息` },
    );
    const outbox = await e2e.waitOutbox(outbound.id, 'sent');
    assert.ok(outbox.attempts >= 1);
  }

  // 日志：success/httpStatus/recipientsCount
  const log = await e2e.waitScheduledTaskLog(
    (item) => item.taskId === task.id && item.status === 'success',
    { taskId: task.id, label: '定时任务 success 日志' },
  );
  assert.equal(log.status, 'success');
  assert.equal(log.httpStatus, 200);
  assert.equal(log.recipientsCount, 2);
  assert.equal(log.taskName, '立即执行成功任务');
  assert.equal(log.error, '');
  assert.equal(typeof log.latencyMs, 'number');
  assert.ok(String(log.replyPreview).includes('SCHEDULED-OK-内容'));
  assert.ok(log.id !== undefined);

  // 任务详情：lastRunAt/lastStatus/nextRunAt 已更新
  const detail = await e2e.getScheduledTask(task.id);
  assert.equal(detail.status, 200);
  const updated = detail.json.task;
  assert.ok(updated.lastRunAt >= startedAt, `lastRunAt 应更新：${updated.lastRunAt}`);
  assert.equal(updated.lastStatus, 'success');
  assert.ok(updated.nextRunAt > updated.lastRunAt, `interval 任务执行后 nextRunAt 应重算：${JSON.stringify(updated)}`);
});

test('分组目标：组内 active 用户收到、unbound 跳过、多分组去重', async () => {
  await e2e.ensureAdmin();
  externalApi.setResponse({ json: { data: { answer: 'GROUP-SCHED-内容' } } });
  externalApi.reset();

  const task = await createTaskOrFail({
    ...taskBody(),
    name: '分组目标任务',
    targets: { type: 'groups', ids: [groupMain.id, groupExtra.id] },
    request: { method: 'GET', url: `${externalApi.baseUrl}/group-sched`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: '', template: '{{data.answer}}', fallbackText: '分组失败兜底' },
  });

  const run = await e2e.runScheduledTask(task.id);
  assert.equal(run.status, 200, `分组任务立即执行应 200：${run.status} ${run.text}`);
  assert.equal(run.json.status, 'success');
  // u3 同时在两个分组（去重）、u4 在 groupMain、u5 已解绑（跳过）→ 收件人 = u3,u4
  assert.equal(run.json.recipientsCount, 2, `分组目标应去重并跳过 unbound：${run.text}`);

  for (const user of [user3, user4]) {
    await e2e.waitMockSentMessageContaining('GROUP-SCHED-内容', {
      toUserId: user.wechatUserId,
      label: `分组用户 ${user.displayName} 收到定时通知`,
    });
    assert.equal(await mockSentCount(user.wechatUserId, 'GROUP-SCHED-内容'), 1, '同一用户跨分组去重只应收到一次');
  }
  assert.equal(await mockSentCount(user5.wechatUserId, 'GROUP-SCHED-内容'), 0, 'unbound 用户不应收到定时通知');

  const log = await e2e.waitScheduledTaskLog((item) => item.taskId === task.id && item.status === 'success', {
    taskId: task.id,
    label: '分组任务 success 日志',
  });
  assert.equal(log.recipientsCount, 2);
});

test('失败兜底：外部接口 500 → 目标收到 fallback_text，日志 failed/httpStatus/error', async () => {
  await e2e.ensureAdmin();
  externalApi.setResponse({ status: 500, body: 'boom' });

  const task = await createTaskOrFail({
    ...taskBody(),
    name: '失败兜底任务',
    targets: { type: 'users', ids: [user1.id] },
    request: { method: 'GET', url: `${externalApi.baseUrl}/fail-sched`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: '', template: '{{data.answer}}', fallbackText: 'SCHED-FALLBACK-文本' },
    timeoutMs: 2000,
  });

  const run = await e2e.runScheduledTask(task.id);
  assert.equal(run.status, 200, `失败执行接口仍应 200：${run.status} ${run.text}`);
  assert.equal(run.json.status, 'failed', `执行状态应为 failed：${run.text}`);
  assert.equal(run.json.httpStatus, 500);
  assert.ok(run.json.error, '失败执行应返回错误信息');
  assert.equal(run.json.recipientsCount, 1, '有 fallback 时应向目标发送兜底通知');

  await e2e.waitMockSentMessageContaining('SCHED-FALLBACK-文本', {
    toUserId: user1.wechatUserId,
    label: '目标收到 fallback 兜底通知',
  });
  const outbound = await e2e.waitAdminMessage(
    (row) =>
      row.direction === 'outbound' &&
      row.source === 'schedule' &&
      row.userId === user1.id &&
      row.status === 'sent' &&
      row.text === 'SCHED-FALLBACK-文本',
    { direction: 'outbound', timeoutMs: 8000 },
  );
  assert.equal(outbound.source, 'schedule');

  const log = await e2e.waitScheduledTaskLog((item) => item.taskId === task.id && item.status === 'failed', {
    taskId: task.id,
    label: '定时任务 failed 日志',
  });
  assert.equal(log.httpStatus, 500);
  assert.ok(log.error, 'failed 日志应含错误');
  assert.equal(log.recipientsCount, 1);
});

test('失败无兜底：不发送任何通知、日志 failed', async () => {
  await e2e.ensureAdmin();
  externalApi.setResponse({ delayMs: 1600, json: { data: { answer: 'NEVER' } } });

  const task = await createTaskOrFail({
    ...taskBody(),
    name: '失败无兜底任务',
    targets: { type: 'users', ids: [user1.id] },
    request: { method: 'GET', url: `${externalApi.baseUrl}/timeout-sched`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: '', template: '{{data.answer}}', fallbackText: '' },
    timeoutMs: 1000,
  });

  const messagesBefore = (await e2e.mockState()).sentMessages.length;
  const run = await e2e.runScheduledTask(task.id);
  assert.equal(run.status, 200);
  assert.equal(run.json.status, 'failed');
  const log = await e2e.waitScheduledTaskLog((item) => item.taskId === task.id && item.status === 'failed', {
    taskId: task.id,
    label: '无兜底失败日志',
  });
  assert.ok(String(log.error).length > 0);
  await sleep(900);
  const messagesAfter = (await e2e.mockState()).sentMessages.length;
  assert.equal(messagesAfter, messagesBefore, '无 fallback 时失败不应发送任何微信消息');
  externalApi.setResponse({ json: { ok: true } });
});

test('测试运行（dry-run）：真实调用并返回诊断，但不发送、不写运行日志（含 429 响应头）', async () => {
  await e2e.ensureAdmin();
  externalApi.setResponse({ json: { data: { answer: 'DRYRUN-SCHED-内容' } } });
  externalApi.reset();

  const task = await createTaskOrFail({
    ...taskBody(),
    name: 'dry-run 任务',
    targets: { type: 'users', ids: [user1.id] },
    request: {
      method: 'GET',
      url: `${externalApi.baseUrl}/dry-sched`,
      headers: { Authorization: 'Bearer dry-run-secret' },
      bodyTemplate: '',
    },
    response: { type: 'json', path: '', template: '{{data.answer}}', fallbackText: 'DRYRUN-兜底' },
  });
  const logsBefore = await e2e.getScheduledTaskLogs({ taskId: task.id });
  assert.equal(logsBefore.status, 200);
  const logsBeforeCount = logsBefore.json.total;
  const mockCountBefore = await mockSentCount(user1.wechatUserId);

  const dryRun = await e2e.testScheduledTask(task.id);
  assert.equal(dryRun.status, 200, `dry-run 应 200：${dryRun.status} ${dryRun.text}`);
  assert.equal(dryRun.json.matched, true);
  assert.equal(dryRun.json.request.method, 'GET');
  assert.ok(String(dryRun.json.request.url).includes('dry-sched'));
  assert.ok(Array.isArray(dryRun.json.request.headerNames));
  assert.ok(dryRun.json.request.headerNames.includes('Authorization'));
  assert.equal(dryRun.json.httpStatus, 200);
  assert.equal(typeof dryRun.json.latencyMs, 'number');
  assert.ok(String(dryRun.json.responsePreview).includes('DRYRUN-SCHED-内容'));
  assert.ok(String(dryRun.json.replyText).includes('DRYRUN-SCHED-内容'));
  assert.ok(Number(dryRun.json.recipientsCount) >= 1);
  assert.equal(dryRun.json.error, '');
  assert.equal(externalApi.requests.length, 1, 'dry-run 应调用外部接口一次');

  await sleep(800);
  assert.equal(await mockSentCount(user1.wechatUserId), mockCountBefore, 'dry-run 不应发送微信消息');
  const logsAfter = await e2e.getScheduledTaskLogs({ taskId: task.id });
  assert.equal(logsAfter.json.total, logsBeforeCount, 'dry-run 不应写运行日志');
  assert.equal(JSON.stringify(dryRun.json).includes('dry-run-secret'), false, 'dry-run 响应不应回显 Header 值');

  // 429：响应头诊断
  externalApi.setResponse({
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '60', 'X-RateLimit-Reset': '1700000000' },
    json: { error: 'rate limited' },
  });
  externalApi.reset();
  const rateLimited = await e2e.testScheduledTask(task.id);
  assert.equal(rateLimited.status, 200);
  assert.equal(rateLimited.json.httpStatus, 429, `上游 429 应体现在 httpStatus：${rateLimited.text}`);
  const headers = rateLimited.json.responseHeaders ?? {};
  const headerText = JSON.stringify(headers).toLowerCase();
  assert.ok(headerText.includes('retry-after') || headerText.includes('x-ratelimit-reset'), `dry-run 应返回上游响应头诊断：${rateLimited.text}`);
  assert.ok(String(rateLimited.json.error ?? '').length > 0, '429 时 dry-run 应返回错误信息');
  externalApi.setResponse({ json: { ok: true } });
});

test('计划 nextRunAt：间隔/每日创建计算、PATCH 重算、停用后 run → 400', async () => {
  await e2e.ensureAdmin();
  externalApi.setResponse({ json: { data: { answer: 'PLAN-OK' } } });

  const now = Date.now();
  const intervalTask = await createTaskOrFail({
    ...taskBody(),
    name: '间隔计划任务',
    schedule: { type: 'interval', intervalMs: 60000 },
  });
  assert.ok(
    intervalTask.nextRunAt > now + 50000 && intervalTask.nextRunAt <= now + 75000,
    `interval 创建后 nextRunAt 应约为 now+60s：${intervalTask.nextRunAt - now}ms`,
  );

  const patched = await e2e.updateScheduledTask(intervalTask.id, {
    schedule: { type: 'interval', intervalMs: 120000 },
  });
  assert.equal(patched.status, 200);
  const patchedNow = Date.now();
  assert.ok(
    patched.json.task.nextRunAt > patchedNow + 100000 && patched.json.task.nextRunAt <= patchedNow + 135000,
    `PATCH 间隔后 nextRunAt 应重算约为 now+120s：${patched.json.task.nextRunAt - patchedNow}ms`,
  );

  const dailyPatched = await e2e.updateScheduledTask(intervalTask.id, {
    schedule: { type: 'daily', dailyTime: '08:00' },
  });
  assert.equal(dailyPatched.status, 200);
  assert.equal(dailyPatched.json.task.schedule.type, 'daily');
  assert.equal(dailyPatched.json.task.schedule.dailyTime, '08:00');
  assert.ok(dailyPatched.json.task.nextRunAt > Date.now(), '改为每日后 nextRunAt 应在未来');
  assert.ok(
    dailyPatched.json.task.nextRunAt <= Date.now() + 24 * 60 * 60 * 1000 + 5 * 60 * 1000,
    '每日任务 nextRunAt 应在 24h 内',
  );

  // 停用任务 → run 400
  const disabled = await e2e.updateScheduledTask(intervalTask.id, { enabled: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.task.enabled, false);
  const runDisabled = await e2e.runScheduledTask(intervalTask.id);
  assert.equal(runDisabled.status, 400, `停用任务立即执行应 400：${runDisabled.status} ${runDisabled.text}`);
  assert.equal(runDisabled.json.error.code, 'BAD_REQUEST');

  // 重新启用 → run 成功
  const enabledAgain = await e2e.updateScheduledTask(intervalTask.id, { enabled: true });
  assert.equal(enabledAgain.status, 200);
  externalApi.reset();
  const runEnabled = await e2e.runScheduledTask(intervalTask.id);
  assert.equal(runEnabled.status, 200);
  assert.equal(runEnabled.json.status, 'success');
  assert.equal(externalApi.requests.length, 1);
});

test('运行日志：taskId/status 过滤、分页、字段完整', async () => {
  await e2e.ensureAdmin();
  externalApi.setResponse({ json: { data: { answer: 'LOG-OK' } } });
  externalApi.reset();

  const task = await createTaskOrFail({
    ...taskBody(),
    name: '日志任务',
    targets: { type: 'users', ids: [user2.id] },
    request: { method: 'GET', url: `${externalApi.baseUrl}/log-sched`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: '', template: '{{data.answer}}', fallbackText: 'LOG-兜底' },
  });
  // 成功两次
  assert.equal((await e2e.runScheduledTask(task.id)).json.status, 'success');
  assert.equal((await e2e.runScheduledTask(task.id)).json.status, 'success');
  // 失败一次（500）
  externalApi.setResponse({ status: 500, body: 'log-fail' });
  assert.equal((await e2e.runScheduledTask(task.id)).json.status, 'failed');
  externalApi.setResponse({ json: { ok: true } });

  const all = await e2e.getScheduledTaskLogs({ taskId: task.id, limit: 50 });
  assert.equal(all.status, 200);
  assert.ok(all.json.total >= 3, `应有 ≥3 条日志，实际 ${all.json.total}`);
  assert.ok(Array.isArray(all.json.items));
  const first = all.json.items[0];
  for (const key of ['id', 'taskId', 'taskName', 'status', 'httpStatus', 'latencyMs', 'recipientsCount', 'createdAt']) {
    assert.ok(key in first, `日志项应包含字段 ${key}：${JSON.stringify(first)}`);
  }
  assert.equal(first.taskId, task.id);
  assert.equal(first.taskName, '日志任务');
  assert.ok(['success', 'failed', 'skipped'].includes(first.status));

  // status 过滤
  const successOnly = await e2e.getScheduledTaskLogs({ taskId: task.id, status: 'success', limit: 50 });
  assert.equal(successOnly.status, 200);
  assert.ok(successOnly.json.items.every((item) => item.status === 'success'));
  assert.ok(successOnly.json.total >= 2);
  const failedOnly = await e2e.getScheduledTaskLogs({ taskId: task.id, status: 'failed', limit: 50 });
  assert.ok(failedOnly.json.items.every((item) => item.status === 'failed'));
  assert.ok(failedOnly.json.total >= 1);

  // 分页：limit=1，offset 拉取不同记录
  const page1 = await e2e.getScheduledTaskLogs({ taskId: task.id, limit: 1, offset: 0 });
  const page2 = await e2e.getScheduledTaskLogs({ taskId: task.id, limit: 1, offset: 1 });
  assert.equal(page1.json.items.length, 1);
  assert.equal(page2.json.items.length, 1);
  assert.notEqual(page1.json.items[0].id, page2.json.items[0].id, '分页 offset 应返回不同日志');
  assert.equal(page1.json.total, page2.json.total);

  // 未知任务过滤 → total 0
  const unknown = await e2e.getScheduledTaskLogs({ taskId: 'task_not_exists_e2e' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.total, 0);
});

test('SCHEDULER_* env 覆盖：SCHEDULER_ENABLED=0 时仍可手工创建/立即执行任务', async () => {
  const disabledSchedulerEnv = await startE2E({
    appEnv: { SCHEDULER_ENABLED: '0', SCHEDULER_TICK_MS: '1000' },
  });
  try {
    await disabledSchedulerEnv.ensureAdmin();
    externalApi.setResponse({ json: { data: { answer: 'SCHEDULER-OFF-OK' } } });
    externalApi.reset();
    const bound = await disabledSchedulerEnv.bindUser({ displayName: '关闭调度用户', waitMonitor: true });
    const created = await disabledSchedulerEnv.createScheduledTask({
      name: '关闭调度器的手工任务',
      enabled: true,
      schedule: { type: 'interval', intervalMs: 60000 },
      targets: { type: 'users', ids: [bound.user.id] },
      request: { method: 'GET', url: `${externalApi.baseUrl}/sched-off`, headers: {}, bodyTemplate: '' },
      response: { type: 'json', path: '', template: '{{data.answer}}', fallbackText: 'OFF-兜底' },
      timeoutMs: 3000,
    });
    assert.equal(created.status, 201, `创建任务应 201（调度器关闭不影响管理接口）：${created.status} ${created.text}`);
    const taskId = created.json.task.id;
    const run = await disabledSchedulerEnv.runScheduledTask(taskId);
    assert.equal(run.status, 200);
    assert.equal(run.json.status, 'success');
    await disabledSchedulerEnv.waitMockSentMessageContaining('SCHEDULER-OFF-OK', {
      toUserId: bound.user.wechatUserId,
      label: '调度器关闭时手工执行仍可发通知',
    });
  } finally {
    await disabledSchedulerEnv.cleanup();
    externalApi.setResponse({ json: { ok: true } });
  }
});
