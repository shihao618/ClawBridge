/**
 * 通用“渲染请求 → 调 HTTP → 解析响应 → 渲染回复”执行管线（shared；规则/定时通知共用）。
 *
 * 拆分点（1.0.0 按用户模式）：
 * - renderHttpRequest：渲染 URL/Header/Body（支持 `{key}` 变量与 `{credential:名称.字段}` 凭据占位符）；
 * - runExternalRequest：只发请求（合并相同请求时复用一次）；
 * - buildResponseResult：把一次原始响应解析并按配置渲染回复（可按用户附加模板根字段）；
 * - executeHttpRequest：= runExternalRequest + buildResponseResult（保持既有单次调用语义）。
 *
 * 模块内不得 import 任何业务模块。
 */
import { pickDiagnosticHeaders, requestExternal } from './http-client.js';
import { parseResponse } from './response.js';
import { containsNoreplyMarker, renderReplyTemplate, renderRequestTemplate, truncate } from './template.js';

/**
 * 渲染一次外部请求（URL/Header/Body 模板 → 实际值）。
 * URL 变量做 URL 编码；Header 值截断 2000 字符；仅 POST 渲染 body；body 预览截断 500。
 * @param {object} request
 * @param {object} vars 普通模板变量
 * @param {{credentialValues?: Map<string,string>|Record<string,string>}} [options]
 * @returns {{method:'GET'|'POST', url:string, headers:object, body:string, headerNames:string[], bodyPreview:string}}
 */
export function renderHttpRequest(request = {}, vars = {}, { credentialValues = null } = {}) {
  const method = String(request.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const url = renderRequestTemplate(request.url ?? '', vars, { urlEncode: true, credentialValues });
  const headers = {};
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    headers[key] = truncate(renderRequestTemplate(value, vars, { credentialValues }), 2000);
  }
  const body = method === 'POST' ? renderRequestTemplate(request.bodyTemplate ?? '', vars, { credentialValues }) : '';
  return {
    method,
    url,
    headers,
    body,
    headerNames: Object.keys(request.headers ?? {}),
    bodyPreview: truncate(body, 500),
  };
}

/**
 * 执行一次已渲染的 HTTP 请求（不解析响应）。
 * 网络错误直接抛出（调用方决定错误文案/兜底）。
 * @returns {Promise<{status:number, latencyMs:number, text:string, headers:object}>}
 */
export async function runExternalRequest({
  request,
  timeoutMs,
  maxResponseBytes,
  allowedHosts,
  dnsLookup,
  httpRequest,
} = {}) {
  return requestExternal({
    url: request?.url ?? '',
    method: request?.method ?? 'GET',
    headers: request?.headers ?? {},
    body: request?.body ?? '',
    timeoutMs,
    maxResponseBytes,
    allowedHosts,
    ...(dnsLookup ? { dnsLookup } : {}),
    ...(httpRequest ? { httpRequest } : {}),
  });
}

/**
 * 把一次原始 HTTP 响应按 response 配置解析并渲染回复。
 * templateExtras 会合并进回复模板根字段（按用户模式的 `userName`/`userId` 等）。
 * @param {{status:number, latencyMs:number, text:string, headers?:object}} fetched runExternalRequest 结果
 * @param {object} response 响应解析/回复模板配置
 * @param {{templateExtras?:object}} [options]
 * @returns {{status:number, latencyMs:number, text:string, headers:object,
 *   parsed:object|null, replyText:string, error:string, noreply:boolean}}
 */
export function buildResponseResult({ fetched, response = {}, templateExtras } = {}) {
  const result = {
    status: null,
    latencyMs: 0,
    text: '',
    headers: {},
    parsed: null,
    replyText: '',
    error: '',
    noreply: false,
  };
  result.status = Number(fetched?.status);
  result.latencyMs = fetched?.latencyMs ?? 0;
  result.text = fetched?.text ?? '';
  result.headers = fetched?.headers ?? {};

  if (result.status < 200 || result.status >= 300) {
    result.error = `HTTP ${result.status}`;
    result.replyText = String(response.fallbackText ?? '');
    return result;
  }

  const parsed = parseResponse({
    responseType: response.type ?? 'json',
    responsePath: response.path ?? '',
    rawText: result.text,
  });
  result.parsed = parsed;
  const root = templateExtras ? { ...(parsed.templateRoot ?? {}), ...templateExtras } : parsed.templateRoot;
  const rendered = renderReplyTemplate(response.template ?? '', {
    root,
    responseRoot: parsed.root,
    responseText: parsed.responseText,
    rawText: parsed.rawText,
  });
  // 模板输出 {{noreply}}：本次不发送任何消息，且不使用兜底文案
  if (containsNoreplyMarker(rendered)) {
    result.noreply = true;
    result.replyText = '';
    return result;
  }
  result.replyText = rendered.trim() === '' ? String(response.fallbackText ?? '') : rendered;
  if (result.replyText.trim() === '') result.error = 'empty reply';
  return result;
}

/**
 * 执行已渲染的 HTTP 请求，并按响应配置解析/渲染回复。
 *
 * 网络/解析错误直接抛出（调用方决定错误文案）；非 2xx 与空回复以 result.error 返回，
 * replyText 使用 fallbackText。
 * @param {{request:object, response?:object, timeoutMs?:number, maxResponseBytes?:number,
 *   allowedHosts?:string[], dnsLookup?:Function, httpRequest?:Function, templateExtras?:object}} options
 * @returns {Promise<{status:number, latencyMs:number, text:string, headers:object,
 *   parsed:object|null, replyText:string, error:string, noreply:boolean}>}
 */
export async function executeHttpRequest({
  request,
  response = {},
  timeoutMs,
  maxResponseBytes,
  allowedHosts,
  dnsLookup,
  httpRequest,
  templateExtras,
} = {}) {
  const fetched = await runExternalRequest({
    request,
    timeoutMs,
    maxResponseBytes,
    allowedHosts,
    dnsLookup,
    httpRequest,
  });
  return buildResponseResult({ fetched, response, templateExtras });
}

/** 便捷函数：渲染 + 执行一步完成（不需要请求预览的调用方使用）。 */
export async function runHttpPipeline({ request = {}, vars = {}, response = {}, credentialValues = null, ...options } = {}) {
  const rendered = renderHttpRequest(request, vars, { credentialValues });
  const result = await executeHttpRequest({ request: rendered, response, ...options });
  return { ...result, request: rendered };
}

/** 通用诊断响应头白名单（app-rules 测试运行用）。 */
export { pickDiagnosticHeaders };
