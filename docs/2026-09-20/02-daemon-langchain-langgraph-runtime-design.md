# Daemon 接入 LangChain / LangGraph 详细设计

> 日期：2026-09-20
> 状态：Phase 0–4 已实施并验证；Phase 5 生产硬化尚未实施
> 关联审计：[01-daemon-claude-decoupling-audit.md](./01-daemon-claude-decoupling-audit.md)
> 范围：`packages/daemon/` 为主，包含必要的 shared / server / web 协议改动

---

## 1. 执行摘要

### 1.1 结论

可以接入，整体复杂度为 **中等**，但不应把 LangChain 或 LangGraph 伪装成另一个 Claude CLI preset。

LangChain 与 LangGraph 是应用框架，不是具有统一命令行协议的成品 Agent CLI。真正需要接入 daemon 的不是框架包本身，而是一个由用户项目提供的、实现 Slock 标准运行时协议的 **本地 Agent Worker**。daemon 负责生命周期、投递、观察、鉴权和成本；Worker 负责加载 graph / chain、调用模型、维护 checkpoint，并把框架事件转换为标准协议事件。

推荐方案：

1. 先抽出 runtime driver 边界，使现有 Claude 成为 `ClaudeRuntimeDriver`。
2. 定义语言无关的 **Slock Agent Runtime Protocol v1，简称 SARP/1**。
3. 实现一个通用 `JsonlBridgeRuntimeDriver`，通过 stdin/stdout JSONL 驱动本地 Worker。
4. `langchain` 与 `langgraph` 作为两个产品 runtime ID，共享同一个 bridge driver。
5. 首个官方 Worker SDK 使用 Python，分别提供 LangChain Agent 和 LangGraph Graph 适配器；Node.js Worker 可直接实现同一协议，后续再提供官方 TypeScript SDK。
6. Worker 的启动命令只能来自 daemon 本机私有 manifest，server 只能传 `entrypoint` 标识，不能下发任意命令、路径或环境变量。

### 1.2 不推荐的方案

| 方案 | 结论 | 原因 |
|---|---|---|
| 在 `COMMAND_PRESETS` 添加 `langchain` / `langgraph` | 不采用 | 二者没有稳定统一 CLI，无法覆盖 graph schema、checkpoint、事件和模型配置 |
| daemon 直接依赖 Python LangChain 包 | 不采用 | Node daemon 将承担 Python 环境、包版本和用户 graph 导入，耦合与故障面过大 |
| server 在 `runtime_profile` 中保存完整 shell command | 禁止 | server 可远程改变本机执行内容，扩大为远程代码执行边界 |
| 每回合启动一次 Python 进程 | 不采用 | 冷启动、模型客户端初始化、MCP 连接与内存状态成本过高 |
| 直接复用 Claude `stream-json` 事件结构 | 不采用 | 会把 Claude 的 `result`、`session_id`、累计成本语义固化到新 runtime |
| 第一版直接连接远程 LangGraph Server | 暂不采用 | 需要新增服务凭证、网络信任、远程部署和运行取消语义，超出本地 daemon 第一版范围 |

### 1.3 改造规模判断

| 工作面 | 复杂度 | 说明 |
|---|---:|---|
| daemon driver 抽象 | 中 | 现有队列、状态机和观察总线可保留，主要拆除 Claude 类型穿透 |
| JSONL bridge driver | 中 | 协议由本项目定义，不需要逆向第三方 CLI |
| runtime 配置与本地 manifest | 中 | 需要兼顾安全、probe、UI 展示和本地入口映射 |
| LangChain / LangGraph Python bridge | 中高 | 需要处理流事件、tool、checkpoint、interrupt、输出提取 |
| Python 环境管理 | 中高 | 第一版应“验证环境并报错”，不在 daemon 内自动安装依赖 |
| server / web 接线 | 中 | 现有 `runtime` 与 `runtime_profile` 已有基础，但目前只放行 Claude |
| 生产硬化与回归 | 中高 | 必须验证重复投递、崩溃恢复、成本缺失、密钥隔离和输出背压 |

---

## 2. 背景与当前约束

当前 daemon 的通用部分已经比较成熟：

- `agent-dispatch-queue.ts` 提供串行派发、去重、重试与死信。
- `agent-runtime-state.ts` 提供统一生命周期状态机。
- `agent-observation.ts` 与 ObservationBus 提供 web 可消费的观察帧。
- `agent-cost-tracker.ts` 提供按 agent / channel / day / thread 的记账与预算门。
- scoped runtime token、token file、env whitelist、MCP bundle 和 `slock` CLI 可以被任意本地子进程复用。
- shared / server 已存在 `runtime`、`runtime_profile`、runtime probe 和 runtime catalog 概念。

Phase 0 开始前，执行主链仍直接依赖 Claude；截至 2026-09-20 的实施状态如下：

- [x] `agent-runtime-dispatch-headless.ts` 已移除对 `PersistentClaude`、`claudePrint`、`ClaudeStreamEvent` 的直接引用，改为依赖 `AgentRuntimeDriver` / `AgentRuntimeSession`。
- [x] `agent-observation.ts` 与通用 stream handler 已只消费规范化 `AgentRuntimeEvent`。
- [x] Claude 累计成本差值、session/tool/result 事件转换已收进 `drivers/claude-runtime.ts`。
- [ ] `agent-runtime.ts` 的 agent 注册信息尚未保存 runtime 身份。
- [ ] `handlers/agent.ts` 收到 runtime 后仍未传入 runtime 注册表。
- [ ] prompt、Claude workspace 配置和 startup probe 仍包含 Claude 私有语义，留给后续对应阶段处理。

Phase 0 已建立长期 runtime 边界；后续阶段应在该边界上贯穿 runtime profile 和 bridge，而不是新增 provider 分支到通用 dispatch。

---

## 3. 目标与非目标

### 3.1 目标

1. 在不破坏 Claude 默认行为的前提下支持 `langchain` 与 `langgraph` runtime。
2. daemon 通用编排层不再导入任何 provider stream event 类型。
3. 用户可以在本机声明多个 LangChain / LangGraph entrypoint，并由 agent 配置引用。
4. Worker 常驻运行，每个 agent 实例拥有独立进程、scoped token 和 MCP 会话。
5. 支持文本流、工具观察、回合结束、usage、错误、checkpoint thread 和 LangGraph interrupt/resume。
6. 所有对 Slock server 的 API 权限仍由现有 scoped token 和 server API 控制；Worker 访问模型商和第三方网络属于本机代码信任边界。
7. 未安装、未授权、协议不兼容、入口缺失时 fail closed，绝不回退到 Claude。
8. 为后续 Codex、Gemini、OpenCode、远程 Agent Server 或自定义 runtime 留出同一抽象面。

### 3.2 非目标

第一版不负责：

- 自动创建 Python virtualenv。
- 自动执行 `pip install`、`uv sync` 或 `npm install`。
- 从 server 下载并执行用户 graph 代码。
- 托管用户代码仓库或同步源码。
- 把 daemon 变成通用 Python 进程管理平台。
- 支持多个 turn 在同一个 agent Worker 中并发执行。
- 提供任意 shell 字符串执行能力。
- 替换或删除冻结的 PTY Claude fallback。
- 承诺所有 LangChain callback / LangGraph custom event 都能自动转换为 UI 事件。
- 第一版支持远程 LangGraph Platform / Agent Server。

---

## 4. 核心架构决策

### 4.1 runtime ID 与 transport driver 分离

`runtime` 表示产品与框架身份，driver 表示 daemon 使用的执行协议。

| runtime ID | driver | 执行对象 |
|---|---|---|
| `claude` | `claude-stream` | Claude Code CLI |
| `langchain` | `sarp-stdio` | 实现 SARP/1 的本地 Worker |
| `langgraph` | `sarp-stdio` | 实现 SARP/1 的本地 Worker |

这样做的原因：

- LangChain 与 LangGraph 在 UI、probe、文档和能力展示上应保持可区分。
- 二者都可以复用相同进程协议和 daemon driver。
- 将来 Python 与 TypeScript Worker 也可复用同一个 transport。
- driver 不需要知道 graph 的节点结构或 chain 的具体类型。

### 4.2 常驻 Worker，而不是 one-shot Worker

每个 Slock agent 对应一个本地 Worker 进程：

- daemon 启动 Worker 后发送一次 `initialize`。
- 每个任务发送一个 `turn.start`。
- Worker 对每个已经接受的 turn 发送零个或多个流事件，最后发送且只发送一个 `turn.end`。
- daemon 回收 agent 时发送 `shutdown`，超时后终止进程。
- Worker 崩溃后由现有队列策略决定是否以相同 `turnId` 重试。

第一版固定 `maxConcurrency = 1`，与当前 A1 每 agent 串行派发语义一致。

### 4.3 server 只保存 entrypoint ID

server 允许保存：

```ts
export type AgentRuntimeId =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "langchain"
  | "langgraph";

export interface RuntimeProfile {
  runtime?: AgentRuntimeId;
  model?: string;
  entrypoint?: string;
}
```

`AgentRuntimeId` 表示产品 catalog，不等于已接线列表；创建请求仍必须通过 `WIRED_RUNTIME_IDS` 与目标 computer probe 校验。Codex、Gemini、OpenCode 继续保持 catalog 可见但未接线状态。

server 禁止保存：

- executable 绝对路径
- shell command
- command args
- cwd
- secret value
- 任意环境变量

`entrypoint` 只是在 daemon 本机 manifest 中查找配置的稳定标识。找不到时，该 agent 不可执行并返回明确错误。

### 4.4 本地 Worker 协议必须语言无关

SARP/1 使用每行一个 UTF-8 JSON 对象的双向协议：

- daemon 写 Worker stdin。
- Worker 写 stdout。
- Worker 日志只能写 stderr。
- daemon 不解析 ANSI 终端画面。
- daemon 不依赖 Python 或 JavaScript 包格式。

这使以下实现都可接入：

- Python LangChain Agent
- Python LangGraph `CompiledStateGraph`
- TypeScript LangChain Agent
- TypeScript LangGraph graph
- Rust、Go 或其他语言实现的自定义 agent

### 4.5 checkpoint 由 Worker 所属框架维护

LangGraph checkpoint、store 和 graph state 不写入 daemon 的 Claude session store。

- daemon 生成稳定 `conversationId`。
- LangGraph bridge 将其作为 `configurable.thread_id`。
- Worker 配置 SQLite、PostgreSQL 或其他 checkpointer。
- daemon 只持有协议级 session metadata 和待恢复 interrupt token。
- `daemon-agent-sessions.json` 继续只服务 Claude，迁移期间不强行改格式。

### 4.6 PTY 保持 Claude-only

`SLOCK_USE_PTY=1` 仍是冻结的 Claude fallback：

- `runtime=claude`：按现有 PTY 行为执行。
- `runtime=langchain` 或 `runtime=langgraph`：返回 permanent configuration error。
- 禁止悄悄改用 Claude。

---

## 5. 目标模块图

