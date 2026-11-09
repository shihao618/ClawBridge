# 发布流程（Release Process）

> 适用：ClawBridge 单仓库自托管发布（Docker 镜像发布到 GHCR + 源码标签）。
> 当前版本：**1.1.5**；数据库 schema：**v1**。
> 升级/回滚的数据操作见 [`docs/UPGRADE.md`](UPGRADE.md)；版本变更见 [CHANGELOG.md](../CHANGELOG.md)。

## 0. 版本与发布物

| 项目 | 说明 |
| --- | --- |
| 版本号来源 | `package.json` 的 `version`（唯一事实来源） |
| 镜像 | `ghcr.io/shihao618/clawbridge`，多架构 `linux/amd64` + `linux/arm64` |
| 镜像 tag | `:latest`（仅默认分支 main 推送时更新）、`:sha-<短 commit>`（每次发布都有）、`:v<版本>`（推 `v*` tag 时） |
| 源码标签 | 形如 `v1.0.0` 的 annotated tag；GitHub Release 正文取自 CHANGELOG 对应段落 |
| 数据库版本 | 当前 schema **v1**；发布前确认 `server/src/db.js` 的 `SCHEMA_VERSION` 是否变化 |

> **发布模型**：合并到 `main` 会自动构建并推送 `:latest` + `:sha-<commit>`（构建前先跑 lint/覆盖率/mock 自测）；
> 在验证过的 commit 上打 `v*` tag 会再触发同一工作流，追加 `:vX.Y.Z` 镜像 tag。因此推荐顺序是：
> PR 全绿 → 合并 main → 等 publish 成功 → 打 tag → GitHub Release。

## 1. 发布前检查清单（本地，全部通过才可发布）

1. **工作区干净**：`git status` 无未提交改动；位于待发布分支。
2. **版本号一致**（逐项核对，缺一不可）：
   - `package.json` `version`；
   - `package-lock.json` 根 `version`（可用 `npm install --package-lock-only` 同步）；
   - `README.md`「当前版本」行；
   - `CHANGELOG.md` 有对应 `## [X.Y.Z] - YYYY-MM-DD` 段落；
   - `mock/ilink-mock.mjs` 的 `VERSION` 常量；
   - `docs/API.md` 中 `version` 示例（`/api/admin/overview`、`/api/admin/config`）；
   - `docs/UPGRADE.md` 的「适用版本」与 schema 说明。
3. `npm ci`（以 lockfile 安装）。
4. `npm test`（unit + e2e，用例数按最终实现为准）。
5. `npm run lint`（ESLint，`--max-warnings=0`，应 0 error / 0 warning）；`npm audit --omit=dev`（生产依赖应 0 漏洞）。
6. `npm run coverage`（CI 阈值：line 90 / branch 70 / funcs 85）。
7. `node mock/selftest.mjs`（协议自测，当前 **26/26**）。
8. `npm run e2e:stability -- --runs=3 --concurrency=1`（e2e 串行连跑稳定性，CI 同款）。
9. `npm run test:ui`（headless Edge/Chrome 浏览器冒烟；无浏览器时自动跳过，**建议**在 UI 有改动时执行）。
10. `docker compose config --quiet`（三份均需通过；demo 组合必须带 `--profile demo`）：
    ```bash
    docker compose -f docker-compose.yml config --quiet
    docker compose -f docker-compose.fnos.yml config --quiet
    docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile demo config --quiet
    ```
11. **镜像冒烟**（本机构建，不推送）：
    ```bash
    docker build -t clawbridge:release .
    docker run -d --rm --name clawbridge-release -p 10388:10380 \
      -e NODE_ENV=production -e DATA_DIR=/tmp/cb-data -e APP_SECRET=release-smoke-secret-0123456789abcdef \
      clawbridge:release
    sleep 3 && curl -fsS http://127.0.0.1:10388/health
    docker rm -f clawbridge-release
    ```
    期望 `{"status":"ok","version":"X.Y.Z","uptimeMs":...}`；有条件再验证 `/`、`/admin`、`/docs` 均 200 与安全响应头。
