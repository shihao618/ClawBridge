/**
 * 规则单次执行与对外 API（app-rules/index.js）。
 *
 * executeRuleHttp（复用 shared/http-execute 管线）与 testRule（管理端 dry-run）；
 * 测试依赖注入锚点（now 用于规则时间戳；httpRequest/dnsLookup 转发到 shared/http-client）。
 */
import { config } from '../config.js';
import {
  configureDependencies as configureSharedDependencies,
  describeFetchError,
  pickDiagnosticHeaders,
  resetDependencies as resetSharedDependencies,
} from '../shared/http-client.js';
import {
  CredentialMissingError,
  collectCredentialRefs,
  redactCredentialValues,
  resolveRequestCredentials,
} from '../shared/credentials.js';
import { executeHttpRequest, renderHttpRequest } from '../shared/http-execute.js';
import { containsNoreplyMarker, renderReplyTemplate, truncate } from '../shared/template.js';
import * as store from '../store.js';

import { extractParams, matchRule, parseRuleRow } from './match.js';

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

/** engine 内部读取当前可注入依赖（外部请用 configureDependencies/resetDependencies）。 */
export function getRuleDependencies() {
  return deps;
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
    noreply: false,
    requestUrl: '',
    headerNames: Object.keys(rule.request?.headers ?? {}),
    bodyPreview: '',
    parsed: null,
    missing: false,
    // 凭据注入：只暴露本次用到的凭据名称（值永不进入结果/日志）
    credentialNames: [],
    missingCredentials: [],
  };

  // 不请求模式：关键词命中后直接回复配置的默认文本，不提取参数、不访问外部接口。
  if (!String(rule.request?.url ?? '').trim()) {
    const rendered = renderReplyTemplate(rule.response?.template ?? '', {
      root: {},
      responseRoot: {},
      responseText: '',
      rawText: '',
    });
    // 模板输出 {{noreply}}：不回复、不使用兜底文案
    if (containsNoreplyMarker(rendered)) {
      result.noreply = true;
      return result;
    }
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

  // 凭据注入：按触发用户解析 `{credential:名称.字段}`（缺失 → failed，错误信息只含名称）
  let credentialValues = null;
  const credentialRefs = collectCredentialRefs(rule.request ?? {});
  if (credentialRefs.length > 0) {
    try {
      const resolved = resolveRequestCredentials(userId, credentialRefs, { ts: Number(now) || undefined });
      credentialValues = resolved.values;
      result.credentialNames = [...resolved.usedNames];
    } catch (err) {
      if (err instanceof CredentialMissingError) {
        result.error = err.message;
        result.missingCredentials = err.missing;
        result.replyText = rule.response?.fallbackText ?? '';
        return result;
      }
      throw err;
    }
  }

  try {
    const prepared = renderHttpRequest(rule.request ?? {}, extraction.vars, { credentialValues });
    // 预览/日志字段入库前统一脱敏（凭据值可能以明文或 URL 编码形式出现在 URL/Body 中）
    result.requestUrl = redactCredentialValues(prepared.url, credentialValues);
    result.bodyPreview = redactCredentialValues(prepared.bodyPreview, credentialValues);
    // 发送真实请求时使用未脱敏的 URL/Headers/Body；结果结构与日志只保留脱敏后的预览。
    const outcome = await executeHttpRequest({
      request: prepared,
      response: rule.response ?? {},
      timeoutMs: Math.min(rule.limits?.timeoutMs ?? config.appRules.timeoutMs, config.appRules.timeoutMs),
      maxResponseBytes: config.appRules.maxResponseBytes,
      allowedHosts: config.appRules.allowedHosts,
    });
    result.httpStatus = outcome.status;
    result.latencyMs = outcome.latencyMs;
    result.responsePreview = redactCredentialValues(truncate(outcome.text, 1000), credentialValues);
    // 仅保留诊断相关响应头（限流/请求 ID 等），供「测试运行」排查；不进入运行日志
    result.responseHeaders = pickDiagnosticHeaders(outcome.headers);
    result.parsed = outcome.parsed;
    result.replyText = outcome.replyText;
    result.noreply = outcome.noreply === true;
    result.error = redactCredentialValues(outcome.error ?? '', credentialValues);
    return result;
  } catch (err) {
    result.error = redactCredentialValues(truncate(describeFetchError(err), 500), credentialValues);
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
      credentialNames: [],
      missingCredentials: [],
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
    noreply: result.noreply === true,
    error: result.error,
    credentialNames: result.credentialNames ?? [],
    missingCredentials: result.missingCredentials ?? [],
  };
}
