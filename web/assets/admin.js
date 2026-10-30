/**
 * ClawBridge 管理后台逻辑。
 *
 * - 未登录：展示登录表单（POST /api/admin/login）
 * - 已登录：概览 / 用户管理 / 广播 / 消息记录 / 运行配置，每 5s 自动刷新（页面隐藏时暂停）
 * - 所有写请求由 common.js 自动附加 X-Requested-With: ClawBridge-Admin
 */
import {
  configureApi,
  apiFetch,
  $,
  $$,
  el,
  clearNode,
  setHidden,
  toast,
  toastError,
  setButtonLoading,
  createPoller,
  debounce,
  confirmDialog,
  openModal,
  formatDateTime,
  formatRelative,
  formatDuration,
  formatNumber,
  formatFileSize,
  uploadWithProgress,
} from './common.js';

const POLL_INTERVAL_MS = 5000;
const PAGE_SIZE = 20;
const MAX_TEXT_LENGTH = 4000;

const USER_STATUS_META = {
  active: { label: '活跃', className: 'badge-success' },
  paused: { label: '暂停中', className: 'badge-warning' },
  unbound: { label: '已解绑', className: 'badge-muted' },
};

const MESSAGE_DIRECTION_META = {
  inbound: { label: '入站', className: 'badge-info' },
  outbound: { label: '出站', className: 'badge-success' },
};

const MESSAGE_STATUS_META = {
  received: { label: '已接收', className: 'badge-info' },
  sent: { label: '已发送', className: 'badge-success' },
  queued: { label: '排队中', className: 'badge-warning' },
  sending: { label: '发送中', className: 'badge-info' },
  failed: { label: '失败', className: 'badge-danger' },
};

/** 消息来源标签（docs/KEEPALIVE.md §4：消息项新增 source 字段）。 */
const MESSAGE_SOURCE_META = {
  keepalive: { label: '保活', className: 'badge-keepalive' },
  broadcast: { label: '广播', className: 'badge-info' },
  group: { label: '分组', className: 'badge-group' },
  admin: { label: '管理', className: 'badge-muted' },
  api: { label: 'API', className: 'badge-muted' },
  system: { label: '系统', className: 'badge-muted' },
};

/** 附件类型元信息（与 docs/MEDIA.md §4.1 的 attachments.kind 对应）。 */
const MEDIA_KIND_META = {
  image: { label: '图片', icon: '🖼️' },
  video: { label: '视频', icon: '🎬' },
  file: { label: '文件', icon: '📄' },
  voice: { label: '语音', icon: '🎤' },
};

/** 后端未返回 media 限制时的保守提示值（仅用于文案，实际以服务端校验为准）。 */
const FALLBACK_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

/** 分组名称/描述长度限制（docs/GROUPS_AND_INBOUND.md §3.1）。 */
const GROUP_NAME_MAX = 40;
const GROUP_DESC_MAX = 200;
/** 分组颜色预设色板。 */
const GROUP_COLOR_PALETTE = [
  '#07C160',
  '#2563EB',
  '#7C3AED',
  '#DB2777',
  '#DC2626',
  '#D97706',
  '#0EA5E9',
  '#64748B',
];
/** 分组筛选中「未分组」的客户端哨兵值（后端仅支持 groupId=具体分组）。 */
const UNGROUPED_FILTER = '__ungrouped__';

/** 后台菜单与 hash 路由（固定 7 个视图，顺序与侧栏一致）。 */
const VIEW_STORAGE_KEY = 'clawbridge:admin-view:v1';
const DEFAULT_VIEW = 'overview';
const MENU_VIEWS = [
  { id: 'overview', hash: '#/overview', title: '概览', sectionId: 'overview-section', live: true },
  { id: 'users', hash: '#/users', title: '用户管理', sectionId: 'users-section', live: true },
  { id: 'groups', hash: '#/groups', title: '用户分组', sectionId: 'groups-section', live: false },
  { id: 'messages', hash: '#/messages', title: '消息记录', sectionId: 'messages-section', live: true },
  { id: 'broadcast', hash: '#/broadcast', title: '广播消息', sectionId: 'broadcast-section', live: false },
  { id: 'app-rules', hash: '#/app-rules', title: '接口应用', sectionId: 'app-rules-section', live: true },
  { id: 'config', hash: '#/config', title: '运行配置', sectionId: 'config-section', live: false },
];
const VIEW_BY_ID = new Map(MENU_VIEWS.map((view) => [view.id, view]));
const LIVE_VIEWS = new Set(MENU_VIEWS.filter((view) => view.live).map((view) => view.id));

const state = {
  authenticated: false,
  /** 当前激活视图（MENU_VIEWS.id）与已加载视图缓存。 */
  view: DEFAULT_VIEW,
  viewLoaded: new Set(),
  users: { total: 0, items: [], offset: 0, q: '', status: 'all', groupId: '' },
  messages: { total: 0, items: [], offset: 0, direction: 'inbound', groupId: '' },
  /** GET /api/admin/groups 的完整列表。 */
  groups: [],
  /** 接口应用规则（docs/API_RULES.md §7）。 */
  appRules: { items: [], filter: 'all' },
  /** 接口应用页内 Tab：'rules' | 'schedule'。 */
  ruleTab: 'rules',
  /** 接口应用「定时通知」Tab：ScheduledTaskView 列表（docs/SCHEDULED_TASKS.md §5/§6）。 */
  scheduled: { items: [], loaded: false, timezone: 'Asia/Shanghai' },
  /** 规则表单/测试用的用户缓存（最多 500）。 */
  pickerUsers: null,
  /** userId → groups（用于消息记录/用户表格展示徽章，来自最近一次用户列表响应）。 */
  userGroupMap: new Map(),
  overview: null,
  config: null,
  /** GET /api/admin/config 的 media 字段（maxBytes / inboundMaxBytes / allowedImage / allowedVideo / dir）。 */
  mediaLimits: null,
  /** 运行配置（后台可改设置，docs/SETTINGS.md §3/§4）。 */
  settings: {
    available: false,
    groups: [],
    envOnly: [],
    initial: new Map(),
    draft: new Map(),
    fields: new Map(),
    /** GET /api/admin/settings 的 security 字段（来源/preview/push 开关；不含密码哈希或 Token 明文）。 */
    security: null,
  },
};

const els = {
  loadingView: $('#admin-loading'),
  loginView: $('#login-view'),
  loginForm: $('#login-form'),
  loginPassword: $('#login-password'),
  loginSubmit: $('#login-submit'),
  loginError: $('#login-error'),
  dashboard: $('#dashboard'),

  sidebar: $('#admin-sidebar'),
  sidebarOverlay: $('#sidebar-overlay'),
  sidebarToggle: $('#btn-sidebar-toggle'),
  topbarBar: $('#admin-topbar-bar'),
  viewTitle: $('#view-title'),
  sidebarVersion: $('#sidebar-version'),

  refreshButton: $('#btn-refresh'),
  logoutButton: $('#btn-logout'),

  overviewStats: $('#overview-stats'),
  overviewServer: $('#overview-server'),
  overviewUpdated: $('#overview-updated'),

  usersTotal: $('#users-total'),
  userSearch: $('#user-search'),
  userStatusFilter: $('#user-status-filter'),
  userGroupFilter: $('#user-group-filter'),
  userTableBody: $('#user-table-body'),
  usersPrev: $('#users-prev'),
  usersNext: $('#users-next'),
  usersPageInfo: $('#users-page-info'),

  groupsTotal: $('#groups-total'),
  createGroupButton: $('#btn-create-group'),
  groupTableBody: $('#group-table-body'),

  appRulesTotal: $('#app-rules-total'),
  createRuleButton: $('#btn-create-rule'),
  ruleStatusFilter: $('#rule-status-filter'),
  appRuleTableBody: $('#app-rule-table-body'),

  ruleTabs: $('#rule-tabs'),
  ruleRulesPanel: $('#rule-rules-panel'),

  appRulesHeadActions: $('#app-rules-head-actions'),
  scheduleHeadActions: $('#schedule-head-actions'),
  ruleSchedulePanel: $('#rule-schedule-panel'),
  scheduleTotal: $('#schedule-total'),
  createScheduleButton: $('#btn-create-schedule'),
  scheduleTableBody: $('#schedule-table-body'),

  broadcastForm: $('#broadcast-form'),
  broadcastText: $('#broadcast-text'),
  broadcastCount: $('#broadcast-count'),
  broadcastButton: $('#btn-broadcast'),

  messagesTotal: $('#messages-total'),
  messagesTabs: $('#messages-tabs'),
  messagesGroupFilter: $('#messages-group-filter'),
  messagesTableBody: $('#messages-table-body'),
  messagesPrev: $('#messages-prev'),
  messagesNext: $('#messages-next'),
  messagesPageInfo: $('#messages-page-info'),

  configList: $('#config-list'),
  settingsGroups: $('#settings-groups'),
  settingsError: $('#settings-error'),
  settingsUnavailable: $('#settings-unavailable'),
  settingsSavebar: $('#settings-savebar'),
  settingsSaveStatus: $('#settings-save-status'),
  settingsSaveButton: $('#btn-settings-save'),
  settingsEnvOnly: $('#settings-env-only'),
  settingsRestartNote: $('#settings-restart-note'),
  settingsRestartContainerButton: $('#btn-restart-container'),

  securityCard: $('#security-card'),
  securityTokenPreview: $('#security-token-preview'),
  securityTokenSource: $('#security-token-source'),
  securityPasswordSource: $('#security-password-source'),
  securityPushToggle: $('#security-push-toggle'),
  securityCurrentPassword: $('#security-current-password'),
  securityNewPassword: $('#security-new-password'),
  securityConfirmPassword: $('#security-confirm-password'),
  securityPasswordChangeButton: $('#btn-password-change'),
  securityPasswordResetButton: $('#btn-password-reset'),
  securityTokenRotateButton: $('#btn-token-rotate'),
  securityTokenResetButton: $('#btn-token-reset'),
  securityError: $('#security-error'),
};

/** 当前打开的模态框集合（打开时暂停自动刷新，避免打断输入）。 */
const openModals = new Set();
let refreshPoller = null;
let loggingIn = false;

configureApi({ csrf: true, onUnauthorized: handleUnauthorized });

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

function init() {
  if (!els.loginForm) return; // 非管理页（防御）

  els.loginForm.addEventListener('submit', handleLogin);
  els.logoutButton.addEventListener('click', handleLogout);
  els.refreshButton.addEventListener('click', handleManualRefresh);

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

  els.messagesTabs.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-direction]');
    if (!button) return;
    setMessageDirection(button.dataset.direction);
  });

  els.messagesGroupFilter.addEventListener('change', () => {
    state.messages.groupId = els.messagesGroupFilter.value || '';
    state.messages.offset = 0;
    loadMessages().catch(loadErrorHandler('加载消息记录失败'));
  });

  els.createGroupButton.addEventListener('click', () => openGroupEditor(null));
  els.groupTableBody.addEventListener('click', handleGroupTableClick);

  els.createRuleButton.addEventListener('click', () => openAppRuleEditor(null));
  els.ruleStatusFilter.addEventListener('change', () => {
    state.appRules.filter = els.ruleStatusFilter.value || 'all';
    renderAppRules();
  });
  els.appRuleTableBody.addEventListener('click', handleAppRuleTableClick);

  els.userTableBody.addEventListener('click', handleUserTableClick);
  els.broadcastForm.addEventListener('submit', handleBroadcast);
  els.broadcastText.addEventListener('input', updateBroadcastCount);

  // 侧栏菜单 / hash 路由 / 移动端抽屉
  for (const link of $$('#admin-menu .menu-item')) {
    link.addEventListener('click', () => closeDrawer());
  }
  els.sidebarToggle.addEventListener('click', toggleDrawer);
  els.sidebarOverlay.addEventListener('click', () => closeDrawer());
  if (typeof window.matchMedia === 'function') {
    const desktopMedia = window.matchMedia('(min-width: 1024px)');
    if (typeof desktopMedia.addEventListener === 'function') {
      desktopMedia.addEventListener('change', () => {
        if (desktopMedia.matches) {
          drawerOpen = false;
          if (els.sidebar) els.sidebar.classList.remove('is-open');
          if (els.sidebarOverlay) els.sidebarOverlay.hidden = true;
          if (els.sidebarToggle) els.sidebarToggle.setAttribute('aria-expanded', 'false');
          document.body.classList.remove('sidebar-open');
        }
        syncSidebarA11y();
      });
    }
  }
  syncSidebarA11y();
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isDrawerOpen()) closeDrawer();
  });
  window.addEventListener('hashchange', () => {
    handleRoute().catch(loadErrorHandler('切换视图失败'));
  });

  // 接口应用页内 Tab：规则列表 / 定时通知
  els.ruleTabs.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-rule-tab]');
    if (!button) return;
    setRuleTab(button.dataset.ruleTab);
  });

  // 定时通知（接口应用第二个 Tab）
  els.createScheduleButton.addEventListener('click', () => openScheduleEditor(null));
  els.scheduleTableBody.addEventListener('click', handleScheduleTableClick);

  // 运行配置（后台可改设置）
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

  bootstrap();
}

async function bootstrap() {
  try {
    const me = await apiFetch('/api/admin/me', { skipAuthRedirect: true, timeoutMs: 10000 });
    if (me && me.authenticated) {
      showDashboard();
      const target = resolveInitialView();
      if (!viewIdFromHash(location.hash)) {
        history.replaceState(null, '', VIEW_BY_ID.get(target).hash);
      }
      await showView(target);
      startAutoRefresh();
    } else {
      showLogin();
    }
  } catch (error) {
    if (error && error.status === 401) {
      // 部分实现下未登录会直接返回 401：按未登录处理即可
      showLogin();
    } else {
      showLogin(
        error && error.isNetworkError
          ? '网络异常，无法验证登录状态，请确认服务已启动后刷新页面。'
          : '',
      );
      if (error && !error.isNetworkError) toastError(error, '验证登录状态失败');
    }
  } finally {
    setHidden(els.loadingView, true);
  }
}

/* ------------------------------------------------------------------ */
/* 登录 / 登出 / 鉴权                                                   */
/* ------------------------------------------------------------------ */

