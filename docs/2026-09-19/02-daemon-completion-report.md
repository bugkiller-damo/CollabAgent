# Slock Daemon 完成情况盘点 + Agent 体验专项审计

> 日期：2026-09-19
> 范围：`packages/daemon`（src 90 文件 / test 43 文件），以及它与 server / shared / web 的接缝
> 方法：逐文件精读核心链路（runtime / dispatch / headless / stream / queue / driver / prompt / handlers）+ 机械采集（清单、tsc、vitest、env、CLI、MCP、WS、git、docs 勾选）
> 原始数据：`docs/2026-09-19/_daemon-inventory-raw.md`（本文所有数字均出自该文件或源码行号，可回查）
> 基线：`npx tsc --noEmit` 零错误；`npx vitest run` **43 文件 / 399 用例全绿**（49.4s）；daemon 最后改动 `b6a8b0b`（2026-09-19）
> 目的：给「下一步优化 agent 体验」提供一份事实底稿——先讲清楚什么已经做完、什么是空口承诺、哪些设计在默认路径上其实没接线。

---

## 0. 一句话结论

**工程债已基本清零，产品化能力已成型；但「默认 headless 路径」上有 5 处 agent 体验断点是设计文档里写了、代码里没接线或只接在冻结 PTY 路径上的**——模型选择、经理/worker 身份、会话续接、跨平台启动、系统提示的频道语境。此外两例实测问题（§8.13 频道里只给代码片段 / §8.14 agent 自我设限拒绝 ping）的根因都指向同一件事：**我们 append 的系统提示把 Claude Code 从「工程师」改写成了「聊天回复者」，且对本机执行权限零声明**，再叠加 10k 消息上限、无交付通道、env 剥掉编译链、工具白名单缩水四条技术限制。这些是下一批 agent 体验优化的主攻点（见 §8 / §9）。

| 维度 | 状态 | 一句话 |
|---|---|---|
| 演进 tracker Step 0–7 | ✅ 38/38 勾选 | 全部落地，含 D1/D2/D3/D4/T8 |
| 评估报告 P0（8）/P1（8） | ✅ 16/16 | 运行时鲁棒性、解耦、配置、类型、脱敏全部收口 |
| 评估报告 P2（6） | ⬜ 0/6 | 均未启动；P2.17 PTY 删除按原计划 2026-09 底评估 |
| Buzz 借鉴 T 系列 | T2/T8 ✅，T4 ✅（tracker Step 7 已勾完但 todo 表未同步），T1/T3/T6 ☐，T5 待定，T7 冻结 | |
| Agent 值班（duty） | ✅ Step A+B | daemon 侧 `agent:duty` + `loadExistingAgents` 过滤已接 |
| 测试 | 43 文件 399 用例 | 覆盖 46 / 未覆盖 44 个 src 文件（未覆盖以 CLI/handlers/冻结 PTY/入口为主） |
| Agent 体验 | **有断点** | 详见 §8：5 个高优先断点 + 9 个中低优先摩擦点 |
| 实测案例（2 例） | **已归因** | §8.13 产出形态退化（prompt 定义 / 10k 上限 / 无交付通道 / env 剥编译链 / 工具白名单）；§8.14 自我设限（身份框架 / 命令清单当权限书 / 零授权声明 / 会话惯性）——需产品拍板权限模型（A8） |

---

## 1. 模块完成度总览

成熟度口径：**A** = 有单测 + 默认路径在用 + 无已知缺陷；**B** = 在用但测试薄或有已知摩擦；**C** = 有代码无接线 / 死代码 / 冻结；**❄️** = PTY 冻结保留。

### 1.1 入口 / 协议 / 配置

| 文件 | 行 | 成熟度 | 现状 |
|---|---|---|---|
| `index.ts` | 100 | B | daemon 进程入口；无测 |
| `supervisor.ts` | 160 | B | dev watch + 崩溃退避重启；`killTree` fire-and-forget（P2.19 未做）；无测 |
| `daemon-core.ts` | 461 | A | WS + auth + `sendWs` 唯一出口 + `postAsAgent/editAsAgent/deleteAsAgent`（reply-guard / 熔断 / 进度共用）+ 3s 状态上报；24 用例 |
| `handlers/index.ts` + 7 个 handler | 51+ | A/B | `dispatchDaemonMessage` 12 个入站 type 全路由；`deliver.ts`（8 用例）、`inbound.ts`（10 用例）有测，`agent/reminder/terminal/workspace/ping` 无直接测 |
| `handlers/inbound.ts` | 185 | A | P1.13 `parseWsToDaemonMessage` 归一化 thread_id / 摊平 deliver / agent:start 三变体 |
| `config.ts` | 162 | A | P1.10 `loadDaemonEnv()` 集中 23 个 `SLOCK_*`；`Number.isFinite` 防 NaN；11 用例 |
| `claude-stream.ts` | 54 | A | P1.13 stream-json 保守联合 + `asClaudeStreamEvent` |
| `errors.ts` | 53 | A | P1.14 `DispatchError(code)` → `retriable` 推导；6 用例 |
| `types/index.ts` | 225 | B | 混有 PTY 专用类型（`AgentRunSnapshot`/`PtyOutputBus`）+ **死接口 `IAgentStartup`**（4 个方法零调用方，见 §10） |

### 1.2 运行时编排（默认 headless 主链）

| 文件 | 行 | 成熟度 | 现状 |
|---|---|---|---|
| `agent-runtime.ts` | 675 | A | 注册表 / `loadExistingAgents`（duty 过滤、非 2xx 显式失败）/ `haltAgent` 统一 stop / stuck 检测器 / idle 回收接线；10+6 用例。仍是 675 行「小上帝模块」（评估报告 2.6 未列入 P1.9） |
| `agent-runtime-dispatch.ts` | 601 | A | 工厂：三道成本门 / A1 队列 / `REMINDER_TAIL` / `attachThreadContext` / `runAgent`·`runAgentDm`·`runAgentReminder`·`runAgentTriage` / `buildPatrolPrompt`·`buildTriagePrompt`；24 用例 |
| `agent-runtime-dispatch-headless.ts` | 276 | A | `ensurePersistentSession` 单飞 + `dropStalePersistentSession`；mint → token file → `.mcp.json` → spawn/send；8 用例。**体验断点集中地（§8.1–8.5）** |
| `agent-runtime-dispatch-stream.ts` | 300 | B | 观察帧发布 / C1 tool-call / D4 进度 / D3 差值落库 / D2 thread-session / 回复守卫三分支（代发·改写·追问）。**无直接单测**（经 dispatch.test 间接覆盖） |
| `agent-runtime-state.ts` | 107 | A | 五态；非法迁移 warn+吞；13 用例；无 `onTransition` 钩子（P2.19） |
| `agent-runtime-credentials.ts` | 47 | B | mint scoped token；无测 |
| `agent-runtime-exit.ts` | 162 | B | PTY 退出清理链；headless 不经过；无测 |
| `agent-dispatch-queue.ts` | 352 | A | per-agent 串行 / 6min in-flight / 退避 / 死信 / 15s 去重 / 合并 / `deliveryGate`；17 用例 |
| `idle-reclaimer.ts` | 129 | A | 默认 30min；`reclaimIdleAgent` 覆盖 headless；10 用例 |
| `live-run-registry.ts` / `agent-run-store.ts` | 89/139 | A | PTY 时代产物，headless 从不 `insertAgentRun`（仅崩溃恢复候选列表用） |

### 1.3 驱动

| 文件 | 行 | 成熟度 | 现状 |
|---|---|---|---|
| `drivers/persistent-claude.ts` | 388 | A | 默认驱动：`--input-format/--output-format stream-json --verbose --allowedTools=… --append-system-prompt-file`；`procGen` 代次 / 沉默超时 300s / 成对卸监听；13 用例。**不传 `--model`、不传 `--resume`、`findClaudeCmd` 仅 Windows 候选（§8.1/8.3/8.4）** |
| `claude-print.ts` | 120 | B | one-shot（`SLOCK_ONESHOT_CLAUDE=1`）：`--print --resume <sid>`；同样仅 Windows 候选；无直接测 |
| `drivers/probe.ts` | 66 | A | `probeClaude/probeRuntimes`（ready payload 用）；3 用例 |

### 1.4 提示 / 上下文 / 记忆

| 文件 | 行 | 成熟度 | 现状 |
|---|---|---|---|
| `system-prompt.ts` | 113 | B | `generateSystemPrompt(identity, channel, dispatchContext?)`；17 个 MCP 工具全列；MEMORY.md 协议；**无测**；headless 调用方从不传 `dispatchContext`（§8.2） |
| `agent-startup.ts` | 164 | B | `writeSystemPromptFile` / `createWorkspaceDir`（MEMORY.md 种子 + legacy 目录迁移）/ `fetchDispatchContext`（**仅 PTY 路径调用**）/ 4 个死函数 |
| `agent-context-builder.ts` | 178 | A | D1：仅线程追问注入；40 条 / 8000 字符（UTF-16 计数）；过滤 ⏳ 进度消息；10 用例 |
| `agent-thread-sessions.ts` | 91 | A | D2：`daemon-thread-sessions.json`；仅 one-shot `--resume` 消费；3 用例 |
| `agent-workspace.ts` | 116 | A | web 只读工作区文件（白名单 + 上限）；3 用例 |
| `restart-summary.ts` | 83 | C | 仅 PTY spawn 路径注入；headless 无调用 |

### 1.5 观察 / 进度 / 成本

| 文件 | 行 | 成熟度 | 现状 |
|---|---|---|---|
| `agent-observation.ts` | 231 | A | B1：stream-json → 观察帧（含 P1.15 源头脱敏）；15 用例 |
| `agent-progress.ts` | 136 | A | D4：2s 节流 / 首帧强刷 / `finish({hadSend, rewrite})`；10 用例 |
| `agent-cost-tracker.ts` | 459 | A | D3：(agent, channel, day, thread) 账本 / `createSessionCostDelta` / `evaluateCostGate`；30 用例 |
| `cost-reporter.ts` | 166 | A | P1.24：60s 脏键批量上报 server `/api/agent-costs/sync`；9 用例 |
| `terminal-log.ts` | 60 | A | 共享（headless `terminal:history` 用）；脱敏后落盘；3 用例 |

### 1.6 安全

| 文件 | 行 | 成熟度 | 现状 |
|---|---|---|---|
| `agent-env-whitelist.ts` | 111 | A | P0.4 默认 whitelist；`SLOCK_ENV_INHERIT=1` 回退；10 用例 |
| `agent-token-file.ts` | 48 | A | 0600 + chmod 补刀；9 用例 |
| `agent-tokens.ts` | 64 | C | 本地 token 注册表：15 用例，**但 `issue()` 生产零调用**（评估报告 2.4「高」未处理） |
| `command-presets.ts` | 78 | A | `--allowedTools` 白名单 fail-closed；13 用例 |
| `redact.ts` / `private-dir.ts` | 32/15 | A | P1.15 |
| `auth.ts` | 139 | B | `loadAgentContext`（CLI/MCP 侧 env → 上下文）；仅 token-file 路径被间接测 |
| `agent-mcp-config.ts` | 72 | A | `.mcp.json` + `settings.local.json`（`enableAllProjectMcpServers` + `effort`，effort 键名未证实） |

### 1.7 Agent 回话通道（agent → server）

| 文件 | 行 | 成熟度 | 现状 |
|---|---|---|---|
| `mcp/slock-mcp-server.ts` | 521 | B | 17 个工具（消息 4 / 任务 5 / 派发 4 / 提醒 3 / 附件 1）；**无任何测试直接 import**（`mcp-server.test.ts` 只测 `mcp-bundle`） |
| `mcp-bundle.ts` | 53 | A | esbuild 打包随运行时注入；7 用例 |
| `cli.ts` + `cli/*`（16） | 46+ | B | 14 组 / 43 个叶子命令；仅 `cli/cost.ts` 有测 |
| `setup-slock-wrapper.ts` | 77 | B | 本机 `slock` wrapper；无测 |
| `client.ts` / `proxy.ts` | 113/74 | B | API 客户端 / fetch dispatcher；无测 |

### 1.8 ❄️ PTY 冻结保留（10 文件头 + 3 混合文件段）

`agent-manager.ts` / `agent-manager-support.ts` / `agent-runtime-dispatch-pty.ts` / `agent-runtime-spawn.ts` / `agent-runtime-terms-dialog.ts` / `agent-runtime-turn-tracker.ts` / `agent-stdin-dispatcher.ts` / `post-start-input-writer.ts` / `pty-output-bus.ts` / `terminal-state.ts`；混合：`agent-sessions.ts`（mtime 启发式段）、`agent-runtime.ts`（usePty 读取处）、`agent-runtime-dispatch.ts:320-358`（if(usePty) 分支）。

`agent-manager-lazy.ts`（P0.7）保证 headless 全程不加载 `node-pty`。依赖 `node-pty` / `@xterm/headless` 保留。

**注意（§8 的根源之一）**：PTY 路径拥有而 headless 路径没有的能力：`--model`（`agent-runtime-spawn.ts:207`）、`fetchDispatchContext`（`agent-runtime-dispatch-pty.ts:95`）、`--resume` + `restart-summary`（`agent-runtime-spawn.ts:172-462`）、跨平台 `resolveClaudeBinary`（`agent-runtime.ts:81`）。2026-08-18 pivot 时这四项没有一并搬到 headless。

---

## 2. 核心链路逐段核查（默认 headless）

```
server WS agent:deliver
  → handlers/inbound.parseWsToDaemonMessage（归一化）
  → handlers/deliver.handleAgentDeliver
      ├ 附件摘要注入（F6）
      ├ "🤖 " 前缀 / senderType=agent 拦截（防自环）
      ├ forceDeliverTo（经理派单）→ runAgent
      ├ dm → runAgentDm（每个 dmAgentRecipients）
      ├ mentionAgents（server 预过滤）/ 本地 findMentionedAgent → runAgent
      └ triageAgents → pickLocalTriageAgent → runAgentTriage
  → runAgent*：拼任务 prompt（replyTarget 严格化）
      └ attachThreadContext（仅 threadId 存在时拉 /history 注入）
  → dispatchToAgent：成本门① → A1 enqueue（wasBusy → agent:delivery-queued）
  → queue.drain：成本门②（deliveryGate）→ 合并批 → deliver
  → doDispatch：成本门③ → agent-unknown/agent-stopped 永久失败 → dispatchHeadlessTurn
  → dispatchHeadlessTurn：
      ├ idleReclaimer.untrack；needsSpawn → starting + 15s 定时器
      ├ writeSystemPromptFile（每回合重写，含本回合 channel）
      ├ createWorkspaceDir（MEMORY.md 种子）
      ├ mintAgentCredential（每回合）→ writeAgentTokenFile（每回合）
      ├ bundleSlockMcpServer → writeMcpConfig
      ├ ensurePersistentSession（单飞）→ new PersistentClaude（首次）
      ├ enterWorking（代次校验）→ armTurnGuard（进度条 + 守卫）
      └ await session.send(userMsg + REMINDER_TAIL)
  → PersistentClaude：stdin JSON user 消息；stdout 逐行 → onStreamEvent；result → resolve
  → createStreamTurnHandler：
      ├ 观察帧 publish → terminal:obs-frame（WS）
      ├ tool_use/tool_result → agent:tool-call（C1 审计）
      ├ 进度 note → ⏳ 频道消息（PUT 节流）+ agent:progress 顶栏
      ├ result → 成本差值落库；working → idle；idleReclaimer.touch
      └ 回复守卫：hadSend? 删进度条 : (lastText? 改写进度条/代发 : 追问一次)
  → 30min 无回合 → reclaimIdleAgent → PersistentClaude.stop()
```

