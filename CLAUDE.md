# Slock Daemon — 仓库工作指南

## 项目定位

AI-native team collaboration platform. The daemon (`packages/daemon/`) is a local Node.js
process that connects to the Slock server via WebSocket, spawns Claude Code subprocesses as
AI agents, and routes messages between them.

## 当前状态（2026-08-20 核查）

**已非早期单体**：`packages/daemon/src/` 50 个源文件 + `test/` 23 个测试文件。
2026-07-15 路线图（26 项）与 2026-08-18 计划（A1/A2/B1/C1/B2/C2 等）**已全部落地**
（存档：`.claude/goal-progress.json`，currentTask = ALL-DONE）。

核心架构事实：

- **headless 为默认**（2026-08-18 起）：`drivers/persistent-claude.ts` 常驻进程 +
  `--input-format/--output-format stream-json`，`result` 事件 = 精确回合边界，
  回合级 Promise + 沉默超时（300s）卡死保护。`SLOCK_ONESHOT_CLAUDE=1` 退到 one-shot。
- **PTY 是冻结保留的兜底**（2026-08-20 Step 3）：`SLOCK_USE_PTY=1` 启用（调试/回退用），
  启用时启动日志打 legacy 警告；代码❄️冻结不删（headless 未过长期验证），
  删除评估 2026-09 底，见 tracker Step 3。
- **A1 派发队列**：`agent-dispatch-queue.ts` 串行派发 + 指数退避重试 + 死信上报 +
  15s 去重 + 忙碌合并。
- **安全**：scoped runtime token（`agent-tokens.ts` + `agent-token-file.ts` 0600）、
  `--allowedTools` 白名单 fail-closed（`command-presets.ts`）、env 白名单默认开启（A2 / P0.4；`SLOCK_ENV_INHERIT=1` 排障回退）。
- **状态机**：`agent-runtime-state.ts` 五态（uninit/idle/starting/working/stopped）。
- **观察**：stream-json 事件 → `agent-observation.ts` 观察帧 → WS 进 web 面板；
  tool_call 经 C1 进审计流。
- **成本记账（D3，2026-08-20 Step 4；P0.5 2026-08-25）**：`agent-cost-tracker.ts` 按
  (agent, channel, UTC day) 累计；`result.total_cost_usd` 是会话累计，落库前做
  「本次 − 上次」差值（`createSessionCostDelta`）；`SLOCK_COST_BUDGET_USD` 超限 →
  A1 拒投 + 频道熔断消息；`slock cost show` 查近 7 天。
- **Context Builder（D1，2026-08-21 Step 6）**：线程追问入队前拉该线程历史并截断注入；
  顶层 @ / DM / 巡检不注入。D2 本批仅 prompt 隔离 + `daemon-thread-sessions.json`
  （不拆 (agent, thread) 进程池）。
- **观察帧产品化（T4/D4，2026-08-21 Step 7）**：stream-json 帧聚合成人类可读进度；
  频道内一条 ⏳ 消息节流原地更新（结束删/改写）；顶栏 `agent:progress`；
  `SLOCK_CHANNEL_PROGRESS=0` 关频道进度。
- **Agent 回话通道**：`mcp/slock-mcp-server.ts`（agent 经 MCP 工具调 server API 发消息/
  派单/读历史），`mcp-bundle.ts` 随运行时注入。

模块速查（`packages/daemon/src/`）：

| 分组 | 文件 |
|------|------|
| 入口 | `index.ts` / `cli.ts`（薄入口）+ `cli/*.ts`（按域） / `daemon-core.ts`（WS + auth）+ `handlers/*`（消息路由） / `config.ts`（P1.10：`SLOCK_*` 统一读取） |
| 运行时编排 | `agent-runtime.ts`（核心）+ `agent-runtime-dispatch.ts`（工厂）+ `agent-runtime-dispatch-{pty,headless,stream}.ts` + `-spawn/-exit/-state/-credentials/-turn-tracker/-terms-dialog.ts` |
| 驱动 | `drivers/persistent-claude.ts`（默认）/ `claude-print.ts`（one-shot）/ `drivers/probe.ts` |
| 队列与生命周期 | `agent-dispatch-queue.ts` / `live-run-registry.ts` / `agent-run-store.ts` / `agent-cost-tracker.ts`（D3） / `agent-context-builder.ts`（D1） / `agent-thread-sessions.ts`（D2） / `agent-progress.ts`（D4 进度条） / `idle-reclaimer.ts` / `supervisor.ts` |
| 安全 | `agent-tokens.ts` / `agent-token-file.ts` / `agent-env-whitelist.ts` / `command-presets.ts` / `command-resolver.ts` / `auth.ts` |
| 启动与提示 | `agent-startup.ts` / `system-prompt.ts` / `setup-slock-wrapper.ts` / `restart-summary.ts` |
| PTY 兜底（❄️冻结保留） | `agent-manager.ts` / `agent-manager-support.ts` / `post-start-input-writer.ts` / `pty-output-bus.ts` / `terminal-state.ts` / `terminal-log.ts`* |
| 会话 | `agent-sessions.ts`（sessionId 捕获/恢复）/ `agent-dir-name.ts` |
| 其他 | `client.ts` / `proxy.ts` / `exit-coordinator.ts` / `exit-handler.ts` / `output.ts` / `types/index.ts` |

