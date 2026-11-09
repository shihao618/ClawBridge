/**
 * users 域：用户行/视图、绑定 upsert、凭证加解密入口、暂停/解绑/删除、列表与广播目标。
 *
 * 从 store.js 按域拆分（纯搬迁）；安全约定见 docs/ARCHITECTURE.md §3/§8。
 */
import { config } from '../config.js';
import { decryptSecretOrNull, encryptSecret } from '../crypto.js';
import { all, get, nowMs, run, transaction } from '../db.js';

import { attachGroupsToUserViews } from './groups.js';
import { clampInt, likePattern, newUserId, toNumber } from './helpers.js';
import { mapUserRow } from './mappers.js';

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

/** 读取用户原始行（含密文字段，仅供内部使用）。 */
export function getUserRow(id) {
  return get('SELECT * FROM users WHERE id = ?', String(id ?? ''));
}

/** context_token 失效（iLink prepare failed）时的用户提示；UI 用它判断“暂不可推送”。 */
export const CONTEXT_TOKEN_STALE_MARKER =
  'context_token 已失效，等待用户先给 bot 发一条消息刷新会话';

/** 标记用户的 context_token 已失效（绑定仍有效，只是需要用户先发消息刷新会话）。 */
export function markContextTokenStale(id, ts = nowMs()) {
  const result = run('UPDATE users SET last_error = ?, updated_at = ? WHERE id = ?', CONTEXT_TOKEN_STALE_MARKER, ts, String(id ?? ''));
  return Number(result.changes) > 0;
}

/** 发送成功/收到新消息刷新 context_token 后，清除“待刷新会话”标记。 */
export function clearContextTokenStale(id, ts = nowMs()) {
  const result = run('UPDATE users SET last_error = \'\', updated_at = ? WHERE id = ? AND last_error = ?', ts, String(id ?? ''), CONTEXT_TOKEN_STALE_MARKER);
  return Number(result.changes) > 0;
}

/** 按微信用户 ID 读取原始行（换绑判定用）。 */
export function getUserRowByWechatId(wechatUserId) {
  return get('SELECT * FROM users WHERE wechat_user_id = ?', String(wechatUserId ?? ''));
}

/** 按 iLink bot 账号 ID 读取原始行（binded_redirect 兜底匹配）。 */
export function getUserRowByBotId(ilinkBotId) {
  return get('SELECT * FROM users WHERE ilink_bot_id = ?', String(ilinkBotId ?? ''));
}

/** 读取用户对外视图（附带 groups）。 */
export function getUser(id, options = {}) {
  const view = mapUserRow(getUserRow(id), options);
  if (!view) return null;
  attachGroupsToUserViews([view]);
  return view;
}

/** 读取用户对外视图（附带 outbox 计数 + groups）。 */
export function getUserWithCounts(id, { now = nowMs() } = {}) {
  const row = get(
    `SELECT u.*,
       (SELECT COUNT(*) FROM outbox o WHERE o.user_id = u.id AND o.status = 'queued') AS queued_count,
       (SELECT COUNT(*) FROM outbox o WHERE o.user_id = u.id AND o.status = 'sent') AS sent_count,
       (SELECT COUNT(*) FROM outbox o WHERE o.user_id = u.id AND o.status = 'failed') AS failed_count,
       (SELECT o.status FROM outbox o WHERE o.user_id = u.id ORDER BY o.updated_at DESC, o.id DESC LIMIT 1) AS last_outbox_status,
       (SELECT o.error FROM outbox o WHERE o.user_id = u.id ORDER BY o.updated_at DESC, o.id DESC LIMIT 1) AS last_outbox_error,
       (SELECT o.updated_at FROM outbox o WHERE o.user_id = u.id ORDER BY o.updated_at DESC, o.id DESC LIMIT 1) AS last_outbox_updated_at
     FROM users u WHERE u.id = ?`,
    String(id ?? ''),
  );
  const view = mapUserRow(row, { now });
  if (!view) return null;
  attachGroupsToUserViews([view]);
  return view;
}

/** 按 wechat_user_id 读取用户对外视图（附带 groups）。 */
export function getUserByWechatId(wechatUserId) {
  const row = getUserRowByWechatId(wechatUserId);
  const view = mapUserRow(row);
  if (!view) return null;
  attachGroupsToUserViews([view]);
  return view;
}

/** 读取用户敏感凭证明文（仅内部模块使用，禁止日志/响应）。 */
export function getUserSecrets(id) {
  const row = get('SELECT token_enc, context_token_enc FROM users WHERE id = ?', String(id ?? ''));
  if (!row) return null;
  return {
    token: decryptSecretOrNull(row.token_enc),
    contextToken: decryptSecretOrNull(row.context_token_enc),
  };
}

