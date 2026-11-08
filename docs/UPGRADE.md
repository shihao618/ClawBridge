# 部署、升级与回滚（Upgrade / Rollback）

> 适用版本：**ClawBridge 1.0.1（数据库 schema v1，全新数据基线）**。
> 本文说明全新部署、从旧版本数据卷切换到 1.0.0、备份与回滚的实操步骤；
> 配置字段见 [`docs/SETTINGS.md`](SETTINGS.md)，发布流程见 [`docs/RELEASE.md`](RELEASE.md)，
> APP_SECRET 轮换见 [`docs/ROTATE_APP_SECRET.md`](ROTATE_APP_SECRET.md)。

## 0. 先看结论（TL;DR）

| 场景 | 是否可原地升级 | 操作 |
| --- | --- | --- |
| 全新部署 | — | 空数据卷直接启动，自动创建 schema v1 空库 |
| 旧版本数据卷（schema 不为 1）→ 1.0.0 | ❌ **不可以** | 备份旧数据卷（保留旧镜像）→ **全新空数据卷**启动 → 重新扫码绑定/重建配置 |
| 1.0.0 → 后续仍为 schema v1 的版本 | ✅ 可以 | 备份 → 拉取/构建新镜像 → `up -d` |
| 回滚 | 视目标版本而定 | 同一 schema：换回旧镜像即可；跨 schema：**镜像 + 数据卷必须一起回滚** |

**关键设计**（`server/src/db.js`）：本版本为**全新数据基线**，只接受「空库（自动建表）」或
「当前 schema_version = 1」；检测到其他版本直接抛错拒绝启动，**不提供任何迁移、导出或升级脚本**：

```text
数据库版本不兼容（检测到 schema_version=<旧值>，当前为 1）；
本版本为全新数据基线，不支持旧数据升级：请使用全新空数据卷重新开始
```

因此「从旧版本升级」= **备份旧数据 → 换全新空数据卷 → 重新绑定用户、重建配置**；
旧库中的用户/分组/规则/定时任务/消息记录/媒体附件不会迁移。

## 1. 升级前检查清单

1. **记录当前版本与镜像**（回滚依赖它）：
   ```bash
   docker compose images
   docker image inspect clawbridge:local --format '{{.Id}} {{index .RepoDigests 0}}'
   # fnOS（GHCR 镜像）
   docker inspect clawbridge --format '{{.Config.Image}}'
   docker image inspect ghcr.io/shihao618/clawbridge:latest --format '{{index .RepoDigests 0}}'
   ```
   把输出记下来；建议发布/升级前给当前镜像打本地标签（如 `docker tag clawbridge:local clawbridge:pre-upgrade`）。
2. **备份数据目录**（见 §2），至少保留一份到宿主机其它路径，校验压缩包可解。
3. 备份/确认 `.env`（尤其 `APP_SECRET`；丢失将无法解密该数据卷内的凭证）。
4. 预留磁盘空间（备份 + 新数据卷，建议 ≥ 2 倍当前数据大小）。
5. 选维护窗口：切换期间服务不可用；用户需要**重新扫码绑定**，请提前通知。

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

> ⚠️ **不要**用 `docker compose down -v`（或任何 `-v`/删卷命令）做「清理」——它会直接删除数据卷。
> 备份完成前不要删卷、不要覆盖 `data/`。

## 3. 从旧版本数据卷切换到 1.0.0

> 目标：把旧数据（旧库 + 旧媒体）**留档**，换一个**全新空数据卷**启动 1.0.0，再重新绑定/配置。
> 旧版本镜像与数据卷请保留，以便需要时整体回滚。

### 3.1 停止服务

```bash
docker compose down                                  # 主 compose
docker compose -f docker-compose.fnos.yml down       # fnOS
# 裸 Node：Ctrl+C / 结束进程
```

### 3.2 备份并验证（见 §2）

确认备份文件存在且大小合理；建议把旧数据卷也保留一份（不删卷、只改为归档/改名）。

### 3.3 使用全新空数据卷启动 1.0.0

**主 compose（命名卷）**：

