/**
 * events 域：系统事件写入与最近事件查询。
 *
 * 从 store.js 按域拆分（纯搬迁）。
 */
import { all, nowMs, run } from '../db.js';

import { clampInt, toNumber } from './helpers.js';

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
