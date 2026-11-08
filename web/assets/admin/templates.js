/**
 * ClawBridge 管理后台模板工具：模板语法帮助、模板/Markdown 离线预览。
 *
 * 规则回复与定时通知共用同一套模板语法说明与预览入口。
 */

import { apiFetch, el } from '../common.js';
import { formField, openTrackedModal } from './ui.js';

/** 新建规则 / 新建任务共用的 Markdown 模板工具栏。 */
export function buildTemplateTools({ templateInput, responseTypeSelect, responsePathInput, fallbackInput, previewTitle }) {
  return el(
    'div',
    { class: 'template-tools' },
    buildTemplateSyntaxHelpButton(),
    buildMarkdownPreviewButton(() => templateInput.value, 'Markdown 预览'),
    buildTemplatePreviewButton(
      () => ({
        responseType: responseTypeSelect.value,
        responsePath: responsePathInput.value.trim(),
        template: templateInput.value,
        fallbackText: fallbackInput.value,
      }),
      previewTitle,
    ),
  );
}

function buildTemplateSyntaxHelpButton() {
  const button = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '模板语法' });
  button.addEventListener('click', openTemplateSyntaxHelpModal);
  return button;
}

/** 规则/定时共用的模板语法说明（结构化，避免把长说明塞进输入框提示）。 */
function openTemplateSyntaxHelpModal() {
  const inline = (text) => el('code', { class: 'template-help-inline', text });
  const code = (text) => el('pre', { class: 'template-help-code', text });
  const item = (...children) => el('li', {}, ...children);
  const section = (title, ...children) =>
    el('section', { class: 'template-help-section' }, el('h4', { class: 'template-help-title', text: title }), ...children);

  openTrackedModal({
    title: '模板语法',
    size: 'wide',
    content: [
      el('p', { class: 'form-hint', text: '规则回复与定时通知共用同一套模板语法；模板为空时直接使用解析结果。回复模板按 Markdown 发送。' }),
      section(
        'Markdown 格式',
        el('ul', { class: 'template-help-list' },
          item('微信客户端会渲染部分 Markdown：标题 ', inline('# 标题'), '、粗体 ', inline('**粗体**'), '、列表 ', inline('- 项目'), '、代码块、表格、引用。'),
          item('换行直接按 Enter；单行换行会自动补 Markdown hard break，避免被客户端压成空格。'),
          item('Markdown 与模板变量可混用，例如 ', inline('- {{name}}：{{count rows}} 条'), '。'),
          item('不支持 Markdown 图片/链接卡片；链接会按文字显示。'),
        ),
        code('# 今日归寝\n\n**未归寝**：{{count rows where CQZT=1}} 人\n- {{#each rows where CQZT=1}}{{@number}}. {{XSXM}}{{/each}}'),
      ),
      section(
        '变量与模板根',
        el('ul', { class: 'template-help-list' },
          item(inline('{{data.answer}}'), '：按当前模板根的点路径取值。'),
          item(inline('{{reply}}'), '：响应中的 reply 字段（空路径时解析器优先使用）。'),
          item(inline('{{response}}'), '：当前解析结果文本；', inline('{{raw}}'), '：原始响应文本。'),
          item('JSON 路径选中节点后，模板根即该节点：路径 ', inline('data.list'), ' 时写 ', inline('{{count .}}'), ' / ', inline('{{#each .}}'), '；空路径时才写 ', inline('{{data.list}}'), '。'),
        ),
      ),
      section(
        '循环与作用域',
        el('ul', { class: 'template-help-list' },
          item(inline('{{#each 路径}}...{{/each}}'), '：逐项渲染；当前项字段直接写 ', inline('{{字段}}'), '，序号用 ', inline('{{@index}}'), '（从 0）和 ', inline('{{@number}}'), '（从 1）。'),
          item('空列表分支：', inline('{{#each 路径}}...{{else}}暂无数据{{/each}}'), '。'),
          item('支持多层嵌套：父级用 ', inline('{{../字段}}'), '、', inline('{{../@index}}'), '；模板根用 ', inline('{{@root.字段}}'), '；完整响应根用 ', inline('{{@responseRoot.字段}}'), '。'),
        ),
      ),
      section(
        '列表过滤',
        el('ul', { class: 'template-help-list' },
          item('循环过滤：', inline('{{#each 路径 where 字段=值}}...{{/each}}'), '；支持 ', inline('where 字段!=值'), '，值可加引号。'),
          item('计数过滤：', inline('{{count 路径 where 字段=值}}'), '。'),
        ),
      ),
      section(
        '条件判断',
        el('ul', { class: 'template-help-list' },
          item('语法：', inline('{{#if 条件}}...{{else if 条件}}...{{else}}...{{/if}}'), '、', inline('{{#unless 条件}}...{{/unless}}'), '。'),
          item('条件支持真值判断及 ', inline('='), ' / ', inline('!='), ' / ', inline('>'), ' / ', inline('>='), ' / ', inline('<'), ' / ', inline('<='), ' 比较；左侧可为字段或 ', inline('count 路径'), '。'),
          item('组合条件：', inline('not 条件'), '、', inline('条件A and 条件B'), '、', inline('条件A or 条件B'), '。'),
        ),
        code('{{#if checks.inRange=false}}\n不在打卡范围：{{location.distance}} 米\n{{else if submitted=true}}\n状态：{{after.status}}\n{{else}}\n提示：{{reason}}\n{{/if}}'),
      ),
      section(
        '默认值',
        el('ul', { class: 'template-help-list' },
          item(inline('{{default 路径 "兜底文案"}}'), '：值为空/null/空串/空数组时输出兜底文案。'),
        ),
      ),
    ],
    actions: [{ label: '关闭', class: 'btn btn-secondary' }],
  });
}

