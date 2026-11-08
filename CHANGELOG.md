# 更新日志（Changelog）

本项目当前为自托管单仓库发布（Docker 镜像 + 源码），版本号以 `package.json` 为准；
记录原则：只写**用户可感知的版本/契约变化与重要修复**，不逐条罗列内部重构。
版本归属：`2.0.0` 为平台基线；2026-11-08 的审查 / 重构 / 加固统一随 **2.1.0** 发布。

## [2.1.0] - 2026-11-08

### 概要（审查 / 重构 / 加固）

- **定位**：2.1.0 是 2.0.0 的**质量与安全加固版本**，数据库 schema 保持 **v10 不变**
  （2.0.0 → 2.1.0 可原地升级，见 [`docs/UPGRADE.md`](docs/UPGRADE.md)；发布流程见
  [`docs/RELEASE.md`](docs/RELEASE.md)）。
- **审计**：对全仓完成 backend / frontend / infra 三份明细只读审计（归档 `docs/review/`），
  汇总与修复记录见 [`docs/CODE_REVIEW.md`](docs/CODE_REVIEW.md)。
- **模块拆分**（对外契约不变）：后端 `api.js` → `http/` + `routes/`、`store.js` → `data/**`、
  `app-rules.js` → `shared/**`（scheduler 解耦）；前端 `admin.js` → `admin/**` + `lib/**` +
  规则/定时编辑器公共模块。
- **安全加固**：接口应用/定时通知 SSRF **连接层固定已校验 IP**（修复 DNS rebinding）、入站媒体下载
  URL 白名单 + 流式解密 + 有界并发（防 OOM）、日志 URL query 机密脱敏、Webhook `?token=` 脱敏、
  共享媒体附件归属修复。
- **数据维护**：新增 `server/src/maintenance.js`——孤儿附件/媒体文件 GC、日志保留期清理、
  `PRAGMA optimize` / WAL checkpoint（参数 `MAINTENANCE_*`）。
- **可靠性**：优雅退出等待在途任务（dispatcher drain / scheduler tick，修复重启重复投递与重复定时、
  日志丢失）、高频查询索引启动时幂等补齐、v1 发送对 `paused` 用户语义与后台对齐。
- **可访问性与截图**：颜色 token 达 WCAG AA、模态框焦点陷阱与 Tab 键盘语义、死 CSS/断点统一；
  README 截图用**演示数据**重新生成（无真实昵称/本机路径）。
- **工程化**：ESLint flat config（0 error / 0 warning）、CI 覆盖率门禁（line 90 / branch 70 / funcs 85）
  与测试 + mock + 浏览器冒烟门禁、e2e 稳定性改造、`.editorconfig` / Dependabot、
  `docs/UPGRADE.md` / `docs/RELEASE.md`、compose demo 加固、GHCR 发布 provenance/SBOM。
- **测试**：**362 → 464** 用例（unit + e2e + 前端/生命周期/维护等新增），mock 协议自测 26/26。
- **部署验证**：本机 `docker compose build` 新镜像后部署验证通过——`/health` 200（version 2.1.0）、
  `/` `/admin` `/docs` 均 200、安全响应头完整；旧数据卷 `clawbridge-data` 与绑定用户保留
  （详见 [`docs/CODE_REVIEW.md`](docs/CODE_REVIEW.md) 部署记录）。
- **升级提示**：旧版本数据库（schema < 10）仍需「备份 → 空库重建 → 重新绑定」；同为 v10 的
  `2.0.0 → 2.1.0` 直接换镜像/源码即可（建议先备份）。

### 兼容性说明

- 对外 HTTP API（`/api/admin/*`、`/api/v1/*`、`/api/bind/*`、`/api/v1/webhook`）的路径、字段与错误码
  经多轮审查/重构/加固**未变化**；错误响应格式与鉴权语义不变。
- **行为收紧（安全）**：入站媒体下载在生产环境默认只允许 https + iLink/CDN/显式白名单主机，并拒绝本机/私网地址；
  dev/test 环境自动放行 localhost 以兼容 mock/demo；如需自定义主机请配置 `MEDIA_ALLOWED_HOSTS`。接口应用/定时
  通知的外部调用在连接层固定已校验 IP，功能语义不变。
