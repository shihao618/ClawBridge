#!/usr/bin/env node
/**
 * doc-lint：文档「值级」一致性检查（零依赖，仅 Node 内置模块）。
 *
 * 检查项（任一失败以非 0 退出，并输出 文件:行/键名 期望 vs 实际）：
 *  1) 版本号：package.json version ↔ README「当前版本」、docs/API.md 的 JSON health 示例、
 *     docs/UPGRADE.md「适用版本」。
 *  2) 环境变量：server/src/config.js 读取的 env ⊆ .env.example（注释/赋值形式均算）；
 *     .env.example 中除显式白名单（Compose/mock/维护模块等非 config 变量）外不得残留未知/废弃变量。
 *  3) 设置字段：server/src/settings.js SETTINGS_SCHEMA 的 group.field ↔ docs/SETTINGS.md 对应分组表；
 *     文档出现未知字段同样失败。
 *  4) API 端点：docs/API.md 中的端点 ⊆ web/docs.html；web/docs.html 额外端点必须能映射到
 *     API.md 的路径模板（参数占位符）或命中显式白名单。
 *  5) 相对链接：docs/**\/*.md 与 README.md 中的 `](path)` 目标必须存在（http/https/mailto/锚点除外）。
 *  6) README「质量与验收」表格中的命令：`npm run X` 必须是 package.json scripts 中的脚本，
 *     `node <path>` 必须是仓库内存在的文件，`npm <cmd>` 允许 package.json scripts 或通用命令。
 *
 * 运行：`node scripts/doc-lint.mjs` 或 `npm run doc:lint`（CI 在 ESLint 之后执行）。
 * 说明：本工具只读，不修改文档；发现真实漂移时应由文档负责人修正后重新运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** .env.example 中允许存在但不由 config.js 读取的变量（其它模块/Compose/mock 使用）。 */
const NON_CONFIG_ENV_ALLOWLIST = new Map([
  ['DATA_PATH', 'docker-compose.fnos.yml 的宿主数据目录'],
  ['PUID', 'docker-compose.fnos.yml 容器运行 UID'],
  ['PGID', 'docker-compose.fnos.yml 容器运行 GID'],
  ['MOCK_AUTO_CONFIRM_MS', 'mock/ilink-mock.mjs 本地模拟器'],
  ['MOCK_PORT', 'mock/ilink-mock.mjs 本地模拟器'],
  ['MAINTENANCE_ENABLED', 'server/src/maintenance.js 数据维护'],
  ['MAINTENANCE_INITIAL_DELAY_MS', 'server/src/maintenance.js 数据维护'],
  ['MAINTENANCE_INTERVAL_MS', 'server/src/maintenance.js 数据维护'],
  ['MAINTENANCE_LOG_RETENTION_DAYS', 'server/src/maintenance.js 数据维护'],
  ['MAINTENANCE_UPLOAD_RETENTION_DAYS', 'server/src/maintenance.js 数据维护'],
  ['MAINTENANCE_BATCH_SIZE', 'server/src/maintenance.js 数据维护'],
  ['MAINTENANCE_ORPHAN_FILE_MIN_AGE_MS', 'server/src/maintenance.js 数据维护'],
  ['MAINTENANCE_PRAGMA_OPTIMIZE', 'server/src/maintenance.js 数据维护'],
  ['MAINTENANCE_WAL_CHECKPOINT', 'server/src/maintenance.js 数据维护'],
  ['DB_SYNCHRONOUS', 'server/src/db.js 读取的 SQLite synchronous 级别（NORMAL/FULL）'],
]);

/** 已废弃变量：即使出现在 .env.example 中也必须报错（历史迁移提示）。 */
const DEPRECATED_ENV = new Set(['ADMIN_PASSWORD', 'API_TOKEN']);

/** web/docs.html 允许出现、但 API.md 未列出的额外端点（当前为空；新例外需在此登记原因）。 */
const HTML_ENDPOINT_ALLOWLIST = new Set([]);

/** 允许跳过的相对链接（当前为空；如确需跳过请在此登记 [文件, 目标] 与原因）。 */
const LINK_ALLOWLIST = [];

/** README 质量表允许的非 package.json script 的 `npm <cmd>` 通用命令。 */
const KNOWN_NPM_COMMANDS = new Set(['ci', 'install', 'update', 'audit']);

const issues = [];

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readLines(relativePath) {
  return readText(relativePath).replace(/\r\n/g, '\n').split('\n');
}

