/**
 * 接口应用（app-rules）请求体校验：matchMode/keywords/regex/scope/extraction/request/response
 * 的完整 patch 构造（创建 requireAll=true，更新为部分字段）。
 *
 * 从 api.js 的 buildAppRulePatch 等价迁出（纯搬迁，行为不变）。
 */
import { encryptSecret } from '../crypto.js';
import { badRequest } from '../errors.js';
import * as store from '../store.js';

import { assertPlainObject, optionalString, requiredString, validRegexSource, validateHttpUrl } from './validators.js';

const APP_RULE_MATCH_MODES = new Set(['contains', 'equals', 'regex']);
const APP_RULE_EXTRACTION_MODES = new Set(['none', 'multi']);
const APP_RULE_SCOPE_TYPES = new Set(['all', 'users', 'groups']);
export const APP_RULE_LOG_STATUSES = new Set(['matched', 'success', 'failed', 'skipped']);

/**
 * 校验并构造规则扁平字段 patch（创建 requireAll=true，更新为部分字段）。
 * request.headers 仅在显式传入时加密（{} 表示清空；不传保持原值）。
 * @param {object} rawBody 请求体
 * @param {{requireAll?: boolean, existing?: object|null}} [options]
 *   existing：PATCH 场景传入 DB 现有行，用于跨字段校验（如 request.mode=none 时合并现有模板/兜底值，BA-14）。
 */
