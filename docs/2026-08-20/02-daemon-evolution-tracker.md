# Daemon 演进推进文档（执行跟踪）

> 创建：2026-08-20 · 方案依据：`docs/2026-08-20/01-daemon-evolution-plan.md`
> 使用方式：
> 1. 「当前焦点」永远只指向**一个**在做的任务，开工前更新；
> 2. 完成一项勾一项，注明 commit 短哈希与日期；
> 3. 完成整个 Step 后，在文末「完成记录」表补一行；
> 4. 本文件是执行面，方案 rationale 改 01，不改这里。

---

## ★ 当前焦点

> **评估报告 P1.14 统一错误模型已落地**（2026-08-26）。
> 下一焦点：评估报告剩余 P1.x / P2 项（按评估报告排序）。
> 注意：「评估报告 P0.x」与本文件「方案 P0.1 = PTY 冻结」（Step 3，已完成）不是同一件事。

---

## 推进规则（三条不可调换）

1. **P0.5（Step 1）先于 P0.1/P0.3（Step 2/3）**——没有测试网，不动幸存主干；
2. **D3（Step 4）先于 D1（Step 6）**——仪表先于增耗；
3. **`agent-runtime-dispatch.ts` 串行新功能**——Step 3 后 PTY 分支冻结不动，
   T8（加 triage）→ D1（加 Context Builder 前置）依次落地，不同时开工。

并行许可：Step 4（成本记账）与 Step 0~3 零代码交集，任何空档均可插入；
Step 6 的**设计文档**可在 Step 5 开发期间并行写。

---

## Step 0 · 修地图 + 死代码（当天，零风险）✅ 2026-08-20

- [x] S0.1 重写 CLAUDE.md「当前状态」段（49 文件 / headless 默认 / 模块索引），删除
      已过时的「12 文件 447 行单体」描述与 Goal Mode 协议中失效的文件引用
      → 已全文重写；Goal Mode 协议段标记完结归档（goal-progress.json：41 项 ALL-DONE）；
      设计文档索引补齐 00/07/completion-analysis 与 08-16 起全部近期文档
- [x] S0.2 `docs/2026-07-15/01-current-state-inventory.md` 头部加「已被 2026-08-20
      核查取代，见 docs/2026-08-20/01」标注
- [x] S0.3 删除 `packages/adapter-layer/`（空壳：仅 dist/node_modules，不在 workspace）
      → 已删（双重核查：子代理全量读文件 + Select-String 复查，零引用）
- [x] S0.4 删除 `packages/daemon/src/drivers/claude.ts`（先 `grep -r ClaudeDriver`
      确认无引用再删）→ 已删（全仓零引用确认）
- [x] S0.5 `agent-stdin-writer.ts` 头注标 deprecated（仅打日志不真实写入，防误用）
      → **修正为直接删除**：核查确认零调用方，连同 types/index.ts 中仅被它消费的
      `IStdinWriter`/`StdinWriteStrategyType` 两个死类型一并移除

**验收**：仓库内不再存在「描述与代码不符」的入口文档；`pnpm -r build` 通过。 ✅
（附加：daemon vitest 17 文件 / 135 用例全绿）

---

## Step 1 · 测试最小集（2~3 天）✅ 2026-08-20（实际 <1 天）

> **⚠️ 前提修正（2026-08-20 Step 0 实测）**：「daemon 近零测试」不成立——现有
> 17 个测试文件 / 135 用例（含 agent-tokens、live-run-registry、command-presets、
> post-start-input-writer、round-end-detection、patrol-prompt 等）。
> **开工前先做覆盖盘点**：下列四个目标模块哪些已有测试、哪些是真空，只补真空。
> 预估随盘点结果重估（大概率小于 2~3 天）。

- [x] S1.0 覆盖盘点 → **结论：S1.1/S1.4 已覆盖，S1.2/S1.3 是真空**
  - `agent-dispatch-queue.test.ts`（10 例）：直通/合并/退避/死信/去重窗口/in-flight
    超时/部分死信全部在测；
  - `agent-tokens.test.ts`（15 例）：含 revokeIfMatches 竞态保护（stale token 不误删新
    token——Node 单线程语义下该用例即为竞态覆盖）；
  - `agent-runtime-state.ts`、`PersistentClaude`：零测试。
