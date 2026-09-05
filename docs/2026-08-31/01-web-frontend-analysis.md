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
| taskStore | 任务 CRUD + 乐观拖拽 | ~~零测试~~ 2026-09-04 重判：死代码（零组件消费、`updateStatus/moveTask` 打在 server 不存在的 `/api/tasks/:n/status` 上），建议删除而非补测试（§8.2） |
| notificationStore | 通知/未读数 | :52 裸 fetch 绕过 apiClient |
| toastStore / uiStore | 全局 toast / 主题·WS 状态·侧栏·抽屉 | uiStore 有 10 用例 |

---

## 3. P0 清单（已人工复核，全部属实）

### P0-1 看门狗误杀健康连接：空闲 70s 必强制重连

> **✅ 2026-09-01 已由 server 侧修复（server 评估报告 P1.21），web 零改动**：server 每 30s 对浏览器连接发应用层 `{type:"ping"}`（`packages/server/src/ws/handler.ts` HEARTBEAT_INTERVAL=30s），下述 `wsManager.ts:132-134` 的 ping→pong「死代码」分支随之复活（任何入站帧都喂看门狗，30s < 70s 阈值，健康空闲连接看门狗永不触发）。修复路径正是本节建议的首选方案。以下保留作审计现场记录，其中「死代码」断言自 2026-09-01 起失效。

- **证据**：`wsManager.ts:67`（`inboundWatchdogMs = 70000`）、`:88-98`（看门狗只在 `onopen`/`onmessage` 重置）；`wsManager.ts:132` 的应用层 `ping→pong` 分支是**死代码**（server 从不发 `{type:"ping"}`，grep 全 server 无）。
- **根因**：server 心跳是**协议级** `ws.ping()`（`packages/server/src/ws/handler.ts:659`，10s 周期）。按 WebSocket 规范，协议 ping/pong 由浏览器内部处理，**不触发 JS 的 onmessage**。
- **后果**：任何空闲 >70s 的客户端被强制 close → 重连 → `AppLayout.vue:169` 触发 `backfillAll` → 夜间/挂机客户端形成重连+补拉风暴。
- **修法**：server 心跳定时器里改为发应用层 `{type:"ping"}`（wsManager 已有对应 pong 应答分支，接通即活）；或前端放宽/移除看门狗，信任 TCP 层。

### P0-2 线程回复实时不可见（双重病理 + key 错位）

> **✅ 2026-09-04 已修复（web 侧，P0 段第二项清零）**：wsDispatch `agent:deliver` 分支重写——①第一次构造透传 threadId，主列表守卫正确拦截；②线程回复改走 store 新 action `receiveThreadReply` 绕开守卫直写线程缓冲区（去重+追加，不落 localStorage 缓存、不推进 lastSeenSeq）；③key 统一为 `threadBufferKey()` 约定（无 `#`，wsDispatch 写侧与 ThreadView 读侧共用同一 helper）。**连带锤出并修复两个本报告未列的隐藏问题**：(a) 修复前线程回复会推进主列表 `lastSeenSeq`——重连 backfill `after=<高 seq>` 会永久跳过其间未到达的顶层消息，修复后水位只被顶层消息推进；(b) 修复后 `messagesByTarget` 出现 thread key，`backfillAll` 若不加护栏会对 `general:abcd1234` 发 history——server 端 `cleanChannelName` 把它清成 `general` 解析成功，主频道顶层历史灌进线程缓冲区并以「回复」形态上屏，现由 store 内 `threadKeys` 登记跳过。验证：web vitest 43→49 全绿（wsDispatch +3：频道线程回复三断言/DM 线程 key/重复投递去重；messageStore +3：threadBufferKey 口径/receiveThreadReply 去重与零副作用/backfillAll 跳过）、vue-tsc 0 错误、biome 0 错误。以下保留作审计现场记录。
>
> **留尾（立此存照，归后续批次）**：DM 线程视图实际入口是 MessageRow 的 `/channels/dm:uuid/<id>` 意外路径（正规 `dm/:peerName/:threadId` 路由全站无 push 入口），该路径下线程 key 碰巧与写入侧一致故 live 回复可见，但 DM 线程**发送** target `#dm:uuid:<tid>` 过不了 server `isDmTarget`（前缀非 `dm:`）→ 404，DM 线程读写整体残缺归独立议题；主列表父消息 `replyCount` 不随 live 回复 +1（需重拉历史）；ThreadView 的 live 合并只按 id 追加，不跟随后续 message:update/delete（replies 是本地 ref 快照）。

- **证据链**：`wsDispatch.ts:99-115`
  1. 第一次 `receiveMessage` 显式构造的对象**丢弃了 threadId 字段** → 绕过 `messageStore.ts:137`「threadId 不入主列表」守卫 → **线程回复漏进主频道列表**。
  2. 第二次 `{...m, channelId: threadKey}` 展开带上 camelCase `threadId`（server 发 camelCase）→ 命中同一守卫**早退** → 线程缓冲区写不进。
  3. 即使写进，key 也不匹配：wsDispatch 写 `#general:abcd1234`（targetKey 带 `#`），`ThreadView.vue:37-40` 读 `general:abcd1234`（路由参数无 `#`）。
- **后果**：实时线程回复完全不可见，只能靠发送后 `loadThread` 拉取兜底。属功能级断裂。
- **修法**：第一次构造时透传 threadId（让守卫正确拦截主列表）；第二次用归一化后的字段绕开守卫直写线程缓冲区；统一 targetKey 与路由参数的 `#` 前缀约定（建议 store 内全部不带 `#`，展示层加）。

### P0-3 三个 animate 类从未定义，9 处动画静默失效

> **✅ 2026-09-04 已修复（web 侧，P0 段四项清零三项，仅余 P0-4）**：`style.css` `@layer utilities` 补齐三个类——`.animate-fade-in`/`.animate-scale-in`（各 0.15s ease-out forwards，与既有 `-out` 时长缓动对称，Modal 开合配齐）与 `.animate-shimmer`（半透明高光 linear-gradient + `background-size: 200% 100%` + 1.5s infinite，叠在 Skeleton 自带 `bg-gray-300` 底色上、深浅两模式通用）；keyframes 全部现成零新增。9 处调用全部生效，Skeleton 不再退化为纯灰块。顺带全量复扫 `animate-` 引用确认无其他漏定义：`animate-highlight` 为 MessageRow.vue `<style>` 内局部定义（:27），spin/ping/pulse 为 Tailwind 内置。验证：vitest 49/49 全绿（纯 CSS 无测试面）、vue-tsc 0 错误、biome 0 错误。以下保留作审计现场记录。

