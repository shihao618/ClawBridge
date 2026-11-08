/**
 * 单元测试：数据生命周期维护（server/src/maintenance.js，BA-18）。
 *
 * 临时 DATA_DIR（含临时 media 目录）+ 真实 SQLite：
 *  - 附件行 GC：无磁盘文件的 ready 行删除；被 queued/sending outbox 引用的保留；
 *  - 上传附件 GC：user_id NULL 且从未入队、超过保留期的 outbound 附件删除行+文件；
 *  - 孤儿文件 GC：无 DB 引用且超过最小年龄的 inbound/outbound 文件删除，新文件/被引用文件保留；
 *  - 日志保留：events / app_rule_logs / scheduled_task_logs 超期分批删除，0 = 关闭；
 *  - start/stop 幂等、MAINTENANCE_ENABLED=0 不启动、runMaintenance 防重入。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-maintenance-',
  env: {
    MEDIA_DIR: undefined, // 媒体目录跟 DATA_DIR 走：<DATA_DIR>/media
    APP_SECRET: 'maintenance-secret-0123456789abcdef0123456789abcdef',
    ADMIN_PASSWORD: 'maintenance-password',
    API_TOKEN: 'maintenance-token',
    LOG_LEVEL: 'silent',
  },
});

const maintenance = await import('../../server/src/maintenance.js');
const store = await import('../../server/src/store.js');
const media = await import('../../server/src/media.js');
const { config } = await import('../../server/src/config.js');
const { getDb } = await import('../../server/src/db.js');

const DAY_MS = 24 * 60 * 60 * 1000;
/** 关闭 SQLite 优化动作，避免测试环境 WAL/统计行为干扰断言。 */
const NO_OPTIMIZE = { pragmaOptimize: false, walCheckpoint: false };

test.after(async () => {
  await maintenance.stop();
  await cleanupUnitEnv(unitEnv);
});

let seq = 0;
function createUser() {
  seq += 1;
  return store.upsertBoundUser({
    wechatUserId: `wx_maintenance_${seq}`,
    displayName: `维护用户${seq}`,
    ilinkBotId: `bot_maintenance_${seq}@im.bot`,
    botToken: `maintenance-bot-token-${seq}`,
    baseUrl: 'https://ilink.example.test',
  }).user;
}

/** 直接插入附件行（不落盘），用于“DB 有行但磁盘无文件”场景。 */
function createAttachmentRow({ id, attachmentPath, userId = null, createdAt = Date.now() }) {
  return store.createAttachment({
    id,
    direction: 'outbound',
    kind: 'image',
    mime: 'image/png',
    fileName: 'a.png',
    size: 10,
    path: attachmentPath,
    sha256: 'hash',
    userId,
    status: 'ready',
    createdAt,
  });
}

/** 真实落盘 + 建 DB 行（管理端上传场景：user_id 为 NULL）。 */
async function createFileAttachment({ createdAt = Date.now(), buffer = Buffer.from('MAINTENANCE-DATA') } = {}) {
  const saved = await media.saveMediaBuffer({ direction: 'outbound', buffer, mime: 'image/png' });
  return store.createAttachment({
    id: saved.id,
    direction: 'outbound',
    kind: 'image',
    mime: saved.mime,
    fileName: 'a.png',
    size: saved.size,
    path: saved.path,
    sha256: saved.sha256,
    status: 'ready',
    createdAt,
  });
}

const absoluteMediaPath = (relativePath) => path.join(config.media.dir, relativePath);

test('附件行 GC：无磁盘文件的 ready 行删除，被 queued/sending outbox 引用的保留', async () => {
  const user = createUser();
  const plain = createAttachmentRow({ id: 'att_gc_missing_plain', attachmentPath: 'outbound/att_gc_missing_plain.png' });
  const referenced = createAttachmentRow({ id: 'att_gc_missing_ref', attachmentPath: 'outbound/att_gc_missing_ref.png' });
  store.enqueueMessage({ userId: user.id, text: '', mediaId: referenced.id });

  const result = await maintenance.runMaintenance({
    now: Date.now(),
    logRetentionDays: 0,
    uploadRetentionDays: 0,
    ...NO_OPTIMIZE,
  });
  assert.ok(result.attachmentsWithoutFile >= 1, `应清理无文件附件行：${JSON.stringify(result)}`);
  assert.equal(store.getAttachment(plain.id), undefined, '无文件且无引用的附件行应删除');
  assert.ok(store.getAttachment(referenced.id), '被 queued outbox 引用的附件行应保留（交 dispatcher 处理失败）');
});