- [x] S1.1 `agent-dispatch-queue` → 现有 10 例已覆盖全部要求项，无需新增
- [x] S1.2 `agent-runtime-state` → **新增 `test/agent-runtime-state.test.ts`（16 例）**：
      合法链/非法迁移被吞且状态不变（6 参数化）/同态 no-op/getWorkingAgents/startup timer
      （**修正 tracker 描述**：非法迁移实际语义是 warn+吞掉不抛错，测试按实现语义断言）
- [x] S1.3 `PersistentClaude` → **新增 `test/persistent-claude.test.ts`（9 例）**：
      result resolve / 串行排空 / mid-turn exit reject + onExit / 沉默超时 kill 后换
      进程续排 / 事件续命不 kill / stop() 全拒 / spawn 失败 / 分片解析 / 非 JSON 行忽略
      （spawn 全 mock，真实短延时计时器）
- [x] S1.4 `agent-tokens` → 现有 15 例已覆盖（见 S1.0）

**验收**：`pnpm vitest run`（packages/daemon）四模块核心路径全绿。 ✅
（19 文件 / **160 例**全绿，净增 25 例）

> **📌 遗留观察（不阻塞，记入 L5 类调优）**：PersistentClaude 沉默超时 kill 后，
> 旧进程的 exit 事件若晚于新进程进入 in-flight 才到达，exit handler 会误 reject
> **新**进程的 activeTurn（kill→exit 通常毫秒内到达，窗口极小）。修复方向：exit
> handler 校验被拒回合与进程的绑定关系（如记录 turn.proc 再 reject）。Step 3 删除
> PTY 后此路径是唯一进程管理路径，建议 Step 6 前顺手修掉。
>
> **✅ 2026-08-24 已修**（评估报告 P0.1）：`procGen` + turn.gen 绑定；超时立即
> settle 当前回合，迟到 exit/stdout/error 忽略；`onExit` 仅当前进程真实退出触发。
> 回归用例见 `test/persistent-claude.test.ts`。

---

## Step 2 · WS 类型对齐（1~2 天）✅ 2026-08-20（实际 <1 天）

- [x] S2.1 线协议盘点（graph 双子代理 + 人工精读 handler.ts/daemon-core.ts 复核）：
      **四方向全量消息表**（见本 Step 末尾附录）。盘点修正了多处规划期错误认知：
      - 死信/排队实际前缀是 `agent:`（`agent:delivery-queued/dead-letter`）；
      - `reminder.upsert/cancel/snapshot`、`agent:deliver:ack`、`agent:activity_probe`
        **均不在线上**（reminder 同步走 REST，ACK 从未实现）；
      - `connected` 两类载荷分裂：daemon 收 `serverTime`，browser 收 `time`；
      - 心跳是 WS 协议层 ping/pong，JSON ping/pong 为遗留兼容；
      - `agent:activity` server 有 case 但 daemon 从不发送（死 case）。
- [x] S2.2 重写 `packages/shared/src/index.ts` WS 段：四方向 union
      `WsToDaemonMessage` / `WsFromDaemonMessage` / `WsToBrowserMessage` /
      `WsFromBrowserMessage` + 共享构件（`WsDeliverMessage`/`ObservationFrame`/
      `WsNotification`/`WsReminderFire`/`WsChannelBroadcast`）；
      旧名保留为 `@deprecated` 别名（web 装饰性使用，过渡期不打破）。
- [x] S2.3 daemon、server 改为 import shared 类型，删除本地重复定义：
      - `ObservationFrame` 规范定义上移到 shared，`agent-observation.ts` 改为 re-export；
      - `daemon-core.ts`：新增 `sendWs(WsFromDaemonMessage)` 唯一出口（11 处发送点全部
        收敛，tsc 校验载荷）；`handleMessage` 参数类型化为 `WsToDaemonMessage`
        （接收体保留防御性解析——线协议有 thread_id 蛇形/msg.message||msg 双路径等
        松散变体，注释说明）；
      - `handler.ts`：`sendToDaemon`/`sendToUser`/`broadcast` 参数类型化；两个 parse
        点分别断言为 `WsFromDaemonMessage`/`WsFromBrowserMessage`；
      - 调用方对齐：notifications.ts（event 注解 + row as any）、agents-dispatch.ts /
        agents-messages.ts（INSERT RETURNING 行类型化）、agents-public.ts（两行 as any）；
      - **删除 server 死 case `agent:activity`**（daemon 无发送点；ws.test.ts 有冒烟
        用例发该消息，无 case 后 switch 静默忽略，行为不变）。

