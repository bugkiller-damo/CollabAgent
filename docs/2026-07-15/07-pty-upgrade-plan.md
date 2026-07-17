# ⑦ PTY 升级计划

> 生成日期：2026-07-16
> 目的：将 Slock daemon 从 `child_process.spawn` + `stream-json` 升级为 `node-pty` + 提示符就绪检测，消除超时丢消息问题
> 参考：Hive 已验证的 PTY 模式（`agent-manager.ts` / `post-start-input-writer.ts` / `agent-run-starter.ts`）

---

## 1. 背景

### 当前架构的问题

```
当前（child_process.spawn + stream-json）
┌─────────────────────────────────────────────┐
│ agent-runtime.ts                            │
│   └─ PersistentClaude                       │
│        ├─ spawn: child_process.spawn        │
│        │   └─ shell:true → cmd.exe 间接启动 │
│        ├─ protocol: stream-json             │
│        │   ├─ stdin: {"type":"user",...}    │
│        │   └─ stdout: 解析 type:"result"    │
│        ├─ turn timeout: 180s → kill         │
│        │   └─ 消息已出队 → 永久丢失         │
│        └─ 无终端环境，无就绪检测              │
└─────────────────────────────────────────────┘
```

### 根因

| 问题 | 影响 | Hive 的做法 |
|------|------|-------------|
| 无 `❯` 提示符可见 | 无法判断 Claude 是否就绪，固定 1s 启动延迟 | node-pty 渲染完整终端，轮询 `❯`/`›`（50ms） |
| stream-json 协议 | 依赖 `type:"result"` 解析，格式变化即失效 | 自然文本 stdin + bracketed paste |
| 180s 硬超时 | Claude 推理未完成即被 kill，消息丢失 | 无限等待提示符，不设 kill 超时 |
| shell:true | cmd.exe 间接启动，进程层级复杂 | node-pty 直连子进程 |

---

## 2. 目标架构

```
目标（node-pty + 提示符就绪检测）
┌──────────────────────────────────────────────────┐
│ agent-runtime.ts                                 │
│   ├─ AgentManager (node-pty)                     │
│   │   ├─ startAgent() → pty.spawn(cmd, args)     │
│   │   ├─ writeInput(runId, text)                 │
│   │   └─ getOutputBus() → PtyOutputBus           │
│   ├─ attachAgentPty()                            │
│   │   ├─ pty.onData → run.output += chunk        │
│   │   ├─ pty.onExit → finishAgentRun             │
│   │   └─ pty.write → write to PTY                │
│   ├─ PtyOutputBus (发布/订阅)                     │
│   │   ├─ publish(runId, chunk)                   │
│   │   ├─ subscribe(runId, listener)              │
│   │   └─ clear(runId)                            │
│   ├─ PostStartInputWriter                        │
│   │   ├─ 每 50ms 轮询 run.output                 │
│   │   ├─ 检测 ❯/› 提示符                        │
│   │   └─ bracketed paste + Enter                 │
│   └─ AgentStdinDispatcher                        │
│       └─ 格式化系统消息 + 调用 PostStartWriter   │
└──────────────────────────────────────────────────┘
```

---

## 3. 改动清单

### 新增文件

| # | 文件 | 行数 | 职责 |
|---|------|------|------|
| 1 | `pty-output-bus.ts` | ~40 | PTY 输出事件总线（发布/订阅） |
| 2 | `agent-manager-support.ts` | ~100 | `attachAgentPty` / `finishAgentRun` / `toAgentRunSnapshot` |
| 3 | `post-start-input-writer.ts` | ~130 | 提示符就绪轮询 + bracketed paste 写入 |

### 修改文件

| # | 文件 | 改动 | 说明 |
|---|------|------|------|
| 4 | `agent-manager.ts` | 重写 | child_process.spawn → node-pty.spawn |
| 5 | `agent-stdin-dispatcher.ts` | 改造 | 内部调用 postStartInputWriter |
| 6 | `agent-runtime.ts` | 改造 | 改用 AgentManager，移除 PersistentClaude |
| 7 | `types/index.ts` | 微调 | PtyOutputBus 接口完善 |
| 8 | `package.json` | 安装 | 添加 `node-pty` 依赖 |

### 删除文件

无。`PersistentClaude` 类保留但不再默认使用。

---

## 4. 执行计划（3 Phase，9 步）

### Phase 1: 基础设施

**Step 1 — 安装 node-pty**

```bash
cd packages/daemon
pnpm add node-pty
pnpm add -D @types/node-pty
```

**Step 2 — 新增 `pty-output-bus.ts`**

```typescript
type OutputListener = (chunk: string) => void;

export interface PtyOutputBus {
  publish(runId: string, chunk: string): void;
  subscribe(runId: string, listener: OutputListener): () => void;
  clear(runId: string): void;
}

export const createPtyOutputBus = (): PtyOutputBus => {
  const listenersByRunId = new Map<string, Set<OutputListener>>();
  return {
    publish(runId, chunk) {
      const listeners = listenersByRunId.get(runId);
      if (!listeners) return;
      for (const listener of listeners) listener(chunk);
    },
    subscribe(runId, listener) {
      let listeners = listenersByRunId.get(runId);
      if (!listeners) { listeners = new Set(); listenersByRunId.set(runId, listeners); }
      listeners.add(listener);
      return () => { listeners.delete(listener); if (listeners.size === 0) listenersByRunId.delete(runId); };
    },
    clear(runId) { listenersByRunId.delete(runId); },
  };
};
```

