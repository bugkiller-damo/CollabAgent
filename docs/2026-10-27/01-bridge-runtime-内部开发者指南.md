# Bridge Runtime（SARP/1）内部开发者指南

> 面向内部开发者的 LangChain/LangGraph bridge worker 开发与接入指南。
> 覆盖：架构与职责、协议生命周期、平台注入内容、SDK API、上手步骤、
> 配置参考、排障、验证结果与已知问题。协议权威定义仍以
> `docs/2026-09-21/02-sarp1-protocol.md` 与 `packages/daemon/src/sarp-protocol.ts` 为准；
> 对外安装/分发见 `docs/2026-09-21/04-python-agent-quickstart.md`。
> 本文所有「输出示例」均为 2026-10-27 本机实机截取（Windows 11 + CPython 3.12.14）。

## 0. 摘要

- bridge runtime 是 daemon 的**第二种 agent driver**：daemon 不实现任何 agent，只定义
  `slock.agent-runtime` v1（SARP/1）JSONL 协议并 spawn 外部进程。你的 Python worker
  自带 agent 逻辑，daemon 负责握手、回合派发、取消、审批路由、熔断与回复代发。
- 与 Claude CLI 同构：Claude（`drivers/claude-runtime.ts` spawn `claude` CLI）和
  bridge（`drivers/jsonl-bridge-runtime.ts` spawn manifest 声明的命令）是同一
  `AgentRuntimeDriver` 契约（`agent-runtime-driver.ts`）下的对等 driver。
- **内部可用**：SDK 0.2.0 经本地验证可跑通全链路（详见 §9），但必须满足三个前提：
  包未上 PyPI（用源码 editable 或本地 wheel 安装）、两侧实验 flag 显式打开
  （server `SLOCK_BRIDGE_RUNTIMES=1` + daemon `SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES=1`）、
  接受 §10 列出的已知限制（未上 PyPI、HEAD 未经远端 CI 验证等）。

## 1. 架构与职责划分

### 1.1 进程拓扑

```
┌─────────┐   HTTP/WS    ┌────────────────┐  stdin/stdout JSONL (SARP/1)  ┌──────────────────────┐
│  server │ ◄──────────► │ daemon (Node)  │ ◄──────────────────────────► │ worker (Python, 你的) │
│         │              │                │                              │  ├─ slock_runtime SDK │
│ agents/ │              │ manifest 查找   │                              │  │  (协议+adapter)     │
│ 消息路由 │              │ spawn/probe/   │                              │  └─ 你的 agent/graph  │
│ 审计/记账│              │ 派发/熔断/代发  │                              └──────────┬───────────┘
└────▲────┘              └───────┬────────┘                                         │ stdio MCP
     │                           │                                                  ▼
     │                           │                                    ┌──────────────────────────┐
     │                           │                                    │ slock-mcp-server.cjs     │
     └───────── HTTP API ────────┼────────────────────────────────────│ (Slock 协作工具子进程)    │
        send_message 等工具回调    └──────── mint scoped token 文件 ────►│ node + token file → server│
                                     注入 worker env                  └──────────────────────────┘
```

- worker 与 daemon 是**父子进程**关系：daemon 按 manifest `command`/`args`/`cwd`
  拉起 worker（`shell: false`），stdin/stdout 逐行 JSON 帧，stderr 是 worker 的日志面。
- Slock MCP server 是**另一个孙进程**：daemon 在 `initialize.platform.mcp` 里下发
  stdio 描述符（`command: "node"`, `args: ["<slockDir>/slock-mcp-server.cjs"]`），
  由 SDK 的 `SlockMcpClient` 拉起（`bridges/python/slock_runtime/mcp.py:79-91`）。
  MCP server 经 `SLOCK_AGENT_TOKEN_FILE` 读 scoped token 调 server HTTP API。
- daemon 全程**不直连任何 LLM provider**——`initialize.runtime.model` 是不透明选择
  标识，worker 自行解释为 provider client（`langchain.chat_models.init_chat_model`）。

### 1.2 Claude vs bridge 对照

| 维度 | Claude（默认 driver） | bridge（SARP/1 worker） |
|------|----------------------|--------------------------|
| agent 本体 | Claude Code CLI 自带完整 agent（工具循环/文件操作/会话 resume） | **开发者自带**；SDK 只桥协议，不建模型/图 |
| 协议 | `--input-format/--output-format stream-json`（`drivers/persistent-claude.ts`） | `slock.agent-runtime` v1 JSONL（`sarp-protocol.ts`） |
| 会话模型 | CLI 会话，`sessionId` 温启动 resume | 常驻 worker 进程；线程隔离靠 LangGraph checkpoint thread_id |
| 回复通道 | 必须调 `send_message` 工具/`slock` CLI；回复守卫 `SLOCK_REPLY_GUARD` 兜底 | `turn.end.finalText` 由 daemon 自动代发（见 §4.3），不受 `SLOCK_REPLY_GUARD` 影响 |
| MCP 工具注入 | workspace 写 `.mcp.json` + `.claude/settings.local.json`（`agent-mcp-config.ts`） | `initialize.platform.mcp` 描述符带内下发（`agent-runtime-dispatch-headless.ts:292-301`） |
| 系统提示 | 写 `system-prompt` 文件交给 CLI | `initialize.platform.systemPrompt` 字段，SDK 以 SystemMessage 注入 |
| runtime 声明 | 内建默认，不进 manifest | manifest 条目 `runtime: "bridge"`（旧别名 `langchain`/`langgraph` 归一） |
| entrypoint | 无（`entrypoint not allowed`） | 必选；server 只认稳定 entrypoint id，命令不跨进程边界 |

### 1.3 三方职责

| 方 | 职责 |
|----|------|
| daemon | manifest 校验/缓存、静态 fail-fast（command/cwd/secret）、spawn + 握手校验（runtime.id 归一比对、maxConcurrency=1、requireDurableThreads、requestId 回显）、回合派发与沉默超时、interrupt 持久化 + resume 路由、turn.cancel、shutdown、回复代发、crash-loop 熔断、probe/CLI |
| `slock-runtime` SDK | 帧编解码与 seq 纪律、`--slock-probe` 内置、握手与 runtime.id 校验、`serve_agent` 对象分派、turn→graph/Runnable 输入映射、stream 事件→协议帧、finalText 提取、interrupt/resume（含 HITL 文本归类）、turn 幂等 journal（含 resumeToken 单次消耗）、Slock MCP client + `SlockStructuredTool`、provider 异常→wire 错误码映射 |
| 开发者（你） | 提供 `CompiledStateGraph` / LangChain Runnable / `factory(init, tools)`；解释 `init.model` 为 provider client；管理 provider 凭据（secretEnv/secretRefs/自管）；需要 durable 线程时挂 checkpointer；自定义审批文案/决定归约/输入输出映射 |

## 2. 代码地图

### 2.1 daemon（`packages/daemon/src/`）

