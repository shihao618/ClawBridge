/**
 * 管理后台：用户 CRUD / 发消息 / 解绑 / 删除 / 重连 / 保活开关（含用户分组全量替换）。
 */
import fs from 'node:fs';

import * as auth from '../auth.js';
import { AppError, ErrorCodes, badRequest, conflict, notFound } from '../errors.js';
import { logger } from '../logger.js';
import { requireJsonBody, parseLimit, parseOffset, parseOptionalText } from '../http/helpers.js';
import { resolveOutboundAttachment } from '../http/media-handlers.js';
import { ensureSendableUser, mustGetUserRow, queuedItem, userView } from '../http/views.js';
import { USER_STATUSES } from '../http/validators.js';
import * as media from '../media.js';
import * as monitor from '../monitor.js';
import * as store from '../store.js';

const log = logger.child({ mod: 'api' });

export function registerAdminUsersRoutes(app) {
  app.get('/api/admin/users', auth.requireAdmin, (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : 'active';
    if (!USER_STATUSES.has(status)) throw badRequest('status 只能是 active | unbound | paused | all');
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const groupId = typeof req.query.groupId === 'string' ? req.query.groupId.trim() : '';
    const result = store.listUsers({
      status,
      q,
      groupId,
      limit: parseLimit(req.query.limit, 50, 500),
      offset: parseOffset(req.query.offset),
    });
    res.json({ total: result.total, items: result.items.map(userView) });
  });

  app.get('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
    const user = store.getUserWithCounts(req.params.id);
    if (!user) throw notFound('用户不存在');
    res.json({
      user: userView(user),
      recentInbound: store.getRecentInbound(req.params.id, 20),
      recentOutbound: store.getRecentOutbound(req.params.id, 20),
    });
  });

  // 全量替换用户分组（多对多标签，docs/GROUPS_AND_INBOUND.md §3.2）
  app.put('/api/admin/users/:id/groups', auth.requireAdminWrite, (req, res) => {
    const user = mustGetUserRow(req.params.id);
    const body = requireJsonBody(req);
    if (!Array.isArray(body.groupIds)) throw badRequest('groupIds 必须是数组');
    const groupIds = [];
    for (const rawId of body.groupIds) {
      if (typeof rawId !== 'string' || rawId.trim() === '') {
        throw badRequest('groupIds 中的分组 id 必须是非空字符串');
      }
      groupIds.push(rawId.trim());
    }
    const uniqueIds = [...new Set(groupIds)];
    const unknownGroupIds = uniqueIds.filter((groupId) => !store.getGroupRow(groupId));
    if (unknownGroupIds.length > 0) {
      throw new AppError(ErrorCodes.BAD_REQUEST, '存在不存在的分组 id', {
        status: 400,
        details: { unknownGroupIds },
      });
    }
    store.replaceUserGroups(user.id, uniqueIds);
    const updatedUser = store.getUserWithCounts(user.id);
    const inheritedKeepalive = store.userHasKeepaliveGroup(user.id);
    log.info('用户分组已更新', { userId: user.id, groupCount: uniqueIds.length, inheritedKeepalive });
    res.json({ user: userView(updatedUser), inheritedKeepalive });
  });

  app.post('/api/admin/users/:id/messages', auth.requireAdminWrite, (req, res) => {
    const row = mustGetUserRow(req.params.id);
    ensureSendableUser(row);
    const body = requireJsonBody(req);
    const text = parseOptionalText(body.text);
    const attachment = resolveOutboundAttachment(body.mediaId);
    if (text === '' && !attachment) throw badRequest('text 与 mediaId 至少提供一个');
    const queued = store.enqueueMessage({
      userId: row.id,
      text,
      source: 'admin',
      mediaId: attachment?.id ?? null,
    });
    res.status(202).json({ queued: [queuedItem(queued, { attachment })] });
  });

  app.post('/api/admin/users/:id/unbind', auth.requireAdminWrite, async (req, res) => {
    const row = mustGetUserRow(req.params.id);
    // 先停轮询（内部 best-effort notifyStop），再清凭证
    await monitor.stop(row.id, { notify: true, reason: 'admin unbind' });
    store.failUserQueued(row.id, '用户已解绑，消息未发送');
    store.unbindUser(row.id);
    store.addEvent({ type: 'unbind', userId: row.id });
    log.info('用户已解绑', { userId: row.id });
    res.json({ ok: true, message: '已解绑（微信端授权需在手机微信中管理）' });
  });

  // 彻底删除用户及其关联数据（不可恢复）：先停监控，再清理关联表 + 附件文件
  app.delete('/api/admin/users/:id', auth.requireAdminWrite, async (req, res) => {
    const row = mustGetUserRow(req.params.id);
    await monitor.stop(row.id, { notify: false, reason: 'admin delete user' }).catch((err) => {
      log.warn('删除用户时停止监控失败（继续删除）', { userId: row.id, message: err?.message });
    });
    const result = store.deleteUserCascade(row.id);
    if (!result) throw notFound('用户不存在');
    let attachmentsDeleted = 0;
    for (const relativePath of result.attachmentPaths) {
      try {
        fs.rmSync(media.resolveMediaPath(relativePath), { force: true });
        attachmentsDeleted += 1;
      } catch (err) {
        log.warn('删除用户附件文件失败（跳过）', { userId: row.id, path: relativePath, message: err?.message });
      }
    }
    log.info('用户已彻底删除', {
      userId: row.id,
      attachmentsDeleted,
      // 仍被其他收件人未完成 outbox 引用的共享附件会保留（行 + 磁盘文件）
      sharedAttachmentsKept: result.keptAttachments,
      cleared: result.cleared,
      updatedTasks: result.updatedTasks,
      updatedRules: result.updatedRules,
    });
    res.json({
      ok: true,
      deleted: true,
      userId: row.id,
      attachmentsDeleted,
      cleared: result.cleared,
      updatedTasks: result.updatedTasks,
      updatedRules: result.updatedRules,
    });
  });

  app.post('/api/admin/users/:id/reconnect', auth.requireAdminWrite, async (req, res) => {
    const row = mustGetUserRow(req.params.id);
    if (row.status !== 'active') throw conflict('用户未绑定或已解绑，请重新扫码绑定');
    if (Number(row.pause_until) > Date.now()) throw conflict('账号冷却中，请等待冷却结束后重试');
    await monitor.start(row.id);
    res.json({ ok: true, monitorsRunning: monitor.isRunning(row.id) });
  });

  // 用户/分组 24h 会话保活开关（docs/KEEPALIVE.md §4）
  app.patch('/api/admin/users/:id/keepalive', auth.requireAdminWrite, (req, res) => {
    const user = mustGetUserRow(req.params.id);
    const body = requireJsonBody(req);
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled 必须是 boolean');
    store.setKeepaliveEnabled(user.id, body.enabled);
    log.info('用户保活开关已更新', { userId: user.id, enabled: body.enabled });
    res.json({ user: userView(store.getUserWithCounts(user.id)) });
  });
}
