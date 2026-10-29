/**
 * e2e：对外入站消息 API（docs/GROUPS_AND_INBOUND.md §4.3/§7，mock 无需改动）。
 *
 * 覆盖：
 *  - 默认 ASC 排序与字段（id/userId/displayName/groups/text/itemTypes/createdAt/receivedAt/attachments）；
 *  - 附件元数据（url/downloadUrl 为 /api/v1/media 前缀）与 GET /api/v1/media/{id} 字节一致、未鉴权 401；
 *  - cursor 分页：limit/hasMore/nextCursor，用 nextCursor 增量拉取不重复不遗漏；
 *  - since 过滤（独占）、userId / groupId 过滤、未知 userId/groupId 返回空；
 *  - wait 长轮询：无新消息时 wait=1 返回空 items 且耗时 ≥~0.9s；并发注入时在等待窗口内及时返回；
 *  - 参数校验（limit/wait/cursor/since 非法 → 400）与鉴权（错误/缺失 API Key → 401）。
 *
 * 全部随机端口 + 临时 DATA_DIR 子进程，不触碰真实容器（127.0.0.1:3000）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

import { sleep, startE2E } from '../helpers/e2e-env.mjs';

let e2e;
let userA;
let userB;
let accountA;
let accountB;
let groupA;
let messageIdSeq = 0;

const fixtures = {
  textA1: 'inbound-A-text-1',
  textA2: 'inbound-A-text-2',
  textB1: 'inbound-B-text-1',
  imageA: null,
  fileB: null,
};

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function makeBytes(size, seed = 1) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buffer[i] = (seed * 31 + i * 17) % 256;
  return buffer;
}

/** 带真实 PNG 魔数的测试图片（服务端入站按魔数嗅探 MIME）。 */
function makePng(size, seed = 1) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, makeBytes(Math.max(0, size - signature.length), seed)]);
}

function uniqueMessageId() {
  messageIdSeq += 1;
  return (BigInt(Date.now()) * 1000n + BigInt(messageIdSeq)).toString();
}

/** 注入文本入站并等待落库（确保 receivedAt 按注入顺序单调递增）。 */
async function injectTextAndWait(user, account, text) {
  await e2e.mockInbound(account.botId, {
    text,
    context_token: `ctx-${text}`,
    message_id: uniqueMessageId(),
  });
  await e2e.waitInboundText(user.id, text);
}

/** 注入媒体入站并等待附件 ready（消息先入库、附件异步下载）。 */
async function injectMediaAndWait(user, account, { kind, fileName, mime, content }) {
  const injected = await e2e.mockInboundMedia(account.botId, {
    kind,
    fileName,
    mime,
    contentBase64: content.toString('base64'),
    context_token: `ctx-media-${kind}`,
  });
  await e2e.waitAttachmentsReady(
    (row) => row.direction === 'inbound' && row.serverMessageId === injected.message.message_id,
    { direction: 'inbound', kind, label: `入站 ${kind} 附件 ready` },
  );
  return injected;
}

before(async () => {
  e2e = await startE2E();
  await e2e.ensureAdmin();

  const a = await e2e.bindUser({ displayName: '入站用户A', waitMonitor: true });
  userA = a.user;
  accountA = a.account;
  const b = await e2e.bindUser({ displayName: '入站用户B', waitMonitor: true });
  userB = b.user;
  accountB = b.account;

  const createdGroup = await e2e.createGroup({ name: '入站分组A', description: 'groupId 过滤用例', color: '#07C160' });
  assert.equal(createdGroup.status, 201, `创建分组失败：${createdGroup.status} ${createdGroup.text}`);
  groupA = createdGroup.json.group;
  const assigned = await e2e.assignUserGroups(userA.id, [groupA.id]);
  assert.equal(assigned.status, 200, `分配分组失败：${assigned.status} ${assigned.text}`);

  // 顺序注入 5 条 fixture 消息（每条确认落库后再下一条，保证 receivedAt 单调递增）
  fixtures.imageA = makePng(2500, 71);
  fixtures.fileB = makeBytes(700, 72);

  await injectTextAndWait(userA, accountA, fixtures.textA1);
  await sleep(20);
  await injectTextAndWait(userA, accountA, fixtures.textA2);
  await sleep(20);
  await injectTextAndWait(userB, accountB, fixtures.textB1);
  await sleep(20);
  await injectMediaAndWait(userA, accountA, {
    kind: 'image',
    fileName: 'in.png',
    mime: 'image/png',
    content: fixtures.imageA,
  });
  await sleep(20);
  await injectMediaAndWait(userB, accountB, {
    kind: 'file',
    fileName: '入站报告.pdf',
    mime: 'application/pdf',
    content: fixtures.fileB,
  });

  // 等待入站 API 可见全部 fixture
  await e2e.waitV1InboundMessages((body) => (body.items ?? []).length >= 5, {
    limit: 200,
    label: 'v1 入站 API 可见 5 条 fixture',
  });
});

