/**
 * 运行配置视图：服务信息、可编辑设置分组（保存/恢复默认/重启）、安全卡片（改密/API Token）。
 */

import { ADVANCED_SETTINGS_KEYS } from '../constants.js';
import { loadErrorHandler } from '../core.js';
import { els, state } from '../state.js';
import { appendKv, buildSwitch, clearInlineError, showInlineError, showSecretRevealModal, showTokenRevealModal } from '../ui.js';
import { apiFetch, clearNode, confirmDialog, el, setButtonLoading, setHidden, toast, toastError } from '../../common.js';
import { parseSettingArrayInput } from '../../lib/parse.js';
import { normalizeSettingValue, settingsValuesEqual, settingTypeOf } from '../../lib/settings.js';

export async function loadConfig() {
  const data = await apiFetch('/api/admin/config');
  state.config = data;
  state.mediaLimits =
    data && data.media && typeof data.media === 'object' ? data.media : null;
  renderServiceInfo(data);
}

function settingsValueKey(groupKey, fieldKey) {
  return `${groupKey}.${fieldKey}`;
}

function isMultilineSetting(field, value) {
  if (field && (field.type === 'text' || field.multiline === true)) return true;
  if (field && /(^|\.)text$/i.test(String(field.key || ''))) return true;
  return typeof value === 'string' && value.length > 160;
}

function cloneSettingValue(value) {
  return Array.isArray(value) ? value.slice() : value;
}

function formatArrayInput(value) {
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
}

