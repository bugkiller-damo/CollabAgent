"""WorkerRuntime：SARP/1 worker 主循环。

生命周期（§8）：
  stdin initialize → on_initialize() 构建 graph/tools → runtime.ready（回显
  requestId + runtime.id + capabilities + model）→ 逐 turn.start 串行回合
  → turn.cancel 协作取消 → shutdown → runtime.stopped → 退出。

并发模型：
- 主线程**始终**阻塞读 stdin——这样 turn.cancel / shutdown 在回合进行中
  仍然可达；
- turn handler 跑在 daemon 线程里，自己经 TurnEmit 发流事件和唯一终态
  turn.end（transport 写锁保证帧不交错）；
- maxConcurrency=1 的语义下 daemon 不会并发派发第二个 turn.start；
  若真收到则按 protocol violation 拒绝；
- cancel 经 threading.Event 协作传递——LangGraph/LangChain 无法强杀，
  adapter 在事件循环里查 cancelled 标志。

回合纪律（镜像 daemon 侧状态机）：
- eventSeq 从 1 起单调递增；每回合恰好一个 turn.end；
- interrupted 终态必须有匹配的 turn.interrupt 预览（§8.6）——本层在
  终态前自动补发/纠发预览帧，保证预览↔终态三要素一致；
- error 终态必须带 error；
- turnId 幂等：journal 有记录 → 直接回放终态帧，不重跑 handler（§15.4）；
- resume token 单次使用：consume 失败 → PROTOCOL_VIOLATION 终态（§11.4）。
"""

from __future__ import annotations

import contextlib
import secrets
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ._version import BRIDGE_VERSION
from .errors import PROTOCOL_VIOLATION, WireError, map_provider_error
from .idempotency import TurnJournal, TurnJournalEntry
from .protocol import (
    SarpInitialize,
    SarpProtocolError,
    SarpShutdown,
    SarpTurnCancel,
    SarpTurnStart,
)
from .transport import SarpTransport


@dataclass(frozen=True)
class InterruptRecord:
    interrupt_id: str
    resume_token: str
    prompt: str
    payload: Any = None


@dataclass(frozen=True)
class TurnOutcome:
    """回合终态。handler 返回它，runtime 落成唯一 turn.end。"""

    status: str = "success"  # success / interrupted / cancelled / error
    final_text: str | None = None
    session_ref: str | None = None
    usage: dict | None = None
    interrupt: InterruptRecord | None = None
    error: WireError | None = None


class TurnEmit:
    """回合内流事件发射口。所有方法线程安全（transport 写锁 + seq 锁）。"""

    def __init__(self, transport: SarpTransport, turn_id: str):
        self._t = transport
        self.turn_id = turn_id
        self._event_seq = 0
        self._seq_lock = threading.Lock()
        self.last_interrupt: InterruptRecord | None = None

    def _next(self) -> int:
        with self._seq_lock:
            self._event_seq += 1
            return self._event_seq

    def delta(self, text: str) -> None:
        self._t.send("assistant.delta", turnId=self.turn_id, eventSeq=self._next(), text=text)

    def message(self, text: str) -> None:
        self._t.send("assistant.message", turnId=self.turn_id, eventSeq=self._next(), text=text)

    def progress(self, message: str) -> None:
        self._t.send("assistant.progress", turnId=self.turn_id, eventSeq=self._next(), message=message)

    def tool_start(
        self,
        call_id: str,
        name: str,
        *,
        provider: str | None = None,
        operation: str | None = None,
        input: Any = None,
    ) -> None:
        tool: dict = {"name": name}
        if provider is not None:
            tool["provider"] = provider
        if operation is not None:
            tool["operation"] = operation
        self._t.send(
            "tool.start",
            turnId=self.turn_id,
            eventSeq=self._next(),
            callId=call_id,
            tool=tool,
            input=input,
        )

    def tool_end(
        self,
        call_id: str,
        ok: bool,
        *,
        name: str | None = None,
        provider: str | None = None,
        operation: str | None = None,
        output: Any = None,
        error: str | None = None,
    ) -> None:
        tool: dict = {}
        if name is not None:
            tool["name"] = name
        if provider is not None:
            tool["provider"] = provider
        if operation is not None:
            tool["operation"] = operation
        self._t.send(
            "tool.end",
            turnId=self.turn_id,
            eventSeq=self._next(),
            callId=call_id,
            tool=tool,
            ok=ok,
            output=output,
            error=error,
        )

    def usage(self, usage: dict) -> None:
        self._t.send("usage", turnId=self.turn_id, eventSeq=self._next(), usage=usage)

    def interrupt(self, record: InterruptRecord) -> None:
        """turn.interrupt 预览帧——记录供终态一致性校验（§8.6）。"""
        self.last_interrupt = record
        self._t.send(
            "turn.interrupt",
            turnId=self.turn_id,
            eventSeq=self._next(),
            interruptId=record.interrupt_id,
            resumeToken=record.resume_token,
            prompt=record.prompt,
            payload=record.payload,
        )


