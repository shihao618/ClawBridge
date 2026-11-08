/**
 * 用户级凭据注入（规则 / 定时通知按用户模式共用）。
 *
 * 语法：在请求 URL / Header / Body 模板中写 `{credential:名称.字段}`（名称/字段命名规则
 * 与 data/user-secrets.js 一致：名称 [A-Za-z0-9_-]{1,32}，字段 [A-Za-z0-9_.-]{1,32}）。
 *
 * 安全约定：
 * - 凭据值只在本模块返回的内存 Map 中存在，不写日志、不进入 HTTP 响应；
 * - 缺失凭据抛 CredentialMissingError，错误信息只含 `名称.字段`，绝不包含任何值；
 * - 日志/错误/预览/事件统一经 redactCredentialValues() 脱敏（含 URL 编码形式）；
 * - 凭据确实被用于一次请求后调用 touchUsedCredentials() 更新 last_used_at（经 data/user-secrets）。
 */
import * as userSecrets from '../data/user-secrets.js';

/** 占位符（全局匹配）：{credential:名称.字段}。 */
const CREDENTIAL_PLACEHOLDER_RE = /\{credential:([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_.-]{1,32})\}/g;
/** 凭据引用的严格格式（内部归一化用）。 */
const CREDENTIAL_REF_RE = /^([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_.-]{1,32})$/;

/** 脱敏后的替换文本。 */
export const REDACTED_CREDENTIAL_VALUE = '***';

/** 凭据缺失错误（message 只含 `名称.字段` 列表，不含任何值）。 */
export class CredentialMissingError extends Error {
  /** @param {string[]} missing 缺失的 `名称.字段` 列表 */
  constructor(missing = []) {
    const unique = [...new Set((missing ?? []).map((item) => String(item)).filter(Boolean))];
    super(`missing credential ${unique.join(', ')}`);
    this.name = 'CredentialMissingError';
    this.code = 'CREDENTIAL_MISSING';
    this.missing = unique;
  }
}

