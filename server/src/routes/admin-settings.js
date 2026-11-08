/**
 * 管理后台：运行配置/设置/重置、机密管理（管理密码、API Token）、容器自重启（docs/SETTINGS.md）。
 */
import fs from 'node:fs';

import * as auth from '../auth.js';
import { config } from '../config.js';
import { AppError, ErrorCodes, badRequest, conflict } from '../errors.js';
import { logger } from '../logger.js';
import { previewToken, requireJsonBody } from '../http/helpers.js';
import * as media from '../media.js';
import * as settings from '../settings.js';
import * as store from '../store.js';

const log = logger.child({ mod: 'api' });

export function registerAdminSettingsRoutes(app) {
  app.get('/api/admin/config', auth.requireAdmin, (req, res) => {
    res.json({
      version: config.version,
      rateLimit: { max: config.push.rateLimitMax, windowMs: config.push.rateLimitWindowMs },
      binding: {
        ttlMs: config.binding.ttlMs,
        maxRefreshes: config.binding.maxRefreshes,
        maxActiveSessions: config.binding.maxActiveSessions,
      },
      pushApiEnabled: config.pushApiEnabled,
      apiTokenPreview: config.pushApiEnabled ? previewToken(config.secrets.apiToken) : '已禁用',
      dataDir: config.dataDir,
      media: { ...media.getMediaLimits(), dir: config.media.dir },
      keepalive: {
        enabled: config.keepalive.enabled,
        windowMs: config.keepalive.windowMs,
        leadMs: config.keepalive.leadMs,
        repeatMs: config.keepalive.repeatMs,
        tickMs: config.keepalive.tickMs,
        maxPerTick: config.keepalive.maxPerTick,
        text: config.keepalive.text,
      },
    });
  });

  // 运行配置（后台可改设置，docs/SETTINGS.md §3）
  app.get('/api/admin/settings', auth.requireAdmin, (req, res) => {
    res.json(settings.getSettings());
  });

  app.patch('/api/admin/settings', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    const result = settings.updateSettings(body);
    log.info('运行配置已更新（API）', { restartRequired: result.restartRequired });
    res.json(result);
  });

  app.post('/api/admin/settings/reset', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    if (typeof body.group !== 'string' || body.group.trim() === '') {
      throw badRequest('group 必须是非空字符串');
    }
    const result = settings.resetGroup(body.group.trim());
    log.info('运行配置分组已恢复默认（API）', { group: body.group.trim() });
    res.json(result);
  });

  // 机密管理（docs/SETTINGS.md §7.3）：管理密码 / API Token（事件不记机密值）
  app.post('/api/admin/security/password', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    if (typeof body.currentPassword !== 'string' || body.currentPassword === '') {
      throw badRequest('currentPassword 必须是非空字符串');
    }
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 8 || body.newPassword.length > 128) {
      throw badRequest('newPassword 长度必须是 8..128');
    }
    const result = settings.changeAdminPassword(body.currentPassword, body.newPassword);
    log.info('管理密码已更新', { source: result.adminPasswordSource });
    res.json(result);
  });

  app.post('/api/admin/security/password/reset', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    if (typeof body.currentPassword !== 'string' || body.currentPassword === '') {
      throw badRequest('currentPassword 必须是非空字符串');
    }
    const result = settings.resetAdminPassword(body.currentPassword);
    log.info('管理密码已重置为随机密码', { source: result.adminPasswordSource });
    res.json(result);
  });

  app.post('/api/admin/security/api-token/rotate', auth.requireAdminWrite, (req, res) => {
    const result = settings.rotateApiToken();
    // 注意：Token 明文只在本次响应用户主动复制，不写日志/事件
    log.info('API Token 已重新生成（DB 密文）');
    res.json(result);
  });

  app.post('/api/admin/security/api-token/reset', auth.requireAdminWrite, (req, res) => {
    const result = settings.resetApiToken();
    log.info('API Token 已恢复环境变量默认', { source: result.apiTokenSource });
    res.json(result);
  });

  // 管理端：重启容器（依赖 docker-compose restart: unless-stopped；非容器环境返回 409）
  // 冷却状态随 createApp() 每次创建独立保存（与原 api.js 内闭包语义一致）。
  let lastRestartRequestAt = 0;
  const RESTART_COOLDOWN_MS = 15000;
  app.post('/api/admin/system/restart', auth.requireAdminWrite, (req, res) => {
    // 仅生产容器环境允许自重启（依赖 docker-compose restart: unless-stopped）；
    // 测试环境（NODE_ENV=test）或非容器运行返回 409，避免误杀进程。
    const inContainer =
      process.env.NODE_ENV === 'production' &&
      (fs.existsSync('/.dockerenv') || String(process.env.DATA_DIR || '') === '/app/data');
    if (!inContainer) {
      throw conflict('当前非生产容器运行环境，无法自动重启容器；请手动重启服务');
    }
    const now = Date.now();
    if (now - lastRestartRequestAt < RESTART_COOLDOWN_MS) {
      throw new AppError(ErrorCodes.RATE_LIMITED, '重启请求过于频繁，请稍后再试', { status: 429 });
    }
    lastRestartRequestAt = now;
    store.addEvent({ type: 'system_restart', detail: 'admin request' });
    log.info('管理员请求重启容器');
    res.status(202).json({
      ok: true,
      message: '容器将在约 1 秒后重启，请稍候刷新页面',
      etaSeconds: 10,
    });
    setTimeout(() => {
      try {
        process.kill(process.pid, 'SIGTERM');
      } catch {
        process.exit(0);
      }
    }, 1000).unref();
  });
}
