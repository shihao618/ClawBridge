# 运行配置（后台可改设置）设计契约

> 需求：能在后台「运行配置」里改的参数，都存到数据库并可在后台修改，尽量不依赖 `.env`；
> `.env` 仅作为首次启动的默认值/机密项。修改后尽量即时生效，只有启动期固定的少量参数提示重启。

## 0. 范围

**可后台修改（DB，schema v8 `app_settings`）**：

| 分组 | 字段 |
| --- | --- |
| push | `rateLimitMax`、`rateLimitWindowMs`、`maxAttempts`、`retryDelaysMs`(逗号分隔)、`apiRateLimitPerMinute`、`maxTextLength` |
| keepalive | `enabled`、`windowMs`、`leadMs`、`tickMs`、`text`、`maxPerTick` |
| appRules | `enabled`、`timeoutMs`、`maxResponseBytes`、`workerConcurrency`、`allowedHosts`(数组/逗号分隔)、`maxQueue` |
| scheduler | `enabled`、`tickMs`、`timezone`(IANA)、`maxRecipients`、`timeoutMs` |
| media | `maxBytes`、`inboundMaxBytes` |
| binding | `ttlMs`、`maxRefreshes`、`maxActive`、`ipLimitPerHour`、`verifyTimeoutMs` |

**仍只由 `.env` 管理（启动前必须/根密钥/存储与监听）**：`APP_SECRET`、`DATA_DIR`、`MEDIA_DIR`、`PORT`、
`HOST`、`NODE_ENV`。管理密码与 API Token 只存 DB（后台「安全」卡片，首启自动生成到 data/ 文件）；
其余运行参数均可在后台「运行配置」修改。

## 1. 数据库 Schema v8（additive）

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,          -- '<group>.<field>'，如 'appRules.allowedHosts'
  value TEXT NOT NULL,           -- JSON 标量/数组/字符串
  updated_at INTEGER NOT NULL
);
```

- `app_settings` 表引入于 schema v8；当前 `SCHEMA_VERSION=9`（v9 为定时任务窗口列，不影响本表）；v7→v8 保留全部数据；新表空时使用 env 默认值。
- 只存**被修改过**的字段（新增/删除字段不影响未设置的默认值）。

## 2. 服务端 `server/src/settings.js`

- `SETTINGS_SCHEMA`：分组/字段元数据（key、label、type、min/max、default 从 `config` 读取、restartRequired 标记）；
- `loadOverrides()`：启动时读取 `app_settings` → 校验 → 覆盖 `config` 对应字段（深拷贝/可变 config 对象）；
- `getSettings()`：返回 `{ groups:[{key,label,fields:[{key,label,type,value,default,min,max,restartRequired,description}]}], envOnly:[...] }`；
- `updateSettings(patch)`：校验（类型/范围/时区/数组长度）→ 写 DB（UPSERT）→ 立即覆盖 `config` →
  调用运行时 hooks（重启 keepalive/scheduler 定时器、启停 appRules/keepalive/scheduler 引擎）；
  返回 `{ok, restartRequired:[keys]}`；
- `resetGroup(group)`：删除该组所有 DB 覆盖，恢复 env 默认并重新应用/hook；
- 所有写操作写 `events(type='settings_update')`（detail 只记录 group/field 名，不记录敏感值）。
- 启动顺序：db 初始化后、各引擎启动前 `settings.loadOverrides()`。

**即时生效说明**：
- `allowedHosts`、timeout、maxResponseBytes、media 限制、keepalive 文本/窗口/提前量、scheduler maxRecipients 等在使用时读取 → 即时；
- `keepalive.enabled/tickMs`、`scheduler.enabled/tickMs`、`appRules.enabled/workerConcurrency` 等通过 hook 重启对应定时器/引擎 → 即时；
- 若某字段无法安全热更新（如 rate limiter 已创建的桶），标记 `restartRequired`，前端提示"已保存，重启容器后生效"。

## 3. 管理端 API（Cookie + CSRF）

```
GET   /api/admin/settings            → { groups:[...], envOnly:[...] }
  // 每个字段自带 value（当前生效值）与 default（环境变量默认值）；不单独返回 envDefaults

PATCH /api/admin/settings            Body: { "push": {"rateLimitMax": 10}, "appRules": {"allowedHosts": ["192.168.88.10"]} }
  → 200 { ok:true, groups:[...], restartRequired:[...] }
