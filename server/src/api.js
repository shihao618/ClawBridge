/**
 * HTTP 层（api.js）：Express 5 应用，提供全部对外接口与静态页面。
 *
 * 契约见 docs/API.md；安全约定见 docs/ARCHITECTURE.md §8：
 * - 统一 JSON 错误格式 { error: { code, message } }，404 也返回 JSON；
 * - 安全响应头（nosniff / DENY / no-referrer / CSP）；
 * - JSON body 上限 64KB；
 * - 管理后台 Cookie 会话 + 写接口 X-Requested-With 防 CSRF；
 * - 推送 API Key 鉴权；绑定会话 secret 只返回一次。
 *
 * Express 5 会自动捕获 async 路由抛出的错误并交给错误中间件。
 */
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { ROOT_DIR, config } from './config.js';
import { AppError, ErrorCodes, ILinkError, badRequest, conflict, notFound, toErrorResponse } from './errors.js';
import { logger } from './logger.js';
import * as appRules from './app-rules.js';
import * as auth from './auth.js';
import * as binding from './binding.js';
import { encryptSecret } from './crypto.js';
import * as media from './media.js';
import * as monitor from './monitor.js';
import * as scheduler from './scheduler.js';
import * as settings from './settings.js';
import * as store from './store.js';

const log = logger.child({ mod: 'api' });

const WEB_DIR = path.join(ROOT_DIR, 'web');

/** 管理端 / 对外 API 的媒体读取 URL 前缀。 */
const MEDIA_ADMIN_PREFIX = '/api/admin/media';
const MEDIA_V1_PREFIX = '/api/v1/media';
/** 媒体上传：原始二进制解析器（限制 MEDIA_MAX_BYTES）。 */
const parseRawMediaBody = express.raw({ type: () => true, limit: config.media.outboundMaxBytes });

/** docs/ARCHITECTURE.md §8 规定的安全响应头（media-src 供后台 <video> 同源播放）。 */
const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
});

const USER_STATUSES = new Set(['active', 'unbound', 'paused', 'all']);
const MESSAGE_DIRECTIONS = new Set(['inbound', 'outbound', 'all']);
const MESSAGE_STATUSES = new Set(['queued', 'sending', 'sent', 'failed', 'received']);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 校验并返回 JSON 对象请求体。 */
function requireJsonBody(req) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('请求体必须是 JSON 对象');
  }
  return body;
}

/** 校验文本：非空字符串且不超过 MAX_TEXT_LENGTH（按 String.length）。 */
function parseText(value) {
  if (typeof value !== 'string') throw badRequest('text 必须是字符串');
  const text = value.trim();
  if (text === '') throw badRequest('text 不能为空');
  if (text.length > config.push.maxTextLength) {
    throw badRequest(`text 不能超过 ${config.push.maxTextLength} 个字符`);
  }
  return text;
}

/** 可选文本（媒体消息的 caption）：允许缺省/空串；超长仍拒绝。 */
function parseOptionalText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest('text 必须是字符串');
  const text = value.trim();
  if (text.length > config.push.maxTextLength) {
    throw badRequest(`text 不能超过 ${config.push.maxTextLength} 个字符`);
  }
  return text;
}

/** 解析分页 limit。 */
function parseLimit(value, fallback = 50, max = 200) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), max);
}

