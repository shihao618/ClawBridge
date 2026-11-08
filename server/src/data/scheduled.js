/**
 * scheduled_tasks / scheduled_task_logs 域：任务 CRUD、到期/日志、目标解析（docs/SCHEDULED_TASKS.md §1/§5）。
 *
 * 从 store.js 按域拆分（纯搬迁）；listScheduledTasks 批量解析 targets names，消除 N+1。
 */
import { config } from '../config.js';
import { decryptSecretOrNull } from '../crypto.js';
import { all, get, nowMs, run, transaction } from '../db.js';

import { clampInt, copyName, newScheduledTaskId, parseJsonValue, toNumber } from './helpers.js';

// ---------------------------------------------------------------------------
// 定时通知（schema v7：scheduled_tasks / scheduled_task_logs，docs/SCHEDULED_TASKS.md §1/§5）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 批量解析 targets names（消除 listScheduledTasks 的 N+1）
// ---------------------------------------------------------------------------

/** 批量 id → 名称映射（一次 IN 查询）。表名/列名来自内部常量，值全部参数化。 */
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
 * 构造 target ids → 名称解析器：一次批量查询 users/groups 后内存映射，
 * 语义与逐条 getGroupRow/getUserRow 查询一致（行不存在时回退 id）。
 * @param {object[]} rows 任务原始行
 * @returns {(targetType:string, ids:string[]) => string[]}
 */
function buildScheduledTargetNameResolver(rows) {
  const groupIds = [];
  const userIds = [];
  for (const row of rows) {
    const targetType = row?.target_type ?? 'users';
    if (targetType !== 'groups' && targetType !== 'users') continue;
    const ids = parseJsonValue(row.target_ids, []);
    if (!Array.isArray(ids)) continue;
    for (const id of ids) (targetType === 'groups' ? groupIds : userIds).push(String(id));
  }
  const groupNames = fetchNameMap('groups', groupIds, 'name');
  const userNames = fetchNameMap('users', userIds, 'display_name');
  return (targetType, ids) => {
    if (!Array.isArray(ids)) return [];
    if (targetType === 'groups') return ids.map((id) => groupNames.get(String(id)) ?? id);
    return ids.map((id) => userNames.get(String(id)) ?? id);
  };
}

/** 目标 id → 名称（单任务视图回退路径；复用批量查询实现）。 */
function resolveScheduledTargetNames(targetType, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const resolver = buildScheduledTargetNameResolver([{ target_type: targetType, target_ids: JSON.stringify(ids) }]);
  return resolver(targetType, ids);
}

