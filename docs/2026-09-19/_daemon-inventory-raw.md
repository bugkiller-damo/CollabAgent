# Daemon 模块盘点 — 原始数据（_daemon-inventory-raw）

采集时间：2026-09-19。纯机械采集，不含主观评价。仓库 `D:\code\slock`，目标 `packages/daemon`。

---

## 1. 源码清单（packages/daemon/src，共 90 个 .ts 文件）

注：`src/auth/` 与 `src/commands/` 为存在但无任何文件的**空目录**。

### src/ 根目录（63 个文件，末行 types/index.ts 实际位于 src/types/ 子目录）

| 文件 | 行数 | 导出顶层符号 | 文件头注释摘要 |
|---|---|---|---|
| agent-context-builder.ts | 178 | HistoryMessage, ContextPack, ContextBudget, DEFAULT_CONTEXT_MAX_MESSAGES, DEFAULT_CONTEXT_MAX_CHARS, contextBuilderEnabled, readContextBudget, normalizeThreadId, packThreadContext, wrapWithIsolation, prependContext, FetchThreadHistoryInput, fetchThreadHistory, buildThreadContextEnvelope（另 re-export parsePositiveInt） | D1 Context Builder（Step 6）：线程追问入队前拉该线程历史、截断后拼进 prompt |
| agent-cost-tracker.ts | 459 | AgentCostRecord, CostTurnInput, CostRecordFilter, CostSpendRow, CostChannelSpendRow, CostDaySpendRow, ICostTracker, extractResultMetrics, createSessionCostDelta, utcDay, shouldCircuitBreak, CostGateDecision, evaluateCostGate, buildCircuitBreakMessage, defaultCostStorePath, normalizeCostChannel, createJsonCostTracker（另 re-export parseCostBudgetUsd） | 无（首行即 import） |
| agent-dir-name.ts | 25 | safeAgentDirName, legacyAgentDirName | Agent 名 → 文件系统安全目录/文件名 |
| agent-dispatch-queue.ts | 352 | DispatchQueueItem, DispatchDeliverFn, DispatchQueueOptions, EnqueueStatus, AgentDispatchQueue, createAgentDispatchQueue | EventQueue 式派发队列（改造方案 A1） |
| agent-env-whitelist.ts | 111 | AgentEnvMode, resolveAgentEnvMode, buildAgentEnv, diffAgentEnv, applyAgentEnv | 子进程 env 默认清空 + 显式白名单（A2 / P0.4） |
| agent-manager.ts | 152 | createAgentManager, removeAgentRun（另 re-export attachAgentPty, finishAgentRun, toAgentRunSnapshot） | ❄️ LEGACY / FROZEN（2026-08-20 Step 3）：仅服务 PTY fallback（SLOCK_USE_PTY=1） |
| agent-manager-lazy.ts | 67 | ILazyAgentManager, createLazyAgentManager | P0.7（2026-08-25）：懒加载 IAgentManager |
| agent-manager-support.ts | 164 | AgentRunProcess, MAX_RUN_OUTPUT_LENGTH, attachAgentPty, finishAgentRun, toAgentRunSnapshot | ❄️ LEGACY / FROZEN（2026-08-20 Step 3）：仅服务 PTY fallback |
| agent-mcp-config.ts | 72 | writeMcpConfig | Agent workspace 的 MCP 配置写入（headless + PTY 共用）；P0.7 从冻结文件迁出 |
| agent-observation.ts | 231 | ObservationBus, streamEventToFrames, renderFrame, ObservationBusOptions, createObservationBus, createSeqAllocator | 结构化观察帧总线（B1） |
| agent-progress.ts | 136 | ProgressPoster, ProgressTurn, CreateProgressTurnOpts, createProgressTurn | D4 频道内进度消息：节流聚合观察帧 → 原地更新的 ⏳ 消息 |
| agent-run-store.ts | 139 | createJsonRunStore, defaultStorePath | 无 |
| agent-runtime.ts | 675 | AgentRuntimeOptions, IAgentRuntime, createAgentRuntime（另 re-export BUSY_MARKER_RE, PROMPT_RE） | 无 |
| agent-runtime-credentials.ts | 47 | ICredentialsClient, createCredentialsClient | Per-agent-run scoped token（对应服务端 agent_credentials 端点） |
| agent-runtime-dispatch.ts | 601 | ReminderFirePayload, buildPatrolPrompt, buildTriagePrompt, pickLocalTriageAgent, IDispatch, DispatchDeps, createDispatch | 无 |
| agent-runtime-dispatch-headless.ts | 276 | DispatchHeadlessTurnOpts, ensurePersistentSession, dropStalePersistentSession, dispatchHeadlessTurn | 无 |
| agent-runtime-dispatch-pty.ts | 139 | DispatchPtyTurnOpts, dispatchPtyTurn | ❄️ LEGACY / FROZEN（2026-08-20 Step 3；P1.9 整块迁出，内部不改） |
| agent-runtime-dispatch-stream.ts | 300 | REPLY_GUARD_PREFIX, TurnGuard, SessionCostDelta, StreamTurnHandlerOpts, isSendToolFrame, abortTurnGuards, armTurnGuard, createStreamTurnHandler, NotifyCircuitBreak | 无 |
| agent-runtime-exit.ts | 162 | RunContextEntry, IExitChain, ExitChainDeps, createExitChain | 无 |
| agent-runtime-spawn.ts | 464 | buildPtyEnv, SpawnPtyForAgentDeps, SpawnPtyForAgent, createSpawnPtyForAgent | ❄️ LEGACY / FROZEN（2026-08-20 Step 3 标注；2026-08-25 P0.7 纯化） |
| agent-runtime-state.ts | 107 | WorkingAgentInfo, IAgentStateMachine, createAgentStateMachine | 无 |
| agent-runtime-terms-dialog.ts | 129 | isClaudeAcceptDialog, installTermsAcceptHandler | ❄️ LEGACY / FROZEN（2026-08-20 Step 3） |
| agent-runtime-turn-tracker.ts | 71 | BUSY_MARKER_RE, PROMPT_RE, ITurnTracker, createTurnTracker | ❄️ LEGACY / FROZEN（2026-08-20 Step 3） |
| agent-sessions.ts | 111 | mangleClaudeProjectPath, captureSessionId, listSessions, isValidSessionId, readSessionMetadata | 冻结状态（2026-08-20 Step 3）：随 PTY fallback 一并 ❄️ 冻结保留（头部 JSDoc 注明） |
| agent-startup.ts | 164 | DispatchContext, fetchDispatchContext, writeSystemPromptFile, agentWorkspacePath, createWorkspaceDir, buildStartupInstructions, buildIdentityMarker, buildProtocolDoc, buildReminderTail | 无 |
| agent-stdin-dispatcher.ts | 77 | createAgentStdinDispatcher | ❄️ LEGACY / FROZEN（2026-08-20 Step 3）：唯一 writer 是 PTY 专属，整体随 PTY 冻结 |
| agent-thread-sessions.ts | 91 | ThreadSessionRecord, IThreadSessionStore, defaultThreadSessionStorePath, createJsonThreadSessionStore | 无 |
| agent-token-file.ts | 48 | AGENT_TOKEN_FILENAME, agentTokenFilePath, writeAgentTokenFile, removeAgentTokenFile | 无 |
| agent-tokens.ts | 64 | createAgentTokenRegistry | 无 |
| agent-workspace.ts | 116 | WORKSPACE_MAX_BYTES, WorkspaceFileMeta, WorkspaceListing, WorkspaceReadResult, isAllowedWorkspaceRel, listWorkspaceFiles, readWorkspaceFile | 无 |
| auth.ts | 139 | AgentContext, AgentBootstrapError, loadAgentContext | 无 |
| claude-print.ts | 120 | ClaudePrintResult, claudePrint, isClaudeAvailable | 无 |
| claude-stream.ts | 54 | isPlainObject, ClaudeStreamSystemEvent, ClaudeStreamAssistantEvent, ClaudeStreamUserEvent, ClaudeStreamResultEvent, ClaudeStreamEvent, asClaudeStreamEvent | Claude Code `--output-format stream-json` 事件的保守联合类型（P1.13） |
| cli.ts | 46 | （无顶层具名导出；re-export program） | `#!/usr/bin/env node`（CLI 入口） |
| client.ts | 113 | ApiResponse, ApiClient | 无 |
| command-presets.ts | 78 | getClaudePermissionArgs, COMMAND_PRESETS, getCommandPreset, renderResumeArgs（另 re-export DEFAULT_AGENT_ALLOWED_TOOLS） | 无 |
| command-resolver.ts | 80 | getPathDirs, getPathExtensions, findInDir, searchInPath, resolveCommand, quoteForShell | 无 |
| config.ts | 162 | AgentEffort, DEFAULT_AGENT_ALLOWED_TOOLS, DAEMON_ENV_DEFAULTS, DaemonEnv, parsePositiveInt, parseNonNegativeInt, parseCostBudgetUsd, loadDaemonEnv | P1.10 统一配置层：daemon 进程级 `SLOCK_*` 的读取/校验/默认值 |
| cost-reporter.ts | 166 | CostReporterOptions, CostReporter, createCostReporter | 无 |
| daemon-core.ts | 461 | DaemonCore | 无 |
| errors.ts | 53 | errMessage, DispatchErrorCode, DispatchError, isDispatchError, errCode, isRetriableError | 单行注释：从 unknown catch 取值；P1.14 统一错误模型 DispatchError |
| exit-coordinator.ts | 61 | IExitCoordinator, createExitCoordinator | 无 |
| exit-handler.ts | 72 | ExitContext, ExitHandler, createExitHandler, ExitHandlerOptions, createMinimalExitHandler | 无 |
| idle-reclaimer.ts | 129 | IdleReclaimerOptions, IIdleReclaimer, createIdleReclaimer, reclaimIdleAgent | 无 |
| index.ts | 100 | （无顶层具名导出） | `#!/usr/bin/env node`（daemon 进程入口） |
| live-run-registry.ts | 89 | createLiveRunRegistry | 无 |
| machine-id.ts | 54 | defaultMachineIdPath, resolveMachineUuid | 无 |
| mcp-bundle.ts | 53 | bundleSlockMcpServer | 无 |
| output.ts | 17 | CliExit, emit, fail | 无（首行即 `export class CliExit`） |
| post-start-input-writer.ts | 207 | INTERACTIVE_COMMANDS, commandBaseName, hasInteractivePromptReady, toBracketedPasteSubmission, hasPasteAck, PostStartInputWriter, createPostStartInputWriter | ❄️ LEGACY / FROZEN（2026-08-20 Step 3） |
| private-dir.ts | 15 | mkdirPrivateSync | 无 |
| proxy.ts | 74 | buildFetchDispatcher | 无 |
| pty-output-bus.ts | 71 | PtyOutputBus, createPtyOutputBus | ❄️ LEGACY / FROZEN（2026-08-20 Step 3） |
| ready-payload.ts | 47 | readDaemonVersion, resolveHostname, buildReadyPayload | 无 |
| redact.ts | 32 | redactSecrets, redactDeep | P1.15：token 脱敏——观察帧/terminal log/WS 围观流共用的出口清洗 |
| restart-summary.ts | 83 | MAX_RUNS_IN_SUMMARY, RunSummary, summarizeRun, summarizeRecentRuns, formatRestartSummary | 无 |
| setup-slock-wrapper.ts | 77 | setupSlockWrapper | 无 |
| supervisor.ts | 160 | （无顶层具名导出） | Daemon 监督进程：文件变更自动重启（dev watch）+ 崩溃自动重启（带退避）+ 干净关闭 |
| system-prompt.ts | 113 | AgentIdentity, DispatchContext, generateRelaySystemPrompt, generateSystemPrompt | 无（首行即 `export interface AgentIdentity`） |
| terminal-log.ts | 60 | appendTerminalLog, readTerminalLogTail | 无 |
| terminal-state.ts | 85 | ITerminalState, createTerminalState | ❄️ LEGACY / FROZEN（2026-08-20 Step 3） |
| types/index.ts | 225 | AgentStatus, RunStatus, AgentInfo, LiveAgentRun, AgentRunSnapshot, AgentRunRecord, AgentRuntimeState, StartAgentInput, DaemonConfig, AgentMessage, PtyOutputEvent, PtyOutputBus, SessionCaptureConfig, CommandPreset, IAgentTokenRegistry, ILiveRunRegistry, IAgentManager, IAgentRunStore, IAgentStartup, IAgentStdinDispatcher | Daemon — 共享类型定义（避免循环引用） |

