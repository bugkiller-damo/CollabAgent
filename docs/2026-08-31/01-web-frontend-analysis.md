# Slock Web 前端审计报告（架构 × 设计 × 工程）

> 审计日期：2026-08-31 ｜ 对象：`packages/web`（117 个源文件，约 13.6k 行）
> 方法：design-taste-frontend skill 审计框架 + 4 路并行 subagent 深扫 + 主会话对全部 P0 断言逐一人工复核（grep/读码验证，全部属实）。
>
> **适用性声明**：taste skill 的目标域是营销页/作品集（其 Section 13 明确排除产品 UI）。本审计是**产品 UI 审计**，只应用了 skill 中可迁移的部分（token 纪律、色彩/圆角一致性锁、状态完整性、a11y、motion 纪律、AI tells 反模式），未套用营销页专属规则（hero 纪律、bento 节奏、eyebrow 配额等）。
>
> **设计读法（Design Read）**：B2B AI 协作产品 UI（Slack 式频道 + agent 调度面板），受众为工程团队。按 skill 表盘语言描述现状：`DESIGN_VARIANCE ≈ 3`（保守对称）、`MOTION_INTENSITY ≈ 2`（近静态）、`VISUAL_DENSITY ≈ 6`（日常应用）。对产品 UI 这是合理区间，问题不在表盘取值，在执行一致性。

---

## 1. 工程健康度总览（实测，非推断）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `vue-tsc --noEmit` | ✅ 0 错误 |
| Lint | `biome check .` | ✅ 0 错误 / 1 warning / 5 info（112 文件） |
| 测试 | `vitest run` | ✅ 5 文件 41 用例全绿（node 环境，3s） |
| 构建 | `vite build` | ⚠️ 成功，但 index chunk **1.24 MB**（gzip 411 kB）触发 >500kB 警告 |

**结论：四项全绿，工程质量底线健康。问题集中在实时链路正确性、设计系统纪律、状态完整性三个层面。**

技术栈：Vue 3.5 + Pinia + vue-router 4 + Tailwind v3 + markdown-it/DOMPurify/highlight.js + @tanstack/vue-virtual。依赖卫生干净：9 个外部包全部在用，无僵尸依赖、无缺失依赖。

---

## 2. 架构评估

### 2.1 数据流（实测拓扑）

```
浏览器 ──WS──> wsManager（连接生命周期：指数退避重连 1s→30s + 看门狗）
                  │ onEvent
                  ▼
              wsDispatch（纯函数 switch，事件 → store 写入，唯一 fan-out hub）
                  │ 写
   ┌──────┬───────┼──────┬──────────┐
   ▼      ▼       ▼      ▼          ▼
 message channel agent terminal notification（toast 横向告警）
                  ▲
   组件 ──REST──> apiClient（cookie + CSRF double-submit）：历史/回填/发送全部走 REST
```

装配点唯一：`AppLayout`（initWsManager + onConnect 触发 backfillAll/flushAllPending）。

### 2.2 架构亮点（值得保留的模式）

- **wsManager 可测性设计好**：socket 工厂 DI（209 行收敛，7 用例）、旧 socket 事件丢弃守卫（`ws !== sock`）、start 幂等。
- **断线回填设计完整**：lastSeenSeq 水位 + 分页游标 + id 去重 + inflight 护栏 + 失败不伪造推进，16 个测试用例背书。
- **无上帝 store、无 store 互 import**（仅 message/channel → toast），wsDispatch 是唯一分发枢纽，边界清晰。
- **离线待发队列 + PendingRow 三态**（sending/queued/failed + 重试/删除）是全站最完整的交互样板。
- **XSS 防护链完整**：全 src 仅 1 处 `v-html`（MarkdownContent.vue:58），markdown-it `html:false` + 自实现 escapeHtml + DOMPurify.sanitize + 链接强制 `rel="noopener noreferrer"`。
- 路由全部页面级 lazy import；httpOnly Cookie 鉴权，localStorage 不存 token。

