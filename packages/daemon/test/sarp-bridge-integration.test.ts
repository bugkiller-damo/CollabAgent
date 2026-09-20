import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent, AgentRuntimeTurnResult } from "../src/agent-runtime-driver.js";
import {
  type JsonlWorkerSessionOptions,
  PersistentJsonlWorkerSession,
} from "../src/drivers/persistent-jsonl-worker.js";
import { DispatchError } from "../src/errors.js";

/**
 * Phase 2：fixture worker ↔ PersistentJsonlWorkerSession 的真实进程集成测试。
 * fake-child 单测覆盖内部状态机；本文件验证跨进程线格式端到端：
 * spawn node sarp-worker.mjs → initialize → runtime.ready → turn.start →
 * 流事件 → turn.end → send() 结算。worker stdout 即协议真流，无假桩。
 */

const FIXTURE = join(__dirname, "fixtures", "sarp-worker.mjs");

const FX_ENV_BASE = { PYTHONUNBUFFERED: "1" } as const;

const openWorker = (
  fxEnv: Record<string, string> = {},
  over: Partial<JsonlWorkerSessionOptions> = {},
): { session: PersistentJsonlWorkerSession; events: AgentRuntimeEvent[] } => {
  const events: AgentRuntimeEvent[] = [];
  const session = new PersistentJsonlWorkerSession({
    agentName: "it-agent",
    runtime: "langgraph",
    entrypoint: "fx-graph",
    workspace: process.cwd(),
    spawnSpec: {
      command: process.execPath,
      args: [FIXTURE],
      cwd: process.cwd(),
      env: { ...FX_ENV_BASE, ...fxEnv },
    },
    timeouts: { startupMs: 5000, silenceMs: 4000, shutdownMs: 1500 },
    onEvent: (e) => events.push(e),
    ...over,
  });
  return { session, events };
};

const req = (turnId: string, prompt = "hi") => ({
  turnId,
  conversationId: "slock:v1:a1:thread:t1",
  attempt: 1,
  prompt,
  source: { kind: "message" as const, channel: "research", sender: "alice" },
});

