/**
 * 运行配置（后台可改设置，docs/SETTINGS.md）。
 *
 * - SETTINGS_SCHEMA：可后台修改的分组/字段元数据（类型/范围/默认值/是否需重启）；
 * - 覆盖值存 DB `app_settings`（schema v8），启动时 `loadOverrides()` 应用；
 * - `updateSettings/resetGroup` 校验 → 写 DB → 立即覆盖 config → 触发运行时 hooks；
 * - 机密（管理密码哈希 / API Token 密文）也存 app_settings，后台可改、读取永不回明文；
 * - .env 仅保留 docs/SETTINGS.md §7.1 的启动必需项。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { config } from './config.js';
import { decryptSecretOrNull, encryptSecret, hashPassword, randomToken, verifyPassword, timingSafeEqualStr } from './crypto.js';
import { all, nowMs, run } from './db.js';
import { badRequest, unauthorized } from './errors.js';
import { logger, setLogLevel } from './logger.js';
import * as store from './store.js';

const log = logger.child({ mod: 'settings' });

/** 分组/字段定义（default 稍后从 config 快照生成）。 */
const GROUPS = [
  {
    key: 'push',
    label: '推送与限流',
    fields: [
      { key: 'rateLimitMax', label: '每窗口最大发送数', type: 'number', min: 1, max: 100, restartRequired: true, description: '发送队列令牌桶容量，进程启动时创建，修改后需重启生效' },
      { key: 'rateLimitWindowMs', label: '限流窗口（毫秒）', type: 'number', min: 1000, max: 86400000, restartRequired: true, description: '令牌桶窗口，修改后需重启生效' },
      { key: 'tickMs', label: '出站队列扫描间隔（毫秒）', type: 'number', min: 50, max: 60000, restartRequired: true, description: 'dispatcher worker 间隔，修改后需重启生效' },
      { key: 'maxAttempts', label: '最大重试次数', type: 'number', min: 1, max: 20, description: '单条消息发送失败后的最大尝试次数' },
      { key: 'retryDelaysMs', label: '重试间隔（毫秒，逗号分隔）', type: 'numberArray', min: 0, max: 300000, description: '例如 5000,15000,30000,60000' },
      { key: 'apiRateLimitPerMinute', label: '对外 API 每分钟上限', type: 'number', min: 1, max: 10000, restartRequired: true, description: 'API 限流器在服务启动时创建，修改后需重启生效' },
      { key: 'maxTextLength', label: '消息最大长度', type: 'number', min: 1, max: 20000, description: '单条文本消息最大字符数' },
    ],
  },
  {
    key: 'keepalive',
    label: '会话保活',
    fields: [
      { key: 'enabled', label: '全局开关', type: 'boolean', description: '关闭后不再自动发送保活消息' },
      { key: 'windowMs', label: '会话窗口（毫秒）', type: 'number', min: 60000, max: 604800000, description: '微信会话有效窗口，默认 24h' },
      { key: 'leadMs', label: '提前量（毫秒）', type: 'number', min: 0, max: 604800000, description: '窗口剩余该时长时触发保活' },
      { key: 'tickMs', label: '扫描间隔（毫秒）', type: 'number', min: 1000, max: 3600000, description: '保活调度扫描间隔' },
      { key: 'text', label: '保活文案', type: 'string', min: 1, max: 500, description: '支持 {name} 占位' },
      { key: 'maxPerTick', label: '单次最多处理用户数', type: 'number', min: 1, max: 1000, description: '防御性上限' },
    ],
  },
  {
    key: 'appRules',
    label: '接口应用',
    fields: [
      { key: 'enabled', label: '全局开关', type: 'boolean', description: '关闭后不再触发关键词规则' },
      { key: 'timeoutMs', label: '请求超时（毫秒）', type: 'number', min: 1000, max: 30000, description: '外部接口单次请求超时上限' },
      { key: 'maxResponseBytes', label: '响应大小上限（字节）', type: 'number', min: 1024, max: 10485760, description: '超过即判失败' },
      { key: 'workerConcurrency', label: '并发数', type: 'number', min: 1, max: 16, description: '规则执行 worker 并发数' },
      { key: 'allowedHosts', label: '内网/本机白名单', type: 'stringArray', description: '允许访问私网的主机名/IP（数组或逗号分隔；空=只允许公网）' },
      { key: 'maxQueue', label: '队列上限', type: 'number', min: 1, max: 10000, description: '内存队列最大长度，满则丢弃' },
    ],
  },
  {
    key: 'scheduler',
    label: '定时通知',
    fields: [
      { key: 'enabled', label: '全局开关', type: 'boolean', description: '关闭后不再自动执行定时任务' },
      { key: 'tickMs', label: '扫描间隔（毫秒）', type: 'number', min: 1000, max: 300000, description: '定时任务扫描间隔' },
      { key: 'timezone', label: '时区（IANA）', type: 'string', min: 1, max: 64, validator: 'timezone', description: '每日任务使用的时区，如 Asia/Shanghai' },
      { key: 'maxRecipients', label: '单次最多收件人数', type: 'number', min: 1, max: 1000, description: '超过按用户 id 截断' },
      { key: 'timeoutMs', label: '请求超时（毫秒）', type: 'number', min: 1000, max: 30000, description: '外部接口单次请求超时上限' },
    ],
  },
  {
    key: 'media',
    label: '媒体文件',
    fields: [
      { key: 'maxBytes', label: '上传大小上限（字节）', type: 'number', min: 1024, max: 1073741824, restartRequired: true, description: '上传 body 解析器在启动时初始化，增大上限需重启生效' },
      { key: 'inboundMaxBytes', label: '入站下载上限（字节）', type: 'number', min: 1024, max: 1073741824, description: '入站媒体下载大小上限' },
      { key: 'downloadTimeoutMs', label: '入站下载超时（毫秒）', type: 'number', min: 1000, max: 600000, description: '下载入站媒体超时' },
      { key: 'uploadTimeoutMs', label: '出站上传超时（毫秒）', type: 'number', min: 1000, max: 600000, description: '上传出站媒体超时' },
      { key: 'allowedImageMime', label: '允许的图片类型', type: 'mimeArray', description: '数组或逗号分隔，如 image/jpeg,image/png' },
      { key: 'allowedVideoMime', label: '允许的视频类型', type: 'mimeArray', description: '数组或逗号分隔，如 video/mp4' },
    ],
  },
  {
    key: 'binding',
    label: '扫码绑定',
    fields: [
      { key: 'ttlMs', label: '绑定会话有效期（毫秒）', type: 'number', min: 60000, max: 86400000, description: '扫码会话过期时间' },
      { key: 'maxRefreshes', label: '最大刷新次数', type: 'number', min: 1, max: 20, description: '同一会话允许刷新次数' },
      { key: 'maxActive', label: '最大并发会话数', type: 'number', min: 1, max: 1000, description: '同时存在的绑定会话上限' },
      { key: 'ipLimitPerHour', label: '单 IP 每小时创建次数', type: 'number', min: 1, max: 1000, description: '绑定创建限流' },
      { key: 'verifyTimeoutMs', label: '确认超时（毫秒）', type: 'number', min: 30000, max: 600000, description: '等待用户确认的超时' },
      { key: 'networkErrorLimit', label: '网络错误上限', type: 'number', min: 1, max: 100, description: '绑定轮询连续网络错误上限' },
      { key: 'pollGapMs', label: '轮询间隔（毫秒）', type: 'number', min: 0, max: 60000, description: '绑定状态轮询最小间隔' },
    ],
  },
  {
    key: 'server',
    label: '服务与日志',
    fields: [
      { key: 'publicBaseUrl', label: '对外访问地址', type: 'url', allowEmpty: true, description: '如 https://bot.example.com；空=按请求推断（Cookie Secure 自动判断）' },
      { key: 'trustProxy', label: '信任反向代理', type: 'boolean', restartRequired: true, description: '反向代理后需开启以获取真实 IP，修改后需重启生效' },
      { key: 'cookieSecure', label: 'Cookie 仅 HTTPS', type: 'boolean', description: '管理会话 Cookie 是否带 Secure 标记' },
      { key: 'logLevel', label: '日志级别', type: 'enum', options: ['debug', 'info', 'warn', 'error', 'silent'], description: '即时生效' },
    ],
  },
  {
    key: 'security',
    label: '安全',
    fields: [
      { key: 'sessionTtlMs', label: '管理会话有效期（毫秒）', type: 'number', min: 60000, max: 604800000, description: '登录 Cookie 有效期（即时生效，新登录使用）' },
      { key: 'pushApiEnabled', label: '启用对外推送 API', type: 'boolean', description: '关闭后 API Key 接口整体禁用' },
    ],
  },
  {
    key: 'ilink',
    label: '微信接入（iLink）',
    fields: [
      { key: 'loginBaseUrl', label: '登录服务地址', type: 'url', restartRequired: true, description: 'iLink 登录服务 Base URL（修改需重启）' },
      { key: 'defaultBaseUrl', label: '默认服务地址', type: 'url', restartRequired: true, description: 'iLink 业务服务 Base URL（修改需重启）' },
      { key: 'cdnBaseUrl', label: '媒体 CDN 地址', type: 'url', restartRequired: true, description: '媒体上传/下载 CDN Base URL（修改需重启）' },
      { key: 'appId', label: 'App ID', type: 'string', min: 1, max: 100, restartRequired: true, description: 'iLink App ID（修改需重启）' },
      { key: 'clientVersion', label: '客户端版本号', type: 'number', min: 1, max: 1000000000, restartRequired: true, description: '请求头中的 client version（修改需重启）' },
      { key: 'channelVersion', label: '渠道版本', type: 'string', min: 1, max: 50, restartRequired: true, description: '请求头中的 channel version（修改需重启）' },
      { key: 'botAgent', label: 'Bot Agent', type: 'string', min: 1, max: 100, restartRequired: true, description: '请求头中的 Bot-Agent（修改需重启）' },
      { key: 'botType', label: 'Bot 类型', type: 'string', min: 1, max: 20, restartRequired: true, description: 'iLink bot type（修改需重启）' },
      { key: 'routeTag', label: '路由标签', type: 'string', min: 0, max: 200, restartRequired: true, description: '可选路由标签（修改需重启）' },
      { key: 'requestTimeoutMs', label: '请求超时（毫秒）', type: 'number', min: 1000, max: 120000, restartRequired: true, description: 'iLink 请求超时（修改需重启）' },
      { key: 'qrPollTimeoutMs', label: '二维码轮询超时（毫秒）', type: 'number', min: 1000, max: 300000, restartRequired: true, description: '扫码状态轮询超时（修改需重启）' },
      { key: 'longPollTimeoutMs', label: '长轮询超时（毫秒）', type: 'number', min: 1000, max: 300000, restartRequired: true, description: 'getupdates 长轮询超时（修改需重启）' },
    ],
  },
  {
    key: 'monitor',
    label: '入站监控',
    fields: [
      { key: 'longPollTimeoutMs', label: '长轮询超时（毫秒）', type: 'number', min: 1000, max: 300000, restartRequired: true, description: '入站监控长轮询超时（修改需重启）' },
      { key: 'maxAccounts', label: '最大监控账号数', type: 'number', min: 1, max: 1000, restartRequired: true, description: '同时监控账号上限（修改需重启）' },
    ],
  },
];