### 2.3 Store 职责表

| store | 职责 | 备注 |
|---|---|---|
| messageStore | 消息缓存/历史/离线队列/回填/编辑删除/反应 | **447 行 7 类职责，最重，可拆** |
| channelStore | 频道列表/成员/未读计数 | 未读 key 不一致（见 P1-9） |
| agentStore | agent 状态/presence/频道进度条 | 零测试 |
| terminalStore | 终端帧/观察帧缓冲 | 纯写入，零测试 |
| authStore | cookie 会话 + localStorage user 镜像 | 仅凭 localStorage 判登录，零测试 |
| computerStore | 我的计算机/daemon 状态 | 双端点降级，零测试 |
| taskStore | 任务 CRUD + 乐观拖拽 | 零测试 |
| notificationStore | 通知/未读数 | :52 裸 fetch 绕过 apiClient |
| toastStore / uiStore | 全局 toast / 主题·WS 状态·侧栏·抽屉 | uiStore 有 10 用例 |

---

## 3. P0 清单（已人工复核，全部属实）

### P0-1 看门狗误杀健康连接：空闲 70s 必强制重连
- **证据**：`wsManager.ts:67`（`inboundWatchdogMs = 70000`）、`:88-98`（看门狗只在 `onopen`/`onmessage` 重置）；`wsManager.ts:132` 的应用层 `ping→pong` 分支是**死代码**（server 从不发 `{type:"ping"}`，grep 全 server 无）。
- **根因**：server 心跳是**协议级** `ws.ping()`（`packages/server/src/ws/handler.ts:659`，10s 周期）。按 WebSocket 规范，协议 ping/pong 由浏览器内部处理，**不触发 JS 的 onmessage**。
- **后果**：任何空闲 >70s 的客户端被强制 close → 重连 → `AppLayout.vue:169` 触发 `backfillAll` → 夜间/挂机客户端形成重连+补拉风暴。
- **修法**：server 心跳定时器里改为发应用层 `{type:"ping"}`（wsManager 已有对应 pong 应答分支，接通即活）；或前端放宽/移除看门狗，信任 TCP 层。

### P0-2 线程回复实时不可见（双重病理 + key 错位）
- **证据链**：`wsDispatch.ts:99-115`
  1. 第一次 `receiveMessage` 显式构造的对象**丢弃了 threadId 字段** → 绕过 `messageStore.ts:137`「threadId 不入主列表」守卫 → **线程回复漏进主频道列表**。
  2. 第二次 `{...m, channelId: threadKey}` 展开带上 camelCase `threadId`（server 发 camelCase）→ 命中同一守卫**早退** → 线程缓冲区写不进。
  3. 即使写进，key 也不匹配：wsDispatch 写 `#general:abcd1234`（targetKey 带 `#`），`ThreadView.vue:37-40` 读 `general:abcd1234`（路由参数无 `#`）。
- **后果**：实时线程回复完全不可见，只能靠发送后 `loadThread` 拉取兜底。属功能级断裂。
- **修法**：第一次构造时透传 threadId（让守卫正确拦截主列表）；第二次用归一化后的字段绕开守卫直写线程缓冲区；统一 targetKey 与路由参数的 `#` 前缀约定（建议 store 内全部不带 `#`，展示层加）。

### P0-3 三个 animate 类从未定义，9 处动画静默失效
- **证据**：`style.css:32-44` 只定义了 `.animate-slide-in-right/.animate-slide-in-up/.animate-fade-out/.animate-scale-out` 四个类；`@keyframes fadeIn/scaleIn/shimmer`（:54/:62/:70）存在但**没有任何类引用它们**；tailwind.config.js `theme.extend` 为空。9 处调用全部静默失效：
  - `Modal.vue:67,76`（入场 fade+scale；退场的 fade-out/scale-out 却定义了——明显是写了一半）
  - `Skeleton.vue:17`（shimmer 失效，骨架屏退化为纯灰块）
  - `Tooltip.vue:42`、`AppLayout.vue:245`（页面切换淡入）、`UserMenu.vue:92`、`UserProfileFooter.vue:55`、`ChatPane.vue:174`、`MessageRow.vue:349`（表情反应弹层）