function addIssue(file, line, message) {
  issues.push({ file, line: Number(line) || 0, message });
}

/** 递归列出目录下 .md 文件（相对 ROOT 的 POSIX 路径）。 */
function listMarkdownFiles(relativeDir) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`, relativePath);
      else if (entry.name.endsWith('.md')) files.push(relativePath);
    }
  };
  walk(relativeDir, relativeDir);
  return files.sort();
}

/** 在给定行中查找首个匹配并返回值与行号。 */
function findFirstMatch(lines, pattern) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index]);
    if (match) return { value: match[1], line: index + 1 };
  }
  return null;
}

/** 计算字符串下标所在行号（用于把源码偏移转换为 file:line）。 */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/* ------------------------------------------------------------------ */
/* 1) 版本号                                                           */
/* ------------------------------------------------------------------ */
function checkVersions() {
  const version = JSON.parse(readText('package.json')).version;
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) {
    addIssue('package.json', 0, `version 不是合法的 x.y.z：${version}`);
    return `跳过版本号核对（package.json version 非法：${version}）`;
  }

  const readmeLines = readLines('README.md');
  const current = findFirstMatch(readmeLines, /当前版本\s*\**\s*v?(\d+\.\d+\.\d+)/);
  if (!current) addIssue('README.md', 0, `未找到「当前版本 x.y.z」声明（期望 ${version}）`);
  else if (current.value !== version) {
    addIssue('README.md', current.line, `当前版本与 package.json 不一致：期望 ${version}，实际 ${current.value}`);
  }

  // docs/API.md：仅校验 JSON 字段 "version": "x.y.z"（health / config 示例），不校验历史叙述
  const apiLines = readLines('docs/API.md');
  let apiVersionCount = 0;
  apiLines.forEach((line, index) => {
    for (const match of line.matchAll(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/g)) {
      apiVersionCount += 1;
      if (match[1] !== version) {
        addIssue('docs/API.md', index + 1, `示例 version 期望 ${version}，实际 ${match[1]}`);
      }
    }
  });
  if (apiVersionCount === 0) addIssue('docs/API.md', 0, `未找到 health/config 示例中的 "version": "x.y.z"（期望 ${version}）`);

  // docs/UPGRADE.md：仅校验「适用版本」抬头（正文历史版本说明保持原样）
  const upgradeLines = readLines('docs/UPGRADE.md');
  const applicable = findFirstMatch(upgradeLines, /适用版本[^\d]{0,40}?(\d+\.\d+\.\d+)/);
  if (!applicable) addIssue('docs/UPGRADE.md', 0, `未找到「适用版本：ClawBridge x.y.z」（期望 ${version}）`);
  else if (applicable.value !== version) {
    addIssue('docs/UPGRADE.md', applicable.line, `适用版本与 package.json 不一致：期望 ${version}，实际 ${applicable.value}`);
  }

  return `版本号一致（${version}）：README 当前版本、docs/API.md 示例 ×${apiVersionCount}、docs/UPGRADE.md 适用版本`;
}

/* ------------------------------------------------------------------ */
/* 2) 环境变量                                                         */
/* ------------------------------------------------------------------ */
function checkEnvVars() {
  const configLines = readLines('server/src/config.js');
  const configEnv = new Map();
  configLines.forEach((line, index) => {
    for (const match of line.matchAll(/env(?:Str|Int|Bool)\(\s*env,\s*['"]([A-Z0-9_]+)['"]/g)) {
      if (!configEnv.has(match[1])) configEnv.set(match[1], index + 1);
    }
  });
  if (configEnv.size === 0) addIssue('server/src/config.js', 0, '未解析到任何 env 读取（envStr/envInt/envBool）');

  const exampleLines = readLines('.env.example');
  const exampleEnv = new Map();
  exampleLines.forEach((line, index) => {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (match && !exampleEnv.has(match[1])) exampleEnv.set(match[1], index + 1);
  });

  for (const [name, line] of configEnv) {
    if (!exampleEnv.has(name)) {
      addIssue('server/src/config.js', line, `env ${name} 未在 .env.example 声明（注释或赋值形式均可）`);
    }
  }
  for (const [name, line] of exampleEnv) {
    if (DEPRECATED_ENV.has(name)) {
      addIssue('.env.example', line, `已废弃变量 ${name} 不应继续出现在模板中（现由 DB/后台管理）`);
      continue;
    }
    if (configEnv.has(name)) continue;
    if (NON_CONFIG_ENV_ALLOWLIST.has(name)) continue;
    addIssue(
      '.env.example',
      line,
      `未知变量 ${name}：config.js 未读取；若由其它模块/Compose 使用，请加入 doc-lint 白名单并注明原因`,
    );
  }

  return `环境变量一致（config.js ${configEnv.size} 项均已在 .env.example；白名单非 config 变量 ${NON_CONFIG_ENV_ALLOWLIST.size} 项）`;
}

/* ------------------------------------------------------------------ */
/* 3) 设置字段（SETTINGS_SCHEMA ↔ docs/SETTINGS.md）                    */
/* ------------------------------------------------------------------ */
/**
 * 定位 SETTINGS_SCHEMA 定义文件：settings.js 可能作为 facade，把 schema 拆到 settings/schema.js
 * （模块拆分后仍保持 GROUPS 结构不变）。返回 { file, text } 或 null。
 */
function locateSettingsSchemaSource() {
  const candidates = ['server/src/settings/schema.js', 'server/src/settings.js'];
  const settingsDir = path.join(ROOT, 'server/src/settings');
  if (fs.existsSync(settingsDir)) {
    for (const name of fs.readdirSync(settingsDir).sort()) {
      if (name.endsWith('.js')) candidates.push(`server/src/settings/${name}`);
    }
  }
  for (const file of candidates) {
    if (!fs.existsSync(path.join(ROOT, file))) continue;
    const text = readText(file);
    if (/(?:export\s+)?const GROUPS = \[/.test(text)) return { file, text };
  }
  return null;
}

function parseSettingsGroups(source) {
  const groups = new Map();
  const groupsMatch = /(?:export\s+)?const GROUPS = \[/.exec(source);
  if (!groupsMatch) return groups;
  const start = groupsMatch.index;
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('[', start); i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return groups;
  const arrayBody = source.slice(source.indexOf('[', start) + 1, end);
  const arrayBodyOffset = source.indexOf('[', start) + 1;
  const groupObjects = [];
  let objectDepth = 0;
  let objectStart = -1;
  for (let i = 0; i < arrayBody.length; i += 1) {
    if (arrayBody[i] === '{') {
      if (objectDepth === 0) objectStart = i;
      objectDepth += 1;
    } else if (arrayBody[i] === '}') {
      objectDepth -= 1;
      if (objectDepth === 0 && objectStart >= 0) {
        groupObjects.push({ text: arrayBody.slice(objectStart, i + 1), offset: objectStart });
        objectStart = -1;
      }
    }
  }
  for (const groupObject of groupObjects) {
    const keyMatch = /key:\s*'([A-Za-z0-9_]+)'/.exec(groupObject.text);
    const fieldsIndex = groupObject.text.indexOf('fields: [');
    if (!keyMatch || fieldsIndex < 0) continue;
    const fields = new Map();
    for (const match of groupObject.text.slice(fieldsIndex).matchAll(/\{\s*key:\s*'([A-Za-z0-9_]+)'/g)) {
      if (!fields.has(match[1])) {
        fields.set(match[1], lineAt(source, arrayBodyOffset + groupObject.offset + fieldsIndex + match.index));
      }
    }
    groups.set(keyMatch[1], fields);
  }
  return groups;
}

function parseSettingsDoc(lines) {
  const docGroups = new Map();
  lines.forEach((line, index) => {
    if (!line.trim().startsWith('|')) return;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2) return;
    const group = cells[0].replace(/`/g, '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(group)) return;
    const fieldsText = cells.slice(1).join(' | ');
    const fields = [...fieldsText.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)].map((match) => match[1]);
    if (fields.length === 0) return;
    if (!docGroups.has(group)) docGroups.set(group, { line: index + 1, fields: new Map() });
    const entry = docGroups.get(group);
    for (const field of fields) if (!entry.fields.has(field)) entry.fields.set(field, index + 1);
  });
  return docGroups;
}

