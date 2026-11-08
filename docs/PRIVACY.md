# 隐私与数据处置（Privacy & Data Handling）

> 适用对象：**自托管部署者（运营者）** 与 **公开仓库维护者/贡献者**。
> 本文说明 ClawBridge 处理哪些个人数据、加密与访问边界、日志脱敏、备份/删除、截图与演示数据规范，
> 以及公开仓库发布前检查清单。
> 相关文档：[SECURITY.md](../SECURITY.md)（漏洞报告与安全策略）、
> [docs/ROTATE_APP_SECRET.md](ROTATE_APP_SECRET.md)（APP_SECRET 轮换）、
> [docs/UPGRADE.md](UPGRADE.md)（备份/升级/回滚）、[docs/MEDIA.md](MEDIA.md)（媒体文件）。

## 0. 角色与范围

- ClawBridge 是**自托管单实例**服务：部署者（运营者）是数据控制者；项目维护者不接触运行数据，
  除非用户主动提供。
- 数据只存在于部署者控制的 `DATA_DIR`（SQLite + 媒体 + 密钥文件）与进程内存中；**无外部遥测/上报**。
- 默认无多租户隔离：同一实例内所有绑定用户的数据由同一运营者管理与访问。
- **非目标**：不提供端到端加密（服务端需持有明文凭证才能调用微信接口）；
  不防护拥有宿主机 root、`DATA_DIR` 或备份文件访问权的攻击者。

## 1. 数据分类

| 数据项 | 存储位置 | 形态 / 保护 | 敏感度 | 说明 |
| --- | --- | --- | --- | --- |
| 微信身份标识 | `users.wechat_user_id` / `ilink_bot_id` | 明文 | 中 | 可关联到微信用户/机器人 |
| 用户昵称 | `users.display_name` | 明文 | 中低 | 示例/演示数据必须使用假名 |
| bot 凭证 | `users.token_enc` | **AES-256-GCM** | 高 | 可代表 bot 调用微信接口 |
| 会话凭证 | `users.context_token_enc` | **AES-256-GCM** | 高 | 可直接用于向该用户发消息 |
| 消息内容 | `inbound_messages.text` / `outbox.text` | 明文（SQLite 文件） | 高 | 用户通信内容 |
| 入站原始 JSON | `inbound_messages.raw_json` | 落库前已脱敏（`context_token`/`aes_key` → `[redacted]`） | 中 | 保留消息结构用于排障 |
| 媒体文件 | `DATA_DIR/media/{inbound,outbound}` | 磁盘明文（文件 0600、目录 0700） | 高 | 图片/视频/文件/语音原始内容 |
| 加密 Header | `app_rules.request_headers_enc`、`scheduled_tasks.request_headers_enc` | **AES-256-GCM** | 高 | 第三方 API 密钥等 |
| 管理密码 | `app_settings.security.adminPasswordHash` + `DATA_DIR/admin-password.txt` | scrypt 哈希 + 明文文件（0600） | 高 | 文件仅用于首次找回，登录只校验哈希 |
| API Token | `app_settings.security.apiTokenEnc` + `DATA_DIR/api-token.txt` | **AES-256-GCM** + 明文文件（0600） | 高 | 对外 API 鉴权 |
| APP_SECRET（根密钥） | `.env` 或 `DATA_DIR/app-secret.key` | 明文（0600） | **极高** | 可解密库内全部加密凭证；单独妥善保管 |
| 运行/规则/定时日志 | `events` / `app_rule_logs` / `scheduled_task_logs` | 明文（预览已脱敏） | 中 | 含操作与请求摘要；按保留期清理 |
| 应用日志 | stdout / Docker json-file | 键名与 URL query 脱敏 | 中低 | 可能含 IP、路径、消息元数据 |

## 2. 加密与访问边界

### 2.1 传输

- 与微信 iLink API 的通信使用 HTTPS；部署时建议前置 HTTPS 反向代理
  （`PUBLIC_BASE_URL` / `TRUST_PROXY`，Cookie 自动/手动 `Secure`，见 [docs/SETTINGS.md](SETTINGS.md)）。
- 媒体只通过鉴权接口读取（`/api/admin/media/*` Cookie 鉴权、`/api/v1/media/*` API Key 鉴权），
  `DATA_DIR` 不直接对外暴露；媒体路径来自 DB 且限制在 `MEDIA_DIR` 内（防目录穿越）。

### 2.2 静态存储（at rest）

