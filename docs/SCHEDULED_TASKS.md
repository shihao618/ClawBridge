# 定时通知（Scheduled Notifications）设计契约

> 需求：**定时访问外部接口 → 解析返回 → 把结果通过微信发送给指定用户/分组**。
> 例如：每天 8:00 查天气并推送给「VIP 客户」分组；每 30 分钟拉取一次订单状态并通知相关用户。
> 与「接口应用」（收到消息触发）互补：定时任务无需用户先发消息，按时间计划主动执行。

## 0. 范围与原则

- 任务由后台配置：名称、启用、计划（间隔 / 每日定时）、目标（指定用户/指定分组）、
  请求（GET/POST、URL、Header、Body 模板）、响应解析（JSON 路径/文本）、回复模板与兜底文案。
- 调度器在服务进程内定时扫描（默认每 15s），到点执行一次 → 渲染文本 → 入队 outbox（source=schedule）
  → 由现有发送队列按微信限流投递；不绕过限流。
- 默认时区 `Asia/Shanghai`（可配置）；间隔任务从「上次执行时间 + 间隔」计算下一次；
  每日任务在配置的 HH:mm 执行（错过则启动后立即补一次，然后按下次时间继续）。
- 单实例调度（与 keepalive 一致）；多副本部署需只让一个副本启用调度器。
- 默认不启用（无任务），配置后不影响现有功能；任务停用后不再执行。

## 1. 数据库 Schema v7（additive）

```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,                       -- 'task_<uuid>'
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_type TEXT NOT NULL DEFAULT 'interval',   -- interval | daily
  interval_ms INTEGER NOT NULL DEFAULT 3600000,     -- interval：最小 60000，最大 30d
  daily_time TEXT NOT NULL DEFAULT '08:00',         -- daily：HH:mm（SCHEDULER_TIMEZONE）
  target_type TEXT NOT NULL DEFAULT 'users',        -- users | groups
  target_ids TEXT NOT NULL DEFAULT '[]',            -- JSON string[]
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
  last_status TEXT NOT NULL DEFAULT '',             -- success | failed | skipped
  next_run_at INTEGER NOT NULL DEFAULT 0,           -- 调度器计算/维护
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS scheduled_task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,                    -- success | failed | skipped
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

- `SCHEMA_VERSION = 7`；`CREATE TABLE IF NOT EXISTS` 幂等；v1→v7 保留全部数据。
- 迁移测试：v6 数据库升级后数据保留、新表/索引存在、重复打开幂等。

## 2. 配置（config.js：`config.scheduler`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SCHEDULER_ENABLED` | `true` | 调度器全局开关 |
| `SCHEDULER_TICK_MS` | `15000` | 扫描间隔 |
| `SCHEDULER_TIMEZONE` | `Asia/Shanghai` | 每日任务时区（IANA） |
| `SCHEDULER_MAX_RECIPIENTS` | `200` | 单次任务最多收件人数（超出截断并 warn） |
| `SCHEDULER_TIMEOUT_MS` | `8000` | 单次外部请求超时上限 |

`config.scheduler = { enabled, tickMs, timezone, maxRecipients, timeoutMs }`。

## 3. 计划计算

- **interval**：首次创建（next_run_at=0）时，next = now + interval_ms；执行后 next = 本次执行开始时间 + interval_ms。
  服务重启后若 next_run_at 已过期 ≤5 分钟内则补跑一次；超过则顺延到下一个周期（避免重启后大量积压任务同时爆发）。
- **daily**：按 `SCHEDULER_TIMEZONE` 的 HH:mm 计算下一次；当前时间已过今天的 HH:mm → 明天 HH:mm；
  创建时若今天该时间已过 → 明天；服务启动时若 next_run_at 已过期 → 立即补跑一次，然后计算下一次。
- 每 tick 取 `enabled=1 AND next_run_at<=now` 的任务，按 next_run_at 升序、最多 10 个；
  单任务执行失败不影响其他任务；执行完写回 last_run_at/last_status/next_run_at。
- 计算 daily 时使用 `Intl.DateTimeFormat(timeZone)` 获取本地时间，避免依赖容器 TZ。

## 4. 执行流程

1. 读取任务（Header 解密）→ 渲染 URL/Body 模板（内置变量：`{now}`、`{date}`、`{time}`、`{taskName}`）。
2. 调用外部接口（复用 app-rules 的 SSRF 防护/超时/大小限制/重定向复验；默认拒绝内网）。
3. 非 2xx / 超时 / JSON 解析失败 / 模板渲染为空 → `failed`：
   - 若 `fallback_text` 非空：把它作为通知内容发送给全部目标（避免用户完全收不到）；
   - 否则本次不发送。