function checkSettingsSchema() {
  const schemaSource = locateSettingsSchemaSource();
  if (!schemaSource) {
    addIssue('server/src/settings.js', 0, '未找到 SETTINGS_SCHEMA 定义（settings.js 或 settings/schema.js 的 const GROUPS = [...]）');
    return '跳过设置字段核对（未找到 SETTINGS_SCHEMA 定义）';
  }
  const groups = parseSettingsGroups(schemaSource.text);
  if (groups.size === 0) {
    addIssue(schemaSource.file, 0, '已定位 GROUPS 定义但未解析出分组/字段');
    return '跳过设置字段核对（SETTINGS_SCHEMA 解析为空）';
  }
  // 文档中只有登记为 SETTINGS_SCHEMA 分组名的表格行才参与比对（§0 总表 + §7.2 分组表都会命中）
  const docGroups = parseSettingsDoc(readLines('docs/SETTINGS.md'));
  let fieldCount = 0;
  for (const [group, fields] of groups) {
    fieldCount += fields.size;
    const docEntry = docGroups.get(group);
    if (!docEntry) {
      addIssue('docs/SETTINGS.md', 0, `缺少配置分组 ${group}（期望字段：${[...fields.keys()].join('、')}）`);
      continue;
    }
    for (const field of fields.keys()) {
      if (!docEntry.fields.has(field)) {
        addIssue('docs/SETTINGS.md', docEntry.line, `分组 ${group} 缺少字段 ${field}（${schemaSource.file} 已声明）`);
      }
    }
    for (const [field, line] of docEntry.fields) {
      if (!fields.has(field)) {
        addIssue('docs/SETTINGS.md', line, `分组 ${group} 出现未知字段 ${field}（${schemaSource.file} SETTINGS_SCHEMA 无此字段）`);
      }
    }
  }
  return `设置字段一致（${groups.size} 个分组 / ${fieldCount} 个字段，与 docs/SETTINGS.md 双向核对）`;
}

