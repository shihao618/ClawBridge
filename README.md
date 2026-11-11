# ClawBridge · 多用户微信 ClawBot 绑定与消息推送平台

用 Docker 一键部署的自托管 Web 服务：**多个微信用户分别扫码绑定自己的 ClawBot**，运营者通过
管理后台或 HTTP API **给任意已绑定用户发送微信消息**，并可接收用户回复、查看消息记录。

> 微信 ClawBot 是微信官方为 OpenClaw 提供的微信通道（iLink Bot API）。ClawBridge 按官方插件
> `@tencent-weixin/openclaw-weixin@2.4.10` 的协议实现扫码绑定、长轮询收消息、文本消息发送，
> 不依赖任何第三方微信协议服务或个人号 Hook。
>
> **当前版本 1.1.15**：数据库 schema **v1**（全新基线），**不兼容任何旧数据卷**，也不提供迁移；
> 请使用全新空数据卷部署（旧部署请先备份，回滚需同时使用旧镜像与旧数据卷）。见
> [`docs/UPGRADE.md`](docs/UPGRADE.md)。

---

## 功能特性

- **多用户扫码绑定**：任何微信用户打开绑定页 → 输入昵称 → 用微信扫码并确认 → 完成绑定。
  支持手机配对数字（`need_verifycode`）、二维码过期自动刷新（≤3 次）、换绑（同一微信重新绑定
  自动清理旧凭证）、已绑定重扫提示（`binded_redirect`）。
- **多账号隔离**：每个微信用户对应一个独立 bot 凭证（token / baseUrl / context_token），
  互不影响；服务重启后自动恢复入站长轮询。
- **消息推送 API**：`POST /api/v1/messages`（指定用户）与 `POST /api/v1/broadcast`（广播），
  API Key 鉴权、异步 outbox 队列、按账号限流（默认 7 条 / 5 分钟，微信服务端限制）、
  `-2` 限流退避重试、`-14` token 失效自动冷却并提示重新绑定；`-2 prepare failed` 会明确提示
  context_token 失效（需要用户先给 bot 发消息），不会误判为限流反复重试。
- **Webhook 兼容**：`POST /api/v1/webhook` 支持 `?token=` 鉴权，目标可放 query
  （`?to=` / `?groupId=` / `?broadcast=1`）或 JSON body；接受 JSON、纯文本、表单 body，
  兼容常见 `text/content/message/msg` 字段，入队来源标记为 `source=webhook`。
- **双向消息**：每个绑定账号独立 `getupdates` 长轮询，接收用户回复、缓存 `context_token`
  以便主动推送更可靠；入站/出站消息统一记录、去重、message_id 无损（uint64 字符串）。
- **多媒体消息**：支持向绑定用户发送**图片、视频、文件**（可选文字 caption，自动按 MIME 路由、
  AES-128-ECB 加密上传微信 CDN），并自动下载/解密用户发来的图片/文件/视频/语音，
  管理后台可直接预览图片、播放视频、下载附件；上传/读取接口均鉴权并支持大小限制。
- **用户分组**：多分组标签（一个用户可属于多个分组），管理后台可增删改分组、给用户分配分组、
  按分组筛选用户/消息、按分组群发（文本 + 图片/文件/视频）；分组可开启「分组保活」，
  之后加入该分组的成员自动开启 24h 会话保活。
- **24h 会话保活（opt-in）**：微信 ClawBot 主动下发依赖"用户最近一次主动消息"的 24 小时会话窗口；
  对开启保活的用户，系统会在其最后一条入站消息满 12 小时后首次提醒，之后每 6 小时重复提醒，
  直到用户回复刷新窗口或窗口过期；可对单用户或分组批量开启。
- **入站消息 API**：对外 API 可分页/游标增量拉取"微信用户发来的消息"（`GET /api/v1/inbound/messages`），
  支持 `since`/`cursor`/`wait` 长轮询、按用户/分组过滤、附件元数据与下载 URL，便于外部系统集成。
- **接口应用 · 规则列表 Tab**：配置规则后，命中「指定用户/分组 + 关键词/正则」的微信消息会自动调用
  外部 HTTP 接口（从消息提取参数、支持 GET/POST/Header/Body 模板），解析返回并回复用户；也可以
  **不请求外部接口，直接回复一段默认文本**（`request.mode=none`）；支持优先级、
  同消息去重、SSRF 防护（默认拒绝内网）、测试运行与每规则运行日志弹窗；调用频率统一由微信默认发送限流控制；回复模板按 Markdown 编写，
  支持 `{{#each}}` 列表渲染（数组数据一次性拼成名单发送）；模板输出 `{{noreply}}` 时静默不回复（不发送、不使用兜底）。
  URL/Header/Body 模板可使用 **`{credential:凭据名.字段}`** 占位符，按**触发用户**注入其用户级凭据。
  规则命中处理期间（含直接回复）会向触发用户显示微信「正在输入」状态（默认开启，可在运行配置关闭；
  best-effort，失败不影响规则；详见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md) §5.6）。
- **发送失败用户提示**：消息最终发送失败（非 -14 暂停、非 prepare failed 可重试）时，向该用户 best-effort
  发一条「⚠️ 消息发送失败，请稍后重试」（默认开启，可后台「运行配置 → 推送/限流」关闭；不进队列、不重试、
  每条只提示一次）。
- **`/echo` 指令**：用户发送 `/echo 内容` 时直接回显（走发送队列，不进入接口应用规则）；其他官方 slash
  指令（如 `/toggle-debug`）不实现。
- **用户级凭据（只写不读）**：为每个绑定用户保存第三方密钥（一条凭据可含多个字段，如 `gps.token`、
  `weather.apiKey`），值 AES-256-GCM 加密落库、接口与后台**不回显明文**（只显示字段名与掩码提示）；
  用户管理行内「密钥」按钮可视化管理，规则/定时通知按需引用；用户删除时级联删除。
- **接口应用 · 定时通知 Tab**：按计划（每 N 分钟，可选每日 HH:mm–HH:mm 生效时间段；或每天 HH:mm；默认 Asia/Shanghai 时区）自动调用外部 HTTP 接口，
  解析返回并通过微信通知指定用户/分组；支持模板（含 `{{#each}}` 列表渲染）、兜底文案、测试运行、
  立即执行与运行日志；模板输出 `{{noreply}}` 时静默不发送（不使用兜底，适合"没数据不打扰"）。
  **按用户模式**：每个目标用户用**自己的凭据**请求、按用户渲染通知（相同凭据值自动合并请求），
  缺凭据跳过、单用户失败不影响其他人，任务状态可为 `partial`（部分成功）。
