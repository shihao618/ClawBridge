/**
 * 进程内可观测性指标（零第三方依赖）。
 *
 * 设计约定（docs/ARCHITECTURE.md §20）：
 * - 只做**进程内内存态**：重启清零、不做持久化，也不做多副本聚合（本项目单进程部署）；
 * - 三类指标：counter（单调递增）/ gauge（瞬时值，可由 provider 动态求值）/ histogram（延迟等分布）；
 * - 规则/定时统计**不做进程内埋点**，直接从 SQLite 现有日志表按 24h 聚合（避免与引擎改动冲突）；
 * - 指标名使用点分命名 `<domain>.<name>`（如 `dispatcher.sent.total` / `media.inbound.active`）；
 * - 快照只含数值/对象，不含 userId/token/消息正文等敏感数据；仅供管理端只读接口使用；
 * - 本模块顶层**不 import db.js**（避免 media 等低层模块被间接引入 DB 打开副作用；CLI/单测可能只 import media）；
 *   聚合查询在快照时按需动态 import db.js（lazy），DB 不可用时对应分组为 null；
 * - 业务模块通过 `incCounter/observeHistogram/setGauge/registerGaugeProvider` 以最小钩子接入，不反向依赖。
 */
import { config } from './config.js';

/** 默认延迟直方图桶（毫秒，上界包含）。 */
export const DEFAULT_LATENCY_BUCKETS_MS = Object.freeze([
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
]);

const counters = new Map();
const histograms = new Map();
const gaugeValues = new Map();
const gaugeProviders = new Map();
/** @type {Promise<typeof import('./db.js')>|null} */
let dbModulePromise = null;

