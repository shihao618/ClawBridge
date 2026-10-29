# mock/ilink-mock.mjs —— 微信 iLink API 模拟器

零依赖（仅 `node:http` / `node:crypto`）的本地微信 ClawBot（iLink Bot API）模拟服务，
用于 **本地开发、Docker 演示与 e2e 测试**：让 ClawBridge 无需真实微信即可跑通
「扫码绑定 → 入站长轮询 → 出站发送（文本 + 图片/视频/文件）→ 媒体 CDN 上传/下载」全链路。

- 协议依据：`docs/PROTOCOL.md`（端点 / 状态机 / 错误码 / 长轮询语义）、
  `docs/MEDIA.md`（多媒体 CDN 上传/下载与 mock 扩展契约 §9）
- 目标客户端：`server/src/ilink.js` / `server/src/media.js`（请求头、无损 ID 解析、
  baseurl 回连、AES-128-ECB 媒体加解密）

## 快速开始

```bash
# 手动模式（无自动扫码）：默认监听 0.0.0.0:3100
node mock/ilink-mock.mjs

# Docker demo 模式：每个新二维码 3s 后自动 扫码→确认，用户 id 依次递增
MOCK_AUTO_CONFIRM_MS=3000 node mock/ilink-mock.mjs

# e2e 模式：随机端口（实际端口见 stdout 的 {"event":"listening","port":...}）
PORT=0 node mock/ilink-mock.mjs

# 自测（启动子进程走完整协议面 + 控制面 + 媒体 CDN，25 项断言）
node mock/selftest.mjs
```

完整演示（app + mock 一起跑）见仓库根目录 `scripts/demo.ps1` / `scripts/demo.sh`。

## 协议面（与真实 iLink API 同路径）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/ilink/bot/get_bot_qrcode?bot_type=3` | 返回 `{qrcode, qrcode_img_content}`；`local_token_list` 会被记录用于 `binded_redirect` 判定 |
| GET | `/ilink/bot/get_qrcode_status?qrcode=…[&verify_code=…]` | 长轮询（默认挂起 ≤1s，仅 `wait` 状态）；状态机 `wait/scaned/need_verifycode/verify_code_blocked/expired/scaned_but_redirect/binded_redirect/confirmed`；`confirmed` 返回 `bot_token/ilink_bot_id/baseurl/ilink_user_id`，`baseurl` 默认由请求 Host 推导（`MOCK_PUBLIC_BASE_URL` 可覆盖） |
| POST | `/ilink/bot/getupdates` | 长轮询（默认挂起 ≤2s）；返回 `msgs/get_updates_buf/longpolling_timeout_ms`；消息 `message_id` 为 **>2^53 的 JSON number 字面量**（验证客户端无损解析）；`stale-token` 时返回 `ret=-14, errcode=-14` |
| POST | `/ilink/bot/sendmessage` | 校验 `Authorization: Bearer` / `AuthorizationType: ilink_bot_token` / `body.msg` 结构；记录 `to_user_id/text/context_token/client_id/headers`；返回 >2^53 的 `message_id`（number 字面量）；可注入 `-2/-14` 失败 |
| POST | `/ilink/bot/msg/notifystart` / `notifystop` | 计数（全局 + 每账号），返回 `{ret:0}` |
| POST | `/ilink/bot/getconfig` | 返回 `{ret:0, typing_ticket}` |
| POST | `/ilink/bot/sendtyping` | 记录最近一次 `status`，返回 `{ret:0}` |
| POST | `/ilink/bot/getuploadurl` | 出站媒体申请上传地址（docs/MEDIA.md §1）：校验鉴权与 body（filekey/media_type/to_user_id/rawsize/rawfilemd5/filesize/aeskey/no_need_thumb），返回 `{ret:0, upload_param, thumb_upload_param:"", upload_full_url}`；`upload_full_url` 指向本 mock 的 `/cdn/upload`（`MOCK_PUBLIC_BASE_URL` 或请求 Host 拼出，保证 app 可达），并记录到 `state.uploads[]` |

