"""errors.py：provider 异常 → wire 码映射（§15.4）。"""

from __future__ import annotations

from slock_runtime.errors import (
    GRAPH_INPUT_INVALID,
    MODEL_RATE_LIMITED,
    PROVIDER_AUTH_FAILED,
    PROVIDER_NETWORK_FAILED,
    WORKER_ERROR,
    SarpError,
    map_provider_error,
)


def _cls(name: str):
    return type(name, (Exception,), {})


class TestMapProviderError:
    def test_sarp_error_passthrough(self):
        e = SarpError(GRAPH_INPUT_INVALID, "bad input", retryable=False)
        w = map_provider_error(e)
        assert w.code == GRAPH_INPUT_INVALID and w.retryable is False

    def test_rate_limit_by_name(self):
        w = map_provider_error(_cls("RateLimitError")("slow down"))
        assert w.code == MODEL_RATE_LIMITED and w.retryable is True

    def test_rate_limit_by_429(self):
        exc = _cls("APIStatusError")("boom")
        exc.status_code = 429
        w = map_provider_error(exc)
        assert w.code == MODEL_RATE_LIMITED and w.retryable is True

    def test_auth_by_name_and_status(self):
        assert map_provider_error(_cls("AuthenticationError")("no")).code == PROVIDER_AUTH_FAILED
        exc = _cls("Whatever")("denied")
        exc.status_code = 403
        w = map_provider_error(exc)
        assert w.code == PROVIDER_AUTH_FAILED and w.retryable is False

    def test_network_5xx_and_name(self):
        exc = _cls("APIStatusError")("upstream")
        exc.status_code = 503
        assert map_provider_error(exc).code == PROVIDER_NETWORK_FAILED
        assert map_provider_error(_cls("APITimeoutError")("t")).code == PROVIDER_NETWORK_FAILED

    def test_input_invalid_400_and_valueerror(self):
        exc = _cls("BadRequestError")("bad")
        exc.status_code = 400
        assert map_provider_error(exc).code == GRAPH_INPUT_INVALID
        assert map_provider_error(ValueError("x")).code == GRAPH_INPUT_INVALID

    def test_unknown_falls_to_worker_error(self):
        w = map_provider_error(_cls("BizarreFailure")("?"))
        assert w.code == WORKER_ERROR

    def test_retry_after_from_attr_and_header(self):
        exc = _cls("RateLimitError")("rl")
        exc.retry_after = 2.5
        assert map_provider_error(exc).retry_after_ms == 2500

        class Resp:
            headers = {"retry-after": "3"}

        exc2 = _cls("RateLimitError")("rl")
        exc2.response = Resp()
        assert map_provider_error(exc2).retry_after_ms == 3000

    def test_message_truncated(self):
        w = map_provider_error(_cls("WeirdError")("x" * 9999))
        assert len(w.message) <= 500
