/**
 * 多媒体（图片/视频/文件/语音）协议与存储工具。
 *
 * 依据微信官方 @tencent-weixin/openclaw-weixin@2.4.10（MIT）的 CDN 管线实现：
 *   - 出站：getuploadurl → AES-128-ECB(PKCS7) 加密 → POST CDN（读 x-encrypted-param）
 *   - 入站：media.full_url 或 {cdn}/download?encrypted_query_param=… → AES-128-ECB 解密
 * 详细契约见 docs/MEDIA.md。本模块只做协议/IO/存储，不访问数据库。
 */
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { config } from './config.js';
import { getUploadUrl, UploadMediaType } from './ilink.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'media' });

export const MediaKind = Object.freeze({ IMAGE: 'image', VIDEO: 'video', FILE: 'file', VOICE: 'voice' });
/** 入站单条消息最多处理的媒体 item 数（防御性上限）。 */
export const MAX_MEDIA_ITEMS_PER_MESSAGE = 5;
const CDN_UPLOAD_MAX_RETRIES = 3;

// BA-05：入站下载 URL 校验与重定向限制。
const INBOUND_MAX_REDIRECTS = 3;
const INBOUND_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** 默认信任的 iLink / 微信 CDN 域名后缀（仅 https 默认放行；http 需显式配置或本机）。 */
const TRUSTED_MEDIA_HOST_SUFFIXES = ['.qq.com', '.weixin.qq.com'];
const LOOPBACK_HOSTS = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1']);

// BA-02：入站媒体下载进程级有界并发闸门（默认并发 2 / 排队 64，超出直接失败）。
const INBOUND_GATE_DEFAULT_MAX_CONCURRENT = 2;
const INBOUND_GATE_DEFAULT_MAX_QUEUE = 64;

// ---------------------------------------------------------------------------
// MIME / 文件名
// ---------------------------------------------------------------------------

const EXTENSION_TO_MIME = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const MIME_TO_EXTENSION = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/silk': '.silk',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-tar': '.tar',
  'application/gzip': '.gz',
  'text/plain': '.txt',
  'text/csv': '.csv',
};

/** 规范化 MIME：去参数、小写。 */
export function normalizeMime(raw) {
  const value = String(raw ?? '').split(';')[0].trim().toLowerCase();
  return value || 'application/octet-stream';
}

export function getMimeFromFilename(filename) {
  const ext = path.extname(String(filename ?? '')).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? 'application/octet-stream';
}

export function getExtensionFromMime(mimeType) {
  return MIME_TO_EXTENSION[normalizeMime(mimeType)] ?? '.bin';
}

/** 清洗客户端文件名：去目录、控制字符，限制长度；保留扩展名。 */
export function sanitizeFileName(rawName, fallback = 'file.bin') {
  let name = String(rawName ?? '').trim();
  if (!name) return fallback;
  try {
    name = decodeURIComponent(name);
  } catch {
    /* 已是普通文件名 */
  }
  name = name.replace(/\\/g, '/').split('/').pop() ?? '';
  // 去除控制字符与路径穿越字符
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  if (!name) return fallback;
  if (name.length > 120) {
    const ext = path.extname(name);
    name = `${name.slice(0, Math.max(1, 120 - ext.length))}${ext}`;
  }
  return name;
}

/**
 * 根据 MIME / 文件名判断出站媒体类型。
 * 只有在 config.media.allowedImageMime / allowedVideoMime 白名单内的类型才会按图片/视频发送，
 * 其余（如 image/svg+xml、image/tiff、未知扩展名）一律按普通文件发送（与 docs/MEDIA.md §3.2 一致）。
 */
export function detectKind({ mime, fileName } = {}) {
  const normalized = normalizeMime(mime);
  if (config.media.allowedImageMime.includes(normalized)) return MediaKind.IMAGE;
  if (config.media.allowedVideoMime.includes(normalized)) return MediaKind.VIDEO;
  const byName = getMimeFromFilename(fileName);
  if (byName !== 'application/octet-stream') {
    if (config.media.allowedImageMime.includes(byName)) return MediaKind.IMAGE;
    if (config.media.allowedVideoMime.includes(byName)) return MediaKind.VIDEO;
  }
  return MediaKind.FILE;
}

