# Daemon 对 Claude 的解耦审计

> 日期：2026-09-20
> 范围：`packages/daemon`（92 个源文件）+ 关联的 `packages/shared` 协议与 `packages/server` 下行链路
> 问题：后续要接入其他 agent runtime（codex / gemini / opencode），当前 Claude 耦合有多深、改造面在哪

## 结论（TL;DR）

**分层是健康的，驱动层没抽象。**

- **编排层约 60% 代码完全 runtime 无关**：派发队列、五态状态机、空闲回收、成本门、
  上下文注入、观察帧总线、进度条、handlers、MCP server、`slock` CLI——它们不知道
  也不关心子进程是 claude 还是别的什么。
- **协议层已经把 `runtime` 字段铺到了 daemon 门口**：server 持久化
  `runtime_profile={runtime,model}`、`agent:start` 三个变体都带 `runtime`、
  `ready` 上报 `RuntimeProbe[]` 能力地图——**但 daemon 在 `handleAgentStart`
  里把这个字段读出来又扔掉了**，`registerAgent`/`agentInfo` 里没有 runtime。
- **真正的硬耦合集中在一个「缺失的驱动接口」上**：`PersistentClaude` 具体类
  直接穿透 runtime / dispatch / idle-reclaimer 五个文件；`claude-stream.ts` 的
  stream-json 事件联合是全链路的回合协议；spawn 参数、MCP 注入、session resume
  全部是 Claude CLI 的私有约定。
- **已有多 runtime 的「脚手架」但没接线**：`COMMAND_PRESETS`（4 个 CLI 的
  yolo/resume/session 参数表）、`SESSION_PATTERNS`（4 个 CLI 的会话目录）、
  `INTERACTIVE_COMMANDS`/`COMMANDS_WITH_BRACKETED_PASTE`（4 个 CLI 的 TUI 集合）
  都写好了 codex/gemini/opencode 条目——但唯一调用点全部硬编码 `"claude"`。

一句话：**加第二个 runtime 不需要动编排层，但需要先造出驱动抽象，然后把
十来个 Claude 私有点收敛到它后面**。工作量中等，路径清晰。

---

## 一、已经解耦的部分（不需要动）

| 模块 | 说明 |
|------|------|
| `agent-dispatch-queue.ts` | 串行派发/退避/死信/去重/合并——纯消息语义 |
| `agent-runtime-state.ts` | 五态机，与 CLI 无关 |
| `agent-dispatch-queue` → `doDispatch` 门控链 | 成本门/停泊位代次/isDeliverable 都是通用逻辑 |
| `idle-reclaimer.ts` 的计时器本体 | `reclaimIdleAgent` 里有 `PersistentClaude` 类型引用，见耦合表 |
| `agent-context-builder.ts` | 线程/频道历史信封，纯 prompt 组装 |
| `agent-cost-tracker.ts` 记账/熔断 | 字段是通用 `costUsd/durationMs/numTurns`（均可空） |
| `agent-observation.ts` 的 `ObservationFrame` | **已是规范化中间表示**——`system/text/thinking/tool_use/tool_result/turn_end/error` 七种 kind，不含任何 Claude 字段 |
| `agent-progress.ts` / `agent-runtime-turn-tracker.ts` | 消费归一化帧/计时器，无 Claude 概念 |
| `handlers/*`（deliver/reminder/terminal/workspace/inbound） | WS 消息路由，无 CLI 语义 |
| `mcp/slock-mcp-server.ts` + `mcp-bundle.ts` | 回话通道协议本身是跨 runtime 的（MCP 是开放协议）；耦合点在「如何把它塞进各 CLI 的配置」而非 server 本体 |
| `setup-slock-wrapper.ts` | `slock` CLI 兜底回话通道，agent 无关——**这是非 MCP runtime 的现成退路** |
| `types/index.ts` 的 `IAgentManager` | `startAgent(command+args)` 通用接口（虽随 PTY 冻结） |
| `drivers/probe.ts` | `probeRuntimes()` 已遍历 4 个 CLI，能力地图上报 server |
| `agent-env-whitelist.ts` | env 白名单与 CLI 无关（注释提 claude 但逻辑通用） |

## 二、协议层现状：runtime 字段「到门口被丢弃」

端到端链路其实已经铺好，只差 daemon 消费：

