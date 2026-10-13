# Bridge Runtime 统一与自建 Agent 适配改造方案

> 日期：2026-10-13　状态：**待实施**　基线：`main@373db97`
>
> 范围：`packages/{shared,daemon,server,web}`、`bridges/python`（slock_runtime SDK）、`bridges/{templates,examples}`、SARP/1 规范与相关文档。
>
> 依据：2026-10-13 代码核查 + 离线实测（fake chat model，不调真实 provider；脚本与日志在本机 `%TEMP%\slock-custom-probe\`，未入库，关键结论摘录于附录 B）。
>
> 本文合并两份方案：① 自建 Agent 适配缺口修复；② langchain / langgraph 统一。实施以本文为准；旧设计文档中被修订的条款见 WP12。行号以基线 `373db97` 为准，实施时以符号名定位。

---

## 0. 摘要

**结论**

- daemon 对框架零感知：`langchain` / `langgraph` 共用一个 driver，只是标签；行为分流已经由握手 capabilities 决定。→ 统一为一个 runtime 标识 `bridge`。
- SDK 层"有状态图 vs 无状态 Runnable"是真实边界，"LangChain vs LangGraph"不是（LangChain 1.x 的 `create_agent` 返回 LangGraph `CompiledStateGraph`）。→ 一个入口按对象类型分派，共享内核。
- 自建 agent 的主要障碍：daemon 喂给 worker 的输入仍是 Claude Code 口径；工具事件 provider、finalText 回复通道、resume 形状三处契约不一致。

**工作包**（每个 WP 独立提交、独立绿灯；推荐按编号顺序）

| WP | 内容 | 优先级 | 依赖 | 涉及 |
|---|---|---|---|---|
| WP1 | SDK：Slock MCP 工具事件标 `provider="slock"`（修 empty-success 误判） | P0 | — | python |
| WP2 | daemon：bridge 平台提示与回合 prompt 去 Claude 化 + manifest `promptProfile` | P0 | — | daemon |
| WP3 | 工作区路径与 cwd 一致性 | P0 | WP2 | daemon、python |
| WP4 | bridge 最终回复语义（finalText 一等公民，不追问） | P0 | WP2 | daemon |
| WP5 | conformance runner 修正 | P1 | — | daemon |
| WP6 | runtime 标识统一为 `bridge`（别名兼容 + 数据迁移） | P1 | WP1–4 | 全部 |
| WP7 | SARP/1 增量字段：原文消息、历史、结构化附件、interrupt 选项、结构化 resume | P1 | WP6 | spec、daemon、shared、server、python |
| WP8 | SDK 统一：`serve_agent` 分派、统一工具类型、async 图执行、输入校验 | P1 | WP6 | python |
| WP9 | interrupt 默认渲染 + resume 映射（LangChain HITL 可批） | P1 | WP7、WP8 | python |
| WP10 | 结构化审批 UI + `interrupt:resolve` 链路 | P2 | WP7、WP9 | shared、server、web、daemon |
| WP11 | 单回合取消（保留进程） | P2 | — | shared、server、web、daemon、python |
| WP12 | 文档 / 模板 / CLAUDE.md 同步 | 随各 WP | — | docs |

---

## 1. 现状核查（2026-10-13）

### 1.1 daemon 对框架零感知

- 同一 driver：`packages/daemon/src/drivers/jsonl-bridge-runtime.ts:108-110`（`driverId: "jsonl-bridge"`、`runtimeIds: BRIDGE_RUNTIME_IDS`）。
- 非测试源码中两个名字只出现在：`shared/src/index.ts:556`（常量）、`daemon/src/agent-runtime-manifest.ts:105`（校验）、`daemon/src/agent-runtime-profile.ts:109`（两者同分支）、`web/src/stores/computerStore.ts:76-77`（标签）；server 经 `BRIDGE_RUNTIME_IDS` 间接引用。**没有任何行为分支。**
- 行为分流已在握手校验：`persistent-jsonl-worker.ts:455-464`（maxConcurrency / durableThreads / model overrides）。
- runtime 标识已渗入身份：profile identity（`agent-runtime-profile.ts:189`）、interrupt 兼容判断（`agent-runtime-interrupt-store.ts:131-134`）、checkpoint thread 命名空间（`bridges/python/slock_runtime/langgraph.py:94-109`）、server `agents.runtime_profile` JSONB。

### 1.2 缺口清单

| # | 缺口 | 证据 | WP |
|---|---|---|---|
| G1 | `turn.start.prompt` 不是用户原话：任务模板 + 历史信封 + `<slock-reminder>` + 角色行；协议无原文字段 | `agent-runtime-dispatch.ts:720-725`（@）、`:736-742`（DM）、`:754-762`（提醒）、`:49` / `:73`（巡检 / 分诊）、`:649-705`（历史）、`:532-537,563`（tail）；`agent-runtime-dispatch-headless.ts:272`（角色行） | WP2、WP7 |
| G2 | `resume.value` 也不是用户原话：取的是组装后的 content（含模板与历史，只去掉 tail） | `agent-runtime-dispatch.ts:572`（`resumeValue: merged`）、`:625`（content = 组装文本） | WP7 |
| G3 | bridge 平台提示是 Claude Code 口径：MEMORY.md、`slock` CLI 兜底、"文本不会自动发送"；SDK 默认前置 | `system-prompt.ts:149-222`（:160、:179、:182、:187-188、:209-219）；`langgraph.py:117-118`、`langchain.py:293-294` | WP2 |
| G4 | 追问文案写死 Claude 工具名 `mcp__slock__send_message` | `agent-runtime-dispatch-stream.ts:323-328` | WP4 |
| G5 | 提示称"当前工作目录是专属工作区"，实际 cwd 是 manifest cwd（用户代码目录）；SDK 不 chdir | `jsonl-bridge-runtime.ts:92` vs `:144`；`runtime.py:273` | WP3 |
| G6 | finalText 上频道依赖 reply-guard，`SLOCK_REPLY_GUARD=0` 即丢 | `agent-runtime-dispatch-stream.ts:274-279,304-318`；`config.ts:171` | WP4 |
| G7 | **SDK 工具事件 provider 固定为 langgraph / langchain，而 daemon 的 empty-success 豁免要求 `provider="slock"`**：调用 send_message 成功但 finalText 为空的回合被判 `empty-success`（不可重试）→ 死信 + 丢弃会话 | `persistent-jsonl-worker.ts:518-523,597-606`；`errors.ts:65,99`；`agent-runtime-dispatch-headless.ts:530-553`；SDK `langgraph.py:437,448`、`langchain.py:234,243,251` | WP1 |
| G8 | 无单回合取消：`turn.cancel` 只在 `stop()` 内发出，随后必杀进程 | `persistent-jsonl-worker.ts:866-904`（:883） | WP11 |
| G9 | resume 只能是字符串；LangChain `HumanInTheLoopMiddleware` 需要 `{"decisions":[...]}`，实测纯文本恢复报错且审批作废；审批提示是 Python dict 原文 | `langgraph.py:493`、`:405-416`；`.venv/.../langchain/agents/middleware/human_in_the_loop.py:147,481`；实测 D11 | WP7、WP9、WP10 |
| G10 | 附件只以文本摘要进 prompt，协议无结构化附件 | `handlers/deliver.ts:19-27,46-48`；`sarp-protocol.ts:60-67` | WP7 |
| G11 | runtime 标识封闭且两标签无差异；`create_agent` 选 `langchain` 会静默降级（无记忆、无中断） | §1.1；`langchain.py:90-91,161-163`；实测 D8 | WP6、WP8 |
| G12 | SDK：LangGraph 只走同步执行（async 节点失败）；无 `messages` 键时报错含糊；两 adapter 工具类型不一致；`serve_langchain` 不校验 runtime id | `langgraph.py:517-518,554`；实测 D5、D2b；`langgraph.py:47-62` vs `langchain.py:386-407`；`langgraph.py:332-337` | WP8 |
| G13 | conformance：cancel 以 `interrupts` 为门（LangChain 被跳过），且 `success` 也判通过；坏帧后 worker 已退出（exit 2）仍跑 shutdown 检查，优雅关停没被真正测到 | `sarp-conformance.ts:332,345,395-399,431-435`；`runtime.py:322-328` | WP5 |

### 1.3 已核实的约束（设计依据）

- **两侧解码器都忽略已知帧中的未知字段**：daemon `decodeSarpWorkerFrame` 只重建已知字段（`sarp-protocol.ts:299-440`）；Python `decode_daemon_frame` 只读已知键（`protocol.py:292-316`）。→ 新增可选字段可以留在 SARP/1。
- **`resume.value` 在 SDK 中是必填非空字符串**（`protocol.py:311`，`_req_str`）。→ 不能把 `value` 改成对象，只能新增 `resume.decision`。
- **server 对 interrupt 摘要逐字段白名单重建**（`server/src/lib/runtime-probe.ts:116-141`）。→ 新字段必须同步加入白名单，否则被剥掉。
- **`SqliteSaver` 不支持异步方法**（`aget_tuple` 直接 `NotImplementedError`）。→ 图执行不能一律改用 `astream`。
- **manifest entry revision = 归一化条目 JSON 的 sha256**（`agent-runtime-manifest.ts:300-301`）。→ 新增带缺省值的字段会改变所有现存 revision（会话重启 + checkpoint 命名空间变化）。
- **`create_agent` 返回 `CompiledStateGraph`**（`.venv/Lib/site-packages/langchain/agents/factory.py` 返回类型标注）。

---

## 2. 设计决策

| # | 决策 | 理由 | 放弃的备选 |
|---|---|---|---|
| DEC-1 | bridge 只保留一个 runtime 标识 **`bridge`**；`langchain` / `langgraph` 仅作输入别名，在每个入口归一 | 与现有术语一致（`BRIDGE_RUNTIME_IDS`、`SLOCK_BRIDGE_RUNTIMES`、`kind:"bridge"`、`jsonl-bridge`）；标签没有行为意义 | `sarp`（术语过专）、`custom`（代码语义模糊）、保留双标签 |
| DEC-2 | 框架名改为展示信息：取 worker 上报的 `runtime.frameworkVersion`，probe 摘要新增 `framework` 字段 | worker 自报，任何框架都能显示，不用维护名单 | manifest 手填 `framework` |
| DEC-3 | 行为分流只看 capabilities，不看 runtime 标识 | 现状已如此 | — |
| DEC-4 | 协议只做**可选字段增量**，SARP 版本保持 1；规范补"已知帧未知字段必须忽略" | 两侧实现已满足；免去版本协商 | 升 SARP/2 |
| DEC-5 | resume 保留 `value: string`（必填），新增中立结构 `resume.decision` | 兼容旧 SDK；daemon 不认识框架私有形状 | 把 value 改成 unknown |
| DEC-6 | daemon 保持中立：只传中立的 `decision` / `options`；LangChain HITL 形状映射放在 SDK | 架构原则：daemon 只和 agent 软件通信，不懂框架 | daemon 内置 HITL 映射 |
| DEC-7 | worker 进程 cwd 保持 manifest cwd；工作区以**绝对路径**告知；SDK 提供可选 `workspace_cwd` | 相对 args 和 worker 自管配置依赖代码目录 | daemon 改 spawn cwd（会破坏 `args:["agent.py"]`） |
| DEC-8 | bridge 的 `finalText` 是一等回复通道：daemon 必发、不受 reply-guard 开关影响、不追问 | reply-guard 是给 Claude 忘调工具设计的兜底 | 维持现状 |
| DEC-9 | SDK 一个入口 `serve_agent` 按对象类型分派（图 / Runnable），`serve_langgraph` / `serve_langchain` 保留为兼容包装 | 真实边界是"是否有状态图"；保住 stable API | 删除旧入口；合并成单一实现 |
| DEC-10 | 接受一次性重置：WP6 合入时 bridge agent 的会话、待审批 interrupt、LangGraph checkpoint thread 重新开始；checkpoint 命名空间同时去掉 runtime 分量 | 仍在实验开关后，迁移代价最低；以后改名不再重置 | 维持旧命名空间的复杂兼容 |
| DEC-11 | manifest 新增 `promptProfile`：`neutral`（默认）/ `agentic` / `none`；缺省时**不写入**归一化条目 | worker 能力各异；缺省不入 revision，WP2 合入不触发重置 | 按 capability 动态生成（平台提示在握手前下发，拿不到 capability） |

---

## 3. 详细改动

### WP1　SDK：Slock MCP 工具事件标注（P0）

**目标**：真实 SDK 发出的 Slock 工具事件满足 daemon 契约 `tool.provider="slock"`、`tool.operation=<工具名>`，修复 G7。

**现状**

- daemon 只在 tool.end 配对后 `provider === "slock" && operation === "send_message" && ok` 时豁免 empty-success（`persistent-jsonl-worker.ts:518-523`）。
- reply-guard 另外按工具名匹配（`agent-runtime-dispatch-stream.ts:187-194`），所以不会重复代发，但回合仍被判失败。
- SDK 所有工具事件固定 `provider="langgraph"`（`langgraph.py:433-450`）或 `"langchain"`（`langchain.py:230-253`），SDK 内没有 `provider="slock"`；`TurnEmit.tool_start / tool_end` 已支持 `operation` 参数（`runtime.py:94-144`）。
- daemon 侧相关测试全是手写帧（`test/persistent-jsonl-worker.test.ts:380-389`、`test/sarp-bridge-integration.test.ts:74-85`），真实 SDK 路径没覆盖。

**改动**

1. `langgraph.py`：`on_initialize` 记录 `state["slock_tool_names"] = {t.name for t in tools}`；`_handle_update` 发事件时：
   ```python
   def _provider_fields(name: str | None) -> dict:
       if name and name in state["slock_tool_names"]:
           return {"provider": "slock", "operation": name}
       return {"provider": "langgraph"}
   ```
   `tool_start`（AIMessage.tool_calls 的 name）与 `tool_end`（ToolMessage.name）都用它。
2. `langchain.py`：`_load_langchain_tools` 产出的名字集合传入 `_run_one_turn → _stream_events`，`on_tool_start / on_tool_end / on_tool_error` 同样映射。
3. WP8 合入后，这段逻辑移入共享内核，并优先读工具 metadata（见 WP8.2）。

**测试**

- `bridges/python/tests/test_langgraph_adapter.py`：工厂拿到名为 `send_message` 的 Slock 工具（复用 `tests/fixtures/fake_mcp_server.py` 或注入假 client），断言 `tool.start.tool == {"name":"send_message","provider":"slock","operation":"send_message"}`，tool.end 同；本地 `@tool` 仍是 `provider="langgraph"`。
- `test_langchain_adapter.py`：同上（对照 `provider="langchain"`）。
- `packages/daemon/test/sarp-python-worker.test.ts`（真实 Python worker）：新增"send_message 成功 + finalText 为空 → 回合 success"。若该 fixture 难以挂 MCP，至少保证 python 侧帧形状测试 + daemon 侧现有手写帧测试，并在提交说明里写明。

**验证**：`bridges/python> .venv\Scripts\python.exe -m pytest -q`；`packages/daemon> $env:SLOCK_TEST_PYTHON="<venv python>"; npx vitest run test/sarp-python-worker.test.ts`

---

### WP2　daemon：bridge 输入去 Claude 化（P0）

**目标**：bridge worker 收到的平台提示与回合 prompt 不含 Claude Code 专属约定，并可按 entrypoint 选择提示档位。修复 G1（prompt 部分）、G3。

**现状**：见 G1、G3。另外，bridge 平台提示在 MCP 描述符解析**之前**生成（`agent-runtime-dispatch-headless.ts:310-313` 早于 `:314-338`），没法按"是否有 MCP 工具"取舍内容。

**2.1 manifest 字段 `promptProfile`**

- `agent-runtime-manifest.ts`：`RuntimeManifestEntry` 增 `promptProfile?: "neutral" | "agentic" | "none"`；`validateEntry` 校验（非法 → `entry-prompt-profile-invalid`）；**缺省时不写入归一化条目**（保持现存 revision 不变，见 §1.3）。
- `schemas/runtime-manifest.schema.json`：加属性与枚举；`test/runtime-manifest-schema.test.ts` 的 schema / 校验一致性测试同步。
- `runtime-manifest-manager.ts` 与 `cli/runtime.ts:436-478`（`addEntryFlags`）：增 `--prompt-profile <neutral|agentic|none>`。
- `agent-runtime-profile.ts`：`ResolvedAgentRuntimeProfile` 透出 `promptProfile`（缺省 `"neutral"`）。

**2.2 平台提示重写（`system-prompt.ts`）**

- 签名：`generateBridgeSystemPrompt(agent, dispatchContext, opts: { profile: "neutral" | "agentic"; workspacePath: string; mcpAvailable: boolean })`；`none` 由调用方直接不生成。
- neutral 内容：身份与平台简介、授权、任务完成标准、**回复契约**（"你本回合的最终回答会由平台自动发到当前会话；需要发到其它会话、发附件或分多条消息时，使用 `send_message` / `upload_attachment` 工具（若可用）。"）、slock 工具面（仅 `mcpAvailable` 时列出，**不出现任何 CLI 命令**）、经理 / 派发说明（仅 `mcpAvailable`）、真实限制（沉默超时）。
- agentic 追加：工作区绝对路径、`deliverables/` 约定、`MEMORY.md` 约定——全部以 `workspacePath` 绝对路径表述。
- 删除：CLI 兜底、"回合输出的文本不会被自动发送"、"当前工作目录是你的专属持久工作区"。
- 调用点 `agent-runtime-dispatch-headless.ts:306-338`：先解析 MCP 描述符，再按 `runtimeProfile.promptProfile` 生成；`none` 时 `platformPrompt = undefined`。

**2.3 回合 prompt 分流（`agent-runtime-dispatch.ts`）**

- 新文件 `src/bridge-turn-prompt.ts`（纯函数，便于单测），构造中立模板：
  ```
  [历史信封（若有，沿用 attachTurnContext 产物）]
  【@alice 在 #general 的消息】 / 【@alice 的私信】 / 【@alice 在 #general 线程 1a2b3c4d 的消息】
  <用户原文>
  [附件摘要（若有）]
  ```
  提醒：`【提醒触发】<title>（相关会话：<channel>）`；巡检：保留职责说明，去掉 CLI 与 MEMORY.md；分诊：保留"回复 / 派发 / 不介入"三选一，工具名统一写"平台提供的回复 / 派发工具"（入队时不知道 MCP 是否可用）。
- `runAgent / runAgentDm / runAgentReminder / runAgentTriage`（`:707-779`）开头调用 `resolveRuntimeProfile(agentName)`（同闭包 `:285-287`；解析报错按非 bridge 处理，错误留给 doDispatch 报）；bridge 走 `bridge-turn-prompt.ts`，Claude 路径逐字不变。
- 入队时打标：`DispatchQueueItem` 增 `bridge?: boolean`（`agent-dispatch-queue.ts:37-58` 与 enqueue 参数 `:105-114`）；投递 `deliver`（`:553-576`）对 bridge 批次**不追加** `REMINDER_TAIL`。用入队时的标记而不是投递时重新解析，避免两次解析之间 profile 变化导致不一致。
- 角色行（`agent-runtime-dispatch-headless.ts:272`）：bridge 保留（经理 / 派发事实对 bridge 同样成立）。

**测试**

- 新增 `test/bridge-turn-prompt.test.ts`：@ / DM / 线程 / 提醒 / 巡检 / 分诊模板；断言不含 `MEMORY.md`、`slock message send`、`mcp__slock__`、`<slock-reminder>`、`deliverables`；含发送者与原文。
- 平台提示：neutral 不含 CLI / MEMORY.md / "当前工作目录"；agentic 含绝对工作区路径；`mcpAvailable=false` 不列工具；`none` → `test/agent-runtime-dispatch-headless.test.ts` 的 bridge 用例断言 `openSession` 收到的 `platformPrompt` 为 undefined。
- `test/agent-runtime-dispatch.test.ts`：bridge agent 投递不带 tail；Claude agent 仍带（回归）。
- manifest / CLI：`agent-runtime-manifest.test.ts`、`runtime-manifest-schema.test.ts`、`runtime-manifest-manager.test.ts`、`cli-runtime.test.ts`——合法值、非法值错误码；**缺省不改变 revision**（同一条目加与不加缺省值时 revision 相等）。

**验证**：`packages/daemon> npx vitest run test/bridge-turn-prompt.test.ts test/agent-runtime-dispatch.test.ts test/agent-runtime-dispatch-headless.test.ts test/agent-runtime-manifest.test.ts test/runtime-manifest-schema.test.ts test/runtime-manifest-manager.test.ts test/cli-runtime.test.ts`；`npx tsc --noEmit -p packages/daemon/tsconfig.json`

**兼容**：平台提示不进 identity——已在运行的 worker 保持旧提示，直到下次 spawn（空闲回收 / 重启 / identity 变化）。

---

### WP3　工作区路径与 cwd（P0）

**目标**：修复 G5，避免带文件工具的 agent 把相对路径写进用户代码目录。

**改动**

1. daemon：spawn cwd 保持 manifest cwd（DEC-7）；WP2 的提示里工作区一律用绝对路径。
2. SDK：`serve_langgraph` / `serve_langchain`（WP8 后为 `serve_agent`）新增 `workspace_cwd: bool = False`；为 True 时在 `on_initialize` 开头、调用工厂之前执行 `os.chdir(init.workspace_path)`。
3. 文档：README / quickstart 写明"文件类工具使用 `init.workspace_path`；自管 `.env` 用 `Path(__file__).parent` 定位"。
4. 示例：`bridges/examples/langgraph-agent` 设 `workspace_cwd=True`，manifest 设 `"promptProfile": "agentic"`。

**测试**：python——`workspace_cwd=True` 时工厂内 `os.getcwd() == init.workspace_path`；默认行为不变。daemon——WP2 提示测试已覆盖绝对路径。

---

### WP4　bridge 最终回复语义（P0）

**目标**：修复 G4、G6。

**改动**（`agent-runtime-dispatch-stream.ts`）

1. `armTurnGuard`（`:83`）增参数 `bridge: boolean`；调用点 `agent-runtime-dispatch-headless.ts:457`（persistent）与 `:560`（one-shot）传入 `isBridge`（`:245`）。
2. turn.end 分支（`:265-330`）在 `guard.bridge` 时：
   - `status === "success" && result.trim() && !hadSend` → 无条件代发（进度消息改写 / `onReplyMissing`），**不检查** `loadDaemonEnv().replyGuard`；
   - 不追问（无文本场景由会话层 `empty-success` 报错）。
3. Claude 路径不变。

**测试**：bridge + `SLOCK_REPLY_GUARD=0` 仍代发；bridge 无文本不追问；bridge 已 send 不重复代发；Claude 回归（追问文案与开关语义不变）。

---

### WP5　conformance runner 修正（P1）

**改动**（`sarp-conformance.ts`）

1. cancel（`:331-354`）：去掉 `capabilities.interrupts !== false` 门（规范中 `cancelled` 是必需终态，`02-sarp1-protocol.md:119,126`）；`cancelled` → pass；`success` → pass，detail 标注 "turn finished before cancel (race)"；其它 → fail。
2. 坏帧（`:380-409`）：收到 `runtime.error` 后等待退出（≤1.5s），记录退出码并置 `workerDead`。
3. 关停（`:411-437`）：**新起一个 worker** 执行"握手 → shutdown → 期望 `runtime.stopped` → 期望 exit code 0"；非 0 → fail。
4. WP11 合入后：仅当 ready 声明 `capabilities.cancel === false` 时跳过 cancel。

**测试**：`test/sarp-conformance.test.ts`——interrupts:false 的 fixture 不再跳过 cancel；坏帧后 exit 2 被识别；优雅关停 exit 0 → pass，非 0 → fail。

**验证**：`npx vitest run test/sarp-conformance.test.ts`；两个模板 `npx tsx src/cli.ts runtime check <id> --run-turns --manifest <临时 manifest>`（LangChain 模板应为 9/9）。

---

### WP6　runtime 标识统一为 `bridge`（P1）

**6.1 shared**（`packages/shared/src/index.ts`）

```ts
export const BRIDGE_RUNTIME_ID = "bridge" as const;
/** 旧标识：只作输入别名，入口处归一为 BRIDGE_RUNTIME_ID */
export const LEGACY_BRIDGE_RUNTIME_IDS = ["langchain", "langgraph"] as const;
export const BRIDGE_RUNTIME_IDS = [BRIDGE_RUNTIME_ID] as const;
export type BridgeRuntimeId = typeof BRIDGE_RUNTIME_ID;

