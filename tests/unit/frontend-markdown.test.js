/**
 * Markdown 预览渲染器单测（最小 DOM stub，node:test，无外部依赖）。
 *
 * 覆盖 CommonMark 常用子集：标题/粗斜体/删除线/行内代码/链接/图片/自动链接/转义、
 * 有序与无序列表（含 loose list、缩进嵌套、列表项续行）、缩进与围栏代码块、
 * 多行引用（含嵌套列表）、表格（对齐/转义）、段落硬换行与空模板占位。
 * 重点回归：有序列表编号连续（不能每项都是 1）、嵌套列表不能拍平、缩进不能丢失。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

class FakeNode {
  constructor(tagName) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.children = [];
    this._ownText = '';
    this.attributes = new Map();
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.parentNode = null;
  }

  append(...nodes) {
    for (const node of nodes.flat(Infinity)) {
      if (node === undefined || node === null || node === false) continue;
      if (typeof node === 'string') this.children.push(node);
      else {
        node.parentNode = this;
        this.children.push(node);
      }
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  addEventListener() {}
  removeEventListener() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  remove() {}

  set textContent(value) {
    this._ownText = String(value);
    this.children = [];
  }

  get textContent() {
    return (
      this._ownText +
      this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('')
    );
  }

  get childElementCount() {
    return this.children.filter((child) => typeof child !== 'string').length;
  }
}

const fakeDocument = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => String(text),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  body: new FakeNode('body'),
  documentElement: new FakeNode('html'),
};

globalThis.document = fakeDocument;
globalThis.Node = FakeNode;
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { renderMarkdownPreview } = await import('../../web/assets/admin/markdown-preview.js');

/** 递归收集指定标签的元素（按文档顺序）。 */
function findAll(node, tag) {
  const found = [];
  const walk = (current) => {
    if (typeof current === 'string' || !current) return;
    if (current.tagName === tag) found.push(current);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return found;
}

/** 直接子元素（跳过文本节点）。 */
function elementChildren(node) {
  return node.children.filter((child) => typeof child !== 'string');
}

const blockTags = (root) => root.children.map((child) => (typeof child === 'string' ? '#text' : child.tagName));

/* ---------------------------- 基础块级 ---------------------------- */

test('标题：H1–H4 正常渲染；微信不渲染的 H5/H6 过滤为普通文本', () => {
  const root = renderMarkdownPreview('# 一级 #\n\n### 三级\n\n###### 六级');
  assert.deepEqual(blockTags(root).slice(0, 2), ['H1', 'H3']);
  assert.equal(findAll(root, 'H1')[0].textContent, '一级');
  const all = root.textContent;
  assert.ok(all.includes('六级'), 'H6 文本应保留');
  assert.ok(!all.includes('######'), 'H6 的 # 标记应被微信规则过滤');
});

test('分隔线：--- / *** / ___', () => {
  const root = renderMarkdownPreview('---\n\n***\n\n___');
  assert.equal(findAll(root, 'HR').length, 3);
});

test('段落：普通两行按微信换行规则渲染为两个段落（单换行会被微信折叠，故补空行）', () => {
  const root = renderMarkdownPreview('第一行\n第二行');
  const paragraphs = findAll(root, 'P');
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].textContent, '第一行');
  assert.equal(paragraphs[1].textContent, '第二行');
  assert.equal(findAll(root, 'BR').length, 0);
});

test('空模板显示占位文案', () => {
  const root = renderMarkdownPreview('');
  assert.equal(findAll(root, 'P')[0].textContent, '（模板为空）');
});

/* ---------------------------- 列表 ---------------------------- */

test('有序列表：连续编号合并为一个 ol（1,2,3 连续）', () => {
  const root = renderMarkdownPreview('1. 第一\n2. 第二\n3. 第三');
  const lists = findAll(root, 'OL');
  assert.equal(lists.length, 1);
  const items = elementChildren(lists[0]);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((li) => li.textContent), ['第一', '第二', '第三']);
});

test('有序列表回归：列表项之间有空行（loose list）仍合并为一个 ol，不重新从 1 开始', () => {
  const root = renderMarkdownPreview('1. 第一\n\n2. 第二\n\n3. 第三');
  const lists = findAll(root, 'OL');
  assert.equal(lists.length, 1, 'loose list 不应被拆成多个 <ol>');
  assert.equal(elementChildren(lists[0]).length, 3);
  assert.deepEqual(blockTags(root), ['OL']);
});

test('有序列表：源文本各行都写 1.（CommonMark 写法）仍按浏览器顺序编号', () => {
  const root = renderMarkdownPreview('1. A\n1. B\n1. C');
  const lists = findAll(root, 'OL');
  assert.equal(lists.length, 1);
  assert.equal(elementChildren(lists[0]).length, 3);
});

test('有序列表：首项编号 != 1 时输出 start 属性（3,4,5）', () => {
  const root = renderMarkdownPreview('3. 第三\n4. 第四');
  const ol = findAll(root, 'OL')[0];
  assert.equal(ol.getAttribute('start'), '3');
  assert.equal(elementChildren(ol).length, 2);
});

