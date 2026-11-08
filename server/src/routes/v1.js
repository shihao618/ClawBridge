/**
 * 对外推送 API（API Key 鉴权）：发消息/广播/媒体/消息状态/用户/分组/入站长轮询。
 */
import * as auth from '../auth.js';
import { AppError, ErrorCodes, badRequest, conflict, notFound } from '../errors.js';
import {
  MEDIA_V1_PREFIX,
  parseLimit,
  parseOffset,
  parseOptionalText,
  parseText,
  requireJsonBody,
  sleepMs,
} from '../http/helpers.js';
import { handleMediaUpload, resolveOutboundAttachment, sendMediaFile } from '../http/media-handlers.js';
import { queueGroupMessage } from '../http/queue-service.js';
import { queuedItem, v1GroupView } from '../http/views.js';
import { INBOUND_WAIT_POLL_MS, USER_STATUSES, parseInboundQuery } from '../http/validators.js';
import * as store from '../store.js';

/**
 * 入站长轮询等待：无新消息时按 pollMs 轮询，直到出现数据 / 超时 / 客户端断开。
 * 抽出为可注入依赖的异步函数便于单测（BA-22：连接断开后应立即停止查询）。
 * @param {{queryOnce:Function, waitSeconds:number, startedAt?:number, sleepFn?:Function,
 *          now?:Function, pollMs?:number, isClosed?:Function}} options
 * @returns {Promise<object>} 最后一次 queryOnce 的结果
 */
export async function waitForInboundResult({
  queryOnce,
  waitSeconds,
  startedAt = Date.now(),
  sleepFn = sleepMs,
  now = Date.now,
  pollMs = INBOUND_WAIT_POLL_MS,
  isClosed = () => false,
} = {}) {
  const deadline = Number(startedAt) + Number(waitSeconds) * 1000;
  let result = queryOnce();
  while (result.items.length === 0 && Number(waitSeconds) > 0 && now() < deadline) {
    if (isClosed()) return result;
    await sleepFn(Math.min(pollMs, Math.max(1, deadline - now())));
    if (isClosed()) return result;
    result = queryOnce();
  }
  return result;
}

/**
 * @param {import('express').Express} app
 * @param {{ parseRawMediaBody: import('express').RequestHandler }} deps
 */