- **证据**：`style.css:32-44` 只定义了 `.animate-slide-in-right/.animate-slide-in-up/.animate-fade-out/.animate-scale-out` 四个类；`@keyframes fadeIn/scaleIn/shimmer`（:54/:62/:70）存在但**没有任何类引用它们**；tailwind.config.js `theme.extend` 为空。9 处调用全部静默失效：
  - `Modal.vue:67,76`（入场 fade+scale；退场的 fade-out/scale-out 却定义了——明显是写了一半）
  - `Skeleton.vue:17`（shimmer 失效，骨架屏退化为纯灰块）
  - `Tooltip.vue:42`、`AppLayout.vue:245`（页面切换淡入）、`UserMenu.vue:92`、`UserProfileFooter.vue:55`、`ChatPane.vue:174`、`MessageRow.vue:349`（表情反应弹层）
- **修法**：补齐三个类定义（keyframes 现成），每类约 3 行。

### P0-4 生产构建渲染「开发模式：跳过登录」按钮

> **✅ 2026-09-04 已修复（web 侧，P0 段四项全部清零）**：`LoginPage.vue` 按钮加 `v-if="isDev"` 门禁（`const isDev = import.meta.env.DEV`）——生产构建不渲染，dev 构建行为不变（保留开发便利性）。两个实锤的落地细节：①Vue 模板表达式**不允许** `import.meta`（compiler 解析直接报错），必须经 setup 绑定引用；②esbuild 不做跨闭包常量折叠，prod 产物中残留按钮文案/handler 的不可达死代码——行为上已完全移除，且 dev/dev 凭据非秘密（正常登录表单同样可试），真正边界在 server 侧该账号是否存在，故 v-if 门禁即为本节完整修复（若要求产物零残留可整段删除，属取舍非缺陷）。验证：vue-tsc 0 错误、biome 0 错误、vitest 49/49、prod `vite build` 成功；**DOM 级实证**：vite preview 起生产产物，浏览器开 `/login`，按钮列表仅「登录」、无 dev 按钮、表单完整；另构建 development 模式产物确认按钮分支仍在。以下保留作审计现场记录。

- **证据**：`LoginPage.vue:96-98` 按钮**无任何 v-if / `import.meta.env.DEV` 门禁**；`:31-48` `handleDevBypass` 硬编码 `dev/dev` 直打 `/api/auth/login`，成功即写 localStorage + 跳转。
- **后果**：视 server 是否放行 dev 账号而定——放行则是生产后门，不放行则是面向真实用户的坏 UI。两种都不是可发布状态。
- **修法**：`v-if="import.meta.env.DEV"` 包裹，或整段删除。

---

## 4. P1 清单（按主题分组）

### 4.1 设计系统纪律（taste audit 核心发现）

| # | 问题 | 证据 |
|---|---|---|
| 1 | **Token 形同虚设** ✅ 2026-09-04 已修复：style.css 定义 7 个 CSS 变量（light/dark 双套），全 src **零引用**；tailwind extend 为空；色彩全靠组件内硬编码 | `style.css:6-24`；grep `var(--` 在 .vue 中无命中 |
| 2 | **同语义多 hue 并存** ✅ 2026-09-04 已修复：成功 green-*（约 40 处）vs emerald-*（6 处，Toast.vue:9）；警告 amber-*（约 60 处）vs yellow-*（7 处，ConnectionStatus.vue:9）；accent 实际有 blue/sky/purple/violet 四个 hue | 违反色彩一致性锁 |
| 3 | **浅色模式下的深色孤岛** ✅ 2026-09-04 已修复（AgentObsStream 核实为误报）：MentionPopup（无条件 `bg-gray-800`）、ThinkingIndicator（`bg-gray-800/80`）、~~AgentObsStream（`bg-gray-900` 系）~~ | 组件硬编码深色 |
| 4 | **`focus-visible` 全 App 0 次** ✅ 2026-09-04 已修复：SearchBar/SearchPane/SearchView 三处 `focus:outline-none` 且无 ring，键盘焦点不可见 | grep 计数 |
| 5 | **Modal 无 a11y 语义** ✅ 2026-09-04 已修复：无 `role="dialog"`/`aria-modal`、无 focus trap、无初始聚焦、无滚动锁定；全站弹窗（频道设置/任务详情/ConfirmDialog）继承此缺陷 | `ui/Modal.vue:62-84` |
| 6 | **Button 原语被绕行** ✅ 2026-09-04 已修复：ui/Button 质量最高（4 variant、loading、active:scale、focus ring），但仅 15 个文件使用；`bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded` 模式在 ConfirmDialog:38、EmptyState:26、ErrorBoundary:41 等处手工复制 | grep 计数 |
| 7 | **圆角五档混用无成文规则** ✅ 2026-09-04 已修复：rounded×71 / rounded-md×63 / rounded-full×39 / rounded-lg×38 / rounded-xl×8；同档组件不一致（ErrorBoundary 裸按钮 `rounded` vs Button md `rounded-md`） | grep 计数 |
| 8 | **对比度不达标点** ✅ 2026-09-04 已修复：`text-white` 压 `bg-amber-500`（Toast.vue:10、AppLayout.vue:240 离线条）约 2.3:1；`text-gray-400` ×236 处，浅底上约 2.5:1（PeopleView/ComputerView/TaskBoard 重灾区） | WCAG AA 4.5:1 不达标 |

> **P1-1 修复记录（2026-09-04，Token 形同虚设）**：①**token 值对账**——原 7 变量从未被引用，其取值是「虚构值」，逐项改为全站主导的事实配对（light/dark）：`--bg-primary` white→gray-50（dark gray-900 不变）、`--bg-secondary` gray-100→white（dark gray-800 不变）、`--bg-tertiary` 保持 gray-200/gray-700、`--text-primary` dark gray-50→white、`--text-secondary` dark gray-300→gray-400、`--text-muted` 由 gray-400/gray-500 反转为 gray-500/gray-400（顺带向 #8 对比度方向收紧）、`--border` light gray-300→gray-200。②tailwind.config `theme.extend.colors` 接入 7 个语义类（canvas/surface/raised/ink/subtle/muted/line），light/dark 由 CSS 变量翻转、使用侧免写 dark: 变体。③**主导配对机械迁移 145 处 + body @apply，全部值级恒等零视觉变化**：text-ink 56（gray-900/white）、text-subtle 15（gray-600/gray-400）、text-muted 34（gray-500/gray-400）、bg-surface 4（white/gray-800）、bg-raised 4（gray-200/gray-700）、hover:bg-raised 10、border-line 19（gray-200/gray-700）、divide-line 1、bg-canvas 3（gray-50/gray-900，含 style.css body）。④**少数派配对约 60 处不动**（text-gray-900 dark:text-gray-100/gray-400、text-gray-600 dark:text-gray-300、text-gray-400 dark:text-gray-500、bg-gray-50/gray-100 dark:bg-gray-800、border-gray-300 dark:border-gray-600 等）——同语义多档属 #2 逐案判断范围，本项只锁定主导口径。验证：vue-tsc 0 错误、vitest 59/59、biome 0 错误、vite build 成功 + 产物 CSS 实证 9 个语义类全部生成且引用 var()。实锤留痕：①**sed 子串误并**——TaskBoard 的 `hover:bg-gray-200 dark:bg-gray-700`（hover 浅色 + dark **基础色**，dark hover 本是 gray-600）被「无变体配对」模式的子串匹配错误塌缩成 `hover:bg-raised`，经全量前缀变体扫描（`([a-z-]+:)+<token>` 计数）定位 2 处并还原；此后配对迁移 sed 之后必须跑前缀扫描对账。②Windows Git Bash 下 `rg -l` 输出反斜杠路径被 xargs 当转义符吞掉（`componentsConfirmDialog.vue`），须 `rg --null | xargs -0`。取舍立此存照：var() 形式的语义色不支持 `/opacity` 修饰（`bg-surface/50` 不会生成，需要透明度时用具体色值）；body 文字保持 `text-gray-900 dark:text-gray-100`（dark gray-100 ≠ token 的 white，归 #2）；`.md-content` 表格边框随 --border 取值微调（gray-300→gray-200，与全站主导边框一致）。

