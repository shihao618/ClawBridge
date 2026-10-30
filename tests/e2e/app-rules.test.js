/**
 * e2e：接口应用（关键词触发 → 调外部 HTTP 接口 → 解析回复微信；docs/API_RULES.md §1-§5/§7）。
 *
 * 外部接口使用本进程内 node:http mock（127.0.0.1 随机端口，记录 method/url/query/headers/body，
 * 可配置 JSON/文本/状态码/延迟/重定向），不触真实外网。
 *
 * 覆盖：
 *  - 规则 CRUD/校验/Header 值脱敏/鉴权 401/403；
 *  - user scope + contains + trailing 成功链路（外部 API 收到参数→用户收到解析回复→日志 success）；
 *  - POST body 模板 + regex 命名组提取；
 *  - 分组 scope 命中/不命中；
 *  - 优先级：多条命中只执行一条；
 *  - 失败兜底（500）与超时无兜底（不回复）；
 *  - 同用户冷却 / 规则小时上限 skipped；
 *  - SSRF：未放行白名单的 app 实例拒绝访问 127.0.0.1（外部 API 收不到请求）；
 *  - 测试运行 dry-run 不发送、不写运行日志；未命中消息不触发。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { sleep, startE2E, startMockApi, waitFor } from '../helpers/e2e-env.mjs';

let e2e;
let externalApi;
let userA;
let userB;
let accountA;
let accountB;
let groupRule;
let seq = 0;

const uniqueText = (prefix) => {
  seq += 1;
  return `${prefix}-${seq}`;
};

function uniqueMessageId() {
  seq += 1;
  return (BigInt(Date.now()) * 1000n + BigInt(seq)).toString();
}

/** 注入一条入站文本消息并等待落库（规则引擎在落库后异步触发）。 */
async function injectInbound(user, account, text) {
  await e2e.mockInbound(account.botId, {
    text,
    context_token: `ctx-${text}`,
    message_id: uniqueMessageId(),
  });
  await e2e.waitInboundText(user.id, text);
}

/** 创建规则并断言 201，返回 RuleView。 */
async function createRuleOrFail(body) {
  const res = await e2e.createAppRule(body);
  assert.equal(res.status, 201, `创建规则应 201，实际 ${res.status}：${res.text}`);
  assert.ok(res.json?.rule?.id?.startsWith('rule_'), `RuleView.id 应为 rule_ 前缀：${res.text}`);
  return res.json.rule;
}

/** 统计某用户收到的 source=rule 出站消息。 */
async function ruleOutboundMessages(userId) {
  const res = await e2e.adminGet(`/api/admin/messages?direction=outbound&userId=${encodeURIComponent(userId)}&limit=100`);
  assert.equal(res.status, 200, `查询出站消息失败：${res.status} ${res.text}`);
  return (res.json.items ?? []).filter((row) => row.source === 'rule');
}

const RULE_BASE = () => ({
  enabled: true,
  priority: 100,
  scope: { type: 'all', ids: [] },
  matchMode: 'contains',
  keywords: ['__none__'],
  regexPattern: '',
  extraction: { mode: 'multi', config: { extractors: [{ type: 'trailing', param: 'arg' }] } },
  request: { method: 'GET', url: `${externalApi.baseUrl}/echo`, headers: {}, bodyTemplate: '' },
  response: { type: 'json', path: '', template: '', fallbackText: '' },
  timeoutMs: 3000,
  cooldownMs: 0,
  maxCallsPerHour: 100,
  maxUserCallsPerHour: 100,
});

before(async () => {
  e2e = await startE2E();
  externalApi = await startMockApi();
  await e2e.ensureAdmin();

  const a = await e2e.bindUser({ displayName: '规则用户A', waitMonitor: true });
  userA = a.user;
  accountA = a.account;
  const b = await e2e.bindUser({ displayName: '规则用户B', waitMonitor: true });
  userB = b.user;
  accountB = b.account;

  const created = await e2e.createGroup({ name: '接口规则分组', description: 'app rules e2e' });
  assert.equal(created.status, 201, `创建分组失败：${created.status} ${created.text}`);
  groupRule = created.json.group;
  const assigned = await e2e.assignUserGroups(userB.id, [groupRule.id]);
  assert.equal(assigned.status, 200, `分配分组失败：${assigned.status} ${assigned.text}`);
});

