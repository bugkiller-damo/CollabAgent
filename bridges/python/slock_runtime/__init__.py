"""slock_runtime — Slock Agent Runtime Protocol (SARP/1) Python Worker SDK。

给「用户自建的 agent worker 进程」用的协议宿主：daemon 经 stdin/stdout
逐行 JSON 下发 initialize / turn.start / turn.cancel / shutdown，本 SDK 兜住
握手、帧编解码、序号纪律、回合状态机、幂等与 interrupt/resume——用户只需
把一个 LangChain chain / LangGraph CompiledStateGraph 交给 serve_* 入口。

最小用法：

    from slock_runtime import serve_langgraph
    raise SystemExit(serve_langgraph(graph_or_factory))

或裸协议层（非 LangChain/LangGraph runtime 自定义接入）：

    from slock_runtime import WorkerRuntime, TurnOutcome
    rt = WorkerRuntime(runtime_id="my-runtime")
    sys.exit(rt.serve(run_turn))

纪律：stdout 只属于协议帧；worker 日志一律 stderr。
"""

from __future__ import annotations

from .errors import SarpError, WireError, map_provider_error
from .idempotency import TurnJournal
from .protocol import (
    SARP_PROTOCOL,
    SARP_VERSION,
    SarpInitialize,
    SarpMcpDescriptor,
    SarpProtocolError,
    SarpResume,
    SarpShutdown,
    SarpTurnCancel,
    SarpTurnSource,
    SarpTurnStart,
)
from .runtime import InterruptRecord, TurnEmit, TurnOutcome, WorkerRuntime, new_resume_token
from .transport import SarpTransport

__version__ = "0.1.0"

__all__ = [
    "SARP_PROTOCOL",
    "SARP_VERSION",
    "SarpError",
    "SarpInitialize",
    "SarpMcpDescriptor",
    "SarpProtocolError",
    "SarpResume",
    "SarpShutdown",
    "SarpTransport",
    "SarpTurnCancel",
    "SarpTurnStart",
    "SarpTurnSource",
    "InterruptRecord",
    "TurnEmit",
    "TurnJournal",
    "TurnOutcome",
    "WireError",
    "WorkerRuntime",
    "map_provider_error",
    "new_resume_token",
    "serve",
    "serve_langchain",
    "serve_langgraph",
    "__version__",
]


def serve(run_turn, *, runtime_id: str, on_initialize=None, **runtime_kwargs) -> int:
    """裸协议入口：自带 run_turn(init, turn, emit, cancelled) -> TurnOutcome。"""
    rt = WorkerRuntime(runtime_id=runtime_id, **runtime_kwargs)
    return rt.serve(run_turn, on_initialize)


def __getattr__(name: str):
    # adapter 模块惰性加载——import slock_runtime 不要求装 langchain/langgraph
    if name == "serve_langgraph":
        from .langgraph import serve_langgraph

        return serve_langgraph
    if name == "serve_langchain":
        from .langchain import serve_langchain

        return serve_langchain
    raise AttributeError(name)
