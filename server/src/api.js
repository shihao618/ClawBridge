/**
 * HTTP 应用组合根（api.js）：只负责中间件顺序与路由挂载，返回 Express app。
 *
 * 分层（自 api.js 等价拆分，行为与对外契约不变）：
 * - http/middleware.js：安全头 / API no-store / JSON body / 媒体 raw body / 404 / 统一错误处理；
 * - http/helpers.js、views.js、validators.js、app-rule-validators.js、scheduled-validators.js、
 *   media-handlers.js、queue-service.js：校验、视图、媒体 IO、入队等可复用逻辑；
 * - routes/*.js：按领域注册路由（公开、admin、v1、webhook、页面）。
 *
 * 契约见 docs/API.md；安全约定见 docs/ARCHITECTURE.md §8：
 * - 统一 JSON 错误格式 { error: { code, message } }，404 也返回 JSON；
 * - 安全响应头（nosniff / DENY / no-referrer / CSP）；
 * - JSON body 上限 64KB；
 * - 管理后台 Cookie 会话 + 写接口 X-Requested-With 防 CSRF；
 * - 推送 API Key 鉴权；绑定会话 secret 只返回一次。
 *
 * Express 5 会自动捕获 async 路由抛出的错误并交给错误中间件。
 */
import express from 'express';

import { config } from './config.js';
import {
  createJsonBodyParser,
  createRawMediaBodyParser,
  errorHandler,
  noStoreApi,
  notFoundHandler,
  securityHeaders,
} from './http/middleware.js';
import { registerAdminAuthRoutes } from './routes/admin-auth.js';
import { registerAdminGroupsRoutes } from './routes/admin-groups.js';
import { registerAdminMessagesRoutes } from './routes/admin-messages.js';
import { registerAdminRulesRoutes } from './routes/admin-rules.js';
import { registerAdminScheduledRoutes } from './routes/admin-scheduled.js';
import { registerAdminSettingsRoutes } from './routes/admin-settings.js';
import { registerAdminUsersRoutes } from './routes/admin-users.js';
import { registerPagesRoutes } from './routes/pages.js';
import { registerBindRoutes, registerHealthRoutes } from './routes/public.js';
import { registerV1Routes } from './routes/v1.js';
import { registerWebhookRoutes } from './routes/webhook.js';

/**
 * 创建 Express 应用（index.js 与测试共用）。
 * @returns {import('express').Express}
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  // 媒体上传原始二进制解析器必须在运行配置覆盖加载后创建（createApp 由 index 在 loadOverrides 后调用），
  // 否则 media.maxBytes 的 restartRequired 设置即使重启也不会生效。
  const parseRawMediaBody = createRawMediaBodyParser();

  // 1) 安全响应头（所有响应，包含静态资源）
  app.use(securityHeaders);

  // 2) API 响应不缓存
  app.use(noStoreApi);

  // 3) 健康检查（无需鉴权、无需 body 解析）
  registerHealthRoutes(app);

  // 4) JSON body 解析：上限 64KB；媒体上传路径绕过（由后面的 express.raw 读取原始字节）
  app.use(createJsonBodyParser());

  // 5) 各路由（分组注册；路径互不重叠，匹配顺序不影响行为；中间件顺序由上面保证）
  registerBindRoutes(app);
  registerAdminAuthRoutes(app);
  registerAdminUsersRoutes(app);
  registerAdminGroupsRoutes(app);
  registerAdminRulesRoutes(app);
  registerAdminScheduledRoutes(app);
  registerAdminSettingsRoutes(app);
  registerAdminMessagesRoutes(app, { parseRawMediaBody });
  registerWebhookRoutes(app);
  registerV1Routes(app, { parseRawMediaBody });

  // 6) 静态资源与页面路由
  registerPagesRoutes(app);

  // 7) 404 与统一错误处理（错误处理必须最后注册）
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
