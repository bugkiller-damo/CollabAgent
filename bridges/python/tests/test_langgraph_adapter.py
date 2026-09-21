"""langgraph.py adapter 测试（设计文档 §20.4）。

分两层：

- 真实 langgraph + SqliteSaver：同 conversation 多轮记忆、worker 重启恢复、
  thread 隔离、interrupt()/Command(resume=) 往返、tool error 不破坏协议、
  streaming 与 invoke 两种模式、握手 capability（durableThreads）。
- 鸭子类型 fake graph：不 import langgraph 也能跑 adapter 逻辑——delta 抽取、
  tool.start/tool.end 映射、usage 累计成 camelCase。

Harness 与 test_runtime.py 同款：内存 stdin/stdout 帧管道驱动
serve_langgraph；Session 变体按「daemon 串行派发」语义逐帧投喂（前一回合
turn.end 落地后才发下一帧），避免与真实 daemon 不一致的并发派发。
"""

from __future__ import annotations

import io
import json
import queue
import sqlite3
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from slock_runtime.langgraph import serve_langgraph
from slock_runtime.transport import SarpTransport

TS = "2026-09-20T00:00:00.000Z"


# ---------------------------------------------------------------------------
# 帧构造
# ---------------------------------------------------------------------------


def _dframe(type_: str, seq: int, **fields) -> bytes:
    return (
        json.dumps(
            {"protocol": "slock.agent-runtime", "version": 1, "type": type_, "seq": seq, "timestamp": TS, **fields}
        )
        + "\n"
    ).encode()


def _init_frame(workspace: Path, seq: int = 1, **over) -> bytes:
    fields = dict(
        requestId="req-1",
        agent={"id": "ag_1", "name": "bot"},
        runtime={"id": "langgraph", "entrypoint": "e1"},
        workspace={"path": str(workspace)},
        platform={"systemPrompt": "sys-prompt"},
        limits={"maxFrameBytes": 1048576, "silenceTimeoutMs": 300000},
    )
    fields.update(over)
    return _dframe("initialize", seq, **fields)


def _turn(seq: int, turn_id: str, conv: str, prompt: str = "hi", resume: dict | None = None) -> bytes:
    fields = dict(
        turnId=turn_id,
        conversationId=conv,
        attempt=1,
        source={"kind": "channel", "channel": "general"},
        prompt=prompt,
    )
    if resume:
        fields["resume"] = resume
    return _dframe("turn.start", seq, **fields)


def _frames(stdout: io.StringIO) -> list[dict]:
    stdout.seek(0)
    return [json.loads(line) for line in stdout if line.strip()]


def _ends(frames: list[dict]) -> list[dict]:
    return [f for f in frames if f["type"] == "turn.end"]


