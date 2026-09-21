"""LangChain worker 模板：最小可复制的 SARP/1 entrypoint。

- `python agent.py`：daemon 按 runtime.manifest.json 拉起，stdin/stdout 跑
  SARP/1 JSONL（日志一律 stderr）。
- `python agent.py --slock-probe`：单行 probe.result 后退出 0——由
  WorkerRuntime.serve 内置处理，无需自写分支。
- 默认 echo 节点不联网、不需要 provider key；真实模型经 initialize.runtime.model
  由 daemon 下发（provider key 配置进 manifest secretEnv）。
"""

from slock_runtime import serve_langchain


def build_agent(_init, _tools):
    """工厂签名 ``(init, tools)``：init = SarpInitialize，tools = Slock MCP
    StructuredTool（init.mcp 存在时由 SDK 加载，§12.4）。"""
    from langchain_core.messages import AIMessage
    from langchain_core.runnables import RunnableLambda

    def reply(value):
        message = value["messages"][-1]
        return {"messages": [AIMessage(content=f"Echo: {message.content}")]}

    return RunnableLambda(reply)


if __name__ == "__main__":
    raise SystemExit(serve_langchain(build_agent))
