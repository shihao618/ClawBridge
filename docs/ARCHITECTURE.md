# ClawBridge 架构与实现约定

ClawBridge = 多用户微信 ClawBot 扫码绑定 + 消息推送平台（Docker 自托管）。

- **技术栈**：Node.js ≥ 22.13（镜像使用 Node 24）+ Express 5 + 内置 `node:sqlite`；前端为**零构建**
  原生 HTML/CSS/ES Module；测试使用内置 `node --test`。
- **生产依赖**：仅 `express`、`qrcode`（二维码 SVG 在服务端渲染，前端零依赖）。
- **单容器单进程**：一个 Node 进程同时提供 Web 页面 + 绑定服务 + 管理 API + 推送 API + 入站长轮询 +
  出站队列 + 规则/定时/维护调度；SQLite 落盘到 `DATA_DIR`（Docker 命名卷）。
- **版本基线**：应用 1.0.0 / 数据库 schema v1（全新基线，无历史版本兼容与迁移）。
- 协议依据：`docs/PROTOCOL.md`；HTTP API 契约：`docs/API.md`。

## 1. 目录结构与职责

| 路径 | 内容 |
| --- | --- |
| `server/src/config.js` / `logger.js` / `errors.js` / `crypto.js` / `db.js` / `rate-limiter.js` / `metrics.js` / `index.js` | 基础层：环境变量与默认值、结构化日志与脱敏、错误类型与错误码、AES-256-GCM/scrypt/会话签名、SQLite 初始化与 schema 校验、限流器、进程内指标、进程入口与生命周期（优雅退出/维护任务接线） |
| `server/src/ilink.js` / `media.js` | 协议层：微信 ClawBot 协议客户端；媒体加解密、MIME、CDN 上下行（出站上传 / 入站有界并发 + 流式下载解密） |
| `server/src/store.js` | 数据层 façade：`export *` 重导出 `data/**`，调用方零改动 |
| `server/src/data/` | 数据层按域实现：`users.js`、`groups.js`、`keepalive.js`、`rules.js`、`scheduled.js`、`attachments.js`、`outbox.js`、`inbound.js`、`messages.js`、`events.js`、`stats.js`、`user-secrets.js`（用户级凭据）+ `mappers.js`/`helpers.js` |
| `server/src/shared/` | 领域共享层：`http-client.js`（SSRF/传输/钉 IP/响应读取）、`template.js`（模板引擎）、`response.js`（响应解析）、`http-execute.js`（渲染→HTTP→解析→渲染回复管线）、`credentials.js`（凭据引用收集/解析/渲染/脱敏）、`wechat-markdown.js`（微信 Markdown 兼容过滤，出站前使用） |
| `server/src/inbound-quote.js` | 入站引用消息（quote / partial quote）最小解析：`ref_msg` 的 `title`/`message_item`/`partial_text` → 引用正文与媒体元数据（并入 `raw_json._quote`）；注入正文顺序 `extractBodyFromItemList`、`message_id` 回退等纯函数 |
| `server/src/typing.js` | 「正在输入」状态（规则命中处理期间显示，含不请求模式直接回复）：`typing_ticket` 获取/缓存、刷新定时器、按用户引用计数、best-effort 失败忽略 |
| `server/src/binding.js` / `monitor.js` / `dispatcher.js` / `keepalive.js` / `app-rules.js` / `scheduler.js` / `settings.js` / `auth.js` / `maintenance.js` | 领域层：扫码绑定状态机、入站长轮询、出站队列、会话保活、接口应用规则引擎、定时通知、运行配置与机密管理（`settings.js` façade + `settings/{schema,validate,apply,secrets,persistence}.js`）、认证与限流、数据生命周期维护 |
| `server/src/app-rules/` / `scheduler/` | 领域模块拆分实现：`app-rules/{match,engine,index}.js`、`scheduler/{calc,index}.js`；根文件保留 façade |
| `server/src/http/` | HTTP 支撑层：`middleware.js`（安全头/body 解析/404/统一错误处理）、`helpers.js`、`views.js`、`validators.js`、`app-rule-validators.js`、`scheduled-validators.js`、`media-handlers.js`、`queue-service.js` |
| `server/src/routes/` | 路由层：`public.js`（健康检查/扫码绑定）、`admin-auth.js`、`admin-users.js`、`admin-user-secrets.js`（用户级凭据）、`admin-groups.js`、`admin-rules.js`、`admin-scheduled.js`、`admin-settings.js`、`admin-messages.js`、`admin-metrics.js`、`v1.js`、`webhook.js`、`pages.js` |
| `server/src/api.js` | Express 组合根：仅装配中间件顺序与挂载路由（`createApp()`） |
| `web/*.html` + `web/assets/style.css` | 零构建前端页面（绑定页 / 管理后台 / API 文档页）与全站样式（WCAG AA 对比度 token、统一断点） |
| `web/assets/common.js` / `bind.js` / `docs.js` | 公共能力（fetch/上传/DOM/格式化/toast/modal 焦点陷阱/轮询/抽屉）与页面入口 |
| `web/assets/admin.js` + `web/assets/admin/` | 管理后台入口与模块：`constants.js`、`state.js` + `state/**`、`core.js`（认证/hash 路由/刷新/注册表）、`ui.js`、`templates.js`、`markdown-preview.js`、`views/*.js`（8 个菜单视图 + 消息弹窗 + 用户凭据对话框）、`integrations/**`（规则/定时编辑器共享片段） |
| `web/assets/lib/` | 前端纯函数模块（parse/settings/summary/media/wechat-markdown），可被 `node:test` 直接单测 |
| `mock/**` | 零依赖微信 iLink 模拟器 + 控制面 + 自测（含 `/mock-bind` 占位页） |
| `tests/unit/**`、`tests/e2e/**`、`tests/helpers/**` | 单元测试、真实双进程 e2e、测试环境辅助（进程/客户端/mock/媒体/单测初始化） |
| `scripts/**` | demo 脚本、浏览器冒烟、截图、e2e 稳定性、doc-lint、APP_SECRET 轮换 |
| `docs/**` | 协议与设计契约（PROTOCOL / API / ARCHITECTURE / MEDIA / GROUPS_AND_INBOUND / KEEPALIVE / API_RULES / SCHEDULED_TASKS / SETTINGS / UPGRADE / RELEASE / PRIVACY / ROTATE_APP_SECRET / MARKDOWN_WECHAT） |
| `Dockerfile` / `docker-compose*.yml` / `.github/workflows/**` | 构建、部署与 CI（PR：lint + coverage + mock + e2e 稳定性；发布：多架构镜像 + provenance/SBOM） |

