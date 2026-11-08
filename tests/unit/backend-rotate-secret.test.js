/**
 * 单元测试：APP_SECRET 轮换工具（scripts/rotate-app-secret.mjs，BA-xx / 安全）。
 *
 * 覆盖：
 * - 真实轮换：users.token_enc / users.context_token_enc / app_rules.request_headers_enc /
 *   scheduled_tasks.request_headers_enc / app_settings['security.apiTokenEnc'] 全部改由新 secret 加密，
 *   新 secret 可解、旧 secret 不可解；非密文字段/行数/scrypt 密码哈希不变；生成 DB 备份；
 * - dry-run：只统计不写库、不生成备份；
 * - 旧 secret 不匹配：中止且不写库；
 * - 损坏/空值：跳过（保持原样），其余正常轮换；
 * - 新 secret 强度校验、非法参数；
 * - CLI：dry-run 实跑；真实执行必须带 --yes。
 *
 * 全部使用临时 DATA_DIR / 临时 DB，绝不触碰真实 data/ 或运行中容器。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..', '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'rotate-app-secret.mjs');
const CRYPTO_URL = pathToFileURL(path.join(ROOT, 'server', 'src', 'crypto.js')).href;

const OLD_SECRET = 'a'.repeat(64);
const NEW_SECRET = 'b'.repeat(64);
const WRONG_SECRET = 'f'.repeat(64);
/** 固定测试数据：2 个用户（token×2 + context×1）+ 规则 1 + 定时任务 1 + API Token 1 = 6 条密文。 */
const ENCRYPTED_VALUE_COUNT = 6;

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-rotate-secret-'));
process.env.DATA_DIR = rootDir;
process.env.APP_SECRET = OLD_SECRET;
process.env.LOG_LEVEL = 'silent';

const { openDatabase, closeDb } = await import('../../server/src/db.js');
const { encryptSecret } = await import('../../server/src/crypto.js');
const {
  rotateSecrets,
  encryptWithSecret,
  decryptWithSecret,
  validateNewSecret,
  isCiphertextFormat,
} = await import('../../scripts/rotate-app-secret.mjs');

test.after(() => {
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function tempCaseDir(name) {
  return fs.mkdtempSync(path.join(rootDir, `${name}-`));
}

/**
 * 建一个与真实 schema 一致的最小库并写入各加密字段；返回期望明文。
 * @returns {{dbPath:string, dir:string, expected:object}}
 */
function seedDatabase(name) {
  const dir = tempCaseDir(name);
  const dbPath = path.join(dir, 'clawbridge.db');
  const db = openDatabase(dbPath);
  const now = 1700000000000;
  const expected = {
    user1Token: 'bot-token-1',
    user1Context: 'context-token-1',
    user2Token: 'bot-token-2',
    ruleHeaders: JSON.stringify({ Authorization: 'Bearer rule-secret' }),
    taskHeaders: JSON.stringify({ 'X-Api-Key': 'task-secret' }),
    apiToken: 'cb_token_plain_0123456789',
  };
  try {
    db.prepare(
      `INSERT INTO users
        (id, display_name, wechat_user_id, token_enc, base_url, context_token_enc, status, bound_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      'u1',
      '用户一',
      'wx_u1',
      encryptSecret(expected.user1Token),
      'https://example.invalid/base',
      encryptSecret(expected.user1Context),
      'active',
      111,
      222,
    );
    db.prepare(
      `INSERT INTO users
        (id, display_name, wechat_user_id, token_enc, base_url, context_token_enc, status, bound_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('u2', '用户二', 'wx_u2', encryptSecret(expected.user2Token), '', null, 'unbound', 333, 444);
    db.prepare(
      `INSERT INTO app_rules (id, name, request_url, request_headers_enc, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('rule_1', '规则一', 'https://api.example.com/rule', encryptSecret(expected.ruleHeaders), now, now);
    db.prepare(
      `INSERT INTO scheduled_tasks (id, name, request_url, request_headers_enc, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('task_1', '任务一', 'https://api.example.com/task', encryptSecret(expected.taskHeaders), now, now);
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)').run(
      'security.apiTokenEnc',
      JSON.stringify(encryptSecret(expected.apiToken)),
      now,
    );
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)').run(
      'security.pushApiEnabled',
      'true',
      now,
    );
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)').run(
      'security.adminPasswordHash',
      'scrypt$16384$8$1$c2FsdA$hash',
      now,
    );
  } finally {
    db.close();
  }
  return { dbPath, dir, expected };
}

