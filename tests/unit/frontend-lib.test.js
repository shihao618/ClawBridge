/**
 * 前端 lib/ 纯函数行为单测（node:test，直接 import ES Module）。
 *
 * 覆盖从 admin.js 抽出的解析/设置/摘要/媒体路径纯函数，替代仅靠源码文本的脆弱断言。
 * 独立运行：node --test tests/unit/frontend-lib.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseKeywordsInput,
  parseHeadersInput,
  normalizeGroupColor,
  parseSettingArrayInput,
} from '../../web/assets/lib/parse.js';
import {
  settingTypeOf,
  normalizeSettingValue,
  settingsValuesEqual,
} from '../../web/assets/lib/settings.js';
import {
  RULE_SCOPE_LABELS,
  RULE_MATCH_LABELS,
  scopeSummary,
  triggerSummary,
  formatIntervalSummary,
  schedulePlanSummary,
  scheduleTargetSummary,
} from '../../web/assets/lib/summary.js';
import { safeMediaPath, attachmentPaths, toCount } from '../../web/assets/lib/media.js';

test('parseKeywordsInput：按换行/中英文逗号/分号拆分并去空白', () => {
  assert.deepEqual(parseKeywordsInput('归寝, 未归\n迟到，请假; 早退；晚归'), [
    '归寝',
    '未归',
    '迟到',
    '请假',
    '早退',
    '晚归',
  ]);
  assert.deepEqual(parseKeywordsInput('  a ,, b , '), ['a', 'b']);
  assert.deepEqual(parseKeywordsInput(''), []);
  assert.deepEqual(parseKeywordsInput(null), []);
  assert.deepEqual(parseKeywordsInput(undefined), []);
});

test('parseKeywordsInput：保留关键词内部空格', () => {
  assert.deepEqual(parseKeywordsInput('hello world, foo bar'), ['hello world', 'foo bar']);
});

test('parseHeadersInput：解析每行 Name: value，忽略空名称与无冒号行', () => {
  assert.deepEqual(
    parseHeadersInput('Authorization: Bearer token\nX-Request-Id: abc:def\n\n: empty-name\n无冒号行'),
    { Authorization: 'Bearer token', 'X-Request-Id': 'abc:def' },
  );
  assert.deepEqual(parseHeadersInput(''), {});
  assert.deepEqual(parseHeadersInput(null), {});
});

test('normalizeGroupColor：仅接受 #RRGGBB 并大写化', () => {
  assert.equal(normalizeGroupColor('#07c160'), '#07C160');
  assert.equal(normalizeGroupColor('#ABCDEF'), '#ABCDEF');
  assert.equal(normalizeGroupColor('#abc'), '');
  assert.equal(normalizeGroupColor('07C160'), '');
  assert.equal(normalizeGroupColor('red'), '');
  assert.equal(normalizeGroupColor('javascript:alert(1)'), '');
  assert.equal(normalizeGroupColor(null), '');
});

test('parseSettingArrayInput：按逗号/换行/分号拆分并去空白', () => {
  assert.deepEqual(parseSettingArrayInput('a,b\nc，d;e；f'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(parseSettingArrayInput('  10, 20 ,, '), ['10', '20']);
  assert.deepEqual(parseSettingArrayInput(''), []);
});

test('settingTypeOf：显式类型映射', () => {
  assert.equal(settingTypeOf({ type: 'boolean' }), 'boolean');
  assert.equal(settingTypeOf({ type: 'bool' }), 'boolean');
  assert.equal(settingTypeOf({ type: 'number' }), 'number');
  assert.equal(settingTypeOf({ type: 'array' }), 'array');
  assert.equal(settingTypeOf({ type: 'numberArray' }), 'array');
  assert.equal(settingTypeOf({ type: 'stringArray' }), 'array');
  assert.equal(settingTypeOf({ type: 'text' }), 'text');
  assert.equal(settingTypeOf({ type: 'enum' }), 'enum');
  assert.equal(settingTypeOf({ type: 'select' }), 'enum');
  assert.equal(settingTypeOf({ type: 'url' }), 'url');
  assert.equal(settingTypeOf({ type: 'urlString' }), 'url');
});

test('settingTypeOf：未声明类型时按当前值推断', () => {
  assert.equal(settingTypeOf({ value: true }), 'boolean');
  assert.equal(settingTypeOf({ value: 42 }), 'number');
  assert.equal(settingTypeOf({ value: ['a'] }), 'array');
  assert.equal(settingTypeOf({ value: 'x' }), 'string');
  assert.equal(settingTypeOf(null), 'string');
  assert.equal(settingTypeOf(undefined), 'string');
});

test('normalizeSettingValue：按类型归一化', () => {
  assert.equal(normalizeSettingValue(true, 'boolean'), true);
  assert.equal(normalizeSettingValue('true', 'boolean'), false);
  assert.equal(normalizeSettingValue('42', 'number'), 42);
  assert.equal(normalizeSettingValue('abc', 'number'), 'abc');
  assert.deepEqual(normalizeSettingValue('a, b', 'array'), ['a', 'b']);
  assert.deepEqual(normalizeSettingValue([1, 2], 'array'), ['1', '2']);
  assert.deepEqual(normalizeSettingValue(null, 'array'), []);
  assert.equal(normalizeSettingValue(null, 'string'), '');
  assert.equal(normalizeSettingValue(123, 'string'), '123');
});

test('settingsValuesEqual：数组按内容比较，原始值严格比较', () => {
  assert.equal(settingsValuesEqual(['a', 'b'], ['a', 'b']), true);
  assert.equal(settingsValuesEqual(['a', 'b'], ['b', 'a']), false);
  assert.equal(settingsValuesEqual([], []), true);
  assert.equal(settingsValuesEqual([], null), true);
  assert.equal(settingsValuesEqual('a', 'a'), true);
  assert.equal(settingsValuesEqual(1, '1'), false);
  assert.equal(settingsValuesEqual(true, 1), false);
});

test('scopeSummary：全部用户 / 指定用户 / 指定分组', () => {
  assert.equal(scopeSummary(null), '全部用户');
  assert.equal(scopeSummary({ type: 'all' }), '全部用户');
  assert.equal(scopeSummary({}), '全部用户');
  assert.equal(scopeSummary({ type: 'users', ids: [1, 2], names: ['张三', '李四'] }), '指定用户：张三、李四');
  assert.equal(scopeSummary({ type: 'users', ids: [1, 2] }), '指定用户（2 个）');
  assert.equal(
    scopeSummary({ type: 'groups', ids: [1, 2, 3, 4], names: ['A', 'B', 'C', 'D'] }),
    '指定分组：A、B、C 等 4 个',
  );
  assert.equal(scopeSummary({ type: 'custom' }), 'custom（0 个）');
  assert.equal(RULE_SCOPE_LABELS.groups, '指定分组');
});

test('triggerSummary：包含 / 全等 / 正则 与空值兜底', () => {
  assert.equal(triggerSummary(null), '—');
  assert.equal(triggerSummary({ matchMode: 'contains', keywords: ['归寝', '迟到'] }), '包含：归寝、迟到');
  assert.equal(triggerSummary({ matchMode: 'equals', keywords: [] }), '全等：—');
  assert.equal(triggerSummary({ matchMode: 'regex', regexPattern: '^未归.*$' }), '正则：^未归.*$');
  assert.equal(triggerSummary({ matchMode: 'regex' }), '正则：—');
  assert.equal(triggerSummary({ keywords: ['x'] }), '包含：x');
  assert.equal(RULE_MATCH_LABELS.equals, '全等');
});

test('formatIntervalSummary：分钟 / 小时 / 天 与回退', () => {
  assert.equal(formatIntervalSummary(60000), '每 1 分钟');
  assert.equal(formatIntervalSummary(30 * 60000), '每 30 分钟');
  assert.equal(formatIntervalSummary(2 * 3600000), '每 2 小时');
  assert.equal(formatIntervalSummary(47 * 3600000), '每 47 小时');
  assert.equal(formatIntervalSummary(48 * 3600000), '每 2 天');
  assert.equal(formatIntervalSummary(90 * 60000), '每 90 分钟');
  assert.equal(formatIntervalSummary(0), '每 1 分钟');
  assert.equal(formatIntervalSummary(undefined), '每 1 分钟');
});

test('schedulePlanSummary：每日定点使用任务时区，缺失回退传入时区', () => {
  assert.equal(
    schedulePlanSummary({ schedule: { type: 'daily', dailyTime: '09:30', timezone: 'Asia/Tokyo' } }, 'UTC'),
    '每天 09:30（Asia/Tokyo）',
  );
  assert.equal(schedulePlanSummary({ schedule: { type: 'daily' } }, 'UTC'), '每天 08:00（UTC）');
  assert.equal(schedulePlanSummary({ schedule: { type: 'daily' } }), '每天 08:00（Asia/Shanghai）');
});

test('schedulePlanSummary：间隔计划与生效时间段', () => {
  assert.equal(
    schedulePlanSummary({ schedule: { type: 'interval', intervalMs: 3600000 } }, 'UTC'),
    '每 1 小时',
  );
  assert.equal(
    schedulePlanSummary({ schedule: { type: 'interval', intervalMs: 3600000, windowStart: ' 08:00 ', windowEnd: '22:00' } }, 'UTC'),
    '每 1 小时（08:00–22:00）',
  );
  assert.equal(schedulePlanSummary({}, 'UTC'), '每 1 小时');
});

test('scheduleTargetSummary：全部 / 分组 / 用户', () => {
  assert.equal(scheduleTargetSummary({ targets: { type: 'all' } }), '全部用户');
  assert.equal(scheduleTargetSummary({ targets: { type: 'groups', ids: [1, 2] } }), '2 个分组');
  assert.equal(
    scheduleTargetSummary({ targets: { type: 'groups', ids: [1, 2, 3, 4], names: ['A', 'B', 'C', 'D'] } }),
    '4 个分组：A、B、C 等 4 个',
  );
  assert.equal(scheduleTargetSummary({ targets: { type: 'users', ids: [1, 2, 3] } }), '3 位用户');
  assert.equal(scheduleTargetSummary(null), '0 位用户');
});

test('safeMediaPath：只放行同源 /api/ 路径', () => {
  assert.equal(safeMediaPath('/api/admin/media/a1b2'), '/api/admin/media/a1b2');
  assert.equal(safeMediaPath('/api/admin/media/a1b2/download'), '/api/admin/media/a1b2/download');
  assert.equal(safeMediaPath('https://evil.example.com/x'), null);
  assert.equal(safeMediaPath('javascript:alert(1)'), null);
  assert.equal(safeMediaPath('//evil.example.com/x'), null);
  assert.equal(safeMediaPath(''), null);
  assert.equal(safeMediaPath(null), null);
});

test('attachmentPaths：url/downloadUrl 字段兼容与 id 兜底', () => {
  assert.deepEqual(attachmentPaths({ id: 'm1', url: '/api/admin/media/m1' }), {
    url: '/api/admin/media/m1',
    downloadUrl: '/api/admin/media/m1?download=1',
  });
  assert.deepEqual(
    attachmentPaths({ id: 'm1', url: '/api/admin/media/m1?x=1', downloadUrl: '/api/admin/media/m1/download' }),
    { url: '/api/admin/media/m1?x=1', downloadUrl: '/api/admin/media/m1/download' },
  );
  assert.deepEqual(attachmentPaths({ id: 'm 2' }), {
    url: '/api/admin/media/m%202',
    downloadUrl: '/api/admin/media/m%202?download=1',
  });
  assert.deepEqual(attachmentPaths({ url: 'javascript:alert(1)' }), { url: null, downloadUrl: null });
  assert.deepEqual(attachmentPaths({}), { url: null, downloadUrl: null });
});

test('toCount：非负计数归一化', () => {
  assert.equal(toCount(0), 0);
  assert.equal(toCount('12'), 12);
  assert.equal(toCount(3.7), 3.7);
  assert.equal(toCount(-1), 0);
  assert.equal(toCount('abc'), 0);
  assert.equal(toCount(null), 0);
  assert.equal(toCount(undefined), 0);
  assert.equal(toCount(Infinity), 0);
});
