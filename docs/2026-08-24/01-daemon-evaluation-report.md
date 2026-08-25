# Slock Daemon 综合评估报告

> 评估日期：2026-08-24  
> 评估范围：`packages/daemon/src/`（50 源文件）、`packages/daemon/test/`（27 测试文件）  
> 评估方法：6 名子 agent 并行按维度精读源码与测试，输出结构化结论后由主编综合去重、定级  
> 当前基线：`pnpm typecheck` 通过；`pnpm vitest run` 27 文件 / 214 用例全绿（约 31.5s）  
> 版本上下文：headless 为默认驱动（2026-08-18 起），PTY 代码冻结保留（2026-08-20 Step 3），Step 4-7（D3/T8/D1/D2/D4）已落地。

---

## 1. 执行摘要

### 1.1 总体健康度

| 维度 | 评分 | 简要评价 |
|---|---|---|
| 架构与模块组织 | 7.0 / 10 | 职责拆分清晰，但~~headless 默认路径仍被 PTY 实现污染~~ **✅ P0.7**，配置读取极度分散，核心入口过于臃肿。 |
| 运行时生命周期与状态机 | 6.0 / 10 | 回合级 Promise、派发串行化已落地；~~kill→exit 竞态、headless 空闲回收失效、stop 路径状态机不一致~~ **✅ P0.1/P0.2/P0.3**。 |
| 派发队列与 T8 经理分诊 | 7.5 / 10 | A1 队列纪律与 T8 触发面完整；~~成本门不拦截已入队积压~~ **✅ P0.6**；去重窗口在死信路径上有副作用。 |
| 安全与权限模型 | 6.0 / 10 | scoped token、MCP 鉴权、白名单框架已落地；~~默认 env 白名单未生效~~ **✅ P0.4**；本地 token 注册表与真实吊销路径脱节。 |
| 成本 / 上下文 / 进度产品化 | 7.0 / 10 | 功能完整且旁路接入；~~`total_cost_usd` 语义未验证~~ **✅ P0.5**、~~预算熔断有透支窗口~~ **✅ P0.6**；CLI 查询面较粗。 |
| 测试覆盖与代码质量 | 6.5 / 10 | 核心旁路模块测试扎实；~~编排核心（runtime/dispatch/daemon-core）是真空~~ **✅ P0.8**；`cli.ts` 仍无测，巨型函数与 `any`/`as` 较多。 |
| **综合评分** | **6.7 / 10** | 基础设施与产品化能力已成型，核心运行时鲁棒性和架构解耦仍是最大短板。 |

### 1.2 关键结论

1. **产品化能力已追上需求**：D3 成本记账、D1 上下文构建、D2 thread-session、T4/D4 观察帧进度、T8 经理分诊均已落地，单测覆盖扎实，对核心派发链路侵入较小。
2. **~~核心运行时尚未达到生产级鲁棒~~ ✅ 2026-08-24/25 已修**：~~`PersistentClaude` 的 kill→exit 竞态~~（P0.1）、~~`idleReclaimer` 对 headless 失效~~（P0.2）、~~`stopAgent` 不驱动状态机~~（P0.3），三个 P0 缺陷均已修复并有单测守护。
3. **~~架构上的“headless 默认”声明与实现不符~~ ✅ 2026-08-25 已修（P0.7）**：~~启动时仍无条件实例化 PTY 管理器、加载 node-pty 原生模块，冻结代码仍处在热路径。~~ 现 PTY manager 懒加载（首次 spawn 才动态 import），headless 全程不加载 node-pty。
4. **安全模型有框架但默认未收紧**：~~env 白名单默认 `warn` 模式导致 secrets 直接流入子进程~~ **✅ 2026-08-25 已修**（P0.4）；`agent-tokens.ts` 本地注册表与真实 server 吊销路径脱节。
5. **~~测试覆盖呈现“旁路厚、核心薄”~~ ✅ 2026-08-25 已修（P0.8）**：队列、状态机、观察帧、成本、Context Builder 均有高覆盖测试；~~`agent-runtime.ts`、`agent-runtime-dispatch.ts`、`daemon-core.ts` 零单测~~——已补 57 用例（全量 33 文件 309 用例全绿）；`cli.ts` 仍无测。

### 1.3 最高优先级行动项（P0）

| # | 行动项 | 责任模块 | 预期收益 |
|---|---|---|---|
| P0.1 | 修复 `PersistentClaude` kill→exit 竞态（旧进程 exit 误 reject 新回合） | `drivers/persistent-claude.ts` | 消除长回合/超时场景下的误重试与死信 | ✅ 2026-08-24：`procGen` + turn.gen；超时立即 settle；迟到 exit 忽略 |
| P0.2 | 让 `idleReclaimer` 同时回收 headless 会话 | `agent-runtime.ts` | 避免 headless 子进程永久泄漏 | ✅ 2026-08-24：`reclaimIdleAgent` 停 PersistentClaude；working/starting 跳过；headless 入 working 时 untrack |
| P0.3 | 统一 `stopAgent`/`stopAll` 状态机语义 | `agent-runtime.ts` | 消除“working 但无进程”的幽灵状态 | ✅ 2026-08-25：`haltAgent` 先 bump 代次再切 idle/stopped；清 startupTimer + 队列；in-flight 不复活 |
| P0.4 | 收紧 env 白名单为默认开启 | `agent-env-whitelist.ts` | 阻止 daemon secrets 流入 agent 子进程 | ✅ 2026-08-25：默认 `whitelist`；`SLOCK_ENV_INHERIT=1` 排障回退；`SLOCK_ENV_WHITELIST=1` 兼容 no-op |
| P0.5 | 验证 `total_cost_usd` 是会话累计还是单回合成本 | `agent-cost-tracker.ts` | 确保成本数据与预算熔断可信 | ✅ 2026-08-25：会话累计；`createSessionCostDelta` 差值落库；stop/reclaim forget 基线 |
| P0.6 | 在队列 `drain` 与 `doDispatch` 执行前补成本门 | `agent-runtime-dispatch.ts` / `agent-dispatch-queue.ts` | 让熔断真正止血，而非只拦截新入队 | ✅ 2026-08-25：队列 `deliveryGate`（drain 前重估，熔断批次丢弃不重试）+ `doDispatch` 入口兜底门；`notifyCircuitBreak` 三处共用 |
| P0.7 | 让 headless 默认路径真正与 PTY 解耦 | `agent-runtime.ts` / `agent-runtime-spawn.ts` / `daemon-core.ts` | 减少原生依赖、内存占用与冻结代码热路径污染 | ✅ 2026-08-25：`agent-manager-lazy.ts` 懒加载 node-pty（首次 spawn 才动态 import）；`writeMcpConfig` 迁出到非冻结 `agent-mcp-config.ts`，spawn 文件纯化全冻结 |
| P0.8 | 为核心编排器（runtime / dispatch / daemon-core）补单元测试 | `test/` | 把最大回归风险纳入自动化守护 | ✅ 2026-08-25：新增 `agent-runtime-dispatch.test.ts`（23）、`agent-runtime.test.ts`（10）、`daemon-core.test.ts`（24）共 57 用例；覆盖 doDispatch 链路/P0.5 差值落库/三道成本门/死信/reply guard/runAgent 路由、注册表与 loadExistingAgents、handleMessage 全部 case；全量 33 文件 309 用例通过 |

