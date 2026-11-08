# 前端代码审查报告

## 0. 方法与基线

- **审查范围**：`web/**` 全部 8 个文件（3 个 HTML + 4 个 JS + 1 个 CSS），只读审查。
- **基线**：`HEAD=a23c2be refactor(admin): 新建规则/任务共用请求、响应与模板表单模块`；审查期间 `web/**` 无改动（工作区其他改动来自并行任务，与本报告无关）。
- **实测行数**（read 工具行号口径，含文件末尾换行差异）：`admin.js 5895`、`common.js 1023`、`bind.js 551`、`docs.js 187`、`style.css 4352`、`admin.html 474`、`index.html 182`、`docs.html 1623`；`web/**` JS 合计约 7656 行 / 289 KB。
- **方法**：全文 read 通读（admin.js 分 9 段读完）+ 定向 grep + 只读 Node 分析脚本（CSS 选择器/变量/断点统计、死选择器与 HTML/JS class token 交叉比对、admin.js 行级/规范化后重复度统计、函数长度分布）+ 与 `server/src/api.js`、`app-rules.js`、`store.js` 的契约/默认值交叉验证 + WCAG 对比度计算。**没有运行浏览器、没有跑 npm test**。
- **交叉验证结论**：admin.js 的 50 处 `apiFetch(...)` 路径与 server 路由逐条比对，**未发现前后端路径/方法不匹配**；`/bind` 302、CSP 约定、`/health` 均符合 `docs/ARCHITECTURE.md` §8/§9。
- **测试基线**：`tests/unit/frontend-pages.test.js` 共 51 个 test（1497 行），本报告第 6 类结论均引用其行号。
- **限制**：未做真实浏览器/读屏器验证，涉及视觉、焦点行为、性能的结论来自源码与静态推导；个别标注"待验证"的条目已明确说明。

## 1. 结论摘要

| 严重度 | 数量 | 说明 |
| --- | --- | --- |
| P0 | 0 | 无 |
| P1 | 1 | 新建规则/定时任务默认启用，与 `docs/API_RULES.md` 及 admin 页面文案相反，可意外触发外部接口与微信推送 |
| P2 | 7 | 会话过期清理泄漏、单文件/全局状态耦合、编辑器大面积重复、测试文本断言阻断拆分、三类 a11y 缺陷 |
| P3 | 21 | 竞态、死代码、CSS 死规则/未定义变量、文档漂移、性能与一致性问题 |

总体评价：安全基线做得相当扎实——没有任何 `innerHTML/outerHTML/eval`，所有动态数据走 `textContent`/DOM 属性，URL 全量白名单校验，CSP 无内联脚本/事件，401 统一跳转，前后端 API 契约完全对齐；这套约束由 51 个静态测试守住，是本项目最大资产。主要风险不在"会不会被攻破"，而在**可维护性**：`admin.js` 5895 行单文件包含 171 个函数、7 个视图、两套近千行的编辑器，重复代码比例高（全局非平凡行重复 24.9%，定时编辑器 42.5% 的行与规则编辑器逐字相同），而静态测试又以源码文本作为契约，使拆分与测试互相锁死。功能层面已确认 1 个 P1 语义错误（默认启用）、1 个 P2 会话过期清理缺陷，以及多处"文档/UI 承诺与实际行为不一致"的漂移。建议按"先改测试、再拆模块、最后清理 CSS"的顺序推进；Lead 已有的 headless Edge smoke（`scripts/frontend-smoke.mjs`，按 Lead 说明覆盖登录+7 视图+CRUD+编辑器+登出）可作为拆分后的端到端回归手段。

## 2. 详细问题清单（按严重度排序）

### F-01 [P1] 功能/一致性：新建规则与定时任务"默认启用"与文档、页面文案相反

- **位置**：`web/assets/admin.js:1587-1591`、`web/assets/admin.js:2281`、`web/assets/admin.js:2894-2898`、`web/assets/admin.js:3401`；`web/admin.html:291-293`、`web/admin.html:327-330`；`docs/API_RULES.md:22`；`server/src/api.js:583-587`、`server/src/api.js:780-784`。
- **证据**：新建规则/任务时 `checked: isEdit ? source.enabled === true : true`（新建立即勾选"启用"），提交 payload 为 `enabled: enabledInput.checked`；server 在未传 `enabled` 时也默认 `true`（`patch.enabled = body.enabled === undefined ? true : body.enabled`）。而 `docs/API_RULES.md:22` 明确"规则**默认不启用**"，`admin.html:292` 写"规则默认不启用"、`admin.html:329` 写定时任务"默认不启用，建议先测试运行再启用"；`docs/SCHEDULED_TASKS.md:248` 也建议"默认可先建一条 disabled 任务"。另 `docs/API_RULES.md:30` / `docs/SCHEDULED_TASKS.md:24` 的 schema 又是 `enabled INTEGER NOT NULL DEFAULT 1`，文档本身自相矛盾。
- **影响**：管理员按页面/文档提示"先建草稿再测试"时，实际创建的是**立即启用**的规则/定时任务：定时任务会被调度器真实调用外部接口并向用户推送微信消息，规则会在下一条匹配消息时执行。属于"承诺与行为相反"的功能错误，可能造成意外外部调用与消息打扰。
- **建议**：由 Lead 确认目标语义；若以文档为准：新建表单默认 `checked: false`（编辑保留原值），并把 `docs/*.md` 与 schema 注释统一；若以 schema 为准：修正 `docs/API_RULES.md:22`、`docs/SCHEDULED_TASKS.md:16/248`、`admin.html:292/329` 文案，并在表单上加"创建后立即启用"的显著提示。二者必须同 commit。
- **工作量**：S。

### F-02 [P2] 正确性：会话过期时未跟踪的 `confirmDialog` 泄漏 Promise / `openModalCount` / 页面滚动锁

- **位置**：`web/assets/common.js:534`、`web/assets/common.js:549-678`、`web/assets/common.js:684-715`；`web/assets/admin.js:483-492`、`web/assets/admin.js:5868-5880`；`web/assets/style.css:2728-2730`。
- **证据**：`openModal` 维护模块级 `openModalCount`，仅在 `close()` 或 `onClose` 链路中递减（`common.js:606-624`）；`body.modal-open { overflow:hidden }`（`style.css:2728-2730`）。后台所有弹窗都经 `openTrackedModal` 登记到 `openModals`，**唯独 `confirmDialog`（11 处调用）在 `common.js:700` 直接 `openModal(...)`，不在跟踪集合中**。会话过期时 `showLogin` 先关闭跟踪弹窗（`admin.js:483-490`），再 `document.querySelectorAll('.modal-backdrop')` 直接 `remove()`（`admin.js:491-492`）——confirm 弹窗 DOM 被移除但从未 `close()`，其 Promise 永远不 resolve，`openModalCount` 保持 1，且 `document.addEventListener('keydown', onKeydown)` 永不注销。
- **影响**：1) 确认框打开时收到 401（如删除/解绑过程中会话恰好过期），对应业务函数永久挂起；2) 重新登录后任意弹窗关闭时 `openModalCount` 只从 2 减到 1，`body.modal-open` 永不移除，**页面无法滚动**，需刷新；3) 每次会话过期泄漏一个 keydown 监听。
- **建议**：让 `common.js` 暴露 `closeAllModals()`（或在 `openModal` 内部维护活动弹窗 Set），`showLogin` 只调用该 API，不再手工 `remove()` DOM；`openModalCount` 改为从 Set 派生。附回归：可在 smoke 中模拟 401 + confirm 打开路径。
- **工作量**：S。

### F-03 [P2] 架构：`admin.js` 5895 行单文件 + 全局 `state`/`els` 深耦合

