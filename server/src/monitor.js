/**
 * 入站监控（monitor.js）—— 每个已绑定账号一个长轮询循环。
 *
 * 流程（docs/ARCHITECTURE.md §6 / docs/PROTOCOL.md §5.4）：
 *   notifyStart → getUpdates 长轮询 → 保存 get_updates_buf / 入站消息 / context_token；
 *   -14（token 失效）→ pause_until=now+1h + events('stale_token') + 停止该账号循环；
 *   其他错误按协议退避（连续 3 次 → 30s，否则 2s）；
 *   客户端超时/主动中止属于正常控制流（ilink.getUpdates 已转为空响应）。
 *
 * start/stop 幂等，key = userId；stop 时 best-effort notifyStop。
 */
import { config } from './config.js';
import { isStaleTokenError } from './errors.js';
import * as appRules from './app-rules.js';
import * as ilink from './ilink.js';
import { logger } from './logger.js';
import * as media from './media.js';
import * as store from './store.js';

const log = logger.child({ mod: 'monitor' });

/** @type {Map<string, {controller: AbortController, promise: Promise<void>, startedAt: number}>} */
const workers = new Map();

function toUserId(userOrId) {
  if (!userOrId) return '';
  if (typeof userOrId === 'string') return userOrId;
  return String(userOrId.id ?? '');
}

/** 可被 AbortSignal 打断的 sleep。 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    };
    timer = setTimeout(done, Math.max(0, ms));
    timer.unref?.();
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/**
 * 判断是否为 bot_token 失效（-14）。
 * 兼容两种上游表达：① HTTP 200 + body.ret=-14；② HTTP 401 + body 中 ret/errcode=-14
 * （部分网关/模拟实现用 401 表示凭证失效）。
 */
function isStaleTokenLike(err) {
  if (isStaleTokenError(err)) return true;
  if (!err || err.name !== 'ILinkError') return false;
  if (err.httpStatus === 401) return true;
  return typeof err.body === 'string' && /"?(?:ret|errcode)"?\s*:\s*-14/.test(err.body);
}

/** 提取消息的可读文本（无文本时按消息类型给占位）。 */
export function extractMessageText(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  let placeholder = '';
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 1 && typeof item.text_item?.text === 'string') return item.text_item.text;
    if (item.type === 3 && typeof item.voice_item?.text === 'string' && item.voice_item.text.trim() !== '') {
      return item.voice_item.text;
    }
    if (placeholder === '') {
      if (item.type === 2) placeholder = '[图片]';
      else if (item.type === 3) placeholder = '[语音]';
      else if (item.type === 4) placeholder = item.file_item?.file_name ? `[文件] ${item.file_item.file_name}` : '[文件]';
      else if (item.type === 5) placeholder = '[视频]';
      else if (item.type === 11 || item.type === 12) placeholder = '[工具调用]';
      else if (item.type) placeholder = '[消息]';
    }
  }
  return placeholder;
}

/** 是否在运行。 */
export function isRunning(userOrId) {
  return workers.has(toUserId(userOrId));
}

/** 当前运行的监控数量。 */
export function runningCount() {
  return workers.size;
}

/** 正在运行的账号 id 列表。 */
export function listRunning() {
  return [...workers.keys()];
}

/**
 * 启动某账号的入站监控（幂等：已在运行返回 false）。
 * 同步返回，循环在后台异步执行（notifyStart 不阻塞调用方）。
 */
export function start(userOrId) {
  const userId = toUserId(userOrId);
  if (!userId) return false;
  if (workers.has(userId)) return false;
  if (workers.size >= config.monitor.maxAccounts) {
    log.warn('入站监控数量已达上限，跳过启动', { userId, maxAccounts: config.monitor.maxAccounts });
    return false;
  }
  const row = store.getUserRow(userId);
  if (!row) return false;
  if (row.status !== 'active') {
    log.info('用户非 active 状态，不启动入站监控', { userId, status: row.status });
    return false;
  }
  if (Number(row.pause_until) > Date.now()) {
    log.info('账号冷却中，暂不启动入站监控', { userId, pauseUntil: row.pause_until });
    return false;
  }
  const secrets = store.getUserSecrets(userId);
  if (!secrets?.token) {
    log.warn('缺少 bot_token，无法启动入站监控', { userId });
    return false;
  }

  const controller = new AbortController();
  const worker = { controller, startedAt: Date.now(), promise: Promise.resolve() };
  workers.set(userId, worker);
  worker.promise = runLoop(row, secrets.token, controller, worker)
    .catch((err) => log.error('入站监控循环异常退出', { userId, message: err?.message, stack: err?.stack }))
    .finally(() => {
      if (workers.get(userId) === worker) workers.delete(userId);
      log.info('入站监控已退出', { userId });
    });
  log.info('入站监控已启动', { userId, running: workers.size });
  return true;
}

