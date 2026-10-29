/**
 * 单元测试：store.js 多媒体扩展（attachments CRUD / outbox.media_id / 视图 attachments）。
 * 临时 DATA_DIR + 真实 SQLite/media 目录，无真实网络。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-media-store-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'media-store-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'media-store-password';
process.env.API_TOKEN = 'media-store-token';
process.env.LOG_LEVEL = 'silent';

const store = await import('../../server/src/store.js');
const media = await import('../../server/src/media.js');
const { closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
function createUser(overrides = {}) {
  seq += 1;
  return store.upsertBoundUser({
    wechatUserId: overrides.wechatUserId ?? `wx_media_${seq}`,
    displayName: overrides.displayName ?? `媒体用户${seq}`,
    ilinkBotId: overrides.ilinkBotId ?? `bot_media_${seq}@im.bot`,
    botToken: overrides.botToken ?? `media-token-${seq}`,
    baseUrl: overrides.baseUrl ?? 'https://ilink.example.test',
  }).user;
}

/** 创建 outbound 附件（真实落盘）。 */
async function createOutboundAttachment({ kind = 'image', mime = 'image/png', fileName = 'a.png', content = Buffer.from('PNGDATA') } = {}) {
  const saved = await media.saveMediaBuffer({ direction: 'outbound', buffer: content, mime });
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
    createdAt: Date.now(),
  });
}

test('attachments: create/get/link/getByOutbox 与视图字段', async () => {
  const user = createUser();
  const attachment = await createOutboundAttachment();
  assert.match(attachment.id, /^att_/);
  assert.equal(attachment.direction, 'outbound');
  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.status, 'ready');
  assert.ok(attachment.path.startsWith('outbound/'));

  // 文件确实落盘且内容一致
  const fileBuffer = await media.readMediaFile(attachment.path);
  assert.deepEqual(fileBuffer, Buffer.from('PNGDATA'));

  const fetched = store.getAttachment(attachment.id);
  assert.equal(fetched.id, attachment.id);
  assert.equal(fetched.file_name, 'a.png');
  assert.equal(store.getAttachment('att_missing'), undefined);

  // 入队并回填 outbox_id
  const queued = store.enqueueMessage({ userId: user.id, text: '看图', mediaId: attachment.id });
  assert.equal(queued.mediaId, attachment.id);
  assert.equal(store.getAttachmentByOutbox(queued.id).id, attachment.id);
  const queuedRaw = store.getUserRow(user.id); // 仅确保用户存在
  assert.ok(queuedRaw);

  // 出站视图附带 attachments（默认 admin URL 前缀）
  const outboxView = store.getOutbox(queued.id);
  assert.equal(outboxView.attachments.length, 1);
  assert.deepEqual(
    {
      id: outboxView.attachments[0].id,
      kind: outboxView.attachments[0].kind,
      mime: outboxView.attachments[0].mime,
      fileName: outboxView.attachments[0].fileName,
      size: outboxView.attachments[0].size,
      status: outboxView.attachments[0].status,
    },
    { id: attachment.id, kind: 'image', mime: 'image/png', fileName: 'a.png', size: 7, status: 'ready' },
  );
  assert.equal(outboxView.attachments[0].url, `/api/admin/media/${attachment.id}`);
  assert.equal(outboxView.attachments[0].downloadUrl, `/api/admin/media/${attachment.id}?download=1`);

  // 自定义 URL 前缀（v1 API 视图）
  const v1View = store.getOutbox(queued.id, { urlPrefix: '/api/v1/media' });
  assert.equal(v1View.attachments[0].url, `/api/v1/media/${attachment.id}`);
});

