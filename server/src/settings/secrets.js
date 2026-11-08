/**
 * 机密管理：管理密码 scrypt 哈希记录 / API Token 密文（DB app_settings + DATA_DIR 文件）。
 *
 * auth.js 只依赖本模块的 getAdminPasswordHashRecord()，从而解除 auth → 整个 settings 的耦合。
 * 明文只在 bootstrap/reset/rotate 的本次返回值出现，绝不出现在读取接口/日志/事件中。
 */
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import {
  decryptSecretOrNull,
  encryptSecret,
  hashPassword,
  isPasswordHashRecord,
  randomToken,
  verifyPassword,
} from '../crypto.js';
import { unauthorized } from '../errors.js';
import { logger } from '../logger.js';

import { addSettingsEvent, upsertSetting } from './persistence.js';
import { fail, previewToken } from './validate.js';

const log = logger.child({ mod: 'settings' });

// 机密覆盖状态
let adminPasswordHashRecord = null;
let apiTokenEncPresent = false;

function verifyCurrentAdminPassword(currentPassword) {
  if (typeof currentPassword !== 'string' || currentPassword === '') {
    fail('currentPassword 必须是非空字符串');
  }
  if (!adminPasswordHashRecord) return false;
  return verifyPassword(currentPassword, adminPasswordHashRecord);
}

export function getSecurityState() {
  return {
    adminPasswordSource: 'db',
    apiTokenSource: 'db',
    apiTokenPreview: config.pushApiEnabled ? previewToken(config.secrets.apiToken) : '已禁用',
    pushApiEnabled: Boolean(config.pushApiEnabled),
    sessionTtlMs: config.session.ttlMs,
  };
}

/** 读取 DB 中管理密码 scrypt 哈希记录（auth 校验优先使用）。 */
export function getAdminPasswordHashRecord() {
  return adminPasswordHashRecord;
}

