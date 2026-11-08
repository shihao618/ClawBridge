# 后端代码审查报告

- 审查对象：`F:\ClawBot\server\src` 全部 19 个模块（HEAD `a23c2be`，git 工作区干净）
- 审查日期：2026-11-08
- 审查角色：只读后端审查（未修改任何代码/测试/文档）
- 报告路径：`docs/review/backend.md`（归档位置；审查时写入 `.audit/backend.md`，2026-11-08 归档至本目录）

## 0. 方法与基线

1. **全文精读**：用 read 工具逐行读完全部 19 个文件，共 11,251 行（`node` 精确计数，见 §5）。所有引用行号来自 read 工具确认的当前 HEAD 行号。
2. **契约对照**：通读 `docs/ARCHITECTURE.md`（464 行）、`docs/API.md`（809 行）；按需核对 `docs/API_RULES.md`、`docs/SETTINGS.md`、`docs/SCHEDULED_TASKS.md`、`docs/GROUPS_AND_INBOUND.md`、`docs/KEEPALIVE.md`、`docs/MEDIA.md`、`docs/PROTOCOL.md` 中的具体断言，均已在条目中给出文档行号。
3. **基线**：任务上下文给出的基线为 schema v10、生产依赖仅 express/qrcode、362 个测试通过（约 33s）。本次复核：`tests/` 下 34 个 unit + 12 个 e2e 文件，顶层 `test()` 计数恰为 **362**，与基线一致。**本次未运行全量 `npm test`**（按任务要求）。
4. **只读动态验证**（未改仓库文件；临时 DB 建在系统临时目录，用后删除）：
   - 用真实 `store`/`db` 模块复现“共享媒体附件归属/级联删除”问题（见 BA-03）：删除用户 A 后附件行消失，而用户 B 的 outbox 仍为 `queued` 且引用该 `mediaId`。
   - 对临时库执行 `EXPLAIN QUERY PLAN`，确认入站对外 API、后台消息列表均走全表扫描 + 临时排序（见 BA-08）。
5. **约束**：只读审查，不修改代码/测试/文档，不执行 git 写操作。行号为 HEAD `a23c2be` 时点；Lead 已提示后续将拆分 `api.js`，拆分后第 2 节中 `api.js` 的行号需按新文件重新定位（问题本身不受影响）。
6. **严重度口径**：P0/P1 只授予可能造成数据丢失、安全边界突破或服务不可用的问题；风格偏好、文档笔误、内部实现选择均降级为 P3。

## 1. 结论摘要

| 严重度 | 数量 | 说明 |
| --- | --- | --- |
| P0 | 0 | 未发现可直接导致整库/凭证明文泄露或必然数据丢失的问题 |
| P1 | 2 | SSRF 防护可被 DNS rebinding 绕过；入站媒体并发/内存无上限可被租户拖垮进程 |
| P2 | 7 | 附件共享归属导致跨用户媒体丢失、退出顺序导致重复投递/重复定时、日志机密泄漏、轮询全表扫描、模块耦合等 |
| P3 | 14 | 死代码、restartRequired 漂移、边界校验缺口、N+1、契约/文档漂移等 |
| 合计 | 23 | — |

**总体评价（3–5 句）**：这套后端的“安全底座”明显强于同规模项目——凭证 AES-256-GCM 加密落库、HMAC 会话、常量时间比较、CSRF 头、IP/Key 双层限流、SSRF 私网全段拒绝 + 逐跳重定向复验、统一错误响应与日志键名脱敏都做得扎实，单进程同步 SQLite 的用法（BEGIN IMMEDIATE + SAVEPOINT，无 async 事务）也正确，362 个测试的覆盖面与文档体系是显著加分项。主要问题集中在三处：一是 SSRF 校验与 `fetch` 两次独立 DNS 解析之间缺少 IP 固定，安全边界可被 DNS rebinding 击穿（BA-01）；二是多租户媒体链路的内存/并发缺少全局闸门，以及共享附件归属建模错误会造成跨用户媒体丢失（BA-02/BA-03）；三是进程退出时未等待 scheduler/app-rules 的在途异步任务、dispatcher 只等 5s 就关库，会产生重复投递/重复定时执行与运行日志丢失（BA-04）。结构上 `api.js`(1895)/`store.js`(2126)/`app-rules.js`(1474) 三个 god module 与 `createApp()` 单函数（913–1895 行，69 个路由）是后续维护的最大成本，报告 §3 给出了可分 6 步落地、每步测试可回归的拆分方案。另外 `db.js` 自 v10 起拒绝旧 schema（`db.js:20-21,279-282`）是文档明示的破坏性设计，升级必须重建空库，属于已接受的运维风险，未计入问题清单。

Top 风险（按优先级）：
1. BA-01 SSRF DNS rebinding（P1）
2. BA-02 入站媒体并发/内存无上限（P1）
3. BA-04 退出顺序 → 重复微信投递 / 定时任务重复执行（P2）
4. BA-03 共享媒体附件归属/级联删除 → 其他收件人媒体丢失（P2）
5. BA-06/BA-07 日志与运行日志中的凭据脱敏缺口（P2）
6. BA-08 对外长轮询 API 缺 `received_at` 索引（P2，已用 query plan 证实）
7. BA-09 scheduler 依赖 app-rules 内部实现 + 双份 HTTP 执行管线（P2 架构）

## 2. 详细问题清单

### 2.1 P1（可能造成安全边界突破 / 服务不可用）

#### BA-01 SSRF 防护可被 DNS rebinding 绕过（校验与请求两次解析，未固定 IP）
- **严重度**：P1
- **类别**：安全 / SSRF
- **位置**：`server/src/app-rules.js:889-921`（`validateTargetUrl`：先 `dnsLookup` 解析并判私网）；`server/src/app-rules.js:1010-1039`（`requestExternal` 每跳先 `await validateTargetUrl`，随后 `fetchImpl(currentUrl, ...)` 自行再解析一次 DNS）；`server/src/app-rules.js:1041-1062`（重定向复验逻辑）
- **证据/说明**：SSRF 防护是“**先解析、后判私网、再交给 fetch 重新解析**”的三段式。`validateTargetUrl` 返回 `{url, hostname}`，但 `requestExternal` 并未把已解析的 IP 固定给连接层（Node 内置 fetch 不支持在调用侧锁定 IP），因此 DNS 记录只要在两次解析之间（TTL 极短或攻击者 DNS 轮换）从公网 IP 变为 `127.0.0.1`/`169.254.169.254`/内网段即可通过校验。单元测试注入的 `dnsLookup` 只覆盖“校验时解析到私网”的分支（`tests/unit/backend-app-rules-core.test.js:366-369`），无法覆盖 rebinding。重定向方向的处理是正确且较严格的：`redirect:'manual'`、最多 3 跳、每跳重新校验、仅允许同主机或 http→https 升级（`app-rules.js:1047-1051`），这一点值得保留。
- **影响**：可让 ClawBridge 进程访问内网/云元数据（凭证、管理端口）。触发条件是“可配置规则 URL 的人”（管理员或后台被入侵/被诱导配置），因此是“管理员权限 → 内网访问”的横向移动通道，而非未授权直接利用；鉴于 `docs/API_RULES.md:158-171` 明确把默认拒绝私网作为安全承诺，仍应视为 P1。
- **修复建议**：把 DNS 解析结果钉住到连接层：Node 24 内置 fetch 基于 undici，可用 `new undici.Agent({ connect: { lookup: (host, opts, cb) => cb(null, pinnedIp, family) } })` 作为 `dispatcher` 传入 `fetch`（undici 是 Node 内置依赖，无需新增包）；或在 `validateTargetUrl` 返回 `addresses`，`requestExternal` 直接用 `http/https.request({ lookup })` 或 `net.connect(pinnedIp)` + `Host` 头发请求。重定向每跳同样使用钉住的 lookup。另建议加单测：DNS 第一次返回公网、第二次返回 127.0.0.1 时请求应被拒绝。工作量 **M**。

