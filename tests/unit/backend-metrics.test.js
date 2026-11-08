/**
 * 后端单元测试：可观测性指标（task-29）
 *
 * 覆盖：
 * - metrics.js 的 counter / gauge（含动态 provider）/ histogram 注册与快照结构；
 * - 进程指标（uptime/memory/heap）与 serverTime；
 * - 从 SQLite 现有日志表聚合的 outbox 状态、规则/定时 24h 统计；
 * - 业务模块最小钩子（dispatcher 失败计数、monitor/media 动态 gauge）；
 * - `GET /api/admin/metrics` 鉴权与响应字段；
 * - `GET /api/admin/overview` 新增 metrics 摘要且旧字段向后兼容。
 *
 * 无外部网络：使用临时 DATA_DIR + 进程内 Express；ILINK 指向不可达端口。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test, { after, before } from 'node:test';

import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-metrics-',
  env: {
    APP_SECRET: 'metrics-test-app-secret-0123456789abcdef0123456789abcdef',
    ADMIN_PASSWORD: 'metrics-test-password',
    API_TOKEN: 'metrics-test-token-123456',
    ILINK_LOGIN_BASE_URL: 'http://127.0.0.1:9',
    ILINK_BASE_URL: 'http://127.0.0.1:9',
    LOG_LEVEL: 'silent',
  },
});

const metrics = await import('../../server/src/metrics.js');
const { createApp } = await import('../../server/src/api.js');
const dispatcher = await import('../../server/src/dispatcher.js');
const store = await import('../../server/src/store.js');

/** @type {import('node:http').Server} */
let server;
let base = '';

before(async () => {
  const { seedTestAdminSecrets } = await import('../helpers/backend-test-secrets.js');
  seedTestAdminSecrets();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await cleanupUnitEnv(unitEnv);
});

