/**
 * e2e：运行配置（第二批）+ 首启自动生成管理密码 / API Token（docs/SETTINGS.md §7/§8）。
 *
 * 用户明确「无需兼容旧版本」：
 *  - ADMIN_PASSWORD / API_TOKEN 环境变量不再读取（显式设置也会被忽略）；删除 legacy env→DB 迁移；
 *  - 空 DB 首启自动生成随机管理密码/API Token → DB（scrypt/AES）+ DATA_DIR/admin-password.txt、
 *    DATA_DIR/api-token.txt；来源恒为 db；文件权限 0600；
 *  - 重置语义：password/reset 生成新随机密码并更新文件；api-token/reset（或 rotate）生成新 token
 *    并更新文件；明文仅本次响应返回；
 *  - 剩余可后台修改分组/字段（server/ilink/monitor/media/push/binding/security）保持原行为。
 *
 * 覆盖：首启文件生成 + 文件值登录/调 API；env 显式设置被忽略；二次启动不重新生成；
 *      密码 change/reset；Token rotate/reset；PATCH 新字段与 restartRequired；非法值 400；
 *      reset 分组默认；401/403；事件表不泄漏密码/Token。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';

import { APP_SECRET, startE2E, startMockApi } from '../helpers/e2e-env.mjs';

const NEW_PASSWORD = 'e2e-new-admin-pass-9876';
const ENV_LEGACY_PASSWORD = 'legacy-env-password-ignored';
const ENV_LEGACY_TOKEN = 'legacy-env-token-ignored';

let e2e;
let externalApi;
let initialSettings;
let initialFilePassword = '';
let initialFileToken = '';
let currentPassword = '';
let currentToken = '';
let rotatedToken = '';
let resetPasswordValue = '';
let resetTokenValue = '';

function groupOf(settings, key) {
  return (settings.groups ?? []).find((group) => group.key === key);
}

function fieldOf(settings, groupKey, fieldKey) {
  return groupOf(settings, groupKey)?.fields?.find((field) => field.key === fieldKey);
}

async function getSettingsJson() {
  const res = await e2e.getSettings();
  assert.equal(res.status, 200, `GET settings 失败：${res.status} ${res.text}`);
  return res.json;
}

/** 从响应 JSON 中提取“新 token 明文”（排除 preview/旧 token/密码类字符串）。 */
function extractNewToken(json, exclude = []) {
  const previewKey = Object.keys(json).find((key) => /preview/i.test(key));
  const preview = previewKey ? json[previewKey] : undefined;
  const excluded = new Set([...exclude.filter(Boolean), preview, APP_SECRET, NEW_PASSWORD].filter(Boolean));
  const candidates = [];
  const walk = (value) => {
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) walk(nested);
      return;
    }
    if (typeof value === 'string' && value.length >= 16) candidates.push(value);
  };
  walk(json);
  return {
    token: candidates.find((value) => !excluded.has(value) && /^[A-Za-z0-9_.\-]{16,256}$/.test(value)),
    preview,
  };
}

/** 从 password reset 响应提取新密码明文（响应字段名 password / newPassword）。 */
function extractResetPassword(json) {
  const candidate = json.password ?? json.newPassword
    ?? Object.entries(json).find(([key, value]) => /password/i.test(key) && typeof value === 'string')?.[1];
  return typeof candidate === 'string' ? candidate : '';
}

async function readPasswordFile() {
  return (await e2e.readSecretFile('admin-password.txt')).trim();
}

async function readTokenFile() {
  return (await e2e.readSecretFile('api-token.txt')).trim();
}

before(async () => {
  e2e = await startE2E();
  externalApi = await startMockApi();
  await e2e.ensureAdmin();
  initialSettings = await getSettingsJson();
  initialFilePassword = e2e.adminPassword;
  initialFileToken = e2e.apiToken;
  currentPassword = initialFilePassword;
  currentToken = initialFileToken;
});

after(async () => {
  await externalApi?.close().catch(() => {});
  await e2e?.cleanup();
});

