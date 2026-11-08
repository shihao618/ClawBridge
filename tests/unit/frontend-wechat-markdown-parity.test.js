/**
 * 微信 Markdown 过滤器一致性测试：服务端（发送前过滤）与前端（预览前过滤）
 * 必须对同一输入产生相同结果，否则会出现"预览与发送不一致"。
 *
 * 两侧实现保持逐字符状态机相同；本测试用固定样例 + 组合样例做逐字节比对。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeWechatMarkdownAdjustments as serverAdjustments,
  filterWechatMarkdown as serverFilter,
  layoutWechatText as serverLayout,
} from '../../server/src/shared/wechat-markdown.js';
import {
  describeWechatMarkdownAdjustments as webAdjustments,
  filterWechatMarkdown as webFilter,
  layoutWechatText as webLayout,
} from '../../web/assets/lib/wechat-markdown.js';

const FIXTURES = [
  '',
  '普通文本\n第二行',
  '# 标题\n## 标题2\n#### 标题4',
  '##### 五级\n###### 六级',
  '**粗体** *italic* ~~删除~~ `code`',
  '*中文斜体* **中文粗体** ***中文粗斜*** ___中文粗斜___',
  '![图](https://example.com/a.png)\n前 ![](https://x/y.png) 后',
  '```js\nconst a = 1; // *不是斜体*\n```',
  '> 引用\n> 第二行\n- 列表\n  - 嵌套\n1. 有序',
  '| 列1 | 列2 |\n| --- | --- |\n| a | b |',
  '---\n***\n___',
  '混合：*中文* 与 *english*，`*code*`，![a](b)，##### 小标题',
  '未闭合 *中文\n下一行',
  '链接 [文字](https://example.com) 与裸 URL https://gps.example.com/',
  '\\*转义\\* 与 *中文斜体*',
  '**a**__b__***c***___d___',
];

test('服务端与前端过滤器：全部固定样例逐字节一致', () => {
  for (const fixture of FIXTURES) {
    assert.equal(
      webFilter(fixture),
      serverFilter(fixture),
      `过滤器结果不一致，输入：${JSON.stringify(fixture)}`,
    );
  }
});

test('服务端与前端调整提示：计数一致', () => {
  for (const fixture of FIXTURES) {
    assert.deepEqual(webAdjustments(fixture), serverAdjustments(fixture), `调整提示不一致：${fixture}`);
  }
});

test('服务端与前端布局：全部固定样例逐字节一致', () => {
  for (const fixture of FIXTURES) {
    assert.equal(
      webLayout(fixture),
      serverLayout(fixture),
      `换行布局结果不一致，输入：${JSON.stringify(fixture)}`,
    );
    assert.equal(webLayout(webFilter(fixture)), serverLayout(serverFilter(fixture)), '过滤+布局组合不一致');
  }
});

test('服务端与前端过滤器：随机组合样例一致', () => {
  const parts = ['*中文*', '*en*', '**粗**', '##### 标题', '![a](b)', '`code`', '```\nfence\n```', '普通', '\n', ' ', '> ', '- ', '1. ', '_中_', '***中***'];
  let seed = 20261108;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 200; round += 1) {
    const count = 1 + Math.floor(random() * 6);
    let text = '';
    for (let index = 0; index < count; index += 1) text += parts[Math.floor(random() * parts.length)];
    assert.equal(webFilter(text), serverFilter(text), `随机样例不一致：${JSON.stringify(text)}`);
    assert.equal(webLayout(text), serverLayout(text), `随机布局不一致：${JSON.stringify(text)}`);
  }
});
