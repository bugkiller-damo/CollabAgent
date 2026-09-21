"""SARP/1 无 provider 单回合冒烟（stdlib-only，干净 venv 可直接跑）。

用法：

    python smoke_one_turn.py <agent.py 路径> <runtime_id>

流程：spawn worker → initialize → runtime.ready（校验 runtime.id）→
turn.start("hi") → turn.end（success 且 finalText == "Echo: hi"）→
shutdown → runtime.stopped → 进程 exit 0。任一环节超时/不符即非零退出。

供 release workflow 的 clean-wheel 冒烟与本地手工验证共用。
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time


def main() -> int:
    agent = os.path.abspath(sys.argv[1])
    runtime_id = sys.argv[2]

    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env["PYTHONUNBUFFERED"] = "1"

    with tempfile.TemporaryDirectory() as ws:
        proc = subprocess.Popen(
            [sys.executable, agent],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=ws,
            env=env,
        )
        frames: queue.Queue[str] = queue.Queue()

        def drain() -> None:
            assert proc.stdout is not None
            for line in proc.stdout:
                frames.put(line)

        threading.Thread(target=drain, daemon=True).start()
        seq = 0

        def send(type_: str, **fields) -> None:
            nonlocal seq
            seq += 1
            frame = {
                "protocol": "slock.agent-runtime",
                "version": 1,
                "type": type_,
                "seq": seq,
                "timestamp": "2026-09-20T00:00:00.000Z",
                **fields,
            }
            assert proc.stdin is not None
            proc.stdin.write(json.dumps(frame) + "\n")
            proc.stdin.flush()

        def wait(pred, timeout: float = 30.0) -> dict:
            deadline = time.time() + timeout
            seen: list[str] = []
            while time.time() < deadline:
                try:
                    line = frames.get(timeout=0.2)
                except queue.Empty:
                    continue
                frame = json.loads(line)
                seen.append(frame.get("type", "?"))
                if pred(frame):
                    return frame
            stderr = proc.stderr.read() if proc.poll() is not None else ""
            raise SystemExit(f"smoke: timeout waiting for frame; saw {seen}; stderr: {stderr[:2000]}")

        try:
            send(
                "initialize",
                requestId="r1",
                agent={"id": "a1", "name": "smoke"},
                runtime={"id": runtime_id, "entrypoint": "smoke"},
                workspace={"path": ws},
                platform={},
                limits={"maxFrameBytes": 1048576, "silenceTimeoutMs": 300000},
            )
            ready = wait(lambda f: f["type"] == "runtime.ready")
            assert ready["runtime"]["id"] == runtime_id, ready

            send(
                "turn.start",
                turnId="t1",
                conversationId="c1",
                attempt=1,
                source={"kind": "channel", "channel": "smoke"},
                prompt="hi",
            )
            end = wait(lambda f: f["type"] == "turn.end")
            assert end["status"] == "success", end
            assert end["finalText"] == "Echo: hi", end

            send("shutdown")
            wait(lambda f: f["type"] == "runtime.stopped")
            rc = proc.wait(timeout=15)
            assert rc == 0, f"worker exit {rc}"
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)

    print(f"smoke OK: {runtime_id} initialize→turn.end(success)→stopped")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main())
