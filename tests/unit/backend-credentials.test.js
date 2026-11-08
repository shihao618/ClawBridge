/**
 * 单元测试：shared/credentials.js —— 用户级凭据注入（user_secrets → `{credential:名称.字段}`）。
 *
 * 覆盖：引用收集、占位符渲染（含 URL 编码）、日志脱敏、按用户解析/缺失错误、touch last_used_at。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-credentials-',
  env: {
    APP_SECRET: 'credentials-secret-0123456789abcdef0123456789abcdef',
    ADMIN_PASSWORD: 'credentials-password',
    API_TOKEN: 'credentials-token',
    LOG_LEVEL: 'silent',
  },
});

const credentials = await import('../../server/src/shared/credentials.js');
const store = await import('../../server/src/store.js');
const userSecrets = await import('../../server/src/data/user-secrets.js');
const { renderRequestTemplate } = await import('../../server/src/shared/template.js');
const { renderHttpRequest } = await import('../../server/src/shared/http-execute.js');

test.after(async () => {
  await cleanupUnitEnv(unitEnv);
});

let seq = 0;
function createUser(displayName = '') {
  seq += 1;
  return store.upsertBoundUser({
    wechatUserId: `wx_credentials_${seq}`,
    displayName: displayName || `凭据用户${seq}`,
    ilinkBotId: `bot_credentials_${seq}@im.bot`,
    botToken: `credentials-bot-token-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
}

function seedSecret(userId, name, fields) {
  return userSecrets.setUserSecret(userId, { name, label: name, fields });
}

function readSecretItem(userId, name) {
  return userSecrets.listUserSecrets(userId).find((item) => item.name === name);
}

test('findCredentialRefs / collectCredentialRefs：URL/Header/Body 收集 + 去重 + 非法忽略', () => {
  assert.deepEqual(credentials.findCredentialRefs('a {credential:gps.token} b {credential:gps.token}'), ['gps.token']);
  assert.deepEqual(credentials.findCredentialRefs('{credential:bad name.x} {credential:gps.device-id}'), ['gps.device-id']);
  assert.deepEqual(credentials.findCredentialRefs('{arg} {credential:} plain'), []);

  const refs = credentials.collectCredentialRefs({
    url: 'https://api.example.com/x?token={credential:gps.token}&city={arg}',
    headers: {
      Authorization: 'Bearer {credential:gps.token}',
      'X-Device': '{credential:gps.device}',
    },
    bodyTemplate: '{"t":"{credential:gps.token}"}',
  });
  assert.deepEqual(refs.sort(), ['gps.device', 'gps.token']);
});

test('containsCredentialPlaceholder / getCredentialNames', () => {
  assert.equal(credentials.containsCredentialPlaceholder('/x?t={credential:gps.token}'), true);
  assert.equal(credentials.containsCredentialPlaceholder('/x?t={arg}'), false);
  assert.equal(credentials.containsCredentialPlaceholder(''), false);
  assert.equal(credentials.containsCredentialPlaceholder(undefined), false);
  assert.deepEqual(credentials.getCredentialNames(['gps.token', 'gps.device', 'other.x']), ['gps', 'other']);
});

test('renderCredentialPlaceholders / renderRequestTemplate：占位符替换（含 URL 编码）', () => {
  const values = new Map([
    ['gps.token', 'abc 123&x'],
    ['gps.device', 'dev-1'],
  ]);
  assert.equal(credentials.renderCredentialPlaceholders('t={credential:gps.token}', values), 't=abc 123&x');
  assert.equal(
    credentials.renderCredentialPlaceholders('t={credential:gps.token}', values, { urlEncode: true }),
    `t=${encodeURIComponent('abc 123&x')}`,
  );
  // 未知引用保持原样
  assert.equal(credentials.renderCredentialPlaceholders('{credential:gps.unknown}', values), '{credential:gps.unknown}');

  // 请求模板单趟渲染：普通变量与凭据占位符互不干扰（避免二次替换注入）
  const template = '{arg}/{credential:gps.token}/{credential:gps.device}';
  assert.equal(
    renderRequestTemplate(template, { arg: 'A B' }, { urlEncode: true, credentialValues: values }),
    `${encodeURIComponent('A B')}/${encodeURIComponent('abc 123&x')}/dev-1`,
  );
  // 用户文本里的 {credential:...} 不会被当作凭据解析（此处仅验证未传 credentialValues 时原样保留）
  assert.equal(renderRequestTemplate('{arg}', { arg: '{credential:gps.token}' }), '{credential:gps.token}');

  const rendered = renderHttpRequest(
    {
      method: 'POST',
      url: 'https://api.example.com/x?t={credential:gps.token}',
      headers: { 'X-Device': '{credential:gps.device}' },
      bodyTemplate: '{"token":"{credential:gps.token}"}',
    },
    {},
    { credentialValues: values },
  );
  assert.equal(rendered.url, `https://api.example.com/x?t=${encodeURIComponent('abc 123&x')}`);
  assert.equal(rendered.headers['X-Device'], 'dev-1');
  assert.equal(rendered.body, '{"token":"abc 123&x"}');
});

test('redactCredentialValues：原值与 URL 编码形式都替换为 ***', () => {
  const values = new Map([
    ['gps.token', 'secret-value-123'],
    ['gps.device', 'dev 9'],
  ]);
  const encoded = encodeURIComponent('secret-value-123');
  const text = `raw=secret-value-123 encoded=${encoded} device=dev 9 other=keep`;
  const redacted = credentials.redactCredentialValues(text, values);
  assert.equal(redacted.includes('secret-value-123'), false);
  assert.equal(redacted.includes(encoded), false);
  assert.equal(redacted.includes('dev 9'), false);
  assert.equal(redacted.includes('other=keep'), true);
  assert.equal(redacted.includes('***'), true);
  assert.equal(credentials.redactCredentialValues('', values), '');
});

test('resolveRequestCredentials：按用户解析、缺失错误只含名称、touch last_used_at', () => {
  const user = createUser('凭据解析用户');
  seedSecret(user.id, 'gps', { token: 'tok-A-123', device: 'dev-1' });
  assert.equal(readSecretItem(user.id, 'gps').lastUsedAt, 0);

  const resolved = credentials.resolveRequestCredentials(user.id, ['gps.token', 'gps.device']);
  assert.equal(resolved.values.get('gps.token'), 'tok-A-123');
  assert.equal(resolved.values.get('gps.device'), 'dev-1');
  assert.deepEqual([...resolved.usedNames], ['gps']);
  assert.ok(readSecretItem(user.id, 'gps').lastUsedAt > 0, '解析成功后应更新 last_used_at');
  assert.equal(readSecretItem(user.id, 'gps').updatedAt > 0, true);

  // 缺失凭据 / 字段：错误信息只含名称
  assert.throws(
    () => credentials.resolveRequestCredentials(user.id, ['nope.token']),
    (err) => {
      assert.equal(err.name, 'CredentialMissingError');
      assert.match(err.message, /missing credential nope\.token/);
      assert.deepEqual(err.missing, ['nope.token']);
      return true;
    },
  );
  assert.throws(
    () => credentials.resolveRequestCredentials(user.id, ['gps.token', 'gps.missing']),
    /missing credential gps\.missing/,
  );
  // 无用户上下文（如管理端测试运行未指定用户）→ 视为缺失
  assert.throws(() => credentials.resolveRequestCredentials('', ['gps.token']), /missing credential gps\.token/);

  // touch=false 不更新 last_used_at
  const user2 = createUser('凭据不 touch 用户');
  seedSecret(user2.id, 'gps', { token: 'tok-B' });
  credentials.resolveRequestCredentials(user2.id, ['gps.token'], { touch: false });
  assert.equal(readSecretItem(user2.id, 'gps').lastUsedAt, 0);

  // 显式 touchUsedCredentials
  assert.equal(credentials.touchUsedCredentials(user2.id, ['gps']), 1);
  assert.ok(readSecretItem(user2.id, 'gps').lastUsedAt > 0);
  assert.equal(credentials.touchUsedCredentials('', ['gps']), 0);
});