```
web 创建 → POST /agents {runtime} → server 校验 WIRED_RUNTIME_IDS（目前只有 "claude"）
  → agents.runtime_profile={runtime,model} 落库
  → WS agent:start {agent.runtime, config.runtime, config.runtime_profile.runtime}
  → daemon handlers/agent.ts handleAgentStart     ← 【断点】只取了 model
  → runtime.registerAgent(id, name, {displayName, description, model})  ← 无 runtime 参数
  → agentInfo: Map<name, {displayName?, description?, model?}>          ← 无 runtime 字段
```

- `packages/shared/src/index.ts`：`WsAgentStartAgent.runtime` /
  `WsAgentStartConfig.runtime` / `runtime_profile.runtime` 均已定义（L398-417）；
  `RUNTIME_CATALOG_IDS=["claude","codex","gemini","opencode"]`、
  `WIRED_RUNTIME_IDS=["claude"]`（L470-474）。
- `handlers/inbound.ts` `readRuntimeProfile` 已经解析 `runtime` 字段——数据进了
  daemon 内存，然后没人用。
- `daemon-core.ts checkClaude()` 启动预检只查 claude（L319-340）。

**这是接新 runtime 的第一刀**：runtime 必须进 `agentInfo`，否则 dispatch 无从选路。

## 三、耦合点清单（按改造代价排序）

### P0 —— 结构性耦合（不解决就无法接第二个 runtime）

**1. 没有驱动接口，`PersistentClaude` 具体类穿透五个文件**

```
agent-runtime.ts:181            persistentSessions: Map<string, PersistentClaude>
agent-runtime.ts:13             import type { PersistentClaude }
agent-runtime-dispatch.ts:150   DispatchDeps.persistentSessions: Map<string, PersistentClaude>
agent-runtime-dispatch-headless.ts:264  new PersistentClaude({...})   ← 直接构造
agent-runtime-dispatch-headless.ts:361  await claudePrint(...)        ← 直接调用
idle-reclaimer.ts:97            persistentSessions: Map<string, PersistentClaude>
```

`PersistentClaude` 实际暴露的形状很小：`send(text):Promise<void>`、`stop()`、
`alive`、构造 opts。测试里的 `FakePersistentClaude` 也只 mock 这三样
（`test/agent-runtime-dispatch-headless.test.ts:14-36`）——**提取接口几乎是零成本**，
但当前没提。

**2. stream-json 事件联合是全链路的回合协议**

`claude-stream.ts` 的 `ClaudeStreamEvent = system|assistant|user|result`
被以下消费方当作「唯一真源」：

- 回合边界：`dispatch-stream.ts` `ev.type === "result"` → 状态机回 idle
- session 学习：`system` 事件 `session_id` → `--resume` 数据源
- 成本落库：`result.total_cost_usd / duration_ms / num_turns`
- 观察帧：`streamEventToFrames(ev: ClaudeStreamEvent)`
- 沉默超时续命：任意合法 JSON 行重置计时器（含 `tool_progress` 心跳）

其他 CLI 的事件流形态不同（codex `exec --json` 是另一套 event 类型；gemini
`--output-format stream-json` 部分对齐；opencode 又是另一套）。**好在事件联合本身
已经足够松散**（字段全 optional、未知 type 静默丢弃），改造方向是「各 driver 把
自家事件流归一化到这个联合（或改名 `AgentStreamEvent`）」，而不是重写消费方。

**3. spawn 参数与 stdin 输入帧是 Claude 私有格式**

`persistent-claude.ts` `spawnProc` 内硬编码：

```
--input-format stream-json --output-format stream-json --verbose
--allowedTools=<Claude 工具名集合>     ← getClaudePermissionArgs()
--model <m>                            ← Claude 参数名
--resume <session_id>                  ← Claude 参数名
--append-system-prompt-file <file>     ← Claude 参数名
stdin 写入帧: {"type":"user","message":{"role":"user","content":text}}
```

`claude-print.ts` 同样硬编码 `--print --output-format stream-json`。
`COMMAND_PRESETS` 表里有其它 CLI 的 yolo/resume 模板但**没有覆盖**
input-format/output-format/system-prompt 注入/stdin 帧格式这些更深的差异点。

**4. MCP 工具注入是 Claude 目录约定**