export function normalizeRuntimeId(id: string | null | undefined): string | undefined {
  const v = id?.trim().toLowerCase();
  if (!v) return undefined;
  return (LEGACY_BRIDGE_RUNTIME_IDS as readonly string[]).includes(v) ? BRIDGE_RUNTIME_ID : v;
}

export const isBridgeRuntime = (id: string | null | undefined): boolean =>
  normalizeRuntimeId(id) === BRIDGE_RUNTIME_ID;
```

- `RuntimeEntrypointProbe` 增 `framework?: string`、`bridgeVersion?: string`（`version` 保留兼容）。
- 顺手：`interrupt:dismiss` 在 browser 消息联合里声明了两次（`:473`、`:697`），合并为一处。

**6.2 daemon**

| 位置 | 改动 |
|---|---|
| `agent-runtime-manifest.ts:105` `validateEntry` | 接受 `bridge` 与旧别名；`entry.runtime = "bridge"`；新增 `entry.declaredRuntime`（manifest 原值，用途见下一行）；旧别名在 manifest 审计里记弃用告警 |
| `drivers/jsonl-bridge-runtime.ts:134` | 传给 worker 的 `runtime` 用 `entry.declaredRuntime`：老 SDK worker 会严格比对 `init.runtime_id`（`langgraph.py:332-337`），manifest 仍写旧值时下发旧值，保证老 worker 可用 |
| `persistent-jsonl-worker.ts:449` | 握手比较两侧 `normalizeRuntimeId` |
| `drivers/runtime-entrypoint-probe.ts:207,223-233` | probe 归一比较；摘要 `runtime: "bridge"`，新增 `framework`、`bridgeVersion` |
| `agent-runtime-profile.ts:80,109` | `runtime = normalizeRuntimeId(info.runtime) ?? "claude"`；`:109` 改为 `!isBridgeRuntime(runtime)` |
| `handlers/agent.ts:16-33` | `runtimeCandidates` 先归一再去重比较（否则 `langgraph` 与 `bridge` 混用会误报 `runtime-profile-conflict`） |
| `agent-runtime-interrupt-store.ts:131-134,149-151` | 兼容比较两侧归一 |
| `schemas/runtime-manifest.schema.json:32` | enum 加 `"bridge"`，旧值保留并标 deprecated |
| `cli/runtime.ts:440` | `--runtime` 帮助改为 `bridge (legacy: langchain|langgraph)`，省略时默认 `bridge` |
| `sarp-conformance.ts` 默认 runtimeId、注释 | 改为 `bridge` |

**6.3 server**

| 位置 | 改动 |
|---|---|
| `routes/agents-public.ts:143-149`（POST）/ `:391-392`（PATCH） | 先 `normalizeRuntimeId`，再判 `isBridgeRuntime` / flag |
| `agents-public.ts:202-223`、`:413-429` | entrypoint 匹配改为 `normalizeRuntimeId(e.runtime) === runtimeId`（旧 daemon 上报的 probe 仍是旧值） |
| `agents-public.ts:280-286` | 持久化归一后的 `bridge` |
| `lib/runtime-probe.ts:51-107` `normalizeEntrypoints` | `runtime` 归一；白名单透传 `framework`、`bridgeVersion` |
| `routes/people.ts:290-293` | 读取时归一（兜底） |
| 新迁移 `db/migrations/035_bridge_runtime_rename.sql` | 见下 |

```sql
-- 035_bridge_runtime_rename.sql：bridge runtime 标识统一（langchain / langgraph → bridge）
CREATE TABLE IF NOT EXISTS agents_runtime_profile_bak_035 AS
  SELECT id, runtime_profile FROM agents
  WHERE runtime_profile->>'runtime' IN ('langchain', 'langgraph');

