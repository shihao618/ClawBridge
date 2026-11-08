/**
 * 极简结构化日志器：单行 JSON 输出，自动脱敏敏感字段。
 * 不依赖第三方库，容器内 stdout 采集友好。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const SENSITIVE_KEY_RE = /(authorization|token|secret|password|api[-_]?key|context_token|bot_token)/i;
const MAX_STRING = 2000;

/** URL query 中需要脱敏的参数名（小写精确匹配；与字段名脱敏口径一致）。 */
const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'bot_token',
  'context_token',
  'key',
  'api_key',
  'api-key',
  'apikey',
  'authorization',
  'auth',
  'password',
  'secret',
  'client_secret',
]);

let currentLevel = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

export function setLogLevel(level) {
  currentLevel = LEVELS[String(level).toLowerCase()] ?? currentLevel;
}

/** 把 query string（可带前导 ?）中敏感参数的值替换为 [redacted]，保留参数顺序与其他内容。 */
function redactQueryString(search) {
  const prefix = search.startsWith('?') ? '?' : '';
  const body = search.slice(prefix.length);
  if (body === '') return search;
  const parts = body.split('&').map((part) => {
    if (part === '') return part;
    const eqIndex = part.indexOf('=');
    const rawKey = eqIndex === -1 ? part : part.slice(0, eqIndex);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
      /* 非法百分号编码：按原文匹配 */
    }
    if (!SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return part;
    return `${rawKey}=[redacted]`;
  });
  return prefix + parts.join('&');
}

/**
 * 日志用 URL 脱敏：保留 origin/path/query 结构与其余参数，仅把敏感 query 参数值替换为 [redacted]。
 * 支持绝对 URL 与 Express req.originalUrl 这类相对路径；无 query 时原样返回。
 */
export function redactUrlQueryForLog(rawUrl) {
  const raw = String(rawUrl ?? '');
  if (raw === '') return '';
  const hashIndex = raw.indexOf('#');
  const beforeHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : raw.slice(hashIndex);
  const queryIndex = beforeHash.indexOf('?');
  if (queryIndex === -1) return raw;
  return beforeHash.slice(0, queryIndex) + redactQueryString(beforeHash.slice(queryIndex)) + hash;
}

function serializeValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code, ret: value.ret, stack: value.stack };
  }
  if (depth >= 3) return '[object]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => serializeValue(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[redacted]' : serializeValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function emit(level, message, fields, base) {
  if ((LEVELS[level] ?? LEVELS.info) < currentLevel) return;
  const record = {
    ts: new Date().toISOString(),
    level: level.toUpperCase(),
    msg: String(message),
    ...(base ? serializeValue(base) : {}),
    ...(fields ? serializeValue(fields) : {}),
  };
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(base = {}) {
  return {
    child(extra) {
      return createLogger({ ...base, ...extra });
    },
    debug: (message, fields) => emit('debug', message, fields, base),
    info: (message, fields) => emit('info', message, fields, base),
    warn: (message, fields) => emit('warn', message, fields, base),
    error: (message, fields) => emit('error', message, fields, base),
    setLevel: setLogLevel,
  };
}

export const logger = createLogger();
