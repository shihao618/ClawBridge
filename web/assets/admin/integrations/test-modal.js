/**
 * 规则编辑器 / 定时任务编辑器共用的「测试运行」弹窗骨架（F-04）。
 *
 * 两套编辑器的测试弹窗结构一致：说明文案 →（规则侧可选输入区）→ 结果区，
 * 底部为「关闭 / 运行测试」；点击运行统一 setBusy、错误渲染与 401 静默语义。
 */
import { apiFetch, clearNode, el, toastError } from '../../common.js';
import { openTrackedModal } from '../ui.js';

/**
 * 打开测试运行弹窗。
 *
 * @param {object} options
 * @param {string} options.title 弹窗标题
 * @param {string} options.hint 顶部说明文案
 * @param {Array<Node>} [options.extraContent] 说明与结果区之间的额外内容（规则侧输入区）
 * @param {string} options.resultId 结果容器 id
 * @param {string} options.runPath 测试接口路径
 * @param {() => (object|undefined)} [options.validate] 运行前校验；返回真值表示已提示并中止
 * @param {() => object} options.buildRequestBody 请求 body 构造
 * @param {(data:any) => Array<Node>} options.buildResultNodes 结果节点构造
 * @param {string} [options.errorMessage] 失败兜底文案
 * @returns {object} openTrackedModal 返回的 modal api
 */
export function openTestRunModal({
  title,
  hint,
  extraContent = [],
  resultId,
  runPath,
  validate = null,
  buildRequestBody,
  buildResultNodes,
  errorMessage = '测试运行失败',
}) {
  const resultBox = el('div', { id: resultId, class: 'rule-test-result', hidden: true });
  return openTrackedModal({
    title,
    size: 'wide',
    content: [el('p', { class: 'form-hint', text: hint }), ...extraContent, resultBox],
    actions: [
      { label: '关闭', class: 'btn btn-secondary' },
      {
        label: '运行测试',
        class: 'btn btn-primary',
        closeOnClick: false,
        onClick: async (modalRef) => {
          if (typeof validate === 'function' && validate()) return;
          modalRef.setBusy(true);
          try {
            const data = await apiFetch(runPath, { method: 'POST', body: buildRequestBody() });
            clearNode(resultBox);
            resultBox.hidden = false;
            resultBox.append(...buildResultNodes(data).filter(Boolean));
          } catch (error) {
            clearNode(resultBox);
            resultBox.hidden = false;
            resultBox.append(
              el('p', {
                class: 'inline-error',
                text: error && error.message ? error.message : errorMessage,
              }),
            );
            toastError(error, errorMessage);
          } finally {
            modalRef.setBusy(false);
          }
        },
      },
    ],
  });
}
