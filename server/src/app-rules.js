/**
 * 接口应用（docs/API_RULES.md）：关键词触发 → 调外部 HTTP 接口 → 解析并回复微信用户。
 *
 * BA-09 架构拆分后本文件只保留「规则领域」部分：
 *  - 规则解析/匹配/参数提取（parseRuleRow / match* / extractParams / buildBuiltinVars）；
 *  - 单次执行（executeRuleHttp，复用 shared/http-execute 通用管线）与 dry-run（testRule）；
 *  - RuleEngine：内存队列 + 并发 worker、去重、运行日志、失败 fallback；
 *  - 日志脱敏工具（redactForLog / redactUrlForLog）。
 *
 * 通用能力已下沉到 shared/：
 *  - shared/http-client.js：SSRF 校验 + 连接层固定 IP + 重定向逐跳复验 + 超时/大小限制；
 *  - shared/template.js：请求/回复模板引擎（含 BA-22 输出长度上限）；
 *  - shared/response.js：响应解析与模板离线预览；
 *  - shared/http-execute.js：渲染请求 → HTTP → 解析 → 渲染回复的通用管线（scheduler 共用）。
 *
 * 为保持既有测试/调用方零改动，这里 re-export 拆分前的导出名（validateTargetUrl /
 * renderReplyTemplate / parseResponse / previewReplyTemplate / truncate 等）。
 */
import { config } from './config.js';
import { decryptSecretOrNull } from './crypto.js';
import { logger, redactUrlQueryForLog } from './logger.js';
import {
  configureDependencies as configureSharedDependencies,
  describeFetchError,
  pickDiagnosticHeaders,
  resetDependencies as resetSharedDependencies,
} from './shared/http-client.js';
import { executeHttpRequest, renderHttpRequest } from './shared/http-execute.js';
import { getByPath, maxReplyLength, renderReplyTemplate, safeJsonParse, truncate } from './shared/template.js';
import * as store from './store.js';

const log = logger.child({ mod: 'app-rules' });

const REDACT_KEY_RE = /(token|secret|password|api[-_]?key|authorization)/i;

// ---------------------------------------------------------------------------
// 兼容旧测试注入锚点（实际 HTTP/DNS 传输注入在 shared/http-client.js）
// ---------------------------------------------------------------------------
let deps = { now: () => Date.now() };

/** 注入测试依赖（httpRequest/dnsLookup 转发到 shared/http-client，now 用于规则时间戳）。 */
export function configureDependencies(overrides = {}) {
  if (typeof overrides?.now === 'function') deps.now = overrides.now;
  configureSharedDependencies(overrides);
}

/** 恢复默认真实依赖。 */
export function resetDependencies() {
  deps = { now: () => Date.now() };
  resetSharedDependencies();
}

// ---------------------------------------------------------------------------
// 兼容 re-export（拆分前 app-rules.js 的既有导出名，测试/调用方零改动）
// ---------------------------------------------------------------------------
export { getByPath, renderReplyTemplate, renderRequestTemplate, truncate } from './shared/template.js';
export { parseResponse, previewReplyTemplate } from './shared/response.js';
export { describeFetchError, isPrivateIp, requestExternal, validateTargetUrl } from './shared/http-client.js';

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

// ---------------------------------------------------------------------------
// 单次执行（引擎与 dry-run 共用；复用 shared/http-execute 管线）
// ---------------------------------------------------------------------------

/**
 * 执行一次规则 HTTP 调用 + 解析 + 回复渲染（不写日志/不发消息）。
 * @returns {Promise<{httpStatus:number|null, latencyMs:number, responsePreview:string,
 *   replyText:string, error:string, requestUrl:string, headerNames:string[], bodyPreview:string,
 *   params:object, parsed:object|null}>}
 */
export async function executeRuleHttp(rule, { text = '', userId = '', displayName = '', now = deps.now() } = {}) {
  const result = {
    params: {},
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
    missing: false,
  };

  // 不请求模式：关键词命中后直接回复配置的默认文本，不提取参数、不访问外部接口。
  if (!String(rule.request?.url ?? '').trim()) {
    const rendered = renderReplyTemplate(rule.response?.template ?? '', {
      root: {},
      responseRoot: {},
      responseText: '',
      rawText: '',
    });
    result.replyText = rendered.trim() === '' ? (rule.response?.fallbackText ?? '') : rendered;
    if (result.replyText.trim() === '') result.error = 'empty reply';
    return result;
  }

  const extraction = extractParams(rule, { text, userId, displayName, now });
  result.params = extraction.params;
  result.missing = extraction.missing;
  if (extraction.missing) {
    result.error = 'missing params';
    result.replyText = rule.response?.fallbackText ?? '';
    return result;
  }

  try {
    const prepared = renderHttpRequest(rule.request ?? {}, extraction.vars);
    result.requestUrl = prepared.url;
    result.bodyPreview = prepared.bodyPreview;
    const outcome = await executeHttpRequest({
      request: prepared,
      response: rule.response ?? {},
      timeoutMs: Math.min(rule.limits?.timeoutMs ?? config.appRules.timeoutMs, config.appRules.timeoutMs),
      maxResponseBytes: config.appRules.maxResponseBytes,
      allowedHosts: config.appRules.allowedHosts,
    });
    result.httpStatus = outcome.status;
    result.latencyMs = outcome.latencyMs;
    result.responsePreview = truncate(outcome.text, 1000);
    // 仅保留诊断相关响应头（限流/请求 ID 等），供「测试运行」排查；不进入运行日志
    result.responseHeaders = pickDiagnosticHeaders(outcome.headers);
    result.parsed = outcome.parsed;
    result.replyText = outcome.replyText;
    result.error = outcome.error;
    return result;
  } catch (err) {
    result.error = truncate(describeFetchError(err), 500);
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
      request: {
        mode: rule.request.mode,
        method: rule.request.method,
        url: '',
        headerNames: Object.keys(rule.request.headers ?? {}),
        bodyPreview: '',
      },
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
      mode: rule.request.mode,
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
// 日志脱敏
// ---------------------------------------------------------------------------

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

/** 脱敏日志中的 URL：去掉 userinfo（user:pass@）凭据，并把敏感 query 参数值替换为 [redacted]。 */
export function redactUrlForLog(rawUrl) {
  const raw = String(rawUrl ?? '');
  if (raw === '') return '';
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = '[redacted]';
      url.password = '[redacted]';
    }
    return redactUrlQueryForLog(url.toString());
  } catch {
    // 无法按绝对 URL 解析（如相对路径）：至少完成 query 脱敏
    return redactUrlQueryForLog(raw);
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
    requestPreview: requestUrl
      ? truncate(`${method} ${redactUrlForLog(requestUrl)}`, 500)
      : '不请求外部接口（直接回复默认文本）',
    responsePreview: truncate(responsePreview ?? '', 1000),
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

/** 发送回复（入队 outbox source='rule'）。 */
function enqueueReply(userId, text) {
  if (!text || String(text).trim() === '') return null;
  const outbox = store.enqueueMessage({ userId, text: truncate(text, maxReplyLength()), source: 'rule' });
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

  // 规则自身不再做冷却/小时配额；调用频率统一由微信账号默认发送限流控制。
  // 同消息+规则仍通过日志唯一索引去重。
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
