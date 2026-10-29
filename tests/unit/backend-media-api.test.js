/**
 * 单元测试：api.js 多媒体路由（docs/MEDIA.md §5）。
 *
 * 进程内启动真实 Express 应用（临时 DATA_DIR/MEDIA_DIR，无真实网络）：
 *  - POST /api/admin/media、/api/v1/media：原始二进制 + X-File-Name、鉴权/CSRF、413 超限；
 *  - GET media：Cookie/API Key 鉴权、字节一致、inline/attachment、Range、404；
 *  - 发送 {text, mediaId}：queued 项带 media 摘要、outbox.media_id、参数校验；
 *  - 管理端消息/用户详情附件视图；/api/admin/config 媒体限制；CSP media-src。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-media-api-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'media-api-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'media-api-admin-password';
process.env.API_TOKEN = 'media-api-token-123456';
process.env.ILINK_LOGIN_BASE_URL = 'http://127.0.0.1:9';
process.env.ILINK_BASE_URL = 'http://127.0.0.1:9';
process.env.LOG_LEVEL = 'silent';
process.env.MEDIA_MAX_BYTES = '2048'; // 便于 413 测试
process.env.INBOUND_MEDIA_MAX_BYTES = '104857600';

const { createApp } = await import('../../server/src/api.js');
const store = await import('../../server/src/store.js');
const media = await import('../../server/src/media.js');
const { closeDb } = await import('../../server/src/db.js');

/** @type {import('node:http').Server} */
let server;
let base = '';
let cookie = '';
const CSRF_HEADERS = { 'x-requested-with': 'ClawBridge-Admin' };

before(async () => {
  const { seedTestAdminSecrets } = await import('./backend-test-secrets.js');
  seedTestAdminSecrets();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'media-api-admin-password' }),
  });
  assert.equal(login.status, 200);
  cookie = /cb_session=[^;]+/.exec(login.headers.get('set-cookie') || '')[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x10, 0x20,
  0x30, 0x40, 0x50, 0x60,
]);

async function request(method, pathName, { body, headers = {}, raw } = {}) {
  const response = await fetch(base + pathName, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(raw !== undefined ? { body: raw } : {}),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, buffer, json };
}

function uploadHeaders({ fileName = '测试 图片.png', mime = 'image/png', authCookie = cookie, csrf = true } = {}) {
  return {
    'content-type': mime,
    'x-file-name': encodeURIComponent(fileName),
    ...(authCookie ? { cookie: authCookie } : {}),
    ...(csrf ? CSRF_HEADERS : {}),
  };
}

function createUser() {
  return store.upsertBoundUser({
    wechatUserId: 'wx_media_api_user',
    displayName: '媒体 API 用户',
    ilinkBotId: 'bot_media_api@im.bot',
    botToken: 'token-media-api',
    baseUrl: 'https://ilink.example.test',
  }).user;
}

test('CSP 增加 media-src self（视频预览不被拦截）', async () => {
  const result = await request('GET', '/health');
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-security-policy') || '', /media-src 'self'/);
});

test('管理端上传：鉴权/CSRF/缺文件名/成功 201 与字段', async () => {
  // 未登录 → 401
  const unauth = await request('POST', '/api/admin/media', {
    raw: PNG_BYTES,
    headers: uploadHeaders({ authCookie: null }),
  });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.json.error.code, 'UNAUTHORIZED');

  // 已登录但缺 CSRF 头 → 403
  const noCsrf = await request('POST', '/api/admin/media', {
    raw: PNG_BYTES,
    headers: uploadHeaders({ csrf: false }),
  });
  assert.equal(noCsrf.status, 403);

  // 缺 X-File-Name → 400
  const noName = await request('POST', '/api/admin/media', {
    raw: PNG_BYTES,
    headers: { 'content-type': 'image/png', cookie, ...CSRF_HEADERS },
  });
  assert.equal(noName.status, 400);
  assert.match(noName.json.error.message, /X-File-Name/);

  // 成功上传
  const ok = await request('POST', '/api/admin/media', {
    raw: PNG_BYTES,
    headers: uploadHeaders({ fileName: '测试 图片.png', mime: 'image/png' }),
  });
  assert.equal(ok.status, 201, ok.buffer.toString('utf8'));
  const { media: item, limits } = ok.json;
  assert.match(item.id, /^att_/);
  assert.equal(item.kind, 'image');
  assert.equal(item.mime, 'image/png');
  assert.equal(item.fileName, '测试 图片.png');
  assert.equal(item.size, PNG_BYTES.length);
  assert.equal(item.url, `/api/admin/media/${item.id}`);
  assert.equal(limits.maxBytes, 2048);
  assert.ok(Array.isArray(limits.allowedImage) && limits.allowedImage.includes('image/png'));

  // 落盘且为上传的原始字节
  const attachments = store.getAttachment(item.id);
  assert.equal(attachments.direction, 'outbound');
  assert.deepEqual(await media.readMediaFile(attachments.path), PNG_BYTES);
});

