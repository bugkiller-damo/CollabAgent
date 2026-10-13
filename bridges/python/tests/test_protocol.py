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
    SarpInterruptAction,
    SarpInterruptOptions,
    SarpProtocolError,
    SarpResumeDecision,
    SarpShutdown,
    SarpTurnCancel,
    SarpTurnMessage,
    SarpTurnStart,
    decode_daemon_frame,
    encode_worker_frame,
    interrupt_options_wire,
    parse_interrupt_options,
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
        assert msg.resume.decision is None  # 老 daemon 不下发 → None

    # ---------------- WP7 增量字段（R-UF 可选） ----------------

    def test_message_full(self):
        f = dict(TURN_FIELDS)
        f["message"] = {
            "text": "批准一下这个操作",
            "sender": "u1",
            "messageId": "m-9",
            "attachments": [
                {
                    "id": "at1",
                    "filename": "spec.pdf",
                    "mimeType": "application/pdf",
                    "sizeBytes": 2048,
                    "url": "https://x/spec.pdf",
                },
                {"id": "at2", "filename": "p.png", "mimeType": "image/png", "sizeBytes": 0},
            ],
        }
        f["contextText"] = "平台注入的会话历史"
        msg = decode_daemon_frame(_frame("turn.start", **f))
        assert isinstance(msg, SarpTurnStart)
        assert isinstance(msg.message, SarpTurnMessage)
        assert msg.message.text == "批准一下这个操作"
        assert msg.message.sender == "u1" and msg.message.message_id == "m-9"
        assert len(msg.message.attachments) == 2
        att = msg.message.attachments[0]
        assert (att.id, att.filename, att.mime_type, att.size_bytes, att.url) == (
            "at1",
            "spec.pdf",
            "application/pdf",
            2048,
            "https://x/spec.pdf",
        )
        assert msg.message.attachments[1].url is None
        assert msg.context_text == "平台注入的会话历史"
        # prompt 语义不变：仍是平台组装好的完整文本
        assert msg.prompt == "hello"

    def test_message_minimal_and_new_fields_absent(self):
        f = dict(TURN_FIELDS)
        f["message"] = {"text": "hi"}  # 仅必填 text
        msg = decode_daemon_frame(_frame("turn.start", **f))
        assert msg.message is not None
        assert msg.message.sender is None and msg.message.message_id is None
        assert msg.message.attachments == ()
        # 全缺省（旧 daemon 帧形态）→ 全 None，不崩
        msg2 = decode_daemon_frame(_frame("turn.start", **TURN_FIELDS))
        assert msg2.message is None and msg2.context_text is None

    def test_message_malformed_ignored(self):
        """R-UF：可选字段畸形不致命——按缺省 None，绝不 raise。"""
        for bad in ("str", 42, [], {"text": 1}, {"text": ""}, {"sender": "u"}, True):
            f = dict(TURN_FIELDS)
            f["message"] = bad
            msg = decode_daemon_frame(_frame("turn.start", **f))
            assert msg.message is None, bad
        f = dict(TURN_FIELDS)
        f["contextText"] = 42  # 非 str → None
        msg = decode_daemon_frame(_frame("turn.start", **f))
        assert msg.context_text is None

    def test_message_malformed_attachment_entries_skipped(self):
        f = dict(TURN_FIELDS)
        f["message"] = {
            "text": "hi",
            "attachments": [
                "junk",
                {"id": "a"},  # 缺 filename/mimeType/sizeBytes
                {"id": "b", "filename": "f", "mimeType": "m", "sizeBytes": -1},  # 负数
                {"id": "c", "filename": "f", "mimeType": "m", "sizeBytes": True},  # bool 非 int
                {"id": "ok", "filename": "f.txt", "mimeType": "text/plain", "sizeBytes": 7},
            ],
        }
        msg = decode_daemon_frame(_frame("turn.start", **f))
        assert [a.id for a in msg.message.attachments] == ["ok"]
        # attachments 非 list → 空表（不致命）
        f["message"] = {"text": "hi", "attachments": "oops"}
        msg = decode_daemon_frame(_frame("turn.start", **f))
        assert msg.message is not None and msg.message.attachments == ()

    def test_resume_decision(self):
        base = {"interruptId": "i1", "resumeToken": "rt", "value": "批准"}
        for dec, want in (
            ({"type": "approve"}, ("approve", None, None)),
            ({"type": "reject", "message": "不行"}, ("reject", "不行", None)),
            ({"type": "respond", "message": "补充说明"}, ("respond", "补充说明", None)),
            (
                {"type": "edit", "args": {"edited_action": {"name": "send_email", "args": {"to": "u"}}}},
                ("edit", None, {"edited_action": {"name": "send_email", "args": {"to": "u"}}}),
            ),
        ):
            f = dict(TURN_FIELDS)
            f["resume"] = {**base, "decision": dec}
            msg = decode_daemon_frame(_frame("turn.start", **f))
            d = msg.resume.decision
            assert isinstance(d, SarpResumeDecision)
            assert (d.type, d.message, d.args) == want

    def test_resume_decision_permissive_and_malformed(self):
        base = {"interruptId": "i1", "resumeToken": "rt", "value": "v"}
        # R-UF 前向兼容：未知 type 原样保留，不收敛枚举
        f = dict(TURN_FIELDS)
        f["resume"] = {**base, "decision": {"type": "future-kind", "extra": "ignored?"}}
        msg = decode_daemon_frame(_frame("turn.start", **f))
        assert msg.resume.decision is not None and msg.resume.decision.type == "future-kind"
        # 畸形 → None（resume 本体字段照常必填校验）
        for bad in ("approve", 42, [], {}, {"type": ""}, {"type": 7}, None):
            f = dict(TURN_FIELDS)
            f["resume"] = {**base, "decision": bad}
            msg = decode_daemon_frame(_frame("turn.start", **f))
            assert msg.resume is not None and msg.resume.decision is None, bad

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


