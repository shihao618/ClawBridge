/**
 * 媒体上传/读取/出站附件解析（admin 与 v1 共用，涉及 fs 与 media 模块）。
 *
 * 从 api.js 等价迁出（纯搬迁，行为不变）。
 */
import fs from 'node:fs';

import { config } from '../config.js';
import { AppError, ErrorCodes, badRequest, conflict, notFound } from '../errors.js';
import { logger } from '../logger.js';
import * as media from '../media.js';
import * as store from '../store.js';

import { MEDIA_ADMIN_PREFIX } from './helpers.js';
import { mediaUploadView } from './views.js';

const log = logger.child({ mod: 'api' });

/** 校验出站媒体附件（必须存在、outbound、ready；语音出站不支持）。 */
export function resolveOutboundAttachment(mediaId) {
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
export async function handleMediaUpload(req, res, { urlPrefix = MEDIA_ADMIN_PREFIX } = {}) {
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
export async function sendMediaFile(req, res) {
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