> **P1-2 修复记录（2026-09-04，同语义多 hue 并存）**：逐处读码后发现 accent 四 hue 并非随机混用而是**半成形的语义分层**——purple 全部 4 处均为 agent 身份（成员列表头像 `member_type==='agent'`、DM agent 徽标、档案 agent 徽标），sky 全部 2 处均为 agent 实时活动（MessageRow 进度条、AgentObsStream 观察流）。据此定稿**色族语义表**：成功=green（主导 60 处）/ 警告=amber（主导 82 处）/ accent=blue / **agent=purple（身份+活动统一）**。收敛执行：emerald→green 12 处、yellow→amber 13 处（sed 全词替换，diff 逐行复核无越界）、sky→purple 8 处（agent 活动并入 agent 身份色，blue 保持纯交互 accent）；violet 实际 0 处（审计计数已过时）；teal/lime/cyan/orange/rose/fuchsia/pink/indigo 全仓扫描均 0。注意本项是**有意视觉变化**（hue 偏移即收敛目的），与 P1-1 的值级恒等不同。验证：vue-tsc 0 错误、vitest 59/59、biome 0 错误、vite build 成功；残留扫描 emerald/yellow/sky/violet 全 0，收敛后 green 73 / amber 95 / purple 18。

> **P1-3 修复记录（2026-09-04，浅色模式深色孤岛）**：①**MentionPopup** 双模式化并直接用 P1-1 语义 token——容器 `bg-gray-800 border-gray-600` → `bg-surface border-line`，未选中项 → `text-ink hover:bg-raised`，头像圈 → `bg-raised`，次级名 → `text-muted`（dark 由 gray-500 微升为 gray-400，对比度顺带改善）。②**ThinkingIndicator**——容器 `bg-gray-800/80` → `bg-gray-100/80 dark:bg-gray-800/80`（var() 语义色不支持 /opacity 修饰，见 P1-1 取舍），agent 名 `text-amber-400` → `text-amber-600 dark:text-amber-400`（浅底对比度），正文 → `text-muted`。③**AgentObsStream 核实为误报不改**——其父容器 AgentTerminalPanel:237 是无条件 `bg-gray-950` 的终端面板（:231/:245 原始终端同），组件深色样式位于刻意的控制台语境内，与 `.md-content pre`（恒 #0d1117）/ComputerView:470 token 命令块同性质。④**审计漏报补录**：`components/message/MentionPopover.vue:57` 存在同款深色弹层，但全仓零引用属死代码——不做样式修复，加入 §5 死代码清单（删除归 P2 批）；`ui/Tooltip.vue:40`（bg-gray-900 text-white 无条件）为双模式深色 tooltip 惯例，保留。全量复扫无条件 `bg-gray-800/900/950` 确认无其他孤岛。验证：vue-tsc 0 错误、vitest 59/59、biome 0 错误（Edit 引入 CRLF 由 --write 归一，diff 复查两文件各 +4/-4 无扩散）、vite build 成功。

> **P1-4 修复记录（2026-09-04，focus-visible）**：①**可见性指标全站 `focus:` → `focus-visible:` 迁移 17 处**——ring-2/ring-blue-500(/30)/ring-blue-300/ring-gray-300/ring-red-300/ring-offset-*/opacity-100（含 Button 的 `dark:focus:` 组合变体）；键盘导航出焦点环、鼠标点击不再闪环。**`focus:outline-none` ×7 保持不动**——若一并改 focus-visible 则鼠标点击会露出浏览器默认 outline，抑制须恒在、指标才随键盘出。②**三个搜索框补 ring**（SearchView:75 / SearchBar:97 / SearchPane:76，均 `focus:border-blue-500 focus:outline-none` 无环）——补 `focus-visible:ring-2 focus-visible:ring-blue-500/30`，与 ui/Input、ui/Textarea 原语同构（后两者经①自动迁移）。③全站其余交互元素核查：仅 7 处 outline-none 且现已全部有环，无 outline-none 的按钮保留浏览器默认焦点轮廓（可见），无缺口。④`focus:border-blue-500` ×6 保持 focus:——输入框获焦即应变色（含鼠标），输入框的 focus-visible ≈ focus 无需区分。取舍立此存照：SearchBar/SearchPane 已在 §5 死代码清单（P2 删除批），仍一并补环防复活时带缺陷回归。验证：vue-tsc 0 错误、vitest 59/59、biome 0 错误、vite build 成功 + 产物 CSS 实证 focus-visible 规则生成；残留 `focus:ring|focus:opacity` 扫描 0。

> **P1-5 修复记录（2026-09-04，Modal a11y）**：`ui/Modal.vue` 单点修复、8 个消费方（ConfirmDialog/CreateChannelModal/ChannelSettingsModal/TaskDetailModal/ChatPane/ChannelView/ComputerView/TaskBoard）全量受益。①**语义**：面板 `role="dialog" aria-modal="true"` + 新增可选 `label` prop（aria-label，不传则依赖弹窗内可见标题）。②**焦点陷阱**：Tab/Shift+Tab 在面板可聚焦元素间循环（FOCUSABLE 选择器 + offsetParent 可见性过滤），焦点逃出面板时拉回两端。③**初始聚焦**：打开时 nextTick 聚焦第一个可聚焦元素，无则聚焦面板本身（tabindex=-1 + outline-none）。④**焦点归还**：关闭时聚焦回打开前的 activeElement。⑤**滚动锁定**：打开时 body overflow hidden，关闭还原前值。⑥**两种挂载形态均覆盖**：`:open` 响应式（ComputerView 等，走 watch）与静态 `open` + 父级 v-if（ConfirmDialog，走 onMounted）；卸载时兜底 deactivate。叠放场景（Modal 上开 ConfirmDialog）滚动锁前值串链正确。取舍立此存照：附件 lightbox（AttachmentView）/抽屉（MemberProfileDrawer）/AppLayout 移动抽屉三处手写 `fixed inset-0` 非 Modal 消费方，未纳入本次（语义非 dialog 模态，归后续）；a11y 行为为运行时可交互逻辑，web 测试是 node 环境无组件挂载设施，验证靠 vue-tsc 0 错误 + vitest 59/59 + biome 0 错误 + vite build 成功 + 读码复核，未做浏览器实测。

