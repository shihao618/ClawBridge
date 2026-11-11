/**
 * ClawBridge 管理后台 Markdown 预览渲染器（安全、零外部依赖）。
 *
 * 目标：与微信 ClawBot 实际渲染**一致**——先按腾讯官方微信插件的
 * `StreamingMarkdownFilter` 语义过滤（中文斜体去标记、H5/H6 去 #、图片移除），
 * 再渲染微信会渲染的子集：
 * - 块级：标题 H1–H4、分隔线、引用（多行/嵌套）、围栏代码块（含语言）、缩进代码块、
 *   无序/有序列表（任意缩进嵌套、列表项续行、loose list）、表格（对齐）、段落与硬换行；
 * - 行内：粗体/斜体（非中文）/删除线、行内代码、链接（按文字显示）、裸 URL（微信会自动识别，
 *   预览按链接样式显示）、反斜杠转义；尖括号 URL 按原文显示（微信不自动识别）。
 *
 * 安全：全部使用 DOM 文本节点（textContent），不拼接 innerHTML；链接不生成可点击 href，
 * 不发起远程请求，避免 XSS/SSRF/追踪。
 */

import { el } from '../common.js';
import { filterWechatMarkdown, layoutWechatText } from '../lib/wechat-markdown.js';

const TAB_WIDTH = 4;
const MAX_NESTING = 12;

/** 把行首 tab 展开为空格（仅用于缩进判定，正文内容保留原样文本）。 */
function normalizeIndent(line) {
  const match = /^[ \t]*/.exec(line);
  return match[0].replace(/\t/g, ' '.repeat(TAB_WIDTH)) + line.slice(match[0].length);
}

/** 缩进宽度（空格数；tab 按 4 计）。 */
function indentWidth(line) {
  const match = /^[ \t]*/.exec(line);
  if (!match) return 0;
  return match[0].replace(/\t/g, ' '.repeat(TAB_WIDTH)).length;
}

/** 去掉至多 n 个行首空格（不足则全部去掉）。 */
function stripIndent(line, n) {
  let i = 0;
  let count = 0;
  while (i < line.length && count < n) {
    if (line[i] === ' ') {
      count += 1;
      i += 1;
    } else if (line[i] === '\t') {
      count += TAB_WIDTH;
      i += 1;
    } else {
      break;
    }
  }
  return line.slice(i);
}

function isBlank(line) {
  return line.trim() === '';
}

/** 解析列表标记：返回 { indent, marker, ordered, content, contentIndent } 或 null。 */
function matchListMarker(line) {
  const match = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[2];
  const spaces = match[3];
  const contentIndent = match[1].length + marker.length + Math.max(1, Math.min(spaces.length, 4));
  return {
    indent: match[1].length,
    marker,
    ordered: /^\d/.test(marker),
    content: match[4],
    contentIndent,
  };
}