/** 特殊配置 → config 实际路径。 */
const CONFIG_PATHS = {
  'media.maxBytes': ['media', 'outboundMaxBytes'],
  'binding.maxActive': ['binding', 'maxActiveSessions'],
  'server.publicBaseUrl': ['publicBaseUrl'],
  'server.trustProxy': ['trustProxy'],
  'server.cookieSecure': ['session', 'cookieSecure'],
  'server.logLevel': ['logLevel'],
  'security.sessionTtlMs': ['session', 'ttlMs'],
  'security.pushApiEnabled': ['pushApiEnabled'],
  'ilink.loginBaseUrl': ['ilink', 'loginBaseUrl'],
  'ilink.defaultBaseUrl': ['ilink', 'defaultBaseUrl'],
  'ilink.cdnBaseUrl': ['ilink', 'cdnBaseUrl'],
  'monitor.longPollTimeoutMs': ['monitor', 'longPollTimeoutMs'],
  'monitor.maxAccounts': ['monitor', 'maxAccounts'],
};

const FIELD_BY_KEY = new Map();
for (const group of GROUPS) {
  for (const field of group.fields) {
    field.group = group.key;
    field.fullKey = `${group.key}.${field.key}`;
    field.configPath = CONFIG_PATHS[field.fullKey] ?? [group.key, field.key];
    FIELD_BY_KEY.set(field.fullKey, field);
  }
}