| 文件 | 作用 |
|------|------|
| `agent-runtime-driver.ts` | driver/session 契约（`send`、`cancelTurn?`、`stop`）；`AgentTurnRequest` 含 `message`/`contextText`/`resume` |
| `drivers/jsonl-bridge-runtime.ts` | bridge driver 工厂：manifest 查条目 → 静态 fail-fast（`cwd-not-found`/`command-not-found`/`secret-env-missing`/`secret-ref-missing`）→ env 合成（manifest env + secrets + 平台 `SLOCK_*` 最后胜出）→ `PersistentJsonlWorkerSession` |
| `drivers/persistent-jsonl-worker.ts` | worker 会话：initialize 握手校验（`runtime-id-mismatch`/`protocol-violation`/`durable-threads-required`/requestId 回显）、回合 seq/eventSeq、沉默超时 `runtime-silence-timeout`、`stop()`=turn.cancel→等 1.5s→shutdown→`runtime.stopped`、journal 终态回放 |
| `agent-runtime-manifest.ts` | manifest 解析 + `validateEntry`（fail-closed，错误码见 §8.2） |
| `runtime-manifest-manager.ts` | manifest CRUD + probe 快照合并 + 审计日志 |
| `agent-runtime-profile.ts` | agent 档案 `{runtime,model,entrypoint}` → 解析：runtime 归一、entrypoint 存在/runtime 匹配/model allowlist 校验、`promptProfile` 缺省 `neutral`、identity（runtime+model+entrypoint+entry revision 哈希） |
| `drivers/runtime-entrypoint-probe.ts` | `--slock-probe` 子进程探测（15s 超时，要求恰好一行），产出 `installed_unsupported` 等状态 |
| `system-prompt.ts` | `generateBridgeSystemPrompt`：neutral/agentic 两档平台提示（§4.1） |
| `bridge-turn-prompt.ts` | 回合 prompt 模板：消息/私信/巡检/提醒/分诊（§4.2） |
| `agent-runtime-interrupt-store.ts` | pending interrupt 持久化 `<slockDir()>/daemon-runtime-interrupts.json`，(agentId, conversationId) 键、resumeToken 一次性 |
| `runtime-secret-store.ts` | `secretRefs` 取值源 `<slockDir()>/runtime-secrets.json`（0600，list 只见名不见值） |
| `runtime-diagnostics.ts` + `runtime-probe-snapshot.ts` + `runtime-entrypoint-refresh.ts` | `doctor` 数据源：last probe 快照 + lastError 诊断（`<slockDir()>/runtime-diagnostics.json`） |
| `agent-runtime-crash-guard.ts` | crash-loop 熔断：连续生命周期失败达阈值→指数冷却→`worker-crash-loop` fail-closed；成功回合复位 |
| `process-tree.ts` | 进程树终止（POSIX pgid / Windows `taskkill /T`） |
| `sarp-protocol.ts` | 帧类型 + 编解码 + `decodeSarpWorkerFrame` + `WIRE_ERROR_MAP`（daemon 帧：`initialize`/`turn.start`/`turn.cancel`/`shutdown`；worker 帧见 §3） |
| `sarp-conformance.ts` | `runtime check` 合规 runner（9 项检查，§9） |
| `cli/runtime.ts` | `slock runtime` 子命令实现 |
| `schemas/runtime-manifest.schema.json` | manifest JSON Schema（编写辅助；`validateEntry` 才是权威） |
| `agent-runtime-dispatch-headless.ts` | spawn 组装：scoped token、MCP 描述符、platformPrompt、crash-guard 前置 |
| `agent-runtime-dispatch-stream.ts` | 事件消费 + **回复守卫/finalText 代发**（§4.3） |
| `agent-conversation-id.ts` | 稳定 conversationId 分类（thread/channel/dm/triage/reminder） |
| `config.ts` / `private-dir.ts` | `SLOCK_*` 统一读取；`slockDir()`（`SLOCK_STATE_DIR` 覆盖，默认 `cwd/.slock`） |

### 2.2 Python SDK（`bridges/python/slock_runtime/`，包名 `slock-runtime` 0.2.0）

| 模块 | 作用 |
|------|------|
| `agent.py` | **`serve_agent` 统一入口** + 共享内核（MCP client、`SlockStructuredTool`、常驻事件循环 `_AsyncLoop`、分派、握手字段） |
| `runtime.py` | `WorkerRuntime.serve` 主循环：probe 内置、journal 回放、`run_turn` 编排、`TurnEmit`（delta/message/progress/tool.*/usage/interrupt）、`TurnOutcome`、`InterruptRecord`、resumeToken 签发/消耗 |
| `protocol.py` | wire dataclass：`SarpInitialize`/`SarpTurnStart`/`SarpResume(Decision)`/`SarpMcpDescriptor`/`normalize_runtime_id` |
| `langgraph.py` | 图路径：input/output/interrupt/resume mapper、astream_events→帧、`checkpoint_thread_id`、HITL 决定归约、`durableThreads` 检测、执行模式判定 |
| `langchain.py` | Runnable 路径（无状态）：输入映射、事件→帧、`interrupts:false`/`durableThreads:false` |
| `mcp.py` | `SlockMcpClient`：spawn stdio MCP 子进程、`tools/list`/`tools/call`、幂等键 `{turnId}:{tool}:{seq}` |
| `idempotency.py` | `TurnJournal`：`<workspace>/.slock/runtime-state.sqlite`（0600），turnId 终态回放 + resumeToken 单次消耗 |
| `errors.py` | wire 错误码常量 + `SarpError` + provider 异常映射 `map_provider_error` |
| `transport.py` / `tool_events.py` | stdout 帧写出（唯一协议面）；tool.start/tool.end provider/operation 判定 |
| `_version.py` | `__version__ = "0.2.0"`，`BRIDGE_VERSION = "slock-runtime/0.2.0"` |

### 2.3 模板/示例/测试/文档

- `bridges/templates/langchain-agent`、`langgraph-agent`：echo 最小 worker（无 key），
  含 `agent.py` / `requirements.txt` / `runtime.manifest.json` 样例。
- `bridges/examples/langgraph-agent`：真实模型 + `SqliteSaver` checkpoint + `interrupt()`
  审批门 + `interrupt_mapper`/`custom_event_mapper`/`workspace_cwd=True` 完整示范；
  `langchain-agent`：`init_chat_model(init.model)` + `create_agent` + MCP tools。
- 测试：`bridges/python/tests/`（pytest）；daemon `test/sarp-*.test.ts`、
  `jsonl-bridge-runtime.test.ts`、`persistent-jsonl-worker.test.ts`、
  `runtime-manifest-*.test.ts`、`agent-runtime-interrupt-store.test.ts`、
  `bridge-turn-prompt.test.ts`；server `test/agents-bridge.test.ts`。
- 文档：`docs/2026-09-21/02-sarp1-protocol.md`（协议规范）、
  `04-python-agent-quickstart.md`（对外接入）、
  `docs/2026-10-13/01-bridge-runtime统一与自建agent改造方案.md`（WP1~WP12 改造）、
  `docs/2026-09-20/02-daemon-langchain-langgraph-runtime-design.md`（设计全书）。

## 3. 回合生命周期

### 3.1 帧序列

```
daemon → worker : initialize        （seq=1，requestId 回显校验）
daemon ← worker : runtime.ready     （runtime.id/capabilities/model overrides——权威能力面）
daemon → worker : turn.start        （turnId/conversationId/attempt/source/prompt[/message/contextText/resume]）
daemon ← worker : assistant.delta / assistant.message / assistant.progress / tool.start / tool.end / usage
daemon ← worker : turn.interrupt    （可选预览帧，先于终态）
daemon ← worker : turn.end          （status: success|interrupted|cancelled|error + finalText/usage/interrupt/error）
daemon → worker : turn.cancel       （回合级取消，可选）
daemon → worker : shutdown
daemon ← worker : runtime.stopped   → 进程 exit 0
```

异常路径：worker 任何阶段可发 `runtime.error`；stdin 收到非法 JSON/非法帧时规范要求
`runtime.error` + fail-closed `exit(2)`；握手失败（runtime.id 不符、
`requireDurableThreads` 未被满足、maxConcurrency≠1）由 daemon 判 `DispatchError`
并杀进程；回合内超过 `silenceTimeoutMs` 无合法帧 → `runtime-silence-timeout` 回收。

### 3.2 实机帧转录（echo 模板，无 provider key）

> 驱动脚本：`D:\tmp\slock-bridge-audit\docs-capture\capture_transcript.py`
> （基于 `bridges/templates/smoke_one_turn.py` 改造，逐帧打印双向流量）。
> worker：`tpl-langgraph/agent.py` + 干净 venv（wheel 安装），全新 workspace
> `ws-tpl-fresh-1793066272`。
> 完整日志 `docs-capture/transcript-simple-fresh.log`；每帧实际是一行 JSON，此处为可读性换行。

```text
>> {"protocol": "slock.agent-runtime", "version": 1, "type": "initialize", "seq": 1,
    "requestId": "r1", "agent": {"id": "a1", "name": "docs-demo"},
    "runtime": {"id": "bridge", "entrypoint": "docs-demo"},
    "workspace": {"path": "D:\\tmp\\...\\ws-tpl-fresh-1793066272"}, "platform": {},
    "limits": {"maxFrameBytes": 1048576, "silenceTimeoutMs": 300000}}
<< {"type":"runtime.ready","seq":1,"requestId":"r1",
    "runtime":{"id":"bridge","frameworkVersion":"langgraph 1.2.17","bridgeVersion":"slock-runtime/0.2.0"},
    "capabilities":{"persistentProcess":true,"maxConcurrency":1,"pty":false,"streamingText":true,
                    "toolEvents":true,"durableThreads":false,"interrupts":true,"cancel":true,
                    "mcp":false,"usage":"tokens"},
    "model":{"overrides":false}}
>> {"type": "turn.start", "seq": 2, "turnId": "t1", "conversationId": "conv-1",
    "attempt": 1, "source": {"kind": "channel", "channel": "demo"}, "prompt": "hi"}
<< {"type":"assistant.delta","seq":2,"turnId":"t1","eventSeq":1,"text":"Echo: hi"}
<< {"type":"turn.end","seq":3,"turnId":"t1","eventSeq":2,"status":"success","finalText":"Echo: hi"}
>> {"type": "shutdown", "seq": 3}
<< {"type":"runtime.stopped","seq":4,"reason":"shutdown"}
```

