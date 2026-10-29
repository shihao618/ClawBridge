# 微信 ClawBot（iLink Bot）协议参考

> 本文档是 **ClawBridge** 的实现依据。协议逆向/整理自微信官方 OpenClaw 微信通道插件
> `@tencent-weixin/openclaw-weixin@2.4.10`（Tencent，MIT License）的源码
> （`src/api/api.ts`、`src/api/types.ts`、`src/auth/login-qr.ts`、`src/monitor/monitor.ts`、
> `src/messaging/send.ts`、`src/messaging/inbound.ts`、`src/api/session-guard.ts`），
> 并交叉参考了第三方实现（`@claw-lab/wxclawbot-cli`、Dart `weixin_clawbot`）。
> 实现时以官方插件的请求头、字段名、状态机语义为准。

## 1. 概念

**微信 ClawBot** 是微信官方为 OpenClaw 提供的微信通道（iLink Bot API）。用户在手机上用微信
扫描由 `get_bot_qrcode` 生成的二维码并确认后，微信用户与一个机器人实例（bot）建立绑定：

- 机器人获得 `ilink_bot_id`（bot 账号 ID）、`bot_token`（Bearer 凭证）、`baseurl`（后续 API 基址）。
- 扫码的微信用户 ID 为 `ilink_user_id`；bot 可以向这个用户发消息。
- 一个客户端可以拥有多个 bot 账号（每个微信用户扫码绑定一个 bot），这正是「多用户」模型。

**权限模型**：鉴权靠 `Authorization: Bearer <bot_token>`。绑定/换绑/解绑都没有服务端接口，
客户端只能清本地凭证；微信手机端的授权记录需用户在微信里自行管理。

## 2. 常量

| 名称 | 值 | 说明 |
| --- | --- | --- |
| 登录 API 基址 | `https://ilinkai.weixin.qq.com` | `get_bot_qrcode` / `get_qrcode_status` 固定用这个域名 |
| 默认业务 API 基址 | `https://ilinkai.weixin.qq.com` | 绑定成功后响应里的 `baseurl` 优先（IDC 可能不同） |
| `bot_type` | `3` | 本通道使用的 bot 类型 |
| `iLink-App-Id` | `bot` | 来自官方插件 `package.json` 的 `ilink_appid` |
| `iLink-App-ClientVersion` | `132106` | 由插件版本 `2.4.10` 编码：`major<<16 | minor<<8 | patch` = `0x02040A` |
| `channel_version` | `2.4.10` | `base_info.channel_version` |
| `bot_agent` | `OpenClaw`（默认） | `base_info.bot_agent`，仅观测用途；建议用合法 UA token 格式，如 `ClawBridge/1.0.0` |
| CDN | `https://novac2c.cdn.weixin.qq.com/c2c` | 媒体上传/下载用；本程序只发文本，暂不需要 |

> 所有常量均允许用环境变量覆盖（见 `docs/ARCHITECTURE.md` 的 `ILINK_*`）。

## 3. 公共请求头

所有请求（含未鉴权的二维码接口）：

```
Content-Type: application/json
iLink-App-Id: bot
iLink-App-ClientVersion: 132106
```

带 `bot_token` 的请求额外携带：

```
Authorization: Bearer <bot_token>
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: <base64(十进制随机 uint32 字符串)>
```

- `X-WECHAT-UIN` 每次请求随机生成：随机 4 字节 → 无符号整数 → 十进制字符串 → UTF-8 后 base64。
- 可选 `SKRouteTag` 路由头，本程序默认不发送。
- `base_info` 是 **body 字段**，不是 HTTP 头；格式：

```json
{ "channel_version": "2.4.10", "bot_agent": "OpenClaw" }
```

## 4. JSON 中 uint64 的处理（重要）

`message_id`、`msg_id`、`svr_id` 是 proto uint64，服务端以 JSON number 返回，可能超过
`2^53`，直接 `JSON.parse` 会丢精度。官方做法：解析前把这些 **对象键** 对应的整数字面量
包成字符串。我们实现同样的扫描器（仅处理字符串 token 之后紧跟 `:` 的键，不影响字符串内容）。

需要无损化的键：`message_id`、`msg_id`、`svr_id`。

## 5. 接口清单

### 5.1 获取登录二维码

