"""LangGraph worker 模板：最小可复制的 SARP/1 entrypoint。

- `python agent.py`：daemon 按 runtime.manifest.json 拉起，stdin/stdout 跑
  SARP/1 JSONL（日志一律 stderr）。
- `python agent.py --slock-probe`：单行 probe.result 后退出 0——由
  WorkerRuntime.serve 内置处理，无需自写分支。
- 默认 echo 节点不联网、不需要 provider key；graph.compile() 未挂持久
  checkpointer 时 durableThreads=false。真实模型经 initialize.runtime.model
  由 daemon 下发（provider key 配置进 manifest secretEnv）。
"""

from slock_runtime import serve_langgraph


def build_graph(_init, _tools):
    """工厂签名 ``(init, tools)``：init = SarpInitialize，tools = SlockTool
    列表（init.mcp 存在时由 SDK 加载，§12.4）。需要 durable checkpoint 时
    在此 compile(checkpointer=SqliteSaver(...))——见 bridges/examples。"""
    from langchain_core.messages import AIMessage
    from langgraph.graph import END, START, MessagesState, StateGraph

    def reply(state):
        message = state["messages"][-1]
        return {"messages": [AIMessage(content=f"Echo: {message.content}")]}

    graph = StateGraph(MessagesState)
    graph.add_node("reply", reply)
    graph.add_edge(START, "reply")
    graph.add_edge("reply", END)
    return graph.compile()


if __name__ == "__main__":
    raise SystemExit(serve_langgraph(build_graph))