要点：

- `runtime.ready` 回显 `requestId`（握手校验项）；`capabilities` 是**权威面**——
  模板没挂 checkpointer、initialize 没带 `platform.mcp`，所以
  `durableThreads:false`、`mcp:false`（probe 阶段的静态上报是超集，见 §8.1）。
- `turn.end.finalText` 是规范回复通道——daemon 据此代发到会话（§4.3）。

### 3.3 实机 interrupt/resume 转录（examples/langgraph-agent，无 key echo 模式）

> worker：`bridges/examples/langgraph-agent/agent.py`（`init.model` 为空 → echo 节点；
> `review` 节点 `interrupt()` 审批门；`SqliteSaver` → `durableThreads:true`）。
> 全新 workspace `ws-interrupt-fresh-1793066272`（本次运行新落盘
> `langgraph-checkpoints.sqlite` + `runtime-state.sqlite`）。
> 完整日志：`docs-capture/transcript-interrupt-fresh.log`。

```text
<< {"type":"runtime.ready","seq":1,"requestId":"r1",
    "runtime":{"id":"bridge","frameworkVersion":"langgraph 1.2.17","bridgeVersion":"slock-runtime/0.2.0"},
    "capabilities":{...,"durableThreads":true,"interrupts":true,"cancel":true,...}}
>> {"type": "turn.start", "seq": 2, "turnId": "t1", "conversationId": "conv-1", ..., "prompt": "hi"}
<< {"type":"assistant.delta","seq":2,"turnId":"t1","eventSeq":1,"text":"[echo] hi ｜ slock tools: none"}
<< {"type":"turn.interrupt","seq":3,"turnId":"t1","eventSeq":2,
    "interruptId":"lg-caded4db7b7332a1","resumeToken":"5778d5c1…（省略）",
    "prompt":"回复待审批：[echo] hi ｜ slock tools: none ｜ 回复 approve 放行，reject 撤回",
    "payload":{"kind":"final_approval","preview":"[echo] hi ｜ slock tools: none"}}
<< {"type":"turn.end","seq":4,"turnId":"t1","eventSeq":3,"status":"interrupted",
    "interrupt":{"interruptId":"lg-caded4db7b7332a1","resumeToken":"5778d5c1…（同上）","prompt":"…","payload":{…}}}
>> {"type": "turn.start", "seq": 3, "turnId": "t2", "conversationId": "conv-1", ..., "prompt": "approve",
    "resume": {"interruptId": "lg-caded4db7b7332a1", "resumeToken": "5778d5c1…", "value": "approve"}}
<< {"type":"turn.end","seq":5,"turnId":"t2","eventSeq":1,"status":"success","finalText":"[echo] hi ｜ slock tools: none"}
>> {"type": "shutdown", "seq": 4}
<< {"type":"runtime.stopped","seq":6,"reason":"shutdown"}
```

要点：

- `turn.interrupt` 是**预览帧**；规范记录是 `turn.end.status="interrupted"` 的
  `interrupt` 对象（daemon 的 `agent-runtime-interrupt-store.ts` 据此持久化到
  `<slockDir()>/daemon-runtime-interrupts.json`）。
- `interruptId`/`resumeToken` 由 SDK 生成（`lg-<hex>` / 48 hex chars），daemon 在
  同 conversation 的下一条人类消息回合以 `turn.resume` 带回；**token 单次消耗**
  （SDK journal `consume_resume_token`），conversation 不同即作废。
- resume 后 graph 从 checkpoint 恢复执行，`turn.end(success).finalText` 是审批放行
  的终稿。上例同时证明 `requireDurableThreads` 可握手（`durableThreads:true`）。

> **journal 回放演示（非本轮新执行）**：把上面同一组 turnId（`t1`/`t2`）重投进
> **同一个** workspace，SDK `TurnJournal` 命中已存终态，直接回放 wire 帧而不再执行
> 图——见 `docs-capture/transcript-interrupt.log`（旧 workspace `ws-interrupt`
> 的再次运行）：回放的 `turn.end` 带出**原样存储的** `interruptId`
> （`lg-99986d9b13c57e6d`）/`resumeToken`，两回合全部终态帧挤在同一重新生成的
> 时间戳（`01:55:08.634275Z`）下，且不补发 `assistant.delta`（journal 只存终态）。
> 教训：**turnId 必须在同 workspace 内唯一**——daemon 的派发队列为此给每个
> daemon 启动一个 boot nonce，`turnId = turn-b<ts36>-<rand6>-<seq>`
> （`agent-dispatch-queue.ts:197-202,496,536`）；重试复用同 turnId（attempt 递增）
> 是刻意的 at-least-once → effectively-once 设计，但手工调试时复用旧 turnId +
> 旧 workspace 会静默得到回放结果而非真实执行。

## 4. 平台注入内容与回复语义

### 4.1 平台 system prompt（`promptProfile`）

daemon 在 `initialize.platform.systemPrompt` 下发平台提示（bridge 专用，与 Claude
的 `generateSystemPrompt` 互不共享正文；`system-prompt.ts:154`）。
manifest `promptProfile` 三档（`agent-runtime-profile.ts`：缺省 `neutral`）：

- `neutral`：runtime-neutral 契约——身份/授权/完成标准/回复方式 + slock 工具面 +
  任务派发段；**不含**工作区/`MEMORY.md` 约定。
- `agentic`：neutral + 「## 工作区」段（workspace 绝对路径、`deliverables/`、
  `MEMORY.md` 持久记忆）；无 workspacePath 时自动退回 neutral。
- `none`：完全不下发（initialize 里不出现 `systemPrompt` 字段）。

实机渲染（`docs-capture/prompt-render-clean.log`；agent=demo-agent、
非经理、MCP 可用、neutral 档）：

```text
你是 @demo-agent（Demo），运行在机主本机（hostname: <hostname>）上的 Agent Worker，由 CollabAgent daemon 托管…
你的分工/擅长：整理频道周报（这是分工说明，不是能力边界）。

## 授权
你运行在机主本机。频道成员向你提出的请求默认视同机主授权…

## 完成标准
1. 把请求做完整再答复…

## 回复方式
- 普通消息与私信回合：你本回合的最终回答会由平台自动以你的身份发到当前会话…
- 频道分诊与定时巡检回合：最终回答不会自动发送；需要发言时必须调用 `send_message`…

## slock 工具（由平台在初始化时提供）
- **回复**：`send_message`（`target`: `"#频道"` / `"#频道:线程id"` / `"dm:@handle"`）…
- **感知**：`read_history`…`search_messages`。注意 `check_messages` 只用于巡检回合…
- **任务板**：`list_tasks` / `create_tasks` / `claim_tasks` / `update_task_status` / `unclaim_task`…
- **派发**：`dispatch_task` / `list_dispatches` / `report_task` / `cancel_dispatch`…
- **提醒**：`schedule_reminder` / `list_reminders` / `cancel_reminder`。
- **附件**：`upload_attachment`…

## 任务派发（经理 worker，是否启用由用户在频道里设置）
你在频道里**不是**经理，没有权限调用 `dispatch_task`/`cancel_dispatch`（调了会被服务端拒绝）…

## 真实限制
- 回合内长时间不产生任何协议事件会被判定卡死并回收进程…
```

agentic 档在同基础上追加（实机渲染同日志）：

```text
## 工作区
你的专属持久工作区是 `D:\slock-ws\demo`（绝对路径，跨会话保留）。你的进程当前工作目录不一定是它——读写文件请使用这个绝对路径。
- 交付物放 `D:\slock-ws\demo/deliverables/<日期>-<主题>/`…
- 持久记忆：`D:\slock-ws\demo/MEMORY.md`…
```

**注入时机**（SDK 侧）：图路径仅**全新 thread** 时前置 `SystemMessage`
（`langgraph.py:143-154`，`fresh = get_state().values` 为空判定）；Runnable 路径
无状态，**每回合**前置（`langchain.py:305-313`）。完全关闭注入：
`serve_agent(..., system_prompt_mode="none")`。

