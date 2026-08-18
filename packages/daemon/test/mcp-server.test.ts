import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleSlockMcpServer } from "../src/mcp-bundle.js";

/**
 * `slock-mcp-server.ts` 是一个独立子进程（由 Claude Code 通过 `.mcp.json`
 * 以 stdio 拉起，见 agent-runtime-spawn.ts 的 writeMcpConfig），不跑在 daemon
 * 主进程里，也不共享主进程的 fetch mock（test/fakes/fake-fetch.ts 打的是
 * globalThis.fetch，对子进程无效）。所以这里起一个真的本地 HTTP server 模拟
 * `/internal/agent/:id/...`，把打包产物当真实子进程跑，用裸 JSON-RPC 消息
 * 驱一遍 MCP 协议，验证：(1) 打包产物真的能跑起来、工具 schema 不会在
 * registerTool 时炸；(2) 每个工具调用真的打到了预期的 HTTP 路径 + 带上了
 * Bearer token；(3) 失败响应会变成 isError:true 而不是让子进程崩掉。
 */

let bundlePath: string;
let server: Server;
let serverUrl: string;
let lastRequest: { method: string; path: string; auth: string | undefined; body: unknown } | null = null;
let nextStatus = 200;
let nextBody: unknown = { ok: true };

beforeAll(async () => {
  const path = await bundleSlockMcpServer();
  if (!path) throw new Error("MCP bundle failed to build");
  bundlePath = path;

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      lastRequest = {
        method: req.method || "",
        path: req.url || "",
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      };
      res.writeHead(nextStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(nextBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("failed to bind test server");
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 起一个 MCP server 子进程，跑完 initialize 握手，返回可以继续发请求的 helper。 */
async function spawnMcpClient(envOverrides: Record<string, string | undefined> = {}) {
  // O11：envOverrides 支持覆盖/删除（undefined）默认 env，用于 TOKEN_FILE 用例
  const env: Record<string, string> = {
    ...process.env,
    SLOCK_AGENT_ID: "agent-under-test",
    SLOCK_AGENT_TOKEN: "sk_agent_test_token",
    SLOCK_SERVER_URL: serverUrl,
  } as Record<string, string>;
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const proc: ChildProcessWithoutNullStreams = spawn("node", [bundlePath], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buf = "";
  const pending = new Map<number, (msg: any) => void>();
  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });

  let nextId = 1;
  const send = (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`MCP call '${method}' timed out`)), 12_000);
    });
  };
  const notify = (method: string, params?: unknown): void => {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };

  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  });
  notify("notifications/initialized");

  return {
    callTool: (name: string, args: Record<string, unknown>) => send("tools/call", { name, arguments: args }),
    listTools: () => send("tools/list"),
    close: () => proc.kill(),
  };
}

// 每个测试都真的 spawn 一个 node 子进程 + 走一遍 initialize 握手，在整个套件
// 并发跑（多个测试文件同时用真实定时器/真实子进程）时，vitest 默认的 5000ms
// 单测超时在这台机器上偏紧——单独跑这个文件时全程 <2s，但和其它文件一起跑
// 会偶发超时，不是逻辑 bug，是并发下资源竞争的真实耗时波动。放宽到 15s。
const SPAWN_TEST_TIMEOUT = 15_000;

