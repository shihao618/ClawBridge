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
import * as metrics from './metrics.js';
import * as store from './store.js';

const log = logger.child({ mod: 'monitor' });

/** 收到消息后静默多久再落游标（连续聊天期间不写游标）。 */
const MESSAGE_IDLE_FLUSH_MS = 15 * 60 * 1000;
/** 一直无消息时，游标最多保留在内存多久后兜底落库。 */
const CURSOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * 游标是否应落库：有消息时等 15 分钟静默；无消息时最多 6 小时。
 * 纯函数便于测试（真实循环只负责调用）。
 */
export function cursorPersistDue({
  dirty,
  now,
  lastMessageAt,
  lastPersistAt,
  idleMs = MESSAGE_IDLE_FLUSH_MS,
  maxAgeMs = CURSOR_MAX_AGE_MS,
} = {}) {
  if (!dirty) return false;
  if (lastMessageAt > 0) return now - lastMessageAt >= idleMs;
  return now - lastPersistAt >= maxAgeMs;
}

/** @type {Map<string, {controller: AbortController, promise: Promise<void>, startedAt: number}>} */
const workers = new Map();

// 可观测性：动态仪表在快照时求值，轮询热路径只做计数，不额外写库。
metrics.registerGaugeProvider('monitor.running_accounts', () => workers.size);
metrics.registerGaugeProvider('monitor.last_poll_at', () => {
  let latest = 0;
  for (const worker of workers.values()) latest = Math.max(latest, Number(worker.lastPollAt) || 0);
  return latest;
});

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
  const worker = { controller, startedAt: Date.now(), promise: Promise.resolve(), pendingBuf: '' };
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
 * 每个媒体 item 都在 media 进程级有界闸门内「流式下载+流式解密+落临时文件→原子 rename」，
 * 队列已满/排队超时直接记 failed，不会无限堆积；因此下面 processMessages 的等待也是有界的
 * （最坏 ≤ 排队超时 + 下载超时）。
 * @param {{userId:string, inboundMessageId:string, wechatMessageId:string, items:Array<object>}} params
 */
