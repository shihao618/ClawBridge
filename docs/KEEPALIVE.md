# 24h 会话保活（Keep-Alive）设计契约

> 背景：微信 ClawBot 存在"会话窗口"限制——用户最近一次主动给 bot 发消息后的约 24 小时内，
> bot 才能可靠地主动下发消息；超过 24 小时会话失效（见 README FAQ / 社区反馈）。
> 本功能：**对开启了保活的用户**，当其"最后一条入站消息"即将满 24 小时时，自动发送一条
> 保活消息，提示用户回复以刷新会话窗口（用户回复后窗口重新计时）。
> 相关文档：`docs/API.md`、`docs/ARCHITECTURE.md`、`docs/GROUPS_AND_INBOUND.md`。

## 0. 范围与原则

- **按用户 opt-in**：默认关闭；管理员可对单个用户或整个分组批量开启/关闭（"对于有需求的用户"）。
- 只在**窗口仍然有效**时发送（剩余时间 >0，默认提前 1 小时触发）；窗口已过期不发送（发了也没用）。
- **每个会话窗口最多自动发送一次**：发送后记录 `keepalive_last_sent_at`；用户之后再发消息
  （`last_inbound_at` 更新）才进入下一个窗口、可再次触发。
- 保活消息走现有 outbox 队列（source=`keepalive`），受每账号限流、`-2/-14` 处理、媒体等完全复用。
- 内容默认："【消息通道保活】回复任意内容即可继续接收通知。"，支持 `{name}` 占位（用户昵称）；
  可通过环境变量覆盖。
- 无入站记录（从未发过消息）的用户不发送（没有可刷新的窗口，冷启动推送由用户自行触发）。
- 调度为单进程内定时扫描（默认每 5 分钟），与 getupdates/outbox 无锁冲突（扫描/入队用事务）。

## 1. 数据库 Schema v4（additive）

`users` 表新增两列：

```sql
ALTER TABLE users ADD COLUMN keepalive_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN keepalive_last_sent_at INTEGER NOT NULL DEFAULT 0;
```

- `SCHEMA_VERSION = 4`；用 `PRAGMA table_info(users)` 检查后 `ALTER TABLE`，幂等；
- v1→v2→v3→v4 逐级迁移，保留全部既有数据（users/outbox/inbound/attachments/events/groups）；
- 测试要求：构造 v3 数据库（含用户/消息/分组）→ 升级到 v4 数据不丢、列默认值正确、重复打开幂等。

## 2. 配置（config.js：`config.keepalive`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KEEPALIVE_ENABLED` | `true` | 全局调度开关（false=完全不扫描，便于运维临时关闭） |
| `KEEPALIVE_WINDOW_MS` | `86400000`（24h） | 会话窗口长度（e2e 可调小） |
| `KEEPALIVE_LEAD_MS` | `3600000`（1h） | 提前量：`now - lastInboundAt >= window - lead` 时触发 |
| `KEEPALIVE_TICK_MS` | `300000`（5min） | 扫描间隔 |
| `KEEPALIVE_TEXT` | `【消息通道保活】回复任意内容即可继续接收通知。` | 保活文本模板，支持 `{name}` |
| `KEEPALIVE_MAX_PER_TICK` | `100` | 单次扫描最多处理用户数（防御） |

`config.keepalive = { enabled, windowMs, leadMs, tickMs, text, maxPerTick }`。

## 3. 触发条件（SQL 语义）

对每个用户，同时满足：

1. `status='active'`；
2. `keepalive_enabled=1`；
3. `last_inbound_at > 0`；
4. `pause_until <= now`（未冷却）；
5. `keepalive_last_sent_at < last_inbound_at`（本窗口还没发过保活）；
6. `now - last_inbound_at >= windowMs - effectiveLeadMs`（默认 23h）；
7. `now - last_inbound_at < windowMs`（窗口未过期；已过期不发送）；
8. 满足 1-7 的用户按 `last_inbound_at ASC` 排序，单次最多 `maxPerTick` 个。

