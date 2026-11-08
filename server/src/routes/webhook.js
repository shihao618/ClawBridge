/**
 * 对外 Webhook 兼容入口（文本/表单 body；目标是 query 或 body 中的用户/分组/广播）。
 */
import express from 'express';

import * as auth from '../auth.js';
import { AppError, ErrorCodes, badRequest } from '../errors.js';
import { logger } from '../logger.js';
import { MEDIA_V1_PREFIX, parseText } from '../http/helpers.js';
import { extractWebhookTarget, extractWebhookText, queueGroupMessage } from '../http/queue-service.js';
import { queuedItem } from '../http/views.js';
import * as store from '../store.js';

const log = logger.child({ mod: 'api' });

export function registerWebhookRoutes(app) {
  // Webhook 兼容：允许文本/表单 body；目标可放在 query（?to= / ?groupId= / ?broadcast=1）。
  const webhookBodyParser = express.text({
    type: ['text/*', 'application/x-www-form-urlencoded'],
    limit: '64kb',
  });
  app.post('/api/v1/webhook', webhookBodyParser, auth.requireWebhookApiKey, (req, res) => {
    const contentType = String(req.get('content-type') || '').toLowerCase();
    const body = (() => {
      if (typeof req.body === 'string' && contentType.includes('application/x-www-form-urlencoded')) {
        return Object.fromEntries(new URLSearchParams(req.body));
      }
      return req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    })();
    const rawText = extractWebhookText(req, body);
    if (!rawText) throw badRequest('无法从 Webhook 请求中提取消息文本（支持 text/content/message/msg 或纯文本 body）');
    const text = parseText(rawText);
    const target = extractWebhookTarget(req, body);
    let payload;
    if (target.broadcast) {
      const rawOnlyBound = req.query?.onlyBound ?? body.onlyBound;
      const onlyBound = !(
        rawOnlyBound === false ||
        ['0', 'false', 'no', 'off'].includes(String(rawOnlyBound ?? '').toLowerCase())
      );
      const targets = store.getBroadcastTargets({ includePaused: !onlyBound });
      const queued = store.enqueueMany(
        targets.map((user) => ({ userId: user.id, text, source: 'webhook' })),
      );
      payload = { accepted: queued.length, queued: queued.map((row) => queuedItem(row)), target: 'broadcast' };
    } else if (target.groupId) {
      const result = queueGroupMessage(target.groupId, { text }, MEDIA_V1_PREFIX, { source: 'webhook' });
      payload = { accepted: result.count, queued: result.queued, target: 'group' };
    } else {
      if (target.userIds.length > 100) throw badRequest('to 最多包含 100 个用户 id');
      const rows = store.getUsersByIds(target.userIds);
      const rowMap = new Map(rows.map((row) => [row.id, row]));
      const validUserIds = [];
      const unknownUserIds = [];
      for (const id of target.userIds) {
        const row = rowMap.get(id);
        if (!row || row.status !== 'active') unknownUserIds.push(id);
        else validUserIds.push(id);
      }
      if (validUserIds.length === 0) {
        throw new AppError(ErrorCodes.NOT_FOUND, '所有用户均不存在或未绑定', {
          status: 404,
          details: { unknownUserIds },
        });
      }
      const queued = store.enqueueMany(
        validUserIds.map((userId) => ({ userId, text, source: 'webhook' })),
      );
      payload = { accepted: queued.length, queued: queued.map((row) => queuedItem(row)), target: 'users' };
      if (unknownUserIds.length > 0) payload.unknownUserIds = unknownUserIds;
    }
    log.info('Webhook 消息已入队', {
      target: payload.target,
      accepted: payload.accepted,
      fromIp: req.ip,
    });
    res.status(202).json(payload);
  });
}
