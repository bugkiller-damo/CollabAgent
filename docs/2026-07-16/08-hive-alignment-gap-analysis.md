# Daemon 与 Hive Agent 子系统对照分析 + 后续优化路线

**日期**: 2026-07-16
**范围**: `packages/daemon/src/`（当前分支 `feature/daemon-full-refactor`）对照 `D:\code\hive-main\src\server\` 的 agent 调用链
**前置文档**: `docs/2026-07-15/01~07`（架构决策/状态机/模块拆分/安全模型/路线图/PTY 升级计划）、`docs/2026-07-15/daemon-completion-analysis.md`（重构前完成度分析）

---

## 0. 结论先行

Hive 的 agent 子系统和 slock daemon 走的是**同一条技术路线**（node-pty + 分层拆分 + token/registry 生命周期管理），这印证了 `04-module-decomposition.md` 的拆分方向是对的。但代码级核对发现：

- **Phase 2 的地基层（types / PTY manager / runtime 状态机）是真实、可用、且已接入的。**
- **Phase 3-5 声称"已完成"的 7 个模块（`agent-stdin-writer.ts`、`command-presets.ts`、`agent-run-store.ts`、`agent-sessions.ts`、`restart-summary.ts`、`idle-reclaimer.ts`、`exit-coordinator.ts`/`exit-handler.ts`）实际上是"孤岛代码"——文件存在、类型正确、部分有单测，但没有被 `agent-runtime.ts` 或 `daemon-core.ts` 引用，在真实调用链中完全不生效。**
- 这意味着 `.claude/goal-progress.json` 记录的"28 项任务完成"高估了系统的真实能力。当前daemon **没有**：崩溃自动清理、idle 回收、重启摘要注入、会话 resume、token 撤销。这些正是 Hive 用来保证可靠性的核心机制。

本文档的目标：把 Hive 对应设计逐一映射到 slock 的现状，标出"地基已对齐"与"孤岛未接线"两类差距，并给出接线优先级和具体任务清单，供下一阶段 Goal Mode 执行。

---

## 1. Hive Agent 子系统架构速览

### 1.1 分层结构（自底向上）

```
L1  agent-command-resolver.ts        跨平台可执行文件解析（不用 shell:true，手动走 PATH/PATHEXT，
                                       .bat/.cmd 用 cmd.exe /d /s /c 重新包装参数）
L2  agent-manager.ts + -support.ts   纯 runId 键控的 PTY 进程生命周期（spawn/输出缓冲/
                                       进程组 SIGTERM→750ms→SIGKILL 逐级终止）
L3  agent-tokens.ts                  per-agentId token（issue 覆盖式签发；
    live-run-registry.ts              revokeIfMatches 仅在 token 仍匹配时撤销 —— 防止
    pty-output-bus.ts                 旧 run 的延迟退出回调清掉新 run 的 token）
                                      live-run-registry 按 runId 索引，独立维护 pendingExitCode
                                       与 exitPromise，供 close() 等待所有进程真正退出
L4  agent-run-bootstrap.ts           "这个 agent 该用什么命令/参数/env" 的解析
    preset-launch-support.ts          （command preset、--resume 参数、session 发现、yolo 参数）
    agent-launch-cache.ts
    command-preset-defaults.ts
L5  agent-run-starter.ts             真正的启动编排：解析配置 → 签发 token → spawn →
    agent-run-exit-handler.ts         持久化 → 注册 registry → 注入 restart-summary 或
    restart-policy.ts                 startup 指令（二选一，用 queueMicrotask 时序保护）
L6  agent-runtime.ts                 对外门面：startPromises Map 去重并发启动请求
    (+ agent-runtime-*.ts 分片)        （唯一的重复启动防护机制），close() 时等待所有
                                       in-flight start 结束再停止 PTY
L7  runtime-store-helpers.ts         应用组合根：markUnfinishedRunsStale()（崩溃恢复）+
                                       autostartConfiguredAgents()（daemon 重启后自动拉起）
L8  team-operations.ts               dispatch/report/status/cancel 域操作
    orchestrator-autostart.ts
