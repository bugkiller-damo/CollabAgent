# SARP/1 协议规范（slock.agent-runtime v1）

> daemon ↔ agent worker 的进程间协议。daemon 通过本机 manifest 注册的
> `command` spawn 用户自己的 worker 进程，stdin/stdout 承载 newline-delimited
> JSON（JSONL）帧。worker 日志一律走 **stderr**；stdout 上只允许协议帧。
>
> 实现参考：`bridges/python/slock_runtime/`（Python SDK）、
> `packages/daemon/src/drivers/persistent-jsonl-worker.ts`（daemon 侧会话）、
> `packages/daemon/test/fixtures/sarp-worker.mjs`（可控协议桩）。

## 1. 传输与信封

| 项 | 值 |
|---|---|
| 协议名 | `slock.agent-runtime` |
| 版本 | `1` |
| 编码 | UTF-8，每行一个 JSON 对象（`\n` 分隔，`\r\n` 需容忍） |
| 最大帧 | 1 MiB（超限断开为协议违例） |
| 方向 | daemon→worker：worker stdin；worker→daemon：worker stdout |

所有帧共享信封字段：

```jsonc
{
  "protocol": "slock.agent-runtime",   // 必填，精确匹配
  "version": 1,                        // 必填
  "seq": 1,                            // 必填，每方向各自从 1 严格递增
  "timestamp": "2026-09-21T00:00:00.000Z", // 必填，ISO8601
  "type": "...",                       // 帧类型
  // ...帧负载
}
```

- `seq` 必须是**每方向单调递增**的整数，从 1 开始。回归即协议违例。
- 未识别的 `type`：可选帧（发送方标 `optional: true`）可忽略；必需帧不可忽略。

## 2. 生命周期

```text
daemon ──spawn──> worker（stdin/stdout 接管）

daemon ──initialize──> worker
worker ──runtime.ready | runtime.error──> daemon   （握手）

loop:
  daemon ──turn.start──> worker
  worker ──assistant.delta / assistant.message / assistant.progress /
          tool.start / tool.end / usage / turn.interrupt──> daemon
  worker ──turn.end──> daemon                        （终态，恰好一个）

daemon ──shutdown──> worker
worker ──runtime.stopped──> daemon
worker exit 0
```

### initialize（daemon→worker，第一帧且唯一）

```jsonc
{
  "type": "initialize",
  "requestId": "...",                // worker 须在 ready/error 回显
  "agent": { "id": "...", "name": "..." },
  "runtime": {
    "id": "langgraph",               // runtime catalog id
    "entrypoint": "my-ep",           // manifest 条目 id
    "model": "openai:deepseek-chat", // 可选，server 选择的模型
    "revision": "sha256:..."          // 可选，manifest 条目 revision（checkpoint 命名空间用）
  },
  "workspace": { "path": "..." },     // agent 工作目录（worker 状态/日志的根）
  "platform": { "mcp": { ... } },     // 可选，平台 MCP 端点描述
  "limits": {
    "maxFrameBytes": 1048576,
    "silenceTimeoutMs": 300000,
    "shutdownTimeoutMs": 5000
  }
}
```

### runtime.ready / runtime.error（worker→daemon）

```jsonc
{
  "type": "runtime.ready",
  "requestId": "<echo>",
  "runtime": { "id": "langgraph", "frameworkVersion": "0.4.x", "bridgeVersion": "1" },
  "capabilities": {
    "persistentProcess": true,   // 进程常驻多回合
    "streamingText": true,       // 会发 assistant.delta
    "toolEvents": true,          // 会发 tool.start/tool.end
    "durableThreads": true,      // 跨进程会话状态
    "interrupts": true,          // 支持 interrupt/resume
    "mcp": true,                 // 会消费 platform.mcp
    "usage": "tokens",           // "tokens" | "cost" | "none"
    "pty": false,
    "maxConcurrency": 1
  },
  "model": { "selected": "openai:deepseek-chat", "overrides": true }
}
```

握手失败回 `runtime.error{error:{code,message,retryable}}` 并退出。

## 3. 回合帧（worker→daemon）

回合帧额外带 `turnId`（匹配 `turn.start.turnId`）与 `eventSeq`
（**回合内从 1 严格递增**）。

