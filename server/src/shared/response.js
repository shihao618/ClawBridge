/**
 * 通用响应解析/预览（shared，无业务依赖；从 app-rules.js 抽出）。
 *
 * parseResponse 按 responseType=json/text + responsePath 解析外部响应；
 * previewReplyTemplate 用示例响应离线预览模板（管理端 dry-run / 校验用）。
 */
import {
  containsNoreplyMarker,
  getByPath,
  maxReplyLength,
  renderReplyTemplate,
  safeJsonParse,
  truncate,
  valueToText,
} from './template.js';

/**
 * 解析外部响应（docs/API_RULES.md §5）。
 * @returns {{root:any, value:any, responseText:string, rawText:string, templateRoot:any}}
 */
export function parseResponse({ responseType = 'json', responsePath = '', rawText = '' } = {}) {
  const raw = String(rawText ?? '');
  if (responseType === 'text') {
    const responseText = truncate(raw.trim(), maxReplyLength());
    return { root: responseText, value: responseText, responseText, rawText: raw, templateRoot: responseText };
  }
  const parsed = safeJsonParse(raw);
  if (!parsed.ok) throw new Error('响应不是合法 JSON');
  const root = parsed.value;
  const hasPath = String(responsePath).trim() !== '';
  let value;
  let pathMatched = true;
  if (!hasPath) {
    if (root && typeof root === 'object' && !Array.isArray(root) && typeof root.reply === 'string' && root.reply.trim() !== '') {
      value = root.reply;
    } else {
      value = JSON.stringify(root);
    }
  } else {
    value = getByPath(root, responsePath);
    pathMatched = value !== undefined;
  }
  const responseText = truncate(valueToText(value), maxReplyLength());
  // JSON 路径命中时，模板根=选中节点（模板可直接相对引用）；空路径=完整响应根。
  // 配置了路径但未命中时模板根为空，**不回退完整响应根**——否则 {{#if .}} 的空数据保护会因
  // “完整响应对象恒为真”而误发空通知；需要完整响应时用 @responseRoot。
  const templateRoot = hasPath ? (pathMatched ? value : undefined) : root;
  return { root, value, responseText, rawText: raw, templateRoot, pathMatched };
}

/**
 * 用示例响应离线预览模板（不访问外部接口），复用真实响应解析与模板引擎。
 * @returns {{responseText:string, replyText:string, usedFallback:boolean, noreply:boolean}}
 */
export function previewReplyTemplate({
  responseType = 'json',
  responsePath = '',
  template = '',
  fallbackText = '',
  rawText = '',
} = {}) {
  const parsed = parseResponse({ responseType, responsePath, rawText });
  const rendered = renderReplyTemplate(template, {
    root: parsed.templateRoot,
    responseText: parsed.responseText,
    rawText: parsed.rawText,
    responseRoot: parsed.root,
  });
  // 模板输出 {{noreply}}：不发送、不使用兜底
  if (containsNoreplyMarker(rendered)) {
    return { responseText: parsed.responseText, replyText: '', usedFallback: false, noreply: true };
  }
  const usedFallback = rendered.trim() === '';
  return {
    responseText: parsed.responseText,
    replyText: usedFallback ? String(fallbackText ?? '') : rendered,
    usedFallback,
    noreply: false,
  };
}
