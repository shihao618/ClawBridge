/**
 * 接口应用（docs/API_RULES.md）：关键词触发 → 调外部 HTTP 接口 → 解析并回复微信用户。
 *
 * 模块构成：
 *  - 纯函数：matchRule / extractParams / 模板渲染 / 响应解析 / 回复渲染 / 路径取值；
 *  - SSRF 防护：协议/userinfo 校验、DNS 解析后私网拒绝、APP_RULES_ALLOWED_HOSTS 白名单、
 *    重定向逐跳复验、超时/响应大小限制、仅接受文本响应；
 *  - RuleEngine：内存队列 + 并发 worker（不阻塞 getupdates）、去重/冷却/小时配额、
 *    成功/失败均写 app_rule_logs、失败按 fallback 回复；
 *  - testRule：管理端 dry-run（不发送、不写运行日志）。
 */
import { promises as dnsPromises } from 'node:dns';
import net from 'node:net';

import { config } from './config.js';
import { decryptSecretOrNull } from './crypto.js';
import { logger } from './logger.js';
import * as store from './store.js';

const log = logger.child({ mod: 'app-rules' });

const REDACT_KEY_RE = /(token|secret|password|api[-_]?key|authorization)/i;
const MAX_REPLY_LENGTH = () => config.push.maxTextLength;

// ---------------------------------------------------------------------------
// 可注入依赖（测试用；默认真实 fetch/dns/now）
// ---------------------------------------------------------------------------
const defaultDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  dnsLookup: (hostname, options) => dnsPromises.lookup(hostname, options),
  now: () => Date.now(),
};
let deps = { ...defaultDeps };

/** 注入测试依赖（fetch/dnsLookup/now），未传字段保持不变。 */
export function configureDependencies(overrides = {}) {
  deps = { ...deps, ...overrides };
}

