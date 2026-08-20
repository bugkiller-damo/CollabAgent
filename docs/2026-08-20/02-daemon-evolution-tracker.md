# Daemon 演进推进文档（执行跟踪）

> 创建：2026-08-20 · 方案依据：`docs/2026-08-20/01-daemon-evolution-plan.md`
> 使用方式：
> 1. 「当前焦点」永远只指向**一个**在做的任务，开工前更新；
> 2. 完成一项勾一项，注明 commit 短哈希与日期；
> 3. 完成整个 Step 后，在文末「完成记录」表补一行；
> 4. 本文件是执行面，方案 rationale 改 01，不改这里。

---

## ★ 当前焦点

> **Step 2 · ✅ 完成**（2026-08-20，全仓 build + daemon 160 测试全绿，改动待 commit）。
> **下一步：Step 3 · PTY 整体退役（前置：web 终端面板退役公告 S3.1）**

---

## 推进规则（三条不可调换）

1. **P0.5（Step 1）先于 P0.1/P0.3（Step 2/3）**——没有测试网，不动幸存主干；
2. **D3（Step 4）先于 D1（Step 6）**——仪表先于增耗；
3. **`agent-runtime-dispatch.ts` 严格串行**——P0.1（删 PTY 分支）→ T8（加 triage）→
   D1（加 Context Builder 前置），三者不同时开工。

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

## Step 3 · PTY 整体退役（2~4 天）☐ —— 单独纯删除 PR

- [ ] S3.1 web 终端面板（AgentTerminalPanel）退役公告/降级为只读 obs 面板
- [ ] S3.2 删除 9 个 PTY 文件：`agent-manager.ts`、`agent-manager-support.ts`、
      `pty-output-bus.ts`、`terminal-state.ts`、`terminal-log.ts`、
      `post-start-input-writer.ts`、`agent-runtime-turn-tracker.ts`、
      `agent-runtime-terms-dialog.ts`、`agent-runtime-spawn.ts`
- [ ] S3.3 收编 `agent-runtime.ts` / `agent-runtime-dispatch.ts` / `daemon-core.ts` 内
      PTY 分支与 `SLOCK_USE_PTY` 门控；删 `terminal:watch/unwatch/resize/history` 处理
- [ ] S3.4 卸依赖 `node-pty`、`@xterm/headless`；删 `agent-sessions.ts` mtime 启发式
      （O13 注明随 PTY 退役删除）
- [ ] S3.5 文档清尾：CLAUDE.md / 相关 docs 中 PTY 与 `SLOCK_USE_PTY` 引用

**验收**：`grep -ri "node-pty\|SLOCK_USE_PTY" packages/` 零命中；tsc 通过；
Step 1 测试全绿。
**⚠️ 完成后**：`agent-runtime-dispatch.ts` 只剩 headless 单路径，T8 才允许开工。

---

## Step 4 · 成本记账 + 熔断（并行轨道，独立）☐

- [ ] S4.1 `agent-observation.ts` result 事件的 `total_cost_usd/duration_ms/num_turns`
      落库（runStore 或 SQLite），按 (agent, channel, day) 累计
- [ ] S4.2 `SLOCK_COST_BUDGET_USD` 阈值熔断：超限 → A1 队列拒投 + 频道发熔断消息
- [ ] S4.3 查询面：`slock` CLI 或管理后台能查「某 agent 最近 7 天花费」

**验收**：超限自动停投且频道可见；查询面可用。
**时序约束**：必须早于 Step 6（D1）上线。

---

## Step 5 · T8 经理分诊（按既有设计文档）☐

- 依据：`docs/2026-08-19/03-t8-manager-triage-design.md`（任务分解以该文档为准，
  本文不重复）。
- **前置**：Step 3 合并（dispatch 层单路径）。
- **并行**：Step 6 设计文档可在本 Step 期间撰写。

---

## Step 6 · D1 Context Builder + D2 thread↔session 亲和（同批）☐

设计（可在 Step 5 期间并行）：
- [ ] S6.0 设计文档（`docs/2026-08-2x/`）：Context Builder 职责边界、与 T8 triage
      prompt 的组装关系、thread↔session 映射表结构、回收策略

实施（T8 合并后）：
- [ ] S6.1 Context Builder 插入 dispatch 前置（`agent:deliver` 后、A1 入队前）：
      相关性筛选 → 线程化重组 → 超窗压缩（经 server 历史 API）
- [ ] S6.2 `agent_run_store` 增加 `threadId → sessionId` 映射；同 thread 追问
      `--resume` 同 session；persistent 按 (agent, thread) 缓存/回收
- [ ] S6.3 联通 Step 4 成本数据：Context Builder 注入量纳入预算统计

**验收**：无线程内 @ 时 agent 能引用早前消息作答；thread A 追问不进 thread B 上下文；
token 消耗在成本查询面可见。

---

## Step 7 · T4 观察帧产品化（D4 并入）☐

- [ ] T4 立项时把 D4 纳入 scope：tool_call/result 事件节流聚合成频道内一条
      原地更新的进度消息（「正在执行：运行测试…」→ 完成时替换为结果摘要）

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
| Step 0 | 2026-08-20 | 待 commit | CLAUDE.md 重写；01 归档标注；删 adapter-layer / drivers/claude.ts / agent-stdin-writer.ts（+2 死类型）；build + 135 测试全绿 |
| Step 1 | 2026-08-20 | 待 commit | 覆盖盘点后只补真空：新增 agent-runtime-state(16 例)+persistent-claude(9 例)；S1.1/S1.4 已覆盖免做；160 全绿；发现 1 个 exit-handler 竞态遗留观察 |
| Step 2 | 2026-08-20 | 待 commit | shared WS 段重写为四方向 union；daemon/server 接线（sendWs 唯一出口 + 参数类型化）；删 server 死 case agent:activity；全仓 build + daemon 160 全绿；server 套件受环境（PG/:3001）阻塞待复验 |
