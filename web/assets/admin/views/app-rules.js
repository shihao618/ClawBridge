/**
 * 接口应用视图（规则 Tab）：规则列表/CRUD、规则编辑器、测试弹窗与运行日志弹窗。
 */

import { MULTI_EXTRACTOR_TYPE_LABELS, RULE_EXTRACTION_LABELS, RULE_RUN_STATUS_META } from '../constants.js';
import { loadErrorHandler, refreshAfterWrite } from '../core.js';
import { els, state } from '../state.js';
import { buildTemplateTools } from '../templates.js';
import { buildRequestRow, buildResponseRow, buildSwitch, createTableClickHandler, emptyRow, formField, formSection, rowActionButton, setupTablist } from '../ui.js';
import { $$, apiFetch, clearNode, confirmDialog, el, formatDateTime, formatNumber, formatRelative, setHidden, toast, toastError } from '../../common.js';
import { parseKeywordsInput } from '../../lib/parse.js';
import { RULE_MATCH_LABELS, RULE_SCOPE_LABELS, scopeSummary, triggerSummary } from '../../lib/summary.js';
import { loadScheduledTasks } from './schedules.js';
import { createPickerSection } from '../integrations/pickers.js';
import { createHeaderModeField } from '../integrations/header-mode.js';
import { openTestRunModal } from '../integrations/test-modal.js';
import { openLogsModal } from '../integrations/logs-modal.js';
import { createBodyTemplateField, createResponseInputs } from '../integrations/response-section.js';
import { createFormError, createSaveAction, openEditorModal } from '../integrations/editor-shell.js';
import { loadPickerUsers } from './users.js';

export async function loadAppRules() {
  initAppRulesView();
  const data = await apiFetch('/api/admin/app-rules?includeDisabled=1');
  state.appRules.items = data && Array.isArray(data.items) ? data.items : [];
  renderAppRules();
}

function filteredAppRules() {
  const filter = state.appRules.filter;
  return state.appRules.items.filter((rule) => {
    if (filter === 'enabled') return rule.enabled === true;
    if (filter === 'disabled') return rule.enabled !== true;
    return true;
  });
}

export function renderAppRules() {
  if (!els.appRuleTableBody) return;
  const items = filteredAppRules();
  if (els.appRulesTotal) {
    els.appRulesTotal.textContent = `共 ${formatNumber(state.appRules.items.length)} 条规则`;
  }
  clearNode(els.appRuleTableBody);
  if (items.length === 0) {
    els.appRuleTableBody.append(
      emptyRow(7, state.appRules.items.length === 0 ? '暂无规则，点击「＋ 新建规则」创建' : '没有匹配的规则'),
    );
    return;
  }
  for (const rule of items) els.appRuleTableBody.append(buildAppRuleRow(rule));
}

function buildRuleSwitch(rule) {
  const enabled = rule.enabled === true;
  return buildSwitch({
    enabled,
    ariaLabel: `规则「${rule.name || rule.id}」启用开关`,
    dataset: { action: 'toggle-rule', ruleId: rule.id, enabled: enabled ? '1' : '0' },
    title: enabled ? '规则已启用（点击禁用）' : '规则已禁用（点击启用）',
    onLabel: '启用',
    offLabel: '禁用',
  });
}

async function toggleAppRule(rule, button) {
  const nextEnabled = rule.enabled !== true;
  if (button) button.disabled = true;
  try {
    await apiFetch(`/api/admin/app-rules/${encodeURIComponent(rule.id)}`, {
      method: 'PATCH',
      body: { enabled: nextEnabled },
    });
    toast(`规则「${rule.name || rule.id}」已${nextEnabled ? '启用' : '禁用'}`, 'success');
    await refreshAfterWrite({ appRules: true });
  } catch (error) {
    toastError(error, '更新规则状态失败');
    if (button) button.disabled = false;
  }
}

function buildAppRuleRow(rule) {
  const stats = rule.stats && typeof rule.stats === 'object' ? rule.stats : {};
  const lastStatus = RULE_RUN_STATUS_META[stats.lastStatus] || null;
  const lastRunCell = el('td', { class: 'cell-nowrap' });
  if (stats.lastRunAt && Number(stats.lastRunAt) > 0) {
    lastRunCell.append(
      el('div', { text: formatRelative(stats.lastRunAt) }),
      lastStatus
        ? el('div', {}, el('span', { class: `badge ${lastStatus.className}`, text: lastStatus.label }))
        : null,
    );
  } else {
    lastRunCell.append(el('span', { class: 'cell-muted', text: '尚未运行' }));
  }

  return el(
    'tr',
    {},
    el('td', { class: 'cell-rule-enabled' }, buildRuleSwitch(rule)),
    el(
      'td',
      {},
      el('div', { class: 'cell-strong', text: rule.name || '（未命名规则）' }),
      el('div', { class: 'cell-muted cell-mono', text: `优先级 ${formatNumber(rule.priority)} · ${rule.id}` }),
      el('div', { class: 'cell-muted', text: triggerSummary(rule.trigger) }),
    ),
    el('td', { class: 'cell-rule-scope', text: scopeSummary(rule.scope) }),
    el(
      'td',
      { class: 'cell-rule-request' },
      ...(rule.request?.mode === 'none' || !rule.request?.url
        ? [
            el('span', { class: 'badge badge-soft badge-info', text: '不请求' }),
            el('div', { class: 'cell-muted rule-url', text: '直接回复默认文本' }),
          ]
        : [
            el('span', { class: `badge badge-soft ${rule.request?.method === 'POST' ? 'badge-group' : 'badge-info'}`, text: rule.request?.method || 'GET' }),
            el('div', { class: 'cell-muted rule-url', title: rule.request?.url || '', text: rule.request?.url || '—' }),
          ]),
    ),
    lastRunCell,
    el('td', {
      class: 'cell-nowrap cell-mono',
      text: `${formatNumber(stats.success24h)} / ${formatNumber(stats.failed24h)} / ${formatNumber(stats.skipped24h)}`,
    }),
    el(
      'td',
      {},
      el(
        'div',
        { class: 'row-actions' },
        ruleActionButton('edit', rule.id, '编辑'),
        ruleActionButton('duplicate', rule.id, '复制'),
        ruleActionButton('test', rule.id, '测试'),
        ruleActionButton('logs', rule.id, '日志'),
        ruleActionButton('delete', rule.id, '删除', 'btn-danger-ghost'),
      ),
    ),
  );
}

