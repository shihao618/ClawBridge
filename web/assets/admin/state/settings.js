/**
 * 运行配置域状态（后台可改设置，docs/SETTINGS.md §3/§4）。
 *
 * 由 ../state.js 组合导出；其他模块一律通过 `state.settings` 访问。
 */

export const settingsState = {
  settings: {
    available: false,
    groups: [],
    envOnly: [],
    initial: new Map(),
    draft: new Map(),
    fields: new Map(),
    /** GET /api/admin/settings 的 security 字段（来源/preview/push 开关；不含密码哈希或 Token 明文）。 */
    security: null,
  },
};