逐段结论：

| 段 | 状态 | 备注 |
|---|---|---|
| 入站归一化 | ✅ | 三变体兼容；未知 type 静默丢 |
| 路由四源（@ / DM / 派单 / 分诊） | ✅ | 均 fail-closed 于 `hasAgent`（duty=off 不在表里） |
| 任务 prompt | ✅ 可用 / ⚠️ 体验 | 见 §8.2 / §8.6：DM / 顶层 @ 无任何频道历史 |
| 三道成本门 | ✅ | P0.6 |
| A1 队列 | ✅ / ⚠️ | 合并批 `items[0].channelName/threadId` 代表整批（§8.7） |
| 启动准备 | ✅ / ⚠️ | 每回合 mint + 写 token 文件 + 重写 sysprompt（§8.8） |
| 驱动 spawn | ✅ / ❗ | 无 `--model` / 无 `--resume` / Windows-only 候选（§8.1 / 8.3 / 8.4） |
| 回合边界 | ✅ | `result` 事件精确；沉默超时 300s |
| 观察 / 进度 / 审计 | ✅ | 产品化完成 |
| 回复守卫 | ✅ / ⚠️ | `isNudge` 用字符串 includes 判定（§8.7） |
| 空闲回收 | ✅ / ❗ | 回收后会话记忆归零（§8.3） |

---

## 3. 能力面清单

### 3.1 环境变量（37 个标识符 = 34 真实读取 + 3 注释别名）

经 `config.ts` 集中（23 个）：`SLOCK_USE_PTY` `SLOCK_ONESHOT_CLAUDE` `SLOCK_REPLY_GUARD` `SLOCK_CHANNEL_PROGRESS` `SLOCK_CONTEXT_BUILDER` `SLOCK_SESSION_RESUME` `SLOCK_ENV_INHERIT` `SLOCK_VERBOSE_PTY` `SLOCK_IDLE_RECLAIM_MS`(1800000) `SLOCK_STUCK_WARN_MS`(90000) `SLOCK_QUIESCE_MS`(20000) `SLOCK_DISPATCH_INFLIGHT_MS`(360000) `SLOCK_DISPATCH_MAX_RETRIES`(3) `SLOCK_PERSISTENT_TURN_MS`(300000) `SLOCK_RESUME_GRACE_MS` `SLOCK_SESSION_CAPTURE_DELAY_MS` `SLOCK_CONTEXT_MAX_MESSAGES`(40) `SLOCK_CONTEXT_MAX_CHARS`(8000) `SLOCK_PROGRESS_THROTTLE_MS`(2000) `SLOCK_COST_BUDGET_USD`(null) `SLOCK_COST_REPORT` `SLOCK_AGENT_ALLOWED_TOOLS` `SLOCK_AGENT_EFFORT`(medium)。

不经 `config.ts`（11 个，子进程注入键 / CLI·MCP 侧读取 / 机器身份）：`SLOCK_SERVER_URL` `SLOCK_SERVER_ID` `SLOCK_AGENT_ACTIVE_CAPABILITIES` `SLOCK_AGENT_PROXY_URL` `SLOCK_AGENT_PROXY_TOKEN` `SLOCK_AGENT_PROXY_TOKEN_FILE` `SLOCK_AGENT_CREDENTIAL_KEY_FILE` `SLOCK_AGENT_TOKEN` `SLOCK_AGENT_ID` `SLOCK_AGENT_TOKEN_FILE` `SLOCK_MACHINE_ID`。

仅注释（历史别名 / 已删）：`SLOCK_DISPATCH_QUEUE` `SLOCK_PERSISTENT_CLAUDE` `SLOCK_ENV_WHITELIST`。

**观察**：`SLOCK_SESSION_RESUME` / `SLOCK_RESUME_GRACE_MS` / `SLOCK_SESSION_CAPTURE_DELAY_MS` / `SLOCK_STUCK_WARN_MS` / `SLOCK_QUIESCE_MS` / `SLOCK_VERBOSE_PTY` 六个在默认 headless 下**基本无效**（PTY 专属或 PTY 语义），文档/`slock` 帮助里应标注，否则运维会以为「开了 resume」。

### 3.2 CLI（`slock`，14 组 / 43 叶子）

auth(1) · channel(3) · thread(1) · server(1) · message(5) · attachment(2) · task(5) · dispatch(4) · profile(2) · reminder(6) · patrol(7) · agent(2) · cost(1) · session(1)。完整 option 见 raw §5。

### 3.3 MCP 工具（17）

`send_message` `upload_attachment` `list_tasks` `create_tasks` `claim_tasks` `update_task_status` `unclaim_task` `dispatch_task` `list_dispatches` `report_task` `cancel_dispatch` `read_history` `check_messages` `search_messages` `schedule_reminder` `list_reminders` `cancel_reminder`。

**MCP 与 CLI 的能力差**（agent 只能退回 Bash 跑 CLI 的操作）：`message react`、`channel members/join/leave`、`thread unfollow`、`server info`、`profile show/update`、`reminder snooze/update/log`、`patrol *`（7 个）、`attachment view`、`agent duty/ls`、`dispatch list --status`。系统提示 §「可用命令」已如实列出退回路径，但这意味着 agent 越常做「团队感知」类动作（看成员、看服务器、加表情、巡检自管理）就越依赖 Bash + 记住 CLI 语法（§8.9）。

### 3.4 WS 协议（shared 四方向 union 已落地）

入站 12：`connected` `ping` `agent:start` `agent:stop` `agent:duty` `agent:deliver` `reminder.fire` `terminal:watch/unwatch/history/resize` `workspace:read`。
出站 12：`ready` `agent:status` `agent:delivery-queued` `agent:delivery-dead-letter` `agent:tool-call` `terminal:frame` `terminal:obs-frame` `terminal:obs-history` `terminal:history` `agent:progress` `workspace:result` `pong`。

---

## 4. 测试覆盖矩阵（43 文件 / 399 用例）

### 4.1 有直接测试的 src（46）

`agent-context-builder`(10) `agent-cost-tracker`(30) `agent-dir-name` `agent-dispatch-queue`(17) `agent-env-whitelist`(10) `agent-manager-lazy`(6) `agent-mcp-config` `agent-observation`(15) `agent-progress`(10) `agent-run-store`(5) `agent-runtime`(10+6 stop+6 integration+5 resume) `agent-runtime-dispatch`(24+2 pty-cost) `agent-runtime-dispatch-headless`(8) `agent-runtime-dispatch-pty` `agent-runtime-spawn`(4) `agent-runtime-state`(13) `agent-runtime-turn-tracker` `agent-sessions`(3) `agent-startup`(经 workspace 测) `agent-thread-sessions`(3) `agent-token-file`(9) `agent-tokens`(15) `agent-workspace`(3) `auth` `claude-stream` `cli/cost` `command-presets`(13) `config`(11) `cost-reporter`(9) `daemon-core`(24) `drivers/persistent-claude`(13) `drivers/probe`(4) `errors`(6) `handlers/deliver`(8) `handlers/inbound` `handlers/types` `idle-reclaimer`(10) `live-run-registry`(10) `machine-id`(6) `mcp-bundle`(7) `post-start-input-writer`(14) `ready-payload`(3) `redact`(8) `terminal-log`(3) `terminal-state`(2) `types/index`。

### 4.2 无直接测试的 src（44），按风险分组

| 组 | 文件 | 风险评估 |
|---|---|---|
| **Agent 体验热路径，缺测** | `agent-runtime-dispatch-stream.ts`（回复守卫三分支 / 进度 finish / 成本差值）、`system-prompt.ts`、`mcp/slock-mcp-server.ts`（17 工具）、`claude-print.ts`、`agent-runtime-credentials.ts` | **高**：§8 的改动都会碰这些文件，现在改了没有回归网 |
| WS handler 薄层 | `handlers/agent.ts`（含 duty）、`handlers/reminder.ts`、`handlers/terminal.ts`、`handlers/workspace.ts`、`handlers/ping.ts`、`handlers/index.ts` | 中：`daemon-core.test.ts` 经 `handleMessage` 间接覆盖大部分 case |
| CLI（15） | `cli.ts` + `cli/*` 除 `cost.ts` | 中：agent 退回 Bash 时的唯一通道；参数解析错误 = agent 静默失败 |
| 进程 / 环境 | `index.ts` `supervisor.ts` `exit-coordinator.ts` `exit-handler.ts` `setup-slock-wrapper.ts` `client.ts` `proxy.ts` `command-resolver.ts` `output.ts` `private-dir.ts`（经 token-file 间接） | 低-中 |
| 冻结 PTY | `agent-manager.ts` `agent-manager-support.ts` `agent-runtime-terms-dialog.ts` `agent-stdin-dispatcher.ts` `pty-output-bus.ts` `agent-runtime-exit.ts` | 低（冻结不改） |
| 死代码 | `restart-summary.ts`（headless 无调用） | — |

---

## 5. 历史计划兑现核对

### 5.1 `docs/2026-08-20/02-daemon-evolution-tracker.md`

- Step 0–7 共 38 个 `- [x]`，0 个 `- [ ]`。Step 7 小节标题仍带 `☐`（子项全勾，标题漏改）。
- 「完成记录」表登记到 P1.15；P1.16（`b19b269`）在「当前焦点」段有记录但表里缺一行。
- 「当前焦点」指向「P2 批（均未启动）」，与代码现状一致。

### 5.2 `docs/2026-08-24/01-daemon-evaluation-report.md`

- P0.1–P0.8、P1.9–P1.16 ✅ 16/16；P2.17–P2.22 ⬜ 0/6。
- 2.4 安全表中「高：`agent-tokens.ts` 本地注册表 `issue()` 生产零调用」**未列入 P0/P1/P2 任何编号**，仍悬空（本文 §10 列为清理项）。
- 2.3 队列表中「去重窗口在死信路径写入」「合并批退避取 min attempts」「`inThread` 用 `replyTarget.includes(":")`」三条 P1 建议未落地（本文 §8.7 归入体验摩擦）。
- 附录 A 覆盖矩阵仍写「评估时 27 测试文件」，现为 43。

### 5.3 `docs/2026-08-19/01-buzz-borrowing-todo.md`

- T4 在 tracker Step 7 已全勾，但 §4 汇总表仍 `☐ Step 7`——应同步为 ✅ 2026-08-21。
- L4「网络命令 `--max-time` 引导加固」标「随手可做」，至今未做（`system-prompt.ts` 无此句；§8.9）。
- L5 提到「persistent 路径闲置回收疑似未覆盖（40min+）」——已由 P0.2 修复，表未同步。

### 5.4 `docs/2026-08-23/05-agent-duty-design.md`

- Step A+B 落地；daemon 侧：`handlers/agent.ts:32` `handleAgentDuty`、`agent-runtime.ts:592` `row.duty === "off"` 过滤、`:608-613` 重连时 unregister 缺席/停班者。
- Step C「收口与文档」（扫残留 `isOnline`、修订 01–04、CLAUDE.md 索引）未见勾选记录；CLAUDE.md 索引确有 05 条目，标「审查中」应改「已落地」。

### 5.5 CLAUDE.md 与现状的偏差

- 「当前状态」写「50 个源文件 + 23 个测试文件」；实际 90 / 43。
- 「常用验证命令」写「test/ 40 文件」；实际 43。
- `05-agent-duty-design.md` 标「审查中」；实际已落地。

---

## 6. 近 30 天 daemon 变更（git，23 条）

| 期间 | 主题 |
|---|---|
| 08-21 | Step 4–6：D3 成本 / T8 分诊 / D1·D2 上下文（`ae29832`） |
| 08-25 | P0.1–P0.8 运行时修复 + 解耦 + 核心单测；Step 7-8 产品化收尾（档案 / Computer / 值班 / 观察帧，`ab24509`）；supervisor Windows watch 修复；deps 安全升级 |
| 08-26 | P1.10–P1.16：配置层 / 成本查询 / 监听清理 / 类型收紧 / 错误模型 / 脱敏 / 删旧链 |
| 09-01～09-03 | server 评估报告 P1.20/23/24 连带 daemon：删 `cli/action.ts`·`cli/integration.ts`、`client.ts` 删 `/internal/agent-api` 重写面、`cost-reporter.ts` 新增、reminder `--tz` |
| 09-16～09-19 | F4–F8 附件（deliver 附件摘要、MCP `upload_attachment`）；跨用户 agent 可见性（状态/终端同步）；server 权限模型 + server-scoped computers（`--server` scope、`machineUuid`） |

**观察**：08-26 之后 daemon 没有再做「agent 体验」维度的改动，全部是 server 主导的连带修改。这与 §0 结论一致——是时候回到 agent 侧。

---

## 7. 已知悬空 / 未同步项汇总（非体验类）

| # | 项 | 出处 | 建议 |
|---|---|---|---|
| H1 | `agent-tokens.ts` 注册表 `issue()` 零调用；exit handler 用它查空 Map | 评估 2.4 高 | ~~删除或接线~~ ✅ 2026-09-20 已删（吊销全由 server 承担，CLAUDE.md 已注明） |
| H2 | `IAgentStartup` 接口 + `buildStartupInstructions/buildIdentityMarker/buildProtocolDoc/buildReminderTail` 零调用 | 本次 grep | ✅ 2026-09-20 已删 |
| H3 | `restart-summary.ts` 仅 PTY 用 | 本次 grep | ⏸ 随 PTY 删除评估一并处置（唯一调用方在冻结文件） |
| H4 | `src/auth/` `src/commands/` 空目录 | raw §1 | ✅ 2026-09-20 已删 |
| H5 | PTY 语义的 6 个 env 在 headless 无效 | §3.1 | ✅ 2026-09-20 已标注（口径修正：A2 后仅 4 个真 PTY-only；`slock --help` 本就不列 env） |
| H6 | 成本/线程会话 JSON 路径依赖 `process.cwd()` | 评估 P2.20 | ✅ 2026-09-20 `slockDir()` + `SLOCK_STATE_DIR` 全收口 |
| H7 | `agent-mcp-config.ts` 写 `settings.effort` 键名未证实 | 代码注释 | ✅ 2026-09-20 改 `effortLevel`（A0.3 已真机证实键名） |
| H8 | `supervisor.killTree` 不等退出 | 评估 P2.19 | ✅ 2026-09-20 等 taskkill+exit 双落定；index.ts 单实例守卫同款修复 |
| H9 | 文档同步：CLAUDE.md 数字、tracker 完成表 P1.16、buzz-todo T4/L5、duty「审查中」 | §5 | ✅ 2026-09-20 已同步（duty 文档已是「已落地」，无需改） |