- **管理后台**：菜单式导航（概览/用户管理/用户分组/消息记录/广播消息/接口应用/运行配置，
  hash 路由可直达、响应式侧栏（桌面常驻、窄屏抽屉））、用户管理（搜索/筛选/分组/发消息/解绑/重连/保活/删除）、分组管理、
  接口应用（含「规则列表」「定时通知」两个 Tab）、广播、消息记录、运行配置；**限流/保活/接口应用/定时通知/媒体/绑定等运行参数
  可在后台「运行配置」修改（DB 持久化，优先于 .env）；页面顶部可一键「重启容器」使需重启字段生效**。
- **安全**：bot_token / context_token AES-256-GCM 加密落库；admin 密码登录（HttpOnly Cookie +
  CSRF 头校验）；**管理密码（scrypt 哈希）与 API Token（AES 加密）可在后台「安全」卡片修改/轮换**，
  Token 仅显示一次；API Key 常量时间比较；绑定会话 secret 只返回一次且仅存哈希；CSP 安全头；
  日志脱敏；未配置密钥时自动生成并持久化到数据卷；提供 **APP_SECRET 轮换工具**
  （`npm run rotate-secret`，离线停机执行并自动备份，见 [`docs/ROTATE_APP_SECRET.md`](docs/ROTATE_APP_SECRET.md)）。
- **可观测性与维护**：管理端只读指标接口 `GET /api/admin/metrics`（进程/队列/监控/媒体/规则·定时聚合）；
  内置数据生命周期维护（孤儿媒体清理、日志保留期）；管理后台视图按需动态加载（首屏只加载概览）。
  隐私与数据边界见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。
- **开箱即用**：单容器（Node 24 + Express 5 + 内置 SQLite，无外部数据库）、零构建前端、
  Docker healthcheck、数据持久化命名卷；附带**本地模拟微信 API**，无真实微信也能完整演示与测试。

## 界面预览

| 公开绑定页（移动端） | 绑定成功（移动端） |
| --- | --- |
| ![绑定页](screenshots/bind-mobile.webp) | ![绑定成功](screenshots/bind-mobile-confirmed.webp) |

| 管理后台（菜单模式·概览） | 管理后台（用户管理） |
| --- | --- |
| ![管理后台菜单概览](screenshots/admin-menu-overview.webp) | ![用户管理](screenshots/admin-menu-users.webp) |

| 管理后台（用户分组） | 管理后台（接口应用） |
| --- | --- |
| ![用户分组](screenshots/admin-menu-groups.webp) | ![接口应用](screenshots/admin-menu-app-rules.webp) |

| 接口应用：规则运行日志弹窗 | 接口应用 → 定时通知：按间隔 + 每日生效时间段 |
| --- | --- |
| ![规则运行日志](screenshots/admin-app-rules-logs-modal.webp) | ![定时通知时间段](screenshots/admin-schedule-window.webp) |

| 管理后台（响应式侧栏） | 推送 API 文档页 |
| --- | --- |
| ![移动端菜单](screenshots/admin-menu-mobile.webp) | ![API 文档](screenshots/docs-page.webp) |

| 多媒体：发送弹窗（图片/视频/文件 + caption） | 消息记录：图片缩略图 / 视频播放 / 文件下载 |
| --- | --- |
| ![发送多媒体](screenshots/admin-media-send.webp) | ![多媒体消息记录](screenshots/admin-media-messages.webp) |

| 用户分组管理（多标签 / 计数 / 群发） | 入站消息 API 文档 |
| --- | --- |
| ![用户分组](screenshots/admin-groups.webp) | ![入站消息 API](screenshots/docs-inbound-api.webp) |

| 接口应用：规则管理（关键词触发外部接口） | 接口应用：测试运行（dry-run，不发送） |
| --- | --- |
| ![接口应用](screenshots/admin-app-rules.webp) | ![测试运行](screenshots/admin-app-rules-test.webp) |

| 24h 会话保活开关 | 接口应用文档 |
| --- | --- |
| ![会话保活](screenshots/admin-keepalive.webp) | ![接口应用文档](screenshots/docs-app-rules.webp) |

| 接口应用 → 定时通知（任务列表） | 接口应用 → 定时通知（测试运行，不发送） |
| --- | --- |
| ![定时通知](screenshots/admin-app-rules-schedule.webp) | ![定时通知测试](screenshots/admin-app-rules-schedule-test.webp) |

| 运行配置（后台可改，DB 持久化） | 接口应用 → 定时通知文档 |
| --- | --- |
| ![运行配置](screenshots/admin-settings.webp) | ![接口应用 → 定时通知文档](screenshots/docs-scheduled-tasks.webp) |

| 安全设置（管理密码 / API Token） | 运行配置（.env 仅剩必须项） |
| --- | --- |
| ![安全设置](screenshots/admin-security.webp) | ![运行配置](screenshots/admin-settings.webp) |

> 截图来自本地演示模式（mock 微信 API + mock CDN/外部接口，自动确认绑定），未连接真实微信。

## 架构

```
浏览器（绑定页 / 管理后台）
        │ 同源 HTTP
        ▼
┌────────────────────────── ClawBridge（单容器）──────────────────────────┐
│ Express 5（api.js 组合根 → http/** 中间件与校验 → routes/** 路由）      │
│  ├─ binding.js  绑定会话 + 二维码状态机 ──► 微信 ClawBot API            │
│  ├─ monitor.js  每账号 getupdates 长轮询（入站消息 / context_token）     │
│  ├─ dispatcher.js  outbox 队列 + 每账号限流 / 重试 ──► sendmessage       │
│  ├─ app-rules.js / scheduler.js  规则触发 / 定时通知 → 外部 HTTP 接口    │
│  ├─ keepalive.js 24h 会话保活；settings.js 运行配置（DB 持久化）         │
│  ├─ store.js    users / outbox / inbound / events（SQLite WAL，加密凭证）│
│  └─ web/        绑定页 · 管理后台 · API 文档（静态、零构建 ES Module）   │
└────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  微信 ClawBot（https://ilinkai.weixin.qq.com）      data 卷：SQLite + secret
```

