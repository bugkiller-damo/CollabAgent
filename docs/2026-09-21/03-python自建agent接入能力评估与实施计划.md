# Python 自建 Agent 接入 daemon：能力现状、接口边界与实施计划

- 日期：2026-09-21
- 状态：评估结论 / 实施提案
- 范围：用户自有 Python Worker，LangChain/LangGraph，经本机 daemon 的 SARP/1 接入

## 1. 执行摘要

SARP/1 协议 + `slock-runtime` Python SDK + daemon bridge driver + server/web 门禁与创建链路已经形成**真实的端到端闭环**：manifest 注册的 Python 进程可以被 daemon 拉起、握手、跑多回合、发流式事件、经平台 MCP 回话、interrupt/resume、被熔断与关停，并在 web 上完成创建。这不是概念验证。

结论：**可以作为"受控开发者预览"交付**（两个实验 flag + 本机 manifest + 源码内 SDK）；**尚不具备普通用户自助接入 / GA 条件**（无公开分发、无 CLI/文档产品化、无编辑与诊断 UX、无双 flag 之外的可用性策略）。

不需要重构 daemon 核心——runtime 派发层已是 provider 中立的 driver 架构（`packages/daemon/src/agent-runtime-driver.ts`、`agent-runtime.ts` 中的 `AgentRuntimeRegistry`）。下一步工作是**开发者产品化**：发布、模板、CLI、文档、诊断与安全边界表达。

| 层级 | 结论 | 说明 |
|------|------|------|
| 运行时核心 | 已完成 | 协议双侧实现、driver/session、profile 解析、interrupt/resume、熔断、进程树终止均已落地并有测试 |
| 本地受控接入 | 已可用 | 手写 manifest + 两个实验 flag + 仓库内示例即可跑通；实机手册已存在（`docs/2026-09-21/01-bridge-runtime-实机测试手册.md`） |
| 公开 Developer Preview | 部分完成 | 链路可用但依赖源码 checkout、手工配置、内部文档；缺发布物、CLI、quickstart |
| 普通用户自助 / GA | 未就绪 | 无 PyPI 分发、无 manifest 工具、无 secret 管理 UX、无编辑 UI、无版本/弃用承诺 |

## 2. 需求定义与边界

**目标用户**：会写 Python、正在使用或愿意使用 LangChain/LangGraph 的开发者；他们已有自己的 agent 逻辑与模型密钥，想让这个 agent 作为 Slock 频道里的同事被 @、被派单、被审批。

**目标体验**：在本机装好 SDK → 写一个 entrypoint 进程 → 在本机 manifest 登记 → 在 web/服务端按探测结果创建 agent → 像 Claude agent 一样收发消息。

**关键定位**：Worker 是**用户自己的本地 Python 可执行进程**，由 daemon 按 manifest 的 `command`/`args`/`cwd` spawn；它不是 daemon 内置的框架，也不是 server 下发的代码。daemon 提供的是连接、生命周期、协议纪律和协作工具面。

### "与 Claude 类似"的能力清单

| 能力 | LangGraph worker | 普通 LangChain Runnable worker |
|------|------------------|-------------------------------|
| 接收 message / reminder / dispatch / triage / nudge（`turn.start.source.kind`） | 支持 | 支持 |
| 常驻进程多回合（persistentProcess / maxConcurrency=1） | 支持 | 支持 |
| 流式文本与进度（assistant.delta / assistant.progress） | 支持 | 支持 |
| 平台 MCP 工具与频道回复（send_message 等） | 支持 | 支持 |
| 状态上报 / 观察帧 / usage·成本记账 | 支持 | 支持 |
| 失败重试 / crash 熔断 / 停止与取消 | 支持 | 支持 |
| durable thread（进程重启后 checkpoint 续接） | 持久 checkpointer 下支持 | 不支持（不虚报，`durableThreads=false`） |
| interrupt / resume 审批门 | 支持 | 不支持（resume 一律 PROTOCOL_VIOLATION） |

后两行是框架能力差异，不是接入缺陷：`slock_runtime/langchain.py` 明确按能力声明，`slock_runtime/langgraph.py` 按 checkpointer 类型判定 `durableThreads`。

### 固定非目标

- server 不下载、不托管、不执行用户源码——entrypoint 只经本机 manifest 的**稳定 ID** 跨进程边界流动，命令/路径不出 daemon 进程。
- daemon 不管理 Python 依赖环境——venv、框架包、provider 包由用户自负；SDK 核心零依赖（`bridges/python/pyproject.toml`）。
- 不把任意 Python 代码变成安全沙箱——worker 是与 daemon 同机的用户态进程（见 §10）。
- 不强制所有框架拥有 LangGraph 的 checkpoint/interrupt 能力——能力按 handshake 声明，缺省不虚报。

## 3. 当前架构与通信链路

