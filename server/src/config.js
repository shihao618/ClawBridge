/**
 * ClawBridge 配置加载（唯一配置入口）。
 *
 * 所有配置来自环境变量；缺省值见下方 DEFAULTS。APP_SECRET 未配置时会自动生成到
 * dataDir/app-secret.key（0600）；管理密码与 API Token 只由 DB/bootstrap 管理，
 * 不再读取 ADMIN_PASSWORD / API_TOKEN 环境变量。
 *
 * 注意：config 在模块加载时求值一次。测试请通过 spawn 子进程 + 环境变量注入，
 * 或在 import 前设置 process.env。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function envStr(env, name, fallback = '') {
  const raw = env[name];
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim();
  return value === '' ? fallback : value;
}

export function envInt(env, name, fallback) {
  const raw = envStr(env, name, '');
  if (raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(env, name, fallback = false) {
  const raw = envStr(env, name, '').toLowerCase();
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function resolveDataDir(env) {
  const raw = envStr(env, 'DATA_DIR', 'data');
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT_DIR, raw);
}

/**
 * iLink-App-ClientVersion：uint32 编码 0x00MMNNPP（高位 8bit 固定 0，其余 major<<16|minor<<8|patch），
 * 与官方 `api/api.js` 的 buildClientVersion() 一致（如 2.4.10 → 0x02040A = 132106）。
 * @param {string} version 形如 "2.4.10"（非数字段按 0 处理）
 * @returns {number}
 */
