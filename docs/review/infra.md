# 测试与基础设施审查报告

> 审查对象：ClawBridge v2.0.0（HEAD `a23c2be`，工作区初始 `git status` 干净）
> 审查方式：只读。未修改任何代码/测试/文档/容器；未执行 `docker build/run`；未访问真实微信 API。
> 产出：本文件（唯一写入）。审查时间：2026-11-08（Asia/Shanghai）。
> 行号基准：本报告行号均以审查开始时工作区快照（HEAD `a23c2be`）为准；审查期间其它协作者对 `README.md`/`package.json` 的并发修改（未提交的 `test:ui` 等）未计入行号，见 INF-20 备注。

## 0. 方法与基线

| 项 | 实测结果 | 依据 |
| --- | --- | --- |
| 环境 | Node v24.20.0 / npm 11.19.0 / Docker 29.8.1（build 4a63305） | `node --version`、`docker --version` |
| 仓库 | 124 个 git 跟踪文件；HEAD=`a23c2be`；远端 `origin/main` 与本地 HEAD 一致；无 tag | `git ls-files`、`git log`、GitHub API |
| 全量测试 | **362 通过 / 0 失败 / 33.5s**（`npm test`，spec reporter，exit 0） | 实跑 |
| 单测 | **271 通过 / 0 失败** | `npm run test:unit`（exit 0） |
| e2e | **91 通过 / 0 失败** | `npm run test:e2e`（exit 0） |
| 覆盖率 | line **91.96%** / branch **75.52%** / funcs **91.12%**（in-process 口径） | `node --test --experimental-test-coverage`，exit 0 |
| mock 自测 | **25/25 PASS / 2.4s** | `node mock/selftest.mjs`，exit 0 |
| 依赖 | 生产依赖仅 express@5.3.0、qrcode@1.5.4；lockfileVersion 3；`npm audit --omit=dev` **0 漏洞**（prod 95） | `npm ls`、`npm audit --json` |
| Compose | 3 份 compose 均通过 `docker compose config --quiet`（exit 0；demo 服务 = mock-ilink + clawbridge） | 只读校验 |
| 运行容器 | `clawbridge-app` 健康（health=healthy，restart=unless-stopped，user=node，命名卷 `clawbridge-data`）；`GET /health` 200 `{status:"ok",version:"2.0.0"}`；安全响应头（含 CSP `media-src 'self'`）；`/docs` 200、`/bind` 302、未知路由 404 JSON | `docker inspect`、本地 `curl` 127.0.0.1:10380（只读） |
| GHCR | 匿名可拉取（manifest 200）；index 含 `linux/amd64` + `linux/arm64`；HEAD `a23c2be` 的 publish workflow 已成功 | 匿名 registry HTTP + GitHub Actions API |
| 结论口径 | 真实微信 API 未访问；“mock 与真实协议差异”基于 `docs/PROTOCOL.md` 文档对照，未标注处为代码可证事实 | — |

覆盖率口径说明：`node --test --experimental-test-coverage` 只统计测试进程内 import 的模块；e2e 把 `server/src/index.js` 作为子进程启动，因此 **index.js 及子进程内运行的 api/dispatcher/monitor 路径不计入该百分比**（由 e2e 黑盒覆盖），下文百分比为单测/进程内覆盖，会低估真实行为覆盖。

## 1. 结论摘要

| 严重度 | 数量 | 含义 |
| --- | --- | --- |
| P0 | 0 | 无 |
| P1 | 1 | 发布链路无质量门禁（可把未验证代码发布为生产镜像） |
| P2 | 10 | 文档/测试架构/覆盖/可复现性/隐私卫生等需排期修复 |
| P3 | 13 | 工程化与仓库细节改进 |

总体评价：这是一个**工程完成度很高**的单仓库项目——362 个测试全绿、覆盖率约 92%、e2e 采用真实双进程 + mock + 随机端口 + 临时数据目录的黑盒架构，Docker/compose/GHCR 交付链路实测可用，机密未被 git 跟踪，依赖面极小且 0 已知漏洞。主要风险不在“功能正确性”，而在**质量门禁与文档可信度**：仓库只有 Docker 发布 workflow、没有任何 CI 测试/构建后冒烟，任何 push 到 main 都会自动构建并推送多架构 `:latest`；同时 docs 中残留已废弃的“自动迁移”承诺、README 里 keepalive 默认值与代码不一致，且前端测试用 1500 行源码文本 grep 绑定实现细节，长期维护成本与误报风险偏高。建议优先补 CI 测试门禁（P1），再系统性消除文档漂移与前端测试脆弱性（P2）。

## 2. 详细问题清单（按严重度）

### P1

#### INF-01 发布流水线无任何质量门禁，main 每次 push 自动发布生产镜像
- **严重度**：P1（发布完整性/部署失败风险）
- **类别**：CI/CD、工程化
- **位置**：`.github/workflows/docker-publish.yml:1-56`（唯一 workflow）；触发条件 `:3-7`（push main/tags + workflow_dispatch）；步骤 `:20-56` 仅 checkout→QEMU→buildx→login→metadata→build-push；`package.json:11-22` 无 CI 相关脚本
- **证据/说明**：
  - 仓库 `.github/workflows/` 只有这 1 个文件（`Get-ChildItem .github -Recurse`），没有 test/ci workflow，也没有 PR 触发；
  - GitHub Actions API 最近 5 次运行全部是 “Build and publish GHCR image”，全部 success（含 HEAD `a23c2be`，2026-11-08T08:01:20Z）；
  - workflow 在 push 后直接 `push: true`（`docker-publish.yml:51`），无 `npm test`、无镜像启动冒烟；
  - 读者会以为“publish 成功=可用”，但镜像只证明 docker build 成功。
- **影响**：任何能通过 build 但运行期崩溃/回归的提交都会以 `:latest` + sha 标签发布；fnOS 文档的标准更新方式 `docker compose ... pull && up -d`（`docker-compose.fnos.yml:12`、README:211-216）会把该镜像直接拉入生产，导致服务启动失败/回归。属可复现的部署失败路径。
- **修复建议**：新增 `.github/workflows/ci.yml`：PR/push 上跑 `npm ci` + `npm test`（Node 24，可加 Node 22.13 引擎下限 job）+ `node mock/selftest.mjs`；发布 job 加 `needs: test`；发布前用 `docker build` 后 `docker run -d -p 0:10380` 并 `curl /health` 做冒烟（CI 内可接受 run/stop），失败则不 push。加覆盖率阈值（见 INF-06）。
- **工作量**：M

### P2