```text
                ┌─────────────────────────────── server ───────────────────────────────┐
                │  agents POST/PATCH 门禁   computers.entrypoints 快照   agent:start 推送 │
                └───────────────▲───────────────────────────────────│──────────────────┘
                            WS  │  ready{entrypoints:probe摘要}        │ agent:start{runtime_profile}
                                │                                    ▼
   ┌────────────────────────────────────── daemon ──────────────────────────────────────┐
   │  agent-runtime-manifest.ts   runtime-entrypoint-probe.ts   agent-runtime-profile.ts │
   │  (.slock/runtimes.json 校验/     (--slock-probe 执行,          (entrypoint/model      │
   │   revision/审计/mtime 缓存)     能力摘要→server)               校验→profile identity) │
   │                                                                                   │
   │  jsonl-bridge-runtime.ts → persistent-jsonl-worker.ts → sarp-protocol.ts            │
   │  (entrypoint→spawnSpec)      (会话状态机/终态纪律)          (SARP/1 帧编解码)          │
   │                                                                                   │
   │  agent-runtime-interrupt-store.ts   agent-runtime-crash-guard.ts   process-tree.ts  │
   └───────────────▲───────────────────────────────────────────────────│───────────────┘
                   │ stdin: initialize / turn.start / turn.cancel / shutdown            │
                   │ stdout: runtime.ready / assistant.* / tool.* / usage /             │
                   │         turn.interrupt / turn.end / runtime.stopped                │
                   ▼                                                                    ▼
   ┌── Python worker（用户进程，slock_runtime SDK）──┐        platform.mcp 描述符 ──► slock-mcp-server.cjs
   │  SarpTransport → WorkerRuntime.serve →          │        (stdio; send_message / dispatch_task / …)
   │  serve_langchain / serve_langgraph adapter      │
   │  TurnJournal (.slock/runtime-state.sqlite)      │
   └───────────────────│────────────────────────────┘
                       ▼
              provider（OpenAI/Anthropic/…；key 只经 daemon env → worker secretEnv）
```

链路要点（事实层）：

- **Manifest**：`<slockDir()>/runtimes.json`（`SLOCK_RUNTIME_MANIFEST` 可覆盖，`config.ts` 的 `runtimeManifestPath`）。`agent-runtime-manifest.ts` 的 `loadRuntimeManifest`/`validateEntry` 做 schema 校验，产出文件级与条目级 sha256 revision，revision 迁移写 `runtime-manifest-audit.jsonl`；`createRuntimeManifestLoader` 提供 mtime 缓存。
- **Probe**：`drivers/runtime-entrypoint-probe.ts` 的 `probeRuntimeEntrypoints` 对每条 entry 执行 `command args --slock-probe`，要求恰好一行 `probe.result` 帧、`runtime.id` 与 manifest 一致、`maxConcurrency=1`；产出安全摘要（id/label/status/模型名单/能力，不含 command/cwd/secret）经 `ready-payload.ts` 的 `probeBridgeEntrypoints` 随 WS `ready` 上报（daemon flag `SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES=1` 门控）。
- **initialize / ready**：`persistent-jsonl-worker.ts` 的 `PersistentJsonlWorkerSession` spawn 后写 `initialize`（含 requestId、agent、runtime{id,entrypoint,model,revision}、workspace、platform{systemPrompt,serverUrl,tokenFile,mcp}、limits）；握手校验 requestId 回显、runtime.id、maxConcurrency≤1、`requireDurableThreads`、model override 拒绝。
- **turn.start / 流事件 / turn.end**：turnId/conversationId/attempt/source/prompt/resume 下行；worker 上行 assistant.delta/message/progress、tool.start/tool.end、usage、恰好一个 turn.end（success/interrupted/cancelled/error）。
- **interrupt/resume**：worker `turn.end{status:"interrupted", interrupt:{interruptId,resumeToken,prompt}}` → dispatch 写 `agent-runtime-interrupt-store.ts`；同 conversation 下一条消息携带 `turn.start.resume`；token 单次消费，identity 变化即清。
- **MCP**：daemon 在 initialize 的 `platform.mcp` 下发 slock-mcp-server 的 stdio 描述（`agent-runtime-dispatch-headless.ts` bridge 分支 + `mcp-bundle.ts`）；worker 侧 `slock_runtime/mcp.py` 的 `SlockMcpClient` 建连、tools/list、tools/call，并对写工具自动注入幂等键 `<turnId>:<tool>:<seq>`。
- **provider key**：manifest 只声明 `secretEnv` 变量名；值从 daemon 进程 env 按名取、注入 worker 子进程，不进 manifest 明文、不进协议帧、不出 daemon。

## 4. 当前完成情况

本次实测：Python SDK 测试 `bridges/python` 下 `pytest tests -q` → **121 passed**（仓库 venv 已装 langchain 1.4.2 / langgraph 1.2.11 / langgraph-checkpoint-sqlite / pytest 9.1.1）。注意：Python 测试当前**不在 GitHub CI**（`.github/workflows/ci.yml` 只有 Node 侧 lint/typecheck、daemon vitest、web、server 四层 job）。本评估未重新运行 daemon/server/web 测试，不虚构其结果；既有覆盖以测试文件存在与覆盖面为准。

