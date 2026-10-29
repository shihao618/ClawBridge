/**
 * e2e：多媒体（图片 / 视频 / 文件）全链路（黑盒 HTTP，契约见 docs/MEDIA.md）。
 *
 * 覆盖：
 *  - 出站：admin 上传原始二进制 → 201 → 发送 {text, mediaId} → mock getuploadurl 记录 / CDN 收到密文
 *    可解密且 sha256 匹配原图 → mock 记录 image_item/video_item/file_item 字段正确 → outbox sent/attempts=1；
 *    并校验出站 CDNMedia.aes_key = base64(32 字符 hex key 的 ASCII)（44 字符），
 *    按接收端逻辑 base64 decode → 32 hex chars → hex decode 16B 后能解密 mock CDN 密文；
 *  - 入站：mock 控制面注入 image/file/video → 后台消息记录 attachments 可见 →
 *    GET /api/admin/media/{id} 字节与原内容一致（含 ?download=1 与 Range）；
 *  - 鉴权/校验：未登录/错误 Key 401、缺文件名 400、语音出站 400、超限 413、非 active 用户 409；
 *  - 对外 API：POST /api/v1/media 上传 → POST /api/v1/messages 发送 → GET /api/v1/media/{id} 读取。
 *
 * 全部使用随机端口 + 临时 DATA_DIR 子进程，不触碰真实 demo 容器（127.0.0.1:3000）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

import { assertBigMessageId, b64HexKey, startE2E } from '../helpers/e2e-env.mjs';

let e2e;
/** @type {{user: object, account: object}} */
let mediaUser;

// ---------------------------------------------------------------------------
// 测试数据工具
// ---------------------------------------------------------------------------
function makeBytes(size, seed = 1) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buffer[i] = (seed * 31 + i * 17) % 256;
  return buffer;
}

/** 带真实 PNG 魔数的测试图片（服务端入站按魔数嗅探 MIME）。 */
function makePng(size, seed = 1) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, makeBytes(Math.max(0, size - signature.length), seed)]);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const md5 = (buffer) => createHash('md5').update(buffer).digest('hex');
/** AES-128-ECB/PKCS7 密文长度。 */
const cfCipherSize = (plainSize) => Math.floor(plainSize / 16) * 16 + 16;

/** 从 mock CDN 下载密文并按接收端逻辑解析 aes_key 解密（helper 复用，证明出站 aes_key 格式正确）。 */
const decryptMockCdnCiphertext = (cdnToken, aesKeyBase64) => e2e.decryptMockCdnCiphertext(cdnToken, aesKeyBase64);

before(async () => {
  e2e = await startE2E();
  await e2e.ensureAdmin();
  const bound = await e2e.bindUser({ displayName: '媒体用户A', waitMonitor: true });
  mediaUser = { user: bound.user, account: bound.account };
});

after(async () => {
  await e2e?.cleanup();
});