function formatSettingDefault(value, type) {
  if (type === 'boolean') return value === true ? '开启' : '关闭';
  if (type === 'array') return Array.isArray(value) && value.length > 0 ? value.join('、') : '空';
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

function buildSettingsState(data) {
  const groups = data && Array.isArray(data.groups) ? data.groups : [];
  const initial = new Map();
  const draft = new Map();
  const fields = new Map();
  for (const group of groups) {
    for (const field of Array.isArray(group.fields) ? group.fields : []) {
      const key = settingsValueKey(group.key, field.key);
      const type = settingTypeOf(field);
      const value = normalizeSettingValue(field.value, type);
      initial.set(key, value);
      draft.set(key, cloneSettingValue(value));
      fields.set(key, { group, field, type });
    }
  }
  return { groups, initial, draft, fields, envOnly: Array.isArray(data && data.envOnly) ? data.envOnly : [] };
}

export async function loadSettings() {
  initSettingsView();
  try {
    const data = await apiFetch('/api/admin/settings');
    const built = buildSettingsState(data || {});
    state.settings.available = true;
    state.settings.groups = built.groups;
    state.settings.envOnly = built.envOnly;
    state.settings.initial = built.initial;
    state.settings.draft = built.draft;
    state.settings.fields = built.fields;
    state.settings.security =
      data && data.security && typeof data.security === 'object' ? data.security : null;
    setHidden(els.settingsUnavailable, true);
    setHidden(els.settingsSavebar, false);
    clearInlineError(els.settingsError);
    renderSettings();
    renderEnvOnly();
    renderSecurityCard();
    renderServiceInfo(state.config);
  } catch (error) {
    state.settings.available = false;
    state.settings.groups = [];
    state.settings.envOnly = [];
    state.settings.initial = new Map();
    state.settings.draft = new Map();
    state.settings.fields = new Map();
    state.settings.security = null;
    clearNode(els.settingsGroups);
    setHidden(els.settingsSavebar, true);
    if (els.securityCard) setHidden(els.securityCard, true);
    els.settingsUnavailable.hidden = false;
    els.settingsUnavailable.textContent = `加载运行配置失败：${error && error.message ? error.message : '未知错误'}。`;
    toastError(error, '加载运行配置失败');
  }
}

function settingControlId(groupKey, fieldKey) {
  return `settings-${String(groupKey).replace(/[^a-zA-Z0-9_-]/g, '-')}-${String(fieldKey).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function buildSettingControl(group, field, type, value) {
  const key = settingsValueKey(group.key, field.key);
  const id = settingControlId(group.key, field.key);
  if (type === 'boolean') {
    return buildSwitch({
      id,
      className: 'settings-switch',
      enabled: value === true,
      ariaLabel: field.label || field.key,
      dataset: { settingKey: key },
      onLabel: '开启',
      offLabel: '关闭',
    });
  }
  if (type === 'number') {
    const input = el('input', {
      id,
      class: 'input settings-number',
      type: 'number',
      step: 'any',
      value: value === undefined || value === null ? '' : String(value),
      dataset: { settingKey: key },
    });
    if (field.min !== undefined && field.min !== null) input.min = String(field.min);
    if (field.max !== undefined && field.max !== null) input.max = String(field.max);
    return input;
  }
  if (type === 'array') {
    return el('textarea', {
      id,
      class: 'textarea settings-array',
      rows: '2',
      value: formatArrayInput(value),
      placeholder: '逗号或换行分隔，例如 192.168.1.10, api.internal',
      dataset: { settingKey: key },
    });
  }
  if (type === 'enum') {
    const options = Array.isArray(field.options) ? field.options : [];
    const current = value === undefined || value === null ? '' : String(value);
    const select = el('select', {
      id,
      class: 'select settings-enum',
      dataset: { settingKey: key },
    });
    const seen = new Set();
    for (const option of options) {
      const optionValue = option && typeof option === 'object' ? option.value : option;
      const optionLabel = option && typeof option === 'object' ? option.label ?? option.value : option;
      const normalized = String(optionValue === undefined || optionValue === null ? '' : optionValue);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      select.append(
        el('option', { value: normalized, text: String(optionLabel ?? normalized), selected: normalized === current }),
      );
    }
    if (!seen.has(current) && current) {
      select.prepend(el('option', { value: current, text: current, selected: true }));
    }
    return select;
  }
  if (type === 'url') {
    return el('input', {
      id,
      class: 'input settings-url',
      type: 'url',
      placeholder: 'https://example.com',
      value: value === undefined || value === null ? '' : String(value),
      dataset: { settingKey: key },
    });
  }
  if (type === 'text' || isMultilineSetting(field, value)) {
    return el('textarea', {
      id,
      class: 'textarea',
      rows: '3',
      value: value === undefined || value === null ? '' : String(value),
      dataset: { settingKey: key },
    });
  }
  return el('input', {
    id,
    class: 'input',
    type: 'text',
    value: value === undefined || value === null ? '' : String(value),
    dataset: { settingKey: key },
  });
}

function renderSettings() {
  clearNode(els.settingsGroups);
  if (!state.settings.groups.length) {
    els.settingsGroups.append(el('p', { class: 'empty-text', text: '暂无可编辑的运行配置（后端未返回 groups）' }));
    return;
  }
  for (const group of state.settings.groups) {
    const card = el('div', { class: 'card settings-group', dataset: { settingsGroup: group.key } });
    const head = el(
      'div',
      { class: 'settings-group-head' },
      el(
        'div',
        { class: 'settings-group-title' },
        el('h3', { class: 'card-title', text: group.label || group.key }),
        group.description ? el('p', { class: 'form-hint', text: group.description }) : null,
      ),
      el('button', {
        class: 'btn btn-secondary btn-sm',
        type: 'button',
        text: '恢复默认',
        dataset: { settingsReset: group.key },
        'aria-label': `恢复「${group.label || group.key}」为默认值`,
      }),
    );
    card.append(head);
    const fieldsBox = el('div', { class: 'settings-fields' });
    for (const field of Array.isArray(group.fields) ? group.fields : []) {
      const key = settingsValueKey(group.key, field.key);
      const meta = state.settings.fields.get(key);
      if (!meta) continue;
      // 推送 API 开关在「安全」卡片中单独管理（走 PATCH settings security.pushApiEnabled）
      if (group.key === 'security' && field.key === 'pushApiEnabled') continue;
      const control = buildSettingControl(group, field, meta.type, state.settings.draft.get(key));
      const settingsSpanClass = key === 'keepalive.text'
        ? ' settings-field--full'
        : key === 'media.allowedImageMime' || key === 'media.allowedVideoMime'
          ? ' settings-field--half'
          : meta.type === 'array'
            ? ' settings-field--full'
            : '';
      const minMax =
        field.min !== undefined && field.min !== null || field.max !== undefined && field.max !== null
          ? `范围：${field.min ?? '—'} ~ ${field.max ?? '—'}`
          : '';
      if (key === 'media.allowedImageMime') {
        fieldsBox.append(el('div', { class: 'settings-row-break', 'aria-hidden': 'true' }));
      }
      if (key === 'ilink.requestTimeoutMs') {
        fieldsBox.append(el('div', { class: 'settings-row-break', 'aria-hidden': 'true' }));
      }
      fieldsBox.append(
        el(
          'div',
          { class: `settings-field${settingsSpanClass}`, dataset: { settingField: key } },
          el(
            'div',
            { class: 'settings-field-head' },
            el('label', { class: 'form-label settings-field-label', for: control.id, text: field.label || field.key }),
            field.restartRequired
              ? el('span', { class: 'badge badge-warning badge-soft settings-restart-badge', title: '该字段需重启容器后生效', text: '需重启' })
              : null,
            el('span', { class: 'badge badge-info badge-soft settings-modified-badge', text: '已修改', hidden: true }),
          ),
          control,
          el(
            'p',
            { class: 'form-hint settings-field-meta' },
            el('span', { class: 'settings-default', text: `默认：${formatSettingDefault(field.default, meta.type)}（.env）` }),
            minMax ? el('span', { class: 'settings-range', text: minMax }) : null,
          ),
          field.description ? el('p', { class: 'form-hint', text: field.description }) : null,
        ),
      );
    }
    const advancedNodes = [...fieldsBox.querySelectorAll('[data-setting-field]')].filter((node) =>
      ADVANCED_SETTINGS_KEYS.has(node.dataset.settingField),
    );
    if (advancedNodes.length) {
      const advancedFields = el('div', { class: 'settings-fields' });
      for (const node of advancedNodes) advancedFields.append(node);
      card.append(
        fieldsBox,
        el(
          'details',
          { class: 'settings-advanced' },
          el(
            'summary',
            { class: 'settings-advanced-summary' },
            el('span', { class: 'settings-advanced-title', text: '高级设置' }),
            el('span', { class: 'form-hint', text: '低频参数，展开后修改' }),
          ),
          advancedFields,
        ),
      );
    } else {
      card.append(fieldsBox);
    }
    els.settingsGroups.append(card);
  }
  syncAllSettingFieldStates();
  updateSettingsSaveBar();
}

export function handleSettingsInput(event) {
  const control = event.target && event.target.closest ? event.target.closest('[data-setting-key]') : null;
  if (!control || !els.settingsGroups.contains(control)) return;
  if (control.getAttribute('role') === 'switch') return;
  applySettingControlValue(control);
}

export function handleSettingsClick(event) {
  const resetButton = event.target.closest ? event.target.closest('button[data-settings-reset]') : null;
  if (resetButton) {
    resetSettingsGroup(resetButton.dataset.settingsReset).catch(loadErrorHandler('恢复默认配置失败'));
    return;
  }
  const switchButton = event.target.closest ? event.target.closest('button[data-setting-key][role="switch"]') : null;
  if (!switchButton) return;
  const key = switchButton.dataset.settingKey;
  const next = state.settings.draft.get(key) !== true;
  state.settings.draft.set(key, next);
  switchButton.classList.toggle('is-on', next);
  switchButton.setAttribute('aria-checked', next ? 'true' : 'false');
  const label = switchButton.querySelector('.switch-label');
  if (label) label.textContent = next ? '开启' : '关闭';
  updateSettingFieldState(key);
  updateSettingsSaveBar();
}

function readSettingControlValue(control, type) {
  if (type === 'boolean') return control.getAttribute('aria-checked') === 'true';
  if (type === 'array') return parseSettingArrayInput(control.value);
  if (type === 'number') {
    const raw = String(control.value === undefined ? '' : control.value).trim();
    if (raw === '') return raw;
    const number = Number(raw);
    return Number.isFinite(number) ? number : raw;
  }
  return String(control.value === undefined ? '' : control.value);
}

function applySettingControlValue(control) {
  const key = control.dataset.settingKey;
  const meta = state.settings.fields.get(key);
  if (!meta) return;
  state.settings.draft.set(key, readSettingControlValue(control, meta.type));
  updateSettingFieldState(key);
  updateSettingsSaveBar();
}

function settingFieldNode(key) {
  for (const node of els.settingsGroups.querySelectorAll('[data-setting-field]')) {
    if (node.dataset.settingField === key) return node;
  }
  return null;
}

function updateSettingFieldState(key) {
  const node = settingFieldNode(key);
  if (!node) return;
  const changed = !settingsValuesEqual(state.settings.draft.get(key), state.settings.initial.get(key));
  node.classList.toggle('is-dirty', changed);
  const badge = node.querySelector('.settings-modified-badge');
  if (badge) badge.hidden = !changed;
  const groupNode = node.closest('.settings-group');
  if (groupNode) {
    const groupKey = groupNode.dataset.settingsGroup;
    let groupDirty = false;
    for (const [fieldKey, meta] of state.settings.fields) {
      if (meta.group.key !== groupKey) continue;
      if (!settingsValuesEqual(state.settings.draft.get(fieldKey), state.settings.initial.get(fieldKey))) {
        groupDirty = true;
        break;
      }
    }
    groupNode.classList.toggle('is-dirty', groupDirty);
  }
}

function syncAllSettingFieldStates() {
  for (const key of state.settings.fields.keys()) updateSettingFieldState(key);
}

function countSettingsChanges() {
  let count = 0;
  for (const key of state.settings.fields.keys()) {
    if (!settingsValuesEqual(state.settings.draft.get(key), state.settings.initial.get(key))) count += 1;
  }
  return count;
}

function updateSettingsSaveBar() {
  if (!els.settingsSaveButton) return;
  const changed = countSettingsChanges();
  if (els.settingsSaveStatus) {
    els.settingsSaveStatus.textContent = changed > 0 ? `${changed} 项已修改，尚未保存` : '尚未修改';
  }
  els.settingsSaveButton.disabled = changed === 0;
}

function collectSettingsChanges() {
  const patch = {};
  const invalid = [];
  for (const [key, meta] of state.settings.fields) {
    const initial = state.settings.initial.get(key);
    const draft = state.settings.draft.get(key);
    if (settingsValuesEqual(initial, draft)) continue;
    let value = draft;
    if (meta.type === 'number') {
      const number = Number(draft);
      if (!Number.isFinite(number)) {
        invalid.push(`${meta.field.label || meta.field.key} 必须是数字`);
        continue;
      }
      value = number;
    } else if (meta.type === 'array') {
      const list = Array.isArray(draft) ? draft.slice() : parseSettingArrayInput(draft);
      const numeric =
        meta.field.type === 'numberArray' ||
        (Array.isArray(initial) && initial.length > 0 && initial.every((item) => typeof item === 'number'));
      value = numeric
        ? list.map((item) => {
            const number = Number(item);
            return Number.isFinite(number) ? number : item;
          })
        : list.map((item) => String(item));
    } else if (meta.type === 'boolean') {
      value = draft === true;
    } else {
      value = String(draft === undefined || draft === null ? '' : draft);
    }
    patch[meta.group.key] = patch[meta.group.key] || {};
    patch[meta.group.key][meta.field.key] = value;
  }
  return { patch, invalid };
}

function showSettingsRestartNote(keys) {
  if (!els.settingsRestartNote) return;
  const list = Array.isArray(keys) ? keys : [];
  if (list.length === 0) {
    els.settingsRestartNote.hidden = true;
    els.settingsRestartNote.textContent = '';
    return;
  }
  els.settingsRestartNote.hidden = false;
  els.settingsRestartNote.textContent = `以下字段已保存，但需重启容器后生效：${list.join('、')}`;
}

export async function saveSettings() {
  if (!state.settings.available) return;
  clearInlineError(els.settingsError);
  const { patch, invalid } = collectSettingsChanges();
  if (invalid.length > 0) {
    showInlineError(els.settingsError, `请检查：${invalid.join('；')}`);
    return;
  }
  if (Object.keys(patch).length === 0) {
    toast('没有需要保存的修改', 'info');
    return;
  }
  setButtonLoading(els.settingsSaveButton, true, '保存中…');
  try {
    const response = await apiFetch('/api/admin/settings', { method: 'PATCH', body: patch });
    const restartRequired = response && Array.isArray(response.restartRequired) ? response.restartRequired : [];
    toast(
      restartRequired.length > 0 ? '运行配置已保存（部分字段需重启容器后生效）' : '运行配置已保存',
      'success',
    );
    showSettingsRestartNote(restartRequired);
    await loadSettings();
  } catch (error) {
    showInlineError(els.settingsError, error && error.message ? error.message : '保存运行配置失败');
    if (error && error.status !== 400) toastError(error, '保存运行配置失败');
  } finally {
    setButtonLoading(els.settingsSaveButton, false);
  }
}

async function resetSettingsGroup(groupKey) {
  const group = state.settings.groups.find((item) => item.key === groupKey);
  const confirmed = await confirmDialog({
    title: '恢复默认配置',
    message: `确定把「${group ? group.label || group.key : groupKey}」分组恢复为默认值吗？该分组在后台做的修改会被清除。`,
    confirmText: '恢复默认',
    cancelText: '取消',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await apiFetch('/api/admin/settings/reset', { method: 'POST', body: { group: groupKey } });
    toast(`「${group ? group.label || group.key : groupKey}」已恢复默认`, 'success');
    showSettingsRestartNote([]);
    await loadSettings();
  } catch (error) {
    toastError(error, '恢复默认配置失败');
  }
}

/**
 * 重启容器：POST /api/admin/system/restart（依赖 docker compose restart: unless-stopped）。
 * 返回 202 后轮询 /health，恢复后自动刷新页面。
 */
export async function restartContainer() {
  const confirmed = await confirmDialog({
    title: '重启容器',
    message: '重启期间后台将短暂不可用（通常 5-15 秒）。请确认需要重启生效的配置已保存。确定现在重启吗？',
    confirmText: '确认重启',
    cancelText: '取消',
    danger: true,
  });
  if (!confirmed) return;
  setButtonLoading(els.settingsRestartContainerButton, true, '重启中…');
  try {
    await apiFetch('/api/admin/system/restart', { method: 'POST' });
    toast('容器正在重启，等待服务恢复后自动刷新…', 'info', 8000);
    const recovered = await waitForHealth(40000);
    if (recovered) {
      window.location.reload();
      return;
    }
    toastError('等待服务恢复超时，请手动刷新页面或检查容器状态', '重启超时');
  } catch (error) {
    toastError(error, '重启容器失败');
  } finally {
    setButtonLoading(els.settingsRestartContainerButton, false);
  }
}

/** 轮询 /health 直到恢复（最多 timeoutMs）。 */
async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('/health', { cache: 'no-store' });
      if (response.ok) return true;
    } catch { /* 重启中，继续等待 */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function renderEnvOnly() {
  if (!els.settingsEnvOnly) return;
  clearNode(els.settingsEnvOnly);
  const items = state.settings.envOnly;
  if (!Array.isArray(items) || items.length === 0) {
    els.settingsEnvOnly.append(el('p', { class: 'empty-text', text: '无（所有配置均可在后台修改）' }));
    return;
  }
  for (const item of items) {
    if (typeof item === 'string') {
      appendKv(els.settingsEnvOnly, item, '只读（.env）');
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    appendKv(
      els.settingsEnvOnly,
      item.label || item.key || '—',
      item.value === undefined || item.value === null ? '只读（.env）' : String(item.value),
      { tone: item.secret === true || item.masked === true ? 'warning' : null },
    );
  }
}

function renderServiceInfo(config) {
  if (!els.configList) return;
  const data = config && typeof config === 'object' ? config : {};
  clearNode(els.configList);
  appendKv(els.configList, '服务版本', data.version);
  appendKv(els.configList, '数据目录', data.dataDir);
  appendKv(
    els.configList,
    '推送 API',
    data.pushApiEnabled === true ? '已启用' : data.pushApiEnabled === false ? '已禁用' : null,
    { tone: data.pushApiEnabled === false ? 'warning' : 'success' },
  );
  appendKv(els.configList, 'API Key 预览', data.apiTokenPreview || '（推送 API 未启用）');
}

/** 机密来源：不再兼容 env/文件回退，管理密码与 API Token 始终由数据库管理。 */
function securitySourceLabel() {
  return '数据库';
}

function renderSecurityCard() {
  if (!els.securityCard) return;
  const security = state.settings.security;
  if (!state.settings.available || !security) {
    setHidden(els.securityCard, true);
    return;
  }
  setHidden(els.securityCard, false);
  if (els.securityTokenPreview) {
    els.securityTokenPreview.textContent = security.apiTokenPreview || '（无 Token / 推送 API 未启用）';
  }
  if (els.securityTokenSource) {
    els.securityTokenSource.textContent = securitySourceLabel();
  }
  if (els.securityPasswordSource) {
    els.securityPasswordSource.textContent = securitySourceLabel();
  }
  const pushEnabled = security.pushApiEnabled === true;
  if (els.securityPushToggle) {
    els.securityPushToggle.classList.toggle('is-on', pushEnabled);
    els.securityPushToggle.setAttribute('aria-checked', pushEnabled ? 'true' : 'false');
    const label = els.securityPushToggle.querySelector('.switch-label');
    if (label) label.textContent = pushEnabled ? '已启用' : '未启用';
  }
  clearInlineError(els.securityError);
}

function showSecurityError(message) {
  if (els.securityError) showInlineError(els.securityError, message);
}

export async function toggleSecurityPushApi() {
  if (!state.settings.security) return;
  const next = state.settings.security.pushApiEnabled !== true;
  if (els.securityPushToggle) els.securityPushToggle.disabled = true;
  try {
    await apiFetch('/api/admin/settings', {
      method: 'PATCH',
      body: { security: { pushApiEnabled: next } },
    });
    toast(`推送 API 已${next ? '启用' : '禁用'}`, 'success');
    await loadSettings();
  } catch (error) {
    toastError(error, '更新推送 API 开关失败');
  } finally {
    if (els.securityPushToggle) els.securityPushToggle.disabled = false;
  }
}

export async function changeAdminPassword() {
  clearInlineError(els.securityError);
  const currentPassword = els.securityCurrentPassword.value;
  const newPassword = els.securityNewPassword.value;
  const confirmPassword = els.securityConfirmPassword.value;
  if (!currentPassword) {
    showSecurityError('请输入当前密码');
    els.securityCurrentPassword.focus();
    return;
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    showSecurityError('新密码长度必须是 8-128 个字符');
    els.securityNewPassword.focus();
    return;
  }
  if (newPassword !== confirmPassword) {
    showSecurityError('两次输入的新密码不一致');
    els.securityConfirmPassword.focus();
    return;
  }
  setButtonLoading(els.securityPasswordChangeButton, true, '修改中…');
  try {
    await apiFetch('/api/admin/security/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    });
    toast('管理密码已修改（已登录会话不会强制下线）', 'success');
    els.securityCurrentPassword.value = '';
    els.securityNewPassword.value = '';
    els.securityConfirmPassword.value = '';
    await loadSettings();
  } catch (error) {
    showSecurityError(error && error.message ? error.message : '修改密码失败');
    if (error && error.status !== 400 && error.status !== 401) toastError(error, '修改密码失败');
  } finally {
    setButtonLoading(els.securityPasswordChangeButton, false);
  }
}

export async function resetAdminPassword() {
  clearInlineError(els.securityError);
  const currentPassword = els.securityCurrentPassword.value;
  if (!currentPassword) {
    showSecurityError('重置为随机密码需要输入当前密码');
    els.securityCurrentPassword.focus();
    return;
  }
  const confirmed = await confirmDialog({
    title: '重置为随机密码',
    message:
      '将生成一个新的随机管理密码并写入 data/admin-password.txt；旧密码立即失效，已登录会话不受影响。确定继续？',
    confirmText: '重置为随机密码',
    cancelText: '取消',
    danger: true,
  });
  if (!confirmed) return;
  setButtonLoading(els.securityPasswordResetButton, true, '重置中…');
  try {
    const data = await apiFetch('/api/admin/security/password/reset', {
      method: 'POST',
      body: { currentPassword },
    });
    const password = data && typeof data === 'object' ? data.password || data.newPassword || '' : '';
    els.securityCurrentPassword.value = '';
    els.securityNewPassword.value = '';
    els.securityConfirmPassword.value = '';
    if (password) {
      showSecretRevealModal({
        title: '新的管理密码（仅显示一次）',
        value: String(password),
        warning:
          '请立即复制保存：关闭本弹窗后无法再次查看该密码；新密码已写入 data/admin-password.txt，旧密码已立即失效。',
        hint: '密码以 scrypt 哈希保存在数据库，页面不再回显明文；重置会生成新的随机密码。',
        copyLabel: '复制密码',
        copyToast: '新密码已复制到剪贴板',
      });
    } else {
      toast('已重置为随机密码（后端未返回明文，请查看 data/admin-password.txt）', 'warning');
    }
    await loadSettings();
  } catch (error) {
    showSecurityError(error && error.message ? error.message : '重置密码失败');
    if (error && error.status !== 400 && error.status !== 401) toastError(error, '重置密码失败');
  } finally {
    setButtonLoading(els.securityPasswordResetButton, false);
  }
}

export async function rotateApiToken() {
  clearInlineError(els.securityError);
  const confirmed = await confirmDialog({
    title: '重新生成 API Token',
    message: '重新生成后旧 Token 立即失效，所有使用旧 Token 的外部调用都会返回 401。确定继续？',
    confirmText: '重新生成',
    cancelText: '取消',
    danger: true,
  });
  if (!confirmed) return;
  setButtonLoading(els.securityTokenRotateButton, true, '生成中…');
  try {
    const data = await apiFetch('/api/admin/security/api-token/rotate', { method: 'POST' });
    const token = data && typeof data === 'object'
      ? data.token || data.apiToken || data.newToken || ''
      : '';
    const preview = data && typeof data === 'object' ? data.preview || data.apiTokenPreview || '' : '';
    if (!token) {
      toast('Token 已重新生成，但后端未返回明文（请检查接口契约）', 'warning');
    } else {
      showTokenRevealModal(String(token), preview ? String(preview) : '');
    }
    await loadSettings();
  } catch (error) {
    showSecurityError(error && error.message ? error.message : '重新生成 Token 失败');
    toastError(error, '重新生成 Token 失败');
  } finally {
    setButtonLoading(els.securityTokenRotateButton, false);
  }
}

export async function resetApiToken() {
  clearInlineError(els.securityError);
  const confirmed = await confirmDialog({
    title: '重置 Token',
    message:
      '将生成一个新的 API Token 并写入 data/api-token.txt；旧 Token 立即失效，所有使用旧 Token 的外部调用会返回 401。确定继续？',
    confirmText: '重置 Token',
    cancelText: '取消',
    danger: true,
  });
  if (!confirmed) return;
  setButtonLoading(els.securityTokenResetButton, true, '重置中…');
  try {
    const data = await apiFetch('/api/admin/security/api-token/reset', { method: 'POST' });
    const token = data && typeof data === 'object' ? data.token || data.apiToken || data.newToken || '' : '';
    const preview = data && typeof data === 'object' ? data.preview || data.apiTokenPreview || '' : '';
    if (token) {
      showTokenRevealModal(String(token), preview ? String(preview) : '');
    } else {
      toast('Token 已重置（后端未返回明文，请查看 data/api-token.txt）', 'warning');
    }
    await loadSettings();
  } catch (error) {
    showSecurityError(error && error.message ? error.message : '重置 Token 失败');
    toastError(error, '重置 Token 失败');
  } finally {
    setButtonLoading(els.securityTokenResetButton, false);
  }
}

/** 运行配置/安全卡片事件绑定（首次进入运行配置视图时加载，幂等）。 */
let settingsViewBound = false;
export function initSettingsView() {
  if (settingsViewBound) return;
  settingsViewBound = true;
  els.settingsSaveButton.addEventListener('click', () => {
    saveSettings().catch(loadErrorHandler('保存运行配置失败'));
  });
  els.settingsGroups.addEventListener('input', handleSettingsInput);
  els.settingsGroups.addEventListener('change', handleSettingsInput);
  els.settingsGroups.addEventListener('click', handleSettingsClick);
  els.settingsRestartContainerButton.addEventListener('click', () => {
    restartContainer().catch(loadErrorHandler('重启容器失败'));
  });
  // 安全卡片：管理密码 / API Token / 推送 API 开关
  els.securityPushToggle.addEventListener('click', () => {
    toggleSecurityPushApi().catch(loadErrorHandler('更新推送 API 开关失败'));
  });
  els.securityTokenRotateButton.addEventListener('click', () => {
    rotateApiToken().catch(loadErrorHandler('重新生成 Token 失败'));
  });
  els.securityTokenResetButton.addEventListener('click', () => {
    resetApiToken().catch(loadErrorHandler('恢复 Token 失败'));
  });
  els.securityPasswordChangeButton.addEventListener('click', () => {
    changeAdminPassword().catch(loadErrorHandler('修改密码失败'));
  });
  els.securityPasswordResetButton.addEventListener('click', () => {
    resetAdminPassword().catch(loadErrorHandler('恢复密码失败'));
  });
}