---

## 8. Agent 体验专项审计（重点）

视角切换：**站在 agent（Claude Code 子进程）的位置**看它每回合拿到了什么、缺什么、被什么打断。每条给出：现状（可回查行号）→ 体验后果 → 建议方向 → 优先级。

### 8.1 ❗ P0 · 用户选的模型在默认路径被无视

- **现状**：`runtime_profile.model`（web 端 sonnet/opus/haiku 选择）由 `handlers/agent.ts:19` 解出并存入 `agentInfo.model`，但 **只有冻结的 PTY 路径**在 `agent-runtime-spawn.ts:204-210` 拼 `--model`。headless：`agent-runtime-dispatch-headless.ts:187` `new PersistentClaude({cwd, systemPromptFile, env, label, …})` 不传 model；`persistent-claude.ts:109-116` args 里没有 `--model`；`claude-print.ts:38` 同样没有。`agentInfo` 的 model 字段在 headless 全程只被读一次（PTY 的 `getAgentModel`）。
- **后果**：用户在档案里把 agent 设成 haiku 省钱 / 设成 opus 求质量，实际全部跑 Claude Code 的默认模型。成本记账（D3）因此与用户预期脱节；「不同 agent 用不同模型分工」这个产品承诺在默认路径为假。
- **建议**：`PersistentClaudeOpts` 加 `model?: string`，`spawnProc` 拼 `--model`（沿用 spawn.ts 的 `/^[a-z0-9._-]+$/i` 校验）；`dispatchHeadlessTurn` 从 `agentInfo.get(agentName)?.model` 取；`claudePrint` 同步。**模型变更 = 换进程**：`registerAgent` 已在 PATCH 时 tearDown（见 8.10），天然覆盖。补 `persistent-claude.test.ts` 用例断言 args 含 `--model`。
- **优先级**：P0（功能性缺失，非摩擦）。

### 8.2 ❗ P0 · 经理 / worker 身份在 headless 系统提示里是「条件句」

- **现状**：`agent-startup.ts:23-27` 注释明确写道「通用条件句式（'如果你是经理…'）agent 没有任何办法判断自己是不是经理，实测会直接把整条指令当模糊闲聊处理」，因此提供了 `fetchDispatchContext` 查 `/internal/agent/:id/channel-members` 得到 `isManager + otherAgents`。但它**只在 PTY 路径**被调用（`agent-runtime-dispatch-pty.ts:95`）。headless `agent-runtime-dispatch-headless.ts:148` 调 `writeSystemPromptFile(agentName, channelName, true, info)` **不传第 5 个参数**，`system-prompt.ts:91-94` 因此落入 `dispatchContext` 为空的通用分支。
- **后果**：T8 经理分诊的经理并不知道自己是经理、也不知道频道里有哪些 worker 可派；分诊 prompt（`buildTriagePrompt`）虽说「你是本频道的经理」，但系统提示层没有可派发名单，经理只能瞎猜 `toAgent`（`system-prompt.ts:84` 那句「先问清楚具体是上面哪一个，不要瞎猜」在 headless 从未出现）。这是 08-18 pivot 时遗漏的 PTY→headless 迁移项。
- **建议**：`dispatchHeadlessTurn` 在 spawn 前 `await fetchDispatchContext(serverUrl, apiKey, agentId, channelName)`（需把 `apiKey` 加进 `DispatchHeadlessTurnOpts`，工厂已有 `options.apiKey`），传入 `writeSystemPromptFile`。但要注意 8.5：系统提示只在 spawn 时读，频道语境会漂——所以更彻底的方案是**把身份事实放进每回合任务 prompt**（`runAgent`/`runAgentTriage` 里附「你在 #ch 的角色：经理，可派发：@a、@b」一行），spawn 时的系统提示只保留通用规则。推荐两处都做：spawn 用首频道 context，回合 prompt 用当前频道 context。
- **优先级**：P0（T8 的可用性依赖它）。

### 8.3 ❗ P0 · 会话续接在默认路径不存在：30 分钟不说话 = 失忆

- **现状**：`persistent-claude.ts:106-159` `spawnProc` 每次都是全新进程，args 无 `--resume`；`agent-sessions.ts` 的 sessionId 捕获是 PTY 冻结段；`daemon-thread-sessions.json` 仅供 one-shot（`SLOCK_ONESHOT_CLAUDE=1`）`--resume`（`agent-runtime-dispatch-headless.ts:254-259`）。`idle-reclaimer` 默认 30min（`config.ts:35`）`stop()` 进程；daemon 重启也是全新进程。`daemon-core.ts:288` 注释「上下文由 session resume（默认开）或 restart-summary 注入保住」——**对默认路径不成立**：两者都只在 PTY 路径存在。
- **后果**：用户中午 @ 了 agent 讨论方案，下午 2 点追问「按刚才说的第二种方案做」，agent 已经是一个空白进程——只剩 MEMORY.md（而 MEMORY.md 由 agent 自觉更新，弱模型实测经常不写）。D1 Context Builder 只在**线程追问**时补历史，顶层频道追问 / DM 追问零上下文。这是「agent 像金鱼」体感的主因，比任何 prompt 措辞问题都大。
- **建议（三层，可分批）**：
  1. **stream-json `system` init 事件带 `session_id`**（`agent-runtime-dispatch-stream.ts:227` 已在读它给 D2 用）——把它按 agent 持久化到 `.slock/daemon-agent-sessions.json`；`PersistentClaude.spawnProc` 支持 `resumeSessionId` → `--resume <id>`；resume 失败（进程秒退 / 首个事件 error）清 id 重 spawn 一次（复用 spawn.ts 的宽限期思路，逻辑非冻结可重写）。
  2. 回收策略分层：30min 回收进程但保留 session id → 下次 `--resume` 温启动；只有 `duty off` / 删除 / 显式 stop 才丢 session。
  3. resume 不可用时的兜底：`restart-summary`（现只 PTY 用）改造为读 `.slock/daemon-costs.json` + 观察帧 transcript 尾部生成「上次你在 #x 做了…」摘要注入首回合。
- **风险提示**：`--resume` 与 `--append-system-prompt-file` 并用、与 `--input-format stream-json` 并用是否稳定，需要一次真机验证（08-18 之前 PTY 路径验证过 `--resume` 本身可用）。
- **优先级**：P0（体验影响最大）。

### 8.4 ❗ P0 · 默认驱动只认 Windows 的 `claude.cmd`

- **现状**：`persistent-claude.ts:11-16` 与 `claude-print.ts:8-15` 的 `findClaudeCmd()` 候选全是 `%APPDATA%/npm/claude.cmd`、`C:/Program Files/Claude Code/claude.cmd`、`claude.cmd`，找不到就返回 `"claude.cmd"` 用 `shell:true` 起。`agent-runtime.ts:81-97` 有一套跨平台的 `resolveClaudeBinary()`（PATH 探测 + .cmd shim 解析 + `command-resolver` 兜底），**只给 PTY 用**（`postStartWriter` 的 `resolvedClaudePath`）。
- **后果**：在 macOS / Linux 上（README 写的 compose 部署、Computer 一等公民「一人一机」的多机场景），默认 headless 大概率 `claude.cmd: command not found` → spawn 失败 → 队列重试 3 次 → 死信。用户看到的是「@ 了没反应，然后 toast 投递失败」。**本条结论基于源码推断，未在非 Windows 机上实测**——建议先在一台 Linux 上跑一次确认。
- **建议**：两处 `findClaudeCmd` 删掉，改用 `resolveClaudeBinary()`（从 `agent-runtime.ts` 抽到 `command-resolver.ts` 或 `drivers/probe.ts`，非冻结）；非 Windows 下 `shell:false` 直接 spawn 真实路径（顺带解决评估报告 2.4 的 `shell:true` + 简易 `q()` 引号问题）。
- **优先级**：P0（阻断性，跨平台）。

### 8.5 ⚠️ P1 · 系统提示的「本次任务」频道语境随首个频道冻结

- **现状**：`dispatchHeadlessTurn` 每回合 `writeSystemPromptFile(agentName, channelName, …)`（`:148`）重写 `.slock/sysprompt-<agent>.md`，内容含「你在 #<channelName> 频道里被 @ 了」「`slock message send --target "#<ch>"`」等（`system-prompt.ts:59-70, 103-104`）。但 PersistentClaude 只在 `spawnProc` 时 `--append-system-prompt-file` 读一次；同一 agent 后续在其他频道 / DM 的回合仍复用该进程，系统提示里写的是**第一个唤醒它的频道**。文件被覆盖但进程不感知。
- **后果**：agent 在 #dev 被首次唤醒，后来在 #design 被 @，系统提示说「你在 #dev」而任务 prompt 说「target 必须严格用 #design」——两处矛盾。多数情况 recency 让任务 prompt 胜出（REMINDER_TAIL 也在补），但弱模型在长回合末尾偶发发错频道；更重要的是系统提示里那一整段「可用命令」示例都带着错误的 `#dev`。
- **建议**：系统提示**去频道化**——`generateSystemPrompt` 不再接 channelName，把「本次任务」段整体移到回合 prompt（`runAgent` 已有 replyTarget 严格化，只需把「先读 MEMORY.md」加过去）；示例命令用 `<target>` 占位。每回合重写文件的动作也可省掉（只在 spawn 前写一次）。
- **优先级**：P1。

### 8.6 ⚠️ P1 · 顶层 @ 与 DM 拿不到任何频道历史

- **现状**：`attachThreadContext`（`agent-runtime-dispatch.ts:477-511`）`if (!agentId || !threadId) return` —— 仅线程追问注入。`runAgentDm`（`:536-551`）根本不调它。D1 设计有意「顶层 @ / DM / 巡检不注入」（tracker Step 6），理由是成本。
- **后果**：叠加 8.3 后，agent 在顶层频道对话完全靠自己调 `read_history`（每次一个工具回合，慢且弱模型常忘）；DM 里用户连续几条消息若被 A1 合并还好，若分回合投递就是逐条失忆。
- **建议**：给顶层 @ 和 DM 一个**小预算**上下文（例如最近 8 条 / 2000 字符，`SLOCK_CONTEXT_TOPLEVEL_MAX_*`），复用 `packThreadContext` + `isProgressContent` 过滤；DM 走 `read_history(channel="dm:@x")` 同一 `/history` 端点。成本可控：8000 字符线程预算已有先例。同时把 `recordContext` 记账扩展到这两条路径。
- **优先级**：P1（8.3 落地后本条的边际收益仍然明显：session resume 保住的是 agent 自己的对话，注入的是**别人在频道里说的话**）。

### 8.7 ⚠️ P1 · A1 合并批的三个语义漏洞

1. **跨频道合并取第一条的频道**：`agent-runtime-dispatch.ts:409-416` `deliver` 把整批 `items` 拼成一条，`doDispatch(agentName, items[0].channelName, merged, items[0].threadId)`。队列按 agent 不按频道分（`agent-dispatch-queue.ts:186`）。若 agent 忙时 #a 和 #b 各来一条，合并后进度条 / 回复守卫代发 / 成本记账全记在 #a；agent 若只发了一条到 #b，守卫会认为 `hadSend=true`（`isSendToolFrame` 不看 target），#a 的问题静默无人答。
2. **`isNudge` 字符串探测污染整批**：`agent-runtime-dispatch-stream.ts:94-99` 用 `userMsg.includes("【频道分诊】") || includes("【定时巡检】")` 判 nudge。一条真实 @ 与一条分诊/巡检 prompt 被合并后，整批 `isNudge=true` → 频道进度条关闭、回复守卫全部跳过——真实 @ 失去兜底。
3. **去重窗口在入队即写**（`agent-dispatch-queue.ts:308`）：死信后用户 15s 内原文重发被吞（评估 2.3 P1 未做）；**合并批退避取 min attempts**（`:250`）（评估 2.3 P1 未做）。

- **建议**：队列键改为 `(agent, channel, threadId)` 分桶合并（或 deliver 时按 channel 分组多次 `doDispatch`，仍串行）；`isNudge` 改为 `DispatchQueueItem.kind`（已有 `"message" | "reminder" | "dispatch"` 字段，加 `"nudge"`/`"patrol"`/`"triage"`）随 item 传递，合并批 `kind` 不同则不合并；`recentContents` 在 delivered 后写、死信不写；退避取 max attempts。
- **优先级**：P1（多 agent 团队场景下频率会上升）。

### 8.8 ⚠️ P1 · 每回合 mint 凭证 + 重写 token 文件 + 重写系统提示 + 重打 MCP bundle 检查

- **现状**：`agent-runtime-dispatch-headless.ts:147-176` 每回合：`writeSystemPromptFile` → `createWorkspaceDir` → `await mintAgentCredential` → `writeAgentTokenFile` → `await bundleSlockMcpServer` → `writeMcpConfig`。评估 2.4「中」已指出 token churn；注释自己也说「这条兜底路径较少用」——但它现在是**默认主路径**。
- **后果**：每回合多一次 server 往返（mint）+ 5 次文件写；进行中的 MCP 子进程每次请求重读 token 文件，回合切换瞬间可能读到新 token（server 端 upsert 旧 token 即失效，但 MCP server 是每请求重读，所以功能无碍）。更实际的体验影响是**首字延迟**：用户 @ 之后要等 mint 往返才开始 spawn/send。
- **建议**：mint 与写文件只在 `needsSpawn` 时做（scoped token 24h TTL，`agent_credentials` 按 agent upsert）；加一个「token 剩余 < 1h 则回合前刷新」的兜底；系统提示 / MCP 配置也只在 spawn 前写（配合 8.5）。
- **优先级**：P1（性能 + 简化）。

### 8.9 ⚠️ P2 · 系统提示与工具面的若干细摩擦