**依赖方向（后端）**：基础层 → 协议层 → 数据层 → 领域层 → 组合根（`api.js`）→ 进程入口（`index.js`）；
`http/**` 与 `routes/**` 只依赖上游，不反向依赖 `api.js`。

**依赖方向（前端）**：`admin.js`（entry）→ `admin/views/**` → `{core, ui, state, templates, lib, common}`；
`core.js` 不 import views（由 entry 注册），`lib/**` 为零依赖纯函数。

## 2. 运行时数据流与生命周期

```
浏览器（公开绑定页/管理后台）
   │  HTTP（同源）
   ▼
Express（api.js 组合根：http/middleware → routes/*）── 静态页面(web/) + /health + /api/...
   │
   ├─ binding.js ── iLink.getBotQrcode()/getQrcodeStatus() ──► 微信 ClawBot（ilinkai.weixin.qq.com）
   │      └─ confirmed → users upsert（按 wechat_user_id）+ monitor.start(user)
   ├─ monitor.js ── notifyStart() + getUpdates() 长轮询（每账号一个循环；-14 暂停 1h 后自动继续）
   │      └─ 入站消息（含 quote 最小解析、/echo）→ 落库（context_token 加密保存、游标每次落库）+ 媒体下载 → 触发规则/通知
   ├─ dispatcher.js（单循环 worker）── outbox queued → 每账号限流 → iLink.sendMessage
   │      └─ 成功 sent / -2 退避重试 / -14 暂停 1h（到期自动恢复轮询）/ 永久失败按开关提示用户
   ├─ app-rules 引擎 ── 命中规则 → 显示「正在输入」→ （可选）按触发用户解析凭据 → 外部 HTTP → 渲染回复入 outbox → 取消 typing
   ├─ scheduler ── 到期任务 → （汇总模式 / 按用户模式）外部 HTTP → 通知入 outbox
   └─ auth.js ── 管理 Cookie 会话；v1 API Key；绑定页 IP 限流
```

