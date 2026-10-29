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
    'rule-logs-panel',
    'rule-log-rule-filter',
    'rule-log-status-filter',
    'rule-log-table-body',
    'rule-log-prev',
    'rule-log-next',
    'rule-log-page-info',
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
    'env-vars',
    'security',
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
  const jsFiles = ['common.js', 'bind.js', 'admin.js', 'docs.js'];
  for (const file of jsFiles) {
    const source = await readAsset(file);
    assert.doesNotMatch(source, /\.innerHTML\b/, `${file} 不允许使用 innerHTML`);
    assert.doesNotMatch(source, /\.outerHTML\b/, `${file} 不允许使用 outerHTML`);
    if (file === 'admin.js') {
      // 规则表单中的 https://api.example.com 仅作输入框占位示例，不是资源引用
      assert.doesNotMatch(
        source,
        /fetch\(\s*['"]https?:|import\s*\(\s*['"]https?:|\.src\s*=\s*['"]https?:/,
        `${file} 不允许从外部 URL 加载资源`,
      );
    } else {
      assert.doesNotMatch(source, /https?:\/\//, `${file} 不允许引用外部 URL`);
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
  const admin = await readAsset('admin.js');
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
    '/api/v1/users',
    '/api/admin/login',
    '/api/bind/sessions',
    'Authorization: Bearer',
    'X-Api-Key',
    'RATE_LIMITED',
    'UNAVAILABLE',
    'BINDING_TTL_MS',
    'API_TOKEN',
    'ADMIN_PASSWORD',
  ]) {
    assert.ok(html.includes(token), `docs.html 应包含契约内容：${token}`);
  }
});

test('多媒体：管理后台脚本实现上传、预览与附件渲染', async () => {
  const admin = await readAsset('admin.js');
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
    assert.ok(html.includes(token), `docs.html 多媒体章节缺少：${token}`);
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
  const admin = await readAsset('admin.js');
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
  const admin = await readAsset('admin.js');
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
  const admin = await readAsset('admin.js');
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
    'formatHours',
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
    'KEEPALIVE_TICK_MS',
    'KEEPALIVE_TEXT',
    'KEEPALIVE_MAX_PER_TICK',
    'updated',
    'source',
    'opt-in',
    'keepaliveSent24h',
  ]) {
    assert.ok(contract.includes(token), `docs/KEEPALIVE.md 应描述：${token}`);
    assert.ok(html.includes(token), `docs.html 保活章节缺少：${token}`);
  }
  assert.ok(/每.*窗口最多.*一次|最多发送一次/.test(html), 'docs.html 应说明每个窗口最多发送一次');
  assert.ok(/curl -X PATCH/.test(html) && /curl -X POST/.test(html), 'docs.html 应包含保活 curl 示例');
});

test('接口应用：管理后台脚本实现规则 CRUD、表单、测试运行与日志', async () => {
  const admin = await readAsset('admin.js');
  for (const token of [
    '/api/admin/app-rules',
    '/api/admin/app-rule-logs',
    'includeDisabled=1',
    'requestBody.headers',
    'headerNames',
    'rule-headers',
    '重设 Header',
    '••••••',
    '值不会回显',
    '值已加密隐藏',
    '响应头（诊断）',
    'Header 值已加密保存（不会回显）',
    'syncHeaderModeUi',
    'scopeTypeValue',
    'extractionModeSelect',
    '不提取（直接调用接口）',
    'rule-extraction-mode',
    'openAppRuleEditor',
    'openAppRuleTestModal',
    'loadRuleLogsInline',
    'setRuleTab',
    'buildRuleTestResultNodes',
    'priority',
    'cooldownMs',
    'maxCallsPerHour',
    'maxUserCallsPerHour',
    'rule-form-section',
    'rule-picker-list',
    '/test',
  ]) {
    assert.ok(admin.includes(token), `admin.js 应包含接口应用实现：${token}`);
  }
  assert.match(admin, /\/app-rules\/\$\{encodeURIComponent/, '规则接口应使用编码后的规则 ID');
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
  // 侧栏底部链接与版本号
  assert.ok(html.includes('id="sidebar-version"'), '侧栏底部应有版本号');
  assert.match(html, /class="sidebar-link"[^>]*href="\/docs"/, '侧栏底部应有 API 文档链接');
  assert.match(html, /class="sidebar-link"[^>]*href="\/"/, '侧栏底部应有公开绑定页链接');
  assert.ok(html.includes('id="btn-sidebar-toggle"'), '应有移动端菜单按钮');
  assert.ok(html.includes('id="sidebar-overlay"'), '应有抽屉遮罩');
  assert.ok(html.includes('id="view-title"'), '顶部栏应有当前视图标题');
});

test('菜单模式：hash 路由、懒加载与移动抽屉实现', async () => {
  const admin = await readAsset('admin.js');
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
    'openDrawer',
    'closeDrawer',
    'toggleDrawer',
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
  const admin = await readAsset('admin.js');
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
    'schedule-type',
    'schedule-interval-minutes',
    'schedule-daily-time',
    'schedule-user-list',
    'schedule-group-list',
    'schedule-headers',
    'schedule-response-path',
    'schedule-reply-template',
    'schedule-fallback',
    'schedule-timeout',
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
  const html = await readPage('admin.html');
  assert.ok(html.includes('data-rule-tab="schedule"'), '接口应用页应有「定时通知」Tab');
  assert.ok(html.includes('定时通知'), '应包含「定时通知」文案');
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
    '/api/admin/scheduled-tasks/{id}/test',
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
    assert.ok(html.includes(token), `docs.html 定时通知章节缺少：${token}`);
  }
  assert.ok(/curl -X POST[^\n]*scheduled-tasks/.test(html), 'docs.html 应包含创建定时任务 curl 示例');
  assert.ok(html.includes('测试运行') && html.includes('立即执行'), 'docs.html 应说明测试运行/立即执行');
});