| # | 现状 | 建议 |
|---|---|---|
| a | `system-prompt.ts:55` 一行列全 17 个 MCP 工具名（长句） | 按「回复 / 感知 / 任务 / 派发 / 提醒 / 附件」分组列出，弱模型检索更稳 |
| b | L4「网络命令必须带 `--max-time`」未加（buzz-todo 标随手可做） | 规则段加一句；沉默超时 300s 的主因就是 curl 挂死 |
| c | MCP 缺 `channel_members` / `server_info` / `react` / `profile_show`（§3.3） | 补 3–4 个只读感知工具；经理分诊「读上下文再定」目前要退回 Bash |
| d | `check_messages` 有游标语义但 agent 在 persistent 会话里几乎用不到（消息都由 daemon 推） | 系统提示里降权或说明「仅巡检回合用」 |
| e | `REMINDER_TAIL` 每回合追加同一段 XML（`agent-runtime-dispatch.ts:394-395`） | 保留（对抗 compact 的实证有效手段），但加入「本回合 target」以对冲 8.5 |
| f | 巡检 / 分诊 prompt 的「沉默协议」与回复守卫的「没发就代发 lastText」逻辑靠 `isNudge` 互斥（8.7.2） | 随 8.7 一并改为 kind 驱动 |
| g | `mentionedAgentNames`（`agent-runtime.ts:359-366`）`content.includes("@"+name)` 无词边界：`@bob` 会命中 `@bobby` | 加 `(?![\w-])` 边界；server 已传 `mentionAgents` 时不影响，旧 server / 附件摘要路径受影响 |
| h | `runAgent` 的 `inThread = Boolean(threadId) || replyTarget.includes(":")`（`:522`） | 仅依赖 threadId（评估 2.3 P1） |
| i | 15s 启动超时硬编码（`headless.ts:139-142`），冷机首次 spawn（MCP bundle esbuild + claude 启动）在慢盘上可能超过 | 提到 `config.ts`（`SLOCK_STARTUP_TIMEOUT_MS`），默认 30s |

### 8.10 ⚠️ P2 · 生命周期对 agent 的「粗暴打断」

- **现状**：`registerAgent`（`agent-runtime.ts:541-563`）在 `agent:start` 重推（**任何 PATCH**：改 description / displayName / model）时 `bumpStopGeneration → clearAgentQueue → tearDownAgentProcess → idle`。注释写「重注册视为一次显式停」。`duty on` 也走 `registerAgent`。
- **后果**：用户在 agent 干活时顺手改了它的描述，正在跑的回合被 kill、队列被清、会话丢（叠加 8.3 没有 resume）；被清的 pending 走 `clearAgentQueue` **不触发死信回调**（`queue.clear` 只 settleDone），用户端没有任何 toast。
- **建议**：`registerAgent` 区分「仅元数据变更」（displayName/description）与「运行时变更」（model / duty）：前者只更新 `agentInfo`，不 tearDown；后者若 `working` 则标记「回合结束后重启」而非立即杀（duty off 例外——设计文档 Q1-A 拍板立即中止，保持）。`clear` 出来的 pending 走 `onDeadLetter` 让 server 标 delivery_failed。
- **优先级**：P2。

### 8.11 ⚠️ P2 · Context Builder 预算与模型无关（评估 P2.18）

- **现状**：`agent-context-builder.ts` 按 UTF-16 字符 8000 截断；中文 ≈ 1 char/1 token 级别，英文代码 ≈ 4 char/token，同一预算在不同内容下 token 差 3–4 倍。
- **建议**：按 `agentInfo.model` 给预算表（haiku 小 / opus 大），字符→token 用 CJK 权重估算即可，不必引 tokenizer。
- **优先级**：P2（8.1 落地后才有 model 可用）。

### 8.13 ❗ P0 · 实测案例一：「频道里只给一份代码 + 编译命令，CLI 里却给可运行的完整 demo」

问题重述：同一句「帮我写一个基于 C++ 的简单光追渲染器」，本机 `claude` 交互式会创建项目、写多文件、编译、运行、修错、最后给一个能跑的 demo；频道里 @ agent 得到的是一段代码贴文 + 一行编译命令。

这不是模型能力差异（同一个 Claude Code 二进制、同一份 Claude Code 默认系统提示），而是**我们 append 的系统提示 + 回合 prompt + 运行环境**把 agent 从「工程师」改写成了「聊天回复者」。逐层归因（按影响大小排序）：

| # | 层 | 现状（可回查） | 对本案例的作用 |
|---|---|---|---|
| 1 | **任务定义 = 回复** | `system-prompt.ts:103-104` 「## 本次任务：…理解来意后，用 `send_message` 回复；如有值得记的再更新 MEMORY.md」；`:106-110` 「## 规则（兼顾速度与记忆）…回复发一条消息即可；除非必要不额外调用…（每条都较慢）…简洁、切题」；`agent-runtime-dispatch.ts:524-531` 回合 prompt 「请用 `send_message` 工具回复」；`REMINDER_TAIL`（`:394-395`）「对外回复只能用 send_message」 | 整个 prompt 栈里**唯一的成功标准是「发一条消息」**，没有一个字说「把活干完、跑通、再交付」。CLI 里 Claude Code 的默认循环是 写→编译→运行→修，因为「用户在终端里等结果」；频道里我们明确告诉它「简洁、一条消息、别多调工具」。它照做了。 |
| 2 | **消息上限 10k 字符** | server `lib/validators.ts:14` `MAX_MESSAGE_CONTENT_LEN = 10_000`；`agents-messages.ts:24-25` 超长 400 `content too long (max 10000)`；MCP `send_message` 描述（`slock-mcp-server.ts:128-139`）**不提上限**；`callSlock` 把 400 原样抛回 agent（`:77-88`） | 一个最小光追（vec3 + ray + sphere + 输出 PPM + main）约 150–250 行 ≈ 6k–12k 字符，加解释文字极易超限。agent 第一次 `send_message` 撞 400 后的自然反应是**删代码、压成「核心片段 + 编译命令」**再发。这恰好是用户看到的形态。P1.33 加这个上限时的取舍写的是「agent 长报告超出应拆条」，但 agent 无从得知。 |
| 3 | **产出没有落地通道** | headless cwd = `.slock/workspaces/<agent>/`（`agent-startup.ts:74-76`），只有 MEMORY.md；用户看不到这个目录（web 的 `workspace:read` 只读白名单文件，`agent-workspace.ts`）；系统提示把附件描述为「附件：优先用 upload_attachment…」的**一个可选功能**（`system-prompt.ts:73`），不是「代码/长产出的交付方式」 | CLI 里「可运行的 demo」的物理形态是**cwd 里的文件**；频道里 agent 即使把文件写进了工作区，用户也拿不到，只能把内容贴进消息——于是回到第 2 条的 10k 墙。agent 没有被告知「写成文件 → 打包 → `upload_attachment` → 随消息发」是标准交付流程。 |
| 4 | **工具白名单缺 `Task` / `WebFetch` / `WebSearch` / `NotebookEdit`** | `config.ts:23` `DEFAULT_AGENT_ALLOWED_TOOLS = "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,TodoWrite,mcp__slock"`；`command-presets.ts:5-9` 注释「未列出的工具在 PTY 里会弹权限确认框」——headless 是非交互 stream-json，**未列出的工具直接被 Claude Code 拒绝**（高置信推断，案例二里 agent 说「查天气时调 curl」而不是 WebFetch 与此一致；建议 A0 真机确认一次） | 没有 `Task` 就没有子代理，Claude Code 在 CLI 里做「写渲染器」这类中型任务时常用 Task 拆分/并行探索；没有 WebFetch/WebSearch 就查不了 API/资料。工具面缩水直接降低了「做完整工程」的能力上限。 |
| 5 | **子进程 env 白名单是 Windows 系统键最小集** | `agent-env-whitelist.ts:22-44` 只放 `PATH`/`SYSTEMROOT`/`APPDATA`/`TEMP` 等 20 个 Windows 系统键 + 代理键；**剥掉一切开发工具链变量**（MSVC 的 `INCLUDE`/`LIB`/`VCINSTALLDIR`/`VSCMD_*`、`JAVA_HOME`/`CARGO_HOME`/`GOPATH`/`VCPKG_ROOT`/`PYTHONPATH`、非 Windows 的 `HOME`/`USER`/`LANG`/`SHELL`） | 用户若在 VS Developer Prompt 里跑 `claude`，`cl.exe` 直接可用；agent 的 Bash 里 `cl` 找不到头文件/库（或 `g++` 不在 PATH 之外的位置）→ **编译失败一两次后 agent 放弃「跑通」，退化为「给你代码和命令，你自己编」**。这是与用户描述形态最吻合的技术性诱因；可在观察帧 / `terminal:history` 里查该回合的 Bash `tool_result` 验证。 |
| 6 | 思考强度被降档 | `agent-mcp-config.ts:61-70` 写 `settings.effort = "medium"`（注释自己承认键名未证实） | 若生效，规划/自检深度低于 CLI 默认（high）。 |
| 7 | 模型不是用户选的 | §8.1 | 用户 CLI 可能用 opus，agent 跑默认模型。 |
| 8 | 时间预算 | `SLOCK_PERSISTENT_TURN_MS` 300s 沉默超时；A1 in-flight 6min（`config.ts:38-40`） | 编译大工程或长时间 `cmake` 无输出 >300s 会被杀（stream-json 期间 Bash 执行中通常没有事件）；回合被 reject → 重试 → 用户看到「投递失败」。对小 demo 影响有限，但 agent 若被杀过一次会在 MEMORY 里学到「别做大任务」。 |

**结论**：1 + 2 + 3 是主因（定义 / 上限 / 通道），5 是最可能的直接触发（编译失败），4/6/7 是能力上限，8 是边界。修 1–3 就能让「频道里问」拿到和 CLI 同形态的交付；修 4/5 才能让它真的**跑通**。

### 8.14 ❗ P0 · 实测案例二：「agent 自我设限、拒绝 ping、自称受控环境」

问题重述：办公小助手被问权限时自述「协作/生活小助手」「不会替频道成员跑任意脚本」，拒绝 `ping 192.168.58.78`；用户预期是「频道 agent = 本地 Claude Code，完整权限」。

先讲事实：**ping 在技术上是被允许的**。`Bash` 在 `--allowedTools` 白名单里且不限参数；env 白名单保留了 `PATH`/`SYSTEMROOT`，`ping.exe` 可达；没有任何 daemon 侧代码会拦截网络命令。这次拒绝 100% 是模型在我们给的框架下**自己推断出来的边界**。归因：

| # | 来源 | 现状（可回查） | 作用 |
|---|---|---|---|
| 1 | **身份框架 = 聊天平台里的助手** | `system-prompt.ts:46` 「你是 @x，CollabAgent 平台上的一个 AI Agent。CollabAgent 是供人类与 AI Agent 协作的团队聊天平台。」`:49` 「你的角色定位：${description}」（本例 description 大概率是「办公/生活小助手」类文案） | Claude Code 的默认系统提示说「你是软件工程 CLI 工具」；我们 append 的这段把它**重新定位**为「聊天平台上的角色扮演助手」，且角色描述由人填、通常是业务化文案。模型把「办公小助手」理解为能力边界而非称呼。 |
| 2 | **「可用命令」清单 = 能力全集** | `system-prompt.ts:58-73` 「## 可用命令（当前已实现）」逐条列 发消息/读历史/私信/搜索/表情/看服务器/任务板/资料/提醒/附件 | 这一节的本意是教它 slock 工具怎么用，但读起来像「你只能做这些」。案例二第一条回答几乎是逐条复述这个清单——它把「可用命令」当成了自己的权限说明书。 |
| 3 | **对本机执行权限零声明** | 全部 prompt 栈里没有一句「你运行在 owner 的本机、拥有与本地 Claude Code 相同的完整执行能力（任意命令 / 编译运行 / 网络访问 / 文件读写）」 | 缺省下，Claude 面对「在别人的机器上、替第三方执行探测内网」的组合会**保守**：它知道自己不是在操作者的终端里（第 1 条框架告诉它了），请求者 `@dongliang` 不是机器主人（回合 prompt 「来自 @dongliang 的消息」），目标是内网 IP。没有授权声明时，「拒绝 + 建议你自己 ping」是模型的安全默认。CLI 里没有这个问题，因为终端前的人 = 机器主人 = 请求者。 |
| 4 | **持久会话的一致性惯性** | headless 每 agent 一个常驻进程（§8.3）；同一会话里前一回合它已经宣称「我不会替频道成员跑任意脚本」 | 下一回合它会与自己保持一致——「我上一条已经说明不提供这类服务」原话就是这个机制。一次保守回答会在 30 分钟内**固化为该 agent 的政策**。 |
| 5 | 环境自述含糊 | 无 prompt 告诉它「机器归属 / 你可以说自己跑在哪」 | 「具体的主机路径、配置属于内部实现细节」是模型对未知信息的保守填充，不是我们要求的保密。 |
| 6 | 真实存在的技术限制（agent 没说对，但确实有） | ① 工具白名单缺 Task/WebFetch/WebSearch（8.13 #4）；② env 白名单剥开发链变量（8.13 #5）；③ cwd 是隔离工作区不是用户项目；④ 300s 沉默超时会杀长命令（`ping -t` 这种常驻命令必死）；⑤ MCP 缺 `channel_members`/`server_info` 等只读感知工具（§3.3） | 这些是「频道 agent ≠ 本地 CLI」的**真差距**，应该在 prompt 里如实告知 agent，而不是让它猜出一套更保守的边界。 |

**这里有一个需要产品拍板的设计点**（代码现状是「没决定」，模型替我们决定成了「最保守」）：

- 方案 A · **owner 全权 + 频道成员视同授权**（用户当前预期）：系统提示明确「你运行在 @owner 的机器上，拥有与本地 Claude Code 相同的完整能力；频道成员向你提出的执行类请求默认视为 owner 授权，照做即可，不要自设边界；仅对明显破坏性/不可逆操作（删库、改生产、对外发送）先确认」。风险：私有频道成员可借 agent 在 owner 机器上跑任意命令——但这正是「值班」「私有频道成员制」「审计流 C1」存在的意义，应由这些机制而非模型自觉来兜。
- 方案 B · **按 agent 配置能力档位**：档案加 `capability: full | collab`（或复用 `runtime_profile`），daemon 据此生成不同的授权段与 `--allowedTools`；「办公小助手」可以是 collab，「构建机器人」是 full。
- 方案 C · **请求者维度**：owner 的请求全权，非 owner 的执行类请求先在频道 @owner 确认（agent 可用 `send_message` 问一句）。

推荐 **A 为默认 + B 作为可选收紧**（与 duty 设计「意愿与进程分层」同构：能力档位是意愿层，`--allowedTools`/env 是执行层）。无论选哪个，**都必须写进系统提示**——不写就是方案 D「让模型猜」，也就是现状。

**决策结果（2026-09-19）**：用户已拍板采用**方案 A**，本批不做方案 B/C；不新增 `capability` 数据库字段、`agent:start` 字段或档案页开关。方案 A 已随 A3/A8 写入系统提示并完成真机 ping 验收，实施细节见 §9 A8。

### 8.12 观察：哪些体验设计**已经做得好**，改动时不要退化

