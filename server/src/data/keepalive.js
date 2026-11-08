/**
 * keepalive 域：24h 会话保活开关、最近发送时间与候选查询（docs/KEEPALIVE.md §1/§3）。
 *
 * 从 store.js 按域拆分（纯搬迁）。
 */
import { all, get, nowMs, run, transaction } from '../db.js';

import { clampInt, toNumber } from './helpers.js';

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
 * 保活候选用户（docs/KEEPALIVE.md §3）：
 *  1 status='active'；2 keepalive_enabled=1；3 last_inbound_at>0；
 *  4 pause_until<=now；
 *  5 本窗口未发过（keepalive_last_sent_at < last_inbound_at），或距上次提醒 >= repeatMs；
 *  6 now-last_inbound_at >= windowMs-effectiveLeadMs；7 now-last_inbound_at < windowMs；
 *  8 按 last_inbound_at ASC 排序，最多 limit 个。
 * @returns {object[]} 用户原始行
 */
export function getKeepaliveCandidates(now = nowMs(), { windowMs, leadMs, repeatMs, limit } = {}) {
  const window = toNumber(windowMs);
  const effectiveLead = Math.min(Math.max(0, toNumber(leadMs)), window);
  const triggerAt = window - effectiveLead;
  const repeat = Math.max(1, toNumber(repeatMs) || Number.MAX_SAFE_INTEGER);
  return all(
    `SELECT * FROM users
     WHERE status = 'active'
       AND keepalive_enabled = 1
       AND last_inbound_at > 0
       AND pause_until <= ?
       AND (
         keepalive_last_sent_at < last_inbound_at
         OR (? - keepalive_last_sent_at) >= ?
       )
       AND (? - last_inbound_at) >= ?
       AND (? - last_inbound_at) < ?
     ORDER BY last_inbound_at ASC, id ASC
     LIMIT ?`,
    toNumber(now),
    toNumber(now),
    repeat,
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
