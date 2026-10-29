/**
 * 绑定会话（binding.js）—— 内存态扫码绑定状态机。
 *
 * 每个会话对应一个后台 worker：轮询 iLink get_qrcode_status，按
 * docs/PROTOCOL.md §5.2 状态机维护状态；二维码过期自动刷新（≤ BINDING_MAX_REFRESHES 次）；
 * 整体 TTL 默认 10 分钟；confirmed 时按 wechat_user_id upsert 用户（换绑语义：
 * 清旧 bot_token/context_token/pause_until）并启动入站监控。
 *
 * 安全：会话 secret 只在创建响应返回一次，内存只保存 crypto.hashToken(secret)。
 */
import QRCode from 'qrcode';

import { config } from './config.js';
import { hashToken, randomToken, randomUuid, timingSafeEqualStr } from './crypto.js';
import * as dispatcher from './dispatcher.js';
import { AppError, ErrorCodes, badRequest, conflict, notFound, rateLimited, unauthorized, unavailable } from './errors.js';
import * as ilink from './ilink.js';
import { logger } from './logger.js';
import * as monitor from './monitor.js';
import { SlidingWindowLimiter } from './rate-limiter.js';
import * as store from './store.js';

const log = logger.child({ mod: 'binding' });

/** 会话状态（docs/API.md §1.2）。 */
export const BINDING_STATUSES = Object.freeze([
  'waiting',
  'scanned',
  'need_verifycode',
  'refreshing',
  'verify_blocked',
  'confirmed',
  'already_bound',
  'expired',
  'timeout',
  'error',
  'cancelled',
]);

/** 终态：worker 停止，会话保留一段时间供前端查询。 */
const TERMINAL = new Set(['confirmed', 'already_bound', 'expired', 'timeout', 'error', 'cancelled']);

/** 二维码内容的有效期（官方约 5 分钟，且不超过会话总 TTL）。 */
const QR_VALIDITY_MS = Math.min(config.binding.ttlMs, 5 * 60 * 1000);
/** 终态后的保留时长：供前端继续查询结果。 */
const RETENTION_MS = config.binding.ttlMs;

const STATUS_MESSAGES = Object.freeze({
  waiting: '等待微信扫码',
  scanned: '已扫码，请在手机微信中确认',
  need_verifycode: '请输入手机微信上显示的配对数字',
  refreshing: '二维码已过期，正在自动刷新…',
  verify_blocked: '配对码错误次数过多，正在刷新二维码…',
  confirmed: '绑定成功',
  already_bound: '该微信号已绑定过本服务',
  expired: '二维码已失效，请重新生成',
  timeout: '绑定超时，请重新生成二维码',
  error: '绑定失败，请重试',
  cancelled: '已取消绑定',
});

/** @type {Map<string, object>} */
const sessions = new Map();

/** 绑定页创建会话的 IP 限流（默认 20 次/小时）。 */
const ipLimiter = new SlidingWindowLimiter({
  limit: Math.max(1, config.binding.ipLimitPerHour),
  windowMs: 60 * 60 * 1000,
});

let cleanupTimer = null;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

