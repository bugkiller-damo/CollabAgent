"""WP9 §9.1/§9.2：HITL interrupt 默认渲染 + resume 默认归约（复现 D11）。

create_agent + HumanInTheLoopMiddleware + InMemorySaver 全链路：

- 文本「批准」→ approve 决定，工具执行，回合 success；
- 文本「先别发」→ reject，工具未执行，模型收到拒绝 ToolMessage
  （歧义输入不得执行被拦截动作）；
- decision {"type":"edit","args":…} → 按修改后参数执行；
- 一回合两个待审批 tool_call → 决定按 action_requests 数复制
  （中间件要求数量一致，human_in_the_loop.py:483-489——单份决定
  会 ValueError count mismatch）；
- turn.interrupt 帧：options.decisions 为排序后的允许集合、
  options.actions 为待审批预览、prompt 为可读文本而非 dict 原文；
- 非 HITL interrupt：decision dict 透传 / value 原文兜底；
- 渲染/归约 helper 单元用例：allowed_decisions 交集、prompt/question/
  message 键、json 兜底、批准词归类、reject→respond 兜底、未知
  decision 类型透传。

Harness 与 test_serve_agent_dispatch.py 同款：内存 stdin/stdout 帧
管道驱动 serve_agent；Session 按「daemon 串行派发」语义逐帧投喂。
"""

from __future__ import annotations

import io
import json
import queue
import threading
import time
from pathlib import Path
from typing import Annotated

import pytest

pytest.importorskip("langgraph", reason="langgraph 未安装")
pytest.importorskip("langchain_core", reason="langchain-core 未安装")
pytest.importorskip("langchain", reason="langchain 未安装")

from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import interrupt
from pydantic import PrivateAttr
from typing_extensions import TypedDict

from slock_runtime import serve_agent
from slock_runtime.errors import SarpError
from slock_runtime.langgraph import (
    _default_interrupt_render,
    _hitl_allowed_decisions,
    _hitl_resume,
    _hitl_text_decision,
    _is_approval_text,
)
from slock_runtime.protocol import SarpResume, SarpResumeDecision, SarpTurnSource, SarpTurnStart
from slock_runtime.transport import SarpTransport

TS = "2026-10-13T00:00:00.000Z"


# ---------------------------------------------------------------------------
# 帧构造 / harness（与 test_serve_agent_dispatch.py 同款）
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
# create_agent + HumanInTheLoopMiddleware 夹具（D11 复现）
# ---------------------------------------------------------------------------


class _ScriptedModel(BaseChatModel):
    """按剧本逐次返回 AIMessage；bind_tools 返回自身（工具循环不校验 schema）。"""

    _script: list = PrivateAttr(default_factory=list)
    _calls_seen: list = PrivateAttr(default_factory=list)

    def __init__(self, script, **kw):
        super().__init__(**kw)
        self._script = list(script)
        self._calls_seen = []

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        self._calls_seen.append(list(messages))
        msg = self._script.pop(0)
        return ChatResult(generations=[ChatGeneration(message=msg)])


def _hitl_agent(script: list, executed: list, interrupt_on: dict, model_out: list | None = None):
    """create_agent(send_email/delete_file + HITL middleware + InMemorySaver)。

    executed 记录真实工具调用（证明 approve/edit 才执行）；interrupt_on
    形如 {"send_email": True}（True = 四种决定全允许）。"""
    model = _ScriptedModel(script)

    @tool
    def send_email(to: str, body: str) -> str:
        """Send an email to somebody."""
        executed.append({"name": "send_email", "args": {"to": to, "body": body}})
        return f"sent to {to}"

    @tool
    def delete_file(path: str) -> str:
        """Delete a file."""
        executed.append({"name": "delete_file", "args": {"path": path}})
        return f"deleted {path}"

    agent = create_agent(
        model=model,
        tools=[send_email, delete_file],
        middleware=[HumanInTheLoopMiddleware(interrupt_on=interrupt_on)],
        checkpointer=InMemorySaver(),
    )
    if model_out is not None:
        model_out.append(model)
    return agent