12. **文档链接检查**：相对链接无断链（可运行仓库内文档检查脚本/CI 的 doc-lint 步骤，若已配置）。
13. **截图（可选）**：UI/版本界面有变化时 `npm run screenshots` 重生成（README 引用的 23 张截图，
    当前为 `.webp`；脚本会按 `package.json` 版本校验侧栏版本号，需要 headless Edge/Chrome）。
    不重生成时确认 README 中的截图仍可访问。
14. **CHANGELOG 内容核对**：新功能/修复/安全/行为收紧/升级注意 分类齐全，无内部待办遗留。
15. **schema 变更确认**：若 `SCHEMA_VERSION` 有变化，必须先更新 `docs/UPGRADE.md` 的升级/回滚步骤，
    并在 CHANGELOG 显著标注「旧库需备份后重建」。

## 2. 发布步骤（tag → GHCR → GitHub Release）

### 2.1 合并并确认自动发布

1. 提交 PR；等 `CI` 工作流（`.github/workflows/ci.yml`：Node 22/24 的 lint + 覆盖率 + mock + e2e 稳定性）全绿。
2. 合并到 `main`；等 `Build and publish GHCR image`（`.github/workflows/docker-publish.yml`）成功。
   该工作流顺序：`npm ci` → lint → coverage → mock 自测 → QEMU/Buildx → 多架构 build & push
   （附 SBOM + provenance attestation）。
3. 记录该次 `main` 的 **commit sha**（对应 `:sha-<短 sha>` 镜像，作为回滚点）。

### 2.2 打 tag

```bash
git checkout main && git pull
git tag -a v1.0.0 -m "ClawBridge 1.0.0"
git push origin v1.0.0        # 只推 tag 即可；不要用 --tags 误推其它本地 tag
git ls-remote --tags origin | grep v1.0.0   # 确认远端 tag
```

推送 `v*` tag 会再次触发发布工作流（先测试再构建），镜像元数据会追加 `:v1.0.0`。

### 2.3 验证 GHCR 发布产物

```bash
# 查看 manifest 是否包含 amd64/arm64、SBOM/provenance attestation
docker buildx imagetools inspect ghcr.io/shihao618/clawbridge:v1.0.0
# 拉取并冒烟（可指定平台）
docker pull --platform linux/amd64 ghcr.io/shihao618/clawbridge:v1.0.0
```

在 GitHub Actions 页面确认 tag 那次运行 success；记录镜像 digest（回滚/发布说明中引用）。

### 2.4 创建 GitHub Release

- 基于 `v1.0.0` tag 创建 Release（不要重新建 tag）；
- 正文使用 CHANGELOG 中 `## [1.0.0]` 段落（分类：新功能 / 修复 / 安全 / 兼容性 / 升级注意）；
- 附镜像地址与 digest、schema 版本（v1）、升级文档链接（`docs/UPGRADE.md`）；
- 发布前确认 Release 是「Pre-release」还是「Latest」：稳定版设为 Latest。

### 2.5 发布后验证（生产/用户视角）

```bash
# 主 compose（源码构建）
git pull && docker compose up -d --build
# 或 GHCR 固定版本（推荐生产）
docker pull ghcr.io/shihao618/clawbridge:v1.0.0
curl -fsS http://127.0.0.1:10380/health
```

- 后台可登录（`/admin`）、文档页（`/docs`）可打开；
- 绑定页扫码绑定/发一条文本 + 一张图片端到端自测；
- 观察日志无 error；旧数据卷与密钥文件保留（不要 `docker compose down -v`）。

## 3. 回滚

