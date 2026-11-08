/**
 * ClawBridge 管理后台通用 UI 构建器：表单区块/字段、表格行/分页/空态、
 * 徽章/颜色点、附件渲染、跟踪弹窗、内联错误与剪贴板/密钥展示等。
 *
 * 只依赖 common.js / lib / constants / state，不依赖视图与 core。
 */

import { clearNode, el, formatFileSize, formatNumber, openModal, toast } from '../common.js';
import { attachmentPaths } from '../lib/media.js';
import { normalizeGroupColor } from '../lib/parse.js';
import { MEDIA_KIND_META, MESSAGE_SOURCE_META, PAGE_SIZE, UNGROUPED_FILTER } from './constants.js';
import { els, openModals, state } from './state.js';

export function buildColorDot(color, className = 'group-dot') {
  const dot = el('span', { class: className, 'aria-hidden': 'true' });
  dot.style.backgroundColor = normalizeGroupColor(color) || 'var(--wechat-green)';
  return dot;
}

/** 用户/消息上的分组徽章：最多 max 个，其余显示 +N。 */
export function buildGroupBadges(groups, max = 3) {
  const list = Array.isArray(groups) ? groups.filter((group) => group && typeof group === 'object') : [];
  if (list.length === 0) return null;
  const wrap = el('div', { class: 'group-badges' });
  for (const group of list.slice(0, max)) {
    const name = typeof group.name === 'string' && group.name ? group.name : '分组';
    wrap.append(
      el(
        'span',
        { class: 'group-badge', title: name },
        buildColorDot(group.color, 'group-dot group-dot-sm'),
        el('span', { class: 'group-badge-name', text: name }),
      ),
    );
  }
  if (list.length > max) {
    wrap.append(el('span', { class: 'group-badge group-badge-more', text: `+${list.length - max}` }));
  }
  return wrap;
}

/** 分组是否开启「分组保活」（group.keepaliveEnabled；兼容 0/1 数字表示）。 */
export function isGroupKeepaliveEnabled(group) {
  if (!group) return false;
  return group.keepaliveEnabled === true || group.keepaliveEnabled === 1;
}

export function updateGroupFilterOptions() {
  fillGroupFilter(els.userGroupFilter, state.users.groupId, true);
  fillGroupFilter(els.messagesGroupFilter, state.messages.groupId, false);
}

function fillGroupFilter(select, currentValue, includeUngrouped) {
  if (!select) return;
  clearNode(select);
  select.append(el('option', { value: '', text: '全部分组' }));
  if (includeUngrouped) select.append(el('option', { value: UNGROUPED_FILTER, text: '未分组' }));
  for (const group of state.groups) {
    const name = typeof group.name === 'string' && group.name ? group.name : group.id;
    select.append(el('option', { value: group.id, text: name }));
  }
  const values = new Set([...select.options].map((option) => option.value));
  const nextValue = values.has(currentValue) ? currentValue : '';
  select.value = nextValue;
  if (select === els.userGroupFilter) state.users.groupId = nextValue;
  if (select === els.messagesGroupFilter) state.messages.groupId = nextValue;
}

export function formSection(title, hint, ...children) {
  return el(
    'div',
    { class: 'rule-form-section' },
    el('h4', { class: 'rule-form-title', text: title }),
    hint ? el('p', { class: 'form-hint', text: hint }) : null,
    ...children,
  );
}

export function formField(label, control, hint, htmlFor, { span = 1, className = '' } = {}) {
  const spanClass = span >= 3 ? 'form-field--full' : span === 2 ? 'form-field--wide' : '';
  return el(
    'div',
    { class: `form-field${spanClass ? ` ${spanClass}` : ''}${className ? ` ${className}` : ''}` },
    label ? el('label', { class: 'form-label', for: htmlFor || undefined, text: label }) : null,
    control,
    hint ? el('p', { class: 'form-hint', text: hint }) : null,
  );
}

/** 新建规则 / 新建任务共用的「请求方法 + URL」行。 */
export function buildRequestRow({
  prefix,
  methodSelect,
  urlInput,
  urlLabel = '请求 URL（http/https）',
  urlHint = null,
}) {
  return el(
    'div',
    { class: 'rule-form-grid' },
    formField('请求方法', methodSelect, null, `${prefix}-request-method`, { span: 1 }),
    formField(urlLabel, urlInput, urlHint, `${prefix}-request-url`, { span: 2 }),
  );
}