/** -14 处理：暂停 1 小时 + 事件 + 停止循环。 */
function pauseForStaleToken(userId, detail, isCurrentCredential = () => true) {
  // 凭据代际保护：旧 worker（换绑前启动）不得把已换绑的用户置为冷却
  if (!isCurrentCredential()) {
    log.info('凭据已变更，忽略旧 worker 的 -14（不写 paused）', { userId });
    return;
  }
  const pauseUntil = Date.now() + config.monitor.stalePauseMs;
  const message = 'bot token 已失效（-14），需要用户重新扫码绑定';
  store.setUserPaused(userId, pauseUntil, message);
  store.addEvent({ type: 'stale_token', userId, detail: String(detail ?? '').slice(0, 500) });
  log.warn('bot token 失效，账号进入 1 小时冷却', { userId, pauseUntil });
}

/** 深度脱敏副本：敏感字段（context_token / aes_key / aeskey）不得进入 raw_json 明文。 */
export function redactInboundMessage(value) {
  if (Array.isArray(value)) return value.map(redactInboundMessage);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = /context_token|aes_?key/i.test(key) ? '[redacted]' : redactInboundMessage(val);
    }
    return out;
  }
  return value;
}

/** 构造可安全落库的 raw_json（脱敏后序列化；序列化失败返回空串）。 */
export function sanitizeInboundRawJson(message) {
  try {
    return JSON.stringify(redactInboundMessage(message));
  } catch {
    return '';
  }
}

/**
 * 下载并保存入站媒体（不抛错：失败只记录 status='failed' 的 attachments 行）。
 * @param {{userId:string, inboundMessageId:string, wechatMessageId:string, items:Array<object>}} params
 */
async function downloadInboundMediaItems({ userId, inboundMessageId, wechatMessageId, items }) {
  for (const item of items) {
    try {
      const { buffer } = await media.downloadAndDecryptInbound({
        media: item.media,
        aesKeyOverride: item.aesKeyOverride,
        timeoutMs: config.media.downloadTimeoutMs,
        maxBytes: config.media.inboundMaxBytes,
      });
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('媒体内容为空');
      // MIME 修正：图片/视频用魔数嗅探；文件用文件名推断；语音固定 audio/silk
      let mime = media.normalizeMime(item.mime);
      if (item.kind === media.MediaKind.IMAGE) {
        mime = media.sniffMime(buffer, mime.startsWith('image/') ? mime : 'image/jpeg');
      } else if (mime === 'application/octet-stream') {
        mime = media.sniffMime(buffer, mime);
      }
      const saved = await media.saveMediaBuffer({ direction: 'inbound', buffer, mime });
      store.createAttachment({
        id: saved.id,
        direction: 'inbound',
        kind: item.kind,
        mime: saved.mime ?? mime,
        fileName: item.fileName || '',
        size: saved.size,
        path: saved.path,
        sha256: saved.sha256,
        userId,
        inboundMessageId,
        wechatMessageId,
        status: 'ready',
        createdAt: Date.now(),
      });
      log.info('入站媒体已保存', {
        userId,
        attachmentId: saved.id,
        kind: item.kind,
        size: saved.size,
        mime: saved.mime ?? mime,
      });
    } catch (err) {
      log.warn('入站媒体下载/解密失败（记录 failed，不影响消息）', {
        userId,
        kind: item.kind,
        message: err?.message,
      });
      try {
        store.createAttachment({
          direction: 'inbound',
          kind: item.kind || media.MediaKind.FILE,
          mime: item.mime || 'application/octet-stream',
          fileName: item.fileName || '',
          size: 0,
          path: '',
          sha256: '',
          userId,
          inboundMessageId,
          wechatMessageId,
          error: String(err?.message ?? err).slice(0, 500),
          status: 'failed',
          createdAt: Date.now(),
        });
      } catch (recordErr) {
        log.warn('记录失败附件行失败（忽略）', { userId, message: recordErr?.message });
      }
    }
  }
}

