/**
 * 用户管理视图：列表/筛选/分页、行内保活开关、用户详情与分组归属、
 * 解绑/重连/删除，以及规则/任务用户选择器数据源。
 */

import { MESSAGE_DIRECTION_META, MESSAGE_STATUS_META, PAGE_SIZE, UNGROUPED_FILTER, USER_STATUS_META } from '../constants.js';
import { loadErrorHandler, refreshAfterWrite } from '../core.js';
import { els, state } from '../state.js';
import { buildAttachmentsNode, buildColorDot, buildGroupBadges, buildSourceBadge, buildSwitch, createTableClickHandler, emptyRow, isGroupKeepaliveEnabled, openTrackedModal, rowActionButton, updateGroupFilterOptions, updatePagination } from '../ui.js';
import { apiFetch, clearNode, confirmDialog, debounce, el, formatDateTime, formatDuration, formatNumber, formatRelative, toast, toastError } from '../../common.js';
import { toCount } from '../../lib/media.js';
import { renderGroups } from './groups.js';
import { openSendMessageModal } from './send-message.js';

export async function loadPickerUsers() {
  if (Array.isArray(state.pickerUsers)) return state.pickerUsers;
  const data = await apiFetch('/api/admin/users?status=all&limit=500&offset=0');
  state.pickerUsers = data && Array.isArray(data.items) ? data.items : [];
  return state.pickerUsers;
}

async function openUserGroupsModal(user) {
  let groups = Array.isArray(state.groups) ? state.groups : [];
  let groupsLoaded = false;
  const modal = openTrackedModal({
    title: `编辑用户分组：${user.displayName || user.id}`,
    content: [el('p', { class: 'form-hint', text: '正在加载分组…' })],
    actions: [
      { label: '取消', class: 'btn btn-secondary' },
      {
        label: '保存',
        class: 'btn btn-primary',
        closeOnClick: false,
        onClick: async (modalRef) => {
          if (!groupsLoaded) {
            toast('分组列表仍在加载（或加载失败），请稍候重试，避免提交空分组', 'error');
            return;
          }
          const selected = [...modalRef.body.querySelectorAll('input[data-group-id]:checked')].map(
            (input) => input.dataset.groupId,
          );
          const previousKeepalive = user.keepaliveEnabled === true;
          const joinsKeepaliveGroup = groups.some(
            (group) => selected.includes(String(group.id)) && isGroupKeepaliveEnabled(group),
          );
          modalRef.setBusy(true);
          try {
            const data = await apiFetch(`/api/admin/users/${encodeURIComponent(user.id)}/groups`, {
              method: 'PUT',
              body: { groupIds: selected },
            });
            const responseUser = data && data.user && typeof data.user === 'object' ? data.user : null;
            const inherited = Boolean(
              (data && data.inheritedKeepalive === true) ||
                (responseUser && responseUser.keepaliveEnabled === true && !previousKeepalive) ||
                (!previousKeepalive && joinsKeepaliveGroup),
            );
            toast(inherited ? '该用户已随分组自动开启保活' : '用户分组已更新', 'success');
            modalRef.close('saved');
            // 刷新用户列表，确保行内「保活」开关状态同步（后端会随分组自动开启）
            await refreshAfterWrite({ groups: true, users: true, messages: true });
          } catch (error) {
            toastError(error, '更新用户分组失败');
          } finally {
            modalRef.setBusy(false);
          }
        },
      },
    ],
  });

  try {
    const data = await apiFetch('/api/admin/groups');
    groups = data && Array.isArray(data.items) ? data.items : [];
    groupsLoaded = true;
    state.groups = groups;
    renderGroups();
    updateGroupFilterOptions();
  } catch {
    groups = Array.isArray(state.groups) ? state.groups : [];
    groupsLoaded = false;
  }

  if (!groupsLoaded) {
    clearNode(modal.body);
    modal.body.append(
      el('p', { class: 'alert alert-error', text: '加载分组失败，请关闭弹窗后重试；为避免误清空用户分组，本次禁止保存。' }),
    );
    return;
  }

  const currentIds = new Set(
    (Array.isArray(user.groups) ? user.groups : []).map((group) => String(group.id)),
  );
  clearNode(modal.body);
  modal.body.append(
    el('p', {
      class: 'form-hint',
      text: '可多选；一个用户可属于多个分组。保存后立即生效，不影响用户绑定状态。',
    }),
  );
  if (groups.length === 0) {
    modal.body.append(
      el('p', { class: 'alert alert-warning', text: '还没有分组，请先在「用户分组」区块新建分组。' }),
    );
    return;
  }
  const list = el('div', { class: 'group-check-list', role: 'group', 'aria-label': '选择用户所属分组' });
  for (const group of groups) {
    const checkbox = el('input', {
      type: 'checkbox',
      class: 'group-check-input',
      dataset: { groupId: String(group.id) },
      checked: currentIds.has(String(group.id)),
    });
    list.append(
      el(
        'label',
        { class: 'group-check-item' },
        checkbox,
        buildColorDot(group.color),
        el(
          'span',
          { class: 'group-check-info' },
          el(
            'span',
            { class: 'group-check-name' },
            el('span', { text: group.name || group.id }),
            isGroupKeepaliveEnabled(group)
              ? el('span', {
                  class: 'group-keepalive-flag',
                  title: '该分组已开启分组保活：加入该分组的成员会自动开启保活',
                  text: '· 保活',
                })
              : null,
          ),
          el('span', {
            class: 'group-check-meta',
            text: `${formatNumber(group.activeUserCount)} / ${formatNumber(group.userCount)} 活跃·总用户${
              group.description ? ` · ${group.description}` : ''
            }`,
          }),
        ),
      ),
    );
  }
  modal.body.append(list);
}