/** 任务对外视图（GET；header 只返回键名，不含值）。 */
export function mapScheduledTaskRow(row, { targetNames } = {}) {
  if (!row) return null;
  const headers = parseJsonValue(decryptSecretOrNull(row.request_headers_enc), null);
  const targetIds = parseJsonValue(row.target_ids, []);
  const targetType = row.target_type ?? 'users';
  return {
    id: row.id,
    name: row.name ?? '',
    enabled: Boolean(row.enabled),
    // 按用户模式（schema v1）：逐目标用户解析凭据并分别请求/回复
    perUserMode: Boolean(row.per_user_mode),
    schedule: {
      type: row.schedule_type ?? 'interval',
      intervalMs: toNumber(row.interval_ms),
      dailyTime: row.daily_time ?? '08:00',
      // 每日生效时间段（仅 interval；空字符串表示不限）
      windowStart: row.window_start ?? '',
      windowEnd: row.window_end ?? '',
      timezone: config.scheduler.timezone,
    },
    targets: {
      type: targetType,
      ids: Array.isArray(targetIds) ? targetIds : [],
      names: targetType === 'all'
        ? ['全部用户']
        : targetNames
          ? targetNames(targetType, Array.isArray(targetIds) ? targetIds : [])
          : resolveScheduledTargetNames(targetType, Array.isArray(targetIds) ? targetIds : []),
    },
    request: {
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
    limits: { timeoutMs: toNumber(row.timeout_ms) },
    nextRunAt: toNumber(row.next_run_at),
    lastRunAt: toNumber(row.last_run_at),
    lastStatus: row.last_status ?? '',
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  };
}

/** 任务原始行。 */
export function getScheduledTaskRow(id) {
  return get('SELECT * FROM scheduled_tasks WHERE id = ?', String(id ?? ''));
}

/** 单任务视图。 */
export function getScheduledTask(id) {
  return mapScheduledTaskRow(getScheduledTaskRow(id));
}

/** 任务列表（默认含 disabled，按创建时间倒序）。 */
export function listScheduledTasks({ includeDisabled = true } = {}) {
  const rows = includeDisabled
    ? all('SELECT * FROM scheduled_tasks ORDER BY created_at DESC, id DESC')
    : all('SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY created_at DESC, id DESC');
  if (rows.length === 0) return [];
  // 批量解析 targets names（每个 target id 一次查询 → 每个列表 2 条 SQL）。
  const targetNames = buildScheduledTargetNameResolver(rows);
  return rows.map((row) => mapScheduledTaskRow(row, { targetNames }));
}

const SCHEDULED_TASK_COLUMNS = {
  name: 'name',
  enabled: 'enabled',
  scheduleType: 'schedule_type',
  intervalMs: 'interval_ms',
  dailyTime: 'daily_time',
  windowStart: 'window_start',
  windowEnd: 'window_end',
  targetType: 'target_type',
  targetIds: 'target_ids',
  perUserMode: 'per_user_mode',
  requestMethod: 'request_method',
  requestUrl: 'request_url',
  requestHeadersEnc: 'request_headers_enc',
  requestBodyTemplate: 'request_body_template',
  responseType: 'response_type',
  responsePath: 'response_path',
  replyTemplate: 'reply_template',
  fallbackText: 'fallback_text',
  timeoutMs: 'timeout_ms',
  nextRunAt: 'next_run_at',
};

function scheduledTaskColumnValue(key, value) {
  if (key === 'targetIds') return JSON.stringify(Array.isArray(value) ? value : []);
  if (key === 'enabled' || key === 'perUserMode') return value ? 1 : 0;
  if (key === 'intervalMs' || key === 'timeoutMs' || key === 'nextRunAt') return toNumber(value);
  if (value === undefined || value === null) return '';
  return String(value);
}

/** 创建任务（入参为已校验的扁平 camelCase 字段）。 */
export function createScheduledTask(input) {
  const now = nowMs();
  const id = newScheduledTaskId();
  const fields = Object.keys(SCHEDULED_TASK_COLUMNS).filter((key) => input[key] !== undefined);
  const columns = ['id', ...fields.map((key) => SCHEDULED_TASK_COLUMNS[key]), 'created_at', 'updated_at'];
  const values = [id, ...fields.map((key) => scheduledTaskColumnValue(key, input[key])), now, now];
  run(`INSERT INTO scheduled_tasks (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...values);
  return getScheduledTask(id);
}

/** 复制定时任务（含加密 headers；副本默认停用、无下次运行时间，日志不复制）。 */
export function duplicateScheduledTask(id) {
  const row = getScheduledTaskRow(id);
  if (!row) return null;
  const now = nowMs();
  const newId = newScheduledTaskId();
  const copiedColumns = [
    'schedule_type',
    'interval_ms',
    'daily_time',
    'window_start',
    'window_end',
    'target_type',
    'target_ids',
    'per_user_mode',
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
    `INSERT INTO scheduled_tasks
       (id, name, enabled, ${copiedColumns.join(', ')},
        last_run_at, last_status, next_run_at, created_at, updated_at)
     SELECT ?, ?, 0, ${copiedColumns.join(', ')}, 0, '', 0, ?, ?
     FROM scheduled_tasks WHERE id = ?`,
    newId,
    copyName(row.name, '未命名任务'),
    now,
    now,
    String(id),
  );
  return getScheduledTask(newId);
}

/** 更新任务（部分字段；不存在返回 null）。 */
export function updateScheduledTask(id, patch) {
  if (!getScheduledTaskRow(id)) return null;
  const fields = Object.keys(SCHEDULED_TASK_COLUMNS).filter((key) => patch[key] !== undefined);
  if (fields.length === 0) return getScheduledTask(id);
  const sets = fields.map((key) => `${SCHEDULED_TASK_COLUMNS[key]} = ?`);
  const values = fields.map((key) => scheduledTaskColumnValue(key, patch[key]));
  run(`UPDATE scheduled_tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...values, nowMs(), String(id));
  return getScheduledTask(id);
}

/** 删除任务（运行日志保留供审计）。 */
export function deleteScheduledTask(id) {
  return Number(run('DELETE FROM scheduled_tasks WHERE id = ?', String(id)).changes) > 0;
}

/** 到期任务（enabled=1 AND next_run_at<=now，按 next_run_at ASC 取 limit 个）。 */
export function listDueScheduledTasks(now = nowMs(), limit = 10) {
  return all(
    'SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC LIMIT ?',
    toNumber(now),
    clampInt(limit, { min: 1, max: 100, fallback: 10 }),
  );
}

/** 写回任务执行结果（last_run_at/last_status/next_run_at）。 */
export function markScheduledTaskRun(id, { lastRunAt = nowMs(), lastStatus = '', nextRunAt = 0 } = {}) {
  const result = run(
    'UPDATE scheduled_tasks SET last_run_at = ?, last_status = ?, next_run_at = ? WHERE id = ?',
    toNumber(lastRunAt),
    String(lastStatus ?? ''),
    toNumber(nextRunAt),
    String(id),
  );
  return Number(result.changes) > 0;
}

/** 写入任务运行日志。 */
export function insertScheduledTaskLog({
  taskId,
  status = 'success',
  httpStatus = null,
  latencyMs = null,
  error = '',
  responsePreview = '',
  replyPreview = '',
  recipientsCount = 0,
  createdAt = nowMs(),
} = {}) {
  const result = run(
    `INSERT INTO scheduled_task_logs
       (task_id, status, http_status, latency_ms, error, response_preview, reply_preview, recipients_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    String(taskId),
    String(status),
    httpStatus === null || httpStatus === undefined ? null : toNumber(httpStatus),
    latencyMs === null || latencyMs === undefined ? null : toNumber(latencyMs),
    String(error ?? '').slice(0, 1000),
    String(responsePreview ?? '').slice(0, 2000),
    String(replyPreview ?? '').slice(0, 2000),
    toNumber(recipientsCount),
    toNumber(createdAt),
  );
  return Number(result.lastInsertRowid);
}

/**
 * 原子写回定时任务执行结果：运行日志 + last_run/next_run 同一事务。
 *
 * 避免“日志已写、next_run_at 未更新”或反之导致的退出/重启后重复执行或日志丢失。
 * @returns {{logId:number, updated:boolean}}
 */
export function completeScheduledTaskRun({
  taskId,
  log = {},
  lastRunAt = nowMs(),
  lastStatus = '',
  nextRunAt = 0,
} = {}) {
  return transaction(() => {
    const logId = insertScheduledTaskLog({ ...log, taskId });
    const updated = markScheduledTaskRun(taskId, { lastRunAt, lastStatus, nextRunAt });
    return { logId, updated };
  });
}

/** 任务运行日志列表（taskId/status 过滤 + 分页，带 taskName）。 */
export function listScheduledTaskLogs({ taskId = '', status = '', limit = 50, offset = 0 } = {}) {
  const filters = [];
  const args = [];
  if (taskId) {
    filters.push('l.task_id = ?');
    args.push(String(taskId));
  }
  if (status) {
    filters.push('l.status = ?');
    args.push(String(status));
  }
  const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const total = toNumber(get(`SELECT COUNT(*) AS c FROM scheduled_task_logs l ${whereSql}`, ...args).c);
  const rows = all(
    `SELECT l.*, t.name AS task_name FROM scheduled_task_logs l LEFT JOIN scheduled_tasks t ON t.id = l.task_id
     ${whereSql} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    ...args,
    clampInt(limit, { min: 1, max: 500, fallback: 50 }),
    clampInt(offset, { min: 0, max: 10_000_000, fallback: 0 }),
  );
  return {
    total,
    items: rows.map((row) => ({
      id: Number(row.id),
      taskId: row.task_id,
      taskName: row.task_name ?? '',
      status: row.status,
      httpStatus: row.http_status === null ? null : toNumber(row.http_status),
      latencyMs: row.latency_ms === null ? null : toNumber(row.latency_ms),
      error: row.error ?? '',
      responsePreview: row.response_preview ?? '',
      replyPreview: row.reply_preview ?? '',
      recipientsCount: toNumber(row.recipients_count),
      createdAt: toNumber(row.created_at),
    })),
  };
}

/**
 * 解析任务目标收件人（docs/SCHEDULED_TASKS.md §4.5）：
 * users → target_ids 中 status='active'；groups → 分组成员中 status='active'；按 id 稳定排序、去重、
 * 上限 maxRecipients 截断。返回 { userIds, total, truncated }。
 */
export function resolveScheduledTaskRecipients(taskRow, { maxRecipients = config.scheduler.maxRecipients } = {}) {
  if (!taskRow) return { userIds: [], total: 0, truncated: false };
  const ids = parseJsonValue(taskRow.target_ids, []);
  const targetIds = Array.isArray(ids) ? ids.map(String) : [];
  const targetType = taskRow.target_type ?? 'users';
  let rows = [];
  if (targetType === 'all') {
    rows = all("SELECT id FROM users WHERE status = 'active' ORDER BY id ASC");
  } else if (targetIds.length > 0) {
    const placeholders = targetIds.map(() => '?').join(', ');
    if (targetType === 'groups') {
      rows = all(
        `SELECT DISTINCT u.id AS id FROM user_groups ug JOIN users u ON u.id = ug.user_id
         WHERE ug.group_id IN (${placeholders}) AND u.status = 'active' ORDER BY u.id ASC`,
        ...targetIds,
      );
    } else {
      rows = all(
        `SELECT id FROM users WHERE id IN (${placeholders}) AND status = 'active' ORDER BY id ASC`,
        ...targetIds,
      );
    }
  }
  const unique = [...new Set(rows.map((row) => String(row.id)))].sort();
  const limit = clampInt(maxRecipients, { min: 1, max: 100000, fallback: 200 });
  return {
    userIds: unique.slice(0, limit),
    total: unique.length,
    truncated: unique.length > limit,
  };
}