test('attachments: failed 行允许无文件（入站下载失败场景）', () => {
  const failed = store.createAttachment({
    direction: 'inbound',
    kind: 'image',
    mime: 'image/jpeg',
    fileName: '',
    size: 0,
    path: '',
    userId: 'u_x',
    inboundMessageId: 'in_x',
    wechatMessageId: '9007199254740999',
    error: '下载超时',
    status: 'failed',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.path, '');
  assert.equal(failed.error, '下载超时');
  const view = store.mapAttachmentRow(failed);
  assert.equal(view.status, 'failed');
  assert.equal(view.error, '下载超时');
});

test('attachments: 批量查询（ByInbound / ByOutboxIds / ByIds）', async () => {
  const user = createUser();
  // 入站消息 + 2 个附件
  const inbound = store.saveInbound({
    userId: user.id,
    wechatMessageId: '9007199254741001',
    fromUserId: 'wx_media',
    text: '[图片]',
    itemTypes: '2,2',
    rawJson: '{}',
  });
  const img1 = await media.saveMediaBuffer({ direction: 'inbound', buffer: Buffer.from('IMG1'), mime: 'image/png' });
  const img2 = await media.saveMediaBuffer({ direction: 'inbound', buffer: Buffer.from('IMG2'), mime: 'image/jpeg' });
  for (const [saved, kind, mime] of [
    [img1, 'image', 'image/png'],
    [img2, 'image', 'image/jpeg'],
  ]) {
    store.createAttachment({
      id: saved.id,
      direction: 'inbound',
      kind,
      mime,
      fileName: '',
      size: saved.size,
      path: saved.path,
      sha256: saved.sha256,
      userId: user.id,
      inboundMessageId: inbound.id,
      wechatMessageId: '9007199254741001',
    });
  }
  const byInbound = store.getAttachmentsByInbound([inbound.id, 'in_missing']);
  assert.equal(byInbound.get(inbound.id).length, 2);
  assert.deepEqual(byInbound.get('in_missing'), []);

  const outbound = await createOutboundAttachment({ fileName: 'b.jpg', mime: 'image/jpeg' });
  const q1 = store.enqueueMessage({ userId: user.id, text: '', mediaId: outbound.id });
  const byIds = store.getAttachmentsByIds([outbound.id, 'att_missing']);
  assert.equal(byIds.get(outbound.id).id, outbound.id);
  assert.equal(byIds.has('att_missing'), false);
  const byOutbox = store.getAttachmentsByOutboxIds([q1.id]);
  assert.equal(byOutbox.get(q1.id).length, 1);

  // listMessages 入站/出站记录均带 attachments
  const messages = store.listMessages({ direction: 'all', limit: 20 });
  const inboundItem = messages.items.find((item) => item.id === inbound.id);
  assert.equal(inboundItem.attachments.length, 2);
  assert.ok(inboundItem.attachments.every((att) => att.url.startsWith('/api/admin/media/')));
  const outboundItem = messages.items.find((item) => item.id === q1.id);
  assert.equal(outboundItem.attachments.length, 1);
  assert.equal(outboundItem.attachments[0].id, outbound.id);

  // getRecentInbound / getRecentOutbound 附带 attachments
  const recentInbound = store.getRecentInbound(user.id, 10);
  assert.equal(recentInbound[0].attachments.length, 2);
  const recentOutbound = store.getRecentOutbound(user.id, 10);
  assert.equal(recentOutbound[0].attachments.length, 1);
});

test('outbox: mediaId 入队、caption_sent_at、deferOutbox 语义', async () => {
  const user = createUser();
  const attachment = await createOutboundAttachment();
  const queued = store.enqueueMessage({ userId: user.id, text: 'caption 文本', source: 'admin', mediaId: attachment.id });
  assert.equal(queued.mediaId, attachment.id);
  assert.equal(queued.captionSentAt, 0);

  // 抢占 sending → 发 caption 后记录 caption_sent_at
  assert.equal(store.markOutboxSending(queued.id), true);
  assert.equal(store.markCaptionSent(queued.id, 5000), true);
  const withCaption = store.getOutbox(queued.id);
  assert.equal(withCaption.captionSentAt, 5000);

  // deferOutbox：sending → queued 推迟，不增加 attempts（此刻仍为 sending 状态）
  assert.equal(store.deferOutbox(queued.id, 9000, 6000), true);
  const deferred = store.getOutbox(queued.id);
  assert.equal(deferred.status, 'queued');
  assert.equal(deferred.nextAttemptAt, 9000);
  assert.equal(deferred.attempts, 0, '限流推迟不应增加 attempts');
  assert.equal(deferred.captionSentAt, 5000, 'caption 记录应保留');

  // 非 sending 状态不允许 deferOutbox
  assert.equal(store.deferOutbox(queued.id, 10000, 7000), false);

  // 纯文本入队仍兼容（media_id 为 NULL）
  const textOnly = store.enqueueMessage({ userId: user.id, text: '纯文本' });
  assert.equal(textOnly.mediaId, null);
  assert.equal(store.getOutbox(textOnly.id).attachments.length, 0);
  // enqueueMessage 参数校验
  assert.throws(() => store.enqueueMessage({ userId: user.id }), /text 与 mediaId/);
  assert.throws(() => store.enqueueMessage({ userId: user.id, text: 123 }), /text 必须是字符串/);
});
