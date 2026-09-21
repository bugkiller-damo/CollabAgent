"""LangGraph adapter：把 CompiledStateGraph 桥进 SARP/1 worker 生命周期。

职责（§12.3）：
- conversationId → configurable.thread_id（§11.2），slock_turn_id 进
  configurable 做幂等审计，不替代 thread ID；
- input_mapper 把 Slock turn 转为 graph 输入；默认 {"messages":[HumanMessage]}，
  init.system_prompt 存在且 thread 为空（get_state().values 为空）时前置
  SystemMessage（§12.5）；
- stream_mode=["messages","updates","custom"] 三路事件：
  messages → assistant.delta（仅 ai 类 chunk；ToolMessage 不进文本流）；
  updates → tool.start/tool.end（AIMessage.tool_calls / ToolMessage）与
  __interrupt__ 检测；custom → 仅 custom_event_mapper 显式放行的
  progress（§12.3.4，不把私有事件透出）；
- interrupt() → InterruptRecord + TurnOutcome(interrupted)；resume token
  签发/单次消费由 runtime journal 兜底（§11.4），adapter 不碰；
- turn.resume → Command(resume=value) 走原 checkpoint 恢复；
- graph.checkpointer 决定 durableThreads：InMemorySaver/MemorySaver/None
  → false，其余（SqliteSaver/Postgres…）→ true（§11.3）。

纪律：
- 模块零框架依赖——所有 langgraph/langchain 导入都在函数体内惰性进行，
  `import slock_runtime` 在未装框架时也必须可用；
- 不完整 graph state / checkpoint blob / secret 永远不进协议帧；
  tool output 截断 ~4000 字符；stdout 只写协议帧。
"""

from __future__ import annotations

import json
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .errors import GRAPH_INPUT_INVALID, INTERRUPT_NOT_FOUND, RUNTIME_ID_MISMATCH, SarpError
from .mcp import SlockMcpClient
from .protocol import SarpInitialize, SarpTurnStart
from .runtime import InterruptRecord, TurnEmit, TurnOutcome, WorkerRuntime, new_resume_token

TOOL_OUTPUT_MAX_CHARS = 4000  # §20.5：超大 tool output 截断
_STREAM_MODES = ["messages", "updates", "custom"]
# 进程内 checkpointer 类名——命中即 durableThreads=False（§11.3）
_VOLATILE_CHECKPOINTERS = ("InMemorySaver", "MemorySaver")


@dataclass(frozen=True)
class SlockTool:
    """Slock MCP 工具的运行时视图（§12.4）。

    graph 工厂拿到的是「可调用的工具描述」而非裸 McpToolInfo——invoke()
    经 worker 内唯一 SlockMcpClient 发出 tools/call；input_schema 为
    MCP JSON Schema，可直接喂给 StructuredTool.from_function(args_schema=)。
    """

    name: str
    description: str
    input_schema: dict
    call: Callable[[dict], str]

    def invoke(self, arguments: dict | None = None) -> str:
        return self.call(dict(arguments or {}))


# ---------------------------------------------------------------------------
# 默认 mapper
# ---------------------------------------------------------------------------