UPDATE agents
SET runtime_profile = jsonb_set(runtime_profile, '{runtime}', '"bridge"')
WHERE runtime_profile->>'runtime' IN ('langchain', 'langgraph');
```

`computers.entrypoints` 快照不迁移：daemon 下次 `ready` / `entrypoints:refresh` 会覆盖；读取时由 `normalizeEntrypoints` 归一。

**6.4 web**

| 位置 | 改动 |
|---|---|
| `stores/computerStore.ts:70-78` | 两条 bridge 项合并为 `{ id: "bridge", label: "自建 Agent", kind: "bridge" }` |
| `pages/ComputerView.vue:136-147,192` | runtime 选项按归一后的 id 聚合；entrypoint 选项显示 `label · framework`（无 framework 时只显示 label） |
| `ComputerView.vue:722-738,812` | chip 显示 `framework ?? runtime` |
| `components/people/MemberProfileBody.vue:3,171-181` | `isBridgeProfile` 改用 `isBridgeRuntime`；runtimeLabel 先归一再查 CATALOG |
| `pages/PeopleView.vue:278-280` | 同上 |

**6.5 Python SDK**

- `runtime_id` 默认改为 `"bridge"`；握手接受 `init.runtime_id ∈ {"bridge","langchain","langgraph"}`，不再要求与参数逐字相等；`serve_langchain` 补上缺失的 runtime id 校验。
- `checkpoint_thread_id`（`langgraph.py:94-109`）去掉 `runtime_id` 分量（entrypoint 已唯一标识 worker）——一次性改变 thread_id（DEC-10）。
- probe / ready 的 `runtime.id` 输出 `"bridge"`。
- pip extras `[langgraph]` / `[langchain]` 名称保留（它们是依赖分组，不是 runtime 标识）。

**6.6 一次性影响（DEC-10）**：所有 bridge agent 的 profile identity 变化 → 常驻 worker 重启；`clearIncompatible` 清除待审批 interrupt；LangGraph checkpoint thread 重新开始（旧数据仍在 sqlite 中，只是不再被引用）。写入发布说明。另外：新 manifest 写 `bridge` 时，老 SDK worker 会因 `init.runtime_id` 不符而握手失败（RUNTIME_ID_MISMATCH，错误清晰），需同时升级 SDK 或暂时保留旧 runtime 值。

**测试**（大量机械替换，规模见附录 C）

- 新增：shared `normalizeRuntimeId` 单测；manifest 旧别名 → `bridge` + 弃用告警；`handlers/agent` 混用别名不报冲突；server POST / PATCH 以 `langgraph` 创建 → 持久化 `bridge`；server 旧 probe（runtime=langgraph）可匹配 `bridge` 请求；web CATALOG 只有一个 bridge 项；握手：manifest 写 `langgraph` 时 initialize 下发 `langgraph`，worker 回 `bridge` 也通过。
- 契约夹具：`bridges/python/tests/fixtures/` 与 `packages/daemon/test/sarp-contract-fixtures.test.ts` 同步修改，两侧一致。

**验证**：`pnpm -r typecheck`、`pnpm -r test`、Python pytest、`SLOCK_TEST_PYTHON` e2e、两个模板 conformance。

---

### WP7　SARP/1 增量字段（P1）

**规范先行**（`docs/2026-09-21/02-sarp1-protocol.md`）

- 新增规则 **R-UF**：已知 type 帧中的未知字段，接收方必须忽略；发送方不得依赖对端理解新增字段。
- 以下字段全部可选，版本仍为 1。

**7.1 turn.start**

```ts
interface SarpTurnStartFields {
  turnId: string;
  conversationId: string;
  attempt: number;
  source: { kind: string; channel?: string; threadId?: string; sender?: string };
  /** 语义不变：平台组装好的完整文本（旧 worker 继续用它） */
  prompt: string;
  /** 新增：触发本回合的人类消息原文（不含平台指令与历史）。提醒 / 巡检等缺省；合并批次按 "\n\n" 拼接 */
  message?: { text: string; sender?: string; messageId?: string; attachments?: SarpAttachment[] };
  /** 新增：平台注入的会话历史文本（与 prompt 中的历史信封同源） */
  contextText?: string;
  resume?: {
    interruptId: string;
    resumeToken: string;
    /** 保持必填非空字符串（旧 SDK protocol.py:311）；改为人类回复原文或决定的可读文本 */
    value: string;
    /** 新增：结构化决定（来自审批按钮），中立形状 */
    decision?: SarpResumeDecision;
  };
}