#### INF-02 README 的 keepalive 默认值与代码/docs 矛盾（23h/每窗口一次 vs 12h/每 6h 重复）
- **严重度**：P2
- **类别**：文档一致性
- **位置**：`README.md:339-340`、`README.md:349`；代码 `server/src/config.js:175-183`
- **证据/说明**：README:339 写“窗口即将过期前（默认 **23h**）自动发送”，:340 写“**每个 24h 窗口最多发送一次**”；同文件 README:349 又写“窗口 24h、**首次提前 12h**、**每 6h 重复提醒**、5 分钟扫描一次”。代码 `config.js:177-180` 为 `windowMs=24h、leadMs=12h、repeatMs=6h、tickMs=5min`；`docs/KEEPALIVE.md:39-45` 与 `docs/API.md:561-562` 均为 12h/6h。即“23h 阈值 + 最多一次”是错的。
- **影响**：运维/运营按 README 预期“每窗口只发一次”，实际同一窗口内可能每 6h 再发（最多额外 2 条），对用户造成非预期重复提醒；也与本文件其它段落自相矛盾。
- **修复建议**：把 README:338-340 改为“首次在最后入站满 12h 提醒，之后每 6h 重复，直至用户回复或窗口过期”；在 `docs/SETTINGS.md` 增加默认值单一来源说明；CI 加文档默认值一致性检查（见 INF-05）。
- **工作量**：S

#### INF-03 4 篇 docs 仍承诺已删除的渐进式 schema 迁移，与实际“旧库直接拒绝”冲突
- **严重度**：P2（升级路径误导 → 启动失败/数据处置风险）
- **类别**：文档一致性、部署运维
- **位置**：`server/src/db.js:265-282`；误解文档：`docs/KEEPALIVE.md:31-33,126,151`、`docs/MEDIA.md:141,171-176,341,356`、`docs/ARCHITECTURE.md:321,342,358,367-369,384,392-393,408`、`docs/GROUPS_AND_INBOUND.md:10,41,222,241`
- **证据/说明**：`db.js:280-282` 明确 `previousVersion !== SCHEMA_VERSION` 直接 `throw`（“旧版本迁移已移除”），`openDatabase` 无任何 ALTER/逐级迁移；`tests/unit/backend-schema-version.test.js:23-37` 专门断言旧库启动失败。而上述 docs 多处描述 “v3→v4 additive migration/ALTER TABLE/逐级迁移、真实数据副本验证”，其中 `docs/ARCHITECTURE.md:139-140` 又正确写着“不再支持旧版本迁移”——文档内部互相矛盾。本地 `backups/clawbridge-v9-*.db` 实测 schema=9，即真实存在“v9 数据卷无法被当前版本打开”的情况，若照 KEEPALIVE.md:151 的“上线迁移”执行会直接启动失败。README:10 的警告是正确且醒目的。
- **影响**：误导升级/排障（以为可原地升级），可能引发停机、误删数据卷/备份；也浪费维护者排查时间。
- **修复建议**：统一改为“当前 schema v10，高/低版本均拒绝、仅支持空库重建 + 备份迁移”；删除或加“历史设计记录”标注（如 `> 历史设计，现行行为见 db.js/README`）；在 README 升级章节给出 v9→v10 的实际操作（导出/重绑/或保留旧容器只读）。
- **工作量**：M（4 篇文档 + 全仓 `grep 迁移` 复核）

#### INF-04 管理后台文案仍写 “schema v8”（实际 v10）
- **严重度**：P2
- **类别**：文档/页面一致性
- **位置**：`web/admin.html:360`
- **证据/说明**：`schema v8 <code>app_settings</code>`；代码 `server/src/db.js:21` `SCHEMA_VERSION = 10`，README:10、docs/SETTINGS.md:8/33、docs/ARCHITECTURE.md:417/446 均为 v10。`app_settings` 表确为 v8 引入，但句意（“已持久化到数据库（schema v8 app_settings）”）会让管理员以为当前库是 v8。
- **影响**：排障/升级时误判数据库版本；用户截图/反馈信息失真。
- **修复建议**：改为“（schema v10，`app_settings` 表自 v8 引入）”，并在前端测试中增加“页面不得出现旧 schema 版本号”的值级断言（见 INF-05）。
- **工作量**：S

#### INF-05 frontend-pages.test.js 用源码文本 grep 断言实现细节（1504 行/51 用例），脆弱且抓不到值级漂移
- **严重度**：P2
- **类别**：测试质量
- **位置**：`tests/unit/frontend-pages.test.js:1-1504`；典型脆弱断言：`:624-626`（负向 `!includes` + 精确 payload 正则）、`:825-826`（`/windowStart,\s*\n\s*windowEnd,/` 绑定换行与格式）、`:896-900`（精确到 `.hidden = item.id !== view.id`、`history.replaceState(null, '', VIEW_BY_ID.get(DEFAULT_VIEW).hash)`）、`:1122-1123`（精确 `method: 'PATCH', body: patch`）、`:1346-1348`（精确 `closeOnBackdrop` 表达式）、`:1480`（CSS `flex: 1 1 calc((100% - 36px) / 3)`）、`:1492`（精确中文提示文案）
- **证据/说明**：该文件对 `web/assets/admin.js`（5896 行）、`common.js`、`style.css` 等做字符串/正则断言；任何无害重构（格式化、变量改名、拆分函数、改提示语、换行风格）都会失败，而真正的 UI 行为（渲染/交互/响应式）并没有被执行。反向也不敏感：`web/admin.html:360` 的 “schema v8” 实际漂移未被任何测试发现；`:549-581` 等处读 `docs/*.md` 只断言 token **存在**，不比较取值，所以文档值漂移（INF-02）同样漏检。
- **影响**：高维护成本 + 假失败/假通过并存；重构意愿被测试绑架；文档/页面数值漂移无法自动拦截。
- **修复建议**（分层改造，见 §3）：
  1. 保留稳定的 HTML 结构/安全断言（id 唯一、无内联脚本、同源资源、CSP），这些是契约；
  2. 把可测逻辑从 `admin.js` 抽到 `web/assets/lib/*.js` 纯函数（filters、payload 组装、模板渲染、状态映射），用 `node:test` 直接单测；
  3. 行为级用 DOM 环境（jsdom）或 Playwright/Cypress 冒烟（登录→建规则→发消息→媒体上传）替代源码正则；关键节点改用 `data-*` 稳定钩子；
  4. 文档一致性改为“值级”：从 `docs/*.md` 的默认值表 + `config`/`SETTINGS_SCHEMA` 生成对照断言（schema 版本、keepalive 默认值、RATE_LIMIT_MAX 等），或 docs.html 端点表由 docs/API.md 生成/校验；
  5. 删除纯格式/CSS 数值断言（`:1480` 等）或改为视觉回归测试。
