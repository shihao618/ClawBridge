/**
 * 规则编辑器 / 定时任务编辑器共用的「用户 / 分组多选」选择器（F-04）。
 *
 * 两侧 DOM 结构、class、文案、勾选状态与保存 payload 语义完全一致，仅以下差异由参数区分：
 * - 元素 id / radio name 前缀（rule-* / schedule-*）
 * - 业务单选顺序与初始类型（规则 all/users/groups；定时 users/groups/all）
 * - checkbox 的 dataset 键（userId/groupId vs scheduleUserId/scheduleGroupId，后者字符串化）
 * - 规则侧多一行说明文案；定时侧多「全选/清空」工具条
 */
import { clearNode, debounce, el, formatNumber, setHidden } from '../../common.js';
import { state } from '../state.js';
import { buildColorDot } from '../ui.js';

/** dataset camelCase 键 → HTML 属性选择器（userId → [data-user-id]）。 */
function dataAttrSelector(key) {
  return `[data-${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}]`;
}

/**
 * 创建用户/分组多选选择器。
 *
 * @param {object} options
 * @param {string} options.prefix 元素 id 前缀（'rule' | 'schedule'）
 * @param {string} options.radioName radio 的 name（如 rule-scope-type）
 * @param {string[]} options.typeOrder radio 展示顺序
 * @param {Record<string,string>} options.typeLabels radio 文案
 * @param {string} options.initialType 初始类型
 * @param {(value: string) => string} [options.normalizeType] 切换时归一化（定时任务用）
 * @param {string[]} [options.initialUserIds] 初始勾选用户 id（字符串）
 * @param {string[]} [options.initialGroupIds] 初始勾选分组 id（字符串）
 * @param {() => Array<object>} options.users 用户数据源（动态读取，便于后续异步加载重渲染）
 * @param {string} options.userDatasetKey checkbox dataset 键（userId | scheduleUserId）
 * @param {string} options.groupDatasetKey checkbox dataset 键（groupId | scheduleGroupId）
 * @param {boolean} [options.stringifyIds] dataset 值是否字符串化（定时任务侧行为）
 * @param {{ user?: string, group?: string }} [options.hints] 选择器下方说明文案
 * @param {boolean} [options.withPickerActions] 是否渲染「全选/清空」工具条
 * @returns {object}
 */