> **P1-6 修复记录（2026-09-04，Button 原语被绕行）**：5 文件 7 处手写按钮迁 ui/Button，使用量 15→20 文件。①**ConfirmDialog**——cancel → `variant="secondary"`，confirm → `:variant="danger ? 'danger' : 'primary'"`（danger 三态语义原样保留）。②**EmptyState**——action → primary md，类名单逐值恒等，零视觉变化。③**ErrorBoundary**——重试 → primary；刷新页面 → secondary。④**ChannelMembersPanel/OrgMembersPanel 邀请按钮** → primary sm。**迁移即白得** focus-visible 环、active:scale、disabled:cursor-not-allowed 与 loading 插槽能力。**有意视觉变化清单**（收敛意图内，与 P1-2 同性质）：cancel 文字 gray-700/dark:gray-300 → secondary 口径 gray-900/dark:white；ErrorBoundary 刷新按钮 gray-600 深灰双模式 → secondary 浅灰/gray-700（顺带 rounded→rounded-md 向 #7 主导档靠拢）；邀请按钮 text-sm→text-xs、px-2/3→px-2.5+py-1、disabled:opacity-50 → disabled:bg-blue-300（禁用口径与全站 Button 统一）。**保留不动立此存照**：MessageComposer:267 发送按钮——9×9 图标方形 + canSend 双态配色（灰↔蓝）非 Button variant 语义（Button 禁用是浅蓝非灰）；OnboardingChecklist:92 RouterLink——anchor 导航语义，Button 仅渲染 button 不支持 as；TaskBoard 过滤 tab / MentionPopup 选中态 / ChannelSettingsModal·CreateChannelModal 选择卡 / NotificationSettings toggle / logo·头像·Toast 配色均非按钮语义；MentionPopover 系 §5 死代码不动。验证：vue-tsc 0 错误、vitest 59/59（组件迁移无测试面）、biome 0 错误、vite build 成功；残留扫描 `hover:bg-blue-500` 仅余 Button 本体 + 上述两处立此存照。

> **P1-7 修复记录（2026-09-04，圆角五档混用）**：**①成文规则定稿并写入 `style.css` 顶部注释**（规则活在代码库，新组件先查后落）——按 ui 原语事实标准分层：`rounded`=小件（徽标/标签/行内 code/方形小头像/骨架/媒体图/xs 控件/内容行 hover 容器）、`rounded-md`=标准控件（Button md/lg、Input/Textarea、IconButton/NavItem、Tooltip、下拉）、`rounded-lg`=容器（Card/Modal/面板/嵌入式预览卡）、`rounded-xl`=特大容器（MetricsDashboard 大卡、ComputerView 大图标块）、`rounded-full`=圆形（Avatar/状态灯/loading 圈）。**②67 处裸 rounded 全量分类**——约 55 处本就符合「小件=rounded」档（徽标贴片、方形头像、code、Skeleton、终端内小件、消息行/成员行 hover 容器等），不动。**③同档发散修正 8 处**：输入框×3（OrgMembersPanel/ChannelMembersPanel 邀请输入、MessageRow 编辑框）rounded→rounded-md 对齐 Input/Textarea 原语；SidebarSection 折叠行项 rounded→rounded-md 对齐 NavItem；NotificationBell 铃铛 rounded→rounded-md 对齐 IconButton；卡片×3（LinkPreview 链接预览卡、TaskBoard 任务卡、AttachmentView 附件卡）rounded→rounded-lg 对齐 Card/Modal。点名案例 ErrorBoundary 裸按钮已由 P1-6 迁移 Button 顺带消除；MentionPopover 系 §5 死代码不动。视觉变化：8 处圆角 4px→6px/8px，属层级语义化的有意微调（与 P1-2 同性质）。验证：vue-tsc 0 错误、vitest 59/59、biome 0 错误、vite build 成功；实测计数（同口径词边界 grep）：裸 rounded 67→59（−8 即升级数）、rounded-md 60→65、rounded-lg 38→41、rounded-xl 8 与 rounded-full 39 不变。

> **P1-8 修复记录（2026-09-04，对比度不达标）**：**①amber 两处根治（2.3:1 → 8.6:1）**——amber-500 底配深字（amber 系警告惯例）：Toast warning 的 kindStyles 新增 `fg` 前景字段（warning=text-gray-900，其余保持 text-white），容器 `text-white` 恒值改绑 `fg`，关闭按钮 `text-white/70 hover:text-white` → `opacity-70 hover:opacity-100`（currentColor 派生自动随 fg）；AppLayout 离线条 text-white → text-gray-900。其余 amber-500 现场核查均非文字底（ConnectionStatus/PasswordStrength/TaskDetailModal/MetricsDashboard 状态点与色块、ThinkingIndicator dot），不动。**②text-gray-400 浅色端大迁移**——`text-gray-400 dark:text-gray-500` 反转对 15 处 + `text-gray-400 dark:text-gray-600` 1 处 → `text-muted`（双向改善：light 400→500 达标、dark 500/600→400 变亮）；裸 `text-gray-400`（双模式无条件）约 148 处/39 文件 → `text-muted`（dark 端不变、light 端 2.5→4.8:1 过 AA 4.5）——重灾区 PeopleView/ComputerView/TaskBoard/MemberProfileBody 抽查全部为真实次级正文（加载/空态/@handle/时间戳/表单 label/dt 项），无装饰性例外。perl 词边界负断言 `(?<![:\w-])…(?![\w-])` 保护前缀变体：`placeholder:` ×3（WCAG incidental 豁免 + Input/Textarea 原语口径）、`dark:text-gray-400` ×18（dark 端达标）、`hover:` 交互态全部原样。**③保留立此存照**：AgentObsStream 终端深底内 2 处裸 400（深底上 7:1 达标且属终端配色）；未读红徽标 `bg-red-500 text-white`（3.7:1，iOS/Slack 同款行业惯例，审计未点名）。实测 text-muted 34→200。验证：vue-tsc 0 错误、vitest 59/59、biome 0 错误（perl -pi 保留 LF 无需归一）、vite build 成功。**至此 §4.1 设计系统纪律 #1~#8 全部清零**。

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
| 14 | **密码策略不一致**：ForgotPasswordPage.vue:41 要求 ≥6 位 vs RegisterPage.vue:44-51 ≥8 位+字母数字。⚠️ 2026-09-01 server P1.20 补齐 forgot/reset-password 端点（reset 走 server `validatePassword` ≥8+字母+数字）后，从「文案不一致」升级为实锤的「客户端过、server 拒」——`abc123`（6–7 位）、`abcdefgh`（纯字母）均过客户端被 server 400；失败文案可透传（:51）故非静默断裂，修法仍是对齐 ≥8+字母+数字（§8.2） | — |
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

