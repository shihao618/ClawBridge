/**
 * 单元测试：定时通知管理端 API（docs/SCHEDULED_TASKS.md §5）。
 * 进程内 Express + 临时 DATA_DIR + 本地假 HTTP server。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-scheduled-api-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'scheduled-api-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'scheduled-api-admin-password';
process.env.API_TOKEN = 'scheduled-api-token-123456';
process.env.ILINK_LOGIN_BASE_URL = 'http://127.0.0.1:9';
process.env.ILINK_BASE_URL = 'http://127.0.0.1:9';
process.env.LOG_LEVEL = 'silent';
process.env.APP_RULES_ALLOWED_HOSTS = '127.0.0.1';

const { createApp } = await import('../../server/src/api.js');
const store = await import('../../server/src/store.js');
const { getDb, closeDb } = await import('../../server/src/db.js');

let apiServer;
let apiPort = 0;
let server;
let base = '';
let cookie = '';
const CSRF = { 'x-requested-with': 'ClawBridge-Admin' };

before(async () => {
  const { seedTestAdminSecrets } = await import('./backend-test-secrets.js');
  seedTestAdminSecrets();
  apiServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${apiPort}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { answer: `answer:${url.searchParams.get('city') ?? 'x'}` } }));
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  apiPort = apiServer.address().port;

  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'scheduled-api-admin-password' }),
  });
  assert.equal(login.status, 200);
  cookie = /cb_session=[^;]+/.exec(login.headers.get('set-cookie') || '')[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
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

const adminGet = (pathName) => request('GET', pathName, { headers: { cookie } });
const adminWrite = (method, pathName, body) => request(method, pathName, { body, headers: { cookie, ...CSRF } });

function assertError(result, status, code) {
  assert.equal(result.status, status, result.text);
  assert.equal(result.json?.error?.code, code, result.text);
}

let seq = 0;
function createUser({ active = true, displayName } = {}) {
  seq += 1;
  const user = store.upsertBoundUser({
    wechatUserId: `wx_sched_api_${seq}`,
    displayName: displayName ?? `API定时用户${seq}`,
    ilinkBotId: `bot_sched_api_${seq}@im.bot`,
    botToken: `sched-api-token-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
  if (!active) store.unbindUser(user.id);
  return user;
}

function validTaskBody(overrides = {}) {
  return {
    name: 'API定时任务',
    enabled: true,
    schedule: { type: 'interval', intervalMs: 120000 },
    targets: { type: 'users', ids: [] },
    request: {
      method: 'GET',
      url: `http://127.0.0.1:${apiPort}/ok?city={taskName}`,
      headers: { Authorization: 'Bearer top-secret-schedule' },
      bodyTemplate: '',
    },
    response: { type: 'json', path: 'data', template: '通知：{{answer}}', fallbackText: '兜底' },
    timeoutMs: 3000,
    ...overrides,
  };
}

test('鉴权 + 创建校验：401/400（name/schedule/targets/url/userinfo/timeout/response）', async () => {
  assertError(await request('GET', '/api/admin/scheduled-tasks'), 401, 'UNAUTHORIZED');
  assertError(await request('POST', '/api/admin/scheduled-tasks', { body: validTaskBody() }), 401, 'UNAUTHORIZED');

  const user = createUser();
  const invalidBodies = [
    [validTaskBody({ name: '' }), 'name'],
    [validTaskBody({ schedule: { type: 'bad' } }), 'schedule.type'],
    [validTaskBody({ schedule: { type: 'interval', intervalMs: 1000 } }), 'interval'],
    [validTaskBody({ schedule: { type: 'daily', dailyTime: '25:00' } }), 'dailyTime'],
    [validTaskBody({ targets: { type: 'users', ids: [] } }), 'targets.ids'],
    [validTaskBody({ targets: { type: 'users', ids: ['u_missing'] } }), 'targets.ids'],
    [validTaskBody({ request: { method: 'GET', url: 'ftp://example.com/x' } }), 'url'],
    [validTaskBody({ request: { method: 'GET', url: 'http://user:pass@example.com/x' } }), 'userinfo'],
    [validTaskBody({ timeoutMs: 500 }), 'timeoutMs'],
    [validTaskBody({ response: { type: 'binary' } }), 'response.type'],
  ];
  for (const [body, label] of invalidBodies) {
    const result = await adminWrite('POST', '/api/admin/scheduled-tasks', body);
    assert.equal(result.status, 400, `${label} 应 400：${result.text}`);
    assert.equal(result.json.error.code, 'BAD_REQUEST');
  }
  assert.ok(user.id);
});

test('创建/查看：TaskView 结构、nextRunAt 计算、header 只回 names、DB 密文', async () => {
  const user = createUser({ displayName: '目标用户' });
  const created = await adminWrite('POST', '/api/admin/scheduled-tasks', validTaskBody({
    name: '天气推送',
    targets: { type: 'users', ids: [user.id] },
  }));
  assert.equal(created.status, 201, created.text);
  const task = created.json.task;
  assert.match(task.id, /^task_/);
  assert.equal(task.name, '天气推送');
  assert.equal(task.enabled, true);
  assert.deepEqual(task.schedule, {
    type: 'interval',
    intervalMs: 120000,
    dailyTime: '08:00',
    windowStart: '',
    windowEnd: '',
    timezone: 'Asia/Shanghai',
  });
  assert.equal(task.targets.type, 'users');
  assert.deepEqual(task.targets.ids, [user.id]);
  assert.deepEqual(task.targets.names, ['目标用户']);
  assert.deepEqual(task.request.headerNames, ['Authorization']);
  assert.ok(!created.text.includes('Bearer'), '响应不得包含 header 值');
  assert.equal(task.limits.timeoutMs, 3000);
  assert.ok(task.nextRunAt > Date.now(), '创建后应计算 next_run_at');

  const row = getDb().prepare('SELECT request_headers_enc FROM scheduled_tasks WHERE id = ?').get(task.id);
  assert.ok(!row.request_headers_enc.includes('Bearer'), 'DB header 必须加密');

  const detail = await adminGet(`/api/admin/scheduled-tasks/${encodeURIComponent(task.id)}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.task.id, task.id);
  assertError(await adminGet('/api/admin/scheduled-tasks/task_missing'), 404, 'NOT_FOUND');

  const list = await adminGet('/api/admin/scheduled-tasks');
  assert.ok(list.json.items.some((item) => item.id === task.id));
});

test('PATCH：局部更新、计划变更重算 next_run_at、headers 清空、enable/disable、校验', async () => {
  const user = createUser();
  const created = await adminWrite('POST', '/api/admin/scheduled-tasks', validTaskBody({
    name: '待更新任务',
    targets: { type: 'users', ids: [user.id] },
  }));
  const task = created.json.task;

  const patched = await adminWrite('PATCH', `/api/admin/scheduled-tasks/${task.id}`, {
    name: '更新任务',
    schedule: { type: 'interval', intervalMs: 7200000 },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.task.name, '更新任务');
  assert.equal(patched.json.task.schedule.intervalMs, 7200000);
  assert.ok(patched.json.task.nextRunAt > Date.now() + 3600000, '计划变更后 next_run_at 应重算');

  const cleared = await adminWrite('PATCH', `/api/admin/scheduled-tasks/${task.id}`, {
    request: { method: 'GET', url: `http://127.0.0.1:${apiPort}/ok?city={taskName}`, headers: {} },
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json.task.request.headerNames, []);

  const disabled = await adminWrite('PATCH', `/api/admin/scheduled-tasks/${task.id}`, { enabled: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.task.enabled, false);
  assert.equal(disabled.json.task.nextRunAt, 0, '禁用后 next_run_at 归零');

  const enabledAgain = await adminWrite('PATCH', `/api/admin/scheduled-tasks/${task.id}`, { enabled: true });
  assert.equal(enabledAgain.json.task.enabled, true);
  assert.ok(enabledAgain.json.task.nextRunAt > Date.now(), '重新启用应重算 next_run_at');

  assertError(
    await adminWrite('PATCH', `/api/admin/scheduled-tasks/${task.id}`, { enabled: 'yes' }),
    400,
    'BAD_REQUEST',
  );
  assertError(
    await adminWrite('PATCH', `/api/admin/scheduled-tasks/${task.id}`, { schedule: { type: 'daily', dailyTime: '9:5' } }),
    400,
    'BAD_REQUEST',
  );
  assertError(await adminWrite('PATCH', '/api/admin/scheduled-tasks/task_missing', { name: 'x' }), 404, 'NOT_FOUND');

  assert.equal((await adminWrite('DELETE', `/api/admin/scheduled-tasks/${task.id}`)).status, 204);
  assertError(await adminWrite('DELETE', `/api/admin/scheduled-tasks/${task.id}`), 404, 'NOT_FOUND');
});

test('POST /:id/test dry-run：真实调用不发送不写日志；返回请求/响应/回复/收件人数', async () => {
  const user = createUser();
  const created = await adminWrite('POST', '/api/admin/scheduled-tasks', validTaskBody({
    name: '测试运行任务',
    targets: { type: 'users', ids: [user.id] },
  }));
  const task = created.json.task;
  const outboxBefore = Number(getDb().prepare('SELECT COUNT(*) AS c FROM outbox').get().c);
  const logsBefore = Number(getDb().prepare('SELECT COUNT(*) AS c FROM scheduled_task_logs').get().c);

  const run = await adminWrite('POST', `/api/admin/scheduled-tasks/${task.id}/test`, {});
  assert.equal(run.status, 200, run.text);
  assert.equal(run.json.status, 'success');
  assert.equal(run.json.httpStatus, 200);
  assert.equal(run.json.replyText, '通知：answer:测试运行任务');
  assert.equal(run.json.recipientsCount, 1);
  assert.deepEqual(run.json.request.headerNames, ['Authorization']);
  assert.ok(run.json.request.url.includes('city=%E6%B5%8B%E8%AF%95%E8%BF%90%E8%A1%8C%E4%BB%BB%E5%8A%A1'));
  assert.equal(typeof run.json.responseHeaders, 'object');

  assert.equal(Number(getDb().prepare('SELECT COUNT(*) AS c FROM outbox').get().c), outboxBefore, 'dry-run 不发消息');
  assert.equal(Number(getDb().prepare('SELECT COUNT(*) AS c FROM scheduled_task_logs').get().c), logsBefore, 'dry-run 不写日志');
  assertError(await adminWrite('POST', '/api/admin/scheduled-tasks/task_missing/test', {}), 404, 'NOT_FOUND');
});

test('POST /:id/run：真实发送+写日志+更新 next_run_at；disabled → 400', async () => {
  const user = createUser();
  const created = await adminWrite('POST', '/api/admin/scheduled-tasks', validTaskBody({
    name: '立即执行任务',
    targets: { type: 'users', ids: [user.id] },
  }));
  const task = created.json.task;

  const run = await adminWrite('POST', `/api/admin/scheduled-tasks/${task.id}/run`, {});
  assert.equal(run.status, 200, run.text);
  assert.equal(run.json.status, 'success');
  assert.equal(run.json.httpStatus, 200);
  assert.equal(run.json.recipientsCount, 1);
  assert.equal(run.json.error, '');

  const outbox = getDb().prepare("SELECT * FROM outbox WHERE user_id = ? AND source = 'schedule'").all(user.id);
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].text, /answer:立即执行任务/);
  const logs = getDb().prepare('SELECT * FROM scheduled_task_logs WHERE task_id = ?').all(task.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'success');

  const detail = await adminGet(`/api/admin/scheduled-tasks/${encodeURIComponent(task.id)}`);
  assert.equal(detail.json.task.lastStatus, 'success');
  assert.ok(detail.json.task.nextRunAt > Date.now());

  await adminWrite('PATCH', `/api/admin/scheduled-tasks/${task.id}`, { enabled: false });
  assertError(await adminWrite('POST', `/api/admin/scheduled-tasks/${task.id}/run`, {}), 400, 'BAD_REQUEST');
  assertError(await adminWrite('POST', '/api/admin/scheduled-tasks/task_missing/run', {}), 404, 'NOT_FOUND');
});

test('GET /api/admin/scheduled-task-logs：过滤/分页/字段/非法 status 400', async () => {
  const task = store.createScheduledTask({
    name: '日志任务',
    enabled: true,
    scheduleType: 'interval',
    intervalMs: 60000,
    targetType: 'users',
    targetIds: [],
    requestMethod: 'GET',
    requestUrl: `http://127.0.0.1:${apiPort}/ok`,
    requestHeadersEnc: null,
    requestBodyTemplate: '',
    responseType: 'json',
    responsePath: '',
    replyTemplate: 'hi',
    fallbackText: '',
    timeoutMs: 1000,
    nextRunAt: Date.now() + 60000,
  });
  store.insertScheduledTaskLog({ taskId: task.id, status: 'success', httpStatus: 200, latencyMs: 5, recipientsCount: 3 });
  store.insertScheduledTaskLog({ taskId: task.id, status: 'failed', error: 'HTTP 500', recipientsCount: 0 });

  const all = await adminGet(`/api/admin/scheduled-task-logs?taskId=${encodeURIComponent(task.id)}`);
  assert.equal(all.status, 200);
  assert.equal(all.json.total, 2);
  const success = all.json.items.find((item) => item.status === 'success');
  assert.equal(success.taskName, '日志任务');
  assert.equal(success.httpStatus, 200);
  assert.equal(success.latencyMs, 5);
  assert.equal(success.recipientsCount, 3);

  const failed = await adminGet(`/api/admin/scheduled-task-logs?taskId=${encodeURIComponent(task.id)}&status=failed`);
  assert.equal(failed.json.total, 1);
  assert.equal(failed.json.items[0].error, 'HTTP 500');
  const page = await adminGet(`/api/admin/scheduled-task-logs?taskId=${encodeURIComponent(task.id)}&limit=1`);
  assert.equal(page.json.items.length, 1);
  assert.equal(page.json.total, 2);

  assertError(await adminGet('/api/admin/scheduled-task-logs?status=bogus'), 400, 'BAD_REQUEST');
});
