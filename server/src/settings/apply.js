/**
 * 运行配置应用：config 读写、loadOverrides、updateSettings/resetGroup、运行时 hooks。
 *
 * 校验 → 原子落库 → 写内存 config → 运行时 hooks；行为/文案/事件与拆分前一致。
 */
import { config } from '../config.js';
import { all, nowMs, run, transaction } from '../db.js';
import { badRequest } from '../errors.js';
import { logger, setLogLevel } from '../logger.js';

import { addSettingsEvent, upsertSetting } from './persistence.js';
import { DEFAULT_ENV_ONLY, DEFAULTS, FIELD_BY_KEY, GROUPS, readConfigField } from './schema.js';
import { getSecurityState, loadSecretOverrides } from './secrets.js';
import { cloneValue, fail, maskSecret, validateFieldValue } from './validate.js';

const log = logger.child({ mod: 'settings' });

function writeConfigField(field, value) {
  const path = field.configPath;
  if (path.length === 1) {
    config[path[0]] = value;
    return;
  }
  const [group, key] = path;
  if (!config[group]) throw badRequest(`配置分组不存在：${group}`);
  config[group][key] = value;
}

function envOnlyEntries() {
  const show = (key, label, value, secret = false) => ({
    key,
    label,
    value: secret ? maskSecret(value) : value,
    default: secret ? maskSecret(DEFAULT_ENV_ONLY[key]) : DEFAULT_ENV_ONLY[key],
    secret,
  });
  return [
    show('APP_SECRET', 'APP_SECRET（加密主密钥）', config.secrets.appSecret, true),
    show('DATA_DIR', 'DATA_DIR（数据目录）', config.dataDir),
    show('MEDIA_DIR', 'MEDIA_DIR（媒体目录）', config.media.dir),
    show('PORT', 'PORT（监听端口）', String(config.port)),
    show('HOST', 'HOST（监听地址）', config.host),
    show('NODE_ENV', 'NODE_ENV（运行模式）', config.nodeEnv),
  ];
}

// ---------------------------------------------------------------------------
// 运行时 hooks（依赖注入，避免循环 import）
// ---------------------------------------------------------------------------
let hooks = {
  restartKeepalive: () => {},
  restartScheduler: () => {},
  restartAppRules: () => {},
};

/** 注入运行时 hooks（index.js 在各引擎启动后调用；测试可注入 spy）。 */
export function setRuntimeHooks(next = {}) {
  hooks = { ...hooks, ...next };
}

function runRuntimeHooks(changedGroups) {
  const set = new Set(changedGroups);
  const runHook = (name) => {
    try {
      hooks[name]?.();
    } catch (err) {
      log.warn('运行配置 hook 执行失败（已忽略）', { hook: name, message: err?.message });
    }
  };
  if (set.has('keepalive')) runHook('restartKeepalive');
  if (set.has('scheduler')) runHook('restartScheduler');
  if (set.has('appRules')) runHook('restartAppRules');
}

// ---------------------------------------------------------------------------
// 对外函数
// ---------------------------------------------------------------------------

/** 读取当前有效配置（托管分组；测试用）。 */
export function getEffectiveConfig() {
  const result = {};
  for (const group of GROUPS) {
    result[group.key] = {};
    for (const field of group.fields) result[group.key][field.key] = cloneValue(readConfigField(field));
  }
  return result;
}

/** 读取运行配置（分组字段当前值/默认值/范围 + envOnly 脱敏值 + security 状态）。 */
export function getSettings() {
  return {
    groups: GROUPS.map((group) => ({
      key: group.key,
      label: group.label,
      fields: group.fields.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        options: field.options ?? undefined,
        value: cloneValue(readConfigField(field)),
        default: cloneValue(DEFAULTS.get(field.fullKey)),
        min: field.min,
        max: field.max,
        restartRequired: Boolean(field.restartRequired),
        description: field.description ?? '',
      })),
    })),
    envOnly: envOnlyEntries(),
    security: getSecurityState(),
  };
}


/**
 * 启动时加载 DB 覆盖值并写入 config（非法值忽略并 warn，不影响启动）。
 * 不再从 env 迁移机密；机密仅由 DB/bootstrap/rotate 管理。
 * @returns {{applied:number, ignored:number}}
 */
