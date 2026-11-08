# APP_SECRET 轮换操作手册（离线重加密）

> 适用版本：**ClawBridge 2.1.0（数据库 schema v10）**。
> 工具：`scripts/rotate-app-secret.mjs`（零外部依赖，仅需 Node ≥ 22.13 的 `node:crypto` + `node:sqlite`）。
> 相关：[升级与回滚](UPGRADE.md) · [配置字段](SETTINGS.md) · [HTTP API](API.md)。

## 0. 结论速览

| 问题 | 结论 |
| --- | --- |
| 为什么要工具？ | APP_SECRET 派生 AES-256-GCM 密钥，直接换 secret 会导致库内密文**无法解密** |
| 能在线执行吗？ | **不能**。必须停止服务/容器后离线执行；工具会检测数据库占用并拒绝 |
| 已绑定用户要重新扫码吗？ | **正常轮换不需要**（工具把 bot_token/context_token 重新加密，微信侧凭证不变） |
| 管理后台要重新登录吗？ | **需要**（APP_SECRET 同时派生管理会话签名，轮换后旧 Cookie 失效；已登录会话会掉线） |
| API Token / 管理密码会变吗？ | 不会。API Token 明文不变（仅重新加密），管理密码是 scrypt 哈希、不受影响 |
| 出问题怎么办？ | 工具执行前自动备份 DB；回滚 = 恢复备份 + 把 APP_SECRET 改回旧值（见 §7） |

## 1. 影响范围（轮换前必读）

- **服务必须停机**：脚本使用 SQLite 独占写事务 + WAL checkpoint；运行中的服务会持有连接并持续写 WAL，工具检测到占用会中止。多副本/多容器部署必须**全部停止**后再执行，只保留一个离线执行环境。
- **管理后台会话失效**：`server/src/crypto.js` 用 `sha256("clawbridge:session:v2:" + APP_SECRET)` 签名管理会话 Cookie。轮换后所有管理员需要重新登录（数据不受影响）。
- **已绑定用户无需重新扫码**：只要工具成功轮换全部密文，下一步用新 APP_SECRET 启动后，服务端可以正常解密用户的 `bot_token` / `context_token`，推送不受影响。
- **什么时候才需要重新扫码**：仅当**旧 APP_SECRET 丢失/无法恢复**、或部分密文已损坏无法解密时——这些用户的凭证无法还原，只能让其重新扫码绑定。替代方案见 §8。
- **API Token 明文不变**：`app_settings.security.apiTokenEnc` 只换加密密钥，外部调用方继续使用同一个 Token。想更换 Token 请在管理后台「运行配置 → 安全」操作。
- **管理密码不变**：`security.adminPasswordHash` 是 scrypt 哈希，不属于本工具处理范围。

### 1.1 覆盖的加密字段（与 server/src/crypto.js、server/src/settings/secrets.js 对齐）

| 存储位置 | 字段/键 | 明文内容 |
| --- | --- | --- |
| `users` | `token_enc` | 微信 bot_token |
| `users` | `context_token_enc` | 微信 context_token |
| `app_rules` | `request_headers_enc` | 规则请求 Header 的 JSON |
| `scheduled_tasks` | `request_headers_enc` | 定时任务请求 Header 的 JSON |
| `app_settings` | `key = 'security.apiTokenEnc'` | API Token（JSON 字符串包装的密文） |

> 其余非密文字段（昵称、URL、模板、`updated_at` 等）与 `security.adminPasswordHash` 保持原样；工具不会重建表、不改 schema。

## 2. 前置条件与风险