协议细节见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)，HTTP API 契约见 [`docs/API.md`](docs/API.md)，
实现架构与设计取舍见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 快速开始（Docker 生产部署）

### 前置要求

- Docker Engine / Docker Desktop（含 `docker compose` v2+），Linux 或 Windows/macOS 均可
- 一台能访问 `https://ilinkai.weixin.qq.com` 的服务器（微信 ClawBot 出网）
- 手机微信（用于扫码绑定）

### 1. 准备配置

```bash
git clone https://github.com/shihao618/ClawBridge.git clawbridge && cd clawbridge
cp .env.example .env
# .env 只需设置 APP_SECRET（不设置会自动生成到数据卷 app-secret.key）
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
notepad .env
```

### 2. 启动

```bash
docker compose up -d --build
```

### 3. 访问

| 地址 | 说明 |
| --- | --- |
| `http://<服务器IP>:10380/` | 首页（微信扫码绑定入口；`/bind` 会 302 到此） |
| `http://<服务器IP>:10380/admin` | 管理后台（初始密码见下方 data 文件） |
| `http://<服务器IP>:10380/docs` | 推送 API 使用文档 |
| `http://<服务器IP>:10380/health` | 健康检查（Docker healthcheck 同款） |

首次启动后获取初始凭据（密码/Token 只存数据库，不再读取 .env）：

```bash
docker exec clawbridge-app cat /app/data/admin-password.txt   # 管理后台初始密码
docker exec clawbridge-app cat /app/data/api-token.txt        # 推送 API Token
```

> 旧数据卷升级时若这两个文件不存在，说明凭据已在旧 DB 中初始化；可在已登录后台「运行配置 → 安全」重置，或在备份 DB 后按 docs/SETTINGS.md 重新引导。

> 登录后可在「运行配置 → 安全」里修改密码、重置 Token；数据卷 `/app/data/` 下文件会同步更新，旧凭据立即失效。

常用运维命令：

```bash
docker compose logs -f clawbridge      # 查看日志（JSON 行、敏感字段自动脱敏）
docker compose ps                      # 查看健康状态
docker compose up -d --build           # 更新代码后重建
docker compose down                    # 停止（保留数据卷）
```

数据保存在 Docker 命名卷 `clawbridge-data`（SQLite、加密主密钥、自动生成的密码/Token、媒体），
`docker compose down` 不会删除；如需彻底清空用 `docker compose down -v`（**会清空所有绑定与消息**）。

### 4. fnOS（飞牛OS）安装（免构建，直接拉取 GHCR 镜像）

使用 [`docker-compose.fnos.yml`](docker-compose.fnos.yml)：**不需要源码/构建**，直接拉取
`ghcr.io/shihao618/clawbridge:latest`（GitHub Actions 自动构建，支持 linux/amd64 与 linux/arm64）。
宿主机端口 **10380**，数据持久化在 **项目根目录 `./data`**（NAS 真实目录，方便查看/备份）。

```bash
# 1) 只需要 docker-compose.fnos.yml（可保存到 fnOS 的 Compose 项目目录）
# 2) 先创建本地持久化目录（属主为 NAS 用户，否则 Docker 自动创建会归 root，容器无法写入）：
mkdir -p data
# 3) 拉取镜像并启动：
docker compose -f docker-compose.fnos.yml pull
docker compose -f docker-compose.fnos.yml up -d
```

更新镜像：

```bash
docker compose -f docker-compose.fnos.yml pull
docker compose -f docker-compose.fnos.yml up -d
```

容器默认以 `PUID:PGID = 1000:1000`（fnOS 默认用户）运行，保证能写入 `./data`。
可在**项目目录**创建可选 `.env` 覆盖（若你的 fnOS 版本不读取 `.env`，直接改
`docker-compose.fnos.yml` 里的默认值即可）：

```env
PUID=1000
PGID=1000
DATA_PATH=./data
# APP_SECRET=（可选，64 位随机串；留空自动生成到 data/app-secret.key）
```

首次启动会自动生成 `APP_SECRET`、管理密码和 API Token（均在 `data/` 下），可直接在
fnOS 文件管理器打开项目目录的 `data/` 查看，或用命令：

```bash
docker exec clawbridge cat /app/data/admin-password.txt
docker exec clawbridge cat /app/data/api-token.txt
```

访问 `http://<fnOS-IP>:10380/`。备份/迁移直接打包项目下的 `data/` 目录即可
（**必须包含 `app-secret.key`**，否则历史凭证无法解密）。

---

## 本地演示模式（无需真实微信）

仓库自带零依赖的微信 iLink 模拟器（`mock/ilink-mock.mjs`），一条命令即可在本地完整走通
「扫码绑定 → 管理后台发消息 → 模拟微信收到 → 用户回复 → ClawBridge 收消息」：

```powershell
# Windows
scripts/demo.ps1                 # 启动全栈并等待健康检查，打印操作指引
scripts/demo.ps1 status          # 查看状态
scripts/demo.ps1 down            # 停止（-Volumes 同时清空数据卷）
```

```bash
# Linux / macOS / Git Bash
bash scripts/demo.sh up
bash scripts/demo.sh down
```

> 如果直接执行 `./scripts/demo.sh` 提示没有执行权限，先 `chmod +x scripts/demo.sh`。

演示模式下 `MOCK_AUTO_CONFIRM_MS=3000`：绑定页生成二维码后约 3 秒，mock 会自动模拟
「扫码 + 手机确认」，页面自动显示绑定成功。随后：

1. 打开 `http://127.0.0.1:10380/`，输入昵称 → 生成二维码 → 等待自动绑定成功；
2. 打开 `http://127.0.0.1:10380/admin`，用 `docker exec clawbridge-app cat /app/data/admin-password.txt` 里的初始密码登录，在用户列表点「发消息」；
3. 查看 mock 是否收到：`http://127.0.0.1:3100/__mock/state` 的 `sentMessages`；
4. 注入一条"微信回复"：

```bash
curl -X POST http://127.0.0.1:3100/__mock/accounts/<botId>/inbound \
  -H 'Content-Type: application/json' -d '{"text":"收到，谢谢！"}'
# 之后在管理后台「消息记录 → 入站」即可看到，且后续推送会自动携带 context_token
```

