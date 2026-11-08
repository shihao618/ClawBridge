/**
 * 编辑器的通用表单骨架辅助：内联错误节点与滚动提示。
 *
 * 规则编辑器 / 定时任务编辑器的错误节点结构、id 规则、滚动行为一致，
 * 仅 id 前缀不同。
 */
import { apiFetch, el, toast, toastError } from '../../common.js';
import { openTrackedModal } from '../ui.js';

/**
 * 创建编辑器内联错误节点（role=alert）及 show 方法。
 *
 * @param {string} id 错误节点 id（rule-form-error / schedule-form-error）
 * @returns {{ node: HTMLElement, show: (message: string) => void }}
 */
export function createFormError(id) {
  const node = el('p', { id, class: 'inline-error', role: 'alert', hidden: true });
  return {
    node,
    show(message) {
      node.textContent = message;
      node.hidden = false;
      node.scrollIntoView({ block: 'nearest' });
    },
  };
}

/**
 * 创建编辑器「保存/创建」按钮的点击处理器（规则编辑器与定时任务编辑器共用）。
 *
 * 统一处理：清空内联错误 → 名称校验（必填/≤60 字）→ 业务 payload 构建（可返回错误）
 * → setBusy → PATCH/POST → 成功 toast/关闭/刷新 → 失败内联错误与 5xx toast。
 * 两个编辑器的差异仅通过参数传入（实体称谓、接口路径、payload 构建、刷新函数）。
 *
 * @param {object} options
 * @param {boolean} options.isEdit 是否编辑
 * @param {string} options.nameLabel 名称校验文案中的实体称谓（规则/任务）
 * @param {string} [options.toastLabel] toast 中的实体称谓，默认同 nameLabel
 * @param {string} options.itemPath PATCH 路径
 * @param {string} options.collectionPath POST 路径
 * @param {() => Promise<unknown>} options.refresh 保存成功后的刷新
 * @param {HTMLElement} options.errorNode 内联错误节点
 * @param {(message: string) => void} options.showFormError 内联错误展示
 * @param {() => string} options.getName 读取名称输入
 * @param {(name: string) => ({payload: object, savedSuffix?: string}|null)} options.buildPayload 构建 payload（校验失败返回 null）
 * @param {string} options.fallbackError 保存失败兜底文案
 * @param {string} [options.badRequestMessage] 400 且无 message 时的文案
 * @returns {(modal: object) => Promise<void>}
 */
export function createSaveAction({
  isEdit,
  nameLabel,
  toastLabel = nameLabel,
  itemPath,
  collectionPath,
  refresh,
  errorNode,
  showFormError,
  getName,
  buildPayload,
  fallbackError,
  badRequestMessage = '',
}) {
  return async (modal) => {
    errorNode.hidden = true;
    const name = getName();
    if (!name) return showFormError(`请输入${nameLabel}名称`);
    if (name.length > 60) return showFormError(`${nameLabel}名称不能超过 60 个字符`);
    const result = buildPayload(name);
    if (!result) return;
    const { payload, savedSuffix = '' } = result;
    modal.setBusy(true);
    try {
      if (isEdit) {
        const patchPath = typeof itemPath === 'function' ? itemPath() : itemPath;
        await apiFetch(patchPath, { method: 'PATCH', body: payload });
        toast(`${toastLabel}「${name}」已保存${savedSuffix}`, 'success');
      } else {
        await apiFetch(collectionPath, { method: 'POST', body: payload });
        toast(`${toastLabel}「${name}」已创建${savedSuffix}`, 'success');
      }
      modal.close('saved');
      await refresh();
    } catch (error) {
      if (badRequestMessage && error && error.status === 400) {
        showFormError(error.message || badRequestMessage);
      } else {
        showFormError(error && error.message ? error.message : fallbackError);
      }
      if (error && error.status >= 500) toastError(error, fallbackError);
    } finally {
      modal.setBusy(false);
    }
  };
}

/**
 * 打开编辑器弹窗（规则/定时任务共用骨架）：宽弹窗、点击遮罩不关闭、
 * 底部固定「取消 / 保存|创建」按钮，保存走 createSaveAction。
 *
 * @param {object} options
 * @param {string} options.title 弹窗标题
 * @param {Array<Node>} options.content 表单内容
 * @param {string} options.saveLabel 保存按钮文案（保存/创建）
 * @param {(modal: object) => Promise<void>} options.onSave 保存处理器
 * @param {boolean} [options.closeOnBackdrop] 是否允许点击遮罩关闭（默认 false，长表单防误关）
 */
export function openEditorModal({ title, content, saveLabel, onSave, closeOnBackdrop = false }) {
  return openTrackedModal({
    title,
    size: 'wide',
    closeOnBackdrop,
    content,
    actions: [
      { label: '取消', class: 'btn btn-secondary' },
      { label: saveLabel, class: 'btn btn-primary', closeOnClick: false, onClick: onSave },
    ],
  });
}
