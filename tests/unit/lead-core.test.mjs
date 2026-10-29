/**
 * Lead 核心模块单元测试：config / crypto / ilink 协议客户端。
 * 使用独立临时 DATA_DIR，避免污染仓库 data/ 目录。
 * （.mjs 后缀确保 Node 测试运行器识别为 ESM，与 package.json type=module 等价。）
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 必须在 import 业务模块之前设置环境变量（config 模块加载即求值）
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawbridge-lead-'));
process.env.DATA_DIR = tmpDir;
process.env.APP_SECRET = 'test-app-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.API_TOKEN = 'test-api-token';
process.env.LOG_LEVEL = 'error';
process.env.ILINK_LOGIN_BASE_URL = 'http://127.0.0.1:9';
process.env.ILINK_BASE_URL = 'http://127.0.0.1:9';

const { loadConfig } = await import('../../server/src/config.js');
const cryptoMod = await import('../../server/src/crypto.js');
const ilink = await import('../../server/src/ilink.js');

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test('config: 默认值与环境变量覆盖', () => {
  const tmp = path.join(tmpDir, 'cfg-default');
  const cfg = loadConfig({ DATA_DIR: tmp, APP_SECRET: 's', ADMIN_PASSWORD: 'p', API_TOKEN: 't' });
  assert.equal(cfg.port, 10380);
  assert.equal(cfg.ilink.loginBaseUrl, 'https://ilinkai.weixin.qq.com');
  assert.equal(cfg.ilink.appId, 'bot');
  assert.equal(cfg.ilink.clientVersion, 132106);
  assert.equal(cfg.push.rateLimitMax, 7);
  assert.equal(cfg.push.rateLimitWindowMs, 300000);
  assert.equal(cfg.binding.maxRefreshes, 3);
  assert.deepEqual(cfg.push.retryDelaysMs, [5000, 15000, 30000, 60000]);
  assert.equal(cfg.pushApiEnabled, true);

  const cfg2 = loadConfig({
    DATA_DIR: tmp,
    APP_SECRET: 's',
    ADMIN_PASSWORD: 'p',
    API_TOKEN: 't',
    PORT: '4567',
    RATE_LIMIT_MAX: '3',
    PUSH_RETRY_DELAYS_MS: '100, 250',
    ILINK_BASE_URL: 'http://127.0.0.1:3100/',
  });
  assert.equal(cfg2.port, 4567);
  assert.equal(cfg2.push.rateLimitMax, 3);
  assert.deepEqual(cfg2.push.retryDelaysMs, [100, 250]);
  assert.equal(cfg2.ilink.defaultBaseUrl, 'http://127.0.0.1:3100');
});

test('config: APP_SECRET 自动生成并持久化；管理密码/API Token 不再由 config 生成', async () => {
  const tmp = path.join(tmpDir, 'cfg-auto');
  const cfgA = loadConfig({ DATA_DIR: tmp });
  assert.ok(cfgA.secrets.appSecret.length >= 32);
  assert.equal(cfgA.secrets.adminPassword, '');
  assert.equal(cfgA.secrets.apiToken, '');
  assert.equal(cfgA.secrets.adminPasswordAuto, false);
  assert.equal(cfgA.secrets.apiTokenAuto, false);
  const secretFile = path.join(tmp, 'app-secret.key');
  await fs.stat(secretFile);
  // 机密只由 settings.bootstrapSecrets()（DB）管理，config 不再生成这两个文件
  await assert.rejects(fs.stat(path.join(tmp, 'admin-password.txt')));
  await assert.rejects(fs.stat(path.join(tmp, 'api-token.txt')));
  const cfgB = loadConfig({ DATA_DIR: tmp });
  assert.equal(cfgB.secrets.appSecret, cfgA.secrets.appSecret);
});

// ---------------------------------------------------------------------------
// crypto
// ---------------------------------------------------------------------------

test('crypto: AES-256-GCM 往返、随机性与篡改检测', () => {
  const a = cryptoMod.encryptSecret('bot-token-123');
  const b = cryptoMod.encryptSecret('bot-token-123');
  assert.notEqual(a, b, '相同明文两次加密应产生不同密文（随机 IV）');
  assert.equal(cryptoMod.decryptSecret(a), 'bot-token-123');
  assert.equal(cryptoMod.decryptSecretOrNull(null), null);
  assert.equal(cryptoMod.decryptSecretOrNull('not-a-ciphertext'), null);

  const parts = a.split('.');
  const tampered = [parts[0], parts[1], parts[2], Buffer.from('evil').toString('base64url')].join('.');
  assert.throws(() => cryptoMod.decryptSecret(tampered));
});

test('crypto: hashToken / timingSafeEqualStr / session 签名', () => {
  const token = cryptoMod.randomToken(16);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(cryptoMod.hashToken(token).length, 64);
  assert.ok(cryptoMod.timingSafeEqualStr('abc', 'abc'));
  assert.ok(!cryptoMod.timingSafeEqualStr('abc', 'abd'));
  assert.ok(!cryptoMod.timingSafeEqualStr('abc', 'abcd'));

  const cookie = cryptoMod.signAdminSession({ ttlMs: 60_000 });
  const payload = cryptoMod.verifyAdminSession(cookie);
  assert.equal(payload.sub, 'admin');
  assert.ok(payload.exp > Date.now());
  assert.equal(cryptoMod.verifyAdminSession(`${cookie}x`), null);
  assert.equal(cryptoMod.verifyAdminSession(''), null);
  const expired = cryptoMod.signAdminSession({ ttlMs: -1000 });
  assert.equal(cryptoMod.verifyAdminSession(expired), null);
});

// ---------------------------------------------------------------------------
// ILink JSON 无损解析
// ---------------------------------------------------------------------------

test('ilink.parseILinkJson: uint64 字段无损、字符串内容不被改写', () => {
  const manual =
    '{"message_id":9007199254740993,"msg_id":18446744073709551615,"nested":{"message_id":1234567890123456789},"text":"message_id\\":123 and { weird } : chars","arr":[{"msg_id":9007199254740991}],"ret":0}';
  const parsed = ilink.parseILinkJson(manual);
  assert.equal(parsed.message_id, '9007199254740993');
  assert.equal(parsed.msg_id, '18446744073709551615');
  assert.equal(parsed.nested.message_id, '1234567890123456789');
  assert.equal(parsed.arr[0].msg_id, '9007199254740991');
  assert.equal(parsed.text, 'message_id":123 and { weird } : chars');
  assert.equal(parsed.ret, 0);
  assert.equal(ilink.parseILinkJson('{"a":1}').a, 1);
});

// ---------------------------------------------------------------------------
// 请求头 / 消息构造
// ---------------------------------------------------------------------------

test('ilink.buildHeaders: 公共头、随机 X-WECHAT-UIN、鉴权头', () => {
  const h1 = ilink.buildHeaders();
  assert.equal(h1['iLink-App-Id'], 'bot');
  assert.equal(h1['iLink-App-ClientVersion'], '132106');
  assert.equal(h1['Content-Type'], 'application/json');
  assert.equal(h1.Authorization, undefined);
  const decoded = Buffer.from(h1['X-WECHAT-UIN'], 'base64').toString('utf8');
  assert.match(decoded, /^\d+$/);

  const h2 = ilink.buildHeaders({ token: 'tok_abc' });
  assert.equal(h2.Authorization, 'Bearer tok_abc');
  assert.equal(h2.AuthorizationType, 'ilink_bot_token');
  const h3 = ilink.buildHeaders();
  assert.notEqual(h3['X-WECHAT-UIN'], h1['X-WECHAT-UIN'], '每次请求 UIN 应随机');
});

test('ilink.sanitizeBotAgent: 合法 UA 保留，非法回退 OpenClaw', () => {
  assert.equal(ilink.sanitizeBotAgent('ClawBridge/1.0.0'), 'ClawBridge/1.0.0');
  assert.equal(ilink.sanitizeBotAgent('OpenClaw'), 'OpenClaw');
  assert.equal(ilink.sanitizeBotAgent('bad agent;rm -rf'), 'OpenClaw');
  assert.equal(ilink.sanitizeBotAgent(''), 'OpenClaw');
  assert.equal(ilink.sanitizeBotAgent(undefined), 'OpenClaw');
  assert.equal(ilink.sanitizeBotAgent(`A/${'x'.repeat(300)}`), 'OpenClaw');
});

test('ilink.buildTextMessage: 字段与官方一致', () => {
  const msg = ilink.buildTextMessage({ toUserId: 'wx_user_1', text: 'hello', contextToken: 'ctx_1' });
  assert.equal(msg.from_user_id, '');
  assert.equal(msg.to_user_id, 'wx_user_1');
  assert.equal(msg.message_type, 2);
  assert.equal(msg.message_state, 2);
  assert.deepEqual(msg.item_list, [{ type: 1, text_item: { text: 'hello' } }]);
  assert.equal(msg.context_token, 'ctx_1');
  assert.ok(msg.client_id.startsWith('clawbridge-'));
  const noCtx = ilink.buildTextMessage({ toUserId: 'u', text: 'x' });
  assert.equal('context_token' in noCtx, false);
});

// ---------------------------------------------------------------------------
// 协议客户端（本地假 iLink 服务）
// ---------------------------------------------------------------------------

function startFakeIlink() {
  const state = {
    requests: [],
    qrStatus: { status: 'wait' },
    updatesResp: { ret: 0, msgs: [], get_updates_buf: 'buf-1' },
    sendResp: { ret: 0 },
    sendRaw: null,
    hangStatusMs: 0,
    hangUpdatesMs: 0,
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = bodyText;
    }
    state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    const sendJson = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const sendRaw = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(text);
    };

    if (req.url.startsWith('/ilink/bot/get_bot_qrcode')) {
      return sendJson(200, { qrcode: 'qr-ticket-1', qrcode_img_content: 'https://weixin.qq.com/q/mock1' });
    }
    if (req.url.startsWith('/ilink/bot/get_qrcode_status')) {
      if (state.hangStatusMs > 0) await new Promise((r) => setTimeout(r, state.hangStatusMs));
      return sendJson(200, state.qrStatus);
    }
    if (req.url.startsWith('/ilink/bot/getupdates')) {
      if (state.hangUpdatesMs > 0) await new Promise((r) => setTimeout(r, state.hangUpdatesMs));
      return sendJson(200, state.updatesResp);
    }
    if (req.url.startsWith('/ilink/bot/sendmessage')) {
      if (state.sendRaw) return sendRaw(200, state.sendRaw);
      return sendJson(200, state.sendResp);
    }
    if (req.url.startsWith('/ilink/bot/msg/notifystart')) return sendJson(200, { ret: 0 });
    if (req.url.startsWith('/ilink/bot/msg/notifystop')) return sendJson(200, { ret: 0 });
    return sendJson(404, { error: 'not found' });
  });
  return { server, state };
}

test('ilink 客户端: 各端点请求方法/路径/头/body 正确', async () => {
  const { server, state } = startFakeIlink();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const qr = await ilink.getBotQrcode({ baseUrl: base, localTokenList: ['t1', 't2'] });
    assert.equal(qr.qrcode, 'qr-ticket-1');
    assert.equal(qr.qrcode_img_content, 'https://weixin.qq.com/q/mock1');
    const qrReq = state.requests.at(-1);
    assert.equal(qrReq.method, 'POST');
    assert.match(qrReq.url, /\/ilink\/bot\/get_bot_qrcode\?bot_type=3/);
    assert.deepEqual(qrReq.body, { local_token_list: ['t1', 't2'] });
    assert.equal(qrReq.headers['ilink-app-id'], 'bot');

    state.qrStatus = { status: 'scaned' };
    const st = await ilink.getQrcodeStatus({ baseUrl: base, qrcode: 'qr-ticket-1', verifyCode: '1234', timeoutMs: 2000 });
    assert.equal(st.status, 'scaned');
    const stReq = state.requests.at(-1);
    assert.equal(stReq.method, 'GET');
    assert.match(stReq.url, /qrcode=qr-ticket-1/);
    assert.match(stReq.url, /verify_code=1234/);

    const upd = await ilink.getUpdates({ baseUrl: base, token: 'tok', getUpdatesBuf: 'buf-0', timeoutMs: 2000 });
    assert.equal(upd.get_updates_buf, 'buf-1');
    const updReq = state.requests.at(-1);
    assert.equal(updReq.headers.authorization, 'Bearer tok');
    assert.equal(updReq.headers.authorizationtype, 'ilink_bot_token');
    assert.equal(updReq.body.get_updates_buf, 'buf-0');
    assert.ok(updReq.body.base_info.channel_version);
    assert.ok(updReq.body.base_info.bot_agent);

    // 真实服务端会返回超过 2^53 的 uint64 数字字面量，这里用原始 JSON 文本模拟
    state.sendRaw = '{"ret":0,"message_id":9007199254740993,"errmsg":""}';
    const sent = await ilink.sendText({ baseUrl: base, token: 'tok', toUserId: 'wx1', text: 'hi', contextToken: 'ctx', timeoutMs: 2000 });
    assert.equal(sent.message_id, '9007199254740993', 'message_id 必须无损解析为字符串');
    const sendReq = state.requests.at(-1);
    assert.equal(sendReq.url, '/ilink/bot/sendmessage');
    assert.equal(sendReq.body.msg.to_user_id, 'wx1');
    assert.equal(sendReq.body.msg.from_user_id, '');
    assert.equal(sendReq.body.msg.message_type, 2);
    assert.equal(sendReq.body.msg.message_state, 2);
    assert.equal(sendReq.body.msg.context_token, 'ctx');
    assert.deepEqual(sendReq.body.msg.item_list, [{ type: 1, text_item: { text: 'hi' } }]);
    assert.ok(sendReq.body.base_info);

    await ilink.notifyStart({ baseUrl: base, token: 'tok' });
    assert.equal(state.requests.at(-1).url, '/ilink/bot/msg/notifystart');
    await ilink.notifyStop({ baseUrl: base, token: 'tok' });
    assert.equal(state.requests.at(-1).url, '/ilink/bot/msg/notifystop');
  } finally {
    server.close();
  }
});

test('ilink 客户端: 业务错误与超时语义', async () => {
  const { server, state } = startFakeIlink();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    state.sendResp = { ret: -2, errmsg: 'rate limited' };
    await assert.rejects(
      () => ilink.sendText({ baseUrl: base, token: 'tok', toUserId: 'u', text: 'x', timeoutMs: 2000 }),
      (err) => err.name === 'ILinkError' && err.ret === -2 && err.errmsg === 'rate limited',
    );

    state.sendResp = { ret: -14, errmsg: 'stale token' };
    await assert.rejects(
      () => ilink.sendText({ baseUrl: base, token: 'tok', toUserId: 'u', text: 'x', timeoutMs: 2000 }),
      (err) => err.name === 'ILinkError' && err.ret === -14,
    );

    // getQrcodeStatus 超时 → ILinkError timeout=true
    state.hangStatusMs = 500;
    await assert.rejects(
      () => ilink.getQrcodeStatus({ baseUrl: base, qrcode: 'q', timeoutMs: 100 }),
      (err) => err.name === 'ILinkError' && err.timeout === true,
    );

    // getUpdates 超时 → 返回空响应而不是抛错
    state.hangUpdatesMs = 500;
    const r = await ilink.getUpdates({ baseUrl: base, token: 'tok', getUpdatesBuf: 'b0', timeoutMs: 100 });
    assert.deepEqual(r.msgs, []);
    assert.equal(r.get_updates_buf, 'b0');
    assert.equal(r.ret, 0);
  } finally {
    server.close();
  }
});