test('有序列表：支持 1) 括号写法', () => {
  const root = renderMarkdownPreview('1) A\n2) B');
  const lists = findAll(root, 'OL');
  assert.equal(lists.length, 1);
  assert.equal(elementChildren(lists[0]).length, 2);
});

test('无序列表：- * + 混用与 loose list 合并', () => {
  const root = renderMarkdownPreview('- A\n\n* B\n\n+ C');
  const lists = findAll(root, 'UL');
  assert.equal(lists.length, 1);
  assert.equal(elementChildren(lists[0]).length, 3);
});

test('嵌套无序列表：缩进 2 空格生成子列表，不被拍平', () => {
  const root = renderMarkdownPreview('* A\n  * A1\n  * A2\n* B');
  const outer = findAll(root, 'UL')[0];
  const outerItems = elementChildren(outer);
  assert.equal(outerItems.length, 2, '顶层应只有 2 项');
  const nested = findAll(outerItems[0], 'UL')[0];
  assert.ok(nested, '第一项下应有嵌套 UL');
  assert.equal(elementChildren(nested).length, 2);
});

test('嵌套有序列表：缩进 3 空格生成子列表', () => {
  const root = renderMarkdownPreview('1. one\n   1. one-one\n   2. one-two\n2. two');
  const outer = findAll(root, 'OL')[0];
  const outerItems = elementChildren(outer);
  assert.equal(outerItems.length, 2);
  const nested = findAll(outerItems[0], 'OL')[0];
  assert.ok(nested, '第一项下应有嵌套 OL');
  assert.equal(elementChildren(nested).length, 2);
});

test('多层混合嵌套：ul → ol → ul 三层', () => {
  const md = '- a\n  - b\n    1. c\n       - d\n- e';
  const root = renderMarkdownPreview(md);
  const ul1 = findAll(root, 'UL')[0];
  const ul2 = findAll(ul1, 'UL')[0];
  const ol1 = findAll(ul2, 'OL')[0];
  const ul3 = findAll(ol1, 'UL')[0];
  assert.ok(ul1 && ul2 && ol1 && ul3, '应存在三层嵌套结构');
});

test('列表项续行：缩进的第二行仍属于同一 li（不拆成段落）', () => {
  const root = renderMarkdownPreview('- 第一行\n  第二行\n- 下一项');
  const ul = findAll(root, 'UL')[0];
  const items = elementChildren(ul);
  assert.equal(items.length, 2);
  assert.ok(items[0].textContent.includes('第一行'));
  assert.ok(items[0].textContent.includes('第二行'));
});

test('tight list：列表项内不额外包 <p>', () => {
  const root = renderMarkdownPreview('- A\n- B');
  assert.equal(findAll(root, 'P').length, 0);
  assert.equal(findAll(root, 'LI').length, 2);
});

test('列表项内支持行内格式与嵌套列表混排', () => {
  const root = renderMarkdownPreview('- **粗**与[链接](https://x)\n  - 子项');
  const li = findAll(root, 'LI')[0];
  assert.ok(findAll(li, 'STRONG').length >= 1);
  assert.ok(findAll(li, 'SPAN').some((node) => node.className === 'markdown-link'));
  assert.ok(findAll(li, 'UL').length >= 1);
});

/* ---------------------------- 代码 ---------------------------- */

test('围栏代码块：保留语言并创建 pre/code', () => {
  const root = renderMarkdownPreview('```js\nconst a = 1;\nconsole.log(a);\n```');
  const pre = findAll(root, 'PRE')[0];
  const code = findAll(pre, 'CODE')[0];
  assert.equal(code.className, 'language-js');
  assert.equal(code.textContent, 'const a = 1;\nconsole.log(a);');
});

test('围栏代码块：~~~ 语法与未闭合围栏', () => {
  const root = renderMarkdownPreview('~~~\nline1\n~~~');
  assert.equal(findAll(root, 'PRE')[0].textContent, 'line1');
});

test('缩进代码块（4 空格）', () => {
  const root = renderMarkdownPreview('    const x = 1;\n    const y = 2;');
  const pre = findAll(root, 'PRE')[0];
  assert.ok(pre);
  assert.equal(findAll(pre, 'CODE')[0].textContent, 'const x = 1;\nconst y = 2;');
});

test('列表项内的缩进代码块（内容缩进 + 4 空格）', () => {
  const root = renderMarkdownPreview('- 说明\n\n      const x = 1;');
  const li = findAll(root, 'LI')[0];
  assert.ok(findAll(li, 'PRE').length === 1, '列表项内应渲染代码块');
});

/* ---------------------------- 引用 ---------------------------- */

test('引用：多行合并为单个 blockquote', () => {
  const root = renderMarkdownPreview('> 第一行\n> 第二行\n\n普通段落');
  const quotes = findAll(root, 'BLOCKQUOTE');
  assert.equal(quotes.length, 1);
  assert.ok(quotes[0].textContent.includes('第一行'));
  assert.ok(quotes[0].textContent.includes('第二行'));
});

