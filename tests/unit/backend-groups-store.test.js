/**
 * 单元测试：store.js 用户分组 + 入站消息查询（docs/GROUPS_AND_INBOUND.md §1/§2/§4.3）。
 * 临时 DATA_DIR + 真实 SQLite，无网络。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-groups-store-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'groups-store-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'groups-store-password';
process.env.API_TOKEN = 'groups-store-token';
process.env.LOG_LEVEL = 'silent';

const store = await import('../../server/src/store.js');
const { get, closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
function createUser(overrides = {}) {
  seq += 1;
  return store.upsertBoundUser({
    wechatUserId: overrides.wechatUserId ?? `wx_group_${seq}`,
    displayName: overrides.displayName ?? `分组用户${seq}`,
    ilinkBotId: `bot_group_${seq}@im.bot`,
    botToken: `group-token-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
}

test('groups CRUD：创建/列表/重名/更新/删除级联', () => {
  assert.deepEqual(store.listGroups(), []);

  const vip = store.createGroup({ name: 'VIP客户', description: '重点客户', color: '#07C160' });
  assert.match(vip.id, /^grp_/);
  assert.equal(vip.name, 'VIP客户');
  assert.equal(vip.color, '#07C160');
  assert.equal(vip.userCount, 0);
  assert.equal(vip.activeUserCount, 0);
  assert.equal(typeof vip.createdAt, 'number');

  const beta = store.createGroup({ name: 'Beta组' });
  assert.equal(beta.description, '');
  assert.equal(beta.color, '');
  assert.equal(store.listGroups().length, 2);
  assert.ok(store.listGroups().some((group) => group.id === vip.id));

  // 重名检测（findGroupByName；PATCH 可用 excludeId 排除自身）
  assert.ok(store.findGroupByName('VIP客户'));
  assert.equal(store.findGroupByName('VIP客户', { excludeId: vip.id }), undefined);
  assert.equal(store.findGroupByName('不存在'), undefined);

  // 更新
  const updated = store.updateGroup(vip.id, { name: 'VIP客户2', description: '更新描述', color: '#FF0000' });
  assert.equal(updated.name, 'VIP客户2');
  assert.equal(updated.description, '更新描述');
  assert.equal(updated.color, '#FF0000');
  assert.equal(store.updateGroup('grp_missing', { name: 'x' }), null);

  // 用户归属 + 删除级联（用户不受影响）
  const user = createUser();
  store.replaceUserGroups(user.id, [vip.id, beta.id]);
  assert.equal(store.getUserGroups(user.id).length, 2);
  assert.equal(store.deleteGroup(vip.id), true);
  assert.equal(store.getGroup(vip.id), null);
  assert.equal(store.getUserGroups(user.id).length, 1, '删除分组应清理 user_groups 关联');
  assert.equal(store.getUser(user.id).displayName.length > 0, true, '用户本身不受影响');
  assert.equal(store.deleteGroup('grp_missing'), false);
});

test('用户分组归属：replaceUserGroups 去重/清空、getGroupsForUsers、视图带 groups', () => {
  const userA = createUser({ displayName: '用户A' });
  const userB = createUser({ displayName: '用户B' });
  const groupA = store.createGroup({ name: 'A组', color: '#111111' });
  const groupB = store.createGroup({ name: 'B组', color: '#222222' });

  const groups = store.replaceUserGroups(userA.id, [groupB.id, groupA.id, groupB.id, '']);
  assert.equal(groups.length, 2, '应去重并忽略空字符串');
  assert.deepEqual(
    groups.map((group) => group.name),
    ['A组', 'B组'],
    '按名称排序',
  );
  assert.deepEqual(
    store.getUserGroups(userA.id).map((group) => group.id),
    [groupA.id, groupB.id],
    'getUserGroups 应按名称排序返回',
  );

  const batch = store.getGroupsForUsers([userA.id, userB.id]);
  assert.equal(batch.get(userA.id).length, 2);
  assert.deepEqual(batch.get(userB.id), []);

  // 用户视图/列表附带 groups
  const view = store.getUser(userA.id);
  assert.equal(view.groups.length, 2);
  assert.deepEqual(view.groups[0].id, groups[0].id);
  const list = store.listUsers({ status: 'all', q: '用户A' });
  assert.equal(list.items[0].groups.length, 2);
  const withCounts = store.getUserWithCounts(userA.id);
  assert.equal(withCounts.groups.length, 2);
  const byWechat = store.getUserByWechatId(userA.wechatUserId);
  assert.equal(byWechat.groups.length, 2);

  // 全量替换：清空
  store.replaceUserGroups(userA.id, []);
  assert.deepEqual(store.getUserGroups(userA.id), []);
  assert.deepEqual(store.getUser(userA.id).groups, []);
});

test('GroupView 计数与分组内成员（activeOnly 排除 unbound/冷却）', () => {
  const group = store.createGroup({ name: '计数组' });
  const active = createUser({ displayName: '活跃' });
  const paused = createUser({ displayName: '冷却' });
  const unbound = createUser({ displayName: '已解绑' });
  store.setUserPaused(paused.id, Date.now() + 3600_000, 'stale');
  store.unbindUser(unbound.id);
  for (const user of [active, paused, unbound]) store.replaceUserGroups(user.id, [group.id]);

  const view = store.getGroup(group.id);
  assert.equal(view.userCount, 3, 'userCount 包含 unbound 历史用户');
  assert.equal(view.activeUserCount, 2, 'activeUserCount=status active（含冷却）');

  const allMembers = store.getGroupMembers(group.id);
  assert.equal(allMembers.length, 3);
  const sendable = store.getGroupMembers(group.id, { activeOnly: true, now: Date.now() });
  assert.equal(sendable.length, 1);
  assert.equal(sendable[0].id, active.id);
});

test('listUsers / listMessages 按 groupId 过滤', () => {
  const group = store.createGroup({ name: '过滤组' });
  const member = createUser({ displayName: '组内用户' });
  const other = createUser({ displayName: '组外用户' });
  store.replaceUserGroups(member.id, [group.id]);

  const filtered = store.listUsers({ status: 'all', groupId: group.id });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, member.id);
  assert.equal(store.listUsers({ status: 'all', groupId: 'grp_missing' }).total, 0);

  store.saveInbound({ userId: member.id, wechatMessageId: 'grp_in_1', fromUserId: 'wx', text: '组内入站', receivedAt: 1000 });
  store.saveInbound({ userId: other.id, wechatMessageId: 'grp_in_2', fromUserId: 'wx', text: '组外入站', receivedAt: 1001 });
  store.enqueueMessage({ userId: member.id, text: '组内出站' });
  store.enqueueMessage({ userId: other.id, text: '组外出站' });

  const messages = store.listMessages({ direction: 'all', groupId: group.id, limit: 20 });
  assert.equal(messages.total, 2);
  assert.ok(messages.items.every((item) => item.text.includes('组内')));
  assert.equal(store.listMessages({ direction: 'inbound', groupId: group.id }).total, 1);
  assert.equal(store.listMessages({ direction: 'outbound', groupId: group.id }).total, 1);
  assert.equal(store.listMessages({ direction: 'all', groupId: 'grp_missing' }).total, 0);
});

test('入站消息 API 查询：ASC 排序/cursor/since/limit/附件/groups', () => {
  const user = createUser({ displayName: '入站查询用户' });
  const group = store.createGroup({ name: '入站组', color: '#ABCDEF' });
  store.replaceUserGroups(user.id, [group.id]);

  const saved = [];
  for (let i = 0; i < 4; i += 1) {
    const receivedAt = 1000 + i;
    store.saveInbound({
      userId: user.id,
      wechatMessageId: `api_in_${i}`,
      fromUserId: user.wechatUserId,
      text: `入站消息-${i}`,
      itemTypes: i === 0 ? '1,2' : '1',
      receivedAt,
      createdAt: receivedAt - 5,
    });
    saved.push(get('SELECT id FROM inbound_messages WHERE wechat_message_id = ?', `api_in_${i}`));
  }
  const ids = saved.map((row) => row.id);
  // 给第二条挂一个入站附件
  store.createAttachment({
    direction: 'inbound',
    kind: 'image',
    mime: 'image/png',
    fileName: 'a.png',
    size: 5,
    path: 'inbound/x.png',
    sha256: 'x',
    userId: user.id,
    inboundMessageId: ids[1],
    wechatMessageId: 'api_in_1',
    status: 'ready',
  });

  // 第一页 limit=2（限定当前用户，避免与其他用例数据混排）
  const page1 = store.listInboundForApi({ limit: 2, userId: user.id });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.hasMore, true);
  assert.deepEqual(
    page1.items.map((item) => item.text),
    ['入站消息-0', '入站消息-1'],
    '按 received_at ASC 排序',
  );
  assert.equal(page1.items[0].displayName, '入站查询用户');
  assert.equal(page1.items[0].itemTypes, '1,2');
  assert.equal(page1.items[0].createdAt, 995);
  assert.equal(page1.items[0].receivedAt, 1000);
  assert.deepEqual(page1.items[0].groups, [{ id: group.id, name: '入站组', color: '#ABCDEF' }]);
  assert.equal(page1.items[0].attachments.length, 0);
  assert.equal(page1.items[1].attachments.length, 1, '第二条应关联附件');
  assert.equal(page1.items[1].attachments[0].url, `/api/v1/media/${page1.items[1].attachments[0].id}`);
  assert.equal(page1.items[1].attachments[0].downloadUrl.endsWith('?download=1'), true);

  // cursor 解码与第二页
  assert.ok(page1.nextCursor);
  const cursor = store.decodeInboundCursor(page1.nextCursor);
  assert.equal(cursor.receivedAt, 1001);
  assert.equal(cursor.id, ids[1]);
  assert.equal(store.encodeInboundCursor(cursor), page1.nextCursor, 'cursor 编解码应可逆');

  const page2 = store.listInboundForApi({
    limit: 2,
    cursor: store.decodeInboundCursor(page1.nextCursor),
    userId: user.id,
  });
  assert.equal(page2.items.length, 2);
  assert.equal(page2.hasMore, false);
  assert.deepEqual(
    page2.items.map((item) => item.text),
    ['入站消息-2', '入站消息-3'],
  );
  assert.ok(page2.nextCursor);

  // 无更多数据
  const page3 = store.listInboundForApi({
    limit: 2,
    cursor: store.decodeInboundCursor(page2.nextCursor),
    userId: user.id,
  });
  assert.equal(page3.items.length, 0);
  assert.equal(page3.hasMore, false);
  assert.equal(page3.nextCursor, null);

  // since 独占（received_at > since）
  const sinceResult = store.listInboundForApi({ limit: 10, since: 1001, userId: user.id });
  assert.deepEqual(
    sinceResult.items.map((item) => item.text),
    ['入站消息-2', '入站消息-3'],
    'since 应独占',
  );

  // userId / groupId 过滤
  const otherUser = createUser({ displayName: '其他入站用户' });
  store.saveInbound({ userId: otherUser.id, wechatMessageId: 'api_in_other', text: '其他用户消息', receivedAt: 2000 });
  assert.equal(store.listInboundForApi({ userId: user.id, limit: 10 }).items.length, 4);
  assert.equal(store.listInboundForApi({ userId: otherUser.id, limit: 10 }).items.length, 1);
  const groupFiltered = store.listInboundForApi({ groupId: group.id, limit: 10 });
  assert.equal(groupFiltered.items.length, 4, 'groupId 过滤按当前 membership');
  assert.equal(groupFiltered.items.every((item) => item.userId === user.id), true);

  // cursor 非法
  assert.throws(() => store.decodeInboundCursor('not-a-cursor'), /格式非法/);
  assert.throws(() => store.decodeInboundCursor(''), /不能为空/);
  assert.throws(() => store.decodeInboundCursor(Buffer.from('{"t":"x","id":1}').toString('base64url')), /格式非法/);
});
