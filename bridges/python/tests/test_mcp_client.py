"""mcp.py 端到端：fake MCP stdio server 驱动 SlockMcpClient 全路径。

覆盖：spawn + initialize 握手、server→client notification 忽略、
tools/list、tools/call echo、isError → SarpError(MCP_START_FAILED)、
close 清理子进程、command 不存在 → MCP_START_FAILED。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from slock_runtime.errors import MCP_START_FAILED, SarpError
from slock_runtime.mcp import SlockMcpClient
from slock_runtime.protocol import SarpMcpDescriptor

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "fake_mcp_server.py"


def _descriptor(command: str | None = None, args: tuple = ()) -> SarpMcpDescriptor:
    return SarpMcpDescriptor(
        command=command or sys.executable,
        args=args or ("-u", str(FIXTURE)),
    )


@pytest.fixture
def client():
    c = SlockMcpClient(_descriptor())
    c.start()
    yield c
    c.close()


class TestLifecycle:
    def test_start_and_close(self):
        c = SlockMcpClient(_descriptor())
        c.start()
        assert c._proc is not None and c._proc.poll() is None
        c.close()
        assert c._proc is None

    def test_command_not_found(self):
        c = SlockMcpClient(_descriptor(command="definitely-not-a-real-mcp-command-xyz"))
        with pytest.raises(SarpError) as ei:
            c.start()
        assert ei.value.wire.code == MCP_START_FAILED
        assert ei.value.wire.retryable is True

    def test_request_after_close_fails(self):
        c = SlockMcpClient(_descriptor())
        c.start()
        c.close()
        with pytest.raises(SarpError) as ei:
            c.list_tools()
        assert ei.value.wire.code == MCP_START_FAILED


class TestTools:
    def test_list_tools(self, client):
        tools = client.list_tools()
        assert len(tools) == 1
        t = tools[0]
        assert t.name == "slock_echo"
        assert "Echo" in t.description
        assert t.input_schema["type"] == "object"
        assert "text" in t.input_schema["properties"]

    def test_call_tool_echoes_arguments(self, client):
        out = client.call_tool("slock_echo", {"text": "hello", "n": 1})
        assert '"n": 1' in out and '"text": "hello"' in out

    def test_call_tool_is_error(self, client):
        with pytest.raises(SarpError) as ei:
            client.call_tool("slock_echo", {"fail": True})
        assert ei.value.wire.code == MCP_START_FAILED
        assert "echo failed by request" in ei.value.wire.message

    def test_sequential_calls_reuse_one_process(self, client):
        pid = client._proc.pid
        client.call_tool("slock_echo", {"text": "a"})
        client.call_tool("slock_echo", {"text": "b"})
        assert client._proc.pid == pid  # §12.4：不为每次 call 起新 server

    def test_unknown_method_returns_rpc_error(self, client):
        with pytest.raises(SarpError) as ei:
            client._request("bogus/method", {})
        assert ei.value.wire.code == MCP_START_FAILED
        assert "method not found" in ei.value.wire.message


class TestWriteIdempotency:
    """§15.4：写工具自动注入 <turnId>:<tool>:<seq> 幂等键。"""

    def test_write_tool_gets_idempotency_key(self, client):
        client.set_active_turn("turn-7")
        out = client.call_tool("send_message", {"target": "#general", "content": "hi"})
        assert '"idempotencyKey": "turn-7:send_message:0"' in out

    def test_seq_increments_within_turn(self, client):
        client.set_active_turn("turn-7")
        client.call_tool("send_message", {"target": "#general", "content": "a"})
        out = client.call_tool("send_message", {"target": "#general", "content": "b"})
        assert '"idempotencyKey": "turn-7:send_message:1"' in out

    def test_replayed_turn_rekeys_from_zero(self, client):
        """A1 重试重跑同 turnId：序号归零重数，第 n 次写撞同一键。"""
        client.set_active_turn("turn-7")
        client.call_tool("send_message", {"target": "#g", "content": "a"})
        client.set_active_turn("turn-7")  # 重试到达：同 turnId 重置序号
        out = client.call_tool("send_message", {"target": "#g", "content": "a"})
        assert '"idempotencyKey": "turn-7:send_message:0"' in out

    def test_different_tools_have_independent_seq(self, client):
        client.set_active_turn("turn-7")
        client.call_tool("send_message", {"target": "#g", "content": "a"})
        out = client.call_tool("dispatch_task", {"channel": "#g", "toAgent": "w", "text": "t"})
        assert '"idempotencyKey": "turn-7:dispatch_task:0"' in out

    def test_read_tool_gets_no_key(self, client):
        client.set_active_turn("turn-7")
        out = client.call_tool("slock_echo", {"text": "x"})
        assert "idempotencyKey" not in out

    def test_no_active_turn_no_key(self, client):
        out = client.call_tool("send_message", {"target": "#g", "content": "a"})
        assert "idempotencyKey" not in out

    def test_caller_supplied_key_wins(self, client):
        client.set_active_turn("turn-7")
        out = client.call_tool(
            "send_message",
            {"target": "#g", "content": "a", "idempotencyKey": "custom-key-9"},
        )
        assert '"idempotencyKey": "custom-key-9"' in out
