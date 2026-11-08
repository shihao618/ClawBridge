/**
 * e2e：用户分组（docs/GROUPS_AND_INBOUND.md §2/§3，mock 无需改动）。
 *
 * 覆盖：
 *  - 分组 CRUD：创建 201（GroupView 字段/计数 0）、重名 409、参数校验 400、PATCH 改名/404、DELETE 204/再删 404；
 *  - 用户归属：PUT /api/admin/users/{id}/groups 全量替换、去重、未知 groupId 400（details.unknownGroupIds）、
 *    用户不存在 404、用户视图/列表带 groups、GET /api/admin/users?groupId= 过滤、GroupView 计数；
 *  - 分组文本群发：2 个 active 用户各收到 mock sentmessage、outbox sent、无 active 用户 count=0；
 *  - 分组媒体群发（图片）：每人各收到 image_item，按接收端解析 aes_key 解密 mock CDN 密文 sha256 一致；
 *  - 删除分组：用户归属清空、群发 404；
 *  - v1：GET /api/v1/groups、POST /api/v1/groups/{id}/messages（accepted/queued）、鉴权 401、未知分组 404。
 *
 * 全部随机端口 + 临时 DATA_DIR 子进程，不触碰真实容器（127.0.0.1:3000）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

import { startE2E, waitFor } from '../helpers/e2e-env.mjs';

let e2e;
let userA;
let userB;
/** 共享分组：before 创建，A/B 均为成员（供群发/v1 用例复用） */
let sharedGroup;
let groupSeq = 0;
const nextName = (prefix) => `${prefix}-${(groupSeq += 1)}`;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function makeBytes(size, seed = 1) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buffer[i] = (seed * 31 + i * 17) % 256;
  return buffer;
}

function makePng(size, seed = 1) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, makeBytes(Math.max(0, size - signature.length), seed)]);
}

/** 断言两个分组 id 集合相等（忽略顺序）。 */
function assertIdSet(actualIds, expectedIds, label = '分组 id') {
  assert.deepEqual([...new Set(actualIds)].sort(), [...new Set(expectedIds)].sort(), `${label} 集合不一致`);
}

/** 创建分组并断言 201，返回 GroupView。 */
async function createGroupOrFail(body) {
  const res = await e2e.createGroup(body);
  assert.equal(res.status, 201, `创建分组应 201，实际 ${res.status}：${res.text}`);
  assert.ok(res.json?.group?.id?.startsWith('grp_'), `GroupView.id 应为 grp_ 前缀：${res.text}`);
  return res.json.group;
}

before(async () => {
  e2e = await startE2E();
  await e2e.ensureAdmin();
  const a = await e2e.bindUser({ displayName: '分组用户A', waitMonitor: true });
  userA = a.user;
  const b = await e2e.bindUser({ displayName: '分组用户B', waitMonitor: true });
  userB = b.user;

  sharedGroup = await createGroupOrFail({ name: '共享分组', description: '群发用例共享', color: '#07C160' });
  const assigned = await e2e.assignUserGroups(userA.id, [sharedGroup.id]);
  assert.equal(assigned.status, 200, `分配用户 A 到共享分组失败：${assigned.text}`);
  const assignedB = await e2e.assignUserGroups(userB.id, [sharedGroup.id]);
  assert.equal(assignedB.status, 200, `分配用户 B 到共享分组失败：${assignedB.text}`);
});

after(async () => {
  await e2e?.cleanup();
});