4. 成功：`success`，按通知模板渲染文本（`{{path}}`/`{{response}}`/`{{raw}}`；列表支持
   `{{count data.list}}` 与 `{{#each data.list}}{{字段}}{{/each}}`，内层可用 `{{@number}}`/`{{@index}}`，
   仅单层 each；支持 `where 字段=值`/`!=` 过滤）。示例（按归寝状态分组）：

   ```
   【未归寝】{{count data.data where CQZT=1}} 人
   {{#each data.data where CQZT=1}}{{@number}}. {{XSXM}}（{{FJH}} 房）
   {{/each}}【已归寝】{{count data.data where CQZT=2}} 人
   {{#each data.data where CQZT=2}}{{@number}}. {{XSXM}}（{{FJH}} 房）
   {{/each}}
   ```
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

## 5. 管理端 API（Cookie + CSRF）

TaskView（GET）不返回 Header 值：

```json
{
  "id":"task_…","name":"每天天气推送","enabled":true,
  "schedule":{"type":"daily","intervalMs":3600000,"dailyTime":"08:00","timezone":"Asia/Shanghai"},
  "targets":{"type":"groups","ids":["grp_…"],"names":["VIP客户"]},
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
GET    /api/admin/scheduled-tasks/{id}               → { task }
PATCH  /api/admin/scheduled-tasks/{id}               → { task }
DELETE /api/admin/scheduled-tasks/{id}               → 204
POST   /api/admin/scheduled-tasks/{id}/test          → 200（dry-run：真实调用接口、渲染通知，不发送、不写运行日志）
POST   /api/admin/scheduled-tasks/{id}/run           → 200（立即执行一次：真实调用并发送、写日志、更新 next_run_at）
GET    /api/admin/scheduled-task-logs?taskId=&status=&limit=&offset= → { total, items:[...] }
```

创建/更新请求体：

```json
{
  "name":"每天天气推送","enabled":true,
  "schedule":{"type":"daily","dailyTime":"08:00"},
  "targets":{"type":"groups","ids":["grp_xxx"]},
  "request":{"method":"GET","url":"https://api.example.com/weather?city=北京",
             "headers":{"Authorization":"Bearer xxx"},"bodyTemplate":""},
  "response":{"type":"json","path":"","template":"{{city}} 今天 {{weather}}","fallbackText":"天气获取失败"},
  "timeoutMs":8000
}
```

- 创建/更新校验：name 1..60；schedule.type ∈ interval/daily；interval_ms 60000..2592000000；
  daily_time 合法 HH:mm；targets.type ∈ users/groups，ids 非空且存在；URL http(s)（创建时拒绝 userinfo）；
  headers 值加密（更新时不传=不变、{} 清空、传对象=全量替换；读取只回 headerNames）；
  timeoutMs 1000..30000；response.type json/text。
- `POST /:id/test` 返回：`{matched:true, request:{method,url,headerNames,bodyPreview}, httpStatus, latencyMs,
  responsePreview, replyText, recipientsCount, error, responseHeaders}`（响应头诊断同 app-rules test）。
- `POST /:id/run` 返回 `{status, httpStatus, latencyMs, recipientsCount, error}`，并写日志、更新 next_run_at。
- 日志项：`{id,taskId,taskName,status,httpStatus,latencyMs,error,responsePreview,replyPreview,recipientsCount,createdAt}`。

## 6. 前端（管理后台）

接口应用页新增第三个 Tab「定时通知」：

1. 任务列表：启用开关、名称、计划摘要（每 N 分钟 / 每天 HH:mm（时区））、目标摘要（N 位用户 / N 个分组）、
   最近执行状态与时间、下次执行时间、操作（编辑 / 测试运行 / 立即执行 / 运行日志 / 删除）。
2. 新建/编辑表单：
   - 基本信息：名称、启用；
   - 计划：类型（间隔 / 每日定时）+ 间隔分钟或 HH:mm 时间；展示时区；
   - 目标：指定用户 / 指定分组（复选框列表，带全选/清空）；
   - 请求：方法 GET/POST、URL 模板、Header（保留/重设/清空，值加密不回显）、Body 模板（POST）；
   - 响应：类型 JSON/文本、JSON 路径、通知模板（`{{path}}`/`{{response}}`/`{{raw}}`）、失败兜底文案；
   - 超时；
   - 表单校验与后端错误展示。
3. 「测试运行」弹窗：真实调用接口并展示实际请求（Header 只显示名称）、HTTP/耗时、响应预览、响应头诊断、
   **将发送的通知文本**、收件人数（明确注明不会发给用户）。