/** 新建规则 / 新建任务共用的「响应类型 + JSON 路径」行。 */
export function buildResponseRow({
  prefix,
  responseTypeSelect,
  responsePathInput,
  pathLabel = 'JSON 路径',
  pathHint = null,
}) {
  return el(
    'div',
    { class: 'rule-form-grid' },
    formField('响应类型', responseTypeSelect, null, `${prefix}-response-type`, { span: 1 }),
    formField(pathLabel, responsePathInput, pathHint, `${prefix}-response-path`, { span: 2 }),
  );
}

/** 新建规则 / 新建任务共用的 Header 列表字段。 */
export function buildHeaderListField({ id, textarea, hintNode }) {
  return el(
    'div',
    { class: 'form-field form-field--full' },
    el('label', { class: 'form-label', for: id, text: 'Header 列表（每行 Name: Value）' }),
    textarea,
    hintNode,
  );
}

function buildAttachmentNode(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const kind = Object.hasOwn(MEDIA_KIND_META, attachment.kind) ? attachment.kind : 'file';
  const meta = MEDIA_KIND_META[kind];
  const name = typeof attachment.fileName === 'string' && attachment.fileName.trim()
    ? attachment.fileName.trim()
    : meta.label;
  const size = Number(attachment.size);
  const sizeText = Number.isFinite(size) && size > 0 ? formatFileSize(size) : '';
  const failed = attachment.status === 'failed';
  const { url, downloadUrl } = attachmentPaths(attachment);

  if (failed) {
    const reason = typeof attachment.error === 'string' && attachment.error.trim()
      ? attachment.error.trim()
      : '附件处理失败';
    return el(
      'div',
      { class: 'msg-attachment is-failed' },
      el('span', { class: 'msg-file-icon', 'aria-hidden': 'true', text: meta.icon }),
      el('span', { class: 'msg-file-name', text: `${name}（${reason}）` }),
    );
  }

  if (url && kind === 'image') {
    const link = el('a', {
      class: 'msg-thumb-link',
      href: url,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: `查看原图：${name}`,
    });
    const img = el('img', { class: 'msg-thumb', alt: name, loading: 'lazy' });
    img.src = url;
    link.append(img);
    return el('div', { class: 'msg-attachment' }, link);
  }

  if (url && kind === 'video') {
    const video = el('video', {
      class: 'msg-video',
      controls: true,
      preload: 'metadata',
      title: name,
    });
    video.src = url;
    return el(
      'div',
      { class: 'msg-attachment' },
      video,
      el('div', { class: 'msg-file-meta', text: `${meta.icon} ${name}${sizeText ? ` · ${sizeText}` : ''}` }),
    );
  }

  const row = el(
    'div',
    { class: 'msg-attachment msg-file-row' },
    el('span', { class: 'msg-file-icon', 'aria-hidden': 'true', text: meta.icon }),
    el(
      'div',
      { class: 'msg-file-info' },
      el('span', { class: 'msg-file-name', text: name }),
      el('span', { class: 'msg-file-size', text: `${meta.label}${sizeText ? ` · ${sizeText}` : ''}` }),
    ),
  );
  if (downloadUrl) {
    row.append(
      el('a', {
        class: 'btn btn-secondary btn-xs msg-file-link',
        href: downloadUrl,
        text: '下载',
        target: '_blank',
        rel: 'noopener noreferrer',
      }),
    );
  }
  return row;
}

/** 渲染消息的 attachments 数组（图片缩略图 / 视频播放器 / 文件下载）。 */
export function buildAttachmentsNode(attachments) {
  if (!Array.isArray(attachments)) return null;
  const list = attachments.filter((attachment) => attachment && typeof attachment === 'object').slice(0, 5);
  if (list.length === 0) return null;
  const wrap = el('div', { class: 'msg-attachments' });
  for (const attachment of list) {
    const node = buildAttachmentNode(attachment);
    if (node) wrap.append(node);
  }
  return wrap.childElementCount > 0 ? wrap : null;
}

/** 消息来源小标签（keepalive/broadcast/group/admin/api/system）。 */
export function buildSourceBadge(message) {
  const source = message && typeof message.source === 'string' ? message.source : '';
  if (!source) return null;
  const meta = MESSAGE_SOURCE_META[source];
  if (!meta) return el('span', { class: 'badge badge-muted badge-source', text: source });
  return el('span', { class: `badge ${meta.className} badge-source`, text: meta.label });
}