def _ai_call(call_id: str, name: str, args: dict) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"id": call_id, "name": name, "args": args}])


def _resume_frame(seq: int, turn_id: str, intr: dict, value: str, decision: dict | None = None) -> bytes:
    resume = {"interruptId": intr["interruptId"], "resumeToken": intr["resumeToken"], "value": value}
    if decision is not None:
        resume["decision"] = decision
    return _turn(seq, turn_id, "conv-1", value, resume=resume)


def _interrupt_turn(s: Session, tmp_path: Path, seq: int = 2) -> tuple[dict, dict]:
    """喂首个 turn → (turn.interrupt 预览帧, turn.end interrupted 帧)。"""
    s.feed(_init_frame(tmp_path))
    s.wait_type("runtime.ready")
    s.feed(_turn(seq, "t-int", "conv-1", "do it"))
    preview = s.wait_type("turn.interrupt")
    end = s.wait_turn_end("t-int")
    assert end["status"] == "interrupted"
    return preview, end


class TestHitlResumeE2E:
    """D11：纯文本 / 结构化 resume 经默认归约成 {"decisions":[…]}。"""

    def test_text_approve_executes_tool(self, tmp_path):
        """文本「批准」→ {"type":"approve"}——工具执行，回合 success。"""
        executed: list = []
        agent = _hitl_agent(
            [_ai_call("c1", "send_email", {"to": "a@b.c", "body": "hi"}), AIMessage("已发送")],
            executed,
            {"send_email": True},
        )
        s = Session(agent)
        _, end1 = _interrupt_turn(s, tmp_path)
        intr = end1["interrupt"]

        s.feed(_resume_frame(3, "t-resume", intr, "批准"))
        e2 = s.wait_turn_end("t-resume")
        assert e2["status"] == "success" and e2["finalText"] == "已发送"
        assert executed == [{"name": "send_email", "args": {"to": "a@b.c", "body": "hi"}}]
        assert s.shutdown() == 0

    def test_text_non_approval_rejects_and_tool_not_executed(self, tmp_path):
        """文本「先别发」→ reject(message=原文)：工具未执行，模型收到拒绝。"""
        executed: list = []
        models: list = []
        agent = _hitl_agent(
            [_ai_call("c1", "send_email", {"to": "a@b.c", "body": "hi"}), AIMessage("好的，不发")],
            executed,
            {"send_email": True},
            model_out=models,
        )
        s = Session(agent)
        _, end1 = _interrupt_turn(s, tmp_path)
        intr = end1["interrupt"]

        s.feed(_resume_frame(3, "t-resume", intr, "先别发"))
        e2 = s.wait_turn_end("t-resume")
        assert e2["status"] == "success" and e2["finalText"] == "好的，不发"
        assert executed == []  # 歧义/拒绝输入不执行被拦截动作
        # 模型第二轮收到人造 ToolMessage（User rejected … reason: 先别发）
        second_call = models[0]._calls_seen[1]
        tool_msgs = [m for m in second_call if getattr(m, "type", None) == "tool"]
        assert any("先别发" in str(m.content) for m in tool_msgs)
        assert s.shutdown() == 0

    def test_decision_edit_runs_with_edited_args(self, tmp_path):
        """decision {"type":"edit","args":{…}} → edited_action 按修改后参数执行。"""
        executed: list = []
        agent = _hitl_agent(
            [_ai_call("c1", "send_email", {"to": "a@b.c", "body": "draft"}), AIMessage("done")],
            executed,
            {"send_email": True},
        )
        s = Session(agent)
        _, end1 = _interrupt_turn(s, tmp_path)
        intr = end1["interrupt"]

        s.feed(
            _resume_frame(
                3,
                "t-resume",
                intr,
                "【审批】修改",
                decision={"type": "edit", "args": {"to": "new@d.e", "body": "edited"}},
            )
        )
        e2 = s.wait_turn_end("t-resume")
        assert e2["status"] == "success"
        assert executed == [{"name": "send_email", "args": {"to": "new@d.e", "body": "edited"}}]
        assert s.shutdown() == 0

    def test_decision_replicated_per_action_request(self, tmp_path):
        """一回合两个待审批 tool_call：单个 HITLRequest 含两条 action_requests，
        决定复制两份（中间件 count 校验）——两个工具都被执行。"""
        executed: list = []
        both = AIMessage(
            content="",
            tool_calls=[
                {"id": "c1", "name": "send_email", "args": {"to": "x@y.z", "body": "b1"}},
                {"id": "c2", "name": "delete_file", "args": {"path": "/tmp/f"}},
            ],
        )
        agent = _hitl_agent(
            [both, AIMessage("done2")],
            executed,
            {"send_email": True, "delete_file": True},
        )
        s = Session(agent)
        _, end1 = _interrupt_turn(s, tmp_path)
        intr = end1["interrupt"]

        s.feed(_resume_frame(3, "t-resume", intr, "批准"))
        e2 = s.wait_turn_end("t-resume")
        assert e2["status"] == "success" and e2["finalText"] == "done2"
        assert executed == [
            {"name": "send_email", "args": {"to": "x@y.z", "body": "b1"}},
            {"name": "delete_file", "args": {"path": "/tmp/f"}},
        ]
        assert s.shutdown() == 0

    def test_interrupt_frame_options_and_readable_prompt(self, tmp_path):
        """turn.interrupt 帧：options.decisions=排序允许集、actions 预览、
        prompt 是「需要审批：调用 …（k=v）。可选：批准 / 拒绝 / 回复 / 修改」
        式的可读文本，不是 dict 原文。"""
        executed: list = []
        agent = _hitl_agent(
            [_ai_call("c1", "send_email", {"to": "a@b.c", "body": "hi"}), AIMessage("done")],
            executed,
            {"send_email": True},
        )
        s = Session(agent)
        preview, end1 = _interrupt_turn(s, tmp_path)
        assert s.shutdown() == 0

        for frame in (preview, end1["interrupt"]):
            opts = frame["options"]
            assert opts["decisions"] == ["approve", "edit", "reject", "respond"]
            action = opts["actions"][0]
            assert action["name"] == "send_email"
            assert action["args"] == {"to": "a@b.c", "body": "hi"}
            assert action["description"]  # 中间件 description 透传
        prompt = preview["prompt"]
        assert "需要审批" in prompt and "send_email" in prompt and "可选" in prompt
        assert "action_requests" not in prompt  # 不是 dict 原文

    def test_allowed_decisions_narrowed_options(self, tmp_path):
        """interrupt_on 收窄 allowed_decisions → options.decisions 只报交集。"""
        executed: list = []
        agent = _hitl_agent(
            [_ai_call("c1", "send_email", {"to": "a@b.c", "body": "hi"}), AIMessage("done")],
            executed,
            {"send_email": {"allowed_decisions": ["approve", "reject"]}},
        )
        s = Session(agent)
        preview, _ = _interrupt_turn(s, tmp_path)
        assert s.shutdown() == 0
        assert preview["options"]["decisions"] == ["approve", "reject"]
        assert "批准" in preview["prompt"] and "修改" not in preview["prompt"]

    def test_user_interrupt_mapper_suppresses_default_render(self, tmp_path):
        """§9.1：用户提供 interrupt_mapper 时以用户为准——prompt 用 mapper
        结果，且不产出默认 options。"""
        executed: list = []
        agent = _hitl_agent(
            [_ai_call("c1", "send_email", {"to": "a@b.c", "body": "hi"}), AIMessage("done")],
            executed,
            {"send_email": True},
        )
        s = Session(agent, interrupt_mapper=lambda v: "CUSTOM-PROMPT")
        preview, _ = _interrupt_turn(s, tmp_path)
        assert s.shutdown() == 0
        assert preview["prompt"] == "CUSTOM-PROMPT"
        assert "options" not in preview  # 用户 mapper 在场不产出默认 options


