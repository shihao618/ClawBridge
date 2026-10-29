#!/usr/bin/env node
/**
 * ClawBridge 微信 iLink Bot API 模拟器（零依赖，仅 node:http / node:crypto）。
 *
 * 目标：
 *  1) 忠实模拟 docs/PROTOCOL.md 中客户端会调用的 iLink 协议面，使 ClawBridge 无需真实微信
 *     即可跑通 扫码绑定 → 入站长轮询 → 出站发送 全链路；
 *  2) 提供 /__mock/* 控制面，供 e2e 测试与 demo 控制状态（扫码/确认/配对码/过期/换 IDC/
 *     已绑定/注入入站消息/token 失效/发送失败注入/重置/查看状态）。
 *
 * 用法：
 *   node mock/ilink-mock.mjs                       # 监听 127.0.0.1:3100（0.0.0.0）
 *   PORT=0 node mock/ilink-mock.mjs                # 随机端口（e2e 用，stdout 输出实际端口）
 *   MOCK_AUTO_CONFIRM_MS=3000 node mock/ilink-mock.mjs   # demo：每个二维码自动 扫码+确认
 *
 * 环境变量：
 *   PORT / HOST                    监听端口 / 地址（默认 3100 / 0.0.0.0；PORT=0 表示随机）
 *   MOCK_AUTO_CONFIRM_MS            >0 时新二维码在 N ms 后自动 scan、再 N ms（≤1s）后 confirm
 *   MOCK_QR_POLL_MS                 get_qrcode_status 长轮询挂起上限（默认 1000ms）
 *   MOCK_LONGPOLL_MS                getupdates 长轮询挂起上限（默认 2000ms）
 *   MOCK_LONGPOLLING_TIMEOUT_MS     响应里的 longpolling_timeout_ms 建议值（默认 35000）
 *   MOCK_QR_TTL_MS                  二维码有效期（默认 300000 = 5 分钟）
 *   MOCK_VERIFY_MAX_ATTEMPTS        配对码最大错误次数，达到后 verify_code_blocked（默认 3）
 *   MOCK_VERIFY_CODE                控制面 require-verify 的默认配对码（默认随机 4 位）
 *   MOCK_PUBLIC_BASE_URL            confirmed 返回的 baseurl 覆盖值（Docker demo：http://mock-ilink:3100）。
 *                                   默认由请求 Host 头推导（http://<host>），保证 app 能回连本 mocker。
 *   MOCK_STRICT=1                   协议校验失败时直接拒绝（默认仅记录到 /__mock/state.rejections）
 *   MOCK_QUIET=1                    关闭每请求 JSON 日志（listen/reset 等生命周期日志仍输出）
 *
 * 多媒体/CDN（docs/MEDIA.md §9）：
 *   POST /ilink/bot/getuploadurl     申请上传地址 → upload_full_url 指向本 mock 的 /cdn/upload
 *                                    （由 MOCK_PUBLIC_BASE_URL 或请求 Host 拼出，保证 app 可达）
 *   POST /cdn/upload?filekey=…       接收 AES-128-ECB 密文，用 getuploadurl 记录的 aeskey 解密校验
 *   GET  /cdn/download?encrypted_query_param=<token>   返回密文字节（404 未知 token）
 *   POST /__mock/accounts/{botId}/inbound-media        注入图片/文件/视频/语音入站媒体消息
 *   GET  /__mock/state               暴露 uploads[] / cdnFiles[] / sentMessages[].itemList
 *
 * 所有日志为单行 JSON（stdout），便于测试读取端口与排障。
 */
import crypto from 'node:crypto';
import http from 'node:http';

const VERSION = '1.0.0';
const STARTED_AT = Date.now();

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
function envStr(name, fallback = '') {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim();
  return value === '' ? fallback : value;
}

