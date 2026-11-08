/**
 * ClawBridge 管理后台跨视图共享状态与壳层 DOM 缓存。
 *
 * - state：会话/路由/列表数据（各视图按域读写）
 * - els：后台壳层与各视图关键 DOM 缓存（模块加载时一次性查询）
 * - openModals：当前打开的模态框集合（打开时暂停自动刷新）
 */

import { $ } from '../common.js';
import { DEFAULT_VIEW } from './constants.js';

export const state = {
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