#### BA-02 入站媒体下载无全局并发/内存上限，单租户可耗尽进程内存
- **严重度**：P1
- **类别**：可用性 / 资源耗尽
- **位置**：`server/src/monitor.js:276-337`（`processMessages` 对每条消息收集 `mediaTasks`，`Promise.allSettled`；`runLoop` 在 `monitor.js:481` **不 await** 地调用它）；`server/src/media.js:209-258`（`fetchBuffer`/`downloadAndDecryptInbound` 把整个文件读入内存后解密，最多同时持有“密文 + 明文”两份）；`server/src/media.js:21`（每条消息最多 5 个媒体 item）；`server/src/config.js:124-126`（入站上限默认 **100MB**/文件，下载超时 60s）
- **证据/说明**：并发链路上没有任何信号量/队列：每次 `getUpdates` 返回后 `processMessages` 被 fire-and-forget 调用，内部对每条消息创建下载任务并用 `Promise.allSettled` 并行等待；多条消息、多个批次的下载可以同时在跑。单个 100MB 文件在 `fetchBuffer` 中形成完整密文 Buffer，`aesEcbDecrypt` 再生成完整明文 Buffer，`saveMediaBuffer` 写盘后才释放，峰值可达数百 MB/任务。`MAX_MEDIA_ITEMS_PER_MESSAGE=5` 只限制单条消息内数量，不限制消息间/用户间并发。
- **影响**：任意已绑定用户（多租户平台中的单个租户）发送若干大图片/文件/视频即可让单进程 Node 触发 OOM，导致所有用户服务中断；正常的多用户大文件并发也可能触发。这符合“可能造成服务不可用”的 P1 口径。
- **修复建议**：在 `media.js` 或 `monitor.js` 增加进程级 `Semaphore`（如 2–4 个并发下载）与全局内存预算；下载改为流式落盘 + 流式解密（`crypto.createDecipheriv` + `pipeline`），不要整文件进内存；`processMessages` 对媒体任务做有界队列（超出直接记 `failed` 附件或延后重试），并给单用户加并发/带宽上限。另把 `INBOUND_MEDIA_MAX_BYTES` 默认值降到更现实的量级（如 25MB）或在文档中明确内存占用模型。工作量 **M**。

### 2.2 P2（数据一致性 / 安全纵深 / 性能 / 架构）

#### BA-03 共享媒体附件归属错误：删除任一收件人会级联删掉其他收件人待发媒体（数据丢失）
- **严重度**：P2
- **类别**：正确性 / 数据完整性
- **位置**：`server/src/store.js:1522-1530`（`linkAttachmentOutbox`：`user_id = COALESCE(user_id, outbox.user_id)`，且 `outbox_id` 每次被覆盖）；`server/src/store.js:284-293`（`deleteUserCascade` 先按 `attachments.user_id` 收集路径，事务内 `DELETE FROM attachments WHERE user_id = ?`）；`server/src/api.js:425-440`（分组群发把**同一个** `mediaId` 入队给全组用户）；`server/src/api.js:1713-1715`（v1 多目标发送同样共享 `mediaId`）；`server/src/dispatcher.js:178-187`（投递前附件不存在 → 直接 failed）
- **证据/说明**：同一附件发给多人时，`enqueueMessage`（`store.js:1574-1600`）对每个收件人调用 `linkAttachmentOutbox`：第一次把 `attachments.user_id` 写成第一个收件人，之后每次覆盖 `outbox_id` 但仍保留第一个 `user_id`。因此附件“归属”第一个收件人，而 `outbox_id` 指向最后一个收件人。`deleteUserCascade` 按 `user_id` 删除附件行并由 API 删除磁盘文件（`api.js:1133-1143`）。**已用真实模块复现**（临时 DATA_DIR）；结果：删除用户 A 后附件行 `GONE`，用户 B 的 outbox 仍是 `status=queued, mediaId=att_…, attachments=0`；随后 dispatcher 预检查（`dispatcher.js:182-186`）会把它标记为“媒体附件不存在或未就绪”永久 failed。
- **影响**：分组群发/多目标 API 发送的媒体，只要第一个（或最后一个，取决于删除谁）收件人被管理员删除，其他收件人的待发媒体就静默丢失；附件文件也会被提前删除。属于跨用户数据丢失 + 消息不可投递。
- **修复建议**：不要把共享附件的 `user_id` 绑定到收件人。`attachments.user_id` 只应由“上传者/入站消息所属用户”写入（本场景上传者管理端用户为 NULL，可保持 NULL）；`linkAttachmentOutbox` 只回填 `outbox_id`（或改为独立关联表 `outbox_attachments` 支持多对多）；`deleteUserCascade` 删除文件前检查是否仍有其他未完成 outbox 引用 `media_id`（`SELECT 1 FROM outbox WHERE media_id=? AND status IN ('queued','sending')`），有引用则保留行与文件。同时为 `attachments.media_id` 语义补文档。工作量 **M**。

#### BA-04 优雅退出未等待异步 worker 在途任务就关闭 DB，导致重复微信投递/定时任务重复执行/运行日志丢失
- **严重度**：P2
- **类别**：正确性 / 生命周期 / 并发
- **位置**：`server/src/index.js:100-143`（退出顺序：HTTP → `dispatcher.stop()` → keepalive/appRules/scheduler 的同步 stop → monitor.stopAll → `closeDb()`）；`server/src/dispatcher.js:124-135`（`stop()` 只 `Promise.race` 等 **5 秒**，且 `processOne` 在途的 `ilink.sendMessage`/媒体上传不可中止）；`server/src/dispatcher.js:291-321`（媒体上传单次超时 60s、最多 3 次重试，可远超 5s）；`server/src/scheduler.js:561-614`（`tick` 是 async，`stop()` 只清 timer（639-649），不等待在途 tick）；`server/src/scheduler.js:527-542`（先写日志再更新 `next_run_at`，失败被 catch 吞掉）；`server/src/store.js:1702-1708`（重启时 `sending` 重置为 `queued`）
- **证据/说明**：若一条消息已实际被微信接收、但 `markOutboxSent` 尚未执行，DB 就被关闭：写入抛错 → 该 outbox 停留 `sending` → 下次启动被 `resetSendingToQueued` 重新入队 → **用户收到重复消息**。定时任务同理：HTTP 调用成功、消息已入 outbox，但 `markScheduledTaskRun` 因 DB 关闭失败 → 重启后 `next_run_at` 仍是旧值（daily 任务）→ 再执行一次 → **重复通知**；运行日志也会丢。`app-rules` 的 `stop()` 还会直接清空队列（`app-rules.js:1432-1440`，文档已声明丢弃），在途规则任务同样可能在关库后写日志失败。
- **影响**：非幂等的用户可见副作用（重复微信消息/重复定时通知）以及审计日志丢失，发生在每次容器重启（含 `POST /api/admin/system/restart`、部署升级）。
- **修复建议**：退出时按“停止接新 → **等待各 worker 的完整 loopPromise/在途任务全部 settle**（不设 5s 截断，外层保留 10s 兜底强制退出）→ 最后关 DB”的顺序；给 `ilink.sendMessage/sendMediaMessage` 增加 `abortSignal` 并在 `dispatcher.stop` 时中止在途请求（中止前不要 mark sent）；`scheduler.tick`/`appRules` 记录在途 Promise 并 `await Promise.allSettled`；`markScheduledTaskRun` 与 `insertScheduledTaskLog` 用单事务保证“日志+next_run_at”原子。如果确实无法等待，至少把 `closeDb` 放到最后并让 `mark*` 写失败时回退状态（例如 `sending` 不重置而标记 `unknown` 供人工核对）。工作量 **M**。