# ---------------------------------------------------------------------------
# 非 HITL interrupt：decision 透传 + 原文兜底（现状语义不回退）
# ---------------------------------------------------------------------------


def _verdict_graph():
    """interrupt({"question": …}) 审批门——非 HITL 形状：dict 无 action_requests。"""
    S = TypedDict("S", {"messages": Annotated[list, add_messages]})  # noqa: UP013

    def node(state):
        verdict = interrupt({"question": "approve reply?", "draft": "x"})
        ok = verdict["type"] if isinstance(verdict, dict) else verdict
        return {"messages": [AIMessage(f"verdict={ok}")]}

    return (
        StateGraph(S)
        .add_node("n", node)
        .add_edge(START, "n")
        .add_edge("n", END)
        .compile(checkpointer=InMemorySaver())
    )


class TestNonHitlInterrupt:
    def test_non_hitl_decision_passthrough(self, tmp_path):
        """decision 出席 → decision dict 原样进节点（{type,message?,args?}）。"""
        s = Session(_verdict_graph())
        _, end1 = _interrupt_turn(s, tmp_path)
        # dict 含 question 键 → prompt 取该值（§9.1）
        assert end1["interrupt"]["prompt"] == "approve reply?"
        intr = end1["interrupt"]

        s.feed(
            _resume_frame(
                3,
                "t-resume",
                intr,
                "【审批】批准",
                decision={"type": "approve"},
            )
        )
        e2 = s.wait_turn_end("t-resume")
        assert e2["status"] == "success" and e2["finalText"] == "verdict=approve"
        assert s.shutdown() == 0

    def test_non_hitl_verbatim_value_fallback(self, tmp_path):
        """无 decision → resume.value 原文透传（现状语义）。"""
        s = Session(_verdict_graph())
        _, end1 = _interrupt_turn(s, tmp_path)
        intr = end1["interrupt"]

        s.feed(_resume_frame(3, "t-resume", intr, "go ahead"))
        e2 = s.wait_turn_end("t-resume")
        assert e2["status"] == "success" and e2["finalText"] == "verdict=go ahead"
        assert s.shutdown() == 0


