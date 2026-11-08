/**
 * 请求参数/请求体校验的通用部分：枚举集合、分组字段、入站查询、基础字符串与 URL 校验。
 *
 * 从 api.js 等价迁出；规则/定时任务两个大 patch builder 因体量分别放在
 * app-rule-validators.js 与 scheduled-validators.js（见重构报告说明）。
 */
import { badRequest } from '../errors.js';
import * as store from '../store.js';

export const USER_STATUSES = new Set(['active', 'unbound', 'paused', 'all']);
export const MESSAGE_DIRECTIONS = new Set(['inbound', 'outbound', 'all']);
export const MESSAGE_STATUSES = new Set(['queued', 'sending', 'sent', 'failed', 'received']);

// ---------------------------------------------------------------------------
// 用户分组 / 入站消息 API 辅助（docs/GROUPS_AND_INBOUND.md）
// ---------------------------------------------------------------------------

const GROUP_NAME_MAX = 40;
const GROUP_DESCRIPTION_MAX = 200;
const GROUP_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const INBOUND_DEFAULT_LIMIT = 50;
const INBOUND_MAX_LIMIT = 200;
const INBOUND_MAX_WAIT_SECONDS = 30;
export const INBOUND_WAIT_POLL_MS = 500;

/** 校验分组名：trim 后 1..40 字符。 */
export function parseGroupName(value) {
  if (typeof value !== 'string') throw badRequest('name 必须是字符串');
  const name = value.trim();
  if (name === '') throw badRequest('name 不能为空');
  if (name.length > GROUP_NAME_MAX) throw badRequest(`name 不能超过 ${GROUP_NAME_MAX} 个字符`);
  return name;
}

/** 校验分组描述：可选，≤200 字符（trim）。 */
export function parseGroupDescription(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest('description 必须是字符串');
  const description = value.trim();
  if (description.length > GROUP_DESCRIPTION_MAX) {
    throw badRequest(`description 不能超过 ${GROUP_DESCRIPTION_MAX} 个字符`);
  }
  return description;
}

/** 校验分组颜色：空或 #RRGGBB。 */
export function parseGroupColor(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !GROUP_COLOR_RE.test(value.trim())) {
    throw badRequest('color 必须是空或 #RRGGBB 格式');
  }
  return value.trim();
}

/**
 * 判断是否为 SQLite 唯一约束冲突。
 * 并发创建/改名同名分组时，"先查重再写入"之间存在竞态，最终由唯一索引兜底抛错，
 * 业务上应映射为 409 CONFLICT 而不是 500（QA nit-1）。
 */
export function isUniqueConstraintError(err) {
  const message = String(err?.message ?? '');
  return (
    err?.errcode === 2067 ||
    /UNIQUE constraint failed/i.test(message) ||
    /SQLITE_CONSTRAINT_UNIQUE/i.test(message)
  );
}

/** 解析 GET /api/v1/inbound/messages 查询参数（非法 → 400）。 */
export function parseInboundQuery(query = {}) {
  let limit = INBOUND_DEFAULT_LIMIT;
  if (query.limit !== undefined && query.limit !== '') {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 1 || n > INBOUND_MAX_LIMIT) {
      throw badRequest(`limit 必须是 1..${INBOUND_MAX_LIMIT} 的整数`);
    }
    limit = n;
  }
  let since = 0;
  if (query.since !== undefined && query.since !== '') {
    const n = Number(query.since);
    if (!Number.isInteger(n) || n < 0) throw badRequest('since 必须是非负毫秒时间戳整数');
    since = n;
  }
  let cursor = null;
  if (query.cursor !== undefined && query.cursor !== '') {
    try {
      cursor = store.decodeInboundCursor(String(query.cursor));
    } catch (err) {
      throw badRequest(`cursor 非法：${err.message}`);
    }
  }
  let wait = 0;
  if (query.wait !== undefined && query.wait !== '') {
    const n = Number(query.wait);
    if (!Number.isFinite(n) || n < 0 || n > INBOUND_MAX_WAIT_SECONDS) {
      throw badRequest(`wait 必须是 0..${INBOUND_MAX_WAIT_SECONDS} 秒`);
    }
    wait = n;
  }
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  const groupId = typeof query.groupId === 'string' ? query.groupId.trim() : '';
  return { limit, since, cursor, wait, userId, groupId };
}

// ---------------------------------------------------------------------------
// 接口应用 / 定时任务的公共请求体校验原语（docs/API_RULES.md §7）
// ---------------------------------------------------------------------------

export function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest(`${field} 必须是对象`);
  return value;
}

export function requiredString(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') throw badRequest(`${field} 必须是字符串`);
  const text = value.trim();
  if (text.length < min || text.length > max) throw badRequest(`${field} 长度必须是 ${min}..${max}`);
  return text;
}

export function optionalString(value, field, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest(`${field} 必须是字符串`);
  if (value.length > max) throw badRequest(`${field} 过长（≤${max}）`);
  return value;
}

export function validRegexSource(value) {
  try {
    new RegExp(value, 'u');
    return true;
  } catch {
    return false;
  }
}

export function validateHttpUrl(value) {
  const raw = requiredString(value, 'request.url', { min: 1, max: 2000 });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('request.url 不是合法 URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('request.url 仅允许 http/https');
  if (url.username || url.password) throw badRequest('request.url 不允许包含用户名/密码（userinfo）');
  return raw;
}