after(async () => {
  await externalApi?.close().catch(() => {});
  await e2e?.cleanup();
});

test('规则 CRUD / 校验 / Header 值脱敏 / 鉴权（401/403）', async () => {
  await e2e.ensureAdmin();

  // 创建（带敏感 Header，读取接口不得回显值）
  const created = await e2e.createAppRule({
    ...RULE_BASE(),
    name: 'CRUD 规则',
    keywords: ['crud测试'],
    request: {
      method: 'GET',
      url: `${externalApi.baseUrl}/crud?q={arg}`,
      headers: { Authorization: 'Bearer super-secret-token', 'X-Custom': 'custom-value' },
      bodyTemplate: '',
    },
  });
  assert.equal(created.status, 201, `创建规则应 201：${created.status} ${created.text}`);
  const rule = created.json.rule;
  assert.match(rule.id, /^rule_/);
  assert.equal(rule.name, 'CRUD 规则');
  assert.equal(rule.scope.type, 'all');
  assert.equal(rule.trigger.matchMode, 'contains');
  assert.deepEqual(rule.trigger.keywords, ['crud测试']);
  assert.equal(rule.request.method, 'GET');
  assert.ok(rule.request.url.includes('{arg}'));
  assert.ok(Array.isArray(rule.request.headerNames));
  assert.ok(rule.request.headerNames.includes('Authorization'));
  assert.deepEqual(rule.request.headerNames.sort(), ['Authorization', 'X-Custom'].sort());
  assert.equal(rule.limits.timeoutMs, 3000);
  assert.equal(rule.response.type, 'json');
  assert.equal(typeof rule.stats, 'object');
  assert.equal(typeof rule.createdAt, 'number');
  // 任何读取响应都不应包含 Header 值
  assert.equal(created.text.includes('super-secret-token'), false, '创建响应不应回显 Header 值');
  assert.equal(created.text.includes('custom-value'), false, '创建响应不应回显 Header 值');

  // 列表 / 详情均不回显 Header 值
  const listed = await e2e.listAppRules();
  assert.equal(listed.status, 200, `规则列表失败：${listed.status} ${listed.text}`);
  assert.ok(Array.isArray(listed.json.items));
  assert.ok(listed.json.items.some((item) => item.id === rule.id));
  assert.equal(listed.text.includes('super-secret-token'), false, '规则列表不应回显 Header 值');

  const detail = await e2e.getAppRule(rule.id);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.rule.id, rule.id);
  assert.equal(detail.text.includes('super-secret-token'), false, '规则详情不应回显 Header 值');

  // 更新
  const patched = await e2e.updateAppRule(rule.id, { name: 'CRUD 规则-改名', priority: 5 });
  assert.equal(patched.status, 200, `更新规则应 200：${patched.status} ${patched.text}`);
  assert.equal(patched.json.rule.name, 'CRUD 规则-改名');
  assert.equal(patched.json.rule.priority, 5);
  assert.ok(Array.isArray(patched.json.rule.request.headerNames), '更新响应仍应只返回 headerNames');

  // 非法请求校验 → 400
  const invalidBodies = [
    { ...RULE_BASE(), name: '' },
    { ...RULE_BASE(), name: 'x', keywords: [] },
    { ...RULE_BASE(), name: 'x', request: { method: 'GET', url: 'ftp://example.com/x', bodyTemplate: '' } },
    { ...RULE_BASE(), name: 'x', request: { method: 'GET', url: 'not a valid url', bodyTemplate: '' } },
    { ...RULE_BASE(), name: 'x', matchMode: 'regex', regexPattern: '[' },
    { ...RULE_BASE(), name: 'x', scope: { type: 'users', ids: ['u_not_exists_e2e'] } },
    { ...RULE_BASE(), name: 'x', extraction: { mode: 'bad-mode', config: {} } },
    { ...RULE_BASE(), name: 'x', timeoutMs: 10 },
    { ...RULE_BASE(), name: 'x', response: { type: 'xml', path: '', template: '', fallbackText: '' } },
  ];
  for (const body of invalidBodies) {
    const res = await e2e.createAppRule(body);
    assert.equal(res.status, 400, `非法规则应 400：${res.status} ${res.text}`);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
  }

  // 不存在规则 → 404
  const missingUpdate = await e2e.updateAppRule('rule_not_exists_e2e', { name: 'x' });
  assert.equal(missingUpdate.status, 404);
  const missingGet = await e2e.getAppRule('rule_not_exists_e2e');
  assert.equal(missingGet.status, 404, '不存在规则详情应 404');
  const missingDelete = await e2e.deleteAppRule('rule_not_exists_e2e');
  assert.equal(missingDelete.status, 404, '删除不存在规则应 404');

  // 鉴权：未登录 401、缺 CSRF 403
  const noAuthCreate = await e2e.request('POST', '/api/admin/app-rules', {
    body: { ...RULE_BASE(), name: '未登录创建' },
  });
  assert.equal(noAuthCreate.status, 401, `未登录创建规则应 401：${noAuthCreate.status} ${noAuthCreate.text}`);
  const noCsrfCreate = await e2e.adminRequest('POST', '/api/admin/app-rules', {
    body: { ...RULE_BASE(), name: '缺CSRF创建' },
  });
  assert.equal(noCsrfCreate.status, 403, `缺 CSRF 头创建规则应 403：${noCsrfCreate.status} ${noCsrfCreate.text}`);
  const noAuthList = await e2e.request('GET', '/api/admin/app-rules');
  assert.equal(noAuthList.status, 401);

  // 删除
  const deleted = await e2e.deleteAppRule(rule.id);
  assert.equal(deleted.status, 204, `删除规则应 204：${deleted.status} ${deleted.text}`);
  const afterDelete = await e2e.getAppRule(rule.id);
  assert.equal(afterDelete.status, 404);
});

