import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
// A7.3：body 只在 JSON 请求时解析；multipart 上传保留 rawBody 供字节级断言
let lastRequest: {
  method: string;
  path: string;
  auth: string | undefined;
  contentType: string;
  body: unknown;
  rawBody: Buffer;
} | null = null;
/** A7.1：拆条会连发多个请求，需要一个完整日志而不是只记最后一条 */
let requestLog: Array<{
  method: string;
  path: string;
  auth: string | undefined;
  contentType: string;
  body: any;
  rawBody: Buffer;
}> = [];
let nextStatus = 200;
let nextBody: unknown = { ok: true };

beforeAll(async () => {
  const path = await bundleSlockMcpServer();
  if (!path) throw new Error("MCP bundle failed to build");
  bundlePath = path;

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      const contentType = String(req.headers["content-type"] || "");
      lastRequest = {
        method: req.method || "",
        path: req.url || "",
        auth: req.headers.authorization,
        contentType,
        body: contentType.includes("application/json") && rawBody.length ? JSON.parse(rawBody.toString()) : undefined,
        rawBody,
      };
      requestLog.push(lastRequest as any);
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

/** A7.3：上传用例创建的临时目录统一回收 */
const tempRoots: string[] = [];
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "slock-mcp-upload-"));
  tempRoots.push(dir);
  return dir;
};
afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
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
    "read_history forwards optional threadId as a query param",
    async () => {
      nextStatus = 200;
      nextBody = { messages: [] };
      const client = await spawnMcpClient();
      try {
        await client.callTool("read_history", { channel: "#general", limit: 10, threadId: "abc12345" });
        expect(lastRequest?.method).toBe("GET");
        expect(lastRequest?.path).toContain("/internal/agent/agent-under-test/history?");
        expect(lastRequest?.path).toContain("channel=%23general");
        expect(lastRequest?.path).toContain("threadId=abc12345");
      } finally {
        client.close();
      }
    },
    SPAWN_TEST_TIMEOUT,
  );

  it(
    "A7.1：>9000 字符自动拆条顺序发送；attachmentIds 只挂最后一条",
    async () => {
      nextStatus = 200;
      nextBody = { state: "sent", messageId: "mx", messageSeq: 1, attachments: [] };
      requestLog = [];
      const client = await spawnMcpClient();
      try {
        // 两个各 ~5000 字符的段落 → 拆成 2 条
        const content = `${"甲".repeat(5000)}\n\n${"乙".repeat(5000)}`;
        const res = await client.callTool("send_message", {
          target: "#general",
          content,
          attachmentIds: ["att-1"],
        });
        expect(res.result.isError).toBeFalsy();

        const sends = requestLog.filter((r) => r.path.endsWith("/send"));
        expect(sends).toHaveLength(2);
        // 保序：第一段在前
        expect(sends[0]!.body.content).toContain("甲");
        expect(sends[0]!.body.content).not.toContain("乙");
        expect(sends[1]!.body.content).toContain("乙");
        // attachmentIds 只随最后一条
        expect(sends[0]!.body.attachmentIds).toBeUndefined();
        expect(sends[1]!.body.attachmentIds).toEqual(["att-1"]);
        // 聚合回执带 autoSplit 计数
        const parsed = JSON.parse(res.result.content[0].text);
        expect(parsed.autoSplit).toBe(2);
      } finally {
        client.close();
      }
    },
    SPAWN_TEST_TIMEOUT,
  );

  it(
    "A7.3：upload_attachment 单文件 .cpp → multipart POST /upload，Content-Type: text/plain",
    async () => {
      nextStatus = 200;
      nextBody = { attachmentId: "att-cpp", filename: "main.cpp", mimeType: "text/plain", sizeBytes: 12 };
      const dir = makeTempDir();
      const file = join(dir, "main.cpp");
      writeFileSync(file, "int main() {}\n");
      const client = await spawnMcpClient();
      try {
        const res = await client.callTool("upload_attachment", { path: file });
        expect(res.result.isError).toBeFalsy();
        expect(lastRequest?.method).toBe("POST");
        expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/upload");
        expect(lastRequest?.auth).toBe("Bearer sk_agent_test_token");
        expect(lastRequest?.contentType).toContain("multipart/form-data");
        const raw = lastRequest!.rawBody;
        expect(raw.includes('filename="main.cpp"')).toBe(true);
        expect(raw.includes("Content-Type: text/plain")).toBe(true);
        expect(JSON.parse(res.result.content[0].text)).toEqual(nextBody);
      } finally {
        client.close();
      }
    },
    SPAWN_TEST_TIMEOUT,
  );

  it(
    "A7.3：upload_attachment 目录 → 自动打 zip，filename=<dir>.zip，Content-Type: application/zip",
    async () => {
      nextStatus = 200;
      nextBody = { attachmentId: "att-zip", filename: "x.zip", mimeType: "application/zip", sizeBytes: 100 };
      const dir = makeTempDir();
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "a.txt"), "hello\n");
      writeFileSync(join(dir, "sub", "b.md"), "# hi\n");
      const client = await spawnMcpClient();
      try {
        const res = await client.callTool("upload_attachment", { path: dir });
        expect(res.result.isError).toBeFalsy();
        expect(lastRequest?.method).toBe("POST");
        expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/upload");
        const raw = lastRequest!.rawBody;
        expect(raw.includes(`filename="${basename(dir)}.zip"`)).toBe(true);
        expect(raw.includes("Content-Type: application/zip")).toBe(true);
        expect(JSON.parse(res.result.content[0].text)).toEqual(nextBody);
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

/**
 * A6：17 工具全覆盖——上面已有 send_message/upload_attachment/list_tasks/
 * create_tasks/read_history 五例，这里补齐其余 12 个：每个至少一例断言
 * 「打到预期 HTTP 路径 + Bearer token + body 映射正确 + isError:false」。
 */
describe("slock-mcp-server 剩余 12 工具（A6 回归网）", () => {
  // 每个用例都 spawn 子进程——并发跑全套件时 5s 默认超时偏紧（见上方注释）
  const itSpawn = (name: string, fn: () => Promise<void>) => it(name, fn, SPAWN_TEST_TIMEOUT);
  const okTool = async (name: string, args: Record<string, unknown>): Promise<void> => {
    nextStatus = 200;
    nextBody = { ok: true };
    const client = await spawnMcpClient();
    try {
      const res = await client.callTool(name, args);
      expect(res.result.isError).toBeFalsy();
      expect(lastRequest?.auth).toBe("Bearer sk_agent_test_token");
    } finally {
      client.close();
    }
  };

  itSpawn("claim_tasks → POST /tasks/claim，taskNumbers→task_numbers", async () => {
    await okTool("claim_tasks", { channel: "#general", taskNumbers: [3, 5] });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/tasks/claim");
    expect(lastRequest?.body).toEqual({ channel: "#general", task_numbers: [3, 5] });
  });

  itSpawn("update_task_status → POST /tasks/update-status", async () => {
    await okTool("update_task_status", { channel: "#general", number: 3, status: "in_progress" });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/tasks/update-status");
    expect(lastRequest?.body).toEqual({ channel: "#general", number: 3, status: "in_progress" });
  });

  itSpawn("unclaim_task → POST /tasks/unclaim，taskNumber→task_number", async () => {
    await okTool("unclaim_task", { channel: "#general", taskNumber: 7 });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/tasks/unclaim");
    expect(lastRequest?.body).toEqual({ channel: "#general", task_number: 7 });
  });

  itSpawn("dispatch_task → POST /dispatch", async () => {
    await okTool("dispatch_task", { channel: "#general", toAgent: "worker-a", text: "做这个" });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/dispatch");
    expect(lastRequest?.body).toEqual({ channel: "#general", toAgent: "worker-a", text: "做这个" });
  });

  itSpawn("list_dispatches → GET /dispatches?channel=&status=", async () => {
    await okTool("list_dispatches", { channel: "#general", status: "open" });
    expect(lastRequest?.method).toBe("GET");
    expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/dispatches?channel=%23general&status=open");
  });

  itSpawn("report_task → POST /dispatch/:id/report", async () => {
    await okTool("report_task", { dispatchId: "d-9", reportText: "做完了", artifacts: ["a.zip"] });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/dispatch/d-9/report");
    expect(lastRequest?.body).toEqual({ reportText: "做完了", artifacts: ["a.zip"] });
  });

  itSpawn("cancel_dispatch → POST /dispatch/:id/cancel", async () => {
    await okTool("cancel_dispatch", { dispatchId: "d-9", reason: "不需要了" });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/dispatch/d-9/cancel");
    expect(lastRequest?.body).toEqual({ reason: "不需要了" });
  });

  itSpawn("check_messages → GET /receive（游标式查收，无参数）", async () => {
    await okTool("check_messages", {});
    expect(lastRequest?.method).toBe("GET");
    expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/receive");
  });

  itSpawn("search_messages → GET /search?q=&channel=&limit=", async () => {
    await okTool("search_messages", { query: "hello", channel: "#general", limit: 5 });
    expect(lastRequest?.method).toBe("GET");
    expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/search?q=hello&channel=%23general&limit=5");
  });

  itSpawn("schedule_reminder → POST /reminders，缺省时区自动补本机 IANA 时区", async () => {
    await okTool("schedule_reminder", { title: "站会", delaySeconds: 600, channel: "#general" });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/reminders");
    const body = lastRequest?.body as any;
    expect(body.title).toBe("站会");
    expect(body.delaySeconds).toBe(600);
    expect(body.channel).toBe("#general");
    // P1.23：daemon 不传时由本机时区兜底——提醒按「用户的钟」触发
    expect(typeof body.timezone).toBe("string");
    expect(body.timezone.length).toBeGreaterThan(0);
  });

  itSpawn("list_reminders → GET /reminders?status=all", async () => {
    await okTool("list_reminders", { status: "all" });
    expect(lastRequest?.method).toBe("GET");
    expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/reminders?status=all");
  });

  itSpawn("cancel_reminder → DELETE /reminders/:id", async () => {
    await okTool("cancel_reminder", { reminderId: "r-42" });
    expect(lastRequest?.method).toBe("DELETE");
    expect(lastRequest?.path).toBe("/internal/agent/agent-under-test/reminders/r-42");
  });
});