```text
server agent config
        │ runtime + model + entrypoint
        ▼
handlers/agent.ts
        │ ResolvedAgentRuntimeProfile
        ▼
agent-runtime.ts ── queue / state / token / context / cost / progress
        │
        ▼
AgentRuntimeRegistry
        ├── ClaudeRuntimeDriver
        │      ├── PersistentClaudeSession
        │      └── ClaudeOneShotSession
        │
        └── JsonlBridgeRuntimeDriver
               └── PersistentJsonlWorkerSession
                        │ SARP/1 over stdio
                        ▼
                 local Agent Worker
                        ├── LangChain adapter
                        ├── LangGraph adapter
                        ├── model provider
                        ├── checkpoint store
                        └── Slock MCP client
```

通用层只能依赖以下规范化对象：

- `ResolvedAgentRuntimeProfile`
- `AgentRuntimeSession`
- `AgentTurnRequest`
- `AgentRuntimeEvent`
- `AgentTurnResult`
- `AgentUsage`
- `AgentRuntimeCapabilities`

通用层不得依赖：

- `ClaudeStreamEvent`
- Claude `session_id`
- Claude `result.total_cost_usd`
- LangGraph `Command`
- LangGraph `RunnableConfig`
- LangChain callback event 名称

---

## 6. daemon 内部 runtime contract

建议新增 `packages/daemon/src/agent-runtime-driver.ts`：

```ts
export type RuntimeId = "claude" | "langchain" | "langgraph" | (string & {});

export interface ResolvedAgentRuntimeProfile {
  runtime: RuntimeId;
  model?: string;
  entrypoint?: string;
  identity: string;
}

export interface AgentRuntimeCapabilities {
  persistentProcess: boolean;
  streamingText: boolean;
  toolEvents: boolean;
  durableThreads: boolean;
  interrupts: boolean;
  mcp: boolean;
  usage: "none" | "tokens" | "cost";
  pty: boolean;
  maxConcurrency: 1;
}

export interface AgentTurnRequest {
  turnId: string;
  conversationId: string;
  attempt: number;
  prompt: string;
  source: {
    kind: "message" | "dispatch" | "nudge" | "triage" | "reminder";
    channel?: string;
    threadId?: string;
    sender?: string;
  };
  resume?: {
    interruptId: string;
    resumeToken: string;
    value: string;
  };
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs?: number;
  model?: string;
}

export interface AgentTurnResult {
  turnId: string;
  status: "success" | "interrupted" | "cancelled";
  finalText?: string;
  usage?: AgentUsage;
  sessionRef?: string;
  interrupt?: {
    interruptId: string;
    resumeToken: string;
    prompt: string;
  };
}

export interface AgentRuntimeSession {
  readonly profile: ResolvedAgentRuntimeProfile;
  readonly capabilities: AgentRuntimeCapabilities;
  isAlive(): boolean;
  send(
    request: AgentTurnRequest,
    onEvent: (event: AgentRuntimeEvent) => void,
  ): Promise<AgentTurnResult>;
  cancel(turnId: string, reason: string): Promise<void>;
  stop(reason: string): Promise<void>;
}

export interface AgentRuntimeDriver {
  readonly driverId: string;
  readonly runtimeIds: readonly RuntimeId[];
  probe(context: RuntimeProbeContext): Promise<RuntimeProbeResult>;
  prepare(context: RuntimePrepareContext): Promise<PreparedRuntime>;
  open(context: RuntimeOpenContext): Promise<AgentRuntimeSession>;
  classifyError(error: unknown): DispatchError;
}
```

设计要求：

1. `send()` 的 Promise 只能在收到规范化终止事件后 resolve。
2. 一个 turn 只能有一个终止结果。
3. `stop()` 必须幂等。
4. session 不能自行写 server；所有自动回复仍由通用 dispatch 层决定。
5. Worker 使用 Slock MCP 主动发出的消息仍走现有 server API。
6. driver 抛出的错误必须通过 `DispatchError` 标记 retryable / permanent。
7. `identity` 至少包含 runtime、entrypoint、model 和本地 manifest revision；identity 改变时必须回收旧 session。

### 6.1 Runtime Registry

建议新增 `packages/daemon/src/agent-runtime-registry.ts`：

```ts
export class AgentRuntimeRegistry {
  private readonly byRuntime = new Map<RuntimeId, AgentRuntimeDriver>();

  constructor(drivers: AgentRuntimeDriver[]) {
    for (const driver of drivers) {
      for (const runtime of driver.runtimeIds) {
        if (this.byRuntime.has(runtime)) {
          throw new Error(`Duplicate runtime driver registration: ${runtime}`);
        }
        this.byRuntime.set(runtime, driver);
      }
    }
  }

  resolve(runtime: RuntimeId): AgentRuntimeDriver {
    const driver = this.byRuntime.get(runtime);
    if (!driver) {
      throw new DispatchError("runtime-unsupported", `Unsupported runtime: ${runtime}`);
    }
    return driver;
  }
}
```

注册顺序不能改变错误语义。任何 runtime 都必须唯一匹配一个 driver，启动时发现重复匹配应直接拒绝 daemon 启动。实现时必须将本设计新增的 kebab-case runtime 错误码加入现有 `DispatchErrorCode` 联合，并把 permanent code 加入 `NON_RETRIABLE`；派发链中的 runtime 失败不能抛普通 `Error`，因为当前未分类错误会被保守地视为可重试。registry 构造期的重复注册属于 daemon 启动配置错误，不进入派发队列。

---

## 7. 规范化事件模型

建议新增 `packages/daemon/src/agent-runtime-events.ts`：

```ts
export type AgentRuntimeEvent =
  | { type: "session"; sessionRef: string }
  | { type: "text.delta"; turnId: string; text: string }
  | { type: "text.message"; turnId: string; text: string }
  | { type: "progress"; turnId: string; message: string }
  | {
      type: "tool.start";
      turnId: string;
      callId: string;
      name: string;
      provider?: string;
      operation?: string;
      input?: unknown;
    }
  | {
      type: "tool.end";
      turnId: string;
      callId: string;
      name: string;
      ok: boolean;
      output?: unknown;
      error?: string;
    }
  | { type: "usage"; turnId: string; usage: AgentUsage }
  | {
      type: "interrupt";
      turnId: string;
      interruptId: string;
      resumeToken: string;
      prompt: string;
      payload?: unknown;
    }
  | { type: "warning"; turnId?: string; code: string; message: string };
```

关键约束：

- `progress` 只允许 provider 公开的安全进度摘要，不传递模型隐藏思维链。
- tool input / output 进入观察帧前继续走现有脱敏和尺寸限制。
- `tool.start.provider="slock"` 且 `operation="send_message"` 是 reply guard 的稳定信号。
- 为兼容旧 Claude 事件，短期可保留名称匹配兜底，但新 driver 不依赖字符串猜测。
- `AgentTurnResult` 是终止结果，不作为普通流事件重复发送给上层。

Claude driver 负责在边界内完成：

```text
Claude system.session_id      → session
Claude assistant text block   → text.delta / text.message
Claude tool_use               → tool.start
Claude tool_result            → tool.end
Claude result                 → AgentTurnResult
Claude cumulative cost        → per-turn AgentUsage.costUsd
```

LangChain / LangGraph Worker 负责在协议边界内完成框架事件到 SARP/1 事件的转换，daemon bridge driver 再执行 schema 校验并转换为上述内部类型。

---

## 8. Slock Agent Runtime Protocol v1

### 8.1 Framing

协议名：`slock.agent-runtime`
协议版本：`1`
传输：UTF-8 JSON Lines over stdin/stdout

本节 JSON 中的模型名、版本号、路径、ID 与成本数值仅用于展示 wire shape，不构成内置默认值或依赖版本建议。

所有消息具有公共字段：

```ts
export interface SarpEnvelope {
  protocol: "slock.agent-runtime";
  version: 1;
  type: string;
  seq: number;
  timestamp: string;
  optional?: true;
}
```

规则：

1. `seq` 在每个发送方向独立单调递增，从 1 开始。
2. `timestamp` 使用 ISO 8601 UTC。
3. JSON 对象必须位于单行，字符串中的换行使用 JSON 转义。
4. stdout 只能写协议消息；日志、traceback 和诊断写 stderr。
5. 单行默认上限 1 MiB；超过即视为 `PROTOCOL_FRAME_TOO_LARGE`。
6. 不接受 JSON array、primitive 或未知协议版本。
7. 未知消息只有在显式携带 `optional: true` 时才能记录 warning 后忽略；未知必选消息、控制消息、终止消息或版本必须 fail closed。
8. 已知消息即使携带 `optional: true` 也必须按其 schema 处理，Worker 不能用该标记绕过校验。
9. schema 验证失败立即终止当前 Worker，避免错误流继续污染 turn 边界。

### 8.2 daemon → Worker：`initialize`

每次进程启动只发送一次：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"initialize","seq":1,"timestamp":"2026-09-20T08:00:00.000Z","requestId":"init_01","agent":{"id":"agent_123","name":"researcher","displayName":"Researcher","description":"Research and summarize"},"runtime":{"id":"langgraph","entrypoint":"research-graph","model":"openai:gpt-5-mini"},"workspace":{"path":"D:\\code\\slock\\.slock\\workspaces\\researcher"},"platform":{"systemPrompt":"You are an AI teammate operating in Slock.","serverUrl":"http://127.0.0.1:3000","tokenFile":"D:\\code\\slock\\.slock\\workspaces\\researcher\\.slock\\agent-token","mcp":{"command":"node","args":["D:\\code\\slock\\.slock\\slock-mcp-server.cjs"],"env":{"SLOCK_SERVER_URL":"http://127.0.0.1:3000","SLOCK_AGENT_TOKEN_FILE":"D:\\code\\slock\\.slock\\workspaces\\researcher\\.slock\\agent-token"}}},"limits":{"maxFrameBytes":1048576,"silenceTimeoutMs":300000,"shutdownTimeoutMs":10000}}
```

约束：

- `platform.systemPrompt` 是 runtime-neutral 平台策略，不包含 Claude tool 名称。
- `platform.mcp.env` 不包含明文 token，只包含 token file 路径和非敏感连接信息。
- Worker 不能修改 scoped token 文件。
- `runtime.model` 是可选 override；Worker 不支持时必须在握手中明确拒绝，不能静默忽略。

### 8.3 Worker → daemon：`runtime.ready`

Worker 必须在 startup timeout 内回复：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"runtime.ready","seq":1,"timestamp":"2026-09-20T08:00:00.420Z","requestId":"init_01","runtime":{"id":"langgraph","frameworkVersion":"0.6.7","bridgeVersion":"1.0.0"},"capabilities":{"persistentProcess":true,"streamingText":true,"toolEvents":true,"durableThreads":true,"interrupts":true,"mcp":true,"usage":"cost","pty":false,"maxConcurrency":1},"model":{"selected":"openai:gpt-5-mini","overrides":true}}
```

握手验证：

- runtime ID 必须与 manifest 和 agent profile 一致。
- `maxConcurrency` 第一版必须为 1。
- manifest 要求 durable state 时，`durableThreads` 必须为 true。
- profile 指定 model 且 Worker 返回 `overrides=false` 时，启动失败。
- Worker 返回的 capability 只能收窄 manifest 声明，不能扩大本地授权。

