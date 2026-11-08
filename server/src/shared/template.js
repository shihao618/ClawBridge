/**
 * 通用模板引擎（shared，无业务依赖；BA-09 从 app-rules.js 抽出）。
 *
 *  - 请求模板：`{key}` 单变量替换（可 URL 编码）；
 *  - 回复/通知模板：`{{path}}` / `{{response}}` / `{{raw}}` / `{{count path}}` /
 *    `{{#each path [where 字段=值]}}...{{else}}...{{/each}}` /
 *    `{{#if ...}}...{{else if ...}}...{{else}}...{{/if}}` / `{{#unless}}` / `{{default ...}}`；
 *  - 输出长度上限（BA-22）：渲染达到 maxReplyLength 后立即停止 each 迭代，避免大数组全量渲染。
 *
 * app-rules 与 scheduler 共用；模块内不得 import 任何业务模块。
 */
import { config } from '../config.js';

/** 回复/通知文本最大长度（config 实时读取，后台修改即时生效）。 */
export function maxReplyLength() {
  return config.push.maxTextLength;
}

/** 截断文本（超长直接截断并加省略号）。 */
export function truncate(value, max = 1000) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** JSON 解析（失败不抛错，返回 {ok,value}）。 */
export function safeJsonParse(text) {
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
export function valueToText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// 请求模板（API_RULES 的 {key} 变量替换）
// ---------------------------------------------------------------------------

/** 单变量替换：`{key}`（仅字母数字下划线）；urlEncode=true 时对值做 URL 编码。 */
export function renderRequestTemplate(template, vars = {}, { urlEncode = false } = {}) {
  return String(template ?? '').replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
    const value = String(vars[key] ?? '');
    return urlEncode ? encodeURIComponent(value) : value;
  });
}

// ---------------------------------------------------------------------------
// 回复模板编译/渲染
// ---------------------------------------------------------------------------

/** 统计数组/对象长度（用于模板 `{{count path}}`）。 */
function countValue(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  if (value === undefined || value === null || value === '') return 0;
  return 1;
}

/**
 * 解析列表规格：`path` 或 `path where 字段=值` / `path where 字段!=值`。
 * path 可为 `.`（当前上下文）或空（当前上下文），支持 `../parent.field` / `@root.path`。
 */