### src/cli/（16 个文件）

| 文件 | 行数 | 导出顶层符号 | 文件头注释摘要 |
|---|---|---|---|
| cli/agent.ts | 38 | registerAgent | 无 |
| cli/attachment.ts | 50 | registerAttachment | 无 |
| cli/auth.ts | 22 | registerAuth | 无 |
| cli/channel.ts | 49 | registerChannel | 无 |
| cli/context.ts | 7 | getClient | 无 |
| cli/cost.ts | 76 | CostShowGroup, CostShowOpts, buildCostShowResult, registerCost | 无 |
| cli/dispatch.ts | 76 | registerDispatch | 无 |
| cli/duration.ts | 17 | parseDuration | 无（首行即 export function） |
| cli/message.ts | 128 | registerMessage | 无 |
| cli/patrol.ts | 134 | registerPatrol | 无 |
| cli/profile.ts | 35 | registerProfile | 无 |
| cli/reminder.ts | 126 | registerReminder | 无 |
| cli/server.ts | 15 | registerServer | 无 |
| cli/session.ts | 14 | registerSession | 无 |
| cli/task.ts | 91 | registerTask | 无 |
| cli/thread.ts | 18 | registerThread | 无 |

### src/drivers/（2 个文件）

| 文件 | 行数 | 导出顶层符号 | 文件头注释摘要 |
|---|---|---|---|
| drivers/persistent-claude.ts | 388 | PersistentClaudeOpts, PersistentClaude | 无 |
| drivers/probe.ts | 66 | resolveCommandOnPath, probeBinary, probeClaude, probeRuntimes | 无 |