进程生命周期（`index.js`）：

1. 加载 config/logger → 初始化 DB（建表并校验 schema：只接受空库 0 或当前 1）；
2. 启动 HTTP server（`HOST:PORT`）；
3. 启动 dispatcher worker、keepalive/scheduler/app-rules 调度器、`maintenance.start()`；
4. 为所有可推送用户启动入站监控（受 `MONITOR_MAX_ACCOUNTS` 限并发，启动间隔防尖峰）；
5. 收到 `SIGTERM`/`SIGINT`：停止接受新请求 → dispatcher 等在途发送 → 各调度器 `stop()` 并等待在途任务 →
   停止入站监控（best-effort `notifyStop()`）→ `maintenance.stop()` → 最后关闭 DB → 退出；
   外层强制退出兜底，保证不重复投递/不丢运行日志。

## 3. 数据库 Schema v1（`node:sqlite`，SQLite 3）

**设计原则**：全新数据基线（schema v1），无迁移；建表 + 外键 + CHECK + 索引一次完成；
单进程单连接，所有写操作经 `data/**` 模块并用事务（`BEGIN IMMEDIATE` + 嵌套 SAVEPOINT）。

```sql
-- 连接级 PRAGMA（db.js 打开时设置）
PRAGMA journal_mode = WAL;          -- 读写并发
PRAGMA foreign_keys = ON;           -- 外键约束生效
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;        -- 可用 DB_SYNCHRONOUS=FULL 收紧
PRAGMA journal_size_limit = 67108864;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -16000;         -- 约 16MB
PRAGMA auto_vacuum = INCREMENTAL;   -- 仅全新库设置
```

| 表 | 关键列 | 约束/关系 |
| --- | --- | --- |
| `meta` | `key`, `value` | 记录 `schema_version`（当前 `1`） |
| `users` | `wechat_user_id`(唯一)、`display_name`、`ilink_bot_id`、`token_enc`、`context_token_enc`、`status`、`pause_until`、`keepalive_enabled` | `wechat_user_id` UNIQUE；`status IN ('active','unbound')`；加密凭证列 |
| `groups` | `name`(唯一)、`description`、`color`、`keepalive_enabled` | 分组名 UNIQUE |
| `user_groups` | `user_id`, `group_id` | 复合主键；两列 FK **ON DELETE CASCADE** |
| `app_rules` | `scope_type`、`match_mode`、`extraction_mode`、`request_method`、`request_url`、`request_headers_enc`、`reply_template`、`timeout_ms` | CHECK 校验枚举（scope/match/extraction/method/response_type） |
| `scheduled_tasks` | `schedule_type`、`interval_ms`/`daily_time`、`window_start/end`、`target_type`/`target_ids`、`per_user_mode`、`request_headers_enc`、`last_status`、`next_run_at` | `per_user_mode IN (0,1)`；`last_status IN ('','success','failed','skipped','partial')` |
| `outbox` | `user_id` FK、`text`、`source`、`status`、`attempts`、`media_id`、`caption_sent_at` | `user_id` FK **ON DELETE CASCADE**；`status IN ('queued','sending','sent','failed')` |
| `inbound_messages` | `user_id`（可空 FK）、`wechat_message_id`、`raw_json`（已脱敏）、`received_at` | `wechat_message_id` 唯一（WHERE 非空）；`user_id` FK **ON DELETE SET NULL** |
| `attachments` | `direction`、`kind`、`path`、`user_id`/`outbox_id`/`inbound_message_id`、`status` | 三个 FK **ON DELETE SET NULL**；`direction IN ('inbound','outbound')` |
| `app_rule_logs` | `rule_id` FK、`user_id`、`inbound_message_id`、`status`、`http_status`、预览字段（已脱敏） | `rule_id` FK **CASCADE**；`inbound_message_id` 去重唯一索引；`status IN ('matched','success','failed','skipped')` |
| `scheduled_task_logs` | `task_id` FK、`status`、`http_status`、`recipients_count`、预览字段 | `task_id` FK **CASCADE**；`status IN ('success','failed','skipped','partial')` |
| `events` | `type`、`user_id`、`detail` | 运行事件/审计（detail 不含机密） |
| `app_settings` | `key`, `value`, `updated_at` | 运行配置覆盖值（只存被修改字段） |
| `user_secrets` | `user_id` FK、`name`、`fields_enc`、`field_names`、`hints`、`label`、`last_used_at` | UNIQUE(user_id,name)；`user_id` FK **CASCADE**；值整体 AES-GCM 加密，`hints` 仅掩码 |