---

## 2. 各维度详细发现

### 2.1 架构与模块组织（7.0 / 10）

#### 优点

- 运行时职责拆分清晰：`agent-runtime-state.ts`（五态机）、`agent-runtime-dispatch.ts`（派发）、`agent-runtime-exit.ts`（退出清理）、`agent-runtime-credentials.ts`（scoped token）、`agent-dispatch-queue.ts`（A1 队列）边界基本合理。
- 观察帧总线与 PTY 输出总线概念对齐，headless 路径具备结构化围观能力。
- 安全、成本、上下文、进度等能力各自独立文件/JSON 存储，不污染 PTY 遗留的 `AgentRunRecord`。

#### 关键问题

| 严重度 | 文件:行号 | 问题 | 后果 |
|---|---|---|---|
| 高 | `agent-runtime.ts:210` | ~~`const agentManager = agentManagerOverride ?? createAgentManager();` 即使 headless 默认也**无条件实例化 PTY 管理器**~~ **✅ 2026-08-25 已修**（P0.7）：`createLazyAgentManager()` 懒加载，首次 `startAgent` 才动态 import agent-manager.js（node-pty）；headless 全程 no-op | 每次启动加载 node-pty 原生依赖并分配 PTY 内存；node-pty 初始化失败会连带影响 headless 启动 |
| 高 | 多处 | 环境变量读取极度分散，约 15+ 文件直接访问 `process.env.SLOCK_*` | 缺少默认值、类型、校验与文档的集中来源；新增配置容易遗漏、命名不一致 |
| 中高 | `daemon-core.ts` | ~~`handleMessage` 是超大 switch~~ **✅ 2026-08-25 已修**（P1.9）：路由迁到 `handlers/*`；`DaemonCore` 只保留 WS/auth/`handleMessage` 转发 | 入口层变成业务编排层，单测困难，任何新消息类型都会继续膨胀该文件 |
| 中 | `cli.ts` | ~~所有子命令堆在一个 1075 行文件~~ **✅ 2026-08-25 已修**（P1.9）：按域拆到 `cli/*.ts`；`cli.ts` 仅 Command 注册与 parse | 低内聚、协作冲突概率高、命令域无显式边界 |
| 中 | `agent-runtime-dispatch.ts:633-730` | `SLOCK_DISPATCH_QUEUE=0` 时回退到旧的 `dispatchPromises` 链式缓冲，与新的 A1 队列并存 | 同一语义有两套错误处理/重试/死信/合并逻辑，旧路径缺乏退避和死信上报 |
| 中低 | `agent-runtime.ts:194-625` | runtime 同时持有 `runIdByAgent`（PTY 常驻）、`persistentSessions`（headless 常驻）、`observationBus`，并内嵌 stuck 检测器 | 仍是“小上帝模块”，新增驱动模式时修改面大 |
| 低 | `types/index.ts:36-52` / `:112-136` | `AgentRunSnapshot` 与 `PtyOutputBus` 等 PTY 专用类型与通用运行时接口混在同一文件 | headless 并不实现这些类型，删除 PTY 时容易遗漏类型清理 |

#### 改进建议

- **P0**：~~将 `createAgentManager()` 改为懒加载/注入，默认 headless 下使用 no-op `IAgentManager`；把 `writeMcpConfig` 从冻结的 `agent-runtime-spawn.ts` 迁出到独立非冻结文件。~~ **✅ 2026-08-25 已修**（P0.7）。
- **P0**：建立统一配置层 `src/config.ts`，一次性读取并校验所有 `SLOCK_*` 环境变量，提供类型化配置对象与默认值。
- **P1**：~~拆分 `daemon-core.ts` 的消息路由为 `handlers/*` 模块~~ **✅ 2026-08-25 已修**（P1.9）：`handlers/{agent,deliver,reminder,terminal,workspace,ping}.ts`；`DaemonCore.handleMessage` 转发。
- **P1**：~~按域拆分 `cli.ts`~~ **✅ 2026-08-25 已修**（P1.9）：`cli/{auth,channel,message,task,...}.ts`；`cli.ts` 仅 Command 注册与入口解析。
- **P1**：删除 `SLOCK_DISPATCH_QUEUE=0` 回退路径与 `dispatchPromises` Map，只保留 A1 队列一条路。

---

### 2.2 运行时生命周期与状态机（6.0 / 10）

#### 优点

- 通过 `SLOCK_USE_PTY=1` 门控，PTY 代码整体冻结，headless 默认路径不再受 TUI 启发式干扰。
- A1 队列实现 per-agent 串行、指数退避、死信上报、15s 去重与合并，基本对齐 buzz 队列纪律。
- `PersistentClaude.send()` 返回的 Promise 由 `result` 事件 resolve、由 mid-turn exit reject，解决了“写入即完成”的误判。
- `agent-runtime-exit.ts` 通过 `runIdByAgent` 匹配保护，避免新 run 的 token/状态被旧 onExit 误清。
- `handleStreamEvent` 以 `result` 事件作为精确回合边界，替代 PTY 的 `❯` 启发式。

#### 关键问题

