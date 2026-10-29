# ClawBridge HTTP API 契约

所有接口均返回 JSON（除静态页面与二维码 SVG）。错误统一格式：

```json
{ "error": { "code": "BAD_REQUEST", "message": "人类可读的错误信息" } }
```

错误码：`BAD_REQUEST`(400)、`UNAUTHORIZED`(401)、`FORBIDDEN`(403)、`NOT_FOUND`(404)、
`CONFLICT`(409)、`RATE_LIMITED`(429)、`INTERNAL`(500)、`UNAVAILABLE`(503)。

时间字段统一为 Unix 毫秒整数。所有写接口接受 `Content-Type: application/json`。

## 0. 页面路由（静态）

| 路径 | 内容 |
| --- | --- |
| `GET /` | 绑定首页（公开，含品牌介绍 + 开始绑定入口 + 管理入口链接） |
| `GET /bind` | 扫码绑定页（公开） |
| `GET /admin` | 管理后台（未登录时展示登录表单，SPA 由前端跳转） |
| `GET /docs` | 内嵌的 API 使用文档页 |
| `GET /assets/*` | 前端静态资源 |
| `GET /health` | 健康检查，返回 `{"status":"ok","version":"...","uptimeMs":123}`（也兼容 `/api/health`） |

## 1. 公开接口：扫码绑定

### 1.1 创建绑定会话

```
POST /api/bind/sessions
Body: { "displayName": "张三" }        // 可选，最长 40 字符
Resp 201:
{
  "sessionId": "01J...",               // 不透明 ID
  "token": "…",                        // 本会话的 secret，只有创建者拿到
  "status": "waiting",
  "displayName": "张三",
  "qr": {
    "svg": "data:image/svg+xml;base64,...",   // 服务端渲染好的二维码 SVG data URI，直接 <img src>
    "content": "https://...",                  // 二维码原始内容（备用，可自行渲染）
    "expiresAt": 1760000000000
  },
  "createdAt": 1760000000000
}
```

- 该接口按 IP 限流（默认 20 次/小时，可由环境变量调整）；最多允许 50 个并发会话。
- 会话有效期 10 分钟；过期由服务端清理。
- 返回 503 且 `code=UNAVAILABLE` 表示连不上微信 API（如出网失败）。

### 1.2 查询绑定状态（前端轮询，1s 间隔）

```
GET /api/bind/sessions/{sessionId}?token=<secret>
Resp 200:
{
  "sessionId": "…",
  "status": "waiting | scanned | need_verifycode | refreshing | verify_blocked | confirmed | already_bound | expired | timeout | error | cancelled",
  "message": "人类可读状态说明",
  "qr": { "svg": "...", "content": "...", "expiresAt": 1760000000000 },  // 刷新后更新
  "refreshCount": 0,
  "user": {                              // 仅 confirmed 时
    "id": "u_...",
    "displayName": "张三",
    "wechatUserId": "…",
    "boundAt": 1760000000000
  },
  "error": "…"                           // status=error 时的错误信息
}
```

状态语义：

| status | 说明 |
| --- | --- |
| `waiting` | 等待扫码 |
| `scanned` | 已扫码，等待手机确认 |
| `need_verifycode` | 需要输入手机微信上显示的配对数字 |
| `refreshing` | 二维码过期，正在自动刷新（最多 3 次） |
| `verify_blocked` | 配对数字错误次数过多，正在刷新二维码 |
| `confirmed` | 绑定成功（`user` 字段返回）。此状态之后会话仍可查询，约保留 10–20 分钟（`BINDING_TTL_MS` 到期后由清理任务回收） |
| `already_bound` | 该微信已绑定过本服务（binded_redirect），`user` 可能返回已有用户；否则提示用户联系管理员 |
| `expired` / `timeout` / `cancelled` | 会话结束，需重新创建 |
| `error` | 协议/网络错误导致失败，`error` 字段给出原因；可重试 |

### 1.3 提交配对数字

```
POST /api/bind/sessions/{sessionId}/verify-code
Body: { "token": "…", "code": "1234" }
Resp 202: { "ok": true }
```

会话状态不是 `need_verifycode` 时返回 409。`code` 只会用于下一次轮询。

### 1.4 取消绑定

```
DELETE /api/bind/sessions/{sessionId}
Body: { "token": "…" }
Resp 204
```

## 2. 管理后台接口（Cookie 会话）

登录后使用 HttpOnly Cookie `cb_session`（SameSite=Lax，12 小时有效）。所有写接口要求
`X-Requested-With: ClawBridge-Admin` 请求头（防 CSRF）。

### 2.1 登录 / 登出 / 当前身份

```
POST /api/admin/login    Body: { "password": "..." }
  → 200 {"ok": true, "expiresAt": 1760000000000} + Set-Cookie: cb_session=...
  → 401 {"error":{"code":"UNAUTHORIZED","message":"密码错误"}}

POST /api/admin/logout   → 204 + 清除 Cookie
GET  /api/admin/me       → 200 {"authenticated": true, "expiresAt": ...} 或 {"authenticated": false}
```