interface SarpAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url?: string;
}

type SarpResumeDecision =
  | { type: "approve" }
  | { type: "reject"; message?: string }
  | { type: "respond"; message: string }
  | { type: "edit"; args: unknown };
```

**7.2 turn.interrupt / turn.end.interrupt**

```ts
interface SarpInterruptOptions {
  decisions?: Array<"approve" | "reject" | "respond" | "edit">;
  /** 待审批动作预览；daemon 外发前截断 + 脱敏 */
  actions?: Array<{ name: string; args?: unknown; description?: string }>;
}
// turn.interrupt 与 turn.end.interrupt 均新增 options?: SarpInterruptOptions
```

**7.3 daemon**

| 位置 | 改动 |
|---|---|
| `sarp-protocol.ts:60-67,177-198,284-289` | 类型更新；`parseInterrupt` 解析 `options`（decisions 只收枚举值；actions ≤10 项，name 必填，其余丢弃） |
| `agent-runtime-driver.ts:25-42` | `AgentTurnRequest` 增 `message?`、`contextText?`、`resume.decision?` |
| `agent-runtime-events.ts:30-35` | `AgentRuntimeInterrupt` 增 `options?` |
| `persistent-jsonl-worker.ts:831-846` | turn.start 写入新字段；预览 / 终态一致性校验（`:579-590`）仍只比三字段 |
| `agent-dispatch-queue.ts:37-58,105-114` | item 增 `message?`；合并规则：text 用 "\n\n" 拼接、attachments 拼接、messageId 取最后一条 |
| `handlers/deliver.ts:43-48` → `runAgent*` → `dispatchToAgent`（`agent-runtime-dispatch.ts:607-637`） | 透传原文与结构化附件（`m.attachments`）；`content` 中的附件摘要保留（Claude 不变） |
| `agent-runtime-dispatch.ts:566-575` | **`resumeValue` 改为原文**（合并后的 `message.text`；无原文时退回现状）——修复 G2 |
| `agent-runtime-dispatch.ts:649-705` | `attachTurnContext` 额外返回信封文本，bridge 回合写入 `contextText` |
| `agent-runtime-interrupt-store.ts:20-37` | `PendingRuntimeInterrupt` 增 `options?`、`kind?`（来源 DispatchKind，WP10 用） |
| `agent-runtime-dispatch-headless.ts:497-513` | put 时写入 `options`、`kind` |
| `daemon-core.ts:329-351` `sendInterruptsState` | 摘要增 `options`：`actions[].args` 经 `redactSecrets` 后 JSON 截断为 `argsPreview`（≤500 字符） |

**7.4 shared / server**

- `PendingInterruptSummary`（`shared/src/index.ts:534-547`）增 `options?: { decisions?: string[]; actions?: Array<{ name: string; argsPreview?: string; description?: string }> }`。
- `server/src/lib/runtime-probe.ts:116-141` `normalizeInterrupts`：白名单补 `options`（逐字段重建、decisions 过滤枚举、actions 限长）——**不加会被剥掉**。

**7.5 Python SDK**

- `protocol.py`：`SarpTurnStart` 增 `message`、`context_text`；`SarpResume` 增 `decision`（`_opt_obj`）；均为可选，缺省 None。
- `runtime.py`：`InterruptRecord`（`:50-55`）增 `options`；`TurnEmit.interrupt`（`:149-160`）与 `_emit_turn_end`（`:488-513`）输出 `options`。
- 默认 input mapper 不变（仍用 `prompt`）；README 说明自定义图可用 `turn.message.text` 取原文。

**测试**

- daemon：`sarp-protocol.test.ts`（options 解析与非法项过滤）、`persistent-jsonl-worker.test.ts`（含新字段的 turn.start 帧快照）、`agent-dispatch-queue.test.ts`（合并规则）、`agent-runtime-interrupt-store.test.ts`（options / kind 持久化）、`agent-runtime-dispatch.test.ts`（resumeValue = 原文）、daemon-core 摘要（脱敏 + 截断）。
- 契约夹具：两侧新增含新字段的样例；旧样例（无新字段）仍通过。
- python：`test_protocol.py`（新字段解码；缺省兼容）。
- server：`runtime-probe.test.ts`（保留 options、剥离未知字段）。

---

### WP8　SDK 统一（P1）

**8.1 新入口与分派**

```python
def serve_agent(
    agent_or_factory: Any,
    *,
    input_mapper=None,
    output_mapper=None,
    interrupt_mapper=None,
    resume_mapper=None,            # WP9
    custom_event_mapper=None,
    usage_extractor=None,
    cost_calculator=None,
    system_prompt_mode: Literal["prepend", "none"] = "prepend",
    execution: Literal["auto", "sync", "async"] = "auto",
    workspace_cwd: bool = False,   # WP3
    streaming: bool = True,
    runtime_id: str = "bridge",
    framework_version: str | None = None,
    transport=None,
    journal=None,
) -> int: ...
```

在 `on_initialize` 拿到对象后判定一次：

1. **工厂**：可调用且不是图 / Runnable → `factory(init, tools)`；支持 `async def` 工厂（在常驻事件循环中执行，见 8.3）。
2. **图路径**：`isinstance(obj, langgraph.pregel.Pregel)`（`CompiledStateGraph`、`create_agent` 产物）→ 现 `langgraph.py` 逻辑。
3. **Runnable 路径**：具备 `astream_events` / `ainvoke` / `invoke` → 现 `langchain.py` 逻辑（无状态）。
4. 其它 → 握手期 `GRAPH_INPUT_INVALID`（消息带对象类型名）。

编译后的图同时也是 Runnable，**必须先判图**。`serve_langgraph` / `serve_langchain` 保留签名，内部调用 `serve_agent` 并强制路径；文档标注推荐 `serve_agent`。建议新增模块 `slock_runtime/agent.py` 承载 `serve_agent` 与共享内核（内容扁平化、截断、usage、错误映射、工具事件），两个旧模块只保留各自路径的执行循环。

**8.2 统一工具类型**

- 两条路径的工厂都拿到 `list[SlockStructuredTool]`：`StructuredTool` 子类，额外保留 `input_schema: dict` 与 `call(args) -> str`，兼容旧 LangGraph 工厂代码（`t.input_schema`、`t.invoke(dict)` 仍可用）。
- 设置 `metadata={"slock": True, "operation": name}`；WP1 的 provider 判定改为优先读 metadata，其次按名。

**8.3 图的执行模式**

- 现状：图路径只调同步 `graph.stream` / `graph.invoke`（`langgraph.py:517-518,554`），async 节点失败（D5）；Runnable 路径每回合 `asyncio.run`（`langchain.py:263`）。
- 约束：`SqliteSaver` 不支持异步（§1.3），**不能**一律改用 `astream`。
- `execution="auto"`：checkpointer 类名以 `Async` 开头，或检测到 async-only 节点 → async；否则 sync（保持现状，SqliteSaver 可用）。`"sync"` / `"async"` 为强制模式。
- async 用**常驻事件循环**：worker 生命周期内一个后台线程 + loop，回合经 `asyncio.run_coroutine_threadsafe` 提交，不再每回合 `asyncio.run`——`AsyncSqliteSaver` / aiosqlite 等资源绑定创建它的 loop，跨 loop 复用会失败。Runnable 路径一并迁到常驻 loop。
- cancel：逐事件检查 `cancelled`（与现状一致）；增强：取消时 `task.cancel()`。

**8.4 输入校验**

- 使用默认 input mapper 时，握手期检查图输入 schema 是否含 `messages`（`graph.get_input_jsonschema()["properties"]`；取不到就跳过检查）；缺失 → `GRAPH_INPUT_INVALID`："graph state has no 'messages' key; pass input_mapper/output_mapper"（替代 D2b 现在的 `WORKER_ERROR 'question'`）。
- 运行期 mapper 抛 KeyError 时，包装成同码的明确信息。

**8.5 其它一致性**

- `system_prompt_mode` 两路径都遵守：图路径仅新 thread 前置（现状）；Runnable 路径每回合前置（无状态，等价于上下文中出现一次）。
- 能力上报：Runnable 路径 `interrupts:false, durableThreads:false`；图路径按 checkpointer 判定。LCEL 不会再误走图路径并声明 `interrupts:true`（D10 现象随分派消失）。
- Runnable 路径保持无状态；需要记忆请用图（`create_agent` + checkpointer），文档写明。

**测试**

- `test_public_api.py`：`serve_agent` 已导出；旧入口仍在。
- 新 `test_serve_agent_dispatch.py`：CompiledStateGraph → 图路径；`create_agent` + InMemorySaver 多轮记忆（复现 D8：模型收到消息数 1→3→5）；LCEL → Runnable 路径并逐 token 流式（复现 D6）；不支持的对象 → 握手失败。
- async：纯 async 节点图在 auto 下成功（D5 转绿）；AsyncSqliteSaver 跨两回合可用；SqliteSaver + 同步图仍走 sync。
- 输入校验：无 messages 且无 mapper → 握手 `GRAPH_INPUT_INVALID`；有 mapper → 成功（D2）。
- 工具：两路径工厂拿到的都是 `StructuredTool` 实例，且有 `input_schema`。

---

### WP9　interrupt 渲染与 resume 映射（P1）

**9.1 默认 interrupt 渲染**（`_interrupt_record`，`langgraph.py:405-416`；用户提供 `interrupt_mapper` 时仍以用户为准）

- `str` → 原样。
- LangChain HITLRequest（dict 且含 `action_requests` 列表）→ 可读文本："需要审批：调用 `send_email`（to=…, body=…）。可选：批准 / 拒绝 / 回复 / 修改"；同时生成 `options`：`decisions` = 各 `review_configs[].allowed_decisions` 的交集，`actions` = `action_requests` 的 name / args / description。
- dict 含字符串键 `prompt` / `question` / `message` → 取该值。
- 其它 → `json.dumps(value, ensure_ascii=False)` 截断，不再用 `str()`。

**9.2 resume 映射**

- 现状：`Command(resume=turn.resume.value)`（`langgraph.py:493`）；HITL 中间件读取 `interrupt(...)["decisions"]`（`human_in_the_loop.py:481`），决定类型为 approve / edit / reject / respond（`:65`）；纯字符串恢复报错，token 已被消费，daemon 删除 pending，审批作废（D11）。
- 新增钩子 `resume_mapper(init, turn, interrupt_value) -> Any`。默认实现：
  1. 读取当前 thread 的待处理 interrupt 值（`graph.get_state(config).tasks[*].interrupts[*].value`；复用 `:480-486` 已有的 `get_state` 调用）。
  2. 若为 HITLRequest：
     - 有 `turn.resume.decision` → 转为 HITL 决定：approve → `{"type":"approve"}`；reject → `{"type":"reject","message":m}`；respond → `{"type":"respond","message":m}`；edit → `{"type":"edit","edited_action":{"name":<动作名>,"args":args}}`。按 action_requests 数量复制（中间件校验数量相等，`human_in_the_loop.py:483-489`）。
     - 只有 `value` 文本 → 归类：批准词（批准 / 同意 / 可以 / 确认 / approve / yes / ok / lgtm，忽略大小写与首尾标点）→ approve；**其它一律 reject，message = 原文**（歧义输入不执行被拦截的动作）。reject 不在 allowed_decisions 时退到 respond；仍不允许 → `GRAPH_INPUT_INVALID`。
  3. 非 HITL：有 `decision` → 传 decision dict；否则传 `value`（现状语义）。
- 依赖 WP7 修复 G2：`value` 是用户原话，归类才可靠。
- 已知限制：resume token 在 `runtime.py:401-425` 先于映射被消费；默认映射保证不失败。把校验前移到消费之前留作后续。

**测试**（create_agent + `HumanInTheLoopMiddleware` + InMemorySaver，复现 D11）

- 文本"批准" → 工具执行，回合 success；
- 文本"先别发" → reject，工具未执行，模型收到拒绝信息；
- `decision={"type":"edit","args":{...}}` → 按修改后的参数执行；
- 同一回合两个待审批工具调用 → 决定复制两份；
- interrupt 帧 `options.decisions == ["approve","edit","reject","respond"]`，prompt 为可读文本。

---

### WP10　结构化审批 UI 与 `interrupt:resolve`（P2）

**10.1 消息**（shared）

```ts
// browser → server
| {
    type: "interrupt:resolve";
    agentId: string;
    conversationId: string;
    interruptId: string;
    decision: SarpResumeDecision;
  }