### src/handlers/（8 个文件）

| 文件 | 行数 | 导出顶层符号 | 文件头注释摘要 |
|---|---|---|---|
| handlers/agent.ts | 47 | handleAgentStart, handleAgentStop, handleAgentDuty | 无 |
| handlers/deliver.ts | 145 | formatAttachmentSummary, handleAgentDeliver | 无 |
| handlers/inbound.ts | 185 | readDeliverMessage, parseWsToDaemonMessage | server → daemon WS 入站收口（P1.13）：归一化松散变体 |
| handlers/index.ts | 51 | dispatchDaemonMessage（另 re-export parseWsToDaemonMessage, HandlerContext） | 无 |
| handlers/ping.ts | 5 | handlePing | 无 |
| handlers/reminder.ts | 22 | handleReminderFire | 无 |
| handlers/terminal.ts | 120 | handleTerminalWatch, handleTerminalHistory, handleTerminalUnwatch, handleTerminalResize | 无 |
| handlers/types.ts | 11 | HandlerContext | 无 |
| handlers/workspace.ts | 44 | handleWorkspaceRead | 无 |

### src/mcp/（1 个文件）

| 文件 | 行数 | 导出顶层符号 | 文件头注释摘要 |
|---|---|---|---|
| mcp/slock-mcp-server.ts | 521 | （无顶层具名导出；文件为可执行 MCP server 脚本） | 无 |

---

## 2. 测试清单（packages/daemon/test，共 43 个 .test.ts 文件）

| 测试文件 | 行数 | describe | it | test | import 的 src 模块 |
|---|---|---|---|---|---|
| agent-context-builder.test.ts | 116 | 3 | 10 | 0 | agent-context-builder |
| agent-cost-tracker.test.ts | 379 | 7 | 30 | 0 | agent-cost-tracker, cli/cost |
| agent-dispatch-queue.test.ts | 315 | 1 | 17 | 0 | agent-dispatch-queue, errors |
| agent-env-whitelist.test.ts | 126 | 4 | 10 | 0 | agent-env-whitelist |
| agent-manager-lazy.test.ts | 134 | 2 | 6 | 0 | agent-manager-lazy, agent-runtime, agent-tokens, live-run-registry, types/index |
| agent-observation.test.ts | 256 | 5 | 15 | 0 | agent-observation |
| agent-progress.test.ts | 169 | 3 | 10 | 0 | agent-progress |
| agent-run-store.test.ts | 178 | 3 | 5 | 0 | agent-run-store, types/index |
| agent-runtime-dispatch-headless.test.ts | 221 | 3 | 8 | 0 | agent-runtime-dispatch-headless, agent-runtime-state, drivers/persistent-claude, idle-reclaimer |
| agent-runtime-dispatch-pty-cost.test.ts | 131 | 1 | 2 | 0 | agent-observation, agent-runtime-dispatch, agent-runtime-dispatch-pty, agent-runtime-state, agent-runtime-turn-tracker, idle-reclaimer |
| agent-runtime-dispatch.test.ts | 674 | 5 | 24 | 0 | agent-context-builder, agent-observation, agent-runtime-dispatch, agent-runtime-state, agent-runtime-turn-tracker, idle-reclaimer |
| agent-runtime-state.test.ts | 170 | 6 | 13 | 0 | agent-runtime-state |
| agent-runtime-stop.test.ts | 170 | 1 | 6 | 0 | agent-runtime, agent-tokens, live-run-registry |
| agent-runtime.test.ts | 181 | 2 | 10 | 0 | agent-runtime, agent-tokens, live-run-registry |
| agent-sessions.test.ts | 67 | 1 | 3 | 0 | agent-sessions |
| agent-thread-sessions.test.ts | 56 | 1 | 3 | 0 | agent-thread-sessions |
| agent-token-file.test.ts | 93 | 2 | 9 | 0 | agent-token-file, auth |
| agent-tokens.test.ts | 98 | 5 | 15 | 0 | agent-tokens |
| agent-workspace.test.ts | 66 | 2 | 3 | 0 | agent-dir-name, agent-startup, agent-workspace |
| command-presets.test.ts | 90 | 5 | 13 | 0 | command-presets |
| config.test.ts | 158 | 2 | 11 | 0 | config |
| cost-reporter.test.ts | 205 | 1 | 9 | 0 | agent-cost-tracker, cost-reporter |
| daemon-core.test.ts | 354 | 6 | 24 | 0 | agent-observation, daemon-core |
| deliver-attachments.test.ts | 201 | 2 | 8 | 0 | agent-runtime, handlers/deliver, handlers/types |
| errors.test.ts | 44 | 1 | 6 | 0 | errors |
| idle-reclaimer.test.ts | 209 | 2 | 10 | 0 | drivers/persistent-claude, idle-reclaimer |
| live-run-registry.test.ts | 99 | 5 | 10 | 0 | live-run-registry, types/index |
| machine-id.test.ts | 61 | 1 | 6 | 0 | machine-id |
| mcp-server.test.ts | 274 | 1 | 7 | 0 | mcp-bundle |
| p1-13-protocol.test.ts | 144 | 3 | 10 | 0 | claude-stream, errors, handlers/inbound |
| patrol-prompt.test.ts | 47 | 1 | 7 | 0 | agent-runtime-dispatch |
| persistent-claude.test.ts | 292 | 1 | 13 | 0 | drivers/persistent-claude |
| post-start-input-writer.test.ts | 85 | 4 | 14 | 0 | post-start-input-writer |
| probe.test.ts | 56 | 2 | 3 | 1 | drivers/probe（动态 `await import`） |
| ready-payload.test.ts | 30 | 1 | 3 | 0 | ready-payload |
| redact.test.ts | 60 | 2 | 8 | 0 | redact |
| round-end-detection.test.ts | 40 | 2 | 6 | 6 | agent-runtime |
| round-end.integration.test.ts | 201 | 1 | 6 | 0 | agent-runtime, agent-tokens, live-run-registry |
| session-resume.test.ts | 268 | 1 | 5 | 0 | agent-run-store, agent-runtime, agent-tokens, live-run-registry, types/index |
| spawn-env.test.ts | 61 | 2 | 4 | 0 | agent-mcp-config, agent-runtime-spawn |
| terminal-log.test.ts | 48 | 1 | 3 | 0 | terminal-log（动态 `await import`，vi.resetModules 配合） |
| terminal-state.test.ts | 34 | 1 | 2 | 0 | terminal-state |
| triage-prompt.test.ts | 46 | 2 | 6 | 0 | agent-runtime-dispatch |

### 未被任何测试文件 import 的 src 文件（44 个；含动态 import 口径）

