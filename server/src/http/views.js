/**
 * HTTP 视图映射与用户领域小函数（admin / v1 契约共用）。
 *
 * 从 api.js 等价迁出（纯搬迁，行为不变）。
 */
import { conflict, notFound } from '../errors.js';
import * as store from '../store.js';

import { MEDIA_ADMIN_PREFIX } from './helpers.js';

/** 用户对外视图转为管理后台列表字段（与 store.mapUserRow 一致，避免泄露额外字段）。 */
export function userView(user) {
  return {
    id: user.id,
    displayName: user.displayName,
    wechatUserId: user.wechatUserId,
    ilinkBotId: user.ilinkBotId,
    status: user.status,
    boundAt: user.boundAt,
    updatedAt: user.updatedAt,
    lastInboundAt: user.lastInboundAt,
    lastOutboundAt: user.lastOutboundAt,
    hasContextToken: user.hasContextToken,
    contextTokenStale: Boolean(user.contextTokenStale),
    pushable: user.pushable !== false && Boolean(user.hasContextToken) && !user.contextTokenStale,
    lastError: user.lastError ?? '',
    queuedCount: user.queuedCount,
    sentCount: user.sentCount,
    failedCount: user.failedCount,
    pauseUntil: user.pauseUntil,
    note: user.note,
    groups: Array.isArray(user.groups) ? user.groups : [],
    keepaliveEnabled: Boolean(user.keepaliveEnabled),
    keepaliveLastSentAt: user.keepaliveLastSentAt ?? 0,
  };
}

/** 入队响应项（admin 与 v1 契约一致：{ outboxId, userId, status }；有媒体时附 media 摘要）。 */
export function queuedItem(row, { attachment = null, urlPrefix = MEDIA_ADMIN_PREFIX } = {}) {
  const item = { outboxId: row.id, userId: row.userId ?? row.user_id ?? '', status: row.status };
  if (attachment) item.media = mediaQueuedView(attachment, urlPrefix);
  return item;
}

/** 上传响应中的 media 视图（docs/MEDIA.md §5.1）。 */
export function mediaUploadView(attachment, urlPrefix = MEDIA_ADMIN_PREFIX) {
  const view = store.mapAttachmentRow(attachment, { urlPrefix });
  return {
    id: view.id,
    kind: view.kind,
    mime: view.mime,
    fileName: view.fileName,
    size: view.size,
    url: view.url,
    downloadUrl: view.downloadUrl,
    status: view.status,
  };
}

/** queued 项中的 media 摘要（docs/MEDIA.md §5.2）。 */
export function mediaQueuedView(attachment, urlPrefix = MEDIA_ADMIN_PREFIX) {
  const view = store.mapAttachmentRow(attachment, { urlPrefix });
  return { id: view.id, kind: view.kind, fileName: view.fileName, size: view.size, url: view.url };
}

/** 取要求存在的用户（原始行，含 pause_until/status）。 */
export function mustGetUserRow(id) {
  const row = store.getUserRow(id);
  if (!row) throw notFound('用户不存在');
  return row;
}

/** 用户是否可接收消息（已绑定且不在 -14 冷却）。 */
export function ensureSendableUser(row) {
  if (row.status !== 'active') throw conflict('用户未绑定或已解绑，无法发送消息');
  if (Number(row.pause_until) > Date.now()) {
    throw conflict('账号冷却中（bot token 已失效，需用户重新扫码绑定），暂时无法发送消息');
  }
}

/** v1 分组列表项（docs/GROUPS_AND_INBOUND.md §4.1）。 */
export function v1GroupView(group) {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    color: group.color,
    keepaliveEnabled: group.keepaliveEnabled === true,
    userCount: group.userCount,
    activeUserCount: group.activeUserCount,
  };
}
