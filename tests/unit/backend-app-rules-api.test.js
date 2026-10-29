/**
 * 单元测试：api.js 接口应用管理端（docs/API_RULES.md §7）。
 * 进程内 Express + 临时 DATA_DIR + 本地假 HTTP server（test 运行）。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-app-rules-api-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'app-rules-api-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'app-rules-api-admin-password';
process.env.API_TOKEN = 'app-rules-api-token-123456';
process.env.ILINK_LOGIN_BASE_URL = 'http://127.0.0.1:9';
process.env.ILINK_BASE_URL = 'http://127.0.0.1:9';
process.env.LOG_LEVEL = 'silent';
process.env.APP_RULES_ALLOWED_HOSTS = '127.0.0.1';

const { createApp } = await import('../../server/src/api.js');
const { getDb, closeDb } = await import('../../server/src/db.js');
const store = await import('../../server/src/store.js');

let server;
let apiServer;
let apiPort = 0;
let base = '';
let cookie = '';
const CSRF = { 'x-requested-with': 'ClawBridge-Admin' };

before(async () => {
  const { seedTestAdminSecrets } = await import('./backend-test-secrets.js');
  seedTestAdminSecrets();
  apiServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${apiPort}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { answer: `answer:${url.searchParams.get('city') ?? ''}` } }));
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  apiPort = apiServer.address().port;

  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'app-rules-api-admin-password' }),
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
  return { status: response.status, headers: response.headers, text, json };
}

const adminGet = (pathName) => request('GET', pathName, { headers: { cookie } });
const adminWrite = (method, pathName, body) => request(method, pathName, { body, headers: { cookie, ...CSRF } });

function assertError(result, status, code) {
  assert.equal(result.status, status, result.text);
  assert.equal(result.json?.error?.code, code, result.text);
}

function validRuleBody(overrides = {}) {
  return {
    name: '查天气',
    enabled: true,
    priority: 100,
    scope: { type: 'all', ids: [] },
    matchMode: 'contains',
    keywords: ['查天气'],
    regexPattern: '',
    extraction: { mode: 'trailing', config: { param: 'arg' } },
    request: {
      method: 'GET',
      url: `http://127.0.0.1:${apiPort}/weather?city={arg}`,
      headers: { Authorization: 'Bearer top-secret-token' },
      bodyTemplate: '',
    },
    response: { type: 'json', path: 'data.answer', template: '{{data.answer}}', fallbackText: '暂时无法查询' },
    timeoutMs: 3000,
    cooldownMs: 0,
    maxCallsPerHour: 60,
    maxUserCallsPerHour: 10,
    ...overrides,
  };
}

test('鉴权 + 创建校验：401/400（name/keywords/regex/scope/url/timeout）', async () => {
  assertError(await request('GET', '/api/admin/app-rules'), 401, 'UNAUTHORIZED');
  assertError(await request('POST', '/api/admin/app-rules', { body: validRuleBody() }), 401, 'UNAUTHORIZED');
  assertError(await request('GET', '/api/admin/app-rule-logs'), 401, 'UNAUTHORIZED');

  const invalidBodies = [
    [validRuleBody({ name: '' }), 'name'],
    [validRuleBody({ matchMode: 'bad' }), 'matchMode'],
    [validRuleBody({ keywords: [] }), 'keywords'],
    [validRuleBody({ matchMode: 'regex', keywords: [], regexPattern: '(' }), 'regexPattern'],
    [validRuleBody({ scope: { type: 'groups', ids: ['grp_missing'] } }), 'scope'],
    [validRuleBody({ request: { method: 'GET', url: 'ftp://example.com/x' } }), 'url'],
    [validRuleBody({ request: { method: 'GET', url: 'not-a-url' } }), 'url'],
    [validRuleBody({ request: { method: 'GET', url: 'http://user:pass@example.com/x' } }), 'url-userinfo'],
    [validRuleBody({ timeoutMs: 500 }), 'timeoutMs'],
    [validRuleBody({ extraction: { mode: 'regex', config: { regex: '(' } } }), 'extraction'],
    [validRuleBody({ extraction: { mode: 'multi', config: { extractors: [] } } }), 'extraction-multi-empty'],
    [
      validRuleBody({ extraction: { mode: 'multi', config: { extractors: [{ type: 'regex', regex: '(' }] } } }),
      'extraction-multi-bad-regex',
    ],
    [validRuleBody({ response: { type: 'binary' } }), 'response'],
  ];
  for (const [body, label] of invalidBodies) {
    const result = await adminWrite('POST', '/api/admin/app-rules', body);
    assert.equal(result.status, 400, `${label} 应 400：${result.text}`);
    assert.equal(result.json.error.code, 'BAD_REQUEST');
  }
});

test('创建/查看：RuleView 结构、headers 只回 names、DB 内为密文', async () => {
  const created = await adminWrite('POST', '/api/admin/app-rules', validRuleBody());
  assert.equal(created.status, 201, created.text);
  const rule = created.json.rule;
  assert.match(rule.id, /^rule_/);
  assert.equal(rule.name, '查天气');
  assert.equal(rule.enabled, true);
  assert.deepEqual(rule.scope, { type: 'all', ids: [], names: [] });
  assert.deepEqual(rule.trigger, { matchMode: 'contains', keywords: ['查天气'], regexPattern: '' });
  assert.equal(rule.extraction.mode, 'trailing');
  assert.equal(rule.request.headerNames[0], 'Authorization');
  assert.equal(rule.request.bodyTemplate, '');
  assert.equal(rule.response.path, 'data.answer');
  assert.equal(rule.response.fallbackText, '暂时无法查询');
  assert.equal(rule.limits.timeoutMs, 3000);
  assert.deepEqual(rule.stats, { lastRunAt: 0, lastStatus: '', success24h: 0, failed24h: 0, skipped24h: 0 });
  assert.ok(!created.text.includes('Bearer'), '接口响应不得包含 header 值');

  const row = getDb().prepare('SELECT request_headers_enc FROM app_rules WHERE id = ?').get(rule.id);
  assert.ok(row.request_headers_enc);
  assert.ok(!row.request_headers_enc.includes('Bearer'), 'DB 中 header 必须加密');
  assert.match(row.request_headers_enc, /^v1\./);

  const detail = await adminGet(`/api/admin/app-rules/${encodeURIComponent(rule.id)}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.rule.id, rule.id);
  assertError(await adminGet('/api/admin/app-rules/rule_missing'), 404, 'NOT_FOUND');

  // 列表默认只返回 enabled；includeDisabled=1 返回全部
  const disabled = await adminWrite('POST', '/api/admin/app-rules', validRuleBody({ name: '停用规则', enabled: false }));
  assert.equal(disabled.status, 201);
  const enabledOnly = await adminGet('/api/admin/app-rules');
  assert.ok(enabledOnly.json.items.every((item) => item.enabled !== false || item.name !== '停用规则'));
  assert.ok(!enabledOnly.json.items.some((item) => item.name === '停用规则'));
  const all = await adminGet('/api/admin/app-rules?includeDisabled=1');
  assert.ok(all.json.items.some((item) => item.name === '停用规则'));
  assert.ok(all.json.items.every((item) => Array.isArray(item.request.headerNames) && !item.request.headers));
});

test('更新/删除：PATCH 局部更新、headers 全量替换/清空、校验、DELETE', async () => {
  const created = await adminWrite('POST', '/api/admin/app-rules', validRuleBody({ name: '待更新规则' }));
  const rule = created.json.rule;

  const patched = await adminWrite('PATCH', `/api/admin/app-rules/${rule.id}`, {
    name: '更新后规则',
    priority: 5,
    request: { method: 'POST', url: `http://127.0.0.1:${apiPort}/weather`, headers: { 'X-Token': 'v2' }, bodyTemplate: '{"city":"{arg}"}' },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.rule.name, '更新后规则');
  assert.equal(patched.json.rule.priority, 5);
  assert.equal(patched.json.rule.request.method, 'POST');
  assert.deepEqual(patched.json.rule.request.headerNames, ['X-Token']);
  assert.ok(!patched.text.includes('v2'));

  // 不传 headers 保持不变
  const partial = await adminWrite('PATCH', `/api/admin/app-rules/${rule.id}`, { name: '仅改名' });
  assert.equal(partial.json.rule.request.headerNames.length, 1);

  // 传 {} 清空
  const cleared = await adminWrite('PATCH', `/api/admin/app-rules/${rule.id}`, { request: { method: 'GET', url: `http://127.0.0.1:${apiPort}/weather`, headers: {} } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json.rule.request.headerNames, []);

  assertError(await adminWrite('PATCH', `/api/admin/app-rules/${rule.id}`, { priority: 'x' }), 400, 'BAD_REQUEST');
  assertError(await adminWrite('PATCH', '/api/admin/app-rules/rule_missing', { name: 'x' }), 404, 'NOT_FOUND');

  assert.equal((await adminWrite('DELETE', `/api/admin/app-rules/${rule.id}`)).status, 204);
  assertError(await adminWrite('DELETE', `/api/admin/app-rules/${rule.id}`), 404, 'NOT_FOUND');
});

test('POST /:id/test：dry-run 返回匹配/参数/请求/HTTP/回复；不写日志不发消息', async () => {
  const user = store.upsertBoundUser({
    wechatUserId: 'wx_app_rules_api_user',
    displayName: '测试用户',
    ilinkBotId: 'bot_app_rules_api@im.bot',
    botToken: 'app-rules-api-bot-token',
    baseUrl: 'https://ilink.example.test',
  }).user;
  const created = await adminWrite('POST', '/api/admin/app-rules', validRuleBody({ name: '测试运行规则' }));
  const rule = created.json.rule;
  const logsBefore = Number(getDb().prepare('SELECT COUNT(*) AS c FROM app_rule_logs').get().c);
  const outboxBefore = Number(getDb().prepare('SELECT COUNT(*) AS c FROM outbox').get().c);

  const run = await adminWrite('POST', `/api/admin/app-rules/${encodeURIComponent(rule.id)}/test`, {
    message: '查天气 上海',
    userId: user.id,
  });
  assert.equal(run.status, 200, run.text);
  assert.equal(run.json.matched, true);
  assert.equal(run.json.ruleId, rule.id);
  assert.equal(run.json.params.arg, '上海');
  assert.equal(run.json.httpStatus, 200);
  assert.ok(run.json.request.url.includes('city=%E4%B8%8A%E6%B5%B7'));
  assert.deepEqual(run.json.request.headerNames, ['Authorization']);
  assert.equal(typeof run.json.responseHeaders, 'object', 'dry-run 应返回响应头诊断字段');
  assert.equal(run.json.replyText, 'answer:上海');
  assert.equal(run.json.error, '');

  assert.equal(Number(getDb().prepare('SELECT COUNT(*) AS c FROM app_rule_logs').get().c), logsBefore, 'dry-run 不写运行日志');
  assert.equal(Number(getDb().prepare('SELECT COUNT(*) AS c FROM outbox').get().c), outboxBefore, 'dry-run 不发消息');

  assertError(
    await adminWrite('POST', `/api/admin/app-rules/${encodeURIComponent(rule.id)}/test`, { message: '' }),
    400,
    'BAD_REQUEST',
  );
  assertError(
    await adminWrite('POST', '/api/admin/app-rules/rule_missing/test', { message: 'x' }),
    404,
    'NOT_FOUND',
  );
});

test('GET /api/admin/app-rule-logs：过滤/分页/字段/非法 status 400', async () => {
  const rule = store.createAppRule({
    name: '日志规则',
    enabled: true,
    priority: 1,
    scopeType: 'all',
    scopeIds: [],
    matchMode: 'contains',
    keywords: ['日志'],
    regexPattern: '',
    extractionMode: 'trailing',
    extractionConfig: {},
    requestMethod: 'GET',
    requestUrl: 'http://127.0.0.1:9/x',
    requestHeadersEnc: null,
    requestBodyTemplate: '',
    responseType: 'json',
    responsePath: '',
    replyTemplate: '',
    fallbackText: '',
    timeoutMs: 1000,
    cooldownMs: 0,
    maxCallsPerHour: 60,
    maxUserCallsPerHour: 10,
  });
  const user = store.upsertBoundUser({
    wechatUserId: 'wx_app_rules_log_user',
    displayName: '日志用户',
    ilinkBotId: 'bot_app_rules_log@im.bot',
    botToken: 'app-rules-log-bot-token',
    baseUrl: 'https://ilink.example.test',
  }).user;
  store.insertAppRuleLog({
    ruleId: rule.id,
    userId: user.id,
    inboundMessageId: 'log_in_1',
    status: 'success',
    httpStatus: 200,
    latencyMs: 12,
    paramsPreview: '{"arg":"北京"}',
    requestPreview: 'GET http://127.0.0.1:9/x',
    responsePreview: '{"data":{"answer":"晴"}}',
    replyOutboxId: 'ob_fake',
  });
  store.insertAppRuleLog({ ruleId: rule.id, userId: user.id, inboundMessageId: 'log_in_2', status: 'failed', error: 'HTTP 500' });

  const all = await adminGet(`/api/admin/app-rule-logs?ruleId=${encodeURIComponent(rule.id)}`);
  assert.equal(all.status, 200);
  assert.ok(all.json.total >= 2);
  const item = all.json.items.find((row) => row.status === 'success');
  assert.equal(item.ruleName, '日志规则');
  assert.equal(item.userId, user.id);
  assert.equal(item.httpStatus, 200);
  assert.equal(item.latencyMs, 12);
  assert.equal(item.paramsPreview, '{"arg":"北京"}');
  assert.equal(item.requestPreview, 'GET http://127.0.0.1:9/x');
  assert.equal(item.replyOutboxId, 'ob_fake');

  const failed = await adminGet(`/api/admin/app-rule-logs?ruleId=${encodeURIComponent(rule.id)}&status=failed`);
  assert.equal(failed.json.total, 1);
  assert.equal(failed.json.items[0].error, 'HTTP 500');
  const byUser = await adminGet(`/api/admin/app-rule-logs?userId=${encodeURIComponent(user.id)}&limit=1`);
  assert.equal(byUser.json.items.length, 1);
  assert.equal(byUser.json.total >= 2, true);

  assertError(await adminGet('/api/admin/app-rule-logs?status=bogus'), 400, 'BAD_REQUEST');
});