/* ------------------------------------------------------------------ */
/* 4) API 端点（docs/API.md ↔ web/docs.html）                          */
/* ------------------------------------------------------------------ */
const ENDPOINT_RE = /\/api\/(?:admin|v1|bind|health)(?:\/[a-z0-9/{}_.-]*)?/gi;

function normalizeEndpoint(raw) {
  return raw
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/[.,;:]+$/g, '')
    .replace(/\/$/, '');
}

function extractEndpoints(relativePath) {
  const endpoints = new Map();
  readLines(relativePath).forEach((line, index) => {
    for (const match of line.matchAll(ENDPOINT_RE)) {
      const endpoint = normalizeEndpoint(match[0]);
      if (endpoint.length > 5 && !endpoints.has(endpoint)) endpoints.set(endpoint, index + 1);
    }
  });
  return endpoints;
}

/** docs.html 中的具体示例端点（如 /api/admin/users/u_abc/messages）是否匹配 API.md 的路径模板。 */
function matchesEndpointTemplate(concreteEndpoint, templates) {
  const concreteSegments = concreteEndpoint.split('/');
  for (const template of templates.keys()) {
    const templateSegments = template.split('/');
    if (templateSegments.length !== concreteSegments.length) continue;
    let matched = true;
    for (let i = 0; i < templateSegments.length; i += 1) {
      if (templateSegments[i] === '{}' || templateSegments[i] === concreteSegments[i]) continue;
      matched = false;
      break;
    }
    if (matched) return true;
  }
  return false;
}

function checkApiEndpoints() {
  const apiEndpoints = extractEndpoints('docs/API.md');
  const htmlEndpoints = extractEndpoints('web/docs.html');
  if (apiEndpoints.size === 0) addIssue('docs/API.md', 0, '未解析到任何 /api/... 端点');
  for (const [endpoint, line] of apiEndpoints) {
    if (!htmlEndpoints.has(endpoint)) {
      addIssue('docs/API.md', line, `端点 ${endpoint} 未在 web/docs.html 出现`);
    }
  }
  for (const [endpoint, line] of htmlEndpoints) {
    if (apiEndpoints.has(endpoint)) continue;
    if (matchesEndpointTemplate(endpoint, apiEndpoints)) continue;
    if (HTML_ENDPOINT_ALLOWLIST.has(endpoint)) continue;
    addIssue('web/docs.html', line, `端点 ${endpoint} 不在 docs/API.md，且不能映射到其路径模板（如为示例请登记白名单）`);
  }
  return `API 端点一致（API.md ${apiEndpoints.size} 个端点均被 docs.html 覆盖；docs.html ${htmlEndpoints.size} 个端点均可映射）`;
}

