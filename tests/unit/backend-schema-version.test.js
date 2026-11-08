/**
 * 单元测试：数据库只支持当前 schema，旧版本直接拒绝（不再提供迁移）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-schema-version-',
  env: {
    APP_SECRET: 'schema-version-secret-0123456789abcdef0123456789abcdef',
    LOG_LEVEL: 'silent',
  },
});
const dataDir = unitEnv.dataDir;

const { openDatabase, SCHEMA_VERSION } = await import('../../server/src/db.js');

test.after(async () => {
  await cleanupUnitEnv(unitEnv);
});

test('不兼容的数据库版本（schema_version≠1）启动时直接拒绝', () => {
  const oldPath = path.join(dataDir, 'old-schema.db');
  const oldDb = new DatabaseSync(oldPath);
  oldDb.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  oldDb.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '2')").run();
  oldDb.close();
  assert.throws(
    () => openDatabase(oldPath),
    /数据库版本不兼容/,
    '不兼容的 schema_version 必须在打开阶段失败，而不是继续使用',
  );
  const check = new DatabaseSync(oldPath);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '2');
  check.close();
});

test('当前 schema 与全新库均可打开且幂等写入当前版本', () => {
  const freshPath = path.join(dataDir, 'fresh.db');
  const first = openDatabase(freshPath);
  assert.equal(
    first.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value,
    String(SCHEMA_VERSION),
  );
  const columns = first.prepare('PRAGMA table_info(app_rules)').all().map((column) => column.name);
  assert.ok(!columns.includes('cooldown_ms'), '当前 schema 不应再有冷却列');
  assert.ok(!columns.includes('max_calls_per_hour'), '当前 schema 不应再有规则小时限额列');
  assert.ok(!columns.includes('max_user_calls_per_hour'), '当前 schema 不应再有用户小时限额列');
  first.close();
  const second = openDatabase(freshPath);
  assert.equal(
    second.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value,
    String(SCHEMA_VERSION),
  );
  assert.ok(second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get());
  second.close();
});
