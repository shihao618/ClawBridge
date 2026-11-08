/**
 * 用户分组视图：分组列表/CRUD、行内保活开关、分组编辑弹窗。
 */

import { GROUP_COLOR_PALETTE, GROUP_DESC_MAX, GROUP_NAME_MAX } from '../constants.js';
import { refreshAfterWrite } from '../core.js';
import { els, state } from '../state.js';
import { buildColorDot, buildSwitch, createTableClickHandler, emptyRow, isGroupKeepaliveEnabled, openTrackedModal, rowActionButton, updateGroupFilterOptions } from '../ui.js';
import { apiFetch, clearNode, confirmDialog, el, formatNumber, toast, toastError } from '../../common.js';
import { normalizeGroupColor } from '../../lib/parse.js';
import { openSendMessageModal } from './send-message.js';

export async function loadGroups() {
  const data = await apiFetch('/api/admin/groups');
  state.groups = data && Array.isArray(data.items) ? data.items : [];
  renderGroups();
  updateGroupFilterOptions();
}

export function renderGroups() {
  if (!els.groupTableBody) return;
  const groups = state.groups;
  if (els.groupsTotal) els.groupsTotal.textContent = `共 ${formatNumber(groups.length)} 个分组`;
  clearNode(els.groupTableBody);
  if (groups.length === 0) {
    els.groupTableBody.append(emptyRow(4, '暂无分组，点击「＋ 新建分组」创建'));
    return;
  }
  for (const group of groups) els.groupTableBody.append(buildGroupRow(group));
}

function buildGroupRow(group) {
  const name = typeof group.name === 'string' && group.name ? group.name : '（未命名分组）';
  const description = typeof group.description === 'string' && group.description ? group.description : '—';
  const active = Number.isFinite(Number(group.activeUserCount)) ? Number(group.activeUserCount) : 0;
  const total = Number.isFinite(Number(group.userCount)) ? Number(group.userCount) : 0;
  return el(
    'tr',
    {},
    el(
      'td',
      {},
      el(
        'div',
        { class: 'group-name-cell' },
        buildColorDot(group.color),
        el('span', { class: 'cell-strong', text: name }),
      ),
    ),
    el('td', { class: 'cell-muted group-desc-cell', text: description }),
    el('td', { class: 'cell-nowrap cell-mono', text: `${formatNumber(active)} / ${formatNumber(total)}` }),
    // 与用户管理一致：保活单独一列，放在操作列前面
    el('td', { class: 'cell-keepalive' }, buildGroupKeepaliveSwitch(group)),
    el(
      'td',
      {},
      el(
        'div',
        { class: 'row-actions' },
        groupActionButton('message', group.id, '发消息'),
        groupActionButton('edit', group.id, '编辑'),
        groupActionButton('delete', group.id, '删除', 'btn-danger-ghost'),
      ),
    ),
  );
}

/**
 * 分组行内保活开关：一键开启/关闭分组保活（无需弹窗）。
 * 后端 POST /api/admin/groups/{id}/keepalive 会同步开启/关闭当前成员，并持久化分组默认，
 * 之后加入该分组的成员自动继承。
 */
function buildGroupKeepaliveSwitch(group) {
  const enabled = isGroupKeepaliveEnabled(group);
  const name = typeof group.name === 'string' && group.name ? group.name : group.id;
  return buildSwitch({
    enabled,
    ariaLabel: `分组 ${name} 的保活开关`,
    dataset: { action: 'keepalive', groupId: group.id, enabled: enabled ? '1' : '0' },
    title: enabled
      ? '已开启分组保活：当前成员已开启，之后加入的成员自动开启（点击关闭）'
      : '未开启分组保活（点击开启：同步当前成员，并让之后加入的成员自动开启）',
    onLabel: '保活中',
    offLabel: '保活',
  });
}

function groupActionButton(action, groupId, label, extraClass = '') {
  return rowActionButton(action, groupId, label, { datasetKey: 'groupId', extraClass });
}

export const handleGroupTableClick = createTableClickHandler({
  find: (button) => state.groups.find((item) => item.id === button.dataset.groupId),
  actions: {
    message: (group) => openSendMessageModal({ kind: 'group', group }),
    keepalive: (group, button) => void toggleGroupKeepalive(group, button),
    edit: (group) => openGroupEditor(group),
    delete: (group) => deleteGroup(group),
  },
});

/** 行内切换分组保活：POST /groups/{id}/keepalive，直接生效并刷新（无需弹窗）。 */
async function toggleGroupKeepalive(group, trigger) {
  if (!group || !group.id) return;
  const nextEnabled = !isGroupKeepaliveEnabled(group);
  if (trigger) trigger.disabled = true;
  try {
    const data = await apiFetch(`/api/admin/groups/${encodeURIComponent(group.id)}/keepalive`, {
      method: 'POST',
      body: { enabled: nextEnabled },
    });
    const updated = Number(data && data.updated);
    const count = Number.isFinite(updated) ? updated : 0;
    toast(
      nextEnabled
        ? `分组已开启保活：已同步 ${count} 位成员，之后加入该分组的成员将自动开启保活`
        : `分组已关闭保活：已同步 ${count} 位成员，之后加入的成员将不再自动开启保活`,
      'success',
    );
    await refreshAfterWrite({ overview: true, users: true, groups: true });
  } catch (error) {
    toastError(error, '切换分组保活失败');
  } finally {
    if (trigger) trigger.disabled = false;
  }
}