**Step 3 — 新增 `agent-manager-support.ts`**

三个函数：
- `attachAgentPty(run, pty, outputBus)` — 绑定 pty.onData/onExit，组装 process 对象（stop/write/pause/resume/resize/isStopped）
- `finishAgentRun(run, exitCode, outputBus)` — 标记结束状态，触发 onExit 回调
- `toAgentRunSnapshot(run)` — 提取快照

**Step 4 — 重写 `agent-manager.ts`**

将 `createAgentManager` 从 child_process.spawn 改为 node-pty.spawn：
```typescript
import { spawn, type IPty } from "node-pty";
// 不再需要 child_process.spawn
// startAgent: 直接 pty = spawn(command, args, { cwd, env, name: "xterm-256color" })
// stopRun: pty.kill()
// writeInput: pty.write(text)
// resizeRun: pty.resize(cols, rows)
// pauseRun: pty.pause() / resumeRun: pty.resume()
// getRun / removeRun 逻辑不变
// 保留 PtyOutputBus 引用
```

### Phase 2: 智能写入

**Step 5 — 新增 `post-start-input-writer.ts`**

核心逻辑（来自 Hive 的 `post-start-input-writer.ts`，适配 Slock）：
```typescript
const INTERACTIVE_COMMANDS = new Set(["claude", "codex", "gemini", "opencode"]);
const READY_CHECK_INTERVAL_MS = 50;
const READY_TIMEOUT_MS = 3000;
const COMMANDS_WITH_BRACKETED_PASTE = new Set(["claude", "codex", "opencode"]);

export const hasInteractivePromptReady = (output: string, command = "") => {
  return /(?:^|[\r\n])\s*[❯›]\s*/u.test(output);
};

export const toBracketedPasteSubmission = (text: string) => `[200~${text}[201~`;

export const createPostStartInputWriter = (agentManager, command) => {
  return (runId, text) => {
    const startedAt = Date.now();
    const tryWrite = () => {
      const run = agentManager.getRun(runId);
      if (!run) return;
      if (hasInteractivePromptReady(run.output, command) || Date.now() - startedAt >= READY_TIMEOUT_MS) {
        const input = COMMANDS_WITH_BRACKETED_PASTE.has(command)
          ? toBracketedPasteSubmission(text)
          : text;
        agentManager.writeInput(runId, input + "\r");
        return;
      }
      setTimeout(tryWrite, READY_CHECK_INTERVAL_MS);
    };
    tryWrite();
  };
};
```

注意：Slock 版本比 Hive 精简，去除了 paste acknowledgement 等待逻辑和 Gemini 特定检测。

**Step 6 — 改造 `agent-stdin-dispatcher.ts`**

当前：`manager.writeInput(runId, wrap(kind, body))`
改为：`writeToRun(runId, wrap(kind, body))`，其中 `writeToRun` 内部调用 `createPostStartInputWriter`。

### Phase 3: 接入运行时

**Step 7 — 改造 `agent-runtime.ts`**

- 导入 `createAgentManager` 替代 PersistentClaude
- `doDispatch` 中：
  - 调用 `agentManager.startAgent({...})` 启动 Claude
  - 调用 `attachAgentPty(run, pty, outputBus)` 绑定事件
  - 用 `postStartWriter(runId, userMsg)` 写入消息（等 ❯ 提示符）
  - `await` exit 事件完成
  - 调用 `agentManager.removeRun(runId)` 清理
- 保留 `PersistentClaude` 路径作为 `SLOCK_PERSISTENT_CLAUDE=1` 的兜底

**Step 8 — 微调 `types/index.ts`**

补充 PtyOutputBus 实现接口、RunStatus 补充。

**Step 9 — 改造 `daemon-core.ts`**

将 PtyOutputBus 传入 createAgentRuntime 或通过 agentManager 间接访问。

---

## 5. 与 Hive 的关键差异

| 组件 | Hive | Slock | 原因 |
|------|------|-------|------|
| TerminalStateMirror | @xterm/headless 终端镜像 | 不实现 | Slock 无 Web UI 实时输出需求 |
| WorkerOutputTracker | 追踪最后 PTY 行 | 不实现 | 同上 |
| Session capture | 4 种 CLI 独立捕获 | 已通过 agent-sessions.ts 实现 | 已有 |
| Exit handler | createExitEntry → handleExit → resolve | 已通过 exit-handler.ts 实现 | 已有 |
| StartPromises dedup | Map keyed by agentId | 已通过 dispatchPromises 实现 | 已有 |
| Restart policy | 重启注入恢复摘要 | 已通过 restart-summary.ts 实现 | 已有 |

---

## 6. 风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| node-pty Windows 编译失败 | 🟡 中 | 🔴 高 | 保留 child_process 路径做 fallback（`SLOCK_PERSISTENT_CLAUDE=1`） |
| 提示符检测不匹配 Claude Code 版本 | 🟡 中 | 🟡 中 | `hasInteractivePromptReady` 正则 + READY_TIMEOUT_MS 兜底 |
| 输出累积 OOM | 🟢 低 | 🟡 中 | 保留 `MAX_RUN_OUTPUT_LENGTH = 1_000_000` |

---

## 7. 验收标准

1. `pnpm typecheck` — 编译通过
2. daemon 启动正常，连接 WebSocket
3. 注册 agent 后，在频道 `@agent` 能收到回复
4. 日志中不再出现 `[Persistent xxx] turn timeout, killing process`
5. 复杂任务超过 60s 时不会被误杀（等待提示符而不是硬超时）
