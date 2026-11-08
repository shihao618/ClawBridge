/**
 * 单元测试：monitor 入站媒体（docs/MEDIA.md §2/§7）。
 *
 * 用本地假 CDN 服务验证：
 *  - 图片 aeskey(hex) 优先、文件/语音 base64(hex) 两种 key 形态解析；
 *  - AES-128-ECB 解密 → 落盘 → attachments 行（关联 inbound_message_id/wechat_message_id）；
 *  - 单消息最多 5 个媒体；
 *  - 下载失败/超限 → 记录 status='failed' 且不影响消息入库；
 *  - raw_json 中 aes_key/aeskey/context_token 全部脱敏。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after } from 'node:test';
import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

// ---------------------------------------------------------------------------
// 假 CDN：/cdn/download?encrypted_query_param=<token> → 返回预置密文
// ---------------------------------------------------------------------------
const cdnFiles = new Map();
const cdnRequests = [];
const fake = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  cdnRequests.push(url.pathname + url.search);
  if (url.pathname === '/cdn/download') {
    const token = url.searchParams.get('encrypted_query_param') || '';
    const file = cdnFiles.get(token);
    if (!file) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.length });
    res.end(file);
    return;
  }
  if (url.pathname === '/cdn/download-chunked') {
    // 无 Content-Length（chunked）：验证流式字节计数上限
    const token = url.searchParams.get('encrypted_query_param') || '';
    const file = cdnFiles.get(token);
    if (!file) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(file.subarray(0, 1024));
    res.end(file.subarray(1024));
    return;
  }
  // 重定向场景（同源 302 / 未授权主机 302 / 重定向环）
  if (url.pathname === '/cdn/redirect') {
    const token = url.searchParams.get('encrypted_query_param') || '';
    res.writeHead(302, { Location: `/cdn/download?encrypted_query_param=${encodeURIComponent(token)}` });
    res.end();
    return;
  }
  if (url.pathname === '/cdn/redirect-external') {
    res.writeHead(302, { Location: 'http://evil.example.invalid/media.bin' });
    res.end();
    return;
  }
  if (url.pathname === '/cdn/redirect-loop') {
    res.writeHead(302, { Location: '/cdn/redirect-loop' });
    res.end();
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
await new Promise((resolve, reject) => {
  fake.once('error', reject);
  fake.listen(0, '127.0.0.1', resolve);
});
const cdnBase = `http://127.0.0.1:${fake.address().port}/cdn`;

/** 加密并登记到假 CDN，返回 {token, ciphertext, keyHex}。 */
function registerCdnFile(plaintext, token, { rawKeyBase64 = false } = {}) {
  const key = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  cdnFiles.set(token, ciphertext);
  return {
    token,
    ciphertext,
    keyHex: key.toString('hex'),
    keyBase64: rawKeyBase64 ? key.toString('base64') : Buffer.from(key.toString('hex'), 'utf8').toString('base64'),
  };
}

// 必须在 import 业务模块前设置
const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-media-inbound-',
  env: {
    APP_SECRET: 'media-inbound-secret-0123456789abcdef0123456789abcdef',
    ADMIN_PASSWORD: 'media-inbound-password',
    API_TOKEN: 'media-inbound-token',
    LOG_LEVEL: 'silent',
    ILINK_CDN_BASE_URL: cdnBase,
    INBOUND_MEDIA_MAX_BYTES: '4096',
    MEDIA_DOWNLOAD_TIMEOUT_MS: '5000',
  },
});
const dataDir = unitEnv.dataDir;

const monitor = await import('../../server/src/monitor.js');
const store = await import('../../server/src/store.js');
const media = await import('../../server/src/media.js');
const { config } = await import('../../server/src/config.js');
const { getDb } = await import('../../server/src/db.js');

after(async () => {
  fake.closeAllConnections?.();
  fake.close();
  await cleanupUnitEnv(unitEnv);
});

