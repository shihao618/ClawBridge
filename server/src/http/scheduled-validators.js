/**
 * 定时通知（scheduled-tasks）请求体校验：schedule/targets/request/response/timeoutMs
 * 的完整 patch 构造（创建 requireAll=true，更新为部分字段）。
 *
 * 从 api.js 的 buildScheduledTaskPatch 等价迁出（纯搬迁，行为不变）。
 */
import { encryptSecret } from '../crypto.js';
import { AppError, badRequest } from '../errors.js';
import * as scheduler from '../scheduler.js';
import * as store from '../store.js';

import { assertPlainObject, optionalString, requiredString, validateHttpUrl } from './validators.js';

const SCHEDULED_SCHEDULE_TYPES = new Set(['interval', 'daily']);
const SCHEDULED_TARGET_TYPES = new Set(['all', 'users', 'groups']);
export const SCHEDULED_TASK_STATUSES = new Set(['success', 'failed', 'skipped']);
const SCHEDULED_MIN_INTERVAL_MS = 60_000;
const SCHEDULED_MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 校验并构造定时任务扁平字段 patch（创建 requireAll=true，更新为部分字段）。
 * request.headers 语义：不传=不变；{} 清空；对象=全量替换（加密落库，读取只回 headerNames）。
 */
export function buildScheduledTaskPatch(rawBody, { requireAll = false } = {}) {
  const body = assertPlainObject(rawBody ?? {}, '请求体');
  const patch = {};

  if (requireAll || body.name !== undefined) patch.name = requiredString(body.name, 'name', { min: 1, max: 60 });
  if (requireAll || body.enabled !== undefined) {
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw badRequest('enabled 必须是 boolean');
    // 创建（requireAll）未传 enabled 时默认停用（与文档「定时任务默认不启用」一致）；更新仅在显式传入时改写。
    patch.enabled = body.enabled === undefined ? false : body.enabled;
  }

  if (requireAll || body.schedule !== undefined) {
    const schedule = assertPlainObject(body.schedule ?? {}, 'schedule');
    const type = schedule.type ?? 'interval';
    if (!SCHEDULED_SCHEDULE_TYPES.has(type)) throw badRequest('schedule.type 只能是 interval | daily');
    patch.scheduleType = type;
    // 每日生效时间段（仅 interval；windowStart/windowEnd 必须同时为空或同时存在）
    const windowStartRaw = schedule.windowStart === undefined || schedule.windowStart === null ? '' : schedule.windowStart;
    const windowEndRaw = schedule.windowEnd === undefined || schedule.windowEnd === null ? '' : schedule.windowEnd;
    if (typeof windowStartRaw !== 'string' || typeof windowEndRaw !== 'string') {
      throw badRequest('schedule.windowStart/windowEnd 必须是 HH:mm 字符串');
    }
    const windowStart = windowStartRaw.trim();
    const windowEnd = windowEndRaw.trim();
    if ((windowStart === '') !== (windowEnd === '')) {
      throw badRequest('schedule.windowStart 与 schedule.windowEnd 必须同时为空或同时填写');
    }
    if (windowStart !== '') {
      if (type === 'daily') throw badRequest('daily 计划不支持每日生效时间段（windowStart/windowEnd 仅 interval 可用）');
      if (!scheduler.parseClockTime(windowStart) || !scheduler.parseClockTime(windowEnd)) {
        throw badRequest('schedule.windowStart/windowEnd 必须是合法的 HH:mm');
      }
      if (windowStart === windowEnd) throw badRequest('schedule.windowStart 与 schedule.windowEnd 不能相同');
    }
    patch.windowStart = windowStart;
    patch.windowEnd = windowEnd;
    if (type === 'interval') {
      const intervalMs = schedule.intervalMs === undefined ? 3600000 : schedule.intervalMs;
      if (!Number.isInteger(intervalMs) || intervalMs < SCHEDULED_MIN_INTERVAL_MS || intervalMs > SCHEDULED_MAX_INTERVAL_MS) {
        throw badRequest(`schedule.intervalMs 必须是 ${SCHEDULED_MIN_INTERVAL_MS}..${SCHEDULED_MAX_INTERVAL_MS} 的整数`);
      }
      patch.intervalMs = intervalMs;
    } else {
      const dailyTime = schedule.dailyTime;
      if (typeof dailyTime !== 'string' || !scheduler.parseDailyTime(dailyTime)) {
        throw badRequest('schedule.dailyTime 必须是合法的 HH:mm');
      }
      patch.dailyTime = dailyTime.trim();
    }
  }

  if (requireAll || body.targets !== undefined) {
    const targets = assertPlainObject(body.targets ?? {}, 'targets');
    const type = targets.type ?? 'users';
    if (!SCHEDULED_TARGET_TYPES.has(type)) throw badRequest('targets.type 只能是 all | users | groups');
    let ids = [];
    if (type === 'all') {
      // 全部用户为动态目标：不保存用户 id，执行时取当时所有 active 用户。
      if (targets.ids !== undefined && !Array.isArray(targets.ids)) throw badRequest('targets.ids 必须是数组');
      ids = [];
    } else {
      if (!Array.isArray(targets.ids) || targets.ids.length === 0) throw badRequest('targets.ids 必须是非空数组');
      ids = [...new Set(targets.ids.map((id) => String(id).trim()).filter(Boolean))];
      if (ids.length === 0) throw badRequest('targets.ids 必须包含有效 id');
      if (type === 'users') {
        const unknown = ids.filter((id) => !store.getUserRow(id));
        if (unknown.length > 0) throw badRequest(`targets.ids 中用户不存在：${unknown.join(', ')}`);
      } else {
        const unknown = ids.filter((id) => !store.getGroupRow(id));
        if (unknown.length > 0) throw badRequest(`targets.ids 中分组不存在：${unknown.join(', ')}`);
      }
    }
    patch.targetType = type;
    patch.targetIds = ids;
  }

  if (requireAll || body.request !== undefined) {
    const request = assertPlainObject(body.request ?? {}, 'request');
    const method = String(request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw badRequest('request.method 只能是 GET | POST');
    patch.requestMethod = method;
    const urlValue = validateHttpUrl(request.url);
    try {
      const parsedUrl = new URL(urlValue);
      if (parsedUrl.username || parsedUrl.password) throw badRequest('request.url 不允许包含 userinfo（user:pass@）');
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw badRequest('request.url 不是合法 URL');
    }
    patch.requestUrl = urlValue;
    patch.requestBodyTemplate = optionalString(request.bodyTemplate, 'request.bodyTemplate', 10000);
    if (request.headers !== undefined) {
      const headers = assertPlainObject(request.headers, 'request.headers');
      const normalized = {};
      for (const [key, value] of Object.entries(headers)) {
        if (typeof key !== 'string' || key.trim().length < 1 || key.trim().length > 100) {
          throw badRequest('request.headers 的 header 名长度必须是 1..100');
        }
        if (typeof value !== 'string' || value.length > 2000) {
          throw badRequest(`request.headers[${key}] 的值必须是 ≤2000 的字符串`);
        }
        normalized[key.trim()] = value;
      }
      patch.requestHeadersEnc = encryptSecret(JSON.stringify(normalized));
    } else if (requireAll) {
      patch.requestHeadersEnc = null;
    }
  }

  if (requireAll || body.response !== undefined) {
    const response = assertPlainObject(body.response ?? {}, 'response');
    const type = response.type ?? 'json';
    if (type !== 'json' && type !== 'text') throw badRequest('response.type 只能是 json | text');
    patch.responseType = type;
    patch.responsePath = optionalString(response.path, 'response.path', 200);
    patch.replyTemplate = optionalString(response.template, 'response.template', 4000);
    patch.fallbackText = optionalString(response.fallbackText, 'response.fallbackText', 4000);
  }

  if (requireAll || body.timeoutMs !== undefined) {
    const timeoutMs = body.timeoutMs === undefined ? 8000 : body.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
      throw badRequest('timeoutMs 必须是 1000..30000 的整数');
    }
    patch.timeoutMs = timeoutMs;
  }

  return patch;
}
