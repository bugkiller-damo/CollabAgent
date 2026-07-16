# ④ 模块分解计划

> 生成日期：2026-07-15
> 目标：将 447 行 DaemonCore 单体文件拆分为职责清晰的模块
> 原则：增量拆分，不一次到位；当前接口只增不减

---

## 1. 目标结构总览

```
packages/daemon/src/
│
├── index.ts                 [保留] 入口：参数解析 → DaemonCore.start()
│
├── daemon-core.ts           [精简] 仅 WS 消息路由 + 顶层协调
├── agent-runtime.ts         [新增] 代理生命周期管理（启动/停止/退出）
├── live-run-registry.ts     [新增] 活跃运行注册表
├── agent-tokens.ts          [新增] Token 签发/验证/吊销
├── agent-manager.ts         [新增] 进程 spawn/kill/resize (node-pty 封装)
├── agent-stdin-writer.ts    [新增] 智能 stdin 写入（等待提示符 + bracketed paste）
├── agent-stdin-dispatcher.ts[新增] 消息格式化 + 路由到 agent stdin
├── agent-startup.ts         [新增] 启动指令生成（角色身份 + 规则 + 协议说明）
├── agent-run-store.ts       [新增] 运行记录持久化
├── agent-sessions.ts        [新增] 会话 ID 恢复（Session resume）
├── command-presets.ts       [新增] 各 CLI 的参数预设表
│
├── auth.ts                  [保留] 4 种认证模式
├── client.ts               [保留] ApiClient HTTP 客户端
├── proxy.ts                [保留] 代理配置
├── output.ts               [保留] CLI 输出 helper
├── system-prompt.ts        [保留] System prompt 生成
│
├── claude-print.ts         [保留] 一次性 Claude 封装
├── claude-setup.ts         [标记废弃] 旧版 prompt builder
│
├── drivers/
│   ├── persistent-claude.ts [重写] 集成 node-pty + stdin writer + 空闲回收
│   ├── probe.ts             [保留] Claude CLI 检测
│   └── claude.ts            [标记废弃] 旧版一次性封装
│
└── types/
    └── index.ts             [新增] 所有共享类型定义
```

### 文件统计

| 状态 | 数量 | 文件 |
|------|------|------|
| 保留 | 7 | index.ts, auth.ts, client.ts, proxy.ts, output.ts, system-prompt.ts, probe.ts |
| 精简 | 1 | daemon-core.ts (原 core.ts) |
| 重写 | 1 | persistent-claude.ts |
| 新增 | 9 + 1 type | agent-runtime.ts, live-run-registry.ts, agent-tokens.ts, agent-manager.ts, agent-stdin-writer.ts, agent-stdin-dispatcher.ts, agent-startup.ts, agent-run-store.ts, agent-sessions.ts, command-presets.ts, types/index.ts |
| 标记废弃 | 2 | claude-setup.ts, drivers/claude.ts |

**变化：保留 7 + 拆/改 2 + 新增 9 + 废弃 2 = 20 个源文件**

---

## 2. 新模块职责说明

### 2.1 daemon-core.ts（精简后）

**来源**: 原 `core.ts`（447 行）
**目标**: ~150 行

| 保留职责 | 说明 |
|----------|------|
| `start()` | 启动入口（调用 agent-runtime 完成初始化） |
| `checkClaude()` | CLI 探测 |
| `setupSlockWrapper()` | slock wrapper 生成 |
| `connect()` / `scheduleReconnect()` | WS 连接管理 |
| `handleMessage()` | 消息路由（switch → 委托给 agent-runtime） |
| `stop()` | 清理（委托给 agent-runtime） |
| `agentWorkspace()` | 工作区目录创建（去掉 await import） |

| 移出职责 | 迁入目标 |
|----------|----------|
| `dispatchToAgent()`, `runAgent()`, `runAgentDm()`, `runAgentReminder()` | `agent-runtime.ts` |
| `writeAgentPrompt()` | `agent-startup.ts` |
| `loadExistingAgents()`, `resolveAgentId()`, `mentionedAgentNames()` | `agent-runtime.ts` |
| `logStatus()` | ❌ 删除（死代码） |

### 2.2 agent-runtime.ts（新增，核心模块）

