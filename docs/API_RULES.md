# 接口应用（关键词触发 → 调外部接口 → 解析回微信）设计契约

> 需求：当收到**特定用户/分组**的微信消息且**包含关键词**时，调用配置的外部 HTTP 接口，
> 从消息中提取参数传给接口，解析接口返回并**回复给该微信用户**。
> 本契约按 MVP 范围（见 §10）执行；规则默认关闭，后台管理员按需配置。

## 0. 总体流程

```
monitor 收到入站消息并落库
  → app-rules 引擎（异步队列，不阻塞 getupdates）
     ├─ 规则启用？范围命中（全部/指定用户/指定分组）？
     ├─ 关键词/正则命中？冷却/小时限额未超？
     ├─ 按 priority 取第一条命中规则（一消息最多执行一条）
     ├─ 参数提取（none / multi；multi 内组合 trailing/regex/json/fulltext 提取项）
     ├─ 渲染请求模板（URL/Headers/Body）→ HTTP 调用（SSRF 防护/超时/大小限制）
     ├─ 解析响应（JSON 路径或纯文本）→ 渲染回复模板（或兜底文案）
     ├─ 写 app_rule_logs（状态/耗时/HTTP 码/错误/预览，脱敏）
     └─ 入队 outbox（source='rule'）→ 微信回复用户（复用限流/-2/-14/context_token）
```

规则**默认不启用**；全局开关 `APP_RULES_ENABLED=false` 时引擎不启动（后台仍可管理规则）。

## 1. 数据库 Schema v5（additive）

```sql
CREATE TABLE IF NOT EXISTS app_rules (
  id TEXT PRIMARY KEY,                       -- 'rule_<uuid>'
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,     -- 数字越小优先级越高；同优先级按 created_at 升序
  scope_type TEXT NOT NULL DEFAULT 'all',    -- all | users | groups
  scope_ids TEXT NOT NULL DEFAULT '[]',      -- JSON string[]：user id 或 group id
  match_mode TEXT NOT NULL DEFAULT 'contains', -- contains | equals | regex
  keywords TEXT NOT NULL DEFAULT '[]',       -- JSON string[]（contains/equals 用）
  regex_pattern TEXT NOT NULL DEFAULT '',    -- match_mode=regex 时使用
  extraction_mode TEXT NOT NULL DEFAULT 'multi',   -- none | multi
  extraction_config TEXT NOT NULL DEFAULT '{}',     -- JSON，见 §3
  request_method TEXT NOT NULL DEFAULT 'GET',       -- GET | POST
  request_url TEXT NOT NULL,
  request_headers_enc TEXT,                  -- AES-256-GCM 加密后的 JSON object（密钥不落明文）
  request_body_template TEXT NOT NULL DEFAULT '',
  response_type TEXT NOT NULL DEFAULT 'json',       -- json | text
  response_path TEXT NOT NULL DEFAULT '',           -- JSON 点路径，如 data.answer
  reply_template TEXT NOT NULL DEFAULT '',
  fallback_text TEXT NOT NULL DEFAULT '',
  timeout_ms INTEGER NOT NULL DEFAULT 8000,
  cooldown_ms INTEGER NOT NULL DEFAULT 10000,       -- 同用户同规则冷却
  max_calls_per_hour INTEGER NOT NULL DEFAULT 60,   -- 规则级小时上限
  max_user_calls_per_hour INTEGER NOT NULL DEFAULT 10, -- 同用户同规则小时上限
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_rules_enabled ON app_rules(enabled, priority, created_at);

CREATE TABLE IF NOT EXISTS app_rule_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  user_id TEXT,
  inbound_message_id TEXT,
  status TEXT NOT NULL,                      -- matched | success | failed | skipped
  http_status INTEGER,
  latency_ms INTEGER,
  error TEXT NOT NULL DEFAULT '',
  params_preview TEXT NOT NULL DEFAULT '',   -- 脱敏后的参数 JSON（截断）
  request_preview TEXT NOT NULL DEFAULT '',  -- 方法 + URL（密钥/敏感 header 不记录）
  response_preview TEXT NOT NULL DEFAULT '', -- 截断
  reply_outbox_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_rule_logs_dedupe
  ON app_rule_logs(rule_id, inbound_message_id)
  WHERE inbound_message_id IS NOT NULL AND inbound_message_id <> '';
CREATE INDEX IF NOT EXISTS idx_app_rule_logs_rule ON app_rule_logs(rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_rule_logs_created ON app_rule_logs(created_at DESC);
```

