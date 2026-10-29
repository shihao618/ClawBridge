/**
 * 后端单元测试：rate-limiter（假时钟，纯内存，无网络）。
 * 覆盖令牌桶、滑动窗口、注入时钟与 key 隔离。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SlidingWindowLimiter, TokenBucketLimiter } from '../../server/src/rate-limiter.js';

test('TokenBucketLimiter: 容量内允许，超额返回等待时间（假时钟）', () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ max: 3, windowMs: 1000, now: () => now });

  assert.deepEqual(limiter.tryAcquire('u1'), { allowed: true, waitMs: 0 });
  assert.deepEqual(limiter.tryAcquire('u1'), { allowed: true, waitMs: 0 });
  assert.deepEqual(limiter.tryAcquire('u1'), { allowed: true, waitMs: 0 });

  const denied = limiter.tryAcquire('u1');
  assert.equal(denied.allowed, false);
  // 每秒回填 3 个令牌 → 补 1 个令牌约需 334ms
  assert.equal(denied.waitMs, 334);
  assert.equal(limiter.waitMsFor('u1'), 334);
});

test('TokenBucketLimiter: 时间流逝按速率回填，waitMs 不消费令牌', () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ max: 2, windowMs: 1000, now: () => now });
  limiter.tryAcquire('u');
  limiter.tryAcquire('u');
  assert.equal(limiter.tryAcquire('u').allowed, false);

  now = 250; // 回填 0.5 个令牌
  assert.equal(limiter.tryAcquire('u').allowed, false);
  // waitMsFor 不消费：连续调用结果一致
  assert.equal(limiter.waitMsFor('u'), limiter.waitMsFor('u'));

  now = 500; // 回填 1 个令牌
  assert.deepEqual(limiter.tryAcquire('u'), { allowed: true, waitMs: 0 });
  assert.equal(limiter.tryAcquire('u').allowed, false);

  now = 1000; // 回填 1 个令牌
  assert.equal(limiter.tryAcquire('u').allowed, true);
});

test('TokenBucketLimiter: 不同 key 隔离/reset/clear', () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ max: 1, windowMs: 1000, now: () => now });
  assert.equal(limiter.tryAcquire('a').allowed, true);
  assert.equal(limiter.tryAcquire('a').allowed, false);
  assert.equal(limiter.tryAcquire('b').allowed, true, '不同 key 互不影响');

  limiter.reset('a');
  assert.equal(limiter.tryAcquire('a').allowed, true, 'reset 后恢复额度');

  limiter.clear();
  assert.equal(limiter.tryAcquire('b').allowed, true, 'clear 后全部恢复');
});

test('SlidingWindowLimiter: 严格窗口计数与 retryAfterMs', () => {
  let now = 0;
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 100, now: () => now });

  assert.deepEqual(limiter.hit('ip1'), { allowed: true, remaining: 1, retryAfterMs: 0 });
  now = 50;
  assert.deepEqual(limiter.hit('ip1'), { allowed: true, remaining: 0, retryAfterMs: 0 });

  const denied = limiter.hit('ip1');
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 50, '最早一条在 t=0，窗口 100 → 还需等待 50ms');

  now = 99;
  assert.equal(limiter.hit('ip1').allowed, false, '窗口未滑动前仍拒绝');
  assert.equal(limiter.peek('ip1').allowed, false);

  now = 100; // t=0 的记录滑出窗口（<= cutoff），t=50 的仍在
  assert.deepEqual(limiter.hit('ip1'), { allowed: true, remaining: 0, retryAfterMs: 0 });
  assert.equal(limiter.hit('ip1').allowed, false, 't=50 与 t=100 占满窗口');
  assert.equal(limiter.peek('ip1').retryAfterMs, 50);

  now = 150; // t=50 的记录滑出
  assert.equal(limiter.peek('ip1').allowed, true);
  assert.equal(limiter.hit('ip1').allowed, true);
});

test('SlidingWindowLimiter: key 隔离、peek 不计数、reset', () => {
  let now = 0;
  const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 1000, now: () => now });
  assert.equal(limiter.hit('a').allowed, true);
  assert.equal(limiter.hit('b').allowed, true, '不同 key 独立计数');
  assert.equal(limiter.peek('b').allowed, false, 'peek 不消耗额度');
  limiter.reset('a');
  assert.equal(limiter.hit('a').allowed, true);
});

// ---------------------------------------------------------------------------
// 内存清理（QA minor-2）：lastUsed / 惰性 prune 防止 Map 无限增长
// ---------------------------------------------------------------------------

test('TokenBucketLimiter: pruneIdle 按 lastUsed 清理空闲 key', () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ max: 1, windowMs: 1000, now: () => now });
  for (let i = 0; i < 5; i += 1) limiter.tryAcquire(`k${i}`);
  assert.equal(limiter.size, 5);

  now = 5000;
  limiter.tryAcquire('k0'); // k0 lastUsed=5000
  now = 10000;
  // k0 空闲 5000ms（保留）；k1~k4 空闲 10000ms（清理）
  assert.equal(limiter.pruneIdle(6000), 4);
  assert.equal(limiter.size, 1);

  now = 12000;
  assert.equal(limiter.pruneIdle(6000), 1);
  assert.equal(limiter.size, 0);
});

test('TokenBucketLimiter: 访问满 256 次自动清理过期 key', () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ max: 1000, windowMs: 1000, now: () => now });
  limiter.tryAcquire('old'); // lastUsed=0
  now = 10 * 60 * 1000 + 5000; // 超过默认空闲阈值 max(window*2, 10min)
  for (let i = 0; i < 256; i += 1) limiter.tryAcquire(`new${i}`); // 第 256 次触发自动 prune
  assert.equal(limiter.buckets.has('old'), false, '自动清理应删除长期空闲 key');
  assert.equal(limiter.size, 256);
});

test('SlidingWindowLimiter: pruneExpired 清理窗口外的 key', () => {
  let now = 0;
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 100, now: () => now });
  limiter.hit('a');
  limiter.hit('b');
  limiter.hit('c');
  assert.equal(limiter.size, 3);

  now = 250; // 所有 key 的命中都早于 window 窗口
  assert.equal(limiter.pruneExpired(), 3);
  assert.equal(limiter.size, 0);

  limiter.hit('d');
  assert.equal(limiter.size, 1);
  now = 300;
  assert.equal(limiter.pruneExpired(100), 0, '窗口内仍有记录的 key 应保留');
  assert.equal(limiter.size, 1);
  now = 400;
  assert.equal(limiter.pruneExpired(100), 1);
  assert.equal(limiter.size, 0);
});

test('SlidingWindowLimiter: 访问满 256 次自动清理过期 key', () => {
  let now = 0;
  const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 1000, now: () => now });
  limiter.hit('old-ip');
  now = 60 * 1000;
  for (let i = 0; i < 256; i += 1) limiter.hit(`new-ip-${i}`);
  assert.equal(limiter.hits.has('old-ip'), false, '自动清理应删除过期 key');
});