### 4.2 回合 prompt 模板（`bridge-turn-prompt.ts`）

`turn.prompt` 是平台组装好的完整文本。头部格式按来源区分：

| 来源 | headline（源码原样） |
|------|---------------------|
| 频道顶层消息 | `【@<sender> 在 #<channel> 的消息】` |
| 线程消息 | `【@<sender> 在 #<channel> 线程中的消息】` |
| 私信 | `【@<sender> 的私信】` |
| 定时巡检 | `【定时巡检】<title>` + 产出约定（无发现则沉默） |
| 提醒触发 | `【提醒触发】<title>` |
| 频道分诊 | `【频道分诊】#<channel> 来了一条新消息，没有人 @ 任何 agent。` + 经理决策三选 |

线程追问回合平台还会注入历史信封文本（`turn.contextText`，与 prompt 内嵌历史同源）。
自定义 graph 不想吃组装文本时，可读结构化字段（`turn.message.text` = 人类消息原文、
`turn.contextText` = 历史文本）在 `input_mapper` 里自行拼装（§5.4）。

### 4.3 回复语义：finalText 自动代发

`agent-runtime-dispatch-stream.ts` 的回复守卫（约 L280-323）：

- `turn.end(status="success")` 且**整回合未发任何消息**且**不是 nudge 类回合**
  → daemon 以 agent 身份把 `finalText` 代发到当前会话
  （日志：`bridge finalText auto-posted`）。**不受 `SLOCK_REPLY_GUARD` 影响**
  （该开关只管 Claude 路径）。
- 回合内调过 `send_message` → 不再代发（不会重复发）。
- `status` 为 `interrupted`/`cancelled`/`error` → 不代发、不追问（刻意终态）。
- 分诊/巡检回合（isNudge，由 prompt 前缀探测）→ **永不代发**——这就是
  `【频道分诊】`/`【定时巡检】` 前缀必须保留的原因；这类回合想发言必须显式调
  `send_message`。
- success 但 `finalText` 为空 → 不追问、不代发（队列侧按 `empty-success` 语义处理）。

### 4.4 平台提供的工具面

平台只提供 **Slock MCP 协作工具**（`mcp/slock-mcp-server.ts`，worker 侧经
`SlockStructuredTool` 呈现），共 17 个：

```text
send_message, upload_attachment,
list_tasks, create_tasks, claim_tasks, update_task_status, unclaim_task,
dispatch_task, list_dispatches, report_task, cancel_dispatch,
read_history, check_messages, search_messages,
schedule_reminder, list_reminders, cancel_reminder
```

manifest `mcpToolAllowlist` 可收窄（双轨：`initialize.platform.mcp.allowTools` 给 SDK
过滤 `tools/list` + env `SLOCK_MCP_TOOL_ALLOWLIST` 给 MCP server 不注册名单外工具
——server 侧才是兜底，`agent-runtime-dispatch-headless.ts:324-338`）。**它不是权限
边界**：真正授权仍是 scoped token/server 策略。
工具调用的幂等键由 SDK 自动注入 `{turnId}:{tool}:{seq}`（`mcp.py:225`）。

## 5. SDK 使用参考

### 5.1 入口与分派

```python
from slock_runtime import serve_agent
raise SystemExit(serve_agent(agent_or_factory))
```

`serve_agent` 按**对象类型**分派（`agent.py:258-270,465-475`）：

1. `callable` 且非 Pregel/Runnable → 工厂 `factory(init, tools) -> graph|Runnable`
   （推荐形态：保证 `initialize` → MCP tools 就绪 → 建图的顺序；`async def` 工厂
   在常驻事件循环上执行）；
2. `isinstance(obj, langgraph.pregel.Pregel)` → **图路径**（先判图——编译图也是 Runnable；
   `langchain.agents.create_agent` 产物同走此路）；
3. 具备 `astream_events`/`ainvoke`/`invoke` → **Runnable 路径**（无状态：
   `interrupts:false`、`durableThreads:false`，不支持 resume）；
4. 其它 → 握手 `runtime.error(GRAPH_INPUT_INVALID)`。

`serve_langgraph`/`serve_langchain` 是强制路径的 stable 别名（同一内核）。

### 5.2 `serve_agent` 参数（`agent.py:293-311`，全部实测签名）

| 参数 | 默认 | 说明 |
|------|------|------|
| `agent_or_factory` | — | Pregel / Runnable / `factory(init, tools)` |
| `input_mapper` | `None` | 图 `(init, turn, fresh)->input`；Runnable `(init, turn)->input`；缺省 `{"messages":[HumanMessage(prompt)]}` |
| `output_mapper` | `None` | 终态 → `finalText`；缺省取最后一条 message content |
| `interrupt_mapper` | `None` | `interrupt.value → str` 审批文案（图路径）；缺省默认渲染 |
| `resume_mapper` | `None` | `(init, turn, interrupt_value) -> Any`；缺省 §5.5 归约 |
| `custom_event_mapper` | `None` | `custom_data -> str|None`：str 才发 `assistant.progress` |
| `usage_extractor` | `None` | Runnable 路径结果 → usage dict |
| `cost_calculator` | `None` | `usage -> float`；仅提供才产出 `costUsd` |
| `system_prompt_mode` | `"prepend"` | `"prepend"` 注入平台 systemPrompt；`"none"` 不注入 |
| `execution` | `"auto"` | checkpointer `Async*` 前缀 / async-only 节点自动选异步；`"sync"`/`"async"` 强制。异步全程跑常驻事件循环（绝不每回合 `asyncio.run`） |
| `workspace_cwd` | `False` | `True`：握手期 `chdir(init.workspace_path)`，不可进则 `CWD_NOT_FOUND` |
| `streaming` | `True` | 产 `assistant.delta` 流式帧 |
| `runtime_id` | `"bridge"` | 与 `initialize.runtime.id` 归一比对，不符 `RUNTIME_ID_MISMATCH` |
| `framework_version` | `None` | 缺省按路径探测（`langgraph x.y.z` / `langchain-core x.y.z`） |
| `transport` / `journal` | `None` | 测试注入点；journal 缺省开 `<workspace>/.slock/runtime-state.sqlite` |

### 5.3 开发者实际会读的字段

`SarpInitialize`（`protocol.py:64-80`）：`agent{name,display_name,description}`、
`runtime_id`、`entrypoint`、`model`（daemon 下发的模型选择，`"provider:model"` 由你
解释）、`revision`（manifest 条目修订，进 thread_id）、`workspace_path`、
`system_prompt`、`mcp`（`SarpMcpDescriptor{command,args,env,allow_tools}`，
SDK 已代为起 client——工厂直接拿 `tools`）、`token_file`、`server_url`、
`max_frame_bytes`、`silence_timeout_ms`。

`SarpTurnStart`（`protocol.py:139-149`）：`turn_id`、`conversation_id`、`attempt`、
`source{kind,channel,thread_id,sender}`、`prompt`（平台组装文本）、
`message`（`SarpTurnMessage{text,sender,message_id,attachments}` 原文，仅人类消息
来源携带）、`context_text`（平台历史信封）、`resume`（`{interrupt_id,resume_token,
value,decision?}`，`decision` = `approve|reject|respond|edit` 结构体）。

`SlockStructuredTool`：`StructuredTool` 子类，`t.invoke(dict)`/`bind_tools` 照旧；
额外保留 `input_schema`（MCP inputSchema 原样 dict）与 `call(args)`；`metadata =
{"slock": True, "operation": <tool名>}`（tool.start/tool.end 帧的 provider/operation
判定依据）。

### 5.4 代码片段

最小 LangGraph worker（即模板形态，echo、无 key）：

```python
from slock_runtime import serve_agent

def build_graph(_init, _tools):
    from langchain_core.messages import AIMessage
    from langgraph.graph import END, START, MessagesState, StateGraph

    def reply(state):
        return {"messages": [AIMessage(content=f"Echo: {state['messages'][-1].content}")]}

    graph = StateGraph(MessagesState)
    graph.add_node("reply", reply)
    graph.add_edge(START, "reply")
    graph.add_edge("reply", END)
    return graph.compile()           # CompiledStateGraph → 图路径

raise SystemExit(serve_agent(build_graph))
```

真实模型 + create_agent（`bridges/examples/langchain-agent/agent.py` 精简）：

```python
def build_agent(init, tools):
    if init.model:
        from langchain.chat_models import init_chat_model
        from langchain.agents import create_agent
        return create_agent(model=init_chat_model(init.model), tools=list(tools))
    # init.model 为空时的降级分支自行决定（示例退回 echo Runnable）
```