function normalizeName(name) {
  const text = String(name ?? '').trim();
  if (text === '') throw new Error('指标名不能为空');
  return text;
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round2(value) {
  return Math.round(toFiniteNumber(value) * 100) / 100;
}

// ---------------------------------------------------------------------------
// 注册 API（业务模块使用）
// ---------------------------------------------------------------------------

/** 计数器 +amount（默认 1）。 */
export function incCounter(name, amount = 1) {
  const key = normalizeName(name);
  counters.set(key, (counters.get(key) ?? 0) + toFiniteNumber(amount, 1));
}

/** 读取计数器当前值（测试/内部使用）。 */
export function getCounter(name) {
  return counters.get(normalizeName(name)) ?? 0;
}

/** 直接设置仪表值（静态仪表；动态值请用 registerGaugeProvider）。 */
export function setGauge(name, value) {
  gaugeValues.set(normalizeName(name), toFiniteNumber(value));
}

/**
 * 注册动态仪表：快照时调用 provider 求值。
 * provider 可返回 number 或用带后缀的 `{ active, queued }` 对象（展开为 `<name>.active` 等）。
 */
export function registerGaugeProvider(name, provider) {
  const key = normalizeName(name);
  if (typeof provider !== 'function') throw new Error('gauge provider 必须是函数');
  gaugeProviders.set(key, provider);
}

/** 记录一次直方图观测值（毫秒；负数按 0 处理）。 */
export function observeHistogram(name, value, { buckets = DEFAULT_LATENCY_BUCKETS_MS } = {}) {
  const key = normalizeName(name);
  const observation = Math.max(0, toFiniteNumber(value));
  let histogram = histograms.get(key);
  if (!histogram) {
    const bucketBounds = [...new Set(buckets.map((bound) => Math.max(0, toFiniteNumber(bound))))].sort(
      (left, right) => left - right,
    );
    histogram = {
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: 0,
      buckets: bucketBounds.map((le) => ({ le, count: 0 })),
    };
    histograms.set(key, histogram);
  }
  histogram.count += 1;
  histogram.sum += observation;
  histogram.min = Math.min(histogram.min, observation);
  histogram.max = Math.max(histogram.max, observation);
  for (const bucket of histogram.buckets) {
    if (observation <= bucket.le) bucket.count += 1;
  }
}

/** 清空所有计数器/直方图/静态仪表（动态 provider 保留；测试隔离用）。 */
export function resetMetrics() {
  counters.clear();
  histograms.clear();
  gaugeValues.clear();
}

/** 当前已注册的指标名（诊断/测试用）。 */
export function listMetricNames() {
  return {
    counters: [...counters.keys()].sort(),
    gauges: [...new Set([...gaugeValues.keys(), ...gaugeProviders.keys()])].sort(),
    histograms: [...histograms.keys()].sort(),
  };
}

// ---------------------------------------------------------------------------
// 快照求值
// ---------------------------------------------------------------------------

function resolveGauges() {
  const resolved = {};
  for (const [name, value] of gaugeValues) resolved[name] = value;
  for (const [name, provider] of gaugeProviders) {
    try {
      const value = provider();
      if (value && typeof value === 'object') {
        for (const [suffix, raw] of Object.entries(value)) {
          const number = Number(raw);
          if (Number.isFinite(number)) resolved[`${name}.${suffix}`] = number;
        }
      } else {
        const number = Number(value);
        if (Number.isFinite(number)) resolved[name] = number;
      }
    } catch {
      /* 动态仪表 provider 失败不影响整个快照 */
    }
  }
  return Object.fromEntries(Object.entries(resolved).sort(([left], [right]) => left.localeCompare(right)));
}

function histogramSnapshot(histogram) {
  return {
    count: histogram.count,
    sum: round2(histogram.sum),
    min: histogram.count > 0 ? round2(histogram.min) : 0,
    max: round2(histogram.max),
    avg: histogram.count > 0 ? round2(histogram.sum / histogram.count) : 0,
    // 桶为累计计数（le 上界包含），最后一项应等于 count。
    buckets: histogram.buckets.map((bucket) => ({ le: bucket.le, count: bucket.count })),
  };
}

function countsByStatus(rows, statuses) {
  const result = Object.fromEntries(statuses.map((status) => [status, 0]));
  let total = 0;
  for (const row of rows ?? []) {
    const count = toFiniteNumber(row?.c);
    total += count;
    if (row?.status in result) result[row.status] = count;
  }
  return { ...result, total };
}

async function safeQuery(sql, ...params) {
  try {
    if (!dbModulePromise) dbModulePromise = import('./db.js');
    const { all } = await dbModulePromise;
    return all(sql, ...params);
  } catch {
    // DB 未初始化/已关闭（例如进程退出阶段）时指标接口仍应可用，只是统计不可用。
    return null;
  }
}

/**
 * 从现有业务表聚合（24h 日志 + outbox 状态）。DB 不可用时各分组为 null。
 * @param {number} [now]
 * @returns {Promise<{outbox: object|null, appRules24h: object|null, scheduledTasks24h: object|null}>}
 */
export async function collectAggregates(now = Date.now()) {
  const since = toFiniteNumber(now) - 24 * 60 * 60 * 1000;
  const [outboxRows, ruleRows, scheduledRows] = await Promise.all([
    safeQuery('SELECT status, COUNT(*) AS c FROM outbox GROUP BY status'),
    safeQuery('SELECT status, COUNT(*) AS c FROM app_rule_logs WHERE created_at >= ? GROUP BY status', since),
    safeQuery('SELECT status, COUNT(*) AS c FROM scheduled_task_logs WHERE created_at >= ? GROUP BY status', since),
  ]);
  return {
    outbox: outboxRows === null ? null : countsByStatus(outboxRows, ['queued', 'sending', 'sent', 'failed']),
    appRules24h: ruleRows === null ? null : countsByStatus(ruleRows, ['matched', 'success', 'failed', 'skipped']),
    scheduledTasks24h:
      scheduledRows === null ? null : countsByStatus(scheduledRows, ['success', 'failed', 'skipped']),
  };
}

/**
 * 完整指标快照：`GET /api/admin/metrics` 的响应体（另在路由层补 serverTime 亦可）。
 * @param {{now?: number}} [options]
 * @returns {Promise<object>}
 */
export async function snapshot({ now = Date.now() } = {}) {
  const memory = process.memoryUsage();
  return {
    serverTime: toFiniteNumber(now),
    version: config.version,
    pid: process.pid,
    node: process.version,
    uptimeMs: Math.round(process.uptime() * 1000),
    memory: {
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers ?? 0,
    },
    heap: {
      totalBytes: memory.heapTotal,
      usedBytes: memory.heapUsed,
      usedPercent: memory.heapTotal > 0 ? round2((memory.heapUsed / memory.heapTotal) * 100) : 0,
    },
    counters: Object.fromEntries([...counters.entries()].sort(([left], [right]) => left.localeCompare(right))),
    gauges: resolveGauges(),
    histograms: Object.fromEntries(
      [...histograms.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, histogram]) => [name, histogramSnapshot(histogram)]),
    ),
    aggregates: await collectAggregates(now),
  };
}

/**
 * 概览页用的紧凑摘要（`GET /api/admin/overview` 的新增 `metrics` 字段）。
 * 只取少量关键数字，避免概览接口变重。
 * @param {{now?: number}} [options]
 * @returns {Promise<object>}
 */
export async function overviewSummary({ now = Date.now() } = {}) {
  const memory = process.memoryUsage();
  const gauges = resolveGauges();
  const aggregates = await collectAggregates(now);
  const number = (value) => toFiniteNumber(value);
  return {
    uptimeMs: Math.round(process.uptime() * 1000),
    memory: { rss: memory.rss, heapUsed: memory.heapUsed },
    gauges: {
      monitorRunningAccounts: number(gauges['monitor.running_accounts']),
      mediaInboundActive: number(gauges['media.inbound.active']),
      mediaInboundQueued: number(gauges['media.inbound.queued']),
      outboxQueued: number(aggregates.outbox?.queued),
      outboxSending: number(aggregates.outbox?.sending),
    },
    counters: {
      dispatcherSent: getCounter('dispatcher.sent.total'),
      dispatcherFailed: getCounter('dispatcher.failed.total'),
      dispatcherRetried: getCounter('dispatcher.retry.total'),
      dispatcherRateLimited: getCounter('dispatcher.rate_limited.total'),
      mediaDownloaded: getCounter('media.inbound.downloaded.total'),
      mediaDownloadFailed: getCounter('media.inbound.failed.total'),
    },
    appRules24h: aggregates.appRules24h,
    scheduledTasks24h: aggregates.scheduledTasks24h,
  };
}
