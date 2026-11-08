/**
 * 运行配置 façade（settings.js）。
 *
 * 实现已拆分到 settings/ 子模块（docs/review/backend.md §3.3 步骤 5 剩余项）：
 * - settings/schema.js：分组/字段元数据、CONFIG_PATHS、FIELD_BY_KEY、env 默认值快照（DEFAULTS）；
 * - settings/validate.js：字段校验（类型/范围/URL/主机名/MIME/枚举）与脱敏展示工具；
 * - settings/apply.js：loadOverrides / updateSettings / resetGroup / 运行时 hooks / 配置视图；
 * - settings/secrets.js：管理密码 scrypt 哈希与 API Token 机密（auth.js 只依赖此模块）；
 * - settings/persistence.js：内部 UPSERT / 事件工具（不对外导出）。
 *
 * 本文件只做 re-export，保持既有导出名与调用方（server 模块 / 测试）零改动。
 * 注意：schema.js 必须先于其他子模块求值，以在 loadOverrides() 之前完成 DEFAULTS 快照
 * （与拆分前 settings.js 的模块加载期行为一致）。
 */
export { getSettingsSchema } from './settings/schema.js';
export {
  getEffectiveConfig,
  getSettings,
  loadOverrides,
  resetGroup,
  setRuntimeHooks,
  updateSettings,
} from './settings/apply.js';
export {
  bootstrapSecrets,
  changeAdminPassword,
  getAdminPasswordHashRecord,
  getSecurityState,
  resetAdminPassword,
  resetApiToken,
  rotateApiToken,
} from './settings/secrets.js';
