/**
 * inbound_messages 域：入站保存/列表、游标分页与对外查询（docs/GROUPS_AND_INBOUND.md §4.3）。
 *
 * 从 store.js 按域拆分（纯搬迁）。
 */
import { all, get, nowMs, run } from '../db.js';

import { getAttachmentsByInbound } from './attachments.js';
import { getGroupsForUsers } from './groups.js';
import { DEFAULT_MEDIA_URL_PREFIX, clampInt, newInboundId, toNumber } from './helpers.js';
import { mapAttachmentRow, mapInboundRow } from './mappers.js';

// ---------------------------------------------------------------------------
// inbound_messages
// ---------------------------------------------------------------------------

/**
 * 保存入站消息（按 wechat_message_id 唯一索引去重）。
 * @returns {{inserted: boolean, id: string}}
 */
export function saveInbound({
  userId = null,
  wechatMessageId = '',
  fromUserId = '',
  text = '',
  itemTypes = '',
  rawJson = '',
  createdAt = nowMs(),
  receivedAt = nowMs(),
}) {
  const id = newInboundId();
  const messageId = wechatMessageId === null || wechatMessageId === undefined ? '' : String(wechatMessageId);
  const result = run(
    `INSERT OR IGNORE INTO inbound_messages
       (id, user_id, wechat_message_id, from_user_id, text, item_types, raw_json, created_at, received_at)
     VALUES (?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, ?)`,
    id,
    userId ? String(userId) : null,
    messageId,
    String(fromUserId ?? ''),
    String(text ?? ''),
    String(itemTypes ?? ''),
    String(rawJson ?? '').slice(0, 8192),
    toNumber(createdAt, receivedAt),
    toNumber(receivedAt),
  );
  return { inserted: Number(result.changes) > 0, id };
}

/** 入站消息列表。 */
export function listInbound({ userId = '', limit = 50, offset = 0 } = {}) {
  const filters = [];
  const args = [];
  if (userId) {
    filters.push('i.user_id = ?');
    args.push(String(userId));
  }
  const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const total = toNumber(get(`SELECT COUNT(*) AS c FROM inbound_messages i ${whereSql}`, ...args).c);
  const rows = all(
    `SELECT i.*, u.display_name AS display_name
     FROM inbound_messages i LEFT JOIN users u ON u.id = i.user_id
     ${whereSql}
     ORDER BY i.created_at DESC, i.rowid DESC LIMIT ? OFFSET ?`,
    ...args,
    clampInt(limit, { min: 1, max: 500, fallback: 50 }),
    clampInt(offset, { min: 0, max: 10_000_000, fallback: 0 }),
  );
  return { total, items: rows.map(mapInboundRow) };
}

/** 用户最近入站消息（管理后台详情用，附带 attachments）。 */
export function getRecentInbound(userId, limit = 20, { urlPrefix = DEFAULT_MEDIA_URL_PREFIX } = {}) {
  const rows = all(
    `SELECT i.*, u.display_name AS display_name
     FROM inbound_messages i LEFT JOIN users u ON u.id = i.user_id
     WHERE i.user_id = ? ORDER BY i.created_at DESC, i.rowid DESC LIMIT ?`,
    String(userId),
    clampInt(limit, { min: 1, max: 100, fallback: 20 }),
  );
  const items = rows.map(mapInboundRow);
  attachAttachmentsToInboundItems(rows, items, { urlPrefix });
  return items;
}

/** 给入站消息视图批量附加 attachments（避免 N+1 查询）。 */
function attachAttachmentsToInboundItems(rows, items, { urlPrefix = DEFAULT_MEDIA_URL_PREFIX } = {}) {
  const attachmentMap = getAttachmentsByInbound(rows.map((row) => row.id));
  rows.forEach((row, index) => {
    const list = attachmentMap.get(row.id) ?? [];
    items[index].attachments = list.map((attachment) => mapAttachmentRow(attachment, { urlPrefix }));
  });
  return items;
}

// ---------------------------------------------------------------------------
// 入站消息对外 API（docs/GROUPS_AND_INBOUND.md §4.3）
// ---------------------------------------------------------------------------

/** 编码入站消息游标：base64url(JSON {"t":receivedAt,"id":"in_…"})。 */
export function encodeInboundCursor({ receivedAt, id }) {
  return Buffer.from(JSON.stringify({ t: toNumber(receivedAt), id: String(id) }), 'utf8').toString('base64url');
}

/** 解码入站消息游标；格式非法抛错（API 层转为 400）。 */
export function decodeInboundCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.trim() === '') throw new Error('cursor 不能为空');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('cursor 格式非法');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Number.isFinite(Number(parsed.t)) ||
    typeof parsed.id !== 'string' ||
    parsed.id === ''
  ) {
    throw new Error('cursor 格式非法');
  }
  return { receivedAt: Number(parsed.t), id: parsed.id };
}

/**
 * 入站消息对外查询（ASC by received_at,id；cursor 优先于 since；支持 userId/groupId）。
 * @returns {{items: object[], hasMore: boolean, nextCursor: string|null}}
 */
export function listInboundForApi({ limit = 50, since = 0, cursor = null, userId = '', groupId = '', urlPrefix = '/api/v1/media' } = {}) {
  const filters = [];
  const args = [];
  if (cursor) {
    filters.push('(i.received_at > ? OR (i.received_at = ? AND i.id > ?))');
    args.push(Number(cursor.receivedAt), Number(cursor.receivedAt), String(cursor.id));
  } else if (Number(since) > 0) {
    filters.push('i.received_at > ?');
    args.push(Number(since));
  }
  if (userId) {
    filters.push('i.user_id = ?');
    args.push(String(userId));
  }
  if (groupId) {
    filters.push('EXISTS (SELECT 1 FROM user_groups ug WHERE ug.user_id = i.user_id AND ug.group_id = ?)');
    args.push(String(groupId));
  }
  const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const pageSize = clampInt(limit, { min: 1, max: 200, fallback: 50 });
  const rows = all(
    `SELECT i.*, u.display_name AS display_name
     FROM inbound_messages i LEFT JOIN users u ON u.id = i.user_id
     ${whereSql}
     ORDER BY i.received_at ASC, i.id ASC
     LIMIT ?`,
    ...args,
    pageSize + 1,
  );
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const attachmentsMap = getAttachmentsByInbound(page.map((row) => row.id));
  const groupsMap = getGroupsForUsers(page.map((row) => row.user_id).filter(Boolean));
  const items = page.map((row) => ({
    id: row.id,
    userId: row.user_id ?? '',
    displayName: row.display_name ?? '',
    groups: groupsMap.get(row.user_id) ?? [],
    text: row.text ?? '',
    itemTypes: row.item_types ?? '',
    createdAt: toNumber(row.created_at),
    receivedAt: toNumber(row.received_at),
    attachments: (attachmentsMap.get(row.id) ?? []).map((attachment) => mapAttachmentRow(attachment, { urlPrefix })),
  }));
  const last = page[page.length - 1];
  return {
    items,
    hasMore,
    nextCursor: last ? encodeInboundCursor({ receivedAt: last.received_at, id: last.id }) : null,
  };
}