/** 是否块级起始（用于段落终止判断）。 */
function startsBlock(line) {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  if (/^(`{3,}|~{3,})/.test(trimmed)) return true;
  if (/^#{1,6}(\s|$)/.test(trimmed)) return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed.replace(/\s+/g, ''))) return true;
  if (/^>/.test(trimmed)) return true;
  if (matchListMarker(line)) return true;
  if (/^\|/.test(trimmed) || /\|/.test(trimmed)) {
    // 表格需要下一行分隔符确认，这里仅在行首 | 时视为候选
    if (/^\|/.test(trimmed)) return true;
  }
  return false;
}


/** 行内渲染：粗体/斜体/删除线/行内代码/链接/图片/转义；尖括号 URL 按原文显示（对齐微信客户端）。 */
function renderInline(target, text) {
  const input = String(text ?? '');
  let i = 0;
  let buffer = '';
  const flush = () => {
    if (buffer) {
      target.append(buffer);
      buffer = '';
    }
  };
  const pushText = (value) => {
    if (value) buffer += value;
  };
  const findCodeEnd = (from, tickCount) => {
    for (let j = from; j < input.length; j += 1) {
      if (input[j] !== '`') continue;
      let k = j;
      while (k < input.length && input[k] === '`') k += 1;
      if (k - j === tickCount) return { start: j, end: k };
      j = k - 1;
    }
    return null;
  };
  const findClosing = (from, token) => {
    let idx = input.indexOf(token, from);
    while (idx !== -1) {
      if (input[idx - 1] !== '\\') return idx;
      idx = input.indexOf(token, idx + 1);
    }
    return -1;
  };

  while (i < input.length) {
    const ch = input[i];

    // 反斜杠转义
    if (ch === '\\' && i + 1 < input.length) {
      pushText(input[i + 1]);
      i += 2;
      continue;
    }

    // 行内代码 `…`（支持多反引号）
    if (ch === '`') {
      let ticks = 1;
      while (input[i + ticks] === '`') ticks += 1;
      const end = findCodeEnd(i + ticks, ticks);
      if (end) {
        let code = input.slice(i + ticks, end.start);
        code = code.replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && code.trim() !== '') code = code.slice(1, -1);
        flush();
        target.append(el('code', { class: 'markdown-inline-code', text: code }));
        i = end.end;
        continue;
      }
      pushText('`'.repeat(ticks));
      i += ticks;
      continue;
    }

    // 裸 URL：微信客户端会自动识别为链接（尖括号包裹的除外）
    if (ch === 'h' && /^https?:\/\//i.test(input.slice(i))) {
      const prev = i > 0 ? input[i - 1] : '';
      if (!['<', '(', '[', '\\', '"', "'", '='].includes(prev)) {
        const match = /^https?:\/\/[^\s<>"'`]+/i.exec(input.slice(i));
        if (match) {
          let url = match[0];
          let trailing = '';
          const tail = /[.,;:!?。，；：！？、]+$/.exec(url);
          if (tail) {
            trailing = tail[0];
            url = url.slice(0, -trailing.length);
          }
          flush();
          target.append(el('span', { class: 'markdown-link', text: url, title: url }));
          pushText(trailing);
          i += match[0].length;
          continue;
        }
      }
    }

    // 图片 ![alt](url) —— 微信不渲染，过滤阶段已移除；此处兜底按原文显示

    // 链接 [text](url) —— 只显示文字，不生成可点击链接（防追踪/钓鱼）
    if (ch === '[') {
      const match = /^\[([^\]]+)\]\(([^)]*)\)/.exec(input.slice(i));
      if (match) {
        flush();
        target.append(el('span', { class: 'markdown-link', text: match[1], title: match[2] }));
        i += match[0].length;
        continue;
      }
    }


    // 删除线 ~~text~~
    if (ch === '~' && input[i + 1] === '~') {
      const end = findClosing(i + 2, '~~');
      if (end !== -1 && end > i + 2) {
        const node = el('s');
        renderInline(node, input.slice(i + 2, end));
        flush();
        target.append(node);
        i = end + 2;
        continue;
      }
    }

    // 粗体 **text** / __text__
    if (ch === '*' || ch === '_') {
      const double = input[i + 1] === ch;
      const token = double ? ch + ch : ch;
      const from = i + token.length;
      const end = findClosing(from, token);
      // 下划线强调不用于词内（如 snake_case）
      const intraword = ch === '_' && i > 0 && /[A-Za-z0-9]/.test(input[i - 1]);
      if (end !== -1 && end > from && !intraword) {
        const tag = double ? 'strong' : 'em';
        const node = el(tag);
        renderInline(node, input.slice(from, end));
        flush();
        target.append(node);
        i = end + token.length;
        continue;
      }
    }

    pushText(ch);
    i += 1;
  }
  flush();
}

/** 渲染单行/多行段落（换行按硬换行处理，与发送时 formatWeixinText 行为一致）。 */
function renderParagraphLines(container, lines) {
  lines.forEach((line, index) => {
    if (index > 0) container.append(el('br'));
    renderInline(container, line);
  });
}

