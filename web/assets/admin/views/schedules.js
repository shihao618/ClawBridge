/**
 * 接口应用视图（定时通知 Tab）：任务列表/CRUD、任务编辑器、测试/立即执行与日志弹窗。
 */

import { SCHEDULE_STATUS_META } from '../constants.js';
import { els, state } from '../state.js';
import { buildTemplateTools } from '../templates.js';
import { buildRequestRow, buildResponseRow, buildSwitch, createTableClickHandler, emptyRow, formField, formSection, rowActionButton } from '../ui.js';
import { apiFetch, clearNode, confirmDialog, el, formatDateTime, formatNumber, formatRelative, setHidden, toast, toastError } from '../../common.js';
import { schedulePlanSummary as formatSchedulePlanSummary, scheduleTargetSummary } from '../../lib/summary.js';
import { createPickerSection } from '../integrations/pickers.js';
import { createHeaderModeField } from '../integrations/header-mode.js';
import { openTestRunModal } from '../integrations/test-modal.js';
import { openLogsModal } from '../integrations/logs-modal.js';
import { createBodyTemplateField, createResponseInputs } from '../integrations/response-section.js';
import { createFormError, createSaveAction, openEditorModal } from '../integrations/editor-shell.js';
import { loadPickerUsers } from './users.js';

export async function loadScheduledTasks() {
  initSchedulesView();
  const data = await apiFetch('/api/admin/scheduled-tasks');
  state.scheduled.items = data && Array.isArray(data.items) ? data.items : [];
  state.scheduled.loaded = true;
  const timezone = state.scheduled.items.find((task) => task?.schedule?.timezone)?.schedule.timezone;
  if (timezone) state.scheduled.timezone = timezone;
  renderScheduledTasks();
}

function scheduleTimezone() {
  return state.scheduled.timezone || 'Asia/Shanghai';
}

function schedulePlanSummary(task) {
  return formatSchedulePlanSummary(task, scheduleTimezone());
}

function renderScheduledTasks() {
  if (!els.scheduleTableBody) return;
  if (els.scheduleTotal) {
    els.scheduleTotal.textContent = `共 ${formatNumber(state.scheduled.items.length)} 个任务`;
  }
  clearNode(els.scheduleTableBody);
  if (state.scheduled.items.length === 0) {
    els.scheduleTableBody.append(
      emptyRow(7, '暂无定时任务，点击「＋ 新建任务」创建（例如每天 8:00 推送天气）'),
    );
    return;
  }
  for (const task of state.scheduled.items) els.scheduleTableBody.append(buildScheduledTaskRow(task));
}

function buildScheduledSwitch(task) {
  const enabled = task.enabled === true;
  return buildSwitch({
    enabled,
    ariaLabel: `定时任务「${task.name || task.id}」启用开关`,
    dataset: { action: 'schedule-toggle', taskId: task.id, enabled: enabled ? '1' : '0' },
    title: enabled ? '任务已启用（点击停用）' : '任务已停用（点击启用）',
    onLabel: '启用',
    offLabel: '停用',
  });
}

function buildScheduledTaskRow(task) {
  const schedule = task.schedule && typeof task.schedule === 'object' ? task.schedule : {};
  const statusMeta = SCHEDULE_STATUS_META[task.lastStatus] || null;
  const lastRunCell = el('td', { class: 'cell-nowrap' });
  if (Number(task.lastRunAt) > 0) {
    lastRunCell.append(
      el('div', { text: formatRelative(task.lastRunAt) }),
      statusMeta
        ? el('div', {}, el('span', { class: `badge ${statusMeta.className}`, text: statusMeta.label }))
        : null,
    );
  } else {
    lastRunCell.append(el('span', { class: 'cell-muted', text: '尚未执行' }));
  }
  const nextRunCell = el('td', { class: 'cell-nowrap' });
  if (Number(task.nextRunAt) > 0) {
    nextRunCell.append(
      el('div', { text: formatDateTime(task.nextRunAt) }),
      el('div', { class: 'cell-muted', text: formatRelative(task.nextRunAt) }),
    );
  } else {
    nextRunCell.append(el('span', { class: 'cell-muted', text: schedule.type === 'daily' ? '待调度' : '—' }));
  }
  return el(
    'tr',
    {},
    el('td', { class: 'cell-rule-enabled' }, buildScheduledSwitch(task)),
    el(
      'td',
      {},
      el('div', { class: 'cell-strong', text: task.name || '（未命名任务）' }),
      el('div', { class: 'cell-muted cell-mono', text: task.id }),
      el('div', { class: 'cell-muted', text: `${task.request?.method || 'GET'} ${task.request?.url || ''}` }),
    ),
    el('td', { class: 'cell-nowrap schedule-plan', text: schedulePlanSummary(task) }),
    el('td', { class: 'schedule-target', text: scheduleTargetSummary(task) }),
    lastRunCell,
    nextRunCell,
    el(
      'td',
      {},
      el(
        'div',
        { class: 'row-actions' },
        scheduleActionButton('schedule-edit', task.id, '编辑'),
        scheduleActionButton('schedule-duplicate', task.id, '复制'),
        scheduleActionButton('schedule-test', task.id, '测试'),
        scheduleActionButton('schedule-run', task.id, '执行'),
        scheduleActionButton('schedule-logs', task.id, '日志'),
        scheduleActionButton('schedule-delete', task.id, '删除', 'btn-danger-ghost'),
      ),
    ),
  );
}

