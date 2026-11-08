/**
 * 数据访问层 façade（store.js）。
 *
 * 实现已按域拆分到 ./data/*（docs/review/backend.md §3.3 步骤 3）：本文件只做 `export *`
 * 重导出，保持既有导出名与调用方（server 模块 / 测试）零改动。
 *
 * 拆分后各域模块：
 *   users.js / groups.js / keepalive.js / rules.js / scheduled.js / attachments.js /
 *   outbox.js / inbound.js / messages.js / events.js / stats.js
 *   + mappers.js（纯行→视图映射，供各域复用）/ helpers.js（内部工具，不对外导出）。
 */
export * from './data/attachments.js';
export * from './data/events.js';
export * from './data/groups.js';
export * from './data/inbound.js';
export * from './data/keepalive.js';
export * from './data/mappers.js';
export * from './data/messages.js';
export * from './data/outbox.js';
export * from './data/rules.js';
export * from './data/scheduled.js';
export * from './data/stats.js';
export * from './data/users.js';
