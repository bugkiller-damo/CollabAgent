import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSarpConformance } from "../src/sarp-conformance.js";

/**
 * sarp-conformance runner 自测：对 fixture worker 跑全检查项。
 * fixture 实现了完整握手/turn/cancel/shutdown，但不实现 turn journal
 * （replay 应 skip），坏行静默忽略（malformed 应 pass）。
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sarp-worker.mjs");

const spec = (env: Record<string, string> = {}) => ({
  command: process.execPath,
  args: [FIXTURE],
  cwd: dirname(FIXTURE),
  env,
});

const checkOf = (report: { checks: { name: string; status: string }[] }, name: string) =>
  report.checks.find((c) => c.name === name);

describe("sarp-conformance — healthy fixture", () => {
  it("全部检查通过（replay skip）", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec(),
      runtimeId: "langgraph",
      entrypoint: "fx-graph",
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(true);
    const statuses = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
    expect(statuses).toMatchObject({
      handshake: "pass",
      "turn-lifecycle": "pass",
      "seq-monotonic": "pass",
      "eventseq-monotonic": "pass",
      cancel: "pass",
      "malformed-stdin": "pass",
      shutdown: "pass",
      "shutdown-exit": "pass",
      replay: "skip",
    });
  }, 30000);
});

describe("sarp-conformance — failure modes", () => {
  it("SLOCK_FX_NO_READY=1 → handshake fail", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_NO_READY: "1" }),
      runtimeId: "langgraph",
      stepTimeoutMs: 1200,
    });
    expect(report.ok).toBe(false);
    expect(checkOf(report, "handshake")?.status).toBe("fail");
  }, 20000);

  it("runtimeId 不匹配 → handshake fail", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_RUNTIME_ID: "langchain" }),
      runtimeId: "langgraph",
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(false);
    expect(checkOf(report, "handshake")?.status).toBe("fail");
  }, 20000);

  it("SLOCK_FX_NO_TURN_END=1 → turn-lifecycle fail", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_NO_TURN_END: "1" }),
      runtimeId: "langgraph",
      stepTimeoutMs: 1500,
    });
    expect(report.ok).toBe(false);
    expect(checkOf(report, "turn-lifecycle")?.status).toBe("fail");
  }, 20000);

  it("SLOCK_FX_SEQ_RESET=1 → seq-monotonic fail（越序被逮住）", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_SEQ_RESET: "1" }),
      runtimeId: "langgraph",
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(false);
    expect(checkOf(report, "turn-lifecycle")?.status).toBe("fail");
  }, 20000);

  it("SLOCK_FX_STARTUP_CRASH=1 → handshake fail", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_STARTUP_CRASH: "1" }),
      runtimeId: "langgraph",
      stepTimeoutMs: 2000,
    });
    expect(report.ok).toBe(false);
    expect(checkOf(report, "handshake")?.status).toBe("fail");
  }, 20000);
});
