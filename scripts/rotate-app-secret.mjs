#!/usr/bin/env node
/**
 * APP_SECRET 轮换工具（离线 / 停机维护，零外部依赖，仅用 Node 内置模块）。
 *
 * 背景：ClawBridge 用 APP_SECRET 派生 AES-256-GCM 密钥（`clawbridge:secret:v1:<secret>`
 * 的 SHA-256），把微信 bot_token / context_token、接口应用与定时任务的请求 Header、
 * 以及 DB 中的 API Token 以 `v1.<iv>.<tag>.<ciphertext>`（base64url）格式加密落库。
 * 直接更换 APP_SECRET 会导致这些数据无法解密。本工具在**服务停止**时把库内全部密文
 * 用旧 secret 解密并用新 secret 重新加密，从而安全轮换主密钥。
 *
 * 覆盖范围（与 server/src/crypto.js + server/src/settings/secrets.js 审计对齐）：
 * - users.token_enc / users.context_token_enc（直接密文）
 * - app_rules.request_headers_enc（JSON.stringify(headers) 的密文）
 * - scheduled_tasks.request_headers_enc（同上）
 * - app_settings.key = 'security.apiTokenEnc'（JSON 字符串包装的密文）
 * 不触碰：security.adminPasswordHash（scrypt 哈希）、其它明文设置项、
 * 以及任何非密文字段/时间戳。
 *
 * 用法（危险操作，默认要求 --yes；建议先 --dry-run）：
 *   node scripts/rotate-app-secret.mjs --data-dir ./data --dry-run
 *   node scripts/rotate-app-secret.mjs --data-dir ./data --yes
 *
 * 参数：
 *   --data-dir <dir>    数据目录（默认 $DATA_DIR 或仓库下 data/）；DB 为 <dir>/clawbridge.db
 *   --backup-dir <dir>  备份目录（默认 <data-dir>/backups）
 *   --dry-run           只统计待轮换条数，不写库、不生成备份
 *   --yes               真实执行确认（非 dry-run 时必填；避免误操作）
 *   --new-secret <s>    新 APP_SECRET（64 位 hex 或高熵字符串；省略则交互输入不回显）
 *   --help / -h         显示帮助
 *
 * 旧 secret 读取顺序：环境变量 APP_SECRET → <data-dir>/app-secret.key 文件内容。
 * 程序不会打印任何旧/新 secret 或密文，也不会自动修改 .env / app-secret.key。
 *
 * 注意：不 import server/** 下的 config/crypto 模块（config 单例会按旧秘密求值并可能
 * 自动创建 data/ 目录）；密钥派生与密文格式在此独立实现，必须与 server/src/crypto.js 保持一致。
 *
 * 严禁对运行中的容器 / 生产库直接执行；请先备份，步骤见 docs/ROTATE_APP_SECRET.md。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENC_PREFIX = 'v1';
/** 与 server/src/crypto.js 的 TOKEN_KEY 派生串一致；改动须同步服务端。 */
const KEY_SALT = 'clawbridge:secret:v1:';
/** app_settings 中已知的密文 key（当前仅 API Token；新增加密设置项时需在此登记）。 */
const ENCRYPTED_SETTING_KEYS = ['security.apiTokenEnc'];
const CIPHERTEXT_RE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** 需要轮换的表与列（表名/列名均为代码内常量，不接受外部输入）。 */
const ENCRYPTED_TABLES = [
  { table: 'users', idColumn: 'id', fields: ['token_enc', 'context_token_enc'] },
  { table: 'app_rules', idColumn: 'id', fields: ['request_headers_enc'] },
  { table: 'scheduled_tasks', idColumn: 'id', fields: ['request_headers_enc'] },
];

// ---------------------------------------------------------------------------
// 密钥派生 / 加解密（与 server/src/crypto.js 行为一致）
// ---------------------------------------------------------------------------

/** 由 APP_SECRET 派生 32 字节 AES 密钥。 */
export function deriveKey(secret) {
  return crypto.createHash('sha256').update(`${KEY_SALT}${String(secret)}`).digest();
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlDecode(str) {
  return Buffer.from(str, 'base64url');
}

/** 用指定 secret 加密 UTF-8 字符串，输出 `v1.<iv>.<tag>.<ciphertext>`。 */
export function encryptWithSecret(plaintext, secret) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENC_PREFIX,
    b64urlEncode(iv),
    b64urlEncode(tag),
    b64urlEncode(ciphertext),
  ].join('.');
}

