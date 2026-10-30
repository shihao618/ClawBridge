/**
 * 回归测试：DB schema v4 → v6 additive migration（v5 接口应用表 + v6 分组保活列；docs/API_RULES.md §1）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const V4_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '', wechat_user_id TEXT NOT NULL,
  ilink_bot_id TEXT, token_enc TEXT, base_url TEXT NOT NULL DEFAULT '',
  context_token_enc TEXT, context_token_updated_at INTEGER NOT NULL DEFAULT 0,
  get_updates_buf TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
  bound_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_inbound_at INTEGER NOT NULL DEFAULT 0, last_outbound_at INTEGER NOT NULL DEFAULT 0,
  last_poll_at INTEGER NOT NULL DEFAULT 0, pause_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  keepalive_enabled INTEGER NOT NULL DEFAULT 0, keepalive_last_sent_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE outbox (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'api',
  status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
  server_message_id TEXT, client_id TEXT, media_id TEXT, caption_sent_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sent_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE inbound_messages (
  id TEXT PRIMARY KEY, user_id TEXT, wechat_message_id TEXT, from_user_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '', item_types TEXT NOT NULL DEFAULT '', raw_json TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, received_at INTEGER NOT NULL
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, user_id TEXT,
  detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY, direction TEXT NOT NULL, kind TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream', file_name TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL, sha256 TEXT NOT NULL DEFAULT '',
  user_id TEXT, outbox_id TEXT, inbound_message_id TEXT, wechat_message_id TEXT,
  error TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ready', created_at INTEGER NOT NULL
);
CREATE TABLE groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE user_groups (
  user_id TEXT NOT NULL, group_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
);
`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-app-rules-migration-'));
const v4Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-app-rules-v4-'));
const v4Path = path.join(v4Dir, 'clawbridge.db');

function createV4Database(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(V4_SCHEMA);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4')").run();
  db.prepare(
    `INSERT INTO users (id, display_name, wechat_user_id, status, bound_at, updated_at, last_inbound_at, keepalive_enabled, keepalive_last_sent_at)
     VALUES ('u_v4_alpha', '真实用户甲', 'wx_v4_alpha', 'active', 1000, 1000, 5000, 1, 6000)`,
  ).run();
  db.prepare(
    `INSERT INTO users (id, display_name, wechat_user_id, status, bound_at, updated_at)
     VALUES ('u_v4_beta', '真实用户乙', 'wx_v4_beta', 'unbound', 2000, 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO outbox (id, user_id, text, source, status, created_at, updated_at) VALUES ('ob_v4_1', 'u_v4_alpha', '历史消息', 'api', 'sent', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO inbound_messages (id, user_id, wechat_message_id, text, item_types, raw_json, created_at, received_at)
     VALUES ('in_v4_1', 'u_v4_alpha', '9007199254746001', '历史入站', '1', '{}', 5000, 5000)`,
  ).run();
  db.prepare(
    `INSERT INTO attachments (id, direction, kind, mime, size, path, status, created_at) VALUES ('att_v4_1', 'outbound', 'image', 'image/png', 3, 'outbound/a.png', 'ready', 1000)`,
  ).run();
  db.prepare("INSERT INTO groups (id, name, created_at, updated_at) VALUES ('grp_v4_1', '真实分组', 1000, 1000)").run();
  db.prepare("INSERT INTO user_groups (user_id, group_id, created_at) VALUES ('u_v4_alpha', 'grp_v4_1', 1000)").run();
  db.prepare("INSERT INTO events (type, user_id, detail, created_at) VALUES ('bind', 'u_v4_alpha', 'v4 event', 1000)").run();
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  db.close();
}

createV4Database(v4Path);

process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'app-rules-migration-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'app-rules-migration-password';
process.env.API_TOKEN = 'app-rules-migration-token';
process.env.LOG_LEVEL = 'silent';

const { openDatabase, SCHEMA_VERSION, closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(v4Dir, { recursive: true, force: true });
});

const count = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
const tableExists = (db, name) =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
const indexExists = (db, name) =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name));

test('v4 → v9 迁移：既有数据零丢失 + app_rules/app_rule_logs + groups 保活列 + v7 定时通知表 + 幂等', () => {
  assert.equal(SCHEMA_VERSION, 9);
  const db = openDatabase(v4Path);
  try {
    assert.equal(count(db, 'users'), 2);
    assert.equal(count(db, 'outbox'), 1);
    assert.equal(count(db, 'inbound_messages'), 1);
    assert.equal(count(db, 'attachments'), 1);
    assert.equal(count(db, 'groups'), 1);
    assert.equal(count(db, 'user_groups'), 1);
    assert.equal(count(db, 'events'), 1);
    const alpha = db.prepare('SELECT * FROM users WHERE id = ?').get('u_v4_alpha');
    assert.equal(alpha.display_name, '真实用户甲');
    assert.equal(Number(alpha.keepalive_enabled), 1);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.ok(tableExists(db, 'scheduled_tasks'), 'scheduled_tasks 表应存在（schema v7）');
    assert.ok(tableExists(db, 'scheduled_task_logs'), 'scheduled_task_logs 表应存在（schema v7）');

    // v6 增量：groups 分组保活列（旧行默认 0）
    const groupColumns = new Set(db.prepare('PRAGMA table_info(groups)').all().map((row) => row.name));
    assert.ok(groupColumns.has('keepalive_enabled'), 'groups.keepalive_enabled 应存在（schema v6）');
    assert.equal(Number(db.prepare("SELECT keepalive_enabled FROM groups WHERE id = 'grp_v4_1'").get().keepalive_enabled), 0);

    // v5 新表/索引
    assert.ok(tableExists(db, 'app_rules'), 'app_rules 表应存在');
    assert.ok(tableExists(db, 'app_rule_logs'), 'app_rule_logs 表应存在');
    for (const index of [
      'idx_app_rules_enabled',
      'idx_app_rule_logs_dedupe',
      'idx_app_rule_logs_rule',
      'idx_app_rule_logs_created',
    ]) {
      assert.ok(indexExists(db, index), `索引 ${index} 应存在`);
    }
    assert.equal(count(db, 'app_rules'), 0);
    assert.equal(count(db, 'app_rule_logs'), 0);

    // 新表可写 + 去重唯一索引生效
    db.prepare(
      `INSERT INTO app_rules (id, name, request_url, created_at, updated_at)
       VALUES ('rule_v5_1', '迁移规则', 'https://api.example.com/x', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO app_rule_logs (rule_id, user_id, inbound_message_id, status, created_at)
       VALUES ('rule_v5_1', 'u_v4_alpha', 'in_v4_1', 'success', 1)`,
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO app_rule_logs (rule_id, user_id, inbound_message_id, status, created_at)
             VALUES ('rule_v5_1', 'u_v4_alpha', 'in_v4_1', 'success', 2)`,
          )
          .run(),
      /UNIQUE|constraint/i,
      '同消息+规则应被去重唯一索引拒绝',
    );
    assert.equal(count(db, 'app_rules'), 1);
    assert.equal(count(db, 'app_rule_logs'), 1);
  } finally {
    db.close();
  }

  // 幂等
  const again = openDatabase(v4Path);
  try {
    assert.equal(again.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.equal(count(again, 'users'), 2);
    assert.equal(count(again, 'app_rules'), 1);
    assert.equal(count(again, 'app_rule_logs'), 1);
    assert.ok(tableExists(again, 'app_rules'));
  } finally {
    again.close();
  }
  const third = openDatabase(v4Path);
  try {
    assert.equal(third.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.equal(count(third, 'users'), 2);
  } finally {
    third.close();
  }
});

test('全新数据库直接创建为 v9 结构', () => {
  const freshPath = path.join(v4Dir, 'fresh.db');
  const db = openDatabase(freshPath);
  try {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.ok(tableExists(db, 'app_rules'));
    assert.ok(tableExists(db, 'app_rule_logs'));
    db.prepare(
      `INSERT INTO app_rules (id, name, request_url, created_at, updated_at) VALUES ('rule_fresh', 'x', 'https://a.example', 1, 1)`,
    ).run();
    assert.equal(count(db, 'app_rules'), 1);
  } finally {
    db.close();
  }
});