test('空 DB 首启自动生成机密文件：文件内容可登录/调 API，security 来源恒为 db', async () => {
  assert.ok(initialFilePassword.length >= 8, `首启生成的管理密码应非空：${JSON.stringify(initialFilePassword)}`);
  assert.ok(initialFileToken.length >= 16, `首启生成的 API Token 应非空：${JSON.stringify(initialFileToken)}`);

  // 文件存在且内容与 helper 读取一致
  const passwordFile = await readPasswordFile();
  const tokenFile = await readTokenFile();
  assert.equal(passwordFile, initialFilePassword, 'admin-password.txt 内容应为首启密码明文');
  assert.equal(tokenFile, initialFileToken, 'api-token.txt 内容应为首启 Token 明文');
  const pwdStat = await fsp.stat(e2e.adminPasswordPath);
  assert.equal(pwdStat.isFile(), true, 'admin-password.txt 应为普通文件');

  // 文件内容可直接登录 / 调 API
  const loginByFile = await e2e.loginAdminWith(passwordFile);
  assert.equal(loginByFile.status, 200, `文件密码登录应 200：${loginByFile.status} ${loginByFile.text}`);
  const apiByFileToken = await e2e.getV1Groups({ token: tokenFile });
  assert.equal(apiByFileToken.status, 200, `文件 Token 调 API 应 200：${apiByFileToken.status} ${apiByFileToken.text}`);

  // GET settings：security 来源恒 db + 脱敏预览；无哈希/明文
  const settings = await getSettingsJson();
  const security = settings.security;
  assert.ok(security && typeof security === 'object', 'GET settings 应含 security 摘要');
  assert.equal(security.adminPasswordSource, 'db', '管理密码来源应恒为 db');
  assert.equal(security.apiTokenSource, 'db', 'API Token 来源应恒为 db');
  assert.equal(typeof security.apiTokenPreview, 'string');
  assert.notEqual(security.apiTokenPreview, tokenFile, 'apiTokenPreview 不应是明文 token');
  const text = JSON.stringify(settings);
  for (const secret of [passwordFile, tokenFile, APP_SECRET]) {
    assert.equal(text.includes(secret), false, 'GET settings 不应包含明文机密');
  }
  assert.equal(/adminPasswordHash/i.test(text), false, '不应返回密码哈希');
  assert.equal(/apiTokenEnc/i.test(text), false, '不应返回加密 token 字段');

  // envOnly 仍为 §7.1 六项（ADMIN_PASSWORD/API_TOKEN 不在其中）
  const envOnlyKeys = (settings.envOnly ?? []).map((item) => (typeof item === 'string' ? item : item.key));
  const allowed = new Set(['APP_SECRET', 'DATA_DIR', 'MEDIA_DIR', 'PORT', 'HOST', 'NODE_ENV']);
  for (const key of envOnlyKeys) assert.ok(allowed.has(key), `envOnly 不应包含 ${key}`);
  for (const key of ['APP_SECRET', 'DATA_DIR', 'PORT', 'HOST', 'NODE_ENV']) {
    assert.ok(envOnlyKeys.includes(key), `envOnly 应包含 ${key}，实际 ${JSON.stringify(envOnlyKeys)}`);
  }
  assert.ok(envOnlyKeys.length >= 5 && envOnlyKeys.length <= 6, `envOnly 应为 5~6 项，实际 ${JSON.stringify(envOnlyKeys)}`);
});

