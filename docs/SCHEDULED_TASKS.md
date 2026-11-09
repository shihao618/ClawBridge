# 定时通知（Scheduled Notifications）设计契约

> 本契约是管理后台「接口应用」页面的**定时通知 Tab**（与「规则列表」Tab 并列），不是独立菜单/页面。
> 需求：**定时访问外部接口 → 解析返回 → 把结果通过微信发送给全部/指定用户或分组**。
> 例如：每天 8:00 查天气并推送给「VIP 客户」分组；每 30 分钟拉取一次订单状态并通知相关用户。
> 与「接口应用 → 规则列表」互补：定时任务无需用户先发消息，按时间计划主动执行。

## 0. 范围与原则

- 任务由后台配置：名称、启用、计划（间隔 / 每日定时）、目标（全部用户 / 指定用户 / 指定分组）、
  请求（GET/POST、URL、Header、Body 模板）、响应解析（JSON 路径/文本）、Markdown 通知模板与兜底文案。
- 调度器在服务进程内定时扫描（默认每 15s），到点执行一次 → 渲染文本 → 入队 outbox（source=schedule）
  → 由现有发送队列按微信限流投递；不绕过限流。
- 默认时区 `Asia/Shanghai`（可配置）；间隔任务从「上次执行时间 + 间隔」计算下一次；
  每日任务在配置的 HH:mm 执行（错过则启动后立即补一次，然后按下次时间继续）。
- 单实例调度（与 keepalive 一致）；多副本部署需只让一个副本启用调度器。
- 默认不启用（无任务），配置后不影响现有功能；任务停用后不再执行。
- 注：创建任务时未传 `enabled` 则按契约写入 `false`（管理后台新建表单默认不勾选「启用」）；
  下表中的 `DEFAULT 1` 仅为 DDL 层兜底默认值，API/管理端创建都会显式写入 `enabled`。

## 1. 数据库 Schema（当前 v1）

```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,                       -- 'task_<uuid>'
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_type TEXT NOT NULL DEFAULT 'interval',   -- interval | daily
  interval_ms INTEGER NOT NULL DEFAULT 3600000,     -- interval：最小 60000，最大 30d
  daily_time TEXT NOT NULL DEFAULT '08:00',         -- daily：HH:mm（SCHEDULER_TIMEZONE）
  window_start TEXT NOT NULL DEFAULT '',            -- interval：每日生效时间段开始 HH:mm（空=不限）
  window_end TEXT NOT NULL DEFAULT '',              -- interval：每日生效时间段结束 HH:mm
  target_type TEXT NOT NULL DEFAULT 'users',        -- all | users | groups
  target_ids TEXT NOT NULL DEFAULT '[]',            -- JSON string[]
  per_user_mode INTEGER NOT NULL DEFAULT 0 CHECK (per_user_mode IN (0, 1)),  -- 按用户模式
  request_method TEXT NOT NULL DEFAULT 'GET',       -- GET | POST
  request_url TEXT NOT NULL,
  request_headers_enc TEXT,                         -- AES-256-GCM(JSON)
  request_body_template TEXT NOT NULL DEFAULT '',
  response_type TEXT NOT NULL DEFAULT 'json',       -- json | text
  response_path TEXT NOT NULL DEFAULT '',
  reply_template TEXT NOT NULL DEFAULT '',
  fallback_text TEXT NOT NULL DEFAULT '',
  timeout_ms INTEGER NOT NULL DEFAULT 8000,
  last_run_at INTEGER NOT NULL DEFAULT 0,
  last_status TEXT NOT NULL DEFAULT '' CHECK (last_status IN ('', 'success', 'failed', 'skipped', 'partial')),
  next_run_at INTEGER NOT NULL DEFAULT 0,           -- 调度器计算/维护
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_created ON scheduled_tasks(created_at DESC);

CREATE TABLE IF NOT EXISTS scheduled_task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL,                    -- success | failed | skipped | partial
  http_status INTEGER,
  latency_ms INTEGER,
  error TEXT NOT NULL DEFAULT '',
  response_preview TEXT NOT NULL DEFAULT '',
  reply_preview TEXT NOT NULL DEFAULT '',
  recipients_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_logs_task ON scheduled_task_logs(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_logs_created ON scheduled_task_logs(created_at DESC);
```

