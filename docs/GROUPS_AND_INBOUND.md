# 用户分组 + 入站消息 API 设计契约

> 本次功能增量：① 用户分组（多分组标签）管理、筛选、按分组群发；② 对外 API 可获取"微信用户发给
> ClawBot 的入站消息"（分页/游标/筛选/长轮询），供外部系统集成。
> 相关既有文档：`docs/API.md`（HTTP 契约总览）、`docs/ARCHITECTURE.md`（架构/DB）、`docs/MEDIA.md`（媒体）。

## 0. 范围与假设

- "分组"采用 **多对多标签**（一个用户可属于多个分组），比单分组更灵活；管理端用多选编辑。
- 现有真实数据（2 个用户、历史消息）必须**无损保留**；schema 采用 v3 additive migration。
- 入站消息 API 为 **拉取式 REST**（支持 `since` / `cursor` / `wait` 长轮询），不改动现有
  `getupdates` 长轮询与 outbox 架构；Webhook 推送不在本次范围（可作为后续扩展）。
- 分组群发复用现有 outbox：为分组内每个 active 用户各入队一条；文本/媒体限制与单发一致。

## 1. 数据库 Schema v3（additive）

```sql
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,                    -- 'grp_<uuid>'
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',         -- 可选 '#RRGGBB'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name ON groups(name);

CREATE TABLE IF NOT EXISTS user_groups (
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_user_groups_group ON user_groups(group_id);
CREATE INDEX IF NOT EXISTS idx_user_groups_user ON user_groups(user_id);
```

迁移要求：
- `SCHEMA_VERSION = 3`；`CREATE TABLE IF NOT EXISTS` 幂等；
- 从 v2 升级保留全部 users/outbox/inbound_messages/attachments/events；
- 无法从 v1 直接跨级？仍走顺序迁移（v1→v2→v3），现有 `db.js` 迁移框架支持；
- 测试必须覆盖：构造 v2 数据库（含用户/消息/附件）→ 迁移到 v3 数据不丢、重复打开幂等。

## 2. 数据模型与视图

**GroupView**

```json
{
  "id": "grp_…", "name": "VIP客户", "description": "重点客户",
  "color": "#07C160", "userCount": 3, "activeUserCount": 2,
  "createdAt": 1760000000000, "updatedAt": 1760000000000
}
```

- `userCount`：该分组下全部用户（含 unbound 历史用户）；`activeUserCount`：status='active' 且未冷却？
  定义：`status='active'` 即计入（冷却中仍算 active，仅发送会失败），群发目标只取 active 且未冷却。

**UserView 增加字段**

```json
"groups": [ { "id": "grp_…", "name": "VIP客户", "color": "#07C160" } ]
```

`GET /api/admin/users`、`GET /api/admin/users/{id}`、`GET /api/v1/users`（简化字段也可带 group 名）均需带。

**消息项**不变；管理端 `GET /api/admin/messages` 支持 `groupId` 过滤（按消息所属用户的分组）。

## 3. 管理端 API（Cookie + CSRF）

### 3.1 分组 CRUD

```
GET    /api/admin/groups
  → 200 { "items": [GroupView, ...] }        // 按 created_at ASC
POST   /api/admin/groups
  Body: { "name": "VIP客户", "description": "可选", "color": "#07C160" }
  → 201 { "group": GroupView }
  - name 1..40 字符、必填、全库唯一（409 CONFLICT）
  - description ≤200；color 为空或 `#RRGGBB`（非法 400）
PATCH  /api/admin/groups/{id}
  Body: { "name"?, "description"?, "color"? }   // 至少一个字段
  → 200 { "group": GroupView }；404 不存在；409 重名
DELETE /api/admin/groups/{id}
  → 204；同时删除 user_groups 关联（用户本身不受影响）
```

### 3.2 用户分组归属

```
PUT /api/admin/users/{id}/groups
  Body: { "groupIds": ["grp_a", "grp_b"] }        // 全量替换；[] 表示清空
  → 200 { "user": UserView }                       // user.groups 已更新
  - 用户不存在 404；groupIds 中有不存在的 → 400（details.unknownGroupIds）
  - 去重、忽略顺序；静默去重