export function createPickerSection({
  prefix,
  radioName,
  typeOrder,
  typeLabels,
  initialType,
  normalizeType = (value) => value,
  initialUserIds = [],
  initialGroupIds = [],
  users,
  userDatasetKey,
  groupDatasetKey,
  stringifyIds = false,
  hints = null,
  withPickerActions = false,
}) {
  let type = normalizeType(initialType);
  const selectedUserIds = new Set(Array.isArray(initialUserIds) ? initialUserIds.map(String) : []);
  const selectedGroupIds = new Set(Array.isArray(initialGroupIds) ? initialGroupIds.map(String) : []);

  const radios = typeOrder.map((value) =>
    el(
      'label',
      { class: 'radio-inline' },
      el('input', { type: 'radio', name: radioName, value, checked: value === type }),
      el('span', { text: typeLabels[value] }),
    ),
  );
  for (const radio of radios) {
    radio.querySelector('input').addEventListener('change', (event) => {
      type = normalizeType(event.target.value);
      syncVisibility();
    });
  }

  const userSearch = el('input', {
    id: `${prefix}-user-search`,
    class: 'input',
    type: 'search',
    placeholder: '搜索用户昵称 / ID',
    autocomplete: 'off',
  });
  const userList = el('div', { id: `${prefix}-user-list`, class: 'rule-picker-list' });
  const groupList = el('div', { id: `${prefix}-group-list`, class: 'rule-picker-list' });

  function pickDatasetValue(id) {
    return stringifyIds ? String(id) : id;
  }

  function selectAll(list, ids, datasetKey, select) {
    for (const checkbox of list.querySelectorAll(`input${dataAttrSelector(datasetKey)}`)) {
      checkbox.checked = select;
      const id = checkbox.dataset[datasetKey];
      if (select) ids.add(id);
      else ids.delete(id);
    }
  }

  function buildPickerActions(kind, list, ids, datasetKey) {
    const isUsers = kind === 'users';
    const wrap = el(
      'div',
      { class: `toolbar-slim ${prefix}-picker-actions` },
      el('button', {
        id: `${prefix}-${kind}-all`,
        class: 'btn btn-secondary btn-xs',
        type: 'button',
        text: isUsers ? '全选用户' : '全选分组',
      }),
      el('button', { id: `${prefix}-${kind}-clear`, class: 'btn btn-ghost btn-xs', type: 'button', text: '清空' }),
    );
    wrap.querySelector(`#${prefix}-${kind}-all`).addEventListener('click', () => selectAll(list, ids, datasetKey, true));
    wrap.querySelector(`#${prefix}-${kind}-clear`).addEventListener('click', () => selectAll(list, ids, datasetKey, false));
    return wrap;
  }

  const userChildren = [];
  if (withPickerActions) userChildren.push(buildPickerActions('users', userList, selectedUserIds, userDatasetKey));
  userChildren.push(userSearch, userList);
  if (hints && hints.user) userChildren.push(el('p', { class: 'form-hint', text: hints.user }));
  const userPicker = el('div', { class: 'rule-picker', hidden: true }, ...userChildren);

  const groupChildren = [];
  if (withPickerActions) groupChildren.push(buildPickerActions('groups', groupList, selectedGroupIds, groupDatasetKey));
  groupChildren.push(groupList);
  if (hints && hints.group) groupChildren.push(el('p', { class: 'form-hint', text: hints.group }));
  const groupPicker = el('div', { class: 'rule-picker', hidden: true }, ...groupChildren);

  function renderUsers(filterText = '') {
    clearNode(userList);
    const keyword = String(filterText || '').trim().toLowerCase();
    const items = Array.isArray(users()) ? users() : [];
    const filtered = items.filter((user) => {
      if (!keyword) return true;
      return [user.displayName, user.id, user.wechatUserId].some((value) =>
        String(value || '').toLowerCase().includes(keyword),
      );
    });
    if (filtered.length === 0) {
      userList.append(el('p', { class: 'empty-text', text: keyword ? '没有匹配的用户' : '暂无用户' }));
      return;
    }
    for (const user of filtered.slice(0, 200)) {
      const checkbox = el('input', {
        type: 'checkbox',
        class: 'rule-picker-check',
        dataset: { [userDatasetKey]: pickDatasetValue(user.id) },
        checked: selectedUserIds.has(String(user.id)),
      });
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedUserIds.add(String(user.id));
        else selectedUserIds.delete(String(user.id));
      });
      userList.append(
        el(
          'label',
          { class: 'rule-picker-item' },
          checkbox,
          el('span', { class: 'rule-picker-name', text: user.displayName || user.id }),
          el('span', { class: 'rule-picker-meta', text: user.wechatUserId || user.id }),
        ),
      );
    }
  }

  function renderGroups() {
    clearNode(groupList);
    if (state.groups.length === 0) {
      groupList.append(el('p', { class: 'empty-text', text: '暂无分组，请先在「用户分组」区块创建' }));
      return;
    }
    for (const group of state.groups) {
      const checkbox = el('input', {
        type: 'checkbox',
        class: 'rule-picker-check',
        dataset: { [groupDatasetKey]: pickDatasetValue(group.id) },
        checked: selectedGroupIds.has(String(group.id)),
      });
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedGroupIds.add(String(group.id));
        else selectedGroupIds.delete(String(group.id));
      });
      groupList.append(
        el(
          'label',
          { class: 'rule-picker-item' },
          checkbox,
          buildColorDot(group.color, 'group-dot'),
          el('span', { class: 'rule-picker-name', text: group.name || group.id }),
          el('span', { class: 'rule-picker-meta', text: `${formatNumber(group.userCount)} 位用户` }),
        ),
      );
    }
  }

  function syncVisibility() {
    for (const radio of radios) {
      const input = radio.querySelector('input');
      input.checked = input.value === type;
    }
    setHidden(userPicker, type !== 'users');
    setHidden(groupPicker, type !== 'groups');
  }

  userSearch.addEventListener(
    'input',
    debounce(() => renderUsers(userSearch.value), 200),
  );
  renderUsers('');
  renderGroups();
  syncVisibility();

  return {
    radios,
    userPicker,
    groupPicker,
    userSearch,
    selectedUserIds,
    selectedGroupIds,
    getType: () => type,
    renderUsers,
    renderGroups,
  };
}