/** 恢复默认真实依赖。 */
export function resetDependencies() {
  deps = { ...defaultDeps };
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 截断文本（超长直接截断并加省略号）。 */
export function truncate(value, max = 1000) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

/** 按点路径取值（支持 a.b.0.c / 数组下标）。未取到返回 undefined。 */
export function getByPath(value, path) {
  if (!path) return value;
  const parts = String(path)
    .split('.')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

/** 值转展示文本：字符串原样，对象/数组 JSON.stringify，null/undefined → ''。 */
function valueToText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 日志脱敏：包含 token/secret/password/api-key/authorization 的键替换为 [redacted]。 */
export function redactForLog(value, depth = 0) {
  if (depth > 4) return '[object]';
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = REDACT_KEY_RE.test(key) ? '[redacted]' : redactForLog(val, depth + 1);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 规则解析 / 匹配 / 参数提取
// ---------------------------------------------------------------------------

/** 把 app_rules 原始行解析为引擎执行配置（含解密后的 request headers）。 */
export function parseRuleRow(row) {
  if (!row) return null;
  const json = (value, fallback) => {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };
  let headers = {};
  const decrypted = decryptSecretOrNull(row.request_headers_enc);
  if (decrypted) {
    const parsed = safeJsonParse(decrypted);
    if (parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
      headers = parsed.value;
    }
  }
  return {
    id: row.id,
    name: row.name ?? '',
    enabled: Boolean(row.enabled),
    priority: Number(row.priority) || 100,
    scope: {
      type: row.scope_type ?? 'all',
      ids: Array.isArray(json(row.scope_ids, [])) ? json(row.scope_ids, []) : [],
    },
    match: {
      mode: row.match_mode ?? 'contains',
      keywords: Array.isArray(json(row.keywords, [])) ? json(row.keywords, []) : [],
      regexPattern: row.regex_pattern ?? '',
    },
    extraction: {
      mode: row.extraction_mode ?? 'trailing',
      config: json(row.extraction_config, {}) ?? {},
    },
    request: {
      method: (row.request_method ?? 'GET').toUpperCase(),
      url: row.request_url ?? '',
      headers,
      bodyTemplate: row.request_body_template ?? '',
    },
    response: {
      type: row.response_type ?? 'json',
      path: row.response_path ?? '',
      template: row.reply_template ?? '',
      fallbackText: row.fallback_text ?? '',
    },
    limits: {
      timeoutMs: Number(row.timeout_ms) || config.appRules.timeoutMs,
      cooldownMs: Number(row.cooldown_ms) || 0,
      maxCallsPerHour: Number(row.max_calls_per_hour) || 60,
      maxUserCallsPerHour: Number(row.max_user_calls_per_hour) || 10,
    },
  };
}

/** 范围匹配：all / users（scope_ids 含 userId）/ groups（用户属于任一分组）。 */
export function matchScope(rule, { userId = '', groupIds = [] } = {}) {
  const scope = rule.scope ?? { type: 'all', ids: [] };
  if (scope.type === 'all') return true;
  if (scope.type === 'users') return scope.ids.map(String).includes(String(userId));
  if (scope.type === 'groups') {
    const set = new Set((groupIds ?? []).map(String));
    return scope.ids.map(String).some((groupId) => set.has(groupId));
  }
  return false;
}

/** 关键词/正则匹配（大小写不敏感 contains；equals 比较 trim 后原样）。 */
export function matchKeywords(rule, text) {
  const raw = String(text ?? '');
  const matcher = rule.match ?? {};
  if (matcher.mode === 'regex') {
    try {
      return new RegExp(matcher.regexPattern, 'u').test(raw);
    } catch {
      return false;
    }
  }
  const keywords = Array.isArray(matcher.keywords) ? matcher.keywords : [];
  if (matcher.mode === 'equals') {
    const trimmed = raw.trim();
    return keywords.some((keyword) => trimmed === String(keyword).trim());
  }
  const lower = raw.toLowerCase();
  return keywords.some((keyword) => keyword !== '' && lower.includes(String(keyword).toLowerCase()));
}

/** 规则匹配（范围 + 关键词/正则）。 */
export function matchRule(rule, messageContext = {}) {
  if (!rule) return false;
  if (!matchScope(rule, messageContext)) return false;
  return matchKeywords(rule, messageContext.text);
}

/**
 * 参数提取（docs/API_RULES.md §3）。
 * @returns {{params:object, vars:object, missing:boolean, primaryKey:string, primaryValue:string}}
 */
export function extractParams(rule, options = {}) {
  const { text = '', userId = '', displayName = '', now = Date.now() } = options;
  const rawText = String(text ?? '');
  const mode = rule.extraction?.mode ?? 'trailing';
  const cfg = rule.extraction?.config ?? {};
  const params = {};
  let primaryKey = typeof cfg.param === 'string' && cfg.param ? cfg.param : 'arg';
  let primaryValue = '';

  if (mode === 'trailing') {
    const keywords = rule.match?.mode === 'equals' ? rule.match.keywords : rule.match?.keywords ?? [];
    const lower = rawText.toLowerCase();
    let earliest = -1;
    let matchedKeyword = '';
    for (const keyword of keywords) {
      if (!keyword) continue;
      const index = lower.indexOf(String(keyword).toLowerCase());
      if (index >= 0 && (earliest === -1 || index < earliest)) {
        earliest = index;
        matchedKeyword = String(keyword);
      }
    }
    primaryValue = earliest >= 0 ? rawText.slice(earliest + matchedKeyword.length).trim() : rawText.trim();
    if (primaryValue) params[primaryKey] = primaryValue;
  } else if (mode === 'regex') {
    const pattern = String(cfg.regex ?? '');
    let match = null;
    try {
      match = pattern ? new RegExp(pattern, 'u').exec(rawText) : null;
    } catch {
      match = null;
    }
    if (match) {
      const groups = match.groups && Object.keys(match.groups).length > 0 ? match.groups : null;
      if (groups) {
        for (const [key, value] of Object.entries(groups)) {
          if (value !== undefined && value !== '') params[key] = value;
        }
      } else if (match[1] !== undefined && match[1] !== '') {
        params.arg = match[1];
      }
      if (groups) {
        primaryKey = Object.keys(groups)[0] ?? 'arg';
        primaryValue = params[primaryKey] ?? '';
      } else {
        primaryKey = 'arg';
        primaryValue = params.arg ?? '';
      }
    }
  } else if (mode === 'json') {
    const parsed = safeJsonParse(rawText);
    if (parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
      for (const [key, value] of Object.entries(parsed.value)) {
        if (value === null || value === undefined) continue;
        params[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
    }
    primaryKey = typeof cfg.param === 'string' && cfg.param ? cfg.param : Object.keys(params)[0] ?? 'arg';
    primaryValue = params[primaryKey] ?? '';
  } else if (mode === 'fulltext') {
    primaryKey = typeof cfg.param === 'string' && cfg.param ? cfg.param : 'text';
    primaryValue = rawText.trim();
    if (primaryValue) params[primaryKey] = primaryValue;
  } else if (mode === 'multi') {
    Object.assign(params, extractMultiParams(rule, rawText));
    primaryKey = typeof cfg.param === 'string' && cfg.param ? cfg.param : Object.keys(params)[0] ?? 'arg';
    primaryValue = params[primaryKey] ?? '';
  }

  const required = mode === 'none' ? [] : Array.isArray(cfg.required) ? cfg.required.map(String) : [];
  let missing;
  if (mode === 'none') {
    missing = false;
  } else if (mode === 'multi') {
    missing =
      required.length > 0
        ? required.some((key) => params[key] === undefined || params[key] === '')
        : Object.keys(params).length === 0;
  } else {
    missing =
      Object.keys(params).length === 0 ||
      primaryValue === '' ||
      required.some((key) => params[key] === undefined || params[key] === '');
  }
  const vars = {
    text: rawText,
    arg: primaryValue,
    userId: String(userId ?? ''),
    name: String(displayName ?? ''),
    now: String(now),
    ...params,
  };
  return { params, vars, missing, primaryKey, primaryValue };
}

/** 在文本中查找最早出现的关键词（大小写不敏感）。 */
function findEarliestKeyword(rawText, keywords) {
  const lower = rawText.toLowerCase();
  let earliest = -1;
  let matchedKeyword = '';
  for (const keyword of keywords ?? []) {
    if (!keyword) continue;
    const index = lower.indexOf(String(keyword).toLowerCase());
    if (index >= 0 && (earliest === -1 || index < earliest)) {
      earliest = index;
      matchedKeyword = String(keyword);
    }
  }
  return earliest >= 0 ? { index: earliest, keyword: matchedKeyword } : null;
}

/**
 * 多参数模式：按 config.extractors 逐项提取并合并参数。
 * 支持 trailing（可指定 keyword）/ regex（命名组或首个捕获组）/ json（path 或顶层字段）/ fulltext。
 */
function extractMultiParams(rule, rawText) {
  const cfg = rule.extraction?.config ?? {};
  const extractors = Array.isArray(cfg.extractors) ? cfg.extractors : [];
  const params = {};
  for (const extractor of extractors) {
    if (!extractor || typeof extractor !== 'object') continue;
    const type = String(extractor.type ?? '');
    const param = typeof extractor.param === 'string' && extractor.param ? extractor.param : '';
    if (type === 'trailing') {
      const keywords = extractor.keyword ? [String(extractor.keyword)] : rule.match?.keywords ?? [];
      const found = findEarliestKeyword(rawText, keywords);
      const value = found ? rawText.slice(found.index + found.keyword.length).trim() : rawText.trim();
      if (value) params[param || 'arg'] = value;
    } else if (type === 'regex') {
      let match = null;
      try {
        match = new RegExp(String(extractor.regex ?? ''), 'u').exec(rawText);
      } catch {
        match = null;
      }
      if (!match) continue;
      if (match.groups && Object.keys(match.groups).length > 0) {
        for (const [key, value] of Object.entries(match.groups)) {
          if (value !== undefined && value !== '') params[key] = value;
        }
      } else if (match[1] !== undefined && match[1] !== '') {
        params[param || 'arg'] = match[1];
      }
    } else if (type === 'json') {
      const parsed = safeJsonParse(rawText);
      if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) continue;
      const path = typeof extractor.path === 'string' ? extractor.path.trim() : '';
      if (path) {
        const value = getByPath(parsed.value, path);
        if (value !== undefined && value !== null && String(value) !== '') {
          const key = param || path.split('.').filter(Boolean).pop() || 'value';
          params[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
      } else if (param && Object.prototype.hasOwnProperty.call(parsed.value, param)) {
        const value = parsed.value[param];
        if (value !== null && value !== undefined) {
          params[param] = typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
      } else {
        for (const [key, value] of Object.entries(parsed.value)) {
          if (value === null || value === undefined) continue;
          params[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
      }
    } else if (type === 'fulltext') {
      const value = rawText.trim();
      if (value) params[param || 'text'] = value;
    }
  }
  return params;
}

/** 内置变量集合（供模板渲染使用；extractParams 之外也可单独构造）。 */
export function buildBuiltinVars({ text = '', userId = '', displayName = '', now = Date.now() } = {}) {
  return { text: String(text), arg: '', userId: String(userId), name: String(displayName), now: String(now) };
}

// ---------------------------------------------------------------------------
// 模板渲染
// ---------------------------------------------------------------------------

/** 单变量替换：`{key}`（仅字母数字下划线）；urlEncode=true 时对值做 URL 编码。 */
export function renderRequestTemplate(template, vars = {}, { urlEncode = false } = {}) {
  return String(template ?? '').replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
    const value = String(vars[key] ?? '');
    return urlEncode ? encodeURIComponent(value) : value;
  });
}

/** 统计数组/对象长度（用于模板 `{{count path}}`）。 */
function countValue(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  if (value === undefined || value === null || value === '') return 0;
  return 1;
}

/** 解析列表规格：`path` 或 `path where 字段=值` / `path where 字段!=值`。 */
function parseListSpec(rawSpec) {
  const spec = String(rawSpec ?? '').trim();
  const whereMatch = spec.match(/^(\S+)\s+where\s+([A-Za-z0-9_.@-]+)\s*(!=|=)\s*(.+)$/i);
  if (!whereMatch) return { path: spec, filter: null };
  let value = whereMatch[4].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { path: whereMatch[1], filter: { field: whereMatch[2], op: whereMatch[3], value } };
}

/** 按 where 条件过滤数组（字段相对当前项；比较字符串化后的值）。 */
function filterList(list, filter) {
  if (!Array.isArray(list)) return [];
  if (!filter) return list;
  return list.filter((item) => {
    const raw = item && typeof item === 'object' ? getByPath(item, filter.field) : undefined;
    const left = raw === undefined || raw === null ? '' : String(raw);
    return filter.op === '=' ? left === filter.value : left !== filter.value;
  });
}

/** 计算 `count path [where ...]` 的值。 */
function resolveCountValue(rawSpec, root) {
  const parsed = parseListSpec(rawSpec);
  const value = getByPath(root, parsed.path);
  if (parsed.filter) return filterList(value, parsed.filter).length;
  return countValue(value);
}

/** 渲染 `{{#each path [where 字段=值]}}...{{/each}}` 列表块（单层）。 */
function expandEachBlocks(template, root) {
  const blockPattern = /\{\{#each\s+([^{}]+?)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g;
  return String(template).replace(blockPattern, (match, rawSpec, inner) => {
    const parsed = parseListSpec(rawSpec);
    const list = filterList(getByPath(root, parsed.path), parsed.filter);
    if (list.length === 0) return '';
    return list
      .map((item, index) => {
        return String(inner).replace(/\{\{([^{}]+?)\}\}/g, (placeholder, rawExpr) => {
          const expr = String(rawExpr).trim();
          if (expr === '@index') return String(index);
          if (expr === '@number') return String(index + 1);
          if (expr === 'this') return valueToText(item);
          if (expr.startsWith('count ')) return valueToText(resolveCountValue(expr.slice(6).trim(), root));
          const own = item && typeof item === 'object' ? getByPath(item, expr) : undefined;
          if (own !== undefined) return valueToText(own);
          return valueToText(getByPath(root, expr));
        });
      })
      .join('');
  });
}

/**
 * 回复/通知模板：`{{path}}` 从解析后的响应根取值；内置 `{{response}}` / `{{raw}}`；
 * 支持 `{{count path [where 字段=值]}}` 与 `{{#each path [where 字段=值]}}...{{/each}}`
 * 列表渲染（`{{@index}}` 从 0、`{{@number}}` 从 1）。
 */
export function renderReplyTemplate(template, { root, responseText = '', rawText = '' } = {}) {
  const tpl = String(template ?? '');
  if (tpl.trim() === '') return truncate(responseText, MAX_REPLY_LENGTH());
  const withLists = expandEachBlocks(tpl, root);
  const rendered = withLists.replace(/\{\{([^{}]+?)\}\}/g, (match, rawExpr) => {
    const expr = String(rawExpr).trim();
    if (expr === 'response') return responseText;
    if (expr === 'raw') return rawText;
    if (expr.startsWith('count ')) return valueToText(resolveCountValue(expr.slice(6).trim(), root));
    const value = getByPath(root, expr);
    return valueToText(value);
  });
  return truncate(rendered, MAX_REPLY_LENGTH());
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

const DIAGNOSTIC_RESPONSE_HEADERS = [
  'content-type',
  'x-ratelimit-type',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'ratelimit',
  'x-error-code',
  'retry-after',
  'x-request-id',
];

/** 从外部响应头中挑选诊断字段（不含 Set-Cookie 等敏感头），供测试运行展示。 */
function pickDiagnosticHeaders(headers) {
  const source = headers && typeof headers === 'object' ? headers : {};
  const picked = {};
  for (const key of DIAGNOSTIC_RESPONSE_HEADERS) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value) !== '') {
      picked[key] = truncate(String(value), 200);
    }
  }
  return picked;
}

/**
 * 解析外部响应（docs/API_RULES.md §5）。
 * @returns {{root:any, value:any, responseText:string, rawText:string}}
 */
export function parseResponse({ responseType = 'json', responsePath = '', rawText = '' } = {}) {
  const raw = String(rawText ?? '');
  if (responseType === 'text') {
    const responseText = truncate(raw.trim(), MAX_REPLY_LENGTH());
    return { root: responseText, value: responseText, responseText, rawText: raw };
  }
  const parsed = safeJsonParse(raw);
  if (!parsed.ok) throw new Error('响应不是合法 JSON');
  const root = parsed.value;
  let value;
  if (String(responsePath).trim() === '') {
    if (root && typeof root === 'object' && !Array.isArray(root) && typeof root.reply === 'string' && root.reply.trim() !== '') {
      value = root.reply;
    } else {
      value = JSON.stringify(root);
    }
  } else {
    value = getByPath(root, responsePath);
  }
  const responseText = truncate(valueToText(value), MAX_REPLY_LENGTH());
  return { root, value, responseText, rawText: raw };
}

// ---------------------------------------------------------------------------
// SSRF 防护
// ---------------------------------------------------------------------------

/** 判断 IP 是否属于私网/环回/链路本地/组播/保留地址。 */
export function isPrivateIp(ip) {
  const value = String(ip ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const version = net.isIP(value);
  if (version === 4) return isPrivateIpv4(value);
  if (version === 6) return isPrivateIpv6(value);
  return true; // 非法地址一律视为不可访问
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip) {
  const value = ip.toLowerCase();
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return isPrivateIpv4(mapped);
    return true;
  }
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // fc00::/7
  if (/^fe[89ab]/.test(value)) return true; // fe80::/10
  if (value.startsWith('ff')) return true; // ff00::/8
  if (value.startsWith('64:ff9b')) return true; // NAT64 保留
  if (value.startsWith('2001:db8')) return true; // 文档保留
  return false;
}

/** URL 解析 + SSRF 校验（DNS 解析所有地址；白名单主机允许私网）。 */
export async function validateTargetUrl(rawUrl, { allowedHosts = config.appRules.allowedHosts, dnsLookup = deps.dnsLookup } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error('URL 格式非法');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https 协议');
  if (url.username || url.password) throw new Error('URL 不允许包含 userinfo（user:pass@）');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) throw new Error('URL 缺少主机名');
  const allowed = (allowedHosts ?? []).map((host) => String(host).toLowerCase()).includes(hostname);
  const literalVersion = net.isIP(hostname);
  let addresses;
  if (literalVersion !== 0) {
    addresses = [hostname];
  } else {
    try {
      addresses = await dnsLookup(hostname, { all: true });
    } catch (err) {
      throw new Error(`域名解析失败：${err?.message ?? 'unknown'}`);
    }
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  for (const entry of list) {
    const ip = typeof entry === 'string' ? entry : entry?.address;
    if (!ip) continue;
    if (isPrivateIp(ip) && !allowed) {
      throw new Error(`目标地址位于私网/保留网段，已拒绝（SSRF）：${hostname} → ${ip}`);
    }
  }
  return { url, hostname };
}

/**
 * 调用外部接口（SSRF 校验 + 重定向逐跳复验 + 超时 + 响应大小限制 + 仅文本）。
 * @returns {Promise<{status:number, text:string, headers:object, finalUrl:string, latencyMs:number}>}
 */
export async function requestExternal({
  url,
  method = 'GET',
  headers = {},
  body = '',
  timeoutMs = config.appRules.timeoutMs,
  maxResponseBytes = config.appRules.maxResponseBytes,
  allowedHosts = config.appRules.allowedHosts,
  redirectLimit = 3,
  dnsLookup = deps.dnsLookup,
  fetchImpl = deps.fetch,
} = {}) {
  const startedAt = deps.now();
  let currentUrl = String(url);
  let currentMethod = String(method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  let currentBody = currentMethod === 'GET' ? '' : String(body ?? '');
  const requestHeaders = { ...(headers ?? {}) };

  for (let redirect = 0; redirect <= redirectLimit; redirect += 1) {
    await validateTargetUrl(currentUrl, { allowedHosts, dnsLookup });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || config.appRules.timeoutMs));
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method: currentMethod,
        headers: requestHeaders,
        body: currentMethod === 'GET' ? undefined : currentBody,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(Number(response.status))) {
      if (redirect === redirectLimit) throw new Error('重定向次数过多');
      const location = response.headers.get('location');
      if (!location) throw new Error('重定向响应缺少 Location');
      currentUrl = new URL(location, currentUrl).toString();
      if (Number(response.status) === 303) {
        currentMethod = 'GET';
        currentBody = '';
      }
      continue;
    }

    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
    if (
      contentType &&
      !/^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/i.test(contentType)
    ) {
      throw new Error(`不支持的响应类型（仅接受文本/JSON）：${contentType}`);
    }
    const declaredSize = Number(response.headers.get('content-length') ?? 0);
    if (declaredSize > maxResponseBytes) throw new Error('响应体超过大小上限');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxResponseBytes) throw new Error('响应体超过大小上限');
    const text = buffer.toString('utf8');
    const responseHeaders = {};
    for (const [key, value] of response.headers.entries()) responseHeaders[key] = value;
    return {
      status: Number(response.status),
      text,
      headers: responseHeaders,
      finalUrl: currentUrl,
      latencyMs: Math.max(0, deps.now() - startedAt),
    };
  }
  throw new Error('重定向次数过多');
}

// ---------------------------------------------------------------------------
// 单次执行（引擎与 dry-run 共用）
// ---------------------------------------------------------------------------

/**
 * 执行一次规则 HTTP 调用 + 解析 + 回复渲染（不写日志/不发消息）。
 * @returns {Promise<{httpStatus:number|null, latencyMs:number, responsePreview:string,
 *   replyText:string, error:string, requestUrl:string, headerNames:string[], bodyPreview:string,
 *   params:object, parsed:object|null}>}
 */
export async function executeRuleHttp(rule, { text = '', userId = '', displayName = '', now = deps.now() } = {}) {
  const extraction = extractParams(rule, { text, userId, displayName, now });
  const result = {
    params: extraction.params,
    httpStatus: null,
    latencyMs: 0,
    responsePreview: '',
    responseHeaders: {},
    replyText: '',
    error: '',
    requestUrl: '',
    headerNames: Object.keys(rule.request?.headers ?? {}),
    bodyPreview: '',
    parsed: null,
    missing: extraction.missing,
  };
  if (extraction.missing) {
    result.error = 'missing params';
    result.replyText = rule.response?.fallbackText ?? '';
    return result;
  }

  const vars = extraction.vars;
  let url = '';
  try {
    url = renderRequestTemplate(rule.request?.url ?? '', vars, { urlEncode: true });
    const headers = {};
    for (const [key, value] of Object.entries(rule.request?.headers ?? {})) {
      headers[key] = truncate(renderRequestTemplate(value, vars), 2000);
    }
    const bodyTemplate = rule.request?.bodyTemplate ?? '';
    const requestBody = rule.request?.method === 'POST' ? renderRequestTemplate(bodyTemplate, vars) : '';
    result.requestUrl = url;
    result.bodyPreview = truncate(requestBody, 500);
    const response = await requestExternal({
      url,
      method: rule.request?.method ?? 'GET',
      headers,
      body: requestBody,
      timeoutMs: Math.min(rule.limits?.timeoutMs ?? config.appRules.timeoutMs, config.appRules.timeoutMs),
      maxResponseBytes: config.appRules.maxResponseBytes,
    });
    result.httpStatus = response.status;
    result.latencyMs = response.latencyMs;
    result.responsePreview = truncate(response.text, 1000);
    // 仅保留诊断相关响应头（限流/请求 ID 等），供「测试运行」排查；不进入运行日志
    result.responseHeaders = pickDiagnosticHeaders(response.headers);
    if (response.status < 200 || response.status >= 300) {
      result.error = `HTTP ${response.status}`;
      result.replyText = rule.response?.fallbackText ?? '';
      return result;
    }
    const parsed = parseResponse({
      responseType: rule.response?.type ?? 'json',
      responsePath: rule.response?.path ?? '',
      rawText: response.text,
    });
    result.parsed = parsed;
    const template = rule.response?.template ?? '';
    const rendered = renderReplyTemplate(template, {
      root: parsed.root,
      responseText: parsed.responseText,
      rawText: parsed.rawText,
    });
    result.replyText = rendered.trim() === '' ? rule.response?.fallbackText ?? '' : rendered;
    if (result.replyText.trim() === '') result.error = 'empty reply';
    return result;
  } catch (err) {
    result.error = truncate(err?.message ?? String(err), 500);
    result.replyText = rule.response?.fallbackText ?? '';
    return result;
  }
}

/** 管理员测试运行（dry-run）：不发送、不写运行日志。 */
export async function testRule({ ruleRow, message = '', userId = '' } = {}) {
  const rule = parseRuleRow(ruleRow);
  const user = userId ? store.getUser(userId) : null;
  const groupIds = userId ? store.getUserGroups(userId).map((group) => group.id) : [];
  const now = deps.now();
  if (!matchRule(rule, { text: message, userId, groupIds })) {
    return {
      matched: false,
      ruleId: rule.id,
      params: {},
      request: { method: rule.request.method, url: '', headerNames: Object.keys(rule.request.headers ?? {}), bodyPreview: '' },
      httpStatus: null,
      latencyMs: 0,
      responsePreview: '',
      replyText: '',
      error: '',
    };
  }
  const result = await executeRuleHttp(rule, {
    text: message,
    userId,
    displayName: user?.displayName ?? '',
    now,
  });
  return {
    matched: true,
    ruleId: rule.id,
    params: result.params,
    request: {
      method: rule.request.method,
      url: result.requestUrl,
      headerNames: result.headerNames,
      bodyPreview: result.bodyPreview,
    },
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
    responsePreview: result.responsePreview,
    responseHeaders: result.responseHeaders ?? {},
    replyText: result.replyText,
    error: result.error,
  };
}

// ---------------------------------------------------------------------------
// 引擎：内存队列 + 并发 worker
// ---------------------------------------------------------------------------

const engineState = {
  running: false,
  /** @type {Array<object>} */
  queue: [],
  active: 0,
  idleWaiters: [],
};

function notifyIdleIfNeeded() {
  if (engineState.active === 0 && engineState.queue.length === 0) {
    const waiters = engineState.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

/** 脱敏日志中的 URL：去掉 userinfo（user:pass@）等凭据。 */
function redactUrlForLog(rawUrl) {
  const raw = String(rawUrl ?? '');
  if (raw === '') return '';
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = '[redacted]';
      url.password = '[redacted]';
    }
    return url.toString();
  } catch {
    return raw;
  }
}

/** 把参数/响应预览做脱敏并截断（写日志用）。 */
function makePreviews({ params, requestUrl, method, responsePreview }) {
  let paramsPreview = '';
  try {
    paramsPreview = truncate(JSON.stringify(redactForLog(params ?? {})), 1000);
  } catch {
    paramsPreview = '';
  }
  return {
    paramsPreview,
    requestPreview: truncate(`${method} ${redactUrlForLog(requestUrl)}`, 500),
    responsePreview: truncate(responsePreview ?? '', 1000),
  };
}

/** 发送回复（入队 outbox source='rule'）。 */
function enqueueReply(userId, text) {
  if (!text || String(text).trim() === '') return null;
  const outbox = store.enqueueMessage({ userId, text: truncate(text, MAX_REPLY_LENGTH()), source: 'rule' });
  return outbox?.id ?? null;
}

/** 把日志更新为终态（skipped/failed/success）。 */
function finalizeLog(logId, patch) {
  if (!logId) return;
  try {
    store.updateAppRuleLog(logId, patch);
  } catch (err) {
    log.warn('更新规则运行日志失败', { logId, message: err?.message });
  }
}

/** 队列 worker：处理一条入站消息（匹配 → 限制 → HTTP → 回复 → 日志）。 */
async function processInboundJob(job) {
  const { userId, inboundMessageId, text } = job;
  const now = deps.now();
  const user = store.getUser(userId);
  if (!user) return;
  const groupIds = store.getUserGroups(userId).map((group) => group.id);
  const ruleRows = store.listEnabledAppRuleRows();
  let matchedRow = null;
  for (const row of ruleRows) {
    const rule = parseRuleRow(row);
    if (matchRule(rule, { text, userId, groupIds })) {
      matchedRow = row;
      break; // priority ASC → 只取第一条命中的规则
    }
  }
  if (!matchedRow) return;
  const rule = parseRuleRow(matchedRow);

  // 冷却（同用户同规则）
  if (rule.limits.cooldownMs > 0) {
    const lastMatchedAt = store.getAppRuleLastMatchedAt(rule.id, userId);
    if (lastMatchedAt > 0 && now - lastMatchedAt < rule.limits.cooldownMs) {
      store.insertAppRuleLog({ ruleId: rule.id, userId, inboundMessageId, status: 'skipped', error: 'cooldown', createdAt: now });
      log.info('规则命中但处于冷却期，跳过', { ruleId: rule.id, userId });
      return;
    }
  }
  // 小时配额
  if (rule.limits.maxCallsPerHour > 0) {
    const ruleCalls = store.countAppRuleLogsLastHour(rule.id, now);
    if (ruleCalls >= rule.limits.maxCallsPerHour) {
      store.insertAppRuleLog({ ruleId: rule.id, userId, inboundMessageId, status: 'skipped', error: 'rule hourly limit', createdAt: now });
      log.warn('规则小时调用上限已达，跳过', { ruleId: rule.id, userId, ruleCalls });
      return;
    }
  }
  if (rule.limits.maxUserCallsPerHour > 0) {
    const userCalls = store.countAppRuleLogsLastHour(rule.id, now, { userId });
    if (userCalls >= rule.limits.maxUserCallsPerHour) {
      store.insertAppRuleLog({ ruleId: rule.id, userId, inboundMessageId, status: 'skipped', error: 'user hourly limit', createdAt: now });
      log.warn('用户规则小时调用上限已达，跳过', { ruleId: rule.id, userId, userCalls });
      return;
    }
  }

  // 去重：同消息+规则只执行一次（唯一索引）
  const logRow = store.insertAppRuleLog({ ruleId: rule.id, userId, inboundMessageId, status: 'matched', createdAt: now });
  if (!logRow.inserted) {
    log.debug('重复入站消息触发同一规则，跳过', { ruleId: rule.id, inboundMessageId });
    return;
  }

  const result = await executeRuleHttp(rule, {
    text,
    userId,
    displayName: user.displayName ?? '',
    now,
  });
  const previews = makePreviews({
    params: result.params,
    requestUrl: result.requestUrl,
    method: rule.request.method,
    responsePreview: result.responsePreview,
  });

  if (result.error) {
    const replyOutboxId = result.replyText ? enqueueReply(userId, result.replyText) : null;
    finalizeLog(logRow.id, {
      status: 'failed',
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      error: result.error,
      ...previews,
      replyOutboxId,
    });
    log.warn('规则执行失败', { ruleId: rule.id, userId, error: result.error });
    return;
  }

  const replyOutboxId = enqueueReply(userId, result.replyText);
  finalizeLog(logRow.id, {
    status: 'success',
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
    error: '',
    ...previews,
    replyOutboxId,
  });
  log.info('规则执行成功并已回复', { ruleId: rule.id, userId, httpStatus: result.httpStatus, latencyMs: result.latencyMs });
}

function pump() {
  if (!engineState.running) return;
  while (engineState.active < config.appRules.workerConcurrency && engineState.queue.length > 0) {
    const job = engineState.queue.shift();
    engineState.active += 1;
    processInboundJob(job)
      .catch((err) => log.error('规则任务处理异常（忽略）', { message: err?.message, stack: err?.stack }))
      .finally(() => {
        engineState.active -= 1;
        pump();
        notifyIdleIfNeeded();
      });
  }
  notifyIdleIfNeeded();
}

/**
 * 入站消息触发规则引擎（异步队列，不阻塞 getupdates）。
 * 仅文本消息（itemTypes 含 1）且 text 非空时触发。
 */
export function handleInboundMessage({ userId, inboundMessageId, text, itemTypes = '' } = {}) {
  if (!engineState.running) return false;
  if (!userId || !inboundMessageId) return false;
  const messageText = String(text ?? '');
  if (messageText.trim() === '') return false;
  const types = String(itemTypes ?? '')
    .split(',')
    .map((type) => type.trim())
    .filter(Boolean);
  if (types.length > 0 && !types.includes('1')) return false;
  if (engineState.queue.length + engineState.active >= config.appRules.maxQueue) {
    log.warn('规则引擎队列已满，丢弃入站消息', { maxQueue: config.appRules.maxQueue });
    return false;
  }
  engineState.queue.push({ userId, inboundMessageId, text: messageText });
  pump();
  return true;
}

/** 启动引擎（幂等；APP_RULES_ENABLED=false 时不启动）。 */
export function start() {
  if (!config.appRules.enabled) {
    log.info('接口应用引擎未启用（APP_RULES_ENABLED=false）');
    return false;
  }
  if (engineState.running) return false;
  engineState.running = true;
  log.info('接口应用引擎已启动', {
    concurrency: config.appRules.workerConcurrency,
    maxQueue: config.appRules.maxQueue,
    timeoutMs: config.appRules.timeoutMs,
  });
  return true;
}

/** 停止引擎（幂等；丢弃未处理队列）。 */
export function stop() {
  const wasRunning = engineState.running;
  engineState.running = false;
  engineState.queue.length = 0;
  notifyIdleIfNeeded();
  if (wasRunning) log.info('接口应用引擎已停止');
  return wasRunning;
}

/** 重启引擎（运行配置热更新用；enabled=false 时停止）。 */
export function restart() {
  stop();
  return start();
}

/** 等待队列排空（测试/优雅退出辅助）。 */
export function waitForIdle(timeoutMs = 10000) {
  if (engineState.active === 0 && engineState.queue.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    engineState.idleWaiters.push(done);
    timer = setTimeout(() => {
      const index = engineState.idleWaiters.indexOf(done);
      if (index >= 0) engineState.idleWaiters.splice(index, 1);
      resolve(false);
    }, Math.max(100, timeoutMs));
    timer.unref?.();
  });
}

/** 引擎状态（测试/观测）。 */
export function getEngineState() {
  return {
    running: engineState.running,
    queued: engineState.queue.length,
    active: engineState.active,
  };
}