- **位置**：`web/assets/admin.js:117-151`（单一 `state`）、`web/assets/admin.js:153-241`（89 条 `els` DOM 引用）、`web/assets/admin.js:5894-5895`（TDZ 注释 + 末尾 `init()`）。
- **证据**：单文件 5895 行、171 个顶层函数、`apiFetch` 50 处、`formField` 29 处、`openTrackedModal` 14 处、17 个 `render*`、11 个 `load*`；`state` 一个对象同时承载会话/路由/用户/消息/分组/规则/定时/配置/设置 8 类互不相关状态；`els` 集中缓存 89 个 DOM 节点，任何模块改动都要读全局表。文件末尾注释自述"等所有顶层 const/let 初始化后再 init"——这是无模块边界、靠人工顺序规避 TDZ 的直接证据。
- **影响**：1) 任何视图改动都可能影响其他视图（共享可变状态、共享 `els`）；2) 无法按视图 code-split，首屏必须解析 234KB JS；3) 测试只能靠文本断言锁定内部结构（见 F-05）；4) 新人/并行开发冲突面极大。
- **建议**：见第 3 节拆分方案；优先把 `state` 按域拆成只读导出 + action 的 store，`els` 下沉到各视图根节点查询；`init` 收敛为 entry 唯一调用点。
- **工作量**：L（分阶段 M×5~6，见 §3）。

### F-04 [P2] 重复代码：规则编辑器 vs 定时任务编辑器 ~1335 行，规范化后重复度 52%~94%

- **位置**：`web/assets/admin.js:1563-2330`（`openAppRuleEditor` 768 行）、`web/assets/admin.js:2868-3434`（`openScheduleEditor` 567 行）；配套 `web/assets/admin.js:2365-2431`/`3436-3473`（测试弹窗）、`2531-2646`/`3548-3677`（日志弹窗）、`2433-2503`/`3475-3515`（测试结果渲染）。
- **证据**（只读脚本量化；"规范化"= 去缩进 + 统一大小写 + `rule/schedule/规则/任务/headerMode` 同义替换后的行级比对）：

  | 对比块 | 规则侧 | 定时侧 | 定时侧非平凡行 | 规范化后逐行相同 | 比例 |
  | --- | --- | --- | --- | --- | --- |
  | Header 模式块（掩码/重设/清空） | 1928-1988 | 3141-3201 | 42 | 39 | **93%** |
  | Header 提交校验 | 2250-2271 | 3372-3391 | 16 | 15 | **94%** |
  | 用户/分组选择器 | 1644-1709 | 3009-3074 | 41 | 35 | **85%** |
  | 响应类型/JSON 路径输入 | 1991-2018 | 3204-3231 | 19 | 16 | **84%** |
  | 保存按钮 action 骨架 | 2183-2320 | 3328-3433 | 71 | 37 | 52% |
  | 日志弹窗（筛选/分页/表格/加载） | 2531-2646 | 3548-3677 | 80 | 54 | 68% |
  | 测试弹窗 | 2365-2431 | 3436-3473 | 21 | 16 | 76% |

  另有全文件层面的重复：3315 条非平凡行中 826 行（24.9%）出现在重复行组里；`switch` 构建器 4 份（`buildGroupKeepaliveSwitch` 889-908、`buildRuleSwitch` 1051-1067、`buildScheduledSwitch` 2722-2738、`buildKeepaliveSwitch` 4084-4102，另有设置布尔控件 5087-5102 为第 5 份）；行操作按钮工厂 4 份（910-917、1146-1153、2795-2802、4124-4132）；表点击分发 4 份（919-929、1155-1167、2820-2833、4134-4148）；`confirmDialog({...})` 11 处；`openTrackedModal({...})` 14 处。最近一次 commit a23c2be 已抽出 `buildRequestRow/buildResponseRow/buildHeaderListField/buildTemplateTools`（`admin.js:1198-1257`），但只覆盖约 54 行，剩余重复仍以千行计。
- **影响**：改一处 Header 逻辑需同步改两处（历史上必然已出现行为漂移风险）；两套校验/两套字段 id 易不一致；测试被迫用"计数恰好为 2"的文本断言锁死（F-05）。
- **建议**：抽 `admin/integrations/form-kit.js`：`buildHeaderModeField()`、`readHeaderPayload()`、`buildPickerSection()`、`buildResponseSection()`、`buildTimeoutField()`、`buildSaveAction()`；两个编辑器只保留各自的展示差异（计划/目标/触发范围）。目标：两个编辑器各 ≤120 行，公共块 0 重复。测试对应改为引用模块文件的 token 断言或行为测试。
- **工作量**：M。

### F-05 [P2] 测试：`frontend-pages.test.js` 以 `admin.js` 源码文本为契约，阻断拆分

- **位置**：`tests/unit/frontend-pages.test.js:391-409`、`:1334-1342`、`:1441-1466`、`:965-996`、`:1372-1387`、`:1489-1495` 等。
- **证据**：`readAsset('admin.js')` 直接出现 **23 次**；约 **24 个 test** 使用 `admin.includes(...)`/`admin.match(...)` 断言内部函数名、中文文案、模板字符串片段（如 `buildRequestRow`、`openRuleLogsModal`、`buildTemplateTools`、`syncHeaderModeUi`）。其中 3 处是**精确计数**断言：`count(/function syncHeaderModeUi\(\)/g) === 2`（965-996）、`(admin.match(/closeOnBackdrop: false/g)).length === 2`、`(admin.match(/setHidden\(bodyField, methodSelect\.value !== 'POST'\)/g)).length === 2`（1372-1387）；`admin.js` 必须"末尾恰好一个顶层 `init();` 且其后无顶层 const/let"（1334-1342）；4 个 JS 文件必须文本包含 `initSidebarDrawer`、不得出现 `matchMedia/innerWidth`（1441-1466）；innerHTML 禁用只扫描**硬编码的 4 个文件**（391-409）。
- **影响**：一旦把任何被断言的函数/文案移出 `admin.js`，测试立即红；精确计数断言会阻止"合并重复"；新模块不会被 innerHTML/设备判断/外部 URL 检查覆盖（安全/一致性网出现缺口）。
- **建议**：先改测试再拆（见 §3.3）。最少改动：`readAssetAll()` 递归读 `web/assets/**/*.js` 拼接用于"存在性"断言；精确计数断言改为指向具体模块文件或改行为测试；innerHTML/无设备判断扫描改为 glob 全量；新增"import 路径存在"与"模块无环"测试；保留 `admin.js` 末尾 `init()` 约束作为 entry 契约。
- **工作量**：M（测试改动约 150-250 行）。

### F-06 [P2] 无障碍：模态框没有焦点陷阱 / 背景未 inert，焦点可逃逸

- **位置**：`web/assets/common.js:549-678`（`openModal`）、`:560`（保存 previousFocus）、`:669-675`（打开 30ms 后聚焦第一个可聚焦元素）。
- **证据**：全仓 grep `inert` / `trapFocus` 无命中；`openModal` 只设置 `role="dialog" aria-modal="true"`、Esc 关闭、关闭时恢复焦点，但 Tab/Shift+Tab 可把焦点移到遮罩后的页面内容；背景节点未设置 `aria-hidden`/`inert`。`document.querySelectorAll('input:not(...)')` 只用于初始聚焦。
- **影响**：键盘与读屏用户可操作到弹窗背后的视图；打开"新建规则/定时任务"这类超长表单时尤为明显。
- **建议**：`openModal` 内实现 Tab 循环（收集 `dialog` 内可聚焦元素，首尾环绕）；打开时对 `document.body` 其余顶层节点 `inert`（现代浏览器支持），关闭时恢复；焦点集合动态变化（如 picker 重渲染）时实时计算。附 a11y 手动清单。
- **工作量**：S。

### F-07 [P2] 无障碍：Tab 组件 ARIA/键盘语义不完整