索引（节选）：`users(wechat_user_id)`/`users(status,bound_at)`、`groups(name)`、`user_groups(group_id)`/`(user_id)`、
`app_rules(enabled,priority,created_at)`、`scheduled_tasks(enabled,next_run_at)`/`(created_at DESC)`、
`outbox(status,next_attempt_at,created_at)`/`(user_id,created_at DESC)`/`(created_at DESC)`、
`inbound_messages(received_at,id)`/`(user_id,created_at DESC)`/`(created_at DESC)`、
`attachments(outbox_id)`/`(inbound_message_id)`/`(user_id,created_at DESC)`、
`app_rule_logs(rule_id,created_at DESC)`/`(created_at DESC)`/去重唯一索引、
`scheduled_task_logs(task_id,created_at DESC)`/`(created_at DESC)`、
`events(type,created_at DESC)`、`user_secrets(user_id,name)`。

## 4. 绑定会话（`binding.js`，内存态）

- 会话状态机：`waiting → scanned → (need_verifycode) → confirmed`；异常路径 `expired`、`refresh`、
  `verify_blocked`、`scaned_but_redirect`、`binded_redirect`、`error`、`cancelled`。
- 每个会话后台一个短轮询 worker（`get_qrcode_status`），二维码过期自动刷新（≤ `BINDING_MAX_REFRESHES`）；
  `scaned_but_redirect` 切换 IDC；`binded_redirect` 复用已有用户（不发放新凭证）。
- 会话 secret 只返回一次（服务端只存哈希）；会话 TTL `BINDING_TTL_MS`，过期清理；
  创建按 IP 限流（`BINDING_IP_LIMIT_PER_HOUR`）、并发上限 `BINDING_MAX_ACTIVE`。
- `confirmed`：按 `wechat_user_id` upsert 用户、清理旧凭证、加密保存 token/base_url/context_token，
  启动该用户入站监控；扫描状态表见 `docs/API.md` §1.2。
- **网络容错（对齐官方）**：轮询中的网络/网关错误（长轮询超时、5xx/524、fetch 失败、ECONN* 等）不终止会话，
  继续轮询到会话总 TTL；`BINDING_NETWORK_ERROR_LIMIT` 仅作为连续网络错误的告警阈值。

## 5. 出站队列与限流（`dispatcher.js` + `rate-limiter.js`）

- outbox 队列模型：`queued → sending → sent | failed`；`attempts` 记录已尝试次数；服务重启把 `sending`
  重置为 `queued`（幂等重试）；用户级冷却（`-14`）时标记 `pause_until` 并失败剩余消息。
- 每账号令牌桶限流（`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`，默认 7 条 / 5 分钟）；
  `-2` 按 `PUSH_RETRY_DELAYS_MS` 退避重试；`-2 prepare failed`（**服务端实测语义，官方 2.4.10 源码无此特判**）
  明确提示 context_token 失效，不按限流重试。
- **HTTP 401**：仅当响应体含 `ret/errcode=-14` 才按 token 失效暂停 1h；401 但 body 非 -14 只记 warn、
  按普通失败退避（避免网关 401 误冷却）。
- **发送失败用户提示**：outbox 永久失败（非 -14 暂停、非 prepare failed）时，按
  `push.errorNoticeEnabled`（env `PUSH_ERROR_NOTICE_ENABLED`，默认 true）向该用户 best-effort 直接发送一次
  「⚠️ 消息发送失败，请稍后重试」；提示不进 outbox 队列、不重试、同一 outbox 只提示一次（进程内去重防循环），
  提示发送失败只记 debug。
- 媒体消息最多两次 `sendmessage`：caption（文字）→ 媒体（上传 CDN 后发送）；`caption_sent_at` 防止重发。
- 优雅退出：`stop()` 等待在途 `processOne()`（有上限），超时后不再写库，避免重复投递。

## 6. 入站监控与媒体（`monitor.js` + `media.js`）

