/**
 * 概览/摘要类纯函数（无 DOM，可被 node:test 直接 import）。
 *
 * 从 admin.js 抽出：规则生效范围/触发条件摘要、定时计划/目标摘要、间隔格式化。
 */
import { formatNumber } from '../common.js';

/** 规则生效范围文案（docs/API_RULES.md §7）。 */
export const RULE_SCOPE_LABELS = { all: '全部用户', users: '指定用户', groups: '指定分组' };
/** 规则触发匹配方式文案。 */
export const RULE_MATCH_LABELS = { contains: '包含', equals: '全等', regex: '正则' };

/**
 * 规则生效范围摘要。
 * @param {object|null|undefined} scope
 * @returns {string}
 */
export function scopeSummary(scope) {
  if (!scope || typeof scope !== 'object') return '全部用户';
  const typeLabel = RULE_SCOPE_LABELS[scope.type] || scope.type || '全部用户';
  if (scope.type === 'all' || !scope.type) return typeLabel;
  const names = Array.isArray(scope.names) ? scope.names.filter((name) => typeof name === 'string' && name) : [];
  if (names.length > 0) {
    return `${typeLabel}：${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 个` : ''}`;
  }
  const count = Array.isArray(scope.ids) ? scope.ids.length : 0;
  return `${typeLabel}（${count} 个）`;
}

/**
 * 规则触发条件摘要。
 * @param {object|null|undefined} trigger
 * @returns {string}
 */
export function triggerSummary(trigger) {
  if (!trigger || typeof trigger !== 'object') return '—';
  if (trigger.matchMode === 'regex') return `正则：${trigger.regexPattern || '—'}`;
  const modeLabel = RULE_MATCH_LABELS[trigger.matchMode] || trigger.matchMode || '包含';
  const keywords = Array.isArray(trigger.keywords) ? trigger.keywords : [];
  return `${modeLabel}：${keywords.join('、') || '—'}`;
}

/**
 * 定时任务间隔摘要。
 * @param {number|string|undefined|null} intervalMs
 * @returns {string}
 */
export function formatIntervalSummary(intervalMs) {
  const minutes = Math.max(1, Math.round(Number(intervalMs || 0) / 60000));
  if (minutes < 60) return `每 ${formatNumber(minutes)} 分钟`;
  const hours = minutes / 60;
  if (Number.isInteger(hours) && hours < 48) return `每 ${formatNumber(hours)} 小时`;
  const days = hours / 24;
  if (Number.isInteger(days)) return `每 ${formatNumber(days)} 天`;
  return `每 ${formatNumber(minutes)} 分钟`;
}

/**
 * 定时计划摘要（每日定点 / 间隔 + 生效时间段）。
 * @param {object|null|undefined} task
 * @param {string} [timezone] 兜底时区（调用方传入当前任务时区，默认 Asia/Shanghai）
 * @returns {string}
 */
export function schedulePlanSummary(task, timezone = 'Asia/Shanghai') {
  const schedule = task && task.schedule && typeof task.schedule === 'object' ? task.schedule : {};
  if (schedule.type === 'daily') {
    return `每天 ${schedule.dailyTime || '08:00'}（${schedule.timezone || timezone}）`;
  }
  const summary = formatIntervalSummary(schedule.intervalMs || 3600000);
  const windowStart = typeof schedule.windowStart === 'string' ? schedule.windowStart.trim() : '';
  const windowEnd = typeof schedule.windowEnd === 'string' ? schedule.windowEnd.trim() : '';
  if (windowStart && windowEnd) return `${summary}（${windowStart}–${windowEnd}）`;
  return summary;
}

/**
 * 定时任务目标摘要（全部用户 / 指定分组 / 指定用户）。
 * @param {object|null|undefined} task
 * @returns {string}
 */
export function scheduleTargetSummary(task) {
  const targets = task && task.targets && typeof task.targets === 'object' ? task.targets : {};
  if (targets.type === 'all') return '全部用户';
  const ids = Array.isArray(targets.ids) ? targets.ids : [];
  const names = Array.isArray(targets.names) ? targets.names.filter(Boolean) : [];
  if (targets.type === 'groups') {
    const label = `${formatNumber(ids.length)} 个分组`;
    return names.length > 0
      ? `${label}：${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 个` : ''}`
      : label;
  }
  return `${formatNumber(ids.length)} 位用户`;
}