```
POST {loginBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3
Header: 公共头（不需要 Authorization）
Body:
{
  "local_token_list": ["<最近绑定的 bot_token>", "..."]   // 可选，最多 10 个；用于识别“已绑定过本客户端”
}
Resp 200:
{
  "qrcode": "<二维码票据，轮询时回传>",
  "qrcode_img_content": "<二维码内容，通常是 https://... 链接，交给二维码渲染器生成图片>"
}
```

- `qrcode_img_content` 是 **要编码成二维码的字符串**（不是图片 URL），前端用二维码库渲染。
- `local_token_list` 作用：若扫码微信用户已经绑定过列表中的某个 bot，服务端会返回
  `binded_redirect` 而非发放新凭证（官方 `clearStaleAccountsForUserId`/换绑语义依赖此机制）。
  客户端应携带本机最近 10 个已绑定账号的 token。

### 5.2 轮询扫码状态（长轮询）

```
GET {loginBaseUrl}/ilink/bot/get_qrcode_status?qrcode=<票据>[&verify_code=<配对数字>]
Header: 公共头
```

服务端会挂起请求至多约 35 秒；客户端超时视为 `wait` 并继续轮询。响应：

```json
{
  "status": "wait | scaned | need_verifycode | verify_code_blocked | expired | scaned_but_redirect | binded_redirect | confirmed",
  "bot_token": "…",         // confirmed 时
  "ilink_bot_id": "…",      // confirmed 时，如 "b0f5860fdecb@im.bot"
  "baseurl": "https://…",   // confirmed 时，后续业务 API 基址
  "ilink_user_id": "…",     // confirmed 时，扫码的微信用户 ID（即默认收件人）
  "redirect_host": "…",     // scaned_but_redirect 时，切换轮询域名到 https://<redirect_host>
  "verify_code": "…"        // 个别版本可能回显，忽略即可
}
```

状态机（官方 CLI 语义）：

| 状态 | 语义 | 客户端动作 |
| --- | --- | --- |
| `wait` | 等待扫码 | 继续轮询（约 1s 间隔或长轮询） |
| `scaned` | 已扫码，等待手机确认 | 继续轮询；若带了配对码且回到 scaned，说明配对码已通过 |
| `need_verifycode` | 需要配对数字（手机上显示的数字） | 让用户输入数字，下一次轮询用 `verify_code` 参数提交 |
| `verify_code_blocked` | 错误次数过多 | 清空配对码，刷新二维码（计入刷新次数） |
| `expired` | 二维码失效 | 自动刷新二维码（最多 3 次），刷新后需重新扫码 |
| `scaned_but_redirect` | 需要换 IDC 轮询域名 | 用 `redirect_host` 切换轮询 base URL，继续 |
| `binded_redirect` | 该微信用户已绑定过本客户端 | 视为**成功**（已连接），不发放新凭证；使用已有本地账号 |
| `confirmed` | 绑定成功 | 保存 `bot_token`/`ilink_bot_id`/`baseurl`/`ilink_user_id` |

其他约束：

- 二维码整体有效期约 5 分钟；官方 `startWeixinLoginWithQr` 的 `ACTIVE_LOGIN_TTL_MS = 5min`。
- 同一登录会话最多刷新 3 次二维码（`MAX_QR_REFRESH_COUNT = 3`），超出则终止。
- 官方终端登录总超时 8 分钟（`waitForWeixinLogin` 默认 480s）；多用户场景可设为 10 分钟。
- 服务端返回的 `confirmed` 里 `ilink_bot_id` 必须存在，否则视为失败。

### 5.3 启动 / 停止通道通知

```
POST {baseUrl}/ilink/bot/msg/notifystart   Body: {"base_info": {...}}
POST {baseUrl}/ilink/bot/msg/notifystop    Body: {"base_info": {...}}
Header: 带 bot_token 的公共头
Resp: {"ret": 0, "errmsg": "..."}
```

事件流约定：`connect` → `notifystart`；`disconnect`/`unbind`/进程退出 → `notifystop`。
请求失败不影响主流程（best-effort）。

### 5.4 长轮询接收消息

```
POST {baseUrl}/ilink/bot/getupdates
Header: 带 bot_token 的公共头
Body:
{
  "get_updates_buf": "<上次响应回传的游标，首次为空串>",
  "base_info": {"channel_version": "2.4.10", "bot_agent": "OpenClaw"}
}
```

服务端挂起至多约 35 秒。Resp：

