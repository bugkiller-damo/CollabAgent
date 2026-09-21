"""SARP/1 传输层：stdin 读 / stdout 写，行分隔 JSON 帧。

- stdout 只走协议帧——worker 自己的 print/logging 一律去 stderr（§8.1.4）。
- 出向 seq 从 1 起严格递增（runtime.ready 是 seq=1）；入向 seq 由
  SarpInbound 校验单调。
- 出向帧超过 max_frame_bytes（initialize.limits 下发，缺省 1MiB）时
  截断为协议违规告警帧而非写坏帧——§17.1。
"""

from __future__ import annotations

import sys
import threading
from datetime import datetime, timezone
from typing import BinaryIO, TextIO

from .protocol import SARP_MAX_FRAME_BYTES, SarpDaemonMessage, SarpInbound, encode_worker_frame


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class SarpTransport:
    """同步阻塞式传输：reader 线程循环喂消息，writer 串行写 stdout。

    asyncio 版在 runtime 层做调度——本层只做 IO 与序号，不感知回合语义。
    """

    def __init__(
        self,
        stdin: BinaryIO | None = None,
        stdout: TextIO | None = None,
        *,
        max_frame_bytes: int = SARP_MAX_FRAME_BYTES,
    ):
        self._stdin = stdin if stdin is not None else sys.stdin.buffer
        self._stdout = stdout if stdout is not None else sys.stdout
        self.max_frame_bytes = max_frame_bytes
        self.inbound = SarpInbound()
        self._out_seq = 0
        self._write_lock = threading.Lock()

    # ---- 入向 ----

    def read_message(self) -> SarpDaemonMessage | None:
        """读一行并解码。EOF 返回 None；协议错误抛 SarpProtocolError。"""
        line = self._stdin.readline()
        if not line:
            return None
        if not line.strip():
            return self.read_message()
        return self.inbound.next(line)

    # ---- 出向 ----

    def send(self, frame_type: str, **fields) -> int:
        """编码并写一帧，返回分配的 seq。

        Windows 上 sys.stdout 默认是 locale 编码（GBK 等）——必须经
        .buffer 写 UTF-8 原始字节，否则非 ASCII 帧在 daemon 侧解码成乱码。
        """
        with self._write_lock:
            self._out_seq += 1
            line = encode_worker_frame(frame_type, self._out_seq, _utc_now(), **fields)
            data = line.encode("utf-8")
            if len(data) > self.max_frame_bytes:
                # 超帧截断为 warning——比写坏帧让 daemon 杀进程好（§17.1）
                line = encode_worker_frame(
                    "runtime.warning",
                    self._out_seq,
                    _utc_now(),
                    code="FRAME_TRUNCATED",
                    message=f"{frame_type} frame exceeded {self.max_frame_bytes} bytes, dropped",
                )
                data = line.encode("utf-8")
            buf = getattr(self._stdout, "buffer", None)
            if buf is not None:
                buf.write(data)
                buf.flush()
            else:  # 测试桩 StringIO 等
                self._stdout.write(line)
                self._stdout.flush()
            return self._out_seq