- agent-manager-support.ts
- agent-manager.ts
- agent-runtime-credentials.ts
- agent-runtime-dispatch-stream.ts
- agent-runtime-exit.ts
- agent-runtime-terms-dialog.ts
- agent-stdin-dispatcher.ts
- claude-print.ts
- cli.ts
- client.ts
- command-resolver.ts
- exit-coordinator.ts
- exit-handler.ts
- index.ts
- output.ts
- private-dir.ts
- proxy.ts
- pty-output-bus.ts
- restart-summary.ts
- setup-slock-wrapper.ts
- supervisor.ts
- system-prompt.ts
- cli/agent.ts
- cli/attachment.ts
- cli/auth.ts
- cli/channel.ts
- cli/context.ts
- cli/dispatch.ts
- cli/duration.ts
- cli/message.ts
- cli/patrol.ts
- cli/profile.ts
- cli/reminder.ts
- cli/server.ts
- cli/session.ts
- cli/task.ts
- cli/thread.ts
- handlers/agent.ts
- handlers/index.ts
- handlers/ping.ts
- handlers/reminder.ts
- handlers/terminal.ts
- handlers/workspace.ts
- mcp/slock-mcp-server.ts

（被覆盖的 46 个：agent-context-builder, agent-cost-tracker, agent-dir-name, agent-dispatch-queue, agent-env-whitelist, agent-manager-lazy, agent-mcp-config, agent-observation, agent-progress, agent-run-store, agent-runtime, agent-runtime-dispatch, agent-runtime-dispatch-headless, agent-runtime-dispatch-pty, agent-runtime-spawn, agent-runtime-state, agent-runtime-turn-tracker, agent-sessions, agent-startup, agent-thread-sessions, agent-token-file, agent-tokens, agent-workspace, auth, claude-stream, cli/cost, command-presets, config, cost-reporter, daemon-core, drivers/persistent-claude, drivers/probe, errors, handlers/deliver, handlers/inbound, handlers/types, idle-reclaimer, live-run-registry, machine-id, mcp-bundle, post-start-input-writer, ready-payload, redact, terminal-log, terminal-state, types/index）

---

## 3. 实际运行结果（packages/daemon 下执行）

### `npx tsc --noEmit -p tsconfig.json`

- 退出码：**0（零错误）**，无任何输出。

### `npx vitest run`

```
 Test Files  43 passed (43)
      Tests  399 passed (399)
   Start at  19:48:00
   Duration  49.36s (transform 1.84s, setup 0ms, import 6.67s, tests 27.18s, environment 8ms)
```

- 43 个测试文件全部通过，399 个用例全部通过，0 失败。
- 输出中的 stderr 行均为测试内故意触发的日志（如 `[ObservationBus] listener error: boom`、`dispatchToAgent failed: process died mid-turn`、`[Presets] Unknown CLI 'nonexistent'`），非失败。

---

## 4. 环境变量清单（src 下 `SLOCK_[A-Z0-9_]+`）

共 37 个大写 SLOCK_* 标识符，其中 **34 个有真实 env 读取点**（`env.X` / `process.env.X`），3 个仅出现在注释中（已移除/历史别名）。另有 1 个小写误匹配 `slock__send_message`（agent-runtime-dispatch-stream.ts:56，是 MCP 工具名而非环境变量，已剔除）。

### 4a. 经 config.ts `loadDaemonEnv()` 集中读取（默认值见 DAEMON_ENV_DEFAULTS）

| 变量 | 默认 | 语义（config.ts 注释原文摘要） |
|---|---|---|
| SLOCK_USE_PTY | false | `=1` 启用冻结的 PTY fallback（默认 headless） |
| SLOCK_ONESHOT_CLAUDE | false | `=1` headless 退到 claudePrint 一次性模式 |
| SLOCK_REPLY_GUARD | true | `=0` 关闭「回合结束未发消息则代发」 |
| SLOCK_CHANNEL_PROGRESS | true | `=0` 关频道内 ⏳ 进度（顶栏仍在） |
| SLOCK_CONTEXT_BUILDER | true | `=0` 关闭线程追问历史注入 |
| SLOCK_SESSION_RESUME | true | `=0` 关闭 PTY `--resume`（捕获仍开） |
| SLOCK_ENV_INHERIT | false | `=1` 子进程全量继承 daemon env（排障回退） |
| SLOCK_VERBOSE_PTY | false / 复用为 logPtyBus(`!=="0"`) | `=1` 把 PTY 字节镜像到 stdout；`=0` 关闭 daemon-core 的 PTY bus 就绪日志 |
| SLOCK_IDLE_RECLAIM_MS | 1800000 | 空闲回收超时 |
| SLOCK_STUCK_WARN_MS | 90000 | PTY working 过久警告 |
| SLOCK_QUIESCE_MS | 20000 | PTY 静默兜底回合结束窗口 |
| SLOCK_DISPATCH_INFLIGHT_MS | 360000 | A1 队列 in-flight 截止（默认 6min） |
| SLOCK_DISPATCH_MAX_RETRIES | 3 | A1 队列最大尝试次数 |
| SLOCK_PERSISTENT_TURN_MS | 300000 | PersistentClaude 沉默超时 |
| SLOCK_RESUME_GRACE_MS | 3000 | PTY resume 快速失败窗口（测试向） |
| SLOCK_SESSION_CAPTURE_DELAY_MS | 5000 | 捕获 sessionId 前等待（测试向） |
| SLOCK_CONTEXT_MAX_MESSAGES | 40 | D1 线程历史条数上限 |
| SLOCK_CONTEXT_MAX_CHARS | 8000 | D1 线程历史字符上限 |
| SLOCK_PROGRESS_THROTTLE_MS | 2000 | 频道进度条刷新节流（非负整数，0 合法） |
| SLOCK_COST_BUDGET_USD | null | 每 agent 每 UTC 日预算；未设/非正数 → 不熔断 |
| SLOCK_COST_REPORT | true | `=0` 关闭 daemon→server 成本上报（P1.24） |
| SLOCK_AGENT_ALLOWED_TOOLS | `Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,TodoWrite,mcp__slock` | 覆盖默认 `--allowedTools` |
| SLOCK_AGENT_EFFORT | medium | `low`/`medium`/`high`，非法回落 medium |

### 4b. 其他真实读取点（不经 config.ts）

| 变量 | 首次出现 | 语义（就近注释/代码摘取） |
|---|---|---|
| SLOCK_SERVER_URL | auth.ts:47；agent-mcp-config.ts:42 | server 地址；同时作为子进程注入键写入 .mcp.json env |
| SLOCK_SERVER_ID | auth.ts:47 | `const serverId = env.SLOCK_SERVER_ID ?? null` |
| SLOCK_AGENT_ACTIVE_CAPABILITIES | auth.ts:48 | 逗号分隔列表 `.split(",")`（agent 能力声明） |
| SLOCK_AGENT_PROXY_URL | auth.ts:58 | Mode 1 managed-runner（proxy-based auth）；有 token 时必填 |
| SLOCK_AGENT_PROXY_TOKEN | auth.ts:59 | managed-runner 代理 token（二选一与 *_FILE） |
| SLOCK_AGENT_PROXY_TOKEN_FILE | auth.ts:60 | managed-runner 代理 token 文件路径 |
| SLOCK_AGENT_CREDENTIAL_KEY_FILE | auth.ts:94 | Mode 2 self-hosted-runner（agent credential key file） |
| SLOCK_AGENT_TOKEN | agent-env-whitelist.ts:57/75 | O11 兜底：结果 env 里绝不含明文 token（防御性 `delete env.SLOCK_AGENT_TOKEN`）；auth.ts 亦为激活凭据来源之一 |
| SLOCK_AGENT_ID | agent-mcp-config.ts:40 | 子进程注入键（MCP server 读） |
| SLOCK_AGENT_TOKEN_FILE | agent-mcp-config.ts:33/41 | O11：.mcp.json 只放 token 文件路径，MCP server 启动时按此读文件取 token |
| SLOCK_MACHINE_ID | machine-id.ts:20/36 | 解析优先级：显式 override > SLOCK_MACHINE_ID env（容器/多实例手工指定）> 持久化文件 > 新生成 |

