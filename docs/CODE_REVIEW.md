# ClawBridge 系统审查与代码结构优化报告

- **审查对象**：ClawBridge v2.0.0（多用户微信 ClawBot 扫码绑定与消息推送平台），仓库根目录 `F:\ClawBot`
- **审查基线**：`main` @ `a23c2be`（2026-11-08），审查开始时工作区干净；全部 362 项测试通过
- **审查日期**：2026-11-08
- **审查方式**：3 名并行审查员（后端 / 前端 / 测试与基础设施）+ 主审运行验证、重构实施、回归验收
- **交付物**：
  - 本报告：`docs/CODE_REVIEW.md`
  - 明细审查报告（未删减，含逐条证据/行号/修复建议，已归档至 `docs/review/`）：`docs/review/backend.md`、`docs/review/frontend.md`、`docs/review/infra.md`
  - 代码结构重构：`server/src/api.js` 拆分、`web/assets/admin.js` 拆分（见第 5 节）
  - 新增工程能力：浏览器冒烟测试 `scripts/frontend-smoke.mjs`（`npm run test:ui`）、覆盖率脚本、CI 测试门禁
  - 修复：审计确认的 P1/P2 缺陷（见第 5 节）

---

## 1. 执行摘要

**总体结论：这是一套工程质量明显高于同规模项目的系统，但仍存在 4 个 P1 级问题（其中 2 个已在本轮修复）、24 个 P2 级问题，以及两个"巨石模块"造成的可维护性瓶颈。**

验证侧：审查基线 362 项测试（unit 271 + e2e 91）全部通过；三轮修复/重构/加固后 **464 项（462 通过 + 2 项 POSIX-only 在 Windows 跳过，约 35s）**，源码 in-process 覆盖率 line 94.03% / branch 77.17% / funcs 93.82%（排除 `web/**` 与 `tests/**`，CI 强制阈值）；`npm run lint` 0 告警；mock 协议自测 26/26；Docker 镜像/容器健康、GHCR 多架构发布链路实测可用；生产依赖仅 `express` + `qrcode`，`npm audit --omit=dev` 0 漏洞；机密管理（`.env`/`backups` 未入库、AES-GCM 凭证、scrypt、常量时间比较、CSP/CSRF）扎实。本次额外补上了此前缺失的**真实浏览器冒烟测试**（headless Edge + CDP，16 项检查）与**可复现截图脚本**，使前端行为与文档截图都可复现验证。

结构侧：重构前 `server/src/api.js`（1895 行/1 个导出/69 个路由 + 全部校验与媒体 IO）、`web/assets/admin.js`（5895 行/171 个函数/7 个视图）是两个典型"上帝模块"。本轮已完成等价拆分：

| 模块 | 重构前 | 重构后 |
| --- | --- | --- |
| `server/src/api.js` | 1895 行 | **87 行**（仅组合根）+ `http/**` 8 文件 + `routes/**` 11 文件（2097 行，最大单文件 203 行） |
| `web/assets/admin.js` | 5895 行 | **198 行**（entry）+ `admin/**` 14 文件 + `lib/**` 4 文件（6064 行） |

问题侧：共确认 **76 条**问题（P0 0 / P1 4 / P2 24 / P3 48）。4 个 P1（SSRF DNS rebinding、入站媒体 OOM、CI 无测试门禁、新规则/任务默认启用）**已全部修复**；P2 中的会话弹窗泄漏、日志 URL 机密、共享附件归属、优雅退出、入站媒体 URL 校验、消息/索引全表扫描、前端编辑器重复、模态框/Tab 可访问性、测试门禁/覆盖缺口、截图隐私等也已在本轮修复（见第 5 节）。剩余工作集中在 `settings.js`/`auth.js` 进一步解耦、前端 state/els 重构、文档值级一致性校验与少量边界/体验优化。

---

## 2. 系统验证结果（查验）

### 2.1 运行时与部署

