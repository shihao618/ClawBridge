/**
 * 用户域状态：用户列表（筛选/分页）、规则选择器用户缓存、用户 → 分组映射。
 *
 * 由 ../state.js 组合导出；其他模块一律通过 `state.users` /
 * `state.pickerUsers` / `state.userGroupMap` 访问。
 */

export const usersState = {
  users: { total: 0, items: [], offset: 0, q: '', status: 'all', groupId: '' },
  /** 规则表单/测试用的用户缓存（最多 500）。 */
  pickerUsers: null,
  /** userId → groups（用于消息记录/用户表格展示徽章，来自最近一次用户列表响应）。 */
  userGroupMap: new Map(),
};