- `SCHEMA_VERSION = 5`；`CREATE TABLE IF NOT EXISTS` 幂等；v4→v5 保留全部既有数据。
- 去重索引保证同一条入站消息对同一规则最多执行一次（getupdates 重放安全）。
- 迁移测试：构造 v4 库（含用户/消息/附件/分组）→ v5 数据保留、新表/索引存在、重复打开幂等。

## 2. 配置（config.js：`config.appRules`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APP_RULES_ENABLED` | `true` | 规则引擎全局开关（false=不触发） |
| `APP_RULE_TIMEOUT_MS` | `8000` | 单次外部接口超时上限（规则可配更小） |
| `APP_RULE_MAX_RESPONSE_BYTES` | `1048576` | 响应体大小上限 |
| `APP_RULES_WORKER_CONCURRENCY` | `2` | 规则执行并发数 |
| `APP_RULES_ALLOWED_HOSTS` | 空 | **允许访问内网/本机的主机白名单**（逗号分隔；为空时只允许公网地址） |
| `APP_RULE_MAX_QUEUE` | `200` | 内存队列上限（超出丢弃并记日志） |

`config.appRules = { enabled, timeoutMs, maxResponseBytes, workerConcurrency, allowedHosts[], maxQueue }`。

## 3. 触发匹配与参数提取

**范围**：`scope_type=all` 全部用户；`users` → `scope_ids` 包含该 userId；`groups` → 该 userId 属于
`scope_ids` 中任一分组。范围不命中直接跳过（不写日志）。

**关键词**：
- `contains`：消息文本包含任一关键词（`keywords` 数组，大小写不敏感）；
- `equals`：消息文本 trim 后等于任一关键词；
- `regex`：`regex_pattern` 用 `u` flag 匹配；非法正则保存时拒绝。

**参数提取**（`extraction_mode` + `extraction_config`）：

| mode | config | 说明 |
| --- | --- | --- |
| `none` | `{}` | **不提取**：消息中不需要参数，直接按 URL/Header/Body 模板调用接口（模板仍可用内置变量）；不检查缺参 |
| `multi` | `{"extractors":[...],"required":["city"]}` | **多参数组合提取**（唯一提取模式）：按顺序执行多个提取项并合并参数，已覆盖原来的关键词后文本 / 正则 / JSON / 整句模式 |

> 后台「提取模式」下拉只保留 **不提取 / 多参数组合提取**；旧版单模式规则打开编辑时会自动转换为等价的多参数组合，保存后统一为 `multi`。

**多参数示例**（消息「查北京天气明天」）：

```json
{
  "mode": "multi",
  "config": {
    "extractors": [
      { "type": "regex", "regex": "^查(?<city>\\S+?)天气(?<date>.+)$" },
      { "type": "trailing", "keyword": "天气", "param": "note" },
      { "type": "fulltext", "param": "raw" }
    ],
    "required": ["city", "date"]
  }
}
```

- `extractors[].type`：`trailing`（可指定 `keyword`，默认用触发关键词）/ `regex`（命名组全部成为参数；无命名组时取第 1 个捕获组作为 `param`）/ `json`（`path` 取值，或按 `param` 取顶层字段，或合并全部顶层字段）/ `fulltext`；
- 参数按顺序合并，同名后者覆盖前者；参数名只能包含字母/数字/下划线（1-30 字符），供 URL 模板 `{参数名}` 使用；
- `required` 中的参数缺失时视为缺参（不会调用接口）；未配置 `required` 时至少提取到一个参数即可调用。

> `none` 模式适用于"固定 URL/固定参数"的接口（例如只做触发通知、查询固定数据）；
> 需要从消息中携带参数时使用 `multi`（组合提取）。

**内置变量**（两种提取模式下都可使用）：`{text}` 消息原文、`{arg}`（组合提取中 trailing/fulltext 的主参数）、
`{userId}`、`{name}`（微信显示名）、`{now}`（毫秒时间戳）。

**缺参处理**：提取后必需参数为空 → 不调用外部接口，回复 `fallback_text`（若配置），
日志 `status='failed'`、`error='missing params'`。

## 4. 请求模板与安全

