/**
 * Lead 多媒体核心模块单元测试：crypto/MIME/存储/上传下载管线（本地假 CDN）。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawbridge-media-lead-'));
process.env.DATA_DIR = tmpDir;
process.env.APP_SECRET = 'media-lead-secret-0123456789abcdef';
process.env.ADMIN_PASSWORD = 'x';
process.env.API_TOKEN = 't';
process.env.LOG_LEVEL = 'error';

const { config } = await import('../../server/src/config.js');
const media = await import('../../server/src/media.js');
const { UploadMediaType } = await import('../../server/src/ilink.js');

const KEY_HEX = '00112233445566778899aabbccddeeff';
const KEY = Buffer.from(KEY_HEX, 'hex');
const PAYLOAD = Buffer.from('ClawBridge 媒体负载 image bytes '.repeat(20));

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('media crypto: AES-128-ECB 往返、密文长度与 aes_key 解析', () => {
  const cipher = media.aesEcbEncrypt(PAYLOAD, KEY);
  assert.equal(cipher.length, media.aesEcbPaddedSize(PAYLOAD.length));
  assert.equal(cipher.length % 16, 0);
  assert.ok(media.aesEcbDecrypt(cipher, KEY).equals(PAYLOAD));
  // 空 buffer 也会填充一个分组
  assert.equal(media.aesEcbEncrypt(Buffer.alloc(0), KEY).length, 16);

  assert.ok(media.parseAesKey(KEY.toString('base64')).equals(KEY));
  assert.ok(media.parseAesKey(Buffer.from(KEY_HEX).toString('base64')).equals(KEY));
  assert.throws(() => media.parseAesKey(Buffer.from('short').toString('base64')));
});

test('media MIME / 文件名 / 类型检测', () => {
  assert.equal(media.normalizeMime('IMAGE/PNG; charset=x'), 'image/png');
  assert.equal(media.getMimeFromFilename('a.PDF'), 'application/pdf');
  assert.equal(media.getExtensionFromMime('video/mp4'), '.mp4');
  assert.equal(media.detectKind({ mime: 'image/jpeg' }), 'image');
  assert.equal(media.detectKind({ mime: '', fileName: 'a.mp4' }), 'video');
  assert.equal(media.detectKind({ mime: 'application/pdf' }), 'file');
  // 白名单外的 image/*（svg/tiff）按普通文件发送（docs/MEDIA.md §3.2）
  assert.equal(media.detectKind({ mime: 'image/svg+xml' }), 'file');
  assert.equal(media.detectKind({ mime: 'application/octet-stream', fileName: 'logo.svg' }), 'file');
  assert.equal(media.detectKind({ mime: '', fileName: 'a.mp4' }), 'video');
  assert.equal(media.detectKind({ mime: 'video/x-msvideo' }), 'file');
  assert.equal(media.sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(media.sanitizeFileName('a/b\\c.txt'), 'c.txt');
  assert.equal(media.sanitizeFileName('x'.repeat(400)), `${'x'.repeat(120)}`);
  assert.equal(media.sanitizeFileName(''), 'file.bin');
  assert.equal(media.sanitizeFileName(encodeURIComponent('报告 v1.pdf')), '报告 v1.pdf');

  assert.equal(media.sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
  assert.equal(media.sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  const mp4 = Buffer.alloc(16);
  mp4.write('ftypisom', 4, 'ascii');
  assert.equal(media.sniffMime(mp4), 'video/mp4');
});

test('media 存储: 保存/读取/防目录穿越/限制信息', async () => {
  const saved = await media.saveMediaBuffer({ direction: 'outbound', buffer: PAYLOAD, mime: 'image/png' });
  assert.match(saved.id, /^att_[0-9a-f-]{36}$/);
  assert.equal(saved.path, `outbound/${saved.id}.png`);
  assert.equal(saved.size, PAYLOAD.length);
  assert.equal(saved.sha256.length, 64);
  const readBack = await media.readMediaFile(saved.path);
  assert.ok(readBack.equals(PAYLOAD));
  await assert.rejects(() => media.readMediaFile('../../etc/passwd'));
  const limits = media.getMediaLimits();
  assert.equal(limits.maxBytes, config.media.outboundMaxBytes);
  assert.ok(limits.allowedImage.includes('image/png'));
});

test('media 消息 item 构造: image/video/file 字段与官方一致', () => {
  const uploaded = {
    downloadParam: 'dl_param_1',
    aeskeyHex: KEY_HEX,
    cipherSize: 160,
    plainSize: 123,
    fileName: '报告.pdf',
  };
  // 微信出站 aes_key = base64(32 字符 hex key 的 ASCII 字节)（官方 send.ts/第三方 CLI 一致）
  const expectedAesKey = Buffer.from(KEY_HEX, 'utf8').toString('base64');
  const image = media.buildMediaItem({ kind: 'image', uploaded });
  assert.deepEqual(image, {
    type: 2,
    image_item: {
      media: { encrypt_query_param: 'dl_param_1', aes_key: expectedAesKey, encrypt_type: 1 },
      mid_size: 160,
    },
  });
  const video = media.buildMediaItem({ kind: 'video', uploaded });
  assert.equal(video.type, 5);
  assert.equal(video.video_item.video_size, 160);
  assert.equal(video.video_item.media.aes_key, expectedAesKey);
  const file = media.buildMediaItem({ kind: 'file', uploaded, fileName: '报告.pdf' });
  assert.equal(file.type, 4);
  assert.equal(file.file_item.file_name, '报告.pdf');
  assert.equal(file.file_item.len, '123');
  assert.equal(file.file_item.media.aes_key, expectedAesKey);

  // 模拟微信接收端的 aes_key 解析：base64 → 32 字符 hex → 16 字节 key，且能解出上报密文
  const decoded = Buffer.from(expectedAesKey, 'base64').toString('ascii');
  assert.match(decoded, /^[0-9a-f]{32}$/);
  assert.ok(Buffer.from(decoded, 'hex').equals(KEY));
  const ciphertext = media.aesEcbEncrypt(PAYLOAD, KEY);
  assert.ok(media.aesEcbDecrypt(ciphertext, Buffer.from(decoded, 'hex')).equals(PAYLOAD));

  assert.throws(() => media.assertOutboundKindSupported('voice'));
  assert.doesNotThrow(() => media.assertOutboundKindSupported('image'));
});

test('media 入站 item 提取: 图片 aeskey hex 优先 / 文件语音视频 base64(hex key)', () => {
  const items = media.extractInboundMediaItems({
    item_list: [
      { type: 2, image_item: { media: { encrypt_query_param: 'p1', aes_key: KEY.toString('base64') }, aeskey: KEY_HEX } },
      { type: 3, voice_item: { media: { encrypt_query_param: 'p2', aes_key: Buffer.from(KEY_HEX).toString('base64') }, text: '转文字' } },
      { type: 4, file_item: { media: { encrypt_query_param: 'p3', aes_key: Buffer.from(KEY_HEX).toString('base64') }, file_name: 'a.pdf' } },
      { type: 5, video_item: { media: { encrypt_query_param: 'p4', aes_key: Buffer.from(KEY_HEX).toString('base64') } } },
      { type: 1, text_item: { text: 'hi' } },
    ],
  });
  assert.equal(items.length, 4);
  assert.equal(items[0].kind, 'image');
  assert.equal(items[0].aesKeyOverride, KEY.toString('base64'));
  assert.equal(items[1].kind, 'voice');
  assert.equal(items[1].mime, 'audio/silk');
  assert.equal(items[2].kind, 'file');
  assert.equal(items[2].fileName, 'a.pdf');
  assert.equal(items[2].mime, 'application/pdf');
  assert.equal(items[3].kind, 'video');
});

// ---------------------------------------------------------------------------
// 假 iLink + 假 CDN：验证出站上传管线与入站下载解密
// ---------------------------------------------------------------------------

function startFakeCdn() {
  const state = {
    uploadUrlRequests: [],
    uploads: [],
    files: new Map(),
    tokenSeq: 0,
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/ilink/bot/getuploadurl') {
      const json = JSON.parse(body.toString('utf8'));
      state.uploadUrlRequests.push(json);
      const token = `up_${state.tokenSeq++}`;
      state.files.set(String(json.filekey), { token, aeskey: json.aeskey, ciphertext: null, plaintext: null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ret: 0, upload_param: 'param_1', upload_full_url: `http://127.0.0.1:${server.address().port}/cdn/upload?filekey=${json.filekey}` }));
      return;
    }
    if (url.pathname === '/cdn/upload') {
      const filekey = url.searchParams.get('filekey');
      const record = state.files.get(filekey);
      if (!record) {
        res.writeHead(404).end('unknown filekey');
        return;
      }
      record.ciphertext = body;
      record.plaintext = media.aesEcbDecrypt(body, Buffer.from(record.aeskey, 'hex'));
      state.uploads.push({ filekey });
      res.writeHead(200, { 'x-encrypted-param': record.token, 'Content-Type': 'application/octet-stream' });
      res.end();
      return;
    }
    if (url.pathname === '/cdn/download') {
      const param = url.searchParams.get('encrypted_query_param');
      const record = [...state.files.values()].find((item) => item.token === param);
      if (!record || !record.ciphertext) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(record.ciphertext);
      return;
    }
    res.writeHead(404).end('not found');
  });
  return { server, state };
}

test('media 出站上传: getuploadurl 字段、AES 加密、CDN 上传与 x-encrypted-param', async () => {
  const { server, state } = startFakeCdn();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const uploaded = await media.uploadMediaToCdn({
      baseUrl,
      token: 'tok',
      toUserId: 'wx_user_1',
      kind: 'image',
      buffer: PAYLOAD,
      fileName: 'a.png',
      cdnBaseUrl: `${baseUrl}/cdn`,
      timeoutMs: 3000,
    });
    assert.match(uploaded.filekey, /^[0-9a-f]{32}$/);
    assert.equal(uploaded.downloadParam, 'up_0');
    assert.equal(uploaded.plainSize, PAYLOAD.length);
    assert.equal(uploaded.cipherSize, media.aesEcbPaddedSize(PAYLOAD.length));
    assert.equal(uploaded.md5, (await import('node:crypto')).createHash('md5').update(PAYLOAD).digest('hex'));

    const reqBody = state.uploadUrlRequests[0];
    assert.equal(reqBody.media_type, UploadMediaType.IMAGE);
    assert.equal(reqBody.to_user_id, 'wx_user_1');
    assert.equal(reqBody.rawsize, PAYLOAD.length);
    assert.equal(reqBody.filesize, media.aesEcbPaddedSize(PAYLOAD.length));
    assert.equal(reqBody.no_need_thumb, true);
    assert.equal(reqBody.aeskey, uploaded.aeskeyHex);
    assert.ok(reqBody.base_info.channel_version);

    // 假 CDN 用请求里的 aeskey 解密成功，说明加密内容正确
    assert.ok(state.uploads.length === 1);
    const record = [...state.files.values()][0];
    assert.ok(record.plaintext.equals(PAYLOAD));

    // 用上传结果构造媒体消息 item
    const item = media.buildMediaItem({ kind: 'image', uploaded });
    assert.equal(item.type, 2);
    assert.equal(item.image_item.mid_size, uploaded.cipherSize);
  } finally {
    server.close();
  }
});

test('media 入站下载: full_url 优先、无 full_url 时拼接 download URL、两种 aes_key 形态均可解密', async () => {
  const { server, state } = startFakeCdn();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const cdnBaseUrl = `${baseUrl}/cdn`;
  try {
    // 构造一个入站媒体文件：写入假 CDN（直接上传密文）
    const cipher = media.aesEcbEncrypt(PAYLOAD, KEY);
    state.files.set('inbound-1', {
      token: 'dl_in_1',
      aeskey: KEY_HEX,
      ciphertext: cipher,
      plaintext: PAYLOAD,
    });

    // 1) 无 full_url，走拼接下载 URL，aes_key = base64(raw key)（图片常见）
    const r1 = await media.downloadAndDecryptInbound({
      cdnBaseUrl,
      media: { encrypt_query_param: 'dl_in_1', aes_key: KEY.toString('base64') },
      timeoutMs: 3000,
    });
    assert.ok(r1.buffer.equals(PAYLOAD));
    assert.equal(r1.encrypted, true);

    // 2) full_url 优先 + aes_key = base64(hex)（文件常见）
    const r2 = await media.downloadAndDecryptInbound({
      cdnBaseUrl,
      media: {
        encrypt_query_param: 'ignored',
        aes_key: Buffer.from(KEY_HEX).toString('base64'),
        full_url: `${cdnBaseUrl}/download?encrypted_query_param=dl_in_1`,
      },
      timeoutMs: 3000,
    });
    assert.ok(r2.buffer.equals(PAYLOAD));

    // 3) 超限保护
    await assert.rejects(() =>
      media.downloadAndDecryptInbound({
        cdnBaseUrl,
        media: { encrypt_query_param: 'dl_in_1', aes_key: KEY.toString('base64') },
        maxBytes: 10,
      }),
    );
  } finally {
    server.close();
  }
});
