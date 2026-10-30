/**
 * 数据访问层（users / outbox / inbound_messages / events）。
 *
 * 安全约定（docs/ARCHITECTURE.md §3/§8）：
 * - bot_token、context_token 只以 crypto.encryptSecret() 的 AES-256-GCM 密文落库；
 *   明文仅通过 getUserSecrets() 提供给绑定/监控/发送模块，绝不进日志与 HTTP 响应。
 * - 对外视图统一走 mapUserRow / mapOutboxRow / mapInboundRow，剥离密文字段。
 */
import { config } from './config.js';
import { decryptSecretOrNull, encryptSecret, randomUuid } from './crypto.js';
import { all, get, nowMs, run, transaction } from './db.js';

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function newUserId() {
  return `u_${randomUuid()}`;
}

function newOutboxId() {
  return `ob_${randomUuid()}`;
}

function newInboundId() {
  return `in_${randomUuid()}`;
}

function newAttachmentId() {
  return `att_${randomUuid()}`;
}

function newGroupId() {
  return `grp_${randomUuid()}`;
}

function newAppRuleId() {
  return `rule_${randomUuid()}`;
}

/** 附件默认 URL 前缀（管理端）；v1 API 视图可传 '/api/v1/media'。 */
const DEFAULT_MEDIA_URL_PREFIX = '/api/admin/media';

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, { min = 0, max = 500, fallback = 50 } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function likePattern(q) {
  return `%${String(q).replace(/[%_]/g, (m) => `\\${m}`)}%`;
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

/** 读取用户原始行（含密文字段，仅供内部使用）。 */
export function getUserRow(id) {
  return get('SELECT * FROM users WHERE id = ?', String(id ?? ''));
}

/** 按微信用户 ID 读取原始行（换绑判定用）。 */
export function getUserRowByWechatId(wechatUserId) {
  return get('SELECT * FROM users WHERE wechat_user_id = ?', String(wechatUserId ?? ''));
}

/** 按 iLink bot 账号 ID 读取原始行（binded_redirect 兜底匹配）。 */
export function getUserRowByBotId(ilinkBotId) {
  return get('SELECT * FROM users WHERE ilink_bot_id = ?', String(ilinkBotId ?? ''));
}

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
       (SELECT COUNT(*) FROM outbox o WHERE o.user_id = u.id AND o.status = 'failed') AS failed_count
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
    'UPDATE users SET context_token_enc = ?, context_token_updated_at = ?, updated_at = ? WHERE id = ?',
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

/** 恢复用户为 active（重新绑定后调用）。 */
export function setUserActive(userId, ts = nowMs()) {
  run("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?", ts, String(userId));
}

/**
 * 彻底删除用户及其关联数据（调用方需先停止该用户监控）。
 * 返回被删除用户、附件相对路径列表与清理统计；附件文件由调用方按路径删除。
 */
export function deleteUserCascade(userId, ts = nowMs()) {
  const id = String(userId);
  const user = get('SELECT id, display_name, wechat_user_id, status FROM users WHERE id = ?', id);
  if (!user) return null;
  const attachmentPaths = all('SELECT path FROM attachments WHERE user_id = ?', id).map((row) => row.path);
  const summary = transaction(() => {
    const cleared = {};
    for (const table of ['user_groups', 'outbox', 'inbound_messages', 'attachments', 'app_rule_logs', 'events']) {
      cleared[table] = Number(run(`DELETE FROM ${table} WHERE user_id = ?`, id).changes) || 0;
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
        updatedTasks,
        updatedRules,
      }),
      Number(ts),
    );
    return { deleted, cleared, updatedTasks, updatedRules };
  });
  return { user, attachmentPaths, ...summary };
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
       (SELECT COUNT(*) FROM outbox o WHERE o.user_id = u.id AND o.status = 'failed') AS failed_count
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

// ---------------------------------------------------------------------------
// groups / user_groups（schema v3：用户分组，docs/GROUPS_AND_INBOUND.md §1/§2）
// ---------------------------------------------------------------------------

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

const GROUP_SELECT_SQL = `SELECT g.*,
  (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id) AS user_count,
  (SELECT COUNT(*) FROM user_groups ug JOIN users u ON u.id = ug.user_id
     WHERE ug.group_id = g.id AND u.status = 'active') AS active_user_count
FROM groups g`;

/** 分组列表（按 created_at ASC）。 */
export function listGroups() {
  return all(`${GROUP_SELECT_SQL} ORDER BY g.created_at ASC, g.id ASC`).map(mapGroupRow);
}

/** 分组原始行（无计数；存在性/归属校验用）。 */
export function getGroupRow(id) {
  return get('SELECT * FROM groups WHERE id = ?', String(id ?? ''));
}

/** 分组对外视图（含计数）；不存在返回 null。 */
export function getGroup(id) {
  return mapGroupRow(get(`${GROUP_SELECT_SQL} WHERE g.id = ?`, String(id ?? '')));
}

/** 按名称查找分组（重名检测；excludeId 用于 PATCH 排除自身）。 */
export function findGroupByName(name, { excludeId = '' } = {}) {
  const normalized = String(name ?? '');
  if (!normalized) return null;
  if (excludeId) return get('SELECT * FROM groups WHERE name = ? AND id <> ?', normalized, String(excludeId));
  return get('SELECT * FROM groups WHERE name = ?', normalized);
}

/** 创建分组（keepaliveEnabled 省略时默认关闭）。 */
export function createGroup({ name, description = '', color = '', keepaliveEnabled = false } = {}) {
  const now = nowMs();
  const id = newGroupId();
  run(
    'INSERT INTO groups (id, name, description, color, keepalive_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    String(name),
    String(description ?? ''),
    String(color ?? ''),
    keepaliveEnabled ? 1 : 0,
    now,
    now,
  );
  return getGroup(id);
}