async function request(method, pathName, { body, headers = {}, cookie } = {}) {
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (cookie) requestHeaders.cookie = cookie;
  const response = await fetch(base + pathName, {
    method,
    headers: requestHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function assertErrorShape(result, status, code) {
  assert.equal(result.status, status, result.text);
  assert.ok(result.json?.error, `响应应为错误 JSON：${result.text}`);
  assert.equal(result.json.error.code, code);
}

/** 登录并返回 Cookie 请求头。 */
async function loginCookie() {
  const login = await request('POST', '/api/admin/login', { body: { password: 'metrics-test-password' } });
  assert.equal(login.status, 200, login.text);
  const setCookie = login.headers.get('set-cookie') || '';
  const match = /cb_session=[^;]+/.exec(setCookie);
  assert.ok(match, '登录响应应下发 cb_session Cookie');
  return match[0];
}

function createUser(wechatUserId) {
  return store.upsertBoundUser({
    wechatUserId,
    displayName: 'metrics 测试用户',
    ilinkBotId: `bot_${wechatUserId}@im.bot`,
    botToken: `token-${wechatUserId}`,
    baseUrl: 'http://127.0.0.1:9',
  }).user;
}

test('指标注册：counter / gauge / histogram 与快照结构', async () => {
  metrics.resetMetrics();
  metrics.incCounter('test.counter', 2);
  metrics.incCounter('test.counter');
  metrics.setGauge('test.gauge', 7);
  metrics.observeHistogram('test.latency_ms', 12);
  metrics.observeHistogram('test.latency_ms', 300);

  const snapshot = await metrics.snapshot();
  assert.equal(snapshot.counters['test.counter'], 3);
  assert.equal(snapshot.gauges['test.gauge'], 7);
  const histogram = snapshot.histograms['test.latency_ms'];
  assert.equal(histogram.count, 2);
  assert.equal(histogram.sum, 312);
  assert.equal(histogram.min, 12);
  assert.equal(histogram.max, 300);
  assert.equal(histogram.avg, 156);
  assert.ok(Array.isArray(histogram.buckets));
  assert.equal(histogram.buckets.find((bucket) => bucket.le === 10).count, 0);
  assert.equal(histogram.buckets.find((bucket) => bucket.le === 25).count, 1);
  assert.equal(histogram.buckets.at(-1).count, 2, '最后一个桶累计计数应等于 count');

  // 进程/时间字段
  assert.equal(typeof snapshot.serverTime, 'number');
  assert.ok(snapshot.serverTime > 0);
  assert.equal(typeof snapshot.uptimeMs, 'number');
  assert.ok(snapshot.uptimeMs >= 0);
  assert.equal(typeof snapshot.version, 'string');
  assert.equal(typeof snapshot.node, 'string');
  assert.ok(snapshot.memory.rss > 0);
  assert.ok(snapshot.memory.heapTotal > 0);
  assert.equal(typeof snapshot.heap.usedBytes, 'number');
  assert.ok(snapshot.heap.usedPercent >= 0 && snapshot.heap.usedPercent <= 100);

  const names = metrics.listMetricNames();
  assert.ok(names.counters.includes('test.counter'));
  assert.ok(names.histograms.includes('test.latency_ms'));
});

test('动态 gauge：monitor / media 模块已注册 provider 且快照可求值', async () => {
  metrics.resetMetrics();
  const snapshot = await metrics.snapshot();
  assert.equal(typeof snapshot.gauges['monitor.running_accounts'], 'number');
  assert.equal(typeof snapshot.gauges['monitor.last_poll_at'], 'number');
  assert.equal(typeof snapshot.gauges['media.inbound.active'], 'number');
  assert.equal(typeof snapshot.gauges['media.inbound.queued'], 'number');
});

test('DB 聚合：outbox 状态 + 规则/定时 24h 日志统计', async () => {
  metrics.resetMetrics();
  const user = createUser('wx_metrics_agg');
  store.enqueueMessage({ userId: user.id, text: 'metrics outbox 1' });
  const candidate = store.getNextQueuedCandidate(Date.now());
  assert.ok(candidate, '应存在 queued 的 outbox 候选');
  assert.equal(store.markOutboxSending(candidate.id), true);

  const now = Date.now();
  store.insertAppRuleLog({ ruleId: 'rule_metrics_1', status: 'success', createdAt: now });
  store.insertAppRuleLog({ ruleId: 'rule_metrics_1', status: 'failed', createdAt: now });
  store.insertScheduledTaskLog({ taskId: 'task_metrics_1', status: 'success', createdAt: now });

  const snapshot = await metrics.snapshot();
  assert.ok(snapshot.aggregates.outbox, 'outbox 聚合应可用');
  assert.ok(snapshot.aggregates.outbox.sending >= 1, 'sending 计数应包含刚置位的记录');
  assert.equal(typeof snapshot.aggregates.outbox.queued, 'number');
  assert.equal(typeof snapshot.aggregates.outbox.sent, 'number');
  assert.equal(typeof snapshot.aggregates.outbox.failed, 'number');
  assert.ok(snapshot.aggregates.appRules24h.success >= 1);
  assert.ok(snapshot.aggregates.appRules24h.failed >= 1);
  assert.ok(snapshot.aggregates.scheduledTasks24h.success >= 1);
});

test('dispatcher 钩子：用户不存在的投递失败计入 dispatcher.failed.total', async () => {
  metrics.resetMetrics();
  store.enqueueMessage({ userId: 'u_metrics_missing_user', text: '投递给不存在的用户' });
  const before = metrics.getCounter('dispatcher.failed.total');
  const handled = await dispatcher.processOne(Date.now());
  assert.equal(handled, true);
  assert.equal(metrics.getCounter('dispatcher.failed.total'), before + 1);
});

test('GET /api/admin/metrics：401 鉴权 + 200 快照字段契约', async () => {
  metrics.resetMetrics();
  assertErrorShape(await request('GET', '/api/admin/metrics'), 401, 'UNAUTHORIZED');

  const cookie = await loginCookie();
  const startedAfter = Date.now();
  const result = await request('GET', '/api/admin/metrics', { cookie });
  assert.equal(result.status, 200, result.text);
  const snapshot = result.json;
  for (const key of [
    'serverTime',
    'version',
    'pid',
    'node',
    'uptimeMs',
    'memory',
    'heap',
    'counters',
    'gauges',
    'histograms',
    'aggregates',
  ]) {
    assert.ok(key in snapshot, `指标快照应包含 ${key}`);
  }
  assert.ok(Math.abs(snapshot.serverTime - startedAfter) <= 10_000, 'serverTime 应为当前时间');
  assert.equal(typeof snapshot.memory.rss, 'number');
  assert.equal(typeof snapshot.gauges['monitor.running_accounts'], 'number');
  assert.equal(typeof snapshot.gauges['media.inbound.active'], 'number');
  assert.equal(typeof snapshot.aggregates.outbox.queued, 'number');
  assert.equal(typeof snapshot.aggregates.appRules24h.total, 'number');
  assert.equal(typeof snapshot.histograms, 'object');
  // 指标不含用户数据/正文（只允许数值/对象结构）
  assert.equal(JSON.stringify(snapshot).includes('wx_metrics_agg'), false);
});

test('GET /api/admin/overview：新增 metrics 摘要且旧字段向后兼容', async () => {
  const cookie = await loginCookie();
  const result = await request('GET', '/api/admin/overview', { cookie });
  assert.equal(result.status, 200, result.text);
  const body = result.json;
  // 旧字段保持不变
  assert.equal(typeof body.stats.totalUsers, 'number');
  assert.equal(typeof body.stats.queued, 'number');
  assert.equal(typeof body.server.uptimeMs, 'number');
  assert.equal(typeof body.server.monitorsRunning, 'number');
  // 新增 metrics 摘要
  assert.ok(body.metrics, 'overview 应新增 metrics 摘要');
  assert.equal(typeof body.metrics.uptimeMs, 'number');
  assert.equal(typeof body.metrics.memory.rss, 'number');
  assert.equal(typeof body.metrics.gauges.monitorRunningAccounts, 'number');
  assert.equal(typeof body.metrics.gauges.outboxQueued, 'number');
  assert.equal(typeof body.metrics.counters.dispatcherSent, 'number');
  assert.ok('appRules24h' in body.metrics);
  assert.ok('scheduledTasks24h' in body.metrics);
});