- **工作量**：L（分阶段：先去格式耦合，再抽纯函数，最后浏览器冒烟）

#### INF-06 覆盖缺口集中且无覆盖率门禁：dispatcher/monitor/binding/index/前端 asset
- **严重度**：P2
- **类别**：测试覆盖、工程化
- **位置**：实测 `node --test --experimental-test-coverage`（00:16 运行，exit 0）
- **证据/说明**（in-process 口径）：
  - 全局：line 91.96 / branch 75.52 / funcs 91.12；
  - 最低：`dispatcher.js` line **66.58%**、branch 68.57%、funcs **50%**（start/loop/stop、其他错误重试分支无直接单测，靠 e2e 黑盒）；`monitor.js` branch **57.94%**（runLoop 退避/pauseForStaleToken/persistCursor/stopAll）；`binding.js` 77.62% / branch 68.00%（refresh、need_verifycode 竞态、redirect、binded_redirect 分支）；`keepalive.js` funcs 66.67%（start/stop/restart 生命周期）；`index.js` 完全不在覆盖报告（子进程运行，优雅退出/SIGTERM/notifyStop/DB close 无断言级测试）；
  - `errors.js` 86.92%（无 `backend-errors` 测试）、`logger.js` branch 68.42%（无直接测试、脱敏仅间接覆盖）；
  - `web/assets/*.js`（admin.js 5896 行）无函数级/DOM 行为测试，只有文本 grep；
  - `package.json:11-22` 无 `coverage` 脚本/无阈值；workflow 不跑覆盖率。
- **影响**：核心出站队列与入站长轮询的异常/生命周期路径回归只能靠 30s 级 e2e 兜底，定位慢；覆盖率无法作为门禁防退化。
- **修复建议**：新增 `npm run coverage`（`node --test --experimental-test-coverage`，Node 24 支持 `--test-coverage-lines/branches/functions`）并在 CI 设阈值（先 90/70/85 起步）；补 `backend-dispatcher.test.js`（start/stop 幂等、loop 取件、-14 置 pause 并失败剩余、prepare failed 直接失败、媒体 caption 重发、reschedule 分支）、`backend-monitor` 增补退避/stale-token/游标持久化/stopAll、`backend-index-lifecycle`（spawn 后 SIGTERM，断言退出码与 notifystop）；允许把 e2e 黑盒作为这些分支的第二道防线，但核心错误映射应有进程内单测。
- **工作量**：M

#### INF-07 e2e 时序/等待策略存在 flaky 风险点，且“确定性”缺少 CI 证据
- **严重度**：P2
- **类别**：测试稳定性
- **位置**：`tests/e2e/app-rules.test.js:329,363,417,536,547`；`tests/e2e/scheduled-tasks.test.js:417,460`；`tests/e2e/keepalive.test.js:64,179,239,332,357`；`tests/e2e/inbound-api.test.js:103-114,380`；`tests/e2e/keepalive-groups.test.js:129`；`tests/helpers/e2e-env.mjs:89-100`（getFreePort）、`:1374`（app 端口先取后 spawn，存在 TOCTOU）、`:1347,1378`（子进程 env `...process.env` 继承宿主环境）
- **证据/说明**：
  - 多处固定 `await sleep(700~1600)` 做“不应再发生”的负向断言（如 app-rules:350 等 1 个请求后 sleep 700ms 断言仍只有 1 个请求；keepalive:239 用 sleep 1600 断言“同一窗口不重复发送”），在慢机/GC/杀软环境下要么假通过（事件没赶在 sleep 内发生）要么假失败（队列/网络延迟超出窗口）；
  - mock 与 app 端口策略不一致：mock 用 `PORT=0` + 解析 listening 日志（稳健），app 用 `getFreePort()` 先探测再 spawn（存在被抢占窗口）；
  - e2e 子进程环境直接展开宿主 `process.env`，若开发机/CI 设置 `KEEPALIVE_ENABLED=false`、`DATA_DIR`、`LOG_LEVEL=debug` 等，会静默改变被测行为（e2e-env:1307-1331 只覆盖部分变量）；
  - README:537 宣称“91 项通过（约 35s，确定性，连跑多次稳定）”，但无 CI 证据、未在 2 核 runner 验证；本机 33.5s 是 362 用例并行（各用例耗时累计约 102s）。
- **影响**：CI 接入后可能出现间歇性红；负向断言给出虚假信心；本地与 CI 结果不可比。
- **修复建议**：把负向断言改为“等待稳定后断言不变量”（如 `await waitStable(() => mockState 无新消息, samples=3)` 或等待 2×tick 后断言状态不变，封装 `expectNoChange()`）；app 也改为 `PORT=0` + 解析启动日志 listening 端口（index.js 已有“ClawBridge 已启动”结构化日志可加 event 字段），或改用与 mock 相同的端口回传机制；子进程 env 改为白名单构造（只传 BASE_APP_ENV + 测试 overrides + PATH 等必要项）；CI 中固定 `--test-concurrency` 并跑 3 次验证稳定性。
- **工作量**：M

#### INF-08 公开仓库的截图/示例含疑似真实用户数据，且截图整体过期（v1.0.0）
- **严重度**：P2（若 owner 确认是真实用户数据则升 P1）
- **类别**：隐私/仓库卫生、文档一致性
- **位置**：`screenshots/admin-menu-users.png`、`screenshots/admin-groups.png`、`screenshots/admin-security.png`、`screenshots/bind-mobile-confirmed.png`（23 张，README:60-108 全部引用）；`docs/API.md:498`、`docs/GROUPS_AND_INBOUND.md:157`
- **证据/说明**：
  - `admin-menu-users.png`（1246×803）显示用户昵称“杨星雨 / 杨星雨2”、绑定时间 “2026-10-28 22:29:01/22:32:19”、“18 小时前”等运行数据；`admin-groups.png` 显示分组 “B260714”；
  - 同一昵称“杨星雨”被 `docs/API.md:498`、`docs/GROUPS_AND_INBOUND.md:157` 用作接口示例 `displayName`；
  - `admin-security.png` 显示本机绝对路径 `C:\Users\admin\AppData\Local\Temp\clawbridge-security-browser\data`、APP_SECRET 掩码、Token 预览片段（预览已脱敏，但路径暴露用户名/目录结构）；
  - 多张截图侧栏版本为 **v1.0.0**（admin-menu-users/admin-groups/admin-security），且 `bind-mobile-confirmed.png` 仍是旧版顶部导航布局——与 README:10 声明的 2.0.0 及当前侧栏壳 UI 不一致，README“界面预览”已过期。
  - 仓库为 GitHub public（API：`private=false`），以上内容已公开。
