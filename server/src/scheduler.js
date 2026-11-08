/**
 * 定时通知调度器 façade（scheduler.js）。
 *
 * 实现已拆分（docs/review/backend.md §3.2/§3.3 收尾）：
 * - scheduler/calc.js：计划计算（interval/daily/window/时区）、next_run 推进、启动补跑对账、
 *   可注入依赖锚点（now/httpRequest）；
 * - scheduler/index.js：tick 扫描/执行/目标入队/日志/启停/手动执行 + getHttpLimits。
 *
 * 本文件只做 re-export，保持既有导出名与调用方（index / routes / store / 测试）零改动。
 */
export {
  advanceIntervalNextRun,
  computeDailyNextRun,
  computeInitialNextRun,
  computeNextAfterRun,
  configureDependencies,
  getZonedParts,
  isInDailyWindow,
  nextWindowStart,
  parseClockTime,
  parseDailyTime,
  reconcileStartupTasks,
  resetDependencies,
  scheduleWindowOf,
  zonedWallTimeToUtc,
} from './scheduler/calc.js';
export {
  buildScheduleVars,
  executeScheduledTask,
  getHttpLimits,
  isRunning,
  isScheduledTaskInFlight,
  parseScheduledTaskRow,
  restart,
  runScheduledTaskNow,
  start,
  stop,
  tick,
  waitForIdleTicks,
} from './scheduler/index.js';