test('上传附件 GC：超期且从未入队的 outbound 上传删除行+文件；已入队/未超期保留', async () => {
  const user = createUser();
  const now = Date.now();
  const staleUpload = await createFileAttachment({ createdAt: now - 10 * DAY_MS });
  const recentUpload = await createFileAttachment({ createdAt: now - 1 * DAY_MS });
  const enqueuedStale = await createFileAttachment({ createdAt: now - 10 * DAY_MS });
  store.enqueueMessage({ userId: user.id, text: '', mediaId: enqueuedStale.id });

  const staleFile = absoluteMediaPath(staleUpload.path);
  assert.equal(fs.existsSync(staleFile), true);

  const result = await maintenance.runMaintenance({
    now,
    logRetentionDays: 0,
    uploadRetentionDays: 7,
    ...NO_OPTIMIZE,
  });
  assert.ok(result.staleUploads >= 1, `应清理超期未入队上传：${JSON.stringify(result)}`);
  assert.equal(store.getAttachment(staleUpload.id), undefined, '超期未入队上传应删除 DB 行');
  assert.equal(fs.existsSync(staleFile), false, '删除 DB 行后应删除磁盘文件');
  assert.ok(store.getAttachment(recentUpload.id), '未超期上传应保留');
  assert.equal(fs.existsSync(absoluteMediaPath(recentUpload.path)), true);
  assert.ok(store.getAttachment(enqueuedStale.id), '已被 outbox 引用的上传即使超期也应保留');
  assert.equal(fs.existsSync(absoluteMediaPath(enqueuedStale.path)), true);
});

test('孤儿媒体文件 GC：无 DB 引用且超过最小年龄删除；新文件/被引用文件保留', async () => {
  await media.ensureMediaDirs();
  const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const orphanOutbound = path.join(config.media.dir, 'outbound', 'orphan-old-outbound.png');
  const orphanInbound = path.join(config.media.dir, 'inbound', 'orphan-old-inbound.png');
  const freshOrphan = path.join(config.media.dir, 'outbound', 'orphan-fresh.png');
  for (const file of [orphanOutbound, orphanInbound, freshOrphan]) fs.writeFileSync(file, 'ORPHAN');
  fs.utimesSync(orphanOutbound, oldDate, oldDate);
  fs.utimesSync(orphanInbound, oldDate, oldDate);

  const referenced = await createFileAttachment();
  const result = await maintenance.runMaintenance({
    orphanFileMinAgeMs: 60 * 60 * 1000,
    uploadRetentionDays: 0,
    logRetentionDays: 0,
    ...NO_OPTIMIZE,
  });
  assert.ok(result.orphanMediaFiles >= 2, `应清理孤儿媒体文件：${JSON.stringify(result)}`);
  assert.equal(fs.existsSync(orphanOutbound), false, '无引用且超龄的 outbound 孤儿文件应删除');
  assert.equal(fs.existsSync(orphanInbound), false, '无引用且超龄的 inbound 孤儿文件应删除');
  assert.equal(fs.existsSync(freshOrphan), true, '未超过最小年龄的新文件应保留（防误删写入中的文件）');
  assert.equal(fs.existsSync(absoluteMediaPath(referenced.path)), true, 'DB 引用的文件应保留');
  assert.ok(store.getAttachment(referenced.id));
});