- 每账号独立 `getupdates` 长轮询（默认 35s），游标 `get_updates_buf` **每次变化即落库**、用户 `context_token` 加密保存；
  `-14` 暂停 1 小时，worker 内等待冷却到期后**自动继续轮询**（对齐官方 session-guard；可被 stop 中止，
  进程重启后冷却到期也会自动恢复监控）；连续失败按官方节奏退避（2s→2s→30s，达到阈值清零计数）；
  `longpolling_timeout_ms` 合法值原样使用（仅无效值回退）。
- **入站正文/引用/指令**：按 `item_list` 顺序首个可识别项决定正文（媒体占位不带文件名）；`message_id` 顶层为空时
  回退 `item_list[].msg_id`；`ref_msg` 最小解析为 `raw_json._quote`（不改变规则匹配正文）；`/echo <内容>`
  直接回显（`source=slash`，不进入规则引擎），其余官方 slash 指令不实现。
- 入站消息统一落库（`inbound_messages`，`raw_json` 深度脱敏 context_token/aes_key），媒体附件：
  - **下载 URL 校验**：仅 http/https、禁止 userinfo、主机白名单（iLink/CDN + `MEDIA_ALLOWED_HOSTS`
    + 默认可信后缀 `*.qq.com`/`*.weixin.qq.com`/`*.weixin.com`/`*.qpic.cn`/`*.wx.qq.com`），生产默认拒绝本机/私网；
    重定向 `manual` 逐跳复验（≤3 跳），拒绝时日志记录 host/reason。
  - **提取对齐**：主 item 无媒体时回退引用消息 `ref_msg.message_item` 并标记 `referenced`；voice 有 `voice_item.text`
    时只保留文本不下载；缺 `media`/`aes_key`/可下载地址的 item 静默跳过；MIME 按文件名扩展名路由（含 `.avi`→`video/x-msvideo` 等）。
  - **有界并发**：进程级信号量（`INBOUND_MEDIA_MAX_CONCURRENT` 默认 2、排队 `INBOUND_MEDIA_MAX_QUEUE` 默认 64、
    排队超时），超限记附件 `failed`，不无限堆积。
  - **流式解密落盘**：AES-128-ECB + PKCS7 解密用 `createDecipheriv` + pipeline 写 `.part`，完成后原子 rename；
    单文件上限 `INBOUND_MEDIA_MAX_BYTES`（默认 100MB），失败不影响消息本身入库。
- 入站消息保存失败分类处理：可重试错误保持游标重放，不可重试记录 `inbound_save_failed` 事件。
- **有意差异**：同一消息最多下载 5 个媒体 item（官方只取一个主媒体）、25MB 出站/100MB 入站/60s 超时等加固
  均为平台增强，详见 `docs/PROTOCOL.md` §8。

## 7. 用户级凭据与凭据占位符（`user_secrets` + `shared/credentials.js`）

- **模型**：每条凭据 = 用户下唯一名称（`name`，`[A-Za-z0-9_-]{1,32}`）+ 可选备注 + 一或多个字段
  （`字段名[1..32]` → 字符串值[1..4096]，单条凭据字段数 1..20、总大小上限 32KB）。
- **存储与访问**：字段值 JSON 整体用 AES-256-GCM 加密（`fields_enc`，密钥由 `APP_SECRET` 派生）；
  `field_names` 与掩码提示 `hints`（如 `••••ab12`）明文存储用于展示；**只写不读**——
  管理端列表/详情与 API 均不返回明文，仅返回名称/字段名/hints/时间戳。
- **解析链路**（`shared/credentials.js`）：
  1. 从请求 URL/Header/Body 模板收集引用 `{credential:name.field}`；
  2. `resolveRequestCredentials(userId, refs)` 按用户读取所需字段（内部经 `data/user-secrets.js` 解密），
     缺少任何字段即返回明确错误（含凭据/字段名，不含值）；
  3. `renderCredentialPlaceholders()` 替换模板；
  4. `redactCredentialValues()` 把本次用到的值（含 URL 编码形式）替换为掩码，用于日志、预览、错误、事件；
     并更新凭据 `last_used_at`。
- **使用位置**：
  - 接口应用规则：按**触发用户**解析凭据；
  - 定时通知「按用户模式」：按**目标用户**解析凭据，相同凭据字段值合并一次外部请求。
