/**
 * 跨路由复用的入队与 Webhook 请求解析逻辑。
 *
 * 从 api.js 等价迁出（纯搬迁，行为不变）。
 */
import { badRequest, notFound } from '../errors.js';
import { logger } from '../logger.js';
import * as store from '../store.js';

import { parseOptionalText } from './helpers.js';
import { resolveOutboundAttachment } from './media-handlers.js';
import { queuedItem } from './views.js';

const log = logger.child({ mod: 'api' });

/** 分组群发公共处理（管理端/ v1 共用）：校验分组+文本/媒体，给目标 active 未冷却用户入队。 */
export function queueGroupMessage(groupId, body, urlPrefix, { source = 'group' } = {}) {
  const group = store.getGroup(groupId);
  if (!group) throw notFound('分组不存在');
  const text = parseOptionalText(body.text);
  const attachment = resolveOutboundAttachment(body.mediaId);
  if (text === '' && !attachment) throw badRequest('text 与 mediaId 至少提供一个');
  const targets = store.getGroupMembers(group.id, { activeOnly: true });
  const queued = store.enqueueMany(
    targets.map((user) => ({ userId: user.id, text, source, mediaId: attachment?.id ?? null })),
  );
  log.info('分组消息已入队', { groupId: group.id, count: queued.length, source });
  return {
    count: queued.length,
    queued: queued.map((row) => queuedItem(row, { attachment, urlPrefix })),
  };
}

/** Webhook 文本提取：常见 text/content/message/msg，支持嵌套对象；无法识别时回退 JSON 字符串。 */
export function extractWebhookText(req, body) {
  const fromObject = (value) => {
    if (typeof value === 'string') return value.trim() || null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    for (const key of ['text', 'content', 'message', 'msg', 'body', 'title']) {
      const found = fromObject(value[key]);
      if (found) return found;
    }
    return null;
  };
  for (const value of [
    req.query?.text,
    req.query?.content,
    req.query?.message,
    req.query?.msg,
    body.text,
    body.content,
    body.message,
    body.msg,
  ]) {
    const found = fromObject(value);
    if (found) return found;
  }
  if (typeof req.body === 'string' && req.body.trim()) return req.body.trim();
  if (body && Object.keys(body).length > 0) return JSON.stringify(body);
  return '';
}

/** Webhook 目标：优先级 query > body；支持用户 ID、分组 ID、广播。 */
export function extractWebhookTarget(req, body) {
  const query = req.query || {};
  const rawUsers =
    query.to ??
    query.userIds ??
    query.user_id ??
    query.users ??
    body.to ??
    body.userIds ??
    body.user_id ??
    body.users;
  const rawGroup =
    query.groupId ?? query.group_id ?? query.group ?? body.groupId ?? body.group_id ?? body.group;
  const rawBroadcast = query.broadcast ?? body.broadcast;
  const broadcast =
    rawBroadcast === true || ['1', 'true', 'yes', 'on'].includes(String(rawBroadcast ?? '').toLowerCase());
  const groupId = typeof rawGroup === 'string' && rawGroup.trim() !== '' ? rawGroup.trim() : '';
  const userIds = [];
  if (rawUsers !== undefined && rawUsers !== null && rawUsers !== '') {
    const values = Array.isArray(rawUsers) ? rawUsers : [rawUsers];
    for (const item of values) {
      if (Array.isArray(item)) {
        for (const nested of item) {
          if (typeof nested === 'string' && nested.trim()) userIds.push(nested.trim());
        }
      } else if (typeof item === 'string') {
        for (const part of item.split(',')) {
          if (part.trim()) userIds.push(part.trim());
        }
      }
    }
  }
  const modes = [userIds.length > 0, groupId !== '', broadcast].filter(Boolean).length;
  if (modes === 0) {
    throw badRequest('缺少收件目标：请通过 ?to=<userId>、?groupId=<groupId> 或 ?broadcast=1 指定');
  }
  if (modes > 1) throw badRequest('收件目标只能选择一种：用户 / 分组 / 广播');
  return { userIds: [...new Set(userIds)], groupId, broadcast };
}
