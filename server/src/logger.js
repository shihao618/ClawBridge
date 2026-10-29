/**
 * 极简结构化日志器：单行 JSON 输出，自动脱敏敏感字段。
 * 不依赖第三方库，容器内 stdout 采集友好。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const SENSITIVE_KEY_RE = /(authorization|token|secret|password|api[-_]?key|context_token|bot_token)/i;
const MAX_STRING = 2000;

let currentLevel = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

export function setLogLevel(level) {
  currentLevel = LEVELS[String(level).toLowerCase()] ?? currentLevel;
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