/** 解析分页 offset。 */
function parseOffset(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** 脱敏展示 API Token：仅前 4 + 后 4。 */
function previewToken(token) {
  if (typeof token !== 'string' || token.length === 0) return '';
  if (token.length <= 8) return '••••';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/** 健康检查响应体。 */
function healthPayload() {
  return { status: 'ok', version: config.version, uptimeMs: Math.round(process.uptime() * 1000) };
}

/** 发送 web/ 下的静态页面；文件不存在时返回 JSON 404（便于前端未就绪时排错）。 */
function sendPage(res, filename, next) {
  const filePath = path.join(WEB_DIR, filename);
  fs.access(filePath, fs.constants.R_OK, (err) => {
    if (err) {
      res.status(404).json({ error: { code: ErrorCodes.NOT_FOUND, message: '页面尚未部署' } });
      return;
    }
    res.sendFile(filePath, (sendErr) => {
      if (sendErr) next(sendErr);
    });
  });
}

/** 用户对外视图转为管理后台列表字段（与 store.mapUserRow 一致，避免泄露额外字段）。 */
function userView(user) {
  return {
    id: user.id,
    displayName: user.displayName,
    wechatUserId: user.wechatUserId,
    ilinkBotId: user.ilinkBotId,
    status: user.status,
    boundAt: user.boundAt,
    updatedAt: user.updatedAt,
    lastInboundAt: user.lastInboundAt,
    lastOutboundAt: user.lastOutboundAt,
    hasContextToken: user.hasContextToken,
    queuedCount: user.queuedCount,
    sentCount: user.sentCount,
    failedCount: user.failedCount,
    pauseUntil: user.pauseUntil,
    note: user.note,
    groups: Array.isArray(user.groups) ? user.groups : [],
    keepaliveEnabled: Boolean(user.keepaliveEnabled),
    keepaliveLastSentAt: user.keepaliveLastSentAt ?? 0,
  };
}

/** 入队响应项（admin 与 v1 契约一致：{ outboxId, userId, status }；有媒体时附 media 摘要）。 */
function queuedItem(row, { attachment = null, urlPrefix = MEDIA_ADMIN_PREFIX } = {}) {
  const item = { outboxId: row.id, userId: row.userId ?? row.user_id ?? '', status: row.status };
  if (attachment) item.media = mediaQueuedView(attachment, urlPrefix);
  return item;
}

/** 上传响应中的 media 视图（docs/MEDIA.md §5.1）。 */
function mediaUploadView(attachment, urlPrefix = MEDIA_ADMIN_PREFIX) {
  const view = store.mapAttachmentRow(attachment, { urlPrefix });
  return {
    id: view.id,
    kind: view.kind,
    mime: view.mime,
    fileName: view.fileName,
    size: view.size,
    url: view.url,
    downloadUrl: view.downloadUrl,
    status: view.status,
  };
}

/** queued 项中的 media 摘要（docs/MEDIA.md §5.2）。 */
function mediaQueuedView(attachment, urlPrefix = MEDIA_ADMIN_PREFIX) {
  const view = store.mapAttachmentRow(attachment, { urlPrefix });
  return { id: view.id, kind: view.kind, fileName: view.fileName, size: view.size, url: view.url };
}

/** 校验出站媒体附件（必须存在、outbound、ready；语音出站不支持）。 */
function resolveOutboundAttachment(mediaId) {
  if (mediaId === undefined || mediaId === null || mediaId === '') return null;
  if (typeof mediaId !== 'string') throw badRequest('mediaId 必须是字符串');
  const attachment = store.getAttachment(mediaId.trim());
  if (!attachment) throw notFound('媒体附件不存在');
  if (attachment.direction !== 'outbound') throw badRequest('mediaId 不是出站媒体附件');
  if (attachment.status !== 'ready' || !attachment.path) throw conflict('媒体附件未就绪或已失败');
  const kind = media.detectKind({ mime: attachment.mime, fileName: attachment.file_name });
  if (kind === media.MediaKind.VOICE) throw badRequest('暂不支持发送语音消息');
  return attachment;
}

/** 媒体上传公共处理（admin 与 v1 共用）。 */
async function handleMediaUpload(req, res, { urlPrefix = MEDIA_ADMIN_PREFIX } = {}) {
  const rawFileName = req.get('x-file-name');
  if (typeof rawFileName !== 'string' || rawFileName.trim() === '') {
    throw badRequest('缺少 X-File-Name 请求头（URL 编码的原始文件名）');
  }
  const fileName = media.sanitizeFileName(rawFileName);
  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw badRequest('缺少媒体内容（请以文件原始二进制作为请求体，并携带 X-File-Name 请求头）');
  }
  if (buffer.length > config.media.outboundMaxBytes) {
    throw new AppError(ErrorCodes.BAD_REQUEST, `媒体文件超过大小上限（${config.media.outboundMaxBytes} 字节）`, {
      status: 413,
    });
  }
  let mime = media.normalizeMime(req.get('content-type'));
  if (mime === 'application/octet-stream') {
    mime = media.sniffMime(buffer, media.getMimeFromFilename(fileName));
  }
  const kind = media.detectKind({ mime, fileName });
  const saved = await media.saveMediaBuffer({ direction: 'outbound', buffer, mime });
  const attachment = store.createAttachment({
    id: saved.id,
    direction: 'outbound',
    kind,
    mime: saved.mime ?? mime,
    fileName,
    size: saved.size,
    path: saved.path,
    sha256: saved.sha256,
    status: 'ready',
    createdAt: Date.now(),
  });
  log.info('出站媒体已上传', { attachmentId: attachment.id, kind, size: attachment.size, fileName });
  res.status(201).json({ media: mediaUploadView(attachment, urlPrefix), limits: media.getMediaLimits() });
}

/** 流式返回媒体文件（支持 Range，防目录穿越，按 ?download=1 决定 inline/attachment）。 */
async function sendMediaFile(req, res) {
  const attachment = store.getAttachment(req.params.id);
  if (!attachment || attachment.status !== 'ready' || !attachment.path) throw notFound('媒体不存在');
  let absolutePath;
  try {
    absolutePath = media.resolveMediaPath(attachment.path);
  } catch {
    throw notFound('媒体不存在');
  }
  let stat;
  try {
    stat = await fs.promises.stat(absolutePath);
  } catch {
    throw notFound('媒体文件不存在');
  }
  if (!stat.isFile()) throw notFound('媒体文件不存在');

  const download = req.query.download === '1' || req.query.download === 'true';
  // 默认仅 image/video inline；其他类型（file/voice）一律 attachment（docs/MEDIA.md §5.4）
  const inline = !download && ['image', 'video'].includes(attachment.kind);
  res.setHeader('Content-Type', attachment.mime || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.file_name || attachment.id)}`,
  );
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Accept-Ranges', 'bytes');
  if (stat.size === 0) {
    res.setHeader('Content-Length', '0');
    res.status(200).end();
    return;
  }

  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const rangeHeader = req.headers.range;
  if (typeof rangeHeader === 'string' && rangeHeader.trim() !== '') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    let valid = Boolean(match);
    if (match) {
      const [, startRaw, endRaw] = match;
      if (startRaw === '' && endRaw === '') {
        valid = false;
      } else if (startRaw === '') {
        const suffix = Number.parseInt(endRaw, 10);
        valid = Number.isFinite(suffix) && suffix > 0;
        if (valid) {
          start = Math.max(0, stat.size - suffix);
          end = stat.size - 1;
        }
      } else {
        start = Number.parseInt(startRaw, 10);
        end = endRaw === '' ? stat.size - 1 : Number.parseInt(endRaw, 10);
        valid = Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size;
        if (valid) end = Math.min(end, stat.size - 1);
      }
    }
    if (!valid) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      res.status(416).end();
      return;
    }
    status = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  }

  res.setHeader('Content-Length', String(end - start + 1));
  res.status(status);
  const stream = fs.createReadStream(absolutePath, { start, end });
  stream.on('error', (err) => {
    log.warn('媒体文件读取失败', { mediaId: attachment.id, message: err?.message });
    res.destroy(err);
  });
  stream.pipe(res);
}

/** 取要求存在的用户（原始行，含 pause_until/status）。 */
function mustGetUserRow(id) {
  const row = store.getUserRow(id);
  if (!row) throw notFound('用户不存在');
  return row;
}

/** 用户是否可接收消息（已绑定且不在 -14 冷却）。 */
function ensureSendableUser(row) {
  if (row.status !== 'active') throw conflict('用户未绑定或已解绑，无法发送消息');
  if (Number(row.pause_until) > Date.now()) {
    throw conflict('账号冷却中（bot token 已失效，需用户重新扫码绑定），暂时无法发送消息');
  }
}

// ---------------------------------------------------------------------------
// 用户分组 / 入站消息 API 辅助（docs/GROUPS_AND_INBOUND.md）
// ---------------------------------------------------------------------------

const GROUP_NAME_MAX = 40;
const GROUP_DESCRIPTION_MAX = 200;
const GROUP_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const INBOUND_DEFAULT_LIMIT = 50;
const INBOUND_MAX_LIMIT = 200;
const INBOUND_MAX_WAIT_SECONDS = 30;
const INBOUND_WAIT_POLL_MS = 500;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 校验分组名：trim 后 1..40 字符。 */
function parseGroupName(value) {
  if (typeof value !== 'string') throw badRequest('name 必须是字符串');
  const name = value.trim();
  if (name === '') throw badRequest('name 不能为空');
  if (name.length > GROUP_NAME_MAX) throw badRequest(`name 不能超过 ${GROUP_NAME_MAX} 个字符`);
  return name;
}

/** 校验分组描述：可选，≤200 字符（trim）。 */
function parseGroupDescription(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest('description 必须是字符串');
  const description = value.trim();
  if (description.length > GROUP_DESCRIPTION_MAX) {
    throw badRequest(`description 不能超过 ${GROUP_DESCRIPTION_MAX} 个字符`);
  }
  return description;
}

/** 校验分组颜色：空或 #RRGGBB。 */
function parseGroupColor(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !GROUP_COLOR_RE.test(value.trim())) {
    throw badRequest('color 必须是空或 #RRGGBB 格式');
  }
  return value.trim();
}

/**
 * 判断是否为 SQLite 唯一约束冲突。
 * 并发创建/改名同名分组时，"先查重再写入"之间存在竞态，最终由唯一索引兜底抛错，
 * 业务上应映射为 409 CONFLICT 而不是 500（QA nit-1）。
 */
function isUniqueConstraintError(err) {
  const message = String(err?.message ?? '');
  return (
    err?.errcode === 2067 ||
    /UNIQUE constraint failed/i.test(message) ||
    /SQLITE_CONSTRAINT_UNIQUE/i.test(message)
  );
}

/** 解析 GET /api/v1/inbound/messages 查询参数（非法 → 400）。 */
function parseInboundQuery(query = {}) {
  let limit = INBOUND_DEFAULT_LIMIT;
  if (query.limit !== undefined && query.limit !== '') {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 1 || n > INBOUND_MAX_LIMIT) {
      throw badRequest(`limit 必须是 1..${INBOUND_MAX_LIMIT} 的整数`);
    }
    limit = n;
  }
  let since = 0;
  if (query.since !== undefined && query.since !== '') {
    const n = Number(query.since);
    if (!Number.isInteger(n) || n < 0) throw badRequest('since 必须是非负毫秒时间戳整数');
    since = n;
  }
  let cursor = null;
  if (query.cursor !== undefined && query.cursor !== '') {
    try {
      cursor = store.decodeInboundCursor(String(query.cursor));
    } catch (err) {
      throw badRequest(`cursor 非法：${err.message}`);
    }
  }
  let wait = 0;
  if (query.wait !== undefined && query.wait !== '') {
    const n = Number(query.wait);
    if (!Number.isFinite(n) || n < 0 || n > INBOUND_MAX_WAIT_SECONDS) {
      throw badRequest(`wait 必须是 0..${INBOUND_MAX_WAIT_SECONDS} 秒`);
    }
    wait = n;
  }
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  const groupId = typeof query.groupId === 'string' ? query.groupId.trim() : '';
  return { limit, since, cursor, wait, userId, groupId };
}

/** 分组群发公共处理（管理端/ v1 共用）：校验分组+文本/媒体，给目标 active 未冷却用户入队。 */
function queueGroupMessage(groupId, body, urlPrefix) {
  const group = store.getGroup(groupId);
  if (!group) throw notFound('分组不存在');
  const text = parseOptionalText(body.text);
  const attachment = resolveOutboundAttachment(body.mediaId);
  if (text === '' && !attachment) throw badRequest('text 与 mediaId 至少提供一个');
  const targets = store.getGroupMembers(group.id, { activeOnly: true });
  const queued = store.enqueueMany(
    targets.map((user) => ({ userId: user.id, text, source: 'group', mediaId: attachment?.id ?? null })),
  );
  log.info('分组消息已入队', { groupId: group.id, count: queued.length });
  return {
    count: queued.length,
    queued: queued.map((row) => queuedItem(row, { attachment, urlPrefix })),
  };
}

/** v1 分组列表项（docs/GROUPS_AND_INBOUND.md §4.1）。 */
function v1GroupView(group) {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    color: group.color,
    keepaliveEnabled: group.keepaliveEnabled === true,
    userCount: group.userCount,
    activeUserCount: group.activeUserCount,
  };
}

// ---------------------------------------------------------------------------
// 接口应用：请求体校验（docs/API_RULES.md §7）
// ---------------------------------------------------------------------------

const APP_RULE_MATCH_MODES = new Set(['contains', 'equals', 'regex']);
const APP_RULE_EXTRACTION_MODES = new Set(['none', 'trailing', 'regex', 'json', 'fulltext', 'multi']);
const APP_RULE_SCOPE_TYPES = new Set(['all', 'users', 'groups']);
const APP_RULE_LOG_STATUSES = new Set(['matched', 'success', 'failed', 'skipped']);

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest(`${field} 必须是对象`);
  return value;
}

function requiredString(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') throw badRequest(`${field} 必须是字符串`);
  const text = value.trim();
  if (text.length < min || text.length > max) throw badRequest(`${field} 长度必须是 ${min}..${max}`);
  return text;
}

function optionalString(value, field, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest(`${field} 必须是字符串`);
  if (value.length > max) throw badRequest(`${field} 过长（≤${max}）`);
  return value;
}

function validRegexSource(value) {
  try {
    new RegExp(value, 'u');
    return true;
  } catch {
    return false;
  }
}

function validateHttpUrl(value) {
  const raw = requiredString(value, 'request.url', { min: 1, max: 2000 });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('request.url 不是合法 URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('request.url 仅允许 http/https');
  if (url.username || url.password) throw badRequest('request.url 不允许包含用户名/密码（userinfo）');
  return raw;
}

/**
 * 校验并构造规则扁平字段 patch（创建 requireAll=true，更新为部分字段）。
 * request.headers 仅在显式传入时加密（{} 表示清空；不传保持原值）。
 */
function buildAppRulePatch(rawBody, { requireAll = false } = {}) {
  const body = assertPlainObject(rawBody ?? {}, '请求体');
  const patch = {};

  if (requireAll || body.name !== undefined) patch.name = requiredString(body.name, 'name', { min: 1, max: 60 });
  if (requireAll || body.enabled !== undefined) {
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw badRequest('enabled 必须是 boolean');
    patch.enabled = body.enabled === undefined ? true : body.enabled;
  }
  if (requireAll || body.priority !== undefined) {
    const priority = body.priority === undefined ? 100 : body.priority;
    if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000) {
      throw badRequest('priority 必须是 0..1000000 的整数');
    }
    patch.priority = priority;
  }

  if (requireAll || body.scope !== undefined) {
    const scope = assertPlainObject(body.scope ?? { type: 'all', ids: [] }, 'scope');
    const type = scope.type ?? 'all';
    if (!APP_RULE_SCOPE_TYPES.has(type)) throw badRequest('scope.type 只能是 all | users | groups');
    let ids = [];
    if (type !== 'all') {
      if (!Array.isArray(scope.ids) || scope.ids.length === 0) throw badRequest('scope.ids 必须是非空数组');
      ids = [...new Set(scope.ids.map((id) => String(id).trim()).filter(Boolean))];
      if (ids.length === 0) throw badRequest('scope.ids 必须包含有效 id');
      if (type === 'users') {
        const unknown = ids.filter((id) => !store.getUserRow(id));
        if (unknown.length > 0) throw badRequest(`scope.ids 中用户不存在：${unknown.join(', ')}`);
      } else {
        const unknown = ids.filter((id) => !store.getGroupRow(id));
        if (unknown.length > 0) throw badRequest(`scope.ids 中分组不存在：${unknown.join(', ')}`);
      }
    }
    patch.scopeType = type;
    patch.scopeIds = ids;
  }

  if (requireAll || body.matchMode !== undefined || body.keywords !== undefined || body.regexPattern !== undefined) {
    const mode = body.matchMode ?? 'contains';
    if (!APP_RULE_MATCH_MODES.has(mode)) throw badRequest('matchMode 只能是 contains | equals | regex');
    patch.matchMode = mode;
    if (mode === 'regex') {
      const pattern = requiredString(body.regexPattern, 'regexPattern', { min: 1, max: 500 });
      if (!validRegexSource(pattern)) throw badRequest('regexPattern 不是合法正则');
      patch.regexPattern = pattern;
      patch.keywords = [];
    } else {
      if (!Array.isArray(body.keywords) || body.keywords.length < 1 || body.keywords.length > 10) {
        throw badRequest('keywords 必须是 1..10 个关键词');
      }
      const keywords = body.keywords.map((keyword) => {
        if (typeof keyword !== 'string') throw badRequest('keywords 必须是字符串数组');
        const text = keyword.trim();
        if (text.length < 1 || text.length > 50) throw badRequest('每个关键词长度必须是 1..50');
        return text;
      });
      patch.keywords = keywords;
      patch.regexPattern = '';
    }
  }

  if (requireAll || body.extraction !== undefined) {
    const extraction = assertPlainObject(body.extraction ?? { mode: 'trailing', config: {} }, 'extraction');
    const mode = extraction.mode ?? 'trailing';
    if (!APP_RULE_EXTRACTION_MODES.has(mode)) {
      throw badRequest('extraction.mode 只能是 none | trailing | regex | json | fulltext');
    }
    const extractionConfig = assertPlainObject(extraction.config ?? {}, 'extraction.config');
    if (mode === 'regex') {
      const regex = extractionConfig.regex;
      if (typeof regex !== 'string' || regex.trim() === '') {
        throw badRequest('regex 提取模式必须提供 extraction.config.regex');
      }
      if (!validRegexSource(regex)) throw badRequest('extraction.config.regex 不是合法正则');
    }
    if (mode === 'multi') {
      const extractors = extractionConfig.extractors;
      if (!Array.isArray(extractors) || extractors.length < 1 || extractors.length > 10) {
        throw badRequest('multi 提取模式需要 extraction.config.extractors 数组（1-10 项）');
      }
      const paramNamePattern = /^[A-Za-z0-9_]{1,30}$/;
      extractors.forEach((item, index) => {
        const extractor = assertPlainObject(item, `extraction.config.extractors[${index}]`);
        const type = String(extractor.type ?? '');
        if (!['trailing', 'regex', 'json', 'fulltext'].includes(type)) {
          throw badRequest(`提取项 ${index + 1} 的 type 只能是 trailing | regex | json | fulltext`);
        }
        if (extractor.param !== undefined) {
          if (typeof extractor.param !== 'string' || !paramNamePattern.test(extractor.param.trim())) {
            throw badRequest(`提取项 ${index + 1} 的 param 只能是字母/数字/下划线（1-30 字符）`);
          }
        }
        if (type === 'trailing' && extractor.keyword !== undefined) {
          if (typeof extractor.keyword !== 'string' || extractor.keyword.length > 50) {
            throw badRequest(`提取项 ${index + 1} 的 keyword 最多 50 个字符`);
          }
        }
        if (type === 'regex') {
          const regex = extractor.regex;
          if (typeof regex !== 'string' || regex.trim() === '' || !validRegexSource(regex)) {
            throw badRequest(`提取项 ${index + 1} 的 regex 缺失或不是合法正则`);
          }
        }
        if (type === 'json' && extractor.path !== undefined) {
          if (typeof extractor.path !== 'string' || extractor.path.length > 200) {
            throw badRequest(`提取项 ${index + 1} 的 path 最多 200 个字符`);
          }
        }
      });
      const required = extractionConfig.required;
      if (required !== undefined) {
        if (!Array.isArray(required) || required.length > 20) {
          throw badRequest('extraction.config.required 必须是数组（最多 20 个参数名）');
        }
        for (const name of required) {
          if (typeof name !== 'string' || !paramNamePattern.test(name.trim())) {
            throw badRequest('extraction.config.required 中的参数名只能是字母/数字/下划线');
          }
        }
      }
    }
    patch.extractionMode = mode;
    patch.extractionConfig = extractionConfig;
  }

  if (requireAll || body.request !== undefined) {
    const request = assertPlainObject(body.request ?? {}, 'request');
    const method = String(request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw badRequest('request.method 只能是 GET | POST');
    patch.requestMethod = method;
    patch.requestUrl = validateHttpUrl(request.url);
    patch.requestBodyTemplate = optionalString(request.bodyTemplate, 'request.bodyTemplate', 10000);
    if (request.headers !== undefined) {
      const headers = assertPlainObject(request.headers, 'request.headers');
      const normalized = {};
      for (const [key, value] of Object.entries(headers)) {
        if (typeof key !== 'string' || key.trim().length < 1 || key.trim().length > 100) {
          throw badRequest('request.headers 的 header 名长度必须是 1..100');
        }
        if (typeof value !== 'string' || value.length > 2000) {
          throw badRequest(`request.headers[${key}] 的值必须是 ≤2000 的字符串`);
        }
        normalized[key.trim()] = value;
      }
      patch.requestHeadersEnc = encryptSecret(JSON.stringify(normalized));
    } else if (requireAll) {
      patch.requestHeadersEnc = null;
    }
  }

  if (requireAll || body.response !== undefined) {
    const response = assertPlainObject(body.response ?? {}, 'response');
    const type = response.type ?? 'json';
    if (type !== 'json' && type !== 'text') throw badRequest('response.type 只能是 json | text');
    patch.responseType = type;
    patch.responsePath = optionalString(response.path, 'response.path', 200);
    patch.replyTemplate = optionalString(response.template, 'response.template', 4000);
    patch.fallbackText = optionalString(response.fallbackText, 'response.fallbackText', 4000);
  }

  const limitSpecs = [
    ['timeoutMs', 1000, 30000, 8000],
    ['cooldownMs', 0, 3600000, 10000],
    ['maxCallsPerHour', 1, 10000, 60],
    ['maxUserCallsPerHour', 1, 10000, 10],
  ];
  for (const [key, min, max, defaultValue] of limitSpecs) {
    if (!requireAll && body[key] === undefined) continue;
    const value = body[key] === undefined ? defaultValue : body[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw badRequest(`${key} 必须是 ${min}..${max} 的整数`);
    }
    patch[key] = value;
  }

  return patch;
}

// ---------------------------------------------------------------------------
// 定时通知：请求体校验（docs/SCHEDULED_TASKS.md §5）
// ---------------------------------------------------------------------------

const SCHEDULED_SCHEDULE_TYPES = new Set(['interval', 'daily']);
const SCHEDULED_TARGET_TYPES = new Set(['users', 'groups']);
const SCHEDULED_TASK_STATUSES = new Set(['success', 'failed', 'skipped']);
const SCHEDULED_MIN_INTERVAL_MS = 60_000;
const SCHEDULED_MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 校验并构造定时任务扁平字段 patch（创建 requireAll=true，更新为部分字段）。
 * request.headers 语义：不传=不变；{} 清空；对象=全量替换（加密落库，读取只回 headerNames）。
 */
function buildScheduledTaskPatch(rawBody, { requireAll = false } = {}) {
  const body = assertPlainObject(rawBody ?? {}, '请求体');
  const patch = {};

  if (requireAll || body.name !== undefined) patch.name = requiredString(body.name, 'name', { min: 1, max: 60 });
  if (requireAll || body.enabled !== undefined) {
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw badRequest('enabled 必须是 boolean');
    patch.enabled = body.enabled === undefined ? true : body.enabled;
  }

  if (requireAll || body.schedule !== undefined) {
    const schedule = assertPlainObject(body.schedule ?? {}, 'schedule');
    const type = schedule.type ?? 'interval';
    if (!SCHEDULED_SCHEDULE_TYPES.has(type)) throw badRequest('schedule.type 只能是 interval | daily');
    patch.scheduleType = type;
    // 每日生效时间段（仅 interval；windowStart/windowEnd 必须同时为空或同时存在）
    const windowStartRaw = schedule.windowStart === undefined || schedule.windowStart === null ? '' : schedule.windowStart;
    const windowEndRaw = schedule.windowEnd === undefined || schedule.windowEnd === null ? '' : schedule.windowEnd;
    if (typeof windowStartRaw !== 'string' || typeof windowEndRaw !== 'string') {
      throw badRequest('schedule.windowStart/windowEnd 必须是 HH:mm 字符串');
    }
    const windowStart = windowStartRaw.trim();
    const windowEnd = windowEndRaw.trim();
    if ((windowStart === '') !== (windowEnd === '')) {
      throw badRequest('schedule.windowStart 与 schedule.windowEnd 必须同时为空或同时填写');
    }
    if (windowStart !== '') {
      if (type === 'daily') throw badRequest('daily 计划不支持每日生效时间段（windowStart/windowEnd 仅 interval 可用）');
      if (!scheduler.parseClockTime(windowStart) || !scheduler.parseClockTime(windowEnd)) {
        throw badRequest('schedule.windowStart/windowEnd 必须是合法的 HH:mm');
      }
      if (windowStart === windowEnd) throw badRequest('schedule.windowStart 与 schedule.windowEnd 不能相同');
    }
    patch.windowStart = windowStart;
    patch.windowEnd = windowEnd;
    if (type === 'interval') {
      const intervalMs = schedule.intervalMs === undefined ? 3600000 : schedule.intervalMs;
      if (!Number.isInteger(intervalMs) || intervalMs < SCHEDULED_MIN_INTERVAL_MS || intervalMs > SCHEDULED_MAX_INTERVAL_MS) {
        throw badRequest(`schedule.intervalMs 必须是 ${SCHEDULED_MIN_INTERVAL_MS}..${SCHEDULED_MAX_INTERVAL_MS} 的整数`);
      }
      patch.intervalMs = intervalMs;
    } else {
      const dailyTime = schedule.dailyTime;
      if (typeof dailyTime !== 'string' || !scheduler.parseDailyTime(dailyTime)) {
        throw badRequest('schedule.dailyTime 必须是合法的 HH:mm');
      }
      patch.dailyTime = dailyTime.trim();
    }
  }

  if (requireAll || body.targets !== undefined) {
    const targets = assertPlainObject(body.targets ?? {}, 'targets');
    const type = targets.type ?? 'users';
    if (!SCHEDULED_TARGET_TYPES.has(type)) throw badRequest('targets.type 只能是 users | groups');
    if (!Array.isArray(targets.ids) || targets.ids.length === 0) throw badRequest('targets.ids 必须是非空数组');
    const ids = [...new Set(targets.ids.map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) throw badRequest('targets.ids 必须包含有效 id');
    if (type === 'users') {
      const unknown = ids.filter((id) => !store.getUserRow(id));
      if (unknown.length > 0) throw badRequest(`targets.ids 中用户不存在：${unknown.join(', ')}`);
    } else {
      const unknown = ids.filter((id) => !store.getGroupRow(id));
      if (unknown.length > 0) throw badRequest(`targets.ids 中分组不存在：${unknown.join(', ')}`);
    }
    patch.targetType = type;
    patch.targetIds = ids;
  }

  if (requireAll || body.request !== undefined) {
    const request = assertPlainObject(body.request ?? {}, 'request');
    const method = String(request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw badRequest('request.method 只能是 GET | POST');
    patch.requestMethod = method;
    const urlValue = validateHttpUrl(request.url);
    try {
      const parsedUrl = new URL(urlValue);
      if (parsedUrl.username || parsedUrl.password) throw badRequest('request.url 不允许包含 userinfo（user:pass@）');
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw badRequest('request.url 不是合法 URL');
    }
    patch.requestUrl = urlValue;
    patch.requestBodyTemplate = optionalString(request.bodyTemplate, 'request.bodyTemplate', 10000);
    if (request.headers !== undefined) {
      const headers = assertPlainObject(request.headers, 'request.headers');
      const normalized = {};
      for (const [key, value] of Object.entries(headers)) {
        if (typeof key !== 'string' || key.trim().length < 1 || key.trim().length > 100) {
          throw badRequest('request.headers 的 header 名长度必须是 1..100');
        }
        if (typeof value !== 'string' || value.length > 2000) {
          throw badRequest(`request.headers[${key}] 的值必须是 ≤2000 的字符串`);
        }
        normalized[key.trim()] = value;
      }
      patch.requestHeadersEnc = encryptSecret(JSON.stringify(normalized));
    } else if (requireAll) {
      patch.requestHeadersEnc = null;
    }
  }

  if (requireAll || body.response !== undefined) {
    const response = assertPlainObject(body.response ?? {}, 'response');
    const type = response.type ?? 'json';
    if (type !== 'json' && type !== 'text') throw badRequest('response.type 只能是 json | text');
    patch.responseType = type;
    patch.responsePath = optionalString(response.path, 'response.path', 200);
    patch.replyTemplate = optionalString(response.template, 'response.template', 4000);
    patch.fallbackText = optionalString(response.fallbackText, 'response.fallbackText', 4000);
  }

  if (requireAll || body.timeoutMs !== undefined) {
    const timeoutMs = body.timeoutMs === undefined ? 8000 : body.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
      throw badRequest('timeoutMs 必须是 1000..30000 的整数');
    }
    patch.timeoutMs = timeoutMs;
  }

  return patch;
}

// ---------------------------------------------------------------------------
// 应用构建
// ---------------------------------------------------------------------------

/**
 * 创建 Express 应用（index.js 与测试共用）。
 * @returns {import('express').Express}
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  // 1) 安全响应头（所有响应，包含静态资源）
  app.use((req, res, next) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
    next();
  });

  // 2) API 响应不缓存
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // 3) 健康检查（无需鉴权、无需 body 解析）
  app.get('/health', (req, res) => res.json(healthPayload()));
  app.get('/api/health', (req, res) => res.json(healthPayload()));

  // 4) JSON body 解析：上限 64KB
  app.use(express.json({ limit: '64kb' }));

  // -------------------------------------------------------------------------
  // 公开接口：扫码绑定
  // -------------------------------------------------------------------------

  app.post('/api/bind/sessions', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const created = await binding.createSession({ displayName: body.displayName, ip: auth.getClientIp(req) });
    res.status(201).json(created);
  });

  app.get('/api/bind/sessions/:sessionId', (req, res) => {
    res.json(binding.getSession({ sessionId: req.params.sessionId, token: req.query.token }));
  });

  app.post('/api/bind/sessions/:sessionId/verify-code', (req, res) => {
    const body = requireJsonBody(req);
    const result = binding.submitVerifyCode({
      sessionId: req.params.sessionId,
      token: body.token,
      code: body.code,
    });
    res.status(202).json(result);
  });

  app.delete('/api/bind/sessions/:sessionId', (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    binding.cancelSession({ sessionId: req.params.sessionId, token: body.token });
    res.status(204).end();
  });

  // -------------------------------------------------------------------------
  // 管理后台（Cookie 会话）
  // -------------------------------------------------------------------------

  app.post('/api/admin/login', (req, res) => {
    const ip = auth.getClientIp(req);
    auth.checkLoginRateLimit(ip);
    const body = requireJsonBody(req);
    const password = typeof body.password === 'string' ? body.password : '';
    if (password === '') throw badRequest('请输入管理员密码');
    if (!auth.verifyAdminPassword(password)) {
      auth.recordLoginEvent(store, { success: false, ip });
      throw new AppError(ErrorCodes.UNAUTHORIZED, '密码错误', { status: 401 });
    }
    const payload = auth.setAdminSessionCookie(res);
    auth.recordLoginEvent(store, { success: true, ip });
    res.json({ ok: true, expiresAt: payload?.exp ?? Date.now() + config.session.ttlMs });
  });

  app.post('/api/admin/logout', auth.requireWriteHeader, (req, res) => {
    auth.clearAdminSessionCookie(res);
    res.status(204).end();
  });

  app.get('/api/admin/me', (req, res) => {
    const session = auth.getAdminSession(req);
    if (!session) {
      res.json({ authenticated: false });
      return;
    }
    res.json({ authenticated: true, expiresAt: session.exp });
  });

  app.get('/api/admin/overview', auth.requireAdmin, (req, res) => {
    const stats = store.getStats();
    res.json({
      stats: {
        totalUsers: stats.totalUsers,
        activeUsers: stats.activeUsers,
        pausedUsers: stats.pausedUsers,
        usersWithContextToken: stats.usersWithContextToken,
        messagesToday: stats.messagesToday,
        queued: stats.queued,
        sending: stats.sending,
        sent: stats.sent,
        failed: stats.failed,
        inboundLast24h: stats.inboundLast24h,
        keepaliveEnabledUsers: stats.keepaliveEnabledUsers,
        keepaliveSent24h: stats.keepaliveSent24h,
      },
      server: {
        version: config.version,
        uptimeMs: Math.round(process.uptime() * 1000),
        now: Date.now(),
        ilink: {
          loginBaseUrl: config.ilink.loginBaseUrl,
          defaultBaseUrl: config.ilink.defaultBaseUrl,
          botType: config.ilink.botType,
        },
        rateLimit: { max: config.push.rateLimitMax, windowMs: config.push.rateLimitWindowMs },
        monitorsRunning: monitor.runningCount(),
        bindingSessionsActive: binding.getActiveSessionCount(),
      },
    });
  });

  app.get('/api/admin/users', auth.requireAdmin, (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : 'active';
    if (!USER_STATUSES.has(status)) throw badRequest('status 只能是 active | unbound | paused | all');
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const groupId = typeof req.query.groupId === 'string' ? req.query.groupId.trim() : '';
    const result = store.listUsers({
      status,
      q,
      groupId,
      limit: parseLimit(req.query.limit, 50, 500),
      offset: parseOffset(req.query.offset),
    });
    res.json({ total: result.total, items: result.items.map(userView) });
  });

  app.get('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
    const user = store.getUserWithCounts(req.params.id);
    if (!user) throw notFound('用户不存在');
    res.json({
      user: userView(user),
      recentInbound: store.getRecentInbound(req.params.id, 20),
      recentOutbound: store.getRecentOutbound(req.params.id, 20),
    });
  });

  // 全量替换用户分组（多对多标签，docs/GROUPS_AND_INBOUND.md §3.2）
  app.put('/api/admin/users/:id/groups', auth.requireAdminWrite, (req, res) => {
    const user = mustGetUserRow(req.params.id);
    const body = requireJsonBody(req);
    if (!Array.isArray(body.groupIds)) throw badRequest('groupIds 必须是数组');
    const groupIds = [];
    for (const rawId of body.groupIds) {
      if (typeof rawId !== 'string' || rawId.trim() === '') {
        throw badRequest('groupIds 中的分组 id 必须是非空字符串');
      }
      groupIds.push(rawId.trim());
    }
    const uniqueIds = [...new Set(groupIds)];
    const unknownGroupIds = uniqueIds.filter((groupId) => !store.getGroupRow(groupId));
    if (unknownGroupIds.length > 0) {
      throw new AppError(ErrorCodes.BAD_REQUEST, '存在不存在的分组 id', {
        status: 400,
        details: { unknownGroupIds },
      });
    }
    store.replaceUserGroups(user.id, uniqueIds);
    const updatedUser = store.getUserWithCounts(user.id);
    const inheritedKeepalive = store.userHasKeepaliveGroup(user.id);
    log.info('用户分组已更新', { userId: user.id, groupCount: uniqueIds.length, inheritedKeepalive });
    res.json({ user: userView(updatedUser), inheritedKeepalive });
  });

  app.post('/api/admin/users/:id/messages', auth.requireAdminWrite, (req, res) => {
    const row = mustGetUserRow(req.params.id);
    ensureSendableUser(row);
    const body = requireJsonBody(req);
    const text = parseOptionalText(body.text);
    const attachment = resolveOutboundAttachment(body.mediaId);
    if (text === '' && !attachment) throw badRequest('text 与 mediaId 至少提供一个');
    const queued = store.enqueueMessage({
      userId: row.id,
      text,
      source: 'admin',
      mediaId: attachment?.id ?? null,
    });
    res.status(202).json({ queued: [queuedItem(queued, { attachment })] });
  });

  app.post('/api/admin/users/:id/unbind', auth.requireAdminWrite, async (req, res) => {
    const row = mustGetUserRow(req.params.id);
    // 先停轮询（内部 best-effort notifyStop），再清凭证
    await monitor.stop(row.id, { notify: true, reason: 'admin unbind' });
    store.failUserQueued(row.id, '用户已解绑，消息未发送');
    store.unbindUser(row.id);
    store.addEvent({ type: 'unbind', userId: row.id });
    log.info('用户已解绑', { userId: row.id });
    res.json({ ok: true, message: '已解绑（微信端授权需在手机微信中管理）' });
  });

  // 彻底删除用户及其关联数据（不可恢复）：先停监控，再清理关联表 + 附件文件
  app.delete('/api/admin/users/:id', auth.requireAdminWrite, async (req, res) => {
    const row = mustGetUserRow(req.params.id);
    await monitor.stop(row.id, { notify: false, reason: 'admin delete user' }).catch((err) => {
      log.warn('删除用户时停止监控失败（继续删除）', { userId: row.id, message: err?.message });
    });
    const result = store.deleteUserCascade(row.id);
    if (!result) throw notFound('用户不存在');
    let attachmentsDeleted = 0;
    for (const relativePath of result.attachmentPaths) {
      try {
        fs.rmSync(media.resolveMediaPath(relativePath), { force: true });
        attachmentsDeleted += 1;
      } catch (err) {
        log.warn('删除用户附件文件失败（跳过）', { userId: row.id, path: relativePath, message: err?.message });
      }
    }
    log.info('用户已彻底删除', {
      userId: row.id,
      attachmentsDeleted,
      cleared: result.cleared,
      updatedTasks: result.updatedTasks,
      updatedRules: result.updatedRules,
    });
    res.json({
      ok: true,
      deleted: true,
      userId: row.id,
      attachmentsDeleted,
      cleared: result.cleared,
      updatedTasks: result.updatedTasks,
      updatedRules: result.updatedRules,
    });
  });

  app.post('/api/admin/users/:id/reconnect', auth.requireAdminWrite, async (req, res) => {
    const row = mustGetUserRow(req.params.id);
    if (row.status !== 'active') throw conflict('用户未绑定或已解绑，请重新扫码绑定');
    if (Number(row.pause_until) > Date.now()) throw conflict('账号冷却中，请等待冷却结束后重试');
    await monitor.start(row.id);
    res.json({ ok: true, monitorsRunning: monitor.isRunning(row.id) });
  });

  // -------------------------------------------------------------------------
  // 管理端：用户分组（schema v3，docs/GROUPS_AND_INBOUND.md §3）
  // -------------------------------------------------------------------------

  app.get('/api/admin/groups', auth.requireAdmin, (req, res) => {
    res.json({ items: store.listGroups() });
  });

  app.post('/api/admin/groups', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    const name = parseGroupName(body.name);
    const description = parseGroupDescription(body.description);
    const color = parseGroupColor(body.color);
    if (body.keepaliveEnabled !== undefined && typeof body.keepaliveEnabled !== 'boolean') {
      throw badRequest('keepaliveEnabled 必须是 boolean');
    }
    const keepaliveEnabled = body.keepaliveEnabled === true;
    if (store.findGroupByName(name)) throw conflict('分组名称已存在');
    let group;
    try {
      group = store.createGroup({ name, description, color, keepaliveEnabled });
    } catch (err) {
      // 并发同名：唯一索引兜底，统一映射 409（不是 500）
      if (isUniqueConstraintError(err)) throw conflict('分组名称已存在');
      throw err;
    }
    log.info('分组已创建', { groupId: group.id, name: group.name, keepaliveEnabled: group.keepaliveEnabled });
    res.status(201).json({ group });
  });

  app.patch('/api/admin/groups/:id', auth.requireAdminWrite, (req, res) => {
    const existing = store.getGroupRow(req.params.id);
    if (!existing) throw notFound('分组不存在');
    const body = requireJsonBody(req);
    const updates = {};
    if (body.name !== undefined) updates.name = parseGroupName(body.name);
    if (body.description !== undefined) updates.description = parseGroupDescription(body.description);
    if (body.color !== undefined) updates.color = parseGroupColor(body.color);
    if (body.keepaliveEnabled !== undefined) {
      if (typeof body.keepaliveEnabled !== 'boolean') throw badRequest('keepaliveEnabled 必须是 boolean');
      updates.keepaliveEnabled = body.keepaliveEnabled;
    }
    if (Object.keys(updates).length === 0) {
      throw badRequest('至少提供一个可更新字段（name/description/color/keepaliveEnabled）');
    }
    if (updates.name !== undefined && store.findGroupByName(updates.name, { excludeId: existing.id })) {
      throw conflict('分组名称已存在');
    }
    let group;
    try {
      group = store.updateGroup(existing.id, updates);
      // 与批量保活接口语义一致：分组级 keepaliveEnabled 变更时同步当前成员
      if (updates.keepaliveEnabled !== undefined) {
        store.setGroupKeepaliveEnabled(existing.id, updates.keepaliveEnabled);
        group = store.getGroup(existing.id);
      }
    } catch (err) {
      // 并发改名同名：唯一索引兜底，统一映射 409（不是 500）
      if (isUniqueConstraintError(err)) throw conflict('分组名称已存在');
      throw err;
    }
    res.json({ group });
  });

  app.delete('/api/admin/groups/:id', auth.requireAdminWrite, (req, res) => {
    if (!store.deleteGroup(req.params.id)) throw notFound('分组不存在');
    log.info('分组已删除', { groupId: req.params.id });
    res.status(204).end();
  });

  app.post('/api/admin/groups/:id/messages', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    const result = queueGroupMessage(req.params.id, body, MEDIA_ADMIN_PREFIX);
    res.status(202).json(result);
  });

  // 用户/分组 24h 会话保活开关（docs/KEEPALIVE.md §4）
  app.patch('/api/admin/users/:id/keepalive', auth.requireAdminWrite, (req, res) => {
    const user = mustGetUserRow(req.params.id);
    const body = requireJsonBody(req);
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled 必须是 boolean');
    store.setKeepaliveEnabled(user.id, body.enabled);
    log.info('用户保活开关已更新', { userId: user.id, enabled: body.enabled });
    res.json({ user: userView(store.getUserWithCounts(user.id)) });
  });

  app.post('/api/admin/groups/:id/keepalive', auth.requireAdminWrite, (req, res) => {
    const group = store.getGroup(req.params.id);
    if (!group) throw notFound('分组不存在');
    const body = requireJsonBody(req);
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled 必须是 boolean');
    const updated = store.setGroupKeepaliveEnabled(group.id, body.enabled);
    log.info('分组保活开关已更新', { groupId: group.id, enabled: body.enabled, updated });
    res.json({ updated, group: store.getGroup(group.id) });
  });

  // -------------------------------------------------------------------------
  // 接口应用（docs/API_RULES.md §7）
  // -------------------------------------------------------------------------
  app.get('/api/admin/app-rules', auth.requireAdmin, (req, res) => {
    const includeDisabled = ['1', 'true', 'yes'].includes(String(req.query.includeDisabled ?? '').toLowerCase());
    res.json({ items: store.listAppRules({ includeDisabled }) });
  });

  app.post('/api/admin/app-rules', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    const patch = buildAppRulePatch(body, { requireAll: true });
    const rule = store.createAppRule(patch);
    log.info('接口应用规则已创建', { ruleId: rule.id, name: rule.name });
    res.status(201).json({ rule });
  });

  app.get('/api/admin/app-rules/:id', auth.requireAdmin, (req, res) => {
    const rule = store.getAppRule(req.params.id);
    if (!rule) throw notFound('规则不存在');
    res.json({ rule });
  });

  app.patch('/api/admin/app-rules/:id', auth.requireAdminWrite, (req, res) => {
    if (!store.getAppRuleRow(req.params.id)) throw notFound('规则不存在');
    const body = requireJsonBody(req);
    const patch = buildAppRulePatch(body, { requireAll: false });
    const rule = store.updateAppRule(req.params.id, patch);
    log.info('接口应用规则已更新', { ruleId: req.params.id });
    res.json({ rule });
  });

  app.delete('/api/admin/app-rules/:id', auth.requireAdminWrite, (req, res) => {
    if (!store.deleteAppRule(req.params.id)) throw notFound('规则不存在');
    log.info('接口应用规则已删除', { ruleId: req.params.id });
    res.status(204).end();
  });

  app.post('/api/admin/app-rules/:id/test', auth.requireAdminWrite, async (req, res) => {
    const row = store.getAppRuleRow(req.params.id);
    if (!row) throw notFound('规则不存在');
    const body = requireJsonBody(req);
    if (typeof body.message !== 'string' || body.message.trim() === '') throw badRequest('message 必须是非空字符串');
    if (body.message.length > config.push.maxTextLength) throw badRequest(`message 长度不能超过 ${config.push.maxTextLength}`);
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    if (userId && !store.getUserRow(userId)) throw notFound('用户不存在');
    const result = await appRules.testRule({ ruleRow: row, message: body.message, userId });
    log.info('接口应用规则测试运行', {
      ruleId: row.id,
      matched: result.matched,
      httpStatus: result.httpStatus,
      error: result.error,
    });
    res.json(result);
  });

  app.get('/api/admin/app-rule-logs', auth.requireAdmin, (req, res) => {
    const ruleId = typeof req.query.ruleId === 'string' ? req.query.ruleId.trim() : '';
    const userId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    if (status !== '' && !APP_RULE_LOG_STATUSES.has(status)) {
      throw badRequest('status 只能是 matched | success | failed | skipped');
    }
    res.json(
      store.listAppRuleLogs({
        ruleId,
        userId,
        status,
        limit: parseLimit(req.query.limit, 50, 500),
        offset: parseOffset(req.query.offset),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 定时通知（docs/SCHEDULED_TASKS.md §5）
  // -------------------------------------------------------------------------
  app.get('/api/admin/scheduled-tasks', auth.requireAdmin, (req, res) => {
    res.json({ items: store.listScheduledTasks() });
  });

  app.post('/api/admin/scheduled-tasks', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    const patch = buildScheduledTaskPatch(body, { requireAll: true });
    patch.nextRunAt = scheduler.computeInitialNextRun(patch);
    const task = store.createScheduledTask(patch);
    log.info('定时任务已创建', { taskId: task.id, name: task.name, nextRunAt: task.nextRunAt });
    res.status(201).json({ task });
  });

  app.get('/api/admin/scheduled-tasks/:id', auth.requireAdmin, (req, res) => {
    const task = store.getScheduledTask(req.params.id);
    if (!task) throw notFound('定时任务不存在');
    res.json({ task });
  });

  app.patch('/api/admin/scheduled-tasks/:id', auth.requireAdminWrite, (req, res) => {
    const row = store.getScheduledTaskRow(req.params.id);
    if (!row) throw notFound('定时任务不存在');
    const body = requireJsonBody(req);
    const patch = buildScheduledTaskPatch(body, { requireAll: false });
    const scheduleKeys = ['scheduleType', 'intervalMs', 'dailyTime'];
    const scheduleChanged = scheduleKeys.some((key) => patch[key] !== undefined);
    const oldNextRunAt = Number(row.next_run_at) || 0;
    if (patch.enabled === false) {
      patch.nextRunAt = 0;
    } else if (patch.enabled === true || scheduleChanged || oldNextRunAt <= 0) {
      patch.nextRunAt = scheduler.computeInitialNextRun({
        scheduleType: patch.scheduleType ?? row.schedule_type,
        intervalMs: patch.intervalMs ?? row.interval_ms,
        dailyTime: patch.dailyTime ?? row.daily_time,
        windowStart: patch.windowStart ?? row.window_start,
        windowEnd: patch.windowEnd ?? row.window_end,
      });
    }
    const task = store.updateScheduledTask(req.params.id, patch);
    log.info('定时任务已更新', { taskId: task.id, enabled: task.enabled, nextRunAt: task.nextRunAt });
    res.json({ task });
  });

  app.delete('/api/admin/scheduled-tasks/:id', auth.requireAdminWrite, (req, res) => {
    if (!store.deleteScheduledTask(req.params.id)) throw notFound('定时任务不存在');
    log.info('定时任务已删除', { taskId: req.params.id });
    res.status(204).end();
  });

  app.post('/api/admin/scheduled-tasks/:id/test', auth.requireAdminWrite, async (req, res) => {
    if (!store.getScheduledTaskRow(req.params.id)) throw notFound('定时任务不存在');
    const result = await scheduler.runScheduledTaskNow(req.params.id, { dryRun: true });
    log.info('定时任务测试运行（dry-run）', { taskId: req.params.id, httpStatus: result?.httpStatus, error: result?.error });
    res.json(result);
  });

  app.post('/api/admin/scheduled-tasks/:id/run', auth.requireAdminWrite, async (req, res) => {
    const row = store.getScheduledTaskRow(req.params.id);
    if (!row) throw notFound('定时任务不存在');
    if (!Number(row.enabled)) throw badRequest('任务未启用，禁止立即执行（请先启用）');
    const result = await scheduler.runScheduledTaskNow(req.params.id, { dryRun: false });
    res.json({
      status: result.status,
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      recipientsCount: result.recipientsCount,
      error: result.error,
    });
  });

  app.get('/api/admin/scheduled-task-logs', auth.requireAdmin, (req, res) => {
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    if (status !== '' && !SCHEDULED_TASK_STATUSES.has(status)) {
      throw badRequest('status 只能是 success | failed | skipped');
    }
    res.json(
      store.listScheduledTaskLogs({
        taskId,
        status,
        limit: parseLimit(req.query.limit, 50, 500),
        offset: parseOffset(req.query.offset),
      }),
    );
  });

  app.post('/api/admin/broadcast', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    const text = parseText(body.text);
    const targets = store.getBroadcastTargets({ includePaused: false });
    const queued = store.enqueueMany(targets.map((user) => ({ userId: user.id, text, source: 'broadcast' })));
    log.info('管理后台广播已入队', { count: queued.length });
    res.status(202).json({ queued: queued.map(queuedItem), count: queued.length });
  });

  app.get('/api/admin/messages', auth.requireAdmin, (req, res) => {
    const direction = typeof req.query.direction === 'string' && req.query.direction !== '' ? req.query.direction : 'all';
    if (!MESSAGE_DIRECTIONS.has(direction)) throw badRequest('direction 只能是 inbound | outbound | all');
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    if (status !== '' && !MESSAGE_STATUSES.has(status)) {
      throw badRequest('status 只能是 queued | sending | sent | failed | received');
    }
    const result = store.listMessages({
      direction,
      status,
      userId: typeof req.query.userId === 'string' ? req.query.userId : '',
      groupId: typeof req.query.groupId === 'string' ? req.query.groupId.trim() : '',
      limit: parseLimit(req.query.limit, 50, 500),
      offset: parseOffset(req.query.offset),
    });
    res.json(result);
  });

  app.get('/api/admin/config', auth.requireAdmin, (req, res) => {
    res.json({
      version: config.version,
      rateLimit: { max: config.push.rateLimitMax, windowMs: config.push.rateLimitWindowMs },
      binding: {
        ttlMs: config.binding.ttlMs,
        maxRefreshes: config.binding.maxRefreshes,
        maxActiveSessions: config.binding.maxActiveSessions,
      },
      pushApiEnabled: config.pushApiEnabled,
      apiTokenPreview: config.pushApiEnabled ? previewToken(config.secrets.apiToken) : '已禁用',
      // 无 env 回退后管理密码只由 DB 管理（首次启动随机生成），不存在“默认密码”状态
      adminPasswordIsDefault: false,
      adminPasswordSource: 'db',
      dataDir: config.dataDir,
      media: { ...media.getMediaLimits(), dir: config.media.dir },
      keepalive: {
        enabled: config.keepalive.enabled,
        windowMs: config.keepalive.windowMs,
        leadMs: config.keepalive.leadMs,
        tickMs: config.keepalive.tickMs,
        maxPerTick: config.keepalive.maxPerTick,
        text: config.keepalive.text,
      },
    });
  });

  // 运行配置（后台可改设置，docs/SETTINGS.md §3）
  app.get('/api/admin/settings', auth.requireAdmin, (req, res) => {
    res.json(settings.getSettings());
  });

  app.patch('/api/admin/settings', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    const result = settings.updateSettings(body);
    log.info('运行配置已更新（API）', { restartRequired: result.restartRequired });
    res.json(result);
  });

  app.post('/api/admin/settings/reset', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    if (typeof body.group !== 'string' || body.group.trim() === '') {
      throw badRequest('group 必须是非空字符串');
    }
    const result = settings.resetGroup(body.group.trim());
    log.info('运行配置分组已恢复默认（API）', { group: body.group.trim() });
    res.json(result);
  });

  // 机密管理（docs/SETTINGS.md §7.3）：管理密码 / API Token（事件不记机密值）
  app.post('/api/admin/security/password', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    if (typeof body.currentPassword !== 'string' || body.currentPassword === '') {
      throw badRequest('currentPassword 必须是非空字符串');
    }
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 8 || body.newPassword.length > 128) {
      throw badRequest('newPassword 长度必须是 8..128');
    }
    const result = settings.changeAdminPassword(body.currentPassword, body.newPassword);
    log.info('管理密码已更新', { source: result.adminPasswordSource });
    res.json(result);
  });

  app.post('/api/admin/security/password/reset', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    if (typeof body.currentPassword !== 'string' || body.currentPassword === '') {
      throw badRequest('currentPassword 必须是非空字符串');
    }
    const result = settings.resetAdminPassword(body.currentPassword);
    log.info('管理密码已恢复环境变量默认', { source: result.adminPasswordSource });
    res.json(result);
  });

  app.post('/api/admin/security/api-token/rotate', auth.requireAdminWrite, (req, res) => {
    const result = settings.rotateApiToken();
    // 注意：Token 明文只在本次响应用户主动复制，不写日志/事件
    log.info('API Token 已重新生成（DB 密文）');
    res.json(result);
  });

  app.post('/api/admin/security/api-token/reset', auth.requireAdminWrite, (req, res) => {
    const result = settings.resetApiToken();
    log.info('API Token 已恢复环境变量默认', { source: result.apiTokenSource });
    res.json(result);
  });

  // 管理端：重启容器（依赖 docker-compose restart: unless-stopped；非容器环境返回 409）
  let lastRestartRequestAt = 0;
  const RESTART_COOLDOWN_MS = 15000;
  app.post('/api/admin/system/restart', auth.requireAdminWrite, (req, res) => {
    // 仅生产容器环境允许自重启（依赖 docker-compose restart: unless-stopped）；
    // 测试环境（NODE_ENV=test）或非容器运行返回 409，避免误杀进程。
    const inContainer =
      process.env.NODE_ENV === 'production' &&
      (fs.existsSync('/.dockerenv') || String(process.env.DATA_DIR || '') === '/app/data');
    if (!inContainer) {
      throw conflict('当前非生产容器运行环境，无法自动重启容器；请手动重启服务');
    }
    const now = Date.now();
    if (now - lastRestartRequestAt < RESTART_COOLDOWN_MS) {
      throw new AppError(ErrorCodes.RATE_LIMITED, '重启请求过于频繁，请稍后再试', { status: 429 });
    }
    lastRestartRequestAt = now;
    store.addEvent({ type: 'system_restart', detail: 'admin request' });
    log.info('管理员请求重启容器');
    res.status(202).json({
      ok: true,
      message: '容器将在约 1 秒后重启，请稍候刷新页面',
      etaSeconds: 10,
    });
    setTimeout(() => {
      try {
        process.kill(process.pid, 'SIGTERM');
      } catch {
        process.exit(0);
      }
    }, 1000).unref();
  });


  // 管理后台：媒体上传（原始二进制 + X-File-Name）与读取（预览/下载，支持 Range）
  app.post('/api/admin/media', auth.requireAdminWrite, parseRawMediaBody, async (req, res) => {
    await handleMediaUpload(req, res, { urlPrefix: MEDIA_ADMIN_PREFIX });
  });

  app.get('/api/admin/media/:id', auth.requireAdmin, async (req, res) => {
    await sendMediaFile(req, res);
  });

  // -------------------------------------------------------------------------
  // 对外推送 API（API Key）
  // -------------------------------------------------------------------------

  app.post('/api/v1/messages', auth.requireApiKey, (req, res) => {
    const body = requireJsonBody(req);
    const text = parseOptionalText(body.text);
    const attachment = resolveOutboundAttachment(body.mediaId);
    if (text === '' && !attachment) throw badRequest('text 与 mediaId 至少提供一个');
    if (!Array.isArray(body.to) || body.to.length === 0) throw badRequest('to 必须是非空的用户 id 数组');
    if (body.to.length > 100) throw badRequest('to 最多包含 100 个用户 id');
    const ids = [];
    for (const item of body.to) {
      if (typeof item !== 'string' || item.trim() === '') throw badRequest('to 中的用户 id 必须是非空字符串');
      ids.push(item.trim());
    }
    const uniqueIds = [...new Set(ids)];
    const rows = store.getUsersByIds(uniqueIds);
    const rowMap = new Map(rows.map((row) => [row.id, row]));

    const unknownUserIds = [];
    const validUserIds = [];
    for (const id of uniqueIds) {
      const row = rowMap.get(id);
      if (!row || row.status !== 'active') unknownUserIds.push(id);
      else validUserIds.push(id);
    }
    if (validUserIds.length === 0) {
      throw new AppError(ErrorCodes.NOT_FOUND, '所有用户均不存在或未绑定', {
        status: 404,
        details: { unknownUserIds },
      });
    }
    const queued = store.enqueueMany(
      validUserIds.map((userId) => ({ userId, text, source: 'api', mediaId: attachment?.id ?? null })),
    );
    const payload = {
      accepted: queued.length,
      queued: queued.map((row) => queuedItem(row, { attachment, urlPrefix: MEDIA_V1_PREFIX })),
    };
    if (unknownUserIds.length > 0) payload.unknownUserIds = unknownUserIds;
    res.status(202).json(payload);
  });

  // 对外 API：媒体上传（原始二进制 + X-File-Name）与读取（供外部系统拉取）
  app.post('/api/v1/media', auth.requireApiKey, parseRawMediaBody, async (req, res) => {
    await handleMediaUpload(req, res, { urlPrefix: MEDIA_V1_PREFIX });
  });

  app.get('/api/v1/media/:id', auth.requireApiKey, async (req, res) => {
    await sendMediaFile(req, res);
  });

  app.post('/api/v1/broadcast', auth.requireApiKey, (req, res) => {
    const body = requireJsonBody(req);
    const text = parseText(body.text);
    const onlyBound = body.onlyBound !== false;
    const targets = store.getBroadcastTargets({ includePaused: !onlyBound });
    const queued = store.enqueueMany(targets.map((user) => ({ userId: user.id, text, source: 'broadcast' })));
    res.status(202).json({ accepted: queued.length, queued: queued.map(queuedItem) });
  });

  app.get('/api/v1/messages/:outboxId', auth.requireApiKey, (req, res) => {
    const row = store.getOutbox(req.params.outboxId, { urlPrefix: MEDIA_V1_PREFIX });
    if (!row) throw notFound('消息不存在');
    res.json({
      id: row.id,
      userId: row.userId,
      status: row.status,
      attempts: row.attempts,
      error: row.error,
      serverMessageId: row.serverMessageId,
      createdAt: row.createdAt,
      sentAt: row.sentAt,
      source: row.source,
      attachments: row.attachments,
    });
  });

  app.get('/api/v1/users', auth.requireApiKey, (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : 'active';
    if (!USER_STATUSES.has(status)) throw badRequest('status 只能是 active | unbound | paused | all');
    const result = store.listUsers({ status, limit: parseLimit(req.query.limit, 100, 500), offset: parseOffset(req.query.offset) });
    res.json({
      items: result.items.map((user) => ({
        id: user.id,
        displayName: user.displayName,
        status: user.status,
        boundAt: user.boundAt,
        hasContextToken: user.hasContextToken,
        groups: user.groups ?? [],
        keepaliveEnabled: Boolean(user.keepaliveEnabled),
      })),
    });
  });

  // -------------------------------------------------------------------------
  // 对外 API：用户分组 + 入站消息（docs/GROUPS_AND_INBOUND.md §4）
  // -------------------------------------------------------------------------

  app.get('/api/v1/groups', auth.requireApiKey, (req, res) => {
    res.json({ items: store.listGroups().map(v1GroupView) });
  });

  app.post('/api/v1/groups/:groupId/messages', auth.requireApiKey, (req, res) => {
    const body = requireJsonBody(req);
    const result = queueGroupMessage(req.params.groupId, body, MEDIA_V1_PREFIX);
    res.status(202).json({ accepted: result.count, queued: result.queued });
  });

  /**
   * 拉取入站消息（ASC by received_at,id；cursor 优先于 since；wait 长轮询）。
   * 响应：{items, nextCursor, hasMore, serverTime}
   */
  app.get('/api/v1/inbound/messages', auth.requireApiKey, async (req, res) => {
    const params = parseInboundQuery(req.query);
    const startedAt = Date.now();
    const deadline = startedAt + params.wait * 1000;
    const queryOnce = () =>
      store.listInboundForApi({
        limit: params.limit,
        since: params.since,
        cursor: params.cursor,
        userId: params.userId,
        groupId: params.groupId,
        urlPrefix: MEDIA_V1_PREFIX,
      });

    let result = queryOnce();
    // wait>0 且当前无新消息：每 500ms 重新查询，直到出现新消息或超时
    while (result.items.length === 0 && params.wait > 0 && Date.now() < deadline) {
      await sleepMs(Math.min(INBOUND_WAIT_POLL_MS, Math.max(1, deadline - Date.now())));
      result = queryOnce();
    }

    res.json({
      items: result.items,
      // 无数据时按契约返回传入游标原样（可能为 null）
      nextCursor: result.items.length > 0 ? result.nextCursor : (req.query.cursor ? String(req.query.cursor) : null),
      hasMore: result.hasMore,
      serverTime: Date.now(),
    });
  });

  // -------------------------------------------------------------------------
  // 静态页面
  // -------------------------------------------------------------------------

  app.use(express.static(WEB_DIR, { index: false, fallthrough: true }));
  app.get('/', (req, res, next) => sendPage(res, 'index.html', next));
  app.get('/bind', (req, res, next) => sendPage(res, 'index.html', next));
  app.get('/admin', (req, res, next) => sendPage(res, 'admin.html', next));
  app.get('/docs', (req, res, next) => sendPage(res, 'docs.html', next));

  // -------------------------------------------------------------------------
  // 404 / 错误处理
  // -------------------------------------------------------------------------

  app.use((req, res) => {
    res.status(404).json({ error: { code: ErrorCodes.NOT_FOUND, message: '接口或页面不存在' } });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    let response;
    const isMediaUploadPath = req.path === '/api/admin/media' || req.path === '/api/v1/media';
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
    const requestInfo = { method: req.method, path: req.originalUrl, status: response.status, message: err?.message };
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
  });

  return app;
}