test('分组 CRUD：创建 201 / 重名 409 / 参数校验 400 / PATCH 改名 / 删除 204', async () => {
  const name = nextName('VIP客户');
  const color = '#07C160';
  const created = await e2e.createGroup({ name, description: '重点客户', color });
  assert.equal(created.status, 201, `创建分组应 201：${created.status} ${created.text}`);
  const group = created.json.group;
  assert.match(group.id, /^grp_/);
  assert.equal(group.name, name);
  assert.equal(group.description, '重点客户');
  assert.equal(group.color, color);
  assert.equal(group.userCount, 0);
  assert.equal(group.activeUserCount, 0);
  assert.equal(typeof group.createdAt, 'number');
  assert.equal(typeof group.updatedAt, 'number');

  // GET 列表包含新分组
  const list = await e2e.listGroups();
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.items));
  assert.ok(list.json.items.some((item) => item.id === group.id), '分组列表应包含刚创建的分组');

  // 重名 → 409
  const duplicate = await e2e.createGroup({ name });
  assert.equal(duplicate.status, 409, `重名应 409：${duplicate.status} ${duplicate.text}`);
  assert.equal(duplicate.json.error.code, 'CONFLICT');

  // 参数校验：name 必填/超长、description 超长、color 非法 → 400
  const invalidBodies = [
    { name: '' },
    { name: '长'.repeat(41) },
    { name: nextName('校验'), description: 'd'.repeat(201) },
    { name: nextName('校验'), color: 'red' },
    { name: nextName('校验'), color: '#12345' },
  ];
  for (const body of invalidBodies) {
    const res = await e2e.createGroup(body);
    assert.equal(res.status, 400, `非法分组参数应 400（${JSON.stringify(body)}）：${res.status} ${res.text}`);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
  }

  // PATCH 改名/描述/颜色
  const newName = nextName('VIP客户-改名');
  const patched = await e2e.updateGroup(group.id, { name: newName, description: '改后描述', color: '#FF0000' });
  assert.equal(patched.status, 200, `PATCH 应 200：${patched.status} ${patched.text}`);
  assert.equal(patched.json.group.name, newName);
  assert.equal(patched.json.group.description, '改后描述');
  assert.equal(patched.json.group.color, '#FF0000');
  assert.equal(patched.json.group.id, group.id);

  // PATCH 空 body → 400；不存在 → 404
  const emptyPatch = await e2e.updateGroup(group.id, {});
  assert.equal(emptyPatch.status, 400);
  assert.equal(emptyPatch.json.error.code, 'BAD_REQUEST');
  const missingPatch = await e2e.updateGroup('grp_not_exists_e2e', { name: nextName('x') });
  assert.equal(missingPatch.status, 404);
  assert.equal(missingPatch.json.error.code, 'NOT_FOUND');

  // DELETE 204，再删 404
  const deleted = await e2e.deleteGroup(group.id);
  assert.equal(deleted.status, 204, `删除分组应 204：${deleted.status} ${deleted.text}`);
  const deletedAgain = await e2e.deleteGroup(group.id);
  assert.equal(deletedAgain.status, 404);
  const listAfter = await e2e.listGroups();
  assert.equal(listAfter.json.items.some((item) => item.id === group.id), false, '删除后分组列表不应再包含该分组');
});

test('用户分组归属：PUT 全量替换/去重/未知 id 400/用户视图与列表带 groups/groupId 过滤', async () => {
  const groupOne = await createGroupOrFail({ name: nextName('归属组一'), color: '#123456' });
  const groupTwo = await createGroupOrFail({ name: nextName('归属组二') });

  // 未知 groupId → 400 + details.unknownGroupIds
  const unknown = await e2e.assignUserGroups(userA.id, [groupOne.id, 'grp_unknown_e2e']);
  assert.equal(unknown.status, 400, `未知 groupId 应 400：${unknown.status} ${unknown.text}`);
  assert.equal(unknown.json.error.code, 'BAD_REQUEST');
  assert.deepEqual(unknown.json.error.details.unknownGroupIds, ['grp_unknown_e2e']);

  // 用户不存在 → 404
  const missingUser = await e2e.assignUserGroups('u_not_exists_e2e', [groupOne.id]);
  assert.equal(missingUser.status, 404);
  assert.equal(missingUser.json.error.code, 'NOT_FOUND');

  // 全量替换 + 静默去重
  const assigned = await e2e.assignUserGroups(userA.id, [groupOne.id, groupTwo.id, groupOne.id]);
  assert.equal(assigned.status, 200, `PUT groups 应 200：${assigned.status} ${assigned.text}`);
  assert.ok(Array.isArray(assigned.json.user.groups));
  assert.equal(assigned.json.user.groups.length, 2, 'groupIds 去重后应有 2 个分组');
  assertIdSet(assigned.json.user.groups.map((item) => item.id), [groupOne.id, groupTwo.id]);
  for (const view of assigned.json.user.groups) {
    assert.equal(typeof view.name, 'string');
    assert.equal(typeof view.color, 'string');
  }

  // 用户详情带 groups
  const detail = await e2e.adminGet(`/api/admin/users/${userA.id}`);
  assert.equal(detail.status, 200);
  assertIdSet((detail.json.user.groups ?? []).map((item) => item.id), [groupOne.id, groupTwo.id], '用户详情 groups');

  // 全量替换为只剩 groupTwo
  const replaced = await e2e.assignUserGroups(userA.id, [groupTwo.id]);
  assert.equal(replaced.status, 200);
  assertIdSet(replaced.json.user.groups.map((item) => item.id), [groupTwo.id], '全量替换后 groups');

  // 清空 []
  const cleared = await e2e.assignUserGroups(userA.id, []);
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json.user.groups, []);

  // 分配 A/B 到 groupOne 后按 groupId 过滤用户列表
  await e2e.assignUserGroups(userA.id, [groupOne.id]);
  await e2e.assignUserGroups(userB.id, [groupOne.id, groupTwo.id]);
  const filtered = await e2e.listUsers({ groupId: groupOne.id });
  assert.equal(filtered.status, 200, `用户列表 groupId 过滤失败：${filtered.status} ${filtered.text}`);
  assertIdSet(filtered.json.items.map((item) => item.id), [userA.id, userB.id], 'groupId 过滤结果');
  const groupOneView = (await e2e.listGroups()).json.items.find((item) => item.id === groupOne.id);
  assert.ok(groupOneView, '分组列表应包含 groupOne');
  assert.equal(groupOneView.userCount, 2, 'userCount 应为 2');
  assert.equal(groupOneView.activeUserCount, 2, 'activeUserCount 应为 2');

  // 用户视图带 groups（列表项）
  const listAll = await e2e.listUsers({ groupId: groupOne.id, status: 'all' });
  const userAItem = listAll.json.items.find((item) => item.id === userA.id);
  assert.ok(userAItem);
  assert.ok(Array.isArray(userAItem.groups));
  assert.ok(userAItem.groups.some((item) => item.id === groupOne.id));

  // 恢复用户 A 到共享分组（供后续群发用例使用）
  const restoreA = await e2e.assignUserGroups(userA.id, [sharedGroup.id]);
  assert.equal(restoreA.status, 200);
});

