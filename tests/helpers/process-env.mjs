/**
 * e2e 进程环境工具：路径/常量、通用等待工具、子进程 env 白名单、日志采集/终止、
 * app/mock 子进程 spawn（PORT=0 端口回传）与临时 DATA_DIR 管理。
 *
 * 依赖方向（无循环）：process-env → （仅 node 内置模块）；e2e-client → process-env；e2e-env → 全部。
 * startE2E 的组合逻辑在聚合层 e2e-env.mjs（避免 process-env ↔ e2e-client 循环依赖）。
 */
import { spawn, spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** package.json 版本号（e2e 断言 /version 字段用，避免测试里硬编码版本号随发版漂移）。 */
export const PACKAGE_VERSION = String(
  JSON.parse(await fsp.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0',
);

/**
 * APP_SECRET 仍由 env 注入（§7.1 六项之一，e2e 用固定值便于重复启动）。
 * 管理密码 / API Token 不再由 env 提供：app 首启自动生成到 DATA_DIR 文件，
 * 每个实例的明文通过 `e2e.adminPassword` / `e2e.apiToken` 获取。
 */
export const APP_SECRET = 'e2e-app-secret-0123456789abcdef0123456789abcdef';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 轮询等待条件成立；fn 返回 truthy 即返回该值。超时抛出带 label 的错误。 */
export async function waitFor(fn, { timeoutMs = 15000, intervalMs = 50, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const suffix = lastError ? `；最后错误：${lastError.message}` : '';
      throw new Error(`waitFor 超时（${timeoutMs}ms）：${label}${suffix}`);
    }
    await sleep(intervalMs);
  }
}

/** 条件连续满足 samples 次（用于断言“状态稳定/不再变化”）。 */
export async function waitStable(fn, { samples = 4, intervalMs = 80, timeoutMs = 10000, label = '状态稳定' } = {}) {
  let count = 0;
  await waitFor(
    async () => {
      if (await fn()) {
        count += 1;
        return count >= samples;
      }
      count = 0;
      return false;
    },
    { timeoutMs, intervalMs, label },
  );
}

/**
 * 反向断言（替代 `await sleep(N); assert 状态未变化`）：
 * 1) 先等待状态“稳定”（连续 samples 次采样序列化结果一致）；
 * 2) 再观察 observeMs，观察窗口内只要状态发生变化即失败。
 * fn 返回值需可 JSON 序列化；可用 serializer 定制比较口径。
 * 返回稳定基线（便于附加断言）。
 */
export async function expectNoChange(fn, {
  samples = 3,
  intervalMs = 100,
  observeMs = 500,
  timeoutMs = 15000,
  serializer = stableStringify,
  label = '状态不变量',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let stable = 0;
  while (Date.now() < deadline) {
    const current = serializer(await fn());
    if (previous !== null && current === previous) stable += 1;
    else stable = 0;
    previous = current;
    if (stable >= samples) break;
    await sleep(intervalMs);
  }
  if (stable < samples) {
    throw new Error(`expectNoChange 超时（${timeoutMs}ms）：${label} 未能在观察前稳定`);
  }
  const baseline = previous;
  const observeUntil = Date.now() + observeMs;
  while (Date.now() < observeUntil) {
    await sleep(Math.max(1, Math.min(intervalMs, observeUntil - Date.now())));
    const current = serializer(await fn());
    if (current !== baseline) {
      throw new Error(
        `expectNoChange 失败（${label}）：观察窗口内状态发生变化\n  稳定基线：${baseline}\n  观察结果：${current}`,
      );
    }
  }
  return baseline;
}

/** 键排序的稳定序列化（同名对象/数组可直接字符串比较）。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * 等待跨过一个毫秒边界：用于让后续写入获得不同的毫秒时间戳，
 * 替代 `await sleep(20)` 这类“睡够就行”的时序 hack（最多等 2s，确定性更好）。
 */
export async function waitNextMillis(ms = 2) {
  const target = Date.now() + Math.max(1, ms);
  await waitFor(() => Date.now() >= target, { timeoutMs: 2000, intervalMs: 1, label: `等待时间推进 ${ms}ms` });
}

/**
 * 子进程环境变量白名单：只透传 OS/运行时必需变量，避免宿主进程里的
 * KEEPALIVE_ENABLED / DATA_DIR / LOG_LEVEL / ILINK_* 等污染被测 app/mock。
 * 测试覆盖只能通过 startE2E({appEnv})、mockEnv 或显式 E2E_APP_ENV 注入。
 */
const CHILD_ENV_PASSTHROUGH = [
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL', 'TZ',
];

export function buildChildEnv(overrides = {}) {
  const env = {};
  for (const key of CHILD_ENV_PASSTHROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

/** 获取一个空闲端口（先监听 127.0.0.1:0 再关闭）。 */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 子进程日志采集器：按行收集 stdout/stderr，保留尾部供失败诊断。 */
function createLogCollector(child, name) {
  const lines = [];
  const listeners = new Set();
  const collector = {
    name,
    lines,
    listeningPort: 0,
    onLine(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    tail(count = 80) {
      return lines.slice(-count).join('\n');
    },
    push(line) {
      lines.push(line);
      if (lines.length > 2000) lines.shift();
      try {
        const parsed = JSON.parse(line);
        // mock：{"event":"listening","port":...}
        if (parsed?.event === 'listening' && Number(parsed.port) > 0) collector.listeningPort = Number(parsed.port);
        // app（server/src/index.js）：启动日志 "ClawBridge 已启动" 的 port 为实际监听端口（PORT=0 时为 OS 分配），
        // e2e 用它替代 getFreePort“先探测再监听”的 TOCTOU 方案。
        else if (parsed?.msg === 'ClawBridge 已启动' && Number(parsed.port) > 0) {
          collector.listeningPort = Number(parsed.port);
        }
      } catch {
        /* 非 JSON 行（node warning 等）忽略解析 */
      }
      for (const fn of listeners) {
        try {
          fn(line);
        } catch {
          /* 监听器异常不影响主流程 */
        }
      }
    },
  };
  const wire = (stream) => {
    if (!stream) return;
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (part.trim() !== '') collector.push(part);
      }
    });
    stream.on('end', () => {
      if (buffer.trim() !== '') collector.push(buffer);
      buffer = '';
    });
  };
  wire(child.stdout);
  wire(child.stderr);
  return collector;
}

/** 优雅/强制停止子进程；Windows 下用 taskkill /T /F 兜底确保不留孤儿进程。 */
export async function stopProcess(proc, logs, name = 'process') {
  if (!proc) return;
  const isAlive = () => proc.exitCode == null && proc.signalCode == null;
  if (!isAlive()) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  try {
    proc.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  const timedOut = sleep(4000).then(() => true);
  const finished = exited.then(() => false);
  if (await Promise.race([finished, timedOut])) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await Promise.race([exited, sleep(1500)]);
  }
  if (isAlive() && process.platform === 'win32' && proc.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* ignore */
    }
    await Promise.race([exited, sleep(1500)]);
  }
  if (isAlive()) {
    throw new Error(`${name} 无法停止（pid=${proc.pid}）：\n${logs?.tail(60) ?? ''}`);
  }
}

function parseExtraAppEnv() {
  const raw = process.env.E2E_APP_ENV;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('E2E_APP_ENV 必须是合法 JSON 对象');
  }
}