- **影响**：若“杨星雨”为真实用户（或真实运营分组名），属于公开仓库中的个人数据暴露（目前仅昵称/时间戳，敏感度中低）；过期截图会让用户按旧 UI 找不到入口，降低文档可信度；绝对路径泄露构建/演示机环境信息。
- **修复建议**：立即用演示模式（mock + 自动确认 + 假数据 “演示用户A/B”）重新生成 2.0.0 截图；替换 docs 示例昵称；对已有 git 历史可评估是否清理（涉及公开历史，建议至少新增提交修正 + 在 README 说明示例数据均为虚构）；截图排除个人信息与绝对路径；如 owner 确认是真实用户，按隐私事件处理并升 P1。
- **工作量**：M（重截图 + 文档替换；历史清理另计 L）

#### INF-09 mock 与真实/文档协议存在差异，自测未覆盖这些差异面
- **严重度**：P2（影响 e2e 对真实协议的置信度）
- **类别**：mock/测试基础设施
- **位置**：`mock/ilink-mock.mjs:486-517`（QR 内容）、`:899-949`（扫码轮询）、`:891-894`（鉴权失败）、`:1682-1693`（路由表）；`mock/selftest.mjs`；`mock/README.md:57-58,114-130`
- **证据/说明**：
  1. `qrcode_img_content` 被构造为 `http://host:port/mock-bind?qrcode=...`（mock:491），但 `dispatch` 没有 `/mock-bind` 路由（mock:1697-1844），**实测该 URL 返回 404**（本地临时以 PORT=3199 启动 mock 验证）；即二维码内容是死链接，手动模式/演示中“扫码打开页面”不可用（自动确认模式掩盖了该问题）；
  2. 扫码状态长轮询 mock 默认仅挂起 ≤1s（`MOCK_QR_POLL_MS`，mock:66）而真实约 35s（docs/PROTOCOL.md:101），e2e 不覆盖真实长超时语义（可接受，但需明示）；
  3. 鉴权失败 mock 返回 HTTP 401 + `{ret:-14}`（mock:891-894），文档描述为 HTTP 200 体内 `ret/errcode=-14`（PROTOCOL.md:168,205-209）；客户端 `dispatcher` 专门兼容 401（dispatcher.js:83-93），但真实 API 是否 401 未验证；
  4. mock 默认 `MOCK_STRICT=0` 只记录协议违规（mock/README:57-58），而 e2e 仅 `media-flow.test.js:153` 断言过 `state.rejections`，其它 11 个 e2e 文件不检查违规记录 → 客户端请求头/字段回归（如漏 `X-WECHAT-UIN`、`from_user_id` 非空）可能不被发现；
  5. mock 不实现真实服务端限流（仅 `fail-next-send` 注入），e2e 的退避重试是“模拟失败”而非真实限流语义（已由单测补充，可接受）。
- **影响**：e2e 通过≠真实协议兼容；“演示手动模式”不可用而文档未说明；协议回归缺少自动拦截。
- **修复建议**：给 mock 增加 `/mock-bind` 占位页（展示 qrcode/说明，或直接重定向演示说明），或在 mock/README 明确“该 URL 不可打开、请用控制面扫码”；e2e 在每个主流程末尾统一 `assertNoRejections()`；selftest 增加 404/405/rejections 面断言；如需更高置信度，录制/对照官方插件请求样例做契约测试（可用文档中的 golden JSON）。
- **工作量**：S/M

#### INF-10 构建/发布可复现性与 compose 一致性缺口
- **严重度**：P2
- **类别**：部署运维、供应链
- **位置**：`Dockerfile:19`（`node:24-alpine` 浮动 tag）；`.github/workflows/docker-publish.yml:22,25,28,33,39,48`（actions 用 `@v4/@v3/@v5/@v6` 未 pin SHA）；`docker-compose.demo.yml:20-57`（mock 服务无 `logging` 上限、无 `security_opt`、无 `stop_grace_period`，而 `docker-compose.yml:37-56` 有）
- **证据/说明**：同上；主 compose 的 app 服务有 `init: true`、`no-new-privileges`、日志滚动上限、15s 停机宽限，mock 服务缺这些；基础镜像未 pin digest 导致同一 Dockerfile 在不同时间构建产物不同；发布无 SBOM/provenance 显式要求（GHCR manifest 已有 buildx 默认 attestation，可保留）。
- **影响**：构建不可复现/上游镜像漂移可能引入意外行为；demo mock 容器日志可能无限增长（演示长跑场景）；供应链可审计性弱。
- **修复建议**：`FROM node:24-alpine@sha256:...`（Dependabot/digest updater 维护）；actions pin 到 commit SHA；mock 服务补齐 logging/security_opt/stop_grace_period；发布 workflow 增加 `provenance: true`、`sbom: true`（build-push-action 参数）。
- **工作量**：S

#### INF-11 文档字段/默认值小漂移（多处）
- **严重度**：P2（单条均小，合并管理避免继续积累）
- **类别**：文档一致性
- **位置/证据**：
  - `docs/PROTOCOL.md:33`：“CDN … 本程序只发文本，暂不需要” —— 媒体（图片/视频/文件/语音入站）已完整实现（docs/MEDIA.md、server/src/media.js、mock CDN）；
  - `docs/ARCHITECTURE.md:258` 的 CSP 字符串无 `media-src 'self'`，而实际响应头（`server/src/api.js:44-45`、本地 curl 实测）含 `media-src 'self'`；
  - `README.md:414`“可在 `.env` 调整 `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`”与 `README.md:432-438`（运行参数后台可改、`.env` 仅 6 项）及 `server/src/settings.js:29-30`（rateLimitMax/Window 为 DB 可改、restartRequired）不一致（env 仅作首次默认值，表述应明确）；
  - `README.md:449` `NODE_ENV` 默认写 `production`，代码默认 `development`（`server/src/config.js:83`；Docker 场景才由 compose/Dockerfile 注入 production）。
- **影响**：读者按文档理解协议能力/CSP/配置来源出现偏差；排障时困惑。
- **修复建议**：逐条修正；建立“默认值单一来源”：docs 中默认值表由脚本校验 config.js/SETTINGS_SCHEMA（可放进 CI 的 doc-lint）。
- **工作量**：S

### P3

