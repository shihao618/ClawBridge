/**
 * 数据生命周期维护（maintenance.js）—— 孤儿附件 / 日志保留清理。
 *
 * 定时任务（默认启动 1 分钟后首次、之后每天一次；timer 全部 unref，不阻止进程退出）：
 *  1) 附件 GC：
 *     - DB 中 status='ready' 但磁盘文件缺失的附件行 → 删除（仍被 queued/sending outbox
 *       引用的保留，交由 dispatcher 做失败处理）；
 *     - media/inbound、media/outbound 下无 DB 引用的孤儿文件 → 删除（最小文件年龄内保留，
 *       避免误删正在写入、尚未落库的文件）；
 *     - 管理端上传的 outbound 附件（user_id NULL）超过保留期且从未被任何 outbox 以
 *       media_id 引用 → 删除 DB 行 + 磁盘文件。
 *  2) 日志保留：events / app_rule_logs / scheduled_task_logs 按保留天数分批删除
 *     （0 = 关闭该清理）；outbox / inbound_messages 属业务数据，不自动删除。
 *  3) 可选：`PRAGMA optimize` 与 `PRAGMA wal_checkpoint(TRUNCATE)`（可用 env 关闭）。
 *
 * 所有删除按 batchSize 分批 + 单事务提交；每轮结束把清理计数写入运行日志。
 * start() / stop() 幂等；stop() 等待在途维护结束（超时上限），必须在 closeDb() 前调用。
 *
 * 维护参数当前从 env 读取（建议后续并入 settings 运行配置，见 docs/SETTINGS.md）：
 *  - MAINTENANCE_ENABLED=1|0               默认 1（关闭后不启动定时维护，仍可手动 runMaintenance）
 *  - MAINTENANCE_INTERVAL_MS               默认 86400000（每天一次，最小 60000）
 *  - MAINTENANCE_INITIAL_DELAY_MS          默认 60000（启动 1 分钟后首次，最小 0）
 *  - MAINTENANCE_LOG_RETENTION_DAYS        默认 90（0 = 不清理日志）
 *  - MAINTENANCE_UPLOAD_RETENTION_DAYS     默认 7（未入队上传附件保留天数，0 = 不清理）
 *  - MAINTENANCE_BATCH_SIZE                默认 200（单条 SQL 批量删除/扫描上限，1..1000）
 *  - MAINTENANCE_ORPHAN_FILE_MIN_AGE_MS    默认 3600000（孤儿文件最小年龄，防误删写入中的文件）
 *  - MAINTENANCE_PRAGMA_OPTIMIZE=1|0       默认 1
 *  - MAINTENANCE_WAL_CHECKPOINT=1|0        默认 1
 */
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { all, exec, get, run, transaction } from './db.js';
import { logger } from './logger.js';
import { resolveMediaPath } from './media.js';

const log = logger.child({ mod: 'maintenance' });

const DAY_MS = 24 * 60 * 60 * 1000;
/** 日志保留清理的表（固定白名单，避免动态表名注入）。 */
const LOG_TABLES = ['events', 'app_rule_logs', 'scheduled_task_logs'];

let running = false;
/** @type {NodeJS.Timeout|null} */
let initialTimer = null;
/** @type {NodeJS.Timeout|null} */
let intervalTimer = null;
/** 当前维护运行 Promise：防重入，stop() 用它等待在途任务。 */
let currentRun = null;
let runsTotal = 0;
/** @type {object|null} */
let lastResult = null;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

function envRaw(name) {
  const value = process.env[name];
  return value === undefined || value === null ? '' : String(value).trim();
}

