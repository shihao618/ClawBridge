/**
 * HTTP 纯工具函数：请求体/文本/分页校验、Token 展示、健康检查、静态页发送、睡眠。
 *
 * 从 api.js 等价迁出（纯搬迁，行为不变）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { ROOT_DIR, config } from '../config.js';
import { ErrorCodes, badRequest } from '../errors.js';

/** 管理端 / 对外 API 的媒体读取 URL 前缀。 */
export const MEDIA_ADMIN_PREFIX = '/api/admin/media';
export const MEDIA_V1_PREFIX = '/api/v1/media';

/** web/ 静态页面与前端资源目录。 */
export const WEB_DIR = path.join(ROOT_DIR, 'web');

/** 校验并返回 JSON 对象请求体。 */
export function requireJsonBody(req) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('请求体必须是 JSON 对象');
  }
  return body;
}

/** 校验文本：非空字符串且不超过 MAX_TEXT_LENGTH（按 String.length）。 */
export function parseText(value) {
  if (typeof value !== 'string') throw badRequest('text 必须是字符串');
  const text = value.trim();
  if (text === '') throw badRequest('text 不能为空');
  if (text.length > config.push.maxTextLength) {
    throw badRequest(`text 不能超过 ${config.push.maxTextLength} 个字符`);
  }
  return text;
}

/** 可选文本（媒体消息的 caption）：允许缺省/空串；超长仍拒绝。 */
export function parseOptionalText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest('text 必须是字符串');
  const text = value.trim();
  if (text.length > config.push.maxTextLength) {
    throw badRequest(`text 不能超过 ${config.push.maxTextLength} 个字符`);
  }
  return text;
}

/** 解析分页 limit。 */
export function parseLimit(value, fallback = 50, max = 200) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), max);
}

/** 解析分页 offset。 */
export function parseOffset(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** 脱敏展示 API Token：仅前 4 + 后 4。 */
export function previewToken(token) {
  if (typeof token !== 'string' || token.length === 0) return '';
  if (token.length <= 8) return '••••';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/** 健康检查响应体。 */
export function healthPayload() {
  return { status: 'ok', version: config.version, uptimeMs: Math.round(process.uptime() * 1000) };
}

/** 发送 web/ 下的静态页面；文件不存在时返回 JSON 404（便于前端未就绪时排错）。 */
export function sendPage(res, filename, next) {
  const filePath = path.join(WEB_DIR, filename);
  fs.access(filePath, fs.constants.R_OK, (err) => {
    if (err) {
      res.status(404).json({ error: { code: ErrorCodes.NOT_FOUND, message: '页面尚未部署' } });
      return;
    }
    // 页面入口禁止缓存，避免升级后仍加载旧版 admin.js/style.css。
    res.sendFile(
      filePath,
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache', Expires: '0' } },
      (sendErr) => {
        if (sendErr) next(sendErr);
      },
    );
  });
}

export function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
