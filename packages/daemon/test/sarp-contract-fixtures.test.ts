/**
 * 跨语言 contract fixtures（Phase 3）。
 *
 * bridges/fixtures/*.jsonl 是 SARP/1 的规范帧序列，两侧共享：
 * - daemon→worker.jsonl：由本文件的 encodeSarpFrame 生成（权威编码器）；
 *   Python 侧 test_contract_fixtures.py 用 decode_daemon_frame 逐行解码校验。
 * - worker→daemon.jsonl：Python encode_worker_frame 应能产生等价帧；
 *   本文件用 decodeSarpWorkerFrame 逐行解码校验（daemon 侧契约保证）。
 *
 * 重新生成：SARP_WRITE_FIXTURES=1 pnpm vitest run sarp-contract-fixtures
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeSarpWorkerFrame, encodeSarpFrame, type SarpDaemonFrame, SarpInbound } from "../src/sarp-protocol.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../bridges/fixtures");
const TS = "2026-09-20T00:00:00.000Z";

/* ------------------------- daemon → worker ------------------------- */

const DAEMON_FRAMES: SarpDaemonFrame[] = [
  {
    type: "initialize",
    fields: {
      requestId: "req-fixture-1",
      agent: { id: "ag_1", name: "bot", displayName: "Bot", description: "fixture agent" },
      runtime: { id: "langgraph", entrypoint: "lg-agent", model: "gpt-4o-mini" },
      workspace: { path: "/tmp/slock-ws" },
      platform: {
        systemPrompt: "You are a fixture.",
        serverUrl: "wss://server.example",
        tokenFile: "/tmp/slock-ws/.slock/token",
        mcp: {
          command: "node",
          args: ["mcp-server.js", "--flag"],
          env: { SLOCK_TOKEN_FILE: "/tmp/slock-ws/.slock/token" },
        },
      },
      limits: { maxFrameBytes: 1048576, silenceTimeoutMs: 300000, shutdownTimeoutMs: 5000 },
    },
  },
  {
    // 最小集：platform 空、runtime 无 model、limits 无 shutdownTimeoutMs
    type: "initialize",
    fields: {
      requestId: "req-fixture-2",
      agent: { id: "ag_2", name: "min" },
      runtime: { id: "langchain", entrypoint: "lc-agent" },
      workspace: { path: "C:\\ws\\win path" },
      platform: {},
      limits: { maxFrameBytes: 1048576, silenceTimeoutMs: 60000 },
    },
  },
  {
    type: "turn.start",
    fields: {
      turnId: "t-1",
      conversationId: "slock:v1:ag_1:thread:th-9",
      attempt: 1,
      source: { kind: "thread", channel: "general", threadId: "th-9", sender: "user-7" },
      prompt: "第一回合：含 CJK 与 emoji 🚀",
    },
  },
  {
    type: "turn.start",
    fields: {
      turnId: "t-2",
      conversationId: "slock:v1:ag_1:thread:th-9",
      attempt: 2,
      source: { kind: "thread", channel: "general", threadId: "th-9" },
      prompt: "resume after interrupt",
      resume: { interruptId: "lg-abc123", resumeToken: "rt-deadbeef", value: "approved: yes" },
    },
  },
  {
    type: "turn.start",
    fields: {
      turnId: "t-3",
      conversationId: "slock:v1:ag_1:channel:general",
      attempt: 1,
      source: { kind: "channel", channel: "general" },
      prompt: "multi\nline\nprompt",
    },
  },
  { type: "turn.cancel", fields: { turnId: "t-3", reason: "user-requested" } },
  { type: "shutdown", fields: { reason: "idle-reclaim", timeoutMs: 4000 } },
  { type: "shutdown", fields: {} },
];

/* ------------------------- worker → daemon ------------------------- */