function parseListSpec(rawSpec) {
  const spec = String(rawSpec ?? '').trim();
  const whereMatch = spec.match(/^(\S*)\s+where\s+([A-Za-z0-9_.@-]+)\s*(!=|=)\s*(.+)$/i);
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

/**
 * 模板路径解析（相对当前上下文，失败时依次向上找父级/模板根）。
 * 支持：`.`/空=当前、`../字段` 上级、`@root.字段` 模板根、`@responseRoot.字段` 完整响应根。
 */
function resolveTemplatePath(rawPath, contextStack, responseRoot) {
  const pathText = String(rawPath ?? '').trim();
  let current = contextStack[contextStack.length - 1];
  if (!pathText || pathText === '.' || pathText === 'this' || pathText === '@this') return current;

  const fullRoot = responseRoot !== undefined ? responseRoot : contextStack[0];
  if (pathText === '@responseRoot') return fullRoot;
  if (pathText.startsWith('@responseRoot.')) return getByPath(fullRoot, pathText.slice('@responseRoot.'.length));
  if (pathText === '@root') return contextStack[0];
  if (pathText.startsWith('@root.')) return getByPath(contextStack[0], pathText.slice(6));

  if (pathText.startsWith('../')) {
    let levels = 0;
    let rest = pathText;
    while (rest.startsWith('../')) {
      levels += 1;
      rest = rest.slice(3);
    }
    const targetIndex = Math.max(0, contextStack.length - 1 - levels);
    current = contextStack[targetIndex];
    if (!rest || rest === '.' || rest === 'this') return current;
    return getByPath(current, rest);
  }

  for (let index = contextStack.length - 1; index >= 0; index -= 1) {
    const value = getByPath(contextStack[index], pathText);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** 计算 `count path [where ...]` 的值（支持相对当前循环项/父级）。 */
function resolveCountValue(rawSpec, contextStack, responseRoot) {
  const parsed = parseListSpec(rawSpec);
  const value = resolveTemplatePath(parsed.path, contextStack, responseRoot);
  if (parsed.filter) return filterList(value, parsed.filter).length;
  return countValue(value);
}

/** 模板 token 化：文本 / 变量 / each、if、unless 块 / else if / else / 闭合。 */
function tokenizeTemplate(template) {
  const tokens = [];
  const pattern =
    /\{\{\s*#(each|if|unless)(?:\s+([^{}]*?))?\s*\}\}|\{\{\s*\/(each|if|unless)\s*\}\}|\{\{\s*else\s+if\s+([^{}]*?)\}\}|\{\{\s*else\s*\}\}|\{\{([^{}]+?)\}\}/gi;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(template)) !== null) {
    if (match.index > lastIndex) tokens.push({ type: 'text', value: template.slice(lastIndex, match.index) });
    if (match[1]) {
      tokens.push({ type: 'block', name: match[1].toLowerCase(), spec: String(match[2] ?? '').trim() });
    } else if (match[3]) {
      tokens.push({ type: 'close', name: match[3].toLowerCase() });
    } else if (match[4] !== undefined) {
      tokens.push({ type: 'elseif', expr: String(match[4] ?? '').trim() });
    } else if (/^\{\{\s*else\s*\}\}$/i.test(match[0])) {
      tokens.push({ type: 'else' });
    } else {
      tokens.push({ type: 'var', expr: String(match[5] ?? '').trim() });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < template.length) tokens.push({ type: 'text', value: template.slice(lastIndex) });
  return tokens;
}

function unquoteTemplateLiteral(raw) {
  const text = String(raw ?? '').trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/** 模板判断的真值：空串/0/false/null/undefined/空数组/空对象为假。 */
function isTruthyTemplateValue(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** default 视为空的值：undefined/null/空串/空数组；0/false 保留。 */
function isEmptyTemplateValue(value) {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** 解析判断表达式左侧：支持路径、count、数字/带引号字面量。 */
function resolveConditionLeft(raw, contextStack, responseRoot) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/^count\s+/i.test(text)) return resolveCountValue(text.slice(6).trim(), contextStack, responseRoot);
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return unquoteTemplateLiteral(text);
  }
  return resolveTemplatePath(text, contextStack, responseRoot);
}

/** 判断右侧按字面量处理；数字转为 number，带引号去引号，其余为字符串。 */
function resolveConditionRight(raw) {
  const text = String(raw ?? '').trim();
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return Number(text);
  return unquoteTemplateLiteral(text);
}

/** 在引号外按 and / or 拆分条件，支持多条件组合。 */
function splitLogicalCondition(text, keyword) {
  const needle = ' ' + keyword + ' ';
  const lower = text.toLowerCase();
  const parts = [];
  let last = 0;
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (lower.startsWith(needle, index)) {
      parts.push(text.slice(last, index).trim());
      last = index + needle.length;
      index += needle.length - 1;
    }
  }
  if (parts.length === 0) return null;
  parts.push(text.slice(last).trim());
  return parts;
}

/**
 * 执行 if/unless 判断。
 * 支持真值判断、not/and/or、= / == / != / > / >= / < / <= 比较，左侧可为 path 或 count。
 */
function evaluateTemplateCondition(raw, contextStack, responseRoot) {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  const orParts = splitLogicalCondition(text, 'or');
  if (orParts) return orParts.some((part) => evaluateTemplateCondition(part, contextStack, responseRoot));
  const andParts = splitLogicalCondition(text, 'and');
  if (andParts) return andParts.every((part) => evaluateTemplateCondition(part, contextStack, responseRoot));
  if (/^not\s+/i.test(text)) return !evaluateTemplateCondition(text.slice(4).trim(), contextStack, responseRoot);

  const match = text.match(/^(.+?)\s*(==|!=|>=|<=|=|>|<)\s*(.+)$/);
  if (!match) return isTruthyTemplateValue(resolveConditionLeft(text, contextStack, responseRoot));

  const left = resolveConditionLeft(match[1], contextStack, responseRoot);
  const op = match[2];
  const right = resolveConditionRight(match[3]);
  if (op === '=' || op === '==') {
    if (typeof left === 'number' && typeof right === 'number') return left === right;
    return (left === undefined || left === null ? '' : String(left)) === String(right);
  }
  if (op === '!=') {
    if (typeof left === 'number' && typeof right === 'number') return left !== right;
    return (left === undefined || left === null ? '' : String(left)) !== String(right);
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
  if (op === '>') return leftNumber > rightNumber;
  if (op === '>=') return leftNumber >= rightNumber;
  if (op === '<') return leftNumber < rightNumber;
  return leftNumber <= rightNumber;
}

/** default path "兜底文案"：值空时使用兜底文案。 */
function resolveDefaultVariable(raw, contextStack, responseRoot) {
  const match = String(raw ?? '').trim().match(/^default\s+(\S+)(?:\s+([\s\S]+))?$/i);
  if (!match) return '';
  const value = resolveTemplatePath(match[1], contextStack, responseRoot);
  if (!isEmptyTemplateValue(value)) return valueToText(value);
  return unquoteTemplateLiteral(match[2] ?? '');
}

function resolveTemplateVariable(expr, contextStack, metaStack, options) {
  const text = String(expr ?? '').trim();
  if (text === 'response') return options.responseText ?? '';
  if (text === 'raw') return options.rawText ?? '';
  if (/^default\s+/i.test(text)) {
    return resolveDefaultVariable(text, contextStack, options.responseRoot);
  }

  const parentIndexMatch = text.match(/^((?:\.\.\/)+)@(index|number)$/);
  if (parentIndexMatch) {
    const levels = (parentIndexMatch[1].match(/\.\.\//g) ?? []).length;
    const meta = metaStack[metaStack.length - 1 - levels];
    return meta ? String(meta[parentIndexMatch[2]]) : '';
  }
  if (text === '@index' || text === '@number') {
    const meta = metaStack[metaStack.length - 1];
    return meta ? String(meta[text.slice(1)]) : '';
  }

  if (text.startsWith('count ')) {
    return valueToText(resolveCountValue(text.slice(6).trim(), contextStack, options.responseRoot));
  }
  return valueToText(resolveTemplatePath(text, contextStack, options.responseRoot));
}

const MAX_TEMPLATE_DEPTH = 32;
const TEMPLATE_CACHE_MAX = 200;
const templateAstCache = new Map();

/** 把 token 编译为 AST；解析失败/未闭合时保持宽容（渲染到末尾），由调用方决定展示。 */
function compileTemplateAst(tokens) {
  let index = 0;
  const parseNodes = (stops) => {
    const nodes = [];
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.type === 'text' || token.type === 'var') {
        nodes.push(token);
        index += 1;
        continue;
      }
      if (token.type === 'close' || token.type === 'elseif' || token.type === 'else') {
        if (stops.has(token.type)) return { nodes, stop: token };
        index += 1;
        continue;
      }
      if (token.type === 'block') {
        const name = token.name;
        index += 1;
        if (name === 'each') {
          const first = parseNodes(new Set(['close', 'else']));
          let elseBody = [];
          if (first.stop?.type === 'else') {
            index += 1;
            const alt = parseNodes(new Set(['close']));
            elseBody = alt.nodes;
            if (alt.stop?.type === 'close') index += 1;
          } else if (first.stop?.type === 'close') {
            index += 1;
          }
          nodes.push({ type: 'each', spec: token.spec, body: first.nodes, elseBody });
          continue;
        }
        const branches = [];
        let expr = token.spec;
        while (true) {
          const parsed = parseNodes(new Set(['elseif', 'else', 'close']));
          branches.push({ expr, nodes: parsed.nodes });
          if (!parsed.stop) break;
          if (parsed.stop.type === 'elseif') {
            expr = parsed.stop.expr;
            index += 1;
            continue;
          }
          if (parsed.stop.type === 'else') {
            index += 1;
            const alt = parseNodes(new Set(['close']));
            branches.push({ expr: null, nodes: alt.nodes });
            if (alt.stop?.type === 'close') index += 1;
            break;
          }
          if (parsed.stop.type === 'close') {
            index += 1;
            break;
          }
        }
        nodes.push({ type: name, branches });
        continue;
      }
      index += 1;
    }
    return { nodes, stop: null };
  };
  return parseNodes(new Set()).nodes;
}

/** 模板 AST 缓存（按模板文本 LRU），同一模板在规则/定时反复执行时不再重复编译。 */
function getCompiledTemplate(template) {
  const cached = templateAstCache.get(template);
  if (cached) {
    templateAstCache.delete(template);
    templateAstCache.set(template, cached);
    return cached;
  }
  const ast = compileTemplateAst(tokenizeTemplate(template));
  if (templateAstCache.size >= TEMPLATE_CACHE_MAX) {
    const oldest = templateAstCache.keys().next().value;
    if (oldest !== undefined) templateAstCache.delete(oldest);
  }
  templateAstCache.set(template, ast);
  return ast;
}

/**
 * 递归渲染 AST；contextStack[0] 为模板根，后续为当前/父级循环项。
 * BA-22：options.maxLength > 0 时，输出达到上限立即停止（含 {{#each}} 迭代），
 * 避免大数组先全量渲染再截断造成的 CPU/内存放大。
 */
function renderTemplateAst(nodes, contextStack, metaStack, options, depth = 0) {
  if (depth > MAX_TEMPLATE_DEPTH) return '';
  const maxLength = Number(options?.maxLength) > 0 ? Number(options.maxLength) : 0;
  let output = '';
  for (const node of nodes || []) {
    if (maxLength > 0 && output.length >= maxLength) break;
    if (node.type === 'text') {
      output += node.value;
      continue;
    }
    if (node.type === 'var') {
      output += resolveTemplateVariable(node.expr, contextStack, metaStack, options);
      continue;
    }
    if (node.type === 'each') {
      const parsed = parseListSpec(node.spec);
      const value = resolveTemplatePath(parsed.path, contextStack, options.responseRoot);
      const list = filterList(value, parsed.filter);
      if (list.length === 0) {
        if (node.elseBody?.length) output += renderTemplateAst(node.elseBody, contextStack, metaStack, options, depth + 1);
        continue;
      }
      for (let itemIndex = 0; itemIndex < list.length; itemIndex += 1) {
        if (maxLength > 0 && output.length >= maxLength) break;
        output += renderTemplateAst(
          node.body,
          [...contextStack, list[itemIndex]],
          [...metaStack, { index: itemIndex, number: itemIndex + 1 }],
          options,
          depth + 1,
        );
      }
      continue;
    }
    if (node.type === 'if' || node.type === 'unless') {
      for (let branchIndex = 0; branchIndex < node.branches.length; branchIndex += 1) {
        if (maxLength > 0 && output.length >= maxLength) break;
        const branch = node.branches[branchIndex];
        const matched =
          branch.expr === null
            ? true
            : node.type === 'unless' && branchIndex === 0
              ? !evaluateTemplateCondition(branch.expr, contextStack, options.responseRoot)
              : evaluateTemplateCondition(branch.expr, contextStack, options.responseRoot);
        if (matched) {
          output += renderTemplateAst(branch.nodes, contextStack, metaStack, options, depth + 1);
          break;
        }
      }
    }
  }
  return output;
}

/**
 * 回复/通知模板：`{{path}}` 从模板根取值；内置 `{{response}}` / `{{raw}}`；
 * 支持 `{{count path [where 字段=值]}}` 与多层嵌套 `{{#each path [where ...]}}...{{/each}}`。
 * 循环内：当前项字段直接写 `{{字段}}`；父级 `{{../字段}}`；根 `{{@root.字段}}`；
 * `{{@index}}`/`{{@number}}` 为当前循环下标/序号，`{{../@index}}` 取父循环。
 * 支持 @root（模板根）与 @responseRoot（完整响应根）两种特殊根引用。
 * 输出长度上限默认取 maxReplyLength()（BA-22），可通过 options.maxLength 覆盖（测试用）。
 */
export function renderReplyTemplate(template, { root, responseText = '', rawText = '', responseRoot, maxLength } = {}) {
  const tpl = String(template ?? '');
  const limit = Math.max(1, Number(maxLength) || maxReplyLength());
  if (tpl.trim() === '') return truncate(responseText, limit);
  const rendered = renderTemplateAst(getCompiledTemplate(tpl), [root], [], {
    responseText,
    rawText,
    responseRoot,
    maxLength: limit,
  });
  return truncate(rendered, limit);
}