function readRows(dbPath) {
  const db = openDatabase(dbPath);
  try {
    const users = db.prepare('SELECT * FROM users ORDER BY id').all();
    const rules = db.prepare('SELECT * FROM app_rules').all();
    const tasks = db.prepare('SELECT * FROM scheduled_tasks').all();
    const settings = db
      .prepare('SELECT key, value, updated_at FROM app_settings ORDER BY key')
      .all();
    return { users, rules, tasks, settings };
  } finally {
    db.close();
  }
}

function settingValue(rows, key) {
  const row = rows.settings.find((item) => item.key === key);
  return row ? row.value : undefined;
}

/** 用真实 server crypto（以指定 APP_SECRET 启动的子进程）解密 DB 中的用户 token。 */
function serverCryptoDecryptInChild(dbPath, secret) {
  const code = [
    "import { DatabaseSync } from 'node:sqlite';",
    `import { decryptSecret } from ${JSON.stringify(CRYPTO_URL)};`,
    "const db = new DatabaseSync(process.env.ROTATE_TEST_DB, { readOnly: true });",
    "const row = db.prepare('SELECT token_enc FROM users WHERE id = ?').get('u1');",
    'process.stdout.write(decryptSecret(row.token_enc));',
    'db.close();',
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: rootDir,
      APP_SECRET: secret,
      LOG_LEVEL: 'silent',
      ROTATE_TEST_DB: dbPath,
    },
    encoding: 'utf8',
  });
}

// ---------------------------------------------------------------------------
// 真实轮换
// ---------------------------------------------------------------------------

test('真实轮换：全部密文可用新 secret 解密、旧 secret 不可解密，备份生成且非密文字段不变', () => {
  const { dbPath, expected } = seedDatabase('rotate');

  const result = rotateSecrets({ dbPath, oldSecret: OLD_SECRET, newSecret: NEW_SECRET });

  assert.equal(result.dryRun, false);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.totals.candidates, ENCRYPTED_VALUE_COUNT);
  assert.equal(result.totals.rotated, ENCRYPTED_VALUE_COUNT);
  assert.equal(result.totals.skippedEmpty, 1, 'u2.context_token_enc 为空应计入 skippedEmpty');
  assert.equal(result.totals.skippedInvalid, 0);

  const usersStats = result.tables.find((entry) => entry.table === 'users');
  assert.deepEqual(usersStats.fields.token_enc, { rotated: 2, skippedEmpty: 0, skippedInvalid: 0 });
  assert.deepEqual(usersStats.fields.context_token_enc, { rotated: 1, skippedEmpty: 1, skippedInvalid: 0 });
  assert.equal(result.tables.find((entry) => entry.table === 'app_rules').fields.request_headers_enc.rotated, 1);
  assert.equal(
    result.tables.find((entry) => entry.table === 'scheduled_tasks').fields.request_headers_enc.rotated,
    1,
  );
  assert.equal(result.settings.rotated, 1);

  // 备份：存在、非空，且备份里仍是旧 secret 可解的密文
  assert.ok(result.backupPath && fs.existsSync(result.backupPath), '应生成 DB 备份');
  assert.ok(result.backupBytes > 0);
  assert.equal(result.backupPath.startsWith(path.join(path.dirname(dbPath), 'backups')), true);
  const backupDb = openDatabase(result.backupPath);
  try {
    const backupRow = backupDb.prepare("SELECT token_enc FROM users WHERE id = 'u1'").get();
    assert.equal(decryptWithSecret(backupRow.token_enc, OLD_SECRET), expected.user1Token);
  } finally {
    backupDb.close();
  }

  // 新 secret 可解、旧 secret 不可解；明文内容与轮换前一致
  const rows = readRows(dbPath);
  const user1 = rows.users.find((row) => row.id === 'u1');
  const user2 = rows.users.find((row) => row.id === 'u2');
  assert.equal(decryptWithSecret(user1.token_enc, NEW_SECRET), expected.user1Token);
  assert.equal(decryptWithSecret(user1.context_token_enc, NEW_SECRET), expected.user1Context);
  assert.equal(decryptWithSecret(user2.token_enc, NEW_SECRET), expected.user2Token);
  assert.equal(decryptWithSecret(rows.rules[0].request_headers_enc, NEW_SECRET), expected.ruleHeaders);
  assert.equal(decryptWithSecret(rows.tasks[0].request_headers_enc, NEW_SECRET), expected.taskHeaders);
  const apiTokenEnc = JSON.parse(settingValue(rows, 'security.apiTokenEnc'));
  assert.equal(typeof apiTokenEnc, 'string');
  assert.equal(decryptWithSecret(apiTokenEnc, NEW_SECRET), expected.apiToken);
  for (const encrypted of [user1.token_enc, user1.context_token_enc, rows.rules[0].request_headers_enc]) {
    assert.throws(() => decryptWithSecret(encrypted, OLD_SECRET), '旧 secret 不应能解密新密文');
  }

  // 非密文字段 / 行数 / 时间戳 / scrypt 哈希 / 其它设置项保持不变
  assert.equal(rows.users.length, 2);
  assert.equal(user1.display_name, '用户一');
  assert.equal(user1.wechat_user_id, 'wx_u1');
  assert.equal(user1.base_url, 'https://example.invalid/base');
  assert.equal(user1.status, 'active');
  assert.equal(user1.bound_at, 111);
  assert.equal(user1.updated_at, 222);
  assert.equal(user2.context_token_enc, null);
  assert.equal(rows.rules[0].request_url, 'https://api.example.com/rule');
  assert.equal(rows.tasks[0].name, '任务一');
  assert.equal(settingValue(rows, 'security.pushApiEnabled'), 'true');
  assert.equal(settingValue(rows, 'security.adminPasswordHash'), 'scrypt$16384$8$1$c2FsdA$hash');
  assert.equal(rows.settings.find((row) => row.key === 'security.apiTokenEnc').updated_at, 1700000000000);

  // 真实服务端 crypto（新 APP_SECRET 子进程）能解密轮换后的密文
  const child = serverCryptoDecryptInChild(dbPath, NEW_SECRET);
  assert.equal(child.status, 0, `子进程解密失败：${child.stderr}`);
  assert.equal(child.stdout, expected.user1Token);
  const oldChild = serverCryptoDecryptInChild(dbPath, OLD_SECRET);
  assert.notEqual(oldChild.status, 0, '旧 APP_SECRET 子进程不应能解密轮换后的密文');
});

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

