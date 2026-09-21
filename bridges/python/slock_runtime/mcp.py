"""Slock MCP stdio client：加载 initialize.platform.mcp 描述的 MCP server。

纪律（§12.4 / §16）：
- 复用单个 client——不为每次 tool call 起新 MCP server；
- 子进程随 worker 退出清理（close() 由 runtime 关停路径调用）；
- MCP server 的 stderr 透传到 worker stderr（不落 stdout）；
- descriptor.env 里的值视为 secret 载体——永不进协议帧/日志。

实现面：MCP stdio transport = 换行分隔 JSON-RPC 2.0。
只实现 SDK 需要的最小子集：initialize / notifications/initialized /
tools/list / tools/call。
"""

from __future__ import annotations

import contextlib
import json
import subprocess
import sys
import threading
from dataclasses import dataclass
from typing import Any

from .errors import MCP_START_FAILED, SarpError
from .protocol import SarpMcpDescriptor

MCP_PROTOCOL_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "slock-runtime", "version": "0.1"}

# §15.4.5：平台写工具的幂等注入面。这些工具调一次产生一条 server 侧写记录；
# worker 崩溃/A1 重试重跑回合时会按相同顺序再次调用——SDK 自动附
# idempotencyKey=<turnId>:<tool>:<seq>，server 撞键去重返回首次结果。
# 只列 server 侧真正实现了去重的工具；读工具天然幂等无需键。
_WRITE_TOOLS = frozenset({"send_message", "dispatch_task"})


@dataclass(frozen=True)
class McpToolInfo:
    name: str
    description: str
    input_schema: dict


class SlockMcpClient:
    """一个 MCP server 子进程的 JSON-RPC stdio 会话。"""

    def __init__(self, descriptor: SarpMcpDescriptor):
        self._desc = descriptor
        self._proc: subprocess.Popen | None = None
        self._next_id = 1
        self._pending: dict[int, threading.Event] = {}
        self._results: dict[int, Any] = {}
        self._lock = threading.Lock()
        self._reader: threading.Thread | None = None
        self._closed = False
        # 回合上下文：adapter 在 run_turn 开头 set_active_turn(turn_id)。
        # seq 以 (turn, tool) 为键——同一回合内第 n 次 send_message 恒得同键，
        # 重跑同 turnId 时序号自然对齐（§15.4.4 幂等锚）。
        self._active_turn: str | None = None
        self._write_seq: dict[tuple[str, str], int] = {}

    def set_active_turn(self, turn_id: str | None) -> None:
        """回合开始/结束时由 adapter 调用；换回合清空写序号。"""
        with self._lock:
            self._active_turn = turn_id
            self._write_seq.clear()

    # ---------------- 生命周期 ----------------

    def start(self, timeout_s: float = 15.0) -> None:
        """spawn + initialize 握手。失败抛 SarpError(MCP_START_FAILED)。"""
        try:
            self._proc = subprocess.Popen(
                [self._desc.command, *self._desc.args],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=None,  # 透传到我方 stderr
                env=None if self._desc.env is None else {**_safe_base_env(), **self._desc.env},
                text=False,
            )
        except FileNotFoundError as e:
            raise SarpError(MCP_START_FAILED, f"mcp command not found: {self._desc.command}", retryable=True) from e
        except OSError as e:
            raise SarpError(MCP_START_FAILED, f"mcp spawn failed: {e}", retryable=True) from e

        self._reader = threading.Thread(target=self._read_loop, daemon=True, name="mcp-reader")
        self._reader.start()
        try:
            self._request(
                "initialize",
                {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": CLIENT_INFO,
                },
                timeout_s=timeout_s,
            )
            self._notify("notifications/initialized", {})
        except SarpError:
            self.close()
            raise

    def close(self) -> None:
        self._closed = True
        proc = self._proc
        self._proc = None
        if proc is None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            with contextlib.suppress(Exception):
                proc.kill()

    # ---------------- JSON-RPC ----------------

    def _send(self, payload: dict) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or self._closed:
            raise SarpError(MCP_START_FAILED, "mcp client not running", retryable=True)
        try:
            proc.stdin.write(json.dumps(payload).encode("utf-8") + b"\n")
            proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            raise SarpError(MCP_START_FAILED, f"mcp write failed: {e}", retryable=True) from e

    def _request(self, method: str, params: dict, timeout_s: float = 30.0) -> Any:
        with self._lock:
            req_id = self._next_id
            self._next_id += 1
            ev = threading.Event()
            self._pending[req_id] = ev
        self._send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        if not ev.wait(timeout_s):
            with self._lock:
                self._pending.pop(req_id, None)
            raise SarpError(MCP_START_FAILED, f"mcp {method} timeout after {timeout_s}s", retryable=True)
        with self._lock:
            self._pending.pop(req_id, None)
            result = self._results.pop(req_id, None)
        if isinstance(result, dict) and "error" in result:
            raise SarpError(MCP_START_FAILED, f"mcp {method} error: {result['error']}", retryable=True)
        return result.get("result") if isinstance(result, dict) else result

    def _notify(self, method: str, params: dict) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _read_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        while not self._closed:
            line = proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except Exception:
                print("[slock_runtime] mcp: non-JSON line dropped", file=sys.stderr)
                continue
            if not isinstance(msg, dict):
                continue
            rid = msg.get("id")
            if rid is None:
                continue  # server → client notification，忽略
            with self._lock:
                self._results[rid] = msg
                ev = self._pending.get(rid)
            if ev is not None:
                ev.set()

    # ---------------- tools ----------------

    def list_tools(self) -> list[McpToolInfo]:
        result = self._request("tools/list", {})
        tools = []
        for t in (result or {}).get("tools", []):
            tools.append(
                McpToolInfo(
                    name=str(t.get("name", "")),
                    description=str(t.get("description", "")),
                    input_schema=t.get("inputSchema") or {"type": "object", "properties": {}},
                )
            )
        return tools

    def call_tool(self, name: str, arguments: dict, timeout_s: float = 60.0) -> str:
        """tools/call → 拼合 text content 返回。isError 时抛异常由上层映射。"""
        args = dict(arguments)
        with self._lock:
            turn = self._active_turn
            if turn and name in _WRITE_TOOLS and "idempotencyKey" not in args:
                key = (turn, name)
                seq = self._write_seq.get(key, 0)
                self._write_seq[key] = seq + 1
                args["idempotencyKey"] = f"{turn}:{name}:{seq}"
        result = self._request("tools/call", {"name": name, "arguments": args}, timeout_s=timeout_s)
        if result is None:
            return ""
        if result.get("isError"):
            parts = [c.get("text", "") for c in result.get("content", []) if isinstance(c, dict)]
            raise SarpError(MCP_START_FAILED, f"mcp tool {name} failed: {' '.join(parts)[:300]}", retryable=True)
        parts = [
            c.get("text", "")
            for c in result.get("content", [])
            if isinstance(c, dict) and c.get("type") == "text"
        ]
        return "\n".join(p for p in parts if p)


def _safe_base_env() -> dict:
    """MCP server 子进程的最小环境——不继承 worker 全量 env（secret 纪律）。"""
    import os

    keep = ("PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "LANG")
    return {k: os.environ[k] for k in keep if k in os.environ}
