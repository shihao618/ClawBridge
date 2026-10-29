# 多媒体资源支持设计（图片 / 文件 / 视频）

> 本文档是「ClawBridge 增加图片等多媒体资源」的实现契约。协议事实整理自微信官方
> `@tencent-weixin/openclaw-weixin@2.4.10`（MIT）的 `src/cdn/*`、`src/messaging/send.ts`、
> `src/media/media-download.ts`。文本协议见 `docs/PROTOCOL.md`，HTTP API 约定见 `docs/API.md`。

## 0. 范围

| 方向 | 支持类型 | 说明 |
| --- | --- | --- |
| 出站（发送） | 图片 `image/*`、视频 `video/*`、普通文件（pdf/zip/docx/mp3…） | 可选文字 caption（先发文字、再发媒体，与官方一致）；按 MIME/扩展名自动路由。音频文件按**普通文件**发送（微信语音气泡需要 SILK 转码，不支持） |
| 入站（接收） | 图片、文件、视频 | 自动从微信 CDN 下载 + AES-128-ECB 解密 + 落盘；后台可预览/下载 |
| 入站（接收） | 语音 | 记录消息与附件元数据，保存解密后的原始 SILK 文件（`kind=voice`，不转码、不出站） |
| 出站 | 语音气泡 | **不支持**（需 silk 转码依赖，暂不做；若用户上传音频文件，按普通文件发送） |

缩略图：出站统一 `no_need_thumb: true`（官方上传原文件即可）；入站不下载缩略图（只取原图/原文件）。

## 1. 协议：CDN 上传（出站）

### 1.1 申请上传地址

```
POST {baseUrl}/ilink/bot/getuploadurl
Header: 带 bot_token 的公共头（同 docs/PROTOCOL.md §3）
Body:
{
  "filekey": "<32 hex 随机>",
  "media_type": 1 | 2 | 3,          // 1=IMAGE 2=VIDEO 3=FILE
  "to_user_id": "<ilink_user_id>",
  "rawsize": 123456,                 // 明文字节数
  "rawfilemd5": "<md5 hex>",         // 明文 MD5
  "filesize": 123472,                // AES-128-ECB(PKCS7) 密文字节数
  "no_need_thumb": true,
  "aeskey": "<32 hex>",              // AES-128 key，hex 编码
  "base_info": {...}
}
Resp:
{ "ret": 0, "upload_param": "…", "thumb_upload_param": "", "upload_full_url": "https://…" }
```

`upload_full_url` 优先；否则客户端拼接
`{cdnBaseUrl}/upload?encrypted_query_param={upload_param}&filekey={filekey}`。

### 1.2 上传密文到 CDN

```
POST {upload_full_url | 拼接 URL}
Header: Content-Type: application/octet-stream
Body: AES-128-ECB(明文, aeskey) 的密文（PKCS7 padding）
Resp: 200；响应头 x-encrypted-param = <下载参数 encrypt_query_param>
```

- 4xx 视为客户端错误不重试；5xx/网络错误最多重试 3 次。
- CDN 默认基址：`https://novac2c.cdn.weixin.qq.com/c2c`（`ILINK_CDN_BASE_URL` 可覆盖）。

### 1.3 发送媒体消息

复用 `POST {baseUrl}/ilink/bot/sendmessage`，`msg` 结构与文本一致，`item_list` 只放**一个**媒体 item（若有 caption，先单独发一条文本消息）：

```jsonc
// 图片
{"msg":{"from_user_id":"","to_user_id":"<user>","client_id":"cb-…","message_type":2,"message_state":2,
 "item_list":[{"type":2,"image_item":{
   "media":{"encrypt_query_param":"<x-encrypted-param>","aes_key":"<base64(hex 字符串)>","encrypt_type":1},
   "mid_size": <密文字节数>}}],
 "context_token":"…"}}

// 视频
{"msg":{…,"item_list":[{"type":5,"video_item":{
   "media":{"encrypt_query_param":"…","aes_key":"<base64(hex 字符串)>","encrypt_type":1},
   "video_size": <密文字节数>}}], …}}

// 文件
{"msg":{…,"item_list":[{"type":4,"file_item":{
   "media":{"encrypt_query_param":"…","aes_key":"<base64(hex 字符串)>","encrypt_type":1},
   "file_name":"报告.pdf","len":"<明文字节数，字符串>"}}], …}}
```