function envBool(name, fallback) {
  const raw = envRaw(name).toLowerCase();
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function envInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = envRaw(name);
  if (raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 读取维护参数（env + 默认值；每次调用实时读取，便于测试/运行配置后续接入）。 */
export function readOptions() {
  return {
    enabled: envBool('MAINTENANCE_ENABLED', true),
    intervalMs: envInt('MAINTENANCE_INTERVAL_MS', DAY_MS, { min: 60_000, max: 7 * DAY_MS }),
    initialDelayMs: envInt('MAINTENANCE_INITIAL_DELAY_MS', 60_000, { min: 0, max: DAY_MS }),
    logRetentionDays: envInt('MAINTENANCE_LOG_RETENTION_DAYS', 90, { min: 0, max: 3650 }),
    uploadRetentionDays: envInt('MAINTENANCE_UPLOAD_RETENTION_DAYS', 7, { min: 0, max: 3650 }),
    batchSize: envInt('MAINTENANCE_BATCH_SIZE', 200, { min: 1, max: 1000 }),
    orphanFileMinAgeMs: envInt('MAINTENANCE_ORPHAN_FILE_MIN_AGE_MS', 60 * 60 * 1000, { min: 0, max: 7 * DAY_MS }),
    pragmaOptimize: envBool('MAINTENANCE_PRAGMA_OPTIMIZE', true),
    walCheckpoint: envBool('MAINTENANCE_WAL_CHECKPOINT', true),
  };
}

/** 解析附件相对路径为绝对路径；非法路径（目录穿越等）返回 null（视为无文件）。 */
function resolveAttachmentAbsolute(relativePath) {
  try {
    return resolveMediaPath(relativePath);
  } catch {
    return null;
  }
}

async function fileExists(absolutePath) {
  try {
    await fs.promises.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/** 附件是否仍被 queued/sending outbox 引用（这类引用必须保留，交由 dispatcher 处理失败）。 */
function hasActiveOutboxReference(attachmentId) {
  return Boolean(
    get("SELECT 1 AS hit FROM outbox WHERE media_id = ? AND status IN ('queued', 'sending') LIMIT 1", String(attachmentId)),
  );
}

/** 附件是否被任何 outbox（含已发送）以 media_id 引用。 */
function hasAnyOutboxReference(attachmentId) {
  return Boolean(get('SELECT 1 AS hit FROM outbox WHERE media_id = ? LIMIT 1', String(attachmentId)));
}

/**
 * 附件 GC 1/3：删除 DB 中无对应磁盘文件的 ready 附件行（分批 + 事务）。
 * status='failed' 的行本就允许无文件（入站下载失败场景），不在此处理。
 */
async function gcAttachmentRowsWithoutFile(batchSize) {
  let deleted = 0;
  let cursor = '';
  for (;;) {
    const rows = all(
      "SELECT id, path FROM attachments WHERE status = 'ready' AND path <> '' AND id > ? ORDER BY id ASC LIMIT ?",
      cursor,
      batchSize,
    );
    if (rows.length === 0) break;
    cursor = String(rows[rows.length - 1].id);
    const staleIds = [];
    for (const row of rows) {
      const absolutePath = resolveAttachmentAbsolute(row.path);
      if (absolutePath && (await fileExists(absolutePath))) continue;
      if (hasActiveOutboxReference(row.id)) continue;
      staleIds.push(String(row.id));
    }
    if (staleIds.length > 0) {
      deleted += transaction(() => {
        let removed = 0;
        for (const id of staleIds) removed += Number(run('DELETE FROM attachments WHERE id = ?', id).changes) || 0;
        return removed;
      });
    }
    if (rows.length < batchSize) break;
  }
  return deleted;
}

/**
 * 附件 GC 2/3：清理“管理端上传但从未入队”且超过保留期的 outbound 附件（user_id NULL，
 * 无任何 outbox 引用）；删除 DB 行（事务）后再删磁盘文件（失败留给孤儿文件扫描兜底）。
 */
async function gcStaleUploads(batchSize, retentionDays, now) {
  if (!(retentionDays > 0)) return 0;
  const cutoff = now - retentionDays * DAY_MS;
  let deleted = 0;
  let cursor = '';
  for (;;) {
    const rows = all(
      `SELECT id, path FROM attachments
       WHERE direction = 'outbound' AND user_id IS NULL AND path <> '' AND created_at < ? AND id > ?
       ORDER BY id ASC LIMIT ?`,
      cutoff,
      cursor,
      batchSize,
    );
    if (rows.length === 0) break;
    cursor = String(rows[rows.length - 1].id);
    const purge = rows.filter((row) => !hasAnyOutboxReference(row.id));
    if (purge.length === 0) {
      if (rows.length < batchSize) break;
      continue;
    }
    const removed = transaction(() => {
      let count = 0;
      for (const row of purge) count += Number(run('DELETE FROM attachments WHERE id = ?', String(row.id)).changes) || 0;
      return count;
    });
    deleted += removed;
    for (const row of purge) {
      const absolutePath = resolveAttachmentAbsolute(row.path);
      if (!absolutePath) continue;
      try {
        await fs.promises.rm(absolutePath, { force: true });
      } catch (err) {
        log.warn('删除过期上传附件文件失败（忽略，下次维护重试）', { attachmentId: row.id, message: err?.message });
      }
    }
    if (rows.length < batchSize) break;
  }
  return deleted;
}

/** 递归列出目录下普通文件（目录不存在返回空数组）。 */
async function listFilesRecursive(root) {
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

/**
 * 附件 GC 3/3：清理 media/inbound、media/outbound 下无 DB 引用的孤儿文件。
 * 未超过 orphanFileMinAgeMs 的新文件不动（文件先落盘、附件行后写入，存在短暂无引用窗口）。
 */
async function gcOrphanMediaFiles(minAgeMs, now) {
  const referenced = new Set();
  for (const row of all("SELECT path FROM attachments WHERE path <> ''")) {
    const absolutePath = resolveAttachmentAbsolute(row.path);
    if (absolutePath) referenced.add(path.resolve(absolutePath));
  }
  let deleted = 0;
  for (const direction of ['inbound', 'outbound']) {
    const root = path.join(config.media.dir, direction);
    for (const absolutePath of await listFilesRecursive(root)) {
      const resolved = path.resolve(absolutePath);
      if (referenced.has(resolved)) continue;
      let stat;
      try {
        stat = await fs.promises.stat(resolved);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs < minAgeMs) continue;
      try {
        await fs.promises.rm(resolved, { force: true });
        deleted += 1;
      } catch (err) {
        log.warn('删除孤儿媒体文件失败（忽略，下次维护重试）', {
          file: path.relative(config.media.dir, resolved),
          message: err?.message,
        });
      }
    }
  }
  return deleted;
}

/** 按保留天数分批删除某张日志表的超期行（单批单事务），返回删除行数。 */
function purgeExpiredLogs(table, cutoff, batchSize) {
  let deleted = 0;
  for (;;) {
    const removed = transaction(
      () =>
        Number(
          run(
            `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE created_at < ? ORDER BY id ASC LIMIT ?)`,
            cutoff,
            batchSize,
          ).changes,
        ) || 0,
    );
    deleted += removed;
    if (removed < batchSize) break;
  }
  return deleted;
}

/** 可选 SQLite 优化：PRAGMA optimize（查询计划统计）与 wal_checkpoint(TRUNCATE)（回收 WAL）。 */
function runOptimize({ pragmaOptimize, walCheckpoint }) {
  const result = { pragmaOptimize: false, walCheckpoint: false };
  if (pragmaOptimize) {
    try {
      exec('PRAGMA optimize');
      result.pragmaOptimize = true;
    } catch (err) {
      log.warn('PRAGMA optimize 失败（忽略）', { message: err?.message });
    }
  }
  if (walCheckpoint) {
    try {
      exec('PRAGMA wal_checkpoint(TRUNCATE)');
      result.walCheckpoint = true;
    } catch (err) {
      log.warn('wal_checkpoint 失败（忽略）', { message: err?.message });
    }
  }
  return result;
}

/** 执行一轮完整维护（内部实现；外部请用 runMaintenance 以获得防重入语义）。 */
async function executeMaintenance(options = {}) {
  const opts = { ...readOptions(), ...(options && typeof options === 'object' ? options : {}) };
  const startedAt = Number(options?.now) || Date.now();
  const stats = {
    startedAt,
    durationMs: 0,
    attachmentsWithoutFile: 0,
    staleUploads: 0,
    orphanMediaFiles: 0,
    logs: { events: 0, appRuleLogs: 0, scheduledTaskLogs: 0 },
    optimize: { pragmaOptimize: false, walCheckpoint: false },
  };
  try {
    stats.attachmentsWithoutFile = await gcAttachmentRowsWithoutFile(opts.batchSize);
    stats.staleUploads = await gcStaleUploads(opts.batchSize, opts.uploadRetentionDays, startedAt);
    stats.orphanMediaFiles = await gcOrphanMediaFiles(opts.orphanFileMinAgeMs, startedAt);
    if (opts.logRetentionDays > 0) {
      const cutoff = startedAt - opts.logRetentionDays * DAY_MS;
      const [events, appRuleLogs, scheduledTaskLogs] = LOG_TABLES.map((table) =>
        purgeExpiredLogs(table, cutoff, opts.batchSize),
      );
      stats.logs = { events, appRuleLogs, scheduledTaskLogs };
    }
    stats.optimize = runOptimize(opts);
  } catch (err) {
    stats.error = err?.message ?? String(err);
    log.error('数据维护执行失败（已完成的清理计数仍会返回）', { message: stats.error, stack: err?.stack });
  }
  stats.durationMs = Math.max(0, Date.now() - startedAt);
  runsTotal += 1;
  lastResult = stats;
  log.debug('数据维护完成', {
    durationMs: stats.durationMs,
    attachmentsWithoutFile: stats.attachmentsWithoutFile,
    staleUploads: stats.staleUploads,
    orphanMediaFiles: stats.orphanMediaFiles,
    events: stats.logs.events,
    appRuleLogs: stats.logs.appRuleLogs,
    scheduledTaskLogs: stats.logs.scheduledTaskLogs,
  });
  return stats;
}

/**
 * 手动/定时执行一轮维护。并发调用防重入：维护进行中再次调用返回同一个 Promise。
 * @param {object} [options] 覆盖 readOptions() 的字段（测试可传 now / retention 等）
 */
export function runMaintenance(options = {}) {
  if (currentRun) return currentRun;
  currentRun = executeMaintenance(options).finally(() => {
    currentRun = null;
  });
  return currentRun;
}

function runScheduled(trigger) {
  void runMaintenance()
    .then((result) => {
      log.info('数据维护完成', {
        trigger,
        durationMs: result.durationMs,
        error: result.error,
        attachmentsWithoutFile: result.attachmentsWithoutFile,
        staleUploads: result.staleUploads,
        orphanMediaFiles: result.orphanMediaFiles,
        events: result.logs.events,
        appRuleLogs: result.logs.appRuleLogs,
        scheduledTaskLogs: result.logs.scheduledTaskLogs,
      });
    })
    .catch((err) => log.warn('数据维护任务执行异常', { trigger, message: err?.message }));
}

/**
 * 启动定时维护（幂等；MAINTENANCE_ENABLED=0 时只记日志不启动）。
 * @returns {boolean} 本次是否真正启动
 */
export function start() {
  const options = readOptions();
  if (!options.enabled) {
    log.info('数据维护任务未启用（MAINTENANCE_ENABLED=0）');
    return false;
  }
  if (running) return false;
  running = true;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    runScheduled('initial');
  }, options.initialDelayMs);
  initialTimer.unref?.();
  intervalTimer = setInterval(() => {
    runScheduled('interval');
  }, options.intervalMs);
  intervalTimer.unref?.();
  log.info('数据维护任务已启动', {
    intervalMs: options.intervalMs,
    initialDelayMs: options.initialDelayMs,
    logRetentionDays: options.logRetentionDays,
    uploadRetentionDays: options.uploadRetentionDays,
    batchSize: options.batchSize,
    orphanFileMinAgeMs: options.orphanFileMinAgeMs,
    pragmaOptimize: options.pragmaOptimize,
    walCheckpoint: options.walCheckpoint,
  });
  return true;
}

/**
 * 停止定时维护（幂等）：清 timer 并等待在途维护结束（默认最多 10s）。
 * 必须在 closeDb() 之前调用，避免维护任务在关库后继续写/删。
 * @returns {Promise<boolean>} 本次是否从“已启动”状态停止（重复调用返回 false）
 */
export async function stop({ timeoutMs = 10_000 } = {}) {
  const wasRunning = running;
  const hadTimer = Boolean(initialTimer || intervalTimer);
  running = false;
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  if (currentRun) {
    const settled = await Promise.race([
      currentRun.then(
        () => true,
        () => true,
      ),
      sleep(Math.max(1, Number(timeoutMs) || 10_000)).then(() => false),
    ]);
    if (!settled) log.warn('数据维护停止时仍有在途任务（等待超时，由进程级兜底退出）', { timeoutMs });
  }
  if (wasRunning || hadTimer) log.info('数据维护任务已停止', { runsTotal });
  return wasRunning || hadTimer;
}

/** 定时维护是否在运行（测试/观测用）。 */
export function isRunning() {
  return running;
}

/** 维护状态（测试/观测用）。 */
export function getState() {
  return { running, runsTotal, lastResult };
}