/** 渲染表格。 */
function renderTable(container, headerLine, alignLine, rows) {
  const splitRow = (row) => {
    let text = row.trim();
    if (text.startsWith('|')) text = text.slice(1);
    if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
    const cells = [];
    let current = '';
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '\\' && text[i + 1] === '|') {
        current += '|';
        i += 1;
      } else if (text[i] === '|') {
        cells.push(current.trim());
        current = '';
      } else {
        current += text[i];
      }
    }
    cells.push(current.trim());
    return cells;
  };
  const alignments = splitRow(alignLine).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  });
  const makeCell = (tag, text, align) => {
    const cell = el(tag);
    if (align) cell.style.textAlign = align;
    renderInline(cell, text);
    return cell;
  };
  const table = el('table', { class: 'markdown-table' });
  const thead = el('thead');
  const headRow = el('tr');
  splitRow(headerLine).forEach((cell, index) => headRow.append(makeCell('th', cell, alignments[index])));
  thead.append(headRow);
  table.append(thead);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    splitRow(row).forEach((cell, index) => tr.append(makeCell('td', cell, alignments[index])));
    tbody.append(tr);
  }
  table.append(tbody);
  container.append(table);
}

/**
 * 解析块级内容。
 * @param {object} container 目标 DOM 容器
 * @param {string[]} lines 已按需去缩进的行数组
 * @param {object} [options]
 * @param {boolean} [options.tightParagraph] 列表项内段落不包 <p>（tight list 视觉）
 * @param {number} [options.depth] 嵌套深度（防御过深缩进）
 */