let seq = 0;
function createUser() {
  seq += 1;
  return store.upsertBoundUser({
    wechatUserId: `wx_inbound_media_${seq}`,
    displayName: `入站媒体用户${seq}`,
    ilinkBotId: `bot_inbound_media_${seq}@im.bot`,
    botToken: `token-inbound-media-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
}

function buildMessage({ messageId, items, contextToken = 'ctx-inbound-secret' }) {
  return {
    seq: 1,
    message_id: messageId,
    from_user_id: 'wx_inbound_media_sender',
    create_time_ms: Date.now(),
    message_type: 1,
    item_list: items,
    context_token: contextToken,
  };
}

test('入站媒体：图片/文件/视频/语音下载解密落盘 + raw_json 脱敏', async () => {
  const user = createUser();
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33, 0x44, 0x55]);
  const pdfBytes = Buffer.from('%PDF-1.4 mock pdf content');
  const videoBytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x01, 0x02, 0x03]);
  const silkBytes = Buffer.from('SILKDATA-FAKE');

  const image = registerCdnFile(pngBytes, 'tok_image_1');
  const pdf = registerCdnFile(pdfBytes, 'tok_pdf_1');
  const video = registerCdnFile(videoBytes, 'tok_video_1');
  const voice = registerCdnFile(silkBytes, 'tok_voice_1');
  // 图片：image_item.aeskey(hex) 优先；故意把 media.aes_key 设为错误值以验证 override 生效
  const wrongKeyBase64 = crypto.randomBytes(16).toString('base64');
  const message = buildMessage({
    messageId: '9007199254742001',
    items: [
      {
        type: 2,
        image_item: {
          media: { encrypt_query_param: image.token, aes_key: wrongKeyBase64, encrypt_type: 1 },
          aeskey: image.keyHex,
          mid_size: image.ciphertext.length,
        },
      },
      {
        type: 4,
        file_item: {
          media: { encrypt_query_param: pdf.token, aes_key: pdf.keyBase64, encrypt_type: 1 },
          file_name: '报告.pdf',
          len: String(pdfBytes.length),
        },
      },
      {
        type: 5,
        video_item: {
          media: { encrypt_query_param: video.token, aes_key: video.keyBase64, encrypt_type: 1 },
          video_size: video.ciphertext.length,
        },
      },
      {
        type: 3,
        voice_item: {
          media: { encrypt_query_param: voice.token, aes_key: voice.keyBase64, encrypt_type: 1 },
          text: '语音转文字',
        },
      },
    ],
  });

  await monitor.processMessages(user.id, [message]);

  // 消息本身已入库
  const inboundRow = getDb()
    .prepare('SELECT * FROM inbound_messages WHERE wechat_message_id = ?')
    .get('9007199254742001');
  assert.ok(inboundRow);
  assert.equal(inboundRow.item_types, '2,4,5,3');

  // 4 个附件全部 ready
  const attachments = store.getAttachmentsByInbound([inboundRow.id]).get(inboundRow.id);
  assert.equal(attachments.length, 4, JSON.stringify(attachments.map((a) => ({ kind: a.kind, status: a.status }))));
  const byKind = new Map(attachments.map((attachment) => [attachment.kind, attachment]));
  assert.deepEqual([...byKind.keys()].sort(), ['file', 'image', 'video', 'voice']);
  for (const attachment of attachments) {
    assert.equal(attachment.status, 'ready', `${attachment.kind} 应为 ready`);
    assert.equal(attachment.direction, 'inbound');
    assert.equal(attachment.inbound_message_id, inboundRow.id);
    assert.equal(attachment.wechat_message_id, '9007199254742001');
    assert.ok(attachment.sha256.length === 64);
    assert.ok(attachment.path.startsWith('inbound/'));
    assert.ok(attachment.size > 0, `${attachment.kind} 附件大小应大于 0`);
  }
  assert.equal(byKind.get('image').mime, 'image/png', '图片 mime 应通过魔数嗅探为 image/png');
  assert.equal(byKind.get('file').file_name, '报告.pdf');
  assert.equal(byKind.get('file').mime, 'application/pdf');
  assert.equal(byKind.get('video').mime, 'video/mp4');
  assert.equal(byKind.get('voice').mime, 'audio/silk');

  // 落盘字节与原文一致
  assert.deepEqual(await media.readMediaFile(byKind.get('image').path), pngBytes);
  assert.deepEqual(await media.readMediaFile(byKind.get('file').path), pdfBytes);
  assert.deepEqual(await media.readMediaFile(byKind.get('video').path), videoBytes);
  assert.deepEqual(await media.readMediaFile(byKind.get('voice').path), silkBytes);

  // raw_json 脱敏：aes_key / aeskey / context_token 均不得明文
  const rawJson = inboundRow.raw_json;
  for (const secret of [image.keyHex, image.keyBase64, pdf.keyBase64, video.keyBase64, voice.keyBase64, 'ctx-inbound-secret']) {
    assert.ok(!rawJson.includes(secret), `raw_json 不得包含敏感值：${secret.slice(0, 12)}…`);
  }
  assert.ok(rawJson.includes('"aes_key":"[redacted]"'), 'raw_json 中 aes_key 应脱敏');
  assert.ok(rawJson.includes('"aeskey":"[redacted]"'), 'raw_json 中 image aeskey 应脱敏');
  assert.ok(rawJson.includes('"context_token":"[redacted]"'));

  // context_token 仍加密入库
  assert.equal(store.getUserSecrets(user.id).contextToken, 'ctx-inbound-secret');
});

test('入站媒体：单消息最多处理 5 个媒体（防御性上限）', async () => {
  const user = createUser();
  const items = [];
  for (let i = 0; i < 7; i += 1) {
    const file = registerCdnFile(Buffer.from(`DATA-${i}`), `tok_cap_${i}`);
    items.push({
      type: 4,
      file_item: {
        media: { encrypt_query_param: file.token, aes_key: file.keyBase64, encrypt_type: 1 },
        file_name: `f${i}.bin`,
      },
    });
  }
  const message = buildMessage({ messageId: '9007199254742002', items });
  await monitor.processMessages(user.id, [message]);
  const inboundRow = getDb()
    .prepare('SELECT id FROM inbound_messages WHERE wechat_message_id = ?')
    .get('9007199254742002');
  const attachments = store.getAttachmentsByInbound([inboundRow.id]).get(inboundRow.id);
  assert.equal(attachments.length, 5, '单消息最多落库 5 个媒体附件');
});

test('入站媒体：下载失败/超限记录 status=failed，不影响消息入库', async () => {
  const user = createUser();
  const okFile = registerCdnFile(Buffer.from('OK'), 'tok_failok_1');
  const tooBig = crypto.randomBytes(8192); // > INBOUND_MEDIA_MAX_BYTES(4096)
  const bigFile = registerCdnFile(tooBig, 'tok_toobig_1');
  const message = buildMessage({
    messageId: '9007199254742003',
    items: [
      {
        type: 4,
        file_item: {
          media: { encrypt_query_param: 'tok_missing_1', aes_key: okFile.keyBase64 },
          file_name: 'missing.bin',
        },
      },
      {
        type: 4,
        file_item: {
          media: { encrypt_query_param: bigFile.token, aes_key: bigFile.keyBase64 },
          file_name: 'big.bin',
        },
      },
      {
        type: 4,
        file_item: {
          media: { encrypt_query_param: okFile.token, aes_key: okFile.keyBase64 },
          file_name: 'ok.bin',
        },
      },
    ],
  });
  await monitor.processMessages(user.id, [message]);
  const inboundRow = getDb()
    .prepare('SELECT id FROM inbound_messages WHERE wechat_message_id = ?')
    .get('9007199254742003');
  assert.ok(inboundRow, '消息本身仍应入库');
  const attachments = store.getAttachmentsByInbound([inboundRow.id]).get(inboundRow.id);
  assert.equal(attachments.length, 3);
  const byName = new Map(attachments.map((attachment) => [attachment.file_name, attachment]));
  assert.equal(byName.get('missing.bin').status, 'failed');
  assert.equal(byName.get('missing.bin').error.length > 0, true, '失败应有 error 原因');
  assert.equal(byName.get('big.bin').status, 'failed');
  assert.match(byName.get('big.bin').error, /上限|大小/);
  assert.equal(byName.get('ok.bin').status, 'ready');
});

test('入站媒体：full_url 优先下载（无需拼接 CDN 参数）', async () => {
  const user = createUser();
  const file = registerCdnFile(Buffer.from('FULL-URL-CONTENT'), 'tok_full_url_1');
  const message = buildMessage({
    messageId: '9007199254742004',
    items: [
      {
        type: 4,
        file_item: {
          media: {
            full_url: `${cdnBase}/download?encrypted_query_param=${encodeURIComponent(file.token)}`,
            aes_key: file.keyBase64,
            encrypt_type: 1,
          },
          file_name: 'full.bin',
        },
      },
    ],
  });
  const requestsBefore = cdnRequests.length;
  await monitor.processMessages(user.id, [message]);
  assert.ok(cdnRequests.length > requestsBefore);
  assert.match(cdnRequests[cdnRequests.length - 1], /encrypted_query_param=tok_full_url_1/);
  const inboundRow = getDb()
    .prepare('SELECT id FROM inbound_messages WHERE wechat_message_id = ?')
    .get('9007199254742004');
  const [attachment] = store.getAttachmentsByInbound([inboundRow.id]).get(inboundRow.id);
  assert.equal(attachment.status, 'ready');
  assert.deepEqual(await media.readMediaFile(attachment.path), Buffer.from('FULL-URL-CONTENT'));
});

// ---------------------------------------------------------------------------
// 进程级有界闸门 / 流式落盘；下载 URL 校验 + 手动重定向
// ---------------------------------------------------------------------------

/** 列出 MEDIA_DIR/inbound 下的流式临时文件（.part），用于断言失败清理。 */
function listingTempParts() {
  try {
    return fs.readdirSync(path.join(dataDir, 'media', 'inbound')).filter((name) => name.includes('.part'));
  } catch {
    return [];
  }
}

function attachmentByMessageId(messageId) {
  const inboundRow = getDb().prepare('SELECT id FROM inbound_messages WHERE wechat_message_id = ?').get(messageId);
  if (!inboundRow) return [];
  return store.getAttachmentsByInbound([inboundRow.id]).get(inboundRow.id);
}

test('入站下载 URL 校验：协议/主机白名单/userinfo', async () => {
  const { assertInboundDownloadUrl } = media;
  // 默认 CDN / 微信域名后缀：https 放行
  assert.equal(
    assertInboundDownloadUrl('https://novac2c.cdn.weixin.qq.com/c2c/download?x=1').hostname,
    'novac2c.cdn.weixin.qq.com',
  );
  assert.equal(assertInboundDownloadUrl('https://wx.qq.com/a.bin').hostname, 'wx.qq.com');
  // 本机 http（开发/测试环境，mock 形态）放行
  assert.equal(assertInboundDownloadUrl(`${cdnBase}/download?encrypted_query_param=x`).hostname, '127.0.0.1');
  // 配置的 CDN 主机（http，demo/mock 形态）放行
  assert.equal(
    assertInboundDownloadUrl('http://mock-ilink:3100/cdn/download?x=1', { cdnBaseUrl: 'http://mock-ilink:3100/cdn' })
      .hostname,
    'mock-ilink',
  );
  // 未授权主机（http 与 https）一律拒绝
  assert.throws(() => assertInboundDownloadUrl('https://evil.example/x'), /允许列表/);
  assert.throws(() => assertInboundDownloadUrl('http://evil.example/x'), /允许列表/);
  // media.allowedHosts / allowInsecureHttp 配置可显式放行
  const originalAllowedHosts = config.media.allowedHosts;
  const originalAllowInsecureHttp = config.media.allowInsecureHttp;
  config.media.allowedHosts = ['media.example.test'];
  try {
    assert.equal(assertInboundDownloadUrl('https://media.example.test/a.bin').hostname, 'media.example.test');
    assert.equal(assertInboundDownloadUrl('http://media.example.test/a.bin').hostname, 'media.example.test');
  } finally {
    config.media.allowedHosts = originalAllowedHosts;
  }
  // 生产环境默认禁止访问本机（避免 SSRF 打本机端口）；显式 allowInsecureHttp 才放行
  const originalProduction = config.isProduction;
  config.isProduction = true;
  try {
    assert.throws(() => assertInboundDownloadUrl('http://127.0.0.2:9/cdn/x'), /允许列表/);
    config.media.allowInsecureHttp = true;
    assert.equal(assertInboundDownloadUrl('http://127.0.0.2:9/cdn/x').hostname, '127.0.0.2');
  } finally {
    config.isProduction = originalProduction;
    config.media.allowInsecureHttp = originalAllowInsecureHttp;
  }
  // 非 http/https 协议
  assert.throws(() => assertInboundDownloadUrl('ftp://novac2c.cdn.weixin.qq.com/x'), /协议/);
  assert.throws(() => assertInboundDownloadUrl('file:///etc/passwd'), /协议/);
  // userinfo
  assert.throws(
    () => assertInboundDownloadUrl('https://user:pass@novac2c.cdn.weixin.qq.com/x'),
    /userinfo/,
  );
});

test('入站媒体：302 重定向逐跳校验（同源放行 / 未授权主机拒绝 / 限跳数）', async () => {
  const user = createUser();
  // 1) 同源 302 → /cdn/download：放行并落盘
  const redirectFile = registerCdnFile(Buffer.from('REDIRECT-CONTENT'), 'tok_redirect_1');
  const redirectMessage = buildMessage({
    messageId: '9007199254742010',
    items: [
      {
        type: 4,
        file_item: {
          media: {
            full_url: `${cdnBase}/redirect?encrypted_query_param=${encodeURIComponent(redirectFile.token)}`,
            aes_key: redirectFile.keyBase64,
            encrypt_type: 1,
          },
          file_name: 'redirect.bin',
        },
      },
    ],
  });
  await monitor.processMessages(user.id, [redirectMessage]);
  const [redirected] = attachmentByMessageId('9007199254742010');
  assert.equal(redirected.status, 'ready', JSON.stringify(redirected));
  assert.deepEqual(await media.readMediaFile(redirected.path), Buffer.from('REDIRECT-CONTENT'));

  // 2) 302 → 未授权主机：记录 failed 且不跟随
  const badFile = registerCdnFile(Buffer.from('SHOULD-NOT-DOWNLOAD'), 'tok_redirect_bad_1');
  const badRedirectMessage = buildMessage({
    messageId: '9007199254742011',
    items: [
      {
        type: 4,
        file_item: {
          media: {
            full_url: `${cdnBase}/redirect-external`,
            aes_key: badFile.keyBase64,
            encrypt_type: 1,
          },
          file_name: 'external.bin',
        },
      },
    ],
  });
  const requestsBefore = cdnRequests.length;
  await monitor.processMessages(user.id, [badRedirectMessage]);
  const [blocked] = attachmentByMessageId('9007199254742011');
  assert.equal(blocked.status, 'failed');
  assert.match(blocked.error, /允许列表|主机|重定向/);
  assert.ok(cdnRequests.length - requestsBefore <= 2, '重定向到未授权主机后不得继续发起请求');
  assert.ok(!cdnRequests.some((path) => path.includes('evil.example.invalid')));

  // 3) 302 环：达到跳数上限后 failed
  const loopFile = registerCdnFile(Buffer.from('LOOP'), 'tok_redirect_loop_1');
  const loopMessage = buildMessage({
    messageId: '9007199254742012',
    items: [
      {
        type: 4,
        file_item: {
          media: { full_url: `${cdnBase}/redirect-loop`, aes_key: loopFile.keyBase64, encrypt_type: 1 },
          file_name: 'loop.bin',
        },
      },
    ],
  });
  await monitor.processMessages(user.id, [loopMessage]);
  const [looped] = attachmentByMessageId('9007199254742012');
  assert.equal(looped.status, 'failed');
  assert.match(looped.error, /重定向次数过多/);
});

test('入站媒体：流式解密失败/被闸门拒绝时不留 .part 临时文件', async () => {
  const user = createUser();
  // 非法密文长度（非 16 字节整数倍）→ decipher 必然失败
  cdnFiles.set('tok_bad_block_1', Buffer.from('NOT-A-16-BYTE-BLOCK'));
  const keyHex = crypto.randomBytes(16).toString('hex');
  const badMessage = buildMessage({
    messageId: '9007199254742020',
    items: [
      {
        type: 4,
        file_item: {
          media: {
            encrypt_query_param: 'tok_bad_block_1',
            aes_key: Buffer.from(keyHex, 'utf8').toString('base64'),
            encrypt_type: 1,
          },
          file_name: 'badblock.bin',
        },
      },
    ],
  });
  await monitor.processMessages(user.id, [badMessage]);
  const [bad] = attachmentByMessageId('9007199254742020');
  assert.equal(bad.status, 'failed');
  assert.ok(bad.error.length > 0);
  assert.deepEqual(listingTempParts(), [], '解密失败后不得残留 .part 临时文件');
});

test('入站媒体有界闸门：并发上限 / 排队上限 / 排队超时 / 计数', async () => {
  // 并发 1 + 排队 1：第 3 个立即拒绝（队列已满），排队者超时后拒绝
  const gate = media.createBoundedGate({ maxConcurrent: 1, maxQueue: 1 });
  const firstRelease = await gate.acquire(1000);
  assert.equal(gate.stats().active, 1);
  const queuedPromise = gate.acquire(2000);
  await assert.rejects(() => gate.acquire(1000), /队列已满/);
  assert.equal(gate.stats().queued, 1);
  assert.equal(gate.stats().rejected, 1);
  firstRelease();
  const secondRelease = await queuedPromise;
  assert.equal(gate.stats().active, 1, '释放后排队任务应接管执行槽');
  assert.equal(gate.stats().queued, 0);
  secondRelease();
  assert.equal(gate.stats().active, 0);
  assert.equal(gate.stats().completed, 2);

  // 排队超时
  const slowGate = media.createBoundedGate({ maxConcurrent: 1, maxQueue: 1 });
  const heldRelease = await slowGate.acquire(1000);
  await assert.rejects(() => slowGate.acquire(25), /排队超时/);
  assert.equal(slowGate.stats().timedOut, 1);
  heldRelease();
  assert.equal(slowGate.stats().active, 0);

  // release 幂等
  const idempotentGate = media.createBoundedGate({ maxConcurrent: 1, maxQueue: 0 });
  const release = await idempotentGate.acquire(1000);
  release();
  release();
  assert.equal(idempotentGate.stats().active, 0);
});

test('入站媒体进程级闸门（集成）：队列满直接拒绝，排空后计数归零', async () => {
  const gateStats = media.getInboundDownloadStats();
  assert.equal(gateStats.maxConcurrent, config.media.inboundMaxConcurrent);
  assert.equal(gateStats.maxQueue, config.media.inboundMaxQueue);
  const limit = gateStats.maxConcurrent;
  const queueLimit = gateStats.maxQueue;
  const resolvers = [];
  const done = [];
  const tasks = [];
  for (let index = 0; index < limit + queueLimit; index += 1) {
    tasks.push(
      media
        .runInboundDownloadWithSlot(
          () =>
            new Promise((resolve) => {
              resolvers.push(resolve);
            }),
        )
        .then(() => {
          done.push(index);
        }),
    );
  }
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => media.runInboundDownloadWithSlot(async () => {}), /队列已满/);
  const saturated = media.getInboundDownloadStats();
  assert.equal(saturated.active, limit);
  assert.equal(saturated.queued, queueLimit);
  for (let guard = 0; guard < 200 && done.length < limit + queueLimit; guard += 1) {
    while (resolvers.length > 0) {
      for (const resolve of resolvers.splice(0)) resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(tasks);
  assert.equal(done.length, limit + queueLimit);
  const drained = media.getInboundDownloadStats();
  assert.equal(drained.active, 0);
  assert.equal(drained.queued, 0);
  assert.ok(drained.rejected >= 1);
});

test('入站媒体：chunked 响应（无 Content-Length）超限时流式中止并清理', async () => {
  const user = createUser();
  const bigCipher = crypto.randomBytes(8192); // > INBOUND_MEDIA_MAX_BYTES(4096)
  cdnFiles.set('tok_chunk_big_1', bigCipher);
  const keyHex = crypto.randomBytes(16).toString('hex');
  const message = buildMessage({
    messageId: '9007199254742030',
    items: [
      {
        type: 4,
        file_item: {
          media: {
            full_url: `${cdnBase}/download-chunked?encrypted_query_param=tok_chunk_big_1`,
            aes_key: Buffer.from(keyHex, 'utf8').toString('base64'),
            encrypt_type: 1,
          },
          file_name: 'chunk-big.bin',
        },
      },
    ],
  });
  await monitor.processMessages(user.id, [message]);
  const [attachment] = attachmentByMessageId('9007199254742030');
  assert.equal(attachment.status, 'failed');
  assert.match(attachment.error, /上限|大小/);
  assert.deepEqual(listingTempParts(), [], '超限中止后不得残留 .part 临时文件');
});

test('入站媒体：队列饱和时 monitor 立即记录 failed（闸门饱和，不无限排队）', async () => {
  const gateStats = media.getInboundDownloadStats();
  const capacity = gateStats.maxConcurrent + gateStats.maxQueue;
  const resolvers = [];
  const saturated = [];
  for (let index = 0; index < capacity; index += 1) {
    saturated.push(
      media.runInboundDownloadWithSlot(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    );
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(media.getInboundDownloadStats().queued, gateStats.maxQueue);

  const user = createUser();
  const file = registerCdnFile(Buffer.from('QUEUED-CONTENT'), 'tok_queue_full_1');
  const message = buildMessage({
    messageId: '9007199254742031',
    items: [
      {
        type: 4,
        file_item: {
          media: { encrypt_query_param: file.token, aes_key: file.keyBase64, encrypt_type: 1 },
          file_name: 'queued.bin',
        },
      },
    ],
  });
  const startedAt = Date.now();
  await monitor.processMessages(user.id, [message]);
  const elapsedMs = Date.now() - startedAt;
  const [attachment] = attachmentByMessageId('9007199254742031');
  assert.equal(attachment.status, 'failed', '队列满时附件应直接记 failed');
  assert.match(attachment.error, /队列已满/);
  assert.ok(elapsedMs < 5000, `不应无限等待（实际 ${elapsedMs}ms）`);

  // 排空被占用的槽位，避免影响后续用例
  for (let guard = 0; guard < 200 && resolvers.length > 0; guard += 1) {
    for (const resolve of resolvers.splice(0)) resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  for (const task of saturated) await task;
  const drained = media.getInboundDownloadStats();
  assert.equal(drained.active, 0);
  assert.equal(drained.queued, 0);
});
