/**
 * 回归测试：DB schema v6 → v8 additive migration（v7 定时通知 + v8 运行配置；docs/SCHEDULED_TASKS.md §1、docs/SETTINGS.md §1）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const V6_SCHEMA = `
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
  color TEXT NOT NULL DEFAULT '', keepalive_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE user_groups (
  user_id TEXT NOT NULL, group_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
);
CREATE TABLE app_rules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 100,
  scope_type TEXT NOT NULL DEFAULT 'all', scope_ids TEXT NOT NULL DEFAULT '[]',
  match_mode TEXT NOT NULL DEFAULT 'contains', keywords TEXT NOT NULL DEFAULT '[]',
  regex_pattern TEXT NOT NULL DEFAULT '', extraction_mode TEXT NOT NULL DEFAULT 'trailing',
  extraction_config TEXT NOT NULL DEFAULT '{}', request_method TEXT NOT NULL DEFAULT 'GET',
  request_url TEXT NOT NULL, request_headers_enc TEXT, request_body_template TEXT NOT NULL DEFAULT '',
  response_type TEXT NOT NULL DEFAULT 'json', response_path TEXT NOT NULL DEFAULT '',
  reply_template TEXT NOT NULL DEFAULT '', fallback_text TEXT NOT NULL DEFAULT '',
  timeout_ms INTEGER NOT NULL DEFAULT 8000, cooldown_ms INTEGER NOT NULL DEFAULT 10000,
  max_calls_per_hour INTEGER NOT NULL DEFAULT 60, max_user_calls_per_hour INTEGER NOT NULL DEFAULT 10,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE app_rule_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id TEXT NOT NULL, user_id TEXT, inbound_message_id TEXT,
  status TEXT NOT NULL, http_status INTEGER, latency_ms INTEGER, error TEXT NOT NULL DEFAULT '',
  params_preview TEXT NOT NULL DEFAULT '', request_preview TEXT NOT NULL DEFAULT '',
  response_preview TEXT NOT NULL DEFAULT '', reply_outbox_id TEXT, created_at INTEGER NOT NULL
);
`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-sched-migration-'));
const v6Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-sched-v6-'));
const v6Path = path.join(v6Dir, 'clawbridge.db');

function createV6Database(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(V6_SCHEMA);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '6')").run();
  db.prepare(
    `INSERT INTO users (id, display_name, wechat_user_id, status, bound_at, updated_at, last_inbound_at, keepalive_enabled)
     VALUES ('u_v6_alpha', '真实用户甲', 'wx_v6_alpha', 'active', 1000, 1000, 5000, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO users (id, display_name, wechat_user_id, status, bound_at, updated_at)
     VALUES ('u_v6_beta', '真实用户乙', 'wx_v6_beta', 'unbound', 2000, 2000)`,
  ).run();
  db.prepare(`INSERT INTO outbox (id, user_id, text, source, status, created_at, updated_at) VALUES ('ob_v6_1', 'u_v6_alpha', '历史消息', 'api', 'sent', 1000, 1000)`).run();
  db.prepare(`INSERT INTO inbound_messages (id, user_id, wechat_message_id, text, item_types, raw_json, created_at, received_at) VALUES ('in_v6_1', 'u_v6_alpha', '9007199254747001', '历史入站', '1', '{}', 5000, 5000)`).run();
  db.prepare(`INSERT INTO attachments (id, direction, kind, mime, size, path, status, created_at) VALUES ('att_v6_1', 'outbound', 'image', 'image/png', 3, 'outbound/a.png', 'ready', 1000)`).run();
  db.prepare(`INSERT INTO groups (id, name, keepalive_enabled, created_at, updated_at) VALUES ('grp_v6_1', '真实分组', 1, 1000, 1000)`).run();
  db.prepare(`INSERT INTO user_groups (user_id, group_id, created_at) VALUES ('u_v6_alpha', 'grp_v6_1', 1000)`).run();
  db.prepare(`INSERT INTO events (type, user_id, detail, created_at) VALUES ('bind', 'u_v6_alpha', 'v6 event', 1000)`).run();
  db.prepare(
    `INSERT INTO app_rules (id, name, request_url, created_at, updated_at) VALUES ('rule_v6_1', '历史规则', 'https://api.example.com/x', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO app_rule_logs (rule_id, user_id, inbound_message_id, status, created_at) VALUES ('rule_v6_1', 'u_v6_alpha', 'in_v6_1', 'success', 1)`,
  ).run();
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  db.close();
}

createV6Database(v6Path);

process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'sched-migration-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'sched-migration-password';
process.env.API_TOKEN = 'sched-migration-token';
process.env.LOG_LEVEL = 'silent';

const { openDatabase, SCHEMA_VERSION, closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(v6Dir, { recursive: true, force: true });
});

const count = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
const tableExists = (db, name) =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
const indexExists = (db, name) =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name));

test('v6 → v8 迁移：既有数据零丢失 + scheduled_tasks/scheduled_task_logs 表/索引 + app_settings 表 + 幂等', () => {
  assert.equal(SCHEMA_VERSION, 8);
  const db = openDatabase(v6Path);
  try {
    assert.equal(count(db, 'users'), 2);
    assert.equal(count(db, 'outbox'), 1);
    assert.equal(count(db, 'inbound_messages'), 1);
    assert.equal(count(db, 'attachments'), 1);
    assert.equal(count(db, 'groups'), 1);
    assert.equal(count(db, 'user_groups'), 1);
    assert.equal(count(db, 'events'), 1);
    assert.equal(count(db, 'app_rules'), 1);
    assert.equal(count(db, 'app_rule_logs'), 1);
    const alpha = db.prepare('SELECT * FROM users WHERE id = ?').get('u_v6_alpha');
    assert.equal(alpha.display_name, '真实用户甲');
    assert.equal(Number(alpha.keepalive_enabled), 1);
    assert.equal(db.prepare('SELECT name FROM groups WHERE id = ?').get('grp_v6_1').name, '真实分组');
    assert.equal(Number(db.prepare('SELECT keepalive_enabled FROM groups WHERE id = ?').get('grp_v6_1').keepalive_enabled), 1);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '8');
    // v8 新表：运行配置（初始为空，使用 env 默认值）
    assert.ok(tableExists(db, 'app_settings'), 'app_settings 表应存在（schema v8）');
    assert.equal(count(db, 'app_settings'), 0);

    // v7 新表/索引
    assert.ok(tableExists(db, 'scheduled_tasks'), 'scheduled_tasks 表应存在');
    assert.ok(tableExists(db, 'scheduled_task_logs'), 'scheduled_task_logs 表应存在');
    for (const index of ['idx_scheduled_tasks_due', 'idx_scheduled_task_logs_task', 'idx_scheduled_task_logs_created']) {
      assert.ok(indexExists(db, index), `索引 ${index} 应存在`);
    }
    assert.equal(count(db, 'scheduled_tasks'), 0);
    assert.equal(count(db, 'scheduled_task_logs'), 0);

    // 新表可写（默认值正确）
    db.prepare(
      `INSERT INTO scheduled_tasks (id, name, request_url, created_at, updated_at)
       VALUES ('task_v7_1', '迁移任务', 'https://api.example.com/x', 1, 1)`,
    ).run();
    const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get('task_v7_1');
    assert.equal(task.enabled, 1);
    assert.equal(task.schedule_type, 'interval');
    assert.equal(task.interval_ms, 3600000);
    assert.equal(task.target_type, 'users');
    assert.equal(task.next_run_at, 0);
    db.prepare(
      `INSERT INTO scheduled_task_logs (task_id, status, recipients_count, created_at) VALUES ('task_v7_1', 'success', 2, 1)`,
    ).run();
    assert.equal(count(db, 'scheduled_task_logs'), 1);
  } finally {
    db.close();
  }

  // 幂等
  const again = openDatabase(v6Path);
  try {
    assert.equal(again.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '8');
    assert.equal(count(again, 'users'), 2);
    assert.equal(count(again, 'scheduled_tasks'), 1);
    assert.ok(tableExists(again, 'scheduled_tasks'));
  } finally {
    again.close();
  }
  const third = openDatabase(v6Path);
  try {
    assert.equal(third.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '8');
    assert.equal(count(third, 'users'), 2);
  } finally {
    third.close();
  }
});

test('全新数据库直接创建为 v8 结构', () => {
  const freshPath = path.join(v6Dir, 'fresh.db');
  const db = openDatabase(freshPath);
  try {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '8');
    assert.ok(tableExists(db, 'scheduled_tasks'));
    assert.ok(tableExists(db, 'scheduled_task_logs'));
    db.prepare(
      `INSERT INTO scheduled_tasks (id, name, request_url, created_at, updated_at) VALUES ('task_fresh', 'x', 'https://a.example', 1, 1)`,
    ).run();
    assert.equal(count(db, 'scheduled_tasks'), 1);
  } finally {
    db.close();
  }
});