| 严重度 | 文件:行号 | 问题 | 后果 |
|---|---|---|---|
| P0 | `drivers/persistent-claude.ts:199-209` + `:98-117` | 沉默超时 kill 后，`cleanup()` 不清 `activeTurn`；旧进程 `exit` 事件稍晚到达时会取出**当前** `activeTurn`（已是新回合）并 reject | 合法新回合被误判为 mid-turn exit，A1 队列会退避重试甚至死信；同一消息反复 spawn |
| P0 | `agent-runtime.ts` `onReclaim` | ~~只读取 `runIdByAgent` / `stopRun`，headless `persistentSessions` 不回收~~ **✅ 2026-08-24 已修**（P0.2）：`reclaimIdleAgent` 同时 `PersistentClaude.stop()` + delete；working/starting 返回 false 保留跟踪 | headless 代理空闲超时后 reclaimer 不 kill 任何进程，子进程永久泄漏 |
| P0 | `agent-runtime.ts` `stopAgent`/`stopAll` | ~~停止进程/会话、清理 Map，但不调用 `transitionState`、不清 `startupTimer`~~ **✅ 2026-08-25 已修**（P0.3）：`haltAgent` 先 bump 代次再切 idle/stopped，清 timer + 队列 + 进程；in-flight spawn 对照代次不复活 | 状态面板显示 working 但无进程；`startupTimer` 后续触发会把状态改回 idle，与“已 stop”意图冲突 |
| P1 | `drivers/persistent-claude.ts:130-139` | `cleanup()` 清空 proc/alive/busy/starting/turnTimer，但不移除 ChildProcess 事件监听器 | 每个被 kill/超时的进程都会留下一组闭包监听器，高频率重启场景下内存累积 |
| P1 | `agent-runtime-dispatch.ts:451-533` | `needsSpawn = !persistentSessions.has(agentName)` 与会话创建之间无锁 | 并发进入时会创建多个 `PersistentClaude` 实例，后一个覆盖前一个，旧实例回调可能混乱 |
| P1 | `agent-runtime-dispatch.ts:502-533` / `:602-618` | headless 会话创建并 `persistentSessions.set` 后，若 `session.send` reject，`catch` 未 `delete` stale session | 下一条消息认为无需 spawn，直接对死实例 send |
| P1 | `agent-runtime.ts:343-408` | `lastWarnedAt` 等 Map 按 agentName 记录，但 agent unregister/stop 后从不清理；`_stuckDetectorInstalled` 一旦置 true 永不重置 | 长期运行 + 频繁增删 agent 时 Map 持续累积 |
| P2 | `agent-runtime-state.ts:55-70` | 非法迁移被 `transitionState` catch 后只 `console.warn` 并 `return` | 外部模块无法订阅状态变化或非法迁移事件，调试困难 |
| P2 | `agent-runtime-dispatch.ts:667-730` | fallback `dispatchPromises` 链未感知 `stopAgent`/`unregisterAgent` | 旧模式下停止 agent 后，链中消息仍会尝试 spawn |
| P2 | `supervisor.ts:34-49` | `killTree` fire-and-forget，不等待进程树实际退出 | 热重启时孙子进程可能尚未终止就启动新 daemon，导致双 daemon、重复 spawn |

#### 改进建议

- **P0**：修复 kill→exit 竞态。方案：给每个 turn 分配唯一 token，exit handler 只 reject 与当前退出进程绑定的 turn；或在 `cleanup()` 中把当前 `activeTurn` 移入 `dyingTurns` 集合并清空 `activeTurn`。
- **P0**：~~让 `idleReclaimer` 同时回收 headless 会话~~ **✅ 2026-08-24 已修**（P0.2）：`reclaimIdleAgent`；working/starting 跳过；headless 入 dispatch 即 untrack。
- **P0**：~~统一 stop 路径状态机语义~~ **✅ 2026-08-25 已修**（P0.3）：`stopAgent` → idle（保留注册）；`unregister`/`stopAll` → stopped；`clearStartupTimer` + 队列 epoch + `getStopGeneration` 挡住 in-flight 复活。
- **P1**：`PersistentClaude.cleanup()` 显式移除 `stdout/stderr/exit/error` 监听器。
- **P1**：给 headless 会话创建加锁；失败时清理 stale session。
- **P2**：状态机增加 `onTransition`/`onInvalidTransition` 钩子；`supervisor.killTree` 等待进程退出确认。

---

### 2.3 派发队列与 T8 经理分诊（7.5 / 10）

#### 优点

- A1 队列纪律清晰：per-agent 串行、in-flight 截止、指数退避 + jitter、死信回调、15s content 去重、忙碌合并。
- T8 分诊触发面闭合：`computeTriageAgents` 纯函数覆盖「非 DM + 顶层消息 + 无 agent 被唤醒 + 开关开 + 有经理」五条件；`pickLocalTriageAgent` 保证多 daemon 拓扑下只唤醒本机托管经理。
- Context Builder 插入点正确：仅在 `runAgent` / `runAgentTriage` 调用 `attachThreadContext`，且仅在传入 `threadId` 时拉历史；DM / 巡检 / 顶层 @ 不注入。
- 进度条与队列核心解耦：`agent-progress.ts` 是纯旁路模块，`doDispatch` 中创建进度条，失败被 try/catch 吞掉不影响队列调度。
- D2 不超范围：thread-session 映射独立 JSON，只供 one-shot `--resume` 与崩溃记账；PersistentClaude 仍是每 agent 一进程。

#### 关键问题

