## [1.1.2] - 2026-11-09

### 文档 / 文案修正

- 明确「定时通知」是管理后台「接口应用」页面的**第二个 Tab**（与「规则列表」并列），不是独立菜单/页面：
  - 修正 docs/SCHEDULED_TASKS.md 中「第三个 Tab」等误导表述；
  - docs/API_RULES.md、docs/ARCHITECTURE.md、docs/API.md、README、后台页面说明统一改为「接口应用 → 规则列表 / 接口应用 → 定时通知」；
  - README 截图说明、DOC 索引与相关交叉引用同步。
- 无 API/数据库 schema 变更（schema 仍 v1）。
## [1.1.1] - 2026-11-09

### 修复

- 用户凭据「新增/编辑」弹窗：凭据名称与备注的标签换行行数不同时，两个输入框没有对齐；
  改为等宽两列、底部对齐，并把名称/备注的格式要求移到弹窗说明文案，避免标签占两行。
# 更新日志（Changelog）

ClawBridge 采用自托管单仓库发布（Docker 镜像 + 源码），版本号以 `package.json` 为准。
本文件从 **1.0.0 全新基线**开始记录；更早的开发历史保留在 git 标签/历史中，不再写入本文件。

## [1.1.0] - 2026-11-09

### 官方协议对齐（对照官方插件 `@tencent-weixin/openclaw-weixin@2.4.10`）

- **请求头矩阵**：POST（含未鉴权的 `get_bot_qrcode`）恒带 `Content-Type`/`AuthorizationType=ilink_bot_token`/
  `X-WECHAT-UIN` + 公共头；GET（`get_qrcode_status`）只带公共头（`iLink-App-Id`/`ClientVersion` + 可选 `SKRouteTag`）。
- **`client_id`**：改为官方格式 `openclaw-weixin:<毫秒时间戳>-<8位hex>`。
- **`bot_agent`**：逐字移植官方 `sanitizeBotAgent`（多 product token、注释最长 64 字符、空白归一、
  256 字节逐 token 截断、空回退 `OpenClaw`）。
- **版本常量**：`clientVersion` 未显式设置 `ILINK_CLIENT_VERSION` 时由 `channelVersion` 自动派生
  （`(major<<16)|(minor<<8)|patch`，2.4.10→132106）；启动日志打印 channelVersion/clientVersion/appId。
- **轻量 API 超时**：`getconfig`/`sendtyping`/`notifystart`/`notifystop` 默认 **10s**（新 env
  `ILINK_CONFIG_TIMEOUT_MS`，默认 10000）；其它 API 保持 15s。
- **绑定轮询容错**：网络/网关错误（长轮询超时、5xx/524、fetch 失败、ECONN* 等）不再终止绑定会话，
  继续轮询到会话 TTL；`BINDING_NETWORK_ERROR_LIMIT` 改为连续网络错误告警阈值。
- **`-14` 自动恢复**：token 失效暂停 1h 后在 worker 内等待到期**自动继续轮询**（对齐官方 session-guard）；
  进程重启后冷却到期也会自动恢复监控，不再需要人工「重连」。
- **监控细节**：失败退避计数清零（2s→2s→30s→2s…）、`longpolling_timeout_ms` 合法值原样使用、
  `get_updates_buf` 每次变化即落库、`message_id` 顶层为空回退 `item_list[].msg_id`、
  `notifystart/notifystop` 返回 `ret!=0` 只告警。
- **入站正文**：按 `item_list` 顺序首个可识别项（TEXT / VOICE 转写 / 媒体占位 `[图片]`…，不带文件名）。
- **引用消息**：quote/partial_quote 最小解析（`ref_msg` 的 title/message_item/partial_text）并入
  `raw_json._quote`，不改变规则匹配正文。
- **`/echo 内容`**：入站指令直接回显（`source=slash`，不进入接口应用规则）；`/toggle-debug` 等不实现。
- **Markdown**：删除线由 supported 移到 filtered（过滤 `~~` 保留文字，`~~~` 围栏保留）；换行布局明确为
  ClawBridge 额外行为（官方不调整换行）。
- **媒体对齐**：入站白名单扩展 `*.qpic.cn`/`*.weixin.com`/`*.wx.qq.com`（保留逐跳校验与拒绝日志）；
  引用消息 `ref_msg.message_item` 媒体回退下载（标记 `referenced`）；voice 带 `text` 不下载；
  缺 `media`/`aes_key` 的 item 静默跳过；MIME 路由按官方（`.avi` 等→视频）；mock 增强。
