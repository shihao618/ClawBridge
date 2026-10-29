/**
 * 单元测试：dispatcher 媒体出站管线（docs/MEDIA.md §6）。
 *
 * 用本地假 iLink + 假 CDN 服务（无真实网络）验证：
 *  - getuploadurl 请求字段（md5/filesize/aeskey/media_type/to_user_id/no_need_thumb）；
 *  - CDN 上传的是 AES-128-ECB 密文且可用 aeskey 解回原文；
 *  - caption 先发、媒体 item 结构（image_item/media/mid_size/aes_key=base64(hex ASCII)）正确回传 context_token；
 *  - caption_sent_at 防重复发送；-2 重试只重发媒体；
 *  - 附件缺失 / 磁盘文件缺失 / 语音出站 → 直接 failed 不重试；
 *  - 每次 sendmessage 消耗一个账号限流令牌。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-media-dispatcher-'));

// ---------------------------------------------------------------------------
// 假 iLink + 假 CDN 服务
// ---------------------------------------------------------------------------
const state = {
  uploadRequests: [],
  uploads: [],
  /** @type {Array<{match: 'text'|'media', ret: number, errmsg?: string, remaining: number}>} */
  sendFailures: [],
  sendRequests: [],
  sendSeq: 0,
};
const SEND_ID_BASE = 18014398509481985n; // 2^54 + 1，验证 message_id 无损解析

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  if (url.pathname === '/ilink/bot/getuploadurl') {
    const body = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : {};
    state.uploadRequests.push(body);
    sendJson(res, 200, {
      ret: 0,
      upload_full_url: `${fakeBase}/cdn/upload?filekey=${encodeURIComponent(body.filekey)}`,
      upload_param: 'mock_upload_param',
      thumb_upload_param: '',
    });
    return;
  }
  if (url.pathname === '/cdn/upload') {
    const filekey = url.searchParams.get('filekey') || '';
    const request = state.uploadRequests.find((item) => item.filekey === filekey);
    if (!request) {
      res.writeHead(400);
      res.end('unknown filekey');
      return;
    }
    const key = Buffer.from(request.aeskey, 'hex');
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    const plaintext = Buffer.concat([decipher.update(rawBody), decipher.final()]);
    const downloadParam = `mock_encrypted_param_${state.uploads.length + 1}`;
    state.uploads.push({
      filekey,
      aeskeyHex: request.aeskey,
      cipherSize: rawBody.length,
      ciphertext: Buffer.from(rawBody),
      plainSize: plaintext.length,
      plaintext,
      downloadParam,
    });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'x-encrypted-param': downloadParam });
    res.end('ok');
    return;
  }
  if (url.pathname === '/ilink/bot/sendmessage') {
    const body = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : {};
    state.sendRequests.push(body);
    const itemType = Number(body?.msg?.item_list?.[0]?.type ?? 0);
    const match = itemType === 1 ? 'text' : 'media';
    const failure = state.sendFailures.find((entry) => entry.match === match && entry.remaining > 0);
    if (failure) {
      failure.remaining -= 1;
      sendJson(res, 200, { ret: failure.ret, errmsg: failure.errmsg ?? `mock failure ret=${failure.ret}` });
      return;
    }
    state.sendSeq += 1;
    const messageId = SEND_ID_BASE + BigInt(state.sendSeq) * 2n;
    // 原始 JSON：message_id 以 >2^53 的 number 字面量返回，验证 parseILinkJson 无损化
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(`{"ret":0,"message_id":${messageId.toString()},"errmsg":""}`);
    return;
  }
  sendJson(res, 404, { ret: -1, errmsg: 'not found' });
});

await new Promise((resolve, reject) => {
  fake.once('error', reject);
  fake.listen(0, '127.0.0.1', resolve);
});
const fakeBase = `http://127.0.0.1:${fake.address().port}`;

// 必须在 import 业务模块前设置
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'media-dispatcher-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'media-dispatcher-password';
process.env.API_TOKEN = 'media-dispatcher-token';
process.env.LOG_LEVEL = 'silent';
process.env.RATE_LIMIT_MAX = '7';
process.env.RATE_LIMIT_WINDOW_MS = '300000';
process.env.PUSH_RETRY_DELAYS_MS = '10';
process.env.PUSH_MAX_ATTEMPTS = '5';

