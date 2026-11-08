/**
 * 定时调度执行与生命周期（scheduler/index.js）。
 *
 * 从 scheduler.js 按职责拆分：tick 扫描/执行/目标入队/日志/启停/手动执行
 * 与 scheduler 网络防护配置（getHttpLimits）。计划计算见 ./calc.js。
 */
import { config } from '../config.js';
import { decryptSecretOrNull } from '../crypto.js';
import { conflict } from '../errors.js';
import { logger } from '../logger.js';
import { executeHttpRequest, renderHttpRequest } from '../shared/http-execute.js';
import { truncate } from '../shared/template.js';
import * as store from '../store.js';

import {
  computeNextAfterRun,
  getDependencies,
  getZonedParts,
  isInDailyWindow,
  nextWindowStart,
  reconcileStartupTasks,
  scheduleWindowOf,
} from './calc.js';

const log = logger.child({ mod: 'scheduler' });

/** 正在执行的任务 id：手动执行与 tick 共用，避免同一任务并发重复调用外部接口/发消息。 */
const inFlightTasks = new Set();

const TICK_BATCH = 10;

/**
 * 定时任务自己的网络防护配置（BA-09）：缺省（0/空数组）继承「接口应用」的值，
 * 保持历史行为；后台可在「定时通知」分组单独覆盖，配置来源不再隐式混用。
 */