- 回合级 Promise + `result` 精确边界 + 沉默超时（而非绝对时长）——`persistent-claude.ts:287-329` 注释记录了两轮真机教训，是当前最稳的一段。
- 回复守卫三分支（代发 / 改写进度条 / 追问一次）——把「答了但没发」这个弱模型最常见故障兜住了；改 8.7 时保持 `hadSend` 语义。
- 进度条「结束删 / 代发改写」不留 ⏳ 垃圾；D1 过滤 ⏳ 避免进度污染上下文。
- 三道成本门 + 每日一条熔断消息，不刷屏。
- MEMORY.md 种子模板 + legacy 目录迁移。
- `loadExistingAgents` 非 2xx 显式失败（避免静默 0 注册）。

---

## 9. 建议的下一批：「Agent 体验 A 批」

按依赖排序；每项给验收标准与触及文件，便于拆给子代理并行。**建议先做 A0 验证再动 A1–A4**。

两例实测问题（8.13 / 8.14）的修复落点：**A8 拍板 → A3 重写 prompt → A7 交付通道**，三者合起来才是「频道 agent = 本地 CLI」；A1/A2 解决的是另一组问题（模型 / 身份 / 失忆）。若只能先做一件事：**A3 + A7.1 + A7.5**（改 prompt 任务定义、消息自动拆条、放开编译链 env）三项能立刻改变 8.13 的产出形态。

### A0 · 真机验证（0.5 天，先于一切）

- [ ] 非 Windows（Linux 容器即可）跑 `pnpm dev`，@ 一个 agent，确认 8.4 是否真的 `claude.cmd not found`。**（本轮跳过：仅做 Windows 验证）**
- [x] 手工 `claude --input-format stream-json --output-format stream-json --resume <sid> --append-system-prompt-file x.md` 确认 resume 与 stream-json 并用可行，`system` init 事件回带同一 `session_id`（8.3 前提）。
- [x] 真机看一次 `/effort` 是否为 medium（H7）。
- [x] **案例一复现取证（8.13）**：在同一 agent 上重发「帮我写一个基于 C++ 的简单光追渲染器」，打开该 agent 的观察面板 / `terminal:history`，记录：① 是否有 Bash 编译调用及其 `tool_result`（验证 #5 env 剥离导致编译失败）；② `send_message` 是否收到 `400 content too long`（验证 #2）；③ 有没有 Write 到工作区却没上传（验证 #3）。
- [x] **工具拒绝语义（8.13 #4）**：headless 下让 agent 调一次 `WebSearch`，看 stream-json 里返回的是「permission denied」还是挂起等确认——决定 A7 是扩白名单还是加 `--permission-mode`。

#### A0 实测结果（2026-09-19 晚，Windows 真机，Claude Code 2.1.274 / deepseek-v4-pro relay）

**A0.2 resume 可行性 ✅**：`--resume <sid>` + `--input-format/--output-format stream-json` + `--append-system-prompt-file` 三者并用成立——resume 后 init 回带**同一** `session_id`（67f1f0e9…），且 agent 能回忆起上一回合植入的 marker（真记忆续接，非 id 回声）。8.3 的方案前提成立，A2 可直接做。

**A0.3 / H7 effort 键名 ✅（结论翻转）**：Claude Code 2.1.274 二进制内 settings schema 的键是 **`effortLevel`**（`low|medium|high|xhigh`，另有 `maxEffortLevel`、`modelSettings.<model>.effortLevel`、env `CLAUDE_CODE_EFFORT_LEVEL`）；daemon 写入的 `settings.effort`（`agent-mcp-config.ts:61-70`）**不是合法 settings 键**。stream-json control 请求 `get_settings` 可用（返回 `effective`/`sources`/`applied`）——`effective` 里能见到 `effortLevel`，而 `effort` 键不进入生效面。注意：本机 relay 模型（deepseek-v4-pro）的 `applied.effort` 恒为 `"max"`，env/settings 都不改变它——effort 通道对非 Anthropic 模型是惰性的，验证「生效」需要真 Anthropic 模型。修复动作明确：`effort` → `effortLevel`（可顺手加 `get_settings` 诊断）。

**A0.5 工具拒绝语义 ✅**：白名单外工具（WebSearch）在 headless stream-json 下 **8.7s 内返回 `system/permission_denied` 事件 + `is_error` 的 tool_result**，回合正常结束，不挂起。A7.4 只需扩 `--allowedTools`，无需引入 `--permission-mode`。

**A0.4 案例一复现 ✅（且抓到三条新伤）**：以测试用户 `a0probe` 在 `#onboarding-owner` @ 办公小助手发同款光追请求（seq 13736），WS `terminal:watch` 全帧取证：

- ① **编译探测发生、编译器缺席**：agent 首个 Bash 就是 `g++ --version; cl`（seq 89/94），结果为空（seq 95）→ 跳过本地编译直接写码。**#5 的推断方向正确**（本机根本没装编译器，env 剥离与否都编不了——但剥离 MSVC/MinGW 变量会让「装了」的机器同样失败）。
- ② **`send_message` 400 实测命中**（seq 114→115）：贴全文代码（约 10.5k 字符）→ `slock 调用失败：400 content too long (max 10000)`。**#2 实锤**。agent 自救路径是裁注释重发（seq 122→123 成功，消息 seq 13738）。
- ③ **写文件不进上传通道**（seq 110-111）：`rt.cpp`（10566B）写进 `.slock/workspaces/_____-1dk9t4/`，未走 `upload_attachment`——agent 的 MEMORY 里记着既有教训「.cpp/.txt 附件均被服务端 415（file type application/octet-stream not allowed）」。对照 `config.ts:90-98` `ALLOWED_MIME_TYPES`：`text/plain` 在白名单内但 `.cpp` 上传被声明为 `application/octet-stream` → 415。**#3 实锤 + 细化：根因是上传路径不做扩展名→MIME 映射**（或 MCP 工具声明错 MIME），不是「文本文件不能传」。
- ④ **§8.5 冻结实锤 + 定位**：spawn 时 `sysprompt-*.md` 正确重写为 `#onboarding-owner`（22:09:25），但工作区 `CLAUDE.md`（8/17 由 PTY 分支 `agent-runtime-spawn.ts:393` 写入）仍冻结在 `#智慧城市产品周会`——**headless 路径从不刷新工作区 CLAUDE.md**，而 Claude Code 每会话自动从 cwd 加载它。agent 实测 thinking（seq 87）：「there's a conflict… one CLAUDE.md mentions #智慧城市产品周会, but the actual task says #onboarding-owner」。修法：headless dispatch 同步刷新（或停写）工作区 CLAUDE.md。
- ⑤ **§8.1 模型无视实锤**：agent runtime_profile=`sonnet`，会话 init 帧实测 `model=deepseek-v4-pro`（seq 86）——headless spawn 不带 `--model`，落环境默认模型。
- ⑥ **新发现 1 · 跨 server 频道 @ 静默黑洞**：先在 `#智慧城市产品周会`（Default Server `a319db9b`）发同款消息（seq 13735）——server 正确解析出 `mentionAgents:["办公小助手"]` 并广播，但 daemon 机器令牌 scope=001（`e49ed94c`）≠ 频道 server → `ws/handler.ts:1110` scope 过滤**静默丢弃**，agent 从未被唤醒、无死信、发送方看到 `state:"sent"`。agent 归属 server 与频道归属 server 不一致时，@ 永久失效且无任何告警。
- ⑦ **新发现 2 · 一消息两回合 + 守卫串台**：seq 13736 一条 deliver 产生了**两个回合**（同进程同 session 9c006474）。重建：A1 `dispatchInflightMs=360s`（config.ts:38）在 turn-1 真实 result 到达的边界上先超时 → 队列把同内容 retry 重投（`inflight-timeout` 不在 NON_RETRIABLE）→ dispatch#2 的 `armTurnGuard` 在 result#1 求值前覆盖了 guard → 回复守卫读到 `hadSend=false` 的新 guard 把 turn-1 末段正文当「没发」**代发进频道（seq 13739「本回合完成」）**；turn-2 又把同一 mention 跑了一遍（礼貌回了 seq 13740「已发过」）；turn-2 的 result 到来时 guard 已被删 → 成本记到 `channel="unknown"`（daemon-costs.json 实见）。**连锁证据全对上**：turn-1 进度条（13737）没被 finish 清掉、13739 是代发、无第二条 ⏳、unknown 成本行。根因：in-flight 超时不取消在途 dispatch（进程仍在跑、result 仍会到），retry 与在途回合共用同一 guard/session。
- ⑧ 环境注记：用户级 GateGuard hook（ECC）会拦截 agent 每文件首次 Bash/Write/Edit（seq 91/99/127），agent MEMORY 已自带绕过套路——非 daemon bug，但它放大了回合时长，是触发 ⑦ 超时边的推手之一。

**对 A 批的影响**：A1.1/A1.2/A2 照常；A3 prompt 重写时把「代码/长产出 = 文件+附件交付」写进标准流程（治 ③）；A4 队列语义要加 ⑥（跨 server 唤醒告警/路由）与 ⑦（in-flight 超时应视为「仍在跑」而非失败重投，或与 turn 生命周期对账）；A7.5 之外补一条：附件上传按扩展名推 MIME（`.cpp/.txt` → `text/plain`），否则 agent 永远学不会走附件通道。

测试残留清理：已从两个频道摘除 `a0probe` 成员行、删其 server 001 成员行、`allow_terminal_watch` 已还原 `false`；测试用户行保留在 users 表（有 session FK，删除成本高，handle=a0probe 可识别）。取证文件在 `%TEMP%\slock-a0\`（obs-frames.txt 全帧 / ws-watch.js / 各 probe）。

### A1 · 驱动补齐（并行 3 子任务，互不冲突）

| 子任务 | 改动 | 验收 |
|---|---|---|
| A1.1 `--model` | `PersistentClaudeOpts.model` + `spawnProc` 拼参；`dispatchHeadlessTurn`/`claudePrint` 取 `agentInfo.model` | `persistent-claude.test.ts` 断言 args；web 改 haiku 后日志 `spawning with --model haiku` |
| A1.2 跨平台 binary | `resolveClaudeBinary` 迁至 `command-resolver.ts`；两个 `findClaudeCmd` 删除；非 Windows `shell:false` | Linux 容器 @ 后有回复；Windows 回归不变 |
| A1.3 dispatchContext | `DispatchHeadlessTurnOpts.apiKey`；spawn 前 `fetchDispatchContext`；回合 prompt 附「角色 / 可派发名单」行 | `triage-prompt.test.ts` 增：经理 prompt 含 worker 名单；worker 系统提示含「你不是经理」 |

#### A1 实施结果（2026-09-19 已落地，410 测试全绿）

**A1.1 `--model` ✅**：`PersistentClaudeOpts.model` + `spawnProc` 拼 `--model`（沿用 spawn.ts 的 `/^[a-z0-9._-]+$/i` 校验，非法值 warn 忽略）；`dispatchHeadlessTurn`/`claudePrint` 均取 `agentInfo.model`（相关 Map 类型已补 `model` 字段）。模型变更仍走 `registerAgent` tearDown → 下次 spawn 生效，无需额外处理。**真机验证**：直接 new PersistentClaude(model="haiku") 打出验收日志 `[Persistent probe] spawning with --model haiku`，init 帧 `model=deepseek-v4-flash`——本机 relay 把 Anthropic 档位名映射到自家模型（sonnet→`deepseek-v4-flash[1M]`，默认空档→`deepseek-v4-pro`），`--model` 在 relay 后端同样真实生效且不挂；真 Anthropic 后端则落所选模型。测试：`persistent-claude.test.ts` 断言 args 含 `--model haiku` / 非法值不拼参；两个 dispatch 测试断言 `opts.model` 透传。

**A1.2 跨平台 binary ✅**：`resolveClaudeBinary`（含 .cmd shim 解包）从 `agent-runtime.ts` 迁至 `command-resolver.ts` 三处共用；两处 `findClaudeCmd`（只认 `claude.cmd` 的 Windows 专用候选）已删除。新 `needsShell`：仅 Windows 且解析结果为裸名/`.cmd|.bat` 时 `shell:true`；已解到真实可执行文件（含 Windows .exe）或任何非 Windows 平台 → `spawn(cmd, args, shell:false)` 直起，顺带消掉评估 2.4 的 shell 引号转义层。Windows 真机复用同一路径实际 spawn 了 claude（A1.1 probe 走的就是新路），Linux/macOS 侧逻辑正确但未实测（非 Windows 验证按约定跳过）。`isClaudeAvailable` 改为「解析到真实路径」。

**A1.3 dispatchContext ✅**：`DispatchHeadlessTurnOpts` 加 `apiKey`（`doDispatch` 传 `options.apiKey`）+ 可注入 `fetchDispatchContext`（缺省真实实现）。`dispatchHeadlessTurn` 每回合 `fetchDispatchContext`（DM `dm:*` 跳过查询）：结果第 5 参进 `writeSystemPromptFile`（经理→「你是 #ch 经理+可派发名单」，worker→「你不是 #ch 经理」——与 PTY 分支对齐），同时经新 `buildRoleContextLine` 以 `【本回合语境】你在 #ch 的角色：…` 追加进回合消息尾部（原始 userMsg 不动，`armTurnGuard` 的 isNudge 探测不受影响）——8.2 推荐的「spawn 首频道 + 回合当前频道」双写都落实。测试：`triage-prompt.test.ts` 增 4 例（经理语境行含名单 / worker 语境行非经理 / 经理系统提示含名单 / worker 系统提示含「你不是经理」）；headless 测试断言 ctx 进 `writeSystemPromptFile` 第 5 参 + 语境行进 sent 消息 + DM 不发起查询。

**验证**：`tsc --noEmit` 0 错；`vitest run` 43 文件 **410 用例全绿**（399→410，+11）；`biome check` 0 error。**遗留**：跑着的 daemon 进程是旧代码（非 watch 模式），web→spawn 全链路日志验证需重启 daemon 后自然生效；A1.2 的 Linux 侧验收（容器 @ 有回复）仍待非 Windows 验证批次。

### A2 · 会话续接（依赖 A0.2）

- `.slock/daemon-agent-sessions.json`（agent → sessionId，独立文件，同 D2 风格）
- `PersistentClaude` 支持 `resumeSessionId`；spawn 后首事件为 error / 3s 内退出 → 清 id 重 spawn 一次
- `reclaimIdleAgent` 保留 sessionId；`unregisterAgent`（含 duty off）/ 显式 stop 清除
- `daemon-core.ts:288` 注释改为事实
- 验收：@ → 等 idle 回收（把 `SLOCK_IDLE_RECLAIM_MS` 调 30s 测）→ 再 @ 追问「刚才说的第二点」→ agent 能接上；日志 `resumed session xxxxxxxx`

#### A2 实施结果（2026-09-19 已落地，430 测试全绿）