const store = await import('../../server/src/store.js');
const media = await import('../../server/src/media.js');
const dispatcher = await import('../../server/src/dispatcher.js');
const { closeDb } = await import('../../server/src/db.js');

after(async () => {
  closeDb();
  fake.closeAllConnections?.();
  await new Promise((resolve) => fake.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
function createUser({ contextToken = 'ctx-media-token' } = {}) {
  seq += 1;
  const result = store.upsertBoundUser({
    wechatUserId: `wx_media_dispatcher_${seq}`,
    displayName: `媒体发送用户${seq}`,
    ilinkBotId: `bot_media_dispatcher_${seq}@im.bot`,
    botToken: `token-media-dispatcher-${seq}`,
    baseUrl: fakeBase,
  });
  if (contextToken) store.updateContextToken(result.user.id, contextToken);
  dispatcher.resetRateLimit(result.user.id);
  return result.user;
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x01, 0x02,
  0x03, 0x04, 0x05, 0x06,
]);

async function createOutboundAttachment({ buffer = PNG_BYTES, mime = 'image/png', kind = 'image', fileName = 'pic.png' } = {}) {
  const saved = await media.saveMediaBuffer({ direction: 'outbound', buffer, mime });
  return store.createAttachment({
    id: saved.id,
    direction: 'outbound',
    kind,
    mime: saved.mime,
    fileName,
    size: saved.size,
    path: saved.path,
    sha256: saved.sha256,
    status: 'ready',
  });
}

test('媒体发送：caption 先发 → getuploadurl → AES 密文上传 → image_item（context_token/字段正确）', async () => {
  state.uploadRequests.length = 0;
  state.uploads.length = 0;
  state.sendRequests.length = 0;
  state.sendFailures.length = 0;

  const user = createUser({ contextToken: 'ctx-caption-image' });
  const attachment = await createOutboundAttachment();
  const queued = store.enqueueMessage({ userId: user.id, text: '看图', source: 'admin', mediaId: attachment.id });
  assert.equal(queued.mediaId, attachment.id);

  const processed = await dispatcher.processOne(Date.now() + 1);
  assert.equal(processed, true);

  // 2 次 sendmessage：caption 文本 + 媒体 item
  assert.equal(state.sendRequests.length, 2, '媒体消息应产生 caption + media 两次 sendmessage');
  const captionReq = state.sendRequests[0];
  assert.deepEqual(captionReq.msg.item_list, [{ type: 1, text_item: { text: '看图' } }]);
  assert.equal(captionReq.msg.to_user_id, user.wechatUserId);
  assert.equal(captionReq.msg.context_token, 'ctx-caption-image');

  // getuploadurl 字段
  assert.equal(state.uploadRequests.length, 1);
  const uploadReq = state.uploadRequests[0];
  assert.match(uploadReq.filekey, /^[0-9a-f]{32}$/);
  assert.equal(uploadReq.media_type, 1, '图片 media_type 应为 1');
  assert.equal(uploadReq.to_user_id, user.wechatUserId);
  assert.equal(uploadReq.rawsize, PNG_BYTES.length);
  assert.equal(uploadReq.rawfilemd5, crypto.createHash('md5').update(PNG_BYTES).digest('hex'));
  assert.equal(uploadReq.filesize, media.aesEcbPaddedSize(PNG_BYTES.length));
  assert.equal(uploadReq.no_need_thumb, true);
  assert.match(uploadReq.aeskey, /^[0-9a-f]{32}$/);
  assert.equal(uploadReq.base_info.channel_version, '2.4.10');

  // CDN 收到密文且可解回原文
  assert.equal(state.uploads.length, 1);
  const upload = state.uploads[0];
  assert.equal(upload.cipherSize, media.aesEcbPaddedSize(PNG_BYTES.length));
  assert.deepEqual(upload.plaintext, PNG_BYTES);
  assert.equal(upload.aeskeyHex, uploadReq.aeskey);

  // 媒体 sendmessage item 结构
  const mediaReq = state.sendRequests[1];
  assert.equal(mediaReq.msg.item_list.length, 1);
  const item = mediaReq.msg.item_list[0];
  assert.equal(item.type, 2);
  assert.equal(item.image_item.media.encrypt_query_param, upload.downloadParam);
  assert.equal(item.image_item.media.encrypt_type, 1);
  const aesKeyBase64 = item.image_item.media.aes_key;
  // 官方语义（media.js buildMediaItem）：aes_key = base64(32 字符 hex key 的 ASCII 字节)，44 字符。
  // 接收端解析：base64 解码 → 32 字符 hex 字符串 → hex 解码 → 16B AES key。
  assert.equal(aesKeyBase64.length, 44, 'aes_key 应为 base64(32 字符 hex 明文的 ASCII)，长度 44');
  const decodedAesKey = Buffer.from(aesKeyBase64, 'base64');
  assert.equal(decodedAesKey.length, 32, 'aes_key base64 解码后应为 32 字节 ASCII hex');
  assert.match(decodedAesKey.toString('ascii'), /^[0-9a-f]{32}$/);
  assert.equal(decodedAesKey.toString('ascii'), uploadReq.aeskey, 'hex 明文应与 getuploadurl.aeskey 一致');
  const receiverKey = Buffer.from(decodedAesKey.toString('ascii'), 'hex');
  assert.equal(receiverKey.length, 16, '接收端 hex 解码后应得到 16 字节 key');
  // 端到端回归：模拟接收端用消息里的 aes_key 解 CDN 密文，应还原原图
  const receiverDecipher = crypto.createDecipheriv('aes-128-ecb', receiverKey, null);
  const receivedPlaintext = Buffer.concat([receiverDecipher.update(upload.ciphertext), receiverDecipher.final()]);
  assert.deepEqual(receivedPlaintext, PNG_BYTES, '接收端用消息中的 aes_key 应能解出原图');
  assert.equal(item.image_item.mid_size, media.aesEcbPaddedSize(PNG_BYTES.length));
  assert.equal(mediaReq.msg.from_user_id, '');
  assert.equal(mediaReq.msg.message_type, 2);
  assert.equal(mediaReq.msg.context_token, 'ctx-caption-image');

  // outbox 状态与 caption 记录
  const sent = store.getOutbox(queued.id);
  assert.equal(sent.status, 'sent');
  assert.ok(sent.captionSentAt > 0);
  assert.equal(sent.attempts, 1);
  assert.match(String(sent.serverMessageId), /^\d+$/, 'message_id 应无损保存为字符串');
  assert.equal(sent.attachments.length, 1);
  assert.equal(sent.attachments[0].id, attachment.id);

  // 限流令牌：caption + media 共消耗 2 个（默认 max=7 → 剩余 5）
  const limiter = dispatcher.getLimiter();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.tryAcquire(user.id).allowed, true, `应剩余 ${5 - i} 个令牌`);
  }
  assert.equal(limiter.tryAcquire(user.id).allowed, false, 'caption+媒体应共消耗 2 个令牌');
});

