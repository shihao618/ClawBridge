/**
 * e2e：24h 会话保活（docs/KEEPALIVE.md §2/§3/§4/§6，压缩时间参数）。
 *
 * 启动参数：KEEPALIVE_ENABLED=1、WINDOW=8000ms、LEAD=3000ms、TICK=300ms
 *   → 最后一条入站消息年龄 ≥5s 且 <8s 时触发；tick 300ms，最多 ~6s 内投递。
 * 覆盖：
 *  - 配置/概览字段、PATCH 鉴权 401/CSRF 403、参数校验 400、用户/分组 404；
 *  - 开启保活后自动发送：{name} 模板渲染、mock 收到、outbox source=keepalive 且 sent、keepaliveLastSentAt 更新；
 *  - 同一窗口不重复；用户回复后新窗口再次触发；
 *  - 未开启保活的用户不触发；分组批量开启后组内用户触发；
 *  - 从未有入站消息的用户不触发；窗口已过期（开启也不发送）不触发。
 *
 * 全部随机端口 + 临时 DATA_DIR 子进程，不触碰真实容器（127.0.0.1:3000）。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { sleep, startE2E, waitFor } from '../helpers/e2e-env.mjs';

const KEEPALIVE_WINDOW_MS = 8000;
const KEEPALIVE_LEAD_MS = 3000;
const KEEPALIVE_TICK_MS = 300;
/** 触发条件：age >= window - lead = 5000ms；窗口 8000ms 内。 */
const KEEPALIVE_TRIGGER_AGE_MS = KEEPALIVE_WINDOW_MS - KEEPALIVE_LEAD_MS;
const KEEPALIVE_TEXT_TEMPLATE = '【保活】{name}，回复任意内容即可继续接收通知。';

const renderKeepaliveText = (name) => KEEPALIVE_TEXT_TEMPLATE.replace(/\{name\}/g, name);

let e2e;
let userA;
let userB;
let userC;
let userD;
let userE;
let accountA;
let accountC;
let groupC;
let seq = 0;