/** 用指定 secret 解密；格式非法/被篡改/密钥不匹配时抛错。 */
export function decryptWithSecret(encoded, secret) {
  if (!encoded || typeof encoded !== 'string') throw new Error('密文为空或类型非法');
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== ENC_PREFIX) throw new Error('未知的密文格式');
  const [, ivB64, tagB64, dataB64] = parts;
  const key = deriveKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, b64urlDecode(ivB64));
  decipher.setAuthTag(b64urlDecode(tagB64));
  return Buffer.concat([decipher.update(b64urlDecode(dataB64)), decipher.final()]).toString('utf8');
}

/** 是否为 `v1.*` 形式的密文（仅粗校验，解密成功与否以 decryptWithSecret 为准）。 */
export function isCiphertextFormat(value) {
  return typeof value === 'string' && CIPHERTEXT_RE.test(value);
}

/**
 * 校验新 APP_SECRET：64 位 hex，或长度 ≥32 且至少包含 3 类字符（大写/小写/数字/符号）。
 * @returns {string} 规范化后的 secret
 */
export function validateNewSecret(secret) {
  const value = typeof secret === 'string' ? secret.trim() : '';
  if (value === '') throw new Error('新 APP_SECRET 不能为空');
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (value.length >= 32 && classes >= 3) return value;
  throw new Error(
    '新 APP_SECRET 强度不足：需 64 位十六进制，或长度 ≥32 且至少包含 3 类字符（大写/小写/数字/符号）',
  );
}

// ---------------------------------------------------------------------------
// DB 读取 / schema 校验
// ---------------------------------------------------------------------------

function openDb(dbPath, { readOnly = false } = {}) {
  if (!fs.existsSync(dbPath)) throw new Error(`数据库文件不存在：${dbPath}`);
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly });
  } catch (err) {
    if (!readOnly) throw err;
    // 只读打开失败（WAL 附属文件不可写等）时退回读写打开；dry-run 依然不执行写语句。
    db = new DatabaseSync(dbPath);
  }
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

function readSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const version = row ? Number.parseInt(row.value, 10) : 0;
    return Number.isFinite(version) ? version : null;
  } catch {
    return null;
  }
}

function tableColumns(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((row) => row.name));
}

