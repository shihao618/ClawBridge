/**
 * 多媒体（图片/视频/文件/语音）协议与存储工具。
 *
 * 依据微信官方 @tencent-weixin/openclaw-weixin@2.4.10（MIT）的 CDN 管线实现：
 *   - 出站：getuploadurl → AES-128-ECB(PKCS7) 加密 → POST CDN（读 x-encrypted-param）
 *   - 入站：media.full_url 或 {cdn}/download?encrypted_query_param=… → AES-128-ECB 解密
 * 详细契约见 docs/MEDIA.md。本模块只做协议/IO/存储，不访问数据库。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';
import { getUploadUrl, UploadMediaType } from './ilink.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'media' });

export const MediaKind = Object.freeze({ IMAGE: 'image', VIDEO: 'video', FILE: 'file', VOICE: 'voice' });
/** 入站单条消息最多处理的媒体 item 数（防御性上限）。 */
export const MAX_MEDIA_ITEMS_PER_MESSAGE = 5;
const CDN_UPLOAD_MAX_RETRIES = 3;

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
// HTTP 下载（带超时与大小限制）
// ---------------------------------------------------------------------------

/**
 * 下载 URL 到 Buffer，带超时与最大字节数保护。
 * @param {string} url
 * @param {{timeoutMs?:number, maxBytes?:number, headers?:Record<string,string>}} [options]
 */
export async function fetchBuffer(url, { timeoutMs = config.media.downloadTimeoutMs, maxBytes = config.media.inboundMaxBytes, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`媒体下载失败 HTTP ${res.status} ${res.statusText}`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
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
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 下载并解密一条入站媒体。
 * @param {{cdnBaseUrl?:string, media:{encrypt_query_param?:string, aes_key?:string, full_url?:string}, aesKeyOverride?:string, timeoutMs?:number, maxBytes?:number}} params
 */
export async function downloadAndDecryptInbound({ cdnBaseUrl = config.ilink.cdnBaseUrl, media, aesKeyOverride, timeoutMs, maxBytes } = {}) {
  const aesKeyBase64 = aesKeyOverride || media?.aes_key;
  const encryptedParam = media?.encrypt_query_param;
  const fullUrl = media?.full_url;
  if (!encryptedParam && !fullUrl) throw new Error('媒体缺少下载参数');
  const url = fullUrl || buildCdnDownloadUrl(encryptedParam, cdnBaseUrl);
  const ciphertext = await fetchBuffer(url, { timeoutMs, maxBytes });
  if (!aesKeyBase64) {
    // 无密钥时返回原始字节（极少数明文媒体）
    return { buffer: ciphertext, encrypted: false };
  }
  const key = parseAesKey(aesKeyBase64);
  return { buffer: aesEcbDecrypt(ciphertext, key), encrypted: true };
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
  // 修正已存在目录的权限（volume 首次创建可能是 0755）
  for (const sub of ['outbound', 'inbound']) {
    try {
      await fs.chmod(path.join(config.media.dir, sub), 0o700);
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