function buildTemplatePreviewButton(getValues, title = '模板预览') {
  const button = el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: '预览模板' });
  button.addEventListener('click', () => openTemplatePreviewModal({ getValues, title }));
  return button;
}

function buildMarkdownPreviewButton(getText, title = 'Markdown 预览') {
  const button = el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Markdown 预览' });
  button.addEventListener('click', () => openMarkdownPreviewModal({ getText, title }));
  return button;
}

/** 安全渲染常见 Markdown（标题/粗体/斜体/列表/代码/引用/表格），全部走 textContent。 */
function renderMarkdownPreview(markdown) {
  const root = el('div', { class: 'markdown-preview' });
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let list = null;
  const closeList = () => {
    if (list) {
      root.append(list);
      list = null;
    }
  };
  const inline = (target, text) => {
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]*\))/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) target.append(text.slice(last, match.index));
      const token = match[1];
      if (token.startsWith('`')) target.append(el('code', { class: 'markdown-inline-code', text: token.slice(1, -1) }));
      else if (token.startsWith('**')) target.append(el('strong', { text: token.slice(2, -2) }));
      else if (token.startsWith('*')) target.append(el('em', { text: token.slice(1, -1) }));
      else {
        const link = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(token);
        target.append(link ? el('span', { class: 'markdown-link', text: link[1], title: link[2] }) : token);
      }
      last = match.index + token.length;
    }
    if (last < text.length) target.append(text.slice(last));
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      closeList();
      i += 1;
      continue;
    }
    if (/^```/.test(trimmed)) {
      closeList();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1;
      root.append(el('pre', { class: 'markdown-code-block' }, el('code', { text: codeLines.join('\n') })));
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length);
      root.append(el(`h${level}`, { class: 'markdown-heading', text: heading[2] }));
      i += 1;
      continue;
    }
    if (trimmed === '---' || trimmed === '***') {
      closeList();
      root.append(el('hr'));
      i += 1;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      closeList();
      const p = el('p');
      inline(p, quote[1]);
      root.append(el('blockquote', {}, p));
      i += 1;
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const tag = ordered ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) {
        closeList();
        list = el(tag, { class: 'markdown-list' });
      }
      const li = el('li');
      inline(li, ordered ? ordered[2] : bullet[1]);
      list.append(li);
      i += 1;
      continue;
    }
    closeList();
    // 简单表格：表头 + 分隔行 + 数据行
    if (trimmed.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
      const splitRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      const table = el('table', { class: 'markdown-table' });
      const thead = el('thead');
      const headRow = el('tr');
      for (const cell of splitRow(line)) {
        const th = el('th');
        inline(th, cell);
        headRow.append(th);
      }
      thead.append(headRow);
      table.append(thead);
      i += 2;
      const tbody = el('tbody');
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const tr = el('tr');
        for (const cell of splitRow(lines[i])) {
          const td = el('td');
          inline(td, cell);
          tr.append(td);
        }
        tbody.append(tr);
        i += 1;
      }
      table.append(tbody);
      root.append(table);
      continue;
    }
    const p = el('p');
    inline(p, trimmed);
    root.append(p);
    i += 1;
  }
  closeList();
  if (root.childElementCount === 0) root.append(el('p', { class: 'form-hint', text: '（模板为空）' }));
  return root;
}

function openMarkdownPreviewModal({ getText, title = 'Markdown 预览' } = {}) {
  const text = typeof getText === 'function' ? String(getText() ?? '') : '';
  const preview = renderMarkdownPreview(text);
  openTrackedModal({
    title,
    size: 'wide',
    content: [
      el('p', { class: 'form-hint', text: '以下为本地 Markdown 预览，不会发送消息；微信客户端会渲染标题、粗体、列表、代码块、表格等常见语法。' }),
      preview,
    ],
    actions: [{ label: '关闭', class: 'btn btn-secondary' }],
  });
}

/** 离线模板预览：用粘贴的示例响应调用后端真实模板引擎，不访问外部接口。 */
function openTemplatePreviewModal({ getValues, title = '模板预览' }) {
  const sampleInput = el('textarea', {
    id: 'template-preview-sample',
    class: 'textarea',
    rows: '7',
    placeholder: '粘贴接口返回的示例数据（JSON 或文本），例如：\n{"data":{"total":2,"items":[]}}',
  });
  const statusLine = el('p', { class: 'form-hint', text: '仅使用粘贴的示例数据渲染，不会调用外部接口。' });
  const resultBox = el('pre', { id: 'template-preview-result', class: 'template-preview-result', hidden: true });
  openTrackedModal({
    title,
    size: 'wide',
    content: [
      statusLine,
      formField('示例响应', sampleInput, '支持 JSON 或文本；配置的响应路径、回复模板和兜底文案会按真实规则处理。', 'template-preview-sample'),
      resultBox,
    ],
    actions: [
      { label: '关闭', class: 'btn btn-secondary' },
      {
        label: '渲染预览',
        class: 'btn btn-primary',
        closeOnClick: false,
        onClick: async () => {
          const values = (typeof getValues === 'function' ? getValues() : null) || {};
          const sample = String(sampleInput.value || '');
          if (sample.trim() === '') {
            resultBox.hidden = false;
            resultBox.textContent = '请先粘贴示例响应';
            return;
          }
          try {
            const data = await apiFetch('/api/admin/template-preview', {
              method: 'POST',
              body: {
                sample,
                responseType: values.responseType === 'text' ? 'text' : 'json',
                responsePath: values.responsePath || '',
                template: values.template || '',
                fallbackText: values.fallbackText || '',
              },
            });
            resultBox.hidden = false;
            resultBox.textContent = data.replyText || '（渲染结果为空）';
            statusLine.textContent = data.usedFallback
              ? '模板结果为空，已使用兜底文案；未访问外部接口。'
              : `预览完成${data.responseText ? `（解析值：${String(data.responseText).slice(0, 200)}）` : ''}；未访问外部接口。`;
          } catch (error) {
            resultBox.hidden = false;
            resultBox.textContent = error && error.message ? error.message : '模板预览失败';
          }
        },
      },
    ],
  });
}