- **发送失败用户提示**：outbox 永久失败（非 `-14` 暂停、非 `prepare failed`）时向该用户 best-effort
  发一次「⚠️ 消息发送失败，请稍后重试」（不进队列、不重试、每条一次）；新 env `PUSH_ERROR_NOTICE_ENABLED`
  （默认 true）+ 运行配置 `push.errorNoticeEnabled`（即时生效）。
- **HTTP 401**：仅响应体含 `ret/errcode=-14` 才按 token 失效暂停；401 但 body 非 -14 只 warn，
  按普通失败退避（避免网关 401 误冷却账号）。
- **`prepare failed`**：文档改为服务端实测语义（官方 2.4.10 源码无该特判）。

### 配置与文档

- `.env.example` 新增 `ILINK_CONFIG_TIMEOUT_MS`、`PUSH_ERROR_NOTICE_ENABLED`；`BINDING_NETWORK_ERROR_LIMIT`
  语义更新（告警阈值）。
- `docs/SETTINGS.md` 新增 `push.errorNoticeEnabled`（即时生效）、更新 binding.networkErrorLimit 语义；
  `docs/PROTOCOL.md` §3/§5/§8、`docs/MEDIA.md`、`docs/MARKDOWN_WECHAT.md`、`docs/ARCHITECTURE.md`、
  各规则/定时文档与 README 同步；README 新增「与官方插件 2.4.10 的兼容性」与差异汇总。

### 测试

- 官方差异对应单测/e2e 补齐（typing、绑定容错、监控恢复/退避、入站 quote//echo、媒体 ref_msg/白名单/
  voice-text、dispatcher 失败提示/401、markdown 删除线）。

## [1.0.5] - 2026-11-09

### 调整

- **「正在输入」参数完全对齐官方微信插件**：
  - `getconfig`/`sendtyping` 请求超时固定 **10s**（对齐官方 `DEFAULT_CONFIG_TIMEOUT_MS = 10_000`；
    删除原 3s 安全上限）。
  - `typing_ticket` 缓存 key 改为**按用户（userId）**（对齐官方 per-user，不再包含 baseUrl）；保留
    24 小时随机刷新、失败 2s 起指数退避（×2、最大 1h）、空 ticket 静默跳过。
  - **删除「最小可见时长约 500ms」与延迟取消**：`endTyping` 引用归零时**立即**发送
    `sendtyping status=2`（与官方 start/stop 语义一致，不再延迟取消）。
  - 保留：刷新间隔默认 5000ms（可配置、对齐官方 `keepaliveIntervalMs`）、`typingIndicator` 开关、
    内部引用计数（仅用于同一用户并发时避免相互取消）。
- 环境变量/运行配置字段名不变；无 API/数据库 schema 变更，可直接原地升级。

## [1.0.4] - 2026-11-09

### 调整

- **「正在输入」参数按官方微信插件对齐**（`@tencent-weixin/openclaw-weixin`）：
  - 续期（刷新）间隔默认 **5000ms（5s）**（对齐官方 `keepaliveIntervalMs: 5000`；范围 1000–30000，后台可改）。
  - `typing_ticket` 缓存由固定 10 分钟改为 **24 小时内随机刷新**（成功后 `nextFetchAt = now + random × 24h`）；
    获取失败从 **2s 起指数退避（×2，最大 1h）**；未到刷新时间复用缓存，缓存为空 ticket 时静默跳过
    `sendtyping`，旧 ticket 刷新失败时保留旧值；失败不阻塞规则。
  - `getconfig`/`sendtyping` 请求保留 **3s 安全上限**（官方默认 10s；为避免拖慢规则执行有意缩短，属差异说明）。
  - 保留「最小可见时长约 500ms」（内部固定值；官方无此概念，用于让直接回复规则也能看到状态）。
- 环境变量/运行配置字段名不变（`APP_RULE_TYPING_REFRESH_MS` 默认 5000、
  `appRules.typingRefreshMs` 默认 5000）；无 API/数据库 schema 变更，可直接原地升级。

## [1.0.3] - 2026-11-09

### 调整