| 能力 | 状态 | 证据 | 结论 |
|------|------|------|------|
| SARP/1 规范与双侧实现 | 已完成 | `packages/daemon/src/sarp-protocol.ts`（协议权威）；`bridges/python/slock_runtime/protocol.py`（逐字段镜像）；`docs/2026-09-21/02-sarp1-protocol.md` | 可直接作为公开协议基础 |
| manifest 校验 / revision / 审计 | 已完成 | `agent-runtime-manifest.ts`：`validateEntry` 全字段校验与 `entry-*` 失败码、sha256 revision、`runtime-manifest-audit.jsonl`、`createRuntimeManifestLoader` | 本地配置层完整 |
| entrypoint probe | 已完成 | `drivers/runtime-entrypoint-probe.ts`：`--slock-probe` 执行、单帧校验、状态分类、invalidEntries 安全上抛；`ready-payload.ts` flag 门控上报 | server/web 可见性已通 |
| JSONL driver / session | 已完成 | `drivers/jsonl-bridge-runtime.ts`（spawn 前静态 fail-fast、secretEnv 注入、revision 透传）；`drivers/persistent-jsonl-worker.ts`（握手校验、回合状态机、silence 超时、优雅 stop） | 派发闭环可用 |
| LangChain adapter | 已完成 | `bridges/python/slock_runtime/langchain.py`：`serve_langchain`，astream_events 映射，不虚报能力 | 普通 Runnable 可接入 |
| LangGraph adapter | 已完成 | `bridges/python/slock_runtime/langgraph.py`：`serve_langgraph`，`checkpoint_thread_id` 命名空间隔离、`Command(resume)`、durableThreads 判定、悬空 tool_call 修复 | durable/interrupt 能力完整 |
| 平台 MCP client | 已完成 | `bridges/python/slock_runtime/mcp.py`：`SlockMcpClient`（stdio JSON-RPC、tools/list·call、写工具幂等键）；daemon 侧 `mcp/slock-mcp-server.ts` 工具面 | 回话/派单/读历史可用 |
| 幂等 / resume | 已完成 | `idempotency.py` `TurnJournal`（turn_journal + resume_tokens，0600）；runtime 层 turnId 回放与 token 单次消费；daemon `agent-runtime-interrupt-store.ts` | 平台写操作与 resume 路径已有防重；用户自定义第三方副作用仍需业务幂等或审批 |
| crash guard / 进程树 | 已完成 | `agent-runtime-crash-guard.ts`（跨消息熔断）；`process-tree.ts`（POSIX pgid / Windows taskkill /T） | 坏 entrypoint 不会烧钱循环 |
| server POST/PATCH 门禁 | 已完成 | `packages/server/src/routes/agents-public.ts`：bridge flag 门控、entrypoint 必填/禁带、绑定机 live probe 复核、model fixed/select 校验、runtime_profile 落库与合并编辑 | 服务端产品门禁已存在 |
| web 创建 runtime/entrypoint/model | 已完成 | `packages/web/src/pages/ComputerView.vue`：bridge runtime 聚合选项、entrypoint 下拉、modelMode 收敛 model；`stores/computerStore.ts` bridgeRuntimes/runtimeCatalog | 创建链路可走 UI |
| 示例 worker | 已完成 | `bridges/examples/langgraph-agent/`、`bridges/examples/langchain-agent/`：agent.py + runtime.manifest.json + README（含手动冒烟） | 可作模板蓝本 |
| 跨语言 fixtures / conformance runner | 已完成 | `bridges/fixtures/*.jsonl` 双侧校验（`test/sarp-contract-fixtures.test.ts` ↔ `tests/test_contract_fixtures.py`）；`sarp-conformance.ts` `runSarpConformance` 8 项检查 | 合规验证能力存在但未暴露 |
| SDK 分发 | 部分完成 | `bridges/python/pyproject.toml` 包名 `slock-runtime` v0.1.0、extras 齐全；但仅本地 editable/源码路径，无 PyPI、无 release CI | 没有受支持的公共安装路径 |
| 可用性开关 | 部分完成 | daemon `SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES`、server `SLOCK_BRIDGE_RUNTIMES` 双 flag 默认关 | 实验姿态明确，非产品级开关 |
| 文档 | 部分完成 | 设计文档、协议规范、实机手册、示例 README 均为内部视角；README 主文档未提 bridge | 缺外部开发者入口文档 |
| bridge agent 编辑 UX | 部分完成 | server PATCH 支持 runtime/entrypoint/model 复核修改；web `MemberProfileBody.vue` 对 bridge profile 只读（runtime 选项仅 claude） | API 先行，UI 未开 |
| 诊断 | 部分完成 | probe 状态/errorCode 上抛至 web；session stderr 环形缓冲进错误尾 | 缺 runtime doctor / 受脱敏 stderr 查看面 |
| secret 管理 | 部分完成 | `secretEnv` 只传变量名、值从 daemon env 注入 | 依赖用户自己配置 daemon 进程 env，无本地 secret store UX |
| conformance 暴露 | 部分完成 | `runSarpConformance` 是库函数，仅测试与文档引用 | 无 CLI/HTTP 入口 |
| 兼容性策略 | 部分完成 | 协议 version=1、SDK `__version__`=0.1.0 已就位 | 无对外版本支持/弃用承诺 |
| PyPI / 公开分发 / release CI | 缺失 | 无发布配置；`.github/workflows/` 无 Python job | Developer Preview 阻塞项 |
| Python CI | 缺失 | 同上；依赖 Python/venv 的 daemon 测试无 python 时 skip | 同上 |
| runtime/manifest/probe/check CLI | 缺失 | `cli.ts` 注册的 slock 子命令无 runtime 域 | 同上 |
| 公开 JSON Schema / 模板生成器 | 缺失 | manifest schema 只在 `validateEntry` 代码内 | 同上 |
| 一站式 quickstart / troubleshooting | 缺失 | 现有文档面向维护者 | 同上 |
| 本地 secret 管理 UX | 缺失 | 仅 daemon env 注入 | Beta 目标 |
| 版本支持与弃用策略 | 缺失 | 无公开承诺文档 | GA 目标 |