function scheduleActionButton(action, taskId, label, extraClass = '') {
  return rowActionButton(action, taskId, label, { datasetKey: 'taskId', extraClass });
}

async function toggleScheduledTask(task, button) {
  const nextEnabled = task.enabled !== true;
  if (button) button.disabled = true;
  try {
    await apiFetch(`/api/admin/scheduled-tasks/${encodeURIComponent(task.id)}`, {
      method: 'PATCH',
      body: { enabled: nextEnabled },
    });
    toast(`定时任务「${task.name || task.id}」已${nextEnabled ? '启用' : '停用'}`, 'success');
    await loadScheduledTasks();
  } catch (error) {
    toastError(error, '更新定时任务状态失败');
    if (button) button.disabled = false;
  }
}

export const handleScheduleTableClick = createTableClickHandler({
  find: (button) => state.scheduled.items.find((item) => item.id === button.dataset.taskId),
  actions: {
    'schedule-toggle': (task, button) => toggleScheduledTask(task, button),
    'schedule-edit': (task) => openScheduleEditor(task),
    'schedule-duplicate': (task, button) => duplicateScheduledTask(task, button),
    'schedule-test': (task) => openScheduleTestModal(task),
    'schedule-run': (task) => runScheduledTask(task),
    'schedule-logs': (task) => openScheduleLogsModal(task),
    'schedule-delete': (task) => deleteScheduledTask(task),
  },
});

async function duplicateScheduledTask(task, button) {
  if (button) button.disabled = true;
  try {
    const data = await apiFetch(`/api/admin/scheduled-tasks/${encodeURIComponent(task.id)}/duplicate`, {
      method: 'POST',
    });
    const name = data && data.task && data.task.name ? data.task.name : '副本';
    toast(`定时任务已复制为「${name}」，副本默认停用`, 'success');
    await loadScheduledTasks();
  } catch (error) {
    toastError(error, '复制定时任务失败');
    if (button) button.disabled = false;
  }
}

