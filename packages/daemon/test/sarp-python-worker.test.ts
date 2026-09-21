import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent, AgentRuntimeTurnResult } from "../src/agent-runtime-driver.js";
import {
  type JsonlWorkerSessionOptions,
  PersistentJsonlWorkerSession,
} from "../src/drivers/persistent-jsonl-worker.js";

/**
 * Phase 3：真实 Python slock_runtime worker ↔ PersistentJsonlWorkerSession。
 * 与 sarp-worker.mjs（脚本桩）不同——这里跑的是真 SDK 主循环：
 * 握手/序号/幂等/interrupt-token 全部由 bridges/python/slock_runtime 承担。
 * 无 Python 时整个文件 skip（CI 可装依赖后开跑）。
 */

const PY_FIXTURE = join(__dirname, "fixtures", "sarp_worker.py");
const SDK_DIR = join(__dirname, "../../../bridges/python");
const VENV_PY = join(SDK_DIR, ".venv", "Scripts", "python.exe");

const findPython = (): string | null => {
  const candidates = [process.env.SLOCK_TEST_PYTHON, "python", VENV_PY].filter(Boolean) as string[];
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { stdio: "pipe" });
    if (r.status === 0) return c;
  }
  return null;
};

const PYTHON = findPython();
const maybe = PYTHON ? describe : describe.skip;

const openPyWorker = (
  workspace: string,
  fxEnv: Record<string, string> = {},
  over: Partial<JsonlWorkerSessionOptions> = {},
): { session: PersistentJsonlWorkerSession; events: AgentRuntimeEvent[] } => {
  const events: AgentRuntimeEvent[] = [];
  const session = new PersistentJsonlWorkerSession({
    agentName: "py-agent",
    runtime: "langgraph",
    entrypoint: "py-fixture",
    workspace,
    spawnSpec: {
      command: PYTHON!,
      args: [PY_FIXTURE],
      cwd: workspace,
      env: { PYTHONPATH: SDK_DIR, PYTHONUNBUFFERED: "1", ...fxEnv },
    },
    timeouts: { startupMs: 8000, silenceMs: 5000, shutdownMs: 2000 },
    onEvent: (e) => events.push(e),
    ...over,
  });
  return { session, events };
};

const req = (turnId: string, prompt = "hi", resume?: { interruptId: string; resumeToken: string; value: string }) => ({
  turnId,
  conversationId: "slock:v1:a1:thread:t1",
  attempt: 1,
  prompt,
  source: { kind: "message" as const, channel: "research", sender: "alice" },
  ...(resume ? { resume } : {}),
});

maybe("Python slock_runtime worker ↔ session 端到端", () => {
  it("握手 + 回合：delta×2 + usage + turn.end success（SDK 真实输出）", async () => {
    const ws = mkdtempSync(join(tmpdir(), "slock-py-"));
    const { session, events } = openPyWorker(ws);
    const result = (await session.send(req("t-1", "ping"))) as AgentRuntimeTurnResult;
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("py:ping");
    expect(result.sessionRef).toBe("slock:v1:a1:thread:t1");
    expect(result.usage?.totalTokens).toBe(3);
    expect(events.map((e) => e.type)).toEqual(["text", "text", "usage", "turn.end"]);
    session.stop();
    expect(session.alive).toBe(false);
  });

  it("interrupt → 同会话 resume 回合：SDK 签发/消费 resume token 全链路", async () => {
    const ws = mkdtempSync(join(tmpdir(), "slock-py-"));
    const { session, events } = openPyWorker(ws, { SLOCK_PY_INTERRUPT: "1" });
    const first = (await session.send(req("t-int"))) as AgentRuntimeTurnResult;
    expect(first.status).toBe("interrupted");
    expect(first.interrupt?.interruptId).toBe("py-int-t-int");
    expect(first.interrupt?.prompt).toBe("批准执行？");
    const token = first.interrupt!.resumeToken;
    expect(token.length).toBeGreaterThan(16);

    const second = (await session.send(
      req("t-resume", "unused", { interruptId: "py-int-t-int", resumeToken: token, value: "approved" }),
    )) as AgentRuntimeTurnResult;
    expect(second.status).toBe("success");
    expect(second.finalText).toBe("resumed:approved");
    session.stop();
  });

  it("伪造 resume token → PROTOCOL_VIOLATION → worker-error/终态 error", async () => {
    const ws = mkdtempSync(join(tmpdir(), "slock-py-"));
    const { session } = openPyWorker(ws, { SLOCK_PY_INTERRUPT: "1" });
    const res = await session.send(req("t-bad", "x", { interruptId: "i", resumeToken: "forged", value: "v" })).then(
      (r) => ({ ok: true as const, r: r as AgentRuntimeTurnResult }),
      (e) => ({ ok: false as const, code: (e as { code?: string }).code }),
    );
    if (res.ok) expect(res.r.status).toBe("error");
    else expect(res.code).toBeDefined();
    session.stop();
  });

  it("runtime.id 不符 → runtime-id-mismatch", async () => {
    const ws = mkdtempSync(join(tmpdir(), "slock-py-"));
    const { session } = openPyWorker(ws, { SLOCK_PY_RUNTIME_ID: "langchain" });
    await expect(session.send(req("t-x"))).rejects.toMatchObject({ code: "runtime-id-mismatch" });
    expect(session.alive).toBe(false);
  });

  it("stdout 混入非帧文本 → protocol-violation（协议纯净纪律）", async () => {
    const ws = mkdtempSync(join(tmpdir(), "slock-py-"));
    const { session } = openPyWorker(ws, { SLOCK_PY_STDOUT_NOISE: "1" });
    await expect(session.send(req("t-noise"))).rejects.toSatisfy(
      (e) =>
        e instanceof Error &&
        ["protocol-violation", "worker-exited", "runtime-start-timeout"].includes((e as { code?: string }).code ?? ""),
    );
  });
});