// 所有活跃实例：测试进程以非 0 退出（有失败用例）时，打印最近实例的 app/mock 日志尾部。
const activeInstances = new Set();
let exitHookInstalled = false;
export function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', (code) => {
    if (!code) return;
    for (const instance of activeInstances) {
      if (instance.finished) continue;
      try {
        console.error(`\n----- E2E 失败诊断：app 日志尾部（${instance.appUrl}）-----\n${instance.appLogs.tail(80)}`);
        console.error(`----- E2E 失败诊断：mock 日志尾部（${instance.mockUrl}）-----\n${instance.mockLogs.tail(40)}`);
      } catch {
        /* ignore */
      }
    }
  });
}
/** 注册活跃 E2E 实例（测试进程非 0 退出时打印 app/mock 日志尾部）。 */
export function trackE2EInstance(instance) {
  activeInstances.add(instance);
}

/** 注销活跃 E2E 实例。 */
export function untrackE2EInstance(instance) {
  activeInstances.delete(instance);
}

// ---------------------------------------------------------------------------
// app/mock 子进程启动与临时目录
// ---------------------------------------------------------------------------
/** 创建 e2e 临时 DATA_DIR（os.tmpdir 下 clawbridge-e2e-*；由 E2E.cleanup 删除）。 */
export async function createTempDataDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'clawbridge-e2e-'));
}