function uniqueText(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

function uniqueMessageId() {
  seq += 1;
  return (BigInt(Date.now()) * 1000n + BigInt(seq)).toString();
}

/** 注入一条入站消息并等待落库（刷新 last_inbound_at / 会话窗口）。 */
async function injectInbound(user, account, text) {
  await e2e.mockInbound(account.botId, {
    text,
    context_token: `ctx-${text}`,
    message_id: uniqueMessageId(),
  });
  await e2e.waitInboundText(user.id, text);
}

/** 等待某用户 lastInboundAt 年龄到达 targetAgeMs（基于服务端时间戳，避免固定 sleep 误差）。 */
async function sleepUntilInboundAge(userId, targetAgeMs) {
  const detail = await e2e.waitUser(userId, (data) => data.user.lastInboundAt > 0);
  const remaining = targetAgeMs - (Date.now() - detail.user.lastInboundAt);
  if (remaining > 0) await sleep(remaining);
  return detail;
}

/** 统计 mock 侧发给某用户、包含“【保活】”的文本消息条数。 */
function keepaliveCountFor(user) {
  return e2e.countMockSentMessagesContaining('【保活】', { toUserId: user.wechatUserId });
}

before(async () => {
  e2e = await startE2E({
    appEnv: {
      KEEPALIVE_ENABLED: '1',
      KEEPALIVE_WINDOW_MS: String(KEEPALIVE_WINDOW_MS),
      KEEPALIVE_LEAD_MS: String(KEEPALIVE_LEAD_MS),
      KEEPALIVE_TICK_MS: String(KEEPALIVE_TICK_MS),
      KEEPALIVE_TEXT: KEEPALIVE_TEXT_TEMPLATE,
      KEEPALIVE_MAX_PER_TICK: '100',
      RATE_LIMIT_MAX: '50',
      DISPATCH_TICK_MS: '50',
    },
  });
  await e2e.ensureAdmin();

  const a = await e2e.bindUser({ displayName: '保活用户A', waitMonitor: true });
  userA = a.user;
  accountA = a.account;
  const b = await e2e.bindUser({ displayName: '保活关闭用户B', waitMonitor: true });
  userB = b.user;
  const c = await e2e.bindUser({ displayName: '保活分组用户C', waitMonitor: true });
  userC = c.user;
  accountC = c.account;
  const d = await e2e.bindUser({ displayName: '保活无入站用户D', waitMonitor: true });
  userD = d.user;
  const e = await e2e.bindUser({ displayName: '保活过期用户E', waitMonitor: true });
  userE = e.user;

  // B：用于「未开启保活（窗口有效期内）不触发」；E：用于「窗口已过期不触发」（到用例时已过期）。
  await injectInbound(userB, b.account, uniqueText('inbound-B'));
  await injectInbound(userE, e.account, uniqueText('inbound-E'));

  const created = await e2e.createGroup({ name: '保活测试组', description: 'keepalive e2e', color: '#07C160' });
  assert.equal(created.status, 201, `创建分组失败：${created.status} ${created.text}`);
  groupC = created.json.group;
  const assigned = await e2e.assignUserGroups(userC.id, [groupC.id]);
  assert.equal(assigned.status, 200, `分配分组失败：${assigned.status} ${assigned.text}`);
});

after(async () => {
  await e2e?.cleanup();
});

test('配置/概览字段 + 鉴权与参数校验（401/403/400/404）', async () => {
  await e2e.ensureAdmin();

  // 运行配置字段（压缩后的时间参数）
  const config = await e2e.getConfig();
  assert.equal(config.status, 200, `GET /api/admin/config 失败：${config.status} ${config.text}`);
  const keepaliveConfig = config.json.keepalive;
  assert.ok(keepaliveConfig, 'config 应包含 keepalive 配置');
  assert.equal(keepaliveConfig.enabled, true);
  assert.equal(keepaliveConfig.windowMs, KEEPALIVE_WINDOW_MS);
  assert.equal(keepaliveConfig.leadMs, KEEPALIVE_LEAD_MS);
  assert.equal(keepaliveConfig.tickMs, KEEPALIVE_TICK_MS);
  assert.equal(keepaliveConfig.maxPerTick, 100);
  assert.equal(typeof keepaliveConfig.text, 'string');
  assert.ok(keepaliveConfig.text.includes('{name}'), 'config.text 应为含 {name} 的模板');

  // 概览统计初始值
  const overview = await e2e.getOverview();
  assert.equal(overview.status, 200, `GET /api/admin/overview 失败：${overview.status} ${overview.text}`);
  assert.equal(overview.json.stats.keepaliveEnabledUsers, 0, '初始应无开启保活的用户');
  assert.equal(overview.json.stats.keepaliveSent24h, 0, '初始应无保活发送记录');

  const userUrl = `/api/admin/users/${userA.id}/keepalive`;
  // 未登录 → 401
  const noAuth = await e2e.request('PATCH', userUrl, { body: { enabled: true } });
  assert.equal(noAuth.status, 401, `未登录应 401：${noAuth.status} ${noAuth.text}`);
  assert.equal(noAuth.json.error.code, 'UNAUTHORIZED');
  // 已登录但缺 CSRF 头 → 403
  const noCsrf = await e2e.adminRequest('PATCH', userUrl, { body: { enabled: true } });
  assert.equal(noCsrf.status, 403, `缺 X-Requested-With 应 403：${noCsrf.status} ${noCsrf.text}`);
  // enabled 非 boolean / 缺失 → 400
  for (const body of [{ enabled: 'true' }, { enabled: 1 }, {}]) {
    const res = await e2e.adminWrite('PATCH', userUrl, body);
    assert.equal(res.status, 400, `非法 enabled 应 400（${JSON.stringify(body)}）：${res.status} ${res.text}`);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
  }
  // 用户不存在 → 404
  const missingUser = await e2e.adminWrite('PATCH', '/api/admin/users/u_not_exists_e2e/keepalive', { enabled: true });
  assert.equal(missingUser.status, 404, `用户不存在应 404：${missingUser.status} ${missingUser.text}`);
  assert.equal(missingUser.json.error.code, 'NOT_FOUND');

  // 分组批量接口：未登录 401、不存在 404、enabled 非 boolean 400
  const missingGroupUrl = '/api/admin/groups/grp_not_exists_e2e/keepalive';
  const groupNoAuth = await e2e.request('POST', missingGroupUrl, { body: { enabled: true } });
  assert.equal(groupNoAuth.status, 401, '未登录分组保活应 401');
  const groupMissing = await e2e.adminWrite('POST', missingGroupUrl, { enabled: true });
  assert.equal(groupMissing.status, 404, `分组不存在应 404：${groupMissing.status} ${groupMissing.text}`);
  const groupBadBody = await e2e.adminWrite('POST', `/api/admin/groups/${groupC.id}/keepalive`, { enabled: 'yes' });
  assert.equal(groupBadBody.status, 400, `分组 enabled 非 boolean 应 400：${groupBadBody.status} ${groupBadBody.text}`);
});

test('未开启保活的用户不触发（窗口有效期内也不发送）', async () => {
  await e2e.ensureAdmin();
  // 等 B 的入站窗口进入可触发区间（age ≥5s），但 B 未开启保活 → 不应发送
  await sleepUntilInboundAge(userB.id, KEEPALIVE_TRIGGER_AGE_MS + 400);
  const detail = await e2e.adminGet(`/api/admin/users/${userB.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.user.keepaliveEnabled, false, 'B 应保持未开启保活');
  const age = Date.now() - detail.json.user.lastInboundAt;
  assert.ok(age >= KEEPALIVE_TRIGGER_AGE_MS, `B 的窗口应已进入可触发区间（age=${age}ms）`);
  assert.ok(age < KEEPALIVE_WINDOW_MS, `B 的窗口应仍有效（age=${age}ms）`);

  assert.equal(await keepaliveCountFor(userB), 0, '未开启保活的用户不应收到保活消息');
  await sleep(900);
  assert.equal(await keepaliveCountFor(userB), 0, '未开启保活的用户不应收到保活消息（等待后仍无）');
  const messages = await e2e.adminGet(`/api/admin/messages?direction=outbound&userId=${userB.id}&limit=50`);
  assert.equal(messages.status, 200);
  assert.equal(
    (messages.json.items ?? []).some((row) => row.source === 'keepalive'),
    false,
    '未开启保活的用户不应有 source=keepalive 的出站消息',
  );
});

test('开启保活后：窗口临近时自动发送（{name} 渲染 / mock 收到 / outbox source=keepalive 且 sent）', async () => {
  await e2e.ensureAdmin();

  // 用户 A：注入新鲜入站消息作为窗口起点，再开启保活
  await injectInbound(userA, accountA, uniqueText('inbound-A'));
  const enable = await e2e.setUserKeepalive(userA.id, true);
  assert.equal(enable.status, 200, `开启保活应 200：${enable.status} ${enable.text}`);
  assert.equal(enable.json.user.keepaliveEnabled, true);
  assert.equal(enable.json.user.keepaliveLastSentAt, 0);

  const expectedText = renderKeepaliveText('保活用户A');
  const startedAt = Date.now();
  const record = await e2e.waitMockSentMessageContaining('【保活】', {
    toUserId: userA.wechatUserId,
    timeoutMs: 9000,
    label: 'mock 收到用户 A 的保活消息',
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(record.text, expectedText, '{name} 应渲染为绑定用户昵称');
  assert.deepEqual(record.itemTypes, [1]);
  assert.equal(record.toUserId, userA.wechatUserId);
  assert.ok(elapsed <= 6500, `保活应在窗口触发后 ~6s 内投递，实际 ${elapsed}ms`);

  // 后台消息记录：source=keepalive、status=sent
  const keepaliveMessage = await e2e.waitAdminMessage(
    (row) =>
      row.direction === 'outbound' &&
      row.source === 'keepalive' &&
      row.userId === userA.id &&
      row.text === expectedText &&
      row.status === 'sent',
    { direction: 'outbound', timeoutMs: 8000, label: '后台保活消息 source=keepalive 且 sent' },
  );
  const outbox = await e2e.waitOutbox(keepaliveMessage.id, 'sent');
  assert.equal(outbox.status, 'sent');
  assert.ok(outbox.attempts >= 1);

  // 用户视图 keepaliveLastSentAt 已更新
  const detail = await e2e.waitUser(userA.id, (data) => data.user.keepaliveLastSentAt > 0);
  assert.equal(detail.user.keepaliveEnabled, true);

  // 概览统计
  const overview = await e2e.getOverview();
  assert.ok(overview.json.stats.keepaliveEnabledUsers >= 1, 'keepaliveEnabledUsers 应 ≥1');
  assert.ok(overview.json.stats.keepaliveSent24h >= 1, 'keepaliveSent24h 应 ≥1');
});

test('同一会话窗口内不重复发送', async () => {
  assert.equal(await keepaliveCountFor(userA), 1, '上一用例应恰好发送 1 条保活');
  await sleep(1600); // > 1 个 tick，仍在同一窗口内
  assert.equal(await keepaliveCountFor(userA), 1, '同一窗口不应重复发送保活消息');

  const messages = await e2e.adminGet(`/api/admin/messages?direction=outbound&userId=${userA.id}&limit=100`);
  assert.equal(messages.status, 200);
  assert.equal(
    (messages.json.items ?? []).filter((row) => row.source === 'keepalive').length,
    1,
    '同一窗口后台应只有 1 条 keepalive 出站消息',
  );
});

test('用户再次发消息后进入新窗口，可再次触发保活', async () => {
  await e2e.ensureAdmin();
  const beforeDetail = await e2e.adminGet(`/api/admin/users/${userA.id}`);
  const previousSentAt = beforeDetail.json.user.keepaliveLastSentAt;
  assert.ok(previousSentAt > 0);

  // 用户 A 再次发消息 → last_inbound_at 刷新 → 新窗口
  await injectInbound(userA, accountA, uniqueText('inbound-A-reply'));

  await waitFor(async () => (await keepaliveCountFor(userA)) >= 2, {
    timeoutMs: 9000,
    label: '新窗口 mock 收到用户 A 第二条保活消息',
  });
  assert.equal(await keepaliveCountFor(userA), 2, '新窗口应恰好再触发一次保活');

  const detail = await e2e.waitUser(userA.id, (data) => data.user.keepaliveLastSentAt > previousSentAt);
  assert.ok(detail.user.keepaliveLastSentAt > previousSentAt, 'keepaliveLastSentAt 应更新到新窗口');

  // 后台出现第二条 source=keepalive 记录且 sent
  const adminMessages = await waitFor(
    async () => {
      const res = await e2e.adminGet(`/api/admin/messages?direction=outbound&userId=${userA.id}&limit=100`);
      assert.equal(res.status, 200);
      const keepaliveRows = (res.json.items ?? []).filter((row) => row.source === 'keepalive');
      return keepaliveRows.length >= 2 && keepaliveRows.every((row) => row.status === 'sent') ? res : null;
    },
    { timeoutMs: 8000, label: '后台出现第二条 keepalive 且 sent' },
  );
  assert.ok((adminMessages.json.items ?? []).filter((row) => row.source === 'keepalive').length >= 2);
});

test('分组批量开启保活：组内用户自动触发', async () => {
  await e2e.ensureAdmin();
  // C 注入新鲜入站消息（此前保活未开启）
  await injectInbound(userC, accountC, uniqueText('inbound-C'));

  const enabled = await e2e.setGroupKeepalive(groupC.id, true);
  assert.equal(enabled.status, 200, `分组批量开启保活应 200：${enabled.status} ${enabled.text}`);
  assert.equal(typeof enabled.json.updated, 'number');
  assert.ok(enabled.json.updated >= 1, `分组批量开启应更新至少 1 个用户，实际 ${enabled.json.updated}`);
  assert.equal(enabled.json.group.id, groupC.id);

  // C 的 keepaliveEnabled 已变为 true
  const cDetail = await e2e.waitUser(userC.id, (data) => data.user.keepaliveEnabled === true);
  assert.equal(cDetail.user.keepaliveEnabled, true);

  const expectedText = renderKeepaliveText('保活分组用户C');
  await waitFor(async () => (await keepaliveCountFor(userC)) >= 1, {
    timeoutMs: 9000,
    label: '分组批量开启后 mock 收到 C 的保活消息',
  });
  const record = await e2e.waitMockSentMessageContaining('【保活】保活分组用户C', {
    toUserId: userC.wechatUserId,
    timeoutMs: 5000,
  });
  assert.equal(record.text, expectedText);

  const keepaliveMessage = await e2e.waitAdminMessage(
    (row) =>
      row.direction === 'outbound' &&
      row.source === 'keepalive' &&
      row.userId === userC.id &&
      row.status === 'sent',
    { direction: 'outbound', timeoutMs: 8000, label: '分组批量保活的后台消息记录' },
  );
  assert.equal(keepaliveMessage.text, expectedText);

  const overview = await e2e.getOverview();
  assert.ok(overview.json.stats.keepaliveEnabledUsers >= 2, 'A/C 开启后 keepaliveEnabledUsers 应 ≥2');
});

test('从未有入站消息的用户不触发保活', async () => {
  await e2e.ensureAdmin();
  const detail = await e2e.adminGet(`/api/admin/users/${userD.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.user.lastInboundAt, 0, '用户 D 应从未有入站消息');

  const enable = await e2e.setUserKeepalive(userD.id, true);
  assert.equal(enable.status, 200);
  assert.equal(enable.json.user.keepaliveEnabled, true);

  await sleep(1300);
  assert.equal(await keepaliveCountFor(userD), 0, '从未入站的用户不应收到保活消息');
  const messages = await e2e.adminGet(`/api/admin/messages?direction=outbound&userId=${userD.id}&limit=50`);
  assert.equal(messages.status, 200);
  assert.equal((messages.json.items ?? []).length, 0, '用户 D 不应有出站消息');
});

test('窗口已过期不触发（过期后再开启也不发送）', async () => {
  await e2e.ensureAdmin();
  // 用户 E 的入站消息在 before 注入，此时窗口应已过期
  const expired = await waitFor(
    async () => {
      const res = await e2e.adminGet(`/api/admin/users/${userE.id}`);
      if (res.status !== 200) return null;
      const { lastInboundAt, keepaliveEnabled } = res.json.user;
      return lastInboundAt > 0 && Date.now() - lastInboundAt > KEEPALIVE_WINDOW_MS + 300
        ? { lastInboundAt, keepaliveEnabled }
        : null;
    },
    { timeoutMs: 5000, label: '用户 E 的会话窗口过期' },
  );
  assert.equal(expired.keepaliveEnabled, false);

  const enable = await e2e.setUserKeepalive(userE.id, true);
  assert.equal(enable.status, 200);
  await sleep(1300);
  assert.equal(await keepaliveCountFor(userE), 0, '窗口已过期的用户不应收到保活消息');

  const detail = await e2e.waitUser(userE.id, (data) => data.user.keepaliveEnabled === true);
  assert.equal(detail.user.keepaliveLastSentAt, 0, '过期窗口开启保活后 keepaliveLastSentAt 应保持 0');
});