### CDN 面（出站上传 / 下载，mock 契约见 docs/MEDIA.md §9）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/cdn/upload?filekey=…` | 读取 AES-128-ECB/PKCS7 密文 body，用 `getuploadurl` 记录的 `aeskey`（hex）解密校验；保存 `{token, ciphertext, plaintextSha256, plainSize, cipherSize}`；响应头 `x-encrypted-param: <token>`；未知 filekey → 404，解密失败 → 400 |
| GET | `/cdn/download?encrypted_query_param=<token>` | 返回该 token 对应的**密文字节**（`application/octet-stream`）；未知 token → 404 |

`sendmessage` 对媒体 item（type 2/4/5，语音 3）额外记录归一化的 `itemList`：
`{type, kind, media:{encryptQueryParam, aesKey, encryptType, fullUrl}, midSize, videoSize, fileName, len, ...}`，
并校验出站媒体 `media.aes_key = base64(32 字符 hex key 的 ASCII 字节)`（44 字符 base64；接收端
base64 decode → 32 hex chars → hex decode 得 16 字节 key）、`encrypt_type=1`、
`mid_size/video_size>0`、`file_item.file_name/len` 等（违规写入 `rejections`）。

协议违规（缺公共头、缺 `base_info`、`from_user_id` 非空、`message_type!=2`、`to_user_id` 与绑定用户不一致、
`X-WECHAT-UIN` 非 base64(十进制) 等）默认 **只记录** 到 `/__mock/state.rejections`，不会拒绝；
鉴权失败（未知 token）返回 HTTP 401 `{ret:-14, errcode:-14}`。测试可断言 `rejections` 为空来验证客户端合规。

## 控制面 `/__mock/*`（测试/演示用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/__mock/health` | 存活探针 `{ok,status,version,port,...}` |
| GET | `/__mock/state` | 全量状态快照（见下） |
| POST | `/__mock/reset` | 清空全部状态并重置计数 |
| POST | `/__mock/qr/{qrcode}/scan` | 扫码（body 可带 `ilink_user_id`）→ `scaned` |
| POST | `/__mock/qr/{qrcode}/confirm` | 确认绑定 → `confirmed` 并创建 bot 账号；body 可带 `ilink_user_id`、`force:true`（模拟换绑） |
| POST | `/__mock/qr/{qrcode}/require-verify` | 进入 `need_verifycode`；body `{code}` 指定配对码，响应返回 `{code}`（默认随机 4 位） |
| POST | `/__mock/qr/{qrcode}/expire` | 二维码过期 → `expired` |
| POST | `/__mock/qr/{qrcode}/redirect` | 换 IDC → `scaned_but_redirect` + `redirect_host`；body `{redirect_host, times}` |
| POST | `/__mock/qr/{qrcode}/already-bound` | 已连接 → `binded_redirect` |
| POST | `/__mock/accounts/{botId}/inbound` | 注入入站消息：body `{text, context_token?, message_id?, from_user_id?, item_list?, repeat?}` |
| POST | `/__mock/accounts/{botId}/inbound-media` | 注入入站**媒体**消息：body `{kind:"image|video|file|voice", fileName?, mime?, contentBase64, fullUrl?, context_token?, message_id?}`。mock 用随机 AES-128 key 加密内容并登记 CDN token：图片 item 带 `image_item.aeskey`(hex) + `media.aes_key=base64(raw key)`；文件/视频/语音 item 带 `media.aes_key=base64(hex key)`；默认不带 `media.full_url`，`fullUrl:true` 时带 mock CDN 绝对地址。响应返回注入消息结构、`cdnFile` 摘要与原文 `contentSha256` |
| POST | `/__mock/accounts/{botId}/stale-token` | 模拟 bot_token 失效（getupdates/sendmessage 返回 -14） |
| POST | `/__mock/accounts/{botId}/clear-stale-token` | 清除失效标记 |
| POST | `/__mock/fail-next-send` | 后续发送注入失败：body `{ret:-2或-14, times, botId?, errmsg?}` |
| POST | `/__mock/shutdown` | 优雅退出（e2e 清理用） |

`{botId}` 也接受 `{bot_token}`（控制面两种定位方式均可，URL 含 `@` 时需 `encodeURIComponent`）。

### 状态快照字段（`GET /__mock/state`）

