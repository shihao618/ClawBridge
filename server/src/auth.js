/**
 * 鉴权与安全中间件。
 *
 * - 管理后台：密码登录 → HMAC 签名的 HttpOnly Cookie `cb_session`（12h）；
 *   所有写接口额外校验 `X-Requested-With: ClawBridge-Admin`（防 CSRF）；
 *   登录失败按 IP 滑动窗口限流（10 次 / 15 分钟）。
 * - 对外推送 API：Authorization: Bearer 或 X-Api-Key；crypto.timingSafeEqualStr 常量时间比对；
 *   按 Key 限流（默认 60 次/分钟）；API_TOKEN=off 时接口整体禁用。
 * - 绑定页：按 IP 的创建会话限流（由 binding.js 使用 SlidingWindowLimiter）。
 */
import { config } from './config.js';
import { hashToken, signAdminSession, timingSafeEqualStr, verifyAdminSession, verifyPassword } from './crypto.js';
import { forbidden, notFound, rateLimited, unauthorized } from './errors.js';
import { logger } from './logger.js';
import { SlidingWindowLimiter } from './rate-limiter.js';
import { getAdminPasswordHashRecord } from './settings.js';

const log = logger.child({ mod: 'auth' });

/** 管理写接口必须携带的防 CSRF 请求头。 */
export const ADMIN_WRITE_HEADER = 'X-Requested-With';
export const ADMIN_WRITE_VALUE = 'ClawBridge-Admin';

/** 登录失败限流：10 次 / 15 分钟 / IP（内存态）。 */
export const loginLimiter = new SlidingWindowLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
/** 推送 API 限流：默认 60 次 / 分钟 / Key。 */
export const apiKeyLimiter = new SlidingWindowLimiter({
  limit: Math.max(1, config.push.apiRateLimitPerMinute),
  windowMs: 60 * 1000,
});

/** 获取客户端 IP（尊重 trust proxy 配置）。 */
export function getClientIp(req) {
  return req?.ip || req?.socket?.remoteAddress || 'unknown';
}

/** 解析 Cookie 请求头为对象（不引入 cookie-parser）。 */
export function parseCookies(cookieHeader) {
  const result = Object.create(null);
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return result;
  for (const pair of cookieHeader.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const name = pair.slice(0, index).trim();
    if (!name) continue;
    let value = pair.slice(index + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* 保留原值 */
    }
    result[name] = value;
  }
  return result;
}

/** 读取指定 Cookie。 */
export function readCookie(req, name = config.session.cookieName) {
  const header = req?.headers?.cookie;
  if (!header) return null;
  return parseCookies(header)[name] ?? null;
}

/**
 * 校验管理员密码：只校验 DB scrypt 哈希（无记录返回 false）。
 * env/自动生成密码不再作为回退（机密仅由 DB load/bootstrap/rotate 管理）。
 */
export function verifyAdminPassword(password) {
  if (typeof password !== 'string' || password.length === 0) return false;
  const hashRecord = getAdminPasswordHashRecord();
  if (!hashRecord) return false;
  return verifyPassword(password, hashRecord);
}

/** 登录限流检查（命中一次），超限抛 429。 */
export function checkLoginRateLimit(ip) {
  const result = loginLimiter.hit(String(ip ?? 'unknown'));
  if (!result.allowed) {
    log.warn('登录尝试过于频繁', { ip });
    throw rateLimited(`登录尝试过于频繁，请 ${Math.ceil(result.retryAfterMs / 1000)} 秒后重试`);
  }
  return result;
}

/** 读取并校验管理会话（无效返回 null）。 */
export function getAdminSession(req) {
  const value = readCookie(req);
  if (!value) return null;
  return verifyAdminSession(value);
}

/** 生成并下发管理会话 Cookie。 */
export function setAdminSessionCookie(res) {
  const value = signAdminSession({ ttlMs: config.session.ttlMs });
  const payload = verifyAdminSession(value);
  res.cookie(config.session.cookieName, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(config.session.cookieSecure),
    path: '/',
    maxAge: config.session.ttlMs,
  });
  return payload;
}

/** 清除管理会话 Cookie。 */
export function clearAdminSessionCookie(res) {
  res.clearCookie(config.session.cookieName, {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(config.session.cookieSecure),
    path: '/',
  });
}

/** 中间件：要求已登录管理后台，失败 401。 */
export function requireAdmin(req, res, next) {
  try {
    const session = getAdminSession(req);
    if (!session) throw unauthorized('请先登录管理后台');
    req.adminSession = session;
    next();
  } catch (err) {
    next(err);
  }
}

/** 中间件：仅校验防 CSRF 写请求头（logout 等无需登录的写接口使用）。 */
export function requireWriteHeader(req, res, next) {
  if (req.get(ADMIN_WRITE_HEADER) !== ADMIN_WRITE_VALUE) {
    next(forbidden(`缺少 ${ADMIN_WRITE_HEADER}: ${ADMIN_WRITE_VALUE} 请求头`));
    return;
  }
  next();
}

/** 中间件：管理写接口 = 已登录 + 防 CSRF 头。 */
export function requireAdminWrite(req, res, next) {
  requireAdmin(req, res, (err) => {
    if (err) {
      next(err);
      return;
    }
    requireWriteHeader(req, res, next);
  });
}

/** 从 Authorization: Bearer 或 X-Api-Key 提取 API Key。 */
export function extractApiKey(req) {
  const authorization = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (match) return match[1].trim();
  const headerKey = req.get('x-api-key');
  if (typeof headerKey === 'string' && headerKey.trim() !== '') return headerKey.trim();
  return '';
}

/** 常量时间校验 API Key。 */
export function isApiKeyValid(token) {
  if (typeof token !== 'string' || token === '') return false;
  return timingSafeEqualStr(token, config.secrets.apiToken);
}

/** 中间件：推送 API Key 鉴权 + 按 Key 限流。API_TOKEN=off 时视为接口不存在。 */
export function requireApiKey(req, res, next) {
  try {
    if (!config.pushApiEnabled) throw notFound('推送 API 已禁用（API_TOKEN=off）');
    const token = extractApiKey(req);
    if (!isApiKeyValid(token)) throw unauthorized('API Key 无效；请使用 Authorization: Bearer <API_TOKEN> 或 X-Api-Key');
    const keyId = hashToken(token);
    const limit = apiKeyLimiter.hit(keyId);
    if (!limit.allowed) {
      throw rateLimited(`API 调用过于频繁，请 ${Math.ceil(limit.retryAfterMs / 1000)} 秒后重试`);
    }
    req.apiKeyId = keyId;
    next();
  } catch (err) {
    next(err);
  }
}

/** 登录成功/失败事件记录辅助（不记录任何密码）。 */
export function recordLoginEvent(store, { success, ip }) {
  try {
    store.addEvent({ type: 'login', detail: `${success ? '成功' : '失败'} ip=${ip ?? 'unknown'}` });
  } catch (err) {
    log.debug('写入登录事件失败', { message: err.message });
  }
}