# ---------------------------------------------------------------------------
# 渲染 / 归约 helper 单元用例（不跑 worker）
# ---------------------------------------------------------------------------

_HITL = {
    "action_requests": [
        {"name": "send_email", "args": {"to": "a@b.c", "body": "hi"}, "description": "d1"},
        {"name": "delete_file", "args": {"path": "/tmp/f"}},
    ],
    "review_configs": [
        {"action_name": "send_email", "allowed_decisions": ["approve", "edit", "reject", "respond"]},
        {"action_name": "delete_file", "allowed_decisions": ["approve", "reject"]},
    ],
}


def _turn_with_resume(value: str, decision: dict | None = None) -> SarpTurnStart:
    return SarpTurnStart(
        seq=1,
        turn_id="t",
        conversation_id="c",
        attempt=1,
        source=SarpTurnSource(kind="channel"),
        prompt=value,
        resume=SarpResume(
            interrupt_id="i",
            resume_token="r",
            value=value,
            decision=SarpResumeDecision(**decision) if decision else None,
        ),
    )


class TestInterruptRenderHelpers:
    def test_allowed_decisions_intersection(self):
        """交集：全量 ∩ {approve,reject} → {approve,reject}（排序输出）。"""
        assert _hitl_allowed_decisions(_HITL) == ["approve", "reject"]

    def test_allowed_decisions_empty_or_missing(self):
        """交集为空 / review_configs 缺失 → []（调用方省略 decisions 键）。"""
        req = {"action_requests": [{"name": "x"}], "review_configs": [
            {"action_name": "x", "allowed_decisions": ["approve"]},
            {"action_name": "y", "allowed_decisions": ["reject"]},
        ]}
        assert _hitl_allowed_decisions(req) == []
        assert _hitl_allowed_decisions({"action_requests": []}) == []

    def test_render_str_passthrough(self):
        prompt, options = _default_interrupt_render("继续吗？")
        assert prompt == "继续吗？" and options is None

    def test_render_dict_prompt_keys(self):
        for key in ("prompt", "question", "message"):
            prompt, options = _default_interrupt_render({key: f"ask-{key}", "x": 1})
            assert prompt == f"ask-{key}" and options is None

    def test_render_other_json_dump(self):
        """非字符串键 dict / 其它对象 → json.dumps(ensure_ascii=False) 截断。"""
        prompt, options = _default_interrupt_render({"foo": "bar", "n": 1})
        assert prompt == '{"foo": "bar", "n": 1}' and options is None
        prompt, _ = _default_interrupt_render({"big": "x" * 5000})
        assert len(prompt) <= 4100 and "truncated" in prompt

    def test_render_hitl_prompt_and_options(self):
        prompt, options = _default_interrupt_render(_HITL)
        assert "需要审批" in prompt and "send_email" in prompt and "delete_file" in prompt
        assert "可选" in prompt and "批准" in prompt and "修改" not in prompt
        assert options is not None
        assert options.decisions == ("approve", "reject")
        assert [a.name for a in options.actions] == ["send_email", "delete_file"]
        assert options.actions[0].args == {"to": "a@b.c", "body": "hi"}
        assert options.actions[0].description == "d1"


