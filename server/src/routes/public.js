/**
 * 公开路由：健康检查（必须在 JSON body 解析前注册）与扫码绑定。
 */
import * as auth from '../auth.js';
import * as binding from '../binding.js';

import { healthPayload, requireJsonBody } from '../http/helpers.js';

/**
 * 健康检查（无需鉴权、无需 body 解析）。
 * 必须在全局 JSON parser 之前注册（原 api.js 顺序约束）。
 */
export function registerHealthRoutes(app) {
  app.get('/health', (req, res) => res.json(healthPayload()));
  app.get('/api/health', (req, res) => res.json(healthPayload()));
}

/** 公开接口：扫码绑定（docs/API.md）。 */
export function registerBindRoutes(app) {
  app.post('/api/bind/sessions', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const created = await binding.createSession({ displayName: body.displayName, ip: auth.getClientIp(req) });
    res.status(201).json(created);
  });

  app.get('/api/bind/sessions/:sessionId', (req, res) => {
    res.json(binding.getSession({ sessionId: req.params.sessionId, token: req.query.token }));
  });

  app.post('/api/bind/sessions/:sessionId/verify-code', (req, res) => {
    const body = requireJsonBody(req);
    const result = binding.submitVerifyCode({
      sessionId: req.params.sessionId,
      token: body.token,
      code: body.code,
    });
    res.status(202).json(result);
  });

  app.delete('/api/bind/sessions/:sessionId', (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    binding.cancelSession({ sessionId: req.params.sessionId, token: body.token });
    res.status(204).end();
  });
}
