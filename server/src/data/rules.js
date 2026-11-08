/**
 * app_rules / app_rule_logs 域：规则 CRUD、运行日志、视图映射（docs/API_RULES.md §1/§7）。
 *
 * 从 store.js 按域拆分（纯搬迁）；listAppRules 批量查询 stats/scope names，消除 N+1。
 */
import { decryptSecretOrNull } from '../crypto.js';
import { all, get, nowMs, run } from '../db.js';

import { clampInt, copyName, newAppRuleId, parseJsonValue, toNumber } from './helpers.js';

// ---------------------------------------------------------------------------
// 接口应用（schema v5：app_rules / app_rule_logs，docs/API_RULES.md §1/§7）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 批量解析（消除 listAppRules 的 N+1：stats / scope names）
// ---------------------------------------------------------------------------

/** 空规则统计（与 getAppRuleStats 的默认结构一致）。 */
function emptyAppRuleStats() {
  return { lastRunAt: 0, lastStatus: '', success24h: 0, failed24h: 0, skipped24h: 0 };
}

/**
 * 批量 id → 名称映射（一次 IN 查询）。表名/列名来自内部常量，值全部参数化。
 * @param {'groups'|'users'} table
 * @param {string[]} ids
 * @param {string} column
 * @returns {Map<string, string|null>}
 */
function fetchNameMap(table, ids, column) {
  const names = new Map();
  const unique = [...new Set(ids.map((id) => String(id)))].filter(Boolean);
  if (unique.length === 0) return names;
  const placeholders = unique.map(() => '?').join(', ');
  for (const row of all(`SELECT id, ${column} AS name FROM ${table} WHERE id IN (${placeholders})`, ...unique)) {
    names.set(row.id, row.name);
  }
  return names;
}

/**
 * 构造 scope ids → 名称解析器：一次批量查询 users/groups 后内存映射，
 * 语义与逐条 getGroupRow/getUserRow 查询一致（行不存在时回退 id）。
 * @param {object[]} rows 规则原始行
 * @returns {(scopeType:string, ids:string[]) => string[]}
 */
function buildScopeNameResolver(rows) {
  const groupIds = [];
  const userIds = [];
  for (const row of rows) {
    const scopeType = row?.scope_type ?? 'all';
    if (scopeType !== 'groups' && scopeType !== 'users') continue;
    const ids = parseJsonValue(row.scope_ids, []);
    if (!Array.isArray(ids)) continue;
    for (const id of ids) (scopeType === 'groups' ? groupIds : userIds).push(String(id));
  }
  const groupNames = fetchNameMap('groups', groupIds, 'name');
  const userNames = fetchNameMap('users', userIds, 'display_name');
  return (scopeType, ids) => {
    if (!Array.isArray(ids)) return [];
    if (scopeType === 'groups') return ids.map((id) => groupNames.get(String(id)) ?? id);
    if (scopeType === 'users') return ids.map((id) => userNames.get(String(id)) ?? id);
    return [];
  };
}

/** 分组/用户 id → 名称（单规则视图回退路径；复用批量查询实现）。 */
function resolveScopeNames(scopeType, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const resolver = buildScopeNameResolver([{ scope_type: scopeType, scope_ids: JSON.stringify(ids) }]);
  return resolver(scopeType, ids);
}

/**
 * 批量规则统计：一条 GROUP BY 聚合 24h 计数 + 一条 MAX(id) 查询最近状态，
 * 替代 mapAppRuleRow 每条规则 2 条 SQL 的 N+1。
 * @param {string[]} ruleIds
 * @param {number} [now]
 * @returns {Map<string, object>}
 */
function getAppRuleStatsBatch(ruleIds, now = nowMs()) {
  const ids = [...new Set((ruleIds ?? []).map((id) => String(id)))].filter(Boolean);
  const statsById = new Map(ids.map((id) => [id, emptyAppRuleStats()]));
  if (ids.length === 0) return statsById;
  const placeholders = ids.map(() => '?').join(', ');
  const since = toNumber(now) - 24 * 60 * 60 * 1000;
  for (const row of all(
    `SELECT rule_id, status, COUNT(*) AS c FROM app_rule_logs
     WHERE rule_id IN (${placeholders}) AND created_at >= ?
     GROUP BY rule_id, status`,
    ...ids,
    since,
  )) {
    const stats = statsById.get(row.rule_id);
    if (!stats) continue;
    if (row.status === 'success' || row.status === 'failed' || row.status === 'skipped') {
      stats[`${row.status}24h`] = toNumber(row.c);
    }
  }
  for (const row of all(
    `SELECT l.rule_id, l.created_at, l.status FROM app_rule_logs l
     JOIN (SELECT rule_id, MAX(id) AS max_id FROM app_rule_logs
           WHERE rule_id IN (${placeholders}) GROUP BY rule_id) latest
       ON l.id = latest.max_id`,
    ...ids,
  )) {
    const stats = statsById.get(row.rule_id);
    if (!stats) continue;
    stats.lastRunAt = toNumber(row.created_at);
    stats.lastStatus = row.status ?? '';
  }
  return statsById;
}