async function handleLogin(event) {
  event.preventDefault();
  if (loggingIn) return;
  const password = els.loginPassword.value;
  clearInlineError(els.loginError);
  if (!password) {
    showInlineError(els.loginError, '请输入管理密码');
    els.loginPassword.focus();
    return;
  }
  loggingIn = true;
  setButtonLoading(els.loginSubmit, true, '登录中…');
  try {
    await apiFetch('/api/admin/login', {
      method: 'POST',
      body: { password },
      skipAuthRedirect: true,
    });
    els.loginPassword.value = '';
    showDashboard();
    toast('登录成功', 'success');
    const target = resolveInitialView();
    await navigateToView(target);
  } catch (error) {
    if (error && error.status === 429) {
      showInlineError(els.loginError, '登录尝试过于频繁，请稍后再试。');
    } else {
      showInlineError(els.loginError, error && error.message ? error.message : '登录失败，请重试');
    }
  } finally {
    loggingIn = false;
    setButtonLoading(els.loginSubmit, false);
  }
}

async function handleLogout() {
  stopAutoRefresh();
  try {
    await apiFetch('/api/admin/logout', { method: 'POST' });
  } catch {
    /* 即使注销请求失败，也回到登录界面 */
  }
  showLogin('已退出登录');
  toast('已退出登录', 'info');
}

function handleUnauthorized() {
  if (!state.authenticated && els.loginView && !els.loginView.hidden) return;
  state.authenticated = false;
  stopAutoRefresh();
  showLogin('登录已过期，请重新登录');
}

function showLogin(message = '') {
  state.authenticated = false;
  stopAutoRefresh();
  closeDrawer();
  document.body.classList.remove('admin-authed');
  setHidden(els.loadingView, true);
  setHidden(els.dashboard, true);
  setHidden(els.loginView, false);
  if (els.sidebar) setHidden(els.sidebar, true);
  if (els.topbarBar) setHidden(els.topbarBar, true);
  if (message) showInlineError(els.loginError, message);
  else clearInlineError(els.loginError);
  setTimeout(() => {
    if (els.loginPassword) els.loginPassword.focus();
  }, 30);
}

function showDashboard() {
  state.authenticated = true;
  document.body.classList.add('admin-authed');
  setHidden(els.loadingView, true);
  setHidden(els.loginView, true);
  setHidden(els.dashboard, false);
  if (els.sidebar) setHidden(els.sidebar, false);
  if (els.topbarBar) setHidden(els.topbarBar, false);
  syncSidebarA11y();
  clearInlineError(els.loginError);
  void loadSidebarVersion();
}

/* ------------------------------------------------------------------ */
/* hash 路由 / 视图切换 / 侧栏抽屉                                       */
/* ------------------------------------------------------------------ */

/** 从 hash 解析合法视图 id；非法/空返回空串。 */
function viewIdFromHash(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  return VIEW_BY_ID.has(raw) ? raw : '';
}

/** 登录后目标视图：优先 URL hash（深链），其次 sessionStorage 记录，最后默认概览。 */
function resolveInitialView() {
  const fromHash = viewIdFromHash(location.hash);
  if (fromHash) return fromHash;
  try {
    const stored = sessionStorage.getItem(VIEW_STORAGE_KEY);
    if (stored && VIEW_BY_ID.has(stored)) return stored;
  } catch {
    /* 隐私模式忽略 */
  }
  return DEFAULT_VIEW;
}

/** hashchange：合法 hash 切换视图；未知 hash 回退概览并纠正 URL。 */
async function handleRoute() {
  if (!state.authenticated) return;
  const rawHash = String(location.hash || '');
  const fromHash = viewIdFromHash(rawHash);
  if (!fromHash) {
    history.replaceState(null, '', VIEW_BY_ID.get(DEFAULT_VIEW).hash);
    await showView(DEFAULT_VIEW);
    return;
  }
  await showView(fromHash);
}

/**
 * 切换到指定视图；updateHash=true 时先改 location.hash（由 hashchange 驱动 showView）。
 * 若 hash 已是目标值则直接 showView。
 */
async function navigateToView(viewId, { updateHash = true } = {}) {
  const target = VIEW_BY_ID.has(viewId) ? viewId : DEFAULT_VIEW;
  const hash = VIEW_BY_ID.get(target).hash;
  if (updateHash && location.hash !== hash) {
    location.hash = hash;
    return;
  }
  await showView(target);
}

/** 显示某个视图：只取消当前 section 的 hidden（其余保留 DOM），同步菜单高亮/标题/URL 状态。 */
async function showView(viewId) {
  const view = VIEW_BY_ID.get(viewId) || VIEW_BY_ID.get(DEFAULT_VIEW);
  state.view = view.id;
  for (const item of MENU_VIEWS) {
    const section = document.getElementById(item.sectionId);
    if (section) section.hidden = item.id !== view.id;
  }
  for (const link of $$('#admin-menu .menu-item')) {
    const active = link.dataset.view === view.id;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (els.viewTitle) els.viewTitle.textContent = view.title;
  document.title = `ClawBridge 管理后台 · ${view.title}`;
  const expectedHash = VIEW_BY_ID.get(view.id).hash;
  if (location.hash !== expectedHash) {
    // 初次加载/异常 hash（如 #foo）统一纠正为规范路由，不新增历史项
    history.replaceState(null, '', expectedHash);
  }
  try {
    sessionStorage.setItem(VIEW_STORAGE_KEY, view.id);
  } catch {
    /* 忽略 */
  }
  closeDrawer();
  await loadView(view.id);
  updateLastUpdated();
  startAutoRefresh();
}

/** 按视图懒加载（依赖数据一并加载，例如用户视图需要分组筛选选项）。 */
async function loadView(viewId, { silent = false } = {}) {
  const tasks = [];
  if (viewId === 'overview') {
    tasks.push(loadOverview());
  } else if (viewId === 'users') {
    tasks.push(loadGroups(), loadUsers());
  } else if (viewId === 'groups') {
    tasks.push(loadGroups());
  } else if (viewId === 'messages') {
    tasks.push(loadGroups(), loadMessages());
  } else if (viewId === 'broadcast') {
    // 广播视图无初始数据需要加载（表单状态保留）
  } else if (viewId === 'app-rules') {
    tasks.push(loadGroups(), loadAppRules());
  } else if (viewId === 'config') {
    tasks.push(loadConfig(), loadSettings());
  }
  const results = await Promise.allSettled(tasks);
  state.viewLoaded.add(viewId);
  if (!silent) {
    const failed = results.find((result) => result.status === 'rejected');
    if (failed && failed.reason && failed.reason.status !== 401) {
      toastError(failed.reason, '加载视图数据失败');
    }
  }
  updateLastUpdated();
}

function updateLastUpdated() {
  if (!els.overviewUpdated) return;
  els.overviewUpdated.textContent = ` · 更新于 ${formatDateTime(Date.now()).slice(11)}`;
}

async function loadSidebarVersion() {
  if (!els.sidebarVersion || els.sidebarVersion.dataset.loaded === '1') return;
  try {
    const health = await apiFetch('/health', { skipAuthRedirect: true, timeoutMs: 8000 });
    if (health && typeof health.version === 'string' && health.version) {
      els.sidebarVersion.textContent = `v${health.version}`;
      els.sidebarVersion.dataset.loaded = '1';
    }
  } catch {
    /* 版本号非关键信息，失败忽略 */
  }
}

/** 移动端侧栏抽屉。 */
let drawerOpen = false;

/** 桌面端侧栏常驻；移动端关闭抽屉时用 inert/aria-hidden 把 off-canvas 菜单移出焦点与可达性树。 */
function isDesktopLayout() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches;
}

function syncSidebarA11y() {
  if (!els.sidebar) return;
  if (isDesktopLayout() || drawerOpen) {
    els.sidebar.removeAttribute('inert');
    els.sidebar.removeAttribute('aria-hidden');
  } else {
    els.sidebar.setAttribute('inert', '');
    els.sidebar.setAttribute('aria-hidden', 'true');
  }
}

function focusFirstMenuItem() {
  const first = document.querySelector('#admin-menu .menu-item');
  if (first && typeof first.focus === 'function') first.focus();
}

function isDrawerOpen() {
  return drawerOpen;
}

function openDrawer() {
  drawerOpen = true;
  if (els.sidebar) els.sidebar.classList.add('is-open');
  if (els.sidebarOverlay) els.sidebarOverlay.hidden = false;
  if (els.sidebarToggle) {
    els.sidebarToggle.setAttribute('aria-expanded', 'true');
    els.sidebarToggle.setAttribute('aria-label', '关闭菜单');
  }
  document.body.classList.add('sidebar-open');
  syncSidebarA11y();
  if (!isDesktopLayout()) focusFirstMenuItem();
}

function closeDrawer() {
  const wasOpen = drawerOpen;
  drawerOpen = false;
  if (els.sidebar) els.sidebar.classList.remove('is-open');
  if (els.sidebarOverlay) els.sidebarOverlay.hidden = true;
  if (els.sidebarToggle) {
    els.sidebarToggle.setAttribute('aria-expanded', 'false');
    els.sidebarToggle.setAttribute('aria-label', '打开菜单');
  }
  document.body.classList.remove('sidebar-open');
  syncSidebarA11y();
  if (wasOpen && !isDesktopLayout() && document.body.classList.contains('admin-authed')
    && els.sidebarToggle && typeof els.sidebarToggle.focus === 'function') {
    els.sidebarToggle.focus();
  }
}

function toggleDrawer() {
  if (drawerOpen) closeDrawer();
  else openDrawer();
}

/* ------------------------------------------------------------------ */
/* 自动刷新（仅刷新当前激活的实时视图）                                  */
/* ------------------------------------------------------------------ */

function startAutoRefresh() {
  stopAutoRefresh();
  refreshPoller = createPoller(
    async () => {
      if (!state.authenticated) return;
      if (!LIVE_VIEWS.has(state.view)) return;
      if (openModals.size > 0 || document.querySelector('.modal-backdrop')) return;
      await loadView(state.view, { silent: true });
    },
    POLL_INTERVAL_MS,
    { immediate: false, hiddenPause: true, onError: () => {} },
  );
  refreshPoller.start({ runNow: false });
}

function stopAutoRefresh() {
  if (refreshPoller) {
    refreshPoller.stop();
    refreshPoller = null;
  }
}

async function refreshAfterWrite(parts = {}) {
  const tasks = [];
  if (parts.groups) tasks.push(loadGroups());
  if (parts.appRules) tasks.push(loadAppRules());
  if (parts.overview) tasks.push(loadOverview());
  if (parts.users) tasks.push(loadUsers());
  if (parts.messages) tasks.push(loadMessages());
  if (parts.config) tasks.push(loadConfig());
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed && failed.reason && failed.reason.status !== 401) {
    toastError(failed.reason, '刷新数据失败');
  }
  updateLastUpdated();
}

async function handleManualRefresh() {
  setButtonLoading(els.refreshButton, true, '刷新中…');
  try {
    await loadView(state.view, { silent: false });
  } finally {
    setButtonLoading(els.refreshButton, false);
  }
}

function loadErrorHandler(fallbackMessage) {
  return (error) => {
    if (error && error.status === 401) return;
    toastError(error, fallbackMessage);
  };
}

/* ------------------------------------------------------------------ */
/* 概览                                                                */
/* ------------------------------------------------------------------ */

async function loadOverview() {
  const data = await apiFetch('/api/admin/overview');
  state.overview = data;
  renderOverview(data);
}

function renderOverview(data) {
  const stats = data && data.stats && typeof data.stats === 'object' ? data.stats : {};
  const cards = [
    { label: '总用户数', value: stats.totalUsers, icon: '👥' },
    { label: '活跃用户', value: stats.activeUsers, icon: '🟢' },
    { label: '暂停中', value: stats.pausedUsers, icon: '⏸️' },
    { label: '可推送用户', value: stats.usersWithContextToken, icon: '📨' },
    { label: '今日消息', value: stats.messagesToday, icon: '💬' },
    { label: '24h 入站', value: stats.inboundLast24h, icon: '📥' },
    { label: '队列中', value: stats.queued, icon: '⌛' },
    { label: '发送中', value: stats.sending, icon: '🚀' },
    { label: '发送成功', value: stats.sent, icon: '✅' },
    { label: '发送失败', value: stats.failed, icon: '⚠️' },
    { label: '保活用户', value: stats.keepaliveEnabledUsers, icon: '🔁' },
    { label: '24h 保活入队', value: stats.keepaliveSent24h, icon: '📮' },
  ];
  clearNode(els.overviewStats);
  for (const card of cards) {
    els.overviewStats.append(
      el(
        'div',
        { class: 'stat-card' },
        el('span', { class: 'stat-icon', 'aria-hidden': 'true', text: card.icon }),
        el(
          'div',
          { class: 'stat-body' },
          el('span', { class: 'stat-label', text: card.label }),
          el('strong', { class: 'stat-value', text: formatNumber(card.value) }),
        ),
      ),
    );
  }

  const server = data && data.server && typeof data.server === 'object' ? data.server : {};
  const ilink = server.ilink && typeof server.ilink === 'object' ? server.ilink : {};
  const rateLimit = server.rateLimit && typeof server.rateLimit === 'object' ? server.rateLimit : {};
  const entries = [
    ['服务版本', server.version],
    ['运行时长', Number.isFinite(server.uptimeMs) ? formatDuration(server.uptimeMs) : null],
    ['服务器时间', server.now ? formatDateTime(server.now) : null],
    ['微信登录基址', ilink.loginBaseUrl],
    ['微信默认基址', ilink.defaultBaseUrl],
    ['Bot 类型', ilink.botType],
    [
      '发送限流',
      rateLimit.max !== undefined && rateLimit.max !== null
        ? `${formatNumber(rateLimit.max)} 条 / ${formatDuration(rateLimit.windowMs)}`
        : null,
    ],
    ['入站监控账号', server.monitorsRunning],
    ['活跃绑定会话', server.bindingSessionsActive],
  ];
  clearNode(els.overviewServer);
  for (const [label, value] of entries) appendKv(els.overviewServer, label, value);
}

/* ------------------------------------------------------------------ */
/* 用户分组：加载 / 渲染 / 新建 / 编辑 / 删除 / 用户归属                 */
/* ------------------------------------------------------------------ */