test('成功链路：user scope + contains + trailing → 调外部 API → 解析回复用户 → 日志 success', async () => {
  externalApi.setResponse({ json: { data: { answer: '北京晴 25℃' } } });
  const rule = await createRuleOrFail({
    ...RULE_BASE(),
    name: '天气查询',
    scope: { type: 'users', ids: [userA.id] },
    keywords: ['查天气'],
    extraction: { mode: 'multi', config: { extractors: [{ type: 'trailing', param: 'city' }] } },
    request: { method: 'GET', url: `${externalApi.baseUrl}/weather?city={city}`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: 'data', template: '{{answer}}', fallbackText: '暂时无法查询' },
    timeoutMs: 3000,
  });
  assert.ok(rule.scope.ids.includes(userA.id));

  externalApi.reset();
  await injectInbound(userA, accountA, '查天气 北京');

  const request = await externalApi.waitForRequest((item) => item.pathname === '/weather', {
    label: '外部 API 收到 /weather 请求',
  });
  assert.equal(request.method, 'GET');
  assert.equal(request.query.city, '北京', 'trailing 提取参数应正确 URL 编码传入');
  assert.ok(request.url.includes(encodeURIComponent('北京')), `URL 应包含编码后的参数：${request.url}`);

  const reply = await e2e.waitMockSentMessageContaining('北京晴 25℃', {
    toUserId: userA.wechatUserId,
    label: '用户 A 收到规则解析回复',
  });
  assert.ok(reply.text.includes('北京晴 25℃'));

  const outbound = await e2e.waitAdminMessage(
    (row) =>
      row.direction === 'outbound' &&
      row.source === 'rule' &&
      row.userId === userA.id &&
      row.status === 'sent' &&
      row.text.includes('北京晴 25℃'),
    { direction: 'outbound', timeoutMs: 8000, label: '后台出现 source=rule 的回复且 sent' },
  );
  const outbox = await e2e.waitOutbox(outbound.id, 'sent');
  assert.equal(outbox.attempts >= 1, true);

  const log = await e2e.waitAppRuleLog(
    (item) => item.ruleId === rule.id && item.userId === userA.id && item.status === 'success',
    { ruleId: rule.id, label: '规则日志 success' },
  );
  assert.equal(log.status, 'success');
  assert.equal(log.httpStatus, 200);
  assert.equal(typeof log.latencyMs, 'number');
  assert.ok(log.replyOutboxId, '成功日志应关联 replyOutboxId');
  assert.equal(log.error, '');
  assert.ok(log.paramsPreview.includes('北京'), `paramsPreview 应包含提取参数：${log.paramsPreview}`);
  assert.equal(externalApi.requests.length, 1, '本次触发应只调用外部 API 一次');
});