export function openGroupEditor(group = null) {
  const isEdit = Boolean(group && group.id);
  const nameInput = el('input', {
    id: 'group-name-input',
    class: 'input',
    type: 'text',
    maxlength: String(GROUP_NAME_MAX),
    autocomplete: 'off',
    placeholder: '例如：VIP客户',
    value: isEdit && typeof group.name === 'string' ? group.name : '',
  });
  const descInput = el('textarea', {
    id: 'group-desc-input',
    class: 'textarea',
    rows: '2',
    maxlength: String(GROUP_DESC_MAX),
    placeholder: '可选，最多 200 字符',
  });
  if (isEdit && typeof group.description === 'string') descInput.value = group.description;
  const errorNode = el('p', { id: 'group-form-error', class: 'inline-error', role: 'alert', hidden: true });

  let selectedColor = normalizeGroupColor(isEdit ? group.color : '');
  /** @type {HTMLElement[]} */
  const swatches = [];
  const palette = el('div', { class: 'color-palette', role: 'group', 'aria-label': '分组颜色（可选）' });
  function syncSwatches() {
    for (const swatch of swatches) {
      const active = swatch.dataset.color === selectedColor;
      swatch.classList.toggle('is-active', active);
      swatch.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }
  function addSwatch(color, label) {
    const swatch = el('button', {
      class: `color-swatch${color ? '' : ' color-swatch-none'}`,
      type: 'button',
      title: label,
      'aria-label': label,
      'aria-pressed': 'false',
      dataset: { color },
    });
    if (color) swatch.style.backgroundColor = color;
    else swatch.textContent = '无';
    swatch.addEventListener('click', () => {
      selectedColor = color;
      syncSwatches();
    });
    swatches.push(swatch);
    palette.append(swatch);
  }
  addSwatch('', '无颜色');
  for (const color of GROUP_COLOR_PALETTE) addSwatch(color, color);
  syncSwatches();

  const content = [
    el(
      'div',
      { class: 'rule-form-grid' },
      el(
        'div',
        { class: 'form-field form-field--wide' },
        el('label', { class: 'form-label', for: 'group-name-input', text: '分组名称（必填，1-40 字符）' }),
        nameInput,
      ),
      el('div', { class: 'form-field' }, el('span', { class: 'form-label', text: '颜色（可选）' }), palette),
      el(
        'div',
        { class: 'form-field form-field--full' },
        el('label', { class: 'form-label', for: 'group-desc-input', text: '描述（可选，≤200 字符）' }),
        descInput,
      ),
    ),
    el('p', {
      class: 'form-hint',
      text: '分组保活开关在分组列表行内操作（「保活」开关）：会同步当前成员，并让之后加入该分组的成员自动开启保活。',
    }),
    errorNode,
  ];

  function showError(message) {
    errorNode.textContent = message;
    errorNode.hidden = false;
  }

  openTrackedModal({
    title: isEdit ? '编辑分组' : '新建分组',
    content,
    actions: [
      { label: '取消', class: 'btn btn-secondary' },
      {
        label: isEdit ? '保存' : '创建',
        class: 'btn btn-primary',
        closeOnClick: false,
        onClick: async (modal) => {
          errorNode.hidden = true;
          const name = nameInput.value.trim();
          const description = descInput.value.trim();
          if (!name) {
            showError('请输入分组名称');
            nameInput.focus();
            return;
          }
          if (name.length > GROUP_NAME_MAX) {
            showError(`分组名称不能超过 ${GROUP_NAME_MAX} 个字符`);
            return;
          }
          if (description.length > GROUP_DESC_MAX) {
            showError(`描述不能超过 ${GROUP_DESC_MAX} 个字符`);
            return;
          }
          modal.setBusy(true);
          try {
            const payload = { name, description, color: selectedColor || '' };
            if (isEdit) {
              await apiFetch(`/api/admin/groups/${encodeURIComponent(group.id)}`, { method: 'PATCH', body: payload });
              toast(`分组「${name}」已更新`, 'success');
            } else {
              await apiFetch('/api/admin/groups', { method: 'POST', body: payload });
              toast(`分组「${name}」已创建`, 'success');
            }
            modal.close('saved');
            await refreshAfterWrite({ groups: true, users: true, messages: true });
          } catch (error) {
            if (error && error.status === 409) showError('分组名称已存在，请换一个名称');
            else showError(error && error.message ? error.message : '保存分组失败');
            if (error && error.status === 401) return;
            if (error && error.status >= 500) toastError(error, '保存分组失败');
          } finally {
            modal.setBusy(false);
          }
        },
      },
    ],
  });
}

async function deleteGroup(group) {
  const confirmed = await confirmDialog({
    title: '删除分组',
    message: `确定删除分组「${group.name || group.id}」吗？用户不会被删除，仅移除该分组关联。`,
    confirmText: '删除分组',
    cancelText: '取消',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await apiFetch(`/api/admin/groups/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
    toast('分组已删除', 'success');
    if (state.users.groupId === group.id) state.users.groupId = '';
    if (state.messages.groupId === group.id) state.messages.groupId = '';
    await refreshAfterWrite({ groups: true, users: true, messages: true });
  } catch (error) {
    toastError(error, '删除分组失败');
  }
}