| 严重度 | 文件:行号 | 问题 | 后果 |
|---|---|---|---|
| 高 | `agent-runtime-dispatch.ts:677-690` / `agent-dispatch-queue.ts:641-648` | ~~`evaluateCostGate` 只在**入队前**调用；一旦消息进入队列的 pending 或退避重试，就不再检查成本~~ **✅ 2026-08-25 已修**（P0.6）：队列 `deliveryGate` 在 drain 出队前重估；`doDispatch` 入口兜底；熔断批次丢弃完结不重试 | 预算耗尽后已入队/重试任务仍会执行，熔断不能即时止血 |
| 中 | `agent-dispatch-queue.ts:244-246, 260` | 去重窗口 `recentContents` 在 dedup 通过后立即写入，即使该消息随后进入死信路径 | 用户在 15s 内重发完全相同内容的补救消息会被静默 dedup |
| 中 | `agent-dispatch-queue.ts:201-206` | 合并批退避 `delay = backoff(Math.min(...retryable.attempts))` | 高 attempts item 被低 attempts item“搭车”早重试，退避强度被稀释 |
| 中 | `agent-runtime-dispatch.ts:776` | `const inThread = Boolean(threadId) || replyTarget.includes(":");` | channel 名含 `:` 或调用方传错时会误判为线程内 |
| 中 | `server/src/routes/messages.ts:300-327` | `computeTriageAgents` 依赖事务内算出的 `mentionAgents`，但开关/经理查询在事务结束后执行 | 事务提交到 T8 查询之间存在极小概率时序裂缝 |
| 低 | `agent-runtime-dispatch.ts:591-593` | one-shot session 选择 `const sid = threadId ? ... : agentSessions.get(agentName);` | `threadId` 为空字符串时按顶层处理，但上游已转 `undefined`，影响有限 |
| 低 | `agent-runtime-dispatch.ts:732-765` / `agent-context-builder.ts:143-180` | Context Builder 失败时直接回退裸 prompt | history API 偶发失败时 agent 会在无线程上下文的情况下回复，像“突然失忆” |
| 低 | `agent-runtime-dispatch.ts:258` | `(progressTurns.get(agentName) ?? turnGuards.get(agentName)?.progress)?.note(frame)` | `progressTurns` 与 `turnGuards.progress` 指向同一对象，表达式冗余 |

#### 改进建议

- **P0**：~~在队列 `drain` 调用 `deliver` 前补一次成本门检查，或在 `doDispatch` 开头增加 `evaluateCostGate`。~~ **✅ 2026-08-25 已修**（P0.6，两处都补了）。
- **P1**：将 `recentContents` 写入时机推迟到「确认本消息会进入正常投递路径」之后，死信路径不写入。
- **P1**：合并批退避改为按最大 attempts 计算，或分别计算后取最大者。
- **P1**：`runAgent` 中 `inThread` 判断改为仅依赖 `threadId`。
- **P1**：Context Builder 失败增加 metric / 事件上报，而非仅 `console.warn`。
- **P2**：补「部分死信后同批内剩余 item 保持相对顺序」的显式单测；进度条 `finish` 与 reply-guard `rewritten` 分支增加单测。

---

### 2.4 安全与权限模型（6.0 / 10）

#### 优点

- Server-side scoped token 机制正确：daemon 用 machine token 换 `sk_agent_...`，`agent_credentials` 表按 `agent_id` upsert，重新签发即吊销旧 token；`DELETE /credentials` 显式吊销 + 24h TTL 兜底。
- Token 不落子进程 env：`agent-runtime-dispatch.ts:474-478` 仅传 `SLOCK_AGENT_TOKEN_FILE` 路径；`buildPtyEnv`/`applyAgentEnv` 防御性剔除明文 `SLOCK_AGENT_TOKEN`。
- Token 文件权限 0600：`agent-token-file.ts:29` 写文件带 mode，`chmodSync` 补刀；POSIX 测试覆盖。
- MCP 鉴权边界清晰：`mcp/slock-mcp-server.ts` 每次请求重读 token 文件，Bearer 调 server；server 端 `requireMachineAuth` 阻止 agent-run token 自吊销/自续期。
- 用户内容不进命令行参数：PersistentClaude/PTY/claudePrint 均将 prompt 走 stdin 或 PTY 键盘写入。
- 路径清洗：`safeAgentDirName` 将 agent 名中的危险字符替换为 `_`，防止路径遍历。

#### 关键问题

| 严重度 | 文件:行号 | 问题 | 后果 |
|---|---|---|---|
| 高 | `agent-env-whitelist.ts` | ~~默认 `warn` 模式调用 `diffAgentEnv` 后仍返回全量 `process.env`；只有显式 `SLOCK_ENV_WHITELIST=1` 才收紧~~ **✅ 2026-08-25 已修**（P0.4）：默认 `whitelist`；`SLOCK_ENV_INHERIT=1` 才全量继承（仍剥 `SLOCK_AGENT_TOKEN`） | agent 子进程可读取 daemon 的 `SLOCK_API_KEY`、云凭证、SSH key、`.env` 等所有环境变量 |
| 高 | `agent-tokens.ts` 全篇 / `exit-handler.ts:28` / `agent-runtime-exit.ts:104` | `tokenRegistry.issue()` 在产线代码中从未被调用；exit handler 用 `revokeIfMatches` 检查的是一个空 Map | 真实吊销完全依赖 server HTTP DELETE；若 daemon 崩溃/网络抖动导致 DELETE 未发出，本地没有兜底；文档与实现不一致 |
| 中 | `command-presets.ts:17` | 默认 `--allowedTools` 含 `Bash` | agent 可执行任意 shell 命令，通过 `curl`/`wget` 绕过 WebFetch 限制，或运行任意下载脚本 |
| 中 | `agent-runtime-dispatch.ts:471-478` | headless 路径每次 dispatch 都 `mintAgentCredential` + `writeAgentTokenFile`，即使复用已有 PersistentClaude 会话 | 高频覆盖增加 race 窗口；旧会话若短暂存活，其 MCP server 可能读到新 token（功能上无害但扩大暴露面） |
| 中 | `agent-token-file.ts:31-35` | `chmodSync` 错误被静默吞掉；Windows `writeFileSync` 的 mode 只影响只读位 | 共享 Windows 用户配置文件或 lax ACL 机器上，其他用户/进程可能读取 token 文件 |
| 中 | `persistent-claude.ts:77-86` / `claude-print.ts:48-55` / `agent-runtime-spawn.ts:287-305` | 使用 `shell: true` 与简易引号函数 `q()` | 未来若把用户可控字段放入 args，简易转义不足以防御 shell 注入 |
| 中 | `agent-observation.ts:70-75` / `agent-runtime-dispatch.ts:91-101` / `terminal-log.ts` | 工具输入/输出直接截断后进入观察帧、WS 审计流、本地 terminal log，未对 token 做显式脱敏 | agent 读取自身 token 后 echo 到输出，token 可能进入日志/面板/审计库 |
| 中 | `agent-runtime-dispatch.ts:778-785` / `buildTriagePrompt` / `buildPatrolPrompt` / `agent-context-builder.ts` | 用户 `content` 直接拼入系统提示；线程历史也直接注入 | 用户消息可诱导 agent 调用工具，将自身权限转化为跨频道/跨 agent 操作 |
| 低 | `command-presets.ts:21` | `SLOCK_AGENT_ALLOWED_TOOLS` 可直接覆盖默认白名单 | 需先取得 daemon 进程 env 控制权，属于提权后场景 |
| 低 | `agent-runtime-spawn.ts:149` / `setup-slock-wrapper.ts` / `mcp-bundle.ts` | `.mcp.json` / wrapper / 打包产物使用默认 umask | 不含 token，但含 `SLOCK_SERVER_URL`、`SLOCK_AGENT_ID`；多用户机器上可枚举 agent 存在性 |
| 低 | `agent-runtime-credentials.ts:23` | 凭证 mint 失败时的错误信息包含 `await res.text()` | server 500 时若错误对象意外含 token 会进日志（概率极低） |