function renderBlocks(container, lines, options = {}) {
  const { tightParagraph = false, depth = 0 } = options;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const trimmed = line.trim();
    const indent = indentWidth(line);

    // 围栏代码块
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (fence && indent <= 3 + depth * 0) {
      const fenceChar = fence[1][0];
      const fenceLen = fence[1].length;
      const info = fence[2].trim();
      const codeLines = [];
      i += 1;
      while (i < n) {
        const candidate = lines[i].trim();
        const close = new RegExp(`^${fenceChar === '`' ? '`' : '~'}{${fenceLen},}\\s*$`);
        if (close.test(candidate)) {
          i += 1;
          break;
        }
        codeLines.push(stripIndent(lines[i], Math.min(indentWidth(lines[i]), indent)));
        i += 1;
      }
      const pre = el('pre', { class: 'markdown-code-block' });
      const codeProps = { text: codeLines.join('\n') };
      if (info) codeProps.class = `language-${info.split(/\s+/)[0].replace(/[^\w+-]/g, '')}`;
      pre.append(el('code', codeProps));
      container.append(pre);
      continue;
    }

    // ATX 标题
    const heading = /^(#{1,6})(?:\s+(.*?))?\s*#*\s*$/.exec(trimmed);
    if (heading && indent <= 3) {
      const level = Math.min(6, heading[1].length);
      const h = el(`h${level}`, { class: 'markdown-heading' });
      renderInline(h, heading[2] || '');
      container.append(h);
      i += 1;
      continue;
    }

    // 分隔线
    if (indent <= 3 && /^([-*_])(\s*\1){2,}\s*$/.test(trimmed)) {
      container.append(el('hr'));
      i += 1;
      continue;
    }

    // 引用（支持多行/嵌套）
    if (indent <= 3 && /^>\s?/.test(trimmed)) {
      const quoteLines = [];
      while (i < n) {
        const current = lines[i];
        if (/^\s{0,3}>\s?/.test(current)) {
          quoteLines.push(current.replace(/^\s{0,3}>\s?/, ''));
          i += 1;
          continue;
        }
        if (isBlank(current)) {
          // 引用内的空行：仅当下一行仍是引用时保留
          let j = i + 1;
          while (j < n && isBlank(lines[j])) j += 1;
          if (j < n && /^\s{0,3}>\s?/.test(lines[j])) {
            quoteLines.push('');
            i = j;
            continue;
          }
        }
        break;
      }
      const blockquote = el('blockquote');
      renderBlocks(blockquote, quoteLines, { depth: depth + 1 });
      container.append(blockquote);
      continue;
    }

    // 列表
    const listMarker = matchListMarker(line);
    if (listMarker && listMarker.indent <= 3) {
      const ordered = listMarker.ordered;
      const listEl = el(ordered ? 'ol' : 'ul', { class: 'markdown-list' });
      const firstNumber = ordered ? Number.parseInt(listMarker.marker, 10) : 1;
      if (ordered && Number.isFinite(firstNumber) && firstNumber > 1) listEl.setAttribute('start', String(firstNumber));
      const listIndent = listMarker.indent;
      while (i < n) {
        const baseLine = lines[i];
        const marker = matchListMarker(baseLine);
        if (!marker || marker.ordered !== ordered || marker.indent !== listIndent) break;
        const itemLines = [marker.content];
        i += 1;
        // 收集列表项续行 / 嵌套块
        while (i < n) {
          const current = lines[i];
          if (isBlank(current)) {
            let j = i + 1;
            while (j < n && isBlank(lines[j])) j += 1;
            if (j >= n) {
              i = j;
              break;
            }
            const nextMarker = matchListMarker(lines[j]);
            if (nextMarker && nextMarker.ordered === ordered && nextMarker.indent === listIndent) {
              i = j;
              break;
            }
            if (indentWidth(lines[j]) > listIndent) {
              itemLines.push('');
              i += 1;
              continue;
            }
            i = j;
            break;
          }
          const currentIndent = indentWidth(current);
          if (currentIndent > listIndent) {
            itemLines.push(stripIndent(current, Math.min(currentIndent, marker.contentIndent)));
            i += 1;
            continue;
          }
          const nextMarker = matchListMarker(current);
          if (nextMarker && nextMarker.ordered === ordered && nextMarker.indent === listIndent) break;
          break;
        }
        const li = el('li');
        if (depth < MAX_NESTING) renderBlocks(li, itemLines, { tightParagraph: true, depth: depth + 1 });
        listEl.append(li);
      }
      container.append(listEl);
      continue;
    }

    // 表格（表头 + 分隔行）
    if (trimmed.includes('|') && i + 1 < n) {
      const separator = lines[i + 1].trim();
      const isSeparator =
        /^\|?[\s:|-]+$/.test(separator) &&
        separator.includes('-') &&
        separator.includes('|') &&
        separator.replace(/[^|]/g, '').length >= 2;
      if (isSeparator) {
        const header = line;
        const rows = [];
        i += 2;
        while (i < n && lines[i].trim() !== '' && lines[i].includes('|')) {
          rows.push(lines[i]);
          i += 1;
        }
        renderTable(container, header, separator, rows);
        continue;
      }
    }

    // 缩进代码块
    if (indent >= 4) {
      const codeLines = [];
      while (i < n && (isBlank(lines[i]) || indentWidth(lines[i]) >= 4)) {
        codeLines.push(stripIndent(lines[i], Math.min(indentWidth(lines[i]), 4)));
        i += 1;
      }
      while (codeLines.length && codeLines[codeLines.length - 1].trim() === '') codeLines.pop();
      container.append(el('pre', { class: 'markdown-code-block' }, el('code', { text: codeLines.join('\n') })));
      continue;
    }

    // 段落：连续非块起始行，换行按硬换行处理
    const paragraphLines = [];
    while (i < n) {
      const current = lines[i];
      if (isBlank(current)) break;
      if (paragraphLines.length > 0 && startsBlock(current)) break;
      if (indentWidth(current) >= 4 && paragraphLines.length === 0) break; // 交给代码块
      paragraphLines.push(current.trim());
      i += 1;
    }
    if (paragraphLines.length === 0) {
      // 防御：不消耗则跳过该行，避免死循环
      i += 1;
      continue;
    }
    if (tightParagraph) {
      renderParagraphLines(container, paragraphLines);
    } else {
      const p = el('p');
      renderParagraphLines(p, paragraphLines);
      container.append(p);
    }
  }
}

/** 安全渲染 Markdown（先按微信规则过滤），返回一个 DOM 容器节点。 */
export function renderMarkdownPreview(markdown) {
  const root = el('div', { class: 'markdown-preview' });
  const filtered = layoutWechatText(filterWechatMarkdown(markdown));
  const lines = String(filtered ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(normalizeIndent);
  renderBlocks(root, lines, {});
  if (root.childElementCount === 0) root.append(el('p', { class: 'form-hint', text: '（模板为空）' }));
  return root;
}
