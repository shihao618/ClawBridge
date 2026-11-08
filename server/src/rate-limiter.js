/**
 * 内存限流器（可注入时钟，便于单元测试）。
 *
 * 1) TokenBucketLimiter —— 每账号发送限流（docs/ARCHITECTURE.md §5）：
 *    容量 max、窗口 windowMs 内匀速回填 max 个令牌；返回 {allowed, waitMs}。
 * 2) SlidingWindowLimiter —— 登录失败 / API Key / 绑定创建 IP 的滑动窗口计数限流。
 *
 * 均为进程内存态（单实例部署，重启即清零），不落库。
 */

/** 令牌桶限流器。 */
export class TokenBucketLimiter {
  /**
   * @param {{max?: number, windowMs?: number, now?: () => number}} [options]
   */
  constructor({ max = 7, windowMs = 5 * 60 * 1000, now = Date.now } = {}) {
    this.max = Math.max(1, Number(max) || 1);
    this.windowMs = Math.max(1, Number(windowMs) || 1);
    this.now = typeof now === 'function' ? now : Date.now;
    /** @type {Map<string, {tokens: number, updatedAt: number, lastUsed: number}>} */
    this.buckets = new Map();
    this.opsSincePrune = 0;
  }

  /** 每秒回填速率（令牌/毫秒）。 */
  get refillPerMs() {
    return this.max / this.windowMs;
  }

  /** 当前 key 数量（测试/观测用）。 */
  get size() {
    return this.buckets.size;
  }

  /** 取出（或初始化）某 key 的桶，并按流逝时间回填令牌。 */
  #bucket(key) {
    const ts = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.max, updatedAt: ts, lastUsed: ts };
      this.buckets.set(key, bucket);
      return bucket;
    }
    bucket.lastUsed = ts;
    const elapsed = Math.max(0, ts - bucket.updatedAt);
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.max, bucket.tokens + elapsed * this.refillPerMs);
      bucket.updatedAt = ts;
    }
    return bucket;
  }

  /** 惰性清理：每 256 次访问触发一次，删除长期未使用的 key（防 Map 无限增长）。 */
  #maybePrune() {
    this.opsSincePrune += 1;
    if (this.opsSincePrune < 256) return;
    this.opsSincePrune = 0;
    this.pruneIdle();
  }

  /**
   * 清理超过 maxIdleMs 未访问的 key。
   * @returns {number} 清理的 key 数量
   */
  pruneIdle(maxIdleMs = Math.max(this.windowMs * 2, 10 * 60 * 1000)) {
    const ts = this.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (ts - bucket.lastUsed > maxIdleMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 尝试消费一个令牌。
   * @returns {{allowed: boolean, waitMs: number}} 不允许时 waitMs 为需要等待的毫秒数
   */
  tryAcquire(key) {
    const bucket = this.#bucket(key);
    this.#maybePrune();
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, waitMs: 0 };
    }
    const waitMs = Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerMs));
    return { allowed: false, waitMs };
  }

  /** 只查询还需等待多久（不消费令牌）。 */
  waitMsFor(key) {
    const bucket = this.#bucket(key);
    this.#maybePrune();
    if (bucket.tokens >= 1) return 0;
    return Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerMs));
  }

  /** 重置信令桶（如账号重新绑定后恢复额度）。 */
  reset(key) {
    this.buckets.delete(key);
  }

  clear() {
    this.buckets.clear();
  }
}

/** 滑动窗口计数限流器（严格窗口内最多 limit 次）。 */
export class SlidingWindowLimiter {
  /**
   * @param {{limit?: number, windowMs?: number, now?: () => number}} [options]
   */
  constructor({ limit = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.windowMs = Math.max(1, Number(windowMs) || 1);
    this.now = typeof now === 'function' ? now : Date.now;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
    this.opsSincePrune = 0;
  }

  /** 当前 key 数量（测试/观测用）。 */
  get size() {
    return this.hits.size;
  }

  /** 清理窗口外的历史记录。 */
  #prune(key, ts) {
    const list = this.hits.get(key);
    if (!list || list.length === 0) return [];
    const cutoff = ts - this.windowMs;
    let index = 0;
    while (index < list.length && list[index] <= cutoff) index += 1;
    if (index > 0) list.splice(0, index);
    if (list.length === 0) this.hits.delete(key);
    return list;
  }

  /** 惰性清理：每 256 次访问触发一次全表清理（防多 IP/Key 长期运行 Map 无限增长）。 */
  #maybePrune() {
    this.opsSincePrune += 1;
    if (this.opsSincePrune < 256) return;
    this.opsSincePrune = 0;
    this.pruneExpired();
  }

  /**
   * 清理窗口内已无任何有效记录的 key。
   * @returns {number} 清理的 key 数量
   */
  pruneExpired(maxAgeMs = this.windowMs) {
    const ts = this.now();
    const cutoff = ts - Math.max(1, maxAgeMs);
    let removed = 0;
    for (const [key, list] of this.hits) {
      let index = 0;
      while (index < list.length && list[index] <= cutoff) index += 1;
      if (index > 0) list.splice(0, index);
      if (list.length === 0) {
        this.hits.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 记录一次命中。
   * @returns {{allowed: boolean, remaining: number, retryAfterMs: number}}
   */
  hit(key) {
    const ts = this.now();
    this.#maybePrune();
    const list = this.#prune(key, ts);
    if (list.length >= this.limit) {
      const retryAfterMs = Math.max(1, list[0] + this.windowMs - ts);
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    list.push(ts);
    if (!this.hits.has(key)) this.hits.set(key, list);
    return { allowed: true, remaining: this.limit - list.length, retryAfterMs: 0 };
  }

  /** 只查询是否允许（不记录）。 */
  peek(key) {
    const ts = this.now();
    this.#maybePrune();
    const list = this.#prune(key, ts);
    if (list.length >= this.limit) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, list[0] + this.windowMs - ts) };
    }
    return { allowed: true, remaining: this.limit - list.length, retryAfterMs: 0 };
  }

  reset(key) {
    this.hits.delete(key);
  }

  clear() {
    this.hits.clear();
  }
}
