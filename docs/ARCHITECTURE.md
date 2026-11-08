# ClawBridge 架构与实现约定

ClawBridge = 多用户微信 ClawBot 扫码绑定 + 消息推送平台（Docker 部署）。

- 技术栈：Node.js ≥22.13（实现与镜像使用 Node 24）+ Express 5 + 内置 `node:sqlite`；
  前端为无构建步骤的原生 HTML/CSS/ES Module；测试用内置 `node --test`。
- 只依赖 `express`、`qrcode` 两个生产依赖（二维码 SVG 服务端渲染，前端零依赖）。
- 单容器：一个 Node 进程同时提供 Web 页面 + 绑定服务 + 管理 API + 推送 API +
  入站长轮询 + 出站队列；SQLite 落盘到 `/app/data`（Docker volume）。
- 协议依据：`docs/PROTOCOL.md`；HTTP API 契约：`docs/API.md`。

## 1. 目录结构与职责（2026-11 模块化重构后）

> 2026-11 重构：`server/src/api.js` 由 1895 行拆为 87 行组合根 + `http/**`/`routes/**` 模块；
> `server/src/store.js` 由 2126 行拆为 23 行 façade + `data/**` 按域模块；`server/src/app-rules.js`
> 由 ~1744 行拆为 656 行 + `shared/**` 模板/HTTP/响应管线；`web/assets/admin.js` 由 5895 行拆为 198 行入口 +
> `admin/**`/`lib/**` 模块。行为与对外契约不变，详见 `docs/CODE_REVIEW.md`。

| 路径 | 内容 |
| --- | --- |
| `server/src/config.js` / `logger.js` / `errors.js` / `crypto.js` / `db.js` / `rate-limiter.js` / `index.js` | 基础层：环境变量与默认值、结构化日志与脱敏、错误类型与错误码、AES-GCM/会话签名、SQLite 初始化与 schema 校验、限流器、进程入口与生命周期（含优雅退出/维护任务接线） |
| `server/src/ilink.js` / `media.js` | 协议层：微信 ClawBot 协议客户端；媒体加解密、MIME、CDN 上下行（出站上传/入站有界并发+流式下载解密） |
| `server/src/store.js` | 数据层 façade：`export *` 重导出 `data/**`，保持既有导出名与调用方零改动 |
| `server/src/data/` | 数据层按域实现：`users.js`、`groups.js`、`keepalive.js`、`rules.js`、`scheduled.js`、`attachments.js`、`outbox.js`、`inbound.js`、`messages.js`、`events.js`、`stats.js` + `mappers.js`/`helpers.js` |
| `server/src/shared/` | 领域共享层：`http-client.js`（SSRF/传输/钉 IP/响应读取）、`template.js`（模板引擎）、`response.js`（响应解析）、`http-execute.js`（渲染→HTTP→解析→渲染回复管线） |
| `server/src/binding.js` / `monitor.js` / `dispatcher.js` / `keepalive.js` / `app-rules.js` / `scheduler.js` / `settings.js` / `auth.js` / `maintenance.js` | 领域层：扫码绑定状态机、入站长轮询、出站队列 drain、会话保活、接口应用规则引擎（656 行，依赖 `shared/**`）、定时通知（依赖 `shared/**`，独立 HTTP 限制配置）、运行配置与机密管理（`settings.js` 32 行 façade + `settings/{schema,validate,apply,secrets,persistence}.js`；`auth.js` 只依赖 secrets）、认证与限流、数据生命周期维护（孤儿附件/日志保留 GC） |
| `server/src/http/` | HTTP 支撑层：`middleware.js`（安全头/body 解析/404/统一错误处理）、`helpers.js`、`views.js`、`validators.js`、`app-rule-validators.js`、`scheduled-validators.js`、`media-handlers.js`、`queue-service.js` |
| `server/src/routes/` | 路由层：`public.js`（健康检查/扫码绑定）、`admin-auth.js`、`admin-users.js`、`admin-groups.js`、`admin-rules.js`、`admin-scheduled.js`、`admin-settings.js`、`admin-messages.js`、`v1.js`、`webhook.js`、`pages.js` |
| `server/src/api.js` | Express 组合根：仅装配中间件顺序与挂载路由（`createApp()`） |
| `web/*.html` + `web/assets/style.css` | 零构建前端页面（绑定页 / 管理后台 / API 文档页）与全站样式（WCAG AA 对比度 token、统一断点） |
| `web/assets/common.js` / `bind.js` / `docs.js` | 公共能力（fetch/上传/DOM/格式化/toast/modal 焦点陷阱/轮询/抽屉）与两个页面入口 |
| `web/assets/admin.js` | 管理后台入口：事件绑定、视图加载器注册、末尾唯一 `init()` |
| `web/assets/admin/` | 管理后台模块：`constants.js`、`state.js`（26 行组合入口）、`state/**`（按域状态 core/users/messages/groups/rules/scheduled/settings + els）、`core.js`（认证/hash 路由/刷新/注册表）、`ui.js`（公共 UI 构建器）、`templates.js`（模板语法/Markdown 预览）、`views/*.js`（8 个菜单视图 + 发送消息弹窗）、`integrations/**`（规则/定时编辑器共享片段） |
| `web/assets/lib/` | 前端纯函数模块（parse/settings/summary/media），可被 `node:test` 直接单测 |
| `mock/**` | 零依赖微信 iLink 模拟器 + 控制面 + 自测（26 项，含 `/mock-bind` 占位页） |
| `tests/unit/**` | 进程内单测 + 前端静态/模块/纯函数测试 + 生命周期/错误/维护等针对性测试 |
| `tests/e2e/**` | 真实 app + mock 双进程、随机端口、临时 DATA_DIR 的全 HTTP 黑盒测试（子进程 env 白名单、稳定等待断言、mock 违规统一断言） |
| `tests/helpers/e2e-env.mjs` | e2e 环境管理、断言助手、外部 HTTP mock、媒体工具、优雅退出/清理 |
| `scripts/**` | `demo.ps1`/`demo.sh` 一键演示；`frontend-smoke.mjs` 浏览器冒烟（`npm run test:ui`）；`screenshots.mjs` 演示数据 WebP 截图；`e2e-stability.mjs` e2e 连跑稳定性；`doc-lint.mjs` 文档值级一致性检查 |
| `docs/**` | 协议与设计契约（PROTOCOL / API / ARCHITECTURE / MEDIA / GROUPS_AND_INBOUND / KEEPALIVE / API_RULES / SCHEDULED_TASKS / SETTINGS / UPGRADE / CODE_REVIEW） |
| `Dockerfile` / `docker-compose*.yml` / `.github/workflows/**` | 构建、部署与 CI（PR：lint + coverage 门禁；main 发布前同样先跑测试，镜像带 provenance/SBOM） |
| `eslint.config.js` / `.editorconfig` / `.gitattributes` | 静态检查与跨平台编辑器/换行约定 |

