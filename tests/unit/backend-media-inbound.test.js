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
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-media-inbound-'));

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
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'media-inbound-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'media-inbound-password';
process.env.API_TOKEN = 'media-inbound-token';
process.env.LOG_LEVEL = 'silent';
process.env.ILINK_CDN_BASE_URL = cdnBase;
process.env.INBOUND_MEDIA_MAX_BYTES = '4096';
process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '5000';

const monitor = await import('../../server/src/monitor.js');
const store = await import('../../server/src/store.js');
const media = await import('../../server/src/media.js');
const { getDb, closeDb } = await import('../../server/src/db.js');

after(() => {
  closeDb();
  fake.closeAllConnections?.();
  fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
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
