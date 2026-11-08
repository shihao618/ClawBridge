/**
 * 管理后台：登录/登出/会话查询与概览。
 */
import * as auth from '../auth.js';
import { config } from '../config.js';
import { AppError, ErrorCodes, badRequest } from '../errors.js';
import { requireJsonBody } from '../http/helpers.js';
import * as binding from '../binding.js';
import * as monitor from '../monitor.js';
import * as store from '../store.js';

export function registerAdminAuthRoutes(app) {
  app.post('/api/admin/login', (req, res) => {
    const ip = auth.getClientIp(req);
    auth.checkLoginRateLimit(ip);
    const body = requireJsonBody(req);
    const password = typeof body.password === 'string' ? body.password : '';
    if (password === '') throw badRequest('请输入管理员密码');
    if (!auth.verifyAdminPassword(password)) {
      auth.recordLoginEvent(store, { success: false, ip });
      throw new AppError(ErrorCodes.UNAUTHORIZED, '密码错误', { status: 401 });
    }
    // 成功登录不占用失败限流额度，避免同一出口 IP 反复登录后被误锁。
    auth.loginLimiter.reset(ip);
    const payload = auth.setAdminSessionCookie(res);
    auth.recordLoginEvent(store, { success: true, ip });
    res.json({ ok: true, expiresAt: payload?.exp ?? Date.now() + config.session.ttlMs });
  });

  app.post('/api/admin/logout', auth.requireWriteHeader, (req, res) => {
    auth.clearAdminSessionCookie(res);
    res.status(204).end();
  });

  app.get('/api/admin/me', (req, res) => {
    const session = auth.getAdminSession(req);
    if (!session) {
      res.json({ authenticated: false });
      return;
    }
    res.json({ authenticated: true, expiresAt: session.exp });
  });

  app.get('/api/admin/overview', auth.requireAdmin, (req, res) => {
    const stats = store.getStats();
    res.json({
      stats: {
        totalUsers: stats.totalUsers,
        activeUsers: stats.activeUsers,
        pausedUsers: stats.pausedUsers,
        usersWithContextToken: stats.usersWithContextToken,
        messagesToday: stats.messagesToday,
        queued: stats.queued,
        sending: stats.sending,
        sent: stats.sent,
        failed: stats.failed,
        inboundLast24h: stats.inboundLast24h,
        keepaliveEnabledUsers: stats.keepaliveEnabledUsers,
        keepaliveSent24h: stats.keepaliveSent24h,
      },
      server: {
        version: config.version,
        uptimeMs: Math.round(process.uptime() * 1000),
        now: Date.now(),
        ilink: {
          loginBaseUrl: config.ilink.loginBaseUrl,
          defaultBaseUrl: config.ilink.defaultBaseUrl,
          botType: config.ilink.botType,
        },
        rateLimit: { max: config.push.rateLimitMax, windowMs: config.push.rateLimitWindowMs },
        monitorsRunning: monitor.runningCount(),
        bindingSessionsActive: binding.getActiveSessionCount(),
      },
    });
  });
}