### 4c. 仅注释提及（无读取点）

| 变量 | 出现处 | 注释原文摘取 |
|---|---|---|
| SLOCK_DISPATCH_QUEUE | agent-runtime-dispatch.ts:399 | "旧 SLOCK_DISPATCH_QUEUE=0 门控链"（P1.16 已删除回退路径与 config 解析） |
| SLOCK_PERSISTENT_CLAUDE | agent-runtime.ts:236；config.ts:15 | 不读的历史别名：2026-08-18 起与默认 headless 等价，保留兼容但不消费 |
| SLOCK_ENV_WHITELIST | agent-env-whitelist.ts:15；config.ts:16 | P0.4 后与默认同为 whitelist，no-op 兼容 |

---

## 5. CLI 命令清单（src/cli.ts + src/cli/*.ts）

顶层：`program.name("slock").description("Agent-facing execution interface for CollabAgent").version("0.1.0")`（cli.ts:20）。

注册的顶层子命令（cli.ts:22-35）：auth, channel, thread, server, message, attachment, task, dispatch, profile, reminder, patrol, agent, cost, session。

| 命令 | description 原文 | 参数 / option |
|---|---|---|
| `auth whoami` | "Print the agent context resolved from env (token redacted)" | — |
| `channel members <target>` | "List agents and humans who are members of a channel, DM, or thread" | `<target>`: Channel / DM / thread target |
| `channel join` | "Join a visible public channel" | `--target <target>`（必填） |
| `channel leave` | "Leave a regular channel you have joined" | `--target <target>`（必填） |
| `thread unfollow` | "Stop following a thread" | `--target <target>`（必填） |
| `server info` | "List channels, agents, and humans on the current server" | — |
| `message send` | "Send a message to a channel, DM, or thread. Content is read from stdin." | `--target <target>`（必填）, `--send-draft`, `--attachment-id <id>`（可重复） |
| `message check` | "Non-blocking check for new messages" | — |
| `message read` | "Read message history for a channel, DM, or thread" | `--channel <target>`（必填）, `--before <seq>`, `--after <seq>`, `--around <idOrSeq>`, `--limit <n>` |
| `message search` | "Search messages" | `--query <q>`（必填）, `--channel <target>`, `--sender <handle>`, `--limit <n>` |
| `message react` | "Add or remove your reaction on a message" | `--message-id <id>`（必填）, `--emoji <emoji>`（必填）, `--remove` |
| `attachment upload` | "Upload a local file as an attachment" | `--path <filepath>`（必填）, `--mime-type <type>` |
| `attachment view` | "Download an attachment by ID" | `--id <attachmentId>`（必填）, `--output <path>`（必填） |
| `task list` | "List tasks in a channel" | `--channel <target>`（必填）, `--status <s>` |
| `task create [titles...]` | "Create one or more tasks in a channel" | `--channel <target>`（必填） |
| `task claim` | "Claim tasks by number or message ID" | `--channel <target>`（必填）, `--number <n>`, `--message-id <id>` |
| `task unclaim` | "Release a previously claimed task" | `--channel <target>`（必填）, `--number <n>`（必填） |
| `task update` | "Update task status" | `--channel <target>`（必填）, `--number <n>`（必填）, `--status <status>`（必填，todo\|in_progress\|in_review\|done） |
| `dispatch create <text>` | "Dispatch a task to a worker agent (channel manager only)" | `--channel <target>`（必填）, `--to <agent>`（必填） |
| `dispatch list` | "List dispatches relevant to this agent in a channel" | `--channel <target>`（必填）, `--status <s>`（open\|reported\|cancelled） |
| `dispatch report <reportText>` | "Report on a dispatch assigned to this agent" | `--id <dispatchId>`（必填） |
| `dispatch cancel` | "Cancel a dispatch this agent created (channel manager only)" | `--id <dispatchId>`（必填）, `--reason <reason>` |
| `profile show [target]` | "Show a profile (omit target for self)" | `[target]` Handle like @alice |
| `profile update` | "Update your own profile" | `--display-name <name>`, `--description <text>` |
| `reminder schedule` | "Schedule a reminder" | `--title <t>`（必填）, `--fire-at <iso>`, `--in <duration>`, `--cadence <rule>`, `--channel <ch>`, `--tz <iana>` |
| `reminder list` | "List your reminders" | `--all` |
| `reminder cancel` | "Cancel a scheduled reminder" | `--id <id>`（必填） |
| `reminder snooze` | "Snooze a reminder" | `--id <id>`（必填）, `--by <duration>`（必填） |
| `reminder update` | "Update a scheduled reminder" | `--id <id>`（必填）, `--fire-at`, `--in`, `--cadence`, `--title`, `--tz` |
| `reminder log` | "Show lifecycle events for a reminder" | `--id <id>`（必填） |
| `patrol create` | "Create a patrol job (recurring proactive check)" | `--title <t>`（必填）, `--instructions <text>`（必填）, `--every <duration>`, `--cadence <rule>`, `--channel <ch>`, `--max-silent <n>` |
| `patrol list` | "List your patrol jobs" | `--all` |
| `patrol pause` | "Pause a patrol job (stays in place, not scheduled)" | `--id <id>`（必填） |
| `patrol resume` | "Resume a paused patrol job (fresh schedule, silent counter reset)" | `--id <id>`（必填） |
| `patrol cancel` | "Cancel a patrol job permanently" | `--id <id>`（必填） |
| `patrol update` | "Update a patrol job" | `--id <id>`（必填）, `--title`, `--instructions`, `--cadence`, `--max-silent` |
| `patrol log` | "Show lifecycle events for a patrol job (fired/outcome/paused/resumed/auto_paused)" | `--id <id>`（必填） |
| `agent duty <state> [name]` | "Set agent duty (on = eligible to wake, off = off duty)" | `<state>` on\|off；`[name]` 缺省当前 agent context |
| `agent ls` | "List agents visible to this token (includes DUTY / PRESENCE)" | `--mine` |
| `cost show`（isDefault） | "Show local daemon spend totals (UTC days, default last 7)" | `--days <n>`（默认 7）, `--agent <name>`, `--channel <name>`, `--day <YYYY-MM-DD>`, `--thread <id>`, `--group <agent\|channel\|day>`（默认 agent） |
| `session show`（isDefault） | "Show local threadId → sessionId map (D2 prompt-isolation store)" | `--agent <name>` |

辅助文件：cli/context.ts（`getClient`）、cli/duration.ts（`parseDuration`，`/^(\d+)([smhd])$/`）。

---