- **安全**：凭据值不进入任何 API 响应/日志/运行日志预览；用户删除时凭据级联删除。

## 8. 接口应用规则引擎（`app-rules/`）

- 命中条件：入站文本消息匹配规则（`contains`/`equals`/`regex`）+ scope（all/users/groups），
  多规则按 `priority` 升序只执行第一条；同一入站消息对同一规则最多执行一次（去重索引）。
- 参数提取：`none` / `multi`（内置提取器组合，`required` 必填），内置变量 `{text}`/`{userId}`/`{name}`/`{now}`。
- 请求渲染：URL/Header/Body 模板 + `{credential:name.field}` 凭据占位符；GET/POST；超时与响应大小限制；
  SSRF 防护（默认拒绝私网/本机，`APP_RULES_ALLOWED_HOSTS` 白名单；连接层钉 IP + 重定向复验）。
- 响应解析：`json`（点路径）或 `text`；回复模板用 `{{path}}`、`{{#each}}`（含 `where` 过滤、`@index`/`@number`）、
  `{{#if}}`/`{{default}}` 等指令；达到 `MAX_TEXT_LENGTH` 停止渲染；`{{noreply}}` 表示不发送（不使用兜底）。
- **「正在输入」（typing indicator）**：**所有命中规则**（含 `request.mode=none` 直接回复）都显示；
  仅接口应用规则处理期间显示（官方对每条 AI 回复显示；定时通知/广播/保活不显示，属有意差异）。流程：
  命中 → `beginTyping()`（按触发用户；`getconfig`→`typing_ticket` 缓存 **24h 内随机刷新**（失败 2s 起
  指数退避 ×2、最大 1h；缓存 key 为 **userId**）→`sendtyping status=1`，按 `APP_RULE_TYPING_REFRESH_MS` 默认
  **5s**（对齐官方）刷新；请求超时固定 **10s**（对齐官方 `DEFAULT_CONFIG_TIMEOUT_MS`））→ 执行/预览/
  `{{noreply}}`/失败/成功 → 回复入队（或明确不回复）→ finally `endTyping()` **立即**发 `status=2`（官方
  start/stop 语义，无最小可见/延迟取消）；引用计数仅用于同一用户并发时避免相互取消。best-effort，失败只
  debug 日志、不影响规则。实现见 `server/src/typing.js`（依赖可注入便于单测）。
- 执行队列：进程内 worker（`APP_RULES_WORKER_CONCURRENCY`）+ 有界队列（`APP_RULE_MAX_QUEUE`），
  失败只记录该次运行；运行日志写 `app_rule_logs`（参数/请求/响应预览均已脱敏，不含凭据值）。

## 9. 定时通知（`scheduler/`）

- 计划：`interval`（每 N 分钟，60s–30d，可配每日生效时间段 `windowStart/windowEnd`，支持跨午夜）与
  `daily`（每天 HH:mm，时区 `SCHEDULER_TIMEZONE`）；服务重启对过期任务补跑一次。
- 执行（tick 扫描 `SCHEDULER_TICK_MS`，单任务异常不影响其他；任务锁防重入）：
  - **汇总模式**（默认）：一次请求 → 渲染通知 → 对目标用户逐个入队 outbox（`source='schedule'`）；
  - **按用户模式**（`per_user_mode=1`）：展开目标用户（上限 `perUserMaxRecipients` 默认 50）→
    逐用户解析其凭据（缺凭据跳过并写事件，不兜底）→ 相同凭据字段值指纹合并为一次外部请求 →
    按用户渲染通知模板（`{{userName}}`/`{{userId}}` 等）→ 只给该用户入队；并发池
    `perUserConcurrency`（默认 2，范围 1–10）；单用户失败只影响该用户；整体状态
    `success | partial | failed`（`partial` = 部分成功），每用户明细写 `events`（不含凭据值）。
  - 失败时按配置的兜底文案发送（为空则不发送）；`{{noreply}}` 生效；写 `scheduled_task_logs`
    （含 `recipients_count`）。
- 手动：`POST /api/admin/scheduled-tasks/{id}/test`（dry-run，不发送不写日志）与 `/{id}/run`
  （立即执行；停用任务返回 400）；`start()/stop()` 幂等，退出时等待在途 tick。

