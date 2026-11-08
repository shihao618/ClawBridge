/**
 * 单元测试：app-rules RuleEngine 全链路（docs/API_RULES.md §0/§6/§9）。
 * 本地假 HTTP server；假 now 仅用于冷却；不触真实外网。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-app-rules-engine-',
  env: {
    APP_SECRET: 'app-rules-engine-secret-0123456789abcdef0123456789abcdef',
    ADMIN_PASSWORD: 'app-rules-engine-password',
    API_TOKEN: 'app-rules-engine-token',
    LOG_LEVEL: 'silent',
    APP_RULES_ALLOWED_HOSTS: '127.0.0.1',
  },
});

const appRules = await import('../../server/src/app-rules.js');
const store = await import('../../server/src/store.js');
const userSecrets = await import('../../server/src/data/user-secrets.js');
const { encryptSecret } = await import('../../server/src/crypto.js');
const { getDb } = await import('../../server/src/db.js');

let server;
let port = 0;
/** 凭据注入测试：记录外部 API 实际收到的请求。 */
const capturedRequests = [];

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
    if (url.pathname === '/capture' || url.pathname === '/echo') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        capturedRequests.push({
          url: req.url,
          headers: { ...req.headers },
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (url.pathname === '/echo') {
          // 故意回显凭据值，用于验证响应预览脱敏
          res.end(JSON.stringify({ data: { answer: `echo:${url.searchParams.get('token') ?? ''}` } }));
          return;
        }
        res.end(JSON.stringify({ data: { answer: 'CAPTURED' } }));
      });
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
  if (server) await new Promise((resolve) => server.close(resolve));
  await cleanupUnitEnv(unitEnv);
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
  // schema v1：app_rule_logs.inbound_message_id 有外键 → 测试先落一条入站消息并使用其真实 id。
  const wechatMessageId = `wxm_engine_${inboundMessageId}`;
  const saved = store.saveInbound({ userId, wechatMessageId, fromUserId: 'wx_engine_sender', text });
  const realInboundId = saved.inserted
    ? saved.id
    : getDb().prepare('SELECT id FROM inbound_messages WHERE wechat_message_id = ?').get(wechatMessageId)?.id;
  const queued = appRules.handleInboundMessage({ userId, inboundMessageId: realInboundId, text, itemTypes });
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

test('引擎不请求链路：关键词命中→直接回复默认文本→success 日志，不访问外部接口', async () => {
  const user = createUser('默认回复用户');
  const rule = createRule({
    name: '不请求默认回复',
    keywords: ['默认帮助'],
    url: '',
    extractionMode: 'none',
    extractionConfig: {},
    responseType: 'text',
    responsePath: '',
    replyTemplate: '这是默认回复',
    fallbackText: '',
  });
  const queued = await runMessage({ userId: user.id, text: '默认帮助', inboundMessageId: 'in_engine_no_request' });
  assert.equal(queued, true);

  const outbox = replyOutbox(user.id);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].text, '这是默认回复');
  const logs = ruleLogs(rule.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'success');
  assert.equal(Number(logs[0].http_status), 0, '不请求时无 HTTP 状态');
  assert.match(logs[0].request_preview, /不请求外部接口/);
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

test('规则无冷却限制：连续两条消息都执行', async () => {
  const user = createUser();
  const rule = createRule({ name: '冷却规则', keywords: ['冷却测试'] });
  await runMessage({ userId: user.id, text: '冷却测试 北京', inboundMessageId: 'in_engine_cd_1' });
  await runMessage({ userId: user.id, text: '冷却测试 上海', inboundMessageId: 'in_engine_cd_2' });
  const logs = ruleLogs(rule.id);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].status, 'success');
  assert.equal(logs[1].status, 'success');
  assert.equal(replyOutbox(user.id).length, 2);
});