def _wait_for(stdout: io.StringIO, pred, timeout: float = 15.0) -> list[dict]:
    """轮询 stdout 直到 pred(frames) 为真；写线程半行按『未就绪』处理。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            fr = _frames(stdout)
        except (json.JSONDecodeError, ValueError):
            fr = []
        if pred(fr):
            return fr
        time.sleep(0.01)
    raise AssertionError(f"timeout waiting; got {_frames(stdout)}")


def _wait_turn_end(stdout: io.StringIO, turn_id: str, timeout: float = 15.0) -> dict:
    def is_end(f: dict) -> bool:
        return f.get("type") == "turn.end" and f.get("turnId") == turn_id

    for f in _wait_for(stdout, lambda fs: any(is_end(x) for x in fs), timeout):
        if is_end(f):
            return f
    raise AssertionError("unreachable")


def run_worker(graph_or_factory, frames: list[bytes], **kwargs) -> tuple[int, list[dict]]:
    """一次性进程生命周期，按 daemon 串行语义投喂：

    turn.start 喂出后等到该 turn 的 turn.end 再喂下一帧——静态 BytesIO
    会让 shutdown/下一 turn 与 handler 线程赛跑，那不是真实 daemon 行为。
    无 shutdown 帧时以 EOF 收尾（等价 daemon 关 stdin）。
    """
    stdin = _QueueStdin()
    stdout = io.StringIO()
    transport = SarpTransport(stdin=stdin, stdout=stdout)
    box: dict = {}
    th = threading.Thread(
        target=lambda: box.setdefault("code", serve_langgraph(graph_or_factory, transport=transport, **kwargs)),
        daemon=True,
    )
    th.start()
    saw_shutdown = False
    for raw in frames:
        parsed = json.loads(raw)
        stdin.feed(raw)
        if parsed.get("type") == "turn.start":
            _wait_turn_end(stdout, parsed["turnId"])
        elif parsed.get("type") == "shutdown":
            saw_shutdown = True
    if not saw_shutdown:
        stdin.eof()
    th.join(timeout=15)
    assert not th.is_alive(), "worker did not exit"
    return box.get("code", -1), _frames(stdout)


# ---------------------------------------------------------------------------
# 真实 langgraph 图工厂（无 LLM——不需要任何 API key）
# ---------------------------------------------------------------------------


def _lg():
    pytest.importorskip("langgraph", reason="langgraph 未安装")
    pytest.importorskip("langgraph.checkpoint.sqlite", reason="langgraph-checkpoint-sqlite 未安装")


def _echo_graph(workspace: Path, *, durable: bool = True, gate: bool = False, crash: bool = False):
    """echo 图：末条 human → AIMessage('echo:<text>|n=<消息数>')。

    gate=True 时回复前插 interrupt() 审批门；crash=True 时节点直接抛错。
    """
    _lg()
    from typing import Annotated

    from langchain_core.messages import AIMessage
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.checkpoint.sqlite import SqliteSaver
    from langgraph.graph import END, START, StateGraph
    from langgraph.graph.message import add_messages
    from langgraph.types import interrupt
    from typing_extensions import TypedDict

    # 函数式 TypedDict：注解存的是真对象，避开 __future__.annotations 下
    # get_type_hints 对模块 globals 的求值依赖
    S = TypedDict("S", {"messages": Annotated[list, add_messages]})  # noqa: UP013

    def node(state):
        if crash:
            raise RuntimeError("node exploded")
        last = state["messages"][-1]
        if gate:
            verdict = interrupt({"question": "approve reply?", "draft": getattr(last, "content", "")})
            return {"messages": [AIMessage(f"verdict:{verdict}")]}
        return {"messages": [AIMessage(f"echo:{last.content}|n={len(state['messages'])}")]}

    g = StateGraph(S).add_node("e", node).add_edge(START, "e").add_edge("e", END)
    if durable:
        conn = sqlite3.connect(str(Path(workspace) / "ck.sqlite"), check_same_thread=False)
        return g.compile(checkpointer=SqliteSaver(conn))
    return g.compile(checkpointer=InMemorySaver())


def _tool_graph(workspace: Path):
    """agent 发 tool_call → tool 节点回 ToolMessage(status=...) → final。"""
    _lg()
    from typing import Annotated

    from langchain_core.messages import AIMessage, ToolMessage
    from langgraph.checkpoint.sqlite import SqliteSaver
    from langgraph.graph import END, START, StateGraph
    from langgraph.graph.message import add_messages
    from typing_extensions import TypedDict

    S = TypedDict("S", {"messages": Annotated[list, add_messages]})  # noqa: UP013

    def agent(state):
        call = {"id": "call-1", "name": "search", "args": {"q": "x"}}
        return {"messages": [AIMessage(content="", tool_calls=[call])]}

    def tool(state):
        return {
            "messages": [ToolMessage(content="tool failed hard", tool_call_id="call-1", name="search", status="error")]
        }

    def final(state):
        return {"messages": [AIMessage("final answer")]}

    g = StateGraph(S)
    g.add_node("agent", agent).add_node("tool", tool).add_node("final", final)
    g.add_edge(START, "agent").add_edge("agent", "tool").add_edge("tool", "final").add_edge("final", END)
    conn = sqlite3.connect(str(Path(workspace) / "ck-tool.sqlite"), check_same_thread=False)
    return g.compile(checkpointer=SqliteSaver(conn))


# ---------------------------------------------------------------------------
# Session：daemon 语义的逐帧投喂（等 turn.end 再发下一帧）
# ---------------------------------------------------------------------------


class _QueueStdin:
    def __init__(self):
        self.q: queue.Queue[bytes] = queue.Queue()

    def feed(self, frame: bytes) -> None:
        self.q.put(frame)

    def eof(self) -> None:
        self.q.put(b"")

    def readline(self) -> bytes:
        try:
            return self.q.get(timeout=15)
        except queue.Empty:
            return b""


class Session:
    """起一个真实 serve_langgraph 线程，帧逐条喂、事件逐条等。"""

    def __init__(self, graph_or_factory, **kwargs):
        self.stdin = _QueueStdin()
        self.stdout = io.StringIO()
        self._transport = SarpTransport(stdin=self.stdin, stdout=self.stdout)
        self._kwargs = kwargs
        self._graph = graph_or_factory
        self.code: int | None = None
        self._th = threading.Thread(target=self._serve, daemon=True)
        self._th.start()

    def _serve(self):
        self.code = serve_langgraph(self._graph, transport=self._transport, **self._kwargs)

    def wait_type(self, type_: str, timeout: float = 15.0) -> dict:
        for f in _wait_for(self.stdout, lambda fs: any(f.get("type") == type_ for f in fs), timeout):
            if f.get("type") == type_:
                return f
        raise AssertionError("unreachable")

    def wait_turn_end(self, turn_id: str, timeout: float = 15.0) -> dict:
        return _wait_turn_end(self.stdout, turn_id, timeout)

    def feed(self, frame: bytes) -> None:
        self.stdin.feed(frame)

    def shutdown(self, seq: int = 90) -> int:
        self.feed(_dframe("shutdown", seq, reason="test done", timeoutMs=8000))
        self._th.join(timeout=15)
        assert not self._th.is_alive(), "worker did not exit after shutdown"
        return self.code


# ---------------------------------------------------------------------------
# §20.4 真实 langgraph 用例
# ---------------------------------------------------------------------------


class TestDurableThreads:
    def test_two_turns_same_conversation_share_state(self, tmp_path):
        """同 conversationId 两轮：第二轮能看到第一轮的消息（§20.4.1）。"""
        s = Session(_echo_graph(tmp_path))
        s.feed(_init_frame(tmp_path))
        ready = s.wait_type("runtime.ready")
        assert ready["capabilities"]["durableThreads"] is True

        s.feed(_turn(2, "t1", "conv-1", "hello"))
        e1 = s.wait_type("turn.end")
        # sys-prompt 在首轮注入：messages = [System, Human, AI] → 节点看到 n=2
        assert e1["status"] == "success" and e1["finalText"] == "echo:hello|n=2"

        s.feed(_turn(3, "t2", "conv-1", "again"))
        e2 = s.wait_turn_end("t2")
        # [System, Human, AI, Human2] → n=4：第一轮上下文仍在
        assert e2["status"] == "success" and e2["finalText"] == "echo:again|n=4"
        assert s.shutdown() == 0

    def test_restart_recovers_thread_state(self, tmp_path):
        """worker 重启后同 conversationId 恢复 checkpoint（§20.4.2）。"""
        code, f1 = run_worker(
            _echo_graph(tmp_path),
            [_init_frame(tmp_path), _turn(2, "t1", "conv-1", "hello"), _dframe("shutdown", 3)],
        )
        assert code == 0 and _ends(f1)[0]["finalText"] == "echo:hello|n=2"

        # 新进程生命周期：新 graph 实例 + 新 SqliteSaver 连接 + 新 journal
        code2, f2 = run_worker(
            _echo_graph(tmp_path),
            [_init_frame(tmp_path), _turn(2, "t2", "conv-1", "again"), _dframe("shutdown", 3)],
        )
        end = _ends(f2)[0]
        assert code2 == 0 and end["status"] == "success"
        assert end["finalText"] == "echo:again|n=4"  # 状态跨重启还在

    def test_different_conversation_isolated(self, tmp_path):
        """不同 conversationId → 不同 thread_id → 不串状态（§20.4.3）。"""
        code, frames = run_worker(
            _echo_graph(tmp_path),
            [_init_frame(tmp_path), _turn(2, "t1", "conv-other", "hello"), _dframe("shutdown", 3)],
        )
        assert _ends(frames)[0]["finalText"] == "echo:hello|n=2"  # 全新 thread

    def test_inmemory_checkpointer_reports_not_durable(self, tmp_path):
        """InMemorySaver → durableThreads=false（§11.3）。"""
        _, frames = run_worker(
            _echo_graph(tmp_path, durable=False),
            [_init_frame(tmp_path), _dframe("shutdown", 2)],
        )
        ready = frames[0]
        assert ready["capabilities"]["durableThreads"] is False
        assert ready["capabilities"]["interrupts"] is True
        assert ready["capabilities"]["maxConcurrency"] == 1
        assert ready["runtime"]["id"] == "langgraph"

    def test_system_prompt_only_prepended_on_fresh_thread(self, tmp_path):
        """systemPrompt 只在 thread 全新时进 messages（§12.5）。"""
        s = Session(_echo_graph(tmp_path))
        s.feed(_init_frame(tmp_path))
        s.wait_type("runtime.ready")
        s.feed(_turn(2, "t1", "conv-1", "hello"))
        s.wait_turn_end("t1")
        s.feed(_turn(3, "t2", "conv-1", "again"))
        s.wait_turn_end("t2")
        s.shutdown()

        from langchain_core.messages import SystemMessage

        graph = _echo_graph(tmp_path)
        # §11.2：thread_id 按 runtime 身份命名空间（langgraph:e1:-:-:前缀）
        snap = graph.get_state({"configurable": {"thread_id": "langgraph:e1:-:-:conv-1"}})
        sys_msgs = [m for m in snap.values["messages"] if isinstance(m, SystemMessage)]
        assert len(sys_msgs) == 1 and sys_msgs[0].content == "sys-prompt"


class TestInterruptResume:
    def test_interrupt_then_resume_same_worker(self, tmp_path):
        """interrupt() → interrupted 终态 + §8.6 一致预览；resume → Command 到节点。"""
        s = Session(_echo_graph(tmp_path, gate=True))
        s.feed(_init_frame(tmp_path))
        s.wait_type("runtime.ready")

        s.feed(_turn(2, "t-int", "conv-1", "draft please"))
        prev = s.wait_type("turn.interrupt")
        end = s.wait_type("turn.end")
        assert end["status"] == "interrupted" and end["turnId"] == "t-int"
        # §8.6：预览↔终态三要素一致
        assert (prev["interruptId"], prev["resumeToken"], prev["prompt"]) == (
            end["interrupt"]["interruptId"],
            end["interrupt"]["resumeToken"],
            end["interrupt"]["prompt"],
        )
        assert end["interrupt"]["interruptId"].startswith("lg-")

        # 同 conversation 下一条消息作为 resume.value 恢复
        s.feed(
            _turn(
                3,
                "t-resume",
                "conv-1",
                "approve",
                resume={
                    "interruptId": end["interrupt"]["interruptId"],
                    "resumeToken": end["interrupt"]["resumeToken"],
                    "value": "approve",
                },
            )
        )
        e2 = s.wait_turn_end("t-resume")
        assert e2["status"] == "success" and e2["finalText"] == "verdict:approve"
        assert s.shutdown() == 0

    def test_resume_survives_worker_restart(self, tmp_path):
        """interrupt 后进程重启：journal token + SqliteSaver checkpoint 都在盘上。"""
        _, f1 = run_worker(
            _echo_graph(tmp_path, gate=True),
            [_init_frame(tmp_path), _turn(2, "t-int", "conv-1", "draft"), _dframe("shutdown", 3)],
        )
        intr = _ends(f1)[0]["interrupt"]

        _, f2 = run_worker(
            _echo_graph(tmp_path, gate=True),
            [
                _init_frame(tmp_path),
                _turn(
                    2,
                    "t-resume",
                    "conv-1",
                    "go",
                    resume={"interruptId": intr["interruptId"], "resumeToken": intr["resumeToken"], "value": "yes"},
                ),
                _dframe("shutdown", 3),
            ],
        )
        end = _ends(f2)[0]
        assert end["status"] == "success" and end["finalText"] == "verdict:yes"


class TestErrors:
    def test_node_exception_single_error_end(self, tmp_path):
        """graph 抛错 → 恰好一个 turn.end(status=error)，协议不被污染（§20.4.8）。"""
        code, frames = run_worker(
            _echo_graph(tmp_path, crash=True),
            [_init_frame(tmp_path), _turn(2, "t1", "conv-1"), _dframe("shutdown", 3)],
        )
        assert code == 0
        ends = _ends(frames)
        assert len(ends) == 1 and ends[0]["status"] == "error"
        assert ends[0]["error"]["code"] == "WORKER_ERROR"
        assert "node exploded" in ends[0]["error"]["message"]
        assert frames[-1]["type"] == "runtime.stopped"

    def test_tool_message_error_maps_tool_end_not_fatal(self, tmp_path):
        """ToolMessage(status=error) → tool.end ok=false，回合仍 success（§20.4.7）。"""
        code, frames = run_worker(
            _tool_graph(tmp_path),
            [_init_frame(tmp_path), _turn(2, "t1", "conv-1"), _dframe("shutdown", 3)],
        )
        assert code == 0
        starts = [f for f in frames if f["type"] == "tool.start"]
        ends_t = [f for f in frames if f["type"] == "tool.end"]
        assert starts[0]["callId"] == "call-1" and starts[0]["tool"]["name"] == "search"
        assert starts[0]["tool"]["provider"] == "langgraph"
        assert starts[0]["input"] == {"q": "x"}
        assert ends_t[0]["callId"] == "call-1" and ends_t[0]["ok"] is False
        assert ends_t[0]["error"] and "tool failed" in ends_t[0]["error"]
        end = _ends(frames)[0]
        assert end["status"] == "success" and end["finalText"] == "final answer"

    def test_input_mapper_failure_is_graph_input_invalid(self, tmp_path):
        def bad_mapper(init, turn, fresh):
            raise KeyError("nope")

        _, frames = run_worker(
            _echo_graph(tmp_path),
            [_init_frame(tmp_path), _turn(2, "t1", "conv-1"), _dframe("shutdown", 3)],
            input_mapper=bad_mapper,
        )
        end = _ends(frames)[0]
        assert end["status"] == "error" and end["error"]["code"] == "GRAPH_INPUT_INVALID"
        assert end["error"]["retryable"] is False

    def test_runtime_id_mismatch_rejected(self, tmp_path):
        init = _init_frame(tmp_path, runtime={"id": "langchain", "entrypoint": "e1"})
        code, frames = run_worker(_echo_graph(tmp_path), [init])
        assert code == 2 and frames[0]["type"] == "runtime.error"
        assert frames[0]["error"]["code"] == "RUNTIME_ID_MISMATCH"


class TestStreamingModes:
    @pytest.mark.parametrize("streaming", [True, False])
    def test_both_modes_produce_final_text(self, tmp_path, streaming):
        """stream 与 invoke 两条路径都产出 finalText（§20.4.9）。"""
        _, frames = run_worker(
            _echo_graph(tmp_path),
            [_init_frame(tmp_path), _turn(2, "t1", "conv-1", "yo"), _dframe("shutdown", 3)],
            streaming=streaming,
        )
        end = _ends(frames)[0]
        assert end["status"] == "success" and end["finalText"] == "echo:yo|n=2"


# ---------------------------------------------------------------------------
# 鸭子类型 fake graph：不依赖 langgraph 的 adapter 逻辑
# ---------------------------------------------------------------------------


class _FakeChunk:
    type = "ai"

    def __init__(self, content, usage=None):
        self.content = content
        if usage is not None:
            self.usage_metadata = usage


class _FakeAI:
    type = "ai"

    def __init__(self, content="", tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls or []


class _FakeTool:
    type = "tool"

    def __init__(self, content, call_id="call-9", status="success", name="search"):
        self.content = content
        self.tool_call_id = call_id
        self.status = status
        self.name = name


class _FakeGraph:
    """最小鸭子类型 graph：stream 按剧本吐 (mode, data)，get_state 给 values。"""

    checkpointer = None  # 进程内 → durableThreads False

    def __init__(self, events, final_values):
        self._events = events
        self._values = final_values
        self.stream_calls: list[dict] = []

    def stream(self, graph_input, config, stream_mode=None):
        self.stream_calls.append({"input": graph_input, "config": config, "stream_mode": stream_mode})
        yield from self._events

    def get_state(self, config):
        return SimpleNamespace(values=self._values)


class TestDuckTypedAdapter:
    def _graph(self) -> _FakeGraph:
        usage = {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}
        tool_calls = [{"id": "c1", "name": "search", "args": {"q": "x"}}]
        return _FakeGraph(
            events=[
                ("messages", (_FakeChunk("hel", usage), {"langgraph_node": "a"})),
                ("messages", (_FakeChunk("lo", usage), {})),
                ("custom", {"msg": "检索中"}),
                ("updates", {"a": {"messages": [_FakeAI(tool_calls=tool_calls)]}}),
                ("updates", {"t": {"messages": [_FakeTool("R" * 5000, call_id="c1")]}}),
            ],
            final_values={"messages": [_FakeAI("done")]},
        )

    def test_delta_tool_usage_flow(self, tmp_path):
        graph = self._graph()
        _, frames = run_worker(
            graph,
            [_init_frame(tmp_path, platform={}), _turn(2, "t1", "conv-1"), _dframe("shutdown", 3)],
            custom_event_mapper=lambda d: d.get("msg") if isinstance(d, dict) else None,
        )
        types = [f["type"] for f in frames]
        assert types[0] == "runtime.ready"
        deltas = [f for f in frames if f["type"] == "assistant.delta"]
        assert [d["text"] for d in deltas] == ["hel", "lo"]

        prog = [f for f in frames if f["type"] == "assistant.progress"]
        assert prog and prog[0]["message"] == "检索中"

        ts = [f for f in frames if f["type"] == "tool.start"][0]
        assert ts["callId"] == "c1"
        assert ts["tool"]["name"] == "search" and ts["tool"]["provider"] == "langgraph"
        assert ts["input"] == {"q": "x"}

        te = [f for f in frames if f["type"] == "tool.end"][0]
        assert te["callId"] == "c1" and te["ok"] is True
        assert te["tool"]["name"] == "search" and te["tool"]["provider"] == "langgraph"
        # 5000 字符输出被截断到 ~4000
        assert len(te["output"]) < 5000 and "truncated" in te["output"]

        end = _ends(frames)[0]
        assert end["status"] == "success" and end["finalText"] == "done"
        # usage_metadata 累计 → camelCase（§8.5）
        assert end["usage"]["inputTokens"] == 2
        assert end["usage"]["outputTokens"] == 4
        assert end["usage"]["totalTokens"] == 6

        # §11.2 config 形状：thread_id = runtime:entrypoint:revision:model:conv
        cfg = graph.stream_calls[0]["config"]
        assert cfg["configurable"]["thread_id"] == "langgraph:e1:-:-:conv-1"
        assert cfg["configurable"]["slock_turn_id"] == "t1"
        assert graph.stream_calls[0]["stream_mode"] == ["messages", "updates", "custom"]

    def test_custom_events_dropped_without_mapper(self, tmp_path):
        graph = self._graph()
        _, frames = run_worker(
            graph,
            [_init_frame(tmp_path, platform={}), _turn(2, "t1", "conv-1"), _dframe("shutdown", 3)],
        )
        assert not [f for f in frames if f["type"] == "assistant.progress"]

    def test_cost_usd_only_with_calculator(self, tmp_path):
        graph = _FakeGraph(events=[], final_values={"messages": [_FakeAI("x")]})
        _, f1 = run_worker(
            graph,
            [_init_frame(tmp_path, platform={}), _turn(2, "t1", "c1"), _dframe("shutdown", 3)],
        )
        # 无 token 无 calculator → 没有 usage 字段
        assert "usage" not in _ends(f1)[0]

        _, f2 = run_worker(
            graph,
            [_init_frame(tmp_path, platform={}), _turn(2, "t2", "c1"), _dframe("shutdown", 3)],
            cost_calculator=lambda u: 0.0042,
        )
        assert _ends(f2)[0]["usage"]["costUsd"] == 0.0042


# ---------------------------------------------------------------------------
# §20.4 e2e：WorkerRuntime + 真管道 + 真 graph
# ---------------------------------------------------------------------------


class TestEndToEnd:
    def test_full_lifecycle_real_graph(self, tmp_path):
        """init → turn → shutdown 全程真帧真图：终态唯一、seq 单调。"""
        s = Session(_echo_graph(tmp_path))
        s.feed(_init_frame(tmp_path))
        s.feed(_turn(2, "t1", "conv-1", "hello e2e"))
        s.wait_turn_end("t1")
        s.shutdown()
        frames = _frames(s.stdout)

        types = [f["type"] for f in frames]
        assert types[0] == "runtime.ready" and types[-1] == "runtime.stopped"
        ends = _ends(frames)
        assert len(ends) == 1
        assert ends[0]["status"] == "success" and ends[0]["finalText"] == "echo:hello e2e|n=2"
        # 出向 seq 严格单调（§8.1.2）
        assert [f["seq"] for f in frames] == list(range(1, len(frames) + 1))
        # 回合事件 eventSeq 从 1 单调
        turn_events = [f for f in frames if f.get("turnId") == "t1"]
        assert [e["eventSeq"] for e in turn_events] == list(range(1, len(turn_events) + 1))
        assert s.code == 0

    def test_factory_receives_init_and_tools(self, tmp_path):
        """工厂形态：factory(init, tools) 被调用、拿到空 tools（无 mcp 下发）。"""
        seen = {}

        def factory(init, tools):
            seen["model"] = init.model
            seen["tools"] = list(tools)
            return _echo_graph(tmp_path)

        _, frames = run_worker(
            factory,
            [_init_frame(tmp_path), _turn(2, "t1", "conv-1"), _dframe("shutdown", 3)],
        )
        assert seen["tools"] == []
        assert _ends(frames)[0]["status"] == "success"
        # 无 mcp descriptor → mcp capability false
        assert frames[0]["capabilities"]["mcp"] is False