其中 `effectiveLeadMs = min(leadMs, windowMs)`（防止配置 lead≥window 时逻辑反转）。

发送流程（`keepalive.js`，单循环）：
1. 查询候选用户（上限 maxPerTick）；
2. 对每个用户：事务内 `enqueueMessage({userId, source:'keepalive', text: 渲染后的模板})` +
   `setKeepaliveLastSentAt(userId, now)` + `addEvent({type:'keepalive', userId, detail})`；
3. 日志 `保活消息已入队`（userId/remainingMs）；失败只记录日志，下个 tick 重试；
4. `stop()` 幂等，进程退出前停止定时器。

## 4. 管理端 API

```
PATCH /api/admin/users/{id}/keepalive         # 单用户开关
  Body: { "enabled": true }                    # 必填 boolean
  → 200 { "user": UserView }                   # user.keepaliveEnabled/keepaliveLastSentAt

POST /api/admin/groups/{id}/keepalive         # 分组批量开关（持久化分组级开关）
  Body: { "enabled": true }
  → 200 { "updated": 3, "group": GroupView }  # GroupView.keepaliveEnabled 同步更新

# 分组级保活（schema v6，groups.keepalive_enabled）：
#  - 分组开启保活后，**之后加入该分组的成员自动开启保活**（PUT /users/{id}/groups 时继承）；
#  - 移出分组不会关闭用户保活（保留用户手动/历史设置）；
#  - 分组关闭保活时，当前成员被关闭，之后加入的成员保持关闭；
#  - 创建/更新分组接口支持可选 keepaliveEnabled 字段（非 boolean → 400）；PATCH 分组设置
#    keepaliveEnabled 与批量开关接口等价，会同步当前成员；
#  - PUT /users/{id}/groups 响应的 inheritedKeepalive 表示该用户当前是否属于任一开启保活的分组
#    （不是“本次是否触发继承”）。

GET /api/admin/users?...                      # UserView 增加：
  "keepaliveEnabled": false,
  "keepaliveLastSentAt": 0
GET /api/admin/config                         # 增加：
  "keepalive": { "enabled":true, "windowMs":86400000, "leadMs":3600000,
                 "tickMs":300000, "maxPerTick":100, "text":"…" }
GET /api/admin/overview                       # stats 增加：
  "keepaliveEnabledUsers": 2, "keepaliveSent24h": 1
  // 注意：keepaliveSent24h = 最近 24h 内**入队**的保活消息数（含 queued/sent 等状态），
  // 不是严格的"发送成功数"；如需精确成功数可查询 outbox（source=keepalive & status=sent）。
```

消息视图（admin `GET /api/admin/messages`、v1 outbox 状态）增加 `source` 字段
（`admin|api|broadcast|group|keepalive|system`），便于前端标注"保活"来源。

对外 v1 `GET /api/v1/users` 的 items 增加 `keepaliveEnabled`（可选、只读，便于外部系统感知）。

错误：用户不存在 404；enabled 非 boolean 400；分组不存在 404；其余沿用统一错误格式。

## 5. 前端（管理后台）

1. 用户列表每行增加「保活」开关（按钮/switch）：点击调用 `PATCH /api/admin/users/{id}/keepalive`，
   开启显示"保活中"状态；同时可在用户详情展示 `keepaliveLastSentAt`（最近保活时间）。
2. 分组列表每行增加「保活」**行内开关**（无需弹窗）：点击调用
   `POST /api/admin/groups/{id}/keepalive`，同步当前成员并持久化分组默认，之后加入该分组的成员自动开启；
   分组新建/编辑表单**不再包含**该开关（新建分组默认关闭，创建后在列表行内开启即可）。
3. 运行配置区块展示保活参数（窗口/提前量/扫描间隔/文本/全局开关）。
4. 消息记录：来源为 `keepalive` 的消息显示"保活"小标签。
5. API 文档页新增「消息保活」章节：机制说明（24h 窗口/每窗口一次/opt-in）、两个管理端接口、
   配置项、curl 示例。