`agent-mcp-config.ts` 写 `.mcp.json` + `.claude/settings.local.json`
（`enableAllProjectMcpServers`、`effortLevel`）。codex 读 `~/.codex/config.toml`
的 `[mcp_servers]`，gemini 读 `.gemini/settings.json`，opencode 读 `opencode.json`。
回话通道不能假设 MCP 可用——**`slock` CLI 兜底（已在 PATH 里）是唯一通用通道**，
prompt 里的「优先 MCP，退回 CLI」策略对新 runtime 要改成「可能只有 CLI」。

### P1 —— 语义耦合（能跑但行为会丢/错）

**5. Session resume 语义整套是 Claude 的**

- `--resume <id>` 参数（preset 有模板但 headless 没走 preset）
- `system init` 事件携带 `session_id`（其他 CLI 未必在流里报 session id；
  codex 要靠扫 `~/.codex/sessions/` 文件，`SESSION_PATTERNS` 已预见）
- resume 失败探测：宽限期早退 + 「首个流事件是 error」（Claude 的坏 id 失败形态）
- `daemon-agent-sessions.json` / `daemon-thread-sessions.json` 的存取时机绑在
  stream handler 的 `system.session_id` 分支上

**6. 系统提示文案 Claude 化**

`system-prompt.ts` 自述「你是机主本机上的 Claude Code 实例」，列举
`Task/WebFetch/NotebookEdit` 等 Claude 工具名、引用 `SLOCK_AGENT_ALLOWED_TOOLS`、
描述 Claude 的 tool_progress 心跳行为。纯模板文本，参数化不难，但目前没有变体机制。

**7. 成本模型假定 `total_cost_usd`**

`extractResultMetrics` 从 result 事件取 USD。codex/gemini 报的是 token 用量而非
美元——要么 driver 层做 token→USD 换算，要么 `costUsd` 长期为 null（熔断失效，
只剩回合计数）。接口本身兼容（可空），但预算功能会名存实亡。

### P2 —— 命名/探测硬编码（改起来机械）

**8.** `resolveClaudeBinary()` / `needsShell(cmd==="claude")` /
`WINDOWS_KNOWN_PATHS.claude`（command-resolver.ts）——需要泛化为
`resolveRuntimeBinary(runtime)`；`probe.resolveCommandOnPath` 已是通用的。

**9.** `claudePrint`/`isClaudeAvailable`/`checkClaude`/`SLOCK_ONESHOT_CLAUDE`/
`[Persistent]`/`[ClaudePrint]` 日志前缀——改名+枚举化即可。

**10.** PTY 冻结层（`agent-runtime-spawn.ts`、`post-start-input-writer.ts`、
`agent-runtime-terms-dialog.ts`、`terminal-state.ts`）全是 Claude TUI 启发式
（`❯` 提示符、Accept-Permissions 弹窗、paste-ack）。**冻结中，建议新 runtime
一律只走 headless driver，绝不进 PTY**——冻结层可以当不存在。

## 四、建议的抽象切入方案

### 4.1 核心：两个接口

```ts
// drivers/agent-session.ts（新）
interface PersistentAgentSession {
  send(text: string): Promise<void>;  // 回合级 Promise：回合结束 resolve / 进程死 reject
  stop(): void;
  readonly alive: boolean;
}

// drivers/runtime-adapter.ts（新）——每种 runtime 一个实现
interface RuntimeAdapter {
  readonly id: RuntimeCatalogId;
  resolveBinary(): string;
  /** 常驻会话工厂（持久进程 + 结构化流）——runtime 不支持可返回 null 退 one-shot */
  createSession(opts: SessionOpts): PersistentAgentSession;
  /** one-shot 打印模式 */
  print(prompt: string, opts: PrintOpts): Promise<PrintResult>;
  /** 把 runtime 原生事件流归一化到观察/回合事件（或直接把 driver 内部事件
      设计成 agent-observation 的 ObservationFrame 源） */
  // 以下全部可选，按 runtime 能力降级：
  writeToolConfig?(workspace: string, ctx: ToolConfigCtx): void;  // .mcp.json / config.toml / …
  sessionIdFromEvent?(ev: unknown): string | undefined;
  resumeArgs?(sessionId: string): string[];
  permissionArgs?(): string[];
  systemPromptVariant?(base: AgentIdentity): string;
}
```

`PersistentClaude` 改名/包一层实现 `PersistentAgentSession`；`claudePrint`
同理。`persistentSessions` 的 Map 类型换成接口——`agent-runtime.ts`、
`dispatch.ts`、`dispatch-headless.ts`、`idle-reclaimer.ts` 四处类型签名跟着换，
行为不变。

