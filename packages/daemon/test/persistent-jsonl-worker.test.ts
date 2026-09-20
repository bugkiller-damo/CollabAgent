import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeSession, AgentTurnRequest } from "../src/agent-runtime-driver.js";
import type { AgentRuntimeEvent } from "../src/agent-runtime-events.js";
import {
  type JsonlWorkerSessionOptions,
  PersistentJsonlWorkerSession,
} from "../src/drivers/persistent-jsonl-worker.js";
import type { DispatchError } from "../src/errors.js";
import { SARP_PROTOCOL, SARP_VERSION } from "../src/sarp-protocol.js";

/**
 * PersistentJsonlWorkerSession 单元测试——全部走注入式 FakeChild，不起真实进程。
 * worker→daemon 帧需要完整 SARP 信封（protocol/version/seq/timestamp），
 * emit() 自动递增入向 seq；emitRaw 用于构造坏帧 / seq 倒退。
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn((_d: string) => true) };
  kill = vi.fn((_signal?: string) => true);
  pid = 43210;
}

const TS = "2026-09-20T08:00:00.000Z";
const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const catchErr = async (p: Promise<unknown>): Promise<DispatchError> => {
  try {
    await p;
  } catch (err) {
    return err as DispatchError;
  }
  throw new Error("expected promise to reject");
};

interface Harness {
  session: AgentRuntimeSession & { ready: Promise<void> };
  child: FakeChild;
  events: AgentRuntimeEvent[];
  /** 已写进 worker stdin 的帧（JSON.parse 后） */
  frames: () => Record<string, unknown>[];
  /** 写一行 worker→daemon 帧（自动补信封 + 递增 seq；seq 可显式覆盖） */
  emit: (obj: Record<string, unknown>, seq?: number) => void;
  emitReady: (overrides?: Record<string, unknown>) => void;
  /** 写一行原始 stdout（不补信封，用于坏帧/超大帧/seq 倒退） */
  emitRaw: (line: string) => void;
}

let sessions: { stop(): void }[];

const makeSession = (overrides: Partial<JsonlWorkerSessionOptions> = {}): Harness => {
  const child = new FakeChild();
  const events: AgentRuntimeEvent[] = [];
  const lines: string[] = [];
  child.stdin.write.mockImplementation((d: string) => {
    lines.push(d);
    return true;
  });
  let inSeq = 0;
  const emit = (obj: Record<string, unknown>, seq?: number) => {
    child.stdout.emit(
      "data",
      JSON.stringify({
        protocol: SARP_PROTOCOL,
        version: SARP_VERSION,
        timestamp: TS,
        seq: seq ?? ++inSeq,
        ...obj,
      }) + "\n",
    );
  };
  const emitReady = (overrides: Record<string, unknown> = {}) =>
    emit({
      type: "runtime.ready",
      // §8.3：回显 initialize.requestId（session 校验一致性）
      requestId: (JSON.parse(lines[0]!) as { requestId?: string }).requestId,
      runtime: { id: "langgraph", frameworkVersion: "0.6.7", bridgeVersion: "1.0.0" },
      capabilities: { persistentProcess: true, durableThreads: true, maxConcurrency: 1 },
      ...overrides,
    });
  const emitRaw = (line: string) => child.stdout.emit("data", line + "\n");
  const base: JsonlWorkerSessionOptions = {
    agentName: "alice",
    agent: { id: "a1", name: "alice", displayName: "Alice" },
    runtime: "langgraph",
    entrypoint: "ep-1",
    platformPrompt: "PLAT-PROMPT",
    serverUrl: "http://127.0.0.1:3000",
    tokenFile: "D:\\ws\\alice\\.slock\\agent-token",
    workspace: "D:\\ws\\alice",
    spawnSpec: { command: "node", args: ["worker.js"], cwd: "D:\\ws\\alice", env: { FOO: "1" } },
    timeouts: { startupMs: 5000, silenceMs: 5000, shutdownMs: 40 },
    onEvent: (ev) => events.push(ev),
    spawn: (() => child as unknown as ChildProcess) as typeof import("node:child_process").spawn,
  };
  const session = new PersistentJsonlWorkerSession({
    ...base,
    ...overrides,
    timeouts: { ...base.timeouts, ...(overrides.timeouts ?? {}) },
  });
  sessions.push(session);
  return { session, child, events, frames: () => lines.map((l) => JSON.parse(l)), emit, emitReady, emitRaw };
};