// server → daemon：同形状，另附 approver?: string（审批人 handle，作为 turn.start.source.sender）
```

**10.2 server**

- `ws/validate.ts`：新增 zod schema（decision 判别联合；message ≤4000 字符；args JSON ≤16KB）。
- `ws/handler.ts:626-638` 旁新增 case；`resolveInterruptDismissTarget`（`:674-697`）改名为 `resolveInterruptTarget` 复用（owner 校验不变）；`sendToDaemon(..., { type: "interrupt:resolve", ..., approver })`。

**10.3 daemon**

- `handlers/index.ts:45-55` 旁新增 `interrupt:resolve` → `ctx.runtime.resolveInterrupt(...)`。
- `agent-runtime.ts` 新方法 `resolveInterrupt(agentId, conversationId, interruptId, decision, approver?)`：
  1. 只读取 pending（不消费）；interruptId 不符或已过期 → 忽略并重推 `interrupts:state`（前端按钮随之消失）。
  2. 入队一条 dispatch：channel / threadId / kind 取自 pending 记录（WP7 已存 `kind`）；`content` 为决定的可读文本（"【审批】批准" / "【审批】拒绝：<原因>"）；`sender = approver`；携带 `resolve: { conversationId, interruptId, decision }`。
- `agent-dispatch-queue.ts`：item 增 `resolve?`；带 resolve 的 item **不参与合并**。
- `agent-runtime-dispatch.ts:412-438`（doDispatch）：有 `turnSeed.resolve` 时 `conversationId = resolve.conversationId`；`take()` 后要求 `pending.interruptId === resolve.interruptId`，否则丢弃并告警；`resume = { interruptId, resumeToken, value: <可读文本>, decision }`。
- 文本回复审批照旧（同会话下一条消息 = `resume.value`，SDK 按 WP9 归类）。

**10.4 web**

- `components/agent/PendingInterruptBanner.vue:38-46`：按 `item.options.decisions` 渲染按钮——批准 / 拒绝（可选原因）/ 回复（必填文本）；`edit` 一期不渲染（二期做 JSON 编辑）；没有 options 时保持现状（"在会话中回复以继续" + 驳回）。
- 展示 `options.actions`（name + argsPreview）。
- 发送 `wsSend({ type: "interrupt:resolve", ... })`；提交后按钮进入 loading，等 `agent:interrupts` 快照更新后移除。
- `interruptStore.ts`、`wsDispatch.ts:92-94` 不用改。

**测试**：shared 类型；server `ws-validate.test.ts` + handler 路由与 owner 校验；daemon resolve（interruptId 不符丢弃、过期丢弃、resolve item 不合并、doDispatch 带 decision）；web 组件测试（按 decisions 渲染按钮、发送帧形状）。

---

### WP11　单回合取消（P2）

- daemon：`AgentRuntimeSession` 增可选方法 `cancelTurn?(reason: string): Promise<"cancelled" | "killed" | "idle">`。JSONL 会话实现：写 `turn.cancel` → 等终态 ≤ `min(shutdownMs, 5000)` → 收到任意终态即返回并**保留进程**；超时 → 走现有 kill 路径。Claude driver 不实现。
- 能力：capabilities 新增 `cancel?: boolean`（SDK 两条路径都报 true；daemon 在 `sarp-protocol.ts:341-351` 解析；probe 摘要透出）。
- 消息：browser → server → daemon `agent:cancel-turn { agentId }`（shared 类型、zod、handler，owner 校验同 stop）。
- dispatch：`cancelled` 终态已经 resolve（`persistent-jsonl-worker.ts:627-630`），不重试、不死信；该 agent 队列里的后续消息照常投递。
- web：agent working 时显示"停止当前回合"（仅 bridge 且 `capabilities.cancel`）。
- 测试：会话层取消后进程仍在、超时则杀进程；handler 路由；web 按钮可见性。

---

### WP12　文档、模板同步（随各 WP 提交）

| 文件 | 内容 | WP |
|---|---|---|
| `docs/2026-09-21/02-sarp1-protocol.md` | R-UF；turn.start 新字段；interrupt.options；resume.decision；`cancel` 能力；runtime.id=`bridge` 与别名 | 6、7、11 |
| `docs/2026-09-21/01-bridge-runtime-实机测试手册.md`（:50、:117、:139、:143） | runtime 改 `bridge`；`promptProfile`；结构化审批与单回合取消的验证步骤 | 2、6、10、11 |
| `docs/2026-09-21/04-python-agent-quickstart.md`（:67-120） | `serve_agent`、`workspace_cwd`、`turn.message`、HITL 用法 | 3、8、9 |
| `docs/2026-09-21/03-python自建agent接入能力评估与实施计划.md` | 文首加指向本文的说明 | — |
| `docs/2026-09-20/02-daemon-langchain-langgraph-runtime-design.md`（§4.1、§4.3、§6、§8.2、§8.4、§8.6、§9.2、§11.2、§11.4、§12.2–12.3、§13） | 不重写，在相应条款加"2026-10-13 修订，见 2026-10-13/01" | 全部 |
| `bridges/python/README.md`（:14-15、:45-55、:74-77） | 推荐入口、API 稳定性分层；extras 说明 | 8 |
| `bridges/templates/*`、`bridges/examples/*`（agent.py、runtime.manifest.json:6、README） | runtime=`bridge`；使用 `serve_agent`；示例采用 agentic 档 | 2、6、8 |
| `CLAUDE.md`（:44-56、:66） | 多 runtime 段落与模块表更新 | 6 |

---

## 4. 迁移与发布

- **版本**：Python SDK `0.1.0 → 0.2.0`（`serve_agent`、`runtime_id` 默认 `bridge`、thread 命名空间变化）。
- **兼容窗口**：旧 manifest（`langgraph` / `langchain`）+ 旧 SDK worker 继续可用（daemon 下发 `declaredRuntime`、握手归一比较）。新 SDK + 旧 daemon 不保证兼容（同仓发布，不单独支持）。
- **一次性影响**（WP6，DEC-10）：bridge agent 会话重启、待审批 interrupt 清除、LangGraph checkpoint thread 重新开始。
- **发布顺序**：server（迁移 035 + 归一）→ daemon → web → SDK 与模板。server 必须先发，因为它要同时接受新旧两种 runtime 值。

## 5. 验证矩阵

| 层 | 命令（Windows PowerShell） | 时机 |
|---|---|---|
| daemon 单测 | `cd packages/daemon; npx vitest run <相关测试文件>` | 每个 WP |
| daemon 类型 | `npx tsc --noEmit -p packages/daemon/tsconfig.json` | 每个 WP |
| server / web / shared | `pnpm --filter @collabagent/server test`、`pnpm --filter @collabagent/web test`、`pnpm --filter @collabagent/web typecheck`、`pnpm --filter @collabagent/shared typecheck` | WP6、7、10、11 |
| Python SDK | `cd bridges/python; .venv\Scripts\python.exe -m pytest -q` | WP1、3、6–9 |
| 真实 worker e2e | `$env:SLOCK_TEST_PYTHON="D:\code\slock\bridges\python\.venv\Scripts\python.exe"; npx vitest run test/sarp-python-worker.test.ts test/sarp-template-manifest-e2e.test.ts` | WP1、6–9 |
| 合规 | `npx tsx src/cli.ts runtime validate` / `probe` / `check <id> --run-turns`，均带 `--manifest <临时 manifest>`（两个模板） | WP5、6、8 |
| 全量门禁 | `pnpm -r typecheck`、`pnpm -r test`、Python pytest | 每批合入前 |
| 实机 | 按测试手册：建 agent → DM → 工具调用 → HITL 审批（按钮 / 文本两种）→ 单回合取消 | WP4、10、11 完成后 |

注意：PowerShell 5 的 `Set-Content -Encoding utf8` 会写 BOM，导致 manifest 解析失败（本轮实测踩到）。写 JSON 用 `[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))`。

## 6. 回滚

- 每个 WP 独立提交，可单独 revert。
- 协议新增字段全部可选，daemon / SDK 任一侧回滚都不破坏另一侧。
- WP6 含数据迁移：回滚时先用 035 的备份表 `agents_runtime_profile_bak_035` 恢复 `runtime_profile`，再 revert 代码。

## 7. 实现前需确认的假设

| # | 假设 | 确认方法 | 影响 |
|---|---|---|---|
| H1 | `CompiledStateGraph.get_input_jsonschema()` 在 langgraph 1.2.x 可用，且能反映 state 键 | venv 中对 MessagesState 图与自定义 TypedDict 图各调用一次 | WP8.4 |
| H2 | 能可靠识别 async-only 节点（节点 runnable 只有 afunc） | 读 langgraph `RunnableCallable` 源码；不稳定则只按 checkpointer 判定 + 显式 `execution="async"` | WP8.3 |
| H3 | `AsyncSqliteSaver` 在常驻 loop 下跨回合可用 | 最小探针：同 thread 两回合 | WP8.3 |
| H4 | `astream_events` 的 tool 事件能取到工具 metadata | 探针打印 `on_tool_start` 事件 | WP1、WP8.2 |
| H5 | `get_state(config).tasks[*].interrupts` 能取到 HITLRequest 原值 | 在 D11 探针基础上打印 | WP9 |
| H6 | `StructuredTool` 子类能声明额外字段 `input_schema`、`call` 而不与基类冲突 | 最小实例化测试 | WP8.2 |

---

## 附录 A　改动文件清单（按包）

- **shared**：`src/index.ts`
- **daemon**：`src/{agent-runtime-manifest,agent-runtime-profile,agent-runtime-driver,agent-runtime-events,agent-runtime-dispatch,agent-runtime-dispatch-headless,agent-runtime-dispatch-stream,agent-dispatch-queue,agent-runtime-interrupt-store,agent-runtime,daemon-core,system-prompt,sarp-protocol,sarp-conformance,runtime-manifest-manager}.ts`、`src/bridge-turn-prompt.ts`（新）、`src/drivers/{jsonl-bridge-runtime,persistent-jsonl-worker,runtime-entrypoint-probe}.ts`、`src/handlers/{agent,deliver,index}.ts`、`src/cli/runtime.ts`、`schemas/runtime-manifest.schema.json`
- **server**：`src/routes/{agents-public,people}.ts`、`src/lib/runtime-probe.ts`、`src/ws/{validate,handler}.ts`、`src/db/migrations/035_bridge_runtime_rename.sql`（新）
- **web**：`src/stores/computerStore.ts`、`src/pages/{ComputerView,PeopleView}.vue`、`src/components/people/MemberProfileBody.vue`、`src/components/agent/PendingInterruptBanner.vue`
- **python**：`slock_runtime/{__init__,protocol,runtime,langgraph,langchain,mcp}.py`、`slock_runtime/agent.py`（新，`serve_agent` 与共享内核）、`tests/*`；`bridges/{templates,examples}/*`
- **docs**：见 WP12

## 附录 B　2026-10-13 离线实测摘要

（fake chat model，不调真实 provider；日志在本机 `%TEMP%\slock-custom-probe\`）

| # | 场景 | 结果 |
|---|---|---|
| D1 | 自定义 TypedDict state、多节点（serve_langgraph） | ✅ |
| D2 / D2b | 无 `messages` 键 + mapper / 不配 mapper | ✅ / ❌ `WORKER_ERROR 'question'` |
| D3 | 子图（包装函数 / 直接作节点） | ✅ 内层 delta 透出 |
| D4b | 工具循环 + ToolNode | ✅ tool.start → tool.end → delta → success |
| D5 | 纯 async 节点 | ❌ `No synchronous function provided` |
| D6 / D6b | LCEL（serve_langchain）/ `create_agent` + 本地工具（serve_langchain） | ✅ 逐 token / ✅ 工具事件 |
| D7 | interrupt → resume | ✅ 现有测试覆盖 |
| D8 | `create_agent` + InMemorySaver（serve_langgraph） | ✅ 工具事件；多轮记忆（模型收到消息数 1→3→5） |
| D9 | `create_agent` 无 checkpointer（serve_langgraph） | ✅ 无状态 |
| D10 | LCEL（serve_langgraph） | ❌ `unexpected keyword argument 'stream_mode'` |
| D11 | `create_agent` + HumanInTheLoopMiddleware（serve_langgraph） | interrupt ✅；纯文本 resume ❌ `string indices must be integers` |

基线测试：Python 142 passed；daemon bridge 相关 17 个文件 229 passed / 2 skipped（设 `SLOCK_TEST_PYTHON` 后，被跳过的 e2e 也通过）；conformance：LangGraph 模板 9/9，LangChain 模板 8 过 1 跳。

## 附录 C　WP6 改名规模

测试与夹具中 `"langgraph"` / `"langchain"` 作为 runtime 标识的出现次数：

| 范围 | 规模 |
|---|---|
| `packages/daemon/test` | 约 24 个文件、约 100 处（agent-runtime-profile 21、agent-runtime-interrupt-store 15、runtime-entrypoint-probe 11、sarp-worker-fixture 7、sarp-conformance 7 …） |
| `packages/server/test` | agents-bridge 16、runtime-probe 4、ws-validate 2、agents 1 |
| `packages/web/src/**/*.test.ts` | computerStore 5、wsDispatch 1、interruptStore 1 |
| `bridges/python/tests` | 7 个文件、约 37 处（含契约夹具） |
| `bridges/templates` / `bridges/examples` | 2 / 6 |
| `packages/daemon/schemas` | 2 |
