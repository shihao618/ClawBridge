/**
 * user_secrets 数据层：用户级命名凭据（模型 2：一条凭据可含多个字段）。
 *
 * 安全约定（docs/ARCHITECTURE.md / docs/PRIVACY.md）：
 * - 字段值整体 `encryptSecret(JSON.stringify(fields))` 后落 `fields_enc`，DB/日志中不出现明文；
 * - `listUserSecrets` 只返回掩码 hints 与元数据，供管理端 API 展示（永不回明文）；
 * - 只有 `getUserSecret` 在进程内返回解密后的 `{field: value}`，仅供凭据注入
 *   （shared/credentials.js，规则/定时通知）内部使用；
 * - `touchUserSecretsUsed` 只更新 `last_used_at`（批量），不改变配置更新时间。
 *
 * 本模块是凭据注入/定时按用户模式依赖的稳定接口：
 *   listUserSecrets(userId) / getUserSecret(userId, name) / touchUserSecretsUsed(userId, names)
 */
import { decryptSecretOrNull, encryptSecret, randomUuid } from '../crypto.js';
import { all, get, nowMs, run } from '../db.js';
import { badRequest } from '../errors.js';

import { parseJsonValue, toNumber } from './helpers.js';

/** 凭据名称：1..32 位字母/数字/下划线/连字符（规则里写作 `{credential:name.field}`）。 */
export const USER_SECRET_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** 字段名：1..32 位字母/数字/下划线/点/连字符（支持 `a.b` 形式）。 */
export const USER_SECRET_FIELD_NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
/** 一条凭据的字段数上限。 */
export const MAX_USER_SECRET_FIELDS = 20;
/** 单个字段值字符数上限。 */
export const MAX_USER_SECRET_VALUE_LENGTH = 4096;
/** label 字符数上限。 */
export const MAX_USER_SECRET_LABEL_LENGTH = 200;
/** 字段 JSON 总字节上限（防止写入超大凭据）。 */
export const MAX_USER_SECRET_TOTAL_BYTES = 32 * 1024;

function newUserSecretId() {
  return `us_${randomUuid()}`;
}

/** 校验凭据名称（非法抛 400 AppError）。 */
export function validateUserSecretName(name) {
  if (typeof name !== 'string' || !USER_SECRET_NAME_RE.test(name)) {
    throw badRequest('凭据名称必须是 1..32 位字母/数字/下划线/连字符');
  }
  return name;
}

/** 校验并归一化 label（可选，≤200 字符）。 */
export function validateUserSecretLabel(label) {
  if (label === undefined || label === null) return '';
  if (typeof label !== 'string') throw badRequest('label 必须是字符串');
  const text = label.trim();
  if (text.length > MAX_USER_SECRET_LABEL_LENGTH) {
    throw badRequest(`label 不能超过 ${MAX_USER_SECRET_LABEL_LENGTH} 个字符`);
  }
  return text;
}

/**
 * 校验并归一化字段对象：`{field: value}`。
 * 规则：字段数 1..20；字段名合法；值必须是非空字符串（≤4096 字符）；JSON 总大小 ≤32KB。
 * @param {unknown} fields
 * @returns {Record<string, string>}
 */
export function validateUserSecretFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw badRequest('fields 必须是对象（{字段名: 字符串值}）');
  }
  const entries = Object.entries(fields);
  if (entries.length < 1 || entries.length > MAX_USER_SECRET_FIELDS) {
    throw badRequest(`fields 必须包含 1..${MAX_USER_SECRET_FIELDS} 个字段`);
  }
  const normalized = {};
  for (const [rawName, rawValue] of entries) {
    const fieldName = String(rawName);
    if (!USER_SECRET_FIELD_NAME_RE.test(fieldName)) {
      throw badRequest(
        `字段名非法：${fieldName}（只允许 1..32 位字母/数字/下划线/点/连字符）`,
      );
    }
    if (typeof rawValue !== 'string') throw badRequest(`字段 ${fieldName} 的值必须是字符串`);
    if (rawValue.length < 1 || rawValue.length > MAX_USER_SECRET_VALUE_LENGTH) {
      throw badRequest(`字段 ${fieldName} 的值长度必须是 1..${MAX_USER_SECRET_VALUE_LENGTH} 个字符`);
    }
    normalized[fieldName] = rawValue;
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_USER_SECRET_TOTAL_BYTES) {
    throw badRequest(`凭据字段总大小不能超过 ${MAX_USER_SECRET_TOTAL_BYTES} 字节`);
  }
  return normalized;
}

/** 单字段掩码：短值全掩码，长值保留末 4 位（如 `••••ab12`）。 */
export function maskUserSecretValue(value) {
  const text = String(value ?? '');
  return text.length > 4 ? `••••${text.slice(-4)}` : '••••';
}

