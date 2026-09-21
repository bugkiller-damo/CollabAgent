"""daemon e2e fixture：真实 LangGraph CompiledStateGraph worker。

由 sarp-langgraph-e2e.test.ts spawn（venv python + PYTHONPATH=bridges/python）。
与 sarp_worker.py 的区别：这里跑的是真 langgraph 图 + 真 SqliteSaver
checkpoint——thread_id 记忆、跨进程重启恢复、interrupt()/Command(resume)
全部由框架真实语义承担。

env:
- SLOCK_LG_INTERRUPT=1：reply 前加 approval gate（interrupt("批准敏感操作？"）；
  resume 值透传进 state.notes 证明 Command(resume=) 到达。
- checkpoint db: <workspace>/.slock/lg-checkpoints.sqlite
"""

from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path


def factory(init, tools):
    from langchain_core.messages import AIMessage
    from langgraph.checkpoint.sqlite import SqliteSaver
    from langgraph.graph import END, START, MessagesState, StateGraph

    def reply(state):
        msgs = state["messages"]
        last = msgs[-1].content
        return {"messages": [AIMessage(content=f"echo[{len(msgs)}]:{last}")]}

    builder = StateGraph(MessagesState)

    if os.environ.get("SLOCK_LG_INTERRUPT") == "1":
        from langgraph.types import interrupt

        def gate(state):
            # value 会经 interrupt_mapper → prompt 透出到频道
            verdict = interrupt("批准敏感操作？")
            return {"messages": [AIMessage(content=f"verdict:{verdict}")]}

        builder.add_node("gate", gate)
        builder.add_node("reply", reply)
        builder.add_edge(START, "gate")
        builder.add_edge("gate", "reply")
        builder.add_edge("reply", END)
    else:
        builder.add_node("reply", reply)
        builder.add_edge(START, "reply")
        builder.add_edge("reply", END)

    db = Path(init.workspace_path) / ".slock" / "lg-checkpoints.sqlite"
    db.parent.mkdir(parents=True, exist_ok=True)
    cp = SqliteSaver(sqlite3.connect(str(db), check_same_thread=False))
    return builder.compile(checkpointer=cp)


def main() -> int:
    from slock_runtime import serve_langgraph

    return serve_langgraph(factory)


if __name__ == "__main__":
    sys.exit(main())
