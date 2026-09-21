# slock_runtime — SARP/1 Python Worker SDK

Slock agent-runtime bridge 的 Python SDK。daemon 把你的 worker 当成本地
子进程拉起，经 stdin/stdout 逐行 JSON（SARP/1，`slock.agent-runtime` v1）
下发回合；本包兜住握手、帧编解码、序号纪律、回合状态机、turnId 幂等、
interrupt/resume 与 usage/错误映射——你只需要给出一个 LangChain agent
或 LangGraph `CompiledStateGraph`。

## 安装

支持 Python 3.10–3.13。**首个 release 发布后**可用 PyPI 安装：

```bash
pip install "slock-runtime[langgraph]"   # LangGraph worker（含 checkpoint-sqlite）
pip install "slock-runtime[langchain]"   # LangChain worker
pip install slock-runtime                # 仅裸协议层（自定义 runtime）
```

发布前的当前受支持路径是源码 / 本地 wheel：

```bash
pip install -e "bridges/python[langgraph]"          # 仓库内 editable
pip install "slock_runtime-0.1.0-py3-none-any.whl[langgraph]"   # 本地 wheel
```

从零开始的完整接入（manifest、daemon/server flag、secret 配置、故障速查）
见公开 quickstart：`docs/2026-09-21/04-python-agent-quickstart.md`；
可复制模板见 `bridges/templates/langchain-agent/` 与
`bridges/templates/langgraph-agent/`。

## 平台支持

| 平台 | Python | 状态 |
|------|--------|------|
| Windows 11 x64 | 3.10.21 / 3.12.14 / 3.13.15 | 本地已验证（pytest 134/134、模板 probe+单回合、daemon SARP 测试 5/5） |
| Windows Server 2022 x64 | 3.10–3.13 | CI 已配置（windows-2022 矩阵 + daemon-bridge 集成），远端待首跑 |
| Ubuntu 22.04 / 24.04 x64 | 3.10–3.13 | CI 已配置（ubuntu-22.04/24.04 矩阵 + daemon-bridge 集成），远端待首跑；Linux x86_64 cp310/cp311/cp313 全部依赖已本地证明有 binary wheel（43 个 wheel、0 sdist，无需编译） |
| CentOS Stream 9 x64 | AppStream Python 3.11 + Node 20 | CI 已配置（`centos-stream-9` 容器 job），远端待首跑 |
| CentOS Linux 7 | — | 不支持（EOL 2024-06-30，无受支持的 Python ≥3.10 基线） |
| macOS | 3.12 | best-effort 冒烟（CI 单 leg），非主要内部目标 |

## 用法

```python
# LangGraph（durable threads + interrupt/resume）
from slock_runtime import serve_langgraph
raise SystemExit(serve_langgraph(graph_or_factory))

# LangChain
from slock_runtime import serve_langchain
raise SystemExit(serve_langchain(agent_or_factory))

# 裸协议（自定义 runtime）
from slock_runtime import WorkerRuntime, TurnOutcome
rt = WorkerRuntime(runtime_id="my-runtime")
sys.exit(rt.serve(run_turn, on_initialize))
```

`graph_or_factory` 可以是编译好的图，或 `factory(init, mcp_tools) -> graph`——
推荐 factory 形态：SDK 保证 `initialize` → MCP 连接 → 建图 → `runtime.ready`
的顺序，systemPrompt/model override 都能在建图时生效。

## 自动 probe

`--slock-probe` 由 `WorkerRuntime.serve` 内置处理：进程打印**单行**
`probe.result` 帧（`probe:true` + `runtime.id` + `runtime.frameworkVersion`
+ `runtime.bridgeVersion` + `capabilities` + `model`）后 `exit(0)`——
在读 stdin、开 journal、调 `on_initialize`、建 graph/model、起 MCP **之前**
返回。worker 源码不需要、也不应该自写 probe 分支；adapter 已静态上报各自的
固有能力面（握手期 `on_initialize` 的 overrides 仍是权威）。

## API 稳定性

- **stable**（语义化版本内保持向后兼容）：`serve_langchain`、`serve_langgraph`、
  `SARP_PROTOCOL`、`SARP_VERSION`、`__version__`。
- **advanced**（自建 runtime 可用，签名仍可能演进）：`serve`、`WorkerRuntime`、
  `TurnOutcome`、`TurnEmit`、`TurnJournal`、`InterruptRecord`、`SarpTransport`、
  协议 dataclass 与错误类型。
- **internal**：其余子模块与内部 helper——未列入 `__all__` 即不受兼容承诺。

## 纪律

- stdout 只属于协议帧；日志一律 stderr。
- provider key / scoped token / 完整 prompt / 图内部状态不进协议帧和幂等库。
- 幂等状态默认 `<workspace>/.slock/runtime-state.sqlite`（0600）。
- LangGraph 线程隔离由 `conversation_id → configurable.thread_id` 驱动；
  checkpoint 推荐放 `<workspace>/.slock/` 下的独立 sqlite 文件。

## 开发

```bash
# 必须装全部 extras——否则真实 adapter 测试会静默 skip
uv venv .venv && uv pip install --python .venv/Scripts/python.exe -e ".[langchain,langgraph,dev]"
# 或：python -m venv .venv && .venv/Scripts/python.exe -m pip install -e ".[langchain,langgraph,dev]"
.venv/Scripts/python.exe -m pytest tests -q
.venv/Scripts/python.exe -m ruff check slock_runtime tests
.venv/Scripts/python.exe -m mypy slock_runtime
```

## 维护者：首次发布

发布走 `.github/workflows/python-release.yml`（`slock-runtime-v*` tag 触发，
trusted publishing，无 API token）。**打 tag 前必须完成两项外部配置**：

1. PyPI 项目页配置 trusted publisher：owner `bugkiller-damo`、repo
   `CollabAgent`、workflow `python-release.yml`、environment `pypi`；
2. GitHub 仓库创建 `pypi` environment（可按需加 required reviewers）。

tag 格式：`slock-runtime-v<与 slock_runtime._version.__version__ 完全一致的版本>`
（workflow 会做对账，不一致即失败）。

示例见 `bridges/examples/langgraph-agent/` 与 `bridges/examples/langchain-agent/`。
协议权威定义：`packages/daemon/src/sarp-protocol.ts` +
`docs/2026-09-21/02-sarp1-protocol.md`。