## 5. 现有用户接入路径及摩擦

按当前实际顺序，每一步的主要摩擦/失败模式：

1. **准备 Python 环境 + 安装 SDK**（`uv pip install -e bridges/python` 或示例的 sys.path 兜底）
   - 摩擦：必须 clone 本仓库；没有 `pip install slock-runtime`；安装说明只在 `bridges/python/README.md` 与示例 README。
2. **编写 `agent.py`（含 `--slock-probe` 分支）**
   - 摩擦：probe 模式目前要用户手工编码 `probe.result` 帧（两个示例都是手写 `encode_worker_frame`），写错即 probe 失败；无模板生成器。
   - 失败模式：probe 输出非单帧/缺字段 → `protocol_incompatible`（`probe-output-invalid` / `probe-protocol-incompatible`）。
3. **手写 manifest 条目**（`command`/`args`/`cwd` 绝对路径、`env`、`secretEnv` 名、`model.mode`、`requireDurableThreads`、三个超时）
   - 摩擦：schema 只在 `validateEntry` 代码里；无 validate CLI；失败表现为 probe `misconfigured` + errorCode，字段级报错不外发。
   - 失败模式（`validateEntry` 精确失败码）：`entry-invalid`、`entry-id-invalid`、`entry-runtime-invalid`、`entry-label-invalid`、`entry-command-invalid`、`entry-args-invalid`、`entry-cwd-invalid`、`entry-env-invalid`、`entry-secret-env-invalid`、`entry-env-overlap`、`entry-model-invalid`、`entry-timeout-invalid`、`entry-durable-invalid`、`entry-id-duplicate`。
4. **配置 daemon env（secretEnv 值）+ 开两个 flag**（daemon `SLOCK_EXPERIMENTAL_BRIDGE_RUNTIMES=1`、server `SLOCK_BRIDGE_RUNTIMES=1`）
   - 摩擦：secret 只能预先放进 daemon 进程环境；双 flag 分散在两侧，漏任一侧链路断头——server flag 关闭时创建直接 400 `runtime not wired`；daemon flag 关闭时不上报 entrypoints 且不注册 bridge driver：新建 agent 通常先在 server 被 `entrypoint_unavailable` 拦住（该机无可用 probe），已有 bridge agent 的派发才落到 `runtime-unsupported`。
   - 失败模式：`secret-env-missing`（probe 与 spawn 同规则 fail-fast）。
5. **daemon ready probe 上报 → 在 web/API 创建 agent**
   - 摩擦：创建按绑定机 live probe 复核；entrypoint 必填；model 受 `modelMode` 约束（fixed 不可改 / select 限 allowlist）。
   - 失败模式：`entrypoint_unavailable` / `entrypoint_not_ready` / `model_fixed` / `model_not_allowed`；daemon 不在线时无 probe 可复核。
6. **消息触发运行**
   - 失败模式：`runtime-start-timeout`（startupTimeoutMs 内无 ready）、`runtime-silence-timeout`、`worker-exited`、连续失败触发 `worker-crash-loop` 熔断；诊断只有错误码与 stderr 尾部，无自助排障界面。

## 6. 应对用户提供的稳定接口

对外承诺面分六层，分别标明“已有基础”或“待新增”。

### A. Python 包

- 待新增：公开分发 `pip install "slock-runtime[langgraph]"` / `"slock-runtime[langchain]"`（extras 已在 `pyproject.toml` 定义，缺的是发布与 release CI）。
- 已有基础但尚未冻结：`serve_langgraph` / `serve_langchain` / 低层 `WorkerRuntime`+`TurnOutcome`+`TurnEmit` 是候选公开 API（`slock_runtime/__init__.py` 的 `__all__` 是当前事实面，发布前仍需分层与兼容测试）。
- 待新增：高层入口自动处理 `--slock-probe`，由 `serve_*`/`WorkerRuntime` 自带 probe 分支，用户不再手写帧（当前示例在 `_probe()` 里手写 `encode_worker_frame`，应内收进 SDK 并由 adapter capabilities 自动填充）。

### B. Worker 可执行契约（公开文字约定）

