/**
 * RuleEngine：内存队列 + 并发 worker、去重、运行日志、失败 fallback（app-rules/engine.js）。
 *
 * 从 app-rules.js 按职责拆分；日志脱敏工具（redactForLog/redactUrlForLog）随引擎日志一起放在本模块。
 */
import { config } from '../config.js';
import { logger, redactUrlQueryForLog } from '../logger.js';
import { maxReplyLength, truncate } from '../shared/template.js';
import * as store from '../store.js';
import { beginTyping, endTyping } from '../typing.js';

import { executeRuleHttp, getRuleDependencies } from './index.js';
import { matchRule, parseRuleRow } from './match.js';

const log = logger.child({ mod: 'app-rules' });

const REDACT_KEY_RE = /(token|secret|password|api[-_]?key|authorization)/i;

// ---------------------------------------------------------------------------
// 日志脱敏
// ---------------------------------------------------------------------------

/** 日志脱敏：包含 token/secret/password/api-key/authorization 的键替换为 [redacted]。 */
export function redactForLog(value, depth = 0) {
  if (depth > 4) return '[object]';
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = REDACT_KEY_RE.test(key) ? '[redacted]' : redactForLog(val, depth + 1);
    }
    return out;
  }
  return value;
}

/** 脱敏日志中的 URL：去掉 userinfo（user:pass@）凭据，并把敏感 query 参数值替换为 [redacted]。 */
export function redactUrlForLog(rawUrl) {
  const raw = String(rawUrl ?? '');
  if (raw === '') return '';
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = '[redacted]';
      url.password = '[redacted]';
    }
    return redactUrlQueryForLog(url.toString());
  } catch {
    // 无法按绝对 URL 解析（如相对路径）：至少完成 query 脱敏
    return redactUrlQueryForLog(raw);
  }
}

/** 把参数/响应预览做脱敏并截断（写日志用）。 */
function makePreviews({ params, requestUrl, method, responsePreview }) {
  let paramsPreview = '';
  try {
    paramsPreview = truncate(JSON.stringify(redactForLog(params ?? {})), 1000);
  } catch {
    paramsPreview = '';
  }
  return {
    paramsPreview,
    requestPreview: requestUrl
      ? truncate(`${method} ${redactUrlForLog(requestUrl)}`, 500)
      : '不请求外部接口（直接回复默认文本）',
    responsePreview: truncate(responsePreview ?? '', 1000),
  };
}

// ---------------------------------------------------------------------------
// 引擎：内存队列 + 并发 worker
// ---------------------------------------------------------------------------

const engineState = {
  running: false,
  /** @type {Array<object>} */
  queue: [],
  active: 0,
  idleWaiters: [],
};

