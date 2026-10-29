/**
 * ClawBridge 公开绑定页逻辑。
 *
 * 流程：POST /api/bind/sessions → 展示服务端二维码 data URI →
 * 每 1s 轮询 GET /api/bind/sessions/{id}?token=… → 按 status 渲染。
 */
import {
  apiFetch,
  $,
  el,
  clearNode,
  setHidden,
  setButtonLoading,
  safeSvgDataUri,
  createPoller,
  formatDateTime,
  formatCountdown,
  toast,
  toastError,
} from './common.js';

const POLL_INTERVAL_MS = 1000;
const STORAGE_KEY = 'clawbridge:bind-session:v1';
const MAX_NAME_LENGTH = 40;

/** 结束后不可再轮询的状态。 */
const TERMINAL_STATUSES = new Set(['confirmed', 'already_bound', 'expired', 'timeout', 'error', 'cancelled']);
/** 需要展示「重新生成二维码」按钮的状态。 */
const REGENERATE_STATUSES = new Set(['expired', 'timeout', 'error', 'cancelled', 'unknown']);

const STATUS_META = {
  waiting: { label: '等待扫码', title: '请用微信扫描二维码', active: true },
  scanned: { label: '已扫码', title: '已扫码，请在手机上确认', active: true },
  need_verifycode: { label: '输入配对数字', title: '输入手机微信显示的数字', active: true },
  refreshing: { label: '正在刷新', title: '二维码已过期，正在刷新', active: true },
  verify_blocked: { label: '配对失败', title: '配对数字错误次数过多，正在刷新二维码', active: true },
  confirmed: { label: '绑定成功', title: '绑定成功', active: false },
  already_bound: { label: '已绑定过', title: '该微信已绑定过本服务', active: false },
  expired: { label: '二维码已过期', title: '二维码已过期，请重新生成', active: false },
  timeout: { label: '会话超时', title: '绑定会话已超时，请重新生成二维码', active: false },
  error: { label: '绑定失败', title: '绑定失败，请重新生成二维码重试', active: false },
  cancelled: { label: '已取消', title: '已取消绑定，可重新生成二维码', active: false },
  unknown: { label: '未知状态', title: '绑定状态未知，请重新生成二维码', active: false },
};

const els = {
  form: $('#bind-form'),
  nameInput: $('#display-name'),
  createButton: $('#btn-create'),
  createError: $('#create-error'),
  sessionBox: $('#bind-session'),
  qrBox: $('#qr-box'),
  qrImg: $('#qr-img'),
  statusBadge: $('#status-badge'),
  statusText: $('#status-text'),
  statusMessage: $('#status-message'),
  countdown: $('#qr-countdown'),
  verifyForm: $('#verify-form'),
  verifyInput: $('#verify-code'),
  verifyButton: $('#btn-verify'),
  verifyError: $('#verify-error'),
  boundInfo: $('#bound-info'),
  boundDetails: $('#bound-details'),
  boundNote: $('#bound-note'),
  regenerateButton: $('#btn-regenerate'),
  cancelButton: $('#btn-cancel'),
};

/** @type {{sessionId:string, token:string, displayName:string, qr:object|null, status:string}|null} */
let session = null;
let poller = null;
let countdownTimer = null;
let terminal = true;
let creating = false;
let submittingVerify = false;

init();

/* ------------------------------------------------------------------ */
/* 初始化 / 恢复会话                                                    */
/* ------------------------------------------------------------------ */

function init() {
  if (!els.form) return; // 非绑定页（防御）
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    createSession(els.nameInput.value.trim());
  });
  els.verifyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitVerifyCode();
  });
  els.regenerateButton.addEventListener('click', () => {
    regenerate();
  });
  els.cancelButton.addEventListener('click', () => {
    cancelSession();
  });
  els.qrImg.addEventListener('error', () => {
    toast('二维码图片渲染失败，请点击「重新生成二维码」', 'error');
  });
  restoreSession();
}

