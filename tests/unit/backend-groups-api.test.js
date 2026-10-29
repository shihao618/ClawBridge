/**
 * 单元测试：api.js 用户分组 + 入站消息 API（docs/GROUPS_AND_INBOUND.md §3/§4）。
 * 进程内启动真实 Express 应用（临时 DATA_DIR，无网络）。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-groups-api-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'groups-api-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'groups-api-admin-password';
process.env.API_TOKEN = 'groups-api-token-123456';
process.env.ILINK_LOGIN_BASE_URL = 'http://127.0.0.1:9';
process.env.ILINK_BASE_URL = 'http://127.0.0.1:9';
process.env.LOG_LEVEL = 'silent';

const { createApp } = await import('../../server/src/api.js');
const store = await import('../../server/src/store.js');
const { getDb, closeDb } = await import('../../server/src/db.js');

let server;
let base = '';
let cookie = '';
const CSRF = { 'x-requested-with': 'ClawBridge-Admin' };
const API_HEADERS = { 'x-api-key': 'groups-api-token-123456' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  const { seedTestAdminSecrets } = await import('./backend-test-secrets.js');
  seedTestAdminSecrets();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'groups-api-admin-password' }),
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
  return { status: response.status, headers: response.headers, text, json };
}

const adminGet = (pathName) => request('GET', pathName, { headers: { cookie } });
const adminWrite = (method, pathName, body) =>
  request(method, pathName, { body, headers: { cookie, ...CSRF } });
const v1Get = (pathName, headers = {}) => request('GET', pathName, { headers: { ...API_HEADERS, ...headers } });
const v1Write = (method, pathName, body) =>
  request(method, pathName, { body, headers: { ...API_HEADERS, 'content-type': 'application/json' } });

let seq = 0;
function createUser(overrides = {}) {
  seq += 1;
  return store.upsertBoundUser({
    wechatUserId: overrides.wechatUserId ?? `wx_groups_api_${seq}`,
    displayName: overrides.displayName ?? `分组API用户${seq}`,
    ilinkBotId: `bot_groups_api_${seq}@im.bot`,
    botToken: `groups-api-token-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
}

function createInbound({ userId, text, receivedAt, msgId }) {
  return store.saveInbound({
    userId,
    wechatMessageId: msgId,
    fromUserId: 'wx_groups_api_sender',
    text,
    itemTypes: '1',
    receivedAt,
    createdAt: receivedAt,
  });
}

function assertError(result, status, code) {
  assert.equal(result.status, status, result.text);
  assert.equal(result.json?.error?.code, code, result.text);
}

// ---------------------------------------------------------------------------
// 管理端：分组 CRUD
// ---------------------------------------------------------------------------
test('管理端分组 CRUD：校验 / 重名 409 / 更新 / 删除级联', async () => {
  // 鉴权
  assertError(await request('GET', '/api/admin/groups'), 401, 'UNAUTHORIZED');
  assertError(await request('GET', '/api/v1/groups'), 401, 'UNAUTHORIZED');

  const list0 = await adminGet('/api/admin/groups');
  assert.equal(list0.status, 200);
  assert.ok(Array.isArray(list0.json.items));
  const initialCount = list0.json.items.length;

  // 参数校验
  assertError(await adminWrite('POST', '/api/admin/groups', {}), 400, 'BAD_REQUEST');
  assertError(await adminWrite('POST', '/api/admin/groups', { name: 'x'.repeat(41) }), 400, 'BAD_REQUEST');
  assertError(
    await adminWrite('POST', '/api/admin/groups', { name: '颜色非法', color: 'red' }),
    400,
    'BAD_REQUEST',
  );
  assertError(
    await adminWrite('POST', '/api/admin/groups', { name: '描述超长', description: 'x'.repeat(201) }),
    400,
    'BAD_REQUEST',
  );
  // 写接口需要 CSRF 头
  assertError(
    await request('POST', '/api/admin/groups', { body: { name: 'no-csrf' }, headers: { cookie } }),
    403,
    'FORBIDDEN',
  );

  const create = await adminWrite('POST', '/api/admin/groups', {
    name: 'VIP客户',
    description: '重点客户',
    color: '#07C160',
  });
  assert.equal(create.status, 201, create.text);
  const group = create.json.group;
  assert.match(group.id, /^grp_/);
  assert.equal(group.name, 'VIP客户');
  assert.equal(group.description, '重点客户');
  assert.equal(group.color, '#07C160');
  assert.equal(group.userCount, 0);
  assert.equal(group.activeUserCount, 0);

  // 重名 → 409
  assertError(await adminWrite('POST', '/api/admin/groups', { name: 'VIP客户' }), 409, 'CONFLICT');

  const list1 = await adminGet('/api/admin/groups');
  assert.equal(list1.json.items.length, initialCount + 1);

  // PATCH
  assertError(await adminWrite('PATCH', `/api/admin/groups/${group.id}`, {}), 400, 'BAD_REQUEST');
  assertError(
    await adminWrite('PATCH', `/api/admin/groups/${group.id}`, { color: '#12' }),
    400,
    'BAD_REQUEST',
  );
  assertError(await adminWrite('PATCH', '/api/admin/groups/grp_missing', { name: 'x' }), 404, 'NOT_FOUND');
  const patched = await adminWrite('PATCH', `/api/admin/groups/${group.id}`, {
    name: 'VIP客户2',
    description: '更新后的描述',
    color: '#FF0000',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.group.name, 'VIP客户2');
  assert.equal(patched.json.group.color, '#FF0000');

  // 重名（PATCH 另一个分组改为已存在名称）→ 409
  const other = await adminWrite('POST', '/api/admin/groups', { name: '普通组' });
  assertError(
    await adminWrite('PATCH', `/api/admin/groups/${other.json.group.id}`, { name: 'VIP客户2' }),
    409,
    'CONFLICT',
  );

  // 删除级联：用户归属被清理，用户本身保留
  const user = createUser();
  const assign = await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(user.id)}/groups`, {
    groupIds: [group.id, other.json.group.id],
  });
  assert.equal(assign.status, 200, assign.text);
  assert.equal(assign.json.user.groups.length, 2);
  const deleted = await adminWrite('DELETE', `/api/admin/groups/${group.id}`);
  assert.equal(deleted.status, 204);
  assertError(await adminWrite('DELETE', '/api/admin/groups/grp_missing'), 404, 'NOT_FOUND');
  const detail = await adminGet(`/api/admin/users/${encodeURIComponent(user.id)}`);
  assert.equal(detail.json.user.groups.length, 1, '删除分组后用户归属应级联清理');
  assert.equal(detail.json.user.groups[0].id, other.json.group.id);
});

// ---------------------------------------------------------------------------
// 管理端：用户分组归属 / 筛选
// ---------------------------------------------------------------------------
test('PUT 用户分组：未知分组 400、去重全量替换、用户列表/详情带 groups 与 groupId 过滤', async () => {
  const user = createUser({ displayName: '归属用户' });
  const g1 = (await adminWrite('POST', '/api/admin/groups', { name: '归属组1', color: '#010101' })).json.group;
  const g2 = (await adminWrite('POST', '/api/admin/groups', { name: '归属组2', color: '#020202' })).json.group;

  assertError(
    await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(user.id)}/groups`, { groupIds: 'x' }),
    400,
    'BAD_REQUEST',
  );
  const unknown = await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(user.id)}/groups`, {
    groupIds: [g1.id, 'grp_missing'],
  });
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.json.error.details.unknownGroupIds, ['grp_missing']);
  assertError(
    await adminWrite('PUT', '/api/admin/users/u_missing/groups', { groupIds: [] }),
    404,
    'NOT_FOUND',
  );

  const assigned = await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(user.id)}/groups`, {
    groupIds: [g2.id, g1.id, g2.id],
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.json.user.groups.length, 2, '应去重');
  const groupNames = assigned.json.user.groups.map((group) => group.name);
  assert.deepEqual([...groupNames].sort(), ['归属组1', '归属组2']);

  // 列表 groupId 过滤
  const filtered = await adminGet(`/api/admin/users?status=all&groupId=${encodeURIComponent(g1.id)}`);
  assert.equal(filtered.status, 200);
  assert.ok(filtered.json.items.some((item) => item.id === user.id));
  assert.ok(filtered.json.items.every((item) => item.groups.some((group) => group.id === g1.id)));
  const empty = await adminGet('/api/admin/users?status=all&groupId=grp_missing');
  assert.equal(empty.json.total, 0);

  // 清空
  const cleared = await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(user.id)}/groups`, {
    groupIds: [],
  });
  assert.deepEqual(cleared.json.user.groups, []);
});

test('管理端消息列表 groupId 过滤（入站/出站）', async () => {
  const group = (await adminWrite('POST', '/api/admin/groups', { name: '消息过滤组' })).json.group;
  const member = createUser({ displayName: '消息组内' });
  const outsider = createUser({ displayName: '消息组外' });
  await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(member.id)}/groups`, { groupIds: [group.id] });

  createInbound({ userId: member.id, text: '组内入站消息', receivedAt: 1111, msgId: 'grp_api_in_member' });
  createInbound({ userId: outsider.id, text: '组外入站消息', receivedAt: 1112, msgId: 'grp_api_in_outsider' });
  store.enqueueMessage({ userId: member.id, text: '组内出站消息', source: 'admin' });
  store.enqueueMessage({ userId: outsider.id, text: '组外出站消息', source: 'admin' });

  const all = await adminGet(`/api/admin/messages?groupId=${encodeURIComponent(group.id)}&limit=100`);
  assert.equal(all.status, 200);
  assert.ok(all.json.items.length >= 2);
  assert.ok(all.json.items.every((item) => item.text.includes('组内')));
  const inboundOnly = await adminGet(
    `/api/admin/messages?direction=inbound&groupId=${encodeURIComponent(group.id)}&limit=100`,
  );
  assert.equal(inboundOnly.json.items.length, 1);
  assert.equal(inboundOnly.json.items[0].text, '组内入站消息');
});

// ---------------------------------------------------------------------------
// 管理端 / v1：分组群发
// ---------------------------------------------------------------------------
test('分组群发：目标=active 且未冷却；无目标 count=0；文本/媒体校验', async () => {
  const group = (await adminWrite('POST', '/api/admin/groups', { name: '群发组' })).json.group;
  const active1 = createUser({ displayName: '群发用户1' });
  const active2 = createUser({ displayName: '群发用户2' });
  const paused = createUser({ displayName: '群发冷却用户' });
  const unbound = createUser({ displayName: '群发解绑用户' });
  store.setUserPaused(paused.id, Date.now() + 3600_000, 'stale');
  store.unbindUser(unbound.id);
  for (const user of [active1, active2, paused, unbound]) {
    await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(user.id)}/groups`, { groupIds: [group.id] });
  }
  // 群发组当前还有别的测试用户？本组是新建的，只有这几个

  assertError(await adminWrite('POST', `/api/admin/groups/${group.id}/messages`, {}), 400, 'BAD_REQUEST');
  assertError(await adminWrite('POST', '/api/admin/groups/grp_missing/messages', { text: 'x' }), 404, 'NOT_FOUND');

  const sent = await adminWrite('POST', `/api/admin/groups/${group.id}/messages`, { text: '分组文本群发' });
  assert.equal(sent.status, 202, sent.text);
  assert.equal(sent.json.count, 2, '只发给 2 个 active 未冷却用户');
  assert.equal(sent.json.queued.length, 2);
  const targetIds = sent.json.queued.map((item) => item.userId).sort();
  assert.deepEqual(targetIds, [active1.id, active2.id].sort());
  const outbox = store.getOutbox(sent.json.queued[0].outboxId);
  assert.equal(outbox.source, 'group');
  assert.equal(outbox.text, '分组文本群发');

  // 带媒体
  const attachment = store.createAttachment({
    direction: 'outbound',
    kind: 'image',
    mime: 'image/png',
    fileName: 'g.png',
    size: 3,
    path: 'outbound/g.png',
    sha256: 'x',
    status: 'ready',
  });
  const sentMedia = await adminWrite('POST', `/api/admin/groups/${group.id}/messages`, {
    text: '媒体群发',
    mediaId: attachment.id,
  });
  assert.equal(sentMedia.status, 202);
  assert.equal(sentMedia.json.count, 2);
  assert.equal(sentMedia.json.queued[0].media.id, attachment.id);

  // 无目标分组 → 202 count 0
  const emptyGroup = (await adminWrite('POST', '/api/admin/groups', { name: '空群发组' })).json.group;
  const emptySend = await adminWrite('POST', `/api/admin/groups/${emptyGroup.id}/messages`, { text: '无人接收' });
  assert.equal(emptySend.status, 202);
  assert.equal(emptySend.json.count, 0);
  assert.deepEqual(emptySend.json.queued, []);

  // v1 分组发送
  const v1Sent = await v1Write('POST', `/api/v1/groups/${group.id}/messages`, { text: 'v1 分组群发' });
  assert.equal(v1Sent.status, 202, v1Sent.text);
  assert.equal(v1Sent.json.accepted, 2);
  assert.equal(v1Sent.json.queued.length, 2);
  assertError(await v1Write('POST', '/api/v1/groups/grp_missing/messages', { text: 'x' }), 404, 'NOT_FOUND');
  assertError(await v1Write('POST', `/api/v1/groups/${group.id}/messages`, {}), 400, 'BAD_REQUEST');

  // v1 分组列表
  const groups = await v1Get('/api/v1/groups');
  assert.equal(groups.status, 200);
  const v1Group = groups.json.items.find((item) => item.id === group.id);
  assert.ok(v1Group);
  assert.equal(v1Group.userCount, 4);
  assert.equal(v1Group.activeUserCount, 3, 'activeUserCount 含冷却用户，不含 unbound');
});

// ---------------------------------------------------------------------------
// v1 入站消息 API
// ---------------------------------------------------------------------------
test('v1 入站消息：鉴权/参数校验/ASC/cursor 增量/since/过滤/附件 URL', async () => {
  // 鉴权
  assertError(await request('GET', '/api/v1/inbound/messages'), 401, 'UNAUTHORIZED');
  assertError(await request('GET', '/api/v1/inbound/messages', { headers: { 'x-api-key': 'bad' } }), 401, 'UNAUTHORIZED');

  // 参数校验
  for (const badQuery of [
    'limit=0',
    'limit=201',
    'limit=abc',
    'wait=-1',
    'wait=31',
    'wait=abc',
    'since=abc',
    'cursor=not-a-cursor',
  ]) {
    const bad = await v1Get(`/api/v1/inbound/messages?${badQuery}`);
    assertError(bad, 400, 'BAD_REQUEST');
  }

  const user = createUser({ displayName: '入站API用户' });
  const group = (await adminWrite('POST', '/api/admin/groups', { name: '入站API组', color: '#00FF00' })).json.group;
  await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(user.id)}/groups`, { groupIds: [group.id] });
  const outsider = createUser({ displayName: '入站API组外' });

  const inboundRows = [];
  for (let i = 0; i < 3; i += 1) {
    createInbound({
      userId: user.id,
      text: `API入站-${i}`,
      receivedAt: 5000 + i,
      msgId: `api_inbound_query_${i}`,
    });
  }
  // 通过 listInbound 找到 id 关联附件
  const stored = store.listInbound({ userId: user.id, limit: 10 }).items;
  const storedByText = new Map(stored.map((item) => [item.text, item]));
  const target = storedByText.get('API入站-1');
  store.createAttachment({
    direction: 'inbound',
    kind: 'file',
    mime: 'application/pdf',
    fileName: 'report.pdf',
    size: 9,
    path: 'inbound/report.pdf',
    sha256: 'x',
    userId: user.id,
    inboundMessageId: target.id,
    wechatMessageId: 'api_inbound_query_1',
    status: 'ready',
  });
  createInbound({ userId: outsider.id, text: '组外入站', receivedAt: 5001, msgId: 'api_inbound_outsider' });

  // 首次拉取（userId 过滤，避免其他用例残留数据干扰）
  const first = await v1Get(`/api/v1/inbound/messages?limit=2&userId=${encodeURIComponent(user.id)}`);
  assert.equal(first.status, 200, first.text);
  assert.equal(typeof first.json.serverTime, 'number');
  assert.equal(first.json.items.length, 2);
  assert.equal(first.json.hasMore, true);
  assert.deepEqual(
    first.json.items.map((item) => item.text),
    ['API入站-0', 'API入站-1'],
    'ASC by received_at',
  );
  const item0 = first.json.items[0];
  assert.equal(item0.userId, user.id);
  assert.equal(item0.displayName, '入站API用户');
  assert.deepEqual(item0.groups, [{ id: group.id, name: '入站API组', color: '#00FF00' }]);
  assert.equal(item0.itemTypes, '1');
  assert.equal(typeof item0.createdAt, 'number');
  assert.equal(typeof item0.receivedAt, 'number');
  const item1 = first.json.items[1];
  assert.equal(item1.attachments.length, 1);
  assert.equal(item1.attachments[0].url, `/api/v1/media/${item1.attachments[0].id}`);
  assert.equal(item1.attachments[0].downloadUrl, `/api/v1/media/${item1.attachments[0].id}?download=1`);
  assert.ok(first.json.nextCursor);

  // cursor 增量：第二页
  const second = await v1Get(
    `/api/v1/inbound/messages?limit=2&userId=${encodeURIComponent(user.id)}&cursor=${encodeURIComponent(first.json.nextCursor)}`,
  );
  assert.equal(second.status, 200);
  assert.deepEqual(second.json.items.map((item) => item.text), ['API入站-2']);
  assert.equal(second.json.hasMore, false);
  assert.ok(second.json.nextCursor);

  // 再次用 cursor → 无新数据
  const third = await v1Get(
    `/api/v1/inbound/messages?userId=${encodeURIComponent(user.id)}&cursor=${encodeURIComponent(second.json.nextCursor)}`,
  );
  assert.deepEqual(third.json.items, []);
  assert.equal(third.json.nextCursor, second.json.nextCursor, '无数据时应回传传入 cursor');
  assert.equal(third.json.hasMore, false);

  // since 独占
  const sinceResult = await v1Get(`/api/v1/inbound/messages?userId=${encodeURIComponent(user.id)}&since=5001`);
  assert.deepEqual(sinceResult.json.items.map((item) => item.text), ['API入站-2']);

  // userId / groupId 过滤
  const byUser = await v1Get(`/api/v1/inbound/messages?userId=${encodeURIComponent(outsider.id)}`);
  assert.deepEqual(byUser.json.items.map((item) => item.text), ['组外入站']);
  const byGroup = await v1Get(`/api/v1/inbound/messages?groupId=${encodeURIComponent(group.id)}&limit=100`);
  assert.ok(byGroup.json.items.length >= 3);
  assert.ok(byGroup.json.items.every((item) => item.userId === user.id));

  // limit 边界：200 合法
  assert.equal((await v1Get('/api/v1/inbound/messages?limit=200')).status, 200);
});

test('v1 入站消息 wait 长轮询：无新消息等待/超时返回空；有新消息立即返回', async () => {
  const user = createUser({ displayName: 'wait用户' });
  const existing = createInbound({ userId: user.id, text: 'wait-基线', receivedAt: 8000, msgId: 'wait_in_0' });
  assert.ok(existing.inserted);

  const baseline = await v1Get(`/api/v1/inbound/messages?userId=${encodeURIComponent(user.id)}`);
  assert.equal(baseline.json.items.length, 1);
  const cursor = baseline.json.nextCursor;

  // 1) wait 期间无新消息 → 超时返回空 + 回传 cursor；等待约 0.6s
  const started = Date.now();
  const timeoutResult = await v1Get(
    `/api/v1/inbound/messages?userId=${encodeURIComponent(user.id)}&cursor=${encodeURIComponent(cursor)}&wait=0.6`,
  );
  const elapsed = Date.now() - started;
  assert.equal(timeoutResult.status, 200);
  assert.deepEqual(timeoutResult.json.items, []);
  assert.equal(timeoutResult.json.nextCursor, cursor);
  assert.ok(elapsed >= 450 && elapsed <= 2500, `wait 超时耗时应约 600ms，实际 ${elapsed}ms`);

  // 2) wait 期间插入新消息 → 立即返回该消息
  const waitStarted = Date.now();
  const waitPromise = v1Get(
    `/api/v1/inbound/messages?userId=${encodeURIComponent(user.id)}&cursor=${encodeURIComponent(cursor)}&wait=5`,
  );
  await sleep(250);
  createInbound({ userId: user.id, text: 'wait-新消息', receivedAt: 8001, msgId: 'wait_in_1' });
  const waitResult = await waitPromise;
  assert.equal(waitResult.status, 200);
  assert.deepEqual(waitResult.json.items.map((item) => item.text), ['wait-新消息']);
  assert.ok(Date.now() - waitStarted <= 4000, '新消息应在 wait 内快速返回');
});

test('v1 用户列表带 groups；admin 用户详情 groups 一致', async () => {
  const group = (await adminWrite('POST', '/api/admin/groups', { name: 'v1用户组', color: '#123456' })).json.group;
  const user = createUser({ displayName: 'v1分组用户' });
  await adminWrite('PUT', `/api/admin/users/${encodeURIComponent(user.id)}/groups`, { groupIds: [group.id] });

  const v1Users = await v1Get('/api/v1/users?status=active&limit=200');
  const v1User = v1Users.json.items.find((item) => item.id === user.id);
  assert.ok(v1User);
  assert.deepEqual(v1User.groups, [{ id: group.id, name: 'v1用户组', color: '#123456' }]);

  const detail = await adminGet(`/api/admin/users/${encodeURIComponent(user.id)}`);
  assert.deepEqual(detail.json.user.groups, [{ id: group.id, name: 'v1用户组', color: '#123456' }]);
});

// ---------------------------------------------------------------------------
// QA nit：并发同名时唯一约束错误应映射 409（不是 500）
// ---------------------------------------------------------------------------
test('store.createGroup 重复同名抛出 SQLite UNIQUE 约束错误（映射判定依据）', async () => {
  const name = '唯一约束形态组';
  await adminWrite('POST', '/api/admin/groups', { name });
  assert.throws(
    () => store.createGroup({ name }),
    (err) => /UNIQUE constraint failed/i.test(String(err?.message ?? '')),
  );
});

test('并发同名/改名（唯一索引兜底）→ 409 CONFLICT 而不是 500', async () => {
  const db = getDb();
  // 用 SQLite trigger 在“预查重通过之后、真正写入之前”抢先插入同名行，确定性模拟并发竞态
  db.exec(`CREATE TRIGGER trg_groups_race_insert
    BEFORE INSERT ON groups WHEN NEW.name = '并发同名组'
    BEGIN
      INSERT INTO groups (id, name, description, color, created_at, updated_at)
      VALUES ('grp_race_insert', '并发同名组', '', '', 1, 1);
    END;`);
  try {
    const raced = await adminWrite('POST', '/api/admin/groups', { name: '并发同名组' });
    assert.equal(raced.status, 409, `并发同名应 409，实际 ${raced.status}：${raced.text}`);
    assert.equal(raced.json.error.code, 'CONFLICT');
  } finally {
    db.exec('DROP TRIGGER IF EXISTS trg_groups_race_insert');
    db.prepare("DELETE FROM groups WHERE id = 'grp_race_insert' OR name = '并发同名组'").run();
  }

  // PATCH 改名竞态：预查重通过后，trigger 抢先插入新名称行 → UPDATE 命中唯一索引 → 409
  const target = (await adminWrite('POST', '/api/admin/groups', { name: '并发改名原组' })).json.group;
  db.exec(`CREATE TRIGGER trg_groups_race_update
    BEFORE UPDATE OF name ON groups WHEN NEW.name = '并发改名新组'
    BEGIN
      INSERT INTO groups (id, name, description, color, created_at, updated_at)
      VALUES ('grp_race_update', '并发改名新组', '', '', 1, 1);
    END;`);
  try {
    const raced = await adminWrite('PATCH', `/api/admin/groups/${target.id}`, { name: '并发改名新组' });
    assert.equal(raced.status, 409, `并发改名应 409，实际 ${raced.status}：${raced.text}`);
    assert.equal(raced.json.error.code, 'CONFLICT');
    // 目标分组名称保持不变（事务未提交）
    const groups = await adminGet('/api/admin/groups');
    assert.equal(groups.json.items.find((group) => group.id === target.id).name, '并发改名原组');
  } finally {
    db.exec('DROP TRIGGER IF EXISTS trg_groups_race_update');
    db.prepare("DELETE FROM groups WHERE id = 'grp_race_update' OR name = '并发改名新组'").run();
    await adminWrite('DELETE', `/api/admin/groups/${target.id}`);
  }

  // 正常重名（预查重路径）仍为 409
  const dupName = '正常重名组';
  await adminWrite('POST', '/api/admin/groups', { name: dupName });
  assert.equal((await adminWrite('POST', '/api/admin/groups', { name: dupName })).status, 409);
});
