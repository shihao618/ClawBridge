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
import { filterWechatMarkdown, layoutWechatText } from './shared/wechat-markdown.js';

const log = logger.child({ mod: 'ilink' });

// 启动日志：打印协议关键参数，便于与官方插件版本对照（官方运行时读 package.json 派生）。
log.info('iLink 协议参数', {
  channelVersion: config.ilink.channelVersion,
  clientVersion: config.ilink.clientVersion,
  appId: config.ilink.appId,
});

const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);
const DEFAULT_BOT_AGENT = 'OpenClaw';
/** bot_agent 清洗后的最大字节数（官方 BOT_AGENT_MAX_LEN）。 */
const BOT_AGENT_MAX_LEN = 256;

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
/** typing 状态（官方 api/types.js TypingStatus）：1=正在输入，2=取消。 */
export const TypingStatus = Object.freeze({ TYPING: 1, CANCEL: 2 });

/** UA product 语法（官方 sanitizeBotAgent 的 productRe）。 */
const BOT_AGENT_PRODUCT_RE = /^[A-Za-z0-9_.-]{1,32}\/[A-Za-z0-9_.+-]{1,32}$/;
/** UA 注释字符语法（官方 sanitizeBotAgent 的 commentCharRe；可打印 ASCII，排除括号）。 */
const BOT_AGENT_COMMENT_RE = /^[\x20-\x27\x2A-\x7E]{1,64}$/;

/**
 * 移植官方 `api/api.js` sanitizeBotAgent()（逐字对齐 2.4.10 算法）：
 * - 语法：`product *( SP product )`；product = name/version [ SP "(" comment ")" ]；
 * - 支持多个 product token 与跨空格的 `(comment)`（注释 ≤64 可打印字符，排除括号）；
 * - 解析失败/空输入 → `OpenClaw`；超过 256 字节时逐个丢弃尾部 token 截断；
 * - 空白归一（按空白切分后重新以单空格拼接）。
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeBotAgent(raw) {
  if (!raw || typeof raw !== 'string') return DEFAULT_BOT_AGENT;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_BOT_AGENT;

  // Tokenize on whitespace, but keep `(comment)` glued to the preceding product.
  const rawTokens = trimmed.split(/\s+/);
  const tokens = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const tok = rawTokens[i];
    if (tok.startsWith('(') && !tok.endsWith(')')) {
      // 跨空格的注释：贪婪收集到遇到右括号
      let acc = tok;
      while (i + 1 < rawTokens.length && !acc.endsWith(')')) {
        i += 1;
        acc += ' ' + rawTokens[i];
      }
      tokens.push(acc);
    } else {
      tokens.push(tok);
    }
  }

  const accepted = [];
  let pendingProduct = null;
  for (const tok of tokens) {
    if (tok.startsWith('(') && tok.endsWith(')')) {
      const inner = tok.slice(1, -1);
      if (pendingProduct && BOT_AGENT_COMMENT_RE.test(inner)) {
        accepted.push(`${pendingProduct} (${inner})`);
        pendingProduct = null;
      } else {
        if (pendingProduct) {
          accepted.push(pendingProduct);
          pendingProduct = null;
        }
      }
      continue;
    }
    if (pendingProduct) {
      accepted.push(pendingProduct);
      pendingProduct = null;
    }
    if (BOT_AGENT_PRODUCT_RE.test(tok)) pendingProduct = tok;
  }
  if (pendingProduct) accepted.push(pendingProduct);
  if (accepted.length === 0) return DEFAULT_BOT_AGENT;

  const joined = accepted.join(' ');
  if (Buffer.byteLength(joined, 'utf8') <= BOT_AGENT_MAX_LEN) return joined;

  // 超过 256 字节：逐个 token 丢弃尾部，直到不超限
  const truncated = [];
  let len = 0;
  for (const token of accepted) {
    const add = (truncated.length === 0 ? 0 : 1) + Buffer.byteLength(token, 'utf8');
    if (len + add > BOT_AGENT_MAX_LEN) break;
    truncated.push(token);
    len += add;
  }
  return truncated.length > 0 ? truncated.join(' ') : DEFAULT_BOT_AGENT;
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

/** 公共请求头（官方 buildCommonHeaders：GET 与 POST 都用；GET 仅带这些）。 */
export function buildCommonHeaders() {
  const headers = {
    'iLink-App-Id': config.ilink.appId,
    'iLink-App-ClientVersion': String(config.ilink.clientVersion),
  };
  if (config.ilink.routeTag) headers.SKRouteTag = config.ilink.routeTag;
  return headers;
}

/**
 * POST 请求头（官方 buildHeaders）：恒带 Content-Type / AuthorizationType / X-WECHAT-UIN + 公共头，
 * 仅 token 非空时带 Authorization。未鉴权的 POST（如 get_bot_qrcode）同样使用本矩阵。
 */