- **凭证/密钥**：`server/src/crypto.js` 的 AES-256-GCM（密钥由 `APP_SECRET` 派生）；管理密码用 scrypt 哈希。
- **文件权限**：启动设 `process.umask(0o077)`；`DATA_DIR` 0700、写入文件 0600；SQLite 文件启动时收口 0600。
- **未加密**：消息文本、昵称、微信 ID 与媒体文件内容在磁盘上为明文，依赖操作系统/磁盘访问控制。
  如需更强保护：全盘加密/加密卷、限制 `DATA_DIR` 权限与备份访问、专用主机部署。

### 2.3 运行期访问控制

- 管理后台：HttpOnly `cb_session`（HMAC 签名会话）+ 写接口 CSRF 头 + 登录 IP 限流；
- 对外 API：API Key（DB 密文 / 文件保存，常量时间比较）；
- 日志/错误响应不返回凭证明文；管理密码/Token 只在生成/重置响应中显示一次。

### 2.4 边界与前提

- 拿到 `DATA_DIR`（DB + 媒体）且同时拿到 `APP_SECRET`（或 `app-secret.key`）者可解密全部凭证并读取全部数据；
  **应把根密钥与数据/备份分开保存、限制访问**。
- 拥有宿主机 root、容器逃逸能力、内存 dump 或备份访问权的人，可绕过应用层控制。
- 反向代理/网关访问日志、容器平台日志可能包含 IP、URL、消息元数据；也需按隐私数据管理。

## 3. 日志脱敏

- 统一 logger 对**敏感键名**（authorization/token/secret/password/api_key/context_token/bot_token 等）按字段名替换为 `[redacted]`；
- 日志中的 **URL 查询参数**（webhook `?token=`、错误日志 path 等）对敏感参数值替换为 `[redacted]`，保留其余结构；
- 入站消息落库前的 `raw_json` 深度脱敏：`context_token` / `aes_key` / `aeskey` → `[redacted]`；
- 管理密码 / API Token 的变更只记录动作与文件路径，不记录明文或哈希；
- 接口应用运行日志的 `params_preview` / `request_preview` 对敏感字段与 query 脱敏；
- 仍建议：限制日志平台访问权限、避免长期开启 `debug` 级别（debug 可能含更多请求上下文）、
  按合规要求设置日志保留期（见 `MAINTENANCE_LOG_RETENTION_DAYS`）。

## 4. 备份、导出与删除

- **备份包含全部个人数据**（SQLite + media + `app-secret.key`/凭据文件）：必须加密存储/传输，
  禁止提交到 git（仓库 `.gitignore` 已忽略 `data/`、`/backups/`、`*.db`、`.env*`、`*.key` 等）。
- 备份/升级/回滚步骤见 [docs/UPGRADE.md](UPGRADE.md)（升级前必须备份 `DATA_DIR`）。
- **删除用户**：管理后台删除用户会级联删除其 outbox / inbound_messages / attachments / 规则与事件记录，
  并删除媒体文件（**不可恢复**）；只想停止收发请用「解绑」。删除前请确认已备份。
- **导出**：当前无内置全量导出工具；可用 SQLite 只读查询 + 打包媒体目录（注意含敏感数据）；
  外部系统可用 v1 入站消息 API（`GET /api/v1/inbound/messages`）按用户增量拉取。
- **APP_SECRET 轮换**：实操（离线停机、备份、重加密、验证、回滚）见
  [docs/ROTATE_APP_SECRET.md](ROTATE_APP_SECRET.md)；轮换前务必完整备份 `DATA_DIR` 并阅读其风险说明。
- **保留期**：`server/src/maintenance.js` 默认每天清理孤儿附件/媒体与超期日志
  （`MAINTENANCE_LOG_RETENTION_DAYS` 默认 90 天，0=保留；`outbox`/`inbound_messages` 业务数据不自动删除），
  见 [docs/UPGRADE.md](UPGRADE.md) §8。

## 5. 截图与演示数据规范（公开仓库）

- **只使用虚构演示数据**：昵称（如“演示用户A/B”）、分组名（如“示例分组”）、消息内容不得使用真实用户信息；
  严禁出现真实微信 ID、昵称、群名、手机号、邮箱、token/context_token 值。
- 用 **mock 模拟器 + 独立临时 `DATA_DIR`** 生成演示数据，不要对生产实例截图。
- 截图不得出现本机绝对路径/用户名（Windows 用户目录、临时目录等）、真实域名/IP、浏览器书签或系统通知；
  地址栏使用 `127.0.0.1`/`example.com` 等安全值。