1. **停机窗口**：离线操作，通常 1-5 分钟（取决于数据量；百万行级别可能更久）。
2. **完整备份**：工具自身会在 `<data-dir>/backups/` 生成 `clawbridge-before-secret-rotation-<时间>.db`；仍建议按 [UPGRADE.md §2](UPGRADE.md#2-备份必须做且先验证) 再对数据卷整体备份一次。
3. **确认旧 secret 来源**：`APP_SECRET` 环境变量（`.env` / Docker secret / compose）> `<data-dir>/app-secret.key` 文件。两者必须与实际运行服务使用的一致。
4. **新 secret 强度**：64 位十六进制，或长度 ≥32 且至少包含 3 类字符（大写/小写/数字/符号）。生成示例：
   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```
5. **版本/schema**：适用于当前 schema v10；工具会校验目标表/列存在。旧 schema 库请先按 [UPGRADE.md](UPGRADE.md) 处理。
6. **安全**：新 secret 不要写进 shell 历史/聊天记录/URL；优先使用交互输入（默认不回显），或临时 secret 文件。

## 3. 操作步骤

以下以 Docker Compose 主部署为例；fnOS / 裸 Node 见 §3.4。

### 3.0 找到数据目录

- 主 compose：命名卷 `clawbridge-data` 挂在容器 `/app/data`。
- fnOS：项目目录下 `./data`（或 `.env` 的 `DATA_PATH`）。
- 裸 Node：`DATA_DIR`（默认仓库下 `data/`）。

### 3.1 停止服务

```bash
# 主 compose
docker compose down

# fnOS
docker compose -f docker-compose.fnos.yml down

# 裸 Node：Ctrl+C 或结束 node 进程（确认端口 10380 已释放）
```

### 3.2 备份（必须）

按 [UPGRADE.md §2](UPGRADE.md#2-备份必须做且先验证) 备份整个数据卷。最低要求：确认 `<data-dir>/clawbridge.db` 已复制，并验证副本可打开：

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log('schema',db.prepare(\"SELECT value FROM meta WHERE key='schema_version'\").get());db.close()" /path/to/clawbridge.db
```

### 3.3 先 dry-run，再执行

在**仓库根目录**执行（脚本会直接读/写 `<data-dir>/clawbridge.db`）：

```bash
# 1) 旧 secret 从环境变量读取（推荐；不要写进命令行）
export APP_SECRET='旧的 64 位 hex'   # Windows PowerShell: $env:APP_SECRET='...'

# 2) dry-run：只统计待轮换密文、不写库、不生成备份
node scripts/rotate-app-secret.mjs --data-dir /path/to/data --dry-run

# 3) 真实执行（--yes 必填；省略 --new-secret 时交互输入新 secret，不回显）
node scripts/rotate-app-secret.mjs --data-dir /path/to/data --yes
```

执行成功后输出每张表的轮换/跳过统计、备份文件路径，以及下一步清单（更新 APP_SECRET、重启、验证）。

> 数据量较大时建议把**数据目录**挂载到执行环境（容器内执行也可：
> `docker run --rm -v clawbridge-data:/app/data -v "$PWD/scripts:/app/scripts:ro" -e APP_SECRET ... node:24-alpine node /app/scripts/rotate-app-secret.mjs --data-dir /app/data --dry-run`）。

### 3.4 fnOS / 裸 Node 差异

- fnOS：`down` 后用真实路径 `--data-dir ./data`；不要把脚本放进数据目录。
- 裸 Node：停进程后 `--data-dir "$DATA_DIR"`；若 `APP_SECRET` 未在环境变量中，工具会自动读 `<data-dir>/app-secret.key`。

### 3.5 更新新 APP_SECRET

轮换后**必须**把新 secret 写入部署配置，否则重启后仍用旧 secret，会读不了新密文：

- `.env` 部署：修改 `APP_SECRET=<新值>`（权限 600，不要提交）。
- Docker secret / 编排变量：更新 secret 或 compose 变量后重新 `up -d`。
- 未设置 `APP_SECRET` 的部署（自动生成文件）：把新值写入 `<data-dir>/app-secret.key`（单行，0600；写前可先备份旧文件）。
- 裸 Node：更新启动环境变量或 `app-secret.key`。

### 3.6 启动并验证

```bash
docker compose up -d        # 或 fnOS / 裸 Node 对应命令
curl -fsS http://127.0.0.1:10380/health
```

验证清单见 §5。

## 4. 命令行参数

| 参数 | 说明 |
| --- | --- |
| `--data-dir <dir>` | 数据目录（默认 `$DATA_DIR` 或仓库下 `data/`）；DB 固定为 `<dir>/clawbridge.db` |
| `--backup-dir <dir>` | 备份目录（默认 `<data-dir>/backups`） |
| `--dry-run` | 只读取 + 解密统计：不写库、不生成备份；可同时校验新 secret 强度 |
| `--yes` | 真实执行确认（非 dry-run 时必填，防止误操作） |
| `--new-secret <s>` | 新 APP_SECRET；省略则在交互终端提示输入（不回显）。**注意会进入 shell 历史，优先交互输入** |
| `--help`, `-h` | 显示帮助 |

退出码：`0` 成功 / dry-run 成功；`1` 失败（错误信息不含任何 secret 或密文）。

## 5. 验证清单（轮换后）

1. `GET /health` 返回 200 且版本正常。
2. 管理后台可登录（旧会话已失效，属预期）。
3. 后台「用户管理」能看到用户列表；对任一用户「发消息」入队成功。
4. 「接口应用 → 测试运行」可解密该规则的 Header 并真实调用外部接口（响应正常）。
5. 「定时通知 → 测试运行」同样正常；日志无「无法解密/非法 JSON」类告警。
6. `docker compose logs app | grep -iE '忽略无法解密|忽略非法 JSON'` 无新增告警。
7. 观察 5-10 分钟：推送队列正常消费，入站监控无异常。

## 6. 回滚（未验证通过时）

1. 停止服务。
2. 把 §3.2 的备份（或工具生成的 `clawbridge-before-secret-rotation-*.db`）复制回 `<data-dir>/clawbridge.db`
   （备份基于 WAL checkpoint 后的主库文件，含轮换前全部数据）。
3. 把 APP_SECRET 改回**旧值**（或恢复旧 `app-secret.key`）。
4. 启动并验证 /health、登录、发消息。
5. 无需重跑工具：旧库 + 旧 secret 已恢复一致。

> 若已用新 secret 启动又发现异常，务必先停机再回滚，避免新库/旧 secret 组合继续写入。

## 7. 常见问题

| 现象 | 处理 |
| --- | --- |
| `旧 APP_SECRET 无法解密任何一条密文` | 旧 secret 与库不匹配。核对 `.env`/`app-secret.key`；用备份恢复后重试。**不要**继续用错误 secret 写入 |
| `数据库正被其它进程占用（WAL checkpoint busy）` | 服务/多副本未停。全部停止后重试 |
| `数据库文件不存在` | `--data-dir` 指错；容器命名卷需挂载到执行环境 |
| `新 APP_SECRET 强度不足` | 用 64 位 hex；或长度 ≥32 且至少 3 类字符 |
| 输出「存在无法解密/格式非法的密文」 | 这些行保持旧 secret 密文（未改）。若影响业务：恢复备份后用正确旧 secret 重跑；或让相关用户重新扫码/删重建规则 |
| 轮换成功但启动后用户推送失败 | 确认新 APP_SECRET 已生效（环境变量/文件），且所有副本一致；用 §5 的测试运行定位 |
| 忘记旧 secret | 从 `.env`、Docker secret、`data/app-secret.key`、备份中找回。**完全丢失时**旧密文无法恢复，只能按 [UPGRADE.md §4](UPGRADE.md#4-旧库schema--10--210-重建步骤) 空库重建 + 所有用户重新扫码（见 §8） |

## 8. 旧 secret 不可恢复时的替代方案

如果旧 APP_SECRET 已丢失且无备份：

1. 先尝试从部署配置、Docker secret、数据卷备份、`app-secret.key` 历史副本中找回；找到后仍按本手册正常轮换（**无需重新扫码**）。
2. 确实无法恢复：
   - 按 [UPGRADE.md §4](UPGRADE.md#4-旧库schema--10--210-重建步骤) 用备份数据卷/空库重建（用户、规则等需重建）；
   - 所有已绑定用户在微信侧需**重新扫码绑定**（旧 `bot_token`/`context_token` 已不可解密）；
   - 管理密码/API Token 会在新库首次启动时重新生成，需更新外部调用方。
3. 若只想暂时恢复服务，可保留旧数据卷不动，先用旧镜像/旧 secret 启动，再另择窗口轮换。

## 9. 安全注意事项

- 本工具**严禁**对运行中的生产库直接执行；执行前后都要确认服务已停止。
- 不要把 secret 放到命令行参数（会进 shell history/进程列表）；优先交互输入或由编排 secret 注入环境变量。
- 操作前对数据卷做**整卷**备份，并验证备份可打开（本工具只备份单个 DB 文件）。
- 轮换后删除临时备份中的明文敏感信息（备份本身即数据库，按生产数据同等保护）。
- 多副本/多容器场景：所有副本必须使用同一个 APP_SECRET；轮换后逐个更新并重启。
- 本工具不修改 schema、不重建表、不触碰 scrypt 密码哈希与业务明文数据。

## 10. 相关文档

- [升级与回滚（备份 / schema / 回滚）](UPGRADE.md)
- [配置字段与默认值（APP_SECRET 来源）](SETTINGS.md)
- [HTTP API 契约（健康检查 / 推送鉴权）](API.md)
- [架构与安全约定](ARCHITECTURE.md)
