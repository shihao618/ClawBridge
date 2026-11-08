/**
 * 数据层共享工具：ID 生成、名称复制、数值/分页/模糊匹配工具、JSON 解析与时区工具。
 *
 * 从 store.js 内部工具等价迁出；startOfDayInTimeZone 为 新增（按调度时区计算当日零点）。
 */
import { config } from '../config.js';
import { randomUuid } from '../crypto.js';

export function newUserId() {
  return `u_${randomUuid()}`;
}

export function newOutboxId() {
  return `ob_${randomUuid()}`;
}

export function newInboundId() {
  return `in_${randomUuid()}`;
}

export function newAttachmentId() {
  return `att_${randomUuid()}`;
}

export function newGroupId() {
  return `grp_${randomUuid()}`;
}

export function newAppRuleId() {
  return `rule_${randomUuid()}`;
}

export function newScheduledTaskId() {
  return `task_${randomUuid()}`;
}

/** 复制项名称：追加「（副本）」，同时满足名称长度上限。 */
export function copyName(name, fallback) {
  const suffix = '（副本）';
  const base = String(name || fallback).trim() || fallback;
  return `${base.slice(0, Math.max(1, 60 - suffix.length))}${suffix}`;
}

/** 附件默认 URL 前缀（管理端）；v1 API 视图可传 '/api/v1/media'。 */
export const DEFAULT_MEDIA_URL_PREFIX = '/api/admin/media';

export function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function clampInt(value, { min = 0, max = 500, fallback = 50 } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function likePattern(q) {
  return `%${String(q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** 安全解析 JSON 字段。 */
export function parseJsonValue(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// 时区工具（概览“今日”与调度使用同一时区口径）
// ---------------------------------------------------------------------------

/** 读取某时刻在指定 IANA 时区下的本地日期/时间字段（失败抛错，由调用方兜底）。 */
function zonedDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

/**
 * 计算指定 IANA 时区下“当日 00:00:00”的 UTC 毫秒时间戳。
 * 非法时区回退到进程本地时区（与旧行为一致，避免统计接口 500）。
 * @param {number} [now]
 * @param {string} [timeZone]
 * @returns {number}
 */
export function startOfDayInTimeZone(now = Date.now(), timeZone = config.scheduler.timezone) {
  const nowValue = toNumber(now, Date.now());
  const fallback = () => {
    const date = new Date(nowValue);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  let parts;
  try {
    parts = zonedDateParts(new Date(nowValue), timeZone);
  } catch {
    return fallback;
  }
  if (!parts.year || !parts.month || !parts.day) return fallback();
  let guess = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0, 0);
  // 迭代修正时区偏移（覆盖 DST 边界；当前日期零点最多 1~2 次收敛）。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let zoned;
    try {
      zoned = zonedDateParts(new Date(guess), timeZone);
    } catch {
      return fallback();
    }
    const asUtc = Date.UTC(
      Number(zoned.year),
      Number(zoned.month) - 1,
      Number(zoned.day),
      Number(zoned.hour),
      Number(zoned.minute),
      Number(zoned.second),
      0,
    );
    const diff = asUtc - guess;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}