mock 的控制面 API（扫码/确认/配对码/过期/失效 token/限流错误注入等）见
[`mock/README.md`](mock/README.md)。

---

## 真实微信绑定与推送

1. 让用户打开绑定页（公网部署时给 `http://<域名>/`），输入昵称并生成二维码；
2. 用户用**手机微信**扫码，按手机提示确认（部分账号需要在手机上输入一组数字，页面会提示输入）；
3. 绑定成功后，该微信的微信里会出现 ClawBot 会话（若聊天列表看不到，可在微信搜索「微信Claw」
   或相关会话记录找到）；
4. 在管理后台“用户列表”里点击「发消息」，或调用推送 API，即可给该用户发送微信消息。

示例：调用推送 API（`API_TOKEN` 来自管理后台「运行配置 → 安全」或数据卷中的 `data/api-token.txt`）：

```bash
# 指定用户发送（用户 id 可在管理后台 URL / 用户接口中获得）
curl -X POST http://127.0.0.1:10380/api/v1/messages \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":["u_xxxxxxxx"],"text":"您好，您的订单已发货 🚚"}'

# 广播给所有已绑定用户
curl -X POST http://127.0.0.1:10380/api/v1/broadcast \
  -H "X-Api-Key: $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"系统将于今晚 23:00 维护"}'
```

### 用户分组与入站消息 API

```bash
# 1) 创建分组（管理端）
curl -X POST http://127.0.0.1:10380/api/admin/groups \
  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin" \
  -H "Content-Type: application/json" \
  -d '{"name":"VIP客户","description":"重点客户","color":"#07C160"}'

# 2) 把用户加入分组（全量替换该用户的分组）
curl -X PUT http://127.0.0.1:10380/api/admin/users/u_xxxxxxxx/groups \
  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin" \
  -H "Content-Type: application/json" \
  -d '{"groupIds":["grp_xxxxxxxx"]}'

# 3) 按分组群发（也支持 mediaId 发送图片/文件/视频）
curl -X POST http://127.0.0.1:10380/api/v1/groups/grp_xxxxxxxx/messages \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"VIP 客户专属通知"}'

# 4) 拉取"微信用户发来的消息"：首次最近 50 条，之后用 nextCursor 增量长轮询
curl -s "http://127.0.0.1:10380/api/v1/inbound/messages?limit=50" \
  -H "Authorization: Bearer $API_TOKEN"
curl -s "http://127.0.0.1:10380/api/v1/inbound/messages?limit=50&cursor=$NEXT&wait=25" \
  -H "Authorization: Bearer $API_TOKEN"
# 返回 items[*].attachments 中的 url 可直接 GET /api/v1/media/{id} 拉取图片/文件（鉴权 + Range）
```

完整字段、错误码与语义见 [`docs/API.md`](docs/API.md) §6/§7 与
[`docs/GROUPS_AND_INBOUND.md`](docs/GROUPS_AND_INBOUND.md)。

### 消息保活（24h 会话窗口）

微信 ClawBot 主动下发依赖"用户最近一次主动消息"的约 24 小时窗口。对**有长期通知需求**的用户，
在管理后台用户行打开「保活」（或对分组批量开启）后，系统会在其最后一条**入站消息满 12 小时**后
首次发送保活提醒，之后**每 6 小时重复提醒**，直到用户回复刷新窗口或窗口过期（后台默认每 5 分钟扫描一次）。
用户回复后窗口重新计时，可继续接收通知。

```bash
# 单用户开启保活（管理端 Cookie+CSRF）；分组批量用 POST /api/admin/groups/{id}/keepalive
curl -X PATCH http://127.0.0.1:10380/api/admin/users/u_xxxxxxxx/keepalive \
  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin" \
  -H "Content-Type: application/json" -d '{"enabled":true}'
```

参数与机制见 [`docs/KEEPALIVE.md`](docs/KEEPALIVE.md)（窗口 24h、首次提前 12h、每 6h 重复提醒、5 分钟扫描一次，
可用 `KEEPALIVE_*` 环境变量调整）。

### 接口应用 → 规则列表（关键词触发 → 外部接口 → 回复用户）

在管理后台「接口应用」新建规则：命中「指定用户/分组 + 关键词/正则」的微信文本消息 → 从消息中提取参数
（多参数组合提取：关键词后文本 / 正则命名组 / JSON 消息体 / 整句组合）→ 按模板调用外部 HTTP 接口 → 解析返回并回复用户。

```bash
# 创建规则：用户发「查天气 北京」→ 调天气 API → 把 data.answer 回复给用户
curl -X POST http://127.0.0.1:10380/api/admin/app-rules \
  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin" \
  -H "Content-Type: application/json" -d '{
    "name":"查天气","enabled":true,"priority":100,
    "scope":{"type":"all"},
    "matchMode":"contains","keywords":["查天气"],
    "extraction":{"mode":"multi","config":{"extractors":[{"type":"trailing","param":"arg"}]}},
    "request":{"method":"GET","url":"https://api.example.com/weather?city={arg}","headers":{}},
    "response":{"type":"json","path":"data","template":"{{data.answer}}","fallbackText":"暂时无法查询天气"},
    "timeoutMs":8000
  }'

# 测试运行（dry-run，只展示提取/请求/响应/将回复内容，不发给用户）
curl -X POST http://127.0.0.1:10380/api/admin/app-rules/rule_xxxxxxxx/test \
  -H "Cookie: cb_session=$ADMIN_COOKIE" -H "X-Requested-With: ClawBridge-Admin" \
  -H "Content-Type: application/json" -d '{"message":"查天气 北京"}'
```

- 安全：外部请求默认**禁止访问内网/本机**；需要访问内网接口时在后台「运行配置 → 接口应用 → allowedHosts」
  添加主机（也可用 `.env` 的 `APP_RULES_ALLOWED_HOSTS` 作为初始默认）；Header 值加密落库、读取只返回键名；
  请求/响应/日志均脱敏。
- 机制与模板语法见 [`docs/API_RULES.md`](docs/API_RULES.md)（一消息只执行优先级最高的一条规则；
  同消息+规则去重、失败兜底文案、运行日志/测试运行；调用频率统一由微信默认发送限流控制）。
- 模板 Markdown 与微信渲染规则（发送前过滤、预览一致）：见 [`docs/MARKDOWN_WECHAT.md`](docs/MARKDOWN_WECHAT.md)。

