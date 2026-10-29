/**
 * e2e：分组级保活开关与成员自动继承（docs/KEEPALIVE.md §4 / docs/API.md §6，schema v6）。
 *
 * 契约：
 *  - GroupView.keepaliveEnabled；“创建/更新分组支持可选 keepaliveEnabled”（非 boolean → 400）；
 *  - POST /api/admin/groups/{id}/keepalive {enabled} 持久化分组标志 + 批量设置当前成员；
 *  - keepaliveEnabled=true 的分组，之后通过 PUT /users/{id}/groups 加入的用户自动开启保活；
 *  - 移出分组不会关闭用户保活；分组关闭保活时当前成员被关闭，之后加入的成员保持关闭。
 *
 * 覆盖：
 *  - 创建分组带 keepaliveEnabled=true → 列表/GroupView 返回 true，新成员加入自动开启；
 *  - 已有分组先批量开启 → 当前成员开启、之后加入成员继承开启；
 *  - 关闭状态分组新成员不误开（false 与默认值两种）；
 *  - 用户移出开启组 → 保持开启（不因移出关闭）；
 *  - 分组批量关闭 → 当前成员关闭、之后加入保持关闭；
 *  - 校验（keepaliveEnabled 非 boolean → 400）与鉴权（401/403）、不存在分组 404。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { sleep, startE2E, waitFor } from '../helpers/e2e-env.mjs';

let e2e;
let user1;
let user2;
let user3;
let user4;
let user5;
let user6;
let user7;
let groupSeq = 0;
const nextName = (prefix) => `${prefix}-${(groupSeq += 1)}`;

async function createGroupOrFail(body) {
  const res = await e2e.createGroup(body);
  assert.equal(res.status, 201, `创建分组应 201，实际 ${res.status}：${res.text}`);
  assert.ok(res.json?.group?.id?.startsWith('grp_'), `GroupView.id 应为 grp_ 前缀：${res.text}`);
  return res.json.group;
}

async function userKeepaliveFlag(userId) {
  const res = await e2e.getUser(userId);
  assert.equal(res.status, 200, `用户详情查询失败：${res.status} ${res.text}`);
  return Boolean(res.json.user?.keepaliveEnabled);
}

before(async () => {
  e2e = await startE2E({ appEnv: { KEEPALIVE_ENABLED: '1' } });
  await e2e.ensureAdmin();
  const bound = [];
  for (let i = 1; i <= 7; i += 1) {
    bound.push(await e2e.bindUser({ displayName: `分组保活用户${i}` }));
  }
  [user1, user2, user3, user4, user5, user6, user7] = bound.map((item) => item.user);
});

after(async () => {
  await e2e?.cleanup();
});

test('创建分组 keepaliveEnabled=true：GroupView 返回 true，新成员加入自动开启保活', async () => {
  const group = await createGroupOrFail({
    name: nextName('继承开启组'),
    description: '创建即开启',
    color: '#07C160',
    keepaliveEnabled: true,
  });
  assert.equal(group.keepaliveEnabled, true, '创建响应的 GroupView.keepaliveEnabled 应为 true');

  // 分组列表与对外 v1 分组列表均返回 true
  const listed = await e2e.findGroup(group.id);
  assert.ok(listed);
  assert.equal(listed.keepaliveEnabled, true);
  const v1Groups = await e2e.getV1Groups();
  assert.equal(v1Groups.status, 200);
  const v1Group = (v1Groups.json.items ?? []).find((item) => item.id === group.id);
  assert.ok(v1Group, 'v1 分组列表应包含该分组');
  // docs/GROUPS_AND_INBOUND.md §4.1 的 v1 分组项字段未含 keepaliveEnabled；若实现提供则必须为 true
  if (v1Group.keepaliveEnabled !== undefined) assert.equal(v1Group.keepaliveEnabled, true);

  // 用户1 初始未开启；加入开启保活的分组后自动开启
  assert.equal(await userKeepaliveFlag(user1.id), false, '用户1 初始应未开启保活');
  const assigned = await e2e.setUserGroups(user1.id, [group.id]);
  assert.equal(assigned.status, 200, `PUT 用户分组失败：${assigned.status} ${assigned.text}`);
  const user1After = await e2e.waitUserKeepalive(user1.id, true, { label: '用户1 加入开启保活分组后自动开启' });
  assert.equal(user1After.keepaliveEnabled, true);

  // 再加入一个此前未开启的用户，同样继承
  assert.equal(await userKeepaliveFlag(user2.id), false);
  await e2e.setUserGroups(user2.id, [group.id]);
  const user2After = await e2e.waitUserKeepalive(user2.id, true, { label: '用户2 加入开启保活分组后自动开启' });
  assert.equal(user2After.keepaliveEnabled, true);
});

test('已有分组先批量开启保活：当前成员开启，之后加入的成员继承开启', async () => {
  const group = await createGroupOrFail({ name: nextName('后开启组') });
  assert.equal(group.keepaliveEnabled, false, '新建分组默认 keepaliveEnabled=false');

  // 用户3 先加入（此时分组未开保活 → 不开启）
  await e2e.setUserGroups(user3.id, [group.id]);
  assert.equal(await userKeepaliveFlag(user3.id), false, '分组未开保活时加入不应开启用户保活');

  // 批量开启：持久化分组标志 + 当前成员开启
  const enabled = await e2e.setGroupKeepalive(group.id, true);
  assert.equal(enabled.status, 200, `分组批量开启保活失败：${enabled.status} ${enabled.text}`);
  assert.equal(enabled.json.group?.id, group.id);
  assert.equal(enabled.json.group?.keepaliveEnabled, true, '批量开启后 GroupView.keepaliveEnabled 应为 true');
  assert.ok(Number(enabled.json.updated) >= 1, `批量开启应更新当前成员，updated=${enabled.json.updated}`);
  await e2e.waitUserKeepalive(user3.id, true, { label: '批量开启后当前成员保活被开启' });

  // 之后加入的用户7 继承开启
  assert.equal(await userKeepaliveFlag(user7.id), false);
  await e2e.setUserGroups(user7.id, [group.id]);
  await e2e.waitUserKeepalive(user7.id, true, { label: '之后加入成员继承开启' });
  const groupView = await e2e.findGroup(group.id);
  assert.equal(groupView.keepaliveEnabled, true);
});

test('关闭保活状态的分组：新成员不会误开保活（false 与默认值）', async () => {
  const closedGroup = await createGroupOrFail({ name: nextName('关闭保活组'), keepaliveEnabled: false });
  assert.equal(closedGroup.keepaliveEnabled, false);
  const defaultGroup = await createGroupOrFail({ name: nextName('默认分组') });
  assert.equal(defaultGroup.keepaliveEnabled, false, '未传 keepaliveEnabled 时默认应为 false');

  assert.equal(await userKeepaliveFlag(user4.id), false, '用户4 初始应未开启保活');
  const assigned = await e2e.setUserGroups(user4.id, [closedGroup.id, defaultGroup.id]);
  assert.equal(assigned.status, 200);
  assert.equal(await userKeepaliveFlag(user4.id), false, '加入关闭保活的分组不应开启用户保活');
  await sleep(200);
  assert.equal(await userKeepaliveFlag(user4.id), false, '加入关闭保活分组后保持 false');
  // 分组视图保持 false
  assert.equal((await e2e.findGroup(closedGroup.id)).keepaliveEnabled, false);
  assert.equal((await e2e.findGroup(defaultGroup.id)).keepaliveEnabled, false);
});

test('用户移出开启保活的分组：保活保持开启（不因移出而关闭）', async () => {
  const enabledGroup = await createGroupOrFail({ name: nextName('移出测试组'), keepaliveEnabled: true });
  const closedGroup = await createGroupOrFail({ name: nextName('移出目标关闭组'), keepaliveEnabled: false });

  assert.equal(await userKeepaliveFlag(user5.id), false);
  await e2e.setUserGroups(user5.id, [enabledGroup.id]);
  await e2e.waitUserKeepalive(user5.id, true, { label: '用户5 加入开启组后开启' });

  // 移出（清空分组）→ 保持开启
  await e2e.setUserGroups(user5.id, []);
  assert.equal(await userKeepaliveFlag(user5.id), true, '移出开启保活分组后用户保活应保持开启');

  // 转移到另一个关闭保活的分组 → 仍保持开启
  await e2e.setUserGroups(user5.id, [closedGroup.id]);
  assert.equal(await userKeepaliveFlag(user5.id), true, '移出后加入关闭保活分组不应关闭用户保活');
});

test('分组批量关闭保活：当前成员关闭，之后加入的成员保持关闭', async () => {
  const enabledGroup = await createGroupOrFail({ name: nextName('批量关闭组'), keepaliveEnabled: true });
  assert.equal(await userKeepaliveFlag(user6.id), false);
  await e2e.setUserGroups(user6.id, [enabledGroup.id]);
  await e2e.waitUserKeepalive(user6.id, true, { label: '用户6 加入开启组后开启' });

  // 批量关闭
  const disabled = await e2e.setGroupKeepalive(enabledGroup.id, false);
  assert.equal(disabled.status, 200, `分组批量关闭保活失败：${disabled.status} ${disabled.text}`);
  assert.equal(disabled.json.group?.keepaliveEnabled, false, '批量关闭后 GroupView.keepaliveEnabled 应为 false');
  assert.ok(Number(disabled.json.updated) >= 1);
  await e2e.waitUserKeepalive(user6.id, false, { label: '批量关闭后当前成员保活被关闭' });
  assert.equal((await e2e.findGroup(enabledGroup.id)).keepaliveEnabled, false);

  // 之后加入的用户4（当前 false，且属于其他关闭组）→ 保持关闭
  assert.equal(await userKeepaliveFlag(user4.id), false);
  const groupsBefore = await e2e.getUser(user4.id);
  const existingGroupIds = (groupsBefore.json.user.groups ?? []).map((item) => item.id);
  await e2e.setUserGroups(user4.id, [...existingGroupIds, enabledGroup.id]);
  assert.equal(await userKeepaliveFlag(user4.id), false, '分组关闭保活后新加入成员应保持关闭');
});

test('校验与鉴权：keepaliveEnabled 非 boolean → 400，未登录 401/缺 CSRF 403，不存在分组 404', async () => {
  await e2e.ensureAdmin();

  // PATCH 分组支持 keepaliveEnabled（默认 false → true → false），与批量接口一致同步当前成员
  const group = await createGroupOrFail({ name: nextName('校验分组') });
  assert.equal(group.keepaliveEnabled, false);
  const user4Before = await e2e.getUser(user4.id);
  const user4GroupIds = (user4Before.json.user.groups ?? []).map((item) => item.id);
  await e2e.setUserGroups(user4.id, [...user4GroupIds, group.id]);
  assert.equal(await userKeepaliveFlag(user4.id), false, '加入关闭保活的新分组后用户应保持关闭');
  const patchedOn = await e2e.updateGroup(group.id, { keepaliveEnabled: true });
  assert.equal(patchedOn.status, 200, `PATCH keepaliveEnabled=true 应 200：${patchedOn.status} ${patchedOn.text}`);
  assert.equal(patchedOn.json.group.keepaliveEnabled, true);
  await e2e.waitUserKeepalive(user4.id, true, { label: 'PATCH 开启分组保活后当前成员应同步开启' });
  const patchedOff = await e2e.updateGroup(group.id, { keepaliveEnabled: false });
  assert.equal(patchedOff.status, 200);
  assert.equal(patchedOff.json.group.keepaliveEnabled, false);
  await e2e.waitUserKeepalive(user4.id, false, { label: 'PATCH 关闭分组保活后当前成员应同步关闭' });

  // 非 boolean → 400
  const invalidCases = [
    () => e2e.createGroup({ name: nextName('非法'), keepaliveEnabled: 'yes' }),
    () => e2e.createGroup({ name: nextName('非法'), keepaliveEnabled: 1 }),
    () => e2e.updateGroup(group.id, { keepaliveEnabled: 'true' }),
    () => e2e.setGroupKeepalive(group.id, 'yes'),
    () => e2e.adminWrite('POST', `/api/admin/groups/${group.id}/keepalive`, {}),
  ];
  for (const call of invalidCases) {
    const res = await call();
    assert.equal(res.status, 400, `非法 keepaliveEnabled 应 400：${res.status} ${res.text}`);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
  }

  // 鉴权：未登录 401、缺 CSRF 403
  const noAuthCreate = await e2e.request('POST', '/api/admin/groups', {
    body: { name: nextName('未登录'), keepaliveEnabled: true },
  });
  assert.equal(noAuthCreate.status, 401, `未登录创建分组应 401：${noAuthCreate.status} ${noAuthCreate.text}`);
  const noCsrfPatch = await e2e.adminRequest('PATCH', `/api/admin/groups/${group.id}`, {
    body: { keepaliveEnabled: true },
  });
  assert.equal(noCsrfPatch.status, 403, `缺 CSRF 头更新分组应 403：${noCsrfPatch.status} ${noCsrfPatch.text}`);
  const noAuthToggle = await e2e.request('POST', `/api/admin/groups/${group.id}/keepalive`, {
    body: { enabled: true },
  });
  assert.equal(noAuthToggle.status, 401, '未登录分组保活开关应 401');
  const noAuthAssign = await e2e.request('PUT', `/api/admin/users/${user1.id}/groups`, {
    body: { groupIds: [] },
  });
  assert.equal(noAuthAssign.status, 401, '未登录设置用户分组应 401');

  // 不存在分组 → 404
  const missing = await e2e.setGroupKeepalive('grp_not_exists_e2e', true);
  assert.equal(missing.status, 404, `不存在分组批量开启保活应 404：${missing.status} ${missing.text}`);
  assert.equal(missing.json.error.code, 'NOT_FOUND');
});
