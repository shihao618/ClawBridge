/**
 * 单元测试：app-rules RuleEngine 全链路（docs/API_RULES.md §0/§6/§9）。
 * 本地假 HTTP server；假 now 仅用于冷却；不触真实外网。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-app-rules-engine-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'app-rules-engine-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'app-rules-engine-password';
process.env.API_TOKEN = 'app-rules-engine-token';
process.env.LOG_LEVEL = 'silent';
process.env.APP_RULES_ALLOWED_HOSTS = '127.0.0.1';

const appRules = await import('../../server/src/app-rules.js');
const store = await import('../../server/src/store.js');
const { getDb, closeDb } = await import('../../server/src/db.js');

let server;
let port = 0;

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/weather') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { answer: `weather:${url.searchParams.get('city')}` } }));
      return;
    }
    if (url.pathname === '/reply') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reply: 'pong' }));
      return;
    }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'boom' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(async () => {
  appRules.stop();
  closeDb();
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
function createUser(displayName) {
  seq += 1;
  return store.upsertBoundUser({
    wechatUserId: `wx_rule_engine_${seq}`,
    displayName: displayName ?? `规则引擎用户${seq}`,
    ilinkBotId: `bot_rule_engine_${seq}@im.bot`,
    botToken: `rule-engine-token-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
}

function createRule({ name, keywords = ['查天气'], url = `http://127.0.0.1:${port}/weather?city={arg}`, ...overrides }) {
  return store.createAppRule({
    name,
    enabled: true,
    priority: 100,
    scopeType: 'all',
    scopeIds: [],
    matchMode: 'contains',
    keywords,
    regexPattern: '',
    extractionMode: 'multi',
    extractionConfig: { extractors: [{ type: 'trailing', param: 'arg' }] },
    requestMethod: 'GET',
    requestUrl: url,
    requestHeadersEnc: null,
    requestBodyTemplate: '',
    responseType: 'json',
    responsePath: 'data',
    replyTemplate: '{{answer}}',
    fallbackText: '暂时无法查询',
    timeoutMs: 2000,
    cooldownMs: 0,
    maxCallsPerHour: 60,
    maxUserCallsPerHour: 10,
    ...overrides,
  });
}

const replyOutbox = (userId) =>
  getDb()
    .prepare("SELECT * FROM outbox WHERE user_id = ? AND source = 'rule' ORDER BY created_at ASC, id ASC")
    .all(userId);

const ruleLogs = (ruleId) =>
  getDb().prepare('SELECT * FROM app_rule_logs WHERE rule_id = ? ORDER BY id ASC').all(ruleId);

async function runMessage({ userId, text, inboundMessageId, itemTypes = '1' }) {
  const queued = appRules.handleInboundMessage({ userId, inboundMessageId, text, itemTypes });
  await appRules.waitForIdle(5000);
  return queued;
}

test('引擎成功链路：匹配→提取→HTTP→解析→回复入队 outbox(source=rule)→success 日志', async () => {
  appRules.start();
  const user = createUser('张三');
  const rule = createRule({ name: '天气规则A', priority: 10 });
  const queued = await runMessage({ userId: user.id, text: '查天气 北京', inboundMessageId: 'in_engine_1' });
  assert.equal(queued, true);

  const outbox = replyOutbox(user.id);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].status, 'queued');
  assert.equal(outbox[0].text, 'weather:北京');

  const logs = ruleLogs(rule.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'success');
  assert.equal(Number(logs[0].http_status), 200);
  assert.ok(Number(logs[0].latency_ms) >= 0);
  assert.equal(logs[0].reply_outbox_id, outbox[0].id);
  assert.match(logs[0].params_preview, /北京/);
  assert.match(logs[0].request_preview, /^GET http:\/\/127\.0\.0\.1:/);
  assert.match(logs[0].response_preview, /weather:北京/);
});

test('引擎失败链路：非 2xx → failed 日志 + fallback 回复', async () => {
  const user = createUser();
  const rule = createRule({ name: '失败规则', keywords: ['查失败'], url: `http://127.0.0.1:${port}/fail` });
  await runMessage({ userId: user.id, text: '查失败 啊', inboundMessageId: 'in_engine_fail_1' });
  const logs = ruleLogs(rule.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'failed');
  assert.equal(Number(logs[0].http_status), 500);
  assert.match(logs[0].error, /HTTP 500/);
  const outbox = replyOutbox(user.id);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].text, '暂时无法查询');
  assert.equal(logs[0].reply_outbox_id, outbox[0].id);
});

test('一条消息最多执行一条规则：按 priority ASC 取首条命中', async () => {
  const user = createUser();
  const first = createRule({ name: '优先规则', keywords: ['多规则'], priority: 5, url: `http://127.0.0.1:${port}/reply` });
  const second = createRule({ name: '次要规则', keywords: ['多规则'], priority: 10, url: `http://127.0.0.1:${port}/reply` });
  await runMessage({ userId: user.id, text: '多规则 测试', inboundMessageId: 'in_engine_multi_1' });
  assert.equal(ruleLogs(first.id).length, 1);
  assert.equal(ruleLogs(second.id).length, 0, '同消息不应执行第二条规则');
  assert.equal(replyOutbox(user.id).length, 1);
});

test('去重：同 (消息,规则) 重复触发只执行一次', async () => {
  const user = createUser();
  const rule = createRule({ name: '去重规则', keywords: ['去重测试'] });
  await runMessage({ userId: user.id, text: '去重测试 北京', inboundMessageId: 'in_engine_dedupe_1' });
  await runMessage({ userId: user.id, text: '去重测试 北京', inboundMessageId: 'in_engine_dedupe_1' });
  assert.equal(ruleLogs(rule.id).length, 1);
  assert.equal(replyOutbox(user.id).length, 1);
});

test('冷却：同用户同规则冷却期内跳过并写 skipped 日志', async () => {
  const user = createUser();
  const rule = createRule({ name: '冷却规则', keywords: ['冷却测试'], cooldownMs: 3600_000 });
  await runMessage({ userId: user.id, text: '冷却测试 北京', inboundMessageId: 'in_engine_cd_1' });
  await runMessage({ userId: user.id, text: '冷却测试 上海', inboundMessageId: 'in_engine_cd_2' });
  const logs = ruleLogs(rule.id);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].status, 'success');
  assert.equal(logs[1].status, 'skipped');
  assert.equal(logs[1].error, 'cooldown');
  assert.equal(replyOutbox(user.id).length, 1);
});

test('小时配额：规则级 maxCallsPerHour=1 时后续消息 skipped', async () => {
  const user = createUser();
  const rule = createRule({ name: '配额规则', keywords: ['配额测试'], maxCallsPerHour: 1 });
  await runMessage({ userId: user.id, text: '配额测试 北京', inboundMessageId: 'in_engine_quota_1' });
  await runMessage({ userId: user.id, text: '配额测试 上海', inboundMessageId: 'in_engine_quota_2' });
  const logs = ruleLogs(rule.id);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].status, 'success');
  assert.equal(logs[1].status, 'skipped');
  assert.equal(logs[1].error, 'rule hourly limit');
});

test('范围：groups 规则只对组内用户触发；users 规则只对指定用户触发', async () => {
  const member = createUser();
  const outsider = createUser();
  const group = store.createGroup({ name: '规则引擎组' });
  store.replaceUserGroups(member.id, [group.id]);
  const groupRule = createRule({
    name: '分组范围规则',
    keywords: ['范围测试'],
    scopeType: 'groups',
    scopeIds: [group.id],
  });
  await runMessage({ userId: member.id, text: '范围测试 北京', inboundMessageId: 'in_engine_scope_1' });
  await runMessage({ userId: outsider.id, text: '范围测试 北京', inboundMessageId: 'in_engine_scope_2' });
  assert.equal(ruleLogs(groupRule.id).length, 1);
  assert.equal(replyOutbox(member.id).length, 1);
  assert.equal(replyOutbox(outsider.id).length, 0);

  const userRule = createRule({
    name: '指定用户规则',
    keywords: ['指定用户测试'],
    scopeType: 'users',
    scopeIds: [member.id],
  });
  await runMessage({ userId: member.id, text: '指定用户测试 北京', inboundMessageId: 'in_engine_scope_3' });
  await runMessage({ userId: outsider.id, text: '指定用户测试 北京', inboundMessageId: 'in_engine_scope_4' });
  assert.equal(ruleLogs(userRule.id).length, 1);
});

test('非文本消息/未命中消息不触发；start/stop 幂等', async () => {
  const user = createUser();
  const rule = createRule({ name: '忽略规则', keywords: ['忽略测试'] });
  await runMessage({ userId: user.id, text: '忽略测试 北京', inboundMessageId: 'in_engine_ignore_1', itemTypes: '2' });
  await runMessage({ userId: user.id, text: '完全不相关', inboundMessageId: 'in_engine_ignore_2' });
  assert.equal(ruleLogs(rule.id).length, 0);

  assert.equal(appRules.start(), false, '重复 start 应返回 false');
  assert.equal(appRules.stop(), true);
  assert.equal(appRules.stop(), false);
  assert.equal(appRules.handleInboundMessage({ userId: user.id, inboundMessageId: 'in_engine_after_stop', text: '忽略测试 x', itemTypes: '1' }), false);
  assert.equal(appRules.start(), true);
});