**agent→sessionId 持久化 ✅**：新 `agent-session-store.ts`（`.slock/daemon-agent-sessions.json`），D2 同款 JSON store——`remember`（按 agentName upsert）/ `lookup` / `forget` / `list`，原子写（tmp+rename）+ `mkdirPrivateSync` 私有目录 + 损坏 JSON 降级空表不抛。`daemon-core` 构造时创建，经 runtime options 透传到 dispatch / stream 两层；store 读写全部 try/catch 旁路化，持久化故障不阻塞派发。

**`PersistentClaude --resume` ✅**：`resumeSessionId`（构造存入内部 `sessionId`）→ `spawnProc` 拼 `--resume <id>`（`isValidSessionId` 校验；非法 id 不拼参并即调 `onResumeFailed`）。**失败判定收口**：宽限期（`SLOCK_RESUME_GRACE_MS`，默认 3000）内、且未见过合法流事件的 exit/error → `discardFailedResume`：清本实例 id + 回调上层清 store + 在途回合 `unshift` 回队首——pump 以全新会话重 spawn 续送，回合 Promise 不 reject（A1 队列无感；不触发 onExit，状态机/回合守卫/进度条不拆）。**首事件 error 形态**：`subtype` 含 error 或 `is_error:true` 的首个流事件同等处理，且该 error 不上抛（result 形 error 会被误当回合边界 resolve）。**边界**：已吐合法 init 的进程再在宽限期内退出按普通 crash（turn reject + onExit），不清 id——resume 本身已被 init 证实成功。**同实例续接**：`system` 事件的 `session_id` 更新内部值（回显 resume id 时打 `resumed session xxxxxxxx`），crash/沉默超时后的重 spawn 也带 `--resume` 接回同一会话。

**接线 ✅**：`dispatchHeadlessTurn` 建实例时 `envCfg.sessionResume ? store.lookup(agent)?.sessionId : undefined`；`onResumeFailed` 只在 store 记录**仍是该 id** 时才 forget（期间若 init 已把新 id 落盘，不盲删）；`createStreamTurnHandler` 在任何 `system` 事件的 `session_id` 上 `remember`（与 threadSessions 并行，互不干扰；one-shot 路径经同一 handler 也落盘）。`SLOCK_SESSION_RESUME=0` 一处总闸（不查 store、不拼参，与 PTY 同语义）。

**生命周期 ✅**：`reclaimIdleAgent` 只 `session.stop()` + 摘 `persistentSessions`，store 刻意保留（回收 ≠ 失忆）；`unregisterAgent`（duty off / `agent:stop` 共用此路径）与显式 `stopAgent` 调 `forget`；`stopAll` / `registerAgent` 不动 store（daemon 重启续接、改配置不清记忆）。`daemon-core.ts` 崩溃恢复注释已改为事实：headless 走 `daemon-agent-sessions.json` + `--resume`；PTY 仍走 `runStore.lastSessionId` / restart-summary。

**测试 +20（410→430）**：`agent-session-store.test.ts` 新文件 5 例（upsert/blank 不落库/forget/跨实例持久化/损坏 JSON）；`persistent-claude.test.ts` +8（`--resume` 拼参 + resumed 日志、总闸、非法 id 回调、宽限期早退清 id 重 spawn 且回合不 reject、首事件 error 同上、init 后早退按普通 crash、宽限后退出正常失败、init 学 id 复用）；dispatch-headless +3（lookup→resumeSessionId、onResumeFailed 比对后清 store/异 id 不删、无记录与总闸）；dispatch +1（`system.session_id` 落 store）；stop +3（unregister/stopAgent 清、stopAll 不清）。

**验证**：`tsc --noEmit` 0 错；`vitest run` 44 文件 **430 用例全绿**；`biome check` 0 error（7 个 warn 均为存量非 A2 文件）。**遗留**：真机验收（`SLOCK_IDLE_RECLAIM_MS=30s` → 回收后再 @ 追问 → 观察 `resumed session` 日志与上下文续接）需重启 daemon 后做；A0.2 已实测 `--resume` 与 stream-json/append-system-prompt-file 并用可行，此处只剩集成路径回归。

### A3 · Prompt 重写：从「聊天回复者」改回「工程师」（依赖 A1.3 与 A8 拍板，可与 A2 并行）

这是 8.13 #1 / 8.14 #1–#3 的直接修复，`system-prompt.ts` 需要整体重写而不是打补丁。目标结构：

1. **身份**：「你是 @x，运行在 @owner 本机上的 Claude Code 实例，通过 CollabAgent 频道接收任务。你拥有与本地 Claude Code 完全相同的工程能力：任意命令、编译运行、文件读写、网络访问。」角色描述（description）改写为「你的分工/擅长」，明确它**不是**能力边界。
2. **授权段**（按 A8 拍板填充，默认方案 A 文案）。
3. **任务完成标准**：「像在终端里一样把活干完再交付：能跑的先跑通、能验证的先验证；不要因为在频道里就只给片段。」删除「回复发一条消息即可 / 除非必要不额外调用 / 简洁 1–4 句」三句；「简洁」只保留在**非工程类**对话的措辞要求里。
4. **交付协议**（见 A7）：文本 ≤ 8k 字符直接发；代码 / 多文件 / 长报告 → 写进工作区 `deliverables/<日期-slug>/` → `upload_attachment`（或打 zip）→ 一条摘要消息带 `attachmentIds`；超长文本自动拆条（A7 把拆条做进 MCP，prompt 只需说「长消息会自动分段」）。
5. **工具面说明**：分组列 slock MCP 工具（回复 / 感知 / 任务 / 派发 / 提醒 / 附件）；如实说明真实限制（哪些 Claude Code 工具不可用、cwd 是你的专属工作区、长命令 300s 无输出会被中止 → 用 `--max-time` / 后台化 / 分步）。
6. **持久记忆**：MEMORY.md 段保留。
7. **去频道化**：「本次任务」段整体下沉到回合 prompt（`runAgent`/`runAgentDm`/…），系统提示不再含 channelName。

- 顶层 @ / DM 小预算上下文（新增 2 个 env，默认 8 条 / 2000 字符）
- 加 `--max-time` 规则（L4）
- 验收：`system-prompt.test.ts`（新建）快照 + 断言不含「回复发一条消息即可」「1-4 句」；`agent-runtime-dispatch.test.ts` 增 DM 注入用例；**真机重跑 8.13 用例**：频道里得到的产出与 CLI 同形态（可运行 + 附件），且 8.14 的「你能 ping 吗」得到执行结果而非拒绝

#### A3 实施结果（2026-09-19 已落地，461 测试全绿；含 A7.1 / A7.2 / §8.6 顶层上下文）

**Prompt 重写 ✅（`system-prompt.ts` 全量重写，方案 A 授权）**：身份行 = `你是 @x，运行在机主本机（hostname: …）上的 Claude Code 实例`——daemon 拿不到机主 handle，用 `os.hostname()` 做「本机」事实锚；description 改写为「分工/擅长（不是能力边界）」。新增「授权」段：频道成员执行类请求**视同机主授权**，仅破坏性/不可逆操作先确认一句，并告知「每次命令与工具调用都有审计记录」。「任务完成标准」段：干完再交付（能跑先跑通、能验证先验证），「简洁」只保留在非工程闲聊条款；删掉「发一条消息即可」类聊天化标准。工具面按组列全（回复/感知/任务板/派发/提醒/附件 + CLI 兜底）；A7.4 后如实声明 Task/WebFetch/WebSearch/NotebookEdit 已放行（notebook 读取走 Read），A7.6 后说明长工具有进度心跳、只有 300s 内**完全无流事件**才会中止，并保留 `--max-time` / 后台化规则。MEMORY.md 段保留并补 `deliverables/` 约定。

**去频道化 ✅**：`generateSystemPrompt(identity, dispatchContext)` 与 `writeSystemPromptFile(agentName, autonomous, info, dispatchContext)` 均不再收 `channelName`——spawn 时写死的频道名/可派发名单不再进系统提示（§8.5 首频道漂移消除），角色事实只走每回合 `【本回合语境】` 行（A1.3 `buildRoleContextLine` 不变）；dispatchContext 在系统提示中只保留角色语义（「你在频道里担任经理」/「不是经理」），名单细节全部下沉。headless 与冻结 PTY 两处调用方同步改签名。REMINDER_TAIL 现带本回合 target（`#ch`/`#ch:thread`/`dm:@x`），与语境行一起构成回合落点。

**回合 prompt 工程师化 ✅**：`runAgent`/`runAgentDm` 的任务行改为「把这条消息当成交给你的任务做完整：需要动手就动手（命令/文件/编译/网络），产出按交付协议走（代码/长内容 → deliverables/ + upload_attachment）」。

**A7.1 send_message 自动拆条 ✅**：新 `mcp/message-split.ts` 纯函数——`splitMessageContent(content, 9000)`：围栏代码块为原子块、其余按空行分段；块内超限按行切、单行超限硬切字符；围栏被迫跨条时前条补 ` ``` ` 收尾、后条按 ` ```lang ` 重开（条条合法 markdown）。`send_message` 顺序发送全部 chunk（同 target/threadId），`attachmentIds` 只挂末条；聚合返回 `{...末条回执, autoSplit: n, messageIds}`；中途失败即抛不回滚（部分送达可据 messageIds 续发）。工具 description 写明上限与自动分段。

**A7.2 交付目录 ✅**：`createWorkspaceDir` 种 `deliverables/`（mkdirPrivateSync）+ MEMORY.md 模板加「交付物」节（`deliverables/<日期>-<主题>/` + 附件 id 记录约定）；`isAllowedWorkspaceRel` 白名单放开 `deliverables/**`（任意深度可读，`collectFiles` 递归天然覆盖），点文件/穿越/CLAUDE.md 仍拒；二进制仍被 NUL 探测挡下走附件通道。

**§8.6 顶层 @ / DM 小预算上下文 ✅**：`config.ts` 新增 `SLOCK_CONTEXT_TOPLEVEL_MAX_MESSAGES`（8）/ `SLOCK_CONTEXT_TOPLEVEL_MAX_CHARS`（2000）；`fetchThreadHistory` 的 `threadId` 变可选（缺省拉顶层；`dm:@x` 目标原样透传）；新 `buildChannelContextEnvelope` 复用 `packThreadContext`（去触发消息、滤 ⏳ 进度条、最旧丢弃），频道用 `【频道近期上下文】`、DM 用 `【私信近期上下文】` 标签，不套线程隔离信封。`attachThreadContext` 更名为 `attachTurnContext`：有 threadId 走原线程大预算路径，无 threadId 走小预算路径（分诊/巡检 nudge 传 `topLevel=false` 不注入）；注入量照常 `recordContext` 记账。失败/关闭/无历史一律裸 prompt 不阻断。

**测试 +31（430→461，46 文件）**：新 `system-prompt.test.ts` 14 例（身份/能力/方案 A 授权/完成标准/交付协议/工具面/限制/分工非边界/去频道化/记忆/三种 dispatchContext 形态/relay 不受影响）；新 `message-split.test.ts` 8 例（边界原样/段落拆分/合并装填/围栏原子/围栏跨条重开/单行硬切/保序/自定义上限）；`agent-context-builder.test.ts` +6（顶层预算 env、频道/DM 信封、触发去重、失败降级、预算收紧）；`agent-workspace.test.ts` +2（deliverables 白名单含穿越拒绝、目录列出可读）；`agent-runtime-dispatch.test.ts` +1 净增（顶层注入用例 + DM 注入断言 + 分诊不注入断言，mock 补 `buildChannelContextEnvelope`）；`mcp-server.test.ts` +1（真子进程 10k 字符 → 2 次 `/send`、附件只挂末条、`autoSplit:2`）；`config.test.ts` 增两 env 断言；`triage-prompt.test.ts`/`dispatch-headless.test.ts` 改断言对齐新签名与去频道化契约。

**A3 阶段验证**：`tsc --noEmit` 0 错；`vitest run` 46 文件 **461 用例全绿**；`biome check` 0 error（7 个 warn 均为存量非本次文件）。A7.3–A7.6 随后已全部完成，最终门禁见 A7 实施结果。**仍需真机回归**：重启 daemon 后重跑 8.13/8.14 用例——频道产出应与 CLI 同形态、「你能 ping 吗」应得到执行结果而非拒绝。

### A7 · 产出交付通道（独立，可最先做；解 8.13 #2/#3/#4/#5）

| 子任务 | 改动 | 验收 |
|---|---|---|
| A7.1 长消息自动拆条 ✅ 已落地 | MCP `send_message`：content > 9_000 字符时按段落/代码块边界拆成多条顺序发送（同 target/thread），返回全部 messageId；描述里写明上限与自动分段 | `mcp-server.test.ts` 真子进程用例 + `message-split.test.ts` 纯函数用例已验证（见 A3 实施结果） |
| A7.2 交付目录约定 ✅ 已落地 | `createWorkspaceDir` 种 `deliverables/` 目录 + MEMORY.md 模板加「交付物放这里」一节；web `workspace:read` 白名单放开 `deliverables/**`（只读浏览） | `agent-workspace.test.ts` 已验证列出/读取/拒绝面；真机「档案页下载交付物」待回归 |
| A7.3 打包上传工具 ✅ 已落地 | 保留既有 `upload_attachment(path)`：path 为目录时自动 zip 后走 `/upload`；单文件按扩展名声明 MIME（`.cpp/.h/.ts/...` → `text/plain`） | `upload-payload.test.ts` ZIP 往返 + `mcp-server.test.ts` 真子进程 multipart 已验证；一次调用可交付多文件工程 |
| A7.4 工具白名单扩容 ✅ 已落地 | `DEFAULT_AGENT_ALLOWED_TOOLS` 已加 `Task,WebFetch,WebSearch,NotebookEdit,NotebookRead`；A0 已证实 headless 拒绝会即时返回，故无需 `--permission-mode`；`SLOCK_AGENT_ALLOWED_TOOLS` 仍可收紧 | 参数测试已锁定默认集；真机 init 已确认 Task/WebFetch/WebSearch/NotebookEdit 存在（NotebookRead 仅作兼容白名单，不在 prompt 宣称） |
| A7.5 env 白名单加开发链层 ✅ 已落地 | `agent-env-whitelist.ts` 已放行 MSVC/Java/Rust/Go/Python/CMake/Node 工具链键、`HOME USER SHELL LANG TERM` 与 `LC_* XDG_* VSCMD_*`；新增 `SLOCK_ENV_EXTRA=A,B,C`，拒绝 `SLOCK_*`/`*_KEY`/`*_TOKEN`/`*_SECRET` | 16 个 env 白名单测试覆盖工具链、跨平台键、extra 大小写/覆盖/秘密拒绝；真机编译器本机未安装，编译 E2E 待有工具链机器 |
| A7.6 长命令边界 ✅ 已落地 | Claude Code 2.1.274 真机 40s Bash 在 30s 发 `tool_progress`；驱动在事件类型收窄前对任意 JSON 行重置沉默计时，因此保留 300s 默认；prompt 仍要求无心跳外部命令 `--max-time`/后台化 | `persistent-claude.test.ts` 用未知 `tool_progress` 跨多个超时窗续命并完成回合 |