#### BA-05 入站媒体下载未复用 SSRF 防护，且默认跟随重定向
- **严重度**：P2
- **类别**：安全 / SSRF（纵深）
- **位置**：`server/src/media.js:245-258`（`downloadAndDecryptInbound`：优先使用上游给的 `media.full_url`，直接 `fetchBuffer(url)`）；`server/src/media.js:209-239`（`fetchBuffer` 使用全局 `fetch`，默认 `redirect:'follow'`，无协议/私网/重定向限制）
- **证据/说明**：`app-rules` 有完整的 SSRF 防护（BA-01），但入站媒体链路完全不经过 `validateTargetUrl`：`full_url` 来自 iLink 响应、`cdnBaseUrl` 来自运行配置；一旦上游/中间代理被篡改或配置被指向恶意服务，或 CDN 存在开放重定向，服务端就可能被引导访问内网（返回内容还会落盘并经 `GET /api/admin/media/:id` 读出，构成 SSRF 数据外带通道）。
- **影响**：安全纵深缺口；利用前提是上游可控/配置被改，故低于 BA-01，列 P2。
- **修复建议**：对 `full_url` 也走 `validateTargetUrl`（允许 iLink/CDN 域名白名单，或配置化 `MEDIA_ALLOWED_HOSTS`）；`fetchBuffer` 显式 `redirect:'manual'` 并限制跳数/同主机；限制协议为 https（mock 环境可配置放行 http）。工作量 **S/M**。

#### BA-06 Webhook `?token=` 的 API Key 会经错误日志原样落盘（与“日志自动脱敏”契约冲突）
- **严重度**：P2
- **类别**：安全 / 日志脱敏
- **位置**：`server/src/api.js:1877`（错误日志 `path: req.originalUrl`）；`server/src/api.js:1884-1890`（4xx 用 `log.debug`、未预期异常用 `log.error`，均带上述 `path`）；`server/src/auth.js:179-210`（Webhook 允许 `?token=`，认证通过后才做 Key 限流，超限抛 429）；`server/src/api.js:1626`（Webhook 路由）
- **证据/说明**：`logger` 只对**字段名**做敏感词替换（`logger.js:6,26-28`），`originalUrl` 里的查询串值不会被脱敏。只要使用 `POST /api/v1/webhook?token=<API_TOKEN>`（文档支持的兼容用法，`docs/API.md:257,268`），当请求被限流（429）或处理中抛未预期异常（500）时，**有效 API Token 会以明文写进 debug/error 日志**；`docs/ARCHITECTURE.md:255` 承诺“日志经 logger 自动脱敏”。
- **影响**：有权读日志的人（运维、日志平台）可拿到完整 API Token；日志常被外送/长期保留，属凭据泄漏面。
- **修复建议**：错误/访问日志统一使用 `sanitizeUrlForLog()`：把 `token/key/api_key/authorization` 等 query 参数值替换为 `[redacted]`；或更彻底——Webhook 路由在解析后立即把 `?token=` 从 `req.originalUrl`/日志字段剥离；同时在 logger 增加按值脱敏的 URL 模式。工作量 **S**。

#### BA-07 接口应用运行日志的 `request_preview` 未脱敏 URL 查询参数中的机密
- **严重度**：P2
- **类别**：安全 / 日志脱敏（文档违约）
- **位置**：`server/src/app-rules.js:1261-1275`（`redactUrlForLog`：**只处理 userinfo**，不处理 query）；`server/src/app-rules.js:1277-1292`（`makePreviews` 把 `requestPreview = method + redactUrlForLog(requestUrl)` 写入 DB）；`server/src/store.js:1032-1073`（运行日志查询接口原样返回 `requestPreview`）；`server/src/api.js:1328-1344`（管理端日志接口）
- **证据/说明**：`docs/API_RULES.md:173-174` 明确要求“日志预览需脱敏（含 token/secret/password/key 的字段替换为 `[redacted]`）”。实际只脱敏了 `paramsPreview` 的键名（`redactForLog`）和 userinfo；常见写法 `https://api.example.com/x?api_key=SECRET` 或 `?token={arg}` 会把**静态密钥或用户参数值**以明文长期写进 `app_rule_logs.request_preview`（DB + 备份），并在后台“运行日志”里展示；`requestUrl` 也会进 `app_rule_logs.request_preview`（`store.js:988-991` 截断 1000 字符）。
- **影响**：第三方 API 凭据泄露面（DB 备份、后台其他查看者、日志导出）；与安全文档承诺不一致。
- **修复建议**：`redactUrlForLog` 增加 query 参数名敏感词替换（复用 `REDACT_KEY_RE`），对 `searchParams` 逐项替换；对模板展开后的 URL 同样处理（在 `makePreviews` 内统一）；最好只存 origin+path，不存 query 值。工作量 **S**。

#### BA-08 高频轮询路径缺排序索引：对外入站长轮询/后台消息列表/概览统计全表扫描（已用 query plan 证实）
- **严重度**：P2
- **类别**：性能 / 数据库
- **位置**：`server/src/store.js:1913-1941`（`listInboundForApi`：`WHERE received_at > ? ORDER BY received_at ASC, id ASC LIMIT ?`）；`server/src/db.js:85-88`（`inbound_messages` 只有 `wechat_message_id` 唯一索引和 `(user_id, created_at)` 索引，**没有 `received_at` 索引**）；`server/src/api.js:1794-1822`（`?wait=` 长轮询每 500ms 重查，最长 30s）；`server/src/store.js:1970-2038`（后台 `listMessages` UNION ALL + 全局 `ORDER BY created_at DESC`）；`server/src/store.js:2090-2126`（overview 14 个 COUNT，部分全表扫描）；`docs/ARCHITECTURE.md:278`（后台 5s 轮询）
- **证据/说明**：对临时库执行 `EXPLAIN QUERY PLAN` 实测：
  - 入站 API 查询：`["SCAN i","USE TEMP B-TREE FOR ORDER BY"]`
  - 后台消息列表：`["CO-ROUTINE m","COMPOUND QUERY","LEFT-MOST SUBQUERY","SCAN i","UNION ALL","SCAN o","SCAN m","USE TEMP B-TREE FOR ORDER BY"]`
  - `messagesToday` 的 inbound 计数：`["SCAN inbound_messages"]`
  即每次对外增量拉取（外部系统按 `wait=25` 持续长轮询时约 **2 次/秒**）、每次后台消息页轮询、每次概览轮询都会全表扫描 + 临时排序，CPU/IO 随消息量线性增长并阻塞单线程事件循环。
