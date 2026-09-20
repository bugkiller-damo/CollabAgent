import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * sarp-worker.mjs 协议桩的自测：真实 spawn 子进程，走 stdin/stdout JSONL 验证
 * 桩本身行为正确，之后 PersistentJsonlWorkerSession 的集成测试才能信任它。
 *
 * Windows 注意：spawn 直接用 process.execPath 起 node，不走 shell。
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sarp-worker.mjs");

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface WorkerHandle {
  proc: ChildProcessWithoutNullStreams;
  /** 发送一帧 daemon→worker（自动补 protocol/version/seq/timestamp 信封）。 */
  sendFrame(fields: Record<string, unknown>): void;
  /** 原样写一行到 worker stdin（坏帧/非 JSON 输入测试用）。 */
  sendRawLine(line: string): void;
  /** 读下一行 stdout 原文。超时（默认 5s）或进程退出时 reject。 */
  readLine(timeoutMs?: number): Promise<string>;
  /** 读下一行 stdout 并 JSON.parse。 */
  readFrame(timeoutMs?: number): Promise<any>;
  waitExit(): Promise<ExitResult>;
  stderrText(): string;
}

const liveWorkers = new Set<WorkerHandle>();

const spawnWorker = (env: Record<string, string> = {}, args: string[] = []): WorkerHandle => {
  const proc = spawn(process.execPath, [FIXTURE, ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buf = "";
  let stderrBuf = "";
  let inSeq = 0;
  let exitSeen: ExitResult | null = null;
  let stdoutClosed = false;
  const lines: string[] = [];
  const waiters: { resolve: (l: string) => void; reject: (e: Error) => void }[] = [];

  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf-8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else lines.push(line);
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf-8");
  });
  // 'exit' 可能早于最后一截 stdout 数据到达；读侧要等 stdout 'close' 才算流尽，
  // 否则 shutdown 前的 runtime.stopped 会被 exit 竞争丢掉。
  proc.stdout.on("close", () => {
    stdoutClosed = true;
    for (const w of waiters.splice(0)) {
      w.reject(new Error(`worker stdout closed (code=${exitSeen?.code}) — stderr: ${stderrBuf.trim()}`));
    }
  });
  const exitPromise = new Promise<ExitResult>((resolve) => {
    proc.on("exit", (code, signal) => {
      exitSeen = { code, signal };
      liveWorkers.delete(handle);
      resolve(exitSeen);
    });
  });

  const handle: WorkerHandle = {
    proc,
    sendFrame(fields) {
      proc.stdin.write(
        `${JSON.stringify({
          protocol: "slock.agent-runtime",
          version: 1,
          seq: ++inSeq,
          timestamp: new Date().toISOString(),
          ...fields,
        })}\n`,
      );
    },
    sendRawLine(line) {
      proc.stdin.write(`${line}\n`);
    },
    readLine(timeoutMs = 5000) {
      if (lines.length) return Promise.resolve(lines.shift()!);
      if (stdoutClosed) {
        return Promise.reject(
          new Error(`worker stdout already closed (code=${exitSeen?.code}) — stderr: ${stderrBuf.trim()}`),
        );
      }
      return new Promise<string>((resolve, reject) => {
        let timer: NodeJS.Timeout;
        // 注意：waiters 里存的必须是这个同一个对象，否则超时 splice 找不到、
        // 死 waiter 留在队列里会吞掉下一行（真实踩过：NO_READY 用例）。
        const waiter = {
          resolve: (l: string) => {
            clearTimeout(timer);
            resolve(l);
          },
          reject: (e: Error) => {
            clearTimeout(timer);
            reject(e);
          },
        };
        timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`no stdout line within ${timeoutMs}ms — stderr: ${stderrBuf.trim()}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    async readFrame(timeoutMs = 5000) {
      return JSON.parse(await this.readLine(timeoutMs));
    },
    waitExit: () => exitPromise,
    stderrText: () => stderrBuf,
  };
  liveWorkers.add(handle);
  return handle;
};

/** --slock-probe 模式：收全部 stdout 等退出。 */
const runProbe = (env: Record<string, string> = {}) =>
  new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const proc = spawn(process.execPath, [FIXTURE, "--slock-probe"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
    proc.on("error", reject);
    // 'close'（stdio 全部关闭）而不是 'exit'，保证最后一截 stdout 已收到。
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
  });

afterEach(async () => {
  for (const w of [...liveWorkers]) {
    liveWorkers.delete(w);
    if (w.proc.exitCode === null) w.proc.kill();
    await w.waitExit();
  }
});

const initFrame = () => ({
  type: "initialize",
  agent: { id: "agent-1", name: "tester" },
  runtime: { id: "langgraph", entrypoint: "fx-graph" },
  platform: { workspace: "D:\\code\\slock\\.slock\\workspaces\\tester" },
  limits: { maxFrameBytes: 1048576, silenceTimeoutMs: 300000 },
});

const turnStart = (turnId = "turn-1", prompt = "hi") => ({
  type: "turn.start",
  turnId,
  conversationId: "conv-1",
  attempt: 1,
  source: { kind: "message", channel: "general" },
  prompt,
});

/** 走完 initialize 握手，返回 ready 帧。 */
const handshake = async (w: WorkerHandle) => {
  w.sendFrame(initFrame());
  return w.readFrame();
};

const scriptEnv = (script: unknown[]) => ({ SLOCK_FX_SCRIPT: JSON.stringify(script) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("sarp-worker fixture — probe mode", () => {
  it("--slock-probe 输出单行 JSON 并 exit 0，runtime.id 正确", async () => {
    const { stdout, code } = await runProbe();
    expect(code).toBe(0);
    const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    const probe = JSON.parse(lines[0]!);
    expect(probe.protocol).toBe("slock.agent-runtime");
    expect(probe.version).toBe(1);
    expect(probe.probe).toBe(true);
    expect(probe.runtime.id).toBe("langgraph");
    expect(probe.capabilities.persistentProcess).toBe(true);
    expect(probe.model.overrides).toBe(true);
  });

  it("SLOCK_FX_RUNTIME_ID 覆盖 probe 的 runtime.id", async () => {
    const { stdout, code } = await runProbe({ SLOCK_FX_RUNTIME_ID: "langchain" });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim()).runtime.id).toBe("langchain");
  });
});

describe("sarp-worker fixture — initialize", () => {
  it("initialize → runtime.ready：信封完整、seq=1、默认 capabilities 齐全", async () => {
    const w = spawnWorker();
    const ready = await handshake(w);
    expect(ready).toMatchObject({
      protocol: "slock.agent-runtime",
      version: 1,
      type: "runtime.ready",
      seq: 1,
      runtime: { id: "langgraph" },
      capabilities: {
        persistentProcess: true,
        streamingText: true,
        toolEvents: true,
        durableThreads: true,
        interrupts: true,
        mcp: true,
        usage: "tokens",
        pty: false,
        maxConcurrency: 1,
      },
      model: { selected: "fx-model", overrides: true },
    });
    expect(typeof ready.timestamp).toBe("string");
    expect(() => new Date(ready.timestamp).toISOString()).not.toThrow();
    w.sendFrame({ type: "shutdown" });
    expect((await w.waitExit()).code).toBe(0);
  });

  it("SLOCK_FX_CAPABILITIES 深合并覆盖 + SLOCK_FX_MODEL_* 生效", async () => {
    const w = spawnWorker({
      SLOCK_FX_CAPABILITIES: JSON.stringify({ interrupts: false, maxConcurrency: 1, usage: "cost" }),
      SLOCK_FX_MODEL_SELECTED: "openai:gpt-5-mini",
      SLOCK_FX_MODEL_OVERRIDE: "false",
      SLOCK_FX_RUNTIME_ID: "langchain",
    });
    const ready = await handshake(w);
    expect(ready.runtime.id).toBe("langchain");
    expect(ready.capabilities.interrupts).toBe(false);
    expect(ready.capabilities.usage).toBe("cost");
    expect(ready.capabilities.streamingText).toBe(true); // 未覆盖的键保留默认
    expect(ready.model).toMatchObject({ selected: "openai:gpt-5-mini", overrides: false });
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("SLOCK_FX_NO_READY=1 → 500ms 内无帧，但进程仍响应 shutdown", async () => {
    const w = spawnWorker({ SLOCK_FX_NO_READY: "1" });
    w.sendFrame(initFrame());
    await expect(w.readFrame(500)).rejects.toThrow(/no stdout line/);
    w.sendFrame({ type: "shutdown" });
    expect((await w.readFrame()).type).toBe("runtime.stopped");
    expect((await w.waitExit()).code).toBe(0);
  });

  it("SLOCK_FX_READY_DELAY_MS → ready 延迟到达", async () => {
    const w = spawnWorker({ SLOCK_FX_READY_DELAY_MS: "200" });
    const t0 = Date.now();
    const ready = await handshake(w);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(ready.type).toBe("runtime.ready");
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("SLOCK_FX_READY_ERROR → initialize 后回 runtime.error 而非 ready", async () => {
    const w = spawnWorker({ SLOCK_FX_READY_ERROR: "MODEL_NOT_ALLOWED" });
    w.sendFrame(initFrame());
    const err = await w.readFrame();
    expect(err.type).toBe("runtime.error");
    expect(err.error).toEqual({ code: "MODEL_NOT_ALLOWED", message: "ready failed" });
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("SLOCK_FX_EXIT_AFTER_INIT=1 → initialize 后 exit 42", async () => {
    const w = spawnWorker({ SLOCK_FX_EXIT_AFTER_INIT: "1" });
    w.sendFrame(initFrame());
    expect((await w.waitExit()).code).toBe(42);
  });

  it("SLOCK_FX_BAD_LINE_AFTER_INIT=1 → 先吐坏行再正常 ready", async () => {
    const w = spawnWorker({ SLOCK_FX_BAD_LINE_AFTER_INIT: "1" });
    w.sendFrame(initFrame());
    expect(await w.readLine()).toBe("{not json");
    expect((await w.readFrame()).type).toBe("runtime.ready");
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("SLOCK_FX_STARTUP_CRASH=1 → 进程起来即 exit 3", async () => {
    const w = spawnWorker({ SLOCK_FX_STARTUP_CRASH: "1" });
    expect((await w.waitExit()).code).toBe(3);
  });
});

describe("sarp-worker fixture — turn", () => {
  it("默认脚本：delta×2 → usage → turn.end success，eventSeq/seq 递增", async () => {
    const w = spawnWorker();
    const ready = await handshake(w);
    expect(ready.seq).toBe(1);
    w.sendFrame(turnStart("turn-A"));

    const d1 = await w.readFrame();
    const d2 = await w.readFrame();
    const usage = await w.readFrame();
    const end = await w.readFrame();

    expect(d1).toMatchObject({ type: "assistant.delta", turnId: "turn-A", eventSeq: 1, text: "hello " });
    expect(d2).toMatchObject({ type: "assistant.delta", turnId: "turn-A", eventSeq: 2, text: "world" });
    expect(usage).toMatchObject({
      type: "usage",
      turnId: "turn-A",
      eventSeq: 3,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, durationMs: 50, model: "fx" },
    });
    expect(end).toMatchObject({
      type: "turn.end",
      turnId: "turn-A",
      eventSeq: 4,
      status: "success",
      finalText: "hello world",
      sessionRef: "fx-thread-1",
      usage: { totalTokens: 15 },
    });
    // 出向 seq 跨握手/回合帧全局单调递增
    expect([ready.seq, d1.seq, d2.seq, usage.seq, end.seq]).toEqual([1, 2, 3, 4, 5]);
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("SLOCK_FX_ECHO_PROMPT=1 → prompt 作为 delta 回显并进 finalText", async () => {
    const w = spawnWorker({ SLOCK_FX_ECHO_PROMPT: "1" });
    await handshake(w);
    w.sendFrame(turnStart("turn-E", "ping-42"));
    expect((await w.readFrame()).text).toBe("ping-42");
    const end = await w.readFrame();
    expect(end).toMatchObject({ type: "turn.end", status: "success", finalText: "ping-42" });
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("脚本 interrupted：turn.interrupt + turn.end interrupted 带 resumeToken", async () => {
    const w = spawnWorker(
      scriptEnv([
        { delta: "need approval" },
        { interrupt: { interruptId: "i1", resumeToken: "tok-1", prompt: "继续？" } },
        { end: { status: "interrupted", interrupt: { interruptId: "i1", resumeToken: "tok-1", prompt: "继续？" } } },
      ]),
    );
    await handshake(w);
    w.sendFrame(turnStart("turn-I"));
    expect((await w.readFrame()).type).toBe("assistant.delta");
    const intr = await w.readFrame();
    expect(intr).toMatchObject({ type: "turn.interrupt", interruptId: "i1", resumeToken: "tok-1", prompt: "继续？" });
    const end = await w.readFrame();
    expect(end).toMatchObject({
      type: "turn.end",
      status: "interrupted",
      interrupt: { interruptId: "i1", resumeToken: "tok-1" },
    });
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("脚本 error：turn.end error 带 code/retryable/retryAfterMs", async () => {
    const w = spawnWorker(
      scriptEnv([
        { delta: "oops" },
        {
          end: {
            status: "error",
            error: { code: "MODEL_RATE_LIMITED", message: "slow down", retryable: true, retryAfterMs: 2000 },
          },
        },
      ]),
    );
    await handshake(w);
    w.sendFrame(turnStart("turn-X"));
    await w.readFrame(); // delta
    const end = await w.readFrame();
    expect(end).toMatchObject({
      type: "turn.end",
      status: "error",
      error: { code: "MODEL_RATE_LIMITED", message: "slow down", retryable: true, retryAfterMs: 2000 },
    });
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("脚本：message/progress/tool.start/tool.end/raw 未知 optional 帧", async () => {
    const w = spawnWorker(
      scriptEnv([
        { message: "stable paragraph" },
        { progress: "检索中" },
        {
          toolStart: {
            callId: "c1",
            name: "send_message",
            provider: "slock",
            operation: "send_message",
            input: { text: "hi" },
          },
        },
        { toolEnd: { callId: "c1", ok: true, output: { id: "m1" } } },
        { raw: { type: "mystery.event", optional: true } },
        { end: { status: "success", finalText: "done" } },
      ]),
    );
    await handshake(w);
    w.sendFrame(turnStart("turn-T"));
    expect(await w.readFrame()).toMatchObject({ type: "assistant.message", text: "stable paragraph", eventSeq: 1 });
    expect(await w.readFrame()).toMatchObject({ type: "assistant.progress", message: "检索中", eventSeq: 2 });
    expect(await w.readFrame()).toMatchObject({
      type: "tool.start",
      eventSeq: 3,
      // §8.5：callId / input 顶层字段，tool 内只有 name/provider/operation
      callId: "c1",
      input: { text: "hi" },
      tool: { name: "send_message", provider: "slock", operation: "send_message" },
    });
    expect(await w.readFrame()).toMatchObject({
      type: "tool.end",
      eventSeq: 4,
      callId: "c1",
      tool: {},
      ok: true,
      output: { id: "m1" },
    });
    // raw：信封自动补，type/optional 原样
    expect(await w.readFrame()).toMatchObject({
      protocol: "slock.agent-runtime",
      type: "mystery.event",
      optional: true,
    });
    expect((await w.readFrame()).type).toBe("turn.end");
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("turn.cancel → 打断脚本发 turn.end cancelled，后续脚本帧不再出现", async () => {
    const w = spawnWorker(scriptEnv([{ sleep: 2000 }, { delta: "late" }]));
    await handshake(w);
    w.sendFrame(turnStart("turn-C"));
    w.sendFrame({ type: "turn.cancel", turnId: "turn-C", reason: "test" });
    const end = await w.readFrame();
    expect(end).toMatchObject({ type: "turn.end", turnId: "turn-C", status: "cancelled" });
    // 脚本已被打断：隐式终态与剩余指令都不会再发
    await expect(w.readFrame(300)).rejects.toThrow(/no stdout line/);
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("turn.cancel 不匹配当前 turnId → 忽略", async () => {
    const w = spawnWorker(scriptEnv([{ delta: "x" }]));
    await handshake(w);
    w.sendFrame(turnStart("turn-real"));
    w.sendFrame({ type: "turn.cancel", turnId: "turn-other", reason: "wrong" });
    expect((await w.readFrame()).type).toBe("assistant.delta");
    expect((await w.readFrame()).status).toBe("success");
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("SLOCK_FX_EMPTY_SUCCESS=1 → turn.end success 无 finalText", async () => {
    const w = spawnWorker({ SLOCK_FX_EMPTY_SUCCESS: "1" });
    await handshake(w);
    w.sendFrame(turnStart("turn-ES"));
    const end = await w.readFrame();
    expect(end.type).toBe("turn.end");
    expect(end.status).toBe("success");
    expect("finalText" in end).toBe(false);
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("SLOCK_FX_NO_TURN_END=1 → 默认脚本跑完不发终态", async () => {
    const w = spawnWorker({ SLOCK_FX_NO_TURN_END: "1" });
    await handshake(w);
    w.sendFrame(turnStart("turn-N"));
    expect((await w.readFrame()).type).toBe("assistant.delta");
    expect((await w.readFrame()).type).toBe("assistant.delta");
    expect((await w.readFrame()).type).toBe("usage");
    await expect(w.readFrame(300)).rejects.toThrow(/no stdout line/);
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("doubleEnd → 收到两个连续 turn.end", async () => {
    const w = spawnWorker(scriptEnv([{ doubleEnd: { status: "success", finalText: "twice" } }]));
    await handshake(w);
    w.sendFrame(turnStart("turn-D"));
    const e1 = await w.readFrame();
    const e2 = await w.readFrame();
    expect(e1).toMatchObject({ type: "turn.end", status: "success", finalText: "twice" });
    expect(e2).toMatchObject({ type: "turn.end", status: "success", finalText: "twice" });
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("literal 指令 → stdout 出现原始非 JSON 行", async () => {
    const w = spawnWorker(scriptEnv([{ literal: "garbage" }, { end: { status: "success", finalText: "ok" } }]));
    await handshake(w);
    w.sendFrame(turnStart("turn-L"));
    expect(await w.readLine()).toBe("garbage");
    expect((await w.readFrame()).type).toBe("turn.end");
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("eventSeqReset + wrongTurnId → eventSeq 回退 1、turnId 变 turn-other", async () => {
    const w = spawnWorker(
      scriptEnv([
        { delta: "a" },
        { eventSeqReset: true },
        { delta: "b" },
        { wrongTurnId: true },
        { delta: "c" },
        { end: { status: "success", finalText: "x" } },
      ]),
    );
    await handshake(w);
    w.sendFrame(turnStart("turn-R"));
    expect(await w.readFrame()).toMatchObject({ eventSeq: 1, turnId: "turn-R", text: "a" });
    expect(await w.readFrame()).toMatchObject({ eventSeq: 1, turnId: "turn-R", text: "b" });
    expect(await w.readFrame()).toMatchObject({ eventSeq: 2, turnId: "turn-other", text: "c" });
    // wrongTurnId 只作用一帧；eventSeq 从 1 继续递增
    expect(await w.readFrame()).toMatchObject({ type: "turn.end", eventSeq: 3, turnId: "turn-R" });
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("SLOCK_FX_SEQ_RESET=1 → 所有出向帧 seq 恒为 1", async () => {
    const w = spawnWorker({ SLOCK_FX_SEQ_RESET: "1" });
    const ready = await handshake(w);
    w.sendFrame(turnStart("turn-S"));
    const d1 = await w.readFrame();
    const d2 = await w.readFrame();
    expect(ready.seq).toBe(1);
    expect(d1.seq).toBe(1);
    expect(d2.seq).toBe(1);
    w.sendFrame({ type: "shutdown" });
    expect((await w.readFrame()).seq).toBe(1);
    await w.waitExit();
  });

  it("SLOCK_FX_TURN_DELAY_MS → 回合首帧延迟", async () => {
    const w = spawnWorker({ SLOCK_FX_TURN_DELAY_MS: "200" });
    await handshake(w);
    const t0 = Date.now();
    w.sendFrame(turnStart("turn-DL"));
    const d1 = await w.readFrame();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(d1.type).toBe("assistant.delta");
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("脚本 exit 指令 → 进程按给定 code 退出", async () => {
    const w = spawnWorker(scriptEnv([{ delta: "bye" }, { exit: 42 }]));
    await handshake(w);
    w.sendFrame(turnStart("turn-Q"));
    expect((await w.readFrame()).type).toBe("assistant.delta");
    expect((await w.waitExit()).code).toBe(42);
  });
});

describe("sarp-worker fixture — shutdown 与健壮性", () => {
  it("shutdown → runtime.stopped{reason:shutdown} + exit 0", async () => {
    const w = spawnWorker();
    await handshake(w);
    w.sendFrame({ type: "shutdown", reason: "idle reclaim" });
    const stopped = await w.readFrame();
    expect(stopped).toMatchObject({ type: "runtime.stopped", reason: "shutdown" });
    expect((await w.waitExit()).code).toBe(0);
  });

  it("stdin 收到非 JSON 行 → stderr 记录、进程不崩、正常响应", async () => {
    const w = spawnWorker();
    w.sendRawLine("this is not json");
    const ready = await handshake(w);
    expect(ready.type).toBe("runtime.ready");
    await sleep(100);
    expect(w.stderrText()).toContain("invalid JSON");
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });

  it("未识别 daemon 帧 type → 忽略", async () => {
    const w = spawnWorker();
    w.sendFrame({ type: "totally.unknown", foo: 1 });
    const ready = await handshake(w);
    expect(ready.type).toBe("runtime.ready");
    w.sendFrame({ type: "shutdown" });
    await w.waitExit();
  });
});