test('POST body 模板 + regex 命名组提取', async () => {
  externalApi.setResponse({ json: { reply: '下单成功：苹果 x3' } });
  const rule = await createRuleOrFail({
    ...RULE_BASE(),
    name: '下单接口',
    scope: { type: 'users', ids: [userA.id] },
    keywords: ['下单'],
    matchMode: 'contains',
    extraction: { mode: 'multi', config: { extractors: [{ type: 'regex', regex: '^下单\\s+(?<item>\\S+)\\s+x(?<qty>\\d+)$' }] } },
    request: {
      method: 'POST',
      url: `${externalApi.baseUrl}/order`,
      // 显式设置 Content-Type（契约 §4：Header/Body 模板由规则配置决定）
      headers: { 'Content-Type': 'application/json', 'X-Test': 'rule-e2e' },
      bodyTemplate: '{"item":"{item}","qty":"{qty}","user":"{name}"}',
    },
    response: { type: 'json', path: 'reply', template: '', fallbackText: '下单失败' },
    timeoutMs: 3000,
  });
  assert.equal(rule.extraction.mode, 'multi');
  assert.equal(rule.extraction.config.extractors[0].type, 'regex');

  externalApi.reset();
  await injectInbound(userA, accountA, '下单 苹果 x3');

  const request = await externalApi.waitForRequest((item) => item.pathname === '/order', {
    label: '外部 API 收到 POST /order',
  });
  assert.equal(request.method, 'POST');
  assert.match(String(request.headers['content-type'] ?? ''), /^application\/json/i, '规则配置的 Content-Type 应生效');
  assert.equal(request.headers['x-test'], 'rule-e2e');
  assert.deepEqual(request.bodyJson, { item: '苹果', qty: '3', user: '规则用户A' }, 'POST body 模板与变量渲染应正确');

  await e2e.waitMockSentMessageContaining('下单成功：苹果 x3', { toUserId: userA.wechatUserId });
  const log = await e2e.waitAppRuleLog(
    (item) => item.ruleId === rule.id && item.status === 'success',
    { ruleId: rule.id, label: 'POST 规则日志 success' },
  );
  assert.equal(log.httpStatus, 200);
  assert.equal(log.error, '');
});

test('分组 scope：组内用户命中、非组内用户不触发', async () => {
  externalApi.setResponse({ json: { data: { answer: '组内接口回复' } } });
  const rule = await createRuleOrFail({
    ...RULE_BASE(),
    name: '分组查询接口',
    scope: { type: 'groups', ids: [groupRule.id] },
    keywords: ['分组查询'],
    extraction: { mode: 'multi', config: { extractors: [{ type: 'trailing', param: 'q' }] } },
    request: { method: 'GET', url: `${externalApi.baseUrl}/group?q={q}`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: 'data', template: '{{answer}}', fallbackText: '分组查询失败' },
  });
  assert.equal(rule.scope.type, 'groups');
  assert.ok(Array.isArray(rule.scope.ids) && rule.scope.ids.includes(groupRule.id));

  // 组内用户 B 命中
  externalApi.reset();
  await injectInbound(userB, accountB, '分组查询 天气');
  const request = await externalApi.waitForRequest((item) => item.pathname === '/group');
  assert.equal(request.query.q, '天气');
  await e2e.waitMockSentMessageContaining('组内接口回复', { toUserId: userB.wechatUserId });
  const hitLog = await e2e.waitAppRuleLog(
    (item) => item.ruleId === rule.id && item.userId === userB.id && item.status === 'success',
    { ruleId: rule.id, label: '组内用户规则日志 success' },
  );
  assert.equal(hitLog.httpStatus, 200);

  // 非组内用户 A 不触发
  externalApi.reset();
  await injectInbound(userA, accountA, '分组查询 天气');
  await sleep(900);
  assert.equal(externalApi.requests.length, 0, '非组内用户消息不应调用外部 API');
  const missLogs = await e2e.getAppRuleLogs({ ruleId: rule.id, userId: userA.id });
  assert.equal(missLogs.status, 200);
  assert.equal(missLogs.json.total, 0, '非组内用户不应产生规则日志');
  const replyCount = await e2e.countMockSentMessagesContaining('组内接口回复', { toUserId: userA.wechatUserId });
  assert.equal(replyCount, 0, '非组内用户不应收到规则回复');
});

