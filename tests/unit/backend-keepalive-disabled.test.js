/**
 * 单元测试：KEEPALIVE_ENABLED=false 时调度完全不启动/不扫描（独立进程，env 在 import 前设置）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-keepalive-disabled-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'keepalive-disabled-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'keepalive-disabled-password';
process.env.API_TOKEN = 'keepalive-disabled-token';
process.env.LOG_LEVEL = 'silent';
process.env.KEEPALIVE_ENABLED = 'false';

const keepalive = await import('../../server/src/keepalive.js');
const store = await import('../../server/src/store.js');
const { config } = await import('../../server/src/config.js');
const { getDb, closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('全局关闭：start 返回 false、scan 不触发、不产生 outbox', async () => {
  assert.equal(config.keepalive.enabled, false);
  const user = store.upsertBoundUser({
    wechatUserId: 'wx_ka_disabled_1',
    displayName: '关闭保活用户',
    ilinkBotId: 'bot_ka_disabled_1@im.bot',
    botToken: 'ka-disabled-token',
    baseUrl: 'https://ilink.example.test',
  }).user;
  store.touchInbound(user.id, 1000);
  store.setKeepaliveEnabled(user.id, true);

  assert.equal(keepalive.start(), false, '全局关闭时 start 不应启动');
  assert.equal(keepalive.isRunning(), false);
  assert.equal(keepalive.stop(), false);

  const WINDOW = 2000;
  const now = 1000 + (WINDOW - 200);
  assert.equal(await keepalive.scan(now, { windowMs: WINDOW, leadMs: 200 }), 0, '全局关闭时默认 scan 不扫描');
  assert.equal(Number(getDb().prepare('SELECT COUNT(*) AS c FROM outbox').get().c), 0);

  // 显式 enabled:true 覆盖仅用于测试，验证候选查询本身正常
  assert.equal(await keepalive.scan(now, { windowMs: WINDOW, leadMs: 200, enabled: true }), 1);
  assert.equal(Number(getDb().prepare("SELECT COUNT(*) AS c FROM outbox WHERE source = 'keepalive'").get().c), 1);
});