- `SCHEMA_VERSION = 1`；`CREATE TABLE IF NOT EXISTS` 幂等；旧版本 schema 启动直接拒绝，不提供迁移
  （升级/回滚实操见 [`docs/UPGRADE.md`](UPGRADE.md)）。

## 2. 配置（config.js：`config.scheduler`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SCHEDULER_ENABLED` | `true` | 调度器全局开关 |
| `SCHEDULER_TICK_MS` | `15000` | 扫描间隔 |
| `SCHEDULER_TIMEZONE` | `Asia/Shanghai` | 每日任务时区（IANA） |
| `SCHEDULER_MAX_RECIPIENTS` | `200` | 单次任务最多收件人数（超出截断并 warn） |
| `SCHEDULER_TIMEOUT_MS` | `8000` | 单次外部请求超时上限 |
| `SCHEDULER_MAX_RESPONSE_BYTES` | `0`（继承接口应用） | 定时任务独立的响应体大小上限；`0` = 继承 `appRules.maxResponseBytes` |
| `SCHEDULER_ALLOWED_HOSTS` | 空（继承接口应用） | 定时任务独立的私网白名单（逗号分隔）；空 = 继承 `appRules.allowedHosts` |
| `SCHEDULER_PER_USER_CONCURRENCY` | `2`（范围 1-10） | 按用户模式并发请求数 |
| `SCHEDULER_PER_USER_MAX_RECIPIENTS` | `50`（范围 1-200） | 按用户模式单任务最多目标用户数 |

`config.scheduler = { enabled, tickMs, timezone, maxRecipients, timeoutMs, maxResponseBytes, allowedHosts,
perUserConcurrency, perUserMaxRecipients }`。

> 定时通知与接口应用共用同一套 HTTP 执行管线（`server/src/shared/http-execute.js`），但
> **响应上限与私网白名单可以在「运行配置 → 定时通知」独立设置**：留空/0 时继承「接口应用」配置
> （保持既有行为），设置后仅影响定时通知，两者互不覆盖。所有字段后台修改即时生效。

## 3. 计划计算

- **interval**：首次创建（next_run_at=0）时，next = now + interval_ms；执行后 next = 本次执行开始时间 + interval_ms。
  服务重启后若 next_run_at 已过期 ≤5 分钟内则补跑一次；超过则顺延到下一个周期（避免重启后大量积压任务同时爆发）。
- **interval + 每日生效时间段（可选）**：`windowStart`/`windowEnd`（HH:mm，成对、可空，支持跨午夜，如 22:00–06:00）。
  任务只在每天该时间段 `[start, end]` 内执行，next_run_at 必须落在窗口内：
  - now 在窗口内 → next = now + interval（若超过 end → 下一个窗口 start）；
  - now 早于窗口 start → next = 当天窗口 start；now 晚于窗口 end → 下一个窗口 start；
  - 执行后 candidate = 执行开始 + interval，若不在窗口内 → candidate 之后的下一个窗口 start；
  - 启动对账时窗口外 next 会被修正；daily 计划不支持 window 字段。
- **daily**：按 `SCHEDULER_TIMEZONE` 的 HH:mm 计算下一次；当前时间已过今天的 HH:mm → 明天 HH:mm；
  创建时若今天该时间已过 → 明天；服务启动时若 next_run_at 已过期 → 立即补跑一次，然后计算下一次。
- 每 tick 取 `enabled=1 AND next_run_at<=now` 的任务，按 next_run_at 升序、最多 10 个；
  单任务执行失败不影响其他任务；执行完写回 last_run_at/last_status/next_run_at。
- 计算 daily 时使用 `Intl.DateTimeFormat(timeZone)` 获取本地时间，避免依赖容器 TZ。

## 4. 执行流程

> 说明：定时通知**不显示**微信「正在输入」状态（该能力仅用于接口应用规则处理期间，属有意差异，
> 见 [`docs/PROTOCOL.md`](PROTOCOL.md) §8）。