```

### 3.3 用户列表/消息筛选

```
GET /api/admin/users?status=&q=&groupId=&limit=&offset=
  - groupId：仅返回属于该分组的用户
GET /api/admin/messages?direction=&status=&userId=&groupId=&limit=&offset=
  - groupId：仅返回所属用户在该分组内的消息（入站/出站均适用）
```

### 3.4 按分组发送

```
POST /api/admin/groups/{id}/messages
  Body: { "text": "可选", "mediaId": "att_xxx(可选)" }   // 同单发：text 与 mediaId 至少一个
  → 202 { "queued": [queuedItem...], "count": 3 }
  - 目标 = 分组内 status='active' 且 pause_until<=now 的用户；无目标时 200/202 + count 0
  - queuedItem 与单发一致（outboxId/userId/status/media）
```

## 4. 对外 API（API Key）

### 4.1 分组列表

```
GET /api/v1/groups
  → 200 { "items": [ { id, name, description, color, keepaliveEnabled,
                       userCount, activeUserCount } ] }
  - keepaliveEnabled：分组级 24h 会话保活开关（只读；分组开启后加入的成员自动开启保活）
```

### 4.2 按分组发送

```
POST /api/v1/groups/{groupId}/messages
  Body: { "text": "可选", "mediaId": "att_..." }        // 至少一个
  → 202 { "accepted": N, "queued": [queuedItem...] }
  - 分组不存在 404；无可发送用户时 accepted=0, queued=[]
```

### 4.3 获取入站消息（核心新增）

```
GET /api/v1/inbound/messages
Auth: Authorization: Bearer <API_TOKEN> 或 X-Api-Key

Query:
  limit   = 1..200，默认 50
  since   = 毫秒时间戳（可选，独占：只返回 received_at > since 的消息）
  cursor  = 不透明游标（可选，优先于 since；来自上次响应的 nextCursor）
  userId  = 可选，只看某用户
  groupId = 可选，只看某分组内用户的消息
  wait    = 0..30（秒，可为小数，如 1.5；长轮询：无新消息时最多等待 N 秒，收到新消息立即返回）

排序：按 (received_at ASC, id ASC) —— 便于外部系统用 cursor 增量拉取。
响应 200:
{
  "items": [ {
    "id": "in_…",
    "userId": "u_…",
    "displayName": "杨星雨",
    "groups": [ { "id":"grp_…", "name":"VIP客户", "color":"#07C160" } ],
    "text": "消息文本（媒体消息为 [图片]/[视频]/[文件]/[语音] 占位）",
    "itemTypes": "1" 或 "1,2",
    "createdAt": 1760000000000,          // 微信消息时间
    "receivedAt": 1760000000123,         // ClawBridge 接收时间（排序/游标依据）
    "attachments": [ {
      "id":"att_…", "kind":"image|video|file|voice", "mime":"image/jpeg",
      "fileName":"", "size":448642, "status":"ready",
      "url":"/api/v1/media/att_…", "downloadUrl":"/api/v1/media/att_…?download=1"
    } ]
  } ],
  "nextCursor": "eyJ0IjoxNzYwMDAwMDAxMjMsImlkIjoiaW5fLi4uIn0", // 无更多数据时可为 null
  "hasMore": false,
  "serverTime": 1760000002000
}
```

语义细节：
- `cursor` 编码（base64url JSON）：`{ "t": receivedAt, "id": "in_…" }`；服务端按
  `(received_at, id) > (t, id)` 的字典序取数据（同毫秒多条也稳定）。
- `nextCursor` 规则：若无更多数据返回最后一条的游标（便于下次继续增量等待）或 null（无数据时）；
  `hasMore=true` 表示还有更多未返回。
- `wait>0` 且当前无新消息：每 500ms 重新查询，直到出现新消息或超时；超时返回 `items=[]`、
  `nextCursor` 为传入游标（原样）/null、`serverTime` 更新。请求总时长 ≤ wait+1s。
- 鉴权失败 401；参数非法 400（limit/wait 越界、cursor 格式错误、since 非数字）。
- `groupId` 过滤按用户当前 membership（非消息发送时快照）。
- 附件只返回元数据；文件内容走已有 `GET /api/v1/media/{attId}`（鉴权 + Range）。

### 4.4 入站消息 API 使用示例（轮询）

```bash
# 首次拉取最近 50 条（升序）
curl -s "http://localhost:10380/api/v1/inbound/messages?limit=50" \
  -H "Authorization: Bearer $API_TOKEN"