- **「正在输入」扩展到所有规则命中**：此前仅在规则调用外部 HTTP 接口期间显示，现改为**所有命中规则**都显示
  （包括 `request.mode=none` 直接回复默认文本的规则——发送文字/入队同样需要时间）。
- **最小可见时长约 500ms**（内部固定值，非运行配置）：直接回复等短流程若不足约 500ms，会延迟取消
  （`sendtyping status=2`），避免用户看不到；延迟由内部定时器处理，**不阻塞规则执行与回复入队**；
  等待取消期间同一用户再次命中规则会复用会话，最终只取消一次。
- **取消时机**改为回复入队（或明确不回复）之后；长请求期间按 `APP_RULE_TYPING_REFRESH_MS`（默认 4000ms）
  持续刷新 `status=1`。
- 运行配置不变（`appRules.typingIndicator` / `appRules.typingRefreshMs`）；无 API/数据库 schema 变更，
  可直接原地升级。

## [1.0.2] - 2026-11-09

### 新增

- **「正在输入」状态（typing indicator）**：接口应用规则调用外部 HTTP 接口期间，向**触发用户**显示微信
  「正在输入」（`getconfig` 获取 `typing_ticket` → `sendtyping status=1`；请求结束——成功/失败/超时/
  `{{noreply}}`——发送 `status=2` 取消）。默认开启，可在后台「运行配置 → 接口应用」关闭；
  刷新间隔默认 4000ms（范围 1000–30000，`appRules.typingRefreshMs`）。
  **best-effort**：开关关闭/无 token/接口失败均静默跳过（仅 debug 日志），不影响规则执行；
  `typing_ticket` 内存缓存 10 分钟；日志不记录 ticket/token。仅外部 HTTP 请求模式（`request.url` 非空）显示。

### 配置

- `.env.example` 新增 `APP_RULE_TYPING_INDICATOR`（默认 `true`）与 `APP_RULE_TYPING_REFRESH_MS`
  （默认 `4000`，范围 1000–30000）。
- 无 API/数据库 schema 变更（schema 仍 v1），可直接原地升级。

## [1.0.1] - 2026-11-09

### 优化

- **管理后台所有示例/提示统一改为「查天气」场景**：模板语法帮助、条件判断示例、API 文档页中的回复模板示例全部换成天气数据，
  不再使用打卡/归寝/考勤等业务示例（如「不在打卡范围」）。
- 无 API/数据库 schema 变更（schema 仍 v1），可直接原地升级。

## [1.0.0] - 2026-11-09

### 全新数据基线（破坏性变更）

- **应用版本 1.0.0 / 数据库 schema v1**：数据库结构整体重写为全新基线，**不兼容任何旧数据卷**。
  启动时只接受「全新空库（自动建表）」或「当前 schema v1」；检测到其他数据库版本会直接拒绝启动，
  **不提供任何迁移/升级逻辑**。旧部署升级方式：备份旧数据卷 → 使用全新空数据卷 → 重新扫码绑定/配置。
- **无旧版本兼容包袱**：删除全部历史迁移代码、历史数据兼容分支与旧版文档记录；接口/字段/配置以本版本为准。

### 新功能

- **用户级命名凭据（user_secrets）**：为每个绑定用户保存「一条凭据含多个字段」的第三方密钥
  （如 `gps.token`、`weather.apiKey`）；值整体 AES-256-GCM 加密落库，**只写不读**——管理端只显示字段名与
  掩码提示（hints），接口不回显明文；新增管理 API：
  `GET/PUT/DELETE /api/admin/users/{id}/secrets[/{name}]`；用户删除时级联删除凭据。
- **凭据模板占位符 `{credential:名称.字段}`**：接口应用规则与定时通知的请求 URL / Header / Body 模板
  可按「触发用户（规则）」或「目标用户（定时按用户模式）」解析凭据并注入；缺失凭据时该次执行失败/跳过并
  记录明确的缺少项名称，日志、预览、错误与事件中的凭据值统一脱敏（不落明文）。
- **定时通知「按用户模式」**：任务可选 `perUserMode`——展开目标用户后逐用户解析其凭据、按用户渲染请求与
  通知模板（可用 `{{userName}}`/`{{userId}}` 等），相同凭据字段值自动合并为一次外部请求；缺凭据跳过并写
  事件、单用户失败只影响该用户；任务状态支持 `partial`（部分成功）。新增运行配置
  `scheduledTasks.perUserConcurrency` 与 `scheduledTasks.perUserMaxRecipients`（并发/目标上限）。