> **重要（踩坑记录）**：出站三种 item 的 `aes_key` 都是 **base64(32 字符 hex key 字符串的 ASCII 字节)**，
> 即 `Buffer.from(aeskeyHex, 'utf8').toString('base64')`，**不是** base64(原始 16 字节 key)。
> 依据：官方 `@tencent-weixin/openclaw-weixin` 的 `send.ts` 中
> `Buffer.from(uploaded.aeskey).toString("base64")`（`uploaded.aeskey` 为 hex 字符串），
> 以及可用的第三方实现 `@claw-lab/wxclawbot-cli` 同样处理。若错误地传 base64(raw key)，
> 接收端微信解密失败，表现为：**图片显示灰色占位、文件点“接收”提示已过期、文件消息甚至不显示**。
> 入站解析则两种形态都要兼容（见 §2）。

## 2. 协议：CDN 下载（入站）

`getupdates` 的消息 `item_list` 中媒体 item 形如：

```jsonc
// 图片（aeskey 为 hex，media.aes_key 为 base64(raw key)，优先 aeskey）
{"type":2,"image_item":{"media":{"encrypt_query_param":"…","aes_key":"…","encrypt_type":1,
  "full_url":"https://…（可选，优先使用）"},"aeskey":"<32 hex>","mid_size":1024}}
// 语音
{"type":3,"voice_item":{"media":{"encrypt_query_param":"…","aes_key":"…"},"encode_type":6,"playtime":1234,"text":"语音转文字"}}
// 文件
{"type":4,"file_item":{"media":{"encrypt_query_param":"…","aes_key":"…"},"file_name":"a.pdf","md5":"…","len":"12345"}}
// 视频
{"type":5,"video_item":{"media":{"encrypt_query_param":"…","aes_key":"…"},"video_size":123456}}
```

下载规则：

- URL：优先 `media.full_url`；否则 `{cdnBaseUrl}/download?encrypted_query_param={encrypt_query_param}`。
- AES key 解析（`media.aes_key` 的 base64 解码后可能是两种形态）：
  - 16 字节 → 直接作为 key（图片常见）；
  - 32 字节且为 ASCII hex → 再把 hex 解析成 16 字节 key（文件/语音/视频常见）；
  - 图片若 `image_item.aeskey`（hex）存在则优先。
- AES-128-ECB + PKCS7 解密。
- 单个文件上限默认 100MB（`INBOUND_MEDIA_MAX_BYTES`），下载超时 60s；失败只记录日志，不影响消息本身入库。

## 3. 存储与配置

### 3.1 目录

```
DATA_DIR/
  media/
    outbound/<attachmentId><ext>    # 管理员/API 上传的待发送文件
    inbound/<attachmentId><ext>     # 从微信下载解密后的文件
```

目录在启动时创建（0700），文件写入 0600（`process.umask(0o077)`）；文件名为随机 `att_<uuid>`，原始文件名只存 DB。

### 3.2 配置（config.js 新增）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ILINK_CDN_BASE_URL` | `https://novac2c.cdn.weixin.qq.com/c2c` | 微信 CDN 基址 |
| `MEDIA_DIR` | `{DATA_DIR}/media` | 媒体文件目录 |
| `MEDIA_MAX_BYTES` | `26214400`（25MB） | 出站单文件上限 |
| `INBOUND_MEDIA_MAX_BYTES` | `104857600`（100MB） | 入站单文件上限 |
| `MEDIA_DOWNLOAD_TIMEOUT_MS` | `60000` | 入站下载超时 |
| `MEDIA_UPLOAD_TIMEOUT_MS` | `60000` | 出站 CDN 上传超时 |
| `MEDIA_ALLOWED_IMAGE_MIME` / `MEDIA_ALLOWED_VIDEO_MIME` | 常见 image/video 类型 | 逗号分隔，未命中按普通文件发送 |

`config.media = { dir, outboundMaxBytes, inboundMaxBytes, downloadTimeoutMs, uploadTimeoutMs }`，
`config.ilink.cdnBaseUrl`。

## 4. 数据库 Schema v2（additive migration，必须保留既有 users/outbox/inbound 数据）