- 两种模式：normal（stdin/stdout SARP/1 JSONL 全生命周期）与 probe（`--slock-probe` → 单行 `probe.result` → exit 0）。
- 纪律：stdout 只承载协议帧，日志一律 stderr；turn 终态恰好一个 `turn.end`；cancel 协作式；shutdown 后 `runtime.stopped` 并退出。
- 以上内容已在 `docs/2026-09-21/02-sarp1-protocol.md` 形成协议规范，对外文档只需引用与收窄到“用户该知道的部分”。

### C. Manifest（本机配置）

- 待新增：公开 v1 JSON Schema（从 `validateEntry` 反推并冻结）：`command`/`args`/`cwd` 只存本地值；secret 只存引用（`secretEnv` 变量名）；`model.mode` = `fixed`/`select`；超时与 `requireDurableThreads` 边界与现状一致。
- 待新增：原子写 + `slock runtime validate`（见 E）；保持现有 mtime 缓存 + revision 审计语义不变（`createRuntimeManifestLoader` / `appendManifestAudit`）。

### D. 平台 MCP

- 已有基础：`initialize.platform.mcp` 描述符 → `SlockMcpClient` 完成工具发现/调用；写工具幂等键由 SDK 管理，用户不接触。
- 待新增：对外明确工具权限与副作用边界；`send_message`/`dispatch_task` 等是**写操作**（server 侧去重兜底），文档需声明“工具能力 = agent 的频道/任务面权限”，并将标准 adapter 的 allowlist 收敛留给 P1。

### E. Conformance / 本地工具

- 待新增固定命令面：`slock runtime list|validate|probe|check`。
  - `list`：读 manifest + 最近一次 probe 状态；
  - `validate`：manifest schema/静态校验（复用 `validateEntry` 规则）；
  - `probe`：对单条 entrypoint 跑 `--slock-probe`（复用 `probeRuntimeEntrypoints`）；
  - `check`：驱动 `sarp-conformance.ts` 的 `runSarpConformance` 输出结构化报告。

### F. 版本 / 兼容

- SARP 协议版本（当前 `slock.agent-runtime` v1）与 SDK semver 解耦演进；
- LangChain/LangGraph 支持矩阵（最低版本 + 测试矩阵）写进公开文档；
- 兼容策略建议：v1 内新增可选字段保持向后兼容；破坏性变更必须升协议版本并提供弃用窗口。worker→daemon 未知帧必须 `optional:true` 的纪律已内建（`protocol.py`）。

## 7. 差距与优先级

### P0 — Developer Preview 阻塞项

| ID | 任务 | 原因 | 主要落点 | 验收 |
|----|------|------|----------|------|
| P0.1 | 发布 SDK wheel/sdist + tag release + clean venv 安装测试；发布前校准 extras 并划分 API 稳定性 | 无受支持的公共安装路径 = 无外部用户；`__all__` 目前只是事实公开面 | `bridges/python/pyproject.toml`（发布元数据；校准 extras 使 `[langchain]`/`[langgraph]` 真能安装各自模板所需的已测试依赖）、新增 release workflow、API 分层与文档 | clean venv `pip install slock-runtime[langchain]` 与 `[langgraph]` 均成功，两个最小模板的 import/probe 都通过；public API 划分 stable/advanced/internal，public 面有类型标注、API 文档与兼容测试 |
| P0.2 | SDK 自动 probe + 两个最小可复制模板 | 用户不应手写协议帧；示例即文档 | `slock_runtime` 入口内置 `--slock-probe`；`bridges/examples/`（或新 `templates/`）最小 langchain/langgraph 模板 | 模板复制改 manifest 即可跑通 probe + 单回合 |
| P0.3 | runtime manifest 公开 JSON Schema + 用户文档 | schema 目前只在代码内 | 新 schema 文件（落点见 §8-B）；docs 引用 | `slock runtime validate` 与 schema 校验一致；文档可独立读懂 manifest |
| P0.4 | `slock runtime list/validate/probe/check` | 无工具 = 接入靠猜 | `packages/daemon/src/cli/runtime.ts`（新），挂进 `cli.ts`；驱动 `probeRuntimeEntrypoints`/`runSarpConformance` | 四条子命令在真 manifest 上产出结构化结果；`check` 使用临时 workspace、不得注入 live Slock MCP 写能力、输出脱敏；若会调用真实 provider 必须明确提示/显式允许，避免无意消费或副作用 |
| P0.5 | Python CI | Python 测试当前不进 CI | 新 workflow 或扩展 `ci.yml`：以 Python 3.10 为最低基线，并覆盖声明支持的一组当前版本；Linux/Windows 跑 contract fixtures 与真实 adapter 测试，macOS 至少 smoke | CI 绿且覆盖 `bridges/python/tests` + 跨语言 fixtures |
| P0.6 | 对外 quickstart / troubleshooting / 兼容矩阵 | 缺入口文档 | `docs/` 新公开文档（或 README 增设 section），引用协议规范与实机手册 | 新用户按文档独立跑通 §5 全路径 |
| P0.7 | rollout 策略定案 | 双实验 flag 不是产品姿态 | server `bridgeRuntimesEnabled`（`lib/config.ts`）、daemon `experimentalBridgeRuntimes`（`config.ts`） | 开发预览保留双 flag；公开 beta 前改为明确产品级开关或默认开放。**不要机械把 bridge runtime 塞入 `WIRED_RUNTIME_IDS`**——binary 探测（PATH/版本）与 bridge 探测（manifest entrypoint）是两套可用性语义，应统一/澄清“可创建”判定（当前 web 已按 `kind:"bridge"` 分开处理，`computerStore.ts` runtimeCatalog），产品化时给单一、清晰的策略表述 |