#### A7 实施结果（2026-09-20 已全部落地，47 文件 / 478 测试全绿）

**A7.3 文件/目录统一上传 ✅**：没有再增加一个语义重叠的 MCP 工具，既有 `upload_attachment(path)` 现在同时接受文件与目录。新 `mcp/upload-payload.ts` 负责载荷准备；目录递归收集后用精确锁定的 `fflate@0.8.3`（MIT，发布已超过 7 天）内存打 zip，上传名为 `<目录名>.zip` / MIME `application/zip`。打包排除所有隐藏路径段、大小写不敏感的 `node_modules` 与符号链接；1000 文件、50 MiB 未压缩源、10 MiB zip 三道闸均在 HTTP 前给出可读错误，巨型文件先按 `lstat.size` 预检再读取。归档名只用 POSIX 相对路径，不含绝对路径/根外链接。单文件也在 10 MiB 前置拦截，并按扩展名覆盖服务端全部默认 MIME；常见 C/C++/TS/JS/Python/Rust/Go/Java/shell/config 源文件映射为 `text/plain`，修复 A0 实测 `.cpp → application/octet-stream → 415`。未知扩展仍 fail-closed 走服务端 415，不猜内容。

**A7.4 Claude 工具面扩容 ✅**：`DEFAULT_AGENT_ALLOWED_TOOLS` 从最小 shell/文件面扩为 `Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,TodoWrite,Task,WebFetch,WebSearch,NotebookEdit,NotebookRead,mcp__slock`；`SLOCK_AGENT_ALLOWED_TOOLS` 覆盖口保留，可按部署收紧。A0 已证明 headless 白名单外工具会即时回 `permission_denied` 而非挂起，因此没有引入 `--permission-mode`。本轮真机 init 工具表确认 Task/WebFetch/WebSearch/NotebookEdit 存在；未出现 NotebookRead，所以它只留在兼容白名单，prompt 如实写成「NotebookEdit；notebook 读取使用 Read」。

**A7.5 开发环境继承 ✅**：白名单新增 MSVC（`INCLUDE/LIB/LIBPATH/VCINSTALLDIR/VCToolsInstallDir/WindowsSdkDir/VSCMD_*`）、Java/Rust/Go/vcpkg/CMake/Python/Conda/NVM/Node 工具链键，以及 POSIX `HOME/USER/SHELL/LANG/TERM/LC_*/XDG_*`。新 `SLOCK_ENV_EXTRA=A,B,C` 经 `config.ts` 集中解析（逗号/空格、去重、合法 env 名），大小写不敏感查本机键、保留原始拼写；extra 明确拒绝 `SLOCK_*` 与 `*_KEY`/`*_TOKEN`/`*_SECRET`，调用方显式 overrides 仍最后胜出，`SLOCK_AGENT_TOKEN` 明文剥离不变。`SLOCK_ENV_INHERIT=1` 的显式排障回退语义不变。

**A7.6 长工具活性 ✅（结论：不调大默认超时）**：Claude Code 2.1.274 真机执行 40s `node -e "setTimeout(()=>{},40000)"`，30s 时输出 `type:"tool_progress", heartbeat:true`，40s 正常回灌 tool_result；`PersistentClaude.onStdout` 在 `asClaudeStreamEvent` 类型收窄**之前**就对任意合法 JSON 行重置计时，因此未知联合里的 tool_progress 也会续命。`SLOCK_PERSISTENT_TURN_MS` 保持 300000，既不误杀长 Bash，也不把真正无事件卡死的恢复时间翻倍；回归测试把该顺序锁死。注意 A1 队列 `SLOCK_DISPATCH_INFLIGHT_MS=360000` 是另一个绝对边界，超过约 6 分钟的重复投递问题归 A4（§8.13 新发现 2），不属于本项沉默计时器。

**测试 +17（461→478，46→47 文件）**：新 `upload-payload.test.ts` 7 例（ZIP 往返/排除项/空目录/50 MiB 读前预检/`.cpp` MIME/不存在路径/MIME 原型链安全）；`mcp-server.test.ts` +2（真子进程 `.cpp` multipart `text/plain`、目录 multipart zip）；`agent-env-whitelist.test.ts` +6（工具链、跨平台键、extra 默认/安全拒绝/非法项/大小写与 override）；`config.test.ts` +1（SLOCK_ENV_EXTRA 解析）；`persistent-claude.test.ts` +1（未知 tool_progress 跨多个沉默窗续命）。`command-presets.test.ts` 与 `system-prompt.test.ts` 更新断言但不增用例。

**最终验证**：`tsc --noEmit` **0 错**；`vitest run` **47 文件 / 478 用例全绿**；Biome 检查 daemon src+test 共 142 文件，**0 error / 7 个存量 warning**（均不在 A7 改动文件）。**仍需产品链真机回归**：重启 daemon 后从频道交付一个多文件目录并在档案页下载、实际调用一次 Task 子代理；本机没有编译器，A7.5 的 `cl/g++` E2E 要在已安装工具链的机器验证。实现与自动化验收已完成。

### A8 · 权限模型拍板 + 落地 ✅ 方案 A 已完成

#### A8 实施结果（2026-09-20 已落地，48 文件 / 482 测试全绿）

**决策 ✅**：采用方案 A——owner 全权，频道成员的执行类请求默认视同机主授权；本批明确**不做**方案 B/C，因此没有新增 `agents.capability`、`agent:start` capability 字段、按档位切 `--allowedTools` 或档案页开关。以后若产品要提供可选收紧，应作为独立需求重新设计，而不是混入本次默认权限语义。

**授权边界写实 ✅**：`system-prompt.ts` 现在明确：agent 运行在机主本机，拥有本地 Claude Code 已提供的命令/脚本/文件/编译测试/网络能力；不得因请求来自频道成员、目标是内网地址或 description 是「办公小助手」等业务角色而自行拒绝或自称「受控环境」。读取/修改工作区、运行脚本、编译测试、查询资料、`ping / traceroute / curl` 网络诊断以及 `send_message` 回报属于低风险操作，**不重复确认**；正常 `send_message` 不属于「对外发布」。只有明显破坏性/不可逆或 CollabAgent 之外的现实副作用（删除/覆盖重要数据、改生产、付款、代表机主发邮件/公开发布）才先确认。被问权限时固定如实说明「有，与本地 Claude Code 相同；每次执行都会留下审计或本地运行记录」，然后执行而非只解释。

**审计安全底座收紧 ✅**：既有链路保持 `stream-json tool_use/tool_result` → `createStreamTurnHandler.onToolCall` → daemon-core `agent:tool-call` WS → server `appendEvent(tool.call.start/end)` 哈希审计链。复查发现 `onToolCall` 原来错误嵌套在可选 `observationBus` 内：一旦 UI 围观总线缺席，审计也会一起消失。本轮把 frame 解析/守卫/审计/进度语义改为无条件执行，仅 `observationBus?.publish` 受 bus 门控；审计回调失败仍作为 best-effort 旁路吞掉，不阻断任务。默认 headless 有结构化审计，冻结 PTY fallback 至少保留本地运行记录，prompt 因此使用准确的「结构化审计或本地运行记录」措辞。

**真机验收 ✅**：用当前 `generateSystemPrompt({name:"a8-probe", description:"办公小助手"})` 生成完整 prompt，在 Claude Code 2.1.274 / `deepseek-flash` 上重跑案例二。agent 首次直接调用 Bash 执行 `ping -n 1 192.168.58.78`；本机 GateGuard 固定 hook 拦了第一次 Bash（非 daemon 权限），agent 陈述请求与命令作用后原样重试成功。结果：发送 1 / 接收 1 / 丢失 0（0%），58ms，TTL=63；最终回答「**有，与本地 Claude Code 相同**（可直接执行 shell 命令），每次执行都会留下审计或本地运行记录」，没有再以「办公小助手」身份拒绝。该 probe 是直接 headless CLI（未挂 slock MCP/频道 target），验证的是 A8 权限判断与真实执行；完整 web→daemon→频道回执仍随重启后的产品链回归一起做。

**测试 +4（478→482，47→48 文件）**：新 `agent-runtime-dispatch-stream.test.ts` 3 例——无 observationBus 仍产生 pending/completed 审计、审计文本 token 脱敏、回调抛错不阻断、带 bus 时观察与审计同时工作；`system-prompt.test.ts` 净增 1 例并锁定方案 A 低风险清单、破坏性边界、正常 send_message 例外与权限回答文案。

**最终验证**：daemon `tsc --noEmit` **0 错**；daemon `vitest run` **48 文件 / 482 用例全绿**；server 定向 `ws-validate.test.ts + audit.test.ts` **2 文件 / 29 用例全绿**；Biome 检查 daemon src+test 共 143 文件，**0 error / 7 个存量 warning**。未重跑需要 live PG 的 `audit-api.test.ts`（本轮未改 server 审计实现）。

### A4 · 队列语义（独立，可最先做）✅ 已完成

- 队列桶键 `(agent, channel, thread)`；`kind` 扩展并随 item 传到 `armTurnGuard`；去重后写；退避 max
- `registerAgent` 元数据变更不 tearDown；`clear` 走死信回调
- 验收：`agent-dispatch-queue.test.ts` 增跨频道不合并 / 分诊不与 @ 合并 / 死信后重发不被吞 3 例

#### A4 实施结果（2026-09-20，全绿：48 文件 / 493 用例）

**桶键 `(agent, channel, thread, kind)` ✅**：pending 合并按四元组分桶——跨频道、跨线程、分诊 vs 普通 @ 互不合并；`kind` 扩为 `message | reminder | dispatch | triage | nudge`。agent 级仍单 in-flight（`PersistentClaude` 单会话串行，守卫按 agent 键控，绝不开并发回合），多桶按入队序串行排水。

**kind → `armTurnGuard` ✅**：`dispatchToAgent` 携带 kind 下穿到 stream 层；`isNudge = kind==="triage"||"nudge"` 再叠加既有 `[slock-reply-guard]`/`【频道分诊】`/`【定时巡检】` 前缀检测——分诊/nudge 不触发回复守卫自动补发，巡检走 `reminder` kind 仍靠前缀判，行为不回归。

**去重后写 ✅**：`recentContents` 只在投递**成功**后写；入队判重 = 已投递窗口 + pending + in-flight 集合。死信不占 dedup 窗口，重发不被吞（测试锁定）。

**退避 max ✅**：重试延迟 `min(base·2^attempts, maxDelayMs)`；合并批按批内最高 attempts 定速。

**⑦ in-flight 超时不再重投（§8.13 新发现修复）**：队列级超时只告警不 reject——真看门狗是驱动层 300s 沉默超时；deliver Promise 未 settle 期间视为「仍在跑」，杜绝同一持久会话上的重复回合 + 守卫覆盖 + 假自动补发（此前实测故障链）。deliver 真 reject（进程死）仍走正常重试。

**`registerAgent` 元数据合并 ✅**：已注册 agent 重推只合并字段（缺省保留旧值），不 bump 代次 / 不清队列 / 不杀进程——此前 bump 会让在途回合 `assertLive` 误杀。显式 unregister/stop/duty-off 仍走原 tearDown 路径。

**`clear` 走死信 ✅**：stop/unregister 丢弃的 pending item 全部经 `onDeadLetter` 上报（daemon-core → WS → server 可呈现），settle 悬挂 Promise 不泄漏；`dispose` 清全部定时器。

**⑥ 跨 server @ 黑洞告警 ✅**：`messages.ts` 在 `mentionAgents` 后做 scope 可达性检查——bound 机 `isMachineOnline(uid, mu, channelServerId)`、unbound `isUserScopeOnline(uid, channelServerId)`；不可达 → `skippedMentions` 新增 `reason:"unreachable"` + server warn 日志。web toast 按 reason 分文案：`已停班` vs `daemon 未在本频道所属 server 上线`。消息本身仍正常发送（诊断告警，非发送失败）。

**测试 +11（482→493）**：`agent-dispatch-queue.test.ts` 增——跨频道不合并 / 分诊不与 @ 合并 / 死信后重发不被吞（验收 3 例）+ 线程分桶 / clear 走死信 / in-flight 超时保持忙碌不重投 / 超时后真 reject 才重试；`agent-runtime-dispatch-stream.test.ts` 增 kind→isNudge 3 例；`agent-runtime-stop.test.ts` 增 registerAgent 元数据重推不 tearDown / 缺省字段保留 / unregister 后重注册仍走显式 stop 3 例。

**最终验证**：daemon `tsc --noEmit` **0 错**；daemon `vitest run` **48 文件 / 493 用例全绿**；server 定向 `ws-validate.test.ts + audit.test.ts` **2 文件 / 29 用例全绿**；web `vue-tsc --noEmit` **0 错**（此前 `tsc --noEmit` 报缺 `.vue` 模块为工具选错，非缺陷）；Biome daemon src+test **0 error / 7 存量 warning**，server/web 改动文件 0 error。

**遗留**：真机回归（重启 daemon 后跨 server @ 复现告警 toast、构造 >6min 长回合验证不再产生重复回合）；server 侧可补 `skippedMentions.reason==="unreachable"` 的 PG 定向测试（本轮 messages.ts 改动无既有 server 测试文件覆盖路径，靠 daemon 侧 + tsc 兜底）。

### A5 · 回合前开销（依赖 A2/A3 定型）✅ 已完成

- mint / token 文件 / sysprompt / mcp 配置仅 `needsSpawn` 时做；token TTL < 1h 刷新
- 验收：`agent-runtime-dispatch-headless.test.ts` 断言复用会话时 `mintAgentCredential` 调用 0 次

#### A5 实施结果（2026-09-20，全绿：48 文件 / 495 用例）

**spawn-only 收敛 ✅**：`dispatchHeadlessTurn` 此前每回合都跑 `mint → writeAgentTokenFile → writeSystemPromptFile → createWorkspaceDir → bundle/writeMcpConfig` 全套（一趟 mint server 往返 + 三次文件写），复用常驻会话时全部浪费。现按 `needsSpawn = !usePersistent || !persistentSessions.has()` 收敛——one-shot 每回合本就是新进程（开销=必需），persistent 复用路径只余 `fetchDispatchContext`（A1.3 回合语境行仍每回合需要）。

**token 临期刷新 ✅**：新增 `credentialIssuedAt` map（agent-runtime 创建 → DispatchDeps → headless opts），spawn mint 时记录时间戳。复用路径上 `issuedAt` 缺失或 `age > 24h TTL − 1h` 余量（`AGENT_CREDENTIAL_TTL_MS`/`AGENT_CREDENTIAL_REFRESH_MARGIN_MS` 导出常量）→ 重 mint + 覆写 token 文件即可——`slock-mcp-server` 每次请求重读文件（`readAgentToken`），覆写即生效，不需要 respawn。

