/**
 * 单元测试：数据库只支持当前 schema，旧版本直接拒绝（不再提供迁移）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-schema-version-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'schema-version-secret-0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL = 'silent';

const { openDatabase, SCHEMA_VERSION, closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('旧 schema 数据库启动时直接拒绝，不做 ALTER 迁移', () => {
  const oldPath = path.join(dataDir, 'old-schema.db');
  const oldDb = new DatabaseSync(oldPath);
  oldDb.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  oldDb.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '8')").run();
  oldDb.close();
  assert.throws(
    () => openDatabase(oldPath),
    /不再兼容/,
    '旧 schema 必须在打开阶段失败，而不是执行迁移',
  );
  const check = new DatabaseSync(oldPath);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '8');
  check.close();
});

test('当前 schema 与全新库均可打开且幂等写入当前版本', () => {
  const freshPath = path.join(dataDir, 'fresh.db');
  const first = openDatabase(freshPath);
  assert.equal(
    first.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value,
    String(SCHEMA_VERSION),
  );
  first.close();
  const second = openDatabase(freshPath);
  assert.equal(
    second.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value,
    String(SCHEMA_VERSION),
  );
  assert.ok(second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get());
  second.close();
});