- 请求方法 `GET` / `POST`；URL、Header 值、Body 支持 `{变量}` 占位（变量值会做 URL 编码用于 URL
  查询参数；Header/Body 中做原文替换并限制长度）。
- `request_body_template`：POST 时原样发送（支持 `{city}` 等）；GET 时忽略 body。
- Header 编辑：创建/更新时传 `requestHeaders` 对象（如 `{"Authorization":"Bearer xxx"}`），落库前
  `crypto.encryptSecret(JSON.stringify(obj))`；**读取接口只返回 `requestHeaderNames`（键名列表），
  不返回值**；更新时传空对象/不传表示不变，传 `{}` 表示清空？→ 约定：传 `requestHeaders` 即全量替换
  （`{}` 清空）；不传该字段保持不变。
- 安全限制（SSRF）：
  - 仅 `http/https`；**创建/更新时即拒绝** URL 带 userinfo（`user:pass@`），运行日志中的 URL 预览
    也会对 userinfo 脱敏；
  - 解析目标主机：域名 → `dns.lookup` 解析 IP；IP 字面量直接判断；
  - 默认拒绝私网/环回/链路本地/组播/保留地址（IPv4：10/8、172.16/12、192.168/16、127/8、
    169.254/16、0.0.0.0/8、100.64/10、192.0.0/24、192.0.2/24、198.18/15、198.51.100/24、
    203.0.113/24、224/4、240/4；IPv6：::1、::、fc00::/7、fe80::/10、ff00::/8、::ffff:0:0/96 等）；
  - 若主机名在 `APP_RULES_ALLOWED_HOSTS` 白名单中，允许私网（用于内网接口）；
  - Docker 内访问宿主机/内网：目标主机需加入白名单（`host.docker.internal` 或内网 IP）；目标服务必须监听
    非 loopback 地址（Docker Desktop 的 `host.docker.internal` 可访问宿主机已发布端口）；
  - POST 的 JSON body 未显式设置 `Content-Type` 时自动补 `application/json`；连接失败错误会保留
    `ECONNREFUSED` 等原因码并给出排查提示，不再只显示 `fetch failed`；
  - 重定向：最多 3 跳，每跳重新做 URL/IP 校验（不允许跳到未授权内网）；
  - 超时 `min(rule.timeoutMs, config.appRules.timeoutMs)`；响应体超过上限直接判失败；
  - 只接受文本响应（忽略二进制）；失败不重试（避免用户触发场景重复副作用）。
- 日志/接口响应不得包含完整 Header 值（如 Authorization）或请求 body 中的敏感值：日志预览需脱敏
  （含 token/secret/password/key 的字段替换为 `[redacted]`）。

## 5. 响应解析与回复

- `response_type=json`：按 `response_path`（点路径，支持 `a.b.0.c`）取值：
  - 路径为空：若解析对象含 `reply` 不空字符串 → 用它；否则用 `JSON.stringify(解析对象)`；
  - 取到的值：字符串直接使用；对象/数组 `JSON.stringify`。
- `response_type=text`：整个响应文本（trim、截断）。
- **模板根**：`response_path` 选中具体节点后，**模板根就是该节点**，模板无需重复路径；
  路径为空时模板根才是完整响应对象。
  - 例：`response_path="data.list"`，模板直接写 `{{count .}}` / `{{#each .}}{{字段}}{{/each}}`；
  - 空路径时才写 `{{data.list}}`；
  - 模板只按模板根/当前循环上下文查找路径，不再兼容旧版完整响应路径写法；需要访问完整响应根时用 `{{@responseRoot.字段}}`。
- 回复模板 `reply_template`：使用 `{{路径}}` 占位；内置 `{{response}}`=解析后的文本值、
  `{{raw}}`=原始响应文本；为空时直接用解析结果。
- **列表渲染**（数组数据一次性拼接）：`{{count 路径}}` 输出数组/对象长度；`{{#each 路径}}...{{/each}}`
  对内层逐项渲染，内层可用当前项字段 `{{字段}}`（当前项没有该字段时依次回退父级/根响应）、`{{@index}}`（从 0）、
  `{{@number}}`（从 1）。支持 `where 字段=值` / `where 字段!=值` 过滤（值可加引号）。
- **多层嵌套循环**：`each` 可嵌套多层（≤8 层）；内层用 `{{../字段}}` 取父级字段、
  `{{../@index}}`/`{{../@number}}` 取父循环下标/序号；`{{@root.字段}}` 取模板根（JSON 路径选中节点）；
  `{{@responseRoot.字段}}` 取完整响应根（可访问选中节点的兄弟字段，如 pageSize）。