\* `terminal-log.ts` 为共享文件（headless 的 `terminal:history` 也用它读落盘日志），不在冻结范围。
P0.7（2026-08-25）解耦：`agent-manager-lazy.ts` 把真实 PTY manager 推迟到首次 spawn 才动态
import（headless 全程不加载 node-pty）；`agent-runtime-spawn.ts` 已纯化为全冻结（`writeMcpConfig`
迁出到非冻结的 `agent-mcp-config.ts`，headless/PTY 共用）。

## 当前执行跟踪

**推进状态以 `docs/2026-08-20/02-daemon-evolution-tracker.md` 为准**（当前焦点 + 勾选清单）。
方案依据：`docs/2026-08-20/01-daemon-evolution-plan.md`（还债批 P0 + 扩建批 D1~D7）。

常用验证命令：

```
npx tsc --noEmit -p packages/daemon/tsconfig.json
pnpm vitest run          # packages/daemon 测试（test/ 33 文件）
```

## 历史档案（已完结，勿再按此工作）

- **原 Goal Mode 协议已完结**：2026-07-15 启动的自主重构目标已全部完成
  （goal-progress.json：41 项 done / 0 pending / ALL-DONE）。原协议中的
  ScheduleWakeup/SendMessage 工作流不再适用。
- `docs/2026-07-15/01-current-state-inventory.md` 描述的是重构前单体时代，
  已被 2026-08-20 核查取代（文首有归档标注），仅作历史参照。

## 设计文档索引

近期（有效）：

| 文档 | 用途 |
|------|------|
| `docs/2026-08-23/01-member-profile-design.md` | 成员档案（Human/Agent 一等公民；P0 已落地） |
| `docs/2026-08-23/02-computer-onboarding-design.md.md` | Computer 一等公民（P0 已落地：一人一机 /computers） |
| `docs/2026-08-23/04-admin-agent-ia-split.md` | Admin Agent IA 拆分（Step A/B 已落地：创建在计算机，配置/巡检/删除在档案） |
| `docs/2026-08-23/05-agent-duty-design.md` | Agent 值班（duty on/off；意愿与进程分层；审查中） |
| `docs/2026-08-22/01-web-two-column-sidebar-design.md` | Web 侧栏两列化（rail + 可折叠 pane；图标进独立主区页） |
| `docs/2026-08-22/02-raft-ui-visual-alignment.md` | ~~Raft 视觉对齐~~ **已废弃**（不仿 Raft UI） |
| `docs/2026-08-21/01-d1-d2-context-session-design.md` | Step 6 D1/D2 设计（prompt 隔离，线程追问） |
| `docs/2026-08-21/02-t4-observation-product-design.md` | Step 7 T4/D4 观察帧产品化 |
| `docs/2026-08-20/01-daemon-evolution-plan.md` | daemon 演进方案（还债+扩建） |
| `docs/2026-08-20/02-daemon-evolution-tracker.md` | **执行跟踪（以此为准）** |
| `docs/2026-08-19/01-buzz-borrowing-todo.md` | 产品能力 backlog（T1~T8 + L1~L5） |
| `docs/2026-08-19/02-t2-agent-patrol-design.md` | T2 agent 巡检设计（已落地） |
| `docs/2026-08-19/03-t8-manager-triage-design.md` | T8 经理分诊设计 |
| `docs/2026-08-18/01-pty-keyboard-vs-structured-channels.md` | O13：PTY vs 结构化通道收敛对照 |
| `docs/2026-08-18/03-slock-modification-plan.md` | A1/A2/B1/C1 改造方案（已落地） |
| `docs/2026-08-16/02-buzz-vs-slock-optimization-plan.md` | O1~O20 工程优化（已落地） |

历史（参考价值，部分已被取代）：

| 文档 | 用途 |
|------|------|
| `docs/2026-07-15/02-architecture-decision-records.md` | 7 个架构决策（注意：ADR-001 PTY 决策已被 08-18 headless pivot 推翻） |
| `docs/2026-07-15/03-state-machine.md` | 状态机设计（已落地于 agent-runtime-state.ts） |
| `docs/2026-07-15/04-module-decomposition.md` | 模块拆分目标（已达成并演进） |
| `docs/2026-07-15/05-security-model.md` | Token 生命周期（已落地） |
| `docs/2026-07-15/06-priority-roadmap.md` | 5 Phase 路线图（已完成） |
| `docs/2026-07-15/07-pty-upgrade-plan.md` | PTY 升级计划（已被 headless pivot 取代） |

## 参考代码

### Hive 对应源文件（`D:\code\hive-main\src\server\`，2026-08-20 核实全部存在）

| 模块 | Hive 参考 | 行数 |
|------|-----------|------|
| Token | `agent-tokens.ts` | ~40 |
| Live Run Registry | `live-run-registry.ts` | ~80 |
| Agent Runtime | `agent-runtime.ts` + `agent-runtime-contract.ts` | ~200 |
| Agent Manager (PTY) | `agent-manager.ts` | ~160 |
| Post-start writer | `post-start-input-writer.ts` | ~170 |
| Stdin dispatcher | `agent-stdin-dispatcher.ts` | ~190 |
| Startup instructions | `agent-startup-instructions.ts` | ~90 |
| Exit handler | `agent-run-exit-handler.ts` | ~45 |
| Command presets | `command-preset-defaults.ts` | ~80 |
| Command resolver | `agent-command-resolver.ts` | ~120 |
| Restart policy | `restart-policy.ts` | ~70 |