- **影响**：消息量到 10 万级后，长轮询与后台页面会显著拖慢整机（同步 SQLite 查询阻塞全部 HTTP 与队列 worker），属于会随数据增长恶化的可用性风险。
- **修复建议**：`schema v11` 增加 `CREATE INDEX idx_inbound_received ON inbound_messages(received_at, id);`（生成列或直接两列都行，SQLite 支持复合索引，`id` 为 TEXT 可参与排序）；后台消息列表为入站/出站分别加分页索引或改成 keyset 分页（避免 UNION+全排序）；overview 统计改为单条聚合查询（`SUM(CASE WHEN ...)` 一次扫描）或缓存 5–10s；`listMessages` 增加 `received_at/created_at` 索引并限制时间范围。工作量 **M**。

#### BA-09 scheduler 直接依赖 app-rules 内部实现：双份“渲染请求 → HTTP → 解析 → 渲染回复”管线 + 配置来源混用
- **严重度**：P2
- **类别**：架构 / 模块边界 / 重复
- **位置**：`server/src/scheduler.js:15-21`（从 app-rules 导入 `parseResponse/renderReplyTemplate/renderRequestTemplate/requestExternal/truncate` 5 个“内部工具”）；`server/src/scheduler.js:317-367`（`parseScheduledTaskRow` 自行复制 `parseRuleRow` 的 header 解密/JSON 解析逻辑，见 `app-rules.js:118-172`）；`server/src/scheduler.js:429-497`（`executeScheduledTaskInternal` 重新实现一遍 `executeRuleHttp`（`app-rules.js:1100-1189`）的 URL/headers/body 渲染、超时合并、响应解析、模板渲染）；`server/src/scheduler.js:468-469`（调度器直接读 `config.appRules.maxResponseBytes` / `config.appRules.allowedHosts`）
- **证据/说明**：app-rules.js 顶部把自身定位为“接口应用”模块，却同时承载了通用 HTTP 客户端 + 模板引擎 + 响应解析；scheduler 为复用它们必须 import 一个业务模块，导致：①“接口应用”关闭（`APP_RULES_ENABLED=false`）时调度器仍依赖其代码与配置；②后台设置里“接口应用”的 `maxResponseBytes/allowedHosts` 悄悄支配“定时通知”的网络行为，配置来源不透明（与任务重点 6 的 config/settings 来源混乱一致）；③两处执行管线细节（超时、重试、错误文案、fallback）未来容易漂移。
- **影响**：模块职责泄漏、未来修改需要同步两处；配置语义不清；不影响当前功能正确性，故 P2。
- **修复建议**：抽 `shared/http-client.js`（`isPrivateIp/validateTargetUrl/requestExternal/readResponseBodyLimited/describeFetchError/pickDiagnosticHeaders`）、`shared/template.js`（`getByPath/tokenize/compile/render*`）、`shared/response.js`（`parseResponse/previewReplyTemplate`）、`shared/http-execute.js`（`renderRequest → requestExternal → parseResponse → renderReplyTemplate` 的通用管线，返回 `{status,text,parsed,replyText,error,requestUrl,headerNames}`）。app-rules 只保留 match/extract/去重/日志/队列，scheduler 只保留计划/目标/日志，两者都依赖 shared；为 shared 增加独立单测。工作量 **M**。

### 2.3 P3（低风险/一致性/可维护性）

#### BA-10 死代码与未使用导出（占 API 面但无调用方，也无测试）
- **位置/证据**（grep 全 src + tests 确认仅定义处出现）：
  - `server/src/ilink.js:466` `getConfig`、`server/src/ilink.js:478` `sendTyping`
  - `server/src/store.js:230` `touchPoll`、`server/src/store.js:276` `setUserActive`、`server/src/store.js:1077` `getAppRuleLastMatchedAt`、`server/src/store.js:1088` `countAppRuleLogsLastHour`（后两者是已删除的规则冷却/小时配额功能残留，与 `app-rules.js:1330-1331` 注释一致）
  - `server/src/monitor.js:117` `listRunning`、`server/src/dispatcher.js:383` `getState`、`server/src/settings.js:756` `getSettingsSchema`、`server/src/app-rules.js:328` `buildBuiltinVars`、`server/src/app-rules.js:1468` `getEngineState`
  - `server/src/settings.js:15` 导入了 `timingSafeEqualStr` 但整个文件未使用（多余 import）
- **影响**：增加阅读负担、误导调用方；`touchPoll` 未使用还导致 `last_poll_at` 语义漂移（见 BA-17）。
- **建议**：删除或标注 `@internal`；`settings.js` 去掉未使用 import。工作量 **S**。

#### BA-11 `skipped` 日志状态/统计是死状态，API 过滤器与 stats 永不产生该值
- **位置**：`server/src/api.js:532`（`APP_RULE_LOG_STATUSES` 含 `skipped`）、`server/src/api.js:1332-1333`（允许按 skipped 过滤）；`server/src/store.js:766,779,829`（`skipped24h` 统计恒 0）；`server/src/app-rules.js:1301`（注释写“终态（skipped/failed/success）”，但引擎只写 `matched/success/failed`，见 1332-1373）；`server/src/api.js:768`（定时任务状态集合也含 `skipped`，scheduler 从不写 skipped）
- **证据**：全 src grep `skipped` 只有枚举/统计/注释，没有 `status: 'skipped'` 写入点。文档 `docs/API.md:616` 仍暴露 `skipped24h`。
- **影响**：契约字段永远为 0、过滤器永远空结果，属误导；不造成故障。
- **建议**：要么实现 skipped（例如“不请求模式缺失必填参数”/“目标为空”），要么从 API/RuleView/文档与代码枚举中移除。工作量 **S**。

#### BA-12 `restartRequired` 标注与实现不一致，且部分派生常量在模块加载时冻结
- **位置/证据**：
  - `server/src/settings.js:31` `push.tickMs` 标 restartRequired，但 `dispatcher.js:149` 每次休眠实时读取 → 实际即时生效。
  - `server/src/settings.js:33` `push.apiRateLimitPerMinute` 标 restartRequired，但 `auth.js:33-35` 的 `syncApiKeyLimiter()` 在 `auth.js:187` 每请求调用 → 实际即时生效。
  - `server/src/settings.js:121-133` ilink 全组标 restartRequired，但 `ilink.js:40-42,52-65,112-114` 等在请求时实时读取 config → 新请求即生效（仅已建立的绑定会话 `apiBaseUrl` 不会变）。
  - `server/src/binding.js:44-46` `QR_VALIDITY_MS`/`RETENTION_MS` 在模块加载时由 `config.binding.ttlMs` 冻结，而 `binding.js:258` 的 `expiresAt` 用实时值；修改 `binding.ttlMs` 后“会话 TTL 已变、二维码有效期/保留期不变”。
  - `server/src/settings.js:114-115` 声称 security 字段“即时（登录时读取）”，属实；但前端/文档据此显示“需重启”，与实际不符。
- **影响**：后台“保存后需重启”的提示误导运维；TTL 不一致属于小范围行为割裂。
- **建议**：逐字段核对后修正 `restartRequired` 标记（能实时读取的去掉标记、确需重启的加标记），绑定相关派生值改为调用时计算或在 hook 中重算。工作量 **S**。

