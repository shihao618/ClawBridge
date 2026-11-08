/**
 * 后台壳层与各视图关键 DOM 缓存 + 当前打开的模态框集合。
 *
 * 由 ../state.js 原样 re-export；`els.xxx` / `openModals` 访问路径不变。
 */

import { $ } from '../../common.js';

export const els = {
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
  messagesPanel: $('#messages-panel'),
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
export const openModals = new Set();
