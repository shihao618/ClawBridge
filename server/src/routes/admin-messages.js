/**
 * 管理后台：广播、消息列表、媒体上传/读取（原始二进制 + X-File-Name，支持 Range）。
 */
import * as auth from '../auth.js';
import { badRequest } from '../errors.js';
import { logger } from '../logger.js';
import { MEDIA_ADMIN_PREFIX, parseLimit, parseOffset, parseText, requireJsonBody } from '../http/helpers.js';
import { handleMediaUpload, sendMediaFile } from '../http/media-handlers.js';
import { queuedItem } from '../http/views.js';
import { MESSAGE_DIRECTIONS, MESSAGE_STATUSES } from '../http/validators.js';
import * as store from '../store.js';

const log = logger.child({ mod: 'api' });

/**
 * @param {import('express').Express} app
 * @param {{ parseRawMediaBody: import('express').RequestHandler }} deps
 */
export function registerAdminMessagesRoutes(app, { parseRawMediaBody }) {
  app.post('/api/admin/broadcast', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    const text = parseText(body.text);
    const targets = store.getBroadcastTargets({ includePaused: false });
    const queued = store.enqueueMany(targets.map((user) => ({ userId: user.id, text, source: 'broadcast' })));
    log.info('管理后台广播已入队', { count: queued.length });
    res.status(202).json({ queued: queued.map(queuedItem), count: queued.length });
  });

  app.get('/api/admin/messages', auth.requireAdmin, (req, res) => {
    const direction = typeof req.query.direction === 'string' && req.query.direction !== '' ? req.query.direction : 'all';
    if (!MESSAGE_DIRECTIONS.has(direction)) throw badRequest('direction 只能是 inbound | outbound | all');
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    if (status !== '' && !MESSAGE_STATUSES.has(status)) {
      throw badRequest('status 只能是 queued | sending | sent | failed | received');
    }
    const result = store.listMessages({
      direction,
      status,
      userId: typeof req.query.userId === 'string' ? req.query.userId : '',
      groupId: typeof req.query.groupId === 'string' ? req.query.groupId.trim() : '',
      limit: parseLimit(req.query.limit, 50, 500),
      offset: parseOffset(req.query.offset),
    });
    res.json(result);
  });

  // 管理后台：媒体上传（原始二进制 + X-File-Name）与读取（预览/下载，支持 Range）
  app.post('/api/admin/media', auth.requireAdminWrite, parseRawMediaBody, async (req, res) => {
    await handleMediaUpload(req, res, { urlPrefix: MEDIA_ADMIN_PREFIX });
  });

  app.get('/api/admin/media/:id', auth.requireAdmin, async (req, res) => {
    await sendMediaFile(req, res);
  });
}