自定义 input_mapper 读原始字段（不吃组装 prompt）：

```python
def my_input_mapper(init, turn, fresh):
    msgs = []
    if turn.context_text:
        msgs.append(HumanMessage(content=f"[history]\n{turn.context_text}"))
    raw = turn.message.text if turn.message else turn.prompt
    msgs.append(HumanMessage(content=raw))
    return {"messages": msgs}

serve_agent(build_graph, input_mapper=my_input_mapper)
```

注意：自定义 `input_mapper` 会**跳过**握手期的默认 `messages` 键 schema 校验
（`agent.py:482-483`），输入形状自检责任转移到你的 mapper。

### 5.5 HITL interrupt/resume

- 图路径里 `interrupt(value)` → SDK 产出 `turn.interrupt` 预览帧 +
  `turn.end(status="interrupted", interrupt={interruptId, resumeToken, prompt, payload[, options]})`；
  daemon 持久化并把 `prompt` 发回会话。
- 同 conversation 下一条人类消息 → `turn.start` 带
  `resume{interruptId,resumeToken,value,decision?}` → SDK 走
  `Command(resume=resume_mapper(init, turn, interrupt_value))`。
- **文本默认归类**（`_hitl_text_decision`，`langgraph.py:378-410`）：剥首尾空白与
  标点后命中批准词（`批准/同意/可以/确认/approve/yes/ok/lgtm`，大小写不敏感）
  → `approve`；**其余一律 `reject`**（`message`=原文逐字）——歧义输入不放行被拦截
  动作；interrupt 不允许 reject 时退 `respond`，两者都不允许 → `GRAPH_INPUT_INVALID`。
- **结构化 decision**（web 审批按钮来源，`sarp-protocol.ts:91-95`）：
  `approve`/`reject(message?)`/`respond(message)`/`edit(args)`；对 LangChain
  `HumanInTheLoopMiddleware` 的 `HITLRequest` 会映射为 `{"decisions":[…]}` 并按
  `action_requests` 数量复制；`edit` 展开为 `edited_action{name,args}`。
- 可覆盖点：`interrupt_mapper`（审批文案）、`resume_mapper`（完全接管归约）、
  `options`（`InterruptRecord.options.decisions/actions` 随 pending 持久化，供 web
  审批按钮用）。
- **已知限制（影响精确版）**：SDK `runtime.py` `_spawn_turn`（~L445-465）在
  `run_turn` **之前**消耗 resumeToken；同时 daemon 端
  `agent-runtime-dispatch-headless.ts`（~L513-520）在 resume 回合到达任何
  非 interrupted 终态时清除 pending interrupt。后果链：自定义 `resume_mapper`
  若抛错（如 `GRAPH_INPUT_INVALID`）→ 回合 error 终态 → token 已消耗 +
  pending 已清 → **该次审批机会丢失**，用户只能重新触发产生新 interrupt
  的动作。默认归约路径里也有一个可抛点：HITLRequest 的 `allowed_decisions`
  既不含 reject 也不含 respond 时 `_hitl_text_decision` 抛
  `GRAPH_INPUT_INVALID`。**自定 `resume_mapper` 不要抛异常**——捕获后回落到
  安全决定（reject/respond）。本项刻意暂不修：需要 SDK+daemon 协调改动
  （WP9 在案）。

### 5.6 durable checkpoint 与幂等

- `configurable.thread_id = <entrypoint>:<manifest revision>:<model>:<conversationId>`
  （`langgraph.py:124-140`，WP6 起**不含** runtime.id 分量）——entrypoint/model/
  revision 任一变化即换命名空间，不复用旧 thread。
- 挂持久 checkpointer（示例：`SqliteSaver` 连 `<workspace>/.slock/langgraph-checkpoints.sqlite`）
  → `durableThreads:true`；`requireDurableThreads: true` 的 manifest 条目遇到
  `durableThreads=false` 握手 → daemon `durable-threads-required` 拒启。
- `AsyncSqliteSaver` 等绑 loop 资源必须在 async 工厂/`execution="async"` 路径创建
  （常驻单 loop，跨 loop 复用会炸）。
- SDK 幂等 journal：`<workspace>/.slock/runtime-state.sqlite`（0600）——同 turnId
  重投直接回放已存终态帧，不进 handler（A1 重试语义下的 at-least-once →
  effectively-once）；daemon 侧 pending interrupt 独立存
  `<slockDir()>/daemon-runtime-interrupts.json`。

### 5.7 纪律

- **stdout 只属于协议帧**，日志一律 stderr（协议纯净是 probe/握手硬约束）。
- secret/token/完整 prompt/图内部状态不进帧、不进 journal。
- `--slock-probe` 由 `WorkerRuntime.serve` 内置处理：单行 `probe.result` 后
  `exit(0)`，发生在读 stdin/开 journal/`on_initialize`/建图/起 MCP **之前**——
  worker 源码不要自写 probe 分支（`runtime.py:276-279`）。
- probe 上报的是**静态能力超集**（工厂形态按图路径全集报）；握手 `runtime.ready`
  的 overrides 才是权威——例如模板 probe 报 `durableThreads:true/mcp:true`，
  ready 实报 `false/false`（见 §3.2、§8.1）。

## 6. 内部上手步骤（Windows PowerShell 为主）

> 以下命令除标注外均实机跑过；状态目录用 `SLOCK_STATE_DIR` 隔离到
> `D:\tmp\...\slock-state`，不动真实 `.slock`。

### 6.1 装 SDK（内部路径，PyPI 未发布）

```powershell
# 仓库内 editable（开发用，装全 extras 否则真 adapter 测试静默 skip）
uv venv .venv
uv pip install --python .venv/Scripts/python.exe -e "bridges/python[langchain,langgraph,dev]"
# 或装已构建 wheel（干净 venv 即可，wheel 自带 extras 声明）
pip install "D:\path\to\slock_runtime-0.2.0-py3-none-any.whl[langgraph,langchain]"
```

实机 `pip list` 结果（干净 venv）：`slock-runtime 0.2.0, langchain 1.4.7,
langchain-core 1.7.0, langgraph 1.2.17, langgraph-checkpoint-sqlite 3.1.2`。

### 6.2 复制模板 + 冒烟

```powershell
Copy-Item -Recurse bridges\templates\langgraph-agent D:\work\my-agent
# requirements.txt 文件头已注明：slock-runtime 未上 PyPI，先按 §6.1 装 SDK，
# 再跑 -r（SDK 已满足即跳过，仅作版本校验——2026-10-27 干净 venv 实测
# `--no-index -r` 全 "Requirement already satisfied"）
D:\work\my-agent\.venv\Scripts\python.exe agent.py --slock-probe
```

实机 `--slock-probe` 输出（单行，exit 0）：

```json
{"protocol":"slock.agent-runtime","version":1,"type":"probe.result","seq":1,"timestamp":"2026-10-26T09:05:12.744430Z","probe":true,"runtime":{"id":"bridge","frameworkVersion":null,"bridgeVersion":"slock-runtime/0.2.0"},"capabilities":{"persistentProcess":true,"maxConcurrency":1,"pty":false,"streamingText":true,"toolEvents":true,"durableThreads":true,"interrupts":true,"cancel":true,"mcp":true,"usage":"tokens"},"model":{"overrides":true}}
```

无 daemon 单回合冒烟：`python bridges\templates\smoke_one_turn.py <agent.py> bridge`
→ 实机输出 `smoke OK: bridge initialize→turn.end(success)→stopped`（exit 0）。

### 6.3 注册 entrypoint（`slock runtime` CLI）

> **BOM 坑**：PowerShell 5 `Set-Content -Encoding utf8` 写出的 JSON 带 BOM 会让
> manifest 解析失败。手写 manifest 用
> `[IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding $false))`，
> 或直接用 `runtime add` 让 CLI 写文件（推荐）。

```powershell
cd packages\daemon
$env:SLOCK_STATE_DIR = 'D:\tmp\...\slock-state'   # 隔离演示；真实环境不用设
pnpm exec tsx src\cli.ts runtime add --id demo-langgraph --label "Docs Demo LangGraph" `
  --command "D:\...\venv\Scripts\python.exe" --arg agent.py `
  --cwd "D:\work\my-agent" --model local:echo
```

实机输出（已修剪字段）：