- **位置**：`web/admin.html:217-220`（消息方向 tablist）、`web/admin.html:295-298`（规则/定时 tablist）；`web/assets/admin.js:4704-4714`（`setMessageDirection`）、`web/assets/admin.js:2509-2525`（`setRuleTab`）。
- **证据**：`role="tablist"`/`role="tab"`/`aria-selected` 存在，但两个 tab 面板都没有 `role="tabpanel"`、没有 `aria-controls`，tab 也没有 `aria-controls`/`id`/`tabindex` roving；JS 只切换 class 与 `aria-selected`，无 ArrowLeft/ArrowRight/Home/End 键盘处理（grep 无 keydown 相关 tab 逻辑）。
- **影响**：读屏器无法建立 tab→panel 关联；键盘用户必须 Tab 穿过两个 tab，不符合 WAI-ARIA Tabs 模式。
- **建议**：面板加 `role="tabpanel"` + `aria-labelledby`，tab 加 `id`/`aria-controls`，实现 roving tabindex 与方向键；或者降级为普通按钮组（去掉 tab 角色）以避免错误语义。两处统一抽 UI helper。
- **工作量**：S。

### F-08 [P2] 无障碍：关键文字/主按钮颜色对比度不足 WCAG AA

- **位置**：`web/assets/style.css:19`（`--text-muted: #8b95a5`）、`:494-497`（`.form-hint` 使用该变量）、`:7`/`:549-553`（`--wechat-green` + `.btn-primary { color:#fff }`）、`:3074-3077`（`.menu-item.is-active` 绿色文字）。
- **证据**（WCAG 2.x 公式计算）：`#8b95a5` on `#ffffff` = **3.03:1**、on `#f5f7fa` = 2.82:1（正文要求 4.5:1）；白字 on `#07c160` = **2.38:1**（大号加粗文本也只要求 3:1，仍不达标）；`.menu-item.is-active` 同色系更差。`--text-muted` 被 `.form-hint`、`.cell-muted`、`.kv-label`、`.footer-version` 等大量使用。
- **影响**：低视力/强光环境下提示文字、主按钮文字难辨认；属于可验收的无障碍缺陷。
- **建议**：把正文级 muted 调深（如 `#5b6675`/`#6b7280`，目标 ≥4.5:1）；主按钮改用 `--wechat-green-dark #06ad56`（3.2:1）或加深到 `#059649`（约 3.9:1）并把按钮文字加粗/≥18.66px，或采用深绿底；在 `:root` 注释标注每个 token 的最低对比度。改 CSS 时注意测试对 `#07c160` 字面量的断言（`frontend-pages.test.js:417`）。
- **工作量**：S。

### F-09 [P3] 竞态：所有列表 loader 没有请求序号/AbortController，旧响应可能覆盖新筛选

- **位置**：`web/assets/admin.js:3975-4003`（`loadUsers` 在 await 后直接写 `state.users`）、`4716-4726`（`loadMessages`）、`790-795`（`loadGroups`）、`5044-5078`（`loadSettings`）；调用方 `562-598`、`666-679`、`303-317` 等。
- **证据**：`apiFetch` 50 处调用均无 `signal`（`common.js:85-167` 支持 `signal` 但无人使用）；筛选/搜索/分页/5s 轮询可并发；响应按到达顺序写全局 state 并全量重渲染，无"当前查询 token"比对。
- **影响**：快速切换筛选（尤其"未分组"要拉 500 条，见 F-24）时，慢的旧响应可能覆盖新结果，页面短暂显示错误筛选数据；下一次轮询（≤5s）会自愈，故非持久错误。
- **建议**：每个 loader 维护 `reqSeq`（或 AbortController）并在写 state 前校验；抽 `loadList()` 通用封装。配合 F-10 的请求去重。
- **工作量**：S/M。

### F-10 [P3] 架构：`state.viewLoaded` 是死状态；切换视图重复全量拉取；无 JS 级别懒加载

- **位置**：`web/assets/admin.js:121`（声明）、`web/assets/admin.js:619`（唯一写点 `state.viewLoaded.add(viewId)`）；`web/assets/admin.js:601-627`（`loadView`）。
- **证据**：全仓 grep `viewLoaded` 仅这两处，**从未被读取**——没有"已加载则跳过/缓存"逻辑；每次 `showView`（569-598）都会重新拉取该视图全部接口（users 视图 2 个请求、config 视图 2 个）。全仓无 `import(` 动态导入；admin.js 一次性加载全部 7 个视图代码。
- **影响**："懒加载"只做在数据层且每次都重来；首屏解析 234KB JS；切换视图有重复网络请求；命名与实际语义不符，误导后续维护。
- **建议**：要么实现按视图 TTL 缓存（并记录 `loadedAt`），要么删除该状态；拆分后可对非默认视图用 `import('./views/x.js')` 按需加载。
- **工作量**：S（删）/M（实现缓存 + 懒加载）。

### F-11 [P3] 功能：消息页的分组徽章依赖用户视图缓存，深链直达时缺失

- **位置**：`web/assets/admin.js:135`（`userGroupMap`）、`:3967-3973`（仅 `loadUsers` 构建）、`:609-610`（messages 视图只 `loadGroups()+loadMessages()`）、`:4852-4866`（`resolveMessageGroups`）。
- **证据**：`resolveMessageGroups` 优先读 `state.userGroupMap`，该 Map 只在 `loadUsers` 成功时更新；直接打开 `/admin#/messages`（或刷新后停留在消息视图）时从未调用 `loadUsers`，Map 为空，只有"按分组筛选时"用 `state.messages.groupId` 兜底显示 1 个徽章。
- **影响**：消息记录页的分组徽章在深链/刷新场景下缺失，与用户视图进入后的表现不一致；ARCHITECTURE §13 要求消息行展示分组徽章。
- **建议**：消息接口若返回用户 groups 则直接用（server 已在 `listMessages` 关联，见 GROUPS_AND_INBOUND 契约）；否则 messages 视图加载时并行 `loadUsers`（或提供 groupId→users 反向缓存）。
- **工作量**：S。

### F-12 [P3] 功能：`mediaLimits` 只在 config 视图加载；未加载时 413 文案显示"0 B"

- **位置**：`web/assets/admin.js:139`（`mediaLimits`）、`:4946-4952`（仅 `loadConfig` 写入）、`:4164-4166`（发送弹窗读取）、`:4260-4264`（413 文案 `formatFileSize(maxBytes)`）。
- **证据**：`maxBytesKnown` 为 false 时发送前不做大小校验，服务端返回 413 时 `formatFileSize(0)` 输出 `0 B`，于是提示"附件超过大小上限（0 B）"；隐藏风险：若从未打开运行配置页，客户端完全不提示上限。
- **影响**：误导性错误提示；用户需先访问"运行配置"才获得正常体验。
- **建议**：`openSendMessageModal` 打开时若无 `state.mediaLimits` 先 `loadConfig()`（或把 media 限制并入 `/api/admin/overview`/`/me`）；413 文案在未知上限时用"服务端限制"而非 0 B。
- **工作量**：S。

### F-13 [P3] HTML：分组表空状态 `colspan=4` 与 5 列表头不一致

- **位置**：`web/assets/admin.js:802-804`（`emptyRow(4, ...)`）；`web/admin.html:199-203`（分组表 5 个 `<th>`：分组/描述/用户数/保活/操作）。
- **证据**：`emptyRow(colspan, text)` 生成 `<td colspan="4">`，但表头 5 列；其余四张表（users 8、messages 6、rules 7、schedules 7）与 colspan 均一致，仅分组表错 1 列。
- **影响**：空状态单元格不铺满整行，出现一列空白；小屏视觉明显。
- **建议**：改为 `emptyRow(5, ...)`，并给 `emptyRow` 增加单测/静态检查（表格 th 数与 colspan 映射）。
- **工作量**：S。

### F-14 [P3] 一致性：自动刷新覆盖范围与页脚/架构文档不符；定时通知 Tab 不随 5s 刷新