function buildUserGroupMapFromItems(items) {
  const map = new Map();
  for (const user of items) {
    if (user && typeof user.id === 'string' && Array.isArray(user.groups)) map.set(user.id, user.groups);
  }
  state.userGroupMap = map;
}

export async function loadUsers() {
  initUsersView();
  const params = new URLSearchParams();
  params.set('status', state.users.status || 'all');
  if (state.users.q) params.set('q', state.users.q);
  const ungrouped = state.users.groupId === UNGROUPED_FILTER;
  const selectedGroupId = state.users.groupId && !ungrouped ? state.users.groupId : '';
  if (selectedGroupId) params.set('groupId', selectedGroupId);
  if (ungrouped) {
    // 契约未定义“未分组”服务端参数：最多拉取 500 位用户后客户端过滤
    params.set('limit', '500');
    params.set('offset', '0');
  } else {
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(state.users.offset));
  }
  const data = await apiFetch(`/api/admin/users?${params.toString()}`);
  if (ungrouped) {
    const all = data && Array.isArray(data.items) ? data.items : [];
    const filtered = all.filter((user) => !Array.isArray(user.groups) || user.groups.length === 0);
    state.users.total = filtered.length;
    state.users.items = filtered.slice(state.users.offset, state.users.offset + PAGE_SIZE);
    buildUserGroupMapFromItems(all);
  } else {
    state.users.total = toCount(data && data.total);
    state.users.items = data && Array.isArray(data.items) ? data.items : [];
    buildUserGroupMapFromItems(state.users.items);
  }
  renderUsers();
}

function renderUsers() {
  const { items, total, offset, q } = state.users;
  els.usersTotal.textContent =
    state.users.groupId === UNGROUPED_FILTER
      ? `共 ${formatNumber(total)} 位未分组用户（最多统计 500 位用户）`
      : `共 ${formatNumber(total)} 位用户`;
  clearNode(els.userTableBody);
  if (items.length === 0) {
    els.userTableBody.append(
      emptyRow(8, q || state.users.groupId ? '没有匹配的用户' : '暂无用户，等待用户扫码绑定'),
    );
  } else {
    for (const user of items) els.userTableBody.append(buildUserRow(user));
  }
  updatePagination(els.usersPrev, els.usersNext, els.usersPageInfo, total, offset);
}