test('优先级：同一消息命中多条规则时只执行 priority 最小的一条', async () => {
  externalApi.setResponse({ json: { data: { answer: 'LOW-RULE-HIT' } } });
  const lowRule = await createRuleOrFail({
    ...RULE_BASE(),
    name: '低优先级规则',
    priority: 10,
    scope: { type: 'users', ids: [userA.id] },
    keywords: ['优先级测试'],
    request: { method: 'GET', url: `${externalApi.baseUrl}/low`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: 'data', template: '{{answer}}', fallbackText: '' },
  });
  const highRule = await createRuleOrFail({
    ...RULE_BASE(),
    name: '高优先级规则',
    priority: 50,
    scope: { type: 'users', ids: [userA.id] },
    keywords: ['优先级测试'],
    request: { method: 'GET', url: `${externalApi.baseUrl}/high`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: 'data', template: '{{answer}}', fallbackText: '' },
  });
  assert.ok(lowRule.priority < highRule.priority);

  externalApi.reset();
  await injectInbound(userA, accountA, '优先级测试 内容');
  await e2e.waitMockSentMessageContaining('LOW-RULE-HIT', { toUserId: userA.wechatUserId });
  await sleep(700);
  assert.equal(externalApi.requests.length, 1, '只应执行一条规则（外部 API 只收到 1 次请求）');
  assert.equal(externalApi.requests[0].pathname, '/low', '应执行 priority 更小的规则');
  const highLogs = await e2e.getAppRuleLogs({ ruleId: highRule.id });
  assert.equal(highLogs.status, 200);
  assert.equal(highLogs.json.total, 0, '未执行的规则不应产生日志');
  const lowLogs = await e2e.getAppRuleLogs({ ruleId: lowRule.id });
  assert.ok(lowLogs.json.total >= 1, '被执行的规则应有日志');
});

test('失败兜底：外部接口 500 时回复 fallback_text；超时无兜底不回复', async () => {
  await e2e.ensureAdmin();
  // ---- 500 → fallback_text ----
  externalApi.setResponse({ status: 500, body: 'boom' });
  const failRule = await createRuleOrFail({
    ...RULE_BASE(),
    name: '失败兜底规则',
    scope: { type: 'users', ids: [userA.id] },
    keywords: ['失败测试'],
    request: { method: 'GET', url: `${externalApi.baseUrl}/fail`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: 'data', template: '{{answer}}', fallbackText: '接口暂时不可用' },
    timeoutMs: 2000,
  });
  await injectInbound(userA, accountA, '失败测试 内容');
  await e2e.waitMockSentMessageContaining('接口暂时不可用', { toUserId: userA.wechatUserId });
  const failedLog = await e2e.waitAppRuleLog(
    (item) => item.ruleId === failRule.id && item.userId === userA.id && item.status === 'failed',
    { ruleId: failRule.id, label: '500 失败日志' },
  );
  assert.equal(failedLog.status, 'failed');
  assert.equal(failedLog.httpStatus, 500);
  assert.ok(failedLog.error, '失败日志应包含错误信息');
  assert.ok(failedLog.replyOutboxId, '有 fallback 时应入队兜底回复');

  // ---- 超时（无 fallback）→ 不回复 ----
  externalApi.setResponse({ delayMs: 1600, json: { data: { answer: 'never' } } });
  const timeoutRule = await createRuleOrFail({
    ...RULE_BASE(),
    name: '超时无兜底规则',
    scope: { type: 'users', ids: [userA.id] },
    keywords: ['超时测试'],
    request: { method: 'GET', url: `${externalApi.baseUrl}/slow`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: 'data', template: '{{answer}}', fallbackText: '' },
    timeoutMs: 1000,
  });
  const ruleMessagesBefore = (await ruleOutboundMessages(userA.id)).length;
  externalApi.reset();
  await injectInbound(userA, accountA, '超时测试 内容');
  const timeoutLog = await e2e.waitAppRuleLog(
    (item) => item.ruleId === timeoutRule.id && item.userId === userA.id && item.status === 'failed',
    { ruleId: timeoutRule.id, label: '超时失败日志' },
  );
  assert.equal(timeoutLog.status, 'failed');
  assert.ok(String(timeoutLog.error).length > 0, '超时失败日志应包含错误');
  await sleep(800);
  const ruleMessagesAfter = (await ruleOutboundMessages(userA.id)).length;
  assert.equal(ruleMessagesAfter, ruleMessagesBefore, '无 fallback 时失败不应给用户发送消息');
  assert.equal(externalApi.requests.length, 1, '超时用例外部 API 应收到 1 次请求');

  // 恢复默认响应
  externalApi.setResponse({ json: { ok: true } });
});

