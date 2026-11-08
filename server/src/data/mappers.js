/**
 * 纯行 → 视图映射（无 DB 查询；分组/规则/任务等需要 DB 的映射放在各自域模块）。
 *
 * 从 store.js 按域拆分（纯搬迁）。
 */
import { nowMs } from '../db.js';

import { DEFAULT_MEDIA_URL_PREFIX, toNumber } from './helpers.js';

/**
 * 用户对外视图（不含任何凭证）。
 * status 派生规则：DB status='active' 且 pause_until 未过 → 'paused'（-14 冷却中）。
 */
export function mapUserRow(row, { now = nowMs() } = {}) {
  if (!row) return null;
  const paused = row.status === 'active' && toNumber(row.pause_until) > now;
  return {
    id: row.id,
    displayName: row.display_name ?? '',
    wechatUserId: row.wechat_user_id ?? '',
    ilinkBotId: row.ilink_bot_id ?? '',
    status: paused ? 'paused' : row.status,
    boundAt: toNumber(row.bound_at),
    updatedAt: toNumber(row.updated_at),
    lastInboundAt: toNumber(row.last_inbound_at),
    lastOutboundAt: toNumber(row.last_outbound_at),
    hasContextToken: Boolean(row.context_token_enc),
    queuedCount: toNumber(row.queued_count),
    sentCount: toNumber(row.sent_count),
    failedCount: toNumber(row.failed_count),
    pauseUntil: toNumber(row.pause_until),
    note: row.note ?? '',
    // 24h 会话保活（schema v4）
    keepaliveEnabled: Boolean(row.keepalive_enabled),
    keepaliveLastSentAt: toNumber(row.keepalive_last_sent_at),
    // 所属分组（schema v3）；由 attachGroupsToUserViews() 批量填充，未填充时为空数组
    groups: [],
  };
}

/** 分组对外视图（GroupView：含 userCount / activeUserCount / keepaliveEnabled）。 */
export function mapGroupRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name ?? '',
    description: row.description ?? '',
    color: row.color ?? '',
    // 分组级保活开关（schema v6）：开启后新加入成员自动开启保活
    keepaliveEnabled: Boolean(row.keepalive_enabled),
    userCount: toNumber(row.user_count),
    activeUserCount: toNumber(row.active_user_count),
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  };
}

/** 附件对外视图（不暴露内部 path；url/downloadUrl 指向媒体读取接口）。 */
export function mapAttachmentRow(row, { urlPrefix = DEFAULT_MEDIA_URL_PREFIX } = {}) {
  if (!row) return null;
  const mediaUrl = `${urlPrefix}/${encodeURIComponent(row.id)}`;
  return {
    id: row.id,
    direction: row.direction,
    kind: row.kind,
    mime: row.mime ?? 'application/octet-stream',
    fileName: row.file_name ?? '',
    size: toNumber(row.size),
    url: mediaUrl,
    downloadUrl: `${mediaUrl}?download=1`,
    status: row.status ?? 'ready',
    ...(row.error ? { error: row.error } : {}),
  };
}

/** outbox 对外视图。 */
export function mapOutboxRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    text: row.text,
    source: row.source,
    status: row.status,
    attempts: toNumber(row.attempts),
    nextAttemptAt: toNumber(row.next_attempt_at),
    error: row.error ?? '',
    serverMessageId: row.server_message_id ?? null,
    clientId: row.client_id ?? null,
    mediaId: row.media_id ?? null,
    captionSentAt: toNumber(row.caption_sent_at),
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
    sentAt: toNumber(row.sent_at),
  };
}

/** 入队响应项（docs/API.md 的 { outboxId, userId, status }）。 */
export function toQueuedItem(row) {
  return { outboxId: row.id, userId: row.userId ?? row.user_id ?? '', status: row.status };
}

/** 入站消息对外视图（管理后台消息记录/用户详情）。 */
export function mapInboundRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    direction: 'inbound',
    userId: row.user_id ?? '',
    displayName: row.display_name ?? '',
    text: row.text ?? '',
    status: 'received',
    error: '',
    attempts: 0,
    // 入站消息的“服务端消息 ID”即微信 message_id（无损保存为字符串，便于观测 >2^53 精度）
    serverMessageId: row.wechat_message_id === null || row.wechat_message_id === undefined ? null : String(row.wechat_message_id),
    createdAt: toNumber(row.created_at),
  };
}
