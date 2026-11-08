/**
 * 前端页面静态校验（node:test，无外部依赖）。
 *
 * 用临时 node:http 静态服务器模拟后端路由：
 *   /            → web/index.html
 *   /bind        → web/index.html
 *   /admin       → web/admin.html
 *   /docs        → web/docs.html
 *   /assets/*    → web/assets/*
 *
 * 覆盖：
 * - 三个页面路由返回 200 HTML
 * - 无内联 <script> / 无内联事件处理器（CSP script-src 'self'）
 * - 页面引用的 /assets/* 资源存在且可访问
 * - 关键元素 id 存在且页面内唯一
 * - 无外部 CDN / 字体 / 图片引用
 * - 前端脚本无 innerHTML、覆盖 API 契约关键路径
 *
 * 独立运行：node --test tests/unit/frontend-pages.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..', '..');
const WEB_DIR = path.join(ROOT, 'web');
const ASSETS_DIR = path.join(WEB_DIR, 'assets');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const PAGE_ROUTES = new Map([
  ['/', 'index.html'],
  ['/bind', 'index.html'],
  ['/admin', 'admin.html'],
  ['/docs', 'docs.html'],
]);

const PAGES = [
  { route: '/', file: 'index.html', script: 'bind.js', name: '绑定页' },
  { route: '/bind', file: 'index.html', script: 'bind.js', name: '绑定页（/bind）' },
  { route: '/admin', file: 'admin.html', script: 'admin.js', name: '管理后台' },
  { route: '/docs', file: 'docs.html', script: 'docs.js', name: 'API 文档页' },
];

const REQUIRED_IDS = {
  'index.html': [
    'bind-form',
    'display-name',
    'btn-create',
    'create-error',
    'bind-session',
    'qr-img',
    'status-badge',
    'status-text',
    'status-message',
    'qr-countdown',
    'verify-form',
    'verify-code',
    'btn-verify',
    'verify-error',
    'bound-info',
    'bound-details',
    'bound-note',
    'btn-regenerate',
    'btn-cancel',
  ],
  'admin.html': [
    'admin-loading',
    'login-view',
    'login-form',
    'login-password',
    'login-submit',
    'login-error',
    'dashboard',
    'admin-sidebar',
    'admin-menu',
    'btn-sidebar-toggle',
    'sidebar-overlay',
    'view-title',
    'overview-updated',
    'sidebar-version',
    'btn-refresh',
    'btn-logout',
    'overview-stats',
    'overview-server',
    'users-total',
    'user-search',
    'user-status-filter',
    'user-group-filter',
    'user-table-body',
    'users-pagination',
    'users-prev',
    'users-next',
    'users-page-info',
    'groups-section',
    'groups-total',
    'btn-create-group',
    'group-table-body',
    'app-rules-section',
    'app-rules-total',
    'btn-create-rule',
    'rule-status-filter',
    'app-rule-table-body',
    'rule-tabs',
    'rule-rules-panel',
    'rule-schedule-panel',
    'schedule-total',
    'btn-create-schedule',
    'schedule-table-body',
    'app-rules-head-actions',
    'schedule-head-actions',
    'broadcast-form',
    'broadcast-text',
    'broadcast-count',
    'btn-broadcast',
    'messages-total',
    'messages-tabs',
    'messages-group-filter',
    'messages-table-body',
    'messages-pagination',
    'messages-prev',
    'messages-next',
    'messages-page-info',
    'config-list',
    'settings-groups',
    'settings-savebar',
    'settings-save-status',
    'btn-settings-save',
    'settings-error',
    'settings-unavailable',
    'settings-env-only',
    'settings-restart-note',
    'security-card',
    'security-token-preview',
    'security-token-source',
    'security-password-source',
    'security-push-toggle',
    'security-current-password',
    'security-new-password',
    'security-confirm-password',
    'btn-password-change',
    'btn-password-reset',
    'btn-token-rotate',
    'btn-token-reset',
    'security-error',
  ],
  'docs.html': [
    'docs-nav',
    'overview',
    'auth',
    'push-api',
    'media',
    'endpoints',
    'endpoint-filter',
    'endpoint-count',
    'endpoint-table',
    'endpoint-empty',
    'bind-status',
    'admin-api',
    'groups-api',
    'inbound-api',
    'keepalive',
    'app-rules',
    'scheduled-tasks',
    'error-codes',
    'back-to-top',
  ],
};

/** @type {http.Server} */
let server;
let baseUrl = '';

function resolveFilePath(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://127.0.0.1').pathname);
  } catch {
    return null;
  }
  const pageFile = PAGE_ROUTES.get(pathname);
  if (pageFile) return path.join(WEB_DIR, pageFile);
  if (pathname.startsWith('/assets/')) {
    const relative = pathname.slice('/assets/'.length);
    if (!relative || relative.includes('..') || relative.includes('\\') || path.isAbsolute(relative)) {
      return null;
    }
    const absolute = path.resolve(ASSETS_DIR, relative);
    const assetsRoot = path.resolve(ASSETS_DIR) + path.sep;
    return absolute.startsWith(assetsRoot) ? absolute : null;
  }
  return null;
}

before(async () => {
  server = http.createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('method not allowed');
      return;
    }
    const filePath = resolveFilePath(request.url || '/');
    if (!filePath) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    try {
      const body = await fs.readFile(filePath);
      const contentType =
        MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      response.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
});

async function readPage(file) {
  return fs.readFile(path.join(WEB_DIR, file), 'utf8');
}

async function readAsset(name) {
  return fs.readFile(path.join(ASSETS_DIR, name), 'utf8');
}

/**
 * 递归列出 web/assets 下全部前端脚本（相对路径，POSIX 分隔符，稳定排序）。
 * 拆分 admin.js 为多个 ES Module 后，静态契约改为扫描全部脚本，避免只覆盖入口文件。
 */
async function listAssetFiles(dir = ASSETS_DIR, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listAssetFiles(path.join(dir, entry.name), rel)));
    } else if (entry.name.endsWith('.js')) {
      files.push(rel);
    }
  }
  return files.sort();
}

/** 读取 web/assets/**\/*.js 全量源码并拼接（带文件分隔注释，便于定位）。 */
async function readAllAssets() {
  const files = await listAssetFiles();
  const contents = await Promise.all(
    files.map(async (file) => `/* ==== ${file} ==== */\n${await fs.readFile(path.join(ASSETS_DIR, file), 'utf8')}`),
  );
  return contents.join('\n');
}

/** 读取 web/assets 下的指定脚本（相对路径）。 */
async function readAssetAt(relPath) {
  return fs.readFile(path.join(ASSETS_DIR, relPath), 'utf8');
}

/**
 * 读取规则/定时任务两套编辑器所在视图模块并拼接。
 * 精确计数断言（如「重设 Header 逻辑恰好两份」）针对具体模块文件，不依赖 admin.js 单文件结构。
 */
async function readEditorModules() {
  const [appRules, schedules] = await Promise.all([
    readAssetAt('admin/views/app-rules.js'),
    readAssetAt('admin/views/schedules.js'),
  ]);
  return `${appRules}\n${schedules}`;
}

/* ------------------------------------------------------------------ */
/* 1. 页面路由                                                         */
/* ------------------------------------------------------------------ */