```sql
-- 新表
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,                    -- 'att_<uuid>'
  direction TEXT NOT NULL,                -- 'inbound' | 'outbound'
  kind TEXT NOT NULL,                     -- 'image' | 'video' | 'file' | 'voice'
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_name TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,        -- 明文字节数
  path TEXT NOT NULL,                     -- 相对 MEDIA_DIR，如 'outbound/att_x.jpg'
  sha256 TEXT NOT NULL DEFAULT '',
  user_id TEXT,
  outbox_id TEXT,                         -- 出站：关联 outbox.id（入队时写入）
  inbound_message_id TEXT,                -- 入站：关联 inbound_messages.id
  wechat_message_id TEXT,                 -- 入站：微信 message_id（便于追溯）
  error TEXT NOT NULL DEFAULT '',         -- 入站下载失败时的原因（此时无文件，status='failed'）
  status TEXT NOT NULL DEFAULT 'ready',   -- 'ready' | 'failed'
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_outbox ON attachments(outbox_id);
CREATE INDEX IF NOT EXISTS idx_attachments_inbound ON attachments(inbound_message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id, created_at DESC);

-- outbox 扩展
ALTER TABLE outbox ADD COLUMN media_id TEXT;                     -- attachments.id
ALTER TABLE outbox ADD COLUMN caption_sent_at INTEGER NOT NULL DEFAULT 0;
```

迁移逻辑（`db.js`，保持幂等）：

1. `CREATE TABLE IF NOT EXISTS attachments(...)`；
2. 用 `PRAGMA table_info(outbox)` 检查列，缺失才 `ALTER TABLE ... ADD COLUMN`；
3. `meta.schema_version = 2`；
4. 启动日志打印迁移结果。**必须用现有真实 v1 数据库副本验证迁移后 users/outbox/inbound 数量不变。**

### 4.1 store.js 新增/调整

- `createAttachment({...})`、`getAttachment(id)`、`getAttachmentByOutbox(outboxId)`、`getAttachmentsByInbound(inboundIds[])`、`linkAttachmentOutbox(attachmentId, outboxId)`、`markAttachmentSent/Failed`（如需要）。
- `enqueueMessage({userId, text, source, mediaId})` / `enqueueMany` 支持 `mediaId`，写入 `outbox.media_id` 并回填 `attachments.outbox_id`。
- `getNextQueuedCandidate` 返回 `media_id`、`caption_sent_at`。
- `markCaptionSent(outboxId)`。
- `getOutbox`/管理端与 v1 的 outbox 视图、`listMessages` 的每条记录输出 `attachments`：
  ```json
  "attachments":[{"id":"att_…","kind":"image","mime":"image/jpeg","fileName":"a.jpg",
                  "size":12345,"url":"/api/admin/media/att_…","downloadUrl":"/api/admin/media/att_…?download=1",
                  "status":"ready"}]
  ```
- `getRecentInbound/getRecentOutbound` 同样附带 attachments。

## 5. HTTP API 扩展

### 5.1 上传媒体（管理后台）

```
POST /api/admin/media
Header: Cookie（admin 会话）、X-Requested-With: ClawBridge-Admin
Header: Content-Type: <文件 MIME>；X-File-Name: <URL 编码的原始文件名>
Body: 文件原始二进制（非 multipart；最大 MEDIA_MAX_BYTES）
Resp 201:
{ "media": { "id":"att_…", "kind":"image|video|file", "mime":"image/jpeg",
             "fileName":"a.jpg", "size":12345, "url":"/api/admin/media/att_…" },
  "limits": { "maxBytes":26214400, "allowedImage":["image/jpeg",…] } }
错误：400（缺少文件名/类型不支持）、413（超过上限）、401（未登录）。
```

说明：采用「原始二进制 + 头」上传（零新增依赖、前端 `fetch(body: File)` 直接可用）；
`X-File-Name` 用 `encodeURIComponent` 编码，服务端 `decodeURIComponent` 还原并做文件名安全清洗。

### 5.2 发送（带媒体）

`POST /api/admin/users/{id}/messages` 请求体扩展：

```json
{ "text": "看图", "mediaId": "att_xxx" }   // text 与 mediaId 至少一个；text 作 caption
```

- 有 `mediaId`：校验附件存在、`direction=outbound`、`status=ready`；入队 outbox（text 可空）。
- 响应 queued 项增加 media 摘要：

```json
{"queued":[{"outboxId":"ob_…","userId":"u_…","status":"queued",
  "media":{"id":"att_…","kind":"image","fileName":"a.jpg","size":12345,
           "url":"/api/admin/media/att_…"}}]}
```

- `POST /api/v1/messages` 同样支持 `mediaId`（可对多个 `to` 使用同一 mediaId，服务端按收件人分别上传）。
- 广播仍只支持文本（文档写明）。

### 5.3 上传媒体（对外 API）

```
POST /api/v1/media        Header: Authorization: Bearer <API_TOKEN> 或 X-Api-Key
                          Content-Type / X-File-Name 同上
→ 201 {"media":{...}, "limits":{...}}
```

