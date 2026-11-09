/**
 * 微信「正在输入」状态（typing indicator）——规则命中期间显示，best-effort。
 *
 * 协议（docs/PROTOCOL.md §5.6，mock 已实现）：
 *   POST {baseUrl}/ilink/bot/getconfig   body {ilink_user_id, context_token?, base_info} → {ret:0, typing_ticket}
 *   POST {baseUrl}/ilink/bot/sendtyping  body {ilink_user_id, typing_ticket, status:1|2, base_info} → {ret:0}
 *   status：1=正在输入，2=取消。
 *
 * 参数对齐官方微信插件（@tencent-weixin/openclaw-weixin）：
 * - 续期间隔：官方 keepaliveIntervalMs=5000 → APP_RULE_TYPING_REFRESH_MS 默认 5000；
 * - typing_ticket 缓存：官方 api/config-cache.js 语义——成功后 24h 内随机刷新
 *   （nextFetchAt = now + Math.random()*24h），失败 2s 起指数退避（x2，最大 1h）；
 *   缓存可为空 ticket（空 ticket 时静默跳过 sendtyping，等同官方 hasTypingTicket=false）；
 * - 请求超时：官方 getConfig/sendTyping 默认 10s；此处为**避免拖慢规则执行**保留 3s 安全上限（有意差异）。
 *
 * 本实现额外保留（官方无此概念，为满足“所有规则命中都显示”需求）：
 * - 最小可见时长 minVisibleMs（默认 500ms）：首次 status=1 成功后引用归零且可见不足时延迟 status=2；
 * - 按用户引用计数：同一用户并发多条规则时只在最后一个结束时取消一次。
 *
 * 所有错误只 log.debug，绝不抛出、不阻塞规则执行；日志不记录 token/ticket；
 * 依赖可注入（configureTypingDependencies / resetTypingDependencies），便于单测替换网络/时钟。
 */
import { config } from './config.js';
import { getUserRow, getUserSecrets } from './data/users.js';
import { getConfig as ilinkGetConfig, sendTyping as ilinkSendTyping } from './ilink.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'typing' });

/** typing_ticket 缓存 TTL：24 小时内随机刷新（对齐官方 CONFIG_CACHE_TTL_MS）。 */
const TICKET_TTL_MS = 24 * 60 * 60 * 1000;
/** 失败重试初始间隔 2s、指数翻倍、最大 1h（对齐官方 CONFIG_CACHE_INITIAL_RETRY_MS / MAX_RETRY_MS）。 */
const CONFIG_RETRY_INITIAL_MS = 2000;
const CONFIG_RETRY_MAX_MS = 60 * 60 * 1000;
/** getconfig/sendtyping 的单次超时上限：官方 10s，这里为不拖慢规则改为 3s（有意差异）。 */
const TYPING_REQUEST_TIMEOUT_CAP_MS = 3000;
/** 「正在输入」默认最小可见时长（毫秒）：避免直接回复规则一闪而过；测试可注入 0。 */
const DEFAULT_MIN_VISIBLE_MS = 500;

const defaultDependencies = {
  getConfig: ilinkGetConfig,
  sendTyping: ilinkSendTyping,
  minVisibleMs: DEFAULT_MIN_VISIBLE_MS,
  /** 可注入时钟（缓存/退避判定用）；默认 Date.now。 */
  now: () => Date.now(),
};
let dependencies = { ...defaultDependencies };

/**
 * userId -> {userId, wechatUserId, baseUrl, token, contextToken, count, timer, ticket, stopped,
 *            cacheKey, startedAt, minVisibleMs, cancelTimer}
 * count=0 且存在 cancelTimer 表示「最小可见时长等待取消中」，期间新 begin 会复用该会话。
 */
const sessions = new Map();
/**
 * `${userId}|${baseUrl}` -> {ticket, everSucceeded, nextFetchAt, retryDelayMs}
 * 对齐官方 WeixinConfigManager：到达 nextFetchAt 才重新 getconfig；失败按指数退避。
 */
const ticketCache = new Map();

/**
 * 注入测试依赖（可覆盖 getConfig/sendTyping/minVisibleMs/now；minVisibleMs 默认 500）。
 * @param {{getConfig?:Function, sendTyping?:Function, minVisibleMs?:number, now?:Function}} [overrides]
 */
export function configureTypingDependencies(overrides = {}) {
  dependencies = { ...defaultDependencies, ...(overrides ?? {}) };
}

/** 恢复默认真实 iLink 依赖。 */
export function resetTypingDependencies() {
  dependencies = { ...defaultDependencies };
}

/** 清空内存会话、待取消定时器与 ticket 缓存（测试辅助；生产无调用方）。 */
export function clearTypingState() {
  for (const session of sessions.values()) {
    if (session.timer) clearInterval(session.timer);
    if (session.cancelTimer) clearTimeout(session.cancelTimer);
    session.timer = null;
    session.cancelTimer = null;
    session.stopped = true;
  }
  sessions.clear();
  ticketCache.clear();
}

