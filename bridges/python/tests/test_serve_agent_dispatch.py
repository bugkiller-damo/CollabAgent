"""serve_agent 统一入口 + 共享内核测试（WP8 §8.1–8.5）。

覆盖：

- **分派**：CompiledStateGraph 同时是 Pregel 与 Runnable——必须先走图
  路径（D1）：create_agent + InMemorySaver 跨回合记忆（模型见到消息数
  2→4；误走 Runnable 路径无持久记忆将是 2→2）；LCEL → Runnable 路径
  逐 token 流式 + stateless 能力面（D6）；不支持对象 → 握手
  runtime.error(GRAPH_INPUT_INVALID)，消息带类型名。
- **执行模式（D5）**：async-only 节点图 auto→async；SqliteSaver 同步图
  auto→sync；AsyncSqliteSaver 跨两回合（常驻 loop 回归守卫——每回合
  asyncio.run 会让绑 loop 的 aiosqlite 连接在第二回合失败）。
- **输入校验（D2）**：无 ``messages`` schema + 默认 mapper → 握手
  GRAPH_INPUT_INVALID；自定义 input_mapper → 成功；运行期 mapper
  KeyError → 同码。
- **工具（§8.2）**：图/Runnable 两条路径的工厂都收到
  ``SlockStructuredTool``（StructuredTool 子类 + ``input_schema`` dict +
  ``metadata.operation``）；``async def`` 工厂在常驻 loop 上执行。
- **resume_mapper（D7）**：``Command(resume=...)`` 应用映射函数；缺省
  原样透传 ``turn.resume.value``。

Harness 与 test_langgraph_adapter.py 同款：内存 stdin/stdout 帧管道驱动
serve_agent；Session 变体按「daemon 串行派发」语义逐帧投喂。
"""

import asyncio
import io
import json
import queue
import sqlite3
import sys
import threading
import time
from pathlib import Path
from typing import Annotated

import pytest

pytest.importorskip("langgraph", reason="langgraph 未安装")
pytest.importorskip("langchain_core", reason="langchain-core 未安装")

from langchain_core.language_models import BaseChatModel, FakeListChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import RunnableLambda
from langchain_core.tools import StructuredTool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import interrupt
from pydantic import PrivateAttr
from typing_extensions import TypedDict

from slock_runtime import serve_agent
from slock_runtime.langgraph import _has_async_node, resolve_execution
from slock_runtime.transport import SarpTransport

TS = "2026-09-20T00:00:00.000Z"
FAKE_MCP = Path(__file__).resolve().parent / "fixtures" / "fake_mcp_server.py"


# ---------------------------------------------------------------------------
# 帧构造 / harness（与 test_langgraph_adapter.py 同款，serve 入口换成 serve_agent）
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
        runtime={"id": "bridge", "entrypoint": "e1"},
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
    return [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]


def _ends(frames: list[dict]) -> list[dict]:
    return [f for f in frames if f["type"] == "turn.end"]


def _wait_for(stdout: io.StringIO, pred, timeout: float = 15.0) -> list[dict]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        fr = _frames(stdout)
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


