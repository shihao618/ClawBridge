/**
 * 消息记录视图：方向 Tab、分组筛选、附件/来源/状态渲染与分页。
 */

import { MESSAGE_DIRECTION_META, MESSAGE_STATUS_META, PAGE_SIZE } from '../constants.js';
import { loadErrorHandler } from '../core.js';
import { els, state } from '../state.js';
import { buildAttachmentsNode, buildGroupBadges, buildSourceBadge, emptyRow, setupTablist, updatePagination } from '../ui.js';
import { $$, apiFetch, clearNode, el, formatDateTime, formatNumber, formatRelative } from '../../common.js';
import { toCount } from '../../lib/media.js';

export function setMessageDirection(direction) {
  if (!['inbound', 'outbound'].includes(direction)) return;
  state.messages.direction = direction;
  state.messages.offset = 0;
  for (const button of $$('button[data-direction]', els.messagesTabs)) {
    const active = button.dataset.direction === direction;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.tabIndex = active ? 0 : -1;
  }
  // 两个方向 Tab 共用同一内容面板：把 tabpanel 的 aria-labelledby 指向当前 Tab。
  if (els.messagesPanel) {
    els.messagesPanel.setAttribute('aria-labelledby', `messages-tab-${direction}`);
  }
  loadMessages().catch(loadErrorHandler('加载消息记录失败'));
}

export async function loadMessages() {
  initMessagesView();
  const params = new URLSearchParams();
  params.set('direction', state.messages.direction);
  if (state.messages.groupId) params.set('groupId', state.messages.groupId);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(state.messages.offset));
  const data = await apiFetch(`/api/admin/messages?${params.toString()}`);
  state.messages.total = toCount(data && data.total);
  state.messages.items = data && Array.isArray(data.items) ? data.items : [];
  renderMessages();
}

function renderMessages() {
  const { items, total, offset } = state.messages;
  els.messagesTotal.textContent = `共 ${formatNumber(total)} 条`;
  clearNode(els.messagesTableBody);
  if (items.length === 0) {
    els.messagesTableBody.append(
      emptyRow(6, state.messages.direction === 'inbound' ? '暂无入站消息' : '暂无出站消息'),
    );
  } else {
    for (const message of items) els.messagesTableBody.append(buildMessageRow(message));
  }
  updatePagination(els.messagesPrev, els.messagesNext, els.messagesPageInfo, total, offset);
}

/** 消息记录里的用户分组徽章：优先用用户列表缓存；按分组筛选时至少展示筛选分组。 */
function resolveMessageGroups(message) {
  const userId = typeof message.userId === 'string' ? message.userId : '';
  const selectedGroup = state.messages.groupId
    ? state.groups.find((group) => group.id === state.messages.groupId)
    : null;
  const cached = state.userGroupMap.get(userId);
  if (Array.isArray(cached) && cached.length > 0) {
    if (selectedGroup && !cached.some((group) => group.id === selectedGroup.id)) {
      return [selectedGroup, ...cached];
    }
    return cached;
  }
  return selectedGroup ? [selectedGroup] : [];
}

function buildMessageUserCell(message) {
  const cell = el(
    'td',
    {},
    el('div', { class: 'cell-strong', text: message.displayName || '—' }),
    el('div', { class: 'cell-muted cell-mono', text: message.userId || '—' }),
  );
  const badges = buildGroupBadges(resolveMessageGroups(message), 2);
  if (badges) cell.append(badges);
  return cell;
}

function buildMessageRow(message) {
  const direction = MESSAGE_DIRECTION_META[message.direction] || {
    label: message.direction || '—',
    className: 'badge-muted',
  };
  const status = MESSAGE_STATUS_META[message.status] || {
    label: message.status || '—',
    className: 'badge-muted',
  };
  const text = typeof message.text === 'string' ? message.text : '';
  const attachmentsNode = buildAttachmentsNode(message.attachments);

  const textCell = el('td', { class: 'cell-text' });
  if (text) {
    const line = el('div', { class: 'cell-text-line', text });
    line.title = text;
    textCell.append(line);
  } else if (!attachmentsNode) {
    textCell.append(el('div', { class: 'cell-text-line', text: '—' }));
  }
  if (attachmentsNode) {
    textCell.classList.add('cell-has-media');
    textCell.append(attachmentsNode);
  }

  const directionCell = el(
    'td',
    { class: 'cell-direction' },
    el('span', { class: `badge ${direction.className}`, text: direction.label }),
  );
  const sourceBadge = buildSourceBadge(message);
  if (sourceBadge) directionCell.append(el('div', { class: 'source-row' }, sourceBadge));

  return el(
    'tr',
    {},
    el(
      'td',
      { class: 'cell-nowrap' },
      el('div', { text: formatDateTime(message.createdAt) }),
      el('div', { class: 'cell-muted', text: formatRelative(message.createdAt) }),
    ),
    directionCell,
    buildMessageUserCell(message),
    textCell,
    el('td', {}, el('span', { class: `badge ${status.className}`, text: status.label })),
    el('td', {
      class: 'cell-error',
      text: message.error ? String(message.error) : '—',
    }),
  );
}

/** 消息记录视图事件绑定（首次进入该视图时加载，幂等）。 */
let messagesViewBound = false;
export function initMessagesView() {
  if (messagesViewBound) return;
  messagesViewBound = true;
  els.messagesPrev.addEventListener('click', () => {
    if (state.messages.offset <= 0) return;
    state.messages.offset = Math.max(0, state.messages.offset - PAGE_SIZE);
    loadMessages().catch(loadErrorHandler('加载消息记录失败'));
  });
  els.messagesNext.addEventListener('click', () => {
    if (state.messages.offset + PAGE_SIZE >= state.messages.total) return;
    state.messages.offset += PAGE_SIZE;
    loadMessages().catch(loadErrorHandler('加载消息记录失败'));
  });
  els.messagesGroupFilter.addEventListener('change', () => {
    state.messages.groupId = els.messagesGroupFilter.value || '';
    state.messages.offset = 0;
    loadMessages().catch(loadErrorHandler('加载消息记录失败'));
  });
  // 消息方向 Tab：点击 + 方向键/Home/End（roving tabindex，）。
  setupTablist({
    tablist: els.messagesTabs,
    tabSelector: 'button[data-direction]',
    getValue: (tab) => tab.dataset.direction,
    onChange: setMessageDirection,
  });
}