### 2.2 概览

```
GET /api/admin/overview
→ 200 {
  "stats": {
    "totalUsers": 3,
    "activeUsers": 3,             // status='active'
    "pausedUsers": 0,             // token 失效冷却中
    "usersWithContextToken": 2,   // 有 context_token 的用户数（可主动推送）
    "messagesToday": 25,          // 今日入站+出站消息数
    "queued": 0, "sending": 0, "sent": 12, "failed": 1,
    "inboundLast24h": 8
  },
  "server": {
    "version": "1.0.0",
    "uptimeMs": 123456,
    "now": 1760000000000,
    "ilink": { "loginBaseUrl": "...", "defaultBaseUrl": "...", "botType": "3" },
    "rateLimit": { "max": 7, "windowMs": 300000 },
    "monitorsRunning": 3,
    "bindingSessionsActive": 0
  }
}
```

### 2.3 用户列表

```
GET /api/admin/users?status=active|unbound|paused|all&q=<搜索>&limit=50&offset=0
→ 200 {
  "total": 3,
  "items": [{
    "id": "u_xxx",
    "displayName": "张三",
    "wechatUserId": "…",
    "ilinkBotId": "…",
    "status": "active | unbound | paused",
    "boundAt": 1760000000000,
    "updatedAt": 1760000000000,
    "lastInboundAt": 1760000000000,
    "lastOutboundAt": 1760000000000,
    "hasContextToken": true,
    "queuedCount": 0,
    "sentCount": 12,
    "failedCount": 0,
    "pauseUntil": 0,              // 冷却结束时间，0 表示无
    "note": ""                    // 预留
  }]
}
```

`status=unbound` 用户为历史记录（凭证已清除）；默认只返回 `active`（`status` 缺省 = active）。

### 2.4 用户详情 / 发消息 / 解绑 / 重连

```
GET  /api/admin/users/{id}
  → { "user": {同列表字段}, "recentInbound": [Message], "recentOutbound": [OutboxItem] }

POST /api/admin/users/{id}/messages
Body: { "text": "你好" }
  → 202 { "queued": [{ "outboxId": "ob_...", "userId": "u_...", "status": "queued" }] }
  → 404 用户不存在；409 用户未绑定或冷却中；400 文本为空/超长（默认 4000 字符）

POST /api/admin/users/{id}/unbind
  → 200 { "ok": true, "message": "已解绑（微信端授权需在手机微信中管理）" }
  语义：停止轮询 → notifyStop → 清除凭证与 context_token → status=unbound

POST /api/admin/users/{id}/reconnect
  → 200 { "ok": true, "monitorsRunning": true }    // 重启该账号的入站轮询（冷却中返回 409）

DELETE /api/admin/users/{id}
  → 200 { "ok": true, "deleted": true, "userId": "u_...",
          "attachmentsDeleted": 2, "updatedTasks": 1, "updatedRules": 0,
          "cleared": { "outbox": 3, "inbound_messages": 5, "attachments": 2, ... } }
  语义：先停止该用户入站监控 → 事务内删除 users / user_groups / outbox /
  inbound_messages / attachments / app_rule_logs / events → 从定时任务目标与接口应用
  「指定用户」范围移除该用户 → 删除其附件文件。**不可恢复**；只想停止收发请用 unbind。
```

### 2.5 广播

```
POST /api/admin/broadcast
Body: { "text": "系统维护通知" }
  → 202 { "queued": [...], "count": 3 }
```

### 2.6 消息记录

```
GET /api/admin/messages?direction=inbound|outbound|all&status=&limit=50&offset=0&userId=
→ 200 {
  "total": 12,
  "items": [{
    "id": "…",
    "direction": "inbound | outbound",
    "userId": "u_…",
    "displayName": "张三",
    "text": "…",
    "status": "sent | failed | queued | sending | received",   // inbound 恒为 received
    "error": "",
    "attempts": 1,                 // 实际发送尝试次数：首次投递成功=1，每次重试递增
    "serverMessageId": "…",
    "createdAt": 1760000000000
  }]
}
```

> 出站消息的 `attempts` 表示已尝试发送的次数（首次成功即为 1）；`status=queued` 时可能为 0。
> `serverMessageId` 为微信返回的 uint64 消息 ID，按字符串无损返回。

### 2.7 运行配置（脱敏）

```
GET /api/admin/config
→ 200 {
  "version": "1.0.0",
  "rateLimit": { "max": 7, "windowMs": 300000 },
  "binding": { "ttlMs": 600000, "maxRefreshes": 3, "maxActiveSessions": 50 },
  "pushApiEnabled": true,
  "apiTokenPreview": "claw…c9f2",      // 仅前 4 + 后 4
  "adminPasswordIsDefault": false,
  "dataDir": "/app/data"
}
```

## 3. 对外推送 API（API Key）