/** 用 qrcode 包把二维码内容渲染为 SVG data URI（前端可直接 <img src>）。 */
async function renderQrSvg(content) {
  const svg = await QRCode.toString(String(content), {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function qrView(session) {
  return { svg: session.qrSvg, content: session.qrContent, expiresAt: session.qrExpiresAt };
}

function currentMessage(session) {
  return session.message || STATUS_MESSAGES[session.status] || '';
}

/** 会话对外视图（不含 token/内部字段）。 */
export function publicSessionView(session) {
  const view = {
    sessionId: session.id,
    status: session.status,
    message: currentMessage(session),
    qr: qrView(session),
    refreshCount: session.refreshCount,
  };
  if (session.userId) {
    const user = store.getUser(session.userId);
    if (user) {
      view.user = {
        id: user.id,
        displayName: user.displayName,
        wechatUserId: user.wechatUserId,
        boundAt: user.boundAt,
      };
    }
  }
  if (session.error) view.error = session.error;
  return view;
}

function countActiveSessions() {
  let count = 0;
  for (const session of sessions.values()) {
    if (!TERMINAL.has(session.status)) count += 1;
  }
  return count;
}

/** 当前活跃（未终态）绑定会话数。 */
export function getActiveSessionCount() {
  return countActiveSessions();
}

/** 会话是否超过保留期（可清理）。 */
function isPastRetention(session, now) {
  const base = Math.max(session.expiresAt, TERMINAL.has(session.status) ? session.updatedAt : 0);
  return now > base + RETENTION_MS;
}

function findSession(sessionId) {
  const session = sessions.get(String(sessionId ?? ''));
  if (!session) return null;
  if (isPastRetention(session, Date.now())) {
    sessions.delete(session.id);
    return null;
  }
  return session;
}

/** 校验会话 secret：仅比对 hashToken(输入) 与保存的哈希（常量时间）。 */
function verifySessionToken(session, token) {
  if (typeof token !== 'string' || token === '') throw unauthorized('缺少会话 token');
  if (!timingSafeEqualStr(hashToken(token), session.tokenHash)) throw unauthorized('会话 token 无效');
}

function mustGetSession(sessionId) {
  const session = findSession(sessionId);
  if (!session) throw notFound('绑定会话不存在或已过期');
  return session;
}

/** 更新状态（自动维护配对码等待计时）。 */
function setStatus(session, status, message) {
  if (session.status !== status) {
    session.status = status;
    session.updatedAt = Date.now();
  }
  if (status === 'need_verifycode') {
    if (!session.verifyNeededAt) session.verifyNeededAt = Date.now();
  } else {
    session.verifyNeededAt = 0;
  }
  if (message) session.message = message;
}

/** 结束会话（进入终态）。 */
function finishSession(session, status, message, error = '') {
  session.status = status;
  session.message = message || STATUS_MESSAGES[status] || '';
  session.error = error;
  session.verifyCode = null;
  session.verifyNeededAt = 0;
  session.updatedAt = Date.now();
  session.done = true;
}

// ---------------------------------------------------------------------------
// 对外 API（供 api.js 调用）
// ---------------------------------------------------------------------------

/**
 * 创建绑定会话并启动后台 worker。
 * @returns {Promise<{sessionId: string, token: string, status: string, displayName: string, qr: object, createdAt: number}>}
 */
export async function createSession({ displayName = '', ip = '' } = {}) {
  let name = '';
  if (displayName !== undefined && displayName !== null && displayName !== '') {
    if (typeof displayName !== 'string') throw badRequest('displayName 必须是字符串');
    name = displayName.trim();
    if (name.length > 40) throw badRequest('displayName 最长 40 个字符');
  }

  if (countActiveSessions() >= config.binding.maxActiveSessions) {
    throw unavailable(`并发绑定会话已达上限（${config.binding.maxActiveSessions}），请稍后重试`);
  }
  const ipLimit = ipLimiter.hit(String(ip || 'unknown'));
  if (!ipLimit.allowed) {
    log.warn('绑定会话创建被 IP 限流', { ip });
    throw rateLimited(`创建绑定会话过于频繁，请 ${Math.ceil(ipLimit.retryAfterMs / 1000)} 秒后重试`);
  }

  let qr;
  try {
    qr = await ilink.getBotQrcode({ localTokenList: store.getRecentBindingTokens(10) });
  } catch (err) {
    log.warn('获取绑定二维码失败', { ip, message: err?.message });
    throw unavailable('无法连接微信 ClawBot API，请稍后重试');
  }

  let qrSvg;
  try {
    qrSvg = await renderQrSvg(qr.qrcode_img_content);
  } catch (err) {
    log.error('二维码渲染失败', { message: err?.message });
    throw new AppError(ErrorCodes.INTERNAL, '二维码生成失败', { status: 500 });
  }

  const now = Date.now();
  const token = randomToken(24);
  const session = {
    id: randomUuid(),
    tokenHash: hashToken(token),
    displayName: name,
    status: 'waiting',
    message: STATUS_MESSAGES.waiting,
    qrcode: qr.qrcode,
    qrContent: qr.qrcode_img_content,
    qrSvg,
    qrExpiresAt: now + QR_VALIDITY_MS,
    refreshCount: 0,
    verifyCode: null,
    verifyNeededAt: 0,
    apiBaseUrl: config.ilink.loginBaseUrl,
    redirectHost: '',
    userId: null,
    error: '',
    networkErrors: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + config.binding.ttlMs,
    lastPollAt: 0,
    ip,
    workerStarted: false,
    done: false,
  };
  sessions.set(session.id, session);
  log.info('绑定会话已创建', { sessionId: session.id, ip, active: countActiveSessions() });

  // worker 异步执行，不阻塞创建请求
  void runWorker(session).catch((err) => {
    log.error('绑定 worker 异常退出', { sessionId: session.id, message: err?.message, stack: err?.stack });
    if (!TERMINAL.has(session.status)) finishSession(session, 'error', '绑定失败，请重试', err?.message ?? 'worker 异常');
  });

  return {
    sessionId: session.id,
    token,
    status: session.status,
    displayName: session.displayName,
    qr: qrView(session),
    createdAt: session.createdAt,
  };
}

/** 查询会话状态（前端 1s 轮询）。 */
export function getSession({ sessionId, token }) {
  const session = mustGetSession(sessionId);
  verifySessionToken(session, token);
  return publicSessionView(session);
}

/** 提交配对数字（仅 need_verifycode 状态允许）。 */
export function submitVerifyCode({ sessionId, token, code }) {
  const session = mustGetSession(sessionId);
  verifySessionToken(session, token);
  if (session.status !== 'need_verifycode') {
    throw conflict('当前状态不需要输入配对码');
  }
  const value = typeof code === 'number' ? String(code) : typeof code === 'string' ? code.trim() : '';
  if (!/^\d{1,12}$/.test(value)) throw badRequest('配对码格式不正确（应为手机微信上显示的数字）');
  session.verifyCode = value;
  session.verifyNeededAt = 0;
  setStatus(session, 'scanned', '配对码已提交，等待手机微信确认');
  return { ok: true };
}

/** 取消绑定（幂等；已终态会话直接返回）。 */
export function cancelSession({ sessionId, token }) {
  const session = mustGetSession(sessionId);
  verifySessionToken(session, token);
  if (!TERMINAL.has(session.status)) {
    finishSession(session, 'cancelled', '已取消绑定');
    log.info('绑定会话已取消', { sessionId: session.id });
  }
  return { ok: true };
}

/** 清理超过保留期的会话（定时器每 60s 调用，也可直接调用）。 */
export function cleanupSessions(now = Date.now()) {
  let removed = 0;
  for (const [id, session] of sessions) {
    if (isPastRetention(session, now)) {
      sessions.delete(id);
      removed += 1;
    }
  }
  return removed;
}

/** 启动会话清理定时器（index.js 调用）。 */
export function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const removed = cleanupSessions();
    if (removed > 0) log.debug('已清理过期绑定会话', { removed, remaining: sessions.size });
  }, 60 * 1000);
  cleanupTimer.unref?.();
}