#### BA-13 PATCH 定时任务仅修改 `windowStart/windowEnd` 时不重算 `next_run_at`
- **位置**：`server/src/api.js:1401-1414`（`scheduleKeys = ['scheduleType','intervalMs','dailyTime']`，不含 window 字段；只有命中这些键或 enabled 变化才重算 `nextRunAt`）
- **证据/说明**：窗口只影响 interval 任务的下次执行位置；当前实现会在任务到期时由 `scheduler.tick`（`scheduler.js:571-587`）发现“到期时间不在窗口内”后推进到下一窗口开始，因此**不会错误执行窗口外任务**，但列表里 `nextRunAt` 在到期前是旧窗口下的值（最多显示失真 1 个周期）。
- **修复建议**：把 `windowStart/windowEnd` 加入 `scheduleKeys`，或在 `patch` 含窗口字段时重算；补一条 API 单测。工作量 **S**。

#### BA-14 “不请求模式”的跨字段校验依赖 patch 形状，更新场景可产出无回复规则
- **位置**：`server/src/api.js:699-747`（`request.mode=none` 时清空 URL/Header/Body 并在 `api.js:742-746` 校验“模板或兜底至少一个非空”；但该检查只有在**本次 patch 里带了 response**（或创建）时才执行）
- **证据/说明**：PATCH 只提交 `{"request":{"mode":"none"}}` 时，`patch.requestUrl === ''` 为 true，但 `body.response === undefined` 且 `requireAll=false` → 跳过 response 分支，不会执行 742-746 的检查；若该规则原有 `template/fallbackText` 均为空，会落库成“命中后即失败（empty reply）”的规则。
- **修复建议**：校验时合并 DB 现有值（`row.reply_template/fallback_text`）一起判断；补单测。工作量 **S**。

#### BA-15 `monitor.processMessages` 单条消息异常被 catch 吞掉，消息会永久丢失且无事件/指标
- **位置**：`server/src/monitor.js:332-334`（`catch { log.warn('保存入站消息失败（忽略该条）') }`），之后 `runLoop` 照常推进内存游标并最终持久化（`monitor.js:466-483`）
- **证据/说明**：`store.saveInbound` 抛错（如 SQLITE_BUSY 超过 busy_timeout、磁盘满）时该条消息既不落库、也不触发规则、也不重试；游标继续前进后重启也不会再拉取该消息。
- **修复建议**：可重试错误（BUSY/IO）应暂停推进游标并在下一轮重试，或把失败消息写入 dead-letter 表 + `events`；至少增加 `events(type='inbound_save_failed')` 与计数指标。工作量 **S/M**。

#### BA-16 视图映射层 N+1（规则 stats/names、定时任务 targets names、用户列表子查询）
- **位置/证据**：
  - `server/src/store.js:752-760` `resolveScopeNames` 对每个 scope id 各查一次 `groups/users`；`store.js:784-833` + `store.js:763-781` `mapAppRuleRow` 每规则调用 `getAppRuleStats`（2 条 SQL）；`GET /api/admin/app-rules` 默认 `includeStats=true`（`api.js:1269-1272`）→ 50 条规则约 150 次 SQL/次页面轮询。
  - `server/src/store.js:1120-1123` `resolveScheduledTargetNames` 每个 target id 一次查询（`store.js:1144-1150`）。
  - `server/src/store.js:391-402` `listUsers` 每行 3 个相关子查询（有 `idx_outbox_user` 兜底，但在 500 行页面上仍有 ~1500 次索引探查）。
- **影响**：规则/任务数量多时后台页面变慢；当前规模可接受，故 P3。
- **建议**：批量 `IN` 查询后内存映射；规则 stats 用一条 `GROUP BY rule_id` 聚合 + 一条 `MAX(id)` 查询；target/scope names 复用批量映射。工作量 **S/M**。

#### BA-17 时区/时间契约不一致：概览“今日”用进程本地时区，调度用 `SCHEDULER_TIMEZONE`；`last_poll_at` 实际很少更新
- **位置**：`server/src/store.js:2091-2093`（`new Date(now); setHours(0,0,0,0)` 使用进程时区计算“今天”）；`server/src/config.js:202` + `scheduler.js:105-119`（调度按 `SCHEDULER_TIMEZONE`，默认 Asia/Shanghai）。若容器未设 `TZ`（`node:24-alpine` 默认 UTC），`messagesToday` 会在北京时间 08:00 才“换天”，与文档 `docs/API.md:130` 的“今日”语义不一致。
- `docs/ARCHITECTURE.md:214` 声称每条消息更新 `last_poll_at`；实际 `touchPoll` 是死代码（BA-10），`last_poll_at` 只在游标落库时由 `updateGetUpdatesBuf`（`store.js:224-227`）顺带更新，最长可滞后 6 小时（`monitor.js:22-25,350-364`）。
- **影响**：统计口径与可观测性字段不准确，不造成功能故障。
- **建议**：统一用 `config.scheduler.timezone`（或新增 `STORE_TIMEZONE`）计算“今日”；如果确有需要，文档注明“今日”时区；恢复 `last_poll_at` 的每轮更新（单独轻量 UPDATE，避免与游标落库耦合）。工作量 **S**。

#### BA-18 无外键约束 + 无数据保留策略：孤儿行与表无限增长
- **位置**：`server/src/db.js:54-239` 所有表均无 `REFERENCES`（尽管 `db.js:277` 开启 `PRAGMA foreign_keys = ON`）；`server/src/store.js:2069-2078` `addEvent` 每次登录/绑定/设置都写一行；`outbox/inbound_messages/attachments/events` 除删除用户级联（`store.js:284-344`）外无任何清理任务
- **证据/说明**：删除用户时手动清理部分表，但 `deleteAppRule`/`deleteScheduledTask` 保留日志（文档声明的审计保留，合理）；登录失败、规则运行、定时运行日志会长期累积；`attachments` 中上传后未入队、或入队前失败的文件/行成为孤儿（`media.saveMediaBuffer` 先写文件、`store.createAttachment` 后写库，`api.js:218-230`）。
- **影响**：磁盘/DB 长期增长，孤儿文件不可见；单进程 SQLite 下会逐渐拖慢查询。
- **建议**：补外键（`outbox.user_id`、`attachments.user_id/outbox_id`、`app_rule_logs.rule_id` 等）与 `ON DELETE` 策略；增加保留策略（如 events/logs 保留 N 天，可配置）；上传失败回滚删除文件；提供 `VACUUM`/清理脚本或定时任务。工作量 **M**。

#### BA-19 绑定成功路径不检查 `monitor.start()` 结果；`binded_redirect` 不刷新旧凭证
- **位置**：`server/src/binding.js:529-531`（`confirmed` 分支 `monitor.start(session.userId)` 返回值被丢弃；若达到 `MONITOR_MAX_ACCOUNTS` 或用户 status/pause 校验失败会静默返回 false）；对比 `api.js:1162-1168` 的管理端 reconnect 会把 `monitorsRunning` 返回给用户
- **证据/说明**：`monitor.start` 在 `monitor.js:129-147` 有 5 个提前返回 false 的分支；绑定时无日志、无状态提示，用户“绑定成功”但收不到入站消息，直到重启/手动 reconnect。
- `binded_redirect` 分支（`binding.js:458-479`）只返回已有用户，不更新 bot_token/base_url；若原凭证已失效（-14 冷却），用户重复扫码仍拿不到新凭证。
- **影响**：小概率“绑定成功但不可用”的支持成本；不造成数据损失。
- **建议**：`monitor.start` 返回 false 时在 session 上追加告警字段/日志，或在 `confirmed` 后延迟重试并上报事件；`binded_redirect` 场景提示“如有异常请在后台重连/解绑后重扫”。工作量 **S**。

