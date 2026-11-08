/**
 * 前端 ES Module 结构静态校验（node:test，无外部依赖）。
 *
 * admin.js 拆分为 `admin/`、`lib/` 等模块后，本测试守住模块化架构契约：
 * - 所有相对 import / 动态 import 路径必须存在（且不得引用外部 URL / 裸包名）
 * - import 图无环；admin.js 入口可达全部 admin/lib 模块（无孤儿模块）
 * - 全部 web/assets/**\/*.js 禁用 innerHTML/outerHTML/insertAdjacentHTML/eval
 * - 全部 web/assets/**\/*.js 禁用 matchMedia/innerWidth 等 JS 设备判断
 * - admin.js 是唯一入口：末尾唯一顶层 init() 调用，其后无顶层 const/let；
 *   非入口模块不得调用顶层 init()
 *
 * 独立运行：node --test tests/unit/frontend-modules.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..', '..');
const ASSETS_DIR = path.join(ROOT, 'web', 'assets');
const ENTRY = 'admin.js';
/** 页面 HTML 直接引用的入口脚本（其余模块必须被其中至少一个入口可达）。 */
const HTML_ENTRIES = ['admin.js', 'bind.js', 'docs.js'];

/** 递归列出 web/assets 下全部脚本（相对路径，POSIX 分隔符，稳定排序）。 */
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

async function readAsset(relPath) {
  return fs.readFile(path.join(ASSETS_DIR, relPath), 'utf8');
}

/** 提取源码中的模块说明符（静态 import/export-from + 动态 import）。 */
function parseModuleSpecifiers(source) {
  const specs = new Set();
  for (const match of source.matchAll(/from\s*['"]([^'"]+)['"]/g)) specs.add(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(match[1]);
  return [...specs];
}

function isRelative(spec) {
  return spec.startsWith('./') || spec.startsWith('../');
}

/** 计算相对入口的规范化模块路径；越界（../ 逃逸）返回 null。 */
function resolveSpecifier(fromRel, spec) {
  const baseDir = path.posix.dirname(fromRel);
  const resolved = path.posix.normalize(path.posix.join(baseDir, spec));
  if (resolved.startsWith('../') || path.posix.isAbsolute(resolved)) return null;
  return resolved;
}

/** 构建全量 import 图（含校验 import 路径存在性）。 */
async function buildImportGraph() {
  const files = await listAssetFiles();
  const fileSet = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const source = await readAsset(file);
    const specifiers = parseModuleSpecifiers(source);
    const deps = [];
    for (const spec of specifiers) {
      assert.ok(isRelative(spec), `${file} 的模块引用必须为同源相对路径（零外部依赖）：${spec}`);
      assert.ok(spec.endsWith('.js'), `${file} 的模块引用应带 .js 扩展名：${spec}`);
      const resolved = resolveSpecifier(file, spec);
      assert.ok(resolved, `${file} 的模块引用不得越出 web/assets：${spec}`);
      assert.ok(fileSet.has(resolved), `${file} 引用了不存在的模块：${spec} → ${resolved}`);
      deps.push(resolved);
    }
    graph.set(file, deps);
  }
  return { files, graph };
}

function findCycle(graph) {
  const state = new Map(); // 0/undefined=未访问 1=栈中 2=完成
  const stack = [];
  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      if (state.get(dep) === 1) return [...stack.slice(stack.indexOf(dep)), dep];
      if (!state.get(dep)) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
    }
    state.set(node, 2);
    stack.pop();
    return null;
  };
  for (const node of graph.keys()) {
    if (!state.get(node)) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

function collectReachable(graph, entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const node = queue.shift();
    if (seen.has(node) || !graph.has(node)) continue;
    seen.add(node);
    queue.push(...(graph.get(node) || []));
  }
  return seen;
}

test('模块 import 图：所有相对引用存在、无外部依赖、无循环依赖', async () => {
  const { files, graph } = await buildImportGraph();
  assert.ok(files.includes(ENTRY), '应有 admin.js 入口');
  const cycle = findCycle(graph);
  assert.equal(cycle, null, `模块 import 图存在循环依赖：${cycle ? cycle.join(' → ') : ''}`);
});

test('模块 import 图：HTML 入口可达全部脚本（无孤儿模块）', async () => {
  const { files, graph } = await buildImportGraph();
  for (const entry of HTML_ENTRIES) assert.ok(files.includes(entry), `应有入口脚本 ${entry}`);
  const reachable = collectReachable(graph, HTML_ENTRIES);
  const orphans = files.filter((file) => !reachable.has(file));
  assert.deepEqual(orphans, [], `以下脚本未被任何 HTML 入口模块引用：${orphans.join(', ')}`);
});

test('模块 import 图：admin.js 入口可达全部 admin/ 与 lib/ 模块', async () => {
  const { files, graph } = await buildImportGraph();
  const reachable = collectReachable(graph, [ENTRY]);
  const expectReachable = files.filter((file) => file.startsWith('admin/') || file.startsWith('lib/'));
  const unreachable = expectReachable.filter((file) => !reachable.has(file));
  assert.deepEqual(unreachable, [], `以下模块未被 admin.js 入口引用：${unreachable.join(', ')}`);
});