- **资源限制**：入站媒体下载默认并发 2、排队 64、排队超时 60s（后台可调）；原先依赖"无限并发/整文件内存"的
  极端场景可能改为排队或失败（会记录附件失败原因）。
- **启动行为**：每次启动会幂等补齐高频查询索引（无需 schema 变更）；数据量大时首次升级启动会多一次建索引耗时。
- 升级自旧版本（schema < v10）**不支持原地升级**：备份后空库重建、重新扫码绑定。
- 本版本新增 `security`/`media`/`binding` 等后台字段、`/mock-bind`（仅 mock）与工程化文件，
  不影响既有部署行为。

### 审计与各轮加固记录

对全仓完成一轮只读审计（`backend` / `frontend` / `infra` 三份报告，含逐条问题与修复建议），
并落地以下变更（新 → 旧）：

### 第三轮加固（2026-11-08，可维护性/数据生命周期/工程化）

- **后端结构**：
  - `server/src/store.js`（2126 行/107 导出）拆为 23 行 façade + `server/src/data/**` 13 个按域模块
    （users/groups/keepalive/rules/scheduled/attachments/outbox/inbound/messages/events/stats +
    mappers/helpers），保持导出名与调用方零改动；顺带消除规则/定时任务视图 N+1 查询、修复"今日统计"
    （按 `SCHEDULER_TIMEZONE` 计算当日零点）与 `last_poll_at` 每轮更新。
  - `server/src/app-rules.js`（~1744 行）拆为 656 行 + `server/src/shared/{http-client,template,response,
    http-execute}.js`；scheduler 不再依赖 app-rules 内部实现，新增独立
    `SCHEDULER_MAX_RESPONSE_BYTES` / `SCHEDULER_ALLOWED_HOSTS`（缺省继承接口应用配置）；
    模板渲染增加输出上限（大列表达到 `maxTextLength` 即停止迭代）。
- **数据生命周期（BA-18）**：新增 `server/src/maintenance.js`——定时清理孤儿媒体文件/无文件附件行/
  超期未入队上传附件，按保留天数清理 events/规则日志/定时日志（不动 outbox/inbound 业务数据），
  分批+事务、`PRAGMA optimize`/WAL checkpoint、优雅退出前停止；参数见 `.env.example` 第十二节
  `MAINTENANCE_*`。
- **行为修正/收紧**：
  - v1 发送对 `paused`（-14 冷却中）用户：全部不可发 → 409；部分可发 → 202 并在响应中返回
    `pausedUserIds`（与后台语义一致，兼容旧调用方）。
  - 绑定成功时若入站监控未能启动，事件/日志/warning 提示（可后台重连）；`binded_redirect` 文案补充
    重连/解绑提示。
  - PATCH 规则"不请求模式"的回复校验合并 DB 现有模板/兜底值；入站消息写入失败按 SQLITE_BUSY/IO
    分类：可重试保持游标重放，不可重试写 `inbound_save_failed` 事件。
  - `restartRequired` 标注逐字段校正（ilink 全组、push.tickMs/apiRateLimitPerMinute 等实际即时生效字段
    不再提示需重启）；前台"需重启"标记与实现一致。
- **前端**：管理后台颜色 token 提升到 WCAG AA（`--text-muted` 等）；清理 41 条死 CSS 规则、补齐未定义
  变量、统一断点（639/640、899/900、1023/1024）；README 全部截图用**演示数据**重新生成
  （`npm run screenshots` 可复现，无真实昵称/本机路径，随 2.1.0 发布的 UI）。
- **工程化**：新增 ESLint flat config（CI `--max-warnings=0`，0 error/0 warning）；
  e2e 子进程 env 白名单、负向断言稳定等待、mock 违规统一断言；新增生命周期/错误/维护等测试；
  `.editorconfig`、dependabot、`docs/UPGRADE.md`、compose demo 加固、GHCR 发布增加 provenance/SBOM；
  测试总量 426 → 464。

### 第二轮加固（2026-11-08，安全/可靠性/可维护性）

