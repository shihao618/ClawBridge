/**
 * HTTP 中间件：安全响应头、API 不缓存、JSON/原始二进制 body 解析、404 与统一错误处理。
 *
 * 从 api.js 等价迁出（纯搬迁，行为不变）；由 createApp() 按原顺序装配。
 */
import express from 'express';

import { config } from '../config.js';
import { AppError, ErrorCodes, ILinkError, toErrorResponse } from '../errors.js';
import { logger, redactUrlQueryForLog } from '../logger.js';

import { MEDIA_ADMIN_PREFIX, MEDIA_V1_PREFIX } from './helpers.js';

const log = logger.child({ mod: 'api' });

/** docs/ARCHITECTURE.md §8 规定的安全响应头（media-src 供后台 <video> 同源播放）。 */
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
});

/** 所有响应（含静态资源）加安全响应头。 */
export function securityHeaders(req, res, next) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
  next();
}

/** API 响应不缓存。 */
export function noStoreApi(req, res, next) {
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * JSON body 解析：上限 64KB。
 * 媒体上传路由必须由后面的 express.raw 读取原始字节，不能让全局 JSON parser 抢先消费
 * （否则上传 Content-Type: application/json 的 .json 文件时会导致 req.body 变成对象而 400）。
 */
export function createJsonBodyParser() {
  const jsonBodyParser = express.json({ limit: '64kb' });
  return (req, res, next) => {
    if (req.method === 'POST' && (req.path === MEDIA_ADMIN_PREFIX || req.path === MEDIA_V1_PREFIX)) {
      next();
      return;
    }
    jsonBodyParser(req, res, next);
  };
}

/**
 * 媒体上传原始二进制解析器。
 *
 * 必须在运行配置覆盖加载后创建（createApp 由 index 在 loadOverrides 后调用），
 * 否则 media.maxBytes 的 restartRequired 设置即使重启也不会生效。
 */
export function createRawMediaBodyParser() {
  return express.raw({ type: () => true, limit: config.media.outboundMaxBytes });
}

/** 未匹配任何路由：统一 JSON 404。 */
export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: ErrorCodes.NOT_FOUND, message: '接口或页面不存在' } });
}

/** 统一错误处理（必须是最后一个注册的中间件）。 */
 
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  let response;
  const isMediaUploadPath = req.path === MEDIA_ADMIN_PREFIX || req.path === MEDIA_V1_PREFIX;
  if (err?.type === 'entity.too.large') {
    response = isMediaUploadPath
      ? {
          status: 413,
          body: {
            error: {
              code: ErrorCodes.BAD_REQUEST,
              message: `媒体文件超过大小上限（${config.media.outboundMaxBytes} 字节）`,
            },
          },
        }
      : { status: 400, body: { error: { code: ErrorCodes.BAD_REQUEST, message: '请求体超过 64KB 上限' } } };
  } else if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && err?.status === 400)) {
    response = { status: 400, body: { error: { code: ErrorCodes.BAD_REQUEST, message: '请求体不是合法的 JSON' } } };
  } else if (err instanceof AppError) {
    response = toErrorResponse(err);
  } else {
    response = toErrorResponse(err);
  }
  // path 可能带 ?token= 等凭据（如 Webhook 兼容用法）：写日志前统一脱敏敏感 query 参数值。
  const requestInfo = {
    method: req.method,
    path: redactUrlQueryForLog(req.originalUrl),
    status: response.status,
    message: err?.message,
  };
  if (err instanceof ILinkError) {
    // 上游微信接口错误：记录错误码但不打印堆栈（属预期失败）
    log.warn('上游微信接口调用失败', {
      ...requestInfo,
      iLink: { ret: err.ret, httpStatus: err.httpStatus, timeout: err.timeout, errmsg: err.errmsg },
    });
  } else if (err instanceof AppError) {
    // 业务错误：5xx 用 warn，4xx 用 debug，均不打印堆栈
    if (response.status >= 500) log.warn('请求处理失败（业务错误）', requestInfo);
    else log.debug('请求被拒绝', requestInfo);
  } else {
    log.error('请求处理失败（未预期异常）', { ...requestInfo, stack: err?.stack });
  }
  res.status(response.status).json(response.body);
}