```json
{
  "ret": 0,
  "errcode": 0,                       // 出现即错误；-14 = bot_token 失效
  "errmsg": "",
  "msgs": [ { "seq": 1, "message_id": "123…", "from_user_id": "…", "to_user_id": "…",
              "create_time_ms": 1690000000000, "message_type": 1, "message_state": 2,
              "item_list": [{"type": 1, "text_item": {"text": "hello"}}],
              "context_token": "…" } ],
  "get_updates_buf": "<新游标，必须保存并在下次请求回传>",
  "longpolling_timeout_ms": 35000    // 服务端建议的下一次长轮询超时
}
```

`WeixinMessage` 字段（节选，来自官方 proto）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `seq` | number | 序号 |
| `message_id` | string（无损化后） | 服务端消息 ID |
| `from_user_id` / `to_user_id` | string | 发送方 / 接收方 iLink 用户 ID |
| `client_id` | string | 客户端生成 ID |
| `create_time_ms` / `update_time_ms` / `delete_time_ms` | number | 毫秒时间戳 |
| `session_id` / `group_id` / `run_id` | string | 会话/群/运行 ID |
| `message_type` | number | 0=NONE 1=USER 2=BOT |
| `message_state` | number | 0=NEW 1=GENERATING 2=FINISH |
| `item_list` | array | 消息体列表 |
| `context_token` | string | **必须缓存，并在此后发消息时原样回传** |

`MessageItem`：

| `type` | 含义 | 子字段 |
| --- | --- | --- |
| 1 | TEXT | `text_item.text` |
| 2 | IMAGE | `image_item.media`（CDN 加密引用） |
| 3 | VOICE | `voice_item.media` / `voice_item.text`（语音转文字） |
| 4 | FILE | `file_item.media` / `file_name` |
| 5 | VIDEO | `video_item.media` |
| 11/12 | TOOL_CALL_START/RESULT | 工具调用，忽略 |

错误处理：

- `errcode === -14`（`ret === -14`）：bot_token 失效。官方 `session-guard` 会 **冷却 1 小时**、
  停止该账号的轮询，需要用户重新扫码绑定。
- 其他 `ret/errcode != 0`：连续 3 次失败后退避 30 秒；否则 2 秒后重试。
- 客户端主动中止（长轮询超时）属正常控制流：视为空响应并立即重试。

### 5.5 发送文本消息

```
POST {baseUrl}/ilink/bot/sendmessage
Header: 带 bot_token 的公共头
Body:
{
  "msg": {
    "from_user_id": "",                     // 必须为空（官方如此）
    "to_user_id": "<ilink_user_id>",        // 收件人 = 绑定时的 ilink_user_id
    "client_id": "openclaw-weixin-<uuid>",  // 客户端生成的唯一 ID
    "message_type": 2,                      // BOT
    "message_state": 2,                     // FINISH
    "item_list": [ { "type": 1, "text_item": { "text": "hello" } } ],
    "context_token": "<最近一条入站消息的 context_token>"   // 可选但强烈建议
  },
  "base_info": {"channel_version": "2.4.10", "bot_agent": "OpenClaw"}
}
Resp 200:
{"ret": 0, "message_id": "1234567890123456789", "errmsg": ""}
```

- `ret != 0` 视为失败：res>0 抛错并记录 `errmsg`。`ret == -2` 表示频率限制（等待 5–10s 重试）；
  `ret == -14` 表示 token 失效（同 5.4，冷却并等待重新绑定）。
- `context_token` 来自该用户最近一条入站消息；**没有入站消息时（冷启动）官方实现会不携带
  context_token 直接尝试发送**，但成功率取决于服务端策略。因此程序应在绑定成功后尽快捕获
  用户的第一条消息，或在无 context_token 时给出发送风险提示。
- 第三方文档（Dart `weixin_clawbot`）指出服务端限制约 **7 条 / 5 分钟 / 每个 bot 账号**，
  且所有客户端共享。本程序默认按保守值 `7/5min` 做客户端限流 + 队列，可用环境变量调整。

### 5.6 其他端点（本程序按需使用）

```
POST {baseUrl}/ilink/bot/getconfig    Body: {"ilink_user_id": "...", "context_token": "...", "base_info": {...}}
  → {"ret":0, "typing_ticket": "<base64>"}
POST {baseUrl}/ilink/bot/sendtyping   Body: {"ilink_user_id": "...", "typing_ticket": "...", "status": 1|2, "base_info": {...}}
  → {"ret":0, "errmsg": ""}         // 1=正在输入 2=取消
```

