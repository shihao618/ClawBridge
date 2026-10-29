/**
 * ClawBridge API 文档页交互：
 * - 代码块「复制」按钮
 * - 端点表格筛选
 * - 侧边目录高亮
 * - 返回顶部
 */
import { $, $$, el, toast } from './common.js';

init();

function init() {
  initCopyButtons();
  initEndpointFilter();
  initTocHighlight();
  initBackToTop();
}

/* ------------------------------------------------------------------ */
/* 代码块复制                                                          */
/* ------------------------------------------------------------------ */

function initCopyButtons() {
  for (const block of $$('.code-block')) {
    const pre = block.querySelector('pre');
    if (!pre) continue;
    if (block.querySelector('.copy-btn')) continue;
    const button = el('button', {
      class: 'btn btn-secondary btn-xs copy-btn',
      type: 'button',
      text: '复制',
      'aria-label': '复制代码',
    });
    button.addEventListener('click', async () => {
      const text = pre.textContent || '';
      const ok = await copyText(text);
      if (ok) {
        toast('已复制到剪贴板', 'success', 1800);
        const original = button.textContent;
        button.textContent = '已复制';
        setTimeout(() => {
          button.textContent = original;
        }, 1500);
      } else {
        toast('复制失败，请手动选择代码后复制', 'error');
      }
    });
    // 复制按钮放在代码块顶部工具条中，避免与代码内容重叠
    block.prepend(el('div', { class: 'code-block-bar' }, button));
  }
}

/** 优先使用 Clipboard API，非安全上下文回退到 execCommand。 */
async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 回退到 execCommand */
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    document.body.append(textarea);
    textarea.select();
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    textarea.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 端点筛选                                                            */
/* ------------------------------------------------------------------ */

function initEndpointFilter() {
  const input = $('#endpoint-filter');
  const table = $('#endpoint-table');
  if (!input || !table) return;
  const count = $('#endpoint-count');
  const emptyRow = $('#endpoint-empty');
  const rows = $$('tbody tr', table).filter((row) => row.id !== 'endpoint-empty');

  const apply = () => {
    const query = input.value.trim().toLowerCase();
    let visible = 0;
    for (const row of rows) {
      const match = !query || (row.textContent || '').toLowerCase().includes(query);
      row.hidden = !match;
      if (match) visible += 1;
    }
    if (count) {
      count.textContent = query ? `匹配 ${visible} / ${rows.length} 个端点` : `共 ${rows.length} 个端点`;
    }
    if (emptyRow) emptyRow.hidden = visible !== 0;
  };

  input.addEventListener('input', apply);
  apply();
}

/* ------------------------------------------------------------------ */
/* 侧边目录高亮                                                        */
/* ------------------------------------------------------------------ */

function initTocHighlight() {
  const nav = $('#docs-nav');
  if (!nav || typeof IntersectionObserver !== 'function') return;
  const links = $$('a[href^="#"]', nav);
  /** @type {Map<Element, HTMLAnchorElement>} */
  const sectionToLink = new Map();
  for (const link of links) {
    const id = (link.getAttribute('href') || '').slice(1);
    if (!id) continue;
    const section = document.getElementById(id);
    if (section) sectionToLink.set(section, link);
  }
  if (sectionToLink.size === 0) return;

  const setActive = (activeLink) => {
    for (const link of links) link.classList.toggle('is-active', link === activeLink);
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const link = sectionToLink.get(entry.target);
        if (link) setActive(link);
      }
    },
    { rootMargin: '-15% 0px -70% 0px', threshold: 0 },
  );
  for (const section of sectionToLink.keys()) observer.observe(section);
}

/* ------------------------------------------------------------------ */
/* 返回顶部                                                            */
/* ------------------------------------------------------------------ */

function initBackToTop() {
  const button = $('#back-to-top');
  if (!button) return;
  let ticking = false;
  const update = () => {
    ticking = false;
    button.hidden = window.scrollY < 480;
  };
  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    },
    { passive: true },
  );
  button.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  update();
}
