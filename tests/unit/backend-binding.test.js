/**
 * 回归测试：绑定配对码（verify_code）竞态。
 *
 * 场景：用户提交配对码时，binding worker 已有一次「未携带 code」的 get_qrcode_status
 * 长轮询在途；该响应返回 need_verifycode 时不能清空刚提交的 pending code，否则 code
 * 永远发不出去（真实浏览器 + 生产 35s 长轮询可复现）。
 *
 * 用本地假 iLink 服务精确控制时序（无真实网络）：
 * - 第 1 次轮询 → need_verifycode；
 * - 第 2 次（无 code）轮询被挂起，测试此时提交配对码，再释放该响应；
 * - 断言下一次轮询确实携带 verify_code，并最终 confirmed。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-binding-'));

// ---------------------------------------------------------------------------
// 假 iLink 服务（先启动拿端口，再设置 env，最后动态 import binding）
// ---------------------------------------------------------------------------
const CORRECT_CODE = '1234';
const state = {
  qrSeq: 0,
  /** @type {Map<string, {phase: number, held: boolean, holdStarted: boolean, release: (()=>void)|null, codes: string[], ilinkUserId: string}>} */
  qrs: new Map(),
  codesReceived: [],
  holdCount: 0,
  /** 置 true 后，下一个二维码的首次（wait 阶段）轮询会被挂起（用于取消竞态测试） */
  holdPhase0: false,
  releaseHolds: () => {
    for (const qr of state.qrs.values()) {
      if (qr.release) {
        const release = qr.release;
        qr.release = null;
        release();
      }
    }
  },
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  // 读取并丢弃 body（GET 也无害）
  for await (const _chunk of req) {
    /* drain */
  }
  const qrcode = url.searchParams.get('qrcode') || '';
  const verifyCode = url.searchParams.get('verify_code') || '';

  if (url.pathname === '/ilink/bot/get_bot_qrcode') {
    state.qrSeq += 1;
    const id = `qr_race_${state.qrSeq}`;
    state.qrs.set(id, {
      phase: 0,
      held: false,
      holdStarted: false,
      release: null,
      codes: [],
      ilinkUserId: `wx_race_${state.qrSeq}@im.wechat`,
    });
    sendJson(res, 200, { qrcode: id, qrcode_img_content: `https://example.test/bind?qrcode=${id}` });
    return;
  }

  if (url.pathname === '/ilink/bot/get_qrcode_status') {
    const qr = state.qrs.get(qrcode);
    if (!qr) {
      sendJson(res, 200, { status: 'wait' });
      return;
    }
    if (verifyCode) {
      qr.codes.push(verifyCode);
      state.codesReceived.push(verifyCode);
    }
    if (qr.phase === 0) {
      qr.phase = 1;
      if (state.holdPhase0) {
        // 模拟“wait 阶段在途长轮询”：挂起，直到测试取消会话后再释放
        state.holdPhase0 = false;
        qr.held = true;
        qr.holdStarted = true;
        state.holdCount += 1;
        await new Promise((resolve) => {
          qr.release = resolve;
        });
        sendJson(res, 200, { status: 'wait' });
        return;
      }
      sendJson(res, 200, { status: 'need_verifycode' });
      return;
    }
    if (qr.phase === 1) {
      if (verifyCode) {
        if (verifyCode === CORRECT_CODE) {
          qr.phase = 2;
          sendJson(res, 200, { status: 'scaned' });
        } else {
          // 错误配对码：仍返回 need_verifycode，等待再次提交
          sendJson(res, 200, { status: 'need_verifycode' });
        }
        return;
      }
      if (!qr.held) {
        // 模拟“在途长轮询”：挂起，直到测试释放（此时用户提交配对码）
        qr.held = true;
        qr.holdStarted = true;
        qr.release = null;
        state.holdCount += 1;
        await new Promise((resolve) => {
          qr.release = resolve;
        });
        sendJson(res, 200, { status: 'need_verifycode' });
        return;
      }
      sendJson(res, 200, { status: 'need_verifycode' });
      return;
    }
    // phase 2：配对码已通过 → 返回 confirmed
    sendJson(res, 200, {
      status: 'confirmed',
      bot_token: `bot_token_${qrcode}`,
      ilink_bot_id: `bot_${qrcode}@im.bot`,
      baseurl: fakeBase,
      ilink_user_id: qr.ilinkUserId,
    });
    return;
  }

  if (url.pathname === '/ilink/bot/msg/notifystart' || url.pathname === '/ilink/bot/msg/notifystop') {
    sendJson(res, 200, { ret: 0, errmsg: '' });
    return;
  }
  if (url.pathname === '/ilink/bot/getupdates') {
    await new Promise((resolve) => setTimeout(resolve, 100));
    sendJson(res, 200, { ret: 0, errcode: 0, msgs: [], get_updates_buf: 'buf_test', longpolling_timeout_ms: 35000 });
    return;
  }
  sendJson(res, 404, { ret: -1, errmsg: 'not found' });
});

await new Promise((resolve, reject) => {
  fake.once('error', reject);
  fake.listen(0, '127.0.0.1', resolve);
});
const fakeBase = `http://127.0.0.1:${fake.address().port}`;

// 必须在 import 业务模块前设置：config 模块加载即求值
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'binding-test-app-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'binding-test-password';
process.env.API_TOKEN = 'binding-test-api-token';
process.env.LOG_LEVEL = 'silent';
process.env.ILINK_LOGIN_BASE_URL = fakeBase;
process.env.ILINK_BASE_URL = fakeBase;
process.env.BINDING_POLL_GAP_MS = '0'; // 关键：0 间隔放大竞态窗口
process.env.BINDING_MAX_ACTIVE = '10';

