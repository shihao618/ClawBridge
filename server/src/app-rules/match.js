/**
 * 规则解析 / 范围与关键词匹配 / 参数提取（app-rules/match.js）。
 *
 * 从 app-rules.js 按职责拆分；纯函数，无网络/引擎状态。
 */
import { config } from '../config.js';
import { decryptSecretOrNull } from '../crypto.js';
import { getByPath, safeJsonParse } from '../shared/template.js';

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
      mode: row.extraction_mode ?? 'none',
      config: json(row.extraction_config, {}) ?? {},
    },
    request: {
      mode: row.request_url ? 'http' : 'none',
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
  const mode = rule.extraction?.mode === 'multi' ? 'multi' : 'none';
  const cfg = rule.extraction?.config ?? {};
  const params = {};
  let primaryKey = 'arg';
  let primaryValue = '';

  if (mode === 'multi') {
    Object.assign(params, extractMultiParams(rule, rawText));
    primaryKey = typeof cfg.param === 'string' && cfg.param ? cfg.param : Object.keys(params)[0] ?? 'arg';
    primaryValue = params[primaryKey] ?? '';
  }

  const required = mode === 'multi' && Array.isArray(cfg.required) ? cfg.required.map(String) : [];
  const missing =
    mode === 'multi' &&
    (required.length > 0
      ? required.some((key) => params[key] === undefined || params[key] === '')
      : Object.keys(params).length === 0);

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
