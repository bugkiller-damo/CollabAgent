"""protocol.py 契约测试：与 daemon 侧 sarp-protocol.ts 逐字段对齐。

跨语言 fixture（bridges/fixtures/*.jsonl）的双向校验见 test_contract_fixtures.py。
"""

from __future__ import annotations

import json

import pytest

from slock_runtime.protocol import (
    SARP_PROTOCOL,
    SarpInbound,
    SarpInitialize,
    SarpProtocolError,
    SarpShutdown,
    SarpTurnCancel,
    SarpTurnStart,
    decode_daemon_frame,
    encode_worker_frame,
)


def _frame(type_: str, seq: int = 1, **fields) -> str:
    return (
        json.dumps(
            {
                "protocol": SARP_PROTOCOL,
                "version": 1,
                "type": type_,
                "seq": seq,
                "timestamp": "2026-09-20T00:00:00.000Z",
                **fields,
            }
        )
        + "\n"
    )


INIT_FIELDS = dict(
    requestId="req-1",
    agent={"id": "ag_1", "name": "bot", "displayName": "Bot", "description": "d"},
    runtime={"id": "langgraph", "entrypoint": "lg-agent", "model": "gpt-4o-mini"},
    workspace={"path": "/tmp/ws"},
    platform={
        "systemPrompt": "sys",
        "serverUrl": "wss://x",
        "tokenFile": "/tmp/tok",
        "mcp": {"command": "node", "args": ["srv.js"], "env": {"K": "V"}},
    },
    limits={"maxFrameBytes": 1048576, "silenceTimeoutMs": 300000, "shutdownTimeoutMs": 5000},
)

TURN_FIELDS = dict(
    turnId="t-1",
    conversationId="slock:v1:ag_1:thread:th1",
    attempt=1,
    source={"kind": "thread", "channel": "general", "threadId": "th1", "sender": "u1"},
    prompt="hello",
)


class TestInitializeDecode:
    def test_full(self):
        msg = decode_daemon_frame(_frame("initialize", **INIT_FIELDS))
        assert isinstance(msg, SarpInitialize)
        assert msg.request_id == "req-1"
        assert msg.agent.id == "ag_1" and msg.agent.display_name == "Bot"
        assert msg.runtime_id == "langgraph" and msg.entrypoint == "lg-agent"
        assert msg.model == "gpt-4o-mini"
        assert msg.workspace_path == "/tmp/ws"
        assert msg.system_prompt == "sys" and msg.token_file == "/tmp/tok"
        assert msg.mcp is not None and msg.mcp.command == "node"
        assert msg.mcp.args == ("srv.js",) and msg.mcp.env == {"K": "V"}
        assert msg.max_frame_bytes == 1048576 and msg.silence_timeout_ms == 300000
        assert msg.shutdown_timeout_ms == 5000

    def test_minimal(self):
        f = dict(INIT_FIELDS)
        f["platform"] = {}
        f["runtime"] = {"id": "langchain", "entrypoint": "e"}
        f["limits"] = {"maxFrameBytes": 1, "silenceTimeoutMs": 1}
        msg = decode_daemon_frame(_frame("initialize", **f))
        assert msg.mcp is None and msg.system_prompt is None and msg.shutdown_timeout_ms is None

    def test_mcp_args_must_be_list(self):
        f = dict(INIT_FIELDS)
        f["platform"] = {"mcp": {"command": "node", "args": "oops"}}
        with pytest.raises(SarpProtocolError) as e:
            decode_daemon_frame(_frame("initialize", **f))
        assert e.value.reason == "invalid-schema"

    def test_mcp_allow_tools_parsed(self):
        """P1.6：allowTools 数组 → descriptor.allow_tools 元组。"""
        f = dict(INIT_FIELDS)
        f["platform"] = {
            "mcp": {"command": "node", "args": [], "allowTools": ["send_message", "read_history"]},
        }
        msg = decode_daemon_frame(_frame("initialize", **f))
        assert msg.mcp is not None
        assert msg.mcp.allow_tools == ("send_message", "read_history")

    def test_mcp_allow_tools_absent_or_empty_means_unrestricted(self):
        """P1.6：缺省/空表 = 不收敛（None）。"""
        f = dict(INIT_FIELDS)
        msg = decode_daemon_frame(_frame("initialize", **f))  # mcp 无 allowTools 键
        assert msg.mcp is not None and msg.mcp.allow_tools is None

        f["platform"] = {"mcp": {"command": "node", "allowTools": []}}
        msg = decode_daemon_frame(_frame("initialize", **f))
        assert msg.mcp is not None and msg.mcp.allow_tools == ()

    def test_mcp_allow_tools_non_array_rejected(self):
        """P1.6：非 array → invalid-schema（fail-closed，不静默放开工具面）。"""
        for bad in ("send_message", 42, {"a": 1}):
            f = dict(INIT_FIELDS)
            f["platform"] = {"mcp": {"command": "node", "allowTools": bad}}
            with pytest.raises(SarpProtocolError) as e:
                decode_daemon_frame(_frame("initialize", **f))
            assert e.value.reason == "invalid-schema"

    def test_mcp_allow_tools_non_string_item_rejected(self):
        f = dict(INIT_FIELDS)
        f["platform"] = {"mcp": {"command": "node", "allowTools": ["ok", 7]}}
        with pytest.raises(SarpProtocolError) as e:
            decode_daemon_frame(_frame("initialize", **f))
        assert e.value.reason == "invalid-schema"

    def test_missing_request_id(self):
        f = dict(INIT_FIELDS)
        del f["requestId"]
        with pytest.raises(SarpProtocolError) as e:
            decode_daemon_frame(_frame("initialize", **f))
        assert e.value.reason == "invalid-schema"