鉴权：`Authorization: Bearer <API_TOKEN>` 或 `X-Api-Key: <API_TOKEN>`。
所有响应 401 时 `code=UNAUTHORIZED`。文本默认上限 4000 字符。接口按 API Key 限流
（默认 60 次/分钟）。

### 3.1 给指定用户发消息

```
POST /api/v1/messages
Body: {
  "to": ["u_abc", "u_def"],       // 用户 id 数组（1..100）
  "text": "您的订单已发货"
}
Resp 202: {
  "accepted": 2,
  "queued": [ { "outboxId": "ob_1", "userId": "u_abc", "status": "queued" },
              { "outboxId": "ob_2", "userId": "u_def", "status": "queued" } ]
}
未知/未绑定用户返回 404，无效用户列在 `error.details.unknownUserIds`；全部无效时不入队。
```

### 3.2 广播

```
POST /api/v1/broadcast
Body: { "text": "系统维护通知", "onlyBound": true }
Resp 202: { "accepted": 3, "queued": [...] }
```

### 3.3 查询投递状态

```
GET /api/v1/messages/{outboxId}
→ 200 { "id": "ob_1", "userId": "u_abc", "status": "queued|sending|sent|failed",
        "attempts": 1, "error": "", "serverMessageId": "…",
        "createdAt": 1760000000000, "sentAt": 1760000001000 }
```

### 3.4 用户列表（供外部系统发现收件人）

```
GET /api/v1/users?status=active&limit=100
→ 200 { "items": [ { "id": "u_abc", "displayName": "张三", "status": "active",
                     "boundAt": 1760000000000, "hasContextToken": true } ] }
```

### 3.5 curl 示例

```bash
# 单发
curl -X POST http://localhost:10380/api/v1/messages \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"to":["u_abc"],"text":"你好，来自 ClawBridge"}'

# 广播
curl -X POST http://localhost:10380/api/v1/broadcast \
  -H "X-Api-Key: $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"系统维护通知"}'
```

## 4. 内部行为约定（供后端实现 / 测试）

- 绑定会话在服务端维护一个 worker：创建后立即开始长轮询 `get_qrcode_status`，状态写回会话。
  worker 出错自动重试（最多 5 次连续网络错误），二维码过期自动刷新（≤3 次），整体 10 分钟超时。
  浏览器只轮询本地 `/api/bind/sessions/{id}`，不会直接访问微信 API。
- 绑定成功后：创建/更新用户（按 `wechat_user_id` upsert，等价官方 clearStaleAccountsForUserId），
  保存加密的 bot_token/base_url，启动该用户的入站监控（notifystart + getupdates）。
- 发送走 outbox 队列：`POST` 只负责入队（202），由 per-account 限流 worker 异步投递；
  `-2` 限流按退避重试，`-14` 标记账号暂停 1 小时并失败剩余消息。
- 所有 bot_token / context_token 必须以 AES-256-GCM 加密后落库，接口与日志不得返回明文。

## 5. 多媒体接口（图片 / 视频 / 文件）

完整协议、存储与实现契约见 [`docs/MEDIA.md`](MEDIA.md)。上传采用「原始二进制 + 请求头」方式
（非 multipart，零新增依赖；前端可直接 `fetch(url,{method:'POST',body:file,headers:{...}})`）。

### 5.1 上传媒体文件（管理后台）

```
POST /api/admin/media
Header: Cookie: cb_session=...、X-Requested-With: ClawBridge-Admin
Header: Content-Type: <文件 MIME>（如 image/jpeg）
Header: X-File-Name: <encodeURIComponent(原始文件名)>
Body: 文件原始二进制（上限 MEDIA_MAX_BYTES，默认 25MB）
Resp 201:
{ "media": { "id":"att_…", "kind":"image|video|file", "mime":"image/jpeg",
             "fileName":"a.jpg", "size":12345, "url":"/api/admin/media/att_…" },
  "limits": { "maxBytes":26214400, "inboundMaxBytes":104857600,
              "allowedImage":["image/jpeg","image/png"], "allowedVideo":["video/mp4"] } }
错误：400（文件名/MIME 非法）、413（超过上限）、401（未登录）。
```

### 5.2 发送带媒体的消息

`POST /api/admin/users/{id}/messages` / `POST /api/v1/messages` 请求体扩展：

```json
{ "text": "看图（可选 caption）", "mediaId": "att_xxx" }
```

- `text` 与 `mediaId` 至少一个；有 `mediaId` 时先发 caption 文本、再发媒体（两次 sendmessage）。
- 入队响应 queued 项增加 media 摘要：

```json
{"queued":[{"outboxId":"ob_…","userId":"u_…","status":"queued",
  "media":{"id":"att_…","kind":"image","fileName":"a.jpg","size":12345,
           "url":"/api/admin/media/att_…"}}]}
```

- 广播接口仍只支持文本（不支持 mediaId）。
- 微信「语音气泡」暂不支持发送（SILK 转码）；`audio/*` 文件会按普通文件发送。

### 5.3 上传媒体（对外 API）