#### INF-12 无 lint / format / typecheck 工具链
- **严重度**：P3
- **类别**：工程化
- **位置**：根目录无 `.eslintrc*`/`eslint.config.js`/`.prettierrc*`/`.editorconfig`/`tsconfig.json`（实测均不存在）；`package.json:11-22` 仅 start/dev/mock/test/docker 脚本
- **证据/说明**：全仓依赖为纯 JS（ESM，无 TS），但有 2 万+ 行手写源码；`node --check` 只能语法检查。代码风格靠人工约定（如 `.gitattributes` 只统一换行）。
- **影响**：风格/常见错误（未使用变量、浮空 Promise 等）无自动发现，review 成本高；格式化噪声可能触发 INF-05 脆弱测试。
- **修复建议**：引入 eslint（flat config，node --test 无构建冲突）+ prettier（或 Biome 一体化，更轻），CI 加 `lint`/`format --check`；对 web 源码采用“格式化后再跑测试”顺序验证 INF-05 改造收益。
- **工作量**：M

#### INF-13 无版本发布流程与运维文档配套
- **严重度**：P3
- **类别**：发布管理
- **位置**：无 `CHANGELOG.md`、`SECURITY.md`、`CONTRIBUTING.md`、`.nvmrc`/`.node-version`、`.github/dependabot.yml`；`git tag -l` 为空（无任何 tag）
- **证据/说明**：workflow 支持 `tags: v*` 触发（docker-publish.yml:5），但仓库从未打 tag；package.json version 2.0.0 与 README 一致，但无发布说明/版本历史；fnOS 用户依赖 `:latest` 浮动 tag（docker-compose.fnos.yml:38）。
- **影响**：用户无法判断“升级了什么/是否安全”；无法回滚到明确版本；无依赖更新自动化。
- **修复建议**：引入 tag + GitHub Release（release-please 或手动 CHANGELOG）；fnOS 文档给出 `sha-*`/版本 tag 固定示例；加 dependabot（npm + docker + actions）；补 `.nvmrc` 与 `engine-strict`（见 INF-21）。
- **工作量**：S/M

#### INF-14 截图占仓库体积约 48%
- **严重度**：P3
- **类别**：仓库卫生
- **位置**：`screenshots/`（23 个 PNG，合计 **2249.2KB**，git 跟踪）；GitHub API `size_kb=4689`
- **证据/说明**：最大单图 bind-mobile.png 264.8KB、bind-mobile-confirmed.png 182.9KB；README 全部引用，但同一图片重复引用（README:102-108 两次 admin-settings.png）。占 GitHub 仓库体积约 48%，克隆/拉取成本偏高。
- **影响**：仓库膨胀、clone 慢；截图更新会持续增大历史。
- **修复建议**：PNG→WebP/JPEG（q=80）或压图（pngquant）可减 50-80%；去除重复引用；超大量截图可考虑 Git LFS 或外链（考虑国内访问可放项目页/对象存储）。
- **工作量**：S

#### INF-15 `.gitattributes` 未覆盖 `*.html`/`*.css`，工作区换行不一致
- **严重度**：P3
- **类别**：仓库卫生
- **位置**：`.gitattributes:1-16`（列了 sh/js/mjs/json/yml/md/Dockerfile/.env.example/ps1）；实测 `git ls-files --eol`：`web/admin.html`、`web/index.html`、`web/docs.html`、`web/assets/style.css` 均为 `i/lf w/crlf`，而 `web/assets/admin.js` 为 `i/lf w/lf`
- **证据/说明**：Windows 下（core.autocrlf=true）HTML/CSS 检出为 CRLF、JS 为 LF；现有测试用 `[^\n]` 正则，暂未触发，但混合换行会让 diff/源码断言（INF-05 的 `\n` 正则）在其它机器/工具链下更易碎。
- **影响**：跨平台协作时无关 diff、潜在测试差异。
- **修复建议**：`.gitattributes` 增加 `*.html text eol=lf`、`*.css text eol=lf`（或统一 text=auto 并按团队约定）；执行一次 `git add --renormalize .`。
- **工作量**：S

#### INF-16 本地机密/备份文件现状（已正确忽略，但存放位置可再收口）
- **严重度**：P3
- **类别**：机密与仓库卫生
- **位置**：`.env`（本地未跟踪，107 行、5253B，`.env:26` 有 64 hex `APP_SECRET`；`.env:32` 注释仍写“3000:3000”，为旧模板）；`backups/clawbridge-v9-20261102-220641.db`、`backups/clawbridge-v10-20261102-220641.db`（各 237568B）；`.gitignore:6-9,12-14`；`.dockerignore:13-19`
- **证据/说明**：
  - **`.env` 未被 git 跟踪**：`git ls-files .env` 为空、`git log --all -- .env` 为空；`.gitignore:12-13` 忽略 `.env`/`.env.*` 并 `!.env.example`；`.dockerignore:18-19` 排除 `.env`/.env.*（构建上下文不泄露）；
  - **backups 未入库**：`git ls-files backups` 为空、`git log --all -- backups` 为空；`*.db` 忽略（`.gitignore:7`）。实测两份 DB 为真实 SQLite：v10 schema=10、v9 schema=9，行数 `users=1, inbound_messages=5, outbox=4, events=94, groups=1, user_groups=1, app_rules=1, scheduled_tasks=1, app_settings=4`（只读查询，未导出内容）；v9 库无法被当前版本打开（见 INF-03）；
  - **本地 `.env` 为旧版模板**（107 行 vs `.env.example` 273 行），注释仍有 3000 端口等过期信息，且含明文 APP_SECRET（虽未跟踪，但工作区若被打包/分享会泄露主密钥；该密钥可解密 DB 内 bot_token/context_token）。