- **修法**：补齐三个类定义（keyframes 现成），每类约 3 行。

### P0-4 生产构建渲染「开发模式：跳过登录」按钮
- **证据**：`LoginPage.vue:96-98` 按钮**无任何 v-if / `import.meta.env.DEV` 门禁**；`:31-48` `handleDevBypass` 硬编码 `dev/dev` 直打 `/api/auth/login`，成功即写 localStorage + 跳转。
- **后果**：视 server 是否放行 dev 账号而定——放行则是生产后门，不放行则是面向真实用户的坏 UI。两种都不是可发布状态。
- **修法**：`v-if="import.meta.env.DEV"` 包裹，或整段删除。

---

## 4. P1 清单（按主题分组）

### 4.1 设计系统纪律（taste audit 核心发现）

| # | 问题 | 证据 |
|---|---|---|
| 1 | **Token 形同虚设**：style.css 定义 7 个 CSS 变量（light/dark 双套），全 src **零引用**；tailwind extend 为空；色彩全靠组件内硬编码 | `style.css:6-24`；grep `var(--` 在 .vue 中无命中 |
| 2 | **同语义多 hue 并存**：成功 green-*（约 40 处）vs emerald-*（6 处，Toast.vue:9）；警告 amber-*（约 60 处）vs yellow-*（7 处，ConnectionStatus.vue:9）；accent 实际有 blue/sky/purple/violet 四个 hue | 违反色彩一致性锁 |
| 3 | **浅色模式下的深色孤岛**：MentionPopup（无条件 `bg-gray-800`）、ThinkingIndicator（`bg-gray-800/80`）、AgentObsStream（`bg-gray-900` 系） | 组件硬编码深色 |
| 4 | **`focus-visible` 全 App 0 次**：SearchBar/SearchPane/SearchView 三处 `focus:outline-none` 且无 ring，键盘焦点不可见 | grep 计数 |
| 5 | **Modal 无 a11y 语义**：无 `role="dialog"`/`aria-modal`、无 focus trap、无初始聚焦、无滚动锁定；全站弹窗（频道设置/任务详情/ConfirmDialog）继承此缺陷 | `ui/Modal.vue:62-84` |
| 6 | **Button 原语被绕行**：ui/Button 质量最高（4 variant、loading、active:scale、focus ring），但仅 15 个文件使用；`bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded` 模式在 ConfirmDialog:38、EmptyState:26、ErrorBoundary:41 等处手工复制 | grep 计数 |
| 7 | **圆角五档混用无成文规则**：rounded×71 / rounded-md×63 / rounded-full×39 / rounded-lg×38 / rounded-xl×8；同档组件不一致（ErrorBoundary 裸按钮 `rounded` vs Button md `rounded-md`） | grep 计数 |
| 8 | **对比度不达标点**：`text-white` 压 `bg-amber-500`（Toast.vue:10、AppLayout.vue:240 离线条）约 2.3:1；`text-gray-400` ×236 处，浅底上约 2.5:1（PeopleView/ComputerView/TaskBoard 重灾区） | WCAG AA 4.5:1 不达标 |

### 4.2 实时/数据正确性

| # | 问题 | 证据 |
|---|---|---|
| 9 | **未读计数 key 三处不一致**：incrementUnread 写 `#general`/`dm:uuid`（wsDispatch.ts:129-131），ChatPane 读裸名（:132/:158），clearUnread 用裸名（channelStore.ts:97）→ 徽标永不亮、清除不落同 key；且 `ch?.name !== activeChannelName` 中 ch 恒 undefined（server 发 `#name`）→ 正在看的频道也累计进聚合徽标 | SidebarRail.vue:15 单调增长 |
| 10 | **fetchHistory 覆盖竞态**：await 后无条件整体置换列表，期间到达的 live 消息被从 UI 抹掉（下次重连才补回） | messageStore.ts:93-97 |

