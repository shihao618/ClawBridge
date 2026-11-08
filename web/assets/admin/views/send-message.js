/**
 * 发送消息弹窗（用户行/分组行共用）：文本模板、附件上传与错误提示。
 */

import { MAX_TEXT_LENGTH, MEDIA_KIND_META } from '../constants.js';
import { refreshAfterWrite } from '../core.js';
import { state } from '../state.js';
import { openTrackedModal } from '../ui.js';
import { apiFetch, clearNode, el, formatFileSize, formatNumber, setHidden, toast, toastError, uploadWithProgress } from '../../common.js';

export function openSendMessageModal(target) {
  const isGroup = Boolean(target && target.kind === 'group');
  const user = isGroup ? null : target && target.user ? target.user : null;
  const group = isGroup ? target.group : null;
  if (!isGroup && (!user || typeof user.id !== 'string')) return;
  if (isGroup && (!group || typeof group.id !== 'string')) return;
  const recipient = isGroup
    ? `分组「${group.name || group.id}」`
    : user.displayName
      ? `${user.displayName}（${user.id}）`
      : String(user.id);
  const sendPath = isGroup
    ? `/api/admin/groups/${encodeURIComponent(group.id)}/messages`
    : `/api/admin/users/${encodeURIComponent(user.id)}/messages`;
  const mediaLimits = state.mediaLimits && typeof state.mediaLimits === 'object' ? state.mediaLimits : null;
  const maxBytes = Number(mediaLimits && mediaLimits.maxBytes) > 0 ? Number(mediaLimits.maxBytes) : 0;
  const maxBytesKnown = maxBytes > 0;

  const textarea = el('textarea', {
    id: 'message-text',
    class: 'textarea',
    rows: 3,
    maxlength: MAX_TEXT_LENGTH,
    placeholder: '输入消息文字（可选；选择附件后作为说明文字）',
  });
  const counter = el('span', { class: 'char-count', text: `0 / ${MAX_TEXT_LENGTH}` });
  textarea.addEventListener('input', () => {
    counter.textContent = `${textarea.value.length} / ${MAX_TEXT_LENGTH}`;
  });

  const fileInput = el('input', {
    id: 'media-file-input',
    class: 'visually-hidden-input',
    type: 'file',
    'aria-label': '选择要发送的图片、视频或文件',
  });
  const pickButton = el('button', {
    id: 'btn-pick-file',
    class: 'btn btn-secondary btn-sm',
    type: 'button',
  }, '📎 选择附件');
  const limitHint = el('span', {
    id: 'media-limit-hint',
    class: 'form-hint',
    text: `支持图片 / 视频 / 任意文件，单个不超过 ${maxBytesKnown ? formatFileSize(maxBytes) : '服务端限制'}`,
  });
  const pickerRow = el('div', { class: 'media-picker' }, pickButton, fileInput, limitHint);

  const previewBox = el('div', { id: 'media-preview', class: 'media-preview', hidden: true });
  const clearButton = el('button', {
    id: 'btn-clear-media',
    class: 'btn btn-ghost btn-xs media-clear',
    type: 'button',
    text: '移除附件',
    hidden: true,
  });
  const progressBar = el('div', { id: 'upload-progress-bar', class: 'upload-progress-bar' });
  const progressLabel = el('span', {
    id: 'upload-progress-text',
    class: 'upload-progress-text',
    text: '等待上传…',
  });
  const progressBox = el(
    'div',
    { id: 'upload-progress', class: 'upload-progress', hidden: true },
    el('div', { class: 'upload-progress-track' }, progressBar),
    progressLabel,
  );

  let selectedFile = null;
  /** 图片预览 token：FileReader 异步完成时防止旧文件覆盖新预览。 */
  let previewToken = 0;
  /** 已上传成功的 mediaId 缓存（同一文件重试发送时无需重复上传）。 */
  let uploadedMediaId = null;
  let uploadedFileKey = null;

  function fileKey(file) {
    return `${file.name || ''}:${file.size}:${file.lastModified || 0}`;
  }

  function resetMediaSelection() {
    selectedFile = null;
    uploadedMediaId = null;
    uploadedFileKey = null;
    previewToken += 1;
    clearNode(previewBox);
    setHidden(previewBox, true);
    setHidden(clearButton, true);
    setHidden(progressBox, true);
    progressBox.classList.remove('is-error', 'is-done');
    progressBar.style.width = '0%';
    progressLabel.textContent = '等待上传…';
    fileInput.value = '';
    pickButton.textContent = '📎 选择附件';
  }

  function setUploadProgress(loaded, total, done = false) {
    setHidden(progressBox, false);
    progressBox.classList.remove('is-error');
    progressBox.classList.toggle('is-done', Boolean(done));
    const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : done ? 100 : 0;
    progressBar.style.width = `${percent}%`;
    progressLabel.textContent = done ? '附件已上传，正在发送消息…' : `正在上传附件… ${percent}%`;
  }

  function showUploadError(error) {
    setHidden(progressBox, false);
    progressBox.classList.add('is-error');
    progressBox.classList.remove('is-done');
    progressBar.style.width = '100%';
    if (error && error.status === 413) {
      progressLabel.textContent = `附件超过大小上限（${formatFileSize(maxBytes)}），未发送`;
    } else {
      progressLabel.textContent = `附件上传/发送失败：${error && error.message ? error.message : '未知错误'}`;
    }
  }

  function setPreview(file) {
    clearNode(previewBox);
    const mime = String(file.type || '');
    let thumb;
    if (mime.startsWith('image/')) {
      const img = el('img', { class: 'media-preview-img', alt: '附件图片预览' });
      thumb = el('div', { class: 'media-preview-thumb' }, img);
      // 用 data URL 预览：后端 CSP 为 img-src 'self' data:，无需额外放行 blob:
      const token = ++previewToken;
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        if (token !== previewToken) return;
        if (typeof reader.result === 'string' && reader.result.startsWith('data:image/')) {
          img.src = reader.result;
        }
      });
      reader.readAsDataURL(file);
    } else if (mime.startsWith('video/')) {
      thumb = el('div', {
        class: 'media-preview-thumb media-preview-thumb-file',
        text: MEDIA_KIND_META.video.icon,
        'aria-hidden': 'true',
      });
    } else {
      thumb = el('div', {
        class: 'media-preview-thumb media-preview-thumb-file',
        text: MEDIA_KIND_META.file.icon,
        'aria-hidden': 'true',
      });
    }
    const kindLabel = mime.startsWith('image/') ? '图片' : mime.startsWith('video/') ? '视频' : '文件';
    const info = el(
      'div',
      { class: 'media-preview-info' },
      el('div', { class: 'media-file-name', text: file.name || '未命名文件' }),
      el('div', { class: 'media-file-size', text: `${kindLabel} · ${formatFileSize(file.size)}` }),
    );
    previewBox.append(thumb, info, clearButton);
    setHidden(previewBox, false);
    setHidden(clearButton, false);
    pickButton.textContent = '📎 重新选择';
  }

  function handleFileSelected(file) {
    if (!file) {
      resetMediaSelection();
      return;
    }
    if (maxBytesKnown && file.size > maxBytes) {
      toast(`附件不能超过 ${formatFileSize(maxBytes)}（当前 ${formatFileSize(file.size)}）`, 'warning', 5200);
      resetMediaSelection();
      return;
    }
    if (file.size === 0) {
      toast('不能选择空文件', 'warning');
      resetMediaSelection();
      return;
    }
    selectedFile = file;
    if (uploadedFileKey !== fileKey(file)) uploadedMediaId = null;
    setPreview(file);
    setHidden(progressBox, true);
    progressBox.classList.remove('is-error', 'is-done');
  }

  pickButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    handleFileSelected(fileInput.files && fileInput.files[0] ? fileInput.files[0] : null);
  });
  clearButton.addEventListener('click', () => resetMediaSelection());

  const content = [el('p', { class: 'modal-message', text: `收件人：${recipient}` })];
  if (isGroup) {
    content.push(
      el('p', {
        class: 'alert alert-info',
        text: `将发送给分组内所有可推送用户（活跃且未冷却），当前活跃用户 ${formatNumber(group.activeUserCount)} 位；没有可发送用户时不会入队。`,
      }),
    );
  } else if (!user.hasContextToken) {
    content.push(
      el('p', {
        class: 'alert alert-warning',
        text: '该用户尚无入站消息（无 context_token），首条消息可能发送失败。',
      }),
    );
  }
  content.push(
    el(
      'div',
      { class: 'form-field' },
      el('label', { class: 'form-label', for: 'message-text', text: '消息文字（可选）' }),
      textarea,
      el(
        'div',
        { class: 'form-row-between' },
        el('span', { class: 'form-hint', text: '有附件时，文字会作为图片/文件的说明（caption）先发送。' }),
        counter,
      ),
    ),
    el(
      'div',
      { class: 'form-field' },
      el('span', { class: 'form-label', text: '附件（可选）' }),
      pickerRow,
      previewBox,
      progressBox,
    ),
  );

  openTrackedModal({
    title: '发送消息',
    content,
    onClose: () => {
      // 使仍在读取中的 FileReader 回调失效；图片预览使用的是 data URL，无需释放
      previewToken += 1;
    },
    actions: [
      { label: '取消', class: 'btn btn-secondary' },
      {
        label: '发送',
        class: 'btn btn-primary',
        closeOnClick: false,
        onClick: async (modal) => {
          const text = textarea.value.trim();
          if (!text && !selectedFile) {
            toast('请输入消息文字或选择附件', 'warning');
            textarea.focus();
            return;
          }
          if (text.length > MAX_TEXT_LENGTH) {
            toast(`消息不能超过 ${MAX_TEXT_LENGTH} 个字符`, 'warning');
            return;
          }
          if (selectedFile && maxBytesKnown && selectedFile.size > maxBytes) {
            toast(`附件不能超过 ${formatFileSize(maxBytes)}`, 'warning');
            return;
          }
          modal.setBusy(true);
          try {
            let mediaId = null;
            if (selectedFile) {
              const key = fileKey(selectedFile);
              if (uploadedMediaId && uploadedFileKey === key) {
                mediaId = uploadedMediaId;
              } else {
                setUploadProgress(0, selectedFile.size);
                const uploaded = await uploadWithProgress('/api/admin/media', selectedFile, {
                  headers: {
                    'Content-Type': selectedFile.type || 'application/octet-stream',
                    'X-File-Name': encodeURIComponent(selectedFile.name || 'file'),
                  },
                  onProgress: (loaded, total) => setUploadProgress(loaded, total),
                });
                const media = uploaded && uploaded.media && typeof uploaded.media === 'object' ? uploaded.media : null;
                if (!media || typeof media.id !== 'string' || !/^att_[A-Za-z0-9_-]+$/.test(media.id)) {
                  throw new Error('服务端未返回有效的 mediaId');
                }
                mediaId = media.id;
                uploadedMediaId = mediaId;
                uploadedFileKey = key;
                setUploadProgress(selectedFile.size, selectedFile.size, true);
              }
            }

            /** @type {{text?: string, mediaId?: string}} */
            const body = mediaId ? (text ? { text, mediaId } : { mediaId }) : { text };
            const result = await apiFetch(sendPath, { method: 'POST', body });
            if (isGroup) {
              const count = Number(result && result.count);
              toast(
                `已加入发送队列${mediaId ? '（含附件）' : ''}：${recipient}${
                  Number.isFinite(count) ? `（${count} 条）` : ''
                }`,
                'success',
              );
            } else {
              toast(
                mediaId ? `已加入发送队列（含附件）：${recipient}` : `已加入发送队列：${recipient}`,
                'success',
              );
            }
            modal.close('sent');
            void refreshAfterWrite({ overview: true, users: true, messages: true });
          } catch (error) {
            showUploadError(error);
            toastError(error, '发送消息失败');
          } finally {
            modal.setBusy(false);
          }
        },
      },
    ],
  });
}