- **死代码**：`panes/ActivityPane.vue`、`panes/SearchPane.vue`、`chat/SearchBar.vue` 全仓库零引用（侧栏两列化设计修订残留）；2026-09-04 增补：`message/MentionPopover.vue` 全仓零引用（P1-3 排查深色孤岛时发现，同款深色弹层系 chat/MentionPopup 的前身残留）；`messageStore.ts:113-130` `sendMessage` 死代码（无 clientNonce，与 enqueuePending 双轨）；`wsDispatch.ts:1` 未使用 import（biome 可自动修）。2026-09-04 增补：`taskStore.ts` 整 store 与 `channelStore.joinChannel/leaveChannel`（传频道名 vs server 只认 UUID）亦为死代码，与 server 报告 §3 drift #7/#8 互证，建议一并删除（§8.2）。
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

**第一梯队（正确性，1-2 天）**：~~P0-1 心跳对齐（server 一行改动）~~（✅ 2026-09-01 已由 server P1.21 落地，web 零改动）→ ~~P0-2 线程回复链路（wsDispatch 重写该分支 + key 约定统一）~~（✅ 2026-09-04 落地，见 P0-2 小节行内记录）→ ~~P0-3 补三个 animate 类~~（✅ 2026-09-04 落地，见 P0-3 小节行内记录）→ ~~P0-4 DEV 门禁~~（✅ 2026-09-04 落地，见 P0-4 小节行内记录）。**P0 段已清零**，server 侧 P0/P1 落地带来的适配增补（含 2 个新 P1）见 §8。

**第二梯队（设计系统收敛，2-3 天）**：
1. ~~把 style.css 已有变量接入 tailwind.config `theme.extend`~~（✅ 2026-09-04 落地，见 §4.1 P1-1 修复记录——含 token 值对账 + 主导配对迁移 145 处；圆角/字号档归 #7/P2）；
2. ~~语义色归一~~（✅ 2026-09-04 落地，见 §4.1 P1-2 修复记录——色族语义表定稿：成功 green / 警告 amber / accent blue / agent purple）；
3. ~~Modal 补 role/focus trap/滚动锁定（一处修复全站受益）~~（✅ 2026-09-04 落地，见 §4.1 P1-5 修复记录——另含初始聚焦/焦点归还/aria-modal，8 个消费方全量受益）；
4. ~~全站 `focus:` → `focus-visible:` 替换 + 三个搜索框补 ring~~（✅ 2026-09-04 落地，见 §4.1 P1-4 修复记录——outline-none 抑制保持恒在，仅指标迁移）。

**第三梯队（状态与测试，持续）**：messageStore 加 error 字段消灭「错误伪装成空态」；highlight.js 按需注册拆包（index 预计降至约 400 kB）；authStore + api + 6 个 store 补单测；确认 localStorage 消息缓存口径。

---

## 8. 适配增补：server 侧 P0.1–P0.11 / P1.12–P1.33 落地后的对照核查（2026-09-04）

> **背景**：本审计成文于 2026-08-31；server 评估报告（`docs/2026-08-28/01-server-evaluation-report.md`）的 P0.1–P0.11 与 P1.12–P1.33 于 2026-08-30 ~ 09-04 全部落地，与本审计时间线交叠。其中多项收紧直接改变了 web 面对的 API 契约（新 400/403/409、admin 门禁、应用层心跳、通知字段口径），本节是对照核查结论。
> **方法**：2 路并行 subagent 对全部受影响契约触点逐一读码核实（file:line 证据），主会话对其中唯一的「真 bug 级」发现（W-A1）人工复核确认。结论分四类：已被 server 消除（§8.1）、含义/优先级变化（§8.2）、新增适配项（§8.3）、核实后确认无需适配（§8.4，防止过度反应）；§8.5 刷新基线数字。

### 8.1 已被 server 侧消除的本报告条目

| 条目 | server 修复 | 核实结论 |
|---|---|---|
| **P0-1 心跳看门狗**（空闲 70s 强制重连） | P1.21（2026-09-01）：server 每 30s 对浏览器连接发 JSON `{type:"ping"}`（`server/src/ws/handler.ts`，HEARTBEAT_INTERVAL=30s） | `wsManager.ts:132-134` ping→pong 分支复活，任何入站帧喂狗、30s < 70s 阈值，**web 零改动、无需动**（P0-1 小节已行内标记） |

### 8.2 含义/优先级发生变化的条目

1. **P1-14（密码策略不一致）升级为实锤路径**：server P1.20（2026-09-01）补齐 forgot/reset-password 端点，reset 走 `validatePassword`（≥8+字母+数字）。`ForgotPasswordPage.vue:41-44` 客户端仅验 ≥6——「客户端过、server 拒」实锤（`abc123` 6–7 位、`abcdefgh` 纯字母均如此）。server 400 文案可透传故非静默断裂，修法不变：客户端规则对齐 ≥8+字母+数字。
2. **P2「authStore 仅凭 localStorage 判登录 + api 无 401 拦截」建议升级 P1**：server P1.15 fail-closed 后（无 sid 存量 token 一律拒、logout-all/改密后 WS 握手 4001），「假登录态」从理论风险变日常可见。新实锤：`wsManager.ts:28` 的 `onclose` 不接收 close code → 4001 与其他断线同等进入无限指数退避重连（`wsManager.ts:142-151`），每次携同一失效 cookie 再被 4001；REST 全部 401 只在局部报错（`api/index.ts:38-41` 无状态码分支），UI 显示已登录。修法：apiClient 加 401 拦截 → 清 localStorage + 跳 /login；wsManager onclose 传 code、4001 停重连并触发登出。
3. **taskStore/channelStore 从「零测试」重判为「死代码，建议删除」**：`taskStore.ts` 全仓仅被 `stores/index.ts:7` re-export、零组件消费，且 `updateStatus/moveTask` 打在 `/api/tasks/:n/status`（server 只有 `/update-status`，与 server 报告 §3 drift #7 互证）；`channelStore.joinChannel/leaveChannel` 传频道名而 server `/:channelId/join` 只认 UUID、零调用方（drift #8）。TaskBoard 实际直打 `apiPost("/api/tasks/update-status")`（`TaskBoard.vue:157-173`）不经过 taskStore。§2.3 职责表与 §5 死代码清单已按此行内修订。

### 8.3 server 收紧带来的新增前端适配清单

| # | 级别 | 适配项 | server 来源 | 证据与修法 |
|---|---|---|---|---|
| W-A1 | **P1** ✅ 2026-09-04 已修复 | **通知 REST 蛇形列名 → 「NaN天前」+ 点击不跳转**（真 bug，主会话已复核） | P1.25 契约债（REST 蛇形 vs WS camelCase，server 报告已立此存照归后续） | `notificationStore.ts:57-58` loadFromApi 无映射原样入库（接口却声明 camelCase）；`NotificationBell.vue:7-13` `timeAgo(undefined)` → NaN → 全分支不命中显示 **"NaN天前"**（`:140` 调用处）；`:53` 点击跳转读 `channelId` → REST 项为 undefined **不跳转**。WS 实时到达的 camelCase 项正常。修法：loadFromApi 加 snake→camel 映射（一处），或 server SELECT 别名收口 |

