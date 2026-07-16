# Slock Daemon — Goal Mode

## 项目定位

AI-native team collaboration platform. The daemon (`packages/daemon/`) is a local Node.js
process that connects to the Slock server via WebSocket, spawns Claude Code subprocesses as
AI agents, and routes messages between them.

## 当前状态

The daemon is in early stage (~447-line monolithic DaemonCore class in `core.ts`). It has
12 source files, fragile process management (child_process.spawn with shell:true, no PTY),
no token lifecycle, no state machine, and silent error swallowing.

## 升级计划

Defined in `docs/2026-07-15/06-priority-roadmap.md` — 5 phases, 26 tasks total.

### Phase 1 (痛点修复)
- 1.1: turn timeout 180s→60s (`drivers/persistent-claude.ts`)
- 1.2: startup delay 1s (`drivers/persistent-claude.ts`)
- 1.3: error logging (catch blocks in `core.ts`)
- 1.4: await loadExistingAgents (`core.ts`)
- 1.5: remove dead code logStatus (`core.ts`)
- 1.6: top-level imports replace await import (`core.ts`)

### Phase 2 (安全+架构)
- 2.1: `types/index.ts` shared types
- 2.2: `agent-tokens.ts` (issue/validate/revokeIfMatches)
- 2.3: `live-run-registry.ts` (active run tracking)
- 2.4: `agent-startup.ts` (extract from core.ts)
- 2.5: `agent-manager.ts` (node-pty wrapper)
- 2.6: `agent-runtime.ts` (core orchestrator)
- 2.7: slim `daemon-core.ts` (~150 lines)
- 2.8: 4-state model (uninit/idle/starting/working/stopped)

### Phase 3-5
See `docs/2026-07-15/06-priority-roadmap.md` for full task breakdown.

## Goal Mode 协议

1. 读 `.claude/goal-progress.json` → 确定当前任务
2. 读 `docs/2026-07-15/` 对应设计文档
3. 读源码 → 执行改动（一次一个文件）
4. 验证：`npx tsc --noEmit -p packages/daemon/tsconfig.json`
5. 更新 `.claude/goal-progress.json`
6. 调用 `ScheduleWakeup(180)` 调度下一次
7. 用 `SendMessage({to:"main",...})` 汇报进度

## 设计文档索引

| 文档 | 用途 |
|------|------|
| `docs/2026-07-15/01-current-state-inventory.md` | 现有代码全景（方法/属性/缺陷） |
| `docs/2026-07-15/02-architecture-decision-records.md` | 7 个架构决策 |
| `docs/2026-07-15/03-state-machine.md` | 四态状态机 + 时序保护 |
| `docs/2026-07-15/04-module-decomposition.md` | 目标 20 文件模块结构 |
| `docs/2026-07-15/05-security-model.md` | Token 生命周期 |
| `docs/2026-07-15/06-priority-roadmap.md` | 5 Phase 路线图 |

## 参考代码

### Hive 对应源文件（`D:\code\hive-main\src\server\`）

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