## 6. MCP 工具清单（src/mcp/slock-mcp-server.ts，`new McpServer({ name: "slock", version: "0.1.0" })`，共 17 个）

| tool | description 原文 | inputSchema 字段 |
|---|---|---|
| send_message | 在指定频道/线程/私信里发一条消息 | target, content, threadId?, attachmentIds? |
| upload_attachment | 上传一个本地文件，返回 attachmentId（之后用 send_message 的 attachmentIds 随消息发出） | path |
| list_tasks | 列出指定频道的任务板 | channel, status? |
| create_tasks | 在指定频道创建一个或多个任务 | channel, titles |
| claim_tasks | 认领指定频道的一个或多个任务（按任务编号） | channel, taskNumbers |
| update_task_status | 更新指定任务的状态（todo/in_progress/in_review/done/closed） | channel, number, status |
| unclaim_task | 取消对指定任务的认领 | channel, taskNumber |
| dispatch_task | 把任务派给指定 worker agent（仅频道的指定经理可用） | channel, toAgent, text |
| list_dispatches | 列出指定频道里跟自己相关的派发任务（经理看自己派的，worker 看分给自己的） | channel, status? |
| report_task | 回报一个分给自己的派发任务的完成情况 | dispatchId, reportText, artifacts? |
| cancel_dispatch | 撤回自己派发的一个未完成任务（仅任务的经理可用） | dispatchId, reason? |
| read_history | 读取指定频道/私信的最近消息记录 | channel, limit?, threadId? |
| check_messages | 查收自上次查收以来发给你的新消息（含频道 @ 与私信；查收后游标前移，重复调用只拿增量） | （空 inputSchema） |
| search_messages | 在你有权限的频道里按关键词搜索消息 | query, channel?, limit? |
| schedule_reminder | 设置一个未来触发的提醒（到点会重新唤醒你处理） | title, delaySeconds?, fireAt?, channel?, timezone? |
| list_reminders | 列出你设置过的提醒（默认只看未到期的） | status? |
| cancel_reminder | 取消一个未到期的提醒 | reminderId |

---

## 7. WS 消息类型

协议 union 定义于 `packages/shared/src/index.ts`（L443-526）。daemon 侧路由在 `src/handlers/index.ts` `dispatchDaemonMessage()`（switch），入站归一化在 `src/handlers/inbound.ts` `parseWsToDaemonMessage()`。

### 入站（server → daemon，`WsToDaemonMessage`，shared/index.ts L445-457）

| type | 处理处 |
|---|---|
| connected | handlers/index.ts L48（无操作） |
| ping | handlers/index.ts L45 → handlers/ping.ts handlePing |
| agent:start | handlers/index.ts L15 → handlers/agent.ts handleAgentStart |
| agent:stop | L21 → handlers/agent.ts handleAgentStop |
| agent:duty | L24 → handlers/agent.ts handleAgentDuty |
| agent:deliver | L18 → handlers/deliver.ts handleAgentDeliver |
| reminder.fire | L27 → handlers/reminder.ts handleReminderFire |
| terminal:watch | L30 → handlers/terminal.ts handleTerminalWatch |
| terminal:unwatch | L36 → handlers/terminal.ts handleTerminalUnwatch |
| terminal:history | L33 → handlers/terminal.ts handleTerminalHistory |
| terminal:resize | L39 → handlers/terminal.ts handleTerminalResize |
| workspace:read | L42 → handlers/workspace.ts handleWorkspaceRead |

（inbound.ts 的 case 列表与上表一致，另含 `connected`/`ping` 归一化。）

### 出站（daemon → server，`WsFromDaemonMessage`，shared/index.ts L476-526）

| type | 载荷要点 |
|---|---|
| ready | capabilities, runtimes(RuntimeProbe[]\|string[]), hostname, daemonVersion, os?, arch?, machineUuid?, serverName? |
| agent:status | agentId, agentName, status, detail |
| agent:delivery-queued | agentName, channelName |
| agent:delivery-dead-letter | agentName, channelName, error |
| agent:tool-call | agentName, agentId, toolName, toolUseId, status(pending\|completed), text, time |
| terminal:frame | agentName, screen, status, time |
| terminal:obs-frame | agentName, frame(ObservationFrame) |
| terminal:obs-history | agentName, frames[] |
| terminal:history | agentName, text |
| agent:progress | agentName, channelName, headline, phase(start\|update\|end) |
| workspace:result | requestId, agentName, exists, files?/path?/content?/bytes?/error? |
| pong | — |

发送侧聚合：daemon-core.ts 持有 `WsFromDaemonMessage` 类型并统一 send；handlers/types.ts `HandlerContext` 亦引用该类型。

---

## 8. TODO/FIXME/HACK/XXX/❄️/冻结/deprecated 标记（src 下）

### 大小写敏感的 TODO/FIXME/HACK/XXX/deprecated

仅 1 条：

- `agent-runtime.ts:40` — `const PTY_COMMAND = "claude"; // TODO: read from command-resolver`

（大小写不敏感匹配额外命中的均为非标记文本，不计入：config.ts:23 的 `TodoWrite`（allowedTools 工具名）、system-prompt.ts:76 / cli/task.ts:76 / slock-mcp-server.ts 多处字符串里的 `todo`（任务状态枚举值）。）

### ❄️ / 冻结 标记（逐条）

