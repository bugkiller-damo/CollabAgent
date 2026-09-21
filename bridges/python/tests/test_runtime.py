"""runtime.py 端到端：真实 os.pipe 驱动 WorkerRuntime 全生命周期。

覆盖：握手（requestId 回显/runtime.id/capabilities）、回合终态唯一性、
幂等回放（结束后重发同 turnId）、在跑重试丢弃、异 turnId 排队串行、
interrupt 签发→resume 消费→单次使用、cancel、shutdown、首帧拒绝、
handler 异常映射。
"""

from __future__ import annotations

import io
import json
import os
import threading
import time

from slock_runtime import InterruptRecord, TurnOutcome, WorkerRuntime, new_resume_token
from slock_runtime.errors import GRAPH_INPUT_INVALID
from slock_runtime.idempotency import TurnJournal
from slock_runtime.transport import SarpTransport


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


INIT = dict(
    requestId="req-1",
    agent={"id": "ag_1", "name": "bot"},
    runtime={"id": "langgraph", "entrypoint": "e1"},
    workspace={"path": "/tmp/slock-test-ws"},
    platform={"systemPrompt": "sys"},
    limits={"maxFrameBytes": 1048576, "silenceTimeoutMs": 300000},
)


def turn_fields(turn_id="t1", conv="conv-1", resume=None, **over):
    f = dict(
        turnId=turn_id,
        conversationId=conv,
        attempt=1,
        source={"kind": "channel", "channel": "general"},
        prompt="hi",
    )
    if resume:
        f["resume"] = resume
    f.update(over)
    return f


class Harness:
    """pipe 交互式 harness：逐帧写给 worker，轮询 stdout 帧。"""

    def __init__(self, tmp_path=None, journal: TurnJournal | None = None):
        r, w = os.pipe()
        self.stdin = os.fdopen(r, "rb")
        self.writer = os.fdopen(w, "wb")
        self.stdout = io.StringIO()
        self.transport = SarpTransport(stdin=self.stdin, stdout=self.stdout)
        self.journal = journal or (TurnJournal(str(tmp_path)) if tmp_path else None)
        self.exit_code: int | None = None
        self._thread: threading.Thread | None = None
        self._seq = 0

    def start(self, run_turn, on_initialize=None, **rt_kwargs) -> None:
        rt = WorkerRuntime(
            runtime_id=rt_kwargs.pop("runtime_id", "langgraph"),
            transport=self.transport,
            journal=self.journal,
            **rt_kwargs,
        )

        def _go():
            self.exit_code = rt.serve(run_turn, on_initialize)

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

    def wait_end(self, turn_id: str | None = None, timeout: float = 8.0, count: int = 1) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            ends = [f for f in self.frames() if f["type"] == "turn.end" and (turn_id is None or f["turnId"] == turn_id)]
            if len(ends) >= count:
                return ends[-1]
            time.sleep(0.01)
        raise AssertionError(f"no turn.end #{count} for {turn_id}")

    def finish(self, timeout: float = 8.0) -> int:
        import contextlib

        with contextlib.suppress(OSError):
            self.writer.close()
        if self._thread:
            self._thread.join(timeout)
        return self.exit_code if self.exit_code is not None else -1


def _ok(init, turn, emit, cancelled):
    emit.delta("hello ")
    emit.delta("world")
    emit.usage({"inputTokens": 2, "outputTokens": 3})
    usage = {"inputTokens": 2, "outputTokens": 3, "totalTokens": 5}
    return TurnOutcome(status="success", final_text="hello world", usage=usage)


class TestHandshake:
    def test_ready_echoes_request_id(self, tmp_path):
        h = Harness(tmp_path)
        h.start(_ok)
        h.send("initialize", **INIT)
        ready = h.wait_frame(lambda f: f["type"] == "runtime.ready")
        assert ready["requestId"] == "req-1" and ready["seq"] == 1
        assert ready["runtime"]["id"] == "langgraph"
        assert ready["capabilities"]["persistentProcess"] is True
        assert ready["capabilities"]["maxConcurrency"] == 1
        h.send("shutdown")
        assert h.wait_frame(lambda f: f["type"] == "runtime.stopped")
        assert h.finish() == 0

    def test_first_frame_not_initialize_rejected(self, tmp_path):
        h = Harness(tmp_path)
        h.start(_ok)
        h.send("turn.start", **turn_fields("t0"))
        err = h.wait_frame(lambda f: f["type"] == "runtime.error")
        assert err["error"]["code"] == "PROTOCOL_VIOLATION"
        assert h.finish() == 2

    def test_on_initialize_overrides_merge(self, tmp_path):
        def on_init(init, emit):
            return {"capabilities": {"durableThreads": True}, "model": {"selected": "m1", "overrides": True}}

        h = Harness(tmp_path)
        h.start(_ok, on_init)
        h.send("initialize", **INIT)
        ready = h.wait_frame(lambda f: f["type"] == "runtime.ready")
        assert ready["capabilities"]["durableThreads"] is True
        assert ready["model"] == {"selected": "m1", "overrides": True}
        h.finish()