发消息是**异步**的：接口立即返回 `202` 和 outbox id，后台队列在满足微信限流的前提下投递；
用 `GET /api/v1/messages/{outboxId}` 查询最终投递状态。完整契约（参数、错误码、状态机）见
[`docs/API.md`](docs/API.md)。

### 发送图片 / 视频 / 文件

先上传媒体拿到 `mediaId`，再带上 `mediaId` 发送（`text` 作为 caption，可选）：

```bash
# 1) 上传图片（原始二进制 + 文件名头；管理端对应 POST /api/admin/media）
MEDIA_ID=$(curl -s -X POST http://127.0.0.1:10380/api/v1/media \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: image/jpeg" \
  -H "X-File-Name: photo.jpg" \
  --data-binary @photo.jpg | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).media.id))")

# 2) 发送（caption + 图片）；文件/视频同理，MIME 自动决定微信消息类型
curl -X POST http://127.0.0.1:10380/api/v1/messages \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d "{\"to\":[\"u_xxxxxxxx\"],\"text\":\"订单截图\",\"mediaId\":\"$MEDIA_ID\"}"
```

- 出站单文件默认上限 25MB（`MEDIA_MAX_BYTES`），入站单文件默认 100MB（`INBOUND_MEDIA_MAX_BYTES`）；
  图片/视频按 `Content-Type` 或扩展名自动归类，其余按文件发送；语音出站暂不支持。
- 管理后台「发消息」弹窗可直接选择文件并预览，无需手工调接口；消息记录中图片显示缩略图、
  视频可播放、文件可下载。
- 媒体协议与实现细节见 [`docs/MEDIA.md`](docs/MEDIA.md)。

注意事项（来自微信 ClawBot 协议约束）：

- 微信服务端约限制 **每个 bot 账号 7 条 / 5 分钟**（所有客户端共享）。ClawBridge 默认按此保守值
  排队限流，可在管理后台「运行配置」调整（`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` 环境变量仅作为
  首次启动的默认值），不建议超过服务端限制。
- 绑定后建议让用户先给 bot 发一条消息：入站消息会带来 `context_token`，携带它主动推送成功率更高；
  没有 context_token 的“冷启动推送”仍会尝试发送，但可能受服务端策略限制。
- 协议**没有服务端解绑接口**：后台「解绑」= 停止轮询 + notifyStop + 清除本地凭证；
  微信里的授权记录需要用户自己在手机微信中管理。
- **24h 会话窗口 / 保活**：用户最后一次主动消息后约 24 小时内才能可靠地下发主动消息。若需要长期
  定时通知，请在管理后台对相关用户/分组开启「保活」：系统会在窗口即将过期前自动发送提醒，
  用户回复后窗口重新计时（默认窗口 24h、首次提前 12h、每 6h 重复提醒；参数见
  [`docs/KEEPALIVE.md`](docs/KEEPALIVE.md) 与 `.env` 的 `KEEPALIVE_*`）。
- **多媒体**：出站支持图片/视频/文件（≤25MB/个），入站自动下载解密图片/文件/视频/语音（≤100MB/个）；
  出站语音暂不支持（微信语音为 SILK 编码，需要转码，不在本期范围）。
- 换绑：同一微信用户重新扫码绑定即可，ClawBridge 会按微信用户自动替换旧 bot 凭证（官方语义）。
- 若服务端返回 `-14`（token 失效），该账号会暂停 1 小时并在后台显示为「paused」，冷却到期后**自动恢复轮询**；
  若 token 确实失效，用户仍需重新扫码。HTTP 401 仅在响应体带 `-14` 时才按 token 失效处理（避免网关 401 误暂停）。

---

## 配置项

> **运行参数已支持后台修改**：限流、会话保活、接口应用（含内网允许名单 `allowedHosts`）、定时通知、
> 媒体、绑定、iLink 地址/超时、监听代理、日志级别、会话 TTL 等均可在管理后台「运行配置」中修改，
> 保存到数据库（优先于 `.env`，尽量即时生效）；**管理密码与 API Token 也只由 DB 管理**：
> 首次启动自动生成随机值并写入数据卷 `/app/data/admin-password.txt` / `api-token.txt`，之后可后台修改/重置；
> 管理密码与 API Token 只由 DB 管理（首次启动自动生成到 data/ 文件，后台可重置）。
> `.env` 仅保留启动前必须确定的项：`APP_SECRET`、`DATA_DIR`、`MEDIA_DIR`、`PORT`、`HOST`、`NODE_ENV`
> 以及 `docker-compose` 部署变量。详见 [`docs/SETTINGS.md`](docs/SETTINGS.md) §8。

