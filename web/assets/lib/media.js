/**
 * 媒体路径/计数纯函数（无 DOM，可被 node:test 直接 import）。
 */

/**
 * 只接受同源 /api/ 路径（接口返回的媒体 URL），避免把 javascript: 等协议塞进 href/src。
 * @param {unknown} value
 * @returns {string|null}
 */
export function safeMediaPath(value) {
  return typeof value === 'string' && value.startsWith('/api/') ? value : null;
}

/**
 * 附件对外字段兼容：接口可能给 url/downloadUrl，缺失时按 id 兜底拼接。
 * @param {object} attachment
 * @returns {{ url: string|null, downloadUrl: string|null }}
 */
export function attachmentPaths(attachment) {
  const id = typeof attachment.id === 'string' ? attachment.id : '';
  const fallback = id ? `/api/admin/media/${encodeURIComponent(id)}` : null;
  const url = safeMediaPath(attachment.url) || fallback;
  const downloadUrl =
    safeMediaPath(attachment.downloadUrl) ||
    (url ? `${url}${url.includes('?') ? '&' : '?'}download=1` : null);
  return { url, downloadUrl };
}

/**
 * 将接口返回的计数归一化为非负整数（非法值回退 0）。
 * @param {unknown} value
 * @returns {number}
 */
export function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