async function loadGroups() {
  const data = await apiFetch('/api/admin/groups');
  state.groups = data && Array.isArray(data.items) ? data.items : [];
  renderGroups();
  updateGroupFilterOptions();
}

function renderGroups() {
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

/** 仅接受 #RRGGBB，避免把接口返回的颜色直接当 CSS 使用。 */
function normalizeGroupColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : '';
}

function buildColorDot(color, className = 'group-dot') {
  const dot = el('span', { class: className, 'aria-hidden': 'true' });
  dot.style.backgroundColor = normalizeGroupColor(color) || 'var(--wechat-green)';
  return dot;
}

/** 用户/消息上的分组徽章：最多 max 个，其余显示 +N。 */
function buildGroupBadges(groups, max = 3) {
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
function isGroupKeepaliveEnabled(group) {
  if (!group) return false;
  return group.keepaliveEnabled === true || group.keepaliveEnabled === 1;
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
  const button = el('button', {
    class: `switch${enabled ? ' is-on' : ''}`,
    type: 'button',
    role: 'switch',
    'aria-checked': enabled ? 'true' : 'false',
    'aria-label': `分组 ${name} 的保活开关`,
    dataset: { action: 'keepalive', groupId: group.id, enabled: enabled ? '1' : '0' },
    title: enabled
      ? '已开启分组保活：当前成员已开启，之后加入的成员自动开启（点击关闭）'
      : '未开启分组保活（点击开启：同步当前成员，并让之后加入的成员自动开启）',
  });
  button.append(
    el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-thumb' })),
    el('span', { class: 'switch-label', text: enabled ? '保活中' : '保活' }),
  );
  return button;
}

function groupActionButton(action, groupId, label, extraClass = '') {
  return el('button', {
    class: `btn btn-secondary btn-xs${extraClass ? ` ${extraClass}` : ''}`,
    type: 'button',
    text: label,
    dataset: { action, groupId },
  });
}

function handleGroupTableClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const group = state.groups.find((item) => item.id === button.dataset.groupId);
  if (!group) return;
  const action = button.dataset.action;
  if (action === 'message') openSendMessageModal({ kind: 'group', group });
  else if (action === 'keepalive') void toggleGroupKeepalive(group, button);
  else if (action === 'edit') openGroupEditor(group);
  else if (action === 'delete') deleteGroup(group);
}

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

