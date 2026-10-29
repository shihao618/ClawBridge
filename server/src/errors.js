/**
 * 统一错误类型与错误码。
 */
export const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
  UNAVAILABLE: 'UNAVAILABLE',
};

/** 业务/HTTP 层错误：可安全返回给客户端。 */
export class AppError extends Error {
  constructor(code, message, { status = 400, details, cause } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const badRequest = (message, details) => new AppError(ErrorCodes.BAD_REQUEST, message, { status: 400, details });
export const unauthorized = (message = '未认证') => new AppError(ErrorCodes.UNAUTHORIZED, message, { status: 401 });
export const forbidden = (message = '无权限') => new AppError(ErrorCodes.FORBIDDEN, message, { status: 403 });
export const notFound = (message = '资源不存在') => new AppError(ErrorCodes.NOT_FOUND, message, { status: 404 });
export const conflict = (message, details) => new AppError(ErrorCodes.CONFLICT, message, { status: 409, details });
export const rateLimited = (message = '请求过于频繁') => new AppError(ErrorCodes.RATE_LIMITED, message, { status: 429 });
export const unavailable = (message = '服务暂不可用') => new AppError(ErrorCodes.UNAVAILABLE, message, { status: 503 });

/**
 * iLink（微信 ClawBot API）调用错误。
 *
 * - ret / errmsg：微信业务错误码（ret != 0，例如 -2 限流、-14 token 失效）
 * - httpStatus：HTTP 层错误码
 * - timeout / aborted：客户端超时或主动中止（长轮询属正常控制流）
 */
export class ILinkError extends Error {
  constructor(message, { endpoint = '', httpStatus = null, ret = null, errmsg = '', body = '', cause = null, timeout = false, aborted = false } = {}) {
    super(message);
    this.name = 'ILinkError';
    this.endpoint = endpoint;
    this.httpStatus = httpStatus;
    this.ret = ret;
    this.errmsg = errmsg;
    this.body = body;
    this.cause = cause;
    this.timeout = timeout;
    this.aborted = aborted;
    this.code = ret !== null ? `ILINK_${ret}` : httpStatus ? `ILINK_HTTP_${httpStatus}` : timeout ? 'ILINK_TIMEOUT' : aborted ? 'ILINK_ABORTED' : 'ILINK_ERROR';
  }
}

/** 微信服务端限流（ret=-2）。 */
export function isRateLimitError(err) {
  return err instanceof ILinkError && err.ret === -2;
}

/** bot_token 失效（ret/errcode=-14），需冷却并重新扫码绑定。 */
export function isStaleTokenError(err) {
  return err instanceof ILinkError && err.ret === -14;
}

export function isTimeoutError(err) {
  return err instanceof ILinkError && (err.timeout === true || err.aborted === true);
}

/** 把任意错误转成可返回给客户端的 { status, body }。 */
export function toErrorResponse(err) {
  if (err instanceof AppError) {
    return { status: err.status, body: err.toJSON() };
  }
  if (err instanceof ILinkError) {
    return {
      status: 502,
      body: { error: { code: 'UPSTREAM_ERROR', message: '微信 ClawBot 接口调用失败', details: err.message } },
    };
  }
  return {
    status: 500,
    body: { error: { code: ErrorCodes.INTERNAL, message: '服务器内部错误' } },
  };
}

export function isAbortError(err) {
  return Boolean(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
}