test('规则无小时配额限制：连续两条消息都执行', async () => {
  const user = createUser();
  const rule = createRule({ name: '配额规则', keywords: ['配额测试'] });
  await runMessage({ userId: user.id, text: '配额测试 北京', inboundMessageId: 'in_engine_quota_1' });
  await runMessage({ userId: user.id, text: '配额测试 上海', inboundMessageId: 'in_engine_quota_2' });
  const logs = ruleLogs(rule.id);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].status, 'success');
  assert.equal(logs[1].status, 'success');
  assert.equal(replyOutbox(user.id).length, 2);
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

// ---------------------------------------------------------------------------
// 凭据注入（规则）：{credential:名称.字段} → URL/Header/Body；缺失/脱敏/noreply
// ---------------------------------------------------------------------------

let credentialMessageSeq = 0;

/** 规则日志带 inbound_message_id 外键：先落一条入站消息再触发引擎。 */
function seedInbound(userId, text) {
  credentialMessageSeq += 1;
  const saved = store.saveInbound({
    userId,
    wechatMessageId: `wxm_rule_credential_${credentialMessageSeq}`,
    fromUserId: 'wx_rule_cred_sender',
    text,
  });
  return saved.id;
}

function createCredentialUser(displayName, fields) {
  const user = createUser(displayName);
  userSecrets.setUserSecret(user.id, { name: 'gps', label: 'GPS', fields });
  return user;
}

test('规则凭据注入：URL/Header/Body 渲染 + 日志/预览只含名称与脱敏值', async () => {
  appRules.start();
  capturedRequests.length = 0;
  const user = createCredentialUser('凭据注入用户', { token: 'rule-secret-token-1', device: 'dev-rule-1' });
  const rule = createRule({
    name: '凭据注入规则',
    keywords: ['凭据测试'],
    url: `http://127.0.0.1:${port}/capture?token={credential:gps.token}&city={arg}`,
    requestMethod: 'POST',
    requestHeadersEnc: encryptSecret(JSON.stringify({ Authorization: 'Bearer {credential:gps.token}' })),
    requestBodyTemplate: '{"device":"{credential:gps.device}"}',
    replyTemplate: '{{answer}}',
    responsePath: 'data',
  });
  await runMessage({ userId: user.id, text: '凭据测试 北京', inboundMessageId: seedInbound(user.id, '凭据测试 北京') });

  assert.equal(capturedRequests.length, 1, '应发出一次真实请求');
  assert.equal(capturedRequests[0].headers.authorization, 'Bearer rule-secret-token-1');
  assert.match(capturedRequests[0].url, /token=rule-secret-token-1/);
  assert.equal(capturedRequests[0].body, '{"device":"dev-rule-1"}');

  const replies = replyOutbox(user.id);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, 'CAPTURED');

  const [logRow] = ruleLogs(rule.id);
  assert.equal(logRow.status, 'success');
  assert.ok(!String(logRow.request_preview).includes('rule-secret-token-1'), '请求预览不得含凭据值');
  assert.ok(String(logRow.request_preview).includes('***') || String(logRow.request_preview).includes('[redacted]'));
  assert.ok(!String(logRow.error).includes('rule-secret-token-1'));
});

