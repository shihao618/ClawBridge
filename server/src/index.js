/**
 * 进程入口（index.js）。
 *
 * 启动顺序（docs/ARCHITECTURE.md §2）：
 *   初始化 DB（db.js 模块加载时完成）→ 启动 HTTP server → 启动 dispatcher →
 *   为 status='active' 且未冷却的用户恢复入站监控（受 MONITOR_MAX_ACCOUNTS 限制，间隔 100ms）。
 *
 * 退出：SIGTERM/SIGINT 幂等处理 —— 关闭 HTTP（拒绝新请求）→ 停 dispatcher →
 * 停全部 monitors（best-effort notifyStop）→ 关闭 DB → 退出；10s 兜底强制退出。
 */
import { closeDb } from './db.js';
import { config } from './config.js';
import { logger, setLogLevel } from './logger.js';
import * as appRules from './app-rules.js';
import * as binding from './binding.js';
import * as dispatcher from './dispatcher.js';
import * as keepalive from './keepalive.js';
import * as monitor from './monitor.js';
import * as scheduler from './scheduler.js';
import * as settings from './settings.js';
import * as store from './store.js';
import { createApp } from './api.js';

// 防御性 umask（QA minor-4）：data 目录/SQLite/密钥等新建文件默认 0700/0600，
// 避免同容器内其他进程读取 DB（另由 infra 在 Dockerfile 中 chmod 700 /app/data）。
process.umask(0o077);

const log = logger.child({ mod: 'main' });

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

/** 关闭 HTTP server（停止接受新连接；最多等 3 秒后强制断开）。 */
function closeHttpServer(server) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      server.close(done);
      server.closeIdleConnections?.();
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        done();
      }, 3000);
      timer.unref?.();
    } catch {
      done();
    }
  });
}

/** 恢复崩溃/重启前的入站监控。 */
async function restoreMonitors() {
  try {
    const users = store.getActiveUsersForMonitor(config.monitor.maxAccounts);
    if (users.length === 0) {
      log.info('没有需要恢复的入站监控');
      return;
    }
    log.info('开始恢复入站监控', { count: users.length, maxAccounts: config.monitor.maxAccounts });
    let started = 0;
    for (const user of users) {
      try {
        if (monitor.start(user.id)) started += 1;
      } catch (err) {
        log.warn('恢复监控失败（忽略并继续）', { userId: user.id, message: err?.message });
      }
      await sleep(100); // 启动间隔 100ms，避免同时向微信 API 发起尖峰
    }
    log.info('恢复入站监控完成', { started, running: monitor.runningCount() });
  } catch (err) {
    log.error('恢复入站监控流程失败', { message: err?.message, stack: err?.stack });
  }
}

function installShutdownHandlers(server) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('收到退出信号，开始优雅退出', { signal });

    // 兜底：10 秒内未完成则强制退出
    const forceTimer = setTimeout(() => {
      log.warn('优雅退出超时（10s），强制退出');
      process.exit(0);
    }, 10_000);
    forceTimer.unref?.();

    try {
      await closeHttpServer(server);
      log.info('HTTP 服务已停止接受新请求');
    } catch (err) {
      log.warn('关闭 HTTP 服务出错', { message: err?.message });
    }
    try {
      await dispatcher.stop();
    } catch (err) {
      log.warn('停止出站队列出错', { message: err?.message });
    }
    try {
      keepalive.stop();
    } catch (err) {
      log.warn('停止保活调度出错', { message: err?.message });
    }
    try {
      appRules.stop();
    } catch (err) {
      log.warn('停止接口应用引擎出错', { message: err?.message });
    }
    try {
      scheduler.stop();
    } catch (err) {
      log.warn('停止定时通知调度器出错', { message: err?.message });
    }
    try {
      await monitor.stopAll({ notify: true, reason: 'shutdown' });
    } catch (err) {
      log.warn('停止入站监控出错', { message: err?.message });
    }
    try {
      binding.stopCleanup();
    } catch {
      /* 忽略 */
    }
    try {
      closeDb();
    } catch (err) {
      log.warn('关闭数据库出错', { message: err?.message });
    }
    clearTimeout(forceTimer);
    log.info('已安全退出');
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

async function main() {
  // 运行配置：DB 覆盖值在引擎启动前应用（docs/SETTINGS.md §2）
  settings.loadOverrides();
  // 首次启动引导：DB 无管理密码/API Token 时自动生成并写入 data/ 文件（幂等；无 env 回退）
  settings.bootstrapSecrets();
  // 运行配置中的日志级别即时生效（DB 覆盖优先于 env LOG_LEVEL）
  setLogLevel(config.logLevel);
  const app = createApp();

  const server = app.listen(config.port, config.host, () => {
    log.info('ClawBridge 已启动', {
      version: config.version,
      host: config.host,
      port: config.port,
      node: process.version,
      dataDir: config.dataDir,
      pushApiEnabled: config.pushApiEnabled,
    });
  });
  server.on('error', (err) => {
    log.error('HTTP 服务启动失败', { message: err?.message, code: err?.code });
    process.exitCode = 1;
  });

  // 出站队列 worker
  dispatcher.start();
  // 24h 会话保活调度（config.keepalive.enabled=false 时不启动）
  keepalive.start();
  // 接口应用规则引擎（config.appRules.enabled=false 时不启动）
  appRules.start();
  // 定时通知调度器（config.scheduler.enabled=false 时不启动）
  scheduler.start();
  // 运行配置热更新 hooks（settings PATCH 时重启定时器/引擎）
  settings.setRuntimeHooks({
    restartKeepalive: () => keepalive.restart(),
    restartScheduler: () => scheduler.restart(),
    restartAppRules: () => appRules.restart(),
  });
  // 绑定会话清理定时器
  binding.startCleanup();
  // 恢复入站监控（后台异步，不阻塞启动完成日志）
  void restoreMonitors();
  // 优雅退出
  installShutdownHandlers(server);
}

main().catch((err) => {
  log.error('启动失败', { message: err?.message, stack: err?.stack });
  process.exit(1);
});