- **影响**：当前无 git 泄漏（证据充分）；但备份 DB 含用户数据且与主密钥同目录，存在“打包整个工作区”时的二次泄露面。
- **修复建议**：`.gitignore` 显式增加 `/backups/`（防止未来非 `*.db` 备份文件误提交）；把 backups 移出仓库目录（如 `..\ClawBridge-backups\`）；本地 `.env` 重新从新版 `.env.example` 生成并轮换 APP_SECRET（轮换会导致已绑定用户需重新扫码，需评估）；文档明确“禁止打包整个工作目录交付”。
- **工作量**：S

#### INF-17 `.env.example` 与代码读取的环境变量有 6 项未覆盖，BOT_AGENT 示例值不一致
- **严重度**：P3
- **类别**：文档一致性
- **位置**：代码读取清单（`server/src/config.js` 共 63 个 env）对 `.env.example`（273 行，60 个变量名）差集：`BINDING_NETWORK_ERROR_LIMIT`、`BINDING_POLL_GAP_MS`、`BINDING_VERIFY_TIMEOUT_MS`、`ILINK_ROUTE_TAG`、`MEDIA_ALLOWED_IMAGE_MIME`、`MEDIA_ALLOWED_VIDEO_MIME` 只在 `docs/SETTINGS.md:116-120` 出现；`.env.example:100` `# BOT_AGENT=ClawBridge/2.0.0` 与代码默认 `OpenClaw`（`config.js:109`、`docs/PROTOCOL.md:32`）不一致
- **证据/说明**：diff 由脚本提取 `envStr/envInt/envBool(env, 'X')` 与 `.env.example` 的 `KEY=`（含注释行）计算；上述 6 项均为“可后台改、env 仅首次默认值”，但 `.env.example` 自述“包含全部首次默认值”，文档承诺不完整。demo 变量 `MOCK_*`、fnOS 变量 `PUID/PGID/DATA_PATH` 已在模板中（合理）。
- **影响**：想用 env 固定初始默认值的用户找不到变量名；BOT_AGENT 示例容易误解默认行为（真实 API 仅观测用途，影响低）。
- **修复建议**：补齐 6 项注释或明确“仅后台可改、不提供 env 首次默认”；把 `.env.example` 头部“其余全部可在后台改”与 SETTINGS §7.2 对齐；BOT_AGENT 注释标注“默认 OpenClaw，示例可选 ClawBridge/2.0.0”。
- **工作量**：S

#### INF-18 单测样板重复、helper 命名不统一
- **严重度**：P3
- **类别**：测试架构
- **位置**：31 个 `tests/unit/*.test.*` 顶部重复 `mkdtemp + process.env + 动态 import + after closeDb/rm`（示例 `tests/unit/backend-store.test.js:13-28`、`tests/unit/backend-api.test.js:15-45`）；`tests/unit/backend-test-secrets.js`（非测试 helper 放在 unit 目录）；`tests/unit/lead-core.test.mjs`、`lead-media.test.mjs` 命名与其余 `backend-*` 不一致
- **证据/说明**：31/33 个单测文件使用 mkdtemp；每文件固定设置已废弃的 `ADMIN_PASSWORD`/`API_TOKEN` 环境变量（31 个文件各 2 处），仅被 `backend-test-secrets.js:13-31` 用于显式 seed DB（该设计已在 helper 头注释说明，可接受但易误解为“env 仍生效”）。
- **影响**：新增测试复制粘贴成本高、易漏 cleanup；命名/结构不统一增加维护者认知负担。
- **修复建议**：抽 `tests/helpers/unit-env.mjs`（mkdtemp + env 默认值 + after 注册 + `seedSecrets` 封装，支持自定义 env 覆盖），按 `tests/unit/<module>.test.js` 统一命名；`backend-test-secrets.js` 移入 `tests/helpers/`。
- **工作量**：M（改动 31 文件，可脚本化）

#### INF-19 e2e helper 单文件 1454 行，职责过多
- **严重度**：P3
- **类别**：测试架构
- **位置**：`tests/helpers/e2e-env.mjs:1-1454`
- **证据/说明**：同一文件承担子进程管理/端口/日志、HTTP 客户端、admin 会话、mock 控制面、媒体 AES、外部 API mock、绑定/队列/分组/规则/定时/设置断言助手、清理；`E2E` 类方法数十个。覆盖统计显示 helper 自身 90.99%/77.87%（e2e 文件 in-process import）。
- **影响**：新人上手难；单文件修改冲突概率高；部分工具（外部 API mock）与进程管理耦合。
- **修复建议**：拆 `tests/helpers/process-env.mjs`（spawn/端口/清理/日志）、`e2e-client.mjs`（E2E 类与 HTTP/断言）、`mock-api.mjs`（外部 HTTP mock）、`media-crypto.mjs`；保留 `e2e-env.mjs` 作为统一导出。
- **工作量**：M（纯重构，靠现有 91 e2e 回归保护）

#### INF-20 README 质量验收表含仓库内无法复现的浏览器测试数字
- **严重度**：P3
- **类别**：文档可信度
- **位置**：`README.md:532-542`（尤其 `:539`“74 + 19 + 38 + 31 + 20 + 28 + 40 + 20 + 25 + 21 + 1 + 26 项通过”“见交付说明”）
- **证据/说明**：HEAD 快照中仓库内无浏览器/CDP 测试脚本（`scripts/` 仅 demo.ps1/demo.sh）；`screenshots/` 仅图片产物；本机 `%TEMP%` 残留旧 QA 目录（clawbridge-cdp-profile 等）印证历史上存在脚本但未提交。
- **备注（审查期间观察到）**：工作区出现了未提交的并发改动——新增 `scripts/frontend-smoke.mjs`，`package.json` 增加 `test:ui`（`node scripts/frontend-smoke.mjs`）与 `smoke:mock`，README:495-500/537-540 增加对应说明（17 项浏览器冒烟，无浏览器自动跳过，待验证）。若该脚本提交并接入 CI，本条的“不可复现”问题可基本关闭；但 README:539 那组巨大数字（74+19+…）仍不可复现，建议同步收口。
- **影响**：验收证据不可复核，削弱“362 项全绿”等可验证声明的可信度。
- **修复建议**：把浏览器冒烟脚本（可抽象为 Playwright/CDP）纳入仓库与 CI，或删除不可复现的数字、仅保留可执行命令（`npm test`、`node mock/selftest.mjs`）与结果。
- **工作量**：S/M

#### INF-21 Node 引擎下限无强制校验/版本文件
- **严重度**：P3
- **类别**：工程化
- **位置**：`package.json:8-10`（engines `>=22.13.0`，node:sqlite 免 flag 的最低版本）；无 `.nvmrc`/`.node-version`，无 `engine-strict`
- **证据/说明**：低于 22.13 的 Node 会在 `import { DatabaseSync } from 'node:sqlite'` 处以模块错误崩溃，报错不直观；Dockerfile:19 固定 node:24 规避了容器场景。
- **影响**：本地开发/第三方部署在旧 Node 上出现难懂错误。
- **修复建议**：加 `.nvmrc`（24）、`.npmrc engine-strict=true`；`server/src/index.js` 启动时显式检查 `process.versions.node` 并给出可读错误（可选）。
- **工作量**：S

#### INF-22 ARCHITECTURE 保留内部协作痕迹
- **严重度**：P3
- **类别**：文档
- **位置**：`docs/ARCHITECTURE.md:12-26`（Owner 列：lead/backend-dev/frontend-dev/infra-dev；“config.js 已就绪，勿改”“禁止修改他人范围文件”）
- **证据/说明**：属开发过程约束，对开源/交付读者无意义且暴露内部流程。
- **影响**：文档噪音；用户可能误解“config.js 不能改”。
- **修复建议**：移到 `CONTRIBUTING.md` 或删除 Owner 列，仅保留目录职责说明。
- **工作量**：S