### 5.4 读取媒体文件

```
GET /api/admin/media/{attId}          # admin Cookie 鉴权（<img>/<video> 同源可直接引用）
GET /api/v1/media/{attId}            # API Key 鉴权，供外部系统拉取
Query: ?download=1 → Content-Disposition: attachment（默认 image/video inline，其他 attachment）
```

- 响应：`Content-Type`、`Content-Length`、`Content-Disposition`、`Cache-Control: private, max-age=3600`；
  支持 Range 请求（视频拖动进度条）；文件不存在返回 404。
- 路径必须来自 DB 且限制在 `MEDIA_DIR` 内（防目录穿越）。

### 5.5 配置接口补充

`GET /api/admin/config` 增加：

```json
"media": { "maxBytes":26214400, "inboundMaxBytes":104857600,
           "allowedImage":["image/jpeg",…], "allowedVideo":["video/mp4",…], "dir":"/app/data/media" }
```

### 5.6 错误格式

沿用统一 `{error:{code,message}}`；新增 `413` 使用 `code=BAD_REQUEST`（message 说明超过上限）。

## 6. 出站队列行为（dispatcher.js）

单条 outbox 可能产生 **最多 2 次 sendmessage**（caption + 媒体），每次发送都消耗一次账号限流令牌。

处理顺序（`processOne`）：

1. 用户/冷却检查（同现有逻辑）；
2. `text` 非空且 `caption_sent_at=0` → 取得 1 个限流令牌 → `ilink.sendText` → `markCaptionSent`；
3. 有 `mediaId`：
   a. 取 1 个限流令牌（无配额 → 推迟该账号 queued，**不**标记失败）；
   b. 读附件文件 → 按 MIME 归类（image/video/file）；
   c. `ilink.getUploadUrl` → AES-128-ECB 加密 → CDN 上传拿 `x-encrypted-param`；
   d. `ilink.sendMediaMessage`（构造 image_item / video_item / file_item）；
   e. 成功 → `markOutboxSent`（server_message_id）+ `touchOutbound` + 事件/日志；
4. 失败：
   - `-2`：退避重试（caption 不重发，`caption_sent_at` 已记录）；
   - `-14`：现有冷却逻辑（失败该条 + 其余 queued）；
   - 其他：按 `PUSH_MAX_ATTEMPTS` 退避重试，媒体每次重试重新上传（官方无上传幂等接口）；
   - 文件缺失/附件不存在：直接 `failed`，错误说明清楚（不重试）。
5. 媒体文件保留：发送成功后保留在 `DATA_DIR/media/outbound/`（便于审计/重发），不做自动删除；后续可加清理任务（不在本期范围）。

## 7. 入站处理（monitor.js）

`processMessages` 在保存入站消息后，对每个媒体 item：

1. 解析 item → `{kind, media, fileName, mime}`（按 item 类型；图片/文件/视频/语音）；
2. 下载+解密（§2），超过 `inboundMaxBytes` 或超时 → 记录 `attachments.status='failed', error=…`（不抛错）；
3. 成功 → 保存文件到 `media/inbound/<id><ext>`、`sha256` 记录、`attachments` 行（`direction=inbound`, 关联 `inbound_message_id`、`wechat_message_id`）；
4. 同一消息多个媒体 item 逐个处理（最多 5 个，防御性上限）；
5. `raw_json` 脱敏扩展：把 `media.aes_key`、`image_item.aeskey` 也替换为 `[redacted]`（与 context_token 同级处理）；
6. 消息 `text` 仍为文本或 `[图片]/[视频]/[文件]/[语音]` 占位；`item_types` 保持。

## 8. 前端（web/admin.html + assets/admin.js）

- 发送弹窗：textarea（caption，可空）+ 文件选择（accept 不限，客户端校验 ≤ `maxBytes`）+ 选中预览
  （图片显示缩略图，视频/文件显示名称/大小）+ 上传进度/禁用态；发送时先上传得到 `mediaId`，再调发送接口；
  上传失败/超限给出明确 toast。
- 用户详情/消息记录列表中，每条消息渲染附件：
  - image → 缩略图（`<img>`，最大 160px，点击新窗口打开原图）；
  - video → `<video controls preload="metadata">`；
  - file/voice → 文件名 + 大小 + 下载链接（`?download=1`）；
  - 下载链接使用 `GET /api/admin/media/{id}`（Cookie 同源）。
