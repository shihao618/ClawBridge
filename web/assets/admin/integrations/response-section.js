/**
 * 规则编辑器 / 定时任务编辑器共用的响应解析输入区（F-04）。
 *
 * 响应类型 / JSON 路径 / 回复模板 / 兜底文案 / 超时输入框的结构与 id 规则一致，
 * 仅 id 前缀与 placeholder 文案不同，由调用方传入。
 */
import { el, setHidden } from '../../common.js';
import { formField } from '../ui.js';

/**
 * 创建响应解析相关输入控件。
 *
 * @param {object} options
 * @param {string} options.prefix 元素 id 前缀（'rule' | 'schedule'）
 * @param {object} options.response 现有 response 配置
 * @param {object} options.limits 现有 limits 配置
 * @param {string} options.pathPlaceholder JSON 路径输入 placeholder
 * @param {string} options.templatePlaceholder 模板输入 placeholder
 * @param {string} options.fallbackPlaceholder 兜底文案 placeholder
 * @returns {object}
 */
export function createResponseInputs({ prefix, response, limits, pathPlaceholder, templatePlaceholder, fallbackPlaceholder }) {
  const responseTypeSelect = el(
    'select',
    { id: `${prefix}-response-type`, class: 'select' },
    ...['json', 'text'].map((type) =>
      el('option', { value: type, text: type === 'json' ? 'JSON' : '文本', selected: (response.type || 'json') === type }),
    ),
  );
  const responsePathInput = el('input', {
    id: `${prefix}-response-path`,
    class: 'input',
    type: 'text',
    placeholder: pathPlaceholder,
    value: response.path || '',
  });
  const replyTemplateInput = el('textarea', {
    id: `${prefix}-reply-template`,
    class: 'textarea',
    rows: '2',
    placeholder: templatePlaceholder,
    value: response.template || '',
  });
  const fallbackInput = el('input', {
    id: `${prefix}-fallback`,
    class: 'input',
    type: 'text',
    placeholder: fallbackPlaceholder,
    value: response.fallbackText || '',
  });
  const timeoutInput = el('input', {
    id: `${prefix}-timeout`,
    class: 'input input-narrow',
    type: 'number',
    min: '1000',
    max: '30000',
    step: '500',
    value: String(Number(limits.timeoutMs) || 8000),
  });
  return { responseTypeSelect, responsePathInput, replyTemplateInput, fallbackInput, timeoutInput };
}

/**
 * 创建请求 Body 模板字段（POST 显示 / GET 隐藏），规则与定时任务编辑器共用。
 *
 * @param {object} options
 * @param {string} options.prefix 元素 id 前缀
 * @param {object} options.request 现有 request 配置
 * @param {string} options.placeholder 输入框 placeholder
 * @param {HTMLElement} options.methodSelect 请求方法 select（用于联动显隐）
 * @returns {{ input: HTMLElement, field: HTMLElement, sync: () => void }}
 */
export function createBodyTemplateField({ prefix, request, placeholder, methodSelect }) {
  const input = el('textarea', {
    id: `${prefix}-body`,
    class: 'textarea',
    rows: '3',
    placeholder,
    value: request.bodyTemplate || '',
  });
  const bodyField = formField('Body 模板（POST）', input, null, `${prefix}-body`, { span: 3 });
  function sync() {
    setHidden(bodyField, methodSelect.value !== 'POST');
  }
  return { input, field: bodyField, sync };
}