1. 读取任务（Header 解密）→ 渲染 URL/Body 模板（内置变量：`{now}`、`{date}`、`{time}`、`{taskName}`）。
2. 调用外部接口（复用 app-rules 的 SSRF 防护/超时/大小限制/重定向复验；默认拒绝内网）。
3. 非 2xx / 超时 / JSON 解析失败 / 模板渲染为空 → `failed`：
   - 若 `fallback_text` 非空：把它作为通知内容发送给全部目标（避免用户完全收不到）；
   - 否则本次不发送。
4. 成功：`success`，按通知模板渲染文本（`{{path}}`/`{{response}}`/`{{raw}}`）。
   - **不回复（静默）**：模板输出 `{{noreply}}`（常用于条件分支的空数据分支，如
     `{{#if rows}}有数据{{else}}{{noreply}}{{/if}}`）时，本次**不发送任何消息、也不使用兜底文案**；
     日志记为 `success`、`replyPreview` 标注「不回复，未使用兜底」，不写 outbox。适合"没有数据就不打扰"的场景。
   - **模板根**：`response.path` 选中节点后，模板根即该节点，路径直接相对它写；空路径才用完整响应对象。
     例：`response.path="data.list"` → `{{count .}}` / `{{#each .}}{{字段}}{{/each}}`；
     **路径配置了但未命中**（如响应外层多一层 `ok/data`）时模板根为空、不回退完整响应对象，
     `{{#if .}}` 会进入空数据分支；需要完整响应时用 `{{@responseRoot.字段}}`。
     模板只按模板根/当前循环上下文查找路径。
   - **列表/多层循环**：`{{count . where 字段=值}}`、`{{#each . where 字段=值}}...{{/each}}`；
     `each` 可嵌套多层，内层用 `{{../字段}}` 取父级、`{{../@index}}`/`{{../@number}}` 取父循环、
     `{{@root.字段}}` 取模板根、`{{@responseRoot.字段}}` 取完整响应根（可访问选中节点的兄弟字段）；
     `@index` 从 0、`@number` 从 1。若同时需要 pageSize 与 rows，推荐把 `response.path` 选到共同父节点
     （如 `datas.cqztbg`），模板直接写 `{{pageSize}}` 与 `{{#each rows}}`。示例（`response.path=datas.rows`）：

   ```
   【未归寝】{{count . where CQZT=1}} 人
   {{#each . where CQZT=1}}{{@number}}. {{XSXM}}（{{FJH}} 房）
   {{/each}}【已归寝】{{count . where CQZT=2}} 人
   {{#each . where CQZT=2}}{{@number}}. {{XSXM}}（{{FJH}} 房）
   {{/each}}
   ```

   多层示例：`{{#each groups}}{{name}}{{#each members}}/{{../name}}-{{name}}{{/each}}{{/each}}`。
5. 目标收件人：
   - `target_type=users`：target_ids 中 `status=active` 的用户（unbound 跳过）；
   - `target_type=groups`：这些分组内 `status=active` 的用户（去重）；
   - 上限 `config.scheduler.maxRecipients`，按用户 id 稳定排序截断。
6. 对每个收件人 `store.enqueueMessage({userId, text, source:'schedule'})`；入队失败不影响其他人；
   写 `scheduled_task_logs`（状态/HTTP/耗时/错误/响应预览/回复预览/收件人数）。
7. 队列限流由既有 dispatcher 执行；任务执行本身不做额外发送重试。
8. 语义说明：
   - `POST /:id/run` 返回的 `status=success` 表示**外部接口调用成功且通知已入队 outbox**，
     实际微信送达由 dispatcher 异步完成，受每账号 7 条/5 分钟限流影响（可能在稍后完成或失败重试）。
   - **删除任务不级联删除历史运行日志**（保留审计记录；日志仍按 task_id 可查，任务名展示为空/任务 ID）。

### 4.1 按用户模式（`perUserMode=true`）

开启后任务**为每个目标用户分别请求并通知**（使用该用户自己的用户级凭据），适用于「每人用各自账号/密钥查询
自己的数据」的场景（如每人查自己的定位/门禁/订单）：

1. 展开目标用户（受 `perUserMaxRecipients` 默认 50 限制；`active` 去重、稳定排序截断）。
2. 对每个用户解析请求 URL/Header/Body 模板中的 `{credential:凭据名.字段}`（读该用户的 `user_secrets`）；
   **缺凭据的用户跳过**（写事件，明细只含 userId/缺失凭据名，不含值），不使用兜底文案。