- **位置**：`web/assets/admin.js:105-115`（`MENU_VIEWS` 中只有 overview/users/messages/app-rules `live:true`）、`:666-679`（轮询只刷新当前 live 视图）、`:613-614`（app-rules 视图只加载规则，不加载定时任务）、`:2522-2524`（只有点击"定时通知"Tab 时才加载任务）；`web/admin.html:464`（页脚"当前视图每 5 秒自动刷新（页面隐藏时暂停）"）；`docs/ARCHITECTURE.md:278`（"后台数据 5s"）。
- **证据**：groups/broadcast/config 3 个视图不自动刷新，但页脚与架构文档没有区分；停留在"定时通知"Tab 时自动刷新只更新规则列表，上次/下次执行时间不会刷新。
- **影响**：用户对刷新行为预期错误（以为数据在刷新其实不会）；定时任务列表数据陈旧。
- **建议**：页脚文案改为"实时视图每 5 秒自动刷新"并列出范围；或在 `loadView('app-rules')` 内按当前 tab 同时加载对应数据（把 `state.ruleTab` 真正用上）；同步更新 `ARCHITECTURE.md` §9。
- **工作量**：S。

### F-15 [P3] 死代码/死状态：`openDrawer/toggleDrawer`、`state.ruleTab`、`escapeHtml` 等

- **位置**：`web/assets/admin.js:650-660`（`openDrawer`/`toggleDrawer` 定义后无调用，仅 `closeDrawer` 被用）、`:129`+`:2511`（`state.ruleTab` 只写不读）、`:2430`（`void modal;` 无用）；`web/assets/common.js:337-340`（`setText` 导出未使用）、`:346-361`（`escapeHtml` 导出未使用，且注释称"兜底使用"但项目策略禁止 innerHTML）、`:398-402`（`formatDate` 仅内部使用、导出无外部引用）。
- **证据**：只读 grep（token 边界）确认：`openDrawer`/`toggleDrawer` 仅定义行；`viewLoaded` 仅写；`escapeHtml`/`setText` 在 admin/bind/docs 中 0 引用；`ruleTab` 只出现在声明与赋值；`void modal;` 在 `openAppRuleTestModal` 结尾。
- **影响**：误导维护者（"看起来有懒加载/HTML 转义能力"），增加审查成本；`escapeHtml` 与"禁止 innerHTML"策略冲突，可能诱导未来绕过静态测试。
- **建议**：删除死代码；如果未来确实需要 HTML 字符串渲染，先在 `el()` 内禁止 `innerHTML` 键名并补测试，再移除 `escapeHtml`。
- **工作量**：S。

### F-16 [P3] CSS：43 条死选择器约 300 行；章节编号重复；分组编辑器被归入"定时通知"章节

- **位置**（死选择器代表）：`style.css:163-251`（`.site-header/.site-header-inner/.site-nav/.nav-link*`）、`:265-270`（`.container-wide`）、`:689`/`:701`（`.media-preview-thumb-video/.media-preview-video`）、`:1242`（`.config-subtitle`）、`:1268-1302`（`.radio-item*`）、`:1407-1432`（`.rule-form-grid-4/.rule-inline-row/.rule-inline-check`）、`:1844`/`:2855-2859`（`.admin-topbar*`）、`:1875-1883`（`.section-block/.section-head`）、`:2222`/`:2412`/`:2924`（`.docs-layout`）、`:2271`/`:2313-2320`/`:4016`（`.doc-nav-sub/.doc-subsection/.doc-heading-nested`）、`:2790`（`.modal-user`）、`:3350`（`.schedule-header-mask`）、`:3672`（`.rule-control-align`）、`:3814-3867`（`.docs-topbar-actions*`）、`:3116-3121`（`.sidebar-version`，HTML 实际用 class `footer-version`）。章节编号：`:2845-2847` 与 `:3004-3006` 都是"12."。分区错位：`:2648` "定时通知"章节包含 `openGroupEditor`（admin.js:3679）与 `openUserGroupsModal`（3835）。
- **证据**：只读脚本把 CSS 选择器 class token 与 `web/*.html` + `web/assets/*.js` 中出现的 class token 做精确比对：**43 条规则只含死 class，约 301 行**（已排除 `toast-*/modal-wide/modal-narrow/kv-value-*` 这类动态拼接 class）；`page-docs` 测试本身也断言旧 class 不应出现在 HTML（`frontend-pages.test.js:1415-1416/1437-1438`），但 CSS 仍保留。
- **影响**：CSS 体积与认知负担；旧样式与现役样式交叉（如 `.section-head` vs `.section-head-actions`）容易改错；测试第 1370 行反而**要求保留**死规则 `.admin-topbar .topbar-actions`，形成"测试锁死死代码"。
- **建议**：分两批删（先删无测试引用的 40 条，再处理被测试引用的 3 条并同步改测试）；删前用浏览器 smoke 走 3 个页面/窄屏；给 CSS 加"仅保留 HTML/JS 实际使用 class"的静态检查脚本（可作为新测试）。
- **工作量**：M。

### F-17 [P3] CSS：未定义变量 `--text-primary`、未使用 token、硬编码颜色

- **位置**：`web/assets/style.css:4171`、`:4194`、`:4312`、`:4332`、`:4346`（`color: var(--text-primary)` 但 `:root` 未定义，`:root` 见 `:6-52`）；`:20`（`--text-inverse` 未使用）、`:29`（`--warning-line` 未使用）、`:40-42`（`--shadow` 未使用）；98 处硬编码色（root 之外 93 处 hex + 19 处 rgba）。
- **证据**：只读脚本统计：35 个变量定义、34 个被使用、2 个被引用但未定义（`--text-primary`、带 fallback 的 `--link` 不算问题）、3 个定义未使用；`var(--text-primary)` 所在 5 条声明会被浏览器判为 invalid at computed-value time，颜色回退为继承值。
- **影响**：模板预览/帮助区域文字颜色与设计意图不符（可见但非预期）；token 体系不完整，后续主题化困难。
- **建议**：补 `--text-primary: var(--text)` 或改成 `--text`；删除未使用 token 或真正用于 `box-shadow`；逐步把组件内硬编码色收敛到 token（可先只处理重复出现的前 10 个色值）。
- **工作量**：S。

### F-18 [P3] 结构/文档漂移：三页共享壳实为两套；favicon/品牌 SVG/头部重复

- **位置**：`web/admin.html:16-82`（`.admin-sidebar`/`.admin-topbar-bar`）vs `web/index.html:15-50` + `web/docs.html:15-68`（`.doc-sidebar`/`.docs-topbar`）；重复字面量：`web/admin.html:10`、`web/index.html:9`、`web/docs.html:9`（favicon data URI 499 字节 ×3）、三个页面 brand SVG 436 字节 ×3；`docs/ARCHITECTURE.md:266-268`（"后台、文档页、首页使用同一套侧栏/顶栏壳与共享 initSidebarDrawer"）。
- **证据**：只读统计：三个 HTML 有 35 行长行完全重复 ≥3 次；index 与 docs 共享 19 行长行壳；admin 与 public 页的抽屉按钮 CSS 规则近乎相同（`.admin-menu-toggle` 3161-3179 vs `.docs-menu-toggle` 3721 附近）。共享的只是 `initSidebarDrawer` 行为，DOM/CSS 是两套。
- **影响**：ARCHITECTURE §9 描述与实现不符；两套壳导致样式/交互修复需双改（例如 focus 样式、移动端断点）；favicon/品牌 SVG 三处手写，改品牌要改 3 个文件。
- **建议**：更正 §9 表述为"行为统一、DOM/CSS 两套"；或抽 `web/assets/shell.css` + 统一 class 前缀，把 `.admin-*`/`.doc-*` 合并；favicon/品牌 SVG 保持零构建可接受重复，但建议在文档注明"三处同步修改"（或用一个 JS 注入 SVG symbol，代价是首屏闪烁）。
- **工作量**：S（改文档）/M（统一壳）。

