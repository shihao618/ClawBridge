/**
 * 出站消息队列 worker（dispatcher.js）—— 单循环顺序投递。
 *
 * 流程（docs/ARCHITECTURE.md §5、docs/MEDIA.md §6）：
 *   1. 取 status='queued' 且 next_attempt_at<=now 的最早一条；
 *   2. 用户非 active 或冷却中 → 直接置 failed；出站附件缺失/未就绪 → 直接 failed（不重试）；
 *   3. 每账号令牌桶限流（RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS），无配额则推迟该账号队列；
 *   4. queued → sending：
 *      - 媒体消息：caption（text）先发一次并记录 caption_sent_at，再上传 CDN 并发送媒体 item；
 *        caption 与媒体各消耗 1 个限流令牌；
 *      - 纯文本：一次 sendText；
 *   5. 成功 → sent + last_outbound_at；失败 ret=-2 限流退避重试；ret=-2 prepare failed 直接失败（context_token 失效）；
 *      -14 冷却 1h 并失败剩余；HTTP 401 仅当响应体含 ret/errcode=-14 才视为 token 失效，其余按普通失败退避到上限。
 *   6. 永久失败（非 -14/非 prepare failed）时按 PUSH_ERROR_NOTICE_ENABLED 向用户 best-effort 发一条简短失败提示；
 *      提示直接发送、不进入 outbox 队列、不重试、同一 outbox 只提示一次（防循环）。
 * 启动时把残留 sending 重置为 queued。
 */
import { config } from './config.js';
import { isPrepareFailedError, isRateLimitError, isStaleTokenError } from './errors.js';
import * as ilink from './ilink.js';
import { logger } from './logger.js';
import * as media from './media.js';
import * as metrics from './metrics.js';
import { TokenBucketLimiter } from './rate-limiter.js';
import * as store from './store.js';

const log = logger.child({ mod: 'dispatcher' });

/** 每账号发送限流器（进程内单实例）。 */
const limiter = new TokenBucketLimiter({
  max: config.push.rateLimitMax,
  windowMs: config.push.rateLimitWindowMs,
});

/** 应用运行配置中的限流值；必须在 start() 时（loadOverrides 之后）同步一次。 */
export function refreshLimiterConfig() {
  limiter.max = Math.max(1, config.push.rateLimitMax);
  limiter.windowMs = Math.max(1, config.push.rateLimitWindowMs);
  limiter.clear();
}

let running = false;
/** @type {AbortController|null} */
let controller = null;
/** @type {Promise<void>|null} */
let loopPromise = null;
let processedTotal = 0;

/** 优雅退出 drain：等待在途 processOne 的上限（媒体上传/发送不可中止，超时后不再写 DB）。 */
const DRAIN_TIMEOUT_MS = 8000;
/** drain 状态（stop() 执行期间为 true，供测试/观测）。 */
let draining = false;
/** drain 超时后由 index 在关库前标记：在途发送完成后跳过 DB 写入（进程即将强制退出）。 */
let dbClosing = false;

/** 当前限流器（测试/管理端只读用）。 */
export function getLimiter() {
  return limiter;
}

/** 重置某账号的发送限流桶（换绑/重新绑定后调用，避免旧 bot 的限流窗口影响新账号）。 */
export function resetRateLimit(userId) {
  if (!userId) return false;
  limiter.reset(String(userId));
  log.info('已重置账号发送限流桶', { userId: String(userId) });
  return true;
}