### P1 — 自助 Beta

| ID | 任务 | 原因 | 主要落点 | 验收 |
|----|------|------|----------|------|
| P1.1 | 本地 secret store + manifest `secretRefs` | daemon env 注入对用户不友好、不可见 | daemon 侧新 secret 存储模块（`<slockDir()>` 下，0600，逐 entrypoint，不上传 server）；manifest 校验扩展 | `secretRefs` 引用可在 probe/spawn 解析；正常 secret 注入控制路径不向 server 或协议帧发送值 |
| P1.2 | manifest CRUD / 原子写 / 冲突校验 + entrypoint capability refresh 上报 | 手写 JSON 易错且无回滚；且现状是 mtime loader 只刷新本地 dispatch 视图，entrypoints 仅在 daemon WS ready 时上报——CRUD 后不重启则 server meta 陈旧 | `cli/runtime.ts` 扩展或 manifest manager 模块；复用 `validateEntry` + revision/审计；新增 shared WS capability-refresh 消息和 server WS handler；CRUD 后重跑 `probeRuntimeEntrypoints` 并更新 server meta（不依赖重启重发 ready） | `slock runtime add/edit/remove` 落盘即审计，非法写入被拒；CRUD 后无需重启 daemon，server 侧 entrypoint 状态经 refresh 上报刷新 |
| P1.3 | web bridge runtime/entrypoint/model 编辑 | API 已支持，UI 锁死 | `MemberProfileBody.vue` 放开 `isBridgeProfile` 分支：entrypoint/model 下拉按 live probe 约束 | bridge agent 可在 UI 改 entrypoint/model，非法组合被 server 复核拦下 |
| P1.4 | pending interrupt 待审批 UX | interrupt 目前只是协议能力，产品面待审批列表/入口缺失 | daemon pending 状态上报 + server 查询面 + web 新组件 | 频道内可看到并响应审批门 |
| P1.5 | runtime doctor / 最近 probe / 受脱敏 stderr | 排障只有 errorCode | `cli/runtime.ts` doctor 子命令 + web entrypoint 详情位；新增诊断快照，复用 `persistent-jsonl-worker.ts` stderr 环形缓冲与 `redact.ts` | 用户能看到最近 probe 结果与脱敏日志尾 |
| P1.6 | MCP tool allowlist | 目标是标准 SDK/model adapter 只看到 allowlist 内工具，降低模型误调用；任意 Python worker 仍可能绕过 SDK，故不构成权限或 OS 安全边界 | manifest 条目扩展 + SDK MCP tools/list 过滤 + server/scoped-token 授权策略 | SDK tools/list 结果与标准 adapter 暴露面受限，并有测试；真正授权仍由 scoped token/server policy 决定 |

### P2 — GA

| ID | 任务 | 原因 | 主要落点 | 验收 |
|----|------|------|----------|------|
| P2.1 | 资源限制 / 可选 OS sandbox / 安全指南 | 任意代码需要边界选项与明示 | spawn 层（`jsonl-bridge-runtime.ts`）+ 安全文档 | 可选隔离启用并有文档化威胁模型 |
| P2.2 | release provenance / 依赖审计 / 回滚 | 供应链信任 | release workflow：签名/provenance、依赖锁定、回滚指引 | 发布物可验证、可回滚 |
| P2.3 | 协议弃用与迁移 | 长期兼容承诺 | 协议规范增补弃用章节 + SDK/server 版本协商 | 弃用窗口与迁移路径文档化 |
| P2.4 | 运行指标与支持性诊断 | 可支持性 | usage/turn 指标透出（daemon→server 已有成本上报链路可复用） | 支持面能看到 worker 健康度 |
| P2.5 | provider 冒烟策略 | 真实 key 不进公共 CI | 私有 runner/手动 gate 的 provider smoke | 冒烟可跑但密钥不出私有环境 |

## 8. 建议实施批次与文件落点

### 批次 A — Developer Kit（对应 P0.1/P0.2/P0.5/P0.6）

- 产物：
  - `bridges/python/` 发布就绪：pyproject 元数据补全；`slock_runtime` 内置 `--slock-probe`（`serve_*`/`WorkerRuntime` 自动应答，`runtime-entrypoint-probe.ts` 的校验面即 probe 契约）；
  - 最小可复制模板两个（基于 `bridges/examples/langchain-agent/`、`langgraph-agent/` 收敛）；
  - 新 workflow：Python 测试（Linux/Windows 全量、macOS smoke）+ release（tag → wheel/sdist → 发布 → clean venv 安装验证）；
  - 公开 quickstart/troubleshooting/兼容矩阵文档。