```
POST /api/v1/media
Header: Authorization: Bearer <API_TOKEN> 或 X-Api-Key: <API_TOKEN>
Header: Content-Type: <MIME>、X-File-Name: <encodeURIComponent(文件名)>
Body: 原始二进制
→ 201 { "media": {...}, "limits": {...} }
```

### 5.4 读取媒体文件

```
GET /api/admin/media/{attId}      # admin Cookie 鉴权（后台 <img>/<video> 同源引用）
GET /api/v1/media/{attId}         # API Key 鉴权
Query: ?download=1               # 强制 Content-Disposition: attachment
```

- 响应含正确的 `Content-Type` / `Content-Length` / `Content-Disposition` /
  `Cache-Control: private, max-age=3600`；支持 HTTP Range（视频拖动进度条）；文件不存在返回 404。
- 媒体内容私有：未鉴权不可访问；路径来自数据库且限制在 `DATA_DIR/media` 内。

### 5.5 消息记录中的附件

`GET /api/admin/messages`、用户详情、outbox 状态（v1）中的消息项可能带：

```json
"attachments":[{"id":"att_…","kind":"image","mime":"image/jpeg","fileName":"a.jpg",
                "size":12345,"url":"/api/admin/media/att_…",
                "downloadUrl":"/api/admin/media/att_…?download=1","status":"ready"}]
```

`kind`：`image | video | file | voice`；入站媒体下载失败时 `status="failed"` 且无文件可读。

### 5.6 配置接口补充

`GET /api/admin/config` 增加：

```json
"media": { "maxBytes":26214400, "inboundMaxBytes":104857600,
           "allowedImage":["image/jpeg","image/png"], "allowedVideo":["video/mp4"], "dir":"/app/data/media" }
```

### 5.7 curl 示例

```bash
# 1) 上传图片（原始二进制）
MEDIA_ID=$(curl -s -X POST http://localhost:10380/api/v1/media \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: image/jpeg" \
  -H "X-File-Name: $(python3 -c 'import urllib.parse;print(urllib.parse.quote("照片.jpg"))' 2>/dev/null || echo photo.jpg)" \
  --data-binary @photo.jpg | python3 -c 'import sys,json;print(json.load(sys.stdin)["media"]["id"])')

# 2) 发送（文字 caption + 图片）
curl -X POST http://localhost:10380/api/v1/messages \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d "{\"to\":[\"u_abc\"],\"text\":\"今日订单截图\",\"mediaId\":\"$MEDIA_ID\"}"
```

## 6. 用户分组（多分组标签）

完整契约见 [`docs/GROUPS_AND_INBOUND.md`](GROUPS_AND_INBOUND.md) §3/§4。用户可属于多个分组；
分组用于用户筛选、消息筛选与按分组群发。

**管理端（Cookie + CSRF）**

```
GET    /api/admin/groups                         → { items:[GroupView] }
POST   /api/admin/groups   {name, description?, color?, keepaliveEnabled?}  → 201 { group }
PATCH  /api/admin/groups/{id} {name?, description?, color?, keepaliveEnabled?} → { group }   // 404/409
DELETE /api/admin/groups/{id}                    → 204                   // 同时清空归属
PUT    /api/admin/users/{id}/groups {groupIds:[]} → { user }             // 全量替换
GET    /api/admin/users?groupId=…                → 按分组过滤用户
GET    /api/admin/messages?groupId=…             → 按分组过滤消息
POST   /api/admin/groups/{id}/messages {text?, mediaId?} → 202 {queued,count}
```

GroupView：

```json
{ "id":"grp_…", "name":"VIP客户", "description":"重点客户", "color":"#07C160",
  "keepaliveEnabled":false,
  "userCount":3, "activeUserCount":2, "createdAt":1760000000000, "updatedAt":1760000000000 }
```

用户视图（admin/v1）新增 `groups:[{id,name,color}]`。分组名唯一（1–40 字符），描述 ≤200，颜色可为空或
`#RRGGBB`。分组群发目标 = 分组内 `status=active` 且未冷却的用户，逐人入 outbox。

**分组保活（schema v6）**：GroupView 的 `keepaliveEnabled` 为分组级保活开关。`POST /api/admin/groups/{id}/keepalive
{enabled}` 会持久化该标志并批量设置当前成员的 `keepaliveEnabled`；`PATCH /api/admin/groups/{id}
{keepaliveEnabled}` 与批量开关等价（也同步当前成员）。`keepaliveEnabled=true` 的分组，
之后通过 `PUT /api/admin/users/{id}/groups` 加入的用户会**自动开启**保活（用户视图返回
`keepaliveEnabled=true`，响应含 `inheritedKeepalive`=该用户当前是否属于任一开启保活的分组）。
移出分组不会关闭用户保活；分组关闭保活时当前成员被关闭，之后加入的成员保持关闭。

**对外 API（API Key）**

```
GET  /api/v1/groups                              → { items:[GroupView] }
POST /api/v1/groups/{groupId}/messages {text?, mediaId?} → 202 {accepted, queued}
```