```jsonc
{
  "ok": true, "port": 3100, "autoConfirmMs": 0,
  "qrs": [{ "qrcode", "status", "baseUrl", "localTokenList", "verifyCode", "verifyAttempts",
            "ilinkUserId", "botId", "botToken", "polls", "createdAt", "expiresAt" }],
  "accounts": [{ "botId", "token", "ilinkUserId", "baseUrl", "notifyStart", "notifyStop",
                 "staleToken", "queuedMessages", "getUpdatesBuf", "inboundCount", "lastTypingStatus" }],
  "uploads": [{ "filekey", "mediaType", "kind", "toUserId", "rawsize", "rawfilemd5", "filesize",
                "aeskey", "noNeedThumb", "botId", "uploadFullUrl", "token", "plainSha256",
                "plainSize", "cipherSize", "downloadUrl", "createdAt", "uploadedAt" }],
  "cdnFiles": [{ "token", "filekey", "botId", "direction", "kind", "mime", "fileName",
                 "plainSize", "cipherSize", "plaintextSha256", "plaintextMd5", "downloadUrl", "createdAt" }],
  "sentMessages": [{ "botId", "toUserId", "text", "contextToken", "clientId", "messageId",
                     "messageType", "messageState", "fromUserId", "itemTypes", "itemList",
                     "headers", "baseInfo", "at" }],
  "notifyStart": 0, "notifyStop": 0,              // 全局次数
  "pollCounts": { "getBotQrcode", "qrStatus", "getUpdates", "getConfig", "sendTyping",
                  "notifyStart", "notifyStop", "sendMessage", "getUploadUrl",
                  "cdnUpload", "cdnDownload", "control" },
  "counts": { "qrCreated", "qrAutoConfirmed", "inboundInjected", "inboundMediaInjected",
              "uploadsCreated", "cdnUploads", "cdnDownloads", "sendAttempts",
              "sendSucceeded", "sendFailed", "resets" },
  "failedSends": [{ "botId", "ret", "errmsg", "text", "at" }],
  "failNextSend": [...], "rejections": [...],
  "getUpdatesBufs": { "<botId>": "<buf>" }
}
```

> 快照中 `messageId` 为字符串（避免测试侧 `JSON.parse` 丢精度）；协议响应中的 `message_id` 是 number 字面量。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `3100` / `0.0.0.0` | 监听地址；`PORT=0` 随机端口 |
| `MOCK_AUTO_CONFIRM_MS` | `0` | >0 时新二维码自动 scan（N ms 后）+ confirm（再 min(N,1000) ms 后），用户 id 递增 |
| `MOCK_QR_POLL_MS` | `1000` | `get_qrcode_status` 挂起上限（仅 wait 状态） |
| `MOCK_LONGPOLL_MS` | `2000` | `getupdates` 挂起上限 |
| `MOCK_LONGPOLLING_TIMEOUT_MS` | `35000` | 响应里的 `longpolling_timeout_ms` |
| `MOCK_QR_TTL_MS` | `300000` | 二维码有效期 |
| `MOCK_VERIFY_MAX_ATTEMPTS` | `3` | 配对码最大错误次数 → `verify_code_blocked` |
| `MOCK_VERIFY_CODE` | 随机 4 位 | `require-verify` 默认配对码 |
| `MOCK_PUBLIC_BASE_URL` | 由请求 Host 推导 | `confirmed.baseurl` 覆盖值（Docker demo：`http://mock-ilink:3100`） |
| `MOCK_STRICT` | `0` | `1` 时协议结构错误直接拒绝（默认只记录） |
| `MOCK_QUIET` | `0` | `1` 时不打印每请求 HTTP 日志 |
| `MOCK_MEDIA_MAX_BYTES` | `104857600`（100MB） | `inbound-media` 注入内容上限（超出 413） |

## curl 演示（手动模式）

