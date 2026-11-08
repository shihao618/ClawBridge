/**
 * 单元测试：数据库高频查询索引（BA-08）。
 *
 * 背景：对外入站长轮询（`WHERE received_at > ? ORDER BY received_at ASC, id ASC`）、
 * 后台消息记录（`UNION ALL ... ORDER BY created_at DESC`）与今日统计在消息量大时
 * 会全表扫描 + 临时排序。本测试守住以下索引存在且被查询计划实际使用：
 * - `inbound_messages(received_at, id)`
 * - `inbound_messages(created_at DESC)`
 * - `outbox(created_at DESC)`
 *
 * 注：索引通过 `CREATE INDEX IF NOT EXISTS` 在每次启动时幂等补齐（无需 schema 版本变更），
 * 因此既有 v10 数据卷在升级后也会自动获得这些索引。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-db-indexes-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'db-indexes-secret-0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL = 'silent';

const { openDatabase, closeDb } = await import('../../server/src/db.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** 查询计划文本拼接（sqlite 的 EXPLAIN QUERY PLAN 返回多行）。 */
function queryPlan(db, sql, ...params) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join(' | ');
}

test('高频查询索引存在且被查询计划使用', () => {
  const dbPath = path.join(dataDir, 'indexes.db');
  const db = openDatabase(dbPath);

  const indexNames = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name),
  );
  for (const name of ['idx_inbound_received', 'idx_inbound_created', 'idx_outbox_created']) {
    assert.ok(indexNames.has(name), `缺少索引 ${name}`);
  }

  // 1) 对外入站消息 API：应走 idx_inbound_received，而不是全表扫描 + 临时排序
  const inboundApiPlan = queryPlan(
    db,
    'SELECT * FROM inbound_messages WHERE received_at > ? ORDER BY received_at ASC, id ASC LIMIT 50',
    0,
  );
  assert.match(inboundApiPlan, /idx_inbound_received/, `入站 API 查询未使用 received_at 索引：${inboundApiPlan}`);
  assert.doesNotMatch(inboundApiPlan, /TEMP B-TREE/, `入站 API 仍需要临时排序：${inboundApiPlan}`);

  // 2) 后台消息记录：入站/出站子查询按 created_at 倒序 + 全局排序
  const inboundListPlan = queryPlan(db, 'SELECT * FROM inbound_messages ORDER BY created_at DESC LIMIT 50');
  assert.match(inboundListPlan, /idx_inbound_created/, `入站消息列表未使用 created_at 索引：${inboundListPlan}`);

  const outboundListPlan = queryPlan(db, 'SELECT * FROM outbox ORDER BY created_at DESC LIMIT 50');
  assert.match(outboundListPlan, /idx_outbox_created/, `出站消息列表未使用 created_at 索引：${outboundListPlan}`);

  // 3) 今日入站统计：走 received_at 索引
  const todayPlan = queryPlan(db, 'SELECT COUNT(*) AS c FROM inbound_messages WHERE received_at >= ?', 0);
  assert.match(todayPlan, /idx_inbound_received/, `今日入站统计未使用 received_at 索引：${todayPlan}`);

  db.close();
});

test('既有 v10 数据库重开时幂等补齐索引（无需 schema 版本变更）', () => {
  const dbPath = path.join(dataDir, 'legacy-v10.db');
  const first = openDatabase(dbPath);
  // 模拟旧库：删掉新增索引后重新打开，启动时应自动补回
  first.exec('DROP INDEX idx_inbound_received');
  first.exec('DROP INDEX idx_inbound_created');
  first.exec('DROP INDEX idx_outbox_created');
  first.close();

  const second = openDatabase(dbPath);
  const indexNames = new Set(
    second
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name),
  );
  assert.ok(indexNames.has('idx_inbound_received'));
  assert.ok(indexNames.has('idx_inbound_created'));
  assert.ok(indexNames.has('idx_outbox_created'));
  second.close();
});
