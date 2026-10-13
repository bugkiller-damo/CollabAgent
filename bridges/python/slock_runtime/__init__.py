"""slock_runtime — Slock Agent Runtime Protocol (SARP/1) Python Worker SDK。

给「用户自建的 agent worker 进程」用的协议宿主：daemon 经 stdin/stdout
逐行 JSON 下发 initialize / turn.start / turn.cancel / shutdown，本 SDK 兜住
握手、帧编解码、序号纪律、回合状态机、幂等与 interrupt/resume——用户只需
把一个 LangChain chain / LangGraph CompiledStateGraph 交给 serve_* 入口。

最小用法（WP8 起推荐统一入口 `serve_agent`——按对象类型自动分派
CompiledStateGraph / LangChain Runnable / 工厂）：

    from slock_runtime import serve_agent
    raise SystemExit(serve_agent(agent_or_factory))

或裸协议层（非 LangChain/LangGraph runtime 自定义接入）：

    from slock_runtime import WorkerRuntime, TurnOutcome
    rt = WorkerRuntime(runtime_id="my-runtime")
    sys.exit(rt.serve(run_turn))

纪律：stdout 只属于协议帧；worker 日志一律 stderr。

公开 API 分层（发布承诺见 README「API 稳定性」）：
- stable（语义化版本内保持向后兼容）：serve_agent、SlockStructuredTool、
  serve_langchain、serve_langgraph（两者为 serve_agent 的强制路径别名）、
  SARP_PROTOCOL、SARP_VERSION、__version__；
- advanced（自建 runtime 可用，签名仍可能演进）：serve、WorkerRuntime、
  TurnOutcome、TurnEmit、TurnJournal、InterruptRecord、SarpTransport、
  协议 dataclass 与错误类型；
- internal：其余子模块与内部 helper——未列入 __all__ 即不受兼容承诺。
"""

from __future__ import annotations

from typing import Any

from ._version import __version__
from .errors import SarpError, WireError, map_provider_error
from .idempotency import TurnJournal
from .protocol import (
    SARP_PROTOCOL,
    SARP_VERSION,
    SarpAttachment,
    SarpInitialize,
    SarpInterruptAction,
    SarpInterruptOptions,
    SarpMcpDescriptor,
    SarpProtocolError,
    SarpResume,
    SarpResumeDecision,
    SarpShutdown,
    SarpTurnCancel,
    SarpTurnMessage,
    SarpTurnSource,
    SarpTurnStart,
)
from .runtime import (
    InterruptRecord,
    OnInitialize,
    RunTurn,
    TurnEmit,
    TurnOutcome,
    WorkerRuntime,
    new_resume_token,
)
from .transport import SarpTransport

__all__ = [
    "SARP_PROTOCOL",
    "SARP_VERSION",
    "SarpAttachment",
    "SarpError",
    "SarpInitialize",
    "SarpInterruptAction",
    "SarpInterruptOptions",
    "SarpMcpDescriptor",
    "SarpProtocolError",
    "SarpResume",
    "SarpResumeDecision",
    "SarpShutdown",
    "SarpTransport",
    "SarpTurnCancel",
    "SarpTurnMessage",
    "SarpTurnStart",
    "SarpTurnSource",
    "SlockStructuredTool",
    "InterruptRecord",
    "TurnEmit",
    "TurnJournal",
    "TurnOutcome",
    "WireError",
    "WorkerRuntime",
    "map_provider_error",
    "new_resume_token",
    "serve",
    "serve_agent",
    "serve_langchain",
    "serve_langgraph",
    "__version__",
]


def serve(
    run_turn: RunTurn,
    *,
    runtime_id: str,
    on_initialize: OnInitialize | None = None,
    **runtime_kwargs: Any,
) -> int:
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
    if name == "serve_agent":
        from .agent import serve_agent

        return serve_agent
    if name == "SlockStructuredTool":
        from .agent import _tool_class
        from .errors import SarpError

        try:
            return _tool_class()
        except SarpError as e:  # 无 langchain-core 的裸协议环境
            raise ImportError("SlockStructuredTool requires langchain-core") from e
    raise AttributeError(name)