Worker 在 ready 前发现初始化失败时发送 `runtime.error`，随后退出：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"runtime.error","seq":1,"timestamp":"2026-09-20T08:00:00.420Z","requestId":"init_01","error":{"code":"MODEL_NOT_ALLOWED","message":"Requested model is not allowed by this worker","retryable":false}}
```

`runtime.error` 在 ready 后只用于没有 active turn 的 fatal runtime 故障；存在 active turn 时必须先用 `turn.end.status="error"` 结束该 turn。daemon 收到 fatal `runtime.error` 后不复用当前 Worker，并通过显式 wire-code 映射生成内部 `DispatchError`。

### 8.4 daemon → Worker：`turn.start`

```json
{"protocol":"slock.agent-runtime","version":1,"type":"turn.start","seq":2,"timestamp":"2026-09-20T08:01:00.000Z","turnId":"turn_01J7Y6V8","conversationId":"slock:v1:agent_123:thread:thread_456","attempt":1,"prompt":"Alice 在 #research 的问题：请汇总这份报告。","source":{"kind":"message","channel":"research","threadId":"thread_456","sender":"alice"}}
```

带 LangGraph resume 的消息：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"turn.start","seq":3,"timestamp":"2026-09-20T08:02:00.000Z","turnId":"turn_01J7Y72A","conversationId":"slock:v1:agent_123:thread:thread_456","attempt":1,"prompt":"批准","source":{"kind":"message","channel":"research","threadId":"thread_456","sender":"alice"},"resume":{"interruptId":"interrupt_9","resumeToken":"resume_7Yq4","value":"批准"}}
```

`turnId` 规则：

- daemon 首次入队时生成。
- 同一次 A1 retry 必须复用原 `turnId`，只增加 `attempt`。
- 新用户消息生成新 `turnId`。
- Worker 应使用 `turnId` 做本地幂等记录，至少避免重复提交同一 graph invocation。

### 8.5 Worker → daemon：流事件

文本增量：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"assistant.delta","seq":2,"timestamp":"2026-09-20T08:01:01.000Z","turnId":"turn_01J7Y6V8","eventSeq":1,"text":"报告的核心结论是"}
```

Worker 可在一段公开 assistant message 完整后发送 `assistant.message`，字段为 `turnId`、`eventSeq` 和 `text`，映射到内部 `text.message`。该事件只用于观察面板形成稳定段落；daemon 自动回复仍只使用 `turn.end.finalText`。

安全进度摘要：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"assistant.progress","seq":3,"timestamp":"2026-09-20T08:01:01.100Z","turnId":"turn_01J7Y6V8","eventSeq":2,"message":"正在检索报告内容"}
```

工具开始：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"tool.start","seq":4,"timestamp":"2026-09-20T08:01:01.300Z","turnId":"turn_01J7Y6V8","eventSeq":3,"callId":"call_01","tool":{"name":"read_channel_history","provider":"slock","operation":"read_history"},"input":{"channel":"research","limit":20}}
```

工具结束：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"tool.end","seq":5,"timestamp":"2026-09-20T08:01:01.800Z","turnId":"turn_01J7Y6V8","eventSeq":4,"callId":"call_01","tool":{"name":"read_channel_history","provider":"slock","operation":"read_history"},"ok":true,"output":{"messageCount":12}}
```

usage：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"usage","seq":6,"timestamp":"2026-09-20T08:01:03.000Z","turnId":"turn_01J7Y6V8","eventSeq":5,"usage":{"inputTokens":1420,"outputTokens":380,"totalTokens":1800,"costUsd":0.0184,"model":"openai:gpt-5-mini"}}
```

约束：

- `costUsd` 必须是当前 turn 的增量值，不允许会话累计值。
- 无法可靠计算 USD 时省略 `costUsd`，不能填 0 冒充已计量。
- token 数未知时省略对应字段。
- daemon 可用多条 usage 更新观察面板的最新快照，但不累加记账；只有 `turn.end.usage` 作为当前 turn 的最终增量写入账本。
- bridge SDK 应在默认 50ms 窗口内批量合并 token delta，避免事件风暴。

### 8.6 Worker → daemon：`turn.interrupt`

```json
{"protocol":"slock.agent-runtime","version":1,"type":"turn.interrupt","seq":7,"timestamp":"2026-09-20T08:01:04.000Z","turnId":"turn_01J7Y6V8","eventSeq":6,"interruptId":"interrupt_9","resumeToken":"resume_7Yq4","prompt":"是否批准向外部系统提交报告？","payload":{"action":"submit_report","risk":"external_side_effect"}}
```

规则：

- `resumeToken` 是不透明、短期、单次使用标识，不得包含完整 graph state 或 secret。
- `turn.interrupt` 是用于低延迟 UI 展示的可选预告；`turn.end.status="interrupted"` 中的 `interrupt` 对象是 canonical 持久化来源。
- Worker 同时发送两者时，`interruptId`、`resumeToken`、`prompt` 必须一致；不一致属于 protocol violation。
- Worker 必须把真实 checkpoint 持久化在自己的 checkpointer 中。
- daemon 将 pending interrupt 按 `(agentId, conversationId)` 持久化。
- 同一 conversation 只允许一个 active interrupt；新的 interrupt 覆盖前必须收到前一个明确终止或撤销。
- 下一条同 conversation 的用户消息作为 `resume.value`。
- 恢复成功后 daemon 删除 pending interrupt；retry 时保留。

### 8.7 Worker → daemon：`turn.end`

成功：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"turn.end","seq":8,"timestamp":"2026-09-20T08:01:05.000Z","turnId":"turn_01J7Y6V8","eventSeq":7,"status":"success","finalText":"报告显示转化率提升了 18%，主要来自新 onboarding 流程。","sessionRef":"thread_456","usage":{"inputTokens":1420,"outputTokens":380,"totalTokens":1800,"costUsd":0.0184,"durationMs":4000,"model":"openai:gpt-5-mini"}}
```

进入 interrupt：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"turn.end","seq":8,"timestamp":"2026-09-20T08:01:05.000Z","turnId":"turn_01J7Y6V8","eventSeq":7,"status":"interrupted","finalText":"需要人工确认后才能继续。","interrupt":{"interruptId":"interrupt_9","resumeToken":"resume_7Yq4","prompt":"是否批准向外部系统提交报告？"}}
```

失败：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"turn.end","seq":8,"timestamp":"2026-09-20T08:01:05.000Z","turnId":"turn_01J7Y6V8","eventSeq":7,"status":"error","error":{"code":"MODEL_RATE_LIMITED","message":"Model provider rate limit exceeded","retryable":true,"retryAfterMs":30000}}
```

终止语义：

1. 每个已接受 turn 必须且只能发送一个 `turn.end`。
2. `success`、`interrupted`、`cancelled` resolve `send()`。
3. `error` 由 bridge driver 转成 `DispatchError` 并 reject `send()`。
4. `finalText` 是 daemon 自动回复的唯一规范文本来源。
5. `assistant.delta` 只用于观察，不作为最终回复拼装的唯一依据。
6. 如果 Agent 已通过 Slock `send_message` 工具回复，现有 reply guard 继续阻止重复自动回复。
7. `turn.end` 后不得再发送属于该 turn 的流事件；后台任务必须在终止前结束或由 Worker 自行取消。
8. 对 `message`、`dispatch`、`nudge`，`success` 必须具有非空 `finalText` 或已观察到 Slock 发消息工具成功；否则转换为 `empty-success` 错误。`triage` 与 `reminder` 可按现有业务规则允许静默成功。

### 8.8 daemon → Worker：取消与关闭

取消 turn：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"turn.cancel","seq":4,"timestamp":"2026-09-20T08:03:00.000Z","turnId":"turn_01J7Y6V8","reason":"agent stopped"}
```

关闭 Worker：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"shutdown","seq":5,"timestamp":"2026-09-20T08:03:01.000Z","reason":"idle reclaim"}
```

Worker 应在 shutdown timeout 内发送：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"runtime.stopped","seq":9,"timestamp":"2026-09-20T08:03:01.200Z","reason":"idle reclaim"}
```

超时后 daemon 使用现有进程树终止能力清理 Worker 及其子进程。

---

## 9. 本机 Runtime Manifest

### 9.1 文件位置

新增默认文件：

```text
<slockDir()>/runtimes.json
```

即默认：

```text
<daemon cwd>/.slock/runtimes.json
```

`SLOCK_STATE_DIR` 生效时随整个状态树迁移。可新增 `SLOCK_RUNTIME_MANIFEST` 覆盖单个文件路径，但该环境变量必须统一在 `config.ts` 读取。

目录继续使用 `mkdirPrivateSync()` 收紧为 0700；文件使用 0600 best-effort。

### 9.2 Schema

```json
{
  "version": 1,
  "entries": [
    {
      "id": "research-graph",
      "runtime": "langgraph",
      "label": "Research Graph",
      "command": "uv",
      "args": ["run", "--project", "D:\\agents\\research-graph", "python", "-m", "research_graph.slock_worker"],
      "cwd": "D:\\agents\\research-graph",
      "env": {
        "PYTHONUNBUFFERED": "1"
      },
      "secretEnv": ["OPENAI_API_KEY", "TAVILY_API_KEY"],
      "model": {
        "mode": "select",
        "default": "openai:gpt-5-mini",
        "allowed": ["openai:gpt-5-mini", "anthropic:claude-sonnet-4-5"]
      },
      "requireDurableThreads": true,
      "startupTimeoutMs": 15000,
      "silenceTimeoutMs": 300000,
      "shutdownTimeoutMs": 10000
    },
    {
      "id": "support-chain",
      "runtime": "langchain",
      "label": "Support Chain",
      "command": "node",
      "args": ["D:\\agents\\support-chain\\dist\\slock-worker.js"],
      "cwd": "D:\\agents\\support-chain",
      "env": {
        "NODE_ENV": "production"
      },
      "secretEnv": ["OPENAI_API_KEY"],
      "model": {
        "mode": "fixed",
        "default": "openai:gpt-5-mini",
        "allowed": []
      },
      "requireDurableThreads": false,
      "startupTimeoutMs": 10000,
      "silenceTimeoutMs": 300000,
      "shutdownTimeoutMs": 10000
    }
  ]
}
```

### 9.3 校验规则

- `version` 必须为 1。
- `entries[].id` 必须唯一，匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`。
- `runtime` 第一版只接受 `langchain` 或 `langgraph`。
- `command` 是单独 executable，禁止包含 shell 运算符。
- spawn 必须使用 `shell: false`。
- `args` 每项独立传给 spawn，禁止二次 shell 解析。
- `cwd` 必须是存在的绝对目录。
- `env` 仅允许非敏感静态值；键名命中 token、secret、password、key 规则时拒绝加载并要求改用 `secretEnv`。
- `secretEnv` 只保存变量名；值从 daemon 自身环境读取，缺失时 probe 标记 misconfigured。
- `secretEnv` 禁止声明 `SLOCK_*`、`NODE_OPTIONS`、`PYTHONPATH`、`LD_PRELOAD`、`DYLD_INSERT_LIBRARIES`。
- 用户静态 env 与 daemon 注入 env 冲突时，daemon 注入值优先。
- timeout 需要受全局上下限约束，防止 0 或极大值关闭保护。
- model `fixed` 不接受 server override；`select` 只接受 allowlist；`freeform` 第一版不启用。

