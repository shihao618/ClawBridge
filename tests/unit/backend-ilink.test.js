/**
 * 后端单元测试：ilink 请求头与 JSON 无损解析（纯函数，无网络请求）。
 * 传输层端点行为由 lead 的 tests/unit/lead-core.test.mjs 用本地假服务覆盖。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-ilink-',
  env: {
    APP_SECRET: 'ilink-test-app-secret-0123456789abcdef0123456789abcdef',
    ADMIN_PASSWORD: 'ilink-test-password',
    API_TOKEN: 'ilink-test-api-token',
    LOG_LEVEL: 'silent',
    BOT_AGENT: 'ClawBridge/1.0.0',
  },
});

const ilink = await import('../../server/src/ilink.js');

test.after(async () => {
  await cleanupUnitEnv(unitEnv);
});

test('ilink.buildHeaders/buildCommonHeaders: 官方请求头矩阵（POST 完整头 / GET 仅公共头）', () => {
  const common = ilink.buildCommonHeaders();
  assert.equal(common['iLink-App-Id'], 'bot');
  assert.equal(common['iLink-App-ClientVersion'], '132106');
  assert.equal(common['Content-Type'], undefined, 'GET 公共头不含 Content-Type');
  assert.equal(common['X-WECHAT-UIN'], undefined, 'GET 公共头不含 X-WECHAT-UIN');
  assert.equal(common.AuthorizationType, undefined, 'GET 公共头不含 AuthorizationType');

  const post = ilink.buildHeaders();
  assert.equal(post['Content-Type'], 'application/json');
  assert.equal(post.AuthorizationType, 'ilink_bot_token', '未鉴权 POST（二维码）同样带 AuthorizationType');
  assert.equal(post.Authorization, undefined, '无 token 时不带 Authorization');
  const uin = Buffer.from(post['X-WECHAT-UIN'], 'base64').toString('utf8');
  assert.match(uin, /^\d+$/, 'X-WECHAT-UIN 应为十进制 uint32 的 base64');
  assert.ok(Number(uin) >= 0 && Number(uin) <= 0xffffffff);
  assert.equal(post['iLink-App-Id'], 'bot');
  assert.equal(post['iLink-App-ClientVersion'], '132106');

  const authed = ilink.buildHeaders({ token: 'tok_123' });
  assert.equal(authed.Authorization, 'Bearer tok_123');
  assert.equal(authed.AuthorizationType, 'ilink_bot_token');
  assert.equal(ilink.buildHeaders({ token: '  tok_trim  ' }).Authorization, 'Bearer tok_trim');
});

test('ilink.buildBaseInfo: channel_version / bot_agent 来自配置', () => {
  const info = ilink.buildBaseInfo();
  assert.equal(info.channel_version, '2.4.10');
  assert.equal(info.bot_agent, 'ClawBridge/1.0.0');
});

test('ilink.parseILinkJson: uint64 键无损为字符串', () => {
  const raw =
    '{"message_id":9007199254740993,"msgs":[{"msg_id":18446744073709551615,"svr_id":42}],"nested":{"message_id":1234567890123456789},"ret":0}';
  const parsed = ilink.parseILinkJson(raw);
  assert.equal(parsed.message_id, '9007199254740993');
  assert.equal(parsed.msgs[0].msg_id, '18446744073709551615');
  assert.equal(parsed.msgs[0].svr_id, '42');
  assert.equal(parsed.nested.message_id, '1234567890123456789');
  assert.equal(parsed.ret, 0, '非目标键保持数字');
});

test('ilink.parseILinkJson: 字符串内容/已为字符串的 ID 不受影响', () => {
  const raw = '{"text":"message_id\\":123 不是键","message_id":"already-string","ret":-14,"errmsg":"stale token"}';
  const parsed = ilink.parseILinkJson(raw);
  assert.equal(parsed.text, 'message_id":123 不是键');
  assert.equal(parsed.message_id, 'already-string');
  assert.equal(parsed.ret, -14);
  assert.equal(parsed.errmsg, 'stale token');
  assert.equal(ilink.parseILinkJson('{"a":1,"b":[1,2,3]}').b.length, 3);
  assert.throws(() => ilink.parseILinkJson('{bad json'), SyntaxError);
});

test('ilink.buildTextMessage: 文本消息结构与官方一致', () => {
  const message = ilink.buildTextMessage({ toUserId: 'wx_user', text: '你好', contextToken: 'ctx_1' });
  assert.equal(message.from_user_id, '');
  assert.equal(message.to_user_id, 'wx_user');
  assert.equal(message.message_type, ilink.MessageType.BOT);
  assert.equal(message.message_state, ilink.MessageState.FINISH);
  assert.deepEqual(message.item_list, [{ type: ilink.MessageItemType.TEXT, text_item: { text: '你好' } }]);
  assert.equal(message.context_token, 'ctx_1');
  assert.match(message.client_id, /^openclaw-weixin:\d{13}-[0-9a-f]{8}$/, 'client_id 应为官方格式');

  const withoutContext = ilink.buildTextMessage({ toUserId: 'wx_user', text: 'x' });
  assert.equal('context_token' in withoutContext, false, '无 context_token 时不应携带该字段');
});

test('ilink.formatWeixinText: 换行原样保留（与官方一致，不自动插空行）', () => {
  assert.equal(ilink.formatWeixinText('第一行\n第二行'), '第一行\n第二行');
  assert.equal(ilink.formatWeixinText('第一段\n\n第二段'), '第一段\n\n第二段', '已有空行保持');
  assert.equal(ilink.formatWeixinText('已含两空格  \n下一行'), '已含两空格  \n下一行');
  assert.equal(ilink.formatWeixinText('- 第一项\n- 第二项'), '- 第一项\n- 第二项', '列表原样');
  assert.equal(
    ilink.formatWeixinText('```\ncode1\ncode2\n```'),
    '```\ncode1\ncode2\n```',
    '代码块原样',
  );
  const message = ilink.buildTextMessage({ toUserId: 'wx_user', text: 'A\nB' });
  assert.equal(message.item_list[0].text_item.text, 'A\nB');
});

test('ilink.sanitizeBotAgent: 官方算法（多 product/跨空格注释/空白归一/256B 逐 token 截断）', () => {
  assert.equal(ilink.sanitizeBotAgent('OpenClaw'), 'OpenClaw');
  assert.equal(ilink.sanitizeBotAgent('  OpenClaw/2.4.10  '), 'OpenClaw/2.4.10', '空白归一');
  assert.equal(
    ilink.sanitizeBotAgent('ClawBridge/1.0.0 Chrome/120.0 (Linux x86_64)'),
    'ClawBridge/1.0.0 Chrome/120.0 (Linux x86_64)',
    '多 product + 跨空格注释',
  );
  assert.equal(ilink.sanitizeBotAgent('bad agent!!'), 'OpenClaw');
  assert.equal(ilink.sanitizeBotAgent(''), 'OpenClaw');
  assert.equal(ilink.sanitizeBotAgent(undefined), 'OpenClaw');
  // 非法/超长注释被丢弃，product 保留
  assert.equal(ilink.sanitizeBotAgent(`Product/1 (${'x'.repeat(65)})`), 'Product/1');
  assert.equal(ilink.sanitizeBotAgent('Product/1 (bad(paren))'), 'Product/1');
  // 超过 256 字节：逐个丢弃尾部 token
  const long = Array.from({ length: 40 }, (_, index) => `P${index}/1.0`).join(' ');
  const sanitized = ilink.sanitizeBotAgent(long);
  assert.ok(Buffer.byteLength(sanitized, 'utf8') <= 256, '截断后不超过 256 字节');
  assert.ok(sanitized.startsWith('P0/1.0 P1/1.0'), '保留头部 token');
  assert.equal(sanitized.includes('P39/1.0'), false, '尾部 token 被丢弃');
});

test('ilink.createClientId: 官方格式 openclaw-weixin:<ts>-<8hex>', () => {
  const a = ilink.createClientId();
  const b = ilink.createClientId();
  assert.notEqual(a, b);
  assert.match(a, /^openclaw-weixin:\d{13}-[0-9a-f]{8}$/);
});

test('ilink.TypingStatus / 官方版本派生 / 轻量 API 超时默认', async () => {
  assert.deepEqual({ ...ilink.TypingStatus }, { TYPING: 1, CANCEL: 2 });
  const { config, deriveClientVersion } = await import('../../server/src/config.js');
  assert.equal(deriveClientVersion('2.4.10'), 132106);
  assert.equal(deriveClientVersion('1.0.11'), 65547);
  assert.equal(config.ilink.channelVersion, '2.4.10');
  assert.equal(config.ilink.clientVersion, 132106, '未显式 ILINK_CLIENT_VERSION 时由 channelVersion 派生');
  assert.equal(config.ilink.appId, 'bot');
  assert.equal(config.ilink.configTimeoutMs, 10000, '轻量 API 默认超时 10s（ILINK_CONFIG_TIMEOUT_MS）');
});

test('getConfig/sendTyping 导出存在（规则「正在输入」使用，docs/PROTOCOL.md §5.6）', () => {
  assert.equal(typeof ilink.getConfig, 'function');
  assert.equal(typeof ilink.sendTyping, 'function');
});