export function getHttpLimits() {
  const ownBytes = Number(config.scheduler.maxResponseBytes);
  const ownHosts = Array.isArray(config.scheduler.allowedHosts) ? config.scheduler.allowedHosts : [];
  return {
    maxResponseBytes:
      Number.isFinite(ownBytes) && ownBytes > 0 ? ownBytes : config.appRules.maxResponseBytes,
    allowedHosts: ownHosts.length > 0 ? ownHosts : config.appRules.allowedHosts,
  };
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
      windowStart: row.window_start ?? '',
      windowEnd: row.window_end ?? '',
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
export function buildScheduleVars(task, now = getDependencies().now()) {
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
 * manual=true：手动执行，写运行日志但保留原有 next_run_at，不影响后续定时。
 * 同一任务同一时刻只允许一个执行实例；并发调用返回 409。
 * @returns {Promise<object>}
 */
export async function executeScheduledTask(taskRow, options = {}) {
  const task = parseScheduledTaskRow(taskRow);
  if (!task) return null;
  const taskId = String(task.id);
  if (inFlightTasks.has(taskId)) {
    throw conflict('定时任务正在执行，请稍后重试');
  }
  inFlightTasks.add(taskId);
  try {
    return await executeScheduledTaskInternal(taskRow, options);
  } finally {
    inFlightTasks.delete(taskId);
  }
}

/** 任务是否正在执行（tick 用于跳过，避免重复写失败日志）。 */
export function isScheduledTaskInFlight(taskId) {
  return inFlightTasks.has(String(taskId));
}

async function executeScheduledTaskInternal(taskRow, { dryRun = false, now = getDependencies().now(), manual = false } = {}) {
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
    const limits = getHttpLimits();
    const prepared = renderHttpRequest(task.request, vars);
    result.request.url = prepared.url;
    result.request.bodyPreview = prepared.bodyPreview;
    const outcome = await executeHttpRequest({
      request: prepared,
      response: task.response,
      timeoutMs: Math.min(task.limits.timeoutMs, config.scheduler.timeoutMs),
      maxResponseBytes: limits.maxResponseBytes,
      allowedHosts: limits.allowedHosts,
      httpRequest: getDependencies().httpRequest,
    });
    httpStatus = outcome.status;
    latencyMs = outcome.latencyMs;
    result.httpStatus = httpStatus;
    result.latencyMs = latencyMs;
    result.responsePreview = truncate(outcome.text, 1000);
    result.responseHeaders = outcome.headers ?? {};
    // 非 2xx / 空回复在通用管线中以 error 返回；这里统一转为失败状态（文案与旧实现一致）。
    if (outcome.error) throw new Error(outcome.error);
    replyText = outcome.replyText.trim();
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

  const nextRunAt = manual
    ? Number(task.nextRunAt) || computeNextAfterRun(task, startedAt)
    : computeNextAfterRun(task, startedAt);
  try {
    // 日志 + last_run/next_run 同一事务（BA-04）：避免只写入其一导致重启后重复执行或日志丢失。
    store.completeScheduledTaskRun({
      taskId: task.id,
      log: {
        status,
        httpStatus,
        latencyMs,
        error,
        responsePreview: result.responsePreview,
        replyPreview: truncate(replyText, 1000),
        recipientsCount: queuedCount,
        createdAt: startedAt,
      },
      lastRunAt: startedAt,
      lastStatus: status,
      nextRunAt,
    });
  } catch (err) {
    log.warn('定时任务写日志/更新计划失败（事务已回滚）', { taskId: task.id, message: err?.message });
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
/** 在途 tick Promise 集合：stop()/restart()/退出时等待其 settle（BA-04）。 */
const activeTicks = new Set();
/** stop() 等待在途 tick 的上限（媒体/接口调用不可中止；超时后由进程级兜底退出）。 */
const DRAIN_TIMEOUT_MS = 8000;

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref?.();
  });
}

/** 等待全部在途 tick settle（stop/restart/退出用）；返回是否在超时前全部完成。 */
export async function waitForIdleTicks(timeoutMs = DRAIN_TIMEOUT_MS) {
  if (activeTicks.size === 0) return true;
  const pending = Promise.allSettled([...activeTicks]).then(() => true);
  const timedOut = sleep(Math.max(1, Number(timeoutMs) || DRAIN_TIMEOUT_MS)).then(() => false);
  return Promise.race([pending, timedOut]);
}

/**
 * 扫描并执行到期任务（最多 10 个，按 next_run_at 升序；单任务异常不影响其他）。
 * 在途 Promise 会被登记，供 stop()/restart() 等待（BA-04）。
 */
export async function tick(now = getDependencies().now()) {
  const task = runTick(now);
  activeTicks.add(task);
  const cleanup = () => activeTicks.delete(task);
  task.then(cleanup, cleanup);
  return task;
}

/** tick 的实际扫描实现（同步登记在途 Promise 的外层包装见 tick()）。 */
async function runTick(now = getDependencies().now()) {
  if (!config.scheduler.enabled || scanning) return 0;
  scanning = true;
  let executed = 0;
  try {
    const dueTasks = store.listDueScheduledTasks(now, TICK_BATCH);
    for (const row of dueTasks) {
      if (isScheduledTaskInFlight(row.id)) continue;
      try {
        const task = parseScheduledTaskRow(row);
        const window = scheduleWindowOf(task);
        const dueAt = Number(row.next_run_at) || Number(now);
        // 结束分钟包含；仅窗口外（如 10:31）需要跳过并推进到下一个窗口开始。
        if (
          window &&
          task?.schedule?.type === 'interval' &&
          !isInDailyWindow(dueAt, window.startMinutes, window.endMinutes, config.scheduler.timezone)
        ) {
          const next = nextWindowStart(dueAt, window.startMinutes, window.endMinutes, config.scheduler.timezone);
          if (next) store.updateScheduledTask(row.id, { nextRunAt: next });
          log.info('定时任务到期时间不在生效窗口内，跳过并推进到下一次窗口', {
            taskId: row.id,
            dueAt,
            nextRunAt: next,
          });
          continue;
        }
        await executeScheduledTask(row, { now: getDependencies().now(), dryRun: false });
        executed += 1;
      } catch (err) {
        log.error('定时任务执行异常（忽略，继续其他任务）', { taskId: row.id, message: err?.message, stack: err?.stack });
        try {
          const task = parseScheduledTaskRow(row);
          const failedAt = getDependencies().now();
          store.completeScheduledTaskRun({
            taskId: row.id,
            log: {
              status: 'failed',
              error: truncate(err?.message ?? String(err), 500),
              createdAt: failedAt,
            },
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
  const fixed = reconcileStartupTasks(getDependencies().now());
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

/** 停止调度器（幂等；先停止定时器，再等待在途 tick settle）。 */
export async function stop() {
  const wasRunning = running;
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const drained = await waitForIdleTicks();
  if (!drained) log.warn('定时通知调度器停止时仍有在途任务（等待超时，由进程级兜底退出）');
  if (wasRunning) log.info('定时通知调度器已停止', { drained });
  return wasRunning;
}

export function isRunning() {
  return running;
}

/** 重启调度器（运行配置热更新用；先等待在途任务收尾再按 enabled 状态启动）。 */
export async function restart() {
  await stop();
  return start();
}
/**
 * 立即执行一次任务（API test/run 复用）。
 * dryRun=true：真实调用接口并渲染，但不发送、不写日志、不更新 next_run_at。
 * 非 dry-run 为手动执行：正常发送/写日志，但保留 next_run_at，不影响定时计划。
 * @returns {Promise<object|null>} 任务不存在返回 null
 */
export async function runScheduledTaskNow(taskId, { dryRun = false } = {}) {
  const row = store.getScheduledTaskRow(taskId);
  if (!row) return null;
  return executeScheduledTask(row, { dryRun, manual: !dryRun, now: getDependencies().now() });
}
