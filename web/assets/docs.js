/**
 * ClawBridge API 文档页交互：
 * - 代码块「复制」按钮
 * - 端点表格筛选
 * - 侧边目录高亮
 * - 返回顶部
 */
import { $, $$, el, toast, initSidebarDrawer } from './common.js';

init();

function init() {
  initCopyButtons();
  initEndpointFilter();
  initTocHighlight();
  initTocNavigation();
  initTocDrawer();
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
/* 目录路由：hash 导航 / 浏览器前进后退 / 直接打开 #section            */
/* ------------------------------------------------------------------ */

/**
 * 目录锚点路由。
 *
 * 浏览器原生 hash 跳转在长文档 + `scroll-behavior: smooth` 下有两个问题：
 * 1. 连续点击两个目录项时，前一次平滑滚动仍在进行，后一次会被打断/叠加，最终停在错误位置；
 * 2. 通过地址栏/前进后退切换 hash 时，IntersectionObserver 高亮与滚动位置可能短暂不一致。
 *
 * 这里统一接管目录内的 `#section` 点击、popstate/hashchange 和首屏带 hash 的情况：
 * - 立即高亮目标目录项；
 * - 临时关闭平滑滚动，精确跳到锚点（保留 CSS 的 scroll-margin-top 偏移）；
 * - 用 pushState 维护历史，浏览器后退仍可回到上一个 section。
 */
function initTocNavigation() {
  const nav = $('#docs-nav');
  if (!nav) return;
  const links = $$('a[href^="#"]', nav);
  if (links.length === 0) return;

  const idOf = (link) => {
    const href = link.getAttribute('href') || '';
    if (!href.startsWith('#')) return '';
    try {
      return decodeURIComponent(href.slice(1));
    } catch {
      return href.slice(1);
    }
  };
  const linkFor = (id) => links.find((link) => idOf(link) === id);
  const setActive = (active) => {
    for (const link of links) link.classList.toggle('is-active', link === active);
  };

  /** @returns {boolean} 是否成功定位到目标 section */
  const goTo = (hash, { updateHistory = true } = {}) => {
    const id = String(hash || '').replace(/^#/, '');
    if (!id) return false;
    const target = document.getElementById(id);
    if (!target) return false;
    if (updateHistory && location.hash !== `#${id}`) {
      try {
        history.pushState(null, '', `#${id}`);
      } catch {
        location.hash = `#${id}`;
      }
    }
    // 临时禁用平滑滚动：确保连续点击/前进后退时不会停在中间位置
    const html = document.documentElement;
    const previous = html.style.scrollBehavior;
    html.style.scrollBehavior = 'auto';
    try {
      target.scrollIntoView({ block: 'start' });
    } finally {
      html.style.scrollBehavior = previous;
    }
    setActive(linkFor(id));
    return true;
  };

  for (const link of links) {
    link.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const id = idOf(link);
      if (!id || !document.getElementById(id)) return;
      event.preventDefault();
      goTo(`#${id}`);
    });
  }

  window.addEventListener('popstate', () => {
    if (location.hash) goTo(location.hash, { updateHistory: false });
  });
  window.addEventListener('hashchange', () => {
    if (location.hash) goTo(location.hash, { updateHistory: false });
  });
  if (location.hash) {
    // 等首屏布局（字体/图片）稳定后再校正一次，避免落到偏上/偏下的位置
    requestAnimationFrame(() => goTo(location.hash, { updateHistory: false }));
  }
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

/* ------------------------------------------------------------------ */
/* 移动端目录折叠                                                      */
/* ------------------------------------------------------------------ */

function initTocDrawer() {
  initSidebarDrawer({
    toggleId: 'docs-menu-toggle',
    sidebarSelector: '.doc-sidebar',
    overlayId: 'docs-nav-overlay',
    closeId: 'docs-nav-close',
    navId: 'docs-nav',
    openLabel: '打开文档目录',
    closeLabel: '关闭文档目录',
  });
}