| 验证项 | 命令/方式 | 结果 |
| --- | --- | --- |
| 本机运行实例 | `docker inspect clawbridge-app` + `curl 127.0.0.1:10380` | 容器 healthy，`/health` 200 `{status:"ok",version:"2.0.0"}`；`/`、`/admin`、`/docs` 均 200；`/api/admin/me` 未登录返回 `{authenticated:false}`；未鉴权 `/api/v1/users` 401；未知路由 404 JSON |
| 安全响应头 | `curl -I /` | `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、完整 CSP（含 `media-src 'self'`）、页面 `no-store` |
| 启动日志 | `docker logs` | schema v10 初始化、2 项 DB 覆盖配置加载、dispatcher/keepalive/app-rules/scheduler 启动、1 个 active 用户入站监控恢复成功；无错误日志 |
| 源码启动 | 临时 DATA_DIR/随机端口启动（测试与冒烟脚本） | 正常启动/优雅退出，无残留 |
| mock 微信 API | `node mock/selftest.mjs` | **26/26 PASS**（本轮为 mock 增加 `/mock-bind` 占位页后 +1） |
| 依赖与漏洞 | `npm ls`、`npm audit --omit=dev` | 生产依赖仅 2 个；**0 漏洞** |
| 部署配置 | `docker compose config`（3 份） | 均校验通过；GHCR `amd64+arm64` 匿名可拉 |
| 页面资源可达性 | 浏览器冒烟 + 静态测试 | 三页面 200、全部 `/assets/*` 可加载、无外部 CDN 引用 |

> **部署记录（2026-11-08）**：本报告完成后已在本机实例完成部署验证：`docker compose build` 构建新镜像
> （`clawbridge:local` new image）→ 停止旧容器 → `docker compose up -d` 创建新容器（`clawbridge-app`，compose 管理）。
> 结果：health 通过、`/`、`/admin`、`/docs` 均 200、安全响应头完整；旧数据卷 `clawbridge-data` 保留，
> schema v10 直接打开、既有绑定用户入站监控恢复成功（monitor started: 1）、新增 maintenance 任务启动日志出现。
> 回滚方式：`git checkout a23c2be` 重建镜像，或使用 GHCR 上上一版本的 `:latest`/`sha-*` 镜像。

> 运维提示：当前运行实例的日志出现"DB 已有管理密码、但 data/admin-password.txt 不存在（旧卷升级）"告警。若数据卷只保留了 DB 而丢失首批 secret 文件，后台密码将无法从文件找回，只能登录后重置（或按日志提示操作 DB）。建议升级/恢复流程中同时保留 `data/` 整个目录，并在 README 升级章节明确。

### 2.2 测试与覆盖率

| 验证项 | 结果 |
| --- | --- |
| `npm test` | 重构前 **362/362 pass**（33.3s）→ 三轮修复/重构/加固后 **464 项：462 通过 + 2 项 POSIX-only 跳过**（约 35s） |
| `npm run test:unit` | 271 → **373**（371 通过 + 2 项 Windows 跳过；新增前端 modules/lib/弹窗/焦点、后端 logger、调度器/分发器生命周期、数据库索引、SSRF、媒体闸门、维护 GC、错误映射、shared 管线等测试） |
| `npm run test:e2e` | 91/91（真实 app + mock 双进程、随机端口、临时 DATA_DIR 黑盒；子进程 env 白名单、稳定等待断言、mock 违规统一断言） |
| 覆盖率（`npm run coverage`，in-process，排除 web/tests，CI 强制阈值 90/70/85） | line **94.03%** / branch **77.17%** / funcs **93.82%**；最低集中在 dispatcher/monitor 等异步生命周期模块（本轮已补生命周期测试；`index.js` 由子进程运行不计入） |
| `npm run lint`（ESLint flat config，CI `--max-warnings=0`） | **0 error / 0 warning** |
| mock 自测 | 26/26 |
| 浏览器冒烟（新增） | `npm run test:ui`：登录、7 个菜单视图、分组创建/删除、规则/任务编辑器、登出、绑定页/文档页，Console/未捕获异常检查，全部通过 |

### 2.3 前端真实交互验证（本轮新增）

原仓库的 `frontend-pages.test.js` 只能做"源码文本 grep"（1500 行静态断言），无法发现运行时问题，也无法在重构时提供行为保护。本轮新增 `scripts/frontend-smoke.mjs`（零依赖，Node 内置 WebSocket + 本机 Edge/Chrome CDP）：

1. 以随机端口 + 临时 DATA_DIR 启动一个独立 app 实例（不影响 `data/` 与线上容器），读取首启自动生成的管理密码；
2. headless 启动浏览器，真实登录后台；
3. 遍历 7 个菜单视图并校验渲染文本；
4. 真实执行"新建分组 → 列表出现 → 删除分组 → 列表消失"；
5. 打开规则编辑器（17 个字段标签）与定时任务编辑器（16 个字段标签）后关闭；
6. 登出回到登录页；加载绑定页与文档页；
7. 全程收集 `Runtime.exceptionThrown` / `console.error` / 浏览器 error 日志，任何异常即失败。

该项已纳入 `npm run test:ui`，无浏览器环境时自动跳过；README 质量表与 `docs/ARCHITECTURE.md` §10 已同步。

---

## 3. 架构评估

### 3.1 优点（应保留的设计）

1. **安全底座扎实**：凭证 AES-256-GCM 落库、HMAC 会话、Cookie HttpOnly/SameSite、写接口 CSRF 头、API Key 常量时间比较、登录/API/IP 三层限流、SSRF 私网全段拒绝 + 重定向逐跳复验、日志键名脱敏、CSP 无内联脚本；前端零 XSS 写入路径（全程 `textContent`/DOM 属性）。
2. **并发与事务细节到位**：单 dispatcher 顺序投递 + 状态守卫；`caption_sent_at` 防重复发送；monitor 凭据代际比较防换绑脏写；规则执行 `(rule_id, inbound_message_id)` 唯一索引幂等；保活"入队+标记+事件"单事务。
3. **配置热更新架构清晰**：`SETTINGS_SCHEMA` + DB `app_settings` + 启动 `loadOverrides()` + 运行时 hooks 依赖注入，避免循环依赖。
4. **测试体系分层合理**：31 个进程内单测 + 12 个 e2e 文件 + mock 自测；e2e 真实双进程、随机端口、临时目录、失败打印日志、Windows 清理兜底。
5. **文档与契约意识强**：9 篇 docs + README + 内置文档页；错误响应格式统一；协议字段有 mock 对照。
6. **依赖面极小**：仅 `express` + `qrcode`，零构建前端，内置 `node:sqlite`，供应链风险低。

### 3.2 主要结构问题（重构前）

| 问题 | 证据 | 影响 |
| --- | --- | --- |
| `api.js` 上帝模块 | 1895 行、69 个路由、45 个内部函数混在一起，`createApp()` 单函数 983 行 | 任何接口改动都触及同一文件；校验/视图/媒体 IO 无法复用与单测 |
| `admin.js` 上帝模块 | 5895 行、171 个函数、7 个视图、两套 ~1000 行编辑器 | 无法按视图隔离；首屏解析 234KB；多人并行冲突面大 |
| 模块依赖方向异常 | `scheduler → app-rules` 内部实现 5 个函数、复制执行管线；`binding → dispatcher`；`auth → settings`；`settings → store` | 领域模块互相耦合，配置语义混淆（定时任务用了接口应用的 `allowedHosts/maxResponseBytes`） |
| 编辑器重复代码 | 规则 vs 定时编辑器 1335 行，规范化后重复度 52%–94%；switch 构建器 5 份、行按钮 4 份、表点击分发 4 份 | 改一处逻辑需同步两处；历史行为漂移风险 |
| 超大纯文件 | `store.js` 2126 行（9 个领域）、`app-rules.js` 1474 行（模板+HTTP 客户端+引擎）、`style.css` 4352 行 | 阅读/测试/拆分成本高 |
| 测试绑定实现细节 | `frontend-pages.test.js` 23 处直接读取 `admin.js` 源码文本，含"恰好出现 2 次"等精确计数 | 重构即红、假失败与假通过并存 |

### 3.3 已实施的重构（行为零变更）

**后端**（`server/src/api.js` 1895 → 87 行）：

- `http/middleware.js`：安全头、API 不缓存、JSON body（媒体上传路径绕过）、raw 媒体解析器工厂、404、统一错误处理；
- `http/{helpers,views,validators,app-rule-validators,scheduled-validators}.js`：工具、视图映射、校验器与 patch 构造；
- `http/{media-handlers,queue-service}.js`：媒体上传/下载、分组入队、webhook 请求解析；
- `routes/*.js`（11 个文件）：按领域注册 69 条路由，顺序与拆分前一致；
- `api.js` 只保留 `createApp()`：中间件顺序（安全头 → no-store → /health → JSON parser → 路由 → static → 页面 → 404 → errorHandler）逐项保持不变。
- 等价性自检：69 条路由注册、35 条日志调用、27 条 `res.status` 与原文件逐字一致；运行时中间件顺序 introspect 一致；拆分后首次全量测试 362/362 = 基线。

**前端**（`web/assets/admin.js` 5895 → 198 行）：

- `admin.js` 仅 entry：事件绑定、`registerViewLoaders/registerDataLoader` 注册、末尾唯一 `init()`；
- `admin/{constants,state,core,ui,templates}.js`：常量/状态/认证与 hash 路由/公共 UI 构建器/模板与 Markdown 预览；
- `admin/views/{overview,users,groups,messages,broadcast,send-message,app-rules,schedules,settings}.js`：8 个菜单视图 + 发送消息弹窗；
- `lib/{parse,settings,summary,media}.js`：可单测纯函数；
- 依赖方向 `entry → views → {core,ui,state,templates,lib,common}`，无循环 import；`core` 不 import views（注册表模式）。
- 行为等价性：HEAD 版 5407 条规范化代码行 vs 新模块 5408 条，差异仅 156/157 行且全部为有意改写（注册表、入口装配、公共构建器去重、import/export）；意图内去重 `buildSwitch` 5→1、行按钮 4→1、表点击分发 4→1（DOM 属性与文案逐字一致）。

**测试重构**（为拆分提供安全网）：

- `frontend-pages.test.js`：`readAsset('admin.js')` 改为 `readAllAssets()` 聚合全部模块源码；3 处"恰好 2 次"精确计数改为读取具体编辑器模块；innerHTML/设备判断扫描改为 `web/assets/**/*.js` 全量；
- 新增 `frontend-modules.test.js`（10 项）：import 路径存在、无环、入口可达、禁止 `innerHTML/outerHTML/insertAdjacentHTML/eval/new Function`、禁止 `matchMedia/innerWidth`、entry 末尾唯一 `init()` 且 ≤600 行、依赖方向；
- 新增 `frontend-lib.test.js`（18 项）：纯函数行为单测。

**结果**：`npm test` 464 项（362 基线 + 102 新增，462 通过 + 2 项 POSIX-only 跳过），`npm run test:ui` 全部通过，`npm run lint` 0 告警。

---

## 4. 问题清单（按严重度汇总）

> 完整证据、行号（基于重构前 HEAD `a23c2be`）、修复建议与工作量见 `docs/review/backend.md`、`docs/review/frontend.md`、`docs/review/infra.md`。
> 状态列：✅=本轮已修复；🔧=已给出方案待排期；⬜=建议跟踪。

### 4.1 P0（0 条）

未发现可直接导致整库/凭证明文泄露或必然数据丢失的问题。

### 4.2 P1（4 条）

| ID | 问题 | 影响 | 状态 |
| --- | --- | --- | --- |
| BA-01 | SSRF 校验与 `fetch` 两次独立 DNS 解析，未固定 IP，可被 DNS rebinding 绕过（`app-rules.validateTargetUrl` → `requestExternal`） | "管理员可配 URL → 内网/云元数据访问"的横向移动通道，违背默认拒绝私网的安全承诺 | ✅ 已修复：改用 `node:http/https.request`，连接层 `lookup` 固定校验通过的 IP（Host/TLS servername 保持原域名），重定向每跳重新校验并重新钉 IP；补 rebinding/重定向私网单测（见 5.4） |
| BA-02 | 入站媒体下载无全局并发/内存上限：`processMessages` fire-and-forget + 整文件 Buffer（单文件默认 100MB） | 单个已绑定用户发送多个大文件即可 OOM 拖垮全实例 | ✅ 已修复：进程级有界闸门（并发 2/排队 64/排队超时 60s，可后台配置）+ 流式下载解密落盘（`.part` → 原子 rename）；排队超限记附件失败（见 5.4） |
| INF-01 | 唯一 CI workflow 只 build&push，main 每次 push 自动发布多架构 `:latest`，无测试/冒烟门禁 | 未验证代码可直接进入生产（fnOS 用户默认 `pull :latest`） | ✅ 新增 `.github/workflows/ci.yml`（PR：Node 22.x/24.x 矩阵跑 coverage 门禁）+ `docker-publish.yml` 构建前先跑测试与 mock 自测 |
| F-01 | 新建规则/定时任务默认启用，与 `docs/API_RULES.md`、`docs/SCHEDULED_TASKS.md`、后台页面文案"默认不启用"相反 | 管理员按文档"先建草稿再测试"时实际立即生效：定时任务会真实调用外部接口并推送微信 | ✅ 前后端创建默认改为停用 + 单测 + 文档对齐（见 5.1） |

### 4.3 P2（24 条，摘要）

**后端（7）**：BA-03 共享媒体附件归属错误（已修复：入队不再覆盖归属、删除用户时检查其他未完成 outbox 引用并保留共享附件）；BA-04 优雅退出未等在途异步任务即关库（已修复：dispatcher drain + scheduler 在途 tick 等待 + 日志/next_run 同事务 + 退出顺序重排）；BA-05 入站媒体下载未复用 SSRF 防护且默认跟随重定向（已修复：主机白名单 + manual 重定向逐跳复验）；BA-06 Webhook `?token=` 经错误日志落盘（已修复）；BA-07 接口应用运行日志 `request_preview` 未脱敏 query 机密（已修复）；BA-08 入站长轮询/后台消息列表缺排序索引（已修复：`received_at,id` / `created_at DESC` 索引，启动幂等补齐）；BA-09 scheduler 依赖 app-rules 内部实现并复制执行管线、配置来源混用（已修复：抽 `shared/**`，scheduler 独立 `maxResponseBytes/allowedHosts` 配置，见 5.5）。

**前端（7）**：F-02 会话过期时 `confirmDialog` 不在跟踪集合 → Promise 悬挂 + 计数泄漏 + 滚动锁残留（已修复）；F-03 admin.js 单文件与全局 state/els 耦合（已重构为模块化；state/els 进一步按域拆分为后续建议）；F-04 两套编辑器 ~1335 行重复（已修复：抽 `admin/integrations/**` 6 个共享模块，app-rules 1232→927、schedules 990→657，公共块 0 重复）；F-05 前端测试以源码文本为契约阻断拆分（已改造 + 真实浏览器冒烟）；F-06 模态框无 focus trap / 背景 inert（已修复：Tab 焦点陷阱 + 背景 inert/aria-hidden）；F-07 Tab 组件 ARIA/键盘语义不完整（已修复：tabpanel/aria-controls/roving tabindex + 方向键/Home/End）；F-08 关键文字/主按钮颜色对比度不足 WCAG AA（已修复：`--text-muted` 等 token 提升到 AA，详见 5.5）。

**测试与基础设施（10）**：INF-02 README keepalive 默认值与代码矛盾（已修复）；INF-03 4 篇 docs 仍承诺已删除的 schema 自动迁移（已修复/标注历史设计）；INF-04 后台文案仍写 schema v8（已修复）；INF-05 前端测试源码文本 grep 脆弱性（已改造 + 浏览器冒烟）；INF-06 覆盖缺口 + 无覆盖率门禁（已修复：CI 强制 coverage 阈值 90/70/85，新增 index 生命周期/错误/monitor 分支/维护等测试；覆盖率 94.03%/77.17%/93.82%）；INF-07 e2e 固定 sleep 负向断言/dns 继承宿主 env 的 flaky 风险（已修复：env 白名单 + `expectNoChange` 稳定等待 + mock 违规统一断言；getFreePort TOCTOU 小窗口保留为后续项）；INF-08 公开仓库截图含疑似真实昵称/运行时间戳/本机路径且仍为 v1.0.0 旧 UI（已修复：`scripts/screenshots.mjs` 演示数据重生成 23 张 2.0.0 截图，自动脱敏断言）；INF-09 mock `/mock-bind` 死链（已修复）、鉴权失败语义差异（文档注明）、e2e 统一断言 rejections（已修复）；INF-10 基础镜像/actions 未 pin、demo mock 缺 logging/security_opt（已修复：compose 加固 + provenance/SBOM + pin 说明，digest/SHA pin 交由 dependabot）；INF-11 文档字段/默认值小漂移（已修复并复核 8 篇 docs）。

### 4.4 P3（48 条，主题）

死代码/未使用导出（BA-10：ilink/monitor/store 侧已清理，浏览器端未用导入清理后 ESLint 0 告警）；`skipped` 是死状态（文档已标注保留字段）；`restartRequired` 标注漂移与 `binding.js` 派生常量冻结（BA-12：已逐字段校正 + 派生值改实时计算）；PATCH 定时任务窗口字段不重算 `next_run_at`（BA-13：已修复）；"不请求模式"跨字段校验依赖 patch 形状（BA-14：已修复，合并 DB 现有值）；入站消息单条失败被吞掉无死信（BA-15：已修复，可重试保游标重放/不可重试写事件）；视图映射 N+1（BA-16：规则 stats/scope names、定时目标名批量查询已修复）；"今日"统计用进程时区而调度用 `SCHEDULER_TIMEZONE`（BA-17：已统一）；无外键/无数据保留策略（BA-18：日志/孤儿附件 GC 已实现，外键/一致性巡检保留为后续）；绑定成功不检查 `monitor.start()` 结果（BA-19：已修复，warning+事件）；v1 发送对暂停用户语义与后台不一致（BA-20：已修复，409/`pausedUserIds`）；长轮询客户端断开不中止、模板渲染先整页后截断（BA-22：已修复）；启动/退出竞态窗口（BA-23：已修复）；前端竞态/CSS 死选择器/未定义变量/断点混用（F-16/F-17/F-23：已清理 41 条死规则、补齐变量、统一断点；列表请求无序号竞态保留为后续低优先级）；分组表空态 colspan（已修复）；文档双份维护（docs.html 与 docs/*.md）仅单向 token 校验（doc-lint 保留为后续）；测试 helper 重复与命名不统一（INF-18：保留为后续）；`index.js` 生命周期无断言级测试（已补 `backend-index-lifecycle.test.js`，Windows 跳过 POSIX 用例）、`errors.js` 无直接单测（已补）；无 lint（INF-12：已引入 ESLint，CI 0 告警）；无版本发布流程/tag（CHANGELOG 已建立，tag/GitHub Release 流程保留为后续）；截图占仓库体积约 48%（已重新生成但体积约 2.4MB，WebP/压缩保留为后续）；`.env.example` 覆盖缺口（已补齐，含维护/调度新变量）；Node 引擎下限无强制校验（已加 `.nvmrc`/`.npmrc`）；README 质量表含不可复现的浏览器测试数字（已替换为可复现命令）。

---

## 5. 本轮已实施的修复

### 5.1 缺陷修复（P1/P2/P3，均带测试）

| ID | 缺陷 | 修复内容 | 验证 |
| --- | --- | --- | --- |
| F-01 (P1) | 新建规则/定时任务默认启用，与文档契约相反 | 创建接口未传 `enabled` 时默认 `false`；管理后台新建表单默认不勾选「启用」（编辑保留原值） | 后端 2 条单测（创建→false、DB=0、PATCH 不变、显式 true 仍生效）+ 前端 1 条静态断言 |
| F-02 (P2) | 会话过期时 `confirmDialog` 泄漏：Promise 悬挂、`openModalCount` 泄漏、页面滚动锁残留 | `common.js` 用活动弹窗 Set 派生计数并导出 `closeAllModals()`（保留关闭动画/焦点恢复/onClose，confirm 会 resolve(false)）；`admin/core.js` 的 401/登出统一调用 | 新增 `frontend-common-modal.test.js`（2 条 DOM stub 行为测试：计数派生、closeAll 关闭含 confirm 的全部弹窗、Promise resolve、keydown 注销、幂等） |
| BA-06 (P2) | Webhook `?token=` 可经错误日志明文落盘 | `logger.js` 新增 `redactUrlQueryForLog()`（token/api_key/authorization 等），错误处理日志 path 使用脱敏 URL | 新增 `backend-logger.test.js` 3 条 + 真实实例 curl 验证日志无明文 token |
| BA-07 (P2) | 接口应用运行日志 `request_preview` 未脱敏 query 机密 | `app-rules.redactUrlForLog` 复用 query 参数脱敏（保留 userinfo 逻辑），不再把 `?token=/api_key=` 明文写库 | `backend-app-rules-core.test.js` 新增 1 条 |
| BA-13 (P3) | PATCH 定时任务仅改 window 字段不重算 `next_run_at` | 路由 `scheduleKeys` 加入 `windowStart/windowEnd`，使重算条件显式化 | `backend-scheduled-window.test.js` 新增 1 条 |

另同步修正 `docs/API_RULES.md`、`docs/SCHEDULED_TASKS.md` 中 `enabled INTEGER NOT NULL DEFAULT 1` 与"默认不启用"的字面矛盾（注明 DDL 兜底默认值 + API/管理端显式写入）。

修复后全量回归：`npm test` **400/400**（+38，含本轮新增测试）、`npm run test:unit` **309/309**、`npm run test:ui` 浏览器冒烟全通过、mock 自测 26/26。

### 5.2 新增工程能力

| 能力 | 文件 | 说明 |
| --- | --- | --- |
| 浏览器冒烟测试 | `scripts/frontend-smoke.mjs`、`npm run test:ui` | 零依赖 CDP，真实登录/遍历视图/CRUD/编辑器/登出 + Console 异常检查；无浏览器自动跳过 |
| 覆盖率脚本 | `npm run coverage` | `node --test --experimental-test-coverage`，排除 `web/**` 与 `tests/**`，输出源码 in-process 覆盖率，CI 可直接用 |
| CI 测试门禁 | `.github/workflows/ci.yml` | PR：Node 22.x + 24.x 矩阵跑 unit + e2e + mock 自测 |
| 发布门禁 | `.github/workflows/docker-publish.yml` | 镜像构建/推送前先跑测试与 mock 自测 |
| mock 自测增强 | `mock/selftest.mjs` | 26 项（新增 `/mock-bind` 占位页断言） |
| 文档治理 | `CHANGELOG.md`、`SECURITY.md`、`.nvmrc`、`.npmrc` | 发布记录、漏洞报告渠道、Node 版本固定/强制校验 |

### 5.3 文档漂移修复

- `README.md`：keepalive 默认值（12h 首次 + 每 6h 重复）、限流/`NODE_ENV` 来源、目录结构、质量验收表数字与可复现命令；
- `web/admin.html`：schema v8 → v10（`app_settings` 自 v8 引入）；
- `docs/KEEPALIVE.md`、`docs/MEDIA.md`、`docs/GROUPS_AND_INBOUND.md`、`docs/ARCHITECTURE.md`：已废弃的"vX→vY 自动迁移/ALTER TABLE"统一标注为**历史设计记录**，明确现行 schema v10 旧库直接拒绝、只能备份后空库重建；
- `docs/API.md`、`docs/SETTINGS.md`、`docs/PROTOCOL.md`：CSRF 登录例外、上传 MIME/错误码表述、`skipped` 保留字段说明、登录来源恒为 DB、CDN 已支持媒体等；
- `.env.example`：补齐 8 个缺失变量（config.js 63 个 env 全覆盖）；
- 文档示例昵称改为演示数据（截图仍为旧版，见第 7 节待办）。

### 5.4 第二轮加固修复（本轮，全部带测试）

| ID | 缺陷 | 修复内容 | 验证 |
| --- | --- | --- | --- |
| BA-01 (P1) | SSRF 可被 DNS rebinding 绕过 | `validateTargetUrl` 返回已解析地址；`requestExternal` 改用可注入 `httpRequest`（默认 `node:http/https.request`），连接层 `lookup` 固定已校验 IP；Host 头/TLS `servername` 用原域名；每跳重定向重新校验并重新钉 IP；补齐 gzip/deflate/br 解压上限与半截 body 竞态 | `backend-app-rules-core.test.js` +6（rebinding 首答公网→二次连接私网必须拒绝、重定向到私网/跨源拒绝、正常 mock 链路、gzip、注入锚点）；e2e app-rules 11/11、scheduled-tasks 9/9 |
| BA-02 (P1) | 入站媒体无全局并发/内存上限 | 进程级有界闸门（并发 2 / 排队 64 / 排队超时 60s，可后台配置）；下载+解密改为流式落盘（`.part` 临时文件→原子 rename，内存 O(chunk)）；排队超限/超时记 `attachments.status='failed'` | media-inbound 新增 7 例（闸门、队列饱和、chunked 超限清理、`.part` 清理）；e2e media-flow 7/7 |
| BA-03 (P2) | 共享媒体附件归属错误（删除任一收件人丢失其他人待发媒体） | 入队不再覆盖 `attachments.user_id`；`outbox_id` 仅首次回填；删除用户前检查其他 queued/sending outbox 是否仍引用该 `media_id`，有引用则保留附件行+磁盘文件 | `backend-store.test.js` +3（A/B 共享 mediaId→删 A 后 B 仍可投递；历史脏数据；独占附件仍删） |
| BA-04 (P2) | 优雅退出未等在途任务即关库（重复投递/重复定时/日志丢失） | dispatcher `stop()` 等待在途 processOne（8s 上限、draining 状态、drain 超时后禁写库）；scheduler 记录在途 tick 并在 stop/restart 等待；新增 `store.completeScheduledTaskRun`（日志+next_run 同事务）；index 退出序重排 + 兜底 10s→30s | 新增 `backend-dispatcher.test.js`（3 条，含 drain 超时后不再写库）；scheduler 新增等待在途/restart 用例；e2e push-flow 6/6、media-flow 7/7 |
| BA-05 (P2) | 入站媒体下载未复用 SSRF 防护、默认跟随重定向 | 下载 URL 协议/主机白名单校验（iLink/CDN + `MEDIA_ALLOWED_HOSTS` + `*.qq.com/*.weixin.qq.com`；生产默认拒绝本机/私网）；`redirect:'manual'` 最多 3 跳、每跳复验 | 同 BA-02 的 media-inbound 测试（URL 白名单、302 同源/未授权主机/限跳） |
| BA-08 (P2) | 入站 API/后台消息列表/今日统计全表扫描 | 新增索引 `inbound_messages(received_at, id)`、`inbound_messages(created_at DESC)`、`outbox(created_at DESC)`，通过 `CREATE INDEX IF NOT EXISTS` 启动幂等补齐（无需 schema 版本变更） | 新增 `backend-db-indexes.test.js`（索引存在、EXPLAIN QUERY PLAN 命中、旧库重开补齐） |
| BA-23 (P3) | restoreMonitors 与退出竞态 | 保存 `restorePromise`，退出时先等待；`restoreMonitors` 内部检查 shuttingDown 提前退出 | 随 BA-04 的 index 退出顺序修改；e2e 生命周期回归 |
| F-04 (P2) | 两套编辑器 ~1335 行重复 | 抽 `web/assets/admin/integrations/**` 6 个共享模块（pickers/header-mode/logs-modal/response-section/editor-shell/test-modal）；app-rules.js 1232→927、schedules.js 990→657，公共块 0 重复 | 前端静态测试全绿 + `npm run test:ui`（含真实浏览器深回归：新建规则/任务保存、测试/日志弹窗） |
| F-06 (P2) | 模态框无焦点陷阱/背景 inert | `openModal` 增加 Tab/Shift+Tab 焦点陷阱（最上层弹窗、无可聚焦时留在 dialog）；背景节点 inert+aria-hidden，最后关闭恢复；兼容 `closeAllModals` | `frontend-common-modal.test.js` +2（背景 inert 应用/恢复、Tab 拦截） |
| F-07 (P2) | Tab 组件 ARIA/键盘语义不完整 | 两处 tablist 补 `role=tabpanel`/`aria-labelledby`/`aria-controls`/`id`/roving tabindex；`ui.setupTablist` 支持 ArrowLeft/Right/Home/End | `frontend-pages.test.js` +1 静态契约；`test:ui` 全过 |

另：`npm run coverage` 已加 CI 阈值门禁（line 90 / branch 70 / funcs 85），CI PR 工作流改为跑 coverage（同套测试+阈值），`docker-publish` 构建前跑全量测试；`docs/ARCHITECTURE.md`、`docs/MEDIA.md`、`docs/SETTINGS.md`、`.env.example`、`CHANGELOG.md` 已同步本轮行为与配置项。

### 5.5 第三轮收尾（本轮，全部带测试）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| 后端数据层拆分 | `server/src/store.js` 2126 行/107 导出 → **23 行 façade** + `data/**` 13 文件（按域拆分，导出名零改动）；顺带 BA-16 规则/定时视图 N+1 批量查询、BA-17 今日统计按 `SCHEDULER_TIMEZONE` + `last_poll_at` 每轮更新、BA-10 store 死导出清理 | 全部 store 相关单测 + e2e（inbound/keepalive/groups/media）全绿 |
| 后端共享层解耦（BA-09） | `app-rules.js` ~1744 → **656 行** + `shared/{http-client,template,response,http-execute}.js`；scheduler 不再依赖 app-rules 内部实现，新增独立 `scheduler.maxResponseBytes/allowedHosts`（缺省继承）；模板渲染输出上限（BA-22） | app-rules/scheduler/settings 单测 86/86；e2e app-rules 11/11、scheduled-tasks 9/9 |
| 数据生命周期（BA-18） | 新增 `maintenance.js`：孤儿媒体文件/无文件附件行/超期未入队上传附件 GC、events/规则日志/定时日志保留清理、分批+事务、`PRAGMA optimize`/WAL checkpoint、退出前停止；`MAINTENANCE_*` env + `.env.example` 第十二节 + `docs/UPGRADE.md` §8 | 新增 `backend-maintenance.test.js`；真实进程启动冒烟验证维护首轮执行日志 |
| 剩余 P3 修复 | BA-10 死代码（ilink/monitor）、BA-12 binding 派生常量实时计算、BA-14 mode=none 跨字段校验、BA-15 入站保存失败分类重试/事件、BA-19 绑定 monitor.start 检查、BA-20 v1 paused 语义（409/pausedUserIds）、BA-22 长轮询断开中止、BA-17 `last_poll_at` | ilink 8 / api 17 / binding 6 / monitor 16 全绿；e2e inbound-api、lifecycle-auth 全绿 |
| e2e 稳定性（INF-07） | 子进程 env 白名单构造、负向断言改"稳定基线+观察窗口"（12 处 `expectNoChange`）、e2e 结束统一断言 mock 无协议违规、`terminateApp` 跨平台优雅退出 | 12 个 e2e 文件分 3 批全绿（91 用例）；新增 `backend-index-lifecycle.test.js`（Windows 跳过 2 条 POSIX 用例）、`backend-errors.test.js` |
| 前端 CSS/a11y（F-08/F-16/F-17/F-23） | 颜色 token 提升到 WCAG AA；清理 41 条死规则（style.css 4352→4102）、补齐未定义变量、统一断点 | frontend-pages 57 项全绿；`test:ui` 通过 |
| 截图隐私（INF-08） | 新增 `scripts/screenshots.mjs`（临时 app+mock+演示数据+headless CDP，自动脱敏断言），重新生成 23 张 2.0.0 截图（与 README 引用同名、无真实昵称/本机路径，`npm run screenshots` 可复现） | 连续两次实跑成功；抽查 8 张确认假名数据与最新 UI |
| 工程化（INF-06/10/12/13/15/17/21） | ESLint flat config（CI `--max-warnings=0`，0 error/0 warning）、`.editorconfig`、`.gitattributes` 换行规范、dependabot、`docs/UPGRADE.md`、compose demo 加固、GHCR provenance/SBOM、覆盖率阈值门禁接入发布流程 | `npm run lint` 0 告警；compose config 全绿；37 条 docs 相对链接 0 断链 |

**最终基线**：`npm test` 464 项（462 通过 + 2 项 POSIX-only 在 Windows 跳过，约 35s）；`npm run test:unit` 373 项；`npm run test:e2e` 91 项；覆盖率 line 94.03% / branch 77.17% / funcs 93.82%；`npm run lint` 0 告警；mock 自测 26/26；`npm run test:ui` 全过。

---

## 6. 建议与路线图（意见）

### 6.1 已实施（本轮完成，保留记录）

1. **BA-01 SSRF IP 固定** ✅：`requestExternal` 改为可注入 `httpRequest`，连接层 `lookup` 钉住已校验 IP（Node 未暴露 undici，故用 `node:http/https.request`），每跳重定向重新校验并重新钉 IP；补 rebinding 单测。
2. **BA-02 入站媒体资源上限** ✅：进程级有界闸门（并发 2/排队 64/排队超时 60s，后台可配）+ 流式下载解密落盘（`.part`→原子 rename）；超限/超时记附件失败。
3. **BA-03 共享附件归属** ✅：入队不再覆盖附件 `user_id`；删除用户前检查其他未完成 outbox 引用并保留共享附件。
4. **BA-04 优雅退出** ✅：dispatcher drain + scheduler 在途 tick 等待 + 定时任务"日志+next_run"同事务 + 退出顺序重排（最后关 DB，兜底 30s）。
5. **BA-05 / BA-08 / BA-23** ✅：入站媒体下载 URL 白名单+手动重定向逐跳复验；`inbound(received_at,id)`/`created_at` 索引启动幂等补齐；restoreMonitors 退出竞态修复。
6. **CI 覆盖率门禁** ✅：`npm run coverage` 强制 line 90 / branch 70 / funcs 85；CI PR 跑 coverage，发布前跑全量测试。
7. **F-04 编辑器去重 + F-06/F-07 可访问性** ✅：抽 `admin/integrations/**` 6 个共享模块（两个编辑器各减 300+ 行、公共块 0 重复）；模态框焦点陷阱/背景 inert；Tab 组件 ARIA + 键盘语义。
8. **文档/工程化漂移** ✅：schema 迁移承诺标注历史、CSP/默认值/环境变量/`skipped` 说明、`.env.example` 补齐、CHANGELOG/SECURITY/CI/.nvmrc/.npmrc。
9. **后端数据层拆分** ✅：`store.js` 2126 → 23 行 façade + `data/**` 13 文件，导出名零改动；顺带 N+1、时区统计、死导出清理。
10. **共享层解耦（BA-09）** ✅：`app-rules.js` 1744 → 656 行 + `shared/**` 4 文件；scheduler 独立 `maxResponseBytes/allowedHosts` 配置；模板输出上限。
11. **数据生命周期（BA-18）** ✅：`maintenance.js` 孤儿附件/磁盘文件/日志保留 GC，分批+事务、退出前停止、`MAINTENANCE_*` 文档化。
12. **e2e 稳定性 + 生命周期测试（INF-06/07）** ✅：env 白名单、稳定等待负向断言、mock 违规统一断言；新增 index 生命周期/错误映射/维护测试；Windows 跳过 2 条 POSIX-only 用例。
13. **前端 a11y/CSS + 截图（F-08/F-16/F-17/F-23/INF-08）** ✅：颜色 token 达 WCAG AA、清 41 条死规则、统一断点；`scripts/screenshots.mjs` 用演示数据重生成 23 张 2.0.0 截图（无真实昵称/本机路径）。
14. **工程化（INF-10/12/13/15/17/21）** ✅：ESLint（CI 0 告警）、`.editorconfig`、`.gitattributes`、dependabot、`docs/UPGRADE.md`、compose demo 加固、GHCR provenance/SBOM、覆盖率门禁接入发布流程。

### 6.2 短期（2–4 周，剩余事项）

1. **剩余模块解耦**：`settings.js`（~758 行）拆 schema/validate/apply/secrets，`auth.js` 只依赖 secrets；`scheduler.js` 计划计算与执行分离；`app-rules.js` 引擎再拆 match/extract（当前 656 行已可接受，优先级低）。
2. **前端状态与视图重构**：`state` 按域拆分、`els` 下沉到各视图、`views/app-rules|schedules` 的 editor/test/logs 子模块化；可选动态 `import()` 懒加载非默认视图（当前首屏加载全部视图模块）。
3. **文档值级一致性（doc-lint）**：默认值表由 `config.js`/`SETTINGS_SCHEMA` 校验，`web/docs.html` 与 `docs/*.md` 做反向端点/字段校验；README 质量表由脚本生成或校验。
4. **e2e CI 稳定性证据**：CI 固定 `--test-concurrency` 并连跑 3 次；app 端口改 `PORT=0` + 启动日志回传实际端口（当前 e2e 仍用 getFreePort，存在 TOCTOU 小窗口）。
5. **测试工具链整理（INF-18/19）**：抽 `tests/helpers/unit-env.mjs` 统一单测 mkdtemp/env/cleanup；拆 `e2e-env.mjs`（进程管理 / HTTP 客户端 / 外部 API mock / 媒体工具）；mock e2e 统一 `assertNoRejections()` 已落地，可继续补协议 golden 对照。
6. **可观测性**：overview 统计改单条聚合或 5–10s 缓存；补队列长度、规则执行耗时/失败率、媒体下载并发/内存等指标与结构化事件；IM 级告警。
7. **截图体验**：当前截图为整视口（detail 类下滚 118px 区分），如需更聚焦可做内容裁剪/局部高亮（非功能项）。
8. **依赖与发布**：处理 dependabot PR（Node 镜像 digest、actions SHA、npm devDeps）；README 与 Release 补充版本 tag 策略。

### 6.3 中期（1–2 月，可持续）

1. **文档单一来源**：由代码/契约生成默认值表与端点表，CI doc-lint；`docs/UPGRADE.md` 升级步骤随 schema 变更同步。
2. **发布与仓库卫生**：打 tag + GitHub Release（CHANGELOG 已建立）；截图转 WebP/压缩或外链（当前 23 张约 2.4MB）；历史提交中的旧截图（含旧演示昵称）如需彻底清理需评估重写公开历史的风险。
3. **可观测性与性能基准**：性能基准脚本（消息/队列/媒体吞吐）、慢查询日志、DB 体积与 WAL 监控。
4. **schema 演进工具**：当前"拒绝旧库、只能空库重建"是明确取舍；若用户规模增长，设计一次性导出/导入工具（旧库 → 新库）。
5. **安全纵深**：依赖与镜像定期扫描（SBOM 已产出）、密钥轮换流程文档化、审计日志导出。

### 6.4 需要 Owner 决策的事项

1. **新规则/定时任务默认启用语义**：已按文档契约改为"默认停用"（前端新建立即不勾选、API 未传 `enabled` 时 false）。如果实际产品意图是"默认启用"，应反向统一文档/页面文案并给出显著提示。
2. **入站媒体默认上限**：资源加固后默认仍为 100MB/文件（未下调以避免行为变更）；若部署实例内存有限，建议下调或明确按"并发 2 × 单文件"估算内存模型。
3. **schema 版本策略**：当前"拒绝旧库、只能空库重建"是明确取舍；本轮新增查询索引通过 `CREATE INDEX IF NOT EXISTS` 启动幂等补齐、未改 schema 版本。若后续需要加列/改表，需先决定是否恢复可迁移路径。
4. **APP_SECRET 轮换**：当前运行实例曾出现 `data/admin-password.txt` 缺失告警（旧卷升级场景）；若曾打包/分享过工作区，建议轮换 `APP_SECRET`（代价：已绑定用户需重新扫码）。
5. **公开仓库历史隐私**：截图已用假名演示数据重新生成，但旧截图（含旧演示昵称）仍存在于 git 历史中；若确认为真实用户数据，需按隐私事件处理（重写历史或归档仓库）。
6. **是否引入 Prettier / Playwright 等开发期依赖**：ESLint 已引入并零告警；格式化与浏览器 E2E 是否需要增加 devDependencies 与 CI 时间，由 Owner 决定。

---

## 7. 遗留风险与跟踪建议

| 风险 | 建议跟踪方式 |
| --- | --- |
| `settings.js`/`auth.js` 解耦、前端 state/els 重构 | 下一轮重构任务，按 `docs/review/*.md` 的分步迁移方案执行，每步跑全量测试 |
| e2e 稳定性缺乏 CI 实测证据 | 接入 CI 后连续跑 10 次观察；app 端口改 `PORT=0`+日志回传（当前 getFreePort 仍有 TOCTOU 小窗口） |
| 文档值级漂移 | doc-lint：默认值/端点表由代码与契约生成或校验 |
| 旧库升级路径 | `docs/UPGRADE.md` 已给出备份→空库重建→重新绑定与回滚步骤；如未来需要原地升级再设计导出/导入工具 |
| 入站媒体 100MB 默认上限 × 并发 2 的内存模型 | 部署前按实例内存评估，必要时下调 `INBOUND_MEDIA_MAX_BYTES` |
| 公开仓库历史中的旧截图（旧演示昵称） | 若确认为真实用户数据，需重写公开 git 历史或归档；当前新截图已脱敏 |
| 生产实例尚未部署本次改动 | 本次已在本地 `docker build` + 容器冒烟验证；部署步骤与回滚见交付说明 |

---

## 8. 附录

### 8.1 验证命令

```bash
npm ci
npm test                 # 464 项（unit + e2e，462 通过 + 2 项 POSIX-only 跳过），约 35s
npm run test:unit        # 需要快速回归时（373 项）
npm run test:e2e
npm run test:ui          # 浏览器冒烟（需本机 Edge/Chrome，无则跳过）
npm run coverage         # in-process 覆盖率 + CI 阈值（line 90 / branch 70 / funcs 85）
npm run lint             # ESLint（CI --max-warnings=0）
npm run screenshots      # 用演示数据重新生成 README 截图（可选，需浏览器）
node mock/selftest.mjs   # mock 协议自测 26 项
docker compose config    # 校验 3 份 compose（demo 需 --profile demo）
```

### 8.2 审查明细报告索引

| 报告 | 内容 | 问题数 |
| --- | --- | --- |
| `docs/review/backend.md` | `server/src` 全部 19 模块：模块边界、重复、正确性、安全、性能、契约漂移；含拆分方案与回归方式 | 23（P1 2 / P2 7 / P3 14） |
| `docs/review/frontend.md` | `web/**`：架构与拆分方案、重复量化、正确性/竞态、a11y、CSS、测试改造映射 | 29（P1 1 / P2 7 / P3 21） |
| `docs/review/infra.md` | 测试/ mock / Docker / CI / docs 一致性：基线实测、覆盖映射、部署链路、仓库卫生 | 24（P1 1 / P2 10 / P3 13） |

> 说明：以上报告为审查时点快照（基于重构前 HEAD `a23c2be` 的行号）；其"问题"本身在重构后依然成立（重构为等价搬迁），行号可按新模块结构重新定位。