3. 用「相同凭据字段值」把用户分组合并：**同一组只发起一次外部请求**，再按用户渲染通知模板
   （模板根附加 `userName`/`userId`；**数组根保持数组语义**，空数组时 `{{#if .}}` 为假，可正常配合
   `{{noreply}}` 静默，不会被按用户字段污染成对象后误发）。
   （模板可额外使用 `{{userName}}`/`{{userId}}`；`{{noreply}}` 对该用户不发送）。
4. 并发池 `perUserConcurrency`（默认 2，范围 1-10）执行请求组；单任务总超时 30s；
   单用户失败只影响该用户（按配置使用兜底文案，为空则不发送）。
5. 状态汇总：全部成功 `success`；部分成功/部分失败或部分跳过 `partial`；全部失败 `failed`。
   逐用户明细写 `events`（type 如 `scheduled_recipient_failed`，只含 userId/httpStatus/凭据名/错误，不含值）；
   `scheduled_task_logs` 记整任务状态、`recipients_count` 与脱敏预览。
6. 安全：凭据值在请求预览、错误、日志、事件中统一替换为 `***`（含 URL 编码形式）；
   汇总模式（`perUserMode=false`）的请求模板包含 `{credential:...}` 时**保存直接 400**（无法确定按谁解析）。

## 5. 管理端 API（Cookie + CSRF）

TaskView（GET）不返回 Header 值：

```json
{
  "id":"task_…","name":"每天天气推送","enabled":true,
  "schedule":{"type":"daily","intervalMs":3600000,"dailyTime":"08:00","windowStart":"","windowEnd":"","timezone":"Asia/Shanghai"},
  "targets":{"type":"groups","ids":["grp_…"],"names":["VIP客户"]},
  "perUserMode": false,
  "request":{"method":"GET","url":"https://api.example.com/weather?city=北京",
             "headerNames":["Authorization"],"bodyTemplate":""},
  "response":{"type":"json","path":"","template":"{{city}} 今天 {{weather}}，{{temp_min}}~{{temp_max}}℃","fallbackText":"天气获取失败"},
  "limits":{"timeoutMs":8000},
  "nextRunAt":0,"lastRunAt":0,"lastStatus":"",
  "createdAt":0,"updatedAt":0
}
```

```
GET    /api/admin/scheduled-tasks                    → { items:[TaskView] }
POST   /api/admin/scheduled-tasks                    → 201 { task }
POST   /api/admin/scheduled-tasks/{id}/duplicate     → 201 { task }（副本默认停用、next_run_at=0）
GET    /api/admin/scheduled-tasks/{id}               → { task }
PATCH  /api/admin/scheduled-tasks/{id}               → { task }
DELETE /api/admin/scheduled-tasks/{id}               → 204
POST   /api/admin/scheduled-tasks/{id}/test          → 200（dry-run：真实调用接口、渲染通知，不发送、不写运行日志）
POST   /api/admin/scheduled-tasks/{id}/run           → 200（手动执行一次：真实调用并发送、写日志，不改变 next_run_at）
GET    /api/admin/scheduled-task-logs?taskId=&status=&limit=&offset= → { total, items:[...] }
POST   /api/admin/template-preview                   → 200 { responseText, replyText, usedFallback, noreply }（示例响应离线预览；noreply=true 表示模板要求不回复）
```

创建/更新请求体：

```json
{
  "name":"每天天气推送","enabled":true,
  "schedule":{"type":"daily","dailyTime":"08:00"},
  "targets":{"type":"groups","ids":["grp_xxx"]},
  "perUserMode": false,
  "request":{"method":"GET","url":"https://api.example.com/weather?city=北京",
             "headers":{"Authorization":"Bearer xxx"},"bodyTemplate":""},
  "response":{"type":"json","path":"","template":"{{city}} 今天 {{weather}}","fallbackText":"天气获取失败"},
  "timeoutMs":8000
}
```

