/**
 * 单元测试：分组级保活开关持久化 + 新成员自动继承（schema v6，task-28）。
 * store 层继承语义 + 管理端 API（POST/PATCH groups keepaliveEnabled、分组 keepalive、PUT 用户分组继承）。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-groups-keepalive-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'groups-keepalive-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'groups-keepalive-password';
process.env.API_TOKEN = 'groups-keepalive-token';
process.env.ILINK_LOGIN_BASE_URL = 'http://127.0.0.1:9';
process.env.ILINK_BASE_URL = 'http://127.0.0.1:9';
process.env.LOG_LEVEL = 'silent';

const store = await import('../../server/src/store.js');
const { createApp } = await import('../../server/src/api.js');
const { closeDb } = await import('../../server/src/db.js');

let server;
let base = '';
let cookie = '';
const CSRF = { 'x-requested-with': 'ClawBridge-Admin' };

before(async () => {
  const { seedTestAdminSecrets } = await import('./backend-test-secrets.js');
  seedTestAdminSecrets();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'groups-keepalive-password' }),
  });
  assert.equal(login.status, 200);
  cookie = /cb_session=[^;]+/.exec(login.headers.get('set-cookie') || '')[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(method, pathName, { body, headers = {} } = {}) {
  const response = await fetch(base + pathName, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

const adminGet = (pathName) => request('GET', pathName, { headers: { cookie } });
const adminWrite = (method, pathName, body) => request(method, pathName, { body, headers: { cookie, ...CSRF } });

function assertError(result, status, code) {
  assert.equal(result.status, status, result.text);
  assert.equal(result.json?.error?.code, code, result.text);
}

let seq = 0;
function createUser() {
  seq += 1;
  return store.upsertBoundUser({
    wechatUserId: `wx_grp_ka_${seq}`,
    displayName: `分组保活用户${seq}`,
    ilinkBotId: `bot_grp_ka_${seq}@im.bot`,
    botToken: `grp-ka-token-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
}

// ---------------------------------------------------------------------------
// store 层
// ---------------------------------------------------------------------------
test('分组 CRUD：keepaliveEnabled 默认 false/可创建/可更新', () => {
  const plain = store.createGroup({ name: '普通分组' });
  assert.equal(plain.keepaliveEnabled, false);

  const enabled = store.createGroup({ name: '保活分组', keepaliveEnabled: true });
  assert.equal(enabled.keepaliveEnabled, true);
  assert.equal(store.getGroup(enabled.id).keepaliveEnabled, true);
  assert.equal(store.listGroups().find((group) => group.id === enabled.id).keepaliveEnabled, true);

  const toggled = store.updateGroup(enabled.id, { keepaliveEnabled: false });
  assert.equal(toggled.keepaliveEnabled, false);
  assert.equal(store.updateGroup(enabled.id, { keepaliveEnabled: true }).keepaliveEnabled, true);
  // 不传 keepaliveEnabled 保持不变
  assert.equal(store.updateGroup(enabled.id, { description: 'x' }).keepaliveEnabled, true);
  assert.equal(store.updateGroup('grp_missing', { keepaliveEnabled: true }), null);
});

test('setGroupKeepaliveEnabled：持久化分组 flag + 更新当前成员（含 unbound）+ 返回成员数', () => {
  const group = store.createGroup({ name: '批量保活分组' });
  const memberA = createUser();
  const memberB = createUser();
  const unbound = createUser();
  store.unbindUser(unbound.id);
  const outsider = createUser();
  for (const user of [memberA, memberB, unbound]) store.replaceUserGroups(user.id, [group.id]);

  assert.equal(store.setGroupKeepaliveEnabled(group.id, true), 3);
  assert.equal(store.getGroup(group.id).keepaliveEnabled, true);
  for (const user of [memberA, memberB, unbound]) {
    assert.equal(store.getUser(user.id).keepaliveEnabled, true);
  }
  assert.equal(store.getUser(outsider.id).keepaliveEnabled, false);

  assert.equal(store.setGroupKeepaliveEnabled(group.id, false), 3);
  assert.equal(store.getGroup(group.id).keepaliveEnabled, false);
  assert.equal(store.getUser(memberA.id).keepaliveEnabled, false);
  assert.equal(store.setGroupKeepaliveEnabled('grp_missing', true), 0);
});

test('replaceUserGroups 继承：加入已开启分组自动开启；加入未开启不变；移出不关闭；任一命中即开启', () => {
  const enabledGroup = store.createGroup({ name: '继承开启组', keepaliveEnabled: true });
  const disabledGroup = store.createGroup({ name: '继承关闭组' });
  const enabledGroup2 = store.createGroup({ name: '继承开启组2', keepaliveEnabled: true });

  // 加入已开启分组 → 自动开启
  const user = createUser();
  assert.equal(store.getUser(user.id).keepaliveEnabled, false);
  store.replaceUserGroups(user.id, [enabledGroup.id]);
  assert.equal(store.getUser(user.id).keepaliveEnabled, true, '加入已开启保活的分组应自动开启用户保活');

  // 再加入未开启分组 → 仍保持开启
  store.replaceUserGroups(user.id, [enabledGroup.id, disabledGroup.id]);
  assert.equal(store.getUser(user.id).keepaliveEnabled, true);

  // 移出开启分组（只剩未开启分组）→ 不关闭
  store.replaceUserGroups(user.id, [disabledGroup.id]);
  assert.equal(store.getUser(user.id).keepaliveEnabled, true, '移出分组不应关闭保活');

  // 全新用户只加入未开启分组 → 不变
  const user2 = createUser();
  store.replaceUserGroups(user2.id, [disabledGroup.id]);
  assert.equal(store.getUser(user2.id).keepaliveEnabled, false, '未开启保活的分组不应开启用户保活');

  // 已在未开启分组，新增一个已开启分组（差集中有开启）→ 开启
  store.replaceUserGroups(user2.id, [disabledGroup.id, enabledGroup2.id]);
  assert.equal(store.getUser(user2.id).keepaliveEnabled, true, '新增分组中任一开启即应开启');

  // 用户手动关闭后，仅保持原有成员关系不应被重新打开（差集为空）
  store.setKeepaliveEnabled(user2.id, false);
  store.replaceUserGroups(user2.id, [disabledGroup.id, enabledGroup2.id]);
  assert.equal(store.getUser(user2.id).keepaliveEnabled, false, '未新增分组时不应覆盖用户手动关闭');

  // 清空分组不关闭
  store.replaceUserGroups(user.id, []);
  assert.equal(store.getUser(user.id).keepaliveEnabled, true);
});

// ---------------------------------------------------------------------------
// 管理端 API
// ---------------------------------------------------------------------------
test('POST/PATCH groups：keepaliveEnabled 可选、非 boolean 400、响应/列表持久化', async () => {
  assertError(
    await adminWrite('POST', '/api/admin/groups', { name: '坏保活组', keepaliveEnabled: 'yes' }),
    400,
    'BAD_REQUEST',
  );
  assertError(
    await adminWrite('POST', '/api/admin/groups', { name: '坏保活组2', keepaliveEnabled: 1 }),
    400,
    'BAD_REQUEST',
  );

  const created = await adminWrite('POST', '/api/admin/groups', { name: 'API保活分组', keepaliveEnabled: true });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.group.keepaliveEnabled, true);

  const plain = await adminWrite('POST', '/api/admin/groups', { name: 'API普通分组' });
  assert.equal(plain.status, 201);
  assert.equal(plain.json.group.keepaliveEnabled, false);

  const patched = await adminWrite('PATCH', `/api/admin/groups/${created.json.group.id}`, { keepaliveEnabled: false });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.group.keepaliveEnabled, false);

  const onlyKeepalive = await adminWrite('PATCH', `/api/admin/groups/${created.json.group.id}`, { keepaliveEnabled: true });
  assert.equal(onlyKeepalive.status, 200, '仅传 keepaliveEnabled 也应允许更新');
  assert.equal(onlyKeepalive.json.group.keepaliveEnabled, true);

  assertError(
    await adminWrite('PATCH', `/api/admin/groups/${created.json.group.id}`, { keepaliveEnabled: 'true' }),
    400,
    'BAD_REQUEST',
  );

  const groups = await adminGet('/api/admin/groups');
  const listed = groups.json.items.find((group) => group.id === created.json.group.id);
  assert.equal(listed.keepaliveEnabled, true);
});

test('分组 keepalive 接口：持久化 flag + group 响应含 keepaliveEnabled + 新成员继承', async () => {
  const created = await adminWrite('POST', '/api/admin/groups', { name: '接口保活组' });
  const group = created.json.group;
  const memberA = createUser();
  const memberB = createUser();
  await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(memberA.id)}/groups`, { groupIds: [group.id] });

  const enabled = await adminWrite('POST', `/api/admin/groups/${group.id}/keepalive`, { enabled: true });
  assert.equal(enabled.status, 200, enabled.text);
  assert.equal(enabled.json.updated, 1);
  assert.equal(enabled.json.group.keepaliveEnabled, true);
  assert.equal(store.getUser(memberA.id).keepaliveEnabled, true);

  // 之后加入的新成员自动继承开启
  const joined = await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(memberB.id)}/groups`, { groupIds: [group.id] });
  assert.equal(joined.status, 200, joined.text);
  assert.equal(joined.json.user.keepaliveEnabled, true, '之后加入分组的新成员应自动开启保活');
  assert.equal(joined.json.inheritedKeepalive, true);
  assert.equal(store.getUser(memberB.id).keepaliveEnabled, true);

  // GET groups 返回持久化 flag
  const groups = await adminGet('/api/admin/groups');
  assert.equal(groups.json.items.find((item) => item.id === group.id).keepaliveEnabled, true);

  assertError(await adminWrite('POST', '/api/admin/groups/grp_missing/keepalive', { enabled: true }), 404, 'NOT_FOUND');
});

test('PUT 用户分组继承：user.keepaliveEnabled 反映继承、inheritedKeepalive、关闭后新成员不开启、移出不关闭', async () => {
  const enabledGroup = (await adminWrite('POST', '/api/admin/groups', { name: 'API继承开启组', keepaliveEnabled: true })).json.group;
  const disabledGroup = (await adminWrite('POST', '/api/admin/groups', { name: 'API继承关闭组' })).json.group;

  const user = createUser();
  const joinEnabled = await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(user.id)}/groups`, {
    groupIds: [enabledGroup.id],
  });
  assert.equal(joinEnabled.status, 200);
  assert.equal(joinEnabled.json.user.keepaliveEnabled, true);
  assert.equal(joinEnabled.json.inheritedKeepalive, true);

  // 加入未开启分组：user 仍保持开启（继承不回退）
  const joinDisabled = await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(user.id)}/groups`, {
    groupIds: [enabledGroup.id, disabledGroup.id],
  });
  assert.equal(joinDisabled.json.user.keepaliveEnabled, true);

  // 移出开启分组：不关闭
  const leaveEnabled = await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(user.id)}/groups`, {
    groupIds: [disabledGroup.id],
  });
  assert.equal(leaveEnabled.json.user.keepaliveEnabled, true, '移出分组不应关闭保活');
  assert.equal(leaveEnabled.json.inheritedKeepalive, false, '当前不在开启保活的分组中');

  // 分组关闭后，之后加入的新成员不自动开启
  const offGroup = (await adminWrite('POST', '/api/admin/groups', { name: 'API关闭后组', keepaliveEnabled: true })).json.group;
  await adminWrite('POST', `/api/admin/groups/${offGroup.id}/keepalive`, { enabled: false });
  const newUser = createUser();
  const joinOff = await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(newUser.id)}/groups`, {
    groupIds: [offGroup.id],
  });
  assert.equal(joinOff.json.user.keepaliveEnabled, false, '分组关闭保活后新成员不应自动开启');
  assert.equal(joinOff.json.inheritedKeepalive, false);
});