test('出站图片：admin 上传 → 发送 {text, mediaId} → mock CDN 解密+sha256 匹配 → image_item 字段正确 → outbox sent', async () => {
  const image = makeBytes(3200, 7);

  // 1) 上传：原始二进制 + Content-Type + X-File-Name
  const upload = await e2e.uploadAdminMedia(image, { fileName: '测试图片.png', mime: 'image/png' });
  assert.equal(upload.status, 201, `上传应 201，实际 ${upload.status}：${upload.text}`);
  const media = upload.json.media;
  assert.ok(media?.id?.startsWith('att_'), `media.id 应为 att_ 前缀：${JSON.stringify(media)}`);
  assert.equal(media.kind, 'image');
  assert.equal(media.mime, 'image/png');
  assert.equal(media.fileName, '测试图片.png');
  assert.equal(media.size, image.length);
  assert.equal(media.url, `/api/admin/media/${media.id}`);
  assert.ok(upload.json.limits?.maxBytes > 0, '响应应包含 limits.maxBytes');

  // 上传后可立即读取且字节一致
  const readBack = await e2e.getAdminMedia(media.id);
  assert.equal(readBack.status, 200);
  assert.deepEqual(readBack.buffer, image, '上传后读取字节应与原文件一致');
  assert.equal(readBack.headers.get('content-type'), 'image/png');

  // 2) 发送：caption 文本 + 媒体
  const caption = '图片消息说明';
  const send = await e2e.adminWrite('POST', `/api/admin/users/${mediaUser.user.id}/messages`, {
    text: caption,
    mediaId: media.id,
  });
  assert.equal(send.status, 202, `发送应 202，实际 ${send.status}：${send.text}`);
  const queued = send.json.queued[0];
  assert.equal(queued.userId, mediaUser.user.id);
  assert.equal(queued.media?.id, media.id);

  // 3) mock：先收到 caption 文本消息，再收到图片消息
  const captionRecord = await e2e.waitSentMessage(caption, { botId: mediaUser.account.botId });
  assert.deepEqual(captionRecord.itemTypes, [1]);
  const imageRecord = await e2e.waitSentItem((item) => item.kind === 'image', { label: 'mock 收到图片媒体 item' });
  const imageItem = imageRecord.itemList.find((item) => item.kind === 'image');

  // 4) mock getuploadurl 记录：filekey/media_type/rawsize/rawfilemd5/filesize/aeskey/botId/明文字段
  const uploadRecord = await e2e.waitMockUpload(
    (record) => record.mediaType === 1 && record.toUserId === mediaUser.user.wechatUserId && record.token,
    { label: 'mock getuploadurl 记录（image）' },
  );
  assert.equal(uploadRecord.rawsize, image.length);
  assert.equal(uploadRecord.rawfilemd5, md5(image));
  assert.equal(uploadRecord.filesize, cfCipherSize(image.length));
  assert.match(uploadRecord.aeskey, /^[0-9a-f]{32}$/, 'aeskey 应为 32 hex');
  assert.equal(uploadRecord.noNeedThumb, true);
  assert.equal(uploadRecord.botId, mediaUser.account.botId);
  assert.equal(uploadRecord.plainSha256, sha256(image), 'mock 解密后 sha256 应与原图一致');
  assert.equal(uploadRecord.plainSize, image.length);
  assert.equal(uploadRecord.cipherSize, cfCipherSize(image.length), 'CDN 收到密文长度应为 AES-128-ECB/PKCS7 结果');

  const cdnFile = await e2e.waitMockCdnFile((file) => file.token === uploadRecord.token);
  assert.equal(cdnFile.plaintextSha256, sha256(image));
  assert.equal(cdnFile.direction, 'outbound');

  // 5) 图片 item 字段：type=2、encrypt_query_param、aes_key=base64(hex ascii)（微信要求）、encrypt_type=1、mid_size
  assert.equal(imageItem.type, 2);
  assert.equal(imageItem.media.encryptQueryParam, uploadRecord.token, 'image_item.media.encrypt_query_param 应为 CDN token');
  assert.equal(imageItem.media.encryptType, 1);
  assert.equal(imageItem.media.aesKey, b64HexKey(uploadRecord.aeskey), '出站 aes_key 应为 base64(32 字符 hex key 的 ASCII)');
  assert.equal(imageItem.media.aesKey.length, 44, 'base64(32 字符 hex ascii) 应为 44 字符');
  // 接收端解析（base64→hex→16B）并用该 key 解密 mock CDN 密文 → 原图（证明格式正确，真实微信同逻辑）
  assert.deepEqual(
    await decryptMockCdnCiphertext(uploadRecord.token, imageItem.media.aesKey),
    image,
    '接收端解析 aes_key 后应能解密 CDN 密文得到原图',
  );
  assert.equal(imageItem.midSize, cfCipherSize(image.length), 'image_item.mid_size 应为密文字节数');

  // 6) outbox 投递成功（首投 attempts=1，message_id 无损字符串）
  const outbox = await e2e.waitOutbox(queued.outboxId, 'sent');
  assert.equal(outbox.status, 'sent');
  assert.equal(outbox.attempts, 1);
  assertBigMessageId(outbox.serverMessageId, '媒体 outbox.serverMessageId');

  // 7) 管理后台消息记录带 attachments：等 outbox sent 后，再等附件 ready（出站附件上传即 ready，仍显式等待防竞态）
  const outboundReady = await e2e.waitAttachmentsReady(
    (row) => row.direction === 'outbound' && (row.attachments ?? []).some((item) => item.id === media.id),
    { direction: 'outbound', kind: 'image', label: '出站图片附件 ready' },
  );
  const attachment = outboundReady.attachments.find((item) => item.id === media.id);
  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.mime, 'image/png');
  assert.equal(attachment.fileName, '测试图片.png');
  assert.equal(attachment.size, image.length);
  assert.equal(attachment.status, 'ready');
  assert.equal(attachment.url, `/api/admin/media/${media.id}`);
  assert.equal(attachment.downloadUrl, `/api/admin/media/${media.id}?download=1`);

  // 8) mock 不应记录媒体字段违规
  const state = await e2e.mockState();
  const mediaViolations = state.rejections.filter(
    (entry) => entry.endpoint === 'sendmessage' && /media|item_list/.test(entry.reason),
  );
  assert.equal(mediaViolations.length, 0, `不应有媒体字段违规：${JSON.stringify(mediaViolations)}`);

  await e2e.waitQueueDrained();
});