test('页面路由 /、/bind、/admin、/docs 均返回 200 HTML', async () => {
  for (const page of PAGES) {
    const response = await fetch(`${baseUrl}${page.route}`);
    assert.equal(response.status, 200, `${page.route} 应返回 200（${page.name}）`);
    assert.match(
      response.headers.get('content-type') || '',
      /text\/html/,
      `${page.route} 的 Content-Type 应为 text/html`,
    );
    const html = await response.text();
    assert.match(html, /<html[\s>]/i, `${page.name} 应返回完整 HTML`);
    assert.match(html, /<meta charset="utf-8">/i, `${page.name} 应声明 UTF-8`);
    assert.match(html, /<meta name="viewport"/i, `${page.name} 应声明移动端 viewport`);
    assert.match(html, /lang="zh-CN"/i, `${page.name} 应为中文页面`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. CSP 兼容：无内联 script / 无内联事件                              */
/* ------------------------------------------------------------------ */

test('页面无内联 <script>，脚本均为同源 ES Module', async () => {
  for (const page of PAGES) {
    const html = await readPage(page.file);
    const allScripts = html.match(/<script\b[^>]*>/gi) || [];
    assert.ok(allScripts.length > 0, `${page.name} 应包含 <script> 引用`);
    for (const tag of allScripts) {
      assert.match(tag, /\bsrc\s*=\s*["']\/assets\//i, `${page.name} 的脚本必须来自 /assets/：${tag}`);
      assert.match(tag, /type\s*=\s*["']module["']/i, `${page.name} 的脚本必须是 type="module"：${tag}`);
    }
    // 不存在无 src 的内联 script 标签
    assert.doesNotMatch(
      html,
      /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i,
      `${page.name} 不允许内联 <script>（CSP script-src 'self'）`,
    );
    // 不使用内联 <style>（样式集中在 /assets/style.css）
    assert.doesNotMatch(html, /<style\b/i, `${page.name} 不允许内联 <style>`);
  }
});

test('页面无内联事件处理器（onclick 等）', async () => {
  for (const page of PAGES) {
    const html = await readPage(page.file);
    const tags = html.match(/<[a-zA-Z][^>]*>/g) || [];
    for (const tag of tags) {
      assert.doesNotMatch(
        tag,
        /\son[a-z]+\s*=/i,
        `${page.name} 不允许内联事件处理器：${tag.slice(0, 120)}`,
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* 3. 资源引用                                                         */
/* ------------------------------------------------------------------ */

test('页面引用的 /assets/ 资源存在且可 HTTP 访问', async () => {
  for (const page of PAGES) {
    const html = await readPage(page.file);
    const references = [...html.matchAll(/(?:src|href)\s*=\s*["'](\/assets\/[^"']+)["']/gi)].map(
      (match) => match[1],
    );
    assert.ok(references.length >= 2, `${page.name} 至少引用 style.css 与页面脚本`);
    assert.ok(
      references.includes('/assets/style.css'),
      `${page.name} 必须引用 /assets/style.css`,
    );
    assert.ok(
      references.includes(`/assets/${page.script}`),
      `${page.name} 必须引用 /assets/${page.script}`,
    );

    for (const reference of new Set(references)) {
      const relative = reference.slice('/assets/'.length);
      const absolute = path.join(ASSETS_DIR, relative);
      const stat = await fs.stat(absolute);
      assert.ok(stat.isFile(), `${page.name} 引用的 ${reference} 应存在`);

      const response = await fetch(`${baseUrl}${reference}`);
      assert.equal(response.status, 200, `${reference} 应可访问`);
      const extension = path.extname(relative).toLowerCase();
      const expectedType = MIME_TYPES[extension];
      if (expectedType) {
        assert.equal(response.headers.get('content-type'), expectedType);
      }
      await response.arrayBuffer();
    }
  }
});

/* ------------------------------------------------------------------ */
/* 4. 关键元素 id                                                      */
/* ------------------------------------------------------------------ */

test('页面关键元素 id 存在且唯一', async () => {
  for (const [file, requiredIds] of Object.entries(REQUIRED_IDS)) {
    const html = await readPage(file);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual(duplicates, [], `${file} 存在重复 id：${duplicates.join(', ')}`);

    const idSet = new Set(ids);
    for (const required of requiredIds) {
      assert.ok(idSet.has(required), `${file} 缺少关键元素 id="${required}"`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 5. 零外部依赖                                                       */
/* ------------------------------------------------------------------ */

test('HTML / CSS 不引用任何外部 URL（CDN / 字体 / 图片）', async () => {
  for (const page of PAGES) {
    const html = await readPage(page.file);
    assert.doesNotMatch(
      html,
      /\b(?:src|href)\s*=\s*["'](?:https?:)?\/\//i,
      `${page.name} 不允许引用外部资源`,
    );
    assert.doesNotMatch(html, /@import\b/i, `${page.name} 不允许 CSS @import`);
  }

  const css = await readAsset('style.css');
  assert.doesNotMatch(css, /@import\b/i, 'style.css 不允许 @import');
  assert.doesNotMatch(css, /url\(\s*['"]?(?:https?:)?\/\//i, 'style.css 不允许外部 url()');
  assert.doesNotMatch(css, /@font-face\b/i, 'style.css 不使用外部字体');
});

test('前端 JS 不使用 innerHTML 拼接动态内容，且不引用外部 URL', async () => {
  const jsFiles = await listAssetFiles();
  assert.ok(jsFiles.length >= 4, `web/assets 下应至少有 4 个前端脚本，实际：${jsFiles.join(', ')}`);
  // 仅允许占位示例域名（输入框 placeholder，不是资源引用）
  const PLACEHOLDER_HOSTS = /^https:\/\/(?:api\.example\.com|example\.com)(?:[/?#]|$)/;
  for (const file of jsFiles) {
    const source = await readAssetAt(file);
    assert.doesNotMatch(source, /\.innerHTML\b/, `${file} 不允许使用 innerHTML`);
    assert.doesNotMatch(source, /\.outerHTML\b/, `${file} 不允许使用 outerHTML`);
    assert.doesNotMatch(
      source,
      /fetch\(\s*['"]https?:|import\s*\(\s*['"]https?:|\.src\s*=\s*['"]https?:/,
      `${file} 不允许从外部 URL 加载资源`,
    );
    for (const match of source.matchAll(/https?:\/\/[^\s'"`)<]+/g)) {
      assert.match(
        match[0],
        PLACEHOLDER_HOSTS,
        `${file} 不允许引用外部 URL：${match[0]}（仅允许输入框占位示例域名）`,
      );
    }
    assert.match(source, /^import\s|\bexport\s/m, `${file} 应为 ES Module`);
  }
});

/* ------------------------------------------------------------------ */
/* 6. 主题与契约覆盖                                                   */
/* ------------------------------------------------------------------ */

test('样式包含微信绿主色与移动端响应式规则', async () => {
  const css = await readAsset('style.css');
  assert.match(css, /#07c160/i, '主色应为微信绿 #07C160');
  assert.match(css, /@media\s*\(/i, '应包含响应式媒体查询');
  assert.match(css, /:root\s*\{/i, '应使用 CSS 变量定义主题');
  assert.match(css, /--font-sans:/i, '应使用系统字体栈（无外部字体）');
});

test('绑定脚本覆盖 docs/API.md 中全部绑定状态', async () => {
  const source = await readAsset('bind.js');
  const statuses = [
    'waiting',
    'scanned',
    'need_verifycode',
    'refreshing',
    'verify_blocked',
    'confirmed',
    'already_bound',
    'expired',
    'timeout',
    'error',
    'cancelled',
  ];
  for (const status of statuses) {
    assert.ok(source.includes(status), `bind.js 应处理绑定状态 ${status}`);
  }
  for (const endpoint of ['/api/bind/sessions', '/verify-code']) {
    assert.ok(source.includes(endpoint), `bind.js 应调用 ${endpoint}`);
  }
  assert.match(source, /safeSvgDataUri/, '绑定页应通过 safeSvgDataUri 校验二维码 data URI');
  const common = await readAsset('common.js');
  assert.match(
    common,
    /data:image\/svg\+xml;base64,/,
    'common.js 应只接受 data:image/svg+xml;base64, 开头的二维码',
  );
  assert.match(source, /1000/, '绑定状态轮询间隔应为 1s 左右');
});

test('后台脚本覆盖管理 API 契约与 CSRF 请求头', async () => {
  const admin = await readAllAssets();
  for (const endpoint of [
    '/api/admin/me',
    '/api/admin/login',
    '/api/admin/logout',
    '/api/admin/overview',
    '/api/admin/users',
    '/api/admin/messages',
    '/api/admin/config',
    '/api/admin/broadcast',
    '/unbind',
    '/reconnect',
  ]) {
    assert.ok(admin.includes(endpoint), `admin.js 应使用 ${endpoint}`);
  }
  for (const token of ['deleteUser', '永久删除', 'method: \'DELETE\'']) {
    assert.ok(admin.includes(token), `admin.js 应包含删除用户实现：${token}`);
  }
  const common = await readAsset('common.js');
  assert.ok(common.includes('X-Requested-With'), 'common.js 应支持 CSRF 请求头');
  assert.ok(common.includes('ClawBridge-Admin'), '写请求应带 X-Requested-With: ClawBridge-Admin');
  assert.ok(admin.includes('5000'), '后台自动刷新间隔应为 5s');
  assert.ok(common.includes('document.hidden'), '轮询工具应在页面隐藏时暂停');
});

test('文档页内容与 docs/API.md 一致（关键端点与错误码）', async () => {
  const html = await readPage('docs.html');
  for (const token of [
    '/api/v1/messages',
    '/api/v1/broadcast',
    '/api/v1/webhook',
    '?token=',
    '/api/v1/users',
    '/api/admin/login',
    '/api/bind/sessions',
    'Authorization: Bearer',
    'X-Api-Key',
    'RATE_LIMITED',
    'UNAVAILABLE',
    'API_TOKEN',
  ]) {
    assert.ok(html.includes(token), `docs.html 应包含契约内容：${token}`);
  }
});

test('多媒体：管理后台脚本实现上传、预览与附件渲染', async () => {
  const admin = await readAllAssets();
  for (const token of [
    '/api/admin/media',
    'X-File-Name',
    'mediaId',
    'attachments',
    'download=1',
    'uploadWithProgress',
    'formatFileSize',
    'mediaLimits',
    'media-preview',
    'upload-progress',
    'maxBytes',
    'video',
    'image',
    'FileReader',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含多媒体实现：${token}`);
  }
  assert.ok(admin.includes("startsWith('/api/')"), '附件 URL 必须只接受同源 /api/ 路径');
  assert.ok(admin.includes("type: 'file'"), '发消息弹窗应包含文件选择 input');
  assert.ok(admin.includes('/api/admin/users/'), '应继续使用管理后台发消息接口');
});

test('多媒体：common.js 提供上传进度与文件大小工具', async () => {
  const common = await readAsset('common.js');
  assert.ok(common.includes('export function uploadWithProgress'), 'common.js 应提供 uploadWithProgress');
  assert.ok(common.includes('XMLHttpRequest'), '上传进度需使用 XHR');
  assert.ok(common.includes('export function formatFileSize'), 'common.js 应提供 formatFileSize');
  assert.ok(common.includes("'X-File-Name'") || common.includes('X-File-Name'), '上传应支持 X-File-Name');
});

test('多媒体：样式包含上传预览与消息附件样式', async () => {
  const css = await readAsset('style.css');
  for (const token of [
    '.media-preview',
    '.upload-progress',
    '.msg-thumb',
    '.msg-video',
    '.msg-attachments',
    '.msg-file-row',
    '.mini-msg',
    '.visually-hidden-input',
  ]) {
    assert.ok(css.includes(token), `style.css 应包含多媒体样式：${token}`);
  }
});

test('文档页多媒体章节与 docs/MEDIA.md 契约一致', async () => {
  const [mediaDoc, html] = await Promise.all([
    fs.readFile(path.join(ROOT, 'docs', 'MEDIA.md'), 'utf8'),
    readPage('docs.html'),
  ]);
  assert.match(html, /<section id="media"/, 'docs.html 应有 #media 章节');

  for (const token of [
    'X-File-Name',
    '--data-binary',
    'mediaId',
    'MEDIA_MAX_BYTES',
    'INBOUND_MEDIA_MAX_BYTES',
    'MEDIA_ALLOWED_IMAGE_MIME',
    'MEDIA_ALLOWED_VIDEO_MIME',
    'MEDIA_DIR',
    'ILINK_CDN_BASE_URL',
    '413',
    'Range',
    '?download=1',
  ]) {
    if (!['MEDIA_DIR', 'ILINK_CDN_BASE_URL'].includes(token)) assert.ok(html.includes(token), `docs.html 多媒体章节缺少：${token}`);
    assert.ok(mediaDoc.includes(token) || token === '?download=1' || token === 'Range', `docs/MEDIA.md 应描述：${token}`);
  }

  for (const endpoint of [
    '/api/admin/media',
    '/api/v1/media',
    '/api/admin/media/{attId}',
    '/api/v1/media/{attId}',
  ]) {
    assert.ok(mediaDoc.includes(endpoint), `docs/MEDIA.md 应包含端点 ${endpoint}`);
    assert.ok(html.includes(endpoint), `docs.html 缺少多媒体端点 ${endpoint}`);
  }
});

test('分组：管理后台脚本实现分组 CRUD、归属、筛选与群发', async () => {
  const admin = await readAllAssets();
  for (const token of [
    '/api/admin/groups',
    '/api/admin/groups/',
    'groupIds',
    'groupId',
    'activeUserCount',
    'userCount',
    'group-badge',
    'color-palette',
    'group-check-list',
    'openGroupEditor',
    'openUserGroupsModal',
    'UNGROUPED_FILTER',
    'PATCH',
    'DELETE',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含分组实现：${token}`);
  }
  assert.match(admin, /\/groups\/\$\{encodeURIComponent/, '分组归属/群发接口应使用编码后的分组 ID');
});

test('分组保活继承：行内开关、分组分配提示与接口字段', async () => {
  const admin = await readAllAssets();
  for (const token of [
    'keepaliveEnabled',
    'isGroupKeepaliveEnabled',
    'buildGroupKeepaliveSwitch',
    'toggleGroupKeepalive',
    'group-keepalive-flag',
    '保活中',
    '· 保活',
    '之后加入该分组的成员将自动开启保活',
    '该用户已随分组自动开启保活',
    'inheritedKeepalive',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含分组保活继承实现：${token}`);
  }
  assert.ok(!admin.includes('group-keepalive-input'), '分组编辑表单不再包含保活复选框（改为列表行内开关）');
  assert.ok(!admin.includes('批量保活'), '旧「批量保活」弹窗已移除');
  assert.match(admin, /payload = \{ name, description, color: selectedColor \|\| '' \}/, '新建/编辑分组请求不再携带 keepaliveEnabled');
  assert.match(
    admin,
    /refreshAfterWrite\(\{ overview: true, users: true, groups: true \}\)/,
    '行内切换分组保活后应刷新用户/分组/概览',
  );
});

test('分组：后台页面包含分组区块与筛选控件', async () => {
  const html = await readPage('admin.html');
  for (const token of [
    'id="groups-section"',
    'id="btn-create-group"',
    'id="group-table-body"',
    'id="user-group-filter"',
    '未分组',
    'id="messages-group-filter"',
    '用户分组',
  ]) {
    assert.ok(html.includes(token), `admin.html 应包含分组相关结构：${token}`);
  }
});

test('文档页分组与入站消息 API 与 docs/GROUPS_AND_INBOUND.md 一致', async () => {
  const [contract, html] = await Promise.all([
    fs.readFile(path.join(ROOT, 'docs', 'GROUPS_AND_INBOUND.md'), 'utf8'),
    readPage('docs.html'),
  ]);
  assert.match(html, /<section id="groups-api"/, 'docs.html 应有 #groups-api 章节');
  assert.match(html, /<section id="inbound-api"/, 'docs.html 应有 #inbound-api 章节');

  for (const token of [
    '/api/admin/groups',
    '/api/v1/groups',
    '/api/v1/inbound/messages',
    '/api/admin/groups/{id}/messages',
    '/api/v1/groups/{groupId}/messages',
    'nextCursor',
    'hasMore',
    'serverTime',
    'since',
    'cursor',
    'wait',
    'groupId',
  ]) {
    assert.ok(contract.includes(token), `docs/GROUPS_AND_INBOUND.md 应描述：${token}`);
    assert.ok(html.includes(token), `docs.html 分组/入站章节缺少：${token}`);
  }
  for (const token of ['409', 'PUT', 'X-Api-Key', 'Authorization: Bearer']) {
    assert.ok(html.includes(token), `docs.html 分组/入站章节缺少：${token}`);
  }
  assert.ok(
    /轮询示例|cursor=\$NEXT|wait=25/.test(html),
    'docs.html 入站消息章节应包含 cursor/wait 轮询示例',
  );
});

test('保活：管理后台脚本实现用户/分组开关、配置小节与来源标签', async () => {
  const admin = await readAllAssets();
  for (const token of [
    '/keepalive',
    'keepaliveEnabled',
    'keepaliveLastSentAt',
    'keepaliveEnabledUsers',
    'keepaliveSent24h',
    'buildKeepaliveSwitch',
    'toggleUserKeepalive',
    'buildGroupKeepaliveSwitch',
    'toggleGroupKeepalive',
    '保活中',
    '消息保活',
    'MESSAGE_SOURCE_META',
    'badge-keepalive',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含保活实现：${token}`);
  }
  assert.match(admin, /method:\s*'PATCH'/, '单用户保活应使用 PATCH');
  assert.ok(admin.includes('source'), '消息行应渲染 source 来源标签');
});

test('保活：后台页面用户表包含保活列', async () => {
  const html = await readPage('admin.html');
  assert.ok(html.includes('保活'), 'admin.html 用户表应包含「保活」列');
  assert.ok(html.includes('<th scope="col">保活</th>'), '保活列应为独立表格列');
});

test('文档页消息保活章节与 docs/KEEPALIVE.md 一致', async () => {
  const [contract, html] = await Promise.all([
    fs.readFile(path.join(ROOT, 'docs', 'KEEPALIVE.md'), 'utf8'),
    readPage('docs.html'),
  ]);
  assert.match(html, /<section id="keepalive"/, 'docs.html 应有 #keepalive 章节');
  for (const token of [
    '/api/admin/users/{id}/keepalive',
    '/api/admin/groups/{id}/keepalive',
    'keepaliveEnabled',
    'keepaliveLastSentAt',
    'KEEPALIVE_ENABLED',
    'KEEPALIVE_WINDOW_MS',
    'KEEPALIVE_LEAD_MS',
    'KEEPALIVE_REPEAT_MS',
    'KEEPALIVE_TICK_MS',
    'KEEPALIVE_TEXT',
    'KEEPALIVE_MAX_PER_TICK',
    'updated',
    'source',
    'opt-in',
    'keepaliveSent24h',
  ]) {
    assert.ok(contract.includes(token), `docs/KEEPALIVE.md 应描述：${token}`);
    if (!token.startsWith('KEEPALIVE_')) assert.ok(html.includes(token), `docs.html 保活章节缺少：${token}`);
  }
  assert.ok(/未回复.*重复提醒|重复提醒/.test(html), 'docs.html 应说明未回复时重复提醒');
  assert.ok(html.includes('repeatMs'), 'docs.html 应说明重复提醒间隔 repeatMs');
  assert.ok(/curl -X PATCH/.test(html) && /curl -X POST/.test(html), 'docs.html 应包含保活 curl 示例');
});

test('接口应用：管理后台脚本实现规则 CRUD、表单、测试运行与日志', async () => {
  const admin = await readAllAssets();
  for (const token of [
    '/api/admin/app-rules',
    '/api/admin/app-rule-logs',
    'includeDisabled=1',
    'requestBody.headers',
    'headerNames',
    'createHeaderModeField',
    '重设 Header',
    '••••••',
    '值不会回显',
    '值已加密隐藏',
    '响应头（诊断）',
    'Header 值已加密保存（不会回显）',
    'syncHeaderModeUi',
    'createPickerSection',
    'extractionModeSelect',
    '不提取（直接调用接口）',
    'rule-extraction-mode',
    'rule-request-mode',
    '不请求（直接回复默认文本）',
    'openAppRuleEditor',
    'duplicateAppRule',
    'app-rules/${encodeURIComponent(rule.id)}/duplicate',
    '复制规则',
    'openAppRuleTestModal',
    'openRuleLogsModal',
    'setRuleTab',
    'rule-log-modal-status',
    'rule-log-modal-body',
    'rule-log-modal-prev',
    'buildRuleTestResultNodes',
    'priority',
    'rule-form-section',
    'rule-picker-list',
    '/test',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含接口应用实现：${token}`);
  }
  assert.match(admin, /\/app-rules\/\$\{encodeURIComponent/, '规则接口应使用编码后的规则 ID');
});

test('接口应用：规则日志改为弹窗（移除独立日志 Tab）', async () => {
  const admin = await readAllAssets();
  for (const token of [
    'openRuleLogsModal',
    'rule-log-modal-status',
    'rule-log-modal-body',
    'rule-log-modal-prev',
    'rule-log-modal-next',
    'rule-log-modal-page-info',
    '加载规则运行日志失败',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含规则日志弹窗实现：${token}`);
  }
  assert.match(admin, /params\.set\('ruleId', rule\.id\)/, '规则日志弹窗应固定按 ruleId 查询');
  assert.ok(!admin.includes('loadRuleLogsInline'), '不应再保留内联日志加载函数');
  assert.ok(!admin.includes('updateRuleLogFilterOptions'), '不应再保留内联日志筛选函数');
  const html = await readPage('admin.html');
  assert.ok(!html.includes('data-rule-tab="logs"'), '不应再有「运行日志」Tab');
  assert.ok(!html.includes('id="rule-logs-panel"'), '不应再有运行日志面板');
  assert.ok(
    html.includes('data-rule-tab="rules"') && html.includes('data-rule-tab="schedule"'),
    '应保留规则列表与定时通知两个 Tab',
  );
});

test('定时通知：interval 可选每日生效时间段（windowStart/windowEnd）', async () => {
  const admin = await readAllAssets();
  for (const token of [
    'windowStart',
    'windowEnd',
    'schedule-window-start',
    'schedule-window-end',
    '每日生效时间段',
    '需同时填写开始与结束时间',
    '开始与结束时间不能相同',
    '支持跨午夜',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含 interval 生效时间段实现：${token}`);
  }
  assert.match(admin, /windowStart,\s*\n\s*windowEnd,/, '保存 payload 应携带 windowStart/windowEnd');
  assert.match(admin, /summary\}（\$\{windowStart\}–\$\{windowEnd\}）/, '列表摘要应显示「每 N 分钟（08:00–20:00）」');
});

test('接口应用：后台页面包含规则区块', async () => {
  const html = await readPage('admin.html');
  for (const token of [
    'id="app-rules-section"',
    'id="btn-create-rule"',
    'id="app-rule-table-body"',
    'id="rule-status-filter"',
    '接口应用',
    '新建规则',
  ]) {
    assert.ok(html.includes(token), `admin.html 应包含接口应用结构：${token}`);
  }
});

test('菜单模式：侧栏固定 7 项菜单与视图区块一一对应', async () => {
  const html = await readPage('admin.html');
  const menu = [
    ['overview', '概览', '#/overview', 'overview-section'],
    ['users', '用户管理', '#/users', 'users-section'],
    ['groups', '用户分组', '#/groups', 'groups-section'],
    ['messages', '消息记录', '#/messages', 'messages-section'],
    ['broadcast', '广播消息', '#/broadcast', 'broadcast-section'],
    ['app-rules', '接口应用', '#/app-rules', 'app-rules-section'],
    ['config', '运行配置', '#/config', 'config-section'],
  ];
  for (const [view, label, hash, sectionId] of menu) {
    assert.ok(html.includes(`data-view="${view}"`), `admin.html 缺少视图 ${view}`);
    assert.ok(html.includes(`href="${hash}"`), `admin.html 缺少菜单链接 ${hash}`);
    assert.ok(html.includes(`id="${sectionId}"`), `admin.html 缺少视图容器 ${sectionId}`);
    assert.ok(html.includes(label), `admin.html 缺少菜单文案 ${label}`);
  }
  // 固定顺序
  const positions = menu.map(([, , hash]) => html.indexOf(`href="${hash}"`));
  assert.deepStrictEqual([...positions].sort((a, b) => a - b), positions, '7 项菜单顺序必须固定');
  // 页面底部版本号
  assert.ok(html.includes('id="sidebar-version"'), '后台页面底部应有版本号');
  const footerLinks = [...html.matchAll(/class="sidebar-link"[^>]*href="([^"]+)"/g)].map((m) => m[1]).filter((href) => href === '/' || href === '/docs');
  assert.deepEqual(footerLinks, ['/', '/docs'], '后台侧栏底部顺序应为 首页、API 文档');
  assert.ok(html.includes('id="btn-sidebar-toggle"'), '应有移动端菜单按钮');
  assert.ok(html.includes('id="sidebar-overlay"'), '应有抽屉遮罩');
  assert.ok(html.includes('id="view-title"'), '顶部栏应有当前视图标题');
});

test('菜单模式：hash 路由、懒加载与移动抽屉实现', async () => {
  const admin = await readAllAssets();
  for (const token of [
    'MENU_VIEWS',
    'VIEW_BY_ID',
    'VIEW_STORAGE_KEY',
    'DEFAULT_VIEW',
    'LIVE_VIEWS',
    'hashchange',
    'sessionStorage',
    'aria-current',
    'is-active',
    'sidebar-open',
    'document.title',
    'showView',
    'navigateToView',
    'resolveInitialView',
    'loadView',
    'closeDrawer',
    'initSidebarDrawer',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含菜单/路由实现：${token}`);
  }
  assert.ok(admin.includes('.hidden = item.id !== view.id'), '切换视图应只显示当前 section（其余 hidden）');
  assert.match(admin, /window\.addEventListener\('hashchange'/, '应监听 hashchange');
  assert.match(admin, /sessionStorage\.setItem\(VIEW_STORAGE_KEY/, '应记录目标视图到 sessionStorage');
  assert.match(admin, /setAttribute\('aria-current', 'page'\)/, '菜单高亮应使用 aria-current="page"');
  assert.match(admin, /history\.replaceState\(null, '', VIEW_BY_ID\.get\(DEFAULT_VIEW\)\.hash\)/, '未知 hash 应回退概览');
});

test('定时通知：后台脚本实现任务 CRUD、表单、测试运行、立即执行与日志', async () => {
  const admin = await readAllAssets();
  for (const token of [
    'buildRequestRow',
    'buildResponseRow',
    'buildHeaderListField',
    'buildTemplateTools',
  ]) {
    assert.ok(admin.includes(token), `新建规则/任务应共用表单模块：${token}`);
  }
  for (const token of [
    '/api/admin/scheduled-tasks',
    '/api/admin/scheduled-task-logs',
    'loadScheduledTasks',
    'renderScheduledTasks',
    'buildScheduledTaskRow',
    'openScheduleEditor',
    'openScheduleTestModal',
    'runScheduledTask',
    'openScheduleLogsModal',
    'deleteScheduledTask',
    'duplicateScheduledTask',
    'scheduled-tasks/${encodeURIComponent(task.id)}/duplicate',
    '复制定时任务',
    'schedule-type',
    'schedule-plan-main-row',
    'schedule-interval-minutes',
    'schedule-daily-time',
    'createPickerSection',
    'withPickerActions',
    'schedule-target-type',
    '全部用户',
    'createHeaderModeField',
    'createResponseInputs',
    'recipientsCount',
    'responseHeaders',
    'headerNames',
    'intervalMs',
    'dailyTime',
    '不会发送给用户',
    '{{#each',
    '{{count',
    '@number',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含定时通知实现：${token}`);
  }
  assert.match(admin, /\/scheduled-tasks\/\$\{encodeURIComponent/, '定时任务接口应使用编码后的任务 ID');
  const scheduleActionLabels = [...admin.matchAll(/scheduleActionButton\('schedule-(?:edit|duplicate|test|run|logs|delete)', task\.id, '([^']+)'/g)]
    .map((match) => match[1]);
  assert.deepEqual(
    scheduleActionLabels,
    ['编辑', '复制', '测试', '执行', '日志', '删除'],
    '定时通知行按钮应依次为 编辑、复制、测试、执行、日志、删除',
  );
  const html = await readPage('admin.html');
  assert.ok(html.includes('data-rule-tab="schedule"'), '接口应用页应有「定时通知」Tab');
  assert.ok(html.includes('定时通知'), '应包含「定时通知」文案');
});

test('接口应用与定时通知：重设 Header 的实际操作一致（保留名称、清除掩码、补全新值）', async () => {
  const editorModules = await readEditorModules();
  const all = await readAllAssets();
  const headerMode = await readAssetAt('admin/integrations/header-mode.js');
  const count = (pattern) => (headerMode.match(pattern) || []).length;
  // F-04：两套编辑器共用 integrations/header-mode.js，能力只实现一次，两侧都引用共享模块
  assert.equal(count(/function syncHeaderModeUi\(\)/g), 1, 'Header 模式同步函数应统一在共享模块中实现');
  assert.equal(
    count(/if \(headerModeValue === 'keep'\) headersTextarea\.value = headerNamesText;/g),
    1,
    '保留模式应显示掩码 Header',
  );
  assert.equal(
    count(/const headerResetText = headerNames\.map\(\(name\) => `\$\{name\}: `\)/g),
    1,
    '重设模式应为每个 Header 保留名称',
  );
  assert.equal(
    count(/else if \(headerModeValue === 'replace'\) headersTextarea\.value = headerResetText;/g),
    1,
    '重设模式应填入保留名称、清除隐藏值的文本',
  );
  assert.equal(
    count(/请补全每个 Header 的值；如需全部删除，请选择「清空 Header」/g),
    1,
    '规则和定时都应校验空 Header 值',
  );
  assert.equal(
    count(/请选择「重设 Header」，保留名称并补全新值/g),
    1,
    '规则和定时的重设提示应一致',
  );
  assert.equal(
    (editorModules.match(/createHeaderModeField\(/g) || []).length,
    2,
    '规则编辑器与定时任务编辑器都应引用共享 Header 模块',
  );
  assert.ok(!all.includes('schedule-header-mask'), '定时通知不应再有单独的 Header 掩码提示');
  assert.ok(!all.includes('现有 Header（值已加密不回显）'), '旧 Header 展示不应保留');
});

test('响应模板：条件判断、默认值与离线预览入口', async () => {
  const [admin, html, css] = await Promise.all([
    readAllAssets(),
    readPage('docs.html'),
    readAsset('style.css'),
  ]);
  for (const token of [
    'buildTemplatePreviewButton',
    'buildMarkdownPreviewButton',
    'markdown-preview',
    'Markdown 预览',
    'buildTemplateSyntaxHelpButton',
    'openTemplatePreviewModal',
    'openTemplateSyntaxHelpModal',
    'template-preview-sample',
    'template-preview-result',
    '预览模板',
    '模板语法',
    'template-help-section',
    'template-help-list',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含模板预览/语法帮助实现：${token}`);
  }
  for (const token of [
    '{{reply}}',
    '{{response}}',
    '{{raw}}',
    '{{@root',
    '{{@responseRoot',
    '{{../字段}}',
    'where 字段=值',
    '{{default 路径 "兜底文案"}}',
  ]) {
    assert.ok(admin.includes(token), `admin.js 模板语法帮助应包含：${token}`);
  }
  for (const token of [
    '/api/admin/template-preview',
    '{{#if',
    '{{else if',
    '{{#unless',
    '{{default',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含模板条件/预览实现：${token}`);
    assert.ok(html.includes(token), `docs.html 应说明模板条件/预览：${token}`);
  }
  for (const token of ['.template-preview-result', '.template-help-section', '.template-help-code', 'white-space: pre-wrap', 'overflow-wrap: anywhere']) {
    assert.ok(css.includes(token), `style.css 应包含模板预览/帮助样式：${token}`);
  }
});

test('定时通知：文档页章节与 docs/SCHEDULED_TASKS.md 一致', async () => {
  const [contract, html] = await Promise.all([
    fs.readFile(path.join(ROOT, 'docs', 'SCHEDULED_TASKS.md'), 'utf8'),
    readPage('docs.html'),
  ]);
  assert.match(html, /<section id="scheduled-tasks"/, 'docs.html 应有 #scheduled-tasks 章节');
  for (const token of [
    '/api/admin/scheduled-tasks',
    '/api/admin/scheduled-tasks/{id}',
    '/api/admin/scheduled-tasks/{id}/duplicate',
    '/api/admin/scheduled-tasks/{id}/test',
    '/api/admin/template-preview',
    '/api/admin/scheduled-tasks/{id}/run',
    '/api/admin/scheduled-task-logs',
    'SCHEDULER_ENABLED',
    'SCHEDULER_TICK_MS',
    'SCHEDULER_TIMEZONE',
    'SCHEDULER_MAX_RECIPIENTS',
    'SCHEDULER_TIMEOUT_MS',
    'interval',
    'daily',
    'timezone',
    'next_run_at',
    'source=schedule',
    'headerNames',
    'recipientsCount',
    'responseHeaders',
    'fallback_text',
    'SSRF',
    '{{path}}',
    '{{response}}',
    '{{raw}}',
  ]) {
    assert.ok(contract.includes(token), `docs/SCHEDULED_TASKS.md 应描述：${token}`);
    if (!token.startsWith('SCHEDULER_')) assert.ok(html.includes(token), `docs.html 定时通知章节缺少：${token}`);
  }
  assert.ok(/curl -X POST[^\n]*scheduled-tasks/.test(html), 'docs.html 应包含创建定时任务 curl 示例');
  assert.ok(html.includes('测试运行') && html.includes('立即执行'), 'docs.html 应说明测试运行/立即执行');
  const admin = await readAllAssets();
  assert.ok(admin.includes('手动执行不会改变下一次定时时间'), '后台立即执行应提示不影响定时');
  assert.ok(admin.includes('定时计划不变'), '后台成功提示应注明定时计划不变');
});

test('运行配置：后台可编辑设置表单（分组/保存/恢复默认/只读 env）', async () => {
  const admin = await readAllAssets();
  for (const token of [
    '/api/admin/settings',
    '/api/admin/settings/reset',
    'loadSettings',
    'renderSettings',
    'buildSettingControl',
    'handleSettingsInput',
    'collectSettingsChanges',
    'saveSettings',
    'resetSettingsGroup',
    'restartRequired',
    'envOnly',
    'settings-group',
    'settings-field',
    'settings-savebar',
    'settings-modified-badge',
    'settings-restart-badge',
    '恢复默认',
    '已修改',
    '需重启',
    'parseSettingArrayInput',
    'settings/reset',
    '/api/admin/system/restart',
    'restartContainer',
    'waitForHealth',
    '重启容器',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含运行配置实现：${token}`);
  }
  assert.match(admin, /method: 'PATCH', body: patch/, '保存运行配置应 PATCH 只提交变化字段');
  assert.match(admin, /body: \{ group: groupKey \}/, '恢复默认应提交 group');
  const html = await readPage('admin.html');
  for (const id of [
    'settings-groups',
    'btn-settings-save',
    'settings-save-status',
    'settings-env-only',
    'settings-restart-note',
    'btn-restart-container',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `admin.html 应有设置表单 id=${id}`);
  }
});

test('运行配置：第二批分组与安全卡片（改密/API Token）', async () => {
  const admin = await readAllAssets();
  for (const token of [
    '/api/admin/security/password',
    '/api/admin/security/password/reset',
    '/api/admin/security/api-token/rotate',
    '/api/admin/security/api-token/reset',
    'renderSecurityCard',
    'toggleSecurityPushApi',
    'changeAdminPassword',
    'resetAdminPassword',
    'rotateApiToken',
    'resetApiToken',
    'showTokenRevealModal',
    'showSecretRevealModal',
    'securityTokenPreview',
    'securityPasswordSource',
    'admin-password.txt',
    'api-token.txt',
    '重置为随机密码',
    '重置 Token',
    '复制密码',
    'pushApiEnabled',
    'settings-enum',
    'enum',
    '复制 Token',
    '仅显示一次',
    '已登录会话不会强制下线',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含安全卡片/第二批设置实现：${token}`);
  }
  assert.match(admin, /body: \{ currentPassword, newPassword \}/, '修改密码应提交当前/新密码');
  assert.match(admin, /body: \{ security: \{ pushApiEnabled: next \} \}/, '推送 API 开关走 PATCH settings');
  assert.match(admin, /data\.password \|\| data\.newPassword/, '重置随机密码应读取后端返回的 password 明文');
  assert.match(admin, /data\.token \|\| data\.apiToken/, '重置 Token 应读取后端返回的 token 明文');
  const html = await readPage('admin.html');
  for (const id of [
    'security-card',
    'security-token-preview',
    'security-token-source',
    'security-password-source',
    'security-push-toggle',
    'security-current-password',
    'security-new-password',
    'security-confirm-password',
    'btn-password-change',
    'btn-password-reset',
    'btn-token-rotate',
    'btn-token-reset',
    'security-error',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `admin.html 应有安全卡片元素 id=${id}`);
  }
  assert.ok(html.includes('重置为随机密码'), '管理密码按钮应为「重置为随机密码」');
  assert.ok(html.includes('重置 Token'), 'API Token 按钮应为「重置 Token」');
  assert.ok(!html.includes('恢复环境变量密码'), '不应再出现「恢复环境变量密码」');
  assert.ok(!html.includes('恢复环境变量默认'), '不应再出现「恢复环境变量默认」');
  assert.ok(html.includes('data/admin-password.txt') && html.includes('data/api-token.txt'), '应说明新密码/Token 写入 data/ 文件');
});

test('运行配置：后台说明不在文档页重复，契约保留在 docs/SETTINGS.md', async () => {
  const [contract, html] = await Promise.all([
    fs.readFile(path.join(ROOT, 'docs', 'SETTINGS.md'), 'utf8'),
    readPage('docs.html'),
  ]);
  assert.ok(!html.includes('<section id="settings"'), '文档页不应再重复运行配置章节');
  assert.ok(!html.includes('href="#settings"'), '文档页目录不应再列出运行配置');
  assert.match(html, /本文档只描述 HTTP API 契约/, '文档页应说明只描述 API 契约');
  for (const token of [
    '/api/admin/settings',
    '/api/admin/settings/reset',
    'app_settings',
    'envOnly',
    'restartRequired',
    'APP_SECRET',
    'rateLimitMax',
    'retryDelaysMs',
    'maxTextLength',
    'publicBaseUrl',
    'adminPasswordSource',
    'MEDIA_DIR',
    'NODE_ENV',
    'scrypt',
    'AES',
  ]) {
    assert.ok(contract.includes(token), `docs/SETTINGS.md 应描述：${token}`);
  }
  assert.ok(!/curl -X PATCH[^\n]*api\/admin\/settings/.test(html), '文档页不再重复运行配置 curl 示例');
});

test('文档页接口应用章节与 docs/API_RULES.md 一致', async () => {
  const [contract, html] = await Promise.all([
    fs.readFile(path.join(ROOT, 'docs', 'API_RULES.md'), 'utf8'),
    readPage('docs.html'),
  ]);
  assert.match(html, /<section id="app-rules"/, 'docs.html 应有 #app-rules 章节');
  assert.match(html, /href="#app-rules">规则列表</, '文档目录应有「规则列表」入口');
  assert.match(html, /href="#scheduled-tasks">定时通知</, '文档目录应有「定时通知」独立入口');
  assert.ok(!html.includes('href="#app-rules">接口应用'), '接口应用应拆分为规则列表和定时通知');
  assert.match(html, /<section id="scheduled-tasks" class="doc-section"/, '定时通知应为独立章节');
  for (const token of [
    '/api/admin/app-rules',
    '/api/admin/app-rules/{id}',
    '/api/admin/app-rules/{id}/duplicate',
    '/api/admin/app-rules/{id}/test',
    '/api/admin/template-preview',
    '{{#if',
    '{{default',
    '/api/admin/app-rule-logs',
    'APP_RULES_ENABLED',
    'APP_RULE_TIMEOUT_MS',
    'APP_RULE_MAX_RESPONSE_BYTES',
    'APP_RULES_WORKER_CONCURRENCY',
    'APP_RULES_ALLOWED_HOSTS',
    'APP_RULE_MAX_QUEUE',
    'priority',
    'scope_type',
    'match_mode',
    'extraction_mode',
    'reply_template',
    'fallback_text',
    'request.mode',
    '不请求',
    'RATE_LIMIT_MAX',
    '7 条 / 5 分钟',
    "source='rule'",
    'SSRF',
  ]) {
    assert.ok(contract.includes(token), `docs/API_RULES.md 应描述：${token}`);
    if (!token.startsWith('APP_RULE')) assert.ok(html.includes(token), `docs.html 接口应用章节缺少：${token}`);
  }
  assert.ok(/curl -X POST[^\n]*app-rules/.test(html), 'docs.html 应包含新建规则 curl 示例');
  assert.ok(html.includes('{{response}}') || html.includes('{{data.answer}}'), 'docs.html 应说明回复模板 {{路径}} 语法');
});

test('文档页覆盖 docs/API.md 中的全部 HTTP 端点、错误码与绑定状态', async () => {
  const [apiMarkdown, html] = await Promise.all([
    fs.readFile(path.join(ROOT, 'docs', 'API.md'), 'utf8'),
    readPage('docs.html'),
  ]);

  const endpoints = new Set();
  // 仅匹配真实 API 前缀，避免把正文描述（如 admin/api/broadcast/group/...）误识别为端点
  const endpointPattern = /\/api\/(?:admin|v1|bind|health)(?:\/[a-z0-9/{}_.-]*)?/gi;
  for (const match of apiMarkdown.matchAll(endpointPattern)) {
    let endpoint = match[0].replace(/[.,;:]+$/g, '');
    if (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1);
    if (endpoint.length > 5) endpoints.add(endpoint);
  }
  assert.ok(endpoints.size >= 15, `docs/API.md 中应至少解析出 15 个端点，实际 ${endpoints.size}`);

  /** 占位符名字（{id}/{sessionId}/{outboxId}）不要求和 API.md 完全一致，只要求路径结构一致。 */
  const normalizeEndpoint = (value) => value.replace(/\{[^}]*\}/g, '{}');
  const documentedEndpoints = new Set(
    [...html.matchAll(endpointPattern)].map((match) =>
      normalizeEndpoint(match[0].replace(/[.,;:]+$/g, '')),
    ),
  );
  for (const endpoint of endpoints) {
    assert.ok(
      documentedEndpoints.has(normalizeEndpoint(endpoint)),
      `docs.html 缺少 docs/API.md 中的端点：${endpoint}`,
    );
  }

  const errorCodes = [
    'BAD_REQUEST',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'NOT_FOUND',
    'CONFLICT',
    'RATE_LIMITED',
    'INTERNAL',
    'UNAVAILABLE',
  ];
  for (const code of errorCodes) {
    assert.ok(html.includes(code), `docs.html 缺少错误码：${code}`);
  }

  const statuses = [
    'waiting',
    'scanned',
    'need_verifycode',
    'refreshing',
    'verify_blocked',
    'confirmed',
    'already_bound',
    'expired',
    'timeout',
    'cancelled',
    'error',
  ];
  for (const status of statuses) {
    assert.ok(html.includes(status), `docs.html 缺少绑定状态：${status}`);
  }
});

test('后台脚本在模块末尾才调用 init()（避免顶层 let/const TDZ 导致登录卡住）', async () => {
  const code = await readAsset('admin.js');
  const trimmed = code.trimEnd();
  assert.ok(trimmed.endsWith('init();'), 'admin.js 末尾应为 init(); 调用');
  const calls = code.match(/^init\(\);$/gm) ?? [];
  assert.equal(calls.length, 1, 'admin.js 只允许一处顶层 init(); 调用');
  const afterInit = code.slice(code.lastIndexOf('init();'));
  assert.ok(!/^(?:const|let)\s/m.test(afterInit), 'init() 之后不应再声明顶层 const/let');
});

test('接口应用：新建规则弹窗点击遮罩不关闭（closeOnBackdrop=false）', async () => {
  const [editorModules, editorShell, common] = await Promise.all([
    readEditorModules(),
    readAssetAt('admin/integrations/editor-shell.js'),
    readAsset('common.js'),
  ]);
  // F-04：编辑器弹窗骨架统一在 integrations/editor-shell.js，默认 closeOnBackdrop=false（长表单防误关）
  assert.match(editorShell, /closeOnBackdrop = false/, '规则编辑弹窗应设置 closeOnBackdrop: false');
  assert.match(editorModules, /openEditorModal\(\{/, '规则与定时任务编辑器应使用共享弹窗骨架');
  assert.match(common, /closeOnBackdrop = true/, 'openModal 应支持 closeOnBackdrop 选项');
  assert.match(common, /!busy && closeOnBackdrop\) close\('dismiss'\)/, '遮罩关闭需受 closeOnBackdrop 控制');
});

test('接口应用：参数提取支持多参数组合模式', async () => {
  const admin = await readAllAssets();
  for (const token of ['多参数组合提取', 'MULTI_EXTRACTOR_TYPE_LABELS', 'multi-extractor-row', 'multi-extractor-list', '＋ 添加提取项', 'multiExtractors']) {
    assert.ok(admin.includes(token), `admin.js 应包含多参数提取实现：${token}`);
  }
  assert.match(admin, /extractionCfg\.extractors = extractors/, '多参数模式保存时应写入 extractors');
  assert.match(admin, /extractionCfg\.required = requiredNames/, '多参数模式应写入必填参数');
});

test('移动端后台顶栏：标题与刷新/退出按钮不冲突', async () => {
  const css = await readAsset('style.css');
  for (const token of [
    '.admin-topbar-bar .topbar-actions',
    'text-overflow: ellipsis',
    'flex-wrap: nowrap',
    'flex: 0 0 auto',
  ]) {
    assert.ok(css.includes(token), `style.css 应包含移动端顶栏适配：${token}`);
  }
  assert.ok(!css.includes('.admin-topbar .topbar-actions'), '旧的 .admin-topbar 死规则已删除（F-16：仅保留 .admin-topbar-bar）');
});
test('表单：GET 隐藏 Body 模板、POST 显示；定时任务弹窗遮罩不关闭', async () => {
  const [editorModules, responseSection, editorShell] = await Promise.all([
    readEditorModules(),
    readAssetAt('admin/integrations/response-section.js'),
    readAssetAt('admin/integrations/editor-shell.js'),
  ]);
  // F-04：Body 模板字段与「GET 隐藏 / POST 显示」联动统一在共享模块中实现一次
  for (const token of ['syncRuleRequestFields', 'syncScheduleRequestFields']) {
    assert.ok(editorModules.includes(token), `编辑器模块应包含请求表单方法联动：${token}`);
  }
  assert.match(editorModules, /createBodyTemplateField\(/, '规则与定时任务编辑器应使用共享 Body 模板字段');
  assert.ok(responseSection.includes('${prefix}-body'), '共享 Body 模板字段应按前缀生成 id');
  assert.equal(
    (responseSection.match(/setHidden\(bodyField, methodSelect\.value !== 'POST'\)/g) || []).length,
    1,
    '规则与定时任务表单都应在 GET 时隐藏 Body（共享实现一次）',
  );
  assert.match(editorShell, /closeOnBackdrop = false/, '规则编辑与定时任务编辑弹窗都应设置 closeOnBackdrop: false');
});
test('移动端文档页：黑色示例框不超出屏幕', async () => {
  const css = await readAsset('style.css');
  for (const token of ['.doc-card .code-block', 'overflow-wrap: anywhere', '.doc-content .code-inline']) {
    assert.ok(css.includes(token), `style.css 应包含文档页移动端防溢出：${token}`);
  }
  assert.match(css, /\.code-block\s*\{[\s\S]*?max-width:\s*100%/, '代码框应限制最大宽度');
});
test('表单行：2/3 个输入框等宽均分并占满一行', async () => {
  const css = await readAsset('style.css');
  assert.match(css, /\.rule-form-grid\s*\{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/, '主表单行应使用统一三列栅格');
  assert.match(css, /\.password-form\s*\{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/, '新密码/确认新密码应两列同行');
  assert.ok(css.includes('.rule-form-grid .input-narrow'), '窄输入框应在表单行内填满列宽');
  assert.ok(css.includes('.form-grid-2 .input-narrow'), '两列行内的时间输入框应填满半列');
  assert.ok(css.includes('max-width: none'), '表单行内窄输入框不应限制最大宽度');
});
test('规则/任务基本信息：启用项在名称上方，规则名称与优先级同一行', async () => {
  const [admin, css] = await Promise.all([readAllAssets(), readAsset('style.css')]);
  for (const token of ['class: \'check-field\'', 'rule-priority-input', '启用规则', '启用任务', "formField('规则名称'", "formField('任务名称"]) {
    assert.ok(admin.includes(token), `规则/任务基本信息应包含：${token}`);
  }
  assert.ok(css.includes('.check-field'), 'style.css 应提供启用项卡片样式');
});
test('文档页：移动端目录使用侧边抽屉（与后台一致）', async () => {
  const [html, js, css] = await Promise.all([readPage('docs.html'), readAsset('docs.js'), readAsset('style.css')]);
  for (const token of ['id="docs-menu-toggle"', 'id="docs-nav-close"', 'id="docs-nav-overlay"', 'class="docs-topbar"', 'doc-sidebar-brand', 'doc-sidebar-footer']) {
    assert.ok(html.includes(token), `文档页应包含后台式导航元素：${token}`);
  }
  assert.ok(!html.includes('class="site-header"'), '文档页应使用后台式导航壳，不再保留独立站点导航');
  assert.ok(!html.includes('docs-topbar-actions'), '文档页右上角不再放导航按钮');
  assert.match(html, /aria-controls="docs-nav"/, '菜单按钮应关联 docs-nav');
  assert.ok(js.includes('initTocDrawer'), 'docs.js 应实现侧边抽屉');
  for (const token of ['docs-nav-open', '.doc-sidebar', '.docs-menu-toggle']) {
    assert.ok(css.includes(token), `style.css 应包含移动端抽屉样式：${token}`);
  }
  assert.match(css, /\.doc-sidebar \.doc-nav\s*\{[\s\S]*?overflow-y:\s*auto/, '文档目录应在侧栏内部滚动');
  assert.match(css, /\.doc-sidebar-footer\s*\{[\s\S]*?flex-shrink:\s*0/, '文档侧栏底部导航应固定');
});
test('首页：使用与后台一致的侧边栏/顶栏导航', async () => {
  const html = await readPage('index.html');
  for (const token of [
    'class="doc-sidebar"',
    'id="home-menu-toggle"',
    'id="home-nav-overlay"',
    'id="home-nav-close"',
    'class="docs-topbar"',
    'doc-sidebar-brand',
  ]) {
    assert.ok(html.includes(token), `首页应使用后台式导航壳：${token}`);
  }
  assert.ok(!html.includes('class="site-header"'), '首页不应再使用独立横向站点导航');
  assert.ok(!html.includes('docs-topbar-actions'), '首页右上角不再放导航按钮');
  assert.ok(html.includes('id="bind-form"'), '首页仍应包含扫码绑定表单');
});
test('全站响应式：页面/导航只有一套 DOM 与交互，无 JS 设备判断或独立 PC/移动端分支', async () => {
  const [adminHtml, docsHtml, indexHtml, css] = await Promise.all([
    readPage('admin.html'),
    readPage('docs.html'),
    readPage('index.html'),
    readAsset('style.css'),
  ]);
  for (const [name, html] of [['admin.html', adminHtml], ['docs.html', docsHtml], ['index.html', indexHtml]]) {
    assert.match(html, /name="viewport"/, `${name} 必须有 viewport meta`);
    assert.ok(!html.includes('br-mobile'), `${name} 不应包含单独的移动端换行标记`);
    assert.ok(!html.includes('mobile-nav') && !html.includes('desktop-nav'), `${name} 不应维护 PC/移动两套导航 DOM`);
  }
  // 设备判断扫描覆盖 web/assets/**/*.js 全量（拆分模块后新增文件同样受约束）
  const DEVICE_PATTERN = /matchMedia|innerWidth|screen\.width|isMobile\b|isDesktop\b/;
  for (const file of await listAssetFiles()) {
    const source = await readAssetAt(file);
    assert.doesNotMatch(source, DEVICE_PATTERN, `${file} 不应在 JS 中判断设备/屏幕宽度`);
  }
  // 各页面入口脚本（含管理后台入口）都复用共享响应式导航实现
  for (const name of ['admin.js', 'common.js', 'docs.js', 'bind.js']) {
    const source = await readAsset(name);
    assert.ok(source.includes('initSidebarDrawer'), `${name} 应复用共享响应式导航`);
  }
  assert.match(css, /@media \(max-width: 1023px\)/, '响应式断点应由 CSS 统一处理');
  assert.match(css, /@media \(max-width: 899px\)/, '文档/首页断点应由 CSS 统一处理');
  assert.match(css, /@media \(min-width: 1024px\)/, '大屏规则应由同一套 CSS 处理');
});

test('后台表单三列栅格：下拉占 1 列、输入占 2 列、长文本/单选整行', async () => {
  const [admin, css] = await Promise.all([readAllAssets(), readAsset('style.css')]);
  for (const token of ['form-field--wide', 'form-field--full', 'span: 2', 'span: 3']) {
    assert.ok(admin.includes(token), `admin.js 应使用三列栅格字段跨度：${token}`);
  }
  assert.match(css, /\.rule-form-grid\s*\{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/, '主表单应为三列栅格');
  assert.match(css, /\.schedule-plan-main-row\s*\{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/, '计划类型/间隔、开始/结束时间应各占一半');
  assert.match(css, /\.form-grid-2\s*\{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/, '两列字段行应为等宽两列');
  for (const token of ['.form-field--wide', '.form-field--full', '.settings-field', '.settings-field--full']) {
    assert.ok(css.includes(token), `style.css 应定义字段跨度：${token}`);
  }
  assert.match(css, /\.settings-fields\s*\{[\s\S]*?display:\s*flex[\s\S]*?flex-wrap:\s*wrap/, '运行配置行应使用自动填满的 flex 布局');
  assert.match(css, /\.settings-field\s*\{[\s\S]*?flex:\s*1 1 calc\(\(100% - 36px\) \/ 3\)/, '运行配置字段应按行内数量自动均分');
  for (const token of ['ADVANCED_SETTINGS_KEYS', 'settings-advanced', 'binding.verifyTimeoutMs', 'media.uploadTimeoutMs', 'ilink.routeTag']) {
    assert.ok(admin.includes(token) || css.includes(token), `运行配置应包含高级设置折叠：${token}`);
  }
  assert.match(css, /\.settings-advanced-summary\s*\{[\s\S]*?cursor:\s*pointer/, '高级设置应可折叠展开');
  assert.match(css, /@media \(max-width: 1023px\)[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/, '平板应降为两列');
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/, '手机应降为单列');
});

test('后台弹窗：分组加载失败禁止保存，会话过期统一调用 closeAllModals 清理弹窗', async () => {
  const admin = await readAllAssets();
  assert.match(admin, /if \(!groupsLoaded\)/, '分组弹窗保存前必须检查分组是否加载成功');
  assert.ok(admin.includes('加载分组失败，请关闭弹窗后重试'), '分组加载失败应给出明确提示且禁止保存');
  assert.match(admin, /export function closeAllModals\(/, 'common.js 应导出 closeAllModals() 统一关闭弹窗');
  assert.match(admin, /closeAllModals\('unauthorized'\)/, '会话过期/登出应调用 closeAllModals 关闭全部弹窗（含 confirmDialog）');
  assert.doesNotMatch(admin, /querySelectorAll\('\.modal-backdrop'\)/, '不得再手工 remove 弹窗遮罩 DOM');
});
test('接口应用/定时任务：新建表单启用项默认不勾选，编辑保留原值', async () => {
  const editorModules = await readEditorModules();
  assert.equal(
    (editorModules.match(/checked: isEdit \? source\.enabled === true : false/g) || []).length,
    2,
    '规则与定时任务编辑器新建时「启用」都应默认不勾选（编辑保留原值）',
  );
  assert.doesNotMatch(editorModules, /checked: isEdit \? source\.enabled === true : true/, '新建表单不应默认勾选启用');
});
test('输入框聚焦提示：长 placeholder 在窄输入框下方完整展示', async () => {
  const [common, css] = await Promise.all([readAsset('common.js'), readAsset('style.css')]);
  for (const token of ['initFocusHints', 'focus-hint', 'focusin', 'aria-describedby', 'isPlaceholderClipped', 'measureText']) {
    assert.ok(common.includes(token), `common.js 应实现聚焦提示：${token}`);
  }
  for (const token of ['.focus-hint', '.focus-hint.is-visible', 'overflow-wrap: anywhere', 'white-space: pre-line']) {
    assert.ok(css.includes(token), `style.css 应包含聚焦提示样式：${token}`);
  }
});

test('无障碍：Tab 组件具备 tabpanel/aria-controls/roving tabindex 与键盘切换（F-07）', async () => {
  const [html, entry, ui, messages, appRules] = await Promise.all([
    readPage('admin.html'),
    readAssetAt('admin.js'),
    readAssetAt('admin/ui.js'),
    readAssetAt('admin/views/messages.js'),
    readAssetAt('admin/views/app-rules.js'),
  ]);
  // 消息方向 Tab：tab 与共用内容面板建立关联
  for (const token of [
    'id="messages-tab-inbound"',
    'id="messages-tab-outbound"',
    'aria-controls="messages-panel"',
    'id="messages-panel"',
    'role="tabpanel"',
    'aria-labelledby="messages-tab-inbound"',
  ]) {
    assert.ok(html.includes(token), `admin.html 消息 Tab 应包含无障碍语义：${token}`);
  }
  // 接口应用 Tab：两个面板各自关联对应 tab
  for (const token of [
    'id="rule-tab-rules"',
    'id="rule-tab-schedule"',
    'aria-controls="rule-rules-panel"',
    'aria-controls="rule-schedule-panel"',
    'aria-labelledby="rule-tab-rules"',
    'aria-labelledby="rule-tab-schedule"',
    'tabindex="0"',
    'tabindex="-1"',
  ]) {
    assert.ok(html.includes(token), `admin.html 接口应用 Tab 应包含无障碍语义：${token}`);
  }
  // 键盘交互：方向键 / Home / End + roving tabindex 统一由 ui.js setupTablist 实现
  for (const token of ['setupTablist', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'tabIndex', 'aria-selected']) {
    assert.ok(ui.includes(token), `ui.js setupTablist 应实现键盘/roving 语义：${token}`);
  }
  assert.match(entry, /tablist: els\.messagesTabs/, '入口应初始化消息方向 Tab');
  assert.match(entry, /tablist: els\.ruleTabs/, '入口应初始化接口应用 Tab');
  assert.match(messages, /aria-labelledby.*messages-tab/, '消息方向切换应同步面板 aria-labelledby');
  assert.match(appRules, /button\.tabIndex = active \? 0 : -1/, '规则/定时 Tab 切换应维护 roving tabindex');
});

test('无障碍：关键文字/主按钮颜色达到 WCAG AA（F-08）', async () => {
  const css = await readAsset('style.css');
  // token：加深后的次要文字与绿色文字（白底 / 页面底对比度见 :root 注释）
  for (const token of [
    '--text-muted: #5b6675',
    '--wechat-green-text: #047a3a',
    '--wechat-green-text-strong: #056c35',
    '--wechat-green: #07c160',
  ]) {
    assert.ok(css.includes(token), `style.css 应包含对比度达标 token：${token}`);
  }
  assert.match(css, /\.btn-primary\s*\{[\s\S]*?background:\s*var\(--wechat-green-text\)/, '主按钮应使用 AA 级绿底（白字 ≥4.5:1）');
  assert.match(css, /\.menu-item\.is-active\s*\{[\s\S]*?color:\s*var\(--wechat-green-text\)/, '菜单激活文字应使用 AA 级绿字');
  assert.match(css, /\.form-hint\s*\{[\s\S]*?color:\s*var\(--text-muted\)/, '提示文字应使用加深后的 --text-muted');
  assert.ok(/WCAG AA/.test(css), ':root 注释应标注颜色 token 的最低对比度（WCAG AA）');
  assert.ok(!/color:\s*#8b95a5/i.test(css), '旧的 3.03:1 灰色文字不应残留');
  assert.ok(!/color:\s*#64748b/i.test(css), '旧的 4.34:1 徽章/状态文字不应残留');
});

test('CSS 变量：所有 var() 引用均有定义或 fallback（F-17）', async () => {
  const css = await readAsset('style.css');
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
  const missing = new Set();
  for (const match of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/g)) {
    if (!defined.has(match[1]) && !match[2]) missing.add(match[1]);
  }
  assert.deepEqual([...missing], [], `存在未定义且无 fallback 的 CSS 变量：${[...missing].join(', ')}`);
  assert.ok(css.includes('--text-primary: var(--text)'), '应补上 --text-primary 别名（F-17）');
});

test('CSS 死选择器清理：旧壳/旧弹窗/旧表单样式不再保留（F-16）', async () => {
  const css = await readAsset('style.css');
  for (const dead of [
    '.site-header',
    '.site-nav',
    '.nav-link',
    '.container-wide',
    '.radio-item',
    '.rule-form-grid-4',
    '.rule-inline-row',
    '.admin-topbar .topbar-actions',
    '.docs-layout',
    '.doc-nav-sub',
    '.doc-subsection',
    '.doc-heading-nested',
    '.modal-user',
    '.media-preview-video',
    '.section-block',
    '.section-head ',
    '.config-subtitle',
    '.schedule-header-mask',
    '.rule-control-align',
    '.docs-topbar-actions',
  ]) {
    assert.ok(!css.includes(dead), `style.css 不应再保留死选择器：${dead}`);
  }
  // 与死规则相邻的现役规则必须保留
  for (const live of [
    '.admin-topbar-bar .topbar-actions',
    '.doc-sidebar',
    '.modal-header',
    '.badge-muted',
    '.section-head-actions',
  ]) {
    assert.ok(css.includes(live), `style.css 应保留现役规则：${live}`);
  }
});

test('CSS 断点统一：mobile <640 / tablet 640–1023 / desktop ≥1024，公共页 899/900（F-23）', async () => {
  const css = await readAsset('style.css');
  const widthQueries = [...css.matchAll(/@media\s*\(([^)]*)\)/g)]
    .map((match) => match[1].replace(/\s+/g, ' ').trim())
    .filter((query) => /width/.test(query));
  const allowed = new Set([
    'max-width: 639px',
    'max-width: 899px',
    'max-width: 1023px',
    'min-width: 640px',
    'min-width: 900px',
    'min-width: 1024px',
  ]);
  const unexpected = [...new Set(widthQueries.filter((query) => !allowed.has(query)))];
  assert.deepEqual(unexpected, [], `存在白名单外的宽度断点：${unexpected.join(', ')}`);
  for (const query of [...allowed]) {
    assert.ok(css.includes(`@media (${query})`), `断点体系应包含：@media (${query})`);
  }
  assert.ok(!/@media\s*\(max-width:\s*900px\)/.test(css), '900/899 断点应统一为 899');
  assert.ok(!/@media\s*\(min-width:\s*560px\)/.test(css), '560 断点应统一到 640');
});
