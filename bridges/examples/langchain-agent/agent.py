"""LangChain 示例 worker：最小可跑的 SARP/1 entrypoint（设计文档 §12.1/§12.4）。

用法：
  - 由 daemon 按 runtime.manifest.json spawn：`python agent.py`
    （stdin/stdout 逐行 SARP/1 帧，日志一律 stderr）。
  - 本机自检：`python agent.py --slock-probe` —— 单行 probe.result 后退出 0
    （§9.4：probe 分支由 SDK WorkerRuntime 内置，跑在加载 graph / 建模型
    客户端 / 联网之前——本文件无需自写分支）。

模型来源：initialize.runtime.model（如 "openai:gpt-4o-mini"）经
`langchain.chat_models.init_chat_model` 解析；未配置或不可用时退化为本地
demo runnable（不联网、不 bind_tools），保证示例零密钥可跑通管道。
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from slock_runtime import SarpInitialize

# 仓库内直接运行的兜底：bridges/python 插进 sys.path；pip install 后走 site-packages
try:
    import slock_runtime  # noqa: F401
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

RUNTIME_ID = "langchain"


def _resolve_model(init: SarpInitialize) -> Any:
    """init.model（"provider:model"）→ chat model；缺省/失败 → None 走 demo 兜底。"""
    if init.model:
        try:
            from langchain.chat_models import init_chat_model

            return init_chat_model(init.model)
        except Exception as e:
            # 缺 provider 包/密钥不算致命——降级跑通管道；warning 只走 stderr
            print(
                f"[langchain-example] init_chat_model({init.model}) failed: {e}; using demo fallback",
                file=sys.stderr,
            )
    return None


def build_agent(init: SarpInitialize, tools: list) -> Any:
    """工厂签名 ``(init, tools)``——init.mcp 存在时 tools 是 SDK 已加载的
    Slock MCP StructuredTool，须在 graph 构建期绑定（§12.4 启动顺序）。"""
    model = _resolve_model(init)
    if model is not None:
        from langchain.agents import create_agent

        # system prompt 由 adapter 按 system_prompt_mode="prepend" 注入为
        # 最高优先级 SystemMessage，这里不重复注入（§12.2）
        return create_agent(model=model, tools=list(tools))

    # ---- demo fallback：不 bind_tools 的最小 runnable，验证协议/事件/回话 ----
    from langchain_core.messages import AIMessage
    from langchain_core.runnables import RunnableLambda

    tool_names = ", ".join(t.name for t in tools) or "none"

    def _reply(x: dict) -> dict:
        last = x["messages"][-1]
        text = getattr(last, "content", str(last))
        return {
            "messages": [
                AIMessage(content=f"[langchain-example] mcp-tools=({tool_names}); echo: {text}")
            ]
        }

    return RunnableLambda(_reply)


def main() -> int:
    from slock_runtime import serve_langchain

    # --slock-probe 由 serve_langchain → WorkerRuntime.serve 内置处理
    return serve_langchain(build_agent, runtime_id=RUNTIME_ID)


if __name__ == "__main__":
    raise SystemExit(main())
