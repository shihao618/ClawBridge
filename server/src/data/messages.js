/**
 * 管理后台混合消息记录：inbound + outbound 合并分页（每页批量附加 attachments）。
 *
 * 从 store.js 按域拆分（纯搬迁）。
 */
import { all, get } from '../db.js';

import { getAttachmentsByInbound, getAttachmentsByIds } from './attachments.js';
import { DEFAULT_MEDIA_URL_PREFIX, clampInt, toNumber } from './helpers.js';
import { mapAttachmentRow } from './mappers.js';

// ---------------------------------------------------------------------------
// 混合消息记录（管理后台）
// ---------------------------------------------------------------------------

/** 管理后台消息记录：inbound + outbound 合并分页（每条附带 attachments）。 */
export function listMessages({
  direction = 'all',
  status = '',
  userId = '',
  groupId = '',
  limit = 50,
  offset = 0,
  urlPrefix = DEFAULT_MEDIA_URL_PREFIX,
} = {}) {
  const includeInbound = (direction === 'all' || direction === 'inbound') && (!status || status === 'received');
  const includeOutbound = direction === 'all' || direction === 'outbound';

  const parts = [];
  const args = [];
  if (includeInbound) {
    const filters = [];
    const inboundArgs = [];
    if (userId) {
      filters.push('i.user_id = ?');
      inboundArgs.push(String(userId));
    }
    if (groupId) {
      filters.push('EXISTS (SELECT 1 FROM user_groups ug WHERE ug.user_id = i.user_id AND ug.group_id = ?)');
      inboundArgs.push(String(groupId));
    }
    const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    parts.push(
      `SELECT 'inbound' AS direction, i.id AS id, i.user_id AS user_id, i.text AS text, 'received' AS status,
              '' AS error, 0 AS attempts, i.wechat_message_id AS server_message_id, i.created_at AS created_at,
              NULL AS media_id, '' AS source
       FROM inbound_messages i ${whereSql}`,
    );
    args.push(...inboundArgs);
  }
  if (includeOutbound) {
    const filters = [];
    const outboundArgs = [];
    if (userId) {
      filters.push('o.user_id = ?');
      outboundArgs.push(String(userId));
    }
    if (groupId) {
      filters.push('EXISTS (SELECT 1 FROM user_groups ug WHERE ug.user_id = o.user_id AND ug.group_id = ?)');
      outboundArgs.push(String(groupId));
    }
    if (status) {
      filters.push('o.status = ?');
      outboundArgs.push(String(status));
    }
    const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    parts.push(
      `SELECT 'outbound' AS direction, o.id AS id, o.user_id AS user_id, o.text AS text, o.status AS status,
              o.error AS error, o.attempts AS attempts, o.server_message_id AS server_message_id, o.created_at AS created_at,
              o.media_id AS media_id, o.source AS source
       FROM outbox o ${whereSql}`,
    );
    args.push(...outboundArgs);
  }
  if (parts.length === 0) return { total: 0, items: [] };

  const fromSql = `FROM (${parts.join(' UNION ALL ')}) m LEFT JOIN users u ON u.id = m.user_id`;
  const total = toNumber(get(`SELECT COUNT(*) AS c ${fromSql}`, ...args).c);
  const rows = all(
    `SELECT m.*, u.display_name AS display_name ${fromSql}
     ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    ...args,
    clampInt(limit, { min: 1, max: 500, fallback: 50 }),
    clampInt(offset, { min: 0, max: 10_000_000, fallback: 0 }),
  );
  const items = rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    userId: row.user_id ?? '',
    displayName: row.display_name ?? '',
    text: row.text ?? '',
    status: row.status,
    error: row.error ?? '',
    attempts: toNumber(row.attempts),
    serverMessageId: row.server_message_id ?? null,
    createdAt: toNumber(row.created_at),
    source: row.source ?? '',
  }));
  // 批量附加 attachments：入站按 inbound_messages.id、出站按 outbox.media_id
  const inboundRows = rows.filter((row) => row.direction === 'inbound');
  const outboundRows = rows.filter((row) => row.direction === 'outbound');
  const inboundAttachments = getAttachmentsByInbound(inboundRows.map((row) => row.id));
  const outboundAttachmentsById = getAttachmentsByIds(outboundRows.map((row) => row.media_id).filter(Boolean));
  rows.forEach((row, index) => {
    const attachment = row.direction === 'outbound' && row.media_id ? outboundAttachmentsById.get(row.media_id) : null;
    const list = row.direction === 'inbound' ? inboundAttachments.get(row.id) ?? [] : attachment ? [attachment] : [];
    items[index].attachments = list.map((attachmentRow) => mapAttachmentRow(attachmentRow, { urlPrefix }));
  });
  return { total, items };
}