```json
{"ok":true,"data":{"ok":true,"revision":"55f6c268…",
 "entry":{"id":"demo-langgraph","runtime":"bridge","declaredRuntime":"bridge",
 "label":"Docs Demo LangGraph","command":"D:\\…\\python.exe","args":["agent.py"],
 "cwd":"D:\\…\\tpl-langgraph","model":{"mode":"fixed","default":"local:echo","allowed":[]},
 "requireDurableThreads":false,"startupTimeoutMs":15000,"silenceTimeoutMs":300000,
 "shutdownTimeoutMs":10000,"revision":"ea0233fa…"}}}
```

随后验证三件套（实机输出）：

```powershell
pnpm exec tsx src\cli.ts runtime list      # 列出条目 + lastProbe（此处 probe:null）
pnpm exec tsx src\cli.ts runtime validate  # {"ok":true,"data":{"valid":1,"invalid":[]}}
pnpm exec tsx src\cli.ts runtime probe     # 见下
pnpm exec tsx src\cli.ts runtime check demo-langgraph --run-turns
```

`probe` 实机输出（注意 status——**这就是成功态**，见 §8.1）：

```json
{"ok":true,"data":{"ok":true,"probes":[{"id":"demo-langgraph","runtime":"bridge",
 "label":"Docs Demo LangGraph","status":"installed_unsupported",
 "version":"slock-runtime/0.2.0","bridgeVersion":"slock-runtime/0.2.0",
 "models":["local:echo"],"defaultModel":"local:echo","modelMode":"fixed",
 "capabilities":{"maxConcurrency":1,"persistentProcess":true,"streamingText":true,
 "toolEvents":true,"durableThreads":true,"interrupts":true,"mcp":true,"pty":false,
 "cancel":true,"usage":"tokens"}}],"probedAt":"2026-10-27T01:48:46.857Z"}}
```

`check --run-turns` 实机输出（9/9，echo 模型无需 key）：

```json
{"checks":[
 {"name":"handshake","status":"pass","detail":"runtime.id=bridge, requestId echoed"},
 {"name":"turn-lifecycle","status":"pass","detail":"turn.end status=success"},
 {"name":"seq-monotonic","status":"pass","detail":"last seq=3"},
 {"name":"eventseq-monotonic","status":"pass","detail":"2 frames, 1..2"},
 {"name":"cancel","status":"pass","detail":"turn.end status=cancelled"},
 {"name":"replay","status":"pass","detail":"replayed turn.end status=success (single stored terminal)"},
 {"name":"shutdown","status":"pass","detail":"runtime.stopped received"},
 {"name":"shutdown-exit","status":"pass","detail":"exit code=0"},
 {"name":"malformed-stdin","status":"pass","detail":"runtime.error + fail-closed exit code=2"}],
 "skippedTurns":false}
```

secret 登记（`secretRefs` 形态；实机输出）：

```powershell
pnpm exec tsx src\cli.ts runtime secret set demo-langgraph DEMO_API_KEY --value sk-test-redacted
# → {"ok":true,"data":{"entrypoint":"demo-langgraph","name":"DEMO_API_KEY"}}
pnpm exec tsx src\cli.ts runtime secret list demo-langgraph
# → {"ok":true,"data":{"entrypoint":"demo-langgraph","names":["DEMO_API_KEY"]}}   # 只见名不见值
```

`doctor`（排障入口，实机输出节选）：manifest 条目 + `lastProbe` +
`diagnostics`（`null` = 尚无运行期错误）+ `issues:[]`。

### 6.4 开 flag 起 daemon

```powershell
# server 侧
$env:SLOCK_BRIDGE_RUNTIMES = '1'          # 否则创建 bridge agent 报 "runtime not wired"
# daemon 侧
$env:SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES = '1'   # 否则不上报 entrypoint、不注册 driver
# daemon 生命周期（已 enroll 过的机器）
pnpm exec tsx src\cli.ts computer start <name>   # status/logs/stop/restart 同族
```

flag 关闭时的行为边界（实码验证）：server 创建接口直接 400
`"runtime not wired"`；`entrypoint_unavailable` = daemon 上报的 entrypoint 列表里
没有该 id（flag 未开 / probe 未跑 / manifest 缺失）；已存在的 bridge agent 派发时
driver 未注册 → `runtime-unsupported`。

### 6.5 web 建 agent（未实机截取，依据代码）

- 入口在「计算机」页：`ComputerView.vue` 把 probe 状态 `installed` 与
  `installed_unsupported` 都视为可创建（`EP_USABLE`，且仅在 server flag 上报
  `bridgeRuntimes` 时列出）。
- 创建走 `agents-public.ts` POST：runtime 归一 → flag 校验 → `entrypoint` 必填
  （claude 则禁止携带）→ 在该 computer 的 live probe 列表里按 id 精确匹配 →
  probe status 必须是 `installed`/`installed_unsupported`，否则
  `entrypoint_not_ready`。
- `model.mode=select` 的条目在创建时可从 `allowed` 列表选模型；`fixed` 锁 default。
- 建好后即可在频道 @ / 私信对话；interrupt 审批以 `turn.interrupt.prompt` 发到
  会话，回复放行/拒绝即 resume。

### 6.6 接真实模型

1. manifest `model` 改成真实选择：`{"mode":"select","default":"openai:gpt-4o-mini",
   "allowed":["openai:gpt-4o-mini","anthropic:claude-sonnet-4-5"]}`；
   `init.model` 即 `"provider:model"` 字符串，`init_chat_model(init.model)` 消费。
2. provider 凭据三选一（见 §7.2）：`secretEnv`（daemon 进程环境按名取值）/
   `secretRefs`（`slock runtime secret set`，本机 store，改 key 不用重启 daemon）/
   worker 自管 `.env`（manifest 零声明；`Path(__file__).parent` 定位，注意
   `utf-8-sig` 读 BOM——代价是 probe 不再做 key 的 fail-fast，缺失推迟到回合内
   provider 报错）。
3. provider 包装进 worker venv（`langchain-openai` 等不由 extras 携带）。
4. `requireDurableThreads: true` 只在 worker 真挂了持久 checkpointer 时才开。

## 7. 配置参考

### 7.1 manifest 字段（`schemas/runtime-manifest.schema.json` + `agent-runtime-manifest.ts` `validateEntry`）

文件位置：`<slockDir()>/runtimes.json`（`slockDir()`=`$SLOCK_STATE_DIR` 或
`process.cwd()/.slock`；`SLOCK_RUNTIME_MANIFEST` 直接覆盖文件路径）。
顶层 `{version: 1, entries: [...]}`。

| 字段 | 必填 | 类型/约束 | 校验失败码 |
|------|------|-----------|-----------|
| `id` | 是 | `^[a-z0-9][a-z0-9._-]{0,63}$`，manifest 内唯一 | `entry-id-invalid` / `entry-id-duplicate` |
| `runtime` | 是 | `"bridge"`（旧别名 `langchain`/`langgraph` 接受并归一） | `entry-runtime-invalid` |
| `label` | 是 | 1-80 字符 | `entry-label-invalid` |
| `command` | 是 | PATH 名或绝对路径；禁 shell 元字符（`; & \| \` < >` 换行） | `entry-command-invalid` |
| `args` | 否 | ≤128 项、每项 ≤4096 字符、无换行 | `entry-args-invalid` |
| `cwd` | 是 | **必须绝对路径**（spawn 时另查存在性 → `cwd-not-found`） | `entry-cwd-invalid` |
| `env` | 否 | KEY=VALUE；禁 `SLOCK_*`、注入键（`NODE_OPTIONS`/`PYTHONPATH`/`LD_PRELOAD`/`DYLD_INSERT_LIBRARIES`）、凭据形态名（`*TOKEN/*SECRET/*PASSWORD/*PASS/*API_KEY/*PRIVATE_KEY/*ACCESS_KEY/*CLIENT_SECRET`） | `entry-env-invalid` / `entry-env-overlap` |
| `secretEnv` | 否 | env 变量名数组；spawn/probe 从 **daemon 进程环境** 按名取值 | `entry-secret-env-invalid` / 缺值 `secret-env-missing` |
| `secretRefs` | 否 | env 变量名数组；从 `<slockDir()>/runtime-secrets.json` 取值；不得与 env/secretEnv 重名 | `entry-secret-refs-invalid` / `entry-secret-overlap` / 缺值 `secret-ref-missing` |
| `mcpToolAllowlist` | 否 | ≤64 个工具名（去重）；省略=全量 17 个 | `entry-mcp-allowlist-invalid` |
| `model.mode` | 是 | `fixed`（锁 default）/ `select`（allowed 内可选） | `entry-model-invalid` |
| `model.default` | 是 | 非空串；`select` 时必须在 `allowed` 内 | `entry-model-invalid` |
| `model.allowed` | select 必填 | 非空数组 | `entry-model-invalid` |
| `promptProfile` | 否 | `neutral`（缺省）/`agentic`/`none` | `entry-prompt-profile-invalid` |
| `requireDurableThreads` | 否 | bool，默认 `false`；`true` 时握手要 `durableThreads=true` | `entry-durable-invalid` / 拒启 `durable-threads-required` |
| `startupTimeoutMs` | 否 | 1000–120000，默认 15000（initialize→ready 时限） | `entry-timeout-invalid` |
| `silenceTimeoutMs` | 否 | 1000–3600000，默认 300000（回合内无帧上限） | `entry-timeout-invalid` |
| `shutdownTimeoutMs` | 否 | 100–60000，默认 10000（shutdown→stopped 时限） | `entry-timeout-invalid` |