export function deriveClientVersion(version) {
  const parts = String(version ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const [major = 0, minor = 0, patch = 0] = parts.map((value) => (Number.isFinite(value) ? value : 0));
  return (((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)) >>> 0;
}

/** 读取持久化 secret；不存在则生成并写盘（0600）。 */
function readOrCreateSecret(dataDir, filename, generate, { env, name }) {
  const filePath = path.join(dataDir, filename);
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (existing) {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        /* Windows/受限环境忽略 */
      }
      return existing;
    }
  } catch {
    /* not found — generate below */
  }
  const value = generate();
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, `${value}\n`, { mode: 0o600 });
    console.warn(`[config] ${name} 未设置，已自动生成并保存到 ${filePath}（请妥善保管）`);
  } catch (err) {
    console.warn(`[config] ${name} 未设置，生成的临时值无法持久化：${err.message}`);
  }
  return value;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const nodeEnv = envStr(env, 'NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';
  const dataDir = resolveDataDir(env);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const appSecret = envStr(env, 'APP_SECRET', '')
    || readOrCreateSecret(dataDir, 'app-secret.key', () => crypto.randomBytes(32).toString('hex'), {
      env,
      name: 'APP_SECRET',
    });

  // 管理密码 / API Token 只由 DB 管理；config.secrets.apiToken 仅作为运行时缓存，
  // 由 settings.bootstrapSecrets/loadOverrides/rotate 写入，不再读取旧 env。
  const apiToken = '';
  const pushApiEnabled = true;

  const publicBaseUrl = envStr(env, 'PUBLIC_BASE_URL', '').replace(/\/+$/, '');
  const trustProxy = envBool(env, 'TRUST_PROXY', false);

  // iLink 渠道/客户端版本：channelVersion 显式配置；clientVersion 未显式设置 ILINK_CLIENT_VERSION 时
  // 由 channelVersion 按官方公式自动派生（官方 2.4.10 → 132106），升级渠道版本时无需手改两个值。
  const channelVersion = envStr(env, 'CHANNEL_VERSION', '2.4.10');
  const explicitClientVersion = envStr(env, 'ILINK_CLIENT_VERSION', '');
  const clientVersion =
    explicitClientVersion === '' ? deriveClientVersion(channelVersion) : envInt(env, 'ILINK_CLIENT_VERSION', deriveClientVersion(channelVersion));

  const ilink = {
    loginBaseUrl: envStr(env, 'ILINK_LOGIN_BASE_URL', 'https://ilinkai.weixin.qq.com').replace(/\/+$/, ''),
    defaultBaseUrl: envStr(env, 'ILINK_BASE_URL', 'https://ilinkai.weixin.qq.com').replace(/\/+$/, ''),
    cdnBaseUrl: envStr(env, 'ILINK_CDN_BASE_URL', 'https://novac2c.cdn.weixin.qq.com/c2c').replace(/\/+$/, ''),
    appId: envStr(env, 'ILINK_APP_ID', 'bot'),
    clientVersion,
    channelVersion,
    botAgent: envStr(env, 'BOT_AGENT', 'OpenClaw'),
    botType: envStr(env, 'ILINK_BOT_TYPE', '3'),
    routeTag: envStr(env, 'ILINK_ROUTE_TAG', ''),
    requestTimeoutMs: envInt(env, 'ILINK_REQUEST_TIMEOUT_MS', 15000),
    // 轻量 API（getconfig/sendtyping/notifystart/notifystop）默认超时（官方 DEFAULT_CONFIG_TIMEOUT_MS=10s）。
    configTimeoutMs: envInt(env, 'ILINK_CONFIG_TIMEOUT_MS', 10000),
    qrPollTimeoutMs: envInt(env, 'ILINK_QR_POLL_TIMEOUT_MS', 35000),
    longPollTimeoutMs: envInt(env, 'ILINK_LONGPOLL_TIMEOUT_MS', 35000),
  };

  const mediaDirRaw = envStr(env, 'MEDIA_DIR', '');
  const mediaDir = mediaDirRaw
    ? (path.isAbsolute(mediaDirRaw) ? mediaDirRaw : path.resolve(ROOT_DIR, mediaDirRaw))
    : path.join(dataDir, 'media');

  const mediaDownloadTimeoutMs = envInt(env, 'MEDIA_DOWNLOAD_TIMEOUT_MS', 60000);

  const media = {
    dir: mediaDir,
    outboundMaxBytes: envInt(env, 'MEDIA_MAX_BYTES', 25 * 1024 * 1024),
    inboundMaxBytes: envInt(env, 'INBOUND_MEDIA_MAX_BYTES', 100 * 1024 * 1024),
    downloadTimeoutMs: mediaDownloadTimeoutMs,
    uploadTimeoutMs: envInt(env, 'MEDIA_UPLOAD_TIMEOUT_MS', 60000),
    // 入站下载进程级有界并发闸门（默认 2 并发 + 64 排队；超出排队直接失败，避免无限堆积）。
    inboundMaxConcurrent: Math.min(32, Math.max(1, envInt(env, 'INBOUND_MEDIA_MAX_CONCURRENT', 2))),
    inboundMaxQueue: Math.min(10000, Math.max(0, envInt(env, 'INBOUND_MEDIA_MAX_QUEUE', 64))),
    inboundQueueTimeoutMs: Math.max(1000, envInt(env, 'INBOUND_MEDIA_QUEUE_TIMEOUT_MS', mediaDownloadTimeoutMs)),
    // 入站下载 URL 协议/主机校验（默认仅 https；主机白名单 = iLink/CDN 主机 + MEDIA_ALLOWED_HOSTS）。
    allowedHosts: envStr(env, 'MEDIA_ALLOWED_HOSTS', '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
    allowInsecureHttp: envBool(env, 'MEDIA_ALLOW_INSECURE_HTTP', false),
    allowedImageMime: envStr(env, 'MEDIA_ALLOWED_IMAGE_MIME', 'image/jpeg,image/png,image/gif,image/webp,image/bmp')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
    allowedVideoMime: envStr(env, 'MEDIA_ALLOWED_VIDEO_MIME', 'video/mp4,video/quicktime,video/webm,video/x-matroska')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  };

  const binding = {
    ttlMs: envInt(env, 'BINDING_TTL_MS', 10 * 60 * 1000),
    maxRefreshes: envInt(env, 'BINDING_MAX_REFRESHES', 3),
    maxActiveSessions: envInt(env, 'BINDING_MAX_ACTIVE', 50),
    ipLimitPerHour: envInt(env, 'BINDING_IP_LIMIT_PER_HOUR', 20),
    // 连续网络错误“告警阈值”：仅用于日志告警，不再终止绑定会话（可恢复网络错误会持续轮询到会话 TTL；
    // 仅二维码过期/未知会话/验证码错误上限等真正的协议错误才结束会话）。
    networkErrorLimit: envInt(env, 'BINDING_NETWORK_ERROR_LIMIT', 5),
    pollGapMs: envInt(env, 'BINDING_POLL_GAP_MS', 1000),
    verifyTimeoutMs: envInt(env, 'BINDING_VERIFY_TIMEOUT_MS', 2 * 60 * 1000),
  };

  const retryDelaysMs = envStr(env, 'PUSH_RETRY_DELAYS_MS', '')
    .split(',')
    .map((v) => Number.parseInt(v.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);

  const push = {
    rateLimitMax: envInt(env, 'RATE_LIMIT_MAX', 7),
    rateLimitWindowMs: envInt(env, 'RATE_LIMIT_WINDOW_MS', 5 * 60 * 1000),
    tickMs: envInt(env, 'DISPATCH_TICK_MS', 250),
    maxAttempts: envInt(env, 'PUSH_MAX_ATTEMPTS', 5),
    // 出站消息永久失败时向用户 best-effort 发送一条简短失败提示（不进入 outbox 队列、不重试）。
    errorNoticeEnabled: envBool(env, 'PUSH_ERROR_NOTICE_ENABLED', true),
    retryDelaysMs: retryDelaysMs.length > 0 ? retryDelaysMs : [5000, 15000, 30000, 60000],
    maxTextLength: envInt(env, 'MAX_TEXT_LENGTH', 4000),
    apiRateLimitPerMinute: envInt(env, 'API_RATE_LIMIT_PER_MINUTE', 60),
  };

  const rawMonitorMetaFlushMs = envInt(env, 'MONITOR_META_FLUSH_MS', 6 * 60 * 60 * 1000);
  const monitor = {
    longPollTimeoutMs: envInt(env, 'MONITOR_LONGPOLL_TIMEOUT_MS', 35000),
    maxAccounts: envInt(env, 'MONITOR_MAX_ACCOUNTS', 200),
    maxConsecutiveFailures: 3,
    backoffMs: 30000,
    retryDelayMs: 2000,
    stalePauseMs: 60 * 60 * 1000,
    // 空闲轮询（无消息）时，get_updates_buf / last_poll_at 的落盘间隔：
    // 默认 6 小时（机械盘/存储卡可长时间休眠）；有消息仍立即落盘。
    // 范围 1s–24h；设为 0 = 空闲不写（仅消息/退出时落盘，最省盘）。
    metaFlushMs:
      rawMonitorMetaFlushMs <= 0
        ? 0
        : Math.max(1000, Math.min(24 * 60 * 60 * 1000, rawMonitorMetaFlushMs)),
  };

  // 24h 会话保活（docs/KEEPALIVE.md）：对开启 keepalive 的用户，在最后一条入站消息
  // 即将满窗口（默认 24h）前自动发保活消息，提示用户回复以刷新会话窗口。
  // 默认提前 12h 首次提醒，之后每 6h 重复提醒，直到用户回复或窗口过期。
  const keepalive = {
    enabled: envBool(env, 'KEEPALIVE_ENABLED', true),
    windowMs: Math.max(1000, envInt(env, 'KEEPALIVE_WINDOW_MS', 24 * 60 * 60 * 1000)),
    leadMs: Math.max(0, envInt(env, 'KEEPALIVE_LEAD_MS', 12 * 60 * 60 * 1000)),
    repeatMs: Math.max(1000, envInt(env, 'KEEPALIVE_REPEAT_MS', 6 * 60 * 60 * 1000)),
    tickMs: Math.max(100, envInt(env, 'KEEPALIVE_TICK_MS', 5 * 60 * 1000)),
    text: envStr(env, 'KEEPALIVE_TEXT', '【消息通道保活】回复任意内容即可继续接收通知。'),
    maxPerTick: Math.max(1, envInt(env, 'KEEPALIVE_MAX_PER_TICK', 100)),
  };

  // 接口应用（docs/API_RULES.md）：关键词/正则触发 → 调外部 HTTP 接口 → 解析并回复用户。
  const appRules = {
    enabled: envBool(env, 'APP_RULES_ENABLED', true),
    timeoutMs: Math.max(1000, envInt(env, 'APP_RULE_TIMEOUT_MS', 8000)),
    maxResponseBytes: Math.max(1024, envInt(env, 'APP_RULE_MAX_RESPONSE_BYTES', 1024 * 1024)),
    workerConcurrency: Math.max(1, envInt(env, 'APP_RULES_WORKER_CONCURRENCY', 2)),
    allowedHosts: envStr(env, 'APP_RULES_ALLOWED_HOSTS', '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
    maxQueue: Math.max(1, envInt(env, 'APP_RULE_MAX_QUEUE', 200)),
    // 「正在输入」状态（docs/PROTOCOL.md §5.6）：规则请求外部接口期间向触发用户显示，best-effort。
    // 续期间隔对齐官方微信插件 keepaliveIntervalMs=5000。
    typingIndicator: envBool(env, 'APP_RULE_TYPING_INDICATOR', true),
    typingRefreshMs: Math.min(30000, Math.max(1000, envInt(env, 'APP_RULE_TYPING_REFRESH_MS', 5000))),
  };

  // 定时通知（docs/SCHEDULED_TASKS.md）：按时间计划调用外部接口并把结果推送微信。
  // 定时任务有独立的网络防护配置；maxResponseBytes=0 / allowedHosts=[] 表示
  // 继承 appRules 的对应值（保持历史行为），后台可在「定时通知」分组单独覆盖。
  const scheduler = {
    enabled: envBool(env, 'SCHEDULER_ENABLED', true),
    tickMs: Math.max(1000, envInt(env, 'SCHEDULER_TICK_MS', 15000)),
    timezone: envStr(env, 'SCHEDULER_TIMEZONE', 'Asia/Shanghai'),
    maxRecipients: Math.max(1, envInt(env, 'SCHEDULER_MAX_RECIPIENTS', 200)),
    timeoutMs: Math.max(1000, envInt(env, 'SCHEDULER_TIMEOUT_MS', 8000)),
    maxResponseBytes: Math.max(0, envInt(env, 'SCHEDULER_MAX_RESPONSE_BYTES', 0)),
    allowedHosts: envStr(env, 'SCHEDULER_ALLOWED_HOSTS', '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
    // 按用户模式（per_user_mode）：并发池大小与单任务目标上限（后台运行配置可改，执行时实时读取）。
    perUserConcurrency: Math.min(16, Math.max(1, envInt(env, 'SCHEDULER_PER_USER_CONCURRENCY', 2))),
    perUserMaxRecipients: Math.min(200, Math.max(1, envInt(env, 'SCHEDULER_PER_USER_MAX_RECIPIENTS', 50))),
  };

  const config = {
    version: readVersion(),
    nodeEnv,
    isProduction,
    port: envInt(env, 'PORT', 10380),
    host: envStr(env, 'HOST', '0.0.0.0'),
    dataDir,
    dbPath: path.join(dataDir, 'clawbridge.db'),
    publicBaseUrl,
    trustProxy,
    logLevel: envStr(env, 'LOG_LEVEL', isProduction ? 'info' : 'debug'),
    secrets: {
      appSecret,
      apiToken,
    },
    pushApiEnabled,
    session: {
      cookieName: 'cb_session',
      ttlMs: envInt(env, 'ADMIN_SESSION_TTL_MS', 12 * 60 * 60 * 1000),
      cookieSecure: envBool(env, 'COOKIE_SECURE', false) || publicBaseUrl.startsWith('https://'),
    },
    ilink,
    media,
    binding,
    push,
    monitor,
    keepalive,
    appRules,
    scheduler,
  };

  return config;
}

export const config = loadConfig();
