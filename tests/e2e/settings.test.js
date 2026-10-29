/**
 * e2e：运行配置（后台可改设置；docs/SETTINGS.md §2/§3/§6）。
 *
 * 覆盖：
 *  - GET /api/admin/settings：分组/字段元数据（value/default/min/max/restartRequired）、envOnly 脱敏；
 *  - PATCH 修改 keepalive.text / appRules.allowedHosts / media.maxBytes / scheduler.timezone / push.rateLimitMax
 *    → 再读生效 + 运行时行为验证（media 上传上限即时生效；allowedHosts 放行 127.0.0.1 后 SSRF dry-run 可达本地 mock）；
 *  - 非法值 400（未知 group/field、越界、非法 timezone、非法 hosts、boolean 传字符串），且失败不落库；
 *  - reset 恢复 env 默认（含 appRules.allowedHosts 恢复默认拒绝私网的行为验证）；
 *  - 未登录 401 / 缺 CSRF 403；restartRequired 字段语义。
 *
 * 所有外部接口为本进程 127.0.0.1 mock，不触真实外网。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  APP_SECRET,
  startE2E,
  startMockApi,
} from '../helpers/e2e-env.mjs';

let e2e;
let externalApi;
let user1;
let initialSettings;
let initialConfig;

function groupOf(settings, key) {
  return (settings.groups ?? []).find((group) => group.key === key);
}

function fieldOf(settings, groupKey, fieldKey) {
  return groupOf(settings, groupKey)?.fields?.find((field) => field.key === fieldKey);
}

function envOnlyKeys(settings) {
  return (settings.envOnly ?? []).map((item) => (typeof item === 'string' ? item : item.key));
}

async function getSettingsJson() {
  const res = await e2e.getSettings();
  assert.equal(res.status, 200, `GET /api/admin/settings 失败：${res.status} ${res.text}`);
  return res.json;
}

function appRuleBody(ruleName, url, userId, keyword) {
  return {
    name: ruleName,
    enabled: true,
    priority: 100,
    scope: { type: 'users', ids: [userId] },
    matchMode: 'contains',
    keywords: [keyword],
    regexPattern: '',
    extraction: { mode: 'trailing', config: { arg: 'arg' } },
    request: { method: 'GET', url, headers: {}, bodyTemplate: '' },
    response: { type: 'json', path: '', template: '{{data.answer}}', fallbackText: '' },
    timeoutMs: 3000,
    cooldownMs: 0,
    maxCallsPerHour: 100,
    maxUserCallsPerHour: 100,
  };
}

before(async () => {
  e2e = await startE2E();
  externalApi = await startMockApi();
  await e2e.ensureAdmin();
  const bound = await e2e.bindUser({ displayName: '设置用户1', waitMonitor: true });
  user1 = bound.user;
  initialSettings = await getSettingsJson();
  const config = await e2e.getConfig();
  initialConfig = config.json;
  externalApi.setResponse({ json: { data: { answer: 'SETTINGS-OK' } } });
});

after(async () => {
  await externalApi?.close().catch(() => {});
  await e2e?.cleanup();
});

test('GET settings：分组/字段元数据完整，envOnly 仅基础设施项且脱敏（第二批）', async () => {
  const settings = await getSettingsJson();
  assert.ok(Array.isArray(settings.groups), 'groups 应为数组');
  const groupKeys = settings.groups.map((group) => group.key);
  for (const key of ['push', 'keepalive', 'appRules', 'scheduler', 'media', 'binding']) {
    assert.ok(groupKeys.includes(key), `groups 应包含 ${key}，实际 ${JSON.stringify(groupKeys)}`);
  }
  for (const group of settings.groups) {
    assert.equal(typeof group.key, 'string');
    assert.equal(typeof group.label, 'string');
    assert.ok(Array.isArray(group.fields) && group.fields.length > 0, `分组 ${group.key} 字段不应为空`);
    for (const field of group.fields) {
      assert.equal(typeof field.key, 'string', `字段 key 类型：${JSON.stringify(field)}`);
      assert.equal(typeof field.label, 'string');
      assert.equal(typeof field.type, 'string');
      assert.ok('value' in field, `字段 ${group.key}.${field.key} 应含 value`);
      assert.ok('default' in field, `字段 ${group.key}.${field.key} 应含 default`);
      assert.ok('restartRequired' in field, `字段 ${group.key}.${field.key} 应含 restartRequired`);
      assert.equal(typeof field.restartRequired, 'boolean');
      assert.ok('min' in field || field.min === undefined, `字段 ${group.key}.${field.key} 应含 min`);
      assert.ok('max' in field || field.max === undefined, `字段 ${group.key}.${field.key} 应含 max`);
    }
  }

  // 关键字段默认值/类型
  const rateLimitMax = fieldOf(settings, 'push', 'rateLimitMax');
  assert.ok(rateLimitMax, '应存在 push.rateLimitMax');
  assert.equal(rateLimitMax.type, 'number');
  assert.equal(rateLimitMax.value, 100, `push.rateLimitMax 初始值应为 env 的 100：${JSON.stringify(rateLimitMax)}`);
  assert.equal(rateLimitMax.default, 100);

  const keepaliveText = fieldOf(settings, 'keepalive', 'text');
  assert.ok(keepaliveText, '应存在 keepalive.text');
  assert.equal(keepaliveText.type, 'string');
  assert.ok(String(keepaliveText.value).includes('保活'), `keepalive.text 初始应含默认文案：${keepaliveText.value}`);
  assert.equal(fieldOf(settings, 'keepalive', 'windowMs').default, 86400000);

  const allowedHosts = fieldOf(settings, 'appRules', 'allowedHosts');
  assert.ok(allowedHosts, '应存在 appRules.allowedHosts');
  assert.ok(Array.isArray(allowedHosts.value), `allowedHosts value 应为数组：${JSON.stringify(allowedHosts.value)}`);
  assert.deepEqual(allowedHosts.value.sort(), ['127.0.0.1', 'localhost'].sort());

  assert.equal(fieldOf(settings, 'scheduler', 'timezone').value, 'Asia/Shanghai');
  assert.equal(fieldOf(settings, 'media', 'maxBytes').default, 26214400);
  assert.equal(fieldOf(settings, 'media', 'maxBytes').value, 26214400);

  // envOnly（docs/SETTINGS.md §7.1 第二批）：收缩为基础设施项；机密改为后台「安全」管理，
  // 由顶层 security 摘要（来源/预览）替代，不再出现在 envOnly。
  assert.ok(Array.isArray(settings.envOnly) && settings.envOnly.length > 0, 'envOnly 应为非空数组');
  const keys = envOnlyKeys(settings);
  for (const key of ['APP_SECRET', 'DATA_DIR', 'MEDIA_DIR', 'PORT', 'HOST', 'NODE_ENV']) {
    assert.ok(keys.includes(key), `envOnly 应包含 §7.1 项 ${key}，实际 ${JSON.stringify(keys)}`);
  }
  assert.ok(keys.length >= 5 && keys.length <= 6, `envOnly 应只剩 5~6 项基础设施，实际 ${JSON.stringify(keys)}`);
  for (const key of ['ADMIN_PASSWORD', 'API_TOKEN', 'LOG_LEVEL', 'COOKIE_SECURE', 'TRUST_PROXY']) {
    assert.equal(keys.includes(key), false, `envOnly 不应再包含可后台修改/机密项 ${key}`);
  }
  const settingsText = JSON.stringify(settings);
  // 机密不再由 env 提供：管理密码/API Token 首启自动生成（明文在 e2e.adminPassword/apiToken）
  for (const secret of [e2e.adminPassword, e2e.apiToken, APP_SECRET]) {
    assert.equal(settingsText.includes(secret), false, 'settings 响应不应包含任何明文机密');
  }
  // envOnly 项若有 value 字段，必须非明文（脱敏/隐藏/空）
  const rawSecrets = { ADMIN_PASSWORD: e2e.adminPassword, API_TOKEN: e2e.apiToken, APP_SECRET };
  for (const item of settings.envOnly) {
    if (typeof item === 'object' && 'value' in item) {
      const raw = rawSecrets[item.key];
      if (raw !== undefined) {
        assert.notEqual(item.value, raw, `envOnly.${item.key} 不应返回明文值`);
      }
      assert.equal(settingsText.includes(String(item.value)) && String(item.value) === raw, false);
    }
  }
  // security 摘要（§8）：来源恒为 db（首启自动生成并持久化），不返回明文/哈希
  if (settings.security) {
    for (const key of ['adminPasswordSource', 'apiTokenSource', 'apiTokenPreview', 'pushApiEnabled']) {
      assert.ok(key in settings.security, `security 摘要应包含 ${key}`);
    }
    assert.equal(settings.security.adminPasswordSource, 'db', '管理密码来源应恒为 db');
    assert.equal(settings.security.apiTokenSource, 'db', 'API Token 来源应恒为 db');
    assert.equal(JSON.stringify(settings.security).includes(e2e.adminPassword), false, 'security 摘要不应回显密码明文');
    assert.equal(JSON.stringify(settings.security).includes(e2e.apiToken), false, 'security 摘要不应回显 token 明文');
  }
});

test('PATCH 修改多字段：再读生效；config 即时生效；media.maxBytes 行为验证', async () => {
  const patch = {
    keepalive: { text: '【E2E-SETTINGS】{name} 请回复任意内容' },
    appRules: { allowedHosts: '127.0.0.1,localhost' },
    media: { maxBytes: 1024 },
    scheduler: { timezone: 'UTC' },
    push: { rateLimitMax: 50 },
  };
  const res = await e2e.updateSettings(patch);
  assert.equal(res.status, 200, `PATCH settings 应 200：${res.status} ${res.text}`);
  assert.equal(res.json.ok, true);
  assert.ok(Array.isArray(res.json.restartRequired), 'PATCH 响应应含 restartRequired 数组');
  for (const key of res.json.restartRequired) assert.equal(typeof key, 'string');

  const settings = await getSettingsJson();
  assert.equal(fieldOf(settings, 'keepalive', 'text').value, patch.keepalive.text);
  const hosts = fieldOf(settings, 'appRules', 'allowedHosts').value;
  assert.ok(Array.isArray(hosts) && hosts.includes('127.0.0.1'), `逗号分隔字符串应被解析为数组：${JSON.stringify(hosts)}`);
  assert.equal(fieldOf(settings, 'media', 'maxBytes').value, 1024);
  assert.equal(fieldOf(settings, 'scheduler', 'timezone').value, 'UTC');
  assert.equal(fieldOf(settings, 'push', 'rateLimitMax').value, 50);

  // 运行时 config 即时生效（settings 已覆盖内存 config）
  const config = await e2e.getConfig();
  assert.equal(config.status, 200);
  if (config.json.keepalive) assert.equal(config.json.keepalive.text, patch.keepalive.text, 'config.keepalive.text 应即时生效');
  if (config.json.scheduler) assert.equal(config.json.scheduler.timezone, 'UTC', 'config.scheduler.timezone 应即时生效');
  if (config.json.media) assert.equal(config.json.media.maxBytes, 1024, 'config.media.maxBytes 应即时生效');
  if (config.json.push) assert.equal(config.json.push.rateLimitMax, 50, 'config.push.rateLimitMax 应即时生效');

  // 行为验证：上传 2048 字节 > 新上限 1024 → 413
  const tooLarge = await e2e.uploadAdminMedia(Buffer.alloc(2048, 0x61), {
    fileName: 'settings-limit.bin',
    mime: 'application/octet-stream',
  });
  assert.equal(tooLarge.status, 413, `超过 media.maxBytes 应 413：${tooLarge.status} ${tooLarge.text}`);

  // 恢复 media 默认后，同样大小可上传成功（行为即时恢复）
  const resetMedia = await e2e.resetSettingsGroup('media');
  assert.equal(resetMedia.status, 200, `reset media 应 200：${resetMedia.status} ${resetMedia.text}`);
  const okUpload = await e2e.uploadAdminMedia(Buffer.alloc(2048, 0x62), {
    fileName: 'settings-limit-ok.bin',
    mime: 'application/octet-stream',
  });
  assert.equal(okUpload.status, 201, `恢复默认后上传应 201：${okUpload.status} ${okUpload.text}`);
});

test('allowedHosts 运行行为：默认拒绝私网 → 后台放行 127.0.0.1 → SSRF 可达本地 mock → reset 后恢复拒绝', async () => {
  // 独立实例：env 默认白名单为空（默认拒绝私网/本机），再通过后台设置放行
  const ssrfE2E = await startE2E({ appEnv: { APP_RULES_ALLOWED_HOSTS: '' } });
  try {
    await ssrfE2E.ensureAdmin();
    const bound = await ssrfE2E.bindUser({ displayName: '设置SSRF用户', waitMonitor: true });
    const created = await ssrfE2E.createAppRule(
      appRuleBody('设置 SSRF 规则', `${externalApi.baseUrl}/settings-ssrf`, bound.user.id, '设置ssrf'),
    );
    assert.equal(created.status, 201, `创建规则应 201：${created.status} ${created.text}`);
    const ruleId = created.json.rule.id;

    externalApi.reset();
    // 1) 默认拒绝：dry-run 被 SSRF 阻止
    const blocked = await ssrfE2E.testAppRule(ruleId, { message: '设置ssrf x', userId: bound.user.id });
    assert.equal(blocked.status, 200);
    const blockedText = JSON.stringify(blocked.json);
    assert.match(blockedText, /SSRF|内网|私网|blocked|forbidden|不允许|禁止/i, `默认应阻止私网请求：${blocked.text}`);
    assert.equal(externalApi.requests.length, 0, '默认拒绝时外部 API 不应收到请求');

    // 2) 后台放行 127.0.0.1 → dry-run 成功访问本地 mock
    const allowed = await ssrfE2E.updateSettings({ appRules: { allowedHosts: ['127.0.0.1'] } });
    assert.equal(allowed.status, 200, `后台设置 allowedHosts 应 200：${allowed.status} ${allowed.text}`);
    const settings = await ssrfE2E.getSettings();
    assert.ok(settings.json.groups.find((g) => g.key === 'appRules').fields.find((f) => f.key === 'allowedHosts').value.includes('127.0.0.1'));
    externalApi.reset();
    const reachable = await ssrfE2E.testAppRule(ruleId, { message: '设置ssrf x', userId: bound.user.id });
    assert.equal(reachable.status, 200);
    assert.equal(reachable.json.error, '', `放行后不应有 SSRF 错误：${reachable.text}`);
    assert.equal(reachable.json.httpStatus, 200, `放行后应访问到本地 mock：${reachable.text}`);
    assert.ok(String(reachable.json.responsePreview).includes('SETTINGS-OK'));
    assert.equal(externalApi.requests.length, 1, '放行后外部 API 应收到 1 个请求');

    // 3) reset 恢复 env 默认（空白名单）→ 再次拒绝
    const reset = await ssrfE2E.resetSettingsGroup('appRules');
    assert.equal(reset.status, 200, `reset appRules 应 200：${reset.status} ${reset.text}`);
    externalApi.reset();
    const blockedAgain = await ssrfE2E.testAppRule(ruleId, { message: '设置ssrf x', userId: bound.user.id });
    assert.match(
      JSON.stringify(blockedAgain.json),
      /SSRF|内网|私网|blocked|forbidden|不允许|禁止/i,
      `reset 后应恢复默认拒绝私网：${blockedAgain.text}`,
    );
    assert.equal(externalApi.requests.length, 0, 'reset 后外部 API 不应再收到请求');
  } finally {
    await ssrfE2E.cleanup();
    externalApi.setResponse({ json: { data: { answer: 'SETTINGS-OK' } } });
  }
});

test('非法值 → 400（未知 group/field、越界、非法 timezone/hosts、boolean 字符串），且不落库', async () => {
  const invalidPatches = [
    { foo: { bar: 1 } }, // 未知 group
    { push: { notAField: 1 } }, // 未知 field
    { push: { rateLimitMax: 0 } }, // 越界（<min）
    { media: { maxBytes: -1 } }, // 越界
    { scheduler: { timezone: 'Mars/Olympus' } }, // 非法 IANA
    { appRules: { allowedHosts: 'http://bad host!!' } }, // 非法 host 字符
    { keepalive: { enabled: 'true' } }, // boolean 传字符串
    { scheduler: { enabled: 'yes' } }, // boolean 传字符串
    { keepalive: { windowMs: 'abc' } }, // number 传字符串
    { push: { rateLimitMax: '1.5' } }, // number 传字符串
  ];
  for (const patch of invalidPatches) {
    const res = await e2e.updateSettings(patch);
    assert.equal(res.status, 400, `非法设置应 400（${JSON.stringify(patch)}）：${res.status} ${res.text}`);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
  }
  // 失败不落库：关键字段仍是上一步更新的值
  const settings = await getSettingsJson();
  assert.equal(fieldOf(settings, 'push', 'rateLimitMax').value, 50);
  assert.equal(fieldOf(settings, 'media', 'maxBytes').value, 26214400);

  // reset 未知分组 → 400
  const unknownGroup = await e2e.resetSettingsGroup('not_a_group');
  assert.equal(unknownGroup.status, 400, `reset 未知分组应 400：${unknownGroup.status} ${unknownGroup.text}`);
  assert.equal(unknownGroup.json.error.code, 'BAD_REQUEST');
});

test('reset 恢复 env 默认（keepalive/appRules/scheduler/push）', async () => {
  for (const group of ['keepalive', 'appRules', 'scheduler', 'push']) {
    const res = await e2e.resetSettingsGroup(group);
    assert.equal(res.status, 200, `reset ${group} 应 200：${res.status} ${res.text}`);
    assert.equal(res.json.ok, true);
    assert.ok(Array.isArray(res.json.groups), `reset ${group} 响应应含 groups`);
  }

  const settings = await getSettingsJson();
  assert.equal(fieldOf(settings, 'keepalive', 'text').value, initialSettings.groups
    .find((g) => g.key === 'keepalive').fields.find((f) => f.key === 'text').value);
  assert.equal(fieldOf(settings, 'scheduler', 'timezone').value, 'Asia/Shanghai');
  assert.equal(fieldOf(settings, 'push', 'rateLimitMax').value, 100);
  const hosts = fieldOf(settings, 'appRules', 'allowedHosts').value;
  assert.ok(Array.isArray(hosts));
  assert.ok(hosts.includes('127.0.0.1'), `reset 后应恢复 env 默认白名单：${JSON.stringify(hosts)}`);
  // media 已在上一用例 reset；再次读取确认默认值
  assert.equal(fieldOf(settings, 'media', 'maxBytes').value, 26214400);
});

test('鉴权：未登录 401、缺 CSRF 403（GET/PATCH/reset）', async () => {
  const noAuthGet = await e2e.request('GET', '/api/admin/settings');
  assert.equal(noAuthGet.status, 401, `未登录 GET settings 应 401：${noAuthGet.status} ${noAuthGet.text}`);
  const noAuthPatch = await e2e.request('PATCH', '/api/admin/settings', { body: { push: { rateLimitMax: 20 } } });
  assert.equal(noAuthPatch.status, 401, '未登录 PATCH settings 应 401');
  const noCsrfPatch = await e2e.adminRequest('PATCH', '/api/admin/settings', { body: { push: { rateLimitMax: 20 } } });
  assert.equal(noCsrfPatch.status, 403, `缺 CSRF 头 PATCH settings 应 403：${noCsrfPatch.status} ${noCsrfPatch.text}`);
  const noAuthReset = await e2e.request('POST', '/api/admin/settings/reset', { body: { group: 'push' } });
  assert.equal(noAuthReset.status, 401, '未登录 reset settings 应 401');
  const noCsrfReset = await e2e.adminRequest('POST', '/api/admin/settings/reset', { body: { group: 'push' } });
  assert.equal(noCsrfReset.status, 403, '缺 CSRF 头 reset settings 应 403');
});
