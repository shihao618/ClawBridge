/**
 * ClawBridge 管理后台核心层：启动、登录/登出、401、hash 路由、视图切换、
 * 自动刷新、写后刷新与共享侧栏抽屉。
 *
 * 依赖方向：core → { state, constants, ui, common, lib }；core 不 import 视图模块，
 * 视图数据加载函数由 admin.js 入口通过 registerViewLoaders/registerDataLoader 注册。
 */

import { $$, apiFetch, closeAllModals, configureApi, createPoller, formatDateTime, setButtonLoading, setHidden, toast, toastError } from '../common.js';
import { DEFAULT_VIEW, LIVE_VIEWS, MENU_VIEWS, POLL_INTERVAL_MS, VIEW_BY_ID, VIEW_STORAGE_KEY } from './constants.js';
import { els, openModals, state } from './state.js';
import { clearInlineError, showInlineError } from './ui.js';

let refreshPoller = null;

let loggingIn = false;

configureApi({ csrf: true, onUnauthorized: handleUnauthorized });

export async function bootstrap() {
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

export async function handleLogin(event) {
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

export async function handleLogout() {
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
  // 会话过期/登出时关闭全部弹窗（含 confirmDialog）：由 common.js 统一触发各自 close()，
  // 保留关闭动画与焦点恢复、让确认框 Promise 正常 resolve(false)，
  // 同时归零弹窗计数并释放 body.modal-open 滚动锁，避免登录后页面无法滚动。
  closeAllModals('unauthorized');
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
  clearInlineError(els.loginError);
  void loadSidebarVersion();
}

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
export async function handleRoute() {
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

/**
 * 按视图数据加载注册表懒加载（core 不 import views，由 admin.js 入口注册惰性工厂）。
 * 行为与拆分前一致：并行加载该视图依赖数据，silent 时不上报 toast，401 交给全局钩子。
 * 非默认视图的模块在首次调用对应工厂时才动态 import；成功缓存 Promise（并发不重复），
 * 失败清缓存以便下次切换视图/手动刷新/轮询时自动重试，非 silent 时 toast 提示。
 */
async function loadView(viewId, { silent = false } = {}) {
  const factories = viewLoaders.get(viewId) || [];
  const results = await Promise.allSettled(factories.map((factory) => runLazyLoader(factory)));
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

/** 响应式侧栏抽屉（实际交互由 common.js 的共享实现处理）。 */
let sidebarDrawer = null;

function closeDrawer() {
  sidebarDrawer?.close();
}

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

/** 写操作后按域刷新数据（惰性工厂由 admin.js 入口注册，顺序与拆分前一致）。 */
export async function refreshAfterWrite(parts = {}) {
  const tasks = [];
  for (const key of REFRESH_LOADER_KEYS) {
    if (!parts[key]) continue;
    const factory = dataLoaders.get(key);
    if (factory) tasks.push(runLazyLoader(factory));
  }
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed && failed.reason && failed.reason.status !== 401) {
    toastError(failed.reason, '刷新数据失败');
  }
  updateLastUpdated();
}

export async function handleManualRefresh() {
  setButtonLoading(els.refreshButton, true, '刷新中…');
  try {
    await loadView(state.view, { silent: false });
  } finally {
    setButtonLoading(els.refreshButton, false);
  }
}

export function loadErrorHandler(fallbackMessage) {
  return (error) => {
    if (error && error.status === 401) return;
    toastError(error, fallbackMessage);
  };
}

/**
 * 视图数据加载器注册表（core 不 import views，由 admin.js 入口注册惰性工厂）。
 * 每个注册项为工厂函数：() => Promise<loader>。首次调用工厂时才动态 import 视图模块，
 * 成功后缓存 Promise（并发切换不会重复加载），失败时删除缓存以便重试。
 */
const viewLoaders = new Map();
const dataLoaders = new Map();
const loaderCache = new Map();
const REFRESH_LOADER_KEYS = ['groups', 'appRules', 'overview', 'users', 'messages', 'config'];

/** 解析惰性加载器工厂：成功缓存 Promise<loader>，失败清缓存（允许重试）。 */
function resolveLazyLoader(factory) {
  if (typeof factory !== 'function') return Promise.reject(new Error('视图加载器工厂无效'));
  if (!loaderCache.has(factory)) {
    const promise = Promise.resolve()
      .then(() => factory())
      .then((loader) => {
        if (typeof loader !== 'function') throw new Error('视图加载器工厂未返回加载函数');
        return loader;
      })
      .catch((error) => {
        loaderCache.delete(factory);
        throw error;
      });
    loaderCache.set(factory, promise);
  }
  return loaderCache.get(factory);
}

/** 解析工厂并执行加载函数（视图首次加载/写后刷新共用）。 */
async function runLazyLoader(factory) {
  const loader = await resolveLazyLoader(factory);
  return loader();
}

/** 注册某个菜单视图的初始数据加载器（惰性工厂：() => Promise<loader>，可多个）。 */
export function registerViewLoaders(viewId, factories) {
  viewLoaders.set(viewId, Array.isArray(factories) ? factories.slice() : []);
}

/** 注册写操作后按域刷新使用的加载器（惰性工厂：() => Promise<loader>）。 */
export function registerDataLoader(key, factory) {
  dataLoaders.set(key, factory);
}

/** 由入口注入共享侧栏抽屉实例（common.js 的 initSidebarDrawer 返回值）。 */
export function setSidebarDrawer(drawer) {
  sidebarDrawer = drawer;
}