/** 规则统计（lastRunAt/lastStatus + 24h 计数）。 */
export function getAppRuleStats(ruleId, now = nowMs()) {
  const last = get('SELECT created_at, status FROM app_rule_logs WHERE rule_id = ? ORDER BY id DESC LIMIT 1', String(ruleId));
  const since = toNumber(now) - 24 * 60 * 60 * 1000;
  const counts = { success: 0, failed: 0, skipped: 0 };
  for (const row of all(
    'SELECT status, COUNT(*) AS c FROM app_rule_logs WHERE rule_id = ? AND created_at >= ? GROUP BY status',
    String(ruleId),
    since,
  )) {
    if (row.status in counts) counts[row.status] = toNumber(row.c);
  }
  return {
    lastRunAt: last ? toNumber(last.created_at) : 0,
    lastStatus: last?.status ?? '',
    success24h: counts.success,
    failed24h: counts.failed,
    skipped24h: counts.skipped,
  };
}

/** 规则对外视图（GET）——不含任何 header 值，只返回 headerNames。 */
export function mapAppRuleRow(row, { includeStats = true, now = nowMs(), stats, scopeNames } = {}) {
  if (!row) return null;
  const headers = parseJsonValue(decryptSecretOrNull(row.request_headers_enc), null);
  const scopeIds = parseJsonValue(row.scope_ids, []);
  const scopeType = row.scope_type ?? 'all';
  const keywords = parseJsonValue(row.keywords, []);
  const extractionConfig = parseJsonValue(row.extraction_config, {});
  const id = row.id;
  return {
    id,
    name: row.name ?? '',
    enabled: Boolean(row.enabled),
    priority: toNumber(row.priority),
    scope: {
      type: scopeType,
      ids: scopeIds,
      names: scopeNames ? scopeNames(scopeType, scopeIds) : resolveScopeNames(scopeType, scopeIds),
    },
    trigger: {
      matchMode: row.match_mode ?? 'contains',
      keywords,
      regexPattern: row.regex_pattern ?? '',
    },
    extraction: {
      mode: row.extraction_mode ?? 'none',
      config: extractionConfig,
    },
    request: {
      mode: row.request_url ? 'http' : 'none',
      method: row.request_method ?? 'GET',
      url: row.request_url ?? '',
      headerNames: headers && typeof headers === 'object' ? Object.keys(headers) : [],
      bodyTemplate: row.request_body_template ?? '',
    },
    response: {
      type: row.response_type ?? 'json',
      path: row.response_path ?? '',
      template: row.reply_template ?? '',
      fallbackText: row.fallback_text ?? '',
    },
    limits: {
      timeoutMs: toNumber(row.timeout_ms),
    },
    stats: includeStats ? (stats ?? getAppRuleStats(id, now)) : emptyAppRuleStats(),
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  };
}

/** 规则原始行（引擎执行用；header 值仍需解密，不对外暴露）。 */
export function getAppRuleRow(id) {
  return get('SELECT * FROM app_rules WHERE id = ?', String(id ?? ''));
}

/** 单条规则对外视图。 */
export function getAppRule(id, options = {}) {
  return mapAppRuleRow(getAppRuleRow(id), options);
}

/** 规则列表（默认只返回 enabled 的规则；按 priority ASC, created_at ASC）。 */
export function listAppRules({ includeDisabled = false, includeStats = true } = {}) {
  const rows = includeDisabled
    ? all('SELECT * FROM app_rules ORDER BY priority ASC, created_at ASC, id ASC')
    : all('SELECT * FROM app_rules WHERE enabled = 1 ORDER BY priority ASC, created_at ASC, id ASC');
  if (rows.length === 0) return [];
  // 批量查询规则 stats 与 scope names（每条规则 2 条 SQL → 全列表 2 条 SQL）。
  const statsById = includeStats ? getAppRuleStatsBatch(rows.map((row) => row.id)) : null;
  const resolveNames = buildScopeNameResolver(rows);
  return rows.map((row) =>
    mapAppRuleRow(row, {
      includeStats,
      stats: includeStats ? statsById.get(row.id) : undefined,
      scopeNames: resolveNames,
    }),
  );
}