/**
 * 处理一批入站消息：去重落库、保存 context_token、落库媒体附件、更新时间戳。
 * raw_json 必须先脱敏（context_token / aes_key 只经加密或磁盘保存）。
 * 注：async 以便测试 await 媒体下载完成；runLoop 侧 fire-and-forget 不阻塞轮询。
 */
export async function processMessages(userId, messages) {
  const now = Date.now();
  const mediaTasks = [];
  for (const message of messages) {
    try {
      if (!message || typeof message !== 'object') continue;
      const fromUserId = message.from_user_id ? String(message.from_user_id) : '';
      if (!fromUserId) continue; // 只处理用户发出的消息
      const messageId =
        message.message_id === null || message.message_id === undefined ? '' : String(message.message_id);
      const itemTypes = Array.isArray(message.item_list)
        ? message.item_list
            .map((item) => (item && item.type !== undefined ? item.type : null))
            .filter((type) => type !== null)
            .join(',')
        : '';
      const text = extractMessageText(message);
      const createdAt = Number(message.create_time_ms);
      const rawJson = sanitizeInboundRawJson(message);
      const result = store.saveInbound({
        userId,
        wechatMessageId: messageId,
        fromUserId,
        text,
        itemTypes,
        rawJson,
        createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now,
        receivedAt: now,
      });
      if (!result.inserted) continue; // 唯一索引去重：重复消息忽略
      if (message.context_token) store.updateContextToken(userId, String(message.context_token), now);
      store.touchInbound(userId, now);
      log.debug('收到入站消息', { userId, messageId, textLength: text.length });

      // 接口应用：文本消息异步触发规则引擎（不阻塞 getupdates；异常不影响入站保存）
      if (text.trim() !== '' && itemTypes.split(',').map((type) => type.trim()).includes('1')) {
        appRules.handleInboundMessage({
          userId,
          inboundMessageId: result.id,
          text,
          itemTypes,
        });
      }

      // 媒体 item：异步下载/解密/落盘，失败只记录 failed 附件（不抛错）
      const mediaItems = media.extractInboundMediaItems(message);
      if (mediaItems.length > 0) {
        mediaTasks.push(
          downloadInboundMediaItems({
            userId,
            inboundMessageId: result.id,
            wechatMessageId: messageId,
            items: mediaItems,
          }),
        );
      }
    } catch (err) {
      log.warn('保存入站消息失败（忽略该条）', { userId, message: err?.message });
    }
  }
  if (mediaTasks.length > 0) await Promise.allSettled(mediaTasks);
}