test('引用内嵌套列表', () => {
  const root = renderMarkdownPreview('> - a\n>   - b\n> - c');
  const quote = findAll(root, 'BLOCKQUOTE')[0];
  const ul = findAll(quote, 'UL')[0];
  assert.ok(ul);
  assert.ok(findAll(ul, 'UL').length >= 1, '引用内应有嵌套列表');
});

/* ---------------------------- 表格 ---------------------------- */

test('表格：对齐方式与行内格式', () => {
  const root = renderMarkdownPreview('| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| **a** | b | c |');
  const table = findAll(root, 'TABLE')[0];
  const ths = findAll(table, 'TH');
  assert.equal(ths.length, 3);
  assert.equal(ths[0].style.textAlign, 'left');
  assert.equal(ths[1].style.textAlign, 'center');
  assert.equal(ths[2].style.textAlign, 'right');
  assert.equal(findAll(table, 'STRONG')[0].textContent, 'a');
});

test('表格：单元格内转义竖线', () => {
  const root = renderMarkdownPreview('| 列 |\n| --- |\n| a \\| b |');
  const td = findAll(root, 'TD')[0];
  assert.equal(td.textContent, 'a | b');
});

/* ---------------------------- 行内 ---------------------------- */

test('行内：粗体/英文斜体/删除线/行内代码；中文斜体按微信规则去标记', () => {
  const root = renderMarkdownPreview('**粗体** 与 *italic* 与 ~~删除~~ 与 `code` 与 *中文斜体*');
  assert.equal(findAll(root, 'STRONG')[0].textContent, '粗体');
  assert.equal(findAll(root, 'EM')[0].textContent, 'italic');
  assert.equal(findAll(root, 'EM').length, 1, '中文内容不渲染斜体，不应生成 EM');
  assert.equal(findAll(root, 'S')[0].textContent, '删除');
  assert.equal(findAll(root, 'CODE')[0].textContent, 'code');
  assert.ok(findAll(root, 'P')[0].textContent.includes('中文斜体'));
  assert.ok(!findAll(root, 'P')[0].textContent.includes('*中文斜体*'));
});

test('行内：__粗__ 与 _英文斜体_ 写法，snake_case 不误判斜体', () => {
  const root = renderMarkdownPreview('__bold__ _italic_ snake_case');
  assert.equal(findAll(root, 'STRONG')[0].textContent, 'bold');
  assert.equal(findAll(root, 'EM')[0].textContent, 'italic');
  assert.equal(findAll(root, 'EM').length, 1);
  assert.ok(findAll(root, 'P')[0].textContent.includes('snake_case'));
});

test('行内：链接按文字显示（不生成可点击 href）', () => {
  const root = renderMarkdownPreview('[链接文字](https://example.com)');
  const span = findAll(root, 'SPAN').find((node) => node.className === 'markdown-link');
  assert.ok(span);
  assert.equal(span.textContent, '链接文字');
  assert.equal(span.getAttribute('title'), 'https://example.com');
  assert.equal(findAll(root, 'A').length, 0);
});

test('图片：微信不渲染，预览按过滤规则整段移除', () => {
  const root = renderMarkdownPreview('前 ![示例图](https://example.com/a.png) 后');
  assert.equal(findAll(root, 'IMG').length, 0);
  const text = root.textContent;
  assert.ok(!text.includes('示例图'), '图片应被微信规则移除');
  assert.ok(text.includes('前') && text.includes('后'));
});

test('裸 URL：微信会自动识别为链接，预览按链接样式显示', () => {
  const root = renderMarkdownPreview('获取定位： https://gps.example.com/ 结束');
  const span = findAll(root, 'SPAN').find((node) => node.className === 'markdown-link');
  assert.ok(span, '裸 URL 应渲染为链接样式');
  assert.equal(span.textContent, 'https://gps.example.com/');
});

test('行内：尖括号 URL 按原文显示（微信不自动转链接）+ 反斜杠转义', () => {
  const root = renderMarkdownPreview('<https://example.com> 与 \\*not italic\\*');
  const p = findAll(root, 'P')[0];
  assert.ok(p.textContent.includes('<https://example.com>'), '尖括号 URL 应保留原文与尖括号');
  assert.equal(findAll(root, 'SPAN').length, 0, '不应把尖括号 URL 转成链接节点');
  assert.ok(p.textContent.includes('*not italic*'));
  assert.equal(findAll(root, 'EM').length, 0);
});

test('安全：HTML 标签按纯文本显示，不产生可执行节点', () => {
  const root = renderMarkdownPreview('<img src=x onerror=alert(1)> <script>alert(2)</script>');
  assert.equal(findAll(root, 'IMG').length, 0);
  assert.equal(findAll(root, 'SCRIPT').length, 0);
  const text = findAll(root, 'P')[0].textContent;
  assert.ok(text.includes('<img'));
  assert.ok(text.includes('<script>'));
});

test('安全：链接 title 仅作为属性文本，textContent 不受影响', () => {
  const root = renderMarkdownPreview('[x](javascript:alert(1))');
  const span = findAll(root, 'SPAN').find((node) => node.className === 'markdown-link');
  assert.equal(span.textContent, 'x');
  assert.equal(findAll(root, 'A').length, 0);
});
