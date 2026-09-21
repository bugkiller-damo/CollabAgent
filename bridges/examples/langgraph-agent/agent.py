"""Slock × LangGraph 示例 worker（设计文档 §12.3/§12.4）。

拓扑：
    START → agent →（有 tool_calls? tools → agent）→ review → END

- agent：绑了 Slock MCP tools 的 chat model（init.model 决定 provider，
  如 "openai:gpt-5-mini" / "anthropic:claude-sonnet-4-5"）；未配 model 时
  退化为 echo 节点——图结构、checkpoint、审批门照常演练。
- review：`interrupt()` 审批门（§8.6）——终稿发出前要人工确认；
  daemon 侧把 interrupt prompt 发回频道，同 conversation 的下一条
  用户消息作为 resume.value 进来：以 "reject" 开头 → 撤回回复，
  其余一律放行。
- checkpointer：SqliteSaver 落 `<workspace>/.slock/langgraph-checkpoints.sqlite`
  —— durableThreads=true，worker 进程重启后 thread 状态不丢（§11.3）。

运行（daemon 会以 manifest 里的 command 拉起本进程）：

    python agent.py            # stdin/stdout 上说 SARP/1 JSONL

本地手动冒烟（无 daemon）：见 README.md。
"""

from __future__ import annotations

import contextlib
import sqlite3
import sys
from pathlib import Path

# 仓库内直跑兜底：未安装 slock-runtime 包时把 bridges/python 加进 sys.path
_SDK_DIR = Path(__file__).resolve().parents[2] / "python"
if _SDK_DIR.is_dir() and str(_SDK_DIR) not in sys.path:
    sys.path.insert(0, str(_SDK_DIR))

from slock_runtime import serve_langgraph  # noqa: E402 — sys.path 兜底必须在 import 前
from slock_runtime.langgraph import SlockTool  # noqa: E402

# 进程级持有 checkpoint 连接，退出时统一关
_CHECKPOINT_CONNS: list[sqlite3.Connection] = []


def _to_langchain_tool(t: SlockTool):
    """SlockTool(MCP) → langchain StructuredTool；inputSchema 直接作 args_schema。"""
    from langchain_core.tools import StructuredTool

    return StructuredTool.from_function(
        lambda **kwargs: t.invoke(kwargs),
        name=t.name,
        description=t.description or t.name,
        args_schema=t.input_schema or {"type": "object", "properties": {}},
    )


def build_graph(init, slock_tools: list[SlockTool]):
    """§12.4 推荐形态：initialize 到达、Slock tools 就绪后才 compile。

    init.model 是 daemon 下发的模型选择（manifest model.mode=select）；
    为空时 graph 仍能跑（echo 节点），方便无 provider key 的冒烟。
    """
    from typing import Annotated

    from langchain_core.messages import AIMessage
    from langgraph.checkpoint.sqlite import SqliteSaver
    from langgraph.graph import END, START, StateGraph
    from langgraph.graph.message import add_messages
    from langgraph.types import interrupt
    from typing_extensions import TypedDict

    # 函数式 TypedDict：注解是真对象——__future__.annotations 下 class 语法
    # 会让 get_type_hints 去模块 globals 找 typing/add_messages 而炸掉
    AgentState = TypedDict("AgentState", {"messages": Annotated[list, add_messages]})  # noqa: UP013

    lc_tools = [_to_langchain_tool(t) for t in slock_tools]

    model = None
    if init.model:
        from langchain.chat_models import init_chat_model

        model = init_chat_model(init.model)
        if lc_tools:
            model = model.bind_tools(lc_tools)

    def agent_node(state):
        if model is not None:
            return {"messages": [model.invoke(state["messages"])]}
        last = state["messages"][-1]
        text = getattr(last, "content", str(last))
        names = ", ".join(t.name for t in slock_tools) or "none"
        return {"messages": [AIMessage(content=f"[echo] {text} ｜ slock tools: {names}")]}

    def route_after_agent(state) -> str:
        last = state["messages"][-1]
        if lc_tools and getattr(last, "tool_calls", None):
            return "tools"
        return "review"

    def review_node(state):
        """审批门：interrupt() 挂起等频道回复；checkpoint 已落盘，重启可续。"""
        last = state["messages"][-1]
        preview = getattr(last, "content", "")
        if not isinstance(preview, str):
            preview = str(preview)
        verdict = interrupt({"kind": "final_approval", "preview": preview[:500]})
        if isinstance(verdict, str) and verdict.strip().lower().startswith("reject"):
            return {"messages": [AIMessage(content="（回复被审批人拒绝，未发出）")]}
        return {}  # approve：终稿保持，graph 结束 → finalText

    builder = StateGraph(AgentState)
    builder.add_node("agent", agent_node)
    builder.add_node("review", review_node)
    if lc_tools:
        from langgraph.prebuilt import ToolNode

        builder.add_node("tools", ToolNode(lc_tools))
        builder.add_edge("tools", "agent")
    builder.add_edge(START, "agent")
    path_map = {"review": "review"}
    if lc_tools:
        path_map["tools"] = "tools"
    builder.add_conditional_edges("agent", route_after_agent, path_map)
    builder.add_edge("review", END)

    ckpt = Path(init.workspace_path) / ".slock" / "langgraph-checkpoints.sqlite"
    ckpt.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(ckpt), check_same_thread=False)
    _CHECKPOINT_CONNS.append(conn)
    return builder.compile(checkpointer=SqliteSaver(conn))


def _interrupt_prompt(value) -> str:
    """interrupt payload → 发回频道的审批文案（§8.6 turn.interrupt.prompt）。"""
    if isinstance(value, dict) and value.get("kind") == "final_approval":
        return f"回复待审批：{value.get('preview', '')[:200]} ｜ 回复 approve 放行，reject 撤回"
    return str(value)


def _custom_progress(data):
    """只放行 {"msg": ...} 形自定义事件为 assistant.progress（§12.3.4）。"""
    if isinstance(data, dict) and isinstance(data.get("msg"), str):
        return data["msg"]
    return None


def main() -> int:
    # --slock-probe 由 serve_langgraph → WorkerRuntime.serve 内置处理——
    # 跑在 import langgraph / 建模型客户端 / 开 checkpoint 之前
    try:
        return serve_langgraph(
            build_graph,
            interrupt_mapper=_interrupt_prompt,
            custom_event_mapper=_custom_progress,
        )
    finally:
        for conn in _CHECKPOINT_CONNS:
            with contextlib.suppress(Exception):
                conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