**验收**：`pnpm -r run build`（shared/daemon/server/web）全绿 ✅；daemon 160 测试全绿 ✅。
**⚠️ server 测试套件在本机无法验收**：25 个套件失败均为环境依赖
（Postgres 密码认证失败 + :3001 ECONNREFUSED 的 E2E 套件），非本次改动引入
（改动为纯类型层 + 1 处死 case 删除）。待有测试库环境后补跑 `pnpm --filter
@collabagent/server test` 复核。

---

## Step 3 · PTY 冻结隔离（**不删代码**，headless 观察期后评估删除）✅ 2026-08-20

> **决策修正（2026-08-20 用户指示）**：PTY 整体退役 ≠ 删除。冻结为 legacy 兜底、
> **代码全部保留**——headless 尚未经过长期验证，保留 `SLOCK_USE_PTY=1` 回退能力。
> 删除动作推迟：建议 2026-09 底评估（届时 headless 已默认运行 6+ 周）再决定是否真删。
> 本 Step 目标变为：**隔离标记 + 降级警告 + 文档同步**，让 PTY 代码「看得见的冻结」，
> 防止新代码继续往 PTY 路径上长。

- [x] S3.1 web 终端面板（AgentTerminalPanel）**保留**（原「退役公告」取消——PTY 功能
      保留则面板保留；面板同时服务 obs 帧，headless 下也在用）
- [x] S3.2 PTY 文件统一 ❄️ legacy 头注（graph 子代理全量触点盘点后执行）：
      - 纯 PTY 全文件冻结（7）：`agent-manager.ts`、`agent-manager-support.ts`、
        `pty-output-bus.ts`、`terminal-state.ts`、`post-start-input-writer.ts`、
        `agent-runtime-turn-tracker.ts`、`agent-runtime-terms-dialog.ts`
      - 混合文件范围化标注（3）：`agent-runtime-spawn.ts`（`writeMcpConfig` 服务
        headless 不冻结，其余冻结）、`agent-stdin-dispatcher.ts`（writer 是 PTY 专属
        故整体随冻）、`agent-sessions.ts`（mtime 启发式冻结，工具函数不冻结）
      - **明确排除**：`terminal-log.ts`（headless `terminal:history` 也用它，共享文件）
- [x] S3.3 混合文件 PTY 分支点注释（`agent-runtime.ts` usePty 读取处 +
      `agent-runtime-dispatch.ts:249` if(usePty) 分支入口）
- [x] S3.4 `SLOCK_USE_PTY=1` 生效时启动打 legacy 警告（`agent-runtime.ts`：
      「PTY legacy fallback 已启用（冻结保留，仅调试/回退用）」）
- [x] S3.5 文档同步：CLAUDE.md（冻结保留 + 共享文件脚注）、
      `01-daemon-evolution-plan.md`（P0.1 改写为冻结方案，原删除方案保留备查）、
      tracker 本段；§5 顺序与规则 3 同步修正（dispatch 层仅剩 T8→D1 串行约束）

**依赖处置**：`node-pty`、`@xterm/headless` **保留不卸**（回退能力需要）。
**验收**：全仓 build 绿 + daemon 160 测试绿；`SLOCK_USE_PTY=1` 路径保持可编译可用；
grep 每个 PTY 文件都有 legacy 标记。

---

## Step 4 · 成本记账 + 熔断（并行轨道，独立）✅ 2026-08-20

- [x] S4.1 `agent-observation.ts` result 事件的 `total_cost_usd/duration_ms/num_turns`
      落库，按 (agent, channel, UTC day) 累计
      → **独立文件** `.slock/daemon-costs.json`（`agent-cost-tracker.ts`），不挂
      `AgentRunRecord`：headless 默认路径从不 `insertAgentRun`（那是 PTY spawn
      专属）。插入点：`handleStreamEvent` 的 `result` 分支、`turnGuards.delete` 之前
      （channel 取自 turnGuard，是频道名不是 server UUID）
- [x] S4.2 `SLOCK_COST_BUDGET_USD` 阈值熔断：超限 → A1 队列拒投 + 频道发熔断消息
      → 入队前 `evaluateCostGate`（`dispatchToAgent` 漏斗，覆盖 DM/reminder/patrol）；
      未设 / 非正数 = 不熔断（opt-in）；同 agent 同 UTC 日最多一条熔断消息，
      经 `daemon-core.postAsAgent`（与 reply-guard 共用 mint token → POST /send，零 LLM）
