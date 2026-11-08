/**
 * ClawBridge 管理后台逻辑。
 *
 * - 未登录：展示登录表单（POST /api/admin/login）
 * - 已登录：概览 / 用户管理 / 广播 / 消息记录 / 运行配置，每 5s 自动刷新（页面隐藏时暂停）
 * - 所有写请求由 common.js 自动附加 X-Requested-With: ClawBridge-Admin
 */

import { debounce, initFocusHints, initSidebarDrawer } from './common.js';
import { PAGE_SIZE } from './admin/constants.js';
import {
  bootstrap,
  handleLogin,
  handleLogout,
  handleManualRefresh,
  handleRoute,
  loadErrorHandler,
  registerDataLoader,
  registerViewLoaders,
  setSidebarDrawer,
} from './admin/core.js';
import { els, state } from './admin/state.js';
import { setupTablist } from './admin/ui.js';
import { handleAppRuleTableClick, loadAppRules, openAppRuleEditor, renderAppRules, setRuleTab } from './admin/views/app-rules.js';
import { handleBroadcast, updateBroadcastCount } from './admin/views/broadcast.js';
import { handleGroupTableClick, loadGroups, openGroupEditor } from './admin/views/groups.js';
import { loadMessages, setMessageDirection } from './admin/views/messages.js';
import { loadOverview } from './admin/views/overview.js';
import { handleScheduleTableClick, openScheduleEditor } from './admin/views/schedules.js';
import {
  changeAdminPassword,
  handleSettingsClick,
  handleSettingsInput,
  loadConfig,
  loadSettings,
  resetAdminPassword,
  resetApiToken,
  restartContainer,
  rotateApiToken,
  saveSettings,
  toggleSecurityPushApi,
} from './admin/views/settings.js';
import { handleUserTableClick, loadUsers } from './admin/views/users.js';

function init() {
  if (!els.loginForm) return; // 非管理页（防御）
  initFocusHints();

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

  // 消息方向 Tab：点击 + 方向键/Home/End（roving tabindex，F-07）。
  setupTablist({
    tablist: els.messagesTabs,
    tabSelector: 'button[data-direction]',
    getValue: (tab) => tab.dataset.direction,
    onChange: setMessageDirection,
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

  // 响应式侧栏：后台/文档/首页共用同一套 DOM 与抽屉交互，由 CSS 决定桌面常驻或窄屏 off-canvas。
  setSidebarDrawer(initSidebarDrawer({
    toggleId: 'btn-sidebar-toggle',
    sidebarSelector: '#admin-sidebar',
    overlayId: 'sidebar-overlay',
    navId: 'admin-menu',
    bodyClass: 'sidebar-open',
    openLabel: '打开菜单',
    closeLabel: '关闭菜单',
  }));
  window.addEventListener('hashchange', () => {
    handleRoute().catch(loadErrorHandler('切换视图失败'));
  });

  // 接口应用页内 Tab：规则列表 / 定时通知（点击 + 方向键/Home/End，F-07）
  setupTablist({
    tablist: els.ruleTabs,
    tabSelector: 'button[data-rule-tab]',
    getValue: (tab) => tab.dataset.ruleTab,
    onChange: setRuleTab,
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

/* ------------------------------------------------------------------ */
/* 视图数据加载器注册：core 不 import views，入口负责注册视图加载函数。      */
/* 依赖方向：admin.js（entry）→ admin/views/** → { core, ui, state, lib, common } */
/* ------------------------------------------------------------------ */

registerViewLoaders('overview', [loadOverview]);
registerViewLoaders('users', [loadGroups, loadUsers]);
registerViewLoaders('groups', [loadGroups]);
registerViewLoaders('messages', [loadGroups, loadMessages]);
registerViewLoaders('broadcast', []);
registerViewLoaders('app-rules', [loadGroups, loadAppRules]);
registerViewLoaders('config', [loadConfig, loadSettings]);
registerDataLoader('groups', loadGroups);
registerDataLoader('appRules', loadAppRules);
registerDataLoader('overview', loadOverview);
registerDataLoader('users', loadUsers);
registerDataLoader('messages', loadMessages);
registerDataLoader('config', loadConfig);

init();
