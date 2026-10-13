"""tool.start/tool.end 的 provider/operation 标注规则（私有模块）。

Slock MCP 工具（initialize.platform.mcp 下发的）标 provider="slock"、
operation=工具名——daemon 侧据此识别「回复已发出的回合」（send_message
成功 + 空 finalText 不是 empty-success）；其余工具保留 adapter 自身的
provider 标注，不填 operation。
"""

from __future__ import annotations


def tool_provider_fields(name: str | None, slock_tool_names: frozenset[str], fallback: str) -> dict[str, str]:
    """Slock MCP 工具 → {"provider": "slock", "operation": name}；其它 → {"provider": fallback}。"""
    if name and name in slock_tool_names:
        return {"provider": "slock", "operation": name}
    return {"provider": fallback}