#### INF-23 errors/logger 无直接单测
- **严重度**：P3
- **类别**：测试覆盖
- **位置**：`server/src/errors.js`、`server/src/logger.js`；无 `tests/unit/backend-errors.test.js` / `backend-logger.test.js`
- **证据/说明**：覆盖报告 errors.js 86.92% line / 80.77% branch、logger.js 95.08% line / 68.42% branch；错误码映射、`toErrorResponse`、日志脱敏（token/password 字段）仅通过 API/设置测试间接覆盖。
- **影响**：错误响应格式/脱敏回归可能逃逸（安全相关分支应直接测）。
- **修复建议**：补两个小单测文件（错误码映射表驱动、logger 脱敏键名/嵌套/循环引用、级别切换）。
- **工作量**：S

#### INF-24 全量测试并行度与运行时间声明
- **严重度**：P3
- **类别**：测试基础设施
- **位置**：`package.json:15`（`node --test` 无 concurrency 配置）；README:537（“约 35s”）；docs/ARCHITECTURE.md:289（“全部测试 90s 内”）
- **证据/说明**：本机 362 用例 33.5s 墙钟，各用例时长累计约 102s（29 个用例 >1s、6 个 >3s，最慢 keepalive 6.2s），说明依赖 node --test 默认按文件并行；12 个 e2e 文件各自 spawn app+mock（低配 CI 2 核时并行度下降，时长可能明显上升；README 数字未在 CI 验证）。
- **影响**：CI 时长不稳定/超时；开发者本机与 CI 结果差异。
- **修复建议**：CI 固定 `--test-concurrency=4`（或按 e2e/unit 分 job），README 标注“本机参考值、CI 实测值”；必要时拆分 e2e 慢用例（keepalive 压缩时间参数已做，可再调小）。
- **工作量**：S

## 3. 工程化改进路线

### 立即（1 周内，止血）
1. **CI 测试门禁（P1/INF-01）**：新增 `.github/workflows/ci.yml`：PR/push 跑 `npm ci` + `npm test` + `node mock/selftest.mjs`；`docker-publish` 加 `needs` 与 main 分支门禁；PR 至少跑构建（不 push）。
2. **文档止血**：修 INF-02（README keepalive 默认值）、INF-04（admin.html schema v8）、INF-03 在 4 篇 docs 前加“历史设计/现行行为”提示或改写；统一 README:414/449（INF-11）。
3. **隐私与卫生**：确认截图/示例昵称是否真实（INF-08），是则按隐私事件处理；否则替换为演示数据并重生成 2.0.0 截图；本地 `.env` 从新版模板重建、评估 APP_SECRET 轮换（INF-16）。

### 短期（2–4 周，质量与稳定）
4. **覆盖率门禁（INF-06）**：`npm run coverage` + CI 阈值；补 dispatcher/monitor/index/errors/logger 单测；补优雅退出（SIGTERM→notifystop→DB close）断言。
5. **e2e 稳定性（INF-07）**：负向断言改为 `expectNoChange`；app 改 PORT=0 解析启动日志；子进程 env 白名单；CI 连跑 3 次观测。
6. **前端测试改造（INF-05）**：先去掉格式耦合断言，再抽 `web/assets/lib/*` 纯函数单测，最后引入 1 条浏览器冒烟（Playwright，CI 可选 job）。
7. **mock 保真（INF-09）**：`/mock-bind` 占位或移除；e2e 统一 `assertNoRejections()`；selftest 补拒绝面。
8. **compose/镜像可复现（INF-10）**：pin digest/actions SHA、mock 服务补齐 logging/security_opt、发布加 smoke+provenance+sbom。