/** 校验目标表/列存在；schema 不符时给出明确错误而不是静默跳过。 */
function assertTargetSchema(db) {
  if (tableColumns(db, 'app_settings').size === 0) throw new Error('数据库缺少 app_settings 表');
  for (const { table, idColumn, fields } of ENCRYPTED_TABLES) {
    const columns = tableColumns(db, table);
    if (columns.size === 0) throw new Error(`数据库缺少 ${table} 表（schema 可能过旧或路径不对）`);
    for (const column of [idColumn, ...fields]) {
      if (!columns.has(column)) throw new Error(`数据库 ${table} 表缺少列 ${column}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 读取 + 预解密（dry-run 与真实执行共用的“计划”阶段）
// ---------------------------------------------------------------------------

function emptyFieldStats() {
  return { rotated: 0, skippedEmpty: 0, skippedInvalid: 0 };
}

function collectPlan(db, oldSecret) {
  const plan = [];
  const stats = {
    tables: [],
    settings: emptyFieldStats(),
    totals: { candidates: 0, decrypted: 0, skippedEmpty: 0, skippedInvalid: 0 },
  };

  for (const { table, idColumn, fields } of ENCRYPTED_TABLES) {
    const select = `SELECT ${idColumn}, ${fields.join(', ')} FROM ${table}`;
    const rows = db.prepare(select).all();
    const tableStats = { table, rows: rows.length, fields: {} };
    for (const field of fields) tableStats.fields[field] = emptyFieldStats();
    for (const row of rows) {
      for (const field of fields) {
        const raw = row[field];
        const fieldStats = tableStats.fields[field];
        if (raw === null || raw === undefined || String(raw).trim() === '') {
          fieldStats.skippedEmpty += 1;
          stats.totals.skippedEmpty += 1;
          continue;
        }
        stats.totals.candidates += 1;
        if (!isCiphertextFormat(raw)) {
          fieldStats.skippedInvalid += 1;
          stats.totals.skippedInvalid += 1;
          continue;
        }
        try {
          const plaintext = decryptWithSecret(raw, oldSecret);
          plan.push({ kind: 'table', table, idColumn, id: row[idColumn], field, plaintext });
          stats.totals.decrypted += 1;
        } catch {
          fieldStats.skippedInvalid += 1;
          stats.totals.skippedInvalid += 1;
        }
      }
    }
    stats.tables.push(tableStats);
  }

  const settingRows = db.prepare('SELECT key, value FROM app_settings').all();
  for (const row of settingRows) {
    if (!ENCRYPTED_SETTING_KEYS.includes(row.key)) continue;
    const raw = row.value;
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      stats.settings.skippedEmpty += 1;
      stats.totals.skippedEmpty += 1;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      stats.settings.skippedInvalid += 1;
      stats.totals.skippedInvalid += 1;
      continue;
    }
    if (typeof parsed !== 'string' || !isCiphertextFormat(parsed)) {
      stats.settings.skippedInvalid += 1;
      stats.totals.skippedInvalid += 1;
      continue;
    }
    stats.totals.candidates += 1;
    try {
      const plaintext = decryptWithSecret(parsed, oldSecret);
      plan.push({ kind: 'setting', key: row.key, plaintext });
      stats.totals.decrypted += 1;
    } catch {
      stats.settings.skippedInvalid += 1;
      stats.totals.skippedInvalid += 1;
    }
  }

  // 能嗅到密文却一条都解不开 ⇒ 旧 secret 不匹配（或全部损坏），必须中止，避免写入混合密钥。
  if (stats.totals.candidates > 0 && stats.totals.decrypted === 0) {
    throw new Error(
      '旧 APP_SECRET 无法解密任何一条密文：请确认 APP_SECRET / app-secret.key 与被轮换数据库匹配。',
    );
  }

  for (const item of plan) {
    if (item.kind === 'table') {
      const tableStats = stats.tables.find((entry) => entry.table === item.table);
      tableStats.fields[item.field].rotated += 1;
    } else {
      stats.settings.rotated += 1;
    }
  }
  stats.totals.rotated = plan.length;
  return { plan, stats };
}

// ---------------------------------------------------------------------------
// 备份 / WAL checkpoint
// ---------------------------------------------------------------------------

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 把 WAL 落盘；checkpoint 失败（例如服务未停）时中止，避免备份到不完整数据。 */
function checkpointWal(db) {
  const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
  if (result && Number(result.busy) !== 0) {
    throw new Error('数据库正被其它进程占用（WAL checkpoint busy）：请先停止 ClawBridge 服务后重试。');
  }
}

/** 备份 DB 文件到 backups/（0600、不覆盖已有文件），返回 {path, bytes}。 */
function createBackup(dbPath, backupDir) {
  const dir = backupDir || path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `clawbridge-before-secret-rotation-${timestamp()}.db`);
  try {
    fs.copyFileSync(dbPath, target, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new Error(`备份文件已存在（${target}）；请等待一秒后重试或手动移走旧备份。`);
    }
    throw new Error(`数据库备份失败：${err.message}`);
  }
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* Windows 等平台忽略 */
  }
  const bytes = fs.statSync(target).size;
  if (bytes <= 0) throw new Error('数据库备份文件为空，已中止（未写库）。');
  return { path: target, bytes };
}

// ---------------------------------------------------------------------------
// 核心轮换逻辑（可测试）
// ---------------------------------------------------------------------------

/**
 * 轮换库内全部加密字段。
 *
 * @param {object} options
 * @param {string} options.dbPath SQLite 数据库路径
 * @param {string} options.oldSecret 旧 APP_SECRET
 * @param {string} options.newSecret 新 APP_SECRET
 * @param {boolean} [options.dryRun=false] 只统计不写库（也不生成备份）
 * @param {string} [options.backupDir] 备份目录（默认 <db 目录>/backups）
 * @returns {object} 统计结果（含 dryRun/dbPath/schemaVersion/backupPath/tables/settings/totals）
 */
export function rotateSecrets(options = {}) {
  const {
    dbPath,
    oldSecret,
    newSecret,
    dryRun = false,
    backupDir = '',
  } = options;
  if (typeof dbPath !== 'string' || dbPath.trim() === '') throw new Error('dbPath 不能为空');
  const oldValue = typeof oldSecret === 'string' ? oldSecret.trim() : '';
  if (oldValue === '') throw new Error('旧 APP_SECRET 不能为空');
  const isDryRun = Boolean(dryRun);
  // dry-run 允许不提供新 secret（只做读取/解密统计）；提供了就一并校验，提前暴露强度问题。
  let newValue = null;
  if (!isDryRun || (typeof newSecret === 'string' && newSecret.trim() !== '')) {
    newValue = validateNewSecret(newSecret);
    if (newValue === oldValue) throw new Error('新 APP_SECRET 不能与旧 APP_SECRET 相同');
  }

  const resolvedDbPath = path.resolve(dbPath);
  const db = openDb(resolvedDbPath, { readOnly: isDryRun });
  try {
    assertTargetSchema(db);
    const schemaVersion = readSchemaVersion(db);
    const { plan, stats } = collectPlan(db, oldValue);

    const result = {
      dryRun: isDryRun,
      dbPath: resolvedDbPath,
      schemaVersion,
      backupPath: null,
      backupBytes: 0,
      tables: stats.tables,
      settings: stats.settings,
      totals: stats.totals,
    };
    if (isDryRun) return result;

    // 真实执行：先确保 WAL 落盘 → 备份 → 事务内逐条改写；任一步失败均不留下部分轮换。
    checkpointWal(db);
    const backup = createBackup(resolvedDbPath, backupDir);
    result.backupPath = backup.path;
    result.backupBytes = backup.bytes;

    const statements = new Map();
    const statementFor = (sql) => {
      let statement = statements.get(sql);
      if (!statement) {
        statement = db.prepare(sql);
        statements.set(sql, statement);
      }
      return statement;
    };

    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const item of plan) {
        if (item.kind === 'table') {
          const encrypted = encryptWithSecret(item.plaintext, newValue);
          statementFor(`UPDATE ${item.table} SET ${item.field} = ? WHERE ${item.idColumn || 'id'} = ?`).run(
            encrypted,
            item.id,
          );
        } else {
          const encrypted = encryptWithSecret(item.plaintext, newValue);
          statementFor('UPDATE app_settings SET value = ? WHERE key = ?').run(
            JSON.stringify(encrypted),
            item.key,
          );
        }
      }
      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        /* 回滚失败时保留原始错误 */
      }
      throw err;
    }

    // 事务提交后再 checkpoint 一次，确保新密文已落主库文件（备份已完成，可安全继续）。
    checkpointWal(db);
    return result;
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略关闭失败 */
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `APP_SECRET 轮换工具（离线/停机维护；严禁对运行中的库执行）

用法：
  node scripts/rotate-app-secret.mjs --data-dir <dir> --dry-run
  node scripts/rotate-app-secret.mjs --data-dir <dir> --yes [--new-secret <64hex>]

参数：
  --data-dir <dir>    数据目录（默认 $DATA_DIR 或 ./data）；DB 为 <dir>/clawbridge.db
  --backup-dir <dir>  备份目录（默认 <data-dir>/backups）
  --dry-run           只统计待轮换条数：不写库、不生成备份
  --yes               确认真实执行（非 dry-run 时必填）
  --new-secret <s>    新 APP_SECRET；省略则在交互终端中提示输入（不回显）
  --help, -h          显示本帮助

旧 APP_SECRET 读取顺序：环境变量 APP_SECRET → <data-dir>/app-secret.key。
新 secret 要求：64 位十六进制，或长度 ≥32 且至少包含 3 类字符。
轮换完成后需把新 APP_SECRET 写入 .env / Docker secret / app-secret.key 并重启服务。
`;

/** 解析 CLI 参数（导出便于测试）。 */
export function parseCliArgs(argv) {
  const args = { dataDir: '', backupDir: '', dryRun: false, yes: false, newSecret: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const name = eq >= 0 ? token.slice(0, eq) : token;
    const inlineValue = eq >= 0 ? token.slice(eq + 1) : '';
    const readValue = (label) => {
      if (inlineValue !== '') return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`参数 ${label} 缺少取值`);
      i += 1;
      return next;
    };
    if (name === '--data-dir') args.dataDir = readValue('--data-dir');
    else if (name === '--backup-dir') args.backupDir = readValue('--backup-dir');
    else if (name === '--new-secret') args.newSecret = readValue('--new-secret');
    else if (name === '--dry-run') args.dryRun = true;
    else if (name === '--yes' || name === '-y') args.yes = true;
    else if (name === '--help' || name === '-h') args.help = true;
    else throw new Error(`未知参数：${token}`);
  }
  return args;
}

function resolveDataDir(args) {
  const raw = args.dataDir || process.env.DATA_DIR || 'data';
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

/** 旧 secret：env APP_SECRET 优先，其次 <data-dir>/app-secret.key。 */
export function resolveOldSecret(dataDir) {
  const fromEnv = typeof process.env.APP_SECRET === 'string' ? process.env.APP_SECRET.trim() : '';
  if (fromEnv) return fromEnv;
  const keyFile = path.join(dataDir, 'app-secret.key');
  try {
    const value = fs.readFileSync(keyFile, 'utf8').trim();
    if (value) return value;
  } catch {
    /* 文件不存在，下面统一报错 */
  }
  throw new Error(
    `无法读取旧 APP_SECRET：请设置环境变量 APP_SECRET，或确认 ${keyFile} 存在（该文件由服务首次启动自动生成）。`,
  );
}

function promptHidden(label) {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error('当前不是交互终端：请使用 --new-secret 传入新 APP_SECRET。'));
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const cleanup = () => {
      stdin.removeListener('data', onData);
      if (!wasRaw) stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('已取消'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (ch === '\u001b' || ch === '\t') continue;
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}


function printStats(result) {
  const mode = result.dryRun ? 'dry-run（只统计，未写库）' : '已执行轮换';
  const verb = result.dryRun ? '待轮换' : '轮换';
  console.log(`[rotate-app-secret] ${mode}`);
  console.log(`  数据库：${result.dbPath}`);
  console.log(`  schema：v${result.schemaVersion ?? '?'}`);
  if (result.backupPath) console.log(`  备份：${result.backupPath}（${result.backupBytes} bytes）`);
  for (const table of result.tables) {
    const parts = Object.entries(table.fields)
      .filter(([, s]) => s.rotated || s.skippedEmpty || s.skippedInvalid)
      .map(([field, s]) => `${field}: ${verb} ${s.rotated} / 空 ${s.skippedEmpty} / 无效 ${s.skippedInvalid}`);
    console.log(`  ${table.table}（${table.rows} 行）：${parts.join('；') || '无密文'}`);
  }
  console.log(
    `  app_settings 密文：${verb} ${result.settings.rotated} / 空 ${result.settings.skippedEmpty} / 无效 ${result.settings.skippedInvalid}`,
  );
  console.log(
    `  合计：待处理密文 ${result.totals.candidates}，${verb} ${result.totals.rotated}，空 ${result.totals.skippedEmpty}，无效 ${result.totals.skippedInvalid}`,
  );
  if (result.totals.skippedInvalid > 0) {
    console.log(
      '  ⚠ 存在无法解密/格式非法的密文：这些行保持原样（未改密钥）。若影响业务，请恢复备份后用旧 secret 重跑，或让相关用户/规则重建。',
    );
  }
}

function printNextSteps(result) {
  if (result.dryRun) {
    console.log('\n[dry-run] 未写库、未生成备份。确认统计无误后去掉 --dry-run 并加 --yes 执行。');
    return;
  }
  console.log(`
下一步（必须按顺序执行）：
  1) 把新 APP_SECRET 写入部署配置：.env 的 APP_SECRET / Docker secret / data/app-secret.key（三选一，取决于部署方式）；
     不要提交到版本库，也不要通过命令行参数长期保存（--new-secret 会进入 shell 历史，建议改用交互输入或 secret 文件）。
  2) 重启 ClawBridge 服务（APP_SECRET 变化会使现有管理后台会话失效，需要重新登录）。
  3) 验证：/health、后台登录、发送消息、接口应用「测试运行」、定时任务「测试运行」。
  4) 回滚：停止服务，用上面的备份文件恢复 <data-dir>/clawbridge.db，并把 APP_SECRET 改回旧值。
`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const dataDir = resolveDataDir(args);
  const dbPath = path.join(dataDir, 'clawbridge.db');
  const oldSecret = resolveOldSecret(dataDir);
  if (args.dryRun) {
    const result = rotateSecrets({
      dbPath,
      oldSecret,
      newSecret: args.newSecret || undefined,
      dryRun: true,
      backupDir: args.backupDir,
    });
    printStats(result);
    printNextSteps(result);
    return;
  }
  if (!args.yes) {
    throw new Error('真实执行必须加 --yes（建议先 --dry-run 查看统计）。');
  }
  const newSecretRaw = args.newSecret || (await promptHidden('新 APP_SECRET（输入不回显）：'));
  const newSecret = validateNewSecret(newSecretRaw);
  const result = rotateSecrets({ dbPath, oldSecret, newSecret, dryRun: false, backupDir: args.backupDir });
  printStats(result);
  printNextSteps(result);
}

const ENTRY = process.argv[1] ? path.resolve(process.argv[1]) : '';
const SELF = fileURLToPath(import.meta.url);
if (ENTRY && path.resolve(SELF) === ENTRY) {
  main().catch((err) => {
    console.error(`[rotate-app-secret] 失败：${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}
