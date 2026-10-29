/**
 * 单元测试：settings.js 运行配置（docs/SETTINGS.md §2/§6）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-settings-core-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'settings-core-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'settings-core-admin-password';
process.env.API_TOKEN = 'settings-core-api-token-123456';
process.env.LOG_LEVEL = 'silent';

const settings = await import('../../server/src/settings.js');
const { config } = await import('../../server/src/config.js');
const { all, get, run, closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function defaultOf(groupKey, fieldKey) {
  const group = settings.getSettings().groups.find((item) => item.key === groupKey);
  return group.fields.find((field) => field.key === fieldKey).default;
}

test('SETTINGS_SCHEMA / getSettings：10 分组、字段元数据、envOnly 仅启动必需项且脱敏', () => {
  const view = settings.getSettings();
  assert.deepEqual(
    view.groups.map((group) => group.key),
    ['push', 'keepalive', 'appRules', 'scheduler', 'media', 'binding', 'server', 'security', 'ilink', 'monitor'],
  );
  const fieldCount = view.groups.reduce((sum, group) => sum + group.fields.length, 0);
  assert.ok(fieldCount >= 57, `字段数量应完整（实际 ${fieldCount}）`);

  const keepalive = view.groups.find((group) => group.key === 'keepalive');
  const textField = keepalive.fields.find((field) => field.key === 'text');
  assert.equal(textField.type, 'string');
  assert.equal(textField.value, config.keepalive.text);
  assert.equal(textField.default, config.keepalive.text);
  assert.equal(keepalive.fields.find((field) => field.key === 'enabled').type, 'boolean');

  const appRules = view.groups.find((group) => group.key === 'appRules');
  assert.equal(appRules.fields.find((field) => field.key === 'allowedHosts').type, 'stringArray');
  assert.equal(appRules.fields.find((field) => field.key === 'timeoutMs').min, 1000);

  const restartFields = view.groups
    .flatMap((group) => group.fields.filter((field) => field.restartRequired).map((field) => `${group.key}.${field.key}`))
    .sort();
  assert.deepEqual(restartFields, [
    'ilink.appId',
    'ilink.botAgent',
    'ilink.botType',
    'ilink.cdnBaseUrl',
    'ilink.channelVersion',
    'ilink.clientVersion',
    'ilink.defaultBaseUrl',
    'ilink.loginBaseUrl',
    'ilink.longPollTimeoutMs',
    'ilink.qrPollTimeoutMs',
    'ilink.requestTimeoutMs',
    'ilink.routeTag',
    'media.maxBytes',
    'monitor.longPollTimeoutMs',
    'monitor.maxAccounts',
    'push.apiRateLimitPerMinute',
    'push.rateLimitMax',
    'push.rateLimitWindowMs',
    'push.tickMs',
    'server.trustProxy',
  ]);

  // envOnly：仅 §7.1 的启动必需项，机密脱敏
  const envKeys = view.envOnly.map((item) => item.key);
  assert.deepEqual(envKeys, ['APP_SECRET', 'DATA_DIR', 'MEDIA_DIR', 'PORT', 'HOST', 'NODE_ENV']);
  const appSecretEntry = view.envOnly.find((item) => item.key === 'APP_SECRET');
  assert.ok(!appSecretEntry.value.includes(config.secrets.appSecret), 'APP_SECRET 不得明文返回');
  assert.equal(view.envOnly.find((item) => item.key === 'MEDIA_DIR').value, config.media.dir);

  // security 状态：不返回哈希/Token 明文
  assert.equal(typeof view.security, 'object');
  assert.ok(['db', 'env', 'auto'].includes(view.security.adminPasswordSource));
  assert.ok(['db', 'env', 'auto'].includes(view.security.apiTokenSource));
  assert.ok(!JSON.stringify(view.security).includes(config.secrets.apiToken));
  assert.ok(!JSON.stringify(view.security).includes(config.secrets.adminPassword));
});

test('updateSettings：校验 → 持久化 → config 生效 → hooks → restartRequired → events 脱敏', () => {
  const hookCalls = [];
  settings.setRuntimeHooks({
    restartKeepalive: () => hookCalls.push('keepalive'),
    restartScheduler: () => hookCalls.push('scheduler'),
    restartAppRules: () => hookCalls.push('appRules'),
  });

  const result = settings.updateSettings({
    keepalive: { enabled: false, text: '自定义保活文案 {name}' },
    appRules: { allowedHosts: '127.0.0.1, 192.168.88.10,127.0.0.1', workerConcurrency: 4 },
    scheduler: { timezone: 'UTC', maxRecipients: 50 },
    media: { maxBytes: 5 * 1024 * 1024 },
    binding: { maxActive: 80 },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.restartRequired, ['media.maxBytes']);
  assert.deepEqual(hookCalls.sort(), ['appRules', 'keepalive', 'scheduler']);

  // config 立即生效
  assert.equal(config.keepalive.enabled, false);
  assert.equal(config.keepalive.text, '自定义保活文案 {name}');
  assert.deepEqual(config.appRules.allowedHosts, ['127.0.0.1', '192.168.88.10']);
  assert.equal(config.appRules.workerConcurrency, 4);
  assert.equal(config.scheduler.timezone, 'UTC');
  assert.equal(config.scheduler.maxRecipients, 50);
  assert.equal(config.media.outboundMaxBytes, 5 * 1024 * 1024);
  assert.equal(config.binding.maxActiveSessions, 80);

  // DB 持久化（只存修改过的字段，JSON 编码）
  const rows = new Map(all('SELECT key, value FROM app_settings').map((row) => [row.key, row.value]));
  assert.equal(JSON.parse(rows.get('keepalive.text')), '自定义保活文案 {name}');
  assert.equal(JSON.parse(rows.get('keepalive.enabled')), false);
  assert.deepEqual(JSON.parse(rows.get('appRules.allowedHosts')), ['127.0.0.1', '192.168.88.10']);
  assert.equal(JSON.parse(rows.get('scheduler.maxRecipients')), 50);

  // getSettings 反映当前值
  const view = settings.getSettings();
  const keepalive = view.groups.find((group) => group.key === 'keepalive');
  assert.equal(keepalive.fields.find((field) => field.key === 'enabled').value, false);
  assert.equal(keepalive.fields.find((field) => field.key === 'text').value, '自定义保活文案 {name}');

  // events 只记录字段名，不写值
  const events = all("SELECT type, detail FROM events WHERE type = 'settings_update' ORDER BY id DESC");
  assert.ok(events.length >= 1);
  assert.match(events[0].detail, /keepalive\.text/);
  assert.ok(!events[0].detail.includes('自定义保活文案'), 'events 不得包含配置值');
});

test('updateSettings：类型/范围/未知字段/时区/主机名校验 400', () => {
  const cases = [
    [null, '请求体'],
    [{}, '至少提交'],
    [{ nope: { x: 1 } }, '未知配置分组'],
    [{ keepalive: { nope: 1 } }, '未知配置字段'],
    [{ keepalive: { enabled: 'yes' } }, 'boolean'],
    [{ keepalive: { windowMs: '1000' } }, '整数'],
    [{ push: { rateLimitMax: 0 } }, '之间'],
    [{ push: { retryDelaysMs: [1000, -1] } }, '之间'],
    [{ appRules: { allowedHosts: 'http://bad host' } }, '非法主机名'],
    [{ scheduler: { timezone: 'Not/AZone' } }, 'IANA 时区'],
    [{ scheduler: { timezone: '' } }, '长度'],
    [{ media: { maxBytes: 1 } }, '之间'],
  ];
  for (const [patch, snippet] of cases) {
    assert.throws(
      () => settings.updateSettings(patch),
      (err) => {
        assert.equal(err.code, 'BAD_REQUEST', `${JSON.stringify(patch)} 应 400`);
        assert.match(err.message, new RegExp(snippet));
        return true;
      },
    );
  }

  // allowedHosts 空数组 = 清空白名单
  settings.updateSettings({ appRules: { allowedHosts: [] } });
  assert.deepEqual(config.appRules.allowedHosts, []);
});

test('loadOverrides：有效覆盖应用，非法值忽略并返回计数', () => {
  const now = Date.now();
  run(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    'push.maxAttempts',
    '9',
    now,
  );
  run(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    'keepalive.windowMs',
    '"not-a-number"',
    now,
  );
  run(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    'unknown.field',
    '1',
    now,
  );
  const beforeWindow = config.keepalive.windowMs;
  const result = settings.loadOverrides();
  assert.ok(result.applied >= 1);
  assert.ok(result.ignored >= 2);
  assert.equal(config.push.maxAttempts, 9);
  assert.equal(config.keepalive.windowMs, beforeWindow, '非法覆盖值应被忽略');
});

test('resetGroup：删除该组覆盖并恢复 env 默认 + hooks', () => {
  const hookCalls = [];
  settings.setRuntimeHooks({ restartKeepalive: () => hookCalls.push('keepalive') });
  settings.updateSettings({ keepalive: { enabled: false, windowMs: 7_200_000 } });
  assert.equal(config.keepalive.enabled, false);
  hookCalls.length = 0;

  const result = settings.resetGroup('keepalive');
  assert.equal(result.ok, true);
  assert.deepEqual(hookCalls, ['keepalive']);
  assert.equal(config.keepalive.enabled, defaultOf('keepalive', 'enabled'));
  assert.equal(config.keepalive.windowMs, defaultOf('keepalive', 'windowMs'));
  const remaining = all("SELECT key FROM app_settings WHERE key LIKE 'keepalive.%'");
  assert.equal(remaining.length, 0, 'reset 后该组不应保留覆盖行');
  assert.throws(() => settings.resetGroup('nope'), /未知配置分组/);
});

test('getEffectiveConfig 返回托管分组当前值', () => {
  const effective = settings.getEffectiveConfig();
  assert.deepEqual(
    Object.keys(effective),
    ['push', 'keepalive', 'appRules', 'scheduler', 'media', 'binding', 'server', 'security', 'ilink', 'monitor'],
  );
  assert.equal(effective.push.maxAttempts, config.push.maxAttempts);
  assert.equal(effective.keepalive.text, config.keepalive.text);
  assert.equal(effective.media.maxBytes, config.media.outboundMaxBytes);
  assert.equal(effective.binding.maxActive, config.binding.maxActiveSessions);
});
