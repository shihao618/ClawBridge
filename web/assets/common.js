/**
 * ClawBridge 前端公共模块（原生 ES Module，零外部依赖）。
 *
 * 提供：
 * - apiFetch：统一 fetch 封装（JSON、错误规范化、401 跳登录、超时、自动 CSRF 头）
 * - DOM 构建工具（el / clearNode / setHidden 等，全部走 textContent，避免 XSS）
 * - 时间/数量格式化
 * - toast 轻提示
 * - 模态框与确认对话框
 * - 轮询工具（页面隐藏时暂停，可见时立即补一次）
 */

/* ------------------------------------------------------------------ */
/* 1. 统一 API 请求                                                     */
/* ------------------------------------------------------------------ */

const apiDefaults = {
  /** 写请求是否自动附加 X-Requested-With: ClawBridge-Admin（管理后台开启） */
  csrf: false,
  /** 收到 401 时的回调（跳转登录视图） */
  onUnauthorized: null,
};

/**
 * 配置 API 默认行为。管理后台启动时调用：
 * configureApi({ csrf: true, onUnauthorized: showLogin })
 */
export function configureApi(options = {}) {
  if (typeof options.csrf === 'boolean') apiDefaults.csrf = options.csrf;
  if (typeof options.onUnauthorized === 'function' || options.onUnauthorized === null) {
    apiDefaults.onUnauthorized = options.onUnauthorized;
  }
}

/** 统一的 API 错误对象（HTTP 错误、网络错误、超时都归一到这里）。 */
export class ApiError extends Error {
  constructor(status, code, message, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }

  get isNetworkError() {
    return this.code === 'NETWORK_ERROR' || this.code === 'TIMEOUT';
  }
}

const HTTP_FALLBACK_MESSAGES = {
  400: '请求参数有误',
  401: '登录已过期，请重新登录',
  403: '没有权限执行该操作',
  404: '请求的资源不存在',
  409: '当前状态不允许该操作',
  429: '操作过于频繁，请稍后再试',
  500: '服务器内部错误',
  503: '服务暂时不可用，请稍后重试',
};

/** 从 {error:{code,message}} 响应体提取错误码与文案。 */
function extractError(data, status) {
  const error = data && typeof data === 'object' ? data.error : null;
  const code = error && typeof error.code === 'string' ? error.code : `HTTP_${status}`;
  const rawMessage = error && typeof error.message === 'string' ? error.message.trim() : '';
  return {
    code,
    message: rawMessage || HTTP_FALLBACK_MESSAGES[status] || `请求失败（HTTP ${status}）`,
  };
}

/**
 * 统一请求封装。
 *
 * @param {string} path 同源路径，如 '/api/admin/overview'
 * @param {object} [options]
 * @param {string} [options.method] 默认 GET
 * @param {object} [options.body] 自动 JSON.stringify 并设置 Content-Type
 * @param {object} [options.headers] 额外请求头
 * @param {AbortSignal} [options.signal] 外部取消信号
 * @param {number} [options.timeoutMs] 超时时间，默认 30s
 * @param {boolean} [options.skipAuthRedirect] 401 时不触发全局跳登录（登录接口用）
 * @returns {Promise<any>} 解析后的 JSON（204 返回 null）
 */
export async function apiFetch(path, options = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    signal,
    timeoutMs = 30000,
    skipAuthRedirect = false,
  } = options;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let abortListener = null;
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      abortListener = () => controller.abort();
      signal.addEventListener('abort', abortListener, { once: true });
    }
  }

  const init = {
    method,
    headers: { Accept: 'application/json', ...headers },
    credentials: 'same-origin',
    signal: controller.signal,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  if (apiDefaults.csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    init.headers['X-Requested-With'] = 'ClawBridge-Admin';
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      if (timedOut) throw new ApiError(0, 'TIMEOUT', '请求超时，请稍后重试');
      throw new ApiError(0, 'ABORTED', '请求已取消');
    }
    throw new ApiError(0, 'NETWORK_ERROR', '网络连接失败，请检查网络后重试');
  } finally {
    clearTimeout(timer);
    if (abortListener && signal) signal.removeEventListener('abort', abortListener);
  }

  let data = null;
  try {
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
  } catch {
    data = null;
  }

  if (!response.ok) {
    const { code, message } = extractError(data, response.status);
    const apiError = new ApiError(response.status, code, message, data);
    if (response.status === 401 && !skipAuthRedirect && typeof apiDefaults.onUnauthorized === 'function') {
      try {
        apiDefaults.onUnauthorized(apiError);
      } catch {
        /* 回调异常不影响错误抛出 */
      }
    }
    throw apiError;
  }

  return data;
}