function debug(message, extra = {}) {
  try {
    log.debug(message, extra);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function nowMs() {
  try {
    const value = Number(dependencies.now());
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function ticketCacheKey(userId, baseUrl) {
  return `${userId}|${baseUrl}`;
}

function typingTimeoutMs() {
  const base = Number(config.ilink.requestTimeoutMs) || 15000;
  return Math.max(100, Math.min(TYPING_REQUEST_TIMEOUT_CAP_MS, base));
}

function sessionMinVisibleMs() {
  const value = Number(dependencies.minVisibleMs);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_VISIBLE_MS;
}

/**
 * 获取会话的 typing_ticket（对齐官方 config-cache 语义）：
 * - 未到 nextFetchAt：直接返回缓存 ticket（可为空字符串）；
 * - 到达 nextFetchAt：重新 getconfig；成功（ret===0）保存 ticket（可为空）并 24h 随机刷新；
 *   失败：保留旧 ticket，按指数退避（2s 起，x2，最大 1h）安排下次重试；无缓存时创建空 ticket 条目（2s 后重试）。
 * 失败不抛错（返回可能为空的旧 ticket）。
 */
async function resolveTicket(session) {
  const key = session.cacheKey;
  const now = nowMs();
  const cached = ticketCache.get(key);
  if (cached && now < Number(cached.nextFetchAt ?? 0)) {
    return String(cached.ticket ?? '');
  }

  let fetchOk = false;
  try {
    const resp = await dependencies.getConfig({
      baseUrl: session.baseUrl,
      token: session.token,
      ilinkUserId: session.wechatUserId,
      contextToken: session.contextToken,
      timeoutMs: typingTimeoutMs(),
    });
    if (Number(resp?.ret) === 0) {
      const ticket = String(resp?.typing_ticket ?? '');
      ticketCache.set(key, {
        ticket,
        everSucceeded: true,
        nextFetchAt: now + Math.random() * TICKET_TTL_MS,
        retryDelayMs: CONFIG_RETRY_INITIAL_MS,
      });
      fetchOk = true;
      debug('typing_ticket 已获取/刷新', { userId: session.userId, hasTicket: ticket !== '' });
      return ticket;
    }
  } catch (err) {
    debug('获取 typing_ticket 失败（忽略，不影响规则）', { userId: session.userId, message: err?.message });
  }

  if (!fetchOk) {
    // 失败退避：官方逻辑——已有条目按上次 retryDelayMs*2（最大 1h）重试；首次失败 2s 后重试。
    const previous = ticketCache.get(key) ?? cached;
    const prevDelay = Number(previous?.retryDelayMs) || CONFIG_RETRY_INITIAL_MS;
    const nextDelay = Math.min(prevDelay * 2, CONFIG_RETRY_MAX_MS);
    if (previous) {
      previous.nextFetchAt = now + nextDelay;
      previous.retryDelayMs = nextDelay;
      ticketCache.set(key, previous);
    } else {
      ticketCache.set(key, {
        ticket: '',
        everSucceeded: false,
        nextFetchAt: now + CONFIG_RETRY_INITIAL_MS,
        retryDelayMs: CONFIG_RETRY_INITIAL_MS,
      });
    }
    debug('typing_ticket 获取失败，已安排退避重试', { userId: session.userId, nextDelayMs: nextDelay });
  }
  return String((ticketCache.get(key) ?? cached)?.ticket ?? '');
}

/** 发送一次状态（1=正在输入 / 2=取消）；无 ticket（含缓存空 ticket）时跳过。 */
async function sendStatus(session, status) {
  const ticket = String(session.ticket ?? '');
  if (!ticket) return false;
  await dependencies.sendTyping({
    baseUrl: session.baseUrl,
    token: session.token,
    ilinkUserId: session.wechatUserId,
    typingTicket: ticket,
    status,
    timeoutMs: typingTimeoutMs(),
  });
  return true;
}

/** 启动刷新定时器（官方 5000ms 续期；会话已结束/被替换时跳过）。 */
function startRefreshTimer(session) {
  if (session.timer || session.stopped) return;
  const refreshMs = Math.max(10, Number(config.appRules.typingRefreshMs) || 5000);
  session.timer = setInterval(() => {
    void refreshSession(session);
  }, refreshMs);
  session.timer.unref?.();
}

/** 定时刷新：重发 status=1（会话已结束时跳过）。 */
async function refreshSession(session) {
  if (session.stopped || sessions.get(session.userId) !== session) return;
  try {
    await sendStatus(session, 1);
  } catch (err) {
    debug('刷新「正在输入」失败（忽略）', { userId: session.userId, message: err?.message });
  }
}

/** 发送取消（best-effort）：发送 status=2。 */
async function cancelSession(session) {
  try {
    await sendStatus(session, 2);
  } catch (err) {
    debug('取消「正在输入」失败（忽略）', { userId: session.userId, message: err?.message });
  }
}

/** 首次启动会话：取 ticket → sendtyping(1) → 记录 startedAt → 启动刷新定时器。 */
async function startSession(session) {
  if (session.stopped) return;
  try {
    session.ticket = String((await resolveTicket(session)) ?? '');
  } catch (err) {
    debug('获取 typing_ticket 失败（忽略，不影响规则）', { userId: session.userId, message: err?.message });
  }
  if (session.stopped) return;
  if (!session.ticket) return; // 空 ticket（未取到/官方缓存允许空）→ 静默跳过 sendtyping
  try {
    await sendStatus(session, 1);
    // 首次 status=1 成功后才开始计算「可见时长」（失败/空 ticket 不需要延迟取消）
    if (!session.startedAt) session.startedAt = Date.now();
  } catch (err) {
    debug('发送「正在输入」失败（忽略）', { userId: session.userId, message: err?.message });
  }
  if (session.stopped || sessions.get(session.userId) !== session) return;
  startRefreshTimer(session);
}

/**
 * 开始显示「正在输入」（引用计数 +1）。
 * 开关关闭 / 用户无 token / 无 wechatUserId / 任何异常 → 返回 null（静默，不影响规则）。
 * @param {object} user 用户视图（需含 id、wechatUserId；baseUrl 可选）或任意 user-like 对象
 * @returns {Promise<{userId:string}|null>} handle（传给 endTyping；null 表示未开始）
 */
export async function beginTyping(user) {
  try {
    if (!config.appRules.typingIndicator) return null;
    const userId = String(user?.id ?? '');
    const wechatUserId = String(user?.wechatUserId ?? '');
    if (!userId || !wechatUserId) return null;

    let row = null;
    let secrets = null;
    try {
      row = getUserRow(userId);
      secrets = getUserSecrets(userId);
    } catch {
      return null;
    }
    const token = String(secrets?.token ?? '');
    if (!token) return null;

    const existing = sessions.get(userId);
    if (existing) {
      // 等待取消期间再次开始：清除待取消定时器并复用会话（不会重复 status=1）
      if (existing.cancelTimer) {
        clearTimeout(existing.cancelTimer);
        existing.cancelTimer = null;
      }
      existing.count += 1;
      existing.stopped = false;
      startRefreshTimer(existing);
      return { userId };
    }

    const baseUrl = String(user?.baseUrl || row?.base_url || config.ilink.defaultBaseUrl);
    const session = {
      userId,
      wechatUserId,
      baseUrl,
      token,
      contextToken: String(secrets?.contextToken ?? ''),
      count: 1,
      timer: null,
      ticket: '',
      stopped: false,
      cacheKey: ticketCacheKey(userId, baseUrl),
      startedAt: 0,
      minVisibleMs: sessionMinVisibleMs(),
      cancelTimer: null,
    };
    sessions.set(userId, session);
    await startSession(session);
    return { userId };
  } catch (err) {
    debug('开始「正在输入」失败（忽略）', { message: err?.message });
    return null;
  }
}

/**
 * 结束「正在输入」（引用计数 -1）。
 * - 仍有余量：不做任何请求；
 * - 归零：清除刷新定时器；若已可见时长不足 minVisibleMs，则延迟 setTimeout 后再 status=2
 *   （不阻塞调用方；等待期间新 begin 会复用会话并清除定时器）；
 * - 未知/重复 handle 安全，best-effort 不抛错。
 * @param {{userId:string}|null|undefined} handle beginTyping 返回值
 */
export async function endTyping(handle) {
  try {
    const userId = String(handle?.userId ?? '');
    if (!userId) return;
    const session = sessions.get(userId);
    if (!session || session.count <= 0) return;
    session.count -= 1;
    if (session.count > 0) return;

    if (session.timer) {
      clearInterval(session.timer);
      session.timer = null;
    }
    const minVisibleMs = Math.max(0, Number(session.minVisibleMs) || 0);
    const visibleMs = session.startedAt ? Date.now() - session.startedAt : 0;
    if (!session.startedAt || visibleMs >= minVisibleMs) {
      sessions.delete(userId);
      session.stopped = true;
      await cancelSession(session);
      return;
    }

    // 可见时长不足：延迟取消，期间会话保留（count=0），新 begin 复用并清除待取消定时器。
    const delayMs = Math.max(1, minVisibleMs - visibleMs);
    session.cancelTimer = setTimeout(() => {
      session.cancelTimer = null;
      if (sessions.get(userId) !== session || session.count > 0) return;
      sessions.delete(userId);
      session.stopped = true;
      void cancelSession(session);
    }, delayMs);
    session.cancelTimer.unref?.();
  } catch (err) {
    debug('结束「正在输入」失败（忽略）', { message: err?.message });
  }
}