function buildUserRow(user) {
  const status = typeof user.status === 'string' ? user.status : 'active';
  const statusMeta = USER_STATUS_META[status] || { label: status || '未知', className: 'badge-muted' };

  // 昵称行：昵称 + 分组标签（分组标签紧跟昵称之后）
  const nameRow = el('div', { class: 'user-name-row' }, el('span', {
    class: 'cell-strong',
    text: user.displayName || '（未命名）',
  }));
  const groupBadges = buildGroupBadges(user.groups, 3);
  if (groupBadges) nameRow.append(groupBadges);

  // 列表只显示昵称 + 分组标签；用户 id / 微信 id 属于明细信息，在「详情」中查看
  const userCell = el('td', {}, nameRow);

  const statusChildren = [
    el('span', { class: `badge ${statusMeta.className}`, text: statusMeta.label }),
    el('span', {
      class: `badge badge-soft ${user.hasContextToken ? 'badge-success' : 'badge-muted'}`,
      text: user.hasContextToken ? '可推送' : '待首条消息',
    }),
  ];
  if (status === 'paused' && user.pauseUntil) {
    statusChildren.push(el('div', { class: 'cell-muted', text: `冷却至 ${formatDateTime(user.pauseUntil)}` }));
  }
  const statusCell = el('td', {}, ...statusChildren);

  const actionsCell = el(
    'td',
    {},
    el(
      'div',
      { class: 'row-actions' },
      actionButton('detail', user.id, '详情'),
      actionButton('message', user.id, '发消息', status === 'unbound'),
      actionButton('groups', user.id, '分组'),
      actionButton('unbind', user.id, '解绑', status === 'unbound', 'btn-danger-ghost'),
      actionButton('reconnect', user.id, '重连', false),
      actionButton('delete', user.id, '删除', false, 'btn-danger-ghost'),
    ),
  );

  const keepaliveCell = el('td', { class: 'cell-keepalive' }, buildKeepaliveSwitch(user));

  return el(
    'tr',
    {},
    userCell,
    statusCell,
    el('td', { class: 'cell-nowrap', text: formatDateTime(user.boundAt) }),
    el('td', { class: 'cell-nowrap', text: formatRelative(user.lastInboundAt) }),
    el('td', { class: 'cell-nowrap', text: formatRelative(user.lastOutboundAt) }),
    el('td', {
      class: 'cell-nowrap cell-mono',
      text: `${formatNumber(user.queuedCount)} / ${formatNumber(user.sentCount)} / ${formatNumber(user.failedCount)}`,
    }),
    keepaliveCell,
    actionsCell,
  );
}

/** 用户行「保活」开关（PATCH /api/admin/users/{id}/keepalive）。 */
function buildKeepaliveSwitch(user) {
  const enabled = user.keepaliveEnabled === true;
  return buildSwitch({
    enabled,
    ariaLabel: `${user.displayName || user.id} 的消息保活`,
    dataset: { action: 'keepalive', userId: user.id, enabled: enabled ? '1' : '0' },
    title: enabled
      ? `保活已开启${user.keepaliveLastSentAt ? `，最近发送 ${formatDateTime(user.keepaliveLastSentAt)}` : ''}（点击关闭）`
      : '保活已关闭（点击开启）',
    onLabel: '保活中',
    offLabel: '关闭',
  });
}

/** 切换用户保活开关：成功后刷新用户列表与概览。 */
async function toggleUserKeepalive(user, button) {
  const nextEnabled = user.keepaliveEnabled !== true;
  if (button) button.disabled = true;
  try {
    await apiFetch(`/api/admin/users/${encodeURIComponent(user.id)}/keepalive`, {
      method: 'PATCH',
      body: { enabled: nextEnabled },
    });
    toast(
      `已${nextEnabled ? '开启' : '关闭'}「${user.displayName || user.id}」的消息保活`,
      'success',
    );
    await refreshAfterWrite({ overview: true, users: true });
  } catch (error) {
    toastError(error, '更新保活状态失败');
    if (button) button.disabled = false;
  }
}

function actionButton(action, userId, label, disabled = false, extraClass = '') {
  return rowActionButton(action, userId, label, { datasetKey: 'userId', extraClass, disabled });
}

export const handleUserTableClick = createTableClickHandler({
  find: (button) => state.users.items.find((item) => item.id === button.dataset.userId),
  actions: {
    detail: (user) => openUserDetailModal(user),
    message: (user) => openSendMessageModal({ kind: 'user', user }),
    groups: (user) => openUserGroupsModal(user),
    keepalive: (user, button) => toggleUserKeepalive(user, button),
    unbind: (user) => unbindUser(user),
    reconnect: (user) => reconnectUser(user),
    delete: (user) => deleteUser(user),
  },
});

async function unbindUser(user) {
  const confirmed = await confirmDialog({
    title: '解绑用户',
    message: `确定解绑「${user.displayName || user.id}」吗？解绑后将停止其消息收发，微信端的授权记录需在手机微信中自行管理。`,
    confirmText: '确认解绑',
    cancelText: '取消',
    danger: true,
  });
  if (!confirmed) return;
  try {
    const data = await apiFetch(`/api/admin/users/${encodeURIComponent(user.id)}/unbind`, {
      method: 'POST',
    });
    toast((data && data.message) || '已解绑', 'success');
    await refreshAfterWrite({ overview: true, users: true, messages: true });
  } catch (error) {
    toastError(error, '解绑失败');
  }
}