6. 保持零构建/CSP/textContent/移动端不溢出。

## 6. 测试要求

**单元（backend-dev）**
- db v3→v4 迁移（数据保留/列默认值/幂等/全新库 v4）；
- store：`setKeepaliveEnabled`（用户/分组批量）、`setKeepaliveLastSentAt`、
  `getKeepaliveCandidates(now, {windowMs, leadMs, limit})`（8 条 SQL 条件、按时间排序、limit）；
- scheduler（`keepalive.js`）：fake clock 直接调用 `scan(now)`——触发一次、同窗口不重复、
  用户回复后新窗口可再触发、disabled/paused/unbound/lastInbound=0/已过期 均不触发、
  模板 `{name}` 渲染、maxPerTick、enqueue 失败不崩；
- API：PATCH 单用户/分组批量（404/400/updated 计数）、UserView/config/overview 字段、source 字段。

**e2e（infra-dev，压缩时间参数）**
- 启动 app 时用 `KEEPALIVE_ENABLED=1 KEEPALIVE_WINDOW_MS=8000 KEEPALIVE_LEAD_MS=3000 KEEPALIVE_TICK_MS=300`；
- 绑定用户并注入入站消息 → `PATCH /api/admin/users/{id}/keepalive {enabled:true}` →
  等待 ~5s 内 mock 收到保活文本（含 {name} 渲染）→ outbox source='keepalive'、sent；
- 同一窗口内不重复发送（等待 >1 个 tick 无第二条）；
- 用户再次注入入站消息后，下个窗口可再次触发；
- 关闭保活的用户不触发；分组批量开启后组内用户触发；窗口已过期的用户不触发（可用 since 注入/等待压缩窗口过期）；
- 鉴权/参数校验（401/400）；现有 40 个 e2e 无回归；`npm test` 全绿。

**QA**
- 独立跑测试矩阵；Docker 黑盒（压缩时间参数）验证保活端到端；
- 真实 v3→v4 迁移副本验证（2 users/13 outbox/6 inbound/6 attachments/9 events… 计数与样本保留、幂等）；
- 安全/代码审查：调度不重复/不阻塞、限流不越界、opt-in 生效、文本 XSS、日志无敏感信息；
- 文档一致性（README/API/ARCHITECTURE 与实现一致）。

## 7. 真实环境上线

- v3→v4 additive migration（默认 schema_version 3→4），保留 2 个真实用户及历史数据；
- 保活默认**不开启**（`keepalive_enabled=0`），由管理员在后台对需要的用户/分组开启；
- 上线后在后台把需要保活的用户打开，可在"运行配置"看到保活参数；用户回复后窗口自动刷新。

## 8. 已知限制与运维说明

- **单实例调度**：`keepalive.js` 为进程内定时器 + 单进程事务，**假定单副本部署**；若将来多副本
  部署，需要外部互斥（如 DB 抢占/分布式锁）或只让一个副本启动调度器（`KEEPALIVE_ENABLED=false`
  关闭其它副本的调度），否则可能重复入队。
- **分组批量开关**的 `updated` 计数包含组内全部成员（含 unbound/paused 用户，仅写 opt-in 标志，
  不改变用户状态；实际是否会发送仍由候选条件决定）。
- **文本长度**：保活文本渲染后会按 `MAX_TEXT_LENGTH`（默认 4000）截断，避免超长模板被微信侧拒绝。
- **统计口径**：`keepaliveSent24h` 为 24h 内入队数（见 §4），前端展示为"24h 保活入队"。
- 保活只保证"尝试刷新会话窗口"，若用户始终不回复，24h 窗口仍会过期；过期后不会继续发送。
- 建议上线后先对 1-2 个用户开启，观察一轮真实 24h 窗口行为后再扩大范围。