# handler 签名：run_turn(init, turn, emit, cancelled) -> TurnOutcome
RunTurn = Callable[[SarpInitialize, SarpTurnStart, "TurnEmit", threading.Event], TurnOutcome]
# on_initialize 可选：返回 {"capabilities": {...}, "model": {...}} 合并进 ready
OnInitialize = Callable[[SarpInitialize, "TurnEmit"], dict | None]


def new_resume_token() -> str:
    return secrets.token_hex(24)


def _wire_to_dict(w: WireError) -> dict:
    """journal 内部存 snake_case（与 WireError 字段同名，回放可直接重建）。"""
    return {
        "code": w.code,
        "message": w.message,
        "retryable": w.retryable,
        "retry_after_ms": w.retry_after_ms,
    }


def _wire_from_dict(d: dict) -> WireError:
    return WireError(
        code=d["code"],
        message=d["message"],
        retryable=d.get("retryable"),
        retry_after_ms=d.get("retry_after_ms"),
    )


class WorkerRuntime:
    """协议正确的最小 worker 宿主。adapter 通过 on_initialize/run_turn 接入。"""

    def __init__(
        self,
        *,
        runtime_id: str,
        framework_version: str | None = None,
        bridge_version: str | None = None,
        capabilities: dict | None = None,
        model_selected: str | None = None,
        model_overrides: bool | None = None,
        probe_model: dict | None = None,
        transport: SarpTransport | None = None,
        journal: TurnJournal | None = None,
    ):
        self.runtime_id = runtime_id
        self.framework_version = framework_version
        self.bridge_version = bridge_version or BRIDGE_VERSION
        self.capabilities = capabilities or {}
        self.model_selected = model_selected
        self.model_overrides = model_overrides
        self.probe_model = probe_model if probe_model is not None else {}
        self.transport = transport or SarpTransport()
        self._journal = journal
        self._cancel_event: threading.Event | None = None
        self._handler_thread: threading.Thread | None = None
        self._active_turn_id: str | None = None
        self._pending_turns: list[SarpTurnStart] = []
        # 活跃判定+排队+排水的互斥：_start_turn 跑在主线程，
        # _drain_pending 跑在 handler 收尾线程——不加锁可能双 spawn
        self._turn_lock = threading.Lock()
        self._shutdown = False
        self._run_turn: RunTurn | None = None

    # ---------------- 主循环 ----------------

    def _resolved_capabilities(self) -> dict:
        """probe 与 runtime.ready 共用的基线能力集。握手期 on_initialize 返回的
        overrides 在 ready 上继续 merge；probe 期无 initialize，基线即全貌。"""
        return {"persistentProcess": True, "maxConcurrency": 1, "pty": False, **self.capabilities}

    def serve(self, run_turn: RunTurn, on_initialize: OnInitialize | None = None) -> int:
        """阻塞跑完整个生命周期，返回进程退出码。"""
        # §8.4：--slock-probe 单行 probe.result 即退——必须跑在读 stdin、开
        # journal、调 on_initialize、建 graph/model、起 MCP 之前（probe 环境是
        # 最小 env，框架/模型依赖可能不可用）。
        if "--slock-probe" in sys.argv[1:]:
            self.transport.send(
                "probe.result",
                probe=True,
                runtime={
                    "id": self.runtime_id,
                    "frameworkVersion": self.framework_version,
                    "bridgeVersion": self.bridge_version,
                },
                capabilities=self._resolved_capabilities(),
                model=self.probe_model,
            )
            return 0

        self._run_turn = run_turn
        t = self.transport

        try:
            init = self._read_initialize()
        except SarpProtocolError as e:
            with contextlib.suppress(Exception):
                t.send(
                    "runtime.error",
                    error={
                        "code": "PROTOCOL_VIOLATION",
                        "message": f"initialize rejected: {e}",
                        "retryable": False,
                    },
                )
            return 2
        if init is None:
            return 2

        if self._journal is None:
            self._journal = TurnJournal(init.workspace_path)

        # 握手期 warning 通道（turnId 未定，用占位符——warning 帧不校验 turnId）
        boot_emit = TurnEmit(t, "__init__")
        try:
            overrides = on_initialize(init, boot_emit) if on_initialize else None
        except Exception as exc:
            w = map_provider_error(exc)
            t.send(
                "runtime.error",
                requestId=init.request_id,
                error={
                    "code": w.code,
                    "message": w.message,
                    "retryable": w.retryable if w.retryable is not None else False,
                    **({"retryAfterMs": w.retry_after_ms} if w.retry_after_ms else {}),
                },
            )
            return 2

        caps = self._resolved_capabilities()
        if overrides and overrides.get("capabilities"):
            caps.update(overrides["capabilities"])
        model_field: dict = {}
        if overrides and overrides.get("model"):
            model_field.update(overrides["model"])
        if self.model_selected is not None:
            model_field.setdefault("selected", self.model_selected)
        if self.model_overrides is not None:
            model_field.setdefault("overrides", self.model_overrides)

        t.send(
            "runtime.ready",
            requestId=init.request_id,
            runtime={
                "id": self.runtime_id,
                "frameworkVersion": self.framework_version,
                "bridgeVersion": self.bridge_version,
            },
            capabilities=caps,
            model=model_field or None,
        )

        while not self._shutdown:
            try:
                msg = t.read_message()
            except SarpProtocolError as e:
                t.send(
                    "runtime.error",
                    error={
                        "code": "PROTOCOL_VIOLATION",
                        "message": f"inbound frame rejected: {e}",
                        "retryable": False,
                    },
                )
                return 2
            if msg is None:  # daemon 关了 stdin
                break
            if isinstance(msg, SarpTurnStart):
                self._start_turn(init, msg)
            elif isinstance(msg, SarpTurnCancel):
                if self._cancel_event is not None and (
                    msg.turn_id is None or msg.turn_id == self._active_turn_id
                ):
                    self._cancel_event.set()
            elif isinstance(msg, SarpShutdown):
                self._shutdown = True
                if self._cancel_event is not None:
                    self._cancel_event.set()
                if self._handler_thread is not None:
                    self._handler_thread.join(timeout=(msg.timeout_ms or 5000) / 1000)
                # 排队中的回合统一 cancelled 终态（§8.8 干净收尾）
                with self._turn_lock:
                    self._drain_pending(init)

        # 退出前若还有 handler 在跑，给它一个短暂收尾窗口
        if self._handler_thread is not None and self._handler_thread.is_alive():
            self._handler_thread.join(timeout=2.0)
        with contextlib.suppress(Exception):
            t.send("runtime.stopped", reason="shutdown")
        if self._journal:
            self._journal.close()
        return 0

    # ---------------- 回合调度 ----------------

    def _read_initialize(self) -> SarpInitialize | None:
        """首帧必须是 initialize（§8.2）；启动超时由 daemon startupMs 兜底。"""
        msg = self.transport.read_message()
        if msg is None:
            return None
        if isinstance(msg, SarpInitialize):
            return msg
        print(f"[slock_runtime] frame before initialize: {type(msg).__name__}", file=sys.stderr)
        raise SarpProtocolError("unexpected-message", "first frame must be initialize")

    def _start_turn(self, init: SarpInitialize, turn: SarpTurnStart) -> None:
        emit = TurnEmit(self.transport, turn.turn_id)
        journal = self._journal

        # §15.4：turnId 幂等——已完成回合直接回放终态（不受活跃回合约束，
        # 回放只是发一帧已存终态，不占并发槽）
        if journal is not None:
            prior = journal.lookup(turn.turn_id)
            if prior is not None:
                self._emit_turn_end(
                    emit,
                    TurnOutcome(
                        status=prior.status,
                        final_text=prior.final_text,
                        session_ref=prior.session_ref,
                        usage=prior.usage,
                        interrupt=InterruptRecord(**prior.interrupt) if prior.interrupt else None,
                        error=_wire_from_dict(prior.error) if prior.error else None,
                    ),
                )
                return

        # maxConcurrency=1 语义下的防御性串行化：
        # - 同 turnId 在跑 → 重试到达，在跑回合的 turn.end 即其终态，丢弃；
        # - 不同 turnId → 排队，回合串行执行（正常路径 daemon 不会并发派发）。
        with self._turn_lock:
            if self._active_turn_id is not None:
                if turn.turn_id != self._active_turn_id:
                    self._pending_turns.append(turn)
                return
            self._spawn_turn(init, turn)

    def _spawn_turn(self, init: SarpInitialize, turn: SarpTurnStart) -> None:
        emit = TurnEmit(self.transport, turn.turn_id)
        journal = self._journal

        # §11.4：resume token 校验挪到 spawn 时——排队回合不提前烧 token
        if turn.resume is not None:
            rec = (
                journal.consume_resume_token(turn.resume.resume_token, turn.conversation_id)
                if journal
                else None
            )
            if rec is None or rec.interrupt_id != turn.resume.interrupt_id:
                self._emit_turn_end(
                    emit,
                    TurnOutcome(
                        status="error",
                        error=WireError(
                            PROTOCOL_VIOLATION,
                            f"resume token rejected for turn {turn.turn_id}",
                            retryable=False,
                        ),
                    ),
                )
                self._drain_pending(init)
                return

        cancel = threading.Event()
        self._cancel_event = cancel
        self._active_turn_id = turn.turn_id  # 调用方已持 _turn_lock
        run_turn = self._run_turn

        def _invoke() -> None:
            try:
                outcome = run_turn(init, turn, emit, cancel) if run_turn else TurnOutcome(
                    status="error",
                    error=WireError(PROTOCOL_VIOLATION, "no turn handler bound", retryable=False),
                )
            except Exception as exc:
                outcome = TurnOutcome(status="error", error=map_provider_error(exc))
            if cancel.is_set() and outcome.status == "success":
                outcome = TurnOutcome(status="cancelled", session_ref=outcome.session_ref)
            if journal is not None:
                # interrupted 终态：签发 resume token（§11.4 单次使用由 consume 侧保证）
                if outcome.status == "interrupted" and outcome.interrupt is not None:
                    # 重放路径可能撞上已签发 token——幂等吞掉
                    with contextlib.suppress(Exception):
                        journal.issue_resume_token(
                            outcome.interrupt.resume_token,
                            outcome.interrupt.interrupt_id,
                            turn.conversation_id,
                        )
                # 先落 journal 再发终态帧：崩溃重试走回放，不重跑 handler
                journal.record(
                    TurnJournalEntry(
                        turn_id=turn.turn_id,
                        status=outcome.status,
                        final_text=outcome.final_text,
                        session_ref=outcome.session_ref,
                        usage=outcome.usage,
                        interrupt=outcome.interrupt.__dict__ if outcome.interrupt else None,
                        error=_wire_to_dict(outcome.error) if outcome.error else None,
                    ),
                )
            self._emit_turn_end(emit, outcome)
            with self._turn_lock:
                self._active_turn_id = None
                self._cancel_event = None
                self._drain_pending(init)

        self._handler_thread = threading.Thread(target=_invoke, daemon=True, name=f"turn-{turn.turn_id[:12]}")
        self._handler_thread.start()

    def _drain_pending(self, init: SarpInitialize) -> None:
        """回合收尾后串行执行排队回合；shutdown 中统一发 cancelled。"""
        while self._pending_turns:
            nxt = self._pending_turns.pop(0)
            if self._shutdown:
                self._emit_turn_end(
                    TurnEmit(self.transport, nxt.turn_id),
                    TurnOutcome(status="cancelled"),
                )
                continue
            self._spawn_turn(init, nxt)
            return  # spawn 后由下一回合的收尾继续排水

    # ---------------- 终态帧 ----------------

    def _emit_turn_end(self, emit: TurnEmit, outcome: TurnOutcome) -> None:
        # §8.6：interrupted 终态的 interrupt 三要素必须匹配最近一次预览——
        # 不一致时先补发/纠发预览帧，保证 daemon 侧校验通过
        if (
            outcome.status == "interrupted"
            and outcome.interrupt is not None
            and emit.last_interrupt != outcome.interrupt
        ):
            emit.interrupt(outcome.interrupt)
        fields: dict[str, Any] = {"status": outcome.status}
        if outcome.final_text is not None:
            fields["finalText"] = outcome.final_text
        if outcome.session_ref is not None:
            fields["sessionRef"] = outcome.session_ref
        if outcome.usage is not None:
            fields["usage"] = outcome.usage
        if outcome.interrupt is not None:
            fields["interrupt"] = {
                "interruptId": outcome.interrupt.interrupt_id,
                "resumeToken": outcome.interrupt.resume_token,
                "prompt": outcome.interrupt.prompt,
                "payload": outcome.interrupt.payload,
            }
        if outcome.error is not None:
            fields["error"] = outcome.error.to_dict()
        self.transport.send("turn.end", turnId=emit.turn_id, eventSeq=emit._next(), **fields)
