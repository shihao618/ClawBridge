/**
 * 定时调度计划计算（纯函数 + 可注入依赖锚点）。
 *
 * 从 scheduler.js 按职责拆分：interval/daily/window 计算、时区换算、next_run 推进、启动补跑对账。
 * 依赖注入（deps）放在本模块，供 calc/index 共用，避免 index ↔ calc 循环依赖。
 */
import { config } from '../config.js';
import { defaultHttpRequest } from '../shared/http-client.js';
import * as store from '../store.js';

const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CATCHUP_MS = 5 * 60 * 1000;

/** 可注入依赖（测试用；默认真实 Date/node:http 传输）。 */
const defaultDeps = {
  now: () => Date.now(),
  httpRequest: defaultHttpRequest,
};
let deps = { ...defaultDeps };
export function configureDependencies(overrides = {}) {
  deps = { ...deps, ...overrides };
}
export function resetDependencies() {
  deps = { ...defaultDeps };
}

/** calc/index 内部读取当前可注入依赖（外部请用 configureDependencies/resetDependencies）。 */
export function getDependencies() {
  return deps;
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

/** 解析 HH:mm 为「当天分钟数」；非法返回 null。 */
export function parseClockTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function localMinuteOfDay(ts, timeZone = config.scheduler.timezone) {
  const parts = getZonedParts(ts, timeZone);
  return parts.hour * 60 + parts.minute;
}

/** 任务是否配置了每日生效时间段（仅 interval 有意义；成对且 start!=end）。 */
export function scheduleWindowOf(task) {
  const start = task?.schedule?.windowStart ?? task?.window_start ?? task?.windowStart ?? '';
  const end = task?.schedule?.windowEnd ?? task?.window_end ?? task?.windowEnd ?? '';
  const startMinutes = parseClockTime(start);
  const endMinutes = parseClockTime(end);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return null;
  return { startMinutes, endMinutes, start, end };
}

/** 时间戳是否落在每日生效时间段内（支持跨午夜；区间 [start, end]）。 */
export function isInDailyWindow(ts, start, end, timeZone = config.scheduler.timezone) {
  const startMinutes = typeof start === 'number' ? start : parseClockTime(start);
  const endMinutes = typeof end === 'number' ? end : parseClockTime(end);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return false;
  const minute = localMinuteOfDay(ts, timeZone);
  if (startMinutes < endMinutes) return minute >= startMinutes && minute <= endMinutes;
  // 跨午夜：22:00–06:00（含 06:00）
  return minute >= startMinutes || minute <= endMinutes;
}

/** ts 之后（严格）的下一个窗口开始时间；无有效窗口返回 null。 */
export function nextWindowStart(ts, start, end, timeZone = config.scheduler.timezone) {
  const startMinutes = typeof start === 'number' ? start : parseClockTime(start);
  const endMinutes = typeof end === 'number' ? end : parseClockTime(end);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return null;
  const local = getZonedParts(ts, timeZone);
  for (let offset = 0; offset <= 2; offset += 1) {
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    const candidate = zonedWallTimeToUtc(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      Math.floor(startMinutes / 60),
      startMinutes % 60,
      timeZone,
    );
    if (candidate > Number(ts)) return candidate;
  }
  return null;
}

/** 把 candidate 落入窗口：在窗口内直接用；否则取 candidate 之后的下一个窗口 start。 */
function clampToWindow(candidate, window, timeZone = config.scheduler.timezone) {
  if (!window) return candidate;
  if (isInDailyWindow(candidate, window.startMinutes, window.endMinutes, timeZone)) return candidate;
  return (
    nextWindowStart(candidate, window.startMinutes, window.endMinutes, timeZone) ??
    nextWindowStart(Date.now(), window.startMinutes, window.endMinutes, timeZone) ??
    candidate
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
  const intervalMs = Number(task.intervalMs ?? task.interval_ms ?? task?.schedule?.intervalMs ?? 3600000);
  const clamped = Math.min(MAX_INTERVAL_MS, Math.max(60_000, Number.isFinite(intervalMs) ? intervalMs : 3600000));
  const window = scheduleWindowOf(task);
  if (!window) return Number(now) + clamped;
  const timeZone = config.scheduler.timezone;
  if (!isInDailyWindow(now, window.startMinutes, window.endMinutes, timeZone)) {
    // 早于窗口 start → 当天窗口 start；晚于窗口 end → 下一个窗口 start
    return nextWindowStart(now, window.startMinutes, window.endMinutes, timeZone) ?? Number(now) + clamped;
  }
  // now 在窗口内：candidate=now+interval；超出窗口 end 则到下一个窗口 start
  return clampToWindow(Number(now) + clamped, window, timeZone);
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
  const candidate = Number(runStartedAt) + intervalMs;
  const window = scheduleWindowOf(task);
  if (!window) return candidate;
  // candidate 在窗口内 → 用它；否则取 candidate 之后的下一个窗口 start
  return clampToWindow(candidate, window, config.scheduler.timezone);
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
      const window = scheduleWindowOf(task);
      const overdue = Number(now) - nextRunAt;
      if (window) {
        // 启动对账：next_run_at 必须落在窗口内，避免启动后立即执行窗口外任务
        if (!isInDailyWindow(nextRunAt, window.startMinutes, window.endMinutes, config.scheduler.timezone)) {
          const normalized =
            overdue > 0
              ? nextWindowStart(now, window.startMinutes, window.endMinutes, config.scheduler.timezone)
              : nextWindowStart(nextRunAt, window.startMinutes, window.endMinutes, config.scheduler.timezone);
          if (normalized) {
            store.updateScheduledTask(task.id, { nextRunAt: normalized });
            changed += 1;
          }
        } else if (overdue > MAX_CATCHUP_MS) {
          const advanced = advanceIntervalNextRun(nextRunAt, task.schedule.intervalMs, now);
          store.updateScheduledTask(task.id, {
            nextRunAt: clampToWindow(advanced, window, config.scheduler.timezone),
          });
          changed += 1;
        }
        continue;
      }
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