/** 引擎执行用：enabled 规则原始行（priority ASC, created_at ASC）。 */
export function listEnabledAppRuleRows() {
  return all('SELECT * FROM app_rules WHERE enabled = 1 ORDER BY priority ASC, created_at ASC, id ASC');
}

const APP_RULE_COLUMNS = {
  name: 'name',
  enabled: 'enabled',
  priority: 'priority',
  scopeType: 'scope_type',
  scopeIds: 'scope_ids',
  matchMode: 'match_mode',
  keywords: 'keywords',
  regexPattern: 'regex_pattern',
  extractionMode: 'extraction_mode',
  extractionConfig: 'extraction_config',
  requestMethod: 'request_method',
  requestUrl: 'request_url',
  requestHeadersEnc: 'request_headers_enc',
  requestBodyTemplate: 'request_body_template',
  responseType: 'response_type',
  responsePath: 'response_path',
  replyTemplate: 'reply_template',
  fallbackText: 'fallback_text',
  timeoutMs: 'timeout_ms',
};

/** 字段值序列化：JSON 字段与布尔/数字列。 */
function appRuleColumnValue(key, value) {
  if (key === 'scopeIds' || key === 'keywords' || key === 'extractionConfig') return JSON.stringify(value ?? (key === 'extractionConfig' ? {} : []));
  if (key === 'enabled') return value ? 1 : 0;
  if (['priority', 'timeoutMs'].includes(key)) return toNumber(value);
  if (value === undefined || value === null) return '';
  return String(value);
}

/** 创建规则（入参为已校验的扁平 camelCase 字段）。 */
export function createAppRule(input) {
  const now = nowMs();
  const id = newAppRuleId();
  const fields = Object.keys(APP_RULE_COLUMNS).filter((key) => input[key] !== undefined);
  const columns = ['id', ...fields.map((key) => APP_RULE_COLUMNS[key]), 'created_at', 'updated_at'];
  const values = [id, ...fields.map((key) => appRuleColumnValue(key, input[key])), now, now];
  run(
    `INSERT INTO app_rules (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ...values,
  );
  return getAppRule(id);
}

/** 复制规则（含加密 headers；副本默认停用，运行日志不复制）。 */
export function duplicateAppRule(id) {
  const row = getAppRuleRow(id);
  if (!row) return null;
  const now = nowMs();
  const newId = newAppRuleId();
  const copiedColumns = [
    'priority',
    'scope_type',
    'scope_ids',
    'match_mode',
    'keywords',
    'regex_pattern',
    'extraction_mode',
    'extraction_config',
    'request_method',
    'request_url',
    'request_headers_enc',
    'request_body_template',
    'response_type',
    'response_path',
    'reply_template',
    'fallback_text',
    'timeout_ms',
  ];
  run(
    `INSERT INTO app_rules
       (id, name, enabled, ${copiedColumns.join(', ')}, created_at, updated_at)
     SELECT ?, ?, 0, ${copiedColumns.join(', ')}, ?, ?
     FROM app_rules WHERE id = ?`,
    newId,
    copyName(row.name, '未命名规则'),
    now,
    now,
    String(id),
  );
  return getAppRule(newId);
}

/** 更新规则（部分字段；未传字段不变）。 */
export function updateAppRule(id, patch) {
  if (!getAppRuleRow(id)) return null;
  const fields = Object.keys(APP_RULE_COLUMNS).filter((key) => patch[key] !== undefined);
  if (fields.length === 0) return getAppRule(id);
  const sets = fields.map((key) => `${APP_RULE_COLUMNS[key]} = ?`);
  const values = fields.map((key) => appRuleColumnValue(key, patch[key]));
  run(`UPDATE app_rules SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...values, nowMs(), String(id));
  return getAppRule(id);
}

/** 删除规则（日志保留用于审计）。 */
export function deleteAppRule(id) {
  const result = run('DELETE FROM app_rules WHERE id = ?', String(id));
  return Number(result.changes) > 0;
}

/**
 * 写入规则运行日志；同 (rule_id, inbound_message_id) 唯一索引冲突 → inserted:false（去重跳过）。
 * @returns {{inserted:boolean, id:number|null, deduped:boolean}}
 */