### F-19 [P3] 交互：编辑器 Esc 可关闭丢输入；`openModal` 30ms 聚焦定时器有竞态

- **位置**：`web/assets/common.js:626-631`（Esc 只要 `dismissible && !busy` 就关闭）、`web/assets/admin.js:2178-2182`（规则编辑器 `closeOnBackdrop:false` 但未设 `dismissible:false`）、`:3323-3327`（定时编辑器同）；`common.js:669-675`（`setTimeout(...,30)` 聚焦）。
- **证据**：`closeOnBackdrop:false` 只阻止点击遮罩；X 按钮与 Esc 仍直接关闭，长表单（规则编辑器 768 行 DOM）无未保存提示；30ms 定时器在弹窗被快速关闭/移除后仍可能执行 `firstFocusable.focus()`（元素可能已脱离文档，浏览器一般无副作用，但属竞态写法）。
- **影响**：误按 Esc 丢失已填写内容；极端情况下焦点跳到即将消失的元素。
- **建议**：规则/定时编辑器传 `dismissible:false`，关闭按钮走"确认放弃修改"（`onClose` 或自定义 header 按钮）；聚焦定时器保存 timer id，`close()` 时 `clearTimeout`。
- **工作量**：S。

### F-20 [P3] 交互：多处弹窗在 await 数据后才打开，无 loading 且可重复点击

- **位置**：`web/assets/admin.js:2868-2884`（`openScheduleEditor` 先 `await loadPickerUsers()` 再建弹窗）、`:2365-2371`（`openAppRuleTestModal`）、`:3548-3555`（`openScheduleLogsModal`）。
- **证据**：`openScheduleEditor` 是 async，点击"新建任务"后至少等待一次 `/api/admin/users?...limit=500`；等待期间按钮无 disabled/loading，用户可再次点击 → 两次 await 完成后叠加两个同一标题 modal（`openTrackedModal` 都会登记），Esc 只能关最上层；慢网络下表现为"点了没反应"。
- **影响**：重复弹窗、交互卡顿、误操作。
- **建议**：同步打开 modal 骨架（"正在加载用户…"）后再异步填充，与 `openAppRuleEditor`/`openUserGroupsModal` 已采用的模式一致；或在入口处加"打开中"禁用锁。
- **工作量**：S。

### F-21 [P3] 绑定页：每秒写 sessionStorage + 每秒重建倒计时；token 在 query 的日志暴露面

- **位置**：`web/assets/bind.js:264-301`（每次轮询成功 `persistSession()`）、`:512-531`（JSON.stringify 写 sessionStorage）、`:335-349`（`renderQr` 每次轮询都 `startCountdown`）、`:351-413`（`applyStatus` 再次 `startCountdown`）、`:482-506`（`startCountdown` 先 `stopCountdown` 再 `setInterval`）；`:269-271`（`?token=` 查询参数，`docs/API.md:54` 契约如此）。
- **证据**：等待扫码期间 1s 轮询，每次成功都会 JSON 序列化 session 并写 sessionStorage，并重建一次 1s interval（`renderQr`→`startCountdown`，随后 `applyStatus` 再重建一次）；`sessionStorage` 中保存了 `token` 与 `qr.svg`。`server/src/api.js:1877` 错误处理器记录 `req.originalUrl`（含 query token），虽仅错误路径且 `logger` 对敏感*键*脱敏、不脱敏 URL 字符串。
- **影响**：低端机/隐私模式下的无谓 IO 与定时器抖动（功能正确，属性能/电量）；若绑定接口错误进入服务端错误日志，session token 可能随 URL 落盘（需服务端确认日志级别与脱敏范围，**待验证**生产环境是否记录 debug 请求）。
- **建议**：仅当 `sessionId/status/qr` 变化时持久化；`startCountdown` 加"expiresAt 未变则复用"判断；服务端对 `/api/bind/sessions/:id` 的 `originalUrl` 做 token 参数脱敏（建议 `logger` 层支持 URL 查询串脱敏）。
- **工作量**：S。

### F-22 [P3] 性能/无障碍：实时视图 5s 全量重渲染，表格焦点/滚动位置丢失；规则/任务/分组列表无分页

- **位置**：`web/assets/admin.js:666-679`（轮询 `loadView`）、`:797-807`/`:1015-1029`/`:2707-2720`/`:4005-4020`/`:4728-4740`（每次 `clearNode(tbody)` 重建全部行）。
- **证据**：实时视图（overview/users/messages/app-rules）每 5s 清空并重建 tbody；若用户正用键盘聚焦某行按钮，DOM 被替换后焦点丢失（modal 打开时轮询会暂停，但行内交互不暂停）。app-rules/定时/分组列表无分页，数据量大时每 5s 重建成本线性增长。
- **影响**：键盘/读屏用户被周期性打断；大规则列表下 CPU/布局抖动。
- **建议**：1) 行级 diff/keyed 更新（按 id 复用 `<tr>`，只更新变化单元格）；或 2) 轮询时先比较数据 JSON，无变化不重渲染；3) app-rules/定时/分组加分页或至少虚拟滚动上限；4) 保留"当前聚焦元素 id"，重渲染后恢复焦点。
- **工作量**：M。

### F-23 [P3] CSS：响应式断点体系不统一（560/639/899/900/1023/1024 混用，min/max 900 重叠）

- **位置**：`web/assets/style.css` 的 26 个 `@media`：`:2849 min-560`、`:2879/3288/3499/3515/3596/3663/3711/4155 max-639`、`:3692 max-900`、`:3768/3892/3977 min-900`、`:3774/3898/3986/4007/4091 max-899`、`:3249/3505 max-1023`、`:2959/3243/2980 min-1024`。
- **证据**：脚本枚举全部媒体查询发现 `max-width:900px` 与 `min-width:900px` 同时存在（视口恰好 900px 时两套规则都命中）；`899/900` 两种写法的分界在各章节不统一；另外 560 只出现一次，与其它断点无体系关系。测试只断言 1023/899/1024 存在（`frontend-pages.test.js:1463-1465`），不校验一致性。
- **影响**：临界宽度样式叠加顺序不可预期；后续改断点需全局搜索。
- **建议**：定义 3 个断点常量语义（mobile `<640`、tablet `640-1023`、desktop `≥1024`，公共页 899/900 统一为 899），把所有媒体查询收敛；在测试中加"断点白名单"断言。
- **工作量**：M。

### F-24 [P3] 功能限制：未分组筛选客户端 500 上限；用户选择器缓存不失效

- **位置**：`web/assets/admin.js:3979-3996`（`UNGROUPED_FILTER` → `limit=500&offset=0` 后客户端过滤）、`:4008-4010`（UI 自述"最多统计 500 位用户"）；`:1169-1174`（`loadPickerUsers` 500 用户缓存）。
- **证据**：服务端契约未定义"未分组"参数（注释已说明），前端用 500 条上限近似；用户总数 >500 时"未分组"计数与分页不准确。`state.pickerUsers` 一旦缓存永不失效，新建/删除/改名用户后，规则/定时编辑器的用户选择器仍是旧数据，选择已删除用户会得到 400。
- **影响**：大数据量下的筛选/统计不准确；编辑器中用户数据陈旧。
- **建议**：后端补 `groupId=__ungrouped__`（或 `ungrouped=1`）参数；前端每次打开规则/任务编辑器时按需刷新 picker 缓存（或 TTL 60s）。
- **工作量**：S（前端）/M（后端契约）。

### F-25 [P3] 一致性：登出后 `document.title` 仍是上次视图标题

- **位置**：`web/assets/admin.js:582-583`（`showView` 设置 title）、`:477-504`（`showLogin` 未重置 title）、`:506-516`（`showDashboard` 未重置）。
- **证据**：登出/会话过期后浏览器标签页仍显示"ClawBridge 管理后台 · 用户管理"等，登录页标题不再准确。
- **影响**：多标签场景难以辨认；小问题。
- **建议**：`showLogin` 恢复 `document.title = 'ClawBridge · 管理后台'`。
- **工作量**：S。