test('运行配置：后台可编辑设置表单（分组/保存/恢复默认/只读 env）', async () => {
  const admin = await readAsset('admin.js');
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
    'allowedHosts',
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
  const admin = await readAsset('admin.js');
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

test('运行配置：文档页与 docs/SETTINGS.md 一致', async () => {
  const [contract, html] = await Promise.all([
    fs.readFile(path.join(ROOT, 'docs', 'SETTINGS.md'), 'utf8'),
    readPage('docs.html'),
  ]);
  assert.match(html, /<section id="settings"/, 'docs.html 应有 #settings 章节');
  for (const token of [
    '/api/admin/settings',
    '/api/admin/settings/reset',
    'app_settings',
    'envOnly',
    'restartRequired',
    'allowedHosts',
    'APP_SECRET',
    'rateLimitMax',
    'rateLimitWindowMs',
    'maxAttempts',
    'retryDelaysMs',
    'apiRateLimitPerMinute',
    'maxTextLength',
    'windowMs',
    'leadMs',
    'tickMs',
    'maxPerTick',
    'maxResponseBytes',
    'workerConcurrency',
    'maxQueue',
    'timezone',
    'maxRecipients',
    'maxBytes',
    'inboundMaxBytes',
    'ttlMs',
    'maxRefreshes',
    'maxActive',
    'ipLimitPerHour',
    'verifyTimeoutMs',
    '/api/admin/security/password',
    '/api/admin/security/password/reset',
    '/api/admin/security/api-token/rotate',
    '/api/admin/security/api-token/reset',
    'publicBaseUrl',
    'trustProxy',
    'cookieSecure',
    'logLevel',
    'sessionTtlMs',
    'pushApiEnabled',
    'loginBaseUrl',
    'defaultBaseUrl',
    'cdnBaseUrl',
    'appId',
    'channelVersion',
    'botAgent',
    'botType',
    'routeTag',
    'clientVersion',
    'requestTimeoutMs',
    'qrPollTimeoutMs',
    'longPollTimeoutMs',
    'maxAccounts',
    'downloadTimeoutMs',
    'uploadTimeoutMs',
    'allowedImageMime',
    'allowedVideoMime',
    'networkErrorLimit',
    'pollGapMs',
    'adminPasswordSource',
    'apiTokenSource',
    'apiTokenPreview',
    '随机密码',
    'admin-password.txt',
    'api-token.txt',
    'scrypt',
    'AES',
    'MEDIA_DIR',
    'NODE_ENV',
  ]) {
    assert.ok(contract.includes(token), `docs/SETTINGS.md 应描述：${token}`);
    assert.ok(html.includes(token), `docs.html 运行配置章节缺少：${token}`);
  }
  assert.ok(/curl -X PATCH[^\n]*api\/admin\/settings/.test(html), 'docs.html 应包含保存运行配置 curl 示例');
});

test('文档页接口应用章节与 docs/API_RULES.md 一致', async () => {
  const [contract, html] = await Promise.all([
    fs.readFile(path.join(ROOT, 'docs', 'API_RULES.md'), 'utf8'),
    readPage('docs.html'),
  ]);
  assert.match(html, /<section id="app-rules"/, 'docs.html 应有 #app-rules 章节');
  for (const token of [
    '/api/admin/app-rules',
    '/api/admin/app-rules/{id}',
    '/api/admin/app-rules/{id}/test',
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
    'cooldown_ms',
    'max_calls_per_hour',
    "source='rule'",
    'SSRF',
  ]) {
    assert.ok(contract.includes(token), `docs/API_RULES.md 应描述：${token}`);
    assert.ok(html.includes(token), `docs.html 接口应用章节缺少：${token}`);
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
  const [admin, common] = await Promise.all([readAsset('admin.js'), readAsset('common.js')]);
  assert.match(admin, /closeOnBackdrop: false/, '规则编辑弹窗应设置 closeOnBackdrop: false');
  assert.match(common, /closeOnBackdrop = true/, 'openModal 应支持 closeOnBackdrop 选项');
  assert.match(common, /!busy && closeOnBackdrop\) close\('dismiss'\)/, '遮罩关闭需受 closeOnBackdrop 控制');
});

test('接口应用：参数提取支持多参数组合模式', async () => {
  const admin = await readAsset('admin.js');
  for (const token of ['多参数（组合提取）', 'multi-extractor-row', 'multi-extractor-list', '＋ 添加提取项', 'multiExtractors']) {
    assert.ok(admin.includes(token), `admin.js 应包含多参数提取实现：${token}`);
  }
  assert.match(admin, /extractionCfg\.extractors = extractors/, '多参数模式保存时应写入 extractors');
  assert.match(admin, /extractionCfg\.required = requiredNames/, '多参数模式应写入必填参数');
});