```bash
# 确认 §2 备份已完成并校验！
docker volume rm clawbridge-data      # 删除旧数据卷（或改名归档后创建全新的同名卷）
docker compose up -d --build          # 重新创建空卷 + 启动（首次启动自动建 schema v1 空库）
```

> 想保留旧卷做只读归档：可先 `docker volume create clawbridge-data-old` 并导出/复制旧卷内容归档，
> 或直接把旧卷 tar 长期保存；最简单且不易错的仍是：**tar 备份 → 删卷重建**。

**fnOS（`./data` 目录）**：

```bash
docker compose -f docker-compose.fnos.yml down
mv data "data-old-backup-$(date +%Y%m%d-%H%M%S)"    # 旧数据整体改名留档
mkdir -p data                                        # 必须提前创建，且属主为 PUID:PGID
sudo chown -R 1000:1000 data                         # 按 .env 的 PUID/PGID 调整
docker compose -f docker-compose.fnos.yml up -d
```

**本地裸 Node**：把 `data/` 改名留档，重新 `npm start`（会自动创建新 `data/` 与 v1 空库）。

### 3.4 取新的管理密码 / API Token

```bash
docker exec clawbridge-app cat /app/data/admin-password.txt   # 主 compose（容器名 clawbridge-app）
docker exec clawbridge cat /app/data/admin-password.txt      # fnOS（容器名 clawbridge）
# API Token 同理：cat /app/data/api-token.txt
```

如果 `.env` 里已有 `APP_SECRET` 会沿用；没有则由程序自动生成 `data/app-secret.key`。
**新库与新 `APP_SECRET` 必须一起备份**，后续升级/迁移都依赖它们。

### 3.5 重新绑定与重建配置

- 打开 `http://<IP>:10380/`（绑定页）→ 每个用户重新「输入昵称 → 微信扫码 → 确认」；
- 管理后台重建：用户分组（含分组保活开关）、接口应用规则、定时通知任务、运行配置、用户级凭据、
  24h 会话保活 opt-in（默认关闭）、广播/消息模板等；
- 旧媒体文件随旧数据卷留档，新库不会引用；如需清理由部署者自行处理。

### 3.6 验收

```bash
curl -s http://127.0.0.1:10380/health        # {"status":"ok","version":"1.0.0",...}
```

- 后台可登录（新密码）、`/docs` 可打开；
- 绑定页可完成扫码绑定；发送文本 + 图片做端到端自测；
- 查看日志无 error；记录镜像 digest 与本次部署时间。

## 4. 同一 schema（v1）的原地升级

适用于：1.0.0 及后续仍为 schema v1 的版本。

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

回滚同样简单：把镜像换回升级前的 tag/digest（§5.1），数据卷不用动。

## 5. 回滚（降级）

### 5.1 同一 schema（v1）回滚到上一版本

数据兼容，只需换回旧镜像：

```bash
# 主 compose（本地构建）：从升级前记录的镜像 tag 恢复
docker compose down
docker tag clawbridge:pre-upgrade clawbridge:local   # 若升级前做过 docker tag 备份
docker compose up -d
# fnOS：把 docker-compose.fnos.yml 的 image 固定到旧版本 tag 后 up -d
```

升级前建议先 `docker tag clawbridge:local clawbridge:pre-upgrade`（或 `docker save -o` 存档），
避免旧镜像被清理后无法回滚。

### 5.2 回滚到旧版本（跨 schema）

旧版本程序只能读它自己的 schema，**必须同时恢复旧镜像与旧数据卷**：

1. 停止当前服务；
2. 把当前 1.0.0 数据也备份一份（以防再次升级）；
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

> ⚠️ 回滚到旧版本 = 放弃 1.0.0 期间产生的数据（schema v1 库不能被旧版本读取，只能留档）。
> 如果已经用 1.0.0 重新绑定/配置过，回滚前请明确取舍。

### 5.3 固定版本以便回滚（推荐）

GHCR 镜像同时发布 `:latest`、`:sha-<commit>`（以及打 tag 后的版本 tag，如 `:v1.0.0`）。
fnOS 用户可把 `docker-compose.fnos.yml` 中：

```yaml
image: ghcr.io/shihao618/clawbridge:latest
```

改为具体版本以锁定升级时机（示例，sha 见 GHCR 页面或 `docker image inspect`）：