```typescript
interface AgentRuntime {
  startAgent(agentName: string, config: StartConfig): Promise<LiveAgentRun>;
  dispatchToAgent(agentName, channelName, userMsg): Promise<void>;
  stopAgent(agentName: string): void;
  stopAll(): void;
  getStatus(agentName: string): AgentStatus;
  isActive(agentName: string): boolean;
  registerAgent(id: string, name: string, info: AgentInfo): void;
  unregisterAgent(agentName: string): void;
  loadExistingAgents(): Promise<void>;
  findMentionedAgent(content: string): string | null;
  resolveAgentId(agentName: string): string | null;
}
```

**核心流程 `dispatchToAgent()` 的委派链**：

```
dispatchToAgent(agentName, channel, userMsg)
  ├── resolveAgentId()                    → UUID
  ├── agentWorkspace()                    → 工作区目录
  ├── agent-startup.buildInstructions()   → 启动提示
  │
  ├── [已有持久会话] → persistentSession.send(text)
  │
  └── [需新建会话]
       ├── agent-tokens.issue()           → 签发 token
       ├── agent-manager.startAgent()     → spawn 进程
       ├── live-run-registry.add()        → 注册运行
       ├── agent-startup.writeInstructions() → 写入身份
       ├── agent-stdin-writer.write()     → 等待提示符 → 写入消息
       └── 包装为 PersistentClaude 缓存
```

### 2.3 agent-tokens.ts（新增，~50 行）

**参考**: Hive `agent-tokens.ts`

```typescript
interface AgentTokenRegistry {
  issue(agentId: string): string;               // 签发新 token
  peek(agentId: string): string | undefined;     // 查看当前 token
  validate(agentId: string, token: string | undefined): boolean;  // 验证
  revokeIfMatches(agentId: string, token: string): void;  // 匹配时吊销
}
```

### 2.4 agent-manager.ts（新增）

**参考**: Hive `agent-manager.ts`

```typescript
interface AgentManager {
  startAgent(input: StartAgentInput): Promise<AgentRunSnapshot>;
  stopRun(runId: string): void;
  writeInput(runId: string, input: string | Buffer): void;
  resizeRun(runId: string, cols: number, rows: number): void;
  pauseRun(runId: string): void;
  resumeRun(runId: string): void;
  getRun(runId: string): AgentRunSnapshot;
  getOutputBus(): PtyOutputBus;
}
```

### 2.5 live-run-registry.ts（新增）

**参考**: Hive `live-run-registry.ts`

```typescript
interface LiveRunRegistry {
  add(run: LiveAgentRun): void;
  get(runId: string): LiveAgentRun | undefined;
  remove(runId: string): void;
  list(): LiveAgentRun[];

  createExitEntry(runId: string): void;       // 先建立退出通道
  resolveExit(runId: string): void;            // 退出完成

  setPendingExitCode(runId: string, exitCode: number | null): void;
  hasPendingExitCode(runId: string): boolean;
  clearPendingExitCode(runId: string): void;
}
```

### 2.6 agent-stdin-writer.ts（新增）

**参考**: Hive `post-start-input-writer.ts`

```typescript
// 策略接口
interface StdinWriteStrategy {
  type: 'direct' | 'wait-for-prompt' | 'bracketed-paste' | 'stream-json';
  write(runId: string, text: string, process: IProcess): void;
}

// Phase 1: 简单延迟后写入
// Phase 2: 等待终端提示符 + bracketed paste
```

### 2.7 agent-stdin-dispatcher.ts（新增）

**参考**: Hive `agent-stdin-dispatcher.ts`

```typescript
interface AgentStdinDispatcher {
  writeDispatchPrompt(agentName, taskText, dispatchId): void;
  writeReportForwardPrompt(agentName, reportText): void;
  writeStatusForwardPrompt(agentName, statusText): void;
  writeUserInputPrompt(agentName, text): void;
  writeReminderPrompt(agentName, reminder): void;
  writeCancelPrompt(agentName, dispatchId, reason): void;
}
```

### 2.8 agent-startup.ts（新增）

**参考**: Hive `agent-startup-instructions.ts`

```typescript
interface AgentStartup {
  buildStartupInstructions(agent: AgentInfo, workspace: WorkspaceInfo): string;
  buildIdentityMarker(agent: AgentInfo): string;
  buildProtocolDoc(agentRole: string): string;
  buildReminderTail(agentRole: string, dispatchId?: string): string;
  writeSystemPromptFile(agentName: string, content: string): string;
  createWorkspaceDir(agentName: string): string;  // 替代 agentWorkspace
}
```

### 2.9 agent-run-store.ts（新增）

