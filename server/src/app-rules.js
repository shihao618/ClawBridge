/**
 * 接口应用 façade（app-rules.js）。
 *
 * 实现已拆分（docs/review/backend.md §3.2）：
 * - app-rules/match.js：规则行解析、scope/keyword/regex 匹配、参数提取、内置变量；
 * - app-rules/index.js：单次执行 executeRuleHttp、dry-run testRule、测试依赖注入锚点；
 * - app-rules/engine.js：RuleEngine 队列/并发/去重/运行日志、启停、日志脱敏工具。
 *
 * 通用能力仍在 shared/：http-client（SSRF/传输）、template、response、http-execute。
 * 本文件只做 re-export（含拆分前的兼容导出名），保持调用方 / 测试零改动。
 */
export { getByPath, renderReplyTemplate, renderRequestTemplate, truncate } from './shared/template.js';
export { parseResponse, previewReplyTemplate } from './shared/response.js';
export { describeFetchError, isPrivateIp, requestExternal, validateTargetUrl } from './shared/http-client.js';
export {
  buildBuiltinVars,
  extractParams,
  matchKeywords,
  matchRule,
  matchScope,
  parseRuleRow,
} from './app-rules/match.js';
export { configureDependencies, executeRuleHttp, resetDependencies, testRule } from './app-rules/index.js';
export {
  getEngineState,
  handleInboundMessage,
  redactForLog,
  redactUrlForLog,
  restart,
  start,
  stop,
  waitForIdle,
} from './app-rules/engine.js';