#### 改进建议

- **P0**：~~将 `resolveAgentEnvMode()` 默认值改为 `whitelist`，保留 `SLOCK_ENV_INHERIT=1` 作为显式排障回退。~~ **✅ 2026-08-25 已修**（P0.4）。
- **P0**：统一 token 吊销路径：要么让 `agent-runtime-dispatch.ts` 在 mint 后将 token 注册到 `agent-tokens.ts` 并确保 exit handler 双吊销，要么移除 `agent-tokens.ts` 并更新文档，明确吊销完全由 server 承担。
- **P1**：关闭或最小化 `shell: true`；对 observation / terminal-log / audit 流增加 token 脱敏（匹配 `sk_agent_[a-z0-9]+` 模式）；显式设置 `.slock` 目录权限 0700。
- **P1**：对用户注入内容做 prompt 边界包装（XML/分隔符），降低 prompt 注入成功率。
- **P2**：MCP server 侧加 capability 预检；减少 headless 路径的 token churn；增加安全相关 metrics。

---

### 2.5 成本 / 上下文 / 观察帧进度产品化（7.0 / 10）

#### 优点

- 成本记账与派发解耦：`AgentCostRecord` 独立 JSON 存储，不挂在 PTY 遗留的 `AgentRunRecord` 上。
- 熔断入口统一：`evaluateCostGate` 在 `dispatchToAgent` 入队前拦截，默认不熔断（`SLOCK_COST_BUDGET_USD > 0` 才生效）。
- Context Builder 失败不阻断：拉历史/打包失败返回 `null`，调用方用裸 prompt 继续运行。
- 进度条语义与设计文档一致：`finish({ hadSend, rewrite })` 区分“agent 自己发消息→删除”和“reply-guard 代发→改写”两条路径；分诊/巡检 `isNudge` 不写频道进度但保留顶栏。
- 观察帧总线是纯函数 + 旁路：`streamEventToFrames` 可单测，`PersistentClaude` 对 `onStreamEvent` 抛错有吞错保护。

#### 关键问题

| 严重度 | 文件:行号 | 问题 | 后果 |
|---|---|---|---|
| 高 | `agent-cost-tracker.ts` | ~~代码把每个 stream-json `result` 事件的 `total_cost_usd` 直接累加，未验证其是**单回合成本**还是**会话累计成本**~~ **✅ 2026-08-25 已修**（P0.5）：确认为会话累计；`createSessionCostDelta` 按 agent 记「本次 − 上次」再 `recordTurn`。`duration_ms`/`num_turns` 仍按回合原值累加 | 若是累计成本，每来一条 result 都会把历史成本再算一次，预算严重虚高 |
| 高 | `agent-runtime-dispatch.ts:677-690` / `:353-619` / `agent-dispatch-queue.ts:183-206` | ~~`evaluateCostGate` 只在 `dispatchToAgent` 调用时执行一次；已入队 pending / 退避重试不再检查~~ **✅ 2026-08-25 已修**（P0.6）：drain 前 `deliveryGate` + `doDispatch` 入口门，旧链路径同样覆盖 | 触发熔断后 agent 仍可能把当日预算再花掉一部分，熔断消息与实际行为不一致 |
| 中 | `claude-print.ts:78-96` / `agent-runtime-dispatch.ts:370-448` / `:265-277` | `recordTurn` 只在 `handleStreamEvent` 的 `result` 分支里调用，仅挂在 `PersistentClaude` | one-shot / PTY 路径没有成本记录，形成“花钱黑盒” |
| 中 | `cli.ts:907-932` | `slock cost show` 只输出按 agent 聚合的最近 N 天总额 | 无法按频道、UTC 日、thread 查看，排查“哪个频道把预算烧光”困难 |
| 中 | `agent-context-builder.ts:31-32` / `:64-104` | 默认 `maxMessages=40`、`maxChars=8000`，按 UTF-16 字符数截断 | 未针对不同模型 tokenizer 或上下文上限调整；中文/代码密集场景可能撑到模型上限 |
| 中 | `agent-cost-tracker.ts:184` / `agent-context-builder.ts:129` | channel 一律做 `.split(":")[0]` 归一化，`#general:thread8` 与 `#general:thread9` 记到同一行 `general` | 丢失 thread 粒度，无法按 thread 做预算或分析 |
| 低 | `agent-runtime-dispatch.ts:196` / `:679-681` | `circuitNotified` 是内存 Set，daemon 重启后“今日已通知”状态丢失 | 频繁重启时频道会重复收到熔断提示 |
| 低 | `agent-cost-tracker.ts:147` / `agent-thread-sessions.ts:29` | 成本/会话存储路径依赖 `process.cwd()` | 用户从不同目录启动 daemon 会看到不同的账本 |
| 低 | `agent-observation.ts:99-113` | `costUsd/durationMs/numTurns` 被格式化成 `turn_end` 的 summary 字符串 | web 面板若想做成本/时长图表需要再解析文本 |

#### 改进建议