/** 处理 security.* 机密覆盖行（loadOverrides 内部）。 */
export function loadSecretOverrides(rows) {
  for (const row of rows) {
    if (row.key === 'security.adminPasswordHash') {
      try {
        const parsed = JSON.parse(row.value);
        if (typeof parsed === 'string' && isPasswordHashRecord(parsed)) {
          adminPasswordHashRecord = parsed;
        } else {
          log.warn('忽略非法的管理密码哈希覆盖值（将重新引导生成新密码）');
        }
      } catch {
        log.warn('忽略非法 JSON 的管理密码哈希覆盖值');
      }
    } else if (row.key === 'security.apiTokenEnc') {
      try {
        const parsed = JSON.parse(row.value);
        const token = typeof parsed === 'string' ? decryptSecretOrNull(parsed) : null;
        if (token) {
          config.secrets.apiToken = token;
          apiTokenEncPresent = true;
        } else {
          log.warn('忽略无法解密/非法的 API Token 覆盖值');
        }
      } catch {
        log.warn('忽略非法 JSON 的 API Token 覆盖值');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 首次启动引导（仅 DB 管理机密）
// ---------------------------------------------------------------------------
const ADMIN_PASSWORD_FILE = 'admin-password.txt';
const API_TOKEN_FILE = 'api-token.txt';

function secretsFilePath(name) {
  return path.join(config.dataDir, name);
}

/** 写机密文件（0600）；失败直接抛错，避免“DB 已有密码但无人知道明文”的锁死状态。 */
function writeSecretFile(name, value) {
  const filePath = secretsFilePath(name);
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${value}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* Windows 等平台忽略 */
  }
  return filePath;
}

function generateAdminPassword() {
  // 12 字节 base64url ≈ 16 字符
  return randomToken(12);
}

function generateApiToken() {
  return `cb_${randomToken(24)}`;
}

/**
 * 首次启动引导（index 在 loadOverrides 之后、引擎启动前调用；幂等）：
 *  - DB 无管理密码哈希 → 生成随机密码，scrypt 哈希存 DB，写 DATA_DIR/admin-password.txt(0600)；
 *  - DB 无 API Token 密文 → 生成 cb_... token，AES 加密存 DB，写 DATA_DIR/api-token.txt(0600)，
 *    更新 config.secrets.apiToken / pushApiEnabled。
 * 二次启动（DB 已有值）不重新生成。
 * @returns {{adminPasswordGenerated:boolean, apiTokenGenerated:boolean, adminPasswordFile:string, apiTokenFile:string}}
 */
export function bootstrapSecrets() {
  const result = {
    adminPasswordGenerated: false,
    apiTokenGenerated: false,
    adminPasswordFile: secretsFilePath(ADMIN_PASSWORD_FILE),
    apiTokenFile: secretsFilePath(API_TOKEN_FILE),
  };
  if (!adminPasswordHashRecord) {
    const password = generateAdminPassword();
    const record = hashPassword(password);
    // 先写文件再落 DB：文件写失败会启动失败，不会留下“哈希已存在但无人知道密码”的死状态。
    writeSecretFile(ADMIN_PASSWORD_FILE, password);
    upsertSetting('security.adminPasswordHash', JSON.stringify(record));
    adminPasswordHashRecord = record;
    result.adminPasswordGenerated = true;
    addSettingsEvent({ action: 'bootstrap_admin_password', source: 'db' });
    log.info('初始管理密码已生成，请查看文件', { file: `data/${ADMIN_PASSWORD_FILE}` });
  } else if (!fs.existsSync(secretsFilePath(ADMIN_PASSWORD_FILE))) {
    log.warn('DB 已有管理密码，但 data/admin-password.txt 不存在（旧卷升级）；如忘记密码，请在已登录后台重置，或先备份 DB 后删除 security.adminPasswordHash 行重新引导');
  }
  if (!apiTokenEncPresent) {
    const token = generateApiToken();
    writeSecretFile(API_TOKEN_FILE, token);
    upsertSetting('security.apiTokenEnc', JSON.stringify(encryptSecret(token)));
    apiTokenEncPresent = true;
    config.secrets.apiToken = token;
    upsertSetting('security.pushApiEnabled', 'true');
    config.pushApiEnabled = true;
    result.apiTokenGenerated = true;
    addSettingsEvent({ action: 'bootstrap_api_token', source: 'db' });
    log.info('初始 API Token 已生成，请查看文件', { file: `data/${API_TOKEN_FILE}` });
  } else if (!fs.existsSync(secretsFilePath(API_TOKEN_FILE))) {
    log.warn('DB 已有 API Token，但 data/api-token.txt 不存在（旧卷升级）；可在后台安全卡片重置 Token');
  }
  return result;
}

/** 变更管理密码（校验当前密码 → 写 scrypt 哈希 → 立即生效）。 */
export function changeAdminPassword(currentPassword, newPassword) {
  if (!verifyCurrentAdminPassword(currentPassword)) throw unauthorized('当前密码错误');
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
    fail('newPassword 长度必须是 8..128');
  }
  const record = hashPassword(newPassword);
  upsertSetting('security.adminPasswordHash', JSON.stringify(record));
  adminPasswordHashRecord = record;
  addSettingsEvent({ action: 'change_admin_password', source: 'db' });
  log.info('管理密码已更新（DB 哈希）');
  return { ok: true, adminPasswordSource: 'db' };
}

/** 重置管理密码：校验当前密码后生成新的随机密码（写 DB 哈希 + admin-password.txt，明文仅本次返回）。 */
export function resetAdminPassword(currentPassword) {
  if (!verifyCurrentAdminPassword(currentPassword)) throw unauthorized('当前密码错误');
  const password = generateAdminPassword();
  const record = hashPassword(password);
  upsertSetting('security.adminPasswordHash', JSON.stringify(record));
  adminPasswordHashRecord = record;
  writeSecretFile(ADMIN_PASSWORD_FILE, password);
  addSettingsEvent({ action: 'reset_admin_password', source: 'db' });
  log.info('管理密码已重新生成（DB 哈希）', { file: `data/${ADMIN_PASSWORD_FILE}` });
  return {
    ok: true,
    password,
    source: 'db',
    adminPasswordSource: 'db',
    file: `data/${ADMIN_PASSWORD_FILE}`,
  };
}

/** 重新生成 API Token（返回明文仅此一次，DB 存密文 + 写 api-token.txt）。 */
export function rotateApiToken() {
  const token = generateApiToken();
  upsertSetting('security.apiTokenEnc', JSON.stringify(encryptSecret(token)));
  apiTokenEncPresent = true;
  config.secrets.apiToken = token;
  
  upsertSetting('security.pushApiEnabled', 'true');
  config.pushApiEnabled = true;
  writeSecretFile(API_TOKEN_FILE, token);
  addSettingsEvent({ action: 'rotate_api_token', source: 'db', pushApiEnabled: true });
  log.info('API Token 已重新生成（DB 密文）', { file: `data/${API_TOKEN_FILE}` });
  return {
    ok: true,
    token,
    apiTokenPreview: previewToken(token),
    source: 'db',
    apiTokenSource: 'db',
    pushApiEnabled: true,
    file: `data/${API_TOKEN_FILE}`,
  };
}

/** 重置 API Token：生成新的随机 token（同 rotate 语义；不再回退 env/文件）。 */
export function resetApiToken() {
  const token = generateApiToken();
  upsertSetting('security.apiTokenEnc', JSON.stringify(encryptSecret(token)));
  apiTokenEncPresent = true;
  config.secrets.apiToken = token;
  
  upsertSetting('security.pushApiEnabled', 'true');
  config.pushApiEnabled = true;
  writeSecretFile(API_TOKEN_FILE, token);
  addSettingsEvent({ action: 'reset_api_token', source: 'db', pushApiEnabled: true });
  log.info('API Token 已重置（DB 密文）', { file: `data/${API_TOKEN_FILE}` });
  return {
    ok: true,
    token,
    apiTokenPreview: previewToken(token),
    source: 'db',
    apiTokenSource: 'db',
    pushApiEnabled: true,
    file: `data/${API_TOKEN_FILE}`,
  };
}