- 创建/更新校验：name 1..60；schedule.type ∈ interval/daily；interval_ms 60000..2592000000；
  daily_time 合法 HH:mm；windowStart/windowEnd 必须同时为空或同时填写、仅 interval、合法 HH:mm 且不相等；
  targets.type ∈ all/users/groups；all 时 ids 可为空，users/groups 时 ids 非空且存在；URL http(s)（创建时拒绝 userinfo）；
  headers 值加密（更新时不传=不变、{} 清空、传对象=全量替换；读取只回 headerNames）；
  timeoutMs 1000..30000；response.type json/text；
  `perUserMode` 布尔（默认 false）。**汇总模式的请求 URL/Header/Body 模板不允许包含 `{credential:...}`
  （无法确定按谁解析），否则 400；按用户模式允许。**
- `POST /:id/test` 返回：`{matched:true, request:{method,url,headerNames,bodyPreview}, httpStatus, latencyMs,
  responsePreview, replyText, recipientsCount, error, responseHeaders}`（响应头诊断同 app-rules test）。
- `POST /:id/run` 返回 `{status, httpStatus, latencyMs, recipientsCount, error}`，并写日志；
  **手动执行不更新 `next_run_at`**，不会改变后续定时计划。
- 日志项：`{id,taskId,taskName,status,httpStatus,latencyMs,error,responsePreview,replyPreview,recipientsCount,createdAt}`。

## 6. 前端（管理后台）

接口应用页面的第二个 Tab「定时通知」（与「规则列表」Tab 并列）：

1. 任务列表：启用开关、名称、计划摘要（每 N 分钟 / 每天 HH:mm（时区））、目标摘要（N 位用户 / N 个分组）、
   最近执行状态与时间、下次执行时间、操作（编辑 / 测试运行 / 立即执行 / 运行日志 / 删除）。
2. 新建/编辑表单：
   - 基本信息：名称、启用；
   - 计划：类型（间隔 / 每日定时）+ 间隔分钟或 HH:mm 时间；间隔可另选「每日生效时间段」（HH:mm–HH:mm，留空不限，支持跨午夜）；展示时区；
   - 目标：全部用户 / 指定用户 / 指定分组（指定用户/分组为复选框列表，带全选/清空）；
   - **按用户模式开关**（`perUserMode`）：说明「每个目标用户使用自己的凭据分别请求；缺凭据跳过、
     失败只影响该用户、目标上限/并发由运行配置控制、通知可用 `{{userName}}`/`{{userId}}`」；
   - 请求：方法 GET/POST、URL 模板、Header（保留/重设/清空，值加密不回显）、Body 模板（仅 POST 显示；GET 参数写在 URL）；
     按用户模式时可在 URL/Header/Body 写 `{credential:凭据名.字段}`（汇总模式填写会在保存时 400）；
   - 响应：类型 JSON/文本、JSON 路径、Markdown 通知模板（`{{path}}`/`{{response}}`/`{{raw}}`）、失败兜底文案；
   - 超时；
   - 表单校验与后端错误展示。
3. 「测试运行」弹窗：真实调用接口并展示实际请求（Header 只显示名称）、HTTP/耗时、响应预览、响应头诊断、
   **将发送的通知文本**、收件人数（明确注明不会发给用户）。
4. 「立即执行」：确认弹窗后调用 `POST /:id/run`，提示本次收件人数与发送结果；手动执行不改变下一次定时时间。
5. 运行日志：任务/状态筛选、分页，字段同 API。
6. 文档页新增「定时通知」章节（机制、计划/模板语法、SSRF/限流、API、curl 示例）。
7. 零构建/CSP/textContent/移动端不溢出；接口应用 Tab 布局保持现有风格。

## 7. 服务端模块与接入

- `server/src/scheduler/`：`calc.js`（计划计算 interval/daily/timezone/window）+ `index.js`（tick 扫描、执行任务、
  渲染通知、目标解析、入队、写日志、按用户模式并发池/合并请求、`start()/stop()` 幂等、依赖注入便于单测）。
- `server/src/scheduled.js`：任务 CRUD/视图（headerNames/perUserMode 映射）、到期任务查询、日志、目标用户解析。
- `server/src/shared/credentials.js` + `data/user-secrets.js`：按用户解析 `{credential:...}`、脱敏与
  `last_used_at` 更新（规则与定时按用户模式共用；见 `docs/ARCHITECTURE.md` §7）。
- `server/src/routes/admin-scheduled.js` + `http/scheduled-validators.js`：§5 接口 + 校验 + Header 加解密 +
  测试运行/立即执行 + 日志查询；汇总模式凭据占位符 400 校验。