function envInt(name, fallback) {
  const raw = envStr(name, '');
  if (raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const HOST = envStr('HOST', '0.0.0.0');
const PORT = envInt('PORT', 3100);
const AUTO_CONFIRM_MS = Math.max(0, envInt('MOCK_AUTO_CONFIRM_MS', 0));
const QR_POLL_HOLD_MS = Math.max(0, envInt('MOCK_QR_POLL_MS', 1000));
const LONGPOLL_MS = Math.max(0, envInt('MOCK_LONGPOLL_MS', 2000));
const LONGPOLLING_TIMEOUT_MS = envInt('MOCK_LONGPOLLING_TIMEOUT_MS', 35000);
const QR_TTL_MS = Math.max(1, envInt('MOCK_QR_TTL_MS', 5 * 60 * 1000));
const VERIFY_MAX_ATTEMPTS = Math.max(1, envInt('MOCK_VERIFY_MAX_ATTEMPTS', 3));
const DEFAULT_VERIFY_CODE = envStr('MOCK_VERIFY_CODE', '');
const PUBLIC_BASE_URL = envStr('MOCK_PUBLIC_BASE_URL', '').replace(/\/+$/, '');
const STRICT = envStr('MOCK_STRICT', '') === '1' || envStr('MOCK_STRICT', '').toLowerCase() === 'true';
const QUIET = envStr('MOCK_QUIET', '') === '1';

const BODY_LIMIT = 8 * 1024 * 1024; // JSON 控制面 body 上限（inbound-media 用 base64，留余量）
const RAW_BODY_LIMIT = 128 * 1024 * 1024; // CDN 上传密文 body 上限（远大于默认 25MB 出站上限）
const MEDIA_MAX_BYTES = Math.max(1, envInt('MOCK_MEDIA_MAX_BYTES', 100 * 1024 * 1024)); // 入站注入内容上限
// 超过 2^53 的 uint64，用来验证客户端的无损解析（JSON number 字面量）。
const INBOUND_ID_BASE = 9007199254740993n; // 2^53 + 1
const SEND_ID_BASE = 18014398509481985n; // 2^54 + 1

// 多媒体常量（docs/MEDIA.md §1/§2/§9）
const MEDIA_TYPE_KIND = Object.freeze({ 1: 'image', 2: 'video', 3: 'file' }); // getuploadurl.media_type
const MEDIA_KIND_DEFAULT_MIME = Object.freeze({
  image: 'image/png',
  video: 'video/mp4',
  file: 'application/octet-stream',
  voice: 'audio/silk',
});

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------
function log(event, fields = {}) {
  if (QUIET && event === 'http') return;
  const line = { ts: new Date().toISOString(), level: event === 'error' ? 'error' : 'info', event, ...fields };
  try {
    console.log(JSON.stringify(line));
  } catch {
    console.log(JSON.stringify({ ts: line.ts, level: line.level, event, note: 'log serialization fallback' }));
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function randomHex(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 支持 BigInt 的 JSON 序列化：BigInt 按 JSON number 字面量输出（客户端需无损解析）。 */
function stringifyJson(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stringifyJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = [];
    for (const [key, val] of Object.entries(value)) {
      if (val === undefined || typeof val === 'function') continue;
      entries.push(`${JSON.stringify(key)}:${stringifyJson(val)}`);
    }
    return `{${entries.join(',')}}`;
  }
  return 'null';
}

/** 状态快照用：把 BigInt 转成字符串，避免测试侧 JSON.parse 丢精度。 */
function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

function digitsOf(value) {
  const text = String(value ?? '');
  return /^\d+$/.test(text) ? text : String(Math.trunc(Number(value) || 0));
}

// ---------------------------------------------------------------------------
// 多媒体 / CDN 工具（协议见 docs/MEDIA.md §1/§2，mock 契约见 §9）
// ---------------------------------------------------------------------------
const AES_KEY_HEX_RE = /^[0-9a-fA-F]{32}$/;
const MD5_HEX_RE = /^[0-9a-fA-F]{32}$/;

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function md5Hex(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/** AES-128-ECB/PKCS7 密文长度（与明文长度对应）。 */
function aes128EcbCipherSize(plainSize) {
  return Math.floor(plainSize / 16) * 16 + 16;
}

function aes128EcbEncrypt(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aes128EcbDecrypt(ciphertext, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** getuploadurl.media_type → kind */
function mediaKindFromType(mediaType) {
  return MEDIA_TYPE_KIND[Number(mediaType)] ?? 'file';
}

/** 下载路径（相对）：/cdn/download?encrypted_query_param=<token> */
function cdnDownloadPath(token) {
  return `/cdn/download?encrypted_query_param=${encodeURIComponent(token)}`;
}

/** 绝对下载地址（供 state.uploads / inbound-media 响应与 full_url 使用）。 */
function cdnDownloadUrl(baseUrl, token) {
  return `${String(baseUrl || `http://127.0.0.1:${actualPort}`).replace(/\/+$/, '')}${cdnDownloadPath(token)}`;
}

/** 生成 mock CDN 下载 token 并登记 cdnFiles（ciphertext 不进入 state 快照）。 */
function registerCdnFile({ token, filekey = '', botId = '', direction = 'outbound', kind = 'file', mime = '', fileName = '', ciphertext, plaintext, baseUrl }) {
  const file = {
    token,
    filekey,
    botId,
    direction,
    kind,
    mime,
    fileName,
    ciphertext,
    plainSize: plaintext.length,
    cipherSize: ciphertext.length,
    plaintextSha256: sha256Hex(plaintext),
    plaintextMd5: md5Hex(plaintext),
    baseUrl,
    createdAt: Date.now(),
  };
  state.cdnFiles.set(token, file);
  if (state.cdnFiles.size > 200) {
    const oldest = state.cdnFiles.keys().next().value;
    state.cdnFiles.delete(oldest);
  }
  return file;
}

function cdnFileSummary(file) {
  return {
    token: file.token,
    filekey: file.filekey,
    botId: file.botId,
    direction: file.direction,
    kind: file.kind,
    mime: file.mime,
    fileName: file.fileName,
    plainSize: file.plainSize,
    cipherSize: file.cipherSize,
    plaintextSha256: file.plaintextSha256,
    plaintextMd5: file.plaintextMd5,
    downloadUrl: cdnDownloadUrl(file.baseUrl, file.token),
    createdAt: file.createdAt,
  };
}

function uploadSummary(upload) {
  return {
    filekey: upload.filekey,
    mediaType: upload.mediaType,
    kind: mediaKindFromType(upload.mediaType),
    toUserId: upload.toUserId,
    rawsize: upload.rawsize,
    rawfilemd5: upload.rawfilemd5,
    filesize: upload.filesize,
    aeskey: upload.aeskey,
    noNeedThumb: upload.noNeedThumb,
    botId: upload.botId,
    uploadFullUrl: upload.uploadFullUrl,
    token: upload.token ?? '',
    plainSha256: upload.plainSha256 ?? '',
    plainSize: upload.plainSize ?? 0,
    cipherSize: upload.cipherSize ?? 0,
    downloadUrl: upload.token ? cdnDownloadUrl(upload.baseUrl, upload.token) : '',
    createdAt: upload.createdAt,
    uploadedAt: upload.uploadedAt ?? 0,
  };
}

/** 解析 sendmessage.item_list 中的媒体 item，归一化为便于断言的 itemList。 */
function parseMediaItems(items) {
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const type = Number(item.type) || 0;
    if (![2, 3, 4, 5].includes(type)) continue;
    const kind = type === 2 ? 'image' : type === 5 ? 'video' : type === 4 ? 'file' : 'voice';
    const source = item.image_item ?? item.video_item ?? item.file_item ?? item.voice_item ?? {};
    const media = source.media && typeof source.media === 'object' ? source.media : null;
    const entry = {
      type,
      kind,
      media: media
        ? {
            encryptQueryParam: typeof media.encrypt_query_param === 'string' ? media.encrypt_query_param : '',
            aesKey: typeof media.aes_key === 'string' ? media.aes_key : '',
            encryptType: Number(media.encrypt_type) || 0,
            fullUrl: typeof media.full_url === 'string' ? media.full_url : '',
          }
        : null,
    };
    if (type === 2) entry.midSize = Number(item.image_item?.mid_size) || 0;
    if (type === 5) entry.videoSize = Number(item.video_item?.video_size) || 0;
    if (type === 4) {
      entry.fileName = typeof item.file_item?.file_name === 'string' ? item.file_item.file_name : '';
      entry.len = item.file_item?.len ?? '';
      entry.md5 = typeof item.file_item?.md5 === 'string' ? item.file_item.md5 : '';
    }
    if (type === 3) {
      entry.encodeType = item.voice_item?.encode_type ?? 0;
      entry.playtime = item.voice_item?.playtime ?? 0;
      entry.voiceText = typeof item.voice_item?.text === 'string' ? item.voice_item.text : '';
    }
    result.push(entry);
  }
  return result;
}

/** 校验 sendmessage 媒体 item 字段（宽松记录违规，不直接拒绝）。 */
function validateMediaItem(endpoint, entry, index) {
  if (!entry.media) {
    noteViolation(endpoint, `item_list[${index}] ${entry.kind} missing media`);
    return;
  }
  if (!entry.media.encryptQueryParam) noteViolation(endpoint, `item_list[${index}] ${entry.kind} missing media.encrypt_query_param`);
  if (!entry.media.aesKey) noteViolation(endpoint, `item_list[${index}] ${entry.kind} missing media.aes_key`);
  if (Number(entry.media.encryptType) !== 1) noteViolation(endpoint, `item_list[${index}] ${entry.kind} media.encrypt_type should be 1`);
  try {
    // 微信要求出站 CDNMedia.aes_key = base64(32 字符 hex key 的 ASCII 字节)（44 字符 base64）；
    // 接收端解析：base64 decode → 32 hex chars → hex decode 得到 16 字节 AES key。
    // 历史误用 base64(原始 16 字节 key)：记录为违规，便于测试尽早发现格式回归（不拒绝请求）。
    const decodedAscii = Buffer.from(entry.media.aesKey, 'base64').toString('utf8');
    if (!AES_KEY_HEX_RE.test(decodedAscii)) {
      noteViolation(
        endpoint,
        `${entry.kind} media.aes_key should be base64(32-char hex key ascii)，实际解码=${JSON.stringify(decodedAscii.slice(0, 64))}`,
      );
    }
  } catch {
    noteViolation(endpoint, `item_list[${index}] ${entry.kind} media.aes_key is not valid base64`);
  }
  if (entry.kind === 'image' && !(entry.midSize > 0)) noteViolation(endpoint, 'image_item.mid_size should be > 0');
  if (entry.kind === 'video' && !(entry.videoSize > 0)) noteViolation(endpoint, 'video_item.video_size should be > 0');
  if (entry.kind === 'file') {
    if (!entry.fileName) noteViolation(endpoint, 'file_item.file_name missing');
    if (!/^\d+$/.test(String(entry.len))) noteViolation(endpoint, `file_item.len should be decimal string (got ${JSON.stringify(entry.len)})`);
  }
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
function createState() {
  return {
    qrs: new Map(), // qrcode -> qr
    accounts: new Map(), // botId -> account
    tokenIndex: new Map(), // bot_token -> account
    sentMessages: [],
    failedSends: [],
    failNextSend: [],
    rejections: [],
    uploads: [], // 出站 getuploadurl 记录（docs/MEDIA.md §9）
    cdnFiles: new Map(), // token -> {token, ciphertext(Buffer), plaintextSha256, ...}
    pollCounts: {
      getBotQrcode: 0,
      qrStatus: 0,
      getUpdates: 0,
      getConfig: 0,
      sendTyping: 0,
      notifyStart: 0,
      notifyStop: 0,
      sendMessage: 0,
      getUploadUrl: 0,
      cdnUpload: 0,
      cdnDownload: 0,
      control: 0,
    },
    counts: {
      qrCreated: 0,
      qrAutoConfirmed: 0,
      inboundInjected: 0,
      inboundMediaInjected: 0,
      uploadsCreated: 0,
      cdnUploads: 0,
      cdnDownloads: 0,
      sendAttempts: 0,
      sendSucceeded: 0,
      sendFailed: 0,
      resets: 0,
    },
    notifyStart: 0,
    notifyStop: 0,
    seq: 0,
    sendSeq: 0,
    autoUserSeq: 0,
    timers: new Set(),
  };
}

let state = createState();
let qrWaiters = new Map(); // qrcode -> Set<resolve>
let updatesWaiters = new Map(); // botId -> Set<resolve>

function nextAutoUserId() {
  state.autoUserSeq += 1;
  return `mock_wx_user_${state.autoUserSeq}@im.wechat`;
}

function getAccountByToken(token) {
  if (!token) return null;
  return state.tokenIndex.get(String(token).trim()) ?? null;
}

/** 控制面可用 botId 或 token 定位账号。 */
function findAccount(key) {
  if (!key) return null;
  const raw = String(key);
  if (state.accounts.has(raw)) return state.accounts.get(raw);
  return getAccountByToken(raw);
}

/** 记录协议违规：默认只记不拒（避免过度约束后端实现），MOCK_STRICT=1 时由调用方决定拒绝。 */
function noteViolation(endpoint, reason) {
  const entry = { endpoint, reason, at: Date.now() };
  state.rejections.push(entry);
  if (state.rejections.length > 200) state.rejections.shift();
  log('protocol_violation', { endpoint, reason });
  return entry;
}

// ---------------------------------------------------------------------------
// 长轮询等待器
// ---------------------------------------------------------------------------
function waitFor(map, key, timeoutMs) {
  return new Promise((resolve) => {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    const done = (value) => {
      clearTimeout(timer);
      set.delete(done);
      if (set.size === 0) map.delete(key);
      resolve(value);
    };
    set.add(done);
    const timer = setTimeout(() => done(null), Math.max(0, timeoutMs));
  });
}

function wakeWaiters(map, key) {
  const set = map.get(key);
  if (!set) return;
  for (const done of [...set]) done('changed');
}

function wakeAllWaiters() {
  for (const map of [qrWaiters, updatesWaiters]) {
    for (const set of [...map.values()]) {
      for (const done of [...set]) done('reset');
    }
    map.clear();
  }
}

function addTimer(fn, delayMs) {
  const timer = setTimeout(() => {
    state.timers.delete(timer);
    try {
      fn();
    } catch (err) {
      log('error', { where: 'timer', message: err?.message ?? String(err) });
    }
  }, Math.max(0, delayMs));
  state.timers.add(timer);
  return timer;
}

function clearTimers() {
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
}

// ---------------------------------------------------------------------------
// 二维码状态机
// ---------------------------------------------------------------------------
function resolveBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = req?.headers?.host || `127.0.0.1:${actualPort || PORT}`;
  return `http://${host}`;
}

const EXPIRABLE_STATUSES = new Set(['wait', 'scaned', 'need_verifycode']);
const TERMINAL_STATUSES = new Set(['expired', 'confirmed', 'binded_redirect', 'verify_code_blocked']);

function effectiveStatus(qr) {
  if (EXPIRABLE_STATUSES.has(qr.status) && Date.now() > qr.expiresAt) {
    qr.status = 'expired';
    qr.expiredAt = Date.now();
  }
  return qr.status;
}

function createQr(req, body) {
  const qrcode = `qr_${randomHex(12)}`;
  const baseUrl = resolveBaseUrl(req);
  const qr = {
    qrcode,
    content: `${baseUrl}/mock-bind?qrcode=${qrcode}`,
    status: 'wait',
    botType: String(body?.bot_type ?? req?.url?.searchParams?.get?.('bot_type') ?? '3'),
    localTokenList: Array.isArray(body?.local_token_list) ? body.local_token_list.map(String).slice(0, 10) : [],
    baseUrl,
    createdAt: Date.now(),
    expiresAt: Date.now() + QR_TTL_MS,
    scannedAt: 0,
    confirmedAt: 0,
    verifyCode: '',
    verifyAttempts: 0,
    verifyHistory: [],
    pendingUserId: '',
    ilinkUserId: '',
    botId: '',
    botToken: '',
    redirectHost: '',
    redirectFrom: '',
    redirectPolls: 0,
    auto: AUTO_CONFIRM_MS > 0,
    polls: 0,
  };
  state.qrs.set(qrcode, qr);
  state.counts.qrCreated += 1;
  if (AUTO_CONFIRM_MS > 0) scheduleAutoConfirm(qr);
  return qr;
}

function scheduleAutoConfirm(qr) {
  addTimer(() => {
    if (qr.status !== 'wait') return;
    qr.status = 'scaned';
    qr.scannedAt = Date.now();
    wakeWaiters(qrWaiters, qr.qrcode);
    log('mock_auto_scan', { qrcode: qr.qrcode });
  }, AUTO_CONFIRM_MS);

  const confirmDelay = AUTO_CONFIRM_MS + Math.min(AUTO_CONFIRM_MS, 1000);
  addTimer(() => {
    if (!['wait', 'scaned'].includes(qr.status)) return;
    const account = confirmQr(qr, { auto: true });
    state.counts.qrAutoConfirmed += 1;
    log('mock_auto_confirm', { qrcode: qr.qrcode, botId: account?.botId ?? null, ilinkUserId: qr.ilinkUserId });
  }, confirmDelay);
}

function markScanned(qr, ilinkUserId = '') {
  if (!['wait'].includes(qr.status)) return { ok: false, error: `cannot scan in status ${qr.status}` };
  qr.status = 'scaned';
  qr.scannedAt = Date.now();
  if (ilinkUserId) qr.pendingUserId = String(ilinkUserId);
  wakeWaiters(qrWaiters, qr.qrcode);
  return { ok: true, status: qr.status };
}

function createAccount(qr, ilinkUserId) {
  const botId = `b${randomHex(10)}@im.bot`;
  const token = `mock_bot_token_${randomHex(16)}`;
  const account = {
    botId,
    token,
    ilinkUserId,
    baseUrl: qr.baseUrl,
    createdAt: Date.now(),
    notifyStart: 0,
    notifyStop: 0,
    staleToken: false,
    queued: [],
    getUpdatesBuf: '',
    bufSeq: 0,
    lastGetUpdatesAt: 0,
    inboundCount: 0,
    lastTypingStatus: null,
    getConfigCount: 0,
  };
  state.accounts.set(botId, account);
  state.tokenIndex.set(token, account);
  return account;
}

/**
 * 确认二维码（控制面 / 自动模式共用）。
 * - 同一微信用户（显式 ilink_user_id 或扫码时指定）且该用户已有 bot_token 出现在 local_token_list
 *   中 → binded_redirect（协议语义：已绑定过本客户端，不发放新凭证）。
 * - force=true 时跳过 binded_redirect 判定（用于模拟“换绑”）。
 */
function confirmQr(qr, { ilinkUserId = '', force = false, auto = false } = {}) {
  effectiveStatus(qr);
  if (qr.status === 'confirmed' && qr.botId) {
    return { account: state.accounts.get(qr.botId) ?? null, alreadyConfirmed: true };
  }
  if (qr.status === 'expired') {
    if (!force) return { error: 'qrcode expired' };
    qr.status = 'scaned';
    qr.expiresAt = Date.now() + QR_TTL_MS;
  }
  if (qr.status === 'verify_code_blocked') {
    if (!force) return { error: 'verify code blocked' };
  }
  const user = String(ilinkUserId || qr.pendingUserId || qr.ilinkUserId || nextAutoUserId());
  qr.ilinkUserId = user;
  qr.pendingUserId = '';

  if (!force) {
    for (const token of qr.localTokenList) {
      const existing = state.tokenIndex.get(token);
      if (existing && existing.ilinkUserId === user) {
        qr.status = 'binded_redirect';
        qr.botId = existing.botId;
        qr.botToken = existing.token;
        qr.bindedRedirectAccount = existing.botId;
        qr.confirmedAt = Date.now();
        wakeWaiters(qrWaiters, qr.qrcode);
        log('mock_binded_redirect', { qrcode: qr.qrcode, botId: existing.botId, ilinkUserId: user });
        return { account: existing, bindedRedirect: true };
      }
    }
  }

  const account = createAccount(qr, user);
  qr.status = 'confirmed';
  qr.botId = account.botId;
  qr.botToken = account.token;
  qr.confirmedAt = Date.now();
  wakeWaiters(qrWaiters, qr.qrcode);
  log('mock_confirmed', { qrcode: qr.qrcode, botId: account.botId, auto: Boolean(auto) });
  return { account };
}

function buildQrStatusPayload(qr) {
  const status = effectiveStatus(qr);
  switch (status) {
    case 'wait':
      return { status: 'wait' };
    case 'scaned':
      return { status: 'scaned' };
    case 'need_verifycode':
      return { status: 'need_verifycode' };
    case 'verify_code_blocked':
      return { status: 'verify_code_blocked' };
    case 'expired':
      return { status: 'expired' };
    case 'scaned_but_redirect':
      return { status: 'scaned_but_redirect', redirect_host: qr.redirectHost };
    case 'binded_redirect':
      return { status: 'binded_redirect' };
    case 'confirmed':
      return {
        status: 'confirmed',
        bot_token: qr.botToken,
        ilink_bot_id: qr.botId,
        baseurl: qr.baseUrl,
        ilink_user_id: qr.ilinkUserId,
      };
    default:
      return { status: 'wait' };
  }
}

function applyVerifyCode(qr, code) {
  if (qr.status !== 'need_verifycode' || !code) return;
  const submitted = String(code);
  if (submitted === qr.verifyCode) {
    qr.status = 'scaned';
    qr.scannedAt = Date.now();
    qr.verifyHistory.push({ code: submitted, ok: true, at: Date.now() });
    qr.pendingUserId = qr.pendingUserId || '';
    wakeWaiters(qrWaiters, qr.qrcode);
    log('mock_verify_ok', { qrcode: qr.qrcode });
    return;
  }
  qr.verifyAttempts += 1;
  qr.verifyHistory.push({ code: submitted, ok: false, at: Date.now() });
  if (qr.verifyAttempts >= VERIFY_MAX_ATTEMPTS) {
    qr.status = 'verify_code_blocked';
    wakeWaiters(qrWaiters, qr.qrcode);
  }
  log('mock_verify_wrong', { qrcode: qr.qrcode, attempts: qr.verifyAttempts, blocked: qr.status === 'verify_code_blocked' });
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------
function qrSummary(qr) {
  effectiveStatus(qr);
  return {
    qrcode: qr.qrcode,
    status: qr.status,
    content: qr.content,
    baseUrl: qr.baseUrl,
    localTokenList: qr.localTokenList,
    botType: qr.botType,
    createdAt: qr.createdAt,
    expiresAt: qr.expiresAt,
    scannedAt: qr.scannedAt,
    confirmedAt: qr.confirmedAt,
    verifyCode: qr.verifyCode,
    verifyAttempts: qr.verifyAttempts,
    verifyHistory: qr.verifyHistory,
    redirectHost: qr.redirectHost,
    ilinkUserId: qr.ilinkUserId,
    botId: qr.botId,
    botToken: qr.botToken,
    auto: qr.auto,
    polls: qr.polls,
  };
}

function accountSummary(account) {
  return {
    botId: account.botId,
    token: account.token,
    ilinkUserId: account.ilinkUserId,
    baseUrl: account.baseUrl,
    createdAt: account.createdAt,
    notifyStart: account.notifyStart,
    notifyStop: account.notifyStop,
    staleToken: account.staleToken,
    queuedMessages: account.queued.length,
    getUpdatesBuf: account.getUpdatesBuf,
    lastGetUpdatesAt: account.lastGetUpdatesAt,
    inboundCount: account.inboundCount,
    lastTypingStatus: account.lastTypingStatus,
    getConfigCount: account.getConfigCount,
  };
}

function snapshotState() {
  const now = Date.now();
  // jsonSafe：把内部 BigInt（message_id 等）转为字符串，避免测试侧 JSON.parse 丢精度；
  // 协议响应仍用 sendJson/stringifyJson 输出 number 字面量。
  return jsonSafe({
    ok: true,
    version: VERSION,
    port: actualPort,
    now,
    uptimeMs: now - STARTED_AT,
    autoConfirmMs: AUTO_CONFIRM_MS,
    qrPollHoldMs: QR_POLL_HOLD_MS,
    longpollMs: LONGPOLL_MS,
    longpollingTimeoutMs: LONGPOLLING_TIMEOUT_MS,
    publicBaseUrl: PUBLIC_BASE_URL || null,
    strict: STRICT,
    qrs: [...state.qrs.values()].map(qrSummary),
    accounts: [...state.accounts.values()].map(accountSummary),
    uploads: state.uploads.map(uploadSummary),
    cdnFiles: [...state.cdnFiles.values()].map(cdnFileSummary),
    sentMessages: state.sentMessages,
    failedSends: state.failedSends,
    failNextSend: state.failNextSend.map((entry) => ({ ...entry })),
    notifyStart: state.notifyStart,
    notifyStop: state.notifyStop,
    pollCounts: { ...state.pollCounts },
    counts: { ...state.counts },
    rejections: state.rejections,
    getUpdatesBufs: Object.fromEntries(
      [...state.accounts.values()].map((account) => [account.botId, account.getUpdatesBuf]),
    ),
  });
}

function resetState(reason = 'manual') {
  clearTimers();
  wakeAllWaiters();
  qrWaiters = new Map();
  updatesWaiters = new Map();
  const prevResets = state.counts.resets;
  state = createState();
  state.counts.resets = prevResets + 1;
  log('reset', { reason, resets: state.counts.resets });
}

// ---------------------------------------------------------------------------
// HTTP 基础
// ---------------------------------------------------------------------------
function sendJson(res, statusCode, payload) {
  const body = stringifyJson(payload);
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, statusCode, code, message) {
  sendJson(res, statusCode, { error: { code, message } });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        const err = new Error('request body too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({ raw: '', body: {} });
        return;
      }
      try {
        resolve({ raw, body: JSON.parse(raw) });
      } catch {
        const err = new Error('invalid JSON body');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** 读取原始二进制 body（CDN 上传的 AES 密文），上限 RAW_BODY_LIMIT。 */
function readRawBody(req, limit = RAW_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('request body too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function requestPath(url) {
  const pathname = url.pathname || '/';
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return { pathname: trimmed || '/', url };
}

function checkCommonHeaders(req, endpoint) {
  const headers = req.headers;
  const violations = [];
  if (!headers['ilink-app-id']) violations.push('missing iLink-App-Id');
  if (!headers['ilink-app-clientversion']) violations.push('missing iLink-App-ClientVersion');
  if (!headers['x-wechat-uin']) violations.push('missing X-WECHAT-UIN');
  for (const reason of violations) noteViolation(endpoint, reason);
  return violations;
}

function checkBaseInfo(body, endpoint) {
  const info = body?.base_info;
  if (!info || typeof info !== 'object') {
    noteViolation(endpoint, 'missing body.base_info');
    return;
  }
  if (!info.channel_version) noteViolation(endpoint, 'missing base_info.channel_version');
  if (!info.bot_agent) noteViolation(endpoint, 'missing base_info.bot_agent');
}

function bearerToken(req) {
  const raw = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : '';
}

/**
 * 校验 bot_token 鉴权。返回 { account } 或 { error: 'invalid token' }。
 * token 未知时返回 ret=-14（token 失效语义），与真实服务端行为一致。
 */
function authenticate(req, endpoint) {
  const token = bearerToken(req);
  if (!token) {
    noteViolation(endpoint, 'missing Authorization: Bearer <bot_token>');
    return { error: 'missing bot token' };
  }
  if (String(req.headers.authorizationtype || '') !== 'ilink_bot_token') {
    noteViolation(endpoint, `AuthorizationType=${req.headers.authorizationtype ?? '(missing)'} (expect ilink_bot_token)`);
  }
  const account = getAccountByToken(token);
  if (!account) {
    noteViolation(endpoint, 'unknown bot token');
    return { error: 'invalid bot token' };
  }
  if (account.staleToken) {
    return { error: 'bot token expired', stale: true };
  }
  return { account };
}

function rejectAuth(res, endpoint, auth) {
  log('mock_auth_reject', { endpoint, reason: auth.error });
  sendJson(res, 401, { ret: -14, errcode: -14, errmsg: auth.error });
}

// ---------------------------------------------------------------------------
// 协议面：二维码登录
// ---------------------------------------------------------------------------
async function handleGetBotQrcode(req, res, url) {
  state.pollCounts.getBotQrcode += 1;
  checkCommonHeaders(req, 'get_bot_qrcode');
  const { body } = await readJsonBody(req);
  const botType = url.searchParams.get('bot_type');
  if (botType !== null && String(botType) !== '3') {
    noteViolation('get_bot_qrcode', `bot_type=${botType} (expect 3)`);
  }
  if (body.local_token_list !== undefined && !Array.isArray(body.local_token_list)) {
    noteViolation('get_bot_qrcode', 'local_token_list is not an array');
  }
  if (Array.isArray(body.local_token_list) && body.local_token_list.length > 10) {
    noteViolation('get_bot_qrcode', 'local_token_list longer than 10');
  }
  const qr = createQr(req, body);
  sendJson(res, 200, { qrcode: qr.qrcode, qrcode_img_content: qr.content });
}

async function handleGetQrcodeStatus(req, res, url) {
  state.pollCounts.qrStatus += 1;
  checkCommonHeaders(req, 'get_qrcode_status');
  const qrcode = url.searchParams.get('qrcode');
  const verifyCode = url.searchParams.get('verify_code') || '';
  if (!qrcode) {
    sendError(res, 400, 'BAD_REQUEST', 'missing qrcode');
    return;
  }
  const qr = state.qrs.get(qrcode);
  if (!qr) {
    // 未知票据：按“已过期”处理，客户端会重新获取二维码（与真实服务端语义接近）。
    noteViolation('get_qrcode_status', `unknown qrcode ${qrcode}`);
    sendJson(res, 200, { status: 'expired' });
    return;
  }
  qr.polls += 1;
  if (verifyCode) applyVerifyCode(qr, verifyCode);

  // 挂起语义：仅 wait 状态做有上限等待（≤1s），其余状态立即返回，便于客户端状态机推进。
  if (effectiveStatus(qr) === 'wait' && QR_POLL_HOLD_MS > 0) {
    await waitFor(qrWaiters, qrcode, QR_POLL_HOLD_MS);
  }

  if (effectiveStatus(qr) === 'scaned_but_redirect') {
    qr.redirectPolls -= 1;
    if (qr.redirectPolls < 0) {
      qr.status = qr.redirectFrom || 'wait';
      qr.redirectHost = '';
    }
  }
  sendJson(res, 200, buildQrStatusPayload(qr));
}

// ---------------------------------------------------------------------------
// 协议面：消息收发
// ---------------------------------------------------------------------------
function takeFailNextSend(account) {
  for (const entry of state.failNextSend) {
    if (entry.remaining <= 0) continue;
    if (entry.botId && entry.botId !== account.botId) continue;
    entry.remaining -= 1;
    return entry;
  }
  return null;
}

function parseSendItems(msg) {
  const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
  const texts = [];
  const types = [];
  for (const item of items) {
    types.push(Number(item?.type) || 0);
    if (Number(item?.type) === 1 && typeof item?.text_item?.text === 'string') texts.push(item.text_item.text);
  }
  return { items, texts, types, text: texts[0] ?? '' };
}

async function handleSendMessage(req, res) {
  const endpoint = 'sendmessage';
  state.pollCounts.sendMessage += 1;
  checkCommonHeaders(req, endpoint);
  const { body } = await readJsonBody(req);
  const auth = authenticate(req, endpoint);
  if (auth.error) {
    rejectAuth(res, endpoint, auth);
    return;
  }
  const { account } = auth;
  checkBaseInfo(body, endpoint);

  const msg = body?.msg;
  const structural = [];
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) structural.push('body.msg is not an object');
  if (msg && typeof msg === 'object') {
    if (!msg.to_user_id || typeof msg.to_user_id !== 'string') structural.push('msg.to_user_id missing/empty');
    if (!Array.isArray(msg.item_list) || msg.item_list.length === 0) structural.push('msg.item_list missing/empty');
  }
  if (structural.length > 0) {
    for (const reason of structural) noteViolation(endpoint, reason);
    state.counts.sendFailed += 1;
    state.failedSends.push({ botId: account.botId, ret: -1, reason: structural.join('; '), at: Date.now() });
    sendJson(res, 400, { ret: -1, errmsg: `invalid msg: ${structural.join('; ')}` });
    return;
  }

  state.counts.sendAttempts += 1;
  const { items, types, text } = parseSendItems(msg);
  const itemList = parseMediaItems(items);
  if (itemList.length > 1) {
    noteViolation(endpoint, `media message should contain exactly one item (got ${itemList.length})`);
  }
  itemList.forEach((entry, index) => validateMediaItem(endpoint, entry, index));
  const headers = req.headers;
  if (msg.from_user_id !== '') noteViolation(endpoint, `msg.from_user_id must be "" (got ${JSON.stringify(msg.from_user_id)})`);
  if (Number(msg.message_type) !== 2) noteViolation(endpoint, `msg.message_type=${msg.message_type} (expect 2 BOT)`);
  if (Number(msg.message_state) !== 2) noteViolation(endpoint, `msg.message_state=${msg.message_state} (expect 2 FINISH)`);
  if (!msg.client_id || typeof msg.client_id !== 'string') noteViolation(endpoint, 'msg.client_id missing');
  if (msg.to_user_id !== account.ilinkUserId) {
    noteViolation(endpoint, `msg.to_user_id=${msg.to_user_id} differs from bound ilink_user_id=${account.ilinkUserId}`);
  }
  const uin = String(headers['x-wechat-uin'] || '');
  try {
    if (uin && !/^\d+$/.test(Buffer.from(uin, 'base64').toString('utf8'))) {
      noteViolation(endpoint, 'X-WECHAT-UIN is not base64(decimal uint32)');
    }
  } catch {
    noteViolation(endpoint, 'X-WECHAT-UIN is not valid base64');
  }

  if (STRICT && structural.length > 0) {
    sendError(res, 400, 'BAD_REQUEST', structural.join('; '));
    return;
  }

  const injectedFailure = takeFailNextSend(account);
  if (injectedFailure) {
    state.counts.sendFailed += 1;
    state.failedSends.push({
      botId: account.botId,
      ret: injectedFailure.ret,
      errmsg: injectedFailure.errmsg || '',
      text,
      at: Date.now(),
    });
    log('mock_send_injected_failure', { botId: account.botId, ret: injectedFailure.ret });
    sendJson(res, 200, {
      ret: injectedFailure.ret,
      errmsg: injectedFailure.errmsg || `mock injected failure ret=${injectedFailure.ret}`,
    });
    return;
  }

  state.sendSeq += 1;
  const messageId = SEND_ID_BASE + BigInt(state.sendSeq) * 2n;
  const record = {
    botId: account.botId,
    token: account.token,
    toUserId: msg.to_user_id,
    text,
    contextToken: typeof msg.context_token === 'string' ? msg.context_token : '',
    clientId: typeof msg.client_id === 'string' ? msg.client_id : '',
    messageId,
    at: Date.now(),
    messageType: Number(msg.message_type) || 0,
    messageState: Number(msg.message_state) || 0,
    fromUserId: typeof msg.from_user_id === 'string' ? msg.from_user_id : '',
    itemTypes: types,
    itemList,
    items,
    baseInfo: body?.base_info ?? null,
    headers: {
      appId: headers['ilink-app-id'] ?? '',
      clientVersion: headers['ilink-app-clientversion'] ?? '',
      wechatUin: headers['x-wechat-uin'] ?? '',
      authorizationType: headers.authorizationtype ?? '',
      skRouteTag: headers.skrouteTag ?? '',
    },
  };
  state.sentMessages.push(record);
  if (state.sentMessages.length > 500) state.sentMessages.shift();
  state.counts.sendSucceeded += 1;
  log('mock_sent_message', {
    botId: account.botId,
    toUserId: record.toUserId,
    messageId: messageId.toString(),
    hasContextToken: Boolean(record.contextToken),
    textLength: text.length,
  });
  sendJson(res, 200, { ret: 0, message_id: messageId, errmsg: '' });
}

async function handleGetUpdates(req, res) {
  const endpoint = 'getupdates';
  state.pollCounts.getUpdates += 1;
  checkCommonHeaders(req, endpoint);
  const { body } = await readJsonBody(req);
  const auth = authenticate(req, endpoint);
  if (auth.error) {
    rejectAuth(res, endpoint, auth);
    return;
  }
  const { account } = auth;
  checkBaseInfo(body, endpoint);
  const requestBuf = typeof body?.get_updates_buf === 'string' ? body.get_updates_buf : '';
  account.lastGetUpdatesAt = Date.now();

  const respond = () => {
    const live = state.accounts.get(account.botId);
    if (!live) {
      sendJson(res, 200, { ret: 0, errcode: 0, msgs: [], get_updates_buf: requestBuf, longpolling_timeout_ms: LONGPOLLING_TIMEOUT_MS });
      return;
    }
    if (live.staleToken) {
      sendJson(res, 200, { ret: -14, errcode: -14, errmsg: 'bot token expired' });
      return;
    }
    if (live.queued.length === 0) {
      sendJson(res, 200, {
        ret: 0,
        errcode: 0,
        errmsg: '',
        msgs: [],
        get_updates_buf: live.getUpdatesBuf,
        longpolling_timeout_ms: LONGPOLLING_TIMEOUT_MS,
      });
      return;
    }
    const msgs = live.queued.splice(0, live.queued.length);
    live.bufSeq += 1;
    live.getUpdatesBuf = `mock_updates_buf_${live.bufSeq}`;
    sendJson(res, 200, {
      ret: 0,
      errcode: 0,
      errmsg: '',
      msgs,
      get_updates_buf: live.getUpdatesBuf,
      longpolling_timeout_ms: LONGPOLLING_TIMEOUT_MS,
    });
  };

  if (account.staleToken || account.queued.length > 0) {
    respond();
    return;
  }
  if (LONGPOLL_MS > 0) await waitFor(updatesWaiters, account.botId, LONGPOLL_MS);
  respond();
}

async function handleNotify(req, res, kind) {
  const endpoint = kind;
  state.pollCounts[kind] += 1;
  checkCommonHeaders(req, endpoint);
  const { body } = await readJsonBody(req);
  const auth = authenticate(req, endpoint);
  if (auth.error) {
    rejectAuth(res, endpoint, auth);
    return;
  }
  checkBaseInfo(body, endpoint);
  const account = auth.account;
  if (kind === 'notifyStart') account.notifyStart += 1;
  else account.notifyStop += 1;
  state[kind] += 1;
  sendJson(res, 200, { ret: 0, errmsg: '' });
}

async function handleGetConfig(req, res) {
  const endpoint = 'getconfig';
  state.pollCounts.getConfig += 1;
  checkCommonHeaders(req, endpoint);
  const { body } = await readJsonBody(req);
  const auth = authenticate(req, endpoint);
  if (auth.error) {
    rejectAuth(res, endpoint, auth);
    return;
  }
  checkBaseInfo(body, endpoint);
  auth.account.getConfigCount += 1;
  if (!body?.ilink_user_id) noteViolation(endpoint, 'missing ilink_user_id');
  sendJson(res, 200, {
    ret: 0,
    errmsg: '',
    typing_ticket: Buffer.from(`mock-typing-ticket-${auth.account.botId}`, 'utf8').toString('base64'),
  });
}

async function handleSendTyping(req, res) {
  const endpoint = 'sendtyping';
  state.pollCounts.sendTyping += 1;
  checkCommonHeaders(req, endpoint);
  const { body } = await readJsonBody(req);
  const auth = authenticate(req, endpoint);
  if (auth.error) {
    rejectAuth(res, endpoint, auth);
    return;
  }
  checkBaseInfo(body, endpoint);
  const status = Number(body?.status);
  if (status !== 1 && status !== 2) noteViolation(endpoint, `status=${body?.status} (expect 1|2)`);
  auth.account.lastTypingStatus = status;
  sendJson(res, 200, { ret: 0, errmsg: '' });
}

// ---------------------------------------------------------------------------
// 协议面：CDN 上传（出站媒体，docs/MEDIA.md §1；mock 契约 §9）
// ---------------------------------------------------------------------------
async function handleGetUploadUrl(req, res) {
  const endpoint = 'getuploadurl';
  state.pollCounts.getUploadUrl += 1;
  checkCommonHeaders(req, endpoint);
  const { body } = await readJsonBody(req);
  const auth = authenticate(req, endpoint);
  if (auth.error) {
    rejectAuth(res, endpoint, auth);
    return;
  }
  const { account } = auth;
  checkBaseInfo(body, endpoint);

  const filekey = typeof body?.filekey === 'string' ? body.filekey.trim() : '';
  const mediaType = Number(body?.media_type);
  const aeskey = typeof body?.aeskey === 'string' ? body.aeskey.trim() : '';
  const violations = [];
  if (!AES_KEY_HEX_RE.test(filekey)) violations.push('filekey must be 32 hex chars');
  if (![1, 2, 3].includes(mediaType)) violations.push(`media_type=${body?.media_type} (expect 1=image|2=video|3=file)`);
  if (!AES_KEY_HEX_RE.test(aeskey)) violations.push('aeskey must be 32 hex chars');
  if (typeof body?.to_user_id !== 'string' || body.to_user_id === '') violations.push('to_user_id missing');
  if (!(Number(body?.rawsize) > 0)) violations.push('rawsize must be > 0');
  if (!MD5_HEX_RE.test(String(body?.rawfilemd5 ?? ''))) violations.push('rawfilemd5 must be 32 hex chars');
  if (!(Number(body?.filesize) > 0)) violations.push('filesize must be > 0');
  if (body?.no_need_thumb !== true) noteViolation(endpoint, 'no_need_thumb should be true');
  for (const reason of violations) noteViolation(endpoint, reason);
  if (!AES_KEY_HEX_RE.test(filekey) || !AES_KEY_HEX_RE.test(aeskey) || ![1, 2, 3].includes(mediaType)) {
    sendJson(res, 400, { ret: -1, errmsg: `invalid getuploadurl body: ${violations.join('; ')}` });
    return;
  }

  const baseUrl = resolveBaseUrl(req);
  const uploadFullUrl = `${baseUrl}/cdn/upload?filekey=${encodeURIComponent(filekey)}&mock_upload=1`;
  const upload = {
    filekey,
    mediaType,
    kind: mediaKindFromType(mediaType),
    toUserId: String(body?.to_user_id ?? ''),
    rawsize: Number(body?.rawsize) || 0,
    rawfilemd5: String(body?.rawfilemd5 ?? '').toLowerCase(),
    filesize: Number(body?.filesize) || 0,
    aeskey: aeskey.toLowerCase(),
    noNeedThumb: body?.no_need_thumb === true,
    botId: account.botId,
    baseUrl,
    uploadFullUrl,
    createdAt: Date.now(),
  };
  state.uploads.push(upload);
  if (state.uploads.length > 200) state.uploads.shift();
  state.counts.uploadsCreated += 1;
  log('mock_getuploadurl', {
    botId: account.botId,
    filekey,
    mediaType,
    kind: upload.kind,
    rawsize: upload.rawsize,
    filesize: upload.filesize,
  });
  sendJson(res, 200, {
    ret: 0,
    upload_param: `mock_upload_param_${randomHex(8)}`,
    thumb_upload_param: '',
    upload_full_url: uploadFullUrl,
  });
}

/** POST /cdn/upload?filekey=…：按 getuploadurl 记录的 aeskey 解密校验密文并登记下载 token。 */
async function handleCdnUpload(req, res, url) {
  const filekey = url.searchParams.get('filekey') || '';
  const upload = [...state.uploads].reverse().find((entry) => entry.filekey === filekey);
  if (!upload) {
    sendError(res, 404, 'NOT_FOUND', `unknown upload filekey: ${filekey}`);
    return;
  }
  const ciphertext = await readRawBody(req);
  if (ciphertext.length === 0) {
    sendError(res, 400, 'BAD_REQUEST', 'empty ciphertext body');
    return;
  }
  let plaintext;
  try {
    plaintext = aes128EcbDecrypt(ciphertext, Buffer.from(upload.aeskey, 'hex'));
  } catch (err) {
    noteViolation('cdn_upload', `AES-128-ECB decrypt failed: ${err.message}`);
    sendError(res, 400, 'BAD_REQUEST', 'invalid ciphertext: AES-128-ECB/PKCS7 decrypt failed');
    return;
  }
  const plainSha256 = sha256Hex(plaintext);
  const plainMd5 = md5Hex(plaintext);
  if (Number(upload.rawsize) !== plaintext.length) {
    noteViolation('cdn_upload', `rawsize mismatch (declared ${upload.rawsize}, actual ${plaintext.length})`);
  }
  if (upload.rawfilemd5 && upload.rawfilemd5 !== plainMd5) {
    noteViolation('cdn_upload', `rawfilemd5 mismatch (declared ${upload.rawfilemd5}, actual ${plainMd5})`);
  }
  if (Number(upload.filesize) !== ciphertext.length) {
    noteViolation('cdn_upload', `filesize mismatch (declared ${upload.filesize}, actual ${ciphertext.length})`);
  }
  const token = `mock_cdn_${randomHex(12)}`;
  registerCdnFile({
    token,
    filekey,
    botId: upload.botId,
    direction: 'outbound',
    kind: upload.kind,
    ciphertext,
    plaintext,
    baseUrl: upload.baseUrl,
  });
  Object.assign(upload, {
    token,
    plainSha256,
    plainSize: plaintext.length,
    cipherSize: ciphertext.length,
    uploadedAt: Date.now(),
  });
  state.counts.cdnUploads += 1;
  log('mock_cdn_upload', {
    filekey,
    token,
    kind: upload.kind,
    plainSize: plaintext.length,
    cipherSize: ciphertext.length,
    sha256: plainSha256,
  });
  res.writeHead(200, {
    'x-encrypted-param': token,
    'Content-Type': 'application/octet-stream',
    'Content-Length': '0',
    'Cache-Control': 'no-store',
  });
  res.end();
}

/** GET /cdn/download?encrypted_query_param=<token>：返回密文字节（404 未知）。 */
async function handleCdnDownload(req, res, url) {
  const token = url.searchParams.get('encrypted_query_param') || url.searchParams.get('token') || '';
  if (!token) {
    sendError(res, 400, 'BAD_REQUEST', 'missing encrypted_query_param');
    return;
  }
  const file = state.cdnFiles.get(token);
  if (!file) {
    sendError(res, 404, 'NOT_FOUND', `unknown encrypted_query_param: ${token}`);
    return;
  }
  state.counts.cdnDownloads += 1;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(file.ciphertext.length),
    'Cache-Control': 'no-store',
    'x-mock-kind': file.kind,
  });
  res.end(file.ciphertext);
}

// ---------------------------------------------------------------------------
// 控制面
// ---------------------------------------------------------------------------
function controlQrSummary(qr) {
  return qrSummary(qr);
}

async function handleControlQrAction(req, res, qrcode, action) {
  state.pollCounts.control += 1;
  const { body } = await readJsonBody(req);
  const qr = state.qrs.get(qrcode);
  if (!qr) {
    sendError(res, 404, 'NOT_FOUND', `qrcode not found: ${qrcode}`);
    return;
  }
  effectiveStatus(qr);
  switch (action) {
    case 'scan': {
      const result = markScanned(qr, body.ilink_user_id || '');
      if (!result.ok) {
        sendJson(res, 409, { ok: false, error: result.error, qr: controlQrSummary(qr) });
        return;
      }
      sendJson(res, 200, { ok: true, qr: controlQrSummary(qr) });
      return;
    }
    case 'confirm': {
      const result = confirmQr(qr, {
        ilinkUserId: body.ilink_user_id || '',
        force: Boolean(body.force),
      });
      if (result.error) {
        sendJson(res, 409, { ok: false, error: result.error, qr: controlQrSummary(qr) });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        bindedRedirect: Boolean(result.bindedRedirect),
        account: result.account ? accountSummary(result.account) : null,
        qr: controlQrSummary(qr),
      });
      return;
    }
    case 'require-verify': {
      if (qr.status === 'expired') {
        sendJson(res, 409, { ok: false, error: 'qrcode expired' });
        return;
      }
      qr.status = 'need_verifycode';
      qr.verifyCode = String(body.code ?? DEFAULT_VERIFY_CODE ?? '') || String(1000 + crypto.randomInt(0, 9000));
      qr.verifyAttempts = 0;
      qr.verifyHistory = [];
      wakeWaiters(qrWaiters, qrcode);
      sendJson(res, 200, { ok: true, code: qr.verifyCode, qr: controlQrSummary(qr) });
      return;
    }
    case 'expire': {
      qr.status = 'expired';
      qr.expiredAt = Date.now();
      wakeWaiters(qrWaiters, qrcode);
      sendJson(res, 200, { ok: true, qr: controlQrSummary(qr) });
      return;
    }
    case 'redirect': {
      qr.redirectFrom = qr.status === 'scaned_but_redirect' ? qr.redirectFrom || 'wait' : qr.status;
      qr.status = 'scaned_but_redirect';
      qr.redirectHost =
        String(body.redirect_host ?? '') ||
        (PUBLIC_BASE_URL ? new URL(PUBLIC_BASE_URL).host : String(req.headers.host || `127.0.0.1:${actualPort}`));
      qr.redirectPolls = Number.isFinite(Number(body.times)) ? Math.max(0, Number(body.times)) : 1;
      wakeWaiters(qrWaiters, qrcode);
      sendJson(res, 200, { ok: true, redirect_host: qr.redirectHost, qr: controlQrSummary(qr) });
      return;
    }
    case 'already-bound': {
      qr.status = 'binded_redirect';
      qr.ilinkUserId = String(body.ilink_user_id || qr.ilinkUserId || '');
      qr.confirmedAt = Date.now();
      wakeWaiters(qrWaiters, qrcode);
      sendJson(res, 200, { ok: true, qr: controlQrSummary(qr) });
      return;
    }
    default: {
      sendError(res, 404, 'NOT_FOUND', `unknown qr action: ${action}`);
    }
  }
}

function buildInboundMessage(account, body) {
  state.seq += 1;
  const seq = state.seq;
  let messageId;
  if (body.message_id !== undefined && body.message_id !== null) {
    const raw = String(body.message_id).trim();
    messageId = /^\d+$/.test(raw) ? BigInt(raw) : raw;
  } else {
    messageId = INBOUND_ID_BASE + BigInt(seq) * 2n;
  }
  const contextToken =
    typeof body.context_token === 'string' && body.context_token
      ? body.context_token
      : `mock_ctx_${account.botId.split('@')[0]}_${seq}`;
  const items = Array.isArray(body.item_list)
    ? body.item_list
    : [{ type: 1, text_item: { text: String(body.text ?? '') } }];
  const now = Date.now();
  return {
    seq,
    message_id: messageId,
    from_user_id: String(body.from_user_id || account.ilinkUserId || 'mock_wx_user_unknown@im.wechat'),
    to_user_id: String(body.to_user_id || account.botId),
    client_id: typeof body.client_id === 'string' ? body.client_id : '',
    create_time_ms: Number(body.create_time_ms) || now,
    update_time_ms: Number(body.update_time_ms) || now,
    delete_time_ms: 0,
    session_id: '',
    group_id: '',
    message_type: Number(body.message_type) || 1,
    message_state: Number(body.message_state) || 2,
    item_list: items,
    context_token: contextToken,
  };
}

async function handleControlInbound(req, res, accountKey) {
  state.pollCounts.control += 1;
  const { body } = await readJsonBody(req);
  const account = findAccount(accountKey);
  if (!account) {
    sendError(res, 404, 'NOT_FOUND', `account not found: ${accountKey}`);
    return;
  }
  const repeat = Math.min(50, Math.max(1, Number.parseInt(String(body.repeat ?? '1'), 10) || 1));
  const messages = [];
  for (let i = 0; i < repeat; i += 1) {
    const msg = buildInboundMessage(account, body);
    account.queued.push(msg);
    account.inboundCount += 1;
    state.counts.inboundInjected += 1;
    messages.push({
      seq: msg.seq,
      message_id: typeof msg.message_id === 'bigint' ? msg.message_id.toString() : msg.message_id,
      text: msg.item_list?.[0]?.text_item?.text ?? '',
      context_token: msg.context_token,
      from_user_id: msg.from_user_id,
    });
  }
  wakeWaiters(updatesWaiters, account.botId);
  log('mock_inbound', { botId: account.botId, count: repeat });
  sendJson(res, 200, { ok: true, count: repeat, messages });
}

const DEFAULT_MEDIA_FILE_NAMES = Object.freeze({
  image: 'image.png',
  video: 'video.mp4',
  file: 'file.bin',
  voice: 'voice.silk',
});

function sanitizeFileName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 200);
  return cleaned || 'file.bin';
}

/** 构造入站媒体 item（结构见 docs/MEDIA.md §2；mock 契约见 §9）。 */
function buildInboundMediaItem(kind, { fileName, token, aeskeyHex, ciphertext, plainSize, fullUrl, baseUrl, voiceText }) {
  const media = {
    encrypt_query_param: token,
    // 图片：media.aes_key = base64(原始 16 字节 key)；文件/视频/语音：base64(32 位 hex 字符串)
    aes_key: kind === 'image' ? Buffer.from(aeskeyHex, 'hex').toString('base64') : Buffer.from(aeskeyHex, 'utf8').toString('base64'),
    encrypt_type: 1,
  };
  if (fullUrl) media.full_url = cdnDownloadUrl(baseUrl, token);
  if (kind === 'image') {
    return { type: 2, image_item: { media, aeskey: aeskeyHex, mid_size: ciphertext.length } };
  }
  if (kind === 'video') {
    return { type: 5, video_item: { media, video_size: ciphertext.length } };
  }
  if (kind === 'file') {
    return { type: 4, file_item: { media, file_name: fileName, len: String(plainSize) } };
  }
  return { type: 3, voice_item: { media, encode_type: 6, playtime: 1234, text: String(voiceText ?? '') } };
}

/** POST /__mock/accounts/{botId}/inbound-media：加密内容并注入一条带媒体 item 的入站消息。 */
async function handleControlInboundMedia(req, res, accountKey) {
  state.pollCounts.control += 1;
  const { body } = await readJsonBody(req);
  const account = findAccount(accountKey);
  if (!account) {
    sendError(res, 404, 'NOT_FOUND', `account not found: ${accountKey}`);
    return;
  }
  const kind = String(body.kind ?? '').trim();
  if (!['image', 'video', 'file', 'voice'].includes(kind)) {
    sendJson(res, 400, { ok: false, error: 'kind 必须是 image | video | file | voice' });
    return;
  }
  let content;
  try {
    content = Buffer.from(String(body.contentBase64 ?? ''), 'base64');
  } catch {
    content = Buffer.alloc(0);
  }
  if (content.length === 0) {
    sendJson(res, 400, { ok: false, error: 'contentBase64 解码后为空（请传非空 base64 内容）' });
    return;
  }
  if (content.length > MEDIA_MAX_BYTES) {
    sendJson(res, 413, { ok: false, error: `content 过大（${content.length} > ${MEDIA_MAX_BYTES}）` });
    return;
  }
  const fileName = sanitizeFileName(body.fileName || DEFAULT_MEDIA_FILE_NAMES[kind]);
  const mime = String(body.mime || MEDIA_KIND_DEFAULT_MIME[kind] || 'application/octet-stream');
  const aeskeyHex = randomHex(16); // AES-128 key（hex）
  const ciphertext = aes128EcbEncrypt(content, Buffer.from(aeskeyHex, 'hex'));
  const token = `mock_cdn_${randomHex(12)}`;
  const baseUrl = resolveBaseUrl(req);
  registerCdnFile({
    token,
    filekey: '',
    botId: account.botId,
    direction: 'inbound',
    kind,
    mime,
    fileName,
    ciphertext,
    plaintext: content,
    baseUrl,
  });
  const fullUrl = Boolean(body.fullUrl);
  const item = buildInboundMediaItem(kind, {
    fileName,
    token,
    aeskeyHex,
    ciphertext,
    plainSize: content.length,
    fullUrl,
    baseUrl,
    voiceText: body.text,
  });
  const message = buildInboundMessage(account, {
    message_id: body.message_id,
    context_token: body.context_token,
    from_user_id: body.from_user_id,
    item_list: [item],
    text: '',
  });
  account.queued.push(message);
  account.inboundCount += 1;
  state.counts.inboundInjected += 1;
  state.counts.inboundMediaInjected += 1;
  wakeWaiters(updatesWaiters, account.botId);
  log('mock_inbound_media', {
    botId: account.botId,
    kind,
    fileName,
    plainSize: content.length,
    cipherSize: ciphertext.length,
    fullUrl,
  });
  sendJson(res, 200, {
    ok: true,
    kind,
    fileName,
    mime,
    message: {
      seq: message.seq,
      message_id: typeof message.message_id === 'bigint' ? message.message_id.toString() : message.message_id,
      context_token: message.context_token,
      item,
    },
    cdnFile: cdnFileSummary(state.cdnFiles.get(token)),
    contentSha256: sha256Hex(content),
    contentLength: content.length,
  });
}

async function handleControlStaleToken(req, res, accountKey, action) {
  state.pollCounts.control += 1;
  const { body } = await readJsonBody(req);
  const account = findAccount(accountKey);
  if (!account) {
    sendError(res, 404, 'NOT_FOUND', `account not found: ${accountKey}`);
    return;
  }
  account.staleToken = action === 'clear-stale-token' ? false : body.stale === false ? false : true;
  wakeWaiters(updatesWaiters, account.botId);
  log('mock_stale_token', { botId: account.botId, staleToken: account.staleToken });
  sendJson(res, 200, { ok: true, account: accountSummary(account) });
}

async function handleControlFailNextSend(req, res) {
  state.pollCounts.control += 1;
  const { body } = await readJsonBody(req);
  const ret = Number.isFinite(Number(body.ret)) ? Number(body.ret) : -2;
  const times = Math.max(1, Math.min(100, Number.parseInt(String(body.times ?? '1'), 10) || 1));
  const botId = body.botId ? String(body.botId) : null;
  if (botId && !state.accounts.has(botId) && !getAccountByToken(botId)) {
    sendError(res, 404, 'NOT_FOUND', `account not found: ${botId}`);
    return;
  }
  const resolvedBotId = botId ? (state.accounts.get(botId)?.botId ?? getAccountByToken(botId)?.botId ?? botId) : null;
  state.failNextSend.push({ ret, remaining: times, botId: resolvedBotId, errmsg: String(body.errmsg ?? '') });
  sendJson(res, 200, { ok: true, pending: state.failNextSend.reduce((sum, entry) => sum + entry.remaining, 0) });
}

async function handleControlReset(req, res) {
  state.pollCounts.control += 1;
  resetState('control');
  sendJson(res, 200, { ok: true, state: snapshotState() });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const ROUTES = [
  [/^\/ilink\/bot\/get_bot_qrcode$/, 'POST', (req, res, url) => handleGetBotQrcode(req, res, url)],
  [/^\/ilink\/bot\/get_qrcode_status$/, 'GET', (req, res, url) => handleGetQrcodeStatus(req, res, url)],
  [/^\/ilink\/bot\/getupdates$/, 'POST', (req, res) => handleGetUpdates(req, res)],
  [/^\/ilink\/bot\/sendmessage$/, 'POST', (req, res) => handleSendMessage(req, res)],
  [/^\/ilink\/bot\/msg\/notifystart$/, 'POST', (req, res) => handleNotify(req, res, 'notifyStart')],
  [/^\/ilink\/bot\/msg\/notifystop$/, 'POST', (req, res) => handleNotify(req, res, 'notifyStop')],
  [/^\/ilink\/bot\/getconfig$/, 'POST', (req, res) => handleGetConfig(req, res)],
  [/^\/ilink\/bot\/sendtyping$/, 'POST', (req, res) => handleSendTyping(req, res)],
  [/^\/ilink\/bot\/getuploadurl$/, 'POST', (req, res) => handleGetUploadUrl(req, res)],
];

const CONTROL_QR_RE = /^\/__mock\/qr\/([^/]+)\/(scan|confirm|require-verify|expire|redirect|already-bound)$/;
const CONTROL_ACCOUNT_RE = /^\/__mock\/accounts\/([^/]+)\/(inbound|inbound-media|stale-token|clear-stale-token)$/;

async function dispatch(req, res) {
  const startedAt = Date.now();
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${actualPort}`}`);
  const { pathname } = requestPath(url);
  const method = String(req.method || 'GET').toUpperCase();
  let statusCode = 200;
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = (code, ...args) => {
    statusCode = code;
    return originalWriteHead(code, ...args);
  };

  try {
    // 控制面（固定前缀）
    if (pathname === '/__mock/health') {
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET');
        return;
      }
      sendJson(res, 200, {
        ok: true,
        status: 'ok',
        version: VERSION,
        port: actualPort,
        uptimeMs: Date.now() - STARTED_AT,
        autoConfirmMs: AUTO_CONFIRM_MS,
        qrs: state.qrs.size,
        accounts: state.accounts.size,
        uploads: state.uploads.length,
        cdnFiles: state.cdnFiles.size,
        counts: { ...state.counts },
      });
      return;
    }
    if (pathname === '/__mock/state') {
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET');
        return;
      }
      sendJson(res, 200, snapshotState());
      return;
    }
    if (pathname === '/__mock/reset') {
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST');
        return;
      }
      await handleControlReset(req, res);
      return;
    }
    if (pathname === '/__mock/fail-next-send') {
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST');
        return;
      }
      await handleControlFailNextSend(req, res);
      return;
    }
    if (pathname === '/__mock/shutdown') {
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST');
        return;
      }
      state.pollCounts.control += 1;
      sendJson(res, 200, { ok: true, message: 'shutting down' });
      setTimeout(() => shutdown('control'), 20);
      return;
    }
    const qrMatch = CONTROL_QR_RE.exec(pathname);
    if (qrMatch) {
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST');
        return;
      }
      await handleControlQrAction(req, res, decodeURIComponent(qrMatch[1]), qrMatch[2]);
      return;
    }
    const accountMatch = CONTROL_ACCOUNT_RE.exec(pathname);
    if (accountMatch) {
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST');
        return;
      }
      const key = decodeURIComponent(accountMatch[1]);
      const action = accountMatch[2];
      if (action === 'inbound') await handleControlInbound(req, res, key);
      else if (action === 'inbound-media') await handleControlInboundMedia(req, res, key);
      else await handleControlStaleToken(req, res, key, action);
      return;
    }
    if (pathname.startsWith('/__mock/')) {
      sendError(res, 404, 'NOT_FOUND', `unknown mock endpoint: ${pathname}`);
      return;
    }

    // CDN 面（出站上传 / 下载，docs/MEDIA.md §1/§2/§9）
    if (pathname === '/cdn/upload') {
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST');
        return;
      }
      await handleCdnUpload(req, res, url);
      return;
    }
    if (pathname === '/cdn/download') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET');
        return;
      }
      await handleCdnDownload(req, res, url);
      return;
    }
    if (pathname.startsWith('/cdn/')) {
      sendError(res, 404, 'NOT_FOUND', `unknown cdn endpoint: ${pathname}`);
      return;
    }

    // iLink 协议面
    for (const [re, expectedMethod, handler] of ROUTES) {
      if (!re.test(pathname)) continue;
      if (method !== expectedMethod) {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', `use ${expectedMethod}`);
        return;
      }
      await handler(req, res, url);
      return;
    }
    if (pathname.startsWith('/ilink/')) {
      noteViolation('router', `unknown ilink endpoint ${method} ${pathname}`);
      sendJson(res, 404, { ret: -1, errmsg: `unknown endpoint: ${pathname}` });
      return;
    }
    sendError(res, 404, 'NOT_FOUND', `not found: ${pathname}`);
  } catch (err) {
    if (err?.statusCode === 400) {
      sendError(res, 400, 'BAD_REQUEST', err.message);
      return;
    }
    if (err?.statusCode === 413) {
      sendError(res, 413, 'PAYLOAD_TOO_LARGE', err.message);
      return;
    }
    log('error', { where: 'dispatch', path: pathname, message: err?.message ?? String(err), stack: err?.stack });
    if (!res.headersSent) sendError(res, 500, 'INTERNAL', 'mock internal error');
  } finally {
    log('http', { method, path: pathname, status: statusCode, ms: Date.now() - startedAt });
  }
}

// ---------------------------------------------------------------------------
// 服务器生命周期
// ---------------------------------------------------------------------------
let actualPort = 0;
const server = http.createServer((req, res) => {
  dispatch(req, res).catch((err) => {
    log('error', { where: 'dispatch-catch', message: err?.message ?? String(err) });
    if (!res.headersSent) sendError(res, 500, 'INTERNAL', 'mock internal error');
  });
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.on('error', (err) => {
  log('error', { where: 'server', message: err?.message ?? String(err) });
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  actualPort = server.address().port;
  log('listening', {
    version: VERSION,
    host: HOST,
    port: actualPort,
    autoConfirmMs: AUTO_CONFIRM_MS,
    qrPollHoldMs: QR_POLL_HOLD_MS,
    longpollMs: LONGPOLL_MS,
    qrTtlMs: QR_TTL_MS,
    publicBaseUrl: PUBLIC_BASE_URL || null,
    strict: STRICT,
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutdown', { signal });
  clearTimers();
  wakeAllWaiters();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log('error', { where: 'uncaughtException', message: err?.message ?? String(err), stack: err?.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log('error', { where: 'unhandledRejection', message: reason?.message ?? String(reason) });
});
