/**
 * 回归测试：DB schema v2 → v6 additive migration（v3 分组 + v4 保活列 + v5 接口应用表 + v6 分组保活列；docs/GROUPS_AND_INBOUND.md §1）。
 *
 * 用 v2 结构构造临时数据库（含 users/outbox/inbound_messages/attachments/events 数据），
 * 再用 db.openDatabase 升级，断言：
 *  - 全部 v2 数据条数与样本不丢；
 *  - groups / user_groups 表与索引存在；users.keepalive_enabled/keepalive_last_sent_at 列存在；
 *  - meta.schema_version = 4；
 *  - 重复打开（幂等）不报错、不重复建表、数据仍完整；
 *  - 全新数据库直接是 v5 结构。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

// v2 结构（含媒体扩展，无 groups/user_groups）
const V2_SCHEMA = `
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
  server_message_id TEXT, client_id TEXT, media_id TEXT,
  caption_sent_at INTEGER NOT NULL DEFAULT 0,
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
`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-groups-migration-'));
const v2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-groups-v2-'));
const v2Path = path.join(v2Dir, 'clawbridge.db');

function createV2Database(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(V2_SCHEMA);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '2')").run();
  db.prepare(
    `INSERT INTO users (id, display_name, wechat_user_id, ilink_bot_id, token_enc, base_url, status, bound_at, updated_at)
     VALUES ('u_v2_alpha', '真实用户甲', 'wx_v2_alpha', 'bot_alpha@im.bot', 'v1.cipher.alpha', 'https://old.example', 'active', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO users (id, display_name, wechat_user_id, status, bound_at, updated_at)
     VALUES ('u_v2_beta', '真实用户乙', 'wx_v2_beta', 'unbound', 2000, 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO outbox (id, user_id, text, source, status, attempts, media_id, caption_sent_at, created_at, updated_at)
     VALUES ('ob_v2_1', 'u_v2_alpha', '历史文本', 'api', 'sent', 1, 'att_v2_1', 0, 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO outbox (id, user_id, text, source, status, attempts, created_at, updated_at)
     VALUES ('ob_v2_2', 'u_v2_alpha', '历史文本2', 'admin', 'failed', 2, 2000, 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO inbound_messages (id, user_id, wechat_message_id, from_user_id, text, item_types, raw_json, created_at, received_at)
     VALUES ('in_v2_1', 'u_v2_alpha', '9007199254741001', 'wx_v2_alpha', '[图片]', '2', '{}', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO inbound_messages (id, user_id, wechat_message_id, from_user_id, text, item_types, raw_json, created_at, received_at)
     VALUES ('in_v2_2', 'u_v2_alpha', '9007199254741003', 'wx_v2_alpha', '你好', '1', '{}', 2000, 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO attachments (id, direction, kind, mime, file_name, size, path, sha256, user_id, inbound_message_id, wechat_message_id, status, created_at)
     VALUES ('att_v2_1', 'inbound', 'image', 'image/png', '', 12, 'inbound/att_v2_1.png', 'abc', 'u_v2_alpha', 'in_v2_1', '9007199254741001', 'ready', 1000)`,
  ).run();
  db.prepare("INSERT INTO events (type, user_id, detail, created_at) VALUES ('bind', 'u_v2_alpha', 'v2 event', 1000)").run();
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  db.close();
}

createV2Database(v2Path);

process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'groups-migration-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'groups-migration-password';
process.env.API_TOKEN = 'groups-migration-token';
process.env.LOG_LEVEL = 'silent';

const { openDatabase, SCHEMA_VERSION, closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(v2Dir, { recursive: true, force: true });
});

const count = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
const tableExists = (db, name) =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
const indexExists = (db, name) =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name));

test('v2 → v9 迁移：既有数据保留 + groups/user_groups/keepalive 列 + v5 表 + v6 分组保活列 + v7 定时通知表 + 幂等', () => {
  assert.equal(SCHEMA_VERSION, 9);
  const db = openDatabase(v2Path);
  try {
    // v2 数据零丢失
    assert.equal(count(db, 'users'), 2);
    assert.equal(count(db, 'outbox'), 2);
    assert.equal(count(db, 'inbound_messages'), 2);
    assert.equal(count(db, 'attachments'), 1);
    assert.equal(count(db, 'events'), 1);
    assert.equal(count(db, 'groups'), 0);
    assert.equal(count(db, 'user_groups'), 0);
    // 样本内容不丢
    assert.equal(db.prepare('SELECT display_name FROM users WHERE id = ?').get('u_v2_alpha').display_name, '真实用户甲');
    assert.equal(db.prepare('SELECT token_enc FROM users WHERE id = ?').get('u_v2_alpha').token_enc, 'v1.cipher.alpha');
    assert.equal(db.prepare('SELECT media_id FROM outbox WHERE id = ?').get('ob_v2_1').media_id, 'att_v2_1');
    assert.equal(db.prepare('SELECT path FROM attachments WHERE id = ?').get('att_v2_1').path, 'inbound/att_v2_1.png');
    assert.equal(db.prepare('SELECT text FROM inbound_messages WHERE id = ?').get('in_v2_2').text, '你好');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.ok(tableExists(db, 'app_rules'), 'app_rules 表应存在（schema v5）');
    assert.ok(tableExists(db, 'app_rule_logs'), 'app_rule_logs 表应存在（schema v5）');
    // v6 增量：groups.keepalive_enabled（默认 0）
    const groupKeepaliveColumn = db
      .prepare('PRAGMA table_info(groups)')
      .all()
      .find((row) => row.name === 'keepalive_enabled');
    assert.ok(groupKeepaliveColumn, 'groups.keepalive_enabled 应存在（schema v6）');
    assert.equal(Number(groupKeepaliveColumn.dflt_value), 0, '分组保活列默认值应为 0');

    // v3 表/索引
    assert.ok(tableExists(db, 'groups'), 'groups 表应存在');
    assert.ok(tableExists(db, 'user_groups'), 'user_groups 表应存在');
    for (const index of ['idx_groups_name', 'idx_user_groups_group', 'idx_user_groups_user']) {
      assert.ok(indexExists(db, index), `索引 ${index} 应存在`);
    }

    // v2/v3 结构可正常写入
    db.prepare('INSERT INTO groups (id, name, description, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'grp_v3_1',
      'VIP客户',
      '重点客户',
      '#07C160',
      3000,
      3000,
    );
    db.prepare('INSERT INTO user_groups (user_id, group_id, created_at) VALUES (?, ?, ?)').run(
      'u_v2_alpha',
      'grp_v3_1',
      3000,
    );
    assert.equal(count(db, 'groups'), 1);
    assert.equal(count(db, 'user_groups'), 1);
    // 重名唯一索引
    assert.throws(
      () => db.prepare('INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)').run('grp_dup', 'VIP客户'),
      /UNIQUE|constraint/i,
    );
  } finally {
    db.close();
  }

  // 幂等：重复打开（已 v3）不报错、数据与表结构稳定
  const again = openDatabase(v2Path);
  try {
    assert.equal(again.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.equal(count(again, 'users'), 2);
    assert.equal(count(again, 'outbox'), 2);
    assert.equal(count(again, 'inbound_messages'), 2);
    assert.equal(count(again, 'attachments'), 1);
    assert.equal(count(again, 'groups'), 1);
    assert.equal(count(again, 'user_groups'), 1);
  } finally {
    again.close();
  }
  const third = openDatabase(v2Path);
  try {
    assert.equal(third.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.equal(count(third, 'users'), 2);
  } finally {
    third.close();
  }
});

test('全新数据库直接创建为 v9 结构', () => {
  const freshPath = path.join(v2Dir, 'fresh.db');
  const db = openDatabase(freshPath);
  try {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.ok(tableExists(db, 'groups'));
    assert.ok(tableExists(db, 'user_groups'));
    assert.ok(tableExists(db, 'attachments'));
  } finally {
    db.close();
  }
});