/** 停止清理定时器。 */
export function stopCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// ---------------------------------------------------------------------------
// worker：查询扫码状态 + 状态机
// ---------------------------------------------------------------------------

/** 重新获取二维码（计入刷新次数；失败则终止会话）。 */
async function refreshQr(session) {
  if (session.refreshCount >= config.binding.maxRefreshes) {
    finishSession(session, 'expired', '二维码刷新次数过多，请重新生成');
    return false;
  }
  session.refreshCount += 1;
  try {
    const qr = await ilink.getBotQrcode({ localTokenList: store.getRecentBindingTokens(10) });
    session.qrcode = qr.qrcode;
    session.qrContent = qr.qrcode_img_content;
    session.qrSvg = await renderQrSvg(qr.qrcode_img_content);
    session.qrExpiresAt = Date.now() + QR_VALIDITY_MS;
    session.apiBaseUrl = config.ilink.loginBaseUrl;
    session.redirectHost = '';
    session.verifyCode = null;
    session.verifyNeededAt = 0;
    session.updatedAt = Date.now();
    log.info('绑定二维码已刷新', { sessionId: session.id, refreshCount: session.refreshCount });
    return true;
  } catch (err) {
    log.warn('刷新绑定二维码失败', { sessionId: session.id, message: err?.message });
    finishSession(session, 'error', '刷新二维码失败，请重试', `刷新二维码失败：${err?.message ?? '未知错误'}`);
    return false;
  }
}

