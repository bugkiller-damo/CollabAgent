"""SARP/1（slock.agent-runtime v1）wire 编解码与 schema 校验。

逐字段镜像 packages/daemon/src/sarp-protocol.ts —— daemon 侧是协议权威，
本模块必须与其保持 frame-for-frame 一致（跨语言 contract fixtures 校验）。

纪律：
- stdin 只承载 daemon→worker 帧；stdout 只承载 worker→daemon 帧（§8.1.4）。
- worker 日志只能走 stderr，绝不写 stdout。
- 未知 daemon 消息：显式 optional:true 才忽略；已知类型即使 optional
  也必须过 schema（§8.1.5/§8.1.6）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

SARP_PROTOCOL = "slock.agent-runtime"
SARP_VERSION = 1
# §8.1.3：单帧上限 1 MiB
SARP_MAX_FRAME_BYTES = 1024 * 1024

PROTOCOL_VERSION = SARP_VERSION  # 兼容别名


# ---------------------------------------------------------------------------
# daemon → worker（解码）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SarpAgentInfo:
    id: str
    name: str
    display_name: str | None = None
    description: str | None = None


@dataclass(frozen=True)
class SarpMcpDescriptor:
    command: str
    args: tuple[str, ...] = ()
    env: dict[str, str] | None = None


@dataclass(frozen=True)
class SarpInitialize:
    seq: int
    request_id: str
    agent: SarpAgentInfo
    runtime_id: str
    entrypoint: str
    model: str | None
    """Phase 5 §11.2：manifest 条目 revision——checkpoint 命名空间分量之一"""
    revision: str | None
    workspace_path: str
    system_prompt: str | None
    server_url: str | None
    token_file: str | None
    mcp: SarpMcpDescriptor | None
    max_frame_bytes: int
    silence_timeout_ms: int
    shutdown_timeout_ms: int | None


@dataclass(frozen=True)
class SarpResume:
    interrupt_id: str
    resume_token: str
    value: str


@dataclass(frozen=True)
class SarpTurnSource:
    kind: str
    channel: str | None = None
    thread_id: str | None = None
    sender: str | None = None


@dataclass(frozen=True)
class SarpTurnStart:
    seq: int
    turn_id: str
    conversation_id: str
    attempt: int
    source: SarpTurnSource
    prompt: str
    resume: SarpResume | None = None


@dataclass(frozen=True)
class SarpTurnCancel:
    seq: int
    turn_id: str
    reason: str


@dataclass(frozen=True)
class SarpShutdown:
    seq: int
    reason: str | None = None
    timeout_ms: int | None = None


SarpDaemonMessage = SarpInitialize | SarpTurnStart | SarpTurnCancel | SarpShutdown

# "frame-too-large" | "invalid-json" | "invalid-envelope"
# | "unsupported-version" | "invalid-schema" | "unexpected-message"
SarpErrorReason = str


class SarpProtocolError(Exception):
    """协议级帧错误。reason 与 daemon 侧 SarpErrorReason 对齐。"""

    def __init__(self, reason: SarpErrorReason, message: str, frame_type: str | None = None):
        super().__init__(message)
        self.reason = reason
        self.frame_type = frame_type


def _fail(reason: SarpErrorReason, msg: str, frame_type: str | None = None) -> None:
    raise SarpProtocolError(reason, msg, frame_type)


def _req_str(o: dict, key: str, t: str) -> str:
    v = o.get(key)
    if not isinstance(v, str) or v == "":
        _fail("invalid-schema", f"{t}.{key}: non-empty string required", t)
    return v


def _req_str_allow_empty(o: dict, key: str, t: str) -> str:
    """必填字符串但允许空串——daemon 缺省路径可能发 agent.id=""（见
    persistent-jsonl-worker.ts initFields 的 fallback）。"""
    v = o.get(key)
    if not isinstance(v, str):
        _fail("invalid-schema", f"{t}.{key}: string required", t)
    return v


def _opt_str(o: dict, key: str, t: str) -> str | None:
    v = o.get(key)
    if v is None:
        return None
    if not isinstance(v, str):
        _fail("invalid-schema", f"{t}.{key}: string required", t)
    return v


def _req_obj(o: dict, key: str, t: str) -> dict:
    v = o.get(key)
    if not isinstance(v, dict):
        _fail("invalid-schema", f"{t}.{key}: object required", t)
    return v


def _opt_obj(o: dict, key: str, t: str) -> dict | None:
    v = o.get(key)
    if v is None:
        return None
    if not isinstance(v, dict):
        _fail("invalid-schema", f"{t}.{key}: object required", t)
    return v


def _req_int(o: dict, key: str, t: str) -> int:
    v = o.get(key)
    if not isinstance(v, int) or isinstance(v, bool) or v < 0:
        _fail("invalid-schema", f"{t}.{key}: non-negative integer required", t)
    return v


def _opt_num(o: dict, key: str, t: str) -> float | None:
    v = o.get(key)
    if v is None:
        return None
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        _fail("invalid-schema", f"{t}.{key}: finite number required", t)
    return v


def _opt_bool(o: dict, key: str, t: str) -> bool | None:
    v = o.get(key)
    if v is None:
        return None
    if not isinstance(v, bool):
        _fail("invalid-schema", f"{t}.{key}: boolean required", t)
    return v


def decode_daemon_frame(line: bytes | str) -> SarpDaemonMessage | None:
    """解码一行 daemon→worker 帧。

    - 返回 None：未知 type 且 optional:true（§8.1.5 显式忽略）。
    - 抛 SarpProtocolError：坏帧/信封非法/版本不符/schema 失败/未知非 optional。
    """
    text = line.decode("utf-8") if isinstance(line, (bytes, bytearray)) else line
    if len(text.encode("utf-8")) > SARP_MAX_FRAME_BYTES:
        _fail("frame-too-large", f"frame exceeds {SARP_MAX_FRAME_BYTES} bytes")
    try:
        raw = json.loads(text)
    except Exception:
        _fail("invalid-json", "frame is not valid JSON")
    if not isinstance(raw, dict):
        _fail("invalid-envelope", "frame must be a JSON object")
    o: dict = raw
    t = o.get("type") if isinstance(o.get("type"), str) else None

    if o.get("protocol") != SARP_PROTOCOL:
        _fail("invalid-envelope", f'protocol must be "{SARP_PROTOCOL}"', t)
    if o.get("version") != SARP_VERSION:
        _fail("unsupported-version", f"version must be {SARP_VERSION}", t)
    if not isinstance(t, str) or t == "":
        _fail("invalid-envelope", "type: non-empty string required")
    seq = o.get("seq")
    if not isinstance(seq, int) or isinstance(seq, bool) or seq <= 0:
        _fail("invalid-envelope", "seq: positive integer required", t)
    ts = o.get("timestamp")
    if not isinstance(ts, str) or ts == "":
        _fail("invalid-envelope", "timestamp: ISO 8601 string required", t)
    optional = o.get("optional") is True
    if "optional" in o and not isinstance(o["optional"], bool):
        _fail("invalid-envelope", "optional: boolean required", t)

    if t == "initialize":
        agent = _req_obj(o, "agent", t)
        runtime = _req_obj(o, "runtime", t)
        workspace = _req_obj(o, "workspace", t)
        platform = _opt_obj(o, "platform", t) or {}
        limits = _req_obj(o, "limits", t)
        mcp = _opt_obj(platform, "mcp", f"{t}.platform")
        mcp_args: tuple[str, ...] = ()
        mcp_env: dict[str, str] | None = None
        if mcp is not None:
            raw_args = mcp.get("args", [])
            if not isinstance(raw_args, list):
                _fail("invalid-schema", f"{t}.platform.mcp.args: array required", t)
            mcp_args = tuple(_req_str_item(a, f"{t}.platform.mcp.args") for a in raw_args)
            raw_env = mcp.get("env")
            if raw_env is not None:
                if not isinstance(raw_env, dict):
                    _fail("invalid-schema", f"{t}.platform.mcp.env: object required", t)
                mcp_env = {str(k): str(v) for k, v in raw_env.items()}
        return SarpInitialize(
            seq=seq,
            request_id=_req_str(o, "requestId", t),
            agent=SarpAgentInfo(
                id=_req_str_allow_empty(agent, "id", f"{t}.agent"),
                name=_req_str(agent, "name", f"{t}.agent"),
                display_name=_opt_str(agent, "displayName", f"{t}.agent"),
                description=_opt_str(agent, "description", f"{t}.agent"),
            ),
            runtime_id=_req_str(runtime, "id", f"{t}.runtime"),
            entrypoint=_req_str(runtime, "entrypoint", f"{t}.runtime"),
            model=_opt_str(runtime, "model", f"{t}.runtime"),
            revision=_opt_str(runtime, "revision", f"{t}.runtime"),
            workspace_path=_req_str(workspace, "path", f"{t}.workspace"),
            system_prompt=_opt_str(platform, "systemPrompt", f"{t}.platform"),
            server_url=_opt_str(platform, "serverUrl", f"{t}.platform"),
            token_file=_opt_str(platform, "tokenFile", f"{t}.platform"),
            mcp=(
                SarpMcpDescriptor(command=_req_str(mcp, "command", f"{t}.platform.mcp"), args=mcp_args, env=mcp_env)
                if mcp
                else None
            ),
            max_frame_bytes=_req_int(limits, "maxFrameBytes", f"{t}.limits"),
            silence_timeout_ms=_req_int(limits, "silenceTimeoutMs", f"{t}.limits"),
            shutdown_timeout_ms=(
                int(v) if (v := _opt_num(limits, "shutdownTimeoutMs", f"{t}.limits")) is not None else None
            ),
        )
    if t == "turn.start":
        src = _req_obj(o, "source", t)
        resume = _opt_obj(o, "resume", t)
        return SarpTurnStart(
            seq=seq,
            turn_id=_req_str(o, "turnId", t),
            conversation_id=_req_str(o, "conversationId", t),
            attempt=_req_int(o, "attempt", t),
            source=SarpTurnSource(
                kind=_req_str(src, "kind", f"{t}.source"),
                channel=_opt_str(src, "channel", f"{t}.source"),
                thread_id=_opt_str(src, "threadId", f"{t}.source"),
                sender=_opt_str(src, "sender", f"{t}.source"),
            ),
            prompt=_req_str(o, "prompt", t),
            resume=(
                SarpResume(
                    interrupt_id=_req_str(resume, "interruptId", f"{t}.resume"),
                    resume_token=_req_str(resume, "resumeToken", f"{t}.resume"),
                    value=_req_str(resume, "value", f"{t}.resume"),
                )
                if resume
                else None
            ),
        )
    if t == "turn.cancel":
        return SarpTurnCancel(seq=seq, turn_id=_req_str(o, "turnId", t), reason=_req_str(o, "reason", t))
    if t == "shutdown":
        return SarpShutdown(seq=seq, reason=_opt_str(o, "reason", t), timeout_ms=(
            int(v) if (v := _opt_num(o, "timeoutMs", t)) is not None else None
        ))

    # §8.1.5：未知 type 仅当显式 optional:true 才允许忽略
    if optional:
        return None
    _fail("unexpected-message", f"unknown message type: {t}", t)


def _req_str_item(v: Any, t: str) -> str:
    if not isinstance(v, str) or v == "":
        _fail("invalid-schema", f"{t}: non-empty string required", t)
    return v


class SarpInbound:
    """入向 daemon→worker seq 单调校验（§8.1.2）。每进程一个实例。"""

    def __init__(self) -> None:
        self._last_seq = 0

    def next(self, line: bytes | str) -> SarpDaemonMessage | None:
        msg = decode_daemon_frame(line)
        if msg is None:
            return None
        if msg.seq <= self._last_seq:
            _fail("unexpected-message", f"inbound seq regression: {msg.seq} <= {self._last_seq}", None)
        self._last_seq = msg.seq
        return msg


# ---------------------------------------------------------------------------
# worker → daemon（编码）
# ---------------------------------------------------------------------------


def encode_worker_frame(frame_type: str, seq: int, timestamp: str, **fields: Any) -> str:
    """编码一帧 worker→daemon（含尾部换行）。None 字段不写。"""
    body: dict[str, Any] = {
        "protocol": SARP_PROTOCOL,
        "version": SARP_VERSION,
        "type": frame_type,
        "seq": seq,
        "timestamp": timestamp,
    }
    for k, v in fields.items():
        if v is not None:
            body[k] = v
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")) + "\n"
