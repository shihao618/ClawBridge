/**
 * 入站监控（monitor.js）—— 每个已绑定账号一个长轮询循环。
 *
 * 流程（docs/ARCHITECTURE.md §6 / docs/PROTOCOL.md §5.4）：
 *   notifyStart → getUpdates 长轮询 → 保存 get_updates_buf / 入站消息 / context_token；
 *   -14（token 失效）→ pause_until=now+1h + events('stale_token')，worker 内等待冷却到期后
 *   **继续轮询**（对齐官方 session-guard 语义，不再退出循环）；
 *   其他错误按协议退避（连续 3 次 → 30s 并清零计数，否则 2s）；
 *   - 有消息的响应立即持久化 get_updates_buf；空闲轮询按 MONITOR_META_FLUSH_MS（默认 5min）节流落盘，
 *     降低 NAS/SD 卡等设备写入频率（崩溃最多重放空响应，消息按 msg_id 去重）；
 *   客户端超时/主动中止属于正常控制流（ilink.getUpdates 已转为空响应）。
 *
 * start/stop 幂等，key = userId；stop 时 best-effort notifyStop。
 */
import { config } from './config.js';
import { isStaleTokenError } from './errors.js';
import { extractBodyFromItemList, extractQuotedMessage } from './inbound-quote.js';
import * as appRules from './app-rules.js';
import * as ilink from './ilink.js';
import { logger } from './logger.js';
import * as media from './media.js';
import * as metrics from './metrics.js';
import * as store from './store.js';

const log = logger.child({ mod: 'monitor' });

/** 历史防抖策略常量（轮询已改为“游标变化即落库”，保留给兼容测试/文档）。 */
const MESSAGE_IDLE_FLUSH_MS = 15 * 60 * 1000;
/** 历史防抖策略常量（轮询已改为“游标变化即落库”，保留给兼容测试/文档）。 */
const CURSOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * 历史防抖策略（已不再用于真实轮询；官方 2.4.10 为每次收到非空游标即落盘）。
 * 保留纯函数便于旧测试/文档引用。
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
 * 官方语义：仅 body 中的 `ret/errcode=-14` 视为 token 失效；HTTP 401 本身不构成失效
 * （401 + body 非 -14 → 普通失败退避，不冷却 1 小时）。
 */
function isStaleTokenLike(err) {
  if (isStaleTokenError(err)) return true;
  if (!err || err.name !== 'ILinkError') return false;
  return typeof err.body === 'string' && /"?(?:ret|errcode)"?\s*:\s*-14/.test(err.body);
}

/** notifyStart/notifyStop：协议返回 ret!=0 时只告警，不抛错（best-effort）。 */
function warnNotifyRet(label, userId, resp) {
  const ret = Number(resp?.ret ?? 0);
  if (Number.isFinite(ret) && ret !== 0) {
    log.warn(`${label} 返回非 0（忽略，不影响轮询）`, { userId, ret, errmsg: resp?.errmsg ?? '' });
  }
}

/** 官方 getWeixinMessageId()：顶层 message_id 为空时回退 item_list[].msg_id。 */
export function resolveInboundMessageId(message) {
  const top = message?.message_id === null || message?.message_id === undefined ? '' : String(message.message_id).trim();
  if (top) return top;
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  for (const item of items) {
    const raw = item?.msg_id;
    if (raw === null || raw === undefined) continue;
    const value = String(raw).trim();
    if (value) return value;
  }
  return '';
}

/** 官方 extractTextBody()（slash 指令探测用）：只取首个 TEXT item 的原始文本。 */
export function extractFirstTextItem(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  for (const item of items) {
    if (item && typeof item === 'object' && item.type === 1 && item.text_item && item.text_item.text !== null && item.text_item.text !== undefined) {
      return String(item.text_item.text);
    }
  }
  return '';
}

/**
 * 提取消息的可读正文（对齐官方 bodyFromItemList：按 item 顺序，首个可识别项决定正文；
 * 媒体占位不带文件名）。工具调用占位为平台附加展示（官方无此文案），仅作为最终回退。
 */
export function extractMessageText(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  const body = extractBodyFromItemList(items);
  if (body) return body;
  return items.some((item) => item && (item.type === 11 || item.type === 12)) ? '[工具调用]' : '';
}

/** /echo 回显内容上限（防止超长入队/发送）。 */
const ECHO_MAX_REPLY_LEN = 2000;

