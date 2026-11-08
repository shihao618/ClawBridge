/**
 * ClawBridge 管理后台跨视图共享状态与壳层 DOM 缓存（按域拆分后的组合入口）。
 *
 * - state：组合 core / users / messages / groups / appRules+scheduled / settings 域状态；
 *   各域模块见 `./state/*.js`，嵌套对象保持引用共享，所有 `state.xxx` 访问路径不变。
 * - els：后台壳层与各视图关键 DOM 缓存（模块加载时一次性查询，原样转出）。
 * - openModals：当前打开的模态框集合（打开时暂停自动刷新）。
 *
 * 依赖方向：state.js → state/**（叶子模块，不得反向 import 本文件），
 * views/core/ui 只依赖 state.js，从而避免循环依赖。
 */

import { core } from './state/core.js';
import { groupsState } from './state/groups.js';
import { messagesState } from './state/messages.js';
import { rulesState } from './state/rules.js';
import { scheduledState } from './state/scheduled.js';
import { settingsState } from './state/settings.js';
import { usersState } from './state/users.js';

export { els, openModals } from './state/els.js';

/** 组合状态：域模块提供初始值/嵌套容器，浅展开后仍是同一个共享 state 对象。 */
export const state = {
  ...core,
  ...usersState,
  ...messagesState,
  ...groupsState,
  ...rulesState,
  ...scheduledState,
  ...settingsState,
};