# 之后用 nextCursor 增量拉取；无新消息时长轮询最多 25 秒
curl -s "http://localhost:10380/api/v1/inbound/messages?limit=50&cursor=$NEXT&wait=25" \
  -H "Authorization: Bearer $API_TOKEN"
```

## 5. 配置

无需新增必需环境变量。常量：
- 入站 API 单页上限 200、默认 50；`wait` 上限 30s；轮询间隔 500ms。
- 分组名唯一（大小写敏感按 SQLite 默认）。

## 6. 前端（管理后台）

1. **用户分组区块**（用户管理内或独立卡片）：
   - 列表列：名称（彩色圆点）、描述、用户数（活跃/总数）、操作：发消息 / 编辑 / 删除；
   - 新建/编辑弹窗：名称、描述、颜色（预设色板，可不选）；删除需二次确认（提示不影响用户）；
2. **用户列表**：
   - 增加分组筛选（全部 / 未分组 / 各分组）；
   - 每行展示分组徽章（最多 3 个 + "+N"）；
   - 行操作增加「分组」→ 多选弹窗（PUT 全量替换）；
   - 行内「发消息」逻辑不变；
3. **分组发消息**：分组行「发消息」打开复用现有发送弹窗（文本 + 可选附件 → 上传 mediaId → POST group messages）；
4. **消息记录**：增加分组筛选（可选实现，复用 `groupId` 参数）；
5. **API 文档页**：新增「用户分组 API」「入站消息 API」章节（含 cursor/wait 示例、附件读取）；
6. 保持零构建、CSP、无内联脚本、textContent 渲染。

## 7. 测试要求

**单元（backend-dev）**
- db：v2→v3 迁移（含 v2 数据）保留数据、幂等；全新库 v3；
- store：groups CRUD/重名、user_groups 替换/去重/级联删除、用户列表按 groupId 过滤、
  消息列表按 groupId 过滤、GroupView 计数、入站查询 cursor/since/分页/附件关联；
- v1 inbound：cursor 编解码、since 独占、limit 边界、wait（短超时，真实等待 ≤1s）、
  非法参数 400、鉴权 401、附件 URL 前缀 v1；
- API：分组 CRUD 校验、PUT groups 未知 id 400、分组群发入队行为、admin group filter；
- 兼容回归：原有测试全绿（141）。

**e2e（infra-dev）**
- 分组 CRUD + 用户归属 + 用户列表过滤 + 分组文本/媒体群发（mock 收到 N 条）；
- v1 分组列表/分组发送；
- v1 入站消息：绑定两用户、注入文本/图片/文件入站 → `GET /api/v1/inbound/messages` 按 cursor
  增量拉取两次（不重复/不遗漏）、since 过滤、userId/groupId 过滤、附件元数据与 `/api/v1/media/...`
  字节一致、鉴权 401、limit/wait 参数校验、wait 超时返回空；
- 迁移：v2 数据库副本升级后数据保留（e2e 或单测均可）；
- `npm test` 全绿（原 142 + 新增）。

**验收（QA）**
- 独立跑测试矩阵；Docker 容器内用真实 API 完成分组/入站 API 黑盒；
- 真实数据 v2→v3 迁移副本验证（users/outbox/inbound/attachments 数量与样本一致、幂等）；
- 安全：分组/入站接口鉴权、参数边界、入站数据不泄漏 token/密钥、分页不越权；
- 文档一致性（README/API/ARCHITECTURE 与实现一致）。