/**
 * 官方 slash-commands 简易版：命令从首个 TEXT item 取，大小写不敏感。
 * 目前只实现 `/echo <内容>`（回显）；`/toggle-debug` 等其它命令不处理（交回规则流水线）。
 * @param {string} content 首个 TEXT item 的原始文本
 * @returns {{handled:boolean, command:string, reply:string}}
 */
export function parseEchoCommand(content) {
  const text = String(content ?? '').trim();
  if (!text.startsWith('/')) return { handled: false, command: '', reply: '' };
  const spaceIndex = text.indexOf(' ');
  const command = (spaceIndex === -1 ? text : text.slice(0, spaceIndex)).toLowerCase();
  if (command !== '/echo') return { handled: false, command, reply: '' };
  const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1).trim();
  const reply = args ? args.slice(0, ECHO_MAX_REPLY_LEN) : '（空）';
  return { handled: true, command: '/echo', reply };
}

/**
 * 失败退避节奏（对齐官方 monitor：连续失败达到阈值 → 30s 并清零计数，否则 2s；
 * 清零后下次失败重新从 2s 开始，形成 2s→2s→30s→2s→2s→30s 节奏）。
 * @param {number} failures 本次失败后的连续失败次数（>=1）
 * @returns {{delayMs:number, nextFailures:number}}
 */
export function computeBackoff(
  failures,
  {
    maxFailures = config.monitor.maxConsecutiveFailures,
    backoffMs = config.monitor.backoffMs,
    retryDelayMs = config.monitor.retryDelayMs,
  } = {},
) {
  const count = Math.max(1, Math.floor(Number(failures) || 0));
  const limit = Math.max(1, Math.floor(Number(maxFailures) || 1));
  if (count >= limit) return { delayMs: Math.max(0, Number(backoffMs) || 0), nextFailures: 0 };
  return { delayMs: Math.max(0, Number(retryDelayMs) || 0), nextFailures: count };
}