test('删除分组：用户归属清空、分组列表移除、按该分组群发 404', async () => {
  const group = await createGroupOrFail({ name: nextName('待删分组') });
  const assigned = await e2e.assignUserGroups(userA.id, [group.id]);
  assert.equal(assigned.status, 200);
  assert.ok(assigned.json.user.groups.some((item) => item.id === group.id));

  const deleted = await e2e.deleteGroup(group.id);
  assert.equal(deleted.status, 204);

  const detail = await e2e.adminGet(`/api/admin/users/${userA.id}`);
  assert.equal(detail.status, 200);
  assert.equal(
    (detail.json.user.groups ?? []).some((item) => item.id === group.id),
    false,
    '删除分组后用户归属应被清空',
  );

  const send = await e2e.sendGroupMessage(group.id, { text: '已删除分组不应能发送' });
  assert.equal(send.status, 404, `向已删除分组发送应 404：${send.status} ${send.text}`);
  assert.equal(send.json.error.code, 'NOT_FOUND');

  // 恢复用户 A 到共享分组
  await e2e.assignUserGroups(userA.id, [sharedGroup.id]);
});

test('分组文本群发：2 个 active 用户各收到，outbox sent', async () => {
  // 确认共享分组当前成员为 A/B（其他用例可能改动，恢复一次）
  await e2e.assignUserGroups(userA.id, [sharedGroup.id]);
  await e2e.assignUserGroups(userB.id, [sharedGroup.id]);

  const text = nextName('分组文本群发');
  const res = await e2e.sendGroupMessage(sharedGroup.id, { text });
  assert.equal(res.status, 202, `分组群发应 202：${res.status} ${res.text}`);
  assert.equal(res.json.count, 2, `共享分组有 2 个 active 用户，count 应为 2：${res.text}`);
  assert.equal(res.json.queued.length, 2);
  const queuedUserIds = res.json.queued.map((item) => item.userId);
  assertIdSet(queuedUserIds, [userA.id, userB.id], '群发 queued 用户');
  for (const item of res.json.queued) {
    assert.ok(item.outboxId.startsWith('ob_'));
    assert.equal(item.status, 'queued');
  }

  // mock 侧：两个账号各收到一条文本
  await e2e.waitSentMessageCount(text, 2);
  const state = await e2e.mockState();
  const sent = state.sentMessages.filter((item) => item.text === text);
  assert.equal(sent.length, 2);
  assertIdSet(
    sent.map((item) => item.toUserId),
    [userA.wechatUserId, userB.wechatUserId],
    '群发 mock 收件人',
  );

  // 两条 outbox 均 sent、attempts=1
  for (const item of res.json.queued) {
    const outbox = await e2e.waitOutbox(item.outboxId, 'sent');
    assert.equal(outbox.attempts, 1);
  }

  // 管理后台消息记录 groupId 过滤（docs/GROUPS_AND_INBOUND.md §3.3，出站）
  const filteredMessages = await e2e.adminGet(
    `/api/admin/messages?direction=outbound&status=sent&groupId=${encodeURIComponent(sharedGroup.id)}&limit=100`,
  );
  assert.equal(filteredMessages.status, 200, `admin 消息 groupId 过滤失败：${filteredMessages.status} ${filteredMessages.text}`);
  const matched = (filteredMessages.json.items ?? []).filter((row) => row.text === text);
  assert.equal(matched.length, 2, 'groupId 过滤应返回本次分组群发的 2 条出站消息');
  assertIdSet(matched.map((row) => row.userId), [userA.id, userB.id], 'groupId 过滤消息所属用户');

  await e2e.waitQueueDrained();
});