### F-26 [P3] 文档维护：`web/docs.html` 与 `docs/*.md` 手工双份维护，测试仅单向 token 校验

- **位置**：`web/docs.html`（1623 行，内嵌 API 表格/章节）、`docs/API.md`（37KB）等；`tests/unit/frontend-pages.test.js:1272-1332`（只校验 `docs/API.md` 中端点都出现在 docs.html，**不反向校验** docs.html 是否包含已废弃端点）。
- **证据**：docs 页面内容与 9 个 markdown 文档大量重复，测试以 token 存在性为主（如 `docs.html.includes(token)`），无法发现"docs.html 多出旧字段/旧参数"或语义漂移。
- **影响**：API 变更后文档页与 markdown 易脱节；测试给人"已覆盖"的错觉。
- **建议**：短期加反向断言（docs.html 中提取的端点集合 ⊆ API.md 端点集合，允许白名单）；中期考虑从 markdown 生成 docs.html 的静态段落脚本（零运行时依赖，构建期可选手动运行）。
- **工作量**：S（反向测试）/M（生成）。

### F-27 [P3] 安全加固（非现存漏洞）：`el()` 允许任意 DOM 属性赋值，静态 innerHTML 禁令只扫 4 个固定文件

- **位置**：`web/assets/common.js:279-322`（`el()` 的 `key in node` 分支会执行 `node.innerHTML = ...` 等任意属性赋值）、`:346-361`（`escapeHtml` 未被使用）；`tests/unit/frontend-pages.test.js:391-409`（只读取 `common.js/bind.js/admin.js/docs.js` 四个文件）。
- **证据**：当前所有调用点均传入字面量属性名（无用户可控 key），且无 `innerHTML/outerHTML/insertAdjacentHTML` 命中，**现状无 XSS**；但 `el()` 的通用属性分支使"未来某人传入 `{innerHTML: data}`"可绕过静态测试（测试只 grep 四个文件、不覆盖新模块）。
- **影响**：拆分后若新模块未纳入测试 glob，安全网出现缺口；`escapeHtml` 死代码可能诱导使用 HTML 字符串路径。
- **建议**：`el()` 显式拒绝 `innerHTML/outerHTML/outerText/insertAdjacentHTML` 键（抛错或静默忽略），并把测试扫描改为 `web/assets/**/*.js` 全量 glob；删除 `escapeHtml`；在 `ARCHITECTURE.md` §8 写明"动态内容只允许 textContent/DOM 属性"。
- **工作量**：S。

### F-28 [P3] 表单校验：规则/定时/分组/设置四套校验各写各的，边界不一致

- **位置**：`web/assets/admin.js:2103-2108`/`:3242-3247`（两个 `showFormError`）、`:3758-3761`（分组 `showError`）；规则保存校验 `2190-2296`（`timeoutMs` 未校验，见 `2020-2029` 输入 min/max）、定时保存校验 `3334-3412`（`timeoutMs` 校验 1000-30000）、设置 `collectSettingsChanges` `5380-5415`。
- **证据**：同样字段 Server 契约有上下限，但规则编辑器未校验 timeout（仅靠 server 400 兜底）、`priority` 空值经 `Number('')` 变成 0（`1599` 默认 100、`2282` 提交），定时编辑器则校验完整；错误展示模式（errorNode + scrollIntoView）复制 3 份。
- **影响**：错误提示时机不一致（有的前端即时提示、有的等 server 400）；`priority` 空输入可能被当作最高优先级保存。
- **建议**：抽 `admin/lib/validation.js`（纯函数，可 node 单测）：`validatePriority`、`validateTimeout`、`validateName`、`validateHeaders`；统一 `FormErrors` 展示组件；规则编辑器补 timeout/priority 校验。
- **工作量**：M。

### F-29 [P3] 文档漂移：`ARCHITECTURE.md` §9 的后台能力清单/共享壳描述过时

- **位置**：`docs/ARCHITECTURE.md:263-278`（§9）；对照 `web/admin.html:32-53`（7 个菜单）与各增量章节 §13-§17。
- **证据**：§9 后台描述仍只有"概览卡片、用户列表、批量广播、消息记录、运行配置"，没有分组/接口应用/定时通知/安全卡片；§9 说三页"同一套侧栏/顶栏壳"，实现是两套 DOM/CSS（见 F-18）；§9 说"后台数据 5s"未注明仅 4 个 live 视图（见 F-14）。§13-§17 的"前端"增量条目与 §9 没有交叉引用。
- **影响**：新成员/审查者按 §9 建立错误心智模型；拆分后模块边界更需要准确文档。
- **建议**：本次拆分同步重写 §9：7 个视图清单、共享壳的真实结构（两套 + 共享 drawer 行为）、轮询范围表、`web/assets/admin/**` 目标模块图；在 §1 写作用域表补 `web/assets/admin/**` 的 owner。
- **工作量**：S。

## 3. 代码结构优化建议

### 3.1 目标模块结构（ES Module，零构建不变）

```
web/assets/
  common.js                 # 保持不变：apiFetch/uploadWithProgress/el/toast/modal/poller/drawer/focus-hints
  lib/                      # 纯函数，无 DOM，可被 node:test 直接 import
    format.js               # formatDateTime/formatRelative/formatDuration/formatNumber/formatFileSize
    parse.js                # parseHeadersInput/parseKeywordsInput/parseSettingArrayInput/normalizeGroupColor
    settings.js             # settingTypeOf/normalizeSettingValue/settingsValuesEqual/collectChanges
    media.js                # safeMediaPath/attachmentPaths/formatFileSize 复用
    summary.js              # formatIntervalSummary/schedulePlanSummary/scopeSummary/targetSummary
  admin.js                  # 40 行内 entry：import { configureApi } + init，末尾唯一 init();
  admin/
    app.js                  # bootstrap/login/logout/unauthorized、document.title、键盘全局监听
    router.js               # MENU_VIEWS/VIEW_BY_ID/hash 解析/showView/navigateToView/loadView 注册表
    shell.js                # els 壳节点（sidebar/topbar/view-title/refresh/logout）、initSidebarDrawer、抽屉
    state/
      session.js users.js messages.js groups.js rules.js scheduled.js settings.js
    ui/
      switches.js           # buildSwitch(options) 统一 4+1 处
      actions.js            # rowActionButton/tableClickDispatcher
      table.js              # emptyRow/pagination/updatePagination/分页状态
      badges.js             # badge/groupBadge/sourceBadge/statusBadge
      modal.js              # openTrackedModal/confirmDelete/openSecretReveal
      pickers.js            # 用户/分组多选（规则+定时共用）
      header-mode.js        # Header 掩码/重设/清空 + readHeaderPayload
      template-tools.js     # 模板语法/预览/Markdown 预览 + renderMarkdownPreview
      forms.js              # formSection/formField/fieldGrid + FormErrors
    integrations/
      editor-shell.js       # 规则/定时编辑器共用骨架（标题、保存 action、busy、错误滚动）
      request-section.js    # buildRequestRow/Header/Body + sync 方法联动
      response-section.js   # buildResponseRow/模板/兜底/超时
      header-mode.js        # 见 ui/
    views/
      overview.js users.js groups.js messages.js broadcast.js
      app-rules/index.js app-rules/editor.js app-rules/test.js app-rules/logs.js
      scheduled/index.js scheduled/editor.js scheduled/test.js scheduled/logs.js
      config/index.js config/settings.js config/security.js config/restart.js
    api.js                  # 按资源收口 50 处 apiFetch，返回领域对象
```