```yaml
image: ghcr.io/shihao618/clawbridge:sha-<commit>
```

升级 = 改 tag 后 `docker compose -f docker-compose.fnos.yml pull && ... up -d`；回滚 = 改回旧 tag。

## 6. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动失败：`数据库版本不兼容（检测到 schema_version=…，当前为 1）` | 数据卷不是全新 v1 库。**不要直接删库**：先按 §2 备份，再按 §3 使用全新空数据卷 |
| 新卷启动后无法登录后台 | 新库首次启动重新生成了随机密码：从 `data/admin-password.txt` 读取，或见启动日志提示路径 |
| 忘记 `APP_SECRET` / 旧 `app-secret.key` 丢失 | 该数据卷中的加密凭证将无法解密，只能重新绑定/重置；新空数据卷不受影响 |
| `docker compose down -v` 后数据没了 | `-v` 会删除命名卷；只能从备份恢复（§2/§5.2） |
| 升级后媒体列表为空，但磁盘上还有旧文件 | 正常：新库没有旧附件记录；旧文件已随旧卷备份归档 |
| fnOS 容器无法写入 `data/` | 目录必须提前创建并归 `PUID:PGID`（默认 1000:1000）所有 |
| 想保留旧版本只读归档 | 删除/改名旧卷前，已用 §2 tar 备份；不要依赖 `:latest` 长期保存旧镜像 |
| 数据量大时启动略慢 | 首次启动需要建表/建索引；之后为正常启动耗时 |

## 7. 数据维护（GC / 日志保留）

应用内置维护任务（`server/src/maintenance.js`）：**默认启动约 1 分钟后首次、之后每天一次**执行；
参数通过 env 配置（后台暂无对应字段）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MAINTENANCE_ENABLED` | `1` | `0`=关闭定时维护（启动时读取，需重启） |
| `MAINTENANCE_INTERVAL_MS` | `86400000`（24h，60s–7d） | 维护周期（需重启） |
| `MAINTENANCE_INITIAL_DELAY_MS` | `60000` | 首次维护延迟（需重启） |
| `MAINTENANCE_LOG_RETENTION_DAYS` | `90`（0=不清理） | events/规则日志/定时日志保留天数（每轮实时读取） |
| `MAINTENANCE_UPLOAD_RETENTION_DAYS` | `7`（0=不清理） | 从未入队的管理端上传附件保留天数 |
| `MAINTENANCE_BATCH_SIZE` | `200`（1–1000） | 分批删除/扫描上限 |
| `MAINTENANCE_ORPHAN_FILE_MIN_AGE_MS` | `3600000` | 孤儿媒体文件最小年龄（防误删写入中文件） |
| `MAINTENANCE_PRAGMA_OPTIMIZE` / `MAINTENANCE_WAL_CHECKPOINT` | `1` | 维护后优化/checkpoint |

清理内容：无磁盘文件的 ready 附件行、孤儿媒体文件、超期未入队上传附件（保留被 queued/sending outbox 引用的）；
按保留期清理 events/规则日志/定时日志；`outbox`/`inbound_messages` 业务数据不自动删除。
参数完整列表见 [`.env.example`](../.env.example) 数据维护节。

## 8. 相关文档

- 配置字段与默认值：[`docs/SETTINGS.md`](SETTINGS.md)
- 媒体文件与 CDN：[`docs/MEDIA.md`](MEDIA.md)
- 24h 会话保活：[`docs/KEEPALIVE.md`](KEEPALIVE.md)
- 用户分组 / 入站 API：[`docs/GROUPS_AND_INBOUND.md`](GROUPS_AND_INBOUND.md)
- 接口应用 / 定时通知：[`docs/API_RULES.md`](API_RULES.md)、[`docs/SCHEDULED_TASKS.md`](SCHEDULED_TASKS.md)
- HTTP API 契约：[`docs/API.md`](API.md)
- 版本变更摘要：[CHANGELOG.md](../CHANGELOG.md)
- 发布流程：[`docs/RELEASE.md`](RELEASE.md)
- APP_SECRET 轮换：[`docs/ROTATE_APP_SECRET.md`](ROTATE_APP_SECRET.md)