/** 单个账号的长轮询主循环。 */
async function runLoop(row, token, controller, worker) {
  const userId = row.id;
  const signal = controller.signal;
  let getUpdatesBuf = row.get_updates_buf || '';
  let consecutiveFailures = 0;
  let nextTimeoutMs = config.monitor.longPollTimeoutMs;
  // 凭据代际：worker 启动时捕获 token_enc；换绑/解绑会改写 DB，旧 worker 必须静默退出，
  // 且不得再写 get_updates_buf / 入站消息 / last_poll / paused（docs M1 修复）。
  const initialTokenEnc = row.token_enc ?? null;
  const isCurrentCredential = () => {
    const current = store.getUserRow(userId);
    return Boolean(current && current.status === 'active' && (current.token_enc ?? null) === initialTokenEnc);
  };

  // best-effort：通道启动通知，失败不阻塞轮询
  try {
    await ilink.notifyStart({ baseUrl: row.base_url, token });
    log.debug('notifystart 已发送', { userId });
  } catch (err) {
    if (signal.aborted) return;
    log.warn('notifystart 失败（忽略，继续轮询）', { userId, message: err?.message });
  }

  while (!signal.aborted) {
    // 每轮开始先校验凭据代际：已换绑/解绑则旧 worker 直接退出
    if (!isCurrentCredential()) {
      log.info('监控凭据已变更或解绑，旧循环退出', { userId });
      return;
    }
    let resp;
    try {
      resp = await ilink.getUpdates({
        baseUrl: row.base_url,
        token,
        getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal: signal,
      });
    } catch (err) {
      if (signal.aborted) break;
      if (!isCurrentCredential()) {
        log.info('监控凭据已变更，丢弃旧凭据的错误并退出', { userId, message: err?.message });
        return;
      }
      if (isStaleTokenLike(err)) {
        pauseForStaleToken(userId, err.message, isCurrentCredential);
        return;
      }
      consecutiveFailures += 1;
      const delayMs =
        consecutiveFailures >= config.monitor.maxConsecutiveFailures
          ? config.monitor.backoffMs
          : config.monitor.retryDelayMs;
      log.warn('getupdates 失败，准备退避重试', { userId, failures: consecutiveFailures, delayMs, message: err?.message });
      await sleep(delayMs, signal);
      continue;
    }
    if (signal.aborted) break;
    // 在途响应返回后、写库前再次校验凭据代际（换绑后旧 bot 的响应必须丢弃）
    if (!isCurrentCredential()) {
      log.info('监控凭据已变更，丢弃在途轮询响应并退出', { userId });
      return;
    }

    const ret = Number(resp?.ret ?? 0);
    const errcode = Number(resp?.errcode ?? 0);
    if (ret === -14 || errcode === -14) {
      pauseForStaleToken(userId, resp?.errmsg || 'getupdates 返回 -14', isCurrentCredential);
      return;
    }
    if (ret !== 0 || errcode !== 0) {
      consecutiveFailures += 1;
      const delayMs =
        consecutiveFailures >= config.monitor.maxConsecutiveFailures
          ? config.monitor.backoffMs
          : config.monitor.retryDelayMs;
      log.warn('getupdates 返回业务错误，准备退避重试', {
        userId,
        ret,
        errcode,
        errmsg: resp?.errmsg,
        failures: consecutiveFailures,
        delayMs,
      });
      await sleep(delayMs, signal);
      continue;
    }

    consecutiveFailures = 0;
    const newBuf = typeof resp?.get_updates_buf === 'string' ? resp.get_updates_buf : '';
    if (newBuf && newBuf !== getUpdatesBuf) {
      getUpdatesBuf = newBuf;
      store.updateGetUpdatesBuf(userId, getUpdatesBuf);
    }
    const serverTimeout = Number(resp?.longpolling_timeout_ms);
    if (Number.isFinite(serverTimeout) && serverTimeout > 0) {
      // 服务端建议值优先，但限制在合理区间
      nextTimeoutMs = Math.min(Math.max(1000, serverTimeout), 120000);
    }
    const messages = Array.isArray(resp?.msgs) ? resp.msgs : [];
    if (messages.length > 0) processMessages(userId, messages);
    store.touchPoll(userId, Date.now());
    worker.lastPollAt = Date.now();
  }
}

/**
 * 停止某账号监控（幂等）。
 * @param {string|object} userOrId
 * @param {{notify?: boolean, reason?: string}} [options]
 * @returns {Promise<boolean>} 是否真的停止了正在运行的循环
 */
export async function stop(userOrId, { notify = true, reason = '' } = {}) {
  const userId = toUserId(userOrId);
  const worker = workers.get(userId);
  if (!worker) return false;
  workers.delete(userId);
  try {
    worker.controller.abort();
  } catch {
    /* 忽略 */
  }
  // 最多等待 5 秒让循环收尾（在途请求可能未被中止）
  await Promise.race([worker.promise.catch(() => {}), sleep(5000)]);
  if (notify) {
    try {
      const row = store.getUserRow(userId);
      const secrets = store.getUserSecrets(userId);
      if (row?.base_url && secrets?.token) {
        await ilink.notifyStop({ baseUrl: row.base_url, token: secrets.token });
        log.debug('notifystop 已发送', { userId });
      }
    } catch (err) {
      log.debug('notifystop 失败（忽略）', { userId, message: err?.message });
    }
  }
  log.info('入站监控已停止', { userId, reason });
  return true;
}

/** 停止全部监控（优雅退出 / 测试清理）。 */
export async function stopAll(options = {}) {
  const ids = [...workers.keys()];
  await Promise.all(ids.map((id) => stop(id, options).catch(() => false)));
  return ids.length;
}