- **模板指令 `{{noreply}}`**：接口应用回复模板或定时通知回复中出现该指令时，**不发送任何消息**
  （不使用兜底文案），用于「只调用外部接口、不回复用户」的场景。
- **微信 Markdown 渲染增强**：消息文本按微信客户端 Markdown 语义做渲染预处理（段落/列表/代码块等，
  见 [`docs/MARKDOWN_WECHAT.md`](docs/MARKDOWN_WECHAT.md)），提升多行消息在微信中的显示效果。
- **可观测性**：新增只读指标 `GET /api/admin/metrics`（进程/监控/队列/媒体/规则与定时统计快照），
  `/api/admin/overview` 附带紧凑 `metrics` 摘要。
- **APP_SECRET 轮换工具**：`scripts/rotate-app-secret.mjs`（`npm run rotate-secret`）支持离线/停机把库内
  全部密文用旧密钥解密、新密钥重加密，含备份、dry-run、验证与回滚说明（见
  [`docs/ROTATE_APP_SECRET.md`](docs/ROTATE_APP_SECRET.md)）。

### 数据库与性能

- **schema v1 全新建表**：外键（`ON DELETE CASCADE/SET NULL`）、CHECK 约束、唯一/复合索引一次建好；
  新增 `user_secrets` 表与 `scheduled_tasks.per_user_mode` 字段；日志状态枚举支持 `partial`。
- **SQLite 调优**：WAL、`foreign_keys=ON`、`auto_vacuum=INCREMENTAL`、`journal_size_limit`、
  `temp_store=MEMORY`、会话级 `cache_size`；新增环境变量 `DB_SYNCHRONOUS`（`NORMAL` 默认 / `FULL` 更保守，
  写入更慢但断电安全性更高）。查询路径补齐索引（入站 `received_at`、规则日志去重等）。
- **数据维护**：`server/src/maintenance.js` 定时清理孤儿媒体文件/无文件附件行/超期未入队上传附件，
  并按保留期清理 events/规则日志/定时日志（`outbox`/`inbound_messages` 业务数据不自动删除）。

### 安全与隐私

- 凭证/密钥继续使用 AES-256-GCM 加密落库，管理密码 scrypt 哈希，API Token 密文 + 文件保存；
  用户凭据**只写不读**，管理端/接口/日志/预览均不回显明文（见 [`SECURITY.md`](SECURITY.md)、
  [`docs/PRIVACY.md`](docs/PRIVACY.md)）。
- 外部 HTTP 调用保持 SSRF 防护（连接层固定已校验 IP、重定向逐跳复验、私网默认拒绝）；
  入站媒体下载保持协议/主机白名单、流式解密与有界并发/排队上限。
- 日志继续对键名、URL query 与入站原始 JSON 中的敏感字段脱敏；凭据值在错误/事件/运行日志中统一替换为掩码。

### 工程化与文档

- 零构建前端（原生 ES Module）继续拆分维护：视图按需动态加载，公共 UI/模板/凭据对话框模块复用。
- 新增 `docs/PRIVACY.md`、`docs/ROTATE_APP_SECRET.md`、`docs/MARKDOWN_WECHAT.md`；文档体系（README +
  `docs/*.md`）按 1.0.0 基线整体重写，移除历史版本/历史审计记录。
- 质量门禁：ESLint（0 warning）、单元 + e2e 覆盖、mock 协议自测、真实浏览器冒烟、文档值级一致性
  `npm run doc:lint`、e2e 稳定性连跑；Docker 多架构镜像 + SBOM/provenance 发布。

### 升级 / 兼容性说明

- **旧数据不兼容**：任何非 schema v1 的旧数据卷均无法被 1.0.0 读取，也不存在迁移脚本/工具；
  请保留旧镜像+旧数据卷以便回滚，或在新数据卷上重新开始（重新扫码绑定/重建配置）。
- 部署方式与依赖不变：Node 24 + Express 5 + `node:sqlite`，生产依赖仅 `express`、`qrcode`；
  Docker/Compose 用法见 README，备份/全新部署/回滚步骤见 [`docs/UPGRADE.md`](docs/UPGRADE.md)。