### 9.4 为什么不自动安装依赖

自动安装会带来：

- 供应链风险。
- 启动时间不可预测。
- Windows / macOS / Linux 构建差异。
- Python 与 Node 版本选择冲突。
- daemon 获得修改用户环境的额外权限。
- 网络失败与 lockfile 漂移。

第一版 probe 只验证 command 可解析、cwd 存在、secretEnv 完整，并通过一次短生命周期 `--slock-probe` 子进程验证 Worker 协议和 framework version。安装命令由管理员在 daemon 外执行。

probe 进程不接收 scoped token、system prompt 或 `secretEnv` 的值，必须在 probe timeout 内输出一个 `probe.result` frame 后以 0 退出：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"probe.result","seq":1,"timestamp":"2026-09-20T08:00:00.000Z","runtime":{"id":"langgraph","frameworkVersion":"0.6.7","bridgeVersion":"1.0.0"},"capabilities":{"persistentProcess":true,"streamingText":true,"toolEvents":true,"durableThreads":true,"interrupts":true,"mcp":true,"usage":"cost","pty":false,"maxConcurrency":1}}
```

Worker 的 probe 分支应在加载用户 graph、创建模型客户端和访问网络之前执行；缺失 secret 由 daemon 根据 `secretEnv` 名称单独判定。非零退出或超时映射为 `misconfigured`；额外 stdout、错误 frame 或不支持的协议版本映射为 `protocol_incompatible`。

---

## 10. Runtime profile 贯穿链路

### 10.1 Canonical resolution

agent runtime profile 按以下顺序解析：

```text
runtime = runtime_profile.runtime ?? agent.runtime ?? "claude"
entrypoint = runtime_profile.entrypoint
model = agent.model ?? config.model ?? runtime_profile.model ?? resolvedEntrypoint?.defaultModel
```

兼容规则：

- 老 agent 没有 runtime 时继续使用 Claude。
- `runtime_profile.runtime` 与 `agent.runtime` 同时存在但值不一致时返回 `runtime-profile-conflict`，不能依赖优先级掩盖脏数据。
- `langchain` / `langgraph` 必须提供 entrypoint。
- `claude` 不接受 entrypoint。
- runtime、entrypoint 或 model 改变后，旧 session 必须停止并用新 identity 打开。
- 无效 profile 是 permanent error，不进入指数重试。

### 10.2 需要改动的链路

```text
server DB agent/runtime_profile
  → agents-public.ts / computers.ts
  → shared WsToDaemonMessage agent:start
  → handlers/agent.ts
  → AgentRuntime.registerAgent()
  → agentInfo map
  → dispatch payload
  → AgentRuntimeRegistry.resolve()
  → driver.prepare() / driver.open()
```

`agent-runtime.ts` 中的 agent info 建议改成：

```ts
export interface RegisteredAgentInfo {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  runtimeProfile: ResolvedAgentRuntimeProfile;
}
```

禁止在 dispatch 时再次从松散字段猜 runtime，所有 dispatch 都使用注册阶段已经验证的 profile。

---

## 11. Conversation 与 checkpoint 设计

### 11.1 稳定 conversation ID

新增 `packages/daemon/src/agent-conversation-id.ts`，集中生成：

```text
普通 thread:
  slock:v1:<agentId>:thread:<threadId>

顶层频道消息与同频道 nudge:
  slock:v1:<agentId>:channel:<channelName>

DM:
  slock:v1:<agentId>:dm:<peerOrChannelId>

经理分诊:
  slock:v1:<agentId>:triage:<channelName>

提醒:
  slock:v1:<agentId>:reminder:<stableReminderId>
```

如果协议暂时没有 stable reminder ID，应先把 reminder ID 从 server payload 贯穿到 daemon；不使用标题作为 ID。

安全与长度处理：

- 外部 ID 先做长度限制和稳定编码。
- 最终超过 256 字节时使用 SHA-256 摘要。
- conversation ID 不包含消息正文。
- 不将 access token、用户邮箱或 secret 放入 ID。

### 11.2 LangGraph 映射

Python bridge 调用 graph 时使用：

```python
config = {
    "configurable": {
        "thread_id": turn.conversation_id,
        "slock_turn_id": turn.turn_id,
    }
}
```

`thread_id` 控制 checkpoint 连续性；`slock_turn_id` 用于幂等审计，不替代 thread ID。

### 11.3 durable state 能力

Worker 握手报告：

- `durableThreads=false`：状态仅限当前进程，进程重启后丢失。
- `durableThreads=true`：使用 SQLite、PostgreSQL 或等价持久 checkpointer。

manifest 可声明 `requireDurableThreads=true`。声明后 Worker 未报告该能力，daemon 拒绝启动该 entrypoint。

### 11.4 interrupt 持久化

新增 `<slockDir()>/daemon-runtime-interrupts.json`，记录：

```ts
export interface PendingRuntimeInterrupt {
  agentId: string;
  runtime: string;
  entrypoint: string;
  conversationId: string;
  interruptId: string;
  resumeToken: string;
  prompt: string;
  createdAt: number;
  expiresAt: number;
}
```

约束：

- 文件使用现有原子写与 private directory 模式。
- resume token 在日志和 WS 出口中脱敏。
- token 默认有效期 24 小时，可由 Worker 给出更短过期时间。
- runtime identity 改变时清除不兼容 interrupt，并向目标频道发明确失败通知。
- Worker 应将 resume token 标记为单次使用，重复 resume 返回 permanent protocol error。

---

## 12. LangChain / LangGraph Worker SDK

### 12.1 包边界

建议新增独立目录：

```text
bridges/python/slock_runtime/
bridges/python/tests/
bridges/examples/langchain-agent/
bridges/examples/langgraph-agent/
```

它不进入 Node daemon 的运行依赖。发布方式可在实现阶段选择 monorepo Python package 或独立 package；协议和 fixtures 必须留在主仓库以支持跨语言契约测试。

SDK 默认把 turn 幂等记录放在 `<workspace>/.slock/runtime-state.sqlite`，文件权限收紧为 0600；LangGraph graph checkpoint 可以使用同库的独立 namespace，也可以由用户显式配置 PostgreSQL 或其他 durable checkpointer。SDK 不得把 provider key、scoped token 或完整 prompt 写入幂等表。

第一版 SDK 暴露两个高层入口：

```python
from slock_runtime import serve_langchain, serve_langgraph

serve_langchain(
    agent=agent,
    system_prompt_mode="prepend",
    usage_extractor=usage_extractor,
)
```

```python
from slock_runtime import serve_langgraph

serve_langgraph(
    graph=graph,
    input_mapper=input_mapper,
    output_mapper=output_mapper,
    interrupt_mapper=interrupt_mapper,
)
```

### 12.2 LangChain adapter

责任：

1. 接收 `initialize` 并验证 model override。
2. 将平台 system prompt 作为最高优先级系统消息注入。
3. 将 `turn.prompt` 转为 `HumanMessage`。
4. 使用 `astream_events` 或框架当前稳定流接口获取事件。
5. 将公开文本 chunk 转换为 `assistant.delta`。
6. 将工具开始 / 完成转换为 `tool.start` / `tool.end`。
7. 从最终 message 提取 `finalText`。
8. 从 provider `usage_metadata` 提取 token；有可靠定价配置时才输出 `costUsd`。
9. 捕获 provider 限流、鉴权、网络和输入错误，映射为稳定错误码。
10. 对相同 `turnId` 的重试执行幂等检查。

LangChain agent 如果内部已经基于 LangGraph 实现，可以报告 durableThreads 和 interrupts；普通 Runnable 不应虚报这些能力。

### 12.3 LangGraph adapter

责任：

1. 用 `conversationId` 设置 `configurable.thread_id`。
2. 用 `input_mapper` 将 Slock turn 转换为 graph state 输入。
3. 订阅 messages、updates、custom 事件流。
4. 只把明确标记为公开的 custom event 转为 `assistant.progress`。
5. 用 `output_mapper` 从最终 graph state 提取文本。
6. 捕获 interrupt，创建 resume token 并发送 `turn.interrupt`。
7. 收到 `resume` 时使用对应 checkpoint 和 `Command(resume=value)` 恢复。
8. 不把完整 graph state、checkpoint 或私有 node state发送到 daemon。
9. graph 完成后发送一个 `turn.end`。
10. graph 崩溃时保留框架 checkpoint，但通过错误分类决定是否自动 retry。

### 12.4 MCP 接入

Worker SDK 从 `initialize.platform.mcp` 获得 stdio MCP server 描述：

- Python LangChain 可使用官方兼容 MCP adapter 创建工具。
- TypeScript Worker 可使用 LangChain.js MCP adapter 或标准 MCP client。
- MCP 子进程继承的只是 `SLOCK_AGENT_TOKEN_FILE` 路径，不是明文 token。
- Worker 必须复用一个 MCP client，不得每个 tool call 启动一份 server。
- Worker 退出时关闭 MCP client 和其子进程。

对于自定义 LangGraph，graph 的工具节点通常在 compile 前确定。推荐 Worker 启动顺序：

```text
读取 initialize
  → 创建 Slock MCP client
  → 加载 Slock tools
  → 构建或绑定 graph
  → 校验 model override
  → 回复 runtime.ready
```

因此 Worker 模块不能在 import 时就不可逆地 compile 一个缺少 Slock tools 的 graph；示例工程应提供 `build_graph(slock_tools, runtime_config)` 工厂。

### 12.5 平台 system prompt

现有 `system-prompt.ts` 需要拆分：

1. `platform prompt`：runtime-neutral，描述 Slock 身份、频道协作、回话规则、安全规则和 workspace。
2. `Claude adapter prompt`：Claude Code tool 名称、`CLAUDE.md`、允许工具与 CLI 行为。
3. `Bridge adapter prompt`：SARP turn 语义、MCP tool 使用与 finalText 规则。

workspace 中新增规范文件 `SLOCK.md`。Claude driver 可继续生成兼容 `CLAUDE.md`；bridge Worker 直接接收 platform prompt 文本，不依赖框架自动读取某个文件名。

---

## 13. Probe、ready payload 与 UI

### 13.1 Probe 状态

扩展 runtime probe：

```ts
export type RuntimeProbeStatus =
  | "installed"
  | "not_installed"
  | "misconfigured"
  | "protocol_incompatible"
  | "installed_unsupported";