def run_worker(agent_or_factory, frames: list[bytes], **kwargs) -> tuple[int, list[dict]]:
    """一次性进程生命周期，按 daemon 串行语义投喂（同 test_langgraph_adapter）。"""
    stdin = _QueueStdin()
    stdout = io.StringIO()
    transport = SarpTransport(stdin=stdin, stdout=stdout)
    box: dict = {}
    th = threading.Thread(
        target=lambda: box.setdefault("code", serve_agent(agent_or_factory, transport=transport, **kwargs)),
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
    """起一个真实 serve_agent 线程，帧逐条喂、事件逐条等。"""

    def __init__(self, agent_or_factory, **kwargs):
        self.stdin = _QueueStdin()
        self.stdout = io.StringIO()
        self._transport = SarpTransport(stdin=self.stdin, stdout=self.stdout)
        self._kwargs = kwargs
        self._agent = agent_or_factory
        self.code: int | None = None
        self._th = threading.Thread(target=self._serve, daemon=True)
        self._th.start()

    def _serve(self):
        self.code = serve_agent(self._agent, transport=self._transport, **self._kwargs)

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
# 图 / Runnable 构造器
# ---------------------------------------------------------------------------


def _echo_graph(workspace: Path, *, saver=None):
    """echo 图：末条 human → AIMessage('echo:<text>|n=<消息数>')。

    saver 缺省为 SqliteSaver（durable）；显式传 InMemorySaver()/None 另行指定。
    """
    # 函数式 TypedDict：注解存的是真对象，避开 get_type_hints 对模块 globals 的求值依赖
    S = TypedDict("S", {"messages": Annotated[list, add_messages]})  # noqa: UP013

    def node(state):
        last = state["messages"][-1]
        return {"messages": [AIMessage(f"echo:{last.content}|n={len(state['messages'])}")]}

    g = StateGraph(S).add_node("e", node).add_edge(START, "e").add_edge("e", END)
    if saver is None:
        conn = sqlite3.connect(str(Path(workspace) / "ck.sqlite"), check_same_thread=False)
        saver = SqliteSaver(conn)
    return g.compile(checkpointer=saver)


def _no_messages_graph():
    """不含 'messages' 键的图（触发 §8.4 默认 schema 校验）。"""
    S = TypedDict("S", {"question": str, "answer": str})  # noqa: UP013

    def node(state):
        return {"answer": "a:" + state["question"]}

    return StateGraph(S).add_node("q", node).add_edge(START, "q").add_edge("q", END).compile()


def _interrupt_graph():
    """interrupt() 审批门：resume 值 dict 取 'ok'，其余原样展示。

    （协议面 turn.resume.value 是字符串；Command(resume=...) 拿到的是
    resume_mapper 的返回——可为任意对象。）"""
    S = TypedDict("S", {"messages": Annotated[list, add_messages]})  # noqa: UP013

    def node(state):
        verdict = interrupt({"question": "approve?"})
        ok = verdict["ok"] if isinstance(verdict, dict) else verdict
        return {"messages": [AIMessage(f"verdict={ok}")]}

    return (
        StateGraph(S)
        .add_node("n", node)
        .add_edge(START, "n")
        .add_edge("n", END)
        .compile(checkpointer=InMemorySaver())
    )


def _counting_model():
    """记录每次 _generate 见到的消息数——跨回合记忆是否生效的探针。"""

    class CountingChatModel(BaseChatModel):
        _seen: list = PrivateAttr(default_factory=list)

        @property
        def _llm_type(self) -> str:
            return "counting-chat-model"

        def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
            self._seen.append(len(messages))
            return ChatResult(generations=[ChatGeneration(message=AIMessage(f"r{len(self._seen)}"))])

    return CountingChatModel()


def _runnable_chain(responses: list[str] | None = None):
    """LCEL Runnable：吃默认 {"messages": [...]} 输入，吐模型回复。"""
    return RunnableLambda(lambda x: x["messages"]) | FakeListChatModel(
        responses=responses or ["runnable reply"]
    )


# ---------------------------------------------------------------------------
# 分派（§8.1：D1 图先于 Runnable / D6 Runnable 流式 / D8 跨回合记忆）
# ---------------------------------------------------------------------------


class TestDispatch:
    def test_dispatch_prefers_graph_over_runnable_d1_d8(self, tmp_path):
        """CompiledStateGraph 同时满足 Runnable 鸭子判定——必须先判图：
        checkpointer 记忆生效 → 模型跨回合见 2→4 条消息（Runnable 路径
        无状态，将是 2→2）。"""
        from langchain.agents import create_agent

        model = _counting_model()

        def factory(init, tools):
            return create_agent(model=model, checkpointer=InMemorySaver())

        s = Session(factory)
        s.feed(_init_frame(tmp_path))
        ready = s.wait_type("runtime.ready")
        assert ready["capabilities"]["interrupts"] is True  # 图能力面
        s.feed(_turn(2, "t1", "conv-1", "hi"))
        assert s.wait_turn_end("t1")["status"] == "success"
        s.feed(_turn(3, "t2", "conv-1", "again"))
        assert s.wait_turn_end("t2")["status"] == "success"
        assert s.shutdown() == 0
        # [System, Human]=2 → [System, Human, AI, Human2]=4：图路径记忆生效
        assert model._seen == [2, 4], f"expected memory growth 2->4, got {model._seen}"

    def test_dispatch_runnable_lcel_streams_d6(self, tmp_path):
        """LCEL Runnable → Runnable 路径：astream_events 逐 token 流式 +
        stateless 能力面（interrupts/durableThreads 恒 false，§8.5）。"""
        chain = _runnable_chain(responses=["hello world"])
        code, frames = run_worker(
            chain,
            [
                _init_frame(tmp_path, runtime={"id": "langchain", "entrypoint": "e1", "model": "lc-model"}),
                _turn(2, "t1", "conv-1", "hi"),
                _dframe("shutdown", 3),
            ],
        )
        assert code == 0
        ready = frames[0]
        assert ready["type"] == "runtime.ready"
        assert ready["runtime"]["id"] == "bridge"  # 旧别名归一上报
        assert ready["model"]["selected"] == "lc-model"
        caps = ready["capabilities"]
        assert caps["interrupts"] is False and caps["durableThreads"] is False

        deltas = [f["text"] for f in frames if f["type"] == "assistant.delta"]
        assert "".join(deltas) == "hello world"
        end = _ends(frames)[0]
        assert end["status"] == "success" and end["finalText"] == "hello world"

    def test_dispatch_unsupported_object_handshake_invalid(self, tmp_path):
        """非图/非 Runnable/非工厂 → 握手 runtime.error(GRAPH_INPUT_INVALID)，
        消息带对象类型名——握手期失败而非首回合。"""
        code, frames = run_worker(object(), [_init_frame(tmp_path)])
        assert code == 2
        assert frames[0]["type"] == "runtime.error"
        err = frames[0]["error"]
        assert err["code"] == "GRAPH_INPUT_INVALID"
        assert err["retryable"] is False
        assert "object" in err["message"]


# ---------------------------------------------------------------------------
# 工具（§8.2：两路径工厂统一收 SlockStructuredTool）
# ---------------------------------------------------------------------------


def _assert_slock_tools(tools) -> None:
    assert tools, "factory must receive SlockStructuredTool list"
    for tool in tools:
        assert isinstance(tool, StructuredTool), type(tool)
        assert isinstance(tool.input_schema, dict) and tool.input_schema
        assert tool.metadata == {"slock": True, "operation": tool.name}
        assert callable(tool.func)


class TestSlockStructuredTool:
    def test_graph_factory_receives_slock_structured_tools(self, tmp_path):
        received: list = []
        invoked: dict = {}

        def factory(init, tools):
            received.extend(tools)
            # StructuredTool.invoke(dict) 兼容面 → 握手期 client 仍活，
            # 真调 MCP echo（shutdown 后 client.close()，再调必失败）
            invoked["echo"] = tools[0].invoke({"text": "ping"})
            return _echo_graph(tmp_path)

        s = Session(factory)
        s.feed(
            _init_frame(
                tmp_path,
                platform={
                    "systemPrompt": "sys-prompt",
                    "mcp": {"command": sys.executable, "args": ["-u", str(FAKE_MCP)]},
                },
            )
        )
        ready = s.wait_type("runtime.ready")
        assert ready["capabilities"]["mcp"] is True
        assert s.shutdown() == 0

        _assert_slock_tools(received)
        assert [t.name for t in received] == ["slock_echo", "send_message"]
        assert '"text": "ping"' in str(invoked["echo"])

    def test_runnable_factory_receives_slock_structured_tools(self, tmp_path):
        received: list = []

        def factory(init, tools):
            received.extend(tools)
            return _runnable_chain()

        s = Session(factory)
        s.feed(
            _init_frame(
                tmp_path,
                platform={
                    "systemPrompt": "sys-prompt",
                    "mcp": {"command": sys.executable, "args": ["-u", str(FAKE_MCP)]},
                },
            )
        )
        ready = s.wait_type("runtime.ready")
        assert ready["capabilities"]["mcp"] is True
        assert s.shutdown() == 0
        _assert_slock_tools(received)

    def test_async_factory_runs_on_persistent_loop(self, tmp_path):
        """async def 工厂 awaitable 在共享常驻 loop 上执行——loop 在握手后
        仍 running（asyncio.run 语义下此刻早已 close）。"""
        loops: list = []

        async def factory(init, tools):
            loops.append(asyncio.get_running_loop())
            return _runnable_chain()

        s = Session(factory)
        s.feed(_init_frame(tmp_path))
        ready = s.wait_type("runtime.ready")
        assert ready["type"] == "runtime.ready"
        assert len(loops) == 1
        assert loops[0].is_running() and not loops[0].is_closed()
        s.feed(_turn(2, "t1", "conv-1", "hi"))
        assert s.wait_turn_end("t1")["status"] == "success"
        assert s.shutdown() == 0


# ---------------------------------------------------------------------------
# 执行模式（§8.3：auto/sync/async + 常驻 loop）
# ---------------------------------------------------------------------------


class TestExecutionModes:
    def test_auto_resolves_async_nodes(self, tmp_path):
        """async-only 节点 → auto 判 async（D5），走常驻 loop astream。"""
        S = TypedDict("S", {"messages": Annotated[list, add_messages]})  # noqa: UP013

        async def anode(state):
            await asyncio.sleep(0)
            return {"messages": [AIMessage("aecho:" + state["messages"][-1].content)]}

        g = (
            StateGraph(S)
            .add_node("a", anode)
            .add_edge(START, "a")
            .add_edge("a", END)
            .compile()
        )
        assert _has_async_node(g), "async-only node must be detected"
        assert resolve_execution(g, "auto") == "async"

        code, frames = run_worker(
            g,
            [_init_frame(tmp_path), _turn(2, "t1", "conv-1", "hi"), _dframe("shutdown", 3)],
        )
        assert code == 0
        end = _ends(frames)[0]
        assert end["status"] == "success" and end["finalText"] == "aecho:hi"

    def test_auto_keeps_sync_graph_sync(self, tmp_path):
        """同步图 + SqliteSaver：auto→sync（不能因可 async 的 API 存在而误升，
        SqliteSaver 的同步连接只在主线程可用）。"""
        g = _echo_graph(tmp_path)
        assert resolve_execution(g, "auto") == "sync"

        code, frames = run_worker(
            g,
            [_init_frame(tmp_path), _turn(2, "t1", "conv-1", "hi"), _dframe("shutdown", 3)],
        )
        assert code == 0
        end = _ends(frames)[0]
        assert end["status"] == "success" and end["finalText"] == "echo:hi|n=2"

    def test_async_sqlite_checkpointer_across_turns(self, tmp_path):
        """AsyncSqliteSaver + 常驻 loop：两回合记忆增长（n=2→4）——回归守卫：
        每回合 asyncio.run 会让绑旧 loop 的 aiosqlite 连接失败。"""
        pytest.importorskip("aiosqlite", reason="aiosqlite 未安装")
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        async def factory(init, tools):
            # aiosqlite 连接绑定创建它的 loop——async 工厂在常驻 loop 上
            # 执行（§8.3），正是构建 loop-bound 资源的正确位置
            import aiosqlite

            conn = aiosqlite.connect(str(tmp_path / "ack.sqlite"))
            return _echo_graph(tmp_path, saver=AsyncSqliteSaver(conn))

        s = Session(factory)
        s.feed(_init_frame(tmp_path))
        ready = s.wait_type("runtime.ready")
        assert ready["capabilities"]["durableThreads"] is True
        s.feed(_turn(2, "t1", "conv-1", "hi"))
        e1 = s.wait_turn_end("t1")
        assert e1["status"] == "success" and e1["finalText"] == "echo:hi|n=2"
        s.feed(_turn(3, "t2", "conv-1", "again"))
        e2 = s.wait_turn_end("t2")
        # [System, Human, AI, Human2] → n=4：checkpoint 跨回合连续
        assert e2["status"] == "success" and e2["finalText"] == "echo:again|n=4"
        assert s.shutdown() == 0


# ---------------------------------------------------------------------------
# 输入校验（§8.4 / D2）
# ---------------------------------------------------------------------------


class TestInputValidation:
    def test_graph_without_messages_schema_fails_handshake(self, tmp_path):
        """默认 input mapper 依赖 messages 键——schema 无之 → 握手
        GRAPH_INPUT_INVALID（替代旧运行期 WORKER_ERROR 'question'）。"""
        code, frames = run_worker(_no_messages_graph(), [_init_frame(tmp_path)])
        assert code == 2
        assert frames[0]["type"] == "runtime.error"
        err = frames[0]["error"]
        assert err["code"] == "GRAPH_INPUT_INVALID"
        assert "messages" in err["message"]
        assert "input_mapper" in err["message"]

    def test_custom_input_mapper_bypasses_schema_check(self, tmp_path):
        """自定义 input_mapper 跳过默认 schema 校验（映射函数自己负责形状）。"""
        code, frames = run_worker(
            _no_messages_graph(),
            [_init_frame(tmp_path), _turn(2, "t1", "conv-1", "hello"), _dframe("shutdown", 3)],
            input_mapper=lambda init, turn, fresh: {"question": turn.prompt},
            output_mapper=lambda values: values["answer"],
        )
        assert code == 0
        end = _ends(frames)[0]
        assert end["status"] == "success" and end["finalText"] == "a:hello"

    def test_runtime_mapper_keyerror_maps_graph_input_invalid(self, tmp_path):
        """运行期 input_mapper KeyError → turn.end GRAPH_INPUT_INVALID，
        retryable=false（与 serve_langgraph 旧行为一致）。"""

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


# ---------------------------------------------------------------------------
# resume_mapper（D7）+ system_prompt_mode（D4）
# ---------------------------------------------------------------------------


class TestResumeAndPromptMode:
    def test_resume_mapper_applied_d7(self, tmp_path):
        """resume_mapper(init, turn, interrupt_value) 输出注入
        Command(resume=...)——value "junk" 经 mapper 变 {"ok": True}。"""
        seen_interrupt_values: list = []

        def resume_mapper(init, turn, interrupt_value):
            seen_interrupt_values.append(interrupt_value)
            return {"ok": True}

        s = Session(_interrupt_graph(), resume_mapper=resume_mapper)
        s.feed(_init_frame(tmp_path))
        s.wait_type("runtime.ready")

        s.feed(_turn(2, "t-int", "conv-1", "go"))
        end1 = s.wait_turn_end("t-int")
        assert end1["status"] == "interrupted"
        intr = end1["interrupt"]

        s.feed(
            _turn(
                3,
                "t-resume",
                "conv-1",
                "junk",
                resume={
                    "interruptId": intr["interruptId"],
                    "resumeToken": intr["resumeToken"],
                    "value": "junk",  # 无 mapper 会原样进节点 → verdict['ok'] 抛错
                },
            )
        )
        end2 = s.wait_turn_end("t-resume")
        assert end2["status"] == "success" and end2["finalText"] == "verdict=True"
        # mapper 第 3 参 = 当前 thread pending interrupt 的 value
        assert seen_interrupt_values == [{"question": "approve?"}]
        assert s.shutdown() == 0

    def test_resume_default_value_verbatim(self, tmp_path):
        """无 resume_mapper：turn.resume.value 原样进 Command(resume=...)。"""
        s = Session(_interrupt_graph())
        s.feed(_init_frame(tmp_path))
        s.wait_type("runtime.ready")

        s.feed(_turn(2, "t-int", "conv-1", "go"))
        end1 = s.wait_turn_end("t-int")
        assert end1["status"] == "interrupted"
        intr = end1["interrupt"]

        s.feed(
            _turn(
                3,
                "t-resume",
                "conv-1",
                "go",
                resume={
                    "interruptId": intr["interruptId"],
                    "resumeToken": intr["resumeToken"],
                    "value": "no",
                },
            )
        )
        end2 = s.wait_turn_end("t-resume")
        assert end2["status"] == "success" and end2["finalText"] == "verdict=no"
        assert s.shutdown() == 0

    def test_system_prompt_mode_none_on_graph(self, tmp_path):
        """mode="none"：图路径完全不注入 SystemMessage（节点见 n=1）。"""
        code, frames = run_worker(
            _echo_graph(tmp_path),
            [_init_frame(tmp_path), _turn(2, "t1", "conv-1", "hi"), _dframe("shutdown", 3)],
            system_prompt_mode="none",
        )
        assert code == 0
        end = _ends(frames)[0]
        assert end["status"] == "success" and end["finalText"] == "echo:hi|n=1"


# ---------------------------------------------------------------------------
# 分派细节守卫
# ---------------------------------------------------------------------------


class TestDispatchEdgeCases:
    def test_graph_object_itself_not_factory(self, tmp_path):
        """CompiledStateGraph 是 callable（Pregel 实现 __call__/invoke 族）
        ——不能被误判为工厂调 obj(init, tools)（分派顺序守卫）。"""
        graph = _echo_graph(tmp_path)
        code, frames = run_worker(
            graph,
            [_init_frame(tmp_path), _turn(2, "t1", "conv-1", "yo"), _dframe("shutdown", 3)],
        )
        assert code == 0
        assert _ends(frames)[0]["finalText"] == "echo:yo|n=2"

    def test_runnable_factory_dispatch(self, tmp_path):
        """sync 工厂返回 Runnable → Runnable 路径（工厂先于分派解析）。"""
        code, frames = run_worker(
            lambda init, tools: _runnable_chain(responses=["from factory"]),
            [_init_frame(tmp_path), _turn(2, "t1", "conv-1"), _dframe("shutdown", 3)],
        )
        assert code == 0
        assert _ends(frames)[0]["finalText"] == "from factory"

    def test_runnable_resume_rejected(self, tmp_path):
        """Runnable 路径无状态——resume 一律 PROTOCOL_VIOLATION（§8.5）。"""
        code, frames = run_worker(
            _runnable_chain(),
            [
                _init_frame(tmp_path),
                _turn(
                    2,
                    "t1",
                    "conv-1",
                    "hi",
                    resume={"interruptId": "x", "resumeToken": "y", "value": "v"},
                ),
                _dframe("shutdown", 3),
            ],
        )
        assert code == 0
        end = _ends(frames)[0]
        assert end["status"] == "error"
        assert end["error"]["code"] == "PROTOCOL_VIOLATION"