完整列表与说明见 [`.env.example`](.env.example)（首次启动默认值）与 [`docs/SETTINGS.md`](docs/SETTINGS.md) §7，
最常用：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APP_SECRET` | 自动生成到数据卷 `app-secret.key` | AES 加密根密钥；**必须保持稳定**，否则旧凭证无法解密（建议显式设置） |
| `DATA_DIR` | `data`（容器内 `/app/data`） | SQLite、密钥、媒体等数据目录 |
| `MEDIA_DIR` | `DATA_DIR/media` | 媒体文件存储路径 |
| `PORT` / `HOST` | `10380` / `0.0.0.0` | HTTP 监听端口（Docker 内外一致 10380）；一般无需修改 |
| `NODE_ENV` | `development` | 运行模式（Docker 部署由镜像/`docker-compose` 设为 `production`） |
| `DB_SYNCHRONOUS` | `NORMAL` | SQLite synchronous 级别：`NORMAL`（默认）/ `FULL`（每次提交 fsync，写入更慢但断电更安全）；仅 `.env`，改动需重启 |

> 其余运行参数（限流、会话保活、接口应用、定时通知、媒体、绑定、iLink 地址/超时、日志级别、
> 会话 TTL 等）均可在后台「运行配置」修改并持久化到数据库；管理密码与 API Token 在「安全」卡片管理
> （首次启动自动生成到数据卷 `/app/data/admin-password.txt`、`api-token.txt`，之后不再读取 .env）。
> 详见 [`docs/SETTINGS.md`](docs/SETTINGS.md) §7/§8。
>
> 其他常用可选 env（均为首次启动默认值）：`ILINK_CONFIG_TIMEOUT_MS`（轻量 iLink API 超时，默认 10000）、
> `PUSH_ERROR_NOTICE_ENABLED`（发送失败提示，默认 true）、`BINDING_NETWORK_ERROR_LIMIT`（绑定网络错误告警阈值）——
> 完整列表见 [`.env.example`](.env.example)。

### 数据维护与升级（1.0.0 全新基线）

- **数据维护（默认开启）**：进程内定时任务会清理孤儿媒体文件 / 无文件附件行、超过保留期的未入队上传附件，
  并按保留天数清理 `events` / 规则日志 / 定时任务日志（不删除 outbox/inbound 业务消息）。
  参数见 `.env.example` 第十二节 `MAINTENANCE_*`（默认启动 1 分钟后首跑、每天一次、日志保留 90 天）。
- **升级 / 回滚（1.0.0 起）**：1.0.0 是**全新数据基线（schema v1）**，不兼容任何旧数据卷，
  也不提供迁移脚本或步骤。从旧的 ClawBridge 数据卷切换到 1.0.0：备份旧数据卷（并保留旧镜像以便回滚）→
  使用**全新空数据卷**启动 → 重新扫码绑定用户并重建后台配置。回滚：换回旧镜像并恢复旧数据卷
  （镜像与数据卷必须配套）。完整步骤见 [`docs/UPGRADE.md`](docs/UPGRADE.md)。
- **APP_SECRET 轮换**：需要更换主密钥（如怀疑泄露）时，**停机后离线**用
  [`scripts/rotate-app-secret.mjs`](scripts/rotate-app-secret.mjs) 重加密库内全部密文
  （已绑定用户无需重新扫码；备份/验证/回滚步骤见 [`docs/ROTATE_APP_SECRET.md`](docs/ROTATE_APP_SECRET.md)）。

### 反向代理 / HTTPS

推荐前置 Nginx / Caddy 并启用 HTTPS，然后设置：

```env
PUBLIC_BASE_URL=https://claw.example.com
TRUST_PROXY=true
```

---

## 管理后台

菜单式布局（左侧 7 项菜单 + 顶部栏 + 视图区，hash 路由可直达如 `/admin#/users`，窄屏自动切换为抽屉菜单）：

- **概览**：用户数、可主动推送用户数、今日消息、队列状态、监控运行数、版本与限流配置；
- **用户管理**：搜索/状态筛选/分组筛选、分页；每行可「发消息」（进入 outbox 队列）、「分组」
  （多选分组标签）、「密钥」（管理该用户的用户级凭据：名称/备注/多字段/掩码提示，值只写不读）、
  「解绑」、「重连」（重启该账号的入站轮询）、「保活」开关；显示绑定时间、
  最近入站/出站、是否有 context_token、队列/成功/失败数、所属分组徽章；
- **用户分组**：新建/编辑/删除分组（名称、描述、颜色），显示活跃/总用户数，支持按分组群发
  （文本 + 图片/文件/视频）；分组列表行内「保活」开关可一键开启/关闭分组保活（同步当前成员，
  之后加入该分组的成员自动开启）；
- **消息记录**：入站/出站分栏，展示状态、尝试次数、错误、微信 server message_id、媒体附件；
  支持按用户/分组筛选；
- **广播消息**：给全部 active 用户排队发送同一文本；
- **接口应用**：同一页面两个 Tab ——「规则列表」（新建/编辑/测试运行/启用筛选，运行日志为页内 Tab）与
  「定时通知」（任务列表/编辑器/测试运行/立即执行/运行日志）；
- **运行配置**：脱敏后的运行配置（API Token 预览、限流、绑定、保活、接口应用参数）。
- **对外 API**：用户/广播推送、分组管理、按分组发送、入站消息增量拉取（`/api/v1/inbound/messages`）。

各视图按需加载并只刷新当前视图；公开绑定页与后台前端均为原生 HTML/CSS/ES Module，无构建、无外部 CDN；
后端设置了严格 CSP（`script-src 'self'`），离线内网也可使用。

---

## 开发与测试

```bash
npm install
npm start                 # 本地启动（默认 http://127.0.0.1:10380，自动生成 data/ 下的密钥）
npm test                  # 单元测试 + e2e（需先安装依赖）
npm run test:unit         # 单元测试（config/crypto/ilink 客户端/store/限流/API 契约/生命周期等）
npm run test:e2e          # 端到端：真实 app 进程 + mock 微信 API，全 HTTP 黑盒
npm run e2e:stability     # e2e 连跑稳定性（默认串行跑 3 次并汇总，CI 使用）
npm run test:ui           # 浏览器冒烟测试（本机 Edge/Chrome headless + CDP，无浏览器时自动跳过）
npm run coverage          # 单元 + e2e + 覆盖率报告（排除 web/tests；CI 阈值 line 90 / branch 70 / funcs 85）
npm run lint              # ESLint 静态检查（含 CI；零告警）
npm run doc:lint          # 文档值级一致性检查（版本/环境变量/设置字段/API 端点/链接/质量表命令）
npm run screenshots       # 用演示数据重新生成 README 截图（WebP；headless Edge/Chrome，可选）
npm run rotate-secret     # APP_SECRET 轮换（停机执行；自动备份 DB，先 --dry-run 核对）
npm run mock              # 单独启动模拟微信 API（默认 127.0.0.1:3100）
npm run smoke:mock        # mock 自身自测（26 项协议行为断言）
```

本地不带 Docker 的演示：

```bash
# 终端 1：mock 微信 API
npm run mock
# 终端 2：app 指向 mock
#   Windows PowerShell:
$env:ILINK_LOGIN_BASE_URL='http://127.0.0.1:3100'; $env:ILINK_BASE_URL='http://127.0.0.1:3100'
$env:MOCK_AUTO_CONFIRM_MS='3000'; npm start
#   Linux/macOS:
ILINK_LOGIN_BASE_URL=http://127.0.0.1:3100 ILINK_BASE_URL=http://127.0.0.1:3100 npm start
```

目录结构：