- **P0**：~~验证 `total_cost_usd` 语义。若是会话累计，改为「本次 - 上次」差值再累计。~~ **✅ 2026-08-25 已修**（P0.5）。
- **P0**：~~在 `doDispatch` 执行前和重试批次出队前再次检查预算。~~ **✅ 2026-08-25 已修**（P0.6）。
- **P1**：补齐 one-shot / PTY 路径的成本记录；扩展 `slock cost show` 查询维度（`--channel`、`--day`、`--thread`）。
- **P1**：Context Builder 引入模型相关的 token 预算，至少按模型支持的最大上下文给安全上限。
- **P2**：固定 `daemon-costs.json` / `daemon-thread-sessions.json` 默认路径到 workspace 根或 `SLOCK_WORKSPACE`；`result` 观察帧增加结构化成本字段；持久化 `circuitNotified` 状态。

---

### 2.6 测试覆盖与代码质量（6.5 / 10）

#### 优点

- 测试基础设施扎实：Vitest 关闭 `fileParallelism` 避免真实子进程/定时器测试互相抢资源；使用高质量 fake（`fake-agent-manager.ts` 用真实 `@xterm/headless` 终端模拟器）和真实 bug fixture（`round-end.integration.test.ts`）。
- 核心旁路模块覆盖较好：A1 队列、状态机、成本、观察帧、Context Builder、环境白名单、命令预设、MCP server 集成等均有独立测试。
- TypeScript 严格模式已开启：`tsconfig.base.json` 启用 `strict: true`，`pnpm typecheck` 通过。
- 文档与注释丰富：关键文件顶部有设计文档引用、冻结代码统一标注 ❄️ LEGACY / FROZEN。

#### 关键问题

| 严重度 | 文件:行号 | 问题 | 后果 |
|---|---|---|---|
| 高 | `agent-runtime-dispatch.ts` | ~~`createDispatch` 函数长达 840 行~~ **✅ 2026-08-25 已修**（P1.9）：抽出 `dispatch-pty` / `dispatch-headless` / `dispatch-stream`；工厂约 600 行（队列漏斗 + prompt 包装仍在） | 单函数职责过重；~~无单元测试~~ **✅ P0.8 已补** |
| 高 | `agent-runtime.ts:194` | `createAgentRuntime` 函数 625 行，内含 `installStuckDetector` 等大型内联闭包 | 状态机/定时器/回收器/清理链全部挤在一个工厂函数，阅读困难；~~单测困难~~ **✅ P0.8 已补**（本项不在 P1.9 范围） |
| 高 | `daemon-core.ts` | ~~`handleMessage` 巨型 switch~~ **✅ 2026-08-25 已修**（P1.9）：`handlers/*`；`handleMessage` 只转发 | WS 消息处理核心~~无单元测试~~ **✅ P0.8 已补** |
| 中 | 多处 | 大量 `(err as any)?.message ?? err`、`ev: any`、`as Record<string, unknown>` | 错误信息提取不统一，stream-json 事件与 WS 线协议类型约束被绕过 |
| 中 | `agent-runtime.ts:459-519` | `registerAgent`/`unregisterAgent`/`stopAgent` 三处重复几乎相同的 `runIdByAgent` 清理逻辑 | 重复代码，变更时容易漏改 |
| 中 | `agent-runtime-dispatch.ts` | ~~PTY 分支与 headless 分支在 `doDispatch` 内并列~~ **✅ 2026-08-25 已修**（P1.9）：分别迁到 `dispatch-pty.ts`（❄️冻结原文）与 `dispatch-headless.ts`；启动准备仍不共享（PTY 冻结，不抽公共函数） | 两条路径未抽取公共启动准备函数 |
| 中 | `agent-runtime.ts:340-341` | `STUCK_WARN_MS` / `QUIESCE_MS` 等阈值通过 `Number(process.env...)` 解析，无 NaN 校验 | 非法 env 值会变为 `NaN`，导致比较永远为 false，静默关闭卡死检测 |
| 低 | 多处 | 大量魔法数字（15000ms 启动超时、300000ms 回合沉默、1800000ms 空闲回收、90000ms STUCK 等） | 生产调优需改多处，集中配置缺失 |
| 低 | `idle-reclaimer.ts:23` | 默认 60s 回收，但 `agent-runtime.ts:272` 覆盖为 1800s | 默认值与实际使用值不一致，易造成误读 |
| 低 | `terminal-log.ts:28` / `agent-runtime.ts:398-404` | 终端日志与 STUCK 警告打印 `screenText`/`output` 尾部 300 字符 | 可能泄露用户消息或工具结果到日志 |
| 低 | `supervisor.ts:67` | 崩溃退避 `restartTimes.length > 5 ? 30000 : 1000` 较简单 | 无指数退避，高频崩溃时恢复策略激进 |

#### 改进建议

- **P0**：~~为核心编排器补单元测试~~ **✅ 2026-08-25 已落地（P0.8）**：未拆分依赖注入，改用手工组装 DispatchDeps + mock 驱动模块的方式，针对 `runAgent`、`doDispatch`、成本熔断、reply guard、WS 路由写了 57 个独立测试。
- **P0**：拆分巨型函数：`createDispatch` 拆为 `prepareHeadlessDispatch`、`preparePtyDispatch`、`handleReplyGuard`、`handleProgress` 等；`handleMessage` 的每个 case 拆为私有方法/独立 handler。
- **P1**：统一错误模型；减少 `any`/`as` 使用，对 stream-json 事件、WS 线协议、`fetch` 响应建立 Zod 或保守类型校验 schema。
- **P1**：提取重复启动准备逻辑；修复 `STUCK_WARN_MS` 解析缺陷（`Number.isFinite` 校验）。
- **P1**：制定并执行冻结 PTY 代码删除计划（按 tracker 原定 2026-09 底评估）。
- **P2**：集中配置常量；引入结构化日志库并审查敏感信息打印；CI 增加测试覆盖率报告。

---

## 3. 跨维度综合风险矩阵

