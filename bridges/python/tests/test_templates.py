"""bridges/templates/ 冒烟：probe + 无 provider 单回合生命周期。

两个模板都是「可复制」的自包含 worker。子进程显式清掉 PYTHONPATH——
clean-wheel 冒烟时 slock_runtime 只能来自该解释器的 site-packages，
防止意外命中源码 checkout。
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

TEMPLATES = Path(__file__).resolve().parents[2] / "templates"

# template 目录名 → (runtime_id, 单回合所需框架包, probe 期望能力)
CASES = {
    "langchain-agent": ("langchain", "langchain_core", {"durableThreads": False, "interrupts": False}),
    "langgraph-agent": ("langgraph", "langgraph", {"durableThreads": True, "interrupts": True}),
}


def _child_env() -> dict:
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env["PYTHONUNBUFFERED"] = "1"
    return env


def _init_frame(runtime_id: str, workspace: Path) -> dict:
    return dict(
        requestId="req-1",
        agent={"id": "ag-1", "name": "bot"},
        runtime={"id": runtime_id, "entrypoint": "e1"},
        workspace={"path": str(workspace)},
        platform={},
        limits={"maxFrameBytes": 1048576, "silenceTimeoutMs": 300000},
    )


@pytest.mark.parametrize("template", list(CASES))
def test_template_probe(template):
    """模板 agent.py --slock-probe：单行 probe.result，exit 0（§8.4）。

    不 importorskip——probe 必须跑在加载框架依赖之前。
    """
    runtime_id, _, caps = CASES[template]
    agent = TEMPLATES / template / "agent.py"
    r = subprocess.run(
        [sys.executable, str(agent), "--slock-probe"],
        capture_output=True,
        text=True,
        timeout=30,
        env=_child_env(),
    )
    assert r.returncode == 0, r.stderr
    lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
    assert len(lines) == 1, r.stdout
    frame = json.loads(lines[0])
    assert frame["protocol"] == "slock.agent-runtime" and frame["version"] == 1
    assert frame["type"] == "probe.result" and frame["probe"] is True
    assert frame["runtime"]["id"] == runtime_id
    assert frame["runtime"]["bridgeVersion"].startswith("slock-runtime/")
    for key, expected in {
        "persistentProcess": True,
        "maxConcurrency": 1,
        "pty": False,
        **caps,
    }.items():
        assert frame["capabilities"][key] is expected, key
    assert frame["model"] == {"overrides": True}


class _Worker:
    """子进程 worker：逐帧写 stdin，后台线程把 stdout 行排进队列。"""

    def __init__(self, template: str, cwd: Path):
        self.proc = subprocess.Popen(
            [sys.executable, str(TEMPLATES / template / "agent.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(cwd),
            env=_child_env(),
        )
        self._q: queue.Queue[str] = queue.Queue()
        self._seq = 0
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self._q.put(line)

    def send(self, type_: str, **fields) -> None:
        self._seq += 1
        frame = {
            "protocol": "slock.agent-runtime",
            "version": 1,
            "type": type_,
            "seq": self._seq,
            "timestamp": "2026-09-20T00:00:00.000Z",
            **fields,
        }
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(frame) + "\n")
        self.proc.stdin.flush()

    def wait(self, pred, timeout: float = 30.0) -> dict:
        deadline = time.time() + timeout
        seen: list[str] = []
        while time.time() < deadline:
            try:
                line = self._q.get(timeout=0.2)
            except queue.Empty:
                continue
            frame = json.loads(line)
            seen.append(frame.get("type", "?"))
            if pred(frame):
                return frame
        raise AssertionError(f"timed out waiting; saw {seen}")

    def kill(self) -> str:
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(timeout=10)
        assert self.proc.stderr is not None
        return self.proc.stderr.read()


@pytest.mark.parametrize("template", list(CASES))
def test_template_one_turn(tmp_path, template):
    """无 provider 单回合：initialize → runtime.ready → turn.start →
    turn.end(success, Echo) → shutdown → runtime.stopped → exit 0。"""
    runtime_id, framework_pkg, _ = CASES[template]
    pytest.importorskip(framework_pkg, reason=f"{framework_pkg} 未安装")

    w = _Worker(template, tmp_path)
    try:
        w.send("initialize", **_init_frame(runtime_id, tmp_path))
        ready = w.wait(lambda f: f["type"] == "runtime.ready")
        assert ready["requestId"] == "req-1"
        assert ready["runtime"]["id"] == runtime_id
        assert ready["capabilities"]["persistentProcess"] is True
        # 握手期 overrides 权威：模板无持久 checkpointer / 无 MCP
        assert ready["capabilities"]["durableThreads"] is False
        assert ready["capabilities"]["mcp"] is False

        w.send(
            "turn.start",
            turnId="t1",
            conversationId="c1",
            attempt=1,
            source={"kind": "channel", "channel": "general"},
            prompt="hi",
        )
        end = w.wait(lambda f: f["type"] == "turn.end")
        assert end["turnId"] == "t1" and end["status"] == "success"
        assert end["finalText"] == "Echo: hi"

        w.send("shutdown")
        w.wait(lambda f: f["type"] == "runtime.stopped")
        assert w.proc.wait(timeout=15) == 0
    finally:
        stderr = w.kill()
        assert w.proc.returncode == 0, stderr
