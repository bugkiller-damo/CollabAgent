"""fake MCP stdio server：newline-delimited JSON-RPC 2.0（测试夹具）。

行为：
- initialize → result（回显 protocolVersion + capabilities + serverInfo）
- notifications/initialized → 无响应；顺带发一条 notifications/message
  （验证 client 正确忽略 server→client notification——无 id 帧不入 pending）
- tools/list → 固定一个 "slock_echo" tool
- tools/call → arguments echo 成 text content；arguments 含
  {"fail": true} → result.isError=true
- 其他带 id 请求 → JSON-RPC method-not-found error
- 非 JSON 行 → JSON-RPC parse error（带 id=null）

stdin/stdout 逐行 JSON；诊断输出一律 stderr。
"""

from __future__ import annotations

import json
import sys

PROTOCOL_VERSION = "2025-06-18"

ECHO_TOOL = {
    "name": "slock_echo",
    "description": "Echo the arguments back as text",
    "inputSchema": {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    },
}


def _send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def _handle(msg: dict) -> None:
    rid = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") or {}

    if method == "initialize":
        _send(
            {
                "jsonrpc": "2.0",
                "id": rid,
                "result": {
                    "protocolVersion": params.get("protocolVersion", PROTOCOL_VERSION),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "fake-mcp", "version": "0.0.1"},
                },
            }
        )
        return
    if method == "notifications/initialized":
        # 合法 notification：无 id、无响应；多发一条干扰 notification
        _send({"jsonrpc": "2.0", "method": "notifications/message", "params": {"level": "info", "data": "fake ready"}})
        return
    if method == "tools/list":
        _send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [ECHO_TOOL]}})
        return
    if method == "tools/call":
        args = params.get("arguments") or {}
        if args.get("fail") is True:
            _send(
                {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "result": {
                        "isError": True,
                        "content": [{"type": "text", "text": "echo failed by request"}],
                    },
                }
            )
            return
        _send(
            {
                "jsonrpc": "2.0",
                "id": rid,
                "result": {
                    "content": [{"type": "text", "text": "echo: " + json.dumps(args, sort_keys=True)}]
                },
            }
        )
        return
    if rid is not None:
        _send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"method not found: {method}"}})


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            _send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
            continue
        if isinstance(msg, dict):
            _handle(msg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