export function buildAppRulePatch(rawBody, { requireAll = false, existing = null } = {}) {
  const body = assertPlainObject(rawBody ?? {}, '请求体');
  const patch = {};

  if (requireAll || body.name !== undefined) patch.name = requiredString(body.name, 'name', { min: 1, max: 60 });
  if (requireAll || body.enabled !== undefined) {
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw badRequest('enabled 必须是 boolean');
    // 创建（requireAll）未传 enabled 时默认停用（与文档「规则默认不启用」一致）；更新仅在显式传入时改写。
    patch.enabled = body.enabled === undefined ? false : body.enabled;
  }
  if (requireAll || body.priority !== undefined) {
    const priority = body.priority === undefined ? 100 : body.priority;
    if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000) {
      throw badRequest('priority 必须是 0..1000000 的整数');
    }
    patch.priority = priority;
  }

  if (requireAll || body.scope !== undefined) {
    const scope = assertPlainObject(body.scope ?? { type: 'all', ids: [] }, 'scope');
    const type = scope.type ?? 'all';
    if (!APP_RULE_SCOPE_TYPES.has(type)) throw badRequest('scope.type 只能是 all | users | groups');
    let ids = [];
    if (type !== 'all') {
      if (!Array.isArray(scope.ids) || scope.ids.length === 0) throw badRequest('scope.ids 必须是非空数组');
      ids = [...new Set(scope.ids.map((id) => String(id).trim()).filter(Boolean))];
      if (ids.length === 0) throw badRequest('scope.ids 必须包含有效 id');
      if (type === 'users') {
        const unknown = ids.filter((id) => !store.getUserRow(id));
        if (unknown.length > 0) throw badRequest(`scope.ids 中用户不存在：${unknown.join(', ')}`);
      } else {
        const unknown = ids.filter((id) => !store.getGroupRow(id));
        if (unknown.length > 0) throw badRequest(`scope.ids 中分组不存在：${unknown.join(', ')}`);
      }
    }
    patch.scopeType = type;
    patch.scopeIds = ids;
  }

  if (requireAll || body.matchMode !== undefined || body.keywords !== undefined || body.regexPattern !== undefined) {
    const mode = body.matchMode ?? 'contains';
    if (!APP_RULE_MATCH_MODES.has(mode)) throw badRequest('matchMode 只能是 contains | equals | regex');
    patch.matchMode = mode;
    if (mode === 'regex') {
      const pattern = requiredString(body.regexPattern, 'regexPattern', { min: 1, max: 500 });
      if (!validRegexSource(pattern)) throw badRequest('regexPattern 不是合法正则');
      patch.regexPattern = pattern;
      patch.keywords = [];
    } else {
      if (!Array.isArray(body.keywords) || body.keywords.length < 1 || body.keywords.length > 10) {
        throw badRequest('keywords 必须是 1..10 个关键词');
      }
      const keywords = body.keywords.map((keyword) => {
        if (typeof keyword !== 'string') throw badRequest('keywords 必须是字符串数组');
        const text = keyword.trim();
        if (text.length < 1 || text.length > 50) throw badRequest('每个关键词长度必须是 1..50');
        return text;
      });
      patch.keywords = keywords;
      patch.regexPattern = '';
    }
  }

  if (requireAll || body.extraction !== undefined) {
    const defaultExtraction = { mode: 'multi', config: { extractors: [{ type: 'trailing', param: 'arg' }] } };
    const extraction = assertPlainObject(body.extraction ?? defaultExtraction, 'extraction');
    const mode = extraction.mode ?? 'multi';
    if (!APP_RULE_EXTRACTION_MODES.has(mode)) {
      throw badRequest('extraction.mode 只能是 none | multi');
    }
    const extractionConfig = assertPlainObject(extraction.config ?? {}, 'extraction.config');
    if (mode === 'multi') {
      const extractors = extractionConfig.extractors;
      if (!Array.isArray(extractors) || extractors.length < 1 || extractors.length > 10) {
        throw badRequest('multi 提取模式需要 extraction.config.extractors 数组（1-10 项）');
      }
      const paramNamePattern = /^[A-Za-z0-9_]{1,30}$/;
      extractors.forEach((item, index) => {
        const extractor = assertPlainObject(item, `extraction.config.extractors[${index}]`);
        const type = String(extractor.type ?? '');
        if (!['trailing', 'regex', 'json', 'fulltext'].includes(type)) {
          throw badRequest(`提取项 ${index + 1} 的 type 只能是 trailing | regex | json | fulltext`);
        }
        if (extractor.param !== undefined) {
          if (typeof extractor.param !== 'string' || !paramNamePattern.test(extractor.param.trim())) {
            throw badRequest(`提取项 ${index + 1} 的 param 只能是字母/数字/下划线（1-30 字符）`);
          }
        }
        if (type === 'trailing' && extractor.keyword !== undefined) {
          if (typeof extractor.keyword !== 'string' || extractor.keyword.length > 50) {
            throw badRequest(`提取项 ${index + 1} 的 keyword 最多 50 个字符`);
          }
        }
        if (type === 'regex') {
          const regex = extractor.regex;
          if (typeof regex !== 'string' || regex.trim() === '' || !validRegexSource(regex)) {
            throw badRequest(`提取项 ${index + 1} 的 regex 缺失或不是合法正则`);
          }
        }
        if (type === 'json' && extractor.path !== undefined) {
          if (typeof extractor.path !== 'string' || extractor.path.length > 200) {
            throw badRequest(`提取项 ${index + 1} 的 path 最多 200 个字符`);
          }
        }
      });
      const required = extractionConfig.required;
      if (required !== undefined) {
        if (!Array.isArray(required) || required.length > 20) {
          throw badRequest('extraction.config.required 必须是数组（最多 20 个参数名）');
        }
        for (const name of required) {
          if (typeof name !== 'string' || !paramNamePattern.test(name.trim())) {
            throw badRequest('extraction.config.required 中的参数名只能是字母/数字/下划线');
          }
        }
      }
    }
    patch.extractionMode = mode;
    patch.extractionConfig = extractionConfig;
  }

  if (requireAll || body.request !== undefined) {
    const request = assertPlainObject(body.request ?? {}, 'request');
    const mode = request.mode ?? 'http';
    if (mode !== 'http' && mode !== 'none') throw badRequest('request.mode 只能是 http | none');
    if (mode === 'none') {
      // 不请求：URL/Header/Body 全部清空，关键词命中后直接使用回复模板/兜底文案。
      patch.requestMethod = 'GET';
      patch.requestUrl = '';
      patch.requestBodyTemplate = '';
      patch.requestHeadersEnc = null;
    } else {
      const method = String(request.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') throw badRequest('request.method 只能是 GET | POST');
      patch.requestMethod = method;
      patch.requestUrl = validateHttpUrl(request.url);
      patch.requestBodyTemplate = optionalString(request.bodyTemplate, 'request.bodyTemplate', 10000);
      if (request.headers !== undefined) {
        const headers = assertPlainObject(request.headers, 'request.headers');
        const normalized = {};
        for (const [key, value] of Object.entries(headers)) {
          if (typeof key !== 'string' || key.trim().length < 1 || key.trim().length > 100) {
            throw badRequest('request.headers 的 header 名长度必须是 1..100');
          }
          if (typeof value !== 'string' || value.length > 2000) {
            throw badRequest(`request.headers[${key}] 的值必须是 ≤2000 的字符串`);
          }
          normalized[key.trim()] = value;
        }
        patch.requestHeadersEnc = encryptSecret(JSON.stringify(normalized));
      } else if (requireAll) {
        patch.requestHeadersEnc = null;
      }
    }
  }

  if (requireAll || body.response !== undefined) {
    const response = assertPlainObject(body.response ?? {}, 'response');
    const type = response.type ?? 'json';
    if (type !== 'json' && type !== 'text') throw badRequest('response.type 只能是 json | text');
    patch.responseType = type;
    patch.responsePath = optionalString(response.path, 'response.path', 200);
    patch.replyTemplate = optionalString(response.template, 'response.template', 4000);
    patch.fallbackText = optionalString(response.fallbackText, 'response.fallbackText', 4000);
  }

  // 不请求模式（request_url 为空）必须能产出回复。
  // BA-14：PATCH 可能只提交 request.mode=none（不带 response），必须合并 DB 现有模板/兜底值判断，
  // 否则会落库成“命中后 empty reply”的规则。创建时 patch 一定带完整 request/response，行为不变。
  const effectiveRequestUrl = patch.requestUrl !== undefined ? patch.requestUrl : (existing?.request_url ?? '');
  if (effectiveRequestUrl === '') {
    const effectiveTemplate = patch.replyTemplate !== undefined ? patch.replyTemplate : (existing?.reply_template ?? '');
    const effectiveFallback = patch.fallbackText !== undefined ? patch.fallbackText : (existing?.fallback_text ?? '');
    if (String(effectiveTemplate).trim() === '' && String(effectiveFallback).trim() === '') {
      throw badRequest('不请求模式必须填写回复模板或兜底文案');
    }
  }

  const limitSpecs = [['timeoutMs', 1000, 30000, 8000]];
  for (const [key, min, max, defaultValue] of limitSpecs) {
    if (!requireAll && body[key] === undefined) continue;
    const value = body[key] === undefined ? defaultValue : body[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw badRequest(`${key} 必须是 ${min}..${max} 的整数`);
    }
    patch[key] = value;
  }

  return patch;
}