class TestInterruptOptions:
    """WP7 §7.2：interrupt.options 的宽容解析与 wire 序列化（与 daemon
    parseInterrupt 过滤口径一致：decisions 收枚举、actions ≤10、缺 name 丢弃）。"""

    def test_parse_full(self):
        raw = {
            "decisions": ["approve", "reject", "respond", "edit"],
            "actions": [
                {"name": "send_email", "args": {"to": "u"}, "description": "给 u 发信"},
                {"name": "delete_file"},
            ],
        }
        o = parse_interrupt_options(raw)
        assert isinstance(o, SarpInterruptOptions)
        assert o.decisions == ("approve", "reject", "respond", "edit")
        assert o.actions[0].name == "send_email" and o.actions[0].args == {"to": "u"}
        assert o.actions[0].description == "给 u 发信"
        assert o.actions[1].args is None and o.actions[1].description is None

    def test_parse_filters_malformed_entries(self):
        raw = {
            "decisions": ["approve", "bogus", 42, "", "reject"],
            "actions": [
                "junk",
                {"name": ""},  # 空 name
                {"no_name": 1},  # 缺 name
                {"name": "ok", "description": 5},  # description 非 str → None
            ],
        }
        o = parse_interrupt_options(raw)
        assert o.decisions == ("approve", "reject")
        assert [a.name for a in o.actions] == ["ok"]
        assert o.actions[0].description is None

    def test_parse_non_dict_and_empty(self):
        assert parse_interrupt_options("x") is None
        assert parse_interrupt_options(None) is None
        assert parse_interrupt_options(7) is None
        # dict 但字段全畸形 → 空 options（不崩）
        o = parse_interrupt_options({"decisions": "nope", "actions": {}})
        assert o.decisions == () and o.actions == ()

    def test_parse_actions_truncated_at_limit(self):
        raw = {"actions": [{"name": f"a{i}"} for i in range(15)]}
        o = parse_interrupt_options(raw)
        assert len(o.actions) == 10  # INTERRUPT_OPTIONS_MAX_ACTIONS
        assert o.actions[-1].name == "a9"

    def test_wire_roundtrip(self):
        o = SarpInterruptOptions(
            decisions=("approve", "edit"),
            actions=(SarpInterruptAction(name="n", args={"k": 1}, description="d"),),
        )
        assert interrupt_options_wire(o) == {
            "decisions": ["approve", "edit"],
            "actions": [{"name": "n", "args": {"k": 1}, "description": "d"}],
        }
        # 空字段不写键
        assert interrupt_options_wire(SarpInterruptOptions()) == {}
        o2 = parse_interrupt_options({"decisions": ["approve"]})
        assert o2 is not None and interrupt_options_wire(o2) == {"decisions": ["approve"]}
