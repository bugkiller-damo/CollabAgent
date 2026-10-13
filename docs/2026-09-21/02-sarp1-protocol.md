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
- **R-UF（未知字段容忍）**：已知 `type` 帧中出现本规范未列出的字段时，
  接收方 **MUST** 忽略之；发送方 **MUST NOT** 依赖这些字段被理解。
  新增可选语义一律以可选字段的形式在**同一协议版本**内引入（不加版本号）；
  接收方的字段级容忍度与帧级可选帧容忍度一致。畸形可选字段
  （类型不对/枚举值非法/条目缺必填项）由接收方过滤或整体丢弃，
  不得因此判协议违例——协议违例仅限 §1/§6 列出的必填条件破坏。

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
    "id": "bridge",                  // runtime catalog id（规范值 "bridge"；
                                     // langchain/langgraph 为旧别名，按归一值比对）
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
  "runtime": { "id": "bridge", "frameworkVersion": "0.4.x", "bridgeVersion": "1" },
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
| `turn.interrupt{interruptId,resumeToken,prompt,payload?,options?}` | 审批门等中断通知 |
| `turn.end{status,finalText?,sessionRef?,usage?,interrupt?,error?}` | **终态，每回合恰好一个** |

`turn.end.status` ∈ `success | error | cancelled | interrupted`：

- `success`：可带 `finalText`/`sessionRef`/`usage`
- `error`：必须带 `error{code,message,retryable,retryAfterMs?}`；
  未知 code 由 daemon 映射为永久的 `worker-error`
- `interrupted`：必须带 `interrupt{interruptId,resumeToken,prompt?,options?}`，
  daemon 落 pending interrupt 等待 resume
- `cancelled`：`turn.cancel` 生效

### interrupt.options（可选，R-UF）

`turn.interrupt` 与 `turn.end.interrupt` 均可携带 `options`，
供平台审批面渲染结构化选项（无 options 时退回纯文本 prompt 审批）：

```jsonc
"options": {
  // 本 interrupt 接受的结构化决定类型（白名单枚举；非法项由接收方丢弃）
  "decisions": ["approve", "reject", "respond", "edit"],
  // 待审批动作预览（≤10 条；name 必填非空，缺/空 name 的条目丢弃）
  "actions": [
    { "name": "send_email", "args": { "to": "a@b.c" }, "description": "发送确认邮件" }
  ]
}
```

- `decisions` 枚举：`"approve" | "reject" | "respond" | "edit"`。
- `actions[].args` 是任意 JSON——daemon 出站摘要时经 `JSON.stringify` →
  脱敏 → 截断为 `argsPreview`（≤500 字符）；**原始 args 不出 daemon**。
- 同一 `interruptId` 的 `turn.interrupt` 预览帧与 `turn.end.interrupt`
  规范记录之间，`options` 不要求一致——daemon 的一致性校验只覆盖
  `interruptId/resumeToken/prompt` 三字段；规范来源以 `turn.end` 为准。

## 4. 控制帧（daemon→worker）

```jsonc
{ "type": "turn.start", "turnId": "...", "conversationId": "...",
  "attempt": 1, "source": { "kind": "message", "channel": "..." },
  "prompt": "...",
  "message": { "text": "...", "sender": "...", "messageId": "...",
               "attachments": [ { "id": "...", "filename": "...",
                                  "mimeType": "...", "sizeBytes": 123, "url": "..." } ] }?,
  "contextText": "..."?,
  "resume": { "interruptId": "...", "resumeToken": "...",
              "value": "...", "decision": { "type": "..." }? }? }

{ "type": "turn.cancel", "turnId": "...", "reason": "..." }

{ "type": "shutdown", "reason": "...", "timeoutMs": 5000 }
```

`turn.start` 必填：`turnId / conversationId / attempt / source / prompt`。
`prompt` 语义不变——平台组装好的完整文本（平台指令 + 历史信封 +
触发消息），**旧 worker 只消费 `prompt` 即可正常工作**（R-UF 兼容性）。

以下为可选字段（全部 R-UF——旧 worker 忽略即可，daemon 不依赖回执）：

- `message`（可选）：触发本回合的**人类消息原文**（不含平台指令与
  历史信封）。reminder/patrol/triage/nudge 等非人类来源回合缺省。
  - `text`：原始文本（daemon 队列合并批次按 `"\n\n"` 拼接）。
  - `sender`：人类发送者名（与 `source.sender` 同源）。
  - `messageId`：平台消息 id。
  - `attachments[]`：结构化附件 `{id, filename, mimeType, sizeBytes, url?}`——
    `url` 仅当平台已知时下发，daemon 绝不凭空构造；合并批次顺序拼接。
    与 `prompt` 内的附件文本摘要并存，互不替代。
- `contextText`（可选）：平台注入的会话历史信封文本（与 `prompt`
  中内嵌的历史同源、同文）。仅 bridge runtime 下发——Claude runtime
  的 prompt 已内嵌历史，不再重复。worker 可把它喂给框架自己的
  history/checkpoint 通道而非拼进 user turn。
- `resume.value`（必填于 resume 出现时）：人类对上次 interrupt 的
  **回复原文**（`message.text` 合并值），不是组装后的 `prompt`；
  无非人类原文批次时退回合并内容文本。
- `resume.decision`（可选）：审批按钮产出的结构化决定——
  `{type:"approve"} | {type:"reject",message?} | {type:"respond",message}`
  `| {type:"edit",args}`。daemon **不从回复文本推断决定**；
  无结构化来源（纯文本回复）时缺省，worker 退回文本语义。

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
thread_id = f"{entrypoint}:{revision}:{model}:{conversation_id}"
```

任一 identity 分量变化（换 entrypoint、manifest 修改、换模型）即不与旧
checkpoint 碰撞。`runtime.revision` 来自 manifest 条目 sha256。runtime.id
不是分量——entrypoint 已唯一标识 worker（runtime 标识统一为 `bridge`
后，旧 5 段格式一次性废弃，checkpoint thread 重新开始）。

## 8. probe 模式

`command --slock-probe`：不进入服务循环，打印**单行** `probe.result` 帧
（`probe:true` + `runtime.id` + `runtime.frameworkVersion` +
`runtime.bridgeVersion` + `capabilities` + `model`）后 `exit(0)`。
daemon 用它做 entrypoint 可用性门禁（15s 超时）。

Python SDK 侧该分支由 `WorkerRuntime.serve` 内置实现：判定只看
`sys.argv[1:]`，在读 stdin、开 journal、调 `on_initialize`、建
graph/model、起 MCP 之前返回；`capabilities` 取 adapter 声明的静态基线
（握手期 `on_initialize` overrides 仍是权威），`model` 取 `probe_model`
（adapter 报 `{"overrides": true}`）。worker 源码不应再自写 probe 分支。

## 9. Conformance

`packages/daemon/src/sarp-conformance.ts` 提供可复用 runner：

```ts
import { runSarpConformance } from "./sarp-conformance.js";

const report = await runSarpConformance({
  spawnSpec: { command: "python", args: ["agent.py"], cwd: "...", env: {...} },
  runtimeId: "bridge",           // 期望的 ready.runtime.id（归一比较：旧别名按规范值判定）
  entrypoint: "my-ep",
  expectJournal: true,           // slock_runtime SDK worker → true
});
// report.checks → handshake / seq-monotonic / turn-lifecycle /
// eventseq-monotonic / cancel / malformed-stdin / replay / shutdown(-exit)
```

检查项与上文 §1–§6 一一对应；`report.ok=false` 时按 check 名定位违例。