- 退出条件：clean venv 安装 + 模板 + 手写 manifest 三步跑通一个回合；CI 绿。

### 批次 B — Local Runtime UX（对应 P0.3/P0.4，并接 P1.1/P1.2）

- 产物：
  - `packages/daemon/src/cli/runtime.ts`：`slock runtime list|validate|probe|check`（`check` 驱动 `runSarpConformance`），注册进 `packages/daemon/src/cli.ts`；
  - manifest schema 公开文件（如 `packages/daemon/schemas/runtime-manifest.schema.json` 或 `packages/shared/` 下，供 CLI/文档/未来 web 复用）+ manifest manager（CRUD、原子写、冲突校验，复用 `agent-runtime-manifest.ts` 的校验与审计）；
  - entrypoint capability refresh 上报：manifest CRUD 后重跑 `probeRuntimeEntrypoints` 并经 WS 更新 server 侧 meta——选定此方案而非"重启 daemon 重发 ready"（现状缺口：mtime loader 只刷新本地 dispatch 视图，entrypoints 仅在 ready 时上报一次）；
  - secret store（`<slockDir()>` 内 0600，`secretEnv`/`secretRefs` 解析仍走 `resolveSpawnSpec` 注入路径）。
- 退出条件：不写 JSON、不重启 daemon，即可完成 entrypoint 登记→validate→probe→check→list 全流程，且 CRUD 后重新 probe 的结果经 refresh 上报刷新 server meta。

### 批次 C — Product UX（对应 P1.3/P1.4/P1.5/P1.6）

- 产物：
  - web：`MemberProfileBody.vue` bridge 编辑分支、`ComputerView.vue` entrypoint 详情/doctor 位、pending interrupt 审批面；
  - server：agents PATCH 编辑路径已有复核（`agents-public.ts`），补 pending interrupt 透出与 entrypoint readiness/缺失错误码展示；server 不接收 secret ref 名与值——secretRefs 和 secret 值始终留在 daemon 本机；
  - daemon：doctor 数据来源（最近 probe 快照、脱敏 stderr 尾）。
- 退出条件：bridge agent 的创建、编辑、审批、排障全部可在产品界面完成。

### 批次 D — GA hardening（对应 P2 全部）

- 产物：可选隔离与资源限制、发布供应链（签名/provenance/审计/回滚）、协议弃用机制、运行指标、provider 私有冒烟、对外安全指南与支持手册。
- 退出条件：§11 GA 勾选项全过。

## 9. 验证矩阵

| 验证面 | 当前覆盖 | 需新增 |
|--------|----------|--------|
| Python unit | `bridges/python/tests` 9 文件 121 用例（本地实测通过；不进 CI） | CI job；发布的 wheel 在 clean venv 安装后跑 smoke |
| 跨语言 contract fixtures | `bridges/fixtures/*.jsonl`：daemon 侧 `test/sarp-contract-fixtures.test.ts` ↔ Python 侧 `tests/test_contract_fixtures.py` | 纳入 Python CI；fixture 再生成流程文档化 |
| daemon bridge/session | `persistent-jsonl-worker.test.ts`、`jsonl-bridge-runtime.test.ts`、`sarp-bridge-integration.test.ts`（mjs fixture 真进程）、`sarp-python-worker.test.ts`（真 SDK，无 python 时 skip）、`sarp-langgraph-e2e.test.ts`（真 LangGraph+sqlite，缺 venv 时 skip） | CI 中提供 python/venv 使 skip 测试实跑；`slock runtime check` CLI 测试 |
| server 门禁 | `test/agents-bridge.test.ts`（fake daemon WS + entrypoints 的 POST/PATCH 矩阵）、`config.test.ts` flag 解析 | secretRefs/编辑路径用例 |
| web 创建/编辑 | `stores/computerStore.test.ts`（flag/entrypoints/catalog） | 创建表单 entrypoint/model 收敛组件测试；bridge 编辑 UI 测试（P1.3 后） |
| 3 OS smoke | 无 | Linux/Windows/macOS 安装+probe smoke |
| provider 冒烟 | 无（示例有 demo fallback 可零密钥跑通管道） | 私有环境真实 provider 冒烟（P2.5） |
| 安全泄漏 | daemon 侧 env 白名单/manifest env 拒绝凭据名/secretEnv 不外发已有测试（`agent-env-whitelist.test.ts`、`agent-runtime-manifest.test.ts`、`runtime-entrypoint-probe.test.ts`） | 显式 leak 测试：stdout 帧/审计/probe 摘要/manifest 文件中不出现 secret 值的断言 |

## 10. 安全与信任模型