## 7. 入站消息 API（获取微信用户发来的消息）

```
GET /api/v1/inbound/messages
Auth: Authorization: Bearer <API_TOKEN> 或 X-Api-Key

Query:
  limit   1..200，默认 50
  since   毫秒时间戳（独占，仅 received_at > since）
  cursor  不透明游标（优先于 since，来自上次 nextCursor）
  userId  只返回指定用户的消息
  groupId 只返回指定分组内用户的消息
  wait    0..30 秒（可为小数，如 1.5），长轮询：无新消息时最多等待 N 秒（500ms 轮询间隔），有新消息立即返回

排序：received_at ASC, id ASC（便于 cursor 增量拉取）
响应 200:
{
  "items": [{
    "id":"in_…", "userId":"u_…", "displayName":"杨星雨",
    "groups":[{"id":"grp_…","name":"VIP客户","color":"#07C160"}],
    "text":"消息文本；媒体消息为 [图片] 等占位", "itemTypes":"1" | "1,2",
    "createdAt":1760000000000, "receivedAt":1760000000123,
    "attachments":[{"id":"att_…","kind":"image","mime":"image/jpeg","fileName":"",
      "size":448642,"status":"ready","url":"/api/v1/media/att_…",
      "downloadUrl":"/api/v1/media/att_…?download=1"}]
  }],
  "nextCursor":"eyJ0IjoxNzYwMDAwMDAxMjMsImlkIjoiaW5fLi4uIn0",
  "hasMore":false,
  "serverTime":1760000002000
}
```

- 游标编码：`base64url(JSON.stringify({t: receivedAt, id}))`；下一次用 `cursor=` 继续增量拉取。
- `wait` 超时返回空 `items`（HTTP 200，`nextCursor` 为传入值/null），外部系统可循环长轮询。
- 参数非法 400、鉴权失败 401；附件内容通过已鉴权的 `GET /api/v1/media/{attId}` 读取（支持 Range）。

**轮询示例**

```bash
# 首次（最近 50 条）
curl -s "http://localhost:10380/api/v1/inbound/messages?limit=50" \
  -H "Authorization: Bearer $API_TOKEN"

# 增量长轮询（无新消息最多等 25s，有新消息立即返回）
curl -s "http://localhost:10380/api/v1/inbound/messages?limit=50&cursor=$NEXT&wait=25" \
  -H "Authorization: Bearer $API_TOKEN"
```

## 8. 24h 会话保活（Keep-Alive）

完整设计见 [`docs/KEEPALIVE.md`](KEEPALIVE.md)。微信 ClawBot 的主动下发依赖"用户最近一次主动消息"
（约 24 小时会话窗口）。对**开启保活**的用户，ClawBridge 会在其最后一条入站消息即将满 24 小时时
（默认提前 1 小时）自动入队一条保活消息，提示用户回复以刷新窗口；**每个会话窗口最多发送一次**，
用户回复后重新计时。默认关闭（opt-in），可对单个用户或整个分组批量开启。

**管理端接口（Cookie + CSRF）**

```
PATCH /api/admin/users/{id}/keepalive
  Body: { "enabled": true }
  → 200 { "user": UserView }          # user 含 keepaliveEnabled / keepaliveLastSentAt

POST /api/admin/groups/{id}/keepalive
  Body: { "enabled": true }
  → 200 { "updated": 3, "group": GroupView }

GET /api/admin/users?...              # UserView 新增 keepaliveEnabled / keepaliveLastSentAt
GET /api/admin/config                 # 新增 keepalive 配置（enabled/windowMs/leadMs/tickMs/text/…）
GET /api/admin/overview               # stats 新增 keepaliveEnabledUsers / keepaliveSent24h
                                      # （keepaliveSent24h = 最近 24h 内**入队**的保活消息数，含 queued/sent）
GET /api/admin/messages               # 消息项新增 source（admin/api/broadcast/group/keepalive/system）
```

`GET /api/v1/users` 的 items 增加只读 `keepaliveEnabled`。

**配置（环境变量）**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KEEPALIVE_ENABLED` | `true` | 全局调度开关 |
| `KEEPALIVE_WINDOW_MS` | `86400000`（24h） | 会话窗口长度 |
| `KEEPALIVE_LEAD_MS` | `3600000`（1h） | 提前触发量（最后入站满 window-lead 时触发） |
| `KEEPALIVE_TICK_MS` | `300000`（5min） | 扫描间隔 |
| `KEEPALIVE_TEXT` | `【消息通道保活】回复任意内容即可继续接收通知。` | 保活文本模板，支持 `{name}` |
| `KEEPALIVE_MAX_PER_TICK` | `100` | 单次扫描最多处理用户数 |

**触发条件**：用户 active、已开启保活、`last_inbound_at>0`、未冷却、
`keepalive_last_sent_at < last_inbound_at`、`now-last_inbound_at ∈ [window-lead, window)`。
不满足（含窗口已过期）不会发送。发送走 outbox（source=`keepalive`），受每账号限流。

**curl 示例**

```bash
# 对单个用户开启保活
curl -X PATCH http://localhost:10380/api/admin/users/u_xxxxxxxx/keepalive \
  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin" \
  -H "Content-Type: application/json" -d '{"enabled":true}'

