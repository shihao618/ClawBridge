/**
 * 微信 ClawBot（iLink Bot API）客户端 —— 只依赖内置 fetch。
 *
 * 协议细节见 docs/PROTOCOL.md。实现与官方 @tencent-weixin/openclaw-weixin@2.4.10
 * 的请求头、JSON 结构、状态机语义保持一致（MIT License，Tencent）。
 */
import crypto from 'node:crypto';

import { config } from './config.js';
import { ILinkError } from './errors.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'ilink' });
const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);
const DEFAULT_BOT_AGENT = 'OpenClaw';
const BOT_AGENT_RE = /^[A-Za-z0-9_.-]{1,32}\/[A-Za-z0-9_.+-]{1,32}(?: \([\x20-\x27\x2A-\x7E]{1,64}\))?$/;

export const MessageType = Object.freeze({ NONE: 0, USER: 1, BOT: 2 });
export const MessageItemType = Object.freeze({
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
});
export const MessageState = Object.freeze({ NEW: 0, GENERATING: 1, FINISH: 2 });

/** bot_agent 必须是合法 UA token，否则回退默认值（与官方 sanitizeBotAgent 语义一致）。 */
export function sanitizeBotAgent(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return DEFAULT_BOT_AGENT;
  return BOT_AGENT_RE.test(value) && Buffer.byteLength(value, 'utf8') <= 256 ? value : DEFAULT_BOT_AGENT;
}

export function buildBaseInfo() {
  return {
    channel_version: config.ilink.channelVersion,
    bot_agent: sanitizeBotAgent(config.ilink.botAgent),
  };
}

/** X-WECHAT-UIN: base64(十进制随机 uint32 字符串)，每次请求随机。 */
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf8').toString('base64');
}

/** 构造请求头。token 为空时是未鉴权请求（二维码接口）。 */
export function buildHeaders({ token } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'iLink-App-Id': config.ilink.appId,
    'iLink-App-ClientVersion': String(config.ilink.clientVersion),
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token) {
    headers.Authorization = `Bearer ${String(token).trim()}`;
    headers.AuthorizationType = 'ilink_bot_token';
  }
  if (config.ilink.routeTag) headers.SKRouteTag = config.ilink.routeTag;
  return headers;
}

/**
 * 无损解析：把 message_id / msg_id / svr_id 的 JSON number 字面量预置为字符串，
 * 避免 uint64 超过 2^53 丢精度（移植官方 parseWeixinApiJson 算法）。
 */
export function parseILinkJson(rawText) {
  try {
    let output = '';
    let index = 0;
    while (index < rawText.length) {
      if (rawText[index] !== '"') {
        output += rawText[index++];
        continue;
      }
      const stringStart = index;
      index += 1;
      let escaped = false;
      while (index < rawText.length) {
        const char = rawText[index++];
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') break;
      }
      const stringToken = rawText.slice(stringStart, index);
      output += stringToken;

      let cursor = index;
      while (/\s/.test(rawText[cursor] ?? '')) cursor += 1;
      if (rawText[cursor] !== ':') continue;
      let key;
      try {
        key = JSON.parse(stringToken);
      } catch {
        continue;
      }
      if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue;

      output += rawText.slice(index, cursor + 1);
      cursor += 1;
      while (/\s/.test(rawText[cursor] ?? '')) {
        output += rawText[cursor];
        cursor += 1;
      }
      const numberStart = cursor;
      if (rawText[cursor] === '-') cursor += 1;
      while (/\d/.test(rawText[cursor] ?? '')) cursor += 1;
      if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === '-')) {
        output += `"${rawText.slice(numberStart, cursor)}"`;
        index = cursor;
      } else {
        index = numberStart;
      }
    }
    return JSON.parse(output);
  } catch {
    return JSON.parse(rawText);
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || config.ilink.defaultBaseUrl).replace(/\/+$/, '');
}

/**
 * 通用 JSON 请求。超时 / 外部中止分别抛出带 timeout / aborted 标记的 ILinkError。
 */
