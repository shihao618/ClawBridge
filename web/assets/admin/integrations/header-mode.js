/**
 * 规则编辑器 / 定时任务编辑器共用的 Header 处理模块（F-04）。
 *
 * 两套编辑器在此处的 DOM 结构、文案、掩码/重设/清空行为与提交校验 100% 一致，
 * 仅 id 前缀与实体称谓（「规则」/「任务」）不同；本模块收敛后由两个编辑器直接调用。
 */
import { el } from '../../common.js';
import { parseHeadersInput } from '../../lib/parse.js';
import { buildHeaderListField } from '../ui.js';

/**
 * 创建 Header 模式字段与提交读取器。
 *
 * @param {object} options
 * @param {string} options.prefix 元素 id / radio name 前缀（'rule' | 'schedule'）
 * @param {boolean} options.isEdit 是否编辑已有实体
 * @param {string[]} options.headerNames 已保存的 Header 名称（值不回显）
 * @param {string} options.entityLabel 实体称谓（'规则' | '任务'），用于提示文案
 * @param {boolean} [options.hiddenLabelClass] 非编辑态 label 是否附加 is-hidden class（规则侧行为）
 * @returns {object}
 */
export function createHeaderModeField({ prefix, isEdit, headerNames, entityLabel, hiddenLabelClass = false }) {
  const hasSavedHeaders = isEdit && headerNames.length > 0;
  const headerNamesText = headerNames.map((name) => `${name}: ••••••`).join('\n');
  const headerResetText = headerNames.map((name) => `${name}: `).join('\n');
  const headersTextarea = el('textarea', {
    id: `${prefix}-headers`,
    class: 'textarea',
    rows: '3',
    placeholder: '每行一个 Header，格式：Name: Value\n例如：Authorization: Bearer xxx',
    value: headerNamesText,
  });
  let headerModeValue = hasSavedHeaders ? 'keep' : 'replace';
  const headerHintNode = el('p', { class: 'form-hint' });

  function syncHeaderHint() {
    let hint = '每行一个 Header，格式 Name: Value；值会加密保存，保存后不再回显。';
    if (hasSavedHeaders) {
      if (headerModeValue === 'keep') {
        hint = '已保存的 Header 值不会回显（AES 加密存储）；如需修改，请选择「重设 Header」，保留名称并补全新值。';
      } else if (headerModeValue === 'replace') {
        hint = `已保留 Header 名称并清除原值，请补全对应的值；保存后将全量替换该${entityLabel}现有 Header。`;
      } else {
        hint = `保存后将清空该${entityLabel}的所有 Header。`;
      }
    }
    headerHintNode.textContent = hint;
  }

  function syncHeaderModeUi() {
    headersTextarea.disabled = headerModeValue !== 'replace';
    if (headerModeValue === 'keep') headersTextarea.value = headerNamesText;
    else if (headerModeValue === 'replace') headersTextarea.value = headerResetText;
    else headersTextarea.value = '';
    syncHeaderHint();
  }

  const headerModeRadios = ['keep', 'replace', 'clear'].map((mode) => {
    const label = mode === 'keep' ? '保留现有 Header' : mode === 'replace' ? '重设 Header' : '清空 Header';
    const hidden = !hasSavedHeaders;
    return el(
      'label',
      { class: `radio-inline${hiddenLabelClass && hidden ? ' is-hidden' : ''}`, hidden },
      el('input', { type: 'radio', name: `${prefix}-header-mode`, value: mode, checked: mode === headerModeValue }),
      el('span', { text: label }),
    );
  });
  for (const label of headerModeRadios) {
    label.querySelector('input').addEventListener('change', (event) => {
      headerModeValue = event.target.value;
      syncHeaderModeUi();
    });
  }
  syncHeaderModeUi();

  const modeField = hasSavedHeaders
    ? el(
        'div',
        { class: 'form-field form-field--full' },
        el('span', { class: 'form-label', text: 'Header 处理' }),
        el('div', { class: 'radio-list rule-radio-row' }, ...headerModeRadios),
      )
    : null;
  const listField = buildHeaderListField({ id: `${prefix}-headers`, textarea: headersTextarea, hintNode: headerHintNode });

  /**
   * 读取提交时的 Header payload（与拆分前逐分支一致）。
   * @returns {{ headers?: Record<string,string>, error?: string }}
   *   headers 为 undefined 表示不修改；{} 表示清空；对象表示全量替换。
   */
  function readHeaderPayload() {
    if (!hasSavedHeaders) {
      const headers = parseHeadersInput(headersTextarea.value);
      return { headers: Object.keys(headers).length > 0 ? headers : undefined };
    }
    if (headerModeValue === 'keep') return { headers: undefined };
    if (headerModeValue === 'clear') return { headers: {} };
    const headers = parseHeadersInput(headersTextarea.value);
    if (Object.keys(headers).length === 0) {
      return { error: '重设 Header 时请至少保留一个 Header；如需全部删除，请选择「清空 Header」' };
    }
    if (Object.values(headers).some((value) => value === '')) {
      return { error: '请补全每个 Header 的值；如需全部删除，请选择「清空 Header」' };
    }
    return { headers };
  }

  return {
    textarea: headersTextarea,
    hintNode: headerHintNode,
    radios: headerModeRadios,
    modeField,
    listField,
    readHeaderPayload,
    syncHeaderModeUi,
    getMode: () => headerModeValue,
  };
}