/** 等待配对码期间的短轮询超时：让 worker 能及时拾取用户提交的配对码。 */
function pollTimeoutFor(session) {
  if (session.status === 'need_verifycode' && !session.verifyCode) {
    return Math.min(config.ilink.qrPollTimeoutMs, 3000);
  }
  return config.ilink.qrPollTimeoutMs;
}

/**
 * 计算 IDC 重定向后的轮询基址。
 * 协议上 redirect_host 是纯域名（https）；但当登录基址是 http（mock/demo/自建代理）时，
 * 沿用当前协议，保证 mock 环境也能正常换 IDC。
 */
function buildRedirectBaseUrl(redirectHost, currentBaseUrl) {
  const host = String(redirectHost ?? '').trim().replace(/\/+$/, '');
  if (!host) return currentBaseUrl;
  if (/^https?:\/\//i.test(host)) return host;
  let protocol = 'https:';
  try {
    protocol = new URL(currentBaseUrl || config.ilink.loginBaseUrl).protocol || 'https:';
  } catch {
    protocol = 'https:';
  }
  return `${protocol}//${host}`;
}

/**
 * 处理一次扫码状态响应。
 * @returns {Promise<boolean>} true 表示会话结束，worker 应退出
 */
async function handleStatus(session, resp) {
  const status = String(resp?.status ?? '');
  const now = Date.now();
  switch (status) {
    case 'wait': {
      setStatus(session, 'waiting', STATUS_MESSAGES.waiting);
      return false;
    }
    case 'scaned': {
      setStatus(session, 'scanned', session.verifyCode ? '配对码已通过，请在手机微信中确认' : '已扫码，请在手机微信中确认');
      return false;
    }
    case 'need_verifycode': {
      if (session.verifyCode) {
        // 本次在途轮询未携带用户刚提交的配对码：保持“已提交”状态，
        // 下一次轮询会携带该 code（避免 UI 闪回输入框与竞态丢码）。
        setStatus(session, 'scanned', '配对码已提交，等待手机微信确认');
      } else {
        setStatus(session, 'need_verifycode', STATUS_MESSAGES.need_verifycode);
      }
      return false;
    }
    case 'verify_code_blocked': {
      // 配对码错误次数过多：清空待用配对码并刷新二维码（计入刷新次数）
      session.verifyCode = null;
      setStatus(session, 'verify_blocked', STATUS_MESSAGES.verify_blocked);
      const refreshed = await refreshQr(session);
      if (!refreshed) return true;
      setStatus(session, 'waiting', '配对码错误次数过多，二维码已刷新，请重新扫码');
      return false;
    }
    case 'expired': {
      setStatus(session, 'refreshing', STATUS_MESSAGES.refreshing);
      const refreshed = await refreshQr(session);
      if (!refreshed) return true;
      setStatus(session, 'waiting', '二维码已刷新，请重新扫码');
      return false;
    }
    case 'scaned_but_redirect': {
      const host = typeof resp?.redirect_host === 'string' ? resp.redirect_host.trim() : '';
      if (host) {
        session.redirectHost = host;
        session.apiBaseUrl = buildRedirectBaseUrl(host, session.apiBaseUrl);
        setStatus(session, 'scanned', '已扫码，正在切换接入点，请稍候…');
        log.info('绑定轮询切换 IDC', { sessionId: session.id, host });
      }
      return false;
    }
    case 'binded_redirect': {
      // 已绑定过本客户端的成功语义：尝试匹配已有用户
      let user = null;
      const wechatUserId = resp?.ilink_user_id ? String(resp.ilink_user_id) : '';
      if (wechatUserId) {
        const row = store.getUserRowByWechatId(wechatUserId);
        if (row) user = store.getUser(row.id);
      }
      if (!user && resp?.ilink_bot_id) {
        const row = store.getUserRowByBotId(String(resp.ilink_bot_id));
        if (row) user = store.getUser(row.id);
      }
      if (user) session.userId = user.id;
      finishSession(
        session,
        'already_bound',
        user ? '该微信号已绑定过本服务，可直接使用' : '该微信号已绑定过本服务，请在管理后台查看或联系管理员',
      );
      store.addEvent({ type: 'bind', userId: user?.id ?? null, detail: 'binded_redirect' });
      log.info('绑定返回 binded_redirect', { sessionId: session.id, userId: session.userId });
      return true;
    }
    case 'confirmed': {
      const botToken = typeof resp?.bot_token === 'string' ? resp.bot_token : '';
      const ilinkBotId = resp?.ilink_bot_id ? String(resp.ilink_bot_id) : '';
      const ilinkUserId = resp?.ilink_user_id ? String(resp.ilink_user_id) : '';
      const baseUrl = resp?.baseurl ? String(resp.baseurl) : config.ilink.defaultBaseUrl;
      if (!botToken || !ilinkBotId || !ilinkUserId) {
        finishSession(session, 'error', '绑定失败，请重试', '微信返回的绑定信息不完整（缺少 bot_token / ilink_bot_id / ilink_user_id）');
        store.addEvent({ type: 'bind_error', userId: null, detail: 'confirmed 缺少必要字段' });
        log.warn('confirmed 响应缺少必要字段', { sessionId: session.id });
        return true;
      }
      // 换绑判定：upsert 之前按 wechat_user_id 查已有账号（upsert 会覆盖 token_enc）
      const existing = store.getUserRowByWechatId(ilinkUserId);
      if (existing) {
        // 换绑：必须先停止旧凭据的入站监控（notifyStop 使用仍保存在 DB 的旧 token），
        // 否则旧 worker 会继续轮询旧 bot，且旧 token -14 会误把新绑定用户置为 paused（QA M1）。
        try {
          const stopped = await monitor.stop(existing.id, { notify: true, reason: 'rebind' });
          log.info('换绑：旧入站监控已停止', { sessionId: session.id, userId: existing.id, stopped });
        } catch (err) {
          log.warn('换绑：停止旧监控失败（继续换绑流程）', { userId: existing.id, message: err?.message });
        }
      }
      let result;
      try {
        result = store.upsertBoundUser({
          wechatUserId: ilinkUserId,
          displayName: session.displayName,
          ilinkBotId,
          botToken,
          baseUrl,
        });
      } catch (err) {
        log.error('保存绑定用户失败', { sessionId: session.id, message: err?.message, stack: err?.stack });
        finishSession(session, 'error', '保存绑定信息失败，请重试', `保存绑定信息失败：${err?.message ?? '未知错误'}`);
        return true;
      }
      session.userId = result.user.id;
      finishSession(session, 'confirmed', result.rebound ? '换绑成功' : '绑定成功');
      store.addEvent({
        type: result.created ? 'bind' : 'rebind',
        userId: session.userId,
        detail: `ilink_bot_id=${ilinkBotId}`,
      });
      log.info('微信绑定成功', { sessionId: session.id, userId: session.userId, rebound: result.rebound });
      if (result.rebound) {
        // 换绑后重置该账号发送限流桶（旧 bot 的限流窗口不应影响新账号）
        dispatcher.resetRateLimit(result.user.id);
      }
      // 启动新凭据的入站监控（notifyStart + getupdates）
      monitor.start(session.userId);
      return true;
    }
    default: {
      log.warn('未知的扫码状态，继续轮询', { sessionId: session.id, status });
      session.updatedAt = now;
      return false;
    }
  }
}

/** 会话 worker 主循环。 */
async function runWorker(session) {
  session.workerStarted = true;
  let consecutiveNetworkErrors = 0;

  while (!TERMINAL.has(session.status)) {
    const now = Date.now();
    // 整体 TTL 超时
    if (now >= session.expiresAt) {
      finishSession(session, 'timeout', '绑定超时，请重新生成二维码');
      log.info('绑定会话超时', { sessionId: session.id });
      return;
    }
    // 等待配对码单独超时（2 分钟未提交）
    if (session.status === 'need_verifycode' && session.verifyNeededAt > 0) {
      if (now - session.verifyNeededAt > config.binding.verifyTimeoutMs) {
        finishSession(session, 'timeout', '等待配对码超时，请重新生成二维码');
        return;
      }
    }

    let resp = null;
    // 记录本次轮询实际携带的配对码：只有“确实携带并收到响应”时才允许清空 pending，
    // 避免用户在长轮询在途时刚提交的 code 被本次响应（need_verifycode）误清掉。
    let sentVerifyCode = null;
    try {
      sentVerifyCode = session.verifyCode || null;
      resp = await ilink.getQrcodeStatus({
        qrcode: session.qrcode,
        verifyCode: sentVerifyCode || undefined,
        baseUrl: session.apiBaseUrl,
        timeoutMs: pollTimeoutFor(session),
      });
      consecutiveNetworkErrors = 0;
      session.lastPollAt = Date.now();
    } catch (err) {
      if (TERMINAL.has(session.status)) return;
      if (err?.timeout === true) {
        // 官方语义：客户端长轮询超时属正常控制流，继续轮询（不计入连续网络错误）
        log.debug('扫码状态长轮询超时，继续轮询', { sessionId: session.id });
      } else if (err?.aborted === true) {
        if (TERMINAL.has(session.status)) return;
      } else {
        consecutiveNetworkErrors += 1;
        session.networkErrors = consecutiveNetworkErrors;
        log.warn('扫码状态轮询失败', {
          sessionId: session.id,
          errors: consecutiveNetworkErrors,
          message: err?.message,
        });
        if (consecutiveNetworkErrors >= config.binding.networkErrorLimit) {
          finishSession(session, 'error', '绑定失败，请重试', `网络错误：${err?.message ?? '未知错误'}`);
          return;
        }
        await sleep(Math.min(1000 * consecutiveNetworkErrors, 5000));
        continue;
      }
    }

    // 用户在长轮询在途期间取消绑定/超时（终态）时，请求返回后不得再覆盖终态或继续处理
    if (TERMINAL.has(session.status)) return;

    if (resp) {
      // 配对码一次性使用：仅当本次请求确实携带了该 code 时清空 pending；
      // 否则保留给下一次轮询（用户提交与在途长轮询的竞态修复）。
      // 若在途期间用户又提交了新 code，则保留新值。
      if (sentVerifyCode && session.verifyCode === sentVerifyCode) session.verifyCode = null;
      let stop = false;
      try {
        stop = await handleStatus(session, resp);
      } catch (err) {
        log.error('处理扫码状态失败', { sessionId: session.id, message: err?.message, stack: err?.stack });
        finishSession(session, 'error', '绑定失败，请重试', `处理绑定状态失败：${err?.message ?? '未知错误'}`);
        return;
      }
      if (stop || TERMINAL.has(session.status)) return;
    }

    if (!TERMINAL.has(session.status)) await sleep(config.binding.pollGapMs);
  }
}
