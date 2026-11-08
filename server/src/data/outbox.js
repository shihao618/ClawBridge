/**
 * outbox 域：入队、发送状态机、限流/退避辅助与出站列表视图。
 *
 * 从 store.js 按域拆分（纯搬迁）。
 */
import { all, get, nowMs, run, transaction } from '../db.js';

import { getAttachment, getAttachmentsByIds, linkAttachmentOutbox } from './attachments.js';
import { DEFAULT_MEDIA_URL_PREFIX, clampInt, newOutboxId, toNumber } from './helpers.js';
import { mapAttachmentRow, mapOutboxRow } from './mappers.js';

// ---------------------------------------------------------------------------
// outbox
// ---------------------------------------------------------------------------

/** 单条入队（text 与 mediaId 至少一个；mediaId 关联出站附件并回填 attachments.outbox_id）。 */
export function enqueueMessage({ userId, text, source = 'api', nextAttemptAt = 0, mediaId = null }) {
  if (!userId) throw new Error('enqueueMessage: userId 不能为空');
  if (text !== undefined && text !== null && typeof text !== 'string') {
    throw new Error('enqueueMessage: text 必须是字符串');
  }
  if (typeof text !== 'string' && !mediaId) throw new Error('enqueueMessage: text 与 mediaId 至少提供一个');
  const now = nowMs();
  const id = newOutboxId();
  const body = typeof text === 'string' ? text : '';
  const media = mediaId ? String(mediaId) : null;
  return transaction(() => {
    run(
      `INSERT INTO outbox (id, user_id, text, source, status, attempts, next_attempt_at, error, media_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 0, ?, '', ?, ?, ?)`,
      id,
      String(userId),
      body,
      source,
      toNumber(nextAttemptAt),
      media,
      now,
      now,
    );
    if (media) linkAttachmentOutbox(media, id, now);
    return mapOutboxRow(get('SELECT * FROM outbox WHERE id = ?', id));
  });
}

/** 批量入队（单事务，保证原子性）。 */
export function enqueueMany(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  return transaction(() => entries.map((entry) => enqueueMessage(entry)));
}

/** 取最早的可投递记录（queued 且 next_attempt_at <= now）。 */
export function getNextQueuedCandidate(now = nowMs()) {
  return get(
    "SELECT * FROM outbox WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC, created_at ASC, rowid ASC LIMIT 1",
    now,
  );
}

/** queued → sending（带状态守卫，返回是否抢占成功）。 */
export function markOutboxSending(id, ts = nowMs()) {
  const result = run("UPDATE outbox SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'queued'", ts, String(id));
  return Number(result.changes) > 0;
}

/** 发送成功（attempts 语义：实际发送尝试次数，首次成功即为 1）。 */
export function markOutboxSent(id, { serverMessageId = null, clientId = null, ts = nowMs() } = {}) {
  const result = run(
    "UPDATE outbox SET status = 'sent', attempts = attempts + 1, server_message_id = ?, client_id = COALESCE(?, client_id), error = '', sent_at = ?, updated_at = ? WHERE id = ?",
    serverMessageId === null || serverMessageId === undefined ? null : String(serverMessageId),
    clientId,
    ts,
    ts,
    String(id),
  );
  return Number(result.changes) > 0;
}

/** 发送失败（终态）；incrementAttempts=false 用于真正的发送尝试之前的预检查失败。 */
export function markOutboxFailed(id, { error = '', ts = nowMs(), incrementAttempts = true } = {}) {
  const attemptsSql = incrementAttempts ? 'attempts = attempts + 1, ' : '';
  const result = run(
    `UPDATE outbox SET status = 'failed', ${attemptsSql}error = ?, updated_at = ? WHERE id = ?`,
    String(error ?? '').slice(0, 1000),
    ts,
    String(id),
  );
  return Number(result.changes) > 0;
}

/** 退避重试：回到 queued，attempts+1，next_attempt_at 延后。 */
export function rescheduleOutbox(id, { nextAttemptAt = 0, error = '', ts = nowMs() } = {}) {
  const result = run(
    "UPDATE outbox SET status = 'queued', attempts = attempts + 1, next_attempt_at = ?, error = ?, updated_at = ? WHERE id = ?",
    toNumber(nextAttemptAt),
    String(error ?? '').slice(0, 1000),
    ts,
    String(id),
  );
  return Number(result.changes) > 0;
}

/** 把某账号所有 queued 消息的 next_attempt_at 推到指定时间之后（限流时用）。 */
export function deferUserQueued(userId, nextAttemptAt, ts = nowMs()) {
  const at = toNumber(nextAttemptAt);
  const result = run(
    "UPDATE outbox SET next_attempt_at = ?, updated_at = ? WHERE user_id = ? AND status = 'queued' AND next_attempt_at < ?",
    at,
    ts,
    String(userId),
    at,
  );
  return Number(result.changes);
}

