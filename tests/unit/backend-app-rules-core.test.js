/**
 * 单元测试：app-rules 纯函数 + SSRF 防护 + 本地假 HTTP server（docs/API_RULES.md §3-§5/§10）。
 * 只访问本机假 HTTP server，不触真实外网。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-app-rules-core-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'app-rules-core-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'app-rules-core-password';
process.env.API_TOKEN = 'app-rules-core-token';
process.env.LOG_LEVEL = 'silent';
process.env.APP_RULES_ALLOWED_HOSTS = '127.0.0.1,localhost';

const appRules = await import('../../server/src/app-rules.js');
const { closeDb } = await import('../../server/src/db.js');

const baseRule = (overrides = {}) => ({
  id: 'rule_test',
  name: '测试规则',
  enabled: true,
  priority: 100,
  scope: { type: 'all', ids: [] },
  match: { mode: 'contains', keywords: ['查天气'], regexPattern: '' },
  extraction: { mode: 'trailing', config: { param: 'arg' } },
  request: { method: 'GET', url: 'http://127.0.0.1:1/', headers: {}, bodyTemplate: '' },
  response: { type: 'json', path: 'data.answer', template: '{{data.answer}}', fallbackText: '' },
  limits: { timeoutMs: 2000, cooldownMs: 0, maxCallsPerHour: 60, maxUserCallsPerHour: 10 },
  ...overrides,
});

let server;
let port = 0;
const requests = [];

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      if (url.pathname === '/weather') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { answer: '今天晴', city: url.searchParams.get('city') } }));
      } else if (url.pathname === '/echo_post') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { answer: `received:${body}` } }));
      } else if (url.pathname === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('纯文本响应');
      } else if (url.pathname === '/redirect') {
        res.writeHead(302, { location: '/weather?city=redirected' });
        res.end();
      } else if (url.pathname === '/binary') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      } else if (url.pathname === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: { answer: '慢' } }));
        }, 1500);
      } else if (url.pathname === '/big') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { answer: 'x'.repeat(5000) } }));
      } else {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(() => {
  closeDb();
  server?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('matchRule：scope all/users/groups + contains/equals/regex', () => {
  const all = baseRule();
  assert.equal(appRules.matchRule(all, { text: '帮我查天气 北京', userId: 'u1', groupIds: ['g1'] }), true);
  assert.equal(appRules.matchRule(all, { text: '你好', userId: 'u1' }), false);

  const users = baseRule({ scope: { type: 'users', ids: ['u1', 'u2'] } });
  assert.equal(appRules.matchRule(users, { text: '查天气', userId: 'u1' }), true);
  assert.equal(appRules.matchRule(users, { text: '查天气', userId: 'u3' }), false);

  const groups = baseRule({ scope: { type: 'groups', ids: ['g1'] } });
  assert.equal(appRules.matchRule(groups, { text: '查天气', userId: 'u1', groupIds: ['g0', 'g1'] }), true);
  assert.equal(appRules.matchRule(groups, { text: '查天气', userId: 'u1', groupIds: ['g2'] }), false);

  const equals = baseRule({ match: { mode: 'equals', keywords: ['查天气'], regexPattern: '' } });
  assert.equal(appRules.matchRule(equals, { text: ' 查天气 ', userId: 'u1' }), true);
  assert.equal(appRules.matchRule(equals, { text: '帮我查天气', userId: 'u1' }), false);

  const regex = baseRule({ match: { mode: 'regex', keywords: [], regexPattern: '^查天气\\s+(.+)$' } });
  assert.equal(appRules.matchRule(regex, { text: '查天气 北京', userId: 'u1' }), true);
  assert.equal(appRules.matchRule(regex, { text: '天气 北京', userId: 'u1' }), false);
});

test('extractParams：trailing / regex / json / fulltext + 内置变量', () => {
  const trailing = appRules.extractParams(baseRule(), { text: '查天气 北京 朝阳', userId: 'u1', displayName: '张三', now: 123 });
  assert.equal(trailing.params.arg, '北京 朝阳');
  assert.equal(trailing.vars.text, '查天气 北京 朝阳');
  assert.equal(trailing.vars.name, '张三');
  assert.equal(trailing.vars.userId, 'u1');
  assert.equal(trailing.vars.now, '123');
  assert.equal(trailing.missing, false);

  const empty = appRules.extractParams(baseRule(), { text: '查天气', userId: 'u1' });
  assert.equal(empty.missing, true, '缺参应标记 missing');

  const regex = appRules.extractParams(
    baseRule({ extraction: { mode: 'regex', config: { regex: '^查(?<city>\\S+)天气$' } } }),
    { text: '查北京天气', userId: 'u1' },
  );
  assert.equal(regex.params.city, '北京');
  assert.equal(regex.missing, false);

  const regexNoName = appRules.extractParams(
    baseRule({ extraction: { mode: 'regex', config: { regex: '^查(\\S+)天气$' } } }),
    { text: '查上海天气', userId: 'u1' },
  );
  assert.equal(regexNoName.params.arg, '上海');

  const json = appRules.extractParams(
    baseRule({ extraction: { mode: 'json', config: {} } }),
    { text: '{"city":"广州","days":3,"extra":{"a":1}}', userId: 'u1' },
  );
  assert.equal(json.params.city, '广州');
  assert.equal(json.params.days, '3');
  assert.equal(json.params.extra, '{"a":1}');

  const fulltext = appRules.extractParams(
    baseRule({ extraction: { mode: 'fulltext', config: { param: 'text' } } }),
    { text: ' 整段文本 ', userId: 'u1' },
  );
  assert.equal(fulltext.params.text, '整段文本');

  const none = appRules.extractParams(
    baseRule({ extraction: { mode: 'none', config: {} } }),
    { text: '任意消息', userId: 'u1', displayName: '张三', now: 456 },
  );
  assert.deepEqual(none.params, {});
  assert.equal(none.missing, false, '不提取模式不应视为缺参');
  assert.equal(none.vars.text, '任意消息');
  assert.equal(none.vars.userId, 'u1');
  assert.equal(none.vars.name, '张三');
  assert.equal(none.vars.now, '456');

  // 多参数组合模式：正则命名组 + 关键词后文本 + 整句，合并后按 required 判定缺参
  const multiRule = baseRule({
    extraction: {
      mode: 'multi',
      config: {
        extractors: [
          { type: 'regex', regex: '^查(?<city>\\S+?)天气(?<date>.+)$' },
          { type: 'trailing', keyword: '天气', param: 'note' },
          { type: 'fulltext', param: 'raw' },
        ],
        required: ['city', 'date'],
      },
    },
  });
  const multi = appRules.extractParams(multiRule, { text: '查北京天气明天', userId: 'u1' });
  assert.equal(multi.params.city, '北京');
  assert.equal(multi.params.date, '明天');
  assert.equal(multi.params.note, '明天');
  assert.equal(multi.params.raw, '查北京天气明天');
  assert.equal(multi.missing, false);

  const multiMissing = appRules.extractParams(multiRule, { text: '查北京天气', userId: 'u1' });
  assert.equal(multiMissing.missing, true, '多参数模式下必填参数缺失应标记 missing');

  const multiOptional = appRules.extractParams(
    baseRule({
      extraction: {
        mode: 'multi',
        config: {
          extractors: [
            { type: 'regex', regex: '^查(?<city>\\S+?)天气$' },
            { type: 'regex', regex: '(?<date>明天|今天|后天)' },
          ],
        },
      },
    }),
    { text: '查北京天气', userId: 'u1' },
  );
  assert.equal(multiOptional.params.city, '北京');
  assert.equal(multiOptional.params.date, undefined);
  assert.equal(multiOptional.missing, false, '未声明必填时至少提取到一个参数即可');
});

test('模板渲染：请求 {var} + URL 编码；回复 {{path}}/{{response}}/{{raw}}', () => {
  const vars = { arg: '北京 朝阳', text: '原文', name: '张三', userId: 'u1', now: '1' };
  assert.equal(
    appRules.renderRequestTemplate('https://api.example.com/weather?city={arg}&name={name}', vars, { urlEncode: true }),
    `https://api.example.com/weather?city=${encodeURIComponent('北京 朝阳')}&name=${encodeURIComponent('张三')}`,
  );
  assert.equal(appRules.renderRequestTemplate('{"text":"{text}"}', vars), '{"text":"原文"}');
  assert.equal(appRules.renderRequestTemplate('{unknown}', vars), '{unknown}');

  assert.equal(
    appRules.renderReplyTemplate('{{data.answer}} / {{response}} / {{raw}}', {
      root: { data: { answer: '晴' } },
      responseText: '解析文本',
      rawText: 'raw',
    }),
    '晴 / 解析文本 / raw',
  );
  assert.equal(appRules.renderReplyTemplate('', { root: null, responseText: '直接使用' }), '直接使用');
  assert.equal(appRules.truncate('x'.repeat(30), 10).length, 10);

  // 列表渲染：{{count path}} + {{#each path}}...{{/each}}（@index/@number、当前项字段、根路径回退）
  const listRoot = {
    ok: true,
    data: {
      code: '0',
      msg: '成功',
      data: [
        { XSXM: '赵培淇', FJH: '417', CQZT_DISPLAY: '未归寝' },
        { XSXM: '胡靖荻', FJH: '410', CQZT_DISPLAY: '已归寝' },
      ],
    },
  };
  const listTemplate = '共 {{count data.data}} 人\n{{#each data.data}}{{@number}}. {{XSXM}}（{{FJH}} 房，{{CQZT_DISPLAY}}）\n{{/each}}';
  assert.equal(
    appRules.renderReplyTemplate(listTemplate, { root: listRoot }),
    '共 2 人\n1. 赵培淇（417 房，未归寝）\n2. 胡靖荻（410 房，已归寝）\n',
  );
  assert.equal(
    appRules.renderReplyTemplate('{{#each data.data}}{{@index}}:{{XSXM}} {{/each}}', { root: listRoot }),
    '0:赵培淇 1:胡靖荻 ',
  );
  assert.equal(
    appRules.renderReplyTemplate('{{#each data.data}}{{data.msg}}-{{XSXM}}；{{/each}}', { root: listRoot }),
    '成功-赵培淇；成功-胡靖荻；',
  );
  assert.equal(
    appRules.renderReplyTemplate('共 {{count data.data}} 人；{{#each data.data}}{{XSXM}}{{/each}}', {
      root: { data: { data: [] } },
    }),
    '共 0 人；',
  );

  // where 过滤：按字段值拆分名单
  const statusRoot = {
    data: {
      data: [
        { XSXM: '赵培淇', FJH: '417', CQZT: '1', CQZT_DISPLAY: '未归寝' },
        { XSXM: '胡靖荻', FJH: '410', CQZT: '2', CQZT_DISPLAY: '已归寝' },
        { XSXM: '刘思辰', FJH: '409', CQZT: '1', CQZT_DISPLAY: '未归寝' },
      ],
    },
  };
  const splitTemplate =
    '【未归寝】{{count data.data where CQZT=1}} 人\n' +
    '{{#each data.data where CQZT=1}}{{@number}}. {{XSXM}}（{{FJH}} 房）\n{{/each}}' +
    '【已归寝】{{count data.data where CQZT=2}} 人\n' +
    '{{#each data.data where CQZT=2}}{{@number}}. {{XSXM}}（{{FJH}} 房）\n{{/each}}';
  assert.equal(
    appRules.renderReplyTemplate(splitTemplate, { root: statusRoot }),
    '【未归寝】2 人\n1. 赵培淇（417 房）\n2. 刘思辰（409 房）\n【已归寝】1 人\n1. 胡靖荻（410 房）\n',
  );
  assert.equal(
    appRules.renderReplyTemplate('{{count data.data where CQZT_DISPLAY="未归寝"}}', { root: statusRoot }),
    '2',
    'where 值支持引号',
  );
  assert.equal(
    appRules.renderReplyTemplate('{{#each data.data where CQZT!=1}}{{XSXM}}{{/each}}', { root: statusRoot }),
    '胡靖荻',
    'where 支持 !=',
  );
});

test('parseResponse：json 路径 / 空路径 reply / 对象 stringify / text', () => {
  const pathResult = appRules.parseResponse({ responseType: 'json', responsePath: 'data.answer', rawText: '{"data":{"answer":"晴"}}' });
  assert.equal(pathResult.responseText, '晴');
  assert.equal(pathResult.value, '晴');

  const replyResult = appRules.parseResponse({ responseType: 'json', responsePath: '', rawText: '{"reply":"好的"}' });
  assert.equal(replyResult.responseText, '好的');

  const objectResult = appRules.parseResponse({ responseType: 'json', responsePath: '', rawText: '{"a":1}' });
  assert.equal(objectResult.responseText, '{"a":1}');

  const textResult = appRules.parseResponse({ responseType: 'text', rawText: '  纯文本  ' });
  assert.equal(textResult.responseText, '纯文本');
  assert.throws(() => appRules.parseResponse({ responseType: 'json', rawText: 'not-json' }), /JSON/);

  const arrayPath = appRules.parseResponse({ responseType: 'json', responsePath: 'data.0.answer', rawText: '{"data":[{"answer":"第一"}]}' });
  assert.equal(arrayPath.responseText, '第一');
});

test('SSRF：私网/环回/保留地址拒绝、白名单放行、userinfo/协议拒绝、DNS 注入', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.1.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', 'ff02::1']) {
    assert.equal(appRules.isPrivateIp(ip), true, `${ip} 应判定为私网/保留`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(appRules.isPrivateIp(ip), false, `${ip} 应判定为公网`);
  }

  await assert.rejects(appRules.validateTargetUrl('http://127.0.0.1:1/x', { allowedHosts: [] }), /SSRF/);
  await assert.rejects(appRules.validateTargetUrl('http://10.0.0.1/x', { allowedHosts: [] }), /SSRF/);
  await assert.rejects(appRules.validateTargetUrl('ftp://example.com/x'), /http\/https/);
  await assert.rejects(appRules.validateTargetUrl('http://user:pass@example.com/x', { allowedHosts: [] }), /userinfo/);
  // 白名单放行私网
  const allowed = await appRules.validateTargetUrl('http://127.0.0.1:1/x', { allowedHosts: ['127.0.0.1'] });
  assert.equal(allowed.hostname, '127.0.0.1');
  // DNS 解析到私网 → 拒绝；白名单主机名放行
  const dnsLookup = async () => [{ address: '10.0.0.9', family: 4 }];
  await assert.rejects(appRules.validateTargetUrl('http://evil.example/x', { allowedHosts: [], dnsLookup }), /SSRF/);
  const allowedDns = await appRules.validateTargetUrl('http://evil.example/x', { allowedHosts: ['evil.example'], dnsLookup });
  assert.equal(allowedDns.hostname, 'evil.example');
});

test('requestExternal：成功/GET query/POST body/重定向复验/超时/大小/二进制拒绝', async () => {
  const ok = await appRules.requestExternal({ url: `http://127.0.0.1:${port}/weather?city=bj`, timeoutMs: 2000 });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /今天晴/);
  assert.equal(typeof ok.latencyMs, 'number');

  const redirected = await appRules.requestExternal({ url: `http://127.0.0.1:${port}/redirect`, timeoutMs: 2000 });
  assert.equal(redirected.status, 200);
  assert.match(redirected.text, /redirected/);

  const postEcho = await appRules.requestExternal({
    url: `http://127.0.0.1:${port}/echo_post`,
    method: 'POST',
    body: 'hello',
    headers: { 'content-type': 'text/plain' },
    timeoutMs: 2000,
  });
  assert.match(postEcho.text, /received:hello/);

  await assert.rejects(
    appRules.requestExternal({ url: `http://127.0.0.1:${port}/slow`, timeoutMs: 300 }),
    (err) => /aborted|abort/i.test(String(err?.name ?? err?.message ?? err)),
  );
  await assert.rejects(appRules.requestExternal({ url: `http://127.0.0.1:${port}/big`, maxResponseBytes: 1024 }), /大小上限/);
  await assert.rejects(appRules.requestExternal({ url: `http://127.0.0.1:${port}/binary` }), /响应类型/);
  await assert.rejects(appRules.requestExternal({ url: 'http://10.0.0.1/x' }), /SSRF/);
});

test('executeRuleHttp：成功渲染回复；失败 fallback；缺参 fallback；不写日志', async () => {
  const rule = baseRule({
    request: { method: 'GET', url: `http://127.0.0.1:${port}/weather?city={arg}`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: 'data.answer', template: '天气：{{data.answer}}', fallbackText: '兜底' },
  });
  const success = await appRules.executeRuleHttp(rule, { text: '查天气 北京', userId: 'u1', displayName: '张三' });
  assert.equal(success.error, '');
  assert.equal(success.httpStatus, 200);
  assert.equal(success.params.arg, '北京');
  assert.equal(success.replyText, '天气：今天晴');

  const failRule = baseRule({
    request: { method: 'GET', url: `http://127.0.0.1:${port}/nope`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: '', template: '', fallbackText: '暂时无法查询' },
  });
  const failure = await appRules.executeRuleHttp(failRule, { text: '查天气 北京', userId: 'u1' });
  assert.equal(failure.error, 'HTTP 500');
  assert.equal(failure.httpStatus, 500);
  assert.equal(failure.replyText, '暂时无法查询');

  const missing = await appRules.executeRuleHttp(rule, { text: '查天气', userId: 'u1' });
  assert.equal(missing.error, 'missing params');
  assert.equal(missing.replyText, '兜底');
});

test('testRule dry-run：不写日志、不发消息、返回请求/响应/回复信息', async () => {
  const { getDb } = await import('../../server/src/db.js');
  const { createAppRule, insertAppRuleLog } = await import('../../server/src/store.js');
  const ruleRow = createAppRule({
    name: 'dry-run规则',
    enabled: true,
    priority: 10,
    scopeType: 'all',
    scopeIds: [],
    matchMode: 'contains',
    keywords: ['查天气'],
    regexPattern: '',
    extractionMode: 'trailing',
    extractionConfig: { param: 'arg' },
    requestMethod: 'GET',
    requestUrl: `http://127.0.0.1:${port}/weather?city={arg}`,
    requestHeadersEnc: null,
    requestBodyTemplate: '',
    responseType: 'json',
    responsePath: 'data.answer',
    replyTemplate: '{{data.answer}}',
    fallbackText: '',
    timeoutMs: 2000,
    cooldownMs: 0,
    maxCallsPerHour: 60,
    maxUserCallsPerHour: 10,
  });
  const raw = getDb().prepare('SELECT * FROM app_rules WHERE id = ?').get(ruleRow.id);
  const logsBefore = Number(getDb().prepare('SELECT COUNT(*) AS c FROM app_rule_logs').get().c);
  const outboxBefore = Number(getDb().prepare('SELECT COUNT(*) AS c FROM outbox').get().c);

  const matched = await appRules.testRule({ ruleRow: raw, message: '查天气 上海' });
  assert.equal(matched.matched, true);
  assert.equal(matched.params.arg, '上海');
  assert.equal(matched.httpStatus, 200);
  assert.equal(matched.replyText, '今天晴');
  assert.equal(matched.error, '');
  assert.ok(matched.request.url.includes('city=%E4%B8%8A%E6%B5%B7'));
  assert.deepEqual(matched.request.headerNames, []);

  const unmatched = await appRules.testRule({ ruleRow: raw, message: '你好' });
  assert.equal(unmatched.matched, false);
  assert.equal(unmatched.httpStatus, null);

  assert.equal(Number(getDb().prepare('SELECT COUNT(*) AS c FROM app_rule_logs').get().c), logsBefore, 'dry-run 不应写运行日志');
  assert.equal(Number(getDb().prepare('SELECT COUNT(*) AS c FROM outbox').get().c), outboxBefore, 'dry-run 不应发消息');
});

test('requestExternal：POST JSON body 自动补 Content-Type；网络错误诊断可读', async () => {
  requests.length = 0;
  const result = await appRules.requestExternal({
    url: `http://127.0.0.1:${port}/echo_post`,
    method: 'POST',
    body: '{"pageSize":1,"pageNumber":1}',
    timeoutMs: 2000,
  });
  assert.equal(result.status, 200);
  const sent = requests.find((item) => item.path === '/echo_post');
  assert.ok(sent, '应发出 POST 请求');
  assert.match(sent.headers['content-type'], /application\/json/);

  const networkError = new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:9'), { code: 'ECONNREFUSED' }),
  });
  const message = appRules.describeFetchError(networkError);
  assert.match(message, /ECONNREFUSED/);
  assert.match(message, /请检查目标服务是否已启动/);
  assert.match(appRules.describeFetchError(Object.assign(new Error('aborted'), { name: 'AbortError' })), /请求超时/);
});