**依赖方向（禁止反向/循环）**：
`admin.js (entry) → app.js → router.js → views/** → { api.js, state/**, ui/**, lib/**, common.js }`；`ui/** → common.js`；`lib/**` 零 import；`views/**` 不 import `router.js`（需要跳转时设置 `location.hash` 或由 app 注入 `navigate()`）；`state/**` 不 import `views/ui`。`integrations/**` 只依赖 `ui/lib/common`，由两个编辑器引用。

**TDZ / init 时序**：ESM 的依赖先于 entry 执行，所有模块顶层初始化天然完成后再执行 `admin.js` 末尾的 `init();`，因此现有 `admin.js:5894` 的 TDZ 注释与"所有 const 必须在 init 前"约束可以删除；保留唯一契约：`admin.js` 最后一条顶层语句是 `init();`（测试同步调整）。

**state/els 解耦**：`els` 拆成各视图模块内部的 `const els = {...}`（在 `initView()` 时对 section 根节点查询，并校验关键节点存在）；跨视图只需壳节点（`shell.js`）与 `state`。`state` 按域拆分为模块，导出只读 getter + action（如 `usersState.get()`, `usersStore.actions.load()/setFilter()`）；避免任何模块直接改别人的 state。参考数量：现 `els` 89 项可缩到每视图 5-15 项。

**UI 构建器抽取清单**（用量来自全文统计）：`switch` 5 份→1；行按钮工厂 4 份→1；表格点击分发 4 份→1；`emptyRow` 5 个调用点+`colspan` 校验→1 个 `table.js`；`confirmDialog` 11 处→`confirmDelete/confirmDanger`；`showInlineError/clearInlineError` 在 admin.js 与 bind.js 各 1 份→common.js 导出；剪贴板逻辑 admin.js:5806-5828 与 docs.js:55-79 两份→common.js 导出 `copyText`。

**视图懒加载（可选）**：`router.js` 的 `loadView` 注册表改为 `() => import('./views/users.js')`；首次切换视图时才加载对应模块（CSP `script-src 'self'` 允许同源动态 import）。默认视图（overview）同步 import，其余动态 import，可显著降低 `/admin` 首屏解析量（当前 234KB）。

### 3.2 迁移步骤（每步独立可回归，建议 6 个 PR/commit）

1. **先加测试安全网**（不改业务代码）：更新 `frontend-pages.test.js`（见 3.3）；新增 `tests/unit/frontend-modules.test.js`（只读 import 图：所有 `from './x'` 路径存在、无环、`web/assets/**/*.js` 无 `innerHTML/outerHTML`、无 `matchMedia/innerWidth`）。先让新旧测试全绿。
2. **抽 `lib/` 纯函数 + 真实单测**：把 `parseHeadersInput`（admin.js:1266-1276）、`parseKeywordsInput`（1259-1264）、`normalizeGroupColor`（809-812）、`parseSettingArrayInput`（5001-5006）、`settingsValuesEqual`（5019-5024）、`settingTypeOf`（4962-4975）、`formatIntervalSummary`（2671-2679）、`schedulePlanSummary`（2681-2691）、`scopeSummary`（1031-1041）、`scheduleTargetSummary`（2693-2705）、`safeMediaPath`（4745-4747）、`toCount`（5859-5862）移到 `lib/`，admin.js 改 import；用 `node:test` 写行为测试（替换对应的脆弱文本断言）。
3. **抽 `ui/` 通用构建器**（switch/action/table/badges/modal/pickers/forms）：从 admin.js 移出被 4+ 处复用的代码，先不动视图逻辑；每批移动后跑静态测试 + smoke。
4. **拆 `views/`（最大步）**：按 7 个菜单视图逐个迁移（overview → users → groups → messages → broadcast → config → app-rules+scheduled），router 注册表指向视图模块；`admin.js` 只留 entry。规则/定时编辑器最后迁移并合并重复块（F-04）。
5. **收口 `api.js` 与 `state/`**：把散落的 50 处 `apiFetch` 路径改为 `api.users.list(...)` 等；state 按域模块化。
6. **清理 CSS 与文档**：删除 F-16 死规则（同步删被测试引用的 3 条断言）、补 F-17 变量、统一断点；重写 `ARCHITECTURE.md` §9 与 §1；更新 README 中的前端结构描述。
7. **最终验收**：静态测试 + 新 lib 单测 + Lead 的 `scripts/frontend-smoke.mjs`（headless Edge/CDP：登录、7 视图遍历、分组 CRUD、两个编辑器、登出）+ 移动端窄屏手工冒烟（抽屉、hash、弹窗焦点）。全部通过后收尾。

### 3.3 对 `tests/unit/frontend-pages.test.js` 的具体调整方案

现状问题（行号均实测）：23 处 `readAsset('admin.js')`、约 24 个 test 依赖其文本；3 处"数量恰好为 2"的精确断言（965-996、1372-1387）；`init()` 末尾唯一性（1334-1342）；innerHTML/设备判断只扫 4 个硬编码文件（391-409、1457-1459）；CSS 断言锁死死规则（1360-1371 要求 `.admin-topbar .topbar-actions` 存在）。

建议按以下映射改造（尽量保留契约强度、去掉结构耦合）：

| 现测试断言 | 改为 |
| --- | --- |
| `readAsset('admin.js')` + `admin.includes(token)`（存在性，约 70% 断言） | `const ALL = await readAllAssets()`（递归 `web/assets/**/*.js` 拼接）后 `ALL.includes(token)`；或按模块 manifest 读指定模块 |
| 精确计数 `syncHeaderModeUi`/`closeOnBackdrop`/`setHidden(bodyField...` = 2（965-996、1372-1387） | 改为行为测试：编辑器打开时点击"重设 Header"，断言 textarea 值（需先拆 `header-mode.js` 导出纯函数 `buildHeaderResetText(names)`/`validateHeaderPayload(text, mode)` 并用 node 断言）；或改为 `readModule('integrations/header-mode.js')` 单文件断言 |
| `init()` 末尾唯一 + 其后无顶层 const/let（1334-1342） | 保留在 `admin.js` entry：`assert.match(trimmed, /init\(\);$/m)` + 全文件仅 1 处；模块内允许顶层 const/let（新增测试：非 entry 文件不得调用 `init()`） |
| `admin.js` 后端点 token（454-478）、分组/保活/规则/定时/设置 token（585-632、683-841、743-963、1091-1195 等） | 先用 `ALL` 拼接源；拆分稳定后改为"各 view 模块文件存在性 + 关键 DOM id/接口路径断言"（id 断言仍读 HTML） |
| innerHTML/outerHTML 禁令（391-409） | 扫描 `web/assets/**/*.js` 全量；新增禁止 `el()` 传入 `innerHTML` 键的断言（F-27） |
| `initSidebarDrawer` 必须出现在 4 个 JS（1457-1462）、无设备判断 | 改为 `ALL` 聚合 + 各页面脚本（bind/docs/admin entry）各自 include；设备判断扫描全量 |
| CSS 死规则断言（1360-1371 等） | 删除对 `.admin-topbar .topbar-actions` 的保留要求（F-16），改为"`.admin-topbar-bar .topbar-actions` 移动端规则存在" |
| 文档页 token 断言（1272-1332 等） | 增加反向校验（F-26）：docs.html 中提取的端点 ⊆ docs/API.md 端点集合 |
| 新增（可选） | import 存在性/无环、CSS 未定义 var 检查、`el()` 危险属性禁止、table colspan 与 th 数一致、`viewLoaded` 等死代码白名单 |

**注意**：测试改造必须先于拆分提交（步骤 1），否则第 2 步起每次移动函数都会红；测试自身是 51 个 test 的资产，不建议整体重写，只做"读取方式聚合化 + 脆弱计数行为化 + 扫描范围全量化"。

### 3.4 验证方式