test('规则凭据：响应回显被脱敏；缺失凭据 → failed（错误只含名称，不泄漏值）', async () => {
  appRules.start();
  // a) 外部 API 回显凭据值：response_preview 必须脱敏
  capturedRequests.length = 0;
  const echoUser = createCredentialUser('凭据回显用户', { token: 'echo-secret-value-2' });
  const echoRule = createRule({
    name: '凭据回显规则',
    keywords: ['回显测试'],
    url: `http://127.0.0.1:${port}/echo?token={credential:gps.token}`,
    replyTemplate: '{{answer}}',
    responsePath: 'data',
  });
  await runMessage({ userId: echoUser.id, text: '回显测试 x', inboundMessageId: seedInbound(echoUser.id, '回显测试 x') });
  const [echoLog] = ruleLogs(echoRule.id);
  assert.equal(echoLog.status, 'success');
  assert.equal(String(echoLog.response_preview).includes('echo-secret-value-2'), false, '响应预览不得含凭据值');
  assert.ok(String(echoLog.response_preview).includes('***'));
  // b) 缺失凭据 → failed；错误信息只含 gps.token；按配置使用兜底文案
  const noSecretUser = createUser('无凭据用户');
  const missingRule = createRule({
    name: '缺凭据规则',
    keywords: ['缺密钥触发'],
    url: `http://127.0.0.1:${port}/capture?token={credential:gps.token}`,
    replyTemplate: '{{answer}}',
    fallbackText: '凭据缺失兜底',
  });
  capturedRequests.length = 0;
  await runMessage({
    userId: noSecretUser.id,
    text: '缺密钥触发 x',
    inboundMessageId: seedInbound(noSecretUser.id, '缺密钥触发 x'),
  });
  assert.equal(capturedRequests.length, 0, '缺失凭据不应发起请求');
  const [missingLog] = ruleLogs(missingRule.id);
  assert.equal(missingLog.status, 'failed');
  assert.match(missingLog.error, /missing credential gps\.token/);
  assert.equal(String(missingLog.error).includes('***'), false, '缺失错误只含名称，不含占位符/值');
  const fallbackReplies = replyOutbox(noSecretUser.id);
  assert.equal(fallbackReplies.length, 1);
  assert.equal(fallbackReplies[0].text, '凭据缺失兜底');
});

test('规则凭据 + {{noreply}}：命中且注入成功，但不发送回复（日志 success）', async () => {
  appRules.start();
  capturedRequests.length = 0;
  const user = createCredentialUser('凭据不回复用户', { token: 'noreply-secret-3' });
  const rule = createRule({
    name: '凭据不回复规则',
    keywords: ['不回复测试'],
    url: `http://127.0.0.1:${port}/capture?token={credential:gps.token}`,
    replyTemplate: '{{noreply}}',
  });
  await runMessage({ userId: user.id, text: '不回复测试 x', inboundMessageId: seedInbound(user.id, '不回复测试 x') });

  assert.equal(capturedRequests.length, 1, '凭据注入后仍应发起真实请求');
  assert.equal(replyOutbox(user.id).length, 0, '{{noreply}} 不应发送任何消息');
  const [logRow] = ruleLogs(rule.id);
  assert.equal(logRow.status, 'success');
  assert.equal(logRow.reply_outbox_id, null);
});

test('testRule：返回凭据名称列表、请求预览脱敏、缺失凭据返回 missingCredentials', async () => {
  appRules.start();
  capturedRequests.length = 0;
  const user = createCredentialUser('测试运行用户', { token: 'testrule-secret-4' });
  const rule = createRule({
    name: '测试运行凭据规则',
    keywords: ['测试运行'],
    url: `http://127.0.0.1:${port}/capture?token={credential:gps.token}`,
    replyTemplate: '{{answer}}',
  });
  const result = await appRules.testRule({
    ruleRow: store.getAppRuleRow(rule.id),
    message: '测试运行 x',
    userId: user.id,
  });
  assert.equal(result.matched, true);
  assert.deepEqual(result.credentialNames, ['gps']);
  assert.equal(result.request.url.includes('testrule-secret-4'), false, '测试运行请求预览应脱敏');
  assert.ok(result.request.url.includes('***'));
  assert.deepEqual(result.missingCredentials, []);

  const noSecretUser = createUser();
  const missing = await appRules.testRule({
    ruleRow: store.getAppRuleRow(rule.id),
    message: '测试运行 x',
    userId: noSecretUser.id,
  });
  assert.equal(missing.matched, true);
  assert.match(missing.error, /missing credential gps\.token/);
  assert.deepEqual(missing.missingCredentials, ['gps.token']);
});
