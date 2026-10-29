/**
 * ClawBridge 配置加载（唯一配置入口）。
 *
 * 所有配置来自环境变量；缺省值见下方 DEFAULTS。敏感值（APP_SECRET、
 * ADMIN_PASSWORD、API_TOKEN）在未通过环境变量提供时会自动生成并持久化到
 * dataDir（权限 0600），保证零配置也能安全启动、且重启后密钥不丢。
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

/** 读取持久化 secret；不存在则生成并写盘（0600）。 */
function readOrCreateSecret(dataDir, filename, generate, { env, name }) {
  const filePath = path.join(dataDir, filename);
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (existing) return existing;
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

  // 机密（管理密码 / API Token）只由 DB 管理：env 仅用于测试/显式注入的初始化值，
  // 生产环境不再读取/生成 data/admin-password.txt、data/api-token.txt（由 settings.bootstrapSecrets 管理）。
  const adminPassword = envStr(env, 'ADMIN_PASSWORD', '');
  const adminPasswordAuto = false;
  const apiToken = envStr(env, 'API_TOKEN', '');
  const apiTokenAuto = false;
  const pushApiEnabled = !['off', 'disabled', 'none', 'false'].includes(apiToken.toLowerCase());

  const publicBaseUrl = envStr(env, 'PUBLIC_BASE_URL', '').replace(/\/+$/, '');
  const trustProxy = envBool(env, 'TRUST_PROXY', false);

  const ilink = {
    loginBaseUrl: envStr(env, 'ILINK_LOGIN_BASE_URL', 'https://ilinkai.weixin.qq.com').replace(/\/+$/, ''),
    defaultBaseUrl: envStr(env, 'ILINK_BASE_URL', 'https://ilinkai.weixin.qq.com').replace(/\/+$/, ''),
    cdnBaseUrl: envStr(env, 'ILINK_CDN_BASE_URL', 'https://novac2c.cdn.weixin.qq.com/c2c').replace(/\/+$/, ''),
    appId: envStr(env, 'ILINK_APP_ID', 'bot'),
    clientVersion: envInt(env, 'ILINK_CLIENT_VERSION', 132106),
    channelVersion: envStr(env, 'CHANNEL_VERSION', '2.4.10'),
    botAgent: envStr(env, 'BOT_AGENT', 'OpenClaw'),
    botType: envStr(env, 'ILINK_BOT_TYPE', '3'),
    routeTag: envStr(env, 'ILINK_ROUTE_TAG', ''),
    requestTimeoutMs: envInt(env, 'ILINK_REQUEST_TIMEOUT_MS', 15000),
    qrPollTimeoutMs: envInt(env, 'ILINK_QR_POLL_TIMEOUT_MS', 35000),
    longPollTimeoutMs: envInt(env, 'ILINK_LONGPOLL_TIMEOUT_MS', 35000),
  };

  const mediaDirRaw = envStr(env, 'MEDIA_DIR', '');
  const mediaDir = mediaDirRaw
    ? (path.isAbsolute(mediaDirRaw) ? mediaDirRaw : path.resolve(ROOT_DIR, mediaDirRaw))
    : path.join(dataDir, 'media');

  const media = {
    dir: mediaDir,
    outboundMaxBytes: envInt(env, 'MEDIA_MAX_BYTES', 25 * 1024 * 1024),
    inboundMaxBytes: envInt(env, 'INBOUND_MEDIA_MAX_BYTES', 100 * 1024 * 1024),
    downloadTimeoutMs: envInt(env, 'MEDIA_DOWNLOAD_TIMEOUT_MS', 60000),
    uploadTimeoutMs: envInt(env, 'MEDIA_UPLOAD_TIMEOUT_MS', 60000),
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
    retryDelaysMs: retryDelaysMs.length > 0 ? retryDelaysMs : [5000, 15000, 30000, 60000],
    maxTextLength: envInt(env, 'MAX_TEXT_LENGTH', 4000),
    apiRateLimitPerMinute: envInt(env, 'API_RATE_LIMIT_PER_MINUTE', 60),
  };

  const monitor = {
    longPollTimeoutMs: envInt(env, 'MONITOR_LONGPOLL_TIMEOUT_MS', 35000),
    maxAccounts: envInt(env, 'MONITOR_MAX_ACCOUNTS', 200),
    maxConsecutiveFailures: 3,
    backoffMs: 30000,
    retryDelayMs: 2000,
    stalePauseMs: 60 * 60 * 1000,
  };

  // 24h 会话保活（docs/KEEPALIVE.md）：对开启 keepalive 的用户，在最后一条入站消息
  // 即将满窗口（默认 24h）前自动发一条保活消息，提示用户回复以刷新会话窗口。
  const keepalive = {
    enabled: envBool(env, 'KEEPALIVE_ENABLED', true),
    windowMs: Math.max(1000, envInt(env, 'KEEPALIVE_WINDOW_MS', 24 * 60 * 60 * 1000)),
    leadMs: Math.max(0, envInt(env, 'KEEPALIVE_LEAD_MS', 60 * 60 * 1000)),
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
  };

  // 定时通知（docs/SCHEDULED_TASKS.md）：按时间计划调用外部接口并把结果推送微信。
  const scheduler = {
    enabled: envBool(env, 'SCHEDULER_ENABLED', true),
    tickMs: Math.max(1000, envInt(env, 'SCHEDULER_TICK_MS', 15000)),
    timezone: envStr(env, 'SCHEDULER_TIMEZONE', 'Asia/Shanghai'),
    maxRecipients: Math.max(1, envInt(env, 'SCHEDULER_MAX_RECIPIENTS', 200)),
    timeoutMs: Math.max(1000, envInt(env, 'SCHEDULER_TIMEOUT_MS', 8000)),
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
      adminPassword,
      adminPasswordAuto,
      apiToken,
      apiTokenAuto,
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