```
server/src/        # 后端：基础层（config/logger/errors/crypto/db/rate-limiter）+ 协议层（ilink/media）
                   # + 数据层（store.js façade + data/** 按域模块）+ 共享层（shared/** 模板/HTTP/响应管线）
                   # + 领域模块（binding/monitor/dispatcher/keepalive/app-rules/scheduler/settings/auth/maintenance）
                   # + HTTP 层（http/** 中间件与校验、routes/** 路由、api.js 组合根）+ index.js 进程入口
web/               # 零构建前端（绑定页 / 管理后台 / API 文档）
web/assets/admin/  # 管理后台 ES Module 模块（core/state/ui/templates/integrations + views/*.js 视图）
web/assets/lib/    # 前端纯函数模块（可直接 node:test 单测）
mock/              # 零依赖微信 iLink 模拟器 + 控制面 + 自测（26 项）
tests/             # tests/unit 单测（含前端静态/模块/纯函数/生命周期测试）、tests/e2e 端到端、tests/helpers 测试环境
docs/              # PROTOCOL.md 协议参考 / API.md 接口契约 / ARCHITECTURE.md 设计文档 /
                   # MEDIA.md 多媒体 / GROUPS_AND_INBOUND.md 分组与入站消息 API / KEEPALIVE.md 会话保活 /
                   # API_RULES.md 接口应用→规则列表（关键词触发→外部 HTTP，含凭据占位符）/ SCHEDULED_TASKS.md 接口应用→定时通知 /
                   # SETTINGS.md 运行配置后台可改 / MARKDOWN_WECHAT.md 微信 Markdown 兼容规则 /
                   # UPGRADE.md 全新基线部署/回滚 / RELEASE.md 发布流程 / SECURITY 策略见根目录 SECURITY.md /
                   # ROTATE_APP_SECRET.md APP_SECRET 轮换 / PRIVACY.md 隐私与数据处置
scripts/           # demo.ps1 / demo.sh 一键演示；frontend-smoke.mjs 浏览器冒烟；screenshots.mjs 截图生成
Dockerfile · docker-compose*.yml · .env.example · eslint.config.js · .editorconfig
.github/workflows/ # CI：lint + coverage 门禁；GHCR 多架构发布（构建前同样先跑测试）
```

---

