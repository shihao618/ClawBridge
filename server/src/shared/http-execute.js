/**
 * 通用“渲染请求 → 调 HTTP → 解析响应 → 渲染回复”执行管线（shared；BA-09）。
 *
 * app-rules（规则执行 / 测试运行）与 scheduler（定时任务）共用同一条管线，
 * 避免两份实现随时间漂移。模块内不得 import 任何业务模块。
 */
import { pickDiagnosticHeaders, requestExternal } from './http-client.js';
import { parseResponse } from './response.js';
import { renderReplyTemplate, renderRequestTemplate, truncate } from './template.js';

/**
 * 渲染一次外部请求（URL/Header/Body 模板 → 实际值）。
 * URL 变量做 URL 编码；Header 值截断 2000 字符；仅 POST 渲染 body；body 预览截断 500。
 * @returns {{method:'GET'|'POST', url:string, headers:object, body:string, headerNames:string[], bodyPreview:string}}
 */
export function renderHttpRequest(request = {}, vars = {}) {
  const method = String(request.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const url = renderRequestTemplate(request.url ?? '', vars, { urlEncode: true });
  const headers = {};
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    headers[key] = truncate(renderRequestTemplate(value, vars), 2000);
  }
  const body = method === 'POST' ? renderRequestTemplate(request.bodyTemplate ?? '', vars) : '';
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
 * 执行已渲染的 HTTP 请求，并按响应配置解析/渲染回复。
 *
 * 网络/解析错误直接抛出（调用方决定错误文案）；非 2xx 与空回复以 result.error 返回，
 * replyText 使用 fallbackText。
 * @returns {Promise<{status:number, latencyMs:number, text:string, headers:object,
 *   parsed:object|null, replyText:string, error:string}>}
 */
export async function executeHttpRequest({
  request,
  response = {},
  timeoutMs,
  maxResponseBytes,
  allowedHosts,
  dnsLookup,
  httpRequest,
} = {}) {
  const result = {
    status: null,
    latencyMs: 0,
    text: '',
    headers: {},
    parsed: null,
    replyText: '',
    error: '',
  };
  const fetched = await requestExternal({
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
  result.status = Number(fetched.status);
  result.latencyMs = fetched.latencyMs;
  result.text = fetched.text;
  result.headers = fetched.headers ?? {};

  if (result.status < 200 || result.status >= 300) {
    result.error = `HTTP ${result.status}`;
    result.replyText = String(response.fallbackText ?? '');
    return result;
  }

  const parsed = parseResponse({
    responseType: response.type ?? 'json',
    responsePath: response.path ?? '',
    rawText: fetched.text,
  });
  result.parsed = parsed;
  const rendered = renderReplyTemplate(response.template ?? '', {
    root: parsed.templateRoot,
    responseRoot: parsed.root,
    responseText: parsed.responseText,
    rawText: parsed.rawText,
  });
  result.replyText = rendered.trim() === '' ? String(response.fallbackText ?? '') : rendered;
  if (result.replyText.trim() === '') result.error = 'empty reply';
  return result;
}

/** 便捷函数：渲染 + 执行一步完成（不需要请求预览的调用方使用）。 */
export async function runHttpPipeline({ request = {}, vars = {}, response = {}, ...options } = {}) {
  const rendered = renderHttpRequest(request, vars);
  const result = await executeHttpRequest({ request: rendered, response, ...options });
  return { ...result, request: rendered };
}

/** 通用诊断响应头白名单（app-rules 测试运行用）。 */
export { pickDiagnosticHeaders };