/** 一次性机密展示弹窗（新 Token / 新随机密码通用，明文仅显示一次）。 */
export function showSecretRevealModal({ title, value, warning, hint, copyLabel = '复制', copyToast = '已复制到剪贴板' }) {
  const secret = String(value || '');
  openTrackedModal({
    title,
    size: 'wide',
    content: [
      el('p', { class: 'alert alert-warning', text: warning }),
      el('pre', { class: 'token-reveal', text: secret }),
      hint ? el('p', { class: 'form-hint', text: hint }) : null,
    ],
    actions: [
      { label: '关闭', class: 'btn btn-secondary' },
      {
        label: copyLabel,
        class: 'btn btn-primary',
        closeOnClick: false,
        onClick: async () => {
          const copied = await copyTextToClipboard(secret);
          toast(copied ? copyToast : '复制失败，请手动选择文本复制', copied ? 'success' : 'warning');
        },
      },
    ],
  });
}

export function showTokenRevealModal(token, preview) {
  showSecretRevealModal({
    title: '新的 API Token（仅显示一次）',
    value: token,
    warning: '请立即复制保存：关闭本弹窗后无法再次查看该 Token；旧 Token 已立即失效。',
    hint: preview
      ? `页面之后只显示预览：${preview}；Token 以 AES 加密保存在数据库。`
      : 'Token 以 AES 加密保存在数据库，页面只显示预览。',
    copyLabel: '复制 Token',
    copyToast: 'Token 已复制到剪贴板',
  });
}