- `server/src/index.js`：启动 `scheduler.start()`（`config.scheduler.enabled=false` 不启动）、
  优雅退出 `scheduler.stop()` 并等待在途 tick。
- 复用：`shared/**` 模板/响应/HTTP 管线；`crypto` 加解密；`logger`；`outbox` 发送完全复用 dispatcher。

## 8. 测试要求

**单元**
- 全新库 v1 建表/索引/幂等，非 v1 数据库拒绝启动；
- store：任务 CRUD/视图（headerNames 不含值、perUserMode 映射）、到期查询、日志、目标用户解析
  （all/users/groups、active 过滤、去重、上限）；
- scheduler：interval/daily/每日生效时间段时间计算（窗口内/前/后、跨午夜、启动对账、时区）、tick 只执行到期任务、
  成功渲染+入队 source=schedule、失败 fallback、无 fallback 不发送、收件人去重/上限、日志写入、
  start/stop 幂等、单任务异常不影响其他任务；
- 按用户模式：多用户各自请求、共享凭据值合并为一次请求、缺凭据跳过（事件不含值）、partial 状态、
  单用户失败隔离、`perUserMaxRecipients` 截断、`perUserConcurrency` 并发、`{{noreply}}` 单用户不发送；
- 凭据：`{credential:...}` 解析/渲染/缺失错误、日志与预览脱敏为 `***`、汇总模式占位符 400 校验；
- API：CRUD/校验（非 boolean、非法计划/目标/URL/perUserMode 400）、Header 加密不泄漏、test dry-run 不发送不写日志、
  run 真实入队并写日志（不改变 next_run_at）、日志过滤分页（含 partial）。

**e2e（本地 mock 外部 API + iLink mock）**
- 间隔任务最小 `intervalMs` 固定为 60000（60s，无测试专用放宽开关）；e2e 通过 `SCHEDULER_TICK_MS=200`
  缩短扫描间隔，并用 `POST /:id/run` 立即触发覆盖真实执行链路；调度到期计算由单测覆盖。
- 用 `POST /:id/run` 验证：外部 API 收到请求 → 解析 → 目标用户收到微信（mock 收到文本）→ outbox source=schedule →
  日志 success/recipients_count；失败（500/超时）→ fallback 发给目标；无 fallback 不发送；多用户/分组目标去重。
  停用任务调用 `POST /:id/run` 返回 **400**（禁止立即执行，需先启用）；`POST /:id/test`（dry-run）对停用任务仍可用。
- 调度自动触发：e2e 用 `SCHEDULER_TICK_MS=200` + 到期任务验证；自动执行的发送结果用 `POST /:id/run` 验证发送链路，
  单测覆盖到期计算。
- 按用户模式：mock 外部 API + 两个演示用户各配置不同凭据 → 各发对应请求/通知；缺凭据用户跳过；
  相同凭据值只请求一次（mock 计数）；任务日志状态 `partial`。

## 9. 真实环境上线

- 当前 schema v1；旧版本库启动直接拒绝，不提供迁移（升级/回滚实操见 [`docs/UPGRADE.md`](UPGRADE.md)）；
- 默认无任务；调度器启动日志；管理员按需创建任务（默认可先建一条 disabled 任务 + 测试运行验证，再启用）；
- 建议先「测试运行」确认接口与文案，再启用或立即执行；注意外部接口费用与微信 7 条/5 分钟限流。
- **访问内网接口**（如 `http://192.168.x.x:8000`）：SSRF 防护会默认拒绝私网/保留地址。可任选以下方式放行：
  - **定时通知独立白名单**：`SCHEDULER_ALLOWED_HOSTS`（空 = 继承「接口应用」白名单；逗号分隔），
    或在后台「运行配置 → 定时通知 → 内网/本机白名单」设置（即时生效）；
  - **接口应用白名单**：`APP_RULES_ALLOWED_HOSTS`（`.env` 仅首次默认值；也可在后台「运行配置 → 接口应用 → allowedHosts」
    修改，即时生效），`SCHEDULER_ALLOWED_HOSTS` 为空时继承；
  - 白名单只放行列出的主机，其他私网地址仍拒绝。
