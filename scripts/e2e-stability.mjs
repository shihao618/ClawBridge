#!/usr/bin/env node
/**
 * e2e 稳定性脚本：串行运行 tests/e2e 多次并汇总结果（默认 3 次）。
 *
 * 目的（INF-07）：e2e 曾依赖固定 sleep/端口探测，存在偶发时序失败风险。本脚本用固定
 * `--test-concurrency` 串行重复跑整批 e2e，任何一次失败/超时/用例数异常都会以非 0 退出，
 * 可直接用于 CI 冒烟与本地回归。
 *
 * 用法：
 *   node scripts/e2e-stability.mjs                 # 3 次，--test-concurrency=1
 *   node scripts/e2e-stability.mjs --runs=5        # 5 次
 *   node scripts/e2e-stability.mjs --concurrency=2 # 覆盖并发（默认 1=最稳，串行文件级）
 *   node scripts/e2e-stability.mjs --timeout-ms=600000
 * 退出码：全部通过 0；任一次失败/超时/结果为 0 用例 1。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E_GLOBS = ['tests/e2e/**/*.test.js', 'tests/e2e/**/*.test.mjs'];

/** 解析 --key=value / --key value / --flag 形式参数。 */
function parseArgs(argv) {
  const options = { runs: 3, concurrency: 1, timeoutMs: 600000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    const [rawKey, rawValue] = arg.slice(2).split('=');
    const nextValue = rawValue ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : undefined);
    const intValue = (name) => {
      const value = Number.parseInt(nextValue ?? '', 10);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} 需要正整数，实际=${nextValue}`);
      return value;
    };
    if (rawKey === 'runs') options.runs = intValue('runs');
    else if (rawKey === 'concurrency') options.concurrency = intValue('concurrency');
    else if (rawKey === 'timeout-ms') options.timeoutMs = intValue('timeout-ms');
    else if (rawKey === 'help' || rawKey === 'h') {
      console.log('用法：node scripts/e2e-stability.mjs [--runs=3] [--concurrency=1] [--timeout-ms=600000]');
      process.exit(0);
    } else throw new Error(`未知参数：--${rawKey}`);
  }
  return options;
}

/** 从 node --test 输出中提取用例统计（spec reporter 的 ℹ tests/pass/fail/duration_ms 行）。 */
function parseStats(stdout) {
  const pick = (label) => {
    const match = new RegExp(`ℹ ${label} (\\d+)`).exec(stdout);
    return match ? Number(match[1]) : null;
  };
  const durationMatch = /ℹ duration_ms ([\d.]+)/.exec(stdout);
  return {
    tests: pick('tests'),
    pass: pick('pass'),
    fail: pick('fail'),
    skipped: pick('skipped'),
    durationMs: durationMatch ? Number(durationMatch[1]) : null,
  };
}

const options = parseArgs(process.argv.slice(2));
const results = [];
const totalStart = Date.now();

console.log(
  `e2e 稳定性：串行运行 ${options.runs} 次，--test-concurrency=${options.concurrency}，单次超时 ${options.timeoutMs}ms`,
);

for (let run = 1; run <= options.runs; run += 1) {
  console.log(`\n===== e2e stability run ${run}/${options.runs} =====`);
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=spec', `--test-concurrency=${options.concurrency}`, ...E2E_GLOBS],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
  );
  const wallMs = Date.now() - startedAt;
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const stats = parseStats(`${stdout}\n${stderr}`);
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const ok = result.status === 0 && !result.error && (stats.tests ?? 0) > 0 && (stats.fail ?? 0) === 0;
  results.push({ run, ok, timedOut, status: result.status, signal: result.signal, wallMs, error: result.error?.message ?? '', ...stats });
  console.log(
    `----- run ${run}/${options.runs}: ${ok ? 'PASS' : 'FAIL'} ` +
      `(tests=${stats.tests ?? '?'}, pass=${stats.pass ?? '?'}, fail=${stats.fail ?? '?'}, ` +
      `skipped=${stats.skipped ?? '?'}, node-ms=${stats.durationMs ?? '?'}, wall=${wallMs}ms) -----`,
  );
}

const totalMs = Date.now() - totalStart;
const failedRuns = results.filter((item) => !item.ok).length;
const slowest = results.reduce((max, item) => Math.max(max, item.wallMs), 0);

console.log('\n================ e2e stability summary ================');
for (const item of results) {
  console.log(
    `run ${item.run}: ${item.ok ? 'PASS' : 'FAIL'} tests=${item.tests ?? '?'} pass=${item.pass ?? '?'} ` +
      `fail=${item.fail ?? '?'} skipped=${item.skipped ?? '?'} wall=${item.wallMs}ms` +
      (item.timedOut ? ' [TIMEOUT]' : '') +
      (item.error ? ` [${item.error}]` : ''),
  );
}
console.log(
  `总计：${results.length - failedRuns}/${results.length} 次通过，总耗时 ${(totalMs / 1000).toFixed(1)}s，最慢单次 ${(slowest / 1000).toFixed(1)}s`,
);
if (failedRuns > 0) {
  console.error(`e2e 稳定性失败：${failedRuns} 次运行未通过`);
  process.exit(1);
}
process.exit(0);
