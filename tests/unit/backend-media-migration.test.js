/**
 * 回归测试：DB schema v1 → 最新版本 additive migration（docs/MEDIA.md §4；媒体为 v2 增量）。
 *
 * 用 v1 结构构造临时数据库（含 users/outbox/inbound/events 数据），再用 db.openDatabase
 * 打开升级（v1 → v2（媒体列/attachments）→ v3（groups/user_groups）→ v4（keepalive 列）→ v5（接口应用表）逐级 additive），断言：
 *  - users/outbox/inbound 数据条数与内容不丢；
 *  - attachments 表、outbox.media_id/caption_sent_at 列存在；
 *  - groups/user_groups 表存在；
 *  - meta.schema_version = 当前版本（3）；
 *  - 重复打开（幂等）不报错、不重复加列、数据仍完整；
 *  - 全新数据库直接创建为最新结构。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// 构造 v1 数据库（升级前结构，无 attachments / media_id / caption_sent_at / groups）
// ---------------------------------------------------------------------------
const V1_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  wechat_user_id TEXT NOT NULL,
  ilink_bot_id TEXT,
  token_enc TEXT,
  base_url TEXT NOT NULL DEFAULT '',
  context_token_enc TEXT,
  context_token_updated_at INTEGER NOT NULL DEFAULT 0,
  get_updates_buf TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  bound_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_inbound_at INTEGER NOT NULL DEFAULT 0,
  last_outbound_at INTEGER NOT NULL DEFAULT 0,
  last_poll_at INTEGER NOT NULL DEFAULT 0,
  pause_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX idx_users_wechat ON users(wechat_user_id);
CREATE INDEX idx_users_status ON users(status);
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'api',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  server_message_id TEXT,
  client_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_outbox_status ON outbox(status, next_attempt_at);
CREATE INDEX idx_outbox_user ON outbox(user_id, created_at DESC);
CREATE TABLE inbound_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  wechat_message_id TEXT,
  from_user_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  item_types TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_inbound_msgid ON inbound_messages(wechat_message_id)
  WHERE wechat_message_id IS NOT NULL AND wechat_message_id <> '';
CREATE INDEX idx_inbound_user ON inbound_messages(user_id, created_at DESC);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  user_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-media-migration-'));
const v1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-media-v1-'));
const v1Path = path.join(v1Dir, 'clawbridge.db');

/** 创建带数据的 v1 数据库。 */
function createV1Database(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(V1_SCHEMA);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  db.prepare(
    `INSERT INTO users (id, display_name, wechat_user_id, ilink_bot_id, token_enc, base_url, status, bound_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run('u_v1_alpha', '用户甲', 'wx_v1_alpha', 'bot_alpha@im.bot', 'v1.fake.cipher.alpha', 'https://old.example', 1000, 1000);
  db.prepare(
    `INSERT INTO users (id, display_name, wechat_user_id, ilink_bot_id, token_enc, base_url, status, bound_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'unbound', ?, ?)`,
  ).run('u_v1_beta', '用户乙', 'wx_v1_beta', null, null, '', 2000, 2000);
  for (const [id, userId, text, status] of [
    ['ob_v1_1', 'u_v1_alpha', '历史文本 1', 'sent'],
    ['ob_v1_2', 'u_v1_alpha', '历史文本 2', 'failed'],
    ['ob_v1_3', 'u_v1_beta', '历史文本 3', 'queued'],
  ]) {
    db.prepare(
      `INSERT INTO outbox (id, user_id, text, source, status, attempts, created_at, updated_at, sent_at)
       VALUES (?, ?, ?, 'api', ?, 1, 1000, 1000, 0)`,
    ).run(id, userId, text, status);
  }
  db.prepare(
    `INSERT INTO inbound_messages (id, user_id, wechat_message_id, from_user_id, text, item_types, raw_json, created_at, received_at)
     VALUES (?, ?, ?, ?, ?, '1', ?, 1000, 1000)`,
  ).run('in_v1_1', 'u_v1_alpha', '9007199254740995', 'wx_v1_alpha', '历史入站', '{"text":"历史入站"}');
  db.prepare(
    `INSERT INTO inbound_messages (id, user_id, wechat_message_id, from_user_id, text, item_types, raw_json, created_at, received_at)
     VALUES (?, ?, ?, ?, ?, '1', ?, 2000, 2000)`,
  ).run('in_v1_2', 'u_v1_alpha', '9007199254740997', 'wx_v1_alpha', '历史入站2', '{"text":"历史入站2"}');
  db.prepare("INSERT INTO events (type, user_id, detail, created_at) VALUES ('bind', 'u_v1_alpha', 'v1 event', 1000)").run();
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  db.close();
}

createV1Database(v1Path);

// config 在 import 时求值：DATA_DIR 指向独立临时目录（单例 DB），不污染 v1 数据库
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'media-migration-secret-0123456789abcdef0123456789abcdef';
process.env.ADMIN_PASSWORD = 'media-migration-password';
process.env.API_TOKEN = 'media-migration-token';
process.env.LOG_LEVEL = 'silent';

const { openDatabase, SCHEMA_VERSION, closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(v1Dir, { recursive: true, force: true });
});

const tableColumns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
const tableExists = (db, name) =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
const count = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);

test('v1 → v9 迁移（逐级 additive）：既有 users/outbox/inbound 数据保留 + 新增表/列', () => {
  assert.equal(SCHEMA_VERSION, 9);
  const db = openDatabase(v1Path);
  try {
    // 数据不丢
    assert.equal(count(db, 'users'), 2);
    assert.equal(count(db, 'outbox'), 3);
    assert.equal(count(db, 'inbound_messages'), 2);
    assert.equal(count(db, 'events'), 1);
    assert.equal(count(db, 'attachments'), 0);
    const alpha = db.prepare('SELECT * FROM users WHERE id = ?').get('u_v1_alpha');
    assert.equal(alpha.display_name, '用户甲');
    assert.equal(alpha.token_enc, 'v1.fake.cipher.alpha');
    const oldOutbox = db.prepare('SELECT * FROM outbox WHERE id = ?').get('ob_v1_1');
    assert.equal(oldOutbox.text, '历史文本 1');
    assert.equal(oldOutbox.status, 'sent');
    assert.equal(oldOutbox.media_id, null, '旧 outbox 行 media_id 应为 NULL');
    assert.equal(Number(oldOutbox.caption_sent_at), 0, '旧 outbox 行 caption_sent_at 应为 0');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.ok(tableExists(db, 'app_rules'), 'app_rules 表应存在（schema v5）');
    assert.ok(tableExists(db, 'app_rule_logs'), 'app_rule_logs 表应存在（schema v5）');

    // v2 增量：媒体列/attachments 表
    const outboxColumns = tableColumns(db, 'outbox');
    assert.ok(outboxColumns.has('media_id'));
    assert.ok(outboxColumns.has('caption_sent_at'));
    assert.ok(tableExists(db, 'attachments'), 'attachments 表应存在');
    for (const index of ['idx_attachments_outbox', 'idx_attachments_inbound', 'idx_attachments_user']) {
      assert.ok(
        db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(index),
        `索引 ${index} 应存在`,
      );
    }
    // v3 增量：groups/user_groups 表
    assert.ok(tableExists(db, 'groups'), 'groups 表应存在');
    assert.ok(tableExists(db, 'user_groups'), 'user_groups 表应存在');
    for (const index of ['idx_groups_name', 'idx_user_groups_group', 'idx_user_groups_user']) {
      assert.ok(
        db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(index),
        `索引 ${index} 应存在`,
      );
    }

    // 新结构可正常写入（v2 + v3 业务可用）
    db.prepare(
      `INSERT INTO attachments (id, direction, kind, mime, file_name, size, path, sha256, status, created_at)
       VALUES ('att_v1_upgrade', 'outbound', 'image', 'image/png', 'a.png', 3, 'outbound/att_v1_upgrade.png', '', 'ready', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO outbox (id, user_id, text, source, status, attempts, media_id, caption_sent_at, created_at, updated_at)
       VALUES ('ob_v2_new', 'u_v1_alpha', 'caption', 'admin', 'queued', 0, 'att_v1_upgrade', 0, 3000, 3000)`,
    ).run();
    assert.equal(db.prepare('SELECT media_id FROM outbox WHERE id = ?').get('ob_v2_new').media_id, 'att_v1_upgrade');
    db.prepare('INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)').run('grp_v1_upgrade', '迁移组');
    db.prepare('INSERT INTO user_groups (user_id, group_id, created_at) VALUES (?, ?, 1)').run(
      'u_v1_alpha',
      'grp_v1_upgrade',
    );
    assert.equal(count(db, 'groups'), 1);
    assert.equal(count(db, 'user_groups'), 1);
  } finally {
    db.close();
  }

  // 幂等：再次打开（已升级库）不报错、数据与列不变
  const again = openDatabase(v1Path);
  try {
    assert.equal(again.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.equal(count(again, 'users'), 2);
    assert.equal(count(again, 'outbox'), 4);
    assert.equal(count(again, 'inbound_messages'), 2);
    assert.equal(count(again, 'attachments'), 1);
    assert.equal(count(again, 'groups'), 1);
    assert.equal(count(again, 'user_groups'), 1);
    assert.equal(tableColumns(again, 'outbox').has('media_id'), true);
    assert.equal(tableColumns(again, 'outbox').has('caption_sent_at'), true);
  } finally {
    again.close();
  }
  const third = openDatabase(v1Path);
  try {
    assert.equal(third.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    assert.equal(count(third, 'users'), 2);
  } finally {
    third.close();
  }
});

test('全新数据库直接创建为最新（v9）结构', () => {
  const freshPath = path.join(v1Dir, 'fresh.db');
  const db = openDatabase(freshPath);
  try {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
    const outboxColumns = tableColumns(db, 'outbox');
    assert.ok(outboxColumns.has('media_id'));
    assert.ok(outboxColumns.has('caption_sent_at'));
    assert.ok(tableExists(db, 'attachments'), 'attachments 表应存在');
    assert.ok(tableExists(db, 'groups'), 'groups 表应存在');
    assert.ok(tableExists(db, 'user_groups'), 'user_groups 表应存在');
    // 新库可直接插入带媒体列/分组的行
    db.prepare('INSERT INTO users (id, display_name, wechat_user_id, bound_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(
      'u_fresh',
      '新用户',
      'wx_fresh',
    );
    db.prepare(
      `INSERT INTO outbox (id, user_id, text, source, status, media_id, caption_sent_at, created_at, updated_at)
       VALUES ('ob_fresh', 'u_fresh', '', 'api', 'queued', NULL, 0, 1, 1)`,
    ).run();
    db.prepare('INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)').run('grp_fresh', '新分组');
    assert.equal(count(db, 'outbox'), 1);
    assert.equal(count(db, 'groups'), 1);
  } finally {
    db.close();
  }
});