test('媒体发送：-2 退避后只重试媒体，caption 不重复发送', async () => {
  state.uploadRequests.length = 0;
  state.uploads.length = 0;
  state.sendRequests.length = 0;
  state.sendFailures.length = 0;

  const user = createUser({ contextToken: 'ctx-retry' });
  const attachment = await createOutboundAttachment({ fileName: 'retry.png' });
  const queued = store.enqueueMessage({ userId: user.id, text: '重试 caption', mediaId: attachment.id });
  state.sendFailures.push({ match: 'media', ret: -2, remaining: 1 });

  assert.equal(await dispatcher.processOne(Date.now() + 1), true);
  let outbox = store.getOutbox(queued.id);
  assert.equal(outbox.status, 'queued', '-2 后应退避重试');
  assert.equal(outbox.attempts, 1);
  assert.ok(outbox.captionSentAt > 0, 'caption 已发送并记录');
  const textSendsAfterFirstAttempt = state.sendRequests.filter((req) => req.msg.item_list[0].type === 1).length;
  assert.equal(textSendsAfterFirstAttempt, 1);

  // 退避到期后再次处理：只发媒体
  assert.equal(await dispatcher.processOne(Date.now() + 5000), true);
  outbox = store.getOutbox(queued.id);
  assert.equal(outbox.status, 'sent');
  assert.equal(outbox.attempts, 2, '失败重试后成功 attempts=2');
  const textSendsTotal = state.sendRequests.filter((req) => req.msg.item_list[0].type === 1).length;
  assert.equal(textSendsTotal, 1, 'caption 不应重复发送');
  const mediaSendsTotal = state.sendRequests.filter((req) => req.msg.item_list[0].type !== 1).length;
  assert.equal(mediaSendsTotal, 2, '媒体应重试一次');
  assert.equal(state.uploadRequests.length, 2, '媒体每次重试重新上传');
});