```bash
# 1) 生成二维码
curl -s -X POST 'http://127.0.0.1:3100/ilink/bot/get_bot_qrcode?bot_type=3' \
  -H 'Content-Type: application/json' -d '{"local_token_list":[]}'
# → {"qrcode":"qr_...","qrcode_img_content":"http://127.0.0.1:3100/mock-bind?qrcode=qr_..."}

# 2) 控制面：扫码 + 确认（模拟手机微信操作）
curl -s -X POST 'http://127.0.0.1:3100/__mock/qr/<qrcode>/scan'
curl -s -X POST 'http://127.0.0.1:3100/__mock/qr/<qrcode>/confirm'

# 3) 轮询状态 → confirmed 返回 bot_token/baseurl/ilink_user_id
curl -s 'http://127.0.0.1:3100/ilink/bot/get_qrcode_status?qrcode=<qrcode>'

# 4) 注入一条入站消息（app 侧会落库并缓存 context_token）
curl -s -X POST 'http://127.0.0.1:3100/__mock/accounts/<botId>/inbound' \
  -H 'Content-Type: application/json' -d '{"text":"你好"}'

# 5) 查看状态：accounts / sentMessages / notifyStart / pollCounts / uploads / cdnFiles
curl -s 'http://127.0.0.1:3100/__mock/state'
```

## curl 演示：媒体 CDN（出站上传 + 入站注入）

```bash
# A) 出站：申请上传地址（aeskey 需与下面加密使用的 key 一致；filekey 32 hex）
curl -s -X POST 'http://127.0.0.1:3100/ilink/bot/getuploadurl' \
  -H 'Authorization: Bearer <bot_token>' -H 'AuthorizationType: ilink_bot_token' \
  -H 'Content-Type: application/json' \
  -d '{"filekey":"<32hex>","media_type":1,"to_user_id":"<ilink_user_id>",
       "rawsize":4,"rawfilemd5":"<md5(明文)>","filesize":16,"no_need_thumb":true,
       "aeskey":"<32hex>","base_info":{}}'
# → {"ret":0,"upload_param":"…","thumb_upload_param":"","upload_full_url":"http://127.0.0.1:3100/cdn/upload?filekey=…&mock_upload=1"}
# 用 aeskey 做 AES-128-ECB/PKCS7 加密后上传密文（可用 node -e 构造）：
#   curl -s -X POST '<upload_full_url>' -H 'Content-Type: application/octet-stream' --data-binary @cipher.bin -D -
# → 响应头 x-encrypted-param: mock_cdn_…（发送 image_item 时填入 media.encrypt_query_param）
# 下载密文核对：
curl -s 'http://127.0.0.1:3100/cdn/download?encrypted_query_param=<token>' -o cipher.bin

# B) 入站：注入一条图片媒体消息（app 会下载解密并落盘/后台可见）
curl -s -X POST 'http://127.0.0.1:3100/__mock/accounts/<botId>/inbound-media' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"image","fileName":"a.png","mime":"image/png","contentBase64":"<base64(原图)>"}'
# → {"ok":true,"kind":"image","message":{"item":{...image_item...}},"cdnFile":{...,"plaintextSha256":"…"}}
```

## e2e 集成约定

- 用 `spawn(process.execPath, ['mock/ilink-mock.mjs'], { env: { PORT: '0', HOST: '127.0.0.1',
  MOCK_QUIET: '1', MOCK_QR_POLL_MS: '300', MOCK_LONGPOLL_MS: '500' } })` 启动；
- 读取 stdout 第一行 `{"event":"listening","port":<实际端口>}` 得到端口；
- app 子进程设置 `ILINK_LOGIN_BASE_URL=ILINK_BASE_URL=http://127.0.0.1:<port>`，
  `ILINK_CDN_BASE_URL=http://127.0.0.1:<port>/cdn`（媒体出站上传用 `upload_full_url` 自带绝对地址；
  入站下载由后端按 `{ILINK_CDN_BASE_URL}/download?encrypted_query_param=…` 拼出 → `/cdn/download`）；
- 测试结束 `kill()`，必要时 `POST /__mock/shutdown` 兜底；
- 用 `waitFor()` 轮询 `/__mock/state` 与 app 接口，避免固定 sleep；
- 媒体断言常用 `state.uploads[]`（明文字段/plainSha256）、`state.cdnFiles[]`（密文 sha256）、
  `state.sentMessages[].itemList`（item 字段），入站用控制面 `inbound-media` 注入后检查 app API。