class TestTurnLifecycle:
    def test_success_turn_frame_sequence(self, tmp_path):
        h = Harness(tmp_path)
        h.start(_ok)
        h.send("initialize", **INIT)
        h.wait_frame(lambda f: f["type"] == "runtime.ready")
        h.send("turn.start", **turn_fields("t1"))
        h.wait_end("t1")
        h.send("shutdown")
        h.finish()
        frames = h.frames()
        types = [f["type"] for f in frames]
        assert types == ["runtime.ready", "assistant.delta", "assistant.delta", "usage", "turn.end", "runtime.stopped"]
        end = frames[4]
        assert end["status"] == "success" and end["finalText"] == "hello world"
        assert [f["eventSeq"] for f in frames[1:5]] == [1, 2, 3, 4]
        assert [f["seq"] for f in frames] == list(range(1, len(frames) + 1))

    def test_handler_exception_maps_to_error_end(self, tmp_path):
        def boom(init, turn, emit, cancelled):
            raise ValueError("bad graph input")

        h = Harness(tmp_path)
        h.start(boom)
        h.send("initialize", **INIT)
        h.wait_frame(lambda f: f["type"] == "runtime.ready")
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        assert end["status"] == "error" and end["error"]["code"] == GRAPH_INPUT_INVALID
        h.finish()

    def test_replay_after_completion_skips_handler(self, tmp_path):
        calls = []

        def counting(init, turn, emit, cancelled):
            calls.append(turn.turn_id)
            return TurnOutcome(status="success", final_text="once")

        h = Harness(tmp_path)
        h.start(counting)
        h.send("initialize", **INIT)
        h.wait_frame(lambda f: f["type"] == "runtime.ready")
        h.send("turn.start", **turn_fields("tX"))
        e1 = h.wait_end("tX")
        # 终态后重发同一 turnId（daemon retry）→ 回放，handler 不重跑
        h.send("turn.start", **turn_fields("tX", attempt=2))
        e2 = h.wait_end("tX", count=2)
        assert e1["status"] == e2["status"] == "success" and e2["finalText"] == "once"
        assert calls == ["tX"]
        h.finish()

    def test_duplicate_turnid_while_active_dropped(self, tmp_path):
        calls = []
        started = threading.Event()

        def slow(init, turn, emit, cancelled):
            calls.append(turn.turn_id)
            started.set()
            time.sleep(0.3)
            return TurnOutcome(status="success", final_text="slow")

        h = Harness(tmp_path)
        h.start(slow)
        h.send("initialize", **INIT)
        h.wait_frame(lambda f: f["type"] == "runtime.ready")
        h.send("turn.start", **turn_fields("tA"))
        started.wait(5)
        h.send("turn.start", **turn_fields("tA", attempt=2))  # 在跑重试 → 丢弃
        end = h.wait_end("tA")
        assert end["status"] == "success"
        assert calls == ["tA"]
        assert len([f for f in h.frames() if f["type"] == "runtime.error"]) == 0
        h.finish()

    def test_different_turnid_queued_serially(self, tmp_path):
        order = []

        def rec(init, turn, emit, cancelled):
            order.append(("start", turn.turn_id))
            time.sleep(0.15)
            order.append(("end", turn.turn_id))
            return TurnOutcome(status="success", final_text=turn.turn_id)

        h = Harness(tmp_path)
        h.start(rec)
        h.send("initialize", **INIT)
        h.wait_frame(lambda f: f["type"] == "runtime.ready")
        h.send("turn.start", **turn_fields("t1"))
        h.send("turn.start", **turn_fields("t2"))  # 活跃期到达 → 排队
        e2 = h.wait_end("t2")
        assert e2["status"] == "success" and e2["finalText"] == "t2"
        # 严格串行：t1 结束后 t2 才开始
        assert order == [("start", "t1"), ("end", "t1"), ("start", "t2"), ("end", "t2")]
        h.finish()