test('媒体发送：caption 发送被 -2 限流时整条退避重试', async () => {
  state.sendRequests.length = 0;
  state.sendFailures.length = 0;
  const user = createUser({ contextToken: 'ctx-caption-retry' });
  const attachment = await createOutboundAttachment({ fileName: 'cap.png' });
  const queued = store.enqueueMessage({ userId: user.id, text: '限流 caption', mediaId: attachment.id });
  state.sendFailures.push({ match: 'text', ret: -2, remaining: 1 });

  assert.equal(await dispatcher.processOne(Date.now() + 1), true);
  let outbox = store.getOutbox(queued.id);
  assert.equal(outbox.status, 'queued');
  assert.equal(outbox.captionSentAt, 0, 'caption 失败时不应记录已发送');

  assert.equal(await dispatcher.processOne(Date.now() + 5000), true);
  outbox = store.getOutbox(queued.id);
  assert.equal(outbox.status, 'sent');
  assert.ok(outbox.captionSentAt > 0);
  assert.equal(outbox.attempts, 2);
});

test('媒体发送：附件不存在 → 直接 failed 不重试、不发 sendmessage', async () => {
  state.sendRequests.length = 0;
  const user = createUser();
  const queued = store.enqueueMessage({ userId: user.id, text: '坏附件', mediaId: 'att_not_exist' });
  assert.equal(await dispatcher.processOne(Date.now() + 1), true);
  const outbox = store.getOutbox(queued.id);
  assert.equal(outbox.status, 'failed');
  assert.match(outbox.error, /附件不存在/);
  assert.equal(state.sendRequests.length, 0);
});

test('媒体发送：磁盘文件缺失 → 直接 failed 不重试', async () => {
  state.sendRequests.length = 0;
  state.uploadRequests.length = 0;
  const user = createUser();
  const attachment = await createOutboundAttachment({ fileName: 'gone.png' });
  const queued = store.enqueueMessage({ userId: user.id, text: '', mediaId: attachment.id });
  // 删除磁盘文件
  fs.rmSync(media.resolveMediaPath(attachment.path), { force: true });
  assert.equal(await dispatcher.processOne(Date.now() + 1), true);
  const outbox = store.getOutbox(queued.id);
  assert.equal(outbox.status, 'failed');
  assert.match(outbox.error, /文件缺失/);
  assert.equal(state.uploadRequests.length, 0, '不应尝试上传');
});

test('媒体发送：语音出站直接 400 语义 failed（不支持）', async () => {
  const user = createUser();
  const attachment = await createOutboundAttachment({
    buffer: Buffer.from('SILKDATA'),
    mime: 'audio/silk',
    kind: 'voice',
    fileName: 'voice.silk',
  });
  const queued = store.enqueueMessage({ userId: user.id, text: '', mediaId: attachment.id });
  assert.equal(await dispatcher.processOne(Date.now() + 1), true);
  const outbox = store.getOutbox(queued.id);
  assert.equal(outbox.status, 'failed');
  assert.match(outbox.error, /语音/);
});