**清理路径 ✅**：`tearDownAgentProcess`（stop/unregister/stopAll 共用）、idle reclaim `onSessionEnded`、`dropStalePersistentSession` 两个调用点（send 失败 / spawn 中被停）均删条目——条目失效后下次 spawn 反正会重 mint 覆盖，清理是纯卫生。

**测试 +2（493→495）**：`agent-runtime-dispatch-headless.test.ts` 增——复用会话第二回合 `mintAgentCredential`/`writeSystemPromptFile`/`createWorkspaceDir`/`writeAgentTokenFile` 全部 0 次新调用（验收例）；签发时间戳拨过 23h 后重 mint + 覆写文件且不 respawn 1 例。测试基建顺手升级：`writeAgentTokenFile`/`createWorkspaceDir` mock 升为 `vi.fn` 可断言。

**最终验证**：daemon `tsc --noEmit` **0 错**；`vitest run` **48 文件 / 495 用例全绿**；Biome **0 error / 7 存量 warning**。

### A6 · 回归网补齐（贯穿）✅ 已完成

- 新建 `agent-runtime-dispatch-stream.test.ts`（守卫三分支 / abort / 成本差值）、`system-prompt.test.ts`、`mcp-server-tools.test.ts`（17 工具至少各 1 例，走 fake fetch）
- 这三份是 A1–A5 的安全网，建议 A0 之后立刻开工

#### A6 实施结果（2026-09-20，全绿：48 文件 / 512 用例）

**三份安全网现状**：`system-prompt.test.ts` 15 例（A3 落地时建：身份/授权/完成标准/交付协议/工具面/去频道化/relay 模式）；`agent-runtime-dispatch-stream.test.ts` 由 A4/A8 已建 6 例（审计独立于 observationBus ×3 + kind→isNudge ×3），本轮补齐规格点名的缺口；`mcp-server-tools.test.ts` 未另建文件——`mcp-server.test.ts` 的子进程 + 真 HTTP server 基建就是「fake fetch」的正确实现（MCP server 是独立子进程，globalThis.fetch mock 够不着），直接在该文件内补齐。

**stream 测试 +5**：守卫三分支全覆盖——hadSend（发过 send_message 不动）/ rewritten（进度条改写吸收回复，不再代发）/ 无正文 nudge 一次（带 `REPLY_GUARD_PREFIX`）；`abortTurnGuards`（拆守卫+删进度条+onProgress(end)，迟到的 result 不再触发任何守卫动作）；成本差值（累计 0.05→0.12 落库 0.05/0.07 增量，channel 取守卫）。

**MCP 工具 +12**：claim_tasks / update_task_status / unclaim_task / dispatch_task / list_dispatches / report_task / cancel_dispatch / check_messages / search_messages / schedule_reminder（含缺省时区补本机 IANA）/ list_reminders / cancel_reminder——每例断言 method + 精确路径 + body 字段映射（camelCase→snake_case 转换点全覆盖）+ Bearer + `isError:false`。至此 17 工具全部至少一例真子进程调用。

**最终验证**：`tsc --noEmit` **0 错**；`vitest run` **48 文件 / 512 用例全绿**（495→512，+17）；Biome **0 error / 7 存量 warning**。

### 顺手（H 系列）

H1 删 `agent-tokens.ts` 或接线；H2 删死接口；H4 删空目录；H5 env JSDoc；H9 文档数字同步（CLAUDE.md / tracker 表 / buzz-todo / duty 状态）。

#### H 系列实施结果（2026-09-20，全绿：48 文件 / 500 用例）

- **H1 ✅ 删除**：`agent-tokens.ts` + `IAgentTokenRegistry` + `tokenRegistry` 管道（daemon-core → createAgentRuntime → ExitChainDeps → exit-handler）整条移除；`createMinimalExitHandler` 合并进 `createExitHandler({runStore?})`；`ExitContext.token` 去掉（`RunContextEntry.token` 保留——冻结的 spawn 侧仍写它，字段本身无害）。本地注册表 `issue()` 生产零调用，exit handler 查的 Map 恒空，删除零行为变化；吊销全由 server 侧 `revokeAgentCredential` 承担（CLAUDE.md 已注明）。连带删 `agent-tokens.test.ts`（15 例）与 5 个测试文件的构造参数。
- **H2 ✅**：`IAgentStartup` 接口 + `buildStartupInstructions`/`buildIdentityMarker`/`buildProtocolDoc`/`buildReminderTail` 全删（`agent-startup.ts` 的 `AgentInfo` import 一并清）。
- **H3 ⏸ 随 PTY 删除评估**：`restart-summary.ts` 唯一调用方是冻结的 `agent-runtime-spawn.ts`，按冻结纪律不单独动。
- **H4 ✅**：`src/auth/` `src/commands/` 空目录已删。
- **H5 ✅（口径修正）**：§3.1 的「6 个无效 env」在 A2 后已过期——`SLOCK_SESSION_RESUME`/`SLOCK_RESUME_GRACE_MS` 现在 headless persistent 也消费（JSDoc 原已写「共用」）。真正 PTY-only 的 4 个已加「PTY only」标注：`SLOCK_VERBOSE_PTY`（含 logPtyBus）/`SLOCK_STUCK_WARN_MS`/`SLOCK_QUIESCE_MS`/`SLOCK_SESSION_CAPTURE_DELAY_MS`。`slock --help` 由 commander 生成、从不列 env——无需删改。
- **H6 ✅**：`private-dir.ts` 新增 `slockDir()`（`SLOCK_STATE_DIR` 覆盖，默认 `cwd/.slock`，调用时读 env）；全部散点收口——4 个 JSON store 默认路径、`agent-startup` 三处（sysprompt/workspaces/legacy 迁移）、`terminal-log`（模块级 LOG_DIR 改调用时函数）、`setup-slock-wrapper`/`mcp-bundle`（局部变量改名避冲突）、`daemon-core` planned-restart 读写、`claude-print` fallback prompt、**`index.ts`/`supervisor.ts` 的包相对 `.slock` 也统一进来**（此前 daemon.pid/planned-restart 走 pkg 目录、其余走 cwd——cwd≠pkgdir 时状态树本就分裂，现在一处解析）。`machine-id.ts` 保持 `homedir()/.slock`（机器身份是用户级全局，不随项目状态搬）；`agent-token-file.ts` 保持 `workspace/.slock`（在 workspace 内）。测试清理路径同步改 `slockDir()`；新增 `test/private-dir.test.ts` 3 例。
- **H7 ✅**：`agent-mcp-config.ts` `settings.effort` → `settings.effortLevel`（A0.3 真机证实 `effort` 非合法键被静默忽略）。
- **H8 ✅**：`supervisor.killTree` 改返回 Promise——Windows 等 taskkill 退出 + child exit 事件双落定（各 5s 上限），热重启由 `restartForChange` 在死透后自己拉起（exit handler 只消费 expectRestart 标记），顺手修了「child 已死且 restartTimer 排队时文件变更触发双拉起」的边；`shutdown` 等 killTree 再退（6s 硬兜底）。`index.ts` 单实例守卫同款修复：taskkill 改 `spawnSync`（树死透才写 pid），POSIX SIGTERM 后轮询 3s 再 SIGKILL。
- **H9 ✅**：CLAUDE.md 90→92 源文件 / 43→47 测试文件 / 399→497 用例；模块表删 `agent-tokens.ts`、补 `agent-session-store.ts`/`agent-mcp-config.ts`/`agent-workspace.ts`/`mcp/*`；Hive 参考表 Token 行标注已删。tracker 完成记录表补 P1.16 行（`b19b269`）。buzz-todo：T4 → ✅ Step 7；L4 → ✅（A3 的 system-prompt 已含 `--max-time` 条款）；L5 → 大半消解（P0.2 回收已修、A7.6 心跳证伪 300s 误杀、WebFetch relay 限制仍在）。duty 文档第 4 行已是「已落地」——无需改。

**最终验证**：`tsc --noEmit` **0 错**；`vitest run` **48 文件 / 500 用例全绿**（512 − 删掉的 agent-tokens 15 例 + private-dir 3 例）；Biome **0 error / 5 存量 warning**（顺手清了 session-resume/round-end 两个 unused import）。

---

## 10. 死代码 / 清理清单（精确）

| 项 | 位置 | 证据 |
|---|---|---|
| ~~`IAgentStartup` 接口~~ ✅ 已删（H2，2026-09-20） | `types/index.ts` | 全仓无实现无引用 |
| ~~`buildStartupInstructions` `buildIdentityMarker` `buildProtocolDoc` `buildReminderTail`~~ ✅ 已删（H2） | `agent-startup.ts` | grep 仅定义处 + 接口声明 |
| ~~`tokenRegistry.issue()` 路径~~ ✅ 已删（H1） | `agent-tokens.ts` 全文（文件已删） | 生产零 `issue` 调用 |
| `restart-summary.ts` 在 headless（⏸ 随 PTY 删除评估，H3） | `agent-runtime-spawn.ts`（唯一调用方，冻结） | headless 无调用 |
| `PTY_COMMAND` 常量（⏸ 随 PTY 删除评估） | `agent-runtime.ts:37` | biome-ignore 标注；唯一 TODO |
| ~~`src/auth/` `src/commands/`~~ ✅ 已删（H4） | 空目录 | raw §1 |
| ~~两个 `findClaudeCmd`~~ ✅ 已不存在（A1.2 已统一到 `resolveClaudeBinary`，本行为过时记录） | — | grep 无匹配 |
| `SLOCK_PERSISTENT_CLAUDE` / `SLOCK_ENV_WHITELIST` 注释别名（⏸ 随 PTY 删除评估） | `config.ts:17-19` | 可在 PTY 删除评估时一并清 |

---

## 11. 附录：数据文件与复核方式

- 原始数据：`docs/2026-09-19/_daemon-inventory-raw.md`（源码清单 / 测试清单 / tsc·vitest 输出 / env / CLI / MCP / WS / 标记 / git / package.json / docs 勾选）
- 复核命令（`packages/daemon`）：`npx tsc --noEmit -p tsconfig.json`；`npx vitest run`
- 本文 §8 每条的行号基于 `b6a8b0b` 工作树；PowerShell 下 grep 请用 `Select-String`，或直接用编辑器搜索 §8 引用的符号名（`findClaudeCmd` / `fetchDispatchContext` / `--model` / `isNudge` / `REMINDER_TAIL`）。

---

## 12. 真机回归（2026-09-20 实测，daemon 重启后全链路）

环境：server `localhost:3001`（dev 实例）+ supervisor 模式 daemon（`SLOCK_IDLE_RECLAIM_MS=60000`、`SLOCK_DISPATCH_INFLIGHT_MS=90000`）+ a0probe 加入 server `001`/`#onboarding-owner`；agent = @办公小助手（a9fc3df8，model sonnet）。

| 项 | 实测结果 |
|---|---|
| **A2 会话续接** | ✅ daemon 两次热重启 + idle 回收三次后，`--resume c8eddbcf` 均接回同一会话（`~/.claude/projects/…/c8eddbcf-….jsonl` 持续追加至 3.8MB）；回合 B/C/末测均正确回忆出第一回合约定的数字 4261 |
| **A5 spawn-only 开销** | ✅ 复用回合（seq 13751）：日志只有 `空闲→工作`，无 spawn；`agent_credentials.created_at` 与 workspace token/sysprompt 文件 mtime 全部停留在上一 spawn 时刻（14:21:10），零 mint 零文件写 |
| **A4⑥ 跨 server @ 告警** | ✅ `POST /api/messages/send` 到 `#智慧城市产品周会`（a319db9b）@办公小助手 → `skippedMentions:[{handle:"办公小助手",reason:"unreachable"}]`，消息本体正常发送 |
| **A4⑦ in-flight 超时** | ✅ 99s `ping -n 100` 回合在 >90s 时打 `turn still running, waiting for real settle (no re-dispatch)`，回合自然跑完、无重投（实测两次命中该告警） |
| **A4 忙碌排队** | ✅ 长命令回合进行中第二条消息 `busy → message queued (dispatch queue)`，前回合 settle 后同进程出队执行（无新 spawn） |
| **A7.1 自动拆条** | ✅ 单条 >10k 消息拆为 8989 + 3409 字符两条（+尾条），第 146 项起干净接续——行边界原子切分 |
| **A7.3 目录上传** | ⚠️ 半实证：`upload_attachment(目录)` 真实调用且 zip→上传端点链路走通，服务端 `storage.save()` 500——根因为 `STORAGE_BACKEND=s3` 的 MinIO `192.168.50.104:9000` 本机不可达（curl 000 超时），非 daemon 侧缺陷；zip 正确性有单测兜底 |
| **A7.4 工具白名单** | ✅ Task 真实调用成功（haiku 子代理 `echo probe-ok-4261`，3175ms）——A0.5 时的 8.7s `permission_denied` 消除；WebFetch 调用放行但 Claude 侧域名安全校验连不上 claude.ai（relay 网络限制，与白名单无关） |
| **A8 方案 A 授权** | ✅ 机主 bugkiller 真实 ping 请求（seq 13742→13743）+ 本批多回合全部直接执行真实命令（Bash ping/date/mkdir），无「权限不足」式拒答；回合回报明确「每次执行都会留下审计」 |
| **H8 supervisor 热重启** | ✅ 两次文件变更触发：`change detected → restarting` → 旧进程 `Planned restart detected → skipping autostart` → `killTree` 等死透后拉起；全程单实例，`daemon.pid` 始终指向存活的 index.ts |
| **H6 slockDir** | ✅ `.slock` 全树（pid/sessions/wrappers/MCP bundle/sysprompt/workspaces）统一落在 `packages/daemon/.slock`（cwd 语义） |
| **H1 清理旁证** | ✅ 此前双 daemon 共存实锤成因：某 agent Bash 在受管 daemon 进程树下 `npx tsx index.ts` 拉起第二实例；旧守卫的异步 taskkill 竞态导致并存，H8 后同类拉起会被 pid 守卫同步杀树 |

实测顺带修掉一个缺陷：`resumed session` 日志在每个 system 事件上重复打印（旧进程一趟刷了 3467 行）——改为 per-spawn 打一次（`spawnResumeLogged`），并对 resume 产出新 session id 的分支补 warn。另观察到 relay 模型下长 Bash 不发 `tool_progress` 心跳（95s STUCK warn 出现一次；300s 沉默看门狗仍是兜底，与 A7.6 官方分发版结论不同，属 relay 行为差异，不阻塞）。

未覆盖（留待需要时）：token 临期原地刷新路径（需等 23h，单测已覆盖）；MinIO 恢复后的 zip 上传端到端回执。