4. 「立即执行」：确认弹窗后调用 `POST /:id/run`，提示本次收件人数与发送结果。
5. 运行日志：任务/状态筛选、分页，字段同 API。
6. 文档页新增「定时通知」章节（机制、计划/模板语法、SSRF/限流、API、curl 示例）。
7. 零构建/CSP/textContent/移动端不溢出；接口应用 Tab 布局保持现有风格。

## 7. 服务端模块与接入

- 新模块 `server/src/scheduler.js`：计划计算（interval/daily/timezone）、tick 扫描、执行任务、
  渲染通知、目标解析、入队、写日志、`start()/stop()` 幂等、依赖注入便于单测（now/fetch）。
- `store.js`：任务 CRUD/视图（headerNames 映射）、到期任务查询、日志、目标用户解析（复用分组/用户查询）。
- `api.js`：§5 接口 + 校验 + Header 加解密 + 测试运行/立即执行 + 日志查询。
- `index.js`：启动 `scheduler.start()`（`config.scheduler.enabled=false` 不启动）、优雅退出 `scheduler.stop()`。
- `db.js`：schema v7。
- 复用：`app-rules.js` 的 template/response/requestExternal 纯函数；`crypto` 加解密；`logger`；
  `outbox` 发送完全复用 dispatcher。

## 8. 测试要求

**单元**
- v6→v7 迁移（数据保留/新表/索引/幂等/全新库 v7）；
- store：任务 CRUD/视图（headerNames 不含值）、到期查询、日志、目标用户解析（users/groups、active 过滤、去重、上限）；
- scheduler：interval/daily 时间计算（含跨天、已过期补跑、时区）、tick 只执行到期任务、
  成功渲染+入队 source=schedule、失败 fallback、无 fallback 不发送、收件人去重/上限、日志写入、
  start/stop 幂等、单任务异常不影响其他任务；
- API：CRUD/校验（非 boolean、非法计划/目标/URL 400）、Header 加密不泄漏、test dry-run 不发送不写日志、
  run 真实入队并写日志/更新 next_run_at、日志过滤分页。

**e2e（本地 mock 外部 API + iLink mock）**
- 创建间隔任务（如 interval 1 分钟，测试用可注入更小 tick？调度器外部真实等待 → 用 `SCHEDULER_TICK_MS=200` 与
  测试可配置 interval 最小 60000，e2e 等 60s 太久 → 需要支持测试覆盖：允许 PATCH 后立即触发 `POST /:id/run` 来验证执行链路；
  以及调度器到期执行可用「创建任务 + 手动改数据库 next_run_at？e2e 不直接改 DB」。
  → 设计补充：`POST /:id/run` 覆盖真实执行链路；调度自动触发的 e2e 可用 `SCHEDULER_TIMEZONE`/tick 加“立即执行”替代。
  另外允许 interval 最小值在测试环境通过环境变量放宽？不建议。
- 用 `POST /:id/run` 验证：外部 API 收到请求 → 解析 → 目标用户收到微信（mock 收到文本）→ outbox source=schedule →
  日志 success/recipients_count；失败（500/超时）→ fallback 发给目标；无 fallback 不发送；多用户/分组目标去重；
  停用任务 run 返回 409/不执行？→ run 对停用任务返回 400（或允许手动执行？定义：disabled 任务不允许 run，返回 400）。
- 调度自动触发：创建 interval 任务后将 next_run_at 通过 `PATCH`? 不可改。可加测试专用环境 `SCHEDULER_TICK_MS=200` 
  且 interval 最小值支持在 `SCHEDULER_ALLOW_MIN_INTERVAL_MS` 配置？简单方案：e2e 使用「立即执行」验证发送链路 + 单测覆盖到期计算；
  自动触发用 `POST /:id/run` 模拟。QA 认可即可。

## 9. 真实环境上线

- v6→v7 additive migration（保留 2 个真实用户/消息/分组/保活/接口应用数据）；
- 默认无任务；调度器启动日志；管理员按需创建任务（默认可先建一条 disabled 任务 + 测试运行验证，再启用）；
- 建议先「测试运行」确认接口与文案，再启用或立即执行；注意外部接口费用与微信 7 条/5 分钟限流。
- **访问内网接口**（如 `http://192.168.x.x:8000`）：SSRF 防护会默认拒绝私网/保留地址；
  在 `.env` 增加 `APP_RULES_ALLOWED_HOSTS=192.168.88.10`（逗号分隔多个主机，仅添加需要的）
  并重启容器（`docker compose up -d`）后即可访问；该白名单只放行列出的主机，其他私网地址仍拒绝。