function ruleActionButton(action, ruleId, label, extraClass = '') {
  return rowActionButton(action, ruleId, label, { datasetKey: 'ruleId', extraClass });
}

export const handleAppRuleTableClick = createTableClickHandler({
  find: (button) => state.appRules.items.find((item) => item.id === button.dataset.ruleId),
  actions: {
    'toggle-rule': (rule, button) => toggleAppRule(rule, button),
    edit: (rule) => openAppRuleEditor(rule),
    duplicate: (rule, button) => duplicateAppRule(rule, button),
    test: (rule) => openAppRuleTestModal(rule),
    logs: (rule) => openRuleLogsModal(rule),
    delete: (rule) => deleteAppRule(rule),
  },
});

export function openAppRuleEditor(rule = null) {
  const isEdit = Boolean(rule && rule.id);
  const source = isEdit ? rule : {};
  const trigger = source.trigger && typeof source.trigger === 'object' ? source.trigger : {};
  const extraction = source.extraction && typeof source.extraction === 'object' ? source.extraction : {};
  const extractionConfig = extraction.config && typeof extraction.config === 'object' ? extraction.config : {};
  const rawExtractionMode = typeof extraction.mode === 'string' ? extraction.mode : '';
  const uiExtractionMode = rawExtractionMode === 'none' ? 'none' : 'multi';
  const uiExtractionConfig = extractionConfig;

  const request = source.request && typeof source.request === 'object' ? source.request : {};
  const response = source.response && typeof source.response === 'object' ? source.response : {};
  const limits = source.limits && typeof source.limits === 'object' ? source.limits : {};
  const scope = source.scope && typeof source.scope === 'object' ? source.scope : { type: 'all', ids: [] };
  const headerNames = Array.isArray(request.headerNames) ? request.headerNames.filter(Boolean) : [];

  const nameInput = el('input', {
    id: 'rule-name-input',
    class: 'input',
    type: 'text',
    maxlength: '60',
    placeholder: '例如：查天气',
    value: typeof source.name === 'string' ? source.name : '',
  });
  const enabledInput = el('input', {
    id: 'rule-enabled-input',
    type: 'checkbox',
    // 新建默认不勾选（文档/UI 承诺「默认不启用」）；编辑保留原值。
    checked: isEdit ? source.enabled === true : false,
  });
  const priorityInput = el('input', {
    id: 'rule-priority-input',
    class: 'input input-narrow',
    type: 'number',
    min: '0',
    max: '1000000',
    step: '1',
    value: String(Number.isInteger(Number(source.priority)) ? Number(source.priority) : 100),
  });

  // 触发范围（用户/分组多选与其他编辑器共用 integrations/pickers.js）
  const picker = createPickerSection({
    prefix: 'rule',
    radioName: 'rule-scope-type',
    typeOrder: ['all', 'users', 'groups'],
    typeLabels: RULE_SCOPE_LABELS,
    initialType: ['all', 'users', 'groups'].includes(scope.type) ? scope.type : 'all',
    initialUserIds: scope.type === 'users' && Array.isArray(scope.ids) ? scope.ids.map(String) : [],
    initialGroupIds: scope.type === 'groups' && Array.isArray(scope.ids) ? scope.ids.map(String) : [],
    users: () => state.pickerUsers,
    userDatasetKey: 'userId',
    groupDatasetKey: 'groupId',
    hints: {
      user: '可多选；未勾选任何用户时保存会提示错误。',
      group: '可多选；用户属于任一分组即命中。',
    },
  });

  // 触发条件
  const matchModeSelect = el('select', { id: 'rule-match-mode', class: 'select' }, ...Object.entries(RULE_MATCH_LABELS).map(
    ([value, label]) => el('option', { value, text: label, selected: (trigger.matchMode || 'contains') === value }),
  ));
  const keywordsInput = el('textarea', {
    id: 'rule-keywords',
    class: 'textarea',
    rows: '3',
    placeholder: '每行一个关键词，或用逗号分隔（1-10 个，每个最多 50 字）',
    value: Array.isArray(trigger.keywords) ? trigger.keywords.join('\n') : '',
  });
  const regexInput = el('textarea', {
    id: 'rule-regex',
    class: 'textarea',
    rows: '3',
    placeholder: '例如：^查天气\\s*(?<city>\\S+)$',
    value: trigger.regexPattern || '',
  });
  const matchKeywordField = formField('关键词', keywordsInput, '匹配方式为「包含 / 全等」时使用，大小写不敏感。', 'rule-keywords', { span: 3 });
  const matchRegexField = formField('正则表达式', regexInput, '匹配方式为「正则」时使用（u flag，保存时校验合法性）。', 'rule-regex', { span: 3 });
  function syncMatchVisibility() {
    const isRegex = matchModeSelect.value === 'regex';
    setHidden(matchKeywordField, isRegex);
    setHidden(matchRegexField, !isRegex);
  }
  matchModeSelect.addEventListener('change', syncMatchVisibility);
  syncMatchVisibility();

  // 参数提取
  const extractionModeSelect = el(
    'select',
    { id: 'rule-extraction-mode', class: 'select' },
    ...Object.entries(RULE_EXTRACTION_LABELS).map(([value, label]) =>
      el('option', { value, text: label, selected: uiExtractionMode === value }),
    ),
  );
  const extractionConfigBox = el('div', { id: 'rule-extraction-config', class: 'rule-extraction-config' });
  // 多参数提取：可增删多个提取项（trailing / regex / json / fulltext），合并为参数
  const defaultMultiExtractor = () => ({ type: 'trailing', param: 'arg', keyword: '', regex: '', path: '', required: false });
  let multiExtractors = Array.isArray(uiExtractionConfig.extractors)
    ? uiExtractionConfig.extractors.map((item) => ({
        type: typeof item?.type === 'string' ? item.type : 'trailing',
        param: typeof item?.param === 'string' ? item.param : '',
        keyword: typeof item?.keyword === 'string' ? item.keyword : '',
        regex: typeof item?.regex === 'string' ? item.regex : '',
        path: typeof item?.path === 'string' ? item.path : '',
        required: Array.isArray(uiExtractionConfig.required)
          ? uiExtractionConfig.required.includes(item?.param)
          : false,
      }))
    : [];
  if (multiExtractors.length === 0) multiExtractors = [defaultMultiExtractor()];
  function buildMultiExtractorExtra(row, rebuild) {
    if (row.type === 'trailing') {
      const input = el('input', {
        class: 'input multi-extractor-keyword',
        type: 'text',
        maxlength: '50',
        placeholder: '关键词（可选，默认用触发关键词）',
        value: row.keyword || '',
      });
      input.addEventListener('input', () => { row.keyword = input.value; });
      return input;
    }
    if (row.type === 'regex') {
      const input = el('input', {
        class: 'input multi-extractor-regex',
        type: 'text',
        placeholder: '例如：(?<date>\\S+)天气',
        value: row.regex || '',
      });
      input.addEventListener('input', () => { row.regex = input.value; });
      return input;
    }
    if (row.type === 'json') {
      const input = el('input', {
        class: 'input multi-extractor-path',
        type: 'text',
        maxlength: '200',
        placeholder: '路径（可选，如 data.city）',
        value: row.path || '',
      });
      input.addEventListener('input', () => { row.path = input.value; });
      return input;
    }
    return el('span', { class: 'cell-muted', text: '整句文本' });
  }
  function renderMultiExtractorList() {
    clearNode(extractionConfigBox);
    const list = el('div', { class: 'multi-extractor-list' });
    const rebuild = () => renderMultiExtractorList();
    multiExtractors.forEach((row, index) => {
      const typeSelect = el(
        'select',
        { class: 'select multi-extractor-type', 'aria-label': `提取项 ${index + 1} 方式` },
        ...['trailing', 'regex', 'json', 'fulltext'].map((type) =>
          el('option', { value: type, text: MULTI_EXTRACTOR_TYPE_LABELS[type], selected: row.type === type }),
        ),
      );
      typeSelect.addEventListener('change', () => {
        row.type = typeSelect.value;
        rebuild();
      });
      const paramInput = el('input', {
        class: 'input multi-extractor-param',
        type: 'text',
        maxlength: '30',
        placeholder: '参数名（如 city）',
        value: row.param || '',
      });
      paramInput.addEventListener('input', () => { row.param = paramInput.value; });
      const requiredToggle = el(
        'label',
        { class: 'checkbox-inline' },
        el('input', { type: 'checkbox', checked: row.required }),
        el('span', { text: '必填' }),
      );
      requiredToggle.querySelector('input').addEventListener('change', (event) => {
        row.required = event.target.checked;
      });
      const removeButton = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '删除' });
      removeButton.addEventListener('click', () => {
        multiExtractors.splice(index, 1);
        if (multiExtractors.length === 0) multiExtractors.push(defaultMultiExtractor());
        rebuild();
      });
      list.append(
        el(
          'div',
          { class: 'multi-extractor-row' },
          typeSelect,
          paramInput,
          buildMultiExtractorExtra(row, rebuild),
          requiredToggle,
          removeButton,
        ),
      );
    });
    const addButton = el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: '＋ 添加提取项' });
    addButton.addEventListener('click', () => {
      multiExtractors.push(defaultMultiExtractor());
      rebuild();
    });
    extractionConfigBox.append(
      list,
      addButton,
      el('p', {
        class: 'form-hint',
        text: '按顺序逐项提取并合并为参数；正则的命名捕获组会变成多个参数；勾选「必填」的参数缺失时不会调用接口。',
      }),
    );
  }
  function renderExtractionConfig() {
    clearNode(extractionConfigBox);
    const mode = extractionModeSelect.value;
    if (mode === 'multi') {
      renderMultiExtractorList();
    } else {
      extractionConfigBox.append(
        el('p', {
          class: 'form-hint',
          text: '不提取模式：不要求消息中包含参数，直接按 URL/Header/Body 模板调用接口；模板中仍可使用内置变量 {text}、{userId}、{name}、{now}。',
        }),
      );
    }
  }
  extractionModeSelect.addEventListener('change', renderExtractionConfig);
  renderExtractionConfig();

  // 请求
  const initialRequestMode = request.mode === 'none' ? 'none' : 'http';
  const requestModeGroup = el(
    'div',
    { class: 'radio-list rule-radio-row', id: 'rule-request-mode', role: 'radiogroup', 'aria-label': '请求模式' },
    el(
      'label',
      { class: 'radio-inline' },
      el('input', { type: 'radio', name: 'rule-request-mode', value: 'http', checked: initialRequestMode === 'http' }),
      el('span', { text: '请求外部接口' }),
    ),
    el(
      'label',
      { class: 'radio-inline' },
      el('input', { type: 'radio', name: 'rule-request-mode', value: 'none', checked: initialRequestMode === 'none' }),
      el('span', { text: '不请求（直接回复默认文本）' }),
    ),
  );
  function getRequestMode() {
    return requestModeGroup.querySelector('input[name="rule-request-mode"]:checked')?.value === 'none' ? 'none' : 'http';
  }
  const methodSelect = el('select', { id: 'rule-request-method', class: 'select' }, ...['GET', 'POST'].map((method) =>
    el('option', { value: method, text: method, selected: (request.method || 'GET') === method }),
  ));
  const urlInput = el('input', {
    id: 'rule-request-url',
    class: 'input',
    type: 'text',
    placeholder: 'https://api.example.com/weather?city={arg}',
    value: request.url || '',
  });
  // Header 处理（掩码/重设/清空 + 提交校验与其他编辑器共用 integrations/header-mode.js）
  const headerCtrl = createHeaderModeField({
    prefix: 'rule',
    isEdit,
    headerNames,
    entityLabel: '规则',
    hiddenLabelClass: true,
  });
  const bodyTemplateField = createBodyTemplateField({
    prefix: 'rule',
    request,
    placeholder: 'POST 请求体模板，可插入 {参数}；GET 请求忽略该字段',
    methodSelect,
  });
  const bodyField = bodyTemplateField.field;
  const bodyTemplateInput = bodyTemplateField.input;
  function syncRuleRequestFields() {
    bodyTemplateField.sync();
  }
  methodSelect.addEventListener('change', syncRuleRequestFields);
  syncRuleRequestFields();

  // 响应
  const { responseTypeSelect, responsePathInput, replyTemplateInput, fallbackInput, timeoutInput } = createResponseInputs({
    prefix: 'rule',
    response,
    limits,
    pathPlaceholder: '例如：data.answer（点路径，可含数组下标）',
    templatePlaceholder: '例如：天气：{{data.answer}}（支持 {{路径}}、{{response}}、{{raw}}）',
    fallbackPlaceholder: '接口失败 / 无有效回复时发送的文案（可为空）',
  });

  const extractionConfigField = el(
    'div',
    { class: 'form-field form-field--full' },
    el('span', { class: 'form-label', text: '提取配置' }),
    extractionConfigBox,
  );
  const extractionSection = formSection(
    '参数提取',
    '从消息中提取变量，供请求 URL / Header / Body 模板使用；缺参时不调用接口。',
    el(
      'div',
      { class: 'rule-form-grid' },
      formField('提取模式', extractionModeSelect, null, 'rule-extraction-mode', { span: 3 }),
      extractionConfigField,
    ),
  );
  const requestDetailsBox = el(
    'div',
    {},
    buildRequestRow({
      prefix: 'rule',
      methodSelect,
      urlInput,
      urlHint: '不请求模式无需填写。',
    }),
    headerCtrl.modeField,
    headerCtrl.listField,
    bodyField,
  );
  const requestModeField = formField(
    '请求模式',
    requestModeGroup,
    '不请求：关键词命中后直接回复默认文本，不访问外部接口。',
    'rule-request-mode',
    { span: 3 },
  );
  const requestSection = formSection(
    '请求',
    'URL / Header / Body 支持 {变量} 占位；可用 {credential:凭据名.字段} 引用当前触发用户在「用户管理 → 密钥」配置的凭据（缺失时规则失败且不调用接口，日志已脱敏）；URL 中的变量会做 URL 编码。默认拒绝访问内网/本机（SSRF 防护）。请求外部接口期间会向触发用户显示「正在输入」状态（可在「运行配置 → 接口应用」关闭）。',
    requestDetailsBox,
  );
  const responseGrid = buildResponseRow({
    prefix: 'rule',
    responseTypeSelect,
    responsePathInput,
    pathLabel: 'JSON 路径（response.type=json）',
    pathHint: '例如 data.answer；为空时优先取 reply 字段。',
  });
  const fallbackField = formField('兜底文案', fallbackInput, '接口失败 / 缺参 / 空回复时发送（可为空）。', 'rule-fallback', { span: 2 });
  const timeoutField = formField('超时（ms，1000-30000）', timeoutInput, null, 'rule-timeout', { span: 1 });
  function syncRuleRequestMode() {
    const noRequest = getRequestMode() === 'none';
    setHidden(extractionSection, noRequest);
    setHidden(requestSection, noRequest);
    setHidden(requestDetailsBox, noRequest);
    setHidden(responseGrid, noRequest);
    setHidden(fallbackField, noRequest);
    setHidden(timeoutField, noRequest);
    if (noRequest) {
      replyTemplateInput.placeholder = '默认回复文本，例如：收到，我们会尽快处理。';
    } else {
      replyTemplateInput.placeholder = '例如：天气：{{data.answer}}（支持 {{路径}}、{{response}}、{{raw}}）';
    }
  }
  for (const radio of requestModeGroup.querySelectorAll('input[name="rule-request-mode"]')) {
    radio.addEventListener('change', syncRuleRequestMode);
  }
  syncRuleRequestMode();

  const formError = createFormError('rule-form-error');
  const errorNode = formError.node;
  const showFormError = formError.show;

  const content = [
    formSection(
      '基本信息',
      null,
      el(
        'label',
        { class: 'check-field' },
        enabledInput,
        el(
          'span',
          { class: 'check-field-text' },
          el('strong', { text: '启用规则' }),
          el('span', { class: 'form-hint', text: '停用后不再触发关键词规则；已有运行日志保留。' }),
        ),
      ),
      el(
        'div',
        { class: 'form-grid-2' },
        formField('规则名称', nameInput, '必填，1-60 字符', 'rule-name-input'),
        formField('优先级', priorityInput, '数字越小越先', 'rule-priority-input'),
      ),
      errorNode,
    ),
    formSection(
      '触发范围',
      '仅对范围内用户的入站消息触发；范围不命中不会写日志。',
      el('div', { class: 'radio-list rule-radio-row' }, ...picker.radios),
      picker.userPicker,
      picker.groupPicker,
    ),
    formSection(
      '触发条件',
      '一消息最多命中一条规则；多规则命中时按优先级取第一条。',
      el(
        'div',
        { class: 'rule-form-grid' },
        formField('匹配方式', matchModeSelect, null, 'rule-match-mode', { span: 3 }),
        matchKeywordField,
        matchRegexField,
        requestModeField,
      ),
    ),
    extractionSection,
    requestSection,
    formSection(
      '响应解析与回复',
      '请求模式按响应类型/路径解析后渲染回复模板；不请求模式直接使用「回复模板 / 默认文本」。',
      responseGrid,
      formField('回复模板（Markdown / 默认文本）', replyTemplateInput, '按 Markdown 发送：支持标题、粗体、列表、代码块、表格；请求模式可用 {{变量}}，不请求模式直接作为默认回复文本。', 'rule-reply-template', { span: 3 }),
      el('div', { class: 'form-row-between' },
        el('span', { class: 'form-hint', text: '可粘贴示例响应离线预览；点击「模板语法」查看变量与 Markdown 规则。' }),
        buildTemplateTools({
          templateInput: replyTemplateInput,
          responseTypeSelect,
          responsePathInput,
          fallbackInput,
          previewTitle: '预览规则回复',
        }),
      ),
      el(
        'div',
        { class: 'rule-form-grid' },
        fallbackField,
        timeoutField,
      ),
    ),
  ];

  openEditorModal({
    title: isEdit ? '编辑接口应用规则' : '新建接口应用规则',
    content,
    saveLabel: isEdit ? '保存' : '创建',
    onSave: createSaveAction({
          isEdit,
          nameLabel: '规则',
          toastLabel: '规则',
          itemPath: () => `/api/admin/app-rules/${encodeURIComponent(rule.id)}`,
          collectionPath: '/api/admin/app-rules',
          refresh: () => refreshAfterWrite({ appRules: true }),
          errorNode,
          showFormError,
          getName: () => nameInput.value.trim(),
          fallbackError: '保存规则失败',
          badRequestMessage: '参数校验失败',
          buildPayload: (name) => {
          const scopeType = picker.getType();
          const scopeIds =
            scopeType === 'users'
              ? [...picker.selectedUserIds]
              : scopeType === 'groups'
                ? [...picker.selectedGroupIds]
                : [];
          if (scopeType !== 'all' && scopeIds.length === 0) {
            return showFormError(scopeType === 'users' ? '请至少选择一位用户' : '请至少选择一个分组');
          }
          const keywords = parseKeywordsInput(keywordsInput.value);
          if (matchModeSelect.value !== 'regex') {
            if (keywords.length < 1 || keywords.length > 10) return showFormError('关键词数量必须是 1-10 个');
            if (keywords.some((keyword) => keyword.length > 50)) return showFormError('每个关键词最多 50 个字符');
          } else if (!regexInput.value.trim()) {
            return showFormError('请输入正则表达式');
          }
          const noRequest = getRequestMode() === 'none';
          let extractionMode = 'none';
          const extractionCfg = {};
          if (!noRequest) {
            extractionMode = extractionModeSelect.value;
            if (extractionMode === 'multi') {
              if (multiExtractors.length === 0) return showFormError('多参数模式至少需要 1 个提取项');
              const extractors = [];
              const requiredNames = [];
              for (const row of multiExtractors) {
                const type = row.type;
                const param = String(row.param || '').trim();
                if (type !== 'regex' && !param) return showFormError('多参数模式：每个提取项都需要填写参数名');
                if (param && !/^[A-Za-z0-9_]{1,30}$/.test(param)) {
                  return showFormError(`参数名不合法：${param}（只能包含字母/数字/下划线，1-30 字符）`);
                }
                const item = { type };
                if (type === 'trailing') {
                  item.param = param || 'arg';
                  const keyword = String(row.keyword || '').trim();
                  if (keyword) item.keyword = keyword;
                } else if (type === 'regex') {
                  const regex = String(row.regex || '').trim();
                  if (!regex) return showFormError('多参数模式：正则提取项需要填写正则表达式');
                  item.regex = regex;
                  if (param) item.param = param;
                } else if (type === 'json') {
                  if (param) item.param = param;
                  const path = String(row.path || '').trim();
                  if (path) item.path = path;
                } else {
                  item.param = param || 'text';
                }
                extractors.push(item);
                if (row.required && param) requiredNames.push(param);
              }
              extractionCfg.extractors = extractors;
              if (requiredNames.length > 0) extractionCfg.required = requiredNames;
            }
          }
          let url = '';
          let headersPayload;
          if (!noRequest) {
            url = urlInput.value.trim();
            if (!/^https?:\/\//i.test(url)) return showFormError('请求 URL 必须是 http(s) 地址');
            const headerResult = headerCtrl.readHeaderPayload();
            if (headerResult.error) return showFormError(headerResult.error);
            headersPayload = headerResult.headers;
          } else if (!replyTemplateInput.value.trim() && !fallbackInput.value.trim()) {
            return showFormError('不请求模式：请填写「回复模板 / 默认文本」');
          }
          const requestBody = noRequest ? { mode: 'none' } : { mode: 'http', method: methodSelect.value, url };
          if (headersPayload !== undefined) requestBody.headers = headersPayload;
          if (!noRequest && methodSelect.value === 'POST') requestBody.bodyTemplate = bodyTemplateInput.value;

          const payload = {
            name,
            enabled: enabledInput.checked,
            priority: Number(priorityInput.value),
            scope: { type: scopeType, ids: scopeIds },
            matchMode: matchModeSelect.value,
            keywords: matchModeSelect.value === 'regex' ? [] : keywords,
            regexPattern: matchModeSelect.value === 'regex' ? regexInput.value.trim() : '',
            extraction: { mode: extractionMode, config: extractionCfg },
            request: requestBody,
            response: {
              type: responseTypeSelect.value,
              path: responsePathInput.value.trim(),
              template: replyTemplateInput.value,
              fallbackText: fallbackInput.value,
            },
            timeoutMs: Number(timeoutInput.value),
          };
          const headersSaved = headersPayload !== undefined && Object.keys(headersPayload).length > 0;
          const savedSuffix = headersSaved ? '；Header 值已加密保存（不会回显）' : '';
          return { payload, savedSuffix };
          },
        }),
  });

  loadPickerUsers()
    .then((users) => {
      if (users.length > 0) picker.renderUsers(picker.userSearch.value);
    })
    .catch((error) => {
      picker.renderUsers('');
      if (error && error.status !== 401) toastError(error, '加载用户列表失败');
    });

}