test('出站视频/文件：video_item.video_size、file_item.file_name/len；无 caption 可发送', async () => {
  // ---- 视频 ----
  const video = makeBytes(4100, 11);
  const videoUpload = await e2e.uploadAdminMedia(video, { fileName: 'demo.mp4', mime: 'video/mp4' });
  assert.equal(videoUpload.status, 201, `视频上传应 201：${videoUpload.status} ${videoUpload.text}`);
  assert.equal(videoUpload.json.media.kind, 'video');
  const videoSend = await e2e.adminWrite('POST', `/api/admin/users/${mediaUser.user.id}/messages`, {
    mediaId: videoUpload.json.media.id,
  });
  assert.equal(videoSend.status, 202, `仅媒体（无 caption）发送应 202：${videoSend.status} ${videoSend.text}`);

  const videoRecord = await e2e.waitSentItem((item) => item.kind === 'video');
  const videoItem = videoRecord.itemList.find((item) => item.kind === 'video');
  const videoUploadRecord = await e2e.waitMockUpload(
    (record) => record.mediaType === 2 && record.plainSize === video.length && record.token,
    { label: 'mock getuploadurl 记录（video）' },
  );
  assert.equal(videoItem.type, 5);
  assert.equal(videoItem.videoSize, cfCipherSize(video.length), 'video_item.video_size 应为密文字节数');
  assert.equal(videoItem.media.encryptType, 1);
  assert.equal(videoItem.media.aesKey, b64HexKey(videoUploadRecord.aeskey), '出站 aes_key 应为 base64(32 字符 hex key 的 ASCII)');
  assert.deepEqual(
    await decryptMockCdnCiphertext(videoUploadRecord.token, videoItem.media.aesKey),
    video,
    '视频：接收端解析 aes_key 后应能解密 CDN 密文',
  );
  assert.equal(videoUploadRecord.plainSha256, sha256(video));
  assert.equal(videoUploadRecord.rawfilemd5, md5(video));

  // ---- 文件 ----
  const fileBytes = makeBytes(1800, 13);
  const fileUpload = await e2e.uploadAdminMedia(fileBytes, { fileName: '报告 final.pdf', mime: 'application/pdf' });
  assert.equal(fileUpload.status, 201, `文件上传应 201：${fileUpload.status} ${fileUpload.text}`);
  assert.equal(fileUpload.json.media.kind, 'file');
  const fileCaption = '附件如下';
  const fileSend = await e2e.adminWrite('POST', `/api/admin/users/${mediaUser.user.id}/messages`, {
    text: fileCaption,
    mediaId: fileUpload.json.media.id,
  });
  assert.equal(fileSend.status, 202);

  const fileRecord = await e2e.waitSentItem((item) => item.kind === 'file' && item.fileName === '报告 final.pdf');
  const fileItem = fileRecord.itemList.find((item) => item.kind === 'file' && item.fileName === '报告 final.pdf');
  const fileUploadRecord = await e2e.waitMockUpload(
    (record) => record.mediaType === 3 && record.plainSize === fileBytes.length && record.token,
    { label: 'mock getuploadurl 记录（file）' },
  );
  assert.equal(fileItem.type, 4);
  assert.equal(fileItem.fileName, '报告 final.pdf', 'file_item.file_name 应为原始文件名');
  assert.equal(fileItem.len, String(fileBytes.length), 'file_item.len 应为明文字节数字符串');
  assert.equal(fileItem.media.encryptQueryParam, fileUploadRecord.token);
  assert.equal(fileItem.media.aesKey, b64HexKey(fileUploadRecord.aeskey), '出站 aes_key 应为 base64(32 字符 hex key 的 ASCII)');
  assert.deepEqual(
    await decryptMockCdnCiphertext(fileUploadRecord.token, fileItem.media.aesKey),
    fileBytes,
    '文件：接收端解析 aes_key 后应能解密 CDN 密文',
  );
  assert.equal(fileUploadRecord.plainSha256, sha256(fileBytes));

  // 两条 outbox 均投递成功；再分别等待后台消息附件 ready
  for (const outboxId of [videoSend.json.queued[0].outboxId, fileSend.json.queued[0].outboxId]) {
    const outbox = await e2e.waitOutbox(outboxId, 'sent');
    assert.equal(outbox.attempts, 1);
    assert.equal(typeof outbox.serverMessageId, 'string');
  }
  const videoReady = await e2e.waitAttachmentsReady(
    (row) => row.direction === 'outbound' && (row.attachments ?? []).some((item) => item.id === videoUpload.json.media.id),
    { direction: 'outbound', kind: 'video', label: '出站视频附件 ready' },
  );
  assert.equal(videoReady.attachments[0].status, 'ready');
  const fileReady = await e2e.waitAttachmentsReady(
    (row) => row.direction === 'outbound' && (row.attachments ?? []).some((item) => item.id === fileUpload.json.media.id),
    { direction: 'outbound', kind: 'file', label: '出站文件附件 ready' },
  );
  assert.equal(fileReady.attachments[0].status, 'ready');
  await e2e.waitQueueDrained();
});