async function requestJson({ method, baseUrl, endpoint, body, token, timeoutMs = config.ilink.requestTimeoutMs, abortSignal, label }) {
  const base = normalizeBaseUrl(baseUrl);
  const url = `${base}${endpoint}`;
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  timer.unref?.();

  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  if (abortSignal) {
    if (abortSignal.aborted) onExternalAbort();
    else abortSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    log.debug(`${label} → ${method} ${base}${endpoint}`, { token: token ? 'present' : 'none' });
    const res = await fetch(url, {
      method,
      headers: buildHeaders({ token }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ILinkError(`${label} HTTP ${res.status}`, {
        endpoint: label,
        httpStatus: res.status,
        body: String(text).slice(0, 1000),
      });
    }
    if (!text) throw new ILinkError(`${label} 响应为空`, { endpoint: label });
    return parseILinkJson(text);
  } catch (err) {
    if (err instanceof ILinkError) throw err;
    if (timedOut) {
      throw new ILinkError(`${label} 请求超时（${timeoutMs}ms）`, { endpoint: label, timeout: true, cause: err });
    }
    if (externallyAborted) {
      throw new ILinkError(`${label} 请求已中止`, { endpoint: label, aborted: true, cause: err });
    }
    throw new ILinkError(`${label} 网络错误：${err?.message ?? err}`, { endpoint: label, cause: err });
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener?.('abort', onExternalAbort);
  }
}

// ---------------------------------------------------------------------------
// 二维码登录
// ---------------------------------------------------------------------------

/**
 * 获取登录二维码。
 * @returns {Promise<{qrcode: string, qrcode_img_content: string}>}
 */
export async function getBotQrcode({ localTokenList = [], botType = config.ilink.botType, baseUrl = config.ilink.loginBaseUrl, timeoutMs } = {}) {
  const endpoint = `/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`;
  const resp = await requestJson({
    method: 'POST',
    baseUrl,
    endpoint,
    body: { local_token_list: localTokenList.slice(0, 10) },
    timeoutMs: timeoutMs ?? config.ilink.requestTimeoutMs,
    label: 'get_bot_qrcode',
  });
  if (!resp?.qrcode || !resp?.qrcode_img_content) {
    throw new ILinkError('get_bot_qrcode 响应缺少 qrcode/qrcode_img_content', { endpoint: 'get_bot_qrcode' });
  }
  return resp;
}

/**
 * 轮询扫码状态（服务端长轮询）。超时/网络错误会抛 ILinkError（timeout=true），
 * 由调用方决定是否视为 wait 继续。
 */
export async function getQrcodeStatus({ qrcode, verifyCode, baseUrl = config.ilink.loginBaseUrl, timeoutMs = config.ilink.qrPollTimeoutMs } = {}) {
  let endpoint = `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  const resp = await requestJson({
    method: 'GET',
    baseUrl,
    endpoint,
    timeoutMs,
    label: 'get_qrcode_status',
  });
  if (!resp?.status) throw new ILinkError('get_qrcode_status 响应缺少 status', { endpoint: 'get_qrcode_status' });
  return resp;
}

// ---------------------------------------------------------------------------
// 消息收发
// ---------------------------------------------------------------------------

/**
 * 长轮询接收消息；客户端超时/中止返回空响应（与官方一致，属正常控制流）。
 */
export async function getUpdates({
  baseUrl,
  token,
  getUpdatesBuf = '',
  timeoutMs = config.ilink.longPollTimeoutMs,
  abortSignal,
} = {}) {
  try {
    return await requestJson({
      method: 'POST',
      baseUrl,
      endpoint: '/ilink/bot/getupdates',
      token,
      body: { get_updates_buf: getUpdatesBuf, base_info: buildBaseInfo() },
      timeoutMs,
      abortSignal,
      label: 'getupdates',
    });
  } catch (err) {
    if (err instanceof ILinkError && (err.timeout || err.aborted)) {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

export function createClientId() {
  return `clawbridge-${crypto.randomUUID()}`;
}

/** 构造单条文本消息（SendMessageReq.msg）。 */
export function buildTextMessage({ toUserId, text, contextToken, clientId = createClientId() } = {}) {
  return {
    from_user_id: '',
    to_user_id: String(toUserId),
    client_id: clientId,
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: String(text) } }],
    ...(contextToken ? { context_token: contextToken } : {}),
  };
}

/**
 * 发送消息；ret != 0 抛 ILinkError（ret=-2 限流、-14 token 失效）。
 * @returns {Promise<{message_id?: string, ret?: number}>}
 */
export async function sendMessage({ baseUrl, token, msg, timeoutMs = config.ilink.requestTimeoutMs } = {}) {
  const resp = await requestJson({
    method: 'POST',
    baseUrl,
    endpoint: '/ilink/bot/sendmessage',
    token,
    body: { msg, base_info: buildBaseInfo() },
    timeoutMs,
    label: 'sendmessage',
  });
  if (resp?.ret !== undefined && resp.ret !== 0) {
    throw new ILinkError(`sendmessage 失败 ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`, {
      endpoint: 'sendmessage',
      ret: resp.ret,
      errmsg: resp.errmsg ?? '',
    });
  }
  return resp;
}

/** 发送纯文本消息的便捷封装。 */
export async function sendText({ baseUrl, token, toUserId, text, contextToken, timeoutMs } = {}) {
  const msg = buildTextMessage({ toUserId, text, contextToken });
  const resp = await sendMessage({ baseUrl, token, msg, timeoutMs });
  return { ...resp, clientId: msg.client_id };
}

// ---------------------------------------------------------------------------
// 媒体消息（出站）
// ---------------------------------------------------------------------------

/** proto: UploadMediaType */
export const UploadMediaType = Object.freeze({ IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 });

/**
 * 申请 CDN 上传地址（媒体消息第一步）。
 * @returns {Promise<{upload_param?:string, thumb_upload_param?:string, upload_full_url?:string, ret?:number}>}
 */
export async function getUploadUrl({
  baseUrl,
  token,
  filekey,
  mediaType,
  toUserId,
  rawsize,
  rawfilemd5,
  filesize,
  noNeedThumb = true,
  aeskey,
  timeoutMs = config.ilink.requestTimeoutMs,
} = {}) {
  return requestJson({
    method: 'POST',
    baseUrl,
    endpoint: '/ilink/bot/getuploadurl',
    token,
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: noNeedThumb,
      aeskey,
      base_info: buildBaseInfo(),
    },
    timeoutMs,
    label: 'getuploadurl',
  });
}

/**
 * 发送一条媒体消息（item_list 中只有一个媒体 item，不含 caption）。
 * item 由 media.buildMediaItem() 构造（避免 ilink <-> media 循环依赖）。
 * @param {{baseUrl:string, token:string, toUserId:string, item:object, contextToken?:string, timeoutMs?:number}} params
 */
export async function sendMediaMessage({ baseUrl, token, toUserId, item, contextToken, timeoutMs } = {}) {
  if (!item || typeof item !== 'object') throw new ILinkError('媒体消息 item 为空', { endpoint: 'sendmessage' });
  const clientId = createClientId();
  const msg = {
    from_user_id: '',
    to_user_id: String(toUserId),
    client_id: clientId,
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    item_list: [item],
    ...(contextToken ? { context_token: contextToken } : {}),
  };
  const resp = await sendMessage({ baseUrl, token, msg, timeoutMs });
  return { ...resp, clientId };
}

// ---------------------------------------------------------------------------
// 通道生命周期 / 配置
// ---------------------------------------------------------------------------

export async function notifyStart({ baseUrl, token, timeoutMs = config.ilink.requestTimeoutMs } = {}) {
  return requestJson({
    method: 'POST',
    baseUrl,
    endpoint: '/ilink/bot/msg/notifystart',
    token,
    body: { base_info: buildBaseInfo() },
    timeoutMs,
    label: 'notifystart',
  });
}

export async function notifyStop({ baseUrl, token, timeoutMs = config.ilink.requestTimeoutMs } = {}) {
  return requestJson({
    method: 'POST',
    baseUrl,
    endpoint: '/ilink/bot/msg/notifystop',
    token,
    body: { base_info: buildBaseInfo() },
    timeoutMs,
    label: 'notifystop',
  });
}

export async function getConfig({ baseUrl, token, ilinkUserId, contextToken, timeoutMs = config.ilink.requestTimeoutMs } = {}) {
  return requestJson({
    method: 'POST',
    baseUrl,
    endpoint: '/ilink/bot/getconfig',
    token,
    body: { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: buildBaseInfo() },
    timeoutMs,
    label: 'getconfig',
  });
}

export async function sendTyping({ baseUrl, token, ilinkUserId, typingTicket, status = 1, timeoutMs = config.ilink.requestTimeoutMs } = {}) {
  return requestJson({
    method: 'POST',
    baseUrl,
    endpoint: '/ilink/bot/sendtyping',
    token,
    body: { ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status, base_info: buildBaseInfo() },
    timeoutMs,
    label: 'sendtyping',
  });
}

export { ILinkError };