/* ------------------------------------------------------------------ */
/* 5) 相对链接                                                         */
/* ------------------------------------------------------------------ */
function checkRelativeLinks() {
  const files = [...listMarkdownFiles('docs'), 'README.md'];
  let checked = 0;
  const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const file of files) {
    readLines(file).forEach((line, index) => {
      for (const match of line.matchAll(linkPattern)) {
        let target = match[1].trim();
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue; // http(s): mailto: data: 等
        if (target.startsWith('#')) continue; // 页内锚点
        if (target.startsWith('//') || target.startsWith('/')) continue; // 协议相对 / 站点绝对路径
        if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
        const withoutFragment = target.split('#')[0].split('?')[0].trim();
        if (withoutFragment === '') continue;
        let decoded = withoutFragment;
        try {
          decoded = decodeURIComponent(withoutFragment);
        } catch {
          /* 非法编码按原文匹配 */
        }
        checked += 1;
        const absolutePath = path.resolve(path.dirname(path.join(ROOT, file)), decoded);
        if (fs.existsSync(absolutePath)) continue;
        const allowed = LINK_ALLOWLIST.some(([allowedFile, allowedTarget]) => allowedFile === file && allowedTarget === target);
        if (allowed) continue;
        addIssue(file, index + 1, `相对链接目标不存在：${target}（解析：${path.relative(ROOT, absolutePath)}）`);
      }
    });
  }
  return `文档相对链接无断链（docs/**/*.md + README.md，共检查 ${checked} 条）`;
}

/* ------------------------------------------------------------------ */
/* 6) README「质量与验收」命令                                          */
/* ------------------------------------------------------------------ */
function checkReadmeCommands() {
  const lines = readLines('README.md');
  const start = lines.findIndex((line) => line.startsWith('## 质量与验收'));
  if (start < 0) {
    addIssue('README.md', 0, '缺少「## 质量与验收」章节');
    return '跳过 README 质量表命令核对（缺少章节）';
  }
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end += 1;
  const scripts = JSON.parse(readText('package.json')).scripts ?? {};
  let checked = 0;
  for (let index = start; index < end; index += 1) {
    for (const match of lines[index].matchAll(/`([^`]+)`/g)) {
      const token = match[1].trim();
      if (token.startsWith('npm run ')) {
        const scriptName = token.slice('npm run '.length).trim().split(/\s+/)[0];
        checked += 1;
        if (!scripts[scriptName]) {
          addIssue('README.md', index + 1, `命令 ${token} 对应的 script「${scriptName}」不存在于 package.json scripts`);
        }
      } else if (token.startsWith('npm ')) {
        const command = token.slice('npm '.length).trim().split(/\s+/)[0];
        checked += 1;
        if (command && command !== 'run' && !scripts[command] && !KNOWN_NPM_COMMANDS.has(command)) {
          addIssue('README.md', index + 1, `命令 ${token} 既非 package.json scripts，也不在通用 npm 命令白名单`);
        }
      } else if (token.startsWith('node ')) {
        const relativePath = token.slice('node '.length).trim().split(/\s+/)[0];
        checked += 1;
        if (relativePath && !fs.existsSync(path.join(ROOT, relativePath))) {
          addIssue('README.md', index + 1, `命令 ${token} 的文件不存在：${relativePath}`);
        }
      }
    }
  }
  return `README 质量表命令可解析（${checked} 条 npm/node 命令均存在）`;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
const CHECKS = [
  ['版本号', checkVersions],
  ['环境变量', checkEnvVars],
  ['设置字段', checkSettingsSchema],
  ['API 端点', checkApiEndpoints],
  ['相对链接', checkRelativeLinks],
  ['质量表命令', checkReadmeCommands],
];

const summaries = [];
for (const [name, check] of CHECKS) {
  try {
    summaries.push({ name, summary: check() });
  } catch (error) {
    addIssue('scripts/doc-lint.mjs', 0, `${name}检查执行异常：${error?.message ?? error}`);
    summaries.push({ name, summary: '执行异常（见失败项）' });
  }
}

if (issues.length === 0) {
  console.log(`doc-lint 通过：${CHECKS.length} 项值级一致性检查全部通过`);
  for (const { name, summary } of summaries) console.log(`  ✓ ${name}：${summary}`);
  process.exitCode = 0;
} else {
  for (const { name, summary } of summaries) console.log(`  · ${name}：${summary}`);
  console.error(`\ndoc-lint 失败：${issues.length} 项不一致`);
  for (const issue of issues) {
    console.error(`  ✗ ${issue.file}:${issue.line} ${issue.message}`);
  }
  process.exitCode = 1;
}
