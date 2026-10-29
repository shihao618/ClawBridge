/**
 * 后端单元测试：ilink 请求头与 JSON 无损解析（纯函数，无网络请求）。
 * 传输层端点行为由 lead 的 tests/unit/lead-core.test.mjs 用本地假服务覆盖。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-ilink-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'ilink-test-app-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'ilink-test-password';
process.env.API_TOKEN = 'ilink-test-api-token';
process.env.LOG_LEVEL = 'silent';
process.env.BOT_AGENT = 'ClawBridge/1.0.0';

const ilink = await import('../../server/src/ilink.js');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('ilink.buildHeaders: 公共头 + 随机 X-WECHAT-UIN + 鉴权头', () => {
  const headers = ilink.buildHeaders();
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['iLink-App-Id'], 'bot');
  assert.equal(headers['iLink-App-ClientVersion'], '132106');
  assert.equal(headers.Authorization, undefined, '二维码接口不带鉴权头');
  assert.equal(headers.AuthorizationType, undefined);

  const uin = Buffer.from(headers['X-WECHAT-UIN'], 'base64').toString('utf8');
  assert.match(uin, /^\d+$/, 'X-WECHAT-UIN 应为十进制 uint32 的 base64');
  assert.ok(Number(uin) >= 0 && Number(uin) <= 0xffffffff);

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
  assert.match(message.client_id, /^clawbridge-/);

  const withoutContext = ilink.buildTextMessage({ toUserId: 'wx_user', text: 'x' });
  assert.equal('context_token' in withoutContext, false, '无 context_token 时不应携带该字段');
});

test('ilink.sanitizeBotAgent / createClientId', () => {
  assert.equal(ilink.sanitizeBotAgent('OpenClaw'), 'OpenClaw');
  assert.equal(ilink.sanitizeBotAgent('bad agent!!'), 'OpenClaw');
  assert.equal(ilink.sanitizeBotAgent(undefined), 'OpenClaw');
  const a = ilink.createClientId();
  const b = ilink.createClientId();
  assert.notEqual(a, b);
  assert.match(a, /^clawbridge-[0-9a-f-]{36}$/);
});
