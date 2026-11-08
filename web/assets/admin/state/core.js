/**
 * 管理后台核心状态：会话、当前视图、概览与运行配置缓存。
 *
 * 由 ../state.js 组合导出；其他模块一律通过 `state.xxx` 访问，
 * 拆分前后访问路径保持不变。
 */

import { DEFAULT_VIEW } from '../constants.js';

export const core = {
  authenticated: false,
  /** 当前激活视图（MENU_VIEWS.id）。 */
  view: DEFAULT_VIEW,
  overview: null,
  config: null,
  /** GET /api/admin/config 的 media 字段（maxBytes / inboundMaxBytes / allowedImage / allowedVideo / dir）。 */
  mediaLimits: null,
};
