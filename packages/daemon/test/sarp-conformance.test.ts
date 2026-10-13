import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSarpConformance } from "../src/sarp-conformance.js";

/**
 * sarp-conformance runner 自测：对 fixture worker 跑全检查项。
 * fixture 实现了完整握手/turn/cancel/shutdown；SLOCK_FX_JOURNAL=1 才开
 * turn journal（否则 replay 检查会逮到「重跑」→ fail）。坏行默认静默忽略
 * （malformed 走 ignore-continue + shutdown 可达路径）。
 *
 * 报告顺序：handshake → turn-lifecycle → seq-monotonic → eventseq-monotonic
 * → cancel → replay → shutdown → shutdown-exit → malformed-stdin
 * （malformed 在独立 Session B 里跑——fail-closed worker 会自杀，排最后）。
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
  it("全部检查通过（TURN_DELAY 让 cancel 确定在途中落地；replay skip）", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_TURN_DELAY_MS: "300" }),
      runtimeId: "bridge",
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

  it("capabilities.interrupts=false 也照跑 cancel（cancel 是基础协议帧，不是 HITL 能力）", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({
        SLOCK_FX_CAPABILITIES: JSON.stringify({ interrupts: false }),
        SLOCK_FX_TURN_DELAY_MS: "300",
      }),
      runtimeId: "bridge",
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(true);
    const c = checkOf(report, "cancel");
    expect(c?.status).toBe("pass");
    expect(c?.detail).toContain("cancelled");
  }, 30000);

  it("无 turn 延迟：turn 先于 cancel 落地 → cancel skip（未验证，不假 pass）", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec(),
      runtimeId: "bridge",
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(true);
    const c = checkOf(report, "cancel");
    expect(c?.status).toBe("skip");
    expect(c?.detail).toContain("before cancel took effect");
  }, 30000);
});

describe("sarp-conformance — 双会话与关停纪律", () => {
  it("SLOCK_FX_MALFORMED_ERROR_EXIT=1 → malformed pass（runtime.error + exit 2），session A shutdown 真验证", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_MALFORMED_ERROR_EXIT: "1" }),
      runtimeId: "bridge",
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(true);
    const m = checkOf(report, "malformed-stdin");
    expect(m?.status).toBe("pass");
    expect(m?.detail).toContain("exit code=2");
    // fail-closed 剖面不再吞掉 shutdown 验证：session A 里真跑 stopped + exit 0
    expect(checkOf(report, "shutdown")?.status).toBe("pass");
    expect(checkOf(report, "shutdown-exit")?.status).toBe("pass");
  }, 30000);

  it("SLOCK_FX_SHUTDOWN_NO_STOP=1 → 未发 stopped 就退 → shutdown fail / exit 0 → shutdown-exit pass", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_SHUTDOWN_NO_STOP: "1" }),
      runtimeId: "bridge",
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(false);
    const s = checkOf(report, "shutdown");
    expect(s?.status).toBe("fail");
    expect(s?.detail).toContain("without runtime.stopped");
    expect(checkOf(report, "shutdown-exit")?.status).toBe("pass");
  }, 30000);

  it("SLOCK_FX_SHUTDOWN_IGNORE=1 → shutdown/shutdown-exit fail；坏行被忽略但 shutdown 不可达 → malformed fail", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_SHUTDOWN_IGNORE: "1" }),
      runtimeId: "bridge",
      stepTimeoutMs: 1500,
    });
    expect(report.ok).toBe(false);
    expect(checkOf(report, "shutdown")?.status).toBe("fail");
    expect(checkOf(report, "shutdown-exit")?.status).toBe("fail");
    expect(checkOf(report, "malformed-stdin")?.status).toBe("fail");
  }, 40000);

  it("skipTurns=true → 回合面全 skip，handshake/shutdown/shutdown-exit/malformed-stdin pass", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec(),
      runtimeId: "bridge",
      skipTurns: true,
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(true);
    const statuses = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
    expect(statuses).toMatchObject({
      handshake: "pass",
      "turn-lifecycle": "skip",
      "seq-monotonic": "skip",
      "eventseq-monotonic": "skip",
      cancel: "skip",
      replay: "skip",
      shutdown: "pass",
      "shutdown-exit": "pass",
      "malformed-stdin": "pass",
    });
  }, 30000);
});

describe("sarp-conformance — journal replay（§15.4）", () => {
  it("SLOCK_FX_JOURNAL=1 + expectJournal → replay pass（只回放单帧终态）", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_JOURNAL: "1" }),
      runtimeId: "bridge",
      expectJournal: true,
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(true);
    expect(checkOf(report, "replay")?.status).toBe("pass");
  }, 30000);

  it("expectJournal 但 worker 无 journal → replay fail（重跑被逮）", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec(),
      runtimeId: "bridge",
      expectJournal: true,
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(false);
    const r = checkOf(report, "replay");
    expect(r?.status).toBe("fail");
    expect(r?.detail).toContain("re-executed");
  }, 30000);
});

describe("sarp-conformance — failure modes", () => {
  it("SLOCK_FX_NO_READY=1 → handshake fail", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_NO_READY: "1" }),
      runtimeId: "bridge",
      stepTimeoutMs: 1200,
    });
    expect(report.ok).toBe(false);
    expect(checkOf(report, "handshake")?.status).toBe("fail");
  }, 20000);

  it("runtimeId 不匹配 → handshake fail", async () => {
    const report = await runSarpConformance({
      // 真正不同的 runtime id——langchain/langgraph 归一后与 bridge 等价，不再构成 mismatch
      spawnSpec: spec({ SLOCK_FX_RUNTIME_ID: "not-a-runtime" }),
      runtimeId: "bridge",
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(false);
    expect(checkOf(report, "handshake")?.status).toBe("fail");
  }, 20000);

  it("WP6：期望 bridge、worker 回显旧别名 langgraph → handshake 归一通过", async () => {
    // 旧 SDK worker 收到 declared 别名后逐字回显（init.runtime_id 严格比对实现）；
    // 归一比较放行——旧 worker 与新 daemon 组合不该误报 handshake fail。
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_RUNTIME_ID: "langgraph" }),
      runtimeId: "bridge",
      skipTurns: true,
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(true);
    expect(checkOf(report, "handshake")?.status).toBe("pass");
  }, 20000);

  it("WP6：期望 declared 别名 langgraph（check 对旧 manifest）、worker 回显 langgraph → handshake 通过", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_RUNTIME_ID: "langgraph" }),
      runtimeId: "langgraph",
      skipTurns: true,
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(true);
    expect(checkOf(report, "handshake")?.status).toBe("pass");
  }, 20000);

  it("SLOCK_FX_NO_TURN_END=1 → turn-lifecycle fail", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_NO_TURN_END: "1" }),
      runtimeId: "bridge",
      stepTimeoutMs: 1500,
    });
    expect(report.ok).toBe(false);
    expect(checkOf(report, "turn-lifecycle")?.status).toBe("fail");
  }, 20000);

  it("SLOCK_FX_SEQ_RESET=1 → seq-monotonic fail（越序被逮住）", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_SEQ_RESET: "1" }),
      runtimeId: "bridge",
      stepTimeoutMs: 6000,
    });
    expect(report.ok).toBe(false);
    expect(checkOf(report, "turn-lifecycle")?.status).toBe("fail");
  }, 20000);

  it("SLOCK_FX_STARTUP_CRASH=1 → handshake fail", async () => {
    const report = await runSarpConformance({
      spawnSpec: spec({ SLOCK_FX_STARTUP_CRASH: "1" }),
      runtimeId: "bridge",
      stepTimeoutMs: 2000,
    });
    expect(report.ok).toBe(false);
    expect(checkOf(report, "handshake")?.status).toBe("fail");
  }, 20000);
});