```

bridge entry probe 结果：

```ts
export interface RuntimeEntrypointProbe {
  id: string;
  runtime: "langchain" | "langgraph";
  label: string;
  status: RuntimeProbeStatus;
  version?: string;
  models?: string[];
  defaultModel?: string;
  modelMode: "fixed" | "select";
  capabilities?: Partial<AgentRuntimeCapabilities>;
  errorCode?: string;
  errorMessage?: string;
}
```

ready payload 可在现有 runtime probes 之外新增 `entrypoints`。不得向 server 上报：

- command
- args
- cwd 绝对路径
- secretEnv 值
- token file 路径
- stderr 原文中的 secret

### 13.2 Server 创建校验

创建 agent 时必须同时满足：

1. runtime 在 `WIRED_RUNTIME_IDS`。
2. 目标 computer 在线。
3. 该 computer 最新 ready payload 中存在同 runtime 的 entrypoint。
4. entrypoint status 为 `installed`。
5. model 满足 entrypoint model policy。

当前 server 对 probe 缺失的情况不能继续默认放行；bridge runtime 必须 fail closed。

### 13.3 Web 创建界面

`ComputerView.vue` 需要改为：

1. 先选择 runtime。
2. Claude 显示现有模型列表。
3. LangChain / LangGraph 显示该 computer 上报的 entrypoint 列表。
4. entrypoint 为 `select` 时显示 allowlist model。
5. entrypoint 为 `fixed` 时只展示固定模型，不允许修改。
6. misconfigured entrypoint 显示安全错误摘要和本机修复指引。
7. computer 离线时不允许创建 bridge agent。

`MemberProfileBody.vue` 应展示：

- runtime
- entrypoint label
- 当前 model
- capabilities 摘要
- durable / ephemeral thread 状态
- 最近 runtime 错误

---

## 14. 成本与 usage

### 14.1 统一语义

通用层只接受 **本 turn 增量**：

```ts
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs?: number;
  model?: string;
}
```

- Claude driver 内部继续用 `createSessionCostDelta()` 把累计值转换为增量。
- bridge Worker 必须直接发送增量。
- daemon 只记录最终明确值，不再根据 runtime 猜测累计语义。
- 多条 usage event 只用于观察和更新当前快照；`turn.end.usage` 是最终 canonical usage，记账时覆盖快照而不是与流事件相加，避免重复计费。

### 14.2 成本未知

如果 Worker 只能报告 token，不能可靠报告 USD：

- `costUsd` 省略。
- `agent-cost-tracker` 将当前 turn 的 USD 记为未知而不是伪装为免费。
- UI 显示 token 与“USD 未计量”。
- `SLOCK_COST_BUDGET_USD` 无法对该 runtime 提供完整保证，agent profile 和 computer 页面必须显示警告。
- 生产环境可在 manifest 增加 `requireCostUsd`；启用后 Worker 未提供 cost 能力就拒绝 ready。

现有 cost store 若暂时不能表达 unknown，应先扩展 schema，再开放 bridge runtime。不能简单把 unknown 写成 0 并继续宣称预算熔断有效。

---

## 15. 错误分类与恢复语义

### 15.1 Permanent errors

以下内部 `DispatchErrorCode` 不进入 A1 自动重试，并沿用仓库现有的 kebab-case 命名：

- `runtime-unsupported`
- `runtime-profile-conflict`
- `entrypoint-required`
- `entrypoint-not-found`
- `manifest-invalid`
- `command-not-found`
- `cwd-not-found`
- `secret-env-missing`
- `protocol-version-unsupported`
- `runtime-id-mismatch`
- `model-not-allowed`
- `durable-threads-required`
- `pty-runtime-unsupported`
- `provider-auth-failed`
- `graph-input-invalid`
- `empty-success`

SARP/1 wire error 可使用 `MODEL_RATE_LIMITED` 这类大写稳定码；bridge driver 必须通过显式映射表转换为内部 `DispatchErrorCode`，不能把 Worker 提供的任意字符串直接注入内部错误联合。

### 15.2 Retryable errors

以下内部错误码可以交给现有 A1 策略：

- `provider-rate-limited`：尊重受上限约束的 `retryAfterMs`
- `provider-network-failed`
- `worker-exited`
- `runtime-start-timeout`
- `runtime-silence-timeout`
- `mcp-start-failed`

这些 code 也必须加入 `DispatchErrorCode`，但不加入 `NON_RETRIABLE`。同时给 `DispatchError` 增加可选、受上限约束的 `retryAfterMs`；队列等待时间取指数退避结果与 `retryAfterMs` 的较大值，再钳制到全局最大退避，避免 provider 值绕过本地保护。

### 15.3 Protocol violations

以下情况立即终止 Worker：

- stdout 非 JSON。
- 错误协议名或版本。
- `turnId` 与当前 turn 不符。
- `eventSeq` 回退或重复。
- 同一 turn 多个 `turn.end`。
- 未 ready 就接收流事件。
- frame 超过上限。
- ready 声明并发大于 1。
- resume token 与 pending interrupt 不匹配。

协议错误默认 permanent；只有明确的传输截断并且 Worker 已退出时可作为 crash retry。

### 15.4 重复副作用

现有队列重试语义本质上是 at-least-once。模型调用、外部 API 和 Slock 发消息都可能在“副作用已发生但进程在 `turn.end` 前崩溃”时重复。

生产开放前必须完成：

1. `turnId` 在 retry 中稳定。
2. bridge SDK 持久化最近完成 turn ID 与结果摘要。
3. Worker 收到已完成 turn ID 时返回相同 terminal result，不重复运行 graph。
4. Slock `send_message` / `dispatch` MCP 工具接受可选 `idempotencyKey`。
5. bridge SDK 默认使用 `<turnId>:<toolCallId>` 作为 Slock 写操作 idempotency key。
6. server 在作用域内去重该 key，并返回第一次调用结果。

对第三方工具的副作用，SDK 无法自动保证 exactly-once，必须由 graph 作者使用业务 idempotency key 或在 interrupt 后人工确认。

---

## 16. 安全模型

### 16.1 信任边界

LangChain / LangGraph Worker 是本机管理员选择运行的任意代码。它与 Claude CLI 不同：

- daemon 无法通过 `--allowedTools` 限制 Worker 自己导入的 Python / Node 库。
- Worker 可以访问其 OS 用户本来可访问的文件和网络。
- scoped Slock token 只限制它对 Slock server 的能力，不构成 OS sandbox。

产品和文档必须明确：启用某个 entrypoint 等同于信任该本地代码。

### 16.2 必须实现的控制

1. **本地 manifest**：远程 server 不能下发 executable、args 或 cwd。
2. **无 shell spawn**：`shell: false`，command 与 args 分离。
3. **env 最小化**：复用现有 `agent-env-whitelist.ts`，只增加 manifest 明确授权的 secretEnv。
4. **token 文件**：继续使用 0600 token file，子进程 env 不含明文 token。
5. **per-agent process**：不同 agent 不共享 Worker，避免 scoped token 和 memory 串线。
6. **输出脱敏**：stderr、protocol error、tool input/output、ready error 均经过 `redact.ts`。
7. **大小限制**：限制 frame、prompt、tool payload、stderr ring buffer 和 pending interrupt payload。
8. **权限冲突保护**：manifest 不能覆盖 daemon 注入的 `SLOCK_*`。
9. **无自动依赖安装**：daemon 不执行 package manager。
10. **配置审计**：日志只记录 manifest path、entrypoint ID 和 hash，不记录 secret value。

### 16.3 可选增强

- Linux 使用独立用户、container 或 systemd sandbox 运行 Worker。
- Windows 使用 Job Object 限制进程树和资源。
- manifest 支持 command hash / signature pinning。
- 为 entrypoint 增加出站网络策略和文件系统沙箱。
- server 管理员策略限制可创建的 runtime 与 entrypoint label。

这些增强不阻塞本地开发版，但企业部署应至少采用 OS 级隔离之一。

---

## 17. 可观测性

### 17.1 日志字段

所有 runtime 日志至少带：

```text
agentName
agentId
runtime
entrypoint
sessionIdentity
pid
turnId
conversationIdHash
attempt
eventType
durationMs
errorCode
retryable
```

不记录：

- 完整 prompt
- 完整 graph state
- resume token
- 明文 secret
- scoped agent token
- 未脱敏 tool payload

### 17.2 指标

建议增加：

- `runtime_worker_start_total{runtime,entrypoint}`
- `runtime_worker_start_failed_total{code}`
- `runtime_worker_restart_total{reason}`
- `runtime_turn_total{runtime,status}`
- `runtime_turn_duration_ms`
- `runtime_event_total{type}`
- `runtime_protocol_error_total{code}`
- `runtime_frame_dropped_total{reason}`
- `runtime_interrupt_total{runtime}`
- `runtime_resume_total{status}`
- `runtime_usage_unknown_total{field}`

若项目当前没有 metrics backend，先以结构化日志和现有观察帧实现，不应为此引入新生产依赖。

### 17.3 stderr 处理

- daemon 持有每个 Worker 最近固定字节数的 stderr ring buffer。
- 正常日志按 debug 级别节流输出。
- Worker 失败时附上脱敏后的尾部摘要。
- stderr 不进入 protocol parser。
- stderr 暴涨不得阻塞 stdout 读取。

---

## 18. 文件级改造计划

### 18.1 新增文件

| 文件 | 职责 |
|---|---|
| `packages/daemon/src/agent-runtime-driver.ts` | driver / session / turn / capability contract |
| `packages/daemon/src/agent-runtime-registry.ts` | runtime → driver 解析，禁止隐式 fallback |
| `packages/daemon/src/agent-runtime-events.ts` | provider-neutral event model |
| `packages/daemon/src/agent-runtime-profile.ts` | runtime profile 解析、校验、identity |
| `packages/daemon/src/agent-runtime-manifest.ts` | 本地 manifest 加载、权限、schema 校验 |
| `packages/daemon/src/agent-conversation-id.ts` | conversation ID 稳定映射 |
| `packages/daemon/src/agent-runtime-interrupt-store.ts` | pending interrupt 持久化 |
| `packages/daemon/src/drivers/claude-runtime.ts` | Claude stream / one-shot 包装为统一 driver |
| `packages/daemon/src/drivers/jsonl-bridge-runtime.ts` | LangChain / LangGraph 共享 driver |
| `packages/daemon/src/drivers/persistent-jsonl-worker.ts` | SARP stdio 生命周期和 parser |
| `packages/daemon/src/sarp-protocol.ts` | SARP/1 schema、decoder、encoder |
| `packages/daemon/test/fixtures/sarp-worker.mjs` | 可控协议测试 Worker |
| `bridges/python/slock_runtime/` | Python Worker SDK |
| `bridges/examples/langchain-agent/` | 可运行 LangChain 示例 |
| `bridges/examples/langgraph-agent/` | durable checkpoint + interrupt 示例 |

### 18.2 主要修改文件

| 文件 | 修改 |
|---|---|
| `packages/shared/src/index.ts` | runtime IDs、profile entrypoint、ready entrypoint probe 类型 |
| `packages/daemon/src/handlers/agent.ts` | 读取并传递完整 runtime profile |
| `packages/daemon/src/agent-runtime.ts` | agentInfo 保存 runtime profile，按 driver 管理 session |
| `packages/daemon/src/agent-runtime-dispatch-headless.ts` | 移除 Claude concrete imports，只依赖 session contract |
| `packages/daemon/src/agent-runtime-dispatch-stream.ts` | 消费 `AgentRuntimeEvent` 而非 `ClaudeStreamEvent` |
| `packages/daemon/src/agent-observation.ts` | provider-neutral event → ObservationFrame |
| `packages/daemon/src/agent-cost-tracker.ts` | 支持 canonical per-turn usage 与 unknown cost |
| `packages/daemon/src/errors.ts` | 扩展 runtime `DispatchErrorCode` 与可选 `retryAfterMs` |
| `packages/daemon/src/agent-dispatch-queue.ts` | 在本地上限内合并指数退避与 `retryAfterMs` |
| `packages/daemon/src/system-prompt.ts` | 拆 platform prompt 与 adapter prompt |
| `packages/daemon/src/agent-mcp-config.ts` | 提供通用 MCP descriptor，Claude 文件写入移到 Claude adapter |
| `packages/daemon/src/mcp/slock-mcp-server.ts` | Slock 写工具接收并透传 idempotency key |
| `packages/daemon/src/daemon-core.ts` | runtime registry、manifest probe、去除仅 Claude startup 假设 |
| `packages/daemon/src/ready-payload.ts` | 上报安全裁剪后的 entrypoint probes |
| `packages/daemon/src/config.ts` | 集中读取 bridge rollout 与 manifest 配置 |
| `packages/daemon/src/command-presets.ts` | unknown runtime 不再回退 Claude |
| `packages/server/src/routes/agents-public.ts` | entrypoint / model / online probe fail-closed 校验 |
| `packages/server/src/routes/agents-messages.ts` | Agent 发消息请求的 idempotency key 去重 |
| `packages/server/src/routes/agents-dispatch.ts` | Agent 派单请求的 idempotency key 去重 |
| `packages/server/src/routes/computers.ts` | 暴露 entrypoint capability 摘要 |
| `packages/web/src/pages/ComputerView.vue` | runtime → entrypoint → model 创建流程 |
| `packages/web/src/components/people/MemberProfileBody.vue` | runtime 状态和能力展示 |

### 18.3 保持冻结的文件

除 Claude PTY defect 外，不修改：

- `agent-runtime-spawn.ts`
- `agent-runtime-terms-dialog.ts`
- PTY prompt 检测和终端解析模块

新 runtime 不经过这些路径。

---

## 19. 分阶段实施

### Phase 0：Claude 行为保持的 driver 抽取

状态：已完成（2026-09-20）
复杂度：中
风险：中

实施：

1. 引入 `AgentRuntimeSession`、`AgentRuntimeEvent`、`AgentRuntimeDriver`。
2. 用 `ClaudeRuntimeDriver` 包装 `PersistentClaude` 与 `claudePrint`。
3. 将 Claude event → normalized event 转换移到 driver 内。
4. dispatch 与 observation 不再导入 `ClaudeStreamEvent`。
5. unknown runtime 改为明确错误，删除 preset 的 Claude fallback。
6. PTY 路径保持原样。

验收：

- [x] 默认 headless、one-shot 和 PTY Claude 行为不变。
- [x] daemon 全量测试通过：50 个测试文件、520 个用例。
- [x] 通用 dispatch、observation、idle reclaim 文件中没有 `PersistentClaude`、`claudePrint`、`ClaudeStreamEvent` import。
- [x] Claude 累计 cost 仍在 driver 边界正确转换为 turn delta。
- [x] daemon typecheck、lint、build 通过；lint 为 0 error，保留 6 个既有或已明确接受的 warning。
- [x] 冻结 PTY 文件未修改。

实际落地文件：

- 新增 `agent-runtime-driver.ts`、`agent-runtime-events.ts`、`drivers/claude-runtime.ts`。
- 新增 registry 与 Claude normalizer/driver 定向测试。
- `agent-runtime.ts` 作为 composition root 注册并解析 Claude driver。
- `getCommandPreset()` 对未知 runtime 改为 permanent `runtime-unsupported`，不再回退 Claude。
- 保留 `streamEventToFrames`、`forgetSessionCost` 等既有公开名称，内部实现改为 provider-neutral，以降低迁移风险。

### Phase 1：runtime profile 与本地 manifest

状态：已完成（2026-09-20）
复杂度：中
风险：中

实施：

1. `runtime`、`model`、`entrypoint` 贯穿 shared → handler → registry → dispatch。
2. 新增 manifest loader 与权限校验。
3. 新增 entrypoint probe 和 ready payload。
4. session identity 变化时安全回收旧进程。
5. 添加 experimental 开关，尚不修改 `WIRED_RUNTIME_IDS`。

验收：

- [x] 老 agent 缺 runtime 时仍是 Claude（`resolveAgentRuntimeProfile` 缺省 runtime="claude"）。
- [x] LangGraph 缺 entrypoint 时 permanent fail（`entrypoint-required` 首败即死信，不重试不 spawn）。
- [x] server 无法通过 profile 注入命令（entrypoint 只是本机 manifest 里的 ID；命令/路径/env 不随 profile 流动）。
- [x] ready payload 不泄漏路径和 secret（probe 只上报 id/label/runtime/状态/模型名单；secretEnv 仅存变量名）。
- [x] manifest 变更后旧 Worker 不会继续复用（identity 含 entry revision；dispatch 复用前比对，不符即丢弃冷启动）。

实际落地文件：

- 新增 `agent-runtime-manifest.ts`（加载/校验/`invalidEntries` 安全元数据/mtime 缓存 loader）、
  `agent-runtime-profile.ts`（解析/校验/identity）、`drivers/runtime-entrypoint-probe.ts`（`--slock-probe` 子进程探测 + 能力白名单裁剪）。
- shared：`AgentRuntimeProfile`、`WsAgentStartConfig/Agent` 增 `entrypoint`、`RuntimeEntrypointProbe`、
  `BRIDGE_RUNTIME_IDS`、ready `entrypoints` 字段。
- `agent-runtime.ts`：`agentInfo` 扩 runtime/entrypoint/runtimeProfileError；`sessionIdentities` +
  `invalidateOnIdentityChange`；`registerAgent` 权威合并语义；`loadExistingAgents` 解析 `runtime_profile`。
- `agent-runtime-dispatch.ts`：派发前 `resolveRuntimeProfile` + `assertResolved`（permanent 即死信）；
  `runtimeRegistry.resolve(profile.runtime)` 取 driver；`usePty`+非 claude → `pty-runtime-unsupported`。
- `agent-runtime-dispatch-headless.ts`：复用前 identity 比对丢弃 stale 会话；`model`/`entrypoint` 走 resolved profile；
  one-shot 续接要求 identity 一致。
- `handlers/agent.ts`：runtime/entrypoint 多源候选 + 冲突检测（`runtime-profile-conflict`）；
  `handlers/inbound.ts` 归一化新字段。
- `ready-payload.ts` + `daemon-core.ts`：`SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES=1` 时 ready 附 `entrypoints`。
- `config.ts`：`SLOCK_RUNTIME_MANIFEST` / `SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES`。
- `errors.ts`：新增 8 个 permanent profile/manifest 错误码。
- server `agents-public.ts`：POST/PATCH entrypoint 落库与透传；`claude+entrypoint` 静态无效组合 400；
  PATCH 保留/清除语义（`entrypoint:null`/`""` 显式清除）。
- `AgentRuntimeRegistry.forgetAgent`：按 driver 去重转发（成本基线/缓存清理由各 driver 自管）。
- `AgentRuntimeOpenOptions.entrypoint`：profile → driver 的稳定 ID 透传。

验证：daemon 全量 53 文件 / 595 用例通过；typecheck、lint（0 error / 6 既有 warning）、build 通过。
server 侧新增 `agents.test.ts` Phase 1 集成用例（entrypoint 落库/保留/清除/400），需活库环境在 CI 执行。

未做（有意推迟）：

- `computers.ts` 的 entrypoint capability 摘要落库与 web 创建 UI——随 Phase 2 driver 接线一并开放；
  当前 daemon 上报的 `entrypoints` 由 server zod `passthrough` 安全忽略。
- `WIRED_RUNTIME_IDS` 仍为 `["claude"]`；bridge runtime 经 PATCH 可写入 profile，但无对应 driver，
  派发以 `runtime-unsupported` 死信——这是本阶段的 fail-closed 预期。

### Phase 2：SARP/1 与通用 bridge driver

状态：已完成（2026-09-20）
复杂度：高
风险：中高

实施：

1. 完成 protocol codec 和 schema validation。
2. 完成 `PersistentJsonlWorkerSession`。
3. 支持 handshake、turn、stream、usage、cancel、shutdown。
4. 支持 stdout parser、stderr ring buffer、frame limit、silence timeout。
5. 使用 fixture Worker 完成崩溃、错帧、重复终止和 retry 测试。

验收：

- [x] fixture Worker 可以连续处理多个 turn（真实子进程端到端测试覆盖）。
- [x] 每个 turn 精确结束一次（终态后同 turnId 的任何帧 = `protocol-violation`）。
- [x] malformed stdout 立即停止 Worker（非 optional 未知帧/坏 schema/越序 → violation 杀进程）。
- [x] idle reclaim 能清理 Worker 进程树（session 走 persistentSessions 统一回收通道；
  `stop()` 发 `shutdown` → SIGTERM → SIGKILL 逐级升级）。
- [x] retry 复用 turn ID（队列 item 首入队生成 `turnId`，重投沿用，`attempt` 随 attempts+1）。
- [x] 不存在跨 agent token 或 MCP 会话复用（initialize 载荷按 agent 生成；
  token 文件路径经 env 白名单下发，MCP 描述符每次 spawn 重建）。

实际落地文件：

- 新增 `sarp-protocol.ts`（信封/编解码/schema 校验/帧大小与 seq 单调/optional 语义/wire 错误映射）、
  `agent-conversation-id.ts`（§11.1 稳定会话 ID）、
  `agent-runtime-interrupt-store.ts`（§11.4 pending interrupt 原子落盘 + 7 天 TTL + runtime/entrypoint 相容校验）。
- 新增 `drivers/persistent-jsonl-worker.ts`（spawn/握手/回合状态机/沉默与启动超时/
  §8.6 预览-终态 interrupt 一致性校验/§8.7.8 empty-success/取消与关停升级）。
- 新增 `drivers/jsonl-bridge-runtime.ts`（manifest→spawnSpec/env 白名单/secretEnv 按名注入/
  initialize 载荷组装），`agent-runtime.ts` 仅在 `SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES=1` 注册。
- `agent-runtime-driver.ts`：`send(prompt)` → `send(AgentTurnRequest)`（turnId/conversationId/
  attempt/source/resume）；`AgentRuntimeTurnResult` 增 status/finalText/interrupt；
  `AgentRuntimeOpenOptions` 增 agent/platformPrompt/mcp。
- `errors.ts`：13 个新错误码 + `retryAfterMs`（封顶 `DISPATCH_MAX_RETRY_AFTER_MS=120s`）。
- `agent-dispatch-queue.ts`：item 携带 `turnId`/`sourceId`/`sender`；retryAfterMs 与退避取大者并封顶。
- `agent-runtime-dispatch.ts`：§11.1 conversationId + pending interrupt take/resume +
  turnSeed 元数据 + sender 贯通（runAgent/runAgentDm/runAgentTriage）；
  `IDispatch.dispatchToAgent` 增 `sender` 形参。
- `agent-runtime-dispatch-headless.ts`：bridge spawn 准备（platformPrompt/MCP 描述符/token 文件/
  env）+ `send(request)` + interrupt 簿记（interrupted→put、success→delete）。
- `agent-runtime-dispatch-stream.ts`：`provider="slock"+operation="send_message"` 稳定信号判
  reply guard；`turn.end.status` 多终态处理；finalText 作守卫代发源。
- `agent-observation.ts`：progress/interrupt/warning 新事件映射 + turn.end 四终态标签。
- `handlers/reminder.ts`：`reminder.id` → sourceId（空串不落 payload）。
- `drivers/claude-runtime.ts`：send 契约适配（实例本体即 session，遮蔽 send 解 request.prompt）。
- `system-prompt.ts`：runtime-neutral `generateBridgeSystemPrompt`。
- `daemon-core.ts`：`unregisterAgent` 时 `interruptStore.clearAgent(agentId)`。
- 测试 fixture `test/fixtures/sarp-worker.mjs`（真实 Node 子进程，env 控制脚本化行为）。

测试与验证：

- 新增测试文件：`sarp-protocol`（15）、`persistent-jsonl-worker`（30）、`sarp-worker-fixture`（28）、
  `sarp-bridge-integration`（真实进程端到端）、`jsonl-bridge-runtime`（6）、
  `agent-conversation-id`（6）、`agent-runtime-interrupt-store`（7）。
- 扩展：`agent-runtime-dispatch`（turn 元数据/conversationId/interrupt 续接/sender）、
  `agent-dispatch-queue`（turnId 复用/attempt/retryAfterMs/sender）、
  `claude-runtime`（send(request) 契约）、`agent-runtime-dispatch-headless`（turn 缺省）、
  `daemon-core`（reminder payload）。
- daemon 全量 **60 文件 / 703 用例通过**；typecheck、lint（0 error / 5 既有 warning）、
  build、`git diff --check` 全部通过。

已知边界与有意推迟：

- bridge driver 仅在 `SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES=1` 注册；flag 关闭时
  langchain/langgraph 仍 `runtime-unsupported` fail-closed。
- 线格式以本节 §8 为准：`tool.start`/`tool.end` 顶层 `callId`/`input` + `tool{}`；
  ready `model.overrides`；initialize 含 `requestId`/`runtime.model`/`workspace.path`。
- `computers.ts` entrypoints 落库与 web 创建 UI 仍随 Phase 4 开放。
- SARP/1 Python SDK（`slock_runtime`）属 Phase 3——本阶段 daemon 侧契约已冻结，
  SDK 实现须与 `sarp-protocol.ts` + fixture worker 逐帧对齐。

### Phase 3：Python LangChain / LangGraph bridge（**已实施并验证**）

复杂度：高
风险：高

实施（已落地，`bridges/`）：

1. Python SARP transport——`slock_runtime/{protocol,transport,runtime}.py`：
   逐字段镜像 `sarp-protocol.ts` 的帧编解码 + 信封/schema/seq 单调校验；
   主循环 `WorkerRuntime.serve()`：initialize 握手 → ready 回显 requestId →
   串行回合（`_turn_lock` 互斥的 pending 队列）→ turn.cancel 协作取消 →
   shutdown → runtime.stopped；Windows 下 stdout 走 `.buffer` 裸 UTF-8。
2. LangChain agent adapter——`slock_runtime/langchain.py` `serve_langchain()`：
   astream_events v2 事件映射（on_chat_model_stream→delta、
   on_tool_start/end→tool 帧、usage_metadata→usage），platform
   systemPrompt 前置注入，无 durable/interrupt 能力如实上报。
3. LangGraph adapter——`slock_runtime/langgraph.py` `serve_langgraph()`：
   `configurable.thread_id = conversationId` + `slock_turn_id` 审计；
   messages/updates/custom 三模流；`__interrupt__` → InterruptRecord；
   resume → `Command(resume=value)`；checkpointer 类名判 durableThreads。
4. Slock MCP tool loader——`slock_runtime/mcp.py` `SlockMcpClient`：
   stdio JSON-RPC（initialize/tools/list/tools/call），单 client 复用，
   子进程随 worker 退出 close()，env 白名单最小继承。
5. usage / provider error mapping——`errors.py` 类名+HTTP status 双轨
   映射到 wire 码（rate limit→retryable+retryAfterMs、auth→permanent、
   5xx/网络→retryable、输入校验→permanent、未知→WORKER_ERROR）。
6. 幂等与 resume token——`idempotency.py` `TurnJournal`：
   `<workspace>/.slock/runtime-state.sqlite`（0600），turnId→终态摘要
   回放 + resume token 单次消费；interrupted 终态由 runtime 自动签发。
7. 两个可运行示例：`bridges/examples/langgraph-agent/`（CompiledStateGraph
   + SqliteSaver + interrupt 审批门）、`bridges/examples/langchain-agent/`。
8. 跨语言 contract fixtures——`bridges/fixtures/*.jsonl`：daemon 编码帧
   由 `test/sarp-contract-fixtures.test.ts` 生成（`SARP_WRITE_FIXTURES=1`
   重新生成），Python 侧 `test_contract_fixtures.py` 解码校验，反向同理。

验收结果：

- ✅ LangGraph 真机端到端：`test/sarp-langgraph-e2e.test.ts` spawn 真
  Python+真 CompiledStateGraph+真 SqliteSaver——两回合记忆、
  **worker 进程重启后 checkpoint 恢复**、conversationId 隔离、
  interrupt→Command(resume) 续跑 5/5 通过。
- ✅ 裸 SDK worker e2e：`test/sarp-python-worker.test.ts` 5/5——
  握手/回合/interrupt token 签发消费/伪造 token 拒绝/stdout 纯净违规。
- ✅ Python 单测 52+ 全绿（protocol/errors/idempotency/runtime/fixtures）。
- ✅ graph state/secret 不进帧（adapter 只透 delta/tool 摘要/finalText）。
- ⏳ LangChain 示例 MCP 调用与 rate-limit 分类由 adapter 测试覆盖；
  真实 LLM 提供商冒烟需 API key，留 CI。

差异说明：agent.id 允许空串（daemon initFields fallback 会发 `""`，
worker 侧容错解析）；resume token 签发收敛进 runtime 层而非 adapter。

### Phase 4：server / web 正式接线 ✅ 已实施

复杂度：中
风险：中

实施（2026-09-21 落码）：

1. ✅ catalog：`computerStore.CATALOG` 增加 `langchain`/`langgraph`（`kind: "bridge"`），
   web `runtimeCatalog()` 六运行时；`BRIDGE_RUNTIME_IDS` 已是 shared 单一事实源。
2. ✅ server probe 接线：`normalizeEntrypoints`（`runtime-probe.ts`，五态全集
   installed/not_installed/installed_unsupported/misconfigured/protocol_incompatible，
   剥离 command/cwd/env/secretEnv 纵深防御）→ `readySchema.entrypoints` →
   `finalizeDaemonReady` 归一化入 `DaemonMeta` + `persistComputerReady` 落库
   （`032_computers_entrypoints.sql`：`computers.entrypoints jsonb default '[]'`）→
   `GET /api/computers` / `/api/computers/me` 透出（live meta 优先，行快照兜底）。
3. ✅ web 三级创建表单（`ComputerView.vue`）：runtime 选项 = 已装 claude + 「该机上
   至少一个可用 entrypoint」聚合出的 bridge runtime；选中 bridge 后出现
   entrypoint 下拉（仅可用态）与模型下拉（select=allowlist / fixed=锁死禁用）。
   计算机页新增 Bridge entrypoints 状态卡（状态/errorCode 可见）。
4. ✅ 成员档案：`PersonProfile.entrypoint` 透出；bridge agent 的 runtime/model
   行内编辑只读（claude 选项集不适用，probe 策略锁定）。
5. ✅ rollout 开关：`SLOCK_BRIDGE_RUNTIMES=1`（`bridgeRuntimesEnabled()` 函数式读 env）；
   关时 POST/PATCH 一律 400 `runtime not wired`，UI 不出 bridge 选项。
6. ⏳ `WIRED_RUNTIME_IDS` 仍为 `["claude"]`——待真实 E2E 后放行。

门禁语义（POST 与 PATCH 同一套）：

- bridge runtime 必须显式 `entrypoint`；非 bridge runtime 携带 entrypoint → 400。
- entrypoint 必须命中**绑定机** live `meta.entrypoints`（machineKey 隔离，
  computer A 的条目对 B 天然 400 `entrypoint_unavailable`）。
- meta 缺失（离线/旧 daemon 未上报）→ fail closed。
- probe 状态仅 installed / installed_unsupported 可用；其余 → `entrypoint_not_ready`。
- fixed 模式拒模型覆盖（`model_fixed`）；select 模式限 allowlist（`model_not_allowed`）。
- PATCH 同门禁：把既有 agent 改成 bridge runtime / 换 entrypoint/model 同样复核
  probe；fixed entrypoint 切换时模型收敛回默认。

验证（server 集成测试 `agents-bridge.test.ts`，fake daemon WS ready 驱动）：

- ✅ 未配置 entrypoint 的 computer 无法创建（meta 缺失 / 条目不在该机 → 400）。
- ✅ computer A 的 entrypoint 不能用于 computer B（跨机隔离用例）。
- ✅ fixed model 不可被 API 覆盖（UI 侧下拉禁用 + server 双重校验）。
- ✅ 离线/旧 daemon fail closed（meta 缺失即拒）。
- ✅ `entrypoint_not_ready` 携带 status/errorCode；`entrypoints` API 面不泄
  command/cwd/env/secretEnv（`normalizeEntrypoints` 白名单重建 + 测试断言）。
- ✅ Claude 创建流程无回归（`agents.test.ts` Phase-1 段改写为 flag 无关断言）。
- flag 自适应：测试实例（`test-server.ts`）默认 `SLOCK_BRIDGE_RUNTIMES=1` 跑
  全矩阵；dev 回落无 flag 时只断言 fail-closed 契约。

### Phase 5：生产硬化

复杂度：中高
风险：高

实施：

1. 完成 turn/tool idempotency。
2. unknown cost 显式建模与预算策略。
3. manifest hash、变更回收和审计日志。
4. Worker crash-loop 抑制。
5. interrupt expiry、撤销和 runtime profile 变更处理。
6. Windows / Linux / macOS 进程树和路径测试。
7. 协议兼容性文档与 Worker conformance suite。

验收：

- 在 `turn.end` 前后注入崩溃均不会重复 Slock 写操作。
- Worker 连续启动失败不会无限热循环。
- runtime 切换不会复用旧 checkpoint / interrupt。
- unknown cost 不再显示为 0 美元已计量。
- 三平台至少各通过一次真实 Worker smoke test。

**实施完成（2026-09-21）**：

1. ✅ **幂等链**——`send_message`/`dispatch_task` 经 MCP 携带 `idempotencyKey`
   （`<turnId>:<tool>:<seq>`，seq 为回合内序号——重试时模型 callId 会变而序号稳定）；
   Python SDK `SlockMcpClient.call_tool` 自动注入（`set_active_turn` 由 adapter
   在 `run_turn` 挂上）。server 侧：`/messages send` 复用 `client_nonce` 唯一索引
   （agent 前缀 `ag:<agentId>:`）；`/dispatch` 迁移 033 加 `idempotency_key` 列，
   撞键返回既有行（重放语义）。
2. ✅ **unknown cost 显式建模**——账本/schema 扩 `input/output/totalTokens` +
   `unmeteredTurns`；token-only worker 记 unmetered 而非 USD 0（§14.2）；
   server sync 逐字段取最大合并；people stats / cost show / web 徽标透出「未计量」。
3. ✅ **manifest 审计**——`runtime-manifest-audit.jsonl`（manifest 旁），
   revision 变化才追加；只记 id/runtime/revision/错误码，不落 command/cwd/env/secret；
   审计写失败不阻塞加载。
4. ✅ **crash-loop 熔断**——`agent-runtime-crash-guard.ts`：按
   `(agentName, profile identity)` 计连续 worker 启动/生命周期失败，阈值熔断 +
   递增冷却 + 探测窗 + 成功回合复位 + identity 变更自动复位 + `unregisterAgent` 显式
   reset。熔断期派发走非重试 `worker-crash-loop` 错误直接死信（不再热 spawn）。
5. ✅ **runtime 切换隔离**——`initialize.runtime.revision`（manifest 条目 sha256）
   下发；Python SDK 组 `thread_id = runtime:entrypoint:revision:model:conversationId`，
   任何 identity 分量变化不命中旧 LangGraph checkpoint；interrupt 记录带 revision，
   identity 变更主动 `clearIncompatible`。
6. ✅ **进程树 kill**——`process-tree.ts`：POSIX `detached` 建进程组 +
   `kill(-pgid)`，Windows `taskkill /T`；优雅/强杀两级；MCP 孙进程不再成孤儿。
   测试经 `killTree` 注入保持可断言。
7. ✅ **conformance suite + 协议文档**——`sarp-conformance.ts` 可复用 runner
   （handshake / seq 单调 / 回合终态唯一 / eventSeq / cancel / 坏帧容错或
   fail-closed / journal 回放 / shutdown 干净退出），
   `test/sarp-conformance.test.ts` 对 fixture 跑健康+5 故障矩阵；
   协议规范独立成文 `docs/2026-09-21/02-sarp1-protocol.md`。

---

## 20. 测试方案

### 20.1 单元测试

| 模块 | 必测场景 |
|---|---|
| runtime profile | 默认 Claude、runtime 字段冲突、entrypoint required、model allowlist、identity 稳定性 |
| registry | 正确 driver、未知 runtime、重复 driver |
| manifest | 权限、schema、重复 ID、cwd、secretEnv、禁止覆盖 SLOCK 变量 |
| protocol codec | 正常帧、超长帧、坏 JSON、版本错误、seq 错误、未知事件、终止后事件、interrupt 字段冲突 |
| conversation ID | thread、channel、DM、triage、reminder、长 ID hash |
| interrupt store | 写入、恢复、过期、单次消费、runtime 切换清理 |
| event normalization | text、tool、usage、interrupt、reply guard |
| cost | per-turn、missing USD、token-only、Claude cumulative delta |
| error classifier | permanent、retryable、wire code 映射、retryAfter 与指数退避合并上限 |

### 20.2 Driver contract tests

同一套 contract suite 跑：

- Claude persistent session fake
- Claude one-shot fake
- JSONL bridge fixture

Contract 断言：

1. initialize 只执行一次。
2. send 串行。
3. 每 turn 一个 terminal result。
4. stop 幂等。
5. process exit reject active turn。
6. silence timeout 清理进程。
7. session identity 不匹配不复用。
8. cancel 不影响下一个 turn。

### 20.3 Bridge 集成测试

fixture Worker 支持参数化行为：

- 正常文本流。
- tool start / end。
- usage token-only。
- usage with USD。
- interrupt / resume。
- stderr 日志。
- stdout 坏 JSON。
- frame oversize。
- 不发送 ready。
- turn 中退出。
- 重复 `turn.end`。
- 错误 turn ID。
- 收到 cancel 后结束。
- shutdown 超时。

### 20.4 LangGraph 真实测试

至少覆盖：

1. SQLite checkpointer 保存两轮上下文。
2. Worker 重启后同 conversation 恢复。
3. 不同 threadId 不串状态。
4. 不同 agent 即使 entrypoint 相同也不串 state namespace。
5. `interrupt()` 产生审批提示。
6. `Command(resume=value)` 恢复到正确 checkpoint。
7. tool error 映射为观察事件，不破坏 protocol。
8. graph exception 生成正确 error code。
9. model streaming 与 non-streaming 都产生 finalText。

### 20.5 安全测试

- server profile 注入 command 无效。
- manifest arg 不经 shell 扩展。
- secret 不出现在 ready payload、stdout error、stderr summary、WS observation。
- Worker 无法覆盖 token file path。
- agent A 的 Worker 不读取 agent B token file。
- protocol payload 中的 `sk_agent_` / `sk_machine_` 经出口脱敏。
- 超大 tool output 被截断。
- command hash 或 manifest revision 改变会回收旧进程。

### 20.6 验证命令

每一阶段至少运行：

```bash
npx tsc --noEmit -p packages/daemon/tsconfig.json
pnpm vitest run
pnpm typecheck
pnpm lint
pnpm build
```

Python bridge 增加自己的 format、typecheck 和 test 命令，并在引入 Python 工程时固定到仓库配置中。首个实现 PR 必须同时落 conformance fixtures，不能只靠人工运行示例验收。

---

## 21. 兼容性与迁移

### 21.1 老 agent

- 无 runtime 字段：默认 Claude。
- 现有 model 字段：按 Claude 现状处理。
- 现有 session store：不迁移到 bridge。
- 现有 workspace：保留。
- 现有 MCP 与 scoped token：复用。

### 21.2 老 daemon / 新 server

server 只有在目标 computer 的 ready payload 明确上报 bridge runtime 与 entrypoint 后才允许创建。旧 daemon 不会上报，因此不会收到无法执行的 agent。

### 21.3 新 daemon / 老 server

新字段均为 optional；新 daemon 对缺失 runtime 的 agent 使用 Claude。entrypoint probe 可作为 ready payload 可选扩展，老 server 忽略即可。

### 21.4 runtime 切换

从 Claude 切到 LangGraph 或反向切换时：

1. 停止旧 session。
2. 清理旧 scoped token 文件并按现有流程换发。
3. 清理不兼容 pending interrupt。
4. 不删除旧 provider 的 checkpoint 或 Claude session 文件。
5. 用新 runtime identity 启动。
6. 在 agent 状态中记录切换结果。

保留旧 checkpoint 是为了可回滚；清理应由明确的管理动作完成，不能在配置切换时自动破坏数据。

---

## 22. 风险登记

| 风险 | 严重度 | 缓解 |
|---|---:|---|
| 用户误以为 daemon 会自动托管 Python 环境 | 高 | UI 和文档明确 entrypoint 必须本机预配置，probe 给出缺失项 |
| Worker 任意代码能力高于 Claude allowedTools | 高 | 本地 manifest、OS 隔离建议、scoped Slock token、明确信任边界 |
| retry 导致外部副作用重复 | 高 | 稳定 turnId、Worker result cache、MCP idempotency key |
| LangChain / LangGraph API 版本变化 | 高 | SDK 层吸收版本差异，daemon 只依赖 SARP/1 |
| graph state 泄漏到观察流 | 高 | output mapper allowlist、payload size、redaction、禁止默认发送完整 state |
| 成本缺失导致预算失真 | 高 | unknown 显式建模、requireCostUsd、UI 警告 |
| stdout 日志破坏 JSONL | 中 | SDK logging 默认 stderr、严格协议 parser、清晰错误 |
| token delta 事件过多 | 中 | SDK 50ms 合并、daemon 节流、bounded queue |
| entrypoint 更新后复用旧进程 | 中 | manifest revision 纳入 identity，变更即回收 |
| 同 entrypoint 多 agent 状态串线 | 高 | per-agent process、agentId namespace、隔离 checkpoint namespace |
| interrupt 无人响应长期占用 | 中 | interrupt TTL、状态可见、管理员取消 |
| Windows 路径与进程树差异 | 中 | command/args 数组、无 shell、三平台 integration test |

---

## 23. 发布门槛

只有同时满足以下条件，才能把 `langchain` / `langgraph` 加入 `WIRED_RUNTIME_IDS`：

- Claude driver 抽取完成且全部回归通过。
- runtime profile 真正贯穿 daemon，不再丢弃 runtime。
- server 依据目标 computer 的 entrypoint probe fail closed。
- SARP/1 conformance suite 通过。
- LangChain 示例完成消息、tool、finalText、usage 流程。
- LangGraph 示例完成 durable checkpoint、进程重启与 interrupt/resume。
- scoped token 不进入 Worker 明文 env。
- stderr、观察帧和 ready payload 通过 secret 泄漏测试。
- unknown cost 在 UI 与账本中明确标识。
- crash retry 的 Slock 写操作具备 idempotency。
- PTY Claude fallback 未被新代码改变。
- Windows 本机完成真实 smoke test，Linux CI 完成进程与协议集成测试。

如果只完成 bridge driver 而没有官方 Worker SDK、示例、probe 和安全校验，runtime 只能保持 `installed_unsupported` 或 experimental，不得对普通用户开放。

---

## 24. 最终建议

推荐按以下顺序推进：

1. **先完成 Phase 0**：把 Claude 变成一个 driver，验证抽象没有破坏现有主链。
2. **再完成 Phase 1 和 Phase 2**：打通 runtime profile、本地 manifest 与 SARP/1。
3. **用 LangGraph 作为第一个 bridge 验证对象**：它同时覆盖常驻进程、stream、checkpoint、thread、interrupt 和 tool，最能检验抽象是否足够通用。
4. **在同一个 Python SDK 中补 LangChain adapter**：LangChain Agent 与 LangGraph 共享大部分消息、tool 和 usage 逻辑。
5. **最后开放 server / web 创建入口**：在 entrypoint probe、安全与幂等未完成前，不提前把 runtime 标记为 wired。

这条路径不会重写现有 daemon。队列、状态机、上下文、token、MCP、观察、成本和空闲回收仍作为通用平台层保留；主要变化集中在 Claude 类型退出通用层、建立 driver contract、增加 bridge transport 和提供 Worker SDK。

完成后，新增一个本地 agent framework 的标准成本应收敛为：

1. 实现或复用 SARP/1 Worker SDK。
2. 在本机 manifest 注册 entrypoint。
3. 声明 capabilities、model policy 与 checkpoint 策略。
4. 通过 conformance suite。
5. 在 catalog 与 UI 中开放 runtime ID。

而不再需要修改 daemon 的队列、状态机、观察总线和核心 dispatch 逻辑。