# 对分组批量开启
curl -X POST http://localhost:10380/api/admin/groups/grp_xxxxxxxx/keepalive \
  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin" \
  -H "Content-Type: application/json" -d '{"enabled":true}'
```

## 9. 接口应用（关键词触发 → 外部 HTTP 接口 → 解析回复）

完整契约见 [`docs/API_RULES.md`](API_RULES.md)。后台配置规则：命中「指定用户/分组 + 关键词/正则」的
入站文本消息 → 提取参数 → 调用外部 HTTP 接口 → 解析响应并回复该用户。

**管理端接口（Cookie + CSRF）**

```
GET    /api/admin/app-rules?includeDisabled=1     → { items:[RuleView] }
POST   /api/admin/app-rules                        → 201 { rule }
GET    /api/admin/app-rules/{id}                   → { rule }
PATCH  /api/admin/app-rules/{id}                   → { rule }
DELETE /api/admin/app-rules/{id}                   → 204
POST   /api/admin/app-rules/{id}/test              → 200（dry-run：不发送、不写运行日志）
  Body: {"message":"查天气 北京","userId":"u_…"}
  Resp: {"matched":true,"ruleId":"…","params":{"arg":"北京"},
         "request":{"method":"GET","url":"…","headerNames":["Authorization"],"bodyPreview":""},
         "httpStatus":200,"latencyMs":123,"responsePreview":"…","replyText":"…","error":""}
GET    /api/admin/app-rule-logs?ruleId=&status=&userId=&limit=&offset=
  → { total, items:[{id,ruleId,ruleName,userId,status,httpStatus,latencyMs,error,
                      paramsPreview,requestPreview,responsePreview,replyOutboxId,createdAt}] }