/** 文本中的全部凭据引用（去重、保持出现顺序）。 */
export function findCredentialRefs(text) {
  if (typeof text !== 'string' || text === '') return [];
  const refs = [];
  const seen = new Set();
  for (const match of text.matchAll(CREDENTIAL_PLACEHOLDER_RE)) {
    const ref = `${match[1]}.${match[2]}`;
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

/** URL/Header/Body 模板中是否包含凭据占位符（定时任务汇总模式校验用）。 */
export function containsCredentialPlaceholder(value) {
  if (typeof value !== 'string' || value === '') return false;
  return new RegExp(CREDENTIAL_PLACEHOLDER_RE.source).test(value);
}

/**
 * 从请求配置收集凭据引用：`{url, headers, bodyTemplate}`。
 * @param {{url?:string, headers?:Record<string,string>, bodyTemplate?:string}} [request]
 * @returns {string[]} `名称.字段` 列表（去重）
 */
export function collectCredentialRefs(request = {}) {
  const refs = new Set();
  const scan = (value) => {
    for (const ref of findCredentialRefs(value)) refs.add(ref);
  };
  scan(request?.url);
  scan(request?.bodyTemplate);
  for (const value of Object.values(request?.headers ?? {})) scan(value);
  return [...refs];
}

/** 从引用列表提取凭据名称（去重，保持顺序）。 */
export function getCredentialNames(refs) {
  const names = [];
  const seen = new Set();
  for (const ref of refs ?? []) {
    const match = CREDENTIAL_REF_RE.exec(String(ref));
    const name = match ? match[1] : '';
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function lookupValue(values, key) {
  if (!values) return undefined;
  if (typeof values.get === 'function') return values.get(key);
  if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
  return undefined;
}

function collectValues(values) {
  if (!values) return [];
  const list = typeof values.get === 'function' ? [...values.values()] : Object.values(values);
  return list.map((item) => String(item ?? '')).filter((item) => item !== '');
}

/**
 * 替换模板中的 `{credential:...}` 占位符（非 URL 变量语法，不与其他 `{var}` 混用）。
 * @param {string} template
 * @param {Map<string,string>|Record<string,string>} values `名称.字段 → 值`
 * @param {{urlEncode?:boolean}} [options]
 * @returns {string}
 */
export function renderCredentialPlaceholders(template, values, { urlEncode = false } = {}) {
  if (typeof template !== 'string' || template === '') return String(template ?? '');
  return template.replace(CREDENTIAL_PLACEHOLDER_RE, (match, name, field) => {
    const value = lookupValue(values, `${name}.${field}`);
    if (value === undefined) return match;
    return urlEncode ? encodeURIComponent(value) : value;
  });
}

/**
 * 把本次用到的凭据值替换为 `***`（同时覆盖原始值与 URL 编码形式），
 * 供日志 / 错误 / 请求与响应预览 / events 统一脱敏。
 * @param {string} text
 * @param {Map<string,string>|Record<string,string>} values `名称.字段 → 值`
 * @returns {string}
 */
export function redactCredentialValues(text, values) {
  let output = String(text ?? '');
  if (output === '') return output;
  const variants = new Set();
  for (const value of collectValues(values)) {
    variants.add(value);
    try {
      variants.add(encodeURIComponent(value));
    } catch {
      /* 无法编码的值跳过 */
    }
  }
  // 长值优先替换，避免短值先替换破坏长值匹配
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    if (variant === '') continue;
    output = output.split(variant).join(REDACTED_CREDENTIAL_VALUE);
  }
  return output;
}

/** 记录凭据最近使用时间（失败不影响主流程）。 */
export function touchUsedCredentials(userId, names, ts) {
  if (!userId) return 0;
  const list = [...new Set([...(names ?? [])].map((name) => String(name ?? '')).filter(Boolean))];
  if (list.length === 0) return 0;
  try {
    return userSecrets.touchUserSecretsUsed(String(userId), list, ts);
  } catch {
    return 0;
  }
}

/**
 * 按用户解析一批凭据引用。
 * 缺失凭据（或字段）时抛 CredentialMissingError（信息只含名称）。
 * @param {string} userId 凭据所属用户（规则触发用户 / 定时任务按用户模式的目标用户）
 * @param {Iterable<string>} refs `名称.字段` 列表
 * @param {{touch?:boolean, ts?:number}} [options] touch=true 时成功解析后更新 last_used_at
 * @returns {{values:Map<string,string>, usedNames:Set<string>}}
 */
export function resolveRequestCredentials(userId, refs, { touch = true, ts } = {}) {
  const requested = [...new Set((refs ?? []).map((ref) => String(ref)).filter(Boolean))];
  const values = new Map();
  const usedNames = new Set();
  const missing = [];
  const byName = new Map();

  for (const ref of requested) {
    const match = CREDENTIAL_REF_RE.exec(ref);
    if (!match) {
      missing.push(ref);
      continue;
    }
    const [, name, field] = match;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ ref, field });
  }

  for (const [name, entries] of byName) {
    let fields = null;
    if (userId) {
      try {
        fields = userSecrets.getUserSecret(String(userId), name);
      } catch {
        // 解密/内容损坏：按缺失处理（错误信息只含名称，不向调用方透出底层细节）
        fields = null;
      }
    }
    if (!fields) {
      for (const entry of entries) missing.push(entry.ref);
      continue;
    }
    usedNames.add(name);
    for (const entry of entries) {
      if (!Object.prototype.hasOwnProperty.call(fields, entry.field)) {
        missing.push(entry.ref);
        continue;
      }
      values.set(entry.ref, String(fields[entry.field] ?? ''));
    }
  }

  if (missing.length > 0) throw new CredentialMissingError(missing);
  if (touch) touchUsedCredentials(userId, usedNames, ts);
  return { values, usedNames };
}
