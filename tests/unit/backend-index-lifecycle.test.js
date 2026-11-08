/**
 * 单元测试：进程生命周期（server/src/index.js 子进程）——优雅退出与终止兜底。
 *
 * 通过 tests/helpers/e2e-env.mjs 启动真实 app 子进程（随机端口 + 临时 DATA_DIR + mock 微信），
 * 绑定一个用户后向 app 发送 SIGTERM/SIGINT，断言：
 *  - 退出码 0、无异常信号；
 *  - 优雅退出日志（收到退出信号 / HTTP 停止 / 已安全退出）；
 *  - monitor.stopAll({notify:true}) 使 mock 收到 notifystop；
 *  - 跨平台的强制终止兜底（Windows 无 POSIX 信号语义时 child.kill 为强制终止）。
 *
 * 平台说明：Node 在 Windows 上 child.kill('SIGTERM'/'SIGINT') 为 TerminateProcess（不会触发
 * `process.on('SIGTERM')`），因此“优雅退出日志/notifystop”断言仅在 POSIX 执行（Linux CI）；
 * Windows 下保留跨平台兜底用例，验证进程确实退出且资源清理干净。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { startE2E, waitFor } from '../helpers/e2e-env.mjs';

const isWindows = process.platform === 'win32';
const POSIX_ONLY = isWindows
  ? 'Windows 无 POSIX 信号语义：child.kill(SIGTERM) 为强制终止，不会触发优雅退出处理器（该断言在 Linux CI 执行）'
  : false;

/** 绑定一个用户并等待入站监控启动，确保退出路径会执行 monitor.stopAll({notify:true})。 */
async function bindUserAndWaitMonitor(e2e) {
  const bound = await e2e.bindUser({ displayName: '生命周期用户', waitMonitor: true });
  assert.ok(bound.user?.id, '应绑定成功并返回 user');
  assert.ok(bound.account?.botId, 'mock 侧应存在对应 bot 账号');
  assert.ok(bound.account.notifyStart >= 1, 'monitor 应已 notifyStart');
  return bound;
}

/** mock 快照中定位 bot 账号（测试结束前 mock 仍存活）。 */
async function findMockAccount(e2e, botId) {
  const state = await e2e.mockState();
  return state.accounts.find((item) => item.botId === botId) ?? null;
}

test('SIGTERM 优雅退出：退出码 0、优雅退出日志、monitor notifystop', { skip: POSIX_ONLY }, async () => {
  const e2e = await startE2E({ appEnv: { LOG_LEVEL: 'info' } });
  try {
    const bound = await bindUserAndWaitMonitor(e2e);
    const pid = e2e.appProc.pid;
    assert.ok(pid > 0, 'app 子进程应有 pid');

    const result = await e2e.terminateApp({ signal: 'SIGTERM', timeoutMs: 25000 });
    assert.equal(result.code, 0, `优雅退出退出码应为 0（实际 code=${result.code} signal=${result.signal}）\n${result.logs}`);
    assert.equal(result.signal, null, `优雅退出不应以信号终止（signal=${result.signal}）`);

    for (const line of ['收到退出信号，开始优雅退出', 'HTTP 服务已停止接受新请求', '已安全退出']) {
      assert.ok(result.logs.includes(line), `优雅退出日志应包含「${line}」：\n${result.logs}`);
    }

    // monitor.stopAll({notify:true}) → mock 收到 notifystop（退出流程在进程内完成，mock 仍存活）
    const account = await waitFor(
      async () => {
        const current = await findMockAccount(e2e, bound.account.botId);
        return current && current.notifyStop >= 1 ? current : null;
      },
      { timeoutMs: 8000, label: '优雅退出后 mock 收到 notifystop' },
    );
    assert.equal(account.notifyStart, 1, 'notifyStart 应恰好 1 次');
    assert.ok(account.notifyStop >= 1, '优雅退出应触发 notifystop');
  } finally {
    await e2e.cleanup({ skipMockViolationCheck: false }).catch(() => {});
  }
});

test('SIGINT 优雅退出：退出码 0 且日志与 SIGTERM 路径一致', { skip: POSIX_ONLY }, async () => {
  const e2e = await startE2E({ appEnv: { LOG_LEVEL: 'info' } });
  try {
    await bindUserAndWaitMonitor(e2e);
    const result = await e2e.terminateApp({ signal: 'SIGINT', timeoutMs: 25000 });
    assert.equal(result.code, 0, `SIGINT 优雅退出退出码应为 0（实际 code=${result.code} signal=${result.signal}）\n${result.logs}`);
    assert.equal(result.signal, null);
    assert.ok(result.logs.includes('收到退出信号，开始优雅退出'), `退出日志缺失：\n${result.logs}`);
    assert.ok(result.logs.includes('已安全退出'), `退出日志缺失：\n${result.logs}`);
  } finally {
    await e2e.cleanup().catch(() => {});
  }
});

test('终止兜底：terminateApp 返回退出信息、进程退出、临时目录被清理（跨平台）', async () => {
  const e2e = await startE2E({ appEnv: { LOG_LEVEL: 'error' } });
  const dataDir = e2e.dataDir;
  try {
    const result = await e2e.terminateApp({ signal: 'SIGTERM', timeoutMs: 25000 });
    // POSIX：优雅退出 code=0；Windows：强制终止 code=null + signal=SIGTERM。
    assert.ok(
      result.code === 0 || result.signal === 'SIGTERM',
      `进程应已退出（实际 code=${result.code} signal=${result.signal}）`,
    );
    assert.equal(e2e.appProc, null, 'terminateApp 后 appProc 应清空');
  } finally {
    await e2e.cleanup().catch(() => {});
  }
  assert.equal(fs.existsSync(dataDir), false, '清理后临时 DATA_DIR 应被删除');
});
