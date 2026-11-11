/**
 * ClawBridge 管理后台模板工具：模板语法帮助、模板/Markdown 离线预览。
 *
 * 规则回复与定时通知共用同一套模板语法说明与预览入口。
 */

import { apiFetch, el } from '../common.js';
import { formField, openTrackedModal } from './ui.js';
import { renderMarkdownPreview } from './markdown-preview.js';
import { describeWechatMarkdownAdjustments } from '../lib/wechat-markdown.js';

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
        'Markdown 格式（与微信渲染规则一致）',
        el('ul', { class: 'template-help-list' },
          item('微信会渲染：标题 H1–H4 ', inline('# 标题'), '、粗体 ', inline('**粗体**'), '、非中文斜体 ', inline('*italic*'), '、删除线 ', inline('~~删除~~'), '、行内代码、代码块、表格、水平线、引用、有序/无序列表。'),
          item('列表支持有序/无序，并可用缩进嵌套子列表（预览按缩进渲染层级）：', code('- 一级\n  - 二级\n    1. 三级')),
          item('引用用 ', inline('>'), ' 开头（可多行）；代码块用三反引号（可标语言），行内代码用反引号；表格用 ', inline('| 列 | 列 |'), ' 且第二行写对齐（', inline(':--'), ' / ', inline(':-:'), ' / ', inline('--:'), '）。'),
          item('微信不渲染、发送前会自动处理：中文斜体（如 ', inline('*中文*'), ' 去星号保留文字）、H5/H6 标题（去 # 保留文字）、Markdown 图片（整段移除）。'),
          item('裸 URL（如 https 开头）微信会自动识别为链接；用尖括号包裹的 URL 按原文显示、不会自动识别。'),
          item('换行直接按 Enter；普通文本行之间会补最小必要空行（列表项之间不补），方便微信逐行显示。列表/表格/代码块按 Markdown 原样渲染。'),
          item('Markdown 与模板变量可混用，例如 ', inline('- {{name}}：{{count rows}} 条'), '。预览不替换模板变量，最终文案请用「模板预览」。'),
          item('不回复（静默）：在模板中输出 ', inline('{{noreply}}'), '（通常放在 ', inline('{{#if}}'), ' 的空数据分支），例如 ', inline('{{#if rows}}有数据{{else}}{{noreply}}{{/if}}'), '；命中时不发送任何消息，也**不会使用兜底文案**。'),
        ),
        code('# 今日天气\n\n**有雨城市**：{{count rows where weather=雨}} 个\n- {{#each rows where weather=雨}}{{@number}}. {{city}}{{/each}}'),
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
        '用户凭据（{credential:名称.字段}）',
        el('ul', { class: 'template-help-list' },
          item('规则请求的 URL / Header / Body 可用 ', inline('{credential:凭据名.字段}'), ' 引用「触发该消息的用户」在「用户管理 → 密钥」中配置的凭据；实际值（含 URL 编码形式）在日志/预览/错误中会统一脱敏为 ', inline('***'), '。'),
          item('定时通知默认按汇总模式执行；开启「按目标用户分别请求（使用各自凭据）」后，请求模板才会按每个目标用户各自的凭据分别解析。'),
          item('按用户模式下通知模板可使用 ', inline('{{userName}}'), '（目标用户昵称）与 ', inline('{{userId}}'), '；缺少所需凭据的用户会被跳过，单个用户失败只影响该用户，整体状态可能为「部分成功」。'),
          item('凭据值只写不读：管理后台只显示掩码提示，不会回显明文；编辑凭据时需重新输入全部字段值。'),
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
        code('{{#if weather.rain}}\n出门带伞：{{city}} 有雨\n{{else if weather.temperature>30}}\n注意防暑：{{city}} {{weather.temperature}}℃\n{{else}}\n天气不错：{{city}} {{weather.text}}\n{{/if}}'),
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

function openMarkdownPreviewModal({ getText, title = 'Markdown 预览' } = {}) {
  const text = typeof getText === 'function' ? String(getText() ?? '') : '';
  const preview = renderMarkdownPreview(text);
  const adjustments = describeWechatMarkdownAdjustments(text);
  const notes = [];
  if (adjustments.cjkItalic > 0) notes.push(`中文斜体 ${adjustments.cjkItalic} 处（已去 * / _ 标记）`);
  if (adjustments.h5h6 > 0) notes.push(`H5/H6 标题 ${adjustments.h5h6} 处（已去 # 标记）`);
  if (adjustments.images > 0) notes.push(`图片 ${adjustments.images} 处（微信不渲染，发送时已移除）`);
  const ruleLine = notes.length > 0
    ? `已按微信渲染规则处理：${notes.join('；')}。`
    : '已按微信渲染规则预览（代码块/表格/引用/列表/标题 H1–H4/粗体/非中文斜体/删除线会保留）。';
  openTrackedModal({
    title,
    size: 'wide',
    content: [
      el('p', { class: 'form-hint', text: '以下为本地 Markdown 预览，不会发送消息；预览与发送前使用同一套微信兼容规则（官方插件 StreamingMarkdownFilter）。尖括号包裹的 URL 按原文显示、裸 URL 微信会自动识别；模板变量 {{…}} 不会在此处替换，如需查看替换后的最终文案请用「模板预览」。' }),
      el('p', { class: 'form-hint', text: ruleLine }),
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
            if (data.noreply) {
              resultBox.textContent = '（不回复：不会发送任何消息，也不会使用兜底文案）';
              statusLine.textContent = '模板命中「不回复」分支 {{noreply}}；未访问外部接口。';
            } else {
              resultBox.textContent = data.replyText || '（渲染结果为空）';
              statusLine.textContent = data.usedFallback
                ? '模板结果为空，已使用兜底文案；未访问外部接口。'
                : `预览完成${data.responseText ? `（解析值：${String(data.responseText).slice(0, 200)}）` : ''}；未访问外部接口。`;
            }
          } catch (error) {
            resultBox.hidden = false;
            resultBox.textContent = error && error.message ? error.message : '模板预览失败';
          }
        },
      },
    ],
  });
}