test('入站媒体：注入 image/file/video → 后台 attachments 可见 → GET /api/admin/media/{id} 字节一致（?download / Range）', async () => {
  await e2e.ensureAdmin();

  // ---- 图片（默认不带 full_url，走 ILINK_CDN_BASE_URL 下载；PNG 魔数便于服务端嗅探 MIME）----
  const image = makePng(2500, 21);
  const injectedImage = await e2e.mockInboundMedia(mediaUser.account.botId, {
    kind: 'image',
    fileName: 'in.png',
    mime: 'image/png',
    contentBase64: image.toString('base64'),
    context_token: 'ctx_media_inbound_1',
  });
  assert.equal(injectedImage.ok, true);
  assert.equal(injectedImage.contentSha256, sha256(image), 'mock 注入响应应返回原文 sha256');

  // 消息先入库、附件异步下载：必须等该消息的 image 附件 status='ready'（最多 20s 轮询）
  const imageReady = await e2e.waitAttachmentsReady(
    (row) => row.direction === 'inbound' && row.serverMessageId === injectedImage.message.message_id,
    { direction: 'inbound', kind: 'image', label: '入站图片附件 ready' },
  );
  const imageAttachment = imageReady.attachments[0];
  assert.ok(imageAttachment.id.startsWith('att_'));
  assert.equal(imageAttachment.mime, 'image/png', '入站图片 MIME 应由 PNG 魔数嗅探得到');
  assert.equal(imageAttachment.size, image.length);
  assert.equal(imageAttachment.status, 'ready');
  assert.equal(imageAttachment.url, `/api/admin/media/${imageAttachment.id}`);
  assert.equal(imageAttachment.downloadUrl, `/api/admin/media/${imageAttachment.id}?download=1`);

  const imageRead = await e2e.getAdminMedia(imageAttachment.id);
  assert.equal(imageRead.status, 200);
  assert.deepEqual(imageRead.buffer, image, 'GET /api/admin/media/{id} 字节应与注入原图一致');
  assert.equal(imageRead.headers.get('content-type'), 'image/png');

  const imageDownload = await e2e.getAdminMedia(imageAttachment.id, { download: true });
  assert.equal(imageDownload.status, 200);
  assert.match(imageDownload.headers.get('content-disposition') ?? '', /attachment/i, '?download=1 应返回 attachment');
  assert.deepEqual(imageDownload.buffer, image);

  // Range 请求（视频进度条场景）
  const range = await e2e.getAdminMedia(imageAttachment.id, { headers: { Range: 'bytes=0-15' } });
  assert.equal(range.status, 206, `Range 请求应 206，实际 ${range.status}`);
  assert.deepEqual(range.buffer, image.subarray(0, 16));

  // ---- 文件（fullUrl=true：走 mock 返回的 media.full_url）----
  const fileBytes = makeBytes(900, 22);
  const injectedFile = await e2e.mockInboundMedia(mediaUser.account.botId, {
    kind: 'file',
    fileName: '入站文档.pdf',
    mime: 'application/pdf',
    contentBase64: fileBytes.toString('base64'),
    fullUrl: true,
  });
  const fileReady = await e2e.waitAttachmentsReady(
    (row) => row.direction === 'inbound' && row.serverMessageId === injectedFile.message.message_id,
    { direction: 'inbound', kind: 'file', label: '入站文件附件 ready' },
  );
  const fileAttachment = fileReady.attachments[0];
  assert.equal(fileAttachment.kind, 'file');
  assert.equal(fileAttachment.mime, 'application/pdf');
  assert.equal(fileAttachment.fileName, '入站文档.pdf');
  assert.equal(fileAttachment.size, fileBytes.length);
  assert.equal(fileAttachment.status, 'ready');
  const fileRead = await e2e.getAdminMedia(fileAttachment.id);
  assert.equal(fileRead.status, 200);
  assert.deepEqual(fileRead.buffer, fileBytes);

  // ---- 视频 ----
  const video = makeBytes(1500, 23);
  const injectedVideo = await e2e.mockInboundMedia(mediaUser.account.botId, {
    kind: 'video',
    fileName: 'in.mp4',
    mime: 'video/mp4',
    contentBase64: video.toString('base64'),
  });
  const videoReady = await e2e.waitAttachmentsReady(
    (row) => row.direction === 'inbound' && row.serverMessageId === injectedVideo.message.message_id,
    { direction: 'inbound', kind: 'video', label: '入站视频附件 ready' },
  );
  const videoAttachment = videoReady.attachments[0];
  assert.equal(videoAttachment.mime, 'video/mp4');
  assert.equal(videoAttachment.size, video.length);
  assert.equal(videoAttachment.status, 'ready');
  const videoRead = await e2e.getAdminMedia(videoAttachment.id);
  assert.deepEqual(videoRead.buffer, video);

  // ---- 用户详情：入站附件可见 + context_token 已缓存 ----
  const detail = await e2e.waitUser(mediaUser.user.id, (data) => data.user.hasContextToken === true);
  assert.ok(detail.recentInbound.some((row) => Array.isArray(row.attachments) && row.attachments.length > 0));
  await e2e.waitQueueDrained();
});

