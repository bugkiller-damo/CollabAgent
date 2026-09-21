"""跨语言 contract fixtures：bridges/fixtures/*.jsonl 双侧共享。

- daemon-to-worker.jsonl：由 daemon encodeSarpFrame 生成（权威），
  本文件逐行 decode_daemon_frame 解码并断言关键字段——证明 Python
  解码器吃得了 daemon 真实输出。
- worker-to-daemon.jsonl：本文件用 encode_worker_frame 重建每帧并与
  fixture 字段级比对——证明 Python 编码器产出 daemon 能解码的形状
  （daemon 侧 sarp-contract-fixtures.test.ts 已验证解码）。
"""

from __future__ import annotations

import json
from pathlib import Path

from slock_runtime.protocol import (
    SarpInitialize,
    SarpShutdown,
    SarpTurnCancel,
    SarpTurnStart,
    decode_daemon_frame,
    encode_worker_frame,
)

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "fixtures"


def _lines(name: str) -> list[str]:
    text = (FIXTURE_DIR / name).read_text(encoding="utf-8")
    return [line for line in text.splitlines() if line.strip()]


class TestDaemonToWorker:
    def test_all_frames_decode(self):
        msgs = [decode_daemon_frame(line) for line in _lines("daemon-to-worker.jsonl")]
        known = [m for m in msgs if m is not None]
        types = [type(m).__name__ for m in known]
        assert types.count("SarpInitialize") == 2
        assert types.count("SarpTurnStart") == 3
        assert types.count("SarpTurnCancel") == 1
        assert types.count("SarpShutdown") == 2

    def test_initialize_fields(self):
        init = decode_daemon_frame(_lines("daemon-to-worker.jsonl")[0])
        assert isinstance(init, SarpInitialize)
        assert init.request_id == "req-fixture-1"
        assert init.runtime_id == "langgraph" and init.model == "gpt-4o-mini"
        assert init.mcp is not None and init.mcp.args == ("mcp-server.js", "--flag")
        assert init.mcp.env == {"SLOCK_TOKEN_FILE": "/tmp/slock-ws/.slock/token"}
        assert init.shutdown_timeout_ms == 5000

    def test_minimal_initialize(self):
        init = decode_daemon_frame(_lines("daemon-to-worker.jsonl")[1])
        assert init.mcp is None and init.system_prompt is None and init.shutdown_timeout_ms is None

    def test_turn_start_variants(self):
        msgs = [decode_daemon_frame(line) for line in _lines("daemon-to-worker.jsonl")]
        turns = [m for m in msgs if isinstance(m, SarpTurnStart)]
        assert turns[0].source.sender == "user-7"
        assert "CJK" in turns[0].prompt and "\U0001f680" in turns[0].prompt  # UTF-8 无损
        assert turns[1].resume is not None and turns[1].resume.value == "approved: yes"
        assert turns[2].prompt == "multi\nline\nprompt"  # 嵌换行转义还原
        cancels = [m for m in msgs if isinstance(m, SarpTurnCancel)]
        assert cancels[0].turn_id == "t-3" and cancels[0].reason == "user-requested"
        shutdowns = [m for m in msgs if isinstance(m, SarpShutdown)]
        assert shutdowns[0].timeout_ms == 4000 and shutdowns[1].reason is None


class TestWorkerToDaemon:
    """对 fixture 每帧：拆出 type + 业务字段，用 encode_worker_frame 重建后
    与原 JSON 字段级比对（seq/timestamp 由各自侧分配，跳过）。"""

    ENVELOPE_KEYS = {"protocol", "version", "type", "seq", "timestamp"}

    def test_each_frame_reencodes_equal(self):
        for raw_line in _lines("worker-to-daemon.jsonl"):
            orig = json.loads(raw_line)
            ftype = orig["type"]
            payload = {k: v for k, v in orig.items() if k not in self.ENVELOPE_KEYS}
            re_line = encode_worker_frame(ftype, orig["seq"], orig["timestamp"], **payload)
            re = json.loads(re_line)
            assert re == orig, f"{ftype} frame re-encode mismatch"