test('dry-run：只统计不写库、不生成备份', () => {
  const { dbPath, dir } = seedDatabase('dryrun');
  const result = rotateSecrets({ dbPath, oldSecret: OLD_SECRET, newSecret: NEW_SECRET, dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.totals.rotated, ENCRYPTED_VALUE_COUNT);
  assert.equal(result.totals.skippedEmpty, 1);
  assert.equal(result.backupPath, null);
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false, 'dry-run 不应生成 backups 目录');

  const rows = readRows(dbPath);
  const user1 = rows.users.find((row) => row.id === 'u1');
  assert.equal(decryptWithSecret(user1.token_enc, OLD_SECRET), 'bot-token-1', 'dry-run 后应仍可用旧 secret 解密');
  assert.throws(() => decryptWithSecret(user1.token_enc, NEW_SECRET));
});

test('dry-run 允许不提供新 secret（仅统计）', () => {
  const { dbPath } = seedDatabase('dryrun-nosecret');
  const result = rotateSecrets({ dbPath, oldSecret: OLD_SECRET, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.totals.rotated, ENCRYPTED_VALUE_COUNT);
  assert.equal(result.backupPath, null);
});

// ---------------------------------------------------------------------------
// 错误场景
// ---------------------------------------------------------------------------

test('旧 secret 不匹配：中止且不写库、不生成备份', () => {
  const { dbPath, dir } = seedDatabase('wrong-old');
  assert.throws(
    () => rotateSecrets({ dbPath, oldSecret: WRONG_SECRET, newSecret: NEW_SECRET }),
    /无法解密任何/,
  );
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false, '校验失败前不应生成备份');
  const rows = readRows(dbPath);
  const user1 = rows.users.find((row) => row.id === 'u1');
  assert.equal(decryptWithSecret(user1.token_enc, OLD_SECRET), 'bot-token-1', '失败后数据应保持原样');
});