// ---------------------------------------------------------------------------
// 默认值快照（必须在 loadOverrides 前捕获 env 默认值）
// ---------------------------------------------------------------------------
function cloneValue(value) {
  return Array.isArray(value) ? value.map((item) => (Array.isArray(item) ? item.slice() : item)) : value;
}

function readConfigField(field) {
  const path = field.configPath;
  if (path.length === 1) return config[path[0]];
  return config[path[0]]?.[path[1]];
}

function writeConfigField(field, value) {
  const path = field.configPath;
  if (path.length === 1) {
    config[path[0]] = value;
    return;
  }
  const [group, key] = path;
  if (!config[group]) throw badRequest(`配置分组不存在：${group}`);
  config[group][key] = value;
}

const DEFAULTS = new Map();
for (const group of GROUPS) {
  for (const field of group.fields) DEFAULTS.set(field.fullKey, cloneValue(readConfigField(field)));
}

const DEFAULT_ENV_ONLY = {
  APP_SECRET: config.secrets.appSecret,
  DATA_DIR: config.dataDir,
  MEDIA_DIR: config.media.dir,
  PORT: String(config.port),
  HOST: config.host,
  NODE_ENV: config.nodeEnv,
};

// 机密覆盖状态
let adminPasswordHashRecord = null;
let apiTokenEncPresent = false;

