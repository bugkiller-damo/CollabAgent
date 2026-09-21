"""LangChain adapter：把一个 LangChain Runnable / agent 挂上 SARP/1 worker runtime。

职责（§12.2）：
1. initialize 握手：先起 Slock MCP client 并把 tools 转成 StructuredTool，
   再调用户工厂 build(init, tools)（§12.4 顺序：tools 必须先于 graph 构建）。
2. turn.prompt → HumanMessage；platform system prompt 按 system_prompt_mode
   注入为最高优先级 SystemMessage（"prepend"）或完全不注入（"none"）。
3. 用 astream_events(v2) 稳定流接口取事件：
   on_chat_model_stream → assistant.delta；on_tool_start/end/error →
   tool.start / tool.end（provider="langchain"）。
4. finalText 取自最终结果的最后一条 message；usage 取自最终 AIMessage 的
   usage_metadata（snake→camel）；costUsd 只由 cost_calculator 给出。
5. resume 不支持（普通 Runnable 无 checkpoint）→ PROTOCOL_VIOLATION 终态；
   durableThreads/interrupts 不虚报（§12.2 末段）。

纪律：
- langchain / langchain_core 一律函数内惰性 import——`import slock_runtime`
  在零框架依赖环境下必须可用。
- 回合在 daemon 线程里跑，asyncio.run 自带私有 loop；cancel 经
  threading.Event 协作传递，每个事件查一次。
- 秘密（token/env）不进任何帧；stdout 只走协议帧。
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable
from typing import Any

from .errors import GRAPH_INPUT_INVALID, PROTOCOL_VIOLATION, SarpError
from .mcp import SlockMcpClient
from .protocol import SarpInitialize, SarpTurnStart
from .runtime import TurnEmit, TurnOutcome, WorkerRuntime

# tool.end output / error 截断上限（§8.5 输出字段控制帧尺寸；§17.1 大帧纪律）
_TOOL_OUTPUT_MAX = 4000
_TOOL_ERROR_MAX = 500

InputMapper = Callable[[SarpInitialize, SarpTurnStart], Any]
OutputMapper = Callable[[Any], str | None]
UsageExtractor = Callable[[Any], dict | None]
CostCalculator = Callable[[dict], float | None]


def serve_langchain(
    agent_or_factory: Any,
    *,
    input_mapper: InputMapper | None = None,
    output_mapper: OutputMapper | None = None,
    usage_extractor: UsageExtractor | None = None,
    cost_calculator: CostCalculator | None = None,
    system_prompt_mode: str = "prepend",
    streaming: bool = True,
    runtime_id: str = "langchain",
    framework_version: str | None = None,
    transport: Any = None,
    journal: Any = None,
    load_mcp_tools: bool = True,
) -> int:
    """LangChain runtime 入口。阻塞至 shutdown，返回进程退出码。

    agent_or_factory：现成的 Runnable，或工厂 ``fn(init, tools) -> Runnable``
    ——工厂在 initialize 之后、Slock MCP tools 就绪之后调用（§12.4）。
    """
    if system_prompt_mode not in ("prepend", "none"):
        raise ValueError(f"system_prompt_mode must be 'prepend' or 'none', got {system_prompt_mode!r}")
    if framework_version is None:
        framework_version = _detect_framework_version()

    # on_initialize 在 runtime.serve 内部跑；client/agent 经 holder 带出，
    # serve 返回后在 finally 里关 MCP 子进程（§12.4：退出时关闭 client）。
    holder: dict[str, Any] = {"mcp_client": None, "agent": None}

    def _on_initialize(init: SarpInitialize, emit: TurnEmit) -> dict:
        tools: list = []
        if init.mcp is not None and load_mcp_tools:
            client = SlockMcpClient(init.mcp)
            client.start()  # 失败抛 SarpError(MCP_START_FAILED) → runtime.error
            holder["mcp_client"] = client
            tools = _load_langchain_tools(client)
        agent = agent_or_factory(init, tools) if callable(agent_or_factory) else agent_or_factory
        holder["agent"] = agent
        return {
            "capabilities": {
                "persistentProcess": True,
                "maxConcurrency": 1,
                "streamingText": streaming,
                "toolEvents": True,
                "interrupts": False,
                "durableThreads": False,
                "mcp": bool(init.mcp),
                "usage": "tokens",
            },
            "model": {"selected": init.model} if init.model else {},
        }

    def _run_turn(init: SarpInitialize, turn: SarpTurnStart, emit: TurnEmit, cancelled) -> TurnOutcome:
        client = holder["mcp_client"]
        if client is not None:
            client.set_active_turn(turn.turn_id)  # §15.4：写工具幂等键锚定 turnId
        return _run_one_turn(
            holder["agent"],
            init,
            turn,
            emit,
            cancelled,
            input_mapper=input_mapper,
            output_mapper=output_mapper,
            usage_extractor=usage_extractor,
            cost_calculator=cost_calculator,
            system_prompt_mode=system_prompt_mode,
            streaming=streaming,
        )

    runtime = WorkerRuntime(
        runtime_id=runtime_id,
        framework_version=framework_version,
        capabilities={
            # probe 期无 initialize——静态报本 adapter 的固有面；
            # 握手期 on_initialize overrides 仍是权威（§12.2）
            "streamingText": streaming,
            "toolEvents": True,
            "durableThreads": False,
            "interrupts": False,
            "mcp": bool(load_mcp_tools),
            "usage": "tokens",
        },
        probe_model={"overrides": True},
        transport=transport,
        journal=journal,
    )
    try:
        return runtime.serve(_run_turn, _on_initialize)
    finally:
        client = holder["mcp_client"]
        if client is not None:
            with contextlib.suppress(Exception):
                client.close()


# ---------------------------------------------------------------------------
# 单回合
# ---------------------------------------------------------------------------


def _run_one_turn(
    agent: Any,
    init: SarpInitialize,
    turn: SarpTurnStart,
    emit: TurnEmit,
    cancelled,
    *,
    input_mapper: InputMapper | None,
    output_mapper: OutputMapper | None,
    usage_extractor: UsageExtractor | None,
    cost_calculator: CostCalculator | None,
    system_prompt_mode: str,
    streaming: bool,
) -> TurnOutcome:
    # langchain runtime 无 checkpoint，resume 一律拒绝（runtime 落成 error turn.end）
    if turn.resume is not None:
        raise SarpError(PROTOCOL_VIOLATION, "resume unsupported on langchain runtime", retryable=False)
    if agent is None:
        raise SarpError(PROTOCOL_VIOLATION, "langchain agent not initialized", retryable=False)

    input_value = _map_input(init, turn, input_mapper, system_prompt_mode)

    streamed: list[str] = []
    result: Any = None
    stream_usage_meta: Any = None

    if streaming and hasattr(agent, "astream_events"):
        result, stream_usage_meta = _stream_events(agent, input_value, emit, cancelled, streamed)
    elif hasattr(agent, "ainvoke"):
        result = asyncio.run(agent.ainvoke(input_value))
    elif hasattr(agent, "invoke"):
        result = agent.invoke(input_value)
    else:
        raise SarpError(
            PROTOCOL_VIOLATION,
            "agent is not runnable: needs astream_events/ainvoke/invoke",
            retryable=False,
        )
    if cancelled.is_set():
        return TurnOutcome(status="cancelled")

    final_text = _final_text(result, output_mapper)
    if not final_text and streamed:
        final_text = "".join(streamed)  # 结果取不到时回落到已流出的文本

    usage = _usage(result, usage_extractor, stream_usage_meta)
    if usage:
        usage = dict(usage)
        # §12.2：costUsd 只能由 cost_calculator 给出——extractor/provider
        # 自带值一律剥掉，避免虚报成本
        usage.pop("costUsd", None)
        if cost_calculator is not None:
            cost = cost_calculator(usage)
            if cost is not None:
                usage["costUsd"] = float(cost)

    return TurnOutcome(status="success", final_text=final_text, usage=usage)


def _stream_events(agent: Any, input_value: Any, emit: TurnEmit, cancelled, streamed: list):
    """asyncio.run 在 handler 线程里跑私有 loop；逐事件查 cancel。"""

    async def _consume():
        result: Any = None
        usage_meta: Any = None
        async for event in agent.astream_events(input_value, version="v2"):
            if cancelled.is_set():
                return result, usage_meta
            if not isinstance(event, dict):
                continue
            etype = event.get("event") or ""
            data = event.get("data")
            if not isinstance(data, dict):
                data = {}
            if etype == "on_chat_model_stream":
                chunk = data.get("chunk")
                text = _content_to_text(getattr(chunk, "content", chunk))
                if text:
                    emit.delta(text)
                    streamed.append(text)
                um = getattr(chunk, "usage_metadata", None)
                if um:
                    usage_meta = um
            elif etype == "on_tool_start":
                emit.tool_start(
                    call_id=str(event.get("run_id", "")),
                    name=str(event.get("name") or "tool"),
                    provider="langchain",
                    input=data.get("input"),
                )
            elif etype == "on_tool_end":
                out = data.get("output")
                emit.tool_end(
                    call_id=str(event.get("run_id", "")),
                    ok=True,
                    name=str(event.get("name") or "tool"),
                    provider="langchain",
                    output=_truncate(_content_to_text(getattr(out, "content", out)), _TOOL_OUTPUT_MAX),
                )
            elif etype == "on_tool_error":
                emit.tool_end(
                    call_id=str(event.get("run_id", "")),
                    ok=False,
                    name=str(event.get("name") or "tool"),
                    provider="langchain",
                    error=_truncate(str(data.get("error")), _TOOL_ERROR_MAX),
                )
            elif etype == "on_chat_model_end":
                um = getattr(data.get("output"), "usage_metadata", None)
                if um:
                    usage_meta = um
            # 最后一个带 output 的 *_end 即最外层 runnable 的终值
            if etype.endswith("_end") and "output" in data:
                result = data.get("output")
        return result, usage_meta

    return asyncio.run(_consume())


# ---------------------------------------------------------------------------
# 输入 / 输出 / usage 映射
# ---------------------------------------------------------------------------


def _map_input(
    init: SarpInitialize,
    turn: SarpTurnStart,
    input_mapper: InputMapper | None,
    system_prompt_mode: str,
) -> Any:
    if input_mapper is None:
        return _default_input(init, turn, system_prompt_mode)
    try:
        return input_mapper(init, turn)
    except SarpError:
        raise
    except Exception as e:
        raise SarpError(GRAPH_INPUT_INVALID, f"input_mapper failed: {e}", retryable=False) from e


def _default_input(init: SarpInitialize, turn: SarpTurnStart, system_prompt_mode: str) -> dict:
    """默认 {"messages": [...]}：platform prompt 作为最高优先级 SystemMessage
    前置（§12.2.2）；mode="none" 时完全不注入。"""
    from langchain_core.messages import HumanMessage, SystemMessage

    messages: list = []
    if system_prompt_mode == "prepend" and init.system_prompt:
        messages.append(SystemMessage(content=init.system_prompt))
    messages.append(HumanMessage(content=turn.prompt))
    return {"messages": messages}


def _final_text(result: Any, output_mapper: OutputMapper | None) -> str | None:
    if output_mapper is not None:
        return _content_to_text(output_mapper(result))
    if result is None:
        return None
    if isinstance(result, dict) and result.get("messages"):
        last = result["messages"][-1]
        return _content_to_text(getattr(last, "content", last))
    content = getattr(result, "content", None)
    if content is not None:
        return _content_to_text(content)
    return str(result)


def _usage(
    result: Any,
    usage_extractor: UsageExtractor | None,
    stream_usage_meta: Any,
) -> dict | None:
    usage: dict | None = (
        usage_extractor(result) if usage_extractor is not None else _default_usage(result)
    )
    if usage is None:
        usage = _usage_from_metadata(stream_usage_meta)
    return usage or None


def _default_usage(result: Any) -> dict | None:
    """默认取最终 message 的 usage_metadata（§12.2.8）。"""
    msg: Any = None
    if isinstance(result, dict) and result.get("messages"):
        msg = result["messages"][-1]
    elif result is not None and hasattr(result, "usage_metadata"):
        msg = result
    if msg is None:
        return None
    return _usage_from_metadata(getattr(msg, "usage_metadata", None))


def _usage_from_metadata(meta: Any) -> dict | None:
    """{input_tokens, output_tokens, total_tokens, model?} → camelCase。"""
    if not meta:
        return None
    getter = meta.get if isinstance(meta, dict) else lambda k, d=None: getattr(meta, k, d)
    usage: dict[str, Any] = {}
    for src, dst in (
        ("input_tokens", "inputTokens"),
        ("output_tokens", "outputTokens"),
        ("total_tokens", "totalTokens"),
    ):
        v = getter(src)
        if isinstance(v, bool):
            v = None
        if isinstance(v, (int, float)):
            usage[dst] = int(v)
    model = getter("model")
    if isinstance(model, str) and model:
        usage["model"] = model
    return usage or None


def _content_to_text(content: Any) -> str:
    """str | [{"type":"text","text":...}] block list | 任意对象 → 文本。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and (block.get("type") == "text" or "text" in block):
                parts.append(str(block.get("text", "")))
        return "".join(parts)
    return str(content)


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit]


# ---------------------------------------------------------------------------
# MCP tools → LangChain tools
# ---------------------------------------------------------------------------


def _load_langchain_tools(client: SlockMcpClient) -> list:
    """McpToolInfo → StructuredTool；所有 tool 复用同一个 client（§12.4）。"""
    from langchain_core.tools import StructuredTool

    tools = []
    for info in client.list_tools():

        def _bind(name: str):  # 闭包固化 tool 名，避免 late-binding
            def _call(**kwargs):
                return client.call_tool(name, kwargs)

            return _call

        tools.append(
            StructuredTool(
                name=info.name,
                description=info.description or info.name,
                args_schema=info.input_schema or {"type": "object", "properties": {}},
                func=_bind(info.name),
            )
        )
    return tools


def _detect_framework_version() -> str | None:
    """惰性探测 langchain-core 版本——走 importlib.metadata，不 import 框架
    （probe 环境可能没有框架依赖）；缺依赖时返回 None，不进帧。"""
    import importlib.metadata

    try:
        return f"langchain-core {importlib.metadata.version('langchain-core')}"
    except Exception:
        return None