### 5.7 媒体消息（图片/视频/文件）

媒体消息走「申请上传地址 → 加密上传 CDN → sendmessage 携带媒体 item」三步；入站媒体需从 CDN
下载并 AES-128-ECB 解密。完整细节（字段、aes_key 两种编码、示例、错误处理）见
[`docs/MEDIA.md`](MEDIA.md)，要点：

```
POST {baseUrl}/ilink/bot/getuploadurl
  Body: {filekey, media_type(1=image 2=video 3=file 4=voice), to_user_id, rawsize, rawfilemd5,
         filesize(AES 密文长度), no_need_thumb:true, aeskey(hex), base_info}
  → {upload_param, thumb_upload_param, upload_full_url}

POST {upload_full_url | {cdnBaseUrl}/upload?encrypted_query_param=…&filekey=…}
  Body: AES-128-ECB(PKCS7) 密文 → 响应头 x-encrypted-param = 下载参数

sendmessage 的 item_list（仅一个媒体 item；aes_key 统一为 base64(32 字符 hex key 字符串)）：
  image: {"type":2,"image_item":{"media":{"encrypt_query_param":"…","aes_key":"<base64(hex字符串)>","encrypt_type":1},"mid_size":<密文字节数>}}
  video: {"type":5,"video_item":{"media":{…},"video_size":<密文字节数>}}
  file:  {"type":4,"file_item":{"media":{…},"file_name":"a.pdf","len":"<明文字节数>"}}
```

入站：`item_list` 中出现 `image_item/voice_item/file_item/video_item`；下载优先
`media.full_url`，否则 `{cdnBaseUrl}/download?encrypted_query_param=…`，然后用
`media.aes_key`（base64(raw 16B) 或 base64(32 字符 hex)）或图片的 `image_item.aeskey`(hex)
做 AES-128-ECB 解密。CDN 默认 `https://novac2c.cdn.weixin.qq.com/c2c`。

## 6. 账号与换取绑定的语义

- 一个 bot 账号 = `{ilink_bot_id, bot_token, base_url, wechat_user_id(ilink_user_id)}`。
  本程序把「绑定用户」与「bot 账号」一一对应。
- **换绑**：官方协议没有换绑接口。语义是「用同一个微信去扫另一个 bot 的二维码」；
  `confirmed` 后客户端删除同一微信用户下的旧账号（官方 `clearStaleAccountsForUserId`），
  避免新旧 bot 的 `context_token` 混淆。本程序在 `confirmed` 时按 `ilink_user_id`
  upsert 用户并清掉旧凭证，等价实现该语义。
- **解绑**：协议无服务端解绑接口。官方做法 = `notifyStop` + 删除本地凭证/context token；
  微信 App 内的授权记录需要用户自己在手机微信里管理。
- **binded_redirect** 是「已连接过本客户端、无需重复绑定」的成功语义，不是错误。

## 7. 最小可用流程（伪代码）

```text
bind(user):
  qr = POST /ilink/bot/get_bot_qrcode?bot_type=3 {local_token_list}
  loop:
    st = GET /ilink/bot/get_qrcode_status?qrcode=qr.qrcode[&verify_code=code]
    switch st.status:
      wait/scaned: continue
      need_verifycode: code = askUser(); continue
      expired: refreshQr(<=3); continue
      scaned_but_redirect: switch baseUrl; continue
      binded_redirect: reuse existing account; done
      confirmed: save {bot_token, ilink_bot_id, baseurl, ilink_user_id}; done
  POST notifystart
  start getupdates loop (save get_updates_buf, cache context_token)

send(user, text):
  msg = {from_user_id:"", to_user_id:user.wechat_user_id, client_id:uuid,
         message_type:2, message_state:2,
         item_list:[{type:1, text_item:{text}}], context_token: user.context_token}
  POST sendmessage {msg, base_info}
  ret -2 → rate limited, retry later; ret -14 → token stale, pause 1h + need rebind
```

## 8. 许可与致谢

本程序的 iLink 客户端按上述协议独立实现，协议事实参考 Tencent 官方插件
（MIT License，https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin）。
第三方优秀实现参考：`@claw-lab/wxclawbot-cli`、Dart `weixin_clawbot`。