class TestTurnStartDecode:
    def test_full(self):
        msg = decode_daemon_frame(_frame("turn.start", **TURN_FIELDS))
        assert isinstance(msg, SarpTurnStart)
        assert msg.turn_id == "t-1" and msg.attempt == 1
        assert msg.source.kind == "thread" and msg.source.sender == "u1"
        assert msg.prompt == "hello" and msg.resume is None

    def test_resume(self):
        f = dict(TURN_FIELDS)
        f["resume"] = {"interruptId": "i1", "resumeToken": "rt", "value": "approved"}
        msg = decode_daemon_frame(_frame("turn.start", **f))
        assert msg.resume is not None and msg.resume.value == "approved"

    def test_cancel_and_shutdown(self):
        c = decode_daemon_frame(_frame("turn.cancel", turnId="t-1", reason="user"))
        assert isinstance(c, SarpTurnCancel) and c.reason == "user"
        s = decode_daemon_frame(_frame("shutdown", reason="idle", timeoutMs=3000))
        assert isinstance(s, SarpShutdown) and s.timeout_ms == 3000
        s2 = decode_daemon_frame(_frame("shutdown"))
        assert s2.reason is None and s2.timeout_ms is None


class TestEnvelope:
    def test_wrong_protocol(self):
        line = _frame("shutdown").replace(SARP_PROTOCOL, "other")
        with pytest.raises(SarpProtocolError) as e:
            decode_daemon_frame(line)
        assert e.value.reason == "invalid-envelope"

    def test_wrong_version(self):
        line = json.loads(_frame("shutdown"))
        line["version"] = 2
        with pytest.raises(SarpProtocolError) as e:
            decode_daemon_frame(json.dumps(line))
        assert e.value.reason == "unsupported-version"

    def test_bad_json(self):
        with pytest.raises(SarpProtocolError) as e:
            decode_daemon_frame("{not json")
        assert e.value.reason == "invalid-json"

    def test_seq_required_positive(self):
        line = json.loads(_frame("shutdown"))
        line["seq"] = 0
        with pytest.raises(SarpProtocolError) as e:
            decode_daemon_frame(json.dumps(line))
        assert e.value.reason == "invalid-envelope"

    def test_unknown_optional_ignored(self):
        assert decode_daemon_frame(_frame("future.thing", optional=True)) is None

    def test_unknown_nonoptional_rejected(self):
        with pytest.raises(SarpProtocolError) as e:
            decode_daemon_frame(_frame("future.thing"))
        assert e.value.reason == "unexpected-message"

    def test_optional_nonbool_rejected(self):
        with pytest.raises(SarpProtocolError) as e:
            decode_daemon_frame(_frame("shutdown", optional="yes"))
        assert e.value.reason == "invalid-envelope"


class TestInboundSeq:
    def test_monotonic_ok(self):
        inbound = SarpInbound()
        inbound.next(_frame("shutdown", seq=3))
        inbound.next(_frame("shutdown", seq=7))

    def test_regression_rejected(self):
        inbound = SarpInbound()
        inbound.next(_frame("shutdown", seq=5))
        with pytest.raises(SarpProtocolError) as e:
            inbound.next(_frame("shutdown", seq=5))
        assert e.value.reason == "unexpected-message"


class TestWorkerEncode:
    def test_envelope_and_none_skip(self):
        line = encode_worker_frame(
            "assistant.delta", 3, "2026-09-20T00:00:00Z", turnId="t", eventSeq=1, text="hi", absent=None
        )
        o = json.loads(line)
        assert o["protocol"] == SARP_PROTOCOL and o["version"] == 1
        assert o["type"] == "assistant.delta" and o["seq"] == 3
        assert o["text"] == "hi" and "absent" not in o
        assert line.endswith("\n")

    def test_no_newline_injection(self):
        # 帧内嵌换行必须转义——JSONL 帧不允许裸 \n
        line = encode_worker_frame("assistant.delta", 1, "ts", turnId="t", eventSeq=1, text="a\nb")
        assert line.count("\n") == 1