async function deleteScheduledTask(task) {
  const confirmed = await confirmDialog({
    title: '删除定时任务',
    message: `确定删除定时任务「${task.name || task.id}」吗？删除后不再执行，运行日志保留。`,
    confirmText: '删除任务',
    cancelText: '取消',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await apiFetch(`/api/admin/scheduled-tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
    toast('定时任务已删除', 'success');
    await loadScheduledTasks();
  } catch (error) {
    toastError(error, '删除定时任务失败');
  }
}

export async function openScheduleEditor(task = null) {
  const isEdit = Boolean(task && task.id);
  const source = isEdit ? task : {};
  const schedule = source.schedule && typeof source.schedule === 'object' ? source.schedule : {};
  const targets = source.targets && typeof source.targets === 'object' ? source.targets : {};
  const request = source.request && typeof source.request === 'object' ? source.request : {};
  const response = source.response && typeof source.response === 'object' ? source.response : {};
  const limits = source.limits && typeof source.limits === 'object' ? source.limits : {};
  const headerNames = Array.isArray(request.headerNames) ? request.headerNames.filter(Boolean) : [];
  const timezone = schedule.timezone || scheduleTimezone();

  let pickerUsers = [];
  try {
    pickerUsers = await loadPickerUsers();
  } catch {
    pickerUsers = state.users.items;
  }

  const nameInput = el('input', {
    id: 'schedule-name-input',
    class: 'input',
    type: 'text',
    maxlength: '60',
    placeholder: '例如：每天天气推送',
    value: typeof source.name === 'string' ? source.name : '',
  });
  const enabledInput = el('input', {
    id: 'schedule-enabled-input',
    type: 'checkbox',
    // 新建默认不勾选（文档/UI 承诺「默认不启用」）；编辑保留原值。
    checked: isEdit ? source.enabled === true : false,
  });

  // 计划
  let scheduleType = schedule.type === 'daily' ? 'daily' : 'interval';
  const typeSelect = el(
    'select',
    { id: 'schedule-type', class: 'select' },
    el('option', { value: 'interval', text: '按间隔（每 N 分钟）', selected: scheduleType === 'interval' }),
    el('option', { value: 'daily', text: '每日定时（HH:mm）', selected: scheduleType === 'daily' }),
  );
  const defaultIntervalMinutes = Math.max(
    1,
    Math.round(Number(schedule.intervalMs || 3600000) / 60000),
  );
  const intervalMinutesInput = el('input', {
    id: 'schedule-interval-minutes',
    class: 'input input-narrow',
    type: 'number',
    min: '1',
    max: '43200',
    step: '1',
    value: String(defaultIntervalMinutes),
  });
  const dailyTimeInput = el('input', {
    id: 'schedule-daily-time',
    class: 'input input-narrow',
    type: 'time',
    value: schedule.dailyTime || '08:00',
  });
  const intervalField = formField('间隔（分钟，1–43200）', intervalMinutesInput, '最小 1 分钟；例如 60 = 每小时一次。', 'schedule-interval-minutes');
  const dailyField = formField('每日时间（HH:mm）', dailyTimeInput, `按服务端时区 ${timezone} 执行；错过后启动时补跑一次。`, 'schedule-daily-time');
  // interval 可选「每日生效时间段」（windowStart/windowEnd，HH:mm，成对可空，支持跨午夜）
  const windowStartInput = el('input', {
    id: 'schedule-window-start',
    class: 'input input-narrow',
    type: 'time',
    value: typeof schedule.windowStart === 'string' ? schedule.windowStart : '',
  });
  const windowEndInput = el('input', {
    id: 'schedule-window-end',
    class: 'input input-narrow',
    type: 'time',
    value: typeof schedule.windowEnd === 'string' ? schedule.windowEnd : '',
  });
  const windowField = el(
    'div',
    { class: 'form-field' },
    el('span', { class: 'form-label', text: '每日生效时间段（可选，仅间隔计划）' }),
    el(
      'div',
      { class: 'form-grid-2' },
      formField('开始时间（HH:mm）', windowStartInput, null, 'schedule-window-start'),
      formField('结束时间（HH:mm）', windowEndInput, '结束分钟也包含；如 09:00–10:30 在 09:00 / 09:30 / 10:00 / 10:30 触发。支持跨午夜，如 22:00–06:00。', 'schedule-window-end'),
    ),
    el('p', {
      class: 'form-hint',
      text: '留空=全天生效；两个时间需同时填写或同时留空，开始时间不能等于结束时间。结束分钟也会发送（区间为 [开始, 结束]）。',
    }),
  );
  const timezoneHint = el('p', { class: 'form-hint', text: `当前时区：${timezone}（由服务端 SCHEDULER_TIMEZONE 决定）` });
  function syncScheduleFields() {
    setHidden(intervalField, scheduleType !== 'interval');
    setHidden(windowField, scheduleType !== 'interval');
    setHidden(dailyField, scheduleType !== 'daily');
  }
  typeSelect.addEventListener('change', () => {
    scheduleType = typeSelect.value === 'daily' ? 'daily' : 'interval';
    syncScheduleFields();
  });
  syncScheduleFields();

  // 目标（用户/分组多选与其他编辑器共用 integrations/pickers.js）
  const picker = createPickerSection({
    prefix: 'schedule',
    radioName: 'schedule-target-type',
    typeOrder: ['users', 'groups', 'all'],
    typeLabels: { all: '全部用户', users: '指定用户', groups: '指定分组' },
    initialType: targets.type === 'all' ? 'all' : targets.type === 'groups' ? 'groups' : 'users',
    normalizeType: (value) => (['all', 'groups', 'users'].includes(value) ? value : 'users'),
    initialUserIds: targets.type === 'users' && Array.isArray(targets.ids) ? targets.ids.map(String) : [],
    initialGroupIds: targets.type === 'groups' && Array.isArray(targets.ids) ? targets.ids.map(String) : [],
    users: () => pickerUsers,
    userDatasetKey: 'scheduleUserId',
    groupDatasetKey: 'scheduleGroupId',
    stringifyIds: true,
    withPickerActions: true,
  });

  // 请求
  const methodSelect = el(
    'select',
    { id: 'schedule-request-method', class: 'select' },
    ...['GET', 'POST'].map((method) =>
      el('option', { value: method, text: method, selected: (request.method || 'GET') === method }),
    ),
  );
  const urlInput = el('input', {
    id: 'schedule-request-url',
    class: 'input',
    type: 'text',
    placeholder: 'https://api.example.com/weather?city=北京（支持 {now}/{date}/{time}/{taskName}）',
    value: request.url || '',
  });
  // Header 处理（掩码/重设/清空 + 提交校验与其他编辑器共用 integrations/header-mode.js）
  const headerCtrl = createHeaderModeField({
    prefix: 'schedule',
    isEdit,
    headerNames,
    entityLabel: '任务',
  });
  const bodyTemplateField = createBodyTemplateField({
    prefix: 'schedule',
    request,
    placeholder: 'POST 请求体模板（支持 {now}/{date}/{time}/{taskName}）；仅 POST 显示，GET 参数请写在 URL 中',
    methodSelect,
  });
  const bodyField = bodyTemplateField.field;
  const bodyTemplateInput = bodyTemplateField.input;
  function syncScheduleRequestFields() {
    bodyTemplateField.sync();
  }
  methodSelect.addEventListener('change', syncScheduleRequestFields);
  syncScheduleRequestFields();

  // 响应
  const { responseTypeSelect, responsePathInput, replyTemplateInput, fallbackInput, timeoutInput } = createResponseInputs({
    prefix: 'schedule',
    response,
    limits,
    pathPlaceholder: '例如：data.weather（点路径，可含数组下标）',
    templatePlaceholder: '例如：{{city}} 今天 {{weather}}，{{temp_min}}~{{temp_max}}℃（支持 {{路径}}/{{response}}/{{raw}}）',
    fallbackPlaceholder: '接口失败时的兜底通知文案（为空则本次不发送）',
  });

  const formError = createFormError('schedule-form-error');
  const errorNode = formError.node;
  const showFormError = formError.show;

  const content = [
    formSection(
      '基本信息',
      null,
      el('label', { class: 'check-field' }, enabledInput, el('span', { class: 'check-field-text' }, el('strong', { text: '启用任务' }), el('span', { class: 'form-hint', text: '停用后调度器不再自动执行，也可手动「立即执行」。' }))),
      el(
        'div',
        { class: 'rule-form-grid' },
        formField('任务名称（必填，1-60 字符）', nameInput, null, 'schedule-name-input', { span: 3 }),
      ),
      errorNode,
    ),
    formSection(
      '计划',
      '间隔任务从上次执行时间 + 间隔计算下次；每日任务按服务端时区 HH:mm 执行。',
      el(
        'div',
        { class: 'schedule-plan-main-row' },
        formField('计划类型', typeSelect, null, 'schedule-type'),
        intervalField,
        dailyField,
      ),
      windowField,
      timezoneHint,
    ),
    formSection(
      '目标',
      '通知发送给全部用户、指定用户或指定分组的 active 用户（去重，受服务端单次收件上限约束）。',
      el('div', { class: 'radio-list rule-radio-row' }, ...picker.radios),
      picker.userPicker,
      picker.groupPicker,
    ),
    formSection(
      '请求',
      'URL / Header / Body 支持内置变量 {now}/{date}/{time}/{taskName}；GET 参数写在 URL 查询串，POST 可用 URL 查询参数 + Body（Body 可留空）。默认拒绝内网/本机（SSRF 防护）。',
      buildRequestRow({
        prefix: 'schedule',
        methodSelect,
        urlInput,
        urlLabel: '请求 URL（必填，http/https）',
      }),
      headerCtrl.modeField,
      headerCtrl.listField,
      bodyField,
    ),
    formSection(
      '响应与通知',
      null,
      buildResponseRow({
        prefix: 'schedule',
        responseTypeSelect,
        responsePathInput,
        pathHint: 'response.type=json 时按点路径取值。',
      }),
      formField('通知模板（Markdown）', replyTemplateInput, '按 Markdown 发送：支持标题、粗体、列表、代码块、表格；可混用 {{变量}}。', 'schedule-reply-template', { span: 3 }),
      el('div', { class: 'form-row-between' },
        el('span', { class: 'form-hint', text: '可粘贴示例响应离线预览；点击「模板语法」查看变量与 Markdown 规则。' }),
        buildTemplateTools({
          templateInput: replyTemplateInput,
          responseTypeSelect,
          responsePathInput,
          fallbackInput,
          previewTitle: '预览通知',
        }),
      ),
      el('div', { class: 'rule-form-grid' },
        formField('兜底文案', fallbackInput, '接口失败/解析失败时发给全部目标；为空则不发送。', 'schedule-fallback', { span: 2 }),
        formField('超时（ms，1000-30000）', timeoutInput, null, 'schedule-timeout', { span: 1 }),
      ),
    ),
  ];

  openEditorModal({
    title: isEdit ? '编辑定时任务' : '新建定时任务',
    content,
    saveLabel: isEdit ? '保存' : '创建',
    onSave: createSaveAction({
          isEdit,
          nameLabel: '任务',
          toastLabel: '定时任务',
          itemPath: () => `/api/admin/scheduled-tasks/${encodeURIComponent(task.id)}`,
          collectionPath: '/api/admin/scheduled-tasks',
          refresh: () => loadScheduledTasks(),
          errorNode,
          showFormError,
          getName: () => nameInput.value.trim(),
          fallbackError: '保存定时任务失败',
          buildPayload: (name) => {
          let schedulePayload;
          if (scheduleType === 'interval') {
            const minutes = Number(intervalMinutesInput.value);
            if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43200) {
              return showFormError('间隔必须是 1–43200 的整数分钟');
            }
            const windowStart = String(windowStartInput.value || '').trim();
            const windowEnd = String(windowEndInput.value || '').trim();
            if ((windowStart && !windowEnd) || (!windowStart && windowEnd)) {
              return showFormError('生效时间段需同时填写开始与结束时间');
            }
            if (windowStart && windowEnd && windowStart === windowEnd) {
              return showFormError('生效时间段的开始与结束时间不能相同');
            }
            schedulePayload = {
              type: 'interval',
              intervalMs: minutes * 60000,
              windowStart,
              windowEnd,
            };
          } else {
            const dailyTime = String(dailyTimeInput.value || '').trim();
            if (!/^\d{2}:\d{2}$/.test(dailyTime)) return showFormError('每日时间格式必须是 HH:mm');
            schedulePayload = { type: 'daily', dailyTime };
          }
          const targetType = picker.getType();
          const ids = targetType === 'all'
            ? []
            : targetType === 'users'
              ? [...picker.selectedUserIds]
              : [...picker.selectedGroupIds];
          if (targetType !== 'all' && ids.length === 0) {
            return showFormError(targetType === 'users' ? '请至少选择一位用户' : '请至少选择一个分组');
          }
          const url = urlInput.value.trim();
          if (!/^https?:\/\//i.test(url)) return showFormError('请求 URL 必须是 http(s) 地址');
          const headerResult = headerCtrl.readHeaderPayload();
          if (headerResult.error) return showFormError(headerResult.error);
          const headersPayload = headerResult.headers;
          const requestBody = { method: methodSelect.value, url };
          if (headersPayload !== undefined) requestBody.headers = headersPayload;
          if (methodSelect.value === 'POST') requestBody.bodyTemplate = bodyTemplateInput.value;
          const timeoutMs = Number(timeoutInput.value);
          if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
            return showFormError('超时必须是 1000–30000 毫秒');
          }
          const payload = {
            name,
            enabled: enabledInput.checked,
            schedule: schedulePayload,
            targets: { type: targetType, ids },
            request: requestBody,
            response: {
              type: responseTypeSelect.value,
              path: responsePathInput.value.trim(),
              template: replyTemplateInput.value,
              fallbackText: fallbackInput.value,
            },
            timeoutMs,
          };
          return { payload };
          },
        }),
  });
}

async function openScheduleTestModal(task) {
  openTestRunModal({
    title: `测试运行：${task.name || task.id}`,
    hint: '测试运行会真实调用外部接口并渲染通知文本，但不会发送给任何用户、也不写运行日志。',
    resultId: 'schedule-test-result',
    runPath: `/api/admin/scheduled-tasks/${encodeURIComponent(task.id)}/test`,
    buildRequestBody: () => ({}),
    buildResultNodes: buildScheduleTestResultNodes,
  });
}

function buildScheduleTestResultNodes(result) {
  const data = result && typeof result === 'object' ? result : {};
  const request = data.request && typeof data.request === 'object' ? data.request : {};
  const headerNames = Array.isArray(request.headerNames) ? request.headerNames : [];
  const nodes = [
    el(
      'div',
      { class: 'rule-test-head' },
      el('span', { class: 'badge badge-info', text: '测试运行' }),
      el('span', { class: 'badge badge-soft badge-muted', text: '不会发送给用户' }),
      el('span', { class: 'badge badge-soft badge-success', text: `收件人数：${formatNumber(Number(data.recipientsCount) || 0)}` }),
    ),
  ];
  if (data.error) nodes.push(el('p', { class: 'alert alert-warning', text: `错误：${data.error}` }));
  nodes.push(
    el(
      'div',
      { class: 'rule-test-grid' },
      el('div', { class: 'rule-test-item' }, el('span', { class: 'kv-label', text: 'HTTP 状态 / 耗时' }), el('span', { class: 'kv-value', text: `${data.httpStatus ?? '—'} / ${data.latencyMs === undefined || data.latencyMs === null ? '—' : `${data.latencyMs} ms`}` })),
      el('div', { class: 'rule-test-item' }, el('span', { class: 'kv-label', text: '请求方法 / URL' }), el('div', { class: 'rule-test-request', text: `${request.method || 'GET'} ${request.url || ''}` })),
    ),
    el(
      'div',
      { class: 'rule-test-item' },
      el('span', { class: 'kv-label', text: 'Header（只显示名称，值已隐藏）' }),
      el('div', { class: 'cell-muted', text: headerNames.length > 0 ? headerNames.map((name) => `${name}: ••••••`).join('；') : '无' }),
    ),
    request.bodyPreview
      ? el('div', { class: 'rule-test-item' }, el('span', { class: 'kv-label', text: '请求体预览' }), el('pre', { class: 'json-preview', text: String(request.bodyPreview) }))
      : null,
    el('div', { class: 'rule-test-item' }, el('span', { class: 'kv-label', text: '响应预览' }), el('pre', { class: 'json-preview', text: data.responsePreview || '（空）' })),
    data.responseHeaders
      ? el('div', { class: 'rule-test-item' }, el('span', { class: 'kv-label', text: '响应头诊断' }), el('pre', { class: 'json-preview', text: JSON.stringify(data.responseHeaders, null, 2) }))
      : null,
    el('div', { class: 'alert alert-success' },
      el('strong', { text: '将发送的通知文本：' }),
      el('div', { class: 'rule-test-reply', text: data.replyText || '（空，将使用兜底文案或本次不发送）' }),
    ),
  );
  return nodes;
}

async function runScheduledTask(task) {
  const confirmed = await confirmDialog({
    title: '立即执行定时任务',
    message: `将立即执行任务「${task.name || task.id}」：真实调用外部接口并把通知发送给目标用户（会占用微信发送限流）。手动执行不会改变下一次定时时间，确定继续？`,
    confirmText: '立即执行',
    cancelText: '取消',
  });
  if (!confirmed) return;
  try {
    const data = await apiFetch(`/api/admin/scheduled-tasks/${encodeURIComponent(task.id)}/run`, {
      method: 'POST',
      body: {},
    });
    const recipients = Number(data && data.recipientsCount);
    const status = data && data.status;
    if (status === 'success') {
      toast(`执行完成：已将 ${formatNumber(Number.isFinite(recipients) ? recipients : 0)} 条通知加入发送队列（微信送达受限流影响；定时计划不变）`, 'success');
    } else if (status === 'skipped') {
      toast(`已跳过执行：${data && data.error ? data.error : '无有效收件人'}`, 'info');
    } else {
      toastError(
        { message: `${data && data.error ? data.error : '外部接口调用失败'}（收件人数：${formatNumber(Number.isFinite(recipients) ? recipients : 0)}）` },
        '执行失败',
      );
    }
    await loadScheduledTasks();
  } catch (error) {
    toastError(error, '立即执行失败');
  }
}

async function openScheduleLogsModal(task) {
  if (!state.scheduled.loaded) {
    try {
      await loadScheduledTasks();
    } catch {
      /* 继续使用现有列表 */
    }
  }
  openLogsModal({
    title: `定时任务运行日志${task && task.name ? `：${task.name}` : ''}`,
    className: 'schedule-logs',
    columns: ['时间', '任务', '状态', 'HTTP', '耗时', '收件人', '错误', '响应预览', '通知预览'],
    ids: {
      tbody: 'schedule-log-table-body',
      pageInfo: 'schedule-log-page-info',
      prev: 'schedule-log-prev',
      next: 'schedule-log-next',
      statusSelect: 'schedule-log-status-filter',
    },
    hintText: '按时间倒序展示执行记录。',
    statusOptions: [
      ['', '全部状态'],
      ['success', '成功'],
      ['failed', '失败'],
      ['skipped', '跳过'],
    ],
    initialExtra: { taskId: task && task.id ? task.id : '' },
    buildToolbarNodes: ({ local, reload }) => {
      const taskSelect = el(
        'select',
        { id: 'schedule-log-task-filter', class: 'select' },
        el('option', { value: '', text: '全部任务' }),
        ...state.scheduled.items.map((item) =>
          el('option', { value: item.id, text: item.name || item.id, selected: item.id === local.taskId }),
        ),
      );
      taskSelect.addEventListener('change', () => {
        local.taskId = taskSelect.value;
        local.offset = 0;
        reload();
      });
      return [taskSelect];
    },
    paramsFor: (local) => {
      const params = new URLSearchParams();
      params.set('limit', String(local.limit));
      params.set('offset', String(local.offset));
      if (local.taskId) params.set('taskId', local.taskId);
      if (local.status) params.set('status', local.status);
      return params;
    },
    endpoint: '/api/admin/scheduled-task-logs',
    renderRow: (log) => {
      const statusMeta = SCHEDULE_STATUS_META[log.status] || { label: log.status || '—', className: 'badge-muted' };
      return el('tr', {},
        el('td', { class: 'cell-nowrap' }, el('div', { text: formatDateTime(log.createdAt) }), el('div', { class: 'cell-muted', text: formatRelative(log.createdAt) })),
        el('td', { class: 'cell-mono', text: log.taskName || log.taskId || '—' }),
        el('td', {}, el('span', { class: `badge ${statusMeta.className}`, text: statusMeta.label })),
        el('td', { class: 'cell-mono', text: log.httpStatus === null || log.httpStatus === undefined ? '—' : String(log.httpStatus) }),
        el('td', { class: 'cell-mono cell-nowrap', text: log.latencyMs === null || log.latencyMs === undefined ? '—' : `${log.latencyMs} ms` }),
        el('td', { class: 'cell-mono', text: formatNumber(Number(log.recipientsCount) || 0) }),
        el('td', { class: 'cell-error', text: log.error || '—' }),
        el('td', { class: 'cell-muted log-preview', title: log.responsePreview || '', text: log.responsePreview || '—' }),
        el('td', { class: 'cell-muted log-preview', title: log.replyPreview || '', text: log.replyPreview || '—' }),
      );
    },
    errorFallback: '加载定时任务日志失败',
  });
}

/** 定时通知 Tab 事件绑定（首次切换到该 Tab 时加载，幂等）。 */
let schedulesViewBound = false;
export function initSchedulesView() {
  if (schedulesViewBound) return;
  schedulesViewBound = true;
  els.createScheduleButton.addEventListener('click', () => openScheduleEditor(null));
  els.scheduleTableBody.addEventListener('click', handleScheduleTableClick);
}
