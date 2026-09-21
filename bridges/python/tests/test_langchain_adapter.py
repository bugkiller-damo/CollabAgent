"""langchain.py adapter：duck-typed FakeAgent 单测 + 真实 langchain_core 集成段。

FakeAgent 段不依赖任何框架行为——astream_events 直接产 v2 事件 dict，
走真实 WorkerRuntime + os.pipe 帧验证 wire 形状。
RealLangChain 段用 pytest.importorskip("langchain_core")：RunnableLambda /
FakeListChatModel / @tool / StructuredTool + fake MCP server 端到端。
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from slock_runtime.errors import GRAPH_INPUT_INVALID, PROTOCOL_VIOLATION
from slock_runtime.idempotency import TurnJournal
from slock_runtime.langchain import serve_langchain
from slock_runtime.transport import SarpTransport

PY_DIR = Path(__file__).resolve().parents[1]
FAKE_MCP = Path(__file__).resolve().parent / "fixtures" / "fake_mcp_server.py"
EXAMPLE_AGENT = Path(__file__).resolve().parents[2] / "examples" / "langchain-agent" / "agent.py"


def _dframe(type_: str, seq: int, **fields) -> bytes:
    return (
        json.dumps(
            {
                "protocol": "slock.agent-runtime",
                "version": 1,
                "type": type_,
                "seq": seq,
                "timestamp": "2026-09-20T00:00:00.000Z",
                **fields,
            }
        )
        + "\n"
    ).encode()


def init_fields(**platform_over):
    platform = {"systemPrompt": "SYS-PROMPT"}
    platform.update(platform_over)
    return dict(
        requestId="req-1",
        agent={"id": "ag_1", "name": "bot"},
        runtime={"id": "langchain", "entrypoint": "e1", "model": "openai:gpt-4o-mini"},
        workspace={"path": "ws"},
        platform=platform,
        limits={"maxFrameBytes": 1048576, "silenceTimeoutMs": 300000},
    )


def turn_fields(turn_id="t1", **over):
    f = dict(
        turnId=turn_id,
        conversationId="conv-1",
        attempt=1,
        source={"kind": "channel", "channel": "general"},
        prompt="hi",
    )
    f.update(over)
    return f


class Harness:
    """pipe 交互式 harness：驱动真实 serve_langchain（复用 test_runtime 模式）。"""

    def __init__(self, tmp_path):
        r, w = os.pipe()
        self.stdin = os.fdopen(r, "rb")
        self.writer = os.fdopen(w, "wb")
        self.stdout = io.StringIO()
        self.transport = SarpTransport(stdin=self.stdin, stdout=self.stdout)
        self.journal = TurnJournal(str(tmp_path))
        self.exit_code: int | None = None
        self._thread: threading.Thread | None = None
        self._seq = 0

    def start(self, agent_or_factory, **kw) -> None:
        def _go():
            self.exit_code = serve_langchain(
                agent_or_factory, transport=self.transport, journal=self.journal, **kw
            )

        self._thread = threading.Thread(target=_go, daemon=True)
        self._thread.start()

    def send(self, type_: str, **fields) -> None:
        self._seq += 1
        self.writer.write(_dframe(type_, self._seq, **fields))
        self.writer.flush()

    def frames(self) -> list[dict]:
        self.stdout.seek(0)
        return [json.loads(line) for line in self.stdout if line.strip()]

    def wait_frame(self, pred, timeout: float = 8.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for f in self.frames():
                if pred(f):
                    return f
            time.sleep(0.01)
        raise AssertionError(f"timed out waiting for frame; got {[f['type'] for f in self.frames()]}")

    def wait_end(self, turn_id: str, timeout: float = 8.0) -> dict:
        return self.wait_frame(
            lambda f: f["type"] == "turn.end" and f["turnId"] == turn_id, timeout
        )

    def ready(self) -> dict:
        return self.wait_frame(lambda f: f["type"] == "runtime.ready")

    def finish(self, timeout: float = 8.0) -> int:
        with contextlib.suppress(OSError):
            self.writer.close()
        if self._thread:
            self._thread.join(timeout)
        return self.exit_code if self.exit_code is not None else -1


# ---------------------------------------------------------------------------
# duck-typed fakes（不 import langchain_core 也能构造的事件形状）
# ---------------------------------------------------------------------------


class FakeMsg:
    """最小 message：只有 .content / .usage_metadata。"""

    def __init__(self, content=None, usage_metadata=None):
        self.content = content
        self.usage_metadata = usage_metadata


class FakeAgent:
    """duck-typed runnable：astream_events 逐条产 v2 事件 dict。

    events 可为 list / generator / callable(input)->iterable。
    """

    def __init__(self, events=(), capture: list | None = None):
        self._events = events
        self.capture = capture if capture is not None else []

    async def astream_events(self, input, version="v2"):
        assert version == "v2"
        self.capture.append(input)
        events = self._events(input) if callable(self._events) else self._events
        for ev in events:
            yield ev


class FakeAInvoke:
    def __init__(self, result, capture: list | None = None):
        self._r = result
        self.capture = capture if capture is not None else []

    async def ainvoke(self, input):
        self.capture.append(input)
        return self._r


class FakeInvoke:
    def __init__(self, result):
        self._r = result

    def invoke(self, input):
        return self._r


def _chunk(text, run_id="r1", usage=None):
    return {
        "event": "on_chat_model_stream",
        "run_id": run_id,
        "name": "ChatX",
        "data": {"chunk": FakeMsg(text, usage)},
    }


def _model_end(text="done", run_id="r1", usage=None):
    return {
        "event": "on_chat_model_end",
        "run_id": run_id,
        "name": "ChatX",
        "data": {"output": FakeMsg(text, usage)},
    }


def _chain_end(output, run_id="root"):
    return {"event": "on_chain_end", "run_id": run_id, "name": "Agent", "data": {"output": output}}


def _tool_start(name="search", run_id="r9", input=None):
    return {"event": "on_tool_start", "run_id": run_id, "name": name, "data": {"input": input}}


def _tool_end(output, name="search", run_id="r9"):
    return {"event": "on_tool_end", "run_id": run_id, "name": name, "data": {"output": output}}


def _tool_error(err, name="search", run_id="r9"):
    return {"event": "on_tool_error", "run_id": run_id, "name": name, "data": {"error": err}}


def _started(h: Harness, agent, **kw) -> dict:
    h.start(agent, **kw)
    h.send("initialize", **init_fields())
    return h.ready()


# ---------------------------------------------------------------------------
# 握手
# ---------------------------------------------------------------------------


class TestHandshake:
    def test_ready_capabilities_and_model_echo(self, tmp_path):
        h = Harness(tmp_path)
        ready = _started(h, FakeAgent())
        assert ready["requestId"] == "req-1"
        assert ready["runtime"]["id"] == "langchain"
        caps = ready["capabilities"]
        assert caps["persistentProcess"] is True
        assert caps["maxConcurrency"] == 1
        assert caps["streamingText"] is True
        assert caps["toolEvents"] is True
        assert caps["interrupts"] is False
        assert caps["durableThreads"] is False
        assert caps["mcp"] is False
        assert caps["usage"] == "tokens"
        assert ready["model"]["selected"] == "openai:gpt-4o-mini"
        h.send("shutdown")
        assert h.finish() == 0

    def test_factory_called_with_init_and_empty_tools(self, tmp_path):
        seen = {}

        def factory(init, tools):
            seen["init"] = init
            seen["tools"] = tools
            return FakeAgent()

        h = Harness(tmp_path)
        _started(h, factory)
        assert seen["init"].runtime_id == "langchain"
        assert seen["init"].system_prompt == "SYS-PROMPT"
        assert seen["tools"] == []
        h.finish()

    def test_streaming_false_capability(self, tmp_path):
        h = Harness(tmp_path)
        ready = _started(h, FakeAgent(), streaming=False)
        assert ready["capabilities"]["streamingText"] is False
        h.finish()

    def test_framework_version_reported(self, tmp_path):
        h = Harness(tmp_path)
        ready = _started(h, FakeAgent(), framework_version="9.9.9-test")
        assert ready["runtime"]["frameworkVersion"] == "9.9.9-test"
        h.finish()


# ---------------------------------------------------------------------------
# 流式回合
# ---------------------------------------------------------------------------


class TestStreamingTurn:
    def test_deltas_final_text_and_usage(self, tmp_path):
        events = [
            _chunk("hello "),
            _chunk("world"),
            _chunk([{"type": "text", "text": "!"}, {"type": "image", "url": "x"}]),
            _model_end("hello world!", usage={"input_tokens": 3, "output_tokens": 4, "total_tokens": 7}),
            _chain_end({"messages": [FakeMsg("hello world!")]}),
        ]
        h = Harness(tmp_path)
        _started(h, FakeAgent(events))
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        deltas = [f["text"] for f in h.frames() if f["type"] == "assistant.delta"]
        assert deltas == ["hello ", "world", "!"]  # block list 压平，非 text 块丢弃
        assert end["status"] == "success" and end["finalText"] == "hello world!"
        assert end["usage"] == {"inputTokens": 3, "outputTokens": 4, "totalTokens": 7}
        h.finish()

    def test_usage_falls_back_to_chunk_metadata(self, tmp_path):
        events = [
            _chunk("a", usage={"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}),
            _chain_end({"messages": [FakeMsg("a")]}),
        ]
        h = Harness(tmp_path)
        _started(h, FakeAgent(events))
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        assert end["usage"]["totalTokens"] == 3
        h.finish()

    def test_final_text_falls_back_to_streamed(self, tmp_path):
        # 没有任何 *_end 携带 output → 用已流出文本兜底
        h = Harness(tmp_path)
        _started(h, FakeAgent([_chunk("part1 "), _chunk("part2")]))
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        assert end["status"] == "success" and end["finalText"] == "part1 part2"
        h.finish()

    def test_tool_events(self, tmp_path):
        events = [
            _tool_start(name="search", run_id="r9", input={"q": "slock"}),
            _tool_end(FakeMsg("result text"), name="search", run_id="r9"),
            _chain_end({"messages": [FakeMsg("done")]}),
        ]
        h = Harness(tmp_path)
        _started(h, FakeAgent(events))
        h.send("turn.start", **turn_fields("t1"))
        h.wait_end("t1")
        frames = h.frames()
        ts = [f for f in frames if f["type"] == "tool.start"][0]
        assert ts["callId"] == "r9"
        assert ts["tool"]["name"] == "search" and ts["tool"]["provider"] == "langchain"
        assert ts["input"] == {"q": "slock"}
        te = [f for f in frames if f["type"] == "tool.end"][0]
        assert te["callId"] == "r9" and te["ok"] is True
        assert te["tool"]["name"] == "search" and te["tool"]["provider"] == "langchain"
        assert te["output"] == "result text"
        h.finish()

    def test_tool_error_maps_to_failed_tool_end(self, tmp_path):
        events = [
            _tool_start(name="search", run_id="r9"),
            _tool_error("boom" * 300, name="search", run_id="r9"),
            _chain_end({"messages": [FakeMsg("done")]}),
        ]
        h = Harness(tmp_path)
        _started(h, FakeAgent(events))
        h.send("turn.start", **turn_fields("t1"))
        h.wait_end("t1")
        te = [f for f in h.frames() if f["type"] == "tool.end"][0]
        assert te["ok"] is False
        assert len(te["error"]) == 500  # 截断上限
        h.finish()

    def test_tool_output_truncated(self, tmp_path):
        events = [_tool_end("x" * 5000, run_id="r9"), _chain_end({"messages": [FakeMsg("ok")]})]
        h = Harness(tmp_path)
        _started(h, FakeAgent(events))
        h.send("turn.start", **turn_fields("t1"))
        h.wait_end("t1")
        te = [f for f in h.frames() if f["type"] == "tool.end"][0]
        assert len(te["output"]) == 4000
        h.finish()

    def test_cancel_mid_stream(self, tmp_path):
        def gen(_input):
            i = 0
            while True:
                i += 1
                yield _chunk(f"{i} ")

        h = Harness(tmp_path)
        _started(h, FakeAgent(gen))
        h.send("turn.start", **turn_fields("tc"))
        h.wait_frame(lambda f: f["type"] == "assistant.delta")
        h.send("turn.cancel", turnId="tc", reason="user")
        end = h.wait_end("tc")
        assert end["status"] == "cancelled"
        h.finish()

    def test_agent_exception_maps_to_error_end(self, tmp_path):
        def gen(_input):
            yield _chunk("partial ")
            raise ValueError("bad graph input")

        h = Harness(tmp_path)
        _started(h, FakeAgent(gen))
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        assert end["status"] == "error" and end["error"]["code"] == GRAPH_INPUT_INVALID
        h.finish()


# ---------------------------------------------------------------------------
# 输入映射
# ---------------------------------------------------------------------------


class TestInputMapping:
    def test_system_prompt_prepended_by_default(self, tmp_path):
        agent = FakeAgent([_chain_end({"messages": [FakeMsg("ok")]})])
        h = Harness(tmp_path)
        _started(h, agent)
        h.send("turn.start", **turn_fields("t1"))
        h.wait_end("t1")
        msgs = agent.capture[0]["messages"]
        assert [m.type for m in msgs] == ["system", "human"]
        assert msgs[0].content == "SYS-PROMPT" and msgs[1].content == "hi"
        h.finish()

    def test_system_prompt_mode_none(self, tmp_path):
        agent = FakeAgent([_chain_end({"messages": [FakeMsg("ok")]})])
        h = Harness(tmp_path)
        _started(h, agent, system_prompt_mode="none")
        h.send("turn.start", **turn_fields("t1"))
        h.wait_end("t1")
        msgs = agent.capture[0]["messages"]
        assert len(msgs) == 1 and msgs[0].type == "human"
        h.finish()

    def test_input_mapper_result_used(self, tmp_path):
        agent = FakeAgent([_chain_end({"messages": [FakeMsg("ok")]})])
        h = Harness(tmp_path)
        _started(h, agent, input_mapper=lambda init, turn: {"q": f"{turn.prompt}?"})
        h.send("turn.start", **turn_fields("t1"))
        h.wait_end("t1")
        assert agent.capture[0] == {"q": "hi?"}
        h.finish()

    def test_input_mapper_failure_is_graph_input_invalid(self, tmp_path):
        def bad_mapper(init, turn):
            raise KeyError("missing field")

        h = Harness(tmp_path)
        _started(h, FakeAgent(), input_mapper=bad_mapper)
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        assert end["status"] == "error"
        assert end["error"]["code"] == GRAPH_INPUT_INVALID
        assert end["error"]["retryable"] is False
        h.finish()

    def test_resume_rejected(self, tmp_path):
        h = Harness(tmp_path)
        _started(h, FakeAgent())
        h.send(
            "turn.start",
            **turn_fields("t1", resume={"interruptId": "i1", "resumeToken": "tok", "value": "v"}),
        )
        end = h.wait_end("t1")
        assert end["status"] == "error" and end["error"]["code"] == PROTOCOL_VIOLATION
        h.finish()


# ---------------------------------------------------------------------------
# 非流式
# ---------------------------------------------------------------------------


class TestNonStreaming:
    RESULT = {"messages": [FakeMsg("final answer", {"input_tokens": 5, "output_tokens": 6, "total_tokens": 11})]}

    def test_ainvoke_path(self, tmp_path):
        agent = FakeAInvoke(self.RESULT)
        h = Harness(tmp_path)
        _started(h, agent, streaming=False)
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        assert end["status"] == "success" and end["finalText"] == "final answer"
        assert end["usage"]["totalTokens"] == 11
        assert not [f for f in h.frames() if f["type"] == "assistant.delta"]
        h.finish()

    def test_sync_invoke_fallback(self, tmp_path):
        h = Harness(tmp_path)
        _started(h, FakeInvoke(FakeMsg("sync done")), streaming=False)
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        assert end["finalText"] == "sync done"
        h.finish()

    def test_streaming_true_but_no_astream_events_falls_back(self, tmp_path):
        agent = FakeAInvoke(self.RESULT)
        h = Harness(tmp_path)
        _started(h, agent, streaming=True)  # agent 无 astream_events → ainvoke
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        assert end["finalText"] == "final answer"
        h.finish()

    def test_output_usage_cost_mappers(self, tmp_path):
        h = Harness(tmp_path)
        _started(
            h,
            FakeAInvoke(self.RESULT),
            streaming=False,
            output_mapper=lambda r: "custom out",
            # extractor 带 costUsd → 必须被剥掉，只认 cost_calculator（§12.2.8）
            usage_extractor=lambda r: {"inputTokens": 9, "costUsd": 99.0},
            cost_calculator=lambda u: 0.0123,
        )
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        assert end["finalText"] == "custom out"
        assert end["usage"] == {"inputTokens": 9, "costUsd": 0.0123}
        h.finish()


# ---------------------------------------------------------------------------
# 零依赖纪律
# ---------------------------------------------------------------------------


class TestZeroDependency:
    def test_module_import_pulls_no_framework(self):
        """import slock_runtime.langchain 不得引入 langchain*/langgraph（§12.1）。"""
        code = (
            f"import sys; sys.path.insert(0, {str(PY_DIR)!r});"
            "import slock_runtime.langchain;"
            "bad=[m for m in ('langchain','langchain_core','langgraph') if m in sys.modules];"
            "sys.exit(1 if bad else 0)"
        )
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        assert r.returncode == 0, r.stderr


# ---------------------------------------------------------------------------
# 真实 langchain_core 集成段（CI 上缺依赖则整段 skip）
# ---------------------------------------------------------------------------


@pytest.fixture
def lc():
    return pytest.importorskip("langchain_core")


class TestRealLangChain:
    def test_runnable_sequence_streams_real_deltas(self, tmp_path, lc):
        from langchain_core.language_models.fake_chat_models import FakeListChatModel
        from langchain_core.runnables import RunnableLambda

        chain = RunnableLambda(lambda x: x["messages"]) | FakeListChatModel(responses=["hi there"])
        h = Harness(tmp_path)
        _started(h, chain)
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        deltas = [f["text"] for f in h.frames() if f["type"] == "assistant.delta"]
        assert "".join(deltas) == "hi there"
        assert end["status"] == "success" and end["finalText"] == "hi there"
        h.finish()

    def test_real_tool_events(self, tmp_path, lc):
        from langchain_core.runnables import RunnableLambda
        from langchain_core.tools import tool

        @tool
        def echo_tool(x: str) -> str:
            """Echo the input."""
            return "ECHO:" + x

        agent = RunnableLambda(lambda x: echo_tool.invoke({"x": x["messages"][-1].content}))
        h = Harness(tmp_path)
        _started(h, agent)
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        frames = h.frames()
        ts = [f for f in frames if f["type"] == "tool.start"][0]
        assert ts["tool"]["name"] == "echo_tool" and ts["tool"]["provider"] == "langchain"
        assert ts["input"] == {"x": "hi"}
        te = [f for f in frames if f["type"] == "tool.end"][0]
        assert te["ok"] is True and "ECHO:hi" in str(te["output"])
        assert end["status"] == "success"
        h.finish()

    def test_real_ainvoke_non_streaming(self, tmp_path, lc):
        from langchain_core.language_models.fake_chat_models import FakeListChatModel
        from langchain_core.runnables import RunnableLambda

        chain = RunnableLambda(lambda x: x["messages"]) | FakeListChatModel(responses=["nostream"])
        h = Harness(tmp_path)
        _started(h, chain, streaming=False)
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        assert end["finalText"] == "nostream"
        h.finish()

    def test_mcp_tools_loaded_and_callable(self, tmp_path, lc):
        """init.mcp → SlockMcpClient + StructuredTool 工厂注入 + 真实调用（§12.4）。"""
        captured: dict = {}

        def factory(init, tools):
            captured["tools"] = tools
            return FakeAgent([_chain_end({"messages": [FakeMsg("mcp ok")]})])

        h = Harness(tmp_path)
        h.start(factory)
        init = init_fields(mcp={"command": sys.executable, "args": ["-u", str(FAKE_MCP)]})
        h.send("initialize", **init)
        ready = h.ready()
        assert ready["capabilities"]["mcp"] is True

        tools = captured["tools"]
        assert [t.name for t in tools] == ["slock_echo"]
        out = tools[0].invoke({"text": "ping"})
        assert '"text": "ping"' in str(out)

        h.send("turn.start", **turn_fields("t1"))
        assert h.wait_end("t1")["finalText"] == "mcp ok"
        h.send("shutdown")
        assert h.finish() == 0

    @pytest.mark.parametrize(
        ("example", "runtime_id", "durable", "interrupts"),
        [
            ("langchain-agent", "langchain", False, False),
            ("langgraph-agent", "langgraph", True, True),
        ],
    )
    def test_example_probe_frame(self, example, runtime_id, durable, interrupts):
        """examples/*/agent.py --slock-probe：单行 probe.result（§9.4）。

        probe 由 WorkerRuntime.serve 内置——示例源码不再持有 _probe 函数
        或 argv 分支，也不 import langchain/langgraph，无需 importorskip。
        """
        agent = EXAMPLE_AGENT.parents[1] / example / "agent.py"
        src = agent.read_text(encoding="utf-8")
        assert "def _probe" not in src
        assert "encode_worker_frame" not in src
        assert 'if "--slock-probe"' not in src

        env = dict(os.environ)
        env.pop("PYTHONPATH", None)
        r = subprocess.run(
            [sys.executable, str(agent), "--slock-probe"],
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
        assert r.returncode == 0, r.stderr
        lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
        assert len(lines) == 1
        frame = json.loads(lines[0])
        assert frame["protocol"] == "slock.agent-runtime" and frame["version"] == 1
        assert frame["type"] == "probe.result" and frame["probe"] is True
        assert frame["runtime"]["id"] == runtime_id
        assert frame["runtime"]["bridgeVersion"].startswith("slock-runtime/")
        assert frame["capabilities"]["maxConcurrency"] == 1
        assert frame["capabilities"]["persistentProcess"] is True
        assert frame["capabilities"]["pty"] is False
        assert frame["capabilities"]["durableThreads"] is durable
        assert frame["capabilities"]["interrupts"] is interrupts
        assert frame["model"] == {"overrides": True}