after(async () => {
  await e2e?.cleanup();
});

/** 拉取全部入站消息（用 nextCursor 翻页），返回 {items, lastCursor}。 */
async function fetchAllInbound({ limit = 200 } = {}) {
  const items = [];
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const res = await e2e.getV1InboundMessages({ limit, cursor });
    assert.equal(res.status, 200, `v1 入站消息查询失败：${res.status} ${res.text}`);
    items.push(...(res.json.items ?? []));
    if (!res.json.hasMore) {
      return { items, lastCursor: res.json.nextCursor ?? cursor ?? null };
    }
    assert.ok(res.json.nextCursor, 'hasMore=true 时应返回 nextCursor');
    cursor = res.json.nextCursor;
  }
  throw new Error('v1 入站消息翻页次数异常（>20 页）');
}

test('默认 ASC 排序 + 字段 + 附件元数据与 /api/v1/media 字节一致', async () => {
  const res = await e2e.getV1InboundMessages({ limit: 200 });
  assert.equal(res.status, 200, `GET /api/v1/inbound/messages 应 200：${res.status} ${res.text}`);
  const body = res.json;
  assert.ok(Array.isArray(body.items));
  assert.equal(body.items.length, 5, `应有 5 条入站消息，实际 ${body.items.length}`);
  assert.equal(typeof body.hasMore, 'boolean');
  assert.ok(body.nextCursor === null || typeof body.nextCursor === 'string');
  assert.equal(typeof body.serverTime, 'number');

  // 默认 ASC：(receivedAt, id) 升序
  for (let i = 1; i < body.items.length; i += 1) {
    const prev = body.items[i - 1];
    const current = body.items[i];
    assert.ok(
      prev.receivedAt < current.receivedAt ||
        (prev.receivedAt === current.receivedAt && String(prev.id) <= String(current.id)),
      `入站消息应按 (receivedAt,id) 升序：${JSON.stringify([prev.receivedAt, current.receivedAt])}`,
    );
  }

  // 文本消息字段
  const textA1 = body.items.find((item) => item.text === fixtures.textA1);
  assert.ok(textA1, '应包含用户 A 的第一条文本消息');
  assert.ok(textA1.id.startsWith('in_'));
  assert.equal(textA1.userId, userA.id);
  assert.equal(textA1.displayName, '入站用户A');
  assert.equal(textA1.itemTypes, '1');
  assert.equal(typeof textA1.createdAt, 'number');
  assert.equal(typeof textA1.receivedAt, 'number');
  assert.ok(Array.isArray(textA1.groups), 'groups 应为数组');
  assert.ok(textA1.groups.some((group) => group.id === groupA.id), '用户 A 的消息应带其分组信息');
  assert.deepEqual(textA1.attachments, []);

  const textB1 = body.items.find((item) => item.text === fixtures.textB1);
  assert.ok(textB1, '应包含用户 B 的文本消息');
  assert.equal(textB1.userId, userB.id);
  assert.equal(textB1.displayName, '入站用户B');
  assert.deepEqual(textB1.groups, [], '未加入分组的用户 B 应返回空 groups');

  // 图片消息 + 附件元数据 + 读取字节一致
  const imageMessage = body.items.find((item) => (item.attachments ?? []).some((att) => att.kind === 'image'));
  assert.ok(imageMessage, '应包含图片入站消息');
  assert.equal(imageMessage.userId, userA.id);
  assert.equal(imageMessage.itemTypes, '2');
  assert.match(imageMessage.text, /图片/, '图片消息文本应为 [图片] 占位');
  const imageAttachment = imageMessage.attachments.find((att) => att.kind === 'image');
  assert.ok(imageAttachment.id.startsWith('att_'));
  assert.equal(imageAttachment.kind, 'image');
  assert.equal(imageAttachment.mime, 'image/png');
  assert.equal(imageAttachment.size, fixtures.imageA.length);
  assert.equal(imageAttachment.status, 'ready');
  assert.equal(imageAttachment.url, `/api/v1/media/${imageAttachment.id}`);
  assert.equal(imageAttachment.downloadUrl, `/api/v1/media/${imageAttachment.id}?download=1`);

  const imageRead = await e2e.getV1Media(imageAttachment.id);
  assert.equal(imageRead.status, 200);
  assert.deepEqual(imageRead.buffer, fixtures.imageA, 'GET /api/v1/media/{id} 字节应与注入图片一致');
  assert.equal(imageRead.headers.get('content-type'), 'image/png');
  assert.equal(sha256(imageRead.buffer), sha256(fixtures.imageA));

  // 文件消息 + 附件 + 读取字节一致
  const fileMessage = body.items.find((item) => (item.attachments ?? []).some((att) => att.kind === 'file'));
  assert.ok(fileMessage, '应包含文件入站消息');
  assert.equal(fileMessage.userId, userB.id);
  assert.equal(fileMessage.itemTypes, '4');
  assert.match(fileMessage.text, /文件/, '文件消息文本应为 [文件] 占位');
  const fileAttachment = fileMessage.attachments.find((att) => att.kind === 'file');
  assert.equal(fileAttachment.fileName, '入站报告.pdf');
  assert.equal(fileAttachment.mime, 'application/pdf');
  assert.equal(fileAttachment.size, fixtures.fileB.length);
  assert.equal(fileAttachment.status, 'ready');
  assert.equal(fileAttachment.url, `/api/v1/media/${fileAttachment.id}`);
  const fileRead = await e2e.getV1Media(fileAttachment.id);
  assert.equal(fileRead.status, 200);
  assert.deepEqual(fileRead.buffer, fixtures.fileB);

  // 附件未鉴权 → 401
  const noAuthRead = await e2e.request('GET', `/api/v1/media/${imageAttachment.id}`);
  assert.equal(noAuthRead.status, 401, '未鉴权读取附件应 401');
});