> **W-A1 修复记录（2026-09-04）**：按首选方案落地——`notificationStore.ts` 新增导出 `mapApiNotification`（snake→camel 归一，对 camelCase 输入兼容透传：server 日后 SELECT 别名收口契约债后本映射无需改动），`loadFromApi` 入库前统一映射。store 层单点修复覆盖全部消费方（NotificationBell + ActivityView + ActivityPane 同链路口径）。验证：新增 `notificationStore.test.ts` +4 用例（蛇形映射+createdAt 可解析性/可空字段 null 归一/camelCase 透传/loadFromApi 端到端映射），49→53 全绿，vue-tsc 0 错误、biome 0 错误。
| W-A2 | **P1** ✅ 2026-09-04 已修复 | **消息长度上限前端化**：composer 计数 `/4000` 陈旧（server 上限实为 10000）且全站输入框无 maxlength | P1.33（content ≤10000，send/edit 双侧 400） | `MessageComposer.vue:287` 计数误导、`:251-261` textarea 无上限；`MessageRow.vue:248-254` 编辑框同。好消息：pending failed 永不自动重试（`messageStore.ts:270` 只挑 queued），**无 400 重试风暴**。修法：maxlength=10000 + 计数修正 |

> **W-A2 修复记录（2026-09-04）**：新建 `web/src/lib/limits.ts` 导出 `MAX_MESSAGE_CONTENT_LEN = 10_000`（注释锚定 server `validators.ts` 同源口径，server 仍是唯一强制点）。MessageComposer textarea 加 `:maxlength` + 计数 `{{ draft.length }}/{{ MAX_MESSAGE_CONTENT_LEN }}`（4000→10000，ThreadView 回复框复用 MessageComposer 一并覆盖）；MessageRow 编辑框加 `:maxlength`。全站 textarea 复扫：仅余 `ui/Textarea.vue` 通用原语（非消息入口，不加）。验证：53 用例不变（模板属性+常量无测试面——web 无组件挂载测试设施）、vue-tsc 0 错误、biome 0 错误。
| W-A3 | **P1** ✅ 2026-09-04 已修复 | **发送/编辑失败原因不可见**（P1.33 的 400/403 原因会被吞掉） | P1.33（threadId 400、content 400、移出私有频道后改删 403） | PendingRow 只有「⚠️ 发送失败」无 server 文案（`PendingRow.vue:32-36`）；ThreadView 回复失败 error 只在 `!parent` 时渲染（`ThreadView.vue:112,133`）——线程已加载时回复失败界面毫无反馈（仅草稿保留）；编辑失败静默（`MessageRow.vue:112-118` 注释明写 keep editing open）。修法：failed 态展示 server 原因（或对 4xx 标「不可重试」）、ThreadView 错误可见化、编辑失败补 toast |

> **W-A3 修复记录（2026-09-04）**：①PendingItem 新增可选 `failReason`（localStorage 持久化向后兼容），`setPendingStatus` 仅 failed 态留存原因（转 sending/queued 清除防陈旧残留），flushPending/retryPending 捕获 `err.message`（apiClient 本就透出 server 文案）；②PendingRow failed 态渲染「⚠️ 发送失败：\<原因\>」；③ThreadView 拆出独立 `sendError`——回复失败在 composer 上方红字透出 server 400/403 原因（不再与整页 load error 共用 `error` 而被 `!parent` 条件隐藏）；④MessageRow 编辑失败补 `toast.error`（对齐同文件 handleDelete 范式，编辑框保持打开）；⑤MessageComposer `doSend` 补 catch 吞异常——此前三个 onSend 实现失败时都 rethrow（为保草稿），事件处理器无人 await 产生 unhandled rejection，现由 onSend 侧各自提示、doSend 统一吞掉。验证：vitest 53→**55**（+2：flush 失败记录 failReason 并持久化+转 sending 清除、retry 再失败更新最新原因）、vue-tsc 0 错误、biome 0 错误。
| W-A4 | P2 ✅ 2026-09-04 已修复 | **admin 入口无角色感知**（非 admin 进 /admin/metrics 见红字 403 + 3s 轮询持续重试） | P1.30（/api/metrics admin 门禁；server 报告已声明前端门控归后续） | 调用点 `MetricsDashboard.vue:240`（3s 轮询）/`:226`（history 首载）；403 整页红字错误（`:250-265`，不崩溃、不落入「错误伪装成空态」）但轮询不停；UserMenu 入口全员可见（`UserMenu.vue:116-121`）。`/api/orgs` 已返回 personal+role，`WorkspaceMembers.vue:40` 已有 isOwner 推导先例 → admin 身份前端可推导。修法：入口/Tab 按推导门控 + 403 停轮询 |

> **W-A4 修复记录（2026-09-04）**：①新 composable `useInstanceAdmin`——模块级单例缓存，`/api/orgs` 推导 `!personal && role==="owner"`（与 server `isInstanceAdmin` membership 口径对齐：025 迁移+启动擢升已保证 owner 必有成员行，与 owner_id 双查等价）；拉取失败按非 admin（隐藏入口不漏权，admin 页 403 红字兜底）。②UserMenu「管理后台」入口 `v-if="isInstanceAdmin === true"`（加载中不渲染，无误闪）。③AdminPanel metrics tab 按推导过滤（null 加载期先显示，直链仍有 403 兜底）。④MetricsDashboard 403 停轮询——api/index.ts 新增 `ApiError extends Error`（带 `status`，message 不变全站零影响，也是 §8.2 #2 401 拦截的地基），catch 按 `status===403` clearInterval；顺带修复「成功不清 err」缺陷（瞬断后错误态曾永久滞留，现成功即清）。验证：vitest 55→**59**（新增 useInstanceAdmin.test.ts +4：owner 推导/个人空间不计/失败按非 admin/单例缓存）、vue-tsc 0 错误、biome 0 错误。取舍立此存照：角色中途变更不刷新缓存（刷新页面复位，P2 可接受）。
| W-A5 | P2 ✅ 2026-09-04 已修复 | **机器令牌 expires_at 未展示**（P1.12 的 90 天过期用户无感知，闲置令牌到期静默失效） | P1.12（90 天滚动续期；GET tokens 已返回 expires_at） | 令牌 UI 在 `IntegrationSettings.vue`（非 SecuritySettings）：`:12` 类型声明了 `expires_at` 但 `:89-90` 只渲染 prefix/created_at。修法：展示过期时间/「N 天后过期」；撤销无确认并入既有 P1-15 |