L9  terminal-ws-server.ts            对外 WS/HTTP 接口
```

### 1.2 关键不变量（这是 Hive 可靠性的核心，也是 slock 当前最大的缺口来源）

| # | 不变量 | 实现位置 | 目的 |
|---|--------|----------|------|
| I1 | 并发启动去重 | `agent-runtime.ts` 的 `startPromises: Map<workspaceId:agentId, Promise>` | 避免同一 agent 被并发启动两次 |
| I2 | Token 撤销仅在仍匹配时生效 | `agent-tokens.ts` `revokeIfMatches` | 防止旧 run 的延迟退出回调清掉新 run 的 token（重启竞态） |
| I3 | 退出处理幂等 | `agent-run-exit-handler.ts` 的 `handledRunExits: Set<runId>` | 防止 onExit 被调用两次（一次来自 pending code，一次来自真实 onExit） |
| I4 | 进程尚未注册就退出的竞态保护 | `live-run-registry.ts` 的 `pendingExitCodes` | node-pty 对不存在的二进制不会同步抛错，可能在 register 完成前就已退出 |
| I5 | 崩溃恢复：daemon 重启时清理僵尸状态 | `agent-run-store.ts` 的 `markUnfinishedRunsStale()`（daemon 启动时调用一次） | 硬崩溃后遗留的 `starting`/`running` 状态不会永久卡住 |
| I6 | 进程组级别终止 | `agent-manager-support.ts` 的 `ps -o pgid=` + SIGTERM→750ms→SIGKILL（`.unref()`） | 杀掉 agent CLI 自己派生的子进程，且不阻塞 daemon 退出 |
| I7 | 重启后注入恢复上下文 | `restart-policy.ts` 的 `injectPostStartMessage()` | 非首次启动且未恢复 CLI session 时，注入"最近消息+任务文件+worker 列表"摘要，而不是让 agent 对着空白终端重新开始 |
| I8 | 命令解析不用 shell:true | `agent-command-resolver.ts` | 避免参数注入面；`.bat`/`.cmd` 手动用 `cmd.exe /d /s /c` 重新包装 |

---

## 2. Slock Daemon 现状核对（代码级验证，非 goal-progress.json 的自述）

### 2.1 已对齐（地基层，真实可用）

| Hive 对应 | Slock 现状 | 备注 |
|---|---|---|
| `agent-manager.ts`（node-pty） | `agent-manager.ts` + `agent-manager-support.ts` | 已从 `child_process` 切到 `node-pty`，`07-pty-upgrade-plan.md` 的 9 个步骤已全部落地 |
| `pty-output-bus.ts` | `pty-output-bus.ts` | 结构一致，slock 版本用完整 `PtyOutputEvent` 对象，比计划文档的草案更完善 |
| `post-start-input-writer.ts`（ready 检测 + bracketed paste） | `post-start-input-writer.ts` | 逻辑对应，超时参数更保守（8s/100次 vs Hive 3s） |
| 四态状态机（uninit/idle/starting/working/stopped） | `agent-runtime.ts` 的 `AgentState`/`VALID_TRANSITIONS` | 完整实现，含 stuck-detector（30s 无响应告警） |
| `agent-tokens.ts` 模块本身 | `agent-tokens.ts` | 逻辑正确（`revokeIfMatches` 实现与 Hive 一致），但**未接入**（见 2.2） |
| `live-run-registry.ts` 模块本身 | `live-run-registry.ts` | 同上，模块正确但**未接入**（见 2.2） |

### 2.2 未接线的孤岛模块（存在但不在真实调用链中）

以下文件被 grep 确认**没有任何其他 `.ts` 文件导入**，或只被单元测试导入：

| 文件 | 行数 | 对应 Hive 能力 | 缺失后果 |
|---|---|---|---|
| `exit-coordinator.ts` / `exit-handler.ts` | 52+71 | `agent-run-exit-handler.ts`（不变量 I2/I3） | PTY 自然退出（崩溃/正常退出）时，`runIdByAgent`/`unsubByRunId`/`liveRunRegistry` 都不会被清理；agent 永久卡死，无任何错误提示 |
| `idle-reclaimer.ts` | 70 | Hive 无直接对应，但对应 slock 自己 ADR-005 的"混合模型" | 60s idle 回收完全没有运行，PTY 会话无限期常驻 |
| `restart-summary.ts` | 72 | `restart-policy.ts`（不变量 I7） | 新 PTY 启动时不会注入"最近消息/任务/worker 列表"摘要 |
| `agent-sessions.ts` | 79 | `agent-session-store.ts` + `claude-session-coordinator.ts` | 无 session 发现/resume，PTY 路径每次都是全新会话 |
| `agent-run-store.ts` | 105 | `agent-run-store.ts`（不变量 I5，JSON 而非 SQLite） | daemon 重启后丢失全部运行历史，`markUnfinishedRunsStale()` 等价能力不存在 |
| `command-presets.ts` | 53 | `command-preset-defaults.ts` | 多 CLI 支持（codex/gemini/opencode）表面存在但不可达，`agent-runtime.ts` 硬编码 `CLAUDE_YOLO_ARGS` |
| `agent-stdin-writer.ts` | 56 | 无直接对应（多策略写入抽象） | 未使用，`agent-stdin-dispatcher.ts` 直接调用 `post-start-input-writer` |

同时，`agent-runtime.ts` 内部也有两处"半接线"：
- `tokenRegistry.issue()` 每次 dispatch 都调用（有效），但 `revokeIfMatches`/`validate` 从未被调用 —— token 只增不撤销（不算严重泄漏，但安全模型文档描述的撤销竞态保护实际不生效）。
- `liveRunRegistry.add()`/`createExitEntry()` 在 spawn 时调用，但 `.resolveExit()`/`.remove()` 从未调用 —— registry 条目永不清理。

### 2.3 Roadmap 任务状态修正（对照实际代码，而非 goal-progress.json）

| 任务 | goal-progress.json | 代码验证结论 |
|---|---|---|
| 1.1 turn timeout 180s→60s | 标记完成 | **未生效** — `persistent-claude.ts` 默认值仍是 180000，且已改为 fallback-only 路径（PTY 是默认路径），没有调用点覆盖该参数 |
| 2.2/2.3（token/registry 模块） | 标记完成 | 模块正确，**集成不完整**（见 2.2 表） |
| 2.4 agent-startup.ts | 标记完成 | 部分接入 —— `writeSystemPromptFile`/`createWorkspaceDir` 用了，`buildStartupInstructions` 等 4 个函数未使用 |
| 3.x/4.x/5.x（全部标记完成） | 标记完成 | **7 个模块孤岛未接线**，功能层面：无崩溃清理、无 idle 回收、无重启摘要、无 session resume、无 token 撤销 |

---

## 3. 差距优先级与后续任务清单

### P0 —— 可靠性缺口（影响正常运行，非新功能）

1. **接线 exit-coordinator/exit-handler 到 `agent-runtime.ts` 的 PTY onExit 回调**
   - 目标：PTY 自然退出时清理 `runIdByAgent`/`unsubByRunId`/`liveRunRegistry`，并把 agent 状态转回可重启的状态，而不是让下一次 dispatch 静默丢消息。
   - 对应 Hive 不变量 I3/I4，参考 `agent-run-exit-handler.ts` 的 6 步序列（持久化状态 → 清 resumed-session-id → 标记 handled → 撤销 token → 触发 onAgentExit 回调 → resolve exit promise）。
   - 验收：kill 掉一个 Claude PTY 子进程后，daemon 应能在下一条消息时重新拉起该 agent，而不是永久静默。

2. **接线 token 撤销**：在 exit-handler 内调用 `tokenRegistry.revokeIfMatches(agentId, token)`，落实 I2 不变量。

3. **接线 live-run-registry 的 `resolveExit`/`remove`**：退出时清理条目，避免 Map 无限增长。

### P1 —— 一致性与可观测性

4. **`agent-manager.ts` 的 `removeAgentRun()`** 已定义但从未调用 —— 应作为 P0-1 清理链的一部分被调用，否则 `processes` Map 同样无限增长。

5. **移除或激活孤岛模块**：`agent-stdin-writer.ts`、`command-presets.ts`（多 CLI 支持）当前是死代码。若近期不打算支持 codex/gemini/opencode，建议在 `agent-runtime.ts` 中明确注释"暂缓，见 CLAUDE.md"，而不是让两套逻辑（硬编码 `CLAUDE_YOLO_ARGS` vs `command-presets.ts` 表）同时存在造成混淆。

6. **`persistent-claude.ts` 的 180s 超时**：确认 PTY 是默认路径后，是否还需要给 fallback 路径传 60s 参数？如果 fallback 路径保留只是应急开关（`SLOCK_PERSISTENT_CLAUDE=1`），应至少把默认值改为 60s，避免"配置项存在但默认值仍是旧值"的陷阱。

### P2 —— 对齐 Hive 的可靠性增强（新能力，非当前 bug）

7. **重启摘要注入**（对应 I7）：接线 `restart-summary.ts` 到 `agent-runtime.ts` 的 spawn 后置逻辑，参考 Hive 的"有上次 run 记录且未 resume session → 注入摘要；否则走普通 startup 指令"二选一模式（`restart-policy.ts`）。

8. **崩溃恢复标记**：daemon 启动时对 `agent-run-store.ts` 做一次类似 `markUnfinishedRunsStale()` 的清理（前提是先接线 P0 的 run-store 持久化）。

9. **idle 回收**：`idle-reclaimer.ts` 已实现但从未 `.start()`，需要在 `daemon-core.ts` 启动时挂载，并明确与 ADR-005 的关系。

10. **Session 发现/resume**：`agent-sessions.ts` 接线到 PTY 路径，让 agent 重启后能 `--resume` 到上次会话，而非每次全新开始。

### P3 —— 待确认（非本次重构范围，需要用户决策）

- 服务端状态上报（`03-state-machine.md §9` 要求 daemon 把状态转换上报服务端，当前完全没有实现）—— 是否属于本轮重构范围？
- WS 连接超时 + zod 消息校验（`05-security-model.md §8`）—— 已声明依赖 zod 但从未使用。
- `daemon-core.ts` 硬编码 `agentId`（S-04）—— 阻塞多 daemon 实例支持，之前文档已标记为已知问题，是否本轮解决？

---

## 4. 建议的执行顺序

鉴于 P0 三项都指向同一个函数（PTY onExit 回调链），建议合并为**一个** Goal Mode 任务来做，而不是拆三个 PR：

> **Task 2.9（新增）**: 在 `agent-runtime.ts` 中为每个 spawn 出的 PTY 注册统一的 onExit 处理器，串联 `exit-coordinator.ts`/`exit-handler.ts`（清理 registry/runIdByAgent）→ `agent-tokens.ts revokeIfMatches`（撤销 token）→ `agent-manager.ts removeAgentRun`（清理 processes Map）。参考 Hive `agent-run-exit-handler.ts` 的幂等设计（`handledRunExits` Set）与 `pendingExitCode` 竞态保护。

完成 Task 2.9 后，daemon 才具备"崩溃后可自愈"的基本可靠性，再考虑 P2 的增强项（重启摘要/idle 回收/session resume）。

---

## 附录：文件对照速查表

| 职责 | Hive 文件 | Slock 文件 | 状态 |
|------|-----------|-----------|------|
| Token 生命周期 | `agent-tokens.ts` | `agent-tokens.ts` | 模块对齐，集成缺失 |
| 活跃 run 注册表 | `live-run-registry.ts` | `live-run-registry.ts` | 模块对齐，集成缺失 |
| PTY 进程管理 | `agent-manager.ts` + `-support.ts` | `agent-manager.ts` + `-support.ts` | 已对齐并接入 |
| 输出总线 | `pty-output-bus.ts` | `pty-output-bus.ts` | 已对齐并接入 |
| 启动后写入 | `post-start-input-writer.ts` | `post-start-input-writer.ts` | 已对齐并接入 |
| stdin 派发 | `agent-stdin-dispatcher.ts` | `agent-stdin-dispatcher.ts` | 已对齐并接入 |
| 退出处理 | `agent-run-exit-handler.ts` | `exit-handler.ts` / `exit-coordinator.ts` | **孤岛，未接入** |
| 重启策略 | `restart-policy.ts` + `-support.ts` | `restart-summary.ts` | **孤岛，未接入** |
| Session 发现/resume | `agent-session-store.ts` + `claude-session-coordinator.ts` | `agent-sessions.ts` | **孤岛，未接入** |
| Run 持久化 | `agent-run-store.ts`（SQLite） | `agent-run-store.ts`（JSON） | **孤岛，未接入** |
| Command preset | `command-preset-defaults.ts` | `command-presets.ts` | **孤岛，未接入** |
| 命令解析 | `agent-command-resolver.ts` | `command-resolver.ts` | 已对齐并接入 |
| 核心编排 | `agent-runtime.ts` + 分片 | `agent-runtime.ts`（785 行，单文件） | 功能对齐，未按 Hive 风格拆分为多个 20-150 行小文件 |
| 组合根 | `runtime-store-helpers.ts` | `daemon-core.ts` | 已对齐（243 行 vs 目标 ~150 行，可接受） |

---

## 5. 执行记录（2026-07-16 当天完成）

### Task 2.9 — PTY 退出清理链（P0）

`agent-runtime.ts` 现在把 `onExit(runId, exitCode)` 传入 `agentManager.startAgent()`（`agent-manager.ts`/`types/index.ts` 相应加了 `onExit` 字段 + `removeRun()` 方法），串联 `exit-coordinator.ts` + `exit-handler.ts`：退出时依次撤销 token（仅匹配时）→ 取消输出订阅 → 清理 `runIdByAgent`（带竞态守卫）→ 状态转回 `idle`（而非 `stopped`，避免被 `doDispatch` 的 stopped 检查拦截）→ 清理 `agent-manager` 内部 processes Map。**效果**：Claude PTY 崩溃后 daemon 现在能在下一次 dispatch 时自动重新拉起，而不是永久静默卡死。

### Task 2.10 — Run 持久化 + 重启摘要 + 崩溃恢复标记（P2 #7/#8）

- `daemon-core.ts` 构造时创建 `createJsonRunStore(defaultStorePath())` 并传入 `createAgentRuntime`；构造时调用一次 `runStore.markUnfinishedRunsStale()`（新增到 `agent-run-store.ts`/`IAgentRunStore`），对应 Hive `markUnfinishedRunsStale()` 的崩溃恢复语义。
- `spawnPtyForAgent` 在 spawn 时 `runStore.insertAgentRun(...)`；退出链改用完整版 `createExitHandler({tokenRegistry, runStore})`（新增 `messagesProcessedByRun` 计数，随 user message 写入递增，退出时随 `ExitContext` 一并落盘）。
- PTY 启动时若 `runStore.listAgentRuns(agentId)` 有历史记录，把 `restart-summary.ts` 的 `formatRestartSummary()` 输出注入到 bootstrap 消息里（对应 Hive `restart-policy.ts` 的恢复摘要，但简化为"总是追加"而非"二选一"，因为 slock 目前没有 session-resume，所以恢复摘要和系统提示不互斥）。

### Task 2.11 — Idle 回收（P2 #9）

`idle-reclaimer.ts` 接入 `agent-runtime.ts`：在回合结束（working→idle）时 `touch()`，开始新一轮 working 或显式停止/注销/重新注册时 `untrack()`，`stopAll()` 时 `stop()`。空闲超时（默认 60s）触发时调用 `agentManager.stopRun()`，实际清理交给已经接好的 exit-coordinator 链条完成，不需要重复实现清理逻辑。

### 顺带修复

`persistent-claude.ts` 的 `turnTimeoutMs` 默认值从 180000 改为 60000 —— 此前 roadmap 1.1 标记"已完成"但从未真正生效（无调用点覆盖默认值）。

### 仍未接线（按之前优先级仍然有效）

- **`agent-sessions.ts`**（session 发现/resume）：需要 per-CLI 文件监听/glob 匹配，属于新能力而非可靠性修复，暂缓。
- **`command-presets.ts` / `agent-stdin-writer.ts`**（多 CLI 支持）：`agent-runtime.ts` 仍硬编码 Claude-only 参数；是否支持 codex/gemini/opencode 需要产品侧决策，非本轮范围。
- **daemon-core.ts 硬编码 agentId（S-04）**、**服务端状态上报**（`03-state-machine.md §9`）、**WS 连接超时 + zod 消息校验**（`05-security-model.md §8`）：均为安全模型文档中标注的待办项，本轮未涉及。

---

## 6. 实机联调发现的 10 个真实 bug（同一天，2026-07-16）

Task 2.9-2.11 全部通过 `tsc`/单测验证后，用户用真实 Claude CLI + daemon 实测，连续多轮才真正跑通：前 6 轮是 TUI 文本解析的时序竞态，第 7 轮是完全不同类别的认证/配置问题，第 8-9 轮是并发消息暴露的两个相关但独立的状态清理 bug，第 10 轮是 P1（scoped runtime token）上线后联调时又暴露的一个新的 TUI 渲染变体。前 6 个 bug 记录下来是因为它们暴露了"回合结束检测"这条路线本身的脆弱性：

1. **对话框竞态**：`post-start-input-writer.ts` 判断"输入框就绪"用的 `❯`/`›`，和 Claude 首次启动的 Accept-Permissions 信任对话框的选项光标是同一个字符。bootstrap 消息在对话框还开着时就被写入、被对话框吃掉丢失。**修复**：`installTermsAcceptHandler` 改为返回 Promise，bootstrap 写入必须等它 resolve。
2. **消息顺序竞态**：bootstrap 系统提示和触发首次启动的用户消息是两次独立的 `postStartWriter` 调用，各自轮询"就绪"，谁先探测到就先写，顺序随机。**修复**：`spawnPtyForAgent` 新增 `initialUserMsg` 参数，两者拼成一次写入。
3. **回合结束误判（陈年 ❯）**：`run.output` 从进程启动起从不清空，检测在全量历史里找 `❯`，刚启动的空闲欢迎屏本身带的 `❯` 永久满足条件，导致状态几乎立刻被误判成"空闲"——叠加 Task 2.11 刚接上的 idle-reclaimer，60s 后真的把还在工作的 PTY 杀掉了（`exit=129`）。**修复**：`roundStartOffsetByRun` 记录每次写入前的 `output.length`，检测只扫描这之后新增的内容。
4. **粘贴未确认就提交**：`post-start-input-writer.ts` 把 bracketed-paste 内容和回车合并成一次 `pty.write()`；几千字符的大段粘贴，Claude 的 Ink 输入框来不及消化就先处理了回车，提交静默失败（`outputLen` 冻结不再变化）。这正是 Hive 版本里"等 `[Pasted text #N` 确认标记"的逻辑，slock port 时被简化掉了。**修复**：新增 `submitPastedInteractiveInput()`，先写内容、等确认标记（或按长度缩放的超时）、再等 100ms、最后发回车。
5. **忙碌帧误判（输入框常驻渲染）**：Claude 的输入框边框（带 `❯`）处理中也不会消失，只是底部提示从 `ctrl+g to edit...` 换成 `esc to interrupt`。第 3 项的修复只排除了"写入前"的陈年 `❯`，没排除"写入后、仍在处理时新画出的这一帧"同样带 `❯`——`✻ Skedaddling…` 思考中那一帧又触发了一次误判+误杀。**修复**：要求"最近一屏"内不能出现 `esc to interrupt`。
6. **固定窗口仍然"陈旧"**：第 5 项用固定 8000 字符的"最近窗口"判断忙碌标记，但如果这一轮总输出没超过窗口大小，处理阶段出现过的 `esc to interrupt` 永远留在窗口里，导致真正空闲后检测也再触发不了。**修复**：改成比较"❯"和"esc to interrupt"各自**最后一次出现的位置**，与窗口大小无关——`❯` 最后一次出现在 `esc to interrupt` 最后一次出现之后（或者后者根本没出现过），才判定为真正的空闲帧。

**关于这条路线本身**：Hive 并不需要这套"扫描终端文本判断回合是否结束"的机制——它的 agent 通过工具调用（`team send`）主动上报，daemon 侧不需要用文本解析猜测 UI 状态；真正的终端可视化用的是完整的 VT100 模拟器（`TerminalStateMirror`），而不是正则扫描全量历史。slock 目前这套是纯文本启发式，每次 bug 都是缩小一个特例，不是结构性解决。如果后续还有类似的误判/漏判，应该考虑投入实现一个轻量终端状态跟踪器（记录光标位置 + 提取"最新一帧"），而不是继续叠加正则规则。

### 第 7 个 bug：认证——完全是另一类问题

第 6 项修复后，第 7 轮实测里回合结束检测终于完全正确（Claude 思考了 4 分 2 秒，`round-end` 在真正说完后才触发，没有被误杀）。但 Claude 的回复内容自己指出了一个新问题："the process env vars for SLOCK_SERVER_URL/SLOCK_AGENT_TOKEN are still stale ... I had to override them inline to authenticate"。

排查后确认：`agent-runtime.ts` 每次 dispatch 都用 `tokenRegistry.issue(agentId)` 生成一个本地 `randomUUID()`，注入子进程的 `SLOCK_AGENT_TOKEN`。但 `packages/server` 的鉴权中间件（`src/index.ts` ~98-124）只认 `sk_machine_...` 开头、能在 `machine_tokens` 表里 bcrypt 匹配上的 token（即启动 daemon 时传的 `--api-key`）——服务端**完全没有**注册/校验"每次运行的 scoped runtime token"这个概念，没有对应端点。这意味着 agent 子进程里所有 `slock` CLI 调用（`slock message send` 等）在这次修复之前必然 401；这一轮能成功，是 Claude 自己发现问题、手动 override 成真实 apiKey 才发出去的，不是可靠复现的行为。

这与前 6 个"UI 文本解析"类的 bug 性质完全不同——是 `05-security-model.md` 描述的 "Phase 2 目标"（scoped runtime token 替代直接暴露 apiKey）从未在服务端落地。daemon 单侧无法完整实现这个安全模型；征求用户意见后，选择了立刻可用的方案：**把真实 apiKey 注入 `SLOCK_AGENT_TOKEN`**（`agent-runtime.ts` 两处 `doDispatch` 调用点），接受"每个 agent 子进程都能拿到完整权限的机器级 token"这个安全权衡（正是安全文档 S-01/T3 想避免的），因为没有回复能力才是当下更紧迫的问题。`tokenRegistry`/`agent-tokens.ts` 本身未改动，仍接在 exit-chain 里，只是不再有任何 `.issue()` 调用喂给它——`revokeIfMatches` 因此永远是无害的空操作，如实反映"当前没有真正的 per-run 凭证可撤销"这个事实。

**后续待办**（需要动 `packages/server`，本轮明确搁置）：如果之后要真正落地 Phase 2 的安全模型，需要在服务端新增一种 token 类型 + 一个供 daemon 注册/宣告 per-agent-run token 的端点，daemon 侧才能停止把完整权限的机器 token 暴露给每个 agent 子进程。

（第 7 轮实测另外还发现 `--server-url` 传成了 Vite 前端 dev server 的 5173 端口，而 `slock` CLI 需要的 `/internal/agent/*` 只在真正后端的 3001 端口上——5173 只代理了 `/api`、`/files`、`/ws`、`/ws/chat` 这几条路径。这是本机开发环境配置问题，不是代码 bug，改用 `--server-url http://localhost:3001` 即可。）

### 第 8 个 bug：并发 dispatch 把回合基线重置错了

port 改成 3001 后第一条消息顺利跑通。但第二条消息在第一条还"工作中"时到达（复用同一个已运行的 PTY），暴露了第 8 个问题：`doDispatch` 复用分支无条件把 `roundStartOffsetByRun` 重置成"现在"的 output 长度再写入第二条消息——这会把第一条消息尚未产出的忙碌标记直接排除出搜索窗口。下一个输出事件（Claude 刚回显第二条消息的粘贴内容，还没开始真正处理）里没有忙碌标记，round-end 立刻误判"完成"，71 秒后 idle-reclaimer 又把 PTY 杀了，Claude 很可能根本没来得及处理第二条消息。

**修复两处**：
1. `pendingMsgCount` 从"计数"改成"布尔"语义（`Map<string, true>` + `hasPending()`）——两条消息重叠时不需要两次 round-end 才能清零，因为 Claude 很可能在同一次"思考"里把两条一起答完，只会有一次真正的回合结束信号；用计数的话一次 `decPending` 只减到 1，永远清不干净。
2. `doDispatch` 复用分支现在只有 `!hasPending(agentName)`（当前没有"还在等回复"的消息，即这是真正全新的一轮）时才重置基线；如果是重叠写入，保留原基线，让搜索窗口继续覆盖回第一条消息的忙碌期，直到 Claude 真正说完（不管是分开回复还是一起回复）才触发。

### 第 9 个 bug：pending 标记按 agentName 存，PTY 被杀后从没清理过

第 8 项修复本身生效了——round-end 这次确实等到第一条消息真正说完（`✻ Crunched for 20s`）才触发，没有在第二条刚到达时就误判。但 idle-reclaimer 在这之后 71 秒还是把 PTY 杀了，第二条消息大概率没等到真正的回复。被杀之后，服务端/用户重发了同一条消息，daemon 全新 spawn 了一个 PTY——结果 round-end 在 `outputLen=801`（就是最原始的启动欢迎屏，第 3 个 bug 里见过的那个）时立刻又触发了一次，跟 bug 3 修复前一模一样的症状重新出现。

排查发现：`pendingMsgCount` 是按 **agentName**（不是 runId）存的，而退出清理链从来没有清理它。上一个 run 被 idle-reclaimer 杀掉时，它的"还在等第二条消息回复"这个 `pending=true` 从未被消费/清零，就一直留在 Map 里。等到同一个 agent 全新 spawn 一个 PTY 时，回合结束检测的" `hasPending()` 才继续检查"这道门槛形同虚设——从第一个输出事件（刚渲染出来的启动欢迎屏）开始就直接放行，完全绕过了本该阻止它的守卫。

**修复**：退出清理链的回调里，在 `idleReclaimer.untrack(ctx.agentName)` 旁边加一行 `decPending(ctx.agentName)`——run 已经死了，任何"还在等回复"的期待都该清零，不管这个 run 是正常退出还是被杀的。

### 第 10 个 bug：`❯` 要求行首锚点，收尾"紧凑状态栏"样式匹配不上（P1 联调时发现）

P1（scoped runtime token）上线后第一次实测：token 部分完全正确——能看到 `●Message sent to #general.`，说明 Claude 直接用换来的 `sk_agent_...` 成功调了 `slock message send`，不用再手动 override。但 round-end 这次从头到尾没有触发过一次：Claude 处理完（`✻Cooked for 2m 42s❯ ← for agents`）之后一直停在 working，第二条消息到达时状态还是 working，之后持续 STUCK。

对比之前所有成功案例的收尾文本，都是 `──────────── ❯ ────────────`（一个完整的空输入框边框，`❯` 前面能确定紧跟着换行）；这次的收尾是 `❯ ← for agents`，明显是另一种"紧凑状态栏"渲染——Claude 用完工具/涉及多 agent 场景之后，收尾提示栏可能不走标准的多行输入框边框，`❯` 前面不一定有 `\r`/`\n`（很可能是光标定位直接画上去的字符，不是新起一行）。`PROMPT_LINE_RE` 之前要求 `❯` 必须出现在行首（`(?:^|[\r\n])\s*[❯›]`），这种渲染样式下永远匹配不上，回合结束永远不触发。

**修复**：去掉行首锚点要求，`PROMPT_LINE_RE` 改成裸字符匹配 `/[❯›]/gu`——`❯` 是个很少在正常回复文本里出现的生僻字符，放宽匹配范围的误判风险，远低于"真正说完了但检测不到，agent 卡在 working 直到被 idle-reclaimer 杀掉"这个后果的严重程度。

**这条路线目前的状态**：第 3/5/6/10 个 bug 全部是"用正则扫描 PTY 文本判断回合是否结束"这条路线的不同侧面暴露出的问题——每次都是遇到一种新的终端渲染变体就要打一次补丁。到目前为止都是收敛的（每次都是让判定"更容易触发"而不是"更容易误判"，方向上是安全的），但如果之后还继续出现新的渲染变体导致漏判，应该认真考虑投入实现一个真正的轻量终端状态跟踪器，而不是无限期地在正则规则上打补丁。

---

## 7. 轻量终端状态跟踪器（第 10 个 bug 修复后，用户要求投入的结构性方案）

第 10 个 bug 修复后又实测了一轮：`round-end` 这次正确触发了（`✻ Baked for 24s ──── ❯ ────`，标准边框样式），但第二条消息到达时打了一行 `Invalid state transition: idle → working (ignored)`——说明状态机确实正确回到了 idle（这次没有卡住），只是 `VALID_TRANSITIONS` 里 `idle` 只允许迁移到 `starting`/`stopped`，不允许直接到 `working`，是个无害的日志噪音（不影响功能，`transitionState` 内部吞掉异常后调用方还是会继续走），本身不是本节要解决的问题。

用户在这个时间点提出：与其继续在"对全量/局部字节做正则扫描"这条路子上打补丁，不如真正做一个轻量终端状态跟踪器。

### 方案

用 `@xterm/headless`（xterm.js 的 headless 引擎，Node 环境专用，无 DOM 依赖）替换手写的正则扫描。新增 `src/terminal-state.ts`：

```ts
export interface ITerminalState {
  write(data: string, onFlushed?: () => void): void;
  resize(cols: number, rows: number): void;
  getScreenText(): string;   // 当前渲染出来的整屏文本，按行拼接
  dispose(): void;
}
```

`createTerminalState(cols, rows)` 内部是 `new Terminal({cols, rows, allowProposedApi: true, scrollback: 0})`。`scrollback: 0` 是关键——滚出可视区域的内容直接丢弃，不需要历史，因为"现在是不是空闲/忙碌"只需要看当前这一帧。

**接入点**：`agent-manager.ts`（spawn 时创建）→ `agent-manager-support.ts`（`attachAgentPty` 的 `pty.onData` 里喂给它，`resize` 时同步调整尺寸；`removeAgentRun` 时 dispose）→ `AgentRunSnapshot` 新增 `screenText` 字段（`toAgentRunSnapshot` 里读 `run.terminal.getScreenText()`）。

**write 的时序坑**：xterm 的 `write()` 对大段输入是异步分块处理的，不能假设调用后立刻生效。`pty.onData` 里改成 `run.terminal.write(data, () => outputBus.publish(...))`——把 publish 移到 write 的回调里，保证任何订阅者（回合结束检测等）读到 `screenText` 时，这次数据已经真正应用到屏幕缓冲区。

**用 screenText 重写的三处**：
1. `agent-runtime.ts` 的回合结束检测——不再需要 `roundStartOffsetByRun` 偏移量记账，也不需要"最后一次出现位置"的比较，直接 `!BUSY_MARKER_RE.test(run.screenText) && PROMPT_RE.test(run.screenText)`。
2. `agent-runtime.ts` 的 `isClaudeAcceptDialog`——不用再自己剥 ANSI，直接测 `run.screenText`。
3. `post-start-input-writer.ts` 的 `hasInteractivePromptReady`/`hasPasteAck`——同样直接测 `run.screenText`，删掉了手写的 `stripAnsi`/ANSI 正则和 paste-ack 的 offset baseline 记账。

**验证**：用 `@xterm/headless` 直接模拟了第 10 个 bug 的场景——先写入一段带 "esc to interrupt" 的忙碌帧，再写入不带换行、光标直接画 `❯` 的"紧凑收尾帧"（`✻Cooked for2m 42s❯ ← for agents`）。结果：忙碌帧正确判定为"忙碌"，紧凑收尾帧正确判定为"就绪且不忙碌"——这正是第 10 个 bug 里检测不到的场景，现在能识别了。`tsc --noEmit` 干净，daemon 36 个单测全过。

**这个方案为什么能一次性解决第 3/5/6/10 个 bug 的共同根源**：这四个 bug 全部源于"对不断累积、从不清空的原始字节流做正则扫描"——同一个字符出现一次就永远留在历史里，不同渲染方式（换行 vs 光标定位）还需要分别适配正则。`screenText` 是终端模拟器实时维护的"当前这一帧"，天然不存在"历史里的陈年匹配"这个问题，也不需要关心具体是换行画的还是光标定位画的——模拟器本身就正确处理了这些控制序列，判断逻辑只需要看渲染结果。

### 部署时的一个插曲：`@xterm/headless` 的 ESM 具名导出

`tsc --noEmit` 通过之后第一次真机启动就崩了：`SyntaxError: The requested module '@xterm/headless' does not provide an export named 'Terminal'`。原因：这个包的 CJS 产物是压缩成一行的 bundle，Node ESM 的 `cjs-module-lexer` 静态分析识别不出具名导出——`tsc` 用的是 `.d.ts` 类型声明（里面确实声明了 `Terminal`），只检查类型不检查运行时产物形状，所以类型检查通过但真正用 `tsx` 跑起来会炸。**修复**：改成默认导入再解构（`import xtermHeadless from "@xterm/headless"; const { Terminal } = xtermHeadless;`），ESM 对 CJS 的互操作总会把整个 `module.exports` 暴露成默认导出，不受具名导出静态识别成不成功影响。这次额外用 `tsx` 实际跑了一遍确认能正常工作，不再只信 `tsc`。

### 第 11 个 bug：`screenText` 修好了"陈年匹配"，但引入了新的盲点——刚启动的欢迎屏和真正说完话的空闲屏长得一模一样

`screenText` 上线后第一次实测：`round-end` 在 `outputLen=827`（还是最原始的启动欢迎屏）就立刻触发了，比之前任何一次都快，跟第 3 个 bug 修复前的症状一样。

根因：`screenText` 确实解决了"陈年字节永远留在历史里"的问题，但引入了一个新问题——**刚启动的欢迎屏**（没有忙碌标记 + 有 `❯`）和**真正说完话之后的空闲屏**，单看"当前这一帧长什么样"是完全无法区分的，两者都是"不忙碌 + 提示符可见"。之前的偏移量方案好歹能排除"写入前"就存在的内容，这次为了解决"陈年匹配"问题把这个约束也一起去掉了，结果丢了区分"从没处理过"和"处理完了"的能力。

**修复**：不再只看"当前是不是空闲"，改成要求"确实观察到忙碌过，然后才变空闲"——新增 `busyObservedByAgent`（按 agentName），回合结束检测里，先检查 `esc to interrupt` 忙碌标记，出现过就记下来（`markBusyObserved`）且直接返回；只有**之前记录过忙碌**、且**当前不忙碌**、且**提示符可见**三个条件同时成立，才判定回合结束，并清掉这个标记等下一轮。写入新消息时按跟 `hasPending` 一致的规则重置这个标记（重叠写入不重置，避免丢失"已经在忙"的证据，参考第 8 个 bug 的处理方式）。

**这个不变量为什么更稳**：它直接对应"我们等的是一次忙碌→空闲的转变，不是任意一个空闲瞬间"这个语义，不依赖屏幕内容的具体渲染细节，也不需要区分"这是欢迎屏还是回复完成屏"——只要曾经观察到过 Claude 真的在处理（无论用什么方式渲染忙碌状态），就足够了。

### 第 12 个 bug：`COMMANDS_WITH_BRACKETED_PASTE.has(command)` 传的是绝对路径，从来没命中过——第 4 个 bug 的修复其实从没生效过

第 11 个 bug 修复后，实测又卡住了：`outputLen` 冻结在 4450，74~94 秒过去 `busyObserved` 始终是 `false`——Claude 从没开始处理过。这次没有直接猜，先给 `submitPastedInteractiveInput`（写粘贴内容/发送回车两处）和 STUCK 检测都加了诊断日志（打印 `pending`/`busyObserved` 状态 + `screenText`）再让用户重测一次。

拿到新日志后关键发现：**从头到尾没有出现任何一行 `[PostStart]` 日志**——说明 `submitPastedInteractiveInput`（第 4 个 bug 修的那条"先等粘贴确认，再等一小段时间，最后发回车"的路径）根本没被走过。同时 `screenText` 显示完整的 bootstrap+消息原文本还原封不动地"躺"在输入框里，没有被折叠成 `[Pasted text #N]` 占位符，也没有任何提交痕迹。

排查 `createPostStartInputWriter(agentManager, resolvedClaudePath)` 的调用点发现：传进去的 `command` 参数是 `resolveClaudeBinary()` 解析出来的**绝对路径**（这台机器上是 `C:\Users\...\claude-code\bin\claude.exe`），而 `post-start-input-writer.ts` 里判断"这个 CLI 支不支持 bracketed paste"用的是 `COMMANDS_WITH_BRACKETED_PASTE.has(command)`——`Set(["claude", "codex", "opencode"])` 里存的是裸命令名字面量，拿一个完整绝对路径去比较**永远不可能命中**。也就是说，从第 4 个 bug 那次"修复"开始，`useBracketedPaste` 在这台机器上就一直是 `false`，走的始终是最原始的"粘贴内容和回车合并成一次 `pty.write()`"那条路——第 4 个 bug 描述的那个"大段粘贴、回车抢跑"的竞态其实从来没被真正堵上，只是大多数时候运气好、Claude 处理得够快没有炸出来。这次没那么走运。

**修复**：新增 `commandBaseName(command)`——用 `basename()` 取文件名，再去掉 `.exe`/`.cmd`/`.bat` 后缀、转小写，拿这个"裸名字"去匹配 `COMMANDS_WITH_BRACKETED_PASTE`，不管调用方传来的是字面量 `"claude"` 还是解析出来的绝对路径。这个函数其实早就存在（`basename(command)` 之前只用在诊断日志里打印，从没用在真正的判断逻辑上）——纯属疏忽。

**这次的教训**：加诊断日志再等一轮实测，比直接猜一个"看起来合理"的修复更快找到根因——如果这次继续凭空猜（比如"再调整一下 paste-ack 的超时时间"之类），大概率还是治标不治本，因为真正的问题是那条修复路径压根没被执行到。