class TestInterruptResume:
    def _interrupting(self, init, turn, emit, cancelled):
        rec = InterruptRecord(interrupt_id="int-1", resume_token=new_resume_token(), prompt="approve?")
        return TurnOutcome(status="interrupted", interrupt=rec)

    def test_interrupt_emits_consistent_preview_and_terminal(self, tmp_path):
        h = Harness(tmp_path)
        h.start(self._interrupting)
        h.send("initialize", **INIT)
        h.wait_frame(lambda f: f["type"] == "runtime.ready")
        h.send("turn.start", **turn_fields("t1"))
        end = h.wait_end("t1")
        assert end["status"] == "interrupted"
        prev = [f for f in h.frames() if f["type"] == "turn.interrupt"][0]
        # §8.6：预览↔终态三要素一致
        assert (prev["interruptId"], prev["resumeToken"], prev["prompt"]) == (
            end["interrupt"]["interruptId"],
            end["interrupt"]["resumeToken"],
            end["interrupt"]["prompt"],
        )
        h.finish()

    def test_resume_roundtrip_and_single_use(self, tmp_path):
        journal = TurnJournal(str(tmp_path))
        h = Harness(journal=journal)
        h.start(self._interrupting)
        h.send("initialize", **INIT)
        h.wait_frame(lambda f: f["type"] == "runtime.ready")
        h.send("turn.start", **turn_fields("t-int"))
        end = h.wait_end("t-int")
        token = end["interrupt"]["resumeToken"]
        int_id = end["interrupt"]["interruptId"]

        resumed = []

        def resume_handler(init, turn, emit, cancelled):
            resumed.append(turn.resume.value if turn.resume else None)
            return TurnOutcome(status="success", final_text="resumed")

        h2 = Harness(journal=journal)
        h2.start(resume_handler)
        h2.send("initialize", **INIT)
        h2.wait_frame(lambda f: f["type"] == "runtime.ready")
        h2.send(
            "turn.start",
            **turn_fields("t-resume", resume={"interruptId": int_id, "resumeToken": token, "value": "yes"}),
        )
        e = h2.wait_end("t-resume")
        assert e["status"] == "success" and resumed == ["yes"]

        # 同一 token 复用 → PROTOCOL_VIOLATION
        h2.send(
            "turn.start",
            **turn_fields("t-reuse", resume={"interruptId": int_id, "resumeToken": token, "value": "again"}),
        )
        e2 = h2.wait_end("t-reuse")
        assert e2["status"] == "error" and e2["error"]["code"] == "PROTOCOL_VIOLATION"
        h.finish()
        h2.finish()

    def test_unknown_resume_rejected(self, tmp_path):
        h = Harness(tmp_path)
        h.start(_ok)
        h.send("initialize", **INIT)
        h.wait_frame(lambda f: f["type"] == "runtime.ready")
        h.send("turn.start", **turn_fields("t1", resume={"interruptId": "i", "resumeToken": "ghost", "value": "v"}))
        end = h.wait_end("t1")
        assert end["error"]["code"] == "PROTOCOL_VIOLATION"
        h.finish()


class TestCancelShutdown:
    def test_cancel_cooperative(self, tmp_path):
        def slow(init, turn, emit, cancelled):
            for _ in range(400):
                if cancelled.is_set():
                    return TurnOutcome(status="cancelled")
                time.sleep(0.005)
            return TurnOutcome(status="success", final_text="finished")

        h = Harness(tmp_path)
        h.start(slow)
        h.send("initialize", **INIT)
        h.wait_frame(lambda f: f["type"] == "runtime.ready")
        h.send("turn.start", **turn_fields("tc"))
        time.sleep(0.05)
        h.send("turn.cancel", turnId="tc", reason="user")
        end = h.wait_end("tc")
        assert end["status"] == "cancelled"
        h.finish()

    def test_eof_ends_cleanly(self, tmp_path):
        h = Harness(tmp_path)
        h.start(_ok)
        h.send("initialize", **INIT)
        h.wait_frame(lambda f: f["type"] == "runtime.ready")
        assert h.finish() == 0
        assert h.frames()[-1]["type"] == "runtime.stopped"