const WORKER_LINES: Record<string, unknown>[] = [
  {
    type: "runtime.ready",
    requestId: "req-fixture-1",
    runtime: { id: "langgraph", frameworkVersion: "langgraph 0.2.x", bridgeVersion: "slock-runtime/0.1" },
    capabilities: {
      persistentProcess: true,
      streamingText: true,
      toolEvents: true,
      durableThreads: true,
      interrupts: true,
      mcp: true,
      usage: "tokens",
      maxConcurrency: 1,
    },
    model: { selected: "gpt-4o-mini", overrides: true },
  },
  { type: "assistant.delta", turnId: "t-1", eventSeq: 1, text: "你好" },
  { type: "assistant.delta", turnId: "t-1", eventSeq: 2, text: "，世界" },
  { type: "assistant.progress", turnId: "t-1", eventSeq: 3, message: "检索中…" },
  {
    type: "tool.start",
    turnId: "t-1",
    eventSeq: 4,
    callId: "call-1",
    tool: { name: "slock_send_message", provider: "slock-mcp", operation: "send" },
    input: { channel: "general", text: "hi" },
  },
  {
    type: "tool.end",
    turnId: "t-1",
    eventSeq: 5,
    callId: "call-1",
    tool: { name: "slock_send_message", provider: "slock-mcp", operation: "send" },
    ok: true,
    output: { sent: true },
  },
  {
    type: "tool.end",
    turnId: "t-1",
    eventSeq: 6,
    callId: "call-2",
    tool: { name: "lookup" },
    ok: false,
    error: "tool exploded",
  },
  { type: "assistant.message", turnId: "t-1", eventSeq: 7, text: "完整答复" },
  {
    type: "usage",
    turnId: "t-1",
    eventSeq: 8,
    usage: {
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
      durationMs: 2100,
      numTurns: 1,
      model: "gpt-4o-mini",
    },
  },
  {
    type: "turn.end",
    turnId: "t-1",
    eventSeq: 9,
    status: "success",
    finalText: "你好，世界",
    sessionRef: "sess-1",
    usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 },
  },
  {
    type: "turn.interrupt",
    turnId: "t-2",
    eventSeq: 1,
    interruptId: "lg-abc123",
    resumeToken: "rt-deadbeef",
    prompt: "批准执行敏感操作？",
    payload: { question: "approve?" },
  },
  {
    type: "turn.end",
    turnId: "t-2",
    eventSeq: 2,
    status: "interrupted",
    interrupt: {
      interruptId: "lg-abc123",
      resumeToken: "rt-deadbeef",
      prompt: "批准执行敏感操作？",
      payload: { question: "approve?" },
    },
  },
  { type: "turn.end", turnId: "t-3", eventSeq: 1, status: "cancelled" },
  {
    type: "turn.end",
    turnId: "t-4",
    eventSeq: 1,
    status: "error",
    error: { code: "MODEL_RATE_LIMITED", message: "429 too many", retryable: true, retryAfterMs: 2500 },
  },
  { type: "runtime.warning", code: "FRAME_TRUNCATED", message: "delta exceeded max frame" },
  {
    type: "runtime.error",
    requestId: "req-x",
    error: { code: "MCP_START_FAILED", message: "mcp spawn failed", retryable: true },
  },
  { type: "runtime.stopped", reason: "shutdown" },
];

const enc = (f: SarpDaemonFrame, seq: number) => encodeSarpFrame(f, seq, { timestamp: TS });
const encWorker = (o: Record<string, unknown>, seq: number) =>
  JSON.stringify({ protocol: "slock.agent-runtime", version: 1, seq, timestamp: TS, ...o }) + "\n";

const daemonJsonl = DAEMON_FRAMES.map((f, i) => enc(f, i + 1)).join("");
const workerJsonl = WORKER_LINES.map((o, i) => encWorker(o, i + 1)).join("");

describe("SARP/1 cross-language fixtures", () => {
  it("daemon→worker fixture matches encodeSarpFrame output", () => {
    const path = join(FIXTURE_DIR, "daemon-to-worker.jsonl");
    if (process.env.SARP_WRITE_FIXTURES) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(path, daemonJsonl);
    }
    expect(readFileSync(path, "utf-8")).toBe(daemonJsonl);
  });

  it("worker→daemon fixture decodes cleanly (all 16 frames)", () => {
    const path = join(FIXTURE_DIR, "worker-to-daemon.jsonl");
    if (process.env.SARP_WRITE_FIXTURES) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(path, workerJsonl);
    }
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(WORKER_LINES.length);
    const inbound = new SarpInbound();
    const decoded = lines.map((l) => inbound.next(l));
    expect(decoded.every((m) => m !== null)).toBe(true);
    expect(decoded.map((m) => m!.type)).toEqual(WORKER_LINES.map((o) => o.type));
    // 关键字段抽查：turn.end interrupted 的 interrupt 三要素完整
    const intr = decoded.find((m) => m!.type === "turn.end" && (m as { status?: string }).status === "interrupted") as {
      interrupt?: { interruptId: string; resumeToken: string; prompt: string };
    };
    expect(intr?.interrupt?.interruptId).toBe("lg-abc123");
    expect(intr?.interrupt?.resumeToken).toBe("rt-deadbeef");
  });
});