| 场景 | 操作 |
| --- | --- |
| 同一 schema（v1）回滚到上一版本 | 镜像/源码换回上一 tag 或 `sha-<commit>` 后 `up -d`；数据卷无需回滚（见 UPGRADE §5.1） |
| 回滚到旧 schema 版本（跨 schema） | **必须同时恢复旧镜像 + 旧数据卷**（见 UPGRADE §5.2）；当前 v1 数据先备份留档 |
| GHCR 镜像不可用/误删 | 用本机保留镜像：`docker save/load`；或从上一 `sha-` 镜像重建 |
| tag 打错（尚未发布 Release） | 确认工作流已完成/可取消后，删除远端 tag：`git push origin :vX.Y.Z`（谨慎；已推送镜像不能真正撤回，必要时发 patch 版本修正） |
| Release 文案有误 | 直接编辑 GitHub Release；如需撤回可改为 Pre-release 并发布 patch 说明 |

回滚后务必重新验证 `/health` 版本号、后台登录、绑定/发送链路与日志。

## 4. fnOS 用户固定版本建议

fnOS 的 `docker-compose.fnos.yml` 默认镜像为 `:latest`；升级/回滚不可控，**建议固定到发布 sha**：

```yaml
image: ghcr.io/shihao618/clawbridge:sha-<commit>
```

升级 = 改 tag → `docker compose -f docker-compose.fnos.yml pull && ... up -d`；
回滚 = 改回旧 tag。固定 tag 后仍可用 `docker buildx imagetools inspect` 核对 digest 与多架构。

## 5. 供应链维护（npm 依赖 / 基础镜像 digest / GitHub Actions SHA）

发布前与每次合并 Dependabot PR 时维护三类可变供应链；任何升级后都要重跑 §1 的 lint/测试与镜像冒烟。

1. **npm 依赖**（`package.json` / `package-lock.json`）：
   - 检查：`npm outdated`、`npm audit --omit=dev`（生产依赖必须 0 漏洞）、`npm audit`；
   - 升级：`npm update <pkg>` 或调整 version range 后 `npm install`；生产依赖升级必须跑 `npm test` 与镜像冒烟；
   - 已知 dev 例外：`minimatch` 的 GHSA-g3hv-75wg-m249（eslint 10 经 `@eslint/config-array` 依赖 `^10.2.4`，
     10.x 无修复版）已用 `package.json` 的 `overrides.minimatch = "^11.0.1"` 固定到已修复版本；
     上游改用 `^11` 后删除该 override；
   - 验证：`npm ci && npm run lint && npm audit --omit=dev`。
2. **Docker 基础镜像 digest**（`Dockerfile` 的 `FROM`）：
   - 已固定 `node:24-alpine@sha256:<manifest-list digest>`（多架构 index，amd64/arm64 共用同一 digest）；
   - 升级：`docker pull node:24-alpine && docker image inspect node:24-alpine --format '{{json .RepoDigests}}'`，
     用新 digest 替换 `FROM` 并同步注释；`docker build -t clawbridge:local .` 后按 §1.11 做 `/health` 冒烟；
   - 可用 `docker pull --platform linux/arm64 node:24-alpine@sha256:<digest>` 验证 digest 确为多架构 index；
   - Dependabot 的 `docker` 生态会定期提 PR。
3. **GitHub Actions commit SHA pin**（`.github/workflows/ci.yml`、`docker-publish.yml`）：
   - 所有 `uses:` 固定到 commit SHA，行尾保留 `# vX` 主版本注释；
   - 升级：`git ls-remote https://github.com/<org>/<repo> refs/tags/<tag>`（annotated tag 取 `^{}` 行）或
     `https://api.github.com/repos/<org>/<repo>/git/ref/tags/<tag>` 查询新 SHA，替换后保留注释；
   - Dependabot 的 `github-actions` 生态每周检查提 PR；合并前确认 YAML 合法且工作流在 PR 上跑通。

## 6. 相关文档

- 升级 / 回滚（备份、空库重建、旧镜像回滚）：[`docs/UPGRADE.md`](UPGRADE.md)
- 版本变更摘要：[CHANGELOG.md](../CHANGELOG.md)
- 安全策略与漏洞报告：[SECURITY.md](../SECURITY.md)
- 隐私与数据处置：[docs/PRIVACY.md](PRIVACY.md)
- APP_SECRET 轮换：[docs/ROTATE_APP_SECRET.md](ROTATE_APP_SECRET.md)
- 部署与运行（README）：[README.md](../README.md)
