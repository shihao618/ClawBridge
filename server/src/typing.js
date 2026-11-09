/**
 * 微信「正在输入」状态（typing indicator）——规则命中期间显示，best-effort。
 *
 * 协议（docs/PROTOCOL.md §5.6，mock 已实现）：
 *   POST {baseUrl}/ilink/bot/getconfig   body {ilink_user_id, context_token?, base_info} → {ret:0, typing_ticket}
 *   POST {baseUrl}/ilink/bot/sendtyping  body {ilink_user_id, typing_ticket, status:1|2, base_info} → {ret:0}
 *   status：1=正在输入，2=取消。
 *
 * 设计要点（v1.0.3：所有规则命中都显示，含不请求模式直接回复）：
 * - 按用户引用计数：同一用户并发多条规则时，只有最后一个结束时才取消（避免互相打断）；
 * - 最小可见时长：首次 status=1 成功后记录 startedAt，引用归零时若可见时长不足 minVisibleMs，
 *   延迟 setTimeout 再发 status=2（不阻塞规则/回复）；等待取消期间再次 begin 复用会话并清除待取消定时器；
 * - typing_ticket 内存缓存 10 分钟（getconfig 有额外请求成本，过期/失败时按需重取）；
 * - 定时刷新：每 config.appRules.typingRefreshMs 重发 status=1（周期较长时微信侧会消失）；
 * - 全部 best-effort：任何错误只 log.debug，绝不抛出、不阻塞规则执行；日志不记录 token/ticket；
 * - 依赖可注入（configureTypingDependencies / resetTypingDependencies），便于单测用 fake 替换网络层。
 */
import { config } from './config.js';
import { getUserRow, getUserSecrets } from './data/users.js';
import { getConfig as ilinkGetConfig, sendTyping as ilinkSendTyping } from './ilink.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'typing' });

/** typing_ticket 缓存 TTL：10 分钟。 */
const TICKET_TTL_MS = 10 * 60 * 1000;
/** getconfig/sendtyping 的单次超时上限（避免拖慢规则请求）。 */
const TYPING_REQUEST_TIMEOUT_CAP_MS = 3000;
/** 「正在输入」默认最小可见时长（毫秒）：避免直接回复规则一闪而过；测试可注入 0。 */
const DEFAULT_MIN_VISIBLE_MS = 500;

const defaultDependencies = {
  getConfig: ilinkGetConfig,
  sendTyping: ilinkSendTyping,
  minVisibleMs: DEFAULT_MIN_VISIBLE_MS,
};
let dependencies = { ...defaultDependencies };

/**
 * userId -> {userId, wechatUserId, baseUrl, token, contextToken, count, timer, ticket, stopped,
 *            cacheKey, startedAt, minVisibleMs, cancelTimer}
 * count=0 且存在 cancelTimer 表示「最小可见时长等待取消中」，期间新 begin 会复用该会话。
 */
const sessions = new Map();
/** `${userId}|${baseUrl}` -> {ticket, expiresAt} */
const ticketCache = new Map();

/**
 * 注入测试依赖（可覆盖 getConfig/sendTyping/minVisibleMs；minVisibleMs 默认 500）。
 * @param {{getConfig?:Function, sendTyping?:Function, minVisibleMs?:number}} [overrides]
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

function ticketCacheKey(userId, baseUrl) {
  return `${userId}|${baseUrl}`;
}

function getCachedTicket(key) {
  const cached = ticketCache.get(key);
  if (!cached) return '';
  if (Number(cached.expiresAt) <= Date.now()) {
    ticketCache.delete(key);
    return '';
  }
  return String(cached.ticket ?? '');
}

function setCachedTicket(key, ticket) {
  ticketCache.set(key, { ticket: String(ticket), expiresAt: Date.now() + TICKET_TTL_MS });
}

function typingTimeoutMs() {
  const base = Number(config.ilink.requestTimeoutMs) || 15000;
  return Math.max(100, Math.min(TYPING_REQUEST_TIMEOUT_CAP_MS, base));
}

function sessionMinVisibleMs() {
  const value = Number(dependencies.minVisibleMs);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_VISIBLE_MS;
}

/** 获取/刷新会话的 typing_ticket（命中缓存则不请求 getconfig）。 */
async function resolveTicket(session) {
  const cached = getCachedTicket(session.cacheKey);
  if (cached) return cached;
  const resp = await dependencies.getConfig({
    baseUrl: session.baseUrl,
    token: session.token,
    ilinkUserId: session.wechatUserId,
    contextToken: session.contextToken,
    timeoutMs: typingTimeoutMs(),
  });
  const ticket = String(resp?.typing_ticket ?? '');
  if (ticket) setCachedTicket(session.cacheKey, ticket);
  return ticket;
}

/** 发送一次状态（1=正在输入 / 2=取消）；无 ticket 时跳过。 */
async function sendStatus(session, status) {
  const ticket = session.ticket || getCachedTicket(session.cacheKey);
  if (!ticket) return false;
  session.ticket = ticket;
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

/** 启动刷新定时器（重发 status=1；会话已结束/被替换时跳过）。 */
function startRefreshTimer(session) {
  if (session.timer || session.stopped) return;
  const refreshMs = Math.max(10, Number(config.appRules.typingRefreshMs) || 4000);
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

/** 发送取消（best-effort）：清理会话后发送 status=2。 */
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
    session.ticket = await resolveTicket(session);
  } catch (err) {
    debug('获取 typing_ticket 失败（忽略，不影响规则）', { userId: session.userId, message: err?.message });
  }
  if (session.stopped) return;
  if (!session.ticket) return; // 无 ticket 无法显示，静默跳过（不重试，避免拖慢规则）
  try {
    await sendStatus(session, 1);
    // 首次 status=1 成功后才开始计算「可见时长」（失败/无 ticket 不需要延迟取消）
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