function updateGroupFilterOptions() {
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

/* ------------------------------------------------------------------ */
/* 接口应用（docs/API_RULES.md §7/§8）                                  */
/* ------------------------------------------------------------------ */

const RULE_RUN_STATUS_META = {
  success: { label: '成功', className: 'badge-success' },
  failed: { label: '失败', className: 'badge-danger' },
  skipped: { label: '跳过', className: 'badge-warning' },
  matched: { label: '命中', className: 'badge-info' },
};
const RULE_SCOPE_LABELS = { all: '全部用户', users: '指定用户', groups: '指定分组' };
const RULE_MATCH_LABELS = { contains: '包含', equals: '全等', regex: '正则' };
const RULE_EXTRACTION_LABELS = {
  none: '不提取（直接调用接口）',
  multi: '多参数组合提取',
};
async function loadAppRules() {
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

function renderAppRules() {
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

function scopeSummary(scope) {
  if (!scope || typeof scope !== 'object') return '全部用户';
  const typeLabel = RULE_SCOPE_LABELS[scope.type] || scope.type || '全部用户';
  if (scope.type === 'all' || !scope.type) return typeLabel;
  const names = Array.isArray(scope.names) ? scope.names.filter((name) => typeof name === 'string' && name) : [];
  if (names.length > 0) {
    return `${typeLabel}：${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 个` : ''}`;
  }
  const count = Array.isArray(scope.ids) ? scope.ids.length : 0;
  return `${typeLabel}（${count} 个）`;
}

function triggerSummary(trigger) {
  if (!trigger || typeof trigger !== 'object') return '—';
  if (trigger.matchMode === 'regex') return `正则：${trigger.regexPattern || '—'}`;
  const modeLabel = RULE_MATCH_LABELS[trigger.matchMode] || trigger.matchMode || '包含';
  const keywords = Array.isArray(trigger.keywords) ? trigger.keywords : [];
  return `${modeLabel}：${keywords.join('、') || '—'}`;
}

function buildRuleSwitch(rule) {
  const enabled = rule.enabled === true;
  const button = el('button', {
    class: `switch${enabled ? ' is-on' : ''}`,
    type: 'button',
    role: 'switch',
    'aria-checked': enabled ? 'true' : 'false',
    'aria-label': `规则「${rule.name || rule.id}」启用开关`,
    dataset: { action: 'toggle-rule', ruleId: rule.id, enabled: enabled ? '1' : '0' },
    title: enabled ? '规则已启用（点击禁用）' : '规则已禁用（点击启用）',
  });
  button.append(
    el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-thumb' })),
    el('span', { class: 'switch-label', text: enabled ? '启用' : '禁用' }),
  );
  return button;
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
      el('span', { class: `badge badge-soft ${rule.request?.method === 'POST' ? 'badge-group' : 'badge-info'}`, text: rule.request?.method || 'GET' }),
      el('div', { class: 'cell-muted rule-url', title: rule.request?.url || '', text: rule.request?.url || '—' }),
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
        ruleActionButton('test', rule.id, '测试'),
        ruleActionButton('logs', rule.id, '日志'),
        ruleActionButton('delete', rule.id, '删除', 'btn-danger-ghost'),
      ),
    ),
  );
}

function ruleActionButton(action, ruleId, label, extraClass = '') {
  return el('button', {
    class: `btn btn-secondary btn-xs${extraClass ? ` ${extraClass}` : ''}`,
    type: 'button',
    text: label,
    dataset: { action, ruleId },
  });
}

function handleAppRuleTableClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const rule = state.appRules.items.find((item) => item.id === button.dataset.ruleId);
  if (!rule) return;
  const action = button.dataset.action;
  if (action === 'toggle-rule') toggleAppRule(rule, button);
  else if (action === 'edit') openAppRuleEditor(rule);
  else if (action === 'test') openAppRuleTestModal(rule);
  else if (action === 'logs') openRuleLogsModal(rule);
  else if (action === 'delete') deleteAppRule(rule);
}

async function loadPickerUsers() {
  if (Array.isArray(state.pickerUsers)) return state.pickerUsers;
  const data = await apiFetch('/api/admin/users?status=all&limit=500&offset=0');
  state.pickerUsers = data && Array.isArray(data.items) ? data.items : [];
  return state.pickerUsers;
}

function formSection(title, hint, ...children) {
  return el(
    'div',
    { class: 'rule-form-section' },
    el('h4', { class: 'rule-form-title', text: title }),
    hint ? el('p', { class: 'form-hint', text: hint }) : null,
    ...children,
  );
}

function formField(label, control, hint, htmlFor) {
  return el(
    'div',
    { class: 'form-field' },
    label ? el('label', { class: 'form-label', for: htmlFor || undefined, text: label }) : null,
    control,
    hint ? el('p', { class: 'form-hint', text: hint }) : null,
  );
}

function parseKeywordsInput(text) {
  return String(text || '')
    .split(/[\n,，;；]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function parseHeadersInput(text) {
  const headers = {};
  for (const line of String(text || '').split('\n')) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

function openAppRuleEditor(rule = null) {
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
    checked: isEdit ? source.enabled === true : true,
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

  // 触发范围
  let scopeTypeValue = ['all', 'users', 'groups'].includes(scope.type) ? scope.type : 'all';
  const selectedUserIds = new Set(scope.type === 'users' && Array.isArray(scope.ids) ? scope.ids.map(String) : []);
  const selectedGroupIds = new Set(scope.type === 'groups' && Array.isArray(scope.ids) ? scope.ids.map(String) : []);
  const scopeRadios = ['all', 'users', 'groups'].map((type) =>
    el(
      'label',
      { class: 'radio-inline' },
      el('input', { type: 'radio', name: 'rule-scope-type', value: type, checked: type === scopeTypeValue }),
      el('span', { text: RULE_SCOPE_LABELS[type] }),
    ),
  );
  for (const radio of scopeRadios) {
    radio.querySelector('input').addEventListener('change', (event) => {
      scopeTypeValue = event.target.value;
      syncScopeVisibility();
    });
  }

  const userSearch = el('input', {
    id: 'rule-user-search',
    class: 'input',
    type: 'search',
    placeholder: '搜索用户昵称 / ID',
    autocomplete: 'off',
  });
  const userList = el('div', { id: 'rule-user-list', class: 'rule-picker-list' });
  const groupList = el('div', { id: 'rule-group-list', class: 'rule-picker-list' });
  const userPicker = el(
    'div',
    { class: 'rule-picker', hidden: true },
    userSearch,
    userList,
    el('p', { class: 'form-hint', text: '可多选；未勾选任何用户时保存会提示错误。' }),
  );
  const groupPicker = el(
    'div',
    { class: 'rule-picker', hidden: true },
    groupList,
    el('p', { class: 'form-hint', text: '可多选；用户属于任一分组即命中。' }),
  );

  function renderUserPicker(filterText = '') {
    clearNode(userList);
    const keyword = filterText.trim().toLowerCase();
    const users = Array.isArray(state.pickerUsers) ? state.pickerUsers : [];
    const filtered = users.filter((user) => {
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
        dataset: { userId: user.id },
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

  function renderGroupPicker() {
    clearNode(groupList);
    if (state.groups.length === 0) {
      groupList.append(el('p', { class: 'empty-text', text: '暂无分组，请先在「用户分组」区块创建' }));
      return;
    }
    for (const group of state.groups) {
      const checkbox = el('input', {
        type: 'checkbox',
        class: 'rule-picker-check',
        dataset: { groupId: group.id },
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

  function syncScopeVisibility() {
    for (const radio of scopeRadios) {
      radio.querySelector('input').checked = radio.querySelector('input').value === scopeTypeValue;
    }
    setHidden(userPicker, scopeTypeValue !== 'users');
    setHidden(groupPicker, scopeTypeValue !== 'groups');
  }

  userSearch.addEventListener(
    'input',
    debounce(() => renderUserPicker(userSearch.value), 200),
  );
  renderUserPicker('');
  renderGroupPicker();
  syncScopeVisibility();

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
  const regexInput = el('input', {
    id: 'rule-regex',
    class: 'input',
    type: 'text',
    placeholder: '例如：^查天气\\s*(?<city>\\S+)$',
    value: trigger.regexPattern || '',
  });
  const matchKeywordField = formField('关键词', keywordsInput, '匹配方式为「包含 / 全等」时使用，大小写不敏感。', 'rule-keywords');
  const matchRegexField = formField('正则表达式', regexInput, '匹配方式为「正则」时使用（u flag，保存时校验合法性）。', 'rule-regex');
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
  // 已保存的 Header 值不回显（仅显示名称与占位符），避免敏感值出现在页面/DOM
  const headerNamesText = headerNames.map((name) => `${name}: ••••••`).join('\n');
  const headersTextarea = el('textarea', {
    id: 'rule-headers',
    class: 'textarea',
    rows: '3',
    placeholder: '每行一个 Header，格式：Name: Value\n例如：Authorization: Bearer xxx',
    value: headerNamesText,
  });
  let headerModeValue = isEdit && headerNames.length > 0 ? 'keep' : 'replace';
  const headerHintNode = el('p', { class: 'form-hint' });
  function syncHeaderHint() {
    let hint = '每行一个 Header，格式 Name: Value；值会加密保存，保存后不再回显。';
    if (isEdit && headerNames.length > 0) {
      if (headerModeValue === 'keep') {
        hint = '已保存的 Header 值不会回显（AES 加密存储）；如需修改，请选择「重设 Header」并重新输入完整的 Name: Value。';
      } else if (headerModeValue === 'replace') {
        hint = '请按 Name: Value 每行一个重新输入；保存后将全量替换该规则现有 Header。';
      } else {
        hint = '保存后将清空该规则的所有 Header。';
      }
    }
    headerHintNode.textContent = hint;
  }
  function syncHeaderModeUi() {
    headersTextarea.disabled = headerModeValue !== 'replace';
    if (headerModeValue === 'keep') headersTextarea.value = headerNamesText;
    else headersTextarea.value = '';
    syncHeaderHint();
  }
  const headerModeRadios = ['keep', 'replace', 'clear'].map((mode) => {
    const label = mode === 'keep' ? '保留现有 Header' : mode === 'replace' ? '重设 Header' : '清空 Header';
    return el(
      'label',
      { class: `radio-inline${isEdit && headerNames.length > 0 ? '' : ' is-hidden'}`, hidden: !(isEdit && headerNames.length > 0) },
      el('input', { type: 'radio', name: 'rule-header-mode', value: mode, checked: mode === headerModeValue }),
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
  const bodyTemplateInput = el('textarea', {
    id: 'rule-body',
    class: 'textarea',
    rows: '3',
    placeholder: 'POST 请求体模板，可插入 {参数}；GET 请求忽略该字段',
    value: request.bodyTemplate || '',
  });
  const bodyField = formField('Body 模板（POST）', bodyTemplateInput, null, 'rule-body');
  function syncRuleRequestFields() {
    setHidden(bodyField, methodSelect.value !== 'POST');
  }
  methodSelect.addEventListener('change', syncRuleRequestFields);
  syncRuleRequestFields();

  // 响应
  const responseTypeSelect = el(
    'select',
    { id: 'rule-response-type', class: 'select' },
    ...['json', 'text'].map((type) =>
      el('option', { value: type, text: type === 'json' ? 'JSON' : '文本', selected: (response.type || 'json') === type }),
    ),
  );
  const responsePathInput = el('input', {
    id: 'rule-response-path',
    class: 'input',
    type: 'text',
    placeholder: '例如：data.answer（点路径，可含数组下标）',
    value: response.path || '',
  });
  const replyTemplateInput = el('textarea', {
    id: 'rule-reply-template',
    class: 'textarea',
    rows: '2',
    placeholder: '例如：天气：{{data.answer}}（支持 {{路径}}、{{response}}、{{raw}}）',
    value: response.template || '',
  });
  const fallbackInput = el('input', {
    id: 'rule-fallback',
    class: 'input',
    type: 'text',
    placeholder: '接口失败 / 无有效回复时发送的文案（可为空）',
    value: response.fallbackText || '',
  });

  // 限制
  const timeoutInput = el('input', {
    id: 'rule-timeout',
    class: 'input input-narrow',
    type: 'number',
    min: '1000',
    max: '30000',
    step: '500',
    value: String(Number(limits.timeoutMs) || 8000),
  });
  const cooldownInput = el('input', {
    id: 'rule-cooldown',
    class: 'input input-narrow',
    type: 'number',
    min: '0',
    max: '3600000',
    step: '1000',
    value: String(Number.isFinite(Number(limits.cooldownMs)) ? Number(limits.cooldownMs) : 10000),
  });
  const maxCallsInput = el('input', {
    id: 'rule-max-calls',
    class: 'input input-narrow',
    type: 'number',
    min: '1',
    max: '10000',
    step: '1',
    value: String(Number(limits.maxCallsPerHour) || 60),
  });
  const maxUserCallsInput = el('input', {
    id: 'rule-max-user-calls',
    class: 'input input-narrow',
    type: 'number',
    min: '1',
    max: '10000',
    step: '1',
    value: String(Number(limits.maxUserCallsPerHour) || 10),
  });

  const errorNode = el('p', { id: 'rule-form-error', class: 'inline-error', role: 'alert', hidden: true });
  function showFormError(message) {
    errorNode.textContent = message;
    errorNode.hidden = false;
    errorNode.scrollIntoView({ block: 'nearest' });
  }

  const content = [
    formSection(
      '基本信息',
      null,
      el(
        'div',
        { class: 'rule-form-grid' },
        formField('规则名称（必填，1-60 字符）', nameInput, null, 'rule-name-input'),
        el(
          'div',
          { class: 'form-field' },
          el('span', { class: 'form-label', text: '启用与优先级' }),
          el(
            'div',
            { class: 'rule-inline-row' },
            el('label', { class: 'rule-inline-check' }, enabledInput, el('span', { text: '启用规则' })),
            el('span', { class: 'form-hint', text: '优先级（越小越先）' }),
            priorityInput,
          ),
        ),
      ),
      errorNode,
    ),
    formSection(
      '触发范围',
      '仅对范围内用户的入站消息触发；范围不命中不会写日志。',
      el('div', { class: 'radio-list rule-radio-row' }, ...scopeRadios),
      userPicker,
      groupPicker,
    ),
    formSection(
      '触发条件',
      '一消息最多命中一条规则；多规则命中时按优先级取第一条。',
      el('div', { class: 'rule-form-grid' }, formField('匹配方式', matchModeSelect, null, 'rule-match-mode')),
      matchKeywordField,
      matchRegexField,
    ),
    formSection(
      '参数提取',
      '从消息中提取变量，供请求 URL / Header / Body 模板使用；缺参时不调用接口。',
      el(
        'div',
        { class: 'rule-form-grid' },
        formField('提取模式', extractionModeSelect, null, 'rule-extraction-mode'),
        extractionConfigBox,
      ),
    ),
    formSection(
      '请求',
      'URL / Header / Body 支持 {变量} 占位；URL 中的变量会做 URL 编码。GET 参数写在 URL 查询串，POST 可用 URL 查询参数 + Body（Body 可留空）。默认拒绝访问内网/本机（SSRF 防护）。',
      el(
        'div',
        { class: 'rule-form-grid' },
        formField('请求方法', methodSelect, null, 'rule-request-method'),
        formField('请求 URL（必填，http/https）', urlInput, null, 'rule-request-url'),
      ),
      isEdit && headerNames.length > 0
        ? el('div', { class: 'form-field' }, el('span', { class: 'form-label', text: 'Header 处理' }), el('div', { class: 'radio-list rule-radio-row' }, ...headerModeRadios))
        : null,
      el(
        'div',
        { class: 'form-field' },
        el('label', { class: 'form-label', for: 'rule-headers', text: 'Header 列表（每行 Name: Value）' }),
        headersTextarea,
        headerHintNode,
      ),
      bodyField,
    ),
    formSection(
      '响应解析与回复',
      null,
      el(
        'div',
        { class: 'rule-form-grid' },
        formField('响应类型', responseTypeSelect, null, 'rule-response-type'),
        formField('JSON 路径（response.type=json）', responsePathInput, '例如 data.answer；为空时优先取 reply 字段。', 'rule-response-path'),
      ),
      formField('回复模板', replyTemplateInput, '支持 {{data.answer}}、{{reply}}、{{response}}、{{raw}}；JSON 路径选中节点即模板根（路径=data.list 时写 {{count .}}/{{#each .}}，空路径才写 {{data.list}}）。支持多层循环、{{../字段}}、{{../@index}}、{{@root.字段}}/{{@responseRoot.字段}}（@root=模板根、@responseRoot=完整响应根；@index/@number 为循环下标/序号），可用 where 字段=值 过滤；为空时直接使用解析结果。', 'rule-reply-template'),
      formField('兜底文案', fallbackInput, '接口失败 / 缺参 / 空回复时发送（可为空）。', 'rule-fallback'),
    ),
    formSection(
      '限制',
      null,
      el(
        'div',
        { class: 'rule-form-grid rule-form-grid-4' },
        formField('超时（ms，1000-30000）', timeoutInput, null, 'rule-timeout'),
        formField('同用户冷却（ms，0-3600000）', cooldownInput, null, 'rule-cooldown'),
        formField('规则每小时上限（1-10000）', maxCallsInput, null, 'rule-max-calls'),
        formField('同用户每小时上限（1-10000）', maxUserCallsInput, null, 'rule-max-user-calls'),
      ),
    ),
  ];

  openTrackedModal({
    title: isEdit ? '编辑接口应用规则' : '新建接口应用规则',
    size: 'wide',
    closeOnBackdrop: false,
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
          if (!name) return showFormError('请输入规则名称');
          if (name.length > 60) return showFormError('规则名称不能超过 60 个字符');
          const scopeIds =
            scopeTypeValue === 'users'
              ? [...selectedUserIds]
              : scopeTypeValue === 'groups'
                ? [...selectedGroupIds]
                : [];
          if (scopeTypeValue !== 'all' && scopeIds.length === 0) {
            return showFormError(scopeTypeValue === 'users' ? '请至少选择一位用户' : '请至少选择一个分组');
          }
          const keywords = parseKeywordsInput(keywordsInput.value);
          if (matchModeSelect.value !== 'regex') {
            if (keywords.length < 1 || keywords.length > 10) return showFormError('关键词数量必须是 1-10 个');
            if (keywords.some((keyword) => keyword.length > 50)) return showFormError('每个关键词最多 50 个字符');
          } else if (!regexInput.value.trim()) {
            return showFormError('请输入正则表达式');
          }
          const extractionMode = extractionModeSelect.value;
          const extractionCfg = {};
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
          const url = urlInput.value.trim();
          if (!/^https?:\/\//i.test(url)) return showFormError('请求 URL 必须是 http(s) 地址');
          let headersPayload;
          if (!isEdit || headerNames.length === 0) {
            const headers = parseHeadersInput(headersTextarea.value);
            headersPayload = Object.keys(headers).length > 0 ? headers : undefined;
          } else if (headerModeValue === 'keep') {
            headersPayload = undefined;
          } else if (headerModeValue === 'clear') {
            headersPayload = {};
          } else {
            headersPayload = parseHeadersInput(headersTextarea.value);
          }
          const requestBody = { method: methodSelect.value, url };
          if (headersPayload !== undefined) requestBody.headers = headersPayload;
          if (methodSelect.value === 'POST') requestBody.bodyTemplate = bodyTemplateInput.value;

          const payload = {
            name,
            enabled: enabledInput.checked,
            priority: Number(priorityInput.value),
            scope: { type: scopeTypeValue, ids: scopeIds },
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
            cooldownMs: Number(cooldownInput.value),
            maxCallsPerHour: Number(maxCallsInput.value),
            maxUserCallsPerHour: Number(maxUserCallsInput.value),
          };
          modal.setBusy(true);
          try {
            const headersSaved = headersPayload !== undefined && Object.keys(headersPayload).length > 0;
            const savedSuffix = headersSaved ? '；Header 值已加密保存（不会回显）' : '';
            if (isEdit) {
              await apiFetch(`/api/admin/app-rules/${encodeURIComponent(rule.id)}`, { method: 'PATCH', body: payload });
              toast(`规则「${name}」已保存${savedSuffix}`, 'success');
            } else {
              await apiFetch('/api/admin/app-rules', { method: 'POST', body: payload });
              toast(`规则「${name}」已创建${savedSuffix}`, 'success');
            }
            modal.close('saved');
            await refreshAfterWrite({ appRules: true });
          } catch (error) {
            if (error && error.status === 400) showFormError(error.message || '参数校验失败');
            else showFormError(error && error.message ? error.message : '保存规则失败');
            if (error && error.status >= 500) toastError(error, '保存规则失败');
          } finally {
            modal.setBusy(false);
          }
        },
      },
    ],
  });

  loadPickerUsers()
    .then((users) => {
      if (users.length > 0) renderUserPicker(userSearch.value);
    })
    .catch((error) => {
      renderUserPicker('');
      if (error && error.status !== 401) toastError(error, '加载用户列表失败');
    });
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
  const resultBox = el('div', { id: 'rule-test-result', class: 'rule-test-result', hidden: true });
  const modal = openTrackedModal({
    title: `测试运行：${rule.name || rule.id}`,
    size: 'wide',
    content: [
      el('p', { class: 'form-hint', text: '测试运行仅模拟一次触发并调用外部接口，不会向微信用户发送消息、不写运行日志。' }),
      formField('示例消息（必填）', messageInput, null, 'rule-test-message'),
      formField('模拟用户（可选，用于范围匹配）', userSelect, null, 'rule-test-user'),
      resultBox,
    ],
    actions: [
      { label: '关闭', class: 'btn btn-secondary' },
      {
        label: '运行测试',
        class: 'btn btn-primary',
        closeOnClick: false,
        onClick: async (modalRef) => {
          const message = messageInput.value.trim();
          if (!message) {
            toast('请输入示例消息', 'warning');
            messageInput.focus();
            return;
          }
          modalRef.setBusy(true);
          try {
            const data = await apiFetch(`/api/admin/app-rules/${encodeURIComponent(rule.id)}/test`, {
              method: 'POST',
              body: { message, ...(userSelect.value ? { userId: userSelect.value } : {}) },
            });
            clearNode(resultBox);
            resultBox.hidden = false;
            resultBox.append(...buildRuleTestResultNodes(data).filter(Boolean));
          } catch (error) {
            clearNode(resultBox);
            resultBox.hidden = false;
            resultBox.append(el('p', { class: 'inline-error', text: error && error.message ? error.message : '测试运行失败' }));
            toastError(error, '测试运行失败');
          } finally {
            modalRef.setBusy(false);
          }
        },
      },
    ],
  });
  void modal;
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
      el('div', { class: 'rule-test-request', text: `${request.method || 'GET'} ${request.url || ''}` }),
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

/* ------------------------------------------------------------------ */
/* 接口应用页内 Tab + 规则运行日志弹窗                                   */
/* ------------------------------------------------------------------ */

function setRuleTab(tab) {
  const target = tab === 'schedule' ? 'schedule' : 'rules';
  state.ruleTab = target;
  for (const button of $$('button[data-rule-tab]', els.ruleTabs)) {
    const active = button.dataset.ruleTab === target;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
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
 * 规则运行日志弹窗（与定时通知运行日志弹窗同风格：状态筛选 + 分页）。
 * GET /api/admin/app-rule-logs?ruleId=&status=&limit=&offset=
 */
function openRuleLogsModal(rule) {
  const local = { status: '', offset: 0, limit: PAGE_SIZE, total: 0 };
  const statusSelect = el(
    'select',
    { id: 'rule-log-modal-status', class: 'select' },
    ...[
      ['', '全部状态'],
      ['success', '成功'],
      ['failed', '失败'],
      ['skipped', '跳过'],
      ['matched', '命中'],
    ].map(([value, label]) => el('option', { value, text: label })),
  );
  const tbody = el('tbody', { id: 'rule-log-modal-body' });
  const pageInfo = el('span', { id: 'rule-log-modal-page-info', class: 'pagination-info', text: '第 1 / 1 页' });
  const prevButton = el('button', { id: 'rule-log-modal-prev', class: 'btn btn-secondary btn-sm', type: 'button', text: '上一页' });
  const nextButton = el('button', { id: 'rule-log-modal-next', class: 'btn btn-secondary btn-sm', type: 'button', text: '下一页' });
  const body = el(
    'div',
    { class: 'rule-logs' },
    el(
      'div',
      { class: 'toolbar toolbar-slim' },
      statusSelect,
      el('span', { class: 'form-hint', text: `规则：${rule.name || rule.id}；按时间倒序展示最近运行记录。` }),
    ),
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data-table data-table-logs' },
        el('thead', {}, el('tr', {},
          ...['时间', '规则', '用户', '状态', 'HTTP', '耗时', '错误', '参数预览', '响应预览'].map((label) =>
            el('th', { scope: 'col', text: label }),
          ),
        )),
        tbody,
      ),
    ),
    el('div', { class: 'pagination' }, prevButton, pageInfo, nextButton),
  );

  async function load() {
    clearNode(tbody);
    tbody.append(el('tr', {}, el('td', { class: 'empty-cell', colspan: '9' }, el('span', { class: 'empty-text', text: '加载中…' }))));
    try {
      const params = new URLSearchParams();
      params.set('ruleId', rule.id);
      params.set('limit', String(local.limit));
      params.set('offset', String(local.offset));
      if (local.status) params.set('status', local.status);
      const data = await apiFetch(`/api/admin/app-rule-logs?${params.toString()}`);
      local.total = toCount(data && data.total);
      const items = data && Array.isArray(data.items) ? data.items : [];
      clearNode(tbody);
      if (items.length === 0) {
        tbody.append(el('tr', {}, el('td', { class: 'empty-cell', colspan: '9' }, el('span', { class: 'empty-text', text: '暂无运行日志' }))));
      } else {
        for (const log of items) {
          const statusMeta = RULE_RUN_STATUS_META[log.status] || { label: log.status || '—', className: 'badge-muted' };
          tbody.append(
            el('tr', {},
              el('td', { class: 'cell-nowrap' }, el('div', { text: formatDateTime(log.createdAt) }), el('div', { class: 'cell-muted', text: formatRelative(log.createdAt) })),
              el('td', { class: 'cell-mono', text: log.ruleName || log.ruleId || '—' }),
              el('td', { class: 'cell-mono', text: log.userId || '—' }),
              el('td', {}, el('span', { class: `badge ${statusMeta.className}`, text: statusMeta.label })),
              el('td', { class: 'cell-mono', text: log.httpStatus === null || log.httpStatus === undefined ? '—' : String(log.httpStatus) }),
              el('td', { class: 'cell-mono cell-nowrap', text: log.latencyMs === null || log.latencyMs === undefined ? '—' : `${log.latencyMs} ms` }),
              el('td', { class: 'cell-error', text: log.error || '—' }),
              el('td', { class: 'cell-muted log-preview', title: log.paramsPreview || '', text: log.paramsPreview || '—' }),
              el('td', { class: 'cell-muted log-preview', title: log.responsePreview || '', text: log.responsePreview || '—' }),
            ),
          );
        }
      }
      updatePagination();
    } catch (error) {
      clearNode(tbody);
      tbody.append(el('tr', {}, el('td', { class: 'empty-cell', colspan: '9' }, el('span', { class: 'inline-error', text: error && error.message ? error.message : '加载日志失败' }))));
      if (error && error.status !== 401) toastError(error, '加载规则运行日志失败');
    }
  }

  function updatePagination() {
    const totalPages = Math.max(1, Math.ceil(local.total / local.limit));
    const currentPage = Math.min(totalPages, Math.floor(local.offset / local.limit) + 1);
    pageInfo.textContent = `第 ${currentPage} / ${totalPages} 页 · 共 ${formatNumber(local.total)} 条`;
    prevButton.disabled = currentPage <= 1;
    nextButton.disabled = currentPage >= totalPages;
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

  openTrackedModal({
    title: `运行日志：${rule.name || rule.id}`,
    size: 'wide',
    content: [body],
    actions: [{ label: '关闭', class: 'btn btn-secondary' }],
  });
  void load();
}

/* ------------------------------------------------------------------ */
/* 定时通知（docs/SCHEDULED_TASKS.md §5/§6；接口应用第三个 Tab）          */
/* ------------------------------------------------------------------ */

const SCHEDULE_STATUS_META = {
  success: { label: '成功', className: 'badge-success' },
  failed: { label: '失败', className: 'badge-danger' },
  skipped: { label: '跳过', className: 'badge-warning' },
};

async function loadScheduledTasks() {
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

function formatIntervalSummary(intervalMs) {
  const minutes = Math.max(1, Math.round(Number(intervalMs || 0) / 60000));
  if (minutes < 60) return `每 ${formatNumber(minutes)} 分钟`;
  const hours = minutes / 60;
  if (Number.isInteger(hours) && hours < 48) return `每 ${formatNumber(hours)} 小时`;
  const days = hours / 24;
  if (Number.isInteger(days)) return `每 ${formatNumber(days)} 天`;
  return `每 ${formatNumber(minutes)} 分钟`;
}

function schedulePlanSummary(task) {
  const schedule = task && task.schedule && typeof task.schedule === 'object' ? task.schedule : {};
  if (schedule.type === 'daily') {
    return `每天 ${schedule.dailyTime || '08:00'}（${schedule.timezone || scheduleTimezone()}）`;
  }
  const summary = formatIntervalSummary(schedule.intervalMs || 3600000);
  const windowStart = typeof schedule.windowStart === 'string' ? schedule.windowStart.trim() : '';
  const windowEnd = typeof schedule.windowEnd === 'string' ? schedule.windowEnd.trim() : '';
  if (windowStart && windowEnd) return `${summary}（${windowStart}–${windowEnd}）`;
  return summary;
}

function scheduleTargetSummary(task) {
  const targets = task && task.targets && typeof task.targets === 'object' ? task.targets : {};
  const ids = Array.isArray(targets.ids) ? targets.ids : [];
  const names = Array.isArray(targets.names) ? targets.names.filter(Boolean) : [];
  if (targets.type === 'groups') {
    const label = `${formatNumber(ids.length)} 个分组`;
    return names.length > 0
      ? `${label}：${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 个` : ''}`
      : label;
  }
  return `${formatNumber(ids.length)} 位用户`;
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
  const button = el('button', {
    class: `switch${enabled ? ' is-on' : ''}`,
    type: 'button',
    role: 'switch',
    'aria-checked': enabled ? 'true' : 'false',
    'aria-label': `定时任务「${task.name || task.id}」启用开关`,
    dataset: { action: 'schedule-toggle', taskId: task.id, enabled: enabled ? '1' : '0' },
    title: enabled ? '任务已启用（点击停用）' : '任务已停用（点击启用）',
  });
  button.append(
    el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-thumb' })),
    el('span', { class: 'switch-label', text: enabled ? '启用' : '停用' }),
  );
  return button;
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
        scheduleActionButton('schedule-test', task.id, '测试运行'),
        scheduleActionButton('schedule-run', task.id, '立即执行'),
        scheduleActionButton('schedule-logs', task.id, '运行日志'),
        scheduleActionButton('schedule-delete', task.id, '删除', 'btn-danger-ghost'),
      ),
    ),
  );
}