test('损坏/空值跳过：其余字段正常轮换，损坏值保持原样', () => {
  const dir = tempCaseDir('invalid');
  const dbPath = path.join(dir, 'clawbridge.db');
  const db = openDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO users (id, wechat_user_id, token_enc, context_token_enc, status, bound_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('u1', 'wx_u1', encryptSecret('bot-token-good'), 'v1.AAAA.BBBB.CCCC', 'active', 1, 1);
    db.prepare(
      `INSERT INTO users (id, wechat_user_id, token_enc, context_token_enc, status, bound_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('u2', 'wx_u2', null, encryptSecret('context-token-good'), 'active', 1, 1);
  } finally {
    db.close();
  }

  const result = rotateSecrets({ dbPath, oldSecret: OLD_SECRET, newSecret: NEW_SECRET });
  const usersStats = result.tables.find((entry) => entry.table === 'users');
  assert.deepEqual(usersStats.fields.token_enc, { rotated: 1, skippedEmpty: 1, skippedInvalid: 0 });
  assert.deepEqual(usersStats.fields.context_token_enc, { rotated: 1, skippedEmpty: 0, skippedInvalid: 1 });
  assert.equal(result.totals.rotated, 2);
  assert.equal(result.totals.skippedInvalid, 1);

  const rows = readRows(dbPath);
  const u1 = rows.users.find((row) => row.id === 'u1');
  const u2 = rows.users.find((row) => row.id === 'u2');
  assert.equal(decryptWithSecret(u1.token_enc, NEW_SECRET), 'bot-token-good');
  assert.equal(u1.context_token_enc, 'v1.AAAA.BBBB.CCCC', '损坏密文应保持原样');
  assert.equal(u2.token_enc, null);
  assert.equal(decryptWithSecret(u2.context_token_enc, NEW_SECRET), 'context-token-good');
});

test('参数校验：新 secret 强度、与旧 secret 相同、db 缺失、旧 secret 为空', () => {
  const { dbPath } = seedDatabase('validate');
  assert.throws(() => validateNewSecret('short'), /强度不足/);
  assert.equal(validateNewSecret(NEW_SECRET), NEW_SECRET);
  assert.equal(validateNewSecret('Abcdefghij0123456789!@#$%^&*()-_=+[]{}'), 'Abcdefghij0123456789!@#$%^&*()-_=+[]{}');
  assert.throws(() => rotateSecrets({ dbPath, oldSecret: OLD_SECRET, newSecret: OLD_SECRET }), /不能与旧/);
  assert.throws(
    () => rotateSecrets({ dbPath: path.join(rootDir, 'missing.db'), oldSecret: OLD_SECRET, newSecret: NEW_SECRET }),
    /数据库文件不存在/,
  );
  assert.throws(() => rotateSecrets({ dbPath, oldSecret: '', newSecret: NEW_SECRET }), /旧 APP_SECRET 不能为空/);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI：dry-run 在临时库上实跑成功且不写库', () => {
  const { dbPath, dir } = seedDatabase('cli-dryrun');
  const cli = spawnSync(process.execPath, [SCRIPT_PATH, '--data-dir', dir, '--dry-run'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dir, APP_SECRET: OLD_SECRET, LOG_LEVEL: 'silent' },
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, `CLI 退出码非 0：${cli.stderr}`);
  assert.match(cli.stdout, /dry-run/);
  assert.match(cli.stdout, new RegExp(`待轮换 ${ENCRYPTED_VALUE_COUNT}`));
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false);
  const rows = readRows(dbPath);
  assert.equal(decryptWithSecret(rows.users[0].token_enc, OLD_SECRET), 'bot-token-1', 'dry-run 不应写库');
});

test('CLI：真实执行必须显式 --yes，否则拒绝且不写库', () => {
  const { dbPath, dir } = seedDatabase('cli-no-yes');
  const cli = spawnSync(process.execPath, [SCRIPT_PATH, '--data-dir', dir, '--new-secret', NEW_SECRET], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dir, APP_SECRET: OLD_SECRET, LOG_LEVEL: 'silent' },
    encoding: 'utf8',
  });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /--yes/);
  const rows = readRows(dbPath);
  assert.equal(decryptWithSecret(rows.users[0].token_enc, OLD_SECRET), 'bot-token-1');
});

test('辅助函数：isCiphertextFormat / encryptWithSecret 与解密往返', () => {
  const cipher = encryptWithSecret('hello', OLD_SECRET);
  assert.equal(isCiphertextFormat(cipher), true);
  assert.equal(isCiphertextFormat('not-a-cipher'), false);
  assert.equal(isCiphertextFormat(''), false);
  assert.equal(decryptWithSecret(cipher, OLD_SECRET), 'hello');
  assert.throws(() => decryptWithSecret(cipher, NEW_SECRET));
  assert.throws(() => decryptWithSecret('v1.x.y.z', OLD_SECRET));
});