const binding = await import('../../server/src/binding.js');
const monitor = await import('../../server/src/monitor.js');
const { closeDb } = await import('../../server/src/db.js');

after(async () => {
  await monitor.stopAll({ notify: false }).catch(() => {});
  try {
    binding.stopCleanup();
  } catch {
    /* ignore */
  }
  closeDb();
  fake.closeAllConnections?.();
  await new Promise((resolve) => fake.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 12000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw lastError ?? new Error('waitFor 超时');
}

function qrcodeOf(created) {
  return new URL(created.qr.content).searchParams.get('qrcode');
}

test('配对码竞态：在途长轮询返回 need_verifycode 时不丢失刚提交的 code', async () => {
  const created = await binding.createSession({ displayName: '竞态用户A' });
  const qrcode = qrcodeOf(created);
  const session = () => binding.getSession({ sessionId: created.sessionId, token: created.token });

  // 第 1 次响应 need_verifycode 后，worker 立即发起第 2 次（无 code）轮询并被假服务挂起
  const qr = state.qrs.get(qrcode);
  await waitFor(() => qr?.holdStarted === true);
  assert.equal(session().status, 'need_verifycode');

  // 在途轮询未返回时，用户提交正确配对码
  binding.submitVerifyCode({ sessionId: created.sessionId, token: created.token, code: CORRECT_CODE });
  assert.equal(session().status, 'scanned', '提交配对码后状态应为 scanned（等待确认）');

  // 释放挂起响应：服务端此时返回 need_verifycode（竞态窗口）
  state.releaseHolds();

  // 修复点：pending code 不能被本次响应清掉，下一次轮询必须携带 1234
  await waitFor(() => state.codesReceived.includes(CORRECT_CODE));
  assert.ok(qr.codes.includes(CORRECT_CODE), '下一次轮询应携带用户提交的 verify_code');

  const confirmed = await waitFor(() => {
    const snapshot = session();
    if (snapshot.status === 'confirmed') return snapshot;
    if (snapshot.status === 'error' || snapshot.status === 'timeout') {
      throw new Error(`会话异常终止: ${snapshot.status} ${snapshot.error ?? ''}`);
    }
    return null;
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(confirmed.user?.id, 'confirmed 应返回用户摘要');
});

test('错误配对码一次后仍可再次提交正确 code 并完成绑定', async () => {
  const created = await binding.createSession({ displayName: '竞态用户B' });
  const qrcode = qrcodeOf(created);
  const qr = state.qrs.get(qrcode);
  const session = () => binding.getSession({ sessionId: created.sessionId, token: created.token });

  await waitFor(() => qr?.holdStarted === true);
  assert.equal(session().status, 'need_verifycode');

  // 先提交错误配对码，并释放在途响应（验证保留语义在错误码场景也正确）
  binding.submitVerifyCode({ sessionId: created.sessionId, token: created.token, code: '0000' });
  state.releaseHolds();
  await waitFor(() => qr.codes.includes('0000'));
  // 错误码被服务端拒绝 → 会话回到 need_verifycode，用户可再次提交
  await waitFor(() => session().status === 'need_verifycode');

  binding.submitVerifyCode({ sessionId: created.sessionId, token: created.token, code: CORRECT_CODE });
  await waitFor(() => qr.codes.includes(CORRECT_CODE));

  const confirmed = await waitFor(() => {
    const snapshot = session();
    if (snapshot.status === 'confirmed') return snapshot;
    if (snapshot.status === 'error' || snapshot.status === 'timeout') {
      throw new Error(`会话异常终止: ${snapshot.status} ${snapshot.error ?? ''}`);
    }
    return null;
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(confirmed.user?.id);
  assert.deepEqual(qr.codes, ['0000', CORRECT_CODE], '假服务应依次收到错误码与正确码');
});

test('取消绑定与在途长轮询竞态：cancelled 终态不被返回响应覆盖', async () => {
  state.holdPhase0 = true;
  const created = await binding.createSession({ displayName: '取消竞态用户' });
  const qr = state.qrs.get(qrcodeOf(created));
  await waitFor(() => qr?.held === true && qr?.holdStarted === true);

  // 在途长轮询未返回时用户取消绑定
  binding.cancelSession({ sessionId: created.sessionId, token: created.token });
  assert.equal(
    binding.getSession({ sessionId: created.sessionId, token: created.token }).status,
    'cancelled',
    '取消后应立刻进入 cancelled 终态',
  );

  // 释放在途响应（wait）：不得把终态覆盖回 waiting
  state.releaseHolds();
  await sleep(150);
  assert.equal(
    binding.getSession({ sessionId: created.sessionId, token: created.token }).status,
    'cancelled',
    '在途轮询响应不得覆盖 cancelled 终态',
  );
});

test('会话状态中的二维码内容/刷新计数字段保持契约', async () => {
  const created = await binding.createSession({ displayName: '契约用户' });
  assert.ok(created.qr.svg.startsWith('data:image/svg+xml;base64,'));
  assert.match(created.qr.content, /^https:\/\/example\.test\/bind\?qrcode=/);
  const snapshot = binding.getSession({ sessionId: created.sessionId, token: created.token });
  assert.equal(typeof snapshot.refreshCount, 'number');
  assert.equal(snapshot.refreshCount, 0);
  // 错误 token 不能读取会话
  assert.throws(
    () => binding.getSession({ sessionId: created.sessionId, token: 'wrong-token' }),
    (err) => err.status === 401,
  );
});