### 4.2 runtime 贯穿注册链（第一刀，独立于 4.1 可做）

`handleAgentStart` 取 `runtime`（三个位置兜底，与 model 同模式）→
`registerAgent(id, name, {displayName, description, model, runtime})` →
`agentInfo` 加 `runtime` 字段 → `dispatchHeadlessTurn` 按 `info.runtime ?? "claude"`
选 adapter。同时 `WIRED_RUNTIME_IDS` 扩展时 server 端同步放行。

### 4.3 事件流归一化

两条路线择一：

- **A（推荐）**：保留 `claude-stream.ts` 联合作为「daemon 内部规范事件」，
  改名为 `AgentStreamEvent`；各 driver 负责把自家流收窄进来。Claude 是恒等映射，
  codex/gemini 写 mapper。消费方（dispatch-stream/observation/cost）零改动。
- **B**：`streamEventToFrames` 直接吃 `unknown` + per-runtime parser。改动面更大，
  但不需要所有 runtime 都能凑出 result/system 语义。

### 4.4 MCP 配置按 runtime 分派

`writeMcpConfig` 变 `adapter.writeToolConfig`：claude 写 `.mcp.json`+
`.claude/settings.local.json`；codex 写 `.codex/config.toml`；gemini 写
`.gemini/settings.json`；不支持 MCP 的 runtime 直接省略，prompt 走纯 `slock` CLI 变体。

### 4.5 不建议做的

- **不要给冻结 PTY 层加 runtime 支持**——它是 Claude TUI 键盘模拟，新 runtime
  走 headless 才是正路；PTY 删除评估（2026-09 底）之后这层整体消失。
- **不要指望 `COMMAND_PRESETS` 直接复用**——它的抽象粒度（yolo/resume 两个参数位）
  不够，headless 需要的 input-format/stdin 帧/事件协议它覆盖不到，4.1 的 adapter
  是正确粒度。
- **不要先做 UI 再补 daemon**——`WIRED_RUNTIME_IDS` 放开等于承诺可用，顺序应是
  daemon adapter → 真机回归 → server 放行 → web picker。

## 五、工作量预估（文件级）

| 改造项 | 触及文件 | 量级 |
|--------|----------|------|
| runtime 字段贯穿（handler→registry→agentInfo） | `handlers/agent.ts`、`agent-runtime.ts`、`agent-runtime-dispatch-headless.ts` | 小（~50 行） |
| `PersistentAgentSession` 接口提取 + 改名 | 新建接口文件 + 4 处类型签名 | 小 |
| `RuntimeAdapter` + claude 实现归拢 | `drivers/` 新增 2 文件；`persistent-claude.ts`/`claude-print.ts`/`command-presets.ts`/`command-resolver.ts`/`agent-mcp-config.ts` 内聚 | 中 |
| 事件流归一化（路线 A） | `claude-stream.ts` 改名 + 各 driver mapper | 中 |
| 第二个 runtime 本体（以 codex 为例：spawn 参数/stdin 帧/事件 map/session 发现/工具配置） | `drivers/codex-*.ts` + preset 行 | 中大（协议调研占大头） |
| prompt 变体机制 | `system-prompt.ts` 拆出 runtime 无关骨架 + per-runtime 能力段 | 小中 |
| server 放行 + web picker | `WIRED_RUNTIME_IDS`、创建表单 | 小 |
| 测试 | 现有 fake 形状（send/stop/alive）天然贴合接口，新增 per-runtime 单测 | 中 |

## 六、风险评估

- **回复守卫对弱模型的依赖**：guard 靠识别 `send_message`/`slock message send`
  tool_use 帧判「已发」——新 runtime 的工具名/事件形态若归一化不好，守卫会误判
  「没发」而代发重复消息。driver 归一化层是质量控制点。
- **沉默超时语义**：300s 无事件必杀假定「干活的 agent 持续有事件」。若某 runtime
  长工具执行没有心跳，会误杀——adapter 需要声明心跳能力或调阈值。
- **session resume 置信度**：Claude 的 resume 失败探测（宽限期+首事件 error）是
  针对其退出行为调出来的；其他 CLI 的失败形态不同，初期建议新 runtime
  `sessionResume` 默认关。
- **测试覆盖优势**：47 个测试文件大多在 fake 接缝上跑（`FakePersistentClaude`、
  mock `agent-startup`/`mcp-bundle`），接口化后这些 fake 直接变成
  `FakeAgentSession`，回归成本低。
