/**
 * attachments 域：附件行 CRUD 与批量查询（原始行；对外视图在 mappers.js）。
 *
 * 从 store.js 按域拆分（纯搬迁）；归属语义见 注释。
 */
import { all, get, nowMs, run } from '../db.js';

import { newAttachmentId, toNumber } from './helpers.js';

// ---------------------------------------------------------------------------
// attachments（schema v2：多媒体附件，docs/MEDIA.md §4.1）
// ---------------------------------------------------------------------------

/** 原始附件行（含内部 path 字段，仅供服务端模块使用）。 */
export function getAttachment(id) {
  return get('SELECT * FROM attachments WHERE id = ?', String(id ?? ''));
}

/** outbox 关联的出站附件原始行（一条 outbox 最多一个附件）。 */
export function getAttachmentByOutbox(outboxId) {
  return get('SELECT * FROM attachments WHERE outbox_id = ? ORDER BY created_at ASC LIMIT 1', String(outboxId ?? ''));
}

/** 批量读取入站消息的附件原始行：Map<inbound_message_id, row[]>。 */
export function getAttachmentsByInbound(inboundIds) {
  const ids = [...new Set((inboundIds ?? []).map((id) => String(id)))].filter(Boolean);
  const result = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = all(
    `SELECT * FROM attachments WHERE inbound_message_id IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`,
    ...ids,
  );
  for (const row of rows) {
    const list = result.get(row.inbound_message_id);
    if (list) list.push(row);
  }
  return result;
}

/** 按 id 批量读取附件原始行：Map<id, row>（出站视图用 media_id 关联，支持同一附件发给多个用户）。 */
export function getAttachmentsByIds(attachmentIds) {
  const ids = [...new Set((attachmentIds ?? []).map((id) => String(id)))].filter(Boolean);
  const result = new Map();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(', ');
  for (const row of all(`SELECT * FROM attachments WHERE id IN (${placeholders})`, ...ids)) {
    result.set(row.id, row);
  }
  return result;
}

/**
 * 创建附件行（入站下载完成 / 出站上传保存后调用）。
 * @returns {object|null} 原始附件行
 */
export function createAttachment({
  id = newAttachmentId(),
  direction,
  kind,
  mime = 'application/octet-stream',
  fileName = '',
  size = 0,
  path: filePath = '',
  sha256 = '',
  userId = null,
  outboxId = null,
  inboundMessageId = null,
  wechatMessageId = null,
  error = '',
  status = 'ready',
  createdAt = nowMs(),
} = {}) {
  if (!direction) throw new Error('createAttachment: direction 不能为空');
  if (!kind) throw new Error('createAttachment: kind 不能为空');
  if (status !== 'failed' && !filePath) throw new Error('createAttachment: path 不能为空');
  run(
    `INSERT INTO attachments
       (id, direction, kind, mime, file_name, size, path, sha256, user_id, outbox_id,
        inbound_message_id, wechat_message_id, error, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    String(id),
    String(direction),
    String(kind),
    String(mime || 'application/octet-stream'),
    String(fileName ?? ''),
    toNumber(size),
    String(filePath),
    String(sha256 ?? ''),
    userId ? String(userId) : null,
    outboxId ? String(outboxId) : null,
    inboundMessageId ? String(inboundMessageId) : null,
    wechatMessageId === null || wechatMessageId === undefined ? null : String(wechatMessageId),
    String(error ?? '').slice(0, 1000),
    status === 'failed' ? 'failed' : 'ready',
    toNumber(createdAt),
  );
  return getAttachment(id);
}

/**
 * 关联附件到 outbox（入队时回填 attachments.outbox_id）。
 *
 * 归属语义：
 * - attachments.user_id 只表示「上传者/入站归属」（管理端上传为 NULL），入队不得覆盖；
 * - 同一附件可被多条 outbox 共享（分组群发/多目标），outbox_id 仅记录首次入队引用（NULL→首个 outbox），
 *   投递与视图一律以 outbox.media_id 为准，不做反复覆盖。
 */
export function linkAttachmentOutbox(attachmentId, outboxId) {
  const result = run(
    'UPDATE attachments SET outbox_id = COALESCE(outbox_id, ?) WHERE id = ?',
    String(outboxId),
    String(attachmentId),
  );
  return Number(result.changes) > 0;
}

/** 附件关联到入站消息（monitor 下载成功后回填）。 */
export function linkAttachmentInbound(attachmentId, inboundMessageId) {
  const result = run(
    'UPDATE attachments SET inbound_message_id = ? WHERE id = ?',
    inboundMessageId ? String(inboundMessageId) : null,
    String(attachmentId),
  );
  return Number(result.changes) > 0;
}