function scheduleActionButton(action, taskId, label, extraClass = '') {
  return el('button', {
    class: `btn btn-secondary btn-xs${extraClass ? ` ${extraClass}` : ''}`,
    type: 'button',
    text: label,
    dataset: { action, taskId },
  });
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

function handleScheduleTableClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const task = state.scheduled.items.find((item) => item.id === button.dataset.taskId);
  if (!task) return;
  const action = button.dataset.action;
  if (action === 'schedule-toggle') toggleScheduledTask(task, button);
  else if (action === 'schedule-edit') openScheduleEditor(task);
  else if (action === 'schedule-test') openScheduleTestModal(task);
  else if (action === 'schedule-run') runScheduledTask(task);
  else if (action === 'schedule-logs') openScheduleLogsModal(task);
  else if (action === 'schedule-delete') deleteScheduledTask(task);
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

async function openScheduleEditor(task = null) {
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
    checked: isEdit ? source.enabled === true : true,
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
      { class: 'rule-form-grid' },
      formField('开始时间（HH:mm）', windowStartInput, null, 'schedule-window-start'),
      formField('结束时间（HH:mm）', windowEndInput, '支持跨午夜，如 22:00–06:00。', 'schedule-window-end'),
    ),
    el('p', {
      class: 'form-hint',
      text: '留空=全天生效；两个时间需同时填写或同时留空，开始时间不能等于结束时间。',
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

  // 目标
  let targetType = targets.type === 'groups' ? 'groups' : 'users';
  const selectedUserIds = new Set(
    targetType === 'users' && Array.isArray(targets.ids) ? targets.ids.map(String) : [],
  );
  const selectedGroupIds = new Set(
    targetType === 'groups' && Array.isArray(targets.ids) ? targets.ids.map(String) : [],
  );
  const targetRadios = ['users', 'groups'].map((type) =>
    el(
      'label',
      { class: 'radio-inline' },
      el('input', { type: 'radio', name: 'schedule-target-type', value: type, checked: type === targetType }),
      el('span', { text: type === 'users' ? '指定用户' : '指定分组' }),
    ),
  );
  for (const radio of targetRadios) {
    radio.querySelector('input').addEventListener('change', (event) => {
      targetType = event.target.value === 'groups' ? 'groups' : 'users';
      syncTargetVisibility();
    });
  }

  const userSearch = el('input', {
    id: 'schedule-user-search',
    class: 'input',
    type: 'search',
    placeholder: '搜索用户昵称 / ID',
    autocomplete: 'off',
  });
  const userList = el('div', { id: 'schedule-user-list', class: 'rule-picker-list' });
  const groupList = el('div', { id: 'schedule-group-list', class: 'rule-picker-list' });
  const userPicker = el('div', { class: 'rule-picker', hidden: true }, userSearch, userList);
  const groupPicker = el('div', { class: 'rule-picker', hidden: true }, groupList);

  function renderScheduleUserPicker(filterText = '') {
    clearNode(userList);
    const keyword = String(filterText || '').trim().toLowerCase();
    const users = Array.isArray(pickerUsers) ? pickerUsers : [];
    const filtered = users.filter((user) => {
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
        dataset: { scheduleUserId: String(user.id) },
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

  function renderScheduleGroupPicker() {
    clearNode(groupList);
    if (state.groups.length === 0) {
      groupList.append(el('p', { class: 'empty-text', text: '暂无分组，请先在「用户分组」区块创建' }));
      return;
    }
    for (const group of state.groups) {
      const checkbox = el('input', {
        type: 'checkbox',
        class: 'rule-picker-check',
        dataset: { scheduleGroupId: String(group.id) },
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

  function selectAllUsers(select) {
    for (const checkbox of userList.querySelectorAll('input[data-schedule-user-id]')) {
      checkbox.checked = select;
      const userId = checkbox.dataset.scheduleUserId;
      if (select) selectedUserIds.add(userId);
      else selectedUserIds.delete(userId);
    }
  }
  function selectAllGroups(select) {
    for (const checkbox of groupList.querySelectorAll('input[data-schedule-group-id]')) {
      checkbox.checked = select;
      const groupId = checkbox.dataset.scheduleGroupId;
      if (select) selectedGroupIds.add(groupId);
      else selectedGroupIds.delete(groupId);
    }
  }
  const userPickerActions = el(
    'div',
    { class: 'toolbar-slim schedule-picker-actions' },
    el('button', { id: 'schedule-users-all', class: 'btn btn-secondary btn-xs', type: 'button', text: '全选用户' }),
    el('button', { id: 'schedule-users-clear', class: 'btn btn-ghost btn-xs', type: 'button', text: '清空' }),
  );
  const groupPickerActions = el(
    'div',
    { class: 'toolbar-slim schedule-picker-actions' },
    el('button', { id: 'schedule-groups-all', class: 'btn btn-secondary btn-xs', type: 'button', text: '全选分组' }),
    el('button', { id: 'schedule-groups-clear', class: 'btn btn-ghost btn-xs', type: 'button', text: '清空' }),
  );
  userPickerActions.querySelector('#schedule-users-all').addEventListener('click', () => selectAllUsers(true));
  userPickerActions.querySelector('#schedule-users-clear').addEventListener('click', () => selectAllUsers(false));
  groupPickerActions.querySelector('#schedule-groups-all').addEventListener('click', () => selectAllGroups(true));
  groupPickerActions.querySelector('#schedule-groups-clear').addEventListener('click', () => selectAllGroups(false));
  userPicker.prepend(userPickerActions);
  groupPicker.prepend(groupPickerActions);
  userSearch.addEventListener(
    'input',
    debounce(() => renderScheduleUserPicker(userSearch.value), 200),
  );
  renderScheduleUserPicker('');
  renderScheduleGroupPicker();

  function syncTargetVisibility() {
    for (const radio of targetRadios) {
      radio.querySelector('input').checked = radio.querySelector('input').value === targetType;
    }
    setHidden(userPicker, targetType !== 'users');
    setHidden(groupPicker, targetType !== 'groups');
  }
  syncTargetVisibility();

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
  const headerMask = headerNames.length > 0
    ? el('p', {
        class: 'form-hint schedule-header-mask',
        text: `现有 Header（值已加密不回显）：${headerNames.map((name) => `${name}: ••••••`).join('；')}`,
      })
    : null;
  const headersTextarea = el('textarea', {
    id: 'schedule-headers',
    class: 'textarea',
    rows: '3',
    placeholder: '每行一个 Header，格式：Name: Value（不传则保留原 Header）',
    value: headerNames.map((name) => `${name}: `).join('\n'),
  });
  let headerModeValue = isEdit && headerNames.length > 0 ? 'keep' : 'replace';
  const headerModeRadios = ['keep', 'replace', 'clear'].map((mode) => {
    const label = mode === 'keep' ? '保留现有 Header' : mode === 'replace' ? '重设 Header' : '清空 Header';
    return el(
      'label',
      { class: 'radio-inline', hidden: !(isEdit && headerNames.length > 0) },
      el('input', { type: 'radio', name: 'schedule-header-mode', value: mode, checked: mode === headerModeValue }),
      el('span', { text: label }),
    );
  });
  for (const label of headerModeRadios) {
    label.querySelector('input').addEventListener('change', (event) => {
      headerModeValue = event.target.value;
      headersTextarea.disabled = headerModeValue !== 'replace';
      if (headerModeValue === 'clear') headersTextarea.value = '';
      if (headerModeValue === 'keep') headersTextarea.value = headerNames.map((name) => `${name}: `).join('\n');
    });
  }
  headersTextarea.disabled = headerModeValue !== 'replace';
  const bodyTemplateInput = el('textarea', {
    id: 'schedule-body',
    class: 'textarea',
    rows: '3',
    placeholder: 'POST 请求体模板（支持 {now}/{date}/{time}/{taskName}）；仅 POST 显示，GET 参数请写在 URL 中',
    value: request.bodyTemplate || '',
  });
  const bodyField = formField('Body 模板（POST）', bodyTemplateInput, null, 'schedule-body');
  function syncScheduleRequestFields() {
    setHidden(bodyField, methodSelect.value !== 'POST');
  }
  methodSelect.addEventListener('change', syncScheduleRequestFields);
  syncScheduleRequestFields();

  // 响应
  const responseTypeSelect = el(
    'select',
    { id: 'schedule-response-type', class: 'select' },
    ...['json', 'text'].map((type) =>
      el('option', { value: type, text: type === 'json' ? 'JSON' : '文本', selected: (response.type || 'json') === type }),
    ),
  );
  const responsePathInput = el('input', {
    id: 'schedule-response-path',
    class: 'input',
    type: 'text',
    placeholder: '例如：data.weather（点路径，可含数组下标）',
    value: response.path || '',
  });
  const replyTemplateInput = el('textarea', {
    id: 'schedule-reply-template',
    class: 'textarea',
    rows: '2',
    placeholder: '例如：{{city}} 今天 {{weather}}，{{temp_min}}~{{temp_max}}℃（支持 {{路径}}/{{response}}/{{raw}}）',
    value: response.template || '',
  });
  const fallbackInput = el('input', {
    id: 'schedule-fallback',
    class: 'input',
    type: 'text',
    placeholder: '接口失败时的兜底通知文案（为空则本次不发送）',
    value: response.fallbackText || '',
  });
  const timeoutInput = el('input', {
    id: 'schedule-timeout',
    class: 'input input-narrow',
    type: 'number',
    min: '1000',
    max: '30000',
    step: '500',
    value: String(Number(limits.timeoutMs) || 8000),
  });

  const errorNode = el('p', { id: 'schedule-form-error', class: 'inline-error', role: 'alert', hidden: true });
  function showFormError(message) {
    errorNode.textContent = message;
    errorNode.hidden = false;
    errorNode.scrollIntoView({ block: 'nearest' });
  }

  const content = [
    formSection(
      '基本信息',
      null,
      formField('任务名称（必填，1-60 字符）', nameInput, null, 'schedule-name-input'),
      el('label', { class: 'check-field' }, enabledInput, el('span', { class: 'check-field-text' }, el('strong', { text: '启用任务' }), el('span', { class: 'form-hint', text: '停用后调度器不再自动执行，也可手动「立即执行」。' }))),
      errorNode,
    ),
    formSection(
      '计划',
      '间隔任务从上次执行时间 + 间隔计算下次；每日任务按服务端时区 HH:mm 执行。',
      formField('计划类型', typeSelect, null, 'schedule-type'),
      intervalField,
      windowField,
      dailyField,
      timezoneHint,
    ),
    formSection(
      '目标',
      '通知发送给指定用户或指定分组的 active 用户（去重，受服务端单次收件上限约束）。',
      el('div', { class: 'radio-list rule-radio-row' }, ...targetRadios),
      userPicker,
      groupPicker,
    ),
    formSection(
      '请求',
      'URL / Header / Body 支持内置变量 {now}/{date}/{time}/{taskName}；GET 参数写在 URL 查询串，POST 可用 URL 查询参数 + Body（Body 可留空）。默认拒绝内网/本机（SSRF 防护）。',
      el('div', { class: 'rule-form-grid' },
        formField('请求方法', methodSelect, null, 'schedule-request-method'),
        formField('请求 URL（必填，http/https）', urlInput, null, 'schedule-request-url'),
      ),
      isEdit && headerNames.length > 0
        ? el('div', { class: 'form-field' }, el('span', { class: 'form-label', text: 'Header 处理' }), el('div', { class: 'radio-list rule-radio-row' }, ...headerModeRadios), headerMask)
        : null,
      formField('Header 列表（每行 Name: Value）', headersTextarea, '编辑时：不传=保留现有；传 {} 清空；重新输入=全量替换。', 'schedule-headers'),
      bodyField,
    ),
    formSection(
      '响应与通知',
      null,
      el('div', { class: 'rule-form-grid' },
        formField('响应类型', responseTypeSelect, null, 'schedule-response-type'),
        formField('JSON 路径', responsePathInput, 'response.type=json 时按点路径取值。', 'schedule-response-path'),
      ),
      formField('通知模板', replyTemplateInput, '支持 {{路径}}、{{response}}、{{raw}}；JSON 路径选中节点即模板根（路径=data.list 时写 {{count .}}/{{#each .}}，空路径才写 {{data.list}}）。支持多层循环、{{../字段}}、{{../@index}}、{{@root.字段}}/{{@responseRoot.字段}}（@root=模板根、@responseRoot=完整响应根；@index/@number 为循环下标/序号），可用 where 字段=值 过滤；为空时直接使用解析结果。', 'schedule-reply-template'),
      formField('兜底文案', fallbackInput, '接口失败/解析失败时发给全部目标；为空则不发送。', 'schedule-fallback'),
      formField('超时（ms，1000-30000）', timeoutInput, null, 'schedule-timeout'),
    ),
  ];

  openTrackedModal({
    title: isEdit ? '编辑定时任务' : '新建定时任务',
    size: 'wide',
    closeOnBackdrop: false,
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
          if (!name) return showFormError('请输入任务名称');
          if (name.length > 60) return showFormError('任务名称不能超过 60 个字符');
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
          const ids = targetType === 'users' ? [...selectedUserIds] : [...selectedGroupIds];
          if (ids.length === 0) {
            return showFormError(targetType === 'users' ? '请至少选择一位用户' : '请至少选择一个分组');
          }
          const url = urlInput.value.trim();
          if (!/^https?:\/\//i.test(url)) return showFormError('请求 URL 必须是 http(s) 地址');
          let headersPayload;
          if (!isEdit || headerNames.length === 0) {
            const headers = parseHeadersInput(headersTextarea.value);
            headersPayload = Object.keys(headers).length > 0 ? headers : undefined;
          } else if (headerModeValue === 'keep') {
            headersPayload = undefined;
          } else if (headerModeValue === 'clear') {
            headersPayload = {};
          } else {
            headersPayload = parseHeadersInput(headersTextarea.value);
          }
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
          modal.setBusy(true);
          try {
            if (isEdit) {
              await apiFetch(`/api/admin/scheduled-tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: payload });
              toast(`定时任务「${name}」已保存`, 'success');
            } else {
              await apiFetch('/api/admin/scheduled-tasks', { method: 'POST', body: payload });
              toast(`定时任务「${name}」已创建`, 'success');
            }
            modal.close('saved');
            await loadScheduledTasks();
          } catch (error) {
            showFormError(error && error.message ? error.message : '保存定时任务失败');
            if (error && error.status >= 500) toastError(error, '保存定时任务失败');
          } finally {
            modal.setBusy(false);
          }
        },
      },
    ],
  });
}

async function openScheduleTestModal(task) {
  const resultBox = el('div', { id: 'schedule-test-result', class: 'rule-test-result', hidden: true });
  openTrackedModal({
    title: `测试运行：${task.name || task.id}`,
    size: 'wide',
    content: [
      el('p', { class: 'form-hint', text: '测试运行会真实调用外部接口并渲染通知文本，但不会发送给任何用户、也不写运行日志。' }),
      resultBox,
    ],
    actions: [
      { label: '关闭', class: 'btn btn-secondary' },
      {
        label: '运行测试',
        class: 'btn btn-primary',
        closeOnClick: false,
        onClick: async (modalRef) => {
          modalRef.setBusy(true);
          try {
            const data = await apiFetch(`/api/admin/scheduled-tasks/${encodeURIComponent(task.id)}/test`, {
              method: 'POST',
              body: {},
            });
            clearNode(resultBox);
            resultBox.hidden = false;
            resultBox.append(...buildScheduleTestResultNodes(data).filter(Boolean));
          } catch (error) {
            clearNode(resultBox);
            resultBox.hidden = false;
            resultBox.append(el('p', { class: 'inline-error', text: error && error.message ? error.message : '测试运行失败' }));
            toastError(error, '测试运行失败');
          } finally {
            modalRef.setBusy(false);
          }
        },
      },
    ],
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
    message: `将立即执行任务「${task.name || task.id}」：真实调用外部接口并把通知发送给目标用户（会占用微信发送限流），确定继续？`,
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
      toast(`执行完成：已将 ${formatNumber(Number.isFinite(recipients) ? recipients : 0)} 条通知加入发送队列（微信送达受限流影响）`, 'success');
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
  const local = { taskId: task && task.id ? task.id : '', status: '', offset: 0, limit: PAGE_SIZE, total: 0 };
  const taskSelect = el(
    'select',
    { id: 'schedule-log-task-filter', class: 'select' },
    el('option', { value: '', text: '全部任务' }),
    ...state.scheduled.items.map((item) =>
      el('option', { value: item.id, text: item.name || item.id, selected: item.id === local.taskId }),
    ),
  );
  const statusSelect = el(
    'select',
    { id: 'schedule-log-status-filter', class: 'select' },
    ...[
      ['', '全部状态'],
      ['success', '成功'],
      ['failed', '失败'],
      ['skipped', '跳过'],
    ].map(([value, label]) => el('option', { value, text: label })),
  );
  const tbody = el('tbody', { id: 'schedule-log-table-body' });
  const pageInfo = el('span', { id: 'schedule-log-page-info', class: 'pagination-info', text: '第 1 / 1 页' });
  const prevButton = el('button', { id: 'schedule-log-prev', class: 'btn btn-secondary btn-sm', type: 'button', text: '上一页' });
  const nextButton = el('button', { id: 'schedule-log-next', class: 'btn btn-secondary btn-sm', type: 'button', text: '下一页' });
  const body = el(
    'div',
    { class: 'schedule-logs' },
    el('div', { class: 'toolbar toolbar-slim' }, taskSelect, statusSelect, el('span', { class: 'form-hint', text: '按时间倒序展示执行记录。' })),
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data-table data-table-logs' },
        el('thead', {}, el('tr', {},
          ...['时间', '任务', '状态', 'HTTP', '耗时', '收件人', '错误', '响应预览', '通知预览'].map((label) =>
            el('th', { scope: 'col', text: label }),
          ),
        )),
        tbody,
      ),
    ),
    el('div', { class: 'pagination' }, prevButton, pageInfo, nextButton),
  );

  async function load() {
    clearNode(tbody);
    tbody.append(el('tr', {}, el('td', { class: 'empty-cell', colspan: '9' }, el('span', { class: 'empty-text', text: '加载中…' }))));
    try {
      const params = new URLSearchParams();
      params.set('limit', String(local.limit));
      params.set('offset', String(local.offset));
      if (local.taskId) params.set('taskId', local.taskId);
      if (local.status) params.set('status', local.status);
      const data = await apiFetch(`/api/admin/scheduled-task-logs?${params.toString()}`);
      local.total = toCount(data && data.total);
      const items = data && Array.isArray(data.items) ? data.items : [];
      clearNode(tbody);
      if (items.length === 0) {
        tbody.append(el('tr', {}, el('td', { class: 'empty-cell', colspan: '9' }, el('span', { class: 'empty-text', text: '暂无运行日志' }))));
      } else {
        for (const log of items) {
          const statusMeta = SCHEDULE_STATUS_META[log.status] || { label: log.status || '—', className: 'badge-muted' };
          tbody.append(
            el('tr', {},
              el('td', { class: 'cell-nowrap' }, el('div', { text: formatDateTime(log.createdAt) }), el('div', { class: 'cell-muted', text: formatRelative(log.createdAt) })),
              el('td', { class: 'cell-mono', text: log.taskName || log.taskId || '—' }),
              el('td', {}, el('span', { class: `badge ${statusMeta.className}`, text: statusMeta.label })),
              el('td', { class: 'cell-mono', text: log.httpStatus === null || log.httpStatus === undefined ? '—' : String(log.httpStatus) }),
              el('td', { class: 'cell-mono cell-nowrap', text: log.latencyMs === null || log.latencyMs === undefined ? '—' : `${log.latencyMs} ms` }),
              el('td', { class: 'cell-mono', text: formatNumber(Number(log.recipientsCount) || 0) }),
              el('td', { class: 'cell-error', text: log.error || '—' }),
              el('td', { class: 'cell-muted log-preview', title: log.responsePreview || '', text: log.responsePreview || '—' }),
              el('td', { class: 'cell-muted log-preview', title: log.replyPreview || '', text: log.replyPreview || '—' }),
            ),
          );
        }
      }
      updatePagination();
    } catch (error) {
      clearNode(tbody);
      tbody.append(el('tr', {}, el('td', { class: 'empty-cell', colspan: '9' }, el('span', { class: 'inline-error', text: error && error.message ? error.message : '加载日志失败' }))));
      if (error && error.status !== 401) toastError(error, '加载定时任务日志失败');
    }
  }

  function updatePagination() {
    const totalPages = Math.max(1, Math.ceil(local.total / local.limit));
    const currentPage = Math.min(totalPages, Math.floor(local.offset / local.limit) + 1);
    pageInfo.textContent = `第 ${currentPage} / ${totalPages} 页 · 共 ${formatNumber(local.total)} 条`;
    prevButton.disabled = currentPage <= 1;
    nextButton.disabled = currentPage >= totalPages;
  }

  taskSelect.addEventListener('change', () => {
    local.taskId = taskSelect.value;
    local.offset = 0;
    void load();
  });
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

  openTrackedModal({
    title: `定时任务运行日志${task && task.name ? `：${task.name}` : ''}`,
    size: 'wide',
    content: [body],
    actions: [{ label: '关闭', class: 'btn btn-secondary' }],
  });
  void load();
}

function openGroupEditor(group = null) {
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
      { class: 'form-field' },
      el('label', { class: 'form-label', for: 'group-name-input', text: '分组名称（必填，1-40 字符）' }),
      nameInput,
    ),
    el(
      'div',
      { class: 'form-field' },
      el('label', { class: 'form-label', for: 'group-desc-input', text: '描述（可选，≤200 字符）' }),
      descInput,
    ),
    el('div', { class: 'form-field' }, el('span', { class: 'form-label', text: '颜色（可选）' }), palette),
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

async function openUserGroupsModal(user) {
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

  let groups = state.groups;
  try {
    const data = await apiFetch('/api/admin/groups');
    groups = data && Array.isArray(data.items) ? data.items : [];
    state.groups = groups;
    renderGroups();
    updateGroupFilterOptions();
  } catch {
    groups = state.groups;
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

/* ------------------------------------------------------------------ */
/* 用户列表                                                            */
/* ------------------------------------------------------------------ */

function buildUserGroupMapFromItems(items) {
  const map = new Map();
  for (const user of items) {
    if (user && typeof user.id === 'string' && Array.isArray(user.groups)) map.set(user.id, user.groups);
  }
  state.userGroupMap = map;
}

async function loadUsers() {
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
  const button = el('button', {
    class: `switch${enabled ? ' is-on' : ''}`,
    type: 'button',
    role: 'switch',
    'aria-checked': enabled ? 'true' : 'false',
    'aria-label': `${user.displayName || user.id} 的消息保活`,
    dataset: { action: 'keepalive', userId: user.id, enabled: enabled ? '1' : '0' },
    title: enabled
      ? `保活已开启${user.keepaliveLastSentAt ? `，最近发送 ${formatDateTime(user.keepaliveLastSentAt)}` : ''}（点击关闭）`
      : '保活已关闭（点击开启）',
  });
  button.append(
    el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-thumb' })),
    el('span', { class: 'switch-label', text: enabled ? '保活中' : '关闭' }),
  );
  return button;
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
  return el('button', {
    class: `btn btn-secondary btn-xs${extraClass ? ` ${extraClass}` : ''}`,
    type: 'button',
    text: label,
    disabled: Boolean(disabled),
    dataset: { action, userId },
  });
}

function handleUserTableClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const userId = button.dataset.userId;
  const action = button.dataset.action;
  const user = state.users.items.find((item) => item.id === userId);
  if (!user) return;
  if (action === 'detail') openUserDetailModal(user);
  else if (action === 'message') openSendMessageModal({ kind: 'user', user });
  else if (action === 'groups') openUserGroupsModal(user);
  else if (action === 'keepalive') toggleUserKeepalive(user, button);
  else if (action === 'unbind') unbindUser(user);
  else if (action === 'reconnect') reconnectUser(user);
  else if (action === 'delete') deleteUser(user);
}

function openSendMessageModal(target) {
  const isGroup = Boolean(target && target.kind === 'group');
  const user = isGroup ? null : target && target.user ? target.user : null;
  const group = isGroup ? target.group : null;
  if (!isGroup && (!user || typeof user.id !== 'string')) return;
  if (isGroup && (!group || typeof group.id !== 'string')) return;
  const recipient = isGroup
    ? `分组「${group.name || group.id}」`
    : user.displayName
      ? `${user.displayName}（${user.id}）`
      : String(user.id);
  const sendPath = isGroup
    ? `/api/admin/groups/${encodeURIComponent(group.id)}/messages`
    : `/api/admin/users/${encodeURIComponent(user.id)}/messages`;
  const mediaLimits = state.mediaLimits && typeof state.mediaLimits === 'object' ? state.mediaLimits : null;
  const maxBytes = Number(mediaLimits && mediaLimits.maxBytes) > 0
    ? Number(mediaLimits.maxBytes)
    : FALLBACK_MEDIA_MAX_BYTES;
  const maxBytesKnown = Boolean(mediaLimits && Number(mediaLimits.maxBytes) > 0);

  const textarea = el('textarea', {
    id: 'message-text',
    class: 'textarea',
    rows: 3,
    maxlength: MAX_TEXT_LENGTH,
    placeholder: '输入消息文字（可选；选择附件后作为说明文字）',
  });
  const counter = el('span', { class: 'char-count', text: `0 / ${MAX_TEXT_LENGTH}` });
  textarea.addEventListener('input', () => {
    counter.textContent = `${textarea.value.length} / ${MAX_TEXT_LENGTH}`;
  });

  const fileInput = el('input', {
    id: 'media-file-input',
    class: 'visually-hidden-input',
    type: 'file',
    'aria-label': '选择要发送的图片、视频或文件',
  });
  const pickButton = el('button', {
    id: 'btn-pick-file',
    class: 'btn btn-secondary btn-sm',
    type: 'button',
  }, '📎 选择附件');
  const limitHint = el('span', {
    id: 'media-limit-hint',
    class: 'form-hint',
    text: `支持图片 / 视频 / 任意文件，单个不超过 ${formatFileSize(maxBytes)}${
      maxBytesKnown ? '' : '（以服务端实际配置为准）'
    }`,
  });
  const pickerRow = el('div', { class: 'media-picker' }, pickButton, fileInput, limitHint);

  const previewBox = el('div', { id: 'media-preview', class: 'media-preview', hidden: true });
  const clearButton = el('button', {
    id: 'btn-clear-media',
    class: 'btn btn-ghost btn-xs media-clear',
    type: 'button',
    text: '移除附件',
    hidden: true,
  });
  const progressBar = el('div', { id: 'upload-progress-bar', class: 'upload-progress-bar' });
  const progressLabel = el('span', {
    id: 'upload-progress-text',
    class: 'upload-progress-text',
    text: '等待上传…',
  });
  const progressBox = el(
    'div',
    { id: 'upload-progress', class: 'upload-progress', hidden: true },
    el('div', { class: 'upload-progress-track' }, progressBar),
    progressLabel,
  );

  let selectedFile = null;
  /** 图片预览 token：FileReader 异步完成时防止旧文件覆盖新预览。 */
  let previewToken = 0;
  /** 已上传成功的 mediaId 缓存（同一文件重试发送时无需重复上传）。 */
  let uploadedMediaId = null;
  let uploadedFileKey = null;

  function fileKey(file) {
    return `${file.name || ''}:${file.size}:${file.lastModified || 0}`;
  }

  function resetMediaSelection() {
    selectedFile = null;
    uploadedMediaId = null;
    uploadedFileKey = null;
    previewToken += 1;
    clearNode(previewBox);
    setHidden(previewBox, true);
    setHidden(clearButton, true);
    setHidden(progressBox, true);
    progressBox.classList.remove('is-error', 'is-done');
    progressBar.style.width = '0%';
    progressLabel.textContent = '等待上传…';
    fileInput.value = '';
    pickButton.textContent = '📎 选择附件';
  }

  function setUploadProgress(loaded, total, done = false) {
    setHidden(progressBox, false);
    progressBox.classList.remove('is-error');
    progressBox.classList.toggle('is-done', Boolean(done));
    const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : done ? 100 : 0;
    progressBar.style.width = `${percent}%`;
    progressLabel.textContent = done ? '附件已上传，正在发送消息…' : `正在上传附件… ${percent}%`;
  }

  function showUploadError(error) {
    setHidden(progressBox, false);
    progressBox.classList.add('is-error');
    progressBox.classList.remove('is-done');
    progressBar.style.width = '100%';
    if (error && error.status === 413) {
      progressLabel.textContent = `附件超过大小上限（${formatFileSize(maxBytes)}），未发送`;
    } else {
      progressLabel.textContent = `附件上传/发送失败：${error && error.message ? error.message : '未知错误'}`;
    }
  }

  function setPreview(file) {
    clearNode(previewBox);
    const mime = String(file.type || '');
    let thumb;
    if (mime.startsWith('image/')) {
      const img = el('img', { class: 'media-preview-img', alt: '附件图片预览' });
      thumb = el('div', { class: 'media-preview-thumb' }, img);
      // 用 data URL 预览：后端 CSP 为 img-src 'self' data:，无需额外放行 blob:
      const token = ++previewToken;
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        if (token !== previewToken) return;
        if (typeof reader.result === 'string' && reader.result.startsWith('data:image/')) {
          img.src = reader.result;
        }
      });
      reader.readAsDataURL(file);
    } else if (mime.startsWith('video/')) {
      thumb = el('div', {
        class: 'media-preview-thumb media-preview-thumb-file',
        text: MEDIA_KIND_META.video.icon,
        'aria-hidden': 'true',
      });
    } else {
      thumb = el('div', {
        class: 'media-preview-thumb media-preview-thumb-file',
        text: MEDIA_KIND_META.file.icon,
        'aria-hidden': 'true',
      });
    }
    const kindLabel = mime.startsWith('image/') ? '图片' : mime.startsWith('video/') ? '视频' : '文件';
    const info = el(
      'div',
      { class: 'media-preview-info' },
      el('div', { class: 'media-file-name', text: file.name || '未命名文件' }),
      el('div', { class: 'media-file-size', text: `${kindLabel} · ${formatFileSize(file.size)}` }),
    );
    previewBox.append(thumb, info, clearButton);
    setHidden(previewBox, false);
    setHidden(clearButton, false);
    pickButton.textContent = '📎 重新选择';
  }

  function handleFileSelected(file) {
    if (!file) {
      resetMediaSelection();
      return;
    }
    if (file.size > maxBytes) {
      toast(`附件不能超过 ${formatFileSize(maxBytes)}（当前 ${formatFileSize(file.size)}）`, 'warning', 5200);
      resetMediaSelection();
      return;
    }
    if (file.size === 0) {
      toast('不能选择空文件', 'warning');
      resetMediaSelection();
      return;
    }
    selectedFile = file;
    if (uploadedFileKey !== fileKey(file)) uploadedMediaId = null;
    setPreview(file);
    setHidden(progressBox, true);
    progressBox.classList.remove('is-error', 'is-done');
  }

  pickButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    handleFileSelected(fileInput.files && fileInput.files[0] ? fileInput.files[0] : null);
  });
  clearButton.addEventListener('click', () => resetMediaSelection());

  const content = [el('p', { class: 'modal-message', text: `收件人：${recipient}` })];
  if (isGroup) {
    content.push(
      el('p', {
        class: 'alert alert-info',
        text: `将发送给分组内所有可推送用户（活跃且未冷却），当前活跃用户 ${formatNumber(group.activeUserCount)} 位；没有可发送用户时不会入队。`,
      }),
    );
  } else if (!user.hasContextToken) {
    content.push(
      el('p', {
        class: 'alert alert-warning',
        text: '该用户尚无入站消息（无 context_token），首条消息可能发送失败。',
      }),
    );
  }
  content.push(
    el(
      'div',
      { class: 'form-field' },
      el('label', { class: 'form-label', for: 'message-text', text: '消息文字（可选）' }),
      textarea,
      el(
        'div',
        { class: 'form-row-between' },
        el('span', { class: 'form-hint', text: '有附件时，文字会作为图片/文件的说明（caption）先发送。' }),
        counter,
      ),
    ),
    el(
      'div',
      { class: 'form-field' },
      el('span', { class: 'form-label', text: '附件（可选）' }),
      pickerRow,
      previewBox,
      progressBox,
    ),
  );

  openTrackedModal({
    title: '发送消息',
    content,
    onClose: () => {
      // 使仍在读取中的 FileReader 回调失效；图片预览使用的是 data URL，无需释放
      previewToken += 1;
    },
    actions: [
      { label: '取消', class: 'btn btn-secondary' },
      {
        label: '发送',
        class: 'btn btn-primary',
        closeOnClick: false,
        onClick: async (modal) => {
          const text = textarea.value.trim();
          if (!text && !selectedFile) {
            toast('请输入消息文字或选择附件', 'warning');
            textarea.focus();
            return;
          }
          if (text.length > MAX_TEXT_LENGTH) {
            toast(`消息不能超过 ${MAX_TEXT_LENGTH} 个字符`, 'warning');
            return;
          }
          if (selectedFile && selectedFile.size > maxBytes) {
            toast(`附件不能超过 ${formatFileSize(maxBytes)}`, 'warning');
            return;
          }
          modal.setBusy(true);
          try {
            let mediaId = null;
            if (selectedFile) {
              const key = fileKey(selectedFile);
              if (uploadedMediaId && uploadedFileKey === key) {
                mediaId = uploadedMediaId;
              } else {
                setUploadProgress(0, selectedFile.size);
                const uploaded = await uploadWithProgress('/api/admin/media', selectedFile, {
                  headers: {
                    'Content-Type': selectedFile.type || 'application/octet-stream',
                    'X-File-Name': encodeURIComponent(selectedFile.name || 'file'),
                  },
                  onProgress: (loaded, total) => setUploadProgress(loaded, total),
                });
                const media = uploaded && uploaded.media && typeof uploaded.media === 'object' ? uploaded.media : null;
                if (!media || typeof media.id !== 'string' || !/^att_[A-Za-z0-9_-]+$/.test(media.id)) {
                  throw new Error('服务端未返回有效的 mediaId');
                }
                mediaId = media.id;
                uploadedMediaId = mediaId;
                uploadedFileKey = key;
                setUploadProgress(selectedFile.size, selectedFile.size, true);
              }
            }

            /** @type {{text?: string, mediaId?: string}} */
            const body = mediaId ? (text ? { text, mediaId } : { mediaId }) : { text };
            const result = await apiFetch(sendPath, { method: 'POST', body });
            if (isGroup) {
              const count = Number(result && result.count);
              toast(
                `已加入发送队列${mediaId ? '（含附件）' : ''}：${recipient}${
                  Number.isFinite(count) ? `（${count} 条）` : ''
                }`,
                'success',
              );
            } else {
              toast(
                mediaId ? `已加入发送队列（含附件）：${recipient}` : `已加入发送队列：${recipient}`,
                'success',
              );
            }
            modal.close('sent');
            void refreshAfterWrite({ overview: true, users: true, messages: true });
          } catch (error) {
            showUploadError(error);
            toastError(error, '发送消息失败');
          } finally {
            modal.setBusy(false);
          }
        },
      },
    ],
  });
}

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

/* ------------------------------------------------------------------ */
/* 用户详情（含最近入站/出站与附件）                                    */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* 广播                                                                */
/* ------------------------------------------------------------------ */

function updateBroadcastCount() {
  const length = els.broadcastText.value.length;
  els.broadcastCount.textContent = `${length} / ${MAX_TEXT_LENGTH}`;
  els.broadcastCount.classList.toggle('char-count-over', length > MAX_TEXT_LENGTH);
}

async function handleBroadcast(event) {
  event.preventDefault();
  const text = els.broadcastText.value.trim();
  if (!text) {
    toast('请输入广播内容', 'warning');
    els.broadcastText.focus();
    return;
  }
  if (text.length > MAX_TEXT_LENGTH) {
    toast(`广播内容不能超过 ${MAX_TEXT_LENGTH} 个字符`, 'warning');
    return;
  }
  setButtonLoading(els.broadcastButton, true, '发送中…');
  try {
    const data = await apiFetch('/api/admin/broadcast', { method: 'POST', body: { text } });
    const count = Number(data && data.count);
    const queuedLength = data && Array.isArray(data.queued) ? data.queued.length : 0;
    const total = Number.isFinite(count) && count >= 0 ? count : queuedLength;
    if (total > 0) toast(`广播已加入发送队列：${total} 条`, 'success');
    else toast('当前没有可推送的已绑定用户', 'warning');
    els.broadcastText.value = '';
    updateBroadcastCount();
    await refreshAfterWrite({ overview: true, messages: true, users: true });
  } catch (error) {
    toastError(error, '广播失败');
  } finally {
    setButtonLoading(els.broadcastButton, false);
  }
}

/* ------------------------------------------------------------------ */
/* 消息记录                                                            */
/* ------------------------------------------------------------------ */

function setMessageDirection(direction) {
  if (!['inbound', 'outbound'].includes(direction)) return;
  state.messages.direction = direction;
  state.messages.offset = 0;
  for (const button of $$('button[data-direction]', els.messagesTabs)) {
    const active = button.dataset.direction === direction;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  loadMessages().catch(loadErrorHandler('加载消息记录失败'));
}

async function loadMessages() {
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

/**
 * 只接受同源 /api/ 路径（接口返回的媒体 URL），避免把 javascript: 等协议塞进 href/src。
 */
function safeMediaPath(value) {
  return typeof value === 'string' && value.startsWith('/api/') ? value : null;
}

/** 附件对外字段兼容：接口可能给 url/downloadUrl，缺失时按 id 兜底拼接。 */
function attachmentPaths(attachment) {
  const id = typeof attachment.id === 'string' ? attachment.id : '';
  const fallback = id ? `/api/admin/media/${encodeURIComponent(id)}` : null;
  const url = safeMediaPath(attachment.url) || fallback;
  const downloadUrl =
    safeMediaPath(attachment.downloadUrl) ||
    (url ? `${url}${url.includes('?') ? '&' : '?'}download=1` : null);
  return { url, downloadUrl };
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
function buildAttachmentsNode(attachments) {
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

/** 消息来源小标签（keepalive/broadcast/group/admin/api/system）。 */
function buildSourceBadge(message) {
  const source = message && typeof message.source === 'string' ? message.source : '';
  if (!source) return null;
  const meta = MESSAGE_SOURCE_META[source];
  if (!meta) return el('span', { class: 'badge badge-muted badge-source', text: source });
  return el('span', { class: `badge ${meta.className} badge-source`, text: meta.label });
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

/* ------------------------------------------------------------------ */
/* 运行配置                                                            */
/* ------------------------------------------------------------------ */

async function loadConfig() {
  const data = await apiFetch('/api/admin/config');
  state.config = data;
  state.mediaLimits =
    data && data.media && typeof data.media === 'object' ? data.media : null;
  // 设置接口可用时，只读区块仅展示服务/版本信息；否则回退到只读配置列表
  if (state.settings.available) renderServiceInfo(data);
  else renderConfig(data);
}

/* ------------------------------------------------------------------ */
/* 运行配置：后台可改设置（docs/SETTINGS.md §3/§4）                      */
/* ------------------------------------------------------------------ */

function settingsValueKey(groupKey, fieldKey) {
  return `${groupKey}.${fieldKey}`;
}

function settingTypeOf(field) {
  const type = field && typeof field.type === 'string' ? field.type.toLowerCase() : '';
  if (type === 'boolean' || type === 'bool') return 'boolean';
  if (type === 'number') return 'number';
  if (type === 'array' || type === 'numberarray' || type === 'stringarray') return 'array';
  if (type === 'text') return 'text';
  if (type === 'enum' || type === 'select') return 'enum';
  if (type === 'url' || type === 'urlstring') return 'url';
  const value = field ? field.value : undefined;
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'array';
  return 'string';
}

function isMultilineSetting(field, value) {
  if (field && (field.type === 'text' || field.multiline === true)) return true;
  if (field && /(^|\.)text$/i.test(String(field.key || ''))) return true;
  return typeof value === 'string' && value.length > 160;
}

function normalizeSettingValue(value, type) {
  if (type === 'boolean') return value === true;
  if (type === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (type === 'array') {
    if (Array.isArray(value)) return value.map((item) => String(item));
    if (typeof value === 'string') return parseSettingArrayInput(value);
    return [];
  }
  return value === undefined || value === null ? '' : String(value);
}

function cloneSettingValue(value) {
  return Array.isArray(value) ? value.slice() : value;
}

function parseSettingArrayInput(text) {
  return String(text || '')
    .split(/[,\n，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
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

function settingsValuesEqual(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left || []) === JSON.stringify(right || []);
  }
  return left === right;
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

async function loadSettings() {
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
    els.settingsUnavailable.textContent = `加载运行配置失败：${error && error.message ? error.message : '未知错误'}；下方仅展示只读配置。`;
    renderConfig(state.config);
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
    const enabled = value === true;
    const button = el('button', {
      id,
      class: `settings-switch switch${enabled ? ' is-on' : ''}`,
      type: 'button',
      role: 'switch',
      'aria-checked': enabled ? 'true' : 'false',
      'aria-label': field.label || field.key,
      dataset: { settingKey: key },
    });
    button.append(
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-thumb' })),
      el('span', { class: 'switch-label', text: enabled ? '开启' : '关闭' }),
    );
    return button;
  }
  if (type === 'number') {
    const input = el('input', {
      id,
      class: 'input input-narrow settings-number',
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
      const minMax =
        field.min !== undefined && field.min !== null || field.max !== undefined && field.max !== null
          ? `范围：${field.min ?? '—'} ~ ${field.max ?? '—'}`
          : '';
      fieldsBox.append(
        el(
          'div',
          { class: 'settings-field', dataset: { settingField: key } },
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
    card.append(fieldsBox);
    els.settingsGroups.append(card);
  }
  syncAllSettingFieldStates();
  updateSettingsSaveBar();
}

function handleSettingsInput(event) {
  const control = event.target && event.target.closest ? event.target.closest('[data-setting-key]') : null;
  if (!control || !els.settingsGroups.contains(control)) return;
  if (control.getAttribute('role') === 'switch') return;
  applySettingControlValue(control);
}

function handleSettingsClick(event) {
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

async function saveSettings() {
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
async function restartContainer() {
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
  appendKv(
    els.configList,
    '管理员密码为默认值',
    data.adminPasswordIsDefault === true ? '是（请修改 ADMIN_PASSWORD）' : '否',
    { tone: data.adminPasswordIsDefault === true ? 'warning' : null },
  );
}

/* ------------------------------------------------------------------ */
/* 安全卡片：管理密码 / API Token（docs/SETTINGS.md §7.3/§7.4）          */
/* ------------------------------------------------------------------ */

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

async function toggleSecurityPushApi() {
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

async function changeAdminPassword() {
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

async function resetAdminPassword() {
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

async function rotateApiToken() {
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

async function resetApiToken() {
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

/** 一次性机密展示弹窗（新 Token / 新随机密码通用，明文仅显示一次）。 */
function showSecretRevealModal({ title, value, warning, hint, copyLabel = '复制', copyToast = '已复制到剪贴板' }) {
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

function showTokenRevealModal(token, preview) {
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

function renderConfig(config) {
  const data = config && typeof config === 'object' ? config : {};
  const rateLimit = data.rateLimit && typeof data.rateLimit === 'object' ? data.rateLimit : {};
  const binding = data.binding && typeof data.binding === 'object' ? data.binding : {};
  const media = data.media && typeof data.media === 'object' ? data.media : null;
  const keepalive = data.keepalive && typeof data.keepalive === 'object' ? data.keepalive : null;
  const appRules = data.appRules && typeof data.appRules === 'object' ? data.appRules : null;
  clearNode(els.configList);
  appendKv(els.configList, '服务版本', data.version);
  appendKv(
    els.configList,
    '推送 API',
    data.pushApiEnabled === true ? '已启用' : data.pushApiEnabled === false ? '已禁用' : null,
    { tone: data.pushApiEnabled === false ? 'warning' : 'success' },
  );
  appendKv(els.configList, 'API Key 预览', data.apiTokenPreview || '（推送 API 未启用）');
  appendKv(
    els.configList,
    '发送限流',
    rateLimit.max !== undefined && rateLimit.max !== null
      ? `${formatNumber(rateLimit.max)} 条 / ${formatDuration(rateLimit.windowMs)}`
      : null,
  );
  appendKv(
    els.configList,
    '绑定会话有效期',
    binding.ttlMs !== undefined && binding.ttlMs !== null ? formatDuration(binding.ttlMs) : null,
  );
  appendKv(
    els.configList,
    '二维码最大刷新次数',
    binding.maxRefreshes !== undefined && binding.maxRefreshes !== null
      ? String(binding.maxRefreshes)
      : null,
  );
  appendKv(
    els.configList,
    '最大并发绑定会话',
    binding.maxActiveSessions !== undefined && binding.maxActiveSessions !== null
      ? formatNumber(binding.maxActiveSessions)
      : null,
  );
  appendKv(
    els.configList,
    '管理员密码为默认值',
    data.adminPasswordIsDefault === true ? '是（请立即修改 ADMIN_PASSWORD）' : '否',
    { tone: data.adminPasswordIsDefault === true ? 'warning' : null },
  );
  if (media) {
    els.configList.append(el('h3', { class: 'config-subtitle', text: '多媒体' }));
    appendKv(
      els.configList,
      '媒体上传上限',
      Number.isFinite(Number(media.maxBytes)) ? formatFileSize(Number(media.maxBytes)) : null,
    );
    appendKv(
      els.configList,
      '入站媒体上限',
      Number.isFinite(Number(media.inboundMaxBytes)) ? formatFileSize(Number(media.inboundMaxBytes)) : null,
    );
    appendKv(els.configList, '允许的图片类型', summarizeMediaTypes(media.allowedImage, 'image/*'));
    appendKv(els.configList, '允许的视频类型', summarizeMediaTypes(media.allowedVideo, 'video/*'));
    appendKv(els.configList, '媒体目录', media.dir);
  } else {
    appendKv(els.configList, '媒体上传', '未启用（后端未返回 media 配置）', { tone: 'warning' });
  }
  if (keepalive) {
    els.configList.append(el('h3', { class: 'config-subtitle', text: '消息保活' }));
    appendKv(
      els.configList,
      '保活全局开关',
      keepalive.enabled === true ? '已启用' : '已禁用',
      { tone: keepalive.enabled === true ? 'success' : 'warning' },
    );
    appendKv(els.configList, '保活窗口（小时）', formatHours(keepalive.windowMs));
    appendKv(els.configList, '保活提前量（小时）', formatHours(keepalive.leadMs));
    appendKv(
      els.configList,
      '扫描间隔',
      Number.isFinite(Number(keepalive.tickMs)) ? formatDuration(Number(keepalive.tickMs)) : null,
    );
    appendKv(
      els.configList,
      '单次扫描上限',
      Number.isFinite(Number(keepalive.maxPerTick)) ? formatNumber(Number(keepalive.maxPerTick)) : null,
    );
    appendKv(els.configList, '保活文本', keepalive.text);
    els.configList.append(
      el('p', {
        class: 'config-note',
        text: '消息保活仅对开启保活的用户生效；每个 24h 会话窗口最多自动发送一次，用户回复后重新计时。窗口已过期或无入站记录的用户不会发送。',
      }),
    );
  } else {
    appendKv(els.configList, '消息保活', '未启用（后端未返回 keepalive 配置）', { tone: 'warning' });
  }
  if (appRules) {
    els.configList.append(el('h3', { class: 'config-subtitle', text: '接口应用' }));
    appendKv(
      els.configList,
      '规则引擎',
      appRules.enabled === true ? '已启用' : '已禁用',
      { tone: appRules.enabled === true ? 'success' : 'warning' },
    );
    appendKv(
      els.configList,
      '单次请求超时上限',
      Number.isFinite(Number(appRules.timeoutMs)) ? formatDuration(Number(appRules.timeoutMs)) : null,
    );
    appendKv(
      els.configList,
      '响应体大小上限',
      Number.isFinite(Number(appRules.maxResponseBytes)) ? formatFileSize(Number(appRules.maxResponseBytes)) : null,
    );
    appendKv(
      els.configList,
      '执行并发数',
      Number.isFinite(Number(appRules.workerConcurrency)) ? formatNumber(Number(appRules.workerConcurrency)) : null,
    );
    appendKv(
      els.configList,
      '内网主机白名单',
      Array.isArray(appRules.allowedHosts) && appRules.allowedHosts.length > 0
        ? `${appRules.allowedHosts.length} 个：${appRules.allowedHosts.slice(0, 3).join('、')}${appRules.allowedHosts.length > 3 ? '…' : ''}`
        : '空（仅允许公网地址）',
    );
    els.configList.append(
      el('p', {
        class: 'config-note',
        text: '外部接口默认拒绝访问内网/本机地址（SSRF 防护）；需要访问内网接口时把主机加入 APP_RULES_ALLOWED_HOSTS 白名单。',
      }),
    );
  }
  appendKv(els.configList, '数据目录', data.dataDir);
}

/** 毫秒 → 小时展示（保活窗口/提前量）。 */
function formatHours(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  const hours = value / 3600000;
  const digits = hours >= 10 ? 1 : 2;
  return `${Number(hours.toFixed(digits))} 小时`;
}

/** 媒体 MIME 白名单摘要（避免运行配置里出现超长列表）。 */
function summarizeMediaTypes(types, fallback) {
  if (!Array.isArray(types) || types.length === 0) return fallback || '—';
  const head = types.slice(0, 4).join('、');
  return types.length > 4 ? `${head} 等 ${types.length} 种` : head;
}

/* ------------------------------------------------------------------ */
/* 渲染小工具                                                          */
/* ------------------------------------------------------------------ */

function appendKv(container, label, value, options = {}) {
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

function emptyRow(colspan, text) {
  return el(
    'tr',
    {},
    el('td', { class: 'empty-cell', colspan: String(colspan) }, el('span', { class: 'empty-text', text })),
  );
}

function updatePagination(prevButton, nextButton, infoNode, total, offset) {
  const totalPages = Math.max(1, Math.ceil((Number(total) || 0) / PAGE_SIZE));
  const currentPage = Math.min(totalPages, Math.floor((Number(offset) || 0) / PAGE_SIZE) + 1);
  infoNode.textContent = `第 ${currentPage} / ${totalPages} 页 · 共 ${formatNumber(total)} 条`;
  prevButton.disabled = currentPage <= 1;
  nextButton.disabled = currentPage >= totalPages;
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

/* ------------------------------------------------------------------ */
/* 模态框追踪 + 内联错误                                                */
/* ------------------------------------------------------------------ */

function openTrackedModal(options = {}) {
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

function showInlineError(node, message) {
  if (!node) return;
  node.textContent = message || '';
  node.hidden = false;
}

function clearInlineError(node) {
  if (!node) return;
  node.textContent = '';
  node.hidden = true;
}

// 模块加载完成后再初始化：确保所有顶层 const/let（如抽屉状态）已完成初始化，避免 TDZ。
init();
