/**
 * 消息记录域状态：方向 Tab、分组筛选与分页。
 *
 * 由 ../state.js 组合导出；其他模块一律通过 `state.messages` 访问。
 */

export const messagesState = {
  messages: { total: 0, items: [], offset: 0, direction: 'inbound', groupId: '' },
};