/** 简单魔数嗅探（入站图片/视频没有 mime 时使用）。 */
export function sniffMime(buffer, fallback = 'application/octet-stream') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return fallback;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  return fallback;
}

export function mediaKindToUploadType(kind) {
  if (kind === MediaKind.IMAGE) return UploadMediaType.IMAGE;
  if (kind === MediaKind.VIDEO) return UploadMediaType.VIDEO;
  return UploadMediaType.FILE;
}

// ---------------------------------------------------------------------------
// AES-128-ECB（与微信 CDN 一致：PKCS7 填充）
// ---------------------------------------------------------------------------

export function aesEcbEncrypt(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function aesEcbDecrypt(ciphertext, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** AES-128-ECB + PKCS7 的密文长度。 */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * 解析 CDNMedia.aes_key 的 base64 形态：
 *   - base64(raw 16 bytes)          → 图片
 *   - base64(32 字符 hex 字符串)     → 文件/语音/视频
 */
export function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(String(aesKeyBase64 ?? ''), 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`无法解析媒体 aes_key（解码后 ${decoded.length} 字节）`);
}

// ---------------------------------------------------------------------------
// CDN URL
// ---------------------------------------------------------------------------

export function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl = config.ilink.cdnBaseUrl) {
  return `${String(cdnBaseUrl).replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export function buildCdnUploadUrl(uploadParam, filekey, cdnBaseUrl = config.ilink.cdnBaseUrl) {
  return `${String(cdnBaseUrl).replace(/\/+$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

// ---------------------------------------------------------------------------
// 入站下载 URL 校验（BA-05：协议/主机白名单 + 手动重定向）
// ---------------------------------------------------------------------------

/** 规范化主机名：小写、去掉 IPv6 方括号与结尾点。 */
function normalizeHostname(hostname) {
  return String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

function hostnameOfUrl(raw) {
  try {
    return normalizeHostname(new URL(String(raw)).hostname);
  } catch {
    return '';
  }
}

function isLoopbackHostname(hostname) {
  if (!hostname) return false;
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname === '::1';
}

/** 显式信任主机：iLink/CDN 配置主机、调用方传入的 cdnBaseUrl 主机、media.allowedHosts。 */
function explicitTrustedHosts(cdnBaseUrl) {
  const hosts = new Set();
  for (const raw of [config.ilink.cdnBaseUrl, config.ilink.defaultBaseUrl, config.ilink.loginBaseUrl, cdnBaseUrl]) {
    const host = hostnameOfUrl(raw);
    if (host) hosts.add(host);
  }
  for (const raw of Array.isArray(config.media.allowedHosts) ? config.media.allowedHosts : []) {
    const host = normalizeHostname(raw);
    if (host) hosts.add(host);
  }
  return hosts;
}

function isSuffixTrustedHostname(hostname) {
  return TRUSTED_MEDIA_HOST_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix));
}

/**
 * 校验入站媒体下载 URL（BA-05）：
 * - 仅允许 http/https，禁止 userinfo；
 * - 主机必须在白名单：iLink/CDN 配置主机、media.allowedHosts、微信 CDN 域名后缀、本机（非生产）；
 * - http 只允许指向显式白名单主机/本机，或显式开启 media.allowInsecureHttp。
 * @param {string|URL} rawUrl
 * @param {{cdnBaseUrl?:string}} [options]
 * @returns {URL}
 */
export function assertInboundDownloadUrl(rawUrl, { cdnBaseUrl = config.ilink.cdnBaseUrl } = {}) {
  let url;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(String(rawUrl));
  } catch {
    throw new Error(`媒体下载 URL 非法：${String(rawUrl).slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`媒体下载 URL 协议不支持（仅允许 http/https）：${url.protocol}`);
  }
  if (url.username || url.password) throw new Error('媒体下载 URL 不允许包含 userinfo（user:pass@）');
  const hostname = normalizeHostname(url.hostname);
  const explicit = explicitTrustedHosts(cdnBaseUrl).has(hostname);
  const loopback = isLoopbackHostname(hostname);
  const suffixTrusted = isSuffixTrustedHostname(hostname);
  const allowInsecureHttp = config.media.allowInsecureHttp === true;
  // 生产环境默认不允许访问本机；开发/测试环境放行（mock/demo 场景），也可由 allowInsecureHttp 显式开启。
  const loopbackAllowed = loopback && (config.isProduction ? allowInsecureHttp : true);
  if (!explicit && !suffixTrusted && !loopbackAllowed) {
    throw new Error(`媒体下载 URL 主机不在允许列表：${hostname || '(空)'}`);
  }
  if (url.protocol === 'http:' && !explicit && !loopbackAllowed && !allowInsecureHttp) {
    throw new Error(`媒体下载 URL 仅允许 https：${hostname}`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// HTTP 下载（带超时、大小限制、手动重定向与 URL 校验）
// ---------------------------------------------------------------------------

function toTimeoutError(err, timeoutMs) {
  if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
    return new Error(`媒体下载超时（>${timeoutMs}ms）`);
  }
  return err;
}

/**
 * 发起入站下载请求（BA-05：redirect:'manual' + 每跳 URL 校验 + 最多 3 跳）。
 * 返回最终 2xx 响应与 clearTimer；调用方必须 clearTimer 并消费/取消 response body。
 */
async function fetchInboundResponse(rawUrl, { timeoutMs = config.media.downloadTimeoutMs, headers, cdnBaseUrl } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  const clearTimer = () => clearTimeout(timer);
  try {
    let current = assertInboundDownloadUrl(rawUrl, { cdnBaseUrl });
    for (let hop = 0; ; hop += 1) {
      const res = await fetch(current, { headers, signal: controller.signal, redirect: 'manual' });
      if (INBOUND_REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        try {
          await res.body?.cancel();
        } catch {
          /* 释放连接失败可忽略 */
        }
        if (!location) throw new Error(`媒体下载失败：重定向缺少 Location（HTTP ${res.status}）`);
        if (hop >= INBOUND_MAX_REDIRECTS) throw new Error(`媒体下载重定向次数过多（>${INBOUND_MAX_REDIRECTS} 次）`);
        current = assertInboundDownloadUrl(new URL(location, current), { cdnBaseUrl });
        continue;
      }
      if (!res.ok) throw new Error(`媒体下载失败 HTTP ${res.status} ${res.statusText}`);
      return { res, clearTimer };
    }
  } catch (err) {
    clearTimer();
    throw toTimeoutError(err, timeoutMs);
  }
}

/**
 * 下载 URL 到 Buffer，带超时与最大字节数保护。
 * @param {string} url
 * @param {{timeoutMs?:number, maxBytes?:number, headers?:Record<string,string>}} [options]
 */
export async function fetchBuffer(url, { timeoutMs = config.media.downloadTimeoutMs, maxBytes = config.media.inboundMaxBytes, headers } = {}) {
  const { res, clearTimer } = await fetchInboundResponse(url, { timeoutMs, headers });
  try {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await res.body?.cancel();
      } catch {
        /* 忽略 */
      }
      throw new Error(`媒体超过大小上限（${declared} > ${maxBytes} 字节）`);
    }
    const chunks = [];
    let total = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) throw new Error(`媒体超过大小上限（>${maxBytes} 字节）`);
        chunks.push(Buffer.from(chunk));
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`媒体超过大小上限（${buf.length} > ${maxBytes} 字节）`);
      return buf;
    }
    return Buffer.concat(chunks);
  } catch (err) {
    throw toTimeoutError(err, timeoutMs);
  } finally {
    clearTimer();
  }
}

/** 临时文件路径（MEDIA_DIR/inbound，隐藏 .part 文件，提交前可安全删除）。 */
async function createInboundTempPath(id) {
  await ensureMediaDirs();
  return path.join(config.media.dir, 'inbound', `.tmp-${id}-${crypto.randomBytes(4).toString('hex')}.part`);
}

/**
 * 流式下载 + 流式解密 + 写临时文件（BA-02：整文件不进内存，仅保留 16 字节头部用于 MIME 嗅探）。
 * @returns {Promise<{id:string,tempPath:string,size:number,sha256:string,encrypted:boolean,head:Buffer}>}
 */
async function streamDownloadToTemp({ url, key, id, timeoutMs, maxBytes, cdnBaseUrl }) {
  const tempPath = await createInboundTempPath(id);
  const { res, clearTimer } = await fetchInboundResponse(url, { timeoutMs, cdnBaseUrl });
  let committed = false;
  try {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await res.body?.cancel();
      } catch {
        /* 忽略 */
      }
      throw new Error(`媒体超过大小上限（${declared} > ${maxBytes} 字节）`);
    }
    if (!res.body) {
      await fs.writeFile(tempPath, Buffer.alloc(0), { mode: 0o600 });
      committed = true;
      return {
        id,
        tempPath,
        size: 0,
        sha256: crypto.createHash('sha256').digest('hex'),
        encrypted: Boolean(key),
        head: Buffer.alloc(0),
      };
    }
    let cipherBytes = 0;
    const sizeGuard = new Transform({
      transform(chunk, _encoding, callback) {
        cipherBytes += chunk.length;
        if (cipherBytes > maxBytes) {
          callback(new Error(`媒体超过大小上限（>${maxBytes} 字节）`));
          return;
        }
        callback(null, chunk);
      },
    });
    const hash = crypto.createHash('sha256');
    let plainSize = 0;
    let head = Buffer.alloc(0);
    const plaintextTracker = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        plainSize += chunk.length;
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        callback(null, chunk);
      },
    });
    const stages = [Readable.fromWeb(res.body), sizeGuard];
    if (key) stages.push(crypto.createDecipheriv('aes-128-ecb', key, null));
    stages.push(plaintextTracker, createWriteStream(tempPath, { mode: 0o600, flags: 'wx' }));
    await pipeline(...stages);
    committed = true;
    return { id, tempPath, size: plainSize, sha256: hash.digest('hex'), encrypted: Boolean(key), head };
  } catch (err) {
    throw toTimeoutError(err, timeoutMs);
  } finally {
    clearTimer();
    if (!committed) await fs.unlink(tempPath).catch(() => {});
  }
}

/**
 * 流式下载并解密一条入站媒体到临时文件（BA-02；BA-05 URL 校验）。
 * 成功后需调用 commitInboundTempMedia 落到正式路径；失败/放弃时调用 discardInboundTempMedia。
 * @param {{cdnBaseUrl?:string, media:{encrypt_query_param?:string, aes_key?:string, full_url?:string}, aesKeyOverride?:string, timeoutMs?:number, maxBytes?:number}} params
 * @returns {Promise<{id:string,tempPath:string,size:number,sha256:string,encrypted:boolean,head:Buffer}>}
 */
export async function downloadAndDecryptInboundToTemp({
  cdnBaseUrl = config.ilink.cdnBaseUrl,
  media,
  aesKeyOverride,
  timeoutMs = config.media.downloadTimeoutMs,
  maxBytes = config.media.inboundMaxBytes,
} = {}) {
  const aesKeyBase64 = aesKeyOverride || media?.aes_key;
  const encryptedParam = media?.encrypt_query_param;
  const fullUrl = media?.full_url;
  if (!encryptedParam && !fullUrl) throw new Error('媒体缺少下载参数');
  const url = fullUrl || buildCdnDownloadUrl(encryptedParam, cdnBaseUrl);
  const key = aesKeyBase64 ? parseAesKey(aesKeyBase64) : null;
  const id = generateAttachmentId();
  return streamDownloadToTemp({ url, key, id, timeoutMs, maxBytes, cdnBaseUrl });
}

/** 把 staged 临时文件原子 rename 到正式 inbound 路径（0600），返回与 saveMediaBuffer 一致的元数据。 */
export async function commitInboundTempMedia(staged, { mime } = {}) {
  if (!staged?.tempPath) throw new Error('媒体临时文件不存在或已提交');
  await ensureMediaDirs();
  const normalizedMime = normalizeMime(mime);
  const ext = getExtensionFromMime(normalizedMime);
  const relativePath = path.posix.join('inbound', `${staged.id}${ext}`);
  const absolutePath = path.join(config.media.dir, relativePath);
  await fs.rename(staged.tempPath, absolutePath);
  staged.tempPath = '';
  try {
    await fs.chmod(absolutePath, 0o600);
  } catch {
    /* Windows/受限环境忽略 */
  }
  return { id: staged.id, path: relativePath, size: staged.size, sha256: staged.sha256, mime: normalizedMime, ext };
}

/** 丢弃 staged 临时文件（幂等：目录里不留 .part 残留）。 */
export async function discardInboundTempMedia(staged) {
  const tempPath = staged?.tempPath;
  if (!tempPath) return;
  staged.tempPath = '';
  await fs.unlink(tempPath).catch(() => {});
}

/**
 * 下载并解密一条入站媒体（Buffer 版，保留给工具/测试；monitor 走 streaming 版）。
 * @param {{cdnBaseUrl?:string, media:{encrypt_query_param?:string, aes_key?:string, full_url?:string}, aesKeyOverride?:string, timeoutMs?:number, maxBytes?:number}} params
 */
export async function downloadAndDecryptInbound({
  cdnBaseUrl = config.ilink.cdnBaseUrl,
  media,
  aesKeyOverride,
  timeoutMs = config.media.downloadTimeoutMs,
  maxBytes = config.media.inboundMaxBytes,
} = {}) {
  const aesKeyBase64 = aesKeyOverride || media?.aes_key;
  const encryptedParam = media?.encrypt_query_param;
  const fullUrl = media?.full_url;
  if (!encryptedParam && !fullUrl) throw new Error('媒体缺少下载参数');
  const url = fullUrl || buildCdnDownloadUrl(encryptedParam, cdnBaseUrl);
  assertInboundDownloadUrl(url, { cdnBaseUrl });
  const ciphertext = await fetchBuffer(url, { timeoutMs, maxBytes });
  if (!aesKeyBase64) {
    // 无密钥时返回原始字节（极少数明文媒体）
    return { buffer: ciphertext, encrypted: false };
  }
  const key = parseAesKey(aesKeyBase64);
  return { buffer: aesEcbDecrypt(ciphertext, key), encrypted: true };
}

// ---------------------------------------------------------------------------
// 入站下载进程级有界闸门（BA-02）
// ---------------------------------------------------------------------------

/**
 * 有界并发闸门（纯工具，便于单测）：最多 maxConcurrent 个任务执行，其余进入 FIFO 等待队列
 * （最多 maxQueue 个）；排队超时或队列已满时直接拒绝（由调用方按失败附件处理）。
 * @param {{maxConcurrent?:number, maxQueue?:number}} [options]
 */
export function createBoundedGate({
  maxConcurrent = INBOUND_GATE_DEFAULT_MAX_CONCURRENT,
  maxQueue = INBOUND_GATE_DEFAULT_MAX_QUEUE,
} = {}) {
  const limit = Math.max(1, Math.floor(Number(maxConcurrent) || 0));
  const queueLimit = Math.max(0, Math.floor(Number(maxQueue) || 0));
  const counters = { active: 0, accepted: 0, completed: 0, rejected: 0, timedOut: 0 };
  const waiting = [];

  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      counters.completed += 1;
      const next = waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        // 执行槽直接转交给排队者：active 数量不变
        next.resolve(makeRelease());
      } else {
        counters.active -= 1;
      }
    };
  };

  return {
    stats: () => ({
      maxConcurrent: limit,
      maxQueue: queueLimit,
      active: counters.active,
      queued: waiting.length,
      accepted: counters.accepted,
      completed: counters.completed,
      rejected: counters.rejected,
      timedOut: counters.timedOut,
    }),
    /** 获取执行槽；返回幂等 release 函数。队列满/排队超时 → rejected Promise。 */
    acquire(timeoutMs = config.media.inboundQueueTimeoutMs) {
      counters.accepted += 1;
      if (counters.active < limit) {
        counters.active += 1;
        return Promise.resolve(makeRelease());
      }
      if (waiting.length >= queueLimit) {
        counters.rejected += 1;
        return Promise.reject(
          new Error(`媒体下载队列已满（并发 ${counters.active}/${limit}，排队 ${waiting.length}/${queueLimit}）`),
        );
      }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        const waitMs = Math.max(1, Number(timeoutMs) || 1);
        waiter.timer = setTimeout(() => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          counters.timedOut += 1;
          reject(new Error(`媒体下载排队超时（>${waitMs}ms，并发 ${counters.active}/${limit}）`));
        }, waitMs);
        waiter.timer.unref?.();
        waiting.push(waiter);
      });
    },
  };
}

/**
 * 进程级单例闸门：首次使用时按当前运行配置创建。
 * 配置来自 config.media.inboundMaxConcurrent/inboundMaxQueue（settings 覆盖在 loadOverrides 后生效，
 * 因此后台修改并发/排队上限需重启进程）。
 */
let inboundDownloadGate = null;
export function getInboundDownloadGate() {
  if (!inboundDownloadGate) {
    inboundDownloadGate = createBoundedGate({
      maxConcurrent: config.media.inboundMaxConcurrent,
      maxQueue: config.media.inboundMaxQueue,
    });
  }
  return inboundDownloadGate;
}

/** 当前入站下载闸门统计（诊断/测试）。 */
export function getInboundDownloadStats() {
  if (!inboundDownloadGate) {
    return {
      maxConcurrent: config.media.inboundMaxConcurrent,
      maxQueue: config.media.inboundMaxQueue,
      active: 0,
      queued: 0,
      accepted: 0,
      completed: 0,
      rejected: 0,
      timedOut: 0,
    };
  }
  return inboundDownloadGate.stats();
}

/**
 * 在闸门内执行一个入站媒体下载任务（monitor 使用）。
 * 队列已满/排队超时 → 立即抛错（调用方把该附件记为 failed，避免无限堆积）。
 * @template T
 * @param {() => Promise<T>} task
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<T>}
 */
export async function runInboundDownloadWithSlot(task, { timeoutMs = config.media.inboundQueueTimeoutMs } = {}) {
  const gate = getInboundDownloadGate();
  let release;
  try {
    release = await gate.acquire(timeoutMs);
  } catch (err) {
    log.warn('入站媒体下载被闸门拒绝（队列已满或排队超时）', { message: err?.message, stats: gate.stats() });
    throw err;
  }
  try {
    return await task();
  } finally {
    release();
  }
}

/**
 * 从 WeixinMessage 中提取可下载的媒体 item（最多 MAX_MEDIA_ITEMS_PER_MESSAGE 个）。
 * 返回 [{kind, media, fileName, mime, aesKeyOverride, text}]
 */
export function extractInboundMediaItems(message) {
  const items = [];
  const list = Array.isArray(message?.item_list) ? message.item_list : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (items.length >= MAX_MEDIA_ITEMS_PER_MESSAGE) break;
    try {
      if (item.type === 2 && item.image_item) {
        const img = item.image_item;
        const media = img.media ?? {};
        const aesKeyOverride = img.aeskey ? Buffer.from(String(img.aeskey), 'hex').toString('base64') : undefined;
        items.push({ kind: MediaKind.IMAGE, media, fileName: '', mime: '', aesKeyOverride });
      } else if (item.type === 3 && item.voice_item) {
        const voice = item.voice_item;
        items.push({
          kind: MediaKind.VOICE,
          media: voice.media ?? {},
          fileName: 'voice.silk',
          mime: 'audio/silk',
          text: voice.text ? String(voice.text) : '',
        });
      } else if (item.type === 4 && item.file_item) {
        const file = item.file_item;
        const fileName = sanitizeFileName(file.file_name || 'file.bin');
        items.push({ kind: MediaKind.FILE, media: file.media ?? {}, fileName, mime: getMimeFromFilename(fileName) });
      } else if (item.type === 5 && item.video_item) {
        items.push({ kind: MediaKind.VIDEO, media: item.video_item.media ?? {}, fileName: 'video.mp4', mime: 'video/mp4' });
      }
    } catch (err) {
      log.warn('解析入站媒体 item 失败（忽略）', { message: err?.message });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

/** 创建媒体目录（幂等）。 */
export async function ensureMediaDirs() {
  await fs.mkdir(path.join(config.media.dir, 'outbound'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(config.media.dir, 'inbound'), { recursive: true, mode: 0o700 });
  // 修正已存在目录的权限（volume 首次创建可能是 0755/0777）
  for (const dir of [config.media.dir, path.join(config.media.dir, 'outbound'), path.join(config.media.dir, 'inbound')]) {
    try {
      await fs.chmod(dir, 0o700);
    } catch {
      /* Windows/受限环境忽略 */
    }
  }
}

export function generateAttachmentId() {
  return `att_${crypto.randomUUID()}`;
}

/**
 * 保存媒体 Buffer 到 MEDIA_DIR/<direction>/<id><ext>，返回相对路径与元数据。
 * @param {{direction:'inbound'|'outbound', buffer:Buffer, mime?:string, id?:string}} params
 */
export async function saveMediaBuffer({ direction, buffer, mime, id } = {}) {
  if (direction !== 'inbound' && direction !== 'outbound') throw new Error('direction 必须是 inbound/outbound');
  await ensureMediaDirs();
  const attachmentId = id || generateAttachmentId();
  const normalizedMime = normalizeMime(mime);
  const ext = getExtensionFromMime(normalizedMime);
  const relativePath = path.posix.join(direction, `${attachmentId}${ext}`);
  const absolutePath = path.join(config.media.dir, relativePath);
  await fs.writeFile(absolutePath, buffer, { mode: 0o600 });
  try {
    await fs.chmod(absolutePath, 0o600);
  } catch {
    /* 忽略 */
  }
  return {
    id: attachmentId,
    path: relativePath,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    mime: normalizedMime,
    ext,
  };
}

/** 读取媒体文件（相对 MEDIA_DIR 的路径）。 */
export async function readMediaFile(relativePath) {
  const absolutePath = resolveMediaPath(relativePath);
  return fs.readFile(absolutePath);
}

/** 把相对路径解析为绝对路径，并保证不会超出 MEDIA_DIR（防目录穿越）。 */
export function resolveMediaPath(relativePath) {
  const base = path.resolve(config.media.dir);
  const absolute = path.resolve(base, String(relativePath ?? ''));
  const relative = path.relative(base, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('非法的媒体路径');
  }
  return absolute;
}

// ---------------------------------------------------------------------------
// 出站上传
// ---------------------------------------------------------------------------

/**
 * 上传 Buffer 到微信 CDN（含 getuploadurl + AES-128-ECB 加密 + 重试）。
 * @returns {Promise<{filekey:string, downloadParam:string, aeskeyHex:string, plainSize:number,
 *   cipherSize:number, md5:string, fileName:string}>}
 */
export async function uploadMediaToCdn({
  baseUrl,
  token,
  toUserId,
  kind,
  buffer,
  fileName = 'file.bin',
  cdnBaseUrl = config.ilink.cdnBaseUrl,
  timeoutMs = config.media.uploadTimeoutMs,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('媒体内容为空');
  if (buffer.length > config.media.outboundMaxBytes) {
    throw new Error(`媒体超过大小上限（${buffer.length} > ${config.media.outboundMaxBytes} 字节）`);
  }
  const rawsize = buffer.length;
  const rawfilemd5 = crypto.createHash('md5').update(buffer).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskey = crypto.randomBytes(16);

  const resp = await getUploadUrl({
    baseUrl,
    token,
    filekey,
    mediaType: mediaKindToUploadType(kind),
    toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    noNeedThumb: true,
    aeskey: aeskey.toString('hex'),
    timeoutMs,
  });
  const uploadFullUrl = typeof resp?.upload_full_url === 'string' ? resp.upload_full_url.trim() : '';
  const uploadParam = typeof resp?.upload_param === 'string' ? resp.upload_param : '';
  if (!uploadFullUrl && !uploadParam) {
    throw new Error('getuploadurl 未返回上传地址（upload_full_url/upload_param 均缺失）');
  }
  const cdnUrl = uploadFullUrl || buildCdnUploadUrl(uploadParam, filekey, cdnBaseUrl);
  const ciphertext = aesEcbEncrypt(buffer, aeskey);

  let downloadParam = '';
  let lastError = null;
  for (let attempt = 1; attempt <= CDN_UPLOAD_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    timer.unref?.();
    try {
      const res = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: controller.signal,
      });
      if (res.status >= 400 && res.status < 500) {
        const detail = res.headers.get('x-error-message') || (await res.text().catch(() => ''));
        throw new Error(`CDN 上传客户端错误 ${res.status}: ${detail}`);
      }
      if (res.status !== 200) {
        const detail = res.headers.get('x-error-message') || `status ${res.status}`;
        throw new Error(`CDN 上传服务端错误: ${detail}`);
      }
      downloadParam = res.headers.get('x-encrypted-param') || '';
      if (!downloadParam) throw new Error('CDN 上传响应缺少 x-encrypted-param 头');
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      const clientError = /客户端错误/.test(err?.message ?? '');
      if (clientError || attempt >= CDN_UPLOAD_MAX_RETRIES) break;
      log.warn('CDN 上传失败，准备重试', { attempt, message: err?.message });
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 300 * attempt);
        t.unref?.();
      });
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError) throw lastError;

  log.info('媒体已上传微信 CDN', { filekey, kind, plainSize: rawsize, cipherSize: filesize });
  return {
    filekey,
    downloadParam,
    aeskeyHex: aeskey.toString('hex'),
    plainSize: rawsize,
    cipherSize: filesize,
    md5: rawfilemd5,
    fileName,
  };
}

/** 出站媒体消息 item 构造（image/video/file）。 */
export function buildMediaItem({ kind, uploaded, fileName }) {
  if (!uploaded?.downloadParam || !uploaded?.aeskeyHex) throw new Error('缺少上传结果，无法构造媒体消息');
  // 重要：微信要求 CDNMedia.aes_key = base64(32 字符 hex 明文 key 的 ASCII 字节)，
  // 即 Buffer.from(hexString)（UTF-8）再 base64，而不是 base64(原始 16 字节 key)。
  // 与官方 @tencent-weixin/openclaw-weixin（send.ts: Buffer.from(uploaded.aeskey).toString("base64")，
  // 其中 uploaded.aeskey 是 hex 字符串）以及可用的第三方实现 @claw-lab/wxclawbot-cli 一致。
  // 若误用 base64(raw key)，接收方微信会解密失败：图片灰块、文件点接收提示"已过期"。
  const media = {
    encrypt_query_param: uploaded.downloadParam,
    aes_key: Buffer.from(String(uploaded.aeskeyHex), 'utf8').toString('base64'),
    encrypt_type: 1,
  };
  if (kind === MediaKind.IMAGE) {
    return { type: 2, image_item: { media, mid_size: uploaded.cipherSize } };
  }
  if (kind === MediaKind.VIDEO) {
    return { type: 5, video_item: { media, video_size: uploaded.cipherSize } };
  }
  return {
    type: 4,
    file_item: { media, file_name: sanitizeFileName(fileName || uploaded.fileName || 'file.bin'), len: String(uploaded.plainSize) },
  };
}

/** 允许出站的媒体类型检查（语音出站不支持）。 */
export function assertOutboundKindSupported(kind) {
  if (kind === MediaKind.VOICE) {
    throw new Error('暂不支持发送语音消息（可在管理后台发送图片/视频/文件）');
  }
  if (![MediaKind.IMAGE, MediaKind.VIDEO, MediaKind.FILE].includes(kind)) {
    throw new Error(`不支持的媒体类型：${kind}`);
  }
}

/** 媒体限制信息（给 API 返回/前端展示）。 */
export function getMediaLimits() {
  return {
    maxBytes: config.media.outboundMaxBytes,
    inboundMaxBytes: config.media.inboundMaxBytes,
    allowedImage: config.media.allowedImageMime,
    allowedVideo: config.media.allowedVideoMime,
  };
}