class TestResumeMappingHelpers:
    def test_approval_word_variants(self):
        """批准词表：大小写不敏感 + 首尾标点剥离。"""
        for text in ("批准", "同意", "可以", "确认", "approve", "APPROVE", "yes", "OK", "lgtm",
                     "批准。", " ok ", "yes!"):
            assert _is_approval_text(text), text
        for text in ("先别发", "批准了吗", "ok，发吧", "", "hmm"):
            assert not _is_approval_text(text), text

    def test_text_decision_approve(self):
        assert _hitl_text_decision("批准", _HITL) == {"type": "approve"}

    def test_text_decision_reject_with_verbatim_message(self):
        """非批准词 → reject + message=原文。"""
        assert _hitl_text_decision("先别发", _HITL) == {"type": "reject", "message": "先别发"}

    def test_text_decision_falls_back_to_respond(self):
        """reject 不在 allowed_decisions → respond(message=原文)。"""
        req = {
            "action_requests": [{"name": "ask"}],
            "review_configs": [{"action_name": "ask", "allowed_decisions": ["approve", "respond"]}],
        }
        assert _hitl_text_decision("随便你定", req) == {"type": "respond", "message": "随便你定"}

    def test_text_decision_no_allowed_raises(self):
        """reject/respond 都不可选 → GRAPH_INPUT_INVALID（不模糊放行）。"""
        req = {
            "action_requests": [{"name": "x"}],
            "review_configs": [{"action_name": "x", "allowed_decisions": ["approve"]}],
        }
        with pytest.raises(SarpError) as ei:
            _hitl_text_decision("hmm", req)
        assert ei.value.wire.code == "GRAPH_INPUT_INVALID"

    def test_hitl_resume_replicates_structured_decision(self):
        """decision approve 按 action_requests 数复制（2 条 → 2 份）。"""
        out = _hitl_resume(_turn_with_resume("【审批】批准", {"type": "approve"}), _HITL)
        assert out == {"decisions": [{"type": "approve"}, {"type": "approve"}]}

    def test_hitl_resume_edit_uses_action_name(self):
        """edit → edited_action.name 取该 action 的名字、args 来自 decision。"""
        out = _hitl_resume(
            _turn_with_resume("【审批】修改", {"type": "edit", "args": {"to": "n@x.y"}}),
            _HITL,
        )
        assert out == {
            "decisions": [
                {"type": "edit", "edited_action": {"name": "send_email", "args": {"to": "n@x.y"}}},
                {"type": "edit", "edited_action": {"name": "delete_file", "args": {"to": "n@x.y"}}},
            ]
        }

    def test_hitl_resume_unknown_decision_type_passthrough(self):
        """R-UF：未知 decision.type 原样下传（中间件报清晰错误）。"""
        out = _hitl_resume(
            _turn_with_resume("x", {"type": "defer", "message": "later"}), _HITL
        )
        assert out["decisions"][0] == {"type": "defer", "message": "later"}