test('显式 env ADMIN_PASSWORD / API_TOKEN 被忽略（使用首启生成文件值）', async () => {
  const legacyEnv = await startE2E({
    appEnv: { ADMIN_PASSWORD: ENV_LEGACY_PASSWORD, API_TOKEN: ENV_LEGACY_TOKEN },
  });
  try {
    // 生成值不能等于显式 env 值
    assert.notEqual(legacyEnv.adminPassword, ENV_LEGACY_PASSWORD, '首启密码不应采用 env ADMIN_PASSWORD');
    assert.notEqual(legacyEnv.apiToken, ENV_LEGACY_TOKEN, '首启 Token 不应采用 env API_TOKEN');
    const filePassword = await legacyEnv.readSecretFile('admin-password.txt');
    const fileToken = await legacyEnv.readSecretFile('api-token.txt');
    assert.equal(filePassword, legacyEnv.adminPassword, '文件内容应为实际生效密码');

    // env 密码登录 401；文件密码 200
    const envLogin = await legacyEnv.loginAdminWith(ENV_LEGACY_PASSWORD);
    assert.equal(envLogin.status, 401, `env 密码应被忽略（401）：${envLogin.status} ${envLogin.text}`);
    const fileLogin = await legacyEnv.loginAdminWith(filePassword);
    assert.equal(fileLogin.status, 200, `文件密码应可登录：${fileLogin.status} ${fileLogin.text}`);

    // env token 调 API 401；文件 token 200
    const envTokenApi = await legacyEnv.getV1Groups({ token: ENV_LEGACY_TOKEN });
    assert.equal(envTokenApi.status, 401, `env Token 应被忽略（401）：${envTokenApi.status} ${envTokenApi.text}`);
    const fileTokenApi = await legacyEnv.getV1Groups({ token: fileToken });
    assert.equal(fileTokenApi.status, 200, `文件 Token 应可调 API：${fileTokenApi.status} ${fileTokenApi.text}`);
  } finally {
    await legacyEnv.cleanup();
  }
});

