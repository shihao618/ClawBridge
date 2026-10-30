/**
 * 回归测试：DB schema v3 → v6 additive migration（v4 保活列 + v5 接口应用表 + v6 分组保活列；docs/KEEPALIVE.md §1）。
 *
 * 用 v3 结构构造临时数据库（含 users/outbox/inbound/attachments/events/groups/user_groups 数据），
 * 再用 db.openDatabase 升级到 v4，断言：
 *  - v3 全部数据条数与样本不丢；
 *  - users 新增 keepalive_enabled/keepalive_last_sent_at 列，旧行默认 0；
 *  - meta.schema_version = 4；重复打开（幂等）；全新库直接 v4。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

// v3 结构（含媒体 v2 + 分组 v3，无 keepalive 列）
const V3_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '', wechat_user_id TEXT NOT NULL,
  ilink_bot_id TEXT, token_enc TEXT, base_url TEXT NOT NULL DEFAULT '',
  context_token_enc TEXT, context_token_updated_at INTEGER NOT NULL DEFAULT 0,
  get_updates_buf TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
  bound_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_inbound_at INTEGER NOT NULL DEFAULT 0, last_outbound_at INTEGER NOT NULL DEFAULT 0,
  last_poll_at INTEGER NOT NULL DEFAULT 0, pause_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX idx_users_wechat ON users(wechat_user_id);
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
CREATE UNIQUE INDEX idx_inbound_msgid ON inbound_messages(wechat_message_id)
  WHERE wechat_message_id IS NOT NULL AND wechat_message_id <> '';
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
CREATE UNIQUE INDEX idx_groups_name ON groups(name);
CREATE TABLE user_groups (
  user_id TEXT NOT NULL, group_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
);
`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-keepalive-migration-'));
const v3Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-keepalive-v3-'));
const v3Path = path.join(v3Dir, 'clawbridge.db');

function createV3Database(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(V3_SCHEMA);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3')").run();
  db.prepare(
    `INSERT INTO users (id, display_name, wechat_user_id, ilink_bot_id, token_enc, base_url, status, bound_at, updated_at, last_inbound_at)
     VALUES ('u_v3_alpha', '真实用户甲', 'wx_v3_alpha', 'bot_a@im.bot', 'v1.cipher.a', 'https://old', 'active', 1000, 1000, 5000)`,
  ).run();
  db.prepare(
    `INSERT INTO users (id, display_name, wechat_user_id, status, bound_at, updated_at)
     VALUES ('u_v3_beta', '真实用户乙', 'wx_v3_beta', 'unbound', 2000, 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO outbox (id, user_id, text, source, status, media_id, created_at, updated_at)
     VALUES ('ob_v3_1', 'u_v3_alpha', '历史消息', 'api', 'sent', 'att_v3_1', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO inbound_messages (id, user_id, wechat_message_id, from_user_id, text, item_types, raw_json, created_at, received_at)
     VALUES ('in_v3_1', 'u_v3_alpha', '9007199254745001', 'wx_v3_alpha', '历史入站', '1', '{}', 5000, 5000)`,
  ).run();
  db.prepare(
    `INSERT INTO attachments (id, direction, kind, mime, size, path, status, user_id, created_at)
     VALUES ('att_v3_1', 'outbound', 'image', 'image/png', 3, 'outbound/a.png', 'ready', 'u_v3_alpha', 1000)`,
  ).run();
  db.prepare("INSERT INTO groups (id, name, color, created_at, updated_at) VALUES ('grp_v3_1', '真实分组', '#07C160', 1000, 1000)").run();
  db.prepare("INSERT INTO user_groups (user_id, group_id, created_at) VALUES ('u_v3_alpha', 'grp_v3_1', 1000)").run();
  db.prepare("INSERT INTO events (type, user_id, detail, created_at) VALUES ('bind', 'u_v3_alpha', 'v3 event', 1000)").run();
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  db.close();
}

createV3Database(v3Path);

process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'keepalive-migration-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'keepalive-migration-password';
process.env.API_TOKEN = 'keepalive-migration-token';
process.env.LOG_LEVEL = 'silent';

const { openDatabase, SCHEMA_VERSION, closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(v3Dir, { recursive: true, force: true });
});

const count = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
const userColumns = (db) => new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));

test('v3 → v9 迁移：既有数据保留 + keepalive 列默认值 + v5 接口应用表 + v6 分组保活列 + 幂等', () => {
  assert.equal(SCHEMA_VERSION, 9);
  const db = openDatabase(v3Path);
  try {
    // 数据不丢
    assert.equal(count(db, 'users'), 2);
    assert.equal(count(db, 'outbox'), 1);
    assert.equal(count(db, 'inbound_messages'), 1);
    assert.equal(count(db, 'attachments'), 1);
    assert.equal(count(db, 'events'), 1);
    assert.equal(count(db, 'groups'), 1);
    assert.equal(count(db, 'user_groups'), 1);
    assert.equal(db.prepare('SELECT display_name FROM users WHERE id = ?').get('u_v3_alpha').display_name, '真实用户甲');
    assert.equal(db.prepare('SELECT media_id FROM outbox WHERE id = ?').get('ob_v3_1').media_id, 'att_v3_1');
    assert.equal(db.prepare('SELECT text FROM inbound_messages WHERE id = ?').get('in_v3_1').text, '历史入站');
    assert.equal(db.prepare('SELECT name FROM groups WHERE id = ?').get('grp_v3_1').name, '真实分组');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    for (const table of ['app_rules', 'app_rule_logs']) {
      assert.ok(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
        `${table} 表应存在（schema v5）`,
      );
    }

    // 新增列 + 旧行默认值 0
    const columns = userColumns(db);
    assert.ok(columns.has('keepalive_enabled'), 'users.keepalive_enabled 应存在');
    assert.ok(columns.has('keepalive_last_sent_at'), 'users.keepalive_last_sent_at 应存在');
    for (const row of db.prepare('SELECT keepalive_enabled, keepalive_last_sent_at FROM users').all()) {
      assert.equal(Number(row.keepalive_enabled), 0, '旧用户 keepalive_enabled 默认 0');
      assert.equal(Number(row.keepalive_last_sent_at), 0, '旧用户 keepalive_last_sent_at 默认 0');
    }

    // 新列可写
    db.prepare('UPDATE users SET keepalive_enabled = 1, keepalive_last_sent_at = ? WHERE id = ?').run(5000, 'u_v3_alpha');
    const updated = db.prepare('SELECT keepalive_enabled, keepalive_last_sent_at FROM users WHERE id = ?').get('u_v3_alpha');
    assert.equal(Number(updated.keepalive_enabled), 1);
    assert.equal(Number(updated.keepalive_last_sent_at), 5000);
  } finally {
    db.close();
  }

  // 幂等：重复打开（已 v4）数据/列稳定
  const again = openDatabase(v3Path);
  try {
    assert.equal(again.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.equal(count(again, 'users'), 2);
    assert.equal(count(again, 'outbox'), 1);
    assert.equal(count(again, 'inbound_messages'), 1);
    assert.equal(count(again, 'groups'), 1);
    assert.equal(userColumns(again).has('keepalive_enabled'), true);
    assert.equal(Number(again.prepare('SELECT keepalive_enabled FROM users WHERE id = ?').get('u_v3_alpha').keepalive_enabled), 1);
  } finally {
    again.close();
  }
  const third = openDatabase(v3Path);
  try {
    assert.equal(third.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.equal(count(third, 'users'), 2);
  } finally {
    third.close();
  }
});

test('全新数据库直接创建为 v9 结构', () => {
  const freshPath = path.join(v3Dir, 'fresh.db');
  const db = openDatabase(freshPath);
  try {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    const columns = userColumns(db);
    assert.ok(columns.has('keepalive_enabled'));
    assert.ok(columns.has('keepalive_last_sent_at'));
    db.prepare('INSERT INTO users (id, display_name, wechat_user_id, bound_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(
      'u_fresh',
      '新用户',
      'wx_fresh',
    );
    const row = db.prepare('SELECT keepalive_enabled, keepalive_last_sent_at FROM users WHERE id = ?').get('u_fresh');
    assert.equal(Number(row.keepalive_enabled), 0);
    assert.equal(Number(row.keepalive_last_sent_at), 0);
  } finally {
    db.close();
  }
});
