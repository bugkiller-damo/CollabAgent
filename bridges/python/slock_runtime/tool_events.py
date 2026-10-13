"""tool.start/tool.end 的 provider/operation 标注规则（私有模块）。

Slock MCP 工具（initialize.platform.mcp 下发的）标 provider="slock"、
operation=工具名——daemon 侧据此识别「回复已发出的回合」（send_message
成功 + 空 finalText 不是 empty-success）；其余工具保留 adapter 自身的
provider 标注，不填 operation。

WP8 §8.2：slock_tools 是「名 → operation」注册表，由工具
metadata={"slock": True, "operation": name} 构建——命中即以
metadata.operation 为权威；兼容旧形态 frozenset[str]（按名命中即
slock、operation=名字），metadata 缺席时保持旧行为。
"""

from __future__ import annotations


def tool_provider_fields(
    name: str | None, slock_tools: dict[str, str] | frozenset[str], fallback: str
) -> dict[str, str]:
    """Slock MCP 工具 → {"provider": "slock", "operation": <op>}；其它 → {"provider": fallback}。"""
    if not name:
        return {"provider": fallback}
    if isinstance(slock_tools, dict):
        # metadata 注册表：名字不在表中即非 slock 工具
        op = slock_tools.get(name)
        return {"provider": "slock", "operation": op} if op else {"provider": fallback}
    # 旧形态：frozenset[str] 按名兜底
    if name in slock_tools:
        return {"provider": "slock", "operation": name}
    return {"provider": fallback}