- [x] S4.3 查询面：`slock cost show [--days 7] [--agent name]` 读本地 costs 文件
      （不打 server；`slock cost` 默认即 show）

**验收**：超限自动停投且频道可见；查询面可用。 ✅
（`pnpm --filter @collabagent/daemon typecheck` 绿；vitest 20 文件 / **177 例**全绿，
净增 `test/agent-cost-tracker.test.ts` 17 例）
**时序约束**：必须早于 Step 6（D1）上线。 ✅ 已满足

> **📌 粒度备注**：聚合键的 channel 是 daemon 侧频道名（`general` / `dm:@handle`），
> 不是 server UUID。one-shot / PTY 路径没有 stream-json result，本批只覆盖
> headless persistent 默认路径。

---

## Step 5 · T8 经理分诊（按既有设计文档）✅ 2026-08-21

- 依据：`docs/2026-08-19/03-t8-manager-triage-design.md`（任务分解以该文档为准，
  本文不重复）。
- **前置**：Step 3 合并（dispatch 层单路径）。
- **并行**：Step 6 设计文档可在本 Step 期间撰写。
- [x] T8.1 migration `013_manager_triage.sql` + canonical schema ALTER
- [x] T8.2 `messages.ts` 无 agent 唤醒 + 顶层消息 + 开关 → `triageAgents`（纯函数 `computeTriageAgents`）
- [x] T8.3 daemon `agent:deliver` mention 未命中后第四唤醒源 `runAgentTriage`
- [x] T8.4 `buildTriagePrompt`（三选一 + 沉默协议）；分诊/巡检回合跳过 reply-guard 代发
- [x] T8.5 PATCH `managerTriageEnabled`：`canManageChannel`（owner/admin）；开启校验至少一名经理 agent
- [x] T8.6 ChannelSettingsModal 开关（无经理置灰；非管理员只读提示）；不做 header badge
- [x] T8.7 L1 单测（server `manager-triage.test.ts` + daemon `triage-prompt.test.ts`）；不做 L4 `triageWoken`

**验收（L1）**：路由纯函数覆盖无 @ / @人空名单 / 有 @ agent / 线程 / 开关关 / DM / 无经理；
daemon prompt 含三选一与沉默协议。L3 手动 E2E 待上线走剧本。

---

## Step 6 · D1 Context Builder + D2 thread↔session 亲和（同批）✅ 2026-08-21

设计：`docs/2026-08-21/01-d1-d2-context-session-design.md`。用户确认：仅 prompt 隔离（不拆进程池）；仅线程追问注入；截断不摘要。

- [x] S6.0 设计文档
- [x] S6.1 Context Builder：`runAgent`/`runAgentTriage` 入 A1 前拉 `GET /history?threadId=`，条数/字符截断 + 隔离信封；顶层 @ / DM / 巡检不注入；`SLOCK_CONTEXT_BUILDER=0` 关闭
- [x] S6.2 `daemon-thread-sessions.json`（独立，不挂 AgentRunRecord）；one-shot 同 thread `--resume`；Persistent 仍每 agent 一进程；idle 仍 per-agent。**不做 (agent, thread) 进程池**
- [x] S6.3 `recordContext` 累计 contextChars/Messages/Dropped/Turns；`slock cost show` 带出；`slock session show`

**验收**：长线程 @ 的 prompt 含早前消息；thread A/B 注入块互不包含；无 threadId 不注入；typecheck + vitest 绿。弱隔离：Claude 会话记忆仍可能跨线程泄漏。
**落地**：`ae29832`（与 Step 4/5 同提交，工作树无法拆成可独立编译的逐步提交）。

---

## Step 7 · T4 观察帧产品化（D4 并入）☐

设计：`docs/2026-08-21/02-t4-observation-product-design.md`。用户确认：面板+频道进度都做；结束消/改写；默认开；频道顶栏状态条。

