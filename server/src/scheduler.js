/**
 * 定时通知调度器（docs/SCHEDULED_TASKS.md）。
 *
 * 流程：tick 扫描到期任务 → 渲染外部请求（{now}/{date}/{time}/{taskName}）→ 调用接口
 * （复用 app-rules 的 SSRF/超时/大小防护）→ 解析响应/渲染通知 → 逐目标入队 outbox
 * （source='schedule'，由 dispatcher 统一限流投递）→ 写 scheduled_task_logs → 更新 next_run_at。
 *
 * 计划：interval（从执行开始时间 + 间隔；启动时过期 ≤5min 补跑否则顺延）与
 * daily（SCHEDULER_TIMEZONE 的 HH:mm；过期立即补跑一次）。
 */
import { config } from './config.js';
import { decryptSecretOrNull } from './crypto.js';
import { logger } from './logger.js';
import {
  parseResponse,
  renderReplyTemplate,
  renderRequestTemplate,
  requestExternal,
  truncate,
} from './app-rules.js';
import * as store from './store.js';

const log = logger.child({ mod: 'scheduler' });

const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CATCHUP_MS = 5 * 60 * 1000;
const TICK_BATCH = 10;

/** 可注入依赖（测试用；默认真实 Date/fetch）。 */
const defaultDeps = {
  now: () => Date.now(),
  fetch: (...args) => globalThis.fetch(...args),
};
let deps = { ...defaultDeps };
export function configureDependencies(overrides = {}) {
  deps = { ...deps, ...overrides };
}
export function resetDependencies() {
  deps = { ...defaultDeps };
}

// ---------------------------------------------------------------------------
// 计划计算（纯函数，便于单测）
// ---------------------------------------------------------------------------

/** 解析 HH:mm；非法返回 null。 */
export function parseDailyTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const zoneFormatters = new Map();
function getZoneFormatter(timeZone) {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function getTimeZoneOffsetMs(timeZone, utcMs) {
  const formatter = getZoneFormatter(timeZone);
  const parts = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcMs;
}

/** 时区本地墙钟时间 → UTC 毫秒（夏令时取最近一次换算，足够 daily 使用）。 */
export function zonedWallTimeToUtc(year, month, day, hour, minute, timeZone = config.scheduler.timezone, second = 0) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = target;
  for (let i = 0; i < 2; i += 1) {
    const offset = getTimeZoneOffsetMs(timeZone, utc);
    utc = target - offset;
  }
  return utc;
}