- `agent-manager-support.ts:2` — `* ❄️ LEGACY / FROZEN（2026-08-20，演进 Step 3）`
- `agent-manager-support.ts:4` — `* 冻结纪律：不接受新功能与非缺陷改动；仅在 headless 出现不可修复问题时作回退启用。`
- `agent-manager.ts:2` — `* ❄️ LEGACY / FROZEN（2026-08-20，演进 Step 3）`
- `agent-manager.ts:4` — `* 冻结纪律：不接受新功能与非缺陷改动；仅在 headless 出现不可修复问题时作回退启用。`
- `agent-mcp-config.ts:4` — `* P0.7（2026-08-25）：从冻结的 agent-runtime-spawn.ts 迁出——headless 路径`
- `agent-mcp-config.ts:5` — `* （agent-runtime-dispatch.ts）也要用它，不该为一个非冻结函数 import 冻结文件。`
- `agent-mcp-config.ts:6` — `* 本文件不在 PTY 冻结范围，正常维护。`
- `agent-runtime-dispatch-pty.ts:2` — `* ❄️ LEGACY / FROZEN（2026-08-20 Step 3；P1.9 整块迁出，内部不改）`
- `agent-runtime-dispatch-pty.ts:4` — `* 支持的路径。冻结纪律：不接受新功能与非缺陷改动；仅在 headless 出现不可`
- `agent-runtime-dispatch.ts:322` — `// ❄️ LEGACY / FROZEN（2026-08-20 Step 3）：本分支整体冻结保留，仅`
- `agent-runtime-spawn.ts:2` — `* ❄️ LEGACY / FROZEN（2026-08-20，演进 Step 3 标注；2026-08-25 P0.7 纯化）`
- `agent-runtime-spawn.ts:4` — `* 支持的路径。冻结纪律：不接受新功能与非缺陷改动；仅在 headless 出现不可`
- `agent-runtime-spawn.ts:39` — `// 每次 spawn 动态求值（SLOCK_AGENT_ALLOWED_TOOLS 可覆盖），不用模块级冻结常量。`
- `agent-runtime-terms-dialog.ts:2` — `* ❄️ LEGACY / FROZEN（2026-08-20，演进 Step 3）`
- `agent-runtime-terms-dialog.ts:4` — `* 冻结纪律：不接受新功能与非缺陷改动；仅在 headless 出现不可修复问题时作回退启用。`
- `agent-runtime-turn-tracker.ts:2` — `* ❄️ LEGACY / FROZEN（2026-08-20，演进 Step 3）`
- `agent-runtime-turn-tracker.ts:4` — `* 冻结纪律：不接受新功能与非缺陷改动；仅在 headless 出现不可修复问题时作回退启用。`
- `agent-runtime.ts:241` — `// ❄️ LEGACY（2026-08-20 Step 3）：PTY 代码已冻结保留（headless 未过长期验证，`
- `agent-runtime.ts:244` — `"[Runtime] ⚠️ SLOCK_USE_PTY=1：PTY legacy fallback 已启用（冻结保留，仅调试/回退用）；" +`
- `agent-sessions.ts:30` — `* 冻结状态（2026-08-20 Step 3）：随 PTY fallback 一并 ❄️ 冻结保留（headless`
- `agent-sessions.ts:33` — `* 等与路径无关的工具函数不在冻结范围，正常维护。`
- `agent-stdin-dispatcher.ts:2` — `* ❄️ LEGACY / FROZEN（2026-08-20，演进 Step 3）`
- `agent-stdin-dispatcher.ts:4` — `* 但其唯一 writer（post-start-input-writer）是 PTY 专属，故整体随 PTY 冻结。`
- `agent-stdin-dispatcher.ts:5` — `* headless 是默认且受支持的路径。冻结纪律：不接受新功能与非缺陷改动。`
- `config.ts:53` — `/** \`SLOCK_USE_PTY=1\`：启用冻结的 PTY fallback（默认 headless） */`
- `errors.ts:14` — `*   冻结 PTY 路径等未迁移抛点的既有重试行为）。`
- `errors.ts:49` — `* 重试判定的唯一入口。未迁移的普通 Error / 冻结 PTY 路径抛点一律视为`
- `post-start-input-writer.ts:2` — `* ❄️ LEGACY / FROZEN（2026-08-20，演进 Step 3）`
- `post-start-input-writer.ts:4` — `* 冻结纪律：不接受新功能与非缺陷改动；仅在 headless 出现不可修复问题时作回退启用。`
- `post-start-input-writer.ts:107` — `* 永久停在那，output 长度冻结不再变化。这正是 Hive 的 \`post-start-input-writer.ts\``
- `pty-output-bus.ts:2` — `* ❄️ LEGACY / FROZEN（2026-08-20，演进 Step 3）`
- `pty-output-bus.ts:4` — `* 冻结纪律：不接受新功能与非缺陷改动；仅在 headless 出现不可修复问题时作回退启用。`
- `terminal-state.ts:2` — `* ❄️ LEGACY / FROZEN（2026-08-20，演进 Step 3）`
- `terminal-state.ts:4` — `* 冻结纪律：不接受新功能与非缺陷改动；仅在 headless 出现不可修复问题时作回退启用。`

带 ❄️ 文件头注释的文件共 10 个：agent-manager.ts, agent-manager-support.ts, agent-runtime-dispatch-pty.ts, agent-runtime-spawn.ts, agent-runtime-terms-dialog.ts, agent-runtime-turn-tracker.ts, agent-stdin-dispatcher.ts, post-start-input-writer.ts, pty-output-bus.ts, terminal-state.ts。

---

## 9. git 视角

`git rev-parse --is-shallow-repository` → false（非浅克隆）。

`git log -1 --format="%h %ad" --date=short -- packages/daemon`：

```
b6a8b0b 2026-09-19
```

`git log --since=2026-08-20 --format="%h %ad %s" --date=short -- packages/daemon`（23 条，subject 超 200 字已截断）：

```
b6a8b0b 2026-09-19 feat(server,web,daemon,shared): server 权限模型 + server-scoped computers 落地
b745f08 2026-09-17 feat(server,web,daemon): 跨用户 agent 可见性——频道成员口径 + 状态/终端同步 + 观看延迟修复
db9153f 2026-09-16 feat(server,web,daemon,shared): 文件能力批次一 F4~F8 落地 + MinIO 对接
30cd102 2026-09-03 fix(server): 评估报告 P1.24——daemon→server 成本上报闭环：①server 建表——022 迁移 agent_cost_daily（PK (agent_id, channel, day)、cost_usd NUMERIC(14,6)；channel 为 daemon 归一化账本名而非 channels FK——DM 归并 "dm" 无法可靠回链 channel id，存名不存 uuid）。②上报端点 POST /api/agent-costs/sync（machine token 走 authenticate，Bearer 无 CSRF 面；行级归属校验 fail-closed：agentId 优先/agentName 兜底，解析不到调用者名下 agent 即 skip 不 400 不泄露存在性；非法行逐条 skip；超 200 行 400）UPSERT ON CONFLICT DO UPDATE SET cost_usd = GREATEST(t.cost_usd, EXCLUDED.cost_usd) 单调收敛——…（截断）
afb1d5e 2026-09-03 fix(server): 评估报告 P1.23——提醒可靠性三件套（认领门控 + IANA 时区 + 消漂移）：①认领门控——scheduler 认领 SQL JOIN agents 带出 owner_user_id 并加「owner daemon 在线（daemonClients 命中）」过滤，daemon 离线的到期行不认领（status 保持 scheduled 等重连），一次性提醒不再被「标 fired + sendToDaemon 静默丢弃」；SQL 侧过滤不占 LIMIT 名额，多实例天然按本地连接分工（FOR UPDATE OF r SKIP LOCKED 只锁 reminders 行）。②IANA 时区——021 迁移 reminders.timezone（NULL=存量行回退 server 本地 tz）；nextFireFromRepeat 按 Intl.DateTimeFormat 换算（DST 双次逼近修正）…（截断）
944b624 2026-09-01 fix(server): 评估报告 P1.20——契约缺失端点补齐或砍掉（drift #2/3/4/5）：①forgot/reset-password 补齐——按 web ForgotPasswordPage.vue 既有契约（{message, devCode?}）实现 POST /api/auth/forgot-password + /api/auth/reset-password；仓库无邮件基建，完整验证码流仅在 SLOCK_DEV_RESET_CODE=1 显式开启（devCode 回传响应，同 P1.17 SLOCK_DEV_TOKEN 模式：collectInsecureConfig 标记、生产无 ALLOW_INSECURE 启动即拒）…（截断）
b19b269 2026-08-26 refactor(daemon): 评估报告 P1.16——移除 SLOCK_DISPATCH_QUEUE=0 回退路径与 dispatchPromises Map
3d92ddc 2026-08-26 feat(daemon): 评估报告 P1.15——token 脱敏 + .slock 目录 0700
0ec3991 2026-08-26 refactor(daemon): 评估报告 P1.14——统一错误模型 DispatchError 可重试分类
c3bbc12 2026-08-26 refactor(daemon): 评估报告 P1.13——收紧 stream-json / WS 线协议类型
20aaad4 2026-08-26 fix(daemon): 评估报告 P1.12——PersistentClaude 监听器清理 + headless 会话创建加锁
dc7a24d 2026-08-26 feat(daemon): 评估报告 P1.11——one-shot/PTY 成本记录 + slock cost show 查询维度
d8ed99f 2026-08-26 refactor(daemon): 评估报告 P1.10——统一配置层 src/config.ts
4549afb 2026-08-25 refactor(daemon): 评估报告 P0.8/P1.9——核心编排器单测 + 巨型函数拆分
4fcc925 2026-08-25 refactor(daemon): 评估报告 P0.7——headless 默认路径与 PTY 解耦
a7152e2 2026-08-25 fix(daemon): 评估报告 P0.5/P0.6——成本差值落库 + 成本门覆盖已入队/重试
c3715bc 2026-08-25 fix(daemon): 评估报告 P0.4——env 白名单默认翻正为 whitelist
48ef738 2026-08-25 fix(daemon): supervisor 用 mtime 基线过滤 Windows fs.watch 误报
b60da8c 2026-08-25 chore(deps): 升级生产依赖修复高危/严重安全漏洞
a809cd6 2026-08-25 fix(daemon): commandBaseName 跨平台解析 Windows 路径
ab24509 2026-08-25 feat(daemon,server,web,shared): Step 7-8 产品化收尾——成员档案、Computer 一等公民、Agent 值班与观察帧
becab1d 2026-08-25 fix(daemon): 评估报告 P0.1–P0.3——kill→exit 竞态、headless 空闲回收、统一 stop 状态机
ae29832 2026-08-21 feat(daemon,server,web): 演进 Step 4-6——D3 成本记账 + T8 经理分诊 + D1/D2 线程上下文
```