test('全部前端脚本禁用 innerHTML/outerHTML/insertAdjacentHTML/eval', async () => {
  const files = await listAssetFiles();
  assert.ok(files.length >= 4, 'web/assets 下至少应有 4 个脚本');
  for (const file of files) {
    const source = await readAsset(file);
    assert.doesNotMatch(source, /\.innerHTML\b/, `${file} 不允许使用 innerHTML`);
    assert.doesNotMatch(source, /\.outerHTML\b/, `${file} 不允许使用 outerHTML`);
    assert.doesNotMatch(source, /insertAdjacentHTML\s*\(/, `${file} 不允许使用 insertAdjacentHTML`);
    assert.doesNotMatch(source, /\beval\s*\(/, `${file} 不允许使用 eval`);
    assert.doesNotMatch(source, /\bnew\s+Function\s*\(/, `${file} 不允许使用 new Function`);
  }
});

test('全部前端脚本不得用 JS 判断设备/屏幕宽度（响应式只由 CSS 断点处理）', async () => {
  const pattern = /matchMedia|innerWidth|innerHeight|screen\.width|screen\.height|isMobile\b|isDesktop\b/;
  for (const file of await listAssetFiles()) {
    const source = await readAsset(file);
    assert.doesNotMatch(source, pattern, `${file} 不应在 JS 中判断设备/屏幕宽度`);
  }
});

test('admin.js 是唯一入口：末尾唯一顶层 init() 调用，其后无顶层 const/let', async () => {
  const files = await listAssetFiles();
  const entry = await readAsset(ENTRY);
  const trimmed = entry.trimEnd();
  assert.ok(trimmed.endsWith('init();'), 'admin.js 末尾应为 init(); 调用');
  const calls = entry.match(/^init\(\);$/gm) ?? [];
  assert.equal(calls.length, 1, 'admin.js 只允许一处顶层 init(); 调用');
  const afterInit = entry.slice(entry.lastIndexOf('init();'));
  assert.ok(!/^(?:const|let)\s/m.test(afterInit), 'init() 之后不应再声明顶层 const/let');
  for (const file of files) {
    // bind.js / docs.js 是各自页面的入口脚本，允许有自己的顶层 init()；
    // admin 拆分出的模块与公共模块不得再调用顶层 init()。
    if (HTML_ENTRIES.includes(file)) continue;
    const source = await readAsset(file);
    assert.equal(
      (source.match(/^init\(\);$/gm) ?? []).length,
      0,
      `${file} 不得调用顶层 init()（唯一入口为 admin.js）`,
    );
  }
});

test('admin/ 基础层不得反向 import views/（依赖方向：views → state/core/ui/lib）', async () => {
  const files = await listAssetFiles();
  const baseFiles = files.filter(
    (file) => file.startsWith('admin/') && !file.startsWith('admin/views/'),
  );
  for (const file of baseFiles) {
    const source = await readAsset(file);
    for (const spec of parseModuleSpecifiers(source)) {
      assert.ok(
        !spec.includes('/views/') && !spec.startsWith('./views/'),
        `${file} 不得 import 视图模块（依赖方向应为 views → 基础层）：${spec}`,
      );
    }
  }
});

test('admin.js 仅保留入口职责：≤600 行，除 init() 外不定义顶层函数', async () => {
  const entry = await readAsset(ENTRY);
  const lineCount = entry.split('\n').length;
  assert.ok(lineCount <= 600, `admin.js 入口应 ≤600 行（当前 ${lineCount} 行），视图逻辑应迁入 admin/views/`);
  const functionNames = [...entry.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
  assert.deepEqual(functionNames, ['init'], `admin.js 入口除 init() 外不应再定义顶层函数：${functionNames.join(', ')}`);
  assert.ok(entry.includes('registerViewLoaders('), '入口应注册各菜单视图的数据加载函数');
  assert.ok(entry.includes('registerDataLoader('), '入口应注册写操作后的按域刷新函数');
});

test('目标模块结构：基础层、视图层与 lib 纯函数模块齐全', async () => {
  const files = await listAssetFiles();
  for (const file of [
    'admin/constants.js',
    'admin/state.js',
    'admin/core.js',
    'admin/ui.js',
    'admin/templates.js',
    'lib/parse.js',
    'lib/settings.js',
    'lib/summary.js',
    'lib/media.js',
  ]) {
    assert.ok(files.includes(file), `缺少基础模块 ${file}`);
  }
  for (const view of ['overview', 'users', 'groups', 'messages', 'broadcast', 'app-rules', 'schedules', 'settings']) {
    assert.ok(files.includes(`admin/views/${view}.js`), `缺少视图模块 admin/views/${view}.js`);
  }
});

test('视图模块只依赖允许的基础层：不得 import admin.js 入口', async () => {
  const files = await listAssetFiles();
  for (const file of files.filter((name) => name.startsWith('admin/views/'))) {
    const source = await readAsset(file);
    for (const spec of parseModuleSpecifiers(source)) {
      assert.ok(
        !/(^|\/)admin\.js$/.test(spec),
        `${file} 不得 import 入口 admin.js（会形成循环）：${spec}`,
      );
    }
  }
});