## 10. 24h 会话保活（`keepalive.js`）

- 对开启保活的用户，在其最后一条入站消息满 `windowMs - leadMs`（默认 24h 窗口、提前 12h）时入队保活消息；
  未回复则每 `repeatMs`（默认 6h）重复提醒，直到用户回复（新入站刷新窗口）或窗口过期。
- opt-in：默认关闭，可对单用户或分组开启；分组开启后新加入成员自动继承（移出分组不关闭）。
- 发送走 outbox（`source='keepalive'`），受每账号限流；单实例进程内定时扫描（`KEEPALIVE_TICK_MS`）。

## 11. 运行配置（`settings/`）

- `app_settings(key, value, updated_at)` 只存被后台覆盖的字段；`.env` 仅作**首次启动默认值**。
  必须由 `.env` 管理的项：`APP_SECRET`、`DATA_DIR`、`MEDIA_DIR`、`PORT`、`HOST`、`NODE_ENV`
  （`DB_SYNCHRONOUS` 为启动期 SQLite 参数），其余均可在后台「运行配置」修改。
- `SETTINGS_SCHEMA` 分组：`push`（含 `errorNoticeEnabled` 发送失败提示开关）、`keepalive`、`appRules`、
  `scheduler`（含 `perUserConcurrency`、`perUserMaxRecipients`）、`media`、`binding`、`server`、`security`、
  `ilink`、`monitor`；
  字段元数据（类型/范围/默认/`restartRequired`）与 `docs/SETTINGS.md` 由 `npm run doc:lint` 双向校验。
- `loadOverrides()` 启动时读取 DB 覆盖 `config`；`updateSettings()` 校验 → UPSERT → 覆盖 config →
  调用运行时 hooks（keepalive/scheduler 重启定时器、appRules 引擎启停、logger 级别）；多数即时生效，
  启动期创建的资源（令牌桶、body 解析上限、下载信号量、代理信任、监控账号池）标记 `restartRequired`。
- 管理密码（scrypt 哈希）与 API Token（AES 密文）只由 DB 管理：首启自动生成并写 `data/` 文件（0600），
  后台「安全」卡片可修改/重置/轮换，接口绝不回显明文。
- env-only 参数：`ILINK_CONFIG_TIMEOUT_MS`（轻量 iLink API 超时，默认 10000，未并入运行配置）、
  `MAINTENANCE_*`（数据维护）等。

## 12. 安全约定

- 管理后台：HttpOnly + SameSite=Lax Cookie（HMAC 签名）+ 写接口 `X-Requested-With` CSRF 头；
  登录失败按 IP 限流。对外 API：`Authorization: Bearer` 或 `X-Api-Key`，常量时间比较，按 Key 限流；
  Webhook 兼容 `?token=`（URL 可能入代理日志，建议用 Header）。
- 绑定页公开：按 IP 限创建会话频率；会话 secret 只返回一次、服务端只存哈希。
- 凭证加密：`bot_token`/`context_token`/规则与定时任务 Header/用户级凭据字段值/API Token 等
  AES-256-GCM 加密落库；管理密码 scrypt；`APP_SECRET` 为根密钥，可用 `npm run rotate-secret` 离线轮换。
- 日志脱敏：按敏感键名替换；URL query（`token/api_key/authorization` 等）值替换为 `[redacted]`；
  入站 `raw_json` 中 `context_token`/`aes_key` 脱敏；凭据值在预览/错误/事件中统一掩码；发送失败用户提示
  只包含固定文案（不含 token/内部错误），其发送失败仅 debug 日志。
- SSRF：外部 HTTP 调用先 DNS 解析并判私网/环回/保留段，再把校验通过的 IP **固定到连接层**
  （`node:http(s).request` 的 `lookup`，Host/TLS servername 用原域名），重定向 `manual` 最多 3 跳、
  每跳重新校验；入站媒体下载同样做协议/主机白名单与逐跳复验。
