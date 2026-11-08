# 升级与回滚（Upgrade / Rollback）

> 适用版本：**ClawBridge 2.0.0（数据库 schema v10）**。本文只讲「数据与镜像」的升级/回滚实操；
> 配置字段与默认值见 [`docs/SETTINGS.md`](SETTINGS.md)，媒体文件规则见 [`docs/MEDIA.md`](MEDIA.md)，
> 版本变更摘要见 [CHANGELOG.md](../CHANGELOG.md)。

## 0. 先看结论（TL;DR）

| 场景 | 是否可原地升级 | 操作 |
| --- | --- | --- |
| 2.0.0 → 后续 **同为 schema v10** 的小版本 | ✅ 可以 | 备份 → 拉取/构建新镜像 → `up -d` |
| 旧版本（schema **< 10**，如 v9）→ 2.0.0 | ❌ **不可以** | 备份 → **空库重建** → 重新扫码绑定 → 手工重建后台配置 |
| 全新部署 | — | 直接启动，自动创建 v10 空库 |
| 回滚（降级） | 视目标版本而定 | v10 → v10：换回旧镜像即可；回滚到旧 schema：**必须连数据卷一起回滚** |

关键设计（`server/src/db.js`）：启动时读取 `meta.schema_version`，若既不是 0（全新库）也不是
**10**，直接抛错拒绝启动，**不执行任何 `ALTER TABLE` / 逐级迁移**：

```text
数据库 schema v9 不再兼容（当前 v10）；旧版本迁移已移除，请备份后使用新版空库重建
```

因此「升级」在旧库场景下 = **备份 → 用空库重建 → 重新绑定**；数据库内的用户、分组、规则、
定时任务、消息记录、附件记录都不会迁移（媒体文件可以保留归档，但新库不会引用它们）。

## 1. 升级前检查清单

1. **记录当前版本与镜像**（回滚依赖它）：
   ```bash
   # 主 compose（本地构建 image: clawbridge:local）
   docker compose images
   docker image inspect clawbridge:local --format '{{.Id}} {{index .RepoDigests 0}}'
   # fnOS（GHCR 镜像）
   docker inspect clawbridge --format '{{.Config.Image}}'
   docker image inspect ghcr.io/shihao618/clawbridge:latest --format '{{index .RepoDigests 0}}'
   ```
   把输出记下来；**fnOS 建议把镜像固定为 `sha-<commit>` tag**（见 §6.2），不要长期只用 `:latest`。
2. **备份数据目录**（见 §2），并至少保留一份到宿主机其它路径，校验压缩包可解。
3. 备份/确认 `.env`（尤其 `APP_SECRET`；丢失将无法解密旧库中的 bot_token/context_token）。
4. 预留磁盘空间（备份 + 新数据卷，建议 ≥ 2 倍当前数据大小）。
5. 选维护窗口：旧库重建期间服务不可用；用户需要**重新扫码绑定**，请提前通知。

## 2. 备份（必须做，且先验证）

数据卷/数据目录里必须包含：`clawbridge.db`（可能还有 `-wal`/`-shm`）、`media/`、
`app-secret.key`、`admin-password.txt`、`api-token.txt`。

### 2.1 主 compose（Docker 命名卷 `clawbridge-data`）

```bash
docker compose stop clawbridge
docker run --rm -v clawbridge-data:/data:ro -v "${PWD}/backups:/backup" alpine:3.20 \
  sh -c 'tar czf /backup/clawbridge-data-$(date +%Y%m%d-%H%M%S).tgz -C /data .'
ls -lh backups/
```

PowerShell 等价（日期先由 PowerShell 展开）：

```powershell
New-Item -ItemType Directory -Force backups | Out-Null
docker compose stop clawbridge
docker run --rm -v clawbridge-data:/data:ro -v "${PWD}\backups:/backup" alpine:3.20 `
  sh -c "tar czf /backup/clawbridge-data-$(Get-Date -Format yyyyMMdd-HHmmss).tgz -C /data ."