- **同时需要 pageSize 与 rows**：推荐把 JSON 路径选到共同父节点（如 `datas.cqztbg`），模板直接写
  `{{pageSize}}` 与 `{{#each rows}}`；若路径仍选 `rows`，可用 `{{@responseRoot.datas.cqztbg.pageSize}}`。
  示例（路径已指向数组）：

  ```
  【未归寝】{{count . where CQZT=1}} 人
  {{#each . where CQZT=1}}{{@number}}. {{XSXM}}（{{FJH}} 房）
  {{/each}}【已归寝】{{count . where CQZT=2}} 人
  {{#each . where CQZT=2}}{{@number}}. {{XSXM}}（{{FJH}} 房）
  {{/each}}
  ```

  多层示例：`{{#each groups}}{{name}}{{#each members}}/{{../name}}-{{name}}{{/each}}{{/each}}`。
  长名单受单条文本 4000 字限制截断，建议只放必要字段。
- 回复长度按 `config.push.maxTextLength`（默认 4000）截断；空回复则使用 `fallback_text`。
- 入队 outbox 文本 `source='rule'`；回包失败（非 2xx/超时/解析失败）→ 若 `fallback_text` 非空则回复
  兜底文案，日志 `status='failed'` + 错误。
- 成功/失败均写 `app_rule_logs`；成功日志 `reply_outbox_id` 关联入队记录。

## 6. 限流与去重

- 同一入站消息对同一规则最多执行一次（DB 唯一索引，插入日志冲突视为重复跳过）。
- 同用户同规则冷却 `cooldown_ms`（默认 10s）：查询该规则+用户最近一次 `matched/success` 日志时间。
- 规则级 `max_calls_per_hour`、用户级 `max_user_calls_per_hour`：按最近 1h 日志数（成功+失败）计算；
  超限直接跳过（写 `skipped` 日志）。
- 队列并发 `workerConcurrency`，队列上限 `maxQueue`（满了丢弃并 warn 日志）。
- 一消息命中多条规则：按 `priority ASC, created_at ASC` **只取第一条**。
- 执行过程中日志先写 `status='matched'` 中间态（表示已匹配、请求进行中），完成后更新为
  `success`/`failed`，便于在运行日志中观测在途请求。

## 7. 管理端 API（Cookie + CSRF）

规则视图（GET）不返回 Header 值：

```json
{
  "id":"rule_…","name":"查天气","enabled":true,"priority":100,
  "scope":{"type":"groups","ids":["grp_…"],"names":["VIP客户"]},
  "trigger":{"matchMode":"contains","keywords":["查天气"],"regexPattern":""},
  "extraction":{"mode":"multi","config":{"extractors":[{"type":"trailing","param":"arg"}]}},
  "request":{"method":"GET","url":"https://api.example.com/weather?city={arg}",
             "headerNames":["Authorization"],"bodyTemplate":""},
  "response":{"type":"json","path":"data","template":"{{answer}}","fallbackText":"暂时无法查询"},
  "limits":{"timeoutMs":8000,"cooldownMs":10000,"maxCallsPerHour":60,"maxUserCallsPerHour":10},
  "stats":{"lastRunAt":0,"lastStatus":"","success24h":0,"failed24h":0,"skipped24h":0},
  "createdAt":0,"updatedAt":0
}
```

```
GET    /api/admin/app-rules?includeDisabled=1     → { items:[RuleView] }
POST   /api/admin/app-rules                        → 201 { rule }
GET    /api/admin/app-rules/{id}                   → { rule }
PATCH  /api/admin/app-rules/{id}                   → { rule }
DELETE /api/admin/app-rules/{id}                   → 204
POST   /api/admin/app-rules/{id}/test              → 200（dry-run，不发送不写运行日志）
  Body: {"message":"查天气 北京","userId":"u_…"(可选，用于范围匹配)}
  Resp: {"matched":true,"ruleId":"rule_…","params":{"arg":"北京"},
         "request":{"method":"GET","url":"…","headerNames":["Authorization"],"bodyPreview":""},
         "httpStatus":200,"latencyMs":123,"responsePreview":"…","replyText":"…","error":""}
GET    /api/admin/app-rule-logs?ruleId=&status=&userId=&limit=50&offset=0
  → { total, items:[{id,ruleId,ruleName,userId,status,httpStatus,latencyMs,error,
                      paramsPreview,requestPreview,responsePreview,replyOutboxId,createdAt}] }
```