---

## 10. 依赖（packages/daemon/package.json）

```json
"scripts": {
  "dev": "tsx src/supervisor.ts",
  "dev:once": "tsx src/index.ts",
  "serve": "tsx src/supervisor.ts",
  "build": "tsc",
  "typecheck": "tsc --noEmit",
  "lint": "biome check .",
  "test": "vitest run"
},
"dependencies": {
  "@anthropic-ai/sdk": "^0.99.0",
  "@collabagent/shared": "workspace:*",
  "@modelcontextprotocol/sdk": "^1.30.0",
  "@xterm/headless": "^6.0.0",
  "commander": "^12.1.0",
  "node-pty": "^1.1.0",
  "undici": "^7.29.0",
  "ws": "^8.21.3",
  "zod": "^3.25.76"
},
"devDependencies": {
  "@types/ws": "^8.5.0",
  "esbuild": "^0.28.0",
  "tsx": "^4.19.0",
  "typescript": "^5.7.0",
  "vitest": "^4.1.7"
}
```

（另：`"bin": { "collabagent-daemon": "./dist/index.js" }`，`"type": "module"`，`"version": "0.1.0"`。）

---

## 11. docs 中 daemon 相关文档的勾选进度

### 11.0 `- [x]` / `- [ ]` 计数

| 文件 | `- [x]` | `- [ ]` |
|---|---|---|
| docs/2026-08-20/02-daemon-evolution-tracker.md | 38 | 0 |
| docs/2026-08-24/01-daemon-evaluation-report.md | 0 | 0 |
| docs/2026-08-19/01-buzz-borrowing-todo.md | 0 | 0 |
| docs/2026-08-23/05-agent-duty-design.md | 0 | 0 |

后三份文档不使用 `- [ ]` 复选框语法，进度用表格内 `✅`/`☐`/`⬜`/`🔶`/`🧊` 表达。以下为等价的「未完成」条目（原文行）。

### 11.1 tracker（2026-08-20/02）：`- [ ]` 为 0；唯一未勾选样式标记

- 小节标题 `## Step 7 · T4 观察帧产品化（D4 并入）☐`（L220，小节标题带 ☐，其下子项已勾选）

### 11.2 evaluation-report（2026-08-24/01）：⬜ 未完成项（小节「### P2 · 中期（评估时建议 1-2 个月内；均未启动）」）

- L300 `17. ⬜ **制定并执行 PTY 代码删除计划**（按 tracker 原定 2026-09 底评估）。`
- L301 `18. ⬜ **Context Builder 引入模型相关 token 预算**。~~按 thread 记录成本粒度~~ ✅ P1.11 账本已按 threadId 分行；预算门仍按 agent/日（本子项完成）。`
- L302 `19. ⬜ **状态机增加 \`onTransition\`/\`onInvalidTransition\` 钩子**；\`supervisor.killTree\` 等待进程退出确认。`
- L303 `20. ⬜ **固定 \`daemon-costs.json\` / \`daemon-thread-sessions.json\` 路径**到 workspace 根或 \`SLOCK_WORKSPACE\`。`
- L304 `21. ⬜ **引入结构化日志库**，审查敏感信息打印；CI 增加测试覆盖率报告与门槛。`
- L305 `22. ⬜ **对用户注入内容做 prompt 边界包装**，降低 prompt 注入面。`

（同文档 P0/P1 编号项 1-16 全部标 ✅ 已完成。）

### 11.3 buzz-borrowing-todo（2026-08-19/01）：小节「## 4. 待办汇总表（可勾选）」中非 ✅ 行

- `| T1 | YAML 工作流引擎 + 审批门 + Trace | 🔴 高 | 大 | O2 events ✅ | ☐ |`
- `| T3 | 任务活动馈送（动词+对象+结果卡） | 🟡 中 | 中 | O2 events ✅ | ☐ |`
- `| T4 | 观察帧升级为产品级活动面板 + 频道进度 | 🟡 中 | 中 | B1 ✅ | ☐ Step 7 |`
- `| T5 | Forge / 代码协作面（**待产品决策**） | 🟡 中 | 大 | — | 🔶 待定 |`
- `| T6 | URL 即社区 / 主权部署 | 🟡 中 | 中 | O3 ✅ | ☐ |`
- `| T7 | mesh 算力 / huddle | 🟢 低 | 大 | — | 🧊 冻结 |`
- `| L2 | Steer 语义 | 🟢 低 | 待验证 | claude 能力 | ☐ |`
- `| L3 | PTY 模式退役 | 🟢 低 | 中 | headless 稳定 | ☐ |`
- `| L4 | 网络命令 \`--max-time\` 引导加固 | 🟢 低 | 随手 | — | ☐ |`
- `| L5 | 已知边界调优 | 🟢 低 | 小 | — | ☐ |`

（表中已 ✅：T2 2026-08-19、T8 2026-08-21、L1 2026-08-25 P0.4。另 T4 小节标题 L68 亦带 `☐ Step 7 实施中 2026-08-21`。）

### 11.4 agent-duty-design（2026-08-23/05）

- 无任何复选框/☐/⬜ 标记。文首状态行：`> 状态：Step A+B 已落地（2026-08-23）。审查拍板默认 Q1-A / Q2-A / Q3-A。`