### 中期（1–2 月，可持续）
9. **工具链（INF-12/13/21）**：eslint+prettier（或 Biome）、`.nvmrc`+engine-strict、dependabot、CHANGELOG/GitHub Release、tag 策略（fnOS 文档同时给 `:latest` 与固定版本示例）。
10. **文档单一来源**：默认值/端点表由 `config`+`SETTINGS_SCHEMA`+`docs/API.md` 生成或校验（doc-lint job）；docs.html 与 docs/*.md 值级一致；README 删除不可复现验收数字（INF-20）。
11. **测试架构整理（INF-18/19/24）**：unit helper + 命名规范、e2e helper 拆分、CI 分片/并发固定；覆盖报告归档为 CI artifact。

## 4. 亮点

1. **e2e 黑盒架构设计成熟**：真实 `mock` + `app` 双子进程、随机端口（mock 以 `PORT=0`+listening 日志解析）、`mkdtemp` 独立 DATA_DIR 并清理、`waitFor/waitStable` 轮询替代固定 sleep、失败时打印 app/mock 日志尾部、Windows `taskkill /T /F` 兜底（`tests/helpers/e2e-env.mjs:49-100,156-188,1339-1430`）；还支持“二次启动不重新生成机密”场景（`settings-security.test.js:175-201`）。
2. **机密治理到位**：`.env` 与 `backups/*.db` 均未被 git 跟踪（`git ls-files`/`git log --all` 均为空）、`.dockerignore` 排除 `.env`/`*.db`、e2e 从首启自动生成文件读取密码/Token 而非 env、日志脱敏（本次全仓机密模式扫描未在跟踪文件中发现真实密钥）。
3. **文档体系完整且可操作**：9 篇 docs + README(620 行) + 内置 API 文档页 + 25 项 mock 自测，PROTOCOL/MEDIA/API 契约详细到字段级，mock 控制面/环境变量说明完整（`node mock/selftest.mjs` 实测 25/25 PASS）。
4. **覆盖率与测试量**：362 用例全绿、line 91.96% / branch 75.52% / funcs 91.12%；auth 98.17%、store 97.55%、settings 97.10%，core 模块整体可靠。
5. **Docker 交付链路实测可用**：Dockerfile 简洁（node:24-alpine、`npm ci --omit=dev`、USER node、/app/data 700、HEALTHCHECK 用内置 fetch）、3 份 compose `config` 校验通过、容器健康且安全响应头完整、优雅退出 15s 宽限 > 10s 强制兜底；GHCR 匿名可拉取、amd64+arm64 多架构、HEAD 提交已有成功发布记录。
6. **依赖面极小**：生产依赖仅 express+qrcode，`npm audit --omit=dev` 0 漏洞，lockfileVersion 3 与 `npm ls` 一致；零构建前端 + 内置 node:sqlite 降低供应链与部署复杂度。

## 5. 附录：测试覆盖映射表

### 5.1 测试组织总览

| 目录/文件 | 数量 | 说明 |
| --- | --- | --- |
| `tests/unit/` | 33 个 `*.test.js` + 1 个 helper（`backend-test-secrets.js`） | 271 用例；进程内导入业务模块 + `listen(0)` HTTP 契约，无外部网络 |
| `tests/e2e/` | 12 个 `*.test.js` | 91 用例；真实 app+mock 子进程 + 随机端口 + 临时 DATA_DIR，全 HTTP 黑盒 |
| `tests/helpers/e2e-env.mjs` | 1 个，1454 行 | e2e 环境/断言/外部 API mock/媒体工具（自身覆盖 90.99%/77.87%） |
| 合计测试文件 | **45**（任务描述中的 39 为旧口径） | 单/并跑均 exit 0；本机 33.5s，用例时长累计约 102s |
| `frontend-pages.test.js` | 1504 行 / 51 用例 | 静态页面结构 + 源码文本断言（脆弱性见 INF-05） |
| `mock/selftest.mjs` | 25 项 | 独立启动 mock 子进程自测协议面/控制面/媒体 CDN（2.4s） |

### 5.2 server/src 模块 → 测试文件 → 覆盖与缺口

> 覆盖率来自 `node --test --experimental-test-coverage`（exit 0）。e2e 在子进程中运行的代码不计入该百分比，故“缺口”列同时标注 e2e 黑盒是否兜底。

| 模块 | 主要进程内测试文件 | 行% / 分支% | 覆盖缺口（含 e2e 兜底情况） |
| --- | --- | --- | --- |
| `api.js` | backend-api / groups-api / media-api / keepalive-api / scheduled-api / app-rules-api / settings-api / settings-security + 12 个 e2e | 91.50 / 79.33 | 系统重启生产分支（api.js:1586-1604 等）、部分校验/媒体异常分支；e2e 覆盖主链路与重启 409/401/403（backend-settings-api.test.js:194-204） |
| `app-rules.js` | backend-app-rules-core / engine；e2e app-rules | 95.32 / 73.03 | 重定向复验、超时/大小限制少量分支 |
| `auth.js` | backend-auth / settings-security；e2e lifecycle-auth | 98.17 / 92.77 | 少量 Cookie/限流边界 |
| `binding.js` | backend-binding / rebind；e2e bind-flow | 77.62 / 68.00 | 刷新二维码/配对码竞态/IDC redirect/binded_redirect 分支仅 e2e 黑盒覆盖；无进程内断言 |
| `config.js` | lead-core；其余单测作为副作用加载 | 97.51 / 76.32 | 非法 env/文件读取失败分支 |
| `crypto.js` | lead-core、backend-auth、settings-security 等（无独立 crypto 测试文件） | 95.43 / 73.85 | 篡改/格式异常少量分支 |
| `db.js` | backend-schema-version + 各 store 测试 | 97.22 / 72.22 | 已无迁移逻辑（见 INF-03）；关闭/异常分支 |
| `dispatcher.js` | backend-media-dispatcher / rebind；e2e push-flow / media-flow | **66.58 / 68.57（func 50）** | start/stop 生命周期、其他错误重试、部分媒体分支无直接单测（e2e 兜底）——**最低覆盖模块** |
| `errors.js` | 无直接测试（API 测试间接） | 86.92 / 80.77 | 错误码映射/ILinkError 分类分支 |
| `ilink.js` | lead-core / backend-ilink | 90.20 / 78.15 | fetch 异常/HTTP 非 200/响应超限部分分支 |
| `index.js` | 无（e2e 子进程启动） | 不计入 | 优雅退出（SIGTERM→notifyStop→DB close）、启动失败/恢复监控无断言级测试 |
| `keepalive.js` | backend-keepalive-scheduler/store/api/disabled；e2e keepalive | 88.89 / 83.33（func 66.67） | start/stop/restart 生命周期无直接单测 |
| `logger.js` | 无直接测试（间接） | 95.08 / **68.42** | 脱敏/级别切换分支 |
| `media.js` | lead-media；backend-media-store/dispatcher/api/inbound；e2e media-flow | 92.76 / 72.22 | CDN 重试/失败分支、部分 MIME 边界 |
| `monitor.js` | backend-monitor / media-inbound、binding、rebind；e2e 多文件 | 80.30 / **57.94** | runLoop 退避、stale-token pause、游标持久化、stopAll 分支（**分支覆盖最低**） |
| `rate-limiter.js` | backend-rate-limiter | 100 / 86.89 | 虚拟时钟边界 |
| `scheduler.js` | backend-scheduler / scheduled-window / scheduled-store / scheduled-api；e2e scheduled-tasks | 92.39 / 70.92 | tick 异常隔离/时区边界 |
| `settings.js` | backend-settings / settings-api / settings-security；e2e settings / settings-security | 97.10 / 87.38 | 少数字段校验/hook 分支 |
| `store.js` | 11 个 unit 文件（store/groups/keepalive/media/scheduled/app-rules/settings 等） | 97.55 / 72.62 | 统计/异常分支 |
| `web/assets/*.js`（admin.js 5896 行） | frontend-pages.test.js（源码文本断言） | n/a | **无函数级/DOM 行为覆盖**（见 INF-05） |
| `mock/ilink-mock.mjs` | mock/selftest.mjs（子进程自测，25 项） | 不计入 | `/mock-bind`、拒绝面等未覆盖（见 INF-09） |

### 5.3 主要测试缺口清单（按影响排序）

1. `index.js` 生命周期/优雅退出无断言级测试（SIGTERM 只作为 e2e 清理手段被间接使用，e2e-env.mjs:156-188）。
2. `dispatcher.js`（66.58%/func 50）与 `monitor.js`（branch 57.94）异常路径缺进程内单测，e2e 兜底但定位成本高。
3. `web/assets/admin.js` 无行为测试（INF-05）。
4. `errors.js`/`logger.js` 无直接单测（安全相关脱敏逻辑）。
5. mock 协议违规 `rejections` 几乎不断言（仅 media-flow.test.js:153），协议回归缺自动拦截。
6. 文档值级一致性无测试（schema 版本/默认值漂移靠人工发现，如 INF-02/04/11）。

---

*附：审查过程中仅执行只读命令（read/git/npm test/coverage/audit、node:sqlite readOnly 查备份 DB 行数、docker inspect/config、本地 curl、匿名 GHCR manifest、临时 mock 进程验证 /mock-bind 404 后已停止）；未修改仓库文件，未改动/重启容器。*
