/**
 * 规则运行日志 / 定时任务运行日志共用的弹窗骨架（F-04）。
 *
 * 两套日志弹窗的差异仅为：接口/查询参数、表格列、行渲染、筛选控件（定时任务多一个任务下拉），
 * 加载中/空态/错误态、分页与关闭动作完全一致。
 */
import { apiFetch, clearNode, el, toastError } from '../../common.js';
import { toCount } from '../../lib/media.js';
import { PAGE_SIZE } from '../constants.js';
import { openTrackedModal, updatePagination } from '../ui.js';

/**
 * 打开运行日志弹窗。
 *
 * @param {object} options
 * @param {string} options.title 弹窗标题
 * @param {string} options.className 外层容器 class（rule-logs / schedule-logs）
 * @param {string[]} options.columns 表头文案（列数用于 loading/empty/error 的 colspan）
 * @param {{ tbody:string, pageInfo:string, prev:string, next:string, statusSelect:string }} options.ids
 * @param {string} options.hintText 工具栏右侧说明文案
 * @param {Array<[string,string]>} options.statusOptions 状态筛选项
 * @param {(log:object, statusSelect:HTMLElement) => HTMLElement} options.renderRow 行渲染（自行按状态取 meta）
 * @param {() => URLSearchParams} options.paramsFor 搜索参数构造
 * @param {string} options.endpoint 日志接口路径
 * @param {(ctx:{local:object, reload:Function}) => Array<Node>} [options.buildToolbarNodes] 额外工具栏节点（任务下拉等）
 * @param {Record<string, string>} [options.initialExtra] 额外查询状态初始值（如 taskId）
 * @param {string} options.errorFallback 加载失败 toast 文案
 * @param {string} [options.emptyText] 空态文案
 * @returns {object} openTrackedModal 返回的 modal api
 */
export function openLogsModal({
  title,
  className,
  columns,
  ids,
  hintText,
  statusOptions,
  renderRow,
  paramsFor,
  endpoint,
  buildToolbarNodes = null,
  initialExtra = {},
  errorFallback,
  emptyText = '暂无运行日志',
}) {
  const local = { status: '', offset: 0, limit: PAGE_SIZE, total: 0, ...initialExtra };

  const statusSelect = el(
    'select',
    { id: ids.statusSelect, class: 'select' },
    ...statusOptions.map(([value, label]) => el('option', { value, text: label })),
  );
  const tbody = el('tbody', { id: ids.tbody });
  const pageInfo = el('span', { id: ids.pageInfo, class: 'pagination-info', text: '第 1 / 1 页' });
  const prevButton = el('button', { id: ids.prev, class: 'btn btn-secondary btn-sm', type: 'button', text: '上一页' });
  const nextButton = el('button', { id: ids.next, class: 'btn btn-secondary btn-sm', type: 'button', text: '下一页' });

  const toolbarNodes = [];
  if (typeof buildToolbarNodes === 'function') {
    toolbarNodes.push(...buildToolbarNodes({ local, reload: () => void load() }));
  }
  toolbarNodes.push(statusSelect, el('span', { class: 'form-hint', text: hintText }));

  function appendStateRow(text, classNameForSpan) {
    tbody.append(
      el(
        'tr',
        {},
        el('td', { class: 'empty-cell', colspan: String(columns.length) }, el('span', { class: classNameForSpan, text })),
      ),
    );
  }

  async function load() {
    clearNode(tbody);
    appendStateRow('加载中…', 'empty-text');
    try {
      const params = paramsFor(local);
      const data = await apiFetch(`${endpoint}?${params.toString()}`);
      local.total = toCount(data && data.total);
      const items = data && Array.isArray(data.items) ? data.items : [];
      clearNode(tbody);
      if (items.length === 0) {
        appendStateRow(emptyText, 'empty-text');
      } else {
        for (const log of items) tbody.append(renderRow(log, statusSelect));
      }
      updatePagination(prevButton, nextButton, pageInfo, local.total, local.offset);
    } catch (error) {
      clearNode(tbody);
      appendStateRow(error && error.message ? error.message : '加载日志失败', 'inline-error');
      if (error && error.status !== 401) toastError(error, errorFallback);
    }
  }

  statusSelect.addEventListener('change', () => {
    local.status = statusSelect.value;
    local.offset = 0;
    void load();
  });
  prevButton.addEventListener('click', () => {
    if (local.offset <= 0) return;
    local.offset = Math.max(0, local.offset - local.limit);
    void load();
  });
  nextButton.addEventListener('click', () => {
    if (local.offset + local.limit >= local.total) return;
    local.offset += local.limit;
    void load();
  });

  const body = el(
    'div',
    { class: className },
    el('div', { class: 'toolbar toolbar-slim' }, ...toolbarNodes),
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data-table data-table-logs' },
        el('thead', {}, el('tr', {}, ...columns.map((label) => el('th', { scope: 'col', text: label })))),
        tbody,
      ),
    ),
    el('div', { class: 'pagination' }, prevButton, pageInfo, nextButton),
  );

  const modal = openTrackedModal({
    title,
    size: 'wide',
    content: [body],
    actions: [{ label: '关闭', class: 'btn btn-secondary' }],
  });
  void load();
  return modal;
}