test('冷却：同用户同规则冷却期内第二条消息不触发', async () => {
  externalApi.setResponse({ json: { data: { answer: '冷却回复' } } });
  const rule = await createRuleOrFail({
    ...RULE_BASE(),
    name: '冷却测试规则',
    scope: { type: 'users', ids: [userA.id] },
    keywords: ['冷却测试'],
    request: { method: 'GET', url: `${externalApi.baseUrl}/cooldown`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: 'data', template: '{{answer}}', fallbackText: '' },
    cooldownMs: 60000,
  });
  await injectInbound(userA, accountA, '冷却测试 第一次');
  await e2e.waitMockSentMessageContaining('冷却回复', { toUserId: userA.wechatUserId });
  await e2e.waitAppRuleLog((item) => item.ruleId === rule.id && item.status === 'success', { ruleId: rule.id });

  externalApi.reset();
  await injectInbound(userA, accountA, '冷却测试 第二次');
  await sleep(1000);
  assert.equal(externalApi.requests.length, 0, '冷却期内不应再次调用外部 API');
});

test('规则小时上限：超过 maxUserCallsPerHour 的消息被 skipped', async () => {
  externalApi.setResponse({ json: { data: { answer: '限额回复' } } });
  const rule = await createRuleOrFail({
    ...RULE_BASE(),
    name: '限额测试规则',
    scope: { type: 'users', ids: [userA.id] },
    keywords: ['限额测试'],
    request: { method: 'GET', url: `${externalApi.baseUrl}/quota`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: 'data', template: '{{answer}}', fallbackText: '' },
    cooldownMs: 0,
    maxUserCallsPerHour: 1,
    maxCallsPerHour: 100,
  });
  await injectInbound(userA, accountA, '限额测试 第一次');
  await e2e.waitMockSentMessageContaining('限额回复', { toUserId: userA.wechatUserId });

  externalApi.reset();
  await injectInbound(userA, accountA, '限额测试 第二次');
  const skippedLog = await e2e.waitAppRuleLog(
    (item) => item.ruleId === rule.id && item.userId === userA.id && item.status === 'skipped',
    { ruleId: rule.id, label: '小时上限 skipped 日志' },
  );
  assert.equal(skippedLog.status, 'skipped');
  assert.equal(externalApi.requests.length, 0, '超限后不应调用外部 API');
});

