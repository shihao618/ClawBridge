/**
 * 运行配置 schema：分组/字段元数据、config 路径映射、env 默认值快照。
 *
 * 注意：DEFAULTS 必须在 loadOverrides() 之前捕获 env 默认值；本模块在 import 时完成快照，
 * 与拆分前 settings.js 的模块加载期行为保持一致（settings.js 必须先 re-export 本模块）。
 */
import { config } from '../config.js';

import { cloneValue } from './validate.js';

/** 分组/字段定义（default 稍后从 config 快照生成）。 */
export const GROUPS = [
  {
    key: 'push',
    label: '推送与限流',
    fields: [
      { key: 'rateLimitMax', label: '每窗口最大发送数', type: 'number', min: 1, max: 100, restartRequired: true, description: '发送队列令牌桶容量，进程启动时创建，修改后需重启生效' },
      { key: 'rateLimitWindowMs', label: '限流窗口（毫秒）', type: 'number', min: 1000, max: 86400000, restartRequired: true, description: '令牌桶窗口，修改后需重启生效' },
      { key: 'tickMs', label: '出站队列扫描间隔（毫秒）', type: 'number', min: 50, max: 60000, description: 'dispatcher 无活时休眠间隔，每轮实时读取（即时生效）' },
      { key: 'maxAttempts', label: '最大重试次数', type: 'number', min: 1, max: 20, description: '单条消息发送失败后的最大尝试次数' },
      { key: 'errorNoticeEnabled', label: '发送失败时通知用户', type: 'boolean', description: '消息最终发送失败（非 -14 暂停／非 prepare failed）时向用户 best-effort 发送一条简短失败提示；不进入队列、不重试（即时生效）' },
      { key: 'apiRateLimitPerMinute', label: '对外 API 每分钟上限', type: 'number', min: 1, max: 10000, description: 'API Key 限流器每请求实时同步（即时生效）' },
      { key: 'maxTextLength', label: '消息最大长度', type: 'number', min: 1, max: 20000, description: '单条文本消息最大字符数' },
      { key: 'retryDelaysMs', label: '重试间隔（毫秒，逗号分隔）', type: 'numberArray', min: 0, max: 300000, description: '例如 5000,15000,30000,60000' },
    ],
  },
  {
    key: 'keepalive',
    label: '会话保活',
    fields: [
      { key: 'enabled', label: '全局开关', type: 'boolean', description: '关闭后不再自动发送保活消息' },
      { key: 'windowMs', label: '会话窗口（毫秒）', type: 'number', min: 60000, max: 604800000, description: '微信会话有效窗口，默认 24h' },
      { key: 'leadMs', label: '首次提前量（毫秒）', type: 'number', min: 0, max: 604800000, description: '窗口剩余该时长时首次触发保活' },
      { key: 'repeatMs', label: '重复提醒间隔（毫秒）', type: 'number', min: 1000, max: 604800000, description: '用户未回复时，每隔该时长重复提醒直到窗口过期' },
      { key: 'tickMs', label: '扫描间隔（毫秒）', type: 'number', min: 1000, max: 3600000, description: '保活调度扫描间隔' },
      { key: 'maxPerTick', label: '单次最多处理用户数', type: 'number', min: 1, max: 1000, description: '防御性上限' },
      { key: 'text', label: '保活文案', type: 'string', min: 1, max: 500, description: '支持 {name} 占位' },
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
      { key: 'maxQueue', label: '队列上限', type: 'number', min: 1, max: 10000, description: '内存队列最大长度，满则丢弃' },
      { key: 'allowedHosts', label: '内网/本机白名单', type: 'stringArray', description: '允许访问私网的主机名/IP（数组或逗号分隔；空=只允许公网）' },
      { key: 'typingIndicator', label: '请求时显示正在输入', type: 'boolean', description: '规则调用外部接口期间向触发用户显示微信「正在输入」（best-effort，失败不影响规则执行）' },
      { key: 'typingRefreshMs', label: '正在输入刷新间隔（毫秒）', type: 'number', min: 1000, max: 30000, description: '请求耗时较长时按该间隔重发「正在输入」状态（默认 5000ms，对齐官方微信插件 5s 续期）' },
    ],
  },
  {
    key: 'scheduler',
    label: '定时通知',
    fields: [
      { key: 'enabled', label: '全局开关', type: 'boolean', description: '关闭后不再自动执行定时任务' },
      { key: 'tickMs', label: '扫描间隔（毫秒）', type: 'number', min: 1000, max: 300000, description: '定时任务扫描间隔' },
      { key: 'timeoutMs', label: '请求超时（毫秒）', type: 'number', min: 1000, max: 30000, description: '外部接口单次请求超时上限' },
      { key: 'timezone', label: '时区（IANA）', type: 'string', min: 1, max: 64, validator: 'timezone', description: '每日任务使用的时区，如 Asia/Shanghai' },
      { key: 'maxRecipients', label: '单次最多收件人数', type: 'number', min: 1, max: 1000, description: '超过按用户 id 截断' },
      { key: 'maxResponseBytes', label: '响应大小上限（字节，0=继承接口应用）', type: 'number', min: 0, max: 10485760, description: '定时任务独立的响应大小上限；0 表示继承「接口应用」配置' },
      { key: 'allowedHosts', label: '内网/本机白名单（空=继承接口应用）', type: 'stringArray', description: '允许定时任务访问私网的主机名/IP；空数组表示继承「接口应用」白名单' },
      { key: 'perUserConcurrency', label: '按用户模式并发数', type: 'number', min: 1, max: 10, description: '按用户模式执行时同时请求的凭据组并发上限（即时生效）' },
      { key: 'perUserMaxRecipients', label: '按用户模式最多收件人数', type: 'number', min: 1, max: 200, description: '按用户模式执行时单任务最多展开的用户数，超过截断（即时生效）' },
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
      { key: 'inboundMaxConcurrent', label: '入站下载并发上限', type: 'number', min: 1, max: 16, restartRequired: true, description: '进程级入站媒体下载并发信号量，修改后需重启生效' },
      { key: 'inboundMaxQueue', label: '入站下载排队上限', type: 'number', min: 0, max: 1000, restartRequired: true, description: '超过排队上限的下载任务直接记失败（防止无限堆积），修改后需重启生效' },
      { key: 'allowedHosts', label: '入站下载允许主机', type: 'stringArray', description: '额外允许的媒体下载主机名/IP（iLink/CDN 主机与 localhost 自动允许；空=仅默认白名单）' },
      { key: 'allowInsecureHttp', label: '允许 HTTP 下载', type: 'boolean', description: '允许入站媒体通过 http 下载（默认仅 https，白名单主机/本机例外）；降低 SSRF 防护强度' },
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
      { key: 'publicBaseUrl', label: '对外访问地址', type: 'url', allowEmpty: true, description: '如 https://bot.example.com；非空且为 https 时管理 Cookie 自动加 Secure（运行配置即时生效）' },
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
      // iLink 客户端在每次请求时实时读取 config（buildHeaders/requestJson 等），
      // 新请求立即生效（不会重建已建立的绑定会话 Base URL），因此均无需重启。
      { key: 'loginBaseUrl', label: '登录服务地址', type: 'url', description: 'iLink 登录服务 Base URL（即时生效：新请求使用；已绑定会话沿用原地址）' },
      { key: 'defaultBaseUrl', label: '默认服务地址', type: 'url', description: 'iLink 业务服务 Base URL（即时生效：新请求使用；已绑定会话沿用原地址）' },
      { key: 'cdnBaseUrl', label: '媒体 CDN 地址', type: 'url', description: '媒体上传/下载 CDN Base URL（即时生效）' },
      { key: 'channelVersion', label: '渠道版本', type: 'string', min: 1, max: 50, description: '请求头中的 channel version（即时生效）' },
      { key: 'botAgent', label: 'Bot Agent', type: 'string', min: 1, max: 100, description: '请求头中的 Bot-Agent（即时生效）' },
      { key: 'botType', label: 'Bot 类型', type: 'string', min: 1, max: 20, description: 'iLink bot type（即时生效）' },
      { key: 'appId', label: 'App ID', type: 'string', min: 1, max: 100, description: 'iLink App ID（即时生效）' },
      { key: 'routeTag', label: '路由标签', type: 'string', min: 0, max: 200, description: '可选路由标签（即时生效）' },
      { key: 'clientVersion', label: '客户端版本号', type: 'number', min: 1, max: 1000000000, description: '请求头中的 client version（即时生效）' },
      { key: 'requestTimeoutMs', label: '请求超时（毫秒）', type: 'number', min: 1000, max: 120000, description: 'iLink 请求超时（即时生效）' },
      { key: 'qrPollTimeoutMs', label: '二维码轮询超时（毫秒）', type: 'number', min: 1000, max: 300000, description: '扫码状态轮询超时（即时生效）' },
      { key: 'longPollTimeoutMs', label: '长轮询超时（毫秒）', type: 'number', min: 1000, max: 300000, description: 'getupdates 长轮询超时（即时生效）' },
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

export const FIELD_BY_KEY = new Map();
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

export function readConfigField(field) {
  const path = field.configPath;
  if (path.length === 1) return config[path[0]];
  return config[path[0]]?.[path[1]];
}

export const DEFAULTS = new Map();
for (const group of GROUPS) {
  for (const field of group.fields) DEFAULTS.set(field.fullKey, cloneValue(readConfigField(field)));
}

export const DEFAULT_ENV_ONLY = {
  APP_SECRET: config.secrets.appSecret,
  DATA_DIR: config.dataDir,
  MEDIA_DIR: config.media.dir,
  PORT: String(config.port),
  HOST: config.host,
  NODE_ENV: config.nodeEnv,
};


/** 字段元数据（测试/诊断用）。 */
export function getSettingsSchema() {
  return GROUPS;
}