export function loadOverrides() {
  const rows = all('SELECT key, value FROM app_settings');
  let applied = 0;
  let ignored = 0;
  loadSecretOverrides(rows);
  for (const row of rows) {
    if (
      row.key === 'security.adminPasswordHash' ||
      row.key === 'security.apiTokenEnc'
    ) {
      continue;
    }
    const field = FIELD_BY_KEY.get(row.key);
    if (!field) {
      ignored += 1;
      log.warn('忽略未知的运行配置项', { key: row.key });
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(row.value);
    } catch {
      ignored += 1;
      log.warn('忽略非法 JSON 的运行配置项', { key: row.key });
      continue;
    }
    try {
      const value = validateFieldValue(field, raw);
      writeConfigField(field, value);
      applied += 1;
    } catch (err) {
      ignored += 1;
      log.warn('忽略非法运行配置覆盖值', { key: row.key, message: err?.message });
    }
  }
  log.info('运行配置覆盖已加载', { applied, ignored });
  return { applied, ignored };
}

/** 批量更新运行配置：校验 → UPSERT → 立即应用到 config → 运行时 hooks。 */
export function updateSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('请求体必须是对象');
  const groupKeys = Object.keys(patch);
  if (groupKeys.length === 0) fail('至少提交一个配置分组');

  const changes = [];
  for (const groupKey of groupKeys) {
    const group = GROUPS.find((item) => item.key === groupKey);
    if (!group) fail(`未知配置分组：${groupKey}`);
    const values = patch[groupKey];
    if (!values || typeof values !== 'object' || Array.isArray(values)) fail(`${groupKey} 必须是对象`);
    const fieldKeys = Object.keys(values);
    if (fieldKeys.length === 0) fail(`${groupKey} 至少提交一个字段`);
    for (const fieldKey of fieldKeys) {
      const field = group.fields.find((item) => item.key === fieldKey);
      if (!field) fail(`未知配置字段：${groupKey}.${fieldKey}`);
      changes.push({ field, value: validateFieldValue(field, values[fieldKey]) });
    }
  }

  const now = nowMs();
  // 先原子落库；全部成功后再写内存 config/hooks，避免请求中途失败留下部分覆盖。
  transaction(() => {
    for (const change of changes) {
      upsertSetting(change.field.fullKey, JSON.stringify(change.value), now);
    }
  });
  for (const change of changes) {
    writeConfigField(change.field, change.value);
  }

  const changedGroups = [...new Set(changes.map((change) => change.field.group))];
  // logLevel / cookieSecure / publicBaseUrl 等即时类字段的应用
  if (changedGroups.includes('server')) setLogLevel(config.logLevel);
  runRuntimeHooks(changedGroups);
  const restartRequired = changes.filter((change) => change.field.restartRequired).map((change) => change.field.fullKey);
  addSettingsEvent({
    groups: changedGroups,
    fields: changes.map((change) => change.field.fullKey),
  });
  log.info('运行配置已更新', { groups: changedGroups, fields: changes.map((change) => change.field.fullKey), restartRequired });
  return { ok: true, groups: getSettings().groups, restartRequired };
}

/** 恢复某分组为 env 默认值（删除该组 DB 覆盖 + 重新应用 config + hooks）。 */
export function resetGroup(groupKey) {
  const group = GROUPS.find((item) => item.key === groupKey);
  if (!group) fail(`未知配置分组：${groupKey}`);
  const placeholders = group.fields.map(() => '?').join(', ');
  transaction(() => {
    run(
      `DELETE FROM app_settings WHERE key IN (${placeholders})`,
      ...group.fields.map((field) => field.fullKey),
    );
  });
  for (const field of group.fields) writeConfigField(field, cloneValue(DEFAULTS.get(field.fullKey)));
  if (group.key === 'server') setLogLevel(config.logLevel);
  runRuntimeHooks([group.key]);
  addSettingsEvent({ groups: [group.key], fields: ['reset'] });
  log.info('运行配置分组已恢复默认', { group: group.key });
  return { ok: true, groups: getSettings().groups };
}