- 运行配置/文档页：展示媒体限制与上传/发送示例（curl `--data-binary`）。
- 保持现有 CSP（`img-src 'self' data:` 已允许同源图片；`media-src` 需在 CSP 中允许 `'self'`）。
- 绑定页不变。

## 9. Mock 扩展（mock/ilink-mock.mjs，供 e2e/演示）

协议面新增：

- `POST /ilink/bot/getuploadurl`：校验鉴权与 body 结构；返回
  `{ret:0, upload_full_url: "<MOCK_PUBLIC_BASE_URL>/cdn/upload?filekey=…&mock_upload=1", upload_param:"mock_upload_param", thumb_upload_param:""}`；
  记录 `uploads[]`：`{filekey, mediaType, toUserId, rawsize, rawfilemd5, filesize, aeskey, botId}`；
- `POST /cdn/upload?filekey=…`：读取密文 body，按 aeskey 解密（mock 知道 getuploadurl 请求里的 hex key）并保存
  `{token, ciphertext, plaintextSha256, size}`；响应头 `x-encrypted-param: <token>`；
- `GET /cdn/download?encrypted_query_param=<token>`：返回对应密文字节（404 未知 token）。
- `sendmessage` 记录媒体消息结构（item_list 类型 2/4/5 及 media 参数），供断言。

控制面新增：

- `POST /__mock/accounts/{botId}/inbound-media`
  body: `{ "kind":"image|video|file|voice", "fileName":"a.png", "mime":"image/png",
           "contentBase64":"…", "fullUrl": false }`
  mock 用随机 AES-128 key 加密 content，登记 CDN token，并向该 bot 的入站队列注入一条带媒体 item 的
  WeixinMessage（图片用 `image_item.aeskey` hex + `media.aes_key` base64(raw key)，文件/视频/语音用
  `media.aes_key=base64(hex key)`；默认不带 full_url，`fullUrl:true` 时带上 mock CDN 完整地址）。
- `GET /__mock/state` 增加：`uploads[]`（含 `plainSha256`、`cipherSize`、`downloadUrl`）、`cdnFiles[]` 摘要、
  `sentMessages[].itemList`（含媒体类型与参数）。
- `POST /__mock/reset` 清空。
- `MOCK_AUTO_CONFIRM_MS` 演示逻辑不变。

## 10. 测试要求

- 单元（backend-dev）：
  - 媒体 crypto：AES-128-ECB 加解密、padded size、aes_key 两种 base64 形态解析、图片 aeskey hex 优先；
  - 上传管线：假 CDN 服务断言 getuploadurl body（md5/filesize/aeskey/media_type/to_user_id）、
    上传密文可被 key 解密、`x-encrypted-param` 写入消息；
  - DB 迁移 v1→v2：用 v1 schema 构造 DB（含 users/outbox/inbound 数据）→ 初始化后数据保留、新增表/列存在、幂等重跑；
  - dispatcher：caption 先发后发媒体、caption 失败不重复发（caption_sent_at）、-2 退避后只重试媒体、
    媒体附件缺失直接 failed、限流令牌消耗（2 次 sendmessage）；
  - inbound：假 CDN 下载+解密+落盘+attachment 行；超限/损坏数据记录 failed 不抛；raw_json 中 aes_key 脱敏。
- e2e（infra-dev）：
  - admin 上传图片（原始二进制）→ 201 → 发送 {text,mediaId} → mock CDN 收到密文且能解密匹配原图 →
    mock 记录 image_item（type=2, mid_size, aes_key=base64(32 字符 hex 字符串)）→ outbox sent/attempts=1；
  - 视频/文件同理（video_item.video_size、file_item.file_name/len）；
  - 入站：mock 注入 image/file/video → 后台消息记录附件可见 → `GET /api/admin/media/{id}` 返回字节与注入内容一致；
  - 鉴权：未登录/错误 API Key 访问上传/读取 401；超限 413；非 active 用户发送 409；
  - v1 上传 + 发送 + 读取；Range 请求（可选）。
- mock selftest 补充 CDN/媒体注入用例；`npm test` 全绿。

## 11. 兼容与回滚

- 迁移是 additive 的，v1 数据库可直接升级；旧 outbox 行 `media_id=NULL` 走原文本路径。
- 旧版前端（缓存）仍可只用文本发送（接口向后兼容：text 仍必填？→ 改为 text/mediaId 至少一个；纯文本调用不变）。
- 媒体目录位于 `DATA_DIR` 下，随命名卷 `clawbridge-data` 持久化；备份策略与 DB 相同。
