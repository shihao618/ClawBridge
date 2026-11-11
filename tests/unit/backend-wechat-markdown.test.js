/**
 * 微信 Markdown 兼容过滤器单测。
 *
 * 核心期望来自腾讯官方微信插件 @tencent-weixin/openclaw-weixin@2.4.10 的
 * StreamingMarkdownFilter 语义：
 * - 保留：代码块/行内代码/表格/水平线/粗体/非中文斜体/标题 H1–H4/引用/列表
 * - 处理：中文斜体去标记、H5/H6 去 #、图片整段移除
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  StreamingWechatMarkdownFilter,
  WECHAT_MARKDOWN_SUPPORT,
  describeWechatMarkdownAdjustments,
  filterWechatMarkdown,
  layoutWechatText,
} from '../../server/src/shared/wechat-markdown.js';

test('保留：代码块原样（含围栏与语言标记）', () => {
  const md = '```js\nconst a = 1; // *不是斜体*\n```';
  assert.equal(filterWechatMarkdown(md), md);
});

test('保留：行内代码、表格、水平线、粗体、非中文斜体', () => {
  const md = '`code` **bold** *italic* | a | b |\n| --- | --- |\n***';
  assert.equal(filterWechatMarkdown(md), md);
});

test('保留：标题 H1–H4、引用、有序/无序列表', () => {
  const md = '# H1\n## H2\n> quote\n1. one\n- bullet\n  - nested';
  assert.equal(filterWechatMarkdown(md), md);
});

test('中文斜体：去掉 * 标记但保留文字', () => {
  assert.equal(filterWechatMarkdown('*中文斜体*'), '中文斜体');
  assert.equal(filterWechatMarkdown('前面 *中文* 后面'), '前面 中文 后面');
});

test('中文斜体：___粗斜体___ / ***粗斜体*** 去标记', () => {
  assert.equal(filterWechatMarkdown('___中文粗斜___'), '中文粗斜');
  assert.equal(filterWechatMarkdown('***中文粗斜***'), '中文粗斜');
});

test('非中文斜体保留标记（微信会渲染英文斜体）', () => {
  assert.equal(filterWechatMarkdown('*english italic*'), '*english italic*');
  assert.equal(filterWechatMarkdown('_english italic_'), '_english italic_');
});

test('中文与英文混排的斜体：包含 CJK 即去标记（与官方一致）', () => {
  assert.equal(filterWechatMarkdown('*hello 中文*'), 'hello 中文');
});

test('H5/H6：去掉 # 前缀保留文字，H1–H4 不动', () => {
  assert.equal(filterWechatMarkdown('##### 五级标题'), '五级标题');
  assert.equal(filterWechatMarkdown('###### 六级标题'), '六级标题');
  assert.equal(filterWechatMarkdown('#### 四级标题'), '#### 四级标题');
});

test('图片：![alt](url) 整段移除（含行内混排）', () => {
  assert.equal(filterWechatMarkdown('![图](https://example.com/a.png)'), '');
  assert.equal(filterWechatMarkdown('前 ![](https://x/y.png) 后'), '前  后');
});

test('图片未闭合/非标准写法保持安全（不会吞掉后续文本）', () => {
  assert.equal(filterWechatMarkdown('![未闭合'), '![未闭合');
  assert.equal(filterWechatMarkdown('![alt] 没有链接'), '![alt] 没有链接');
});

test('行内强调跨行：中文斜体遇到换行时保留星号并恢复行首状态', () => {
  assert.equal(filterWechatMarkdown('*中文\n下一行'), '*中文\n下一行');
});

test('流式 feed/flush 与一次性过滤结果一致', () => {
  const md = '##### 标题\n*中文* **粗体** ![a](b) ```\ncode\n```\n';
  const streaming = new StreamingWechatMarkdownFilter();
  let out = '';
  for (const chunk of md.match(/[\s\S]{1,3}/g) ?? []) out += streaming.feed(chunk);
  out += streaming.flush();
  assert.equal(out, filterWechatMarkdown(md));
});

test('代码块内的 Markdown 标记不被过滤', () => {
  const md = '```\n##### 标题\n*中文*\n![a](b)\n```';
  assert.equal(filterWechatMarkdown(md), md);
});

test('调整提示：图片/H5H6/中文斜体计数', () => {
  const md = '##### 标题\n*中文*\n![a](b)\n![c](d)\n**粗体**';
  const info = describeWechatMarkdownAdjustments(md);
  assert.equal(info.images, 2);
  assert.equal(info.h5h6, 1);
  assert.equal(info.cjkItalic, 1);
});

test('普通文本与空值：原样返回', () => {
  assert.equal(filterWechatMarkdown('普通文本\n第二行'), '普通文本\n第二行');
  assert.equal(filterWechatMarkdown(''), '');
  assert.equal(filterWechatMarkdown(null), '');
});

test('换行布局：普通文本行之间补空行（微信单换行会折叠为空格）', () => {
  assert.equal(layoutWechatText('第一行\n第二行'), '第一行\n\n第二行');
  assert.equal(layoutWechatText('第一行\n第二行\n第三行'), '第一行\n\n第二行\n\n第三行');
  assert.equal(layoutWechatText('第一段\n\n第二段'), '第一段\n\n第二段');
});

test('换行布局：列表项/表格行/缩进代码块之间不插空行', () => {
  assert.equal(layoutWechatText('- a\n- b'), '- a\n- b');
  assert.equal(layoutWechatText('1. a\n2. b'), '1. a\n2. b');
  assert.equal(layoutWechatText('| a | b |\n| --- | --- |\n| c | d |'), '| a | b |\n| --- | --- |\n| c | d |');
  assert.equal(layoutWechatText('    code1\n    code2'), '    code1\n    code2');
});

test('换行布局：围栏代码块原样，代码块外文本补空行', () => {
  const md = '第一行\n```\ncode1\ncode2\n```\n第二行';
  assert.equal(layoutWechatText(md), '第一行\n\n```\ncode1\ncode2\n```\n第二行');
});

test('换行布局：列表前后普通文本补空行（列表紧跟文本不插），列表项缩进续行保持', () => {
  assert.equal(layoutWechatText('第一段\n- 列表'), '第一段\n- 列表');
  assert.equal(layoutWechatText('- 列表\n  续行'), '- 列表\n  续行');
});

test('发送文本 = 过滤（换行原样保留，不自动补空行）', () => {
  const md = '##### 小标题\n第一行\n第二行';
  assert.equal(filterWechatMarkdown(md), '小标题\n第一行\n第二行');
});

// ---------------------------------------------------------------------------
// OA-17：删除线不在 supported（官方同样过滤 `~`，仅保留文字）
// ---------------------------------------------------------------------------

test('WECHAT_MARKDOWN_SUPPORT：删除线为 filtered（官方不渲染删除线，仅保留文字）', () => {
  assert.equal(WECHAT_MARKDOWN_SUPPORT.supported.includes('删除线'), false, 'supported 不应宣称支持删除线');
  assert.ok(
    WECHAT_MARKDOWN_SUPPORT.filtered.some((item) => String(item).includes('删除线')),
    '删除线应列在 filtered',
  );
  assert.equal(filterWechatMarkdown('~~删除线~~'), '删除线', '删除线标记被移除、文字保留');
  assert.equal(filterWechatMarkdown('~a~b'), 'ab', '单独的 ~ 字符直接丢弃（与官方一致）');
});