- **安全**：
  - 接口应用/定时通知的外部 HTTP 调用改为**连接层固定已校验 IP**（`node:http/https.request` + `lookup`，
    Host/TLS servername 保持原域名），重定向每跳重新校验并重新钉 IP，修复 DNS rebinding 绕过 SSRF 防护的
    问题（BA-01）；补充 gzip/deflate/br 解压上限与半截响应竞态处理。
  - 入站媒体下载增加协议/主机白名单（iLink/CDN + `MEDIA_ALLOWED_HOSTS`，生产默认拒绝本机/私网）、
    `redirect:'manual'` 逐跳复验（BA-05）。
  - **入站媒体资源上限（BA-02）**：进程级有界并发闸门（默认并发 2 / 排队 64 / 排队超时 60s，均可在
    「运行配置 → 媒体」调整）、下载+解密改为**流式落盘**（`.part` 临时文件 → 原子 rename），避免单租户
    大文件把进程内存打满；排队超限/超时记附件失败。新增环境变量：`INBOUND_MEDIA_MAX_CONCURRENT`、
    `INBOUND_MEDIA_MAX_QUEUE`、`INBOUND_MEDIA_QUEUE_TIMEOUT_MS`、`MEDIA_ALLOWED_HOSTS`、
    `MEDIA_ALLOW_INSECURE_HTTP`。
- **可靠性**：
  - 优雅退出改为**等待在途任务**：dispatcher drain（在途发送完成/超时后禁写库）、scheduler 在途 tick 等待、
    定时任务"运行日志 + next_run_at"同一事务、最后关闭 DB（兜底 10s→30s）；修复重启可能导致的重复微信
    投递/重复定时通知/日志丢失（BA-04），并消除 `restoreMonitors` 与退出的竞态（BA-23）。
  - 修复共享媒体附件归属错误（BA-03）：分组/多目标使用同一 `mediaId` 时，删除任一收件人不再删除其他
    收件人待发媒体；删除用户时保留仍被未完成 outbox 引用的附件。
  - 新增高频查询索引（BA-08）：`inbound_messages(received_at, id)`、`inbound_messages(created_at DESC)`、
    `outbox(created_at DESC)`；通过 `CREATE INDEX IF NOT EXISTS` 在启动时幂等补齐（无需 schema 版本变更，
    既有 v10 数据卷升级后自动生效，首次启动会多一次建索引耗时）。
- **前端**：
  - 规则编辑器与定时任务编辑器重复代码合并（新增 `web/assets/admin/integrations/**` 6 个共享模块，
    两个编辑器各减少 300+ 行，行为/DOM/文案不变）。
  - 无障碍：模态框 Tab 焦点陷阱 + 背景 inert/aria-hidden；消息方向、规则/定时 Tab 补齐
    `role=tabpanel`/`aria-controls`/roving tabindex 与方向键/Home/End 键盘操作。
- **工程化**：`npm run coverage` 增加 CI 阈值（line 90 / branch 70 / funcs 85），CI PR 工作流改为跑覆盖率门禁；
  测试总量 400 → 426。

### 首轮修复与结构重构（2026-11-08）

- **行为变更（与文档契约对齐）**：新建接口应用规则 / 定时通知任务默认**停用**——API 创建未传
  `enabled` 时写入 `false`，管理后台新建表单默认不勾选「启用」（此前默认启用，与
  `docs/API_RULES.md` / `docs/SCHEDULED_TASKS.md` 的"默认不启用"承诺相反）。
- **缺陷修复**：
  - 管理后台会话过期时正确关闭全部弹窗（此前 `confirmDialog` 未纳入跟踪集合，可能出现 Promise
    悬挂、弹窗计数泄漏与页面滚动锁残留）；
  - 错误日志与接口应用运行日志对 URL query 中的机密参数（`token`/`api_key`/`authorization` 等）
    统一脱敏（Webhook `?token=` 不再可能明文落盘，`request_preview` 不再保存明文 query 密钥）；
  - 定时任务 PATCH 修改每日生效时间段（`windowStart`/`windowEnd`）时显式重算 `next_run_at`。
- **测试**：新增 `npm run test:ui` 浏览器冒烟（headless Edge/Chrome + CDP，可复现的登录/视图/CRUD/
  编辑器回归）、`npm run coverage`，测试总量 362 → 400。
- **工程化**：新增 CI 测试工作流（`npm ci` → 单元 + e2e + mock 自测；发布镜像前先测试）；
  新增 `.nvmrc`（Node 24）与 `.npmrc`（`engine-strict=true`），低于 engines 下限会直接报错而不是运行时崩溃。