**依赖方向（后端）**：基础层 → 协议层 → 数据层 → 领域层 → 组合根（`api.js`）→ 进程入口（`index.js`）；
`http/**` 与 `routes/**` 只依赖上游，不反向依赖 `api.js`。
**依赖方向（前端）**：`admin.js`（entry）→ `admin/views/**` → `{core, ui, state, templates, lib, common}`；
`core.js` 不 import views（由 entry 调用 `registerViewLoaders/registerDataLoader` 注册），`lib/**` 为零依赖纯函数；
`tests/unit/frontend-modules.test.js` 静态强制该约束（import 路径存在、无环、入口可达、entry ≤ 600 行）。

## 2. 运行时模块与数据流

```
浏览器（公开绑定页/管理后台）
   │  HTTP（同源）
   ▼
Express（api.js 组合根：http/middleware 中间件 → routes/* 路由）── 静态页面(web/) + /health + /api/...
   │
   ├─ binding.js ── iLink.getBotQrcode / getQrcodeStatus ──► 微信 ClawBot (ilinkai.weixin.qq.com)
   │      └─ confirmed → store.upsertUser()（按 wechat_user_id，旧凭证清理）+ monitor.start(user)
   ├─ monitor.js ── iLink.notifyStart / getUpdates（长轮询，每账号一个循环）
   │      └─ INBOUND 消息 → store.saveInbound()（加密保存 context_token、更新 get_updates_buf）
   ├─ dispatcher.js（单循环 worker）── store 取 queued outbox → 限流 → iLink.sendMessage
   │      └─ 成功 sent / -2 退避重试 / -14 标记 pause 1h 且失败剩余
   └─ auth.js ── admin Cookie 会话；v1 API Key；绑定页 IP 限流
```

进程生命周期（`index.js`）：

1. 加载 config/logger → 初始化 DB（`db.js` 建表/校验当前 schema 版本）；
2. 启动 HTTP server（0.0.0.0:PORT）；
3. 启动 dispatcher worker；
4. 为所有 `status='active'` 且 `pause_until<=now` 的用户启动入站监控（按 `MONITOR_MAX_ACCOUNTS` 限并发，
   启动间隔 100ms 防尖峰）；
5. 注册 `SIGTERM`/`SIGINT`：停止接受新请求 → 停止 dispatcher 与 monitors（对每个账号 best-effort
   `notifyStop`）→ 关闭 DB → 退出。必须幂等、超时兜底（例如 10s 后 `process.exit(0)`）。