- [x] T7.0 设计文档 + 共享聚合（`packages/shared/src/progress.ts`：工具中文化 / 节流文案 / `⏳ ` 前缀）
- [x] T7.1 D4 daemon：`agent-progress.ts` 回合级节流器；`handleStreamEvent` 喂帧；分诊/巡检不写频道；`SLOCK_CHANNEL_PROGRESS=0` 关
- [x] T7.2 server：`PUT/DELETE /internal/agent/:id/messages/:messageId`（不写 edits/审计）；硬删无回复的进度条
- [x] T7.3 结束：hadSend → DELETE；reply-guard 有正文 → PUT 改写（不再另 POST）；进程退出 abort
- [x] T7.4 T4 web：AgentObsStream 中文活动卡 + headline；ChannelView/DmView/ThreadView 顶栏 `AgentProgressBar`；`agent:progress` WS；进度删除不留「已删除」
- [x] T7.5 D1 过滤 `⏳ ` 进度消息；daemon vitest 覆盖聚合/节流/过滤

**验收**：非技术用户不打开终端也能从顶栏/频道进度条读懂「正在读文件 / 跑测试」；回合结束后频道不留 ⏳ 垃圾（已发则删、代发则改写成答案）。typecheck + daemon vitest 绿。
**开关**：默认开；`SLOCK_CHANNEL_PROGRESS=0` 关频道进度（顶栏仍在）。

---

## 远期（触发条件驱动，不排期）

| # | 事项 | 启动条件 | 状态 |
|---|---|---|---|
| D5 | 第二家厂商 adapter（统一事件 schema + raw fallback） | 产品决定接入第二家 | 🧊 |
| D6 | Orchestrator（复杂任务拆解 → 多 agent 认领 → 汇总） | T8 跑稳之后 | 🧊 |
| D7 | 隐式触发（轻量分类器，默认关） | D1 上线且成本可控后 | 🧊 |

---

## 完成记录