```

不额外拉取 alpine 的替代方式（容器已停止也可 `docker cp`）：

```bash
docker compose stop clawbridge
docker cp clawbridge-app:/app/data "./backups/data-$(date +%Y%m%d-%H%M%S)"
```

### 2.2 fnOS（`./data` 真实目录，或 `.env` 中 `DATA_PATH`）

```bash
docker compose -f docker-compose.fnos.yml stop
tar czf "backups/clawbridge-data-$(date +%Y%m%d-%H%M%S).tgz" -C ./data .
```

NAS 用户也可直接用文件管理器把 `data/` 目录复制一份到备份目录（确保包含隐藏文件）。

### 2.3 本地裸 Node（`npm start`）

```bash
# 先 Ctrl+C 停止进程，再整目录复制（示例 DATA_DIR=./data）
cp -a data "data-backup-$(date +%Y%m%d-%H%M%S)"
```

> ⚠️ **不要**用 `docker compose down -v`（或任何 `-v`/删卷命令）做“清理”——它会直接删除数据卷。
> 备份完成前不要删卷、不要覆盖 `data/`。

## 3. 判断数据卷的 schema 版本

**方式 A（最简单）**：直接用当前版本启动一次，看日志/报错：能正常启动即 v10（或空库）；报
“数据库 schema vX 不再兼容（当前 v10）”即旧库。

**方式 B（离线读取备份，不启动服务）**：

```bash
# Node ≥ 22.13（node:sqlite 免 flag）。注意：复制出来的是备份里的 clawbridge.db 副本
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('clawbridge.db',{readOnly:true});console.log(db.prepare(\"SELECT value FROM meta WHERE key='schema_version'\").get())"
# 有 sqlite3 命令行时也可以：
# sqlite3 clawbridge.db "SELECT value FROM meta WHERE key='schema_version';"
```

结果含义：`10` = 可原地升级（§5）；`0` 或查询不到 = 空库/极早期库（按空库处理）；
其它值（如 9）= 旧库，必须走 §4 重建。

## 4. 旧库（schema < 10）→ 2.0.0 重建步骤

> 目标：把“旧库 + 旧媒体”留档，换一个**空 v10 库**启动，再重新绑定/配置。

### 4.1 停止服务

```bash
# 主 compose
docker compose down
# fnOS
docker compose -f docker-compose.fnos.yml down
# 裸 Node：Ctrl+C / 结束进程
```

### 4.2 备份并验证（见 §2）

确认备份文件存在且大小合理，并（可选）用 §3 方式 B 读出旧库版本号写入备份目录的说明文件。

### 4.3 清空旧库（三种部署方式）

**主 compose（命名卷）**：

```bash
# 确认 §2 备份已完成并校验！
docker volume rm clawbridge-data      # 删除旧数据卷
docker compose up -d --build          # 重新创建空卷 + 启动（首次启动自动建 v10 空库）
```

> 想保留旧卷做只读归档，可不删卷，改为「另起新卷」：先 `docker volume create clawbridge-data-v10`，
> 再临时加一个 override 文件把 `volumes.clawbridge-data.name` 指向新卷（或直接把旧卷导出成 tar
> 长期保存）。最简单且不易错的仍是：**tar 备份 → 删卷重建**。

**fnOS（`./data` 目录）**：

```bash
docker compose -f docker-compose.fnos.yml down
mv data "data-v9-backup-$(date +%Y%m%d-%H%M%S)"   # 旧数据整体改名留档
mkdir -p data                                       # 必须提前创建，且属主为 PUID:PGID
sudo chown -R 1000:1000 data                        # 按 .env 的 PUID/PGID 调整
docker compose -f docker-compose.fnos.yml up -d
```

**本地裸 Node**：把 `data/` 改名留档，重新 `npm start`（会自动创建新 `data/` 与 v10 空库）。

### 4.4 取新的管理密码 / API Token

```bash
docker exec clawbridge-app cat /app/data/admin-password.txt   # 主 compose（容器名 clawbridge-app）
docker exec clawbridge cat /app/data/admin-password.txt      # fnOS（容器名 clawbridge）
# API Token 同理：cat /app/data/api-token.txt
```

如果 `.env` 里已有 `APP_SECRET` 会沿用；没有则由程序自动生成 `data/app-secret.key`。
**新库与新 `APP_SECRET` 必须一起备份**，后续升级/迁移都依赖它们。

### 4.5 重新绑定微信用户

打开 `http://<IP>:10380/`（绑定页）→ 每个用户重新「输入昵称 → 微信扫码 → 确认」。
旧凭证（bot_token/context_token）在旧库中，无法迁移；必要时先让用户在微信里管理旧授权。

### 4.6 手工重建后台配置

旧库里的以下数据**不会自动迁移**，需在管理后台重建（按重要性排序）：

- 用户分组与分组保活开关（`POST /api/admin/groups`、`PUT /api/admin/users/{id}/groups`）；
- 接口应用规则（`POST /api/admin/app-rules`）与定时通知任务（`POST /api/admin/scheduled-tasks`）；
- 运行配置（「运行配置」页按需重设；未设置的字段沿用 `.env`/内置默认值）；
- 24h 会话保活：需对用户/分组重新开启（opt-in 默认关闭）。

### 4.7 验收

```bash
curl -s http://127.0.0.1:10380/health        # {"status":"ok","version":"2.0.0"}
```

- 后台可登录（新密码）、`/docs` 可打开；
- 绑定页可完成扫码绑定；
- 发送一条文本 + 一张图片做端到端自测（媒体走 CDN，见 docs/MEDIA.md）；
- 旧媒体文件已随备份留档；如需清理由你自行处理（新库不引用旧附件）。

## 5. 同一 schema（v10）的原地升级

适用于：2.0.0 及后续仍为 schema v10 的版本（例如 2.0.x 修复版）。查询索引等通过
`CREATE INDEX IF NOT EXISTS` 在启动时幂等补齐，不会改 schema 版本。

```bash
# 1) 备份（§2）
# 2) 更新代码/镜像
git pull                                  # 主 compose：源码构建方式
docker compose up -d --build
# 或：docker compose pull && docker compose up -d   # 使用 GHCR 镜像时
# fnOS：
docker compose -f docker-compose.fnos.yml pull
docker compose -f docker-compose.fnos.yml up -d
# 3) 确认健康
curl -s http://127.0.0.1:10380/health
```

回滚同样简单：把镜像换回升级前的 tag/digest（§6.1），数据卷不用动。

## 6. 回滚（降级）

### 6.1 v10 → v10（回滚到上一个 2.x 镜像）

数据兼容，只需换回旧镜像：

```bash
# 主 compose（本地构建）：从升级前记录/备份的镜像 tag 恢复
docker compose down
docker tag clawbridge:pre-upgrade clawbridge:local   # 若升级前做过 docker tag 备份
docker compose up -d
# fnOS：把 docker-compose.fnos.yml 的 image 固定到旧版本 tag 后 up -d
```

升级前建议先 `docker tag clawbridge:local clawbridge:pre-upgrade`（或 `docker save -o` 存档），
避免旧镜像被清理后无法回滚。

### 6.2 回滚到旧 schema 版本（2.0.0 → 旧版本）

旧版本程序只能读旧 schema 的库，**必须同时恢复旧镜像与旧数据卷**：

1. 停止当前服务；
2. 把当前 v10 数据也备份一份（以防再次升级）；
3. 用 §2 的备份恢复旧数据卷/旧 `data/` 目录（覆盖或新建同名卷）；
4. 用旧版本镜像启动（旧 tag / `sha-<commit>` / 本地保存的旧镜像）；
5. 若旧库与新 `APP_SECRET` 不匹配，用备份中的 `app-secret.key` 一并恢复。

```bash
# 主 compose：恢复命名卷（示意）
docker compose down
docker volume rm clawbridge-data
docker volume create clawbridge-data
docker run --rm -v clawbridge-data:/data -v "${PWD}/backups:/backup" alpine:3.20 \
  sh -c 'tar xzf /backup/clawbridge-data-<时间戳>.tgz -C /data'
docker compose up -d
```

> ⚠️ 回滚到旧版本 = 放弃 2.0.0 期间产生的数据（v10 库不能被旧版本读取，只能留档）。
> 如果已经用 2.0.0 重新绑定/配置过，回滚前请明确取舍。

### 6.3 固定版本以便回滚（推荐）

GHCR 镜像同时发布 `:latest`、`sha-<commit>`（以及打 tag 后的版本 tag，如 `:v2.0.0`）。
fnOS 用户可把 `docker-compose.fnos.yml` 中：

```yaml
image: ghcr.io/shihao618/clawbridge:latest
```

改为具体版本以锁定升级时机（示例，sha 见 GHCR 页面或 `docker image inspect`）：

```yaml
image: ghcr.io/shihao618/clawbridge:sha-<commit>
```

升级 = 改 tag 后 `docker compose -f docker-compose.fnos.yml pull && ... up -d`；回滚 = 改回旧 tag。

## 7. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动失败：`数据库 schema v9 不再兼容（当前 v10）…` | 数据卷还是旧库。**不要直接删库**：先按 §2 备份，再按 §4 重建空库 |
| 新卷启动后无法登录后台 | 新库首次启动重新生成了随机密码：从 `data/admin-password.txt` 读取，或见启动日志提示路径 |
| 忘记 `APP_SECRET` / 旧 `app-secret.key` 丢失 | 旧库中的加密凭证（bot_token/context_token/API Token）将无法解密，只能重新绑定/重置；新空库不受影响 |
| `docker compose down -v` 后数据没了 | `-v` 会删除命名卷；只能从备份恢复（§2/§6.2） |
| 升级后媒体列表为空，但磁盘上还有旧文件 | 正常：新库没有旧附件记录。旧文件已备份归档，可自行清理 |
| fnOS 容器无法写入 `data/` | 目录必须提前创建并归 `PUID:PGID`（默认 1000:1000）所有 |
| 想保留旧版本只读归档 | 删除/改名旧卷前，已用 §2 tar 备份；不要依赖 `:latest` 长期保存旧镜像 |

## 8. 数据维护（GC / 日志保留）

`server/src/maintenance.js` 随应用启动运行：**默认启动 1 分钟后首次、之后每天一次**执行数据维护
（进程内定时器，随进程退出；`stop()` 幂等并等待在途任务结束，在关库前调用）。维护参数目前从 **env**
读取（尚未并入后台「运行配置」）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MAINTENANCE_ENABLED` | `1` | `0` = 关闭定时维护（不影响业务；启动时读取，需重启生效） |
| `MAINTENANCE_INTERVAL_MS` | `86400000`（24h；范围 60s–7d） | 维护周期（启动时读取，需重启生效） |
| `MAINTENANCE_INITIAL_DELAY_MS` | `60000`（1min） | 启动后首次维护延迟（启动时读取，需重启生效） |
| `MAINTENANCE_LOG_RETENTION_DAYS` | `90` | `events` / `app_rule_logs` / `scheduled_task_logs` 保留天数（`0`=不清理；每轮实时读取） |
| `MAINTENANCE_UPLOAD_RETENTION_DAYS` | `7` | 管理端上传但从未入队的 outbound 附件保留天数（`0`=不清理） |
| `MAINTENANCE_BATCH_SIZE` | `200`（1–1000） | 单批删除/扫描上限（分批 + 事务提交） |
| `MAINTENANCE_ORPHAN_FILE_MIN_AGE_MS` | `3600000`（1h） | 孤儿媒体文件最小年龄，防误删正在写入的文件 |
| `MAINTENANCE_PRAGMA_OPTIMIZE` | `1` | 维护后执行 `PRAGMA optimize` |
| `MAINTENANCE_WAL_CHECKPOINT` | `1` | 维护后执行 `PRAGMA wal_checkpoint(TRUNCATE)` |

清理内容（均为**不可恢复删除**，清理前请确认 §2 备份有效）：

1. **附件行**：`status='ready'` 但磁盘文件缺失的 `attachments` 行 —— 被 `queued/sending` outbox 引用的保留
   （交由 dispatcher 判定失败）；`status='failed'` 允许无文件，不处理。
2. **孤儿媒体文件**：`media/inbound`、`media/outbound` 下无 DB 引用、且超过最小年龄的文件。
3. **过期上传**：管理端上传的 outbound 附件（`user_id IS NULL`）超过保留期、且从未被任何 outbox
   以 `media_id` 引用 → 删除 DB 行 + 磁盘文件。
4. **日志保留**：`events` / `app_rule_logs` / `scheduled_task_logs` 超期分批删除；
   **`outbox` / `inbound_messages` 属业务数据，不自动删除**。
5. 每轮结束输出维护日志（各类清理计数）；SQLite `optimize`/`wal_checkpoint` 可用 env 关闭。

> 想长期保留审计日志：把 `MAINTENANCE_LOG_RETENTION_DAYS` 调大或设为 `0`（关闭日志清理）。
> 维护 env 是否生效：`ENABLED`/`INTERVAL`/`INITIAL_DELAY` 需重启；保留天数等参数下一轮维护实时生效。

## 9. 相关文档

- 配置字段与默认值：[`docs/SETTINGS.md`](SETTINGS.md)
- 媒体文件与 CDN：[`docs/MEDIA.md`](MEDIA.md)
- 24h 会话保活：[`docs/KEEPALIVE.md`](KEEPALIVE.md)
- 用户分组 / 入站 API：[`docs/GROUPS_AND_INBOUND.md`](GROUPS_AND_INBOUND.md)
- 接口应用 / 定时通知：[`docs/API_RULES.md`](API_RULES.md)、[`docs/SCHEDULED_TASKS.md`](SCHEDULED_TASKS.md)
- HTTP API 契约：[`docs/API.md`](API.md)
- 版本变更摘要：[CHANGELOG.md](../CHANGELOG.md)