```typescript
// Phase 1: JSON 文件实现
interface AgentRunStore {
  insertAgentRun(run: AgentRunRecord): void;
  updateAgentRun(runId: string, updates: Partial<AgentRunRecord>): void;
  listAgentRuns(agentId: string): AgentRunRecord[];
  getLastRun(agentId: string): AgentRunRecord | null;
  saveRuntimeState(state: AgentRuntimeState): void;
  loadRuntimeState(): AgentRuntimeState | null;
}

// Phase 3: 相同接口，SQLite 实现
```

### 2.10 command-presets.ts（新增）

**参考**: Hive `command-preset-defaults.ts`

```typescript
interface CommandPreset {
  command: string;
  yoloArgs: string[];
  resumeArgsTemplate: string | null;
  sessionIdCapture: SessionCaptureConfig | null;
}

const COMMAND_PRESETS: Record<string, CommandPreset> = {
  claude: {
    command: 'claude',
    yoloArgs: ['--dangerously-skip-permissions'],
    resumeArgsTemplate: '--resume {session_id}',
    sessionIdCapture: { source: 'claude_project_jsonl_dir' },
  },
  codex: {
    command: 'codex',
    yoloArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    resumeArgsTemplate: 'resume {session_id}',
  },
  gemini: {
    command: 'gemini',
    yoloArgs: ['--yolo'],
    resumeArgsTemplate: '--resume {session_id}',
  },
  opencode: {
    command: 'opencode',
    yoloArgs: [],
    resumeArgsTemplate: '--session {session_id}',
  },
};
```

### 2.11 types/index.ts（新增）

```typescript
type AgentStatus = 'uninit' | 'idle' | 'starting' | 'working' | 'stopped';

interface LiveAgentRun {
  runId: string;
  agentId: string;
  pid: number | null;
  status: 'starting' | 'running' | 'exited' | 'error';
  output: string;
  exitCode: number | null;
  startedAt: number;
}

interface AgentInfo {
  agentId: string;
  agentName: string;
  displayName?: string;
  description?: string;
}

interface AgentRunRecord {
  runId: string;
  agentId: string;
  agentName: string;
  status: 'starting' | 'running' | 'exited' | 'error';
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  messagesProcessed: number;
  lastTurnDuration: number | null;
}

interface AgentRuntimeState {
  agentId: string;
  agentName: string;
  status: AgentStatus;
  lastTransitionAt: number;
  totalRuns: number;
  currentRunId: string | null;
  lastSessionId: string | null;
  lastSessionUpdatedAt: number | null;
}
```

---

## 3. 现有代码映射表

### core.ts (447 行) → 拆分目标

| 原方法 | 目标模块 | 说明 |
|--------|----------|------|
| 属性声明 | daemon-core.ts | 精简后只留 WS/配置属性 |
| `start()` | daemon-core.ts | 只保留协调逻辑 |
| `checkClaude()` | daemon-core.ts | 保留 |
| `setupSlockWrapper()` | daemon-core.ts | 保留 |
| `loadExistingAgents()` | agent-runtime.ts | - |
| `connect()` | daemon-core.ts | WS 专属 |
| `scheduleReconnect()` | daemon-core.ts | WS 专属 |
| `mentionedAgentNames()` | agent-runtime.ts | - |
| `findMentionedAgent()` | agent-runtime.ts | - |
| `resolveAgentId()` | agent-runtime.ts | - |
| `agentWorkspace()` | agent-startup.ts | - |
| `writeAgentPrompt()` | agent-startup.ts | - |
| `dispatchToAgent()` | agent-runtime.ts | - |
| `runAgent()` | agent-runtime.ts | - |
| `runAgentDm()` | agent-runtime.ts | - |
| `runAgentReminder()` | agent-runtime.ts | - |
| `logStatus()` | ❌ 删除 | 死代码 |
| `handleMessage()` | daemon-core.ts | 精简为 switch+委派 |
| `stop()` | daemon-core.ts | 委派给 agent-runtime |

### persistent-claude.ts → 重写

| 原方法 | 目标 | 说明 |
|--------|------|------|
| `spawn()` → shell:true | agent-manager.ts → node-pty | 替换为真实 PTY |
| `writeStdin()` | agent-stdin-writer.ts | 等待提示符 |
| `pump()` 文本匹配 | agent-stdin-dispatcher.ts | 结构化消息 |
| `send()` (无 Promise) | agent-runtime.ts | 返回 Promise |
| `stop()` | agent-runtime.ts | 完整退出链 |
| `restart()` | agent-runtime.ts | 时序保护 |

### 保留不变的文件