| Step | 完成日期 | Commit | 备注 |
|---|---|---|---|
| Step 0 | 2026-08-20 | `dffb5f8` | CLAUDE.md 重写；01 归档标注；删 adapter-layer / drivers/claude.ts / agent-stdin-writer.ts（+2 死类型）；build + 135 测试全绿 |
| Step 1 | 2026-08-20 | `dffb5f8` | 覆盖盘点后只补真空：新增 agent-runtime-state(16 例)+persistent-claude(9 例)；S1.1/S1.4 已覆盖免做；160 全绿；发现 1 个 exit-handler 竞态遗留观察 |
| Step 2 | 2026-08-20 | `dffb5f8` | shared WS 段重写为四方向 union；daemon/server 接线（sendWs 唯一出口 + 参数类型化）；删 server 死 case agent:activity；全仓 build + daemon 160 全绿；server 套件受环境（PG/:3001）阻塞待复验 |
| Step 3 | 2026-08-20 | `a65f60c` | PTY 冻结隔离（不删代码）：7 纯 PTY 文件 + 3 混合文件 legacy 标记；SLOCK_USE_PTY=1 启动警告；terminal-log.ts/writeMcpConfig 确认共享不冻结；全仓 build + 160 测试全绿 |
| Step 4 | 2026-08-20 | `ae29832` | D3 成本记账：`agent-cost-tracker.ts` 独立 JSON 按 (agent, channel, UTC day) 累计；`SLOCK_COST_BUDGET_USD` 入队前熔断 + `postAsAgent` 频道可见；`slock cost show`；typecheck + 177 测试全绿 |
| Step 5 | 2026-08-21 | `ae29832` | T8 经理分诊：013 开关列；`triageAgents` 第四唤醒源；分诊 prompt + reply-guard 豁免；PATCH owner/admin + 经理校验；设置面板开关；L1 14 例；不做 badge/L4 |
| Step 6 | 2026-08-21 | `ae29832` | D1 线程追问 Context Builder（截断注入）+ D2 prompt 隔离与 thread-session JSON；history/MCP `threadId`；`recordContext`；不做进程池 |
| 评估 P0.1 | 2026-08-24 | （待提交） | PersistentClaude kill→exit 竞态：`procGen` 绑定回合；超时立即 settle；迟到 exit/stdout 忽略；dispatch catch 补 `idleReclaimer.touch`；12 例全绿 |
| 评估 P0.2 | 2026-08-24 | （待提交） | headless idleReclaimer：`reclaimIdleAgent` 停 PersistentClaude 并踢 `persistentSessions`；working/starting 返回 false 保留跟踪；headless 入 working / starting 时 untrack |
| 评估 P0.3 | 2026-08-25 | （待提交） | 统一 stop 状态机：`haltAgent` 先 bump 代次再切 idle（stopAgent）/stopped（unregister、stopAll）；清 startupTimer + 队列 epoch；dispatch 跨 await 对照代次不复活；`test/agent-runtime-stop.test.ts` |
| 评估 P0.4 | 2026-08-25 | `c3715bc` | env 白名单默认翻正：`resolveAgentEnvMode` 默认 `whitelist`；`SLOCK_ENV_INHERIT=1` 排障回退（仍剥 token）；`SLOCK_ENV_WHITELIST=1` 兼容 no-op；warn-only 路径删除 |
| 评估 P0.5 | 2026-08-25 | （待提交） | `total_cost_usd` 确认为会话累计：`createSessionCostDelta` 按 agent 记差值再落库；`duration_ms`/`num_turns` 仍按回合原值；stop/reclaim `forget` 基线 |
| 评估 P0.6 | 2026-08-25 | （待提交） | 成本门覆盖已入队/重试：队列新增 `deliveryGate`（drain 出队前重估，熔断批次丢弃完结不重试）+ `onDeliveryBlocked`；`doDispatch` 入口兜底门（覆盖旧链路径与竞态窗口）；熔断通知收口 `notifyCircuitBreak` 三处共用；队列测试 +3 |
| 评估 P0.7 | 2026-08-25 | （待提交） | headless 与 PTY 解耦：`agent-manager-lazy.ts` 懒加载（首次 spawn 才动态 import node-pty；同步方法加载前安全 no-op；空 bus 兜底 `getOutputBus`）；`writeMcpConfig` 迁出冻结文件到 `agent-mcp-config.ts`，`agent-runtime-spawn.ts` 纯化全冻结；`test/agent-manager-lazy.test.ts` +6 |
| 评估 P0.8 | 2026-08-25 | （待提交） | 核心编排器补单测：`agent-runtime-dispatch.test.ts`（23：doDispatch 链路/P0.5 差值/三道成本门/死信/合并去重/reply guard/runAgent 路由）、`agent-runtime.test.ts`（10：注册表/mention/loadExistingAgents）、`daemon-core.test.ts`（24：handleMessage 全 case）；全量 33 文件 309 用例通过 |
| 评估 P1.9 | 2026-08-25 | （待提交） | 拆分巨型函数/模块：`createDispatch` 抽出 pty/headless/stream（949→603 行工厂 + 3 子文件）；`handleMessage` → `handlers/*`（daemon-core 712→417）；`cli.ts` 按域拆到 `cli/*.ts`（1075→50 行入口）；typecheck + 33 文件 309 用例全绿 |
| 评估 P1.10 | 2026-08-25 | （待提交） | 统一配置层：`src/config.ts` `loadDaemonEnv()` 集中读取/校验全部 daemon 进程级 `SLOCK_*`；调用方不再直读；`test/config.test.ts` 11 例；typecheck + 34 文件 320 用例全绿 |
| 评估 P1.11 | 2026-08-26 | （待提交） | one-shot 走 `handleStreamEvent` 记成本；PTY 在 `doDispatch` 成功后记 `costUsd=0` 回合（不改冻结文件）；`slock cost show --channel/--day/--thread/--group`；账本按 thread 分行（旧行兼容空 thread）；typecheck + 35 文件 331 用例全绿 |
| 评估 P1.12 | 2026-08-26 | （待提交） | PersistentClaude cleanup 成对卸 stdout/stderr/exit/error；headless `ensurePersistentSession` 单飞 + `dropStalePersistentSession`（send 失败踢本实例并 forget 成本基线）；`test/agent-runtime-dispatch-headless.test.ts` 8 例；typecheck + 36 文件 342 用例全绿 |
| 评估 P1.13 | 2026-08-26 | `c3bbc12` | stream-json / WS 类型收紧：`ClaudeStreamEvent` + `asClaudeStreamEvent`；`parseWsToDaemonMessage` 归一化入站；handlers 吃收窄联合；`errMessage` 顺手收口热路径；`test/p1-13-protocol.test.ts`；typecheck + 37 文件 350 用例全绿 |
| 评估 P1.14 | 2026-08-26 | `f501a5a` | 统一错误模型：`DispatchError(code)` + `retriable` 由 code 推导（agent-unknown/agent-stopped/session-lost 永久失败，inflight-timeout/credential-mint-failed 可重试）；队列对非可重试错误首次失败即死信不空转退避，未分类 Error 保持旧「一律重试」；派发链 5 处抛点迁移；`test/errors.test.ts` +6、队列 +3；typecheck + 38 文件 359 用例全绿 |