## 3. 数据库 Schema（`node:sqlite`，WAL）

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                     -- 'u_' + randomUUID
  display_name TEXT NOT NULL DEFAULT '',
  wechat_user_id TEXT NOT NULL,            -- iLink ilink_user_id（扫码微信用户）
  ilink_bot_id TEXT,                       -- 机器人账号 ID
  token_enc TEXT,                          -- AES-256-GCM 加密后的 bot_token
  base_url TEXT NOT NULL DEFAULT '',
  context_token_enc TEXT,                  -- 加密后的最近 context_token
  context_token_updated_at INTEGER NOT NULL DEFAULT 0,
  get_updates_buf TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',   -- active | unbound
  bound_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_inbound_at INTEGER NOT NULL DEFAULT 0,
  last_outbound_at INTEGER NOT NULL DEFAULT 0,
  last_poll_at INTEGER NOT NULL DEFAULT 0,
  pause_until INTEGER NOT NULL DEFAULT 0,  -- >now 表示 -14 冷却中（对 API 表现为 paused）
  last_error TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wechat ON users(wechat_user_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,                     -- 'ob_' + randomUUID
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'api',      -- admin | api | broadcast | system
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | sending | sent | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  server_message_id TEXT,
  client_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_user ON outbox(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id TEXT PRIMARY KEY,                     -- 'in_' + randomUUID
  user_id TEXT,
  wechat_message_id TEXT,
  from_user_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  item_types TEXT NOT NULL DEFAULT '',     -- 如 "1" / "1,2"
  raw_json TEXT NOT NULL DEFAULT '',       -- 截断后的原始消息（<=8KB）
  created_at INTEGER NOT NULL,             -- 微信消息时间戳
  received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_msgid
  ON inbound_messages(wechat_message_id)
  WHERE wechat_message_id IS NOT NULL AND wechat_message_id <> '';
CREATE INDEX IF NOT EXISTS idx_inbound_user ON inbound_messages(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                      -- bind/login/bind_error/rebind/unbind/stale_token/...
  user_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
```

约定：

- 所有敏感值（`token_enc`、`context_token_enc`）只能通过 `crypto.encryptSecret()` 写入、
  `crypto.decryptSecretOrNull()` 读取；任何 API/日志不得返回明文 token。
- 时间统一为毫秒整数。
- 开启 WAL；`db.js` 内设置 `busy_timeout`（如 5000）。单进程写，无需连接池。
- 高频查询索引：`inbound_messages(received_at, id)`（对外入站 API 游标/长轮询）、
  `inbound_messages(created_at DESC)` 与 `outbox(created_at DESC)`（后台消息记录 UNION 排序/今日统计）
  通过 `CREATE INDEX IF NOT EXISTS` 在每次启动**幂等创建/补齐**——无需 schema 版本变更，
  既有 v10 数据卷升级后自动生效（首次启动会多一次建索引耗时，数据量大时属正常）。
- schema：`meta` 表存 `schema_version`，当前版本 10；**不再支持旧版本迁移**。启动时若发现非当前
  版本（且非全新库）直接失败，要求备份后使用新版空库；当前 schema 使用 `CREATE TABLE IF NOT EXISTS` 建表。


## 4. 绑定会话（binding.js，内存态）

```js
{
  id, tokenHash, displayName,
  status,             // waiting|scanned|need_verifycode|refreshing|verify_blocked|confirmed|already_bound|expired|timeout|error|cancelled
  qrcode, qrContent, qrSvg, qrExpiresAt,
  refreshCount, verifyCode (pending), apiBaseUrl, redirectHost,
  userId (confirmed 后), error,
  createdAt, updatedAt, expiresAt, ip,
  workerStarted
}
```

- 创建：`POST /api/bind/sessions` → 校验 IP 限流/并发上限 → 调 `ilink.getBotQrcode()`（带本机最近
  10 个账号 token 的 `local_token_list`）→ 用 `qrcode` 包生成 SVG（`toString(content, {type:'svg'})`），
  返回 `data:image/svg+xml;base64,...` → 启动该会话 worker（异步，不阻塞请求）。
- worker：循环 `ilink.getQrcodeStatus()`；按 `docs/PROTOCOL.md` 5.2 状态机处理：
  - `wait`/`scanned`：更新状态，继续；
  - `need_verifycode`：状态置 `need_verifycode` 等待用户提交（`POST .../verify-code` 写入 pending），
    下一次轮询携带 `verify_code`；连续 2 分钟未提交 → 状态 `timeout`；
  - `expired`：`refreshCount+1` >3 → `expired`；否则状态 `refreshing`，重新 `getBotQrcode()`
    更新二维码后继续；
  - `verify_code_blocked`：清 pending、刷新二维码（计入次数），状态 `verify_blocked`；
  - `scaned_but_redirect`：切换轮询 base URL 到 `https://<redirect_host>`；
  - `binded_redirect`：状态 `already_bound`，尝试按微信用户找已有用户返回；结束；
  - `confirmed`：校验 `ilink_bot_id` → `store.upsertUser(...)`（同 wechat_user_id 视为换绑，
    清旧凭证与 context token、重置 pause_until）→ 启动该用户 monitor → 状态 `confirmed`，
    返回 `user` 摘要；写入 events 表 `bind`/`rebind`；
  - 网络错误/超时：不终止，记录连续错误数，>=5 次 → `error`；每轮结束按 1s 间隔；
  - 整体超过 `config.binding.ttlMs` → `timeout`。
- 会话保留 10 分钟供前端查询；后台每 60s 清理过期会话（内存 Map）。
- 同一 IP 的创建次数用内存滑动窗口限制（`config.binding.ipLimitPerHour`）。

## 5. 出站队列与限流（dispatcher.js + rate-limiter.js）

- API 只负责入队（202），不等待微信 API。
- dispatcher 单循环（`config.push.tickMs`）：
  1. 取 `status='queued' AND next_attempt_at<=now` 的最早一条 outbox；
  2. 加载用户；用户不是 `active` 或 `pause_until>now` → 失败该条（错误写清原因）；
  3. 每账号令牌桶限流（`config.push.rateLimitMax` 条 / `rateLimitWindowMs` 窗口）：
     无配额时把该账号所有 queued 的 `next_attempt_at` 推到配额可用时间，跳过；
  4. 标记 `sending`，调 `ilink.sendText({baseUrl, token, toUserId: user.wechat_user_id,
     text, contextToken: decrypt(context_token_enc)})`；
  5. 成功 → `sent`、`server_message_id`、`sent_at`，更新用户 `last_outbound_at`；
  6. 失败 → `attempts+1`：
     - `-2`（限流）：按 `config.push.retryDelaysMs` 退避后重试；若 `errmsg=prepare failed`，表示
       context_token 缺失/失效，直接 failed 并提示用户先给 bot 发消息刷新会话，不按限流重试；
     - `-14`（token 失效）：用户 `pause_until=now+1h`、`last_error`，该条与其余 queued
       标记 `failed`（错误："bot token 已失效，需要用户重新扫码绑定"），写 events；
     - 其他错误：同上退避重试，超过 `maxAttempts` → `failed`。
- `rate-limiter.js` 必须可注入时钟（`now()`）以便单测；同账号严格串行（单 dispatcher 保证）。
- 进程重启后 `sending` 状态的记录要恢复为 `queued`（启动时重置）。

## 6. 入站监控（monitor.js）

- `start(user)`：加入 Map（key=userId），异步循环：
  ```
  best-effort ilink.notifyStart()
  while active && !paused:
    resp = ilink.getUpdates({getUpdatesBuf})     // 超时/中止返回空，正常继续
    if resp.errcode/-ret === -14: 用户 pause_until=now+1h、事件 stale_token、退出循环
    if 其他错误: 连续失败计数（3 次 → 退避 30s，否则 2s）
    if resp.get_updates_buf: 保存到 users.get_updates_buf
    for msg of resp.msgs:
      resp.longpolling_timeout_ms 更新下一次超时
      - 仅处理 from_user_id 非空的消息；
      - 按 message_id 去重（inbound_messages 唯一索引，冲突忽略）；
      - 文本取 item_list 中第一个 type=1 的 text_item.text；无文本取 "[图片]" 等占位；
      - 保存 inbound_messages（raw_json 截断 8KB）；
      - 若有 context_token：更新用户 context_token_enc/updated_at；
      - 更新 last_inbound_at/last_poll_at。
  stop(userId, {notify})：abort 循环（AbortController）→ best-effort notifyStop → 从 Map 移除
  ```
- **入站媒体（BA-02/BA-05，2026-11）**：`processMessages` 对每条消息的媒体 item 走进程级有界闸门
  （默认并发 2、排队 64、排队超时 60s；超限/超时记 `attachments.status='failed'` 而不是无限堆积）；
  下载+解密为**流式落盘**（`.part` 临时文件 → 原子 rename，内存 O(chunk)）；下载 URL 做协议/主机白名单
  校验（iLink/CDN + `MEDIA_ALLOWED_HOSTS`，生产默认拒绝本机/私网），`redirect:'manual'` 每跳复验，最多 3 跳。
  详见 `docs/MEDIA.md` §2/§7。
- 启动恢复：`index.js` 对每个 active 用户 `monitor.start()`；监控数上限 `config.monitor.maxAccounts`。
- `stop` 必须可重复调用（幂等）；测试可通过管理端 unbind 验证 notifyStop 被调用。

## 7. 环境变量（config.js 已实现，直接使用 `config`）

> 第二批运行配置迁移后，仅 `APP_SECRET` / `DATA_DIR` / `MEDIA_DIR` / `PORT` / `HOST` / `NODE_ENV`
> 必须由 env 提供；其余同名 env 仅作为首次启动默认值，保存到 DB 后以后台「运行配置」为准
> （管理密码/API Token 完全由 DB 管理，env 不再读取）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `10380` / `0.0.0.0` | HTTP 监听（Docker 内外一致 10380，一般不改） |
| `DATA_DIR` | `<repo>/data` | SQLite/secret 目录（Docker 用 `/app/data`） |
| `APP_SECRET` | 自动生成 `data/app-secret.key` | 加密主密钥 |
| `ADMIN_PASSWORD` | —（不再读取 env） | 管理密码只存 DB（scrypt 哈希）；首启自动生成到 `data/admin-password.txt` |
| `API_TOKEN` | —（不再读取 env） | API Token 只存 DB（AES 密文）；首启生成到 `data/api-token.txt`，后台可重置 |
| `PUBLIC_BASE_URL` | 空 | 公网地址（展示/文档用） |
| `TRUST_PROXY` / `COOKIE_SECURE` | false | 反代场景 |
| `LOG_LEVEL` | info(prod)/debug(dev) | 日志级别 |
| `ILINK_LOGIN_BASE_URL` / `ILINK_BASE_URL` | `https://ilinkai.weixin.qq.com` | 微信 API（e2e/demo 指向 mock） |
| `ILINK_APP_ID` / `ILINK_CLIENT_VERSION` / `CHANNEL_VERSION` / `BOT_AGENT` / `ILINK_BOT_TYPE` | `bot` / `132106` / `2.4.10` / `OpenClaw` / `3` | 协议常量覆盖 |
| `BINDING_TTL_MS` / `BINDING_MAX_REFRESHES` / `BINDING_MAX_ACTIVE` / `BINDING_IP_LIMIT_PER_HOUR` | 600000 / 3 / 50 / 20 | 绑定会话 |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | 7 / 300000 | 每账号发送限流 |
| `PUSH_MAX_ATTEMPTS` / `PUSH_RETRY_DELAYS_MS` / `MAX_TEXT_LENGTH` / `API_RATE_LIMIT_PER_MINUTE` | 5 / `5000,15000,30000,60000` / 4000 / 60 | 队列/校验 |
| `MONITOR_MAX_ACCOUNTS` / `MONITOR_LONGPOLL_TIMEOUT_MS` | 200 / 35000 | 入站监控 |
| `ADMIN_SESSION_TTL_MS` | 43200000 | 后台会话时长 |
| `ILINK_CDN_BASE_URL` | `https://novac2c.cdn.weixin.qq.com/c2c` | 微信媒体 CDN |
| `MEDIA_DIR` | `{DATA_DIR}/media` | 媒体文件目录 |
| `MEDIA_MAX_BYTES` / `INBOUND_MEDIA_MAX_BYTES` | 25MB / 100MB | 出站/入站单文件上限 |
| `MEDIA_DOWNLOAD_TIMEOUT_MS` / `MEDIA_UPLOAD_TIMEOUT_MS` | 60000 / 60000 | 媒体传输超时 |
| `INBOUND_MEDIA_MAX_CONCURRENT` / `INBOUND_MEDIA_MAX_QUEUE` / `INBOUND_MEDIA_QUEUE_TIMEOUT_MS` | 2 / 64 / 60000 | 入站下载有界并发与排队（防 OOM） |
| `MEDIA_ALLOWED_HOSTS` / `MEDIA_ALLOW_INSECURE_HTTP` | 空 / false | 入站媒体下载主机白名单与 http 放行（SSRF 纵深） |

## 8. 安全约定

- 管理后台：HttpOnly + SameSite=Lax Cookie；写接口要求 `X-Requested-With: ClawBridge-Admin`；
  登录失败按 IP 限流（如 10 次/15 分钟）。
- 推送 API：`Authorization: Bearer <API_TOKEN>` 或 `X-Api-Key`；按 token 限流 60 次/分钟。
  Webhook 兼容入口额外允许 `?token=`（便于不能自定义 Header 的服务；URL 可能进入代理日志，优先 Header）。
- 绑定页：公开；按 IP 限制创建会话频率；会话 secret 只返回一次，服务端只存哈希。
- 不返回任何 token 明文；日志经 `logger` 自动脱敏（键名脱敏 + URL query 中的 `token/api_key/authorization` 等
  值替换为 `[redacted]`，覆盖错误日志与接口应用运行日志预览）。
- **SSRF（2026-11 加固）**：
  - 外部 HTTP 调用（接口应用/定时通知）：先 DNS 解析并校验私网/环回/链路本地/保留段；随后**把校验通过的 IP
    固定到连接层**（`node:http/https.request` 的 `lookup` 选项；Node 不暴露 undici Agent），Host 头与 TLS
    `servername` 使用原域名；重定向 `manual`、最多 3 跳、跨源拒绝、每跳重新校验并重新钉 IP（BA-01）。
  - 入站媒体下载：仅 http/https、禁 userinfo、主机白名单（iLink/CDN + 配置），生产默认拒绝本机/私网；
    `redirect:'manual'` 每跳复验（BA-05）。
- 安全响应头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、
  `Referrer-Policy: no-referrer`、CSP：
  `default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`
  （前端不得使用内联 `<script>`/`onclick=`；样式可用 `<style>`/内联 style 属性）。
- 请求体上限 64KB；`MAX_TEXT_LENGTH` 校验中文字符数按 `String.length`。
- 404/错误响应不得泄漏内部路径或堆栈（生产）。

## 9. 前端约定（web/）

- 零构建、零外部 CDN：原生 ES Module + 手写 CSS；所有资源由本服务 `/assets/*` 提供。HTML 只引用
  `/assets/admin.js`、`/assets/bind.js`、`/assets/docs.js` 三个入口脚本与 `/assets/style.css`，
  其余模块通过相对 `import` 加载（新模块必须落在 `web/assets/**` 内，禁止裸包名/外部 URL）。
- **管理后台模块结构（2026-11 起）**：
  - `web/assets/admin.js`：entry（约 200 行）——事件绑定、视图加载器注册、末尾唯一 `init()`；
  - `web/assets/admin/`：`constants.js`（常量/元数据/`MENU_VIEWS`）、`state.js`（26 行组合入口）+ `state/**`
    （按域状态 core/users/messages/groups/rules/scheduled/settings + els）、`core.js`（登录/登出/401/hash 路由/
    自动刷新/注册表）、`ui.js`（switch/行按钮/表格/分页/formField 等公共构建器）、
    `templates.js`（模板语法帮助/Markdown 预览/请求响应区块）、`views/*.js`（概览/用户/分组/消息/广播/
    接口应用/定时通知/运行配置 + 发送消息弹窗）、`integrations/**`（规则/定时编辑器共享片段）；
  - `web/assets/lib/`：纯函数（parse/settings/summary/media），可直接被 `node:test` import 单测。
  - **依赖方向**：`admin.js → admin/views/** → {core, ui, state, templates, lib, common}`；`core` 不 import views
    （由 entry 注册）；禁止循环 import（由 `tests/unit/frontend-modules.test.js` 强制）。
  - **新增视图步骤**：① `admin.html` 增加 `<section class="view-section" data-view="x">`；② `constants.js` 的
    `MENU_VIEWS` 增加菜单项；③ 新增 `admin/views/x.js` 导出 `loadX()`；④ entry 中
    `registerViewLoaders('x', [...])` / `registerDataLoader('x', loadX)`；⑤ 视图私有 `state` 字段放 `state.js`。
- **全站响应式（单套 DOM/CSS）**：后台、文档页、首页使用同一套侧栏/顶栏壳与共享
  `initSidebarDrawer`；JS 不判断屏幕宽度。桌面端侧栏常驻、窄屏 off-canvas 完全由 CSS 媒体查询切换，
  不存在独立的 PC/移动端页面或两套导航 DOM。
- 三个页面：
  - `/`：首页（公开绑定页）。品牌介绍 + 昵称输入 + "生成绑定二维码" 按钮；`/bind` 302 跳转到 `/`，不再重复提供页面；
    弹层/卡片展示二维码 SVG、状态文案（等待扫码/已扫码/请输入配对数字/刷新中/绑定成功）、
    配对数字输入框、重新生成、成功后的用户信息；移动端优先。
  - `/admin`：管理后台。未登录显示登录表单；登录后：概览、用户管理、用户分组、消息记录、广播、
    接口应用（规则 + 定时通知）、运行配置（含安全卡片），hash 路由可直达。
  - `/docs`：API 文档页（推送 API 示例、curl、环境变量说明），内容与 `docs/API.md` 一致。
- 统一 `fetch` 封装：JSON、错误 toast、401 跳登录；管理写请求自动加 `X-Requested-With`。
- 中文界面，微信绿 `#07C160` 主色；无图片资源（用 CSS/emoji/SVG inline）。
- 轮询：绑定状态 1s；后台仅 4 个实时视图（概览/用户/分组/消息）5s 轮询，页面隐藏或弹窗打开时暂停。
- 动态内容只允许 `textContent`/DOM 属性写入；禁止 `innerHTML`/`outerHTML`/内联事件（由
  `tests/unit/frontend-modules.test.js` 全量扫描 `web/assets/**/*.js` 强制）。

## 10. 测试策略

- 单测（`tests/unit/`，`node --test`）：crypto 往返/篡改、rate-limiter 假时钟、
  ilink.parseILinkJson 无损 ID、ilink 请求头/URL 对 mock、store CRUD 与加密落库、HTTP 路由契约、
  调度/保活/规则引擎/设置校验等。
- **前端测试**（`tests/unit/`）：`frontend-pages.test.js`（页面结构、CSP、关键 id、契约 token；
  源码断言通过 `readAllAssets()` 聚合全部模块，不绑定单文件）；`frontend-modules.test.js`
  （import 路径存在、无环、入口可达、禁止 innerHTML/设备判断、entry 末尾唯一 init、entry ≤ 600 行）；
  `frontend-lib.test.js`（`web/assets/lib/**` 纯函数行为单测）。
- e2e（`tests/e2e/`）：启动 `mock/ilink-mock.mjs`（子进程，随机端口）+ 启动真实 app
  （子进程，随机端口、临时 DATA_DIR、显式 secret），通过 HTTP 全链路验证：
  绑定（wait→scaned→confirmed）、配对数字、二维码刷新、binded_redirect、发送（含 context_token
  回传断言、-2 重试、-14 处理）、入站消息落库与去重、解绑 notifyStop、鉴权失败、限流。
- 浏览器冒烟（可选，需本机 Edge/Chrome）：`npm run test:ui` 以 headless 浏览器 + CDP 启动临时 app，
  真实登录并遍历 7 个菜单视图、分组创建/删除、规则/定时编辑器、登出、绑定页/文档页，收集
  Console/未捕获异常；无浏览器环境自动跳过（exit 0）。
- 测试要求：确定性（禁用真实网络）；用 `waitFor(fn, timeout)` 轮询代替固定 sleep；
  每个测试独立临时目录；失败时打印服务端日志；全部测试在 90s 内跑完。
- 规模基线（2026-11）：`npm test` 464 项（unit 373 + e2e 91；462 通过 + 2 项 POSIX-only 在 Windows 跳过）约 35s；
  mock 自测 26 项；`npm run lint` 0 告警；`npm run doc:lint` 6/6；`npm run e2e:stability` 串行 3 次全绿；
  `npm run coverage` 输出 in-process 覆盖率（排除 `web/**` 与 `tests/**`，服务端源码 line 约 94.0%、
  branch 约 77.1%、funcs 约 93.8%；CI 强制阈值 line 90 / branch 70 / funcs 85）。
- `npm test` 必须同时跑 unit + e2e；`npm run test:unit` / `npm run test:e2e` 可单独跑。

## 11. Docker 约定（infra-dev）

- `Dockerfile`：`node:24-alpine`（Node 24 内置 `node:sqlite`，镜像更小；本机镜像加速对 slim 清单拉取不稳定）；
  `npm ci --omit=dev`；仅 `COPY server web`（文档页内嵌在 `web/docs.html`）；`USER node`；`DATA_DIR=/app/data`；
  `HEALTHCHECK` 用 `node -e fetch(...)`；`EXPOSE 10380`。
- `docker-compose.yml`：`clawbridge` 服务，`env_file: .env`，命名卷 `clawbridge-data:/app/data`，
  `restart: unless-stopped`，`init: true`，`security_opt: no-new-privileges:true`，healthcheck，
  容器内/宿主机均监听 10380（内外一致）。
- `.github/workflows/docker-publish.yml`：push main 时构建 `linux/amd64 + linux/arm64` 镜像并推送
  `ghcr.io/shihao618/clawbridge:latest`（另带 `sha-*` / tag 标签）。
- fnOS：`docker-compose.fnos.yml` **免构建**，直接拉取上述 GHCR 镜像；数据挂载项目 `./data`
  （可用 `PUID/PGID/DATA_PATH` 覆盖），容器以 NAS 用户运行。
- 演示模式：`docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile demo up -d --build`
  启动 `mock-ilink` 服务（复用 `node:24-alpine` + 挂载 `./mock`，`MOCK_AUTO_CONFIRM_MS=3000`），
  app 通过环境变量把 `ILINK_LOGIN_BASE_URL` / `ILINK_BASE_URL` 指向 `http://mock-ilink:3100`，
  无需真实微信即可完整走通绑定→推送→入站。
- `.env.example`：包含变量表与注释；`.dockerignore`：排除 `node_modules`、`data`、`.git`、`tests`、
  `mock`、`docs`，`web` 需要打进镜像。
- `scripts/demo.ps1` / `scripts/demo.sh`：一键演示（起服务、等待健康、打印访问地址与
  管理员密码提示、提示如何用 mock 完成绑定）。

## 12. 多媒体扩展（图片 / 视频 / 文件）

> ⚠️ **历史设计记录**：§12–§16 中的「DB vX（additive migration）/ ALTER TABLE / 逐级迁移」描述的是
> 当时的增量设计过程。**现行实现（schema v10 起）不再提供旧版本迁移**：启动时检测到非当前
> schema 版本会直接失败（`db.js`），升级只能备份后使用空库重建。阅读升级/排障步骤时以
> `README.md`「升级」章节与 `db.js` 实际行为为准。

完整协议与 API 契约见 [`docs/MEDIA.md`](MEDIA.md)。架构增量：

- **新模块 `server/src/media.js`**：AES-128-ECB 加解密、aes_key 两种编码解析、MIME/文件名、
  CDN 上传（getuploadurl + 加密 + 重试）/下载（full_url 优先 + 解密 + 大小/超时保护）、
  安全存储（`DATA_DIR/media/{inbound,outbound}/att_*`，0700/0600，防目录穿越）。
- **ilink.js**：新增 `getUploadUrl`、`sendMediaMessage`、`UploadMediaType`。
- **DB v2（additive migration，保留既有数据）**：
  - 新表 `attachments(id, direction, kind, mime, file_name, size, path, sha256, user_id,
    outbox_id, inbound_message_id, wechat_message_id, error, status, created_at)` + 索引；
  - `outbox` 新增 `media_id TEXT`、`caption_sent_at INTEGER NOT NULL DEFAULT 0`。
- **出站**：outbox 一行可含 text(caption)+media；dispatcher 先发 caption（若未发过，`caption_sent_at`
  记录防重），再 `uploadMediaToCdn` → `sendMediaMessage`；每次 sendmessage 消耗一个限流令牌；
  -2 退避后只重试媒体；附件缺失直接 failed。
- **入站**：monitor 对 `item_list` 中的图片/文件/视频/语音（最多 5 个）下载解密 → 落盘 →
  `attachments` 行；失败记录 `status=failed` 不影响消息入库；`raw_json` 同时脱敏
  `context_token`、`media.aes_key`、`image_item.aeskey`。
- **API**：`POST /api/admin/media`、`POST /api/v1/media`（原始二进制上传）、
  发送接口支持 `mediaId`、`GET /api/admin/media/{id}`、`GET /api/v1/media/{id}`
  （鉴权 + Range + `?download=1`）；消息/outbox 视图带 `attachments`。
- **前端**：发送弹窗支持选文件/预览/上传；消息记录渲染图片缩略图、视频播放器、文件下载。
- **mock**：新增 `/ilink/bot/getuploadurl`、`/cdn/upload`、`/cdn/download` 与控制面
  `POST /__mock/accounts/{botId}/inbound-media`，e2e 覆盖出站加密上传与入站解密下载。

## 13. 用户分组 + 入站消息 API

完整契约见 [`docs/GROUPS_AND_INBOUND.md`](GROUPS_AND_INBOUND.md)。架构增量：

- **DB v3（additive migration）**：
  - 新表 `groups(id, name UNIQUE, description, color, created_at, updated_at)`；
  - 新表 `user_groups(user_id, group_id, created_at, PRIMARY KEY(user_id, group_id))` + 两个索引；
  - 现有 users/outbox/inbound_messages/attachments/events 数据零改动。
- **分组模型**：多对多标签；删除分组仅清归属，不动用户。
- **store.js**：分组 CRUD/归属/计数；`listUsers({groupId})`、`listMessages({groupId})`；
  `listInboundForApi({limit,since,cursor,userId,groupId})` 按 `(received_at,id)` 升序 + cursor 分页，
  批量关联 attachments 与用户 displayName/groups；cursor = `base64url({t,id})`。
- **api.js**：
  - 管理端：分组 CRUD、`PUT /api/admin/users/{id}/groups`、用户/消息 groupId 过滤、
    `POST /api/admin/groups/{id}/messages`（目标 = 分组内 active 且未冷却用户，逐人入 outbox）；
  - 对外：`GET /api/v1/groups`、`POST /api/v1/groups/{id}/messages`、
    `GET /api/v1/inbound/messages`（limit/since/cursor/userId/groupId/wait 长轮询，500ms 间隔，
    最长 30s；响应 items/nextCursor/hasMore/serverTime；附件 URL 指向 `/api/v1/media/{id}`）。
- **前端**：用户管理新增分组区块（CRUD/颜色/计数/群发）、用户分组多选与筛选、分组徽章；
  文档页新增分组与入站消息 API 章节。
- **测试**：v2→v3 迁移（真实数据零丢失、幂等）、分组 CRUD/归属/过滤/群发、入站 API
  cursor/since/过滤/wait/附件/鉴权；e2e 覆盖分组群发（文本+媒体）与入站增量拉取。

## 14. 24h 会话保活（Keep-Alive）

完整契约见 [`docs/KEEPALIVE.md`](KEEPALIVE.md)。架构增量：

- **背景**：微信 ClawBot 主动下发依赖"用户最近一次主动消息"的约 24h 会话窗口；窗口过期后
  主动消息不可达。保活机制在窗口即将过期前自动发送一条提醒，促使用户回复以刷新窗口。
- **DB v4（additive）**：`users` 新增 `keepalive_enabled INTEGER NOT NULL DEFAULT 0`、
  `keepalive_last_sent_at INTEGER NOT NULL DEFAULT 0`（v3→v4 逐级迁移，保留既有数据）。
- **DB v6（additive，分组级保活）**：`groups` 新增 `keepalive_enabled INTEGER NOT NULL DEFAULT 0`：
  分组开启后当前成员批量开启，**之后加入该分组的成员在 `replaceUserGroups` 事务内自动继承开启**；
  移出分组不关闭；分组关闭时当前成员关闭、之后加入保持关闭。分组创建/编辑接口支持可选
  `keepaliveEnabled` 字段。
- **新模块 `server/src/keepalive.js`**：单循环定时调度（`config.keepalive.tickMs`，默认 5min）：
  - 候选条件：active + enabled + `last_inbound_at>0` + 未冷却 + `keepalive_last_sent_at<last_inbound_at`
    + `now-last_inbound_at ∈ [window-lead, window)`；按 `last_inbound_at` 升序、单次 ≤ maxPerTick；
  - 事务内入队 outbox（`source='keepalive'`，模板支持 `{name}`）+ 更新 `keepalive_last_sent_at`
    + 写 `events(type='keepalive')`；入队失败只记录日志；
  - `start()/stop()` 幂等；`config.keepalive.enabled=false` 时不启动扫描；进程优雅退出前停止。
- **index.js**：dispatcher 启动后 `keepalive.start()`；SIGTERM/SIGINT 优雅退出时 `keepalive.stop()`。
- **api.js**：`PATCH /api/admin/users/{id}/keepalive`、`POST /api/admin/groups/{id}/keepalive`
  （单用户 / 分组批量 opt-in），UserView/config/overview 增加保活字段，消息视图增加 `source`。
- **前端**：用户行保活开关、分组行内保活开关（同步当前成员+持久化分组默认）、运行配置保活参数、
  消息来源「保活」标签、文档页保活章节。
- **测试**：v3→v4 迁移、候选条件边界、调度假时钟（首次提醒/未回复重复/回复后新窗口/disabled/失败不崩）、
  API 校验；e2e 用压缩时间参数（window=8s、lead=3s、tick=300ms）验证真实触发与不重复。

## 15. 接口应用（关键词触发 → 外部 HTTP 接口 → 解析回复）

完整契约见 [`docs/API_RULES.md`](API_RULES.md)。架构增量：

- **背景**：让微信成为外部系统的入口/出口：用户发含关键词的消息 → 调外部接口 → 结果回微信。
- **DB v5（additive）**：新表 `app_rules`（规则配置，Header 值加密存 `request_headers_enc`）与
  `app_rule_logs`（运行日志，含 `(rule_id, inbound_message_id)` 去重唯一索引）；v4→v5 保留既有数据。
- **新模块 `server/src/app-rules.js`**：
  - 纯函数：范围/关键词/正则匹配、4 种参数提取（trailing/regex/json/fulltext）、请求模板渲染、
    SSRF 校验、HTTP 调用（超时/大小限制/重定向复验）、响应解析、回复模板渲染；
  - `RuleEngine`：内存队列 + 并发（`APP_RULES_WORKER_CONCURRENCY`）、`start/stop` 幂等、
    `handleInboundMessage()` 从 monitor 异步触发（仅文本）；一消息按 priority 只执行首条规则；
    同消息+规则去重；成功或失败（兜底文案）回复均入 outbox（`source='rule'`）并写日志；调用频率统一由微信默认发送限流控制；
  - `testRule()` dry-run：管理端"测试运行"使用，不发送、不写运行日志。
- **monitor.js**：入站消息保存后 fire-and-forget 调用规则引擎（不阻塞 getupdates）。
- **index.js**：`appRules.start()` / 优雅退出 `stop()`；`APP_RULES_ENABLED=false` 时不启动。
- **api.js**：规则 CRUD、测试运行、运行日志查询；创建/更新时 Header 值加密，读取仅返回键名；
  完整校验（URL/正则/scope/limits 等）与统一错误格式。
- **前端**：管理后台「接口应用」规则列表/表单/测试运行/运行日志；文档页接口应用章节。
- **安全**：默认拒绝内网/环本 SSRF，`APP_RULES_ALLOWED_HOSTS` 白名单放行；日志/接口脱敏；
  管理员鉴权 + CSRF；请求/响应/日志大小与长度限制。
- **测试**：v4→v5 迁移、匹配/提取/模板/响应解析/SSRF/限流去重/引擎成功失败/API 校验单测；
  e2e 用本地 mock 外部 API 覆盖成功、失败兜底、分组范围、优先级、冷却、SSRF、dry-run 全链路。

## 16. 定时通知（Scheduled Notifications）

完整契约见 [`docs/SCHEDULED_TASKS.md`](SCHEDULED_TASKS.md)。架构增量：

- **背景**：无需用户发消息，按计划主动调用外部接口 → 解析 → 通过微信通知指定用户/分组
  （如每天 8:00 天气、每 30 分钟订单状态）。
- **当前 schema v10**：表 `scheduled_tasks`（任务配置，Header 加密存 `request_headers_enc`）与
  `scheduled_task_logs`（执行日志）；interval 支持 `window_start/window_end`（每日生效时间段）；
  不再提供旧版本迁移。
- **新模块 `server/src/scheduler.js`**：
  - 计划计算：`interval`（每 N 分钟，60s–30d；执行后 next=执行开始+interval；可选每日生效时间段 windowStart/windowEnd，
    窗口外 next 自动推进到窗口内）与 `daily`
    （每天 HH:mm，时区 `SCHEDULER_TIMEZONE`，用 Intl 计算下一次；服务启动时过期任务补跑一次）；
  - tick 扫描（`SCHEDULER_TICK_MS`）：取 `enabled=1 AND next_run_at<=now` 任务顺序执行，单任务异常不影响其他；
  - 执行：复用 `shared/**` 的模板渲染/HTTP 调用（SSRF/超时/大小/重定向）与响应解析（`scheduler.maxResponseBytes`/
    `scheduler.allowedHosts` 缺省继承接口应用配置）；成功按回复模板渲染，
    失败时用兜底文案（为空则不发送）；目标用户（users/groups，active 去重、上限）逐个入队 outbox
    （`source='schedule'`），复用微信限流；写 `scheduled_task_logs`；
  - `runScheduledTaskNow(taskId,{dryRun})` 供管理端"测试运行/立即执行"复用；`start/stop` 幂等。
- **index.js**：dispatcher/keepalive/appRules 之后 `scheduler.start()`；优雅退出 `stop()`；
  `SCHEDULER_ENABLED=false` 时不启动。
- **api.js**：任务 CRUD、`/:id/test`（dry-run）、`/:id/run`（立即执行）、日志查询；Header 值加密、
  读取仅返回名称；完整校验。
- **前端**：接口应用页新增「定时通知」Tab（任务列表/表单/测试运行/立即执行/运行日志）；文档页定时通知章节；
  接口应用的规则日志改为每行「日志」弹窗（不再单独占一个 Tab）。
- **测试**：计划计算（interval/daily/时区/过期补跑）、tick 执行、目标去重上限、
  fallback、dry-run 不发送、run 写日志/更新 next、API 校验；e2e 用本地 mock 外部 API 覆盖执行链路与投递。

## 17. 运行配置后台可改（Runtime Settings）

完整契约见 [`docs/SETTINGS.md`](SETTINGS.md)。架构增量：

- **背景**：原 `.env` 中的运行参数改为数据库持久化、后台「运行配置」可编辑，`.env` 仅作首次默认值；
  第二批迁移后 `.env` 只保留启动前必须确定/不能入 DB 的项（`APP_SECRET`/`DATA_DIR`/`MEDIA_DIR`/`PORT`/`HOST`/`NODE_ENV`），
  管理密码与 API Token **只由 DB 管理**：首次启动自动生成随机值并写入 `data/` 文件，不再读取 `.env`（不兼容旧版 env 机密）。
- **`app_settings` 表**：新表 `app_settings(key, value, updated_at)`，只存被覆盖的字段；
  当前 `SCHEMA_VERSION=10`。
- **新模块 `settings.js`**：`SETTINGS_SCHEMA`（push/keepalive/appRules/scheduler/media/binding/server/security/ilink/monitor
  字段元数据，含类型/范围/default/restartRequired）、`loadOverrides()`、`getSettings()`、`updateSettings()`、
  `resetGroup()`、机密管理（scrypt 密码哈希 / AES Token 加密 / rotate/reset / 首启 bootstrap）；
  更新时校验→UPSERT→覆盖 `config`→调用运行时 hooks；事件只记录字段名/动作。
- **运行时 hooks**：`keepalive.restart()`、`scheduler.restart()`、`app-rules` 引擎重启/启停、`logger.setLogLevel()`；
  大多数字段在请求/每轮时实时读取即**即时生效**；确实在启动时创建/无法热更的字段（push.rateLimit*、
  media.maxBytes/inboundMaxConcurrent/inboundMaxQueue、server.trustProxy、monitor 两项）才标记 `restartRequired`
  （2026-11 已逐字段校正，详见 `docs/SETTINGS.md` §7.2）。
- **index.js**：db 初始化后、各引擎启动前 `settings.loadOverrides()`；启动后注册 hooks。
- **api.js**：`GET/PATCH /api/admin/settings`、`POST /api/admin/settings/reset`（Cookie+CSRF+校验）；
  机密管理 `POST /api/admin/security/{password,password/reset,api-token/rotate,api-token/reset}`，
  GET settings 附带 `security` 摘要（来源/preview，永不回哈希/明文）。
- **前端**：运行配置页改为可编辑分组表单（保存/恢复默认/已修改/需重启标记），保留 env-only 脱敏只读区。
- **测试**：校验边界、覆盖/恢复默认、hooks 调用、API 鉴权与事件脱敏；e2e 覆盖修改生效与 reset。

## 18. 模块化重构记录（2026-11）

### 18.1 重构前后度量

| 模块 | 重构前 | 重构后 | 说明 |
| --- | --- | --- | --- |
| `server/src/api.js` | 1895 行（69 个路由 + 校验 + 媒体 IO + 错误处理） | **87 行**（仅 `createApp()` 组合根） | 拆出 `http/**` 8 文件 + `routes/**` 11 文件，共 2097 行，最大单文件 203 行 |
| `server/src/store.js` | 2126 行 / 107 个导出（9 个领域 + 映射 + 统计混在一起） | **23 行 façade** + `data/**` 13 文件 | 按域拆分（users/groups/keepalive/rules/scheduled/attachments/outbox/inbound/messages/events/stats + mappers/helpers）；`export *` 保持导出名零改动 |
| `server/src/app-rules.js` | ~1744 行（模板引擎 + SSRF HTTP + 匹配 + 引擎） | **656 行** + `shared/**` 4 文件 | `shared/{http-client,template,response,http-execute}.js`；scheduler 不再依赖 app-rules 内部实现（BA-09） |
| `web/assets/admin.js` | 5895 行 / 171 个顶层函数 | **198 行**（entry） | 拆出 `admin/**` 14 文件 + `lib/**` 4 文件，共约 6064 行 |
| 前端编辑器 | 规则/定时编辑器各 ~768/567 行、重复 ~1335 行 | `views/app-rules.js` 927 行、`views/schedules.js` 657 行 + `admin/integrations/**` 6 文件 | F-04：公共块 0 重复 |
| 前端测试 | `frontend-pages.test.js` 51 项（源码文本 grep，绑定单文件） | 57 项（`readAllAssets()` 聚合）+ modules 10 + lib 18 + 弹窗/焦点行为 4 | 测试总量 362 → 464 |

**等价性**：纯搬迁/等价重构，对外契约/路由/中间件顺序/响应字段/文案不变；各轮后 `npm test` 全绿、
`npm run test:ui` 真实浏览器冒烟全通过。重构实施前的完整审查报告见 `docs/CODE_REVIEW.md`（明细归档 `docs/review/`）。

### 18.2 后端分层（依赖方向自上而下）

```
index.js（进程入口/生命周期）
  └─ api.js（组合根：中间件顺序 + 挂载路由）
       ├─ routes/*.js（按领域注册路由，使用 http/** 与领域模块）
       ├─ http/middleware.js（安全头/no-store/body 解析/404/统一错误处理）
       ├─ http/{helpers,views,validators,app-rule-validators,scheduled-validators}.js
       ├─ http/{media-handlers,queue-service}.js
       ├─ 领域模块：binding / monitor / dispatcher / keepalive / app-rules / scheduler / settings / auth / maintenance
       │    └─ app-rules / scheduler → shared/**（http-client / template / response / http-execute）
       └─ store.js（façade）→ data/** → db.js / crypto.js
            基础层：config/logger/errors/rate-limiter；协议层：ilink.js / media.js
```

约定：新增 HTTP 接口放 `server/src/routes/<领域>.js` 并在 `api.js` 按既有顺序挂载；新增校验放
`http/validators.js`（或对应领域校验文件）；错误统一抛 `AppError`/`badRequest` 等，由
`http/middleware.js` 的 `errorHandler` 输出 `{ error: { code, message } }`。

### 18.3 前端分层

```
admin.js（entry：事件绑定 + 视图/数据加载器注册 + init()）
  └─ admin/views/*.js（视图逻辑 + 编辑器 + 列表渲染）
       └─ { admin/core.js（认证/路由/刷新/注册表）, admin/ui.js（公共构建器）,
            admin/state.js（全局 state/els）, admin/templates.js,
            admin/constants.js, lib/**（纯函数）, common.js（fetch/modal/toast/poller） }
```

约定：新增视图按 §9「新增视图步骤」；公共构建器优先抽到 `ui.js`；可单测的纯逻辑放 `lib/**`；
动态内容只用 `textContent`/DOM 属性，禁止 `innerHTML`（静态测试强制）。

### 18.4 后续优化建议（尚未实施，收益递减项）

- `scheduler.js`：计划计算（calc）与执行（tick）可再拆分；`app-rules.js` 引擎可再拆 match/extract。
- 前端：`views/app-rules` / `views/schedules` 的 editor/test/logs 子模块化；可选动态 `import()` 懒加载非默认视图。
- `tests/helpers/e2e-env.mjs` 拆分（进程管理 / HTTP 客户端 / 外部 mock / 媒体工具）。
- 详见 `docs/CODE_REVIEW.md` 第 6 节路线图。

## 19. 数据生命周期维护（maintenance.js，BA-18）

进程内定时维护（默认启动 1 分钟后首跑、之后每天一次；`MAINTENANCE_*` 环境变量控制，见
[`docs/UPGRADE.md`](UPGRADE.md) §8 与 `.env.example` 第十二节）：

- **附件 GC**：删除 DB 中 `status='ready'` 但磁盘文件缺失的附件行（仍被 queued/sending outbox 引用的保留，
  交由 dispatcher 失败处理）；删除 `media/inbound|outbound` 下无 DB 引用的孤儿文件（有最小文件年龄防误删）；
  删除超过保留期且从未被任何 outbox 引用的管理端上传附件（行 + 文件）。
- **日志保留**：`events` / `app_rule_logs` / `scheduled_task_logs` 按保留天数分批删除；`outbox` /
  `inbound_messages` 属业务数据不自动删除。
- 每批 `MAINTENANCE_BATCH_SIZE` 条 + 单事务；每轮输出清理计数日志；可选 `PRAGMA optimize` 与
  `wal_checkpoint(TRUNCATE)`；`start()/stop()` 幂等，`index.js` 在 `closeDb()` 前停止。
- 维护参数当前仅由 env 管理（后台运行配置暂未暴露，后续可并入 `SETTINGS_SCHEMA`）。