### 4.3 状态完整性与 UX 一致性

| # | 问题 | 证据 |
|---|---|---|
| 11 | **错误伪装成空态**（5+ 页面）：SearchView.vue:36-38（失败显示"没有找到匹配"）、TaskBoard.vue:117-120（失败显示"暂无任务"）、PeopleView.vue:63-73、IntegrationSettings.vue:24-26、WorkspaceMembers 静默；ChannelView.vue:80 `fetchHistory().catch(()=>{})` 静默吞错，断网进频道永远停在"还没有消息" | messageStore 无 error 字段 |
| 12 | **搜索跳转高亮在小频道失效**：≤100 条频道走普通 div 分支，不传 `highlightMsgId` | ChannelView.vue:361-368 vs 369-384 |
| 13 | **ProfileSettings 错误消息恒绿色**："保存失败""修改失败"用 `text-green-600` 渲染 | ProfileSettings.vue:115,143 |
| 14 | **密码策略不一致**：ForgotPasswordPage.vue:41 要求 ≥6 位 vs RegisterPage.vue:44-51 ≥8 位+字母数字 | — |
| 15 | **危险操作确认不一致**：WorkspaceMembers.vue:89-97 移除成员无确认（同站 ChannelManagement 有 ConfirmDialog）；SecuritySettings.vue:81 用原生 `confirm()`；IntegrationSettings 撤销令牌无确认 | — |
| 16 | **ThreadView 无加载态**：加载中呈空白 | ThreadView.vue:54-66 |

### 4.4 工程

| # | 问题 | 证据 |
|---|---|---|
| 17 | **index chunk 1.24 MB**：急切依赖链 router → AppLayout → MemberProfileDrawer → MemberProfileBody → AgentWorkspacePanel → MarkdownContent.vue:3 `import hljs from "highlight.js"`（**全量约 190 语言**）+ markdown-it + DOMPurify 全部进入口 chunk | 构建产物实测；修法：`highlight.js/lib/common` 按需注册 + MarkdownContent 异步组件/manualChunks |
| 18 | **测试盲区**：authStore / api(CSRF) / agent·channel·computer·notification·task·terminal 6 个 store / 3 个 composables 全部零测试；消息渲染安全链（DOMPurify+md）无回归网 | 现有 41 用例集中在 ws 链路 |
| 19 | **消息明文缓存 localStorage**：频道消息与离线队列明文落盘（切频道/刷新不丢的设计权衡） | messageStore.ts:26-35,216；知情风险，建议确认口径或加上限/开关 |

---

## 5. P2 清单（精选）