function notifyIdleIfNeeded() {
  if (engineState.active === 0 && engineState.queue.length === 0) {
    const waiters = engineState.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

/** 发送回复（入队 outbox source='rule'）。 */
function enqueueReply(userId, text) {
  if (!text || String(text).trim() === '') return null;
  const outbox = store.enqueueMessage({ userId, text: truncate(text, maxReplyLength()), source: 'rule' });
  return outbox?.id ?? null;
}

/** 把日志更新为终态（skipped/failed/success）。 */
function finalizeLog(logId, patch) {
  if (!logId) return;
  try {
    store.updateAppRuleLog(logId, patch);
  } catch (err) {
    log.warn('更新规则运行日志失败', { logId, message: err?.message });
  }
}

/** 队列 worker：处理一条入站消息（匹配 → 限制 → HTTP → 回复 → 日志）。 */
async function processInboundJob(job) {
  const { userId, inboundMessageId, text } = job;
  const now = getRuleDependencies().now();
  const user = store.getUser(userId);
  if (!user) return;
  const groupIds = store.getUserGroups(userId).map((group) => group.id);
  const ruleRows = store.listEnabledAppRuleRows();
  let matchedRow = null;
  for (const row of ruleRows) {
    const rule = parseRuleRow(row);
    if (matchRule(rule, { text, userId, groupIds })) {
      matchedRow = row;
      break; // priority ASC → 只取第一条命中的规则
    }
  }
  if (!matchedRow) return;
  const rule = parseRuleRow(matchedRow);

  // 规则自身不再做冷却/小时配额；调用频率统一由微信账号默认发送限流控制。
  // 同消息+规则仍通过日志唯一索引去重。
  const logRow = store.insertAppRuleLog({ ruleId: rule.id, userId, inboundMessageId, status: 'matched', createdAt: now });
  if (!logRow.inserted) {
    log.debug('重复入站消息触发同一规则，跳过', { ruleId: rule.id, inboundMessageId });
    return;
  }

  // 命中规则即显示微信「正在输入」（含不请求模式直接回复：发送文字/入队同样需要时间）。
  // best-effort：失败/无凭据时静默返回 null，不影响规则；生命周期覆盖 HTTP → 预览 → 回复入队 → 日志。
  const typingHandle = await beginTyping(user);
  try {
    const result = await executeRuleHttp(rule, {
      text,
      userId,
      displayName: user.displayName ?? '',
      now,
    });
    const previews = makePreviews({
      params: result.params,
      requestUrl: result.requestUrl,
      method: rule.request.method,
      responsePreview: result.responsePreview,
    });

    // 模板输出 {{noreply}}：命中规则但不回复（也不使用兜底文案）
    if (result.noreply === true) {
      finalizeLog(logRow.id, {
        status: 'success',
        httpStatus: result.httpStatus,
        latencyMs: result.latencyMs,
        error: '',
        ...previews,
        replyOutboxId: null,
      });
      log.info('规则命中，但模板要求不回复（未使用兜底文案）', {
        ruleId: rule.id,
        userId,
        httpStatus: result.httpStatus,
        credentials: result.credentialNames,
      });
      return;
    }

    if (result.error) {
      const replyOutboxId = result.replyText ? enqueueReply(userId, result.replyText) : null;
      finalizeLog(logRow.id, {
        status: 'failed',
        httpStatus: result.httpStatus,
        latencyMs: result.latencyMs,
        error: result.error,
        ...previews,
        replyOutboxId,
      });
      // 日志只记凭据名称（值只存在于 executeRuleHttp 内部，且预览/错误已脱敏）
      log.warn('规则执行失败', { ruleId: rule.id, userId, error: result.error, credentials: result.credentialNames });
      return;
    }

    const replyOutboxId = enqueueReply(userId, result.replyText);
    finalizeLog(logRow.id, {
      status: 'success',
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      error: '',
      ...previews,
      replyOutboxId,
    });
    log.info('规则执行成功并已回复', {
      ruleId: rule.id,
      userId,
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      credentials: result.credentialNames,
    });
  } finally {
    // 正常/失败/超时/异常/noreply 路径都在回复入队（或明确不回复）之后取消「正在输入」；
    // endTyping 内部对「可见时长不足 minVisibleMs」只延迟调度，不阻塞本 worker。
    await endTyping(typingHandle);
  }
}

function pump() {
  if (!engineState.running) return;
  while (engineState.active < config.appRules.workerConcurrency && engineState.queue.length > 0) {
    const job = engineState.queue.shift();
    engineState.active += 1;
    processInboundJob(job)
      .catch((err) => log.error('规则任务处理异常（忽略）', { message: err?.message, stack: err?.stack }))
      .finally(() => {
        engineState.active -= 1;
        pump();
        notifyIdleIfNeeded();
      });
  }
  notifyIdleIfNeeded();
}

/**
 * 入站消息触发规则引擎（异步队列，不阻塞 getupdates）。
 * 仅文本消息（itemTypes 含 1）且 text 非空时触发。
 */
export function handleInboundMessage({ userId, inboundMessageId, text, itemTypes = '' } = {}) {
  if (!engineState.running) return false;
  if (!userId || !inboundMessageId) return false;
  const messageText = String(text ?? '');
  if (messageText.trim() === '') return false;
  const types = String(itemTypes ?? '')
    .split(',')
    .map((type) => type.trim())
    .filter(Boolean);
  if (types.length > 0 && !types.includes('1')) return false;
  if (engineState.queue.length + engineState.active >= config.appRules.maxQueue) {
    log.warn('规则引擎队列已满，丢弃入站消息', { maxQueue: config.appRules.maxQueue });
    return false;
  }
  engineState.queue.push({ userId, inboundMessageId, text: messageText });
  pump();
  return true;
}

/** 启动引擎（幂等；APP_RULES_ENABLED=false 时不启动）。 */
export function start() {
  if (!config.appRules.enabled) {
    log.info('接口应用引擎未启用（APP_RULES_ENABLED=false）');
    return false;
  }
  if (engineState.running) return false;
  engineState.running = true;
  log.info('接口应用引擎已启动', {
    concurrency: config.appRules.workerConcurrency,
    maxQueue: config.appRules.maxQueue,
    timeoutMs: config.appRules.timeoutMs,
  });
  return true;
}

/** 停止引擎（幂等；丢弃未处理队列）。 */
export function stop() {
  const wasRunning = engineState.running;
  engineState.running = false;
  engineState.queue.length = 0;
  notifyIdleIfNeeded();
  if (wasRunning) log.info('接口应用引擎已停止');
  return wasRunning;
}

/** 重启引擎（运行配置热更新用；enabled=false 时停止）。 */
export function restart() {
  stop();
  return start();
}

/** 等待队列排空（测试/优雅退出辅助）。 */
export function waitForIdle(timeoutMs = 10000) {
  if (engineState.active === 0 && engineState.queue.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    engineState.idleWaiters.push(done);
    timer = setTimeout(() => {
      const index = engineState.idleWaiters.indexOf(done);
      if (index >= 0) engineState.idleWaiters.splice(index, 1);
      resolve(false);
    }, Math.max(100, timeoutMs));
    timer.unref?.();
  });
}

/** 引擎状态（测试/观测）。 */
export function getEngineState() {
  return {
    running: engineState.running,
    queued: engineState.queue.length,
    active: engineState.active,
  };
}