function buildHints(fields) {
  const hints = {};
  for (const [fieldName, value] of Object.entries(fields)) hints[fieldName] = maskUserSecretValue(value);
  return hints;
}

/** DB 原始行 → 对外视图（不含任何明文）。 */
function mapUserSecretRow(row) {
  return {
    name: row.name,
    label: row.label ?? '',
    fieldNames: parseJsonValue(row.field_names, []),
    hints: parseJsonValue(row.hints, {}),
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
    lastUsedAt: toNumber(row.last_used_at),
  };
}

/**
 * 列出某用户的全部凭据元数据（不含明文；按名称升序）。
 * @param {string} userId
 * @returns {Array<{name:string,label:string,fieldNames:string[],hints:Record<string,string>,createdAt:number,updatedAt:number,lastUsedAt:number}>}
 */
export function listUserSecrets(userId) {
  if (!userId) return [];
  return all('SELECT * FROM user_secrets WHERE user_id = ? ORDER BY name ASC', String(userId)).map(mapUserSecretRow);
}

/**
 * 读取并解密一条凭据的字段（仅供内部凭据注入使用，禁止直接暴露给 HTTP API）。
 * @param {string} userId
 * @param {string} name
 * @returns {Record<string,string>|null} 不存在返回 null；解密/内容损坏抛错（错误信息只含名称）
 */
export function getUserSecret(userId, name) {
  if (!userId || typeof name !== 'string' || name === '') return null;
  const row = get('SELECT fields_enc FROM user_secrets WHERE user_id = ? AND name = ?', String(userId), String(name));
  if (!row) return null;
  const plaintext = decryptSecretOrNull(row.fields_enc);
  if (!plaintext) throw new Error(`凭据解密失败：${name}`);
  let fields;
  try {
    fields = JSON.parse(plaintext);
  } catch {
    throw new Error(`凭据内容损坏：${name}`);
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error(`凭据内容非法：${name}`);
  }
  return fields;
}

/**
 * 创建/覆盖一条用户凭据（`UNIQUE(user_id,name)` upsert；保留 created_at/last_used_at）。
 * @param {string} userId
 * @param {{name:string,label?:string,fields:Record<string,string>}} input
 * @returns {object} 对外视图（不含明文）
 */
export function setUserSecret(userId, { name, label = '', fields } = {}) {
  if (!userId) throw badRequest('userId 不能为空');
  const secretName = validateUserSecretName(name);
  const normalizedLabel = validateUserSecretLabel(label);
  const normalizedFields = validateUserSecretFields(fields);
  const fieldNames = Object.keys(normalizedFields);
  const now = nowMs();
  run(
    `INSERT INTO user_secrets
       (id, user_id, name, fields_enc, field_names, hints, label, created_at, updated_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(user_id, name) DO UPDATE SET
       fields_enc = excluded.fields_enc,
       field_names = excluded.field_names,
       hints = excluded.hints,
       label = excluded.label,
       updated_at = excluded.updated_at`,
    newUserSecretId(),
    String(userId),
    secretName,
    encryptSecret(JSON.stringify(normalizedFields)),
    JSON.stringify(fieldNames),
    JSON.stringify(buildHints(normalizedFields)),
    normalizedLabel,
    now,
    now,
  );
  return mapUserSecretRow(
    get('SELECT * FROM user_secrets WHERE user_id = ? AND name = ?', String(userId), secretName),
  );
}

/**
 * 删除一条用户凭据。
 * @returns {boolean} 是否删除了记录
 */
export function deleteUserSecret(userId, name) {
  const result = run('DELETE FROM user_secrets WHERE user_id = ? AND name = ?', String(userId ?? ''), String(name ?? ''));
  return Number(result.changes) > 0;
}

/**
 * 批量更新凭据最近使用时间（供凭据注入链路调用；不改变 updated_at）。
 * @param {string} userId
 * @param {string[]} names
 * @param {number} [ts]
 * @returns {number} 实际更新的行数
 */
export function touchUserSecretsUsed(userId, names, ts = nowMs()) {
  if (!userId || names === null || names === undefined) return 0;
  // 兼容数组 / Set / 其它可迭代集合（凭据注入链路返回 usedNames:Set）。
  let rawNames;
  if (Array.isArray(names)) {
    rawNames = names;
  } else if (typeof names !== 'string' && typeof names[Symbol.iterator] === 'function') {
    rawNames = [...names];
  } else {
    return 0;
  }
  const uniqueNames = [...new Set(rawNames.map((name) => String(name ?? '')).filter((name) => name !== ''))];
  if (uniqueNames.length === 0) return 0;
  const placeholders = uniqueNames.map(() => '?').join(', ');
  const result = run(
    `UPDATE user_secrets SET last_used_at = ?
      WHERE user_id = ? AND name IN (${placeholders})`,
    toNumber(ts),
    String(userId),
    ...uniqueNames,
  );
  return Number(result.changes);
}