async function downloadInboundMediaItems({ userId, inboundMessageId, wechatMessageId, items }) {
  for (const item of items) {
    let staged = null;
    try {
      const { saved, mime } = await media.runInboundDownloadWithSlot(async () => {
        staged = await media.downloadAndDecryptInboundToTemp({
          media: item.media,
          aesKeyOverride: item.aesKeyOverride,
          timeoutMs: config.media.downloadTimeoutMs,
          maxBytes: config.media.inboundMaxBytes,
        });
        if (!staged || staged.size === 0) throw new Error('媒体内容为空');
        // MIME 修正：图片/视频用魔数嗅探；文件用文件名推断；语音固定 audio/silk
        let detectedMime = media.normalizeMime(item.mime);
        if (item.kind === media.MediaKind.IMAGE) {
          detectedMime = media.sniffMime(staged.head, detectedMime.startsWith('image/') ? detectedMime : 'image/jpeg');
        } else if (detectedMime === 'application/octet-stream') {
          detectedMime = media.sniffMime(staged.head, detectedMime);
        }
        const committed = await media.commitInboundTempMedia(staged, { mime: detectedMime });
        staged = null;
        return { saved: committed, mime: detectedMime };
      });
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
      metrics.incCounter('media.inbound.downloaded.total');
    } catch (err) {
      metrics.incCounter('media.inbound.failed.total');
      if (/队列已满|排队超时/.test(String(err?.message ?? ''))) {
        metrics.incCounter('media.inbound.gate_rejected.total');
      }
      if (staged) await media.discardInboundTempMedia(staged);
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
 * SQLite 级“可重试”的落库错误：busy/locked/IO/磁盘满/无法打开等。
 * 这些错误下同一批消息应保留在服务端游标内重放，不能推进游标。
 */
export function isRetryableInboundSaveError(err) {
  const message = String(err?.message ?? '');
  if (
    /SQLITE_(?:BUSY|LOCKED|IOERR|FULL|CANTOPEN|PROTOCOL)|database(?: table)? is locked|disk I\/O error|database or disk is full|unable to open database/i.test(
      message,
    )
  ) {
    return true;
  }
  const errcode = Number(err?.errcode);
  if (Number.isFinite(errcode)) {
    // 主错误码取低 8 位（扩展错误码高位携带更多细节）：5=BUSY,6=LOCKED,10=IOERR,13=FULL,14=CANTOPEN
    if ([5, 6, 10, 13, 14].includes(errcode & 0xff)) return true;
  }
  return false;
}

/**
 * 处理一批入站消息：去重落库、保存 context_token、落库媒体附件、更新时间戳。
 * raw_json 必须先脱敏（context_token / aes_key 只经加密或磁盘保存）。
 * 注：async 以便测试 await 媒体下载完成；runLoop 侧 fire-and-forget 不阻塞轮询。
 *     媒体任务在 media 有界闸门内执行，队列满/排队超时会立即记 failed，等待不会无限增长。
 *
 * 单条消息落库失败不再静默吞掉——
 * - 可重试错误（SQLITE_BUSY/LOCKED/IOERR/FULL…）：返回 {retryable:true}，由 runLoop 保留旧游标，
 *   下一轮 getUpdates 重放同一批消息（已落库的消息由唯一索引去重）；
 * - 不可重试错误：写 events(type='inbound_save_failed') + error 日志后跳过该条，不影响后续消息与游标推进。
 * @param {{awaitMedia?: boolean}} [options]
 * @returns {Promise<{saved:number, failed:number, retryable:boolean}>}
 */
export async function processMessages(userId, messages, { awaitMedia = true } = {}) {
  const now = Date.now();
  const mediaTasks = [];
  const outcome = { saved: 0, failed: 0, retryable: false };
  for (const message of messages) {
    let messageId = '';
    try {
      if (!message || typeof message !== 'object') continue;
      const fromUserId = message.from_user_id ? String(message.from_user_id) : '';
      if (!fromUserId) continue; // 只处理用户发出的消息
      messageId = message.message_id === null || message.message_id === undefined ? '' : String(message.message_id);
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
      outcome.saved += 1;
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
      if (isRetryableInboundSaveError(err)) {
        // 保留旧游标，由 runLoop 下一轮重放；本批剩余消息暂不处理，避免把游标推过失败消息。
        outcome.retryable = true;
        log.warn('入站消息保存失败（可重试），本轮不推进游标，下一轮重放该批消息', {
          userId,
          messageId,
          message: err?.message,
        });
        break;
      }
      outcome.failed += 1;
      const errorText = String(err?.message ?? err).slice(0, 300);
      log.error('入站消息保存失败（不可重试），已跳过并写入事件', { userId, messageId, message: errorText });
      try {
        store.addEvent({
          type: 'inbound_save_failed',
          userId,
          detail: JSON.stringify({ messageId, error: errorText }),
        });
      } catch (eventErr) {
        log.warn('记录 inbound_save_failed 事件失败（忽略）', { userId, message: eventErr?.message });
      }
    }
  }
  if (mediaTasks.length > 0) {
    // runLoop 场景不等待媒体（长轮询不被下载阻塞）；测试/直接调用默认等待，便于断言附件落库。
    const allMedia = Promise.allSettled(mediaTasks);
    if (awaitMedia) await allMedia;
  }
  return outcome;
}

/** 单个账号的长轮询主循环。 */
async function runLoop(row, token, controller, worker) {
  const userId = row.id;
  const signal = controller.signal;
  let getUpdatesBuf = row.get_updates_buf || '';
  let consecutiveFailures = 0;
  let nextTimeoutMs = config.monitor.longPollTimeoutMs;
  let cursorDirty = false;
  let lastMessageAt = 0;
  let lastPersistAt = Date.now();

  /** 落库当前内存游标；失败保留 dirty，下一轮重试。 */
  const persistCursor = () => {
    if (!cursorDirty) return false;
    const ts = Date.now();
    try {
      store.updateGetUpdatesBuf(userId, getUpdatesBuf, ts);
      cursorDirty = false;
      lastPersistAt = ts;
      lastMessageAt = 0;
      return true;
    } catch (err) {
      log.warn('持久化 getupdates 游标失败（下一轮重试）', { userId, message: err?.message });
      return false;
    }
  };

  /**
   * 两个落库窗口：
   * 1) 收到消息后静默 15 分钟；
   * 2) 一直无消息时最多 6 小时兜底一次（游标未变化则不写）。
   */
  const maybePersistCursor = () => {
    if (!cursorDirty) return;
    if (cursorPersistDue({
      dirty: cursorDirty,
      now: Date.now(),
      lastMessageAt,
      lastPersistAt,
    })) {
      persistCursor();
    }
  };
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
    maybePersistCursor();
    metrics.incCounter('monitor.poll.total');
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
        metrics.incCounter('monitor.poll.errors.total');
        metrics.incCounter('monitor.stale_token.total');
        pauseForStaleToken(userId, err.message, isCurrentCredential);
        return;
      }
      metrics.incCounter('monitor.poll.errors.total');
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

    // 每轮成功拿到 getUpdates 响应后更新 last_poll_at（轻量 UPDATE；失败不影响轮询/退避流程）。
    try {
      store.touchPoll(userId);
    } catch (pollErr) {
      log.debug('更新 last_poll_at 失败（忽略）', { userId, message: pollErr?.message });
    }

    const ret = Number(resp?.ret ?? 0);
    const errcode = Number(resp?.errcode ?? 0);
    if (ret === -14 || errcode === -14) {
      metrics.incCounter('monitor.poll.errors.total');
      metrics.incCounter('monitor.stale_token.total');
      pauseForStaleToken(userId, resp?.errmsg || 'getupdates 返回 -14', isCurrentCredential);
      return;
    }
    if (ret !== 0 || errcode !== 0) {
      metrics.incCounter('monitor.poll.errors.total');
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
    const bufChanged = Boolean(newBuf && newBuf !== getUpdatesBuf);
    const serverTimeout = Number(resp?.longpolling_timeout_ms);
    if (Number.isFinite(serverTimeout) && serverTimeout > 0) {
      // 服务端建议值优先，但限制在合理区间
      nextTimeoutMs = Math.min(Math.max(1000, serverTimeout), 120000);
    }
    const messages = Array.isArray(resp?.msgs) ? resp.msgs : [];
    let inboundOutcome = null;
    if (messages.length > 0) {
      lastMessageAt = Date.now();
      // await 仅覆盖“消息落库”阶段（媒体下载在后台有界执行），以便按落库结果决定是否推进游标。
      inboundOutcome = await processMessages(userId, messages, { awaitMedia: false });
    }
    if (inboundOutcome?.retryable) {
      // 可重试的落库失败不推进游标，下一轮 getUpdates 用旧 buf 重放同一批消息。
      metrics.incCounter('monitor.poll.errors.total');
      metrics.incCounter('monitor.inbound_save_retry.total');
      consecutiveFailures += 1;
      const delayMs =
        consecutiveFailures >= config.monitor.maxConsecutiveFailures
          ? config.monitor.backoffMs
          : config.monitor.retryDelayMs;
      log.warn('入站消息落库失败（可重试），暂不推进游标并重试同一批消息', {
        userId,
        failures: consecutiveFailures,
        delayMs,
      });
      await sleep(delayMs, signal);
      continue;
    }
    // 落库处理完成（成功或不可重试失败已记事件）后才推进内存游标
    if (bufChanged) {
      getUpdatesBuf = newBuf;
      cursorDirty = true;
    }
    worker.pendingBuf = getUpdatesBuf;
    maybePersistCursor();
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
  // 仅在优雅退出时补写一次内存游标，避免重启后重复回放；日常空闲不写盘。
  if (reason === 'shutdown' && worker.pendingBuf) {
    try {
      const row = store.getUserRow(userId);
      if (row && row.get_updates_buf !== worker.pendingBuf) {
        store.updateGetUpdatesBuf(userId, worker.pendingBuf, Date.now());
      }
    } catch (err) {
      log.warn('退出时持久化 getupdates 游标失败（忽略）', { userId, message: err?.message });
    }
  }
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