/** worker 是否在运行。 */
export function isRunning() {
  return running;
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
 * 与官方 session-guard.js 一致：只认响应体中的 ret/errcode=-14。
 * HTTP 401 但 body 未带 -14 时不算 token 失效（避免网关/代理 401 误冷却账号）；
 * 兼容两种上游表达：① HTTP 200 + body.ret=-14；② HTTP 401 + body 中 ret/errcode=-14。
 */
function isStaleTokenLike(err) {
  if (isStaleTokenError(err)) return true;
  if (!err || err.name !== 'ILinkError') return false;
  return typeof err.body === 'string' && /"?(?:ret|errcode)"?\s*:\s*-14(?:[^0-9]|$)/.test(err.body);
}

/** 发送失败提示文案（仅告知结果，不包含 token/内部错误细节）。 */
const ERROR_NOTICE_TEXT = '⚠️ 消息发送失败，请稍后重试';
/** 已发送过失败提示的 outbox id（同一消息只提示一次；进程内有界去重，防止提示本身失败造成循环）。 */
const errorNoticeSent = new Set();
const ERROR_NOTICE_DEDUPE_LIMIT = 1000;

/**
 * 出站消息永久失败时，向用户 best-effort 发送一条失败提示（对齐官方 error-notice.js）。
 * - 直接调用 ilink.sendText，不进入 outbox 队列、不重试、失败只记 debug；
 * - -14（需重新绑定）与 prepare failed（context_token 失效）由调用方跳过；
 * - 同一 outbox 只提示一次（进程内去重）。
 * @returns {Promise<boolean>} 是否实际尝试并成功发送
 */
async function sendErrorNotice({ user, candidate, secrets }) {
  if (!config.push.errorNoticeEnabled || dbClosing) return false;
  const outboxId = candidate?.id;
  if (!outboxId || errorNoticeSent.has(outboxId)) return false;
  const userSecrets = secrets ?? store.getUserSecrets(user.id);
  if (!userSecrets?.token) return false;
  errorNoticeSent.add(outboxId);
  if (errorNoticeSent.size > ERROR_NOTICE_DEDUPE_LIMIT) {
    errorNoticeSent.delete(errorNoticeSent.values().next().value);
  }
  try {
    await ilink.sendText({
      baseUrl: user.base_url,
      token: userSecrets.token,
      toUserId: user.wechat_user_id,
      text: ERROR_NOTICE_TEXT,
      contextToken: userSecrets.contextToken || undefined,
    });
    metrics.incCounter('dispatcher.error_notice.sent');
    log.debug('已向用户发送发送失败提示', { outboxId, userId: user.id });
    return true;
  } catch (err) {
    metrics.incCounter('dispatcher.error_notice.failed');
    log.debug('发送失败提示失败（忽略）', { outboxId, userId: user.id, message: err?.message });
    return false;
  }
}

/** 启动 worker（幂等）。 */
export function start() {
  if (running) return false;
  refreshLimiterConfig();
  running = true;
  controller = new AbortController();
  // 进程重启恢复：残留 sending 记录重新入队
  try {
    const recovered = store.resetSendingToQueued();
    if (recovered > 0) log.warn('已把残留 sending 消息重新入队', { recovered });
  } catch (err) {
    log.error('重置 sending 队列失败', { message: err?.message });
  }
  loopPromise = loop(controller.signal)
    .catch((err) => log.error('出站队列 worker 异常退出', { message: err?.message, stack: err?.stack }))
    .finally(() => {
      running = false;
      loopPromise = null;
    });
  log.info('出站队列 worker 已启动', {
    tickMs: config.push.tickMs,
    rateLimitMax: config.push.rateLimitMax,
    rateLimitWindowMs: config.push.rateLimitWindowMs,
    maxAttempts: config.push.maxAttempts,
  });
  return true;
}

/**
 * 停止 worker（幂等）：先停止取新任务，再等待在途 processOne 完成（默认最多 8s）。
 *
 * 旧实现只 `Promise.race` 等 5s，随后 index 立即关 DB，可能造成
 * “消息已发出但 markOutboxSent 写失败 → 重启后重复投递”。
 * @returns {Promise<{stopped:boolean, drained:boolean}>} drained=false 表示等待超时（仍有在途发送）
 */
export async function stop({ timeoutMs = DRAIN_TIMEOUT_MS } = {}) {
  if (!running && !loopPromise) return { stopped: false, drained: true };
  running = false;
  draining = true;
  try {
    controller?.abort();
  } catch {
    /* 忽略 */
  }
  const loopDone = (loopPromise ?? Promise.resolve()).then(
    () => true,
    () => true,
  );
  const drained = await Promise.race([loopDone, sleep(Math.max(1, Number(timeoutMs) || DRAIN_TIMEOUT_MS)).then(() => false)]);
  draining = false;
  if (!drained) {
    log.warn('出站队列 drain 超时，仍有在途发送；关闭数据库前后续写库将被跳过', {
      processedTotal,
      timeoutMs,
    });
  }
  log.info('出站队列 worker 已停止', { processedTotal, drained });
  return { stopped: true, drained };
}

/** drain 超时后由 index 在 closeDb() 前调用：在途发送完成后不再写 DB，避免关库后写失败/重复入队。 */
export function markDbClosing() {
  dbClosing = true;
}

/** 是否处于退出 drain 状态（管理端/测试观测用）。 */
export function isDraining() {
  return draining;
}

/** 主循环：有活就连续处理，无活按 tickMs 休眠。 */
async function loop(signal) {
  while (!signal.aborted) {
    let worked = false;
    try {
      worked = await processOne();
      if (worked) processedTotal += 1;
    } catch (err) {
      log.error('出站队列处理异常', { message: err?.message, stack: err?.stack });
      worked = false;
    }
    if (signal.aborted) break;
    if (!worked) await sleep(config.push.tickMs, signal);
  }
}

/**
 * 处理一条队列记录（单步，测试可直接调用）。
 * @returns {Promise<boolean>} 是否处理了一条记录
 */
export async function processOne(now = Date.now()) {
  const candidate = store.getNextQueuedCandidate(now);
  if (!candidate) return false;

  const user = store.getUserRow(candidate.user_id);
  if (!user) {
    store.markOutboxFailed(candidate.id, { error: '用户不存在', ts: now, incrementAttempts: false });
    metrics.incCounter('dispatcher.failed.total');
    log.warn('消息投递失败：用户不存在', { outboxId: candidate.id });
    return true;
  }
  if (user.status !== 'active') {
    store.markOutboxFailed(candidate.id, { error: '用户未绑定（凭证已清除），消息未发送', ts: now, incrementAttempts: false });
    metrics.incCounter('dispatcher.failed.total');
    log.warn('消息投递失败：用户未绑定', { outboxId: candidate.id, userId: user.id });
    return true;
  }
  if (Number(user.pause_until) > now) {
    store.markOutboxFailed(candidate.id, { error: '账号冷却中（bot token 失效），消息未发送', ts: now, incrementAttempts: false });
    metrics.incCounter('dispatcher.failed.total');
    log.warn('消息投递失败：账号冷却中', { outboxId: candidate.id, userId: user.id });
    return true;
  }

  // 出站附件预检查：不存在/方向不对/未就绪 → 直接 failed（不消耗限流令牌、不重试）
  let attachment = null;
  if (candidate.media_id) {
    attachment = store.getAttachment(candidate.media_id);
    if (!attachment || attachment.direction !== 'outbound' || attachment.status !== 'ready') {
      store.markOutboxFailed(candidate.id, { error: '媒体附件不存在或未就绪，无法发送', ts: now, incrementAttempts: false });
      metrics.incCounter('dispatcher.failed.total');
      log.warn('消息投递失败：媒体附件缺失/未就绪', { outboxId: candidate.id, mediaId: candidate.media_id });
      void sendErrorNotice({ user, candidate });
      return true;
    }
  }

  if (!store.markOutboxSending(candidate.id, now)) return true;
  const secrets = store.getUserSecrets(user.id);
  if (!secrets?.token) {
    store.markOutboxFailed(candidate.id, { error: '缺少 bot_token，需要用户重新扫码绑定', ts: now, incrementAttempts: false });
    metrics.incCounter('dispatcher.failed.total');
    return true;
  }
  const contextToken = secrets.contextToken || undefined;
  const rawText = typeof candidate.text === 'string' ? candidate.text : '';

  try {
    // 1) 媒体消息的 caption 先发（成功后记录 caption_sent_at，-2 重试时不重复发送）
    const caption = rawText.trim();
    if (attachment && caption !== '' && Number(candidate.caption_sent_at) === 0) {
      const captionQuota = limiter.tryAcquire(user.id);
      if (!captionQuota.allowed) {
        deferForRateLimit(candidate, user, captionQuota.waitMs, now);
        return false;
      }
      await ilink.sendText({
        baseUrl: user.base_url,
        token: secrets.token,
        toUserId: user.wechat_user_id,
        text: rawText,
        contextToken,
      });
      if (dbClosing) {
        log.warn('退出 drain 超时：caption 已发出但跳过写库', { outboxId: candidate.id, userId: user.id });
        return true;
      }
      store.markCaptionSent(candidate.id, Date.now());
      log.info('媒体 caption 已发送', { outboxId: candidate.id, userId: user.id });
    }

    // 2) 发送主体（媒体 item 或纯文本）；每次 sendmessage 消耗 1 个令牌
    const quota = limiter.tryAcquire(user.id);
    if (!quota.allowed) {
      deferForRateLimit(candidate, user, quota.waitMs, now);
      return false;
    }

    const sendStartedAt = Date.now();
    let resp;
    let sentKind = '';
    if (attachment) {
      const mediaResult = await sendMediaAttachment({
        user,
        token: secrets.token,
        attachment,
        contextToken,
      });
      resp = mediaResult.resp;
      sentKind = mediaResult.kind;
      log.info('媒体消息投递成功', { outboxId: candidate.id, userId: user.id, mediaId: attachment.id, kind: sentKind });
    } else {
      resp = await ilink.sendText({
        baseUrl: user.base_url,
        token: secrets.token,
        toUserId: user.wechat_user_id,
        text: rawText,
        contextToken,
      });
    }

    const serverMessageId = resp?.message_id ?? resp?.msg_id ?? null;
    if (dbClosing) {
      log.warn('退出 drain 超时：消息已发出但跳过写库（由重启后 resetSendingToQueued 兜底）', {
        outboxId: candidate.id,
        userId: user.id,
        serverMessageId,
      });
      return true;
    }
    store.markOutboxSent(candidate.id, {
      serverMessageId,
      clientId: resp?.clientId ?? null,
      ts: Date.now(),
    });
    store.touchOutbound(user.id, Date.now());
    try {
      store.clearContextTokenStale(user.id, Date.now());
    } catch { /* 忽略标记清理失败，不影响发送成功 */ }
    metrics.incCounter('dispatcher.sent.total');
    metrics.observeHistogram('dispatcher.send_latency_ms', Date.now() - sendStartedAt);
    log.info('消息投递完成', {
      outboxId: candidate.id,
      userId: user.id,
      attempts: candidate.attempts + 1,
      hasMedia: Boolean(attachment),
      kind: sentKind || undefined,
    });
  } catch (err) {
    if (dbClosing) {
      log.warn('退出 drain 超时：发送失败但跳过写库', { outboxId: candidate.id, userId: user.id, message: err?.message });
      return true;
    }
    // 不可重试错误：磁盘文件缺失 / 语音出站等
    if (err?.permanent || err?.code === 'ENOENT') {
      const reason = err?.code === 'ENOENT' ? '媒体文件缺失（磁盘文件不存在），无法发送' : err?.message ?? '媒体发送失败';
      store.markOutboxFailed(candidate.id, { error: reason, ts: Date.now() });
      metrics.incCounter('dispatcher.failed.total');
      log.warn('消息投递失败（不可重试）', { outboxId: candidate.id, userId: user.id, message: reason });
      void sendErrorNotice({ user, candidate, secrets });
      return true;
    }
    handleFailure({ candidate, user, err, secrets });
  }
  return true;
}

/** 无令牌配额时把单条与同账号队列推迟（不增加 attempts、不标记失败）。 */
function deferForRateLimit(candidate, user, waitMs, now) {
  const nextAt = now + Math.max(1, waitMs);
  store.deferOutbox(candidate.id, nextAt, now);
  store.deferUserQueued(user.id, nextAt, now);
  metrics.incCounter('dispatcher.rate_limited.total');
  log.debug('账号发送限流，队列推迟', {
    userId: user.id,
    outboxId: candidate.id,
    waitMs: nextAt - now,
    hasMedia: Boolean(candidate.media_id),
  });
}

/**
 * 读取附件并上传 CDN、发送媒体消息（一次尝试）。
 * @returns {Promise<{resp:object, kind:string}>}
 */
async function sendMediaAttachment({ user, token, attachment, contextToken }) {
  const buffer = await media.readMediaFile(attachment.path);
  // 语音附件保留 kind=voice（detectKind 对 audio/* 会归类为普通文件，需优先使用入库 kind）
  const kind =
    attachment.kind === media.MediaKind.VOICE
      ? media.MediaKind.VOICE
      : media.detectKind({ mime: attachment.mime, fileName: attachment.file_name });
  try {
    media.assertOutboundKindSupported(kind);
  } catch (err) {
    err.permanent = true;
    throw err;
  }
  const uploaded = await media.uploadMediaToCdn({
    baseUrl: user.base_url,
    token,
    toUserId: user.wechat_user_id,
    kind,
    buffer,
    fileName: attachment.file_name,
  });
  const item = media.buildMediaItem({ kind, uploaded, fileName: attachment.file_name });
  const resp = await ilink.sendMediaMessage({
    baseUrl: user.base_url,
    token,
    toUserId: user.wechat_user_id,
    item,
    contextToken,
  });
  return { resp, kind };
}

/** 发送失败处理：-14 冷却 / -2 退避 / 其他错误退避到上限；永久失败发用户提示。 */
function handleFailure({ candidate, user, err, secrets }) {
  if (dbClosing) {
    log.warn('退出 drain 超时：跳过失败状态写库', { outboxId: candidate.id, userId: user.id });
    return;
  }
  const now = Date.now();
  const attempts = Number(candidate.attempts) + 1;
  const message = err?.message ?? String(err);

  if (isStaleTokenLike(err)) {
    const pauseUntil = now + config.monitor.stalePauseMs;
    const reason = 'bot token 已失效，需要用户重新扫码绑定';
    store.markOutboxFailed(candidate.id, { error: reason, ts: now });
    const failedCount = store.failUserQueued(user.id, reason, now);
    store.setUserPaused(user.id, pauseUntil, reason, now);
    store.addEvent({ type: 'stale_token', userId: user.id, detail: 'sendmessage 返回 -14' });
    metrics.incCounter('dispatcher.failed.total');
    metrics.incCounter('dispatcher.stale_token.total');
    log.warn('消息投递失败：bot token 失效，账号进入 1 小时冷却', {
      outboxId: candidate.id,
      userId: user.id,
      alsoFailed: failedCount,
    });
    return;
  }

  // HTTP 401 但响应体未带 -14：不是 token 失效（对齐官方 session-guard），只告警不冷却，按普通失败处理。
  if (err?.name === 'ILinkError' && err.httpStatus === 401) {
    log.warn('HTTP 401 但响应体未包含 -14：不视为 token 失效、不冷却账号', {
      outboxId: candidate.id,
      userId: user.id,
      body: String(err.body ?? '').slice(0, 200),
    });
  }

  // iLink 的 ret=-2 有两种语义：真正限流，以及 prepare failed（context_token 缺失/失效）。
  // 后者重试无意义，直接失败并给出可操作提示。
  if (isPrepareFailedError(err)) {
    const reason =
      '消息发送失败：context_token 缺失或已失效，需要用户先给 bot 发一条消息刷新会话（iLink prepare failed）';
    store.markOutboxFailed(candidate.id, { error: reason, ts: now });
    // 绑定仍有效，但 context_token 已失效：标记为“待用户刷新会话”，后台不再显示可推送
    try {
      store.markContextTokenStale(user.id, now);
    } catch { /* 忽略标记失败，不影响失败落库 */ }
    metrics.incCounter('dispatcher.failed.total');
    log.warn('消息投递失败：context_token 缺失/失效（prepare failed），不重试', {
      outboxId: candidate.id,
      userId: user.id,
      message,
    });
    return;
  }

  if (attempts >= config.push.maxAttempts) {
    store.markOutboxFailed(candidate.id, { error: message, ts: now });
    metrics.incCounter('dispatcher.failed.total');
    log.warn('消息投递失败（达到最大重试次数）', {
      outboxId: candidate.id,
      userId: user.id,
      attempts,
      maxAttempts: config.push.maxAttempts,
      message,
    });
    void sendErrorNotice({ user, candidate, secrets });
    return;
  }

  const delays = config.push.retryDelaysMs;
  const delayMs = delays[Math.min(attempts - 1, delays.length - 1)] ?? 5000;
  store.rescheduleOutbox(candidate.id, { nextAttemptAt: now + delayMs, error: message, ts: now });
  metrics.incCounter('dispatcher.retry.total');
  if (isRateLimitError(err)) metrics.incCounter('dispatcher.rate_limited.total');
  log.warn(isRateLimitError(err) ? '发送被微信限流（-2），退避后重试' : '消息发送失败，退避后重试', {
    outboxId: candidate.id,
    userId: user.id,
    attempts,
    delayMs,
    message,
  });
}

/** 运行状态（管理端/测试观测用）。 */
export function getState() {
  return {
    running,
    draining,
    dbClosing,
    processedTotal,
    rateLimit: { max: config.push.rateLimitMax, windowMs: config.push.rateLimitWindowMs },
  };
}
