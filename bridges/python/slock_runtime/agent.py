"""serve_agent 统一入口 + 共享内核（WP8 §8.1–8.5）。

一个入口按**对象类型**分派（DEC-9：真实边界是「是否有状态图」，不是框架名）：

1. **工厂**：callable 且不是图 / Runnable → `factory(init, tools)`；
   `async def` 工厂返回 awaitable，在常驻事件循环上执行（§8.3）。
2. **图路径**：`isinstance(obj, langgraph.pregel.Pregel)` → langgraph.py
   执行循环。编译后图同时也是 Runnable——**必须先判图**。
3. **Runnable 路径**：具备 `astream_events` / `ainvoke` / `invoke` →
   langchain.py 执行循环（无状态）。
4. 其它 → 握手期 `GRAPH_INPUT_INVALID`（消息带对象类型名）。

`serve_langgraph` / `serve_langchain` 保留签名，内部走 `_serve_impl` 加
`force_path`——旧入口全部语义（含鸭子类型图）不变，文档推荐 `serve_agent`。

共享内核面：
- 握手：runtime.id 归一比对、`workspace_cwd` chdir、Slock MCP client、
  统一工具构建（两路径都拿到 `list[SlockStructuredTool]`，§8.2）、
  dispatch 后的能力上报（图路径按 checkpointer；Runnable 路径
  interrupts:false / durableThreads:false）。
- §8.4 输入校验：默认 input mapper + 图输入 schema 无 `messages` 键 →
  握手期 `GRAPH_INPUT_INVALID`（取代旧运行期 `WORKER_ERROR 'question'`）。
- §8.3 常驻事件循环 `_AsyncLoop`：worker 生命周期内一个后台线程 + loop，
  async 图 / Runnable / async 工厂都经 `run_coroutine_threadsafe` 提交——
  AsyncSqliteSaver / aiosqlite 等资源绑定创建它们的 loop，跨 loop 复用
  会失败，所以绝不每回合 `asyncio.run`。turn.cancel 时
  `future.cancel()` 桥成 loop 线程上的 `task.cancel()`。

纪律：
- 模块零框架依赖——langchain_core / langgraph 一律函数内惰性 import，
  `import slock_runtime`（及 `.agent`）在裸协议环境下也必须可用。
  `SlockStructuredTool` 类对象按需构造（要 StructuredTool 基类），经模块
  `__getattr__` 暴露。
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import inspect
import os
import threading
import warnings
from collections.abc import Callable
from typing import Any, Literal

from . import langchain as _runnable_path
from . import langgraph as _graph_path
from .errors import (
    CWD_NOT_FOUND,
    GRAPH_INPUT_INVALID,
    MCP_START_FAILED,
    PROTOCOL_VIOLATION,
    RUNTIME_ID_MISMATCH,
    SarpError,
)
from .mcp import SlockMcpClient
from .protocol import SarpInitialize, SarpTurnStart, normalize_runtime_id
from .runtime import RunTurn, TurnEmit, TurnOutcome, WorkerRuntime

# ---------------------------------------------------------------------------
# SlockStructuredTool（§8.2 统一工具类型）
# ---------------------------------------------------------------------------

_TOOL_CLS: type | None = None


def _tool_class() -> type:
    """SlockStructuredTool 类对象——首次调用才 import langchain_core。

    惰性构造保住零依赖纪律：裸协议 env（无 extras）下 `import
    slock_runtime.agent` 与 `serve_agent` 可用；只有真建 MCP 工具或显式取
    `slock_runtime.SlockStructuredTool` 时才需要 langchain-core。
    """
    global _TOOL_CLS
    if _TOOL_CLS is None:
        try:
            from langchain_core.tools import StructuredTool
        except ImportError as e:
            raise SarpError(
                MCP_START_FAILED,
                "SlockStructuredTool requires langchain-core "
                "(pip install 'slock-runtime[langchain]')",
                retryable=False,
            ) from e

        with warnings.catch_warnings():
            # pydantic 对遮蔽父类属性的字段发 UserWarning——`call` 是刻意的
            # 旧 SlockTool 兼容面。
            warnings.simplefilter("ignore")

            class SlockStructuredTool(StructuredTool):
                """Slock MCP 工具的统一类型（§8.2）。

                `StructuredTool` 子类——LangChain/LangGraph 工厂代码照旧
                （`t.invoke(dict)`、`bind_tools(tools)`、`t.args_schema`）。
                额外保留旧 `SlockTool` 兼容面：`input_schema` 为 MCP
                inputSchema 原样 dict（`BaseTool.input_schema` 是返回动态
                schema 类的 property——这里覆盖成 dict 视图，invoke 走
                `args_schema`/`get_input_schema()` 不受影响）、
                `call(args) -> str` 直调。

                `metadata={"slock": True, "operation": name}`——tool.start /
                tool.end 的 provider/operation 判定优先读它（WP1/§8.2）。
                """

                slock_input_schema: dict = {}
                call: Callable[[dict], str] | None = None

                # §7 H6：刻意遮蔽基类签名——对外呈现原样 MCP inputSchema dict；
                # invoke 与 args_schema/get_input_schema 不受影响（见类 docstring）
                @property
                def input_schema(self) -> dict:  # type: ignore[override]
                    """旧 SlockTool 兼容面：MCP inputSchema 原样 dict。"""
                    return self.slock_input_schema

        _TOOL_CLS = SlockStructuredTool
    return _TOOL_CLS


def __getattr__(name: str):
    # `from slock_runtime.agent import SlockStructuredTool` 同样惰性解析
    if name == "SlockStructuredTool":
        return _tool_class()
    raise AttributeError(name)


def _load_slock_tools(client: SlockMcpClient) -> list:
    """McpToolInfo → list[SlockStructuredTool]；所有 tool 复用同一 client。"""
    cls = _tool_class()
    tools = []
    for info in client.list_tools():

        def _bind(name: str):  # 闭包固化 tool 名，避免 late-binding
            def _call(**kwargs):
                return client.call_tool(name, kwargs)

            return _call

        def _bind_call(name: str):
            def _call(args: dict) -> str:
                return client.call_tool(name, dict(args or {}))

            return _call

        tools.append(
            cls(
                name=info.name,
                description=info.description or info.name,
                args_schema=info.input_schema or {"type": "object", "properties": {}},
                func=_bind(info.name),
                slock_input_schema=info.input_schema or {},
                call=_bind_call(info.name),
                metadata={"slock": True, "operation": info.name},
            )
        )
    return tools


def _tool_ops(tools: list) -> dict[str, str]:
    """工具注册表：名 → operation（metadata 优先，缺省回退名字——§8.2/WP1）。

    下发工具集本就只含 Slock MCP 工具——metadata 缺席时按名兜底（与旧
    frozenset 形态同语义），出席时以 metadata.operation 为权威。
    """
    ops: dict[str, str] = {}
    for t in tools:
        md = getattr(t, "metadata", None)
        op = md.get("operation") if isinstance(md, dict) and md.get("slock") else None
        ops[t.name] = str(op) if op else t.name
    return ops


# ---------------------------------------------------------------------------
# 常驻事件循环（§8.3）
# ---------------------------------------------------------------------------


class _AsyncLoop:
    """worker 生命周期内唯一的常驻事件循环：后台线程 + 单个 asyncio loop。

    回合协程经 `asyncio.run_coroutine_threadsafe` 提交，绝不每回合
    `asyncio.run`——AsyncSqliteSaver / aiosqlite 这类资源绑定创建它们的
    loop，跨 loop 复用会失败。

    cancel：`future.cancel()` 经 `_chain_future` 桥成 loop 线程上的
    `task.cancel()`（线程安全）；handler 同时保留逐事件 `cancelled.is_set()`
    检查（与旧行为一致）。任务收尾必须等其真正结束再返回——否则残余
    emit 会在 turn.end 之后继续写帧，污染协议。
    """

    def __init__(self) -> None:
        self._loop = asyncio.new_event_loop()
        self._started = threading.Event()
        self._closed = False
        self._thread = threading.Thread(target=self._main, daemon=True, name="slock-async-loop")
        self._thread.start()
        self._started.wait(timeout=10)

    def _main(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._started.set()
        self._loop.run_forever()
        # loop.stop 之后排水：取消残余任务再关 loop
        pending = [t for t in asyncio.all_tasks(self._loop) if not t.done()]
        for t in pending:
            t.cancel()
        if pending:
            with contextlib.suppress(Exception):
                self._loop.run_until_complete(asyncio.wait(pending, timeout=2))
        self._loop.close()

    def submit(self, coro) -> concurrent.futures.Future:
        """提交协程；返回 concurrent.futures.Future（cancel() → task.cancel()）。"""
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    def run(self, coro, cancelled: threading.Event | None = None) -> Any:
        """跑协程到完成：返回其结果或抛其异常。

        cancelled 置位 → `future.cancel()`（→ `task.cancel()`）并继续轮询
        直到协程收尾；协程被取消 → 抛 `asyncio.CancelledError`。
        """
        future = self.submit(coro)
        while True:
            try:
                return future.result(timeout=0.05 if cancelled is not None else None)
            except concurrent.futures.TimeoutError:
                if cancelled is not None and cancelled.is_set():
                    future.cancel()  # 幂等；已起跑则桥成 task.cancel()
            except concurrent.futures.CancelledError:
                raise asyncio.CancelledError from None

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(Exception):
            self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)


# ---------------------------------------------------------------------------
# 分派
# ---------------------------------------------------------------------------


def _is_pregel(obj: Any) -> bool:
    try:
        from langgraph.pregel import Pregel  # 惰性导入：无 langgraph 不致命
    except Exception:
        return False
    return isinstance(obj, Pregel)


def _is_runnable(obj: Any) -> bool:
    return any(hasattr(obj, m) for m in ("astream_events", "ainvoke", "invoke"))


def _dispatch(obj: Any) -> str:
    """auto 分派（§8.1）：先图后 Runnable——编译图同时也是 Runnable。"""
    if _is_pregel(obj):
        return "graph"
    if _is_runnable(obj):
        return "runnable"
    raise SarpError(
        GRAPH_INPUT_INVALID,
        f"unsupported agent object type {type(obj).__name__!r}: pass a compiled "
        "LangGraph graph (langgraph.pregel.Pregel), a LangChain Runnable "
        "(astream_events/ainvoke/invoke), or a factory(init, tools)",
        retryable=False,
    )


def _static_path(obj: Any) -> str | None:
    """probe 期的静态分派（不 raise）——非 callable 对象才判得出来。"""
    if callable(obj):
        return None
    if _is_pregel(obj):
        return "graph"
    if _is_runnable(obj):
        return "runnable"
    return None


async def _await_result(awaitable: Any) -> Any:
    return await awaitable


# ---------------------------------------------------------------------------
# 公开入口
# ---------------------------------------------------------------------------


def serve_agent(
    agent_or_factory: Any,
    *,
    input_mapper=None,
    output_mapper=None,
    interrupt_mapper=None,
    resume_mapper=None,
    custom_event_mapper=None,
    usage_extractor=None,
    cost_calculator=None,
    system_prompt_mode: Literal["prepend", "none"] = "prepend",
    execution: Literal["auto", "sync", "async"] = "auto",
    workspace_cwd: bool = False,
    streaming: bool = True,
    runtime_id: str = "bridge",
    framework_version: str | None = None,
    transport=None,
    journal=None,
) -> int:
    """统一 worker 入口（§8.1）：按对象类型分派图 / Runnable 路径。

    `agent_or_factory`：CompiledStateGraph（或任意 `langgraph.pregel.Pregel`，
    含 `create_agent` 产物）、LangChain Runnable（`astream_events`/`ainvoke`/
    `invoke`），或工厂 `factory(init, tools) -> graph|Runnable`——工厂在
    initialize 之后、Slock MCP tools 就绪之后调用；`async def` 工厂在常驻
    事件循环上执行。其它对象 → 握手 `GRAPH_INPUT_INVALID`。

    mapper 签名（随分派路径不同；强制路径见 serve_langgraph/serve_langchain）：
    - `input_mapper`：图路径 `(init, turn, fresh) -> graph input`；
      Runnable 路径 `(init, turn) -> runnable input`。缺省都是
      `{"messages": [...]}`——图路径握手期校验 state schema 含 `messages`
      键（§8.4），自定义 mapper 时跳过该校验。
    - `output_mapper(values|result) -> str`：终态 → finalText。
    - `interrupt_mapper(interrupt.value) -> str`：审批提示文本（图路径）。
      缺省走 §9.1 默认渲染——HITLRequest 出可读提示 + options
      （decisions/actions 预览），str 原样，其余 json 截断。
    - `resume_mapper(init, turn, interrupt_value) -> Any`：resume 值映射
      （图路径）。`interrupt_value` 是当前 thread 首个 pending interrupt
      的 value（取不到为 None）。缺省走 §9.2 默认归约：LangChain
      HITLRequest → `{"decisions": [...]}`（`turn.resume.decision` 结构化
      决定按 approve/reject/respond/edit 映射并按 action_requests 数量
      复制；纯文本按批准词表归类 approve、其余一律 reject/respond——
      歧义输入不执行被拦截动作），非 HITL interrupt → decision dict
      透传或 `turn.resume.value` 原文。
    - `custom_event_mapper(custom_data) -> str | None`：返回 str 才发
      progress（图路径）。
    - `usage_extractor(result) -> dict | None`（Runnable 路径）。
    - `cost_calculator(usage_dict) -> float | None`：仅提供时才产出 costUsd。

    `system_prompt_mode`：`"prepend"` 注入 platform systemPrompt——图路径
    仅新 thread 前置，Runnable 路径每回合前置（无状态，等价上下文出现一
    次）；`"none"` 完全不注入。

    `execution`：`"auto"` 按 checkpointer 类名（`Async*`）或 async-only
    节点判定（best-effort）；`"sync"`/`"async"` 强制。async 全程跑在常驻
    事件循环上（§8.3）。

    `workspace_cwd`/`runtime_id`/`transport`/`journal`：同旧入口。

    Runnable 路径无状态：`interrupts:false, durableThreads:false`，不支持
    resume。需要记忆/审批请用图（`create_agent` + checkpointer）。
    """
    return _serve_impl(
        agent_or_factory,
        force_path=None,
        input_mapper=input_mapper,
        output_mapper=output_mapper,
        interrupt_mapper=interrupt_mapper,
        resume_mapper=resume_mapper,
        custom_event_mapper=custom_event_mapper,
        usage_extractor=usage_extractor,
        cost_calculator=cost_calculator,
        system_prompt_mode=system_prompt_mode,
        execution=execution,
        workspace_cwd=workspace_cwd,
        streaming=streaming,
        runtime_id=runtime_id,
        framework_version=framework_version,
        transport=transport,
        journal=journal,
    )


# ---------------------------------------------------------------------------
# 共享内核
# ---------------------------------------------------------------------------


def _serve_impl(
    agent_or_factory: Any,
    *,
    force_path: Literal["graph", "runnable"] | None,
    input_mapper=None,
    output_mapper=None,
    interrupt_mapper=None,
    resume_mapper=None,
    custom_event_mapper=None,
    usage_extractor=None,
    cost_calculator=None,
    system_prompt_mode: str = "prepend",
    execution: str = "auto",
    workspace_cwd: bool = False,
    streaming: bool = True,
    runtime_id: str = "bridge",
    framework_version: str | None = None,
    transport=None,
    journal=None,
    load_mcp_tools: bool = True,  # serve_langchain 旧参数（非 serve_agent 面）
) -> int:
    """serve_agent 与两个旧入口（force_path 强制路径）的共享内核。"""
    if system_prompt_mode not in ("prepend", "none"):
        raise ValueError(f"system_prompt_mode must be 'prepend' or 'none', got {system_prompt_mode!r}")
    if execution not in ("auto", "sync", "async"):
        raise ValueError(f"execution must be 'auto', 'sync' or 'async', got {execution!r}")

    # 内核共享状态——run_turn 闭包按 key 读（graph/agent/mcp_client/tools/
    # slock_tool_ops/loop/run_turn），路径工厂只组装自己的回合函数
    state: dict[str, Any] = {
        "mcp_client": None,
        "tools": [],
        "slock_tool_ops": {},
        "obj": None,
        "path": None,
        "loop": None,
        "run_turn": None,
    }

    def ensure_loop() -> _AsyncLoop:
        """惰性创建常驻 loop——纯 sync 图 / invoke-only Runnable 不付线程。"""
        loop = state["loop"]
        if loop is None:
            loop = _AsyncLoop()
            state["loop"] = loop
        return loop

    # ---------------- 握手（§8.1/§12.4 顺序） ----------------

    def on_initialize(init: SarpInitialize, emit: TurnEmit) -> dict:
        # WP6：initialize.runtime.id 是 manifest 声明原值——归一后比对，
        # "bridge"/"langchain"/"langgraph"（大小写不敏感）均接受
        if normalize_runtime_id(init.runtime_id) != normalize_runtime_id(runtime_id):
            raise SarpError(
                RUNTIME_ID_MISMATCH,
                f"initialize.runtime.id={init.runtime_id!r} does not match worker "
                f"runtime_id={runtime_id!r} (normalized comparison; "
                "'langchain'/'langgraph' are legacy aliases of 'bridge')",
                retryable=False,
            )
        if workspace_cwd:
            try:
                os.chdir(init.workspace_path)
            except OSError as e:
                raise SarpError(
                    CWD_NOT_FOUND,
                    f"workspace_cwd: cannot chdir to {init.workspace_path!r}: {e}",
                    retryable=False,
                ) from e

        # 1) MCP client 先行：子进程随 worker 退出由 finally close() 兜底；
        #    tools 必须先于图/Runnable 构建（§12.4）
        client: SlockMcpClient | None = None
        tools: list = []
        if init.mcp is not None and load_mcp_tools:
            client = SlockMcpClient(init.mcp)
            client.start()
            tools = _load_slock_tools(client)
        state["mcp_client"] = client
        state["tools"] = tools
        # tool.start/tool.end 的 provider=slock/operation 注册表（metadata
        # 优先、名字兜底——§8.2/WP1）
        state["slock_tool_ops"] = _tool_ops(tools)

        # 2) 对象：callable 且非图/Runnable → 工厂（async 工厂走常驻 loop）
        obj = agent_or_factory
        if callable(obj) and not _is_pregel(obj) and not _is_runnable(obj):
            produced = obj(init, tools)
            if inspect.isawaitable(produced):
                produced = ensure_loop().run(_await_result(produced))
            obj = produced
        state["obj"] = obj

        # 3) 分派一次判定；之后按路径装配
        path = force_path or _dispatch(obj)
        state["path"] = path

        if path == "graph":
            state["graph"] = obj
            rt.framework_version = framework_version or _graph_path.detect_version()
            # §8.4：默认 input mapper 依赖 messages 键——握手期校验
            if input_mapper is None:
                _graph_path.check_default_input_schema(obj)
            exec_mode = _graph_path.resolve_execution(obj, execution)
            if exec_mode == "async":
                ensure_loop()  # async 图必用常驻 loop——握手期起好
            state["run_turn"] = _graph_path.make_run_turn(
                state,
                input_mapper=input_mapper,
                output_mapper=output_mapper,
                interrupt_mapper=interrupt_mapper,
                resume_mapper=resume_mapper,
                custom_event_mapper=custom_event_mapper,
                cost_calculator=cost_calculator,
                system_prompt_mode=system_prompt_mode,
                exec_mode=exec_mode,
                streaming=streaming,
                ensure_loop=ensure_loop,
            )
            return _graph_path.handshake_fields(
                init, obj, streaming=streaming, has_mcp=client is not None
            )

        # runnable 路径（无状态）
        state["agent"] = obj
        rt.framework_version = framework_version or _runnable_path.detect_version()
        state["run_turn"] = _runnable_path.make_run_turn(
            state,
            input_mapper=input_mapper,
            output_mapper=output_mapper,
            usage_extractor=usage_extractor,
            cost_calculator=cost_calculator,
            system_prompt_mode=system_prompt_mode,
            streaming=streaming,
            ensure_loop=ensure_loop,
        )
        return _runnable_path.handshake_fields(init, streaming=streaming, has_mcp=bool(init.mcp))

    # ---------------- 回合 ----------------

    def run_turn(init: SarpInitialize, turn: SarpTurnStart, emit: TurnEmit, cancelled) -> TurnOutcome:
        fn: RunTurn | None = state["run_turn"]
        if fn is None:
            raise SarpError(PROTOCOL_VIOLATION, "agent not initialized", retryable=False)
        return fn(init, turn, emit, cancelled)

    # probe 期静态能力面：能判出路径就按路径报，否则报图路径全集
    # （superset——握手期 on_initialize overrides 仍是权威）
    probe_path = force_path or _static_path(agent_or_factory)
    if probe_path == "runnable":
        probe_caps = _runnable_path.probe_capabilities(streaming, load_mcp_tools)
    else:
        probe_caps = _graph_path.probe_capabilities(streaming)

    rt = WorkerRuntime(
        runtime_id=runtime_id,
        framework_version=(
            framework_version
            or (None if probe_path is None else _version_for(probe_path))
        ),
        capabilities=probe_caps,
        probe_model={"overrides": True},
        transport=transport,
        journal=journal,
    )
    try:
        return rt.serve(run_turn, on_initialize)
    finally:
        client = state["mcp_client"]
        if client is not None:
            with contextlib.suppress(Exception):
                client.close()
        loop = state["loop"]
        if loop is not None:
            loop.close()


def _version_for(path: str) -> str | None:
    return _graph_path.detect_version() if path == "graph" else _runnable_path.detect_version()