async function reconnectUser(user) {
  try {
    const data = await apiFetch(`/api/admin/users/${encodeURIComponent(user.id)}/reconnect`, {
      method: 'POST',
    });
    toast(data && data.monitorsRunning ? '已触发重连，入站监控运行中' : '已触发重连', 'success');
    await refreshAfterWrite({ overview: true, users: true });
  } catch (error) {
    toastError(error, '重连失败');
  }
}

/** 彻底删除用户（不可恢复）：DELETE /api/admin/users/{id}。 */
async function deleteUser(user) {
  const name = user.displayName || user.id;
  const confirmed = await confirmDialog({
    title: '删除用户',
    message:
      `确定永久删除「${name}」吗？\n\n` +
      '将删除：用户与绑定凭证、分组关系、消息记录、入站/出站媒体文件、接口应用日志，' +
      '并从定时任务/接口应用的「指定用户」目标中移除。\n\n此操作不可恢复；如只想停止收发，请使用「解绑」。',
    confirmText: '永久删除',
    cancelText: '取消',
    danger: true,
  });
  if (!confirmed) return;
  try {
    const data = await apiFetch(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
    const attachments = Number(data && data.attachmentsDeleted) || 0;
    toast(attachments > 0 ? `用户已删除（清理 ${attachments} 个附件文件）` : '用户已删除', 'success');
    await refreshAfterWrite({ overview: true, users: true, messages: true, groups: true });
  } catch (error) {
    toastError(error, '删除用户失败');
  }
}

async function openUserDetailModal(user) {
  const modal = openTrackedModal({
    title: `用户详情：${user.displayName || user.id}`,
    size: 'wide',
    content: [el('p', { class: 'form-hint', text: '正在加载用户详情…' })],
    actions: [{ label: '关闭', class: 'btn btn-secondary' }],
  });
  try {
    const data = await apiFetch(`/api/admin/users/${encodeURIComponent(user.id)}`);
    const detailUser = data && data.user && typeof data.user === 'object' ? data.user : user;
    const recentInbound = data && Array.isArray(data.recentInbound) ? data.recentInbound : [];
    const recentOutbound = data && Array.isArray(data.recentOutbound) ? data.recentOutbound : [];
    clearNode(modal.body);
    modal.body.append(...buildUserDetailNodes(detailUser, recentInbound, recentOutbound));
  } catch (error) {
    clearNode(modal.body);
    modal.body.append(
      el('p', { class: 'inline-error', role: 'alert', text: error && error.message ? error.message : '加载用户详情失败' }),
    );
    toastError(error, '加载用户详情失败');
  }
}

function buildUserDetailNodes(user, recentInbound, recentOutbound) {
  const status = USER_STATUS_META[user.status] || {
    label: user.status || '未知',
    className: 'badge-muted',
  };
  const head = el(
    'div',
    { class: 'user-detail-head' },
    el('span', { class: `badge ${status.className}`, text: status.label }),
    el('span', {
      class: `badge badge-soft ${user.hasContextToken ? 'badge-success' : 'badge-muted'}`,
      text: user.hasContextToken ? '可主动推送' : '待首条消息',
    }),
    el('span', {
      class: `badge badge-soft ${user.status === 'paused' && user.pauseUntil ? 'badge-warning' : 'badge-muted'}`,
      text: user.status === 'paused' && user.pauseUntil ? `冷却至 ${formatDateTime(user.pauseUntil)}` : '无冷却',
    }),
  );

  const info = el('div', { class: 'kv-grid user-detail-kv' });
  const entries = [
    ['昵称', user.displayName || '（未命名）'],
    ['用户 ID', user.id],
    ['微信用户 ID', user.wechatUserId],
    ['机器人 ID', user.ilinkBotId],
    ['绑定时间', formatDateTime(user.boundAt)],
    ['最近入站', formatRelative(user.lastInboundAt)],
    ['最近出站', formatRelative(user.lastOutboundAt)],
    ['消息保活', user.keepaliveEnabled === true ? '已开启' : '未开启'],
    [
      '最近保活发送',
      user.keepaliveLastSentAt && user.keepaliveLastSentAt > 0
        ? formatDateTime(user.keepaliveLastSentAt)
        : '—',
    ],
    [
      '队列 / 成功 / 失败',
      `${formatNumber(user.queuedCount)} / ${formatNumber(user.sentCount)} / ${formatNumber(user.failedCount)}`,
    ],
  ];
  // 开启保活且有入站记录时，展示当前 24h 会话窗口剩余时间（来自 /api/admin/config.keepalive）
  const keepaliveWindowMs = Number(state.config && state.config.keepalive && state.config.keepalive.windowMs);
  if (user.keepaliveEnabled === true && Number(user.lastInboundAt) > 0 && Number.isFinite(keepaliveWindowMs) && keepaliveWindowMs > 0) {
    const remaining = Number(user.lastInboundAt) + keepaliveWindowMs - Date.now();
    entries.push([
      '会话窗口剩余',
      remaining > 0 ? formatDuration(remaining) : '已过期（不会自动发送保活）',
    ]);
  }
  for (const [label, value] of entries) {
    if (value === undefined || value === null || value === '') continue;
    info.append(
      el(
        'div',
        { class: 'kv-item' },
        el('span', { class: 'kv-label', text: label }),
        el('span', { class: 'kv-value', text: String(value) }),
      ),
    );
  }

  return [
    head,
    info,
    buildMiniMessagesSection('最近入站消息', recentInbound),
    buildMiniMessagesSection('最近出站消息', recentOutbound),
  ];
}

function buildMiniMessagesSection(title, messages) {
  const section = el(
    'section',
    { class: 'mini-msg-section' },
    el('h4', { class: 'mini-msg-title', text: `${title}（${messages.length}）` }),
  );
  if (messages.length === 0) {
    section.append(el('p', { class: 'empty-text', text: '暂无记录' }));
    return section;
  }
  const list = el('div', { class: 'mini-msg-list' });
  for (const message of messages.slice(0, 10)) list.append(buildMiniMessageItem(message));
  section.append(list);
  return section;
}

function buildMiniMessageItem(message) {
  const direction = MESSAGE_DIRECTION_META[message.direction] || {
    label: message.direction || '—',
    className: 'badge-muted',
  };
  const status = MESSAGE_STATUS_META[message.status] || {
    label: message.status || '—',
    className: 'badge-muted',
  };
  const item = el(
    'div',
    { class: 'mini-msg' },
    el(
      'div',
      { class: 'mini-msg-head' },
      el('span', { class: `badge ${direction.className}`, text: direction.label }),
      el('span', { class: `badge badge-soft ${status.className}`, text: status.label }),
      buildSourceBadge(message),
      el('span', { class: 'mini-msg-time', text: formatDateTime(message.createdAt) }),
    ),
  );
  const text = typeof message.text === 'string' ? message.text : '';
  if (text) item.append(el('div', { class: 'mini-msg-text', text }));
  const attachments = buildAttachmentsNode(message.attachments);
  if (attachments) item.append(attachments);
  if (message.error) item.append(el('div', { class: 'mini-msg-error', text: String(message.error) }));
  return item;
}

/** 用户管理视图事件绑定（首次进入该视图时加载，幂等）。 */
let usersViewBound = false;
export function initUsersView() {
  if (usersViewBound) return;
  usersViewBound = true;
  els.userSearch.addEventListener(
    'input',
    debounce(() => {
      state.users.q = els.userSearch.value.trim();
      state.users.offset = 0;
      loadUsers().catch(loadErrorHandler('加载用户列表失败'));
    }, 300),
  );
  els.userStatusFilter.addEventListener('change', () => {
    state.users.status = els.userStatusFilter.value || 'all';
    state.users.offset = 0;
    loadUsers().catch(loadErrorHandler('加载用户列表失败'));
  });
  els.userGroupFilter.addEventListener('change', () => {
    state.users.groupId = els.userGroupFilter.value || '';
    state.users.offset = 0;
    loadUsers().catch(loadErrorHandler('加载用户列表失败'));
  });
  els.usersPrev.addEventListener('click', () => {
    if (state.users.offset <= 0) return;
    state.users.offset = Math.max(0, state.users.offset - PAGE_SIZE);
    loadUsers().catch(loadErrorHandler('加载用户列表失败'));
  });
  els.usersNext.addEventListener('click', () => {
    if (state.users.offset + PAGE_SIZE >= state.users.total) return;
    state.users.offset += PAGE_SIZE;
    loadUsers().catch(loadErrorHandler('加载用户列表失败'));
  });
  els.userTableBody.addEventListener('click', handleUserTableClick);
}