test('鉴权 / 校验 / 语音出站错误路径：401、400、404', async () => {
  await e2e.ensureAdmin();

  // admin 上传未登录 → 401
  const noAuth = await e2e.request('POST', '/api/admin/media', {
    rawBody: Buffer.from('x'),
    headers: { 'Content-Type': 'image/png', 'X-File-Name': 'a.png' },
  });
  assert.equal(noAuth.status, 401, `未登录上传应 401：${noAuth.status} ${noAuth.text}`);
  assert.equal(noAuth.json.error.code, 'UNAUTHORIZED');

  // 缺少 X-File-Name → 400
  const noFileName = await e2e.request('POST', '/api/admin/media', {
    rawBody: Buffer.from('x'),
    headers: {
      'Content-Type': 'image/png',
      'X-Requested-With': 'ClawBridge-Admin',
      Cookie: e2e.adminCookie,
    },
  });
  assert.equal(noFileName.status, 400, `缺 X-File-Name 应 400：${noFileName.status} ${noFileName.text}`);
  assert.equal(noFileName.json.error.code, 'BAD_REQUEST');

  // 语音出站不支持：入站 voice 附件不能作为出站媒体发送 → 400
  const voiceBytes = Buffer.from('[fake-silk-voice]');
  const injectedVoice = await e2e.mockInboundMedia(mediaUser.account.botId, {
    kind: 'voice',
    fileName: 'voice.silk',
    mime: 'audio/silk',
    contentBase64: voiceBytes.toString('base64'),
  });
  const voiceReady = await e2e.waitAttachmentsReady(
    (row) => row.direction === 'inbound' && row.serverMessageId === injectedVoice.message.message_id,
    { direction: 'inbound', kind: 'voice', label: '入站语音附件 ready' },
  );
  const voiceAttachment = voiceReady.attachments[0];
  assert.equal(voiceAttachment.mime, 'audio/silk');
  assert.equal(voiceAttachment.status, 'ready');
  const voiceSend = await e2e.adminWrite('POST', `/api/admin/users/${mediaUser.user.id}/messages`, {
    mediaId: voiceAttachment.id,
  });
  assert.equal(voiceSend.status, 400, `语音出站应 400：${voiceSend.status} ${voiceSend.text}`);
  assert.equal(voiceSend.json.error.code, 'BAD_REQUEST');

  // 音频文件上传：服务端若明确拒绝（400）则校验错误信息；若按普通文件接收（201，当前 detectKind 对 audio/* 归为 file）也接受
  const audioUpload = await e2e.uploadAdminMedia(Buffer.from('fake-silk-bytes'), {
    fileName: 'voice.silk',
    mime: 'audio/silk',
  });
  if (audioUpload.status === 400) {
    assert.equal(audioUpload.json.error.code, 'BAD_REQUEST');
    assert.match(audioUpload.json.error.message, /语音|音频|voice|audio|不支持/i);
  } else {
    assert.equal(audioUpload.status, 201, `音频上传预期 400 或 201，实际 ${audioUpload.status} ${audioUpload.text}`);
    assert.equal(audioUpload.json.media.kind, 'file', '当前实现将 audio/* 归为普通文件');
  }

  // 上传一个合法媒体用于读取鉴权用例
  const validUpload = await e2e.uploadAdminMedia(makeBytes(256, 41), { fileName: 'auth.png', mime: 'image/png' });
  assert.equal(validUpload.status, 201);
  const mediaId = validUpload.json.media.id;

  // 未登录 / 错误 Key 读取 → 401
  const noAuthRead = await e2e.request('GET', `/api/admin/media/${mediaId}`, { headers: {} });
  assert.equal(noAuthRead.status, 401);
  const badV1Key = await e2e.request('GET', `/api/v1/media/${mediaId}`, { headers: { Authorization: 'Bearer wrong-token' } });
  assert.equal(badV1Key.status, 401);
  const v1NoAuth = await e2e.request('GET', `/api/v1/media/${mediaId}`);
  assert.equal(v1NoAuth.status, 401);

  // v1 上传鉴权失败 → 401
  const badUploadKey = await e2e.request('POST', '/api/v1/media', {
    rawBody: Buffer.from('x'),
    headers: { 'Content-Type': 'image/png', 'X-File-Name': 'a.png', Authorization: 'Bearer wrong-token' },
  });
  assert.equal(badUploadKey.status, 401);

  // 不存在的媒体 → 404
  const missing = await e2e.getAdminMedia('att_not_exists_e2e');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');
});

