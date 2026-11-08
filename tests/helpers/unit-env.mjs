/**
 * 单元测试公共环境初始化。
 *
 * 背景：`tests/unit/backend-*.test.js` 顶部曾各自重复
 * `mkdtempSync + process.env.DATA_DIR/APP_SECRET/LOG_LEVEL + test.after(closeDb + rmSync)` 样板。
 * 本模块统一这些步骤，同时保证关键约束：**必须在任何 `server/src` 模块动态 import 之前
 * 调用**（config.js 在模块加载时一次性求值，env 必须先就位），因此本文件只依赖 node 内置模块，
 * 不静态 import 任何业务模块（`cleanupUnitEnv` 在清理时才动态 import db.js）。
 *
 * 典型用法（保持文件级进程隔离，env 在动态 import 前设置）：
 *
 * ```js
 * import test from 'node:test';
 * import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';
 *
 * const unitEnv = prepareUnitEnv({
 *   prefix: 'clawbridge-foo-',
 *   env: {
 *     APP_SECRET: 'foo-secret-...',
 *     ADMIN_PASSWORD: 'foo-password', // 仅测试 seed DB 用（config 不再读取）
 *     API_TOKEN: 'foo-token',
 *     APP_RULES_ALLOWED_HOSTS: '127.0.0.1',
 *   },
 * });
 * const dataDir = unitEnv.dataDir; // 仅测试自身还需要该路径时保留
 *
 * const store = await import('../../server/src/store.js');
 * ...
 * test.after(async () => {
 *   // 文件自身的额外清理（停 server/close fake 等）在前
 *   await cleanupUnitEnv(unitEnv);
 * });
 * ```
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 未显式传 APP_SECRET 时的默认测试密钥（各测试不再需要唯一值；仍可显式覆盖）。 */
const DEFAULT_APP_SECRET = 'unit-test-app-secret-0123456789abcdef0123456789abcdef';
/** 未显式传 LOG_LEVEL 时的默认级别（避免测试噪声）。 */
const DEFAULT_LOG_LEVEL = 'silent';

/**
 * 在动态 import 业务模块前初始化单测环境：创建临时 DATA_DIR，设置 env 默认值 + 覆盖值。
 * 低层 API（每次调用都会新建一个临时目录）；需要进程退出兜底时用 setupUnitEnv。
 *
 * @param {object} [options]
 * @param {Record<string, string|number|boolean|undefined|null>} [options.env] 额外 env；undefined/null 表示删除该变量
 * @param {string} [options.prefix] 临时目录前缀（默认 'clawbridge-unit-'）
 * @returns {{dataDir: string, prefix: string, env: Record<string, string|undefined>, cleaned: boolean, exitHandler: Function|null, cleanup: () => Promise<void>}}
 */
export function prepareUnitEnv({ env = {}, prefix = 'clawbridge-unit-' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // DATA_DIR 以临时目录为准（不允许 env 覆盖，避免测试污染工作区）
  process.env.DATA_DIR = dataDir;
  const applied = { APP_SECRET: DEFAULT_APP_SECRET, LOG_LEVEL: DEFAULT_LOG_LEVEL, ...env };
  for (const [name, value] of Object.entries(applied)) {
    if (value === undefined || value === null) {
      delete process.env[name];
      continue;
    }
    process.env[name] = String(value);
  }
  const ctx = {
    dataDir,
    prefix,
    env: applied,
    cleaned: false,
    exitHandler: null,
  };
  ctx.cleanup = () => cleanupUnitEnv(ctx);
  return ctx;
}

/**
 * 推荐入口：prepareUnitEnv + 可选的 process 退出兜底清理（默认关闭，测试应在 test.after 显式清理）。
 * @param {object} [options] 透传 prepareUnitEnv；额外支持 registerExitCleanup=true 注册 exit 兜底（best-effort）
 */
export function setupUnitEnv(options = {}) {
  const ctx = prepareUnitEnv(options);
  if (options.registerExitCleanup === true) {
    ctx.exitHandler = () => {
      try {
        fs.rmSync(ctx.dataDir, { recursive: true, force: true });
      } catch {
        /* 进程退出兜底：忽略清理失败 */
      }
    };
    process.once('exit', ctx.exitHandler);
  }
  return ctx;
}

/**
 * 清理单测环境（幂等）：关闭 DB（若已打开）并删除临时 DATA_DIR。
 * 通常作为 `test.after(async () => { ...; await cleanupUnitEnv(unitEnv); })` 的最后一步调用。
 * @param {{dataDir?: string, cleaned?: boolean, exitHandler?: Function|null}|null|undefined} ctx
 */
export async function cleanupUnitEnv(ctx) {
  if (!ctx || ctx.cleaned) return;
  ctx.cleaned = true;
  if (ctx.exitHandler) {
    try {
      process.removeListener('exit', ctx.exitHandler);
    } catch {
      /* 忽略 */
    }
    ctx.exitHandler = null;
  }
  // 动态 import：保证本模块自身不触发 config.js/db.js 的模块加载期求值。
  try {
    const { closeDb } = await import('../../server/src/db.js');
    closeDb();
  } catch {
    /* DB 未打开或已被测试自身关闭：忽略 */
  }
  if (ctx.dataDir) {
    try {
      fs.rmSync(ctx.dataDir, { recursive: true, force: true });
    } catch {
      /* Windows 上句柄未释放时忽略：临时目录由 OS 清理 */
    }
  }
}
