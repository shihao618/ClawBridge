/**
 * 广播消息视图：广播表单计数与提交。
 */

import { MAX_TEXT_LENGTH } from '../constants.js';
import { refreshAfterWrite } from '../core.js';
import { els } from '../state.js';
import { apiFetch, setButtonLoading, toast, toastError } from '../../common.js';

export function updateBroadcastCount() {
  const length = els.broadcastText.value.length;
  els.broadcastCount.textContent = `${length} / ${MAX_TEXT_LENGTH}`;
  els.broadcastCount.classList.toggle('char-count-over', length > MAX_TEXT_LENGTH);
}

export async function handleBroadcast(event) {
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

/** 广播消息视图事件绑定（首次进入该视图时加载，幂等）。 */
let broadcastViewBound = false;
export function initBroadcastView() {
  if (broadcastViewBound) return;
  broadcastViewBound = true;
  els.broadcastForm.addEventListener('submit', handleBroadcast);
  els.broadcastText.addEventListener('input', updateBroadcastCount);
}
