/**
 * groups / user_groups 域：分组 CRUD、成员查询、用户分组全量替换与保活继承。
 *
 * 从 store.js 按域拆分（纯搬迁）。
 */
import { all, get, nowMs, run, transaction } from '../db.js';

import { newGroupId, toNumber } from './helpers.js';
import { mapGroupRow } from './mappers.js';

// ---------------------------------------------------------------------------
// groups / user_groups（schema v3：用户分组，docs/GROUPS_AND_INBOUND.md §1/§2）
// ---------------------------------------------------------------------------

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
