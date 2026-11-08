/**
 * 统计域：管理后台概览统计（docs/API.md §2.2）。
 *
 * “今日”按 config.scheduler.timezone 计算当日零点（与调度口径一致），不再依赖进程本地时区。
 */
import { config } from '../config.js';
import { all, get, nowMs } from '../db.js';

import { startOfDayInTimeZone, toNumber } from './helpers.js';
import { countKeepaliveEnabled, countKeepaliveSent24h } from './keepalive.js';

/** 管理后台概览统计（docs/API.md §2.2）。 */
export function getStats({ now = nowMs() } = {}) {
  const todayStart = startOfDayInTimeZone(now, config.scheduler.timezone);

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