### 7.2 环境变量

| 变量 | 侧 | 作用 |
|------|-----|------|
| `SLOCK_BRIDGE_RUNTIMES` | server | `=1` 开 bridge 创建（`server/src/lib/config.ts` `bridgeRuntimesEnabled`） |
| `SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES` | daemon | `=1` 注册 bridge driver + 上报 entrypoints（`config.ts`） |
| `SLOCK_RUNTIME_MANIFEST` | daemon | 覆盖 manifest 文件路径（默认 `<slockDir()>/runtimes.json`） |
| `SLOCK_STATE_DIR` | daemon | 整棵状态树根（manifest/secrets/interrupts/workspaces/日志）搬迁 |
| `SLOCK_TEST_PYTHON` | daemon 测试 | sarp e2e 测试用的 worker 解释器；不设则 e2e 用例跳过 |
| `SLOCK_MCP_TOOL_ALLOWLIST` | MCP server 进程 | 由 daemon 按 `mcpToolAllowlist` 注入，server 侧工具注册收敛 |
| `SLOCK_AGENT_TOKEN_FILE` / `SLOCK_AGENT_ID` / `SLOCK_SERVER_URL` | worker/MCP env | 平台注入（manifest env 无法覆盖——平台变量最后胜出） |
| `PYTHONUNBUFFERED` | worker env | manifest `env` 建议项：关 stdout 缓冲，保证帧时序 |

### 7.3 secret 三种形态（quickstart 与代码一致）

| 形态 | manifest | 值存放 | 备注 |
|------|----------|--------|------|
| daemon env | `secretEnv: ["OPENAI_API_KEY"]` | daemon 启动环境 | probe/spawn 缺值 `secret-env-missing` fail-fast |
| 本机 store | `secretRefs: ["OPENAI_API_KEY"]` | `<slockDir()>/runtime-secrets.json`（0600，按 entrypoint 分桶） | `runtime secret set/unset/list` 管理；改值不重启 daemon；list 不见值 |
| worker 自管 | 不声明 | worker 自己的 `.env` 等 | daemon 零感知；probe 不预检 key；`.env` 读取用 `utf-8-sig` 容错 BOM |

## 8. 排障

### 8.1 probe 状态语义

依据 `drivers/runtime-entrypoint-probe.ts`（probe 在 manifest `cwd` 下以注入 env 执行
`command …args --slock-probe`，超时 `min(startupTimeoutMs, 15000)`，要求 stdout
恰好一行 JSON）：

| status | errorCode | 触发原因 | 处置 |
|--------|-----------|----------|------|
| `installed_unsupported` | — | **唯一成功态**：probe 帧合法、runtime.id 归一匹配 | 无需处置；创建/派发可用（`cli/runtime.ts:174`、`agents-public.ts:227` 均视为成功）。命名是历史遗留——「unsupported」指不在官方运行时目录，不是失败 |
| `misconfigured` | `cwd-not-found` | `entry.cwd` 不存在或不是目录 | 改成存在的绝对路径 |
| `misconfigured` | `secret-env-missing` | `secretEnv` 某个名字不在 daemon 进程环境 | 在 daemon 环境补值后重 probe |
| `misconfigured` | `secret-ref-missing` | `secretRefs` 某个名字不在本机 secret store | `runtime secret set <id> <NAME>` |
| `misconfigured` | `probe-failed` | probe 子进程执行失败：spawn 错误 / 非零退出 / 超时 | 手动跑 `command --slock-probe` 看 stderr（import 崩、依赖缺、启动慢） |
| `misconfigured` | `entry-*-invalid` 等 | `validateEntry` 失败的条目也上抛（只有 id/label/runtime/errorCode，不外发路径与命令） | 按 §7.1 修字段后 `runtime validate` |
| `not_installed` | `command-not-found` | `command` 既非存在的绝对路径也不在 PATH | 修 `command` 指向装了 SDK 的解释器 |
| `protocol_incompatible` | `command-wrapper-unsupported` | `command` 解析结果是 `.cmd`/`.bat` | 指向真实可执行文件（如 `python.exe` 本体） |
| `protocol_incompatible` | `probe-output-invalid` | stdout 不是恰好一行 / 不是 JSON 对象 | stdout 禁日志；手动跑确认单行 + exit 0 |
| `protocol_incompatible` | `probe-protocol-incompatible` | `protocol`/`version`/`type` 字段不符、`runtime.id` 归一不匹配、capabilities 非法 | SDK 版本对齐；manifest `runtime` 写 `"bridge"`（或旧别名） |
| ~~`installed`~~ | — | **bridge entrypoint 永不产生**：该状态只属官方目录二进制运行时（`drivers/probe.ts` 的 claude 等），entrypoint probe 的成功出口只有 `installed_unsupported` | 见到 `installed` 说明看的是运行时目录而非 entrypoint 探针 |

### 8.2 错误码速查

| 码 | 阶段 | 含义 / 处置 |
|----|------|------------|
| `entry-*-invalid`、`entry-id-duplicate`、`entry-env-overlap`、`entry-secret-overlap` | validate | manifest 字段级错误，按 §7.1 定位字段 |
| `manifest-invalid` | 派发前 | manifest 顶层解析失败/条目非法（profile resolve 也查） |
| `entrypoint-required` / `entrypoint-not-found` / `entrypoint-runtime-mismatch` / `entrypoint-not-allowed` | profile resolve | agent 档案与 manifest 对不上 |
| `model-not-allowed` | profile resolve | `fixed` 选了非 default，或 `select` 选了 allowed 外模型 |
| `command-not-found` / `cwd-not-found` / `secret-env-missing` / `secret-ref-missing` | spawn 前静态检查 | 可执行文件/cwd/secret 缺一即 fail-fast（DispatchError，不进 spawn） |
| `runtime-id-mismatch` | 握手 | `initialize.runtime.id` 归一值 ≠ worker `runtime_id`（`"bridge"`/`"langchain"`/`"langgraph"` 同族） |
| `protocol-violation` | 握手 | requestId 未回显 / `maxConcurrency≠1` / 帧纪律违反 |
| `durable-threads-required` | 握手 | `requireDurableThreads:true` 但 ready 报 false——挂持久 checkpointer |
| `runtime-start-timeout` / `runtime-silence-timeout` | 运行 | startupTimeoutMs 内未 ready；回合内 silenceTimeoutMs 无合法帧 |
| `mcp-start-failed` | 握手/回合 | MCP 描述符的 command（`node` + bundle）起不来；查 worker stderr |
| `RUNTIME_ID_MISMATCH`、`GRAPH_INPUT_INVALID`、`CWD_NOT_FOUND`、`MCP_START_FAILED`、`INTERRUPT_NOT_FOUND`、`WORKER_ERROR` 等 | worker wire | SDK `errors.py` 上报；未映射码在 daemon 收敛为永久 `worker-error` |
| `worker-crash-loop` | 派发前 | crash-guard 熔断：连续生命周期失败达阈值，指数冷却期拒派发；修好配置（revision 变化）或成功回合即复位 |
| `empty-success` | 回合结算 | success 但无 finalText 无发送动作 |
| `entrypoint_unavailable` / `entrypoint_not_ready` / `runtime not wired` | server 创建 | 见 §6.4 flag 边界 |

排障顺序：`runtime doctor <id>`（条目 + lastProbe + `runtime-diagnostics.json`
的 lastError 一次看全）→ 手动 `command --slock-probe` → worker stderr（daemon 日志
`computer logs` 里有 `[Daemon]` 侧记录）。