/** 获取指定时间戳在时区内的本地日期/时间字段。 */
export function getZonedParts(ts, timeZone = config.scheduler.timezone) {
  const formatter = getZoneFormatter(timeZone);
  const parts = {};
  for (const part of formatter.formatToParts(new Date(Number(ts)))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** 下一次 daily 触发时间（严格 > now；今天已过则明天，跨天/跨月/跨年由 Date.UTC 处理）。 */
export function computeDailyNextRun(now, dailyTime, timeZone = config.scheduler.timezone) {
  const parsed = parseDailyTime(dailyTime);
  if (!parsed) return null;
  const local = getZonedParts(now, timeZone);
  const todayCandidate = zonedWallTimeToUtc(local.year, local.month, local.day, parsed.hour, parsed.minute, timeZone);
  if (todayCandidate > now) return todayCandidate;
  const nextDayUtc = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return zonedWallTimeToUtc(
    nextDayUtc.getUTCFullYear(),
    nextDayUtc.getUTCMonth() + 1,
    nextDayUtc.getUTCDate(),
    parsed.hour,
    parsed.minute,
    timeZone,
  );
}

/** 兼容多种任务对象形态（DB row / API patch / store view）读取计划类型与 daily 时间。 */
function scheduleTypeOf(task) {
  return task?.schedule?.type ?? task?.schedule_type ?? task?.scheduleType ?? 'interval';
}

function dailyTimeOf(task) {
  return task?.schedule?.dailyTime ?? task?.daily_time ?? task?.dailyTime ?? '08:00';
}

/** 创建任务时的初始 next_run_at（interval=now+interval；daily=下一次 daily）。 */
export function computeInitialNextRun(task, now = deps.now()) {
  const scheduleType = scheduleTypeOf(task);
  if (scheduleType === 'daily') {
    return computeDailyNextRun(now, dailyTimeOf(task), config.scheduler.timezone) ?? now + 60_000;
  }
  const intervalMs = Number(task.intervalMs ?? task.interval_ms ?? 3600000);
  const clamped = Math.min(MAX_INTERVAL_MS, Math.max(60_000, Number.isFinite(intervalMs) ? intervalMs : 3600000));
  return Number(now) + clamped;
}

/** 本次执行开始后的下一次触发时间（interval=执行开始+间隔；daily=下一次本地 HH:mm）。 */
export function computeNextAfterRun(task, runStartedAt) {
  const scheduleType = scheduleTypeOf(task);
  if (scheduleType === 'daily') {
    return (
      computeDailyNextRun(runStartedAt, dailyTimeOf(task), config.scheduler.timezone) ??
      Number(runStartedAt) + 24 * 60 * 60 * 1000
    );
  }
  const intervalMs = Math.min(
    MAX_INTERVAL_MS,
    Math.max(60_000, Number(task.interval_ms ?? task.intervalMs ?? task?.schedule?.intervalMs ?? 3600000) || 3600000),
  );
  return Number(runStartedAt) + intervalMs;
}

/** 超过补跑窗口的 interval 任务顺延到下一个周期（避免重启后积压爆发）。 */
export function advanceIntervalNextRun(nextRunAt, intervalMs, now) {
  const interval = Math.min(MAX_INTERVAL_MS, Math.max(60_000, Number(intervalMs) || 3600000));
  const missed = Math.ceil((Number(now) - Number(nextRunAt)) / interval);
  let next = Number(nextRunAt) + Math.max(1, missed) * interval;
  if (next <= Number(now)) next += interval;
  return next;
}

/**
 * 启动时对账 next_run_at：
 *  - 0 → 按计划计算初始值；
 *  - interval 且过期 >5min → 顺延到下一个周期；过期 ≤5min 保持到期（由 tick 补跑）；
 *  - daily 过期 → 保持到期（tick 立即补跑一次，执行后计算下一次）。
 * @returns {number} 修正的任务数
 */
export function reconcileStartupTasks(now = deps.now()) {
  let changed = 0;
  for (const task of store.listScheduledTasks({ includeDisabled: false })) {
    if (!task.enabled) continue;
    const nextRunAt = Number(task.nextRunAt) || 0;
    if (nextRunAt <= 0) {
      store.updateScheduledTask(task.id, { nextRunAt: computeInitialNextRun(task, now) });
      changed += 1;
      continue;
    }
    if (task.schedule.type === 'interval') {
      const overdue = Number(now) - nextRunAt;
      if (overdue > MAX_CATCHUP_MS) {
        store.updateScheduledTask(task.id, {
          nextRunAt: advanceIntervalNextRun(nextRunAt, task.schedule.intervalMs, now),
        });
        changed += 1;
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// 任务解析 / 执行
// ---------------------------------------------------------------------------

/** app_rules 原始行 → 调度执行配置（解密 request headers）。 */
export function parseScheduledTaskRow(row) {
  if (!row) return null;
  let headers = {};
  const decrypted = decryptSecretOrNull(row.request_headers_enc);
  if (decrypted) {
    try {
      const parsed = JSON.parse(decrypted);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) headers = parsed;
    } catch {
      headers = {};
    }
  }
  let targetIds = [];
  try {
    const parsed = JSON.parse(row.target_ids ?? '[]');
    if (Array.isArray(parsed)) targetIds = parsed.map(String);
  } catch {
    targetIds = [];
  }
  const time = row.daily_time ?? '08:00';
  return {
    id: row.id,
    name: row.name ?? '',
    enabled: Boolean(row.enabled),
    schedule: {
      type: row.schedule_type ?? 'interval',
      intervalMs: Number(row.interval_ms) || 3600000,
      dailyTime: time,
      timezone: config.scheduler.timezone,
    },
    targets: { type: row.target_type ?? 'users', ids: targetIds },
    request: {
      method: (row.request_method ?? 'GET').toUpperCase(),
      url: row.request_url ?? '',
      headers,
      bodyTemplate: row.request_body_template ?? '',
    },
    response: {
      type: row.response_type ?? 'json',
      path: row.response_path ?? '',
      template: row.reply_template ?? '',
      fallbackText: row.fallback_text ?? '',
    },
    limits: { timeoutMs: Number(row.timeout_ms) || config.scheduler.timeoutMs },
    nextRunAt: Number(row.next_run_at) || 0,
    lastRunAt: Number(row.last_run_at) || 0,
    lastStatus: row.last_status ?? '',
  };
}

/** 调度内置变量：{now}/{date}/{time}/{taskName}（date/time 按 SCHEDULER_TIMEZONE）。 */
export function buildScheduleVars(task, now = deps.now()) {
  const local = getZonedParts(now, config.scheduler.timezone);
  const pad = (value) => String(value).padStart(2, '0');
  return {
    now: String(now),
    date: `${local.year}-${pad(local.month)}-${pad(local.day)}`,
    time: `${pad(local.hour)}:${pad(local.minute)}`,
    taskName: task?.name ?? '',
  };
}

function createEmptyResult(task) {
  return {
    matched: true,
    status: 'failed',
    httpStatus: null,
    latencyMs: 0,
    error: '',
    responsePreview: '',
    replyText: '',
    recipientsCount: 0,
    recipientsTotal: 0,
    truncated: false,
    request: {
      method: task.request.method,
      url: '',
      headerNames: Object.keys(task.request.headers ?? {}),
      bodyPreview: '',
    },
    responseHeaders: {},
  };
}

/**
 * 执行一次任务（dryRun=true：真实调用但不发送/不写日志/不更新 next_run_at）。
 * @returns {Promise<object>}
 */
export async function executeScheduledTask(taskRow, { dryRun = false, now = deps.now() } = {}) {
  const task = parseScheduledTaskRow(taskRow);
  if (!task) return null;
  const startedAt = Number(now);
  const vars = buildScheduleVars(task, startedAt);
  const result = createEmptyResult(task);
  const recipients = store.resolveScheduledTaskRecipients(taskRow, { maxRecipients: config.scheduler.maxRecipients });
  result.recipientsCount = recipients.userIds.length;
  result.recipientsTotal = recipients.total;
  result.truncated = recipients.truncated;
  if (recipients.truncated) {
    log.warn('定时任务目标数量超过上限，已截断', {
      taskId: task.id,
      total: recipients.total,
      maxRecipients: config.scheduler.maxRecipients,
    });
  }

  let replyText = '';
  let status = 'failed';
  let httpStatus = null;
  let latencyMs = 0;
  let error = '';
  try {
    const url = renderRequestTemplate(task.request.url, vars, { urlEncode: true });
    const headers = {};
    for (const [key, value] of Object.entries(task.request.headers ?? {})) {
      headers[key] = truncate(renderRequestTemplate(value, vars), 2000);
    }
    const body =
      task.request.method === 'POST' ? renderRequestTemplate(task.request.bodyTemplate, vars) : '';
    result.request.url = url;
    result.request.bodyPreview = truncate(body, 500);
    const response = await requestExternal({
      url,
      method: task.request.method,
      headers,
      body,
      timeoutMs: Math.min(task.limits.timeoutMs, config.scheduler.timeoutMs),
      maxResponseBytes: config.appRules.maxResponseBytes,
      allowedHosts: config.appRules.allowedHosts,
      fetchImpl: deps.fetch,
    });
    httpStatus = response.status;
    latencyMs = response.latencyMs;
    result.httpStatus = httpStatus;
    result.latencyMs = latencyMs;
    result.responsePreview = truncate(response.text, 1000);
    result.responseHeaders = response.headers ?? {};
    if (httpStatus < 200 || httpStatus >= 300) throw new Error(`HTTP ${httpStatus}`);
    const parsed = parseResponse({
      responseType: task.response.type,
      responsePath: task.response.path,
      rawText: response.text,
    });
    const rendered = renderReplyTemplate(task.response.template, {
      root: parsed.root,
      responseText: parsed.responseText,
      rawText: parsed.rawText,
    });
    replyText = rendered.trim();
    if (!replyText) throw new Error('empty reply');
    status = 'success';
  } catch (err) {
    error = truncate(err?.message ?? String(err), 500);
    replyText = (task.response.fallbackText ?? '').trim();
    status = 'failed';
  }

  result.status = status;
  result.httpStatus = httpStatus;
  result.latencyMs = latencyMs;
  result.error = error;
  result.replyText = replyText;
  if (dryRun) return result;

  // 逐目标入队（单个失败不影响其他）
  let queuedCount = 0;
  if (replyText) {
    for (const userId of recipients.userIds) {
      try {
        store.enqueueMessage({
          userId,
          text: truncate(replyText, config.push.maxTextLength),
          source: 'schedule',
        });
        queuedCount += 1;
      } catch (err) {
        log.warn('定时任务入队失败（跳过该用户）', { taskId: task.id, userId, message: err?.message });
      }
    }
  }
  result.recipientsCount = queuedCount;

  const nextRunAt = computeNextAfterRun(task, startedAt);
  try {
    store.insertScheduledTaskLog({
      taskId: task.id,
      status,
      httpStatus,
      latencyMs,
      error,
      responsePreview: result.responsePreview,
      replyPreview: truncate(replyText, 1000),
      recipientsCount: queuedCount,
      createdAt: startedAt,
    });
    store.markScheduledTaskRun(task.id, { lastRunAt: startedAt, lastStatus: status, nextRunAt });
  } catch (err) {
    log.warn('定时任务写日志/更新计划失败', { taskId: task.id, message: err?.message });
  }
  if (status === 'success') {
    log.info('定时任务执行成功', { taskId: task.id, recipients: queuedCount, httpStatus, latencyMs });
  } else {
    log.warn('定时任务执行失败', { taskId: task.id, error, recipients: queuedCount });
  }
  return result;
}

// ---------------------------------------------------------------------------
// tick / start / stop
// ---------------------------------------------------------------------------

let running = false;
/** @type {NodeJS.Timeout|null} */
let timer = null;
let scanning = false;

/** 扫描并执行到期任务（最多 10 个，按 next_run_at 升序；单任务异常不影响其他）。 */
export async function tick(now = deps.now()) {
  if (!config.scheduler.enabled || scanning) return 0;
  scanning = true;
  let executed = 0;
  try {
    const dueTasks = store.listDueScheduledTasks(now, TICK_BATCH);
    for (const row of dueTasks) {
      try {
        await executeScheduledTask(row, { now: deps.now(), dryRun: false });
        executed += 1;
      } catch (err) {
        log.error('定时任务执行异常（忽略，继续其他任务）', { taskId: row.id, message: err?.message, stack: err?.stack });
        try {
          const task = parseScheduledTaskRow(row);
          const failedAt = deps.now();
          store.insertScheduledTaskLog({
            taskId: row.id,
            status: 'failed',
            error: truncate(err?.message ?? String(err), 500),
            createdAt: failedAt,
          });
          store.markScheduledTaskRun(row.id, {
            lastRunAt: failedAt,
            lastStatus: 'failed',
            nextRunAt: computeNextAfterRun(task, failedAt),
          });
        } catch {
          /* 忽略二次失败 */
        }
      }
    }
  } finally {
    scanning = false;
  }
  return executed;
}

/** 启动调度器（幂等；SCHEDULER_ENABLED=false 时不启动）。 */
export function start() {
  if (!config.scheduler.enabled) {
    log.info('定时通知调度器未启用（SCHEDULER_ENABLED=false）');
    return false;
  }
  if (running) return false;
  running = true;
  const fixed = reconcileStartupTasks(deps.now());
  timer = setInterval(() => {
    void tick().catch((err) => log.error('定时任务扫描异常（忽略）', { message: err?.message }));
  }, config.scheduler.tickMs);
  timer.unref?.();
  log.info('定时通知调度器已启动', {
    tickMs: config.scheduler.tickMs,
    timezone: config.scheduler.timezone,
    maxRecipients: config.scheduler.maxRecipients,
    reconciled: fixed,
  });
  return true;
}

/** 停止调度器（幂等）。 */
export function stop() {
  const wasRunning = running;
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (wasRunning) log.info('定时通知调度器已停止');
  return wasRunning;
}

export function isRunning() {
  return running;
}

/** 重启调度器（运行配置热更新用；enabled=false 时停止）。 */
export function restart() {
  stop();
  return start();
}
/**
 * 立即执行一次任务（API test/run 复用）。
 * dryRun=true：真实调用接口并渲染，但不发送、不写日志、不更新 next_run_at。
 * @returns {Promise<object|null>} 任务不存在返回 null
 */
export async function runScheduledTaskNow(taskId, { dryRun = false } = {}) {
  const row = store.getScheduledTaskRow(taskId);
  if (!row) return null;
  return executeScheduledTask(row, { dryRun, now: deps.now() });
}