test('cursor 分页：limit/hasMore/nextCursor，增量拉取不重复不遗漏', async () => {
  const all = await fetchAllInbound({ limit: 200 });
  const allIds = all.items.map((item) => item.id);
  assert.equal(allIds.length, 5);

  // limit=1：只返回 1 条且 hasMore=true
  const onePage = await e2e.getV1InboundMessages({ limit: 1 });
  assert.equal(onePage.status, 200);
  assert.equal(onePage.json.items.length, 1);
  assert.equal(onePage.json.hasMore, true);
  assert.ok(onePage.json.nextCursor, 'hasMore=true 时应返回 nextCursor');

  // 逐页翻完：每页 limit=2
  const pageIds = [];
  let cursor;
  let hasMore = true;
  let pages = 0;
  while (hasMore) {
    const page = await e2e.getV1InboundMessages({ limit: 2, cursor });
    assert.equal(page.status, 200, `cursor 翻页失败：${page.status} ${page.text}`);
    assert.ok(page.json.items.length <= 2);
    pageIds.push(...page.json.items.map((item) => item.id));
    hasMore = page.json.hasMore;
    if (hasMore) {
      assert.ok(page.json.nextCursor, 'hasMore=true 时应返回 nextCursor');
      cursor = page.json.nextCursor;
    } else if (page.json.nextCursor) {
      cursor = page.json.nextCursor;
    }
    pages += 1;
    assert.ok(pages <= 10, '翻页次数异常');
  }
  assert.equal(pageIds.length, allIds.length, 'cursor 翻页条数应与全量一致');
  assert.equal(new Set(pageIds).size, allIds.length, 'cursor 翻页不应重复');
  assert.deepEqual(pageIds, allIds, 'cursor 翻页应按 ASC 不遗漏');

  // 用最后游标再次拉取 → 空 items、hasMore=false
  assert.ok(cursor, '有数据时应得到非空 nextCursor');
  const emptyPage = await e2e.getV1InboundMessages({ limit: 10, cursor });
  assert.equal(emptyPage.status, 200);
  assert.deepEqual(emptyPage.json.items, []);
  assert.equal(emptyPage.json.hasMore, false);
});