// ---------------------------------------------------------------------------
// 值校验
// ---------------------------------------------------------------------------
function fail(message) {
  throw badRequest(message);
}

function parseStringArray(raw) {
  let values;
  if (Array.isArray(raw)) values = raw;
  else if (typeof raw === 'string') values = raw.split(',');
  else fail('必须是数组或逗号分隔字符串');
  return values.map((value) => String(value).trim().toLowerCase()).filter((value) => value !== '');
}

function validateHostname(value) {
  if (net.isIP(value) !== 0) return true;
  if (value.length < 1 || value.length > 253) return false;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

function validateUrl(value, field, label) {
  if (value === '' && field.allowEmpty) return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} 不是合法 URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail(`${label} 仅允许 http/https`);
  if (parsed.username || parsed.password) fail(`${label} 不允许包含 userinfo`);
  return value.replace(/\/+$/, '');
}

function validateFieldValue(field, raw) {
  const label = `${field.group}.${field.key}`;
  if (field.type === 'boolean') {
    if (typeof raw !== 'boolean') fail(`${label} 必须是 boolean`);
    return raw;
  }
  if (field.type === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
      fail(`${label} 必须是整数`);
    }
    if (raw < field.min || raw > field.max) fail(`${label} 必须在 ${field.min}..${field.max} 之间`);
    return raw;
  }
  if (field.type === 'numberArray') {
    let list;
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string') list = raw.split(',');
    else fail(`${label} 必须是整数数组或逗号分隔字符串`);
    list = list.map((value) => String(value).trim()).filter((value) => value !== '');
    if (list.length === 0 || list.length > 10) fail(`${label} 必须包含 1..10 个数值`);
    return list.map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) fail(`${label} 包含非法数值：${value}`);
      if (parsed < field.min || parsed > field.max) fail(`${label} 每个数值必须在 ${field.min}..${field.max} 之间`);
      return parsed;
    });
  }
  if (field.type === 'stringArray') {
    const list = [...new Set(parseStringArray(raw))];
    if (list.length > 100) fail(`${label} 最多 100 项`);
    for (const value of list) {
      if (!validateHostname(value)) fail(`${label} 包含非法主机名：${value}`);
    }
    return list;
  }
  if (field.type === 'mimeArray') {
    const list = [...new Set(parseStringArray(raw))];
    if (list.length === 0 || list.length > 50) fail(`${label} 必须包含 1..50 个 MIME 类型`);
    for (const value of list) {
      if (!MIME_RE.test(value)) fail(`${label} 包含非法 MIME 类型：${value}`);
    }
    return list;
  }
  if (field.type === 'enum') {
    if (typeof raw !== 'string' || !field.options.includes(raw)) {
      fail(`${label} 必须是 ${field.options.join('/')} 之一`);
    }
    return raw;
  }
  // string / url
  if (typeof raw !== 'string') fail(`${label} 必须是字符串`);
  const value = raw.trim();
  if (field.type === 'url') return validateUrl(value, field, label);
  if (value.length < field.min || value.length > field.max) {
    fail(`${label} 长度必须在 ${field.min}..${field.max} 之间`);
  }
  if (field.validator === 'timezone') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
    } catch {
      fail(`${label} 不是合法的 IANA 时区`);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// envOnly（只读、脱敏展示 + env 默认快照）
// ---------------------------------------------------------------------------
function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '未配置';
  if (text.length <= 8) return '已配置（隐藏）';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function previewToken(value) {
  const text = String(value ?? '');
  if (!text) return '未配置';
  if (text.length <= 12) return '已配置（隐藏）';
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function envOnlyEntries() {
  const show = (key, label, value, secret = false) => ({
    key,
    label,
    value: secret ? maskSecret(value) : value,
    default: secret ? maskSecret(DEFAULT_ENV_ONLY[key]) : DEFAULT_ENV_ONLY[key],
    secret,
  });
  return [
    show('APP_SECRET', 'APP_SECRET（加密主密钥）', config.secrets.appSecret, true),
    show('DATA_DIR', 'DATA_DIR（数据目录）', config.dataDir),
    show('MEDIA_DIR', 'MEDIA_DIR（媒体目录）', config.media.dir),
    show('PORT', 'PORT（监听端口）', String(config.port)),
    show('HOST', 'HOST（监听地址）', config.host),
    show('NODE_ENV', 'NODE_ENV（运行模式）', config.nodeEnv),
  ];
}

// ---------------------------------------------------------------------------
// 运行时 hooks（依赖注入，避免循环 import）
// ---------------------------------------------------------------------------
let hooks = {
  restartKeepalive: () => {},
  restartScheduler: () => {},
  restartAppRules: () => {},
};

/** 注入运行时 hooks（index.js 在各引擎启动后调用；测试可注入 spy）。 */
export function setRuntimeHooks(next = {}) {
  hooks = { ...hooks, ...next };
}

function runRuntimeHooks(changedGroups) {
  const set = new Set(changedGroups);
  const runHook = (name) => {
    try {
      hooks[name]?.();
    } catch (err) {
      log.warn('运行配置 hook 执行失败（已忽略）', { hook: name, message: err?.message });
    }
  };
  if (set.has('keepalive')) runHook('restartKeepalive');
  if (set.has('scheduler')) runHook('restartScheduler');
  if (set.has('appRules')) runHook('restartAppRules');
}

// ---------------------------------------------------------------------------
// 内部工具：UPSERT / 事件
// ---------------------------------------------------------------------------
function upsertSetting(key, jsonValue, ts = nowMs()) {
  run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    jsonValue,
    ts,
  );
}

function deleteSetting(key) {
  run('DELETE FROM app_settings WHERE key = ?', key);
}

function addSettingsEvent(detail) {
  store.addEvent({ type: 'settings_update', detail: JSON.stringify(detail) });
}

function verifyCurrentAdminPassword(currentPassword) {
  if (typeof currentPassword !== 'string' || currentPassword === '') {
    fail('currentPassword 必须是非空字符串');
  }
  if (!adminPasswordHashRecord) return false;
  return verifyPassword(currentPassword, adminPasswordHashRecord);
}

// ---------------------------------------------------------------------------
// 对外函数
// ---------------------------------------------------------------------------

/** 读取当前有效配置（托管分组；测试用）。 */
export function getEffectiveConfig() {
  const result = {};
  for (const group of GROUPS) {
    result[group.key] = {};
    for (const field of group.fields) result[group.key][field.key] = cloneValue(readConfigField(field));
  }
  return result;
}

/** 机密状态（无 env 回退；来源恒为 DB，永不返回哈希/Token 明文）。 */
export function getSecurityState() {
  return {
    adminPasswordSource: 'db',
    apiTokenSource: 'db',
    apiTokenPreview: config.pushApiEnabled ? previewToken(config.secrets.apiToken) : '已禁用',
    pushApiEnabled: Boolean(config.pushApiEnabled),
    sessionTtlMs: config.session.ttlMs,
  };
}

/** 读取 DB 中管理密码 scrypt 哈希记录（auth 校验优先使用）。 */
export function getAdminPasswordHashRecord() {
  return adminPasswordHashRecord;
}

/** 读取运行配置（分组字段当前值/默认值/范围 + envOnly 脱敏值 + security 状态）。 */
export function getSettings() {
  return {
    groups: GROUPS.map((group) => ({
      key: group.key,
      label: group.label,
      fields: group.fields.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        options: field.options ?? undefined,
        value: cloneValue(readConfigField(field)),
        default: cloneValue(DEFAULTS.get(field.fullKey)),
        min: field.min,
        max: field.max,
        restartRequired: Boolean(field.restartRequired),
        description: field.description ?? '',
      })),
    })),
    envOnly: envOnlyEntries(),
    security: getSecurityState(),
  };
}