test('SSRF：未放行白名单的 app 实例拒绝访问 127.0.0.1（外部 API 收不到请求）', async () => {
  const ssrfE2E = await startE2E({ appEnv: { APP_RULES_ALLOWED_HOSTS: '' } });
  try {
    await ssrfE2E.ensureAdmin();
    const bound = await ssrfE2E.bindUser({ displayName: 'SSRF用户', waitMonitor: true });
    externalApi.reset();
    const created = await ssrfE2E.createAppRule({
      ...RULE_BASE(),
      name: 'SSRF 规则',
      scope: { type: 'users', ids: [bound.user.id] },
      keywords: ['ssrf测试'],
      request: { method: 'GET', url: `${externalApi.baseUrl}/ssrf`, headers: {}, bodyTemplate: '' },
      response: { type: 'json', path: 'data', template: '{{answer}}', fallbackText: '' },
      timeoutMs: 2000,
    });
    assert.equal(created.status, 201, `SSRF 规则创建应 201：${created.status} ${created.text}`);
    const ruleId = created.json.rule.id;

    await ssrfE2E.mockInbound(bound.account.botId, {
      text: 'ssrf测试 内容',
      context_token: 'ctx-ssrf',
      message_id: uniqueMessageId(),
    });
    await ssrfE2E.waitInboundText(bound.user.id, 'ssrf测试 内容');

    const log = await ssrfE2E.waitAppRuleLog(
      (item) => item.ruleId === ruleId && item.status === 'failed',
      { ruleId, label: 'SSRF 阻止日志失败' },
    );
    assert.equal(log.status, 'failed');
    assert.match(
      String(log.error),
      /SSRF|内网|私网|私有|blocked|forbidden|不允许|禁止/i,
      `失败原因应说明 SSRF/私网被阻止：${log.error}`,
    );
    assert.equal(externalApi.requests.length, 0, 'SSRF 被阻止时外部 API 不应收到请求');
  } finally {
    await ssrfE2E.cleanup();
    externalApi.setResponse({ json: { ok: true } });
  }
});

test('测试运行（dry-run）：返回解析结果但不发送、不写运行日志', async () => {
  await e2e.ensureAdmin();
  // 复用天气规则（user scope A）
  const rules = await e2e.listAppRules();
  const rule = (rules.json.items ?? []).find((item) => item.name === '天气查询');
  assert.ok(rule, '应存在天气查询规则');

  externalApi.setResponse({ json: { data: { answer: '上海多云 18℃' } } });
  externalApi.reset();
  const logsBefore = await e2e.getAppRuleLogs({ ruleId: rule.id });
  assert.equal(logsBefore.status, 200);
  const beforeCount = logsBefore.json.total;
  const repliesBefore = await e2e.countMockSentMessagesContaining('上海多云', { toUserId: userA.wechatUserId });

  const dryRun = await e2e.testAppRule(rule.id, { message: '查天气 上海', userId: userA.id });
  assert.equal(dryRun.status, 200, `dry-run 应 200：${dryRun.status} ${dryRun.text}`);
  assert.equal(dryRun.json.matched, true);
  assert.equal(dryRun.json.ruleId, rule.id);
  assert.equal(dryRun.json.params?.city, '上海');
  assert.equal(dryRun.json.request.method, 'GET');
  assert.ok(String(dryRun.json.request.url).includes('weather'));
  assert.equal(dryRun.json.httpStatus, 200);
  assert.equal(typeof dryRun.json.latencyMs, 'number');
  assert.ok(String(dryRun.json.responsePreview).includes('上海多云'));
  assert.ok(String(dryRun.json.replyText).includes('上海多云'));
  assert.equal(dryRun.json.error, '');

  // dry-run 会真实调用外部接口，但不发送微信消息、不写运行日志
  assert.equal(externalApi.requests.length, 1, 'dry-run 应调用外部 API 一次');
  await sleep(700);
  const repliesAfter = await e2e.countMockSentMessagesContaining('上海多云', { toUserId: userA.wechatUserId });
  assert.equal(repliesAfter, repliesBefore, 'dry-run 不应给用户发送消息');
  const logsAfter = await e2e.getAppRuleLogs({ ruleId: rule.id });
  assert.equal(logsAfter.json.total, beforeCount, 'dry-run 不应写运行日志');
});

test('未命中关键词/无规则的消息不触发外部接口', async () => {
  externalApi.reset();
  const unrelated = uniqueText('无关键词语句');
  await injectInbound(userA, accountA, unrelated);
  await sleep(900);
  assert.equal(externalApi.requests.length, 0, '未命中任何规则的消息不应调用外部 API');
  const logs = await e2e.getAppRuleLogs({ userId: userA.id, limit: 200 });
  assert.equal(logs.status, 200);
  assert.equal(
    (logs.json.items ?? []).some((item) => String(item.paramsPreview || '').includes(unrelated)),
    false,
    '未命中消息不应产生对应规则日志',
  );
});