export function buildHeaders({ token } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (token && String(token).trim()) {
    headers.Authorization = `Bearer ${String(token).trim()}`;
  }
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

/** iLink 响应体硬上限（防止被篡改/异常上游返回超大响应拖垮内存）。 */
const MAX_ILINK_RESPONSE_BYTES = 10 * 1024 * 1024;

/** 流式读取 iLink 响应文本并限制大小；无 body 的测试 mock 回退到 res.text()。 */
async function readResponseTextLimited(res, maxBytes = MAX_ILINK_RESPONSE_BYTES) {
  const declared = Number(res.headers?.get?.('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ILinkError('iLink 响应体超过上限', { body: `${declared} > ${maxBytes}` });
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new ILinkError('iLink 响应体超过上限');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* 已超限 */
        }
        throw new ILinkError('iLink 响应体超过上限');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      /* 忽略 */
    }
  }
  return Buffer.concat(chunks, total).toString('utf8');
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
    // 官方请求头矩阵：GET 仅公共头；所有 POST 用完整 POST 头（含未鉴权的 get_bot_qrcode）。
    const headers = String(method).toUpperCase() === 'GET' ? buildCommonHeaders() : buildHeaders({ token });
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await readResponseTextLimited(res);
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

/** 生成出站消息 client_id（官方 util/random.js generateId 格式：`openclaw-weixin:<ts>-<8hex>`）。 */
export function createClientId() {
  return `openclaw-weixin:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/** 构造单条文本消息（SendMessageReq.msg）。 */
export function formatWeixinText(text) {
  // 1) 按微信渲染规则过滤：中文斜体去标记、H5/H6 去 #、图片整段移除（与官方插件一致）
  // 2) 微信把 Markdown 单换行渲染为空格且不认 hard break，因此普通文本行之间改插空行（段落），
  //    列表/表格/代码块保持单换行（见 shared/wechat-markdown.js layoutWechatText）。
  return layoutWechatText(filterWechatMarkdown(text));
}

/** 构造单条文本消息（SendMessageReq.msg）。 */
export function buildTextMessage({ toUserId, text, contextToken, clientId = createClientId() } = {}) {
  return {
    from_user_id: '',
    to_user_id: String(toUserId),
    client_id: clientId,
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: formatWeixinText(text) } }],
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

export async function notifyStart({ baseUrl, token, timeoutMs = config.ilink.configTimeoutMs } = {}) {
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

export async function notifyStop({ baseUrl, token, timeoutMs = config.ilink.configTimeoutMs } = {}) {
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

// ---------------------------------------------------------------------------
// 正在输入（typing indicator，docs/PROTOCOL.md §5.6）
// ---------------------------------------------------------------------------

/**
 * 获取 typing_ticket（POST /ilink/bot/getconfig）。
 * @param {{baseUrl?:string, token?:string, ilinkUserId:string, contextToken?:string, timeoutMs?:number}} params
 * @returns {Promise<object>} 协议响应（含 typing_ticket）
 */
export async function getConfig({
  baseUrl,
  token,
  ilinkUserId,
  contextToken,
  timeoutMs = config.ilink.configTimeoutMs,
} = {}) {
  const resp = await requestJson({
    method: 'POST',
    baseUrl,
    endpoint: '/ilink/bot/getconfig',
    token,
    body: {
      ilink_user_id: String(ilinkUserId ?? ''),
      ...(contextToken ? { context_token: String(contextToken) } : {}),
      base_info: buildBaseInfo(),
    },
    timeoutMs,
    label: 'getconfig',
  });
  if (Number(resp?.ret) !== 0) {
    throw new ILinkError(`getconfig 失败：ret=${resp?.ret ?? 'unknown'} ${resp?.errmsg ?? ''}`.trim(), {
      endpoint: 'getconfig',
      body: resp,
    });
  }
  return resp;
}

/**
 * 发送/取消「正在输入」状态（POST /ilink/bot/sendtyping）。
 * status：1=正在输入，2=取消。
 * @param {{baseUrl?:string, token?:string, ilinkUserId:string, typingTicket:string, status:1|2, timeoutMs?:number}} params
 * @returns {Promise<object>} 协议响应（ret=0）
 */
export async function sendTyping({
  baseUrl,
  token,
  ilinkUserId,
  typingTicket,
  status,
  timeoutMs = config.ilink.configTimeoutMs,
} = {}) {
  const normalizedStatus = Number(status);
  if (normalizedStatus !== TypingStatus.TYPING && normalizedStatus !== TypingStatus.CANCEL) {
    throw new ILinkError('sendtyping status 只能是 1|2', { endpoint: 'sendtyping' });
  }
  const resp = await requestJson({
    method: 'POST',
    baseUrl,
    endpoint: '/ilink/bot/sendtyping',
    token,
    body: {
      ilink_user_id: String(ilinkUserId ?? ''),
      typing_ticket: String(typingTicket ?? ''),
      status: normalizedStatus,
      base_info: buildBaseInfo(),
    },
    timeoutMs,
    label: 'sendtyping',
  });
  if (Number(resp?.ret) !== 0) {
    throw new ILinkError(`sendtyping 失败：ret=${resp?.ret ?? 'unknown'} ${resp?.errmsg ?? ''}`.trim(), {
      endpoint: 'sendtyping',
      body: resp,
    });
  }
  return resp;
}

export { ILinkError };
