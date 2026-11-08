/**
 * e2e 测试环境统一入口（聚合导出，保持既有 import 路径与导出名不变）。
 *
 * 拆分后的职责：
 * - process-env.mjs：进程/端口/日志/临时目录/等待工具与子进程 env 白名单；
 * - e2e-client.mjs：E2E 类（HTTP/admin/绑定/队列/分组/规则/定时/设置断言助手）；
 * - mock-api.mjs：外部 HTTP API mock（接口应用 e2e 用）；
 * - media-crypto.mjs：媒体 AES 测试工具。
 *
 * 用法（每个 e2e 文件一个实例）：
 *   import { before, after } from 'node:test';
 *   import { startE2E } from '../helpers/e2e-env.mjs';
 *   let e2e;
 *   before(async () => { e2e = await startE2E(); });
 *   after(async () => { await e2e?.cleanup(); });
 *
 * 环境变量覆盖：E2E_APP_ENV='{"LOG_LEVEL":"debug"}'（JSON）可附加/覆盖 app 环境变量，便于本地排障。
 */
import assert from 'node:assert/strict';

import { E2E, assertBigMessageId } from './e2e-client.mjs';
import {
  APP_SECRET,
  PACKAGE_VERSION,
  REPO_ROOT,
  buildChildEnv,
  createTempDataDir,
  getFreePort,
  removeTempDataDir,
  sleep,
  spawnAppProcess,
  spawnMockProcess,
  stableStringify,
  stopProcess,
  waitFor,
  waitNextMillis,
  waitStable,
  expectNoChange,
} from './process-env.mjs';
import { startMockApi } from './mock-api.mjs';
import { b64HexKey, parseOutboundAesKey } from './media-crypto.mjs';

export { APP_SECRET, PACKAGE_VERSION, REPO_ROOT, buildChildEnv, getFreePort } from './process-env.mjs';
export { sleep, waitFor, waitStable, expectNoChange, stableStringify, waitNextMillis } from './e2e-client.mjs';
export { assertBigMessageId } from './e2e-client.mjs';
export { startMockApi } from './mock-api.mjs';
export { b64HexKey, parseOutboundAesKey } from './media-crypto.mjs';

/**
 * 启动 mock + app 并等待健康检查通过，随后读取首启自动生成的机密文件。
 * @param {{appEnv?: object, mockEnv?: object, dataDir?: string, allowMockViolations?: Array<string|Function>}} [options]
 *   dataDir 传入已有目录时复用（用于重启/二次启动用例），cleanup 不会删除该目录；
 *   allowMockViolations 传给 E2E，用于豁免确有必要的 mock 协议违规（默认空 = 不允许任何违规）。
 *   注意：子进程 env 为白名单构造（buildChildEnv），不再继承宿主 process.env；
 *   如需覆盖，用 appEnv/mockEnv 或显式 E2E_APP_ENV（JSON）逃生通道。
 * @returns {Promise<E2E>}
 */
export async function startE2E({
  appEnv = {},
  mockEnv = {},
  dataDir: reuseDataDir = null,
  allowMockViolations = [],
} = {}) {
  const ownsDataDir = !reuseDataDir;
  const dataDir = reuseDataDir ?? (await createTempDataDir());
  let mock = null;
  let app = null;
  try {
    mock = await spawnMockProcess({ mockEnv });
    app = await spawnAppProcess({ dataDir, mockUrl: mock.url, appEnv });
  } catch (err) {
    if (app) {
      try {
        app.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    if (mock) await stopProcess(mock.proc, mock.logs, 'mock').catch(() => {});
    if (ownsDataDir) await removeTempDataDir(dataDir);
    throw err;
  }

  const e2e = new E2E({
    appProc: app.proc,
    mockProc: mock.proc,
    appPort: app.port,
    mockPort: mock.port,
    dataDir,
    appLogs: app.logs,
    mockLogs: mock.logs,
    ownsDataDir,
    allowMockViolations,
  });

  try {
    await waitFor(
      async () => {
        if (app.proc.exitCode != null || app.proc.signalCode != null) {
          throw new Error(`app 进程提前退出（code=${app.proc.exitCode}, signal=${app.proc.signalCode}）`);
        }
        try {
          const res = await fetch(`${app.url}/health`, { signal: AbortSignal.timeout(1000) });
          return res.ok;
        } catch {
          return null;
        }
      },
      { timeoutMs: 20000, label: 'app /health 就绪' },
    );
    // 首启自动生成的机密文件（docs/SETTINGS.md §8）：读取明文供登录/API 鉴权使用
    e2e.adminPassword = await waitFor(() => e2e.readSecretFile('admin-password.txt').catch(() => null), {
      timeoutMs: 10000,
      label: 'admin-password.txt 首启生成',
    });
    e2e.apiToken = await waitFor(() => e2e.readSecretFile('api-token.txt').catch(() => null), {
      timeoutMs: 10000,
      label: 'api-token.txt 首启生成',
    });
    assert.ok(e2e.adminPassword.length > 0, 'admin-password.txt 不应为空');
    assert.ok(e2e.apiToken.length > 0, 'api-token.txt 不应为空');
  } catch (err) {
    await e2e.cleanup();
    throw new Error(`${err.message}\n--- app 日志 ---\n${app.logs.tail(60)}`);
  }
  return e2e;
}

export default {
  startE2E,
  startMockApi,
  waitFor,
  waitStable,
  expectNoChange,
  waitNextMillis,
  stableStringify,
  buildChildEnv,
  sleep,
  getFreePort,
  assertBigMessageId,
  b64HexKey,
  parseOutboundAesKey,
};
