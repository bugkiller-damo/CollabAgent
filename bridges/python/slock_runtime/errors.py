"""SARP/1 wire 错误码与 provider 异常映射。

与 daemon 侧 WIRE_ERROR_MAP（sarp-protocol.ts §15.4）一一对应：
worker 只能报这里定义的码；未映射码在 daemon 侧收敛为永久 worker-error。

纪律（§15）：
- 限流类 → retryable + retryAfterMs（尊重 provider 声明值，daemon 封顶 120s）
- 鉴权类 → permanent
- 网络/供应商不可达 → retryable
- 输入校验 → permanent
- 未分类异常 → WORKER_ERROR（retryable，保守；daemon 侧 worker-error 是永久
  ——worker 想要可重试必须报已知码，所以映射层要尽量吃透 provider 异常）
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# ---- wire 错误码（与 daemon WIRE_ERROR_MAP 的 key 完全对齐）----

MODEL_RATE_LIMITED = "MODEL_RATE_LIMITED"
PROVIDER_RATE_LIMITED = "PROVIDER_RATE_LIMITED"
RATE_LIMITED = "RATE_LIMITED"
MODEL_AUTH_FAILED = "MODEL_AUTH_FAILED"
PROVIDER_AUTH_FAILED = "PROVIDER_AUTH_FAILED"
AUTH_FAILED = "AUTH_FAILED"
MODEL_NETWORK_FAILED = "MODEL_NETWORK_FAILED"
PROVIDER_NETWORK_FAILED = "PROVIDER_NETWORK_FAILED"
NETWORK_FAILED = "NETWORK_FAILED"
MODEL_NOT_ALLOWED = "MODEL_NOT_ALLOWED"
GRAPH_INPUT_INVALID = "GRAPH_INPUT_INVALID"
INPUT_INVALID = "INPUT_INVALID"
MCP_START_FAILED = "MCP_START_FAILED"
RUNTIME_ID_MISMATCH = "RUNTIME_ID_MISMATCH"
DURABLE_THREADS_REQUIRED = "DURABLE_THREADS_REQUIRED"
PROTOCOL_VERSION_UNSUPPORTED = "PROTOCOL_VERSION_UNSUPPORTED"
PROTOCOL_VIOLATION = "PROTOCOL_VIOLATION"
COMMAND_NOT_FOUND = "COMMAND_NOT_FOUND"
CWD_NOT_FOUND = "CWD_NOT_FOUND"
SECRET_ENV_MISSING = "SECRET_ENV_MISSING"
EMPTY_SUCCESS = "EMPTY_SUCCESS"
# worker 内部错误的兜底码（daemon 收敛为永久 worker-error）
WORKER_ERROR = "WORKER_ERROR"


@dataclass(frozen=True)
class WireError:
    code: str
    message: str
    retryable: bool | None = None
    retry_after_ms: int | None = None

    def to_dict(self) -> dict:
        d: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.retryable is not None:
            d["retryable"] = self.retryable
        if self.retry_after_ms is not None:
            d["retryAfterMs"] = self.retry_after_ms
        return d


class SarpError(Exception):
    """携带 wire code 的 worker 内部错误——runtime 层把它落成 turn.end.error
    或 runtime.error。message 不得含 secret（出口脱敏由 daemon 侧再做一次，
    但 worker 自己也要守纪律：§16/§20.5）。"""

    def __init__(self, code: str, message: str, *, retryable: bool | None = None,
                 retry_after_ms: int | None = None):
        super().__init__(message)
        self.wire = WireError(code, message, retryable=retryable, retry_after_ms=retry_after_ms)


# ---- provider 异常 → wire code ----

# 类名匹配表：langchain_core / openai / anthropic / httpx 等异常按
# __class__.__name__ 判定——不 import provider SDK，零依赖兜底。
_RATE_LIMIT_NAMES = {
    "RateLimitError",
    "RateLimited",
    "TooManyRequests",
    "ThrottlingException",
    "ResourceExhausted",  # google
    "QuotaExceeded",
}
_AUTH_NAMES = {
    "AuthenticationError",
    "AuthError",
    "PermissionDeniedError",
    "PermissionDenied",
    "Unauthenticated",
    "Unauthorized",
    "InvalidAPIKey",
    "AccessDeniedException",
}
_NETWORK_NAMES = {
    "APIConnectionError",
    "ConnectError",
    "ConnectTimeout",
    "ReadTimeout",
    "APITimeoutError",
    "TimeoutException",
    "ServiceUnavailable",
    "InternalServerError",
    "APIStatusError",  # 5xx 时由 status 细分（见下）
    "NetworkError",
    "EndpointConnectionError",
}
_INPUT_NAMES = {
    "BadRequestError",
    "ValidationError",
    "InvalidRequestError",
    "GraphInputInvalid",
    "ValueError",
}


def _class_name(exc: BaseException) -> str:
    return type(exc).__name__


def _status_code(exc: BaseException) -> int | None:
    for attr in ("status_code", "status", "http_status"):
        v = getattr(exc, attr, None)
        if isinstance(v, int):
            return v
    resp = getattr(exc, "response", None)
    v = getattr(resp, "status_code", None)
    return v if isinstance(v, int) else None


def _retry_after_ms(exc: BaseException) -> int | None:
    """从 provider 异常取声明的 retry-after（秒级 header → ms）。"""
    for attr in ("retry_after", "retry_after_ms"):
        v = getattr(exc, attr, None)
        if isinstance(v, (int, float)):
            return int(v * 1000) if attr == "retry_after" else int(v)
    resp = getattr(exc, "response", None)
    headers = getattr(resp, "headers", None)
    if headers is not None:
        ra = headers.get("retry-after") or headers.get("Retry-After")
        if ra is not None:
            try:
                return int(float(ra) * 1000)
            except (TypeError, ValueError):
                pass
    return None


def map_provider_error(exc: BaseException) -> WireError:
    """把任意 provider/framework 异常映射为 wire 错误。

    - SarpError 已携带 wire code → 原样透传。
    - 其余按类名 + HTTP status 判定；吃不准的收敛 WORKER_ERROR。
    - message 只取 str(exc) 的前 500 字符（防超长帧 + 防泄漏堆栈细节）。
    """
    if isinstance(exc, SarpError):
        return exc.wire

    name = _class_name(exc)
    status = _status_code(exc)
    msg = str(exc)[:500]
    retry_after = _retry_after_ms(exc)

    if name in _RATE_LIMIT_NAMES or status == 429:
        return WireError(MODEL_RATE_LIMITED, msg, retryable=True, retry_after_ms=retry_after)
    if name in _AUTH_NAMES or status in (401, 403):
        return WireError(PROVIDER_AUTH_FAILED, msg, retryable=False)
    if status is not None and 500 <= status < 600:
        return WireError(PROVIDER_NETWORK_FAILED, msg, retryable=True)
    if status == 400 or name in _INPUT_NAMES:
        return WireError(GRAPH_INPUT_INVALID, msg, retryable=False)
    if name in _NETWORK_NAMES:
        return WireError(PROVIDER_NETWORK_FAILED, msg, retryable=True, retry_after_ms=retry_after)
    return WireError(WORKER_ERROR, msg)