def _flatten_content(content: Any) -> str:
    """message.content → 纯文本。str 直返；list-of-blocks 拼 text 块。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                if block.get("type") in (None, "text"):
                    t = block.get("text")
                    if isinstance(t, str):
                        parts.append(t)
            else:
                t = getattr(block, "text", None)
                if isinstance(t, str):
                    parts.append(t)
        return "".join(parts)
    return str(content)


def checkpoint_thread_id(init: SarpInitialize, conversation_id: str) -> str:
    """Phase 5 §11.2：thread_id 按 runtime 身份命名空间隔离。

    runtime/entrypoint/model/manifest revision 任一分量变化 → 新命名空间 →
    不复用旧 checkpoint thread。身份不变时 conversation_id 保住会话连续性。
    前缀分量做分隔符清洗，保证结果仍是合法 thread_id 且不会跨命名空间碰撞。
    """
    parts = [
        init.runtime_id,
        init.entrypoint,
        init.revision or "-",
        init.model or "-",
        conversation_id,
    ]
    cleaned = ["".join(c if (c.isalnum() or c in "._-") else "_" for c in p) for p in parts]
    return ":".join(cleaned)


def _default_input_mapper(init: SarpInitialize, turn: SarpTurnStart, fresh: bool) -> dict:
    """§12.3.2：HumanMessage(turn.prompt)；thread 全新且有平台 prompt 时前置 SystemMessage。"""
    from langchain_core.messages import HumanMessage, SystemMessage  # 惰性导入

    msgs: list = []
    if init.system_prompt and fresh:
        msgs.append(SystemMessage(content=init.system_prompt))
    msgs.append(HumanMessage(content=turn.prompt))
    return {"messages": msgs}


def _default_output_mapper(values: Any) -> str:
    """终态 state.values → finalText：取最后一条 message 的 content 拍平。"""
    if not isinstance(values, dict):
        return ""
    msgs = values.get("messages")
    if isinstance(msgs, (list, tuple)) and msgs:
        return _flatten_content(getattr(msgs[-1], "content", msgs[-1]))
    return ""


def _truncate(text: Any, limit: int = TOOL_OUTPUT_MAX_CHARS) -> str:
    s = text if isinstance(text, str) else _flatten_content(text)
    if not isinstance(s, str):
        try:
            s = json.dumps(s, ensure_ascii=False, default=str)
        except Exception:
            s = str(s)
    return s if len(s) <= limit else s[:limit] + f"…[truncated {len(s) - limit} chars]"


def _msg_kind(msg: Any) -> str:
    """消息归类：真 langchain 消息看 .type（"ai"/"tool"/"human"/…），
    鸭子类型对象退回类名小写——测试里的 fake message 也能走同一套逻辑。"""
    t = getattr(msg, "type", None)
    if isinstance(t, str) and t:
        return t
    return type(msg).__name__.lower()


def _is_ai_kind(kind: str) -> bool:
    return kind in ("ai", "aimessage", "aimessagechunk")


def _is_tool_kind(kind: str) -> bool:
    return kind in ("tool", "toolmessage", "toolmessagechunk")


def _jsonable(v: Any) -> bool:
    try:
        json.dumps(v)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# adapter
# ---------------------------------------------------------------------------


def _detect_langgraph_version() -> str | None:
    try:
        import importlib.metadata

        return f"langgraph {importlib.metadata.version('langgraph')}"
    except Exception:
        return None


def _thread_fresh(graph: Any, config: dict) -> bool:
    """thread 是否无 checkpoint 历史。get_state 不可用/失败按 fresh 处理。"""
    get_state = getattr(graph, "get_state", None)
    if get_state is None:
        return True
    try:
        snap = get_state(config)
    except Exception:
        return True
    return not getattr(snap, "values", None)


def _repair_dangling_tool_calls(graph: Any, config: dict) -> int:
    """回合中途死亡（崩溃/error/杀进程）会把『带 tool_calls 的 AI 消息』落进
    checkpoint 而对应 ToolMessage 未写——下个回合 provider 400 拒收整个
    messages（assistant tool_calls must be followed by tool messages）。

    provider 要求 tool 应答**紧跟** AI 消息之后——尾部追加无效（实机验证：
    悬空 AI 在历史中段时 append 的 ToolMessage 不构成合法应答，自身还成
    孤儿）。修法：add_messages 按 id upsert，把悬空 AI 原位替换为只保留
    『已被紧邻 tool 块应答』的 tool_calls 的同 id 副本；游离 ToolMessage
    （无紧邻上游 AI tool_calls 认领，含旧版尾部补丁残留）一并 RemoveMessage。
    返回改动消息数。"""
    get_state = getattr(graph, "get_state", None)
    update_state = getattr(graph, "update_state", None)
    if get_state is None or update_state is None:
        return 0
    try:
        snap = get_state(config)
    except Exception:
        return 0
    values = getattr(snap, "values", None)
    messages = list(values.get("messages") or []) if isinstance(values, dict) else []
    if not messages:
        return 0

    def _tid(tc: Any) -> str | None:
        t = tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None)
        return str(t) if t else None

    patches: list = []
    n = len(messages)
    i = 0
    while i < n:
        m = messages[i]
        kind = _msg_kind(m)
        if _is_ai_kind(kind) and (getattr(m, "tool_calls", None) or getattr(m, "invalid_tool_calls", None)):
            # 紧邻其后的连续 tool 块才算合法应答（provider 语义）
            j = i + 1
            block: list = []
            while j < n and _is_tool_kind(_msg_kind(messages[j])):
                block.append(messages[j])
                j += 1
            block_ids = {getattr(t, "tool_call_id", None) for t in block}
            tcs = list(getattr(m, "tool_calls", None) or ())
            ics = list(getattr(m, "invalid_tool_calls", None) or ())
            keep = [tc for tc in tcs if _tid(tc) in block_ids]
            keep_i = [tc for tc in ics if _tid(tc) in block_ids]
            if len(keep) != len(tcs) or len(keep_i) != len(ics):
                mid = getattr(m, "id", None)
                try:
                    patches.append(
                        m.model_copy(update={"tool_calls": keep, "invalid_tool_calls": keep_i})
                        if mid
                        else ("remove", mid)
                    )
                except AttributeError:
                    if mid:
                        patches.append(("remove", mid))  # 改不了就整条删——AI 无 tool_calls 仍合法
            # block 里不属于本 AI 调用集的 tool 消息是孤儿
            call_ids = {_tid(tc) for tc in tcs} | {_tid(tc) for tc in ics}
            for t in block:
                if getattr(t, "tool_call_id", None) not in call_ids:
                    patches.append(("remove", getattr(t, "id", None)))
            i = j
        elif _is_tool_kind(kind):
            # 不在任何 AI tool_calls 紧邻块内的 tool 消息 → 孤儿
            patches.append(("remove", getattr(m, "id", None)))
            i += 1
        else:
            i += 1

    if not patches:
        return 0
    from langchain_core.messages import RemoveMessage  # 惰性导入

    ops = [RemoveMessage(id=p[1]) if isinstance(p, tuple) and p[1] else p for p in patches]
    if not ops:
        return 0
    update_state(config, {"messages": ops})
    return len(ops)


def _final_values(graph: Any, config: dict, fallback: dict) -> dict:
    try:
        snap = graph.get_state(config)
        values = getattr(snap, "values", None)
        if isinstance(values, dict):
            return values
    except Exception:
        pass
    return fallback


def _iter_update_messages(update: Any):
    """node update 负载里的消息对象：{'messages': [...]} / 单条 / 裸消息。"""
    if isinstance(update, dict):
        candidates = update.get("messages")
        if isinstance(candidates, (list, tuple)):
            yield from candidates
        elif candidates is not None:
            yield candidates
    else:
        yield update


def serve_langgraph(
    graph_or_factory: Any,
    *,
    input_mapper: Callable[[SarpInitialize, SarpTurnStart, bool], Any] | None = None,
    output_mapper: Callable[[dict], str] | None = None,
    interrupt_mapper: Callable[[Any], str] | None = None,
    custom_event_mapper: Callable[[Any], str | None] | None = None,
    cost_calculator: Callable[[dict], float | None] | None = None,
    streaming: bool = True,
    runtime_id: str = "langgraph",
    framework_version: str | None = None,
    transport: Any = None,
    journal: Any = None,
) -> int:
    """LangGraph worker 入口。返回进程退出码（0 正常关停，2 协议/初始化失败）。

    graph_or_factory：CompiledStateGraph 实例，或 `factory(init, tools) ->
    graph` 工厂（§12.4：graph 不能在 import 时就 compile——Slock MCP tools
    要等 initialize 下发后才有；tools 是 list[SlockTool]）。

    mapper 签名：
    - input_mapper(init, turn, fresh) -> graph input；fresh = thread 无
      checkpoint 历史。默认规则见 _default_input_mapper。
    - output_mapper(state_values) -> str：终态 get_state().values → finalText。
    - interrupt_mapper(interrupt.value) -> str：审批提示文本。
    - custom_event_mapper(custom_data) -> str|None：返回 str 才发 progress。
    - cost_calculator(usage_dict) -> float|None：仅提供时才产出 costUsd。
    """

    state: dict[str, Any] = {"graph": None, "tools": [], "mcp_client": None}

    # ---------------- 握手（§12.4 启动顺序） ----------------

    def on_initialize(init: SarpInitialize, emit: TurnEmit) -> dict:
        if init.runtime_id != runtime_id:
            raise SarpError(
                RUNTIME_ID_MISMATCH,
                f"initialize.runtime.id={init.runtime_id!r} != worker runtime_id={runtime_id!r}",
                retryable=False,
            )
        client: SlockMcpClient | None = None
        tools: list[SlockTool] = []
        if init.mcp is not None:
            # 1) MCP client 先行：子进程随 worker 退出由 finally close() 兜底
            client = SlockMcpClient(init.mcp)
            client.start()
            tools = [
                SlockTool(
                    name=t.name,
                    description=t.description,
                    input_schema=t.input_schema,
                    call=lambda args, _n=t.name, _c=client: _c.call_tool(_n, args),
                )
                for t in client.list_tools()
            ]
        state["mcp_client"] = client
        state["tools"] = tools

        # 2) graph：工厂模式把 init + slock tools 交给用户构建
        graph = graph_or_factory(init, tools) if callable(graph_or_factory) else graph_or_factory
        state["graph"] = graph

        # 3) durableThreads：持久 checkpointer 才算（§11.3）
        cp = getattr(graph, "checkpointer", None)
        durable = cp is not None and type(cp).__name__ not in _VOLATILE_CHECKPOINTERS

        model_field: dict = {"overrides": bool(init.model)}
        if init.model:
            model_field["selected"] = init.model
        return {
            "capabilities": {
                "persistentProcess": True,
                "maxConcurrency": 1,
                "streamingText": bool(streaming),
                "toolEvents": True,
                "interrupts": True,
                "durableThreads": durable,
                "mcp": client is not None,
                "usage": "tokens",
            },
            "model": model_field,
        }

    # ---------------- 回合 ----------------

    def _usage_out(seen: set, totals: dict, duration_ms: int) -> dict | None:
        usage: dict[str, Any] = {}
        token_keys = (
            ("input_tokens", "inputTokens"),
            ("output_tokens", "outputTokens"),
            ("total_tokens", "totalTokens"),
        )
        for src, dst in token_keys:
            if src in seen:
                usage[dst] = totals[src]
        usage["durationMs"] = duration_ms
        if cost_calculator is not None:
            cost = cost_calculator(usage)
            if cost is not None:
                usage["costUsd"] = cost
        return usage if len(usage) > 1 else None  # 只有 durationMs 等于没数据

    def _interrupt_record(interrupts: Any) -> InterruptRecord:
        first = next(iter(interrupts), None)
        value = getattr(first, "value", first)
        prompt = interrupt_mapper(value) if interrupt_mapper else None
        if not prompt:
            prompt = str(value)
        return InterruptRecord(
            interrupt_id=f"lg-{secrets.token_hex(8)}",
            resume_token=new_resume_token(),
            prompt=prompt,
            payload=value if _jsonable(value) else None,
        )

    def _handle_update(data: Any, emit: TurnEmit) -> Any | None:
        """updates 事件：返回捕获到的 Interrupt 元组（若有）。"""
        if not isinstance(data, dict):
            return None
        found = None
        for node, update in data.items():
            if node == "__interrupt__":
                found = update  # tuple/list of Interrupt
                continue
            for msg in _iter_update_messages(update):
                kind = _msg_kind(msg)
                if _is_tool_kind(kind):
                    call_id = getattr(msg, "tool_call_id", None) or getattr(msg, "id", "") or ""
                    ok = getattr(msg, "status", "success") == "success"
                    text = _truncate(getattr(msg, "content", ""))
                    emit.tool_end(
                        str(call_id),
                        ok,
                        name=getattr(msg, "name", None),
                        provider="langgraph",
                        output=text,
                        error=None if ok else text,
                    )
                elif _is_ai_kind(kind):
                    for tc in getattr(msg, "tool_calls", None) or ():
                        if not isinstance(tc, dict):
                            continue
                        emit.tool_start(
                            str(tc.get("id") or ""),
                            str(tc.get("name") or ""),
                            provider="langgraph",
                            input=tc.get("args"),
                        )
        return found

    def run_turn(init: SarpInitialize, turn: SarpTurnStart, emit: TurnEmit, cancelled) -> TurnOutcome:
        graph = state["graph"]
        client = state["mcp_client"]
        if client is not None:
            client.set_active_turn(turn.turn_id)  # §15.4：写工具幂等键锚定 turnId
        started = time.monotonic()
        # §11.2：thread_id 按 runtime 身份命名空间控 checkpoint 连续性
        # （runtime/entrypoint/revision/model 变化不复用旧 thread）；
        # slock_turn_id 供幂等审计。
        config = {
            "configurable": {
                "thread_id": checkpoint_thread_id(init, turn.conversation_id),
                "slock_turn_id": turn.turn_id,
            }
        }

        if turn.resume is not None:
            from langgraph.types import Command  # 惰性导入：无 resume 不碰 langgraph

            # 孤儿 resume 防护（实机踩坑）：journal 层已验 token 单次有效，
            # 但 thread 侧可能根本没有 pending interrupt——命名空间漂移
            # （runtime/entrypoint/revision/model 任一变化即换 thread）、
            # 旧格式 thread、checkpoint 丢失都会命中。此时 Command(resume)
            # 会让 agent 节点拿到空 messages → provider 报 "Empty input
            # messages"。显式失败让 daemon 清掉 pending 记录（自愈）。
            has_pending = False
            get_state = getattr(graph, "get_state", None)
            if get_state is not None:
                try:
                    snap = get_state(config)
                    has_pending = bool(getattr(snap, "next", None))
                except Exception:
                    has_pending = False
            if not has_pending:
                raise SarpError(
                    INTERRUPT_NOT_FOUND,
                    f"resume for turn {turn.turn_id}: thread has no pending interrupt",
                    retryable=False,
                )
            graph_input = Command(resume=turn.resume.value)
        else:
            fresh = _thread_fresh(graph, config)
            if not fresh:
                # 上个回合可能死在 tool_call 与 ToolMessage 之间——先补悬空
                # tool_call 的 error ToolMessage，否则 provider 400 拒收整个
                # messages（实机：idempotencyKey 400 崩回合后 thread 永久毒化）。
                _repair_dangling_tool_calls(graph, config)
            mapper = input_mapper or _default_input_mapper
            try:
                graph_input = mapper(init, turn, fresh)
            except SarpError:
                raise
            except Exception as e:
                raise SarpError(GRAPH_INPUT_INVALID, f"input_mapper failed: {e}", retryable=False) from e

        seen_tokens: set = set()
        totals = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        last_updates: dict = {}
        interrupts = None

        def _elapsed() -> int:
            return int((time.monotonic() - started) * 1000)

        if streaming:
            for mode, data in graph.stream(graph_input, config, stream_mode=_STREAM_MODES):
                if cancelled.is_set():
                    return TurnOutcome(status="cancelled")
                if mode == "messages":
                    if isinstance(data, (tuple, list)) and len(data) == 2:
                        chunk, _meta = data
                    else:
                        chunk, _meta = data, {}
                    if _is_ai_kind(_msg_kind(chunk)):
                        text = _flatten_content(getattr(chunk, "content", None))
                        if text:
                            emit.delta(text)
                    um = getattr(chunk, "usage_metadata", None)
                    if isinstance(um, dict):
                        for k in totals:
                            v = um.get(k)
                            if isinstance(v, (int, float)):
                                totals[k] += int(v)
                                seen_tokens.add(k)
                elif mode == "updates":
                    if isinstance(data, dict):
                        for node, upd in data.items():
                            if node != "__interrupt__" and isinstance(upd, dict):
                                last_updates.update(upd)
                    interrupts = _handle_update(data, emit) or interrupts
                elif mode == "custom":
                    mapped = custom_event_mapper(data) if custom_event_mapper else None
                    if isinstance(mapped, str):
                        emit.progress(mapped)
                if interrupts:
                    return TurnOutcome(
                        status="interrupted",
                        interrupt=_interrupt_record(interrupts),
                        usage=_usage_out(seen_tokens, totals, _elapsed()),
                    )
        else:
            result = graph.invoke(graph_input, config)
            if cancelled.is_set():
                return TurnOutcome(status="cancelled")
            if isinstance(result, dict):
                last_updates.update(result)
                intr = result.get("__interrupt__")
                if intr:
                    return TurnOutcome(
                        status="interrupted",
                        interrupt=_interrupt_record(intr),
                        usage=_usage_out(seen_tokens, totals, _elapsed()),
                    )

        values = _final_values(graph, config, last_updates)
        out_map = output_mapper or _default_output_mapper
        final_text = out_map(values)
        if final_text is not None and not isinstance(final_text, str):
            final_text = str(final_text)
        return TurnOutcome(
            status="success",
            final_text=final_text,
            usage=_usage_out(seen_tokens, totals, _elapsed()),
        )

    rt = WorkerRuntime(
        runtime_id=runtime_id,
        framework_version=framework_version or _detect_langgraph_version(),
        transport=transport,
        journal=journal,
    )
    try:
        return rt.serve(run_turn, on_initialize)
    finally:
        client = state["mcp_client"]
        if client is not None:
            client.close()