/** 删除 e2e 临时 DATA_DIR（失败忽略）。 */
export async function removeTempDataDir(dataDir) {
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

const BASE_APP_ENV = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  APP_SECRET,
  // 必须 info：app 启动日志 "ClawBridge 已启动" 携带实际监听端口，e2e 依赖它回传 PORT=0 的真实端口。
  LOG_LEVEL: 'info',
  BINDING_POLL_GAP_MS: '50',
  BINDING_IP_LIMIT_PER_HOUR: '1000',
  RATE_LIMIT_MAX: '100',
  RATE_LIMIT_WINDOW_MS: '60000',
  PUSH_RETRY_DELAYS_MS: '80,150,300',
  DISPATCH_TICK_MS: '50',
  MONITOR_LONGPOLL_TIMEOUT_MS: '1000',
  MAX_TEXT_LENGTH: '4000',
  COOKIE_SECURE: 'false',
  TRUST_PROXY: 'false',
  // 接口应用（docs/API_RULES.md）：e2e 外部 API mock 在 127.0.0.1，需放行白名单；
  // 无规则的常规 e2e 不受影响（没有规则即不触发）。
  APP_RULES_ENABLED: '1',
  APP_RULES_ALLOWED_HOSTS: '127.0.0.1,localhost',
  // 定时通知（docs/SCHEDULED_TASKS.md）：e2e 用「立即执行」验证链路，tick 调小便于调度器启动；
  // 任务 interval 最小 60s，测试期间不会自动触发，避免干扰。
  SCHEDULER_ENABLED: '1',
  SCHEDULER_TICK_MS: '1000',
  SCHEDULER_TIMEZONE: 'Asia/Shanghai',
};

/**
 * 启动 mock 微信 iLink 子进程（PORT=0，从 {"event":"listening"} 日志回传真实端口）。
 * @param {{mockEnv?: object}} [options]
 * @returns {Promise<{proc: import('node:child_process').ChildProcess, logs: object, port: number, url: string}>}
 */
