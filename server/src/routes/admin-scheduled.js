/**
 * 管理后台：定时通知（scheduled-tasks）CRUD / 测试 / 立即执行 / 日志（docs/SCHEDULED_TASKS.md §5）。
 */
import * as auth from '../auth.js';
import { badRequest, notFound } from '../errors.js';
import { logger } from '../logger.js';
import { requireJsonBody, parseLimit, parseOffset } from '../http/helpers.js';
import { SCHEDULED_TASK_STATUSES, buildScheduledTaskPatch } from '../http/scheduled-validators.js';
import * as scheduler from '../scheduler.js';
import * as store from '../store.js';

const log = logger.child({ mod: 'api' });

export function registerAdminScheduledRoutes(app) {
  app.get('/api/admin/scheduled-tasks', auth.requireAdmin, (req, res) => {
    res.json({ items: store.listScheduledTasks() });
  });

  app.post('/api/admin/scheduled-tasks', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    const patch = buildScheduledTaskPatch(body, { requireAll: true });
    patch.nextRunAt = scheduler.computeInitialNextRun(patch);
    const task = store.createScheduledTask(patch);
    log.info('定时任务已创建', { taskId: task.id, name: task.name, nextRunAt: task.nextRunAt });
    res.status(201).json({ task });
  });

  app.post('/api/admin/scheduled-tasks/:id/duplicate', auth.requireAdminWrite, (req, res) => {
    const task = store.duplicateScheduledTask(req.params.id);
    if (!task) throw notFound('定时任务不存在');
    log.info('定时任务已复制', { sourceTaskId: req.params.id, taskId: task.id, name: task.name });
    res.status(201).json({ task });
  });

  app.get('/api/admin/scheduled-tasks/:id', auth.requireAdmin, (req, res) => {
    const task = store.getScheduledTask(req.params.id);
    if (!task) throw notFound('定时任务不存在');
    res.json({ task });
  });

  app.patch('/api/admin/scheduled-tasks/:id', auth.requireAdminWrite, (req, res) => {
    const row = store.getScheduledTaskRow(req.params.id);
    if (!row) throw notFound('定时任务不存在');
    const body = requireJsonBody(req);
    const patch = buildScheduledTaskPatch(body, { requireAll: false });
    // windowStart/windowEnd 也影响 interval 任务下次执行位置：仅改窗口同样需要重算 next_run_at。
    const scheduleKeys = ['scheduleType', 'intervalMs', 'dailyTime', 'windowStart', 'windowEnd'];
    const scheduleChanged = scheduleKeys.some((key) => patch[key] !== undefined);
    const oldNextRunAt = Number(row.next_run_at) || 0;
    if (patch.enabled === false) {
      patch.nextRunAt = 0;
    } else if (patch.enabled === true || scheduleChanged || oldNextRunAt <= 0) {
      patch.nextRunAt = scheduler.computeInitialNextRun({
        scheduleType: patch.scheduleType ?? row.schedule_type,
        intervalMs: patch.intervalMs ?? row.interval_ms,
        dailyTime: patch.dailyTime ?? row.daily_time,
        windowStart: patch.windowStart ?? row.window_start,
        windowEnd: patch.windowEnd ?? row.window_end,
      });
    }
    const task = store.updateScheduledTask(req.params.id, patch);
    log.info('定时任务已更新', { taskId: task.id, enabled: task.enabled, nextRunAt: task.nextRunAt });
    res.json({ task });
  });

  app.delete('/api/admin/scheduled-tasks/:id', auth.requireAdminWrite, (req, res) => {
    if (!store.deleteScheduledTask(req.params.id)) throw notFound('定时任务不存在');
    log.info('定时任务已删除', { taskId: req.params.id });
    res.status(204).end();
  });

  app.post('/api/admin/scheduled-tasks/:id/test', auth.requireAdminWrite, async (req, res) => {
    if (!store.getScheduledTaskRow(req.params.id)) throw notFound('定时任务不存在');
    const result = await scheduler.runScheduledTaskNow(req.params.id, { dryRun: true });
    log.info('定时任务测试运行（dry-run）', { taskId: req.params.id, httpStatus: result?.httpStatus, error: result?.error });
    res.json(result);
  });

  app.post('/api/admin/scheduled-tasks/:id/run', auth.requireAdminWrite, async (req, res) => {
    const row = store.getScheduledTaskRow(req.params.id);
    if (!row) throw notFound('定时任务不存在');
    if (!Number(row.enabled)) throw badRequest('任务未启用，禁止立即执行（请先启用）');
    const result = await scheduler.runScheduledTaskNow(req.params.id, { dryRun: false });
    res.json({
      status: result.status,
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      recipientsCount: result.recipientsCount,
      error: result.error,
    });
  });

  app.get('/api/admin/scheduled-task-logs', auth.requireAdmin, (req, res) => {
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    if (status !== '' && !SCHEDULED_TASK_STATUSES.has(status)) {
      throw badRequest('status 只能是 success | failed | skipped');
    }
    res.json(
      store.listScheduledTaskLogs({
        taskId,
        status,
        limit: parseLimit(req.query.limit, 50, 500),
        offset: parseOffset(req.query.offset),
      }),
    );
  });
}