> **W-A5 修复记录（2026-09-04）**：`IntegrationSettings.vue` 新增 `expiryLabel`/`expiryClass` 两个模板 helper 并在令牌卡创建时间后追加过期信息——`expires_at` 为 NULL 显示「永不过期」；未过期显示「有效期至 \<date\>（N 天后过期）」，≤14 天 amber 警示；已过期显示「已于 \<date\> 过期」红色（过期令牌仍列于列表可撤销，不过滤）。核过 server 语义：`machine-token-policy.ts` ACTIVE_TOKEN_PREDICATE（NULL 豁免）+ `auth-token.ts:79-81` 活跃使用滚动续期 90 天，故「N 天后过期」对闲置令牌是真实死线、对活跃令牌随用随续（标签口径正确）。撤销无确认仍归 P1-15 不在本批。验证：59 用例不变（模板 helper 无测试面，与 W-A2 同口径）、vue-tsc 0 错误、biome 0 错误。
| W-A6 | P2 ✅ 2026-09-04 已修复 | **频道创建 409/400 英文文案直出 + 可选 maxlength** | P1.32（lower(name) 重名 409、name ≤100 400） | CreateChannelModal 客户端预检大小写敏感（`CreateChannelModal.vue:33`）且列表不含未加入的私有频道 → 两类漏检落 server 英文「channel already exists」（`:49` 原文透传）。修法：409 文案本地化 + `maxlength="100"`（体验项，功能不破） |

> **W-A6 修复记录（2026-09-04）**：`CreateChannelModal.vue` 三处——①客户端重名预检 `c.name === formatted` 改 `c.name.toLowerCase() === formatted`，对齐 server lower(name) 唯一索引口径（大小写变体本地即拦）；②新增 `localizeCreateError`：`status===409`（W-A4 落地的 ApiError.status 通道首个消费方）或 /already exists/i →「同名频道已存在（含大小写变体或你未加入的私有频道）」，/too long/i →「频道名过长（上限 100 字符）」，其余原文透传兜底；③频道名 Input 加 `maxlength="100"`（Input.vue 纯 fallthrough 包装，原生属性直达 input）。验证：59 用例不变（模板+纯函数映射无测试面）、vue-tsc 0 错误、biome 0 错误；Edit 引入 CRLF 由 `biome check --write` 归一，git diff 复查 +12/-2 无扩散。
| W-A7 | P2 ✅ 2026-09-04 已修复 | **看板可拖他人已认领卡**（server 403 英文 toast 兜底） | P1.33（tasks 归属校验：认领人/认领 agent 的 owner/频道管理） | TaskBoard 非乐观更新、成功后才 load()（`TaskBoard.vue:157-173`）无回滚问题；403 经 `toast.error(err?.message)` 透传英文文案；所有卡片恒 `draggable="true"`（`:300`），TaskDetailModal 状态下拉同。修法（可选）：按 assignee/当前用户角色禁用拖拽 + 文案本地化 |

> **W-A7 修复记录（2026-09-04）**：①TaskBoard 前端镜像 server `canTouchTask`（tasks.ts:17-25）四条款——未认领任何人可动 / `task_assignee === authStore.user.id` / 当前频道成员 role ∈ {owner, admin}（复用 `channelStore.fetchMembers`，watch channelId 触发）/ `task_assignee ∈ myAgentIds`（onMounted 拉 `/api/agents?mine=1`，失败降级为空集）。②体验层禁用：卡片 `:draggable` + dragstart 守卫 + 锁态样式（cursor-default/opacity-80/tooltip 说明）、卡片状态下拉 `:disabled`、`onDrop` 双保险；TaskDetailModal 新增 `canTouch` prop（withDefaults true，全仓唯一消费方 TaskBoard 按列表行推导传入）禁用其状态下拉。③403 文案本地化兜底：`localizeTaskError` / modal 内联同正则——「仅认领人（或认领 agent 的所有者）与频道管理可…」。实锤的对齐细节：members 端点返回 `role` 裸列（channels.ts:140），canManageChannel 口径 owner|admin（access.ts:156-159）。取舍立此存照：前端禁用只是体验层，members/agents 拉取失败按无权限降级（不误导放行），server 403 恒为最终强制点；列表视图本就无拖拽/状态下拉（只读+点开详情），无需处理。验证：59 用例不变（页面级交互无测试设施）、vue-tsc 0 错误、biome 0 错误、`vite build` 成功；biome --write 归一格式后 numstat 复查 +67/-7、+14/-3 无扩散。实锤留痕：初版 dragstart 用内联 `if (...) 赋值` 语句，**vue-tsc 不捕获、vite 模板编译直接报错**（dev server 500），抽成 `onCardDragStart` 方法修复——此后页面级模板改动须以 `vite build` 为最终验证，三件套不够。至此 §8.3 全部 7 项（W-A1~W-A7）清零。

### 8.4 核实后确认「无需适配」清单（防止过度反应）

- **RegisterPage**：400/409 文案经 apiClient 原文透传（`RegisterPage.vue:70` + `api/index.ts:38-41`），密码规则与 server `validatePassword` 逐条一致。可选小改进：email 加 `required`（占位符「用于找回密码」看似选填，server 实则必填）。
- **频道 type/visibility**：创建（CreateChannelModal 二选一档）/设置（ChannelSettingsModal）/admin（ChannelManagement 下拉）三处 UI 均只能产出 public|private，构造不出非法值，P1.32 白名单无前端破坏面。
- **LinkPreview**：preview 400/502 → catch 置 null → 整块不渲染（`LinkPreview.vue:44-65`），静默隐藏无破图，失败结果进缓存防重复请求。
- **WS 新事件分支已在位**：`notification.read`（`wsDispatch.ts:28-32`，含 2 用例）与 `agent:delivery-dead-letter` 双文案分支（`:84-94`，⚠️ daemon 离线 vs ❌ 重试耗尽）——P1.25/P1.26 落地时已同步改 web，无欠账。
- **心跳**：见 §8.1，P0-1 已闭环。

### 8.5 基线数字刷新

