/**
 * 回归测试：DB schema v7 → v9 additive migration（app_settings，docs/SETTINGS.md §1）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

// v7 结构（足够代表性：meta/users/groups/outbox/app_rules/scheduled_tasks 等，无 app_settings）
const V7_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '', wechat_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', bound_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_inbound_at INTEGER NOT NULL DEFAULT 0, pause_until INTEGER NOT NULL DEFAULT 0,
  keepalive_enabled INTEGER NOT NULL DEFAULT 0, keepalive_last_sent_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '', keepalive_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE outbox (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'api',
  status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
  server_message_id TEXT, client_id TEXT, media_id TEXT, caption_sent_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sent_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE app_rules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100, request_url TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NOT NULL DEFAULT 0, request_url TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-settings-migration-'));
const v7Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-settings-v7-'));
const v7Path = path.join(v7Dir, 'clawbridge.db');

function createV7Database(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(V7_SCHEMA);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '7')").run();
  db.prepare(
    `INSERT INTO users (id, display_name, wechat_user_id, status, bound_at, updated_at, keepalive_enabled)
     VALUES ('u_v7_alpha', '真实用户甲', 'wx_v7_alpha', 'active', 1000, 1000, 1)`,
  ).run();
  db.prepare("INSERT INTO groups (id, name, keepalive_enabled, created_at, updated_at) VALUES ('grp_v7_1', '真实分组', 1, 1, 1)").run();
  db.prepare("INSERT INTO outbox (id, user_id, text, source, status, created_at, updated_at) VALUES ('ob_v7_1', 'u_v7_alpha', '历史消息', 'api', 'sent', 1, 1)").run();
  db.prepare("INSERT INTO app_rules (id, name, request_url, created_at, updated_at) VALUES ('rule_v7_1', '规则', 'https://a.example', 1, 1)").run();
  db.prepare("INSERT INTO scheduled_tasks (id, name, request_url, created_at, updated_at) VALUES ('task_v7_1', '任务', 'https://a.example', 1, 1)").run();
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  db.close();
}

createV7Database(v7Path);

process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'settings-migration-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'settings-migration-password';
process.env.API_TOKEN = 'settings-migration-token';
process.env.LOG_LEVEL = 'silent';

const { openDatabase, SCHEMA_VERSION, closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(v7Dir, { recursive: true, force: true });
});

const count = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
const tableExists = (db, name) =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));

test('v7 → v9 迁移：既有数据零丢失 + app_settings 表 + 幂等', () => {
  assert.equal(SCHEMA_VERSION, 9);
  const db = openDatabase(v7Path);
  try {
    assert.equal(count(db, 'users'), 1);
    assert.equal(count(db, 'groups'), 1);
    assert.equal(count(db, 'outbox'), 1);
    assert.equal(count(db, 'app_rules'), 1);
    assert.equal(count(db, 'scheduled_tasks'), 1);
    assert.equal(db.prepare('SELECT display_name FROM users WHERE id = ?').get('u_v7_alpha').display_name, '真实用户甲');
    assert.equal(db.prepare('SELECT name FROM groups WHERE id = ?').get('grp_v7_1').name, '真实分组');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');

    assert.ok(tableExists(db, 'app_settings'), 'app_settings 表应存在');
    assert.equal(count(db, 'app_settings'), 0);

    // 新表可写（JSON 值 + updated_at）
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'keepalive.text',
      JSON.stringify('自定义保活 {name}'),
      123,
    );
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'appRules.allowedHosts',
      JSON.stringify(['192.168.88.10']),
      124,
    );
    assert.equal(count(db, 'app_settings'), 2);
    assert.equal(JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='appRules.allowedHosts'").get().value)[0], '192.168.88.10');
  } finally {
    db.close();
  }

  // 幂等
  const again = openDatabase(v7Path);
  try {
    assert.equal(again.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.equal(count(again, 'users'), 1);
    assert.equal(count(again, 'app_settings'), 2);
    assert.ok(tableExists(again, 'app_settings'));
  } finally {
    again.close();
  }
});

test('全新数据库直接创建为 v9 结构', () => {
  const freshPath = path.join(v7Dir, 'fresh.db');
  const db = openDatabase(freshPath);
  try {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.ok(tableExists(db, 'app_settings'));
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run('keepalive.enabled', 'false', 1);
    assert.equal(count(db, 'app_settings'), 1);
  } finally {
    db.close();
  }
});