test('since 过滤（独占）：仅返回 received_at > since', async () => {
  const all = (await e2e.getV1InboundMessages({ limit: 200 })).json.items;
  assert.equal(all.length, 5);
  // fixture 顺序注入保证 receivedAt 单调递增
  assert.ok(all[0].receivedAt <= all[1].receivedAt);
  const since = all[1].receivedAt;
  const expected = all.filter((item) => item.receivedAt > since).map((item) => item.id);
  assert.ok(expected.length >= 1, '测试数据应存在 receivedAt > since 的消息');

  const filtered = await e2e.getV1InboundMessages({ since, limit: 200 });
  assert.equal(filtered.status, 200, `since 过滤失败：${filtered.status} ${filtered.text}`);
  assert.deepEqual(filtered.json.items.map((item) => item.id), expected, 'since 过滤应独占且不遗漏');
  assert.ok(filtered.json.items.every((item) => item.receivedAt > since));

  // since=0 → 返回全部
  const fromZero = await e2e.getV1InboundMessages({ since: 0, limit: 200 });
  assert.equal(fromZero.status, 200);
  assert.equal(fromZero.json.items.length, all.length);
});

test('userId / groupId 过滤，未知用户/分组返回空', async () => {
  const all = (await e2e.getV1InboundMessages({ limit: 200 })).json.items;

  const byUserA = await e2e.getV1InboundMessages({ userId: userA.id, limit: 200 });
  assert.equal(byUserA.status, 200);
  assert.deepEqual(
    byUserA.json.items.map((item) => item.id),
    all.filter((item) => item.userId === userA.id).map((item) => item.id),
  );
  assert.ok(byUserA.json.items.every((item) => item.userId === userA.id));

  const byUserB = await e2e.getV1InboundMessages({ userId: userB.id, limit: 200 });
  assert.equal(byUserB.status, 200);
  assert.equal(byUserB.json.items.length, 2, '用户 B 应有 2 条入站消息（文本+文件）');
  assert.ok(byUserB.json.items.every((item) => item.userId === userB.id));

  // groupId：只有 A 在 groupA 中
  const byGroup = await e2e.getV1InboundMessages({ groupId: groupA.id, limit: 200 });
  assert.equal(byGroup.status, 200);
  assert.deepEqual(
    byGroup.json.items.map((item) => item.id),
    all.filter((item) => item.userId === userA.id).map((item) => item.id),
    'groupId 过滤应只返回该分组用户（A）的消息',
  );

  const unknownUser = await e2e.getV1InboundMessages({ userId: 'u_not_exists_e2e', limit: 200 });
  assert.equal(unknownUser.status, 200);
  assert.deepEqual(unknownUser.json.items, []);

  const unknownGroup = await e2e.getV1InboundMessages({ groupId: 'grp_not_exists_e2e', limit: 200 });
  assert.equal(unknownGroup.status, 200);
  assert.deepEqual(unknownGroup.json.items, []);
});

