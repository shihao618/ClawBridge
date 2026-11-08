/**
 * settings 子模块内部依赖：app_settings UPSERT 与 settings_update 事件。
 *
 * 由 apply.js 与 secrets.js 共用；仅作为内部模块，不通过 settings.js façade 对外导出。
 */
import { nowMs, run } from '../db.js';
import * as store from '../store.js';

// ---------------------------------------------------------------------------
// 内部工具：UPSERT / 事件
// ---------------------------------------------------------------------------
export function upsertSetting(key, jsonValue, ts = nowMs()) {
  run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    jsonValue,
    ts,
  );
}

export function addSettingsEvent(detail) {
  store.addEvent({ type: 'settings_update', detail: JSON.stringify(detail) });
}