export function insertAppRuleLog({
  ruleId,
  userId = null,
  inboundMessageId = null,
  status = 'matched',
  httpStatus = null,
  latencyMs = null,
  error = '',
  paramsPreview = '',
  requestPreview = '',
  responsePreview = '',
  replyOutboxId = null,
  createdAt = nowMs(),
} = {}) {
  const result = run(
    `INSERT OR IGNORE INTO app_rule_logs
       (rule_id, user_id, inbound_message_id, status, http_status, latency_ms, error,
        params_preview, request_preview, response_preview, reply_outbox_id, created_at)
     VALUES (?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    String(ruleId),
    userId ? String(userId) : null,
    inboundMessageId === null || inboundMessageId === undefined ? '' : String(inboundMessageId),
    String(status),
    httpStatus === null || httpStatus === undefined ? null : toNumber(httpStatus),
    latencyMs === null || latencyMs === undefined ? null : toNumber(latencyMs),
    String(error ?? '').slice(0, 1000),
    String(paramsPreview ?? '').slice(0, 2000),
    String(requestPreview ?? '').slice(0, 1000),
    String(responsePreview ?? '').slice(0, 2000),
    replyOutboxId ? String(replyOutboxId) : null,
    toNumber(createdAt),
  );
  const inserted = Number(result.changes) > 0;
  return {
    inserted,
    deduped: !inserted,
    id: inserted ? Number(result.lastInsertRowid) : null,
  };
}

/** 更新一条运行日志的终态/结果字段。 */
export function updateAppRuleLog(id, patch = {}) {
  const mapping = {
    status: 'status',
    httpStatus: 'http_status',
    latencyMs: 'latency_ms',
    error: 'error',
    paramsPreview: 'params_preview',
    requestPreview: 'request_preview',
    responsePreview: 'response_preview',
    replyOutboxId: 'reply_outbox_id',
  };
  const fields = Object.keys(mapping).filter((key) => patch[key] !== undefined);
  if (fields.length === 0) return false;
  const sets = fields.map((key) => `${mapping[key]} = ?`);
  const values = fields.map((key) => {
    if (key === 'httpStatus' || key === 'latencyMs') return toNumber(patch[key]);
    if (key === 'replyOutboxId') return patch[key] ? String(patch[key]) : null;
    if (key === 'error') return String(patch[key] ?? '').slice(0, 1000);
    if (key === 'paramsPreview') return String(patch[key] ?? '').slice(0, 2000);
    if (key === 'requestPreview') return String(patch[key] ?? '').slice(0, 1000);
    if (key === 'responsePreview') return String(patch[key] ?? '').slice(0, 2000);
    return String(patch[key]);
  });
  const result = run(`UPDATE app_rule_logs SET ${sets.join(', ')} WHERE id = ?`, ...values, Number(id));
  return Number(result.changes) > 0;
}

/** 规则运行日志列表（ruleId/status/userId 过滤 + 分页）。 */
export function listAppRuleLogs({ ruleId = '', status = '', userId = '', limit = 50, offset = 0 } = {}) {
  const filters = [];
  const args = [];
  if (ruleId) {
    filters.push('l.rule_id = ?');
    args.push(String(ruleId));
  }
  if (status) {
    filters.push('l.status = ?');
    args.push(String(status));
  }
  if (userId) {
    filters.push('l.user_id = ?');
    args.push(String(userId));
  }
  const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const total = toNumber(get(`SELECT COUNT(*) AS c FROM app_rule_logs l ${whereSql}`, ...args).c);
  const rows = all(
    `SELECT l.*, r.name AS rule_name FROM app_rule_logs l LEFT JOIN app_rules r ON r.id = l.rule_id
     ${whereSql} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    ...args,
    clampInt(limit, { min: 1, max: 500, fallback: 50 }),
    clampInt(offset, { min: 0, max: 10_000_000, fallback: 0 }),
  );
  return {
    total,
    items: rows.map((row) => ({
      id: Number(row.id),
      ruleId: row.rule_id,
      ruleName: row.rule_name ?? '',
      userId: row.user_id ?? '',
      status: row.status,
      httpStatus: row.http_status === null ? null : toNumber(row.http_status),
      latencyMs: row.latency_ms === null ? null : toNumber(row.latency_ms),
      error: row.error ?? '',
      paramsPreview: row.params_preview ?? '',
      requestPreview: row.request_preview ?? '',
      responsePreview: row.response_preview ?? '',
      replyOutboxId: row.reply_outbox_id ?? null,
      createdAt: toNumber(row.created_at),
    })),
  };
}