const openReady = async (overrides: Partial<JsonlWorkerSessionOptions> = {}): Promise<Harness> => {
  const h = makeSession(overrides);
  h.emitReady();
  await h.session.ready;
  return h;
};

const makeReq = (overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest => ({
  turnId: "t1",
  conversationId: "conv1",
  attempt: 1,
  prompt: "hello",
  source: { kind: "message", channel: "general", sender: "bob" },
  ...overrides,
});

describe("PersistentJsonlWorkerSession", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    sessions = [];
  });

  afterEach(() => {
    for (const s of sessions) s.stop();
    vi.restoreAllMocks();
  });

  it("握手：initialize 帧内容完整；ready 后 send 写 turn.start（seq 递增、字段完整）", async () => {
    const h = makeSession();
    expect(h.session.alive).toBe(true);
    const init = h.frames()[0]!;
    expect(init).toMatchObject({
      protocol: SARP_PROTOCOL,
      version: SARP_VERSION,
      type: "initialize",
      seq: 1,
      requestId: expect.any(String),
      agent: { id: "a1", name: "alice", displayName: "Alice" },
      runtime: { id: "langgraph", entrypoint: "ep-1" },
      workspace: { path: "D:\\ws\\alice" },
      platform: {
        systemPrompt: "PLAT-PROMPT",
        serverUrl: "http://127.0.0.1:3000",
        tokenFile: "D:\\ws\\alice\\.slock\\agent-token",
      },
      limits: { maxFrameBytes: 1024 * 1024, silenceTimeoutMs: 5000, shutdownTimeoutMs: 40 },
    });
    expect(init.timestamp).toBeTypeOf("string");

    h.emitReady();
    await h.session.ready;
    const p = h.session.send(makeReq());
    await flush();
    const ts = h.frames()[1]!;
    expect(ts).toMatchObject({
      protocol: SARP_PROTOCOL,
      version: SARP_VERSION,
      type: "turn.start",
      seq: 2,
      turnId: "t1",
      conversationId: "conv1",
      attempt: 1,
      prompt: "hello",
      source: { kind: "message", channel: "general", sender: "bob" },
    });
    h.emit({ type: "turn.end", turnId: "t1", eventSeq: 1, status: "success", finalText: "done" });
    await expect(p).resolves.toMatchObject({ status: "success", finalText: "done" });
    h.session.stop();
  });

  it("runtime id 不匹配 → ready reject runtime-id-mismatch + 杀进程", async () => {
    const h = makeSession();
    h.emitReady({ runtime: { id: "langchain" } });
    await expect(h.session.ready).rejects.toMatchObject({ code: "runtime-id-mismatch" });
    expect(h.child.kill).toHaveBeenCalled();
    expect(h.session.alive).toBe(false);
    await expect(h.session.send(makeReq())).rejects.toMatchObject({ code: "runtime-id-mismatch" });
  });

  it("requireDurableThreads 但 worker 不支持 → durable-threads-required", async () => {
    const h = makeSession({ requireDurableThreads: true });
    h.emitReady({ capabilities: { durableThreads: false, maxConcurrency: 1 } });
    await expect(h.session.ready).rejects.toMatchObject({ code: "durable-threads-required" });
    expect(h.child.kill).toHaveBeenCalled();
  });

  it("maxConcurrency>1 → protocol-violation；model override 被拒 → model-not-allowed", async () => {
    const h1 = makeSession();
    h1.emitReady({ capabilities: { maxConcurrency: 4 } });
    await expect(h1.session.ready).rejects.toMatchObject({ code: "protocol-violation" });

    const h2 = makeSession({ model: "openai:gpt-5" });
    h2.emitReady({ model: { selected: "other", overrides: false } });
    await expect(h2.session.ready).rejects.toMatchObject({ code: "model-not-allowed" });
  });

  it("startup 超时（不发 ready）→ runtime-start-timeout + 杀进程", async () => {
    const h = makeSession({ timeouts: { startupMs: 40 } });
    await expect(h.session.ready).rejects.toMatchObject({ code: "runtime-start-timeout" });
    expect(h.child.kill).toHaveBeenCalled();
    await expect(h.session.send(makeReq())).rejects.toMatchObject({ code: "runtime-start-timeout" });
  });

  it("正常回合：delta/progress/tool/usage → normalized 事件；turn.end → resolve", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq());
    await flush();
    h.emit({ type: "assistant.delta", turnId: "t1", eventSeq: 1, text: "he" });
    h.emit({ type: "assistant.message", turnId: "t1", eventSeq: 2, text: "llo" });
    h.emit({ type: "assistant.progress", turnId: "t1", eventSeq: 3, message: "检索中" });
    h.emit({
      type: "tool.start",
      turnId: "t1",
      eventSeq: 4,
      callId: "c1",
      tool: { name: "read_channel_history", provider: "slock", operation: "read_history" },
      input: { limit: 5 },
    });
    h.emit({ type: "tool.end", turnId: "t1", eventSeq: 5, callId: "c1", ok: true, output: { count: 3 } });
    h.emit({
      type: "usage",
      turnId: "t1",
      eventSeq: 6,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.01, durationMs: 42, model: "m1" },
    });
    h.emit({
      type: "turn.end",
      turnId: "t1",
      eventSeq: 7,
      status: "success",
      finalText: "reply",
      sessionRef: "thread-9",
      usage: { inputTokens: 10 },
    });
    const res = await p;
    expect(res).toMatchObject({ status: "success", finalText: "reply", sessionRef: "thread-9" });
    expect(res?.usage?.inputTokens).toBe(10);

    expect(h.events).toContainEqual({ type: "text", turnId: "t1", text: "he" });
    expect(h.events).toContainEqual({ type: "text", turnId: "t1", text: "llo" });
    expect(h.events).toContainEqual({ type: "progress", turnId: "t1", message: "检索中" });
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "tool.start",
        toolName: "read_channel_history",
        toolUseId: "c1",
        provider: "slock",
      }),
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "tool.end",
        toolName: "read_channel_history",
        toolUseId: "c1",
        output: JSON.stringify({ count: 3 }),
        ok: true,
      }),
    );
    expect(h.events).toContainEqual({
      type: "usage",
      turnId: "t1",
      usage: {
        costUsd: 0.01,
        durationMs: 42,
        numTurns: null,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        model: "m1",
      },
    });
    expect(h.events).toContainEqual(expect.objectContaining({ type: "turn.end", status: "success", result: "reply" }));
    h.session.stop();
  });

  it("eventSeq 倒退 → protocol-violation（send reject + 杀进程）", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq());
    const rejected = expect(p).rejects.toMatchObject({ code: "protocol-violation" });
    await flush();
    h.emit({ type: "assistant.delta", turnId: "t1", eventSeq: 5, text: "x" });
    h.emit({ type: "assistant.delta", turnId: "t1", eventSeq: 3, text: "y" });
    await rejected;
    expect(h.child.kill).toHaveBeenCalled();
    expect(h.session.alive).toBe(false);
  });

  it("turnId 不匹配 → protocol-violation", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq());
    const rejected = expect(p).rejects.toMatchObject({ code: "protocol-violation" });
    await flush();
    h.emit({ type: "assistant.delta", turnId: "t2", eventSeq: 1, text: "x" });
    await rejected;
    expect(h.child.kill).toHaveBeenCalled();
  });

  it("重复 turn.end → protocol-violation 杀进程", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq());
    await flush();
    h.emit({ type: "turn.end", turnId: "t1", eventSeq: 1, status: "success", finalText: "ok" });
    await expect(p).resolves.toMatchObject({ status: "success" });
    h.emit({ type: "turn.end", turnId: "t1", eventSeq: 2, status: "success", finalText: "again" });
    await flush();
    expect(h.child.kill).toHaveBeenCalled();
    expect(h.session.alive).toBe(false);
    await expect(h.session.send(makeReq({ turnId: "t2" }))).rejects.toMatchObject({ code: "worker-exited" });
  });

  it("turn.end 后同 turnId 又来一帧 → protocol-violation", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq());
    await flush();
    h.emit({ type: "turn.end", turnId: "t1", eventSeq: 1, status: "success", finalText: "ok" });
    await expect(p).resolves.toMatchObject({ status: "success" });
    h.emit({ type: "assistant.delta", turnId: "t1", eventSeq: 2, text: "late" });
    await flush();
    expect(h.child.kill).toHaveBeenCalled();
    expect(h.session.alive).toBe(false);
  });

  it("turn.end error + MODEL_RATE_LIMITED retryAfterMs=2000 → provider-rate-limited", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq());
    await flush();
    h.emit({
      type: "turn.end",
      turnId: "t1",
      eventSeq: 1,
      status: "error",
      error: { code: "MODEL_RATE_LIMITED", message: "slow down", retryable: true, retryAfterMs: 2000 },
    });
    const err = await catchErr(p);
    expect(err.code).toBe("provider-rate-limited");
    expect(err.retryAfterMs).toBe(2000);
  });

  it("未映射 wire 错误码 → worker-error", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq());
    await flush();
    h.emit({
      type: "turn.end",
      turnId: "t1",
      eventSeq: 1,
      status: "error",
      error: { code: "SOMETHING_UNMAPPED", message: "mystery" },
    });
    const err = await catchErr(p);
    expect(err.code).toBe("worker-error");
    expect(err.retriable).toBe(false);
  });

  it("empty-success：message 无 finalText 且无 slock send → reject empty-success（turn.end 事件已先 emit）", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq()); // source.kind = message
    await flush();
    h.emit({ type: "turn.end", turnId: "t1", eventSeq: 1, status: "success" });
    const err = await catchErr(p);
    expect(err.code).toBe("empty-success");
    expect(h.events).toContainEqual(expect.objectContaining({ type: "turn.end", status: "success" }));
  });

  it("empty-success 豁免：slock send_message ok=true → success resolve（无 finalText 也行）", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq());
    await flush();
    h.emit({
      type: "tool.start",
      turnId: "t1",
      eventSeq: 1,
      callId: "s1",
      tool: { name: "send_message", provider: "slock", operation: "send_message" },
    });
    h.emit({ type: "tool.end", turnId: "t1", eventSeq: 2, callId: "s1", ok: true });
    h.emit({ type: "turn.end", turnId: "t1", eventSeq: 3, status: "success" });
    await expect(p).resolves.toMatchObject({ status: "success" });
  });

  it("interrupted：turn.interrupt 预览事件 + turn.end interrupted → resolve interrupt", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq());
    await flush();
    h.emit({
      type: "turn.interrupt",
      turnId: "t1",
      eventSeq: 1,
      interruptId: "i1",
      resumeToken: "r1",
      prompt: "批准吗？",
      payload: { action: "submit" },
    });
    expect(h.events).toContainEqual({
      type: "interrupt",
      turnId: "t1",
      interrupt: { interruptId: "i1", resumeToken: "r1", prompt: "批准吗？", payload: { action: "submit" } },
    });
    h.emit({
      type: "turn.end",
      turnId: "t1",
      eventSeq: 2,
      status: "interrupted",
      finalText: "需要人工确认",
      interrupt: { interruptId: "i1", resumeToken: "r1", prompt: "批准吗？" },
    });
    await expect(p).resolves.toMatchObject({
      status: "interrupted",
      finalText: "需要人工确认",
      interrupt: { interruptId: "i1", resumeToken: "r1", prompt: "批准吗？" },
    });
  });

  it("进程回合中退出 → worker-exited（retriable）+ stderr 尾部脱敏", async () => {
    const onExit = vi.fn();
    const h = await openReady({ onExit });
    const p = h.session.send(makeReq());
    await flush();
    h.child.stderr.emit("data", "fatal boom sk_agent_secret123 tail\n");
    h.child.emit("exit", 1);
    const err = await catchErr(p);
    expect(err.code).toBe("worker-exited");
    expect(err.retriable).toBe(true);
    expect(err.message).toContain("stderr");
    expect(err.message).not.toContain("sk_agent_secret123");
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(h.session.alive).toBe(false);
  });

  it("空闲进程退出 → alive=false + onExit；后续 send → worker-exited", async () => {
    const onExit = vi.fn();
    const h = await openReady({ onExit });
    h.child.emit("exit", 0);
    expect(h.session.alive).toBe(false);
    expect(onExit).toHaveBeenCalledTimes(1);
    await expect(h.session.send(makeReq())).rejects.toMatchObject({ code: "worker-exited" });
  });

  it("silence 超时 → runtime-silence-timeout + 杀进程", async () => {
    const h = await openReady({ timeouts: { silenceMs: 40 } });
    const p = h.session.send(makeReq());
    const rejected = expect(p).rejects.toMatchObject({ code: "runtime-silence-timeout" });
    await flush();
    await rejected;
    expect(h.child.kill).toHaveBeenCalled();
  });

  it("非法 JSON 行 → protocol-violation", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq());
    const rejected = expect(p).rejects.toMatchObject({ code: "protocol-violation" });
    await flush();
    h.emitRaw("this is { not valid json");
    await rejected;
    expect(h.child.kill).toHaveBeenCalled();
  });

  it("超大帧（>1MiB）→ protocol-violation", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq());
    const rejected = expect(p).rejects.toMatchObject({ code: "protocol-violation" });
    await flush();
    h.emitRaw(
      JSON.stringify({
        protocol: SARP_PROTOCOL,
        version: SARP_VERSION,
        timestamp: TS,
        seq: 99,
        type: "runtime.warning",
        message: "x".repeat(1024 * 1024),
      }),
    );
    await rejected;
    expect(h.child.kill).toHaveBeenCalled();
  });

  it("未知非 optional 帧 → protocol-violation；optional:true 未知帧被忽略", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq());
    const rejected = expect(p).rejects.toMatchObject({ code: "protocol-violation" });
    await flush();
    h.emit({ type: "mystery.event", foo: 1 });
    await rejected;
    expect(h.child.kill).toHaveBeenCalled();

    const h2 = await openReady();
    const p2 = h2.session.send(makeReq({ turnId: "t5" }));
    await flush();
    h2.emit({ type: "mystery.event", optional: true, foo: 1 }); // 忽略
    h2.emit({ type: "turn.end", turnId: "t5", eventSeq: 1, status: "success", finalText: "ok" });
    await expect(p2).resolves.toMatchObject({ status: "success" });
    h2.session.stop();
  });

  it("worker 帧 seq 倒退 → protocol-violation", async () => {
    const h = await openReady(); // ready 已占用入向 seq=1
    const p = h.session.send(makeReq());
    const rejected = expect(p).rejects.toMatchObject({ code: "protocol-violation" });
    await flush();
    h.emitRaw(
      JSON.stringify({
        protocol: SARP_PROTOCOL,
        version: SARP_VERSION,
        timestamp: TS,
        seq: 1, // 重复 seq=1 → inbound 单调校验失败
        type: "assistant.delta",
        turnId: "t1",
        eventSeq: 1,
        text: "x",
      }),
    );
    await rejected;
    expect(h.child.kill).toHaveBeenCalled();
  });

  it("stop()：turn.cancel → 无回应 → shutdown → SIGTERM；幂等；stop 后 send → agent-stopped", async () => {
    const h = await openReady({ timeouts: { shutdownMs: 30 } });
    const p = h.session.send(makeReq());
    const rejected = expect(p).rejects.toMatchObject({ code: "agent-stopped" });
    await flush();
    h.session.stop();
    await rejected;
    await flush(80); // cancel 宽限(30ms) → shutdown → shutdownMs(30ms) → SIGTERM
    const types = h.frames().map((f) => f.type);
    expect(types).toEqual(["initialize", "turn.start", "turn.cancel", "shutdown"]);
    expect(h.frames()[2]).toMatchObject({ turnId: "t1", reason: "agent stopped" });
    expect(h.frames()[3]).toMatchObject({ reason: "agent stopped", timeoutMs: 30 });
    expect(h.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(h.session.alive).toBe(false);
    h.child.emit("exit", 143); // 进程退出，清掉 SIGKILL 兜底计时器
    h.session.stop(); // 幂等：第二次不炸
    await expect(h.session.send(makeReq({ turnId: "t2" }))).rejects.toMatchObject({ code: "agent-stopped" });
  });

  it("stdin EPIPE（write throw）→ 走 kill 路径，send reject worker-exited 不挂起", async () => {
    const h = await openReady();
    h.child.stdin.write.mockImplementationOnce(() => {
      throw new Error("EPIPE");
    });
    const p = h.session.send(makeReq());
    const rejected = expect(p).rejects.toMatchObject({ code: "worker-exited" });
    await rejected;
    expect(h.child.kill).toHaveBeenCalled();
  });

  it("spawn 同步抛错 → alive=false，send 报 command-not-found（带 errMessage）", async () => {
    const h = makeSession({
      spawn: (() => {
        throw new Error("spawn node ENOENT");
      }) as unknown as typeof import("node:child_process").spawn,
    });
    expect(h.session.alive).toBe(false);
    const err = await catchErr(h.session.send(makeReq()));
    expect(err.code).toBe("command-not-found");
    expect(err.message).toContain("ENOENT");
  });

  it("子进程 error 事件：ENOENT → command-not-found；其它 → worker-exited", async () => {
    const h1 = makeSession();
    const enoent = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
    h1.child.emit("error", enoent);
    await expect(h1.session.ready).rejects.toMatchObject({ code: "command-not-found" });

    const h2 = makeSession();
    h2.child.emit("error", new Error("socket hangup"));
    await expect(h2.session.ready).rejects.toMatchObject({ code: "worker-exited" });
  });

  it("握手期 runtime.error → mapWireError reject handshake", async () => {
    const h = makeSession();
    h.emit({ type: "runtime.error", error: { code: "MCP_START_FAILED", message: "mcp down", retryable: true } });
    await expect(h.session.ready).rejects.toMatchObject({ code: "mcp-start-failed" });
    expect(h.child.kill).toHaveBeenCalled();
  });

  it("ready 前进程退出 → handshake reject worker-exited", async () => {
    const h = makeSession();
    h.child.stderr.emit("data", "missing dep\n");
    h.child.emit("exit", 2);
    await expect(h.session.ready).rejects.toMatchObject({ code: "worker-exited" });
  });

  it("ready 前收到 turn-scoped 帧 → protocol-violation", async () => {
    const h = makeSession();
    h.emit({ type: "assistant.delta", turnId: "t0", eventSeq: 1, text: "premature" });
    await expect(h.session.ready).rejects.toMatchObject({ code: "protocol-violation" });
    expect(h.child.kill).toHaveBeenCalled();
  });

  it("回合中 runtime.error → mapWireError reject + 杀进程", async () => {
    const h = await openReady();
    const p = h.session.send(makeReq());
    const rejected = expect(p).rejects.toMatchObject({ code: "provider-network-failed" });
    await flush();
    h.emit({ type: "runtime.error", error: { code: "NETWORK_FAILED", message: "provider unreachable" } });
    await rejected;
    expect(h.child.kill).toHaveBeenCalled();
  });
});