/** 处理 security.* 机密覆盖行（loadOverrides 内部）。 */
function loadSecretOverrides(rows) {
  for (const row of rows) {
    if (row.key === 'security.adminPasswordHash') {
      try {
        const parsed = JSON.parse(row.value);
        if (typeof parsed === 'string' && parsed.startsWith('scrypt$')) {
          adminPasswordHashRecord = parsed;
        } else {
          log.warn('忽略非法管理密码哈希覆盖值');
        }
      } catch {
        log.warn('忽略非法 JSON 的管理密码哈希覆盖值');
      }
    } else if (row.key === 'security.apiTokenEnc') {
      try {
        const parsed = JSON.parse(row.value);
        const token = typeof parsed === 'string' ? decryptSecretOrNull(parsed) : null;
        if (token) {
          config.secrets.apiToken = token;
          config.secrets.apiTokenAuto = false;
          apiTokenEncPresent = true;
        } else {
          log.warn('忽略无法解密/非法的 API Token 覆盖值');
        }
      } catch {
        log.warn('忽略非法 JSON 的 API Token 覆盖值');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 首次启动引导（仅 DB 管理机密；无 env 回退）
// ---------------------------------------------------------------------------
const ADMIN_PASSWORD_FILE = 'admin-password.txt';
const API_TOKEN_FILE = 'api-token.txt';

function secretsFilePath(name) {
  return path.join(config.dataDir, name);
}

/** 写机密文件（0600；失败仅 warn，不影响服务启动）。 */
function writeSecretFile(name, value) {
  const filePath = secretsFilePath(name);
  try {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, `${value}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* Windows 等平台忽略 */
    }
  } catch (err) {
    log.warn('写入机密文件失败（不影响服务运行）', { file: name, message: err?.message });
  }
  return filePath;
}

function generateAdminPassword() {
  // 12 字节 base64url ≈ 16 字符
  return randomToken(12);
}

function generateApiToken() {
  return `cb_${randomToken(24)}`;
}

/**
 * 首次启动引导（index 在 loadOverrides 之后、引擎启动前调用；幂等）：
 *  - DB 无管理密码哈希 → 生成随机密码，scrypt 哈希存 DB，写 DATA_DIR/admin-password.txt(0600)；
 *  - DB 无 API Token 密文 → 生成 cb_... token，AES 加密存 DB，写 DATA_DIR/api-token.txt(0600)，
 *    更新 config.secrets.apiToken / pushApiEnabled。
 * 二次启动（DB 已有值）不重新生成。
 * @returns {{adminPasswordGenerated:boolean, apiTokenGenerated:boolean, adminPasswordFile:string, apiTokenFile:string}}
 */
export function bootstrapSecrets() {
  const result = {
    adminPasswordGenerated: false,
    apiTokenGenerated: false,
    adminPasswordFile: secretsFilePath(ADMIN_PASSWORD_FILE),
    apiTokenFile: secretsFilePath(API_TOKEN_FILE),
  };
  if (!adminPasswordHashRecord) {
    const password = generateAdminPassword();
    const record = hashPassword(password);
    upsertSetting('security.adminPasswordHash', JSON.stringify(record));
    adminPasswordHashRecord = record;
    writeSecretFile(ADMIN_PASSWORD_FILE, password);
    result.adminPasswordGenerated = true;
    addSettingsEvent({ action: 'bootstrap_admin_password', source: 'db' });
    log.info('初始管理密码已生成，请查看文件', { file: `data/${ADMIN_PASSWORD_FILE}` });
  }
  if (!apiTokenEncPresent) {
    const token = generateApiToken();
    upsertSetting('security.apiTokenEnc', JSON.stringify(encryptSecret(token)));
    apiTokenEncPresent = true;
    config.secrets.apiToken = token;
    config.secrets.apiTokenAuto = false;
    upsertSetting('security.pushApiEnabled', 'true');
    config.pushApiEnabled = true;
    writeSecretFile(API_TOKEN_FILE, token);
    result.apiTokenGenerated = true;
    addSettingsEvent({ action: 'bootstrap_api_token', source: 'db' });
    log.info('初始 API Token 已生成，请查看文件', { file: `data/${API_TOKEN_FILE}` });
  }
  return result;
}/**
 * 启动时加载 DB 覆盖值并写入 config（非法值忽略并 warn，不影响启动）。
 * 不再从 env 迁移机密；机密仅由 DB/bootstrap/rotate 管理。
 * @returns {{applied:number, ignored:number}}
 */
export function loadOverrides() {
  const rows = all('SELECT key, value FROM app_settings');
  let applied = 0;
  let ignored = 0;
  loadSecretOverrides(rows);
  for (const row of rows) {
    if (
      row.key === 'security.adminPasswordHash' ||
      row.key === 'security.apiTokenEnc'
    ) {
      continue;
    }
    const field = FIELD_BY_KEY.get(row.key);
    if (!field) {
      ignored += 1;
      log.warn('忽略未知的运行配置项', { key: row.key });
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(row.value);
    } catch {
      ignored += 1;
      log.warn('忽略非法 JSON 的运行配置项', { key: row.key });
      continue;
    }
    try {
      const value = validateFieldValue(field, raw);
      writeConfigField(field, value);
      applied += 1;
    } catch (err) {
      ignored += 1;
      log.warn('忽略非法运行配置覆盖值', { key: row.key, message: err?.message });
    }
  }
  log.info('运行配置覆盖已加载', { applied, ignored });
  return { applied, ignored };
}

/** 变更管理密码（校验当前密码 → 写 scrypt 哈希 → 立即生效）。 */
export function changeAdminPassword(currentPassword, newPassword) {
  if (!verifyCurrentAdminPassword(currentPassword)) throw unauthorized('当前密码错误');
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
    fail('newPassword 长度必须是 8..128');
  }
  const record = hashPassword(newPassword);
  upsertSetting('security.adminPasswordHash', JSON.stringify(record));
  adminPasswordHashRecord = record;
  addSettingsEvent({ action: 'change_admin_password', source: 'db' });
  log.info('管理密码已更新（DB 哈希）');
  return { ok: true, adminPasswordSource: 'db' };
}

/** 重置管理密码：校验当前密码后生成新的随机密码（写 DB 哈希 + admin-password.txt，明文仅本次返回）。 */
export function resetAdminPassword(currentPassword) {
  if (!verifyCurrentAdminPassword(currentPassword)) throw unauthorized('当前密码错误');
  const password = generateAdminPassword();
  const record = hashPassword(password);
  upsertSetting('security.adminPasswordHash', JSON.stringify(record));
  adminPasswordHashRecord = record;
  writeSecretFile(ADMIN_PASSWORD_FILE, password);
  addSettingsEvent({ action: 'reset_admin_password', source: 'db' });
  log.info('管理密码已重新生成（DB 哈希）', { file: `data/${ADMIN_PASSWORD_FILE}` });
  return {
    ok: true,
    password,
    source: 'db',
    adminPasswordSource: 'db',
    file: `data/${ADMIN_PASSWORD_FILE}`,
  };
}

/** 重新生成 API Token（返回明文仅此一次，DB 存密文 + 写 api-token.txt）。 */
export function rotateApiToken() {
  const token = generateApiToken();
  upsertSetting('security.apiTokenEnc', JSON.stringify(encryptSecret(token)));
  apiTokenEncPresent = true;
  config.secrets.apiToken = token;
  config.secrets.apiTokenAuto = false;
  upsertSetting('security.pushApiEnabled', 'true');
  config.pushApiEnabled = true;
  writeSecretFile(API_TOKEN_FILE, token);
  addSettingsEvent({ action: 'rotate_api_token', source: 'db', pushApiEnabled: true });
  log.info('API Token 已重新生成（DB 密文）', { file: `data/${API_TOKEN_FILE}` });
  return {
    ok: true,
    token,
    apiTokenPreview: previewToken(token),
    source: 'db',
    apiTokenSource: 'db',
    pushApiEnabled: true,
    file: `data/${API_TOKEN_FILE}`,
  };
}

/** 重置 API Token：生成新的随机 token（同 rotate 语义；不再回退 env/文件）。 */
export function resetApiToken() {
  const token = generateApiToken();
  upsertSetting('security.apiTokenEnc', JSON.stringify(encryptSecret(token)));
  apiTokenEncPresent = true;
  config.secrets.apiToken = token;
  config.secrets.apiTokenAuto = false;
  upsertSetting('security.pushApiEnabled', 'true');
  config.pushApiEnabled = true;
  writeSecretFile(API_TOKEN_FILE, token);
  addSettingsEvent({ action: 'reset_api_token', source: 'db', pushApiEnabled: true });
  log.info('API Token 已重置（DB 密文）', { file: `data/${API_TOKEN_FILE}` });
  return {
    ok: true,
    token,
    apiTokenPreview: previewToken(token),
    source: 'db',
    apiTokenSource: 'db',
    pushApiEnabled: true,
    file: `data/${API_TOKEN_FILE}`,
  };
}

/** 批量更新运行配置：校验 → UPSERT → 立即应用到 config → 运行时 hooks。 */
export function updateSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('请求体必须是对象');
  const groupKeys = Object.keys(patch);
  if (groupKeys.length === 0) fail('至少提交一个配置分组');

  const changes = [];
  for (const groupKey of groupKeys) {
    const group = GROUPS.find((item) => item.key === groupKey);
    if (!group) fail(`未知配置分组：${groupKey}`);
    const values = patch[groupKey];
    if (!values || typeof values !== 'object' || Array.isArray(values)) fail(`${groupKey} 必须是对象`);
    const fieldKeys = Object.keys(values);
    if (fieldKeys.length === 0) fail(`${groupKey} 至少提交一个字段`);
    for (const fieldKey of fieldKeys) {
      const field = group.fields.find((item) => item.key === fieldKey);
      if (!field) fail(`未知配置字段：${groupKey}.${fieldKey}`);
      changes.push({ field, value: validateFieldValue(field, values[fieldKey]) });
    }
  }

  const now = nowMs();
  for (const change of changes) {
    upsertSetting(change.field.fullKey, JSON.stringify(change.value), now);
    writeConfigField(change.field, change.value);
  }

  const changedGroups = [...new Set(changes.map((change) => change.field.group))];
  // logLevel / cookieSecure / publicBaseUrl 等即时类字段的应用
  if (changedGroups.includes('server')) setLogLevel(config.logLevel);
  runRuntimeHooks(changedGroups);
  const restartRequired = changes.filter((change) => change.field.restartRequired).map((change) => change.field.fullKey);
  addSettingsEvent({
    groups: changedGroups,
    fields: changes.map((change) => change.field.fullKey),
  });
  log.info('运行配置已更新', { groups: changedGroups, fields: changes.map((change) => change.field.fullKey), restartRequired });
  return { ok: true, groups: getSettings().groups, restartRequired };
}

/** 恢复某分组为 env 默认值（删除该组 DB 覆盖 + 重新应用 config + hooks）。 */
export function resetGroup(groupKey) {
  const group = GROUPS.find((item) => item.key === groupKey);
  if (!group) fail(`未知配置分组：${groupKey}`);
  const placeholders = group.fields.map(() => '?').join(', ');
  run(
    `DELETE FROM app_settings WHERE key IN (${placeholders})`,
    ...group.fields.map((field) => field.fullKey),
  );
  for (const field of group.fields) writeConfigField(field, cloneValue(DEFAULTS.get(field.fullKey)));
  if (group.key === 'server') setLogLevel(config.logLevel);
  runRuntimeHooks([group.key]);
  addSettingsEvent({ groups: [group.key], fields: ['reset'] });
  log.info('运行配置分组已恢复默认', { group: group.key });
  return { ok: true, groups: getSettings().groups };
}

/** 字段元数据（测试/诊断用）。 */
export function getSettingsSchema() {
  return GROUPS;
}