- **死代码**：`panes/ActivityPane.vue`、`panes/SearchPane.vue`、`chat/SearchBar.vue` 全仓库零引用（侧栏两列化设计修订残留）；`messageStore.ts:113-130` `sendMessage` 死代码（无 clientNonce，与 enqueuePending 双轨）；`wsDispatch.ts:1` 未使用 import（biome 可自动修）。
- **emoji 当图标约 120 处 / 50 文件**（Toast ✅⚠️❌、EmptyState 💬、密码可见性 🙈/👁、状态灯 🟢⚪），跨平台渲染不一致；同时存在 27 处手写 inline SVG（无图标库依赖）。建议统一引入图标库（项目已有 SVG 基础，迁移成本低）。
- `useMentionSuggest.ts:95-99` API 失败注入假候选 alice/demo/local-agent-test；:165 新 @ 会话无防抖重拉两端点。
- `OnboardingChecklist.vue:55` 第三步 done 恒 false（永远显示未完成）。
- placeholder-as-label：Login/Register/ForgotPassword 全部字段（正面例：CreateChannelModal.vue:65-91 label-above-input）。
- 消息列表无日期分隔线；DmView 无虚拟化（长 DM 性能风险）。
- admin 四页 + settings 五页重复「PageHeader back + Card + 加载中…/暂无」模式 8 次以上，可抽 ListPage/AsyncState 公共件。
- wsManager.ts:111-113 CONNECTING 卡死的 socket 不重排重连；:173-177 send 静默丢弃。
- `usePolling.ts:18-20` fn 重复 reject 无兜底（unhandled rejection）；main.ts 无 `app.config.errorHandler`，ErrorBoundary.retry 对确定性错误即重挂即崩。
- authStore.ts:25 仅凭 localStorage 判登录；api/index.ts 无 401 拦截跳登录，session 过期停留假登录态。
- `text-[10px]/[11px]` 任意值约 10 处；标题字重 font-bold（PageHeader:44）与 font-semibold（SidebarPane:23）混用。
- dev proxy `/internal` 直通后端内部接口（仅 dev 环境，提示级）。

---

## 6. 亮点清单（审计中发现的正面模式，应在全站推广）

1. **PendingRow 离线队列三态 + 重试/删除**：全站最完整的异步交互样板。
2. **EmptyState**：可复用且被 8 个页面采用，状态表达的最佳实践。
3. **wsManager/wsDispatch/messageStore 测试三角**：41 用例全绿，backfill 设计（水位+游标+去重+inflight 护栏）教科书级。
4. **ui/Button 原语**：variant/loading/active:scale/双模式 focus ring 齐备（问题是覆盖面，不是质量）。
5. **灰色系纪律**：纯 gray 一族，slate/zinc/neutral/stone 零混入，「灰蓝」基调守住；无 brutal 黄/硬阴影残留。
6. **dark: 变体 707 处**，核心 ui 原语 10/10 双模式成对；无纯 #000/#fff 滥用。
7. **全局 `prefers-reduced-motion` 兜底**（style.css:75-81）；动画基本只动 transform/opacity。
8. **rail/pane 两列侧栏**与 08-22 设计文档一致落地（w-14 rail + w-60 可折叠 pane + localStorage 持久化 + ⌘K/⌘B + 1024px 断点统一）。

---

## 7. 改进路线图建议

**第一梯队（正确性，1-2 天）**：P0-1 心跳对齐（server 一行改动）→ P0-2 线程回复链路（wsDispatch 重写该分支 + key 约定统一）→ P0-3 补三个 animate 类 → P0-4 DEV 门禁。

**第二梯队（设计系统收敛，2-3 天）**：
1. 把 style.css 已有变量接入 tailwind.config `theme.extend`（颜色/圆角/字号三档），让语义化工具类可用；
2. 语义色归一（green→emerald 或反向二选一、amber→yellow 归一、accent 收敛为 blue 单色）；
3. Modal 补 role/focus trap/滚动锁定（一处修复全站受益）；
4. 全站 `focus:` → `focus-visible:` 替换 + 三个搜索框补 ring。

**第三梯队（状态与测试，持续）**：messageStore 加 error 字段消灭「错误伪装成空态」；highlight.js 按需注册拆包（index 预计降至约 400 kB）；authStore + api + 6 个 store 补单测；确认 localStorage 消息缓存口径。

---

## 附录：审计口径

- 分析覆盖：packages/web 全部 117 个源文件（4 路 subagent 分区深扫：架构数据流 / 设计系统 / 页面 UX / 工程健康）。
- 所有 P0 断言由主会话 grep/读码复核确认（2026-08-31）；P1/P2 均带 `文件:行号` 或 grep 计数证据。
- 工程数字（测试 41 例、chunk 1.24 MB 等）来自当日真实命令输出。
- 未做：浏览器实测（Lighthouse/视觉走查）、server 侧全量审计（仅追查了心跳与消息格式两个交叉点）。