- **worker 是本机管理员信任的任意代码**：它在用户机器上以 daemon 子进程身份运行，拥有该用户的本地权限。Claude 的 `--allowedTools` 不适用于任意 Python worker；scoped token、env 白名单、标准 SDK 的 MCP allowlist 只能收窄平台接口面，**不构成 OS 沙箱**，也挡不住受信任 worker 自行访问本机文件或网络——文档必须明说，不暗示隔离。
- **正常控制面不会主动上送 command/cwd/provider secret 值**：跨进程边界只流稳定 entrypoint ID 与 probe 安全摘要（`probeRuntimeEntrypoints` 只外发 id/label/status/模型名单/能力；`agents-public.ts`/`computers.ts` 只转发摘要）。但该承诺针对控制面行为：若 worker 主动把 secret 写进 assistant/tool 输出，平台无法从信任模型上保证永不泄漏——因此要有出口脱敏与泄漏测试，但不能把脱敏当绝对保证。
- **stdout 既载协议也载模型输出**：帧内容可能含模型生成文本与工具输出——上限截断（1MiB 帧、tool output 截断）是既有纪律；出口脱敏（`redact.ts`）目前用于 observation、terminal log、stderr/错误等出口，不能暗示任意 finalText 都必然被完整脱敏——"统一覆盖所有用户可见出口"的验证列为需补测试/加固。对外文档需声明"模型输出视为不可信内容"。
- **第三方副作用需业务幂等或审批**：写工具幂等键（`<turnId>:<tool>:<seq>`）+ server 去重 + LangGraph interrupt 审批门是三层既有手段；用户自定义工具的副作用不在平台担保范围内。
- **secret 生命周期**：manifest 只存变量名（`secretEnv`），值从 daemon env 注入 worker；P1 的本地 secret store 必须保持"逐 entrypoint、0600、不上传 server"的等价纪律。

## 11. 发布门槛 / Definition of Done

### Developer Preview（P0 全完成为门槛）

- [ ] `pip install "slock-runtime[langgraph]"` / `[langchain]` 在 clean venv 成功；`--slock-probe` 由 SDK 自动应答
- [ ] 两个最小模板可复制即用；公开 manifest JSON Schema + `slock runtime list|validate|probe|check` 可用
- [ ] Python CI 在 Linux/Windows 全量、macOS smoke 绿
- [ ] 对外 quickstart + troubleshooting + 兼容矩阵发布；双 flag 预览姿态与"非托管"表述写入文档
- [ ] P0.7 的可用性策略表述定案（不把 bridge 机械塞进 `WIRED_RUNTIME_IDS`）

### Public Beta（另需）

- [ ] P1 中 secret store + `secretRefs`、manifest CRUD、web 编辑、runtime doctor、pending interrupt UX 全部落地
- [ ] 新用户不读内部设计文档即可完成接入；常见失败有对应排障入口

### GA（另需）

- [ ] 三平台（Linux/Windows/macOS）验证通过；发布供应链（provenance/审计/回滚）就位
- [ ] 协议弃用与迁移策略公开；运行指标与支持性诊断可供一线排障
- [ ] 安全指南发布（worker 信任模型、非沙箱声明、provider key 纪律）

## 12. 最终建议

1. **第一优先做 P0，不再扩 daemon runtime 核心。** 派发层的 provider 中立 driver 架构、manifest/probe/session/interrupt/熔断链路已是完成态；缺口集中在安装、配置、诊断、发布与安全边界表达。
2. **推荐产品表述**："在你的电脑上运行自有 Python Agent；Slock daemon 负责连接、生命周期和协作工具，不托管你的代码与模型密钥。"——与 §10 的实现事实一致。
3. **现有实现是功能闭环而非概念验证**：端到端链路、协议规范、双侧测试与实机手册俱在；Developer Preview 的工作是把"维护者能跑"变成"外部开发者能自助跑通"。

---

**主要证据文件**：`bridges/python/pyproject.toml`、`bridges/python/slock_runtime/__init__.py`、`slock_runtime/{runtime,protocol,transport,langchain,langgraph,mcp,idempotency,errors}.py`、`bridges/examples/{langchain-agent,langgraph-agent}/`、`bridges/fixtures/*.jsonl`、`packages/daemon/src/agent-runtime-manifest.ts`、`drivers/runtime-entrypoint-probe.ts`、`drivers/jsonl-bridge-runtime.ts`、`drivers/persistent-jsonl-worker.ts`、`agent-runtime-profile.ts`、`agent-runtime-interrupt-store.ts`、`agent-runtime-crash-guard.ts`、`sarp-protocol.ts`、`sarp-conformance.ts`、`ready-payload.ts`、`config.ts`、`cli.ts`、`mcp/slock-mcp-server.ts`、`packages/shared/src/index.ts`、`packages/server/src/routes/agents-public.ts`、`routes/computers.ts`、`ws/handler.ts`、`lib/runtime-probe.ts`、`db/migrations/032_computers_entrypoints.sql`、`packages/web/src/pages/ComputerView.vue`、`components/people/MemberProfileBody.vue`、`stores/computerStore.ts`、`docs/2026-09-21/02-sarp1-protocol.md`、`docs/2026-09-21/01-bridge-runtime-实机测试手册.md`、`docs/2026-09-20/02-daemon-langchain-langgraph-runtime-design.md`。