- §1 测试行：41 用例 → **43 用例**（5 文件；P1.25 为 wsDispatch +2 notification.read 用例）。其余基线（vue-tsc/biome/chunk 1.24MB）未复测，仍以 2026-08-31 为准。
- 2026-09-04 P0-2 落地复测：43 → **49 用例**（wsDispatch +3 线程链路、messageStore +3 receiveThreadReply/backfill 护栏），vue-tsc 0 错误、biome 0 错误。
- 2026-09-04 P0-3 落地复测：49 用例不变（纯 CSS 修复无测试面），vue-tsc 0 错误、biome 0 错误。
- 2026-09-04 P0-4 落地复测：49 用例不变，vue-tsc 0 错误、biome 0 错误；prod/dev 双模式构建成功 + 生产产物浏览器 DOM 实证按钮已除（chunk 1.24MB 基线不变，死代码残留见 P0-4 小节）。至此 P0-1~P0-4 全部落地。
- 2026-09-04 W-A1 落地复测：49 → **53 用例**（新增 `notificationStore.test.ts` +4），vue-tsc 0 错误、biome 0 错误。实锤留痕：P0-4 的 biome 校验此前被 `| tail` 管道吞掉退出码（pipefail 未开），本次发现 LoginPage.vue 行尾被编辑引入 CRLF 混入，已 `biome check --write` 归一（git diff 仍 +8/-1 无污染），后续验证命令注意 biome 需直跑看退出码。
- 2026-09-04 W-A2 落地复测：53 用例不变（模板属性+常量无测试面），vue-tsc 0 错误、biome 0 错误。实锤留痕：①验证三件套一度全红系工作目录被前序 git 命令带至仓库根（monorepo 全量 vitest/tsc/biome 假警），验证必须锁定 `packages/web`；②Edit 再次向 MessageComposer.vue 引入 CRLF 由 `biome check --write` 归一，git diff 复查 +3/-1 无扩散。
- 2026-09-04 W-A3 落地复测：53 → **55 用例**（messageStore.backfill-pending +2 failReason 用例），vue-tsc 0 错误、biome 0 错误。至此 §8.3 的 3 个 P1 适配项（W-A1/A2/A3）全部清零，余 W-A4~A7（P2）。
- 2026-09-04 W-A4 落地复测：55 → **59 用例**（新增 useInstanceAdmin.test.ts +4），vue-tsc 0 错误、biome 0 错误。新增 `ApiError`（api/index.ts）为后续 §8.2 #2 的 401 拦截登出备好状态码通道。
- 2026-09-04 W-A5 落地复测：59 用例不变（模板 helper 无测试面），vue-tsc 0 错误、biome 0 错误。§8.3 适配清单余 W-A6/W-A7（P2，体验项）。
- 2026-09-04 W-A6 落地复测：59 用例不变，vue-tsc 0 错误、biome 0 错误。§8.3 适配清单仅余 W-A7（P2，看板拖拽按归属禁用，可选）。
- 2026-09-04 W-A7 落地复测：59 用例不变（页面级交互无测试设施），vue-tsc 0 错误、biome 0 错误、`vite build` 成功（含内联 handler 编译事故修复，见 W-A7 修复记录实锤留痕）。**§8.3 server 收紧适配清单 W-A1~W-A7 全部清零**；§8 余量为 §8.2 两项（P1-14 密码策略对齐、authStore/401 拦截升 P1 建议）。
- server 变更时间线对照：P1.20（09-01 forgot/reset 上线 → P1-14 升级）；P1.21（09-01 心跳 → P0-1 消除）；P1.25（09-02 通知 → W-A1）；P1.30（09-03 metrics 门禁 → W-A4）；P1.31/32（09-03 注册/频道收紧 → §8.4 确认无碍 + W-A6）；P1.33（09-04 消息/任务收紧 → W-A2/W-A3/W-A7）。
- 2026-09-04 P1-1（Token 形同虚设）落地复测：59 用例不变（纯 class 迁移无测试面）、vue-tsc 0 错误、biome 0 错误、vite build 成功 + 产物 CSS 实证 9 个语义类生成。7 个语义 token 接入 tailwind.config，主导事实配对迁移 145 处（值级恒等）；TaskBoard 2 处 sed 子串误并已还原（详见 §4.1 P1-1 修复记录实锤留痕）。**§4.1 设计系统纪律余 #2~#8**（语义色归一/深色孤岛/focus-visible/Modal a11y/Button 绕行/圆角规则/对比度）。
- 2026-09-04 P1-2（同语义多 hue 并存）落地复测：59 用例不变、vue-tsc 0 错误、biome 0 错误、vite build 成功。emerald→green 12 / yellow→amber 13 / sky→purple 8（agent 活动并入 agent 身份色），色族语义表定稿（green 成功 / amber 警告 / blue accent / purple agent），残留 hue 扫描全 0。**§4.1 余 #3~#8**。
- 2026-09-04 P1-3（浅色模式深色孤岛）落地复测：59 用例不变、vue-tsc 0 错误、biome 0 错误、vite build 成功。MentionPopup/ThinkingIndicator 双模式化（复用 P1-1 语义 token）；AgentObsStream 核实为误报（父容器是无条件 bg-gray-950 终端面板）不改；审计漏报 MentionPopover 同款弹层查实零引用、转 §5 死代码清单。**§4.1 余 #4~#8**。
- 2026-09-04 P1-4（focus-visible）落地复测：59 用例不变、vue-tsc 0 错误、biome 0 错误、vite build 成功 + 产物 CSS 实证 focus-visible 规则生成。可见性指标 17 处 focus:→focus-visible:（outline-none ×7 保持恒在抑制），三搜索框补 ring 与 Input/Textarea 原语同构。**§4.1 余 #5~#8**（Modal a11y/Button 绕行/圆角规则/对比度）。
- 2026-09-04 P1-5（Modal a11y）落地复测：59 用例不变、vue-tsc 0 错误、biome 0 错误、vite build 成功。ui/Modal 单点补齐 role=dialog/aria-modal/焦点陷阱/初始聚焦/焦点归还/滚动锁定，8 消费方全量受益；手写遮罩三处（AttachmentView/MemberProfileDrawer/AppLayout 抽屉）非 dialog 语义未纳入。**§4.1 余 #6~#8**。
- 2026-09-04 P1-6（Button 原语被绕行）落地复测：59 用例不变（组件迁移无测试面）、vue-tsc 0 错误、biome 0 错误、vite build 成功。5 文件 7 处手写按钮迁 ui/Button（使用量 15→20 文件），cancel/刷新/邀请三处含收敛意图内的微调色差（详见 §4.1 P1-6 修复记录清单）；MessageComposer 发送图标按钮与 OnboardingChecklist RouterLink 形态/语义不覆盖立此存照。**§4.1 余 #7~#8**（圆角规则/对比度）。
- 2026-09-04 P1-7（圆角五档混用）落地复测：59 用例不变、vue-tsc 0 错误、biome 0 错误、vite build 成功。成文规则写入 style.css 顶部注释（小件 rounded / 控件 rounded-md / 容器 rounded-lg / 特大 rounded-xl / 圆形 rounded-full）；67 处裸 rounded 全量分类、约 55 处本符合小件档不动，同档发散修正 8 处（输入框×3→md、侧栏行项+铃铛→md、卡片×3→lg），实测裸 rounded 67→59。**§4.1 余 #8**（对比度）。
- 2026-09-04 P1-8（对比度）落地复测：59 用例不变、vue-tsc 0 错误、biome 0 错误、vite build 成功。amber-500 底两处改深字（2.3→8.6:1）；text-gray-400 浅色端约 164 处迁 text-muted（反转对 16 + 裸 148，词边界保护 placeholder/hover/dark 前缀变体），AgentObsStream 终端深底与未读红徽标保留立此存照；text-muted 34→200。**§4.1 设计系统纪律 #1~#8 全部清零**，§4 余量转入 §4.2/§4.3/§4.4（实时正确性 #9~#10、状态完整性 #11~#16、工程 #17~#19）。

---

## 附录：审计口径

- 分析覆盖：packages/web 全部 117 个源文件（4 路 subagent 分区深扫：架构数据流 / 设计系统 / 页面 UX / 工程健康）。
- 所有 P0 断言由主会话 grep/读码复核确认（2026-08-31）；P1/P2 均带 `文件:行号` 或 grep 计数证据。
- 工程数字（测试 41 例、chunk 1.24 MB 等）来自当日真实命令输出。
- 未做：浏览器实测（Lighthouse/视觉走查）、server 侧全量审计（仅追查了心跳与消息格式两个交叉点）。
