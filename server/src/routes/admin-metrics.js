/**
 * 管理后台：可观测性指标（只读）。
 *
 * `GET /api/admin/metrics` 返回进程内指标快照 + DB 24h 聚合（docs/API.md §2.8、
 * docs/ARCHITECTURE.md §20）。仅管理端 Cookie 会话可读；不写库、不回传任何用户数据。
 */
import * as auth from '../auth.js';
import * as metrics from '../metrics.js';

export function registerAdminMetricsRoutes(app) {
  app.get('/api/admin/metrics', auth.requireAdmin, async (req, res) => {
    res.json(await metrics.snapshot());
  });
}