| type | 语义 |
|---|---|
| `assistant.delta{text}` | 流式文本片段 |
| `assistant.message{text}` | 完整消息块（非流式） |
| `assistant.progress{message}` | 进度提示（节流展示） |
| `tool.start{callId,tool:{name,provider,operation},input?}` | 工具调用开始 |
| `tool.end{callId,tool:{...},ok,output?,error?}` | 工具调用结束 |
| `usage{usage:{inputTokens,outputTokens,totalTokens,durationMs,model}}` | token 用量（`costUsd` 缺省 = 未计量，不得伪造 0） |
| `turn.interrupt{interruptId,resumeToken,prompt,payload?}` | 审批门等中断通知 |
| `turn.end{status,finalText?,sessionRef?,usage?,interrupt?,error?}` | **终态，每回合恰好一个** |

`turn.end.status` ∈ `success | error | cancelled | interrupted`：

- `success`：可带 `finalText`/`sessionRef`/`usage`
- `error`：必须带 `error{code,message,retryable,retryAfterMs?}`；
  未知 code 由 daemon 映射为永久的 `worker-error`
- `interrupted`：必须带 `interrupt{interruptId,resumeToken,prompt?}`，
  daemon 落 pending interrupt 等待 resume
- `cancelled`：`turn.cancel` 生效

## 4. 控制帧（daemon→worker）

```jsonc
{ "type": "turn.start", "turnId": "...", "conversationId": "...",
  "attempt": 1, "source": { "kind": "message", "channel": "..." },
  "prompt": "...", "resume": { "interruptId": "...", "resumeToken": "..." }? }

{ "type": "turn.cancel", "turnId": "...", "reason": "..." }

{ "type": "shutdown", "reason": "...", "timeoutMs": 5000 }
```

## 5. 幂等与恢复（§15.4）

- **turnId 稳定**：daemon 对同一队列项的重试复用相同 `turnId`。
  worker 须实现 turn journal：`turn.start` 到达时查 journal，
  已有终态记录 → **直接回放终态帧，不重跑 handler**。
- **先落 journal 再发终态**：`turn.end` 帧发出前把终态写进 journal；
  worker 崩溃重启后 daemon 重发同 `turnId`，回放已存终态。
- **resume token 单次使用**：interrupted 终态签发 token；
  `turn.start.resume` 消费时校验（token + interruptId + conversationId），
  消费即焚。
- **写操作幂等键**：worker 经 MCP 调平台写接口（`send_message`/`dispatch_task`）
  必须携带 `idempotencyKey`（`<turnId>:<tool>:<seq>`——seq 用回合内序号而非
  模型 callId，重试时 callId 会变但序号稳定）。server 侧按键去重。

## 6. 错误与退出纪律

- **未知可选帧**：忽略（发送方 `optional:true`）。
- **无法解析的入向行**：两种合规行为——(a) 忽略继续服务；(b) `runtime.error`
  后 `exit(非零)` fail-closed。不合规：静默挂死。
- **协议违例**（首帧非 initialize、seq 回归、必需字段缺失）：
  `runtime.error{code:"PROTOCOL_VIOLATION",retryable:false}` → `exit(2)`。
- **正常退出**：`shutdown` → `runtime.stopped{reason}` → `exit(0)`。
- **进程树**：worker 的子进程（MCP server 等）必须随 worker 终止——
  POSIX 由 daemon 组杀（worker 不得自建新进程组脱离），Windows 走 `taskkill /T`。

## 7. checkpoint / thread 隔离

`durableThreads` runtime（如 LangGraph）的内部会话键必须命名空间化：

```text
thread_id = f"{runtime.id}:{entrypoint}:{revision}:{model}:{conversation_id}"
```

任一 identity 分量变化（换 entrypoint、manifest 修改、换模型）即不与旧
checkpoint 碰撞。`runtime.revision` 来自 manifest 条目 sha256。

## 8. probe 模式

`command --slock-probe`：不进入服务循环，打印**单行** `probe.result` 帧
（`probe:true` + `runtime.id` + `capabilities` + `model`）后 `exit(0)`。
daemon 用它做 entrypoint 可用性门禁（15s 超时）。

## 9. Conformance

`packages/daemon/src/sarp-conformance.ts` 提供可复用 runner：

```ts
import { runSarpConformance } from "./sarp-conformance.js";

const report = await runSarpConformance({
  spawnSpec: { command: "python", args: ["agent.py"], cwd: "...", env: {...} },
  runtimeId: "langgraph",        // 期望的 ready.runtime.id
  entrypoint: "my-ep",
  expectJournal: true,           // slock_runtime SDK worker → true
});
// report.checks → handshake / seq-monotonic / turn-lifecycle /
// eventseq-monotonic / cancel / malformed-stdin / replay / shutdown(-exit)
```

检查项与上文 §1–§6 一一对应；`report.ok=false` 时按 check 名定位违例。
