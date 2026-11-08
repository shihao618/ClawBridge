/**
 * ClawBridge 管理后台逻辑（入口模块）。
 *
 * - 未登录：展示登录表单（POST /api/admin/login）
 * - 已登录：概览 / 用户管理 / 广播 / 消息记录 / 运行配置，每 5s 自动刷新（页面隐藏时暂停）
 * - 所有写请求由 common.js 自动附加 X-Requested-With: ClawBridge-Admin
 *
 * 性能：默认视图 overview 静态导入（首屏立即可用）；其余菜单视图注册为惰性工厂，
 * 首次切换到该视图时才动态 import 对应模块（零构建；CSP `script-src 'self'` 允许同源动态 import）。
 */

import { initFocusHints, initSidebarDrawer } from './common.js';
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
import { els } from './admin/state.js';
import { loadOverview } from './admin/views/overview.js';

/*
 * 惰性加载器工厂：() => Promise<加载函数>。
 * core 会缓存成功解析的 Promise（并发切换不会重复 import），失败时清缓存以便重试。
 */
const lazyOverview = () => Promise.resolve(loadOverview);
const lazyGroups = () => import('./admin/views/groups.js').then((module) => module.loadGroups);
const lazyUsers = () => import('./admin/views/users.js').then((module) => module.loadUsers);
const lazyMessages = () => import('./admin/views/messages.js').then((module) => module.loadMessages);
const lazyBroadcast = () => import('./admin/views/broadcast.js').then((module) => module.initBroadcastView);
const lazyAppRules = () => import('./admin/views/app-rules.js').then((module) => module.loadAppRules);
const lazyConfig = () => import('./admin/views/settings.js').then((module) => module.loadConfig);
const lazySettings = () => import('./admin/views/settings.js').then((module) => module.loadSettings);

function init() {
  if (!els.loginForm) return; // 非管理页（防御）
  initFocusHints();

  // 壳层与全局动作保持静态绑定；各视图内部事件在首次加载该视图模块时绑定（views/*.js init*）。
  els.loginForm.addEventListener('submit', handleLogin);
  els.logoutButton.addEventListener('click', handleLogout);
  els.refreshButton.addEventListener('click', handleManualRefresh);

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

  bootstrap();
}

/* ------------------------------------------------------------------ */
/* 视图数据加载器注册：core 不 import views，入口注册惰性工厂。          */
/* 依赖方向：admin.js（entry）→ 动态 import admin/views/** → { core, ui, state, lib, common } */
/* ------------------------------------------------------------------ */

registerViewLoaders('overview', [lazyOverview]);
registerViewLoaders('users', [lazyGroups, lazyUsers]);
registerViewLoaders('groups', [lazyGroups]);
registerViewLoaders('messages', [lazyGroups, lazyMessages]);
registerViewLoaders('broadcast', [lazyBroadcast]);
registerViewLoaders('app-rules', [lazyGroups, lazyAppRules]);
registerViewLoaders('config', [lazyConfig, lazySettings]);
registerDataLoader('groups', lazyGroups);
registerDataLoader('appRules', lazyAppRules);
registerDataLoader('overview', lazyOverview);
registerDataLoader('users', lazyUsers);
registerDataLoader('messages', lazyMessages);
registerDataLoader('config', lazyConfig);

init();