function restoreSession() {
  let stored = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    stored = null;
  }
  if (!stored || typeof stored.sessionId !== 'string' || typeof stored.token !== 'string') {
    showStartForm();
    return;
  }
  const restoredStatus = typeof stored.status === 'string' ? stored.status : 'waiting';
  if (TERMINAL_STATUSES.has(restoredStatus)) {
    clearStoredSession();
    showStartForm();
    return;
  }
  session = {
    sessionId: stored.sessionId,
    token: stored.token,
    displayName: typeof stored.displayName === 'string' ? stored.displayName : '',
    qr: stored.qr && typeof stored.qr === 'object' ? stored.qr : null,
    status: restoredStatus,
  };
  terminal = false;
  if (session.displayName) els.nameInput.value = session.displayName;
  showSessionView();
  renderQr(session.qr);
  applyStatus(session.status);
  startPolling(true);
}

/* ------------------------------------------------------------------ */
/* 创建 / 重新生成 / 取消                                               */
/* ------------------------------------------------------------------ */

async function createSession(displayName) {
  if (creating) return;
  creating = true;
  clearInlineError(els.createError);
  setButtonLoading(els.createButton, true, '正在生成二维码…');
  try {
    /** @type {{displayName?: string}} */
    const body = {};
    if (displayName) body.displayName = displayName.slice(0, MAX_NAME_LENGTH);
    const data = await apiFetch('/api/bind/sessions', { method: 'POST', body });
    if (!data || typeof data.sessionId !== 'string' || typeof data.token !== 'string') {
      throw new Error('服务端返回的绑定会话数据不完整，请重新生成二维码');
    }
    stopPolling();
    stopCountdown();
    terminal = false;
    session = {
      sessionId: data.sessionId,
      token: data.token,
      displayName: typeof data.displayName === 'string' ? data.displayName : displayName || '',
      qr: data.qr && typeof data.qr === 'object' ? data.qr : null,
      status: typeof data.status === 'string' && data.status ? data.status : 'waiting',
    };
    if (session.displayName) els.nameInput.value = session.displayName;
    showSessionView();
    renderQr(session.qr);
    applyStatus(session.status);
    persistSession();
    startPolling(true);
  } catch (error) {
    showInlineError(els.createError, describeCreateError(error));
    toastError(error, '生成二维码失败');
  } finally {
    creating = false;
    setButtonLoading(els.createButton, false);
  }
}

function describeCreateError(error) {
  if (!error) return '生成二维码失败，请稍后重试';
  if (error.status === 429) return '生成二维码过于频繁，请稍后再试（同一网络每小时有次数限制）。';
  if (error.status === 503) return '暂时无法连接微信服务器，请稍后重试。';
  if (error.code === 'NETWORK_ERROR') return '网络连接失败，请检查网络后重试。';
  if (error.code === 'TIMEOUT') return '请求超时，请稍后重试。';
  return error.message || '生成二维码失败，请稍后重试';
}

async function regenerate() {
  const displayName = (session && session.displayName) || els.nameInput.value.trim();
  if (session && session.token) cancelRemoteSession(session.sessionId, session.token);
  stopPolling();
  stopCountdown();
  clearStoredSession();
  session = null;
  terminal = true;
  showStartForm();
  if (displayName) els.nameInput.value = displayName;
  await createSession(displayName);
}

async function cancelSession() {
  if (!session) return;
  const snapshot = session;
  stopPolling();
  stopCountdown();
  terminal = true;
  clearStoredSession();
  els.cancelButton.disabled = true;
  try {
    await apiFetch(`/api/bind/sessions/${encodeURIComponent(snapshot.sessionId)}`, {
      method: 'DELETE',
      body: { token: snapshot.token },
    });
  } catch {
    /* 取消属于尽力而为，服务端会自行清理 */
  } finally {
    els.cancelButton.disabled = false;
  }
  session = null;
  applyStatus('cancelled', { message: '已取消本次绑定，可重新生成二维码。' });
  toast('已取消绑定', 'info');
}

