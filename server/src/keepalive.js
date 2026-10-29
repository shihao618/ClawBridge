/**
 * 24h 会话保活调度（docs/KEEPALIVE.md）。
 *
 * 背景：微信 ClawBot 存在会话窗口限制——用户最后一次主动发消息后约 24h 内 bot 才能
 * 可靠下发消息。本模块对开启了 keepalive 的用户，在"最后一条入站消息即将满窗口"时
 * 自动入队一条保活提醒（source='keepalive'），提示用户回复以刷新窗口。
 *
 * 规则：
 *  - 按用户 opt-in（默认关闭）；全局 config.keepalive.enabled=false 时完全不扫描；
 *  - 只在窗口仍有效时发送（提前 leadMs 触发，窗口过期不发送）；
 *  - 每个会话窗口最多发送一次（keepalive_last_sent_at < last_inbound_at 才可再次触发）；
 *  - 走现有 outbox 队列（限流/-2/-14 复用），不新增发送通道。
 */
import { config } from './config.js';
import { transaction } from './db.js';
import { logger } from './logger.js';
import * as store from './store.js';

const log = logger.child({ mod: 'keepalive' });

let running = false;
/** @type {NodeJS.Timeout|null} */
let timer = null;
let scanning = false;

/** 渲染保活文本模板：支持 `{name}`（用户昵称）占位。 */
export function renderKeepaliveText(template, { displayName = '' } = {}) {
  return String(template ?? '').replace(/\{name\}/g, String(displayName ?? ''));
}

/**
 * 执行一次扫描（可注入 now / 依赖，便于单测假时钟）。
 * @param {number} [now] 假时钟毫秒时间戳
 * @param {{windowMs?:number, leadMs?:number, limit?:number, text?:string,
 *          enqueueMessage?:Function, enabled?:boolean}} [options]
 * @returns {Promise<number>} 本次成功入队的保活消息数
 */
export async function scan(now = Date.now(), options = {}) {
  const enabled = options.enabled === undefined ? config.keepalive.enabled : Boolean(options.enabled);
  if (!enabled) return 0;
  const windowMs = options.windowMs ?? config.keepalive.windowMs;
  const leadMs = options.leadMs ?? config.keepalive.leadMs;
  const limit = options.limit ?? config.keepalive.maxPerTick;
  const template = options.text ?? config.keepalive.text;
  const enqueueMessage = options.enqueueMessage ?? store.enqueueMessage;

  const candidates = store.getKeepaliveCandidates(now, { windowMs, leadMs, limit });
  let sent = 0;
  for (const user of candidates) {
    try {
      const remainingMs = Math.max(0, windowMs - (Number(now) - Number(user.last_inbound_at ?? 0)));
      // 渲染模板并限制在单条文本上限内（超长模板/昵称时避免被微信侧拒绝）
      const text = renderKeepaliveText(template, { displayName: user.display_name }).slice(0, config.push.maxTextLength);
      // 事务：入队 + 记录 last_sent + 事件，保证"同窗口只发一次"原子性
      transaction(() => {
        enqueueMessage({ userId: user.id, text, source: 'keepalive' });
        store.setKeepaliveLastSentAt(user.id, now);
        store.addEvent({ type: 'keepalive', userId: user.id, detail: `remainingMs=${remainingMs}` });
      });
      sent += 1;
      log.info('保活消息已入队', { userId: user.id, remainingMs });
    } catch (err) {
      // 单用户失败不影响其他用户；last_sent 未写入 → 下个 tick 自动重试
      log.warn('保活消息入队失败（下个 tick 重试）', { userId: user.id, message: err?.message });
    }
  }
  return sent;
}

/** 单次 tick：重入保护 + 异常不外抛（调度不崩）。 */
async function tick() {
  if (!running || scanning) return;
  scanning = true;
  try {
    await scan(Date.now());
  } catch (err) {
    log.error('保活调度扫描异常（忽略，继续运行）', { message: err?.message, stack: err?.stack });
  } finally {
    scanning = false;
  }
}

/**
 * 启动调度（幂等）。全局关闭时返回 false 且不创建定时器。
 * @returns {boolean} 是否真正启动
 */
export function start() {
  if (!config.keepalive.enabled) {
    log.info('保活调度未启用（KEEPALIVE_ENABLED=false），不启动');
    return false;
  }
  if (running) return false;
  running = true;
  timer = setInterval(() => {
    void tick();
  }, config.keepalive.tickMs);
  timer.unref?.();
  log.info('保活调度已启动', {
    tickMs: config.keepalive.tickMs,
    windowMs: config.keepalive.windowMs,
    leadMs: config.keepalive.leadMs,
    maxPerTick: config.keepalive.maxPerTick,
  });
  return true;
}

/** 停止调度（幂等，进程退出前调用）。 */
export function stop() {
  const wasRunning = running;
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (wasRunning) log.info('保活调度已停止');
  return wasRunning;
}

/** 调度是否在运行。 */
export function isRunning() {
  return running;
}

/** 重启调度（运行配置热更新用；enabled=false 时停止）。 */
export function restart() {
  stop();
  return start();
}