export function registerV1Routes(app, { parseRawMediaBody }) {
  app.post('/api/v1/messages', auth.requireApiKey, (req, res) => {
    const body = requireJsonBody(req);
    const text = parseOptionalText(body.text);
    const attachment = resolveOutboundAttachment(body.mediaId);
    if (text === '' && !attachment) throw badRequest('text 与 mediaId 至少提供一个');
    if (!Array.isArray(body.to) || body.to.length === 0) throw badRequest('to 必须是非空的用户 id 数组');
    if (body.to.length > 100) throw badRequest('to 最多包含 100 个用户 id');
    const ids = [];
    for (const item of body.to) {
      if (typeof item !== 'string' || item.trim() === '') throw badRequest('to 中的用户 id 必须是非空字符串');
      ids.push(item.trim());
    }
    const uniqueIds = [...new Set(ids)];
    const rows = store.getUsersByIds(uniqueIds);
    const rowMap = new Map(rows.map((row) => [row.id, row]));

    const now = Date.now();
    const unknownUserIds = [];
    const pausedUserIds = [];
    const validUserIds = [];
    for (const id of uniqueIds) {
      const row = rowMap.get(id);
      if (!row || row.status !== 'active') {
        unknownUserIds.push(id);
      } else if (Number(row.pause_until) > now) {
        // BA-20：与后台发送语义对齐——-14 冷却中的账号不能接收新消息（dispatcher 会直接置 failed）。
        pausedUserIds.push(id);
      } else {
        validUserIds.push(id);
      }
    }
    if (validUserIds.length === 0) {
      if (pausedUserIds.length > 0 && unknownUserIds.length === 0) {
        throw conflict('账号冷却中（bot token 已失效，需用户重新扫码绑定），暂时无法发送消息');
      }
      throw new AppError(ErrorCodes.NOT_FOUND, '所有用户均不存在或未绑定', {
        status: 404,
        details: { unknownUserIds, ...(pausedUserIds.length > 0 ? { pausedUserIds } : {}) },
      });
    }
    const queued = store.enqueueMany(
      validUserIds.map((userId) => ({ userId, text, source: 'api', mediaId: attachment?.id ?? null })),
    );
    const payload = {
      accepted: queued.length,
      queued: queued.map((row) => queuedItem(row, { attachment, urlPrefix: MEDIA_V1_PREFIX })),
    };
    if (unknownUserIds.length > 0) payload.unknownUserIds = unknownUserIds;
    if (pausedUserIds.length > 0) payload.pausedUserIds = pausedUserIds;
    res.status(202).json(payload);
  });

  // 对外 API：媒体上传（原始二进制 + X-File-Name）与读取（供外部系统拉取）
  app.post('/api/v1/media', auth.requireApiKey, parseRawMediaBody, async (req, res) => {
    await handleMediaUpload(req, res, { urlPrefix: MEDIA_V1_PREFIX });
  });

  app.get('/api/v1/media/:id', auth.requireApiKey, async (req, res) => {
    await sendMediaFile(req, res);
  });

  app.post('/api/v1/broadcast', auth.requireApiKey, (req, res) => {
    const body = requireJsonBody(req);
    const text = parseText(body.text);
    // 兼容字段 onlyBound 的**实际**语义是“是否包含 -14 冷却中的账号”（unbound 始终排除），
    // 不是“是否只包含已绑定账号”；保留字段名以兼容既有调用方，默认 true=只发未冷却账号。
    const includePaused = body.onlyBound === false;
    const targets = store.getBroadcastTargets({ includePaused });
    const queued = store.enqueueMany(targets.map((user) => ({ userId: user.id, text, source: 'broadcast' })));
    res.status(202).json({ accepted: queued.length, queued: queued.map(queuedItem) });
  });

  app.get('/api/v1/messages/:outboxId', auth.requireApiKey, (req, res) => {
    const row = store.getOutbox(req.params.outboxId, { urlPrefix: MEDIA_V1_PREFIX });
    if (!row) throw notFound('消息不存在');
    res.json({
      id: row.id,
      userId: row.userId,
      status: row.status,
      attempts: row.attempts,
      error: row.error,
      serverMessageId: row.serverMessageId,
      createdAt: row.createdAt,
      sentAt: row.sentAt,
      source: row.source,
      attachments: row.attachments,
    });
  });

  app.get('/api/v1/users', auth.requireApiKey, (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : 'active';
    if (!USER_STATUSES.has(status)) throw badRequest('status 只能是 active | unbound | paused | all');
    const result = store.listUsers({ status, limit: parseLimit(req.query.limit, 100, 500), offset: parseOffset(req.query.offset) });
    res.json({
      items: result.items.map((user) => ({
        id: user.id,
        displayName: user.displayName,
        status: user.status,
        boundAt: user.boundAt,
        hasContextToken: user.hasContextToken,
        groups: user.groups ?? [],
        keepaliveEnabled: Boolean(user.keepaliveEnabled),
      })),
    });
  });

  // -------------------------------------------------------------------------
  // 对外 API：用户分组 + 入站消息（docs/GROUPS_AND_INBOUND.md §4）
  // -------------------------------------------------------------------------

  app.get('/api/v1/groups', auth.requireApiKey, (req, res) => {
    res.json({ items: store.listGroups().map(v1GroupView) });
  });

  app.post('/api/v1/groups/:groupId/messages', auth.requireApiKey, (req, res) => {
    const body = requireJsonBody(req);
    const result = queueGroupMessage(req.params.groupId, body, MEDIA_V1_PREFIX);
    res.status(202).json({ accepted: result.count, queued: result.queued });
  });

  /**
   * 拉取入站消息（ASC by received_at,id；cursor 优先于 since；wait 长轮询）。
   * 响应：{items, nextCursor, hasMore, serverTime}
   */
  app.get('/api/v1/inbound/messages', auth.requireApiKey, async (req, res) => {
    const params = parseInboundQuery(req.query);
    const queryOnce = () =>
      store.listInboundForApi({
        limit: params.limit,
        since: params.since,
        cursor: params.cursor,
        userId: params.userId,
        groupId: params.groupId,
        urlPrefix: MEDIA_V1_PREFIX,
      });

    // BA-22：客户端断开（fetch abort/关页）后立即停止每 500ms 的查询；res 'close' 在响应正常结束时也会触发，
    // 因此用 writableEnded 区分“提前断开”和“已写完响应”。
    let clientClosed = false;
    const onClose = () => {
      if (!res.writableEnded) clientClosed = true;
    };
    res.on('close', onClose);
    try {
      const result = await waitForInboundResult({
        queryOnce,
        waitSeconds: params.wait,
        isClosed: () => clientClosed,
      });
      if (clientClosed || res.writableEnded) return; // 连接已断开：不再查询/不再写响应
      res.json({
        items: result.items,
        // 无数据时按契约返回传入游标原样（可能为 null）
        nextCursor: result.items.length > 0 ? result.nextCursor : (req.query.cursor ? String(req.query.cursor) : null),
        hasMore: result.hasMore,
        serverTime: Date.now(),
      });
    } finally {
      res.off('close', onClose);
    }
  });
}