export async function spawnMockProcess({ mockEnv = {} } = {}) {
  const proc = spawn(process.execPath, [path.join(REPO_ROOT, 'mock', 'ilink-mock.mjs')], {
    cwd: REPO_ROOT,
    env: buildChildEnv({
      PORT: '0',
      HOST: '127.0.0.1',
      MOCK_QUIET: '1',
      MOCK_AUTO_CONFIRM_MS: '0',
      MOCK_QR_POLL_MS: '150',
      MOCK_LONGPOLL_MS: '300',
      MOCK_LONGPOLLING_TIMEOUT_MS: '1000',
      MOCK_QR_TTL_MS: '300000',
      MOCK_VERIFY_MAX_ATTEMPTS: '3',
      ...mockEnv,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.on('error', () => {});
  const logs = createLogCollector(proc, 'mock-ilink');
  try {
    const port = await waitFor(() => (logs.listeningPort > 0 ? logs.listeningPort : null), {
      timeoutMs: 15000,
      label: 'mock 启动 listening',
    });
    return { proc, logs, port, url: `http://127.0.0.1:${port}` };
  } catch (err) {
    await stopProcess(proc, logs, 'mock').catch(() => {});
    throw new Error(`${err.message}\n--- mock 日志 ---\n${logs.tail(40)}`);
  }
}

/**
 * 启动 app 子进程（PORT=0，从「ClawBridge 已启动」日志回传实际监听端口，消除端口探测 TOCTOU）。
 * @param {{dataDir: string, mockUrl: string, appEnv?: object}} options
 * @returns {Promise<{proc: import('node:child_process').ChildProcess, logs: object, port: number, url: string}>}
 */
export async function spawnAppProcess({ dataDir, mockUrl, appEnv = {} } = {}) {
  const appChildEnv = buildChildEnv({
    ...BASE_APP_ENV,
    ...parseExtraAppEnv(),
    PORT: '0',
    DATA_DIR: dataDir,
    ILINK_LOGIN_BASE_URL: mockUrl,
    ILINK_BASE_URL: mockUrl,
    // mock CDN 的下载路径为 /cdn/download?encrypted_query_param=…；
    // 后端按 `{ILINK_CDN_BASE_URL}/download?…` 拼 URL，因此 base 需带 /cdn 后缀。
    ILINK_CDN_BASE_URL: `${mockUrl}/cdn`,
    ...appEnv,
  });
  // 端口回传依赖 info 级的「ClawBridge 已启动」日志：调用方若把 LOG_LEVEL 调成 warn/error/silent，
  // 会拿不到端口（曾导致 backend-index-lifecycle 用例等待 20s 超时），这里强制回退到 info；
  // 只有显式 debug（更详细）时保留。
  if (!['debug', 'info'].includes(String(appChildEnv.LOG_LEVEL ?? '').toLowerCase())) {
    appChildEnv.LOG_LEVEL = 'info';
  }
  const proc = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'src', 'index.js')], {
    cwd: REPO_ROOT,
    env: appChildEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.on('error', () => {});
  const logs = createLogCollector(proc, 'app');
  try {
    const deadline = Date.now() + 20000;
    while (logs.listeningPort <= 0) {
      if (proc.exitCode != null || proc.signalCode != null) {
        throw new Error(`app 进程提前退出（code=${proc.exitCode}, signal=${proc.signalCode}）`);
      }
      if (Date.now() >= deadline) throw new Error('app 启动日志端口回传超时（20000ms）');
      await sleep(25);
    }
    const port = logs.listeningPort;
    return { proc, logs, port, url: `http://127.0.0.1:${port}` };
  } catch (err) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    throw new Error(`${err.message}\n--- app 日志 ---\n${logs.tail(60)}`);
  }
}

/**
 * 主动终止 app 子进程并等待退出，返回 { code, signal, logs }（logs 为信号发出后新增的日志）。
 * 超时后 SIGKILL +（Windows）taskkill /T /F 兜底，并调用 onTimeout（用于 E2E 清理 mock/临时目录）。
 * 供 E2E.terminateApp 复用，避免子进程生命周期逻辑散落在客户端类里。
 * @param {import('node:child_process').ChildProcess} proc
 * @param {{lines: string[], tail: (n?: number) => string}} logs
 * @param {{signal?: 'SIGTERM'|'SIGINT'|'SIGKILL', timeoutMs?: number, label?: string, onTimeout?: () => Promise<void>|void}} [options]
 */
export async function terminateAppProcess(
  proc,
  logs,
  { signal = 'SIGTERM', timeoutMs = 15000, label = 'app 进程退出', onTimeout } = {},
) {
  if (!proc) throw new Error(`${label}：进程未运行`);
  const logStart = logs.lines.length;
  const exited = new Promise((resolve) => {
    proc.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  // 注意：超时计时器必须 unref + clear，否则测试进程会被不必要地拖慢/挂住。
  let timeoutHandle = null;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
    timeoutHandle.unref?.();
  });
  try {
    proc.kill(signal);
  } catch (err) {
    clearTimeout(timeoutHandle);
    throw new Error(`${label}：发送 ${signal} 失败：${err.message}`);
  }
  const result = await Promise.race([exited, timeout]);
  clearTimeout(timeoutHandle);
  if (!result) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    if (process.platform === 'win32' && proc.pid) {
      try {
        spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {
        /* ignore */
      }
    }
    if (onTimeout) {
      try {
        await onTimeout();
      } catch {
        /* ignore */
      }
    }
    throw new Error(`${label} 超时（${timeoutMs}ms）：\n${logs?.tail(80) ?? ''}`);
  }
  return { ...result, logs: logs.lines.slice(logStart).join('\n') };
}