test('媒体发送：无 caption 的媒体只发一次 sendmessage；纯文本路径保持不变', async () => {
  state.sendRequests.length = 0;
  const user = createUser({ contextToken: 'ctx-plain' });
  const attachment = await createOutboundAttachment({ fileName: 'no-caption.png' });
  const mediaOnly = store.enqueueMessage({ userId: user.id, text: '', mediaId: attachment.id });
  assert.equal(await dispatcher.processOne(Date.now() + 1), true);
  assert.equal(state.sendRequests.length, 1, '无 caption 时只发媒体消息');
  assert.notEqual(state.sendRequests[0].msg.item_list[0].type, 1);
  assert.equal(store.getOutbox(mediaOnly.id).status, 'sent');

  state.sendRequests.length = 0;
  const textOnly = store.enqueueMessage({ userId: user.id, text: '纯文本消息' });
  assert.equal(await dispatcher.processOne(Date.now() + 1), true);
  assert.equal(state.sendRequests.length, 1);
  assert.deepEqual(state.sendRequests[0].msg.item_list, [{ type: 1, text_item: { text: '纯文本消息' } }]);
  assert.equal(store.getOutbox(textOnly.id).status, 'sent');
});

test('媒体发送：video/file item 的 aes_key 同为 base64(hex ASCII)，接收端可解密还原', async () => {
  const user = createUser({ contextToken: 'ctx-video-file' });
  const cases = [
    {
      kind: 'video',
      mime: 'video/mp4',
      fileName: 'v.mp4',
      buffer: Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x01, 0x02, 0x03, 0x04]),
      expectedType: 5,
    },
    {
      kind: 'file',
      mime: 'application/pdf',
      fileName: '报告.pdf',
      buffer: Buffer.from('%PDF-1.4 mock media file'),
      expectedType: 4,
    },
  ];

  for (const testCase of cases) {
    state.sendRequests.length = 0;
    state.uploadRequests.length = 0;
    state.uploads.length = 0;
    state.sendFailures.length = 0;

    const attachment = await createOutboundAttachment({
      buffer: testCase.buffer,
      mime: testCase.mime,
      kind: testCase.kind,
      fileName: testCase.fileName,
    });
    const queued = store.enqueueMessage({ userId: user.id, text: '', mediaId: attachment.id });
    assert.equal(await dispatcher.processOne(Date.now() + 1), true, `${testCase.kind} 应处理成功`);

    const mediaReq = state.sendRequests.find((request) => request.msg.item_list[0].type !== 1);
    assert.ok(mediaReq, `${testCase.kind} 应发送媒体消息`);
    const item = mediaReq.msg.item_list[0];
    assert.equal(item.type, testCase.expectedType);
    const itemPayload = testCase.kind === 'video' ? item.video_item : item.file_item;
    const uploadRequest = state.uploadRequests[state.uploadRequests.length - 1];
    const uploadRecord = state.uploads[state.uploads.length - 1];
    assert.equal(uploadRequest.media_type, testCase.kind === 'video' ? 2 : 3);

    // 官方语义：aes_key = base64(32 字符 hex 明文的 ASCII)，44 字符
    const base64Key = itemPayload.media.aes_key;
    assert.equal(base64Key.length, 44, `${testCase.kind} aes_key 应为 44 字符 base64(hex ASCII)`);
    const decodedKey = Buffer.from(base64Key, 'base64');
    assert.equal(decodedKey.length, 32);
    assert.match(decodedKey.toString('ascii'), /^[0-9a-f]{32}$/);
    assert.equal(decodedKey.toString('ascii'), uploadRequest.aeskey);
    // 模拟接收端解析并用其解密 CDN 密文
    const receiverKey = Buffer.from(decodedKey.toString('ascii'), 'hex');
    const decipher = crypto.createDecipheriv('aes-128-ecb', receiverKey, null);
    assert.deepEqual(
      Buffer.concat([decipher.update(uploadRecord.ciphertext), decipher.final()]),
      testCase.buffer,
      `${testCase.kind} 接收端应能解出原文`,
    );

    if (testCase.kind === 'video') {
      assert.equal(item.video_item.video_size, media.aesEcbPaddedSize(testCase.buffer.length));
    } else {
      assert.equal(item.file_item.file_name, '报告.pdf');
      assert.equal(item.file_item.len, String(testCase.buffer.length));
    }
    assert.equal(store.getOutbox(queued.id).status, 'sent');
  }
});