## 质量与验收

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 后端/核心单测（config、crypto、iLink 客户端、store 与拆分后的 data/**、限流、auth、API、绑定状态机、监控、换绑、媒体加解密/上传管线/入站下载与有界并发、入站下载 URL 白名单、schema 版本校验、数据库索引、用户分组、入站 API、用户级凭据（加密/掩码/级联删除）、凭据占位符解析与脱敏、会话保活调度、分组级保活继承、接口应用规则引擎与 SSRF IP 固定、shared 模板/响应管线、定时通知调度与生效时间段（含按用户模式 partial）、优雅退出 drain、数据维护 GC、可观测性指标、APP_SECRET 轮换、运行配置后台设置、后台菜单路由与初始化顺序、视图懒加载/弹窗交互/焦点陷阱/Tab 语义、响应式布局、前端模块/纯函数/弹窗行为、日志脱敏、错误映射） | `npm run test:unit` | **待发布前实测刷新**（`npm test` 最终值由 Lead 填写） |
| 端到端黑盒（真实 app 进程 + mock 微信 API/CDN + mock 外部接口，覆盖绑定/配对码/刷新/推送/入站/鉴权/解绑/错误注入/图片视频文件收发/分组/入站消息 API/24h 保活/分组保活继承/接口应用/凭据注入/定时通知（含按用户模式）/运行配置设置/密码与 API Token；子进程 env 白名单、稳定等待断言、mock 违规统一断言） | `npm run test:e2e` | **待发布前实测刷新** |
| 全量测试（unit + e2e） | `npm test` | **632 项（630 通过 + 2 项 POSIX-only 跳过）** |
| e2e 连跑稳定性（串行 3 次，CI 门禁） | `npm run e2e:stability` | 3/3 次通过（每次约 2 分钟） |
| 覆盖率（in-process，排除 `web/**` 与 `tests/**`，CI 强制阈值 line 90 / branch 70 / funcs 85） | `npm run coverage` | line **94.05%** / branch **77.76%** / funcs **94.46%**（CI 阈值门禁通过） |
| 静态检查（ESLint flat config，CI `--max-warnings=0`） | `npm run lint` | 0 error / 0 warning |
| 文档值级一致性（版本/环境变量/设置字段/API 端点/相对链接/质量表命令） | `npm run doc:lint` | 6 项全部通过（CI 门禁） |
| 可观测性指标（`GET /api/admin/metrics`、overview.metrics） | `npm run test:unit`（backend-metrics） | 契约与鉴权全覆盖 |
| mock 自身协议自测 | `node mock/selftest.mjs` | 26 项通过 |
| 浏览器冒烟测试（可复现的子集：登录、7 个菜单视图、新建/删除分组、规则/任务编辑器、Markdown 预览编号回归、登出、绑定页/文档页加载、Console 异常检查） | `npm run test:ui` | 17 项通过（无 Edge/Chrome 时自动跳过） |
| 演示数据截图（23 张 WebP，与 README 引用同名；自动脱敏、假名演示数据、1.0.0 UI） | `npm run screenshots` | 成功生成 / 可重复运行（合计约 1.2MB） |

> 说明：mock 用于本地/CI 验证协议与业务逻辑，真实微信 ClawBot 需在手机微信上扫码绑定后才能端到端体验；
> 首次启动会生成随机管理密码/API Token 并写入数据卷 `data/`；上线前请备份数据卷与 `APP_SECRET`，建议启用 HTTPS。

## 常见问题

**Q：扫码后一直停在「等待扫码 / 已扫码」？**
确认服务器能出网访问 `https://ilinkai.weixin.qq.com`（`docker compose logs clawbridge` 里
若有 `get_qrcode_status 网络错误` 即为此因）；二维码约 5 分钟有效，过期会自动刷新。

**Q：发送后用户没收到？**
到管理后台「消息记录」看出站状态与错误：`queued` 说明在限流队列中（微信约 7 条/5 分钟/账号）；
`failed` 且错误含 `-14` 说明 bot token 失效，需要用户重新扫码；`-2` 会自动退避重试。

**Q：消息里的换行在微信里变成空格/空行？**
微信 Markdown 会把相邻普通文本行的单换行合并成一行；ClawBridge 只在**普通文本行之间补最小必要空行**，
列表项之间、文本紧邻列表时不补。因此标题会各自独立显示，列表保持紧凑；模板里为代码排版写的换行不会变成列表项之间的空行。
详见 [`docs/MARKDOWN_WECHAT.md`](docs/MARKDOWN_WECHAT.md) §3.1。

**Q：绑定成功但用户微信里找不到 ClawBot 会话？**
在微信搜索「微信Claw」或从对话记录进入；这是微信 ClawBot 客户端表现，不是 ClawBridge 的问题。

**Q：发出的图片显示灰色占位、文件点「接收」提示已过期？**
这是出站媒体 `CDNMedia.aes_key` 编码错误导致的（接收端解密失败）。正确格式是
**base64(32 字符 hex key 的 ASCII 字节)**，而不是 base64(原始 16 字节 key)；本项目已在
`server/src/media.js` 修复并加了回归测试（见 `docs/MEDIA.md` §1.3 的踩坑记录）。
升级后**重新发送**即可；此前已发出的灰块/过期消息无法回溯修复。若升级后仍复现，请提供发送时间
与消息类型，检查日志中 `媒体已上传微信 CDN` 与 `媒体消息投递成功`。

**Q：ClawBot 消息在微信里能看到，但没有声音 / 横幅 / 角标提醒，不像普通好友消息？**
这是微信 ClawBot **机器人通道的平台行为**，不是 ClawBridge 的发送逻辑问题：iLink 协议里没有
"通知 / 静音"这类字段，ClawBridge 发送的 `msg` 结构与官方插件完全一致
（`message_type=BOT`、`message_state=FINISH`、`item_list` 文本/媒体）。是否提醒由微信客户端/服务端
决定——机器人会话通常按"服务/机器人会话"处理，提醒强度弱于好友消息（可能不响铃、不震动、无角标）。
可尝试：
1. 打开 ClawBot 聊天 → 右上角 → 关闭「消息免打扰」、开启「置顶聊天」；
2. 微信 → 我 → 设置 → 新消息通知：开启「接收新消息通知 / 声音 / 振动」；
3. 手机系统设置 → 微信 → 通知：允许横幅/锁屏/声音，关闭对该应用的电池限制；
4. 关闭手机「专注模式 / 勿扰模式」；把微信切到后台或锁屏后再让对方发一条测试；
5. 平台还有会话活跃度限制（社区反馈：用户 24 小时内无主动上行消息可能收不到推送）与频率上限，
   告警类通知建议结合服务号模板消息 / 企业微信 / 短信 / 邮件等强提醒通道。

**Q：端口 10380 被占用？**
修改 `docker-compose.yml` 的 `ports`（例如 `"18080:10380"`）后 `docker compose up -d`；
fnOS 同理修改 `docker-compose.fnos.yml`。只改宿主机侧映射，容器内监听端口保持 `10380`。

**Q：Docker 镜像拉取慢/失败？**
本仓库镜像基于 `node:24-alpine`；配置 Docker 镜像加速器，或预先 `docker pull node:24-alpine` 后
再构建。

**Q：如何备份/迁移？**
- **主 compose（命名卷）**：备份命名卷 `clawbridge-data`（SQLite、媒体、`app-secret.key`、初始凭据文件）：
  `docker run --rm -v clawbridge-data:/data -v "$PWD":/backup alpine tar czf /backup/clawbridge-data.tgz -C /data .`
  迁移/恢复时把备份解压回同名命名卷即可。
- **fnOS compose（项目目录）**：直接打包项目根目录下的 `data/` 目录即可：
  `tar czf clawbridge-data-backup.tgz data/`。

两种方式都**必须包含 `app-secret.key`**，否则历史凭证无法解密。
备份与恢复仅能与**同一版本基线**配套使用：1.0.0（schema v1）不能读取旧版本的数据卷，
旧版本也不能读取 1.0.0 的数据卷；升级/回滚请按 [`docs/UPGRADE.md`](docs/UPGRADE.md) 同时切换镜像与数据卷。

---

## 与官方插件 2.4.10 的兼容性

v1.1.0 起协议层按官方插件 `@tencent-weixin/openclaw-weixin@2.4.10` 逐项对齐：请求头矩阵（POST 恒带
`Content-Type`/`AuthorizationType`/`X-WECHAT-UIN`，GET 仅公共头）、`client_id` 官方格式、`bot_agent` 官方清洗、
版本常量自动派生、绑定轮询网络容错、`-14` 暂停 1h 后**自动恢复轮询**、退避节奏、`longpolling_timeout_ms`
原样使用、游标有消息立即落库/空闲按 6 小时节流落库、入站 `message_id` item 级回退与正文顺序、引用消息（quote/partial_quote）最小解析、
媒体引用下载 / voice 带文本跳过 / 缺媒体跳过 / MIME 路由对齐、Markdown 过滤（删除线只保留文字，普通文本行补最小必要空行、列表项不补）、
typing 参数（5s keepalive / 10s 超时 / 24h ticket 随机缓存 + 退避）。
**有意保留的差异**（多 media、最小换行布局、客户端限流/队列、AI 通道功能、`run_id` 等）见
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) §8「官方对齐与有意差异」。

---

## 限制与合规

- 微信 ClawBot 目前为官方 Public Beta，协议字段/限流可能变化；本项目按官方插件 2.4.10 实现，
  协议常量可通过环境变量覆盖（见 `docs/PROTOCOL.md` §2）。
- 请遵守微信生态内容合规要求，仅向已明确同意接收消息的用户推送，勿用于骚扰/营销群发。
- 单个 bot 账号的发送频率受微信服务端限制，ClawBridge 的队列和限流是保护措施，不能突破服务端上限。
- 本项目为自托管工具，与腾讯/微信无隶属关系；"微信"、"ClawBot" 等商标归其所有者。
- 用户数据分类、加密与访问边界、日志脱敏、备份及截图/演示数据规范见
  [`docs/PRIVACY.md`](docs/PRIVACY.md)（自托管部署者与公开仓库维护者均建议阅读）。

## 参考与致谢

- 微信官方 OpenClaw 微信通道插件 [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
  （Tencent，MIT License）：协议实现的事实来源（9 个 iLink 端点、请求头、二维码状态机、uint64 解析、
  `-14` 会话冷却等）。
- 第三方参考实现：[`@claw-lab/wxclawbot-cli`](https://www.npmjs.com/package/@claw-lab/wxclawbot-cli)、
  Dart [`weixin_clawbot`](https://pub.dev/packages/weixin_clawbot)。

## License

MIT