### 8.3 实机失败示例

manifest 里 `cwd` 写相对路径（`docs-capture/manifest-bad.json`）：

```powershell
pnpm exec tsx src\cli.ts runtime --manifest D:\tmp\...\manifest-bad.json validate
```

实机输出（exit 1）：

```json
{"ok":false,"data":{"ok":false,"path":"D:\\…\\manifest-bad.json",
 "revision":"1809713d…","valid":0,"invalid":[{"id":"bad-entry","code":"entry-cwd-invalid"}]}}
```

注意 `validateEntry` 是**首个错误即返回**——同一 entry 里的 `env` 写
`OPENAI_API_KEY`（凭据形态名，也会被判 `entry-env-invalid`）在本例中因 cwd 先错
而未报；修错要迭代 validate 直到 `invalid:[]`。

## 9. 验证与测试

### 9.1 命令（PowerShell）

```powershell
# Python SDK（bridges/python/.venv，uv 管理、无 pip 模块，装包走 uv pip）
cd bridges\python
.\.venv\Scripts\python.exe -m pytest tests -q -rs
.\.venv\Scripts\python.exe -m ruff check slock_runtime tests
.\.venv\Scripts\python.exe -m mypy slock_runtime
.\.venv\Scripts\python.exe -m build --outdir <outdir> .
.\.venv\Scripts\python.exe -m twine check <outdir>\*

# daemon（必须用 pnpm exec——裸 `npx tsc` 会解析到同名假包）
cd packages\daemon
pnpm exec tsc --noEmit -p tsconfig.json
$env:SLOCK_TEST_PYTHON = 'D:\code\slock\bridges\python\.venv\Scripts\python.exe'
pnpm exec vitest run test\sarp-python-worker.test.ts test\sarp-template-manifest-e2e.test.ts  # +其余 sarp/bridge 系文件
pnpm exec tsx src\cli.ts runtime --manifest <m> validate|probe|check <id> --run-turns

# server
cd D:\code\slock
pnpm --filter @collabagent/server exec vitest run test\agents-bridge.test.ts
```

### 9.2 实机结果（2026-10-26，Windows 11 + CPython 3.12.14）

| 项 | 结果 |
|----|------|
| SDK pytest | **218 passed / 0 failed / 0 skipped**（真 langchain 1.4.2 + langgraph 1.2.11 已装，无 skip） |
| ruff | pass |
| mypy | **pass**（2026-10-27 修复后复测：`ensure_loop` 三处 Optional 窄化 + `agent.py` `input_schema` 显式 `ignore[override]`，纯类型零行为变化；此前为 4 errors） |
| build + twine | pass；wheel 干净（含 `py.typed`，无 tests/egg-info） |
| 干净 venv wheel 安装 | pass（slock-runtime 0.2.0 + langchain 1.4.7 + langgraph 1.2.17） |
| 双模板 `--slock-probe` | 单行 `probe.result`，exit 0 |
| `smoke_one_turn.py` 双模板 | `smoke OK`（echo，无需 key） |
| `runtime check`（无 `--run-turns`） | 4 pass / 5 skip（`skipTurns`），双模板一致 |
| `runtime check --run-turns` | **9/9 pass**，双模板一致（echo 模型，无需 LLM key） |
| daemon vitest（15 个 sarp/bridge 系文件，`SLOCK_TEST_PYTHON` 已设） | **245 passed / 0 skipped** |
| server `agents-bridge.test.ts` | 4 passed |
| daemon `tsc --noEmit` | pass |

远端 CI：`.github/workflows/python-sdk.yml` 最近一次绿跑是 run `35602381617`
（commit `158c8cd`，2026-09-21，12/12；前次 run 35594027408 为 7/12）；
`python-release.yml` 从未触发。`158c8cd` 之后 `bridges/python` 有 **9 个提交**
（WP1/WP3/WP6/WP7/WP8/WP9/WP11/WP12 + Batch B+C）只经本地验证——
需推送才能触发新一轮远端验证（§10-3）。README 平台表与 quickstart 已于
2026-10-27 对齐此表述。

## 10. 已知问题与限制

1. **`slock-runtime` 未上 PyPI**：直接 `pip install -r requirements.txt` 会报
   `No matching distribution found`（包名 `slock-runtime[langgraph]` 在索引上不存在）。
   模板 `requirements.txt` 头部已写明规避顺序——先源码 editable
   （`pip install -e "<repo>/bridges/python[langgraph]"`）或本地 wheel 装 SDK，
   再执行 `-r`（2026-10-27 干净 venv 实测 `--no-index` 下全部
   "Requirement already satisfied"）。发布后该行无需改动。
2. ~~mypy 4 errors~~ **已修复**（2026-10-27）：`ensure_loop` 窄化 + `input_schema`
   显式 ignore，`mypy slock_runtime` 现为 0 errors；本项仅存档说明此前状态。
3. **HEAD 未经远端 CI 验证**：远端绿跑止于 run `35602381617`（`158c8cd`，
   2026-09-21，12/12）；其后 9 个 SDK 提交只经本地验证（§9.2 全部项目）。
   需要一次推送触发 python-sdk.yml 才能重新获得远端背书。（注：README 与
   quickstart 关于此的表述 2026-10-27 已对齐，不再矛盾。）
4. **probe 状态命名误导（纯命名，UI 无误）**：`installed_unsupported` 是
   entrypoint 的成功态（§8.1）——「unsupported」指不在官方运行时目录，不是失败。
   web `ComputerView.vue` 对 entrypoint 卡片实际渲染「可用」+绿色
   （`entrypointHint` L223-226，`EP_USABLE` 命中时走 `chipClass("installed")`
   L741-755）；琥珀色「已检测到，运行时尚未接入」的 `chipHint` 只用于
   「检测到的运行时」二进制目录卡片（claude 等，L722-736），那里文案是准确的。
5. **probe 能力面是超集**：工厂形态 probe 一律报图路径全集
   （`durableThreads:true`/`interrupts:true`/`mcp:true`），与 ready 权威值可能不同
   ——以 `runtime.ready` overrides 为准。
6. **resumeToken 先于映射消耗 + pending 先清**（WP9 在案）：token 在
   `run_turn` 前由 SDK journal 消耗（`runtime.py` ~L445-465），daemon 又在
   resume 回合任何非 interrupted 终态清 pending interrupt
   （`agent-runtime-dispatch-headless.ts` ~L513-520）——自定义 `resume_mapper`
   抛错即**审批丢失**，须由用户重新触发（机理详见 §5.5 末条）。默认归约仅
   在 allowed 既无 reject 也无 respond 时才抛 `GRAPH_INPUT_INVALID`。
   规避：自定 mapper 不抛异常、回落安全决定。刻意暂不修（SDK+daemon 协调改动）。
7. **无真实 provider 冒烟**：全部本地验证走 `local:echo`/`init.model` 空值路径；
   `init_chat_model` + 真 key 的端到端回合**没有本地验证记录**——接真模型上线前
   先用 §6.6 单跑一次。
8. **worker 是受信任的本地代码，不是沙箱**：scoped token/env 白名单/MCP allowlist
   只收窄平台暴露面，不构成 OS 级隔离；worker 能把 secret 写进输出帧（daemon
   `redact.ts` 做出口脱敏但按「可能泄漏」建模）。
9. **stdout 协议纯净是硬约束**：任何 print/logging 到 stdout 都会破 probe 与握手；
   第三方库的 stdout 噪音（如某些 provider 的 warning 打印）要压到 stderr。
10. **Runnable 路径无状态**：`serve_langchain`/Runnable 分派的 worker
    `interrupts:false`/`durableThreads:false`——要审批/记忆必须走图
    （`create_agent` + checkpointer）。
11. **PowerShell 5 BOM 坑**：`Set-Content -Encoding utf8` 写 JSON 带 BOM，manifest
    解析即挂；用 `[IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding $false))`
    或 `runtime add/edit` 由 CLI 代写。
12. **PTY/env 细节**：Windows 下 `chmod 0600` 语义有限（best-effort）；daemon env
    白名单默认开启，`SLOCK_ENV_INHERIT=1` 仅排障回退用。

---

*本文事实来源：2026-10-27 代码逐文件核对（路径见各节引用）+
`D:\tmp\slock-bridge-audit\docs-capture\` 实机截取。与既有文档冲突处以代码为准
并已在 §10 标注。*