/** 重新生成前尽力取消旧会话（失败无妨）。 */
function cancelRemoteSession(sessionId, token) {
  apiFetch(`/api/bind/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    body: { token },
  }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* 轮询                                                                */
/* ------------------------------------------------------------------ */

function startPolling(runNow = true) {
  stopPolling();
  if (!session) return;
  poller = createPoller(pollStatusOnce, POLL_INTERVAL_MS, {
    immediate: runNow,
    hiddenPause: true,
    onError: () => {},
  });
  poller.start({ runNow });
}

function stopPolling() {
  if (poller) {
    poller.stop();
    poller = null;
  }
}

async function pollStatusOnce() {
  if (!session || terminal) return;
  const current = session;
  let data;
  try {
    data = await apiFetch(
      `/api/bind/sessions/${encodeURIComponent(current.sessionId)}?token=${encodeURIComponent(current.token)}`,
      { timeoutMs: 15000, skipAuthRedirect: true },
    );
  } catch (error) {
    if (error && [401, 403, 404, 410].includes(error.status)) {
      handleSessionLost(error);
      return;
    }
    showStatusMessage('网络波动，正在重试…');
    return;
  }
  if (!data || typeof data !== 'object') return;
  // 会话可能在 await 期间被重置
  if (!session || session.sessionId !== current.sessionId) return;

  if (data.qr && typeof data.qr === 'object') session.qr = data.qr;
  renderQr(session.qr);

  const status = typeof data.status === 'string' && data.status ? data.status : 'unknown';
  session.status = status;
  const user = data.user && typeof data.user === 'object' ? data.user : null;
  applyStatus(status, { message: data.message, error: data.error }, user);

  if (TERMINAL_STATUSES.has(status)) {
    terminal = true;
    stopPolling();
    stopCountdown();
    clearStoredSession();
  } else {
    persistSession();
  }
}

function handleSessionLost(error) {
  const current = session;
  terminal = true;
  stopPolling();
  stopCountdown();
  clearStoredSession();
  session = null;
  const detail =
    error && error.status === 404
      ? '绑定会话不存在或已被清理，请重新生成二维码。'
      : '绑定会话已失效，请重新生成二维码。';
  applyStatus('expired', { message: detail });
  toast('绑定会话已失效，请重新生成二维码', 'warning');
  if (current) cancelRemoteSession(current.sessionId, current.token);
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function showStartForm() {
  setHidden(els.form, false);
  setHidden(els.sessionBox, true);
  clearInlineError(els.createError);
}

function showSessionView() {
  setHidden(els.form, true);
  setHidden(els.sessionBox, false);
  clearInlineError(els.createError);
}

function renderQr(qr) {
  const svg = qr && typeof qr === 'object' ? safeSvgDataUri(qr.svg) : null;
  if (!svg) {
    els.qrImg.removeAttribute('src');
    els.qrImg.classList.add('qr-img-empty');
    els.qrImg.alt = '二维码暂不可用';
    stopCountdown();
    showStatusMessage('二维码数据格式异常，请点击「重新生成二维码」。');
    return;
  }
  els.qrImg.classList.remove('qr-img-empty');
  els.qrImg.alt = '微信扫码绑定二维码';
  if (els.qrImg.getAttribute('src') !== svg) els.qrImg.src = svg;
  startCountdown(qr.expiresAt);
}

function applyStatus(status, data = {}, user = null) {
  const meta = STATUS_META[status] || STATUS_META.unknown;
  els.statusBadge.dataset.status = STATUS_META[status] ? status : 'unknown';
  els.statusBadge.textContent = meta.label;
  els.statusText.textContent = meta.title;

  // 服务端附带的说明 / 错误原因
  const message = typeof data.message === 'string' ? data.message.trim() : '';
  const reason = typeof data.error === 'string' ? data.error.trim() : '';
  const detail = reason || message;
  if (detail && detail !== meta.title) showStatusMessage(detail);
  else setHidden(els.statusMessage, true);

  // 配对数字表单
  const showVerify = status === 'need_verifycode';
  if (showVerify) {
    if (els.verifyForm.hidden) {
      clearInlineError(els.verifyError);
      els.verifyInput.value = '';
      setHidden(els.verifyForm, false);
      setTimeout(() => els.verifyInput.focus(), 50);
    }
  } else {
    setHidden(els.verifyForm, true);
    els.verifyInput.value = '';
    clearInlineError(els.verifyError);
  }

  // 绑定结果信息
  if (status === 'confirmed') {
    renderBoundUser(user, '之后将通过微信 ClawBot 接收消息。');
  } else if (status === 'already_bound') {
    renderBoundUser(
      user,
      user
        ? '该微信已绑定本服务，无需重复绑定；如需更换账号请联系管理员。'
        : '该微信已绑定过本服务。如需更换或解绑，请联系管理员。',
    );
  } else {
    setHidden(els.boundInfo, true);
  }

  // 操作按钮
  const isActive = Boolean(meta.active);
  setHidden(els.cancelButton, !isActive);
  setHidden(els.regenerateButton, !REGENERATE_STATUSES.has(status));

  // 二维码区域与倒计时：结束时隐藏/置灰，成功时不再展示已使用的二维码
  if (!isActive) {
    stopCountdown();
    setHidden(els.countdown, true);
    if (status === 'confirmed' || status === 'already_bound') {
      setHidden(els.qrBox, true);
    } else {
      setHidden(els.qrBox, false);
      els.qrBox.classList.add('is-dimmed');
    }
  } else {
    setHidden(els.qrBox, false);
    els.qrBox.classList.remove('is-dimmed');
    if (session && session.qr && Number.isFinite(session.qr.expiresAt)) startCountdown(session.qr.expiresAt);
  }
}

function renderBoundUser(user, note) {
  setHidden(els.boundInfo, false);
  if (els.boundNote) els.boundNote.textContent = note || '';
  clearNode(els.boundDetails);
  const rows = [];
  if (user && typeof user === 'object') {
    if (user.id) rows.push(['用户 ID', String(user.id)]);
    if (user.displayName) rows.push(['昵称', String(user.displayName)]);
    if (user.wechatUserId) rows.push(['微信用户 ID', String(user.wechatUserId)]);
    if (user.boundAt) rows.push(['绑定时间', formatDateTime(Number(user.boundAt))]);
  }
  if (rows.length === 0) {
    setHidden(els.boundDetails, true);
    return;
  }
  setHidden(els.boundDetails, false);
  for (const [label, value] of rows) {
    els.boundDetails.append(el('dt', { text: label }), el('dd', { text: value }));
  }
}

function showStatusMessage(message) {
  if (!els.statusMessage) return;
  els.statusMessage.textContent = message;
  setHidden(els.statusMessage, false);
}

/* ------------------------------------------------------------------ */
/* 配对数字                                                            */
/* ------------------------------------------------------------------ */

async function submitVerifyCode() {
  if (!session || submittingVerify) return;
  if (terminal) return;
  const code = els.verifyInput.value.trim();
  clearInlineError(els.verifyError);
  if (!/^\d{1,8}$/.test(code)) {
    showInlineError(els.verifyError, '请输入手机微信上显示的数字（仅数字）。');
    return;
  }
  submittingVerify = true;
  setButtonLoading(els.verifyButton, true, '提交中…');
  try {
    await apiFetch(`/api/bind/sessions/${encodeURIComponent(session.sessionId)}/verify-code`, {
      method: 'POST',
      body: { token: session.token, code },
    });
    // 保留输入内容，直到状态离开 need_verifycode（避免网络/竞态导致用户需要重新输入）
    toast('配对数字已提交，请稍候…', 'success');
    if (poller) poller.runNow();
  } catch (error) {
    if (error && error.status === 409) {
      showInlineError(els.verifyError, '当前状态无法提交配对数字，请等待二维码刷新后重试。');
    } else {
      showInlineError(els.verifyError, error && error.message ? error.message : '提交失败，请重试。');
    }
    toastError(error, '提交配对数字失败');
  } finally {
    submittingVerify = false;
    setButtonLoading(els.verifyButton, false);
  }
}

/* ------------------------------------------------------------------ */
/* 倒计时                                                              */
/* ------------------------------------------------------------------ */

function startCountdown(expiresAt) {
  stopCountdown();
  if (!Number.isFinite(expiresAt) || expiresAt <= 0 || terminal) {
    setHidden(els.countdown, true);
    return;
  }
  setHidden(els.countdown, false);
  const update = () => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      els.countdown.textContent = '二维码已过期，正在刷新…';
      return;
    }
    els.countdown.textContent = `二维码有效期剩余 ${formatCountdown(remaining)}`;
  };
  update();
  countdownTimer = setInterval(update, 1000);
}

function stopCountdown() {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

/* ------------------------------------------------------------------ */
/* 会话持久化 / 小工具                                                  */
/* ------------------------------------------------------------------ */

function persistSession() {
  if (!session || terminal) {
    clearStoredSession();
    return;
  }
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessionId: session.sessionId,
        token: session.token,
        displayName: session.displayName,
        qr: session.qr,
        status: session.status,
      }),
    );
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用 */
  }
}

function clearStoredSession() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
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