/** 更新分组（PATCH：仅更新传入字段）；不存在返回 null。 */
export function updateGroup(id, { name, description, color, keepaliveEnabled } = {}) {
  const existing = getGroupRow(id);
  if (!existing) return null;
  const fields = [];
  const args = [];
  if (name !== undefined) {
    fields.push('name = ?');
    args.push(String(name));
  }
  if (description !== undefined) {
    fields.push('description = ?');
    args.push(String(description));
  }
  if (color !== undefined) {
    fields.push('color = ?');
    args.push(String(color));
  }
  if (keepaliveEnabled !== undefined) {
    fields.push('keepalive_enabled = ?');
    args.push(keepaliveEnabled ? 1 : 0);
  }
  if (fields.length === 0) return getGroup(id);
  fields.push('updated_at = ?');
  args.push(nowMs(), String(id));
  run(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?`, ...args);
  return getGroup(id);
}

/** 删除分组（同时清理 user_groups 关联；用户本身不受影响）。 */
export function deleteGroup(id) {
  return transaction(() => {
    run('DELETE FROM user_groups WHERE group_id = ?', String(id));
    const result = run('DELETE FROM groups WHERE id = ?', String(id));
    return Number(result.changes) > 0;
  });
}

/** 读取用户所属分组（[{id,name,color}]，按名称排序）。 */
export function getUserGroups(userId) {
  if (!userId) return [];
  return all(
    `SELECT g.id AS id, g.name AS name, g.color AS color
     FROM user_groups ug JOIN groups g ON g.id = ug.group_id
     WHERE ug.user_id = ? ORDER BY g.name ASC, g.id ASC`,
    String(userId),
  );
}

/** 批量读取多个用户的分组：Map<userId, [{id,name,color}]>。 */
export function getGroupsForUsers(userIds) {
  const ids = [...new Set((userIds ?? []).map((id) => String(id)).filter(Boolean))];
  const result = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = all(
    `SELECT ug.user_id AS user_id, g.id AS id, g.name AS name, g.color AS color
     FROM user_groups ug JOIN groups g ON g.id = ug.group_id
     WHERE ug.user_id IN (${placeholders}) ORDER BY g.name ASC, g.id ASC`,
    ...ids,
  );
  for (const row of rows) {
    const list = result.get(row.user_id);
    if (list) list.push({ id: row.id, name: row.name, color: row.color });
  }
  return result;
}

/** 批量给用户视图附加 groups 字段（原地修改并返回 items）。 */
export function attachGroupsToUserViews(items) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const groupsMap = getGroupsForUsers(items.map((item) => item.id));
  for (const item of items) item.groups = groupsMap.get(item.id) ?? [];
  return items;
}

/**
 * 用户是否属于任一"开启保活"的分组（schema v6；PUT 用户分组返回 inheritedKeepalive 提示用）。
 * 注意：用户实际 keepalive_enabled 可能在移出分组后仍保留（不自动关闭）。
 */
export function userHasKeepaliveGroup(userId) {
  const row = get(
    `SELECT COUNT(*) AS c FROM groups WHERE keepalive_enabled = 1 AND id IN (
       SELECT group_id FROM user_groups WHERE user_id = ?
     )`,
    String(userId),
  );
  return toNumber(row?.c) > 0;
}

/** 分组内成员原始行；activeOnly 时仅 status='active' 且未冷却（群发目标）。 */export function getGroupMembers(groupId, { activeOnly = false, now = nowMs() } = {}) {
  if (activeOnly) {
    return all(
      `SELECT u.* FROM user_groups ug JOIN users u ON u.id = ug.user_id
       WHERE ug.group_id = ? AND u.status = 'active' AND u.pause_until <= ?
       ORDER BY u.bound_at ASC, u.id ASC`,
      String(groupId),
      now,
    );
  }
  return all(
    `SELECT u.* FROM user_groups ug JOIN users u ON u.id = ug.user_id
     WHERE ug.group_id = ? ORDER BY u.bound_at ASC, u.id ASC`,
    String(groupId),
  );
}

/**
 * 全量替换用户分组（去重；事务）。返回最新 GroupView[]。
 * 继承语义（schema v6）：本次**新增**的分组中若有 keepalive_enabled=1，则把用户保活自动置 1；
 * 仅自动开启、不因移出分组而关闭（保留用户手动开关）。
 */
export function replaceUserGroups(userId, groupIds = []) {
  const unique = [...new Set((groupIds ?? []).map((id) => String(id)).filter(Boolean))];
  const now = nowMs();
  return transaction(() => {
    const oldIds = new Set(
      all('SELECT group_id FROM user_groups WHERE user_id = ?', String(userId)).map((row) => String(row.group_id)),
    );
    const addedIds = unique.filter((groupId) => !oldIds.has(groupId));
    run('DELETE FROM user_groups WHERE user_id = ?', String(userId));
    for (const groupId of unique) {
      run('INSERT INTO user_groups (user_id, group_id, created_at) VALUES (?, ?, ?)', String(userId), groupId, now);
    }
    if (addedIds.length > 0) {
      const placeholders = addedIds.map(() => '?').join(', ');
      const enabled = get(
        `SELECT COUNT(*) AS c FROM groups WHERE keepalive_enabled = 1 AND id IN (${placeholders})`,
        ...addedIds,
      );
      if (toNumber(enabled?.c) > 0) {
        run('UPDATE users SET keepalive_enabled = 1, updated_at = ? WHERE id = ?', now, String(userId));
      }
    }
    return getUserGroups(userId);
  });
}

// ---------------------------------------------------------------------------
// keepalive（schema v4：24h 会话保活，docs/KEEPALIVE.md §1/§3）
// ---------------------------------------------------------------------------

/** 单用户开关保活；返回是否命中用户。 */
export function setKeepaliveEnabled(userId, enabled, ts = nowMs()) {
  const result = run(
    'UPDATE users SET keepalive_enabled = ?, updated_at = ? WHERE id = ?',
    enabled ? 1 : 0,
    ts,
    String(userId),
  );
  return Number(result.changes) > 0;
}

/**
 * 分组批量开关保活（schema v6）：事务内 ①持久化 groups.keepalive_enabled ②同步更新当前成员
 * users.keepalive_enabled；返回更新的成员数（含 unbound 历史用户，全部归属成员）。
 */
export function setGroupKeepaliveEnabled(groupId, enabled, ts = nowMs()) {
  return transaction(() => {
    run(
      'UPDATE groups SET keepalive_enabled = ?, updated_at = ? WHERE id = ?',
      enabled ? 1 : 0,
      toNumber(ts),
      String(groupId),
    );
    const result = run(
      `UPDATE users SET keepalive_enabled = ?, updated_at = ?
       WHERE id IN (SELECT user_id FROM user_groups WHERE group_id = ?)`,
      enabled ? 1 : 0,
      toNumber(ts),
      String(groupId),
    );
    return Number(result.changes);
  });
}

/** 记录最近一次保活发送时间（用于"同一窗口只发一次"判定）。 */
export function setKeepaliveLastSentAt(userId, ts = nowMs()) {
  const result = run(
    'UPDATE users SET keepalive_last_sent_at = ?, updated_at = ? WHERE id = ?',
    toNumber(ts),
    toNumber(ts),
    String(userId),
  );
  return Number(result.changes) > 0;
}

/**
 * 保活候选用户（docs/KEEPALIVE.md §3 的 8 个条件）：
 *  1 status='active'；2 keepalive_enabled=1；3 last_inbound_at>0；
 *  4 pause_until<=now；5 keepalive_last_sent_at < last_inbound_at（本窗口未发过）；
 *  6 now-last_inbound_at >= windowMs-effectiveLeadMs；7 now-last_inbound_at < windowMs；
 *  8 按 last_inbound_at ASC 排序，最多 limit 个。
 * @returns {object[]} 用户原始行
 */
export function getKeepaliveCandidates(now = nowMs(), { windowMs, leadMs, limit } = {}) {
  const window = toNumber(windowMs);
  const effectiveLead = Math.min(Math.max(0, toNumber(leadMs)), window);
  const triggerAt = window - effectiveLead;
  return all(
    `SELECT * FROM users
     WHERE status = 'active'
       AND keepalive_enabled = 1
       AND last_inbound_at > 0
       AND pause_until <= ?
       AND keepalive_last_sent_at < last_inbound_at
       AND (? - last_inbound_at) >= ?
       AND (? - last_inbound_at) < ?
     ORDER BY last_inbound_at ASC, id ASC
     LIMIT ?`,
    toNumber(now),
    toNumber(now),
    triggerAt,
    toNumber(now),
    window,
    clampInt(limit, { min: 1, max: 10000, fallback: 100 }),
  );
}

/** 开启保活的用户总数（overview 统计）。 */
export function countKeepaliveEnabled() {
  return toNumber(get('SELECT COUNT(*) AS c FROM users WHERE keepalive_enabled = 1').c);
}

/** 最近 24h 入队的保活消息数（overview 统计）。 */
export function countKeepaliveSent24h(now = nowMs()) {
  return toNumber(
    get("SELECT COUNT(*) AS c FROM outbox WHERE source = 'keepalive' AND created_at >= ?", toNumber(now) - 24 * 60 * 60 * 1000).c,
  );
}

// ---------------------------------------------------------------------------
// 接口应用（schema v5：app_rules / app_rule_logs，docs/API_RULES.md §1/§7）
// ---------------------------------------------------------------------------

/** 安全解析 JSON 字段。 */
function parseJsonValue(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** 分组/用户 id → 名称（RuleView.scope.names）。 */
function resolveScopeNames(scopeType, ids) {
  if (scopeType === 'groups') {
    return ids.map((id) => getGroupRow(id)?.name ?? id);
  }
  if (scopeType === 'users') {
    return ids.map((id) => getUserRow(id)?.display_name ?? id);
  }
  return [];
}

/** 规则统计（lastRunAt/lastStatus + 24h 计数）。 */
export function getAppRuleStats(ruleId, now = nowMs()) {
  const last = get('SELECT created_at, status FROM app_rule_logs WHERE rule_id = ? ORDER BY id DESC LIMIT 1', String(ruleId));
  const since = toNumber(now) - 24 * 60 * 60 * 1000;
  const counts = { success: 0, failed: 0, skipped: 0 };
  for (const row of all(
    'SELECT status, COUNT(*) AS c FROM app_rule_logs WHERE rule_id = ? AND created_at >= ? GROUP BY status',
    String(ruleId),
    since,
  )) {
    if (row.status in counts) counts[row.status] = toNumber(row.c);
  }
  return {
    lastRunAt: last ? toNumber(last.created_at) : 0,
    lastStatus: last?.status ?? '',
    success24h: counts.success,
    failed24h: counts.failed,
    skipped24h: counts.skipped,
  };
}

/** 规则对外视图（GET）——不含任何 header 值，只返回 headerNames。 */
export function mapAppRuleRow(row, { includeStats = true, now = nowMs() } = {}) {
  if (!row) return null;
  const headers = parseJsonValue(decryptSecretOrNull(row.request_headers_enc), null);
  const scopeIds = parseJsonValue(row.scope_ids, []);
  const scopeType = row.scope_type ?? 'all';
  const keywords = parseJsonValue(row.keywords, []);
  const extractionConfig = parseJsonValue(row.extraction_config, {});
  const id = row.id;
  return {
    id,
    name: row.name ?? '',
    enabled: Boolean(row.enabled),
    priority: toNumber(row.priority),
    scope: {
      type: scopeType,
      ids: scopeIds,
      names: resolveScopeNames(scopeType, scopeIds),
    },
    trigger: {
      matchMode: row.match_mode ?? 'contains',
      keywords,
      regexPattern: row.regex_pattern ?? '',
    },
    extraction: {
      mode: row.extraction_mode ?? 'trailing',
      config: extractionConfig,
    },
    request: {
      method: row.request_method ?? 'GET',
      url: row.request_url ?? '',
      headerNames: headers && typeof headers === 'object' ? Object.keys(headers) : [],
      bodyTemplate: row.request_body_template ?? '',
    },
    response: {
      type: row.response_type ?? 'json',
      path: row.response_path ?? '',
      template: row.reply_template ?? '',
      fallbackText: row.fallback_text ?? '',
    },
    limits: {
      timeoutMs: toNumber(row.timeout_ms),
      cooldownMs: toNumber(row.cooldown_ms),
      maxCallsPerHour: toNumber(row.max_calls_per_hour),
      maxUserCallsPerHour: toNumber(row.max_user_calls_per_hour),
    },
    stats: includeStats
      ? getAppRuleStats(id, now)
      : { lastRunAt: 0, lastStatus: '', success24h: 0, failed24h: 0, skipped24h: 0 },
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  };
}

/** 规则原始行（引擎执行用；header 值仍需解密，不对外暴露）。 */
export function getAppRuleRow(id) {
  return get('SELECT * FROM app_rules WHERE id = ?', String(id ?? ''));
}

/** 单条规则对外视图。 */
export function getAppRule(id, options = {}) {
  return mapAppRuleRow(getAppRuleRow(id), options);
}

/** 规则列表（默认只返回 enabled 的规则；按 priority ASC, created_at ASC）。 */
export function listAppRules({ includeDisabled = false, includeStats = true } = {}) {
  const rows = includeDisabled
    ? all('SELECT * FROM app_rules ORDER BY priority ASC, created_at ASC, id ASC')
    : all('SELECT * FROM app_rules WHERE enabled = 1 ORDER BY priority ASC, created_at ASC, id ASC');
  return rows.map((row) => mapAppRuleRow(row, { includeStats }));
}

/** 引擎执行用：enabled 规则原始行（priority ASC, created_at ASC）。 */
export function listEnabledAppRuleRows() {
  return all('SELECT * FROM app_rules WHERE enabled = 1 ORDER BY priority ASC, created_at ASC, id ASC');
}

const APP_RULE_COLUMNS = {
  name: 'name',
  enabled: 'enabled',
  priority: 'priority',
  scopeType: 'scope_type',
  scopeIds: 'scope_ids',
  matchMode: 'match_mode',
  keywords: 'keywords',
  regexPattern: 'regex_pattern',
  extractionMode: 'extraction_mode',
  extractionConfig: 'extraction_config',
  requestMethod: 'request_method',
  requestUrl: 'request_url',
  requestHeadersEnc: 'request_headers_enc',
  requestBodyTemplate: 'request_body_template',
  responseType: 'response_type',
  responsePath: 'response_path',
  replyTemplate: 'reply_template',
  fallbackText: 'fallback_text',
  timeoutMs: 'timeout_ms',
  cooldownMs: 'cooldown_ms',
  maxCallsPerHour: 'max_calls_per_hour',
  maxUserCallsPerHour: 'max_user_calls_per_hour',
};

/** 字段值序列化：JSON 字段与布尔/数字列。 */
function appRuleColumnValue(key, value) {
  if (key === 'scopeIds' || key === 'keywords' || key === 'extractionConfig') return JSON.stringify(value ?? (key === 'extractionConfig' ? {} : []));
  if (key === 'enabled') return value ? 1 : 0;
  if (['priority', 'timeoutMs', 'cooldownMs', 'maxCallsPerHour', 'maxUserCallsPerHour'].includes(key)) return toNumber(value);
  if (value === undefined || value === null) return '';
  return String(value);
}

/** 创建规则（入参为已校验的扁平 camelCase 字段）。 */
export function createAppRule(input) {
  const now = nowMs();
  const id = newAppRuleId();
  const fields = Object.keys(APP_RULE_COLUMNS).filter((key) => input[key] !== undefined);
  const columns = ['id', ...fields.map((key) => APP_RULE_COLUMNS[key]), 'created_at', 'updated_at'];
  const values = [id, ...fields.map((key) => appRuleColumnValue(key, input[key])), now, now];
  run(
    `INSERT INTO app_rules (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ...values,
  );
  return getAppRule(id);
}

/** 更新规则（部分字段；未传字段不变）。 */
export function updateAppRule(id, patch) {
  if (!getAppRuleRow(id)) return null;
  const fields = Object.keys(APP_RULE_COLUMNS).filter((key) => patch[key] !== undefined);
  if (fields.length === 0) return getAppRule(id);
  const sets = fields.map((key) => `${APP_RULE_COLUMNS[key]} = ?`);
  const values = fields.map((key) => appRuleColumnValue(key, patch[key]));
  run(`UPDATE app_rules SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...values, nowMs(), String(id));
  return getAppRule(id);
}

/** 删除规则（日志保留用于审计）。 */
export function deleteAppRule(id) {
  const result = run('DELETE FROM app_rules WHERE id = ?', String(id));
  return Number(result.changes) > 0;
}

/**
 * 写入规则运行日志；同 (rule_id, inbound_message_id) 唯一索引冲突 → inserted:false（去重跳过）。
 * @returns {{inserted:boolean, id:number|null, deduped:boolean}}
 */
export function insertAppRuleLog({
  ruleId,
  userId = null,
  inboundMessageId = null,
  status = 'matched',
  httpStatus = null,
  latencyMs = null,
  error = '',
  paramsPreview = '',
  requestPreview = '',
  responsePreview = '',
  replyOutboxId = null,
  createdAt = nowMs(),
} = {}) {
  const result = run(
    `INSERT OR IGNORE INTO app_rule_logs
       (rule_id, user_id, inbound_message_id, status, http_status, latency_ms, error,
        params_preview, request_preview, response_preview, reply_outbox_id, created_at)
     VALUES (?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    String(ruleId),
    userId ? String(userId) : null,
    inboundMessageId === null || inboundMessageId === undefined ? '' : String(inboundMessageId),
    String(status),
    httpStatus === null || httpStatus === undefined ? null : toNumber(httpStatus),
    latencyMs === null || latencyMs === undefined ? null : toNumber(latencyMs),
    String(error ?? '').slice(0, 1000),
    String(paramsPreview ?? '').slice(0, 2000),
    String(requestPreview ?? '').slice(0, 1000),
    String(responsePreview ?? '').slice(0, 2000),
    replyOutboxId ? String(replyOutboxId) : null,
    toNumber(createdAt),
  );
  const inserted = Number(result.changes) > 0;
  return {
    inserted,
    deduped: !inserted,
    id: inserted ? Number(result.lastInsertRowid) : null,
  };
}

/** 更新一条运行日志的终态/结果字段。 */
export function updateAppRuleLog(id, patch = {}) {
  const mapping = {
    status: 'status',
    httpStatus: 'http_status',
    latencyMs: 'latency_ms',
    error: 'error',
    paramsPreview: 'params_preview',
    requestPreview: 'request_preview',
    responsePreview: 'response_preview',
    replyOutboxId: 'reply_outbox_id',
  };
  const fields = Object.keys(mapping).filter((key) => patch[key] !== undefined);
  if (fields.length === 0) return false;
  const sets = fields.map((key) => `${mapping[key]} = ?`);
  const values = fields.map((key) => {
    if (key === 'httpStatus' || key === 'latencyMs') return toNumber(patch[key]);
    if (key === 'replyOutboxId') return patch[key] ? String(patch[key]) : null;
    if (key === 'error') return String(patch[key] ?? '').slice(0, 1000);
    if (key === 'paramsPreview') return String(patch[key] ?? '').slice(0, 2000);
    if (key === 'requestPreview') return String(patch[key] ?? '').slice(0, 1000);
    if (key === 'responsePreview') return String(patch[key] ?? '').slice(0, 2000);
    return String(patch[key]);
  });
  const result = run(`UPDATE app_rule_logs SET ${sets.join(', ')} WHERE id = ?`, ...values, Number(id));
  return Number(result.changes) > 0;
}

/** 规则运行日志列表（ruleId/status/userId 过滤 + 分页）。 */
export function listAppRuleLogs({ ruleId = '', status = '', userId = '', limit = 50, offset = 0 } = {}) {
  const filters = [];
  const args = [];
  if (ruleId) {
    filters.push('l.rule_id = ?');
    args.push(String(ruleId));
  }
  if (status) {
    filters.push('l.status = ?');
    args.push(String(status));
  }
  if (userId) {
    filters.push('l.user_id = ?');
    args.push(String(userId));
  }
  const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const total = toNumber(get(`SELECT COUNT(*) AS c FROM app_rule_logs l ${whereSql}`, ...args).c);
  const rows = all(
    `SELECT l.*, r.name AS rule_name FROM app_rule_logs l LEFT JOIN app_rules r ON r.id = l.rule_id
     ${whereSql} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    ...args,
    clampInt(limit, { min: 1, max: 500, fallback: 50 }),
    clampInt(offset, { min: 0, max: 10_000_000, fallback: 0 }),
  );
  return {
    total,
    items: rows.map((row) => ({
      id: Number(row.id),
      ruleId: row.rule_id,
      ruleName: row.rule_name ?? '',
      userId: row.user_id ?? '',
      status: row.status,
      httpStatus: row.http_status === null ? null : toNumber(row.http_status),
      latencyMs: row.latency_ms === null ? null : toNumber(row.latency_ms),
      error: row.error ?? '',
      paramsPreview: row.params_preview ?? '',
      requestPreview: row.request_preview ?? '',
      responsePreview: row.response_preview ?? '',
      replyOutboxId: row.reply_outbox_id ?? null,
      createdAt: toNumber(row.created_at),
    })),
  };
}

/** 同用户同规则最近一次 matched/success 日志时间（冷却判定）。 */
export function getAppRuleLastMatchedAt(ruleId, userId) {
  const row = get(
    `SELECT MAX(created_at) AS t FROM app_rule_logs
     WHERE rule_id = ? AND user_id = ? AND status IN ('matched', 'success')`,
    String(ruleId),
    String(userId),
  );
  return row && row.t !== null ? toNumber(row.t) : 0;
}

/** 最近 1h 内规则/用户调用次数（成功+失败；小时配额判定）。 */
export function countAppRuleLogsLastHour(ruleId, now = nowMs(), { userId = '' } = {}) {
  const since = toNumber(now) - 60 * 60 * 1000;
  if (userId) {
    return toNumber(
      get(
        `SELECT COUNT(*) AS c FROM app_rule_logs
         WHERE rule_id = ? AND user_id = ? AND created_at >= ? AND status IN ('success', 'failed')`,
        String(ruleId),
        String(userId),
        since,
      ).c,
    );
  }
  return toNumber(
    get(
      `SELECT COUNT(*) AS c FROM app_rule_logs
       WHERE rule_id = ? AND created_at >= ? AND status IN ('success', 'failed')`,
      String(ruleId),
      since,
    ).c,
  );
}

// ---------------------------------------------------------------------------
// 定时通知（schema v7：scheduled_tasks / scheduled_task_logs，docs/SCHEDULED_TASKS.md §1/§5）
// ---------------------------------------------------------------------------

function newScheduledTaskId() {
  return `task_${randomUuid()}`;
}

/** 目标 id → 名称（TaskView.targets.names）。 */
function resolveScheduledTargetNames(targetType, ids) {
  if (targetType === 'groups') return ids.map((id) => getGroupRow(id)?.name ?? id);
  return ids.map((id) => getUserRow(id)?.display_name ?? id);
}

/** 任务对外视图（GET；header 只返回键名，不含值）。 */
export function mapScheduledTaskRow(row) {
  if (!row) return null;
  const headers = parseJsonValue(decryptSecretOrNull(row.request_headers_enc), null);
  const targetIds = parseJsonValue(row.target_ids, []);
  const targetType = row.target_type ?? 'users';
  return {
    id: row.id,
    name: row.name ?? '',
    enabled: Boolean(row.enabled),
    schedule: {
      type: row.schedule_type ?? 'interval',
      intervalMs: toNumber(row.interval_ms),
      dailyTime: row.daily_time ?? '08:00',
      // 每日生效时间段（仅 interval；空字符串表示不限）
      windowStart: row.window_start ?? '',
      windowEnd: row.window_end ?? '',
      timezone: config.scheduler.timezone,
    },
    targets: {
      type: targetType,
      ids: Array.isArray(targetIds) ? targetIds : [],
      names: resolveScheduledTargetNames(targetType, Array.isArray(targetIds) ? targetIds : []),
    },
    request: {
      method: row.request_method ?? 'GET',
      url: row.request_url ?? '',
      headerNames: headers && typeof headers === 'object' ? Object.keys(headers) : [],
      bodyTemplate: row.request_body_template ?? '',
    },
    response: {
      type: row.response_type ?? 'json',
      path: row.response_path ?? '',
      template: row.reply_template ?? '',
      fallbackText: row.fallback_text ?? '',
    },
    limits: { timeoutMs: toNumber(row.timeout_ms) },
    nextRunAt: toNumber(row.next_run_at),
    lastRunAt: toNumber(row.last_run_at),
    lastStatus: row.last_status ?? '',
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  };
}

/** 任务原始行。 */
export function getScheduledTaskRow(id) {
  return get('SELECT * FROM scheduled_tasks WHERE id = ?', String(id ?? ''));
}

/** 单任务视图。 */
export function getScheduledTask(id) {
  return mapScheduledTaskRow(getScheduledTaskRow(id));
}

/** 任务列表（默认含 disabled，按创建时间倒序）。 */
export function listScheduledTasks({ includeDisabled = true } = {}) {
  const rows = includeDisabled
    ? all('SELECT * FROM scheduled_tasks ORDER BY created_at DESC, id DESC')
    : all('SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY created_at DESC, id DESC');
  return rows.map(mapScheduledTaskRow);
}

const SCHEDULED_TASK_COLUMNS = {
  name: 'name',
  enabled: 'enabled',
  scheduleType: 'schedule_type',
  intervalMs: 'interval_ms',
  dailyTime: 'daily_time',
  windowStart: 'window_start',
  windowEnd: 'window_end',
  targetType: 'target_type',
  targetIds: 'target_ids',
  requestMethod: 'request_method',
  requestUrl: 'request_url',
  requestHeadersEnc: 'request_headers_enc',
  requestBodyTemplate: 'request_body_template',
  responseType: 'response_type',
  responsePath: 'response_path',
  replyTemplate: 'reply_template',
  fallbackText: 'fallback_text',
  timeoutMs: 'timeout_ms',
  nextRunAt: 'next_run_at',
};

function scheduledTaskColumnValue(key, value) {
  if (key === 'targetIds') return JSON.stringify(Array.isArray(value) ? value : []);
  if (key === 'enabled') return value ? 1 : 0;
  if (key === 'intervalMs' || key === 'timeoutMs' || key === 'nextRunAt') return toNumber(value);
  if (value === undefined || value === null) return '';
  return String(value);
}

/** 创建任务（入参为已校验的扁平 camelCase 字段）。 */
export function createScheduledTask(input) {
  const now = nowMs();
  const id = newScheduledTaskId();
  const fields = Object.keys(SCHEDULED_TASK_COLUMNS).filter((key) => input[key] !== undefined);
  const columns = ['id', ...fields.map((key) => SCHEDULED_TASK_COLUMNS[key]), 'created_at', 'updated_at'];
  const values = [id, ...fields.map((key) => scheduledTaskColumnValue(key, input[key])), now, now];
  run(`INSERT INTO scheduled_tasks (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...values);
  return getScheduledTask(id);
}

/** 更新任务（部分字段；不存在返回 null）。 */
export function updateScheduledTask(id, patch) {
  if (!getScheduledTaskRow(id)) return null;
  const fields = Object.keys(SCHEDULED_TASK_COLUMNS).filter((key) => patch[key] !== undefined);
  if (fields.length === 0) return getScheduledTask(id);
  const sets = fields.map((key) => `${SCHEDULED_TASK_COLUMNS[key]} = ?`);
  const values = fields.map((key) => scheduledTaskColumnValue(key, patch[key]));
  run(`UPDATE scheduled_tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...values, nowMs(), String(id));
  return getScheduledTask(id);
}

/** 删除任务（运行日志保留供审计）。 */
export function deleteScheduledTask(id) {
  return Number(run('DELETE FROM scheduled_tasks WHERE id = ?', String(id)).changes) > 0;
}

/** 到期任务（enabled=1 AND next_run_at<=now，按 next_run_at ASC 取 limit 个）。 */
export function listDueScheduledTasks(now = nowMs(), limit = 10) {
  return all(
    'SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC LIMIT ?',
    toNumber(now),
    clampInt(limit, { min: 1, max: 100, fallback: 10 }),
  );
}

/** 写回任务执行结果（last_run_at/last_status/next_run_at）。 */
export function markScheduledTaskRun(id, { lastRunAt = nowMs(), lastStatus = '', nextRunAt = 0 } = {}) {
  const result = run(
    'UPDATE scheduled_tasks SET last_run_at = ?, last_status = ?, next_run_at = ? WHERE id = ?',
    toNumber(lastRunAt),
    String(lastStatus ?? ''),
    toNumber(nextRunAt),
    String(id),
  );
  return Number(result.changes) > 0;
}

/** 写入任务运行日志。 */
export function insertScheduledTaskLog({
  taskId,
  status = 'success',
  httpStatus = null,
  latencyMs = null,
  error = '',
  responsePreview = '',
  replyPreview = '',
  recipientsCount = 0,
  createdAt = nowMs(),
} = {}) {
  const result = run(
    `INSERT INTO scheduled_task_logs
       (task_id, status, http_status, latency_ms, error, response_preview, reply_preview, recipients_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    String(taskId),
    String(status),
    httpStatus === null || httpStatus === undefined ? null : toNumber(httpStatus),
    latencyMs === null || latencyMs === undefined ? null : toNumber(latencyMs),
    String(error ?? '').slice(0, 1000),
    String(responsePreview ?? '').slice(0, 2000),
    String(replyPreview ?? '').slice(0, 2000),
    toNumber(recipientsCount),
    toNumber(createdAt),
  );
  return Number(result.lastInsertRowid);
}

/** 任务运行日志列表（taskId/status 过滤 + 分页，带 taskName）。 */
export function listScheduledTaskLogs({ taskId = '', status = '', limit = 50, offset = 0 } = {}) {
  const filters = [];
  const args = [];
  if (taskId) {
    filters.push('l.task_id = ?');
    args.push(String(taskId));
  }
  if (status) {
    filters.push('l.status = ?');
    args.push(String(status));
  }
  const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const total = toNumber(get(`SELECT COUNT(*) AS c FROM scheduled_task_logs l ${whereSql}`, ...args).c);
  const rows = all(
    `SELECT l.*, t.name AS task_name FROM scheduled_task_logs l LEFT JOIN scheduled_tasks t ON t.id = l.task_id
     ${whereSql} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    ...args,
    clampInt(limit, { min: 1, max: 500, fallback: 50 }),
    clampInt(offset, { min: 0, max: 10_000_000, fallback: 0 }),
  );
  return {
    total,
    items: rows.map((row) => ({
      id: Number(row.id),
      taskId: row.task_id,
      taskName: row.task_name ?? '',
      status: row.status,
      httpStatus: row.http_status === null ? null : toNumber(row.http_status),
      latencyMs: row.latency_ms === null ? null : toNumber(row.latency_ms),
      error: row.error ?? '',
      responsePreview: row.response_preview ?? '',
      replyPreview: row.reply_preview ?? '',
      recipientsCount: toNumber(row.recipients_count),
      createdAt: toNumber(row.created_at),
    })),
  };
}

/**
 * 解析任务目标收件人（docs/SCHEDULED_TASKS.md §4.5）：
 * users → target_ids 中 status='active'；groups → 分组成员中 status='active'；按 id 稳定排序、去重、
 * 上限 maxRecipients 截断。返回 { userIds, total, truncated }。
 */
export function resolveScheduledTaskRecipients(taskRow, { maxRecipients = config.scheduler.maxRecipients } = {}) {
  if (!taskRow) return { userIds: [], total: 0, truncated: false };
  const ids = parseJsonValue(taskRow.target_ids, []);
  const targetIds = Array.isArray(ids) ? ids.map(String) : [];
  let rows = [];
  if (targetIds.length > 0) {
    const placeholders = targetIds.map(() => '?').join(', ');
    if ((taskRow.target_type ?? 'users') === 'groups') {
      rows = all(
        `SELECT DISTINCT u.id AS id FROM user_groups ug JOIN users u ON u.id = ug.user_id
         WHERE ug.group_id IN (${placeholders}) AND u.status = 'active' ORDER BY u.id ASC`,
        ...targetIds,
      );
    } else {
      rows = all(
        `SELECT id FROM users WHERE id IN (${placeholders}) AND status = 'active' ORDER BY id ASC`,
        ...targetIds,
      );
    }
  }
  const unique = [...new Set(rows.map((row) => String(row.id)))].sort();
  const limit = clampInt(maxRecipients, { min: 1, max: 100000, fallback: 200 });
  return {
    userIds: unique.slice(0, limit),
    total: unique.length,
    truncated: unique.length > limit,
  };
}

// ---------------------------------------------------------------------------
// attachments（schema v2：多媒体附件，docs/MEDIA.md §4.1）
// ---------------------------------------------------------------------------

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

/** 批量读取 outbox 的附件原始行：Map<outbox_id, row[]>。 */
export function getAttachmentsByOutboxIds(outboxIds) {
  const ids = [...new Set((outboxIds ?? []).map((id) => String(id)))].filter(Boolean);
  const result = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = all(
    `SELECT * FROM attachments WHERE outbox_id IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`,
    ...ids,
  );
  for (const row of rows) {
    const list = result.get(row.outbox_id);
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

/** 关联附件到 outbox（入队时回填 attachments.outbox_id）。 */
export function linkAttachmentOutbox(attachmentId, outboxId, ts = nowMs()) {
  const result = run(
    'UPDATE attachments SET outbox_id = ?, user_id = COALESCE(user_id, (SELECT user_id FROM outbox WHERE id = ?)) WHERE id = ?',
    String(outboxId),
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

// ---------------------------------------------------------------------------
// outbox
// ---------------------------------------------------------------------------

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

/** 发送失败（终态）。 */
export function markOutboxFailed(id, { error = '', ts = nowMs() } = {}) {
  const result = run(
    "UPDATE outbox SET status = 'failed', attempts = attempts + 1, error = ?, updated_at = ? WHERE id = ?",
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

/** 给 outbox 行映射视图并批量附加 attachments（media_id 优先，兼容旧 outbox_id 关联）。 */
function attachToOutboxRows(rows, { urlPrefix = DEFAULT_MEDIA_URL_PREFIX } = {}) {
  const mediaIds = rows.map((row) => row.media_id).filter(Boolean);
  const byId = getAttachmentsByIds(mediaIds);
  const legacyRows = rows.filter((row) => !row.media_id);
  const byOutboxId = getAttachmentsByOutboxIds(legacyRows.map((row) => row.id));
  return rows.map((row) => {
    const view = mapOutboxRow(row);
    const list = row.media_id ? (byId.has(row.media_id) ? [byId.get(row.media_id)] : []) : (byOutboxId.get(row.id) ?? []);
    view.attachments = list.map((attachment) => mapAttachmentRow(attachment, { urlPrefix }));
    return view;
  });
}

// ---------------------------------------------------------------------------
// inbound_messages
// ---------------------------------------------------------------------------

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
  // 批量附加 attachments：入站按 inbound_messages.id、出站按 outbox.media_id（兼容旧 outbox_id 关联）
  const inboundRows = rows.filter((row) => row.direction === 'inbound');
  const outboundRows = rows.filter((row) => row.direction === 'outbound');
  const inboundAttachments = getAttachmentsByInbound(inboundRows.map((row) => row.id));
  const outboundAttachmentsById = getAttachmentsByIds(outboundRows.map((row) => row.media_id).filter(Boolean));
  const legacyOutbound = getAttachmentsByOutboxIds(outboundRows.filter((row) => !row.media_id).map((row) => row.id));
  rows.forEach((row, index) => {
    let list = [];
    if (row.direction === 'inbound') {
      list = inboundAttachments.get(row.id) ?? [];
    } else if (row.media_id) {
      const attachment = outboundAttachmentsById.get(row.media_id);
      if (attachment) list = [attachment];
    } else {
      list = legacyOutbound.get(row.id) ?? [];
    }
    items[index].attachments = list.map((attachment) => mapAttachmentRow(attachment, { urlPrefix }));
  });
  return { total, items };
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/** 记录系统事件（bind / rebind / unbind / stale_token / login / bind_error …）。 */
export function addEvent({ type, userId = null, detail = '', ts = nowMs() }) {
  run(
    'INSERT INTO events (type, user_id, detail, created_at) VALUES (?, ?, ?, ?)',
    String(type),
    userId ? String(userId) : null,
    String(detail ?? '').slice(0, 2000),
    toNumber(ts),
  );
}

/** 最近事件（运维排查用）。 */
export function listEvents(limit = 100) {
  return all('SELECT * FROM events ORDER BY id DESC LIMIT ?', clampInt(limit, { min: 1, max: 1000, fallback: 100 }));
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

/** 管理后台概览统计（docs/API.md §2.2）。 */
export function getStats({ now = nowMs() } = {}) {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();

  const totalUsers = toNumber(get('SELECT COUNT(*) AS c FROM users').c);
  const activeUsers = toNumber(get("SELECT COUNT(*) AS c FROM users WHERE status = 'active'").c);
  const pausedUsers = toNumber(get("SELECT COUNT(*) AS c FROM users WHERE status = 'active' AND pause_until > ?", now).c);
  const usersWithContextToken = toNumber(
    get("SELECT COUNT(*) AS c FROM users WHERE status = 'active' AND context_token_enc IS NOT NULL").c,
  );
  const inboundToday = toNumber(get('SELECT COUNT(*) AS c FROM inbound_messages WHERE received_at >= ?', todayStart).c);
  const outboundToday = toNumber(get('SELECT COUNT(*) AS c FROM outbox WHERE created_at >= ?', todayStart).c);
  const inboundLast24h = toNumber(get('SELECT COUNT(*) AS c FROM inbound_messages WHERE received_at >= ?', now - 24 * 60 * 60 * 1000).c);
  const keepaliveEnabledUsers = countKeepaliveEnabled();
  const keepaliveSent24h = countKeepaliveSent24h(now);

  const counts = { queued: 0, sending: 0, sent: 0, failed: 0 };
  for (const row of all('SELECT status, COUNT(*) AS c FROM outbox GROUP BY status')) {
    if (row.status in counts) counts[row.status] = toNumber(row.c);
  }

  return {
    totalUsers,
    activeUsers,
    pausedUsers,
    usersWithContextToken,
    messagesToday: inboundToday + outboundToday,
    queued: counts.queued,
    sending: counts.sending,
    sent: counts.sent,
    failed: counts.failed,
    inboundLast24h,
    keepaliveEnabledUsers,
    keepaliveSent24h,
  };
}