/**
 * 上传原始二进制文件（非 multipart），支持上传进度回调。
 * 与服务端约定：body 为文件原始字节，Content-Type 为文件 MIME，
 * 文件名通过 X-File-Name（encodeURIComponent）传递。
 *
 * 401 时与 apiFetch 一样触发全局 onUnauthorized；错误统一抛 ApiError。
 *
 * @param {string} path 同源接口路径
 * @param {File|Blob} file 文件对象
 * @param {object} [options]
 * @param {Record<string,string>} [options.headers] 额外请求头
 * @param {(loaded:number,total:number)=>void} [options.onProgress] 上传进度（字节）
 * @param {number} [options.timeoutMs] 超时，默认 120s
 * @returns {Promise<any>} 解析后的 JSON
 */
export function uploadWithProgress(path, file, options = {}) {
  const { headers = {}, onProgress = null, timeoutMs = 120000 } = options;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    xhr.withCredentials = true;
    xhr.timeout = Math.max(1000, Number(timeoutMs) || 120000);
    try {
      xhr.setRequestHeader('Accept', 'application/json');
    } catch {
      /* 某些环境不允许设置，忽略 */
    }
    if (apiDefaults.csrf) xhr.setRequestHeader('X-Requested-With', 'ClawBridge-Admin');
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null || value === '') continue;
      try {
        xhr.setRequestHeader(key, String(value));
      } catch {
        /* 非法 header 名忽略 */
      }
    }

    if (typeof onProgress === 'function') {
      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable) return;
        try {
          onProgress(event.loaded, event.total);
        } catch {
          /* 忽略回调异常 */
        }
      });
    }

    xhr.addEventListener('load', () => {
      let data = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      const { code, message } = extractError(data, xhr.status);
      const error = new ApiError(xhr.status, code, message, data);
      if (xhr.status === 401 && typeof apiDefaults.onUnauthorized === 'function') {
        try {
          apiDefaults.onUnauthorized(error);
        } catch {
          /* ignore */
        }
      }
      reject(error);
    });
    xhr.addEventListener('error', () => {
      reject(new ApiError(0, 'NETWORK_ERROR', '网络连接失败，上传未完成'));
    });
    xhr.addEventListener('abort', () => {
      reject(new ApiError(0, 'ABORTED', '上传已取消'));
    });
    xhr.addEventListener('timeout', () => {
      reject(new ApiError(0, 'TIMEOUT', '上传超时，请重试'));
    });

    try {
      xhr.send(file);
    } catch {
      reject(new ApiError(0, 'NETWORK_ERROR', '无法发送上传请求'));
    }
  });
}

/* ------------------------------------------------------------------ */
/* 2. DOM 构建工具（安全：文本一律走 textContent）                       */
/* ------------------------------------------------------------------ */

export function $(selector, root = document) {
  return root ? root.querySelector(selector) : null;
}

export function $$(selector, root = document) {
  return root ? Array.from(root.querySelectorAll(selector)) : [];
}

