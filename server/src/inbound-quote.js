/**
 * 入站引用消息（quote / partial quote）最小解析。
 *
 * 对齐官方 @tencent-weixin/openclaw-weixin@2.4.10：
 * - `messaging/inbound.js:218-246`：解析 `item_list[].ref_msg` 的
 *   `title` / `message_item` / `svr_id` / `msg_id`，得到引用正文（title | body）与 ReplyToId；
 * - `messaging/partial-quote.js:34-50`：解析 `partial_text` 的
 *   `start` / `end` / `startindex` / `endindex` / `quotemd5`，还原“部分引用”片段。
 *
 * ClawBridge 没有官方的 quote-store（本地消息引用缓存），因此这里只做协议字段解析与纯函数还原，
 * 不读取 DB；引用媒体由 media 层后续按 `ref_msg` 处理（本模块只提取媒体类型/文件名元数据）。
 */

import crypto from 'node:crypto';

/** 官方 getMediaLabel()：媒体 item 的正文占位（不带文件名）。 */
export const QUOTED_MEDIA_LABELS = Object.freeze({
  2: '[图片]',
  3: '[语音]',
  4: '[文件]',
  5: '[视频]',
});

/**
 * 官方 bodyFromItemList() 顺序：按 item 顺序，首个可识别项决定正文——
 * TEXT 文本 → VOICE 转写文本 → 媒体占位（图片/视频/文件/语音）。
 * @param {Array<object>|undefined} itemList
 * @returns {string}
 */
export function extractBodyFromItemList(itemList) {
  if (!Array.isArray(itemList) || itemList.length === 0) return '';
  for (const item of itemList) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 1 && item.text_item && item.text_item.text !== null && item.text_item.text !== undefined) {
      return String(item.text_item.text);
    }
    if (item.type === 3 && item.voice_item && item.voice_item.text) {
      return String(item.voice_item.text);
    }
    if (Object.prototype.hasOwnProperty.call(QUOTED_MEDIA_LABELS, item.type)) {
      return QUOTED_MEDIA_LABELS[item.type];
    }
  }
  return '';
}

/** 官方 findReferenceItem()：找到带 `ref_msg` 的 item（通常就是当前消息 item）。 */
export function findReferenceItem(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  return items.find((item) => item && typeof item === 'object' && item.ref_msg) ?? null;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 引用消息中的首个媒体 item（仅元数据，不包含 aes_key 等敏感字段）。 */
function quotedMedia(messageItem) {
  const items = Array.isArray(messageItem?.item_list) ? messageItem.item_list : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(QUOTED_MEDIA_LABELS, item.type)) continue;
    let kind = 'video';
    if (item.type === 2) kind = 'image';
    else if (item.type === 3) kind = 'voice';
    else if (item.type === 4) kind = 'file';
    return {
      kind,
      itemType: item.type,
      fileName: item.type === 4 && item.file_item ? trimString(item.file_item.file_name) : '',
    };
  }
  return null;
}

function normalizePartialText(partial) {
  if (!partial || typeof partial !== 'object') return null;
  const start = trimString(partial.start);
  const end = trimString(partial.end);
  if (!start || !end) return null;
  const startIndex = Number(partial.startindex);
  const endIndex = Number(partial.endindex);
  return {
    start,
    end,
    startindex: Number.isInteger(startIndex) && startIndex >= 0 ? startIndex : 0,
    endindex: Number.isInteger(endIndex) && endIndex >= 0 ? endIndex : 0,
    quotemd5: trimString(partial.quotemd5).toLowerCase(),
  };
}

function nthIndexOf(text, value, occurrence, fromIndex = 0) {
  if (!value || !Number.isInteger(occurrence) || occurrence < 0) return -1;
  let position = fromIndex;
  for (let current = 0; current <= occurrence; current += 1) {
    position = text.indexOf(value, position);
    if (position < 0) return -1;
    if (current < occurrence) position += value.length;
  }
  return position;
}

function hashQuote(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

function candidate(fullText, partial, endSearchMode) {
  const start = nthIndexOf(fullText, partial.start, partial.startindex);
  if (start < 0) return null;
  const end =
    endSearchMode === 'global'
      ? nthIndexOf(fullText, partial.end, partial.endindex)
      : nthIndexOf(fullText, partial.end, partial.endindex, start + partial.start.length);
  if (end < start) return null;
  return fullText.slice(start, end + partial.end.length);
}

/**
 * 官方 resolvePartialQuote()：同时尝试 endindex 的 global/relative 两种解释；
 * 有 quotemd5 时用它消歧，无 hash 时取 global 命中。
 * @param {string} fullText 被引用的完整正文（来自本地消息缓存）
 * @param {{start:string,end:string,startindex:number,endindex:number,quotemd5?:string}} partial
 * @returns {{resolved:string|null, fallback:boolean}}
 */
export function resolvePartialQuote(fullText, partial) {
  if (!fullText || !partial || !partial.start || !partial.end) {
    return { resolved: null, fallback: true };
  }
  const candidates = [candidate(fullText, partial, 'global'), candidate(fullText, partial, 'relative')].filter(
    (value, index, all) => Boolean(value) && all.indexOf(value) === index,
  );
  const expected = typeof partial.quotemd5 === 'string' ? partial.quotemd5.toLowerCase() : '';
  if (!expected) {
    return candidates[0] ? { resolved: candidates[0], fallback: false } : { resolved: null, fallback: true };
  }
  const resolved = candidates.find((value) => hashQuote(value) === expected) ?? null;
  return { resolved, fallback: resolved === null };
}

/**
 * 解析入站消息的引用上下文（官方 applyInlineQuoteContext 的纯函数版）。
 * 只读取消息字段，不访问 DB。
 * @param {object} message WeixinMessage（getupdates 的 msgs[] 单项）
 * @returns {null|{replyToId:string, title:string, body:string, quotedText:string,
 *   media:null|{kind:string,itemType:number,fileName:string},
 *   partialQuote:null|{start:string,end:string,startindex:number,endindex:number,quotemd5:string}}}
 */
export function extractQuotedMessage(message) {
  const item = findReferenceItem(message);
  const ref = item?.ref_msg;
  if (!ref || typeof ref !== 'object') return null;

  const title = trimString(ref.title);
  const messageItem = ref.message_item && typeof ref.message_item === 'object' ? ref.message_item : null;
  const body = messageItem ? extractBodyFromItemList(messageItem.item_list) : '';
  const parts = [];
  if (title) parts.push(title);
  if (body) parts.push(body);

  return {
    replyToId: trimString(ref.svr_id) || trimString(messageItem?.msg_id),
    title,
    body,
    quotedText: parts.join(' | '),
    media: quotedMedia(messageItem),
    partialQuote: normalizePartialText(ref.partial_text),
  };
}