```

RuleView 关键字段：`scope{type,ids,names}`、`trigger{matchMode,keywords,regexPattern}`、
`extraction{mode,config}`、`request{method,url,headerNames,bodyTemplate}`、
`response{type,path,template,fallbackText}`、`limits{timeoutMs,cooldownMs,maxCallsPerHour,
maxUserCallsPerHour}`、`stats{lastRunAt,lastStatus,success24h,failed24h,skipped24h}`。
**Header 值只写不读**（落库 AES-256-GCM 加密，读取只返回 `requestHeaderNames`）。

**触发/模板语法**

- 匹配：`contains`（大小写不敏感）/`equals`/`regex`；范围 `all|users|groups`（分组为本系统用户分组）；
  一消息命中多条规则时按 `priority` 升序**只执行第一条**。
- 参数提取：`none`（不提取，直接调用接口）、`trailing`（关键词后文本，参数默认 `arg`）、`regex`（命名捕获组）、`json`（消息体为
  JSON 对象时取顶层字段）、`fulltext`（整句）、`multi`（多参数组合：`extractors` 多项合并 + `required` 必填）；
  内置变量 `{text}`/`{userId}`/`{name}`/`{now}`（完整配置见 [`docs/API_RULES.md`](API_RULES.md) §3）。
- 请求：URL/Header/Body 模板用 `{变量}`；GET 参数自动 URL 编码；POST 发 body。
- 响应：`json` 按点路径（如 `data.answer`）或 `text`；回复模板用 `{{路径}}`（如 `{{data.answer}}`），
  列表支持 `{{count data.list}}` 与 `{{#each data.list}}{{字段}}{{/each}}`（`@index`/`@number`，单层，
  可用 `where 字段=值`/`!=` 过滤）；为空时用解析结果；可配置兜底文案。
- 限制：同用户同规则冷却（默认 10s）、规则/用户每小时上限、入站消息+规则去重、超时/响应大小限制。
- 安全：默认拒绝访问内网/本机（SSRF）；需要访问内网接口时在 `APP_RULES_ALLOWED_HOSTS` 加白名单。

**配置（环境变量）**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APP_RULES_ENABLED` | `true` | 规则引擎全局开关 |
| `APP_RULE_TIMEOUT_MS` | `8000` | 单次接口超时上限 |
| `APP_RULE_MAX_RESPONSE_BYTES` | `1048576` | 响应体大小上限 |
| `APP_RULES_WORKER_CONCURRENCY` | `2` | 规则执行并发数 |
| `APP_RULES_ALLOWED_HOSTS` | 空 | 允许访问的内网/本机主机白名单（逗号分隔） |
| `APP_RULE_MAX_QUEUE` | `200` | 内存队列上限 |

**curl 示例**

```bash
# 1) 创建规则：查天气（关键词后文本作为 arg，调用外部 API 并解析 data.answer 回复）
curl -X POST http://localhost:10380/api/admin/app-rules \
  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin" \
  -H "Content-Type: application/json" -d '{
    "name":"查天气","enabled":true,"priority":100,
    "scope":{"type":"all"},
    "matchMode":"contains","keywords":["查天气"],
    "extraction":{"mode":"trailing","config":{"param":"arg"}},
    "request":{"method":"GET","url":"https://api.example.com/weather?city={arg}","headers":{}},
    "response":{"type":"json","path":"data","template":"{{data.answer}}","fallbackText":"暂时无法查询天气"},
    "timeoutMs":8000,"cooldownMs":10000,"maxCallsPerHour":60,"maxUserCallsPerHour":10
  }'

# 2) 测试运行（dry-run，不发用户）
curl -X POST http://localhost:10380/api/admin/app-rules/rule_xxxxxxxx/test \
  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin" \
  -H "Content-Type: application/json" -d '{"message":"查天气 北京"}'

# 3) 查看运行日志
curl "http://localhost:10380/api/admin/app-rule-logs?limit=20" \
  -H "Cookie: cb_session=$ADMIN_COOKIE"
```

## 10. 定时通知（Scheduled Notifications）

完整契约见 [`docs/SCHEDULED_TASKS.md`](SCHEDULED_TASKS.md)：按计划定时调用外部接口 → 解析返回 →
把结果通过微信发送给指定用户/分组（无需用户先发消息）。

**管理端接口（Cookie + CSRF）**

```
GET    /api/admin/scheduled-tasks                    → { items:[TaskView] }
POST   /api/admin/scheduled-tasks                    → 201 { task }
GET    /api/admin/scheduled-tasks/{id}               → { task }
PATCH  /api/admin/scheduled-tasks/{id}               → { task }
DELETE /api/admin/scheduled-tasks/{id}               → 204
POST   /api/admin/scheduled-tasks/{id}/test          → 200（dry-run：真实调用接口渲染通知，不发送不写日志）
POST   /api/admin/scheduled-tasks/{id}/run           → 200（立即执行一次：调用+发送+写日志+更新下次时间）
GET    /api/admin/scheduled-task-logs?taskId=&status=&limit=&offset=
```

TaskView 关键字段：`schedule{type,intervalMs,dailyTime,timezone}`、`targets{type,ids,names}`、
`request{method,url,headerNames,bodyTemplate}`、`response{type,path,template,fallbackText}`、
`nextRunAt/lastRunAt/lastStatus`。Header 值加密保存、读取只返回名称。

**计划**：`interval`（每 N 分钟，60s–30d）或 `daily`（每天 HH:mm，时区 `SCHEDULER_TIMEZONE`，默认 Asia/Shanghai）；
任务执行后写 `nextRunAt`，服务重启时过期任务补跑一次（避免漏发）。

**发送**：解析成功后按回复模板（`{{path}}`/`{{response}}`/`{{raw}}`）渲染通知文本，
对目标用户逐个入队 outbox（source=`schedule`），复用现有微信限流；失败时若配置了兜底文案也发送，
否则本次不发送。目标 = 指定用户或指定分组内 `active` 用户（去重、上限 `SCHEDULER_MAX_RECIPIENTS`）。
`POST /:id/run` 的 `status=success` 仅表示外部调用成功且通知已入队，实际微信送达由队列异步完成；
删除任务不会级联删除历史运行日志（审计保留）。

**配置（环境变量）**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SCHEDULER_ENABLED` | `true` | 调度器全局开关 |
| `SCHEDULER_TICK_MS` | `15000` | 扫描间隔 |
| `SCHEDULER_TIMEZONE` | `Asia/Shanghai` | 每日任务时区（IANA） |
| `SCHEDULER_MAX_RECIPIENTS` | `200` | 单任务单次最多收件人数 |
| `SCHEDULER_TIMEOUT_MS` | `8000` | 外部请求超时上限 |

**curl 示例**

```bash
# 创建每天 08:00 给分组推送天气的任务
curl -X POST http://localhost:10380/api/admin/scheduled-tasks \
  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin" \
  -H "Content-Type: application/json" -d '{
    "name":"每天天气推送","enabled":true,
    "schedule":{"type":"daily","dailyTime":"08:00"},
    "targets":{"type":"groups","ids":["grp_xxxxxxxx"]},
    "request":{"method":"GET","url":"https://api.example.com/weather?city=北京","headers":{}},
    "response":{"type":"json","path":"","template":"{{city}} 今天 {{weather}}，{{temp_min}}~{{temp_max}}℃","fallbackText":"天气获取失败"},
    "timeoutMs":8000
  }'

# 测试运行（dry-run，不发用户）/ 立即执行一次
curl -X POST http://localhost:10380/api/admin/scheduled-tasks/task_xxxxxxxx/test -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin"
curl -X POST http://localhost:10380/api/admin/scheduled-tasks/task_xxxxxxxx/run  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin"
```

## 11. 运行配置（后台可改设置）

完整契约见 [`docs/SETTINGS.md`](SETTINGS.md)。可用参数从 `.env`（首次默认值）迁移到数据库
（schema v8 `app_settings`），管理员在后台「运行配置」修改，DB 持久化，尽量即时生效。

**可后台修改**：推送/限流（rateLimitMax/window/maxAttempts/retryDelaysMs/apiRateLimitPerMinute/maxTextLength）、
会话保活（enabled/windowMs/leadMs/tickMs/text/maxPerTick）、接口应用（enabled/timeoutMs/maxResponseBytes/
workerConcurrency/allowedHosts/maxQueue）、定时通知（enabled/tickMs/timezone/maxRecipients/timeoutMs）、
媒体（maxBytes/inboundMaxBytes）、绑定（ttlMs/maxRefreshes/maxActive/ipLimitPerHour/verifyTimeoutMs）。

**仍只由 .env 管理（启动必须）**：`APP_SECRET`、`DATA_DIR`、`MEDIA_DIR`、`PORT`、`HOST`、`NODE_ENV`。
管理密码/API Token 由 DB 管理（后台「安全」卡片，首启自动生成）；其余运行参数均可在后台修改。

```
GET   /api/admin/settings            → { groups:[...], envOnly:[...] }
PATCH /api/admin/settings            Body: {"appRules":{"allowedHosts":["192.168.88.10"]}}
  → 200 { ok:true, groups:[...], restartRequired:[...] }
POST  /api/admin/settings/reset      Body: {"group":"appRules"} → 200 { ok:true, groups:[...] }
```

```bash
# 在后台允许访问内网接口（替代 .env 的 APP_RULES_ALLOWED_HOSTS）
curl -X PATCH http://localhost:10380/api/admin/settings \
  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin" \
  -H "Content-Type: application/json" \
  -d '{"appRules":{"allowedHosts":["192.168.88.10"]}}'

# 恢复接口应用组的默认值（清空白名单，重新拒绝私网）
curl -X POST http://localhost:10380/api/admin/settings/reset \
  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin" \
  -H "Content-Type: application/json" -d '{"group":"appRules"}'
```

## 12. 系统重启（重启容器）

运行配置页顶部「重启容器」按钮使用。仅 **生产容器环境**（`NODE_ENV=production` 且检测到容器
`/.dockerenv` 或 `DATA_DIR=/app/data`）可用；进程收到 SIGTERM 优雅退出后由 Docker
`restart: unless-stopped` 自动拉起（通常 5-15 秒不可用）。测试/非容器环境返回 409，避免误杀进程。

```
POST /api/admin/system/restart     (Cookie + CSRF；无请求体)
  → 202 { ok:true, message:"容器将在约 1 秒后重启，请稍候刷新页面", etaSeconds:10 }
  → 409 { error:{ code:"CONFLICT", message:"当前非生产容器运行环境…" } }
  → 429 重启请求过于频繁（15 秒冷却）
```

```bash
curl -X POST http://localhost:10380/api/admin/system/restart \
  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin"
```

前端点击后轮询 `GET /health`，恢复后自动刷新页面；设置的 DB 覆盖会经 `loadOverrides()` 在重启后重新生效。

## 13. 安全设置（管理密码 / API Token 后台管理）

运行配置页「安全」卡片使用；**仅存 DB，不再读取 `.env` 的 ADMIN_PASSWORD/API_TOKEN**，也不做旧版迁移。
首次启动自动生成随机密码/Token（写入 `data/admin-password.txt`、`data/api-token.txt`）。
**任何接口都不返回密码哈希或 Token 明文**（仅 preview/来源）。

```
POST /api/admin/security/password        Body: {currentPassword,newPassword}
  → 200 { ok:true, adminPasswordSource:"db" }   // 当前密码错误 401/400，new 长度 8..128
POST /api/admin/security/password/reset  Body: {currentPassword}
  → 200 { ok:true, password:"随机新密码（仅此一次）", source:"db" }
  // 校验当前密码后生成新随机密码，写 DB + data/admin-password.txt
POST /api/admin/security/api-token/rotate
  → 200 { ok:true, token:"cb_…（仅此一次）", apiTokenPreview, apiTokenSource:"db" }
POST /api/admin/security/api-token/reset
  → 200 { ok:true, token:"cb_…（仅此一次）", apiTokenPreview, apiTokenSource:"db" }
  // 同样生成新 token，写 DB + data/api-token.txt；旧 token 立即失效
```

- 推送 API 开关：`PATCH /api/admin/settings` `{ "security": { "pushApiEnabled": true } }`。
- 会话 TTL：`security.sessionTtlMs`（登录时生效）；修改密码不会强制已登录会话立即下线。
- GET `/api/admin/settings` 增加 `security: {adminPasswordSource:'db', apiTokenSource:'db', apiTokenPreview,
  pushApiEnabled, sessionTtlMs}`；`envOnly` 为 `APP_SECRET`、`DATA_DIR`、`MEDIA_DIR`、`PORT`、`HOST`、`NODE_ENV`。







