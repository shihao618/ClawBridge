/**
 * 定时通知域状态：任务列表、已加载标记与服务端时区。
 *
 * 由 ../state.js 组合导出；其他模块一律通过 `state.scheduled` 访问。
 */

export const scheduledState = {
  /** 接口应用「定时通知」Tab：ScheduledTaskView 列表（docs/SCHEDULED_TASKS.md §5/§6）。 */
  scheduled: { items: [], loaded: false, timezone: 'Asia/Shanghai' },
};