| 文件 | 理由 |
|------|------|
| `auth.ts` | 4 种认证模式已成熟 |
| `client.ts` | 14 条路径重写，独立逻辑 |
| `proxy.ts` | 代理配置，独立 |
| `output.ts` | 简单 CLI helper |
| `system-prompt.ts` | 与 agent-startup 互补 |
| `probe.ts` | 独立探测逻辑 |

---

## 4. 拆分批次

### Phase 1（痛点修复）

```
动作: core.ts → daemon-core.ts (重命名)
新增: agent-tokens.ts (从 Hive 移植，~50 行)
修改: persistent-claude.ts timeout (180s→60s) + 启动延迟 (1s)
```

**Phase 1 结果**：core.ts 减掉 ~50 行，新增 1 文件

### Phase 2（核心架构）

```
从 core.ts 抽出:
  → agent-runtime.ts      (dispatchToAgent + runAgent 系列)
  → agent-startup.ts      (writeAgentPrompt + agentWorkspace)
  → live-run-registry.ts  (与 Hive 一致)

从 persistent-claude.ts 抽出:
  → agent-manager.ts      (node-pty 封装)
  → agent-stdin-writer.ts (写入策略)
```

**Phase 2 结果**：core.ts 减掉 ~200 行，新增 4 文件

### Phase 3（可靠性）

```
新增:
  → agent-stdin-dispatcher.ts
  → agent-run-store.ts
  → command-presets.ts
  → types/index.ts
```

**Phase 3 结果**：新增 4 文件

---

## 5. 接口设计原则

1. **接口隔离**：每个模块暴露最小接口，不暴露内部实现
2. **依赖注入**：模块间通过接口依赖，便于测试
3. **单向依赖**：daemon-core → agent-runtime → 子模块（无循环）
4. **错误类型化**：使用 typed error 而非字符串匹配

### 核心接口

```typescript
// agent-runtime.ts
interface IAgentRuntime {
  startAgent(name: string, config: StartConfig): Promise<LiveAgentRun>;
  dispatchMessage(agentName: string, msg: AgentMessage): Promise<void>;
  stopAgent(name: string): void;  stopAll(): void;
  getStatus(name: string): AgentStatus;
  registerAgent(id: string, name: string, info: AgentInfo): void;
  unregisterAgent(name: string): void;
}

// agent-tokens.ts
interface IAgentTokenRegistry {
  issue(agentId: string): string;
  peek(agentId: string): string | undefined;
  validate(agentId: string, token: string | undefined): boolean;
  revokeIfMatches(agentId: string, token: string): void;
}

// live-run-registry.ts
interface ILiveRunRegistry {
  add(run: LiveAgentRun): void;
  get(runId: string): LiveAgentRun | undefined;
  remove(runId: string): void;
  list(): LiveAgentRun[];
  createExitEntry(runId: string): void;
  resolveExit(runId: string): void;
  setPendingExitCode(runId: string, exitCode: number | null): void;
}

// agent-manager.ts
interface IAgentManager {
  startAgent(input: StartAgentInput): Promise<AgentRunSnapshot>;
  stopRun(runId: string): void;
  writeInput(runId: string, input: string | Buffer): void;
  resizeRun(runId: string, cols: number, rows: number): void;
  getRun(runId: string): AgentRunSnapshot;
}

// agent-run-store.ts
interface IAgentRunStore {
  insertAgentRun(run: AgentRunRecord): void;
  listAgentRuns(agentId: string): AgentRunRecord[];
  getLastRun(agentId: string): AgentRunRecord | null;
  saveRuntimeState(state: AgentRuntimeState): void;
  loadRuntimeState(): AgentRuntimeState | null;
}
```

---

## 6. 文件依赖图（目标态）

```
index.ts
  └── daemon-core.ts (精简, ~150行)
         ├── agent-runtime.ts (核心协调)
         │     ├── agent-tokens.ts (token 管理)
         │     ├── agent-manager.ts (node-pty)
         │     ├── live-run-registry.ts (活跃运行表)
         │     ├── agent-startup.ts (启动指令)
         │     ├── agent-stdin-writer.ts (写入策略)
         │     ├── agent-stdin-dispatcher.ts (消息格式化)
         │     ├── agent-run-store.ts (持久化)
         │     ├── command-presets.ts (CLI 参数表)
         │     └── persistent-claude.ts (进程封装)
         ├── client.ts → proxy.ts
         ├── auth.ts
         ├── system-prompt.ts
         └── probe.ts
```

依赖方向从上到下，无循环依赖。agent-runtime 是核心协调者，通过接口依赖子模块。