/**
 * 绑定成功时按 wechat_user_id upsert 用户（等价官方 clearStaleAccountsForUserId 换绑语义）。
 * - 已存在：保留用户 id，清空旧 bot_token/context_token/get_updates_buf/pause_until，状态恢复 active；
 * - 不存在：新建用户。
 * @returns {{user: object, created: boolean, rebound: boolean}}
 */
export function upsertBoundUser({ wechatUserId, displayName = '', ilinkBotId = '', botToken, baseUrl = '' }) {
  if (!wechatUserId) throw new Error('upsertBoundUser: wechatUserId 不能为空');
  if (!botToken) throw new Error('upsertBoundUser: botToken 不能为空');
  const now = nowMs();
  const tokenEnc = encryptSecret(botToken);
  return transaction(() => {
    const existing = getUserRowByWechatId(wechatUserId);
    if (existing) {
      const name = String(displayName || existing.display_name || '').slice(0, 40);
      run(
        `UPDATE users SET
           display_name = ?, ilink_bot_id = ?, token_enc = ?, base_url = ?,
           context_token_enc = NULL, context_token_updated_at = 0, get_updates_buf = '',
           status = 'active', bound_at = ?, updated_at = ?, pause_until = 0,
           last_inbound_at = 0, last_outbound_at = 0, last_poll_at = 0,
           last_error = ''
         WHERE id = ?`,
        name,
        ilinkBotId || null,
        tokenEnc,
        baseUrl || config.ilink.defaultBaseUrl,
        now,
        now,
        existing.id,
      );
      return { user: getUserWithCounts(existing.id, { now }), created: false, rebound: true };
    }
    const id = newUserId();
    run(
      `INSERT INTO users
        (id, display_name, wechat_user_id, ilink_bot_id, token_enc, base_url, status, bound_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      id,
      String(displayName || '').slice(0, 40),
      String(wechatUserId),
      ilinkBotId || null,
      tokenEnc,
      baseUrl || config.ilink.defaultBaseUrl,
      now,
      now,
    );
    return { user: getUserWithCounts(id, { now }), created: true, rebound: false };
  });
}

/** 更新用户最近一条入站消息的 context_token（加密落库）。 */
export function updateContextToken(userId, contextToken, ts = nowMs()) {
  if (!contextToken) return false;
  const result = run(
    "UPDATE users SET context_token_enc = ?, context_token_updated_at = ?, updated_at = ?, last_error = '' WHERE id = ?",
    encryptSecret(String(contextToken)),
    ts,
    ts,
    String(userId),
  );
  return Number(result.changes) > 0;
}

/** 保存 getUpdates 长轮询游标。 */
export function updateGetUpdatesBuf(userId, buf, ts = nowMs()) {
  const result = run('UPDATE users SET get_updates_buf = ?, last_poll_at = ?, updated_at = ? WHERE id = ?', String(buf ?? ''), ts, ts, String(userId));
  return Number(result.changes) > 0;
}

/** 记录轮询时间。 */
export function touchPoll(userId, ts = nowMs()) {
  run('UPDATE users SET last_poll_at = ?, updated_at = ? WHERE id = ?', ts, ts, String(userId));
}

/** 更新最后入站时间。 */
export function touchInbound(userId, ts = nowMs()) {
  run('UPDATE users SET last_inbound_at = ?, updated_at = ? WHERE id = ?', ts, ts, String(userId));
}

/** 更新最后出站时间。 */
export function touchOutbound(userId, ts = nowMs()) {
  run('UPDATE users SET last_outbound_at = ?, updated_at = ? WHERE id = ?', ts, ts, String(userId));
}

/** -14 冷却：设置 pause_until 与最后错误。 */
export function setUserPaused(userId, pauseUntil, lastError = '', ts = nowMs()) {
  const result = run(
    'UPDATE users SET pause_until = ?, last_error = ?, updated_at = ? WHERE id = ?',
    Math.max(0, toNumber(pauseUntil)),
    String(lastError ?? '').slice(0, 500),
    ts,
    String(userId),
  );
  return Number(result.changes) > 0;
}

/** 清除冷却与错误。 */
export function clearUserPause(userId, ts = nowMs()) {
  run("UPDATE users SET pause_until = 0, last_error = '', updated_at = ? WHERE id = ?", ts, String(userId));
}

/** 解绑：清空全部凭证与游标，保留历史用户记录（status=unbound）。 */
export function unbindUser(userId, ts = nowMs()) {
  const result = run(
    `UPDATE users SET
       status = 'unbound', token_enc = NULL, context_token_enc = NULL, context_token_updated_at = 0,
       ilink_bot_id = NULL, base_url = '', get_updates_buf = '', pause_until = 0,
       last_error = '', updated_at = ?
     WHERE id = ?`,
    ts,
    String(userId),
  );
  return Number(result.changes) > 0;
}

/**
 * 彻底删除用户及其关联数据（调用方需先停止该用户监控）。
 * 返回被删除用户、可删除附件相对路径列表与清理统计；附件文件由调用方按路径删除。
 *
 * 共享附件保护：删除附件前检查是否仍被其他用户的未完成 outbox
 * （queued/sending）引用；被引用的附件行与磁盘文件保留（不被本用户“持有”），
 * user_id 置 NULL，避免删除任一收件人导致其他收件人待发媒体丢失。
 */
export function deleteUserCascade(userId, ts = nowMs()) {
  const id = String(userId);
  const user = get('SELECT id, display_name, wechat_user_id, status FROM users WHERE id = ?', id);
  if (!user) return null;
  const attachmentRows = all('SELECT id, path FROM attachments WHERE user_id = ?', id);
  const keptAttachmentIds = [];
  for (const row of attachmentRows) {
    const referenced = get(
      "SELECT 1 AS hit FROM outbox WHERE media_id = ? AND user_id != ? AND status IN ('queued', 'sending') LIMIT 1",
      row.id,
      id,
    );
    if (referenced) keptAttachmentIds.push(row.id);
  }
  const keptSet = new Set(keptAttachmentIds);
  const attachmentPaths = attachmentRows.filter((row) => !keptSet.has(row.id)).map((row) => row.path);
  const summary = transaction(() => {
    const cleared = {};
    for (const table of ['user_groups', 'outbox', 'inbound_messages', 'app_rule_logs', 'events']) {
      cleared[table] = Number(run(`DELETE FROM ${table} WHERE user_id = ?`, id).changes) || 0;
    }
    if (keptAttachmentIds.length === 0) {
      cleared.attachments = Number(run('DELETE FROM attachments WHERE user_id = ?', id).changes) || 0;
    } else {
      const placeholders = keptAttachmentIds.map(() => '?').join(', ');
      cleared.attachments =
        Number(run(`DELETE FROM attachments WHERE user_id = ? AND id NOT IN (${placeholders})`, id, ...keptAttachmentIds).changes) || 0;
      // 共享附件仍被其他收件人引用：保留行与文件，仅解除被删用户的归属。
      run(`UPDATE attachments SET user_id = NULL WHERE id IN (${placeholders})`, ...keptAttachmentIds);
    }
    // 从定时任务目标中移除该用户（target_ids 为 JSON 数组）
    let updatedTasks = 0;
    for (const row of all('SELECT id, target_ids FROM scheduled_tasks')) {
      let ids;
      try {
        ids = JSON.parse(row.target_ids ?? '[]');
      } catch {
        continue;
      }
      if (!Array.isArray(ids) || !ids.map(String).includes(id)) continue;
      run(
        'UPDATE scheduled_tasks SET target_ids = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(ids.filter((item) => String(item) !== id)),
        Number(ts),
        row.id,
      );
      updatedTasks += 1;
    }
    // 从接口应用「指定用户」范围中移除该用户
    let updatedRules = 0;
    for (const row of all("SELECT id, scope_type, scope_ids FROM app_rules WHERE scope_type = 'users'")) {
      let ids;
      try {
        ids = JSON.parse(row.scope_ids ?? '[]');
      } catch {
        continue;
      }
      if (!Array.isArray(ids) || !ids.map(String).includes(id)) continue;
      run(
        'UPDATE app_rules SET scope_ids = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(ids.filter((item) => String(item) !== id)),
        Number(ts),
        row.id,
      );
      updatedRules += 1;
    }
    const deleted = Number(run('DELETE FROM users WHERE id = ?', id).changes) > 0;
    run(
      "INSERT INTO events (type, user_id, detail, created_at) VALUES ('user_delete', NULL, ?, ?)",
      JSON.stringify({
        deleted,
        attachments: attachmentPaths.length,
        sharedAttachmentsKept: keptAttachmentIds.length,
        updatedTasks,
        updatedRules,
      }),
      Number(ts),
    );
    return { deleted, cleared, updatedTasks, updatedRules };
  });
  return { user, attachmentPaths, keptAttachments: keptAttachmentIds.length, ...summary };
}

/** 最近绑定账号的 token 明文列表（供 get_bot_qrcode 的 local_token_list，最多 10 个）。 */
export function getRecentBindingTokens(limit = 10) {
  const rows = all(
    "SELECT token_enc FROM users WHERE token_enc IS NOT NULL AND status = 'active' ORDER BY updated_at DESC LIMIT ?",
    clampInt(limit, { min: 1, max: 10, fallback: 10 }),
  );
  const tokens = [];
  for (const row of rows) {
    const token = decryptSecretOrNull(row.token_enc);
    if (token) tokens.push(token);
  }
  return tokens;
}

/** 用户列表（支持状态筛选/关键词/分组/分页）。status: active|unbound|paused|all */
export function listUsers({ status = 'active', q = '', groupId = '', limit = 50, offset = 0, now = nowMs() } = {}) {
  const filters = [];
  const args = [];
  const keyword = typeof q === 'string' ? q.trim() : '';
  switch (status) {
    case 'active':
      filters.push("u.status = 'active'");
      break;
    case 'unbound':
      filters.push("u.status = 'unbound'");
      break;
    case 'paused':
      filters.push("u.status = 'active' AND u.pause_until > ?");
      args.push(now);
      break;
    case 'all':
    default:
      break;
  }
  if (keyword) {
    filters.push('(u.display_name LIKE ? ESCAPE \'\\\' OR u.wechat_user_id LIKE ? ESCAPE \'\\\' OR u.id LIKE ? ESCAPE \'\\\')');
    const like = likePattern(keyword);
    args.push(like, like, like);
  }
  if (groupId) {
    filters.push('EXISTS (SELECT 1 FROM user_groups ug WHERE ug.user_id = u.id AND ug.group_id = ?)');
    args.push(String(groupId));
  }
  const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const total = toNumber(get(`SELECT COUNT(*) AS c FROM users u ${whereSql}`, ...args).c);
  const rows = all(
    `SELECT u.*,
       (SELECT COUNT(*) FROM outbox o WHERE o.user_id = u.id AND o.status = 'queued') AS queued_count,
       (SELECT COUNT(*) FROM outbox o WHERE o.user_id = u.id AND o.status = 'sent') AS sent_count,
       (SELECT COUNT(*) FROM outbox o WHERE o.user_id = u.id AND o.status = 'failed') AS failed_count,
       (SELECT o.status FROM outbox o WHERE o.user_id = u.id ORDER BY o.updated_at DESC, o.id DESC LIMIT 1) AS last_outbox_status,
       (SELECT o.error FROM outbox o WHERE o.user_id = u.id ORDER BY o.updated_at DESC, o.id DESC LIMIT 1) AS last_outbox_error,
       (SELECT o.updated_at FROM outbox o WHERE o.user_id = u.id ORDER BY o.updated_at DESC, o.id DESC LIMIT 1) AS last_outbox_updated_at
     FROM users u ${whereSql}
     ORDER BY u.bound_at DESC, u.id ASC
     LIMIT ? OFFSET ?`,
    ...args,
    clampInt(limit, { min: 1, max: 500, fallback: 50 }),
    clampInt(offset, { min: 0, max: 10_000_000, fallback: 0 }),
  );
  const items = rows.map((row) => mapUserRow(row, { now }));
  attachGroupsToUserViews(items);
  return { total, items };
}

/** 启动时恢复监控的用户：active 且不在冷却期，按绑定时间从早到晚。 */
export function getActiveUsersForMonitor(limit = config.monitor.maxAccounts, now = nowMs()) {
  return all(
    "SELECT * FROM users WHERE status = 'active' AND pause_until <= ? ORDER BY bound_at ASC LIMIT ?",
    now,
    clampInt(limit, { min: 1, max: 10000, fallback: config.monitor.maxAccounts }),
  );
}

/** 广播目标：active 用户；includePaused 时包含 -14 冷却中的账号。 */
export function getBroadcastTargets({ includePaused = false, now = nowMs() } = {}) {
  if (includePaused) return all("SELECT * FROM users WHERE status = 'active' ORDER BY bound_at ASC");
  return all("SELECT * FROM users WHERE status = 'active' AND pause_until <= ? ORDER BY bound_at ASC", now);
}

/** 按 id 批量读取用户原始行。 */
export function getUsersByIds(ids) {
  const unique = [...new Set((ids ?? []).map((id) => String(id)))].filter(Boolean);
  if (unique.length === 0) return [];
  const placeholders = unique.map(() => '?').join(', ');
  return all(`SELECT * FROM users WHERE id IN (${placeholders})`, ...unique);
}