test('管理端读取媒体：字节一致 / inline / download / Range / 404', async () => {
  const upload = await request('POST', '/api/admin/media', {
    raw: PNG_BYTES,
    headers: uploadHeaders({ fileName: 'read.png' }),
  });
  const mediaId = upload.json.media.id;

  const read = await request('GET', `/api/admin/media/${mediaId}`, { headers: { cookie } });
  assert.equal(read.status, 200);
  assert.deepEqual(read.buffer, PNG_BYTES);
  assert.equal(read.headers.get('content-type'), 'image/png');
  assert.match(read.headers.get('content-disposition') || '', /^inline;/);
  assert.match(read.headers.get('cache-control') || '', /private/);
  assert.equal(read.headers.get('accept-ranges'), 'bytes');

  // Range 请求
  const ranged = await request('GET', `/api/admin/media/${mediaId}`, {
    headers: { cookie, range: 'bytes=0-3' },
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-3/${PNG_BYTES.length}`);
  assert.deepEqual(ranged.buffer, PNG_BYTES.subarray(0, 4));

  // ?download=1 → attachment
  const downloaded = await request('GET', `/api/admin/media/${mediaId}?download=1`, { headers: { cookie } });
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition') || '', /^attachment;/);

  // 未登录 / 不存在
  assert.equal((await request('GET', `/api/admin/media/${mediaId}`)).status, 401);
  assert.equal((await request('GET', '/api/admin/media/att_missing', { headers: { cookie } })).status, 404);
});

test('管理端上传：超过 MEDIA_MAX_BYTES 返回 413', async () => {
  const tooBig = Buffer.alloc(4096, 0x41);
  const result = await request('POST', '/api/admin/media', {
    raw: tooBig,
    headers: uploadHeaders({ fileName: 'big.bin', mime: 'application/octet-stream' }),
  });
  assert.equal(result.status, 413);
  assert.equal(result.json.error.code, 'BAD_REQUEST');
  assert.match(result.json.error.message, /大小上限/);
});

test('发送 {text, mediaId}：queued 项带 media 摘要 + outbox.media_id', async () => {
  const user = createUser();
  const upload = await request('POST', '/api/admin/media', {
    raw: PNG_BYTES,
    headers: uploadHeaders({ fileName: 'send.png' }),
  });
  const mediaId = upload.json.media.id;

  const sent = await request('POST', `/api/admin/users/${encodeURIComponent(user.id)}/messages`, {
    body: { text: '看图', mediaId },
    headers: { 'content-type': 'application/json', cookie, ...CSRF_HEADERS },
  });
  assert.equal(sent.status, 202, sent.buffer.toString('utf8'));
  const queued = sent.json.queued[0];
  assert.equal(queued.userId, user.id);
  assert.equal(queued.media.id, mediaId);
  assert.equal(queued.media.kind, 'image');
  assert.equal(queued.media.url, `/api/admin/media/${mediaId}`);
  const rawOutbox = store.getOutbox(queued.outboxId);
  assert.equal(rawOutbox.mediaId, mediaId);
  assert.equal(rawOutbox.text, '看图');

  // 只有 mediaId、无 text 也允许
  const mediaOnly = await request('POST', `/api/admin/users/${encodeURIComponent(user.id)}/messages`, {
    body: { mediaId },
    headers: { 'content-type': 'application/json', cookie, ...CSRF_HEADERS },
  });
  assert.equal(mediaOnly.status, 202, mediaOnly.buffer.toString('utf8'));
  assert.equal(mediaOnly.json.queued[0].media.id, mediaId);

  // 参数校验
  const neither = await request('POST', `/api/admin/users/${encodeURIComponent(user.id)}/messages`, {
    body: {},
    headers: { 'content-type': 'application/json', cookie, ...CSRF_HEADERS },
  });
  assert.equal(neither.status, 400);
  assert.match(neither.json.error.message, /至少提供一个/);
  const missingMedia = await request('POST', `/api/admin/users/${encodeURIComponent(user.id)}/messages`, {
    body: { text: 'x', mediaId: 'att_missing' },
    headers: { 'content-type': 'application/json', cookie, ...CSRF_HEADERS },
  });
  assert.equal(missingMedia.status, 404);
  const tooLongCaption = await request('POST', `/api/admin/users/${encodeURIComponent(user.id)}/messages`, {
    body: { text: 'x'.repeat(4001), mediaId },
    headers: { 'content-type': 'application/json', cookie, ...CSRF_HEADERS },
  });
  assert.equal(tooLongCaption.status, 400);
});

test('管理端消息记录 / 用户详情附带 attachments 视图', async () => {
  const user = createUser();
  const upload = await request('POST', '/api/admin/media', {
    raw: PNG_BYTES,
    headers: uploadHeaders({ fileName: 'view.png' }),
  });
  const mediaId = upload.json.media.id;
  const sent = await request('POST', `/api/admin/users/${encodeURIComponent(user.id)}/messages`, {
    body: { text: '视图', mediaId },
    headers: { 'content-type': 'application/json', cookie, ...CSRF_HEADERS },
  });
  const outboxId = sent.json.queued[0].outboxId;

  const messages = await request('GET', `/api/admin/messages?direction=outbound&userId=${encodeURIComponent(user.id)}`, {
    headers: { cookie },
  });
  assert.equal(messages.status, 200);
  const outboundItem = messages.json.items.find((item) => item.id === outboxId);
  assert.ok(outboundItem, '应能查询到出站消息');
  assert.equal(outboundItem.attachments.length, 1);
  assert.equal(outboundItem.attachments[0].id, mediaId);
  assert.equal(outboundItem.attachments[0].url, `/api/admin/media/${mediaId}`);
  assert.equal(outboundItem.attachments[0].kind, 'image');

  const detail = await request('GET', `/api/admin/users/${encodeURIComponent(user.id)}`, { headers: { cookie } });
  assert.equal(detail.json.recentOutbound[0].attachments.length, 1);
  assert.equal(detail.json.recentOutbound[0].attachments[0].id, mediaId);
});

test('对外 API：v1 上传 / 发送 {mediaId} / 读取', async () => {
  const apiKeyHeaders = { 'x-api-key': 'media-api-token-123456' };
  const user = createUser();

  // 未鉴权上传 → 401
  assert.equal(
    (await request('POST', '/api/v1/media', { raw: PNG_BYTES, headers: uploadHeaders({ authCookie: null, csrf: false }) })).status,
    401,
  );

  const upload = await request('POST', '/api/v1/media', {
    raw: PNG_BYTES,
    headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('v1.png'), ...apiKeyHeaders },
  });
  assert.equal(upload.status, 201, upload.buffer.toString('utf8'));
  const mediaId = upload.json.media.id;
  assert.equal(upload.json.media.url, `/api/v1/media/${mediaId}`);

  // v1 读取（API Key）
  const read = await request('GET', `/api/v1/media/${mediaId}`, { headers: apiKeyHeaders });
  assert.equal(read.status, 200);
  assert.deepEqual(read.buffer, PNG_BYTES);
  assert.equal((await request('GET', `/api/v1/media/${mediaId}`)).status, 401);

  // v1 发送带 mediaId
  const sent = await request('POST', '/api/v1/messages', {
    body: { to: [user.id], text: 'v1 看图', mediaId },
    headers: { 'content-type': 'application/json', ...apiKeyHeaders },
  });
  assert.equal(sent.status, 202, sent.buffer.toString('utf8'));
  assert.equal(sent.json.accepted, 1);
  const queued = sent.json.queued[0];
  assert.equal(queued.userId, user.id);
  assert.equal(queued.media.id, mediaId);
  assert.equal(queued.media.url, `/api/v1/media/${mediaId}`);

  // 参数校验：text 与 mediaId 至少一个
  const neither = await request('POST', '/api/v1/messages', {
    body: { to: [user.id] },
    headers: { 'content-type': 'application/json', ...apiKeyHeaders },
  });
  assert.equal(neither.status, 400);
});

test('/api/admin/config 返回媒体限制', async () => {
  const config = await request('GET', '/api/admin/config', { headers: { cookie } });
  assert.equal(config.status, 200);
  assert.equal(config.json.media.maxBytes, 2048);
  assert.equal(config.json.media.inboundMaxBytes, 104857600);
  assert.ok(Array.isArray(config.json.media.allowedImage));
  assert.ok(Array.isArray(config.json.media.allowedVideo));
  assert.equal(typeof config.json.media.dir, 'string');
});