test('无 active 用户的分组：群发 count=0（空分组；仅 unbound 用户的分组）', async () => {
  // 空分组
  const emptyGroup = await createGroupOrFail({ name: nextName('空分组') });
  const emptySend = await e2e.sendGroupMessage(emptyGroup.id, { text: nextName('空分组消息') });
  assert.ok([200, 202].includes(emptySend.status), `空分组群发应 200/202，实际 ${emptySend.status} ${emptySend.text}`);
  assert.equal(emptySend.json.count, 0);
  assert.deepEqual(emptySend.json.queued, []);

  // 仅 unbound 用户的分组
  const bound = await e2e.bindUser({ displayName: '分组解绑用户C', waitMonitor: true });
  const unboundGroup = await createGroupOrFail({ name: nextName('解绑用户组') });
  const assigned = await e2e.assignUserGroups(bound.user.id, [unboundGroup.id]);
  assert.equal(assigned.status, 200);
  const unbind = await e2e.adminWrite('POST', `/api/admin/users/${bound.user.id}/unbind`);
  assert.equal(unbind.status, 200);
  const groupView = (await e2e.listGroups()).json.items.find((item) => item.id === unboundGroup.id);
  assert.equal(groupView.userCount, 1, 'unbound 用户仍计入 userCount');
  assert.equal(groupView.activeUserCount, 0, 'unbound 用户不计入 activeUserCount');
  const unboundSend = await e2e.sendGroupMessage(unboundGroup.id, { text: nextName('解绑组消息') });
  assert.ok([200, 202].includes(unboundSend.status));
  assert.equal(unboundSend.json.count, 0);
  assert.deepEqual(unboundSend.json.queued, []);
});

