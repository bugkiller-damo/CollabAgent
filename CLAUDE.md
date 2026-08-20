# Slock Daemon — 仓库工作指南

## 项目定位

AI-native team collaboration platform. The daemon (`packages/daemon/`) is a local Node.js
process that connects to the Slock server via WebSocket, spawns Claude Code subprocesses as
AI agents, and routes messages between them.

## 当前状态（2026-08-20 核查）

**已非早期单体**：`packages/daemon/src/` 49 个源文件 + `test/` 19 个测试文件。
2026-07-15 路线图（26 项）与 2026-08-18 计划（A1/A2/B1/C1/B2/C2 等）**已全部落地**
（存档：`.claude/goal-progress.json`，currentTask = ALL-DONE）。

核心架构事实：

- **headless 为默认**（2026-08-18 起）：`drivers/persistent-claude.ts` 常驻进程 +
  `--input-format/--output-format stream-json`，`result` 事件 = 精确回合边界，
  回合级 Promise + 沉默超时（300s）卡死保护。`SLOCK_ONESHOT_CLAUDE=1` 退到 one-shot。
- **PTY 是待退役兜底**：`SLOCK_USE_PTY=1` 启用（调试用），删除计划见 tracker Step 3。
- **A1 派发队列**：`agent-dispatch-queue.ts` 串行派发 + 指数退避重试 + 死信上报 +
  15s 去重 + 忙碌合并。
- **安全**：scoped runtime token（`agent-tokens.ts` + `agent-token-file.ts` 0600）、
  `--allowedTools` 白名单 fail-closed（`command-presets.ts`）、env 白名单（A2）。
- **状态机**：`agent-runtime-state.ts` 五态（uninit/idle/starting/working/stopped）。
- **观察**：stream-json 事件 → `agent-observation.ts` 观察帧 → WS 进 web 面板；
  tool_call 经 C1 进审计流。
- **Agent 回话通道**：`mcp/slock-mcp-server.ts`（agent 经 MCP 工具调 server API 发消息/
  派单/读历史），`mcp-bundle.ts` 随运行时注入。

模块速查（`packages/daemon/src/`）：

| 分组 | 文件 |
|------|------|
| 入口 | `index.ts` / `cli.ts` / `daemon-core.ts`（WS 客户端 + 消息分发） |
| 运行时编排 | `agent-runtime.ts`（核心）+ `agent-runtime-dispatch/-spawn/-exit/-state/-credentials/-turn-tracker/-terms-dialog.ts` |
| 驱动 | `drivers/persistent-claude.ts`（默认）/ `claude-print.ts`（one-shot）/ `drivers/probe.ts` |
| 队列与生命周期 | `agent-dispatch-queue.ts` / `live-run-registry.ts` / `agent-run-store.ts` / `idle-reclaimer.ts` / `supervisor.ts` |
| 安全 | `agent-tokens.ts` / `agent-token-file.ts` / `agent-env-whitelist.ts` / `command-presets.ts` / `command-resolver.ts` / `auth.ts` |
| 启动与提示 | `agent-startup.ts` / `system-prompt.ts` / `setup-slock-wrapper.ts` / `restart-summary.ts` |
| PTY 兜底（待退役） | `agent-manager.ts` / `agent-manager-support.ts` / `post-start-input-writer.ts` / `pty-output-bus.ts` / `terminal-state.ts` / `terminal-log.ts` |
| 会话 | `agent-sessions.ts`（sessionId 捕获/恢复）/ `agent-dir-name.ts` |
| 其他 | `client.ts` / `proxy.ts` / `exit-coordinator.ts` / `exit-handler.ts` / `output.ts` / `types/index.ts` |

## 当前执行跟踪

**推进状态以 `docs/2026-08-20/02-daemon-evolution-tracker.md` 为准**（当前焦点 + 勾选清单）。
方案依据：`docs/2026-08-20/01-daemon-evolution-plan.md`（还债批 P0 + 扩建批 D1~D7）。

常用验证命令：

```
npx tsc --noEmit -p packages/daemon/tsconfig.json
pnpm vitest run          # packages/daemon 测试（test/ 19 文件）
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
