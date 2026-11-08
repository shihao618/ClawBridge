/**
 * SQLite 数据库（Node 内置 node:sqlite，零第三方依赖），全新基线 schema v1。
 *
 * 约定：
 * - 本版本为全新数据基线：全新数据库自动建表；检测到任何其他 schema_version 直接拒绝启动，
 *   不包含任何迁移/升级逻辑（旧数据需使用全新数据卷重新开始）；
 * - 外键/CHECK 约束/索引一次建好；开启 WAL、foreign_keys、auto_vacuum=INCREMENTAL；
 * - 单进程单连接；所有业务写操作经由 data/** 模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { config } from './config.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'db' });

/** 全新数据基线版本：0 = 空库（自动建表），其它值一律拒绝。 */
export const SCHEMA_VERSION = 1;

/** SQLite synchronous 级别（WAL 下默认 NORMAL；可用 DB_SYNCHRONOUS=FULL 收紧）。 */
function resolveSynchronous() {
  const raw = String(process.env.DB_SYNCHRONOUS ?? 'NORMAL').trim().toUpperCase();
  return raw === 'FULL' ? 'FULL' : 'NORMAL';
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  wechat_user_id TEXT NOT NULL,
  ilink_bot_id TEXT,
  token_enc TEXT,
  base_url TEXT NOT NULL DEFAULT '',
  context_token_enc TEXT,
  context_token_updated_at INTEGER NOT NULL DEFAULT 0,
  get_updates_buf TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unbound')),
  bound_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_inbound_at INTEGER NOT NULL DEFAULT 0,
  last_outbound_at INTEGER NOT NULL DEFAULT 0,
  last_poll_at INTEGER NOT NULL DEFAULT 0,
  pause_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  keepalive_enabled INTEGER NOT NULL DEFAULT 0 CHECK (keepalive_enabled IN (0, 1)),
  keepalive_last_sent_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wechat ON users(wechat_user_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status, bound_at);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  keepalive_enabled INTEGER NOT NULL DEFAULT 0 CHECK (keepalive_enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name ON groups(name);

CREATE TABLE IF NOT EXISTS user_groups (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_user_groups_group ON user_groups(group_id);
CREATE INDEX IF NOT EXISTS idx_user_groups_user ON user_groups(user_id);

CREATE TABLE IF NOT EXISTS app_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 100,
  scope_type TEXT NOT NULL DEFAULT 'all' CHECK (scope_type IN ('all', 'users', 'groups')),
  scope_ids TEXT NOT NULL DEFAULT '[]',
  match_mode TEXT NOT NULL DEFAULT 'contains' CHECK (match_mode IN ('contains', 'equals', 'regex')),
  keywords TEXT NOT NULL DEFAULT '[]',
  regex_pattern TEXT NOT NULL DEFAULT '',
  extraction_mode TEXT NOT NULL DEFAULT 'multi' CHECK (extraction_mode IN ('none', 'multi')),
  extraction_config TEXT NOT NULL DEFAULT '{}',
  request_method TEXT NOT NULL DEFAULT 'GET' CHECK (request_method IN ('GET', 'POST')),
  request_url TEXT NOT NULL,
  request_headers_enc TEXT,
  request_body_template TEXT NOT NULL DEFAULT '',
  response_type TEXT NOT NULL DEFAULT 'json' CHECK (response_type IN ('json', 'text')),
  response_path TEXT NOT NULL DEFAULT '',
  reply_template TEXT NOT NULL DEFAULT '',
  fallback_text TEXT NOT NULL DEFAULT '',
  timeout_ms INTEGER NOT NULL DEFAULT 8000,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_rules_enabled ON app_rules(enabled, priority, created_at);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  schedule_type TEXT NOT NULL DEFAULT 'interval' CHECK (schedule_type IN ('interval', 'daily')),
  interval_ms INTEGER NOT NULL DEFAULT 3600000,
  daily_time TEXT NOT NULL DEFAULT '08:00',
  window_start TEXT NOT NULL DEFAULT '',
  window_end TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT 'users' CHECK (target_type IN ('all', 'users', 'groups')),
  target_ids TEXT NOT NULL DEFAULT '[]',
  per_user_mode INTEGER NOT NULL DEFAULT 0 CHECK (per_user_mode IN (0, 1)),
  request_method TEXT NOT NULL DEFAULT 'GET' CHECK (request_method IN ('GET', 'POST')),
  request_url TEXT NOT NULL,
  request_headers_enc TEXT,
  request_body_template TEXT NOT NULL DEFAULT '',
  response_type TEXT NOT NULL DEFAULT 'json' CHECK (response_type IN ('json', 'text')),
  response_path TEXT NOT NULL DEFAULT '',
  reply_template TEXT NOT NULL DEFAULT '',
  fallback_text TEXT NOT NULL DEFAULT '',
  timeout_ms INTEGER NOT NULL DEFAULT 8000,
  last_run_at INTEGER NOT NULL DEFAULT 0,
  last_status TEXT NOT NULL DEFAULT '' CHECK (last_status IN ('', 'success', 'failed', 'skipped', 'partial')),
  next_run_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_created ON scheduled_tasks(created_at DESC);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'api',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  server_message_id TEXT,
  client_id TEXT,
  media_id TEXT,
  caption_sent_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_user ON outbox(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at DESC);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  wechat_message_id TEXT,
  from_user_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  item_types TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_msgid
  ON inbound_messages(wechat_message_id)
  WHERE wechat_message_id IS NOT NULL AND wechat_message_id <> '';
CREATE INDEX IF NOT EXISTS idx_inbound_user ON inbound_messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_received ON inbound_messages(received_at, id);
CREATE INDEX IF NOT EXISTS idx_inbound_created ON inbound_messages(created_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  kind TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_name TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  outbox_id TEXT REFERENCES outbox(id) ON DELETE SET NULL,
  inbound_message_id TEXT REFERENCES inbound_messages(id) ON DELETE SET NULL,
  wechat_message_id TEXT,
  error TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_outbox ON attachments(outbox_id);
CREATE INDEX IF NOT EXISTS idx_attachments_inbound ON attachments(inbound_message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_rule_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL REFERENCES app_rules(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  inbound_message_id TEXT REFERENCES inbound_messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('matched', 'success', 'failed', 'skipped')),
  http_status INTEGER,
  latency_ms INTEGER,
  error TEXT NOT NULL DEFAULT '',
  params_preview TEXT NOT NULL DEFAULT '',
  request_preview TEXT NOT NULL DEFAULT '',
  response_preview TEXT NOT NULL DEFAULT '',
  reply_outbox_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_rule_logs_dedupe
  ON app_rule_logs(rule_id, inbound_message_id)
  WHERE inbound_message_id IS NOT NULL AND inbound_message_id <> '';
CREATE INDEX IF NOT EXISTS idx_app_rule_logs_rule ON app_rule_logs(rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_rule_logs_rule_id ON app_rule_logs(rule_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_app_rule_logs_created ON app_rule_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS scheduled_task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped', 'partial')),
  http_status INTEGER,
  latency_ms INTEGER,
  error TEXT NOT NULL DEFAULT '',
  response_preview TEXT NOT NULL DEFAULT '',
  reply_preview TEXT NOT NULL DEFAULT '',
  recipients_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_logs_task ON scheduled_task_logs(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_logs_task_id ON scheduled_task_logs(task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_logs_created ON scheduled_task_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  user_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(type, created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 用户级命名凭据（一条凭据可含多个字段；值整体加密）
CREATE TABLE IF NOT EXISTS user_secrets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
  fields_enc TEXT NOT NULL,
  field_names TEXT NOT NULL DEFAULT '[]',
  hints TEXT NOT NULL DEFAULT '{}',
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_user_secrets_user ON user_secrets(user_id, name);
`;

/** @type {DatabaseSync|null} */
let database = null;
/** @type {Map<string, import('node:sqlite').StatementSync>} */
const statementCache = new Map();
let transactionDepth = 0;
let savepointSeq = 0;

/** 读取当前 schema_version（meta 表不存在/无记录时返回 0）。 */
function readSchemaVersion(instance) {
  try {
    const row = instance.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const version = row ? Number.parseInt(row.value, 10) : 0;
    return Number.isFinite(version) ? version : 0;
  } catch {
    return 0;
  }
}

/**
 * 打开/初始化数据库。
 * 只接受全新库（schema_version=0，自动建表）或当前基线（schema_version=1）；
 * 其他版本（包括旧版本数据库）一律拒绝启动——本版本不提供数据迁移。
 * @param {string} [dbPath]
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDatabase(dbPath = config.dbPath) {
  process.umask(0o077);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const instance = new DatabaseSync(dbPath);
  try {
    // auto_vacuum 必须在切换 WAL/建表前设置（之后无法修改）；仅对全新库设置
    const previousVersion = readSchemaVersion(instance);
    if (previousVersion === 0) instance.exec('PRAGMA auto_vacuum = 2;');
    instance.exec('PRAGMA journal_mode = WAL;');
    instance.exec('PRAGMA foreign_keys = ON;');
    instance.exec('PRAGMA busy_timeout = 5000;');
    instance.exec(`PRAGMA synchronous = ${resolveSynchronous()};`);
    instance.exec('PRAGMA journal_size_limit = 67108864;');
    instance.exec('PRAGMA temp_store = MEMORY;');
    instance.exec('PRAGMA cache_size = -16000;');
    if (previousVersion !== 0 && previousVersion !== SCHEMA_VERSION) {
      throw new Error(
        `数据库版本不兼容（检测到 schema_version=${previousVersion}，当前为 ${SCHEMA_VERSION}）；` +
          '本版本为全新数据基线，不支持旧数据升级：请使用全新空数据卷重新开始',
      );
    }
    instance.exec(SCHEMA_SQL);
    instance
      .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION));
    const autoVacuum = instance.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum;
    log.info('数据库已初始化', {
      dbPath,
      schemaVersion: SCHEMA_VERSION,
      synchronous: resolveSynchronous(),
      autoVacuum,
    });
    return instance;
  } catch (err) {
    try {
      instance.close();
    } catch {
      /* 忽略关闭失败 */
    }
    throw err;
  }
}
database = openDatabase();

/** 收紧数据库文件权限（Windows/受限环境失败可忽略）。 */
function normalizeDatabasePermissions() {
  const dbPath = config.dbPath;
  try {
    fs.chmodSync(path.dirname(dbPath), 0o700);
    fs.chmodSync(dbPath, 0o600);
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.chmodSync(`${dbPath}${suffix}`, 0o600);
      } catch {
        /* 文件可能不存在 */
      }
    }
  } catch (err) {
    log.warn('修正数据库文件权限失败（Windows/受限环境可忽略）', { message: err?.message });
  }
}
normalizeDatabasePermissions();

/** 返回底层 DatabaseSync（测试/特殊维护用；正常业务请用 run/get/all）。 */
export function getDb() {
  return database;
}

/** 预处理语句并缓存（同一 SQL 只编译一次）。 */
export function prepare(sql) {
  if (!database) throw new Error('数据库已关闭');
  let statement = statementCache.get(sql);
  if (!statement) {
    statement = database.prepare(sql);
    statementCache.set(sql, statement);
  }
  return statement;
}

/** 执行写语句，返回 {changes, lastInsertRowid}。 */
export function run(sql, ...params) {
  return prepare(sql).run(...params);
}

/** 查询单行，无结果返回 undefined。 */
export function get(sql, ...params) {
  return prepare(sql).get(...params);
}

/** 查询多行。 */
export function all(sql, ...params) {
  return prepare(sql).all(...params);
}

/** 直接执行多语句 SQL（建表/PRAGMA 等）。 */
export function exec(sql) {
  if (!database) throw new Error('数据库已关闭');
  database.exec(sql);
}

/**
 * 事务封装：回调内所有写操作原子提交；抛错自动回滚。
 * 支持嵌套（内层用 SAVEPOINT），避免组合写操作互相破坏。
 */
export function transaction(fn) {
  if (transactionDepth > 0) {
    const name = `sp_${++savepointSeq}`;
    exec(`SAVEPOINT ${name}`);
    transactionDepth += 1;
    try {
      const result = fn();
      exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      try {
        exec(`ROLLBACK TO ${name}`);
        exec(`RELEASE ${name}`);
      } catch {
        /* 忽略回滚失败 */
      }
      throw err;
    } finally {
      transactionDepth -= 1;
    }
  }

  exec('BEGIN IMMEDIATE');
  transactionDepth = 1;
  try {
    const result = fn();
    exec('COMMIT');
    return result;
  } catch (err) {
    try {
      exec('ROLLBACK');
    } catch {
      /* 忽略回滚失败 */
    }
    throw err;
  } finally {
    transactionDepth = 0;
  }
}

/** 当前毫秒时间戳（统一时间来源，便于测试替换）。 */
export function nowMs() {
  return Date.now();
}

/** 读取 meta 值（不存在返回 null）。 */
export function getMeta(key) {
  const row = get('SELECT value FROM meta WHERE key = ?', key);
  return row ? row.value : null;
}

/** 写入/覆盖 meta 值。 */
export function setMeta(key, value) {
  run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

/** 关闭数据库（优雅退出 / 测试清理用，可重复调用）。 */
export function closeDb() {
  if (!database) return;
  statementCache.clear();
  try {
    database.close();
  } catch (err) {
    log.warn('关闭数据库时出错', { message: err.message });
  } finally {
    database = null;
  }
}
