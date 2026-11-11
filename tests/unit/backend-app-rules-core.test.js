/**
 * 单元测试：app-rules 纯函数 + SSRF 防护 + 本地假 HTTP server（docs/API_RULES.md §3-§5/§10）。
 * 只访问本机假 HTTP server，不触真实外网。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import zlib from 'node:zlib';
import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-app-rules-core-',
  env: {
    APP_SECRET: 'app-rules-core-secret-0123456789abcdef0123456789abcdef',
    ADMIN_PASSWORD: 'app-rules-core-password',
    API_TOKEN: 'app-rules-core-token',
    LOG_LEVEL: 'silent',
    APP_RULES_ALLOWED_HOSTS: '127.0.0.1,localhost',
  },
});

const appRules = await import('../../server/src/app-rules.js');

const baseRule = (overrides = {}) => ({
  id: 'rule_test',
  name: '测试规则',
  enabled: true,
  priority: 100,
  scope: { type: 'all', ids: [] },
  match: { mode: 'contains', keywords: ['查天气'], regexPattern: '' },
  extraction: { mode: 'multi', config: { extractors: [{ type: 'trailing', param: 'arg' }] } },
  request: { method: 'GET', url: 'http://127.0.0.1:1/', headers: {}, bodyTemplate: '' },
  response: { type: 'json', path: 'data', template: '{{answer}}', fallbackText: '' },
  limits: { timeoutMs: 2000 },
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
      } else if (url.pathname === '/redirect-cross') {
        res.writeHead(302, { location: `http://localhost:${port}/weather` });
        res.end();
      } else if (url.pathname === '/redirect-private') {
        // 重定向目标既跨源又位于私网/保留网段：必须在校验阶段拒绝，不得建立连接
        res.writeHead(302, { location: 'http://10.0.0.1:1/internal-meta' });
        res.end();
      } else if (url.pathname === '/gzip') {
        const payload = zlib.gzipSync(JSON.stringify({ data: { answer: '压缩响应' } }));
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': payload.length,
        });
        res.end(payload);
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
      } else if (url.pathname === '/big-chunked') {
        // 不设置 Content-Length，模拟 chunked 大响应，验证流式读取上限
        res.writeHead(200, { 'content-type': 'application/json' });
        for (let i = 0; i < 8; i += 1) res.write('x'.repeat(512));
        res.end();
      } else if (url.pathname === '/slow-body') {
        // 响应头已返回但 body 迟迟不结束：验证超时覆盖 body 读取阶段
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('start');
        setTimeout(() => res.end('end'), 1500);
      } else {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(async () => {
  server?.close();
  await cleanupUnitEnv(unitEnv);
});

test('日志 URL 脱敏：敏感 query 参数值替换为 [redacted]，保留 origin+path 与非敏感参数', () => {
  // 常见第三方接口凭据写法：token / api_key / key / authorization 等参数值不得落库
  assert.equal(
    appRules.redactUrlForLog('https://x.example/api?token=SECRET&a=1'),
    'https://x.example/api?token=[redacted]&a=1',
  );
  assert.equal(
    appRules.redactUrlForLog('https://x.example/api?api_key=SECRET&token=T&a=1'),
    'https://x.example/api?api_key=[redacted]&token=[redacted]&a=1',
  );
  assert.equal(
    appRules.redactUrlForLog('https://x.example/api?key=SECRET&authorization=Bearer%20X&page=2'),
    'https://x.example/api?key=[redacted]&authorization=[redacted]&page=2',
  );
  // 非敏感参数（含 keyword 这类包含 key 字样的参数名）保留原值
  assert.equal(
    appRules.redactUrlForLog('https://x.example/api?keyword=weather&city=%E5%8C%97%E4%BA%AC'),
    'https://x.example/api?keyword=weather&city=%E5%8C%97%E4%BA%AC',
  );
  // userinfo 仍按原逻辑脱敏，且 query 一并脱敏
  const userinfo = appRules.redactUrlForLog('https://user:pass@x.example/api?token=SECRET');
  assert.ok(!userinfo.includes('user:pass'), 'userinfo 不应出现在日志 URL 中');
  assert.ok(userinfo.includes('token=[redacted]'), 'query token 应脱敏');
  // 无 query 原样返回
  assert.equal(appRules.redactUrlForLog('https://x.example/api'), 'https://x.example/api');
  assert.equal(appRules.redactUrlForLog(''), '');
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

test('extractParams：none / multi 组合提取 + 内置变量', () => {
  const none = appRules.extractParams(
    baseRule({ extraction: { mode: 'none', config: {} } }),
    { text: '查天气 北京', userId: 'u1', displayName: '张三', now: 456 },
  );
  assert.deepEqual(none.params, {});
  assert.equal(none.missing, false, '不提取模式不应视为缺参');
  assert.equal(none.vars.text, '查天气 北京');
  assert.equal(none.vars.userId, 'u1');
  assert.equal(none.vars.name, '张三');
  assert.equal(none.vars.now, '456');

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

  // 独占一行的块标签不应把模板换行带进消息（否则列表项之间会多出空行）
  const blockLineTemplate =
    '{{#if items}}\n【未归寝】共 {{count items}} 人\n{{#each items}}\n{{@number}}. {{name}}\n{{/each}}\n{{else}}\n{{noreply}}\n{{/if}}';
  assert.equal(
    appRules.renderReplyTemplate(blockLineTemplate, { root: { items: [{ name: '甲' }, { name: '乙' }] } }),
    '【未归寝】共 2 人\n1. 甲\n2. 乙\n',
  );
  assert.equal(
    appRules.renderReplyTemplate(blockLineTemplate, { root: { items: [] } }),
    '\u0000clawbridge-noreply\u0000\n',
  );

  // escape：显式转义用户可控字段；未使用 escape 的变量保持原样
  assert.equal(
    appRules.renderReplyTemplate('{{escape name}}', { root: { name: '*张三*_x_[a]<b>|c~d' } }),
    '\\*张三\\*\\_x\\_\\[a\\]\\<b\\>\\|c\\~d',
  );
  assert.equal(appRules.renderReplyTemplate('{{escape name}}', { root: { name: '# 标题' } }), '\\# 标题');
  assert.equal(
    appRules.renderReplyTemplate('{{escape note}}', { root: { note: '第一行\n第二行' } }),
    '第一行 第二行',
  );
  assert.equal(appRules.renderReplyTemplate('{{name}}', { root: { name: '*张三*' } }), '*张三*');

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

test('模板条件判断（if/else if/else/unless、比较、真值）与 default 兜底', () => {
  const root = {
    data: {
      total: 39,
      status: 'returned',
      items: [
        { name: '张三', returned: true },
        { name: '李四', returned: false },
      ],
      emptyItems: [],
      student: { name: '', className: '智科' },
      reason: '不在范围 and 不允许打卡',
    },
  };
  const render = (template) => appRules.renderReplyTemplate(template, { root });

  assert.equal(render('{{#if data.status=returned}}已归寝{{else}}未归寝{{/if}}'), '已归寝');
  assert.equal(render('{{#if data.status != returned}}未归寝{{else}}已归寝{{/if}}'), '已归寝');
  assert.equal(render('{{#if data.status="returned"}}已归寝{{/if}}'), '已归寝');
  assert.equal(render('{{#if data.items}}有数据{{else}}无数据{{/if}}'), '有数据');
  assert.equal(render('{{#if data.emptyItems}}有数据{{else}}无数据{{/if}}'), '无数据');
  assert.equal(render('{{#if count data.emptyItems>0}}有{{else}}无{{/if}}'), '无');
  assert.equal(
    render('{{#if data.total>100}}多{{else if data.total>=39}}正常{{else}}少{{/if}}'),
    '正常',
  );
  assert.equal(render('{{#if data.total<39}}少{{else}}不少{{/if}}'), '不少');
  assert.equal(render('{{#unless data.emptyItems}}空数组{{/unless}}'), '空数组');
  assert.equal(
    render('{{#each data.items}}{{#if returned=true}}{{name}}已归寝；{{else}}{{name}}未归寝；{{/if}}{{/each}}'),
    '张三已归寝；李四未归寝；',
  );
  assert.equal(render('{{#each data.emptyItems}}有数据{{else}}暂无数据{{/each}}'), '暂无数据');
  assert.equal(
    render('{{#each data.items where returned=true}}{{name}}{{else}}无匹配{{/each}}'),
    '张三',
  );
  assert.equal(render('{{#if data.total>0 and data.status=returned}}正常{{else}}异常{{/if}}'), '正常');
  assert.equal(render('{{#if data.status=absent or data.total=39}}正常{{/if}}'), '正常');
  assert.equal(render('{{#if not data.emptyItems}}非空{{else}}空{{/if}}'), '非空');
  assert.equal(
    render('{{#if data.status=returned and not data.emptyItems}}组合条件成立{{/if}}'),
    '组合条件成立',
  );
  assert.equal(
    render('{{#if data.reason="不在范围 and 不允许打卡"}}原文匹配{{/if}}'),
    '原文匹配',
    '引号内的 and 不应被拆成逻辑条件',
  );
  assert.equal(render('{{default data.student.name "未知姓名"}}'), '未知姓名');
  assert.equal(render('{{default data.student.className "未知班级"}}'), '智科');
  assert.equal(render('{{default data.total "无"}}'), '39');
  assert.equal(render('{{default data.emptyItems "暂无"}}'), '暂无');
  assert.equal(render('{{default data.student "缺失"}}'), '{"name":"","className":"智科"}');
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

  const preview = appRules.previewReplyTemplate({
    responseType: 'json',
    responsePath: 'data',
    template: '{{#if total>0}}共 {{total}} 人{{else}}暂无数据{{/if}}',
    fallbackText: '兜底',
    rawText: '{"data":{"total":39}}',
  });
  assert.equal(preview.responseText, '{"total":39}');
  assert.equal(preview.replyText, '共 39 人');
  assert.equal(preview.usedFallback, false);
  assert.equal(
    appRules.previewReplyTemplate({ responseType: 'json', rawText: '{"data":{}}', template: '{{#if data.x}}有{{/if}}', fallbackText: '兜底' }).replyText,
    '兜底',
  );

  const noreplyTemplate = '{{#if data.x}}有数据{{else}}{{noreply}}{{/if}}';
  const noreplyPreview = appRules.previewReplyTemplate({
    responseType: 'json',
    rawText: '{"data":{}}',
    template: noreplyTemplate,
    fallbackText: '兜底',
  });
  assert.equal(noreplyPreview.noreply, true, '模板输出 {{noreply}} 应标记为不回复');
  assert.equal(noreplyPreview.replyText, '', '不回复时不应使用兜底文案');
  assert.equal(noreplyPreview.usedFallback, false);
  const normalPreview = appRules.previewReplyTemplate({
    responseType: 'json',
    rawText: '{"data":{"x":1}}',
    template: noreplyTemplate,
    fallbackText: '兜底',
  });
  assert.equal(normalPreview.noreply, false);
  assert.equal(normalPreview.replyText, '有数据');

  const arrayPath = appRules.parseResponse({ responseType: 'json', responsePath: 'data.0.answer', rawText: '{"data":[{"answer":"第一"}]}' });
  assert.equal(arrayPath.responseText, '第一');

  // 配置了 response_path 但外层结构不匹配：模板根为空，不回退完整响应根（避免空数据误发）
  const outerEnvelope = JSON.stringify({ ok: true, data: { code: 0, msg: 'ok', data: { total: 0, items: [] } } });
  const pathMiss = appRules.parseResponse({ responseType: 'json', responsePath: 'data.items', rawText: outerEnvelope });
  assert.equal(pathMiss.pathMatched, false);
  assert.equal(pathMiss.templateRoot, undefined);
  const pathMissPreview = appRules.previewReplyTemplate({
    responseType: 'json',
    responsePath: 'data.items',
    template: '{{#if .}}有数据{{else}}{{noreply}}{{/if}}',
    fallbackText: '兜底',
    rawText: outerEnvelope,
  });
  assert.equal(pathMissPreview.noreply, true, '路径未命中时不应回退完整响应根而误发空通知');
  assert.equal(pathMissPreview.replyText, '');
});

test('shared/http-execute：按用户模式数组根保留数组语义（空数组 noreply，非空可取 userName）', async () => {
  const { buildResponseResult } = await import('../../server/src/shared/http-execute.js');
  const response = {
    type: 'json',
    path: 'data.items',
    template: '{{#if .}}有数据{{else}}{{noreply}}{{/if}}',
    fallbackText: '兜底',
  };
  const empty = buildResponseResult({
    fetched: { status: 200, text: '{"data":{"items":[]}}' },
    response,
    templateExtras: { userId: 'u1', userName: '张三' },
  });
  assert.equal(empty.noreply, true, '按用户模式空数组根应触发 noreply，而不是被扩展成对象后误发');
  assert.equal(empty.replyText, '');

  const one = buildResponseResult({
    fetched: { status: 200, text: '{"data":{"items":[{"name":"甲"}]}}' },
    response: { ...response, template: '{{#each .}}{{name}}-{{userName}};{{/each}}' },
    templateExtras: { userId: 'u1', userName: '李四' },
  });
  assert.equal(one.noreply, false);
  assert.equal(one.replyText, '甲-李四;', '数组附加按用户字段后可正常取 userName');
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
  await assert.rejects(
    appRules.requestExternal({ url: `http://127.0.0.1:${port}/redirect-cross`, timeoutMs: 2000 }),
    /跨源重定向/,
    '跨源重定向必须拒绝，避免请求头凭据被转发',
  );

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
  await assert.rejects(
    appRules.requestExternal({ url: `http://127.0.0.1:${port}/big-chunked`, maxResponseBytes: 1024 }),
    /大小上限/,
    '无 Content-Length 的 chunked 响应也必须在流式读取时截断',
  );
  await assert.rejects(
    appRules.requestExternal({ url: `http://127.0.0.1:${port}/slow-body`, timeoutMs: 300 }),
    (err) => /aborted|abort/i.test(String(err?.name ?? err?.message ?? err)),
    '超时必须在 body 读取阶段仍然生效',
  );
  await assert.rejects(appRules.requestExternal({ url: `http://127.0.0.1:${port}/binary` }), /响应类型/);
  await assert.rejects(appRules.requestExternal({ url: 'http://10.0.0.1/x' }), /SSRF/);
});

test('executeRuleHttp：成功渲染回复；失败 fallback；缺参 fallback；不写日志', async () => {
  const rule = baseRule({
    request: { method: 'GET', url: `http://127.0.0.1:${port}/weather?city={arg}`, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: 'data', template: '天气：{{answer}}', fallbackText: '兜底' },
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

test('executeRuleHttp：不请求模式直接渲染默认文本，不发 HTTP', async () => {
  const requestsBefore = requests.length;
  const rule = baseRule({
    extraction: { mode: 'multi', config: { extractors: [{ type: 'trailing', param: 'arg' }] } },
    request: { mode: 'none', method: 'GET', url: '', headers: {}, bodyTemplate: '' },
    response: { type: 'text', path: '', template: '收到，我们会尽快处理。', fallbackText: '兜底' },
  });
  const result = await appRules.executeRuleHttp(rule, { text: '关键词 内容', userId: 'u1', displayName: '张三' });
  assert.equal(result.error, '');
  assert.equal(result.httpStatus, null);
  assert.equal(result.latencyMs, 0);
  assert.equal(result.requestUrl, '');
  assert.equal(result.replyText, '收到，我们会尽快处理。');
  assert.deepEqual(result.params, {});
  assert.equal(requests.length, requestsBefore, '不请求规则不应访问外部接口');
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
    extractionMode: 'multi',
    extractionConfig: { extractors: [{ type: 'trailing', param: 'arg' }] },
    requestMethod: 'GET',
    requestUrl: `http://127.0.0.1:${port}/weather?city={arg}`,
    requestHeadersEnc: null,
    requestBodyTemplate: '',
    responseType: 'json',
    responsePath: 'data',
    replyTemplate: '{{answer}}',
    fallbackText: '',
    timeoutMs: 2000,
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
test('模板根=JSON 路径选中节点：相对引用、旧全路径回退、多层嵌套循环', () => {
  const rawText = JSON.stringify({
    datas: {
      cqztbg: {
        pageSize: 10,
        rows: [
          { XM: '张三', FJH: '101', CQZT: '1' },
          { XM: '李四', FJH: '102', CQZT: '2' },
          { XM: '王五', FJH: '103', CQZT: '2' },
        ],
      },
    },
  });
  const parsed = appRules.parseResponse({ responseType: 'json', responsePath: 'datas.cqztbg.rows', rawText });
  assert.ok(Array.isArray(parsed.templateRoot), '路径命中后模板根应为选中数组');
  assert.deepEqual(parsed.templateRoot, parsed.value);

  const relative = appRules.renderReplyTemplate(
    '共 {{count . where CQZT=2}} 人；{{#each . where CQZT=2}}{{@number}}.{{XM}}（{{FJH}}）；{{/each}}',
    { root: parsed.templateRoot, responseRoot: parsed.root },
  );
  assert.equal(relative, '共 2 人；1.李四（102）；2.王五（103）；');

  // 选中节点为 rows 时，可通过 @responseRoot 访问兄弟字段
  assert.equal(
    appRules.renderReplyTemplate('pageSize={{@responseRoot.datas.cqztbg.pageSize}}；rows={{count .}}', {
      root: parsed.templateRoot,
      responseRoot: parsed.root,
    }),
    'pageSize=10；rows=3',
  );

  // 已移除旧版本兼容：非相对路径不再回退到完整响应根
  assert.equal(
    appRules.renderReplyTemplate('{{count datas.cqztbg.rows where CQZT=1}}', {
      root: parsed.templateRoot,
      responseRoot: parsed.root,
    }),
    '0',
  );

  const nestedRoot = {
    groups: [
      { name: 'A', members: [{ name: 'a1' }, { name: 'a2' }] },
      { name: 'B', members: [{ name: 'b1' }] },
    ],
  };
  const nestedTemplate =
    '{{#each groups}}{{name}}:{{#each members}}{{../name}}-{{name}}#{{@number}}/{{../@index}};{{/each}}|{{/each}}';
  assert.equal(
    appRules.renderReplyTemplate(nestedTemplate, { root: nestedRoot }),
    'A:A-a1#1/0;A-a2#2/0;|B:B-b1#1/1;|',
  );
  assert.equal(
    appRules.renderReplyTemplate('{{#each groups}}{{#each members}}{{@root.groups.0.name}}/{{../name}}/{{name}};{{/each}}{{/each}}', { root: nestedRoot }),
    'A/A/a1;A/A/a2;A/B/b1;',
  );
});

// ---------------------------------------------------------------------------
// SSRF DNS rebinding（校验时解析 → 连接时二次解析）修复验证
//
// 修复方式：validateTargetUrl 返回校验通过的 IP 列表，requestExternal 每跳把该 IP
// 通过 lookup 固定到 node:http/https 连接层；连接层不会再自行解析 DNS。
// ---------------------------------------------------------------------------

test('SSRF DNS rebinding：连接层 lookup 只返回校验过的 IP，校验后不再解析 DNS', async () => {
  // 攻击者 DNS：第一次解析返回公网 IP（通过校验），若之后再次解析则返回 127.0.0.1（rebinding）
  const answers = [
    [{ address: '93.184.216.34', family: 4 }],
    [{ address: '127.0.0.1', family: 4 }],
  ];
  let dnsCalls = 0;
  const dnsLookup = async () => {
    const answer = answers[Math.min(dnsCalls, answers.length - 1)];
    dnsCalls += 1;
    return answer;
  };
  const lookupResults = [];
  let transportCalls = 0;
  const httpRequest = async (options) => {
    transportCalls += 1;
    assert.equal(options.hostname, 'rebind.example');
    // 连接层被要求解析域名时，必须拿回校验过的公网 IP，而不是 rebinding 后的 127.0.0.1
    assert.equal(options.address, '93.184.216.34');
    assert.equal(options.family, 4);
    const viaAll = await new Promise((resolve, reject) => {
      options.lookup(options.hostname, { all: true }, (err, list) => (err ? reject(err) : resolve(list)));
    });
    const viaSingle = await new Promise((resolve, reject) => {
      options.lookup(options.hostname, {}, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
    });
    assert.deepEqual(viaAll, [{ address: '93.184.216.34', family: 4 }], 'lookup(all) 只能返回已校验 IP');
    assert.deepEqual(viaSingle, { address: '93.184.216.34', family: 4 }, 'lookup(single) 只能返回已校验 IP');
    lookupResults.push(viaAll[0].address, viaSingle.address);
    // 固定到公网 IP 后连接失败（模拟目标不可达）：绝不能因为“再解析一次”而落到内网
    throw Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:9'), { code: 'ECONNREFUSED' });
  };

  await assert.rejects(
    appRules.requestExternal({
      url: 'http://rebind.example:9/api',
      timeoutMs: 1000,
      allowedHosts: [],
      dnsLookup,
      httpRequest,
    }),
    /ECONNREFUSED/,
  );
  assert.equal(dnsCalls, 1, 'DNS 只允许在校验阶段解析一次，连接层不得二次解析');
  assert.equal(transportCalls, 1);
  assert.deepEqual(lookupResults, ['93.184.216.34', '93.184.216.34']);
});

test('SSRF：重定向每跳重新校验 DNS 并重新固定 IP（http→https 升级后的 rebinding 拒绝）', async () => {
  let dnsCalls = 0;
  const dnsLookup = async () => {
    dnsCalls += 1;
    // 第一跳解析到公网 → 通过；重定向后第二跳被 rebinding 为云元数据地址 → 必须拒绝
    return dnsCalls === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '169.254.169.254', family: 4 }];
  };
  const transportCalls = [];
  const httpRequest = async (options) => {
    transportCalls.push(options);
    assert.equal(options.address, '93.184.216.34');
    // 同主机 http→https 升级属于允许的重定向
    return new Response(null, { status: 302, headers: { location: 'https://rebind.example/steal' } });
  };

  await assert.rejects(
    appRules.requestExternal({
      url: 'http://rebind.example/start',
      timeoutMs: 1000,
      allowedHosts: [],
      dnsLookup,
      httpRequest,
    }),
    /SSRF/,
    '重定向后的目标被解析到私网/保留网段时必须拒绝',
  );
  assert.equal(dnsCalls, 2, '重定向后必须重新解析并校验 DNS');
  assert.equal(transportCalls.length, 1, '第二跳校验失败后不得建立连接（不得连内网）');
});

test('SSRF：重定向 Location 指向私网必须拒绝', async () => {
  const before = requests.length;
  await assert.rejects(
    appRules.requestExternal({ url: `http://127.0.0.1:${port}/redirect-private`, timeoutMs: 2000 }),
    /跨源重定向/,
    '重定向 Location 指向私网/跨源地址必须拒绝',
  );
  assert.equal(requests.length, before + 1, '只允许发出第一跳请求，不得连接重定向目标');
  await assert.rejects(appRules.requestExternal({ url: 'http://169.254.169.254/latest/meta-data' }), /SSRF/);
});

test('requestExternal：正常 mock HTTP 服务器链路成功（域名经固定 lookup 连接，不依赖系统 DNS）', async () => {
  const before = requests.length;
  // 系统 DNS 无法解析 rebind.internal：只有连接层真正使用校验过的固定 IP 才能成功建连。
  const url = `http://rebind.internal:${port}/weather?city=shanghai`;
  const result = await appRules.requestExternal({
    url,
    timeoutMs: 2000,
    allowedHosts: ['rebind.internal'],
    dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  assert.equal(result.status, 200);
  assert.match(result.text, /今天晴/);
  assert.equal(result.finalUrl, url);
  assert.equal(typeof result.latencyMs, 'number');
  assert.ok(result.latencyMs >= 0);
  assert.equal(String(result.headers['content-type']), 'application/json');

  const sent = requests[before];
  assert.equal(sent.method, 'GET');
  assert.equal(sent.query.city, 'shanghai');
  // Host 头必须对应 URL 域名+端口（而非固定后的 IP），否则虚拟主机/证书语义会被破坏
  assert.equal(sent.headers.host, `rebind.internal:${port}`, 'Host 头应保留 URL 主机名与端口');
});

test('requestExternal：gzip 响应自动解压（与 fetch 行为一致）', async () => {
  const result = await appRules.requestExternal({ url: `http://127.0.0.1:${port}/gzip`, timeoutMs: 2000 });
  assert.equal(result.status, 200);
  assert.match(result.text, /压缩响应/);
});

test('configureDependencies/resetDependencies：HTTP 传输与 DNS 均可注入（默认 node:http/https）', async () => {
  const received = [];
  appRules.configureDependencies({
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    httpRequest: async (options) => {
      received.push(options);
      return new Response('injected-ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    },
  });
  try {
    const result = await appRules.requestExternal({ url: 'http://api.example.test/x', allowedHosts: [] });
    assert.equal(result.status, 200);
    assert.equal(result.text, 'injected-ok');
    assert.equal(received.length, 1);
    assert.equal(received[0].address, '93.184.216.34');
  } finally {
    appRules.resetDependencies();
  }
});

// ---------------------------------------------------------------------------
// 模板输出上限、shared 通用执行管线
// ---------------------------------------------------------------------------

test('renderReplyTemplate：输出达到 maxTextLength 后停止 {{#each}} 迭代', async () => {
  const { config } = await import('../../server/src/config.js');
  let reads = 0;
  const items = Array.from({ length: 5000 }, (_, index) => ({
    get value() {
      reads += 1;
      return `item-${index}`;
    },
  }));
  const rendered = appRules.renderReplyTemplate('{{#each .}}[{{value}}]{{/each}}', { root: items });
  assert.equal(rendered.length, config.push.maxTextLength, '输出应截断到 maxTextLength');
  assert.ok(reads < items.length, `达到上限后应停止迭代（实际读取 ${reads}/${items.length}）`);

  // 未超限的小模板行为不变（完整渲染）
  assert.equal(
    appRules.renderReplyTemplate('{{#each .}}{{value}};{{/each}}', { root: [{ value: 'a' }, { value: 'b' }] }),
    'a;b;',
  );
});

test('shared/http-execute：renderHttpRequest + executeHttpRequest 通用管线', async () => {
  const { executeHttpRequest, renderHttpRequest } = await import('../../server/src/shared/http-execute.js');
  const prepared = renderHttpRequest(
    { method: 'POST', url: 'https://api.example.test/x?q={arg}', headers: { 'X-Arg': '{arg}' }, bodyTemplate: '{"v":"{arg}"}' },
    { arg: '北京' },
  );
  assert.equal(prepared.method, 'POST');
  assert.equal(prepared.url, 'https://api.example.test/x?q=%E5%8C%97%E4%BA%AC');
  assert.equal(prepared.headers['X-Arg'], '北京');
  assert.equal(prepared.body, '{"v":"北京"}');
  assert.deepEqual(prepared.headerNames, ['X-Arg']);

  let received = null;
  const outcome = await executeHttpRequest({
    request: prepared,
    response: { type: 'json', path: 'data', template: '{{answer}}', fallbackText: '兜底' },
    timeoutMs: 1000,
    maxResponseBytes: 1024,
    allowedHosts: [],
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    httpRequest: async (options) => {
      received = options;
      return new Response(JSON.stringify({ data: { answer: 'ok' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(received.method, 'POST');
  assert.equal(received.address, '93.184.216.34');
  assert.equal(outcome.status, 200);
  assert.equal(outcome.replyText, 'ok');
  assert.equal(outcome.error, '');
  assert.deepEqual(outcome.parsed.value, { answer: 'ok' });

  // 非 2xx：以 error + fallback 返回（不抛错），两种调用方共用同一语义
  const failed = await executeHttpRequest({
    request: prepared,
    response: { type: 'json', path: 'data', template: '{{answer}}', fallbackText: '兜底' },
    allowedHosts: [],
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    httpRequest: async () => new Response(null, { status: 500, headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(failed.status, 500);
  assert.equal(failed.error, 'HTTP 500');
  assert.equal(failed.replyText, '兜底');
});
test('executeRuleHttp：{{noreply}} 不请求模式下不回复且不使用兜底', async () => {
  const rule = {
    request: { mode: 'none', url: '', headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: '', template: '{{#if data.x}}有{{else}}{{noreply}}{{/if}}', fallbackText: '兜底' },
  };
  const result = await appRules.executeRuleHttp(rule, { text: 'x' });
  assert.equal(result.noreply, true);
  assert.equal(result.replyText, '');
  assert.equal(result.error, '');
  const replyRule = {
    request: { mode: 'none', url: '', headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: '', template: '固定回复', fallbackText: '兜底' },
  };
  const normal = await appRules.executeRuleHttp(replyRule, { text: 'x' });
  assert.equal(normal.noreply, false);
  assert.equal(normal.replyText, '固定回复');
});