describe("fixture worker ↔ session 端到端", () => {
  it("握手 + 默认脚本回合：delta×2 + usage + turn.end success（finalText 拼接）", async () => {
    const { session, events } = openWorker();
    const result = (await session.send(req("t-1"))) as AgentRuntimeTurnResult;
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("hello world");
    expect(result.sessionRef).toBe("fx-thread-1");
    expect(result.usage?.totalTokens).toBe(15);
    expect(events.map((e) => e.type)).toEqual(["text", "text", "usage", "turn.end"]);
    session.stop();
    expect(session.alive).toBe(false);
  });

  it("initialize → ready 走真实 stdin/stdout JSONL；runtime.id 不符 → runtime-id-mismatch", async () => {
    const bad = openWorker({ SLOCK_FX_RUNTIME_ID: "langchain" });
    await expect(bad.session.send(req("t-x"))).rejects.toMatchObject({
      name: "DispatchError",
      code: "runtime-id-mismatch",
    });
    expect(bad.session.alive).toBe(false);
  });

  it("脚本驱动：tool.start(slock send_message)+tool.end → tool 事件 + empty-success 豁免", async () => {
    const { session, events } = openWorker({
      SLOCK_FX_SCRIPT: JSON.stringify([
        { toolStart: { callId: "c1", name: "send_message", provider: "slock", operation: "send_message" } },
        { toolEnd: { callId: "c1", ok: true, output: { id: "m1" } } },
        { end: { status: "success" } }, // 无 finalText：靠 slock send 豁免
      ]),
    });
    const result = (await session.send(req("t-2"))) as AgentRuntimeTurnResult;
    expect(result.status).toBe("success");
    const toolStart = events.find((e) => e.type === "tool.start");
    expect(toolStart).toMatchObject({ provider: "slock", operation: "send_message", toolUseId: "c1" });
    session.stop();
  });

  it("turn.interrupt 预览 + turn.end interrupted → send() 返回 interrupt 记录", async () => {
    const { session, events } = openWorker({
      SLOCK_FX_SCRIPT: JSON.stringify([
        { interrupt: { interruptId: "i9", resumeToken: "r7", prompt: "批准？" } },
        {
          end: {
            status: "interrupted",
            finalText: "等待确认",
            interrupt: { interruptId: "i9", resumeToken: "r7", prompt: "批准？" },
          },
        },
      ]),
    });
    const result = (await session.send(req("t-3"))) as AgentRuntimeTurnResult;
    expect(result.status).toBe("interrupted");
    expect(result.interrupt).toMatchObject({ interruptId: "i9", resumeToken: "r7", prompt: "批准？" });
    // 预览事件 + 终态事件都 emit 了
    expect(events.some((e) => e.type === "interrupt")).toBe(true);
    expect(events.some((e) => e.type === "turn.end" && e.status === "interrupted")).toBe(true);
    session.stop();
  });

  it("预览与终态 interrupt 不一致 → protocol-violation（§8.6）", async () => {
    const { session } = openWorker({
      SLOCK_FX_SCRIPT: JSON.stringify([
        { interrupt: { interruptId: "i9", resumeToken: "r7", prompt: "批准？" } },
        {
          end: { status: "interrupted", interrupt: { interruptId: "i9", resumeToken: "DIFFERENT", prompt: "批准？" } },
        },
      ]),
    });
    await expect(session.send(req("t-4"))).rejects.toMatchObject({ code: "protocol-violation" });
    expect(session.alive).toBe(false);
  });

  it("stop() 中断在跑回合：turn.cancel → cancelled 结算或 agent-stopped 强制结算", async () => {
    const { session } = openWorker({
      SLOCK_FX_SCRIPT: JSON.stringify([{ sleep: 30_000 }, { delta: "late" }]),
    });
    const p = session.send(req("t-5"));
    // 给 worker 一点启动时间再停——cancel 路径可能 resolve cancelled
    // （worker 应答取消），也可能被宽限强制结算成 agent-stopped
    await new Promise((r) => setTimeout(r, 300));
    session.stop();
    const outcome = await p.then(
      (r) => ({ ok: true as const, status: (r as AgentRuntimeTurnResult).status }),
      (e) => ({ ok: false as const, code: (e as DispatchError).code }),
    );
    if (outcome.ok) expect(outcome.status).toBe("cancelled");
    else expect(outcome.code).toBe("agent-stopped");
    expect(session.alive).toBe(false);
  });

  it("worker 回合中崩溃（exit 42）→ worker-exited retriable", async () => {
    const { session } = openWorker({
      SLOCK_FX_SCRIPT: JSON.stringify([{ delta: "partial" }, { exit: 42 }]),
    });
    await expect(session.send(req("t-6"))).rejects.toMatchObject({
      code: "worker-exited",
      retriable: true,
    });
    expect(session.alive).toBe(false);
  });

  it("沉默超时（NO_TURN_END + sleep 超过 silenceMs）→ runtime-silence-timeout + 杀进程", async () => {
    const { session } = openWorker(
      {
        SLOCK_FX_SCRIPT: JSON.stringify([{ sleep: 30_000 }]),
        SLOCK_FX_NO_TURN_END: "1",
      },
      { timeouts: { startupMs: 5000, silenceMs: 800, shutdownMs: 1000 } },
    );
    await expect(session.send(req("t-7"))).rejects.toMatchObject({ code: "runtime-silence-timeout" });
    expect(session.alive).toBe(false);
  });

  it("startup 超时（NO_READY）→ runtime-start-timeout", async () => {
    const { session } = openWorker(
      { SLOCK_FX_NO_READY: "1" },
      { timeouts: { startupMs: 600, silenceMs: 4000, shutdownMs: 1000 } },
    );
    await expect(session.send(req("t-8"))).rejects.toMatchObject({ code: "runtime-start-timeout" });
    expect(session.alive).toBe(false);
  });

  it("坏帧（BAD_LINE_AFTER_INIT）→ handshake protocol-violation", async () => {
    const { session } = openWorker({ SLOCK_FX_BAD_LINE_AFTER_INIT: "1" });
    await expect(session.send(req("t-9"))).rejects.toSatisfy(
      (e) => e instanceof DispatchError && (e.code === "protocol-violation" || e.code === "worker-exited"),
    );
    expect(session.alive).toBe(false);
  });
});