| 风险 | 涉及维度 | 当前状态 | 触发条件 | 业务影响 |
|---|---|---|---|---|
| headless 子进程泄漏 | 运行时、架构 | ✅ 2026-08-24 已修（P0.2） | 任何 headless agent 完成一轮对话后空闲 | 长期运行积累大量 `claude` 子进程，内存/句柄耗尽 |
| 预算熔断后仍透支 | 派发队列、产品化 | ✅ 2026-08-25 已修（P0.6） | 预算在队列积压或重试期间被耗尽 | 成本失控，熔断消息成虚假承诺 |
| secrets 流入 agent | 安全 | ✅ 2026-08-25 已修（P0.4） | 默认启动，未设 `SLOCK_ENV_WHITELIST=1` | agent 可读取 daemon 的 API key、云凭证等 |
| kill→exit 竞态误伤新回合 | 运行时 | ✅ 2026-08-24 已修（P0.1） | 回合超时 kill 且队列有后续消息 | 合法消息被反复重试甚至死信 |
| 成本数据重复计费 | 产品化 | ✅ 2026-08-25 已修（P0.5） | 取决于 Claude Code `total_cost_usd` 语义 | 预算严重虚高或虚低 |
| 核心编排器无单测 | 代码质量 | ✅ 2026-08-25 已修（P0.8） | 任何对 runtime/dispatch/daemon-core 的修改 | 回归只能靠集成测试和人工发现 |
| PTY 原生依赖污染 headless | 架构 | ✅ 2026-08-25 已修（P0.7） | 默认启动 | 启动失败风险、内存开销、维护冻结代码 |
| stop 后状态漂移 | 运行时 | ✅ 2026-08-25 已修（P0.3） | 调用 stopAgent/stopAll | 状态面板与实际不一致，STUCK 误报 |

---

## 4. 优先级路线图

### P0 · 立即（建议 1-2 周内完成）

1. **~~修复 PersistentClaude kill→exit 竞态~~** —— ✅ 2026-08-24（P0.1）：`procGen` + turn.gen 绑定进程代次，exit handler 只 reject 对应进程；超时立即 settle。
2. **~~修复 headless 空闲回收失效~~** —— ✅ 2026-08-24：`reclaimIdleAgent` 同时回收 `persistentSessions`。
3. **~~统一 stop 路径状态机语义~~** —— ✅ 2026-08-25：`haltAgent` 驱动 `transitionState`，清 `startupTimer`/`dispatchQueue`，in-flight 对照代次。
4. **~~收紧 env 白名单默认~~** —— ✅ 2026-08-25：默认 `whitelist`；`SLOCK_ENV_INHERIT=1` 排障回退。
5. **~~验证 `total_cost_usd` 语义~~** —— ✅ 2026-08-25：会话累计；差值落库；stop/reclaim 清基线。
6. **~~让成本门覆盖已入队/重试任务~~** —— ✅ 2026-08-25：队列 `deliveryGate` drain 前重估 + `doDispatch` 入口门；熔断批次丢弃完结不重试。
7. **~~headless 路径与 PTY 解耦~~** —— ✅ 2026-08-25：`agent-manager-lazy.ts` 懒加载；`writeMcpConfig` 迁出到 `agent-mcp-config.ts`。
8. **~~为核心编排器补单元测试~~** —— ✅ 2026-08-25（P0.8）：`agent-runtime-dispatch.test.ts`（23）+ `agent-runtime.test.ts`（10）+ `daemon-core.test.ts`（24），覆盖 `runAgent`、`doDispatch`、成本熔断、reply guard、WS 路由；全量 33 文件 309 用例全绿。

### P1 · 近期（建议 2-4 周内完成）

9. **~~拆分巨型函数/模块~~** —— ✅ 2026-08-25（P1.9）：`createDispatch` 抽出 pty/headless/stream；`handleMessage` → `handlers/*`；`cli.ts` → `cli/*.ts`。`createAgentRuntime` 仍偏大，不在本项。
10. **统一配置层**：新建 `src/config.ts`，集中读取/校验/默认值所有 `SLOCK_*` 环境变量。
11. **补齐 one-shot / PTY 路径成本记录**，扩展 `slock cost show` 查询维度。
12. **清理 `PersistentClaude` 事件监听器**，给 headless 会话创建加锁，失败时清理 stale session。
13. **减少 `any`/`as` 使用**：对 stream-json 事件、WS 线协议建立 Zod schema 或保守联合类型。
14. **统一错误模型**：引入标准化 `DispatchResult` 或 `Result<T, E>`，避免错误语义散落在 `console.warn` 和 `catch` 中。
15. **对 observation/terminal-log/audit 流做 token 脱敏**，设置 `.slock` 目录 0700 权限。
16. **移除 `SLOCK_DISPATCH_QUEUE=0` 回退路径与 `dispatchPromises` Map**。

### P2 · 中期（建议 1-2 个月内完成）

17. **制定并执行 PTY 代码删除计划**（按 tracker 原定 2026-09 底评估）。
18. **Context Builder 引入模型相关 token 预算**；按 thread 记录成本粒度。
19. **状态机增加 `onTransition`/`onInvalidTransition` 钩子**；`supervisor.killTree` 等待进程退出确认。
20. **固定 `daemon-costs.json` / `daemon-thread-sessions.json` 路径**到 workspace 根或 `SLOCK_WORKSPACE`。
21. **引入结构化日志库**，审查敏感信息打印；CI 增加测试覆盖率报告与门槛。
22. **对用户注入内容做 prompt 边界包装**，降低 prompt 注入面。

---

## 5. 结论与后续建议

`packages/daemon` 已经从早期单体演进到**功能完整、旁路模块测试扎实的多模块架构**。D3/T8/D1/D2/D4 等产品化能力基本满足当前需求，且对核心派发链路侵入较小。

然而，**核心运行时鲁棒性仍是最大短板**：三个已确认的 P0 缺陷（kill→exit 竞态、headless 空闲回收失效、stop 状态机不一致）都可能导致线上报错、资源泄漏或状态漂移。同时，**架构上的 headless/PTY 解耦、配置集中化、核心编排器单测覆盖**也需要尽快补齐，否则随着功能继续堆叠，回归风险会指数级上升。

建议下一轮迭代优先按本报告 P0 列表执行，尤其是运行时修复与核心编排器单测；P1/P2 按“先架构解耦、后细节打磨”的顺序推进。