/** 官方 monitor：longpolling_timeout_ms 原样使用；仅无效值（<=0/NaN）回退当前值。 */
export function resolveLongPollTimeout(serverValue, fallback) {
  const value = Number(serverValue);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 是否在运行。 */
export function isRunning(userOrId) {
  return workers.has(toUserId(userOrId));
}

/** 当前运行的监控数量。 */
export function runningCount() {
  return workers.size;
}

// ---------------------------------------------------------------------------
// 冷却（-14）到期自动恢复
// ---------------------------------------------------------------------------

/** 冷却到期后自动恢复监控的定时器（key=userId）；stop/stopAll 会取消。 */
const pausedResumeTimers = new Map();
/** 生产进程内扫描冷却到期账号的间隔（重启恢复兜底；见 resumePausedMonitors）。 */
const PAUSED_RESUME_SWEEP_MS = 60 * 1000;
let pausedSweepTimer = null;

function clearPausedResumeTimer(userId) {
  const timer = pausedResumeTimers.get(userId);
  if (!timer) return false;
  clearTimeout(timer);
  pausedResumeTimers.delete(userId);
  return true;
}

/** 在 pause_until 到期后自动调用 start()。 */
function schedulePausedStart(userId, pauseUntil) {
  clearPausedResumeTimer(userId);
  const delayMs = Math.max(0, Number(pauseUntil) - Date.now()) + 100;
  const timer = setTimeout(() => {
    pausedResumeTimers.delete(userId);
    try {
      start(userId);
    } catch (err) {
      log.warn('冷却结束后自动恢复入站监控失败', { userId, message: err?.message });
    }
  }, delayMs);
  timer.unref?.();
  pausedResumeTimers.set(userId, timer);
}

/**
 * 重启恢复兜底：扫描 active 且 pause_until 已到期的账号并启动监控。
 * index.js 的 restoreMonitors 只取 pause_until<=now 的用户，进程重启时仍处于冷却中的账号
 * 需要这里在冷却到期后恢复（生产环境每 60s 自动扫描；测试可直接调用）。
 * @returns {number} 本次成功启动的监控数量
 */
export function resumePausedMonitors() {
  let rows;
  try {
    rows = store.getBroadcastTargets({ includePaused: true });
  } catch (err) {
    log.debug('扫描冷却账号失败（忽略）', { message: err?.message });
    return 0;
  }
  const now = Date.now();
  let started = 0;
  for (const row of rows) {
    const userId = String(row?.id ?? '');
    if (!userId || workers.has(userId) || pausedResumeTimers.has(userId)) continue;
    if (row.status !== 'active') continue;
    const pauseUntil = Number(row.pause_until) || 0;
    if (pauseUntil <= 0 || pauseUntil > now) continue;
    try {
      if (start(userId)) started += 1;
    } catch (err) {
      log.warn('恢复冷却到期的入站监控失败（忽略）', { userId, message: err?.message });
    }
  }
  return started;
}

/** 仅生产环境启用自动扫描（避免测试/开发环境的后台定时器干扰）。 */
function ensurePausedResumeSweeper() {
  if (pausedSweepTimer || !config.isProduction) return;
  pausedSweepTimer = setInterval(() => {
    try {
      resumePausedMonitors();
    } catch (err) {
      log.debug('冷却账号扫描异常（忽略）', { message: err?.message });
    }
  }, PAUSED_RESUME_SWEEP_MS);
  pausedSweepTimer.unref?.();
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
    // 对齐官方：冷却结束后继续轮询；这里安排到期自动 start（幂等，可被 stop 取消）
    schedulePausedStart(userId, Number(row.pause_until));
    log.info('账号冷却中，已安排冷却结束后自动恢复入站监控', { userId, pauseUntil: row.pause_until });
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

/**
 * -14 处理：暂停 1 小时 + 事件；worker 在循环内等待到 pause_until 后继续轮询（对齐官方）。
 * @returns {number} pause_until（0 表示凭据代际已变化、忽略本次 -14）
 */
function pauseForStaleToken(userId, detail, isCurrentCredential = () => true) {
  // 凭据代际保护：旧 worker（换绑前启动）不得把已换绑的用户置为冷却
  if (!isCurrentCredential()) {
    log.info('凭据已变更，忽略旧 worker 的 -14（不写 paused）', { userId });
    return 0;
  }
  const pauseUntil = Date.now() + config.monitor.stalePauseMs;
  const message = 'bot token 已失效（-14），已暂停 1 小时，到期后自动恢复轮询；若仍失效请重新扫码绑定';
  store.setUserPaused(userId, pauseUntil, message);
  store.addEvent({ type: 'stale_token', userId, detail: String(detail ?? '').slice(0, 500) });
  log.warn('bot token 失效，账号进入冷却（到期后自动继续轮询）', { userId, pauseUntil });
  return pauseUntil;
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
      messageId = resolveInboundMessageId(message);
      const itemTypes = Array.isArray(message.item_list)
        ? message.item_list
            .map((item) => (item && item.type !== undefined ? item.type : null))
            .filter((type) => type !== null)
            .join(',')
        : '';
      const text = extractMessageText(message);
      const createdAt = Number(message.create_time_ms);
      // 引用消息（quote / partial quote）：解析后并入 raw_json（原始 JSON 字段保留），
      // 不改变规则匹配正文（对齐官方：引用上下文仅作为辅助信息）。
      const quote = extractQuotedMessage(message);
      const rawJson = sanitizeInboundRawJson(quote ? { ...message, _quote: quote } : message);
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
      log.debug('收到入站消息', { userId, messageId, textLength: text.length, hasQuote: Boolean(quote) });

      // slash 指令（官方简易版）：/echo 直接回显入队（source='slash'），不进入规则引擎。
      const slash = parseEchoCommand(extractFirstTextItem(message));
      if (slash.handled) {
        try {
          store.enqueueMessage({ userId, text: slash.reply, source: 'slash' });
          log.info('slash 指令已回显入队', { userId, messageId, command: slash.command, replyLength: slash.reply.length });
        } catch (err) {
          log.warn('slash 指令回显入队失败（忽略）', { userId, messageId, message: err?.message });
        }
      }

      // 接口应用：文本消息异步触发规则引擎（不阻塞 getupdates；异常不影响入站保存）；
      // slash 指令已处理时不进入规则流水线。
      if (!slash.handled && text.trim() !== '' && itemTypes.split(',').map((type) => type.trim()).includes('1')) {
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
  const rawMetaFlushMs = Number(config.monitor.metaFlushMs);
  // 0 = 空闲不写盘（仅消息/退出时落盘）；默认 6 小时；上限 24 小时。
  const metaFlushMs =
    rawMetaFlushMs <= 0 ? 0 : Math.max(1000, Math.min(24 * 60 * 60 * 1000, rawMetaFlushMs || 6 * 60 * 60 * 1000));
  /** 上次把轮询元数据（游标 / last_poll_at）落盘的时间；空闲轮询按 metaFlushMs 节流。 */
  let lastDiskFlushAt = Number(row.last_poll_at) || 0;
  /** 是否刚从 -14 冷却恢复（恢复后的首个成功响应清除 DB pause_until/last_error）。 */
  let pausedForStaleToken = false;

  /** 落库当前内存游标；失败保留 dirty，下一轮开头重试。 */
  const persistCursor = () => {
    if (!cursorDirty) return false;
    try {
      store.updateGetUpdatesBuf(userId, getUpdatesBuf, Date.now());
      cursorDirty = false;
      return true;
    } catch (err) {
      log.warn('持久化 getupdates 游标失败（下一轮重试）', { userId, message: err?.message });
      return false;
    }
  };

  /**
   * 失败退避（对齐官方 monitor）：2s→2s→30s（达到阈值时清零计数），
   * 清零后下一次失败重新从 2s 开始，形成 2s→2s→30s→2s→2s→30s 节奏。
   * @param {object} detail 日志附加字段
   */
  const deferForFailure = async (detail) => {
    consecutiveFailures += 1;
    const failures = consecutiveFailures;
    const { delayMs, nextFailures } = computeBackoff(failures);
    consecutiveFailures = nextFailures;
    log.warn('getupdates 失败，准备退避重试', {
      userId,
      failures,
      delayMs,
      ...detail,
    });
    await sleep(delayMs, signal);
  };

  /**
   * -14 冷却：写 DB pause_until + 事件后，在本 worker 内等待到冷却到期再继续轮询
   * （对齐官方 session-guard：不退出循环，可被 stop 中止）。
   * @param {string} detail 事件/日志详情
   */
  const enterStalePause = async (detail) => {
    const pauseUntil = pauseForStaleToken(userId, detail, isCurrentCredential);
    if (signal.aborted || pauseUntil <= 0) return;
    pausedForStaleToken = true;
    consecutiveFailures = 0;
    await sleep(Math.max(0, pauseUntil - Date.now()), signal);
  };

  // 凭据代际：worker 启动时捕获 token_enc；换绑/解绑会改写 DB，旧 worker 必须静默退出，
  // 且不得再写 get_updates_buf / 入站消息 / last_poll / paused（docs M1 修复）。
  const initialTokenEnc = row.token_enc ?? null;
  const isCurrentCredential = () => {
    const current = store.getUserRow(userId);
    return Boolean(current && current.status === 'active' && (current.token_enc ?? null) === initialTokenEnc);
  };

  // best-effort：通道启动通知，失败不阻塞轮询；ret!=0 只告警（对齐官方 channel.startAccount）
  try {
    const startResp = await ilink.notifyStart({ baseUrl: row.base_url, token });
    warnNotifyRet('notifystart', userId, startResp);
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
    // 上一轮游标落库失败后的重试不做额外特殊处理：dirty 会在下一个成功响应
    // 满足「有消息 / 距上次落盘 ≥ metaFlushMs」时重试，避免每轮轮询都尝试写库。
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
        await enterStalePause(err.message);
        continue;
      }
      if (err?.httpStatus === 401) {
        // 官方语义：HTTP 401 但 body 未携带 ret/errcode=-14 → 不是 token 失效，按普通失败退避（不冷却）。
        log.warn('getupdates HTTP 401 但 body 未带 -14，按普通失败退避（不冷却）', {
          userId,
          body: String(err?.body ?? '').slice(0, 200),
        });
      }
      metrics.incCounter('monitor.poll.errors.total');
      await deferForFailure({ message: err?.message });
      continue;
    }
    if (signal.aborted) break;
    // 在途响应返回后、写库前再次校验凭据代际（换绑后旧 bot 的响应必须丢弃）
    if (!isCurrentCredential()) {
      log.info('监控凭据已变更，丢弃在途轮询响应并退出', { userId });
      return;
    }

    // 每轮成功响应后更新内存指标；DB last_poll_at 按 metaFlushMs 节流（见下方落库策略）。
    const ret = Number(resp?.ret ?? 0);
    const errcode = Number(resp?.errcode ?? 0);
    if (ret === -14 || errcode === -14) {
      metrics.incCounter('monitor.poll.errors.total');
      metrics.incCounter('monitor.stale_token.total');
      await enterStalePause(resp?.errmsg || 'getupdates 返回 -14');
      continue;
    }
    if (ret !== 0 || errcode !== 0) {
      metrics.incCounter('monitor.poll.errors.total');
      await deferForFailure({ ret, errcode, errmsg: resp?.errmsg });
      continue;
    }

    // 成功响应：清零失败计数；若刚从 -14 冷却恢复，清除 DB pause_until/last_error
    //（官方 session-guard 的暂停窗口到期后自动失效语义）。
    consecutiveFailures = 0;
    if (pausedForStaleToken) {
      pausedForStaleToken = false;
      try {
        store.clearUserPause(userId);
        log.info('token 冷却结束，入站监控恢复轮询', { userId });
      } catch (err) {
        log.debug('清除冷却状态失败（忽略）', { userId, message: err?.message });
      }
    }

    const newBuf = typeof resp?.get_updates_buf === 'string' ? resp.get_updates_buf : '';
    const bufChanged = Boolean(newBuf && newBuf !== getUpdatesBuf);
    // 官方：longpolling_timeout_ms 原样使用；仅无效值回退当前值。
    nextTimeoutMs = resolveLongPollTimeout(resp?.longpolling_timeout_ms, nextTimeoutMs);
    const messages = Array.isArray(resp?.msgs) ? resp.msgs : [];
    let inboundOutcome = null;
    if (messages.length > 0) {
      // await 仅覆盖“消息落库”阶段（媒体下载在后台有界执行），以便按落库结果决定是否推进游标。
      inboundOutcome = await processMessages(userId, messages, { awaitMedia: false });
    }
    if (inboundOutcome?.retryable) {
      // 可重试的落库失败不推进游标，下一轮 getUpdates 用旧 buf 重放同一批消息。
      metrics.incCounter('monitor.poll.errors.total');
      metrics.incCounter('monitor.inbound_save_retry.total');
      await deferForFailure({ reason: 'inbound_save_retry' });
      continue;
    }
    // 落库处理完成（成功或不可重试失败已记事件）后才推进内存游标。
    // 磁盘写入策略（兼顾可靠性与 NAS/低写入设备寿命）：
    // - 收到消息：立即持久化，保证崩溃后不重放有消息的批次；
    // - 空闲轮询：游标/最近轮询时间最多每 metaFlushMs 落盘一次（默认 5 分钟）；
    //   崩溃最多重放空响应，消息按 wechat_message_id 去重，不会产生重复回复。
    if (bufChanged) {
      getUpdatesBuf = newBuf;
      cursorDirty = true;
    }
    worker.pendingBuf = getUpdatesBuf;
    worker.lastPollAt = Date.now();
    const now = Date.now();
    const idleFlushDue = metaFlushMs > 0 && now - lastDiskFlushAt >= metaFlushMs;
    let persisted = false;
    if (cursorDirty) {
      const flushDue = messages.length > 0 || idleFlushDue;
      if (flushDue) {
        persisted = persistCursor();
        if (persisted) lastDiskFlushAt = now;
      }
    }
    if (!persisted && idleFlushDue) {
      try {
        store.touchPoll(userId, now);
        lastDiskFlushAt = now;
      } catch (pollErr) {
        log.debug('更新 last_poll_at 失败（忽略）', { userId, message: pollErr?.message });
      }
    }
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
  // 手动 stop 同时取消“冷却到期自动恢复”的定时器（避免停止后又被自动拉起）
  clearPausedResumeTimer(userId);
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
  // 仅在优雅退出时补写一次内存游标（正常轮询已“变化即落库”，这里是兜底）。
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
        const stopResp = await ilink.notifyStop({ baseUrl: row.base_url, token: secrets.token });
        warnNotifyRet('notifystop', userId, stopResp);
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
  for (const userId of [...pausedResumeTimers.keys()]) clearPausedResumeTimer(userId);
  const ids = [...workers.keys()];
  await Promise.all(ids.map((id) => stop(id, options).catch(() => false)));
  return ids.length;
}

// 生产环境启动“冷却到期自动恢复”扫描（index.restoreMonitors 只恢复非冷却用户，这里兜底）。
ensurePausedResumeSweeper();