test('日志保留：events/app_rule_logs/scheduled_task_logs 超期分批删除，0 = 不清理', async () => {
  const now = Date.now();
  const old = now - 100 * DAY_MS;
  store.addEvent({ type: 'maintenance_old_event', ts: old });
  store.addEvent({ type: 'maintenance_new_event', ts: now });
  store.insertAppRuleLog({ ruleId: 'rule_maintenance', status: 'success', createdAt: old });
  store.insertAppRuleLog({ ruleId: 'rule_maintenance', status: 'success', createdAt: now });
  store.insertScheduledTaskLog({ taskId: 'task_maintenance', status: 'success', createdAt: old });
  store.insertScheduledTaskLog({ taskId: 'task_maintenance', status: 'success', createdAt: now });

  const count = (table) => Number(getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
  const before = { events: count('events'), appRuleLogs: count('app_rule_logs'), scheduledTaskLogs: count('scheduled_task_logs') };

  const result = await maintenance.runMaintenance({
    now,
    logRetentionDays: 90,
    uploadRetentionDays: 0,
    ...NO_OPTIMIZE,
  });
  assert.equal(result.logs.events, 1, '应删除 1 条超期事件');
  assert.equal(result.logs.appRuleLogs, 1, '应删除 1 条超期规则日志');
  assert.equal(result.logs.scheduledTaskLogs, 1, '应删除 1 条超期定时任务日志');
  assert.equal(before.events - count('events'), 1);
  assert.equal(before.appRuleLogs - count('app_rule_logs'), 1);
  assert.equal(before.scheduledTaskLogs - count('scheduled_task_logs'), 1);
  // 未超期行保留（按类型核对）
  assert.ok(
    getDb().prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'maintenance_new_event'").get().c >= 1,
    '未超期事件应保留',
  );

  // MAINTENANCE_LOG_RETENTION_DAYS=0（覆盖为 0）→ 不清理日志
  store.addEvent({ type: 'maintenance_old_event_2', ts: old });
  const beforeClosed = count('events');
  const closed = await maintenance.runMaintenance({ now, logRetentionDays: 0, uploadRetentionDays: 0, ...NO_OPTIMIZE });
  assert.equal(closed.logs.events, 0);
  assert.equal(closed.logs.appRuleLogs, 0);
  assert.equal(closed.logs.scheduledTaskLogs, 0);
  assert.equal(count('events'), beforeClosed, '保留天数为 0 时不应删除日志');
});

test('start/stop 幂等、MAINTENANCE_ENABLED=0 不启动、runMaintenance 防重入', async () => {
  const saved = {
    enabled: process.env.MAINTENANCE_ENABLED,
    initialDelay: process.env.MAINTENANCE_INITIAL_DELAY_MS,
  };
  try {
    process.env.MAINTENANCE_ENABLED = '0';
    assert.equal(maintenance.start(), false, 'MAINTENANCE_ENABLED=0 时 start 应返回 false');
    assert.equal(maintenance.isRunning(), false);
    assert.equal(await maintenance.stop(), false, '未启动时 stop 应返回 false');

    delete process.env.MAINTENANCE_ENABLED;
    process.env.MAINTENANCE_INITIAL_DELAY_MS = '60000'; // 测试期间不自动触发，只验证 timer 生命周期
    assert.equal(maintenance.start(), true);
    assert.equal(maintenance.isRunning(), true);
    assert.equal(maintenance.start(), false, '重复 start 应幂等返回 false');

    // runMaintenance 并发防重入：返回同一 Promise，stop 会等待其 settle
    const first = maintenance.runMaintenance({ logRetentionDays: 0, uploadRetentionDays: 0, ...NO_OPTIMIZE });
    const second = maintenance.runMaintenance({ logRetentionDays: 0, uploadRetentionDays: 0, ...NO_OPTIMIZE });
    assert.equal(first, second, '维护进行中再次调用应返回同一 Promise');
    assert.equal(await maintenance.stop(), true, 'stop 应返回是否从已启动状态停止');
    await first;
    assert.equal(maintenance.isRunning(), false);
    assert.equal(await maintenance.stop(), false, '重复 stop 应幂等返回 false');
    const state = maintenance.getState();
    assert.ok(state.runsTotal >= 1, '应记录维护运行次数');
    assert.ok(state.lastResult && typeof state.lastResult.durationMs === 'number', '应记录最近一次维护结果');
  } finally {
    if (saved.enabled === undefined) delete process.env.MAINTENANCE_ENABLED;
    else process.env.MAINTENANCE_ENABLED = saved.enabled;
    if (saved.initialDelay === undefined) delete process.env.MAINTENANCE_INITIAL_DELAY_MS;
    else process.env.MAINTENANCE_INITIAL_DELAY_MS = saved.initialDelay;
    await maintenance.stop();
  }
});