- **后端结构**：拆分 `server/src/api.js` 为 `http/`（中间件/校验/视图）+ `routes/`（各路由模块）+ 组合根，
  对外接口、鉴权、错误格式完全不变。
- **前端结构**：拆分 `web/assets/admin.js` 为 `web/assets/admin/**` 视图/状态/UI 构建器 + `web/assets/lib/**`
  纯函数模块（零构建 ES Module 不变），行为、文案与 DOM 结构不变。
- **mock**：新增 `GET /mock-bind` 占位页（此前 `qrcode_img_content` 指向该地址但返回 404）；
  `node mock/selftest.mjs` 断言数增加。
- **文档修正**（与实现对齐，避免误导升级/排障）：
  - schema 迁移相关章节统一标注为“历史设计记录（已废弃）”，明确现行 schema v10 旧库直接拒绝；
  - 补充媒体能力说明（`docs/PROTOCOL.md` 不再称“只发文本”）；
  - 明确管理后台写接口的 CSRF 头要求（`POST /api/admin/login` 例外）；
  - 明确上传接口的 MIME/文件名校验行为（不校验 MIME 白名单，仅文件名/请求体非法时 400）；
  - 明确管理密码/API Token 来源恒为 DB；
  - `skipped` 日志状态/统计标注为保留字段（当前引擎不写入、统计恒为 0）；
  - `.env.example` 补齐 8 个首次默认值变量（含任务要求的 6 个：`BINDING_VERIFY_TIMEOUT_MS`、
    `BINDING_NETWORK_ERROR_LIMIT`、`BINDING_POLL_GAP_MS`、`ILINK_ROUTE_TAG`、
    `MEDIA_ALLOWED_IMAGE_MIME`、`MEDIA_ALLOWED_VIDEO_MIME`；另补 `ADMIN_SESSION_TTL_MS`、
    `PUSH_RETRY_DELAYS_MS`），并修正 `BOT_AGENT` 示例值（代码默认 `OpenClaw`）。

## [2.0.0] - 2026-11-08

> 说明：本段为 2.0.0 平台基线记录；其后 2026-11-08 的审查/重构/加固（含测试 362→464）已归档到
> 上方 [2.1.0]。

### 概要

- **定位**：ClawBridge 2.0.0 是自托管的多用户微信 ClawBot 绑定 / 推送平台（Node 24 + Express 5 +
  `node:sqlite`，零构建前端，`node --test` 测试体系；生产依赖仅 `express`、`qrcode`）。
- **核心能力**：多用户扫码绑定与凭证隔离、出站 outbox 队列（每账号限流、`-2` 退避 / `-14` 冷却）、
  入站长轮询与消息记录、用户分组（多标签/按组群发）、对外入站消息 API（分页 / 游标 / 长轮询）、
  24h 会话保活、接口应用（关键词触发外部 HTTP 接口并回复）、定时通知、媒体（图片/视频/文件出站，
  图片/文件/视频/语音入站；CDN AES-128-ECB 加解密）。
- **安全底座**：凭证 AES-256-GCM 加密落库、HMAC 会话 Cookie、管理写接口 CSRF 头、IP/API Key 双层限流、
  接口应用 SSRF 私网拒绝、媒体文件私有读取（鉴权 + Range + 防目录穿越）、日志键名脱敏。
- **运行配置**：常用参数存 `app_settings` 并可在后台「运行配置」修改；`.env` 只保留启动期必须项
  （`APP_SECRET`/`DATA_DIR`/`MEDIA_DIR`/`PORT`/`HOST`/`NODE_ENV`）作为**首次启动默认值**。
  管理密码 / API Token 只由 DB 管理（首启自动生成，写入 `data/` 文件），不再读取旧 env。
- **数据库**：schema **v10**，**不兼容旧版本数据库**——旧库启动直接拒绝（不提供迁移），
  升级须备份 `DATA_DIR` 后用空库重建并重新绑定。
- **交付**：Dockerfile + 3 份 compose（含 fnOS）、GHCR 多架构镜像、`mock/ilink-mock.mjs` 本地模拟器
  （`node mock/selftest.mjs` 自测）。