async function duplicateAppRule(rule, button) {
  if (button) button.disabled = true;
  try {
    const data = await apiFetch(`/api/admin/app-rules/${encodeURIComponent(rule.id)}/duplicate`, {
      method: 'POST',
    });
    const name = data && data.rule && data.rule.name ? data.rule.name : '副本';
    toast(`规则已复制为「${name}」，副本默认停用`, 'success');
    await refreshAfterWrite({ appRules: true });
  } catch (error) {
    toastError(error, '复制规则失败');
    if (button) button.disabled = false;
  }
}

async function deleteAppRule(rule) {
  const confirmed = await confirmDialog({
    title: '删除接口应用规则',
    message: `确定删除规则「${rule.name || rule.id}」吗？删除后不再触发，运行日志保留。`,
    confirmText: '删除规则',
    cancelText: '取消',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await apiFetch(`/api/admin/app-rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
    toast('规则已删除', 'success');
    await refreshAfterWrite({ appRules: true });
  } catch (error) {
    toastError(error, '删除规则失败');
  }
}

async function openAppRuleTestModal(rule) {
  let users = [];
  try {
    users = await loadPickerUsers();
  } catch {
    users = state.users.items;
  }
  const messageInput = el('textarea', {
    id: 'rule-test-message',
    class: 'textarea',
    rows: '3',
    placeholder: '输入一条示例微信消息，例如：查天气 北京',
  });
  const userSelect = el('select', { id: 'rule-test-user', class: 'select' }, el('option', { value: '', text: '不指定用户（不校验范围）' }));
  for (const user of users.slice(0, 200)) {
    userSelect.append(el('option', { value: user.id, text: `${user.displayName || user.id}（${user.id}）` }));
  }
  openTestRunModal({
    title: `测试运行：${rule.name || rule.id}`,
    hint: '测试运行仅模拟一次触发，不会向微信用户发送消息、不写运行日志。请求模式会真实调用外部接口；不请求模式直接渲染默认文本。',
    extraContent: [
      el(
        'div',
        { class: 'rule-form-grid' },
        formField('示例消息（必填）', messageInput, null, 'rule-test-message', { span: 2 }),
        formField('模拟用户（可选，用于范围匹配）', userSelect, null, 'rule-test-user', { span: 1 }),
      ),
    ],
    resultId: 'rule-test-result',
    runPath: `/api/admin/app-rules/${encodeURIComponent(rule.id)}/test`,
    validate: () => {
      const message = messageInput.value.trim();
      if (message) return false;
      toast('请输入示例消息', 'warning');
      messageInput.focus();
      return true;
    },
    buildRequestBody: () => ({
      message: messageInput.value.trim(),
      ...(userSelect.value ? { userId: userSelect.value } : {}),
    }),
    buildResultNodes: buildRuleTestResultNodes,
  });
}

/** 从测试运行结果中收集本次使用的凭据名称（后端字段名兼容多种命名）。 */
function collectUsedCredentialNames(data) {
  const names = [];
  for (const candidate of [data.credentialNames, data.usedCredentials, data.credentials]) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      const name = typeof entry === 'string' ? entry : entry && typeof entry.name === 'string' ? entry.name : '';
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** 从测试运行结果中收集缺失的凭据名称（字段或错误信息中的 missing credential）。 */
function collectMissingCredentialNames(data) {
  const names = [];
  const add = (name) => {
    if (typeof name === 'string' && name && !names.includes(name)) names.push(name);
  };
  if (Array.isArray(data.missingCredentials)) {
    for (const entry of data.missingCredentials) {
      add(typeof entry === 'string' ? entry : entry && typeof entry.name === 'string' ? entry.name : '');
    }
  }
  const message = typeof data.error === 'string' ? data.error : '';
  for (const match of message.matchAll(
    /(?:missing credential|缺少凭据)[：:\s]+([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_.-]+)?)/g,
  )) {
    add(match[1]);
  }
  return names;
}

/** 规则测试运行结果中的凭据使用/缺失提示（值不会返回，仅显示名称）。 */
function buildRuleCredentialUsageNodes(data) {
  const used = collectUsedCredentialNames(data);
  const missing = collectMissingCredentialNames(data);
  const nodes = [];
  if (used.length > 0) {
    nodes.push(
      el(
        'p',
        { class: 'form-hint' },
        el('span', { text: '本次使用用户凭据：' }),
        ...used.map((name) => el('code', { class: 'credential-ref', text: name })),
      ),
    );
  }
  if (missing.length > 0) {
    nodes.push(
      el('p', {
        class: 'alert alert-warning',
        text: `缺少用户凭据：${missing.join('、')}。请在「用户管理 → 密钥」为该用户配置对应凭据；缺失时规则记失败且不发起请求，日志只记录凭据名。`,
      }),
    );
  }
  return nodes;
}

function buildRuleTestResultNodes(result) {
  const data = result && typeof result === 'object' ? result : {};
  const nodes = [];
  const matched = data.matched === true;
  nodes.push(
    el(
      'div',
      { class: 'rule-test-head' },
      el('span', { class: `badge ${matched ? 'badge-success' : 'badge-muted'}`, text: matched ? '命中规则' : '未命中规则' }),
      el('span', { class: 'badge badge-soft badge-info', text: '不会发送给用户' }),
    ),
  );
  if (!matched) {
    nodes.push(el('p', { class: 'form-hint', text: '示例消息未命中该规则的触发范围或关键词，可调整规则或消息后重试。' }));
    return nodes;
  }
  nodes.push(...buildRuleCredentialUsageNodes(data));
  if (data.error === 'missing params') {
    nodes.push(el('p', {
      class: 'alert alert-warning',
      text: '未调用外部接口：未从消息中提取到参数。请检查「参数提取」配置与消息格式（例如当前正则可能要求「查北京天气」这种格式，而不是「查天气 北京」）。',
    }));
  } else if (data.httpStatus === null || data.httpStatus === undefined) {
    nodes.push(el('p', { class: 'form-hint', text: '本次未发起外部请求。' }));
  } else {
    nodes.push(el('p', {
      class: 'form-hint',
      text: `请求已发送到外部接口（HTTP ${data.httpStatus}）${data.error ? '；非 2xx 响应会直接使用兜底文案，暂不解析响应体。' : '，已按配置解析响应。'}`,
    }));
  }
  if (data.error) nodes.push(el('p', { class: 'alert alert-warning', text: `错误：${data.error}` }));
  nodes.push(
    el('div', { class: 'rule-test-grid' },
      el('div', { class: 'rule-test-item' }, el('span', { class: 'kv-label', text: '参数' }), el('pre', { class: 'json-preview', text: JSON.stringify(data.params || {}, null, 2) })),
      el('div', { class: 'rule-test-item' }, el('span', { class: 'kv-label', text: 'HTTP 状态 / 耗时' }), el('span', { class: 'kv-value', text: `${data.httpStatus ?? '—'} / ${data.latencyMs === undefined || data.latencyMs === null ? '—' : `${data.latencyMs} ms`}` })),
    ),
  );
  const request = data.request && typeof data.request === 'object' ? data.request : {};
  const testHeaderNames = Array.isArray(request.headerNames) ? request.headerNames.filter(Boolean) : [];
  const diagHeaders = data.responseHeaders && typeof data.responseHeaders === 'object' ? data.responseHeaders : {};
  const diagHeaderLines = Object.keys(diagHeaders).map((key) => `${key}: ${diagHeaders[key]}`);
  nodes.push(
    el('div', { class: 'rule-test-item' },
      el('span', { class: 'kv-label', text: '实际请求' }),
      el('div', { class: 'rule-test-request', text: request.url ? `${request.method || 'GET'} ${request.url}` : '不请求（直接回复默认文本）' }),
      el('div', {
        class: 'cell-muted',
        text: testHeaderNames.length > 0
          ? `Header：${testHeaderNames.join('、')}（值已加密隐藏，实际请求会携带完整值）`
          : 'Header：无',
      }),
      diagHeaderLines.length > 0
        ? el('div', { class: 'rule-test-item' },
            el('span', { class: 'kv-label', text: '响应头（诊断）' }),
            el('pre', { class: 'json-preview', text: diagHeaderLines.join('\n') }),
          )
        : null,
      request.bodyPreview
        ? el('pre', { class: 'json-preview', text: String(request.bodyPreview) })
        : null,
    ),
    el('div', { class: 'rule-test-item' },
      el('span', { class: 'kv-label', text: '响应预览' }),
      el('pre', { class: 'json-preview', text: data.responsePreview || '（空）' }),
    ),
    el('div', { class: 'alert alert-success' },
      el('strong', { text: '将回复的文本：' }),
      el('div', { class: 'rule-test-reply', text: data.replyText || '（空，将使用兜底文案或不发送）' }),
    ),
  );
  return nodes;
}

export function setRuleTab(tab) {
  const target = tab === 'schedule' ? 'schedule' : 'rules';
  state.ruleTab = target;
  for (const button of $$('button[data-rule-tab]', els.ruleTabs)) {
    const active = button.dataset.ruleTab === target;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.tabIndex = active ? 0 : -1;
  }
  setHidden(els.ruleRulesPanel, target !== 'rules');
  if (els.ruleSchedulePanel) setHidden(els.ruleSchedulePanel, target !== 'schedule');
  // 视图头部操作按钮跟随 Tab：规则列表 → 新建规则；定时通知 → 新建任务
  if (els.appRulesHeadActions) setHidden(els.appRulesHeadActions, target !== 'rules');
  if (els.scheduleHeadActions) setHidden(els.scheduleHeadActions, target !== 'schedule');
  if (target === 'schedule') {
    loadScheduledTasks().catch(loadErrorHandler('加载定时任务失败'));
  }
}

/**
 * 规则运行日志弹窗（与定时通知运行日志弹窗共用 integrations/logs-modal.js）。
 * GET /api/admin/app-rule-logs?ruleId=&status=&limit=&offset=
 */
function openRuleLogsModal(rule) {
  openLogsModal({
    title: `运行日志：${rule.name || rule.id}`,
    className: 'rule-logs',
    columns: ['时间', '规则', '用户', '状态', 'HTTP', '耗时', '错误', '参数预览', '响应预览'],
    ids: {
      tbody: 'rule-log-modal-body',
      pageInfo: 'rule-log-modal-page-info',
      prev: 'rule-log-modal-prev',
      next: 'rule-log-modal-next',
      statusSelect: 'rule-log-modal-status',
    },
    hintText: `规则：${rule.name || rule.id}；按时间倒序展示最近运行记录。`,
    statusOptions: [
      ['', '全部状态'],
      ['success', '成功'],
      ['failed', '失败'],
      ['skipped', '跳过'],
      ['matched', '命中'],
    ],
    paramsFor: (local) => {
      const params = new URLSearchParams();
      params.set('ruleId', rule.id);
      params.set('limit', String(local.limit));
      params.set('offset', String(local.offset));
      if (local.status) params.set('status', local.status);
      return params;
    },
    endpoint: '/api/admin/app-rule-logs',
    renderRow: (log) => {
      const statusMeta = RULE_RUN_STATUS_META[log.status] || { label: log.status || '—', className: 'badge-muted' };
      return el('tr', {},
        el('td', { class: 'cell-nowrap' }, el('div', { text: formatDateTime(log.createdAt) }), el('div', { class: 'cell-muted', text: formatRelative(log.createdAt) })),
        el('td', { class: 'cell-mono', text: log.ruleName || log.ruleId || '—' }),
        el('td', { class: 'cell-mono', text: log.userId || '—' }),
        el('td', {}, el('span', { class: `badge ${statusMeta.className}`, text: statusMeta.label })),
        el('td', { class: 'cell-mono', text: log.httpStatus === null || log.httpStatus === undefined ? '—' : String(log.httpStatus) }),
        el('td', { class: 'cell-mono cell-nowrap', text: log.latencyMs === null || log.latencyMs === undefined ? '—' : `${log.latencyMs} ms` }),
        el('td', { class: 'cell-error', text: log.error || '—' }),
        el('td', { class: 'cell-muted log-preview', title: log.paramsPreview || '', text: log.paramsPreview || '—' }),
        el('td', { class: 'cell-muted log-preview', title: log.responsePreview || '', text: log.responsePreview || '—' }),
      );
    },
    errorFallback: '加载规则运行日志失败',
  });
}

/** 接口应用视图事件绑定（首次进入该视图时加载，幂等）。 */
let appRulesViewBound = false;
export function initAppRulesView() {
  if (appRulesViewBound) return;
  appRulesViewBound = true;
  els.createRuleButton.addEventListener('click', () => openAppRuleEditor(null));
  els.ruleStatusFilter.addEventListener('change', () => {
    state.appRules.filter = els.ruleStatusFilter.value || 'all';
    renderAppRules();
  });
  els.appRuleTableBody.addEventListener('click', handleAppRuleTableClick);
  // 接口应用页内 Tab：规则列表 / 定时通知（点击 + 方向键/Home/End，）
  setupTablist({
    tablist: els.ruleTabs,
    tabSelector: 'button[data-rule-tab]',
    getValue: (tab) => tab.dataset.ruleTab,
    onChange: setRuleTab,
  });
}