POST  /api/admin/settings/reset      Body: { "group": "appRules" } → 200 { ok:true, groups:[...] }
```

- 校验失败 400；未登录 401/缺 CSRF 403；未知 group/field 400；未知用户影响无。
- 必须支持字段 `appRules.allowedHosts` 用数组或逗号分隔字符串传入；空数组=清空白名单（恢复默认拒绝私网）。

## 4. 前端（运行配置页）

- 将「运行配置」从只读列表改为**可编辑表单**：按分组（推送/限流、会话保活、接口应用、定时通知、媒体、绑定）展示字段，
  加载 `GET /api/admin/settings` 渲染 input/switch；
- 保存按钮收集变更 → `PATCH /api/admin/settings` → 成功后 toast（含"需重启"提示）并刷新；
- 每分组提供「恢复默认」按钮（reset）；显示来源（环境变量默认 vs 后台已修改）；
- 页面顶部提供 **「🔄 重启容器」** 按钮：确认弹窗 → `POST /api/admin/system/restart`（202）→
  按钮进入"重启中…"，前端轮询 `/health` 恢复后自动刷新页面；非生产容器环境返回 409 并提示手动重启；
  依赖 `docker compose` 的 `restart: unless-stopped`（进程退出后 Docker 自动拉起）。
- 只读区块继续展示 env-only 配置（脱敏）与版本信息；
- 保持零构建/CSP/textContent/移动端不溢出。

## 5. 真实环境上线

- v7→v8 additive migration；启动日志 `fromSchemaVersion:7→8`；
- 后台把 `APP_RULES_ALLOWED_HOSTS=192.168.88.10` 从 `.env` 移除，改在运行配置里设置 `接口应用 → allowedHosts`，
  重启容器验证持久化生效（用户任务 dry-run 200）；
- 其余常用参数（限流/保活/定时通知/媒体）改为后台可调，`.env` 仅保留机密与基础设施。

## 6. 测试要求

- 单测：v7→v8 迁移；settings 校验（类型/范围/时区/数组）；loadOverrides 覆盖 config；update 持久化+应用；
  resetGroup 恢复默认；API 401/403/400/200；events 不泄漏敏感值。
- e2e/黑盒：GET/PATCH settings（修改 keepalive.text/appRules.allowedHosts/media.maxBytes）→ 读取生效；
  invalid 400；reset 恢复默认。
- 前端：运行配置表单存在、分组/字段齐全、保存/恢复按钮、CSP 安全。

## 7. 第二批迁移：除「必须」外全部后台可改

目标：`.env` 只保留启动前必须知道/不能进 DB 的项，其余全部进 `app_settings` 并可在后台改。

### 7.1 仍必须由 `.env` 管理（最终名单）

| 变量 | 原因 |
| --- | --- |
| `APP_SECRET` | 加密主密钥（DB 内密文依赖它；不能把根密钥存进被它加密的 DB） |
| `DATA_DIR` | SQLite/媒体/自动密钥文件位置，DB 打开前必须确定 |
| `MEDIA_DIR` | 媒体存储路径（文件系统基础设施；默认 `DATA_DIR/media`） |
| `PORT` / `HOST` | 容器监听与端口映射，进程启动前必须确定 |
| `NODE_ENV` | 运行模式（生产容器判定/重启保护等） |

以上在后台只读展示 + 脱敏/路径展示。其余全部迁移到 DB（后台可改）。

### 7.2 新增设置分组/字段（全部 DB 可改）

| 分组 | 字段（type/范围） | 生效 |
| --- | --- | --- |
| server | `publicBaseUrl`(string，空/URL)、`trustProxy`(bool)、`cookieSecure`(bool)、`logLevel`(enum debug/info/warn/error/silent) | publicBaseUrl/cookieSecure/logLevel 即时（logLevel 调用 logger.setLogLevel）；trustProxy restartRequired |
| security | `sessionTtlMs`(number)、`pushApiEnabled`(bool) | 即时（登录时读取） |
| ilink | `loginBaseUrl`、`defaultBaseUrl`、`cdnBaseUrl`(URL)、`appId`、`channelVersion`、`botAgent`、`botType`、`routeTag`(string)、`clientVersion`、`requestTimeoutMs`、`qrPollTimeoutMs`、`longPollTimeoutMs`(number) | 全部 restartRequired |
| monitor | `longPollTimeoutMs`、`maxAccounts`(number) | restartRequired |
| media | 新增 `downloadTimeoutMs`、`uploadTimeoutMs`、`allowedImageMime`、`allowedVideoMime`（数组/逗号串） | 即时 |
| push | 新增 `tickMs`(number) | restartRequired |
| binding | 新增 `networkErrorLimit`、`pollGapMs`(number) | 即时 |

### 7.3 机密（管理密码 / API Token）改为后台管理

- DB 新增（仍在 `app_settings`，不新增表）：
  - `security.adminPasswordHash`：`scrypt` 哈希记录（salt/参数），登录校验优先用它，否则回退 env/自动生成密码；
  - `security.apiTokenEnc`：AES-256-GCM 加密的 API Token；`pushApiEnabled` 控制开关。
- 新增 API（Cookie + CSRF）：
  - `POST /api/admin/security/password` `{currentPassword,newPassword}` → 当前密码校验（仅 DB scrypt 哈希），
    new 8..128 字符，写 scrypt 哈希；返回 `{ok, adminPasswordSource:'db'}`；错误 400/401；
  - `POST /api/admin/security/password/reset` `{currentPassword}` → 校验后**生成新的随机密码**，
    写 DB 哈希 + `DATA_DIR/admin-password.txt`，返回 `{ok,password,source:'db'}`（明文仅本次响应）；
  - `POST /api/admin/security/api-token/rotate` → 生成新 token（返回明文仅此一次 + preview）、加密存 DB、
    更新 `config.secrets.apiToken`/`pushApiEnabled=true`；
  - `POST /api/admin/security/api-token/reset` → 同样生成新 token（写入 DB + `DATA_DIR/api-token.txt`），
    返回一次性明文；不再回退 env/文件旧值。
  - 所有事件只记动作，不记密码/Token。
- GET `/api/admin/settings` 新增 `security`：
  `{ adminPasswordSource:'db', apiTokenSource:'db', apiTokenPreview, pushApiEnabled, sessionTtlMs }`
  （**永不返回密码哈希/Token 明文**）。`envOnly` 缩小为 §7.1 六项。
- `loadOverrides()`：加载 `security.*` 覆盖到 `config.session.ttlMs`、`config.pushApiEnabled`、
  `config.secrets.apiToken`（解密）；密码哈希仅供 auth 校验；`server/ilink/monitor/media/push/binding` 字段映射到 config。
- auth.js：`verifyAdminPassword` **只校验 DB scrypt 哈希**（无记录返回 false，由启动 bootstrap 保证存在）；
  API Key 只校验 `config.secrets.apiToken`（只能由 DB load/bootstrap/rotate/reset 设置）。

### 7.4 前端

- 运行配置页自动渲染新增分组（server/security/ilink/monitor/media 扩展字段）；
- 新增「安全」卡片：
  - 管理密码：当前密码/新密码/确认新密码 + 提交（POST security/password）、「重置为随机密码」按钮；
  - API Token：当前预览 + 来源（数据库）；「重新生成」按钮 → 弹窗显示新 Token 一次 + 复制按钮；
    「恢复环境变量默认」按钮；推送 API 开关；
  - 全部提示：Token 只显示一次、修改密码不强制下线已登录会话（过期后失效）。
- 文档页更新「运行配置」章节与端点表；`.env.example` 标注仅 6 项必须 env + 其余可后台改。

### 7.5 测试与验收

- 单测：新字段校验（URL/enum/范围/数组）、loadOverrides 映射、restartRequired 标记、logLevel 即时生效；
  密码 change/verify/reset（错误当前密码 401/400、哈希格式）；token rotate/reset（旧 token 401、新 token 200、
  预览不回显）；GET settings 不泄漏；envOnly 只剩 6 项。
- e2e：PATCH 新字段 → 生效；改密码后用新密码登录、旧密码 401；rotate token 后旧 token 401/新 token 200；
  reset 生成新值；非生产容器不能调用无关。前端安全卡片渲染/提交。
- 真实环境：`env` 仅保留 6 项；重启后 loadOverrides 持久化。

## 8. 机密仅 DB 管理（无旧版本兼容）

用户明确「无需兼容旧版本」，因此移除旧 `.env` 机密兼容/回退，改为干净的首启引导：

- **删除** `legacy env→DB 自动迁移`；`ADMIN_PASSWORD` / `API_TOKEN` 环境变量**不再读取**（设置也不会报错，直接忽略）。
- **首次启动自动生成**（空 DB、无哈希/密文时，幂等）：
  - 生成随机管理密码 → scrypt 哈希存 `security.adminPasswordHash`，明文写入 `DATA_DIR/admin-password.txt`（0600），
    日志只提示文件路径（不打印明文）；
  - 生成随机 API Token → AES 密文存 `security.apiTokenEnc`，明文写入 `DATA_DIR/api-token.txt`（0600），
    日志只提示文件路径；`pushApiEnabled` 默认 true。
  - **DB 已有机密时不生成/不覆盖文件**；仅在新生成/重置/rotate 时写回文件；不再扫描/清理旧版遗留文件。
- **来源恒为 DB**：GET settings 的 `security.adminPasswordSource/apiTokenSource` 恒为 `'db'`。
- **重置语义**：
  - `POST /security/password/reset`（校验当前密码）→ 生成**新的随机密码**（不是回退 env），写 DB + `admin-password.txt`，
    明文仅本次响应返回；
  - `POST /security/api-token/reset`（或 `/rotate`）→ 生成新 token，写 DB + `api-token.txt`，明文仅本次响应返回。
- 旧版仅有 env 密码/token 的部署升级后不会继承 env 值（env 已被忽略），请通过 `data/admin-password.txt`（如已生成）
  或后台重置接口获取新值；`config.js` 不再读取/生成管理密码与 API Token 文件。
- `.env` 最终只保留 §7.1 六项（真实 Docker 部署下通常只需 `APP_SECRET`/`PORT`/`DATA_DIR`，其余用默认）。