async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 回退到 execCommand */
  }
  try {
    const textarea = el('textarea', { class: 'visually-hidden-input', 'aria-hidden': 'true' });
    textarea.value = value;
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

export function appendKv(container, label, value, options = {}) {
  const text = value === undefined || value === null || value === '' ? '—' : String(value);
  const valueClass = options.tone ? `kv-value kv-value-${options.tone}` : 'kv-value';
  container.append(
    el(
      'div',
      { class: 'kv-item' },
      el('span', { class: 'kv-label', text: String(label) }),
      el('span', { class: valueClass, text }),
    ),
  );
}

export function emptyRow(colspan, text) {
  return el(
    'tr',
    {},
    el('td', { class: 'empty-cell', colspan: String(colspan) }, el('span', { class: 'empty-text', text })),
  );
}

export function updatePagination(prevButton, nextButton, infoNode, total, offset) {
  const totalPages = Math.max(1, Math.ceil((Number(total) || 0) / PAGE_SIZE));
  const currentPage = Math.min(totalPages, Math.floor((Number(offset) || 0) / PAGE_SIZE) + 1);
  infoNode.textContent = `第 ${currentPage} / ${totalPages} 页 · 共 ${formatNumber(total)} 条`;
  prevButton.disabled = currentPage <= 1;
  nextButton.disabled = currentPage >= totalPages;
}

export function openTrackedModal(options = {}) {
  const userOnClose = options.onClose;
  let modal = null;
  modal = openModal({
    ...options,
    onClose(result) {
      openModals.delete(modal);
      if (typeof userOnClose === 'function') userOnClose(result);
    },
  });
  openModals.add(modal);
  return modal;
}

export function showInlineError(node, message) {
  if (!node) return;
  node.textContent = message || '';
  node.hidden = false;
}

export function clearInlineError(node) {
  if (!node) return;
  node.textContent = '';
  node.hidden = true;
}

/* ------------------------------------------------------------------ */
/* 统一构建器：开关 / 行操作按钮 / 表格点击分发                          */
/* （拆分前各视图 4~5 份重复实现收敛到此处，DOM 结构与行为逐属性一致）   */
/* ------------------------------------------------------------------ */

/**
 * 统一 role="switch" 开关按钮（分组保活 / 用户保活 / 规则启用 / 定时任务启用 / 运行配置布尔项）。
 * @param {object} [options]
 * @param {boolean} [options.enabled]
 * @param {string} [options.ariaLabel]
 * @param {string} [options.title]
 * @param {Record<string, string>} [options.dataset]
 * @param {string} [options.id]
 * @param {string} [options.className] 额外 class 前缀（如 settings-switch）
 * @param {string} [options.onLabel]
 * @param {string} [options.offLabel]
 * @returns {HTMLElement}
 */
export function buildSwitch({
  enabled = false,
  ariaLabel = '',
  title = '',
  dataset = {},
  id = '',
  className = '',
  onLabel = '开启',
  offLabel = '关闭',
} = {}) {
  const props = {
    class: `${className ? `${className} ` : ''}switch${enabled ? ' is-on' : ''}`,
    type: 'button',
    role: 'switch',
    'aria-checked': enabled ? 'true' : 'false',
    dataset,
  };
  if (id) props.id = id;
  if (ariaLabel) props['aria-label'] = ariaLabel;
  if (title) props.title = title;
  const button = el('button', props);
  button.append(
    el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-thumb' })),
    el('span', { class: 'switch-label', text: enabled ? onLabel : offLabel }),
  );
  return button;
}

/**
 * 表格行操作按钮（原 group/rule/schedule/user 4 份实现收敛）。
 * @param {string} action data-action 值
 * @param {string} id 行实体 id
 * @param {string} label 按钮文案
 * @param {object} [options]
 * @param {string} [options.datasetKey] 行实体 id 的 dataset 键（groupId/ruleId/taskId/userId）
 * @param {string} [options.extraClass]
 * @param {boolean} [options.disabled]
 * @returns {HTMLElement}
 */
export function rowActionButton(action, id, label, { datasetKey = 'id', extraClass = '', disabled = false } = {}) {
  return el('button', {
    class: `btn btn-secondary btn-xs${extraClass ? ` ${extraClass}` : ''}`,
    type: 'button',
    text: label,
    disabled: Boolean(disabled),
    dataset: { action, [datasetKey]: id },
  });
}

/**
 * 表格点击分发器（原用户/分组/规则/定时任务 4 份实现收敛）：
 * 命中行内 button[data-action] → 定位当前域数据 → 按 action 分发；
 * 非按钮/禁用/找不到数据/无匹配动作时静默返回（与拆分前一致）。
 * @param {{ find: (button: HTMLElement) => object|undefined, actions: Record<string, (item: object, button: HTMLElement) => void> }} options
 * @returns {(event: Event) => void}
 */
export function createTableClickHandler({ find, actions }) {
  return (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const item = find(button);
    if (!item) return;
    const action = button.dataset.action;
    if (!Object.prototype.hasOwnProperty.call(actions, action)) return;
    const handler = actions[action];
    if (handler) handler(item, button);
  };
}

/**
 * 初始化 WAI-ARIA Tabs 交互（F-07）：roving tabindex + 点击激活 + 方向键/Home/End 切换。
 * 面板的 role="tabpanel"/aria-labelledby 由 HTML 静态声明，本函数只维护 tab 侧状态。
 * @param {object} options
 * @param {HTMLElement|null} options.tablist
 * @param {string} [options.tabSelector]
 * @param {(tab: HTMLElement) => string} options.getValue 从 tab 读取业务值
 * @param {(value: string) => void} options.onChange 切换后的业务回调（渲染/加载）
 */
export function setupTablist({ tablist, tabSelector = '[role="tab"]', getValue, onChange }) {
  if (!tablist) return;
  const getTabs = () => [...tablist.querySelectorAll(tabSelector)];
  const setActiveTab = (tab, { focus = false } = {}) => {
    for (const item of getTabs()) {
      const active = item === tab;
      item.tabIndex = active ? 0 : -1;
      item.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (focus && typeof tab.focus === 'function') tab.focus();
  };
  const activate = (tab, options) => {
    setActiveTab(tab, options);
    const value = getValue(tab);
    if (value) onChange(value);
  };
  const initial = getTabs().find((tab) => tab.getAttribute('aria-selected') === 'true') || getTabs()[0];
  if (initial) setActiveTab(initial);
  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest(tabSelector);
    if (!tab) return;
    activate(tab);
  });
  tablist.addEventListener('keydown', (event) => {
    const tabs = getTabs();
    if (tabs.length === 0) return;
    const current = tabs.indexOf(document.activeElement);
    let nextIndex = -1;
    if (event.key === 'ArrowRight') nextIndex = current < 0 ? 0 : (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = current < 0 ? tabs.length - 1 : (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === -1) return;
    event.preventDefault();
    activate(tabs[nextIndex], { focus: true });
  });
}