test('参数校验 400 与鉴权 401', async () => {
  const invalidQueries = [
    { limit: 0 },
    { limit: 201 },
    { limit: 'abc' },
    { wait: 31 },
    { wait: -1 },
    { since: 'not-a-number' },
    { cursor: 'not-a-valid-cursor' },
    { cursor: Buffer.from('{"x":1}').toString('base64url') },
  ];
  for (const query of invalidQueries) {
    const res = await e2e.getV1InboundMessages(query);
    assert.equal(res.status, 400, `非法参数应 400（${JSON.stringify(query)}）：${res.status} ${res.text}`);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
  }

  // 无鉴权 / 错误 API Key → 401
  const noAuth = await e2e.request('GET', '/api/v1/inbound/messages');
  assert.equal(noAuth.status, 401, '未鉴权访问入站消息 API 应 401');
  assert.equal(noAuth.json.error.code, 'UNAUTHORIZED');
  const badKey = await e2e.getV1InboundMessages({ token: 'wrong-token' });
  assert.equal(badKey.status, 401);
  assert.equal(badKey.json.error.code, 'UNAUTHORIZED');
});

test('wait 长轮询：无新消息时 wait=1 返回空 items 且等待 ≥~0.9s', async () => {
  const all = (await e2e.getV1InboundMessages({ limit: 200 })).json;
  const lastCursor = all.nextCursor;
  assert.ok(lastCursor, '已有数据时应返回 nextCursor');

  const startedAt = Date.now();
  const res = await e2e.getV1InboundMessages({ cursor: lastCursor, limit: 50, wait: 1, timeoutMs: 8000 });
  const elapsed = Date.now() - startedAt;
  assert.equal(res.status, 200, `wait=1 查询失败：${res.status} ${res.text}`);
  assert.deepEqual(res.json.items, [], '无新消息时 wait 应返回空 items');
  assert.equal(res.json.hasMore, false);
  assert.ok(res.json.nextCursor === lastCursor || res.json.nextCursor === null, '超时时应原样返回传入游标或 null');
  assert.ok(elapsed >= 900, `wait=1 应至少等待约 0.9s，实际 ${elapsed}ms`);
  assert.ok(elapsed <= 5000, `wait=1 总时长不应明显超过 wait+1s，实际 ${elapsed}ms`);
});

test('wait 长轮询：并发注入新消息时在等待窗口内及时返回，增量不重复', async () => {
  const base = (await e2e.getV1InboundMessages({ limit: 200 })).json;
  const cursor = base.nextCursor;
  assert.ok(cursor, '已有数据时应返回 nextCursor');

  const waitText = 'inbound-wait-concurrent';
  const startedAt = Date.now();
  const pending = e2e.getV1InboundMessages({ cursor, limit: 50, wait: 3, timeoutMs: 8000 });
  await sleep(400);
  await e2e.mockInbound(accountA.botId, {
    text: waitText,
    context_token: 'ctx-wait-concurrent',
    message_id: uniqueMessageId(),
  });
  const res = await pending;
  const elapsed = Date.now() - startedAt;

  assert.equal(res.status, 200, `并发注入 wait 查询失败：${res.status} ${res.text}`);
  assert.ok(
    res.json.items.some((item) => item.text === waitText),
    `wait 长轮询应返回并发注入的新消息：${JSON.stringify(res.json.items.map((item) => item.text))}`,
  );
  assert.ok(elapsed < 3000, `应在 wait=3 超时前返回，实际 ${elapsed}ms`);
  assert.ok(elapsed >= 200, `应确有等待，实际 ${elapsed}ms`);

  // 增量：使用返回的 nextCursor 再拉取 → 空（不重复）
  const nextCursor = res.json.nextCursor;
  if (nextCursor) {
    const after = await e2e.getV1InboundMessages({ cursor: nextCursor, limit: 50 });
    assert.equal(after.status, 200);
    assert.deepEqual(after.json.items, [], '用最新 nextCursor 再拉取不应重复返回已消费消息');
  }

  // 新消息已落库：按 userId 过滤应能查到
  const byUser = await e2e.getV1InboundMessages({ userId: userA.id, limit: 200 });
  assert.ok(byUser.json.items.some((item) => item.text === waitText));
});