describe("slock-mcp-server (bundled, spawned as a real child process)", () => {
  it(
    "bundles and boots without throwing, registering all 17 tools",
    async () => {
      const client = await spawnMcpClient();
      try {
        const res = await client.listTools();
        const names = res.result.tools.map((t: any) => t.name).sort();
        expect(names).toEqual(
          [
            "cancel_dispatch",
            "cancel_reminder",
            "check_messages",
            "claim_tasks",
            "create_tasks",
            "dispatch_task",
            "list_dispatches",
            "list_reminders",
            "list_tasks",
            "read_history",
            "report_task",
            "schedule_reminder",
            "search_messages",
            "send_message",
            "unclaim_task",
            "update_task_status",
            "upload_attachment",
          ].sort(),
        );
      } finally {
        client.close();
      }
    },
    SPAWN_TEST_TIMEOUT,
  );

  it(
    "send_message hits POST /internal/agent/:id/send with Bearer token + body, returns structured result",
    async () => {
      nextStatus = 200;
      nextBody = { state: "sent", messageId: "m1", messageSeq: 1, attachments: [] };
      const client = await spawnMcpClient();
      try {
        const res = await client.callTool("send_message", { target: "#general", content: "hi" });
        expect(lastRequest?.method).toBe("POST");
        expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/send");
        expect(lastRequest?.auth).toBe("Bearer sk_agent_test_token");
        expect(lastRequest?.body).toEqual({ target: "#general", content: "hi", threadId: undefined });
        expect(res.result.isError).toBeFalsy();
        expect(JSON.parse(res.result.content[0].text)).toEqual(nextBody);
      } finally {
        client.close();
      }
    },
    SPAWN_TEST_TIMEOUT,
  );

  it(
    "O11：SLOCK_AGENT_TOKEN_FILE 优先于字面量 env——从文件读 token 且 env 无需明文",
    async () => {
      nextStatus = 200;
      nextBody = { state: "sent", messageId: "m2", messageSeq: 2, attachments: [] };
      const tokenFile = join(tmpdir(), `slock-mcp-tokenfile-${process.pid}-${Date.now()}`);
      writeFileSync(tokenFile, "sk_agent_from_file_456");
      const client = await spawnMcpClient({
        SLOCK_AGENT_TOKEN: undefined, // 显式删除字面量，证明不依赖它
        SLOCK_AGENT_TOKEN_FILE: tokenFile,
      });
      try {
        const res = await client.callTool("send_message", { target: "#general", content: "hi" });
        expect(res.result.isError).toBeFalsy();
        expect(lastRequest?.auth).toBe("Bearer sk_agent_from_file_456");
      } finally {
        client.close();
        rmSync(tokenFile, { force: true });
      }
    },
    SPAWN_TEST_TIMEOUT,
  );

  it(
    "list_tasks issues a GET with the channel/status as query params",
    async () => {
      nextStatus = 200;
      nextBody = { tasks: [{ id: "t1", task_number: 1, content: "do thing", task_status: "todo" }] };
      const client = await spawnMcpClient();
      try {
        const res = await client.callTool("list_tasks", { channel: "#general", status: "todo" });
        expect(lastRequest?.method).toBe("GET");
        expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/tasks?channel=%23general&status=todo");
        expect(res.result.isError).toBeFalsy();
        expect(JSON.parse(res.result.content[0].text)).toEqual(nextBody);
      } finally {
        client.close();
      }
    },
    SPAWN_TEST_TIMEOUT,
  );

  it(
    "create_tasks maps titles[] into {tasks: [{title}]} on the wire",
    async () => {
      nextStatus = 200;
      nextBody = { tasks: [{ id: "t2", task_number: 2, content: "a" }] };
      const client = await spawnMcpClient();
      try {
        await client.callTool("create_tasks", { channel: "#general", titles: ["a", "b"] });
        expect(lastRequest?.body).toEqual({ channel: "#general", tasks: [{ title: "a" }, { title: "b" }] });
      } finally {
        client.close();
      }
    },
    SPAWN_TEST_TIMEOUT,
  );

  it(
    "surfaces a non-2xx HTTP response as isError:true with the server's error text, not a crash",
    async () => {
      nextStatus = 403;
      nextBody = { error: "no channel access" };
      const client = await spawnMcpClient();
      try {
        const res = await client.callTool("send_message", { target: "#secret", content: "hi" });
        expect(res.result.isError).toBe(true);
        expect(res.result.content[0].text).toContain("no channel access");
      } finally {
        client.close();
      }
    },
    SPAWN_TEST_TIMEOUT,
  );
});