- 每个迁移步骤：`node --check` 所有改动 JS（ESM 语法）；`node --test tests/unit/frontend-pages.test.js tests/unit/frontend-modules.test.js tests/unit/frontend-lib.test.js`（新增）。
- 拆分完成后：`npm run test:unit`（注意 Lead 要求不在审查阶段跑全量；拆分实施阶段可跑）；Lead 的 `scripts/frontend-smoke.mjs` 做真实浏览器回归（登录/7 视图/分组 CRUD/编辑器/登出），并补窄屏（≤639px）抽屉与弹窗焦点手工检查。
- 性能回归：记录拆分前后 `/admin` 首屏 JS 解析时间与 `performance.getEntriesByType('resource')` 中模块请求数；动态 import 后确认 7 个视图均可打开。

## 4. 亮点

1. **安全写入路径非常克制**：全仓无 `innerHTML/outerHTML/insertAdjacentHTML/eval/new Function`（仅 common.js:343 注释提及），`el()`/`textContent`/DOM 属性为唯一写入方式；URL 有三级白名单：`safeSvgDataUri`（common.js:367-374，仅 `data:image/svg+xml;base64,` + base64 校验）、`safeMediaPath`（admin.js:4745-4747，仅 `/api/` 前缀）、`normalizeGroupColor`（admin.js:809-812，仅 `#RRGGBB`），且 `renderMarkdownPreview`（admin.js:1364-1489）完全用 textContent 渲染 Markdown，用户模板无法注入 HTML。
2. **统一请求层质量高**：`apiFetch`（common.js:85-167）统一超时/网络错误/TIMEOUT/401 全局钩子/CSRF 头/JSON 规范化，`uploadWithProgress`（184-255）用 XHR 支持进度且同样走 401 钩子；50 个调用点与 server 路由逐条比对无错配。
3. **轮询与可见性管理成熟**：`createPoller`（common.js:756-852）具备页面隐藏暂停、可见即补一次、inFlight + rerun 防重入；后台轮询在弹窗打开时暂停（admin.js:672），登出/401 时统一 stop + 清弹窗（admin.js:470-504）。
4. **单套 DOM 响应式与共享抽屉**：三页均无 JS 设备判断（测试 1441-1466 强制），`initSidebarDrawer`（common.js:966-1022）统一处理 aria-expanded/overlay/Esc/焦点回退，CSS 用 1023/899/639 断点完成 off-canvas；hash 路由处理了深链、非法 hash 回退、`replaceState` 规范化、sessionStorage 记忆（admin.js:522-598），边界情况覆盖较全。
5. **无障碍基础扎实**：skip-link、`aria-current="page"`、`role="switch"+aria-checked`、`role="dialog"+aria-modal`、关闭恢复焦点、全局 `:focus-visible` 描边（style.css:131-133）、`prefers-reduced-motion`（2890-3001）、长 placeholder 聚焦提示 + `aria-describedby`（common.js:881-964）。
6. **测试资产**：51 个前端静态测试把 CSP/外部依赖/关键 id/契约 token 固化下来，是拆分前最好的安全网；只要按 §3.3 先把"读文件方式"聚合化，测试强度不降反升。

## 5. 附录：文件指标表

### 5.1 web 文件指标

| 文件 | 行数 | 字节 | 职责 | 被引用关系 |
| --- | --- | --- | --- | --- |
| `web/admin.html` | 474 | 26585 | 后台壳 + 登录 + 7 个视图容器 + 设置/安全卡片 | → `style.css`、`admin.js` |
| `web/index.html` | 182 | 8613 | 公开绑定页（生成二维码/轮询/配对数字/成功信息） | → `style.css`、`bind.js` |
| `web/docs.html` | 1623 | 98696 | API 文档页（内嵌全部契约/示例/错误码） | → `style.css`、`docs.js` |
| `web/assets/admin.js` | 5895 | 234483 | 后台全部逻辑（171 函数/7 视图/2 编辑器/设置/安全） | admin.html 引用；import common.js |
| `web/assets/common.js` | 1023 | 33306 | API/上传/DOM/格式化/toast/modal/poller/drawer/focus-hints | 被 admin/bind/docs 三脚本 import |
| `web/assets/bind.js` | 551 | 18668 | 绑定页状态机（1s 轮询、配对、会话持久化） | index.html 引用；import common.js |
| `web/assets/docs.js` | 187 | 5940 | 文档页复制/端点筛选/TOC 高亮/回顶/抽屉 | docs.html 引用；import common.js |
| `web/assets/style.css` | 4352 | 79044 | 全站样式（21 个章节、26 个媒体查询、35 个变量） | 三页共同引用 |

引用关系补充：`common.js` 被 3 个页面脚本共享（唯一跨页模块）；`style.css` 被 3 页共享；无任何外部 CDN/字体/图片（favicon 为 data URI）。`tests/unit/frontend-pages.test.js` 直接读取 4 个 JS 文本（23 次读取 admin.js）。

### 5.2 admin.js 分域指标（行号实测）

| 行区间 | 行数 | 内容 | 备注 |
| --- | --- | --- | --- |
| 1-116 | 116 | imports/常量/元数据（7 主题色板、状态/来源/媒体映射） | 可移 `admin/constants.js` |
| 117-249 | 133 | 全局 `state` + `els`（89 项）+ openModals + configureApi | 拆分重点 |
| 250-418 | 169 | init / bootstrap | entry 化后大幅缩小 |
| 420-516 | 97 | 登录/登出/鉴权/401 | → `admin/app.js` |
| 518-660 | 143 | hash 路由/视图切换/抽屉 | → `admin/router.js` + `shell.js` |
| 662-718 | 57 | 自动刷新/写后刷新/手动刷新 | → `router.js` |
| 720-784 | 65 | 概览 | → `views/overview.js` |
| 786-976 | 191 | 用户分组（CRUD/保活/筛选） | → `views/groups.js` |
| 978-2503 | 1526 | 接口应用（规则列表/表单/测试/日志/模板预览） | → `views/app-rules/**` + `lib/markdown` |
| 2505-2646 | 142 | 规则运行日志弹窗 | → `views/app-rules/logs.js`（与定时日志 68% 重复） |
| 2648-3961 | 1314 | 定时通知（列表/编辑器/测试/执行/日志）+ 混入的分组编辑器/用户分组弹窗 | → `views/scheduled/**`；3679-3961 应移回 groups |
| 3963-4517 | 555 | 用户列表/详情/发消息弹窗/解绑/重连/删除 | → `views/users/**`；发消息弹窗 312 行独立可拆 |
| 4519-4658 | 140 | 用户详情 + 迷你消息渲染 | → `views/users/detail.js` |
| 4660-4698 | 39 | 广播 | → `views/broadcast.js` |
| 4700-4940 | 241 | 消息记录 + 附件渲染 | → `views/messages.js` |
| 4942-4952 | 11 | `/api/admin/config` | → `api.js`/`views/config` |
| 4954-5558 | 605 | 运行配置设置表单（load/render/save/reset/restart） | → `views/config/settings.js` |
| 5560-5862 | 303 | 安全卡片（改密/重置密码/Token/一次性展示） | → `views/config/security.js` |
| 5864-5896 | 33 | 弹窗追踪/内联错误/appendKv/emptyRow/updatePagination/toCount | → `ui/**`（现定义在文件末尾，所有视图反向依赖） |

### 5.3 关键数据换算说明

- 重复度指标：先按行去空白/去注释标记，再做"规范化同义替换"（`rule/schedule/规则/任务/headerMode`），比较两段代码中非平凡行（≥15 字符）的逐行相同数；数字见 F-04 表格。
- CSS 指标：手工正则解析 642 条规则/693 个选择器/2216 条声明（含 @media 内嵌）；死选择器判定为"选择器 class token 在 3 个 HTML + 4 个 JS 中均不存在"（已剔除动态拼接类名）；对比度按 WCAG 2.x 相对亮度公式计算。
- 行号口径：与 read 工具一致（文件末尾若为换行，最大行号 = `split('\n').length - 1`）。