/**
 * 创建元素。
 *
 * el('div', { class: 'card', text: '文本' }, childNode, '字符串')
 *
 * - text：设置 textContent（永远安全）
 * - class / dataset / style / on：分别处理
 * - 其它键：优先作为 DOM 属性，失败则 setAttribute
 * 注意：不提供 html 参数，禁止插入未转义的 HTML。
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  if (props && typeof props === 'object') {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === 'text') {
        node.textContent = String(value);
        continue;
      }
      if (key === 'class') {
        node.className = String(value);
        continue;
      }
      if (key === 'dataset') {
        Object.assign(node.dataset, value);
        continue;
      }
      if (key === 'style' && value && typeof value === 'object') {
        Object.assign(node.style, value);
        continue;
      }
      if (key === 'on' && value && typeof value === 'object') {
        for (const [eventType, handler] of Object.entries(value)) {
          if (typeof handler === 'function') node.addEventListener(eventType, handler);
        }
        continue;
      }
      try {
        if (key in node && !key.startsWith('data-') && !key.startsWith('aria-')) {
          node[key] = value;
        } else {
          node.setAttribute(key, String(value));
        }
      } catch {
        node.setAttribute(key, String(value));
      }
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 清空节点子元素。 */
export function clearNode(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 设置可见性（true = 隐藏）。 */
export function setHidden(node, hidden) {
  if (node) node.hidden = Boolean(hidden);
}

/** 设置文本（null/undefined 显示占位符）。 */
export function setText(node, value, fallback = '—') {
  if (!node) return;
  node.textContent = value === undefined || value === null || value === '' ? fallback : String(value);
}

/**
 * HTML 转义工具。前端禁止用 innerHTML 拼接动态数据；
 * 该函数仅为极端场景（必须生成 HTML 字符串时）兜底使用。
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * 校验服务端二维码 data URI：只接受 data:image/svg+xml;base64, 开头且内容为合法 base64。
 * 返回安全值或 null。
 */
export function safeSvgDataUri(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('data:image/svg+xml;base64,')) return null;
  const payload = trimmed.slice('data:image/svg+xml;base64,'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  return trimmed;
}

/* ------------------------------------------------------------------ */
/* 3. 时间 / 数量格式化                                                 */
/* ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');

function toValidDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Unix 毫秒 → "2026-10-28 21:33:40" */
export function formatDateTime(ms) {
  const date = toValidDate(ms);
  if (!date) return '—';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Unix 毫秒 → "2026-10-28" */
export function formatDate(ms) {
  const date = toValidDate(ms);
  if (!date) return '—';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Unix 毫秒 → 相对时间："刚刚" / "3 分钟前" / "2 小时前" / 具体日期 */
export function formatRelative(ms) {
  const date = toValidDate(ms);
  if (!date) return '—';
  const diff = Date.now() - date.getTime();
  if (diff < 0) return formatDateTime(ms);
  if (diff < 45 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return formatDate(ms);
}

/** 毫秒时长 → "1 天 2 小时" / "3 分 20 秒" / "5 分钟" / "45 秒" */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} 天` : `${days} 天 ${restHours} 小时`;
}

/** 毫秒倒计时 → "04:32"（只用于二维码有效期展示） */
export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${pad2(minutes)}:${pad2(totalSeconds % 60)}`;
}

/** 数字格式化（null/NaN → "—"） */
export function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return String(Math.trunc(value));
}

/** 文件大小格式化：1024 → "1 KB"；26214400 → "25 MB" */
export function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  const rounded = Number(size.toFixed(digits));
  return `${rounded} ${units[unitIndex]}`;
}

/* ------------------------------------------------------------------ */
/* 4. toast 轻提示                                                      */
/* ------------------------------------------------------------------ */

const TOAST_TYPES = new Set(['success', 'error', 'warning', 'info']);
let toastRoot = null;

function ensureToastRoot() {
  if (!toastRoot || !toastRoot.isConnected) {
    toastRoot = document.getElementById('toast-root');
  }
  if (!toastRoot) {
    toastRoot = el('div', { class: 'toast-root', id: 'toast-root', 'aria-live': 'polite' });
    document.body.append(toastRoot);
  }
  return toastRoot;
}

/**
 * 展示一条轻提示。
 * @param {string} message 文案
 * @param {'success'|'error'|'warning'|'info'} [type]
 * @param {number} [durationMs]
 * @returns {() => void} 手动关闭函数
 */
export function toast(message, type = 'info', durationMs = 4200) {
  const root = ensureToastRoot();
  const toastType = TOAST_TYPES.has(type) ? type : 'info';
  const node = el(
    'div',
    {
      class: `toast toast-${toastType}`,
      role: toastType === 'error' ? 'alert' : 'status',
    },
    el('span', { class: 'toast-dot', 'aria-hidden': 'true' }),
    el('span', { class: 'toast-text', text: message === undefined || message === null ? '' : String(message) }),
  );

  let removed = false;
  const dismiss = () => {
    if (removed) return;
    removed = true;
    node.classList.remove('toast-show');
    setTimeout(() => node.remove(), 220);
  };

  node.addEventListener('click', dismiss);
  root.append(node);
  requestAnimationFrame(() => node.classList.add('toast-show'));
  const timer = setTimeout(dismiss, Math.max(1200, Number(durationMs) || 4200));
  node.addEventListener('click', () => clearTimeout(timer), { once: true });
  return dismiss;
}

/** 展示错误提示：接受 Error / ApiError / 字符串。 */
export function toastError(error, fallback = '操作失败，请稍后重试') {
  let message = fallback;
  if (error instanceof Error && error.message) message = error.message;
  else if (typeof error === 'string' && error.trim()) message = error.trim();
  return toast(message, 'error', 5200);
}

