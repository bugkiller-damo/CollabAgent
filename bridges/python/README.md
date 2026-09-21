# slock_runtime — SARP/1 Python Worker SDK

Slock agent-runtime bridge 的 Python SDK。daemon 把你的 worker 当成本地
子进程拉起，经 stdin/stdout 逐行 JSON（SARP/1，`slock.agent-runtime` v1）
下发回合；本包兜住握手、帧编解码、序号纪律、回合状态机、turnId 幂等、
interrupt/resume 与 usage/错误映射——你只需要给出一个 LangChain agent
或 LangGraph `CompiledStateGraph`。

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

## 纪律

- stdout 只属于协议帧；日志一律 stderr。
- provider key / scoped token / 完整 prompt / 图内部状态不进协议帧和幂等库。
- 幂等状态默认 `<workspace>/.slock/runtime-state.sqlite`（0600）。
- LangGraph 线程隔离由 `conversation_id → configurable.thread_id` 驱动；
  checkpoint 推荐放 `<workspace>/.slock/` 下的独立 sqlite 文件。

## 开发

```bash
uv venv .venv && uv pip install --python .venv/Scripts/python.exe -e ".[dev]"
.venv/Scripts/python.exe -m pytest tests
```

示例见 `bridges/examples/langgraph-agent/` 与 `bridges/examples/langchain-agent/`。
协议权威定义：`packages/daemon/src/sarp-protocol.ts` +
`docs/2026-09-20/02-daemon-langchain-langgraph-runtime-design.md` §8。