test('二次启动不重新生成机密（文件内容/密码不变）', async () => {
  const first = await startE2E();
  const firstDir = first.dataDir;
  const firstPassword = first.adminPassword;
  const firstToken = first.apiToken;
  const firstPwdFile = await first.readSecretFile('admin-password.txt');
  const firstTokenFile = await first.readSecretFile('api-token.txt');
  try {
    await first.cleanup({ keepDataDir: true }); // 停止 app/mock，保留 DATA_DIR
    const second = await startE2E({ dataDir: firstDir });
    try {
      assert.equal(second.adminPassword, firstPassword, '二次启动不应重新生成管理密码');
      assert.equal(second.apiToken, firstToken, '二次启动不应重新生成 API Token');
      assert.equal(await second.readSecretFile('admin-password.txt'), firstPwdFile, '二次启动密码文件内容应不变');
      assert.equal(await second.readSecretFile('api-token.txt'), firstTokenFile, '二次启动 Token 文件内容应不变');
      const login = await second.loginAdminWith(second.adminPassword);
      assert.equal(login.status, 200, '二次启动后原密码应可登录');
      const api = await second.getV1Groups({ token: second.apiToken });
      assert.equal(api.status, 200, '二次启动后原 Token 应可调 API');
    } finally {
      await second.cleanup(); // 复用 DATA_DIR：不删除
    }
  } finally {
    await first.cleanup().catch(() => {});
    await fsp.rm(firstDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
});

test('GET settings：新分组/扩展字段/security 摘要齐全', async () => {
  const settings = await getSettingsJson();
  const groupKeys = settings.groups.map((group) => group.key);
  for (const key of ['server', 'ilink', 'monitor', 'media', 'push', 'binding']) {
    assert.ok(groupKeys.includes(key), `groups 应包含 ${key}，实际 ${JSON.stringify(groupKeys)}`);
  }
  const serverFields = ['publicBaseUrl', 'trustProxy', 'cookieSecure', 'logLevel'];
  for (const field of serverFields) {
    const meta = fieldOf(settings, 'server', field);
    assert.ok(meta, `应存在 server.${field}`);
    assert.ok('value' in meta && 'default' in meta);
    assert.equal(typeof meta.restartRequired, 'boolean');
  }
  assert.equal(fieldOf(settings, 'server', 'trustProxy').restartRequired, true);
  assert.equal(fieldOf(settings, 'server', 'logLevel').restartRequired, false);
  for (const field of [
    'loginBaseUrl', 'defaultBaseUrl', 'cdnBaseUrl', 'appId', 'channelVersion',
    'botAgent', 'botType', 'routeTag', 'clientVersion', 'requestTimeoutMs',
    'qrPollTimeoutMs', 'longPollTimeoutMs',
  ]) {
    const meta = fieldOf(settings, 'ilink', field);
    assert.ok(meta, `应存在 ilink.${field}`);
    assert.equal(meta.restartRequired, true, `ilink.${field} 应为 restartRequired`);
  }
  for (const field of ['longPollTimeoutMs', 'maxAccounts']) {
    assert.ok(fieldOf(settings, 'monitor', field), `应存在 monitor.${field}`);
    assert.equal(fieldOf(settings, 'monitor', field).restartRequired, true);
  }
  for (const field of ['downloadTimeoutMs', 'uploadTimeoutMs', 'allowedImageMime', 'allowedVideoMime']) {
    assert.ok(fieldOf(settings, 'media', field), `应存在 media.${field}`);
  }
  assert.ok(fieldOf(settings, 'push', 'tickMs'), '应存在 push.tickMs');
  assert.equal(fieldOf(settings, 'push', 'tickMs').restartRequired, true);
  for (const field of ['networkErrorLimit', 'pollGapMs']) {
    assert.ok(fieldOf(settings, 'binding', field), `应存在 binding.${field}`);
  }
  const security = settings.security;
  for (const key of ['adminPasswordSource', 'apiTokenSource', 'apiTokenPreview', 'pushApiEnabled', 'sessionTtlMs']) {
    assert.ok(key in security, `security 应包含 ${key}`);
  }
  assert.equal(security.adminPasswordSource, 'db');
  assert.equal(security.apiTokenSource, 'db');
  assert.equal(typeof security.pushApiEnabled, 'boolean');
  assert.equal(typeof security.sessionTtlMs, 'number');
});

test('PATCH 新字段生效；restartRequired 标记正确（logLevel 即时，ilink/monitor/push.tickMs 需重启）', async () => {
  await e2e.ensureAdmin();
  const patch = {
    server: { logLevel: 'debug', publicBaseUrl: 'http://clawbridge.example.test:3000', trustProxy: true, cookieSecure: false },
    ilink: {
      loginBaseUrl: `${externalApi.baseUrl}/ilink-login`,
      defaultBaseUrl: `${externalApi.baseUrl}/ilink-api`,
      cdnBaseUrl: `${externalApi.baseUrl}/cdn`,
      appId: 'e2e-app-id',
      longPollTimeoutMs: 4000,
    },
    monitor: { maxAccounts: 3, longPollTimeoutMs: 3000 },
    media: {
      downloadTimeoutMs: 5000,
      uploadTimeoutMs: 6000,
      allowedImageMime: ['image/png', 'image/jpeg'],
      allowedVideoMime: 'video/mp4,video/quicktime',
    },
    push: { tickMs: 120 },
    binding: { pollGapMs: 10, networkErrorLimit: 5 },
    security: { sessionTtlMs: 7200000 },
  };
  const res = await e2e.updateSettings(patch);
  assert.equal(res.status, 200, `PATCH 新字段应 200：${res.status} ${res.text}`);
  assert.equal(res.json.ok, true);
  const restartRequired = res.json.restartRequired ?? [];
  for (const key of ['server.trustProxy', 'ilink.loginBaseUrl', 'monitor.maxAccounts', 'push.tickMs']) {
    assert.ok(restartRequired.includes(key), `restartRequired 应包含 ${key}，实际 ${JSON.stringify(restartRequired)}`);
  }
  assert.equal(restartRequired.includes('server.logLevel'), false, 'logLevel 应即时生效');

  const settings = await getSettingsJson();
  assert.equal(fieldOf(settings, 'server', 'logLevel').value, 'debug');
  assert.equal(fieldOf(settings, 'server', 'trustProxy').value, true);
  assert.equal(fieldOf(settings, 'ilink', 'loginBaseUrl').value, patch.ilink.loginBaseUrl);
  assert.equal(fieldOf(settings, 'monitor', 'maxAccounts').value, 3);
  assert.deepEqual(fieldOf(settings, 'media', 'allowedImageMime').value, ['image/png', 'image/jpeg']);
  assert.deepEqual(fieldOf(settings, 'media', 'allowedVideoMime').value, ['video/mp4', 'video/quicktime']);
  assert.equal(fieldOf(settings, 'push', 'tickMs').value, 120);
  assert.equal(fieldOf(settings, 'binding', 'pollGapMs').value, 10);
  assert.equal(settings.security.sessionTtlMs, 7200000);

  const config = await e2e.getConfig();
  assert.equal(config.status, 200);
  if (config.json.logLevel !== undefined) assert.equal(config.json.logLevel, 'debug');
  if (config.json.ilink) assert.equal(config.json.ilink.loginBaseUrl, patch.ilink.loginBaseUrl);
});

test('改管理密码：错误当前/长度不足 400/401；成功后旧密码 401、新密码 200', async () => {
  await e2e.ensureAdmin();
  const wrongCurrent = await e2e.changeAdminPassword({ currentPassword: 'definitely-wrong-password', newPassword: NEW_PASSWORD });
  assert.ok([400, 401].includes(wrongCurrent.status), `错误当前密码应 400/401：${wrongCurrent.status} ${wrongCurrent.text}`);

  const shortPassword = await e2e.changeAdminPassword({ currentPassword, newPassword: 'short' });
  assert.equal(shortPassword.status, 400, `新密码过短应 400：${shortPassword.status} ${shortPassword.text}`);
  assert.equal(shortPassword.json.error.code, 'BAD_REQUEST');

  const changed = await e2e.changeAdminPassword({ currentPassword, newPassword: NEW_PASSWORD });
  assert.equal(changed.status, 200, `修改密码应 200：${changed.status} ${changed.text}`);
  assert.equal(changed.json.ok, true);
  assert.equal(changed.json.adminPasswordSource, 'db');

  const oldLogin = await e2e.loginAdminWith(currentPassword);
  assert.equal(oldLogin.status, 401, `旧密码登录应 401：${oldLogin.status} ${oldLogin.text}`);
  const newLogin = await e2e.loginAdminWith(NEW_PASSWORD);
  assert.equal(newLogin.status, 200, `新密码登录应 200：${newLogin.status} ${newLogin.text}`);
  currentPassword = NEW_PASSWORD;

  const settings = await getSettingsJson();
  assert.equal(settings.security.adminPasswordSource, 'db');
  assert.equal(JSON.stringify(settings).includes(NEW_PASSWORD), false, 'GET settings 不应包含新密码明文');
});

test('reset 密码：返回新密码明文 → 旧密码 401、新密码 200、admin-password.txt 更新', async () => {
  await e2e.ensureAdmin();
  const wrongReset = await e2e.resetAdminPassword({ currentPassword: 'wrong-reset-password' });
  assert.ok([400, 401].includes(wrongReset.status), `reset 错误当前密码应 400/401：${wrongReset.status} ${wrongReset.text}`);

  const reset = await e2e.resetAdminPassword({ currentPassword });
  assert.equal(reset.status, 200, `reset 密码应 200：${reset.status} ${reset.text}`);
  assert.equal(reset.json.ok, true);
  assert.equal(reset.json.adminPasswordSource ?? reset.json.source, 'db');
  const newPassword = extractResetPassword(reset.json);
  assert.ok(newPassword.length >= 8, `reset 响应应返回新密码明文（仅本次）：${reset.text}`);
  assert.notEqual(newPassword, currentPassword, 'reset 应生成新密码而不是回退旧值');
  resetPasswordValue = newPassword;

  // 文件已更新为新密码
  assert.equal(await readPasswordFile(), newPassword, 'data/admin-password.txt 应更新为新密码');

  // 旧密码 401、新密码 200
  const oldLogin = await e2e.loginAdminWith(currentPassword);
  assert.equal(oldLogin.status, 401, `reset 后旧密码应 401：${oldLogin.status} ${oldLogin.text}`);
  const newLogin = await e2e.loginAdminWith(newPassword);
  assert.equal(newLogin.status, 200, `reset 后新密码应 200：${newLogin.status} ${newLogin.text}`);
  currentPassword = newPassword;

  const settings = await getSettingsJson();
  assert.equal(settings.security.adminPasswordSource, 'db');
  assert.equal(JSON.stringify(settings).includes(newPassword), false, 'GET settings 不应回显新密码明文');
});

test('API Token rotate/reset：明文仅一次、旧 401/新 200、api-token.txt 更新、pushApiEnabled 开关', async () => {
  await e2e.ensureAdmin();
  // 当前 token 可用
  const initialApi = await e2e.getV1Groups({ token: currentToken });
  assert.equal(initialApi.status, 200, `当前 API Token 应可用：${initialApi.status} ${initialApi.text}`);

  // rotate：生成新 token（明文仅本次响应）
  const rotate = await e2e.rotateApiToken();
  assert.equal(rotate.status, 200, `rotate 应 200：${rotate.status} ${rotate.text}`);
  assert.equal(rotate.json.ok, true);
  const rotated = extractNewToken(rotate.json, [currentToken, initialFilePassword, currentPassword, resetPasswordValue]);
  assert.ok(rotated.token, `rotate 响应应包含新 token 明文：${rotate.text}`);
  assert.equal(rotate.text.split(rotated.token).length - 1, 1, 'token 明文应只出现一次');
  rotatedToken = rotated.token;
  const rotatedApi = await e2e.getV1Groups({ token: rotatedToken });
  assert.equal(rotatedApi.status, 200, 'rotate 后新 token 应可用');
  const oldApi = await e2e.getV1Groups({ token: currentToken });
  assert.equal(oldApi.status, 401, 'rotate 后旧 token 应 401');
  currentToken = rotatedToken;

  // GET settings：来源 db、preview 脱敏、无明文
  let settings = await getSettingsJson();
  assert.equal(settings.security.apiTokenSource, 'db');
  assert.notEqual(settings.security.apiTokenPreview, rotatedToken, 'preview 不应是明文 token');
  assert.equal(JSON.stringify(settings).includes(rotatedToken), false, 'GET settings 不应回显 token 明文');

  // reset：生成另一个新 token + 更新文件
  const reset = await e2e.resetApiToken();
  assert.equal(reset.status, 200, `reset token 应 200：${reset.status} ${reset.text}`);
  assert.equal(reset.json.ok, true);
  const resetExtract = extractNewToken(reset.json, [rotatedToken, resetPasswordValue, APP_SECRET]);
  assert.ok(resetExtract.token, `reset 响应应包含新 token 明文：${reset.text}`);
  assert.notEqual(resetExtract.token, rotatedToken, 'reset 应生成不同 token');
  resetTokenValue = resetExtract.token;
  assert.equal(await readTokenFile(), resetTokenValue, 'data/api-token.txt 应更新为新 token');

  const resetApi = await e2e.getV1Groups({ token: resetTokenValue });
  assert.equal(resetApi.status, 200, 'reset 后新 token 应可用');
  const rotatedInvalid = await e2e.getV1Groups({ token: rotatedToken });
  assert.equal(rotatedInvalid.status, 401, 'reset 后 rotate token 应失效');
  currentToken = resetTokenValue;

  settings = await getSettingsJson();
  assert.equal(JSON.stringify(settings).includes(resetTokenValue), false, 'GET settings 不应回显 reset token 明文');

  // pushApiEnabled 开关
  const off = await e2e.updateSettings({ security: { pushApiEnabled: false } });
  assert.equal(off.status, 200);
  const disabledRes = await e2e.getV1Groups({ token: currentToken });
  assert.ok([401, 403, 404].includes(disabledRes.status), `pushApiEnabled=false 时 API 应拒绝：${disabledRes.status} ${disabledRes.text}`);
  const on = await e2e.updateSettings({ security: { pushApiEnabled: true } });
  assert.equal(on.status, 200);
  const enabledRes = await e2e.getV1Groups({ token: currentToken });
  assert.equal(enabledRes.status, 200, '重新开启后 API 应恢复');
});

test('非法新字段 → 400 且不落库（logLevel/URL/范围/boolean 字符串/空数组）', async () => {
  await e2e.ensureAdmin();
  const before = await getSettingsJson();
  const beforeLogLevel = fieldOf(before, 'server', 'logLevel').value;
  const invalidPatches = [
    { server: { logLevel: 'trace' } },
    { server: { publicBaseUrl: 'ftp://example.com/x' } },
    { server: { cookieSecure: 'yes' } },
    { ilink: { cdnBaseUrl: 'not a url' } },
    { ilink: { longPollTimeoutMs: 10 } },
    { monitor: { maxAccounts: 0 } },
    { binding: { pollGapMs: -1 } },
    { media: { allowedImageMime: 123 } },
  ];
  for (const patch of invalidPatches) {
    const res = await e2e.updateSettings(patch);
    assert.equal(res.status, 400, `非法新字段应 400（${JSON.stringify(patch)}）：${res.status} ${res.text}`);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
  }
  const afterInvalid = await getSettingsJson();
  assert.equal(fieldOf(afterInvalid, 'server', 'logLevel').value, beforeLogLevel, '非法 PATCH 不应落库');
});

test('reset 新分组恢复默认（server/ilink/monitor/push/binding）', async () => {
  await e2e.ensureAdmin();
  for (const group of ['server', 'ilink', 'monitor', 'push', 'binding']) {
    const res = await e2e.resetSettingsGroup(group);
    assert.equal(res.status, 200, `reset ${group} 应 200：${res.status} ${res.text}`);
    assert.equal(res.json.ok, true);
  }
  const settings = await getSettingsJson();
  assert.equal(fieldOf(settings, 'server', 'logLevel').value,
    initialSettings.groups.find((group) => group.key === 'server').fields.find((field) => field.key === 'logLevel').value);
  assert.equal(fieldOf(settings, 'ilink', 'loginBaseUrl').value, fieldOf(settings, 'ilink', 'loginBaseUrl').default);
  assert.equal(fieldOf(settings, 'monitor', 'maxAccounts').value, fieldOf(settings, 'monitor', 'maxAccounts').default);
  assert.equal(fieldOf(settings, 'push', 'tickMs').value, fieldOf(settings, 'push', 'tickMs').default);
  assert.equal(fieldOf(settings, 'binding', 'pollGapMs').value, fieldOf(settings, 'binding', 'pollGapMs').default);

  const unknown = await e2e.resetSettingsGroup('not_a_group');
  assert.equal(unknown.status, 400, 'reset 未知分组应 400');
  assert.equal(unknown.json.error.code, 'BAD_REQUEST');
});

test('鉴权/CSRF：未登录 401、缺 CSRF 403；事件表不泄漏密码/Token', async () => {
  // 未登录
  for (const [method, pathname, body] of [
    ['POST', '/api/admin/security/password', { currentPassword: currentPassword, newPassword: 'whatever-12345' }],
    ['POST', '/api/admin/security/password/reset', { currentPassword: currentPassword }],
    ['POST', '/api/admin/security/api-token/rotate', {}],
    ['POST', '/api/admin/security/api-token/reset', {}],
    ['PATCH', '/api/admin/settings', { security: { sessionTtlMs: 7200000 } }],
  ]) {
    const res = await e2e.request(method, pathname, { body });
    assert.equal(res.status, 401, `未登录 ${method} ${pathname} 应 401：${res.status} ${res.text}`);
  }
  // 缺 CSRF
  for (const [method, pathname, body] of [
    ['POST', '/api/admin/security/password', { currentPassword: currentPassword, newPassword: 'whatever-12345' }],
    ['POST', '/api/admin/security/api-token/rotate', {}],
    ['POST', '/api/admin/security/api-token/reset', {}],
  ]) {
    const res = await e2e.adminRequest(method, pathname, { body });
    assert.equal(res.status, 403, `缺 CSRF ${method} ${pathname} 应 403：${res.status} ${res.text}`);
  }

  // 事件表审计：不含密码/Token 明文（只读打开临时 DB，WAL 并发读安全）
  const dbPath = path.join(e2e.dataDir, 'clawbridge.db');
  let rows = [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      rows = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 300').all();
    } finally {
      db.close();
    }
  } catch (err) {
    assert.fail(`读取事件表失败：${err.message}`);
  }
  assert.ok(rows.length > 0, '应存在事件记录');
  const eventText = JSON.stringify(rows);
  const secrets = [
    initialFilePassword,
    initialFileToken,
    NEW_PASSWORD,
    resetPasswordValue,
    rotatedToken,
    resetTokenValue,
    ENV_LEGACY_PASSWORD,
    ENV_LEGACY_TOKEN,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  for (const secret of secrets) {
    assert.equal(eventText.includes(secret), false, '事件表不应包含密码/Token 明文');
  }
  assert.ok(
    rows.some((row) => /password|token|settings|security/i.test(String(row.type ?? ''))),
    `事件应记录密码/Token/配置变更动作：${JSON.stringify(rows.slice(0, 5))}`,
  );
});