test('超限：MEDIA_MAX_BYTES 调小后上传 → 413（独立随机端口环境）', async () => {
  const small = await startE2E({ appEnv: { MEDIA_MAX_BYTES: '2048' } });
  try {
    await small.ensureAdmin();
    const config = await small.adminGet('/api/admin/config');
    assert.equal(config.status, 200);
    assert.equal(config.json.media?.maxBytes, 2048, 'config.media.maxBytes 应反映 MEDIA_MAX_BYTES');

    const oversized = await small.uploadAdminMedia(makeBytes(4096, 43), {
      fileName: 'big.bin',
      mime: 'application/octet-stream',
    });
    assert.equal(oversized.status, 413, `超限上传应 413：${oversized.status} ${oversized.text}`);
    assert.equal(oversized.json.error.code, 'BAD_REQUEST');
  } finally {
    await small.cleanup();
  }
});

test('对外 API：v1 上传 → 发送 → 读取字节一致', async () => {
  await e2e.ensureAdmin();
  const bytes = makeBytes(1200, 31);

  const upload = await e2e.uploadV1Media(bytes, { fileName: 'v1-photo.jpg', mime: 'image/jpeg' });
  assert.equal(upload.status, 201, `v1 上传应 201：${upload.status} ${upload.text}`);
  const media = upload.json.media;
  assert.equal(media.kind, 'image');
  assert.equal(media.mime, 'image/jpeg');
  assert.equal(media.size, bytes.length);

  const read = await e2e.getV1Media(media.id);
  assert.equal(read.status, 200);
  assert.deepEqual(read.buffer, bytes, 'GET /api/v1/media/{id} 字节应一致');

  const caption = 'v1 媒体消息';
  const send = await e2e.api('POST', '/api/v1/messages', {
    body: { to: [mediaUser.user.id], text: caption, mediaId: media.id },
    headers: { Authorization: `Bearer ${e2e.apiToken}` },
  });
  assert.equal(send.status, 202, `v1 发送应 202：${send.status} ${send.text}`);
  assert.equal(send.json.accepted, 1);
  const queued = send.json.queued[0];

  const uploadRecord = await e2e.waitMockUpload(
    (record) => record.mediaType === 1 && record.plainSize === bytes.length && record.token,
    { label: 'v1 上传的 mock getuploadurl 记录' },
  );
  const record = await e2e.waitSentItem((item) => item.media?.encryptQueryParam === uploadRecord.token);
  const item = record.itemList.find((entry) => entry.media?.encryptQueryParam === uploadRecord.token);
  assert.equal(item.kind, 'image');
  assert.equal(item.media.aesKey, b64HexKey(uploadRecord.aeskey), 'v1 出站 aes_key 应为 base64(32 字符 hex key 的 ASCII)');
  assert.deepEqual(
    await decryptMockCdnCiphertext(uploadRecord.token, item.media.aesKey),
    bytes,
    'v1 出站：接收端解析 aes_key 后应能解密 CDN 密文',
  );
  assert.equal(uploadRecord.plainSha256, sha256(bytes));

  const outbox = await e2e.waitOutbox(queued.outboxId, 'sent');
  assert.equal(outbox.attempts, 1);
  assertBigMessageId(outbox.serverMessageId, 'v1 媒体 outbox.serverMessageId');

  // 出站消息附件 ready
  const v1Ready = await e2e.waitAttachmentsReady(
    (row) => row.direction === 'outbound' && (row.attachments ?? []).some((item) => item.id === media.id),
    { direction: 'outbound', kind: 'image', label: 'v1 出站图片附件 ready' },
  );
  assert.equal(v1Ready.attachments[0].status, 'ready');

  // v1 读取鉴权：错误 Key → 401
  const badRead = await e2e.request('GET', `/api/v1/media/${media.id}`, { headers: { Authorization: 'Bearer wrong-token' } });
  assert.equal(badRead.status, 401);
  await e2e.waitQueueDrained();
});

test('非 active 用户发送媒体 → 409 CONFLICT', async () => {
  await e2e.ensureAdmin();
  const bound = await e2e.bindUser({ displayName: '媒体解绑用户', waitMonitor: true });
  const upload = await e2e.uploadAdminMedia(makeBytes(300, 51), { fileName: 'x.png', mime: 'image/png' });
  assert.equal(upload.status, 201);
  const unbind = await e2e.adminWrite('POST', `/api/admin/users/${bound.user.id}/unbind`);
  assert.equal(unbind.status, 200);
  const send = await e2e.adminWrite('POST', `/api/admin/users/${bound.user.id}/messages`, {
    text: '解绑后发送媒体',
    mediaId: upload.json.media.id,
  });
  assert.equal(send.status, 409, `解绑用户发送媒体应 409：${send.status} ${send.text}`);
  assert.equal(send.json.error.code, 'CONFLICT');
});
