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
import {
  CredentialMissingError,
  collectCredentialRefs,
  redactCredentialValues,
  resolveRequestCredentials,
} from '../shared/credentials.js';
import { describeFetchError } from '../shared/http-client.js';
import {
  buildResponseResult,
  executeHttpRequest,
  renderHttpRequest,
  runExternalRequest,
} from '../shared/http-execute.js';
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
 * 定时任务自己的网络防护配置）：缺省（0/空数组）继承「接口应用」的值，
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
    // 按用户模式（schema v1）：逐目标用户解析凭据并分别请求/回复
    perUserMode: Boolean(row.per_user_mode),
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
 * 按用户模式（per_user_mode）：单任务总超时（毫秒）与并发池大小的防御性上限。
 * 并发/目标上限来自运行配置 scheduler.perUserConcurrency / perUserMaxRecipients（实时读取）。
 */
const PER_USER_TOTAL_TIMEOUT_MS = 30_000;

function perUserConcurrency() {
  return Math.min(10, Math.max(1, Number(config.scheduler.perUserConcurrency) || 2));
}

function perUserMaxRecipients() {
  return Math.min(200, Math.max(1, Number(config.scheduler.perUserMaxRecipients) || 50));
}

/** 简单并发池：最多 limit 个 worker 同时消费 items（保持结果顺序）。 */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(Number(limit) || 1, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 按用户模式事件（detail 仅 userId/httpStatus/凭据名/错误，不含任何凭据值）。 */
function addRecipientEvent(type, detail) {
  try {
    store.addEvent({ type, userId: detail?.userId ?? null, detail: JSON.stringify(detail) });
  } catch (err) {
    log.warn('写入按用户模式任务事件失败（忽略）', { type, message: err?.message });
  }
}

/** 汇总按用户模式的错误文案（只含计数/名称/已脱敏错误）。 */
function summarizePerUserError({ failedCount, skippedCount, firstError, firstMissing }) {
  const parts = [];
  if (failedCount > 0) parts.push(`failed=${failedCount}`);
  if (skippedCount > 0) parts.push(`skipped=${skippedCount}`);
  const detail = firstError || (firstMissing.length > 0 ? `missing credential ${firstMissing.join(', ')}` : '');
  return truncate([parts.join(' '), detail].filter(Boolean).join(' '), 500);
}

/**
 * 按用户模式执行：
 *  展开目标用户 → 逐用户解析凭据（缺失跳过并写事件，不兜底）→ 渲染请求（userName/userId 变量）
 *  → 按“渲染后的请求”指纹合并相同凭据/模板的请求只调用一次 → 逐用户用同一响应渲染回复
 *  （模板根附加 userName/userId，`{{noreply}}` 单用户不回复）→ 只入队该用户 → 汇总状态/日志/事件。
 * 单用户失败只影响该用户（按配置使用兜底文案）；整体状态 success/partial/failed。
 */
async function executePerUserScheduledTask(taskRow, task, { dryRun = false, now = getDependencies().now(), manual = false } = {}) {
  const startedAt = Number(now);
  const result = createEmptyResult(task);
  result.mode = 'per_user';
  result.perUserMode = true;

  const recipients = store.resolveScheduledTaskRecipients(taskRow, { maxRecipients: perUserMaxRecipients() });
  result.recipientsTotal = recipients.total;
  result.truncated = recipients.truncated;
  if (recipients.truncated) {
    log.warn('按用户模式任务目标数量超过上限，已截断', {
      taskId: task.id,
      total: recipients.total,
      maxRecipients: perUserMaxRecipients(),
    });
  }
  const userIds = recipients.userIds;
  const userNames = new Map();
  try {
    for (const row of store.getUsersByIds(userIds)) userNames.set(String(row.id), row.display_name ?? '');
  } catch {
    /* 名称仅用于模板展示，失败时回退 userId */
  }

  const baseVars = buildScheduleVars(task, startedAt);
  const credentialRefs = collectCredentialRefs(task.request ?? {});
  const deadline = startedAt + PER_USER_TOTAL_TIMEOUT_MS;

  // 1) 逐用户解析凭据 + 渲染请求；按渲染后的请求指纹分组（相同凭据字段值 + 相同模板 → 合并一次请求）
  const groups = new Map();
  const skipped = [];
  const errors = [];
  for (const userId of userIds) {
    const userName = userNames.get(userId) ?? '';
    const extras = { userId, userName };
    let credentialValues = null;
    let credentialNames = [];
    if (credentialRefs.length > 0) {
      try {
        const resolved = resolveRequestCredentials(userId, credentialRefs, { ts: startedAt });
        credentialValues = resolved.values;
        credentialNames = [...resolved.usedNames];
      } catch (err) {
        if (err instanceof CredentialMissingError) {
          skipped.push({ userId, missing: err.missing });
          continue;
        }
        errors.push({ userId, error: truncate(String(err?.message ?? err), 500), httpStatus: null, credentials: [] });
        continue;
      }
    }
    const request = renderHttpRequest(task.request ?? {}, { ...baseVars, userId, userName }, { credentialValues });
    const fingerprint = `${request.method} ${request.url}\n${JSON.stringify(request.headers)}\n${request.body}`;
    const existing = groups.get(fingerprint);
    if (existing) {
      existing.users.push({ userId, userName, extras });
    } else {
      groups.set(fingerprint, { request, credentialValues, credentialNames, users: [{ userId, userName, extras }] });
    }
  }

  // 2) 并发执行合并后的请求，并逐用户渲染回复/入队
  const limits = getHttpLimits();
  let requestError = '';
  let httpStatus = null;
  let totalLatencyMs = 0;
  let firstResponsePreview = '';
  let firstError = '';
  let successCount = 0;
  let failedCount = 0;
  let noreplyCount = 0;
  let queuedCount = 0;
  const groupList = [...groups.values()];

  await runWithConcurrency(groupList, perUserConcurrency(), async (group) => {
    if (getDependencies().now() > deadline) {
      for (const user of group.users) skipped.push({ userId: user.userId, missing: [], error: 'timeout' });
      return;
    }
    let fetched;
    try {
      fetched = await runExternalRequest({
        request: group.request,
        timeoutMs: Math.min(task.limits.timeoutMs, config.scheduler.timeoutMs),
        maxResponseBytes: limits.maxResponseBytes,
        allowedHosts: limits.allowedHosts,
        httpRequest: getDependencies().httpRequest,
      });
    } catch (err) {
      const message = redactCredentialValues(truncate(describeFetchError(err), 500), group.credentialValues);
      if (!requestError) requestError = message;
      if (!firstError) firstError = message;
      for (const user of group.users) {
        failedCount += 1;
        errors.push({ userId: user.userId, error: message, httpStatus: null, credentials: group.credentialNames });
        // 请求级失败（网络/超时/SSRF 等）同样按配置兜底：每个失败用户一条兜底消息。
        if (dryRun) continue;
        const fallback = String(task.response.fallbackText ?? '').trim();
        if (!fallback) continue;
        try {
          store.enqueueMessage({
            userId: user.userId,
            text: truncate(fallback, config.push.maxTextLength),
            source: 'schedule',
          });
          queuedCount += 1;
        } catch (enqueueErr) {
          log.warn('按用户模式请求失败兜底入队失败（跳过该用户）', {
            taskId: task.id,
            userId: user.userId,
            message: enqueueErr?.message,
          });
        }
      }
      return;
    }
    httpStatus = Number(fetched.status);
    totalLatencyMs += Number(fetched.latencyMs) || 0;
    const redactedResponsePreview = redactCredentialValues(truncate(fetched.text ?? '', 1000), group.credentialValues);
    if (!firstResponsePreview) firstResponsePreview = redactedResponsePreview;

    for (const user of group.users) {
      // 单用户失败（响应解析/模板渲染/入队）只影响该用户：记 failed + 事件 + 按配置兜底，不中断整轮
      const handleUserFailure = (errorText, errorStatus) => {
        failedCount += 1;
        if (!firstError) firstError = errorText;
        errors.push({
          userId: user.userId,
          error: errorText,
          httpStatus: Number.isFinite(Number(errorStatus)) ? Number(errorStatus) : null,
          credentials: group.credentialNames,
        });
        if (dryRun) return;
        const fallback = String(task.response.fallbackText ?? '').trim();
        if (!fallback) return;
        try {
          store.enqueueMessage({
            userId: user.userId,
            text: truncate(fallback, config.push.maxTextLength),
            source: 'schedule',
          });
          queuedCount += 1;
        } catch (err) {
          log.warn('按用户模式兜底入队失败（跳过该用户）', { taskId: task.id, userId: user.userId, message: err?.message });
        }
      };

      let outcome;
      try {
        outcome = buildResponseResult({
          fetched,
          response: task.response,
          templateExtras: { userId: user.userId, userName: user.userName },
        });
      } catch (err) {
        // 非 JSON / 模板渲染异常：仅该用户失败（不 abort 其他用户）
        handleUserFailure(
          redactCredentialValues(truncate(String(err?.message ?? err), 500), group.credentialValues),
          fetched.status,
        );
        continue;
      }
      const preview = redactCredentialValues(truncate(fetched.text ?? '', 1000), group.credentialValues);
      if (!firstResponsePreview) firstResponsePreview = preview;
      if (outcome.noreply === true) {
        // 该用户模板要求不回复：不发送、不使用兜底（按成功处理）
        noreplyCount += 1;
        continue;
      }
      const errorText = redactCredentialValues(outcome.error ?? '', group.credentialValues);
      if (errorText) {
        handleUserFailure(errorText, outcome.status);
        continue;
      }
      const replyText = String(outcome.replyText ?? '').trim();
      if (!replyText) {
        handleUserFailure('empty reply', outcome.status);
        continue;
      }
      successCount += 1;
      if (dryRun) continue;
      try {
        store.enqueueMessage({
          userId: user.userId,
          // 回复内容照常发送（与规则回复一致，仅日志/预览/事件脱敏；API 回显的凭据值不应意外进入用户消息时由模板/接口方负责）
          text: truncate(replyText, config.push.maxTextLength),
          source: 'schedule',
        });
        queuedCount += 1;
      } catch (err) {
        handleUserFailure(truncate(String(err?.message ?? err), 500), outcome.status);
      }
    }
  });

  const skippedCount = skipped.length;
  const deliveredCount = successCount + noreplyCount;
  let status = 'success';
  if (userIds.length > 0 && deliveredCount === 0) status = 'failed';
  else if (failedCount > 0 || skippedCount > 0) status = 'partial';

  result.status = status;
  result.httpStatus = httpStatus;
  result.latencyMs = totalLatencyMs;
  result.error = status === 'success' ? '' : summarizePerUserError({
    failedCount,
    skippedCount,
    firstError: firstError || requestError,
    firstMissing: skipped.find((item) => item.missing.length > 0)?.missing ?? [],
  });
  result.responsePreview = firstResponsePreview;
  result.replyText = '';
  result.noreply = userIds.length > 0 && noreplyCount === userIds.length;
  result.recipientsCount = dryRun ? userIds.length : queuedCount;
  result.successCount = successCount;
  result.noreplyCount = noreplyCount;
  result.failedCount = failedCount;
  result.skippedCount = skippedCount;

  if (dryRun) return result;

  // 每人明细事件（跳过/失败），不写任何凭据值
  for (const item of skipped) {
    addRecipientEvent('scheduled_recipient_skipped', {
      taskId: task.id,
      userId: item.userId,
      ...(item.missing.length > 0 ? { missing: item.missing } : {}),
      ...(item.error ? { error: item.error } : {}),
    });
  }
  for (const item of errors) {
    addRecipientEvent('scheduled_recipient_failed', {
      taskId: task.id,
      userId: item.userId,
      httpStatus: item.httpStatus,
      ...(item.credentials?.length > 0 ? { credentials: item.credentials } : {}),
      error: String(item.error ?? '').slice(0, 500),
    });
  }

  const nextRunAt = manual
    ? Number(task.nextRunAt) || computeNextAfterRun(task, startedAt)
    : computeNextAfterRun(task, startedAt);
  try {
    store.completeScheduledTaskRun({
      taskId: task.id,
      log: {
        status,
        httpStatus,
        latencyMs: totalLatencyMs,
        error: result.error,
        responsePreview: firstResponsePreview,
        replyPreview: `按用户模式：成功 ${successCount} / 不回复 ${noreplyCount} / 失败 ${failedCount} / 跳过 ${skippedCount}`,
        recipientsCount: queuedCount,
        createdAt: startedAt,
      },
      lastRunAt: startedAt,
      lastStatus: status,
      nextRunAt,
    });
  } catch (err) {
    log.warn('按用户模式任务写日志/更新计划失败（事务已回滚）', { taskId: task.id, message: err?.message });
  }
  if (status === 'success') {
    log.info('按用户模式定时任务执行成功', {
      taskId: task.id,
      recipients: queuedCount,
      requests: groupList.length,
      noreply: noreplyCount,
      httpStatus,
      latencyMs: totalLatencyMs,
    });
  } else {
    log.warn('按用户模式定时任务执行未全部成功', {
      taskId: task.id,
      status,
      success: successCount,
      failed: failedCount,
      skipped: skippedCount,
      requests: groupList.length,
      error: result.error,
    });
  }
  return result;
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

async function executeScheduledTaskInternal(taskRow, options = {}) {
  const task = parseScheduledTaskRow(taskRow);
  if (!task) return null;
  if (task.perUserMode) return executePerUserScheduledTask(taskRow, task, options);
  return executeSummaryScheduledTask(task, taskRow, options);
}

/** 汇总模式（perUserMode=false）：一次请求 → 解析/渲染回复 → 所有目标用户收到相同内容（既有行为）。 */
async function executeSummaryScheduledTask(task, taskRow, { dryRun = false, now = getDependencies().now(), manual = false } = {}) {
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
  let noreply = false;
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
    // 模板输出 {{noreply}}：本次不发送任何消息，且不使用兜底文案
    if (outcome.noreply === true) {
      noreply = true;
      status = 'success';
    } else {
      // 非 2xx / 空回复在通用管线中以 error 返回；这里统一转为失败状态（文案与旧实现一致）。
      if (outcome.error) throw new Error(outcome.error);
      replyText = outcome.replyText.trim();
      if (!replyText) throw new Error('empty reply');
      status = 'success';
    }
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
  result.noreply = noreply;
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
    // 日志 + last_run/next_run 同一事务）：避免只写入其一导致重启后重复执行或日志丢失。
    store.completeScheduledTaskRun({
      taskId: task.id,
      log: {
        status,
        httpStatus,
        latencyMs,
        error,
        responsePreview: result.responsePreview,
        replyPreview: noreply ? '（不回复，未使用兜底）' : truncate(replyText, 1000),
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
  if (status === 'success' && noreply) {
    log.info('定时任务执行成功（模板要求不回复，未使用兜底文案）', { taskId: task.id, httpStatus, latencyMs });
  } else if (status === 'success') {
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
/** 在途 tick Promise 集合：stop/restart/退出时等待其 settle）。 */
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
 * 在途 Promise 会被登记，供 stop/restart 等待）。
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