test('分组媒体群发（图片）：每人各收到 image_item，接收端解密后 sha256 与原图一致', async () => {
  await e2e.assignUserGroups(userA.id, [sharedGroup.id]);
  await e2e.assignUserGroups(userB.id, [sharedGroup.id]);

  const image = makePng(2400, 61);
  const caption = nextName('分组图片');
  const upload = await e2e.uploadAdminMedia(image, { fileName: '分组图片.png', mime: 'image/png' });
  assert.equal(upload.status, 201, `上传图片失败：${upload.status} ${upload.text}`);
  const mediaId = upload.json.media.id;

  const res = await e2e.sendGroupMessage(sharedGroup.id, { text: caption, mediaId });
  assert.equal(res.status, 202, `分组媒体群发应 202：${res.status} ${res.text}`);
  assert.equal(res.json.count, 2);
  assert.equal(res.json.queued.length, 2);

  // caption 文本消息 2 条
  await e2e.waitSentMessageCount(caption, 2);

  // 图片媒体消息 2 条（分别发给 A/B）
  const stateWithImages = await waitFor(
    async () => {
      const state = await e2e.mockState();
      const images = state.sentMessages.filter(
        (record) =>
          record.itemList?.some((item) => item.kind === 'image') &&
          [userA.wechatUserId, userB.wechatUserId].includes(record.toUserId),
      );
      return images.length >= 2 ? state : null;
    },
    { label: 'mock 收到 2 条分组图片消息（A/B 各一条）' },
  );
  const imageRecords = stateWithImages.sentMessages.filter(
    (record) =>
      record.itemList?.some((item) => item.kind === 'image') &&
      [userA.wechatUserId, userB.wechatUserId].includes(record.toUserId),
  );
  // 只取本次群发产生的：同一个 CDN token 集合按每收件人各上传一次
  const latestTwo = imageRecords.slice(-2);
  assert.equal(latestTwo.length, 2);
  assertIdSet(latestTwo.map((record) => record.toUserId), [userA.wechatUserId, userB.wechatUserId], '媒体群发收件人');
  for (const record of latestTwo) {
    const item = record.itemList.find((entry) => entry.kind === 'image');
    assert.equal(item.type, 2);
    assert.equal(item.media.encryptType, 1);
    assert.equal(typeof item.media.encryptQueryParam, 'string');
    assert.ok(item.media.encryptQueryParam.length > 0);
    // 接收端解析 aes_key 并解密 mock CDN 密文，sha256 应与原图一致
    const decrypted = await e2e.decryptMockCdnCiphertext(item.media.encryptQueryParam, item.media.aesKey);
    assert.equal(sha256(decrypted), sha256(image), '媒体群发每人解密结果应等于原图');
    assert.deepEqual(decrypted, image);
  }

  for (const item of res.json.queued) {
    const outbox = await e2e.waitOutbox(item.outboxId, 'sent');
    assert.equal(outbox.attempts, 1);
  }
  await e2e.waitQueueDrained();
});

test('v1 分组 API：GET /api/v1/groups、分组发送、鉴权 401、未知分组 404', async () => {
  await e2e.assignUserGroups(userA.id, [sharedGroup.id]);
  await e2e.assignUserGroups(userB.id, [sharedGroup.id]);

  // GET /api/v1/groups
  const groups = await e2e.getV1Groups();
  assert.equal(groups.status, 200, `GET /api/v1/groups 应 200：${groups.status} ${groups.text}`);
  assert.ok(Array.isArray(groups.json.items));
  const view = groups.json.items.find((item) => item.id === sharedGroup.id);
  assert.ok(view, 'v1 分组列表应包含共享分组');
  assert.equal(view.name, sharedGroup.name);
  assert.equal(typeof view.userCount, 'number');
  assert.equal(typeof view.activeUserCount, 'number');
  assert.equal(view.userCount, 2);
  assert.equal(view.activeUserCount, 2);

  // POST /api/v1/groups/{id}/messages
  const text = nextName('v1分组群发');
  const send = await e2e.sendV1GroupMessage(sharedGroup.id, { text });
  assert.equal(send.status, 202, `v1 分组群发应 202：${send.status} ${send.text}`);
  assert.equal(send.json.accepted, 2);
  assert.equal(send.json.queued.length, 2);
  assertIdSet(send.json.queued.map((item) => item.userId), [userA.id, userB.id], 'v1 群发用户');
  await e2e.waitSentMessageCount(text, 2);
  for (const item of send.json.queued) {
    await e2e.waitOutbox(item.outboxId, 'sent');
  }

  // 鉴权 401（无 key / 错误 key）
  const noAuth = await e2e.getV1Groups({ token: '' });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.json.error.code, 'UNAUTHORIZED');
  const badAuth = await e2e.getV1Groups({ token: 'wrong-token' });
  assert.equal(badAuth.status, 401);
  const noAuthSend = await e2e.sendV1GroupMessage(sharedGroup.id, { text: nextName('x') }, { token: '' });
  assert.equal(noAuthSend.status, 401);

  // 未知分组 404 / 空 body 400
  const unknownGroup = await e2e.sendV1GroupMessage('grp_not_exists_e2e', { text: nextName('x') });
  assert.equal(unknownGroup.status, 404);
  assert.equal(unknownGroup.json.error.code, 'NOT_FOUND');
  const emptyBody = await e2e.sendV1GroupMessage(sharedGroup.id, {});
  assert.equal(emptyBody.status, 400);
  assert.equal(emptyBody.json.error.code, 'BAD_REQUEST');

  // 管理端分组发送校验：空 body 400
  const adminEmpty = await e2e.sendGroupMessage(sharedGroup.id, {});
  assert.equal(adminEmpty.status, 400);

  await e2e.waitQueueDrained();
});