/* ------------------------------------------------------------------ */
/* 5. 模态框 / 确认对话框                                               */
/* ------------------------------------------------------------------ */

let openModalCount = 0;

/**
 * 打开模态框。
 *
 * @param {object} options
 * @param {string} [options.title]
 * @param {Array<Node|string>} [options.content] 主体内容节点
 * @param {Array<{label:string,class?:string,onClick?:Function,disabled?:boolean,closeOnClick?:boolean}>} [options.actions]
 * @param {'wide'|'narrow'|''} [options.size]
 * @param {boolean} [options.dismissible] 是否允许 Esc / 点击遮罩关闭，默认 true
 * @param {boolean} [options.closeOnBackdrop] 是否允许点击遮罩关闭（可单独关闭，Esc/关闭按钮仍生效），默认 true
 * @param {(result:any)=>void} [options.onClose]
 * @returns {{root:HTMLElement, dialog:HTMLElement, body:HTMLElement, footer:HTMLElement, close:Function, setBusy:Function, setTitle:Function, busy:boolean}}
 */
export function openModal(options = {}) {
  const {
    title = '提示',
    content = [],
    actions = [],
    size = '',
    dismissible = true,
    closeOnBackdrop = true,
    onClose = null,
  } = options;

  const previousFocus = document.activeElement;
  const backdrop = el('div', { class: 'modal-backdrop' });
  const dialog = el('div', {
    class: `modal${size ? ` modal-${size}` : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title || '对话框',
    tabindex: '-1',
  });
  const titleNode = el('h3', { class: 'modal-title', text: title });
  const closeButton = el('button', {
    class: 'modal-close',
    type: 'button',
    'aria-label': '关闭',
    title: '关闭',
  }, '✕');
  const header = el('div', { class: 'modal-header' }, titleNode, closeButton);
  const body = el('div', { class: 'modal-body' }, ...content);
  const footer = el('div', { class: 'modal-footer' });
  dialog.append(header, body, footer);
  backdrop.append(dialog);

  let closed = false;
  let busy = false;
  const api = {
    root: backdrop,
    dialog,
    body,
    footer,
    busy: false,
    close,
    setBusy,
    setTitle(newTitle) {
      titleNode.textContent = newTitle === undefined || newTitle === null ? '' : String(newTitle);
      dialog.setAttribute('aria-label', titleNode.textContent || '对话框');
    },
  };

  function setBusy(value) {
    busy = Boolean(value);
    api.busy = busy;
    for (const button of $$('button', footer)) button.disabled = busy;
    closeButton.disabled = busy;
    dialog.classList.toggle('is-busy', busy);
  }

  function close(result) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown);
    backdrop.classList.remove('modal-visible');
    openModalCount = Math.max(0, openModalCount - 1);
    if (openModalCount === 0) document.body.classList.remove('modal-open');
    setTimeout(() => backdrop.remove(), 180);
    if (previousFocus && typeof previousFocus.focus === 'function' && previousFocus.isConnected) {
      previousFocus.focus();
    }
    if (typeof onClose === 'function') {
      try {
        onClose(result);
      } catch {
        /* 忽略关闭回调异常 */
      }
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && dismissible && !busy) {
      event.preventDefault();
      close('dismiss');
    }
  }

  closeButton.addEventListener('click', () => {
    if (!busy) close('dismiss');
  });
  if (dismissible) {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop && !busy && closeOnBackdrop) close('dismiss');
    });
  }

  for (const action of Array.isArray(actions) ? actions : []) {
    if (!action || typeof action.label !== 'string') continue;
    const button = el('button', {
      class: `btn ${action.class || 'btn-secondary'}`,
      type: 'button',
      text: action.label,
      disabled: Boolean(action.disabled),
    });
    button.addEventListener('click', async () => {
      if (busy) return;
      const closeAfter = action.closeOnClick !== false;
      try {
        const result = typeof action.onClick === 'function' ? await action.onClick(api) : undefined;
        if (closeAfter && result !== false) close(result);
      } catch (error) {
        toastError(error);
      }
    });
    footer.append(button);
  }

  document.body.append(backdrop);
  openModalCount += 1;
  document.body.classList.add('modal-open');
  document.addEventListener('keydown', onKeydown);
  requestAnimationFrame(() => backdrop.classList.add('modal-visible'));

  setTimeout(() => {
    const firstFocusable = dialog.querySelector(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not(.modal-close)',
    );
    if (firstFocusable && typeof firstFocusable.focus === 'function') firstFocusable.focus();
    else dialog.focus();
  }, 30);

  return api;
}

/**
 * 确认对话框，返回 Promise<boolean>。
 * confirmDialog({ title, message, confirmText, cancelText, danger })
 */
export function confirmDialog(options = {}) {
  const {
    title = '确认操作',
    message = '',
    confirmText = '确定',
    cancelText = '取消',
    danger = false,
  } = options;

  return new Promise((resolve) => {
    let decided = false;
    const decide = (value) => {
      if (decided) return;
      decided = true;
      resolve(value);
    };
    openModal({
      title,
      content: [el('p', { class: 'modal-message', text: message })],
      actions: [
        { label: cancelText, class: 'btn btn-secondary', closeOnClick: false, onClick: (modal) => { decide(false); modal.close(false); } },
        {
          label: confirmText,
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          closeOnClick: false,
          onClick: (modal) => { decide(true); modal.close(true); },
        },
      ],
      onClose: () => decide(false),
    });
  });
}

/* ------------------------------------------------------------------ */
/* 6. 按钮 loading 态                                                   */
/* ------------------------------------------------------------------ */

/**
 * 切换按钮 loading 态（禁用并替换文案），完成后恢复原样。
 */
export function setButtonLoading(button, loading, loadingText = '处理中…') {
  if (!button) return;
  if (loading) {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent || '';
    button.disabled = true;
    button.textContent = loadingText;
    button.classList.add('is-loading');
  } else {
    button.disabled = false;
    if (button.dataset.originalText !== undefined) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
    button.classList.remove('is-loading');
  }
}

/* ------------------------------------------------------------------ */
/* 7. 轮询 / 防抖                                                      */
/* ------------------------------------------------------------------ */

/**
 * 创建轮询器。页面隐藏（document.hidden）时暂停，重新可见时立即执行一次。
 *
 * @param {() => any|Promise<any>} task 每次执行的任务
 * @param {number} intervalMs 间隔毫秒
 * @param {object} [options]
 * @param {boolean} [options.immediate] start 时是否立即执行，默认 true
 * @param {boolean} [options.hiddenPause] 页面隐藏时暂停，默认 true
 * @param {(error:any)=>void} [options.onError] 任务抛错回调（默认吞掉）
 * @returns {{start:Function, stop:Function, runNow:Function, active:()=>boolean}}
 */
export function createPoller(task, intervalMs, options = {}) {
  const { immediate = true, hiddenPause = true, onError = null } = options;
  const period = Math.max(200, Number(intervalMs) || 5000);
  let timer = null;
  let stopped = true;
  let inFlight = false;
  let rerunRequested = false;
  let hiddenListener = null;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delay = period) {
    clearTimer();
    if (stopped) return;
    timer = setTimeout(() => {
      tick();
    }, delay);
  }

  async function tick() {
    if (stopped) return;
    clearTimer();
    if (hiddenPause && document.hidden) {
      schedule();
      return;
    }
    if (inFlight) {
      rerunRequested = true;
      return;
    }
    inFlight = true;
    try {
      await task();
    } catch (error) {
      if (typeof onError === 'function') {
        try {
          onError(error);
        } catch {
          /* 忽略回调异常 */
        }
      }
    } finally {
      inFlight = false;
      if (!stopped) {
        if (rerunRequested) {
          rerunRequested = false;
          schedule(0);
        } else {
          schedule();
        }
      }
    }
  }

  function onVisibilityChange() {
    if (stopped) return;
    if (!document.hidden) tick();
    else clearTimer();
  }

  function start(startOptions = {}) {
    if (!stopped) return;
    stopped = false;
    if (hiddenPause) {
      hiddenListener = onVisibilityChange;
      document.addEventListener('visibilitychange', hiddenListener);
    }
    const runNow = typeof startOptions.runNow === 'boolean' ? startOptions.runNow : immediate;
    if (runNow) tick();
    else schedule();
  }

  function stop() {
    stopped = true;
    clearTimer();
    if (hiddenListener) {
      document.removeEventListener('visibilitychange', hiddenListener);
      hiddenListener = null;
    }
  }

  function runNow() {
    if (!stopped) tick();
  }

  return {
    start,
    stop,
    runNow,
    active: () => !stopped,
  };
}

/** 简单防抖。 */
export function debounce(fn, wait = 250) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, Math.max(0, Number(wait) || 0));
  };
  wrapped.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}