#### BA-20 对外发送接口与后台发送接口对“冷却中用户”语义不一致；`onlyBound` 参数语义误导
- **位置**：`server/src/api.js:320-326`（后台 `ensureSendableUser`：非 active 或 `pause_until>now` → 409）、`server/src/api.js:1100-1114`（后台发送）；而 `server/src/api.js:1697-1720`（v1 `/messages` 只过滤 `status !== 'active'`，**不检查 pause_until**）；`server/src/dispatcher.js:167-176`（冷却中用户的 queued 消息会被直接置 failed）
- **证据/说明**：v1 对冷却中用户返回 202 accepted，随后 dispatcher 永久 failed，调用方无法从响应里获知；后台接口则立即 409。两者契约不一致。
- `onlyBound`（`api.js:1640-1652` Webhook、`api.js:1736-1737` v1 broadcast）实际语义是“是否包含 -14 冷却用户”（`store.js:418-421` `includePaused`），不是“是否只包含已绑定用户”（unbound 始终被排除）。`docs/API.md:261` 只说“可选 onlyBound=false”，未定义。
- **影响**：调用方误判投递结果；语义命名误导。
- **建议**：v1 发送前对 paused 用户也返回 409/或在响应 `queued` 项中标注 `paused` 并给出 `unknownUserIds` 类似字段；`onlyBound` 重命名为 `includePaused`（或文档明确其真实含义并保持兼容别名）。工作量 **S**。

#### BA-21 契约/文档漂移合集（代码行为与文档描述不一致，均为 P3）
- `docs/ARCHITECTURE.md:409` 声称 e2e 覆盖“冷却”，但规则冷却/小时配额已移除（`app-rules.js:1330-1331`，`tests/e2e/app-rules.test.js:426` 明确测“旧冷却字段不再限流”）。
- `docs/API.md:106-107` 称“所有写接口要求 `X-Requested-With`”，但 `POST /api/admin/login`（`api.js:984-999`）未校验；实际影响仅为低价值登录 CSRF（攻击者已知管理员密码时无额外收益），但与文档不符。
- `docs/API.md:355` 称上传“400（文件名/MIME 非法）”，实际 `api.js:198-233` + `media.detectKind`（`media.js:121-131`）接受任意 MIME 并按 `file` 处理，仅文件名非法时 400。
- `docs/SETTINGS.md:125` 仍写“登录校验优先用 DB 哈希，否则回退 env/自动生成密码”，而代码已不读取 env 密码（`config.js:94-97`、`settings.js:533-567`），且同文档 `docs/SETTINGS.md:175` 已写“来源恒为 DB”。
- `docs/API.md:589,616` 暴露 `skipped` 状态/统计（与 BA-11 同源）。
- **建议**：随代码改动同步修订文档；或对已废弃字段保留兼容说明。工作量 **S**。

#### BA-22 长轮询请求在客户端断开后不中止；模板渲染先整段渲染再截断（CPU/内存放大）
- **位置**：`server/src/api.js:1808-1813`（`wait` 循环只检查时间，未监听 `req.on('close')`，客户端断开后仍会最多 30s、每 500ms 查询一次）；`server/src/app-rules.js:745-753`（`renderReplyTemplate` 完整渲染后才 `truncate`，`{{#each}}` 对 1MB 响应体的大数组会全量迭代）；`server/src/app-rules.js:906`（长轮询超时 35s 的 `getUpdates` 已用 AbortSignal，可作参考）
- **影响**：少量资源浪费；恶意/异常外部响应可造成单次规则执行的 CPU 放大（受 `maxResponseBytes=1MB` 与 worker 并发 2 限制，风险有限）。
- **建议**：长轮询监听 `req.on('close')` 并提前返回；模板渲染增加输出长度上限（达到 `maxTextLength` 即停止 `each`）。工作量 **S**。

#### BA-23 启动/退出类边缘：`restoreMonitors` 与 `runWorker` 的竞态窗口
- **位置**：`server/src/index.js:62-83`（`restoreMonitors` 在后台异步循环启动，最多 N×100ms；若此时收到 SIGTERM，`monitor.stopAll` 可能先于剩余账号 start 完成，随后循环继续 `monitor.start` 访问已关闭的 DB）；`server/src/index.js:197`（`void restoreMonitors()` 不等待，启动完成日志与实际监控恢复完成不同步）
- **证据/说明**：`monitor.start` 会读 `store.getUserRow`/`getUserSecrets`，关库后抛错会被 `restoreMonitors` 的 try/catch 捕获并 warn（`index.js:71-77`），不会崩溃，但会留下“退出过程中继续启动监控”的日志噪声，且恢复进度不可观测。
- **修复建议**：保存 `restoreMonitors` 的 Promise，退出时先 `await` 它（并让其内部检查 shuttingDown 标志提前退出）；启动日志在恢复完成后输出。工作量 **S**。

## 3. 代码结构优化建议

### 3.1 现状（度量与依赖方向）

| 文件 | 行数 | 导出 | 主要职责 | 问题 |
| --- | --- | --- | --- | --- |
| `api.js` | 1895 | 1 | HTTP 全部路由 + 校验 + 媒体 IO + 静态页 + 错误处理 | 69 个路由、`createApp()` 913–1895（983 行），admin/v1/webhook 三套表面 |
| `store.js` | 2126 | 107 | 全部领域的数据访问 + 视图映射 + 统计 | 9 个领域混在一个文件，映射/统计/O(N) 扫描混合 |
| `app-rules.js` | 1474 | 27 | 模板引擎 + SSRF HTTP 客户端 + 匹配/提取 + 规则引擎 + dry-run | 3 类互不相关的关注点耦合；被 scheduler 依赖 |
| `scheduler.js` | 670 | 24 | 计划计算 + 到期执行 + 启停 | 复制 app-rules 的执行管线；计划逻辑可独立 |
| `settings.js` | 758 | 14 | 字段元数据 + 校验 + 机密管理 + 运行时应用 | 4 类关注点；auth 反向依赖 settings |
| 其余 14 个文件 | 合计 ~3.8k | — | 协议/数据/调度/中间件 | 相对清晰 |

依赖方向总体是 DAG（无循环 import）：`config/logger/errors/crypto/rate-limiter/db` → `ilink/media` → `store` → 领域模块（`app-rules/scheduler/keepalive/dispatcher/monitor/settings/auth`）→ `binding` → `api` → `index`（组合根）。需要修正的 4 个方向异常：
1. `scheduler → app-rules`（领域互相依赖，应用 §3.2 的 shared 层解耦）；
2. `binding → dispatcher`（`binding.js:15,527` 仅为调用 `dispatcher.resetRateLimit`，应把发送限流器下沉为共享服务）；
3. `auth → settings`（`auth.js:16` 为读管理密码哈希而依赖整个运行配置/机密模块，应抽 `domain/settings/secrets.js` 或 `core/credentials.js`）；
4. `settings → store`（仅为 `addEvent`，可注入事件 sink，便于测试与解耦）。

### 3.2 目标目录结构（建议，不强制一次到位）

