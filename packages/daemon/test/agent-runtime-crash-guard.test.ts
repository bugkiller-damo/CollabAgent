import { describe, expect, it } from "vitest";
import { crashGuardCounts, createWorkerCrashGuard } from "../src/agent-runtime-crash-guard.js";

const ID = "langgraph@ep1:rev1";

describe("worker crash guard", () => {
  it("spawn/生命周期类失败码计入熔断，provider/回合类不计", () => {
    expect(crashGuardCounts("worker-exited")).toBe(true);
    expect(crashGuardCounts("runtime-start-timeout")).toBe(true);
    expect(crashGuardCounts("runtime-silence-timeout")).toBe(true);
    expect(crashGuardCounts("command-not-found")).toBe(true);
    expect(crashGuardCounts("manifest-invalid")).toBe(true);
    expect(crashGuardCounts("protocol-violation")).toBe(true);
    // worker 活着、坏在 provider/图内部——不是 crash loop
    expect(crashGuardCounts("provider-rate-limited")).toBe(false);
    expect(crashGuardCounts("provider-auth-failed")).toBe(false);
    expect(crashGuardCounts("provider-network-failed")).toBe(false);
    expect(crashGuardCounts("graph-input-invalid")).toBe(false);
    expect(crashGuardCounts("empty-success")).toBe(false);
    expect(crashGuardCounts("worker-error")).toBe(false);
    expect(crashGuardCounts("agent-stopped")).toBe(false);
    expect(crashGuardCounts(undefined)).toBe(false);
  });

  it("阈值内放行，达到阈值后熔断并给剩余冷却", () => {
    const g = createWorkerCrashGuard({ threshold: 3, baseCooldownMs: 10_000, now: () => t });
    let t = 1000;
    g.recordFailure("a", ID, "worker-exited");
    g.recordFailure("a", ID, "worker-exited");
    expect(g.check("a", ID).blocked).toBe(false);
    g.recordFailure("a", ID, "worker-exited");
    const d = g.check("a", ID);
    expect(d.blocked).toBe(true);
    expect(d.consecutiveFailures).toBe(3);
    expect(d.retryAfterMs).toBe(10_000);
    t += 4_000;
    expect(g.check("a", ID).retryAfterMs).toBe(6_000);
  });

  it("冷却结束后放行一次探测，再失败进入更长冷却", () => {
    let t = 0;
    const g = createWorkerCrashGuard({ threshold: 2, baseCooldownMs: 10_000, maxCooldownMs: 100_000, now: () => t });
    g.recordFailure("a", ID, "worker-exited");
    g.recordFailure("a", ID, "worker-exited");
    expect(g.check("a", ID).blocked).toBe(true);
    t += 10_001;
    expect(g.check("a", ID).blocked).toBe(false); // 半开探测
    g.recordFailure("a", ID, "worker-exited"); // 又失败 → 重开，冷却翻倍
    expect(g.check("a", ID).blocked).toBe(true);
    expect(g.check("a", ID).retryAfterMs).toBe(20_000);
  });

  it("成功回合复位熔断计数", () => {
    const g = createWorkerCrashGuard({ threshold: 2 });
    g.recordFailure("a", ID, "worker-exited");
    g.recordFailure("a", ID, "worker-exited");
    expect(g.check("a", ID).blocked).toBe(true);
    g.recordSuccess("a", ID);
    expect(g.check("a", ID).blocked).toBe(false);
    expect(g.check("a", ID).consecutiveFailures).toBe(0);
  });

  it("identity 变化（manifest 修订/entrypoint 变更）自动复位", () => {
    const g = createWorkerCrashGuard({ threshold: 2 });
    g.recordFailure("a", ID, "worker-exited");
    g.recordFailure("a", ID, "worker-exited");
    expect(g.check("a", ID).blocked).toBe(true);
    // 新 entrypoint 修订 → 熔断对新配置不成立
    expect(g.check("a", "langgraph@ep1:rev2").blocked).toBe(false);
  });

  it("非熔断类失败码不累计", () => {
    const g = createWorkerCrashGuard({ threshold: 2 });
    g.recordFailure("a", ID, "provider-rate-limited");
    g.recordFailure("a", ID, "provider-network-failed");
    g.recordFailure("a", ID, "worker-error");
    expect(g.check("a", ID).blocked).toBe(false);
    expect(g.check("a", ID).consecutiveFailures).toBe(0);
  });

  it("不同 agent 互不影响；reset 清账", () => {
    const g = createWorkerCrashGuard({ threshold: 1 });
    g.recordFailure("a", ID, "worker-exited");
    expect(g.check("a", ID).blocked).toBe(true);
    expect(g.check("b", ID).blocked).toBe(false);
    g.reset("a");
    expect(g.check("a", ID).blocked).toBe(false);
  });
});
