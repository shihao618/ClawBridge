/**
 * 管理后台：用户分组 CRUD / 分组群发 / 分组保活开关（docs/GROUPS_AND_INBOUND.md §3）。
 */
import * as auth from '../auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { logger } from '../logger.js';
import { MEDIA_ADMIN_PREFIX, requireJsonBody } from '../http/helpers.js';
import { queueGroupMessage } from '../http/queue-service.js';
import {
  isUniqueConstraintError,
  parseGroupColor,
  parseGroupDescription,
  parseGroupName,
} from '../http/validators.js';
import * as store from '../store.js';

const log = logger.child({ mod: 'api' });

export function registerAdminGroupsRoutes(app) {
  app.get('/api/admin/groups', auth.requireAdmin, (req, res) => {
    res.json({ items: store.listGroups() });
  });

  app.post('/api/admin/groups', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    const name = parseGroupName(body.name);
    const description = parseGroupDescription(body.description);
    const color = parseGroupColor(body.color);
    if (body.keepaliveEnabled !== undefined && typeof body.keepaliveEnabled !== 'boolean') {
      throw badRequest('keepaliveEnabled 必须是 boolean');
    }
    const keepaliveEnabled = body.keepaliveEnabled === true;
    if (store.findGroupByName(name)) throw conflict('分组名称已存在');
    let group;
    try {
      group = store.createGroup({ name, description, color, keepaliveEnabled });
    } catch (err) {
      // 并发同名：唯一索引兜底，统一映射 409（不是 500）
      if (isUniqueConstraintError(err)) throw conflict('分组名称已存在');
      throw err;
    }
    log.info('分组已创建', { groupId: group.id, name: group.name, keepaliveEnabled: group.keepaliveEnabled });
    res.status(201).json({ group });
  });

  app.patch('/api/admin/groups/:id', auth.requireAdminWrite, (req, res) => {
    const existing = store.getGroupRow(req.params.id);
    if (!existing) throw notFound('分组不存在');
    const body = requireJsonBody(req);
    const updates = {};
    if (body.name !== undefined) updates.name = parseGroupName(body.name);
    if (body.description !== undefined) updates.description = parseGroupDescription(body.description);
    if (body.color !== undefined) updates.color = parseGroupColor(body.color);
    if (body.keepaliveEnabled !== undefined) {
      if (typeof body.keepaliveEnabled !== 'boolean') throw badRequest('keepaliveEnabled 必须是 boolean');
      updates.keepaliveEnabled = body.keepaliveEnabled;
    }
    if (Object.keys(updates).length === 0) {
      throw badRequest('至少提供一个可更新字段（name/description/color/keepaliveEnabled）');
    }
    if (updates.name !== undefined && store.findGroupByName(updates.name, { excludeId: existing.id })) {
      throw conflict('分组名称已存在');
    }
    let group;
    try {
      group = store.updateGroup(existing.id, updates);
      // 与批量保活接口语义一致：分组级 keepaliveEnabled 变更时同步当前成员
      if (updates.keepaliveEnabled !== undefined) {
        store.setGroupKeepaliveEnabled(existing.id, updates.keepaliveEnabled);
        group = store.getGroup(existing.id);
      }
    } catch (err) {
      // 并发改名同名：唯一索引兜底，统一映射 409（不是 500）
      if (isUniqueConstraintError(err)) throw conflict('分组名称已存在');
      throw err;
    }
    res.json({ group });
  });

  app.delete('/api/admin/groups/:id', auth.requireAdminWrite, (req, res) => {
    if (!store.deleteGroup(req.params.id)) throw notFound('分组不存在');
    log.info('分组已删除', { groupId: req.params.id });
    res.status(204).end();
  });

  app.post('/api/admin/groups/:id/messages', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    const result = queueGroupMessage(req.params.id, body, MEDIA_ADMIN_PREFIX);
    res.status(202).json(result);
  });

  app.post('/api/admin/groups/:id/keepalive', auth.requireAdminWrite, (req, res) => {
    const group = store.getGroup(req.params.id);
    if (!group) throw notFound('分组不存在');
    const body = requireJsonBody(req);
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled 必须是 boolean');
    const updated = store.setGroupKeepaliveEnabled(group.id, body.enabled);
    log.info('分组保活开关已更新', { groupId: group.id, enabled: body.enabled, updated });
    res.json({ updated, group: store.getGroup(group.id) });
  });
}