```
server/src/
  core/        config.js logger.js errors.js crypto.js rate-limiter.js db.js
  protocol/    ilink.js media.js
  data/        users.js groups.js outbox.js inbound.js attachments.js
               rules.js scheduled.js events.js stats.js
               mappers.js helpers.js          # toNumber/clampInt/parseJsonValue/likePattern/ID 生成
  shared/      http-client.js                   # SSRF + fetch 限制 + 重定向
               template.js response.js          # 模板引擎 / 响应解析
               http-execute.js                 # 渲染请求→HTTP→解析→渲染回复（app-rules 与 scheduler 共用）
               async.js                         # sleep(ms,{signal}) / Semaphore / withTimeout
  domain/
    binding.js monitor.js dispatcher.js keepalive.js
    app-rules/ index.js match.js extract.js engine.js
    scheduler/ index.js calc.js
    settings/  schema.js validate.js apply.js secrets.js
  http/        app.js middleware.js views.js validate.js
               routes/bind.js admin-auth.js admin-users.js admin-groups.js
                      admin-rules.js admin-scheduled.js admin-settings.js
                      admin-media.js admin-messages.js admin-system.js
                      v1-push.js v1-inbound.js v1-groups.js webhook.js
  index.js
```

预期效果：`app.js` 约 60–80 行（只装配顺序与中间件）；`api.js` 最大文件降到 300 行左右；`store.js` 按域拆到 150–350 行/文件；`app-rules.js` 引擎 < 400 行；scheduler 不再 import app-rules。

### 3.3 迁移步骤（每步可独立提交并跑测试）

1. **抽 shared 纯函数（无行为变更）**：把 `app-rules.js` 的 `isPrivateIp/validateTargetUrl/requestExternal/readResponseBodyLimited/describeFetchError/pickDiagnosticHeaders` 迁到 `shared/http-client.js`，模板引擎（`getByPath/tokenizeTemplate/compileTemplateAst/renderReplyTemplate/...`）迁到 `shared/template.js`，`parseResponse/previewReplyTemplate` 迁到 `shared/response.js`；在 `app-rules.js` 中 **re-export** 旧名称（`export * from ...`）保证现有测试/调用方零改动。验证：`npm run test:unit`。
2. **抽 `shared/http-execute.js` 并替换 scheduler 内部实现**：scheduler 只保留 `renderRequest → shared.httpExecute → 目标解析/入队`；同时给 scheduler 增加自己的 `scheduler.maxResponseBytes/allowedHosts`（缺省继承 appRules，文档注明），消除配置来源混用。验证：`backend-scheduler.test.js`、`backend-scheduled-window.test.js`、`backend-scheduled-api.test.js`、e2e `scheduled-tasks`。
3. **拆 store**：按 §3.2 建 `data/*`，先保留 `store.js` 为 barrel（`export * from './data/...'`），调用方不动；然后逐模块替换 import；`mappers.js` 集中视图转换（顺带修 BA-16 的批量查询）。验证：`backend-store`/`backend-groups-store`/`backend-scheduled-store`/`backend-keepalive-store`/`backend-media-store`。
4. **拆 api.js**：先抽 `http/middleware.js`（安全头/缓存/JSON/raw 解析/错误处理/404）、`http/views.js`（`userView/queuedItem/mediaView/groupView`）、`http/validate.js`（`requireJsonBody/requiredString/optionalString/parseLimit/parseOffset`、两个 patch builder）；再按 §3.2 逐组抽 Router（顺序：bind → admin-auth → admin-users/groups → admin-rules/scheduled → admin-settings/security/media/messages/system → v1-push/inbound/groups → webhook）；`createApp()` 只保留中间件顺序与 `app.use(router)`。验证：`backend-api`/`backend-groups-api`/`backend-app-rules-api`/`backend-scheduled-api`/`backend-settings-api`/`backend-media-api`/`backend-keepalive-api` + 相关 e2e。
5. **拆 settings/auth 方向**：抽 `domain/settings/secrets.js`（哈希记录/Token 加解密/bootstrap/rotate）与 `domain/settings/schema.js|validate.js|apply.js`；`auth.js` 改为只依赖 `secrets.js`；`settings` 通过注入 `addEvent` 解除对 store 的依赖。验证：`backend-settings*`、`backend-auth`、e2e `settings*`。
6. **拆 binding/dispatcher 方向**：把发送限流器（`TokenBucketLimiter` 实例 + `resetRateLimit`）下沉到 `core/rate-limiter.js` 或 `domain/send-limiter.js`，dispatcher 与 binding 都只依赖它；`monitor → app-rules` 的触发改为事件总线/回调注入（可选）。验证：`backend-binding`/`backend-rebind`/`backend-media-dispatcher`/e2e `bind-flow`/`push-flow`。
7. **收尾**：删除 barrel re-export、清理 BA-10 死代码、修正 BA-11/BA-12/BA-21 文档；在 CI 增加“import 图无环 + 单文件行数阈值（如 800 行）告警”。

### 3.4 风险与验证

- **风险 1：中间件顺序**（安全头 → no-store → /health → JSON parser → 路由 → static → 404 → error）。拆分 Router 时必须保持：媒体上传仍需绕过全局 JSON parser、static 必须在 404 前、错误处理器必须最后注册。建议为 `createApp()` 增加一组路由顺序的集成测试（现有 e2e 已覆盖大部分）。
- **风险 2：模块加载副作用**：`db.js` 在 import 时打开数据库、`config.js`/`settings.js` 在 import 时做 DEFAULTS 快照、`binding/dispatcher` 在 import 时创建限流器。拆模块时不能改变这些副作用的求值次数/顺序（尤其 `settings` 的 DEFAULTS 必须在 `loadOverrides()` 之前捕获）。建议把“打开 DB”“捕获默认值”改成显式 `init()`，由 `index.js` 组合根调用，长期更干净，但需同步修改测试的 import 约定。
- **风险 3：测试以黑盒为主**：`createApp()` 与模块导出是测试锚点，re-export 阶段必须保持原名；建议每步都跑全量 `npm test`（33s 量级，可接受）并对比 362 用例数不下降。
- **验证方式**：每步提交前 `node --check` 全部改动文件 + `npm run test:unit`；涉及 HTTP 的步骤追加对应 e2e；最终 `npm test`。可新增一个 `tests/unit/architecture.test.js` 做静态依赖方向断言（读取 import 语句，禁止 `domain/scheduler → domain/app-rules` 等）。

## 4. 亮点

