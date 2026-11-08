/**
 * 接口应用（规则列表）域状态：规则列表、启用状态筛选与页内 Tab。
 *
 * 由 ../state.js 组合导出；其他模块一律通过 `state.appRules` /
 * `state.ruleTab` 访问。
 */

export const rulesState = {
  /** 接口应用规则（docs/API_RULES.md §7）。 */
  appRules: { items: [], filter: 'all' },
  /** 接口应用页内 Tab：'rules' | 'schedule'。 */
  ruleTab: 'rules',
};
