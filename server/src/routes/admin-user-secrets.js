/**
 * 管理后台：用户级凭据（user_secrets）。
 *
 * - GET    /api/admin/users/:id/secrets          → { items: [...] }（Cookie 会话，requireAdmin）
 * - PUT    /api/admin/users/:id/secrets/:name    → { item }（Cookie + CSRF，upsert，值不回显）
 * - DELETE /api/admin/users/:id/secrets/:name    → 204（Cookie + CSRF）
 *
 * 只写/掩码展示：任何响应都不回显字段值（只有掩码 hints）；字段值仅 `data/user-secrets.js`
 * 内部解密供规则/定时凭据注入使用。契约见 docs/API.md §2.9。
 */
import * as auth from '../auth.js';
import { deleteUserSecret, listUserSecrets, setUserSecret } from '../data/user-secrets.js';
import { notFound } from '../errors.js';
import { requireJsonBody } from '../http/helpers.js';
import { mustGetUserRow } from '../http/views.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'api' });

export function registerAdminUserSecretsRoutes(app) {
  app.get('/api/admin/users/:id/secrets', auth.requireAdmin, (req, res) => {
    const user = mustGetUserRow(req.params.id);
    res.json({ items: listUserSecrets(user.id) });
  });

  app.put('/api/admin/users/:id/secrets/:name', auth.requireAdminWrite, (req, res) => {
    const user = mustGetUserRow(req.params.id);
    const body = requireJsonBody(req);
    // 校验（名称/字段/大小）由数据层统一抛出 400 AppError；label 可选。
    const item = setUserSecret(user.id, { name: req.params.name, label: body.label, fields: body.fields });
    log.info('用户凭据已保存', { userId: user.id, secretName: item.name, fieldNames: item.fieldNames });
    res.json({ item });
  });

  app.delete('/api/admin/users/:id/secrets/:name', auth.requireAdminWrite, (req, res) => {
    const user = mustGetUserRow(req.params.id);
    if (!deleteUserSecret(user.id, req.params.name)) throw notFound('凭据不存在');
    log.info('用户凭据已删除', { userId: user.id, secretName: req.params.name });
    res.status(204).end();
  });
}