- 推荐用 `npm run screenshots`（`scripts/screenshots.mjs`，headless 浏览器 + 演示数据 + 自动脱敏断言）
  生成/更新截图；README 当前截图均为假名演示数据（`.webp`）。
- 二进制截图无法 grep 审查：新增/替换后需人工抽查（或用 `read_image`）确认无个人数据。

## 6. 公开仓库发布前检查清单

- [ ] `git status` 干净；变更只包含应发布文件，无临时文件/本地数据。
- [ ] 确认未提交机密/数据：`.env*`、`data/`、`backups/`、`*.db*`、`*.key`、`admin-password.txt`、
      `api-token.txt`、媒体文件（`.gitignore` 已覆盖；用 `git ls-files` 复核）。
- [ ] grep 隐私残留（`docs/review/` 历史审查快照除外）：真实昵称、本机绝对路径、邮箱/手机号、
      token/context_token 值；用系统用户名/用户目录/临时目录等关键词检索 `docs/`、`README.md`、
      `CHANGELOG.md`、`web/`、`scripts/`。
- [ ] 截图与演示数据符合 §5；新生成截图已抽查。
- [ ] 文档一致性：`npm run doc:lint`；代码检查：`npm run lint`；mock 自测：`node mock/selftest.mjs`。
- [ ] CHANGELOG 记录隐私/安全相关变更；[SECURITY.md](../SECURITY.md) 报告渠道有效。
- [ ] 发布镜像附 provenance/SBOM、使用版本 tag（见 [docs/RELEASE.md](RELEASE.md)）。
- [ ] 历史 git 中的旧敏感文件/截图已按 §7 评估处置（需 Owner 确认）。

## 7. 历史提交中的旧截图：评估与处置建议（需 Owner 确认）

**现状**：早期开发阶段（v1.0.0 UI 时期）生成的截图曾包含真实风格的运行数据——用户昵称、绑定时间、
运营分组名、本机绝对路径（Windows 用户目录/临时目录）等；这些截图已从当前工作区与最新提交中**替换为
假名演示数据（`.webp`）**，但**旧截图仍存在于 git 历史提交中**（公开仓库可被检索）。当前工作区截图已
全部为演示数据；`docs/review/` 为内部历史审查快照，保留当时的路径/数据描述原文。

**风险评估**：

- 若旧截图中的昵称/分组为**真实用户/真实运营数据**：公开 git 历史构成个人数据暴露
  （昵称 + 绑定时间 + 分组名 + 本机路径，敏感度中低，但已公开）。
- 若为虚构测试数据：风险低，但仍建议避免本机路径/用户名长期留存。
- 任何历史重写都会影响已发布镜像的 commit/tag 引用、CHANGELOG/Release 链接与现有 fork，需权衡可追溯性。

**处置选项（本仓库不自动改写历史，需 Owner/维护者决策）**：

| 选项 | 动作 | 适用 | 代价 |
| --- | --- | --- | --- |
| A. 保守处置（建议先做） | 确认昵称/分组是否为真实数据；在 README/PRIVACY 声明示例数据均为虚构；继续使用当前干净截图 | 数据为虚构或敏感度低 | 无历史改写；旧截图仍可检索 |
| B. 彻底清理 | 归档旧仓库后重建干净历史（squash/新仓库），同步更新 tag/Release/镜像 provenance | 要求历史中不残留旧截图 | 改写全部 commit/PR 引用，需通知用户/fork |
| C. 按隐私事件处理 | 若确认为真实个人数据：评估通知受影响用户、force-push 重写历史并清理 GitHub 缓存/分支/tag，必要时归档旧仓库 | 真实个人数据暴露 | 操作复杂、影响面大，需 Owner 授权与记录 |

**执行任何历史重写前**：完整备份仓库；评估对已发布镜像 sha、tag、CHANGELOG/Release 链接的影响；
完成后更新本文档与 [SECURITY.md](../SECURITY.md) 记录处置结果。

## 8. 相关文档

- 安全策略与漏洞报告：[SECURITY.md](../SECURITY.md)
- APP_SECRET 轮换：[docs/ROTATE_APP_SECRET.md](ROTATE_APP_SECRET.md)
- 升级 / 备份 / 回滚：[docs/UPGRADE.md](UPGRADE.md)
- 版本发布流程：[docs/RELEASE.md](RELEASE.md)
- 媒体文件与配置：[docs/MEDIA.md](MEDIA.md)、[docs/SETTINGS.md](SETTINGS.md)
- 历史审查快照（含旧数据记录，内部归档）：`docs/review/`