- 安全响应头：`nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、
  CSP `default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline';
  script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`。
- 请求体上限 64KB；`MAX_TEXT_LENGTH` 按 `String.length`；404/错误响应不泄漏内部路径或堆栈（生产）。

## 13. 前端约定（`web/`）

- 零构建、零外部 CDN：原生 ES Module + 手写 CSS，所有资源由本服务 `/assets/*` 提供；
  HTML 只引用 `/assets/admin.js`、`/assets/bind.js`、`/assets/docs.js` 三个入口与 `/assets/style.css`，
  其余模块通过相对 `import` 加载（禁止裸包名/外部 URL）。
- 管理后台模块结构见 §1；视图按需**动态 import** 懒加载（首屏只加载概览 + core/ui 等公共模块），
  由 entry 注册视图加载器；`tests/unit/frontend-modules.test.js` 强制 import 路径存在、无环、入口可达。
- 统一 `fetch` 封装：JSON、错误 toast、401 跳登录；管理写请求自动加 `X-Requested-With`；
  全部动态内容用 `textContent`/DOM 属性渲染（无 `innerHTML`/内联事件），满足 CSP。
- 三页面：`/`（公开绑定页，`/bind` 302 跳转 `/`）、`/admin`（管理后台，hash 路由直达视图）、
  `/docs`（API 文档页，端点与 `docs/API.md` 由 doc-lint 保持一致性）。
- 单套 DOM/CSS 响应式（桌面常驻侧栏、窄屏 off-canvas 抽屉由 CSS 媒体查询切换，JS 不判断屏宽）。

## 14. 数据维护与可观测性

- **维护**（`maintenance.js`，默认启用）：启动约 1 分钟后首次、之后按 `MAINTENANCE_INTERVAL_MS` 周期执行；
  清理孤儿媒体文件、无磁盘文件的 ready 附件行、超期未入队上传附件（保留被 queued/sending outbox 引用的），
  按保留期分批删除 `events`/`app_rule_logs`/`scheduled_task_logs`；`outbox`/`inbound_messages` 业务数据不自动删；
  维护前后可执行 `PRAGMA optimize` 与 WAL checkpoint（可用 env 关闭）。参数见 `.env.example` 数据维护节。
- **指标**（`metrics.js`）：进程内计数器/仪表（入站监控、出站队列、媒体下载/排队、规则与定时聚合、进程 uptime/内存），
  通过 `GET /api/admin/metrics` 与管理后台概览 `metrics` 摘要只读暴露，不采集个人信息。

## 15. 测试策略

- **单元**：进程内 import 业务模块 + `listen(0)` HTTP 契约；覆盖 config/crypto/iLink/store 与 data/**、
  媒体加解密与入站下载/并发、schema v1 校验与索引、用户级凭据、凭据解析/脱敏、规则引擎/SSRF、定时计划与
  两种执行模式、运行配置、维护 GC、指标、日志脱敏、错误映射；前端 parser/lib/模块图/静态页面测试。
- **e2e**：真实 `app` + `mock` 双进程、随机端口（`PORT=0` 日志解析）、临时 `DATA_DIR`，全 HTTP 黑盒；
  覆盖绑定/推送/入站/媒体/分组/入站 API/保活/规则/凭据注入/定时（含按用户模式）/运行配置/密码与 Token；
  子进程 env 白名单、稳定等待断言、mock 协议违规统一断言；`npm run e2e:stability` 串行连跑验证稳定性。
- **浏览器冒烟**：`npm run test:ui`（headless Edge/Chrome + CDP，无浏览器自动跳过）。
- **文档**：`npm run doc:lint` 校验版本号/环境变量/设置字段/API 端点/相对链接/README 命令。
- 覆盖率：`npm run coverage`，CI 阈值 line 90 / branch 70 / funcs 85。

## 16. Docker 与发布

- `Dockerfile`：`node:24-alpine`（生产依赖 `npm ci --omit=dev`）、非 root `USER node`、`/app/data` 700、
  内置 fetch HEALTHCHECK；数据持久化到命名卷 `clawbridge-data`。
- 3 份 compose：生产（命名卷）、fnOS（`./data` 真实目录 + PUID/PGID）、demo（app + mock iLink，
  `--profile demo`）；均带健康检查、日志滚动与运行加固（`no-new-privileges`、停机宽限）。
- CI/发布（`.github/workflows/`）：PR 跑 lint → coverage 门禁 → mock 自测 → e2e 稳定性；
  `main` 推送构建并发布多架构镜像（`latest` + `sha-<commit>`，附 SBOM/provenance），`v*` tag 追加版本 tag。
  发布流程见 [`docs/RELEASE.md`](RELEASE.md)。