> **2026-08-25 进展更新**：本报告 P0 列表（P0.1–P0.8）已全部落地。三个运行时缺陷（P0.1/P0.2/P0.3）、env 白名单收紧（P0.4）、成本语义与熔断（P0.5/P0.6）、headless/PTY 解耦（P0.7）、核心编排器单测（P0.8，57 用例）均已修复/补齐，全量 33 测试文件 309 用例全绿。结论中「核心运行时鲁棒性是最大短板」已不成立；剩余债务转入 P1（巨型函数拆分、配置集中化、类型收紧）与 P2。
>
> **2026-08-25 P1.9**：巨型函数/模块拆分落地——`createDispatch` 抽出 `agent-runtime-dispatch-{pty,headless,stream}.ts`（工厂 949→603 行）；`handleMessage` 迁到 `handlers/*`（`daemon-core.ts` 712→417 行）；`cli.ts` 按 16 个域拆到 `cli/*.ts`（1075→50 行入口）。对外 API 不变；typecheck + 33 文件 309 用例全绿。下一焦点 P1.10 统一配置层。

---

## 附录 A：测试覆盖矩阵

| 模块 | 是否有测试 | 覆盖度主观评估 | 备注 |
|---|---|---|---|
| `agent-dispatch-queue.ts` | 是 | 高 | 边界、重试、死信、dedup、合并、竞态 |
| `agent-runtime-state.ts` | 是 | 高 | 合法/非法迁移、定时器 |
| `agent-run-store.ts` | 是 | 高 | 多 agent、active 列表顺序 |
| `agent-tokens.ts` | 是 | 高 | issue/validate/revoke 竞态 |
| `agent-token-file.ts` | 是 | 高 | 含 `auth.ts` 的 TOKEN_FILE 路径 |
| `agent-env-whitelist.ts` | 是 | 高 | 白名单/warn/inherit 模式 |
| `command-presets.ts` | 是 | 高 | 白名单、resume 参数 |
| `agent-observation.ts` | 是 | 高 | 帧解析、bus、replay、transcript |
| `agent-progress.ts` | 是 | 高 | 节流、finish rewrite、关闭 |
| `agent-cost-tracker.ts` | 是 | 高 | 聚合、budget、circuit-break |
| `agent-context-builder.ts` | 是 | 高 | 打包、截断、隔离信封 |
| `agent-thread-sessions.ts` | 是 | 中 | upsert/lookup/list |
| `live-run-registry.ts` | 是 | 中 | CRUD + pending exit code |
| `drivers/persistent-claude.ts` | 是 | 高 | 回合 Promise、超时、退出、分片 |
| `session-resume.test.ts` | 是 | 中 | fake PTY 集成，resume 成功/失败/慢失败 |
| `round-end.integration.test.ts` | 是 | 高 | 真实屏幕帧 fixture 回归 |
| `round-end-detection.test.ts` | 是 | 低 | 仅正则 |
| `terminal-state.test.ts` | 是 | 中 | viewport vs scrollback |
| `post-start-input-writer.test.ts` | 是 | 中 | 纯函数；writer 时序未测 |
| `spawn-env.test.ts` | 是 | 中 | buildPtyEnv、writeMcpConfig |
| `probe.test.ts` | 是 | 中 | mock execFileSync |
| `patrol-prompt.test.ts` | 是 | 中 | prompt 内容 |
| `triage-prompt.test.ts` | 是 | 中 | prompt 内容 + `pickLocalTriageAgent` |
| `mcp-server.test.ts` | 是 | 高 | 真实子进程 + HTTP server 集成 |
| `agent-workspace.test.ts` | 是 | 中 | 白名单、读/列文件 |
| `ready-payload.test.ts` | 是 | 低 | 仅结构 |
| `agent-runtime.ts` | 是 | 高 | P0.8：注册表/mention 解析/loadExistingAgents（duty 过滤、非 2xx 保留注册）；stop 语义见 P0.3 `agent-runtime-stop.test.ts` |
| `agent-runtime-dispatch.ts` | 是 | 高 | P0.8：doDispatch 链路、P0.5 成本差值、三道成本门、死信/合并/去重、reply guard、runAgent 系列路由 |
| `agent-runtime-spawn.ts` | **否** | **无** | PTY spawn 冻结代码 |
| `daemon-core.ts` | 是 | 高 | P0.8：handleMessage 全 case；P1.9：路由已迁 `handlers/*`，测试仍调私有 `handleMessage` |
| `cli.ts` / `cli/*` | **否** | **无** | P1.9 按域拆分；整个 CLI 仍无测 |
| `client.ts` | **否** | **无** | API 客户端 |
| `proxy.ts` | **否** | **无** | HTTP 代理 |
| `auth.ts` | **否** | **无** | 仅 token-file 路径被间接覆盖 |
| `claude-print.ts` | **否** | **无** | one-shot 路径 |
| `idle-reclaimer.ts` | 是 | 高 | P0.2：timeout/untrack/skip-if-working + headless session.stop |
| `exit-coordinator.ts` / `exit-handler.ts` | **否** | **无** | 退出时序保护 |
| `system-prompt.ts` / `agent-startup.ts` | **否** | **无** | 系统提示生成 |
| `mcp-bundle.ts` / `setup-slock-wrapper.ts` | **否** | **无** | esbuild 打包 |
| `terminal-log.ts` / `restart-summary.ts` | **否** | **无** | 日志/摘要 |

---

## 附录 B：术语表

- **A1 队列**：`agent-dispatch-queue.ts` 实现的 per-agent 串行派发队列，含去重、合并、退避、死信。
- **T8 经理分诊**：`messages.ts` 中当顶层消息未命中任何 agent 时，由经理 agent 主动分诊的设计。
- **D1 / D2**：线程追问上下文构建（Context Builder）与 thread↔session 亲和设计。
- **D3**：成本记账与预算熔断。
- **D4 / T4**：观察帧产品化，包括频道进度条与顶栏 `agent:progress`。
- **headless**：默认驱动 `drivers/persistent-claude.ts`，使用 `--input-format/--output-format stream-json` 与 Claude Code 子进程通信。
- **PTY**：冻结保留的 legacy 驱动路径，通过 `node-pty` 与 TUI 交互，默认不启用。
- **reply-guard**：当 agent 回合结束但未发送任何消息时，由 daemon 代发最后一段文本的机制。
