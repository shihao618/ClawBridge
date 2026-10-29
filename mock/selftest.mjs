#!/usr/bin/env node
/**
 * mock/ilink-mock.mjs 的自测脚本（零依赖，仅 node:http/fetch + 内置 assert）。
 *
 * 启动 mock 子进程（随机端口）后完整走一遍协议面 + 控制面：
 *   二维码 → 扫码/配对码/过期/换 IDC/已绑定 → 确认 → notifystart →
 *   入站注入（>2^53 message_id）→ getupdates → sendmessage（鉴权/记录/注入 -2）→
 *   多媒体（getuploadurl → /cdn/upload AES 解密校验 → /cdn/download 往返 →
 *   sendmessage 媒体 item → inbound-media 注入 image/file/video/voice）→
 *   token 失效 → reset；并验证 MOCK_AUTO_CONFIRM_MS 自动绑定模式。
 *
 * 用法：node mock/selftest.mjs
 * 退出码：0 = 全部通过；1 = 有失败（并打印 mock 日志尾部）。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SCRIPT = path.join(HERE, 'ilink-mock.mjs');

// ---------------------------------------------------------------------------
// 多媒体测试工具（AES-128-ECB/PKCS7、md5/sha256）
// ---------------------------------------------------------------------------
function randomHex(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function md5Hex(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function aesCipherSize(plainSize) {
  return Math.floor(plainSize / 16) * 16 + 16;
}

function aesEncrypt(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesDecrypt(ciphertext, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

const PROTO_HEADERS = {
  'Content-Type': 'application/json',
  'iLink-App-Id': 'bot',
  'iLink-App-ClientVersion': '132106',
  'X-WECHAT-UIN': Buffer.from('123456789', 'utf8').toString('base64'),
};

function authHeaders(token) {
  return { ...PROTO_HEADERS, Authorization: `Bearer ${token}`, AuthorizationType: 'ilink_bot_token' };
}

function startMock(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK_SCRIPT], {
      cwd: path.resolve(HERE, '..'),
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        MOCK_QUIET: '1',
        MOCK_AUTO_CONFIRM_MS: '0',
        MOCK_QR_POLL_MS: '150',
        MOCK_LONGPOLL_MS: '250',
        MOCK_VERIFY_MAX_ATTEMPTS: '3',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const logs = [];
    const stderr = [];
    let buffer = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error(`mock 启动超时，日志：\n${logs.join('\n')}`));
    }, 10000);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      logs.push(text.trimEnd());
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === 'listening') {
            clearTimeout(timer);
            resolve({ proc: child, port: parsed.port, logs });
            return;
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk.toString('utf8').trimEnd());
      logs.push(`[stderr] ${chunk.toString('utf8').trimEnd()}`);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      logs.push(`[exit] code=${code}`);
    });
  });
}

function createClient(port) {
  const base = `http://127.0.0.1:${port}`;
  async function request(method, pathname, { body, headers } = {}) {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 保留 text 供断言 */
    }
    return { status: res.status, text, json };
  }
  return {
    base,
    request,
    get: (p, opts) => request('GET', p, opts),
    post: (p, body, opts = {}) => request('POST', p, { ...opts, body }),
    proto: (method, p, { body, token } = {}) =>
      request(method, p, {
        body,
        headers: token ? authHeaders(token) : PROTO_HEADERS,
      }),
    state: async () => {
      const res = await request('GET', '/__mock/state');
      assert.equal(res.status, 200, `GET /__mock/state 状态码 ${res.status}`);
      return res.json;
    },
    /** 原始响应文本中的 message_id 必须是 >2^53 的 JSON number 字面量。 */
    assertBigMessageId: (text, label) => {
      const match = /"message_id":(\d{16,})/.exec(text);
      assert.ok(match, `${label}: 响应中应有 JSON number 形式的 message_id，实际文本=${text.slice(0, 300)}`);
      const value = BigInt(match[1]);
      assert.ok(value > 2n ** 53n, `${label}: message_id=${value} 应大于 2^53`);
      return match[1];
    },
  };
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`[PASS] ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log(`[FAIL] ${name}\n       ${err?.message ?? err}`);
  }
}

function stopChild(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode != null || proc.signalCode != null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 3000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`pollUntil 超时（${timeoutMs}ms）`);
}

// ---------------------------------------------------------------------------
// Phase 1：手动控制状态机
// ---------------------------------------------------------------------------
const manualMock = await startMock();
let mockLogs = [];
try {
  const c = createClient(manualMock.port);
  mockLogs = manualMock.logs;

  let qr;
  let token;
  let botId;
  let iLinkUserId;

  await check('GET /__mock/health 返回 ok 且端口正确', async () => {
    const res = await c.get('/__mock/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.port, manualMock.port);
  });

  await check('get_bot_qrcode 返回 qrcode/qrcode_img_content', async () => {
    const res = await c.proto('POST', '/ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] } });
    assert.equal(res.status, 200, res.text);
    qr = res.json;
    assert.match(qr.qrcode, /^qr_[0-9a-f]+$/);
    assert.match(qr.qrcode_img_content, /^https?:\/\//);
  });

  await check('get_qrcode_status 初始为 wait（长轮询有上限）', async () => {
    const startedAt = Date.now();
    const res = await c.proto('GET', `/ilink/bot/get_qrcode_status?qrcode=${qr.qrcode}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'wait');
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 100, `长轮询应挂起约 150ms，实际 ${elapsed}ms`);
    assert.ok(elapsed < 3000, `长轮询不应过久，实际 ${elapsed}ms`);
  });

  await check('控制面 scan → 状态 scaned', async () => {
    const scan = await c.post(`/__mock/qr/${qr.qrcode}/scan`);
    assert.equal(scan.status, 200, scan.text);
    assert.equal(scan.json.ok, true);
    const res = await c.proto('GET', `/ilink/bot/get_qrcode_status?qrcode=${qr.qrcode}`);
    assert.equal(res.json.status, 'scaned');
  });

  await check('控制面 confirm → confirmed 且返回凭证字段', async () => {
    const confirm = await c.post(`/__mock/qr/${qr.qrcode}/confirm`, { ilink_user_id: 'wx_selftest_user_1@im.wechat' });
    assert.equal(confirm.status, 200, confirm.text);
    assert.equal(confirm.json.ok, true);
    const res = await c.proto('GET', `/ilink/bot/get_qrcode_status?qrcode=${qr.qrcode}`);
    assert.equal(res.json.status, 'confirmed');
    token = res.json.bot_token;
    botId = res.json.ilink_bot_id;
    iLinkUserId = res.json.ilink_user_id;
    assert.ok(token?.startsWith('mock_bot_token_'));
    assert.match(botId, /^b[0-9a-f]+@im\.bot$/);
    assert.equal(iLinkUserId, 'wx_selftest_user_1@im.wechat');
    assert.equal(res.json.baseurl, `http://127.0.0.1:${manualMock.port}`);
  });

  await check('notifystart / notifystop 计数', async () => {
    const start = await c.proto('POST', '/ilink/bot/msg/notifystart', { token, body: { base_info: { channel_version: '2.4.10', bot_agent: 'OpenClaw' } } });
    assert.equal(start.json.ret, 0);
    const stop = await c.proto('POST', '/ilink/bot/msg/notifystop', { token, body: { base_info: { channel_version: '2.4.10', bot_agent: 'OpenClaw' } } });
    assert.equal(stop.json.ret, 0);
    const state = await c.state();
    assert.equal(state.notifyStart, 1);
    assert.equal(state.notifyStop, 1);
    assert.equal(state.accounts[0].notifyStart, 1);
    assert.equal(state.accounts[0].notifyStop, 1);
  });

  await check('getconfig / sendtyping 正常返回', async () => {
    const cfg = await c.proto('POST', '/ilink/bot/getconfig', {
      token,
      body: { ilink_user_id: iLinkUserId, context_token: 'ctx_x', base_info: { channel_version: '2.4.10', bot_agent: 'OpenClaw' } },
    });
    assert.equal(cfg.json.ret, 0);
    assert.ok(cfg.json.typing_ticket?.length > 0);
    const typing = await c.proto('POST', '/ilink/bot/sendtyping', {
      token,
      body: { ilink_user_id: iLinkUserId, typing_ticket: cfg.json.typing_ticket, status: 1, base_info: { channel_version: '2.4.10', bot_agent: 'OpenClaw' } },
    });
    assert.equal(typing.json.ret, 0);
  });

  await check('控制面入站注入 → getupdates 返回 >2^53 的 message_id（number 字面量）', async () => {
    const inbound = await c.post(`/__mock/accounts/${encodeURIComponent(botId)}/inbound`, {
      text: '你好，ClawBridge',
      context_token: 'ctx_selftest_inbound_1',
    });
    assert.equal(inbound.status, 200, inbound.text);
    assert.equal(inbound.json.ok, true);
    const res = await c.proto('POST', '/ilink/bot/getupdates', {
      token,
      body: { get_updates_buf: '', base_info: { channel_version: '2.4.10', bot_agent: 'OpenClaw' } },
    });
    assert.equal(res.json.ret, 0);
    assert.equal(res.json.msgs.length, 1);
    assert.equal(res.json.msgs[0].item_list[0].text_item.text, '你好，ClawBridge');
    assert.equal(res.json.msgs[0].from_user_id, iLinkUserId);
    assert.equal(res.json.msgs[0].context_token, 'ctx_selftest_inbound_1');
    const idText = c.assertBigMessageId(res.text, 'getupdates');
    assert.equal(BigInt(idText) > 2n ** 53n, true);
    assert.match(res.json.get_updates_buf, /^mock_updates_buf_/);
    assert.equal(typeof res.json.longpolling_timeout_ms, 'number');
  });

  await check('sendmessage 鉴权 + 结构校验 + 记录 + >2^53 message_id', async () => {
    const msg = {
      from_user_id: '',
      to_user_id: iLinkUserId,
      client_id: 'clawbridge-selftest-client',
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: '来自 ClawBridge 的测试消息' } }],
      context_token: 'ctx_selftest_inbound_1',
    };
    const res = await c.proto('POST', '/ilink/bot/sendmessage', {
      token,
      body: { msg, base_info: { channel_version: '2.4.10', bot_agent: 'ClawBridge/1.0.0' } },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.ret, 0);
    const idText = c.assertBigMessageId(res.text, 'sendmessage');
    assert.equal(BigInt(idText) > 2n ** 53n, true);
    const state = await c.state();
    assert.equal(state.sentMessages.length, 1);
    const sent = state.sentMessages[0];
    assert.equal(sent.toUserId, iLinkUserId);
    assert.equal(sent.text, '来自 ClawBridge 的测试消息');
    assert.equal(sent.contextToken, 'ctx_selftest_inbound_1');
    assert.equal(sent.clientId, 'clawbridge-selftest-client');
    assert.equal(sent.headers.authorizationType, 'ilink_bot_token');
    assert.equal(sent.headers.appId, 'bot');
    assert.equal(sent.headers.clientVersion, '132106');
    assert.equal(BigInt(sent.messageId) > 2n ** 53n, true);
  });

  await check('sendmessage 未带 token → 401 ret=-14', async () => {
    const res = await c.proto('POST', '/ilink/bot/sendmessage', {
      body: { msg: { to_user_id: iLinkUserId, item_list: [{ type: 1, text_item: { text: 'x' } }] } },
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.ret, -14);
  });

  await check('控制面 fail-next-send ret=-2 → 第一次失败、第二次成功', async () => {
    const fail = await c.post('/__mock/fail-next-send', { ret: -2, times: 1 });
    assert.equal(fail.json.ok, true);
    const msg = JSON.stringify({
      msg: {
        from_user_id: '',
        to_user_id: iLinkUserId,
        client_id: 'c1',
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: 'rate-limited' } }],
      },
      base_info: {},
    });
    const first = await fetch(`${c.base}/ilink/bot/sendmessage`, { method: 'POST', headers: authHeaders(token), body: msg });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).ret, -2);
    const second = await fetch(`${c.base}/ilink/bot/sendmessage`, { method: 'POST', headers: authHeaders(token), body: msg });
    assert.equal((await second.json()).ret, 0);
    const state = await c.state();
    assert.equal(state.failedSends.length, 1);
    assert.equal(state.failedSends[0].ret, -2);
  });

  await check('错/对配对数字：need_verifycode → 错误累计 → 正确后 scaned', async () => {
    const created = await c.proto('POST', '/ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] } });
    const verifyQr = created.json.qrcode;
    await c.post(`/__mock/qr/${verifyQr}/scan`);
    const rv = await c.post(`/__mock/qr/${verifyQr}/require-verify`, { code: '4321' });
    assert.equal(rv.json.code, '4321');
    const wrong = await c.proto('GET', `/ilink/bot/get_qrcode_status?qrcode=${verifyQr}&verify_code=1111`);
    assert.equal(wrong.json.status, 'need_verifycode');
    const state = await c.state();
    assert.equal(state.qrs.find((q) => q.qrcode === verifyQr).verifyAttempts, 1);
    const right = await c.proto('GET', `/ilink/bot/get_qrcode_status?qrcode=${verifyQr}&verify_code=4321`);
    assert.equal(right.json.status, 'scaned');
    const confirmed = await c.post(`/__mock/qr/${verifyQr}/confirm`);
    assert.equal(confirmed.json.qr.status, 'confirmed');
  });

  await check('连续错配对数字 3 次 → verify_code_blocked', async () => {
    const created = await c.proto('POST', '/ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] } });
    const blockedQr = created.json.qrcode;
    await c.post(`/__mock/qr/${blockedQr}/require-verify`, { code: '9999' });
    let last;
    for (let i = 0; i < 3; i += 1) {
      last = await c.proto('GET', `/ilink/bot/get_qrcode_status?qrcode=${blockedQr}&verify_code=0000`);
    }
    assert.equal(last.json.status, 'verify_code_blocked');
  });

  await check('控制面 expire → 状态 expired', async () => {
    const created = await c.proto('POST', '/ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] } });
    const expiredQr = created.json.qrcode;
    const exp = await c.post(`/__mock/qr/${expiredQr}/expire`);
    assert.equal(exp.json.ok, true);
    const res = await c.proto('GET', `/ilink/bot/get_qrcode_status?qrcode=${expiredQr}`);
    assert.equal(res.json.status, 'expired');
  });

  await check('控制面 redirect → scaned_but_redirect（带 redirect_host），随后恢复', async () => {
    const created = await c.proto('POST', '/ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] } });
    const redirectQr = created.json.qrcode;
    await c.post(`/__mock/qr/${redirectQr}/scan`);
    const red = await c.post(`/__mock/qr/${redirectQr}/redirect`, { redirect_host: 'idc2.mock.local:3100' });
    assert.equal(red.json.redirect_host, 'idc2.mock.local:3100');
    const res = await c.proto('GET', `/ilink/bot/get_qrcode_status?qrcode=${redirectQr}`);
    assert.equal(res.json.status, 'scaned_but_redirect');
    assert.equal(res.json.redirect_host, 'idc2.mock.local:3100');
    const next = await c.proto('GET', `/ilink/bot/get_qrcode_status?qrcode=${redirectQr}`);
    assert.equal(next.json.status, 'scaned');
  });

  await check('控制面 already-bound → binded_redirect', async () => {
    const created = await c.proto('POST', '/ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] } });
    const boundQr = created.json.qrcode;
    await c.post(`/__mock/qr/${boundQr}/already-bound`, { ilink_user_id: iLinkUserId });
    const res = await c.proto('GET', `/ilink/bot/get_qrcode_status?qrcode=${boundQr}`);
    assert.equal(res.json.status, 'binded_redirect');
  });

  await check('local_token_list + 同一微信用户 → binded_redirect（不发放新凭证）', async () => {
    const created = await c.proto('POST', '/ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [token] } });
    const reQr = created.json.qrcode;
    const state0 = await c.state();
    assert.deepEqual(state0.qrs.find((q) => q.qrcode === reQr).localTokenList, [token]);
    await c.post(`/__mock/qr/${reQr}/scan`, { ilink_user_id: iLinkUserId });
    const confirm = await c.post(`/__mock/qr/${reQr}/confirm`);
    assert.equal(confirm.json.ok, true);
    assert.equal(confirm.json.bindedRedirect, true);
    assert.equal(confirm.json.account.botId, botId);
  });

  await check('stale-token → getupdates ret=-14；clear 后恢复', async () => {
    await c.post(`/__mock/accounts/${encodeURIComponent(botId)}/stale-token`);
    const stale = await c.proto('POST', '/ilink/bot/getupdates', {
      token,
      body: { get_updates_buf: '', base_info: {} },
    });
    assert.equal(stale.json.ret, -14);
    assert.equal(stale.json.errcode, -14);
    await c.post(`/__mock/accounts/${encodeURIComponent(botId)}/clear-stale-token`);
    const healthy = await c.proto('POST', '/ilink/bot/getupdates', {
      token,
      body: { get_updates_buf: '', base_info: {} },
    });
    assert.equal(healthy.json.ret, 0);
  });

  await check('重复 message_id 入站可注入（供 app 去重断言）', async () => {
    await c.post(`/__mock/accounts/${encodeURIComponent(botId)}/inbound`, { text: 'dup-1', message_id: 424242, context_token: 'ctx_dup' });
    await c.post(`/__mock/accounts/${encodeURIComponent(botId)}/inbound`, { text: 'dup-2', message_id: 424242, context_token: 'ctx_dup' });
    const res = await c.proto('POST', '/ilink/bot/getupdates', { token, body: { get_updates_buf: '', base_info: {} } });
    assert.equal(res.json.msgs.length, 2);
    assert.match(res.text, /"message_id":424242/);
  });

  // -------------------------------------------------------------------------
  // 多媒体 / CDN（docs/MEDIA.md §9）
  // -------------------------------------------------------------------------
  const sendMediaMessage = async (item) => {
    const res = await fetch(`${c.base}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: iLinkUserId,
          client_id: `clawbridge-media-${randomHex(4)}`,
          message_type: 2,
          message_state: 2,
          item_list: [item],
        },
        base_info: { channel_version: '2.4.10', bot_agent: 'ClawBridge/1.0.0' },
      }),
    });
    return { status: res.status, json: await res.json() };
  };

  await check('getuploadurl → /cdn/upload（AES-128-ECB 解密校验）→ /cdn/download 往返', async () => {
    const plaintext = Buffer.from(`[mock-media-image]${'x'.repeat(300)}`);
    const keyHex = randomHex(16);
    const filekey = randomHex(16);
    const filesize = aesCipherSize(plaintext.length);
    const uploadRes = await c.proto('POST', '/ilink/bot/getuploadurl', {
      token,
      body: {
        filekey,
        media_type: 1,
        to_user_id: iLinkUserId,
        rawsize: plaintext.length,
        rawfilemd5: md5Hex(plaintext),
        filesize,
        no_need_thumb: true,
        aeskey: keyHex,
        base_info: { channel_version: '2.4.10', bot_agent: 'ClawBridge/1.0.0' },
      },
    });
    assert.equal(uploadRes.status, 200, uploadRes.text);
    assert.equal(uploadRes.json.ret, 0);
    assert.ok(uploadRes.json.upload_param?.length > 0);
    assert.match(uploadRes.json.upload_full_url, /\/cdn\/upload\?filekey=/);
    assert.ok(
      uploadRes.json.upload_full_url.startsWith(`http://127.0.0.1:${manualMock.port}`),
      `upload_full_url 应指向 mock 自身：${uploadRes.json.upload_full_url}`,
    );

    let state = await c.state();
    const recorded = state.uploads.find((entry) => entry.filekey === filekey);
    assert.ok(recorded, 'state.uploads 应记录 getuploadurl 请求');
    assert.equal(recorded.mediaType, 1);
    assert.equal(recorded.kind, 'image');
    assert.equal(recorded.toUserId, iLinkUserId);
    assert.equal(recorded.rawsize, plaintext.length);
    assert.equal(recorded.rawfilemd5, md5Hex(plaintext));
    assert.equal(recorded.filesize, filesize);
    assert.equal(recorded.aeskey, keyHex);
    assert.equal(recorded.noNeedThumb, true);

    // AES-128-ECB/PKCS7 加密后上传密文
    const ciphertext = aesEncrypt(plaintext, Buffer.from(keyHex, 'hex'));
    assert.equal(ciphertext.length, filesize, 'PKCS7 密文长度应与 getuploadurl.filesize 一致');
    const uploadHttpRes = await fetch(uploadRes.json.upload_full_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: ciphertext,
    });
    assert.equal(uploadHttpRes.status, 200);
    const cdnToken = uploadHttpRes.headers.get('x-encrypted-param');
    assert.ok(cdnToken?.startsWith('mock_cdn_'), `响应头 x-encrypted-param 应为 mock CDN token：${cdnToken}`);

    state = await c.state();
    const uploaded = state.uploads.find((entry) => entry.filekey === filekey);
    assert.equal(uploaded.token, cdnToken);
    assert.equal(uploaded.plainSha256, sha256Hex(plaintext));
    assert.equal(uploaded.plainSize, plaintext.length);
    assert.equal(uploaded.cipherSize, ciphertext.length);
    assert.match(uploaded.downloadUrl, /\/cdn\/download\?encrypted_query_param=/);
    const cdnFile = state.cdnFiles.find((entry) => entry.token === cdnToken);
    assert.ok(cdnFile, 'state.cdnFiles 应登记上传文件');
    assert.equal(cdnFile.kind, 'image');
    assert.equal(cdnFile.direction, 'outbound');
    assert.equal(cdnFile.plaintextSha256, sha256Hex(plaintext));

    // 下载密文并解密回原文
    const downloadRes = await fetch(`${c.base}/cdn/download?encrypted_query_param=${encodeURIComponent(cdnToken)}`);
    assert.equal(downloadRes.status, 200);
    const ciphertextDownloaded = Buffer.from(await downloadRes.arrayBuffer());
    assert.deepEqual(ciphertextDownloaded, ciphertext);
    assert.deepEqual(aesDecrypt(ciphertextDownloaded, Buffer.from(keyHex, 'hex')), plaintext);

    // 出站 CDNMedia.aes_key 格式（微信要求）：base64(32 字符 hex key 的 ASCII) = 44 字符；
    // 模拟接收端解析：base64 decode → 32 hex chars → hex decode 16B，并用解析出的 key 解密 CDN 密文。
    const outboundAesKeyB64 = Buffer.from(keyHex, 'utf8').toString('base64');
    assert.equal(outboundAesKeyB64.length, 44, 'base64(32 字符 hex ascii) 应为 44 字符');
    const formatRes = await sendMediaMessage({
      type: 2,
      image_item: {
        media: { encrypt_query_param: cdnToken, aes_key: outboundAesKeyB64, encrypt_type: 1 },
        mid_size: ciphertext.length,
      },
    });
    assert.equal(formatRes.json.ret, 0);
    const formatState = await c.state();
    const formatRecord = formatState.sentMessages[formatState.sentMessages.length - 1];
    const formatItem = formatRecord.itemList[0];
    assert.equal(formatItem.media.aesKey, outboundAesKeyB64, 'sendmessage 应原样记录 base64(hex ascii) 形态的 aes_key');
    const receiverAsciiKey = Buffer.from(formatItem.media.aesKey, 'base64').toString('utf8');
    assert.match(receiverAsciiKey, /^[0-9a-f]{32}$/, '接收端 base64 decode 后应为 32 字符 hex');
    const receiverKey = Buffer.from(receiverAsciiKey, 'hex');
    assert.equal(receiverKey.length, 16);
    const receiverDownload = await fetch(`${c.base}/cdn/download?encrypted_query_param=${encodeURIComponent(cdnToken)}`);
    const receiverCiphertext = Buffer.from(await receiverDownload.arrayBuffer());
    assert.deepEqual(aesDecrypt(receiverCiphertext, receiverKey), plaintext, '接收端解析出的 key 应能解密 CDN 密文');

    // 未知 token → 404
    const missingRes = await fetch(`${c.base}/cdn/download?encrypted_query_param=mock_cdn_missing`);
    assert.equal(missingRes.status, 404);
    // 未知 filekey 上传 → 404
    const unknownUploadRes = await fetch(`${c.base}/cdn/upload?filekey=${randomHex(16)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: ciphertext,
    });
    assert.equal(unknownUploadRes.status, 404);
    // 无法解密的密文 → 400
    const badKeyUpload = await c.proto('POST', '/ilink/bot/getuploadurl', {
      token,
      body: {
        filekey: randomHex(16),
        media_type: 1,
        to_user_id: iLinkUserId,
        rawsize: 10,
        rawfilemd5: md5Hex(Buffer.from('0123456789')),
        filesize: aesCipherSize(10),
        no_need_thumb: true,
        aeskey: randomHex(16),
        base_info: {},
      },
    });
    const badUploadRes = await fetch(badKeyUpload.json.upload_full_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('this-is-not-a-valid-aes-ciphertext'),
    });
    assert.equal(badUploadRes.status, 400);
  });

  await check('getuploadurl：未鉴权 401、缺字段 400', async () => {
    const noAuth = await c.proto('POST', '/ilink/bot/getuploadurl', { body: { filekey: randomHex(16) } });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.json.ret, -14);
    const missing = await c.proto('POST', '/ilink/bot/getuploadurl', {
      token,
      body: { filekey: 'not-hex', media_type: 9, base_info: {} },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.ret, -1);
  });

  await check('sendmessage 记录媒体 itemList（image/video/file 字段与 aes_key 形态）', async () => {
    const rawKeyHex = randomHex(16);
    // 微信要求出站 CDNMedia.aes_key = base64(32 字符 hex key 的 ASCII 字节)（44 字符）
    const hexKeyB64 = Buffer.from(rawKeyHex, 'utf8').toString('base64');
    assert.equal(hexKeyB64.length, 44);
    const cipherSize = 4096;

    const imageRes = await sendMediaMessage({
      type: 2,
      image_item: {
        media: { encrypt_query_param: 'mock_cdn_image_param', aes_key: hexKeyB64, encrypt_type: 1 },
        mid_size: cipherSize,
      },
    });
    assert.equal(imageRes.json.ret, 0);
    const videoRes = await sendMediaMessage({
      type: 5,
      video_item: {
        media: { encrypt_query_param: 'mock_cdn_video_param', aes_key: hexKeyB64, encrypt_type: 1 },
        video_size: cipherSize,
      },
    });
    assert.equal(videoRes.json.ret, 0);
    const fileRes = await sendMediaMessage({
      type: 4,
      file_item: {
        media: { encrypt_query_param: 'mock_cdn_file_param', aes_key: hexKeyB64, encrypt_type: 1 },
        file_name: '报告.pdf',
        len: '1024',
      },
    });
    assert.equal(fileRes.json.ret, 0);

    const state = await c.state();
    const mediaMessages = state.sentMessages.filter((entry) => entry.itemList?.length > 0);
    assert.ok(mediaMessages.length >= 3, `应记录至少 3 条媒体消息，实际 ${mediaMessages.length}`);
    const [image, video, file] = mediaMessages.slice(-3);
    assert.equal(image.itemTypes[0], 2);
    assert.equal(image.itemList[0].kind, 'image');
    assert.equal(image.itemList[0].media.encryptQueryParam, 'mock_cdn_image_param');
    assert.equal(image.itemList[0].media.aesKey, hexKeyB64);
    assert.equal(image.itemList[0].midSize, cipherSize);
    assert.equal(video.itemTypes[0], 5);
    assert.equal(video.itemList[0].kind, 'video');
    assert.equal(video.itemList[0].media.encryptQueryParam, 'mock_cdn_video_param');
    assert.equal(video.itemList[0].media.aesKey, hexKeyB64);
    assert.equal(video.itemList[0].videoSize, cipherSize);
    assert.equal(file.itemTypes[0], 4);
    assert.equal(file.itemList[0].kind, 'file');
    assert.equal(file.itemList[0].fileName, '报告.pdf');
    assert.equal(file.itemList[0].media.aesKey, hexKeyB64);
    assert.equal(file.itemList[0].len, '1024');
    // 字段合规：不应产生 media 相关的协议违规
    assert.equal(
      state.rejections.filter((entry) => entry.endpoint === 'sendmessage' && /media|item_list/.test(entry.reason)).length,
      0,
      `不应有媒体字段违规：${JSON.stringify(state.rejections)}`,
    );

    // 旧格式 base64(原始 16B) 应被 mock 校验记录违规（防回归：微信要求 base64(hex ascii)）
    const legacyAesKeyB64 = Buffer.from(rawKeyHex, 'hex').toString('base64');
    const legacyRes = await sendMediaMessage({
      type: 2,
      image_item: {
        media: { encrypt_query_param: 'mock_cdn_legacy_param', aes_key: legacyAesKeyB64, encrypt_type: 1 },
        mid_size: cipherSize,
      },
    });
    assert.equal(legacyRes.json.ret, 0, 'mock 对格式违规只记录不拒绝');
    const legacyState = await c.state();
    assert.ok(
      legacyState.rejections.some((entry) => entry.endpoint === 'sendmessage' && /aes_key/.test(entry.reason)),
      `旧 base64(raw 16B) aes_key 格式应记录违规：${JSON.stringify(legacyState.rejections.slice(-5))}`,
    );
  });

  await check('inbound-media 注入 image/file/video/voice 结构正确且 CDN 密文可解密', async () => {
    const accountPath = `/__mock/accounts/${encodeURIComponent(botId)}`;
    const imageBytes = Buffer.from(`[fake-png]${'A'.repeat(128)}`);
    const injImage = await c.post(`${accountPath}/inbound-media`, {
      kind: 'image',
      fileName: '图片.png',
      mime: 'image/png',
      contentBase64: imageBytes.toString('base64'),
    });
    assert.equal(injImage.json.ok, true);
    const imageItem = injImage.json.message.item;
    assert.equal(imageItem.type, 2);
    assert.match(imageItem.image_item.aeskey, /^[0-9a-f]{32}$/);
    assert.equal(Buffer.from(imageItem.image_item.media.aes_key, 'base64').length, 16, '图片 media.aes_key 应为 base64(16B raw key)');
    assert.equal(imageItem.image_item.mid_size, injImage.json.cdnFile.cipherSize);
    assert.equal(injImage.json.contentSha256, sha256Hex(imageBytes));
    const imageDownload = await fetch(
      `${c.base}/cdn/download?encrypted_query_param=${encodeURIComponent(injImage.json.cdnFile.token)}`,
    );
    const imageDecrypted = aesDecrypt(Buffer.from(await imageDownload.arrayBuffer()), Buffer.from(imageItem.image_item.aeskey, 'hex'));
    assert.deepEqual(imageDecrypted, imageBytes);

    // 文件（fullUrl=true：应带 media.full_url，且 aes_key = base64(hex key)）
    const fileBytes = Buffer.from(`%PDF-1.4 ${'B'.repeat(64)}`);
    const injFile = await c.post(`${accountPath}/inbound-media`, {
      kind: 'file',
      fileName: '报告.pdf',
      mime: 'application/pdf',
      contentBase64: fileBytes.toString('base64'),
      fullUrl: true,
    });
    const fileItem = injFile.json.message.item;
    assert.equal(fileItem.type, 4);
    assert.equal(fileItem.file_item.file_name, '报告.pdf');
    assert.equal(fileItem.file_item.len, String(fileBytes.length));
    assert.match(fileItem.file_item.media.full_url, /^http:\/\/127\.0\.0\.1:\d+\/cdn\/download\?encrypted_query_param=/);
    const fileKeyHex = Buffer.from(fileItem.file_item.media.aes_key, 'base64').toString('utf8');
    assert.match(fileKeyHex, /^[0-9a-f]{32}$/, '文件 media.aes_key 应为 base64(hex key)');

    // 视频
    const videoBytes = Buffer.from(`[fake-mp4]${'C'.repeat(32)}`);
    const injVideo = await c.post(`${accountPath}/inbound-media`, {
      kind: 'video',
      fileName: 'video.mp4',
      mime: 'video/mp4',
      contentBase64: videoBytes.toString('base64'),
    });
    assert.equal(injVideo.json.message.item.type, 5);
    assert.ok(injVideo.json.message.item.video_item.video_size > 0);

    // 语音
    const voiceBytes = Buffer.from('[fake-silk]');
    const injVoice = await c.post(`${accountPath}/inbound-media`, {
      kind: 'voice',
      fileName: 'voice.silk',
      mime: 'audio/silk',
      contentBase64: voiceBytes.toString('base64'),
    });
    assert.equal(injVoice.json.message.item.type, 3);
    assert.equal(injVoice.json.message.item.voice_item.encode_type, 6);

    // 一次 getupdates 应拿到 4 条媒体消息，顺序与注入一致
    const updates = await c.proto('POST', '/ilink/bot/getupdates', {
      token,
      body: { get_updates_buf: '', base_info: {} },
    });
    assert.equal(updates.json.msgs.length, 4);
    assert.equal(updates.json.msgs[0].item_list[0].type, 2);
    assert.equal(updates.json.msgs[1].item_list[0].type, 4);
    assert.equal(updates.json.msgs[2].item_list[0].type, 5);
    assert.equal(updates.json.msgs[3].item_list[0].type, 3);

    const state = await c.state();
    assert.equal(state.cdnFiles.filter((entry) => entry.direction === 'inbound').length, 4);
    assert.equal(state.counts.inboundMediaInjected, 4);
  });

  await check('POST /__mock/reset 清空状态且计数归零', async () => {
    const res = await c.post('/__mock/reset');
    assert.equal(res.status, 200);
    const state = res.json.state;
    assert.equal(state.qrs.length, 0);
    assert.equal(state.accounts.length, 0);
    assert.equal(state.sentMessages.length, 0);
    assert.equal(state.notifyStart, 0);
    assert.equal(state.uploads.length, 0);
    assert.equal(state.cdnFiles.length, 0);
    const after = await c.state();
    assert.equal(after.counts.resets, 1);
  });
} finally {
  await stopChild(manualMock.proc);
}

// ---------------------------------------------------------------------------
// Phase 2：MOCK_AUTO_CONFIRM_MS 自动绑定（docker demo 路径）
// ---------------------------------------------------------------------------
const autoMock = await startMock({ MOCK_AUTO_CONFIRM_MS: '80', MOCK_QR_POLL_MS: '50' });
try {
  const c = createClient(autoMock.port);
  await check('MOCK_AUTO_CONFIRM_MS 自动 scan+confirm，用户 id 递增', async () => {
    const created = await c.proto('POST', '/ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] } });
    const qr = created.json.qrcode;
    const confirmed = await pollUntil(async () => {
      const res = await c.proto('GET', `/ilink/bot/get_qrcode_status?qrcode=${qr}`);
      return res.json.status === 'confirmed' ? res.json : null;
    }, { timeoutMs: 4000 });
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.ilink_user_id, 'mock_wx_user_1@im.wechat');
    const created2 = await c.proto('POST', '/ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] } });
    const confirmed2 = await pollUntil(async () => {
      const res = await c.proto('GET', `/ilink/bot/get_qrcode_status?qrcode=${created2.json.qrcode}`);
      return res.json.status === 'confirmed' ? res.json : null;
    }, { timeoutMs: 4000 });
    assert.equal(confirmed2.ilink_user_id, 'mock_wx_user_2@im.wechat');
  });
} finally {
  await stopChild(autoMock.proc);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log('\n================ mock selftest summary ================');
console.log(`PASS ${results.length - failed.length}/${results.length}`);
if (failed.length > 0) {
  console.log('\n--- 最近 mock 日志（手动模式）---');
  console.log(mockLogs.slice(-40).join('\n'));
  for (const item of failed) {
    console.log(`\n[FAILED] ${item.name}`);
    console.log(item.error?.stack ?? String(item.error));
  }
  process.exitCode = 1;
} else {
  console.log('ALL PASS');
  process.exitCode = 0;
}