创建/更新请求体（JSON）：

```json
{
  "name":"查天气","enabled":true,"priority":100,
  "scope":{"type":"groups","ids":["grp_xxx"]},
  "matchMode":"contains","keywords":["查天气"],"regexPattern":"",
  "extraction":{"mode":"multi","config":{"extractors":[{"type":"trailing","param":"arg"}]}},
  "request":{"method":"GET","url":"https://api.example.com/weather?city={arg}",
             "headers":{"Authorization":"Bearer xxx"},"bodyTemplate":""},
  "response":{"type":"json","path":"data","template":"{{answer}}","fallbackText":"暂时无法查询"},
  "timeoutMs":8000,"cooldownMs":10000,"maxCallsPerHour":60,"maxUserCallsPerHour":10
}
```

校验：name 1..60；scope.type ∈ all/users/groups（users/groups 时 ids 非空且存在）；matchMode 合法；
contains/equals 关键词 1..10 个、每个 1..50 字；regex 合法；extraction.mode/config 合法；
URL http(s) 合法；timeoutMs 1000..30000；cooldownMs 0..3600000；每小时上限 1..10000；
response.type ∈ json/text。错误 400/404/409（重名可选，本版允许重名）。

## 8. 前端（管理后台）

1. 新增「接口应用」区块/页面：规则列表（启用开关、名称、范围、关键词、请求方法/URL、最近运行状态、
   24h 成功/失败/跳过计数、操作：编辑/测试/日志/删除）；新建按钮。
2. 规则表单：基本信息（名称/启用/优先级）、触发范围（全部/指定用户多选/指定分组多选）、
   匹配（包含/全等/正则 + 关键词/正则）、参数提取（4 种模式 + 配置 + 实时示例说明）、
   请求（方法/URL/Header 列表/body 模板；GET 时隐藏 Body、参数写 URL）、响应（类型/JSON 路径/回复模板/兜底文案）、
   限制（超时/冷却/小时上限）；
3. 「测试运行」弹窗：输入示例消息/选择用户 → 显示提取参数、实际请求 URL、HTTP 状态/耗时、
   响应预览、将回复文本（不发给用户）；
4. 「运行日志」表格：时间/规则/用户/状态/HTTP/耗时/错误/参数与响应预览；支持状态筛选、分页；
5. 文档页新增「接口应用」章节（机制、模板语法、安全限制、curl 示例、测试运行/日志）；
6. 保持零构建/CSP/textContent/移动端不溢出。

## 9. 服务端模块与接入

- 新模块 `server/src/app-rules.js`：匹配/提取/模板渲染/SSRF 校验/HTTP 调用/响应解析/回复渲染的
  纯函数 + `RuleEngine`（内存队列、并发、start/stop、`handleInbound()`）。
- `monitor.js`：入站消息落库后调用 `appRules.handleInboundMessage({userId, inboundMessageId, text, itemTypes})`
  （仅文本消息触发；异步不阻塞轮询）。
- `index.js`：`appRules.start()`（`config.appRules.enabled=false` 时不启动）与优雅退出
  `appRules.stop()`。
- `store.js`：规则 CRUD/日志写入/统计/冷却与配额查询/去重索引处理。
- `db.js`：schema v5。
- `api.js`：§7 全部管理端接口 + 校验 + Header 加解密 + 测试运行 + 日志查询。
- `crypto.js` 复用加密；`logger` 复用脱敏。

## 10. MVP 范围（本次实现）

- 文本触发；范围 all/users/groups；match contains/equals/regex；参数提取 none/multi（组合项 trailing/regex/json/fulltext）；
  GET/POST + URL/Header/Body 模板；响应 json/text + 路径 + 回复模板 + 兜底；冷却/小时限额/队列并发/
  去重；SSRF 防护与允许名单；后台规则管理 + 测试运行 + 日志；e2e（本地 mock 外部 API 全链路）；
  文档；schema v5 真实迁移验证。
- 不包含（后续）：多步对话/有状态会话、LLM 参数抽取、媒体回复、HMAC/OAuth2、多规则级联、
  对外规则管理 API。