/**
 * 单条 outbox 推迟（发送限流无配额时）：保持 queued、不增加 attempts、不标记失败。
 * 用于已置 sending 但尚未真正调用的场景（如 caption 已发、媒体需等待令牌）。
 */
export function deferOutbox(id, nextAttemptAt, ts = nowMs()) {
  const at = toNumber(nextAttemptAt);
  const result = run(
    "UPDATE outbox SET status = 'queued', next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'",
    at,
    toNumber(ts),
    String(id),
  );
  return Number(result.changes) > 0;
}

/**
 * 把某账号所有 queued 消息标记失败（-14 token 失效 / 解绑时）。
 * 这些消息尚未真正发送，因此不增加 attempts。
 */
export function failUserQueued(userId, error = '', ts = nowMs()) {
  const result = run(
    "UPDATE outbox SET status = 'failed', error = ?, updated_at = ? WHERE user_id = ? AND status = 'queued'",
    String(error ?? '').slice(0, 1000),
    ts,
    String(userId),
  );
  return Number(result.changes);
}

/** 进程启动时把残留的 sending 重置为 queued（docs/ARCHITECTURE.md §5）。 */
export function resetSendingToQueued(ts = nowMs()) {
  const result = run(
    "UPDATE outbox SET status = 'queued', next_attempt_at = 0, error = '进程重启，重新入队', updated_at = ? WHERE status = 'sending'",
    ts,
  );
  return Number(result.changes);
}

/** 记录 caption（媒体消息前的文本）已发送，避免重试时重复发送。 */
export function markCaptionSent(outboxId, ts = nowMs()) {
  const result = run('UPDATE outbox SET caption_sent_at = ?, updated_at = ? WHERE id = ?', toNumber(ts), toNumber(ts), String(outboxId));
  return Number(result.changes) > 0;
}

/**
 * 单条 outbox 对外视图（附带 attachments）。
 * 出站附件优先按 outbox.media_id 关联（同一附件可发给多个收件人）。
 * @param {string} id
 * @param {{urlPrefix?: string}} [options]
 */
export function getOutbox(id, { urlPrefix = DEFAULT_MEDIA_URL_PREFIX } = {}) {
  const row = get('SELECT * FROM outbox WHERE id = ?', String(id ?? ''));
  if (!row) return null;
  const view = mapOutboxRow(row);
  let attachmentRows = [];
  if (row.media_id) {
    const attachment = getAttachment(row.media_id);
    if (attachment) attachmentRows = [attachment];
  } else {
    attachmentRows = all('SELECT * FROM attachments WHERE outbox_id = ? ORDER BY created_at ASC, rowid ASC', String(row.id));
  }
  view.attachments = attachmentRows.map((attachment) => mapAttachmentRow(attachment, { urlPrefix }));
  return view;
}

/** 某用户 outbox 列表（对外视图，附带 attachments）。 */
export function listOutbox({ userId = '', limit = 50, offset = 0, urlPrefix = DEFAULT_MEDIA_URL_PREFIX } = {}) {
  const filters = [];
  const args = [];
  if (userId) {
    filters.push('user_id = ?');
    args.push(String(userId));
  }
  const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const total = toNumber(get(`SELECT COUNT(*) AS c FROM outbox ${whereSql}`, ...args).c);
  const rows = all(
    `SELECT * FROM outbox ${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    ...args,
    clampInt(limit, { min: 1, max: 500, fallback: 50 }),
    clampInt(offset, { min: 0, max: 10_000_000, fallback: 0 }),
  );
  return { total, items: attachToOutboxRows(rows, { urlPrefix }) };
}

/** 用户最近出站消息（管理后台详情用，附带 attachments）。 */
export function getRecentOutbound(userId, limit = 20, { urlPrefix = DEFAULT_MEDIA_URL_PREFIX } = {}) {
  const rows = all(
    'SELECT * FROM outbox WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    String(userId),
    clampInt(limit, { min: 1, max: 100, fallback: 20 }),
  );
  return attachToOutboxRows(rows, { urlPrefix });
}

/** 给 outbox 行映射视图并批量附加 attachments（仅按 outbox.media_id 关联）。 */
function attachToOutboxRows(rows, { urlPrefix = DEFAULT_MEDIA_URL_PREFIX } = {}) {
  const mediaIds = rows.map((row) => row.media_id).filter(Boolean);
  const byId = getAttachmentsByIds(mediaIds);
  return rows.map((row) => {
    const view = mapOutboxRow(row);
    const attachment = row.media_id ? byId.get(row.media_id) : null;
    view.attachments = attachment ? [mapAttachmentRow(attachment, { urlPrefix })] : [];
    return view;
  });
}