1. **凭证与认证底座扎实**：bot_token/context_token 只以 AES-256-GCM 密文落库（`crypto.js:31-50`，`store.js:165-221`；唯一明文出口 `getUserSecrets` 有注释约束）；管理会话 HMAC-SHA256 签名 + HttpOnly/SameSite=Lax + 写接口 `X-Requested-With` 防 CSRF（`crypto.js:148-175`、`auth.js:103-156`）；API Key 先定长 SHA-256 再 `timingSafeEqual`（`crypto.js:76-80`、`auth.js:169-172`）；登录/API Key/IP 三处限流均可注入时钟、可单测（`rate-limiter.js`）。
2. **SSRF 设计整体认真**：协议与 userinfo 校验、IPv4/IPv6 私网/环回/链路本地/组播/保留段的较全覆盖、DNS 解析后拒绝、白名单放行、重定向逐跳复验 + 跨源禁止、流式响应大小限制、仅接受文本响应、诊断响应头白名单（`app-rules.js:844-1088`、`786-808`）。BA-01 只是在“校验到请求”的最后一公里缺 IP 固定，修掉即可。
3. **并发正确性细节到位**：单 dispatcher 顺序投递 + `markOutboxSending` 状态守卫（`store.js:1616-1620`）；media caption 用 `caption_sent_at` 防重发（`dispatcher.js:198-216`）；monitor 用“凭据代际”比较 token_enc 防止换绑后旧 worker 写脏数据（`monitor.js:382-404`）；规则执行用 `(rule_id, inbound_message_id)` 唯一索引做幂等去重（`db.js:184-186`、`app-rules.js:1332-1336`）；keepalive 在事务内“入队 + last_sent + event”原子完成（`keepalive.js:56-65`）。
4. **事务与数据层实现正确**：`node:sqlite` 同步事务 + SAVEPOINT 嵌套（`db.js:361-403`），所有 `transaction()` 调用点都是同步回调（无 async 跨事务）；WAL + busy_timeout + umask 077 + 启动时 chmod 收口（`db.js:271-322`）；语句缓存避免重复编译（`db.js:329-338`）；所有动态 SQL 字段名来自常量白名单、值全部参数化，未见注入点。
5. **配置热更新架构有想法**：`SETTINGS_SCHEMA` + DB `app_settings` + 启动 `loadOverrides()` + 运行时 hooks 依赖注入（`settings.js:24-170,352-377,573-610,692-753`；`index.js:155-193`），把“配置管理”与“引擎启停”解耦，避免循环 import；`envOnly` 带默认值快照与脱敏展示，设计成熟。
6. **契约与测试体系完备**：`docs/` 9 份文档 + 46 个测试文件 362 用例，错误响应格式统一（`errors.js:16-37,88-103`、`api.js:1849-1892`），错误码与 HTTP 状态映射清晰；日志为单行 JSON、按敏感键名自动脱敏（`logger.js:6,26-28`），容器 stdout 采集友好。

## 5. 附录：文件指标表

> 行数/导出数为 `node` 精确统计（导出含 `export function/class/const/let/var` 与 `export {}`）；测试文件为直接相关的主要测试（e2e 另有跨模块覆盖）。

| 文件 | 行数 | 导出数 | 职责 | 对应测试文件（主要） |
| --- | --- | --- | --- | --- |
| `server/src/api.js` | 1895 | 1 | Express 应用：全部 HTTP 路由、校验、媒体 IO、静态页、404/错误处理 | `unit/backend-api`、`backend-groups-api`、`backend-app-rules-api`、`backend-scheduled-api`、`backend-settings-api`、`backend-media-api`、`backend-keepalive-api`、`backend-keepalive-disabled`；`e2e/*` |
| `server/src/store.js` | 2126 | 107 | 全部领域数据访问、视图映射、统计 | `unit/backend-store`、`backend-groups-store`、`backend-scheduled-store`、`backend-keepalive-store`、`backend-media-store`、`backend-media-inbound`、`backend-groups-keepalive` |
| `server/src/app-rules.js` | 1474 | 27 | 规则匹配/提取/模板引擎/SSRF HTTP/响应解析/引擎/testRule | `unit/backend-app-rules-core`、`backend-app-rules-engine`、`backend-app-rules-api`；`e2e/app-rules` |
| `server/src/settings.js` | 758 | 14 | 运行配置 schema/校验/覆盖加载/机密管理/热更新 | `unit/backend-settings`、`backend-settings-api`、`backend-settings-security`；`e2e/settings*` |
| `server/src/scheduler.js` | 670 | 24 | 定时任务计划计算、tick 执行、启停、手动执行 | `unit/backend-scheduler`、`backend-scheduled-window`；`e2e/scheduled-tasks` |
| `server/src/binding.js` | 621 | 10 | 扫码绑定会话状态机（内存态）+ 换绑 upsert + 限流 | `unit/backend-binding`、`backend-rebind`；`e2e/bind-flow` |
| `server/src/monitor.js` | 538 | 11 | 每账号入站长轮询、消息落库、媒体下载、-14 冷却 | `unit/backend-monitor`、`backend-media-inbound`；`e2e/inbound-api`、`e2e/keepalive*` |
| `server/src/media.js` | 511 | 27 | 媒体 MIME/文件名、AES-128-ECB、CDN 上下行、存储与路径安全 | `unit/backend-media-*`；`e2e/media-flow` |
| `server/src/ilink.js` | 490 | 23 | iLink 协议客户端（请求头/无损 JSON/收发/回调生命周期） | `unit/backend-ilink`；`e2e/bind-flow`、`push-flow` |
| `server/src/keepalive.js` | 135 | 6 | 24h 会话保活扫描（候选→事务入队） | `unit/backend-keepalive-store`、`backend-keepalive-scheduler`、`backend-keepalive-api`、`backend-keepalive-disabled`；`e2e/keepalive*` |
| `server/src/dispatcher.js` | 389 | 8 | 出站队列 worker（限流/媒体 caption/重试/-14） | `unit/backend-media-dispatcher`、`backend-rebind`；`e2e/push-flow` |
| `server/src/db.js` | 432 | 13 | SQLite 初始化、schema、语句缓存、事务、时间/meta | `unit/backend-store`、`backend-schema-version` |
| `server/src/auth.js` | 219 | 21 | 管理会话/CSRF 中间件、API Key 鉴权与限流、登录限流 | `unit/backend-auth`、`backend-settings-security`；`e2e/lifecycle-auth` |
| `server/src/rate-limiter.js` | 204 | 2 | 令牌桶 / 滑动窗口限流器（可注入时钟） | `unit/backend-rate-limiter` |
| `server/src/crypto.js` | 175 | 12 | AES-256-GCM、HMAC 会话、token 哈希、scrypt 密码 | `unit/backend-auth`、`backend-store`（间接） |
| `server/src/config.js` | 241 | 6 | 环境变量/默认值/secret 加载（唯一配置入口） | `unit/lead-core.test.mjs`、`backend-test-secrets`（间接） |
| `server/src/errors.js` | 107 | 16 | AppError/ILinkError/错误码/错误响应转换 | `unit/backend-ilink`、`backend-app-rules-*`（间接） |
| `server/src/index.js` | 205 | 0 | 进程入口：启动顺序、监控恢复、优雅退出 | `e2e/lifecycle-auth`（子进程启动） |
| `server/src/logger.js` | 61 | 3 | 单行 JSON 日志 + 敏感键名脱敏 | 无直接单测（经各模块间接覆盖） |
| **合计** | **11,251** | **331** | — | 34 unit + 12 e2e，362 个顶层用例 |

### 附：动态验证命令摘要（可复现，不修改仓库）

- 共享附件问题：以临时 `DATA_DIR` 导入真实 `store`/`db`，`createAttachment` + 同一 `mediaId` 分别入队给 A/B 两个用户，`deleteUserCascade(A)` 后附件行消失、B 的 outbox 仍 `queued` 且 `attachments=0`。
- 查询计划：同临时库上
  - `EXPLAIN QUERY PLAN SELECT ... FROM inbound_messages WHERE received_at > ? ORDER BY received_at, id LIMIT 51` → `SCAN i; USE TEMP B-TREE FOR ORDER BY`
  - 后台消息 UNION 列表 → `SCAN i` / `SCAN o` / `SCAN m` + `USE TEMP B-TREE FOR ORDER BY`
  - `SELECT COUNT(*) FROM inbound_messages WHERE received_at >= ?` → `SCAN inbound_messages`
